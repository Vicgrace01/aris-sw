import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || v === 'placeholder') throw new Error(`Missing or placeholder required env var: ${name}`);
  return v;
}
function optional(name, fallback) { return process.env[name] ?? fallback; }
function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const env = optional('NODE_ENV', 'development');

export const config = Object.freeze({
  env,
  isProd: env === 'production',
  port: int('PORT', 3000),

  nkenne: Object.freeze({
    apiKey: required('NKENNE_API_KEY'),
    baseUrl: optional('NKENNE_BASE_URL', 'https://developers-api.nkenne.ai'),
    timeoutMs: int('NKENNE_TIMEOUT_MS', 30000),
  }),

  groq: Object.freeze({
    apiKey: required('GROQ_API_KEY'),
    baseUrl: optional('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
    model: optional('GROQ_MODEL', 'qwen/qwen3.8-27b'),
    maxOutputTokens: int('GROQ_MAX_OUTPUT_TOKENS', 400),
    timeoutMs: int('GROQ_TIMEOUT_MS', 60000),
  }),

  rateLimit: Object.freeze({
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60000),
    max: int('RATE_LIMIT_MAX', 30),
  }),

  cors: Object.freeze({
    origin: optional('CORS_ORIGIN', '*'),
  }),

  log: Object.freeze({
    level: optional('LOG_LEVEL', 'info'),
  }),

  dataset: Object.freeze({
    episodesPath: optional('DATASET_EPISODES_PATH', 'data/advisory_episodes.train.jsonl'),
    goldPath: optional('DATASET_GOLD_PATH', 'data/gold_diagnostics.jsonl'),
    swahiliPath: optional('DATASET_SWAHILI_PATH', 'data/advisory_episodes.sw.jsonl'),
    swahiliGoldPath: optional('DATASET_SWAHILI_GOLD_PATH', 'data/gold_diagnostics.sw.jsonl'),
    factLedgerPath: optional('DATASET_FACT_LEDGER_PATH', 'data/fact_ledger.jsonl'),
  }),

  paths: Object.freeze({
    sessionDb: optional('SESSION_DB_PATH', 'data/sessions.db'),
    groqCache: optional('GROQ_CACHE_PATH', 'data/groq-cache.jsonl'),
  }),
});