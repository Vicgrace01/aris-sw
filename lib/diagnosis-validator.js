/* Valid diagnoses per crop, sourced from gold_diagnostics.jsonl.
 *
 * Match policy (audit-aligned):
 *   - Full canonical label match Ã¢â€ â€™ confident snap (score 15)
 *   - Short-name match (e.g. "Fall armyworm" for "Fall armyworm (Spodoptera frugiperda)") Ã¢â€ â€™ confident snap (score 12)
 *   - 2+ distinct keyword hits Ã¢â€ â€™ confident snap (score >= 5)
 *   - 1 keyword hit Ã¢â€ â€™ WEAK match, does NOT snap (audit fix)
 *   - 0 keyword hits Ã¢â€ â€™ no match, does NOT snap
 *
 * Threshold for snapping is 5. A single ambiguous keyword like "whorl" or
 * "yellow" or "wilt" alone is not enough to commit to a canonical diagnosis.
 * The model's own label is preserved as "unconfirmed" instead, and a
 * field_confirmation triage question is queued.
 */

const VALID_DIAGNOSES = {
  maize: [
    { canonical: 'Fall armyworm (Spodoptera frugiperda)', sw: 'Viwavi jeshi (Spodoptera frugiperda)', keywords: ['armyworm', 'faw', 'spodoptera', 'whorl', 'frass'], factIds: ['FAW-001', 'FAW-002', 'FAW-003'], sources: ['IITA', 'NAERLS'] },
    { canonical: 'Maize stem borer (Busseola fusca)', sw: 'Funza wa shina la mahindi (Busseola fusca)', keywords: ['stem borer', 'borer', 'busseola', 'tunnel', 'dead heart'], factIds: ['SB-001', 'SB-002'], sources: ['IITA', 'NAERLS'] },
    { canonical: 'Striga (Striga hermonthica) damage', sw: 'Uharibifu wa kidani cha striga', keywords: ['striga', 'stunting', 'purple', 'parasit', 'witchweed'], factIds: ['STR-001', 'STR-002'], sources: ['IITA', 'NAERLS'] }
  ],
  cassava: [
    { canonical: 'Cassava mosaic disease', sw: 'Ugonjwa wa batobato wa muhogo', keywords: ['mosaic', 'cmd', 'yellow', 'distort', 'whitefly'], factIds: ['CMD-001', 'CMD-002', 'CMD-003'], sources: ['IITA', 'NRCRI'] },
    { canonical: 'Cassava brown streak disease', sw: 'Ugonjwa wa mfululizo wa kahawia wa muhogo', keywords: ['brown streak', 'cbsd', 'root necrosis'], factIds: ['CBSD-001'], sources: ['IITA', 'NRCRI'] }
  ],
  tomato: [
    { canonical: 'Bacterial wilt (Ralstonia solanacearum)', sw: 'Unyauko wa bakteria (Ralstonia solanacearum)', keywords: ['bacterial wilt', 'ralstonia', 'wilt', 'sudden collapse'], factIds: ['BW-001', 'BW-002'], sources: ['IITA', 'NAERLS'] },
    { canonical: 'Fusarium wilt', sw: 'Unyauko wa Fusarium', keywords: ['fusarium', 'one-sided'], factIds: ['FW-001'], sources: ['IITA', 'NAERLS'] }
  ],
  cowpea: [
    { canonical: 'Cowpea seed beetle (Callosobruchus maculatus)', sw: 'Mende wa mbegu za kunde', keywords: ['callosobruchus', 'seed beetle', 'storage', 'exit hole'], factIds: ['CP-001', 'CP-002'], sources: ['IITA', 'NSPRI'] }
  ],
  groundnut: [
    { canonical: 'Groundnut rosette disease', sw: 'Ugonjwa wa rosette wa karanga', keywords: ['rosette', 'mottle', 'aphid'], factIds: ['GR-001', 'GR-002'], sources: ['IITA', 'NAERLS'] }
  ],
  rice: [
    { canonical: 'Rice yellow mottle virus (RYMV)', sw: 'Virusi vya madoa njano ya mpunga (RYMV)', keywords: ['rymv', 'mottle', 'yellow'], factIds: ['RYMV-001', 'RYMV-002'], sources: ['AfricaRice', 'IITA'] }
  ]
};

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function shortName(canonical) {
  return normalize(String(canonical).split('(')[0]);
}

