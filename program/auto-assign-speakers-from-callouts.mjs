#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = '/home/htaf/pyac/pyash';
const HOUSE = path.join(ROOT, 'world/house/owen-sound-reporter');
const DEFAULT_ROSTER = path.join(HOUSE, 'artifacts/owen-sound/2022-2026-council.txt');
const DEFAULT_VOICES = path.join(ROOT, 'world/voices');

function usage() {
  return [
    'Usage: node program/auto-assign-speakers-from-callouts.mjs <transcript_dir> [prefix] [roster_file] [voices_dir]',
    'Example: node ... artifacts/.../transcript meeting-qwen-auto-normalized.sentences /home/.../2022-2026-council.txt /home/.../world/voices',
  ].join('\n');
}

function resolveReporterPath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return path.normalize(raw);
  const fromCwd = path.resolve(process.cwd(), raw);
  return fromCwd;
}

function main() {
  const transcriptDirArg = process.argv[2];
  const prefixArg = process.argv[3] || 'auto';
  const rosterArg = process.argv[4] || DEFAULT_ROSTER;
  const voicesArg = process.argv[5] || DEFAULT_VOICES;

  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const scriptPath = path.join(ROOT, 'command/auto_assign_speakers_from_callouts.mjs');
  const run = spawnSync('node', [
    scriptPath,
    resolveReporterPath(transcriptDirArg),
    String(prefixArg),
    resolveReporterPath(rosterArg),
    resolveReporterPath(voicesArg),
  ], {
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
