import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceDiagnosis, bumpConfidenceOnAnswer } from '../lib/diagnosis-validator.js';

function emptyProvenance() { return { fact_ids: [], source_names: [] }; }

test('enforceDiagnosis snaps high-confidence keyword matches to canonical', () => {
  const a = {
    diagnosis: { primary: { label: 'Fall armyworm', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance(),
    triage: { questions: [] }
  };
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, true);
  assert.equal(a.diagnosis.primary.label, 'Fall armyworm (Spodoptera frugiperda)');
  assert.equal(a.diagnosis.unsupported, undefined);
});

test('enforceDiagnosis attaches fact_ids after a confident match', () => {
  const a = {
    diagnosis: { primary: { label: 'fall armyworm whorl feeding', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance(),
    triage: { questions: [] }
  };
  enforceDiagnosis(a, 'maize');
  assert.deepEqual(a.provenance.fact_ids, ['FAW-001', 'FAW-002', 'FAW-003']);
});

test('enforceDiagnosis does NOT fabricate a diagnosis from an unmatched label', () => {
  const a = {
    diagnosis: { primary: { label: 'Maize leaf spot', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance(),
    triage: { questions: [] }
  };
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.matched, false);
  assert.equal(r.unsupported, true);
  assert.equal(a.diagnosis.primary.label, 'Maize leaf spot');
  assert.equal(a.diagnosis.primary.confidence, 'unconfirmed');
  assert.equal(a.diagnosis.unsupported, true);
  assert.deepEqual(a.provenance.fact_ids, []);
});

test('enforceDiagnosis adds a field_confirmation triage question when unsupported', () => {
  const a = {
    diagnosis: { primary: { label: 'Maize leaf spot', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance(),
    triage: { questions: [] }
  };
  enforceDiagnosis(a, 'maize');
  assert.ok(a.triage.questions.length > 0);
  assert.ok(a.triage.questions.some(q => q.field === 'field_confirmation'));
});

test('enforceDiagnosis does not duplicate field_confirmation question', () => {
  const a = {
    diagnosis: { primary: { label: 'Maize leaf spot', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance(),
    triage: { questions: [{ field: 'field_confirmation', ask_en: 'Existing', why: 'x' }] }
  };
  enforceDiagnosis(a, 'maize');
  const count = a.triage.questions.filter(q => q.field === 'field_confirmation').length;
  assert.equal(count, 1);
});

test('enforceDiagnosis handles cassava CMD confidently', () => {
  const a = {
    diagnosis: { primary: { label: 'Cassava mosaic disease', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance(),
    triage: { questions: [] }
  };
  const r = enforceDiagnosis(a, 'cassava');
  assert.equal(r.matched, true);
  assert.deepEqual(a.provenance.fact_ids, ['CMD-001', 'CMD-002', 'CMD-003']);
});

test('enforceDiagnosis returns enforced:false for unknown crop', () => {
  const a = { diagnosis: { primary: { label: 'X', confidence: 'likely' } } };
  const r = enforceDiagnosis(a, 'unknown');
  assert.equal(r.enforced, false);
});

test('enforceDiagnosis returns enforced:false without diagnosis', () => {
  const r = enforceDiagnosis({ provenance: emptyProvenance() }, 'maize');
  assert.equal(r.enforced, false);
});

test('bumpConfidenceOnAnswer escalates unconfirmed -> possible', () => {
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

test('bumpConfidenceOnAnswer does not bump on non-confirmation', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  const r = bumpConfidenceOnAnswer(a, 'I do not know');
  assert.equal(r.bumped, false);
});

test('bumpConfidenceOnAnswer refuses to bump an unsupported diagnosis', () => {
  const a = { diagnosis: { primary: { confidence: 'unconfirmed' }, unsupported: true } };
  const r = bumpConfidenceOnAnswer(a, 'yes');
  assert.equal(r.bumped, false);
  assert.equal(a.diagnosis.primary.confidence, 'unconfirmed');
});

test('bumpConfidenceOnAnswer does not exceed confirmed', () => {
  const a = { diagnosis: { primary: { confidence: 'confirmed' } } };
  const r = bumpConfidenceOnAnswer(a, 'yes');
  assert.equal(r.bumped, false);
  assert.equal(a.diagnosis.primary.confidence, 'confirmed');
});