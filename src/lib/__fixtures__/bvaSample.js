// Synthetic BVA workbook fixtures. All names and numbers are fabricated.
// Real client workbooks live only in the git-ignored bva-workbooks/ directory.
//
// `cleanParsed()`      — everything reconciles, no blocking warnings.
// `workbookLikeParsed()` — reproduces four real-workbook-shaped defects:
//   1. displayed annual income budget omits a sub-cent line (non-blocking;
//      calculated wins),
//   2. a cash account total the workbook displays disagrees with the sum of
//      accounts (still blocking, used to exercise the override mechanism),
//   3. the workbook's own Q2 distributions column subtotal silently skips
//      one entity's row (the same class of manually-typed-range bug as the
//      real workbook's Q3 column skipping one entity's row) — the
//      corrected entity-quarter sum is authoritative and does NOT block,
//   4. recurring-transfer label columns are misaligned.
//
// Reporting context for both: cutoff 2026-07-31 -> 7 elapsed months,
// expected pace 7/12 = 58.33%.

export const SAMPLE_CUTOFF = '2026-07-31';
export const SAMPLE_ELAPSED_MONTHS = 7;

export function cleanParsed() {
  return {
    meta: {
      sheetName: 'Sheet1',
      titleText: 'BVA Sample August 2026',
      cutoffDate: SAMPLE_CUTOFF,
      suggestedMonth: 8,
      suggestedYear: 2026,
    },
    cash: {
      accounts: [
        { name: 'Checking', balance: 10000 },
        { name: 'Savings', balance: 25000 },
        { name: 'Brokerage', balance: 5000 },
      ],
      reportedTotal: 40000,
    },
    distributions: {
      entities: [
        { name: 'Entity One', q1: 1000, q2: 1000, q3: 1000, q4: 0, reportedYtd: 3000 },
        { name: 'Entity Two', q1: 2000, q2: 0, q3: 0, q4: 0, reportedYtd: 2000 },
      ],
      reportedTotal: 5000,
    },
    income: {
      categories: [
        { code: '4000', name: 'Interest', monthActual: 0, actualYtd: 7, annualBudget: 12 },
        { code: '4010', name: 'Client Payments', monthActual: 0, actualYtd: 70000, annualBudget: 120000 },
        { code: '4020', name: 'Retainer Monthly', monthActual: 0, actualYtd: 700000, annualBudget: 1200000 },
      ],
      reportedActualTotal: 770007,
      reportedBudgetTotal: 1320012,
    },
    expenseSummary: {
      groups: [
        { key: 'fixed', name: 'FIXED', monthActual: 0, actualYtd: 70000, annualBudget: 120000 },
        { key: 'variable', name: 'VARIABLE', monthActual: 0, actualYtd: 50000, annualBudget: 120000 },
        { key: 'discretionary', name: 'DISCRETIONARY', monthActual: 0, actualYtd: 95000, annualBudget: 120000 },
      ],
      reportedActualTotal: 215000,
      reportedBudgetTotal: 360000,
      reportedVarianceAmount: -5000,
      reportedVariancePct: -5000 / 360000,
      pacePctProxy: 7 / 12,
    },
    detail: {
      categories: [
        { code: '6100', name: 'Gardening', group: 'unassigned', groupConfirmed: false, monthActual: 0, actualYtd: 35000, annualBudget: 60000 },
        { code: '6200', name: 'Tutoring', group: 'unassigned', groupConfirmed: false, monthActual: 0, actualYtd: 5000, annualBudget: 60000 },
        { code: '6300', name: 'Clothing', group: 'unassigned', groupConfirmed: false, monthActual: 0, actualYtd: 70000, annualBudget: 60000 },
        { code: '6400', name: 'Medical', group: 'unassigned', groupConfirmed: false, monthActual: 0, actualYtd: 40000, annualBudget: 60000 },
      ],
    },
    transfers: {
      items: [
        { amount: 500, purpose: 'Tax Savings', source: 'Acct A', destination: null, rawLabels: ['Acct A', 'Tax Savings'], labelsNeedReview: false },
        { amount: 1500, purpose: 'Insurance', source: 'Acct A', destination: null, rawLabels: ['Acct A', 'Insurance'], labelsNeedReview: false },
        { amount: 750, purpose: 'Lease', source: 'Acct B', destination: null, rawLabels: ['Acct B', 'Lease'], labelsNeedReview: false },
      ],
      reportedTotal: null,
    },
    parseWarnings: [],
  };
}

export function workbookLikeParsed() {
  const p = cleanParsed();
  // 1. Displayed income budget total omits the 12 sub-cent Interest line.
  p.income.reportedBudgetTotal = 1320000;

  // 2. A still-blocking discrepancy unrelated to distributions, so
  //    finalize-gating tests have a real reconciliation to override.
  p.cash.reportedTotal = 41000; // accounts still sum to 40000

  // 3. Distributions: the workbook's own Q2 column subtotal silently skips
  //    Entity Two's row, and Entity Two's own displayed YTD is also wrong
  //    (a second, independent formula error, mirroring the real workbook
  //    where the per-entity row and the grand-total row have separate bugs).
  //    Entity Two's true YTD is 2000+1500+1500+0 = 5000.
  p.distributions.entities[1] = { name: 'Entity Two', q1: 2000, q2: 1500, q3: 1500, q4: 0, reportedYtd: 4500 };
  // Column totals: q1 3000 (1000+2000, correct), q2 1000 (only Entity One's
  // 1000 — Entity Two's 1500 is dropped), q3 2500 (correct), q4 0.
  p.distributions.reportedQuarterTotals = { q1: 3000, q2: 1000, q3: 2500, q4: 0 };
  p.distributions.reportedTotal = 6500; // 3000+1000+2500+0 — the workbook's own (wrong) grand total

  // 4. Misaligned transfer labels.
  p.transfers.items = p.transfers.items.map((t) => ({ ...t, labelsNeedReview: true }));
  p.parseWarnings = [
    {
      code: 'transfer_labels_misaligned',
      section: 'transfers',
      message: 'Recurring transfer label columns are misaligned; confirm each transfer in Admin.',
    },
  ];
  return p;
}

// Isolates only the distributions defect (no cash/income/transfer defects),
// for tests proving the distributions correction alone never blocks finalize.
export function distributionsGapOnlyParsed() {
  const p = cleanParsed();
  p.distributions.entities[1] = { name: 'Entity Two', q1: 2000, q2: 1500, q3: 1500, q4: 0, reportedYtd: 4500 };
  p.distributions.reportedQuarterTotals = { q1: 3000, q2: 1000, q3: 2500, q4: 0 };
  p.distributions.reportedTotal = 6500;
  return p;
}
