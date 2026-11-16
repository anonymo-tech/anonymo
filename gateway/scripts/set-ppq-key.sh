#!/usr/bin/env bash
# Asks for the PayPerQ API key (and, optionally, the PPQ credit id the balance check uses) in a native macOS dialog
# with hidden input, then saves them to gateway/.env, which Bun loads and git ignores. The values are never printed,
# never passed on a command line and never leave this machine.
#
#   bash scripts/set-ppq-key.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env"

if ! command -v osascript >/dev/null; then
  echo "This needs macOS (osascript). Add PPQ_API_KEY to gateway/.env by hand instead." >&2
  exit 1
fi

ask() { # ask <prompt> <button>: prints what was typed, fails on Cancel
  osascript - "$1" "$2" <<'APPLESCRIPT' 2>/dev/null
on run argv
  set r to display dialog (item 1 of argv) default answer "" with hidden answer with title "Anonymo · PayPerQ" ¬
    buttons {"Cancel", item 2 of argv} default button 2 cancel button 1
  return text returned of r
end run
APPLESCRIPT
}

clean() { printf '%s' "$1" | tr -d '[:space:]'; }

cancelled() { echo "Cancelled. Nothing was saved."; exit 0; }
key=$(ask "Paste your PayPerQ API key. It is saved to gateway/.env on this Mac only." "Next") || cancelled
key=$(clean "$key")
if [ -z "$key" ]; then
  echo "No key entered. Nothing was saved." >&2
  exit 1
fi
credit=$(ask "Optional: your PPQ credit id, for the balance check. Leave it empty to skip." "Save") || cancelled
credit=$(clean "$credit")

umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
tmp=$(mktemp "${TMPDIR:-/tmp}/anonymo-env.XXXXXX")
grep -v -E '^(PPQ_API_KEY|PPQ_CREDIT_ID)=' "$ENV_FILE" >"$tmp" || true
printf 'PPQ_API_KEY=%s\n' "$key" >>"$tmp"
if [ -n "$credit" ]; then printf 'PPQ_CREDIT_ID=%s\n' "$credit" >>"$tmp"; fi
cat "$tmp" >"$ENV_FILE"
rm -f "$tmp"
unset key

echo "Saved PPQ_API_KEY${credit:+ and PPQ_CREDIT_ID} to gateway/.env (readable only by you)."
osascript -e 'display notification "PPQ key saved to gateway/.env" with title "Anonymo"' 2>/dev/null || true
