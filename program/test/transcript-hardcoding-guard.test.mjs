import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'run-full-transcript-pipeline.mjs');

test('transcript mode has no topic-specific rewrite hardcoding', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  const lines = src.split(/\r?\n/u);
  const forbidden = [/ryerson/iu, /billy bishop/iu, /bryerson/iu, /fourth avenue/iu, /patio/iu];
  const hits = [];
  lines.forEach((line, idx) => {
    if (/forbiddenTerms/.test(line)) return;
    if (/forbidden term checks/.test(line)) return;
    for (const re of forbidden) {
      if (re.test(line)) hits.push({ line: idx + 1, text: line.trim() });
    }
  });
  assert.equal(hits.length, 0, `Found topic-specific hardcoding:\n${hits.map((h) => `${h.line}: ${h.text}`).join('\n')}`);
});
