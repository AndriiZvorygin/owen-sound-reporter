#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Share the daily lock so a scheduled poll cannot start a second long
# transcription while an archive backfill is in progress.  Cron invokes this
# wrapper directly; it waits for the daily poll instead of taking the lock in
# an outer shell command (which would deadlock the wrapper).
exec flock -w "${OWEN_POLICE_LOCK_WAIT_SECONDS:-43200}" /tmp/owen-sound-police-reporter.cron.lock \
  node "$SCRIPT_DIR/program/run-owen-sound-police-backfill-2026.mjs" "$@"
