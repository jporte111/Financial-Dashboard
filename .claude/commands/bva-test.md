---
description: Run the BVA-related vitest suites and report pass/fail/skip precisely
---

Run the BVA-related test suites for this repo:

```
npx vitest run src/lib/bva.test.js src/lib/bvaAcceptance.test.js src/lib/bvaDashboard.test.js src/lib/bvaImport.test.js src/lib/bvaMissingVsZero.test.js src/lib/bvaParser.test.js src/lib/bvaValidation.test.js src/lib/noQuickbooks.test.js
```

Report the results per `.claude/skills/bva-import-review/SKILL.md`'s testing-discipline
rule: give passed / failed / skipped / todo as separate counts, name any skipped tests
explicitly, and never fold skipped or todo into "passed". If `bvaAcceptance.test.js`
skips because the git-ignored real-workbook fixture in `bva-workbooks/` is absent, report
that plainly as a skip with the reason, not as a pass. If a headline count differs from a
previous run reported in this conversation, explain the cause rather than letting it stand
silently.

$ARGUMENTS
