import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Owen Stage 3 delegates availability retries to the model-specific renderer", () => {
  const source = fs.readFileSync(
    new URL("../summarize-agenda-wise-sections-from-transcript-folder.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\/api\/tags/u);
  assert.match(source, /runAgendaStage3SummaryRenderer/u);
});
