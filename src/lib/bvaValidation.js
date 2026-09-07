// Independent validation of a parsed BVA workbook.
//
// The workbook has a history of shifted cells and broken formulas, so every
// derived figure and every parts-vs-total reconciliation is recomputed here
// from the raw primitives and compared against what the workbook displayed.
//
// Policy (from the requirements + explicit corrections):
//   - When a computed value conflicts with the workbook value, keep BOTH and
//     raise a warning. Use the CALCULATED value unless an authorized override
//     with a reason is saved.
//   - Annual income budget: use the independently calculated total; record the
//     workbook's displayed total as a discrepancy (it omits sub-cent lines).
//   - Distributions YTD: the sum of each entity's own quarters (q1+q2+q3+q4)
//     is authoritative. The workbook's displayed grand total is kept only as
//     an audit-trail source value — it is a manually-typed cell range and has
//     been wrong before (e.g. a column subtotal formula that silently skips
//     one entity's row). When the two disagree, this does NOT block
//     finalization and needs no override: the arithmetic is simply corrected,
//     and a non-blocking notice records what happened for Admin review so the
//     source spreadsheet's formula can be fixed.
//   - A period cannot be marked Final while a required reconciliation fails
//     unless an explicit override is recorded for it.

import { n, round2, expectedPacePct, computeYtd, elapsedMonthsFromCutoff } from './bva.js';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

