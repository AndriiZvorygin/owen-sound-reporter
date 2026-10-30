#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec flock -n /tmp/owen-sound-police-reporter.cron.lock \
  node "$SCRIPT_DIR/program/run-owen-sound-police-next.mjs" "$@"

