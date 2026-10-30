#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./run-bulk-update.sh [match_text] [dry_run]
# Examples:
#   ./run-bulk-update.sh council-meeting 0
#   ./run-bulk-update.sh committee- 1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MATCH_TEXT="${1:-}"
DRY_RUN="${2:-0}"

load_token() {
  local env_file
  for env_file in "$ROOT_DIR/.env" "/home/htaf/pyac/pyash/.env"; do
    if [[ -f "$env_file" ]]; then
      local tok
      tok="$(grep '^MEETING_PUBLISH_AUTH_TOKEN=' "$env_file" | cut -d= -f2- | tr -d '\r\n' || true)"
      if [[ -n "$tok" ]]; then
        export MEETING_PUBLISH_AUTH_TOKEN="$tok"
        return 0
      fi
    fi
  done
  return 1
}

if [[ "$DRY_RUN" != "1" && "$DRY_RUN" != "true" && "$DRY_RUN" != "yes" ]]; then
  if ! load_token; then
    echo "MEETING_PUBLISH_AUTH_TOKEN not found in .env" >&2
    exit 1
  fi
fi

cd "$ROOT_DIR"
exec node program/publish-bulk-meeting-updates.mjs artifacts/owen-sound/meetings "$MATCH_TEXT" "$DRY_RUN"
