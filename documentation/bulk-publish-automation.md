# Bulk Publish Automation

## Goal
Safely update many existing transcript posts with minimal manual babysitting and without idempotency-key churn.

## One-command runner
From `world/house/owen-sound-reporter`:

```bash
./run-bulk-update.sh [match_text] [dry_run]
```

Examples:

```bash
./run-bulk-update.sh council-meeting 0
./run-bulk-update.sh committee- 0
./run-bulk-update.sh "" 1
```

## What is now automated
- Loads `MEETING_PUBLISH_AUTH_TOKEN` from local `.env` or repo `.env`.
- Uses bulk update mode only (UPDATE posts, not CREATE).
- Preserves per-attempt publish responses at:
  - `*.meeting-publish.response.attempt-XX.json`
  - and updates latest `*.meeting-publish.response.json`
- Retries with **fresh idempotency key per attempt** (`-r2`, `-r3`, ...).
- Retries transient failures:
  - rate limit (`429` / `rate_limit_error`)
  - `Failed Lemmy login`
  - `idempotency_key already used for failed request`
  - `5xx` server errors
- Automatically paces meeting-to-meeting updates (`BULK_PUBLISH_BETWEEN_MS`, default `20000`).
- If `post_url` is missing from response history, tries to recover it from local `transcript-page.html`.

## Relevant env controls
- `MEETING_PUBLISH_MAX_ATTEMPTS` (default `8`)
- `MEETING_PUBLISH_RETRY_DELAY_MS` (default `105000`)
- `MEETING_PUBLISH_RETRY_JITTER_MS` (default `5000`)
- `MEETING_PUBLISH_LEMMY_LOGIN_RETRY_DELAY_MS` (default `120000`)
- `BULK_PUBLISH_BETWEEN_MS` (default `20000`)

## Operational notes
- Use match filters (`council-meeting`, `committee-`) to avoid touching the wrong set.
- Run `dry_run=1` first when changing render/canonical behavior.
- If Helpos returns persistent `Failed Lemmy login`, stop and retry later after server-side auth is healthy.
