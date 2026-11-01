#!/usr/bin/env node

// Discover and process archived Police Services Board recordings. This is
// deliberately separate from the daily poller: backfill is oldest-first,
// bounded to one recording by default, and skips short/closed-session items
// that are not useful public transcripts. Failed or incomplete publish
// responses remain eligible on the next scheduled run until a real URL-backed
// success is recorded.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSuccessfulPublishResponse } from "./shared/police-publish-state.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWEN_ROOT = path.resolve(PROGRAM_DIR, "..");
const ANDRII_ROOT = path.resolve(OWEN_ROOT, "../andrii-youtube-reporter");
const MEETINGS_DIR = path.join(ANDRII_ROOT, "artifacts/andrii-youtube/meetings");
const CHANNEL = "https://www.youtube.com/@owensoundpolice8677/streams";
const EXTRACTOR_ARGS = String(process.env.ANDRII_YTDLP_EXTRACTOR_ARGS || "youtube:player_client=android").trim();
const MIN_DURATION_SECONDS = Math.max(0, Number(process.env.OWEN_POLICE_MIN_DURATION_SEC || 300) || 0);
const INCLUDE_CLOSED = /^(1|true|yes)$/iu.test(String(process.env.OWEN_POLICE_INCLUDE_CLOSED || "0"));
const LIMIT = Math.max(1, Number(process.env.OWEN_POLICE_BACKFILL_LIMIT || 1) || 1);
const START_DATE = String(process.env.OWEN_POLICE_BACKFILL_START_DATE || "").trim();
const END_DATE = String(process.env.OWEN_POLICE_BACKFILL_END_DATE || "").trim();

function ytdlpArgs(args) {
  return EXTRACTOR_ARGS ? [...args, "--extractor-args", EXTRACTOR_ARGS] : [...args];
}

function videoId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]{11}$/u.test(text) ? text : (text.match(/[?&]v=([A-Za-z0-9_-]{11})/u)?.[1] || "");
}

export function recordingDate(meta) {
  for (const key of ["release_timestamp", "timestamp"]) {
    const seconds = Number(meta?.[key]);
    if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString().slice(0, 10);
  }
  for (const key of ["upload_date", "release_date", "date"]) {
    const value = String(meta?.[key] || "").trim();
    if (/^\d{8}$/u.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  }
  return "";
}

export function isBackfillDateEligible(date, { startDate = "", endDate = "" } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(date || ""))) return false;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(String(startDate || "")) && date < startDate) return false;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(String(endDate || "")) && date > endDate) return false;
  return true;
}

function probe(ref) {
  try {
    const raw = execFileSync("yt-dlp", ytdlpArgs([
      "--quiet", "--skip-download", "--no-warnings", "--no-playlist",
      "--print", "%(id)s\\t%(upload_date)s\\t%(release_timestamp)s\\t%(duration)s\\t%(title)s\\t%(live_status)s\\t%(was_live)s",
      ref,
    ]), { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 20_000 }).trim();
    const [id, upload_date, release_timestamp, duration, ...rest] = raw.split("\\t");
    const was_live = rest.pop() === "True";
    const live_status = rest.pop() || "";
    return { id, upload_date, release_timestamp, duration: Number(duration) || 0, title: rest.join("\\t"), live_status, was_live };
  } catch (err) {
    process.stderr.write(`[owen-police-backfill] probe failed for ${ref}: ${String(err?.message || err)}\n`);
    return null;
  }
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
      for (const response of responses) {
        try {
          const payload = JSON.parse(fs.readFileSync(path.join(transcriptDir, response.name), "utf8"));
          if (isSuccessfulPublishResponse(payload)) return true;
        } catch {}
      }
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
  const args = [
    "--quiet", "--ignore-errors", "--dump-single-json", "--flat-playlist",
  ];
  const playlistEnd = Number(process.env.OWEN_POLICE_BACKFILL_PLAYLIST_END || 0);
  if (Number.isFinite(playlistEnd) && playlistEnd > 0) {
    args.push("--playlist-end", String(Math.floor(playlistEnd)));
  }
  args.push(CHANNEL);
  const raw = execFileSync("yt-dlp", ytdlpArgs(args), {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: Math.max(120_000, Number(process.env.OWEN_POLICE_BACKFILL_DISCOVERY_TIMEOUT_MS || 300_000) || 300_000),
  });
  const listing = JSON.parse(raw || "{}");
  const entries = Array.isArray(listing?.entries) ? listing.entries : [];
  const candidates = [];
  for (const entry of entries) {
    const id = videoId(entry?.id || entry?.url);
    if (!id || alreadyPublished(id)) continue;
    const url = `https://www.youtube.com/watch?v=${id}`;
    const meta = probe(url);
    if (!meta) continue;
    const date = recordingDate(meta);
    if (!isBackfillDateEligible(date, { startDate: START_DATE, endDate: END_DATE })) continue;
    if (!(meta.was_live === true || /^(?:was_live|post_live)$/iu.test(String(meta.live_status || "")))) continue;
    const duration = Number(meta.duration || 0) || 0;
    const title = String(meta.title || entry?.title || "OSPSB recording");
    if (duration < MIN_DURATION_SECONDS) {
      process.stdout.write(`[owen-police-backfill] skip ${id}: ${date} duration=${Math.round(duration)}s below minimum ${MIN_DURATION_SECONDS}s\n`);
      continue;
    }
    if (!INCLUDE_CLOSED && /closed\s+session/iu.test(title)) {
      process.stdout.write(`[owen-police-backfill] skip ${id}: ${date} closed session\n`);
      continue;
    }
    candidates.push({ id, url, date, duration, title, timestamp: Number(meta.release_timestamp || meta.timestamp || 0) || 0 });
  }
  candidates.sort((a, b) => a.date.localeCompare(b.date) || a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const selected = candidates.slice(0, LIMIT);
  if (!selected.length) {
    process.stdout.write("[owen-police-backfill] no unpublished public-session recording found\n");
    return;
  }
  for (const item of selected) {
    process.stdout.write(`[owen-police-backfill] selected ${item.id}: ${item.date} ${Math.round(item.duration)}s ${item.title}\n`);
    if (/^(1|true|yes)$/iu.test(String(process.env.OWEN_POLICE_BACKFILL_DRY_RUN || "0"))) continue;
    await run(item.url);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
    process.exit(1);
  });
}
