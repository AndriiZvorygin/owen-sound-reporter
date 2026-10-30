#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = '/home/htaf/pyac/pyash';

function usage() {
  return [
    'Usage: node program/generate-meeting-hook-from-transcript-folder.mjs <transcript_dir> [prefix] [focus] [jurisdiction] [body]',
    'Example: node ... artifacts/.../transcript meeting-qwen-auto-normalized "newsworthy juicy bits" "Owen Sound" "Council"',
  ].join('\n');
}

function resolvePath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(process.cwd(), raw);
}

function main() {
  const transcriptDirArg = process.argv[2];
  const prefixArg = process.argv[3] || 'auto';
  const focusArg = process.argv[4] || '';
  const jurisdictionArg = process.argv[5] || 'Owen Sound';
  const bodyArg = process.argv[6] || 'Council';
  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const scriptPath = path.join(ROOT, 'command/generate_meeting_hook_from_transcript_folder.mjs');
  const args = [resolvePath(transcriptDirArg), String(prefixArg), String(focusArg), String(jurisdictionArg), String(bodyArg)];

  const run = spawnSync('node', [scriptPath, ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 100,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  process.exit(run.status ?? 1);
}

main();
