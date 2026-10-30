import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRankedTopNewsFromAgenda } from "../run-full-transcript-pipeline.mjs";

test("agenda top-news selection keeps grounded substantive items with negative news scores", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owen-top-news-"));
  const agendaPath = path.join(dir, "agenda-summary.pya");
  const sections = [
    {
      "unit id": "ground_001",
      heading: "1 CALL TO ORDER",
      summary: "The committee called the meeting to order.",
    },
    {
      "unit id": "ground_002",
      heading: "7.a Application File No. B11-2026 for 1038 Sixth Avenue West",
      summary: "The committee approved a zoning bylaw amendment and an agreement for the proposed residential lots after staff review.",
    },
  ];
  fs.writeFileSync(
    agendaPath,
    `exists su name sections ob text ${JSON.stringify(JSON.stringify(sections))} ya\nprah\n`,
    "utf8",
  );

  const result = buildRankedTopNewsFromAgenda(agendaPath);

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].unitId, "ground_002");
  assert.ok(result.selected[0].substantive);
  assert.ok(result.selected[0].score < 0);
});
