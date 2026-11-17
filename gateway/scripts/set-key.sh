#!/usr/bin/env bash
# Asks for a provider key in a native macOS dialog with hidden input and saves it to gateway/.env, which Bun loads and
# git ignores. The values are never printed, never passed on a command line and never leave this machine.
#
#   bash scripts/set-key.sh ppq    # PPQ_API_KEY, and optionally PPQ_CREDIT_ID (the balance check)
#   bash scripts/set-key.sh groq   # GROQ_API_KEY, for the floor guard (gpt-oss-safeguard-20b on Groq)
#   bash scripts/set-key.sh nanogpt  # NANOGPT_API_KEY, for the floor guard on NanoGPT (pinned to its Groq route)
#   bash scripts/set-key.sh openai   # OPENAI_API_KEY, for the floor's moderation check (sexual/minors)
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env"

case "${1:-}" in
  ppq)
    TITLE="Anonymo · PayPerQ"
    KEY_VAR=PPQ_API_KEY
    KEY_PROMPT="Paste your PayPerQ API key. It is saved to gateway/.env on this Mac only."
    EXTRA_VAR=PPQ_CREDIT_ID
    EXTRA_PROMPT="Optional: your PPQ credit id, for the balance check. Leave it empty to keep what is saved, or to skip."
    ;;
  groq)
    TITLE="Anonymo · Groq"
    KEY_VAR=GROQ_API_KEY
    KEY_PROMPT="Paste your Groq API key (it starts with gsk_). It is saved to gateway/.env on this Mac only."
    EXTRA_VAR=""
    ;;
  nanogpt)
    TITLE="Anonymo · NanoGPT"
    KEY_VAR=NANOGPT_API_KEY
    KEY_PROMPT="Paste your NanoGPT API key. It is saved to gateway/.env on this Mac only."
    EXTRA_VAR=""
    ;;
  openai)
    TITLE="Anonymo · OpenAI"
    KEY_VAR=OPENAI_API_KEY
    KEY_PROMPT="Paste your OpenAI API key (it starts with sk-). It is saved to gateway/.env on this Mac only."
    EXTRA_VAR=""
    ;;
  *)
    echo "Usage: bash scripts/set-key.sh ppq|groq|nanogpt|openai" >&2
    exit 2
    ;;
esac

if ! command -v osascript >/dev/null; then
  echo "This needs macOS (osascript). Add $KEY_VAR to gateway/.env by hand instead." >&2
  exit 1
fi

ask() { # ask <prompt> <button>: prints what was typed; exit 1 on Cancel, 2 when no pop-up could open
  local err out
  err=$(mktemp "${TMPDIR:-/tmp}/anonymo-ask.XXXXXX")
  if out=$(osascript - "$TITLE" "$1" "$2" 2>"$err" <<'APPLESCRIPT'
on run argv
  set r to display dialog (item 2 of argv) default answer "" with hidden answer with title (item 1 of argv) ¬
    buttons {"Cancel", item 3 of argv} default button 2 cancel button 1
  return text returned of r
end run
APPLESCRIPT
  ); then rm -f "$err"; printf '%s' "$out"; return 0; fi
  if grep -q -- "-128" "$err"; then rm -f "$err"; return 1; fi
  rm -f "$err"; return 2
}

clean() { printf '%s' "$1" | tr -d '[:space:]'; }
cancelled() {
  if [ "$1" = 2 ]; then
    echo "The pop-up could not open from this shell. Run this command in Terminal (or the app's Terminal panel) instead. Nothing was saved." >&2
    exit 1
  fi
  echo "Cancelled. Nothing was saved."; exit 0
}

key=$(ask "$KEY_PROMPT" "$([ -n "$EXTRA_VAR" ] && echo Next || echo Save)") || cancelled $?
key=$(clean "$key")
if [ -z "$key" ]; then
  echo "No key entered. Nothing was saved." >&2
  exit 1
fi
if [ "$KEY_VAR" = GROQ_API_KEY ] && [ "${key#gsk_}" = "$key" ]; then
  echo "Note: Groq keys usually start with gsk_. Saved anyway; check it if the guard answers 401." >&2
fi
extra=""
if [ -n "$EXTRA_VAR" ]; then
  extra=$(ask "$EXTRA_PROMPT" "Save") || cancelled $?
  extra=$(clean "$extra")
fi

# Replace only the variables being written; everything else in .env stays as it was.
drop="^${KEY_VAR}="
if [ -n "$extra" ]; then drop="^(${KEY_VAR}|${EXTRA_VAR})="; fi
umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
tmp=$(mktemp "${TMPDIR:-/tmp}/anonymo-env.XXXXXX")
grep -v -E "$drop" "$ENV_FILE" >"$tmp" || true
printf '%s=%s\n' "$KEY_VAR" "$key" >>"$tmp"
if [ -n "$extra" ]; then printf '%s=%s\n' "$EXTRA_VAR" "$extra" >>"$tmp"; fi
cat "$tmp" >"$ENV_FILE"
rm -f "$tmp"
saved="$KEY_VAR${extra:+ and $EXTRA_VAR}"
unset key extra

echo "Saved $saved to gateway/.env (readable only by you)."
osascript -e "display notification \"$KEY_VAR saved to gateway/.env\" with title \"Anonymo\"" 2>/dev/null || true
