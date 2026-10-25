import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';

const API_KEY = config.nkenne.apiKey;
const BASE = config.nkenne.baseUrl;
const MOCK = config.nkenne.mock;
const LOG_PATH = './TOKEN_LOG.md';
const BUDGET_FLOOR = Number(process.env.TOKEN_BUDGET_FLOOR || 200);

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let calls = [];
let totalTokensUsed = 0;
let lastTokensRemaining = null;
let blockedCalls = 0;

function logCall(entry) {
  const record = { ...entry, timestamp: new Date().toISOString(), mock: MOCK };
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
  return { floor: BUDGET_FLOOR, lastTokensRemaining, exhausted: budgetExhausted(), blockedCalls, mock: MOCK };
}

function silentWav(durationSec = 2) {
  const sampleRate = 16000;
  const numSamples = sampleRate * durationSec;
  const dataLength = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

export async function stt(audioBuffer, mimeType = 'audio/wav') {
  if (MOCK) {
    logCall({ endpoint: 'stt/swahili [MOCK]', ok: true, tokensUsed: 0 });
    return { text: 'Mahindi yangu yana matundu kwenye majani', duration: 3.0 };
  }

  assertBudget('stt');
  const form = new FormData();
  form.append('audio_file', new Blob([audioBuffer], { type: mimeType }), 'input.wav');

  const res = await fetch(`${BASE}/api/stt/v1/swahili/with-api-key`, {
    method: 'POST',
    headers: { Authorization: API_KEY, 'User-Agent': BROWSER_UA },
    body: form,
  });
  const data = await res.json();
  logCall({ endpoint: 'stt/swahili', ok: res.ok });
  if (!res.ok) throw new Error(data.error || 'STT failed');
  return { text: data.text, duration: data.duration };
}

async function translateOnce(text, from, to) {
  assertBudget('translate');
  const res = await fetch(`${BASE}/api/translate/with-api-key`, {
    method: 'POST',
    headers: {
      Authorization: API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_UA
    },
    body: JSON.stringify({ text, fromLanguage: from, toLanguage: to }),
  });

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    return { nonJson: true, status: res.status };
  }

  const data = await res.json();
  if (data.tokensRemaining != null) lastTokensRemaining = data.tokensRemaining;
  logCall({
    endpoint: `translate ${from}->${to}`,
    ok: res.ok,
    tokensUsed: data.tokensUsed || 0,
    tokensRemaining: data.tokensRemaining
  });
  if (!res.ok) throw new Error(data.error || 'Translation failed');
  return { text: data.translated_text || data.translatedText, tokensRemaining: data.tokensRemaining };
}

export async function translate(text, from = 'English', to = 'Swahili', attempt = 1) {
  if (MOCK) {
    logCall({ endpoint: `translate ${from}->${to} [MOCK]`, ok: true, tokensUsed: 0 });
    return { text: '', tokensRemaining: null };
  }

  let result;
  try {
    result = await translateOnce(text, from, to);
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1200 * attempt));
      return translate(text, from, to, attempt + 1);
    }
    throw e;
  }

  if (result.nonJson) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1200 * attempt));
      return translate(text, from, to, attempt + 1);
    }
    throw new Error(`Non-JSON response from NKENNEAi (HTTP ${result.status})`);
  }

  return { text: result.text, tokensRemaining: result.tokensRemaining };
}

export async function tts(rawText, attempt = 1) {
  if (MOCK) {
    logCall({ endpoint: 'tts/swahili [MOCK]', ok: true, tokensUsed: 0 });
    return { audio: silentWav(2), contentType: 'audio/wav' };
  }

  assertBudget('tts');
  const text = String(rawText || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('TTS text is empty after cleaning');

  const res = await fetch(`${BASE}/api/tts/v1/swahili/with-api-key`, {
    method: 'POST',
    headers: {
      Authorization: API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_UA
    },
    body: JSON.stringify({ text, speaking_rate: 1.0 }),
  });
  if (!res.ok) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return tts(rawText, attempt + 1);
    }
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
    `Mode: ${MOCK ? 'MOCK (no NKENNEAi network calls)' : 'LIVE'}`,
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