import { writeFile } from 'node:fs/promises';

const API_KEY = process.env.NKENNE_API_KEY;
const BASE = process.env.NKENNE_BASE_URL || 'https://developers-api.nkenne.ai';
const LOG_PATH = './TOKEN_LOG.md';
const BUDGET_FLOOR = Number(process.env.TOKEN_BUDGET_FLOOR || 200);

let calls = [];
let totalTokensUsed = 0;
let lastTokensRemaining = null;
let blockedCalls = 0;

function logCall(entry) {
  const record = { ...entry, timestamp: new Date().toISOString() };
  calls.push(record);
  if (record.tokensUsed) totalTokensUsed += record.tokensUsed;
}

function budgetExhausted() {
  return lastTokensRemaining !== null && lastTokensRemaining < BUDGET_FLOOR;
}

function assertBudget(op) {
  if (budgetExhausted()) {
    blockedCalls++;
    throw new Error(`TOKEN_BUDGET_EXHAUSTED (${op}): ${lastTokensRemaining} left, floor ${BUDGET_FLOOR}`);
  }
}

export function getBudgetStatus() {
  return {
    floor: BUDGET_FLOOR,
    lastTokensRemaining,
    exhausted: budgetExhausted(),
    blockedCalls,
  };
}

export async function stt(audioBuffer, mimeType = 'audio/wav') {
  assertBudget('stt');
  const form = new FormData();
  form.append('audio_file', new Blob([audioBuffer], { type: mimeType }), 'input.wav');

  const res = await fetch(`${BASE}/api/stt/v1/swahili/with-api-key`, {
    method: 'POST',
    headers: { Authorization: API_KEY },
    body: form,
  });
  const data = await res.json();
  logCall({ endpoint: 'stt/swahili', ok: res.ok });
  if (!res.ok) throw new Error(data.error || 'STT failed');
  return { text: data.text, duration: data.duration };
}

export async function translate(text, from = 'English', to = 'Swahili') {
  assertBudget('translate');
  const res = await fetch(`${BASE}/api/translate/with-api-key`, {
    method: 'POST',
    headers: { Authorization: API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, fromLanguage: from, toLanguage: to }),
  });
  const data = await res.json();
  const tokensUsed = data.tokensUsed || 0;
  if (data.tokensRemaining != null) lastTokensRemaining = data.tokensRemaining;
  logCall({ endpoint: `translate ${from}->${to}`, ok: res.ok, tokensUsed, tokensRemaining: data.tokensRemaining });
  if (!res.ok) throw new Error(data.error || 'Translation failed');
  return { text: data.translated_text || data.translatedText, tokensRemaining: data.tokensRemaining };
}

export async function tts(text) {
  assertBudget('tts');
  const res = await fetch(`${BASE}/api/tts/v1/swahili/with-api-key`, {
    method: 'POST',
    headers: { Authorization: API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speaking_rate: 1.0 }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    logCall({ endpoint: 'tts/swahili', ok: false });
    throw new Error(err.error || 'TTS failed');
  }
  const audio = Buffer.from(await res.arrayBuffer());
  logCall({ endpoint: 'tts/swahili', ok: true });
  return { audio, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

export async function writeLog() {
  const budget = getBudgetStatus();
  const lines = [
    '# Token Usage Log — ARIS-SW',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Total NKENNEAi calls this session: ${calls.length}`,
    `Total tokens tracked: ${totalTokensUsed}`,
    `Last known tokens remaining: ${lastTokensRemaining ?? 'unknown'}`,
    `Budget floor: ${budget.floor} · exhausted: ${budget.exhausted} · blocked calls: ${budget.blockedCalls}`,
    '',
    '## Session calls',
    '',
    '| Time | Endpoint | Tokens | Status |',
    '|---|---|---|---|',
  ];
  for (const c of calls) {
    lines.push(`| ${c.timestamp} | ${c.endpoint} | ${c.tokensUsed ?? '—'} | ${c.ok ? 'OK' : 'FAIL'} |`);
  }
  await writeFile(LOG_PATH, lines.join('\n') + '\n', 'utf-8');
}

export function getSessionStats() {
  return { calls: calls.length, tokensTracked: totalTokensUsed, lastTokensRemaining, budget: getBudgetStatus() };
}