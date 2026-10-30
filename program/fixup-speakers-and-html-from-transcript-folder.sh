#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/htaf/pyac/pyash/world/house/owen-sound-reporter"
NODE_BIN="/home/htaf/.nvm/versions/node/v24.13.1/bin/node"
ROSTER_DEFAULT="$ROOT/artifacts/owen-sound/2022-2026-council.txt"
SPEAKER_HOST_DEFAULT="http://127.0.0.1:8010"

usage() {
  cat <<'EOF'
Usage:
  fixup-speakers-and-html-from-transcript-folder.sh <transcript_dir> [prefix] [--skip-diarize]

Examples:
  fixup-speakers-and-html-from-transcript-folder.sh \
    artifacts/owen-sound/meetings/2026-03-09_council-meeting-regular_e25a5ba7/transcript

  fixup-speakers-and-html-from-transcript-folder.sh \
    artifacts/owen-sound/meetings/2026-03-09_council-meeting-regular_e25a5ba7/transcript \
    meeting-qwen-auto-normalized.sentences \
    --skip-diarize
EOF
}

if [[ "${1:-}" == "" ]]; then
  usage
  exit 2
fi

TRANSCRIPT_DIR="$1"
PREFIX="${2:-auto}"
SKIP_DIARIZE="${3:-}"

if [[ ! -d "$TRANSCRIPT_DIR" ]]; then
  echo "transcript directory not found: $TRANSCRIPT_DIR" >&2
  exit 1
fi

WORK_VOICES_DIR="$TRANSCRIPT_DIR/voices-working"
mkdir -p "$WORK_VOICES_DIR"

echo "[fixup] transcript: $TRANSCRIPT_DIR"
echo "[fixup] prefix: $PREFIX"
echo "[fixup] voices-working: $WORK_VOICES_DIR"
echo "[fixup] speaker host: ${PYA_SPEAKER_HOST:-$SPEAKER_HOST_DEFAULT}"

cd "$ROOT"

if [[ "$SKIP_DIARIZE" != "--skip-diarize" ]]; then
  PYA_SPEAKER_HOST="${PYA_SPEAKER_HOST:-$SPEAKER_HOST_DEFAULT}" \
  PYA_COMMAND_TIMEOUT_MS=7200000 \
  "$NODE_BIN" program/diarize-sentence-srt-from-transcript-folder.mjs \
    "$TRANSCRIPT_DIR" "$PREFIX" ""
else
  echo "[fixup] skip diarize"
fi

"$NODE_BIN" program/auto-assign-speakers-from-callouts.mjs \
  "$TRANSCRIPT_DIR" "$PREFIX" "$ROSTER_DEFAULT" "$WORK_VOICES_DIR"

"$NODE_BIN" program/relabel-speaker-sentence-srt-from-transcript-folder.mjs \
  "$TRANSCRIPT_DIR" "$PREFIX" "$WORK_VOICES_DIR"

"$NODE_BIN" program/render-transcript-html-from-transcript-folder.mjs \
  "$TRANSCRIPT_DIR"

echo "[fixup] done"
