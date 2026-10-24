import * as nkenne from './nkenne.js';
import { logger } from './logger.js';

const KNOWN_LABELS = {
  // Diagnosis labels — already curated
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
  'rice yellow mottle virus': 'Virusi vya madoa njano ya mpunga',

  // Advice strings — pre-translated for demo (eliminates API dependency)
  'inspect the whorls of 10 plants for larvae or frass': 'Kagua vichwa vya mimea 10 kwa viwavi au kinyesi',
  'inspect 10 plants in 5 spots to assess infestation level': 'Kagua mimea 10 katika maeneo 5 kutathmini kiwango cha maambukizi',
  'do not apply any pesticide without a confirmed diagnosis and a registered product recommendation': 'Usitumie dawa yoyote bila utambuzi uliothibitishwa na mapendekezo ya bidhaa yaliyosajiliwa',
  'if symptoms spread to more than 20% of plants, contact your extension officer': 'Ikiwa dalili zinaenea kwa zaidi ya 20% ya mimea, wasiliana na afisa wako wa upanuzi',
  'contact your local agricultural extension officer': 'Wasiliana na afisa wa ugani wa eneo lako',
  'contact your local extension officer immediately to obtain a registered insecticide and correct dosage': 'Wasiliana na afisa wako wa upanuzi wa ndani mara moja ili kupata dawa iliyosajiliwa na kipimo sahihi',
  'do you see caterpillars or sawdust-like waste inside the leaf whorl': 'Unaona viwavi au kinyesi ndani ya kilele cha majani',
  'is the damage in the whorl (top funnel) or in the stem lower down': 'Uharibifu uko kwenye kilele cha mmea au kwenye shina chini',
  'do you see sawdust-like waste (frass) inside the whorl': 'Unaona kinyesi kinachofanana na vumbi la mbao ndani ya kilele cha mmea'
};

const fieldCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const DELAY_BETWEEN_CALLS_MS = 900;

function normalizeForMatch(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ');
}

function cacheKey(text) { return text.trim().toLowerCase(); }

export function getTranslationCacheStats() {
  return { size: fieldCache.size, knownLabels: Object.keys(KNOWN_LABELS).length };
}

async function translateField(text) {
  if (!text || typeof text !== 'string') return '';

  const normalized = normalizeForMatch(text);
  if (KNOWN_LABELS[normalized]) return KNOWN_LABELS[normalized];

  const key = cacheKey(text);
  const cached = fieldCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.value;

  const cleaned = text.replace(/\s*\([^)]*\)/g, '').trim();
  if (!cleaned) return '';

  try {
    const result = await nkenne.translate(cleaned, 'English', 'Swahili');
    const translated = (result.text || '').trim();
    if (!translated) return '';

    fieldCache.set(key, { value: translated, timestamp: Date.now() });
    if (fieldCache.size > 500) fieldCache.delete(fieldCache.keys().next().value);
    return translated;
  } catch (e) {
    logger.warn('translate.field_failed', { error: e.message, input: cleaned.substring(0, 40) });
    return '';
  }
}

export async function translateAdvisory(advisory) {
  const jobs = [];

  if (advisory.diagnosis?.primary?.label) {
    jobs.push({ src: advisory.diagnosis.primary.label, apply: v => { advisory.diagnosis.primary.label_sw = v; } });
  }
  for (const item of (advisory.advice?.immediate || [])) {
    if (item.action_en) jobs.push({ src: item.action_en, apply: v => { item.action_sw = v; } });
  }
  for (const item of (advisory.advice?.preventive || [])) {
    if (item.action_en) jobs.push({ src: item.action_en, apply: v => { item.action_sw = v; } });
  }
  for (const item of (advisory.advice?.do_not || [])) {
    if (item.text_en) jobs.push({ src: item.text_en, apply: v => { item.text_sw = v; } });
  }
  if (advisory.escalation?.trigger_en) {
    jobs.push({ src: advisory.escalation.trigger_en, apply: v => { advisory.escalation.trigger_sw = v; } });
  }
  if (advisory.escalation?.referral) {
    jobs.push({ src: advisory.escalation.referral, apply: v => { advisory.escalation.referral_sw = v; } });
  }
  for (const q of (advisory.triage?.questions || [])) {
    if (q.ask_en && !q.ask_sw) {
      jobs.push({ src: q.ask_en, apply: v => { q.ask_sw = v; } });
    }
  }

  let translatedCount = 0;
  let fallbackCount = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const translated = await translateField(job.src);
    if (translated) {
      job.apply(translated);
      translatedCount++;
    } else {
      fallbackCount++;
    }
    if (i < jobs.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_CALLS_MS));
    }
  }

  return { total: jobs.length, translated: translatedCount, fallback: fallbackCount };
}