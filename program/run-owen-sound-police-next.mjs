#!/usr/bin/env node

// Discover one new recording from the Police Services Board channel and pass
// it to the shared profile runner.  This is intentionally only discovery and
// routing; all transcription and prose remain in the verified LLM pipeline.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWEN_ROOT = path.resolve(PROGRAM_DIR, "..");
const ANDRII_ROOT = path.resolve(OWEN_ROOT, "../andrii-youtube-reporter");
const MEETINGS_DIR = path.join(ANDRII_ROOT, "artifacts/andrii-youtube/meetings");
const CHANNEL = "https://www.youtube.com/@owensoundpolice8677/streams";
const EXTRACTOR_ARGS = String(process.env.ANDRII_YTDLP_EXTRACTOR_ARGS || "youtube:player_client=android").trim();

function ytdlpArgs(args) {
  return EXTRACTOR_ARGS ? [...args, "--extractor-args", EXTRACTOR_ARGS] : [...args];
}

function probe(ref) {
  try {
    return JSON.parse(execFileSync("yt-dlp", ytdlpArgs([
      "--quiet", "--dump-single-json", "--skip-download", "--no-warnings", ref,
    ]), { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30_000 }));
  } catch (err) {
    process.stderr.write(`[owen-police-next] probe failed for ${ref}: ${String(err?.message || err)}\n`);
    return null;
  }
}

function videoId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]{11}$/u.test(text) ? text : (text.match(/[?&]v=([A-Za-z0-9_-]{11})/u)?.[1] || "");
}

function alreadyPublished(id) {
  if (!id || !fs.existsSync(MEETINGS_DIR)) return false;
  for (const entry of fs.readdirSync(MEETINGS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(MEETINGS_DIR, entry.name);
    try {
      const meeting = JSON.parse(fs.readFileSync(path.join(dir, "meeting.json"), "utf8"));
      if (String(meeting?.payload?.meeting_id || "").trim() !== id) continue;
      const transcriptDir = path.join(dir, "transcript");
      const responses = fs.readdirSync(transcriptDir, { withFileTypes: true })
        .filter((file) => file.isFile() && /\.meeting-publish\.response(?:\.attempt-\d+)?\.json$/u.test(file.name));
      if (responses.length) return true;
    } catch {}
  }
  return false;
}

function run(ref) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PROGRAM_DIR, "run-owen-sound-police-from-ref.mjs"), ref], {
      cwd: OWEN_ROOT,
      env: { ...process.env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`police runner failed (code=${code ?? "null"} signal=${signal ?? ""})`)));
  });
}

async function main() {
  const raw = execFileSync("yt-dlp", ytdlpArgs([
    "--quiet", "--ignore-errors", "--dump-single-json", "--flat-playlist", "--playlist-end", "40", CHANNEL,
  ]), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const listing = JSON.parse(raw || "{}");
  const entries = Array.isArray(listing?.entries) ? listing.entries : [];
  for (const entry of entries) {
    const id = videoId(entry?.id || entry?.url);
    if (!id || alreadyPublished(id)) continue;
    const url = `https://www.youtube.com/watch?v=${id}`;
    const meta = probe(url);
    if (!meta || !(meta.was_live === true || /^(?:was_live|post_live)$/iu.test(String(meta.live_status || "")))) continue;
    process.stdout.write(`[owen-police-next] selected ${id}: ${String(meta.title || entry?.title || "OSPSB recording")}\n`);
    await run(url);
    return;
  }
  process.stdout.write("[owen-police-next] no unposted Police Services Board recording found\n");
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});

