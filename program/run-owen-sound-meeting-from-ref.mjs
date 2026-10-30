#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPublishEnvNormalization } from '../../../../program/publisher-interface.mjs';
import { readPyaTextValues } from '../../../../command/pya_lookup.mjs';
import { OWEN_ADAPTER } from './writer-adapter-owen-sound.mjs';
import { resolveMeetingVideoUrls } from './escribe-video-links.mjs';
import { DEFAULT_SUMMARY_FOCUS } from './defaults.mjs';
import {
  pickRichestAgendaMarkdownPathFromConvertedDir,
  pickRichestAgendaPdfPathFromSourceDir,
  pickRichestAgendaPrunedMarkdownPathFromConvertedDir,
} from '../../../../program/library/agenda_preview_shared.mjs';
import { writePyaMapArtifact } from '../../../../program/library/reporter_shared/agenda-stage-contracts.mjs';
import { assertAgendaPublishable } from './shared/agenda-publish-gate.mjs';
import { assertNumericFidelity, hasNumericFidelity } from './shared/numeric-fidelity.mjs';
import { normalizeCanadianEnglish } from '../../../../program/library/reporter_shared/canadian-english.mjs';
import { sanitizeBasePrefix } from '../../../../program/library/reporter_shared/prefix-normalization.mjs';
import { renderAgendaPreviewToc } from '../../../../program/library/reporter_shared/agenda-preview-toc.mjs';
import { agendaPreviewPriorityAdjustment } from '../../../../program/library/reporter_shared/agenda-preview-priority.mjs';
import { buildAgendaPreviewChunkSpans } from '../../../../program/library/reporter_shared/agenda-preview-source-chunks.mjs';
import {
  hasAgendaPreviewArtifactsCheckpoint,
  hasWholeAgendaSummaryCheckpoint,
} from '../../../../program/library/reporter_shared/agenda-preview-checkpoint.mjs';
import { requestManagedOllamaChat } from '../../../../program/runtime/gpu/managed-ollama.mjs';
import { canonicalMeetingRouteSlug } from '../../../../program/library/reporter_shared/meeting-route.mjs';

const PYASH_ROOT = '/home/htaf/pyac/pyash';
const HOUSE_ROOT = '/home/htaf/pyac/pyash/world/house/owen-sound-reporter';
const MONTHLY_DIR = path.join(HOUSE_ROOT, 'artifacts/owen-sound/monthly');
const MEETINGS_DIR = path.join(HOUSE_ROOT, 'artifacts/owen-sound/meetings');
const RUN_BIN = path.join(PYASH_ROOT, 'run');
const SECRET_PATHS = [
  path.join(HOUSE_ROOT, 'configure/secret.pya'),
  path.join(PYASH_ROOT, 'configure/secret.pya'),
  '/home/htaf/pyash/configure/secret.pya',
];
const SECRET_PATH = SECRET_PATHS.find((p) => fs.existsSync(p)) || SECRET_PATHS[0];
const SECRET_VALUES = readPyaTextValues(SECRET_PATH, [
  'ollama host',
  'ai host',
  'relay local host',
  'host',
  'draw host',
  'hear qwen host',
  'hear host',
  'speaker host',
  'speaker host root',
]);

const DEFAULT_BASE_PREFIX = 'meeting-qwen-auto';
const DEFAULT_FOCUS = DEFAULT_SUMMARY_FOCUS;
const DEFAULT_JURISDICTION = 'Owen Sound';
const DEFAULT_BODY = 'auto';
const DEFAULT_SITE = 'https://helpos.ca';
const AGENDA_PREVIEW_LLM_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(String(process.env.AGENDA_PREVIEW_LLM_TIMEOUT_MS || '300000'), 10) || 300000,
);
const AGENDA_PREVIEW_ONE_SENTENCE_ATTEMPTS = Math.max(
  0,
  Number.parseInt(String(process.env.AGENDA_PREVIEW_ONE_SENTENCE_ATTEMPTS || '3'), 10) || 3,
);
const AGENDA_PREVIEW_ONE_SENTENCE_VERIFY_ATTEMPTS = Math.max(
  1,
  Number.parseInt(String(process.env.AGENDA_PREVIEW_ONE_SENTENCE_VERIFY_ATTEMPTS || '3'), 10) || 3,
);
const AGENDA_ONE_SENTENCE_MIN_WORDS = 18;
const AGENDA_ONE_SENTENCE_MAX_WORDS = 32;
const AGENDA_SUBREPORT_SUMMARY_TIMEOUT_MS = Math.max(
  10000,
  Number.parseInt(String(process.env.AGENDA_SUBREPORT_SUMMARY_TIMEOUT_MS || '120000'), 10) || 120000,
);
const AGENDA_SUBREPORT_SUMMARY_LIMIT = Math.max(
  0,
  Number.parseInt(String(process.env.AGENDA_SUBREPORT_SUMMARY_LIMIT || '12'), 10) || 12,
);
const AGENDA_PREVIEW_SUBSECTION_LIMIT = Math.max(
  0,
  Number.parseInt(String(process.env.AGENDA_PREVIEW_SUBSECTION_LIMIT || '3'), 10) || 3,
);
const AGENDA_WHOLE_SUMMARY_BASE_TIMEOUT_MS = 45 * 60 * 1000;
const AGENDA_WHOLE_SUMMARY_TIMEOUT_SLOPE = 1;

function scaleTimeout(baseMs, durationSeconds, slopePerHour = 0.8) {
  const hours = Math.max(0, Number(durationSeconds) || 0) / 3600;
  return Math.round(baseMs * Math.max(1, 1 + (hours * slopePerHour)));
}

function ffprobeDurationSeconds(audioPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(audioPath)) return resolve(0);
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk ?? ''); });
    child.on('error', () => resolve(0));
    child.on('close', () => {
      const seconds = Number(String(out || '').trim());
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    });
  });
}

function estimateAgendaWholeSummaryWorkSeconds({ audioSeconds = 0, sectionCount = 0 } = {}) {
  // Upcoming previews have no recording to measure. Their complete chronology
  // still drives the same chunk reviews, coverage adjudication, and repairs,
  // so use a bounded per-section estimate when audio length is unavailable.
  const chronologySeconds = Math.max(0, Number(sectionCount) || 0) * 120;
  return Math.max(0, Number(audioSeconds) || 0, chronologySeconds);
}

async function managedChat({ ollamaBase, messages, options = {}, timeoutMs = AGENDA_PREVIEW_LLM_TIMEOUT_MS, format = '' }) {
  return requestManagedOllamaChat({
    ollamaUrl: ollamaBase,
    managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || '',
    messages,
    options,
    format,
    think: false,
    keepAlive: 300,
    timeoutMs,
  });
}

function resolveOllamaHost() {
  const fromEnv = String(process.env.OLLAMA_HOST || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/u, '');
  return String(
    SECRET_VALUES['ollama host']
    || SECRET_VALUES['ai host']
    || SECRET_VALUES['relay local host']
    || SECRET_VALUES.host
    || ''
  ).trim().replace(/\/$/u, '');
}

const RESOLVED_OLLAMA_HOST = resolveOllamaHost();
if (!process.env.OLLAMA_HOST && RESOLVED_OLLAMA_HOST) {
  process.env.OLLAMA_HOST = RESOLVED_OLLAMA_HOST;
}

function toComfyHostFromOllama(hostText) {
  const txt = String(hostText || '').trim();
  if (!txt) return '';
  return txt.replace(/:11434(?=\/?$)/u, ':8188').replace(/\/$/u, '');
}

function resolveHearQwenHost() {
  const fromEnv = String(process.env.PYA_HEAR_QWEN_HOST || process.env.PYA_DRAW_HOST || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/u, '');
  const fromSecret = String(
    SECRET_VALUES['hear qwen host'] || SECRET_VALUES['draw host'] || SECRET_VALUES['hear host'] || '',
  ).trim();
  if (fromSecret) return fromSecret.replace(/\/$/u, '');
  return toComfyHostFromOllama(RESOLVED_OLLAMA_HOST || process.env.OLLAMA_HOST || '');
}

const RESOLVED_HEAR_QWEN_HOST = resolveHearQwenHost();
if (!process.env.PYA_HEAR_QWEN_HOST && RESOLVED_HEAR_QWEN_HOST) {
  process.env.PYA_HEAR_QWEN_HOST = RESOLVED_HEAR_QWEN_HOST;
}
if (!process.env.PYA_DRAW_HOST && RESOLVED_HEAR_QWEN_HOST) {
  process.env.PYA_DRAW_HOST = RESOLVED_HEAR_QWEN_HOST;
}

function resolveSpeakerHost() {
  const fromEnv = String(process.env.PYA_SPEAKER_HOST || process.env.SPEAKER_HOST || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/u, '');
  return String(SECRET_VALUES['speaker host'] || '').trim().replace(/\/$/u, '');
}

function resolveSpeakerHostRoot() {
  const fromEnv = String(process.env.PYA_SPEAKER_HOST_ROOT || '').trim();
  if (fromEnv) return fromEnv;
  return String(SECRET_VALUES['speaker host root'] || '/workplace').trim() || '/workplace';
}

const RESOLVED_SPEAKER_HOST = resolveSpeakerHost();
const RESOLVED_SPEAKER_HOST_ROOT = resolveSpeakerHostRoot();
if (!process.env.PYA_SPEAKER_HOST && RESOLVED_SPEAKER_HOST) {
  process.env.PYA_SPEAKER_HOST = RESOLVED_SPEAKER_HOST;
}
if (!process.env.PYA_SPEAKER_HOST_ROOT && RESOLVED_SPEAKER_HOST_ROOT) {
  process.env.PYA_SPEAKER_HOST_ROOT = RESOLVED_SPEAKER_HOST_ROOT;
}

function usage() {
  return [
    'Usage: node program/run-owen-sound-meeting-from-ref.mjs <meeting_ref> [base_prefix] [focus] [jurisdiction] [body] [site_url] [discussion_url]',
    'meeting_ref can be meeting URL, full UUID meeting id, or 8-char meeting id prefix.',
    'Example: node ... "https://pub-owensound.escribemeetings.com/MeetingsCalendarView.aspx/Meeting?Id=199e5d63-5f50-44c5-b48d-285e9558391a"',
  ].join('\n');
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'meeting';
}

function normalizeBodyLabel(label) {
  let out = String(label || '').trim().replace(/\s+/gu, ' ');
  // Collapse accidental duplicated prefixes from some meeting feeds.
  out = out.replace(/^((?:Council Meeting|Committee|Board))\s*-\s*\1\s*-\s*/iu, '$1 - ');
  out = out.replace(/^Committee\s*-\s*Committee of\s+/iu, 'Committee of ');
  out = out.replace(/^Board\s*-\s*Board of\s+/iu, 'Board of ');
  out = out.replace(/\s*-\s*/gu, ' - ');
  return out.trim();
}

function inferBodyFromPayload(payload = {}, fallback = 'Council') {
  const meetingName = String(payload?.meeting_name || '').trim();
  const meetingType = String(payload?.meeting_type || '').trim();
  const source = meetingType || meetingName;
  if (!source) return normalizeBodyLabel(fallback);
  const m = source.match(/^(Council Meeting\s*-\s*[^-].*|Committee\s*-\s*[^-].*|Board\s*-\s*[^-].*)/iu);
  if (m) return normalizeBodyLabel(m[1].trim());
  if (/operations/iu.test(source)) return normalizeBodyLabel('Committee - Operations');
  if (/community services/iu.test(source)) return normalizeBodyLabel('Committee - Community Services');
  if (/corporate services/iu.test(source)) return normalizeBodyLabel('Committee - Corporate Services');
  if (/committee of adjustment/iu.test(source)) return normalizeBodyLabel('Committee - Committee of Adjustment');
  if (/committee/iu.test(source)) return normalizeBodyLabel('Committee');
  if (/board/iu.test(source)) return normalizeBodyLabel('Board');
  if (/council/iu.test(source)) return normalizeBodyLabel('Council Meeting - Regular');
  return normalizeBodyLabel(fallback);
}

function parseSeriesLine(line) {
  const m = line.match(/^su name (.+?) since date (\S+) until date (\S+) ob text "(.+)" ya$/u);
  if (!m) return null;
  const [, suName, since, until, escapedJson] = m;
  let jsonText = '';
  let payload = null;
  try {
    jsonText = JSON.parse(`"${escapedJson}"`);
    payload = JSON.parse(jsonText);
  } catch {
    return null;
  }
  return { suName, since, until, payload };
}

function parseMeetingIdFromRef(ref) {
  const txt = String(ref || '').trim();
  if (!txt) return '';
  const idQuery = txt.match(/[?&]Id=([0-9a-fA-F-]{8,36})/u);
  if (idQuery) return idQuery[1].toLowerCase();
  const uuid = txt.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/u);
  if (uuid) return uuid[1].toLowerCase();
  const shortId = txt.match(/^([0-9a-fA-F]{8})$/u);
  if (shortId) return shortId[1].toLowerCase();
  return '';
}

function findMeetingByRef(allMeetings, ref) {
  const txt = String(ref || '').trim();
  const idHint = parseMeetingIdFromRef(txt);
  const normalizedRef = txt.toLowerCase();

  if (idHint && idHint.length === 36) {
    return allMeetings.find((m) => String(m?.payload?.meeting_id || '').toLowerCase() === idHint) || null;
  }

  if (idHint && idHint.length === 8) {
    return allMeetings.find((m) => String(m?.payload?.meeting_id || '').toLowerCase().startsWith(idHint)) || null;
  }

  if (normalizedRef.startsWith('http://') || normalizedRef.startsWith('https://')) {
    return allMeetings.find((m) => String(m?.payload?.meeting_url || '').toLowerCase() === normalizedRef) || null;
  }

  return null;
}

function extFromUrl(url, fallback = '.bin') {
  const clean = String(url || '').split('?')[0];
  if (/filestream\.ashx$/iu.test(clean)) return '.pdf';
  if (/meeting\.aspx$/iu.test(clean)) return '.html';
  if (/isistandaloneplayer\.aspx$/iu.test(clean)) return '.html';
  const base = path.basename(clean);
  const ext = path.extname(base);
  return ext || fallback;
}

function docName(prefix, i, url) {
  const n = String(i + 1).padStart(2, '0');
  const ext = extFromUrl(url, '.pdf');
  return `${prefix}-${n}${ext}`;
}

function markdownName(sourceName) {
  const ext = path.extname(sourceName);
  const stem = sourceName.slice(0, sourceName.length - ext.length);
  return `${stem}.md`;
}

function stripQuery(url) {
  return String(url || '').split('?')[0];
}

function extFromMediaUrl(url) {
  const clean = stripQuery(url).toLowerCase();
  const ext = path.extname(clean);
  return ext || '';
}

function isDirectAudioUrl(url) {
  const ext = extFromMediaUrl(url);
  return ext === '.opus' || ext === '.wav' || ext === '.mp3' || ext === '.m4a' || ext === '.aac' || ext === '.flac';
}

function isDirectVideoUrl(url) {
  const ext = extFromMediaUrl(url);
  return ext === '.mp4' || ext === '.webm' || ext === '.mkv' || ext === '.mov' || ext === '.m4v';
}

