#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOUSE = '/home/htaf/pyac/pyash/world/house/owen-sound-reporter';
const DEFAULT_MEETINGS_DIR = path.join(HOUSE, 'artifacts/owen-sound/meetings');
const PUBLISH_SCRIPT = path.join(HOUSE, 'program/publish-meeting-to-helpos-from-payload.mjs');

function usage() {
  return [
    'Usage: node program/publish-bulk-meeting-updates.mjs [meetings_dir] [match_text] [dry_run]',
    'Examples:',
    '  node program/publish-bulk-meeting-updates.mjs',
    '  node program/publish-bulk-meeting-updates.mjs artifacts/owen-sound/meetings 2026-03-23 1',
  ].join('\n');
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function extractPostUrlFromText(src) {
  const m = String(src || '').match(/https:\/\/helpos\.ca\/c\/[^\s"'<>]+/iu);
  return m ? String(m[0]).trim() : '';
}

function latestResponseFileWithPostUrl(transcriptDir) {
  const names = fs.readdirSync(transcriptDir)
    .filter((n) => n.endsWith('.meeting-publish.response.json'))
    .sort((a, b) => {
      const ap = path.join(transcriptDir, a);
      const bp = path.join(transcriptDir, b);
      const am = Number(fs.statSync(ap).mtimeMs || 0);
      const bm = Number(fs.statSync(bp).mtimeMs || 0);
      return bm - am || a.localeCompare(b);
    });
  for (const name of names) {
    const p = path.join(transcriptDir, name);
    try {
      const postUrl = String(readJson(p)?.post_url || '').trim();
      if (postUrl) return p;
    } catch {}
  }
  return '';
}

function postUrlFromTranscriptHtml(transcriptDir) {
  const htmlPath = path.join(transcriptDir, 'transcript-page.html');
  if (!isFile(htmlPath)) return '';
  try {
    return extractPostUrlFromText(fs.readFileSync(htmlPath, 'utf8'));
  } catch {
    return '';
  }
}

function collectUpdateTargets(meetingsDir, matchText) {
  const out = [];
  for (const meetingName of fs.readdirSync(meetingsDir).sort()) {
    if (matchText && !meetingName.includes(matchText)) continue;
    const transcriptDir = path.join(meetingsDir, meetingName, 'transcript');
    if (!isDir(transcriptDir)) continue;
    const payloadPath = path.join(transcriptDir, 'meeting-qwen-auto-normalized.lemmy-post.json');
    if (!isFile(payloadPath)) continue;
    const respPath = latestResponseFileWithPostUrl(transcriptDir);
    let postUrl = '';
    if (respPath) {
      try { postUrl = String(readJson(respPath)?.post_url || '').trim(); } catch {}
    }
    if (!postUrl) postUrl = postUrlFromTranscriptHtml(transcriptDir);
    if (!postUrl) continue;
    out.push({ meetingName, transcriptDir, payloadPath, respPath, postUrl });
  }
  return out;
}

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => {
      const text = String(buf || '');
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (buf) => {
      const text = String(buf || '');
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`command failed code=${code ?? 'null'} signal=${signal ?? ''}\n${stderr || stdout}`.trim()));
    });
  });
}

async function main() {
  const meetingsDirArg = process.argv[2] || DEFAULT_MEETINGS_DIR;
  const matchText = String(process.argv[3] || '').trim();
  const dryRun = /^(1|true|yes)$/iu.test(String(process.argv[4] || '0'));
  const betweenMeetingsMs = Math.max(
    0,
    Number.parseInt(String(process.env.BULK_PUBLISH_BETWEEN_MS || '20000'), 10) || 20_000,
  );

  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const meetingsDir = path.isAbsolute(meetingsDirArg)
    ? meetingsDirArg
    : path.resolve(process.cwd(), meetingsDirArg);
  if (!isDir(meetingsDir)) throw new Error(`meetings directory not found: ${meetingsDir}`);

  const targets = collectUpdateTargets(meetingsDir, matchText);
  process.stdout.write(`[bulk-publish] meetings dir: ${meetingsDir}\n`);
  process.stdout.write(`[bulk-publish] match: ${matchText || '(all)'}\n`);
  process.stdout.write(`[bulk-publish] targets: ${targets.length}\n`);
  process.stdout.write(`[bulk-publish] between_meetings_ms: ${betweenMeetingsMs}\n`);
  if (!targets.length) return;

  const ok = [];
  const failed = [];
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    process.stdout.write(`[bulk-publish] atindex num ${i + 1} toindex num ${targets.length} meeting "${t.meetingName}"\n`);
    if (dryRun) {
      process.stdout.write(`[bulk-publish] dry-run payload: ${t.payloadPath}\n`);
      ok.push({ meeting: t.meetingName, dry_run: true });
      continue;
    }
    const stamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
    const key = `bulk-refresh-${stamp}-${String(i + 1).padStart(2, '0')}`;
    try {
      await runNode([PUBLISH_SCRIPT, t.payloadPath, '', key, t.postUrl], HOUSE);
      ok.push({ meeting: t.meetingName, post_url: t.postUrl });
    } catch (err) {
      failed.push({ meeting: t.meetingName, post_url: t.postUrl, error: String(err?.message || err) });
    }
    if (i + 1 < targets.length && !dryRun) await sleep(betweenMeetingsMs);
  }

  process.stdout.write(`[bulk-publish] ok: ${ok.length}\n`);
  process.stdout.write(`[bulk-publish] failed: ${failed.length}\n`);
  for (const f of failed) {
    process.stdout.write(`[bulk-publish] fail ${f.meeting}: ${f.error.slice(0, 300)}\n`);
  }

  const reportPath = path.join(HOUSE, 'artifacts', `bulk-publish-report-${new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14)}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    meetings_dir: meetingsDir,
    match: matchText,
    dry_run: dryRun,
    ok,
    failed,
    generated_at_utc: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  process.stdout.write(`[bulk-publish] report: ${reportPath}\n`);

  if (failed.length) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
