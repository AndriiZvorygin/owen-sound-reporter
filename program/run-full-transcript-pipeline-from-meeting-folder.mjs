#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = '/home/htaf/pyac/pyash';
const HOUSE = path.join(ROOT, 'world/house/owen-sound-reporter');

function usage() {
  return [
    'Usage: node program/run-full-transcript-pipeline-from-meeting-folder.mjs <meeting_dir> [base_prefix] [focus] [jurisdiction] [body] [site_url] [discussion_url]',
    'Example: node ... artifacts/owen-sound/meetings/2026-03-23_council-meeting-regular_f3b0c55c meeting-qwen-auto "clear, neutral reporting of consequential decisions and public concerns" "Owen Sound" "Council" "https://helpos.ca" ""',
  ].join('\n');
}

function ensureDir(dirPath, label) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`${label} not found: ${dirPath}`);
}

function resolveReporterPath(inputPath) {
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
  const fromCwd = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(HOUSE, inputPath);
}

function runWithStreaming({ cmd, args, cwd = ROOT, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      process.stdout.write(String(chunk ?? ''));
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(String(chunk ?? ''));
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`pipeline failed (code=${code ?? 'null'} signal=${signal ?? ''})`));
    });
  });
}

async function main() {
  const meetingDirArg = process.argv[2];
  if (!meetingDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const meetingDir = resolveReporterPath(meetingDirArg);
  ensureDir(meetingDir, 'meeting directory');

  const transcriptDir = path.join(meetingDir, 'transcript');
  ensureDir(transcriptDir, 'transcript directory');

  const passArgs = process.argv.slice(3);

  process.stdout.write(`[full-pipeline-meeting] meeting dir: ${meetingDir}\n`);
  process.stdout.write(`[full-pipeline-meeting] transcript dir: ${transcriptDir}\n`);

  await runWithStreaming({
    cmd: 'node',
    args: [
      path.join(HOUSE, 'program/run-full-transcript-pipeline.mjs'),
      transcriptDir,
      ...passArgs,
    ],
    cwd: ROOT,
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
