import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceDiagnosis, bumpConfidenceOnAnswer } from '../lib/diagnosis-validator.js';

function emptyProvenance() { return { fact_ids: [], source_names: [] }; }

/* ---------- Confident match cases ---------- */

test('enforceDiagnosis snaps on exact canonical match', () => {
  const a = { diagnosis: { primary: { label: 'Fall armyworm (Spodoptera frugiperda)', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, true);
  assert.equal(a.diagnosis.primary.label, 'Fall armyworm (Spodoptera frugiperda)');
});

test('enforceDiagnosis snaps on short-name match', () => {
  const a = { diagnosis: { primary: { label: 'Maize stem borer', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, true);
  assert.equal(a.diagnosis.primary.label, 'Maize stem borer (Busseola fusca)');
});

test('enforceDiagnosis snaps on two distinct keyword hits (whorl + frass)', () => {
  const a = { diagnosis: { primary: { label: 'Maize whorl damage with frass', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, true);
  assert.equal(a.diagnosis.primary.label, 'Fall armyworm (Spodoptera frugiperda)');
});

test('enforceDiagnosis attaches fact_ids on confident match', () => {
  const a = { diagnosis: { primary: { label: 'Fall armyworm (Spodoptera frugiperda)', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  enforceDiagnosis(a, 'maize');
  assert.deepEqual(a.provenance.fact_ids, ['FAW-001', 'FAW-002', 'FAW-003']);
});

/* ---------- Audit-fix: single ambiguous keyword does NOT snap ---------- */

test('CRITICAL FIX: single keyword "whorl" alone does NOT snap to FAW', () => {
  const a = { diagnosis: { primary: { label: 'Maize whorl damage', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, false);
  assert.equal(r.unsupported, true);
  assert.equal(a.diagnosis.primary.label, 'Maize whorl damage');
  assert.equal(a.diagnosis.primary.confidence, 'unconfirmed');
  assert.deepEqual(a.provenance.fact_ids, []);
});

test('CRITICAL FIX: single keyword "yellow" alone does NOT snap to cassava mosaic', () => {
  const a = { diagnosis: { primary: { label: 'Cassava yellow leaves', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  const r = enforceDiagnosis(a, 'cassava');
  assert.equal(r.matched, false);
  assert.equal(r.unsupported, true);
});

test('CRITICAL FIX: single keyword "wilt" alone does NOT snap to bacterial wilt', () => {
  const a = { diagnosis: { primary: { label: 'Tomato wilting', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  const r = enforceDiagnosis(a, 'tomato');
  assert.equal(r.matched, false);
  assert.equal(r.unsupported, true);
});

test('CRITICAL FIX: two cassava keywords (mosaic + yellow) DO snap to CMD', () => {
  const a = { diagnosis: { primary: { label: 'Cassava yellow mosaic leaves', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  const r = enforceDiagnosis(a, 'cassava');
  assert.equal(r.matched, true);
  assert.equal(a.diagnosis.primary.label, 'Cassava mosaic disease');
});

test('enforceDiagnosis does NOT fabricate a diagnosis from an unmatched label', () => {
  const a = { diagnosis: { primary: { label: 'Maize leaf spot', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, false);
  assert.equal(r.unsupported, true);
  assert.equal(a.diagnosis.primary.label, 'Maize leaf spot');
});

test('enforceDiagnosis adds field_confirmation question when unsupported', () => {
  const a = { diagnosis: { primary: { label: 'Maize leaf spot', confidence: 'likely' }, differentials: [] }, provenance: emptyProvenance(), triage: { questions: [] } };
  enforceDiagnosis(a, 'maize');
  assert.ok(a.triage.questions.some(q => q.field === 'field_confirmation'));
});

test('enforceDiagnosis returns enforced:false for unknown crop', () => {
  const r = enforceDiagnosis({ diagnosis: { primary: { label: 'X', confidence: 'likely' } } }, 'unknown');
  assert.equal(r.enforced, false);
});

test('enforceDiagnosis returns enforced:false without diagnosis', () => {
  const r = enforceDiagnosis({ provenance: emptyProvenance() }, 'maize');
  assert.equal(r.enforced, false);
});

/* ---------- Confidence escalation ---------- */

test('bumpConfidenceOnAnswer escalates unconfirmed -> possible on real evidence', () => {
  const a = { diagnosis: { primary: { confidence: 'unconfirmed' } } };
  const r = bumpConfidenceOnAnswer(a, 'yes I see frass');
  assert.equal(r.bumped, true);
  assert.equal(a.diagnosis.primary.confidence, 'possible');
});

test('bumpConfidenceOnAnswer escalates possible -> likely', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  bumpConfidenceOnAnswer(a, 'ndio naona kinyesi');
  assert.equal(a.diagnosis.primary.confidence, 'likely');
});

test('bumpConfidenceOnAnswer escalates likely -> confirmed', () => {
  const a = { diagnosis: { primary: { confidence: 'likely' } } };
  bumpConfidenceOnAnswer(a, 'yes, caterpillar visible');
  assert.equal(a.diagnosis.primary.confidence, 'confirmed');
});

test('CRITICAL FIX: bare "yes" without evidence term does NOT bump', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  const r = bumpConfidenceOnAnswer(a, 'yes');
  assert.equal(r.bumped, false);
  assert.equal(r.reason, 'affirmation_without_evidence');
  assert.equal(a.diagnosis.primary.confidence, 'possible');
});

test('CRITICAL FIX: negative answer does NOT bump', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  const r = bumpConfidenceOnAnswer(a, 'no, I do not see frass');
  assert.equal(r.bumped, false);
  assert.equal(r.reason, 'negative_answer');
});

test('CRITICAL FIX: Swahili negative answer does NOT bump', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  const r = bumpConfidenceOnAnswer(a, 'hapana, sioni kinyesi');
  assert.equal(r.bumped, false);
  assert.equal(r.reason, 'negative_answer');
});

test('bumpConfidenceOnAnswer does not bump on non-confirmation', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  const r = bumpConfidenceOnAnswer(a, 'I do not know');
  assert.equal(r.bumped, false);
});

test('bumpConfidenceOnAnswer refuses to bump unsupported diagnosis', () => {
  const a = { diagnosis: { primary: { confidence: 'unconfirmed' }, unsupported: true } };
  const r = bumpConfidenceOnAnswer(a, 'yes, frass');
  assert.equal(r.bumped, false);
});

test('bumpConfidenceOnAnswer does not exceed confirmed', () => {
  const a = { diagnosis: { primary: { confidence: 'confirmed' } } };
  const r = bumpConfidenceOnAnswer(a, 'yes, frass');
  assert.equal(r.bumped, false);
});