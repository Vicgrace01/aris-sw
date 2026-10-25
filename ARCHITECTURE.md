# Architecture

ARIS-SW is a three-layer system: a voice frontend, a reasoning agent, and a grounded dataset. Each layer can be swapped independently.

## Layer diagram

```
┌──────────────────────────────────────────────────────────┐
│ Browser (public/index.html + app.js)                     │
│ • Records Swahili audio (MediaRecorder → WAV)            │
│ • Renders bilingual advisory (SW/EN toggle)              │
│ • Plays Swahili TTS response                             │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTP/JSON
┌──────────────────────▼───────────────────────────────────┐
│ Express server (server.js)                               │
│ • /api/chat — session-aware reasoning                    │
│ • /api/stt, /api/translate, /api/tts — NKENNEAi proxy    │
│ • /api/session/* — token-gated retrieval                 │
│ • /api/health — telemetry                                │
│ • middleware: helmet, cors, rate-limit, request-id       │
└──────────────────────┬───────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   ┌─────────┐   ┌──────────┐   ┌──────────┐
   │ NKENNEAi│   │   Groq   │   │ SQLite   │
   │ STT     │   │  Qwen    │   │ Sessions │
   │ TTS     │   │  3.8 27B │   │ + tokens │
   │ Trans.  │   │          │   │          │
   └─────────┘   └────┬─────┘   └──────────┘
                      │
                      ▼
                 ┌─────────────┐
                 │  Dataset    │
                 │ 2,448 eps   │
                 │ 7 gold diag │
                 └─────────────┘
```

## Data flow — one farmer turn

1. **Farmer speaks Swahili** into the browser mic.
2. **Browser records** as WebM via MediaRecorder, then decodes to raw PCM and re-encodes as `audio/wav` before upload (NKENNEAi accepts WAV but not WebM).
3. **`POST /api/stt`** → NKENNEAi Speech-to-Text (Swahili) → English text.
4. **`POST /api/chat`** with `{ sessionId?, input }`:
   - **Session lookup** — create (returns `sessionToken`) or resume from SQLite.
   - **Triage check** — if there are pending questions, this input is an answer.
   - **Few-shot selection** — 3 examples chosen deterministically by crop + symptom overlap. Diagnostic inputs hard-filtered to `diagnostic_episode` records only, so `fact_only` noise cannot crowd out gold examples.
   - **Groq reasoning** — Qwen 3.8 27B with system prompt + few-shots → JSON advisory (English only).
   - **Schema validation** — `validateAdvisory`. Retry once on failure with corrective prompt.
   - **Evidence-gated diagnosis enforcement** — full canonical match (score 15), short-name match (12), 2 keyword hits (5), or 3+ keyword hits (8) snap to a curated whitelist entry with `fact_ids` attached. A single keyword hit (score 1) or zero hits do **not** snap; the model's own label is preserved as `unconfirmed` with provenance cleared and a `field_confirmation` triage question queued.
   - **Confidence escalation on triage answers** — fires only when the answer contains (a) an affirmative word, (b) no negation, and (c) at least one specific evidence term from the discriminator pool. Bare "yes" without evidence does not bump. Negative answers do not bump.
   - **Translation** — NKENNEAi translate per-field with 900ms spacing and 3-attempt retry. Curated Swahili map covers 22+ common diagnosis and advice strings (0-token path). Sanity check rejects runaway generation and token loops. On failure, English fallback with `EN` marker.
   - **Persist** — advisory saved to session, input cached to disk by hash.
5. **Browser renders** the bilingual card. Triage buttons appear if pending questions.
6. **`POST /api/tts`** → NKENNEAi Text-to-Speech → Swahili audio. Parenthetical scientific names stripped before send (TTS engines break on `(Spodoptera frugiperda)`). Failure renders a disabled play button rather than omitting it.

## Design decisions

