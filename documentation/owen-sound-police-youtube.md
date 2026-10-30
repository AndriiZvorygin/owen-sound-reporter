# Owen Sound Police Services Board YouTube flow

Police Services Board recordings are handled by the shared managed YouTube
transcript pipeline, with an Owen-specific source profile and the existing
HelpOS meeting publisher. This keeps transcription, sentence diarization,
chapter generation, whole-stream coverage, and article-claim verification in
the same path used for the other YouTube reports.

The reusable entry point is:

```sh
node program/run-owen-sound-police-from-ref.mjs <youtube-url-or-id>
```

For channel polling (one unposted recording per invocation), use:

```sh
./run-next-police-story.sh
```

Install or repair the user crontab with:

```sh
node program/install-police-cron.mjs
```

That managed block invokes this entry point daily at 05:10 (before the
agenda-pin jobs) and records output in
`/home/htaf/pyash/owen-sound-police.cron.log`.

The daily poller owns the single-flight lock and processes at most one
recording. Do not wrap it in a second `flock` command. A 2026 archive backfill
is available separately:

```sh
./run-backfill-police-2026.sh
```

Backfill is oldest-first and bounded to one public recording per invocation by
default. It skips already-published recordings, closed sessions, and clips
shorter than five minutes. Set `OWEN_POLICE_BACKFILL_LIMIT` to process more
than one, or `OWEN_POLICE_BACKFILL_DRY_RUN=1` to inspect the next selection.
Use `OWEN_POLICE_MIN_DURATION_SEC=0` or
`OWEN_POLICE_INCLUDE_CLOSED=1` only when a specific exception is intended.

The installed backfill cron runs at 05:40 with a twelve-hour wait on the same
lock. That means it starts after the daily poller if necessary, processes one
oldest outstanding 2026 public meeting, and records output in
`/home/htaf/pyash/owen-sound-police-backfill.cron.log`.

It targets the `owen_sound_police` community and the channel
`https://www.youtube.com/@owensoundpolice8677/streams`. The wrapper does not
publish until the shared pipeline has produced a verified transcript payload;
publication is idempotent by video id and recording date.

The HelpOS community has the Lemmy name `owen_sound_police`. The meeting-
publish endpoint accepts that existing name (as well as hyphen slugs and
community IDs); do not create a second hyphen-named community as a workaround.

For a retry, invoke the same command again. Existing checkpoints are reused by
video id. A dry run of the publication step is available with
`OWEN_POLICE_DRY_RUN=1`.

The source profile lives in the Andrii YouTube house at
`program/youtube-source-profiles.mjs`; it changes routing metadata only. It
does not bypass the managed GPU queue or introduce a police-specific prose
fallback.
