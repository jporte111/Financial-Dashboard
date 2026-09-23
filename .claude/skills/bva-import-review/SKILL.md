---
name: bva-import-review
description: Validation rules for the monthly BVA Excel import — independent recomputation, missing-vs-zero handling, Distributions YTD, DETAIL group mapping, savings composition, and legacy-period handling. Use before touching src/lib/bva*.js, the BVA parser/validator/importer, or when asked to validate, import, reconcile, or debug a monthly BVA workbook.
---

# BVA Import & Validation Rules

The monthly BVA ("Budget vs Actual") Excel workbook is the authoritative source for every
figure on the main dashboard. QuickBooks is fully removed from this app (as of commit
`8edc66a`) and must never be reintroduced as a data source. The workbook itself is
unreliable — it has recurring shifted cells and broken formulas — so the pipeline never
trusts the workbook's own formula cells at face value.

## Independent recomputation

Locate blocks by anchor label, not fixed row numbers. Independently recompute, and never
just copy from the sheet:

- Remaining = Annual Budget − Actual YTD
- Percent Used = Actual YTD / Annual Budget
- Expected Pace % = elapsed reporting months / 12, derived from the confirmed cutoff date
  (never inferred from the filename or sheet tab name)
- Expected YTD Budget = Annual Budget × Expected Pace %
- Variance to Expected Pace = Actual YTD − Expected YTD Budget
- Variance % = Expected Pace % − Percent Used

When an imported value conflicts with the independently calculated value, record and
display a validation warning showing both, and use the calculated value unless an
authorized override with a reason is saved.

The income budget total is a known case: the workbook's displayed annual income budget
omits one of the bank interest-income lines. Always use the independently calculated sum of every income
category's annual budget as the reconciled total, and record the workbook's displayed
total as a validation discrepancy — never treat the workbook figure as reconciled.

## Missing vs. zero — never coerce blank to $0.00

A source value that is genuinely zero must render as "$0.00". A source value that is
blank, unmapped, or not yet entered must render as an explicit missing state instead
("Source value missing" / "Mapping requires review" / "—", per the `SECTION_STATE`
vocabulary in `src/lib/bvaDashboard.js`). Never `|| 0` a blank cell anywhere in the
pipeline:

- The parser keeps blank "Current Month" cells as `null`, not `0`, and exposes
  `hasMonthColumn` per block.
- `bvaValidation` carries nulls through; `reconciled.income.monthActualTotal` /
  `monthActualTotal` for expenses is `null` when the whole month column was blank.
- `bvaImport` writes `month_income` / `month_expenses` / `BudgetLine.month_actual` as
  `null`, never `0`, in that case.
- The `ReportingPeriod` fields `month_income`, `month_expenses`, `savings_in_ytd`,
  `savings_spend_ytd`, and `BudgetLine.month_actual` have no `"default": 0` in their Base44
  schema — an unset field stays `null` rather than being auto-zeroed.
- `buildBvaDashboard` yields `null` (with matching `*Missing` booleans) rather than 0 when
  a value is unknown; the This-Month section state is `MISSING` (whole month column blank)
  distinct from `NO_MONTH_ACTUAL_ACTIVITY`/`NO_MONTH_ACTIVITY` (a real imported 0).
- `PeriodTotalsForm` saves a blank input as `null`, not `0`.

Tests for this behavior live in `src/lib/bvaMissingVsZero.test.js` — extend it, don't
bypass it, when touching any of the above.

## Distributions YTD — entity-quarter sum is authoritative

`Distributions YTD` is always the sum of each entity's own quarters (q1+q2+q3+q4), not the
workbook's displayed grand total. The workbook's grand-total row is known to have a
manually-typed column-subtotal formula that can silently skip one entity's row for one
quarter — this is a spreadsheet defect, not an open business question. Still flag the
discrepancy (`requiresAdminReview: true`) and generate a specific notice naming the
entity/quarter/amount when the gap traces to exactly one cell
(`explainDistributionGap` in `src/lib/bvaValidation.js`), falling back to a generic message
otherwise. The workbook's displayed total is retained only as an audit-trail source value
(visible in BVA Review) and never blocks finalization.

`Distributions YTD` and `"Savings / Distributions In"` are different metrics — do not
conflate them.

## Savings composition (ReportingPeriod manual entries)

`savings_in_ytd` and `savings_spend_ytd` are manually entered in Admin → Monthly Totals
(never in the BVA workbook, never auto-populated by the parser), but they are not
free-form:

- `savings_in_ytd` ("Savings / Distributions In") = `distributions_ytd` + the DETAIL/watch
  8030 "Monthly Savings" line's Actual YTD. That 8030 line is also shown separately as
  "Planned Monthly Savings" on the Budget page — the roll-up is intentional, not a
  double-count bug. Do not map 8030 alone into this field.
- `savings_spend_ytd` ("Expenses Paid From Savings") = the sum of the period's
  `SavingsSpend` line-item entities (extraordinary one-offs funded from accumulated
  savings). Leave it `null` — unknown, not 0 — when a period has no `SavingsSpend` rows.
- `netSavings` = `savings_in_ytd` − `savings_spend_ytd`, and stays null/uncomputed while
  either input is null.
- The workbook's "Monthly Transfers/Debits" block is a mixture of savings-sub-account
  transfers and ordinary recurring operating debits (mortgage, car lease). It feeds the
  `RecurringTransfer` records only — never `savings_spend_ytd`.

## DETAIL category-to-group mapping

The workbook's DETAIL block carries no Fixed/Variable/Discretionary tags. Preserve any
existing *confirmed* mapping matched by normalized account number. When no confirmed
mapping exists, store the row as `group = unassigned`, `group_confirmed = false` — never
guess a group, and never default a missing group to `discretionary`. Unassigned rows show
"Unassigned" on the dashboard and "Group mapping required" in Admin, are excluded from the
Fixed/Variable/Discretionary filters until confirmed, and must never affect the
authoritative Fixed/Variable/Discretionary summary totals — those come only from the BVA
expense-summary block, never from summing DETAIL watch-list rows.

## Legacy vs. BVA-validated periods

A reporting period is "BVA-validated" only when `bva_import_status === 'final'`. For a
legacy period (no finalized BVA import), preserve its stored values unchanged, make no
validation-passed claims, and show a "Legacy period — not validated through BVA import"
indicator. Never silently reinterpret a finalized historical period using the new
validation logic.

## Testing discipline

When reporting a BVA-related test run, give passed / failed / skipped / todo as separate
counts and name any skipped tests explicitly — never fold skipped into "passed". The
acceptance suite (`bvaAcceptance.test.js`) is expected to skip with a notice when the
git-ignored real-workbook fixture in `bva-workbooks/` is absent; report that as skipped,
not as a pass.
