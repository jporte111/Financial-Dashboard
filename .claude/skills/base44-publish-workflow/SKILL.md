---
name: base44-publish-workflow
description: How this repo's Base44 CLI/branch/publish workflow actually works — which branch the Builder syncs from, which CLI commands are safe vs. bypass user review, and how to test without publishing. Use before running any base44 CLI command, before pushing to main, or when asked to deploy, publish, sync entities/functions/connectors, or test schema/backend changes.
---

# Base44 Publish Workflow

This app (id `6a80ccf1dac2259ae9870f29`, site `sonia-wealth-view.base44.app`) has a GitHub
webhook that syncs code into the Base44 Builder's editable canvas. The Builder tracks
**`main` specifically** — confirmed via `git log` (recurring "Update base44 packages"
commits from `base44-builder[bot]` on `main`) and the repo's GitHub `default_branch`.
Pushing to any other branch still fires the webhook but does **not** update what the user
sees in the Builder.

## The standing rule: push to `main` and stop there

The expected workflow is: do work on a feature branch, get it merged into `main` with a
normal `git push` (never force-push or rewrite `main`'s history), and stop. The user
reviews the change inside the Base44 Builder and clicks Publish themselves.

**Never run `base44 deploy`, `base44 site deploy`, or `base44 visibility` on this project
unless the user explicitly asks for a direct/emergency deploy.** These commands write
directly to the live hosted site — they are not git-branch-aware, bypass the
Builder-review-and-Publish workflow entirely, and do not require anything to be merged
into `main` first. A `.claude/hooks/guard-base44-git.sh` PreToolUse hook forces a
confirmation prompt before any of these run; do not work around it — if it fires, that is
the signal to check with the user, not to find another way to run the command.

## Safe, additive Base44 CLI operations

These are fine to run as part of getting a change ready for review — they do not publish
anything and are not gated by the hook above:

- **`base44 entities push`** — purely additive schema sync of everything in the local
  `base44/entities/` directory. No selective/dry-run flag exists: it pushes every file at
  once and prints them all under "Updated:" even when only one changed (unchanged files
  are idempotent no-ops). It never migrates existing records. Keep the local entities
  directory in sync with the live schema and commit only the intended field change before
  running it.
- **`base44 functions deploy --force`** — deploys every function that has a local
  `base44/functions/<name>/entry.ts` and **deletes any remote function with no matching
  local directory**. This is the correct way to actually undeploy a backend function
  (deleting the local `.ts` file alone does not undeploy it). Use `base44 functions list`
  before/after to confirm what's live.
- **`base44 connectors push -y`** — removes every connector Base44 has no matching local
  file for. An empty/missing local `base44/connectors/` directory removes all connectors.
- **`base44 functions pull <name>`** — safe diagnostic pull against a git-tracked function
  to verify what's actually deployed; compare with `git diff` afterward. It leaves behind
  extra artifacts (`function.jsonc`, a duplicated `base44/` dependency-closure subfolder) —
  delete those rather than committing them.
- **`base44 dev`** — runs a local authenticated dev environment against the local Base44
  backend (backend + frontend together, when `base44/config.jsonc` sets
  `site.serveCommand`). This is the default way to test a change end-to-end, including
  schema changes and real BVA imports as Draft, **without publishing**. Publishing is the
  last step, done only after this authenticated preview passes — don't assume publishing
  is required to test something.
- **`npm run dev`** — frontend-only, against the hosted Base44 backend.
- **`base44 exec`** (reads a script from stdin, runs it with a pre-authenticated `base44`
  SDK global) — the sanctioned way to do a read-only production query or a guarded,
  targeted write. Requires Deno installed locally (`brew install deno`); reading the
  stored CLI token from `~/.base44/auth/auth.json` directly is separately blocked, so
  `exec` is the only workable path for authenticated production reads/writes here.

## CLI notes specific to this environment

`base44` is not on PATH — invoke it as `npx --yes base44@latest <command>`; it is already
authenticated (`whoami` confirms the account). `base44 entities` has no `list` subcommand.
`base44 secrets list` reports only key names, never values. `base44 site open --json` /
`base44 dashboard open --json` print the live site URL and the Builder editor URL
(`https://app.base44.com/apps/<id>/editor/workspace/overview`).

To independently confirm which branch a Base44 GitHub integration is actually watching
(when not otherwise exposed by the CLI): `gh api repos/<owner>/<repo>/hooks` and
`gh api repos/<owner>/<repo>/hooks/<id>/deliveries/<delivery-id> --jq '.request.payload.ref'`.
