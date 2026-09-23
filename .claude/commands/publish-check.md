---
description: Pre-publish checklist — verify the branch, checks, and entity schema are ready for the user to review and Publish in the Base44 Builder
---

Read `.claude/skills/base44-publish-workflow/SKILL.md` first if you haven't already this
session. Then walk through this checklist and report the result of each step clearly —
do not skip a step silently:

1. `git status` — working tree clean? Any uncommitted changes to call out?
2. `git branch --show-current` and `git log --oneline -5` — confirm we're on the intended
   branch and show recent history. If work is meant to reach the Builder, it must end up
   merged into `main` via a normal `git push` (never force-push or rewrite `main`).
3. Run the project's checks: `npm run lint`, `npm run typecheck`, `npm test`. Report
   passed/failed/skipped counts precisely (see the bva-import-review skill's testing
   section) — do not fold skipped into passed.
4. Diff `base44/entities/*.jsonc` against what's currently committed on the target branch
   (`git diff <target-branch> -- base44/entities/`) — flag any schema change so the user
   knows a `base44 entities push` will be needed, and confirm it's additive (no renames,
   no removed fields, no destructive changes) per project rules.
5. Confirm no file under the git-ignored `bva-workbooks/` directory, and no real client
   dollar figures or identifiers, are part of the diff being prepared — see
   `.claude/skills/client-data-hygiene/SKILL.md`.
6. State explicitly: this checklist prepares the branch for the user's own review in the
   Base44 Builder and their own click of Publish. **Do not run `base44 deploy`,
   `base44 site deploy`, or `base44 visibility`** as part of this command — those bypass
   the Builder review entirely and are only for an explicit, separately-requested
   direct/emergency deploy.

$ARGUMENTS
