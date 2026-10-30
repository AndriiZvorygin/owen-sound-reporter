#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = "/home/htaf/pyac/pyash";
const HOUSE = path.join(ROOT, "world/house/owen-sound-reporter");

function usage() {
  return "Usage: node program/wise-chunk-meeting-from-transcript-folder.mjs <transcript_dir> [prefix]";
}

function ensureDir(dirPath) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`transcript directory not found: ${dirPath}`);
}

function pickTimingSrt(transcriptDir, prefix = "meeting-qwen-auto") {
  const preferred = path.join(transcriptDir, `${prefix}.timing.srt`);
  if (fs.existsSync(preferred)) return { plainPath: preferred, resolvedPrefix: prefix };

  const candidates = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name.endsWith(".timing.srt"))
    .sort();
  if (!candidates.length) throw new Error(`no *.timing.srt transcript found in ${transcriptDir}`);
  const chosen = candidates[candidates.length - 1];
  const resolvedPrefix = chosen.replace(/\.timing\.srt$/u, "");
  return { plainPath: path.join(transcriptDir, chosen), resolvedPrefix };
}

function main() {
  const transcriptDirArg = process.argv[2];
  const prefixArg = process.argv[3] || "meeting-qwen-auto";
  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const transcriptDir = path.resolve(process.cwd(), transcriptDirArg);
  ensureDir(transcriptDir);
  const { plainPath, resolvedPrefix } = pickTimingSrt(transcriptDir, prefixArg);
  const outputPath = path.join(transcriptDir, `${resolvedPrefix}.wise.series.pya`);

  process.stdout.write(`[wise-chunk-meeting] timing srt: ${plainPath}\n`);
  process.stdout.write(`[wise-chunk-meeting] output series: ${outputPath}\n`);

  const out = execFileSync("node", [
    path.join(ROOT, "command/srt_to_wise_chip_series.mjs"),
    plainPath,
    outputPath,
    "--min-words",
    "120",
    "--max-words",
    "320",
    "--pause-seconds",
    "6"
  ], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024
  });

  if (out.trim()) process.stdout.write(`${out.trim()}\n`);
}

main();
