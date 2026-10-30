#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function usage() {
  return [
    'Usage: node program/rename-speaker-in-voices-dir.mjs <voices_dir> <speaker_key> <new_name>',
    'Example: node ... "artifacts/.../speaker voices" speaker_001 "ian boddy"'
  ].join('\n');
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function ensureDir(dirPath) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`voices directory not found: ${dirPath}`);
}

function normalizeName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/gu, '_')
    .toLowerCase();
}

function toFullName(raw) {
  return String(raw || '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((w) => w[0] ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(' ');
}

function upsertField(lines, field, valueLiteral) {
  const re = new RegExp(`^\\s*su name ${field} ob .* ya\\s*$`, 'u');
  let replaced = false;
  const out = lines.map((line) => {
    if (re.test(line)) {
      replaced = true;
      return `su name ${field} ob ${valueLiteral} ya`;
    }
    return line;
  });
  if (!replaced) {
    const prahIndex = out.findIndex((line) => /^\s*prah\s*$/u.test(line));
    if (prahIndex >= 0) out.splice(prahIndex, 0, `su name ${field} ob ${valueLiteral} ya`);
    else out.push(`su name ${field} ob ${valueLiteral} ya`);
  }
  return out;
}

function readMetaName(metaPath) {
  if (!fs.existsSync(metaPath)) return '';
  const src = fs.readFileSync(metaPath, 'utf8');
  const m = src.match(/^\s*su name name ob text "(.*)" ya\s*$/mu);
  return String(m?.[1] || '').trim();
}

function reserveUniqueNameInVoices(voicesDir, speakerKey, preferredName) {
  const base = String(preferredName || '').trim();
  if (!base) return base;
  const names = fs.readdirSync(voicesDir)
    .filter((n) => n.endsWith('.pya') && n !== 'index.pya')
    .sort();
  const byName = new Map();
  for (const name of names) {
    const key = name.replace(/\.pya$/u, '');
    const current = readMetaName(path.join(voicesDir, name));
    if (!current) continue;
    if (!byName.has(current)) byName.set(current, new Set());
    byName.get(current).add(key);
  }
  let candidate = base;
  let suffix = 1;
  while (true) {
    const keys = byName.get(candidate);
    const usedByOther = Boolean(keys && [...keys].some((k) => String(k) !== String(speakerKey)));
    if (!usedByOther) return candidate;
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
}

function main() {
  const voicesDirArg = process.argv[2];
  const speakerKey = String(process.argv[3] || '').trim();
  const newNameRaw = String(process.argv[4] || '').trim();

  if (!voicesDirArg || !speakerKey || !newNameRaw) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const voicesDir = path.resolve(process.cwd(), voicesDirArg);
  ensureDir(voicesDir);
  const metaFile = path.join(voicesDir, `${speakerKey}.pya`);
  if (!fs.existsSync(metaFile)) throw new Error(`speaker metadata file missing: ${metaFile}`);

  const normalized = normalizeName(newNameRaw);
  const newName = reserveUniqueNameInVoices(voicesDir, speakerKey, normalized);
  const fullName = toFullName(newName.replace(/_/gu, ' '));
  if (!newName) throw new Error('new_name became empty after normalization');

  const src = fs.readFileSync(metaFile, 'utf8').replace(/\r\n/g, '\n');
  let lines = src.split('\n');
  lines = upsertField(lines, 'name', `text ${JSON.stringify(newName)}`);
  lines = upsertField(lines, 'full_name', `text ${JSON.stringify(fullName)}`);
  lines = upsertField(lines, 'origin', `text ${JSON.stringify('manual')}`);
  lines = upsertField(lines, 'updated_at', `text ${JSON.stringify(nowIso())}`);

  fs.writeFileSync(metaFile, `${lines.join('\n').replace(/\n*$/u, '')}\n`, 'utf8');
  process.stdout.write(`[speaker-rename] voices dir: ${voicesDir}\n`);
  process.stdout.write(`[speaker-rename] speaker key: ${speakerKey}\n`);
  process.stdout.write(`[speaker-rename] new name: ${newName}\n`);
  process.stdout.write(`[speaker-rename] updated: ${metaFile}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
}
