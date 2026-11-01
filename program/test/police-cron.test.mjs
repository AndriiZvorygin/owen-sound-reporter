import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { mergeManagedPoliceCrontab } from "../install-police-cron.mjs";
import {
  dateOnly,
  isShortPoliceClip,
  isSuccessfulPublishResponse,
  recordingDate,
} from "../run-owen-sound-police-next.mjs";

test("police cron owns one managed block without an outer flock", () => {
  const existing = [
    "# unrelated entry",
    "15 6 * * * echo keep-me",
    "# owen-sound-police-reporter managed:start",
    "10 5 * * * flock -n /tmp/owen-sound-police-reporter.cron.lock -c old-command",
    "# owen-sound-police-reporter managed:end",
    "",
  ].join("\n");
  const merged = mergeManagedPoliceCrontab(existing, { nodeBin: "/opt/node/bin/node" });

  assert.match(merged, /15 6 \* \* \* echo keep-me/u);
  assert.equal((merged.match(/owen-sound-police-reporter managed:start/gu) || []).length, 1);
  assert.match(merged, /10 5 \* \* \* .*\.\/run-next-police-story\.sh/u);
  assert.match(merged, /40 5 \* \* \* .*\.\/run-backfill-police-2026\.sh/u);
  assert.doesNotMatch(merged, /10 5 .*flock -n/u);
  assert.match(merged, /PATH='\/opt\/node\/bin:/u);
});

test("backfill wrapper waits for the daily lock itself", () => {
  const source = fs.readFileSync(new URL("../../run-backfill-police-2026.sh", import.meta.url), "utf8");
  assert.match(source, /flock -w "\$\{OWEN_POLICE_LOCK_WAIT_SECONDS:-43200\}"/u);
  assert.doesNotMatch(source, /flock -n/u);
});

test("police next only trusts successful publish responses", () => {
  assert.equal(isSuccessfulPublishResponse({ ok: false, error: "canonical mismatch" }), false);
  assert.equal(isSuccessfulPublishResponse({ ok: true, post_url: "https://helpos.ca/c/owen_sound_police/1/post" }), true);
});

test("police next filters short clips and compares recording dates", () => {
  assert.equal(isShortPoliceClip({ duration: 124 }), true);
  assert.equal(isShortPoliceClip({ duration: 3357 }), false);
  assert.equal(recordingDate({ upload_date: "20261021" }), "2026-10-21");
  assert.equal(dateOnly("2026-10-20T12:00:00"), "2026-10-20");
});
