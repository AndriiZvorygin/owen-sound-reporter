#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { normalizePublishConfig } from '../../../../program/publisher-interface.mjs';
import { savePyaReportArtifact } from '../../../../program/library/reporter_shared/artifact-contracts.mjs';
import { verifyArticleClaims } from '../../../../program/library/reporter_shared/quality-verifiers.mjs';
import { sanitizeBasePrefix, deriveNormalizedPrefix } from '../../../../program/library/reporter_shared/prefix-normalization.mjs';
import { generateTranscriptHeadingFromEvidence, buildOneSentenceFromHeading } from '../../../../program/library/reporter_shared/transcript-heading-generator.mjs';
import {
  agendaRoleConstraint,
  splitCivicSentences,
  unsupportedAgendaRoles,
  unsupportedCivicOutcomeVerbs,
} from '../../../../program/library/reporter_shared/civic-sentence-boundaries.mjs';
import { auditRenderedContent } from '../../../../program/library/reporter_shared/content-source-audit.mjs';
import {
  articleClaimsVerificationNeedsRetry,
  buildArticleVerificationRetryFeedback,
} from '../../../../program/library/reporter_shared/article-verification-checkpoint.mjs';
import { readPyaMapArtifact } from '../../../../program/library/reporter_shared/agenda-stage-contracts.mjs';
import { requestOllamaChat } from '../../../../program/library/reporter_shared/whole-meeting-synthesis.mjs';
import { buildCanonicalAgendaEvidence } from '../../../../program/library/reporter_shared/escribe-agenda-identity.mjs';
import { canonicalMeetingRouteSlug } from '../../../../program/library/reporter_shared/meeting-route.mjs';
import { OWEN_ADAPTER } from './writer-adapter-owen-sound.mjs';
import { DEFAULT_SUMMARY_FOCUS } from './defaults.mjs';
import { readPyaTextValues } from '../../../../command/pya_lookup.mjs';
import { resolveGpuHousekeeperUrl } from '../../../../program/runtime/gpu/managed-ollama.mjs';
import {
  buildSentenceDiarizationEnv,
  namedSpeakerIdentityEnabled,
  speakerArtifactUsesDefaultLabels,
} from '../../../../program/library/reporter_shared/speaker-diarization-policy.mjs';

const ROOT = '/home/htaf/pyac/pyash';
const HOUSE = path.join(ROOT, 'world/house/owen-sound-reporter');
const GLOBAL_DEFAULTS_PATH = path.join(ROOT, 'configure/default.pya');
const HOUSE_SECRET_PATH = path.join(HOUSE, 'configure/secret.pya');
const RUN_BIN = path.join(ROOT, 'run');
const DEFAULT_SITE = 'https://helpos.ca';
const DEFAULT_FOCUS = DEFAULT_SUMMARY_FOCUS;
const DEFAULT_STYLE = 'bold civic poster background, no person required, high contrast, simple geometry, strong readability';
const HARD_DEFAULT_SPEAKER_HOST = 'http://mriczo:8010';
const HARD_DEFAULT_SPEAKER_HOST_ROOT = '/workplace';
const MEETING_TEASER_MAX_WORDS = 72;
const HOUSE_SECRET_VALUES = readPyaTextValues(HOUSE_SECRET_PATH, ['speaker host', 'speaker host root']);
const GLOBAL_DEFAULT_VALUES = readPyaTextValues(GLOBAL_DEFAULTS_PATH, ['speaker host', 'speaker host root']);

function usage() {
  return [
    'Usage: node program/run-full-transcript-pipeline.mjs <transcript_dir> [base_prefix] [focus] [jurisdiction] [body] [site_url] [discussion_url]',
    'Example: node ... artifacts/owen-sound/meetings/<meeting>/transcript meeting-qwen-auto "clear, neutral reporting of consequential decisions and public concerns" "Owen Sound" "Council" "https://helpos.ca" "https://helpos.ca/post/..."',
  ].join('\n');
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function ensureDir(dirPath) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`directory not found: ${dirPath}`);
}

function existsFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function existsDir(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function ensureWritableDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const probe = path.join(
    dirPath,
    `.write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  fs.writeFileSync(probe, 'ok', 'utf8');
  fs.unlinkSync(probe);
}

function fileMtimeMs(filePath) {
  try {
    return Number(fs.statSync(filePath).mtimeMs || 0);
  } catch {
    return 0;
  }
}

function countSrtCues(filePath) {
  if (!existsFile(filePath)) return 0;
  const text = safeReadText(filePath, '');
  const m = String(text).match(/^\d\d:\d\d:\d\d,\d\d\d\s+-->\s+\d\d:\d\d:\d\d,\d\d\d$/gmu);
  return Array.isArray(m) ? m.length : 0;
}

function parseSrtCuesWithText(filePath) {
  if (!existsFile(filePath)) return [];
  const text = safeReadText(filePath, "");
  const blocks = String(text).split(/\r?\n\s*\r?\n/gu);
  const rows = [];
  for (const block of blocks) {
    const lines = String(block || "").split(/\r?\n/gu);
    const timeIndex = lines.findIndex((line) => /^\d\d:\d\d:\d\d,\d\d\d\s+-->\s+\d\d:\d\d:\d\d,\d\d\d$/u.test(line.trim()));
    if (timeIndex < 0) continue;
    const m = lines[timeIndex].trim().match(/^(\d\d:\d\d:\d\d,\d\d\d)\s+-->\s+(\d\d:\d\d:\d\d,\d\d\d)$/u);
    if (!m) continue;
    const cueText = lines.slice(timeIndex + 1).join(" ").replace(/\s+/gu, " ").trim();
    rows.push({
      start: m[1],
      end: m[2],
      startMs: srtTimestampToMs(m[1]),
      endMs: srtTimestampToMs(m[2]),
      text: cueText,
    });
  }
  return rows;
}

function cueWords(text = "") {
  return String(text || "")
    .replace(/\bSPEAKER_[0-9A-Z]+:\s*/gu, " ")
    .split(/[^A-Za-z0-9']+/u)
    .map((w) => w.trim())
    .filter(Boolean);
}

function sentenceCueQuality(filePath) {
  const cues = parseSrtCuesWithText(filePath);
  if (!cues.length) return { ok: false, reason: "missing_cues", cueCount: 0 };
  const continuationLast = new Set([
    "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "can", "could",
    "do", "does", "did", "for", "from", "had", "has", "have", "if", "in", "is", "it",
    "may", "might", "not", "of", "on", "or", "our", "that", "the", "their", "these",
    "this", "those", "to", "was", "we", "were", "will", "with", "would", "you", "your",
  ]);
  let wordTotal = 0;
  let punctuationEnd = 0;
  let fragmentLike = 0;
  const wordCounts = [];
  for (const cue of cues) {
    const text = String(cue.text || "").replace(/\bSPEAKER_[0-9A-Z]+:\s*/gu, "").trim();
    const words = cueWords(text);
    const wc = words.length;
    wordTotal += wc;
    wordCounts.push(wc);
    const endsSentence = /[.!?]["')\]]?$/u.test(text);
    if (endsSentence) punctuationEnd += 1;
    const last = String(words[words.length - 1] || "").toLowerCase();
    if (
      wc >= 3
      && !endsSentence
      && (
        wc <= 8
        || continuationLast.has(last)
        || /[,;:]\s*$/u.test(text)
      )
    ) {
      fragmentLike += 1;
    }
  }
  wordCounts.sort((a, b) => a - b);
  const cueCount = cues.length;
  const avgWords = wordTotal / Math.max(1, cueCount);
  const medianWords = wordCounts[Math.floor(wordCounts.length / 2)] || 0;
  const punctuationRatio = punctuationEnd / Math.max(1, cueCount);
  const fragmentRatio = fragmentLike / Math.max(1, cueCount);
  const ok = cueCount < 40
    || (
      fragmentRatio <= 0.38
      && !(avgWords < 7.5 && punctuationRatio < 0.35)
      && !(medianWords < 6 && punctuationRatio < 0.30)
    );
  return { ok, reason: ok ? "" : "fragment_shaped_sentence_cues", cueCount, avgWords, medianWords, punctuationRatio, fragmentRatio };
}

function requireSentenceCueQuality(filePath, label) {
  const q = sentenceCueQuality(filePath);
  if (q.ok) return q;
  throw new Error(
    `[sentence-contract] ${label} is not sentence-cue shaped: reason=${q.reason} cues=${q.cueCount} avg_words=${Number(q.avgWords || 0).toFixed(2)} median_words=${Number(q.medianWords || 0).toFixed(2)} punctuation_ratio=${Number(q.punctuationRatio || 0).toFixed(3)} fragment_ratio=${Number(q.fragmentRatio || 0).toFixed(3)} file=${filePath}`,
  );
}

function readAlignmentReport(filePath) {
  const reportPath = String(filePath || "").replace(/(?:\.srt)?$/iu, ".alignment-report.json");
  return safeReadJson(reportPath, null);
}

function alignmentReportPath(filePath) {
  return String(filePath || "").replace(/(?:\.srt)?$/iu, ".alignment-report.json");
}

function removeFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function countSpeakerRowsJson(filePath) {
  if (!existsFile(filePath)) return 0;
  const obj = safeReadJson(filePath, {});
  const rows = Array.isArray(obj?.rows) ? obj.rows.length : 0;
  return Number.isFinite(rows) ? rows : 0;
}

function parseSrtCueRows(filePath) {
  if (!existsFile(filePath)) return [];
  const text = safeReadText(filePath, "");
  const lines = String(text).split(/\r?\n/gu);
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^(\d\d:\d\d:\d\d,\d\d\d)\s+-->\s+(\d\d:\d\d:\d\d,\d\d\d)$/u);
    if (!m) continue;
    rows.push({ start: m[1], end: m[2], startMs: srtTimestampToMs(m[1]), endMs: srtTimestampToMs(m[2]) });
  }
  return rows;
}

function srtTimestampToMs(ts) {
  const m = String(ts || "").match(/^(\d\d):(\d\d):(\d\d),(\d\d\d)$/u);
  if (!m) return Number.NaN;
  return (((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000) + Number(m[4]);
}

function summarizeCueTimeline(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let prevEnd = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const cue = rows[i] || {};
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)) {
      throw new Error(`[timing-contract] malformed cue timestamp at cue=${i + 1}`);
    }
    if (cue.endMs <= cue.startMs) {
      throw new Error(`[timing-contract] invalid cue bounds at cue=${i + 1}: ${cue.start} --> ${cue.end}`);
    }
    if (cue.startMs < prevEnd) {
      throw new Error(`[timing-contract] non-monotonic/overlap at cue=${i + 1}: ${cue.start} starts before previous end`);
    }
    prevEnd = cue.endMs;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    start: first.start,
    end: last.end,
    startMs: first.startMs,
    endMs: last.endMs,
    durationMs: Math.max(0, last.endMs - first.startMs),
  };
}

function findFirstDivergentCue(expected, actual, toleranceMs = 25) {
  const max = Math.min(expected.length, actual.length);
  for (let i = 0; i < max; i += 1) {
    const e = expected[i];
    const a = actual[i];
    if (Math.abs(e.startMs - a.startMs) > toleranceMs || Math.abs(e.endMs - a.endMs) > toleranceMs) {
      return {
        index: i + 1,
        expected: `${e.start} --> ${e.end}`,
        actual: `${a.start} --> ${a.end}`,
      };
    }
  }
  return null;
}

function assertCueTimelineMatch(expectedFile, actualFile, label, opts = {}) {
  const requireEqualCueCount = opts.requireEqualCueCount !== false;
  const startToleranceMs = Math.max(0, Number(opts.startToleranceMs ?? 1500));
  const endToleranceMs = Math.max(0, Number(opts.endToleranceMs ?? 1500));
  const cueToleranceMs = Math.max(0, Number(opts.cueToleranceMs ?? 25));
  const expected = parseSrtCueRows(expectedFile);
  const actual = parseSrtCueRows(actualFile);
  if (!expected.length) {
    throw new Error(`[timing-contract] expected cues missing: ${expectedFile}`);
  }
  if (!actual.length) {
    throw new Error(`[timing-contract] actual cues missing: ${actualFile}`);
  }
  const expectedTimeline = summarizeCueTimeline(expected);
  const actualTimeline = summarizeCueTimeline(actual);
  const startDeltaMs = Math.abs(expectedTimeline.startMs - actualTimeline.startMs);
  const endDeltaMs = Math.abs(expectedTimeline.endMs - actualTimeline.endMs);
  const durationDeltaMs = Math.abs(expectedTimeline.durationMs - actualTimeline.durationMs);
  const maxDurationDeltaMs = Math.max(
    2000,
    Math.round(expectedTimeline.durationMs * 0.05),
    Math.round(Number(opts.maxDurationDeltaMs ?? 0)),
  );

  if (requireEqualCueCount) {
    if (expected.length !== actual.length) {
      throw new Error(
        `[timing-contract] ${label} cue-count mismatch: expected=${expected.length} actual=${actual.length} expected_file=${expectedFile} actual_file=${actualFile}`,
      );
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (
        Math.abs(expected[i].startMs - actual[i].startMs) > cueToleranceMs ||
        Math.abs(expected[i].endMs - actual[i].endMs) > cueToleranceMs
      ) {
        throw new Error(
          `[timing-contract] ${label} cue-${i + 1} mismatch: expected=${expected[i].start} --> ${expected[i].end} actual=${actual[i].start} --> ${actual[i].end} expected_file=${expectedFile} actual_file=${actualFile}`,
        );
      }
    }
    return { ok: true, warning: null };
  }

  if (startDeltaMs > startToleranceMs || endDeltaMs > endToleranceMs || durationDeltaMs > maxDurationDeltaMs) {
    const divergent = findFirstDivergentCue(expected, actual, cueToleranceMs);
    const divergentText = divergent
      ? ` first_divergent_cue=${divergent.index} expected=${divergent.expected} actual=${divergent.actual}`
      : "";
    throw new Error(
      `[timing-contract] ${label} timeline mismatch: expected_count=${expected.length} actual_count=${actual.length} expected_start=${expectedTimeline.start} actual_start=${actualTimeline.start} expected_end=${expectedTimeline.end} actual_end=${actualTimeline.end} start_delta_ms=${startDeltaMs} end_delta_ms=${endDeltaMs} duration_delta_ms=${durationDeltaMs} expected_file=${expectedFile} actual_file=${actualFile}${divergentText}`,
    );
  }

  if (expected.length !== actual.length) {
    const msg = `${label} cue-count differs but timeline coverage matches: expected=${expected.length} actual=${actual.length} expected_start=${expectedTimeline.start} actual_start=${actualTimeline.start} expected_end=${expectedTimeline.end} actual_end=${actualTimeline.end} duration_delta_ms=${durationDeltaMs} expected_file=${expectedFile} actual_file=${actualFile}`;
    return { ok: true, warning: msg };
  }

  return { ok: true, warning: null };
}
function cueTimelineMatches(expectedFile, actualFile, label, opts = {}) {
  try {
    assertCueTimelineMatch(expectedFile, actualFile, label, opts);
    return true;
  } catch (err) {
    log(String(err?.message || err));
    return false;
  }
}

async function assertCanonicalSentenceTimingFromWordCues({
  transcriptDir,
  sentencePlain,
  baseTimingSrt,
  canonicalSentenceSrt,
  driftSeconds = 1.5,
}) {
  const probePath = path.join(
    transcriptDir,
    `.timing-contract-${process.pid}-${Date.now()}.probe.srt`,
  );
  try {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(ROOT, 'command/lyrics_to_srt_from_timing.mjs'),
        sentencePlain,
        baseTimingSrt,
        probePath,
        '--sentence-cues',
      ],
      cwd: ROOT,
      env: {
        PYA_SRT_MAX_DRIFT_SECONDS: String(driftSeconds),
      },
      timeoutMs: 20 * 60 * 1000,
      label: 'timing-contract-canonical-from-word-cues',
    });
    assertCueTimelineMatch(probePath, canonicalSentenceSrt, 'canonical-vs-word-cues');
  } finally {
    try { fs.unlinkSync(probePath); } catch {}
  }
}

function resolveReporterPath(inputPath) {
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
  const fromCwd = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(HOUSE, inputPath);
}

function runWithStreaming({ cmd, args, cwd = ROOT, env = {}, timeoutMs = 30 * 60 * 1000, label = 'stage' }) {
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
      const msg = `${label} failed (code=${code ?? 'null'} signal=${signal ?? ''})`;
      reject(new Error(`${msg}\n${stderr || stdout}`.trim()));
    });
  });
}

function ffprobeDurationSeconds(audioPath) {
  return new Promise((resolve) => {
    if (!existsFile(audioPath)) return resolve(0);
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
      const n = Number(String(out || '').trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
  });
}

function scaleTimeout(baseMs, audioSeconds, slopePerHour = 0.8) {
  const hours = Math.max(0, Number(audioSeconds) || 0) / 3600;
  const factor = 1 + (hours * slopePerHour);
  return Math.round(baseMs * Math.max(1, factor));
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'unknown';
}

function deriveDateLongFromMeetingDir(meetingDirName) {
  const m = String(meetingDirName || '').match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!m) return { iso: '', long: 'Unknown date' };
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const dt = new Date(`${iso}T12:00:00Z`);
  return {
    iso,
    long: dt.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
  };
}

function sanitizeStem(input) {
  const base = path.basename(String(input || ''), path.extname(String(input || '')));
  let out = base.replace(/[^A-Za-z0-9_-]/gu, '_').replace(/_+/gu, '_').replace(/^_+|_+$/gu, '');
  if (!out) out = 'output';
  return out.slice(0, 96);
}

function parseGeneratedImagePath(drawStdout, sourceFilename) {
  const text = String(drawStdout || '');
  const matches = [...text.matchAll(/\/home\/htaf\/pyac\/pyash\/(?:artifacts)\/[^\s"']+\.png/gu)].map((m) => m[0]);
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (existsFile(matches[i])) return matches[i];
  }
  return '';
}

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function parsePyaJsonTextField(filePath, fieldName) {
  const values = readPyaTextValues(filePath, [fieldName]);
  const raw = String(values[fieldName] || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readPyaNumberField(filePath, fieldName) {
  const values = readPyaTextValues(filePath, [fieldName]);
  return Number(values[fieldName] || 0);
}

function safeReadText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function resolveSpeakerHost() {
  const fromEnv = String(process.env.PYA_SPEAKER_HOST || process.env.SPEAKER_HOST || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/u, '');
  const fromSecret = String(HOUSE_SECRET_VALUES['speaker host'] || '').trim();
  if (fromSecret) return fromSecret.replace(/\/$/u, '');
  const fromGlobal = String(GLOBAL_DEFAULT_VALUES['speaker host'] || '').trim();
  if (fromGlobal) return fromGlobal.replace(/\/$/u, '');
  return HARD_DEFAULT_SPEAKER_HOST;
}

function resolveSpeakerHostRoot() {
  const fromEnv = String(process.env.PYA_SPEAKER_HOST_ROOT || '').trim();
  if (fromEnv) return fromEnv;
  const fromSecret = String(HOUSE_SECRET_VALUES['speaker host root'] || '').trim();
  if (fromSecret) return fromSecret;
  const fromGlobal = String(GLOBAL_DEFAULT_VALUES['speaker host root'] || '').trim();
  if (fromGlobal) return fromGlobal;
  return HARD_DEFAULT_SPEAKER_HOST_ROOT;
}

function extractMarkdownSection(mdText, headingText) {
  const lines = String(mdText || '').split(/\r?\n/u);
  const target = String(headingText || '').trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^#{1,2}\s+(.+?)\s*$/u);
    if (!m) continue;
    if (m[1].trim().toLowerCase() === target) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^#{1,2}\s+/u.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}


function replaceMarkdownSection(mdText, headingText, replacementText) {
  const lines = String(mdText || "").split(/\r?\n/u);
  const target = String(headingText || "").trim().toLowerCase();
  let startLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^#{1,2}\s+(.+?)\s*$/u);
    if (!m) continue;
    if (m[1].trim().toLowerCase() === target) {
      startLine = i + 1;
      break;
    }
  }
  if (startLine < 0) return mdText;
  let endLine = lines.length;
  for (let i = startLine; i < lines.length; i += 1) {
    if (/^#{1,2}\s+/u.test(lines[i])) {
      endLine = i;
      break;
    }
  }
  const before = lines.slice(0, startLine);
  const after = lines.slice(endLine);
  const mid = String(replacementText || "").split(/\r?\n/u);
  return [...before, ...mid, ...after].join("\n").replace(/\n{3,}/gu, "\n\n");
}

function upsertMarkdownSectionBefore(mdText, headingText, replacementText, beforeHeadingText = "Meeting Recap") {
  const src = String(mdText || "");
  if (extractMarkdownSection(src, headingText)) {
    return replaceMarkdownSection(src, headingText, replacementText);
  }
  const lines = src.split(/\r?\n/u);
  const beforeTarget = String(beforeHeadingText || "").trim().toLowerCase();
  let insertAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^#{1,2}\s+(.+?)\s*$/u);
    if (m && m[1].trim().toLowerCase() === beforeTarget) {
      insertAt = i;
      break;
    }
  }
  const sectionLines = [`## ${headingText}`, ...String(replacementText || "").split(/\r?\n/u), ""];
  if (insertAt >= 0) {
    return [...lines.slice(0, insertAt), ...sectionLines, ...lines.slice(insertAt)].join("\n").replace(/\n{3,}/gu, "\n\n");
  }
  return `${src.trim()}\n\n${sectionLines.join("\n")}`.replace(/\n{3,}/gu, "\n\n").trim();
}

function removeMarkdownSection(mdText, headingText) {
  return String(replaceMarkdownSection(mdText, headingText, "") || "").replace(/\n{3,}/gu, "\n\n").trim();
}

function normalizeTopNewsMarkdown(blockText) {
  const src = String(blockText || "").trim();
  if (!src) return "";
  const bulletMatches = Array.from(src.matchAll(/-\s+\*\*([^*]+):\*\*\s+([\s\S]*?)(?=(?:\n|\s)-\s+\*\*[^*]+:\*\*\s+|$)/gu));
  if (bulletMatches.length > 0) {
    const items = bulletMatches
      .map((m) => {
        const title = String(m[1] || "").replace(/[.:\-]+$/u, "").trim();
        const body = String(m[2] || "").replace(/\s+/gu, " ").trim();
        if (!title || !body) return "";
        return `- **${title}:** ${body}`;
      })
      .filter(Boolean);
    if (items.length > 0) return items.join("\n");
  }
  const lines = src.split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  const alreadyBullets = lines.filter((l) => /^-\s+\*\*[^*]+:\*\*\s+.+/u.test(l));
  if (alreadyBullets.length > 0 && alreadyBullets.length === lines.length) {
    return alreadyBullets.join("\n");
  }
  const compact = src.replace(/\r?\n+/gu, " ").replace(/\s+/gu, " ").trim();
  const chunks = compact.split(/(?=\*\*[^*]+\*\*)/u).map((x) => x.trim()).filter(Boolean);
  const items = [];
  for (const c of chunks) {
    const m = c.match(/^\*\*([^*]+)\*\*\s*:?\s*[\s\-]*([\s\S]*)$/u);
    if (!m) continue;
    const title = String(m[1] || "").replace(/[.:\-]+$/u, "").trim();
    const body = String(m[2] || "").replace(/^[-*]\s*/u, "").trim();
    if (!title || !body) continue;
    items.push(`- **${title}:** ${body}`);
  }
  return items.join("\n");
}

function validateTopNewsMarkdown(blockText, { minBullets = 3, maxBullets = 6 } = {}) {
  const lines = String(blockText || "").split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^-\s+\*\*[^*]+:\*\*\s+.+/u.test(l));
  return {
    ok: bullets.length >= minBullets && bullets.length <= maxBullets && bullets.length === lines.length,
    count: bullets.length,
    lines,
  };
}


function buildFallbackTopNewsFromAgendaSummary(agendaSummaryPyaPath, agendaSectionGroundingPyaPath = "", minSelected = 3) {
  const ranked = buildRankedTopNewsFromAgenda(agendaSummaryPyaPath, agendaSectionGroundingPyaPath);
  if (Array.isArray(ranked.selected) && ranked.selected.length >= Math.max(1, Number(minSelected || 1))) {
    return ranked.markdown;
  }
  return "";
}

