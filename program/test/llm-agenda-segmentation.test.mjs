import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAtomicTranscriptUnits,
  buildGroundedTimeline,
  buildOverlappingWindows,
  loadCanonicalAgenda,
  validateReconciledTimeline,
} from "../../../../../program/library/reporter_shared/agenda-llm-segmentation.mjs";
import { writePyaMapArtifact } from "../../../../../program/library/reporter_shared/agenda-stage-contracts.mjs";
import { verifyArticleClaims } from "../../../../../program/library/reporter_shared/quality-verifiers.mjs";

const HOUSE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const meetingDir = path.join(HOUSE_ROOT, "artifacts/owen-sound/meetings/2026-07-13_council-meeting-regular_03069c57");
const rowsPath = path.join(meetingDir, "transcript/meeting-qwen-auto-normalized.sentences.speaker.sentences.json");
const canonicalPath = path.join(meetingDir, "converted/subreports.index.json");

function boundary(item, status, id = "", role = "", quote = "", confidence = 0) {
  return { "agenda item": item, status, "atomic unit id": id, role, "evidence quote": quote, confidence };
}

test("structured eScribe agenda remains the canonical identity source", () => {
  const canonical = loadCanonicalAgenda(canonicalPath);
  const glassworks = canonical.items.find((entry) => entry.item === "7.a");
  assert.match(glassworks.title, /Glassworks Village Official Plan/iu);
  assert.equal(canonical.items.find((entry) => entry.item === "8").title, "PUBLIC FORUM");
  assert.equal(canonical.sourceType, "structured_escribe_index");
  assert.match(canonical.fingerprint, /^[a-f0-9]{64}$/u);
});

test("Owen Sound meeting metadata exposes the named scope used by agenda segmentation", () => {
  const meetingRecord = JSON.parse(fs.readFileSync(path.join(meetingDir, "meeting.json"), "utf8"));
  assert.equal(meetingRecord.payload.meeting_name, "Council Meeting - Regular");
});

test("atomic units preserve multiple transitions in one oversized source row", () => {
  const units = buildAtomicTranscriptUnits({ rows: [{ since: 10, until: 20, speaker: "Chair", text: "Item twenty-one is bylaws. Carried. Item twenty-two is adjournment." }] });
  assert.equal(units.length, 3);
  assert.deepEqual(units.map((unit) => unit["source row"]), [0, 0, 0]);
  assert.deepEqual(units.map((unit) => unit["sentence index"]), [0, 1, 2]);
  assert.deepEqual(units.map((unit) => unit.since), [10, 10, 10]);
});

test("overlapping windows contain complete transcript text instead of opening fragments", () => {
  const units = buildAtomicTranscriptUnits({ rows: Array.from({ length: 100 }, (_, i) => ({ speaker: "Chair", text: `Sentence ${i} contains the complete discussion words for this agenda transition.` })) });
  const windows = buildOverlappingWindows(units, { maxWords: 300, overlapWords: 80 });
  assert.ok(windows.length > 2);
  assert.match(windows[0].text, /complete discussion words/iu);
  assert.ok(windows[1]["atomic start"] <= windows[0]["atomic end"]);
});

test("windowing is meeting-format agnostic on another Owen Sound body", () => {
  const otherRowsPath = path.join(HOUSE_ROOT, "artifacts/owen-sound/meetings/2026-07-08_board-river-district_4d599942/transcript/meeting-qwen-auto-normalized.sentences.speaker.sentences.json");
  const otherRows = JSON.parse(fs.readFileSync(otherRowsPath, "utf8"));
  const units = buildAtomicTranscriptUnits(otherRows);
  const windows = buildOverlappingWindows(units, { maxWords: 700, overlapWords: 150 });
  assert.ok(units.length > 10);
  assert.ok(windows.length > 1);
  assert.equal(windows[0]["atomic start"], 0);
  assert.equal(windows.at(-1)["atomic end"], units.length - 1);
});

