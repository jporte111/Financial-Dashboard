#!/usr/bin/env bash
# Guards against accidental direct-to-production Base44 deploys and destructive
# git operations on main, per this project's standing Claude Code rules
# (see .claude/skills/base44-publish-workflow/SKILL.md).
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

ask() {
  local reason="$1"
  jq -n --arg reason "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
  exit 0
}

# Base44 direct-to-production commands bypass the Builder review/Publish workflow.
# Matches "base44 deploy", "base44@<version> deploy", "base44 site deploy", and
# "base44 visibility" — deliberately NOT "base44 functions deploy --force" or any other
# "base44 <subcommand> deploy", which are documented-safe additive operations.
if printf '%s' "$cmd" | grep -qE '\bbase44(@[^[:space:]]+)?[[:space:]]+deploy\b' \
  || printf '%s' "$cmd" | grep -qE '\bbase44(@[^[:space:]]+)?[[:space:]]+site[[:space:]]+deploy\b' \
  || printf '%s' "$cmd" | grep -qE '\bbase44(@[^[:space:]]+)?[[:space:]]+visibility\b'; then
  ask "Standing project rule: base44 deploy / site deploy / visibility writes directly to the live production site and bypasses the Base44 Builder review-and-Publish workflow. Only run this for an explicit, user-requested direct/emergency deploy — confirm that's the case."
fi

# Force-push targeting main.
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+push\b' \
  && printf '%s' "$cmd" | grep -qE '(--force\b|--force-with-lease\b|[[:space:]]-f([[:space:]]|$))' \
  && printf '%s' "$cmd" | grep -qE '\bmain\b'; then
  ask "Standing project rule: never force-push main — it is the branch the Base44 Builder syncs from. Confirm this is an intentional, approved history rewrite."
fi

# Remote deletion of main.
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+push\b.*:main\b' \
  || printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+push\b.*--delete\b.*\bmain\b'; then
  ask "Standing project rule: never delete the main branch remotely — it is the branch the Base44 Builder syncs from. Confirm this is intentional."
fi

# Local force-delete of main.
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+branch[[:space:]]+(-D|--delete[[:space:]]+--force)[[:space:]]+main\b'; then
  ask "Standing project rule: never force-delete the main branch. Confirm this is intentional."
fi

exit 0
