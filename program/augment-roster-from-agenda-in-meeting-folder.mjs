#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/htaf/pyac/pyash';
const HOUSE = path.join(ROOT, 'world/house/owen-sound-reporter');
const DEFAULT_ROSTER = path.join(HOUSE, 'artifacts/owen-sound/2022-2026-council.txt');
const START_MARK = 'Agenda-derived participants (auto):';
const END_MARK = 'End agenda-derived participants (auto).';

function usage() {
  return [
    'Usage: node program/augment-roster-from-agenda-in-meeting-folder.mjs <meeting_dir> [roster_file]',
    'Example: node ... artifacts/owen-sound/meetings/2026-03-23_council-meeting-regular_f3b0c55c',
  ].join('\n');
}

function ensureDir(dirPath, label) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`${label} not found: ${dirPath}`);
}

function resolveReporterPath(inputPath) {
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
  const fromCwd = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(HOUSE, inputPath);
}

function pickAgendaMarkdown(meetingDir) {
  const convertedDir = path.join(meetingDir, 'converted');
  const preferred = path.join(convertedDir, 'agenda-01.pruned.md');
  if (fs.existsSync(preferred)) return preferred;
  if (!fs.existsSync(convertedDir)) return '';

  const all = fs.readdirSync(convertedDir)
    .filter((n) => n.toLowerCase().startsWith('agenda-') && n.toLowerCase().endsWith('.md'))
    .sort();
  return all.length ? path.join(convertedDir, all[0]) : '';
}

