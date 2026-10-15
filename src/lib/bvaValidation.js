// Independent validation of a parsed BVA workbook.
//
// The workbook has a history of shifted cells and broken formulas, so every
// derived figure and every parts-vs-total reconciliation is recomputed here
// from the raw primitives and compared against what the workbook displayed.
//
// Policy:
//   - The dashboard shows what the workbook contains. Missing and unusual
//     values are WARNINGS: highlighted for review, never a reason to block
//     finalize or publish, and no written reason is needed to publish them.
//     Only structural / integrity failures block (base44/shared/hardRules.ts):
//     the app cannot tell what the workbook says or which period it is.
//   - Printed totals (owner decision, October 2026): when the workbook's
//     printed total disagrees with the sum of its rows, the PRINTED total is
//     what the dashboard shows (reconciled.display), and a warning says the
//     workbook does not add up. The total calculated from the rows is kept
//     (reconciled.*) for validation. With no printed total, the calculated
//     one is shown. This covers Total Cash, Total Income and the annual income
//     budget, Total Expenses and the annual expense budget, Distributions YTD,
//     each entity's distributions YTD, and the quarter column totals.
//   - Missing vs zero: a blank source value stays null all the way through.
//     A total with a missing part is itself missing (null), never a partial
//     sum. It is shown as missing, never as $0.00.

import { n, round2, expectedPacePct, computeYtd, elapsedMonthsFromCutoff } from './bva.js';
import { isHardValidation, CLIENT_ONLY_HARD } from '../../base44/shared/hardRules.ts';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

