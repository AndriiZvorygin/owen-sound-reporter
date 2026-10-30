#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = '/home/htaf/pyac/pyash';
const HOUSE = '/home/htaf/pyac/pyash/world/house/owen-sound-reporter';

function usage() {
  return [
    'Usage: node program/refresh-named-voices-from-speaker-srt.mjs <transcript_dir> [prefix] [voices_dir]',
    'Example: node ... artifacts/.../transcript meeting-qwen-auto-normalized.sentences /home/htaf/pyac/pyash/world/voices',
  ].join('\n');
}

function parseTime(raw) {
  const m = String(raw || '').match(/^(\d\d):(\d\d):(\d\d),(\d\d\d)$/u);
  if (!m) return 0;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ms = Number(m[4]);
  return (hh * 3600) + (mm * 60) + ss + (ms / 1000);
}

function parseSrtRows(srtText) {
  const src = String(srtText || '').replace(/\r\n/g, '\n');
  const blocks = src.split(/\n{2,}/u).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const tm = lines[1].trim().match(/^(\d\d:\d\d:\d\d,\d\d\d)\s+-->\s+(\d\d:\d\d:\d\d,\d\d\d)$/u);
    if (!tm) continue;
    const since = parseTime(tm[1]);
    const until = parseTime(tm[2]);
    const body = lines.slice(2).join(' ').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const sm = body.match(/^([^:]{2,80}):\s+(.+)$/u);
    const speaker = sm ? String(sm[1]).trim() : '';
    const speech = sm ? String(sm[2]).trim() : body;
    out.push({ since, until, speaker, speech });
  }
  return out;
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/u).filter(Boolean).length;
}

function normalizeName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .replace(/_+/gu, '_');
}

function pickSpeakerSrt(transcriptDir, prefix) {
  if (prefix && prefix !== 'auto') {
    const p = path.join(transcriptDir, `${prefix}.speaker.sentence.srt`);
    if (!fs.existsSync(p)) throw new Error(`speaker srt missing: ${p}`);
    return p;
  }
  const files = fs.readdirSync(transcriptDir).filter((n) => n.endsWith('.speaker.sentence.srt'));
  if (!files.length) throw new Error(`no *.speaker.sentence.srt found in ${transcriptDir}`);
  const ranked = files.map((name) => {
    const lower = name.toLowerCase();
    const st = fs.statSync(path.join(transcriptDir, name));
    let score = 0;
    if (lower.includes('.normalized.')) score += 20;
    if (lower.includes('.sentences.')) score += 10;
    if (lower.startsWith('meeting-qwen-auto')) score += 5;
    return { name, score, mtime: Number(st.mtimeMs || 0) };
  }).sort((a, b) => b.score - a.score || b.mtime - a.mtime || a.name.localeCompare(b.name));
  return path.join(transcriptDir, ranked[0].name);
}

function pickAudioFile(transcriptDir) {
  const names = fs.readdirSync(transcriptDir).filter((n) => /\.(opus|wav|m4a|mp3)$/iu.test(n));
  if (!names.length) throw new Error(`no audio file found in ${transcriptDir}`);
  const ranked = names.map((name) => {
    const lower = name.toLowerCase();
    const st = fs.statSync(path.join(transcriptDir, name));
    let score = 0;
    if (lower === 'meeting-audio.opus') score += 1000;
    if (lower.endsWith('.opus')) score += 700;
    if (lower.endsWith('.wav')) score += 500;
    return { name, score, size: Number(st.size || 0), mtime: Number(st.mtimeMs || 0) };
  }).sort((a, b) => b.score - a.score || b.size - a.size || b.mtime - a.mtime || a.name.localeCompare(b.name));
  return path.join(transcriptDir, ranked[0].name);
}

