/* Valid diagnoses per crop. The whitelist exists so high-confidence
 * keyword matches snap to canonical labels with real provenance.
 *
 * If the model returns a label that does NOT match any whitelist entry,
 * the system MUST NOT invent a diagnosis. The label is kept as-is,
 * confidence drops to "unconfirmed", provenance fact_ids are cleared,
 * and a triage question is added asking for field confirmation.
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
    { canonical: 'Rice yellow mottle virus (RYMV)', sw: 'Virusi vya madoa njano ya mpunga', keywords: ['rymv', 'mottle', 'yellow'], factIds: ['RYMV-001', 'RYMV-002'], sources: ['AfricaRice', 'IITA'] }
  ]
};

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreMatch(label, entry) {
  const n = normalize(label);
  let score = 0;
  if (n.includes(normalize(entry.canonical))) score += 10;
  for (const kw of entry.keywords) {
    if (n.includes(normalize(kw))) score += 3;
  }
  return score;
}

function attachProvenance(advisory, entry) {
  if (!advisory || !entry) return;
  if (!advisory.provenance) advisory.provenance = { fact_ids: [], source_names: [] };
  advisory.provenance.fact_ids = Array.isArray(entry.factIds) ? [...entry.factIds] : [];
  advisory.provenance.source_names = Array.isArray(entry.sources) ? [...entry.sources] : [];
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

  // HIGH-CONFIDENCE MATCH: snap to canonical, attach provenance. This is safe.
  if (best && bestScore >= 3) {
    const before = label;
    advisory.diagnosis.primary.label = best.canonical;
    advisory.diagnosis.primary.label_sw = best.sw;
    attachProvenance(advisory, best);
    return { enforced: true, matched: true, before, after: best.canonical, score: bestScore };
  }

  // Try promoting from differentials — but only on a VERY high match (>= 5)
  // to avoid the same fabrication risk. A weak match is not a license to snap.
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

  // NO MATCH — do NOT fabricate. Keep the model's label but mark it unconfirmed
  // with no provenance, and add a triage question asking for field confirmation.
  const originalLabel = advisory.diagnosis.primary.label;
  advisory.diagnosis.primary.confidence = 'unconfirmed';
  advisory.diagnosis.confidence_basis = `The system could not confirm "${originalLabel}" against the verified diagnosis set for ${cropKey}. Field confirmation required before any treatment advice.`;
  advisory.diagnosis.unsupported = true;

  if (!advisory.provenance) advisory.provenance = { fact_ids: [], source_names: [] };
  advisory.provenance.fact_ids = [];
  if (!Array.isArray(advisory.provenance.source_names) || advisory.provenance.source_names.length === 0) {
    advisory.provenance.source_names = ['Unverified — field confirmation required'];
  }

  if (!advisory.triage) advisory.triage = { observed_signs: [], missing_discriminators: [], questions: [] };
  if (!Array.isArray(advisory.triage.questions)) advisory.triage.questions = [];
  const already = advisory.triage.questions.some(q => q.field === 'field_confirmation');
  if (!already) {
    advisory.triage.questions.unshift({
      field: 'field_confirmation',
      ask_en: `Please describe the symptoms in more detail, or confirm the affected crop is ${cropKey}. An extension officer can help if symptoms are unclear.`,
      ask_sw: `Tafadhali eleza dalili kwa undani zaidi, au thibitisha kuwa zao lililoathirika ni ${cropKey}. Afisa wa ugani anaweza kusaidia ikiwa dalili haziko wazi.`,
      why: 'The system did not match this case to a verified diagnosis. A human confirmation is required before giving treatment advice.'
    });
  }

  return { enforced: true, matched: false, unsupported: true, before: originalLabel, after: originalLabel };
}

const CONFIRMATION_WORDS = [
  'yes', 'yeah', 'ndio', 'ndiyo', 'saw', 'seen', 'see', 'find', 'found',
  'visible', 'there is', 'there are', 'kuna', 'naona', 'nimeona',
  'frass', 'kinyesi', 'sawdust', 'caterpillar', 'viwavi', 'larva'
];

export function bumpConfidenceOnAnswer(advisory, farmerAnswer) {
  if (!advisory?.diagnosis?.primary) return { bumped: false };
  if (advisory.diagnosis.unsupported) return { bumped: false };
  const current = advisory.diagnosis.primary.confidence;
  if (current === 'confirmed') return { bumped: false };

  const lower = (farmerAnswer || '').toLowerCase();
  const hasConfirmation = CONFIRMATION_WORDS.some(w => lower.includes(w));
  if (!hasConfirmation) return { bumped: false };

  const next = current === 'unconfirmed' ? 'possible'
             : current === 'possible' ? 'likely'
             : current === 'likely' ? 'confirmed'
             : current;

  if (next !== current) {
    advisory.diagnosis.primary.confidence = next;
    advisory.diagnosis.confidence_basis = (advisory.diagnosis.confidence_basis || '') + ' (Upgraded after farmer confirmed a discriminator.)';
    return { bumped: true, before: current, after: next };
  }
  return { bumped: false };
}