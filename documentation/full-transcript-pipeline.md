# Full Transcript Pipeline (Owen Sound Reporter)

This flow runs from transcript folder input through transcript publication assets:

1. Qwen ASR transcription and merge (single pass)
2. Roster augmentation from agenda names
3. Transcript normalization
4. Sentence-timed merge for normalized plain text
5. Speaker diarization
6. Auto-assign anonymous speakers from chair callouts + roster
7. Speaker relabel
8. Agenda-aware wise chunking
9. Agenda section summaries
10. Whole meeting summary
11. Meeting hook (3-6 words, verified)
12. SEO transcript HTML render
13. Cover image generation from meeting summary
14. Lemmy post payload generation (and optional submit)

All stages are checkpointed by output files and are idempotent by default.

## Non-Negotiable Pipeline Separation

This reporter has two different flows that must not contaminate each other:

- Agenda preview pipeline (agenda-centric, includes subreports)
- Transcript pipeline (transcript-centric, agenda used only as section scaffold)

Rules:

- Do not reuse agenda preview hook/title/image/summary outputs for transcript publish.
- Transcript section summaries, whole summary, hook, HTML, image, and payload must come from transcript pipeline outputs.
- Agenda subreports are valid for agenda preview flow, not for transcript section text.

## Entry Point

- `.pya`: `program/run-full-transcript-pipeline.pya`
- Orchestrator: `program/run-full-transcript-pipeline.mjs`
- Meeting-root launcher:
  - `.pya`: `program/run-full-transcript-pipeline-from-meeting-folder.pya`
  - `.mjs`: `program/run-full-transcript-pipeline-from-meeting-folder.mjs`

Run from reporter house:

```bash
pyash run program/run-full-transcript-pipeline.pya \
  artifacts/owen-sound/meetings/2026-03-23_council-meeting-regular_f3b0c55c/transcript/ \
  --verbose
```

Meeting-root form (recommended for reporter workflow):

```bash
pyash run program/run-full-transcript-pipeline-from-meeting-folder.pya \
  artifacts/owen-sound/meetings/2026-03-23_council-meeting-regular_f3b0c55c \
  --verbose
```

Run from pyash root:

```bash
./run world/house/owen-sound-reporter/program/run-full-transcript-pipeline.pya \
  world/house/owen-sound-reporter/artifacts/owen-sound/meetings/2026-03-23_council-meeting-regular_f3b0c55c/transcript/ \
  --verbose
```

## Auto-Pick Next Story

Single command runner that:

- refreshes calendar
- chooses one unposted candidate
  - priority 1: nearest upcoming meeting with agenda
  - fallback: most recent past meeting with video
- runs full meeting pipeline
- publishes via HelpOS endpoint (unless disabled)
- sends executive DM notification with post/transcript links

From reporter house:

```bash
pyash run program/run-next-unposted-story.pya --verbose
```

Pick-only dry selection (no heavy pipeline):

```bash
OWEN_NEXT_STORY_PICK_ONLY=1 node program/run-next-unposted-story.mjs
```

## Inputs

Required:

- `transcript_dir` containing at minimum `meeting-audio.opus` (or another supported audio file already discoverable by the transcribe stage).

Expected nearby context:

- `../meeting.json` for official source links (`meeting_url`, `agenda`, `agenda_cover`, `video`).
- Council roster file: `artifacts/owen-sound/2022-2026-council.txt`.

Roster enrichment utility (also run automatically in full pipeline):

- `program/augment-roster-from-agenda-in-meeting-folder.mjs`
- `program/augment-roster-from-agenda-in-meeting-folder.pya`

Speaker auto-assign utility (also run automatically in full pipeline):

- `program/auto-assign-speakers-from-callouts.mjs`
- `program/auto-assign-speakers-from-callouts.pya`

## Default Outputs (prefix: `meeting-qwen-auto-normalized`)

In transcript folder:

- `meeting-qwen-auto.timing.srt`
- `meeting-qwen-auto.plain.txt`
- `meeting-qwen-auto.merged.srt`
- `meeting-qwen-auto-normalized.plain.txt`
- `meeting-qwen-auto-normalized.sentences.merged.srt`
- `meeting-qwen-auto-normalized.sentences.speaker.sentences.json`
- `meeting-qwen-auto-normalized.sentences.speaker.sentence.srt`
- `meeting-qwen-auto-normalized.agenda-wise.series.pya`
- `meeting-qwen-auto-normalized.agenda-summary.md`
- `meeting-qwen-auto-normalized.agenda-summary.json`
- `meeting-qwen-auto-normalized.meeting-summary.md`
- `meeting-qwen-auto-normalized.meeting-summary.json`
- `meeting-qwen-auto-normalized.meeting-hook.txt`
- `meeting-qwen-auto-normalized.meeting-hook.json`
- `transcript-page.html`
- `meeting-qwen-auto-normalized.meeting-cover.png` (and `meeting-cover.png`)
- `meeting-qwen-auto-normalized.lemmy-post.md`
- `meeting-qwen-auto-normalized.lemmy-post.json`
- `meeting-qwen-auto-normalized.full-pipeline.report.json`

