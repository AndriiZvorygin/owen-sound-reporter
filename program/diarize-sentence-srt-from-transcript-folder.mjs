#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = '/home/htaf/pyac/pyash';

function usage() {
  return [
    'Usage: node program/diarize-sentence-srt-from-transcript-folder.mjs <transcript_dir> [prefix] [voices_dir]',
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

  const scriptPath = path.join(ROOT, 'command/diarize_sentence_srt_from_transcript_folder.mjs');
  const args = [resolvePath(transcriptDirArg), String(prefixArg)];
  if (voicesDirArg) args.push(resolvePath(voicesDirArg));

  const child = spawn('node', [scriptPath, ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(String(chunk || ''));
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(String(chunk || ''));
  });

  child.on('error', (err) => {
    process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
    process.exit(1);
  });
  child.on('close', (code) => {
    process.exit(code ?? 1);
  });
}

main();
