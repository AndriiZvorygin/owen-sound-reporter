#!/usr/bin/env node

// Owen Sound Council YouTube source runner.  This keeps YouTube processing in
// the shared Andrii pipeline, then hands the verified payload to the normal
// Owen Sound publisher.  Speaker settings are explicit because candidate
// forums are panels rather than two-person interviews.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWEN_ROOT = path.resolve(PROGRAM_DIR, "..");
const ANDRII_ROOT = path.resolve(OWEN_ROOT, "../andrii-youtube-reporter");
const ANDRII_RUNNER = path.join(ANDRII_ROOT, "program/run-andrii-youtube-meeting-from-ref.mjs");
const OWEN_PUBLISHER = path.join(OWEN_ROOT, "program/publish-meeting-to-helpos-from-payload.mjs");
const MEETINGS_DIR = path.join(ANDRII_ROOT, "artifacts/andrii-youtube/meetings");
const BASE_PREFIX = String(process.env.OWEN_COUNCIL_BASE_PREFIX || "meeting-qwen-auto").trim() || "meeting-qwen-auto";
const DEFAULT_FOCUS = [
  "the candidate's stated positions, answers, and concrete proposals in this recording",
  "the questions or prompts and any substantive policy differences actually discussed",
  "using a neutral, source-faithful lens without assigning views that were not stated",
].join(", ");

function usage() {
  return [
    "Usage: node program/run-owen-sound-youtube-from-ref.mjs <video_ref> [focus]",
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

function ensureMeetingRouteSlug(payloadPath) {
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const route = String(payload?.meeting_route_slug || payload?.topic || "council-meeting").trim() || "council-meeting";
  if (payload.meeting_route_slug === route) return;
  payload.meeting_route_slug = route;
  fs.writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function firstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

async function main() {
  const ref = String(process.argv[2] || "").trim();
  if (!ref) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }
  const id = videoId(ref);
  if (!id) throw new Error(`could not identify YouTube video id from ref: ${ref}`);
  const focus = String(process.argv[3] || process.env.OWEN_COUNCIL_SUMMARY_FOCUS || DEFAULT_FOCUS).trim();
  const runnerEnv = {
    ANDRII_SOURCE_PROFILE: "owen-sound-council",
    ANDRII_SOURCE_CHANNEL_URL: "https://www.youtube.com/@AndriiZ/streams",
    ANDRII_SOURCE_SLUG: "owen-sound",
    ANDRII_TOPIC_SLUG: "council-meeting",
    // Candidate interviews are often uploaded in batches on the same date;
    // keep each transcript page distinct while retaining the shared topic.
    PYA_TRANSCRIPT_ROUTE_SUFFIX: id,
    ANDRII_COMMUNITY_NAME: "owen-sound-council",
    ANDRII_CONTENT_MODE: "general",
    ANDRII_AUTOPUBLISH: "0",
    // The panel has six candidates plus a moderator. Keep these overridable
    // for future forums while making the intended seven-speaker run explicit.
    PYA_SPEAKER_EXPECTED_MAX: firstEnv("PYA_SPEAKER_EXPECTED_MAX") || "7",
    // Sentence-level attribution is mandatory; aggregate SpeechBrain
    // reconciliation is intentionally not exposed here.
    PYA_SPEAKER_SENTENCE_ONLY: "1",
    PYA_SPEAKER_TWO_SPEAKER_CUE_TURNS: "1",
    PYA_SPEAKER_CUE_LEVEL_TURNS: "1",
    PYA_SPEAKER_BAD_SAMPLE_GUARD: "1",
    PYA_SPEAKER_BOUNDARY_REFINE: firstEnv("PYA_SPEAKER_BOUNDARY_REFINE") || "0",
    PYA_SPEAKER_SAME_THRESHOLD: firstEnv("PYA_SPEAKER_SAME_THRESHOLD") || "0.72",
    // Optional panel-forum mode: the shared pipeline can identify moderator
    // and audience questions and start chapters at those question cues. Keep
    // it opt-in because ordinary council livestreams need their normal topic
    // segmentation.
    PYA_CHAPTER_QUESTION_MODE: firstEnv("PYA_CHAPTER_QUESTION_MODE", "OWEN_COUNCIL_QUESTION_CHAPTERS") || "0",
    // Answer-level chapters are separate from ordinary question chapters and
    // require a named-speaker roster. Enable them for candidate forums with
    // PYA_ANSWER_CHAPTER_MODE=1 (or the Owen-specific alias below).
    PYA_ANSWER_CHAPTER_MODE: firstEnv("PYA_ANSWER_CHAPTER_MODE", "OWEN_COUNCIL_ANSWER_CHAPTERS") || "0",
    // Optional evidence-backed transcript labels for candidate forums. The
    // linker works at row ranges, not raw diarizer IDs, and leaves mixed rows
    // generic. Keep this opt-in for ordinary council meetings.
    PYA_SPEAKER_NAME_LINKING: firstEnv("PYA_SPEAKER_NAME_LINKING", "OWEN_COUNCIL_SPEAKER_NAMES") || "0",
    PYA_SPEAKER_NAME_ROSTER: firstEnv("PYA_SPEAKER_NAME_ROSTER", "OWEN_COUNCIL_SPEAKER_ROSTER") || "",
  };
  process.stdout.write(`[owen-council] processing ${ref} through shared YouTube pipeline (expected speakers: ${runnerEnv.PYA_SPEAKER_EXPECTED_MAX})\n`);
  await run(process.execPath, [ANDRII_RUNNER, ref, BASE_PREFIX, focus, "Owen Sound", "Council", "https://helpos.ca"], runnerEnv);

  const meetingDir = findMeetingDir(id);
  if (!meetingDir) throw new Error(`shared pipeline completed but meeting workspace was not found for ${id}`);
  const transcriptDir = path.join(meetingDir, "transcript");
  const payloadPath = path.join(transcriptDir, `${BASE_PREFIX}-normalized.lemmy-post.json`);
  if (!fs.existsSync(payloadPath)) throw new Error(`shared pipeline did not produce payload: ${payloadPath}`);
  ensureMeetingRouteSlug(payloadPath);
  const dateIso = sourceDate(payloadPath);
  const key = String(process.env.OWEN_COUNCIL_IDEMPOTENCY_KEY || `owen-sound-council-youtube-${id}-${dateIso}-v1`).trim();
  const publishEnv = {
    MEETING_PUBLISH_COMMUNITY_NAME: "owen-sound-council",
    MEETING_PUBLISH_IDEMPOTENCY_KEY: key,
  };
  const postRef = String(process.env.OWEN_COUNCIL_POST_REF || "").trim();
  if (postRef) publishEnv.MEETING_PUBLISH_POST_REF = postRef;
  if (/^(1|true|yes)$/iu.test(String(process.env.OWEN_COUNCIL_DRY_RUN || "0"))) {
    publishEnv.MEETING_PUBLISH_DRY_RUN = "1";
  }
  process.stdout.write(`[owen-council] publishing ${payloadPath} to owen-sound-council\n`);
  await run(process.execPath, [OWEN_PUBLISHER, payloadPath, "owen-sound-council", key], publishEnv, OWEN_ROOT);
  process.stdout.write(`[owen-council] done: video=${id} date=${dateIso} payload=${payloadPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
