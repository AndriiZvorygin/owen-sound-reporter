#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYASH_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

exec node "$PYASH_ROOT/command/rotate_community_agenda_pins.mjs" --community owen-sound-council "$@"