const eq = (a, b) => round2(a) === round2(b);
const money = (v) => `$${Math.abs(round2(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const QUARTER_LABEL = { q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4' };

// When the workbook's displayed quarterly column subtotals are available,
// pinpoint exactly which quarter disagrees with the independently-summed
// column total, then check whether one specific entity's value for that
// quarter fully explains the gap. Returns null when there is nothing to
// pin down (no column totals captured, or no single entity/quarter explains
// the difference) so callers can fall back to a generic message.
function explainDistributionGap(entities, reportedQuarterTotals) {
  if (!reportedQuarterTotals) return null;
  const calcQ = { q1: 0, q2: 0, q3: 0, q4: 0 };
  for (const e of entities) {
    calcQ.q1 += n(e.q1);
    calcQ.q2 += n(e.q2);
    calcQ.q3 += n(e.q3);
    calcQ.q4 += n(e.q4);
  }
  for (const q of ['q1', 'q2', 'q3', 'q4']) {
    const reportedQ = reportedQuarterTotals[q];
    if (reportedQ == null || eq(calcQ[q], reportedQ)) continue;
    const gap = round2(calcQ[q] - reportedQ);
    const hit = entities.find((e) => eq(n(e[q]), gap));
    if (hit) return { entity: hit.name, quarter: q, amount: round2(n(hit[q])) };
  }
  return null;
}

function warn(list, w) {
  list.push({
    requiresAdminReview: false,
    blocksFinalize: false,
    severity: SEVERITY.WARNING,
    ...w,
    sourceValue: w.sourceValue == null ? null : round2(w.sourceValue),
    calculatedValue: w.calculatedValue == null ? null : round2(w.calculatedValue),
    difference:
      w.sourceValue == null || w.calculatedValue == null ? null : round2(n(w.calculatedValue) - n(w.sourceValue)),
  });
}

/**
 * @param {object} parsed  output of parseBvaWorkbook()
 * @param {object} opts     { elapsedMonths?, cutoffDate?, overrides? }
 *   overrides: { [warningCode]: { reason, by, at } } — clears blocksFinalize.
 */
export function validateBva(parsed, opts = {}) {
  const warnings = [];
  const overrides = opts.overrides || {};
  const elapsedMonths =
    opts.elapsedMonths != null ? opts.elapsedMonths : elapsedMonthsFromCutoff(opts.cutoffDate || parsed?.meta?.cutoffDate);
  const pacePct = expectedPacePct(elapsedMonths);

  // Carry through any structural problems the parser reported.
  for (const pw of parsed?.parseWarnings || []) {
    warn(warnings, {
      code: pw.code || 'parse_warning',
      section: pw.section || 'workbook',
      message: pw.message,
      requiresAdminReview: true,
    });
  }

  // ---- Pace sanity: elapsed-months pace vs the workbook's proxy ----------
  const proxy = parsed?.expenseSummary?.pacePctProxy;
  if (proxy != null && Math.abs(n(proxy) - pacePct) > 0.005) {
    warn(warnings, {
      code: 'pace_proxy_divergence',
      section: 'expenses',
      message:
        "The workbook's pace reference differs from elapsed reporting months / 12. Calculated pace is used.",
      sourceValue: n(proxy) * 100,
      calculatedValue: pacePct * 100,
      requiresAdminReview: true,
    });
  }

  // ---- Cash: accounts sum to Total Cash --------------------------------
  const cashAccounts = parsed?.cash?.accounts || [];
  const cashSum = round2(cashAccounts.reduce((s, a) => s + n(a.balance), 0));
  const cashReported = parsed?.cash?.reportedTotal;
  if (cashReported != null && !eq(cashSum, cashReported)) {
    warn(warnings, {
      code: 'cash_total_mismatch',
      section: 'cash',
      message: 'Cash account balances do not sum to the workbook Total Cash. Calculated total is used.',
      sourceValue: cashReported,
      calculatedValue: cashSum,
      requiresAdminReview: true,
      blocksFinalize: !overrides.cash_total_mismatch,
    });
  }

  // ---- Income: categories sum to Total Income; budget total recalculated
  const incomeCats = parsed?.income?.categories || [];
  const incomeActualSum = round2(incomeCats.reduce((s, c) => s + n(c.actualYtd), 0));
  const incomeBudgetSum = round2(incomeCats.reduce((s, c) => s + n(c.annualBudget), 0));
  // Current-month total is null when the workbook's month column was blank —
  // "unknown", not a confirmed $0. Only a present-but-zero column yields 0.
  const incomeMonthPresent = parsed?.income?.hasMonthColumn === true || incomeCats.some((c) => c.monthActual != null);
  const incomeMonthSum = incomeMonthPresent
    ? round2(incomeCats.reduce((s, c) => s + n(c.monthActual), 0))
    : null;
  const incomeActualReported = parsed?.income?.reportedActualTotal;
  const incomeBudgetReported = parsed?.income?.reportedBudgetTotal;

  if (incomeActualReported != null && !eq(incomeActualSum, incomeActualReported)) {
    warn(warnings, {
      code: 'income_actual_mismatch',
      section: 'income',
      message: 'Income categories do not sum to the workbook Total Income. Calculated total is used.',
      sourceValue: incomeActualReported,
      calculatedValue: incomeActualSum,
      requiresAdminReview: true,
      blocksFinalize: !overrides.income_actual_mismatch,
    });
  }
  if (incomeBudgetReported != null && !eq(incomeBudgetSum, incomeBudgetReported)) {
    warn(warnings, {
      code: 'income_budget_workbook_mismatch',
      section: 'income',
      message:
        "The workbook's displayed annual income budget omits one or more sub-cent lines. The independently calculated total is used.",
      sourceValue: incomeBudgetReported,
      calculatedValue: incomeBudgetSum,
      requiresAdminReview: true,
      // Recorded as a discrepancy, not a finalize blocker — calculated wins.
      blocksFinalize: false,
    });
  }

  const incomeRemaining = round2(incomeBudgetSum - incomeActualSum);
  const incomePercentUsed = incomeBudgetSum !== 0 ? incomeActualSum / incomeBudgetSum : 0;

  // ---- Expenses: Fixed + Variable + Discretionary ---------------------
  const groupsRaw = parsed?.expenseSummary?.groups || [];
  const groups = groupsRaw.map((g) => ({
    key: g.key,
    name: g.name || g.key,
    monthActual: g.monthActual == null ? null : n(g.monthActual),
    ...computeYtd({ actualYtd: g.actualYtd, annualBudget: g.annualBudget }, elapsedMonths),
  }));
  const expActualSum = round2(groups.reduce((s, g) => s + g.actual, 0));
  const expBudgetSum = round2(groups.reduce((s, g) => s + g.annual, 0));
  const expenseMonthPresent = parsed?.expenseSummary?.hasMonthColumn === true || groups.some((g) => g.monthActual != null);
  const expenseMonthSum = expenseMonthPresent
    ? round2(groups.reduce((s, g) => s + n(g.monthActual), 0))
    : null;
  const expActualReported = parsed?.expenseSummary?.reportedActualTotal;
  const expBudgetReported = parsed?.expenseSummary?.reportedBudgetTotal;

  if (expActualReported != null && !eq(expActualSum, expActualReported)) {
    warn(warnings, {
      code: 'expense_actual_mismatch',
      section: 'expenses',
      message: 'Fixed + Variable + Discretionary actual does not equal the workbook Total Expenses. Calculated total is used.',
      sourceValue: expActualReported,
      calculatedValue: expActualSum,
      requiresAdminReview: true,
      blocksFinalize: !overrides.expense_actual_mismatch,
    });
  }
  if (expBudgetReported != null && !eq(expBudgetSum, expBudgetReported)) {
    warn(warnings, {
      code: 'expense_budget_mismatch',
      section: 'expenses',
      message:
        'Fixed + Variable + Discretionary annual budget does not equal the workbook Total Annual Expense Budget. Calculated total is used.',
      sourceValue: expBudgetReported,
      calculatedValue: expBudgetSum,
      requiresAdminReview: true,
      blocksFinalize: !overrides.expense_budget_mismatch,
    });
  }

  const overall = computeYtd({ actualYtd: expActualSum, annualBudget: expBudgetSum }, elapsedMonths);

  // ---- Distributions: entity-quarter sum is authoritative --------------
  // Each entity's own quarters (q1+q2+q3+q4) are always independently
  // correct regardless of what the workbook's own per-entity YTD formula
  // says. The workbook's grand-total cell is retained only as an audit
  // source value; when it disagrees, the calculated sum wins outright and no
  // override is required — this is an arithmetic correction, not an open
  // question.
  const distEntities = (parsed?.distributions?.entities || []).map((e) => {
    const calculatedYtd = round2(n(e.q1) + n(e.q2) + n(e.q3) + n(e.q4));
    return {
      name: e.name,
      q1: n(e.q1),
      q2: n(e.q2),
      q3: n(e.q3),
      q4: n(e.q4),
      calculatedYtd,
      reportedYtd: e.reportedYtd == null ? null : round2(e.reportedYtd),
      matches: e.reportedYtd == null ? null : eq(calculatedYtd, e.reportedYtd),
    };
  });
  const distEntitySum = round2(distEntities.reduce((s, e) => s + e.calculatedYtd, 0));
  const distWorkbookTotal = parsed?.distributions?.reportedTotal ?? null;
  let distributionsReconciled = false;
  if (distWorkbookTotal != null) {
    distributionsReconciled = eq(distEntitySum, distWorkbookTotal) && distEntities.every((e) => e.matches !== false);
    if (!distributionsReconciled) {
      const gapExplanation = explainDistributionGap(distEntities, parsed?.distributions?.reportedQuarterTotals);
      const message = gapExplanation
        ? `Workbook total omitted ${gapExplanation.entity} ${QUARTER_LABEL[gapExplanation.quarter]} of ${money(gapExplanation.amount)}. Dashboard uses the recalculated entity-quarter total of ${money(distEntitySum)}.`
        : 'Distribution entity quarterly totals do not match the workbook displayed total. The recalculated entity-quarter total is used.';
      warn(warnings, {
        code: 'distribution_workbook_total_corrected',
        section: 'distributions',
        message,
        sourceValue: distWorkbookTotal,
        calculatedValue: distEntitySum,
        requiresAdminReview: true, // keep flagging the workbook formula error for BVA Review
        blocksFinalize: false, // arithmetically correct; no override needed to use it
      });
    }
  }

  // ---- Recurring transfers: their amounts define the total -----------
  const transferItems = parsed?.transfers?.items || [];
  const transfersTotal = round2(transferItems.reduce((s, t) => s + n(t.amount), 0));
  const transfersReported = parsed?.transfers?.reportedTotal;
  if (transfersReported != null && !eq(transfersTotal, transfersReported)) {
    warn(warnings, {
      code: 'transfers_total_mismatch',
      section: 'transfers',
      message: 'Recurring transfer amounts do not sum to the workbook transfer total. Calculated total is used.',
      sourceValue: transfersReported,
      calculatedValue: transfersTotal,
      requiresAdminReview: true,
    });
  }

  // ---- Detail: recompute every monitored category (ignore workbook E/F/G/H)
  const detailCategories = (parsed?.detail?.categories || []).map((d) => ({
    code: d.code || null,
    name: d.name,
    group: d.group || 'unassigned',
    groupConfirmed: !!d.groupConfirmed,
    monthActual: d.monthActual == null ? null : n(d.monthActual),
    ...computeYtd({ actualYtd: d.actualYtd, annualBudget: d.annualBudget }, elapsedMonths),
  }));

  const blocksFinalize = warnings.some((w) => w.blocksFinalize);
  const openReconciliations = warnings.filter((w) => w.blocksFinalize).map((w) => w.code);

  return {
    elapsedMonths,
    pacePct,
    warnings,
    blocksFinalize,
    openReconciliations,
    reconciled: {
      cash: { accounts: cashAccounts.map((a) => ({ name: a.name, balance: round2(a.balance) })), total: cashSum },
      income: {
        categories: incomeCats.map((c) => ({
          code: c.code || null,
          name: c.name,
          monthActual: c.monthActual == null ? null : round2(c.monthActual),
          actualYtd: round2(c.actualYtd),
          annualBudget: round2(c.annualBudget),
          remaining: round2(n(c.annualBudget) - n(c.actualYtd)),
          percentUsed: n(c.annualBudget) !== 0 ? n(c.actualYtd) / n(c.annualBudget) : 0,
        })),
        actualTotal: incomeActualSum,
        budgetTotal: incomeBudgetSum, // calculated wins
        workbookBudgetTotal: incomeBudgetReported == null ? null : round2(incomeBudgetReported),
        remaining: incomeRemaining,
        percentUsed: incomePercentUsed,
        // null = the workbook carried no current-month income figures.
        monthActualTotal: incomeMonthSum,
        monthPresent: incomeMonthPresent,
      },
      expenses: {
        groups,
        actualTotal: expActualSum,
        budgetTotal: expBudgetSum,
        remaining: round2(expBudgetSum - expActualSum),
        percentUsed: expBudgetSum !== 0 ? expActualSum / expBudgetSum : 0,
        overall,
        // null = the workbook carried no current-month expense figures.
        monthActualTotal: expenseMonthSum,
        monthPresent: expenseMonthPresent,
      },
      distributions: {
        entities: distEntities,
        // Authoritative: the sum of each entity's own quarters.
        ytd: distEntitySum,
        entitySum: distEntitySum,
        // Audit-trail only — the workbook's own displayed grand total. Never
        // used as the dashboard figure; retained so BVA Review can show
        // "workbook said X, calculated Y" side by side.
        workbookReportedTotal: distWorkbookTotal,
        reconciled: distributionsReconciled,
      },
      transfers: { items: transferItems.map((t) => ({ ...t, amount: round2(t.amount) })), total: transfersTotal },
      detail: { categories: detailCategories },
    },
  };
}
