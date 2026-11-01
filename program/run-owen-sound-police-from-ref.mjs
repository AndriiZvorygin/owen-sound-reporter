#!/usr/bin/env node

// Owen Sound Police Services Board source runner.  Processing stays in the
// shared managed YouTube pipeline; this wrapper supplies source identity and
// hands the verified payload to the existing Owen publisher/community.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWEN_ROOT = path.resolve(PROGRAM_DIR, "..");
const ANDRII_ROOT = path.resolve(OWEN_ROOT, "../andrii-youtube-reporter");
const ANDRII_RUNNER = path.join(ANDRII_ROOT, "program/run-andrii-youtube-meeting-from-ref.mjs");
const OWEN_PUBLISHER = path.join(OWEN_ROOT, "program/publish-meeting-to-helpos-from-payload.mjs");
const MEETINGS_DIR = path.join(ANDRII_ROOT, "artifacts/andrii-youtube/meetings");
const BASE_PREFIX = String(process.env.OWEN_POLICE_BASE_PREFIX || "meeting-qwen-auto").trim() || "meeting-qwen-auto";
const DEFAULT_FOCUS = "the main topics, decisions, reports, and public-safety implications discussed by the Owen Sound Police Services Board, using a neutral source-faithful lens";

function usage() {
  return [
    "Usage: node program/run-owen-sound-police-from-ref.mjs <video_ref> [focus]",
    "The ref may be a YouTube URL or an 11-character video id.",
  ].join("\n");
}

function run(cmd, args, env = {}, cwd = ANDRII_ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} failed (code=${code ?? "null"} signal=${signal ?? ""})`));
    });
  });
}

function videoId(ref) {
  const value = String(ref || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/u.test(value)) return value;
  return value.match(/[?&]v=([A-Za-z0-9_-]{11})/u)?.[1]
    || value.match(/youtu\.be\/([A-Za-z0-9_-]{11})/u)?.[1]
    || "";
}

function findMeetingDir(id) {
  if (!id || !fs.existsSync(MEETINGS_DIR)) return "";
  const matches = [];
  for (const entry of fs.readdirSync(MEETINGS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(MEETINGS_DIR, entry.name);
    const meetingJson = path.join(dir, "meeting.json");
    if (!fs.existsSync(meetingJson)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(meetingJson, "utf8"));
      if (String(parsed?.payload?.meeting_id || "").trim() === id) matches.push(dir);
    } catch {}
  }
  return matches.sort().at(-1) || "";
}

function sourceDate(payloadPath) {
  try {
    const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
    return String(payload?.date_iso || "unknown-date").trim() || "unknown-date";
  } catch {
    return "unknown-date";
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "unknown";
}

export function canonicalTranscriptUrl(payload, siteUrl = process.env.MEETING_PUBLISH_SITE_URL || "https://helpos.ca") {
  const jurisdiction = slugify(payload?.jurisdiction || "Owen Sound Police");
  const route = slugify(payload?.meeting_route_slug || payload?.topic || "police-board");
  const date = String(payload?.date_iso || "").trim();
  return `${String(siteUrl || "https://helpos.ca").replace(/\/+$/u, "")}/transcripts/${jurisdiction}/${route}/${date}`;
}

function ensureMeetingRouteSlug(payloadPath) {
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const route = String(payload?.meeting_route_slug || payload?.topic || "police-board").trim() || "police-board";
  const canonical = canonicalTranscriptUrl({ ...payload, meeting_route_slug: route });
  payload.meeting_route_slug = route;
  payload.transcript_url = canonical;
  const htmlPathRaw = String(payload?.local_transcript_html || "").trim();
  const htmlPath = htmlPathRaw
    ? (path.isAbsolute(htmlPathRaw) ? htmlPathRaw : path.resolve(path.dirname(payloadPath), htmlPathRaw))
    : "";
  if (htmlPath && fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, "utf8");
    const rewritten = html.replace(
      /(<link\s+rel=["']canonical["']\s+href=["'])[^"']+(["'])/iu,
      `$1${canonical}$2`,
    );
    if (rewritten !== html) fs.writeFileSync(htmlPath, rewritten, "utf8");
  }
  fs.writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const ref = String(process.argv[2] || "").trim();
  if (!ref) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }
  const id = videoId(ref);
  if (!id) throw new Error(`could not identify YouTube video id from ref: ${ref}`);
  const focus = String(process.argv[3] || process.env.OWEN_POLICE_SUMMARY_FOCUS || DEFAULT_FOCUS).trim();
  const runnerEnv = {
    ANDRII_SOURCE_PROFILE: "owen-sound-police",
    ANDRII_SOURCE_CHANNEL_URL: "https://www.youtube.com/@owensoundpolice8677/streams",
    ANDRII_SOURCE_SLUG: "owen-sound-police",
    ANDRII_TOPIC_SLUG: "police-board",
    ANDRII_COMMUNITY_NAME: "owen_sound_police",
    ANDRII_CONTENT_MODE: "general",
    ANDRII_AUTOPUBLISH: "0",
  };
  process.stdout.write(`[owen-police] processing ${ref} through shared YouTube pipeline\n`);
  await run(process.execPath, [ANDRII_RUNNER, ref, BASE_PREFIX, focus, "Owen Sound Police", "Police Services Board", "https://helpos.ca"], runnerEnv);

  const meetingDir = findMeetingDir(id);
  if (!meetingDir) throw new Error(`shared pipeline completed but meeting workspace was not found for ${id}`);
  const transcriptDir = path.join(meetingDir, "transcript");
  const payloadPath = path.join(transcriptDir, `${BASE_PREFIX}-normalized.lemmy-post.json`);
  if (!fs.existsSync(payloadPath)) throw new Error(`shared pipeline did not produce payload: ${payloadPath}`);
  ensureMeetingRouteSlug(payloadPath);
  const dateIso = sourceDate(payloadPath);
  const key = String(process.env.OWEN_POLICE_IDEMPOTENCY_KEY || `owen-sound-police-${id}-${dateIso}-v1`).trim();
  const publishEnv = {
    MEETING_PUBLISH_COMMUNITY_NAME: "owen_sound_police",
    MEETING_PUBLISH_IDEMPOTENCY_KEY: key,
  };
  if (/^(1|true|yes)$/iu.test(String(process.env.OWEN_POLICE_DRY_RUN || "0"))) {
    publishEnv.MEETING_PUBLISH_DRY_RUN = "1";
  }
  process.stdout.write(`[owen-police] publishing ${payloadPath} to owen_sound_police\n`);
  // The publisher resolves its local .env/token relative to cwd; keep that
  // resolution in the Owen repo while the shared transcript runner uses the
  // Andrii repo above.
  await run(process.execPath, [OWEN_PUBLISHER, payloadPath, "owen_sound_police", key], publishEnv, OWEN_ROOT);
  process.stdout.write(`[owen-police] done: video=${id} date=${dateIso} payload=${payloadPath}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
    process.exit(1);
  });
}
