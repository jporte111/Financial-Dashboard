---
name: client-data-hygiene
description: Rules for keeping real client financial data out of git in this repo, and the recovery procedure if it lands in a commit anyway. Use before committing test fixtures derived from a BVA workbook, before pushing a feature branch, or when asked to sanitize or check git history for client data.
---

# Client Data Hygiene

The real monthly BVA workbooks contain the client's actual cash balances, income, and
distributions. They live only in the local, git-ignored `bva-workbooks/` directory and
must **never** be committed, even to this private repo. Acceptance-test expected values
that are real client figures (e.g. `expected-july-2026.json`) also stay in that git-ignored
directory — the committed test loads them and skips with a notice when absent, so it never
carries client numbers itself.

Only sanitized fixtures (same structure, scrubbed/rounded numbers, invented names even in
comments) may be committed for tests.

## If real client data does land in a commit

Sanitizing it in a later commit does **not** remove it — earlier commits still contain it
in their history. If this happens on a local feature branch:

1. Do not push the branch.
2. Squash the final sanitized tree into a single new commit created from the up-to-date
   base branch:
   ```
   git checkout -b <clean-branch> <base-branch>
   git merge --squash <tainted-branch>
   git commit
   ```
3. Verify the new commit's ancestry does not contain the tainted commits:
   ```
   git merge-base --is-ancestor <tainted-sha> HEAD   # should fail / print nothing
   ```
4. Grep the committed tree for client identifiers (account names, entity names, transfer
   purposes, account numbers, real dollar figures) to confirm none remain.
5. Before proposing any remediation, check with read-only commands whether the tainted
   commits ever reached a remote:
   ```
   git branch -r --contains <tainted-sha>
   git ls-remote --heads origin <branch>
   git for-each-ref --contains <tainted-sha>
   ```
   and check the `origin/*` reflog. Never delete or rewrite a remote branch without first
   explaining the exact action and getting explicit approval.

## Reporting git privacy status precisely

Distinguish three things when reporting status: local temporary feature history, remote
history, and the final sanitized branch intended for merging. Never say "no client data
exists anywhere in git history" while local feature history still contains it — say
precisely what's true of each: e.g. "the tainted commits exist locally on
`<branch>` but never reached `origin`; the sanitized `<clean-branch>` is what's proposed for
merge and its tree greps clean."
