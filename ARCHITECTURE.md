# Architecture

ARIS-SW is a three-layer system: a voice frontend, a reasoning agent, and a grounded dataset. Each layer can be swapped independently.

## Layer diagram
┌──────────────────────────────────────────────────────────┐
│ Browser (public/index.html + app.js) │
│ • Records Swahili audio (MediaRecorder) │
│ • Renders bilingual advisory (SW/EN toggle) │
│ • Plays Swahili TTS response │
└──────────────────────┬───────────────────────────────────┘
│ HTTP/JSON
┌──────────────────────▼───────────────────────────────────┐
│ Express server (server.js) │
│ • /api/chat — session-aware reasoning │
│ • /api/stt, /api/translate, /api/tts — NKENNEAi proxy │
│ • /api/health — telemetry │
│ • middleware: helmet, cors, rate-limit, request-id │
└──────────────────────┬───────────────────────────────────┘
│
┌──────────────┼──────────────┐
▼ ▼ ▼
┌─────────┐ ┌──────────┐ ┌──────────┐
│ NKENNEAi│ │ Groq │ │ SQLite │
│ STT │ │ Reason │ │ Sessions │
│ TTS │ │ (Qwen) │ │ │
│ Trans. │ │ │ │ │
└─────────┘ └────┬─────┘ └──────────┘
│
▼
┌─────────────┐
│ Dataset │
│ 2448 episodes│
│ 7 gold diags│
└─────────────┘

text

## Data flow — one farmer turn

1. **Farmer speaks Swahili** into the browser mic.
2. **Browser records** as `audio/wav` blob via MediaRecorder.
3. **`POST /api/stt`** → NKENNEAi Speech-to-Text (Swahili) → English text.
4. **`POST /api/chat`** with `{ sessionId?, input }`:
   - **Session lookup** — create or resume from SQLite.
   - **Triage check** — if there are pending questions, this input is an answer.
   - **Few-shot selection** — 3 examples chosen deterministically by crop + symptom overlap from the dataset.
   - **Groq reasoning** — Qwen 3.8 27B with system prompt + few-shots → JSON advisory (English).
   - **Schema validation** — `validateAdvisory`. Retry once on failure with corrective prompt.
   - **Diagnosis enforcement** — snap invented labels to the curated whitelist. Attach `fact_ids`.
   - **Confidence bump** — on triage answers, escalate confidence one level if the answer confirms a discriminator.
   - **Translation** — NKENNEAi translate per-field, with a curated Swahili map for diagnoses (0-token path for common cases).
   - **Persist** — advisory saved to the session, cached to disk by input hash.
5. **Browser renders** the bilingual card. Triage buttons appear if pending questions.
6. **`POST /api/tts`** → NKENNEAi Text-to-Speech → Swahili audio, played inline.

## Design decisions

| Decision | Rationale |
|---|---|
| **Bilingual output from Groq** | One call produces `_en` and `_sw` fields; avoids a second roundtrip |
| **Curated Swahili map for diagnoses** | Machine translation of plant pathology terms is unreliable; ground-truth wins for the visible field |
| **Per-field NKENNEAi translation** | Batches all translatable fields into one request; per-field cache reduces cost |
| **Diagnosis whitelist** | Groq occasionally invents labels; the whitelist is the last line of safety |
| **Bump confidence on triage** | The multi-turn flow should move a diagnosis forward when a discriminator is confirmed |
| **Disk cache for Groq responses** | Repeat demo inputs cost 0 tokens; persistence survives restart |
| **SQLite for sessions** | Zero external dependencies; synchronous API; WAL mode handles concurrent reads |
| **Rate limit 30 req/min/IP** | Reasonable for a demo; tune via `RATE_LIMIT_MAX` |
| **Groq free tier** | Constrains cost; production should use Dev Tier or self-host |

## Why these APIs

| API | Endpoint | Role |
|---|---|---|
| NKENNEAi STT | `/api/stt/v1/swahili/with-api-key` | Only Swahili STT that works offline-friendly |
| NKENNEAi TTS | `/api/tts/v1/swahili/with-api-key` | Natural Swahili voice output |
| NKENNEAi Translation | `/api/translate/with-api-key` | Fills `_sw` fields when curated map doesn't cover them |
| Groq (Qwen) | `/chat/completions` | Fast, free, structured output, reliable JSON |

## Extension points

- **Swap reasoning model**: replace `lib/groq.js` with any LLM that returns JSON; interface is `reason(input) → { advisory }`.
- **Swap STT/TTS**: replace `lib/nkenne.js` with OpenAI Whisper + ElevenLabs; interface is `stt(buffer)`, `tts(text)`.
- **Add crops**: extend `VALID_DIAGNOSES` in `lib/diagnosis-validator.js` and add gold records to `data/gold_diagnostics.jsonl`.
- **Add a fact ledger**: drop `data/fact_ledger.jsonl`, add a retrieval step in `lib/agent.js` before reasoning.

## Security model

- API keys live in `.env`, never in code or the frontend
- Helmet sets standard security headers
- Rate limiting per IP
- Request IDs for correlation in logs
- Structured logs via pino (JSON in prod, pretty in dev)
- No user accounts = no password storage, no PII beyond session text
- Sessions are ephemeral; purge by removing `data/sessions.db`