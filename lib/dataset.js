import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

let allEpisodes = [];
let cleanEpisodes = [];
let templatedEpisodes = [];
let goldDiagnostics = [];
let byCrop = new Map();
let byKind = { diagnostic_episode: [], fact_only: [], refusal: [] };
let swahiliEpisodes = null;
let swahiliGold = null;

const CROP_KEYWORDS = [
  'maize', 'corn', 'rice', 'cassava', 'yam', 'cowpea', 'sorghum',
  'millet', 'groundnut', 'soybean', 'tomato', 'pepper', 'onion',
  'okra', 'plantain', 'banana', 'cocoa', 'oil palm', 'cashew',
  'ginger', 'sesame', 'melon', 'sugarcane', 'wheat', 'potato',
  'sweet potato', 'vegetable', 'bean', 'pigeon pea', 'mango',
  'citrus', 'orange',
  'mahindi', 'mchele', 'mpunga', 'muhogo', 'mihogo', 'viazi',
  'nyanya', 'karanga', 'choroko', 'mtama', 'ulezi', 'ndizi',
  'maharagwe', 'pamba', 'miwa', 'ngano', 'pilipili', 'kitunguu',
  'biringanya', 'maharage', 'alizeti', 'simsim'
];

const CROP_SYNONYMS = {
  corn: 'maize', mahindi: 'maize',
  mchele: 'rice', mpunga: 'rice',
  muhogo: 'cassava', mihogo: 'cassava',
  viazi: 'potato',
  nyanya: 'tomato', biringanya: 'tomato',
  karanga: 'groundnut',
  choroko: 'cowpea', maharage: 'bean',
  mtama: 'sorghum',
  ulezi: 'millet',
  ndizi: 'banana',
  maharagwe: 'bean',
  pamba: 'cotton',
  miwa: 'sugarcane',
  ngano: 'wheat',
  pilipili: 'pepper',
  kitunguu: 'onion',
  alizeti: 'sunflower',
  simsim: 'sesame'
};

const SW_MARKERS = [' na ',' ya ',' wa ',' kwa ',' la ',' za ',' ni ',' yangu',' yetu',' yako',' wao',' kwenye',' katika','kuna','hakuna',' sana ',' kidogo',' mengi',' wengi',' hii ',' hilo ',' hiyo ',' huyu ',' yule '];

const SYMPTOM_TERMS = [
  'holes', 'spots', 'wilting', 'wilt', 'rot', 'yellow', 'mosaic',
  'blight', 'stunted', 'stunting', 'dying', 'dead', 'insect', 'worm',
  'caterpillar', 'larva', 'aphid', 'whitefly', 'beetle', 'frass',
  'curling', 'drooping', 'discolored', 'discoloured', 'powder',
  'smut', 'gall', 'boring', 'stem', 'leaf', 'leaves', 'fruit',
  'matundu', 'tundu', 'kuoza', 'njano', 'manjano', 'madoa',
  'kunyauka', 'kuvimba', 'viwavi', 'wadudu', 'shina', 'majani',
  'kuuma', 'kudhoofika', 'kukauka', 'ukungu', 'ugonjwa', 'vidonda',
  'mafunza', 'funza', 'kuanguka', 'vichwa', 'kuvunjika'
];

function detectLanguage(text) {
  const lower = ' ' + (text || '').toLowerCase() + ' ';
  for (const m of SW_MARKERS) if (lower.includes(m)) return 'sw';
  return 'en';
}

function isTemplated(ep) {
  if (ep.record_kind !== 'diagnostic_episode') return false;
  const label = ep.diagnosis?.primary?.label || '';
  return label.startsWith('possible disorder in');
}

function indexEpisode(ep) {
  const crop = (ep.context?.crop || '_none').toLowerCase();
  if (!byCrop.has(crop)) byCrop.set(crop, []);
  byCrop.get(crop).push(ep);
  if (byKind[ep.record_kind]) byKind[ep.record_kind].push(ep);
}

