#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  classifyMeetingVideoUrls,
  fetchMeetingRecordById,
  resolveMeetingVideoUrls,
} from "./escribe-video-links.mjs";

function usage() {
  return "Usage: node program/backfill-meeting-video-links.mjs <meeting_dir>";
}

function ensureDir(dirPath) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) {
    throw new Error(`meeting directory not found: ${dirPath}`);
  }
}

function monthRangeFromIso(isoText) {
  const m = String(isoText || "").match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!m) return { start: "2020-01-01", end: "2030-12-31" };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const start = `${m[1]}-${m[2]}-01`;
  const endDate = new Date(Date.UTC(y, mo, 0, 12, 0, 0));
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

function parseMeetingJson(meetingJsonPath) {
  const parsed = JSON.parse(fs.readFileSync(meetingJsonPath, "utf8"));
  const payload = parsed?.payload && typeof parsed.payload === "object" ? { ...parsed.payload } : {};
  return { root: parsed, payload };
}

function updateLemmyPayloads(transcriptDir, preferredVideoUrl, meetingUrl) {
  if (!preferredVideoUrl && !meetingUrl) return [];
  const files = fs.readdirSync(transcriptDir)
    .filter((name) => /\.lemmy-post(?:\..+)?\.json$/u.test(name))
    .filter((name) => !name.endsWith(".meeting-publish.response.json"))
    .map((name) => path.join(transcriptDir, name));
  const touched = [];
  for (const filePath of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const source = parsed.source && typeof parsed.source === "object" ? { ...parsed.source } : {};
    if (meetingUrl) source.meeting_url = meetingUrl;
    if (preferredVideoUrl) source.video_url = preferredVideoUrl;
    parsed.source = source;
    fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    touched.push(filePath);
  }
  return touched;
}

async function main() {
  const meetingDirArg = process.argv[2];
  if (!meetingDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }
  const meetingDir = path.resolve(process.cwd(), meetingDirArg);
  ensureDir(meetingDir);

  const meetingJsonPath = path.join(meetingDir, "meeting.json");
  if (!fs.existsSync(meetingJsonPath)) throw new Error(`missing meeting.json: ${meetingJsonPath}`);

  const { root, payload } = parseMeetingJson(meetingJsonPath);
  const meetingId = String(payload?.meeting_id || "").trim();
  if (!meetingId) throw new Error("meeting.json payload is missing meeting_id");

  const { start, end } = monthRangeFromIso(root?.since || payload?.start_local || "");
  const record = await fetchMeetingRecordById(meetingId, start, end);
  const docs = Array.isArray(record?.MeetingDocumentLink) ? record.MeetingDocumentLink : [];
  const docVideoUrls = classifyMeetingVideoUrls(docs);
  const seedVideo = Array.isArray(payload.video) ? payload.video : [];
  const merged = [...docVideoUrls, ...seedVideo];
  const resolved = await resolveMeetingVideoUrls(merged);

  payload.video = resolved.all;
  payload.video_direct = resolved.direct;
  payload.video_player = resolved.player;
  payload.video_resolved_at_utc = new Date().toISOString();

  root.payload = payload;
  fs.writeFileSync(meetingJsonPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");

  const transcriptDir = path.join(meetingDir, "transcript");
  const preferredVideoUrl = String(resolved.direct[0] || resolved.all[0] || "").trim();
  const touchedPayloads = fs.existsSync(transcriptDir)
    ? updateLemmyPayloads(transcriptDir, preferredVideoUrl, String(payload.meeting_url || ""))
    : [];

  process.stdout.write(`[backfill-video] meeting_id: ${meetingId}\n`);
  process.stdout.write(`[backfill-video] meeting.json: ${meetingJsonPath}\n`);
  process.stdout.write(`[backfill-video] video direct count: ${resolved.direct.length}\n`);
  process.stdout.write(`[backfill-video] video player count: ${resolved.player.length}\n`);
  if (preferredVideoUrl) {
    process.stdout.write(`[backfill-video] preferred video_url: ${preferredVideoUrl}\n`);
  }
  for (const filePath of touchedPayloads) {
    process.stdout.write(`[backfill-video] updated payload: ${filePath}\n`);
  }
}

await main();
