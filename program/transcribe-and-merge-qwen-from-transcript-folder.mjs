#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PROGRAM_DIR, '../../../..');
const HOUSE = path.resolve(PROGRAM_DIR, '..');

function usage() {
  return [
    'Usage: node program/transcribe-and-merge-qwen-from-transcript-folder.mjs <transcript_dir> [prefix]',
    'Example: node ... world/house/owen-sound-reporter/artifacts/owen-sound/meetings/<meeting>/transcript meeting-qwen-auto'
  ].join('\n');
}

function ensureDir(dirPath) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) {
    throw new Error(`transcript directory not found: ${dirPath}`);
  }
}

function candidateRank(name) {
  const lower = name.toLowerCase();
  if (lower === 'meeting-audio.opus') return 1000;
  if (lower === 'meeting-audio.wav') return 900;
  if (lower === 'meeting-audio.mp3') return 850;
  if (lower.endsWith('.opus')) return 500;
  if (lower.endsWith('.wav')) return 400;
  if (lower.endsWith('.mp3')) return 300;
  if (lower.endsWith('.m4a')) return 250;
  return 0;
}

function pickAudioFile(transcriptDir) {
  const entries = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => /\.(opus|wav|mp3|m4a)$/i.test(name));

  if (entries.length === 0) {
    throw new Error(`no audio file found in transcript directory: ${transcriptDir}`);
  }

  const ranked = entries
    .map((name) => {
      const full = path.join(transcriptDir, name);
      const st = fs.statSync(full);
      return {
        name,
        full,
        rank: candidateRank(name),
        size: Number(st.size || 0),
        mtimeMs: Number(st.mtimeMs || 0)
      };
    })
    .sort((a, b) =>
      b.rank - a.rank ||
      b.size - a.size ||
      b.mtimeMs - a.mtimeMs ||
      a.name.localeCompare(b.name)
    );

  return ranked[0].full;
}

function runChildStreaming(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', (chunk) => {
      process.stdout.write(String(chunk ?? ''));
    });
    proc.stderr.on('data', (chunk) => {
      process.stderr.write(String(chunk ?? ''));
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`child exited with code ${code}`));
    });
  });
}

async function main() {
  const transcriptDirArg = process.argv[2];
  const prefix = process.argv[3] || 'meeting-qwen-auto';
  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const transcriptDir = path.resolve(process.cwd(), transcriptDirArg);
  ensureDir(transcriptDir);
  const audioPath = pickAudioFile(transcriptDir);

  process.stdout.write(`[qwen-merge-folder] transcript dir: ${transcriptDir}\n`);
  process.stdout.write(`[qwen-merge-folder] selected audio: ${audioPath}\n`);

  await runChildStreaming([
    path.join(HOUSE, 'program/transcribe-and-merge-qwen-from-filename.mjs'),
    audioPath,
    transcriptDir,
    prefix
  ]);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