| Decision | Rationale |
|---|---|
| **English-only output from Groq** | Groq produces the reasoning and structure in English. Swahili is rendered downstream by a dedicated translation step with a curated map + NKENNEAi fallback. Asking Groq for bilingual output was tried and produced inconsistent Swahili and increased token cost by 2×. |
| **Curated Swahili map for diagnoses and safety advice** | Machine translation of plant pathology terms is unreliable. `Fall armyworm` became `Kuku wa mahindi` ("chickens of maize") in one run; `Spodoptera frugiperda` triggered a 30-repetition token loop in another. 22+ diagnosis and advice strings come from a hand-verified map. Zero API calls, zero nonsense in the most visible fields. |
| **Per-field translation with retry and cache** | Batched translation with a ` ||| ` separator was attempted and rejected — the API returns a single translated paragraph with the separators removed, breaking field attribution. Per-field with 900ms spacing, 3-attempt exponential backoff, and a content-hash cache is what ships. |
| **Evidence-gated diagnosis matching** | Groq occasionally invents labels. A first version of enforcement snapped to the first whitelist entry on any match; a second version snapped on a single ambiguous keyword ("whorl" → FAW). Both were wrong. Current version requires canonical label, short-name, or 2+ distinct keyword hits. Everything weaker is preserved as `unconfirmed` with provenance cleared and a confirmation question. |
| **Confidence escalation requires evidence** | A bare "yes" is not diagnostic evidence. The three-condition rule (affirmative + evidence term + no negation) is what prevents "yes" from promoting an unsupported diagnosis. Negative answers ("no, I don't see frass") must never bump. |
| **Disk cache for Groq responses** | Repeat demo inputs cost 0 tokens. Cache key includes `CACHE_VERSION`, `PROMPT_VERSION`, and `MODEL`, so prompt edits or model changes invalidate stale entries automatically. Persistence survives restart. |
| **SQLite for sessions** | Zero external dependencies; synchronous API; WAL mode handles concurrent reads. On Render free tier, the DB resets on redeploy — acceptable for a demo, must move to a managed DB for production. |
| **Session bearer tokens** | `POST /api/chat` returns a `sessionToken` on new session creation. `GET /api/session/:id` and `POST /api/session/:id/close` require `Authorization: Bearer <token>`. `/api/chat` itself accepts just `sessionId` so conversation continuation is frictionless — see REPORT.md §12 for the trade-off. |
| **Rate limit 30 req/min/IP** | Reasonable for a demo; configurable via `RATE_LIMIT_MAX`. On Render deployment, set to 60 to give judges headroom. |
| **Groq free tier** | Constrains cost; production should use Dev Tier or self-host. OTPM ceiling (1,000/min) requires `max_tokens: 400` and 429-retry-with-backoff handling. |
| **Budget guard (`TOKEN_BUDGET_FLOOR=200`)** | When NKENNEAi balance drops below floor, `assertBudget` throws before any API call. App degrades to English-only rather than erroring. Public testing cannot exhaust the allocation. |

## Why these APIs

| API | Endpoint | Role |
|---|---|---|
| NKENNEAi STT | `/api/stt/v1/swahili/with-api-key` | Swahili voice transcription. Only Swahili ASR endpoint available for this event. |
| NKENNEAi TTS | `/api/tts/v1/swahili/with-api-key` | Natural Swahili voice output. Audio is played back inline in the chat. |
| NKENNEAi Translation | `/api/translate/with-api-key` | Fills `_sw` fields when curated map doesn't cover them. Per-field with retry and content-hash cache. |
| Groq (Qwen) | `/chat/completions` | Fast, free, structured JSON output with `response_format: json_object`. Reasoning only — no Swahili. |

## Extension points

- **Swap reasoning model**: replace `lib/groq.js` with any LLM that returns JSON. Interface is `reason(input) → { advisory }`. Cache and prompt versioning are handled inside `lib/groq.js`; a replacement must handle its own retry and cache.
- **Swap STT/TTS**: replace `lib/nkenne.js` with OpenAI Whisper + ElevenLabs. Interface is `stt(buffer) → {text}`, `tts(text) → {audio, contentType}`. The WAV encoding happens client-side in `public/app.js` before upload.
- **Add a diagnosis to the whitelist**: extend `VALID_DIAGNOSES` in `lib/diagnosis-validator.js` with a `canonical` label, Swahili `sw` label, at least 2 distinguishing `keywords`, `factIds`, and `sources`. Add a matching gold record to `data/gold_diagnostics.jsonl` so the few-shot selector can retrieve it. Add a test in `test/diagnosis-validator.test.js`.
- **Add a fact ledger**: drop `data/fact_ledger.jsonl`, add a retrieval step in `lib/agent.js` before reasoning, and modify `translateAdvisory`/`enforceDiagnosis` to require retrieved-fact support for every claim. This is the largest remaining structural change — documented in REPORT.md §16.1.
- **Add a new language**: update `lib/translator.js` map with the target language's strings, replace the STT/TTS endpoint slugs in `lib/nkenne.js`, and extend the curated label map. NKENNEAi only supports Swahili for this event; other languages are pending API availability.

## Security model

- **API keys** live in `.env`, never in code, never in the frontend bundle, never committed to git. `.gitignore` excludes all `.env*` except `.env.example`.
- **Helmet** sets standard security headers (CSP disabled for TTS audio blobs — required for in-browser playback).
- **Rate limiting** per IP via `express-rate-limit`. `RateLimit-*` headers exposed so clients can back off.
- **Session ownership tokens** required on `GET /api/session/:id` and `POST /api/session/:id/close`. Chat continuation is not token-gated (documented trade-off in REPORT.md §12).
- **Request IDs** generated per request, returned in `X-Request-Id` header, included in every log line for correlation.
- **Structured logs** via pino — JSON in production, pretty in dev. Internal error details are logged server-side only; public responses carry `error`, `message`, `requestId`, never the raw exception.
- **No user accounts** — no passwords, no password reset flow, no account takeover surface. Session IDs are ephemeral and rotatable.
- **Budget guard** — `assertBudget` prevents outbound NKENNEAi calls when balance is below `TOKEN_BUDGET_FLOOR`. Public users cannot trigger cost overruns.
- **No PII** beyond the farmer's typed or transcribed input. No user identity is stored. Session IDs and tokens are random, not derived from user attributes.
- **Deployment note**: on Render free tier, `data/sessions.db` and `data/groq-cache.jsonl` reset on redeploy. Not a security issue but relevant to uptime and cache behavior.
