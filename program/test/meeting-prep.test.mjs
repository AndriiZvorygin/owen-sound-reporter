import assert from "node:assert/strict";
import test from "node:test";

import { buildPipeline } from "../prepare-today-meeting-workspaces.mjs";

test("Owen agenda prep uses the canonical eScribe preparation command when HTML is available", () => {
  const pipeline = buildPipeline("/tmp/owen-meeting", {
    since: "2026-10-18T12:00:00",
    until: "2026-10-18T14:00:00",
    payload: {
      meeting_name: "Council Meeting",
      agenda: [
        "https://example.test/agenda.pdf",
        "https://example.test/Meeting.aspx?Id=meeting",
      ],
      meeting_url: "https://example.test/meeting",
    },
  });

  assert.match(pipeline, /command\/prepare_agenda_subreports_from_converted\.mjs/u);
  assert.doesNotMatch(pipeline, /extract-subreports-fromstate-wo-escribe-full\.pya/u);
  assert.match(pipeline, /https:\/\/example\.test\/meeting/u);
});
