#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = '/home/htaf/pyac/pyash';

function usage() {
  return [
    'Usage: node program/relabel-speaker-sentence-srt-from-transcript-folder.mjs <transcript_dir> [prefix] [voices_dir]',
    'Example: node ... artifacts/owen-sound/meetings/<meeting>/transcript meeting-qwen-auto world/voices',
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
  const voicesDirArg = process.argv[4] || '';
  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const scriptPath = path.join(ROOT, 'command/relabel_speaker_sentence_srt_from_transcript_folder.mjs');
  const args = [resolvePath(transcriptDirArg), String(prefixArg)];
  if (voicesDirArg) args.push(resolvePath(voicesDirArg));

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
