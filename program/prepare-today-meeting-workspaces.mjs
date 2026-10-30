#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMeetingVideoUrls } from "./escribe-video-links.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, "..");
const PYASH_ROOT = path.resolve(ROOT, "../../..");
const MONTHLY_DIR = path.join(ROOT, "artifacts/owen-sound/monthly");
const MEETINGS_DIR = path.join(ROOT, "artifacts/owen-sound/meetings");
const TZ = "America/Toronto";

function todayToronto() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "meeting";
}

function parseSeriesLine(line) {
  const m = line.match(
    /^su name (.+?) since date (\S+) until date (\S+) ob text "(.+)" ya$/,
  );
  if (!m) return null;
  const [, suName, since, until, escapedJson] = m;
  let jsonText = "";
  let payload = null;
  try {
    jsonText = JSON.parse(`"${escapedJson}"`);
    payload = JSON.parse(jsonText);
  } catch {
    return null;
  }
  return { suName, since, until, payload };
}

function extFromUrl(url, fallback = ".bin") {
  const clean = String(url || "").split("?")[0];
  if (/filestream\.ashx$/i.test(clean)) return ".pdf";
  if (/meeting\.aspx$/i.test(clean)) return ".html";
  if (/isistandaloneplayer\.aspx$/i.test(clean)) return ".html";
  const base = path.basename(clean);
  const ext = path.extname(base);
  return ext || fallback;
}

