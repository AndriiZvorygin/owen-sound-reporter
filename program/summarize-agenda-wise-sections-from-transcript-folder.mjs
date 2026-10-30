#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgendaStage3SummaryRenderer } from "../../../../program/library/reporter_shared/agenda-stage3-summary-renderer.mjs";

const HOUSE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolvePrefix(transcriptDir, prefixArg = "auto") {
  if (prefixArg && !/^auto$/iu.test(String(prefixArg))) return String(prefixArg);
  const candidates = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => n.endsWith(".agenda.section-grounding.pya"))
    .map((n) => n.replace(/\.agenda\.section-grounding\.pya$/u, ""))
    .sort();
  if (!candidates.length) throw new Error(`no *.agenda.section-grounding.pya found in ${transcriptDir}`);
  return candidates[candidates.length - 1];
}

async function main() {
  if (!process.env.PYA_RUNTIME_FILE) process.env.PYA_RUNTIME_FILE = path.join(HOUSE, "conduct", "runtime.pya");
  const transcriptDirArg = process.argv[2];
  const prefixArg = process.argv[3] || "auto";
  const focusArg = process.argv.slice(4).join(" ").trim();
  if (!transcriptDirArg) {
    process.stdout.write("Usage: node program/summarize-agenda-wise-sections-from-transcript-folder.mjs <transcript_dir> [prefix] [focus]\n");
    process.exit(2);
  }
  const transcriptDir = path.resolve(process.cwd(), transcriptDirArg);
  const prefix = resolvePrefix(transcriptDir, prefixArg);
  const ollamaBase = process.env.OLLAMA_HOST?.replace(/\/$/u, "") || "http://mriczo:11434";

  await runAgendaStage3SummaryRenderer({
    transcriptDir,
    prefix,
    sectionGroundingPyaPath: path.join(transcriptDir, `${prefix}.agenda.section-grounding.pya`),
    outSummaryPyaPath: path.join(transcriptDir, `${prefix}.agenda-summary.pya`),
    outSummaryMdPath: path.join(transcriptDir, `${prefix}.agenda-summary.md`),
    focus: focusArg,
    ollamaUrl: `${ollamaBase}/api/chat`,
    log: (line) => process.stdout.write(`${line}\n`),
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
