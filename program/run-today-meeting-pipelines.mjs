#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = "/home/htaf/pyac/pyash/world/house/owen-sound-reporter";
const MEETINGS_DIR = path.join(ROOT, "artifacts/owen-sound/meetings");
const RUN_BIN = "/home/htaf/pyac/pyash/run";
const TZ = "America/Toronto";

function todayToronto() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function main() {
  const day = todayToronto();
  const todayPath = path.join(MEETINGS_DIR, `${day}.today.json`);
  if (!fs.existsSync(todayPath)) {
    process.stdout.write(`no today workspace file: ${todayPath}\n`);
    return;
  }

  const today = JSON.parse(fs.readFileSync(todayPath, "utf8"));
  const meetings = Array.isArray(today.meetings) ? today.meetings : [];
  const results = [];

  for (const meeting of meetings) {
    const pipeline = String(meeting?.pipeline || "");
    const folder = String(meeting?.folder || "");
    const statusPath = path.join(MEETINGS_DIR, folder, "status.txt");

    if (!pipeline || !fs.existsSync(pipeline)) {
      results.push({
        meeting_id: meeting?.meeting_id ?? "",
        folder,
        ok: false,
        note: "missing pipeline file",
      });
      continue;
    }

    try {
      const out = execFileSync(RUN_BIN, [pipeline], {
        cwd: "/home/htaf/pyac/pyash",
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      fs.writeFileSync(statusPath, "complete\n", "utf8");
      results.push({
        meeting_id: meeting?.meeting_id ?? "",
        folder,
        ok: true,
        run_stdout_preview: out.slice(0, 4000),
      });
    } catch (error) {
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      const stderr = typeof error?.stderr === "string" ? error.stderr : "";
      fs.writeFileSync(statusPath, "failed\n", "utf8");
      results.push({
        meeting_id: meeting?.meeting_id ?? "",
        folder,
        ok: false,
        run_stdout_preview: stdout.slice(0, 4000),
        run_stderr_preview: stderr.slice(0, 4000),
      });
    }
  }

  const summary = {
    day,
    meeting_count: meetings.length,
    ran_count: results.length,
    ok_count: results.filter((r) => r.ok).length,
    fail_count: results.filter((r) => !r.ok).length,
    results,
    generated_at_utc: new Date().toISOString(),
  };
  const summaryPath = path.join(MEETINGS_DIR, `${day}.run-summary.json`);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  process.stdout.write(
    `ran ${summary.ran_count} meeting pipelines (${summary.ok_count} ok, ${summary.fail_count} failed)\n`,
  );
}

main();