function pyaEsc(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeReadText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownSection(mdText, heading) {
  const lines = String(mdText || '').split(/\r?\n/u);
  const target = String(heading || '').trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/u);
    if (!m) continue;
    if (m[1].trim().toLowerCase() === target) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function markdownLeadSection(mdText) {
  const lines = String(mdText || '').split(/\r?\n/u);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#\s+Whole Meeting Summary\b/iu.test(String(lines[i] || '').trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = String(lines[i] || '');
    if (/^##\s+/u.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function parseDateInfoFromSince(sinceText) {
  const iso = String(sinceText || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) return { iso: '', long: 'Unknown date' };
  const dt = new Date(`${iso}T12:00:00Z`);
  return {
    iso,
    long: dt.toLocaleDateString('en-CA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }),
  };
}

function formatMeetingTimeText(payload, sinceText) {
  const formattedStart = String(payload?.formatted_start || '').trim();
  const fromFormatted = formattedStart.match(/@\s*([0-9]{1,2}:[0-9]{2}\s*[AP]M)\b/i);
  if (fromFormatted) return fromFormatted[1].replace(/\s+/gu, ' ').toUpperCase();
  const local = String(payload?.start_local || sinceText || '').trim();
  const m = local.match(/T(\d{2}):(\d{2})/u);
  if (!m) return '';
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return '';
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

function pickMeetingLocationText(payload) {
  const candidates = [
    payload?.location,
    payload?.meeting_location,
    payload?.meetingLocation,
    payload?.venue,
    payload?.meeting_venue,
    payload?.address,
    payload?.formatted_location,
    payload?.formattedLocation,
  ];
  for (const raw of candidates) {
    const text = String(raw || '').replace(/\s+/gu, ' ').trim();
    if (text) return text;
  }
  return '';
}

function buildScheduleContext({ dateInfo, meetingTime, meetingLocation }) {
  const parts = [];
  if (dateInfo?.long) parts.push(`date: ${dateInfo.long}`);
  if (meetingTime) parts.push(`time: ${meetingTime}`);
  if (meetingLocation) parts.push(`location: ${meetingLocation}`);
  return parts.join('; ');
}

function hasTranscriptAudio(transcriptDir) {
  if (!fs.existsSync(transcriptDir)) return false;
  const files = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
  return files.some((name) => /\.(opus|wav|mp3|m4a|aac|flac)$/iu.test(name));
}

async function runSubmitHook(command, payloadPath) {
  const escapedPayload = String(payloadPath).replace(/"/gu, '\\"');
  await runWithStreaming({
    cmd: 'bash',
    args: ['-lc', `${command} "${escapedPayload}"`],
    cwd: PYASH_ROOT,
    timeoutMs: 10 * 60 * 1000,
    label: 'submit-hook',
  });
}

function uniqueNonEmptyStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function compactText(value, maxLen = 420) {
  const oneLine = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!oneLine) return '';
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLen - 3)).trim()}...`;
}

function cleanSummaryForPost(value) {
  const lines = String(value || '')
    .split(/\r?\n/u)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((line) => !/\|\s*gender\s*:/iu.test(line))
    .filter((line) => !/\|\s*role\s*:/iu.test(line));
  return normalizeCanadianEnglish(lines.join(' ').replace(/\s+/gu, ' ').trim());
}

function renderInlineMarkdown(text) {
  const escaped = escapeHtml(String(text || ''));
  return escaped
    .replace(/\*\*(.+?)\*\*/gu, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/gu, '<em>$1</em>');
}

function markdownToHtmlBlock(markdownText) {
  const lines = String(markdownText || '').replace(/\r\n/gu, '\n').split('\n');
  const out = [];
  let inList = false;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${renderInlineMarkdown(para.join(' '))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (!inList) return;
    out.push('</ul>');
    inList = false;
  };

  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) {
      flushPara();
      closeList();
      continue;
    }
    const li = line.match(/^[-*]\s+(.+)$/u);
    if (li) {
      flushPara();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${renderInlineMarkdown(li[1])}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }

  flushPara();
  closeList();
  return out.join('\n');
}

function parseAgendaSummaryMarkdownSections(mdText = '') {
  const src = String(mdText || '').replace(/\r\n/gu, '\n');
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '').trim();
    if (!line.startsWith('## ')) continue;
    const heading = line.replace(/^##\s+/u, '').trim();
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = String(lines[j] || '');
      if (next.trim().startsWith('## ')) break;
      body.push(next);
    }
    const chapterAt = body.findIndex((x) => String(x || '').trim() === 'Chapters');
    const summary = (chapterAt >= 0 ? body.slice(0, chapterAt) : body)
      .map((x) => x.trim()).filter(Boolean).join(' ')
      .replace(/\s+/gu, ' ')
      .trim();
    const chapters = chapterAt < 0 ? [] : body.slice(chapterAt + 1).reduce((rows, raw) => {
      const value = String(raw || '').trim();
      const match = value.match(/^- \[[^\]]+\]\s+(.+)$/u);
      if (match) rows.push({ title: match[1].trim(), summary: '' });
      else if (value && rows.length) rows.at(-1).summary = `${rows.at(-1).summary} ${value}`.trim();
      return rows;
    }, []);
    if (heading && summary) out.push({ heading, summary, chapters });
  }
  return out;
}

function dedupeMarkdownBulletLines(text = '') {
  const lines = String(text || '').split(/\r?\n/u);
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const line = String(raw || '');
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) {
      out.push(line);
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function parseAgendaHeadingStart(line = '') {
  let s = String(line || '')
    .replace(/\u00a0/gu, ' ')
    .replace(/\*\*/gu, '')
    .replace(/^#+\s*/u, '')
    .replace(/^[-*]\s+/u, '')
    .trim();
  if (!s) return null;
  // Handles:
  //  - "10."
  //  - "10. REPORTS ..."
  //  - "10.a Report ..."
  //  - "2 CALL FOR ..."
  const m = s.match(/^((?:\d+(?:\.[a-z])?)\.?)\s*(.*)$/iu);
  if (!m) return null;
  const rawCode = String(m[1] || '').trim();
  const code = rawCode.replace(/\.$/u, '');
  if (!code) return null;
  const numeric = Number(code.split('.')[0]);
  if (Number.isFinite(numeric) && numeric > 40) return null;
  const remainder = String(m[2] || '').trim();
  // If this is not dotted form, require heading-like remainder to reduce false positives.
  if (!/\.$/u.test(rawCode)) {
    if (!/^[A-Za-z][A-Za-z0-9"'()\-/,;&: ]*$/u.test(remainder)) return null;
    if (remainder.length < 3) return null;
  }
  return { code, remainder };
}

function parseAgendaOutlineItems(mdText = '') {
  const lines = String(mdText || '')
    .split(/\r?\n/u)
    .map((x) => x.trim());
  const isPageNumber = (s) => /^\d+$/u.test(String(s || '').trim()) || /^page\s+\d+\s+of\s+\d+$/iu.test(String(s || '').trim());
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseAgendaHeadingStart(lines[i]);
    if (!parsed) continue;
    const item = parsed.code;
    const sectionParts = [];
    if (parsed.remainder) sectionParts.push(parsed.remainder);
    for (let j = i + 1; j < lines.length; j += 1) {
      const s = lines[j];
      if (!s) continue;
      if (parseAgendaHeadingStart(s)) break;
      if (isPageNumber(s)) continue;
      sectionParts.push(s);
      if (sectionParts.join(' ').length > 6000) break;
    }
    // Defensive trim: if embedded later headings leaked in, stop at the first distinct heading.
    const clippedParts = [];
    const itemNorm = normalizeAgendaItemCode(item);
    for (const part of sectionParts) {
      const nested = parseAgendaHeadingStart(part);
      if (nested && normalizeAgendaItemCode(nested.code) !== itemNorm) break;
      clippedParts.push(part);
    }
    const title = normalizeAgendaTitle(sectionParts
      .slice(0, 4)
      .join(' ')
      // If extraction merged nested item labels into this heading, keep only the first heading phrase.
      .replace(/\s+(?:\d+(?:\.[a-z])?)\.?\s+[A-Z][^]*$/u, '')
      .replace(/\s+/gu, ' ')
      .trim());
    const embeddedCodes = title.match(/\b\d+(?:\.[a-z])?\b/giu) || [];
    if (embeddedCodes.length > 2) continue;
    if (!isUsableAgendaTitle(title)) continue;
    const excerpt = (clippedParts.length ? clippedParts : sectionParts).join('\n').trim();
    out.push({ item, title, excerpt });
  }
  return out;
}

function normalizeAgendaItemCode(code = '') {
  return String(code || '').trim().toLowerCase().replace(/\.$/u, '');
}

function extractAgendaItemCode(text = '') {
  const match = String(text || '').trim().match(/^([0-9]+(?:\.[a-z0-9]+)*|[a-z])\.?(?:\s|$)/iu);
  return normalizeAgendaItemCode(match?.[1] || '');
}

function parseAgendaItemOrderKey(code = '') {
  const c = normalizeAgendaItemCode(code);
  const m = c.match(/^(\d+)(?:\.([a-z]))?(?:\.(\d+))?$/iu);
  if (!m) return null;
  const major = Number(m[1]);
  if (!Number.isFinite(major)) return null;
  const minor = m[2] ? (m[2].toLowerCase().charCodeAt(0) - 96) : 0;
  const subminor = m[3] ? Number(m[3]) : 0;
  return { major, minor, subminor };
}

function compareAgendaItemCodes(a = '', b = '') {
  const ka = parseAgendaItemOrderKey(a);
  const kb = parseAgendaItemOrderKey(b);
  if (ka && kb) {
    if (ka.major !== kb.major) return ka.major - kb.major;
    if (ka.minor !== kb.minor) return ka.minor - kb.minor;
    return (ka.subminor || 0) - (kb.subminor || 0);
  }
  if (ka) return -1;
  if (kb) return 1;
  return String(a).localeCompare(String(b));
}

function normalizeAgendaTitle(value = '') {
  let out = String(value || '').trim();
  if (!out) return '';
  // Fix common OCR spacing splits like "C ALL", "M arch", "Di rector".
  out = out.replace(/\b([A-Za-z])\s+([A-Za-z]{2,})\b/gu, '$1$2');
  out = out.replace(/\b([A-Za-z]{2,})\s+([A-Za-z])\b/gu, '$1$2');
  // Remove duplicated leading agenda token if it leaked into title text.
  out = out.replace(/^(?:\d+(?:\.[a-z])?)\.?\s+/iu, '');
  // Trim accidental concatenation of subsequent agenda headings.
  out = out.replace(
    /\s+(?:DEPUTATIONS AND PRESENTATIONS|PUBLIC FORUM|CORRESPONDENCE RECEIVED FOR WHICH DIRECTION IS REQUIRED|REPORTS OF CITY STAFF|MATTERS POSTPONED|MOTIONS FOR WHICH NOTICE WAS PREVIOUSLY GIVEN|CORRESPONDENCE PROVIDED FOR INFORMATION|DISCUSSION OF ADDITIONAL BUSINESS|NOTICES OF MOTION|ADJOURNMENT)\b[\s\S]*$/u,
    '',
  );
  out = out.replace(/\s+/gu, ' ').trim();
  return out;
}

function isUsableAgendaTitle(value = '') {
  return /[A-Za-z]{3}/u.test(String(value || ''));
}

function isProceduralAgendaHeading(value = '') {
  const s = String(value || '').toLowerCase();
  if (!s) return false;
  return [
    'call for additional business',
    'declarations of interest',
    'confirmation of minutes',
    'deputations and presentations',
    'public forum',
    'correspondence received for which direction is required',
    'matters postponed',
    'motions for which notice was previously given',
    'correspondence provided for information',
    'discussion of additional business',
    'notices of motion',
    'adjournment',
    'no reports of city staff',
    'there are no reports of city staff',
    'report to follow',
  ].some((needle) => s.includes(needle));
}

function isSelectorExcludedProceduralHeading(value = '') {
  const s = String(value || '').toLowerCase();
  if (!s) return true;
  return [
    'call for additional business',
    'declarations of interest',
    'confirmation of the council minutes',
    'confirmation of minutes',
    'public meetings',
    'public forum',
    'correspondence received for which direction',
    'motions for which notice was previously given',
    'discussion of additional business',
    'notices of motion',
    'adjournment',
    'no reports of city staff',
    'there are no reports of city staff',
    'report to follow',
  ].some((needle) => s.includes(needle));
}

function isLikelyEmptyProceduralSummary(value = '') {
  const s = String(value || '').toLowerCase();
  if (!s) return true;
  return [
    'no substantive content',
    'there are no deputations',
    'no deputations',
    'no correspondence items',
    'there are no correspondence',
    'no additional business',
    'no declarations',
    'routine minutes',
    'adjournment',
    'no reports of city staff',
    'there are no reports of city staff',
    'report to follow',
    'no motions',
    'no public meetings',
    'no public forum',
    'not being presented for consideration',
    'agenda item listed in the published package',
    'section contains no substantive',
  ].some((needle) => s.includes(needle));
}
function isLikelyMinutesActionContamination(value = '') {
  const s = String(value || '').toLowerCase();
  if (!s) return false;
  const markers = [
    'minutes',
    'call to order',
    'election of chair',
    'election of vice chair',
    'nominated',
    'accepted the nomination',
    'acclaimed as chair',
    'opened the floor for nominations',
    'moved by',
    'seconded by',
    'carried',
    'defeated',
  ];
  let hits = 0;
  for (const marker of markers) if (s.includes(marker)) hits += 1;
  return hits >= 3;
}

function isOutlineAgendaSourcePath(filePath = '') {
  const p = String(filePath || '').replace(/\\/gu, '/').toLowerCase();
  return p.includes('/agenda-outline/');
}

function hasMeaningfulAgendaDetailText(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  const words = text.split(/\s+/u).filter(Boolean).length;
  if (words < 16) return false;
  if (isLikelyEmptyProceduralSummary(text)) return false;
  const low = text.toLowerCase();
  if (/^the agenda item\b/.test(low)) return false;
  if (/^the section\b/.test(low)) return false;
  if (/covers reports from city staff/.test(low)) return false;
  return true;
}

function isGenericAgendaHeadingForTopNews(value = '') {
  const s = normalizeAgendaTitle(String(value || '').toLowerCase());
  return [
    'reports of city staff',
    'deputations and presentations',
    'public forum',
    'discussion of additional business',
    'correspondence received for which direction is required',
    'correspondence provided for information',
  ].some((needle) => s === needle || s.startsWith(needle));
}

function isEmptyProceduralAgendaItem({ title = '', summary = '' } = {}) {
  const t = String(title || '').toLowerCase();
  const s = String(summary || '').toLowerCase();
  const combined = `${t} ${s}`;
  const emptySignals = [
    'there are no deputations',
    'no deputations',
    'there are no public meetings',
    'no public meetings',
    'there are no correspondence',
    'no correspondence',
    'no additional business',
    'no declarations',
    'routine minutes',
    'adjournment',
    'no reports of city staff',
    'there are no reports of city staff',
    'report to follow',
  ];
  return emptySignals.some((needle) => combined.includes(needle));
}

function toReaderFacingAgendaTitle(value = '') {
  let out = normalizeAgendaTitle(String(value || ''));
  out = out.replace(/^\s*[0-9]+(?:\.[a-z])?(?:\.[0-9]+)?\.?\s*/iu, '');
  out = out.replace(/^\s*[a-z]\s+/iu, '');
  out = out.replace(/^\s*report\s+[A-Z]{2}-\d{2}-\d{3}\s+from[^:]*:\s*/iu, '');
  out = out.replace(/\bfrom\s+the\s+[^:]{0,90}\s+re\s*:\s*/iu, '');
  out = out.replace(/\bre\s*:\s*/giu, '');
  out = out.replace(/\breport\s+[A-Z]{2}-\d{2}-\d{3}\b/giu, '');
  out = out.replace(/\bfrom\s+the\s+[^:]{0,120}$/iu, '');
  out = out.replace(/\baBy-law\b/giu, 'a By-law');
  out = out.replace(/\baVital\b/giu, 'a Vital');
  out = out.replace(/\bthere are no\s+deputations?(?:\s+or\s+presentations?)?\.?$/iu, '');
  out = out.replace(/\bthere are no\s+correspondence(?:\s+items?)?\.?$/iu, '');
  out = out.replace(/\s+re\.?$/iu, '');
  out = out.replace(/\s+/gu, ' ').trim();
  if (!out) return '';
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)$/iu.test(out)) {
    const src = normalizeAgendaTitle(String(value || ''));
    if (/\breport\b/iu.test(src)) return 'Tom Thomson Art Gallery ' + out + ' update report';
    return out + ' agenda update';
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function compactAgendaPreviewHookTitle(value = '') {
  const text = toReaderFacingAgendaTitle(value);
  const low = text.toLowerCase();
  if (/\bproperty standards by-law\b/u.test(low) && /\bvital services by-law\b/u.test(low)) {
    return 'Property Standards And Vital Services By-Law';
  }
  return text;
}

function extractAgendaContentWords(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4)
    .filter((w) => !new Set(['report', 'committee', 'agenda', 'policy', 'city', 'from', 'with', 'this', 'that', 'will', 'meeting']).has(w));
}

function hookMatchesSelectedItems(hook = '', selectedItems = []) {
  const hookText = toReaderFacingAgendaTitle(hook).toLowerCase();
  const hookWords = new Set(extractAgendaContentWords(hook));
  if (!hookWords.size) return false;
  const titles = (Array.isArray(selectedItems) ? selectedItems : [])
    .map((it) => toReaderFacingAgendaTitle(String(it?.title || '')))
    .filter((t) => isUsableAgendaNewsTitle(t));
  if (!titles.length) return true;
  for (const title of titles) {
    const compact = compactAgendaPreviewHookTitle(title).toLowerCase();
    const reader = toReaderFacingAgendaTitle(title).toLowerCase();
    if (hookText && (reader.includes(hookText) || compact.includes(hookText) || hookText.includes(compact))) return true;
  }
  if (titles.length <= 1) return true;
  const titleWords = new Set(titles.flatMap((t) => extractAgendaContentWords(t)));
  if (!titleWords.size) return true;
  let overlap = 0;
  for (const w of hookWords) if (titleWords.has(w)) overlap += 1;
  return overlap >= 1;
}

function isUsableAgendaNewsTitle(value = '') {
  const t = toReaderFacingAgendaTitle(value);
  if (!t) return false;
  const low = t.toLowerCase().trim();
  if (!low) return false;
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)$/u.test(low)) return false;
  if (/\b(re|from)\.?$/iu.test(t)) return false;
  if (/^presentation\s+from\s+the\s+committee\b/iu.test(t) && /\bre\.?$/iu.test(t)) return false;
  if (t.split(/\s+/u).length < 3) return false;
  return true;
}

function isReadableAgendaHook(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.split(/\s+/u).length < 3) return false;
  if (text.split(/\s+/u).length > 12) return false;
  if (/\bagenda preview\b/iu.test(text)) return false;
  if (isEmptyProceduralAgendaItem({ title: text, summary: '' })) return false;
  if (/^\s*[0-9]+(?:\.[a-z])?(?:\.[0-9]+)?/iu.test(text)) return false;
  if (/[;:]\s*$/u.test(text)) return false;
  if (/\b(re|from)\s*\.?$/iu.test(text)) return false;
  if (/\s{2,}/u.test(text)) return false;
  if (/(\b\w+\b)(?:\s+\w+){0,1}\s+\1(?:\b|$)/iu.test(text)) return false;
  return true;
}

function isValidAgendaOneSentence(value = '', {
  minWords = AGENDA_ONE_SENTENCE_MIN_WORDS,
  maxWords = AGENDA_ONE_SENTENCE_MAX_WORDS,
} = {}) {
  const text = String(value || '').trim();
  if (!text) return false;
  if ((text.match(/[.!?](?:\s|$)/gu) || []).length !== 1) return false;
  const words = text.split(/\s+/u).filter(Boolean).length;
  if (words < minWords) return false;
  if (words > maxWords) return false;
  if (isEmptyProceduralAgendaItem({ title: '', summary: text })) return false;
  if (/\b(re|from)\s*\.?$/iu.test(text)) return false;
  if (/\band\s+presentation\s+from\s+the\s+committee\b/iu.test(text)) return false;
  return true;
}

function normalizeGeneratedOneSentence(value = '') {
  const text = String(value || '')
    .split(/\r?\n/u)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return '';
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

export function oneSentenceMatchesSelectedItems(sentence = '', selectedItems = []) {
  const words = new Set(extractAgendaContentWords(sentence));
  if (!words.size) return false;
  const bannedLoaded = ['compassionate', 'dramatic', 'explosive', 'historic', 'shocking', 'controversial', 'rescue'];
  for (const b of bannedLoaded) if (String(sentence || '').toLowerCase().includes(b)) return false;
  const selected = (Array.isArray(selectedItems) ? selectedItems : [])
    .slice(0, 2)
    .map((it) => ({
      title: toReaderFacingAgendaTitle(String(it?.title || '')),
      summary: String(it?.active_summary || '').trim(),
    }))
    .filter((it) => it.title || it.summary);
  if (!selected.length) return true;

  const genericTopicWords = new Set([
    'agenda', 'and', 'city', 'committee', 'council', 'corporate', 'direction', 'for', 'from',
    'given', 'information', 'management', 'meeting', 'of', 'provided', 'report', 'reports',
    'required', 'review', 'services', 'staff', 'the', 'this', 'update', 'which',
  ]);
  const topicForms = (value) => {
    const forms = new Set();
    for (const raw of extractAgendaContentWords(value)) {
      const word = raw.toLowerCase();
      if (genericTopicWords.has(word)) continue;
      forms.add(word);
      if (word.endsWith('ies') && word.length > 4) forms.add(`${word.slice(0, -3)}y`);
      if (word.endsWith('s') && word.length > 4) forms.add(word.slice(0, -1));
    }
    return forms;
  };
  const sentenceForms = topicForms(sentence);
  return selected.every((item) => {
    const titleForms = topicForms(item.title);
    for (const word of titleForms) if (sentenceForms.has(word)) return true;
    // A title can use administrative wording while its generated summary
    // names the concrete civic topic readers need in the teaser.
    const summaryForms = topicForms(item.summary);
    let overlap = 0;
    for (const word of summaryForms) {
      if (sentenceForms.has(word)) overlap += 1;
      if (overlap >= 2) return true;
    }
    return false;
  });
}

export function selectedAgendaTopicPrompt(selectedItems = []) {
  const rows = (Array.isArray(selectedItems) ? selectedItems : [])
    .slice(0, 2)
    .map((it) => {
      const code = String(it?.item || '').trim();
      const title = toReaderFacingAgendaTitle(String(it?.title || '')).trim();
      return `${code ? `${code} ` : ''}${title}`.trim();
    })
    .filter(Boolean);
  return rows.length ? ['selected agenda topics (each must be represented):', ...rows.map((row) => `- ${row}`)].join('\n') : '';
}

function bodySubjectForAgendaSentence(body = '', meetingName = '') {
  const source = normalizeBodyLabel(String(body || meetingName || '').trim());
  if (!source || /^auto$/iu.test(source)) return 'The committee';
  if (/^council\b/iu.test(source)) return 'Council';
  if (/^committee\s*-\s*/iu.test(source)) {
    const label = source.replace(/^committee\s*-\s*/iu, '').trim();
    return label ? `The ${label} Committee` : 'The committee';
  }
  if (/^board\s*-\s*/iu.test(source)) {
    const label = source.replace(/^board\s*-\s*/iu, '').trim();
    return label ? `The ${label} Board` : 'The board';
  }
  return `The ${source}`;
}

function enforceAgendaSentenceBodySubject(sentence = '', body = '', meetingName = '') {
  const text = String(sentence || '').trim();
  if (!text) return '';
  const subject = bodySubjectForAgendaSentence(body, meetingName);
  if (/^Council\b/u.test(text) && !/^Council\b/u.test(subject)) {
    return text.replace(/^Council\b/u, subject);
  }
  return text;
}

function requiresAgendaDetailCoverage(item = {}) {
  const heading = normalizeAgendaTitle(String(item?.title || '')).toLowerCase();
  const summary = String(item?.active_summary || item?.agenda_section_summary || '').toLowerCase();
  const combined = `${heading} ${summary}`;

  if (!heading) return false;
  if (/\b(there are no deputations|there are no correspondence|there are no reports of city staff|no reports of city staff|no matters postponed|no motions)\b/u.test(combined)) return false;
  if (/\bmotion (?:to move council into committee of the whole|that committee of the whole rise and report|to adopt proceedings in committee of the whole)\b/u.test(heading)) return false;
  if (isSelectorExcludedProceduralHeading(heading) && isLikelyEmptyProceduralSummary(summary)) return false;

  if (Array.isArray(item?.attachments) && item.attachments.length > 0) return true;
  if (/\b[A-Z]{2}-\d{2}-\d{3}\b/u.test(String(item?.title || ''))) return true;
  if (/\breport\b/u.test(heading)) return true;
  if (/\breports of city staff\b/u.test(heading)) return true;
  if (/\bdeputations? and presentations?\b/u.test(heading) && !/there are no deputations?/u.test(combined)) return true;
  if (/\bcorrespondence received for which direction is required\b/u.test(heading) && !/there are no correspondence/u.test(combined)) return true;
  if (/\bby-?laws?\b/u.test(heading)) return true;
  return false;
}

function evaluateAgendaPreviewCoverage({ topItems = [], summaryItems = [], rawSubreportItems = [] }) {
  const rows = (Array.isArray(topItems) ? topItems : []).map((it) => {
    const heading = `${it?.item ? `${it.item} ` : ''}${String(it?.title || '').trim()}`.trim();
    const sourcePath = String(it?.file || '').trim();
    const outlineSource = isOutlineAgendaSourcePath(sourcePath);
    const sourceText = String(it?.source_text || '').trim();
    const activeSummary = String(it?.active_summary || it?.agenda_section_summary || it?.generated_summary || '').trim();
    const hasUsableSubreport = Boolean(it?.has_page_slice) && !!sourcePath && fs.existsSync(sourcePath) && !outlineSource && hasMeaningfulAgendaDetailText(sourceText) && !isLikelyMinutesActionContamination(sourceText);
    const hasGroundedDetail = !outlineSource && hasMeaningfulAgendaDetailText(sourceText) && hasMeaningfulAgendaDetailText(activeSummary) && !isLikelyMinutesActionContamination(sourceText);
    const requiresDetail = requiresAgendaDetailCoverage({ ...it, active_summary: activeSummary });
    let summarySource = 'none';
    if (hasUsableSubreport) summarySource = 'subreport';
    else if (hasGroundedDetail) summarySource = 'grounded';
    else if (outlineSource || activeSummary) summarySource = 'outline';
    const accepted = !requiresDetail || hasUsableSubreport || hasGroundedDetail;
    const reason = accepted
      ? (requiresDetail ? `detail_source_${summarySource}` : 'procedural_or_non_detail')
      : (requiresDetail && summarySource === 'outline' ? 'required_detail_missing_outline_only' : 'required_detail_missing');
    return {
      item: String(it?.item || ''),
      heading,
      requires_detail: requiresDetail,
      has_usable_subreport: hasUsableSubreport,
      has_grounded_detail: hasGroundedDetail,
      summary_source: summarySource,
      accepted,
      reason,
      source_path: sourcePath,
      outline_source: outlineSource,
    };
  });

  const selectedHeadingSet = new Set((summaryItems || []).map((it) => `${it?.item ? `${it.item} ` : ''}${String(it?.title || '').trim()}`.trim()));
  const selectedRows = rows.filter((r) => selectedHeadingSet.has(r.heading));
  const selectedMissingRequired = selectedRows.filter((r) => r.requires_detail && !r.accepted);
  const genericSelected = selectedRows.filter((r) => isGenericAgendaHeadingForTopNews(r.heading));
  const selectedNoDetail = selectedRows.filter((r) => r.requires_detail && r.summary_source === 'outline');

  const rawItems = Array.isArray(rawSubreportItems) ? rawSubreportItems : [];
  const rawCandidates = rawItems.filter((x) => {
    const t = normalizeAgendaTitle(String(x?.title || ''));
    return (Array.isArray(x?.attachments) && x.attachments.length > 0)
      || /\breport\b|\bdeputation\b|\bby-?law\b|\bcorrespondence received for which direction is required\b/iu.test(t);
  });
  // A retained page slice is one valid grounding path, but browser-retrieved
  // attachment text can be authoritative even when the source package has no
  // page slice. Count that candidate once its generated, non-empty grounded
  // summary has passed the same coverage checks above.
  const groundedCandidateKeys = new Set(rows
    .filter((row) => row?.has_grounded_detail && row?.accepted)
    .map((row) => normalizeAgendaItemCode(String(row?.item || '')))
    .filter(Boolean));
  const usableRaw = rawCandidates.filter((x) => (
    (Boolean(x?.has_page_slice) && String(x?.file || '').trim() && fs.existsSync(String(x.file)))
    || groundedCandidateKeys.has(normalizeAgendaItemCode(String(x?.item || '')))
  ));
  const allSubreportCandidatesUnusable = rawCandidates.length > 0 && usableRaw.length === 0;

  const failures = [];
  if (selectedMissingRequired.length) failures.push('selected_required_detail_missing');
  if (allSubreportCandidatesUnusable) failures.push('all_subreport_candidates_unusable');
  if (selectedNoDetail.length) failures.push('selected_required_items_outline_only');
  if (selectedRows.length && genericSelected.length === selectedRows.length) failures.push('top_news_generic_headings_only');

  return {
    rows,
    selected_rows: selectedRows,
    failures,
    pass: failures.length === 0,
    subreport_candidates_total: rawCandidates.length,
    subreport_candidates_usable: usableRaw.length,
    all_subreport_candidates_unusable: allSubreportCandidatesUnusable,
  };
}

function scoreAgendaPreviewNewsworthiness(item = {}) {
  const title = String(item?.title || '').trim();
  const summary = String(item?.active_summary || '').trim();
  const sourceText = String(item?.source_text || '').trim();
  const titleLc = title.toLowerCase();
  const summaryLc = summary.toLowerCase();
  let score = 0;

  if (isSelectorExcludedProceduralHeading(titleLc)) score -= 8;
  if (isLikelyEmptyProceduralSummary(summaryLc)) score -= 6;
  if (isLikelyMinutesActionContamination(`${titleLc}\n${summaryLc}\n${sourceText.toLowerCase()}`)) score -= 10;

  const structuralPenaltySignals = [
    ['minutes of the closed session', 6],
    ['minutes of the regular council meeting', 4],
    ['motion to move into closed session', 7],
    ['motion that committee of the whole rise and report formal session', 6],
    ['motion to adopt proceedings in committee of the whole', 6],
    ['reporting out of closed session', 6],
  ];
  for (const [needle, pts] of structuralPenaltySignals) {
    if (titleLc.includes(needle)) score -= pts;
  }

  const titleSignals = [
    ['report', 2],
    ['by-law', 3],
    ['bylaw', 3],
    ['agreement', 2],
    ['collective agreement', 3],
    ['budget', 4],
    ['tax', 4],
    ['fee', 3],
    ['funding', 3],
    ['deputation', 1],
    ['presentation', 1],
    ['policy', 3],
    ['plan', 2],
    ['licence', 2],
    ['license', 2],
    ['staff', 1],
  ];
  for (const [needle, pts] of titleSignals) {
    if (titleLc.includes(needle)) score += pts;
  }

  const summarySignals = [
    ['consider', 2],
    ['review', 2],
    ['discuss', 2],
    ['debate', 2],
    ['receive', 1],
    ['proposal', 2],
    ['recommend', 2],
    ['impact', 2],
    ['cost', 2],
    ['fund', 2],
    ['change', 1],
    ['amend', 2],
  ];
  for (const [needle, pts] of summarySignals) {
    if (summaryLc.includes(needle)) score += pts;
  }

  const publicImpactSignals = [
    ['food insecurity', 8],
    ['cannot afford', 6],
    ['struggle to afford', 6],
    ['children miss school', 7],
    ['social assistance', 5],
    ['living wage', 5],
    ['food deserts', 5],
    ['grocery prices', 4],
    ['households', 4],
    ['regional depot', 3],
    ['public health', 4],
    ['housing', 3],
  ];
  for (const [needle, pts] of publicImpactSignals) {
    if (summaryLc.includes(needle) || sourceText.toLowerCase().includes(needle)) score += pts;
  }

  const routineAdminPenaltySignals = [
    ['appointment of a by-law enforcement officer', 6],
    ['appointment', 2],
    ['administrative adjustment', 4],
    ['administrative update', 4],
    ['change in parties', 3],
    ['does not alter', 3],
    ['no impact on funding terms', 4],
    ['no climate impacts', 2],
  ];
  for (const [needle, pts] of routineAdminPenaltySignals) {
    if (titleLc.includes(needle) || summaryLc.includes(needle)) score -= pts;
  }

  const summaryWords = summary.split(/\s+/u).filter(Boolean).length;
  if (summaryWords >= 20) score += 1;
  if (summaryWords >= 45) score += 1;
  if (summaryWords >= 80) score += 1;

  if (/\$\s*\d|\b\d{3,}\b/u.test(summary) || /\$\s*\d|\b\d{3,}\b/u.test(sourceText)) score += 1;

  return score + agendaPreviewPriorityAdjustment({ title, summary, sourceText });
}

function hasUsableDetailChildItem(item = {}) {
  const code = normalizeAgendaItemCode(String(item?.item || ''));
  const order = parseAgendaItemOrderKey(code);
  if (!order || order.minor === 0) return false;
  const hasSlice = Boolean(item?.has_page_slice);
  const sourcePath = String(item?.file || '').trim();
  const sourceText = String(item?.source_text || '').trim();
  const title = String(item?.title || '');
  return hasSlice && !!sourcePath && fs.existsSync(sourcePath) && hasMeaningfulAgendaDetailText(sourceText) && !isSelectorExcludedProceduralHeading(title);
}

function isGenericParentSuppressedByUsableChildren(item = {}, byMajorChildDetail = new Map()) {
  const title = String(item?.title || '');
  if (!isGenericAgendaHeadingForTopNews(title)) return false;
  const code = normalizeAgendaItemCode(String(item?.item || ''));
  const order = parseAgendaItemOrderKey(code);
  if (!order || order.minor !== 0) return false;
  return Boolean(byMajorChildDetail.get(order.major));
}

function suppressStructuralParentsWithCoveredChildren(selected = [], candidates = []) {
  const selectedList = Array.isArray(selected) ? selected : [];
  const coveredMajors = new Set();
  for (const it of Array.isArray(candidates) ? candidates : []) {
    const code = normalizeAgendaItemCode(String(it?.item || ''));
    const order = parseAgendaItemOrderKey(code);
    if (!order || order.minor === 0) continue;
    if (Boolean(it?.has_page_slice) && hasMeaningfulAgendaDetailText(String(it?.active_summary || ''))) {
      coveredMajors.add(order.major);
    }
  }
  return selectedList.filter((it) => {
    const code = normalizeAgendaItemCode(String(it?.item || ''));
    const order = parseAgendaItemOrderKey(code);
    if (order && order.minor === 0 && coveredMajors.has(order.major) && isGenericAgendaHeadingForTopNews(String(it?.title || ''))) {
      return false;
    }
    return true;
  });
}


function isNonSubstantiveAgendaSummary(value = '') {
  const s = String(value || '').toLowerCase();
  if (!s) return true;
  return [
    'no specific actions',
    'no newsworthy events',
    'serves as a confirmation',
    'contains no further information',
    'no substantive actions',
    'report to follow',
    'no reports from city staff',
    'there are no reports of city staff',
    'there are no deputations',
    'there are no public meetings',
    'there are no correspondence',
  ].some((needle) => s.includes(needle));
}

function isAgendaTopNewsSubstantive(item = {}) {
  const title = String(item?.title || '').trim();
  const summary = String(item?.active_summary || '').trim();
  if (!title || !summary) return false;
  if (isEmptyProceduralAgendaItem({ title, summary })) return false;
  if (isNonSubstantiveAgendaSummary(summary)) return false;
  if (isLikelyEmptyProceduralSummary(summary)) return false;
  if (isLikelyMinutesActionContamination(`${String(item?.source_text || '')}
${summary}`)) return false;
  const words = summary.split(/\s+/u).filter(Boolean).length;
  return words >= 10;
}

function selectNewsworthyAgendaItems(items = [], { topN = 8, minScore = 3 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const byMajorChildDetail = new Map();
  for (const it of list) {
    if (!hasUsableDetailChildItem(it)) continue;
    const order = parseAgendaItemOrderKey(normalizeAgendaItemCode(String(it?.item || '')));
    if (!order) continue;
    byMajorChildDetail.set(order.major, true);
  }

  const scored = list
    .map((it) => {
      const score = scoreAgendaPreviewNewsworthiness(it);
      const excludedProcedural = isSelectorExcludedProceduralHeading(String(it?.title || ''))
        && isLikelyEmptyProceduralSummary(String(it?.active_summary || ''));
      const hasSubstance = String(it?.active_summary || '').trim().split(/\s+/u).filter(Boolean).length >= 8
        && !isLikelyEmptyProceduralSummary(String(it?.active_summary || ''))
        && !isEmptyProceduralAgendaItem({ title: it?.title, summary: it?.active_summary })
        && !isNonSubstantiveAgendaSummary(String(it?.active_summary || ''))
        && !isLikelyMinutesActionContamination(`${String(it?.source_text || '') }\n${String(it?.active_summary || '') }`);
      const suppressedGenericParent = isGenericParentSuppressedByUsableChildren(it, byMajorChildDetail);
      const selected = !excludedProcedural && !suppressedGenericParent && hasSubstance && isUsableAgendaNewsTitle(String(it?.title || '')) && score >= minScore;
      return {
        ...it,
        newsworthy_score: Number(score.toFixed(2)),
        newsworthy_selected: selected,
        newsworthy_excluded: excludedProcedural || !hasSubstance || suppressedGenericParent,
        newsworthy_reason: suppressedGenericParent
          ? 'suppressed_structural_parent_with_covered_children'
          : (excludedProcedural ? 'excluded_procedural' : (!hasSubstance ? 'excluded_low_substance' : 'eligible')),
      };
    })
    .sort((a, b) => b.newsworthy_score - a.newsworthy_score || compareAgendaItemCodes(String(a.item || ''), String(b.item || '')));

  let selected = scored.filter((it) => it.newsworthy_selected).slice(0, topN);

  if (!selected.length) {
    selected = scored
      .filter((it) => !it.newsworthy_excluded && isUsableAgendaNewsTitle(String(it?.title || '')))
      .slice(0, Math.min(topN, 6));
  }
  if (!selected.length) {
    selected = scored
      .filter((it) => !isSelectorExcludedProceduralHeading(String(it?.title || '')))
      .slice(0, Math.min(topN, 5));
  }

  return { selected, scored };
}

function titleTokens(value = '') {
  return new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, ' ')
      .split(/\s+/u)
      .map((x) => x.trim())
      .filter((x) => x.length >= 4),
  );
}

function titleOverlapCount(a = '', b = '') {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  let n = 0;
  for (const t of ta) {
    if (tb.has(t)) n += 1;
  }
  return n;
}

function extractReportCode(value = '') {
  const m = String(value || '').toUpperCase().match(/\b([A-Z]{2}-\d{2}-\d{3})\b/u);
  return m ? m[1] : '';
}

function isStrongAgendaTitleMatch(fallbackTitle = '', candidateTitle = '') {
  const a = normalizeAgendaTitle(fallbackTitle);
  const b = normalizeAgendaTitle(candidateTitle);
  if (!a || !b) return false;
  const codeA = extractReportCode(a);
  const codeB = extractReportCode(b);
  if (codeA && codeB && codeA === codeB) return true;
  const overlap = titleOverlapCount(a, b);
  if (overlap >= 2) return true;
  // Very short procedural labels should not be force-mapped by numeric key alone.
  if (a.length < 28 || b.length < 28) return false;
  return overlap >= 1;
}

function sanitizeAgendaSectionBody(item = {}, rawBody = '') {
  let text = String(rawBody || '').replace(/\r\n/gu, '\n');
  if (!text.trim()) return '';
  // Remove common page/OCR boilerplate.
  text = text
    .replace(/^\s*page\s+\d+\s+of\s+\d+\s*$/gimu, '')
    .replace(/^\s*\d+\s*$/gimu, '')
    .replace(/\f/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  const title = String(item?.title || '').trim();
  const tks = titleTokens(title);
  const paras = text.split(/\n{2,}/u).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return text;

  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < paras.length; i += 1) {
    const pt = titleTokens(paras[i]);
    let score = 0;
    for (const t of tks) {
      if (pt.has(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  let chosen = paras;
  if (bestScore >= 2 && bestIdx > 0) {
    chosen = paras.slice(bestIdx);
  }

  // If this is a major numbered item, clip content before the next major heading.
  const order = parseAgendaItemOrderKey(String(item?.item || '').trim());
  if (order && order.minor === 0) {
    const nextMajor = order.major + 1;
    const clipped = [];
    for (let i = 0; i < chosen.length; i += 1) {
      const p = chosen[i];
      if (i > 0 && new RegExp(`^${nextMajor}(?:\\.|\\s)`, 'iu').test(p)) break;
      clipped.push(p);
    }
    if (clipped.length) chosen = clipped;
  }

  return chosen.join('\n\n').trim();
}

function estimateSectionDurationSecondsFromText(text = '') {
  const words = String(text || '').trim().split(/\s+/u).filter(Boolean).length;
  if (!words) return 45;
  // Conservative spoken-word estimate for agenda preview grounding.
  return Math.max(45, Math.min(45 * 60, Math.round(words * 0.42)));
}

function normalizePreviewSourceForComparison(text = '') {
  return String(text || '').replace(/\s+/gu, ' ').trim();
}

function buildAgendaPreviewGroundingArtifact(items = []) {
  const groundedUnits = [];
  let rowCursor = 0;
  let timeCursor = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const agendaItem = String(item.item || '').trim().toLowerCase() || String(i + 1);
    const title = normalizeAgendaTitle(String(item.title || '').trim()) || `Agenda item ${agendaItem}`;
    const sourceText = sanitizeAgendaSectionBody(item, safeReadText(String(item.file || ''), '').trim());
    const excerpt = sourceText || `Agenda section ${agendaItem}: ${title}.`;
    const baseSourceRows = Math.max(
      1,
      excerpt
        .split(/\n{2,}/u)
        .map((x) => x.trim())
        .filter(Boolean).length,
    );
    const durationSeconds = estimateSectionDurationSecondsFromText(excerpt);
    const rowStart = rowCursor;
    const since = timeCursor;
    const until = since + durationSeconds;
    const chunkId = `preview_chunk_${String(i + 1).padStart(3, '0')}`;
    const sourceWordCount = excerpt.split(/\s+/u).filter(Boolean).length;
    const longSource = Boolean(item.long_source) || sourceWordCount >= 700;
    const stage3ChapterMaxChars = Math.max(
      2000,
      Number.parseInt(String(process.env.AGENDA_CHAPTER_MAX_SOURCE_CHARS || '8000'), 10) || 8000,
    );
    const chapterSpans = longSource
      ? buildAgendaPreviewChunkSpans(excerpt, {
        rowStart,
        sourceRows: baseSourceRows,
        since,
        durationSeconds,
        maxChars: stage3ChapterMaxChars,
        targetChars: Math.max(1800, stage3ChapterMaxChars - 400),
      })
      : [];
    if (chapterSpans.length > 0) {
      const rebuilt = chapterSpans.map((chapter) => chapter.text).join('\n\n');
      if (normalizePreviewSourceForComparison(rebuilt) !== normalizePreviewSourceForComparison(excerpt)) {
        throw new Error(`agenda preview source chunking lost grounded text for item ${agendaItem}`);
      }
    }
    const sourceRows = chapterSpans.length
      ? chapterSpans.at(-1).rowEnd - rowStart + 1
      : baseSourceRows;
    const rowEnd = rowStart + sourceRows - 1;
    const unitId = `ground_${String(i + 1).padStart(3, '0')}`;
    const childChapters = chapterSpans.map((chapter, chapterIndex) => {
      const chapterId = `${chunkId}_chapter_${String(chapterIndex + 1).padStart(2, '0')}`;
      return {
      'chapter id': chapterId,
      'parent unit id': unitId,
      'ordering index': chapterIndex + 1,
      'row start': chapter.rowStart,
      'row end': chapter.rowEnd,
      'source rows': chapter.sourceRows,
      since: chapter.since,
      until: chapter.until,
      'duration seconds': chapter.durationSeconds,
      'chunk ids': [chapterId],
      'trace row span': `${chapter.rowStart}..${chapter.rowEnd}`,
      'source excerpt': chapter.text,
      'source chars': chapter.text.length,
      };
    });

    groundedUnits.push({
      'unit id': unitId,
      'agenda item': agendaItem,
      'parent agenda item': agendaItem,
      label: `${agendaItem} ${title}`.trim(),
      'row start': rowStart,
      'row end': rowEnd,
      'source rows': sourceRows,
      since,
      until,
      'duration seconds': durationSeconds,
      'chunk ids': [chunkId],
      'chunk span': { first: chunkId, last: chunkId },
      'parent unit id': '',
      'split depth': 0,
      'grounding confidence': 0.82,
      'grounding status': 'grounded-preview',
      'source excerpt': excerpt,
      'source words': excerpt.split(/\s+/u).filter(Boolean).length,
      'trace chunk ids': [chunkId],
      'trace row span': `${rowStart}..${rowEnd}`,
      'trace signals': {
        'likely agenda items': [agendaItem],
        'signal flow': ['agenda-package'],
        'topic transition': ['none'],
      },
      'part index': 0,
      'part total': 1,
      'source kind': item.attachments?.length ? 'attachment-backed' : 'agenda-package',
      substantive: Boolean(item.substantive) || item.attachments?.length > 0 || sourceWordCount >= 80,
      'long source': longSource,
      procedural: Boolean(item.procedural),
      'child chapters': childChapters,
    });

    rowCursor = rowEnd + 1;
    timeCursor = until;
  }
  return {
    'schema version': 'agenda_section_grounding_v1',
    'generated time': new Date().toISOString(),
    'transcript rows total': Math.max(1, rowCursor),
    'grounded units': groundedUnits,
  };
}

function toAgendaWiseSeriesText(items = []) {
  const lines = ['su name wise chips be series def'];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const heading = `${String(it?.item || '').trim()} ${String(it?.title || '').trim()}`.trim();
    const rawBody = safeReadText(String(it?.file || ''), '').trim();
    const body = sanitizeAgendaSectionBody(it, rawBody);
    if (!heading || !body) continue;
    const chip = `[Agenda Start] ${heading} | method agenda-package\n${body}`;
    lines.push(`ob text quoted.text.${chip}.text.quoted from num ${i + 1} be text ya`);
  }
  lines.push('prah');
  return `${lines.join('\n')}\n`;
}

function buildAgendaFallbackOutlineItems({ meetingDir, agendaPath, transcriptDir, normPrefix }) {
  const convertedDir = path.join(meetingDir, 'converted');
  const prunedAgendaPath = pickRichestAgendaPrunedMarkdownPathFromConvertedDir(convertedDir);
  const outlineSourcePath = prunedAgendaPath || agendaPath;
  const mdText = safeReadText(outlineSourcePath, '').trim();
  if (!mdText) return [];
  const parsed = parseAgendaOutlineItems(mdText);
  if (!parsed.length) return [];
  const outDir = path.join(transcriptDir, `${normPrefix}.agenda-outline`);
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  let inClosedSessionSubclauses = false;
  for (let idx = 0; idx < parsed.length; idx += 1) {
    const it = parsed[idx];
    const code = normalizeAgendaItemCode(String(it.item || ''));
    const titleNorm = normalizeAgendaTitle(String(it.title || ''));
    const order = parseAgendaItemOrderKey(code);
    const headingText = `${code} ${titleNorm}`.toLowerCase();
    if (headingText.includes('move into closed session')) {
      inClosedSessionSubclauses = true;
    } else if (code === '20') {
      inClosedSessionSubclauses = false;
    }
    // Ignore numbered subclauses (1..9) embedded inside closed-session item 19.
    if (inClosedSessionSubclauses && order && order.minor === 0 && order.major >= 1 && order.major <= 9 && code !== '19') {
      continue;
    }
    const stem = slugify(`${code}-${titleNorm}`) || `agenda-item-${idx + 1}`;
    const file = path.join(outDir, `${stem}.txt`);
    let bodyText = String(it.excerpt || '').trim();
    if (bodyText) {
      bodyText = bodyText.slice(0, 12000).trim();
    }
    if (isProceduralAgendaHeading(titleNorm)) {
      const compact = bodyText
        .split(/\n+/u)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join('\n')
        .trim();
      bodyText = compact && compact.length <= 700 ? compact : '';
    }
    const body = `${code} ${titleNorm}\n\n${bodyText || 'Agenda item listed in the published package.'}\n`;
    // Always rewrite to keep reruns deterministic after parser fixes.
    fs.writeFileSync(file, body, 'utf8');
    out.push({
      item: code,
      title: titleNorm,
      file,
      has_page_slice: false,
    });
  }
  out.sort((a, b) => compareAgendaItemCodes(a.item, b.item));
  return out;
}

function parseFirstJsonObject(text) {
  const src = String(text || '');
  const start = src.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = src.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function splitTextIntoGrossChunks(text, { maxChars = 8000, minChars = 2200 } = {}) {
  const source = String(text || '').trim();
  if (!source) return [];
  const paras = source.split(/\n{2,}/u).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [source];
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    const next = cur ? `${cur}\n\n${p}` : p;
    if (next.length <= maxChars) {
      cur = next;
      continue;
    }
    if (cur && cur.length >= minChars) {
      chunks.push(cur);
      cur = p;
      continue;
    }
    const sentences = p.split(/(?<=[.!?])\s+/u).map((s) => s.trim()).filter(Boolean);
    for (const s of sentences) {
      const sentNext = cur ? `${cur} ${s}` : s;
      if (sentNext.length <= maxChars) cur = sentNext;
      else {
        if (cur) chunks.push(cur);
        cur = s;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim().length > 0);
}

function forceSplitLongTextInTwo(text) {
  const src = String(text || '').trim();
  if (!src) return [];
  const sentences = src.split(/(?<=[.!?])\s+/u).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 6) return [src];
  const totalWords = sentences.reduce((n, s) => n + s.split(/\s+/u).filter(Boolean).length, 0);
  const target = Math.max(1, Math.floor(totalWords / 2));
  let seen = 0;
  let cut = -1;
  for (let i = 0; i < sentences.length; i += 1) {
    seen += sentences[i].split(/\s+/u).filter(Boolean).length;
    if (seen >= target) {
      cut = i;
      break;
    }
  }
  if (cut <= 0 || cut >= sentences.length - 1) return [src];
  return [
    sentences.slice(0, cut + 1).join(' ').trim(),
    sentences.slice(cut + 1).join(' ').trim(),
  ].filter(Boolean);
}

function buildAgendaPreviewGroundedFocus(focus = '') {
  const userFocus = String(focus || '').trim();
  const constraints = [
    'upcoming agenda preview',
    'strictly grounded in source text',
    'no claims of decisions already made',
    'no sensational framing',
    'avoid inferred motives or causal claims unless explicit',
  ].join('; ');
  return userFocus ? `${userFocus}; ${constraints}` : constraints;
}

async function summarizeAgendaSubsectionChunkLlm({
  heading,
  chunkText,
  focus,
}) {
  const cleaned = String(chunkText || '').trim();
  if (!cleaned) return null;
  const ollamaBase = String(RESOLVED_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://mriczo:11434').replace(/\/+$/u, '');
  const prompt = [
    'Create one subsection for an upcoming civic agenda preview.',
    `Parent agenda heading: ${String(heading || '').trim() || '(unknown)'}`,
    `Focus: ${String(focus || '').trim() || 'newsworthy civic impacts'}`,
    'Return JSON only with keys: title, summary.',
    'Rules:',
    '- title: 5-12 words, specific, no trailing period.',
    '- summary: one sentence, 18-40 words, concrete, future/present tense.',
    '- use only facts from chunk text.',
    '',
    'Chunk text:',
    cleaned.slice(0, 14000),
  ].join('\n');

  try {
    const obj = await managedChat({
      ollamaBase,
      messages: [
        { role: 'system', content: 'You write concise subsection summaries for civic agenda previews.' },
        { role: 'user', content: prompt },
      ],
      options: { num_predict: 180 },
      format: 'json',
      timeoutMs: AGENDA_PREVIEW_LLM_TIMEOUT_MS,
    });
    const raw = String(obj?.message?.content || obj?.response || '').trim();
    const parsed = parseFirstJsonObject(raw) || {};
    const title = String(parsed?.title || '').replace(/\s+/gu, ' ').trim();
    const summary = String(parsed?.summary || '').replace(/\s+/gu, ' ').trim();
    if (!title || !summary) throw new Error('qwen returned incomplete subsection summary');
    return { title, summary };
  } catch (error) {
    throw new Error(`agenda subsection summary generation failed; job remains retryable: ${String(error?.message || error)}`);
  }
}

async function buildAgendaPreviewSubsections({
  topItems,
  focus,
}) {
  const out = new Map();
  if (AGENDA_PREVIEW_SUBSECTION_LIMIT <= 0) return out;
  for (const it of (Array.isArray(topItems) ? topItems : []).slice(0, AGENDA_PREVIEW_SUBSECTION_LIMIT)) {
    const key = String(it?.item || '').trim();
    const text = String(it?.source_text || '').trim();
    if (!key || !text) continue;
    const words = text.split(/\s+/u).filter(Boolean).length;
    if (words < 700) continue;
    let chunks = splitTextIntoGrossChunks(text, { maxChars: 8000, minChars: 2200 }).slice(0, 5);
    if (chunks.length <= 1) chunks = forceSplitLongTextInTwo(text).slice(0, 5);
    if (chunks.length <= 1) continue;
    const rows = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const sub = await summarizeAgendaSubsectionChunkLlm({
        heading: `${it.item ? `${it.item} ` : ''}${it.title}`.trim(),
        chunkText: chunks[i],
        focus,
      });
      if (!sub) continue;
      rows.push({
        index: i + 1,
        title: String(sub.title || '').trim(),
        summary: String(sub.summary || '').trim(),
      });
    }
    if (rows.length > 1) out.set(key, rows);
  }
  return out;
}

async function generateOneSentenceSummaryLlm({
  transcriptDir,
  normPrefix,
  focus,
  fullAgendaSummary,
  topNewsMarkdown,
  scheduleContext,
  selectedItems,
}) {
  const full = String(fullAgendaSummary || '').trim();
  const top = String(topNewsMarkdown || '').trim();
  const sourceText = [
    full ? `WHOLE AGENDA SUMMARY:\n${full}` : '',
    top ? `TOP NEWSWORTHY AGENDA ITEMS:\n${top}` : '',
  ].filter(Boolean).join('\n\n').trim();
  if (!sourceText) return '';
  const sourcePath = path.join(transcriptDir, `${normPrefix}.one-sentence-source.txt`);
  fs.writeFileSync(sourcePath, `${sourceText}\n`, 'utf8');
  const ollamaBase = String(RESOLVED_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://mriczo:11434').replace(/\/+$/u, '');
  const basePrompt = [
    'Write exactly one sentence for an upcoming civic agenda preview.',
    `Focus: ${String(focus || '').trim() || 'newsworthy civic decisions'}.`,
    `Constraints: ${AGENDA_ONE_SENTENCE_MIN_WORDS}-${AGENDA_ONE_SENTENCE_MAX_WORDS} words; present/future tense; concrete; no ellipses; no semicolons; no bullet/list format.`,
    scheduleContext ? `Include these meeting details when possible: ${scheduleContext}.` : 'If meeting date/time/location details are provided, include them naturally.',
    selectedAgendaTopicPrompt(selectedItems),
    'Represent each selected agenda topic in the sentence; use a specific topic phrase rather than only a generic committee or report label.',
    'Use distinct wording from the whole agenda summary.',
    'Preserve addresses and numeric facts exactly as numerals from the source; never spell multi-digit numbers digit-by-digit.',
    '',
    sourceText,
  ].join('\n');
  let rejectedCandidate = '';
  let rejectionReason = '';
  if (AGENDA_PREVIEW_ONE_SENTENCE_ATTEMPTS <= 0) return '';
  for (let attempt = 1; attempt <= AGENDA_PREVIEW_ONE_SENTENCE_ATTEMPTS; attempt += 1) {
    const retryFeedback = attempt === 1 ? '' : [
      'The prior response failed the complete downstream contract. Return a fresh sentence, not a lightly edited copy.',
      `REJECTION_REASON: ${rejectionReason || 'the prior response was malformed or empty'}`,
      `REJECTED_CANDIDATE: ${rejectedCandidate || '(empty)'}`,
      attempt % 2 === 0
        ? `Count every word and keep the new sentence between ${AGENDA_ONE_SENTENCE_MIN_WORDS} and ${AGENDA_ONE_SENTENCE_MAX_WORDS} words; use Arabic numerals for multi-digit facts.`
        : 'Start over with the smallest set of source-grounded topics and supporting details needed for a useful civic teaser; preserve numeric notation exactly.',
    ].join('\n');
    const prompt = [basePrompt, retryFeedback].filter(Boolean).join('\n\n');
    try {
      const json = await managedChat({
        ollamaBase,
        messages: [
          { role: 'system', content: 'You write concise civic agenda teasers.' },
          { role: 'user', content: prompt },
        ],
        options: { num_predict: 96 },
        timeoutMs: AGENDA_PREVIEW_LLM_TIMEOUT_MS,
      });
      const candidate = normalizeGeneratedOneSentence(json?.message?.content || json?.response || '');
      const defects = [];
      if (!candidate) defects.push('empty response content');
      else {
        if (!isValidAgendaOneSentence(candidate)) {
          defects.push(`shape must be exactly one sentence of ${AGENDA_ONE_SENTENCE_MIN_WORDS}-${AGENDA_ONE_SENTENCE_MAX_WORDS} words`);
        }
        if (!hasNumericFidelity(candidate)) defects.push('numeric fidelity defect');
        if (!oneSentenceMatchesSelectedItems(candidate, selectedItems)) defects.push('selected agenda topic coverage defect');
      }
      if (!defects.length) return candidate;
      rejectedCandidate = candidate;
      rejectionReason = defects.join('; ');
    } catch (err) {
      rejectedCandidate = '';
      rejectionReason = String(err?.message || err || 'unknown fetch error');
    }
  }
  return '';
}

async function rewriteUpcomingAgendaSummaryLlm({
  focus,
  scheduleContext,
  wholeAgendaSummary,
  topNewsMarkdown,
}) {
  const sourceWhole = String(wholeAgendaSummary || '').trim();
  if (!sourceWhole) return '';
  const sourceTop = String(topNewsMarkdown || '').trim();
  const ollamaBase = String(RESOLVED_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://mriczo:11434').replace(/\/+$/u, '');
  const prompt = [
    'Rewrite the summary for an upcoming civic agenda preview.',
    `Focus: ${String(focus || '').trim() || 'newsworthy civic impacts'}.`,
    scheduleContext ? `Meeting context: ${scheduleContext}.` : '',
    'Rules:',
    '- Use present/future tense only for this upcoming meeting.',
    '- Do not imply decisions were already approved/adopted/rejected at this meeting.',
    '- If mentioning actions, frame them as expected discussion, potential decisions, or scheduled consideration.',
    '- Keep factual details and stakes.',
    '- Preserve addresses, unit counts, dates, money, percentages, report codes, and by-law numbers in the same numeric notation used by the source.',
    '- Never spell a multi-digit number digit-by-digit or produce forms such as one-two-zero-one or twelve-eight.',
    '- Return exactly one paragraph, 80-180 words.',
    '',
    `SOURCE_WHOLE_SUMMARY:\n${sourceWhole}`,
    sourceTop ? `\nSOURCE_TOP_NEWS:\n${sourceTop}` : '',
  ].join('\n');
  try {
    const json = await managedChat({
      ollamaBase,
      messages: [
        { role: 'system', content: 'You rewrite civic agenda summaries with strict tense control.' },
        { role: 'user', content: prompt },
      ],
      options: { num_predict: 260 },
      timeoutMs: AGENDA_PREVIEW_LLM_TIMEOUT_MS,
    });
    const text = String(json?.message?.content || json?.response || '')
      .split(/\r?\n/u)
      .map((x) => x.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!text) throw new Error('qwen returned empty rewritten agenda summary');
    if (hasNumericFidelity(text)) return text;
    const corrected = await correctNumericFidelityLlm({ candidateText: text, sourceText: `${sourceWhole}\n\n${sourceTop}` });
    if (hasNumericFidelity(corrected)) return corrected;
    throw new Error('numeric fidelity repair returned no acceptable agenda summary');
  } catch (error) {
    throw new Error(`agenda summary rewrite failed; job remains retryable: ${String(error?.message || error)}`);
  }
}

async function correctNumericFidelityLlm({ candidateText, sourceText }) {
  const candidate = String(candidateText || '').trim();
  const source = String(sourceText || '').trim();
  if (!candidate || hasNumericFidelity(candidate)) return candidate;
  const ollamaBase = String(RESOLVED_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://mriczo:11434').replace(/\/+$/u, '');
  const prompt = [
    'Correct only malformed numeric wording in this civic text.',
    'Return only the corrected text.',
    'Preserve wording except where needed to restore conventional numeric notation from SOURCE.',
    'Examples: one-two-zero-one Fifteenth Avenue East -> 1201 15th Avenue East; twelve-eight units -> 128 units.',
    'Do not invent or calculate numbers.',
    '', `CANDIDATE:\n${candidate}`, '', `SOURCE:\n${source}`,
  ].join('\n');
  try {
    const response = await managedChat({
      ollamaBase,
      options: { num_predict: 280 },
      messages: [{ role: 'system', content: 'You preserve numeric fidelity in civic documents.' }, { role: 'user', content: prompt }],
      timeoutMs: AGENDA_PREVIEW_LLM_TIMEOUT_MS,
    });
    return String(response?.message?.content || response?.response || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).join(' ').trim();
  } catch { return ''; }
}

async function verifyAgendaPreviewClaimsLlm({
  candidateText,
  sourceTopNews,
  sourceSections,
  scheduleContext,
}) {
  const candidate = String(candidateText || '').trim();
  if (!candidate) return '';
  const sources = [
    String(sourceTopNews || '').trim(),
    String(sourceSections || '').trim(),
  ].filter(Boolean).join('\n\n').trim();
  if (!sources) return candidate;
  const ollamaBase = String(RESOLVED_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://mriczo:11434').replace(/\/+$/u, '');
  const prompt = [
    'Validate and correct an upcoming civic agenda preview text.',
    scheduleContext ? `Meeting context: ${scheduleContext}.` : '',
    'Return only corrected text.',
    'Rules:',
    '- Keep only claims supported by SOURCE.',
    '- Remove speculation, loaded framing, and causal claims not explicit in SOURCE.',
    '- Keep upcoming tense (will/may/is scheduled to be considered).',
    '- Do not invent numbers, names, or outcomes.',
    '- Preserve addresses and other numeric facts in the numeric notation used by SOURCE; never spell multi-digit numbers digit-by-digit.',
    '- Preserve concise style and readability.',
    '',
    `CANDIDATE:\n${candidate}`,
    '',
    `SOURCE:\n${sources}`,
  ].join('\n');
  try {
    const json = await managedChat({
      ollamaBase,
      messages: [
        { role: 'system', content: 'You are a strict factual verifier for civic agenda previews.' },
        { role: 'user', content: prompt },
      ],
      options: { num_predict: 260 },
      timeoutMs: AGENDA_PREVIEW_LLM_TIMEOUT_MS,
    });
    const out = String(json?.message?.content || json?.response || '')
      .split(/\r?\n/u)
      .map((x) => x.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!out) throw new Error('qwen returned empty verified agenda text');
    if (hasNumericFidelity(out)) return out;
    const corrected = await correctNumericFidelityLlm({ candidateText: out, sourceText: sources });
    if (hasNumericFidelity(corrected)) return corrected;
    throw new Error('numeric fidelity repair returned no acceptable verified agenda text');
  } catch (error) {
    throw new Error(`agenda claim verification failed; job remains retryable: ${String(error?.message || error)}`);
  }
}

export async function verifyAgendaOneSentenceStrictLlm({
  candidateText,
  sourceTopNews,
  sourceSections,
  scheduleContext,
  selectedItems,
}) {
  const candidate = String(candidateText || '').trim();
  const sources = [
    String(sourceTopNews || '').trim(),
    String(sourceSections || '').trim(),
  ].filter(Boolean).join('\n\n').trim();
  if (!candidate || !sources) return { pass: false, corrected: '', reason: 'missing_candidate_or_sources' };

  const ollamaBase = String(RESOLVED_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://mriczo:11434').replace(/\/+$/u, '');
  const basePrompt = [
    'Validate ONE sentence for an upcoming civic agenda preview.',
    scheduleContext ? 'Meeting context: ' + scheduleContext : '',
    'Return JSON only with keys: pass (boolean), corrected (text), reason (text).',
    'Rules:',
    `- corrected must be exactly one sentence, ${AGENDA_ONE_SENTENCE_MIN_WORDS}-${AGENDA_ONE_SENTENCE_MAX_WORDS} words, plain factual language.`,
    '- if CANDIDATE is too long, condense it while retaining every selected agenda topic and one concrete supporting detail.',
    '- count the words in corrected before returning; never copy an overlong CANDIDATE unchanged.',
    '- corrected must be supported by SOURCE.',
    selectedAgendaTopicPrompt(selectedItems),
    '- include a specific topic phrase for each selected agenda topic; generic committee or report wording is not sufficient.',
    '- reject vague phrasing like "update report" if specific topic names are available in SOURCE.',
    '- do not invent outcomes or decisions.',
    '- preserve addresses and numeric facts in the numeric notation used by SOURCE.',
    '',
    'CANDIDATE:',
    candidate,
    '',
    'SOURCE:',
    sources,
  ].filter(Boolean).join('\n');

  let last = { pass: false, corrected: '', reason: 'no valid response' };
  for (let attempt = 1; attempt <= AGENDA_PREVIEW_ONE_SENTENCE_VERIFY_ATTEMPTS; attempt += 1) {
    const retryFeedback = attempt === 1 ? '' : [
      'This is a bounded repair attempt. Return a fresh corrected sentence, not the prior malformed shape.',
      `REJECTION_REASON: ${last.reason}`,
      `PRIOR_REJECTED_CORRECTED_OUTPUT: ${last.corrected || '(empty)'}`,
      'Do not append a Markdown bullet or agenda heading after the sentence; keep civic abbreviations such as No. inside the sentence when they are part of a title or report code.',
      attempt % 2 === 0
        ? `Repair numeric notation first, then count the words and keep the sentence between ${AGENDA_ONE_SENTENCE_MIN_WORDS} and ${AGENDA_ONE_SENTENCE_MAX_WORDS} words.`
        : 'Remove secondary clauses and rewrite from scratch around the selected agenda topics and one concrete supporting detail.',
    ].join('\n');
    const prompt = [basePrompt, retryFeedback].filter(Boolean).join('\n\n');
    try {
      const obj = await managedChat({
        ollamaBase,
        messages: [
          { role: 'system', content: 'You are a strict factual verifier for one-sentence agenda summaries.' },
          { role: 'user', content: prompt },
        ],
        options: { num_predict: 120 },
        format: 'json',
        timeoutMs: AGENDA_PREVIEW_LLM_TIMEOUT_MS,
      });
      const raw = String(obj?.message?.content || obj?.response || '').trim();
      const parsed = parseFirstJsonObject(raw) || {};
      const normalizedCorrected = normalizeGeneratedOneSentence(parsed?.corrected || candidate);
      const shapePass = isValidAgendaOneSentence(normalizedCorrected);
      const modelPass = parsed?.pass === true;
      const numericPass = hasNumericFidelity(normalizedCorrected);
      const selectedTopicPass = oneSentenceMatchesSelectedItems(normalizedCorrected, selectedItems);
      const contractReasons = [
        !modelPass ? 'the verifier did not accept the candidate' : '',
        !shapePass ? `corrected must be one sentence of ${AGENDA_ONE_SENTENCE_MIN_WORDS}-${AGENDA_ONE_SENTENCE_MAX_WORDS} words` : '',
        !numericPass ? 'numeric fidelity defect' : '',
        !selectedTopicPass ? 'selected agenda topic coverage defect' : '',
      ].filter(Boolean);
      const pass = modelPass && shapePass && numericPass && selectedTopicPass;
      const reason = [
        String(parsed?.reason || '').trim(),
        ...contractReasons,
      ].filter(Boolean).join('; ') || (pass ? 'ok' : 'llm_reject');
      last = { pass, corrected: normalizedCorrected, reason };
      if (pass) return last;
    } catch (err) {
      last = { pass: false, corrected: '', reason: 'fetch_error_' + String(err?.message || 'unknown') };
    }
  }
  return last;
}

async function buildAgendaSummarySourcePath({ meetingDir, transcriptDir, normPrefix }) {
  const convertedDir = path.join(meetingDir, 'converted');
  const sourceDir = path.join(meetingDir, 'source');
  const prunedPath = pickRichestAgendaPrunedMarkdownPathFromConvertedDir(convertedDir);
  const prunedText = prunedPath ? safeReadText(prunedPath, '').trim() : '';
  if (prunedPath && prunedText) return prunedPath;

  const mdPath = pickRichestAgendaMarkdownPathFromConvertedDir(convertedDir);
  const mdText = mdPath ? safeReadText(mdPath, '').trim() : '';
  if (mdPath && mdText) return mdPath;

  const pdfPath = pickRichestAgendaPdfPathFromSourceDir(sourceDir);
  if (!pdfPath || !fs.existsSync(pdfPath)) return '';
  const extractedPath = path.join(transcriptDir, `${normPrefix}.agenda-source.txt`);
  try {
    await runWithStreaming({
      cmd: 'pdftotext',
      args: [pdfPath, extractedPath],
      cwd: PYASH_ROOT,
      timeoutMs: 2 * 60 * 1000,
      label: 'extract-agenda-pdf-text',
    });
    const txt = safeReadText(extractedPath, '').trim();
    if (!txt) return '';
    fs.writeFileSync(extractedPath, `${txt.slice(0, 120000)}\n`, 'utf8');
    return extractedPath;
  } catch {
    return '';
  }
}

async function writeAgendaPreviewArtifacts({
  meetingDir,
  row,
  payload,
  focus,
  jurisdiction,
  body,
  siteUrl,
  discussionUrl,
  basePrefix,
  publishNorm,
}) {
  const transcriptDir = path.join(meetingDir, 'transcript');
  const normPrefix = `${basePrefix}-normalized`;
  const agendaPrefix = `${normPrefix}.agenda`;
  const forceAgendaRebuild = /^(1|true|yes)$/iu.test(String(process.env.OWEN_AGENDA_FORCE_REBUILD || ''));
  const postCmd = String(
    process.env.OWEN_AGENDA_POST_COMMAND
    || process.env.AGENDA_POST_COMMAND
    || `node ${path.join(PYASH_ROOT, 'command/publish_agenda_to_helpos_from_payload.mjs')}`
  ).trim();
  const skipLemmy = /^(1|true|yes)$/iu.test(String(process.env.OWEN_PIPELINE_SKIP_LEMMY || '0'));
  const lemmyPayloadPath = path.join(transcriptDir, `${agendaPrefix}.lemmy-post.json`);
  if (!forceAgendaRebuild && hasAgendaPreviewArtifactsCheckpoint(transcriptDir, agendaPrefix)) {
    log('[meeting-ref] skip agenda-preview generation (checkpoint exists)');
    if (!skipLemmy && postCmd) {
      await runSubmitHook(postCmd, lemmyPayloadPath);
    } else {
      log('[meeting-ref] agenda preview submit skipped (OWEN_PIPELINE_SKIP_LEMMY=1 or missing post command)');
    }
    return;
  }

  const agendaFocus = buildAgendaPreviewGroundedFocus(focus);
  const agendaPath = await buildAgendaSummarySourcePath({ meetingDir, transcriptDir, normPrefix });
  const subreportIndexPath = path.join(meetingDir, 'converted', 'subreports.index.json');
  const subreportIndex = safeReadJson(subreportIndexPath, {});
  const dateInfo = parseDateInfoFromSince(row?.since || '');
  const meetingRouteSlug = canonicalMeetingRouteSlug(payload?.meeting_type || payload?.meeting_name || body);
  const agendaCanonicalUrl = `${siteUrl.replace(/\/+$/u, '')}/agendas/${slugify(jurisdiction)}/${meetingRouteSlug}/${dateInfo.iso || 'unknown-date'}`;
  const transcriptCanonicalUrl = `${siteUrl.replace(/\/+$/u, '')}/transcripts/${slugify(jurisdiction)}/${meetingRouteSlug}/${dateInfo.iso || 'unknown-date'}`;
  const meetingName = String(payload?.meeting_name || body || 'Meeting').trim();
  // Whole-meeting synthesis writes the canonical norm-prefixed artifact; the
  // agenda prefix is reserved for the preview and publication derivatives.
  const meetingSummaryPath = path.join(transcriptDir, `${normPrefix}.meeting-summary.md`);
  const meetingHookPath = path.join(transcriptDir, `${normPrefix}.meeting-hook.txt`);
  const coverImagePath = path.join(transcriptDir, `${agendaPrefix}.meeting-cover.png`);
  const coverImageStablePath = path.join(transcriptDir, 'agenda-cover.png');
  const htmlPath = path.join(transcriptDir, 'agenda-page.html');
  const lemmyBodyPath = path.join(transcriptDir, `${agendaPrefix}.lemmy-post.md`);

  const items = Array.isArray(subreportIndex?.items) ? subreportIndex.items : [];
  const agendaWisePath = path.join(transcriptDir, `${agendaPrefix}.agenda-wise.series.pya`);
  const agendaSummaryPath = path.join(transcriptDir, `${agendaPrefix}.agenda-summary.json`);
  const canonicalAgendaSectionGroundingPath = path.join(transcriptDir, `${normPrefix}.agenda.section-grounding.pya`);
  const canonicalAgendaSummaryPyaPath = path.join(transcriptDir, `${normPrefix}.agenda-summary.pya`);
  const transcriptStyleItems = items
    .map((it) => ({
      item: String(it?.item || '').trim(),
      title: normalizeAgendaTitle(String(it?.title || '')),
      file: String(it?.file || '').trim(),
      has_page_slice: Boolean(it?.has_page_slice),
      attachments: Array.isArray(it?.attachments) ? it.attachments : [],
    }))
    .filter((it) => it.item && isUsableAgendaTitle(it.title) && it.file && fs.existsSync(it.file));
  const fallbackOutlineItems = agendaPath
    ? buildAgendaFallbackOutlineItems({ meetingDir, agendaPath, transcriptDir, normPrefix })
    : [];
  // Build one cohesive agenda: skeleton order first, with subreport content injected inline.
  const mergedAgendaItems = (() => {
    const byKeySubreport = new Map();
    for (const it of transcriptStyleItems) {
      const key = normalizeAgendaItemCode(it.item);
      if (!key) continue;
      byKeySubreport.set(key, it);
    }
    if (items.length) {
      const fallbackByKey = new Map(fallbackOutlineItems.map((it) => [normalizeAgendaItemCode(it.item), it]));
      return items.map((canonical) => {
        const key = normalizeAgendaItemCode(canonical?.item || '');
        const direct = byKeySubreport.get(key);
        const fallback = fallbackByKey.get(key);
        return {
          item: String(canonical?.item || '').trim(),
          source_item: String(canonical?.item || '').trim(),
          title: normalizeAgendaTitle(String(canonical?.title || '')),
          file: String(direct?.file || fallback?.file || '').trim(),
          has_page_slice: Boolean(direct?.has_page_slice),
          attachments: Array.isArray(canonical?.attachments) ? canonical.attachments : [],
        };
      }).filter((it) => it.item && it.title && it.file && fs.existsSync(it.file));
    }
    const tryMatchSubreport = (fallbackItem, prevFallbackItem = null) => {
      const key = normalizeAgendaItemCode(fallbackItem?.item || '');
      const title = String(fallbackItem?.title || '');
      const order = parseAgendaItemOrderKey(key);
      const hasReportCode = Boolean(extractReportCode(title));
      const looksLikeReportOrDeputation = /(?:\breport\b|\bdeputation\b)/iu.test(title);
      // For agenda-preview mode, keep major procedural headings on skeleton text only.
      // Only attach subreport bodies to explicit sub-items or report/deputation-style headings.
      if (!((order && order.minor > 0) || hasReportCode || looksLikeReportOrDeputation)) {
        return null;
      }
      let sub = byKeySubreport.get(key) || null;
      if (sub && isStrongAgendaTitleMatch(title, String(sub?.title || ''))) return sub;
      sub = null;

      return null;
    };
    const out = [];
    const seen = new Set();
    for (let i = 0; i < fallbackOutlineItems.length; i += 1) {
      const it = fallbackOutlineItems[i];
      const key = normalizeAgendaItemCode(it.item);
      if (!key || seen.has(key)) continue;
      const sub = tryMatchSubreport(it, i > 0 ? fallbackOutlineItems[i - 1] : null);
      const subKey = normalizeAgendaItemCode(sub?.item || '');
      out.push({
        item: String(it.item || '').trim(),
        source_item: String(sub?.item || it.item || '').trim(),
        title: normalizeAgendaTitle(String(it.title || sub?.title || '')),
        file: String(sub?.file || it.file || '').trim(),
        has_page_slice: Boolean(sub?.has_page_slice),
        attachments: Array.isArray(sub?.attachments) ? sub.attachments : [],
      });
      seen.add(key);
      if (subKey) seen.add(subKey);
    }
    for (const it of transcriptStyleItems) {
      const key = normalizeAgendaItemCode(it.item);
      if (!key || seen.has(key)) continue;
      out.push({
        ...it,
        source_item: String(it.item || '').trim(),
      });
      seen.add(key);
    }

    for (let i = 0; i < out.length; i += 1) {
      const row = out[i];
      const key = normalizeAgendaItemCode(row?.item || '');
      if (!key) continue;
      const sub = byKeySubreport.get(key);
      if (!sub) continue;
      if (!row.file || !fs.existsSync(String(row.file || '')) || !row.has_page_slice) {
        out[i] = {
          ...row,
          title: normalizeAgendaTitle(String(row.title || sub.title || '')),
          file: String(sub.file || row.file || '').trim(),
          has_page_slice: Boolean(sub.has_page_slice),
          attachments: Array.isArray(sub.attachments) ? sub.attachments : (Array.isArray(row.attachments) ? row.attachments : []),
          source_item: String(sub.item || row.source_item || row.item || '').trim(),
        };
      }
    }

    out.sort((a, b) => compareAgendaItemCodes(a.item, b.item));
    return out.slice(0, 48);
  })();
  if (mergedAgendaItems.length) {
    fs.writeFileSync(agendaWisePath, toAgendaWiseSeriesText(mergedAgendaItems), 'utf8');
    const previewGrounding = buildAgendaPreviewGroundingArtifact(mergedAgendaItems);
    writePyaMapArtifact(
      canonicalAgendaSectionGroundingPath,
      'agenda section grounding artifact',
      previewGrounding,
    );
    try {
      const reuseStage3 = /^(1|true|yes)$/iu.test(String(process.env.OWEN_AGENDA_REUSE_STAGE3 || ''))
        && fs.existsSync(canonicalAgendaSummaryPyaPath)
        && fs.existsSync(path.join(transcriptDir, `${normPrefix}.agenda-summary.md`));
      if (reuseStage3) {
        log('[meeting-ref] reusing validated Stage 3 output (OWEN_AGENDA_REUSE_STAGE3=1)');
      } else await runWithStreaming({
        cmd: 'node',
        args: [path.join(HOUSE_ROOT, 'program/summarize-agenda-wise-sections-from-transcript-folder.mjs'), transcriptDir, normPrefix, focus],
        cwd: PYASH_ROOT,
        env: {
          ...process.env,
          AGENDA_SUMMARY_TIME_MODE: 'upcoming',
        },
        timeoutMs: 2 * 60 * 60 * 1000,
        label: 'agenda-wise-section-summaries',
      });
    } catch (error) {
      throw new Error(`Stage 3 agenda summary generation failed; job remains retryable: ${String(error?.message || error)}`);
    }
  }
  const agendaSummaryJson = safeReadJson(agendaSummaryPath, {});
  const agendaSummaryMdPath = path.join(transcriptDir, `${normPrefix}.agenda-summary.md`);
  const agendaSummarySections = (() => {
    const mdText = safeReadText(agendaSummaryMdPath, '');
    const fromMd = parseAgendaSummaryMarkdownSections(mdText);
    if (fromMd.length) return fromMd;
    return Array.isArray(agendaSummaryJson?.sections) ? agendaSummaryJson.sections : [];
  })();
  const agendaSummaryByItem = new Map(
    agendaSummarySections.map((sec) => {
      const heading = String(sec?.heading || '').trim();
      const itemCode = extractAgendaItemCode(heading);
      return [itemCode, String(sec?.summary || '').trim()];
    }).filter(([k, v]) => k && v),
  );
  const summaryIndexPath = '';
  const displayItems = (() => {
    if (!mergedAgendaItems.length) return items;
    return mergedAgendaItems;
  })();
  const topItems = displayItems
    .map((it) => ({
      item: String(it?.item || '').trim(),
      source_item: String(it?.source_item || it?.item || '').trim(),
      title: normalizeAgendaTitle(String(it?.title || '')),
      file: String(it?.file || '').trim(),
      has_page_slice: Boolean(it?.has_page_slice),
      source_text: safeReadText(String(it?.file || ''), '').trim(),
      agenda_section_summary: String(agendaSummaryByItem.get(normalizeAgendaItemCode(String(it?.item || '').trim())) || '').trim(),
      generated_summary: '',
      stage3_chapters: agendaSummarySections.find((section) => extractAgendaItemCode(section?.heading) === normalizeAgendaItemCode(String(it?.item || '')))?.chapters || [],
      substantive: Array.isArray(it?.attachments) && it.attachments.length > 0 || safeReadText(String(it?.file || ''), '').trim().split(/\s+/u).filter(Boolean).length >= 80,
      long_source: safeReadText(String(it?.file || ''), '').trim().split(/\s+/u).filter(Boolean).length >= 700,
      procedural: isProceduralAgendaHeading(String(it?.title || '')),
      attachments: Array.isArray(it?.attachments)
        ? it.attachments
          .map((a) => ({
            label: String(a?.label || '').trim(),
            url: String(a?.url || '').trim(),
          }))
          .filter((a) => a.label && a.url)
        : [],
    }))
    .filter((it) => it.title)
    .slice(0, 48);
  for (const item of topItems) {
    item.source_text = sanitizeAgendaSectionBody(item, item.source_text);
    const sourceWords = item.source_text.split(/\s+/u).filter(Boolean).length;
    item.substantive = item.attachments.length > 0 || sourceWords >= 80;
    item.long_source = sourceWords >= 700;
    item.procedural = isProceduralAgendaHeading(item.title);
  }
  assertAgendaPublishable(topItems);
  const subsectionRowsByItem = new Map(topItems.map((item) => [String(item.item || '').trim(), item.stage3_chapters]));
  const subsectionHighlightsMarkdown = topItems
    .map((it) => {
      const key = String(it.item || '').trim();
      const subs = subsectionRowsByItem.get(key) || [];
      if (!subs.length) return '';
      const heading = `${it.item ? `${it.item} ` : ''}${it.title}`.trim();
      const merged = subs
        .map((sub) => `${String(sub.title || '').trim()}: ${String(sub.summary || sub.text || '').trim()}`)
        .filter(Boolean)
        .join(' ');
      if (!merged) return '';
      return `- **${heading} (Subsections):** ${merged}`;
    })
    .filter(Boolean)
    .join('\n');
  const agendaLinks = uniqueNonEmptyStrings([
    ...(Array.isArray(payload?.agenda_cover) ? payload.agenda_cover : []),
    ...(Array.isArray(payload?.agenda) ? payload.agenda : []),
  ]);
  const localSourceAttachments = [
    ...(Array.isArray(payload?.agenda_cover)
      ? payload.agenda_cover.map((url, index) => ({ kind: 'agenda-cover', url, index }))
      : []),
    ...(Array.isArray(payload?.agenda)
      ? payload.agenda.map((url, index) => ({ kind: 'agenda', url, index }))
      : []),
  ]
    .filter((row) => /\/filestream\.ashx(?:[?#]|$)/iu.test(String(row.url || '')))
    .map((row) => ({
      item: 'agenda-source',
      label: row.kind === 'agenda-cover' ? 'Official agenda cover' : 'Official agenda package',
      url: row.url,
      local_file: path.join(meetingDir, 'source', docName(row.kind, row.index, row.url)),
    }));
  const supportingAttachments = (() => {
    const out = [];
    const seen = new Set();
    for (const item of items) {
      for (const attachment of Array.isArray(item?.attachments) ? item.attachments : []) {
        const url = String(attachment?.url || '').trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push({
          item: String(item?.item || '').trim(),
          label: String(attachment?.label || item?.title || 'Supporting attachment').trim(),
          url,
        });
      }
    }
    return out;
  })();
  let hook = '';
  const summaryCandidates = topItems
    .map((it) => ({
      ...it,
      active_summary: cleanSummaryForPost(String((it.has_page_slice ? (it.generated_summary || it.agenda_section_summary) : (it.agenda_section_summary || it.generated_summary)) || '').trim()),
    }))
    .filter((it) => it.active_summary);
  const newsworthySelection = selectNewsworthyAgendaItems(summaryCandidates, { topN: 8, minScore: 3 });
  let summaryItems = suppressStructuralParentsWithCoveredChildren(newsworthySelection.selected, summaryCandidates);
  let newsworthyFallbackItems = newsworthySelection.scored
    .filter((it) => !it.newsworthy_excluded)
    .slice(0, 8);
  const coverageVerifyPath = path.join(transcriptDir, `${agendaPrefix}.agenda-preview.coverage.verify.pya`);
  const initialCoverage = evaluateAgendaPreviewCoverage({
    topItems: summaryCandidates,
    summaryItems,
    rawSubreportItems: items,
  });
  const coverageRowByHeading = new Map((initialCoverage.rows || []).map((r) => [String(r.heading || ''), r]));
  summaryItems = summaryItems.filter((it) => {
    const heading = `${it?.item ? `${it.item} ` : ''}${String(it?.title || '').trim()}`.trim();
    const row = coverageRowByHeading.get(heading);
    if (row && row.requires_detail && !row.accepted) return false;
    return isAgendaTopNewsSubstantive(it);
  });
  newsworthyFallbackItems = newsworthyFallbackItems.filter((it) => isAgendaTopNewsSubstantive(it));
  const coverage = evaluateAgendaPreviewCoverage({
    topItems: summaryCandidates,
    summaryItems,
    rawSubreportItems: items,
  });
  writePyaMapArtifact(coverageVerifyPath, 'agenda preview coverage verify artifact', {
    schema_version: 'agenda_preview_coverage_v1',
    generated_at_utc: new Date().toISOString(),
    pass: coverage.pass,
    failures: coverage.failures,
    subreport_candidates_total: coverage.subreport_candidates_total,
    subreport_candidates_usable: coverage.subreport_candidates_usable,
    all_subreport_candidates_unusable: coverage.all_subreport_candidates_unusable,
    coverage_rows: coverage.rows,
    selected_rows: coverage.selected_rows,
  });
  if (!coverage.pass) {
    throw new Error(`agenda preview coverage gate failed: ${coverage.failures.join(', ')} | report=${coverageVerifyPath}`);
  }
  for (const row of newsworthySelection.scored.slice(0, 10)) {
    log(`[agenda-newsworthy] score=${Number(row.newsworthy_score || 0).toFixed(2)} selected=${row.newsworthy_selected ? 'yes' : 'no'} heading="${String(row.item || '').trim()} ${String(row.title || '').trim()}"`);
  }
  const deterministicBreakdown = agendaSummarySections
    .map((sec) => ({
      heading: String(sec?.heading || '').trim(),
      summary: cleanSummaryForPost(String(sec?.summary || '').trim()),
    }))
    .filter((it) => it.heading && it.summary);
  if (topItems.length > 0 && summaryItems.length === 0 && deterministicBreakdown.length === 0) {
    throw new Error('agenda preview missing section summaries (regression guard)');
  }
  const audioSeconds = await ffprobeDurationSeconds(path.join(transcriptDir, 'meeting-audio.opus'));
  const wholeMeetingWorkSeconds = estimateAgendaWholeSummaryWorkSeconds({
    audioSeconds,
    sectionCount: agendaSummarySections.length,
  });
  const wholeMeetingSummaryTimeoutMs = scaleTimeout(
    AGENDA_WHOLE_SUMMARY_BASE_TIMEOUT_MS,
    wholeMeetingWorkSeconds,
    AGENDA_WHOLE_SUMMARY_TIMEOUT_SLOPE,
  );
  log(`[meeting-ref] whole-meeting summary timeout ms: ${wholeMeetingSummaryTimeoutMs}`);
  try {
    const reuseWholeSummary = hasWholeAgendaSummaryCheckpoint(meetingSummaryPath, agendaSummarySections);
    if (reuseWholeSummary) {
      log('[meeting-ref] reuse complete whole-agenda summary checkpoint');
    } else {
      await runWithStreaming({
        cmd: 'node',
        args: [
          path.join(HOUSE_ROOT, 'program/summarize-whole-meeting-from-agenda-summary.mjs'),
          transcriptDir,
          normPrefix,
          agendaFocus,
        ],
        cwd: PYASH_ROOT,
        env: {
          ...process.env,
          AGENDA_SUMMARY_TIME_MODE: 'upcoming',
        },
        timeoutMs: wholeMeetingSummaryTimeoutMs,
        label: 'agenda-whole-summary',
      });
    }
  } catch (error) {
    throw new Error(`agenda whole summary generation failed; job remains retryable: ${String(error?.message || error)}`);
  }
  const meetingSummaryMd = safeReadText(meetingSummaryPath, '').trim();
  if (!meetingSummaryMd) throw new Error('agenda whole summary artifact is empty; job remains retryable');
  const llmTopNews = markdownSection(meetingSummaryMd, 'Top Newsworthy Developments');
  const llmWhyMatters = markdownSection(meetingSummaryMd, 'Why It Matters');
  const deterministicTopNewsMarkdown = summaryItems.length
    ? summaryItems
      .filter((it) => !isEmptyProceduralAgendaItem({ title: it?.title, summary: it?.active_summary }))
      .filter((it) => !isNonSubstantiveAgendaSummary(String(it?.active_summary || '')))
      .map((it) => ({ title: toReaderFacingAgendaTitle(it.title), summary: it.active_summary }))
      .filter((it) => isUsableAgendaNewsTitle(it.title))
      .map((it) => `- **${it.title}:** ${it.summary}`)
      .join('\n')
    : '';
  const mergedTopNewsMarkdown = dedupeMarkdownBulletLines([llmTopNews, deterministicTopNewsMarkdown]
    .filter(Boolean)
    .join('\n\n')
    .trim());
  try {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE_ROOT, 'program/generate-meeting-hook-from-transcript-folder.mjs'),
        transcriptDir,
        normPrefix,
        agendaFocus,
        jurisdiction,
        body,
      ],
      cwd: PYASH_ROOT,
      timeoutMs: 30 * 60 * 1000,
      label: 'agenda-preview-hook',
    });
  } catch (error) {
    throw new Error(`agenda hook generation failed; job remains retryable: ${String(error?.message || error)}`);
  }
  const llmHook = safeReadText(meetingHookPath, '').trim();
  if (!isReadableAgendaHook(llmHook)
    || !(hookMatchesSelectedItems(llmHook, summaryItems) || hookMatchesSelectedItems(llmHook, newsworthyFallbackItems))) {
    throw new Error('agenda preview hook gate failed: no substantive source-grounded hook');
  }
  hook = llmHook;
  hook = normalizeCanadianEnglish(hook);
  const title = `${hook} - ${meetingName} Agenda Preview - ${dateInfo.long}`;
  const meetingTime = formatMeetingTimeText(payload, row?.since || '');
  const meetingLocation = pickMeetingLocationText(payload);
  const scheduleContext = buildScheduleContext({ dateInfo, meetingTime, meetingLocation });

  const llmLead = markdownLeadSection(meetingSummaryMd);
  const narrativeWholeSummary = cleanSummaryForPost(llmLead || llmWhyMatters || '');
  if (!narrativeWholeSummary || narrativeWholeSummary.length < 90) {
    throw new Error('agenda whole summary is empty or too short; job remains retryable');
  }
  const fullAgendaSummary = narrativeWholeSummary;
  const rewrittenWholeAgendaSummary = (
    await rewriteUpcomingAgendaSummaryLlm({
      focus: agendaFocus,
      scheduleContext,
      wholeAgendaSummary: fullAgendaSummary,
      topNewsMarkdown: mergedTopNewsMarkdown || llmTopNews,
    })
  );
  if (!rewrittenWholeAgendaSummary) throw new Error('agenda summary rewrite returned empty text; job remains retryable');
  const enforcedWholeAgendaSummary = await verifyAgendaPreviewClaimsLlm({
    candidateText: rewrittenWholeAgendaSummary,
    sourceTopNews: mergedTopNewsMarkdown || llmTopNews,
    sourceSections: deterministicTopNewsMarkdown,
    scheduleContext,
  });
  const llmOneSentence = await generateOneSentenceSummaryLlm({
    transcriptDir,
    normPrefix: agendaPrefix,
    focus: agendaFocus,
    fullAgendaSummary: enforcedWholeAgendaSummary,
    topNewsMarkdown: mergedTopNewsMarkdown || llmTopNews,
    scheduleContext,
    selectedItems: summaryItems,
  });
  const oneSentenceRawPath = path.join(transcriptDir, `${agendaPrefix}.agenda.one-sentence.llm.raw.txt`);
  fs.writeFileSync(oneSentenceRawPath, String(llmOneSentence || '').trim() + '\n', 'utf8');
  let oneSentenceSummary = String(await verifyAgendaPreviewClaimsLlm({
    candidateText: llmOneSentence,
    sourceTopNews: mergedTopNewsMarkdown || llmTopNews,
    sourceSections: deterministicTopNewsMarkdown,
    scheduleContext,
  }) || '').trim();

  const oneSentenceVerifyPath = path.join(transcriptDir, `${agendaPrefix}.agenda.one-sentence.verify.pya`);
  const oneSentenceReview = await verifyAgendaOneSentenceStrictLlm({
    // Review the concise generated proposal directly. The claim-checking pass can
    // expand it with every supporting condition, which violates this field's shape
    // contract before the strict verifier has a chance to condense it.
    candidateText: llmOneSentence || oneSentenceSummary,
    sourceTopNews: mergedTopNewsMarkdown || llmTopNews,
    sourceSections: deterministicTopNewsMarkdown,
    scheduleContext,
    selectedItems: summaryItems,
  });

  if (String(oneSentenceReview.corrected || '').trim()) {
    oneSentenceSummary = String(oneSentenceReview.corrected || '').trim();
  }

  const oneSentenceLocalPass = isValidAgendaOneSentence(oneSentenceSummary)
    && oneSentenceMatchesSelectedItems(oneSentenceSummary, summaryItems)
    && hasNumericFidelity(oneSentenceSummary);
  const oneSentenceAcceptedViaCorrection = !Boolean(oneSentenceReview.pass)
    && String(oneSentenceReview.corrected || '').trim().length > 0
    && oneSentenceLocalPass;
  const oneSentencePass = oneSentenceLocalPass
    && (Boolean(oneSentenceReview.pass) || oneSentenceAcceptedViaCorrection);

  writePyaMapArtifact(oneSentenceVerifyPath, 'agenda one-sentence verify artifact', {
    schema_version: 'agenda_one_sentence_verify_v1',
    generated_at_utc: new Date().toISOString(),
    pass: oneSentencePass,
    llm_pass: Boolean(oneSentenceReview.pass),
    accepted_via_correction: oneSentenceAcceptedViaCorrection,
    local_pass: oneSentenceLocalPass,
    reason: String(oneSentenceReview.reason || ''),
    candidate: llmOneSentence,
    verified_sentence: oneSentenceSummary,
    raw_llm_path: oneSentenceRawPath,
    verified_text_path: path.join(transcriptDir, `${agendaPrefix}.agenda.one-sentence.verified.txt`),
    source_top_news_present: Boolean(String(mergedTopNewsMarkdown || llmTopNews || '').trim()),
    source_sections_present: Boolean(String(deterministicTopNewsMarkdown || '').trim()),
  });

  const oneSentenceVerifiedPath = path.join(transcriptDir, `${agendaPrefix}.agenda.one-sentence.verified.txt`);
  fs.writeFileSync(oneSentenceVerifiedPath, String(oneSentenceSummary || '').trim() + '\n', 'utf8');

  if (!oneSentencePass) {
    throw new Error('one-sentence summary verification failed | report=' + oneSentenceVerifyPath);
  }

  if (/\bReport\s+[A-Z]{2}-\d{2}-\d{3}\b/u.test(oneSentenceSummary) || /\baBy-law\b/u.test(oneSentenceSummary)) {
    throw new Error('one-sentence summary verification failed: malformed generated heading phrase | report=' + oneSentenceVerifyPath);
  }
  oneSentenceSummary = enforceAgendaSentenceBodySubject(oneSentenceSummary, body, meetingName);
  oneSentenceSummary = normalizeCanadianEnglish(oneSentenceSummary);
  const whenWhere = [
    dateInfo.long ? `**${dateInfo.long}**` : '',
    meetingTime ? `**${meetingTime}**` : '',
    meetingLocation ? `at **${meetingLocation}**` : '',
  ].filter(Boolean).join(' ');
  const bodyParts = [
    whenWhere ? `Upcoming meeting preview for **${meetingName}** on ${whenWhere}.` : `Upcoming meeting preview for **${meetingName}**.`,
    'This preview is based on the published agenda package and supporting reports.',
  ];
  bodyParts.push('## One-Sentence Summary');
  bodyParts.push(oneSentenceSummary);
  bodyParts.push('## Whole Agenda Summary');
  bodyParts.push(enforcedWholeAgendaSummary);
  if (mergedTopNewsMarkdown || llmTopNews) {
    bodyParts.push('## Most Newsworthy Agenda Items');
    bodyParts.push(mergedTopNewsMarkdown || llmTopNews);
  } else {
    throw new Error('agenda newsworthy summary generation returned empty text; job remains retryable');
  }
  bodyParts.push('## What To Watch');
  bodyParts.push('- Which agenda items move forward to formal recommendations.');
  bodyParts.push('- Whether staff proposals trigger additional public consultation or revisions.');
  bodyParts.push('- Follow-up actions, timelines, and any deferred items.');
  bodyParts.push(`Read full agenda archive page: ${agendaCanonicalUrl}`);
  bodyParts.push(`Transcript will be published here: ${transcriptCanonicalUrl}`);
  if (agendaLinks.length) {
    bodyParts.push('## Original Agenda Package Links');
    bodyParts.push(agendaLinks.map((url, idx) => `- [Agenda source ${idx + 1}](${url})`).join('\n'));
  }
  if (supportingAttachments.length) {
    bodyParts.push('## Supporting Attachments');
    bodyParts.push(supportingAttachments.map((attachment) => {
      const prefix = attachment.item ? `${attachment.item} ` : '';
      return `- [${prefix}${attachment.label}](${attachment.url})`;
    }).join('\n'));
  }
  if (payload?.meeting_url) bodyParts.push(`Official meeting page: ${payload.meeting_url}`);
  if (discussionUrl) bodyParts.push(`HelpOS discussion: ${discussionUrl}`);
  const bodyMarkdown = normalizeCanadianEnglish(bodyParts.join('\n\n').trim());
  assertNumericFidelity(enforcedWholeAgendaSummary, 'whole agenda summary');
  assertNumericFidelity(oneSentenceSummary, 'one-sentence summary');
  assertNumericFidelity(mergedTopNewsMarkdown || llmTopNews, 'newsworthy agenda summaries');
  assertNumericFidelity(bodyMarkdown, 'publish body');

  const jurisdictionSlug = slugify(jurisdiction);
  const bodySlug = slugify(body);
  const archiveJurUrl = `/agendas/${jurisdictionSlug}`;
  const archiveBodyUrl = `/agendas/${jurisdictionSlug}/${bodySlug}`;
  const summaryText = enforcedWholeAgendaSummary;
  const description = `Agenda preview and section summaries for the ${meetingName} meeting on ${dateInfo.long}.`;
  const summaryTextByItem = new Map(summaryItems.map((it) => [String(it.item || '').trim(), String(it.active_summary || '').trim()]));
  const sectionRows = topItems
    .filter((it) => String(it.source_text || '').trim())
    .map((it, idx) => ({
      id: `section-${idx + 1}`,
      heading: `${it.item ? `${it.item} ` : ''}${it.title}`.trim(),
      summary: summaryTextByItem.get(String(it.item || '').trim()) || cleanSummaryForPost(String(it.agenda_section_summary || it.generated_summary || '').trim()),
      fullText: String(it.source_text || '').trim(),
      subsections: (subsectionRowsByItem.get(String(it.item || '').trim()) || []).map((sub, subIndex) => ({
        ...sub,
        id: `section-${idx + 1}-child-${subIndex + 1}`,
      })),
    }));
  const tocRows = [
    { href: '#summary', label: 'Summary' },
    { href: '#key-topics', label: 'Key Topics & Sections' },
    { href: '#details', label: 'Meeting Details' },
    { href: '#discussion', label: 'Related Discussion' },
    { href: '#transcript-notice', label: 'Transcript Notice' },
    { href: '#full-transcript', label: 'Full Transcript' },
    { href: '#related-links', label: 'Related Links' },
  ];
  const tocHtml = renderAgendaPreviewToc({ utilityRows: tocRows, sections: sectionRows });
  const topNewsHtml = mergedTopNewsMarkdown
    ? `<div class="newsworthy-md">${markdownToHtmlBlock(mergedTopNewsMarkdown)}</div>`
    : '';
  const sectionsHtml = sectionRows.length
    ? sectionRows.map((s) => {
      const children = s.subsections.length
        ? `<div class="section-subsections">${s.subsections.map((sub) => `<article id="${escapeHtml(sub.id)}" class="subsection"><h4>${escapeHtml(sub.title || 'Subsection')}</h4><p>${escapeHtml(sub.summary || sub.text || '')}</p></article>`).join('')}</div>`
        : '';
      return `<section id="${escapeHtml(s.id)}" class="transcript-section"><h3>${escapeHtml(s.heading)}</h3><p class="section-summary">${escapeHtml(s.summary)}</p>${children}<pre>${escapeHtml(s.fullText)}</pre></section>`;
    }).join('\n')
    : '<p>No section text available.</p>';
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    headline: title,
    datePublished: `${dateInfo.iso || '1970-01-01'}T00:00:00-05:00`,
    dateModified: new Date().toISOString(),
    mainEntityOfPage: agendaCanonicalUrl,
    publisher: { '@type': 'Organization', name: 'HelpOS', url: DEFAULT_SITE },
    about: sectionRows.flatMap((section) => [
      section.heading,
      ...section.subsections.map((sub) => sub.title),
    ]).slice(0, 10),
    description,
  };

  const htmlLines = [
    '<!doctype html>',
    '<html lang="en-CA">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtml(title)}</title>`,
    `  <meta name="description" content="${escapeHtml(description)}" />`,
    `  <link rel="canonical" href="${escapeHtml(agendaCanonicalUrl)}" />`,
    `  <meta property="og:title" content="${escapeHtml(title)}" />`,
    `  <meta property="og:description" content="${escapeHtml(description)}" />`,
    '  <meta property="og:type" content="article" />',
    `  <meta property="og:url" content="${escapeHtml(agendaCanonicalUrl)}" />`,
    `  <meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `  <meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `  <script type="application/ld+json">${JSON.stringify(ld)}</script>`,
    '  <style>',
    '    :root { --bg:#faf8f2; --fg:#1c1f24; --muted:#5c6670; --line:#d7d2c6; --accent:#0f5f8f; }',
    '    * { box-sizing:border-box; }',
    '    body { margin:0; font-family: "Source Serif 4", Georgia, serif; background:var(--bg); color:var(--fg); line-height:1.6; }',
    '    .wrap { max-width: 860px; margin: 0 auto; padding: 1.25rem 1rem 3rem; }',
    '    nav.breadcrumbs { font-size:.95rem; color:var(--muted); margin-bottom:1rem; }',
    '    nav.breadcrumbs a { color:var(--accent); text-decoration:none; }',
    '    header h1 { margin:.2rem 0 .4rem; font-size:1.9rem; line-height:1.2; }',
    '    .subtitle { color:var(--muted); margin:0 0 1rem; }',
    '    .hook { display:inline-block; margin:.2rem 0 .55rem; padding:.2rem .5rem; border:1px solid var(--line); background:#fff; font-family:"IBM Plex Sans", Arial, sans-serif; font-size:.92rem; font-weight:700; }',
    '    section { margin: 1.25rem 0 1.4rem; padding-top:.3rem; }',
    '    h2 { font-family: "IBM Plex Sans", Arial, sans-serif; font-size:1.25rem; margin:0 0 .6rem; }',
    '    h3 { font-family: "IBM Plex Sans", Arial, sans-serif; margin:.6rem 0 .4rem; font-size:1.02rem; }',
    '    .toc { margin:.3rem 0 .9rem; padding:.6rem .75rem; border:1px solid var(--line); background:#fff; }',
    '    .toc ol { margin:.25rem 0 .1rem 1.2rem; }',
    '    .toc .toc-children { margin:.2rem 0 .35rem 1.15rem; font-size:.94rem; }',
    '    .toc a { color:var(--accent); text-decoration:none; }',
    '    .details dl { display:grid; grid-template-columns: 160px 1fr; gap:.25rem .75rem; margin:0; }',
    '    .details dt { font-weight:700; font-family:"IBM Plex Sans", Arial, sans-serif; }',
    '    .details dd { margin:0; }',
    '    .notice { border:1px solid var(--line); background:#fff; padding:.75rem .85rem; }',
    '    .section-summary { margin:.1rem 0 .5rem; color:#26323e; background:#fff; border-left:3px solid var(--line); padding:.35rem .55rem; }',
    '    .transcript-section { margin: 1.1rem 0 1.25rem; }',
    '    pre { white-space:pre-wrap; background:#fff; border:1px solid var(--line); padding:.7rem; }',
    '    .discussion a, .links a { color:var(--accent); }',
    '    ul { margin:.25rem 0 .25rem 1.2rem; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main class="wrap">',
    '    <nav class="breadcrumbs" aria-label="Breadcrumb">',
    '      <a href="/">Home</a> / <a href="/agendas">Agendas</a> / ' +
      `<a href="${escapeHtml(archiveJurUrl)}">${escapeHtml(jurisdiction)}</a> / ` +
      `<a href="${escapeHtml(archiveBodyUrl)}">${escapeHtml(body)}</a> / <span>${escapeHtml(dateInfo.long)}</span>`,
    '    </nav>',
    '    <header>',
    `      <h1>${escapeHtml(meetingName)} Agenda Preview — ${escapeHtml(dateInfo.long)}</h1>`,
    `      ${hook ? `<p class="hook">Hook: ${escapeHtml(hook)}</p>` : ''}`,
    `      <p class="subtitle">${escapeHtml(jurisdiction)} · ${escapeHtml(body)} · ${escapeHtml(dateInfo.long)}</p>`,
    '    </header>',
    '    <section id="summary">',
    '      <h2>Summary</h2>',
    `      <p><strong>One-sentence summary:</strong> ${escapeHtml(oneSentenceSummary)}</p>`,
    `      <p>${escapeHtml(summaryText)}</p>`,
    `      ${topNewsHtml ? `<h3>Top Newsworthy Developments</h3>${topNewsHtml}` : ''}`,
    '    </section>',
    '    <section id="key-topics">',
    '      <h2>Key Topics &amp; Sections</h2>',
    `      ${tocHtml}`,
    '    </section>',
    '    <section id="details" class="details">',
    '      <h2>Meeting Details</h2>',
    '      <dl>',
    `        <dt>Jurisdiction</dt><dd>${escapeHtml(jurisdiction)}</dd>`,
    `        <dt>Body</dt><dd>${escapeHtml(body)}</dd>`,
    `        <dt>Date</dt><dd>${escapeHtml(dateInfo.long)}</dd>`,
    '        <dt>Transcript Status</dt><dd>Agenda package summary and extracted subreport text</dd>',
    `        <dt>Transcript URL</dt><dd><a href="${escapeHtml(transcriptCanonicalUrl)}">${escapeHtml(transcriptCanonicalUrl)}</a></dd>`,
    `        <dt>Official Source</dt><dd>${payload?.meeting_url ? `<a href="${escapeHtml(String(payload.meeting_url))}">View official meeting page</a>` : 'Not provided'}</dd>`,
    '      </dl>',
    '    </section>',
    '    <section id="discussion" class="discussion">',
    '      <h2>Related Discussion</h2>',
    `      <p>${discussionUrl ? `<a href="${escapeHtml(discussionUrl)}">Discuss this meeting on HelpOS</a>` : 'HelpOS discussion thread link pending.'}</p>`,
    '    </section>',
    '    <section id="transcript-notice" class="notice" aria-labelledby="transcript-notice-title">',
    '      <h2 id="transcript-notice-title">Transcript Notice</h2>',
    '      <p>This page is an accessibility-focused summary and extracted agenda text intended to promote civic accessibility.</p>',
    '      <p>It is an unofficial convenience copy and may contain extraction or summarization errors.</p>',
    '      <p>For the authoritative record, try to access the original source materials from Owen Sound using the original link below.</p>',
    `      <p>${payload?.meeting_url ? `<a href="${escapeHtml(String(payload.meeting_url))}">Original meeting link</a>` : 'Original meeting link unavailable.'}</p>`,
    '    </section>',
    '    <section id="full-transcript">',
    '      <h2>Full Transcript</h2>',
    `      ${sectionsHtml}`,
    '    </section>',
    '    <section id="related-links" class="links">',
    '      <h2>Related Links</h2>',
    '      <ul>',
    `        <li><a href="${escapeHtml(archiveJurUrl)}">More ${escapeHtml(jurisdiction)} agendas</a></li>`,
    `        <li><a href="${escapeHtml(archiveBodyUrl)}">More ${escapeHtml(body)} agendas</a></li>`,
    `        <li><a href="${escapeHtml(transcriptCanonicalUrl)}">Transcript URL</a></li>`,
    `        ${payload?.meeting_url ? `<li><a href="${escapeHtml(String(payload.meeting_url))}">Official eScribe meeting page</a></li>` : ''}`,
    ...agendaLinks.map((url, idx) => `        <li><a href="${escapeHtml(url)}">Agenda source ${idx + 1}</a></li>`),
    ...supportingAttachments.map((attachment) => `        <li><a href="${escapeHtml(attachment.url)}">${escapeHtml(`${attachment.item ? `${attachment.item} ` : ''}${attachment.label}`)}</a></li>`),
    '      </ul>',
    '    </section>',
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].filter(Boolean);
  const html = htmlLines.join('\n');
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(meetingHookPath, `${hook}\n`, 'utf8');

  const imageInputVerifyPath = path.join(transcriptDir, `${agendaPrefix}.agenda-preview.image-input.verify.pya`);
  const topImageItem = (summaryItems || []).find((it) => !isEmptyProceduralAgendaItem({ title: it?.title, summary: it?.active_summary })) || null;
  const imageInputProcedural = !hook || isEmptyProceduralAgendaItem({ title: hook, summary: '' });
  writePyaMapArtifact(imageInputVerifyPath, 'agenda preview image input verify artifact', {
    schema_version: 'agenda_preview_image_input_v1',
    generated_at_utc: new Date().toISOString(),
    final_hook: hook,
    overlay_text: hook,
    selected_source_item_id: String(topImageItem?.item || ''),
    selected_source_item_title: String(topImageItem?.title || ''),
    selected_source_item_procedural: topImageItem ? isEmptyProceduralAgendaItem({ title: topImageItem?.title, summary: topImageItem?.active_summary }) : null,
    overlay_source_is_procedural: imageInputProcedural,
    pass: !imageInputProcedural,
  });
  if (imageInputProcedural) {
    throw new Error(`agenda image input gate failed: procedural/empty hook selected | report=${imageInputVerifyPath}`);
  }

  const drawStartedAt = Date.now();
  let drawCoverOk = false;
  try {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(PYASH_ROOT, 'command/draw_meeting_cover_from_transcript_folder.mjs'),
        transcriptDir,
        agendaPrefix,
        process.env.OWEN_DRAW_STYLE || '',
      ],
      cwd: PYASH_ROOT,
      env: {
        PYA_DRAW_COVER_STABLE_NAME: 'agenda-cover.png',
      },
      timeoutMs: 45 * 60 * 1000,
      label: 'draw-meeting-cover',
    });
    drawCoverOk = true;
  } catch (err) {
    log(`[meeting-ref] warn draw-meeting-cover failed: ${String(err?.message || err)}`);
    for (const stalePath of [coverImageStablePath, coverImagePath]) {
      try {
        if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
      } catch {}
    }
  }
  const isFreshFile = (filePath) => {
    try {
      const st = fs.statSync(filePath);
      return st.isFile() && Number(st.size || 0) > 0 && Number(st.mtimeMs || 0) >= (drawStartedAt - 1500);
    } catch {
      return false;
    }
  };
  const localCoverImage = drawCoverOk
    ? (
      isFreshFile(coverImageStablePath)
        ? coverImageStablePath
        : (isFreshFile(coverImagePath) ? coverImagePath : '')
    )
    : '';
  if (drawCoverOk && !localCoverImage) {
    throw new Error("agenda cover image stale/missing after draw; fallback and reuse are disabled");
  }

  fs.writeFileSync(lemmyBodyPath, `${bodyMarkdown}\n`, 'utf8');
  fs.writeFileSync(lemmyPayloadPath, `${JSON.stringify({
    title,
    body_markdown: bodyMarkdown,
    agenda_url: agendaCanonicalUrl,
    transcript_url: transcriptCanonicalUrl,
    local_agenda_html: htmlPath,
    local_transcript_html: '',
    local_cover_image: localCoverImage,
    local_attachment_index: subreportIndexPath,
    local_source_attachments: localSourceAttachments,
    jurisdiction,
    body,
    date_iso: dateInfo.iso,
    hook,
    focus,
    source: {
      meeting_url: String(payload?.meeting_url || ''),
      video_url: '',
      agenda_urls: agendaLinks,
      subreport_summaries_file: summaryIndexPath,
      agenda_wise_series_file: agendaWisePath,
      agenda_summary_file: agendaSummaryMdPath,
    },
    discussion_url: discussionUrl,
    content_type: 'agenda',
    generated_at_utc: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');

  if (!skipLemmy && postCmd) {
    await runSubmitHook(postCmd, lemmyPayloadPath);
  }

  log('[meeting-ref] no transcript audio; agenda preview artifacts generated');
  log(`[meeting-ref] payload: ${lemmyPayloadPath}`);
}

function buildPipeline(meetingDir, row) {
  const payload = row.payload ?? {};
  const sourceDir = path.join(meetingDir, 'source');
  const convertedDir = path.join(meetingDir, 'converted');
  const reportDir = path.join(meetingDir, 'report');
  const transcriptDir = path.join(meetingDir, 'transcript');

  const lines = [];
  lines.push('su name sandbox configure be map def');
  lines.push('su name max output bytes ob num 8388608 ya');
  lines.push('su name timeout ms ob num 21600000 ya');
  lines.push('prah');
  lines.push('');

  lines.push(`be directory ob filename "${pyaEsc(sourceDir)}" do`);
  lines.push(`be directory ob filename "${pyaEsc(convertedDir)}" do`);
  lines.push(`be directory ob filename "${pyaEsc(reportDir)}" do`);
  lines.push(`be directory ob filename "${pyaEsc(transcriptDir)}" do`);
  lines.push('');

  const allDocs = [
    ...(Array.isArray(payload.agenda_cover) ? payload.agenda_cover.map((u, i) => ({ kind: 'agenda-cover', url: u, i })) : []),
    ...(Array.isArray(payload.agenda) ? payload.agenda.map((u, i) => ({ kind: 'agenda', url: u, i })) : []),
    ...(Array.isArray(payload.minutes) ? payload.minutes.map((u, i) => ({ kind: 'minutes', url: u, i })) : []),
  ];

  let agendaHtmlPath = '';

  for (const doc of allDocs) {
    const fileName = docName(doc.kind, doc.i, doc.url);
    const srcPath = path.join(sourceDir, fileName);
    if (doc.kind === 'agenda' && fileName.toLowerCase().endsWith('.html')) {
      agendaHtmlPath = srcPath;
    }
    lines.push(`be download from filename "${pyaEsc(doc.url)}" as wo file to filename "${pyaEsc(srcPath)}" do`);

    if (fileName.toLowerCase().endsWith('.pdf')) {
      const mdVar = `doc ${doc.kind} ${doc.i + 1} markdown`;
      const mdPath = path.join(convertedDir, markdownName(fileName));
      lines.push(`from filename "${pyaEsc(srcPath)}" fromstate wo pdf become wo markdown to name text ${mdVar} be read do`);
      lines.push(`ob name ${mdVar} to filename "${pyaEsc(mdPath)}" be write do`);
    }
  }

  const subreportDir = path.join(convertedDir, 'subreports');
  const subreportIndexPath = path.join(convertedDir, 'subreports.index.json');
  lines.push(`be directory ob filename "${pyaEsc(subreportDir)}" do`);
  lines.push(
    `ob text "node ${pyaEsc(path.join(PYASH_ROOT, "command/prepare_agenda_subreports_from_converted.mjs"))} '${pyaEsc(convertedDir)}' '${pyaEsc(subreportDir)}' '${pyaEsc(subreportIndexPath)}' '${pyaEsc(path.join(HOUSE_ROOT, "program/prune-owen-sound-agenda.mjs"))}' '${pyaEsc(agendaHtmlPath)}' '${pyaEsc(String(payload.meeting_url || payload.source_url || ""))}'" be command do`,
  );

  lines.push('');
  const videos = Array.isArray(payload.video) ? payload.video : [];
  const videoPlayers = Array.isArray(payload.video_player) ? payload.video_player : [];
  const videoDirect = Array.isArray(payload.video_direct) ? payload.video_direct : [];
  if (videos.length > 0 || videoPlayers.length > 0 || videoDirect.length > 0) {
    const preferred = (videoPlayers[0] || videos[0] || videoDirect[0] || '').trim();
    const direct = (videoDirect[0] || videos[0] || '').trim();
    if (direct && isDirectAudioUrl(direct)) {
      const ext = extFromMediaUrl(direct) || '.opus';
      const outAudio = path.join(transcriptDir, `meeting-audio${ext}`);
      lines.push(`ob text "node ${pyaEsc(path.join(PYASH_ROOT, "command/resumable_download.mjs"))} '${pyaEsc(direct)}' '${pyaEsc(outAudio)}' 8" be command do`);
    } else if (direct && isDirectVideoUrl(direct)) {
      const ext = extFromMediaUrl(direct) || '.mp4';
      const outVideo = path.join(transcriptDir, `meeting-video${ext}`);
      const outAudio = path.join(transcriptDir, 'meeting-audio.opus');
      lines.push(`ob text "node ${pyaEsc(path.join(PYASH_ROOT, "command/resumable_download.mjs"))} '${pyaEsc(direct)}' '${pyaEsc(outVideo)}' 8" be command do`);
      lines.push(`ob text "ffmpeg -nostdin -y -i '${pyaEsc(outVideo)}' -vn -ac 1 -ar 16000 -c:a libopus '${pyaEsc(outAudio)}'" be command do`);
    } else {
      lines.push(`ob text "node ${pyaEsc(path.join(PYASH_ROOT, "command/disk_housekeeping.mjs"))} --pre-download --required-bytes 0 --mount '${pyaEsc(transcriptDir)}'" be command do`);
      lines.push(`be download ob wo all during month 1 from filename "${pyaEsc(preferred)}" as wo audio to filename "${pyaEsc(transcriptDir)}" do`);
    }
  } else {
    lines.push(`ob text "No video link yet for this meeting. Audio download skipped." to filename "${pyaEsc(path.join(transcriptDir, 'note.txt'))}" be write do`);
  }

  lines.push('');
  lines.push('ob text "meeting workspace prep complete" be write do');
  return `${lines.join('\n')}\n`;
}

function runWithStreaming({ cmd, args, cwd = PYASH_ROOT, env = {}, timeoutMs = 60 * 60 * 1000, label = 'stage' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = String(chunk ?? '');
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk ?? '');
      stderr += text;
      process.stderr.write(text);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, Math.max(10_000, Number(timeoutMs) || 10_000));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${label} failed (code=${code ?? 'null'} signal=${signal ?? ''})\n${stderr || stdout}`.trim()));
    });
  });
}

