import 'dotenv/config';
import { readFile, writeFile, access } from 'node:fs/promises';

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

async function exists(p) { try { await access(p); return true; } catch { return false; } }

const SYSTEM = `You are a professional Swahili translator for agricultural advisory content.
The user will send you a JSON object with English strings. Return a JSON object with the SAME keys, each value translated to natural, farmer-friendly Swahili.
Rules:
- Preserve numbers, units, and proper nouns (IITA, NAERLS, TME 419, etc.) unchanged.
- Keep translations concise (same approximate length).
- Return ONLY valid JSON. No prose, no markdown.`;

async function translateBatch(obj) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(obj) }
      ],
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    })
  });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 5000));
    return translateBatch(obj);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return JSON.parse(data.choices[0].message.content);
}

async function translateEpisode(ep) {
  const out = JSON.parse(JSON.stringify(ep));

  const batch = {
    chief_complaint: out.context?.chief_complaint_en || '',
    primary_label: out.diagnosis?.primary?.label || '',
    confidence_basis: out.diagnosis?.confidence_basis || '',
    escalation_trigger: out.escalation?.trigger_en || '',
    escalation_referral: out.escalation?.referral || '',
    follow_up_success: out.follow_up?.success_indicator_en || '',
    fact_answer: out.fact_body?.answer_en || '',
    refusal_reason: out.refusal?.reason_en || '',
    immediate_actions: (out.advice?.immediate || []).map(a => a.action_en || '').join(' || '),
    preventive_actions: (out.advice?.preventive || []).map(a => a.action_en || '').join(' || '),
    do_not_texts: (out.advice?.do_not || []).map(d => d.text_en || '').join(' || '),
    do_not_reasons: (out.advice?.do_not || []).map(d => d.reason || '').join(' || '),
    differential_labels: (out.diagnosis?.differentials || []).map(d => d.label || '').join(' || '),
    differential_reasons: (out.diagnosis?.differentials || []).map(d => d.ruled_out_because || '').join(' || '),
    question_asks: (out.triage?.questions || []).map(q => q.ask_en || '').join(' || ')
  };

  const hasContent = Object.values(batch).some(v => v && v.length > 2);
  if (!hasContent) return out;

  let t;
  try { t = await translateBatch(batch); }
  catch (e) { console.error(`  translate failed for ${ep.episode_id}: ${e.message}`); return out; }

  if (out.context && t.chief_complaint) out.context.chief_complaint_sw = t.chief_complaint;
  if (out.diagnosis?.primary && t.primary_label) out.diagnosis.primary.label_sw = t.primary_label;
  if (out.diagnosis && t.confidence_basis) out.diagnosis.confidence_basis_sw = t.confidence_basis;
  if (out.escalation && t.escalation_trigger) out.escalation.trigger_sw = t.escalation_trigger;
  if (out.escalation && t.escalation_referral) out.escalation.referral_sw = t.escalation_referral;
  if (out.follow_up && t.follow_up_success) out.follow_up.success_indicator_sw = t.follow_up_success;
  if (out.fact_body && t.fact_answer) out.fact_body.answer_sw = t.fact_answer;
  if (out.refusal && t.refusal_reason) out.refusal.reason_sw = t.refusal_reason;

  const splitTranslated = (val) => val ? val.split(' || ') : [];
  const imm = splitTranslated(t.immediate_actions);
  (out.advice?.immediate || []).forEach((a, i) => { if (imm[i]) a.action_sw = imm[i]; });
  const prev = splitTranslated(t.preventive_actions);
  (out.advice?.preventive || []).forEach((a, i) => { if (prev[i]) a.action_sw = prev[i]; });
  const dnt = splitTranslated(t.do_not_texts);
  const dnr = splitTranslated(t.do_not_reasons);
  (out.advice?.do_not || []).forEach((d, i) => {
    if (dnt[i]) d.text_sw = dnt[i];
    if (dnr[i]) d.reason_sw = dnr[i];
  });
  const dfl = splitTranslated(t.differential_labels);
  const dfr = splitTranslated(t.differential_reasons);
  (out.diagnosis?.differentials || []).forEach((d, i) => {
    if (dfl[i]) d.label_sw = dfl[i];
    if (dfr[i]) d.ruled_out_because_sw = dfr[i];
  });
  const qas = splitTranslated(t.question_asks);
  (out.triage?.questions || []).forEach((q, i) => { if (qas[i]) q.ask_sw = qas[i]; });

  return out;
}

async function processFile(inPath, outPath) {
  console.log(`\n[translate] ${inPath} -> ${outPath}`);
  const raw = await readFile(inPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const done = await exists(outPath)
    ? new Set((await readFile(outPath, 'utf-8')).split('\n').filter(l => l.trim()).map(l => JSON.parse(l).episode_id))
    : new Set();

  const results = [];
  let processed = 0;

  for (const line of lines) {
    const ep = JSON.parse(line);
    if (done.has(ep.episode_id)) { results.push(line); continue; }
    try {
      const translated = await translateEpisode(ep);
      results.push(JSON.stringify(translated));
      processed++;
      if (processed % 25 === 0) {
        console.log(`  ${processed} new / ${lines.length - done.size} remaining`);
        await writeFile(outPath, results.join('\n') + '\n', 'utf-8');
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`  FAILED ${ep.episode_id}: ${e.message}`);
      results.push(line);
    }
  }

  await writeFile(outPath, results.join('\n') + '\n', 'utf-8');
  console.log(`[translate] done: ${processed} new, ${done.size} existing, ${lines.length} total`);
}

await processFile('data/advisory_episodes.train.jsonl', 'data/advisory_episodes.sw.jsonl');
await processFile('data/gold_diagnostics.jsonl', 'data/gold_diagnostics.sw.jsonl');
console.log('\n[translate] complete');