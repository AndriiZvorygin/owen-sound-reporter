#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = '/home/htaf/pyac/pyash';

function usage() {
  return [
    'Usage: node program/render-transcript-html-from-transcript-folder.mjs <transcript_dir> [output_html] [jurisdiction] [body] [site_url] [discussion_url] [source_url] [video_url] [hook] [agenda_url] [canonical_url]',
    'Example: node ... artifacts/.../transcript transcript.html "Owen Sound" "Council" "https://helpos.ca" "https://helpos.ca/post/..." "https://owensound.ca/..." "https://www.youtube.com/..."',
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
  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const passthrough = process.argv.slice(3);
  const scriptPath = path.join(ROOT, 'command/render_transcript_html_from_transcript_folder.mjs');
  const args = [resolvePath(transcriptDirArg), ...passthrough];

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