test("July 13 boundaries keep Glassworks, public forum, and staff reports separate", () => {
  const rows = JSON.parse(fs.readFileSync(rowsPath, "utf8"));
  const units = buildAtomicTranscriptUnits(rows);
  const canonical = {
    items: [
      { item: "5", title: "MOTION TO MOVE COUNCIL INTO COMMITTEE OF THE WHOLE" },
      { item: "6", title: "PUBLIC MEETINGS" },
      { item: "7", title: "DEPUTATIONS AND PRESENTATIONS" },
      { item: "7.a", title: "Glassworks Village Official Plan and Rezoning Applications" },
      { item: "8", title: "PUBLIC FORUM" },
      { item: "9", title: "CORRESPONDENCE RECEIVED FOR WHICH DIRECTION IS REQUIRED" },
      { item: "10", title: "REPORTS OF CITY STAFF" },
      { item: "10.a", title: "Senior Planner Report ZBA 58" },
    ],
  };
  const dispositions = [
    boundary("5", "executed", "atomic_000039", "procedural", "Number five, motion to move council", 0.99),
    boundary("6", "empty", "atomic_000046", "public_meeting", "number six on our agenda", 0.99),
    boundary("7", "container"),
    boundary("7.a", "executed", "atomic_000048", "deputation", "we have a deputation from Christopher Stevens", 0.99),
    boundary("8", "executed", "atomic_000165", "public_forum", "next on our agenda is public forum", 0.99),
    boundary("9", "empty", "atomic_000313", "correspondence", "number nine and we have no correspondence", 0.99),
    boundary("10", "container"),
    boundary("10.a", "executed", "atomic_000314", "staff_report", "number 10A we have a report from Senior Planner", 0.99),
  ];
  const grounded = buildGroundedTimeline({ canonical, units, dispositions });
  const byItem = (item) => grounded.find((unit) => unit["agenda item"] === item);

  assert.equal(byItem("5")["row end"], 43);
  assert.equal(byItem("6")["row start"], 44);
  assert.equal(byItem("6")["row end"], 45);
  assert.equal(byItem("7.a")["row start"], 46);
  assert.equal(byItem("7.a")["row end"], 161);
  assert.equal(byItem("8")["row start"], 162);
  assert.equal(byItem("8")["row end"], 303);
  assert.equal(byItem("9")["row start"], 304);
  assert.equal(byItem("10.a")["row start"], 305);
  assert.match(byItem("7.a")["source excerpt"], /Glassworks/iu);
  assert.doesNotMatch(byItem("8")["source excerpt"], /deputation from Christopher Stevens/iu);
  assert.match(byItem("8")["source excerpt"], /meal services/iu);
  assert.doesNotMatch(byItem("5")["source excerpt"], /Glassworks/iu);
});

test("timeline validation permits revisited items but rejects overlapping and non-literal boundaries", () => {
  const canonical = { items: [{ item: "1", title: "First" }, { item: "2", title: "Second" }] };
  const units = buildAtomicTranscriptUnits({ rows: [{ speaker: "Chair", text: "First item begins." }, { speaker: "Chair", text: "Second item begins." }] });
  const revisited = validateReconciledTimeline([
    boundary("1", "executed", "atomic_000002", "procedural", "Second item", 0.9),
    boundary("2", "executed", "atomic_000001", "staff_report", "First item", 0.9),
  ], canonical, units);
  assert.deepEqual(revisited.map((entry) => entry["agenda item"]), ["2", "1"]);
  assert.throws(() => validateReconciledTimeline([
    boundary("1", "executed", "atomic_000001", "procedural", "First item", 0.9),
    boundary("2", "executed", "atomic_000001", "staff_report", "First item", 0.9),
  ], canonical, units), /overlapping/iu);
  assert.throws(() => validateReconciledTimeline([
    boundary("1", "executed", "atomic_000001", "procedural", "words that were never spoken", 0.9),
    boundary("2", "executed", "atomic_000002", "staff_report", "Second item", 0.9),
  ], canonical, units), /non-literal/iu);
  assert.throws(() => validateReconciledTimeline([
    boundary("1", "executed", "atomic_000001", "procedural", "First item", 0.2),
    boundary("2", "executed", "atomic_000002", "staff_report", "Second item", 0.9),
  ], canonical, units), /low-confidence/iu);
});

