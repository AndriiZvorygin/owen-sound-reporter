#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ENDPOINT =
  "https://pub-owensound.escribemeetings.com/MeetingsCalendarView.aspx/GetCalendarMeetings";
const BASE_URL = "https://pub-owensound.escribemeetings.com/";
const RANGE_START = "2020-01-01";
const RANGE_END = "2030-12-31";
const OUT_DIR =
  "/home/htaf/pyac/pyash/world/house/owen-sound-reporter/artifacts/owen-sound/monthly";

function normalizeUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("./")) return `${BASE_URL}${url.slice(2)}`;
  return `${BASE_URL}${url}`;
}

function parseLocalIso(input) {
  if (typeof input !== "string" || input.trim() === "") return "";
  const m = input.match(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  }
  return input.replace(/\//g, "-").replace(" ", "T");
}

function toMonthKey(isoLocal) {
  if (!isoLocal || isoLocal.length < 7) return "unknown-month";
  return isoLocal.slice(0, 7);
}

function escapePyashText(text) {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toSuName(meetingName, sinceIsoLocal) {
  const words = String(meetingName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  const timeTokens = String(sinceIsoLocal || "")
    .slice(0, 16)
    .replace(/[T:\-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const all = [...words, ...timeTokens];
  return all.length > 0 ? all.join(" ") : "event";
}

function categorizeDocs(docs) {
  const agendaCover = [];
  const agenda = [];
  const minutes = [];
  const video = [];

  for (const doc of docs) {
    const title = String(doc?.Title ?? "");
    const type = String(doc?.Type ?? "");
    const format = String(doc?.Format ?? "");
    const link = normalizeUrl(String(doc?.Url ?? ""));
    if (!link) continue;

    const item = { title, type, format, url: link };
    const lowerTitle = title.toLowerCase();
    const lowerType = type.toLowerCase();

    if (lowerType.includes("agendacover") || lowerTitle.includes("agenda cover")) {
      agendaCover.push(item);
      continue;
    }
    if (lowerType.includes("postminutes") || lowerTitle.includes("minutes")) {
      minutes.push(item);
      continue;
    }
    if (
      lowerType.includes("video") ||
      lowerTitle.includes("video") ||
      doc?.HasVideo === true ||
      doc?.HasLiveVideo === true
    ) {
      video.push(item);
      continue;
    }
    if (lowerType.includes("agenda")) {
      agenda.push(item);
    }
  }

  return {
    agenda_cover: agendaCover,
    agenda,
    minutes,
    video,
  };
}

function monthlySeriesName(monthKey) {
  return `owen sound council events ${monthKey.replace("-", " ")}`;
}

async function fetchMeetings() {
  const body = execFileSync(
    "curl",
    [
      "-sS",
      ENDPOINT,
      "-H",
      "Content-Type: application/json; charset=UTF-8",
      "--data-raw",
      JSON.stringify({
        calendarStartDate: RANGE_START,
        calendarEndDate: RANGE_END,
      }),
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(body);
  const meetings = Array.isArray(parsed?.d) ? parsed.d : [];
  return meetings;
}

function buildMonthlyRows(meetings) {
  const byMonth = new Map();

  for (const meeting of meetings) {
    const since = parseLocalIso(meeting?.StartDate);
    const until = parseLocalIso(meeting?.EndDate) || since;
    const monthKey = toMonthKey(since);
    const meetingUrl =
      normalizeUrl(String(meeting?.Url ?? "")) ||
      `${BASE_URL}MeetingsCalendarView.aspx/Meeting?Id=${String(meeting?.ID ?? "").trim()}`;
    const docs = Array.isArray(meeting?.MeetingDocumentLink) ? meeting.MeetingDocumentLink : [];
    const categorized = categorizeDocs(docs);

    const payload = {
      meeting_id: String(meeting?.ID ?? ""),
      meeting_name: String(meeting?.MeetingName ?? ""),
      meeting_type: String(meeting?.MeetingType ?? ""),
      meeting_url: meetingUrl,
      formatted_start: String(meeting?.FormattedStart ?? ""),
      start_local: since,
      end_local: until,
      agenda_cover: categorized.agenda_cover.map((x) => x.url),
      agenda: categorized.agenda.map((x) => x.url),
      minutes: categorized.minutes.map((x) => x.url),
      video: categorized.video.map((x) => x.url),
    };

    const row = {
      suName: toSuName(payload.meeting_name, since),
      since,
      until,
      obText: JSON.stringify(payload),
    };

    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(row);
  }

  for (const rows of byMonth.values()) {
    rows.sort((a, b) => {
      if (a.since !== b.since) return a.since.localeCompare(b.since);
      if (a.until !== b.until) return a.until.localeCompare(b.until);
      return a.suName.localeCompare(b.suName);
    });
  }

  return byMonth;
}

function renderSeries(monthKey, rows) {
  const lines = [`su name ${monthlySeriesName(monthKey)} be series def`];
  for (const row of rows) {
    lines.push(
      `su name ${row.suName} since date ${row.since} until date ${row.until} ob text "${escapePyashText(row.obText)}" ya`,
    );
  }
  lines.push("prah");
  lines.push("");
  return lines.join("\n");
}

function ensureCleanMonthFiles(outDir, targetFiles) {
  if (!fs.existsSync(outDir)) return;
  const existing = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith(".series.pya"))
    .map((f) => path.join(outDir, f));
  const targetSet = new Set(targetFiles);
  for (const file of existing) {
    if (!targetSet.has(file)) fs.unlinkSync(file);
  }
}

async function main() {
  const meetings = await fetchMeetings();
  const byMonth = buildMonthlyRows(meetings);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const monthKeys = [...byMonth.keys()].sort();
  const filesToWrite = monthKeys.map((monthKey) =>
    path.join(OUT_DIR, `${monthKey}.events.series.pya`),
  );
  ensureCleanMonthFiles(OUT_DIR, filesToWrite);

  for (const monthKey of monthKeys) {
    const rows = byMonth.get(monthKey) ?? [];
    const filePath = path.join(OUT_DIR, `${monthKey}.events.series.pya`);
    const text = renderSeries(monthKey, rows);
    fs.writeFileSync(filePath, text, "utf8");
  }

  const summary = {
    fetched_at_utc: new Date().toISOString(),
    source: ENDPOINT,
    calendar_start: RANGE_START,
    calendar_end: RANGE_END,
    meeting_count: meetings.length,
    month_count: monthKeys.length,
    output_dir: OUT_DIR,
    files: monthKeys.map((m) => `${m}.events.series.pya`),
  };
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), `${JSON.stringify(summary, null, 2)}\n`);

  process.stdout.write(
    `wrote ${meetings.length} events into ${monthKeys.length} month files at ${OUT_DIR}\n`,
  );
}

await main();
