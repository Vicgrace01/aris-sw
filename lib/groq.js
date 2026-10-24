import { selectFewShots } from './dataset.js';
import { validateAdvisory } from './schema-validator.js';
import { translateAdvisory, getTranslationCacheStats } from './translator.js';
import { enforceDiagnosis, bumpConfidenceOnAnswer } from './diagnosis-validator.js';
import { logger } from './logger.js';
import { config } from '../config.js';
import { readFile, appendFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const CACHE_FILE = path.resolve(process.cwd(), config.paths.groqCache);
mkdirSync(path.dirname(CACHE_FILE), { recursive: true });

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = config.groq.model;
const MAX_OUTPUT_TOKENS = config.groq.maxOutputTokens;
const MAX_RETRIES = 5;
const FETCH_TIMEOUT_MS = config.groq.timeoutMs;
const CACHE_TTL_MS = 60 * 60 * 1000;

const CACHE_VERSION = 4;
const PROMPT_VERSION = '2.2.0';

const responseCache = new Map();

function cacheKey(input) {
  return [
    `v${CACHE_VERSION}`,
    `p${PROMPT_VERSION}`,
    MODEL,
    input.trim().toLowerCase().replace(/\s+/g, ' ')
  ].join('|');
}

let diskCacheReady = (async () => {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8');
    let loaded = 0;
    let skipped = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry.key || !entry.value) continue;
        const prefix = `v${CACHE_VERSION}|p${PROMPT_VERSION}|${MODEL}|`;
        if (!entry.key.startsWith(prefix)) { skipped++; continue; }
        responseCache.set(entry.key, { value: entry.value, timestamp: entry.timestamp });
        loaded++;
      } catch {}
    }
    if (loaded > 0 || skipped > 0) {
      logger.info('groq.cache.loaded', { entries: loaded, invalidated: skipped, path: CACHE_FILE });
    }
  } catch { /* no cache file yet */ }
})();

async function persistCacheEntry(key, value) {
  try {
    await appendFile(CACHE_FILE, JSON.stringify({ key, value, timestamp: Date.now() }) + '\n', 'utf-8');
  } catch (e) {
    logger.warn('groq.cache.persist_failed', { error: e.message });
  }
}

