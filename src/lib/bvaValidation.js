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
//   - Distributions YTD: preserve the business-reported total; still recompute
//     each entity from its quarters; the entity-sum-vs-reported gap is an
//     unresolved warning that requires Admin review. Never silently replace the
//     reported total with the entity sum, and do not call the detail reconciled.
//   - A period cannot be marked Final while a required reconciliation fails
//     unless an explicit override is recorded for it.

import { n, round2, expectedPacePct, computeYtd, elapsedMonthsFromCutoff } from './bva.js';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

const eq = (a, b) => round2(a) === round2(b);

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
    monthActual: n(g.monthActual),
    ...computeYtd({ actualYtd: g.actualYtd, annualBudget: g.annualBudget }, elapsedMonths),
  }));
  const expActualSum = round2(groups.reduce((s, g) => s + g.actual, 0));
  const expBudgetSum = round2(groups.reduce((s, g) => s + g.annual, 0));
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

  // ---- Distributions: preserve reported total, flag the entity gap ----
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
  const distReportedTotal = parsed?.distributions?.reportedTotal ?? null;
  let distributionsReconciled = false;
  if (distReportedTotal != null) {
    distributionsReconciled = eq(distEntitySum, distReportedTotal) && distEntities.every((e) => e.matches !== false);
    if (!distributionsReconciled) {
      warn(warnings, {
        code: 'distribution_entity_sum_mismatch',
        section: 'distributions',
        message:
          'Distribution entity quarterly totals do not reconcile to the business-reported Distributions YTD. The reported total is preserved; this discrepancy is unresolved and needs Admin review.',
        sourceValue: distReportedTotal,
        calculatedValue: distEntitySum,
        requiresAdminReview: true,
        blocksFinalize: !overrides.distribution_entity_sum_mismatch,
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
    monthActual: n(d.monthActual),
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
          monthActual: round2(c.monthActual),
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
      },
      expenses: {
        groups,
        actualTotal: expActualSum,
        budgetTotal: expBudgetSum,
        remaining: round2(expBudgetSum - expActualSum),
        percentUsed: expBudgetSum !== 0 ? expActualSum / expBudgetSum : 0,
        overall,
      },
      distributions: {
        entities: distEntities,
        reportedTotal: distReportedTotal, // preserved, business-reported
        entitySum: distEntitySum,
        reconciled: distributionsReconciled,
      },
      transfers: { items: transferItems.map((t) => ({ ...t, amount: round2(t.amount) })), total: transfersTotal },
      detail: { categories: detailCategories },
    },
  };
}
