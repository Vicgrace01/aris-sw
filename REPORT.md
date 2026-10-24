# ARIS-SW Technical Report

**Swahili voice-first agricultural advisory — NKENNEAi API Hackathon 2026**

Author: Victor Chukwuebuka Nwaruwe (Vicgrace Labs)  
Repository: https://github.com/Vicgrace01/aris-sw  
Live: https://aris-sw.onrender.com

---

## 1. Executive summary

ARIS-SW is a voice-first agricultural advisor for Swahili-speaking smallholder farmers in East Africa. A farmer speaks a crop problem; the system transcribes, triages, diagnoses, and responds with a structured advisory — in English and Swahili, as text and audio.

The system integrates three NKENNEAi APIs (Speech-to-Text, Translation, Text-to-Speech) in the core request path and adds four engineering layers that make it production-shaped rather than a wrapper:

1. A **schema-validated advisory contract** with retry-on-failure
2. A **diagnosis whitelist** that snaps hallucinated labels to curated diagnoses and attaches provenance fact IDs
3. A **curated Swahili translation map** with a sanity check that rejects machine-translation garbage
4. A **token budget guard** that degrades gracefully to English-only rather than erroring in front of public users

The system was deployed on Render's free tier with a persistent SQLite session store, disk-cached Groq responses (0-token repeat inputs), and 33 automated tests that run without network calls.

**Deployment posture:** production-ready single service, ~180 MB container, cold-start ~30s on free tier, warm requests <200ms (excluding upstream API calls).

---

## 2. System architecture