function buildRankedTopNewsFromTranscriptSummary(summaryMdText) {
  const text = String(summaryMdText || '');
  const m = text.match(/##\s*(?:Most Newsworthy Items|Top Newsworthy Developments)\s*([\s\S]*?)(?:\n##\s+|$)/iu);
  const block = m ? String(m[1] || '') : '';
  const rows = [];
  let i = 0;
  const bulletRx = /^\s*[*-]\s+\*\*([^*]+)\*\*:\s*(.+)$/gmu;
  let match;
  while ((match = bulletRx.exec(block)) !== null) {
    i += 1;
    const title = String(match[1] || '').replace(/\s+/gu, ' ').trim();
    const body = neutralizeAttribution(String(match[2] || '').replace(/\s+/gu, ' ').trim());
    if (!title || !body) continue;
    rows.push({
      id: `news_${String(i).padStart(3, '0')}`,
      unitId: `summary_${String(i).padStart(3, '0')}`,
      heading: title,
      summary: body,
      body,
      title: normalizeNewsTitle(title, body, title, body),
      excluded: false,
      score: scoreNewsSection({ heading: title, summary: body, excerpt: body }),
      candidateKind: 'transcript_summary',
    });
  }
  if (!rows.length) {
    // Support markdown style:
    // **Title**
    // Paragraph...
    const headingParagraphRx = /^\s*\*\*([^*]+)\*\*\s*\n+([\s\S]*?)(?=\n\s*\*\*[^*]+\*\*\s*\n|\n##\s+|$)/gmu;
    let hpMatch;
    while ((hpMatch = headingParagraphRx.exec(block)) !== null) {
      i += 1;
      const title = String(hpMatch[1] || '').replace(/\s+/gu, ' ').trim();
      const para = String(hpMatch[2] || '').replace(/\s+/gu, ' ').trim();
      const first = String(para.split(/(?<=[.!?])\s+/u)[0] || para).trim();
      const body = neutralizeAttribution(first);
      if (!title || !body) continue;
      rows.push({
        id: `news_${String(i).padStart(3, '0')}`,
        unitId: `summary_${String(i).padStart(3, '0')}`,
        heading: title,
        summary: body,
        body,
        title: normalizeNewsTitle(title, body, title, body),
        excluded: false,
        score: scoreNewsSection({ heading: title, summary: body, excerpt: para }),
        candidateKind: 'transcript_summary',
      });
    }
  }
  if (!rows.length) {
    const paragraphs = block
      .split(/\n\s*\n/gu)
      .map((p) => String(p || '').replace(/\s+/gu, ' ').trim())
      .filter((p) => p.length > 40);
    for (const p of paragraphs) {
      i += 1;
      const first = String(p.split(/(?<=[.!?])\s+/u)[0] || p).trim();
      const title = deriveTopNewsTitleFromSummary(first, `Section ${i}`);
      const body = neutralizeAttribution(first);
      if (!title || !body) continue;
      rows.push({
        id: `news_${String(i).padStart(3, '0')}`,
        unitId: `summary_${String(i).padStart(3, '0')}`,
        heading: title,
        summary: body,
        body,
        title: normalizeNewsTitle(title, body, title, body),
        excluded: false,
        score: scoreNewsSection({ heading: title, summary: body, excerpt: p }),
        candidateKind: 'transcript_summary',
      });
    }
  }
  let selected = rows
    .filter((r) => !r.excluded && Number(r.score || 0) > 0 && !isGenericNewsTitle(r.title))
    .sort((a, b) => {
      const ai = humanImpactSignalScore(a);
      const bi = humanImpactSignalScore(b);
      if (bi !== ai) return bi - ai;
      const aFood = /\b(food insecurity|food security|hunger|good food box)\b/iu.test(`${String(a?.title || "")} ${String(a?.body || "")}`) ? 1 : 0;
      const bFood = /\b(food insecurity|food security|hunger|good food box)\b/iu.test(`${String(b?.title || "")} ${String(b?.body || "")}`) ? 1 : 0;
      if (aFood !== bFood) return bFood - aFood;
      return Number(b.score || 0) - Number(a.score || 0);
    })
    .slice(0, 4);
  if (!selected.length) {
    selected = rows
      .filter((r) => !r.excluded && !isGenericNewsTitle(r.title))
      .sort((a, b) => {
        const ai = humanImpactSignalScore(a);
        const bi = humanImpactSignalScore(b);
        if (bi !== ai) return bi - ai;
        return Number(b.score || 0) - Number(a.score || 0);
      })
      .slice(0, 3);
  }
  const markdown = selected.map((r) => `- **${r.title}:** ${r.body}`).join('\n');
  return { rows, selected, markdown, sourceHeading: m ? 'matched' : 'missing' };
}

function writeTopNewsSelectionDebugPya(pathname, payload) {
  const p = payload || {};
  const lines = [];
  lines.push(`exists su name meeting ref ob text "${JSON.stringify(String(p.meetingRef || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name source artifact ob text "${JSON.stringify(String(p.sourceArtifact || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name source heading match ob text "${JSON.stringify(String(p.sourceHeading || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name raw candidate count ob number ${Number(p.rawCandidateCount || 0)} ya`);
  lines.push(`exists su name selected candidate count ob number ${Number(p.selectedCandidateCount || 0)} ya`);
  lines.push(`exists su name lead candidate id ob text "${JSON.stringify(String(p.lead_candidate_id || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name title source candidate id ob text "${JSON.stringify(String(p.title_source_candidate_id || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name hook source candidate id ob text "${JSON.stringify(String(p.hook_source_candidate_id || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name one sentence source candidate id ob text "${JSON.stringify(String(p.one_sentence_source_candidate_id || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name first top news candidate id ob text "${JSON.stringify(String(p.first_top_news_candidate_id || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name title generation method ob text "${JSON.stringify(String(p.title_generation_method || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name hook generation method ob text "${JSON.stringify(String(p.hook_generation_method || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name one sentence generation method ob text "${JSON.stringify(String(p.one_sentence_generation_method || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name candidates ob text "${JSON.stringify(JSON.stringify(p.candidates || [])).slice(1, -1)}" ya`);
  fs.writeFileSync(pathname, lines.join('\n') + '\n');
}

function writePublishEvidenceValidationPya(pathname, report) {
  const r = report || {};
  const lines = [];
  lines.push(`exists su name meeting ref ob text "${JSON.stringify(String(r.meetingRef || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name transcript source file ob text "${JSON.stringify(String(r.transcriptSourceFile || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name payload file ob text "${JSON.stringify(String(r.payloadFile || '')).slice(1, -1)}" ya`);
  lines.push(`exists su name decision ob text "${JSON.stringify(String(r.decision || 'BLOCK')).slice(1, -1)}" ya`);
  lines.push(`exists su name reasons ob text "${JSON.stringify(JSON.stringify(r.reasons || [])).slice(1, -1)}" ya`);
  lines.push(`exists su name forbidden term checks ob text "${JSON.stringify(JSON.stringify(r.forbiddenChecks || [])).slice(1, -1)}" ya`);
  lines.push(`exists su name field checks ob text "${JSON.stringify(JSON.stringify(r.fieldChecks || [])).slice(1, -1)}" ya`);
  lines.push(`exists su name top news checks ob text "${JSON.stringify(JSON.stringify(r.topNewsChecks || [])).slice(1, -1)}" ya`);
  fs.writeFileSync(pathname, lines.join('\n') + '\n');
}

function sha256Text(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function writeContentSourceAuditPya(pathname, report) {
  const r = report || {};
  const lines = [];
  lines.push(`exists su name meeting ref ob text "${JSON.stringify(String(r.meetingRef || "")).slice(1, -1)}" ya`);
  lines.push(`exists su name decision ob text "${JSON.stringify(String(r.decision || "BLOCK")).slice(1, -1)}" ya`);
  lines.push(`exists su name reasons ob text "${JSON.stringify(JSON.stringify(r.reasons || [])).slice(1, -1)}" ya`);
  lines.push(`exists su name fallback count total ob number ${Number(r.fallbackCountTotal || 0)} ya`);
  lines.push(`exists su name content fallback count ob number ${Number(r.contentFallbackCount || 0)} ya`);
  lines.push(`exists su name structural fallback count ob number ${Number(r.structuralFallbackCount || 0)} ya`);
  lines.push(`exists su name omitted optional sections ob text "${JSON.stringify(JSON.stringify(r.omittedOptionalSections || [])).slice(1, -1)}" ya`);
  lines.push(`exists su name rendered fields ob text "${JSON.stringify(JSON.stringify(r.renderedFields || [])).slice(1, -1)}" ya`);
  fs.writeFileSync(pathname, lines.join("\n") + "\n");
}

function inferClaimRole(text = "") {
  const t = String(text || "").toLowerCase();
  if (/\b(voted|approved|adopted|carried|defeated|rejected|deferred|amend(ed|ment))\b/u.test(t)) return "council_decision";
  if (/\b(report|city manager|staff)\b/u.test(t)) return "staff_report";
  if (/\b(public forum|resident|speaker|comment)\b/u.test(t)) return "public_forum_comment";
  if (/\b(deputation|presentation)\b/u.test(t)) return "delegation";
  if (/\b(correspondence)\b/u.test(t)) return "correspondence";
  if (/\b(call to order|adjourn|minutes|procedural)\b/u.test(t)) return "procedural";
  return "unknown";
}

function extractTopNewsBullets(markdown) {
  const block = extractMarkdownSection(markdown, 'Most Newsworthy Items') || extractMarkdownSection(markdown, 'Top Newsworthy Developments');
  const out = [];
  const lines = String(block || '').split(/\r?\n/u);
  for (const line of lines) {
    const m = line.match(/^\s*-\s+\*\*([^*]+):\*\*\s+(.+)$/u);
    if (!m) continue;
    out.push({ title: String(m[1] || '').trim(), body: String(m[2] || '').trim() });
  }
  return out;
}


function readGroundingUnitsMap(agendaSectionGroundingPyaPath) {
  const out = new Map();
  try {
    const txt = fs.readFileSync(agendaSectionGroundingPyaPath, 'utf8');
    const m = txt.match(/exists su name grounded units ob text "([\s\S]*)" ya\n?pra?h?$/m);
    if (!m) return out;
    const units = JSON.parse(JSON.parse('"' + m[1] + '"'));
    for (const u of (Array.isArray(units) ? units : [])) {
      const id = String(u['unit id'] || '');
      if (!id) continue;
      out.set(id, {
        boundarySource: String(u['boundary source'] || ''),
        evidence: String(u['boundary evidence strength'] || ''),
        excerpt: String(u['source excerpt'] || ''),
        rowStart: Number(u['row start'] || 0),
        rowEnd: Number(u['row end'] || 0),
        since: Number(u.since || 0),
        until: Number(u.until || 0),
        chapters: Array.isArray(u['child chapters']) ? u['child chapters'] : [],
      });
    }
  } catch {}
  return out;
}

function headingMatchesExcerpt(heading, excerpt) {
  const h = String(heading || '').toLowerCase();
  const e = String(excerpt || '').toLowerCase();
  const tokens = h
    .replace(/^\d+[a-z]?\.?\s*/u, '')
    .split(/[^a-z0-9]+/u)
    .filter((w) => w.length >= 4)
    .filter((w) => !['report','agenda','item','minutes','meeting','council','city','from','held'].includes(w));
  if (!tokens.length) return true;
  let hits = 0;
  for (const t of tokens) {
    if (e.includes(t)) hits += 1;
  }
  return hits >= Math.max(1, Math.floor(tokens.length / 3));
}

function readAgendaSummarySections(agendaSummaryPyaPath) {
  const values = readPyaTextValues(agendaSummaryPyaPath, ["sections"]);
  try {
    const raw = String(values.sections || "[]").trim();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    // Some pya writers persist JSON arrays as quoted JSON strings.
    if (typeof parsed === "string") {
      const reparsed = JSON.parse(parsed);
      return Array.isArray(reparsed) ? reparsed : [];
    }
    return [];
  } catch {
    return [];
  }
}

function isProceduralHeadingText(h) {
  const x = String(h || "").toLowerCase();
  return /(call to order|call for additional business|declarations of interest|confirmation of .*minutes|motion to move council into committee of the whole|motion to rise and report|adjournment)/iu.test(x)
    || /public meetings/iu.test(x)
    || /minutes of/iu.test(x);
}

function isLowSignalSectionSummary(text = "") {
  const s = String(text || "").replace(/\s+/gu, " ").trim().toLowerCase();
  if (!s) return true;
  return /\b(no submissions?|none submitted|no deputations?|no scheduled sessions?|none scheduled|received for information only|for information only|proceeded to the next item|meeting then proceeded|no correspondence items?|no correspondence was presented|no correspondence(?:\s+items?)?\s+were\s+presented|no correspondence(?:\s+items?)?\s+for\s+consideration|(?:absence|lack) of (?:any )?(?:questions?|participants?|speakers?|submissions?|correspondence)|no (?:questions?|participants?|speakers?|submissions?|audience members?) (?:were |was )?(?:asked|present|received|submitted)|nobody (?:was )?present)\b/iu.test(s);
}

function agendaItemCode(heading = "") {
  return String(heading || "").match(/^\s*(\d+(?:\.[a-z0-9]+)*)\b/iu)?.[1]?.toLowerCase() || "";
}

function isStructuralAgendaParent(sec = {}, sections = []) {
  const code = agendaItemCode(sec?.heading);
  if (!/^\d+$/u.test(code)) return false;
  const childPrefix = `${code}.`;
  return (Array.isArray(sections) ? sections : []).some((candidate) => {
    const candidateCode = agendaItemCode(candidate?.heading);
    return candidateCode.startsWith(childPrefix);
  });
}

function sectionLooksSubstantive(sec = {}) {
  const heading = String(sec?.heading || "");
  const summary = String(sec?.summary || "").trim();
  if (!summary) return false;
  if (isProceduralHeadingText(heading)) return false;
  if (isLowSignalSectionSummary(summary)) return false;
  if (summary.split(/\s+/u).filter(Boolean).length < 14) return false;
  return true;
}

function cleanupRecapParagraph(text = "") {
  const normalized = String(text || "")
    .replace(/\*+/gu, "")
    .replace(/\bSPEAKER[_ ]\d+\b/giu, "a speaker")
    .replace(/\s+/gu, " ")
    .replace(/\.\.\.+/gu, ".")
    .trim();
  return normalized.split(/(?<=[.!?])\s+/u)
    .filter((sentence) => !/^to answer (?:your|the) question\b/iu.test(String(sentence || "").trim()))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function chapterLooksSubstantive(chapter = {}) {
  const title = String(chapter?.title || "").trim();
  const text = String(chapter?.text || "").trim();
  if (!title || !text) return false;
  if (isProceduralHeadingText(title)) return false;
  if (isLowSignalSectionSummary(text)) return false;
  return text.split(/\s+/u).filter(Boolean).length >= 14;
}

function buildTranscriptRecapCandidates(sections = [], { allowProcedural = false } = {}) {
  const candidates = [];
  for (const sec of (Array.isArray(sections) ? sections : [])) {
    // A numbered parent that has canonical child items is an agenda category,
    // not an independent meeting topic. Let its grounded children carry the
    // recap so the whole-meeting teaser cannot select a generic parent and
    // then drift into an unrelated role or subject.
    if (!allowProcedural && isStructuralAgendaParent(sec, sections)) continue;
    if (sectionLooksSubstantive(sec)) {
      candidates.push(sec);
      continue;
    }
    if (allowProcedural && String(sec?.summary || '').trim() && !isLowSignalSectionSummary(sec.summary)) {
      candidates.push(sec);
      continue;
    }
    // Agenda grounding can occasionally retain a procedural parent heading
    // across a long substantive span. Preserve the grounded child chapters
    // instead of treating the entire span as procedural and losing the recap.
    for (const chapter of (Array.isArray(sec?.chapters) ? sec.chapters : [])) {
      if (!chapterLooksSubstantive(chapter)) continue;
      candidates.push({
        heading: chapter.title,
        summary: chapter.text,
        chapters: [],
      });
    }
  }
  return candidates;
}

function buildTranscriptRecapFromSections(sections = [], minCount = 3, canonicalAgendaEvidence = new Map(), options = {}) {
  const substantive = buildTranscriptRecapCandidates(sections, options);
  const targetCount = Math.max(minCount, 7);
  const picked = [];
  if (substantive.length <= targetCount) {
    picked.push(...substantive);
  } else {
    // Preserve the first distinct agenda items, where public input commonly
    // occurs, then spread the remaining picks across the meeting chronology.
    const lastIdx = substantive.length - 1;
    const seen = new Set();
    const earlyCount = Math.min(3, targetCount, substantive.length);
    for (let idx = 0; idx < earlyCount; idx += 1) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      picked.push(substantive[idx]);
    }
    const remaining = targetCount - picked.length;
    for (let rank = 0; rank < remaining; rank += 1) {
      const fraction = remaining <= 1 ? 1 : rank / (remaining - 1);
      const idx = Math.min(lastIdx, Math.max(earlyCount, Math.round(earlyCount + fraction * (lastIdx - earlyCount))));
      if (seen.has(idx)) continue;
      seen.add(idx);
      picked.push(substantive[idx]);
    }
    picked.sort((a, b) => substantive.indexOf(a) - substantive.indexOf(b));
    if (picked.length > targetCount) picked.length = targetCount;
  }
  const blocks = [];
  for (const sec of picked) {
    const rawHeading = String(sec.heading || "Section");
    const heading = cleanHeadlineText(rawHeading);
    const sectionSummary = cleanupRecapParagraph(String(sec.summary || ""));
    if (!heading || !sectionSummary) continue;
    const item = rawHeading.match(/^\s*(\d+(?:\.[a-z0-9]+)*)\b/iu)?.[1]?.toLowerCase() || "";
    // Keep Stage 3's grounded child chapters with their parent item. These
    // character-bounded summaries are what preserve distinct report topics in
    // short meetings; dropping them leaves one broad paragraph repeated across
    // the article and loses the report's internal nuance.
    blocks.push({
      heading,
      summary: sectionSummary,
      chapters: (Array.isArray(sec?.chapters) ? sec.chapters : [])
        .filter((chapter) => chapterLooksSubstantive(chapter))
        .map((chapter) => ({
          title: cleanHeadlineText(String(chapter.title || "")),
          text: cleanupRecapParagraph(String(chapter.text || "")),
        }))
        .filter((chapter) => chapter.title && chapter.text),
      authoritativeAgendaEvidence: canonicalAgendaEvidence.get(item) || [],
    });
  }
  return blocks;
}

function countTranscriptRecapWords(recapBlocks = []) {
  let words = 0;
  for (const block of (Array.isArray(recapBlocks) ? recapBlocks : [])) {
    words += String(block?.summary || "").split(/\s+/u).filter(Boolean).length;
    for (const ch of (Array.isArray(block?.chapters) ? block.chapters : [])) {
      words += String(ch?.text || "").split(/\s+/u).filter(Boolean).length;
    }
  }
  return words;
}

function scoreNewsSection(section) {
  const heading = String(section?.heading || "");
  const summary = String(section?.summary || "");
  const excerpt = String(section?.excerpt || "");
  const text = `${heading} ${summary} ${excerpt}`.toLowerCase();
  let score = 0;
  if (/\b(public forum|deputation|presentation|report|committee)\b/.test(text)) score += 2;
  if (/\b(correspondence)\b/.test(text)) score -= 6;
  if (/\b(deferred|defeated|rejected|approved|passed|carried|adopted|voted)\b/.test(text)) score += 2;
  if (/\b(food|insecurity|wheelchair|accessibility|hospital|taxi|housing|rent|cost of living|budget|fee|tax|transit|infrastructure|safety|poverty|hunger|health)\b/.test(text)) score += 16;
  if (/\b(cost|funding|service|policy)\b/.test(text)) score += 4;
  if (/\bby-?law|agreement|administrative|consent agenda\b/.test(text)) score -= 10;
  if (/\b(consent agenda)\b/.test(text)) score -= 8;
  if (/\b(no submissions?|none submitted|none scheduled|no correspondence|for information only)\b/.test(text)) score -= 12;
  if (/\b(by-?law\s*\d{2,}|report\s+[a-z]+-\d+|resolution\s+no\.?\s*\d+)\b/.test(text)) score -= 6;
  const words = excerpt.split(/\s+/u).filter(Boolean).length;
  if (words >= 50) score += 4;
  else if (words >= 25) score += 2;
  else if (words <= 12) score -= 2;
  if (/committee of the whole|call to order|adjournment|minutes/.test(text)) score -= 8;
  return score;
}

function humanImpactSignalScore(section = {}) {
  const heading = String(section?.heading || "");
  const summary = String(section?.summary || "");
  const excerpt = String(section?.excerpt || "");
  const text = `${heading} ${summary} ${excerpt}`.toLowerCase();
  let s = 0;
  if (/\b(wheelchair|accessibility|hospital|non-emergency|taxi|mobility)\b/.test(text)) s += 10;
  if (/\b(food insecurity|food security|hunger|poverty|housing|rent|cost of living)\b/.test(text)) s += 9;
  if (/\b(health|safety|public health)\b/.test(text)) s += 6;
  if (/\b(transit|service cuts?|service change|funding gap|affordability)\b/.test(text)) s += 5;
  if (/\b(consent agenda|administrative|lease assignment|business license|minutes received|for information only)\b/.test(text)) s -= 8;
  return s;
}

function isAdministrativeNumberHeavy(section = {}) {
  const text = `${String(section?.heading || "")} ${String(section?.title || "")} ${String(section?.summary || "")} ${String(section?.body || "")}`.toLowerCase();
  const admin = /\b(by-?law|agreement|administrative|consent agenda|minutes|assignment of lease|business license)\b/iu.test(text);
  const numberish = /\b(\d{3,}|[a-z]{2,}-\d{2,}|report\s+[a-z]+-\d+|resolution\s+no\.?\s*\d+)\b/iu.test(text);
  return admin && numberish;
}

function deriveTopNewsTitleFromSummary(summary, fallbackHeading) {
  const text = String(summary || "");
  const h = String(fallbackHeading || "").replace(/^\d+[a-z]?\.?\s*/iu, "").replace(/\s+/gu, " ").trim();
  const lead = text.split(/(?<=[.!?])\s+/u)[0] || "";
  const compact = lead.replace(/^[^A-Za-z0-9]+/u, "").split(/[.:]/u)[0].trim();
  if (compact && compact.split(/\s+/u).length >= 3) {
    if (compact.length <= 90) return compact;
    return compact.slice(0, 90).replace(/\s+\S*$/u, "").replace(/[,:;\-–—]\s*$/u, "").trim();
  }
  if (!h || /^(agenda item|report|item|section)\b/iu.test(h)) return "Council review item";
  return h;
}

function cleanHeadlineText(input) {
  let t = String(input || '').replace(/\s+/gu, ' ').trim();
  t = t.replace(/\*+/gu, '');
  t = t.replace(/^(first|second|third|fourth|fifth)[,:\s]+/iu, '');
  t = t.replace(/^(the most consequential (item|moment|action)( of the night| on the agenda)? was)\s+/iu, '');
  t = t.replace(/^(simultaneously|finally|administratively|separately|in the public forum|the meeting (also )?featured|the meeting opened with|council discussed)\b[:,]?\s*/iu, '');
  t = (splitCivicSentences(t)[0] || t).trim();
  t = t.replace(/[,:;]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const words = t.split(/\s+/u).filter(Boolean);
  const stop = new Set(['and', 'or', 'to', 'of', 'the', 'for', 'with', 'by', 'on', 'in', 'at', 'from', 'regarding', 'where', 'during', 'while']);
  while (words.length > 3 && stop.has(String(words[words.length - 1] || '').toLowerCase())) words.pop();
  if (words.length > 12) words.length = 12;
  t = words.join(' ').trim();
  t = t.replace(/[^\p{L}\p{N})\]]$/u, '');
  if (!t) return 'Key council development';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function cleanCandidateBodyText(input) {
  let t = String(input || '').replace(/\s+/gu, ' ').trim();
  t = t.replace(/^\*+\s*/u, '');
  t = t.replace(/\*+/gu, '');
  t = t.replace(/\s+-\s+\*\s+-\s+\*/gu, ' ');
  t = t.replace(/\bThe\s+section\s+also\s+covers\s+[^.!?]+[.!?]/giu, ' ');
  t = t.replace(/\bThe\s+section\s+also\s+details\s+key\s+arguments\s+and\s+outcome\s+context\s+[^.!?]*[.!?]/giu, ' ');
  t = t.replace(/\bThe\s+(section|discussion|presentation)\s+(addresses|highlights|details|covers|concerns)\s+that\s+/giu, '');
  t = t.replace(/\bThe\s+(section|discussion|presentation)\s+(addresses|highlights|details|covers|concerns)\s+(a|an|the)\s+/giu, '$3 ');
  t = t.replace(/\bThe\s+(section|discussion|presentation)\s+(addresses|highlights|details|covers|concerns)\s+/giu, '');
  t = t.replace(/^how\s+([a-z])/iu, (_, c) => c.toUpperCase());
  t = t.replace(/\bOnsound\b/giu, 'Owen Sound');
  t = t.replace(/\bOceansound\b/giu, 'Owen Sound');
  t = t.replace(/[^\S\r\n]+/gu, ' ').trim();
  const badTail = new Set(['and', 'but', 'or', 'so', 'because', 'if', 'when', 'while', 'with', 'for', 'from', 'to', 'of', 'in', 'on', 'have', 'has', 'had', 'be', 'been', 'being']);
  const sentences = t.split(/(?<=[.!?])\s+/u).map((s) => s.trim()).filter(Boolean);
  while (sentences.length > 1) {
    const lastWords = sentences[sentences.length - 1].replace(/[.!?]+$/u, '').split(/\s+/u).filter(Boolean);
    const lastWord = String(lastWords[lastWords.length - 1] || '').toLowerCase();
    if (badTail.has(lastWord) || lastWords.length < 4) sentences.pop();
    else break;
  }
  if (sentences.length) t = sentences.join(' ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function isAgendaLabelShapedTitle(title = "") {
  const t = String(title || "").replace(/\s+/gu, " ").trim();
  if (!t) return false;
  return /^(correspondence|presentation|deputation|report|staff report|verbal report|memo|letter|minutes|motion|notice of motion)\s+(from|regarding|re:|re\b|to|for)\b/iu.test(t)
    || /\b(re:|regarding)\s+(correspondence|letter|memo|report)\b/iu.test(t)
    || /^correspondence\b/iu.test(t)
    || /\bOwen Sound Police Service Re\b/iu.test(t)
    || /\bRe$/iu.test(t);
}

function normalizeNewsTitle(title, body, heading, excerpt) {
  const t = String(title || '').trim();
  const h = String(heading || '').trim();
  const src = (String(body || '') + ' ' + String(excerpt || '')).toLowerCase();
  const generic = /^(reports of city staff|verbal report from the deputy mayor re: grey county council|consent agenda (grouped)|motions for which notice was previously given)$/iu.test(t)
    || /^(reports of city staff|verbal report|consent agenda|motions for which notice)/iu.test(h);
  if (!generic) return t;
  return t;
}


function toReaderFacingTopNewsTitle(title, heading, body) {
  const t = String(title || '').replace(/\s+/gu, ' ').trim();
  return t;
}


function isGenericNewsTitle(title) {
  const t = String(title || '').trim();
  const low = t.toLowerCase();
  if (/^(reports of city staff|verbal report from the deputy mayor re: grey county council|consent agenda (grouped)|motions for which notice was previously given|key council item)$/iu.test(low)) return true;
  if (/postponed from the december/iu.test(t)) return true;
  if (/^a?\s*council\s+resolution\s+no\./iu.test(t)) return true;
  if (/^[A-Z\s\-()]{12,}$/u.test(t) && /(deputations and presentations|reports of city staff|public forum|consent agenda)/iu.test(t)) return true;
  return false;
}


function titleMatchesBody(title, body) {
  const t = String(title || '').toLowerCase();
  const b = String(body || '').toLowerCase();
  const sig = t.split(/[^a-z0-9]+/u).filter((w) => w.length >= 5).slice(0, 6);
  if (!sig.length) return true;
  const hits = sig.filter((w) => b.includes(w)).length;
  if (hits < Math.max(1, Math.floor(sig.length / 3))) return false;
  return true;
}

function titleSignalTokens(title = "") {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 5)
    .filter((w) => !["council", "approved", "reviewed", "updates", "received", "issues", "discusses", "discussed"].includes(w));
}

function focusBodyOnTitle(title = "", body = "") {
  const src = String(body || "").replace(/\s+/gu, " ").trim();
  if (!src) return "";
  const tokens = titleSignalTokens(title);
  if (!tokens.length) return src;
  const sentences = src.split(/(?<=[.!?])\s+/u).map((s) => s.trim()).filter(Boolean);
  const picked = [];
  for (const s of sentences) {
    const low = s.toLowerCase();
    const hits = tokens.filter((t) => low.includes(t)).length;
    if (hits >= 1) picked.push(s);
    if (picked.length >= 3) break;
  }
  if (!picked.length) return "";
  return picked.join(" ").replace(/\s+/gu, " ").trim();
}

function deriveContentTopicCandidates(base, grounding = {}) {
  const out = [];
  const chapters = Array.isArray(base?.chapters) ? base.chapters : [];
  let i = 0;
  for (const ch of chapters) {
    const chTitle = cleanHeadlineText(String(ch?.title || "").replace(/^\d+[a-z]?\.?\s*/iu, "").trim());
    const chTextRaw = cleanupRecapParagraph(String(ch?.text || ""));
    const chText = cleanCandidateBodyText(neutralizeAttribution(chTextRaw));
    if (!chTitle || !chText) continue;
    if (!chapterLooksSubstantive({ title: chTitle, text: chText })) continue;
    let title = normalizeNewsTitle(chTitle, chText, chTitle, chText);
    if (isAgendaLabelShapedTitle(title)) {
      title = cleanHeadlineText(deriveTopNewsTitleFromSummary(chText, chTitle));
      title = normalizeNewsTitle(title, chText, chTitle, chText);
    }
    if (isAgendaLabelShapedTitle(title) || !titleMatchesBody(title, chText)) continue;
    const impact = humanImpactSignalScore({ heading: chTitle, summary: chText, excerpt: String(grounding?.excerpt || "") });
    const score = scoreNewsSection({ heading: chTitle, summary: chText, excerpt: String(grounding?.excerpt || "") }) + 3 + impact;
    const sourceChapter = Array.isArray(grounding?.chapters) ? grounding.chapters[i] : null;
    i += 1;
    out.push({
      id: `${String(base?.id || "news")}_topic_${String(i).padStart(2, "0")}`,
      unitId: String(base?.unitId || ""),
      chapterId: String(ch?.["chapter id"] || sourceChapter?.["chapter id"] || ""),
      rowStart: Number(ch?.["row start"] || sourceChapter?.["row start"] || grounding?.rowStart || 0),
      rowEnd: Number(ch?.["row end"] || sourceChapter?.["row end"] || grounding?.rowEnd || 0),
      since: Number(ch?.since || sourceChapter?.since || grounding?.since || 0),
      until: Number(ch?.until || sourceChapter?.until || grounding?.until || 0),
      heading: chTitle,
      summary: chText,
      body: chText,
      title,
      excluded: false,
      substantive: true,
      score,
      candidateKind: "content_topic",
    });
  }
  return out;
}



function cleanTopNewsBody(title, body) {
  let t = String(title || '').trim();
  let b = String(body || '').replace(/\s+/gu, ' ').trim();
  const focused = focusBodyOnTitle(t, b);
  if (focused) b = focused;
  return { title: t, body: b };
}

function buildRankedTopNewsFromAgenda(agendaSummaryPyaPath, agendaSectionGroundingPyaPath = "") {
  const sections = readAgendaSummarySections(agendaSummaryPyaPath);
  const groundingMap = agendaSectionGroundingPyaPath ? readGroundingUnitsMap(agendaSectionGroundingPyaPath) : new Map();
  const rows = [];
  for (let i = 0; i < sections.length; i += 1) {
    const s = sections[i];
    const heading = String(s?.heading || "").trim();
    const summary = String(s?.summary || "").replace(/\s+/gu, " ").trim();
    const unitId = String(s?.["unit id"] || s?.unitId || ("section_" + (i + 1)));
    const id = "news_" + String(i + 1).padStart(3, "0") + "_" + unitId;
    const g = groundingMap.get(unitId) || { boundarySource: '', evidence: '', excerpt: '' };
    const weakBoundary = /interpolated|step-clamp|fallback/iu.test(g.boundarySource) || /weak/iu.test(g.evidence);
    const headingMatch = headingMatchesExcerpt(heading, g.excerpt || summary);
    const substantiveSignal = /\b(by-?law|funding|funder|transit|lease assignment|approved|passed|carried|service|accessibility|hospital)\b/iu.test(summary);
    const excluded = isProceduralHeadingText(heading)
      || (!summary || isLowSignalSectionSummary(summary))
      || (weakBoundary && !headingMatch && !substantiveSignal);
    const score = excluded ? -999 : scoreNewsSection({ heading, summary, excerpt: g.excerpt || '' });
    const body = cleanCandidateBodyText(neutralizeAttribution((summary.split(/(?<=[.!?])\s+/u)[0] || summary).trim()));
    const title = cleanHeadlineText(deriveTopNewsTitleFromSummary(body, heading));
    let safeTitle = normalizeNewsTitle(title, body, heading, g.excerpt || '');
    if (!titleMatchesBody(safeTitle, body)) {
      safeTitle = cleanHeadlineText(deriveTopNewsTitleFromSummary(body, heading));
      safeTitle = normalizeNewsTitle(safeTitle, body, heading, '');
    }
    const cleaned = cleanTopNewsBody(safeTitle, body);
    safeTitle = cleaned.title || safeTitle;
    safeTitle = cleanHeadlineText(toReaderFacingTopNewsTitle(safeTitle, heading, body));
    if (isAgendaLabelShapedTitle(safeTitle)) {
      safeTitle = cleanHeadlineText(deriveTopNewsTitleFromSummary(cleaned.body || body, heading));
      safeTitle = normalizeNewsTitle(safeTitle, cleaned.body || body, heading, g.excerpt || '');
    }
    const cleanedBody = cleanCandidateBodyText(cleaned.body || body);
    const substantive = sectionLooksSubstantive({ heading, summary });
    const base = {
      id, unitId, heading, summary, body: cleanedBody, title: safeTitle, excluded, substantive, score, candidateKind: 'section',
      rowStart: Number(g.rowStart || 0),
      rowEnd: Number(g.rowEnd || 0),
      since: Number(g.since || 0),
      until: Number(g.until || 0),
      chapters: Array.isArray(s?.chapters) ? s.chapters : [],
    };
    rows.push(base);
    const derived = deriveContentTopicCandidates(base, g);
    for (const d of derived) rows.push(d);
  }
  const unitHasDerived = new Set(
    rows.filter((r) => r.candidateKind === 'content_topic').map((r) => String(r.unitId || '')),
  );
  const selectedPre = rows
    // News scores rank grounded agenda items; they do not decide whether a
    // substantive item exists. Administrative and planning items can score
    // below zero while still being valid, generated agenda summaries.
    .filter((r) => !r.excluded && r.substantive)
    .filter((r) => {
      if (r.candidateKind === 'content_topic') return true;
      if (unitHasDerived.has(String(r.unitId || ''))) return false;
      const groupedLike = /consent agenda|reports of city staff|verbal report|agenda item|motions for which notice/i.test(String(r.heading || ''));
      const hardAggregate = /consent agenda|reports of city staff/i.test(String(r.heading || ''));
      if (hardAggregate && unitHasDerived.has(String(r.unitId || ''))) return false;
      if (groupedLike && unitHasDerived.has(String(r.unitId || ''))) return false;
      if (isGenericNewsTitle(r.title)) return false;
      if (isAgendaLabelShapedTitle(r.title)) return false;
      if (!titleMatchesBody(String(r.title || ""), String(r.body || ""))) return false;
      if (/postponed from the december|council\s+resolution\s+no\./iu.test(String(r.heading || '') + ' ' + String(r.title || ''))) return false;
      return true;
    })
    .sort((a, b) => {
      const ai = humanImpactSignalScore(a);
      const bi = humanImpactSignalScore(b);
      if (bi !== ai) return bi - ai;
      const aAdminHeavy = isAdministrativeNumberHeavy(a) ? 1 : 0;
      const bAdminHeavy = isAdministrativeNumberHeavy(b) ? 1 : 0;
      if (aAdminHeavy !== bAdminHeavy) return aAdminHeavy - bAdminHeavy;
      return b.score - a.score;
    });
  const seenTitles = new Set();
  const byUnitCount = new Map();
  const selected = [];
  for (const r of selectedPre) {
    const tk = String(r.title || '').toLowerCase().trim();
    if (!tk || seenTitles.has(tk)) continue;
    const unitKey = String(r.unitId || '');
    const existingFromUnit = Number(byUnitCount.get(unitKey) || 0);
    if (unitKey && existingFromUnit >= 2) continue;
    seenTitles.add(tk);
    selected.push(r);
    if (unitKey) byUnitCount.set(unitKey, existingFromUnit + 1);
    if (selected.length >= 4) break;
  }
  const bullets = selected.map((r) => "- **" + r.title + ":** " + r.body);
  return { rows, selected, markdown: bullets.join("\n") };
}
function sanitizeLeadSentence(text) {
  let out = String(text || '').replace(/\s+/gu, ' ').trim();
  out = out.replace(/^The\s+Deputy\s+Mayor\s+explains\s+that\s+/iu, 'Council discussed ');
  out = out.replace(/^The\s+acting\s+city\s+manager\s+presented\s+/iu, 'Staff presented ');
  out = out.replace(/^City\s+staff\s+presented\s+/iu, 'Staff presented ');
  out = out.replace(/^council\s+the\s+/iu, 'council ');
  return out;
}


function neutralizeAttribution(sentence) {
  let out = String(sentence || '').replace(/\s+/gu, ' ').trim();
  out = out.replace(/\bGray County\b/gu, 'Grey County');
  out = out.replace(/\bOnsound\b/giu, 'Owen Sound');
  out = out.replace(/\bOceansound\b/giu, 'Owen Sound');
  out = out.replace(/^The\s+Deputy\s+Mayor\s+explains?\b[^.]*?/iu, 'Council discussed');
  out = out.replace(/^The\s+Deputy\s+Mayor\s+addressed\b[^.]*?/iu, 'Council discussed');
  out = out.replace(/^The\s+acting\s+city\s+manager\s+presented\b/iu, 'Staff presented');
  out = out.replace(
    /^City\s+staff\s+presented\s+a\s+verbal\s+update\s+from\s+the\s+Grey\s+County\s+Council\b[^.]*/iu,
    "Council received an update about Grey County's endorsement of a Western Ontario Wardens' Association letter regarding Bill 100, local leadership, and regional municipal structures"
  );
  out = out.replace(/^City\s+staff\s+presented\b/iu, 'Staff presented');
  out = out.replace(/^staff\s+presented\b/iu, 'Staff presented');
  return out.replace(/\s+/gu, ' ').trim();
}

function anonymizeSpeakerAttributions(text = "") {
  let out = String(text || "").replace(/[^\S\r\n]+/gu, " ").trim();
  const speakerMap = new Map();
  let nextSpeaker = 1;
  const tag = (rawName) => {
    const key = String(rawName || "").trim().toLowerCase();
    if (!key) return "Speaker";
    if (!speakerMap.has(key)) {
      speakerMap.set(key, `Speaker ${String(nextSpeaker).padStart(2, "0")}`);
      nextSpeaker += 1;
    }
    return speakerMap.get(key);
  };
  out = out.replace(/\b(Councillor|Councilor|Mayor|Deputy Mayor)\s+([A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,2})\b/gu, (_, __, nm) => tag(nm));
  out = out.replace(/\b(resident|speaker|presenter|deputant)\s+([A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,2})\b/giu, (_, role, nm) => `${String(role || "speaker").toLowerCase()} ${tag(nm)}`);
  out = out.replace(/\b(Bradey Carbert|Melanie Middlebro|Eckhard Pastrik|Scott Greig)\b/gu, (m) => tag(m));
  out = out.replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(said|stated|argued|noted|proposed|explained|urged|reported)\b/gu, (_m, nm, verb) => `${tag(nm)} ${verb}`);
  out = out.replace(/\bOnsound\b/giu, "Owen Sound");
  out = out.replace(/\bOceansound\b/giu, "Owen Sound");
  return out
    .split(/\r?\n/u)
    .map((line) => line.replace(/[^\S\r\n]+/gu, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function dedupeSentences(sentences) {
  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    const k = String(s || '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(s || '').trim());
  }
  return out;
}

function applyCanonicalNameFixes(text = "") {
  return String(text || "")
    .replace(/\bOnsound\b/giu, "Owen Sound")
    .replace(/\bOceansound\b/giu, "Owen Sound")
    .replace(/\bCity of Oceansound\b/giu, "City of Owen Sound")
    .replace(/\bAndre Zvorogin\b/gu, "Andrii Zvorygin")
    .replace(/\bAndrei Zvorov\b/gu, "Andrii Zvorygin")
    .replace(/\bAndrei Zvorygin\b/gu, "Andrii Zvorygin")
    .replace(/\bAndrii Zvorov\b/gu, "Andrii Zvorygin")
    .replace(/\bGrey Sable\b/giu, "Grey Sauble")
    .replace(/\bLURA\b/gu, "Lake Huron Regional Conservation Authority");
}

function buildWholeSummaryFromTop(selected, dateLong, jurisdiction) {
  const leadSource = Array.isArray(selected) && selected.length ? selected[0] : null;
  const leadBody = neutralizeAttribution(sanitizeLeadSentence(String((leadSource?.body || leadSource?.summary || '').split(/(?<=[.!?])\s+/u)[0] || '')));
  const lead = leadBody || 'council discussed several substantive items.';
  const leadClean = lead.replace(/^the committee\s+/iu, '').replace(/^council\s+/iu, '').trim();
  const first = ('On ' + dateLong + ', ' + jurisdiction + ' council ' + leadClean.charAt(0).toLowerCase() + leadClean.slice(1)).replace(/\.+$/u, '.');

  const secondaryRaw = (selected || [])
    .slice(1)
    .filter((x) => x?.candidateKind === 'content_topic' || !isGenericNewsTitle(x?.title || ''))
    .map((x) => neutralizeAttribution(sanitizeLeadSentence(String((x?.body || x?.summary || '').split(/(?<=[.!?])\s+/u)[0] || '').replace(/\s+/gu, ' ').trim())))
    .filter(Boolean)
    .filter((x) => !/^The\s+Deputy\s+Mayor\s+explains/iu.test(x))
    .filter((x) => !/\bcouncil\s+the\b/iu.test(x));

  const secondary = dedupeSentences(secondaryRaw).slice(0, 2);
  const whole = [first, ...secondary].join(' ').replace(/\s+/gu, ' ').trim();
  return whole.replace(/\bcouncil\s+the\b/giu, 'council ').replace(/(\b[^.]+\.)\s+\1/gu, '$1');
}

function isLowSignalTopNewsItem(item = {}) {
  const title = String(item?.title || "").trim();
  const body = String(item?.body || "").trim();
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  if (!title || !body) return true;
  if (t === b) return true;
  if (/^on the financial and regulatory front\b/iu.test(title) || /^administrative business\b/iu.test(title)) return true;
  if (isAgendaLabelShapedTitle(title)) return true;
  if (/^the\s+(discussion|section|presentation)\s+(addresses|highlights|details)\b/iu.test(title) || /^the\s+(discussion|section|presentation)\s+(addresses|highlights|details)\b/iu.test(body)) return true;
  if (/\b(So you|So when|And so|But then),?\s+(at your|we|they|it|that)\b/iu.test(body)) return true;
  if (/\b\p{L}+'s\s+[^.!?]+\s+and\s+(introduces|debates|discusses|debating|introducing)\b/iu.test(body)) return true;
  if (body.split(/\s+/u).filter(Boolean).length < 10) return true;
  return false;
}

function crossJurisdictionLeadPenalty(item = {}, jurisdiction = "") {
  const local = String(jurisdiction || "").replace(/\s+/gu, " ").trim().toLowerCase();
  if (!local) return 0;
  const text = `${String(item?.title || "")} ${String(item?.heading || "")} ${String(item?.body || "")}`
    .replace(/\s+/gu, " ")
    .trim();
  const startsOtherGovernment = /^(Grey County|Bruce County|Simcoe County|Toronto|Ontario|Canada)\b/u.test(text);
  if (local.includes("owen sound") && startsOtherGovernment && !/^Owen Sound\b/u.test(text)) return 18;
  return 0;
}

function buildWhyMattersFromTop(selected) {
  const clauses = [];
  const text = selected.map((s) => `${s.heading || ''} ${s.title || ''} ${s.body || ''} ${s.summary || ''}`).join(" ").toLowerCase();
  if (/\b(deferred|defer|defeated|rejected|approved|adopted|carried|voted)\b/.test(text)) {
    clauses.push("These decisions can change service timelines, project priorities, and near-term municipal operations.");
  }
  if (/\b(fee|tax|budget|funding|cost|charges?)\b/.test(text)) {
    clauses.push("Financial choices can affect residents, local organizations, and future city budget planning.");
  }
  if (/\b(by-law|agreement|policy|service|transit|infrastructure|road|transportation)\b/.test(text)) {
    clauses.push("Policy and service changes can reshape how city programs are delivered and accessed.");
  }
  if (/\b(public forum|deputation|presentation|community|accessibility|housing|food|safety)\b/.test(text)) {
    clauses.push("Community-facing issues highlighted in the discussion can have direct day-to-day impacts for residents.");
  }
  if (!clauses.length) {
    if (/\b(food truck|event fees?|fees? and charges|non-profit|snow removal|annual review|three-year)\b/.test(text)) {
      clauses.push("Fee and charge decisions can directly affect event organizers, small operators, and service planning.");
    }
    if (/\b(operations committee|staff report|service review|cost recovery)\b/.test(text)) {
      clauses.push("Committee recommendations shape how future council decisions balance cost recovery with community impact.");
    }
  }
  return clauses.slice(0, 4).join(" ");
}

function enforceSingleLeadSentence(text, dateLong, jurisdiction) {
  const s = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!s) return s;
  const match = s.match(/^On\s+[^,]+,\s*\d{4},\s*(.+)$/iu);
  if (!match) return s;
  let tail = String(match[1] || '').trim();
  tail = tail.split(/,\s*(while|and|as well as)\b/iu)[0].trim();
  tail = tail.replace(/[,:;\-–—]\s*$/u, '').trim();
  const city = String(jurisdiction || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').trim();
  if (city) {
    const cityCouncilPrefix = new RegExp(`^${city}\\s+council\\s+`, 'iu');
    tail = tail.replace(cityCouncilPrefix, '');
  }
  tail = tail.replace(/^council\s+/iu, '');
  if (!tail) return s;
  return `On ${dateLong}, ${jurisdiction} council ${tail}`.replace(/\.+$/u, '.');
}

function assertMeetingLocalTopics(bodyMarkdown, sourceText) {
  const body = String(bodyMarkdown || '').toLowerCase();
  const source = String(sourceText || '').toLowerCase();
  const checks = [
    { label: 'named-topic drift', pattern: /\b(park renaming proposal|specific local issue package)\b/iu },
  ];
  const leaks = [];
  for (const c of checks) {
    if (c.pattern.test(body) && !c.pattern.test(source)) leaks.push(c.label);
  }
  if (leaks.length) {
    throw new Error(`[article-locality] out-of-meeting topic leakage: ${leaks.join(', ')}`);
  }
}

function toShortOverlay(hookText) {
  const words = String(hookText || '')
    .replace(/[^A-Za-z0-9\s-]/gu, ' ')
    .split(/\s+/u)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return 'City Update';
  return words.slice(0, 3).join(' ');
}

function syncSpeakerArtifactsToGlobal({ fromDir, toDir }) {
  if (!existsFile(path.join(fromDir, 'index.pya'))) return { copied: 0, keys: [] };
  fs.mkdirSync(toDir, { recursive: true });
  const copiedKeys = [];
  const names = fs.readdirSync(fromDir)
    .filter((n) => /^speaker_\d+\.pya$/iu.test(n))
    .map((n) => n.replace(/\.pya$/u, ''))
    .sort();
  for (const key of names) {
    let copiedForKey = false;
    for (const ext of ['.pya', '.npy', '.wav']) {
      const src = path.join(fromDir, `${key}${ext}`);
      const dst = path.join(toDir, `${key}${ext}`);
      if (!existsFile(src)) continue;
      if (!existsFile(dst)) {
        fs.copyFileSync(src, dst);
        copiedForKey = true;
      }
    }
    if (copiedForKey) copiedKeys.push(key);
  }
  return { copied: copiedKeys.length, keys: copiedKeys };
}

function hasSuccessfulMeetingPublishResponse(transcriptDir) {
  if (!existsDir(transcriptDir)) return false;
  const files = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => n.endsWith('.meeting-publish.response.json'));
  for (const name of files) {
    const full = path.join(transcriptDir, name);
    try {
      const obj = JSON.parse(fs.readFileSync(full, 'utf8'));
      const postUrl = String(obj?.post_url || '').trim();
      const transcriptUrl = String(obj?.transcript_url || '').trim();
      const err = String(obj?.error || '').trim();
      if ((postUrl || transcriptUrl) && !err) return true;
    } catch {
      // ignore malformed response artifacts
    }
  }
  return false;
}

function hasTranscriptPayloadShape(payloadPath, expectedHtmlPath) {
  if (!existsFile(payloadPath)) return false;
  try {
    const obj = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    const contentType = String(obj?.content_type || '').trim().toLowerCase();
    if (contentType === 'agenda') return false;
    const localTranscriptHtml = String(obj?.local_transcript_html || '').trim();
    if (!localTranscriptHtml) return false;
    const resolved = path.isAbsolute(localTranscriptHtml)
      ? path.normalize(localTranscriptHtml)
      : path.normalize(path.resolve(path.dirname(payloadPath), localTranscriptHtml));
    const expected = path.normalize(String(expectedHtmlPath || ''));
    if (expected && resolved !== expected) return false;
    return true;
  } catch {
    return false;
  }
}

function hasOneSentenceSection(bodyPath) {
  if (!existsFile(bodyPath)) return false;
  const text = safeReadText(bodyPath, '');
  return /##\s+One-Sentence Summary/iu.test(text);
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/u).filter(Boolean).length;
}

function hasReasonablePunctuation(text) {
  const src = String(text || '');
  const words = countWords(src);
  if (words < 80) return true;
  const punct = (src.match(/[.!?]/gu) || []).length;
  const ratio = punct / Math.max(1, words);
  // Require at least ~1 sentence punctuation per 125 words for long transcripts.
  return punct >= 6 && ratio >= 0.008;
}

function simplifyOneSentenceLead(text) {
  const src = String(text || "").replace(/\s+/gu, " ").trim();
  if (!src) return "";
  if (/^On\s+[A-Za-z]+\s+\d{1,2},\s+\d{4},\s+council(?:ors)?\b/u.test(src) && /,\s+and\s+/u.test(src)) {
    const lead = src.split(/,\s+and\s+/u)[0].trim().replace(/[,:;\-–—]\s*$/u, "");
    if (lead.split(/\s+/u).filter(Boolean).length >= 12) return lead;
  }
  // If model stitches multiple developments after a comma, keep the lead development only.
  // Hard guard for multi-item stitched leads: keep only the first development clause.

  if (/^On\s+[A-Za-z]+\s+\d{1,2},\s+\d{4},\s+council(?:ors)?\b/u.test(src) && src.includes(",")) {
    const parts = src.split(",");
    if (parts.length >= 3) {
      const first = `${parts[0].trim()},${parts[1].trim()}`.replace(/[,:;\-–—]\s*$/u, "").trim();
      if (first.split(/\s+/u).filter(Boolean).length >= 12) return first;
    }
  }
  if (/^On\s+[A-Za-z]+\s+\d{1,2},\s+\d{4},\s+council(?:ors)?\b/u.test(src)) {
    const cutAt = src.search(/\b(and|while|as well as)\b/iu);
    if (cutAt > 0) {
      const lead = src.slice(0, cutAt).trim().replace(/[,:;\-–—]\s*$/u, "");
      if (lead.split(/\s+/u).filter(Boolean).length >= 10) return lead;
    }
  }
  // Avoid stitched leads that jam multiple unrelated items.
  if (/^On\s+[A-Za-z]+\s+\d{1,2},\s+\d{4},\s+council(?:ors)?\b/u.test(src)) {
    const multi = src.match(/^([^,]+,[^,]+),\s*([^,]+),\s*(.+)$/u);
    if (multi) {
      const first = `${multi[1]}, ${multi[2]}`.replace(/[,:;\-–—]\s*$/u, "").trim();
      if (first.split(/\s+/u).filter(Boolean).length >= 10) return first;
    }
  }
  if (/\bwhile\b/iu.test(src) && /\band\b/iu.test(src)) {
    const cut = src.split(/\bwhile\b/iu)[0].trim().replace(/[,:;\-–—]\s*$/u, "");
    if (cut.split(/\s+/u).filter(Boolean).length >= 12) return cut;
  }
  return src;
}

function oneSentenceLeadLooksLikePublicForum(leadTop = null) {
  const hay = `${String(leadTop?.heading || "")} ${String(leadTop?.title || "")} ${String(leadTop?.body || leadTop?.summary || "")}`.toLowerCase();
  return /\b(public forum|resident|speaker|deputation|delegation|presentation)\b/iu.test(hay);
}

function rewriteOneSentenceAttributionForPublicForum(sentence = "", leadTop = null) {
  const src = String(sentence || "").replace(/\s+/gu, " ").trim();
  if (!src) return src;
  if (!oneSentenceLeadLooksLikePublicForum(leadTop)) return src;
  let out = src;
  out = out.replace(
    /^On\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}),\s+council members?\s+discussed\b/iu,
    "On $1, public forum participants raised"
  );
  out = out.replace(
    /^At\s+its\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})\s+meeting,\s+[^,]*\bcouncil\s+discussed\b/iu,
    "At its $1 meeting, council heard public forum participants raise"
  );
  out = out.replace(
    /^On\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}),\s+council\s+discussed\b/iu,
    "On $1, public forum participants raised"
  );
  return out;
}

