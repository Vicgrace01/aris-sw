import * as nkenne from './nkenne.js';
import { logger } from './logger.js';

/* ---------- Curated Swahili translations for known diagnoses ---------- */
/* These come from your gold dataset and are guaranteed correct. */

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

/* ---------- Per-field cache ---------- */

const fieldCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function cacheKey(text) { return text.trim().toLowerCase(); }

/* ---------- Sanity check on NKENNEAi output ---------- */

function sanityCheck(original, translated) {
  if (!translated || typeof translated !== 'string') return false;
  if (translated.length === 0) return false;

  // Reject if output is >4x input length (runaway generation)
  if (translated.length > original.length * 4) return false;

  // Reject if any word repeats 4+ times (degenerate loop)
  const words = translated.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const counts = {};
  for (const w of words) {
    counts[w] = (counts[w] || 0) + 1;
    if (counts[w] >= 4) return false;
  }

  // Reject if any 6-char substring repeats within 15 chars (e.g. "optera...optera")
  for (let i = 0; i < translated.length - 6; i++) {
    const sub = translated.substring(i, i + 6);
    const next = translated.indexOf(sub, i + 1);
    if (next !== -1 && next - i < 15) return false;
  }

  return true;
}

/* ---------- Single field translation ---------- */

async function translateField(text) {
  if (!text || typeof text !== 'string') return '';

  // Tier 1: curated map
  const normalized = text.trim().toLowerCase();
  if (KNOWN_LABELS[normalized]) return KNOWN_LABELS[normalized];

  // Tier 2: cache
  const key = cacheKey(text);
  const cached = fieldCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.value;

  // Tier 3: NKENNEAi translate — strip scientific names first (they break the translator)
  const cleaned = text.replace(/\s*\([^)]*\)/g, '').trim();
  if (!cleaned) return '';

  try {
    const result = await nkenne.translate(cleaned, 'English', 'Swahili');
    const translated = (result.text || '').trim();

    if (!sanityCheck(cleaned, translated)) {
      logger.warn('translate.garbage_rejected', {
        input: cleaned.substring(0, 40),
        output: translated.substring(0, 60)
      });
      fieldCache.set(key, { value: '', timestamp: Date.now() });
      return '';
    }

    fieldCache.set(key, { value: translated, timestamp: Date.now() });
    if (fieldCache.size > 500) fieldCache.delete(fieldCache.keys().next().value);
    return translated;
  } catch (e) {
    logger.warn('translate.field_failed', { error: e.message, input: cleaned.substring(0, 40) });
    return '';
  }
}

export function getTranslationCacheStats() {
  return { size: fieldCache.size, knownLabels: Object.keys(KNOWN_LABELS).length };
}

/* ---------- Advisory-level translation ---------- */

export async function translateAdvisory(advisory) {
  const jobs = [];

  if (advisory.diagnosis?.primary?.label) {
    jobs.push({
      src: advisory.diagnosis.primary.label,
      apply: v => { advisory.diagnosis.primary.label_sw = v; }
    });
  }

  for (const item of (advisory.advice?.immediate || [])) {
    if (item.action_en) {
      jobs.push({ src: item.action_en, apply: v => { item.action_sw = v; } });
    }
  }

  for (const item of (advisory.advice?.preventive || [])) {
    if (item.action_en) {
      jobs.push({ src: item.action_en, apply: v => { item.action_sw = v; } });
    }
  }

  for (const item of (advisory.advice?.do_not || [])) {
    if (item.text_en) {
      jobs.push({ src: item.text_en, apply: v => { item.text_sw = v; } });
    }
  }

  if (advisory.escalation?.trigger_en) {
    jobs.push({ src: advisory.escalation.trigger_en, apply: v => { advisory.escalation.trigger_sw = v; } });
  }

  if (advisory.escalation?.referral) {
    jobs.push({ src: advisory.escalation.referral, apply: v => { advisory.escalation.referral_sw = v; } });
  }

  let translatedCount = 0;
  let fallbackCount = 0;
  for (const job of jobs) {
    const translated = await translateField(job.src);
    if (translated) {
      job.apply(translated);
      translatedCount++;
    } else {
      fallbackCount++;
    }
  }

  return { total: jobs.length, translated: translatedCount, fallback: fallbackCount };
}