const eq = (a, b) => round2(a) === round2(b);
const money = (v) => `$${Math.abs(round2(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const QUARTER_LABEL = { q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4' };
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const r2 = (v) => (v == null ? null : round2(v));
// The workbook's printed figure when present, else the calculated one.
const printedOr = (printed, calculated) => (printed != null ? round2(n(printed)) : r2(calculated));

// Sum of values; null when any part is missing (a partial sum is not a total).
const sumOrNull = (values) => (values.some((v) => v == null) ? null : round2(values.reduce((s, v) => s + n(v), 0)));

// YTD figures for one line, or all-null figures when a primary value is missing.
function ytdOrNull(actualYtd, annualBudget, elapsedMonths) {
  if (actualYtd == null || annualBudget == null) {
    return {
      mode: 'ytd',
      actual: actualYtd == null ? null : n(actualYtd),
      annual: annualBudget == null ? null : n(annualBudget),
      remaining: null,
      percentUsed: null,
      pacePct: expectedPacePct(elapsedMonths),
      expectedYtdBudget: null,
      varianceToPace: null,
      variancePct: null,
      favorable: null,
      status: null,
      missing: true,
    };
  }
  return computeYtd({ actualYtd, annualBudget }, elapsedMonths);
}

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
    overridable: true,
    severity: SEVERITY.WARNING,
    ...w,
    sourceValue: w.sourceValue == null ? null : round2(w.sourceValue),
    calculatedValue: w.calculatedValue == null ? null : round2(w.calculatedValue),
    difference:
      w.sourceValue == null || w.calculatedValue == null ? null : round2(n(w.calculatedValue) - n(w.sourceValue)),
  });
}

// Months between the reporting period and the month its cutoff date falls in.
const monthIndex = (year, month) => Number(year) * 12 + (Number(month) - 1);
function isMonthEnd(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const next = new Date(d.getTime() + 86400000);
  return next.getUTCDate() === 1;
}
const cutoffYm = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
};
const ymLabel = (ym) => `${MONTH_NAMES[ym.month - 1]} ${ym.year}`;

/**
 * @param {object} parsed  output of parseBvaWorkbook()
 * @param {object} opts     { elapsedMonths?, cutoffDate?, overrides?, period?, previous? }
 *   overrides: accepted for compatibility; no warning needs one any more.
 *   period:    { month, year } — the reporting period being imported into.
 *   previousUnavailable: true when the previous period could not be loaded —
 *              its checks did not run, which blocks (never skipped silently).
 *   previous:  { month, year, label?, cutoffDate?, detailCodes?, transferCount? } —
 *              the latest earlier BVA period, which sets what this import is
 *              expected to contain.
 */
export function validateBva(parsed, opts = {}) {
  const warnings = [];
  // Confirmed group mappings (saved BudgetLine rows or import corrections),
  // keyed by normalized category code. The parsed workbook itself carries no
  // group for watch-list rows.
  const groupMap = opts.groupMap || {};
  // Only structural / integrity findings block (hardRules.ts); no reason clears them.
  const isHard = (code) => isHardValidation(code) || CLIENT_ONLY_HARD.has(code);
  const cutoffDate = opts.cutoffDate || parsed?.meta?.cutoffDate || null;
  const elapsedMonths = opts.elapsedMonths != null ? opts.elapsedMonths : cutoffDate ? elapsedMonthsFromCutoff(cutoffDate) : null;
  const pacePct = expectedPacePct(elapsedMonths);
  const sections = parsed?.sections || null; // absent on parses stored before the multi-sheet parser

  // Carry through any structural problems the parser reported.
  for (const pw of parsed?.parseWarnings || []) {
    const hard = isHard(pw.code || 'parse_warning');
    warn(warnings, {
      code: pw.code || 'parse_warning',
      section: pw.section || 'workbook',
      message: pw.message,
      requiresAdminReview: true,
      overridable: !hard,
      blocksFinalize: hard,
    });
  }
  const has = (code) => warnings.some((w) => w.code === code);
  // A finding for review; it blocks only when it is structural (isHard).
  const block = (w) => warn(warnings, { requiresAdminReview: true, ...w, blocksFinalize: isHard(w.code), overridable: !isHard(w.code) });

  if (opts.previousUnavailable) {
    block({ code: 'previous_period_unavailable', section: 'meta', message: 'The previous period could not be loaded, so the comparison with it did not run. Retry.', overridable: false });
  }

  // ---- Cutoff date and reporting month -----------------------------------
  if (!cutoffDate) {
    if (!has('cutoff_date_conflict')) {
      block({ code: 'cutoff_date_required', section: 'meta', message: 'No reporting cutoff date is set, so the report cannot be placed in a month. Confirm the cutoff date.', overridable: false });
    }
  } else if (!isMonthEnd(cutoffDate)) {
    block({ code: 'cutoff_not_month_end', section: 'meta', message: `The cutoff date ${cutoffDate} is not the last day of a month; elapsed-month pace assumes it is.` });
  }
  const cutYm = cutoffYm(cutoffDate);
  const period = opts.period && opts.period.month && opts.period.year ? { month: Number(opts.period.month), year: Number(opts.period.year) } : null;
  if (period && cutYm) {
    const offset = monthIndex(period.year, period.month) - monthIndex(cutYm.year, cutYm.month);
    if (offset === 0) {
      warn(warnings, { code: 'period_is_cutoff_month', section: 'meta', message: `${ymLabel(period)} reports data through ${cutoffDate} (the same month).`, requiresAdminReview: true });
    } else if (offset === 1) {
      warn(warnings, { code: 'period_follows_cutoff_month', section: 'meta', message: `${ymLabel(period)} is the report month; its data runs through ${cutoffDate} (the previous month end).`, requiresAdminReview: true });
    } else {
      block({ code: 'reporting_month_mismatch', section: 'meta', message: `The reporting period ${ymLabel(period)} does not match the cutoff date ${cutoffDate}: it must be the cutoff month or the month after it.`, overridable: false });
    }
    const t = parsed?.meta?.titleMonth ? { month: parsed.meta.titleMonth, year: parsed.meta.titleYear } : null;
    // A title may name the report month, or -- the bookkeeper's convention
    // since September 2026 -- the month the data runs through, when the
    // confirmed cutoff supports it (the cutoff month is that month and this
    // period is the cutoff month or the month after it). Anything else blocks.
    const namesReportMonth = t && t.month === period.month && t.year === period.year;
    const namesDataMonth = t && t.month === cutYm.month && t.year === cutYm.year && (offset === 0 || offset === 1);
    if (t && !namesReportMonth && namesDataMonth) {
      warn(warnings, { code: 'title_names_data_month', section: 'meta', message: `The workbook title names ${ymLabel(t)}, the month its data runs through (cutoff ${cutoffDate}); it is imported as the ${ymLabel(period)} report. Accepted.` });
    } else if (t && !namesReportMonth) {
      block({ code: 'title_month_mismatch', section: 'meta', message: `The workbook title names ${ymLabel(t)}, but it is being imported as ${ymLabel(period)}, and its cutoff (${cutoffDate}) does not support that.` });
    }
    const prev = opts.previous;
    const prevCut = prev && cutoffYm(prev.cutoffDate);
    if (prev && prevCut) {
      const prevOffset = monthIndex(prev.year, prev.month) - monthIndex(prevCut.year, prevCut.month);
      if (prev.cutoffDate === cutoffDate) {
        block({ code: 'cutoff_already_reported', section: 'meta', message: `${prev.label || 'The previous period'} already reports data through ${cutoffDate}.` });
      } else if ((offset === 0 || offset === 1) && prevOffset !== offset) {
        block({
          code: 'reporting_convention_changed',
          section: 'meta',
          message: `${prev.label || 'The previous period'} used a cutoff ${prevOffset === 1 ? 'one month before' : 'in'} its reporting month; this import uses a cutoff ${offset === 1 ? 'one month before' : 'in'} it.`,
        });
      }
    }
  }

  // ---- Sections: expected but absent, empty or unreadable ----------------
  const prev = opts.previous || null;
  const status = (key) => (sections && sections[key] ? sections[key].status : null);
  if (sections) {
    for (const [key, label] of [['cash', 'cash'], ['income', 'income'], ['expenseSummary', 'expense summary']]) {
      if (status(key) === 'absent' || status(key) === 'empty') {
        block({ code: `section_missing:${key}`, section: key, message: `The workbook has no ${label} figures; this section is required.`, overridable: false });
      }
    }
    if (status('distributions') === 'absent' || status('distributions') === 'empty') {
      block({ code: 'section_missing:distributions', section: 'distributions', message: 'The workbook has no distributions block; Distributions YTD is required.', overridable: false });
    }
    const expectDetail = !!(prev && Array.isArray(prev.detailCodes) && prev.detailCodes.length);
    if (status('detail') === 'absent') {
      if (expectDetail) {
        block({ code: 'detail_section_expected', section: 'detail', message: `No DETAIL (watch-list) section was found, but ${prev.label || 'the previous period'} had ${prev.detailCodes.length} watch-list categories. Check whether it was left out on purpose.` });
      } else {
        warn(warnings, { code: 'detail_section_absent', section: 'detail', message: 'This workbook has no DETAIL (watch-list) section, and none is expected from the previous period.', requiresAdminReview: true });
      }
    } else if (status('detail') === 'empty') {
      block({ code: 'detail_section_empty', section: 'detail', message: 'The DETAIL (watch-list) section was found but has no category rows.' });
    }
    const expectTransfers = !!(prev && prev.transferCount > 0);
    if (status('transfers') === 'absent') {
      if (expectTransfers) {
        block({ code: 'transfers_section_expected', section: 'transfers', message: `No recurring transfers were found, but ${prev.label || 'the previous period'} had ${prev.transferCount}. Check whether there are none this month.` });
      } else {
        warn(warnings, { code: 'transfers_section_absent', section: 'transfers', message: 'This workbook has no recurring transfers section, and none is expected from the previous period.', requiresAdminReview: true });
      }
    } else if (status('transfers') === 'empty') {
      block({ code: 'transfers_section_empty', section: 'transfers', message: 'The recurring transfers section was found but has no rows with an amount.' });
    }
  }
  // Watch-list categories that were present last period but are missing now.
  const detailNow = new Set((parsed?.detail?.categories || []).map((d) => d.code).filter(Boolean));
  if (prev && Array.isArray(prev.detailCodes) && detailNow.size) {
    const gone = prev.detailCodes.filter((c) => c && !detailNow.has(c));
    if (gone.length) {
      block({ code: 'detail_rows_missing_vs_prior', section: 'detail', message: `Watch-list categories present in ${prev.label || 'the previous period'} are missing from this workbook: ${gone.join(', ')}.` });
    }
  }

  // ---- Missing primary values (never read as $0.00) ----------------------
  const missingIn = (key, label, rows, fields) => {
    const bad = rows.filter((x) => fields.some((f) => x[f] == null));
    if (bad.length) {
      block({
        code: `source_value_missing:${key}`,
        section: key,
        message: `${label}: ${bad.map((x) => x.name || x.code || 'unnamed row').join(', ')} ${bad.length > 1 ? 'have' : 'has'} a blank ${fields.join(' / ')} in the workbook. It is shown as missing (never $0.00); ask the bookkeeper to fill it in if it should have a value.`,
      });
    }
  };

  // ---- Pace sanity: elapsed-months pace vs the workbook's proxy ----------
  const proxy = parsed?.expenseSummary?.pacePctProxy;
  if (proxy != null && elapsedMonths != null && Math.abs(n(proxy) - pacePct) > 0.005) {
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
  missingIn('cash', 'Cash', cashAccounts.map((a) => ({ name: a.name, balance: a.balance })), ['balance']);
  const cashSum = cashAccounts.length ? sumOrNull(cashAccounts.map((a) => a.balance)) : null;
  const cashReported = parsed?.cash?.reportedTotal;
  if (cashReported != null && cashSum != null && !eq(cashSum, cashReported)) {
    warn(warnings, {
      code: 'cash_total_mismatch',
      section: 'cash',
      message: 'The workbook does not add up: cash account balances do not sum to its Total Cash. The workbook\'s Total Cash is shown; the calculated total is kept for checking.',
      sourceValue: cashReported,
      calculatedValue: cashSum,
      requiresAdminReview: true,
      blocksFinalize: false,
    });
  }

  // ---- Income: categories sum to Total Income; budget total recalculated
  const incomeCats = parsed?.income?.categories || [];
  missingIn('income', 'Income', incomeCats, ['actualYtd', 'annualBudget']);
  const incomeActualSum = incomeCats.length ? sumOrNull(incomeCats.map((c) => c.actualYtd)) : null;
  const incomeBudgetSum = incomeCats.length ? sumOrNull(incomeCats.map((c) => c.annualBudget)) : null;
  // Current-month total is null when the workbook's month column was blank —
  // "unknown", not a confirmed $0. Only a present-but-zero column yields 0.
  const incomeMonthPresent = parsed?.income?.hasMonthColumn === true || incomeCats.some((c) => c.monthActual != null);
  const incomeMonthSum = incomeMonthPresent
    ? round2(incomeCats.reduce((s, c) => s + n(c.monthActual), 0))
    : null;
  const incomeActualReported = parsed?.income?.reportedActualTotal;
  const incomeBudgetReported = parsed?.income?.reportedBudgetTotal;

  if (incomeActualReported != null && incomeActualSum != null && !eq(incomeActualSum, incomeActualReported)) {
    warn(warnings, {
      code: 'income_actual_mismatch',
      section: 'income',
      message: 'The workbook does not add up: income categories do not sum to its Total Income. The workbook\'s total is shown; the calculated total is kept for checking.',
      sourceValue: incomeActualReported,
      calculatedValue: incomeActualSum,
      requiresAdminReview: true,
      blocksFinalize: false,
    });
  }
  if (incomeBudgetReported != null && incomeBudgetSum != null && !eq(incomeBudgetSum, incomeBudgetReported)) {
    // Name the exact cause when the gap is explained by specific lines whose
    // budgets the workbook's Total row leaves out (both values are kept).
    const gap = round2(n(incomeBudgetSum) - n(incomeBudgetReported));
    const omitted = gap > 0 ? incomeCats.filter((c) => c.annualBudget != null && eq(n(c.annualBudget), gap)) : [];
    const cause = omitted.length
      ? ` Its Total row omits the budget of: ${omitted.map((c) => `${c.name} (${money(n(c.annualBudget))})`).join(', ')}.`
      : '';
    warn(warnings, {
      code: 'income_budget_workbook_mismatch',
      section: 'income',
      message: `The workbook does not add up: its annual income budget total differs from the sum of the income lines' budgets.${cause} The workbook's total is shown; the calculated total is kept for checking.`,
      sourceValue: incomeBudgetReported,
      calculatedValue: incomeBudgetSum,
      requiresAdminReview: true,
      blocksFinalize: false,
    });
  }

  const incomeRemaining = incomeActualSum == null || incomeBudgetSum == null ? null : round2(incomeBudgetSum - incomeActualSum);
  const incomePercentUsed = incomeActualSum == null || incomeBudgetSum == null ? null : incomeBudgetSum !== 0 ? incomeActualSum / incomeBudgetSum : 0;

  // ---- Expenses: Fixed + Variable + Discretionary ---------------------
  const groupsRaw = parsed?.expenseSummary?.groups || [];
  missingIn('expenses', 'Expense groups', groupsRaw, ['actualYtd', 'annualBudget']);
  if (groupsRaw.length && ['fixed', 'variable', 'discretionary'].some((k) => !groupsRaw.some((g) => g.key === k))) {
    block({ code: 'expense_group_missing', section: 'expenses', message: 'The expense summary does not have all three groups (Fixed, Variable, Discretionary).', overridable: false });
  }
  const groups = groupsRaw.map((g) => ({
    key: g.key,
    name: g.name || g.key,
    monthActual: g.monthActual == null ? null : n(g.monthActual),
    ...ytdOrNull(g.actualYtd, g.annualBudget, elapsedMonths),
  }));
  const expActualSum = groups.length ? sumOrNull(groups.map((g) => g.actual)) : null;
  const expBudgetSum = groups.length ? sumOrNull(groups.map((g) => g.annual)) : null;
  const expenseMonthPresent = parsed?.expenseSummary?.hasMonthColumn === true || groups.some((g) => g.monthActual != null);
  const expenseMonthSum = expenseMonthPresent
    ? round2(groups.reduce((s, g) => s + n(g.monthActual), 0))
    : null;
  const expActualReported = parsed?.expenseSummary?.reportedActualTotal;
  const expBudgetReported = parsed?.expenseSummary?.reportedBudgetTotal;

  if (expActualReported != null && expActualSum != null && !eq(expActualSum, expActualReported)) {
    warn(warnings, {
      code: 'expense_actual_mismatch',
      section: 'expenses',
      message: 'The workbook does not add up: Fixed + Variable + Discretionary actual does not equal its Total Expenses. The workbook\'s total is shown; the calculated total is kept for checking.',
      sourceValue: expActualReported,
      calculatedValue: expActualSum,
      requiresAdminReview: true,
      blocksFinalize: false,
    });
  }
  if (expBudgetReported != null && expBudgetSum != null && !eq(expBudgetSum, expBudgetReported)) {
    warn(warnings, {
      code: 'expense_budget_mismatch',
      section: 'expenses',
      message:
        'The workbook does not add up: Fixed + Variable + Discretionary annual budget does not equal its Total Annual Expense Budget. The workbook\'s total is shown; the calculated total is kept for checking.',
      sourceValue: expBudgetReported,
      calculatedValue: expBudgetSum,
      requiresAdminReview: true,
      blocksFinalize: false,
    });
  }

  const overall = ytdOrNull(expActualSum, expBudgetSum, elapsedMonths);

  // ---- Distributions: entity-quarter sum is authoritative --------------
  // Each entity's own quarters (q1+q2+q3+q4) are always independently
  // correct regardless of what the workbook's own per-entity YTD formula
  // says. The workbook's grand-total cell is retained only as an audit
  // source value; when it disagrees, the calculated sum wins outright and no
  // override is required — this is an arithmetic correction, not an open
  // question. A blank quarter cell means no distribution was entered for it:
  // it adds nothing, stays blank (never stored as $0.00), and is pointed out
  // when the quarter has already begun.
  const rawEntities = parsed?.distributions?.entities || [];
  const distEntities = rawEntities.map((e) => {
    const calculatedYtd = round2(n(e.q1) + n(e.q2) + n(e.q3) + n(e.q4));
    return {
      name: e.name,
      q1: e.q1 == null ? null : n(e.q1),
      q2: e.q2 == null ? null : n(e.q2),
      q3: e.q3 == null ? null : n(e.q3),
      q4: e.q4 == null ? null : n(e.q4),
      calculatedYtd,
      reportedYtd: e.reportedYtd == null ? null : round2(e.reportedYtd),
      matches: e.reportedYtd == null ? null : eq(calculatedYtd, e.reportedYtd),
    };
  });
  if (cutYm) {
    const begun = ['q1', 'q2', 'q3', 'q4'].filter((q, i) => cutYm.month >= i * 3 + 1);
    const blanks = distEntities.flatMap((e) => begun.filter((q) => e[q] == null).map((q) => `${e.name} ${QUARTER_LABEL[q]}`));
    if (blanks.length) {
      warn(warnings, {
        code: 'distribution_quarter_blank',
        section: 'distributions',
        message: `Blank distribution cells for quarters that have begun: ${blanks.join(', ')}. They add nothing to Distributions YTD; confirm none was received.`,
        requiresAdminReview: true,
      });
    }
  }
  const distEntitySum = distEntities.length ? round2(distEntities.reduce((s, e) => s + e.calculatedYtd, 0)) : null;
  const distWorkbookTotal = parsed?.distributions?.reportedTotal ?? null;
  let distributionsReconciled = false;
  if (distWorkbookTotal != null && distEntitySum != null) {
    // Cent-based comparison (eq rounds to cents): the grand total can agree to
    // the cent while an entity's own YTD cell is stale, so the two mismatches
    // are checked and reported separately.
    const grandTotalMatches = eq(distEntitySum, distWorkbookTotal);
    const entityMismatches = distEntities.filter((e) => e.matches === false);
    distributionsReconciled = grandTotalMatches && entityMismatches.length === 0;
    // A per-entity YTD cell that disagrees with the sum of that entity's own
    // quarters is a per-line formula error. It is reported on its own, with
    // that entity's figures — never as a grand-total discrepancy with a
    // misleading Δ $0.00.
    for (const e of entityMismatches) {
      warn(warnings, {
        code: 'distribution_entity_ytd_mismatch',
        section: 'distributions',
        message: `${e.name}'s own YTD cell in the workbook (${money(e.reportedYtd)}) does not equal the sum of its quarters (${money(e.calculatedYtd)}). The workbook does not add up; its YTD cell is shown and the sum of the quarters is kept for checking.`,
        sourceValue: e.reportedYtd,
        calculatedValue: e.calculatedYtd,
        requiresAdminReview: true, // keep flagging the workbook formula error for BVA Review
        blocksFinalize: false,
      });
    }
    if (!grandTotalMatches) {
      const gapExplanation = explainDistributionGap(distEntities, parsed?.distributions?.reportedQuarterTotals);
      const message = gapExplanation
        ? `The workbook does not add up: its Distributions YTD total omits ${gapExplanation.entity} ${QUARTER_LABEL[gapExplanation.quarter]} of ${money(gapExplanation.amount)}. The workbook's total is shown; the entity-quarter total of ${money(distEntitySum)} is kept for checking.`
        : 'The workbook does not add up: the entities\' quarters do not sum to its Distributions YTD total. The workbook\'s total is shown; the entity-quarter total is kept for checking.';
      warn(warnings, {
        code: 'distribution_workbook_total_corrected',
        section: 'distributions',
        message,
        sourceValue: distWorkbookTotal,
        calculatedValue: distEntitySum,
        requiresAdminReview: true, // keep flagging the workbook formula error for BVA Review
        blocksFinalize: false,
      });
    }
  }
  // Printed quarter column totals that differ from the sum of the entities.
  const printedQ = parsed?.distributions?.reportedQuarterTotals || null;
  if (printedQ && distEntities.length) {
    const off = ['q1', 'q2', 'q3', 'q4'].filter((q) => printedQ[q] != null && !eq(distEntities.reduce((t, e) => t + n(e[q]), 0), printedQ[q]));
    if (off.length) {
      warn(warnings, {
        code: 'distribution_quarter_total_mismatch',
        section: 'distributions',
        message: `The workbook does not add up: its ${off.map((q) => QUARTER_LABEL[q]).join(', ')} distribution total${off.length > 1 ? 's do' : ' does'} not equal the sum of the entities. The workbook's totals are shown.`,
        requiresAdminReview: true,
      });
    }
  }

  // ---- Recurring transfers: their amounts define the total -----------
  const transferItems = parsed?.transfers?.items || [];
  missingIn('transfers', 'Recurring transfers', transferItems.map((t) => ({ name: t.purpose || t.source, amount: t.amount })), ['amount']);
  const transfersTotal = sumOrNull(transferItems.map((t) => t.amount));
  const transfersReported = parsed?.transfers?.reportedTotal;
  if (transfersReported != null && transfersTotal != null && !eq(transfersTotal, transfersReported)) {
    warn(warnings, {
      code: 'transfers_total_mismatch',
      section: 'transfers',
      message: 'The workbook does not add up: recurring transfer amounts do not sum to its transfer total. Both are kept.',
      sourceValue: transfersReported,
      calculatedValue: transfersTotal,
      requiresAdminReview: true,
    });
  }

  // ---- Detail: recompute every monitored category (ignore workbook E/F/G/H)
  const detailRaw = parsed?.detail?.categories || [];
  // A watch-list row needs both figures once it has either (rows with none
  // are not imported by the parser).
  missingIn('detail', 'Watch-list categories', detailRaw.filter((d) => (d.actualYtd == null) !== (d.annualBudget == null)), ['actualYtd', 'annualBudget']);
  const detailCategories = detailRaw.map((d) => {
    const mapped = d.code ? groupMap[String(d.code).trim().toLowerCase().replace(/\s+/g, ' ')] || null : null;
    return {
      code: d.code || null,
      name: d.name,
      group: mapped || d.group || 'unassigned',
      groupConfirmed: !!mapped || !!d.groupConfirmed,
      monthActual: d.monthActual == null ? null : n(d.monthActual),
      ...ytdOrNull(d.actualYtd, d.annualBudget, elapsedMonths),
    };
  });

  const blocksFinalize = warnings.some((w) => w.blocksFinalize);
  const openReconciliations = warnings.filter((w) => w.blocksFinalize).map((w) => w.code);

  return {
    elapsedMonths,
    pacePct,
    warnings,
    blocksFinalize,
    openReconciliations,
    reconciled: {
      cash: { accounts: cashAccounts.map((a) => ({ name: a.name, balance: r2(a.balance) })), total: cashSum },
      income: {
        categories: incomeCats.map((c) => ({
          code: c.code || null,
          name: c.name,
          monthActual: c.monthActual == null ? null : round2(c.monthActual),
          actualYtd: r2(c.actualYtd),
          annualBudget: r2(c.annualBudget),
          remaining: c.actualYtd == null || c.annualBudget == null ? null : round2(n(c.annualBudget) - n(c.actualYtd)),
          percentUsed: c.actualYtd == null || c.annualBudget == null ? null : n(c.annualBudget) !== 0 ? n(c.actualYtd) / n(c.annualBudget) : 0,
        })),
        actualTotal: incomeActualSum,
        budgetTotal: incomeBudgetSum, // calculated, for checking (the dashboard shows display.annual_budgeted_income)
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
        remaining: expActualSum == null || expBudgetSum == null ? null : round2(expBudgetSum - expActualSum),
        percentUsed: expActualSum == null || expBudgetSum == null ? null : expBudgetSum !== 0 ? expActualSum / expBudgetSum : 0,
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
      transfers: { items: transferItems.map((t) => ({ ...t, amount: r2(t.amount) })), total: transfersTotal },
      detail: { categories: detailCategories },
      // What the dashboard shows: the workbook's printed total when it has
      // one, else the calculated total (a blank stays missing, never $0.00).
      display: {
        total_cash: printedOr(cashReported, cashSum),
        ytd_income: printedOr(incomeActualReported, incomeActualSum),
        annual_budgeted_income: printedOr(incomeBudgetReported, incomeBudgetSum),
        ytd_expenses: printedOr(expActualReported, expActualSum),
        annual_budgeted_expenses: printedOr(expBudgetReported, expBudgetSum),
        distributions_ytd: printedOr(distWorkbookTotal, distEntitySum),
        distribution_quarter_totals: Object.fromEntries(['q1', 'q2', 'q3', 'q4'].map((q) => [q, r2(parsed?.distributions?.reportedQuarterTotals?.[q])]).filter(([, v]) => v != null)),
        entity_ytd: distEntities.map((e) => printedOr(e.reportedYtd, e.calculatedYtd)),
      },
    },
  };
}