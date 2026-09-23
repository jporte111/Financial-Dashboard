---
description: Check the current branch and git history for real client financial data before it gets pushed
---

Follow the procedure in `.claude/skills/client-data-hygiene/SKILL.md` to check this
branch (default target: `main`, or use $ARGUMENTS if a different target/branch is given)
for exposed real client data before it's pushed:

1. Confirm `bva-workbooks/` is git-ignored and untracked.
2. Diff this branch against its merge-base with the target branch and scan for real-looking
   dollar figures, account numbers, and entity/person names that aren't obviously
   placeholders.
3. Check whether any commit unique to this branch has already reached `origin`.
4. Report precisely — distinguish local-only history, history that reached a remote, and
   the clean/sanitized state, per the skill's "Reporting git privacy status precisely"
   section. Never claim "no client data anywhere in history" while local history still
   contains it.

If anything suspicious is found, stop and report it in detail rather than attempting
remediation (squash/rewrite) without the user's explicit go-ahead.

$ARGUMENTS
