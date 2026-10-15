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

**Printed totals (owner decision, October 2026).** When the workbook's printed total
disagrees with the sum of its rows, the dashboard shows the PRINTED total
(`validation.reconciled.display`, stored in the period scalars, `Distribution.workbook_ytd`
and `ReportingPeriod.distribution_quarter_totals`). The calculated total is kept for
validation (`reconciled.*` and the warning's `calculatedValue`), and a warning — and a
client note — says the workbook does not add up. With no printed total, the calculated
total is shown. Derived figures (Remaining, Percent Used, pace variance) use what is
shown. Periods stored before this rule keep their stored figures.

**Two known-defect exceptions (owner, October 2026)** — the calculated total is shown,
with the warning (`knownDefect: true`):
- Distributions YTD, when the whole grand-total gap is exactly one entity's quarter the
  column-subtotal formula skipped (`explainDistributionGap`); that quarter's column total
  is shown calculated too. Each entity's own printed YTD is not part of the exception.
- The annual income budget, when the gap is exactly the budget of ONE omitted line that
  is named "interest" or has a budget under $1 (the bank interest lines carry sub-dollar
  budgets and are not otherwise marked in the workbook).
Any other disagreement shows the printed total.

## What blocks (October 2026 owner decision)

The dashboard faithfully shows what the workbook contains: upload → review warnings →
publish. Missing and unusual values (blanks, decreases, budget changes, group changes,
month-vs-YTD mismatches, totals that do not add up) are **warnings** in the grouped
review. They never block finalize or publish and need no written reason. Only
structural / integrity failures block — the list lives in
`base44/shared/hardRules.ts` (plus no/invalid cutoff, elapsed months inconsistent with
the cutoff, an incomplete import, a conflicting or duplicate period/version, and checks
that could not run). Do not add a new blocker outside that list without the owner's
approval.

The income budget total is a known case: the workbook's displayed annual income budget
omits one of the bank interest-income lines. When the gap is exactly that line's budget,
the calculated total is shown and the warning names the omitted line; any other
difference shows the printed budget (see above).

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
- `PeriodTotalsForm` saves a blank input as missing, not `0` (see below).
- The parser keeps every blank cell `null` (YTD, budget, balances, quarters, amounts).
  A total with a missing part is `null`, not a partial sum. A missing Actual YTD /
  Annual Budget / balance / transfer amount is shown as missing and highlighted as a
  warning (it does not block). A watch-list row with no figures at all is not imported
  (notice only).

**Never write `null`.** Base44 rejects `null` in number / string fields (HTTP 422) and
has no nullable schema type. So a missing value is written by *omission*: import
payloads go through `withoutNulls` (`base44/shared/sourceMissing.ts`), and the fields
that can be missing have **no schema default** (a `"default": 0` would silently turn
an omitted value into $0.00). Because an omitted field cannot clear an older stored
value, a `ReportingPeriod` also lists its missing numeric fields in
`source_missing_fields`; every reader (publish gate, dashboard model, public period,
Admin totals form) goes through `effectiveRecord`, which treats a listed field as
missing. Child rows whose value becomes missing on re-import are replaced (delete +
create, carrying admin-owned fields) by `bvaImport.js`.

Tests for this behavior live in `src/lib/bvaMissingVsZero.test.js` and
`src/lib/bvaMissingValues.test.js` — extend them, don't bypass them, when touching any
of the above. `scripts/verify-local-missing-values.mjs` checks it against a local
`base44 dev` server.

## Workbook layout and sections

The parser scans **every sheet** and finds each block by its label (the watch list and
transfers have been moved to a second sheet before). Header-less fallbacks run only in
the simplified layout (no EXPENSE header). Every numeric cell must be read by a section
or recognized as informational (over/under, off-balance accounts, notes); anything else
is reported as `unrecognized_content` (a warning). Duplicate sections that disagree are
never combined or chosen between (this blocks). A required section that is absent or
unreadable blocks; an optional one (watch list, transfers) is a warning. The title is
only text (a mismatch is a warning); the period must be the cutoff month or the month
after it (this blocks).

## Distributions YTD — the printed total is shown; the entity-quarter sum checks it

`Distributions YTD` shown is the workbook's printed grand total (and each entity's printed
YTD, and the printed quarter column totals) when present; otherwise the sum of each
entity's own quarters. The sum is always computed and compared: the workbook's grand-total
row is known to have a manually-typed column-subtotal formula that can skip one entity's
row for one quarter. Flag it (`requiresAdminReview: true`) with a specific notice naming the
entity/quarter/amount when the gap traces to exactly one cell (`explainDistributionGap` in
`src/lib/bvaValidation.js`), else a generic message. It never blocks.

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
