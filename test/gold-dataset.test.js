import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdvisory } from '../lib/schema-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = path.resolve(__dirname, '..', 'data', 'gold_diagnostics.jsonl');

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

async function loadGold() {
  const raw = stripBom(await readFile(GOLD_PATH, 'utf-8'));
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(stripBom(l)));
}

test('gold dataset loads and has records', async () => {
  const records = await loadGold();
  assert.ok(records.length >= 13, `expected >= 13 records, got ${records.length}`);
});

test('every gold record passes schema validation', async () => {
  const records = await loadGold();
  for (const ep of records) {
    const r = validateAdvisory(ep);
    assert.ok(r.valid, `${ep.episode_id}: ${(r.errors || []).join('; ')}`);
  }
});

test('every confident diagnostic gold has provenance', async () => {
  const records = await loadGold();
  const diagnostic = records.filter(ep => ep.record_kind === 'diagnostic_episode');
  assert.ok(diagnostic.length >= 10, `expected >= 10 diagnostics, got ${diagnostic.length}`);
  for (const ep of diagnostic) {
    const confidence = ep.diagnosis?.primary?.confidence;
    if (confidence === 'unconfirmed') continue;
    assert.ok(Array.isArray(ep.provenance?.fact_ids), `${ep.episode_id}: missing fact_ids array`);
    assert.ok(ep.provenance.fact_ids.length > 0, `${ep.episode_id}: empty fact_ids (confidence=${confidence})`);
    assert.ok(Array.isArray(ep.provenance?.source_names), `${ep.episode_id}: missing source_names`);
    assert.ok(ep.provenance.source_names.length > 0, `${ep.episode_id}: empty source_names`);
  }
});

test('every refusal gold has a refusal reason', async () => {
  const records = await loadGold();
  const refusals = records.filter(ep => ep.record_kind === 'refusal');
  assert.ok(refusals.length >= 2, `expected >= 2 refusals, got ${refusals.length}`);
  for (const ep of refusals) {
    assert.ok(ep.refusal?.reason_en, `${ep.episode_id}: missing refusal.reason_en`);
  }
});