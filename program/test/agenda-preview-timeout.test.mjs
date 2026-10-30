import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Owen agenda preview LLM calls use a bounded five-minute default timeout", () => {
  const source = fs.readFileSync(
    new URL("../run-owen-sound-meeting-from-ref.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /AGENDA_PREVIEW_LLM_TIMEOUT_MS \|\| '300000'/u);
});

test("Owen whole-meeting agenda synthesis timeout scales with chronology size", () => {
  const source = fs.readFileSync(
    new URL("../run-owen-sound-meeting-from-ref.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /function estimateAgendaWholeSummaryWorkSeconds/u);
  assert.match(source, /const chronologySeconds = Math\.max\(0, Number\(sectionCount\) \|\| 0\) \* 120/u);
  assert.match(source, /timeoutMs: wholeMeetingSummaryTimeoutMs/u);
  assert.match(source, /AGENDA_WHOLE_SUMMARY_BASE_TIMEOUT_MS = 45 \* 60 \* 1000/u);
});
