import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { chunkAgendaPreviewSource } from "../../../../../program/library/reporter_shared/agenda-preview-source-chunks.mjs";

const HOUSE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const meetingDir = path.join(HOUSE_ROOT, "artifacts/owen-sound/meetings/2026-07-27_council-meeting-regular_fcdfabfa");
const index = JSON.parse(fs.readFileSync(path.join(meetingDir, "converted/subreports.index.json"), "utf8"));
const byItem = (item) => index.items.find((row) => row.item === item);
const sourcePath = (() => {
  const source = String(byItem("7.a")?.file || "");
  const marker = `${path.sep}artifacts${path.sep}`;
  const relative = source.includes(marker) ? source.slice(source.indexOf(marker) + 1) : "";
  const local = relative ? path.join(HOUSE_ROOT, relative) : "";
  return local && fs.existsSync(local) ? local : source;
})();
const normalized = (text = "") => String(text || "").replace(/\s+/gu, " ").trim();

function sanitizePreviewSource(text = "") {
  return String(text || "")
    .replace(/^\s*page\s+\d+\s+of\s+\d+\s*$/gimu, "")
    .replace(/^\s*\d+\s*$/gimu, "")
    .replace(/\f/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

test("July 27 NRT content uses character-bounded chunks instead of slide headings", {
  skip: !sourcePath || !fs.existsSync(sourcePath) || fs.statSync(sourcePath).size < 9000,
}, () => {
  const source = sanitizePreviewSource(fs.readFileSync(sourcePath, "utf8"));
  const chunks = chunkAgendaPreviewSource(source);

  assert.equal(chunks.length, 6);
  assert.equal(chunks.every((chunk) => chunk.length <= 9000), true);
  assert.equal(normalized(chunks.join(" ")), normalized(source));
  assert.equal(Math.max(...chunks.map((chunk) => (
    chunk.match(/COMMUNITY SURVEY RESULTS/gu) || []
  ).length)) >= 8, true);
});

test("July 27 NRT and shelter attachments retain separate canonical owners", () => {
  assert.deepEqual(byItem("7.a").attachments.map((row) => row.url), [
    "https://pub-owensound.escribemeetings.com/filestream.ashx?DocumentId=53363",
    "https://pub-owensound.escribemeetings.com/filestream.ashx?DocumentId=53364",
    "https://pub-owensound.escribemeetings.com/filestream.ashx?DocumentId=53365",
  ]);
  assert.deepEqual(byItem("7.b").attachments.map((row) => row.url), [
    "https://pub-owensound.escribemeetings.com/filestream.ashx?DocumentId=53366",
    "https://pub-owensound.escribemeetings.com/filestream.ashx?DocumentId=53367",
  ]);
});
