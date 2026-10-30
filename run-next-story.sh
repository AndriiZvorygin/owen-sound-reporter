#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYASH_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI="$PYASH_ROOT/command/unified-writer-cli.mjs"
LOCAL_ENV_FILE="$SCRIPT_DIR/.env"

# Prefer explicit env, then local .env, then sane local default for speaker service.
if [[ -z "${PYA_SPEAKER_HOST:-}" ]]; then
  if [[ -f "$LOCAL_ENV_FILE" ]]; then
    SPEAKER_FROM_ENV="$(grep -E '^PYA_SPEAKER_HOST=' "$LOCAL_ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
    SPEAKER_FROM_ENV="${SPEAKER_FROM_ENV//$'\r'/}"
    SPEAKER_FROM_ENV="${SPEAKER_FROM_ENV%\"}"
    SPEAKER_FROM_ENV="${SPEAKER_FROM_ENV#\"}"
    SPEAKER_FROM_ENV="${SPEAKER_FROM_ENV%\'}"
    SPEAKER_FROM_ENV="${SPEAKER_FROM_ENV#\'}"
    if [[ -n "$SPEAKER_FROM_ENV" ]]; then
      export PYA_SPEAKER_HOST="$SPEAKER_FROM_ENV"
    fi
  fi
fi

if [[ -z "${PYA_SPEAKER_HOST:-}" ]]; then
  export PYA_SPEAKER_HOST="http://mriczo:8010"
fi

# Ensure Owen has a default submit command so --post does not silently skip.
if [[ -z "${OWEN_LEMMY_POST_COMMAND:-}" && -z "${MEETING_POST_COMMAND:-}" ]]; then
  export OWEN_LEMMY_POST_COMMAND="node $SCRIPT_DIR/program/publish-meeting-to-helpos-from-payload.mjs"
fi

# Compatibility behavior:
# - no args => next
# - first arg is a flag => next + flags
# - first arg is a command => pass through command surface
if [[ $# -eq 0 ]]; then
  exec node "$CLI" next --writer owen
fi

if [[ "$1" == "--list" ]]; then
  shift
  exec node "$CLI" list --writer owen "$@"
fi

if [[ "$1" == "--meeting" || "$1" == --meeting* ]]; then
  exec node "$CLI" run --writer owen "$@"
fi

case "$1" in
  -*)
    exec node "$CLI" next --writer owen "$@"
    ;;
  *)
    CMD="$1"
    shift
    exec node "$CLI" "$CMD" --writer owen "$@"
    ;;
esac
