#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = '/home/htaf/pyac/pyash';
const HOUSE = path.join(ROOT, 'world/house/owen-sound-reporter');
const DEFAULT_MEETINGS_DIR = path.join(HOUSE, 'artifacts/owen-sound/meetings');
const DEFAULT_VOICES_DIR = path.join(ROOT, 'world/voices');

function usage() {
  return [
    'Usage: node program/backfill-missing-voice-wavs-from-meetings.mjs [meetings_dir] [voices_dir]',
    'Example: node ... world/house/owen-sound-reporter/artifacts/owen-sound/meetings world/voices',
  ].join('\n');
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/u).filter(Boolean).length;
}

function scoreRow(row) {
  const since = Number(row?.since || 0);
  const until = Number(row?.until || 0);
  const dur = Math.max(0, until - since);
  const words = countWords(row?.text || '');
  if (dur < 2.0 || dur > 12.0) return -1;
  if (words < 5 || words > 85) return -1;
  if (/^(yes|no|okay|thanks?|thank you|all in favor)\.?$/iu.test(String(row?.text || '').trim())) return -1;
  const durScore = Math.max(0, 1 - (Math.abs(dur - 6.0) / 6.0));
  const wordsScore = Math.max(0, 1 - (Math.abs(words - 22) / 22));
  const punctuation = /[.,;:!?]/u.test(String(row?.text || '')) ? 0.2 : 0;
  return (durScore * 0.6) + (wordsScore * 0.4) + punctuation;
}

function extractWav({ audioPath, since, until, outPath }) {
  const start = Math.max(0, Number(since) - 0.10);
  const end = Math.max(start + 0.35, Number(until) + 0.12);
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
    '-af', 'silenceremove=start_periods=1:start_duration=0.12:start_threshold=-37dB:stop_periods=1:stop_duration=0.18:stop_threshold=-42dB',
    '-ac', '1', '-ar', '16000',
    outPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  try { fs.unlinkSync(tmpPath); } catch {}
}

function findSpeakerJsonFiles(meetingsDir) {
  const out = [];
  for (const meetingName of fs.readdirSync(meetingsDir)) {
    const meetingDir = path.join(meetingsDir, meetingName);
    if (!isDir(meetingDir)) continue;
    const transcriptDir = path.join(meetingDir, 'transcript');
    if (!isDir(transcriptDir)) continue;
    const files = fs.readdirSync(transcriptDir)
      .filter((n) => n.endsWith('.speaker.sentences.json') || n.endsWith('.sentences.speaker.sentences.json'))
      .sort();
    for (const name of files) out.push(path.join(transcriptDir, name));
  }
  return out;
}

function scoreAudioName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower === 'meeting-audio.opus') return 1000;
  if (lower === 'meeting-audio.wav') return 900;
  if (lower === 'meeting-audio.mp3') return 850;
  if (lower.endsWith('.opus')) return 500;
  if (lower.endsWith('.wav')) return 400;
  if (lower.endsWith('.mp3')) return 300;
  if (lower.endsWith('.m4a')) return 250;
  if (lower.endsWith('.aac')) return 240;
  if (lower.endsWith('.flac')) return 230;
  return 0;
}

function pickAudioFromTranscriptDir(transcriptDir) {
  const files = fs.readdirSync(transcriptDir)
    .filter((n) => isFile(path.join(transcriptDir, n)))
    .map((name) => ({ name, score: scoreAudioName(name) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  if (!files.length) return '';
  return path.join(transcriptDir, files[0].name);
}

function loadMissingSpeakerKeys(voicesDir) {
  const names = fs.readdirSync(voicesDir);
  const pyaKeys = names
    .filter((n) => n.endsWith('.pya') && n !== 'index.pya')
    .map((n) => n.replace(/\.pya$/u, ''))
    .filter((k) => /^speaker_\d+$/iu.test(k));
  const missing = new Set();
  for (const key of pyaKeys) {
    if (!isFile(path.join(voicesDir, `${key}.wav`))) missing.add(key);
  }
  return missing;
}

function main() {
  const meetingsDirArg = process.argv[2] || DEFAULT_MEETINGS_DIR;
  const voicesDirArg = process.argv[3] || DEFAULT_VOICES_DIR;
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const meetingsDir = path.isAbsolute(meetingsDirArg) ? meetingsDirArg : path.resolve(process.cwd(), meetingsDirArg);
  const voicesDir = path.isAbsolute(voicesDirArg) ? voicesDirArg : path.resolve(process.cwd(), voicesDirArg);
  if (!isDir(meetingsDir)) throw new Error(`meetings directory not found: ${meetingsDir}`);
  if (!isDir(voicesDir)) throw new Error(`voices directory not found: ${voicesDir}`);

  const missing = loadMissingSpeakerKeys(voicesDir);
  if (!missing.size) {
    process.stdout.write('[voice-backfill] nothing to do (no missing speaker wav files)\n');
    return;
  }

  const speakerJsonFiles = findSpeakerJsonFiles(meetingsDir);
  if (!speakerJsonFiles.length) throw new Error(`no *.speaker.sentences.json found under ${meetingsDir}`);

  const bestBySpeaker = new Map();
  for (const jsonPath of speakerJsonFiles) {
    let obj = null;
    try { obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { continue; }
    const transcriptDir = path.dirname(jsonPath);
    const audioFromJson = String(obj?.audio || '').trim();
    const audioPath = (audioFromJson && isFile(audioFromJson)) ? audioFromJson : pickAudioFromTranscriptDir(transcriptDir);
    if (!audioPath || !isFile(audioPath)) continue;
    const rows = Array.isArray(obj?.rows) ? obj.rows : [];
    for (const row of rows) {
      const key = String(row?.speaker_key || '').trim().toLowerCase();
      if (!missing.has(key)) continue;
      const s = scoreRow(row);
      if (s < 0) continue;
      const prev = bestBySpeaker.get(key);
      if (!prev || s > prev.score) {
        bestBySpeaker.set(key, { score: s, row, audioPath, jsonPath });
      }
    }
  }

  let created = 0;
  const skipped = [];
  for (const key of [...missing].sort()) {
    const pick = bestBySpeaker.get(key);
    if (!pick) {
      skipped.push({ key, reason: 'no_candidate_row' });
      continue;
    }
    const outPath = path.join(voicesDir, `${key}.wav`);
    try {
      extractWav({
        audioPath: pick.audioPath,
        since: Number(pick.row?.since || 0),
        until: Number(pick.row?.until || 0),
        outPath,
      });
      created += 1;
      process.stdout.write(
        `[voice-backfill] created ${key}.wav from ${path.basename(pick.jsonPath)} ${Number(pick.row?.since || 0).toFixed(2)}-${Number(pick.row?.until || 0).toFixed(2)}s\n`
      );
    } catch (err) {
      skipped.push({ key, reason: `ffmpeg_failed: ${String(err?.message || err)}` });
    }
  }

  process.stdout.write(`[voice-backfill] meetings: ${meetingsDir}\n`);
  process.stdout.write(`[voice-backfill] voices: ${voicesDir}\n`);
  process.stdout.write(`[voice-backfill] missing before: ${missing.size}\n`);
  process.stdout.write(`[voice-backfill] created: ${created}\n`);
  process.stdout.write(`[voice-backfill] skipped: ${skipped.length}\n`);
  for (const item of skipped.slice(0, 50)) {
    process.stdout.write(`[voice-backfill] skip ${item.key}: ${item.reason}\n`);
  }
}

main();
