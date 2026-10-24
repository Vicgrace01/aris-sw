import * as nkenne from './nkenne.js';
import { logger } from './logger.js';

const KNOWN_LABELS = {
  'fall armyworm (spodoptera frugiperda)': 'Viwavi jeshi (Spodoptera frugiperda)',
  'fall armyworm': 'Viwavi jeshi',
  'maize stem borer (busseola fusca)': 'Funza wa shina la mahindi (Busseola fusca)',
  'maize stem borer': 'Funza wa shina la mahindi',
  'fall armyworm (spodoptera frugiperda) or maize stem borer (busseola fusca)':
    'Viwavi jeshi (Spodoptera frugiperda) au funza wa shina la mahindi (Busseola fusca)',
  'cassava mosaic disease': 'Ugonjwa wa batobato wa muhogo',
  'bacterial wilt (ralstonia solanacearum)': 'Unyauko wa bakteria (Ralstonia solanacearum)',
  'bacterial wilt': 'Unyauko wa bakteria',
  'striga (striga hermonthica) damage': 'Uharibifu wa kidani cha striga (Striga hermonthica)',
  'striga': 'Kidani cha striga',
  'striga hermonthica': 'Kidani cha striga',
  'cowpea seed beetle (callosobruchus maculatus)': 'Mende wa mbegu za kunde (Callosobruchus maculatus)',
  'groundnut rosette disease': 'Ugonjwa wa rosette wa karanga',
  'groundnut rosette': 'Ugonjwa wa rosette wa karanga',
  'rice yellow mottle virus (rymv)': 'Virusi vya madoa njano ya mpunga (RYMV)',
  'rice yellow mottle virus': 'Virusi vya madoa njano ya mpunga'
};

const SEP = ' ||| ';
const advisoryCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function cacheKey(advisory) {
  return JSON.stringify({
    label: advisory.diagnosis?.primary?.label,
    immediate: (advisory.advice?.immediate || []).map(x => x.action_en),
    preventive: (advisory.advice?.preventive || []).map(x => x.action_en),
    do_not: (advisory.advice?.do_not || []).map(x => x.text_en),
    trigger: advisory.escalation?.trigger_en,
    referral: advisory.escalation?.referral
  });
}

function sanityCheck(original, translated) {
  if (!translated || typeof translated !== 'string') return false;
  if (translated.length === 0) return false;
  if (translated.length > original.length * 8) return false;
  return true;
}

export function getTranslationCacheStats() {
  return { size: advisoryCache.size, knownLabels: Object.keys(KNOWN_LABELS).length };
}

