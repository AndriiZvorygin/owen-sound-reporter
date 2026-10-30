#!/usr/bin/env node

// Install the Police Services Board poller and archive backfill as one
// self-owned crontab block.  The wrappers own the single-flight lock; cron
// must not acquire it first because flock is not re-entrant.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWEN_ROOT = path.resolve(PROGRAM_DIR, "..");
const PYASH_ROOT = path.resolve(OWEN_ROOT, "../../..");
export const POLICE_CRON_START = "# owen-sound-police-reporter managed:start";
export const POLICE_CRON_END = "# owen-sound-police-reporter managed:end";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function withoutManagedBlock(lines) {
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === POLICE_CRON_START) {
      inside = true;
      continue;
    }
    if (line.trim() === POLICE_CRON_END) {
      inside = false;
      continue;
    }
    if (!inside) kept.push(line);
  }
  return kept;
}

/**
 * Replace only the police-managed block, preserving every other user cron
 * entry.  Keeping this pure makes the lock/cron regression test independent
 * of the host's crontab.
 */
export function mergeManagedPoliceCrontab(existing, { nodeBin = process.execPath } = {}) {
  const nodeDir = path.dirname(nodeBin);
  const pathValue = `${nodeDir}:/usr/local/bin:/usr/bin:/bin`;
  const house = shellQuote(OWEN_ROOT);
  const log = shellQuote(path.join(PYASH_ROOT, "owen-sound-police.cron.log"));
  const backfillLog = shellQuote(path.join(PYASH_ROOT, "owen-sound-police-backfill.cron.log"));
  const common = `cd ${house} && PATH=${shellQuote(pathValue)} ANDRII_YTDLP_EXTRACTOR_ARGS='youtube:player_client=android'`;
  const block = [
    POLICE_CRON_START,
    `10 5 * * * ${common} ./run-next-police-story.sh >> ${log} 2>&1`,
    `40 5 * * * ${common} OWEN_POLICE_BACKFILL_LIMIT=1 ./run-backfill-police-2026.sh >> ${backfillLog} 2>&1`,
    POLICE_CRON_END,
  ];

  const original = String(existing || "").replace(/\s+$/u, "");
  const kept = withoutManagedBlock(original ? original.split("\n") : []).filter((line, index, all) =>
    !(line === "" && index === all.length - 1));
  const prefix = kept.join("\n").replace(/\s+$/u, "");
  return `${prefix ? `${prefix}\n` : ""}${block.join("\n")}\n`;
}

function install() {
  const listed = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (listed.error) throw listed.error;
  if (listed.status !== 0 && !/no crontab/iu.test(String(listed.stderr || ""))) {
    throw new Error(`crontab -l failed: ${String(listed.stderr || "").trim()}`);
  }

  const existing = listed.status === 0 ? String(listed.stdout || "") : "";
  const merged = mergeManagedPoliceCrontab(existing);
  if (merged === existing) {
    process.stdout.write("Police reporter crontab is already up to date.\n");
    return;
  }

  const updated = spawnSync("crontab", ["-"], { input: merged, encoding: "utf8" });
  if (updated.error) throw updated.error;
  if (updated.status !== 0) {
    throw new Error(`crontab install failed: ${String(updated.stderr || "").trim()}`);
  }
  process.stdout.write("Installed the police reporter crontab block.\n");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    install();
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error?.message || error)}\n`);
    process.exitCode = 1;
  }
}