function loadAllMeetingsFromMonthlyFiles() {
  if (!fs.existsSync(MONTHLY_DIR)) return [];
  const files = fs.readdirSync(MONTHLY_DIR)
    .filter((name) => name.endsWith('.events.series.pya'))
    .map((name) => path.join(MONTHLY_DIR, name))
    .sort();

  const out = [];
  for (const filePath of files) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('su name owen sound council events')) continue;
      if (line === 'prah') continue;
      const row = parseSeriesLine(line);
      if (!row) continue;
      out.push(row);
    }
  }
  return out;
}

async function ensureMonthlyFresh() {
  await runWithStreaming({
    cmd: 'node',
    args: [path.join(HOUSE_ROOT, 'program/extract-owen-sound-calendar-monthly.mjs')],
    cwd: PYASH_ROOT,
    timeoutMs: 5 * 60 * 1000,
    label: 'refresh-monthly',
  });
}

function hasMeetingMediaPayload(payload = {}) {
  const videos = Array.isArray(payload?.video) ? payload.video : [];
  const players = Array.isArray(payload?.video_player) ? payload.video_player : [];
  const direct = Array.isArray(payload?.video_direct) ? payload.video_direct : [];
  const hasAny = [...videos, ...players, ...direct].some((x) => String(x || '').trim().length > 0);
  return hasAny;
}

