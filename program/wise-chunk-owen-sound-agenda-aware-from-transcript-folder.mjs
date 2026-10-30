#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runLlmAgendaSegmentation } from "../../../../program/library/reporter_shared/agenda-llm-segmentation.mjs";
import { pickRichestAgendaPathFromMeetingDir } from "../../../../program/library/agenda_preview_shared.mjs";
import { resolveTextModel } from "../../../../program/runtime/gpu/text-model.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE = path.resolve(PROGRAM_DIR, "..");
const OLLAMA_BASE = process.env.OLLAMA_HOST?.replace(/\/$/u, "") || "http://mriczo:11434";
const OLLAMA_URL = `${OLLAMA_BASE}/api/chat`;
const LLM_MODEL = resolveTextModel("", { runtimePath: path.join(HOUSE, "conduct", "runtime.pya") });

function usage() {
  return "Usage: node program/wise-chunk-owen-sound-agenda-aware-from-transcript-folder.mjs <transcript_dir> [prefix]";
}

function resolveReporterPath(inputPath) {
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
  const fromCwd = path.resolve(process.cwd(), inputPath);
  return fs.existsSync(fromCwd) ? fromCwd : path.resolve(HOUSE, inputPath);
}

function readNormalizeCheckpoint(transcriptDir, prefix) {
  const metaPath = path.join(transcriptDir, `${prefix}.normalize.metadata.json`);
  if (!fs.existsSync(metaPath)) return { exists: false, complete: false };
  try {
    const obj = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const total = Number(obj?.chunks_total);
    const done = Number(obj?.chunks_processed);
    return { exists: true, complete: Number.isFinite(total) && total > 0 && done === total };
  } catch {
    return { exists: true, complete: false };
  }
}

function pickPrefix(transcriptDir, requested = "auto") {
  if (requested && !/^auto$/iu.test(requested)) return requested;
  const candidates = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".plain.txt"))
    .map((entry) => entry.name.replace(/\.plain\.txt$/u, ""))
    .map((prefix) => {
      const checkpoint = readNormalizeCheckpoint(transcriptDir, prefix);
      let score = checkpoint.complete ? 400 : (checkpoint.exists ? -300 : 0);
      if (/normalized/iu.test(prefix)) score += 150;
      if (/test|tmp|partial/iu.test(prefix)) score -= 250;
      return { prefix, score, mtime: fs.statSync(path.join(transcriptDir, `${prefix}.plain.txt`)).mtimeMs };
    })
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  if (!candidates.length) throw new Error(`no *.plain.txt transcript found in ${transcriptDir}`);
  return candidates[0].prefix;
}

function fallbackAgendaPath(meetingDir) {
  const converted = path.join(meetingDir, "converted");
  for (const filename of ["agenda-01.md", "agenda-99-from-pdf.pruned.md", "agenda-pruned.md"]) {
    const candidate = path.join(converted, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return pickRichestAgendaPathFromMeetingDir(meetingDir) || "";
}

async function main() {
  const transcriptDirArg = process.argv[2];
  if (!transcriptDirArg) {
    process.stderr.write(`${usage()}\n`);
    process.exit(2);
  }
  const transcriptDir = resolveReporterPath(transcriptDirArg);
  if (!fs.statSync(transcriptDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`transcript directory not found: ${transcriptDir}`);
  }
  const prefix = pickPrefix(transcriptDir, process.argv[3] || "auto");
  const meetingDir = path.dirname(transcriptDir);
  const rowsJsonPath = path.join(transcriptDir, `${prefix}.sentences.speaker.sentences.json`);
  const canonicalIndexPath = path.join(meetingDir, "converted", "subreports.index.json");
  const meetingRecord = JSON.parse(fs.readFileSync(path.join(meetingDir, "meeting.json"), "utf8"));
  const meetingLabel = String(meetingRecord?.payload?.meeting_name || meetingRecord?.payload?.meeting_type || "").trim();
  if (!fs.existsSync(rowsJsonPath)) throw new Error(`speaker rows json not found: ${rowsJsonPath}`);

  process.stdout.write(`[agenda-boundaries] transcript rows: ${rowsJsonPath}\n`);
  process.stdout.write(`[agenda-boundaries] canonical agenda: ${fs.existsSync(canonicalIndexPath) ? canonicalIndexPath : "LLM fallback"}\n`);
  process.stdout.write(`[agenda-boundaries] model: ${LLM_MODEL}\n`);
  process.stdout.write(`[agenda-boundaries] meeting scope: ${meetingLabel || "(unavailable)"}\n`);

  await runLlmAgendaSegmentation({
    rowsJsonPath,
    canonicalIndexPath,
    fallbackAgendaPath: fallbackAgendaPath(meetingDir),
    candidatesPyaPath: path.join(transcriptDir, `${prefix}.agenda.gross-chunks.pya`),
    matchesPyaPath: path.join(transcriptDir, `${prefix}.agenda.matches.pya`),
    wiseSeriesPyaPath: path.join(transcriptDir, `${prefix}.agenda-wise.series.pya`),
    sectionGroundingPyaPath: path.join(transcriptDir, `${prefix}.agenda.section-grounding.pya`),
    llmModel: LLM_MODEL,
    ollamaUrl: OLLAMA_URL,
    meetingLabel,
    log: (line) => process.stdout.write(`${line}\n`),
  });
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error?.message || error)}\n`);
  process.exit(1);
});
