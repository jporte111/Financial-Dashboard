# Draft revisions: staging results, deployment and rollback

## Hosted staging run (2026-10-07, staging app only, fictional data)

Periods were shaped like the largest real month (396 rows: lines, cash,
distributions, transfers, savings spends, 374 transactions). States that cannot
be produced from outside a running function were simulated with
owner-privileged writes on the staging app, then recovered with the real
hosted code. Script: `scripts/verify-staging-revisions.mjs`.

| Test | Result |
|---|---|
| 1. Copy of a ~400-row period | PASS: 396 rows copied and verified in 7.8 s, one function call |
| 1b. Burst: three ~400-row copies at once | PASS: 5.6 / 6.5 / 10.3 s; no rate limiting logged |
| 2. Lifecycle: published → revision → corrected import + edit → finalize → publish replacement | PASS: one client-visible version throughout; corrected figures served; old link serves the revision; drill-down refuses the superseded original |
| 3a. Interrupted copy (simulated) | PASS: cannot finalize; resume filled the gap in 4.7 s, verified, no duplicates |
| 3b. Duplicated batch (simulated) | PASS: verification failed, finalize refused, revision discarded, fresh one verified |
| 3c. Interrupted publish (simulated: switch done, cleanup not) | PASS: Admin shows "awaiting cleanup", not a conflict; clients see one version; retry finishes cleanup without a second switch |
| 4a. Two revisions requested at once (real race) | PASS: one created, the other refused |
| 4b. Two revisions published at once (real race) | PASS: one refused as stale; no conflict |
| 4c. Conflict state (simulated both published) | PASS: Admin conflict; revisions blocked; clients see one version; reopening the unwanted one resolves it |
| 5. Rollback of functions + site to `main` after revisions exist | FAIL (by design of `main`): see below |
| 6. Original never mutated | PASS for every test with the branch code; FAIL under rolled-back `main` code (state fields only) |

Base44 behaviour observed: `deploy` deletes entity schemas missing from the
folder (and aborts if they still hold records); it does not delete functions;
rate limiting did not occur with batched copies (the earlier limits were hit by
one-row-at-a-time writes).

## Rollback findings (test 5)

With `main`'s functions and site redeployed over the new schemas:
- a replaced month whose cleanup was unfinished: `main`'s dashboard served
  **two** versions;
- `main`'s publish of a final revision does not supersede the original:
  **two** versions served;
- `main`'s `invalidate` (old import path) changed a superseded original's state
  (status / finalized fields; figures and rows untouched -- the schema rule still
  refused the data write);
- months already cleanly replaced, open revisions and unpublished final
  revisions stayed correct.

Redeploying the branch restored one version per month; `finish_supersede`
repaired the affected months.

## Production deployment

1. Freeze imports and Admin edits; confirm nothing is mid-import.
2. Read-only baseline: public fingerprints of every published period, row
   counts, guard scan; confirm `main` has not moved since the branch was
   tested (rebase and re-test if it has).
3. Push the branch and merge it to `main` (normal push, no force); wait for the
   Builder sync; verify the draft matches the commit file by file.
4. Builder Publish (owner): schemas, functions and site together. Every partial
   combination was tested and fails safe before any revision exists.
5. Read-only checks: fingerprints of every published period unchanged (no
   revisions exist, so the one-version rule serves the same records); the
   published schema has the revision fields; the live site has the Versions
   panel.
6. No revision is created until the owner decides. The first one can be
   created and discarded as a production dry run (a write, invisible to
   clients) with explicit approval.

## Rollback

- **Before any revision exists in production:** revert the merge on `main`
  (normal revert, no force) and Publish. Safe: without revisions both versions
  of the code serve the same records. Keep the schema fields (do not remove
  them).
- **After revisions exist, do not roll the functions back to `main`.** Its
  dashboard and drill-down lack the one-version rule, its publish does not
  supersede, and its invalidate changes superseded originals.
  - Frontend problem only: revert only `src/` (keep `base44/`); an older
    browser against the new backend was tested and is safe.
  - Backend problem: fix forward. If a rollback is unavoidable, first bring the
    data to a rollback-safe state -- finish every unfinished replacement,
    discard every open or final-unpublished revision -- then roll back, and
    freeze imports into replaced months and all publishing until the fix is
    redeployed.
  - Never remove the revision schema fields: `main`'s code ignores them, and
    removing them may drop the version links.
