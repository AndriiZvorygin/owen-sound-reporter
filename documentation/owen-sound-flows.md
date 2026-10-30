# Owen Sound Reporter Flows

## 1) Idempotent Calendar Harvest

Purpose: pull meetings/doc links from Escribe and write month-based series files.

Entry point:

- `program/extract-owen-sound-calendar-monthly.pya`
- wrapper executes `program/extract-owen-sound-calendar-monthly.mjs`

Run:

```bash
cd /home/htaf/pyac/pyash
./run world/house/owen-sound-reporter/program/extract-owen-sound-calendar-monthly.pya --verbose
```

Input source:

- `https://pub-owensound.escribemeetings.com/MeetingsCalendarView.aspx/GetCalendarMeetings`
- date range hardcoded to `2020-01-01` through `2030-12-31`

Output:

- `world/house/owen-sound-reporter/artifacts/owen-sound/monthly/YYYY-MM.events.series.pya`

Data model per event row:

- `since` / `until` = local datetime window
- `su name` = normalized meeting name + datetime tokens
- `ob text` JSON payload includes:
  - `meeting_id`, `meeting_name`, `meeting_type`, `meeting_url`
  - `agenda_cover[]`, `agenda[]`, `minutes[]`, `video[]`

Idempotency behavior:

- every run rewrites all target month files from source of truth
- stale month `.series.pya` files are removed

## 2) Prepare Today Workspaces

Purpose: create per-meeting folders and generate a runnable `.pya` pipeline for each meeting happening today (Toronto timezone).

Entry point:

- `program/prepare-today-meeting-workspaces.pya`
- wrapper executes `program/prepare-today-meeting-workspaces.mjs`

Run:

```bash
cd /home/htaf/pyac/pyash
./run world/house/owen-sound-reporter/program/prepare-today-meeting-workspaces.pya --verbose
```

Reads from:

- today month file in `artifacts/owen-sound/monthly`

Writes:

- `artifacts/owen-sound/meetings/YYYY-MM-DD.today.json`
- per meeting folder:
  - `meeting.json`
  - `run-meeting-pipeline.pya`
  - subfolders: `source/`, `converted/`, `report/`, `transcript/`

## 3) Run Today Pipelines

Purpose: execute each generated meeting pipeline and capture status.

Entry point:

- `program/run-today-meeting-pipelines.pya`
- wrapper executes `program/run-today-meeting-pipelines.mjs`

Run:

```bash
cd /home/htaf/pyac/pyash
./run world/house/owen-sound-reporter/program/run-today-meeting-pipelines.pya --verbose
```

Writes:

- per meeting `status.txt` (`ready` -> `complete`/`failed`)
- `artifacts/owen-sound/meetings/YYYY-MM-DD.run-summary.json`

## 4) Generated Meeting Pipeline (Per Meeting)

Each generated `run-meeting-pipeline.pya` currently performs:

1. Ensure directory structure exists.
2. Download agenda cover, agenda, and minutes docs into `source/`.
3. Convert PDF docs using builtin PDF->Markdown path into `converted/`.
4. Prune agenda markdown via:
   - `program/prune-owen-sound-agenda.mjs`
5. Extract subreports via:
   - `program/extract-owen-sound-subreports.mjs`
6. Download meeting video/audio to `transcript/` when video link exists (uses existing `be download ... as wo audio`).
7. Generate a local-news image with `be draw` into `report/image.png`.
8. Emit `report/brief.md`.

## 5) Wise Chip + Summarization Examples

Reusable examples currently in base repo:

- `examples/pyash/wise-chip-refinery-inline.pya`
- `examples/pyash/summary-chip-from-filename.pya`
- `examples/pyash/summary-from-filename-scored.pya`
- `examples/pyash/summarize-from-filename.pya` (if present in your current branch)

Reporter-specific summarization example:

- `program/summarize-principles-integrity-wise-chunks.pya`

## 6) Suggested Operational Order

For a normal day:

1. Run monthly harvest (refresh links/idempotent updates).
2. Run workspace preparation.
3. Run meeting pipelines.
4. Inspect outputs in meeting folder (`converted/`, `report/`, `transcript/`).

For post-meeting updates (minutes/video appeared later):

1. Re-run monthly harvest.
2. Re-run workspace prep (safe to regenerate metadata/pipelines).
3. Re-run meeting pipelines for relevant day.

## 7) Full Transcript Publication Pipeline

Purpose: go from meeting audio in `transcript/` to complete publication assets.

Entry point:

- `program/run-full-transcript-pipeline.pya`
- wrapper executes `program/run-full-transcript-pipeline.mjs`
- meeting-root convenience entry:
  - `program/run-full-transcript-pipeline-from-meeting-folder.pya`
  - wrapper executes `program/run-full-transcript-pipeline-from-meeting-folder.mjs`

Run:

```bash
cd /home/htaf/pyac/pyash/world/house/owen-sound-reporter
pyash run program/run-full-transcript-pipeline.pya artifacts/owen-sound/meetings/<meeting>/transcript/ --verbose
```

or:

```bash
cd /home/htaf/pyac/pyash/world/house/owen-sound-reporter
pyash run program/run-full-transcript-pipeline-from-meeting-folder.pya artifacts/owen-sound/meetings/<meeting>/ --verbose
```

Stages:

1. transcribe + merge (single-pass qwen flow)
2. augment roster from agenda names
3. normalize transcript
4. regenerate sentence-timed merged SRT from normalized plain text
5. diarize speakers
6. auto-assign anonymous speakers from callouts + roster
7. relabel speakers
8. agenda-aware wise chunks
9. agenda section summaries
10. whole meeting summary
11. 3-6 word verified hook
12. SEO HTML transcript render
13. cover image generation
14. lemmy payload generation (optional post submit command hook)

For controls and environment variables, see:

- `documentation/full-transcript-pipeline.md`
