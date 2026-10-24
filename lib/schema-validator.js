const VALID_KINDS = ['diagnostic_episode', 'fact_only', 'refusal'];
const VALID_CONFIDENCES = ['confirmed', 'likely', 'possible', 'unconfirmed'];

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

export function validateAdvisory(a) {
  const errors = [];

  if (!isPlainObject(a)) {
    const t = Array.isArray(a) ? 'array' : (a === null ? 'null' : typeof a);
    return { valid: false, errors: [`Response must be a plain object (got: ${t})`] };
  }

  if (!VALID_KINDS.includes(a.record_kind)) {
    errors.push(`record_kind must be one of ${VALID_KINDS.join(', ')} (got: ${String(a.record_kind)})`);
  }

  if (!isPlainObject(a.context)) {
    errors.push('context must be an object');
  }

  if (!isPlainObject(a.provenance) || !Array.isArray(a.provenance.source_names)) {
    errors.push('provenance.source_names must be an array');
  }

  if (!Array.isArray(a.policy_trace)) {
    errors.push('policy_trace must be an array');
  }

  if (a.record_kind === 'diagnostic_episode') {
    if (!isPlainObject(a.diagnosis) || !isPlainObject(a.diagnosis.primary) || !a.diagnosis.primary.label) {
      errors.push('diagnosis.primary.label is required');
    } else if (!VALID_CONFIDENCES.includes(a.diagnosis.primary.confidence)) {
      errors.push(`diagnosis.primary.confidence must be one of ${VALID_CONFIDENCES.join(', ')} (got: ${String(a.diagnosis.primary.confidence)})`);
    }

    if (!Array.isArray(a.diagnosis?.differentials)) {
      errors.push('diagnosis.differentials must be an array');
    } else {
      a.diagnosis.differentials.forEach((d, i) => {
        if (!isPlainObject(d) || !d.label) errors.push(`diagnosis.differentials[${i}].label is required`);
        if (!isPlainObject(d) || !d.ruled_out_because) errors.push(`diagnosis.differentials[${i}].ruled_out_because is required`);
      });
    }

    if (!Array.isArray(a.advice?.immediate)) {
      errors.push('advice.immediate must be an array');
    } else {
      a.advice.immediate.forEach((x, i) => {
        if (!isPlainObject(x) || !x.action_en) errors.push(`advice.immediate[${i}].action_en is required`);
      });
    }

    if (!Array.isArray(a.advice?.do_not)) {
      errors.push('advice.do_not must be an array');
    } else {
      a.advice.do_not.forEach((x, i) => {
        if (!isPlainObject(x) || !x.text_en) errors.push(`advice.do_not[${i}].text_en is required`);
      });
    }

    if (!isPlainObject(a.escalation) || !a.escalation.trigger_en) {
      errors.push('escalation.trigger_en is required');
    }
  }

  if (a.record_kind === 'refusal') {
    if (!isPlainObject(a.refusal) || !a.refusal.reason_en) {
      errors.push('refusal.reason_en is required');
    }
  }

  return { valid: errors.length === 0, errors };
}