## Checkpoint Behavior

- Checkpoints are dependency-aware, not simple file-exists checks.
- A stage reruns when its upstream source changed or when the checkpoint shape is stale.
- Example: section summaries rerun when agenda-wise chips change; hook reruns when whole summary changes; payload reruns when html/summary/hook/image changes.
- To force rerun all stages:

```bash
OWEN_PIPELINE_FORCE=1 pyash run program/run-full-transcript-pipeline.pya <transcript_dir> --verbose
```

## Timeouts

- Stage timeouts are dynamically scaled from detected audio duration via `ffprobe`.
- Long-running LLM/transcription stages have larger timeout ceilings than render/payload stages.

## Hook + Title Format

Hook is generated in a dedicated verified stage.

Page/post title format:

- `<Hook> — <Jurisdiction> <Body> Transcript — <Date>`

Example:

- `Height Rules Shift Again — Owen Sound Council Transcript — March 23, 2026`

## Lemmy Integration Mode

Default behavior creates payload only:

- `*.lemmy-post.json`
- `*.lemmy-post.md`

## HelpOS Publish (Transcript + Post Upsert)

New endpoint submitter:

- Node: `program/publish-meeting-to-helpos-from-payload.mjs`
- Pyash wrapper: `program/publish-meeting-to-helpos-from-payload.pya` (safe default dry-run)

Dry-run from reporter house:

```bash
pyash run program/publish-meeting-to-helpos-from-payload.pya \
  artifacts/owen-sound/meetings/<meeting>/transcript/meeting-qwen-auto-normalized.lemmy-post.json
```

Live publish (create mode):

```bash
MEETING_PUBLISH_AUTH_TOKEN='<token>' \
node program/publish-meeting-to-helpos-from-payload.mjs \
  artifacts/owen-sound/meetings/<meeting>/transcript/meeting-qwen-auto-normalized.lemmy-post.json \
  owensound \
  owen-sound-council-2026-03-23-v1
```

Live publish (update mode by post URL):

```bash
MEETING_PUBLISH_AUTH_TOKEN='<token>' \
node program/publish-meeting-to-helpos-from-payload.mjs \
  artifacts/owen-sound/meetings/<meeting>/transcript/meeting-qwen-auto-normalized.lemmy-post.json \
  owensound \
  owen-sound-council-2026-03-23-v2 \
  https://lemmy.ca/post/3540
```

Notes:

- The uploader enforces canonical URL match (`/transcripts/<jurisdiction>/<body>/<date_iso>`).
- It auto-injects `{{DISCUSSION_URL}}` if missing.
- It strips disallowed tags (`script/iframe/object` and inline `on*=` handlers) into `*.meeting-publish.html` before upload.
- Response is saved beside payload as `*.meeting-publish.response.json`.

Optional submit hook:

```bash
OWEN_LEMMY_POST_COMMAND='node /path/to/submit-lemmy-post.mjs' \
pyash run program/run-full-transcript-pipeline.pya <transcript_dir> --verbose
```

The command receives one argument: payload json path.

## Environment Controls

- `OWEN_PIPELINE_FORCE=1` rerun all stages
- `OWEN_VOICES_DIR=/home/htaf/pyac/pyash/world/voices` override voice embeddings path
- `OWEN_AGENDA_USE_LLM_RANGE=1` enable LLM range refinement in agenda-aware chunking
- `OWEN_DRAW_STYLE="..."` override draw style string
- `OWEN_PIPELINE_SKIP_IMAGE=1` skip draw stage
- `OWEN_PIPELINE_SKIP_LEMMY=1` skip lemmy payload stage
- `OWEN_LEMMY_POST_COMMAND="..."` optional post-submit command

## Notes

- Summarization stages use scored verification and keep the best draft if no pass >= 0.8 is reached.
- Hook stage also uses scored verification.
- HTML render includes TOC and section summaries (from agenda-summary JSON) before section transcript content.
- Long sections are split into chapter-like subsections by shared code (`/home/htaf/pyac/pyash/program/library/reporter_shared/agenda-section-summaries.mjs`) using LLM boundary detection with deterministic fallback splitting.

## Transcript Sectioning Defaults

Transcript-wise sectioning is driven by:

1. `meeting-qwen-auto-normalized.agenda-wise.series.pya` (agenda-heading-to-transcript alignment)
2. Shared section summarizer/chapter splitter in `reporter_shared/agenda-section-summaries.mjs`

Default guardrail:

- Transcript chunking generates a transcript-safe agenda skeleton.
- If that skeleton yields too few parsed sections, it automatically falls back to source pruned agenda for transcript chunking.

This is the default path going forward and is intended to match the April 7-style behavior.