function pyaEsc(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function docName(prefix, i, url) {
  const n = String(i + 1).padStart(2, "0");
  const ext = extFromUrl(url, ".pdf");
  return `${prefix}-${n}${ext}`;
}

function markdownName(sourceName) {
  const ext = path.extname(sourceName);
  const stem = sourceName.slice(0, sourceName.length - ext.length);
  return `${stem}.md`;
}

function stripQuery(url) {
  return String(url || "").split("?")[0];
}

function extFromMediaUrl(url) {
  const clean = stripQuery(url).toLowerCase();
  const ext = path.extname(clean);
  return ext || "";
}

function isDirectAudioUrl(url) {
  const ext = extFromMediaUrl(url);
  return ext === ".opus" || ext === ".wav" || ext === ".mp3" || ext === ".m4a" || ext === ".aac" || ext === ".flac";
}

function isDirectVideoUrl(url) {
  const ext = extFromMediaUrl(url);
  return ext === ".mp4" || ext === ".webm" || ext === ".mkv" || ext === ".mov" || ext === ".m4v";
}

function loadTodayMeetings() {
  const day = todayToronto();
  const month = day.slice(0, 7);
  const monthFile = path.join(MONTHLY_DIR, `${month}.events.series.pya`);
  if (!fs.existsSync(monthFile)) return { day, monthFile, meetings: [] };

  const lines = fs.readFileSync(monthFile, "utf8").split("\n");
  const meetings = [];
  for (const line of lines) {
    const row = parseSeriesLine(line.trim());
    if (!row) continue;
    if (!row.since.startsWith(day)) continue;
    meetings.push(row);
  }
  return { day, monthFile, meetings };
}

function buildPipeline(meetingDir, row) {
  const payload = row.payload ?? {};
  const sourceDir = path.join(meetingDir, "source");
  const convertedDir = path.join(meetingDir, "converted");
  const reportDir = path.join(meetingDir, "report");
  const transcriptDir = path.join(meetingDir, "transcript");

  const lines = [];
  lines.push(`su name sandbox configure be map def`);
  lines.push(`su name max output bytes ob num 8388608 ya`);
  lines.push(`su name timeout ms ob num 21600000 ya`);
  lines.push(`prah`);
  lines.push("");
  lines.push(`be directory ob filename "${pyaEsc(sourceDir)}" do`);
  lines.push(`be directory ob filename "${pyaEsc(convertedDir)}" do`);
  lines.push(`be directory ob filename "${pyaEsc(reportDir)}" do`);
  lines.push(`be directory ob filename "${pyaEsc(transcriptDir)}" do`);
  lines.push("");

  const allDocs = [
    ...(Array.isArray(payload.agenda_cover)
      ? payload.agenda_cover.map((u, i) => ({ kind: "agenda-cover", url: u, i }))
      : []),
    ...(Array.isArray(payload.agenda)
      ? payload.agenda.map((u, i) => ({ kind: "agenda", url: u, i }))
      : []),
    ...(Array.isArray(payload.minutes)
      ? payload.minutes.map((u, i) => ({ kind: "minutes", url: u, i }))
      : []),
  ];

  let primaryAgendaMarkdownPath = "";
  let agendaHtmlPath = "";

  for (const doc of allDocs) {
    const fileName = docName(doc.kind, doc.i, doc.url);
    const srcPath = path.join(sourceDir, fileName);
    if (doc.kind === "agenda" && fileName.toLowerCase().endsWith(".html")) {
      agendaHtmlPath = srcPath;
    }
    lines.push(
      `be download from filename "${pyaEsc(doc.url)}" as wo file to filename "${pyaEsc(srcPath)}" do`,
    );
    if (fileName.toLowerCase().endsWith(".pdf")) {
      const mdVar = `doc ${doc.kind} ${doc.i + 1} markdown`;
      const mdPath = path.join(convertedDir, markdownName(fileName));
      if (doc.kind === "agenda" && !primaryAgendaMarkdownPath) {
        primaryAgendaMarkdownPath = mdPath;
      }
      lines.push(
        `from filename "${pyaEsc(srcPath)}" fromstate wo pdf become wo markdown to name text ${mdVar} be read do`,
      );
      lines.push(
        `ob name ${mdVar} to filename "${pyaEsc(mdPath)}" be write do`,
      );
    }
  }

  if (primaryAgendaMarkdownPath) {
    const prunedPath = primaryAgendaMarkdownPath.replace(/\.md$/i, ".pruned.md");
    lines.push(
      `ob text "node /home/htaf/pyac/pyash/world/house/owen-sound-reporter/program/prune-owen-sound-agenda.mjs '${pyaEsc(primaryAgendaMarkdownPath)}' '${pyaEsc(prunedPath)}'" be command do`,
    );
    const subreportDir = path.join(convertedDir, "subreports");
    const subreportIndexPath = path.join(convertedDir, "subreports.index.json");
    if (agendaHtmlPath) {
      lines.push(
        `ob text "node ${pyaEsc(path.join(PYASH_ROOT, "command/prepare_agenda_subreports_from_converted.mjs"))} '${pyaEsc(convertedDir)}' '${pyaEsc(subreportDir)}' '${pyaEsc(subreportIndexPath)}' '${pyaEsc(path.join(ROOT, "program/prune-owen-sound-agenda.mjs"))}' '${pyaEsc(agendaHtmlPath)}' '${pyaEsc(String(payload.meeting_url || payload.source_url || ""))}'" be command do`,
      );
    } else {
      lines.push(
        `ob text "/home/htaf/pyac/pyash/run /home/htaf/pyac/pyash/program/extract-subreports-fromstate-wo-escribe-full.pya \\"${pyaEsc(primaryAgendaMarkdownPath)}\\" \\"${pyaEsc(subreportDir)}\\" \\"${pyaEsc(subreportIndexPath)}\\" \\"${pyaEsc(agendaHtmlPath)}\\" \\"${pyaEsc(String(payload.meeting_url || payload.source_url || ""))}\\"" be command do`,
      );
    }
  }

  lines.push("");
  const videos = Array.isArray(payload.video) ? payload.video : [];
  const videoPlayers = Array.isArray(payload.video_player) ? payload.video_player : [];
  const videoDirect = Array.isArray(payload.video_direct) ? payload.video_direct : [];
  if (videos.length > 0 || videoPlayers.length > 0 || videoDirect.length > 0) {
    const preferred = (videoPlayers[0] || videos[0] || videoDirect[0] || "").trim();
    const direct = (videoDirect[0] || videos[0] || "").trim();
    if (direct && isDirectAudioUrl(direct)) {
      const ext = extFromMediaUrl(direct) || ".opus";
      const outAudio = path.join(transcriptDir, `meeting-audio${ext}`);
      lines.push(
        `ob text "node ${pyaEsc(path.join(PYASH_ROOT, "command/resumable_download.mjs"))} '${pyaEsc(direct)}' '${pyaEsc(outAudio)}' 8" be command do`,
      );
    } else if (direct && isDirectVideoUrl(direct)) {
      const ext = extFromMediaUrl(direct) || ".mp4";
      const outVideo = path.join(transcriptDir, `meeting-video${ext}`);
      const outAudio = path.join(transcriptDir, "meeting-audio.opus");
      lines.push(
        `ob text "node ${pyaEsc(path.join(PYASH_ROOT, "command/resumable_download.mjs"))} '${pyaEsc(direct)}' '${pyaEsc(outVideo)}' 8" be command do`,
      );
      lines.push(
        `ob text "ffmpeg -nostdin -y -i '${pyaEsc(outVideo)}' -vn -ac 1 -ar 16000 -c:a libopus '${pyaEsc(outAudio)}'" be command do`,
      );
    } else {
      lines.push(
        `ob text "node ${pyaEsc(path.join(PYASH_ROOT, "command/disk_housekeeping.mjs"))} --pre-download --required-bytes 0 --mount '${pyaEsc(transcriptDir)}'" be command do`,
      );
      lines.push(
        `be download ob wo all during month 1 from filename "${pyaEsc(preferred)}" as wo audio to filename "${pyaEsc(transcriptDir)}" do`,
      );
    }
  } else {
    lines.push(
      `ob text "No video link yet for this meeting. Audio download skipped." to filename "${pyaEsc(path.join(transcriptDir, "note.txt"))}" be write do`,
    );
  }

  lines.push("");
  const prompt = `Editorial local-news illustration for ${payload.meeting_name || "meeting"} at ${payload.formatted_start || row.since}, Owen Sound City Hall, civic atmosphere, clean composition, no text.`;
  lines.push(
    `ob text "${pyaEsc(prompt)}" to filename "${pyaEsc(path.join(reportDir, "image-prompt.txt"))}" be write do`,
  );
  lines.push(
    `ob text "${pyaEsc(prompt)}" fromstate wo text become wo photograph to filename "${pyaEsc(path.join(reportDir, "image.png"))}" be draw do`,
  );

  lines.push("");
  const brief = [
    `Meeting: ${payload.meeting_name || ""}`,
    `When: ${row.since} to ${row.until}`,
    `Meeting URL: ${payload.meeting_url || ""}`,
    `Agenda cover links: ${(payload.agenda_cover || []).length}`,
    `Agenda links: ${(payload.agenda || []).length}`,
    `Minutes links: ${(payload.minutes || []).length}`,
    `Video links: ${(payload.video || []).length}`,
  ].join("\\n");
  lines.push(
    `ob text "${pyaEsc(brief)}" to filename "${pyaEsc(path.join(reportDir, "brief.md"))}" be write do`,
  );
  lines.push(
    `ob text "ready" to filename "${pyaEsc(path.join(meetingDir, "status.txt"))}" be write do`,
  );

  lines.push("");
  lines.push(`ob text "meeting pipeline complete" be write do`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { day, monthFile, meetings } = loadTodayMeetings();
  fs.mkdirSync(MEETINGS_DIR, { recursive: true });

  const created = [];
  for (const row of meetings) {
    const payload = { ...(row.payload ?? {}) };
    const videoResolved = await resolveMeetingVideoUrls(payload.video || []);
    payload.video = videoResolved.all;
    payload.video_direct = videoResolved.direct;
    payload.video_player = videoResolved.player;
    payload.video_resolved_at_utc = new Date().toISOString();
    const id = String(payload.meeting_id || "unknown-id");
    const folder = `${day}_${slugify(payload.meeting_name)}_${id.slice(0, 8)}`;
    const meetingDir = path.join(MEETINGS_DIR, folder);
    fs.mkdirSync(meetingDir, { recursive: true });
    fs.mkdirSync(path.join(meetingDir, "source"), { recursive: true });
    fs.mkdirSync(path.join(meetingDir, "converted"), { recursive: true });
    fs.mkdirSync(path.join(meetingDir, "report"), { recursive: true });
    fs.mkdirSync(path.join(meetingDir, "transcript"), { recursive: true });

    fs.writeFileSync(
      path.join(meetingDir, "meeting.json"),
      `${JSON.stringify(
        {
          su_name: row.suName,
          since: row.since,
          until: row.until,
          payload,
          generated_at_utc: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const pyaPipeline = buildPipeline(meetingDir, row);
    const pipelinePath = path.join(meetingDir, "run-meeting-pipeline.pya");
    fs.writeFileSync(pipelinePath, pyaPipeline, "utf8");

    created.push({
      meeting_id: payload.meeting_id,
      meeting_name: payload.meeting_name,
      folder,
      pipeline: pipelinePath,
    });
  }

  const summaryPath = path.join(MEETINGS_DIR, `${day}.today.json`);
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        day,
        month_file: monthFile,
        meeting_count: meetings.length,
        meetings: created,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.stdout.write(`prepared ${created.length} meeting workspaces for ${day} at ${MEETINGS_DIR}\n`);
}

export { buildPipeline };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