### 2.1 Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (public/index.html + app.js)                       │
│  • MediaRecorder for Swahili voice capture                  │
│  • Bilingual SW/EN toggle (localStorage-persisted)          │
│  • Audio playback of TTS response                           │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTPS/JSON
┌─────────────────────────▼───────────────────────────────────┐
│  Express server (server.js)                                 │
│  • /api/chat — session-aware reasoning pipeline             │
│  • /api/stt, /api/translate, /api/tts — NKENNEAi proxies    │
│  • /api/health, /api/session/* — telemetry + persistence    │
│  • Middleware: helmet, cors, rate-limit, request-id         │
└─────────────────────────┬───────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ┌─────────┐      ┌──────────┐      ┌──────────┐
   │ NKENNEAi│      │   Groq   │      │ SQLite   │
   │ STT/TTS │      │  Qwen    │      │ Sessions │
   │ Translate      │  3.8 27B │      │          │
   └─────────┘      └────┬─────┘      └──────────┘
                         │
                         ▼
                    ┌─────────────┐
                    │  Dataset    │
                    │ 2,448 eps   │
                    │ 7 gold diag │
                    └─────────────┘
```

### 2.2 Request lifecycle

A single farmer turn touches the following subsystems:

1. **`POST /api/stt`** — NKENNEAi Speech-to-Text receives an `audio/wav` multipart body. Response: `{text, duration, language}`.
2. **`POST /api/chat`** with `{sessionId?, input}`:
   - **Session resolution** — SQLite lookup or new session creation (nanoid ID)
   - **Triage detection** — if `pending_triage` row exists for this session, the input is interpreted as an answer to the first queued question
   - **Augmented context** — original complaint + all prior triage answers prepended to the reasoning input
   - **Few-shot selection** — 3 examples chosen deterministically by crop + symptom term overlap
   - **Groq reasoning** — Qwen 3.8 27B with system prompt + few-shots → JSON advisory (English only)
   - **Schema validation** — retry once with corrective prompt on validation failure
   - **Diagnosis enforcement** — snap any invented label to the curated whitelist
   - **Confidence escalation** — bump one level if the input contains a confirmation discriminator
   - **Translation** — per-field via NKENNEAi, curated map preferred, sanity check on NKENNEAi output
   - **Persistence** — advisory written to session, input cached to disk by hash
3. **`POST /api/tts`** — NKENNEAi Text-to-Speech receives the Swahili advisory text and returns an `audio/mpeg` stream.

**Typical latency (warm):** 2.5–4s end-to-end from typing input to advice card render. Voice-in adds ~1.2s for STT.

---

## 3. NKENNEAi API integration — per-API deep dive

### 3.1 Speech-to-Text

**Endpoint:** `POST https://developers-api.nkenne.ai/api/stt/v1/swahili/with-api-key`

**Request shape:** multipart form-data with a single `audio_file` field (WAV/MP3/M4A/FLAC/OGG; max 25 MB).

**Response shape on success:** `{"text": string, "duration": number, "language": "swahili"}`

**Handling decisions:**

- The endpoint accepts only Swahili in the hackathon scope (documented constraint). Non-Swahili input will produce nonsense. This is a known limitation.
- 25 MB cap is a hard API ceiling. Browser MediaRecorder produces ~1 MB per 60 seconds of WAV at 24 kHz mono, so a 20-minute recording stays within the limit; longer recordings must be split. Not currently exposed in the UI — a production build would add a length guard before upload.
- Error paths handled: `400` (no `audio_file` field), `413` (payload too large), `401` (key invalid). All surface to the user as `{error: UPSTREAM_FAILED, message: string}` with the underlying NKENNEAi message preserved.
- **Token cost:** 1 STT call per voice turn. Typed input bypasses STT entirely — a deliberate cost control.

**Testing status:** Verified during development against recorded Swahili audio. Not exercised against field recordings (wind noise, dialect variation, background chicken noise) — a known limitation disclosed in §12.

### 3.2 Translation

**Endpoint:** `POST https://developers-api.nkenne.ai/api/translate/with-api-key`

**Request shape:** `{"text": string, "fromLanguage": "English", "toLanguage": "Swahili"}`

**Response shape on success:** `{"translatedText": string, "tokensRemaining": number, "message": string}`

Note: the actual response field is `translated_text` (snake case) despite the documentation showing `translatedText` (camel case). Our client normalises both — `data.translated_text || data.translatedText` — because the docs and the runtime disagree.

**Handling decisions:**

- **Batched translation.** All translatable fields from one advisory (diagnosis label, 1–2 immediate actions, 1–2 do_not items, escalation trigger, escalation referral) are concatenated with a delimiter and sent in **one** call. On a full advisory this is one request instead of five. Saves ~80% of translation tokens per turn.
- **Curated map first.** For the 16 most common diagnosis labels, no API call is made. The curated map guarantees accuracy (machine translation of scientific names produces unreliable output — see §8.2).
- **Sanity check on output.** After a successful API response, the translator runs three plausibility checks before accepting: output length must be under 4× input length; no word can repeat 4+ times; no 6-character substring can repeat within 15 characters. If any check fails, the field is left empty and the UI falls back to English with an `EN` superscript marker.
- **Sanitised input.** Scientific names in parentheses are stripped before sending (`Fall armyworm (Spodoptera frugiperda)` → `Fall armyworm`). The parenthetical form confuses the translator and produces token loops.
- **Per-field cache.** Translated strings are cached by content hash for 1 hour. The same "Do not apply any pesticide..." string appears in nearly every advisory — it's translated once and reused.

**Token cost:** ~40–60 tokens per batched advisory (as measured during development). Near-zero for repeat advisories due to per-field cache.

### 3.3 Text-to-Speech

**Endpoint:** `POST https://developers-api.nkenne.ai/api/tts/v1/swahili/with-api-key`

**Request shape:** `{"text": string, "speaking_rate": 1.0, "voice_name": optional}`

**Response shape on success:** binary `audio/mpeg` or `audio/wav` stream (24 kHz).

**Handling decisions:**

- Response is a binary stream, not JSON. Our client checks `res.ok` before buffering — a 400/401/404 returns JSON, and we parse that separately.
- Audio is cached as a Blob URL on the client and attached to the advice card as a play button. Each advisory gets its own audio; previous advisories keep their audio (no clobbering).
- Failure is non-fatal: if TTS fails, the advice card still renders. The play button just doesn't appear. Judges see a working card either way.
- `speaking_rate` fixed at 1.0 — the API range is 0.5–2.0, and a demo-tuned rate is out of scope for the hackathon. Exposed as a UI slider in production.

**Token cost:** ~150–250 tokens per advisory (longest text field of the three calls). This is why the budget guard exists.

### 3.4 The fourth NKENNEAi API — speech translation

Not used in the shipped build. NKENNEAi also offers `/api/st/v1/{pair}/with-api-key` (direct speech-to-translated-text). It would replace our `STT → reason → translate` chain with `ST → reason`, saving one API call per turn. Rejected because:

- It returns translated *text*, not a structured advisory. We still need the reasoning step.
- Our STT output needs to be in English for the reasoning layer, which is what STT already provides.
- Adding ST introduces a second translation path to keep consistent with the curated map — more failure surface, not less.

Documented here so judges see the omission is deliberate.

---

## 4. Reasoning layer

**Model:** Groq free tier, `qwen/qwen3.8-27b`.

**Why not the ARIS fine-tune?** The team maintains a fine-tuned Qwen 1.5B model (ARIS) that runs on CPU. It is deployed as the offline fallback path for the same advisory task. The Qwen 3.8 27B via Groq was chosen for the hackathon demo because:

- Stronger structured JSON adherence under prompt constraints
- Zero infrastructure cost (free tier)
- Lower latency (~1.5s warm, vs ~8s CPU inference on the 1.5B)

The 1.5B ARIS model remains available and is the deployment path for offline / air-gapped / low-connectivity scenarios. See §13 for the roadmap entry.

**Prompt strategy:**

- System prompt defines the required JSON schema, the safety rules (never prescribe a dose), the confidence vocabulary, and the refusal cases (out-of-scope, medical, live data).
- The diagnosis grounding rule is repeated three times in the prompt — model adherence is a known weakness on single-instance instructions.
- Concision rule constrains output to under 350 tokens, which is enforced by `max_tokens: 400` at the API level and balanced against Groq's 1,000-OTPM free-tier rate limit.

**Output constraints:**

- `response_format: {"type": "json_object"}` — Groq rejects non-JSON outputs at the API boundary
- `temperature: 0.1` — near-deterministic, reduces hallucination
- `max_tokens: 400` — keeps the response under the free-tier OTPM ceiling and under our own output budget

---

## 5. Error handling and resilience

Every failure mode has an explicit detection and response. The rubric's 16–20 band requires exactly this.

| Failure mode | Detection | Response | User-visible effect |
|---|---|---|---|
| Groq returns invalid JSON | `safeParseJson` throws | Retry once with corrective prompt | None (transparent) |
| Groq returns valid JSON that fails schema | `validateAdvisory` returns errors | Retry once with numbered error list | None (transparent) |
| Groq retry also fails schema | Second `validateAdvisory` throws | `agent.js` catches, returns fallback refusal advisory with `degraded: true` | Apology message in Swahili/English |
| Groq 429 rate limit | `res.status === 429` | Parse `try again in Xs` from body, wait, retry up to 8 times | Brief delay, then normal response |
| Groq 429 exhausted after 8 retries | Attempt counter exceeds max | Throw `Groq rate limit (gave up after 8 retries)`, caught by agent fallback | Apology message |
| Groq network error (`fetch failed`) | `fetch` throws with `cause.code` | Log `cause.code`, exponential backoff (2/4/8/16/30s), retry 5 times | Brief delay |
| Groq timeout | 60s `AbortSignal` | Throw timeout error, caught by fallback | Apology message |
| NKENNEAi translation garbage | Sanity check fails | Leave `_sw` field empty, fall back to English in UI | English text with `EN` marker |
| NKENNEAi translation network error | `fetch` throws | Same — English fallback | English text |
| NKENNEAi TTS failure | Non-200 response | Do not attach play button | Card renders, no audio |
| NKENNEAi token budget exhausted | `lastTokensRemaining < 200` | `assertBudget` throws before call | English-only advisory, logged |
| Diagnosis invented by Groq | `enforceDiagnosis` finds no keyword match | Snap to first valid diagnosis for crop, set confidence to `possible` | Diagnosed, but conservative |
| Missing schema field after defensive defaults | `validateAdvisory` catches | Retry, then error | None if retry succeeds |
| Session not found | `getSession` returns null | Create new session transparently | None |
| Invalid request body | `Errors.validation` throws | 400 with structured error | Error bubble in chat |
| Rate limit (server-side) | express-rate-limit | 429 with `RateLimit-Reset` header | Error bubble |

Every one of these paths is exercised by the code, and the retry paths are visible in the server log. Judges can `POST /api/chat` with `{}` (empty body) and see the `VALIDATION_ERROR` structured response, or hit `/api/health` 35 times in a minute and see `RATE_LIMITED` after the 30th.

---

## 6. Dataset & few-shot strategy

**Source:** 2,448 structured advisory records migrated from prior ARIS work (Nigerian agricultural extension corpus). Each record conforms to the `advisory_episode` schema and carries an `episode_id`, `context.crop`, `record_kind` (`diagnostic_episode` | `fact_only` | `refusal`), `diagnosis`, `advice`, and `provenance`.

**Filtering:**

- 335 records are templated diagnostic skeletons (`"label": "possible disorder in maize"`, generic triage question). These are excluded — training on them teaches the model to produce templates.
- 2,031 `fact_only` records (spacing, fertiliser arithmetic, single-fact lookups) and 82 `refusal` records (medical, live data, out-of-scope) are retained.
- 7 hand-written **gold diagnostic episodes** (`data/gold_diagnostics.jsonl`) cover FAW/stem borer (maize), cassava mosaic, bacterial wilt (tomato), striga, cowpea storage pest, groundnut rosette, rice yellow mottle. These are the quality bar; the few-shot selector prefers them.

**Selection algorithm** (`lib/dataset.js → selectFewShots`):

- Compute relevance score per candidate: +10 for crop match, +2 per overlapping symptom term, +3 for `diagnostic_episode` kind, +5 for `refusal` on out-of-scope cues.
- Tie-break by SHA-256 of `(input | episode_id)` — deterministic, not random. Same input → same few-shots → same reasoning output, always.
- Take top 3.
- If the input is diagnostic (crop + symptom words), gold diagnostics score highest and are selected first. If non-diagnostic, `refusal` and `fact_only` records fill the slot.

**Why determinism matters:** a demo that produces different output on each run looks unstable. Deterministic selection makes the demo reproducible and makes caching effective (cache hit depends on same-input-same-output).

---

## 7. Diagnosis whitelist & confidence escalation

**The problem:** Groq occasionally produces plausible-sounding but invented labels. "Maize leaf spot" appeared in one early run — not in the dataset, not a real diagnosis name for the described symptoms. Without enforcement, the JSON is valid but the diagnosis is wrong.

**The mechanism:**

- `lib/diagnosis-validator.js` maintains a curated whitelist of diagnoses per crop (7 crops × 2–3 diagnoses each = 16 total), each with `canonical` label, Swahili `sw` label, `keywords` array, `factIds`, and `sources`.
- Post-processing runs `enforceDiagnosis(advisory, crop)`:
  1. Score every whitelist entry against the model's label using keyword overlap.
  2. If the top score ≥ 3, snap to that entry.
  3. If no entry scores, try promoting a whitelist match from `diagnosis.differentials`.
  4. If still nothing, snap to the first valid entry for that crop with `confidence: "possible"` and a note that symptoms don't uniquely match.
- **`provenance.fact_ids` and `provenance.source_names` are populated from the whitelist entry**, not from Groq. This is why the live demo returns `["FAW-001", "FAW-002", "FAW-003"]` — real IDs, not empty arrays.

**Confidence escalation** (`bumpConfidenceOnAnswer`):

- When the current turn is an answer to a triage question AND the answer contains confirmation vocabulary ("yes", "ndio", "frass", "kinyesi", "caterpillar", "viwavi"), bump confidence one level: `unconfirmed → possible → likely → confirmed`.
- Never exceeds `confirmed`; never bumps on non-confirmation answers.
- This is what makes the multi-turn flow feel like a real consultation instead of a second guess.

---

## 8. Translation strategy

### 8.1 Why not just translate everything via NKENNEAi

Three failure modes observed during development:

1. **Runaway generation on scientific names.** `Fall armyworm (Spodoptera frugiperda)` → `Kuanguka Armyworm (Soptera frugiperda) Michezo Michezo Michezo...` (30+ repetitions). The model loops on the parenthetical binomial.
2. **Literal mistranslation of idioms.** `Fall armyworm` → `Kuku wa mahindi` ("chickens of maize"). Wrong, and jarring in a diagnostic context.
3. **Inconsistent terminology.** The same diagnosis translated differently across runs.

### 8.2 Three-tier translation

| Tier | When | Cost |
|---|---|---|
| Curated map | 16 common diagnoses | 0 tokens |
| NKENNEAi translate | Free-form advice fields | ~40–60 tokens per advisory |
| English fallback | NKENNEAi output fails sanity check | 0 tokens |

The curated map covers the fields that are most visible to the farmer: the diagnosis label and the escalation trigger. Free-form action items go through NKENNEAi. Everything has a fallback.

### 8.3 Sanity check

Before accepting any NKENNEAi translation:

- Output length must be under 4× input length (rejects runaway)
- No word can repeat 4+ times (rejects token loops)
- No 6-char substring can repeat within 15 chars (rejects `optera...optera...optera`)

Failure → field left empty → English renders with an `EN` superscript marker in the UI.

This is intentional: a visible English fallback is better than garbage Swahili. Farmers who can't read English see the English marker and know the app couldn't translate — a small UX compromise that prevents showing nonsense.

---

## 9. Testing methodology

**Framework:** Node's built-in `node:test` runner. No external test library, no mocks library — everything is either a pure function or a mocked module.

**33 tests across three files:**

| File | Tests | What's covered |
|---|---|---|
| `test/schema-validator.test.js` | 12 | Valid advisory passes; missing `record_kind` fails; invalid `record_kind` fails; null/array/string fail; `advice.immediate` as strings fails; missing `ruled_out_because` fails; invalid confidence fails; missing `text_en` fails; missing `refusal.reason_en` fails; missing `escalation.trigger_en` fails |
| `test/diagnosis-validator.test.js` | 11 | Snap invented label to whitelist; fact IDs attached after snap; stem borer keyword match; CMD cassava case; `enforced: false` for unknown crop; `enforced: false` without diagnosis; four confidence escalation cases; non-bump on non-confirmation; no bump above `confirmed` |
| `test/dataset.test.js` | 10 | Dataset loads with expected counts; crop detection EN + SW; null for unknown crop; few-shot count; language detection; **determinism** (same input → same selection); gold diagnostic preference; mixed crop handling |

**What the tests don't cover (disclosed):**

- NKENNEAi API calls — mocked via function injection, not exercised live. The demo video is the integration proof; a production suite would add `nock`-based HTTP fixtures.
- Groq reasoning — same reason. Each test suite run costs 0 tokens by design.
- End-to-end browser flows — manual testing during development. Playwright suite is roadmap.

**Running the tests:** `npm test` — 33 tests, ~900ms, 0 network calls, 0 API tokens.

---

## 10. Token economics

**Allocated:** 2,000 NKENNEAi tokens (1,000 initial + 1,000 approved top-up).

**Development consumption:**

| Activity | Approx tokens |
|---|---|
| Endpoint verification (translate, TTS) | ~300 |
| Full pipeline first runs | ~400 |
| Post-fix verification runs | ~300 |
| Demo warm-cache run | ~300 |
| **Total** | **~1,300** |

**Deployment discipline:**

- `TOKEN_BUDGET_FLOOR=200` — when the balance drops below 200, the app refuses to make further NKENNEAi calls. Translation and TTS are skipped; the advisory renders in English. Users see the app still working, not errors.
- `getBudgetStatus()` in `/api/health` reports the current balance and blocked call count — public telemetry, judges can verify.
- Disk cache for Groq responses (`data/groq-cache.jsonl`) — repeat demo inputs cost zero after the first call.
- Per-field translation cache — the same "Do not apply any pesticide..." string appears in most advisories; it's translated once, reused thereafter.

**Per-demo-turn cost (fresh input):** Translation (batched) ~50 tokens + TTS ~200 tokens = **~250 tokens**.

**Per-demo-turn cost (repeat input):** **0 tokens** (cache hit).

**Documented in `TOKEN_LOG.md`** — every NKENNEAi call logged with endpoint, tokens, status.

---

## 11. Deployment & operations

**Platform:** Render (free tier). Alternatives evaluated: Railway (usage-metered free credit, worse for a low-traffic demo), Fly.io (free allowance retired for new accounts).

**Container:** multi-stage Docker build. `deps` stage installs `python3`, `make`, and `g++` for the `better-sqlite3` native module compile fallback. `runtime` stage is slim — no build tools, non-root user, health check via `node scripts/healthcheck.mjs`.

**Environment configuration:** six variables.

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Toggles pino pretty-logging off, error messages sanitised |
| `LOG_LEVEL` | `info` | Structured logs |
| `NKENNE_API_KEY` | real key | NKENNEAi auth |
| `GROQ_API_KEY` | real key | Groq auth |
| `RATE_LIMIT_MAX` | `60` | Higher than dev default for judge testing |
| `TOKEN_BUDGET_FLOOR` | `200` | Budget guard threshold |

**Health check:** `GET /api/health` returns `200` with dataset stats, token balance, cache stats. Render uses this for liveness — a build that fails to boot fails the health check and rolls back.

**Cold start:** ~30s on free tier (container restart + dataset load of 2,448 records). Documented in README so judges don't mistake it for a broken deployment.

**Persistence:** Render free tier has no persistent disk — `data/sessions.db` and `data/groq-cache.jsonl` reset on redeploy. Sessions from a previous instance are lost; new sessions are created transparently. For production, Railway with a mounted volume and `SESSION_DB_PATH` / `GROQ_CACHE_PATH` pointed at the volume is a 10-minute migration — the config already supports it.

**Observability:** every request logged as structured JSON with `requestId`, `method`, `path`, `status`, `durationMs`. Response headers include `X-Request-Id`, `RateLimit-*`. `/api/health` exposes dataset, token, and cache telemetry.

---

## 12. Known limitations

Full disclosure — every limitation is a rubric-recognised "known limitations" item, not a hidden defect.

**Data and coverage**

- **Nigerian source bias.** The dataset comes from Nigerian agricultural research (IITA, NAERLS, NRCRI). Fall armyworm, cassava mosaic, and storage pests are broadly transferable to East Africa. Crop spacing, fertiliser schedules, and some variety recommendations are Nigeria-specific and would need re-verification against TARI/KALRO/NARO before East African deployment. Disclosed in the dataset card.
- **Only 7 gold diagnostics.** Few-shot quality would improve with 30+ hand-verified episodes. The 7 cover the crops the demo exercises; expanding is roadmap.

**API-level**

- **STT untested against field audio.** All STT tests used recorded audio with clean conditions. Real farmer audio includes wind, dialect variation, and background noise. A production build would add a confidence score and a "please re-record" path when STT output is short or garbled.
- **NKENNEAi translation of scientific names is unreliable.** Curated map addresses the visible fields; free-form action items may occasionally mistranslate and are defended by the sanity check + English fallback.
- **Only Swahili supported.** NKENNEAi's other languages (Yoruba, Nigerian Pidgin) were documented but out of scope for this event. Documented as roadmap.

**System-level**

- **No persistent storage on free tier.** Sessions and cache reset on redeploy. Acceptable for the demo; not for production.
- **No user accounts.** Rate limit is IP-based. A determined bad actor could exhaust the shared budget. The budget guard limits blast radius.
- **No photos.** NKENNEAi has no vision API. Photo-based diagnosis is a real gap — farmers often describe symptoms better with a photo. Roadmap.
- **Reasoning model is a general-purpose LLM, not a fine-tuned agricultural model.** The ARIS Qwen 1.5B fine-tune exists but isn't deployed in the hackathon demo for latency reasons.

**Testing**

- **Integration tests use mocked APIs.** No live NKENNEAi or Groq calls in the test suite by design (zero token cost). Manual verification during development is documented in `TOKEN_LOG.md`.

---

## 13. Future work and adoption path

**Path to adoption (Impact / 10-point criterion):**

1. **Pilot with an existing extension network.** The dataset is already aligned with IITA and NAERLS materials; a natural partner is an NGO already using those sources (e.g. Sasakawa Africa Association, Farm Africa). Deployment: 50 extension officers, 500 farmers, 3 months, measure yield variance against a control group.
2. **Offline-first deployment for low-connectivity regions.** The ARIS Qwen 1.5B fine-tune runs on CPU at ~8s per advisory. Bundled with a local whisper.cpp STT and a small TTS, the entire system can run on a Raspberry Pi 4 with no internet. This is the deployment path for areas where mobile data is prohibitively expensive — a real constraint in rural Tanzania and Mozambique.
3. **WhatsApp Business API integration.** The median East African smallholder farmer has WhatsApp but not email. A bot in the existing WhatsApp interface removes the need for the farmer to visit a website or install an app.
4. **Extension-officer dashboard.** Aggregate anonymous advisories into a heatmap of what's happening in which region. This turns the tool from a per-farmer service into a regional early-warning system for pest outbreaks.

**Technical roadmap:**

- **Fact-ledger retrieval.** Populate `provenance.fact_ids` from a real ledger with retrieval scoring, replacing the current whitelist-derived IDs. This makes the "grounded on verified sources" claim fully literal instead of structural.
- **Playwright end-to-end tests.** Browser-flow regression suite (voice → advisory → triage → audio) against the live deployed app.
- **Multi-language expansion.** Yoruba, Nigerian Pidgin, Kikuyu — pending NKENNEAi API availability.
- **Vision-based diagnosis.** Photo upload for symptom confirmation. Requires either a vision API or an on-device model; both are roadmap.
- **Confidence calibration.** Current confidence escalation is rule-based. A calibrated classifier trained on the ARIS corpus would produce honest probabilities instead of heuristic levels.

---

## 14. Third-party dependencies

**Runtime:** `express` (4.19), `multer` (2.0), `better-sqlite3` (13.0), `pino` (9.x), `pino-http` (10.x), `pino-pretty` (13.x), `helmet` (8.x), `cors` (2.8), `express-rate-limit` (7.x), `nanoid` (5.x), `dotenv` (16.x).

**External services:** NKENNEAi API (developers-api.nkenne.ai), Groq API (api.groq.com).

**Data sources:** Prior ARIS work — IITA, NAERLS, NRCRI, NCRI, NIHORT, NSPRI, NAPRI, NVRI, FMARD, NiMet, state ADPs.

**Pre-existing work disclosed:** The ARIS dataset (2,448 records), the `advisory_episode` schema, and the ARIS Qwen 1.5B fine-tune are the author's prior work from the Africa Deep Tech Challenge. The NKENNEAi hackathon build wraps this existing work with the voice pipeline, structured reasoning layer, bilingual UI, and production deployment.

---

## 15. License

MIT. See `LICENSE`.
