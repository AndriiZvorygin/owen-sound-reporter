#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OWEN_ADAPTER } from './writer-adapter-owen-sound.mjs';
import { buildRunNextConfig } from '../../../../program/library/reporter_shared/writer-adapter-interface.mjs';
import { applyPublishEnvNormalization } from '../../../../program/publisher-interface.mjs';

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_ROOT = path.resolve(PROGRAM_DIR, '..');
const PYASH_ROOT = path.resolve(PROGRAM_DIR, '../../../..');

function runWithStreaming({ cmd, args, cwd, env = {}, timeoutMs = 8 * 60 * 60 * 1000, label = 'stage' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const t = String(chunk || '');
      stdout += t;
      process.stdout.write(t);
    });
    child.stderr.on('data', (chunk) => {
      const t = String(chunk || '');
      stderr += t;
      process.stderr.write(t);
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(10_000, Number(timeoutMs) || 10_000));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${label} failed (code=${code ?? 'null'} signal=${signal ?? ''})\n${stderr || stdout}`.trim()));
    });
  });
}

async function main() {
  const basePrefix = process.argv[2] || OWEN_ADAPTER.defaults.base_prefix;
  const focus = process.argv[3] || OWEN_ADAPTER.defaults.focus;
  const jurisdiction = process.argv[4] || OWEN_ADAPTER.defaults.jurisdiction;
  const body = process.argv[5] || OWEN_ADAPTER.defaults.body;
  const siteUrl = process.argv[6] || OWEN_ADAPTER.defaults.site_url;
  const discussionUrl = process.argv[7] || OWEN_ADAPTER.defaults.discussion_url;
  const execMxid = process.argv[8] || process.env.OWEN_EXEC_MXID || OWEN_ADAPTER.defaults.exec_mxid;

  const cfg = buildRunNextConfig(OWEN_ADAPTER, {
    basePrefix,
    focus,
    jurisdiction,
    body,
    siteUrl,
    discussionUrl,
    execMxid,
    timezone: OWEN_ADAPTER.defaults.timezone,
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owen-next-story-'));
  const cfgPath = path.join(tempDir, 'config.json');
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  const normalized = applyPublishEnvNormalization({
    env: process.env,
    adapter: OWEN_ADAPTER,
    fallbackCommand: '',
  });

  await runWithStreaming({
    cmd: 'node',
    args: [path.join(PYASH_ROOT, 'command/run_next_unposted_story.mjs'), cfgPath],
    cwd: PYASH_ROOT,
    env: normalized.env,
    timeoutMs: 8 * 60 * 60 * 1000,
    label: 'run-next-unposted-story',
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