function hasWorkspacePrepCheckpoint(meetingDir, payload = {}) {
  const sourceDir = path.join(meetingDir, 'source');
  const convertedDir = path.join(meetingDir, 'converted');
  const transcriptDir = path.join(meetingDir, 'transcript');
  const hasSource = fs.existsSync(sourceDir) && fs.readdirSync(sourceDir).some((n) => /\.(pdf|html)$/iu.test(n));
  const hasConverted = fs.existsSync(convertedDir) && fs.readdirSync(convertedDir).some((n) => {
    if (!/\.md$/iu.test(n)) return false;
    try {
      return Number(fs.statSync(path.join(convertedDir, n)).size || 0) > 0;
    } catch {
      return false;
    }
  });
  const hasAgendaHtml = fs.existsSync(sourceDir)
    && fs.readdirSync(sourceDir).some((n) => /^agenda-\d+\.html$/iu.test(n));
  let hasCanonicalAgenda = false;
  if (hasAgendaHtml) {
    try {
      const index = JSON.parse(fs.readFileSync(path.join(convertedDir, 'subreports.index.json'), 'utf8'));
      hasCanonicalAgenda = index?.schema_version === 'canonical_escribe_agenda_v2'
        && Array.isArray(index?.items)
        && index.items.length > 0
        && String(index?.authoritative_source || '').trim().length > 0;
    } catch {
      hasCanonicalAgenda = false;
    }
  }
  const agendaReady = hasAgendaHtml ? hasCanonicalAgenda : hasConverted;
  const hasAudio = fs.existsSync(transcriptDir) && fs.readdirSync(transcriptDir).some((n) => /\.(opus|wav|m4a|mp3)$/iu.test(n));
  const needsAudio = hasMeetingMediaPayload(payload);
  return needsAudio ? (hasSource && agendaReady && hasAudio) : (hasSource && agendaReady);
}

