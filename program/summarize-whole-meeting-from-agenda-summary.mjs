#!/usr/bin/env node
import { summarizeWholeMeetingArtifacts } from "../../../../program/library/reporter_shared/whole-meeting-synthesis.mjs";

async function main() {
  const transcriptDirArg = process.argv[2];
  const prefixArg = process.argv[3] || "auto";
  const focusArg = process.argv.slice(4).join(" ").trim();
  if (!transcriptDirArg) {
    process.stdout.write("Usage: node program/summarize-whole-meeting-from-agenda-summary.mjs <transcript_dir> [prefix] [focus]\n");
    process.exit(2);
  }
  await summarizeWholeMeetingArtifacts({ transcriptDirArg, prefixArg, focusArg });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