export async function loadDataset(filePath, goldPath = null, swahiliPath = null, swahiliGoldPath = null) {
  const raw = await readFile(filePath, 'utf-8');
  allEpisodes = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

  for (const ep of allEpisodes) {
    if (isTemplated(ep)) templatedEpisodes.push(ep);
    else { cleanEpisodes.push(ep); indexEpisode(ep); }
  }

  if (goldPath) {
    try {
      const goldRaw = await readFile(goldPath, 'utf-8');
      goldDiagnostics = goldRaw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      for (const ep of goldDiagnostics) indexEpisode(ep);
      console.log(`[dataset] loaded ${goldDiagnostics.length} GOLD diagnostic episodes`);
    } catch { console.log(`[dataset] no gold file at ${goldPath}`); }
  }

  if (swahiliPath) {
    try {
      const swRaw = await readFile(swahiliPath, 'utf-8');
      swahiliEpisodes = swRaw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      console.log(`[dataset] loaded ${swahiliEpisodes.length} SWAHILI-translated episodes`);
    } catch { /* optional */ }
  }

  if (swahiliGoldPath) {
    try {
      const swGoldRaw = await readFile(swahiliGoldPath, 'utf-8');
      swahiliGold = swGoldRaw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      console.log(`[dataset] loaded ${swahiliGold.length} SWAHILI-translated GOLD episodes`);
    } catch { /* optional */ }
  }

  console.log(`[dataset] total=${allEpisodes.length} clean=${cleanEpisodes.length + goldDiagnostics.length} templated_excluded=${templatedEpisodes.length}`);
  console.log(`[dataset] by kind: diag=${byKind.diagnostic_episode.length} fact=${byKind.fact_only.length} refusal=${byKind.refusal.length}`);
}

export function getStats() {
  return {
    total: allEpisodes.length,
    clean: cleanEpisodes.length + goldDiagnostics.length,
    templatedExcluded: templatedEpisodes.length,
    goldDiagnostics: goldDiagnostics.length,
    swahiliAvailable: Boolean(swahiliEpisodes),
    byKind: {
      diagnostic_episode: byKind.diagnostic_episode.length,
      fact_only: byKind.fact_only.length,
      refusal: byKind.refusal.length
    },
    crops: Array.from(byCrop.keys()).filter(k => k !== '_none').length
  };
}

export function detectCrop(text) {
  const lower = (text || '').toLowerCase();
  for (const kw of CROP_KEYWORDS) {
    if (lower.includes(kw)) return CROP_SYNONYMS[kw] || kw;
  }
  return null;
}

function hashInt(str) {
  const h = createHash('sha256').update(str).digest();
  return h.readUInt32BE(0);
}

function scoreEpisode(ep, input, inputCrop) {
  let score = 0;
  const text = (ep.context?.chief_complaint_en || '').toLowerCase();
  const inputLower = input.toLowerCase();

  if (inputCrop && (ep.context?.crop || '').toLowerCase() === inputCrop) score += 10;

  for (const term of SYMPTOM_TERMS) {
    if (inputLower.includes(term) && text.includes(term)) score += 2;
  }

  if (ep.record_kind === 'diagnostic_episode') score += 3;
  if (ep.record_kind === 'refusal' && /medical|price|exchange|live|headache|doctor/.test(inputLower)) score += 5;

  score += (hashInt(input + '|' + (ep.episode_id || '')) % 1000) / 1000;

  return score;
}

function pickVariant(ep, lang, swahiliPool) {
  if (lang !== 'sw' || !swahiliPool) return ep;
  const sw = swahiliPool.find(e => e.episode_id === ep.episode_id);
  return sw || ep;
}

export function selectFewShots(inputText, count = 3) {
  const lang = detectLanguage(inputText);
  const crop = detectCrop(inputText);

  const pool = [
    ...goldDiagnostics,
    ...byKind.fact_only,
    ...byKind.refusal
  ].filter((v, i, arr) => v && v.episode_id && arr.findIndex(e => e.episode_id === v.episode_id) === i);

  const scored = pool.map(ep => ({ ep, score: scoreEpisode(ep, inputText, crop) }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.ep.episode_id || '').localeCompare(b.ep.episode_id || '');
  });

  const selectedEpisodes = scored.slice(0, count).map(s => s.ep);

  const fewShots = selectedEpisodes.map(ep => {
    const variant = pickVariant(ep, lang, swahiliEpisodes);
    return {
      user: variant.context?.chief_complaint_sw
        || variant.context?.chief_complaint_en
        || variant.fact_body?.answer_sw
        || variant.fact_body?.answer_en
        || 'Agricultural question',
      assistant: JSON.stringify(stripMeta(variant))
    };
  });

  return {
    fewShots,
    detectedLang: lang,
    detectedCrop: crop,
    selectionTrace: selectedEpisodes.map(ep => ({
      id: ep.episode_id,
      kind: ep.record_kind
    }))
  };
}

function stripMeta(ep) {
  const { review, legacy_system_prompt, ...clean } = ep;
  return clean;
}