function titleCaseName(name) {
  return String(name || '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function parseRosterNames(rosterText) {
  const names = new Set();
  const lines = String(rosterText || '').split(/\r?\n/u);
  for (const line of lines) {
    const m = line.match(/^\s*-\s+([^|\n]+?)\s*\|/u);
    if (!m) continue;
    names.add(titleCaseName(m[1]));
  }
  return names;
}

function maybeAddName(outSet, raw) {
  const name = titleCaseName(raw)
    .replace(/\bMister\b/gu, 'Mr.')
    .replace(/\bMissus\b/gu, 'Mrs.')
    .replace(/\bMiss\b/gu, 'Ms.')
    .trim();
  if (!name) return;
  const words = name.split(/\s+/u);
  if (words.length < 2 || words.length > 4) return;
  if (words.includes('And')) return;
  if (/\d/u.test(name)) return;
  if (!/^[A-Z][A-Za-z'\-.]+$/u.test(words[0])) return;
  if (!/^[A-Z][A-Za-z'\-.]+$/u.test(words[words.length - 1])) return;

  const rejectHead = new Set([
    'City', 'Council', 'Committee', 'Regular', 'Agenda', 'Minutes', 'Meeting', 'County', 'Grey', 'Owen',
    'Report', 'Code', 'Conduct', 'Complaint', 'Manager', 'Update', 'Presentation', 'Deputation', 'Re', 'The',
    'Public', 'Forum', 'Motion', 'By', 'Law', 'Section', 'Item', 'From', 'To', 'Of', 'At', 'In'
  ]);
  if (words.some((w) => rejectHead.has(w))) return;

  const rejectOrg = new Set([
    'Inc', 'Incorporated', 'Ltd', 'Limited', 'Corp', 'Corporation', 'Company', 'Co', 'Authority',
    'Canada', 'Street', 'St', 'Road', 'Rd', 'Avenue', 'Ave', 'West', 'East', 'North', 'South',
    'Project', 'Reconstruction', 'Operations', 'Services', 'Engineering', 'Works'
  ]);
  if (words.some((w) => rejectOrg.has(w))) return;

  outSet.add(name);
}

function maybeAddFromComposite(outSet, raw) {
  const text = String(raw || '').replace(/\s+/gu, ' ').trim();
  if (!text) return;

  // Split common "Name and Name" constructions from agenda titles.
  if (/\band\b/iu.test(text)) {
    const parts = text.split(/\band\b/iu).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      for (const p of parts) maybeAddFromComposite(outSet, p);
      return;
    }
  }

  // Also handle comma-separated name list fragments.
  if (/,/u.test(text)) {
    const chunks = text.split(',').map((x) => x.trim()).filter(Boolean);
    // If comma split gives many fragments, try each; otherwise fallback to whole.
    if (chunks.length >= 2) {
      let added = false;
      for (const c of chunks) {
        const before = outSet.size;
        maybeAddName(outSet, c);
        if (outSet.size > before) added = true;
      }
      if (added) return;
    }
  }

  maybeAddName(outSet, text);
}

function stripAgendaDerivedBlock(rosterText) {
  const src = String(rosterText || '').replace(/\r\n/gu, '\n');
  const start = src.indexOf(START_MARK);
  const end = src.indexOf(END_MARK);
  if (start >= 0 && end > start) {
    const after = end + END_MARK.length;
    return `${src.slice(0, start).trimEnd()}\n\n${src.slice(after).trimStart()}`.trimEnd();
  }
  return src.trimEnd();
}

function extractAgendaNames(agendaText) {
  const out = new Set();
  const lines = String(agendaText || '').split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);

  const fromPatterns = [
    /\bfrom\s+([A-Z][A-Za-z'\-.]+(?:\s+[A-Z][A-Za-z'\-.]+){1,3})\b/gu,
    /\bby\s+([A-Z][A-Za-z'\-.]+(?:\s+[A-Z][A-Za-z'\-.]+){1,3})\b/gu,
    /\bdeputation\s+([A-Z][A-Za-z'\-.]+(?:\s+[A-Z][A-Za-z'\-.]+){1,3})\b/giu,
    /\bpresentation\s+from\s+([A-Z][A-Za-z'\-.]+(?:\s+[A-Z][A-Za-z'\-.]+){1,3})\b/giu,
  ];

  const genericFullName = /\b([A-Z][A-Za-z'\-.]+\s+[A-Z][A-Za-z'\-.]+(?:\s+[A-Z][A-Za-z'\-.]+)?)\b/gu;

  for (const line of lines) {
    for (const re of fromPatterns) {
      let m;
      while ((m = re.exec(line))) maybeAddFromComposite(out, m[1]);
    }

    // Only accept free-form full names on lines likely to contain people.
    if (!/\b(from|deputation|presentation|speaker|citizen|re:)\b/iu.test(line)) continue;
    let g;
    while ((g = genericFullName.exec(line))) maybeAddFromComposite(out, g[1]);
  }

  return [...out].sort((a, b) => a.localeCompare(b));
}

function upsertAgendaDerivedBlock(rosterText, namesToAdd) {
  const base = stripAgendaDerivedBlock(rosterText);

  if (!namesToAdd.length) return `${base}\n`;

  const blockLines = [
    START_MARK,
    ...namesToAdd.map((n) => `- ${n} | role: Agenda Participant | gender: unknown`),
    END_MARK,
  ];

  return `${base}\n\n${blockLines.join('\n')}\n`;
}

async function main() {
  const meetingDirArg = process.argv[2];
  const rosterArg = process.argv[3] || DEFAULT_ROSTER;
  if (!meetingDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const meetingDir = resolveReporterPath(meetingDirArg);
  ensureDir(meetingDir, 'meeting directory');
  const agendaPath = pickAgendaMarkdown(meetingDir);
  if (!agendaPath) throw new Error(`agenda markdown not found under: ${meetingDir}/converted`);

  const rosterPath = resolveReporterPath(rosterArg);
  const rosterExists = fs.existsSync(rosterPath);
  const rosterText = rosterExists ? fs.readFileSync(rosterPath, 'utf8') : '';
  const baseRosterText = stripAgendaDerivedBlock(rosterText);
  const rosterNames = parseRosterNames(baseRosterText);

  const agendaText = fs.readFileSync(agendaPath, 'utf8');
  const extracted = extractAgendaNames(agendaText);
  const newNames = extracted.filter((n) => !rosterNames.has(n));

  const merged = upsertAgendaDerivedBlock(rosterText, newNames);
  fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
  fs.writeFileSync(rosterPath, merged, 'utf8');

  process.stdout.write(`[roster-agenda] meeting: ${meetingDir}\n`);
  process.stdout.write(`[roster-agenda] agenda: ${agendaPath}\n`);
  process.stdout.write(`[roster-agenda] roster: ${rosterPath}\n`);
  process.stdout.write(`[roster-agenda] extracted names: ${extracted.length}\n`);
  process.stdout.write(`[roster-agenda] newly added: ${newNames.length}\n`);
  if (newNames.length) process.stdout.write(`[roster-agenda] names: ${newNames.join(' | ')}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