function normalizeCivicBodyLabel(jurisdiction = "", body = "") {
  const city = String(jurisdiction || "").replace(/\s+/gu, " ").trim() || "Owen Sound";
  let label = String(body || "").replace(/\s+/gu, " ").trim() || "Council";
  label = label.replace(/^Committee\s*-\s*Committee of\s+/iu, "Committee of ");
  label = label.replace(/^Council Meeting\s*-\s*/iu, "Council");
  label = label.replace(/^Committee\s*-\s*/iu, "Committee ");
  label = label.replace(/\s+/gu, " ").trim();
  if (!label) label = "Council";
  if (new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(label)) return label;
  return `${city} ${label}`.replace(/\s+/gu, " ").trim();
}

function oneSentenceHasCivicSubject(text = "", { jurisdiction = "", body = "" } = {}) {
  const s = String(text || "").replace(/\s+/gu, " ").trim();
  if (!s) return false;
  if (/\b(council|committee|board)\b/iu.test(s)) return true;
  const label = normalizeCivicBodyLabel(jurisdiction, body);
  const parts = label
    .split(/\s+/u)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4)
    .filter((x) => !/^(owen|sound|city|town|county)$/iu.test(x));
  return parts.some((part) => new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(s));
}

function explainMalformedOneSentence(text, opts = {}) {
  const s = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!s) return 'empty';
  if (/\.\.\.$/u.test(s)) return 'ellipsis_tail';
  if (/\bcouncil\s+(the|a|an)\b/iu.test(s)) return 'malformed_subject_phrase';
  if (/\bagenda item\s+\d/iu.test(s)) return 'agenda_fragment';
  const words = s.split(/\s+/u).filter(Boolean);
  const maximumWords = Number.isFinite(opts.maxWords) ? opts.maxWords : 42;
  if (words.length < 10 || words.length > maximumWords) return 'word_count_out_of_bounds';
  if (!/[.!?]$/u.test(s)) return 'missing_terminal_punctuation';
  if (!oneSentenceHasCivicSubject(s, opts)) return 'missing_civic_body_subject';
  if (!opts.allowMeetingSectionPhrases
    && /\b(consent agenda|reports of city staff|deputations and presentations|public meetings)\b/iu.test(s)) return 'generic_section_phrase';
  if (!/\b(deferred|rejected|approved|passed|considered|discussed|heard|voted|received|confirmed|required|prohibited|concluded|convened|reviewed|directed|recommended|proposed|presented|raised|noted|accepted|established|authorized|showed|highlighted|identified|described|reported|warned|called|asked|explored|emphasized|debated)\b/iu.test(s)) return 'missing_action_verb';
  const commaCount = (s.match(/,/gu) || []).length;
  // A meeting-wide sentence may need a short, readable list of outcomes when
  // one report is the only substantive item. Permit up to four commas while
  // still rejecting comma-splice walls that usually indicate an unbounded
  // model dump.
  if (commaCount >= 5) return 'too_many_commas';
  return '';
}