function scoreMatch(label, entry) {
  const n = normalize(label);

  // 1. Full canonical match Ã¢â‚¬â€ highest confidence
  if (n.includes(normalize(entry.canonical))) return 15;

  // 2. Short-name match Ã¢â‚¬â€ high confidence
  // e.g. "Fall armyworm" for canonical "Fall armyworm (Spodoptera frugiperda)"
  const short = shortName(entry.canonical);
  if (short.length >= 5 && n.includes(short)) return 12;

  // 3. Count distinct keyword hits
  let hits = 0;
  for (const kw of entry.keywords) {
    if (n.includes(normalize(kw))) hits++;
  }

  if (hits >= 3) return 8;   // multiple symptoms Ã¢â‚¬â€ very confident
  if (hits === 2) return 5;  // two symptom indicators Ã¢â‚¬â€ confident
  if (hits === 1) return 1;  // single ambiguous keyword Ã¢â‚¬â€ NOT enough to snap
  return 0;
}

function attachProvenance(advisory, entry) {
  if (!advisory || !entry) return;
  if (!advisory.provenance) advisory.provenance = { fact_ids: [], source_names: [] };
  advisory.provenance.fact_ids = Array.isArray(entry.factIds) ? [...entry.factIds] : [];
  advisory.provenance.source_names = Array.isArray(entry.sources) ? [...entry.sources] : [];
}

function clearProvenance(advisory) {
  if (!advisory.provenance) advisory.provenance = { fact_ids: [], source_names: [] };
  advisory.provenance.fact_ids = [];
  if (!Array.isArray(advisory.provenance.source_names) || advisory.provenance.source_names.length === 0) {
    advisory.provenance.source_names = ['Unverified Ã¢â‚¬â€ field confirmation required'];
  }
}

function addFieldConfirmationQuestion(advisory, cropKey) {
  if (!advisory.triage) advisory.triage = { observed_signs: [], missing_discriminators: [], questions: [] };
  if (!Array.isArray(advisory.triage.questions)) advisory.triage.questions = [];
  const already = advisory.triage.questions.some(q => q.field === 'field_confirmation');
  if (already) return;
  advisory.triage.questions.unshift({
    field: 'field_confirmation',
    ask_en: `Please describe the symptoms in more detail, or confirm the affected crop is ${cropKey}. An extension officer can help if symptoms are unclear.`,
    ask_sw: `Tafadhali eleza dalili kwa undani zaidi, au thibitisha kuwa zao lililoathirika ni ${cropKey}. Afisa wa ugani anaweza kusaidia ikiwa dalili haziko wazi.`,
    why: 'The system did not match this case to a verified diagnosis. A human confirmation is required before giving treatment advice.'
  });
}

export function enforceDiagnosis(advisory, crop) {
  if (!advisory?.diagnosis?.primary) return { enforced: false, matched: false };

  const cropKey = (crop || '').toLowerCase();
  const valid = VALID_DIAGNOSES[cropKey];
  if (!valid || valid.length === 0) return { enforced: false, matched: false, reason: 'no_whitelist_for_crop' };

  const label = advisory.diagnosis.primary.label || '';
  let best = null;
  let bestScore = 0;
  for (const entry of valid) {
    const s = scoreMatch(label, entry);
    if (s > bestScore) { bestScore = s; best = entry; }
  }

  // SNAP THRESHOLD = 5 Ã¢â‚¬â€ confident match only
  if (best && bestScore >= 5) {
    const before = label;
    advisory.diagnosis.primary.label = best.canonical;
    advisory.diagnosis.primary.label_sw = best.sw;
    attachProvenance(advisory, best);
    return { enforced: true, matched: true, before, after: best.canonical, score: bestScore };
  }

  // Weak-match attempt via differentials Ã¢â‚¬â€ also require score >= 5
  for (const d of (advisory.diagnosis.differentials || [])) {
    for (const entry of valid) {
      if (scoreMatch(d.label, entry) >= 5) {
        const before = advisory.diagnosis.primary.label;
        advisory.diagnosis.differentials = advisory.diagnosis.differentials.filter(x => x !== d);
        advisory.diagnosis.differentials.push({
          label: before,
          ruled_out_because: 'Not supported by primary symptom pattern.'
        });
        advisory.diagnosis.primary.label = entry.canonical;
        advisory.diagnosis.primary.label_sw = entry.sw;
        attachProvenance(advisory, entry);
        return { enforced: true, matched: true, before, after: entry.canonical, fromDifferential: true };
      }
    }
  }

  // NO CONFIDENT MATCH Ã¢â‚¬â€ preserve the model's own label as unconfirmed.
  // Never fabricate a diagnosis from array position or a single keyword.
  const originalLabel = advisory.diagnosis.primary.label;
  advisory.diagnosis.primary.confidence = 'unconfirmed';
  advisory.diagnosis.confidence_basis = `The system could not confidently match "${originalLabel}" against the verified diagnosis set for ${cropKey}. Field confirmation required before any treatment advice.`;
  advisory.diagnosis.unsupported = true;

  clearProvenance(advisory);
  addFieldConfirmationQuestion(advisory, cropKey);

  return { enforced: true, matched: false, unsupported: true, before: originalLabel, after: originalLabel, bestScore };
}

