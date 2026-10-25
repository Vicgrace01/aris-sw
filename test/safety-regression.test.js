import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceDiagnosis, bumpConfidenceOnAnswer } from '../lib/diagnosis-validator.js';

function emptyProvenance() { return { fact_ids: [], source_names: [] }; }
function baseAdvisory(label, confidence = 'likely') {
  return {
    diagnosis: { primary: { label, confidence }, differentials: [] },
    provenance: emptyProvenance(),
    triage: { questions: [] }
  };
}

test('case-insensitive: uppercase canonical label snaps', () => {
  const a = baseAdvisory('FALL ARMYWORM');
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, true);
  assert.equal(a.diagnosis.primary.label, 'Fall armyworm (Spodoptera frugiperda)');
});

test('non-string label falls back without crash', () => {
  const a = baseAdvisory(12345);
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, false);
  assert.equal(r.unsupported, true);
});

test('mixed affirmative + contraction negation does NOT bump', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  const r = bumpConfidenceOnAnswer(a, "yes but I don't see frass");
  assert.equal(r.bumped, false);
  assert.equal(r.reason, 'negative_answer');
});

test('mixed Swahili affirmative + negation does NOT bump', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  const r = bumpConfidenceOnAnswer(a, 'ndio lakini sioni kinyesi');
  assert.equal(r.bumped, false);
  assert.equal(r.reason, 'negative_answer');
});

test('empty string label falls back without crash', () => {
  const a = baseAdvisory('');
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, false);
  assert.equal(r.unsupported, true);
});