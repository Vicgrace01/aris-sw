import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, detectCrop, selectFewShots, getStats } from '../lib/dataset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

before(async () => {
  await loadDataset(
    path.join(ROOT, 'data', 'advisory_episodes.train.jsonl'),
    path.join(ROOT, 'data', 'gold_diagnostics.jsonl')
  );
});

test('dataset loads with expected counts', () => {
  const stats = getStats();
  assert.ok(stats.total > 2000, `expected >2000 episodes, got ${stats.total}`);
  assert.ok(stats.goldDiagnostics >= 7, `expected >=7 gold, got ${stats.goldDiagnostics}`);
  assert.ok(stats.templatedExcluded > 300);
});

test('detectCrop identifies English crop names', () => {
  assert.equal(detectCrop('my maize has holes'), 'maize');
  assert.equal(detectCrop('cassava mosaic'), 'cassava');
  assert.equal(detectCrop('tomato wilt'), 'tomato');
});

test('detectCrop identifies Swahili crop names', () => {
  assert.equal(detectCrop('mahindi yangu yana matundu'), 'maize');
  assert.equal(detectCrop('muhogo wangu'), 'cassava');
  assert.equal(detectCrop('nyanya zangu'), 'tomato');
});

test('detectCrop returns null for unknown crop', () => {
  assert.equal(detectCrop('some random text'), null);
});

test('selectFewShots returns exactly count few-shots', () => {
  const r = selectFewShots('Mahindi yangu yana matundu', 3);
  assert.equal(r.fewShots.length, 3);
});

test('selectFewShots detects Swahili input', () => {
  const r = selectFewShots('Mahindi yangu yana matundu kwenye majani');
  assert.equal(r.detectedLang, 'sw');
});

test('selectFewShots detects English input', () => {
  const r = selectFewShots('my maize has holes in the leaves');
  assert.equal(r.detectedLang, 'en');
});

test('selectFewShots is deterministic for same input', () => {
  const a = selectFewShots('Mahindi yangu yana matundu');
  const b = selectFewShots('Mahindi yangu yana matundu');
  assert.deepEqual(
    a.selectionTrace.map(x => x.id),
    b.selectionTrace.map(x => x.id)
  );
});

test('selectFewShots prefers diagnostic episodes for symptom-rich input', () => {
  const r = selectFewShots('Mahindi yangu yana matundu kwenye majani', 3);
  assert.ok(r.selectionTrace.length > 0);
  const kinds = r.selectionTrace.map(x => x.kind);
  assert.ok(kinds.includes('diagnostic_episode'), `expected diagnostic, got ${kinds.join(',')}`);
});

test('selectFewShots handles mixed crop input', () => {
  const r = selectFewShots('nyanya na mahindi zina matatizo', 3);
  assert.equal(r.fewShots.length, 3);
});