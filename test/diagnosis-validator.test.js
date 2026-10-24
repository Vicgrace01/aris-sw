import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceDiagnosis, bumpConfidenceOnAnswer } from '../lib/diagnosis-validator.js';

function emptyProvenance() { return { fact_ids: [], source_names: [] }; }

test('enforceDiagnosis snaps invented label to closest valid', () => {
  const a = {
    diagnosis: { primary: { label: 'Maize leaf spot', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance()
  };
  const r = enforceDiagnosis(a, 'maize');
  assert.equal(r.enforced, true);
  assert.equal(a.diagnosis.primary.label, 'Fall armyworm (Spodoptera frugiperda)');
});

test('enforceDiagnosis attaches fact_ids after snap', () => {
  const a = {
    diagnosis: { primary: { label: 'Maize leaf spot', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance()
  };
  enforceDiagnosis(a, 'maize');
  assert.deepEqual(a.provenance.fact_ids, ['FAW-001', 'FAW-002', 'FAW-003']);
});

test('enforceDiagnosis picks stem borer when keywords match', () => {
  const a = {
    diagnosis: { primary: { label: 'maize stem borer tunneling', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance()
  };
  enforceDiagnosis(a, 'maize');
  assert.ok(a.diagnosis.primary.label.includes('stem borer'));
});

test('enforceDiagnosis handles cassava CMD', () => {
  const a = {
    diagnosis: { primary: { label: 'Cassava mosaic disease', confidence: 'likely' }, differentials: [] },
    provenance: emptyProvenance()
  };
  enforceDiagnosis(a, 'cassava');
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

test('bumpConfidenceOnAnswer escalates unconfirmed → possible', () => {
  const a = { diagnosis: { primary: { confidence: 'unconfirmed' } } };
  const r = bumpConfidenceOnAnswer(a, 'yes I see frass');
  assert.equal(r.bumped, true);
  assert.equal(a.diagnosis.primary.confidence, 'possible');
});

test('bumpConfidenceOnAnswer escalates possible → likely', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  bumpConfidenceOnAnswer(a, 'ndio naona kinyesi');
  assert.equal(a.diagnosis.primary.confidence, 'likely');
});

test('bumpConfidenceOnAnswer escalates likely → confirmed', () => {
  const a = { diagnosis: { primary: { confidence: 'likely' } } };
  bumpConfidenceOnAnswer(a, 'yes, caterpillar visible');
  assert.equal(a.diagnosis.primary.confidence, 'confirmed');
});

test('bumpConfidenceOnAnswer does not bump on non-confirmation', () => {
  const a = { diagnosis: { primary: { confidence: 'possible' } } };
  const r = bumpConfidenceOnAnswer(a, 'I do not know');
  assert.equal(r.bumped, false);
  assert.equal(a.diagnosis.primary.confidence, 'possible');
});

test('bumpConfidenceOnAnswer does not exceed confirmed', () => {
  const a = { diagnosis: { primary: { confidence: 'confirmed' } } };
  const r = bumpConfidenceOnAnswer(a, 'yes');
  assert.equal(r.bumped, false);
  assert.equal(a.diagnosis.primary.confidence, 'confirmed');
});