export async function translateAdvisory(advisory) {
  const key = cacheKey(advisory);
  const cached = advisoryCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    applyFields(advisory, cached.fields);
    logger.info('translate.cache.hit');
    return { total: cached.fields.length, translated: cached.fields.filter(f => f).length, fallback: cached.fields.filter(f => !f).length, cached: true };
  }

  // Build list of (field, original text, curated-or-not) in the exact order we'll read them back
  const fields = [];
  const setters = [];

  // 1. Diagnosis label — try curated map first
  if (advisory.diagnosis?.primary?.label) {
    const label = advisory.diagnosis.primary.label;
    const normalized = label.trim().toLowerCase();
    if (KNOWN_LABELS[normalized]) {
      advisory.diagnosis.primary.label_sw = KNOWN_LABELS[normalized];
      fields.push(KNOWN_LABELS[normalized]);
      setters.push(null); // already applied
    } else {
      fields.push(label);
      setters.push(v => { advisory.diagnosis.primary.label_sw = v; });
    }
  }

  // 2. Immediate actions
  for (const item of (advisory.advice?.immediate || [])) {
    if (item.action_en) {
      fields.push(item.action_en);
      setters.push(v => { item.action_sw = v; });
    }
  }

  // 3. Preventive actions
  for (const item of (advisory.advice?.preventive || [])) {
    if (item.action_en) {
      fields.push(item.action_en);
      setters.push(v => { item.action_sw = v; });
    }
  }

  // 4. Do-not items
  for (const item of (advisory.advice?.do_not || [])) {
    if (item.text_en) {
      fields.push(item.text_en);
      setters.push(v => { item.text_sw = v; });
    }
  }

  // 5. Escalation trigger
  if (advisory.escalation?.trigger_en) {
    fields.push(advisory.escalation.trigger_en);
    setters.push(v => { advisory.escalation.trigger_sw = v; });
  }

  // 6. Escalation referral
  if (advisory.escalation?.referral) {
    fields.push(advisory.escalation.referral);
    setters.push(v => { advisory.escalation.referral_sw = v; });
  }

  if (fields.length === 0) return { total: 0, translated: 0, fallback: 0 };

  // Build the combined string — strip parenthetical scientific names to avoid translator token loops
  const cleanedFields = fields.map(f => {
    const n = (f || '').trim().toLowerCase();
    if (KNOWN_LABELS[n]) return null; // skip — already applied
    return String(f).replace(/\s*\([^)]*\)/g, '').trim();
  });

  const toTranslate = cleanedFields.filter(f => f !== null);
  if (toTranslate.length === 0) {
    return { total: setters.length, translated: setters.length, fallback: 0, cached: false };
  }

  const combined = toTranslate.join(SEP);

  let result;
  try {
    result = await nkenne.translate(combined, 'English', 'Swahili');
  } catch (e) {
    logger.warn('translate.batch_failed', { error: e.message, fieldCount: toTranslate.length });
    return { total: setters.length, translated: 0, fallback: setters.length, error: e.message };
  }

  const parts = (result.text || '').split('|||').map(s => s.trim());

  // Map translated parts back to original fields (in order, skipping curated ones)
  const translatedByField = [];
  let partIdx = 0;
  for (let i = 0; i < fields.length; i++) {
    if (cleanedFields[i] === null) {
      translatedByField.push(fields[i]); // curated, already applied
    } else {
      translatedByField.push(parts[partIdx] || '');
      partIdx++;
    }
  }

  // Sanity check the whole thing
  const validTranslations = translatedByField.map((v, i) => {
    if (cleanedFields[i] === null) return v;
    return sanityCheck(cleanedFields[i], v) ? v : '';
  });

  // Apply
  for (let i = 0; i < setters.length; i++) {
    if (setters[i] && validTranslations[i]) {
      setters[i](validTranslations[i]);
    }
  }

  advisoryCache.set(key, { fields: validTranslations, timestamp: Date.now() });
  if (advisoryCache.size > 500) advisoryCache.delete(advisoryCache.keys().next().value);

  const translatedCount = validTranslations.filter(v => v).length;
  const fallbackCount = validTranslations.length - translatedCount;

  logger.info('translate.batch_ok', {
    total: validTranslations.length,
    translated: translatedCount,
    fallback: fallbackCount,
    tokensRemaining: result.tokensRemaining
  });

  return {
    total: validTranslations.length,
    translated: translatedCount,
    fallback: fallbackCount,
    tokensRemaining: result.tokensRemaining,
    cached: false
  };
}

function applyFields(advisory, fields) {
  let i = 0;
  if (advisory.diagnosis?.primary?.label && i < fields.length) {
    advisory.diagnosis.primary.label_sw = fields[i++];
  }
  for (const item of (advisory.advice?.immediate || [])) {
    if (item.action_en && i < fields.length) item.action_sw = fields[i++];
  }
  for (const item of (advisory.advice?.preventive || [])) {
    if (item.action_en && i < fields.length) item.action_sw = fields[i++];
  }
  for (const item of (advisory.advice?.do_not || [])) {
    if (item.text_en && i < fields.length) item.text_sw = fields[i++];
  }
  if (advisory.escalation?.trigger_en && i < fields.length) advisory.escalation.trigger_sw = fields[i++];
  if (advisory.escalation?.referral && i < fields.length) advisory.escalation.referral_sw = fields[i++];
}