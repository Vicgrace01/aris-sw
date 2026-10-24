import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdvisory } from '../lib/schema-validator.js';

function minimalValid() {
  return {
    record_kind: 'diagnostic_episode',
    language: 'en',
    channel: 'voice',
    context: { crop: 'maize', growth_stage: 'vegetative', chief_complaint_en: 'Holes in leaves' },
    triage: { observed_signs: ['holes'], missing_discriminators: [], questions: [] },
    diagnosis: {
      primary: { label: 'Fall armyworm', confidence: 'likely' },
      differentials: [{ label: 'Stem borer', ruled_out_because: 'Whorl feeding pattern' }],
      confidence_basis: 'Multiple signs align'
    },
    advice: {
      immediate: [{ action_en: 'Scout the field', timeframe: 'today' }],
      preventive: [],
      do_not: [{ text_en: 'Do not spray', reason: 'No confirmed pest' }]
    },
    escalation: { trigger_en: '>20% damage', referral: 'Extension officer', urgency: 'medium' },
    provenance: { fact_ids: ['FAW-001'], source_names: ['IITA'] },
    policy_trace: [{ step: 'intake', action: 'set_context' }]
  };
}

test('valid diagnostic_episode passes', () => {
  const r = validateAdvisory(minimalValid());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('missing record_kind fails', () => {
  const r = validateAdvisory({ language: 'en' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('record_kind')));
});

test('invalid record_kind fails', () => {
  const a = minimalValid();
  a.record_kind = 'made_up';
  const r = validateAdvisory(a);
  assert.equal(r.valid, false);
});

test('null advisory fails', () => {
  assert.equal(validateAdvisory(null).valid, false);
});

test('array advisory fails', () => {
  assert.equal(validateAdvisory([]).valid, false);
});

test('string advisory fails', () => {
  assert.equal(validateAdvisory('not an object').valid, false);
});

test('advice.immediate as strings fails', () => {
  const a = minimalValid();
  a.advice.immediate = ['scout the field'];
  const r = validateAdvisory(a);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('action_en')));
});

test('differential missing ruled_out_because fails', () => {
  const a = minimalValid();
  a.diagnosis.differentials = [{ label: 'Stem borer' }];
  const r = validateAdvisory(a);
  assert.equal(r.valid, false);
});

test('invalid confidence value fails', () => {
  const a = minimalValid();
  a.diagnosis.primary.confidence = 'probably';
  const r = validateAdvisory(a);
  assert.equal(r.valid, false);
});

test('advice.do_not without text_en fails', () => {
  const a = minimalValid();
  a.advice.do_not = [{ reason: 'Risk' }];
  const r = validateAdvisory(a);
  assert.equal(r.valid, false);
});

test('refusal without reason_en fails', () => {
  const r = validateAdvisory({
    record_kind: 'refusal',
    language: 'en',
    context: { crop: null, chief_complaint_en: 'Question' },
    provenance: { fact_ids: [], source_names: [] },
    policy_trace: [],
    refusal: {}
  });
  assert.equal(r.valid, false);
});

test('missing escalation.trigger_en fails', () => {
  const a = minimalValid();
  a.escalation = { referral: 'Officer', urgency: 'low' };
  const r = validateAdvisory(a);
  assert.equal(r.valid, false);
});