function isMalformedOneSentence(text, opts = {}) {
  return !!explainMalformedOneSentence(text, opts);
}

function normalizeSentenceForCompare(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function oneSentenceMateriallyChanged(beforeText = "", afterText = "") {
  const a = normalizeSentenceForCompare(beforeText);
  const b = normalizeSentenceForCompare(afterText);
  if (!a || !b) return a !== b;
  if (a === b) return false;
  // Treat short punctuation-only or tiny lexical edits as non-material.
  const aWords = a.split(" ").filter(Boolean);
  const bWords = b.split(" ").filter(Boolean);
  if (Math.abs(aWords.length - bWords.length) <= 1) {
    let overlap = 0;
    const bSet = new Set(bWords);
    for (const w of aWords) if (bSet.has(w)) overlap += 1;
    const ratio = overlap / Math.max(1, Math.min(aWords.length, bWords.length));
    if (ratio >= 0.85) return false;
  }
  return true;
}

function oneSentenceHasUnsupportedOutcome(sentence = '', leadTop = null) {
  const s = String(sentence || '').toLowerCase();
  const b = (String(leadTop?.title || '') + ' ' + String(leadTop?.body || '')).toLowerCase();
  const outcomeWords = ['deferred', 'defeated', 'rejected', 'approved', 'adopted', 'passed', 'carried'];
  const sentenceOutcome = outcomeWords.find((w) => new RegExp('\\b' + w + '\\b', 'u').test(s));
  if (!sentenceOutcome) return false;
  if (new RegExp('\\b' + sentenceOutcome + '\\b', 'u').test(b)) return false;
  if (!/\b(defer|defeated|rejected|approved|adopted|passed|carried|voted)\b/u.test(b)) return true;
  return true;
}

function downgradeUnsupportedOutcomeToNeutral(sentence = "", leadTop = null) {
  const src = String(sentence || "").replace(/\s+/gu, " ").trim();
  if (!src) return src;
  if (!oneSentenceHasUnsupportedOutcome(src, leadTop)) return src;
  return src
    .replace(/\brejected\s+procedural\s+delays?\s+(?:after|following)\b/iu, "discussed procedural timing after")
    .replace(/\b(?:bypassed|rejected)\s+standard\s+procedural\s+delays?\s+(?:after|following)\b/iu, "discussed standard procedures after")
    .replace(/\brejected\s+procedural\s+delays?\s+to\s+prioritize\b/iu, "discussed procedural timing and")
    .replace(/\bcouncil\s+approved\b/iu, "council discussed")
    .replace(/\bcouncil\s+adopted\b/iu, "council discussed")
    .replace(/\bcouncil\s+passed\b/iu, "council considered")
    .replace(/\bcouncil\s+carried\b/iu, "council considered")
    .replace(/\bcouncil\s+rejected\b/iu, "council discussed")
    .replace(/\bcouncil\s+defeated\b/iu, "council considered")
    .replace(/\bcouncil\s+deferred\b/iu, "council discussed")
    .replace(/\bapproved\b/iu, "discussed")
    .replace(/\badopted\b/iu, "discussed")
    .replace(/\bpassed\b/iu, "considered")
    .replace(/\bcarried\b/iu, "considered")
    .replace(/\brejected\b/iu, "discussed")
    .replace(/\bdefeated\b/iu, "considered")
    .replace(/\bdeferred\b/iu, "discussed")
    .replace(/\bto\s+prioritize\s+immediate\b/iu, "while reviewing immediate")
    .replace(/\s+/gu, " ")
    .trim();
}

function neutralizeCommitteeDecisionLanguage(text = "", body = "") {
  const src = String(text || "").replace(/\s+/gu, " ").trim();
  if (!src) return src;
  const bodyText = String(body || "").toLowerCase();
  if (!bodyText.includes("committee") || bodyText.includes("council meeting")) return src;
  return src
    .replace(/\bThe council advanced\b/giu, "The committee reviewed")
    .replace(/\bCouncil advanced\b/giu, "The committee reviewed")
    .replace(/\bthe council advanced\b/giu, "the committee reviewed")
    .replace(/\bcouncil advanced\b/giu, "the committee reviewed")
    .replace(/\bThe council approved\b/giu, "The committee supported")
    .replace(/\bCouncil approved\b/giu, "The committee supported")
    .replace(/\bthe council approved\b/giu, "the committee supported")
    .replace(/\bcouncil approved\b/giu, "the committee supported")
    .replace(/\bThe council authorized\b/giu, "The committee recommended")
    .replace(/\bCouncil authorized\b/giu, "The committee recommended")
    .replace(/\bthe council authorized\b/giu, "the committee recommended")
    .replace(/\bcouncil authorized\b/giu, "the committee recommended")
    .replace(/\bleading Council to approve\b/giu, "with the committee supporting")
    .replace(/\bleading council to approve\b/giu, "with the committee supporting")
    .replace(/\bsecured additional funding\b/giu, "discussed additional funding")
    .replace(/\bsecured extra funding\b/giu, "discussed extra funding")
    .replace(/\bsecured an additional allocation\b/giu, "discussed an additional allocation")
    .replace(/\bapproved an extra allocation\b/giu, "supported an extra allocation")
    .replace(/\bapproved additional funds\b/giu, "supported additional funds")
    .replace(/\bapproved additional funding\b/giu, "supported additional funding")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildNeutralOneSentenceFromLead({ leadTop = null, dateLong = "", jurisdiction = "Owen Sound", body = "Council" } = {}) {
  const source = String(leadTop?.body || leadTop?.summary || leadTop?.title || "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!source) return "";
  let first = source.split(/(?<=[.!?])\s+/u).find(Boolean) || source;
  first = first
    .replace(/^The\s+(presentation|discussion|section)\s+(highlights?|addresses?|details?)\s+(that\s+)?/iu, "")
    .replace(/^The\s+Police\s+Chief\s+notes?\s+that\s+/iu, "the Police Chief noted ")
    .replace(/\s+/gu, " ")
    .trim();
  const words = first.split(/\s+/u).filter(Boolean);
  let picked = words.slice(0, 28);
  while (picked.length > 12 && /^(and|or|but|to|of|the|a|an|with|for|from|that|while|because)$/iu.test(picked[picked.length - 1])) picked.pop();
  const topic = picked.join(" ").replace(/[,:;\-–—]\s*$/u, "").trim();
  if (!topic) return "";
  const civic = normalizeCivicBodyLabel(jurisdiction, body);
  const date = String(dateLong || "").trim();
  const prefix = date && !/^Unknown date$/iu.test(date)
    ? `At ${civic}'s ${date} meeting, `
    : `At ${civic}'s meeting, `;
  const sentence = `${prefix}the lead item highlighted ${topic.charAt(0).toLowerCase()}${topic.slice(1)}`.replace(/\s+/gu, " ").trim();
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
}

function buildDeterministicOneSentence({ dateLong, jurisdiction, body, leadTop }) {
  const date = String(dateLong || '').trim() || 'April 27, 2026';
  const civicBody = normalizeCivicBodyLabel(jurisdiction, body);
  const heading = String(leadTop?.heading || '');
  const leadBody = String(leadTop?.body || '');
  const text = `${heading} ${leadBody}`.toLowerCase();
  const cleaned = leadBody.replace(/\s+/gu, ' ').trim().replace(/[.!?]+$/u, '');
  if (cleaned) {
    let topic = cleaned
      .replace(/^(the agenda item focused on|the agenda item|the agenda addresses|the agenda moved to|the committee deliberated on|the committee reviewed|staff proposed|council staff proposed)\s+/iu, '')
      .replace(/^that\s+/iu, '')
      .trim();
    topic = topic
      .split(/,\s*(specifically|while|and)\b/iu)[0]
      .replace(/[,:;\-–—]\s*$/u, '')
      .trim();
    const words = topic.split(/\s+/u).filter(Boolean);
    if (words.length > 20) topic = words.slice(0, 20).join(' ').replace(/[,:;\-–—]\s*$/u, '');
    if (topic) return `On ${date}, ${civicBody} discussed ${topic}.`;
    return `On ${date}, ${civicBody} discussed local service and infrastructure decisions.`;
  }
  return `On ${date}, ${civicBody} discussed key local infrastructure and service decisions.`;
}

function chooseLeadTopForOneSentence(selectedItems = [], opts = {}) {
  const rows = Array.isArray(selectedItems) ? selectedItems.filter(Boolean) : [];
  if (!rows.length) return null;
  const rank = (item) => {
    const text = `${String(item?.title || "")} ${String(item?.heading || "")} ${String(item?.body || "")}`.toLowerCase();
    let s = Number(item?.score || 0);
    const words = String(item?.body || "").split(/\s+/u).filter(Boolean).length;
    const sustained = words >= 20;
    const humanImpact = /\b(food|insecurity|poverty|wheelchair|accessibility|hospital|transport|transit|service|safety|housing)\b/iu.test(text);
    const proceduralPenalty = /\b(call to order|adjournment|declaration|minutes|verbal report|for information only)\b/iu.test(text) ? 1 : 0;
    const adminPenalty = /\b(consent agenda|by-?law|agreement|administrative|assignment)\b/iu.test(text) ? 1 : 0;
    const decisionImpact = /\b(approved|adopted|carried|rejected|deferred|defeated|voted)\b/iu.test(text) ? 1 : 0;
    const directPublicImpact = /\b(resident|public|hospital|access|food|cost|service|mobility|safety)\b/iu.test(text);
    if (sustained) s += 10;
    if (humanImpact) s += 8;
    if (humanImpact && sustained) s += 8;
    if (decisionImpact) s += 4;
    if (adminPenalty && !directPublicImpact) s -= 8;
    if (!sustained && adminPenalty) s -= 12;
    if (proceduralPenalty) s -= 10;
    s -= crossJurisdictionLeadPenalty(item, opts.jurisdiction || "");
    return s;
  };
  return [...rows].sort((a, b) => rank(b) - rank(a))[0] || rows[0];
}

function buildGuaranteedSingleSentence({ dateLong, jurisdiction, body, leadTop }) {
  const date = String(dateLong || "").trim() || "April 27, 2026";
  const civicBody = normalizeCivicBodyLabel(jurisdiction, body);
  const title = String(leadTop?.title || leadTop?.heading || "").replace(/\s+/gu, " ").trim();
  let cleanedTitle = title
    .replace(/^[^A-Za-z0-9]+/u, "")
    .replace(/^[Tt]he\s+/u, '')
    .replace(/\b(blocked by|stalled by)\b/giu, 'barriers involving')
    .replace(/[,:;\-–—]\s*$/u, "")
    .trim();
  cleanedTitle = cleanedTitle.split(/\b(while| and )\b/iu)[0].trim();
  cleanedTitle = cleanedTitle
    .replace(/[,;:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const words = cleanedTitle.split(/\s+/u).filter(Boolean);
  if (words.length > 12) cleanedTitle = words.slice(0, 12).join(" ");
  cleanedTitle = cleanedTitle.replace(/\s+/gu, ' ');
  if (cleanedTitle) {
    return `At its ${date} meeting, ${civicBody} discussed ${cleanedTitle}.`;
  }
  return `At its ${date} meeting, ${civicBody} discussed key local issues.`;
}

function buildDeterministicLeadSentence({ dateLong, jurisdiction, body, leadTop }) {
  const date = String(dateLong || "").trim() || "April 27, 2026";
  const civicBody = normalizeCivicBodyLabel(jurisdiction, body);
  let topic = cleanHeadlineText(String(leadTop?.title || leadTop?.heading || ""))
    .replace(/\*+/gu, "")
    .replace(/[.!?]+$/u, "")
    .replace(/^(first|second|third|fourth|fifth)[,:\s]+/iu, "")
    .replace(/^(the meeting (also )?featured|the meeting opened with|simultaneously|in addition|during the meeting|council discussed)\b[:,]?\s*/iu, "")
    .trim();
  if (!topic || isBadHeadlineFragment(topic) || /\b(and|or|to|of|for|with|from|in|on|at|by|during|while|where|that|which)\s*$/iu.test(topic)) {
    const alt = buildLeadTopicPhrase(leadTop);
    topic = String(alt || "").replace(/[.!?]+$/u, "").trim();
  }
  topic = String(topic || "").toLowerCase();
  if (!topic) topic = "local services";
  const headingText = `${String(leadTop?.heading || "")} ${String(leadTop?.title || "")}`.toLowerCase();
  if (/\b(public forum|resident|deputation|delegation)\b/iu.test(headingText)) {
    return `At its ${date} meeting, ${civicBody} heard resident concerns about ${topic}.`;
  }
  return `At its ${date} meeting, ${civicBody} discussed ${topic}.`;
}

function isBadHeadlineFragment(text = "") {
  const s = String(text || "").replace(/\s+/gu, " ").trim();
  if (!s) return true;
  if (/\*\*/u.test(s)) return true;
  if (/\.\.\.$/u.test(s)) return true;
  if (/[,:]\s*$/u.test(s)) return true;
  if (/\bwhere\s*$/iu.test(s)) return true;
  if (/^(the most consequential moment|the meeting also featured|simultaneously|in addition|during the meeting|council discussed)\b/iu.test(s)) return true;
  if (s.split(/\s+/u).filter(Boolean).length > 16) return true;
  return false;
}

function buildLeadTopicPhrase(leadTop = null) {
  const raw = [String(leadTop?.title || ""), String(leadTop?.body || ""), String(leadTop?.heading || "")]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!raw) return "";
  let s = raw
    .replace(/^[^A-Za-z0-9]+/u, "")
    .replace(/^(the most consequential (item|moment|action)( of the night)? was)\s+/iu, "")
    .replace(/^(the most consequential moment arrived during the public forum, where)\s+/iu, "")
    .replace(/^(simultaneously,?\s*)/iu, "")
    .replace(/^(administrative business included)\s+/iu, "")
    .replace(/^(the meeting (also )?featured)\s+/iu, "")
    .replace(/\b(council discussed|during the meeting)\b/giu, "")
    .replace(/\b(resident\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/gu, "residents")
    .replace(/[,;:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  s = s.split(/\b(while| and )\b/iu)[0].trim();
  const words = s.split(/\s+/u).filter(Boolean);
  if (words.length > 10) s = words.slice(0, 10).join(" ");
  return s.trim();
}

function normalizeChapterStyleStem(input) {
  let s = cleanHeadlineText(input);
  s = s.replace(/\*+/gu, "").replace(/\s+/gu, " ").trim();
  s = s.replace(/\b(the most consequential (item|moment|action)( of the night)? (came|arose|was|arrived)[^.]*)$/iu, "").trim();
  s = s.replace(/\b(the most pressing issue[^.]*)$/iu, "").trim();
  s = s.replace(/\b(minutes received[^.]*)$/iu, "").trim();
  s = s.replace(/[,:;.-]\s*$/u, "").trim();
  const words = s.split(/\s+/u).filter(Boolean);
  if (words.length > 8) s = words.slice(0, 8).join(" ");
  return s.trim();
}

function buildAssemblyHeadlineStem({ leadTop, fallbackHeading }) {
  const fromTitle = cleanHeadlineText(String(leadTop?.title || ""));
  if (fromTitle && !isBadHeadlineFragment(fromTitle)) return fromTitle;
  const topic = buildLeadTopicPhrase(leadTop);
  if (topic) {
    const headline = `Public Forum Concerns About ${topic}`.replace(/\s+/gu, " ").trim();
    if (!isBadHeadlineFragment(headline)) return headline;
  }
  const heading = String(fallbackHeading || "").toLowerCase();
  if (/\bpublic forum\b/iu.test(heading)) return "Public Forum Concerns";
  return "Resident Concerns";
}

function isVagueConcernOnlyStem(stem = "") {
  const s = String(stem || "").replace(/\s+/gu, " ").trim();
  if (!/\b(representative|resident|speaker|public|neighbou?rhood)\b/iu.test(s)) return false;
  if (!/\b(concerns?|voices?|raises?|raised)\b/iu.test(s)) return false;
  return !/\b(subdivision|frontage|lots?|housing|parking|snow|pedestrian|school|hazard|eighth|twenty|third|street|avenue|consent)\b/iu.test(s);
}

function isForbiddenTitleStem(stem = "") {
  const s = String(stem || "").replace(/\s+/gu, " ").trim();
  if (!s) return true;
  const n = s.toLowerCase().replace(/[^a-z0-9\s]/gu, " ").replace(/\s+/gu, " ").trim();
  if ([
    "budget fiscal approval",
    "fiscal approval",
    "budget approval",
    "budget fiscal review",
  ].includes(n)) return true;
  if (isVagueConcernOnlyStem(s)) return true;
  if (isProseHookStem(s)) return true;
  if (/\b(two[- ]decade|2[- ]decade|20[- ]year)\b/iu.test(s) && /\b(twenty|20)\s+years?\b/iu.test(s)) return true;
  if (/^(the most consequential|the meeting also|simultaneously|in addition|during the meeting|council discussed)\b/iu.test(s)) return true;
  if (/\b(where|during the)\s*$/iu.test(s)) return true;
  if (/,\s*$/u.test(s)) return true;
  const words = s.split(/\s+/u).filter(Boolean);
  if (words.length > 12) return true;
  if (/\b(and|or|to|of|for|with|from|in|on|at|by|during|while|where|that|which)\s*$/iu.test(s)) return true;
  return false;
}

function isProseHookStem(stem = "") {
  const s = String(stem || "").replace(/\s+/gu, " ").trim();
  if (!s) return true;
  return /^(the successful|a proposed|an? presentation|the presentation|the committee|the council|staff presented|staff proposed|council approved|council requested|motion to|speaker\s+\d+\b|representative voices?|resident voices?|residents voice)\b/iu.test(s);
}

function isStrictChapterStyleHook(hook, { jurisdiction = "", body = "" } = {}) {
  const s = String(hook || "").replace(/\s+/gu, " ").trim();
  if (!s) return false;
  const words = s.split(/\s+/u).filter(Boolean);
  if (words.length < 4 || words.length > 6) return false;
  if (/[*_#`]/u.test(s)) return false;
  if (/[.!?,:;()[\]{}]/u.test(s)) return false;
  if (/^(the most consequential|the meeting also|simultaneously|in addition|during the meeting|council discussed)\b/iu.test(s)) return false;
  if (/\b(where|during the)\s*$/iu.test(s)) return false;
  const genericMeetingWords = new Set([
    "council",
    "committee",
    "community",
    "county",
    "city",
    "meeting",
    "regular",
    "regional",
    "service",
    "services",
    "special",
    "board",
    "session",
    "agenda",
    "preview",
  ]);
  const bannedParts = [String(jurisdiction || "")]
    .flatMap((x) => x.split(/[^A-Za-z0-9]+/u))
    .map((x) => x.trim())
    .filter((x) => x.length >= 3)
    .filter((x) => !genericMeetingWords.has(x.toLowerCase()));
  for (const part of bannedParts) {
    if (new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(s)) return false;
  }
  const bodySignalWords = String(body || "")
    .split(/[^A-Za-z0-9]+/u)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4)
    .filter((x) => !genericMeetingWords.has(x.toLowerCase()));
  if (bodySignalWords.length >= 2) {
    const bodyPhrase = bodySignalWords
      .map((x) => x.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("\\s+");
    if (new RegExp(`\\b${bodyPhrase}\\b`, "iu").test(s)) return false;
  }
  return true;
}

function chooseSectionFallbackStem(leadTop = null) {
  const heading = String(leadTop?.heading || "");
  const merged = `${String(leadTop?.title || "")} ${heading} ${String(leadTop?.body || "")}`.toLowerCase();
  if (/\bpublic forum\b/iu.test(heading)) return "Public Forum Concerns";
  if (/\b(public|resident|residents|deputation|delegation)\b/iu.test(merged)) return "Resident Concerns";
  return "Council Meeting Highlights";
}

function isValidHookTitle(hook) {
  const s = String(hook || '').replace(/\s+/gu, ' ').trim();
  if (!s) return false;
  if (s.split(/\s+/u).length < 4 || s.split(/\s+/u).length > 6) return false;
  if (isProseHookStem(s)) return false;
  if (/^(the most consequential|the meeting also|simultaneously|in addition|during the meeting|council discussed)\b/iu.test(s)) return false;
  if (/\b(where|during the)\s*$/iu.test(s)) return false;
  if (/\.\.\.|[*_#`]/u.test(s)) return false;
  if (/[.!?,:;()[\]{}]/u.test(s)) return false;
  return true;
}

function chooseRecapHookTitle({ currentHook, ranked }) {
  const items = Array.isArray(ranked) ? ranked : [];
  const leadTop = items[0] || null;
  const leadText = (String(leadTop?.heading || '') + ' ' + String(leadTop?.body || '')).toLowerCase();
  const preferred = String(leadTop?.title || '').trim();
  if (isValidHookTitle(preferred)) return preferred;
  const leadTitle = String(leadTop?.title || '').trim();
  if (isValidHookTitle(leadTitle)) return leadTitle;
  const candidate = String(currentHook || '').trim();
  if (isValidHookTitle(candidate)) return candidate;
  return 'Key Council Decisions Reviewed';
}

async function generateOneSentenceSummaryLlm({
  transcriptDir,
  normPrefix,
  focus,
  jurisdiction,
  body,
  wholeAgendaSummary,
  topNewsMarkdown,
  scheduleContext,
  leadTop = null,
  strict = false,
}) {
  const full = String(wholeAgendaSummary || '').trim();
  const top = String(topNewsMarkdown || '').trim();
  const sourceText = [
    leadTop ? `LEAD NEWS ITEM (PRIORITY SOURCE):\n${String(leadTop?.title || "").trim()}: ${String(leadTop?.body || leadTop?.summary || "").trim()}` : "",
    full ? `WHOLE AGENDA SUMMARY:\n${full}` : '',
    top ? `TOP NEWSWORTHY AGENDA ITEMS:\n${top}` : '',
  ].filter(Boolean).join('\n\n').trim();
  if (!sourceText) return '';

  const sourcePath = path.join(transcriptDir, `${normPrefix}.one-sentence-source.txt`);
  fs.writeFileSync(sourcePath, `${sourceText}\n`, 'utf8');

  const prompt = [
    'Write exactly one sentence for a civic meeting article teaser.',
    `Focus: ${String(focus || '').trim() || 'newsworthy civic decisions'}.`,
    `Civic body: ${normalizeCivicBodyLabel(jurisdiction, body)}.`,
    'Constraints: 18-32 words; present/past tense appropriate to a completed meeting; concrete; no ellipses; no semicolons; no bullet/list format.',
    'Use neutral factual wording: discussed, considered, voted, deferred, approved, rejected.',
    'Do not use ideological or advocacy framing: distributive justice, overreach, vulnerable residents, protecting workers, victory, crisis.',
    'Do not claim motive or causality unless explicit in source.',
    'Preferred structure: On <date>, <civic body> <action> <topic> ...',
    'Hard priority: center the sentence on LEAD NEWS ITEM; do not switch to a secondary topic unless lead text is empty.',
    'Use one development from LEAD NEWS ITEM only; do not stitch in facts, actors, or requests from other agenda items.',
    'If LEAD NEWS ITEM is from public forum/deputation/presentation, attribute claims to participants/speakers (for example "raised at the meeting"), not to members.',
    'For a deputation request, say Council heard or discussed the deputation seeking the requested action; never recast the presenter request as a staff request or Council action.',
    'If the lead source records a request but no disposition, do not mention any vote, approval, rejection, direction, or decision.',
    strict ? 'Hard rule: exactly one complete sentence with one main development only; no stitched multi-item list.' : '',
    scheduleContext ? `Include these meeting details when possible: ${scheduleContext}.` : 'If meeting date/time/location details are provided, include them naturally.',
    'Use distinct wording from the whole agenda summary.',
    '',
    sourceText,
  ].join('\n');

  let first = '';
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      first = String(await requestOllamaChat([
        { role: 'system', content: 'You write concise civic meeting teasers.' },
        { role: 'user', content: prompt },
      ], { numPredict: 96, retryAttempts: 3, retryDelayMs: 2500 }))
        .split(/\r?\n/u)
        .map((x) => x.trim())
        .find(Boolean) || '';
      if (first) break;
      lastError = 'empty response content';
    } catch (err) {
      lastError = String(err?.message || err || 'unknown fetch error');
    }
  }
  if (!first) {
    throw new Error(`one-sentence summary LLM failed via qwen transport (${lastError || 'no response'})`);
  }
  const compact = first.replace(/\s+/gu, ' ').trim();
  const picked = (compact.match(/^(.+?[.!?])(?:\s|$)/u)?.[1] || compact).trim();
  const one = simplifyOneSentenceLead(picked);
  if (!one) {
    throw new Error('one-sentence summary LLM returned unusable text via qwen transport');
  }
  return /[.!?]$/u.test(one) ? one : `${one}.`;
}

function oneSentenceMeetingCoverage(sentence = '', recapBlocks = []) {
  const sentenceTokens = new Set(normalizeSentenceForCompare(sentence)
    .split(' ')
    .filter((word) => word.length >= 5)
    .filter((word) => ![
      'council', 'meeting', 'report', 'committee', 'agenda', 'owen', 'sound',
      'july', 'heard', 'considered', 'discussed', 'approved', 'adopted',
    ].includes(word)));
  const coveredIndexes = [];
  for (let index = 0; index < recapBlocks.length; index += 1) {
    const block = recapBlocks[index] || {};
    const sourceTokens = [...new Set(normalizeSentenceForCompare(
      `${String(block.heading || '')} ${String(block.summary || '')}`
    ).split(' ')
      .filter((word) => word.length >= 5)
      .filter((word) => ![
        'council', 'meeting', 'report', 'committee', 'agenda', 'owen', 'sound',
        'july', 'heard', 'considered', 'discussed', 'approved', 'adopted',
      ].includes(word)))];
    const hits = sourceTokens.filter((word) => sentenceTokens.has(word)).length;
    if (hits >= Math.min(2, sourceTokens.length)) coveredIndexes.push(index);
  }
  return { count: coveredIndexes.length, indexes: coveredIndexes };
}

async function generateMeetingWideOneSentenceLlm({
  recapBlocks,
  wholeAgendaSummary,
  jurisdiction,
  body,
  scheduleContext,
  allowProcedural = false,
  groundedSectionCount = 0,
  articleVerificationFeedback = '',
}) {
  const blocks = (Array.isArray(recapBlocks) ? recapBlocks : [])
    .filter((block) => String(block?.heading || '').trim() && String(block?.summary || '').trim())
    .filter((block) => allowProcedural || sectionLooksSubstantive(block));
  // A short committee meeting can legitimately execute one substantive
  // attachment-backed report, with the remaining grounded sections being
  // opening, minutes, or empty headings. Permit that shape only when the
  // recap still contains multiple canonical sections and the surviving item
  // has a non-empty generated substantive overview; a collapsed one-section chronology must continue to
  // fail closed instead of producing a teaser from an opening fragment.
  const singleSubstantiveMeeting = !allowProcedural
    && blocks.length === 1
    && Number(groundedSectionCount) >= 2;
  const minimumBlocks = allowProcedural ? 1 : (singleSubstantiveMeeting ? 1 : 2);
  if (blocks.length < minimumBlocks) throw new Error(`meeting-wide teaser requires at least ${minimumBlocks === 1 ? 'one' : 'two'} ${allowProcedural ? 'grounded recap item' : 'substantive recap items'}`);
  const targetCount = Math.min(3, blocks.length);
  const chosenIndexes = targetCount === 2
    ? [0, blocks.length - 1]
    : [...new Set([0, Math.floor((blocks.length - 1) / 2), blocks.length - 1])];
  const chosenBlocks = chosenIndexes.map((index) => blocks[index]).filter(Boolean);
  if (chosenBlocks.length < targetCount) throw new Error('meeting-wide teaser could not select complete chronological recap coverage');
  const source = chosenBlocks.map((block, index) =>
    `${index + 1}. ${String(block.heading || '').trim()}: ${String(block.summary || '').replace(/\s+/gu, ' ').trim()}`
  ).join('\n');
  const coverageAnchors = chosenBlocks.map((block, index) => {
    const headingWords = String(block.heading || '')
      .replace(/[^A-Za-z0-9 ]/gu, ' ')
      .split(/\s+/u)
      .filter((word) => word.length >= 5)
      .filter((word) => !['council', 'meeting', 'report', 'committee', 'agenda'].includes(word.toLowerCase()))
      .slice(0, 4);
    return `${index + 1}. ${headingWords.join(', ') || String(block.heading || '').trim()}`;
  }).join('\n');
  const authoritativeRoleConstraint = agendaRoleConstraint(chosenBlocks.map((block) => [
    String(block.heading || ''),
    String(block.summary || ''),
    ...(Array.isArray(block.authoritativeAgendaEvidence) ? block.authoritativeAgendaEvidence : []),
  ].join(' ')));
  const prompt = [
    'Write exactly one sentence summarizing the meeting as a whole.',
    `Civic body: ${normalizeCivicBodyLabel(jurisdiction, body)}.`,
    scheduleContext ? `Meeting context: ${scheduleContext}.` : '',
    `Use 24-68 words and cover exactly ${targetCount} distinct ${allowProcedural ? 'grounded recap items' : 'substantive agenda items'}.`,
    targetCount > 1 ? 'Choose items from different parts of the supplied recap, including at least one item from the latter half.' : 'This meeting has one substantive agenda item; cover that item without inventing additional business.',
    `Use ${targetCount} separate clauses, one clause per chosen numbered recap item, and never move a fact from one item into another clause.`,
    'Each clause must retain at least two distinctive words from its matching numbered recap item heading or summary so the generated sentence remains independently traceable to every selected item. Do not omit an item merely because its heading is procedural; use its supplied grounded action with a neutral verb.',
    'Preserve the agenda role in each clause: identify Public Forum comments as comments from Public Forum participants, and identify a deputation only as a deputation.',
    allowProcedural ? 'This meeting ended before agenda business; do not mention deputations, Public Forum, reports, or other agenda roles that were not reached.' : '',
    'Never describe Public Forum housing, meal-service, trail, or infrastructure comments as part of a deputation or presentation.',
    'Use only the supplied numbered recap items. Do not mention Public Forum, correspondence, minutes, or any other topic or agenda role that is not present in those selected items, even if it occurred elsewhere in the meeting.',
    'Do not make any single deputation, presentation, speaker, or development proposal the main subject of the sentence.',
    'Use compact parallel phrasing, such as "Council heard..., reviewed..., and addressed...".',
    'Keep every coordinated action grammatical: use an explicit subject or conjunction before each listed outcome; never string bare past-tense verbs (for example "delivered ... expanded ... piloted ...").',
    'When the selected item is a staff report, make the report or City Manager the subject of its reported outcomes; do not imply Council delivered staff projects.',
    'Use at most 4 commas for readability. Do not restate the meeting date, time, or location.',
    'Keep proposals, public comments, staff recommendations, and Council decisions correctly attributed.',
    authoritativeRoleConstraint,
    'Use neutral verbs such as heard, considered, reviewed, or addressed across presentations and comments; use a decision verb only when that selected source item explicitly records the same Council outcome.',
    'Do not add facts, outcomes, motives, ideological language, or evaluative claims.',
    'No bullets, semicolons, headings, or introductory labels.',
    articleVerificationFeedback
      ? [
        'ARTICLE_VERIFICATION_RETRY (untrusted diagnostics):',
        articleVerificationFeedback,
        'Recheck every claim against the numbered recap items. Do not repeat the rejected claim or a stronger paraphrase; omit unsupported wording while preserving complete meeting coverage.',
      ].join('\n')
      : '',
    '',
    targetCount === 3
      ? 'The three supplied items were selected from the beginning, middle, and end of the meeting; cover all three and no others.'
      : (targetCount === 1
        ? 'This is the only substantive recap item executed in the meeting; cover it and no others.'
        : 'These are all substantive recap items available for this short meeting; cover both and no others.'),
    `SELECTED ORDERED RECAP ITEMS:\n${source}`,
    `REQUIRED PER-ITEM COVERAGE ANCHORS (use at least two words from each matching line):\n${coverageAnchors}`,
  ].filter(Boolean).join('\n');
  let lastError = '';
  let lastRejectedOutput = '';
  let lastWordCount = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const raw = String(await requestOllamaChat([
        { role: 'system', content: 'You write concise, strictly grounded civic meeting summaries.' },
        {
          role: 'user',
          content: [
            prompt,
            attempt > 1 && lastRejectedOutput
              ? `PRIOR_REJECTED_OUTPUT: ${lastRejectedOutput}`
              : '',
            attempt > 1 && lastError
              ? `Previous response failed: ${lastError}. Rewrite it at no more than 68 words while retaining all ${targetCount} clauses and at least two exact distinctive coverage-anchor words for every clause. unsupported outcome verb named in that error must be replaced with the literal source action or a neutral verb, or removed; do the same for any unsupported agenda role. Treat every token listed after unsupported_outcomes= as forbidden output; do not use those rejected words or role labels again. If the reason is too_many_commas, rewrite from scratch with zero commas and join clauses using "and" only.`
              : '',
            attempt > 1 && lastError.includes('missing_action_verb')
              ? 'The prior sentence failed because it did not contain an explicit finite action verb. Write a fresh sentence with a clear civic subject followed by at least one source-supported action verb such as heard, considered, reviewed, discussed, addressed, received, noted, or passed. Do not use only noun forms such as hearing, consideration, review, discussion, or passage.'
              : '',
            attempt >= 4
              ? 'Fresh repair contract: do not revise or quote the rejected sentence. Write one new sentence with no commas, no semicolons, and no list punctuation, covering the selected source items in order with neutral verbs.'
              : '',
            attempt > 1 && lastWordCount
              ? `Previous response contained ${lastWordCount} words; the valid range is 24-68. Remove at least ${Math.max(1, lastWordCount - 64)} words from that rejected sentence. Return exactly 48-64 words, still as one complete sentence with all ${targetCount} source-grounded clauses.`
              : '',
          ].filter(Boolean).join('\n\n'),
        },
      ], {
        numPredict: 128,
        retryAttempts: 3,
        retryDelayMs: 2500,
      })).replace(/\s+/gu, ' ').trim();
      lastRejectedOutput = raw.slice(0, 1200);
      const parts = splitCivicSentences(raw);
      if (parts.length !== 1) {
        lastError = `expected one sentence, received ${parts.length}`;
        continue;
      }
      const candidate = /[.!?]$/u.test(parts[0]) ? parts[0] : `${parts[0]}.`;
      const words = candidate.split(/\s+/u).filter(Boolean).length;
      lastWordCount = words;
      const coverage = oneSentenceMeetingCoverage(candidate, chosenBlocks);
      const hasLatterHalf = coverage.indexes.some((index) => index >= Math.floor(chosenBlocks.length / 2));
      const unsupportedOutcomeVerbs = unsupportedCivicOutcomeVerbs(
        candidate,
        chosenBlocks.map((block) => `${String(block.heading || '')} ${String(block.summary || '')}`),
      );
      const unsupportedRoles = allowProcedural ? [] : unsupportedAgendaRoles(
        candidate,
        chosenBlocks.map((block) => `${String(block.heading || "")} ${String(block.summary || "")}`),
      );
      const malformedReason = explainMalformedOneSentence(candidate, {
        jurisdiction,
        body,
        allowMeetingSectionPhrases: true,
        maxWords: MEETING_TEASER_MAX_WORDS,
      });
      if (malformedReason || words < 24 || words > MEETING_TEASER_MAX_WORDS || coverage.count < targetCount || !hasLatterHalf
        || unsupportedOutcomeVerbs.length || unsupportedRoles.length) {
        lastError = words < 24 || words > MEETING_TEASER_MAX_WORDS
          ? `word count ${words} is outside the required 24-68 range`
          : malformedReason
          ? `invalid teaser contract: ${malformedReason}`
          : `invalid breadth words=${words} covered=${coverage.count} latter_half=${hasLatterHalf} unsupported_outcomes=${unsupportedOutcomeVerbs.join(',') || 'none'} unsupported_roles=${unsupportedRoles.join(',') || 'none'}`;
        continue;
      }
      lastRejectedOutput = '';
      lastWordCount = 0;
      return candidate;
    } catch (err) {
      lastError = String(err?.message || err || 'unknown fetch error');
    }
  }
  throw new Error(`meeting-wide one-sentence summary failed (${lastError || 'no valid response'})`);
}

function oneSentenceMatchesLeadTopic(sentence = "", leadTop = null) {
  const s = normalizeSentenceForCompare(sentence);
  if (!s) return false;
  const lead = normalizeSentenceForCompare(`${String(leadTop?.title || "")} ${String(leadTop?.body || leadTop?.summary || "")}`);
  if (!lead) return true;
  const leadTokens = lead
    .split(" ")
    .filter((w) => w.length >= 5)
    .filter((w) => !["council", "meeting", "committee", "report", "discussion", "discussed", "considered"].includes(w))
    .slice(0, 24);
  if (!leadTokens.length) return true;
  let hits = 0;
  for (const t of leadTokens) {
    if (s.includes(t)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

async function generateOneSentenceFromLeadOnlyLlm({
  leadTop,
  focus,
  jurisdiction,
  body,
  scheduleContext,
}) {
  const lead = String(leadTop?.body || leadTop?.summary || "").replace(/\s+/gu, " ").trim();
  if (!lead) return "";
  const prompt = [
    "Write exactly one sentence for a civic meeting article teaser from LEAD_ITEM only.",
    `Focus: ${String(focus || "").trim() || "newsworthy civic decisions"}.`,
    `Civic body: ${normalizeCivicBodyLabel(jurisdiction, body)}.`,
    "Constraints: 14-26 words; one main development only; no commas unless required; no lists; no semicolons.",
    "Do not upgrade proposals/discussion into approvals or outcomes unless LEAD_ITEM explicitly says approved/passed/carried/adopted.",
    "Prefer neutral verbs: discussed, heard, considered, proposed.",
    scheduleContext ? `Meeting context: ${scheduleContext}.` : "",
    "",
    `LEAD_ITEM: ${lead}`,
  ].join("\n");
  let first = "";
  try {
    first = String(await requestOllamaChat([
      { role: "system", content: "You write concise factual civic meeting teasers." },
      { role: "user", content: prompt },
    ], { numPredict: 72, retryAttempts: 3, retryDelayMs: 2500 }))
      .split(/\r?\n/u).map((x) => x.trim()).find(Boolean) || "";
  } catch {
    return "";
  }
  if (!first) return "";
  const one = simplifyOneSentenceLead(first.replace(/\s+/gu, " ").trim());
  if (!one) return "";
  return /[.!?]$/u.test(one) ? one : `${one}.`;
}

async function generateWholeSummaryFromRecapLlm({
  recapBlocks,
  focus,
  scheduleContext,
  strict = false,
}) {
  const blocks = Array.isArray(recapBlocks) ? recapBlocks : [];
  const recapSource = blocks
    .map((b) => {
      const heading = String(b?.heading || '').trim();
      const summary = String(b?.summary || '').replace(/\s+/gu, ' ').trim();
      if (!heading || !summary) return '';
      return `- ${heading}: ${summary}`;
    })
    .filter(Boolean)
    .join('\n');
  if (!recapSource) throw new Error('whole-summary-from-recap: empty recap source');

  const prompt = [
    'Write a Whole Meeting Summary paragraph from SOURCE_RECAP only.',
    `Focus: ${String(focus || '').trim() || 'newsworthy civic developments'}.`,
    'Constraints: 6-8 sentences, 130-220 words, factual, neutral municipal tone.',
    'Cover at least five distinct SOURCE_RECAP agenda items spanning the beginning, middle, and end of the meeting.',
    'Do not spend more than two sentences on any single agenda item.',
    `Write exactly ${blocks.length} sentences: one sentence for each SOURCE_RECAP bullet, in the same order, without combining or skipping bullets.`,
    'Do not invent votes, approvals, service launches, or motives.',
    'A request or proposal made during a deputation, presentation, public meeting, or public forum is not Council direction or a Council decision.',
    'Never say Council or leadership directed, authorized, approved, endorsed, adopted, or rejected something unless SOURCE_RECAP explicitly records that action.',
    'Do not attribute statements to named individuals; avoid speaker names entirely.',
    'If speaker identity is uncertain, use neutral phrasing like "a speaker" or "a council member".',
    'Do not mention empty procedural items (for example no submissions/no scheduled sessions).',
    strict ? 'Hard rule: include only developments explicitly present in SOURCE_RECAP.' : '',
    scheduleContext ? `Meeting context: ${scheduleContext}.` : '',
    '',
    'SOURCE_RECAP:',
    recapSource,
  ].join('\n');

  const scorePrompt = [
    'Verify SUMMARY against SOURCE_RECAP for factual faithfulness.',
    'Fail if SUMMARY introduces claims not present in SOURCE_RECAP or flips polarity/agency.',
    'Fail if SUMMARY attributes claims to named individuals not explicitly and reliably supported by SOURCE_RECAP.',
    'Fail if SUMMARY covers fewer than five distinct SOURCE_RECAP bullets or fails to include items from the beginning, middle, and end of SOURCE_RECAP.',
    scheduleContext ? `ALLOWED_MEETING_CONTEXT: ${scheduleContext}. Metadata from this line is allowed in SUMMARY.` : '',
    'Output first line feedback, final line exactly PASS or FAIL.',
    '',
    'SOURCE_RECAP:',
    recapSource,
    '',
    'SUMMARY:',
    '[[SUMMARY]]',
  ].join('\n');

  let best = '';
  let bestPass = false;
  let lastErr = '';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let draft = '';
    try {
      draft = anonymizeSpeakerAttributions(String(await requestOllamaChat([
        { role: 'system', content: 'You write concise factual civic summaries.' },
        { role: 'user', content: prompt },
      ], { numPredict: 320, retryAttempts: 3, retryDelayMs: 2500 })).replace(/\s+/gu, ' ').trim());
      if (!draft) {
        lastErr = 'whole-summary-generate empty';
        continue;
      }
      const draftSentences = splitCivicSentences(draft);
      if (draftSentences.length !== blocks.length) {
        lastErr = `coverage_shape_fail: expected ${blocks.length} sentences, received ${draftSentences.length}`;
        best = draft;
        continue;
      }
      const ignoredCoverageWords = new Set([
        'about', 'after', 'agenda', 'council', 'during', 'meeting', 'owen', 'report', 'sound', 'their', 'there', 'these', 'those', 'which', 'while', 'with',
      ]);
      const coverageAligned = blocks.every((block, index) => {
        const sourceNorm = normalizeSentenceForCompare(`${String(block?.heading || '')} ${String(block?.summary || '')}`);
        const sentenceNorm = normalizeSentenceForCompare(draftSentences[index] || '');
        const terms = [...new Set(sourceNorm.split(' ').filter((word) => word.length >= 5 && !ignoredCoverageWords.has(word)))];
        let hits = 0;
        for (const term of terms) {
          if (sentenceNorm.includes(term)) hits += 1;
          if (hits >= 2) return true;
        }
        return terms.length < 2 && terms.every((term) => sentenceNorm.includes(term));
      });
      if (!coverageAligned) {
        lastErr = 'coverage_alignment_fail: generated sentences did not follow SOURCE_RECAP bullet order';
        best = draft;
        continue;
      }
      const review = String(await requestOllamaChat([
        { role: 'system', content: 'You are a strict semantic verifier for civic summaries.' },
        { role: 'user', content: scorePrompt.replace('[[SUMMARY]]', draft) },
      ], { numPredict: 120, retryAttempts: 3, retryDelayMs: 2500 })).trim();
      const lastLine = review.split(/\r?\n/u).map((x) => x.trim()).filter(Boolean).at(-1) || '';
      const pass = /^PASS$/iu.test(lastLine);
      best = draft;
      bestPass = pass;
      if (pass) break;
      lastErr = `verifier_fail: ${review.slice(0, 200)}`;
    } catch (err) {
      lastErr = String(err?.message || err || 'unknown');
    }
  }
  if (!best || !bestPass) throw new Error(`whole-summary-from-recap verifier failed (${lastErr || 'no-pass'})`);
  return /[.!?]$/u.test(best) ? best : `${best}.`;
}

async function generateWholeSummaryFromRecapItemsLlm({
  recapBlocks,
  focus,
  scheduleContext,
  articleVerificationFeedback = '',
}) {
  const blocks = Array.isArray(recapBlocks) ? recapBlocks : [];
  if (!blocks.length) throw new Error('whole-summary-items: empty recap source');
  const sentences = [];
  const ignored = new Set(['about', 'agenda', 'council', 'during', 'meeting', 'owen', 'report', 'sound', 'their', 'there', 'these', 'those', 'which', 'while', 'with']);
  const meetingDate = String(scheduleContext || '').match(/^date\s+(.+?)(?=,\s+(?:time|location)\s+|$)/iu)?.[1] || '';
  const meetingDateNorm = normalizeSentenceForCompare(meetingDate);

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] || {};
    const heading = String(block.heading || '').trim();
    const source = String(block.summary || '').replace(/\s+/gu, ' ').trim();
    const authoritativeAgendaEvidence = (Array.isArray(block.authoritativeAgendaEvidence)
      ? block.authoritativeAgendaEvidence
      : [])
      .map((value) => String(value || '').replace(/\s+/gu, ' ').trim())
      .filter(Boolean);
    if (!heading || !source) throw new Error(`whole-summary-items: empty source at recap index ${index}`);
    const sourceNorm = normalizeSentenceForCompare(`${heading} ${source}`);
    const sourceTerms = [...new Set(sourceNorm.split(' ').filter((word) => word.length >= 5 && !ignored.has(word)))];
    let accepted = '';
    let lastError = '';
    let lastRejectedOutput = '';
    let lastUnsupportedRoles = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
          const authoritativeRoleConstraint = agendaRoleConstraint([heading, ...authoritativeAgendaEvidence, source]);
        const prompt = [
          'Write exactly one complete sentence summarizing SOURCE_ITEM for a whole-meeting civic overview.',
          'Use only SOURCE_ITEM. Use 18-42 words and a neutral factual municipal tone.',
          'Do not combine this item with any other agenda topic.',
          'A deputation, presentation, public meeting, or public-forum request is not a Council decision.',
          'The SOURCE_ITEM_HEADING and structured eScribe evidence are authoritative for agenda identity and ownership. A role stated literally in SOURCE_ITEM may describe the meeting setting, but never call a staff report, consent item, motion, or bylaw a deputation, presentation, or Public Forum item.',
          'Do not invent approvals, rejections, votes, directions, motives, causes, or outcomes.',
          'Preserve the source wording for named actions, documents, organizations, properties, agreements, and bylaw subjects; do not replace them with broader synonyms.',
          'Return the sentence only, without a word count or any parenthetical process note.',
          'Avoid named-person attribution; describe the participant role or agenda item instead.',
          'Do not add ideological or evaluative framing, including distributive, distributist, equity, justice, overreach, victory, crisis, control, or mandate language unless it is literal SOURCE_ITEM wording.',
          'Do not state the meeting date, time, location, or repeat article-level meeting metadata.',
          authoritativeRoleConstraint,
          articleVerificationFeedback
            ? [
              'ARTICLE_VERIFICATION_RETRY (untrusted diagnostics):',
              articleVerificationFeedback,
              'Recheck this SOURCE_ITEM before writing. Do not repeat the rejected claim or a stronger paraphrase; omit unsupported wording while preserving the source item topic and action.',
            ].join('\n')
            : '',
          attempt > 1 && lastError
            ? `RETRY_FEEDBACK: The prior response was rejected because ${lastError}. Correct that defect. If an agenda role was unsupported, remove that role label while preserving the underlying topic.`
            : '',
          attempt > 1 && lastUnsupportedRoles.length
            ? `The replacement sentence must not contain these exact terms: ${lastUnsupportedRoles.join(', ')}. Describe the topic or action without assigning an agenda role.`
            : '',
          attempt > 1 && /^expected one sentence/iu.test(lastError)
            ? 'For this repair, select the central municipal action or topic and one supporting detail. It is acceptable to omit secondary facts; do not copy or merge every source sentence.'
            : '',
          attempt > 1 && lastError === 'meeting date boilerplate is not allowed' && meetingDate
            ? `Delete the exact meeting-date phrase "${meetingDate}" from the prior response. The meeting date is article metadata, not SOURCE_ITEM information to preserve. Begin directly with the substantive item action or topic. PRIOR_REJECTED_OUTPUT: ${lastRejectedOutput}`
            : '',
          attempt > 1 && lastRejectedOutput
            && !/^expected one sentence/iu.test(lastError)
            && lastError !== 'meeting date boilerplate is not allowed'
            ? `PRIOR_REJECTED_OUTPUT: ${lastRejectedOutput}\nRewrite all of its grounded information as one grammatical sentence with clauses; do not select only its opening sentence.`
            : '',
          `SOURCE_ITEM_HEADING: ${heading}`,
          authoritativeAgendaEvidence.length
            ? `STRUCTURED_ESCRIBE_EVIDENCE:\n${authoritativeAgendaEvidence.map((value) => `- ${value}`).join('\n')}`
            : '',
          `SOURCE_ITEM: ${source}`,
        ].filter(Boolean).join('\n');
        const raw = String(await requestOllamaChat([
          { role: 'system', content: 'You write one strictly grounded civic summary sentence.' },
          { role: 'user', content: prompt },
        ], {
          numPredict: attempt > 1 ? 180 : 110,
          retryAttempts: 3,
          retryDelayMs: 2500,
        })).replace(/\s+/gu, ' ').trim();
        lastRejectedOutput = raw.slice(0, 1200);
        // Do not treat agenda/report abbreviations such as "No. 58" as a
        // sentence boundary. A genuine second sentence begins with a letter.
        const parts = splitCivicSentences(raw);
        if (parts.length !== 1) {
          lastError = `expected one sentence, received ${parts.length}`;
          continue;
        }
        const candidate = parts[0];
          const unsupportedRoles = unsupportedAgendaRoles(candidate, [heading, ...authoritativeAgendaEvidence, source]);
        if (unsupportedRoles.length) {
          lastUnsupportedRoles = unsupportedRoles;
          lastError = `agenda role mismatch: ${unsupportedRoles.join(', ')} absent from authoritative heading`;
          continue;
        }
        const candidateNorm = normalizeSentenceForCompare(candidate);
        if (meetingDateNorm && candidateNorm.includes(meetingDateNorm)) {
          lastError = 'meeting date boilerplate is not allowed';
          continue;
        }
        let hits = 0;
        for (const term of sourceTerms) if (candidateNorm.includes(term)) hits += 1;
        if (sourceTerms.length >= 2 && hits < 2) {
          lastError = `source alignment failed with ${hits} keyword hits`;
          continue;
        }
        accepted = candidate;
        lastRejectedOutput = '';
        lastUnsupportedRoles = [];
        break;
      } catch (err) {
        lastError = String(err?.message || err || 'unknown');
      }
    }
    if (!accepted) throw new Error(`whole-summary-items retryable: item ${heading} failed (${lastError || 'no valid output'})`);
    sentences.push(accepted);
  }
  return sentences.join(' ');
}

async function generateWholeSummaryFromTopNewsLlm({
  topNewsMarkdown,
  focus,
  scheduleContext,
}) {
  const src = String(topNewsMarkdown || "").trim();
  if (!src) throw new Error("whole-summary-top-news: empty top news source");
  const prompt = [
    "Write a Whole Meeting Summary paragraph using ONLY TOP_NEWS bullets.",
    `Focus: ${String(focus || "").trim() || "newsworthy civic developments"}.`,
    "Constraints: 4-6 sentences, 90-170 words, factual and neutral municipal tone.",
    "Write one sentence per TOP_NEWS bullet, in source order. Never combine two bullets into one sentence.",
    "Do not invent approvals/outcomes or motives. Do not include named speaker attribution.",
    "A staff recommendation is not a Council outcome, and a request made by a deputation or public-forum speaker is not Council direction.",
    "Do not describe Council as adopting, rejecting, declining, or remaining neutral on a request when TOP_NEWS does not explicitly record that disposition.",
    "Do not add ideological framing, causal conclusions, collective interpretations, or claims that the source developments form a broader strategy.",
    "Do not use causal connectors such as because, so that, in order to, this means, or this shows; report each source statement independently.",
    scheduleContext ? `Meeting context: ${scheduleContext}.` : "",
    "",
    "TOP_NEWS:",
    src,
  ].join("\n");
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const out = anonymizeSpeakerAttributions(String(await requestOllamaChat([
        { role: "system", content: "You write concise factual civic summaries." },
        { role: "user", content: prompt },
      ], { numPredict: 320, retryAttempts: 3, retryDelayMs: 2500 })).replace(/\s+/gu, " ").trim());
      if (!out) {
        lastErr = "whole-summary-top-news empty";
        continue;
      }
      return /[.!?]$/u.test(out) ? out : `${out}.`;
    } catch (err) {
      lastErr = String(err?.message || err || "unknown");
    }
  }
  throw new Error(`whole-summary-top-news failed (${lastErr || "no-response"})`);
}

async function main() {
  if (!process.env.PYA_RUNTIME_FILE) process.env.PYA_RUNTIME_FILE = path.join(HOUSE, "conduct", "runtime.pya");
  const resolvedOllamaHost = String(process.env.OLLAMA_HOST || "http://mriczo:11434").replace(/\/+$/u, "");
  if (!process.env.OLLAMA_HOST) process.env.OLLAMA_HOST = resolvedOllamaHost;
  const gpuHousekeeper = resolveGpuHousekeeperUrl({
    ollamaUrl: resolvedOllamaHost,
    env: process.env,
  });
  if (!process.env.PYA_GPU_HOUSEKEEPER_URL) process.env.PYA_GPU_HOUSEKEEPER_URL = gpuHousekeeper;
  log(`[llm] ollama host: ${resolvedOllamaHost}`);
  log(`[gpu] housekeeper: ${gpuHousekeeper}`);
  const transcriptDirArg = process.argv[2];
  const basePrefix = sanitizeBasePrefix(process.argv[3] || 'meeting-qwen-auto', 'meeting-qwen-auto');
  const focus = process.argv[4] || DEFAULT_FOCUS;
  const jurisdiction = process.argv[5] || 'Owen Sound';
  const body = process.argv[6] || 'Council';
  const siteUrl = process.argv[7] || DEFAULT_SITE;
  const discussionUrl = process.argv[8] || '';

  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const transcriptDir = resolveReporterPath(transcriptDirArg);
  ensureDir(transcriptDir);
  const meetingDir = path.dirname(transcriptDir);

  const baseVoicesDir = process.env.OWEN_VOICES_DIR || path.join(ROOT, 'world/voices');
  const requestedVoicesWorkDir = process.env.OWEN_VOICES_WORK_DIR || path.join(transcriptDir, 'voices-working');
  // Default to isolated working voices so global voice identities stay immutable.
  const isolateVoices = !/^(0|false|no)$/iu.test(String(process.env.PYA_SPEAKER_ISOLATE_VOICES || '1'));
  let voicesWorkDir = requestedVoicesWorkDir;
  try {
    ensureWritableDir(voicesWorkDir);
  } catch (err) {
    const fallback = path.join(os.tmpdir(), 'owen-voices-working', path.basename(meetingDir));
    ensureWritableDir(fallback);
    voicesWorkDir = fallback;
    log(`[full-pipeline] warn voices-working not writable: ${requestedVoicesWorkDir}`);
    log(`[full-pipeline] using fallback voices-working: ${voicesWorkDir}`);
  }
  const normPrefix = deriveNormalizedPrefix(basePrefix, 'meeting-qwen-auto');
  const activeVoicesDir = isolateVoices ? voicesWorkDir : baseVoicesDir;
  const namedSpeakerIdentity = namedSpeakerIdentityEnabled(process.env);
  const speakerHost = resolveSpeakerHost();
  const speakerHostRoot = resolveSpeakerHostRoot();
  const force = /^(1|true|yes)$/iu.test(String(process.env.OWEN_PIPELINE_FORCE || ''));
  const diarizeOnly = /^(1|true|yes)$/iu.test(String(process.env.OWEN_PIPELINE_DIARIZE_ONLY || ''));
  const skipImage = /^(1|true|yes)$/iu.test(String(process.env.OWEN_PIPELINE_SKIP_IMAGE || ''));
  const skipLemmy = /^(1|true|yes)$/iu.test(String(process.env.OWEN_PIPELINE_SKIP_LEMMY || ''));
  const forcePostStage =
    /^(1|true|yes)$/iu.test(String(process.env.OWEN_PIPELINE_FORCE_POST || '')) ||
    /^(1|true|yes)$/iu.test(String(process.env.PIPELINE_FORCE_POST || ''));
  const baseTimingSrt = path.join(transcriptDir, `${basePrefix}.timing.srt`);
  const basePlain = path.join(transcriptDir, `${basePrefix}.plain.txt`);
  const baseMerged = path.join(transcriptDir, `${basePrefix}.merged.srt`);

  const normalizedPlain = path.join(transcriptDir, `${normPrefix}.plain.txt`);
  const normalizedMeta = path.join(transcriptDir, `${normPrefix}.normalize.metadata.json`);
  const normalizedSentenceMerged = path.join(transcriptDir, `${normPrefix}.sentences.merged.srt`);
  const timedSentenceMerged = path.join(transcriptDir, `${basePrefix}.sentences.merged.srt`);
  const speakerJson = path.join(transcriptDir, `${normPrefix}.sentences.speaker.sentences.json`);
  const speakerSrt = path.join(transcriptDir, `${normPrefix}.sentences.speaker.sentence.srt`);
  const autoAssignReport = path.join(transcriptDir, `${normPrefix}.sentences.speaker.autoassign.report.json`);
  const agendaWiseSeries = path.join(transcriptDir, `${normPrefix}.agenda-wise.series.pya`);
  const agendaGrossChunksPya = path.join(transcriptDir, `${normPrefix}.agenda.gross-chunks.pya`);
  const agendaMatchesPya = path.join(transcriptDir, `${normPrefix}.agenda.matches.pya`);
  const agendaSectionGroundingPya = path.join(transcriptDir, `${normPrefix}.agenda.section-grounding.pya`);
  const canonicalAgendaIndex = path.join(meetingDir, 'converted', 'subreports.index.json');
  const agendaSummaryPya = path.join(transcriptDir, `${normPrefix}.agenda-summary.pya`);
  const agendaReferenceCorroborationPya = path.join(transcriptDir, `${normPrefix}.agenda-reference-corroboration.pya`);
  const meetingSummaryChunksPya = path.join(transcriptDir, `${normPrefix}.meeting-summary.chunks.pya`);
  const meetingSummaryPya = path.join(transcriptDir, `${normPrefix}.meeting-summary.pya`);
  const meetingSummaryMd = path.join(transcriptDir, `${normPrefix}.meeting-summary.md`);
  const meetingHookTxt = path.join(transcriptDir, `${normPrefix}.meeting-hook.txt`);
  const thumbnailSourceMd = path.join(transcriptDir, `${normPrefix}.thumbnail-source.md`);
  const htmlPath = path.join(transcriptDir, 'transcript-page.html');
  const coverImagePath = path.join(transcriptDir, `${normPrefix}.meeting-cover.png`);
  const coverImageStablePath = path.join(transcriptDir, 'meeting-cover.png');
  const lemmyPayloadPath = path.join(transcriptDir, `${normPrefix}.lemmy-post.json`);
  const lemmyBodyPath = path.join(transcriptDir, `${normPrefix}.lemmy-post.md`);
  const articleClaimsVerifyPath = path.join(transcriptDir, `${normPrefix}.article-claims.verify.pya`);

  const audioPath = path.join(transcriptDir, 'meeting-audio.opus');
  const audioSeconds = await ffprobeDurationSeconds(audioPath);
  log(`[full-pipeline] transcript dir: ${transcriptDir}`);
  log(`[full-pipeline] base prefix: ${basePrefix}`);
  log(`[full-pipeline] normalized prefix: ${normPrefix}`);
  log(`[full-pipeline] audio seconds: ${audioSeconds.toFixed(1)}`);

  const stageStatus = [];
  function latestSpeakerArtifactTime() {
    // Agenda segmentation consumes the speaker-labelled artifacts. Include
    // those outputs so a completed relabel/auto-assign pass cannot leave
    // agenda boundaries stale while the merged sentence inputs are unchanged.
    return Math.max(
      fileMtimeMs(normalizedSentenceMerged),
      fileMtimeMs(timedSentenceMerged),
      fileMtimeMs(speakerJson),
    );
  }

  function transcribeCheckpointValid() {
    // Require merged.srt so downstream sentence merge keeps punctuation from
    // qwen plain-text alignment instead of regressing to token-level timing text.
    if (!existsFile(baseTimingSrt) || !existsFile(basePlain)) return false;
    if (!existsFile(baseMerged)) return false;
    const plain = safeReadText(basePlain, '');
    if (!hasReasonablePunctuation(plain)) return false;
    return true;
  }

  function speakerCheckpointValid() {
    if (!existsFile(speakerJson) || !existsFile(speakerSrt)) return false;
    if (!namedSpeakerIdentity
      && (!speakerArtifactUsesDefaultLabels(speakerJson) || !speakerArtifactUsesDefaultLabels(speakerSrt))) return false;
    const normalizedTime = fileMtimeMs(normalizedSentenceMerged);
    if (normalizedTime > 0 && Math.min(fileMtimeMs(speakerJson), fileMtimeMs(speakerSrt)) < normalizedTime) return false;
    if (!sentenceCueQuality(speakerSrt).ok) return false;
    const expected = countSrtCues(normalizedSentenceMerged);
    if (expected <= 0) return true;
    const rows = countSpeakerRowsJson(speakerJson);
    const srtCues = countSrtCues(speakerSrt);
    const minNeeded = Math.max(40, Math.floor(expected * 0.8));
    return rows >= minNeeded && srtCues >= minNeeded;
  }

  function relabelCheckpointValid() {
    if (!namedSpeakerIdentity) return true;
    if (!existsFile(speakerJson) || !existsFile(speakerSrt)) return false;
    if (!existsFile(normalizedSentenceMerged)) return false;
    const srtTime = fileMtimeMs(speakerSrt);
    const jsonTime = fileMtimeMs(speakerJson);
    const reportTime = fileMtimeMs(autoAssignReport);
    const normalizedTime = fileMtimeMs(normalizedSentenceMerged);
    if (normalizedTime > 0 && srtTime < normalizedTime) return false;
    if (!sentenceCueQuality(speakerSrt).ok) return false;
    if (!(srtTime >= jsonTime && srtTime >= reportTime)) return false;
    if (!cueTimelineMatches(normalizedSentenceMerged, speakerSrt, 'relabel-checkpoint')) return false;
    return true;
  }

  function sentenceMergeCheckpointValid() {
    if (!existsFile(timedSentenceMerged) || !existsFile(normalizedSentenceMerged)) return false;
    const report = readAlignmentReport(timedSentenceMerged);
    if (!report || report.sentenceCues !== true) return false;
    if (!sentenceCueQuality(timedSentenceMerged).ok) return false;
    if (!sentenceCueQuality(normalizedSentenceMerged).ok) return false;
    const sourceSrt = existsFile(baseMerged) ? baseMerged : baseTimingSrt;
    const outputTime = Math.min(fileMtimeMs(timedSentenceMerged), fileMtimeMs(normalizedSentenceMerged));
    const sourceTime = Math.max(fileMtimeMs(sourceSrt), fileMtimeMs(normalizedPlain), fileMtimeMs(normalizedMeta));
    return outputTime >= sourceTime;
  }

  function normalizeCheckpointValid() {
    if (!existsFile(normalizedPlain) || !existsFile(normalizedMeta)) return false;
    const normalizedText = safeReadText(normalizedPlain, '').trim();
    if (!normalizedText) return false;
    // Reuse successful normalized artifacts when available, even if a fresh
    // normalize attempt fails due transient model/network issues.
    return true;
  }

  function agendaWiseCheckpointValid() {
    if (!existsFile(agendaGrossChunksPya) || !existsFile(agendaMatchesPya) || !existsFile(agendaSectionGroundingPya)) return false;
    if (!existsFile(agendaWiseSeries)) return false;
    const sectionsTotal = readPyaNumberField(agendaMatchesPya, 'sections total');
    const assignments = parsePyaJsonTextField(agendaMatchesPya, 'assignments');
    if (!(Number.isFinite(sectionsTotal) && sectionsTotal > 0 && Array.isArray(assignments) && assignments.length > 0)) return false;
    const groundedUnits = parsePyaJsonTextField(agendaSectionGroundingPya, 'grounded units');
    if (!Array.isArray(groundedUnits) || groundedUnits.length === 0) return false;
    const maxGroundedUnitWords = groundedUnits.reduce(
      (max, unit) => Math.max(max, Number(unit?.['source words'] || 0)),
      0,
    );
    const maxCheckpointUnitWords = Math.max(
      1000,
      // Stage 3 splits long childless units by character budget before
      // generation, so a valid agenda checkpoint may legitimately contain a
      // unit just over the old 20k-word guard. Keep a stale-artifact ceiling,
      // but do not force the expensive boundary rebuild for a bounded unit
      // that Stage 3 can safely split and audit.
      Number(process.env.AGENDA_CHECKPOINT_MAX_UNIT_WORDS || 30000),
    );
    if (maxGroundedUnitWords >= maxCheckpointUnitWords) return false;
    const schemaVersion = parsePyaJsonTextField(agendaMatchesPya, 'schema version');
    const recordedFingerprint = parsePyaJsonTextField(agendaMatchesPya, 'canonical fingerprint');
    if (schemaVersion !== 'agenda_boundary_reconciliation_v3') return false;
    const boundaryRecoveryVersion = parsePyaJsonTextField(agendaMatchesPya, 'boundary recovery version');
    if (boundaryRecoveryVersion !== 'minutes_like_child_boundaries_v4') return false;
    if (!existsFile(canonicalAgendaIndex)) return false;
    const currentFingerprint = createHash('sha256').update(fs.readFileSync(canonicalAgendaIndex, 'utf8')).digest('hex');
    if (!recordedFingerprint || recordedFingerprint !== currentFingerprint) return false;
    const wiseTime = Math.min(
      fileMtimeMs(agendaWiseSeries),
      fileMtimeMs(agendaGrossChunksPya),
      fileMtimeMs(agendaMatchesPya),
      fileMtimeMs(agendaSectionGroundingPya),
    );
    const upstreamTime = Math.max(latestSpeakerArtifactTime(), fileMtimeMs(canonicalAgendaIndex));
    if (upstreamTime > 0 && wiseTime < upstreamTime) return false;
    return true;
  }

  function agendaSummaryCheckpointValid() {
    if (!existsFile(agendaSummaryPya)) return false;
    const sections = parsePyaJsonTextField(agendaSummaryPya, 'sections');
    if (!Array.isArray(sections) || !sections.length) return false;
    const groundedUnits = parsePyaJsonTextField(agendaSectionGroundingPya, 'grounded units');
    if (Array.isArray(groundedUnits) && groundedUnits.length > 0 && sections.length < groundedUnits.length) return false;
    const summaryTime = fileMtimeMs(agendaSummaryPya);
    const wiseTime = Math.max(
      fileMtimeMs(agendaWiseSeries),
      fileMtimeMs(agendaMatchesPya),
      fileMtimeMs(agendaGrossChunksPya),
      fileMtimeMs(agendaSectionGroundingPya),
    );
    if (wiseTime > 0 && summaryTime < wiseTime) return false;
    const speakerTime = latestSpeakerArtifactTime();
    if (speakerTime > 0 && summaryTime < speakerTime) return false;
    return true;
  }

  function wholeMeetingSummaryCheckpointValid() {
    if (!existsFile(meetingSummaryMd) || !existsFile(meetingSummaryChunksPya)) return false;
    if (existsFile(articleClaimsVerifyPath)) {
      const articleVerification = parsePyaJsonTextField(articleClaimsVerifyPath, 'summary');
      if (articleClaimsVerificationNeedsRetry(articleVerification)) return false;
    }
    const chunks = parsePyaJsonTextField(meetingSummaryChunksPya, 'chunks');
    if (!Array.isArray(chunks) || !chunks.length) return false;
    const summaryTime = fileMtimeMs(meetingSummaryMd);
    const agendaTime = fileMtimeMs(agendaSummaryPya);
    const chunksTime = fileMtimeMs(meetingSummaryChunksPya);
    if (agendaTime > 0 && summaryTime < agendaTime) return false;
    if (chunksTime > 0 && summaryTime < chunksTime) return false;
    return true;
  }

  function agendaReferenceCorroborationCheckpointValid() {
    if (!existsFile(agendaReferenceCorroborationPya)) return false;
    const unresolved = readPyaNumberField(agendaReferenceCorroborationPya, 'unresolved total');
    if (!Number.isFinite(unresolved) || unresolved > 0) return false;
    const reportTime = fileMtimeMs(agendaReferenceCorroborationPya);
    const upstream = Math.max(fileMtimeMs(agendaSummaryPya), fileMtimeMs(agendaWiseSeries));
    if (upstream > 0 && reportTime < upstream) return false;
    return true;
  }

  function meetingHookCheckpointValid() {
    if (!existsFile(meetingHookTxt)) return false;
    const hookTime = fileMtimeMs(meetingHookTxt);
    const summaryTime = fileMtimeMs(meetingSummaryMd);
    if (summaryTime > 0 && hookTime < summaryTime) return false;
    return true;
  }

  function imageCheckpointValid() {
    const imagePath = existsFile(coverImageStablePath) ? coverImageStablePath : (existsFile(coverImagePath) ? coverImagePath : '');
    if (!imagePath) return false;
    const imageTime = fileMtimeMs(imagePath);
    const hookTime = fileMtimeMs(meetingHookTxt);
    if (hookTime > 0 && imageTime < hookTime) return false;
    return true;
  }

  function lemmyPayloadCheckpointValid() {
    if (!existsFile(lemmyPayloadPath) || !existsFile(lemmyBodyPath)) return false;
    if (!hasOneSentenceSection(lemmyBodyPath)) return false;
    if (!hasTranscriptPayloadShape(lemmyPayloadPath, htmlPath)) return false;
    if (!hasSuccessfulMeetingPublishResponse(transcriptDir)) return false;
    const payloadTime = Math.min(fileMtimeMs(lemmyPayloadPath), fileMtimeMs(lemmyBodyPath));
    const upstreamTime = Math.max(
      fileMtimeMs(htmlPath),
      fileMtimeMs(meetingSummaryMd),
      fileMtimeMs(meetingHookTxt),
      fileMtimeMs(existsFile(coverImageStablePath) ? coverImageStablePath : coverImagePath),
    );
    if (upstreamTime > 0 && payloadTime < upstreamTime) return false;
    return true;
  }

  async function stage(name, fn, { skipWhen = null, optional = false } = {}) {
    if (!force && typeof skipWhen === 'function' && skipWhen()) {
      log(`[full-pipeline] skip ${name} (checkpoint exists)`);
      stageStatus.push({ stage: name, status: 'skipped' });
      return;
    }
    log(`[full-pipeline] start ${name}`);
    const t0 = Date.now();
    try {
      await fn();
      const ms = Date.now() - t0;
      log(`[full-pipeline] done ${name} in ${(ms / 1000).toFixed(1)}s`);
      stageStatus.push({ stage: name, status: 'ok', duration_ms: ms });
    } catch (err) {
      if (optional) {
        log(`[full-pipeline] warn ${name}: ${String(err?.message || err)}`);
        stageStatus.push({ stage: name, status: 'warn', error: String(err?.message || err) });
        return;
      }
      throw err;
    }
  }

  await stage('augment-roster-from-agenda', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE, 'program/augment-roster-from-agenda-in-meeting-folder.mjs'),
        meetingDir,
      ],
      cwd: ROOT,
      timeoutMs: 5 * 60 * 1000,
      label: 'augment-roster-from-agenda',
    });
  }, {
    optional: true,
  });

  await stage('transcribe+merge', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE, 'program/transcribe-and-merge-qwen-from-transcript-folder.mjs'),
        transcriptDir,
        basePrefix,
      ],
      cwd: ROOT,
      timeoutMs: scaleTimeout(70 * 60 * 1000, audioSeconds, 1.8),
      label: 'transcribe+merge',
    });
  }, {
    skipWhen: () => transcribeCheckpointValid(),
  });

  await stage('normalize-transcript', async () => {
    try {
      await runWithStreaming({
        cmd: 'node',
        args: [
          path.join(HOUSE, 'program/normalize-transcript-from-transcript-folder.mjs'),
          transcriptDir,
          basePrefix,
          normPrefix,
        ],
        cwd: ROOT,
        timeoutMs: scaleTimeout(40 * 60 * 1000, audioSeconds, 1.1),
        label: 'normalize-transcript',
      });
    } catch (err) {
      if (normalizeCheckpointValid()) {
        log(`[full-pipeline] warn normalize-transcript failed; using checkpoint artifacts (${String(err?.message || err)})`);
        return;
      }
      throw err;
    }
  }, {
    skipWhen: () => normalizeCheckpointValid(),
  });

  await stage('ensure-base-merged-srt', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(ROOT, 'command/lyrics_to_srt_from_timing.mjs'),
        basePlain,
        baseTimingSrt,
        baseMerged,
      ],
      cwd: ROOT,
      env: {
        PYA_SRT_MAX_DRIFT_SECONDS: String(process.env.PYA_SRT_MAX_DRIFT_SECONDS || '1.5'),
      },
      timeoutMs: 15 * 60 * 1000,
      label: 'ensure-base-merged-srt',
    });
  }, {
    skipWhen: () => existsFile(baseMerged),
  });

  await stage('merge-normalized-sentence-srt', async () => {
    removeFileIfExists(timedSentenceMerged);
    removeFileIfExists(alignmentReportPath(timedSentenceMerged));
    removeFileIfExists(normalizedSentenceMerged);
    removeFileIfExists(alignmentReportPath(normalizedSentenceMerged));
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(ROOT, 'command/lyrics_to_srt_from_timing.mjs'),
        normalizedPlain,
        baseTimingSrt,
        timedSentenceMerged,
        '--sentence-cues',
      ],
      cwd: ROOT,
      timeoutMs: 20 * 60 * 1000,
      label: 'merge-normalized-sentence-srt',
    });
    if (!existsFile(timedSentenceMerged)) {
      throw new Error(`timed sentence srt missing after merge: ${timedSentenceMerged}`);
    }
    const timedReport = readAlignmentReport(timedSentenceMerged);
    if (!timedReport || timedReport.sentenceCues !== true) {
      throw new Error(`timed sentence alignment report missing sentenceCues=true: ${alignmentReportPath(timedSentenceMerged)}`);
    }
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(ROOT, 'command/apply_string_replacement_map_to_srt.mjs'),
        timedSentenceMerged,
        normalizedMeta,
        normalizedSentenceMerged,
      ],
      cwd: ROOT,
      timeoutMs: 5 * 60 * 1000,
      label: 'apply-normalize-replacements-to-sentence-srt',
    });
    assertCueTimelineMatch(timedSentenceMerged, normalizedSentenceMerged, 'normalize-text-only');
    fs.copyFileSync(alignmentReportPath(timedSentenceMerged), alignmentReportPath(normalizedSentenceMerged));
    requireSentenceCueQuality(timedSentenceMerged, 'timed sentence merge');
    requireSentenceCueQuality(normalizedSentenceMerged, 'normalized sentence merge');
  }, {
    skipWhen: () => sentenceMergeCheckpointValid(),
  });

  await stage('diarize-speakers', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE, 'program/diarize-sentence-srt-from-transcript-folder.mjs'),
        transcriptDir,
        `${normPrefix}.sentences`,
        baseVoicesDir,
      ],
      cwd: ROOT,
      env: buildSentenceDiarizationEnv({
        PYA_SPEAKER_ISOLATE_VOICES: '0',
        PYA_SPEAKER_RESEED_VOICES: '0',
        ...(speakerHost ? { PYA_SPEAKER_HOST: speakerHost } : {}),
        ...(speakerHostRoot ? { PYA_SPEAKER_HOST_ROOT: speakerHostRoot } : {}),
      }, process.env),
      timeoutMs: scaleTimeout(70 * 60 * 1000, audioSeconds, 1.4),
      label: 'diarize-speakers',
    });
  }, {
    skipWhen: () => speakerCheckpointValid(),
  });

  await stage('auto-assign-speakers-from-callouts', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE, 'program/auto-assign-speakers-from-callouts.mjs'),
        transcriptDir,
        `${normPrefix}.sentences`,
        path.join(HOUSE, 'artifacts/owen-sound/2022-2026-council.txt'),
        activeVoicesDir,
      ],
      cwd: ROOT,
      env: {
        PYA_SPEAKER_NAME_LINKING: namedSpeakerIdentity ? '1' : '0',
        PYA_AUTOASSIGN_ALLOW_REASSIGN: '0',
        PYA_AUTOASSIGN_OVERWRITE_EXISTING: '0',
      },
      timeoutMs: 10 * 60 * 1000,
      label: 'auto-assign-speakers-from-callouts',
    });
  }, {
    optional: true,
    skipWhen: () => !namedSpeakerIdentity,
  });

  await stage('relabel-speakers', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE, 'program/relabel-speaker-sentence-srt-from-transcript-folder.mjs'),
        transcriptDir,
        `${normPrefix}.sentences`,
        activeVoicesDir,
      ],
      cwd: ROOT,
      env: {
        PYA_SPEAKER_NAME_LINKING: namedSpeakerIdentity ? '1' : '0',
      },
      timeoutMs: 10 * 60 * 1000,
      label: 'relabel-speakers',
    });
  }, {
    skipWhen: () => !namedSpeakerIdentity || relabelCheckpointValid(),
  });

  await stage('apply-normalize-replacements-to-speaker-srt', async () => {
    const tmpOut = `${speakerSrt}.tmp`;
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(ROOT, 'command/apply_string_replacement_map_to_srt.mjs'),
        speakerSrt,
        normalizedMeta,
        tmpOut,
      ],
      cwd: ROOT,
      timeoutMs: 5 * 60 * 1000,
      label: 'apply-normalize-replacements-to-speaker-srt',
    });
    const currentText = safeReadText(speakerSrt, '');
    const nextText = safeReadText(tmpOut, '');
    if (currentText !== nextText) {
      fs.copyFileSync(tmpOut, speakerSrt);
    } else {
      log('[full-pipeline] apply-normalize-replacements-to-speaker-srt: no changes');
    }
    try { fs.unlinkSync(tmpOut); } catch {}
  }, {
    optional: true,
  });

  await stage('verify-sentence-timing-contract', async () => {
    const strictCanonicalContract = /^(1|true|yes)$/iu.test(
      String(process.env.PYA_VERIFY_CANONICAL_SENTENCE_CONTRACT || '0'),
    );
    try {
      await assertCanonicalSentenceTimingFromWordCues({
        transcriptDir,
        sentencePlain: normalizedPlain,
        baseTimingSrt,
        canonicalSentenceSrt: timedSentenceMerged,
        driftSeconds: Number(process.env.PYA_SRT_MAX_DRIFT_SECONDS || 1.5),
      });
    } catch (err) {
      if (strictCanonicalContract) throw err;
      log(`[timing-contract] warn canonical sentence contract mismatch; continuing (${String(err?.message || err)})`);
    }
    assertCueTimelineMatch(timedSentenceMerged, normalizedSentenceMerged, 'normalized-vs-canonical');
    requireSentenceCueQuality(timedSentenceMerged, 'canonical sentence srt');
    requireSentenceCueQuality(normalizedSentenceMerged, 'normalized sentence srt');
    const strictSpeakerTiming = !/^(0|false|no)$/iu.test(String(process.env.PYA_VERIFY_SPEAKER_TIMING_CONTRACT || '1'));
    if (strictSpeakerTiming) {
      try {
        const contract = assertCueTimelineMatch(normalizedSentenceMerged, speakerSrt, 'speaker-vs-normalized', {
          requireEqualCueCount: false,
          startToleranceMs: 1500,
          endToleranceMs: 1500,
          cueToleranceMs: 40,
        });
        if (contract?.warning) {
          log(`[timing-contract] warn ${contract.warning}`);
        }
      } catch (err) {
        log(`[timing-contract] speaker contract mismatch; attempting relabel repair (${String(err?.message || err)})`);
        await runWithStreaming({
          cmd: 'node',
          args: [
            path.join(HOUSE, 'program/relabel-speaker-sentence-srt-from-transcript-folder.mjs'),
            transcriptDir,
            `${normPrefix}.sentences`,
            activeVoicesDir,
          ],
          cwd: ROOT,
          timeoutMs: 10 * 60 * 1000,
          label: 'relabel-speakers-repair',
        });
        const contractAfterRepair = assertCueTimelineMatch(normalizedSentenceMerged, speakerSrt, 'speaker-vs-normalized', {
          requireEqualCueCount: false,
          startToleranceMs: 1500,
          endToleranceMs: 1500,
          cueToleranceMs: 40,
        });
        if (contractAfterRepair?.warning) {
          log(`[timing-contract] warn ${contractAfterRepair.warning}`);
        }
      }
    } else {
      const speakerMatches = cueTimelineMatches(normalizedSentenceMerged, speakerSrt, 'speaker-vs-normalized', {
        requireEqualCueCount: false,
        startToleranceMs: 1500,
        endToleranceMs: 1500,
        cueToleranceMs: 40,
      });
      if (!speakerMatches) {
        log('[timing-contract] warn speaker timing differs from canonical; continuing (set PYA_VERIFY_SPEAKER_TIMING_CONTRACT=1 to fail)');
      }
    }
    requireSentenceCueQuality(speakerSrt, 'speaker sentence srt');
  }, {
    skipWhen: () => /^(1|true|yes)$/iu.test(String(process.env.PYA_SKIP_SENTENCE_TIMING_CONTRACT || '0')),
  });

  await stage('sync-speaker-artifacts-to-global-voices', async () => {
    if (!isolateVoices || voicesWorkDir === baseVoicesDir) {
      log('[full-pipeline] speaker artifacts copied: 0 (isolate voices off)');
      return;
    }
    const result = syncSpeakerArtifactsToGlobal({ fromDir: voicesWorkDir, toDir: baseVoicesDir });
    log(`[full-pipeline] speaker artifacts copied: ${result.copied}`);
  }, {
    optional: true,
  });

  if (diarizeOnly) {
    stageStatus.push({ stage: 'agenda-aware-wise-chunks', status: 'skipped', reason: 'diarize-only' });
    stageStatus.push({ stage: 'agenda-section-summaries', status: 'skipped', reason: 'diarize-only' });
    stageStatus.push({ stage: 'agenda-reference-corroboration', status: 'skipped', reason: 'diarize-only' });
    stageStatus.push({ stage: 'whole-meeting-summary', status: 'skipped', reason: 'diarize-only' });
    stageStatus.push({ stage: 'meeting-hook', status: 'skipped', reason: 'diarize-only' });
    stageStatus.push({ stage: 'render-html', status: 'skipped', reason: 'diarize-only' });
    stageStatus.push({ stage: 'draw-meeting-image', status: 'skipped', reason: 'diarize-only' });
    stageStatus.push({ stage: 'lemmy-payload', status: 'skipped', reason: 'diarize-only' });
  } else {

  await stage('agenda-aware-wise-chunks', async () => {
    try {
      await runWithStreaming({
        cmd: 'node',
        args: [
          path.join(HOUSE, 'program/wise-chunk-owen-sound-agenda-aware-from-transcript-folder.mjs'),
          transcriptDir,
          normPrefix,
        ],
        cwd: ROOT,
        env: {
          OWEN_AGENDA_USE_LLM_RANGE: process.env.OWEN_AGENDA_USE_LLM_RANGE || '1',
          AGENDA_MAX_GAP_ROWS: process.env.AGENDA_MAX_GAP_ROWS || '12',
        },
        timeoutMs: scaleTimeout(50 * 60 * 1000, audioSeconds, 0.7),
        label: 'agenda-aware-wise-chunks',
      });
    } catch (err) {
      if (agendaWiseCheckpointValid()) {
        log('[full-pipeline] warn agenda-aware-wise-chunks failed; using checkpoint artifacts (' + String(err?.message || err) + ')');
        return;
      }
      throw err;
    }
  }, {
    skipWhen: () => agendaWiseCheckpointValid(),
  });

  await stage('agenda-section-summaries', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE, 'program/summarize-agenda-wise-sections-from-transcript-folder.mjs'),
        transcriptDir,
        normPrefix,
        focus,
      ],
      cwd: ROOT,
      timeoutMs: scaleTimeout(75 * 60 * 1000, audioSeconds, 0.9),
      label: 'agenda-section-summaries',
    });
  }, {
    skipWhen: () => agendaSummaryCheckpointValid(),
  });

  await stage('agenda-reference-corroboration', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(ROOT, 'command/corroborate_agenda_references_from_transcript_folder.mjs'),
        transcriptDir,
        normPrefix,
      ],
      cwd: ROOT,
      timeoutMs: 10 * 60 * 1000,
      label: 'agenda-reference-corroboration',
    });
  }, {
    skipWhen: () => agendaReferenceCorroborationCheckpointValid(),
  });

  await stage('whole-meeting-summary', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE, 'program/summarize-whole-meeting-from-agenda-summary.mjs'),
        transcriptDir,
        normPrefix,
        focus,
      ],
      cwd: ROOT,
      // Whole-meeting synthesis performs bounded chunk generation, semantic
      // reviews, coverage adjudication, and source-faithful repairs. Scale
      // its child timeout with recording length so a long complete meeting
      // remains retryable instead of being SIGKILLed mid-repair.
      timeoutMs: scaleTimeout(35 * 60 * 1000, audioSeconds, 0.8),
      label: 'whole-meeting-summary',
    });
  }, {
    skipWhen: () => wholeMeetingSummaryCheckpointValid(),
    inputArtifacts: [agendaSummaryPya],
    outputArtifacts: [meetingSummaryChunksPya, meetingSummaryPya, meetingSummaryMd],
  });

  await stage('meeting-hook', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE, 'program/generate-meeting-hook-from-transcript-folder.mjs'),
        transcriptDir,
        normPrefix,
        focus,
        jurisdiction,
        body,
      ],
      cwd: ROOT,
      timeoutMs: 15 * 60 * 1000,
      label: 'meeting-hook',
    });
  }, {
    skipWhen: () => meetingHookCheckpointValid(),
  });

  const meetingJsonPath = path.join(meetingDir, 'meeting.json');
  const meetingPayload = safeReadJson(meetingJsonPath, {})?.payload || {};
  const meetingDateInfo = deriveDateLongFromMeetingDir(path.basename(meetingDir));
  const meetingRouteSlug = canonicalMeetingRouteSlug(meetingPayload?.meeting_type || meetingPayload?.meeting_name || body);
  const agendaPageUrl = `${siteUrl.replace(/\/+$/u, '')}/agendas/${slugify(jurisdiction)}/${meetingRouteSlug}/${meetingDateInfo.iso || 'unknown-date'}`;
  const transcriptPageUrl = `${siteUrl.replace(/\/+$/u, '')}/transcripts/${slugify(jurisdiction)}/${meetingRouteSlug}/${meetingDateInfo.iso || 'unknown-date'}`;
  const meetingUrl = String(meetingPayload?.meeting_url || '').trim();
  const payloadVideoDirect = Array.isArray(meetingPayload?.video_direct)
    ? meetingPayload.video_direct.find((x) => /^https?:\/\//iu.test(String(x || '')))
    : '';
  const payloadVideo = Array.isArray(meetingPayload?.video)
    ? meetingPayload.video.find((x) => /^https?:\/\//iu.test(String(x || '')))
    : '';
  const preferredVideo = String(payloadVideoDirect || payloadVideo || '');

  const hook = safeReadText(meetingHookTxt, '').trim();

  await stage('render-html', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(HOUSE, 'program/render-transcript-html-from-transcript-folder.mjs'),
        transcriptDir,
        path.basename(htmlPath),
        jurisdiction,
        body,
        siteUrl,
        discussionUrl,
        meetingUrl,
        preferredVideo,
        hook,
        agendaPageUrl,
        transcriptPageUrl,
      ],
      cwd: ROOT,
      timeoutMs: 10 * 60 * 1000,
      label: 'render-html',
    });
  });

  await stage('draw-meeting-image', async () => {
    await runWithStreaming({
      cmd: 'node',
      args: [
        path.join(ROOT, 'command/draw_meeting_cover_from_transcript_folder.mjs'),
        transcriptDir,
        normPrefix,
        process.env.OWEN_DRAW_STYLE || DEFAULT_STYLE,
      ],
      cwd: ROOT,
      env: { COVER_REQUIRE_SOURCE_VIDEO: '1' },
      timeoutMs: 45 * 60 * 1000,
      label: 'draw-meeting-image',
    });
  }, {
    skipWhen: () => skipImage || imageCheckpointValid(),
  });

  await stage('lemmy-payload', async () => {
    const summaryMd = safeReadText(meetingSummaryMd, '').trim();
    const dateInfo = deriveDateLongFromMeetingDir(path.basename(meetingDir));
    const dateLong = dateInfo.long;
    const rankedFromAgenda = buildRankedTopNewsFromAgenda(agendaSummaryPya, agendaSectionGroundingPya);
    const rankedFromSummary = buildRankedTopNewsFromTranscriptSummary(summaryMd);
    const rankedNews = (Array.isArray(rankedFromAgenda?.selected) && rankedFromAgenda.selected.length > 0)
      ? rankedFromAgenda
      : rankedFromSummary;
    rankedNews.selected = (Array.isArray(rankedNews.selected) ? rankedNews.selected : [])
      .filter((item) => !isLowSignalTopNewsItem(item));
    const selectedForAssembly = Array.isArray(rankedNews.selected) ? [...rankedNews.selected] : [];
    const isHumanImpact = (r) => /\b(food|hunger|poverty|wheelchair|accessibility|hospital|taxi|service|mobility)\b/iu.test(`${String(r?.title || '')} ${String(r?.body || '')}`);
    const isSustained = (r) => Number(String(r?.body || '').split(/\s+/u).filter(Boolean).length) >= 20;
    const isGeneral = (r) => !isHumanImpact(r) && !/\b(by-?law|agreement|administrative|consent agenda)\b/iu.test(`${String(r?.title || '')} ${String(r?.body || '')}`);
    const leadCandidate = chooseLeadTopForOneSentence(selectedForAssembly, { jurisdiction }) || selectedForAssembly[0] || null;
    const topNow = selectedForAssembly[0] || null;
    const hasPublicImpactOverride = (r) => /\b(resident|public|service|hospital|access|food|mobility|safety)\b/iu.test(`${String(r?.title || '')} ${String(r?.body || '')}`);
    if (topNow && leadCandidate && String(topNow.id || '') !== String(leadCandidate.id || '')) {
      const idx = selectedForAssembly.findIndex((x) => String(x?.id || '') === String(leadCandidate.id || ''));
      if (idx > 0) {
        const shouldPromote = crossJurisdictionLeadPenalty(topNow, jurisdiction) > 0
          || !hasPublicImpactOverride(topNow)
          || (isGeneral(topNow) && !isSustained(topNow) && isHumanImpact(leadCandidate) && isSustained(leadCandidate));
        if (shouldPromote) {
          const [lead] = selectedForAssembly.splice(idx, 1);
          selectedForAssembly.unshift(lead);
        }
      }
    }
    const currentHookTerms = cleanHeadlineText(String(safeReadText(meetingHookTxt, '') || ''))
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .split(/\s+/u)
      .filter((term) => term.length >= 4)
      .filter((term) => !new Set([
        'council', 'committee', 'meeting', 'transcript', 'owen', 'sound',
        'local', 'voice', 'review', 'reviews', 'approved', 'approval',
      ]).has(term));
    let hookMatchedLeadId = '';
    if (currentHookTerms.length >= 2 && selectedForAssembly.length > 1) {
      const scored = selectedForAssembly
        .map((item, idx) => {
          const haystack = `${String(item?.title || '')} ${String(item?.heading || '')} ${String(item?.body || '')}`
            .toLowerCase()
            .replace(/[^a-z0-9\s]/gu, ' ')
            .replace(/\s+/gu, ' ');
          const matched = currentHookTerms.filter((term) => haystack.includes(term));
          return {
            idx,
            item,
            score: matched.length,
            matched: matched.length,
            sustained: Number(String(item?.body || '').split(/\s+/u).filter(Boolean).length) >= 20,
          };
        })
        .sort((a, b) => b.score - a.score || Number(b.sustained) - Number(a.sustained) || a.idx - b.idx);
      const best = scored[0] || null;
      if (best && best.idx > 0 && best.score >= Math.min(2, currentHookTerms.length)) {
        const [lead] = selectedForAssembly.splice(best.idx, 1);
        selectedForAssembly.unshift(lead);
        hookMatchedLeadId = String(lead?.id || '');
      }
    }
    rankedNews.selected = selectedForAssembly;
    const topNewsDebugPath = path.join(transcriptDir, `${normPrefix}.transcript-top-news-selection-debug.pya`);
    const leadForAssembly = hookMatchedLeadId
      ? rankedNews.selected[0]
      : (chooseLeadTopForOneSentence(rankedNews.selected, { jurisdiction }) || rankedNews.selected[0] || null);
    const selectionDebug = {
      meetingRef: path.basename(meetingDir),
      sourceArtifact: meetingSummaryMd,
      sourceHeading: rankedNews.sourceHeading || '',
      rawCandidateCount: Array.isArray(rankedNews.rows) ? rankedNews.rows.length : 0,
      selectedCandidateCount: Array.isArray(rankedNews.selected) ? rankedNews.selected.length : 0,
      leadCandidateId: String(leadForAssembly?.id || ''),
      lead_candidate_id: String(leadForAssembly?.id || ''),
      titleSourceCandidateId: String(leadForAssembly?.id || ''),
      title_source_candidate_id: String(leadForAssembly?.id || ''),
      hookSourceCandidateId: String(leadForAssembly?.id || ''),
      hook_source_candidate_id: String(leadForAssembly?.id || ''),
      oneSentenceSourceCandidateId: String(leadForAssembly?.id || ''),
      one_sentence_source_candidate_id: String(leadForAssembly?.id || ''),
      firstTopNewsCandidateId: String((rankedNews.selected?.[0]?.id) || ''),
      first_top_news_candidate_id: String((rankedNews.selected?.[0]?.id) || ''),
      hookMatchedLeadId,
      hook_matched_lead_id: hookMatchedLeadId,
      candidates: (Array.isArray(rankedNews.rows) ? rankedNews.rows : []).map((r) => ({
        id: String(r.id || ''),
        title: String(r.title || ''),
        heading: String(r.heading || ''),
        body: String(r.body || '').slice(0, 280),
        score: Number(r.score || 0),
        excluded: !!r.excluded,
        source: String(r.candidateKind || ''),
        evidenceRows: Number(String(r.body || '').split(/\s+/u).filter(Boolean).length),
        durationSeconds: 0,
        speakerTurns: 0,
        sustainedDiscussion: Number(String(r.body || '').split(/\s+/u).filter(Boolean).length) >= 20,
        proceduralAdminScore: /\b(by-?law|agreement|administrative|consent agenda)\b/iu.test(String(r.body || '')) ? 1 : 0,
        humanImpactScore: /\b(food|hunger|poverty|wheelchair|accessibility|hospital|taxi|service)\b/iu.test(String(r.body || '')) ? 1 : 0,
        salienceReason: /\b(food|hunger|poverty|wheelchair|accessibility|hospital|taxi|service)\b/iu.test(String(r.body || ''))
          ? 'human_impact'
          : (/\b(by-?law|agreement|administrative|consent agenda)\b/iu.test(String(r.body || '')) ? 'administrative' : 'general'),
        selected: (Array.isArray(rankedNews.selected) ? rankedNews.selected : []).some((s) => s.id === r.id),
        rejectionReason: (Array.isArray(rankedNews.selected) ? rankedNews.selected : []).some((s) => s.id === r.id)
          ? ''
          : (isGenericNewsTitle(r.title) ? 'generic_title' : (Number(r.score || 0) <= 0 ? 'non_positive_score' : 'filtered')),
      })),
    };
    const leadTop = leadForAssembly;
    const headingGen = await generateTranscriptHeadingFromEvidence({
      transcriptEvidence: String(leadTop?.body || ""),
      candidateSummary: String(leadTop?.summary || leadTop?.body || ""),
      sectionHeading: String(leadTop?.heading || ""),
      meetingContext: `${jurisdiction} ${body} ${dateLong}`,
      maxWords: 8,
      mode: 'post_lead',
    });
    const candidateHeading = String(headingGen?.heading || "").trim();
    const headingGenStrict = await generateTranscriptHeadingFromEvidence({
      transcriptEvidence: `${String(leadTop?.heading || "")}\n${String(leadTop?.body || "")}`,
      candidateSummary: String(leadTop?.body || leadTop?.summary || ""),
      sectionHeading: String(leadTop?.heading || ""),
      meetingContext: `${jurisdiction} ${body} ${dateLong}`,
      maxWords: 6,
      mode: 'post_lead',
    });
    const candidateHeadingStrict = String(headingGenStrict?.heading || "").trim();
    const chapterStyleHookRaw = cleanHeadlineText(String(safeReadText(meetingHookTxt, "") || "").trim());
	    const chapterStyleHook = normalizeChapterStyleStem(chapterStyleHookRaw);
	    const headingCandidates = [candidateHeading, candidateHeadingStrict]
	      .map((x) => normalizeChapterStyleStem(String(x || "").replace(/\s+/gu, " ").trim()))
	      .filter(Boolean)
	      .map((x) => x.replace(/\b(the most consequential (item|moment|action)( of the night)? was)\b/iu, "").trim())
	      .map((x) => x.replace(/[,:;]\s*$/u, "").trim())
	      .filter(Boolean);
    let hookTitle = "";
    let titleGenerationMethod = "lead_heading";
    if (chapterStyleHook && isStrictChapterStyleHook(chapterStyleHook, { jurisdiction, body }) && !isBadHeadlineFragment(chapterStyleHook) && !isForbiddenTitleStem(chapterStyleHook)) {
      hookTitle = chapterStyleHook;
      titleGenerationMethod = "chapter_style_hook_direct";
    } else {
      const acceptedHeading = headingCandidates.find((h) =>
        isStrictChapterStyleHook(h, { jurisdiction, body }) && isValidHookTitle(h) && !isBadHeadlineFragment(h) && !isForbiddenTitleStem(h)
      );
      if (!acceptedHeading) {
        throw new Error(`bad_heading_artifact: no_valid_keyword_hook_or_regenerated_heading meeting_hook="${chapterStyleHookRaw}" lead_heading="${candidateHeading}" lead_heading_strict="${candidateHeadingStrict}"`);
      } else {
	        hookTitle = acceptedHeading;
	        titleGenerationMethod = "lead_heading";
      }
    }
    const title = `${hookTitle} — ${jurisdiction} ${body} Transcript — ${dateLong}`;

    const canonicalUrl = transcriptPageUrl;
    const sourceLinks = [];
    if (meetingUrl) sourceLinks.push(`Official meeting page: ${meetingUrl}`);
    if (preferredVideo) sourceLinks.push(`Original video: ${preferredVideo}`);

    const meetingTime = (() => {
      const raw = String(meetingPayload?.meeting_time || '').trim();
      if (raw) return raw;
      const iso = String(meetingPayload?.meeting_start || '').trim();
      if (!iso) return '';
      const dt = new Date(iso);
      if (Number.isNaN(dt.getTime())) return '';
      return dt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Toronto' });
    })();
    const meetingLocation = String(
      meetingPayload?.meeting_location
      || meetingPayload?.location
      || meetingPayload?.venue
      || ''
    ).trim();
    const scheduleContext = [
      dateLong ? `date ${dateLong}` : '',
      meetingTime ? `time ${meetingTime}` : '',
      meetingLocation ? `location ${meetingLocation}` : '',
    ].filter(Boolean).join(', ');

    for (const r of rankedNews.rows) {
      const reason = r.excluded ? 'procedural_or_empty' : (r.substantive || r.score > 0 ? 'substantive' : 'low_score');
      const selected = rankedNews.selected.some((x) => x.heading === r.heading && x.summary === r.summary);
      log('[top-news] id=' + r.id + ' unit=' + r.unitId + ' heading=' + (r.heading || '(blank)') + ' procedural_excluded=' + (r.excluded ? 'yes' : 'no') + ' score=' + r.score + ' selected=' + (selected ? 'yes' : 'no') + ' reason=' + reason + ' title=' + r.title + ' body=' + r.body);
    }
    const standaloneSectionCount = readAgendaSummarySections(agendaSummaryPya).length;
    const meetingName = String(path.basename(meetingDir) || "").toLowerCase();
    const bodyName = String(body || "").toLowerCase();
    const isCommitteeMeeting = bodyName.includes("committee") || meetingName.includes("committee");
    const isShortMeeting = Number(audioSeconds || 0) <= 5400 || standaloneSectionCount <= 9;
    const lowCountMode = isCommitteeMeeting && isShortMeeting;
    const minTopNewsRequired = 1;
    const substantivePoolCount = rankedNews.rows.filter((r) => !r.excluded && (r.substantive || Number(r.score || 0) > 0)).length;
    const meetingTranscriptEvidenceText = String(safeReadText(normalizedPlain, '') || safeReadText(basePlain, '') || '');
    // A recorded quorum failure is a valid transcript with no substantive
    // agenda business. Its generated procedural recap remains publishable;
    // it must not be converted into a fabricated substantive item.
    const abortedNoQuorumMeeting = /\b(?:no quorum|quorum has not been reached|without quorum)\b/iu.test(meetingTranscriptEvidenceText)
      && /\badjourn(?:ed|ment|s)?\b/iu.test(meetingTranscriptEvidenceText)
      && substantivePoolCount === 0;
    if (rankedNews.selected.length < minTopNewsRequired) {
      if (!abortedNoQuorumMeeting) {
        throw new Error('top-news selector produced too few substantive items (' + rankedNews.selected.length + ') | debug=' + topNewsDebugPath);
      }
      log('[top-news] allowing generated procedural quorum-failure recap with no substantive agenda items');
    }
    if (rankedNews.selected.length < 3) {
      log('[top-news] low substantive count: ' + rankedNews.selected.length + '; proceeding because candidates passed quality checks'
        + ' meeting_type=' + (isCommitteeMeeting ? 'committee' : 'council')
        + ' short=' + (isShortMeeting ? 'yes' : 'no')
        + ' standalone_sections=' + standaloneSectionCount
        + ' substantive_pool=' + substantivePoolCount
        + ' mode=' + (lowCountMode ? 'short_committee' : 'general_low_count'));
    }
    for (const item of rankedNews.selected) {
      if (!item.id || !item.unitId || !item.title || !item.body) {
        throw new Error('top-news invariant failed: missing id/unit/title/body');
      }
      const itemIsSubstantive = item.candidateKind === 'section' || item.candidateKind === 'content_topic'
        ? item.substantive === true
        : Number(item.score || 0) > 0;
      if ((item.excluded || !itemIsSubstantive) && !abortedNoQuorumMeeting) {
        throw new Error('top-news invariant failed: selected item is non-substantive');
      }
    }
    const topNewsMarkdown = (Array.isArray(rankedNews.selected) ? rankedNews.selected : [])
      .map((r) => `- **${String(r.title || '').trim()}:** ${String(r.body || '').replace(/\s+/gu, ' ').trim()}`)
      .filter((x) => /^-\s+\*\*[^*]+:\*\*\s+.+/u.test(x))
      .join('\n');
    const canonicalAgenda = safeReadJson(canonicalAgendaIndex, {});
    const canonicalAgendaEvidence = buildCanonicalAgendaEvidence(canonicalAgenda?.items);
    const recapBlocks = buildTranscriptRecapFromSections(
      readAgendaSummarySections(agendaSummaryPya),
      3,
      canonicalAgendaEvidence,
      { allowProcedural: abortedNoQuorumMeeting },
    );
    let articleVerificationFeedback = '';
    if (existsFile(articleClaimsVerifyPath)) {
      try {
        const priorArticleVerification = await readPyaMapArtifact(
          articleClaimsVerifyPath,
          'article claims verify artifact',
        );
        articleVerificationFeedback = buildArticleVerificationRetryFeedback(priorArticleVerification);
      } catch (error) {
        log(`[article-verify] prior report unavailable; regenerating from source: ${String(error?.message || error)}`);
      }
    }
    let wholeAgendaSummary = '';
    let finalOneSentenceSummary = '';
    let finalBodyMd = '';
    let bodyMd = '';
    let preVerifyOneSentence = '';
    let articleVerify = null;
    let oneSentenceStatus = "present";
    let oneSentenceRejectReason = "";
    let omittedOptionalSections = [];
    const articleVerificationMaxAttempts = 3;
    for (let articleVerifyAttempt = 1; articleVerifyAttempt <= articleVerificationMaxAttempts; articleVerifyAttempt += 1) {
      wholeAgendaSummary = await generateWholeSummaryFromRecapItemsLlm({
        recapBlocks,
        focus,
        scheduleContext,
        articleVerificationFeedback,
      });
      wholeAgendaSummary = neutralizeCommitteeDecisionLanguage(wholeAgendaSummary, body);
      const oneSentenceSummary = await generateMeetingWideOneSentenceLlm({
        recapBlocks,
        wholeAgendaSummary,
        jurisdiction,
        body,
        scheduleContext,
        groundedSectionCount: standaloneSectionCount,
        allowProcedural: abortedNoQuorumMeeting,
        articleVerificationFeedback,
      });
      finalOneSentenceSummary = String(oneSentenceSummary || '').replace(/\s+/gu, ' ').trim();
      finalOneSentenceSummary = rewriteOneSentenceAttributionForPublicForum(finalOneSentenceSummary, leadForAssembly);
      oneSentenceStatus = "present";
      oneSentenceRejectReason = "";
      const oneSentenceValidationContext = {
        jurisdiction,
        body,
        allowMeetingSectionPhrases: true,
        maxWords: MEETING_TEASER_MAX_WORDS,
      };
      const teaserCoverage = oneSentenceMeetingCoverage(finalOneSentenceSummary, recapBlocks);
      const teaserHasLatterHalf = teaserCoverage.indexes.some((index) => index >= Math.floor(recapBlocks.length / 2));
      const substantiveRecapCount = recapBlocks.filter((block) => sectionLooksSubstantive(block)).length;
      const teaserRequiredCoverage = Math.min(3, Math.max(1, substantiveRecapCount));
      if (isMalformedOneSentence(finalOneSentenceSummary, oneSentenceValidationContext)
        || teaserCoverage.count < teaserRequiredCoverage
        || (teaserRequiredCoverage > 1 && !teaserHasLatterHalf)) {
        oneSentenceStatus = "invalid";
        oneSentenceRejectReason = isMalformedOneSentence(finalOneSentenceSummary, oneSentenceValidationContext)
          ? explainMalformedOneSentence(finalOneSentenceSummary, oneSentenceValidationContext)
          : `insufficient meeting breadth: covered=${teaserCoverage.count} latter_half=${teaserHasLatterHalf}`;
        throw new Error('bad_one_sentence_artifact: ' + oneSentenceRejectReason);
      }
      finalOneSentenceSummary = finalOneSentenceSummary.replace(/^(On\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+(?=[A-Z])/u, '$1, ');
      if (!/[.!?]$/u.test(finalOneSentenceSummary)) {
        finalOneSentenceSummary += '.';
      }

      const bodyLines = [];
      omittedOptionalSections = [];
      bodyLines.push('## One-Sentence Summary');
      bodyLines.push(finalOneSentenceSummary);
      bodyLines.push('## Whole Meeting Summary');
      bodyLines.push(wholeAgendaSummary);
      bodyLines.push('## Most Newsworthy Items');
      bodyLines.push(topNewsMarkdown);
      bodyLines.push('# Meeting Recap');
      if (recapBlocks.length) {
        for (const block of recapBlocks) {
          bodyLines.push(`## ${block.heading}`);
          bodyLines.push(block.summary);
          const chapters = Array.isArray(block.chapters) ? block.chapters : [];
          for (const ch of chapters) {
            const chTitle = String(ch?.title || '').trim();
            const chText = String(ch?.text || '').trim();
            if (!chText) continue;
            if (chTitle) bodyLines.push(`### ${chTitle}`);
            bodyLines.push(chText);
          }
        }
      } else {
        omittedOptionalSections.push("Meeting Recap");
      }
      bodyLines.push('## Links');
      bodyLines.push(`Read full transcript: ${canonicalUrl}`);
      bodyLines.push(`Agenda page: ${agendaPageUrl}`);
      if (sourceLinks.length) {
        for (const line of sourceLinks) bodyLines.push(String(line));
      }
      if (discussionUrl) bodyLines.push(`HelpOS discussion: ${discussionUrl}`);

      bodyMd = bodyLines.join('\n\n').trim();
      preVerifyOneSentence = extractMarkdownSection(bodyMd, 'One-Sentence Summary');
      articleVerify = verifyArticleClaims({
        bodyMarkdown: bodyMd,
        meetingSummaryMd: summaryMd,
        meetingSummaryChunksPyaPath: meetingSummaryChunksPya,
        agendaSummaryPyaPath: agendaSummaryPya,
        agendaSectionGroundingPyaPath: agendaSectionGroundingPya,
        reportPath: articleClaimsVerifyPath,
      });

      const articleVerifyNeedsRetry = articleVerify.blocked
        || articleVerify.removals > 0
        || articleVerify.rewrites > 0;
      if (!articleVerifyNeedsRetry) {
        log('[article-verify] pass');
        finalBodyMd = String(bodyMd).trim();
        break;
      }

      const retryReport = {
        summary: {
          "has error": articleVerify.blocked,
          "removed count": articleVerify.removals,
          "rewritten count": articleVerify.rewrites,
          "unresolved high severity count": articleVerify.unresolvedHighSeverity,
        },
        findings: articleVerify.findings,
      };
      articleVerificationFeedback = buildArticleVerificationRetryFeedback(retryReport);
      log(`[article-verify] regeneration required (${articleVerifyAttempt}/${articleVerificationMaxAttempts})`);
      if (articleVerifyAttempt === articleVerificationMaxAttempts) {
        const reason = articleVerify.blocked
          ? 'unresolved unsupported claims'
          : (articleVerify.removals > 0 ? 'unsupported content' : 'verifier rewrites');
        throw new Error(`article-verify retryable after ${articleVerificationMaxAttempts} attempts: ${reason}`);
      }
    }
    const postVerifyOneSentence = extractMarkdownSection(finalBodyMd, 'One-Sentence Summary');
    if (preVerifyOneSentence && postVerifyOneSentence && oneSentenceMateriallyChanged(preVerifyOneSentence, postVerifyOneSentence)) {
      throw new Error('bad_one_sentence_artifact: verifier_material_rewrite');
    }
    finalBodyMd = anonymizeSpeakerAttributions(finalBodyMd);
    finalBodyMd = finalBodyMd.replace(/\bGray County\b/gu, 'Grey County');
    finalBodyMd = applyCanonicalNameFixes(finalBodyMd);
    const canonicalTopNews = (Array.isArray(rankedNews.selected) ? rankedNews.selected : [])
      .map((r) => `- **${String(r.title || '').trim()}:** ${String(r.body || '').replace(/\s+/gu, ' ').trim()}`)
      .filter((x) => /^-\s+\*\*[^*]+:\*\*\s+.+/u.test(x))
      .join('\n');
    if (canonicalTopNews) {
      finalBodyMd = upsertMarkdownSectionBefore(finalBodyMd, 'Most Newsworthy Items', canonicalTopNews, 'Meeting Recap');
    }
    const topBlock = extractMarkdownSection(finalBodyMd, 'Most Newsworthy Items');
    const topPreCheck = validateTopNewsMarkdown(topBlock, { minBullets: minTopNewsRequired, maxBullets: 6 });
    if (!topPreCheck.ok) {
      let repairedTop = normalizeTopNewsMarkdown(topBlock);
      if (!repairedTop) {
        repairedTop = String(buildFallbackTopNewsFromAgendaSummary(agendaSummaryPya, agendaSectionGroundingPya, minTopNewsRequired)?.markdown || "").trim();
      }
      if (repairedTop) {
        finalBodyMd = replaceMarkdownSection(finalBodyMd, 'Most Newsworthy Items', repairedTop);
      }
      const retryTop = validateTopNewsMarkdown(
        extractMarkdownSection(finalBodyMd, 'Most Newsworthy Items'),
        { minBullets: minTopNewsRequired, maxBullets: 6 }
      );
      if (!retryTop.ok) {
        const directSelectedTop = (Array.isArray(rankedNews.selected) ? rankedNews.selected : [])
          .slice(0, 6)
          .map((r) => `- **${String(r.title || "").replace(/[\\r\\n]+/gu, " ").trim()}:** ${String(r.body || "").replace(/[\\r\\n]+/gu, " ").replace(/\\s+/gu, " ").trim()}`)
          .filter((x) => /^-\s+\*\*[^*]+:\*\*\s+.+/u.test(x))
          .join("\n");
        if (directSelectedTop) {
          finalBodyMd = upsertMarkdownSectionBefore(finalBodyMd, "Most Newsworthy Items", directSelectedTop, "Meeting Recap");
        }
        const finalTop = validateTopNewsMarkdown(
          extractMarkdownSection(finalBodyMd, "Most Newsworthy Items"),
          { minBullets: Math.max(1, Math.min(2, minTopNewsRequired)), maxBullets: 6 }
        );
        if (!finalTop.ok) {
          throw new Error(`[bad_top_news_artifact] invalid Most Newsworthy Items bullets count=${finalTop.count}`);
        }
      }
    }
    let topCheck = validateTopNewsMarkdown(
      extractMarkdownSection(finalBodyMd, 'Most Newsworthy Items'),
      { minBullets: minTopNewsRequired, maxBullets: 6 }
    );
    const postOne = extractMarkdownSection(finalBodyMd, 'One-Sentence Summary');
    if (!topCheck.ok) {
      throw new Error(`[bad_top_news_artifact] invalid Top Newsworthy Developments bullets count=${topCheck.count}`);
    }
    const wholeBlock = extractMarkdownSection(finalBodyMd, 'Whole Meeting Summary');
    if (/\bcouncil\s+the\b/iu.test(wholeBlock || '')) {
      throw new Error('[article-assembly] malformed whole summary phrase: council the');
    }
    const wholeSentences = splitCivicSentences(wholeBlock);
    const dedupedWhole = dedupeSentences(wholeSentences);
    if (dedupedWhole.length !== wholeSentences.length) {
      finalBodyMd = replaceMarkdownSection(finalBodyMd, 'Whole Meeting Summary', dedupedWhole.join(' '));
    }
    const recapWordCount = countTranscriptRecapWords(recapBlocks);
    if (!recapBlocks.length || (!abortedNoQuorumMeeting && recapWordCount < 40)) {
      throw new Error('insufficient_summary_artifacts: meeting_recap');
    }

    // Topic-agnostic verifier: do not block on phrase/topic lists.

    let finalStem = String(hookTitle || '').trim();
    let oneSentenceGenerationMethod = oneSentenceStatus === "present" ? 'summary_artifact' : 'summary_artifact_invalid';
    if (/\bthe most consequential\b/iu.test(finalStem) || /\bthe most consequential\b/iu.test(finalOneSentenceSummary)) {
      throw new Error('final assembly regression: forbidden filler fragment survived ("The most consequential")');
    }
    hookTitle = finalStem;
    const finalTitle = `${hookTitle} — ${jurisdiction} ${body} Transcript — ${dateLong}`;
    const hookUsesMeetingSummary = ["chapter_style_hook_direct", "meeting_hook"].includes(titleGenerationMethod);
    const hookSourceCandidateId = hookUsesMeetingSummary
      ? "meeting_summary_hook"
      : String(leadForAssembly?.id || "");
    const hookSourceArtifact = hookUsesMeetingSummary ? meetingSummaryMd : topNewsDebugPath;
    const hookSourceText = hookUsesMeetingSummary
      ? summaryMd
      : `${String(leadTop?.heading || "")}\n${String(leadTop?.title || "")}\n${String(leadTop?.body || "")}`;
    selectionDebug.lead_candidate_id = String(leadForAssembly?.id || '');
    selectionDebug.title_source_candidate_id = hookSourceCandidateId;
    selectionDebug.hook_source_candidate_id = hookSourceCandidateId;
    selectionDebug.one_sentence_source_candidate_id = String(leadForAssembly?.id || '');
    selectionDebug.first_top_news_candidate_id = String((rankedNews.selected?.[0]?.id) || '');
    selectionDebug.title_generation_method = titleGenerationMethod;
    selectionDebug.hook_generation_method = titleGenerationMethod;
    selectionDebug.one_sentence_generation_method = oneSentenceGenerationMethod;
    selectionDebug.one_sentence_status = oneSentenceStatus;
    selectionDebug.one_sentence_reject_reason = oneSentenceRejectReason;
    for (const key of ['lead_candidate_id', 'title_source_candidate_id', 'hook_source_candidate_id', 'one_sentence_source_candidate_id', 'first_top_news_candidate_id']) {
      if (!String(selectionDebug[key] || '').trim()) {
        throw new Error(`top-news debug missing required field: ${key}`);
      }
    }
    writeTopNewsSelectionDebugPya(topNewsDebugPath, selectionDebug);

    const contentSourceAuditPath = path.join(transcriptDir, `${normPrefix}.content-source-audit.pya`);
    const meetingSummarySourceTexts = [
      wholeAgendaSummary,
      topNewsMarkdown,
      ...recapBlocks.flatMap((block) => [
        `${String(block?.heading || '')} ${String(block?.summary || '')}`,
        ...(Array.isArray(block?.authoritativeAgendaEvidence) ? block.authoritativeAgendaEvidence : []),
      ]),
    ].filter(Boolean);
    const contentAudits = {
      title: auditRenderedContent({ renderedText: finalTitle, sourceTexts: [hookSourceText] }),
      hook: auditRenderedContent({ renderedText: hookTitle, sourceTexts: [hookSourceText] }),
      oneSentence: auditRenderedContent({ renderedText: finalOneSentenceSummary, sourceTexts: meetingSummarySourceTexts }),
      wholeSummary: auditRenderedContent({ renderedText: wholeAgendaSummary, sourceTexts: [wholeAgendaSummary] }),
      topNews: auditRenderedContent({ renderedText: topNewsMarkdown, sourceTexts: [topNewsMarkdown] }),
      meetingRecap: auditRenderedContent({
        renderedText: extractMarkdownSection(finalBodyMd, "Meeting Recap"),
        sourceTexts: recapBlocks.map((block) => `${String(block?.heading || '')} ${String(block?.summary || '')}`),
      }),
    };
    const renderedFields = [
      {
        field: "title",
        rendered_text_hash: sha256Text(finalTitle),
        source_role: "transcript_derived_section_summary",
        source_class: "transcript_derived_summary",
        source_artifact: hookSourceArtifact,
        meeting_ref: path.basename(meetingDir),
        transcript_hash: sha256Text(safeReadText(normalizedPlain, "")),
        fallback_used: false,
        fallback_type: "",
        factual_content_introduced_by_fallback: false,
        claim_role: inferClaimRole(hookSourceText),
        rendered_claim_role: inferClaimRole(finalTitle),
        role_upgrade_detected: contentAudits.title.roleUpgradeDetected,
        unsupported_outcome_verbs: contentAudits.title.unsupportedOutcomeVerbs,
        unsupported_agenda_roles: contentAudits.title.unsupportedRoles,
      },
      {
        field: "hook",
        rendered_text_hash: sha256Text(hookTitle),
        source_role: "transcript_derived_section_summary",
        source_class: "transcript_derived_summary",
        source_artifact: hookSourceArtifact,
        meeting_ref: path.basename(meetingDir),
        transcript_hash: sha256Text(safeReadText(normalizedPlain, "")),
        fallback_used: false,
        fallback_type: "",
        factual_content_introduced_by_fallback: false,
        claim_role: inferClaimRole(hookSourceText),
        rendered_claim_role: inferClaimRole(hookTitle),
        role_upgrade_detected: contentAudits.hook.roleUpgradeDetected,
        unsupported_outcome_verbs: contentAudits.hook.unsupportedOutcomeVerbs,
        unsupported_agenda_roles: contentAudits.hook.unsupportedRoles,
      },
      {
        field: "one_sentence_summary",
        rendered_text_hash: sha256Text(finalOneSentenceSummary),
        source_role: "transcript_derived_meeting_summary",
        source_class: "transcript_derived_summary",
        source_artifact: meetingSummaryMd,
        meeting_ref: path.basename(meetingDir),
        transcript_hash: sha256Text(safeReadText(normalizedPlain, "")),
        fallback_used: false,
        fallback_type: "",
        factual_content_introduced_by_fallback: false,
        claim_role: inferClaimRole(meetingSummarySourceTexts.join("\n")),
        rendered_claim_role: inferClaimRole(finalOneSentenceSummary),
        role_upgrade_detected: contentAudits.oneSentence.roleUpgradeDetected,
        unsupported_outcome_verbs: contentAudits.oneSentence.unsupportedOutcomeVerbs,
        unsupported_agenda_roles: contentAudits.oneSentence.unsupportedRoles,
      },
      {
        field: "whole_summary",
        rendered_text_hash: sha256Text(wholeAgendaSummary),
        source_role: "transcript_derived_meeting_summary",
        source_class: "transcript_derived_summary",
        source_artifact: meetingSummaryMd,
        meeting_ref: path.basename(meetingDir),
        transcript_hash: sha256Text(safeReadText(normalizedPlain, "")),
        fallback_used: false,
        fallback_type: "",
        factual_content_introduced_by_fallback: false,
        claim_role: inferClaimRole(wholeAgendaSummary),
        rendered_claim_role: inferClaimRole(wholeAgendaSummary),
        role_upgrade_detected: contentAudits.wholeSummary.roleUpgradeDetected,
        unsupported_outcome_verbs: contentAudits.wholeSummary.unsupportedOutcomeVerbs,
        unsupported_agenda_roles: contentAudits.wholeSummary.unsupportedRoles,
      },
      {
        field: "top_news",
        rendered_text_hash: sha256Text(topNewsMarkdown),
        source_role: "transcript_derived_meeting_summary",
        source_class: "transcript_derived_summary",
        source_artifact: meetingSummaryMd,
        meeting_ref: path.basename(meetingDir),
        transcript_hash: sha256Text(safeReadText(normalizedPlain, "")),
        fallback_used: false,
        fallback_type: "",
        factual_content_introduced_by_fallback: false,
        claim_role: inferClaimRole(topNewsMarkdown),
        rendered_claim_role: inferClaimRole(topNewsMarkdown),
        role_upgrade_detected: contentAudits.topNews.roleUpgradeDetected,
        unsupported_outcome_verbs: contentAudits.topNews.unsupportedOutcomeVerbs,
        unsupported_agenda_roles: contentAudits.topNews.unsupportedRoles,
      },
      {
        field: "meeting_recap",
        rendered_text_hash: sha256Text(extractMarkdownSection(finalBodyMd, "Meeting Recap")),
        source_role: "transcript_derived_section_summary",
        source_class: "transcript_derived_summary",
        source_artifact: agendaSummaryPya,
        meeting_ref: path.basename(meetingDir),
        transcript_hash: sha256Text(safeReadText(normalizedPlain, "")),
        fallback_used: false,
        fallback_type: "",
        factual_content_introduced_by_fallback: false,
        claim_role: inferClaimRole(extractMarkdownSection(finalBodyMd, "Meeting Recap")),
        rendered_claim_role: inferClaimRole(extractMarkdownSection(finalBodyMd, "Meeting Recap")),
        role_upgrade_detected: contentAudits.meetingRecap.roleUpgradeDetected,
        unsupported_outcome_verbs: contentAudits.meetingRecap.unsupportedOutcomeVerbs,
        unsupported_agenda_roles: contentAudits.meetingRecap.unsupportedRoles,
      },
    ];
    const blockedFields = renderedFields.filter((f) =>
      !String(f.source_class || "").startsWith("transcript_derived")
      || f.factual_content_introduced_by_fallback
      || f.role_upgrade_detected
    );
    const contentAuditDecision = blockedFields.length ? "BLOCK" : "PASS";
    const contentAuditReasons = blockedFields.map((f) => `blocked_field:${f.field}`);
    writeContentSourceAuditPya(contentSourceAuditPath, {
      meetingRef: path.basename(meetingDir),
      decision: contentAuditDecision,
      reasons: contentAuditReasons,
      fallbackCountTotal: 0,
      contentFallbackCount: 0,
      structuralFallbackCount: 0,
      omittedOptionalSections,
      renderedFields,
    });
    if (contentAuditDecision !== "PASS") {
      throw new Error(`content-source audit blocked | report=${contentSourceAuditPath} | reasons=${contentAuditReasons.join(",")}`);
    }

    const payload = {
      title: finalTitle,
      body_markdown: finalBodyMd,
      transcript_url: canonicalUrl,
      local_transcript_html: htmlPath,
      local_cover_image: existsFile(coverImageStablePath) ? coverImageStablePath : (existsFile(coverImagePath) ? coverImagePath : ''),
      local_attachment_index: canonicalAgendaIndex,
      jurisdiction,
      body,
      meeting_route_slug: meetingRouteSlug,
      date_iso: dateInfo.iso,
      hook: hookTitle,
      focus,
      source: {
        meeting_url: meetingUrl || '',
        video_url: preferredVideo,
        agenda_url: agendaPageUrl,
      },
      discussion_url: discussionUrl || '',
      generated_at_utc: new Date().toISOString(),
    };

    const publishEvidencePath = path.join(transcriptDir, `${normPrefix}.publish-evidence-validation.pya`);
    const transcriptEvidenceText = String(safeReadText(normalizedPlain, '') || safeReadText(basePlain, '') || '').toLowerCase();
    const forbiddenChecks = [];
    const recapMarkdownText = String(extractMarkdownSection(payload.body_markdown, 'Meeting Recap') || '').trim();
    const fieldChecks = [
      { field: 'title', pass: String(payload.title || '').trim().length > 0 },
      { field: 'hook', pass: String(payload.hook || '').trim().length > 0 },
      { field: 'body_markdown', pass: String(payload.body_markdown || '').trim().length > 40 },
      {
        field: 'one_sentence_summary',
        pass: !extractMarkdownSection(payload.body_markdown, 'One-Sentence Summary')
          || String(extractMarkdownSection(payload.body_markdown, 'One-Sentence Summary') || '').trim().length > 20
      },
      {
        field: 'meeting_recap',
        pass: recapMarkdownText.length > 80
          || (recapBlocks.length > 0 && countTranscriptRecapWords(recapBlocks) >= 40)
          || (abortedNoQuorumMeeting && recapBlocks.length > 0)
      },
    ];
    const topNewsChecks = extractTopNewsBullets(payload.body_markdown).map((item, idx) => {
      const text = `${item.title} ${item.body}`.toLowerCase();
      const words = text.split(/[^a-z0-9]+/u).filter((w) => w.length >= 5).slice(0, 12);
      const hits = words.filter((w) => transcriptEvidenceText.includes(w)).length;
      // This is a final lexical sanity check after the source-aware claim
      // verifier. Allow normal paraphrases such as "snow removal" for
      // transcript wording about plowing while still requiring source overlap.
      const pass = hits >= Math.max(1, Math.floor(words.length / 5));
      return { index: idx + 1, title: item.title, pass, tokenHits: hits, tokenCount: words.length };
    });
    const reasons = [];
    for (const c of fieldChecks) if (!c.pass) reasons.push(`field_invalid:${c.field}`);
    for (const c of topNewsChecks) if (!c.pass) reasons.push(`top_news_unsupported:${c.index}`);
    const decision = reasons.length ? 'BLOCK' : 'PASS';
    writePublishEvidenceValidationPya(publishEvidencePath, {
      meetingRef: path.basename(meetingDir),
      transcriptSourceFile: existsFile(normalizedPlain) ? normalizedPlain : basePlain,
      payloadFile: lemmyPayloadPath,
      decision,
      reasons,
      forbiddenChecks,
      fieldChecks,
      topNewsChecks,
    });
    if (decision !== 'PASS') {
      throw new Error(`publish evidence validation blocked | report=${publishEvidencePath} | reasons=${reasons.join(',')}`);
    }

    fs.writeFileSync(lemmyPayloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.writeFileSync(lemmyBodyPath, `${finalBodyMd}\n`, 'utf8');
    log(`[full-pipeline] wrote: ${lemmyPayloadPath}`);
    log(`[full-pipeline] wrote: ${lemmyBodyPath}`);

    const publishCfg = normalizePublishConfig({
      env: process.env,
      adapter: OWEN_ADAPTER,
      fallbackCommand: '',
    });
    const postCmd = String(publishCfg.command || '').trim();
    if (postCmd) {
      await runWithStreaming({
        cmd: 'bash',
        args: ['-lc', `${postCmd} "${lemmyPayloadPath.replace(/"/gu, '\\"')}"`],
        cwd: ROOT,
        timeoutMs: 10 * 60 * 1000,
        label: 'lemmy-submit',
      });
    } else {
      log('[full-pipeline] lemmy submit skipped (set OWEN_LEMMY_POST_COMMAND or MEETING_POST_COMMAND to enable)');
    }
  }, {
    skipWhen: () => skipLemmy || (!forcePostStage && lemmyPayloadCheckpointValid()),
  });
  }

  const reportPath = path.join(transcriptDir, `${normPrefix}.full-pipeline.report.pya`);
  const legacyReportJsonPath = path.join(transcriptDir, `${normPrefix}.full-pipeline.report.json`);
  savePyaReportArtifact(reportPath, {
    transcript_dir: transcriptDir,
    base_prefix: basePrefix,
    normalized_prefix: normPrefix,
    focus,
    jurisdiction,
    body,
    site_url: siteUrl,
    discussion_url: discussionUrl,
    voices_base_dir: baseVoicesDir,
    voices_work_dir: voicesWorkDir,
    audio_seconds: audioSeconds,
    stages: stageStatus,
    outputs: {
      normalized_plain: normalizedPlain,
      speaker_srt: speakerSrt,
      agenda_summary_pya: agendaSummaryPya,
      meeting_summary_md: meetingSummaryMd,
      meeting_hook_txt: meetingHookTxt,
      html: htmlPath,
      image: existsFile(coverImageStablePath) ? coverImageStablePath : (existsFile(coverImagePath) ? coverImagePath : ''),
      lemmy_payload: lemmyPayloadPath,
    },
    generated_at_utc: new Date().toISOString(),
  }, { rootName: 'full pipeline report' });
  if (existsFile(legacyReportJsonPath)) fs.unlinkSync(legacyReportJsonPath);

  log(`[full-pipeline] report: ${reportPath}`);
  log('[full-pipeline] complete');
}

export { buildRankedTopNewsFromAgenda };

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = path.resolve(fileURLToPath(import.meta.url));
let directInvocation = invokedPath === modulePath;
if (!directInvocation && invokedPath) {
  try {
    directInvocation = fs.realpathSync(invokedPath) === fs.realpathSync(modulePath);
  } catch {}
}

if (directInvocation) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
    process.exit(1);
  });
}