/* Confidence escalation Ã¢â‚¬â€ requires an affirmative answer that actually names
 * a specific evidence term. A bare "yes" without a symptom does NOT bump.
 * A negative answer does NOT bump. */

const CONFIRMATION_WORDS = ['yes', 'yeah', 'yep', 'ndio', 'ndiyo', 'saw', 'seen', 'see', 'find', 'found', 'visible', 'kuna', 'naona', 'nimeona', 'correct', 'sahihi'];
const NEGATION_WORDS = ['no', 'not', 'cannot', "can't", 'cant', "don't", 'dont', "doesn't", 'doesnt', "isn't", 'isnt', "won't", 'wont', 'hakuna', 'hapana', 'sioni', 'sijaona', 'sijui', 'nope', 'none', 'wrong'];

const EVIDENCE_POOL = [
  'frass', 'kinyesi', 'sawdust', 'caterpillar', 'viwavi', 'larva', 'worm', 'funza',
  'whorl', 'kilele', 'stem', 'shina', 'leaf', 'majani', 'yellow', 'njano', 'manjano',
  'mosaic', 'wilt', 'kunyauka', 'spots', 'madoa', 'tunnel', 'borer', 'lesion', 'fungus', 'ukoga'
];

function hasWord(text, word) {
  if (word.length <= 4) {
    return new RegExp(`\\b${word}\\b`, 'i').test(text);
  }
  return text.includes(word);
}

export function bumpConfidenceOnAnswer(advisory, farmerAnswer, answeredQuestion = null) {
  if (!advisory?.diagnosis?.primary) return { bumped: false };
  if (advisory.diagnosis.unsupported) return { bumped: false };
  const current = advisory.diagnosis.primary.confidence;
  if (current === 'confirmed') return { bumped: false };

  const lower = (farmerAnswer || '').toLowerCase();

  // Reject negative answers Ã¢â‚¬â€ "no" or "sijaona" must not bump confidence
  if (NEGATION_WORDS.some(w => hasWord(lower, w))) {
    return { bumped: false, reason: 'negative_answer' };
  }

  // Require an affirmative word
  if (!CONFIRMATION_WORDS.some(w => hasWord(lower, w))) {
    return { bumped: false, reason: 'no_affirmation' };
  }

  // Require specific evidence Ã¢â‚¬â€ bare "yes" without a symptom term does NOT bump
  const hasEvidence = EVIDENCE_POOL.some(t => lower.includes(t));
  if (!hasEvidence) {
    return { bumped: false, reason: 'affirmation_without_evidence' };
  }

  const next = current === 'unconfirmed' ? 'possible'
             : current === 'possible' ? 'likely'
             : current === 'likely' ? 'confirmed'
             : current;

  if (next !== current) {
    advisory.diagnosis.primary.confidence = next;
    advisory.diagnosis.confidence_basis = (advisory.diagnosis.confidence_basis || '') + ' (Upgraded after farmer confirmed a specific discriminator.)';
    return { bumped: true, before: current, after: next };
  }
  return { bumped: false };
}