function chooseBestRow(rows) {
  const filtered = rows.filter((r) => {
    const dur = Math.max(0, r.until - r.since);
    const words = countWords(r.speech);
    if (dur < 2.6 || dur > 11.0) return false;
    if (words < 8 || words > 70) return false;
    if (/^(yes|no|okay|thanks?|thank you|all in favor)\.?$/iu.test(String(r.speech || '').trim())) return false;
    return true;
  });
  const src = filtered.length ? filtered : rows;
  if (!src.length) return null;
  const scored = src.map((r) => {
    const dur = Math.max(0, r.until - r.since);
    const words = countWords(r.speech);
    const idealDur = 5.8;
    const durScore = Math.max(0, 1 - (Math.abs(dur - idealDur) / idealDur));
    const wordsScore = Math.max(0, 1 - (Math.abs(words - 20) / 20));
    const punctuation = /[.,;:!?]/u.test(r.speech) ? 0.2 : 0;
    const score = (durScore * 0.55) + (wordsScore * 0.35) + punctuation;
    return { r, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].r;
}

function ffmpegExtractAndTrim({ audioPath, since, until, outPath }) {
  const start = Math.max(0, Number(since) - 0.12);
  const end = Math.max(start + 0.3, Number(until) + 0.12);
  const tmpPath = `${outPath}.tmp.wav`;
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(start),
    '-to', String(end),
    '-i', audioPath,
    '-ac', '1', '-ar', '16000',
    tmpPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', tmpPath,
    '-af', 'silenceremove=start_periods=1:start_duration=0.15:start_threshold=-38dB:stop_periods=1:stop_duration=0.20:stop_threshold=-42dB',
    '-ac', '1', '-ar', '16000',
    outPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  try { fs.unlinkSync(tmpPath); } catch {}
}

function nowTag() {
  return new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
}

function main() {
  const transcriptDirArg = process.argv[2];
  const prefixArg = process.argv[3] || 'auto';
  const voicesDirArg = process.argv[4] || path.join(ROOT, 'world', 'voices');
  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }
  const transcriptDir = path.isAbsolute(transcriptDirArg)
    ? transcriptDirArg
    : path.resolve(process.cwd(), transcriptDirArg);
  const voicesDir = path.isAbsolute(voicesDirArg)
    ? voicesDirArg
    : path.resolve(process.cwd(), voicesDirArg);
  if (!fs.existsSync(transcriptDir)) throw new Error(`transcript directory missing: ${transcriptDir}`);
  if (!fs.existsSync(voicesDir)) throw new Error(`voices directory missing: ${voicesDir}`);

  const srtPath = pickSpeakerSrt(transcriptDir, prefixArg);
  const audioPath = pickAudioFile(transcriptDir);
  const rows = parseSrtRows(fs.readFileSync(srtPath, 'utf8'));
  const bySpeaker = new Map();
  for (const row of rows) {
    const key = normalizeName(row.speaker);
    if (!key || /^speaker_\d+$/iu.test(key)) continue;
    if (!bySpeaker.has(key)) bySpeaker.set(key, []);
    bySpeaker.get(key).push(row);
  }

  const voiceKeys = fs.readdirSync(voicesDir)
    .filter((n) => n.endsWith('.wav'))
    .map((n) => n.replace(/\.wav$/u, ''))
    .filter((k) => !/^speaker_\d+$/iu.test(k) && k !== 'index')
    .sort();
  const backupDir = path.join(voicesDir, `archive-named-wavs-${nowTag()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const refreshed = [];
  const skipped = [];
  for (const key of voiceKeys) {
    const candidates = bySpeaker.get(key) || [];
    if (!candidates.length) {
      skipped.push({ key, reason: 'no_rows_for_speaker' });
      continue;
    }
    const best = chooseBestRow(candidates);
    if (!best) {
      skipped.push({ key, reason: 'no_candidate_clip' });
      continue;
    }
    const target = path.join(voicesDir, `${key}.wav`);
    const backup = path.join(backupDir, `${key}.wav`);
    if (fs.existsSync(target)) fs.copyFileSync(target, backup);
    ffmpegExtractAndTrim({ audioPath, since: best.since, until: best.until, outPath: target });
    refreshed.push({
      key,
      since: best.since,
      until: best.until,
      words: countWords(best.speech),
      text: String(best.speech).slice(0, 120),
    });
  }

  process.stdout.write(`[voices-refresh] transcript dir: ${transcriptDir}\n`);
  process.stdout.write(`[voices-refresh] speaker srt: ${srtPath}\n`);
  process.stdout.write(`[voices-refresh] audio: ${audioPath}\n`);
  process.stdout.write(`[voices-refresh] voices dir: ${voicesDir}\n`);
  process.stdout.write(`[voices-refresh] backup dir: ${backupDir}\n`);
  process.stdout.write(`[voices-refresh] refreshed: ${refreshed.length}\n`);
  for (const r of refreshed) {
    process.stdout.write(
      `[voices-refresh] ${r.key} clip ${r.since.toFixed(2)}-${r.until.toFixed(2)}s words ${r.words} text "${r.text}"\n`
    );
  }
  process.stdout.write(`[voices-refresh] skipped: ${skipped.length}\n`);
  for (const s of skipped) {
    process.stdout.write(`[voices-refresh] skip ${s.key}: ${s.reason}\n`);
  }
}

main();
