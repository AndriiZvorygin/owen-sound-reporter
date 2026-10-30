# Speaker Identity Guardrails (Owen Sound Reporter)

This document defines the anti-regression rules for speaker naming, relabeling, and publish safety.

## Core Rules

1. Unique speaker names in voices dir
- No two `speaker_###.pya` entries may share the same `su name name` value.
- If a proposed name already exists, suffix automatically: `_2`, `_3`, etc.

2. Trust model for relabeling
- For `speaker_###` keys, relabel should trust global name only when metadata is trusted:
  - `full_name` exists, or
  - `origin` is set and not `identify`.
- Untrusted `identify` drift should not override meeting-level assignments.

3. Manual rename is authoritative
- Manual rename must set:
  - `name`
  - `full_name`
  - `origin = manual`
- This makes intentional human corrections survive relabel passes.

4. Future-facing corrections by default
- Prefer applying speaker corrections to current/future meetings.
- Do not bulk rewrite historical meetings unless explicitly requested.

5. Merge duplicate speakers carefully
- If two keys represent same person, choose one canonical key.
- Keep the better sample (usually longer/cleaner wav).
- Remap current/future meeting speaker JSON rows to canonical key.
- Retire duplicate key from `world/voices` after remap.

## Operational Commands

### 1) Manual rename (collision-safe)
```bash
node program/rename-speaker-in-voices-dir.mjs /home/htaf/pyac/pyash/world/voices speaker_660 "suneet kukreja"
```

### 2) Relabel one meeting transcript from current voice map
```bash
node program/relabel-speaker-sentence-srt-from-transcript-folder.mjs \
  artifacts/owen-sound/meetings/<meeting>/transcript \
  meeting-qwen-auto-normalized.sentences \
  /home/htaf/pyac/pyash/world/voices
```

### 3) Enforce uniqueness across `world/voices`
```bash
node /home/htaf/pyac/pyash/command/enforce_unique_voice_names_in_dir.mjs /home/htaf/pyac/pyash/world/voices
```

## Publish Flow After Speaker Fixes

For a meeting already processed:
1. Relabel transcript using current voices.
2. Re-render transcript page HTML.
3. Publish in UPDATE mode to same post/transcript URL.

## Candidate Answer Chapters

Candidate forums can opt into answer-level segmentation with:

```bash
PYA_ANSWER_CHAPTER_MODE=1
```

The stage requires the evidence-backed speaker map and question boundaries. It
uses moderator name callouts as the primary handoff evidence, then validates
the first and last candidate sentence in each answer. It writes:

- `*.candidate-answer-chapters.json` — structured rows for comparison tables;
- `*.candidate-answer-chapters.md` — answer summaries for review;
- `*.candidate-answer-chapters.txt` — timestamp/title chapter list.

The shared transcript renderer nests these answer chapters under the relevant
question, opening, or closing section. It never treats a repeated question,
moderator instruction, or “repeat the question” cue as candidate speech.

## Regression Checklist

Before posting:
- Confirm no duplicate names in `world/voices`.
- Confirm corrected labels appear in `*.sentences.speaker.sentence.srt`.
- Confirm `transcript-page.html` reflects corrected labels.
- Confirm publish response indicates UPDATE success.
