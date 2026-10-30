#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const BASE_URL = "https://pub-owensound.escribemeetings.com/";
const CALENDAR_ENDPOINT =
  "https://pub-owensound.escribemeetings.com/MeetingsCalendarView.aspx/GetCalendarMeetings";

function normalizeUrl(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  if (/^https?:\/\//iu.test(text)) return text;
  if (text.startsWith("./")) return `${BASE_URL}${text.slice(2)}`;
  return `${BASE_URL}${text.replace(/^\/+/, "")}`;
}

function decodeHtmlEntities(text = "") {
  return String(text)
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function maybeDecodeUriComponent(text = "") {
  try {
    return decodeURIComponent(String(text));
  } catch {
    return String(text);
  }
}

function uniqueUrls(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const normalized = normalizeUrl(item);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function isEscribePlayerUrl(urlText = "") {
  if (!urlText) return false;
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    return false;
  }
  const host = String(parsed.hostname || "").toLowerCase();
  const pathname = String(parsed.pathname || "").toLowerCase();
  return host.endsWith("escribemeetings.com") && pathname.includes("/players/isistandaloneplayer.aspx");
}

export async function resolveEscribePlayerMediaUrl(urlText = "") {
  const playerUrl = normalizeUrl(urlText);
  if (!isEscribePlayerUrl(playerUrl)) return "";
  let html = "";
  try {
    html = String(
      execFileSync("curl", ["-sS", playerUrl], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }),
    );
  } catch {
    return "";
  }
  if (!html) return "";

  const directUrlMatch = html.match(/https:\/\/video\.isilive\.ca\/[^"'<> \t\r\n]+/iu);
  if (directUrlMatch) return decodeHtmlEntities(directUrlMatch[0]);

  const clientMatch = html.match(/data-client_id=(["'])(.*?)\1/iu);
  const fileMatch = html.match(/data-file_name=(["'])(.*?)\1/iu);
  if (!clientMatch || !fileMatch) return "";
  const clientIdRaw = decodeHtmlEntities(clientMatch[2]).trim();
  const fileNameRaw = decodeHtmlEntities(fileMatch[2]).trim();
  if (!clientIdRaw || !fileNameRaw) return "";
  const clientId = encodeURIComponent(maybeDecodeUriComponent(clientIdRaw));
  const fileName = encodeURIComponent(maybeDecodeUriComponent(fileNameRaw));
  return `https://video.isilive.ca/${clientId}/${fileName}`;
}

export async function resolveMeetingVideoUrls(urls = []) {
  const input = uniqueUrls(urls);
  const player = [];
  const direct = [];
  const passthrough = [];

  for (const raw of input) {
    if (isEscribePlayerUrl(raw)) {
      player.push(raw);
      const resolved = await resolveEscribePlayerMediaUrl(raw).catch(() => "");
      if (resolved) direct.push(resolved);
      continue;
    }
    passthrough.push(raw);
  }

  return {
    all: uniqueUrls([...direct, ...passthrough, ...player]),
    direct: uniqueUrls(direct),
    player: uniqueUrls(player),
  };
}

export function classifyMeetingVideoUrls(docLinks = []) {
  const out = [];
  for (const doc of Array.isArray(docLinks) ? docLinks : []) {
    const title = String(doc?.Title || "").toLowerCase();
    const type = String(doc?.Type || "").toLowerCase();
    if (
      type.includes("video") ||
      title.includes("video") ||
      doc?.HasVideo === true ||
      doc?.HasLiveVideo === true
    ) {
      const url = normalizeUrl(String(doc?.Url || ""));
      if (url) out.push(url);
    }
  }
  return uniqueUrls(out);
}

export async function fetchMeetingRecordById(meetingId, rangeStart, rangeEnd) {
  const idText = String(meetingId || "").trim();
  if (!idText) return null;
  const body = JSON.stringify({
    calendarStartDate: String(rangeStart || "").trim(),
    calendarEndDate: String(rangeEnd || "").trim(),
  });
  let raw = "";
  try {
    raw = String(
      execFileSync(
        "curl",
        [
          "-sS",
          CALENDAR_ENDPOINT,
          "-H",
          "Content-Type: application/json; charset=UTF-8",
          "--data-raw",
          body,
        ],
        {
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        },
      ),
    );
  } catch {
    return null;
  }
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed?.d) ? parsed.d : [];
  return rows.find((row) => String(row?.ID || "").trim() === idText) || null;
}