async function main() {
  if (!process.env.PYA_RUNTIME_FILE) process.env.PYA_RUNTIME_FILE = path.join(HOUSE_ROOT, "conduct", "runtime.pya");
  const publishNorm = applyPublishEnvNormalization({
    env: process.env,
    adapter: OWEN_ADAPTER,
    fallbackCommand: '',
  });

  const meetingRef = process.argv[2];
  const basePrefix = sanitizeBasePrefix(process.argv[3] || DEFAULT_BASE_PREFIX, DEFAULT_BASE_PREFIX);
  const focus = process.argv[4] || DEFAULT_FOCUS;
  const jurisdiction = process.argv[5] || DEFAULT_JURISDICTION;
  const bodyArg = process.argv[6] || DEFAULT_BODY;
  const siteUrl = process.argv[7] || DEFAULT_SITE;
  const discussionUrl = process.argv[8] || '';
  const forcePrep = /^(1|true|yes)$/iu.test(String(process.env.OWEN_PREP_FORCE || ''));

  if (!meetingRef) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }
  log(`[meeting-ref] ollama host: ${RESOLVED_OLLAMA_HOST || '(default http://mriczo:11434)'}`);

  fs.mkdirSync(MEETINGS_DIR, { recursive: true });

  const skipRefresh = /^(1|true|yes)$/iu.test(String(process.env.OWEN_SKIP_MONTHLY_REFRESH || '0'));
  if (!skipRefresh) {
    log('[meeting-ref] refreshing Owen Sound monthly calendar cache');
    await ensureMonthlyFresh();
  } else {
    log('[meeting-ref] skip monthly refresh (OWEN_SKIP_MONTHLY_REFRESH=1)');
  }

  const allMeetings = loadAllMeetingsFromMonthlyFiles();
  if (!allMeetings.length) throw new Error('no meetings found in monthly cache');

  const row = findMeetingByRef(allMeetings, meetingRef);
  if (!row) {
    throw new Error(`meeting not found for ref: ${meetingRef}`);
  }

  const payload = { ...(row.payload || {}) };
  const videoResolved = await resolveMeetingVideoUrls(payload.video || []);
  payload.video = videoResolved.all;
  payload.video_direct = videoResolved.direct;
  payload.video_player = videoResolved.player;
  payload.video_resolved_at_utc = new Date().toISOString();
  const body = /^(auto)?$/iu.test(String(bodyArg || '').trim())
    ? inferBodyFromPayload(payload, 'Council Meeting - Regular')
    : bodyArg;

  const day = String(row.since || '').slice(0, 10);
  const id = String(payload.meeting_id || 'unknown-id');
  const folder = `${day}_${slugify(payload.meeting_name)}_${id.slice(0, 8)}`;
  const meetingDir = path.join(MEETINGS_DIR, folder);

  fs.mkdirSync(meetingDir, { recursive: true });
  fs.mkdirSync(path.join(meetingDir, 'source'), { recursive: true });
  fs.mkdirSync(path.join(meetingDir, 'converted'), { recursive: true });
  fs.mkdirSync(path.join(meetingDir, 'report'), { recursive: true });
  fs.mkdirSync(path.join(meetingDir, 'transcript'), { recursive: true });

  fs.writeFileSync(
    path.join(meetingDir, 'meeting.json'),
    `${JSON.stringify({
      su_name: row.suName,
      since: row.since,
      until: row.until,
      payload,
      generated_at_utc: new Date().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  );

  const prepPipelinePath = path.join(meetingDir, 'run-meeting-pipeline.pya');
  fs.writeFileSync(prepPipelinePath, buildPipeline(meetingDir, { ...row, payload }), 'utf8');

  log(`[meeting-ref] workspace: ${meetingDir}`);
  if (forcePrep || !hasWorkspacePrepCheckpoint(meetingDir, payload)) {
    log('[meeting-ref] downloading agenda/minutes/audio');
    await runWithStreaming({
      cmd: 'node',
      args: [path.join(PYASH_ROOT, 'command/run_pya_program.mjs'), prepPipelinePath],
      // Keep prep run artifacts under house-local ./artifacts instead of global pyash/artifacts.
      cwd: HOUSE_ROOT,
      timeoutMs: 6 * 60 * 60 * 1000,
      label: 'prep-workspace',
    });
  } else {
    log('[meeting-ref] skip prep-workspace (checkpoint exists)');
  }

  const transcriptDir = path.join(meetingDir, 'transcript');
  if (!hasTranscriptAudio(transcriptDir)) {
    await writeAgendaPreviewArtifacts({
      meetingDir,
      row,
      payload,
      focus,
      jurisdiction,
      body,
      siteUrl,
      discussionUrl,
      basePrefix,
      publishNorm,
    });
    log(`[meeting-ref] done`);
    log(`[meeting-ref] meeting_dir: ${meetingDir}`);
    log(`[meeting-ref] transcript_dir: ${transcriptDir}`);
    return;
  }

  log('[meeting-ref] running full transcript pipeline');
  await runWithStreaming({
    cmd: 'node',
    args: [
      path.join(HOUSE_ROOT, 'program/run-full-transcript-pipeline-from-meeting-folder.mjs'),
      meetingDir,
      basePrefix,
      focus,
      jurisdiction,
      body,
      siteUrl,
      discussionUrl,
    ],
    cwd: PYASH_ROOT,
    env: {
      ...publishNorm.env,
      PYA_COMMAND_TIMEOUT_MS: process.env.PYA_COMMAND_TIMEOUT_MS || '28800000',
      PYA_SPEAKER_HOST: process.env.PYA_SPEAKER_HOST || RESOLVED_SPEAKER_HOST || '',
      PYA_SPEAKER_HOST_ROOT: process.env.PYA_SPEAKER_HOST_ROOT || RESOLVED_SPEAKER_HOST_ROOT || '/workplace',
      OWEN_PIPELINE_SKIP_IMAGE: process.env.OWEN_PIPELINE_SKIP_IMAGE || '0',
      OWEN_PIPELINE_SKIP_LEMMY: process.env.OWEN_PIPELINE_SKIP_LEMMY || '0',
      OWEN_PIPELINE_FORCE: process.env.OWEN_PIPELINE_FORCE || '0',
      OWEN_LEMMY_POST_COMMAND: process.env.OWEN_LEMMY_POST_COMMAND || '',
    },
    timeoutMs: 8 * 60 * 60 * 1000,
    label: 'full-pipeline',
  });
  const payloadPath = path.join(transcriptDir, `${basePrefix}-normalized.lemmy-post.json`);
  log(`[meeting-ref] done`);
  log(`[meeting-ref] meeting_dir: ${meetingDir}`);
  log(`[meeting-ref] transcript_dir: ${transcriptDir}`);
  if (fs.existsSync(payloadPath)) {
    log(`[meeting-ref] payload: ${payloadPath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
    process.exit(1);
  });
}