test("timeline validation keeps a lone boundary from absorbing a long meeting", () => {
  const canonical = { items: [{ item: "1", title: "Call to order" }, { item: "2", title: "Reports" }] };
  const units = buildAtomicTranscriptUnits({ rows: [
    { since: 0, until: 5, speaker: "Chair", text: "Call to order." },
    { since: 5, until: 1800, speaker: "Staff", text: "The meeting continues through several substantive reports." },
  ] });
  assert.throws(() => validateReconciledTimeline([
    boundary("1", "executed", "atomic_000001", "procedural", "Call to order", 0.9),
    boundary("2", "skipped"),
  ], canonical, units), /one boundary would absorb/iu);
});

test("long grounded items split into character-bounded child chapters", () => {
  const canonical = { items: [{ item: "8.a", title: "Service Review Implementation Summary", level: 2, substantive: true }] };
  const units = buildAtomicTranscriptUnits({ rows: Array.from({ length: 24 }, (_, index) => ({
    since: index * 30,
    until: (index + 1) * 30,
    speaker: "Staff",
    text: `Topic ${index + 1} ${"distinct report evidence ".repeat(34)}`,
  })) });
  const grounded = buildGroundedTimeline({
    canonical,
    units,
    dispositions: [
      { "agenda item": "8.a", status: "executed", "atomic unit id": "atomic_000001", role: "staff_report", "evidence quote": "Topic 1 distinct", confidence: 0.95 },
    ],
  });
  const chapters = grounded[0]["child chapters"];
  assert.ok(chapters.length >= 2);
  assert.ok(chapters.every((chapter) => Number(chapter["source chars"] || 0) <= 8000));
  assert.equal(chapters[0]["row start"], grounded[0]["row start"]);
  assert.equal(chapters.at(-1)["row end"], grounded[0]["row end"]);
});

test("article outcome claims require motion evidence in the matching agenda segment", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-claims-"));
  const groundingPath = path.join(temp, "grounding.pya");
  writePyaMapArtifact(groundingPath, "agenda section grounding artifact", {
    "schema version": "agenda_section_grounding_v2",
    "generated time": new Date(0).toISOString(),
    "canonical source path": canonicalPath,
    "canonical source type": "structured_escribe_index",
    "canonical fingerprint": "0".repeat(64),
    "transcript rows total": 2,
    "atomic units total": 2,
    "grounded units": [
      { "agenda item": "7.a", label: "Glassworks Village deputation", role: "deputation", "source excerpt": "The presenter requested support for the Glassworks Village planning application." },
      { "agenda item": "21.a", label: "Eighth Avenue land transfer bylaw", role: "bylaw", "source excerpt": "Council considered the Eighth Avenue land transfer. The motion was carried." },
    ],
  });
  const wrong = verifyArticleClaims({
    bodyMarkdown: "## One-Sentence Summary\nCouncil approved the Glassworks Village planning application.",
    agendaSectionGroundingPyaPath: groundingPath,
  });
  assert.equal(wrong.blocked, true);
  const requestedDirectionIsNotDirection = verifyArticleClaims({
    bodyMarkdown: "## Whole Meeting Summary\nLeadership directed staff to continue technical studies for Glassworks Village.",
    agendaSectionGroundingPyaPath: groundingPath,
  });
  assert.equal(requestedDirectionIsNotDirection.blocked, true);
  const supported = verifyArticleClaims({
    bodyMarkdown: "## One-Sentence Summary\nCouncil approved the Eighth Avenue land transfer bylaw.",
    agendaSectionGroundingPyaPath: groundingPath,
  });
  assert.equal(supported.blocked, false);
});