function cacheGet(input) {
  const key = cacheKey(input);
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(input, value) {
  const key = cacheKey(input);
  responseCache.set(key, { value, timestamp: Date.now() });
  persistCacheEntry(key, value);
  if (responseCache.size > 500) responseCache.delete(responseCache.keys().next().value);
}

export function getCacheStats() {
  return {
    size: responseCache.size,
    persistent: true,
    path: CACHE_FILE,
    cacheVersion: CACHE_VERSION,
    promptVersion: PROMPT_VERSION,
    model: MODEL,
    translation: getTranslationCacheStats()
  };
}

const SYSTEM_PROMPT = `You are ARIS-SW, a Swahili-speaking agricultural extension officer serving smallholder farmers in East Africa.

You have:
- No internet access
- No live weather data
- No camera
- No live market prices
- No ability to prescribe veterinary treatment or pesticide doses

You answer strictly from verified agricultural sources (IITA, NAERLS, NRCRI, NCRI, NIHORT, NSPRI, NAPRI, NVRI, FMARD, NiMet, ADP).

LANGUAGE: Reason internally in English. Produce ALL output fields in ENGLISH ONLY. Swahili is added downstream by a separate translation service.

GROUNDING RULE (STRICT): The diagnosis label MUST be EXACTLY one of the labels present in the examples below. Do NOT invent any label. Copy the label character-for-character from one of the examples.

FEW-SHOT USAGE: The examples below are all diagnostic episodes. Your output must follow the structure of one of them. If the farmer's description matches the symptoms of one example, use that example's diagnosis as your primary label. Do NOT introduce a diagnosis from outside the examples. If symptoms describe a condition not represented in the examples, set record_kind to "refusal" with category "insufficient_info" and explain that a field visit is required.

CONFIDENCE RULES:
- "unconfirmed": no discriminators answered yet
- "possible": one discriminator answered but ambiguous
- "likely": multiple signs point to this diagnosis
- "confirmed": farmer EXPLICITLY confirmed a definitive sign (saw frass -> FAW; saw diamond-spot caterpillar -> FAW; saw lower-stem tunneling -> stem borer; saw yellow mosaic on cassava -> CMD)

BE CONCISE: one short sentence per field. Max 2 items per array (except policy_trace = exactly 5). Keep total JSON under 350 tokens.

REQUIRED JSON STRUCTURE (English only):
{
  "record_kind": "diagnostic_episode",
  "language": "en",
  "channel": "voice",
  "context": { "crop": "<crop>", "growth_stage": "<stage or null>", "chief_complaint_en": "<one sentence>" },
  "triage": {
    "observed_signs": ["<sign>"],
    "missing_discriminators": ["<field>"],
    "questions": [{ "field": "<snake_case>", "ask_en": "<question>", "why": "<one sentence>" }]
  },
  "diagnosis": {
    "primary": { "label": "<exactly from examples>", "confidence": "confirmed|likely|possible|unconfirmed" },
    "differentials": [{ "label": "<exactly from examples>", "ruled_out_because": "<one sentence>" }],
    "confidence_basis": "<one sentence>"
  },
  "advice": {
    "immediate": [{ "action_en": "<action>", "timeframe": "today" }],
    "preventive": [{ "action_en": "<action>", "timeframe": "next season" }],
    "do_not": [{ "text_en": "<what NOT to do>", "reason": "<one sentence>" }]
  },
  "escalation": { "trigger_en": "<threshold>", "referral": "<who>", "urgency": "low|medium|high" },
  "provenance": { "fact_ids": [], "source_names": ["IITA", "NAERLS"] },
  "policy_trace": [
    { "step": "intake", "action": "set_context" },
    { "step": "triage", "action": "ask_clarification" },
    { "step": "diagnose", "action": "commit_likely" },
    { "step": "advise", "action": "emit_advice" },
    { "step": "close", "action": "schedule_follow_up" }
  ]
}

If the query is out of scope (medical, live market data, non-agricultural), set record_kind to "refusal" and populate refusal.reason_en and refusal.category.

Respond with a SINGLE valid JSON object. No prose. No markdown fences.`;

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function safeParseJson(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty response from Groq');
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*\n?/i, '').replace(/```\s*$/, '').trim();
  }
  try { return JSON.parse(t); } catch {}
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(t.substring(first, last + 1)); } catch {}
  }
  throw new Error(`Invalid JSON in Groq response: ${text.substring(0, 200)}`);
}

function applyDefensiveDefaults(advisory) {
  if (!isPlainObject(advisory)) return advisory;
  if (!Array.isArray(advisory.policy_trace) || advisory.policy_trace.length === 0) {
    advisory.policy_trace = [
      { step: 'intake', action: 'set_context' },
      { step: 'triage', action: 'ask_clarification' },
      { step: 'diagnose', action: 'commit_likely' },
      { step: 'advise', action: 'emit_advice' },
      { step: 'close', action: 'schedule_follow_up' }
    ];
  }
  if (!isPlainObject(advisory.provenance) || !Array.isArray(advisory.provenance.source_names)) {
    advisory.provenance = { fact_ids: [], source_names: ['IITA', 'NAERLS'] };
  } else if (!Array.isArray(advisory.provenance.fact_ids)) {
    advisory.provenance.fact_ids = [];
  }
  if (!isPlainObject(advisory.escalation) || !advisory.escalation.trigger_en) {
    advisory.escalation = {
      ...(advisory.escalation || {}),
      trigger_en: 'If symptoms spread to more than 20% of plants, contact your extension officer.',
      referral: (advisory.escalation && advisory.escalation.referral) || 'Contact your local agricultural extension officer.',
      urgency: (advisory.escalation && advisory.escalation.urgency) || 'medium'
    };
  }
  if (advisory.record_kind === 'diagnostic_episode') {
    if (!isPlainObject(advisory.advice)) advisory.advice = {};
    if (!Array.isArray(advisory.advice.do_not) || advisory.advice.do_not.length === 0) {
      advisory.advice.do_not = [{
        text_en: 'Do not apply any pesticide without a confirmed diagnosis and a registered product recommendation.',
        reason: 'Unverified dosage is the highest-risk failure mode.'
      }];
    }
    if (!Array.isArray(advisory.advice.immediate)) advisory.advice.immediate = [];
    if (!Array.isArray(advisory.advice.preventive)) advisory.advice.preventive = [];
  }
  if (!isPlainObject(advisory.context)) advisory.context = { crop: null, growth_stage: null, chief_complaint_en: '' };
  if (!isPlainObject(advisory.triage)) advisory.triage = { observed_signs: [], missing_discriminators: [], questions: [] };
  if (!Array.isArray(advisory.triage.questions)) advisory.triage.questions = [];
  if (!Array.isArray(advisory.triage.missing_discriminators)) advisory.triage.missing_discriminators = [];
  if (!Array.isArray(advisory.triage.observed_signs)) advisory.triage.observed_signs = [];
  return advisory;
}

function extractRetrySeconds(text) {
  const m = String(text).match(/try again in ([\d.]+)s/);
  return m ? Math.min(30, Math.ceil(parseFloat(m[1])) + 1) : 8;
}

async function callGroqOnce(messages, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${config.groq.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.1,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const cause = err.cause || {};
    logger.warn('groq.fetch_error', {
      attempt, message: err.message, name: err.name,
      code: cause.code, errno: cause.errno, syscall: cause.syscall, hostname: cause.hostname
    });

    if (attempt < MAX_RETRIES) {
      const backoff = Math.min(30, Math.pow(2, attempt - 1) * 2);
      logger.info('groq.retrying', { attempt, backoffSec: backoff });
      await new Promise(r => setTimeout(r, backoff * 1000));
      return callGroqOnce(messages, attempt + 1);
    }

    if (err.name === 'AbortError') throw new Error(`Groq request timed out after ${FETCH_TIMEOUT_MS}ms (after ${attempt} attempts)`);
    throw new Error(`Groq network error: ${err.message} (${cause.code || 'no-code'}) after ${attempt} attempts`);
  }
  clearTimeout(timer);

  if (res.status === 429) {
    const text = await res.text();
    if (attempt >= MAX_RETRIES) throw new Error(`Groq rate limit (gave up after ${MAX_RETRIES} retries)`);
    const waitSec = extractRetrySeconds(text);
    logger.warn('groq.429', { attempt, waitSec });
    await new Promise(r => setTimeout(r, waitSec * 1000));
    return callGroqOnce(messages, attempt + 1);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data?.error?.message) || `Groq HTTP ${res.status}`);
  }
  if (!data) throw new Error('Groq returned non-JSON body');

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const summary = JSON.stringify(data).substring(0, 300);
    throw new Error(`Groq returned empty content. Body: ${summary}`);
  }
  return content;
}

export async function reason(inputText, { isTriageAnswer = false, farmerAnswer = null } = {}) {
  await diskCacheReady;

  const cached = !isTriageAnswer ? cacheGet(inputText) : null;
  if (cached) {
    logger.info('groq.cache.hit');
    return { ...cached, cached: true };
  }

  const selection = selectFewShots(inputText, 3);
  const { fewShots, detectedLang, detectedCrop } = selection;

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const shot of fewShots) {
    messages.push({ role: 'user', content: shot.user });
    messages.push({ role: 'assistant', content: shot.assistant });
  }
  messages.push({ role: 'user', content: inputText });

  const raw = await callGroqOnce(messages);

  let parsed;
  try { parsed = safeParseJson(raw); }
  catch (e) { throw new Error(`Groq returned invalid JSON: ${e.message}`); }

  if (!isPlainObject(parsed)) {
    const t = Array.isArray(parsed) ? 'array' : String(parsed);
    throw new Error(`Groq returned non-object JSON (${t}): ${String(raw).substring(0, 200)}`);
  }

  parsed = applyDefensiveDefaults(parsed);

  let check = validateAdvisory(parsed);

  if (!check.valid) {
    logger.warn('groq.validation.retry', { errors: check.errors });

    const retryMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...fewShots.flatMap(s => [
        { role: 'user', content: s.user },
        { role: 'assistant', content: s.assistant }
      ]),
      { role: 'user', content: inputText },
      { role: 'assistant', content: raw },
      { role: 'user', content: `Fix ALL of these errors:\n${check.errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nReturn ONLY the corrected JSON object. No prose.` }
    ];

    const retryRaw = await callGroqOnce(retryMessages);

    try { parsed = safeParseJson(retryRaw); }
    catch (e) { throw new Error(`Groq retry invalid JSON: ${e.message}. Original errors: ${check.errors.join('; ')}`); }

    if (!isPlainObject(parsed)) {
      throw new Error(`Groq retry returned non-object JSON. Original errors: ${check.errors.join('; ')}`);
    }

    parsed = applyDefensiveDefaults(parsed);
    check = validateAdvisory(parsed);

    if (!check.valid) {
      throw new Error(`Schema failed after retry: ${check.errors.join('; ')}`);
    }
  }

  const crop = isPlainObject(parsed.context) ? parsed.context.crop : null;
  const enforcement = enforceDiagnosis(parsed, crop);
  if (enforcement.enforced) {
    logger.warn('diagnosis.enforcement', {
      matched: !!enforcement.matched,
      unsupported: !!enforcement.unsupported,
      before: enforcement.before,
      after: enforcement.after,
      fromDifferential: !!enforcement.fromDifferential
    });
  }

  if (isTriageAnswer && farmerAnswer) {
    const bump = bumpConfidenceOnAnswer(parsed, farmerAnswer);
    if (bump.bumped) logger.info('confidence.bumped', { before: bump.before, after: bump.after });
  }

  let translationInfo = { cached: false };
  if (parsed.record_kind === 'diagnostic_episode' || parsed.record_kind === 'fact_only') {
    translationInfo = await translateAdvisory(parsed);
  }

  const result = {
    advisory: parsed,
    retried: check.valid === false,
    fewShotsUsed: fewShots.length,
    selectionMode: selection.selectionMode,
    selectedExamples: selection.selectionTrace,
    detectedLang,
    detectedCrop,
    cached: false,
    translation: translationInfo,
    diagnosisEnforced: enforcement.matched === true,
    diagnosisUnsupported: enforcement.unsupported === true,
    cacheMeta: {
      cacheVersion: CACHE_VERSION,
      promptVersion: PROMPT_VERSION,
      model: MODEL
    }
  };

  if (!isTriageAnswer) cacheSet(inputText, result);
  return result;
}