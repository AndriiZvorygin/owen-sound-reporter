#!/usr/bin/env node
import fs from "node:fs";

function normalize(line) {
  return String(line || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function findStart(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const n = normalize(lines[i]);
    if (n === "CALL TO ORDER" || n.includes("CALL TO ORDER")) return i;
  }
  return -1;
}

function findEnd(lines, fromIndex) {
  for (let i = Math.max(0, fromIndex); i < lines.length; i += 1) {
    const n = normalize(lines[i]);
    if (n === "ADJOURNMENT" || n.includes("ADJOURNMENT")) return i;
  }
  return -1;
}

function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    process.stderr.write(
      "usage: node prune-owen-sound-agenda.mjs <input.md> <output.md>\n",
    );
    process.exit(2);
  }

  const text = fs.readFileSync(inputPath, "utf8");
  const lines = text.split(/\r?\n/);
  const start = findStart(lines);
  const end = start >= 0 ? findEnd(lines, start) : -1;

  let out = text;
  if (start >= 0 && end >= start) {
    out = `${lines.slice(start, end + 1).join("\n")}\n`;
  }

  fs.writeFileSync(outputPath, out, "utf8");
  process.stdout.write(
    `pruned agenda window start=${start} end=${end} lines=${out.split(/\r?\n/).length}\n`,
  );
}

main();
