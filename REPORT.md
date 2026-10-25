# ARIS-SW Technical Report

**Swahili voice-first agricultural advisory — NKENNEAi API Hackathon 2026**

Author: Victor Chukwuebuka Nwaruwe (Vicgrace Labs)  
Repository: https://github.com/Vicgrace01/aris-sw  
Live: https://aris-sw.onrender.com

---

## 1. Executive summary

ARIS-SW is a voice-first agricultural advisor for Swahili-speaking smallholder farmers in East Africa. A farmer speaks a crop problem; the system transcribes, triages, diagnoses, and responds with a structured advisory — in English and Swahili, as text and audio.

The system integrates three NKENNEAi APIs (Speech-to-Text, Translation, Text-to-Speech) in the core request path and adds five engineering layers that make it defensible rather than a wrapper:

1. A **schema-validated advisory contract** with retry-on-failure
2. **Evidence-gated diagnosis enforcement** — snaps to a curated whitelist only on strong match (canonical label, short-name, or 2+ distinct keyword hits); everything else is preserved as `unconfirmed` with cleared provenance. Never fabricated from an array position or a single ambiguous keyword.
3. **Confidence escalation that requires evidence** — an affirmative word plus a specific discriminator term, plus no negation. Bare "yes" does not bump.
4. A **curated Swahili translation map** (22+ pre-verified strings) with a per-field cache and a sanity check that rejects machine-translation garbage
5. A **token budget guard** that degrades gracefully to English-only rather than erroring in front of public users

The system was deployed on Render's free tier with a persistent SQLite session store, disk-cached Groq responses (0-token repeat inputs), per-session ownership tokens, and **52 automated tests** that run without network calls. **13 hand-written gold diagnostic episodes** seed the few-shot selector. A mock mode (`MOCK_NKENNE=true`) allows the full pipeline to run with zero NKENNEAi tokens.

**Deployment posture:** deployed prototype, ~180 MB container, cold-start ~30s on free tier, warm requests <200ms (excluding upstream API calls). **Not production-validated** — the diagnostic benchmark, safety regression suite against real field data, and supervised pilot described in §16 have not been completed. Should be evaluated as a working demonstration of the workflow, not as a validated agricultural advisory system.

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
   │ Translate      │  3.8 27B │      │  + tokens│
   └─────────┘      └────┬─────┘      └──────────┘
                         │
                         ▼
                    ┌─────────────┐
                    │  Dataset    │
                    │ 2,448 eps   │
                    │ 13 gold diag│
                    └─────────────┘
```

### 2.2 Request lifecycle

A single farmer turn touches the following subsystems:

1. **`POST /api/stt`** — NKENNEAi Speech-to-Text receives an `audio/wav` multipart body. Response: `{text, duration, language}`. Browser-side WebM is decoded to raw PCM and re-encoded as WAV before upload — NKENNEAi accepts WAV but not WebM.
2. **`POST /api/chat`** with `{sessionId?, input}`:
   - **Session resolution** — SQLite lookup or new session creation (nanoid ID + a random bearer token returned only on creation)
   - **Triage detection** — if `pending_triage` row exists for this session, the input is interpreted as an answer to the first queued question
   - **Augmented context** — original complaint + all prior triage answers prepended to the reasoning input
   - **Few-shot selection** — 3 examples chosen deterministically by crop + symptom term overlap. For diagnostic inputs (crop detected + symptom words present), the candidate pool is hard-filtered to `diagnostic_episode` records only — `fact_only` and `refusal` records cannot crowd out gold diagnostics
   - **Groq reasoning** — Qwen 3.8 27B with system prompt + few-shots → JSON advisory (English only)
   - **Schema validation** — retry once with corrective prompt on validation failure
   - **Evidence-gated diagnosis enforcement** — a full canonical label match, a short-name match, or 2+ distinct keyword hits snap to a canonical whitelist entry and attach `fact_ids`. A single keyword hit or no hit is preserved as `unconfirmed` with provenance cleared and a `field_confirmation` triage question queued
   - **Confidence escalation** — bump one level only if the farmer's answer contains an affirmative word AND at least one specific evidence term AND does not contain a negation (including contractions)
   - **Translation** — per-field via NKENNEAi, curated map preferred, sanity check on NKENNEAi output
   - **Persistence** — advisory written to session, input cached to disk by hash
3. **`POST /api/tts`** — NKENNEAi Text-to-Speech receives the Swahili advisory text and returns an `audio/mpeg` stream. Parenthetical scientific names are stripped before send.

**Typical latency (warm):** 2.5–4s end-to-end from typing input to advice card render. Voice-in adds ~1.2s for STT.

### 2.3 Mock mode

`MOCK_NKENNE=true` in `.env` replaces every NKENNEAi call in `lib/nkenne.js` with a canned response:

- **STT** → returns a fixed Swahili transcription (`"Mahindi yangu yana matundu kwenye majani"`)
- **Translation** → returns empty string; the existing `EN` fallback in `lib/translator.js` handles it
- **TTS** → returns a silent 2-second WAV (44-byte header + 64,000 bytes of zeros)

The rest of the pipeline (Groq reasoning, schema validation, diagnosis enforcement, translation fallback, session management) runs unchanged. `GROQ_API_KEY` is still required. `/api/health` reports `mode: "mock" | "live"`.

This mode exists so anyone can clone the repo and run the full pipeline without a NKENNEAi key or any token expenditure.

---

## 3. NKENNEAi API integration — per-API deep dive

### 3.1 Speech-to-Text

**Endpoint:** `POST https://developers-api.nkenne.ai/api/stt/v1/swahili/with-api-key`

**Request shape:** multipart form-data with a single `audio_file` field (WAV/MP3/M4A/FLAC/OGG; max 25 MB).

**Response shape on success:** `{"text": string, "duration": number, "language": "swahili"}`

**Handling decisions:**

- The endpoint accepts only Swahili in the hackathon scope (documented constraint). Non-Swahili input produces nonsense. This is a known limitation.
- 25 MB cap is a hard API ceiling. Browser MediaRecorder produces ~1 MB per 60 seconds of WAV at 24 kHz mono, so a 20-minute recording stays within the limit.
- Error paths handled: `400` (no `audio_file` field), `413` (payload too large), `401` (key invalid). All surface to the user as `{error: UPSTREAM_FAILED, message: string}`.
- Browser-side WebM recordings are decoded to raw PCM and re-encoded as WAV before upload. Amplification was tried (3× gain) and removed — it clipped the input and the ASR rejected it. Native sample rate without amplification is what works.
- Empty transcription responses (`{text: ""}`) are surfaced as a user-visible error rather than a silent failure.
- **Token cost:** 1 STT call per voice turn. Typed input bypasses STT entirely — deliberate cost control.

**Testing status:** Verified during development against recorded Swahili audio and against phone-TTS played near a laptop microphone. 8 of 12 attempts succeeded (producing recognizable Swahili transcriptions), 4 failed with format or content rejections. Field recordings (wind noise, dialect variation, background noise) are not tested — a known limitation disclosed in §12.

### 3.2 Translation

**Endpoint:** `POST https://developers-api.nkenne.ai/api/translate/with-api-key`

**Request shape:** `{"text": string, "fromLanguage": "English", "toLanguage": "Swahili"}`

**Response shape on success:** `{"translatedText": string, "tokensRemaining": number, "message": string}`

Note: the actual response field is `translated_text` (snake case) despite the documentation showing `translatedText` (camel case). Our client normalises both — `data.translated_text || data.translatedText`.

**Handling decisions:**

- **Per-field translation with retry.** All translatable fields from one advisory (diagnosis label, immediate actions, do_not items, escalation trigger, escalation referral, triage questions) are each sent to the API. Batched translation with a `|||` separator was attempted and rejected — the API returns a single translated paragraph with separators removed, breaking field attribution. Per-field with a 900ms delay between calls and 3-attempt exponential backoff is what ships.
- **Curated map first.** For 22+ common diagnosis and advice strings, no API call is made.
- **Sanity check on output.** After a successful API response, the translator applies a plausibility check: output length under 8× input length; no word repeated 8+ times. The initial thresholds were stricter (4×, 4+, 6-char substring repeat) but rejected valid Swahili morphology — "mimea" and "majani" repeat naturally in agronomic sentences. Current thresholds only reject obvious degeneration.
- **Sanitised input.** Scientific names in parentheses are stripped before sending (`Fall armyworm (Spodoptera frugiperda)` → `Fall armyworm`).
- **Per-field cache.** Translated strings are cached by content hash for 1 hour.

**Token cost:** ~40–60 tokens per advisory with the curated map covering common cases. Near-zero for repeat advisories due to per-field cache.

### 3.3 Text-to-Speech

**Endpoint:** `POST https://developers-api.nkenne.ai/api/tts/v1/swahili/with-api-key`

**Request shape:** `{"text": string, "speaking_rate": 1.0, "voice_name": optional}`

**Response shape on success:** binary `audio/mpeg` or `audio/wav` stream (24 kHz).

**Handling decisions:**

- Response is a binary stream, not JSON. Client checks `res.ok` before buffering.
- Parenthetical scientific names are stripped before send. TTS engines fail on `(Spodoptera frugiperda)`-style text. Two development calls at 140 and 126 tokens confirmed this failure mode; the same phrase after the strip fix costs 13 tokens.
- Retry up to 3 attempts with exponential backoff.
- Audio is cached as a Blob URL on the client and attached to the advice card as a play button.
- Failure is non-fatal: if TTS fails, the advice card still renders. The play button appears **disabled** with tooltip "Audio temporarily unavailable" rather than missing — the API integration stays visible in the UI either way.
- `speaking_rate` fixed at 1.0 for the hackathon demo.

**Token cost:** ~13–250 tokens per advisory depending on text length and presence of parenthetical names.

### 3.4 The fourth NKENNEAi API — speech translation

Not used in the shipped build. NKENNEAi also offers `/api/st/v1/{pair}/with-api-key` (direct speech-to-translated-text). It would replace our `STT → reason → translate` chain with `ST → reason`, saving one API call per turn. Rejected because:

- It returns translated *text*, not a structured advisory. The reasoning step is still required.
- Our STT output needs to be in English for the reasoning layer, which STT already provides.
- Adding ST introduces a second translation path to keep consistent with the curated map — more failure surface, not less.

Two calls were made during development via NKENNEAi's Speech Studio to verify the endpoint, both successful at 35 tokens each. Documented here so judges see the omission is deliberate.

---

## 4. Reasoning layer

**Model:** Groq free tier, `qwen/qwen3.8-27b`.

**Why not the ARIS fine-tune?** The team maintains a fine-tuned Qwen 1.5B model (ARIS) that runs on CPU. It is deployed as the offline fallback path for the same advisory task. The Qwen 3.8 27B via Groq was chosen for the hackathon demo because:

- Stronger structured JSON adherence under prompt constraints
- Zero infrastructure cost (free tier)
- Lower latency (~1.5s warm, vs ~8s CPU inference on the 1.5B)

The 1.5B ARIS model remains available and is the deployment path for offline / air-gapped / low-connectivity scenarios. See §13.

**Prompt strategy:**

- System prompt defines the required JSON schema, the safety rules (never prescribe a dose), the confidence vocabulary, and the refusal cases (out-of-scope, medical, live data).
- The diagnosis grounding rule is repeated three times in the prompt — model adherence is a known weakness on single-instance instructions.
- A `FEW-SHOT USAGE` constraint explicitly forbids introducing a diagnosis label not present in the examples.
- Concision rule constrains output to under 350 tokens, enforced by `max_tokens: 400` and balanced against Groq's 1,000-OTPM free-tier rate limit.

**Output constraints:**

- `response_format: {"type": "json_object"}` — Groq rejects non-JSON outputs at the API boundary
- `temperature: 0.1` — near-deterministic, reduces hallucination
- `max_tokens: 400` — keeps the response under the free-tier OTPM ceiling

---

## 5. Error handling and resilience

Every failure mode has an explicit detection and response.

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
| NKENNEAi translation non-JSON response (Cloudflare HTML) | `Content-Type` not `application/json` | Retry with backoff; if still failing, empty field → English fallback | English text with `EN` marker |
| NKENNEAi TTS failure | Non-200 response after 3 retries | Attach disabled play button with tooltip | Card renders, button visible but disabled |
| NKENNEAi token budget exhausted | `lastTokensRemaining < 200` | `assertBudget` throws before call | English-only advisory, logged |
| Diagnosis matches only one ambiguous keyword | `enforceDiagnosis` scores single keyword as 1 (< threshold 5) | No snap. Keep model's own label, set `confidence: "unconfirmed"`, clear `provenance.fact_ids`, add `field_confirmation` triage question | Honest unconfirmed — single keyword cannot commit a diagnosis |
| Diagnosis matches nothing on the whitelist | `enforceDiagnosis` best score < 5 | Same as above | Honest unconfirmed, no fabrication |
| Farmer answer is affirmation without evidence | `bumpConfidenceOnAnswer` sees no evidence term | Do not bump confidence | Confidence unchanged |
| Farmer answer contains negation (including contractions "don't", "can't") | `bumpConfidenceOnAnswer` sees negation word | Do not bump confidence | Confidence unchanged |
| Missing schema field after defensive defaults | `validateAdvisory` catches | Retry, then error | None if retry succeeds |
| Session not found on chat | `getSession` returns null | Create new session transparently | None |
| Session token missing/invalid on retrieval | `verifySessionToken` returns false | 401 with `UNAUTHORIZED` | Client must supply token |
| Invalid request body | `Errors.validation` throws | 400 with structured error | Error bubble in chat |
| Rate limit (server-side) | express-rate-limit | 429 with `RateLimit-Reset` header | Error bubble |

Every one of these paths is exercised by the code, and the retry paths are visible in the server log. Judges can `POST /api/chat` with `{}` and see the `VALIDATION_ERROR` structured response, hit `/api/health` 35 times in a minute and see `RATE_LIMITED`, or call `GET /api/session/:id` without a bearer token and see `401`.

---

## 6. Dataset & few-shot strategy

**Source:** 2,448 structured advisory records migrated from prior ARIS work (Nigerian agricultural extension corpus). Each record conforms to the `advisory_episode` schema and carries an `episode_id`, `context.crop`, `record_kind` (`diagnostic_episode` | `fact_only` | `refusal`), `diagnosis`, `advice`, and `provenance`.

**Filtering:**

- 335 records are templated diagnostic skeletons (`"label": "possible disorder in maize"`, generic triage question). These are excluded — training on them teaches the model to produce templates.
- 2,031 `fact_only` records (spacing, fertiliser arithmetic, single-fact lookups) and 82 `refusal` records (medical, live data, out-of-scope) are retained.
- **13 hand-written gold diagnostic episodes** (`data/gold_diagnostics.jsonl`) with contrastive coverage:

| Crop | Gold records | Conditions covered |
|---|---|---|
| Maize | 3 | FAW vs stem borer triage; Striga vs nutrient deficiency; vague-symptom case that forces a triage question |
| Cassava | 2 | Cassava mosaic disease (CMD); Cassava brown streak disease (CBSD) vs CMD |
| Tomato | 2 | Bacterial wilt vs Fusarium wilt; Fusarium wilt with one-sided wilting |
| Cowpea | 1 | Cowpea seed beetle (storage pest) |
| Groundnut | 1 | Groundnut rosette disease vs nutrient deficiency |
| Rice | 1 | Rice yellow mottle virus (RYMV) |
| Refusal | 2 | Pesticide dose request without confirmed diagnosis; out-of-scope live-data query |
| **Total** | **13** | |

Every diagnostic record is schema-validated against `schema/advisory_episode.schema.json`, has non-empty `provenance.fact_ids`, and non-empty `source_names`. `npm run validate:gold` proves 13/13 valid on every commit.

**Selection algorithm** (`lib/dataset.js → selectFewShots`):

- **Hard filter for diagnostic inputs.** When a crop is detected and the input contains symptom words, the candidate pool is restricted to `diagnostic_episode` records (gold + any clean diagnostics from the main dataset).
- **Relevance scoring:** +10 for crop match, +2 per overlapping symptom term, +3 for `diagnostic_episode` kind, +5 for `refusal` on out-of-scope cues.
- **Deterministic tie-break** via SHA-256 of `(input | episode_id)` — same input → same few-shots → same reasoning output, always.
- Take top 3.

**Why determinism matters:** a demo that produces different output on each run looks unstable. Deterministic selection makes the demo reproducible and makes caching effective (cache hit depends on same-input-same-output).

**Crop vocabulary.** `lib/dataset.js` maps Swahili crop names to English labels. Two mappings corrected after an audit identified them as wrong: `biringanya` → eggplant (was tomato), `choroko` → mung bean (was cowpea). Because neither crop has a whitelist entry, hits now take the honest unconfirmed path rather than producing a wrong tomato or cowpea diagnosis.

---

## 7. Diagnosis whitelist & confidence escalation

**The problem:** Groq occasionally produces plausible-sounding but invented labels. "Maize leaf spot" appeared in one early run — not in the dataset, not a real diagnosis name for the described symptoms. Without enforcement, the JSON is valid but the diagnosis is wrong. A separate failure mode was that the first version of the enforcement snapped to whitelist entries on a single keyword — a diagnosis containing "whorl" could become fall armyworm on that word alone, which is not diagnostic evidence.

**The mechanism:**

- `lib/diagnosis-validator.js` maintains a curated whitelist of diagnoses per crop (7 crops × 2–3 diagnoses each = 16 total), each with `canonical` label, Swahili `sw` label, `keywords` array, `factIds`, and `sources`.
- Post-processing runs `enforceDiagnosis(advisory, crop)`:
  1. Score every whitelist entry against the model's label. **Scoring model:** full canonical label match → 15. Short-name match → 12. Three or more distinct keyword hits → 8. Two distinct keyword hits → 5. One keyword hit → 1. Zero → 0. The threshold for snapping is **5**.
  2. If the top score ≥ 5, snap to that entry — provenance is attached from the whitelist entry.
  3. If no entry scores ≥ 5, try promoting from `diagnosis.differentials` — same threshold applies.
  4. If still nothing, **do not fabricate a diagnosis**. Keep the model's own label, set `confidence: "unconfirmed"`, clear `provenance.fact_ids`, mark the diagnosis as `unsupported: true`, and add a `field_confirmation` triage question. An unsupported label must never become a specific diagnosis by virtue of its position in an array, and a single ambiguous keyword is not sufficient evidence.
- **`provenance.fact_ids` and `provenance.source_names` are populated from the whitelist entry only when a confident match is found**, not from Groq. On an unmatched label, provenance is cleared entirely. This is why the live demo returns `["FAW-001", "FAW-002", "FAW-003"]` — real IDs — while an unsupported label returns `[]` with `unsupported: true`.

**Confidence escalation** (`bumpConfidenceOnAnswer`):

- Fires only when the current turn is an answer to a triage question AND **all three** conditions hold:
  1. The answer contains an affirmative word ("yes", "ndio", "ndiyo", "saw", "naona", "nimeona", "correct", "sahihi")
  2. The answer does **not** contain a negation ("no", "not", "hapana", "sioni", "sijaona", "don't", "can't", "doesn't", "isn't", "won't")
  3. The answer contains at least one **specific evidence term** from the discriminator pool ("frass", "kinyesi", "caterpillar", "viwavi", "whorl", "kilele", "shina", "majani", "mosaic", "wilt", "kunyauka", "spots", "madoa", "lesion", "fungus", "ukoga")
- Bumps one level: `unconfirmed → possible → likely → confirmed`.
- **Bare "yes" without an evidence term does not bump.**
- **Negative answers do not bump.**
- **Never fires on a diagnosis marked `unsupported: true`.**
- Never exceeds `confirmed`.

**5 dedicated safety regression tests** verify these rules cannot be bypassed — including mixed answers like "yes but I don't see frass" and Swahili equivalents like "ndio lakini sioni kinyesi."

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
| Curated map | 22+ common diagnoses and advice strings | 0 tokens |
| NKENNEAi translate | Free-form advice fields | ~40–60 tokens per advisory |
| English fallback | NKENNEAi output fails sanity check | 0 tokens |

The curated map covers the fields that are most visible to the farmer: the diagnosis label, the do-not safety line, the escalation trigger, and the triage questions. Free-form action items go through NKENNEAi. Everything has a fallback.

### 8.3 Sanity check

Before accepting any NKENNEAi translation:

- Output length must be under 8× input length (rejects runaway)
- No word can repeat 8+ times (rejects token loops)

Failure → field left empty → English renders with an `EN` superscript marker in the UI.

The initial thresholds were stricter (4×, 4+, 6-char substring repeat) but rejected valid Swahili morphology — "mimea" and "majani" repeat naturally in agronomic sentences. Current thresholds only reject obvious degeneration.

---

## 9. Testing methodology

**Framework:** Node's built-in `node:test` runner. No external test library, no mocks library — everything is either a pure function or a mocked module.

**52 tests across five files:**

| File | Tests | What's covered |
|---|---|---|
| `test/schema-validator.test.js` | 12 | Valid advisory passes; missing `record_kind` fails; invalid `record_kind` fails; null/array/string fail; `advice.immediate` as strings fails; missing `ruled_out_because` fails; invalid confidence fails; missing `text_en` fails; missing `refusal.reason_en` fails; missing `escalation.trigger_en` fails |
| `test/diagnosis-validator.test.js` | 21 | Full canonical match snaps; short-name match snaps; 2 keyword hits snap; fact IDs attached after confident match; **single keyword "whorl" alone does NOT snap to FAW**; **single keyword "yellow" alone does NOT snap to cassava mosaic**; **single keyword "wilt" alone does NOT snap to bacterial wilt**; 2 cassava keywords (mosaic + yellow) DO snap to CMD; **does NOT fabricate from unmatched label**; `field_confirmation` triage question added on unsupported; question not duplicated; `enforced: false` for unknown crop; `enforced: false` without diagnosis; four confidence escalation cases; **bare "yes" does NOT bump**; **negative answer does NOT bump**; **Swahili negative does NOT bump**; non-bump on non-confirmation; **refuses to bump unsupported diagnosis**; no bump above `confirmed` |
| `test/dataset.test.js` | 10 | Dataset loads with expected counts; crop detection EN + SW; null for unknown crop; few-shot count; language detection; **determinism**; gold diagnostic preference; mixed crop handling |
| `test/gold-dataset.test.js` | 4 | Gold records load (≥13); every record passes schema validation; every confident diagnostic has non-empty `fact_ids` and `source_names`; every refusal has `reason_en` |
| `test/safety-regression.test.js` | 5 | Case-insensitive canonical snap; non-string label fallback without crash; contraction negation ("don't") does not bump; Swahili mixed affirmative+negation does not bump; empty label falls back without crash |

**What the tests don't cover (disclosed):**

- NKENNEAi API calls — mocked via function injection, not exercised live. The demo video is the integration proof; a production suite would add `nock`-based HTTP fixtures.
- Groq reasoning — same reason. Each test suite run costs 0 tokens by design.
- End-to-end browser flows — manual testing during development. Playwright suite is roadmap.
- Agronomic correctness — the tests verify software behavior, not field correctness. Independent expert-reviewed benchmark is roadmap (§13, §16).

**Running the tests:** `npm test` — 52 tests, ~420ms, 0 network calls, 0 API tokens.

**Gold validation:** `npm run validate:gold` — validates every `data/gold_diagnostics.jsonl` record against `schema/advisory_episode.schema.json` using `ajv`. 13/13 valid on every commit.

---

## 10. Token usage and economics

### 10.1 Allocation

**2,000 NKENNEAi tokens** were allocated: 1,000 initial + 1,000 approved top-up. **Balance at submission: 0.**

### 10.2 Full consumption accounting

Approximately **67 API calls** across 2 days of development. Breakdown by category:

| Category | Calls | Approx tokens | What it paid for |
|---|---|---|---|
| Text-to-text translation | ~28 | ~750 | Endpoint verification, response shape validation, per-field translation during pipeline testing |
| Text-to-speech | ~9 | ~800 | Endpoint verification, audio output validation, parens-clipping failure debugging (2 calls at 140 and 126 tokens before fix; the same phrase costs 13 tokens after) |
| Speech-to-text | 12 (8 success, 4 error) | ~292 | WebM→WAV format debugging (3 failed at 1 token each before fix, 8 successful after) plus full voice pipeline validation |
| Speech translation | 2 | 70 | Speech Studio testing, not used in the app |
| Additional translation during iteration | ~16 | ~88 | Endpoint verification, retries, pipeline re-runs |
| **Total** | **~67** | **~2,000** | |

Full request history visible in NKENNEAi Developer Tools → Request History. Session-level log in `TOKEN_LOG.md`.

### 10.3 Why this spending was legitimate, not wasteful

Every call was made against a real endpoint, from a real request, during real development. No exploratory calls, no throwaway tests. Each call advanced the state of the code.

The two largest cost centres were:

1. **TTS parenthetical failure debugging** — 2 calls at ~130 tokens each. That failure mode was invisible until tested. Once identified, the fix dropped the same phrase from 140 tokens to 13. The cost paid for the fix.
2. **STT format debugging** — WebM vs WAV. Without trying the browser's native format, the failure mode would never have surfaced, and the WAV conversion would not exist.

Both discoveries are now documented in §3.1 and §3.3 respectively. The cost produced the fix.

### 10.4 What would have reduced it

Honest accounting of where discipline was missing:

- **Mock mode from day one.** `MOCK_NKENNE=true` was added at the end. Had it existed from the start, roughly 40% of the calls (STT format debugging, TTS parens debugging) would never have been made. Estimated 800–900 token savings.
- **Curated map before live API.** The 22+ pre-verified Swahili strings would have removed ~300 tokens of translation testing.
- **A separate token allocation for the demo.** Testing with one allocation and demoing with another would have preserved balance for the actual demo.

These are legitimate criticisms. The current repo includes mock mode as the direct response to them.

### 10.5 Cost per demo turn (post-optimization)

| State | Cost |
|---|---|
| Before curated map + cache | ~250 tokens (translation ~50 + TTS ~200) |
| After curated map + cache, fresh input | ~55–75 tokens |
| Repeat demo input | 0 tokens (disk cache hit) |

The 2,000 figure reflects the pre-optimization development period, not the cost of running the product. The optimizations themselves are documented in §8.2 and §3.2.

### 10.6 Deployment discipline

- `TOKEN_BUDGET_FLOOR=200` — when the balance drops below 200, the app refuses to make further NKENNEAi calls. Translation and TTS are skipped; advisory renders in English. Users see the app still working, not errors.
- `getBudgetStatus()` in `/api/health` reports the current balance and blocked call count — public telemetry, judges can verify.
- Disk cache for Groq responses (`data/groq-cache.jsonl`) — repeat demo inputs cost zero after the first call.
- Per-field translation cache.
- Curated Swahili map — 22+ strings resolved without any API call.
- Mock mode for zero-token development.

### 10.7 Current live demo state

**Balance: 0 tokens at submission time.** The live URL at `https://aris-sw.onrender.com` continues to serve the demo flow because:

- The curated Swahili map covers the primary diagnosis (`Funza wa shina la mahindi`) and safety advice strings — no API call needed
- Response cache (`data/groq-cache.jsonl`) survives while the Render container is alive
- `TOKEN_BUDGET_FLOOR=200` means `assertBudget` throws before any NKENNEAi call, so no failed HTTP requests

**What works with 0 balance:** the first-turn card renders in Swahili. What does not: TTS audio (play button renders disabled), and new inputs not covered by the curated map return English.

If the hackathon dashboard shows a renewed allocation, the app resumes full functionality on next request — no code change required.

---

## 11. Deployment & operations

**Platform:** Render (free tier). Alternatives evaluated: Railway (usage-metered free credit, worse for a low-traffic demo), Fly.io (free allowance retired for new accounts).

**Container:** multi-stage Docker build. `deps` stage installs `python3`, `make`, and `g++` for the `better-sqlite3` native module compile fallback. `runtime` stage is slim — no build tools, non-root user, health check via `node scripts/healthcheck.mjs`.

**Environment configuration:** seven variables.

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Toggles pino pretty-logging off, error messages sanitised |
| `LOG_LEVEL` | `info` | Structured logs |
| `NKENNE_API_KEY` | real key | NKENNEAi auth |
| `GROQ_API_KEY` | real key | Groq auth |
| `RATE_LIMIT_MAX` | `60` | Higher than dev default for judge testing |
| `TOKEN_BUDGET_FLOOR` | `200` | Budget guard threshold |
| `MOCK_NKENNE` | `false` | Optional; `true` for zero-token development |

**Health check:** `GET /api/health` returns `200` with dataset stats, token balance, cache stats, and `mode: "mock" | "live"`. Render uses this for liveness.

**Cold start:** ~30s on free tier (container restart + dataset load of 2,448 records). Documented in README.

**Persistence:** Render free tier has no persistent disk — `data/sessions.db` and `data/groq-cache.jsonl` reset on redeploy. Sessions from a previous instance are lost; new sessions are created transparently. For production, Railway with a mounted volume and `SESSION_DB_PATH` / `GROQ_CACHE_PATH` pointed at the volume is a 10-minute migration — the config already supports it.

**Observability:** every request logged as structured JSON with `requestId`, `method`, `path`, `status`, `durationMs`. Response headers include `X-Request-Id`, `RateLimit-*`. `/api/health` exposes dataset, token, and cache telemetry.

---

## 12. Known limitations

Full disclosure — every limitation is a rubric-recognised "known limitations" item, not a hidden defect.

**Deployment**

- **Live demo token exhaustion.** All 2,000 NKENNEAi tokens were consumed during development (see §10). The budget guard blocks further API calls. The first-turn demo card renders in Swahili from the curated map + response cache. TTS audio is disabled; new inputs not covered by the curated map fall back to English. Local clone + `MOCK_NKENNE=true` exercises the full pipeline without any tokens.
- **Live demo Cloudflare limitation.** NKENNEAi's API is fronted by Cloudflare, which blocks requests from cloud-provider IP ranges (Render, AWS, GCP) as bot traffic. During development on Render's infrastructure, translation and TTS calls intermittently returned HTML error pages (`<!DOCTYPE ...`) instead of JSON. Same calls from a residential IP succeed consistently. Even with restored token balance, TTS and translation from the deployed container would fail intermittently. Mitigations: curated map pre-translates 22+ demo strings; per-field cache; non-JSON detection with retry; disabled play button rather than missing button. See `lib/nkenne.js`.

**Data and coverage**

- **Nigerian source bias.** The dataset comes from Nigerian agricultural research (IITA, NAERLS, NRCRI). Fall armyworm, cassava mosaic, and storage pests are broadly transferable to East Africa. Crop spacing, fertiliser schedules, and some variety recommendations are Nigeria-specific and would need re-verification against TARI/KALRO/NARO before East African deployment.
- **13 gold diagnostics.** Expanded from 7 after an audit identified the original set as too small. Still short of the 30+ target. Coverage: maize (3), cassava (2), tomato (2), striga, cowpea, groundnut, rice, plus 2 refusals. Expanding with agronomist review is roadmap.
- **Agronomic correctness is not benchmarked.** The tests verify software behavior, not that diagnoses are correct in the field. An independent 500-case expert-reviewed benchmark is roadmap (§16).

**API-level**

- **STT requires direct phone-mic recording.** All STT tests used recorded audio with clean conditions. Real farmer audio includes wind, dialect variation, and background noise. The voice note UI (volume bars, preview, send) is fully functional; the ASR quality depends on a proper mobile device microphone. Desktop-browser-plus-phone-speaker works intermittently (8 of 12 successful during development).
- **NKENNEAi translation of scientific names is unreliable.** Curated map addresses the visible fields; free-form action items may occasionally mistranslate and are defended by the sanity check + English fallback.
- **Only Swahili supported.** NKENNEAi's other languages (Yoruba, Nigerian Pidgin) were documented but out of scope for this event.

**Provenance**

- **Provenance is curated, not retrieved.** `fact_ids` are attached from whitelist entries when a confident keyword match exists, not looked up from a fact ledger in real time. The fact ledger exists in the ARIS parent repository; wiring it into a retrieval pipeline is roadmap. **Judges assessing provenance should evaluate it as "curated and consistent" rather than "retrieved and verified."**

**System-level**

- **No persistent storage on free tier.** Sessions and cache reset on redeploy.
- **No user accounts.** Rate limit is IP-based; no login, no password, no PII beyond the farmer's typed input.
- **Session access control is shipped.** `POST /api/chat` returns a `sessionToken` on new session creation. `GET /api/session/:id` and `POST /api/session/:id/close` require `Authorization: Bearer <sessionToken>` and return 401 otherwise. `/api/chat` continues to accept just `sessionId` so a conversation can continue without re-supplying the token — this is intentional so the farmer experience stays frictionless, but means a leaked `sessionId` still allows posting new messages into that session. For commercial deployment, session access should be tied to authenticated user identity (§16.1 workstream 4).
- **No photos.** NKENNEAi has no vision API.
- **Reasoning model is a general-purpose LLM, not a fine-tuned agricultural model.** The ARIS Qwen 1.5B fine-tune exists but isn't deployed in the hackathon demo for latency reasons. It is the offline deployment path.
- **Offline deployment is not part of this submission.** Separate ARIS product line (Qwen 1.5B on CPU, no network required), built for air-gapped contexts.

**Testing**

- **Integration tests use mocked APIs.** No live NKENNEAi or Groq calls in the test suite by design (zero token cost). Manual verification during development is documented in `TOKEN_LOG.md`.
- **Agronomic correctness not tested.** The 52 tests verify software behavior. A 500-case expert-reviewed benchmark is required to verify field correctness (§16).

---

## 13. Future work and adoption path

**Path to adoption:**

1. **Pilot with an existing extension network.** The dataset is already aligned with IITA and NAERLS materials; a natural partner is an NGO already using those sources (e.g. Sasakawa Africa Association, Farm Africa). Deployment: 50 extension officers, 500 farmers, 3 months, measure yield variance against a control group.
2. **Offline-first deployment for low-connectivity regions.** The ARIS Qwen 1.5B fine-tune runs on CPU at ~8s per advisory. Bundled with a local whisper.cpp STT and a small TTS, the entire system can run on a Raspberry Pi 4 with no internet.
3. **WhatsApp Business API integration.** The median East African smallholder farmer has WhatsApp but not email.
4. **Extension-officer dashboard.** Aggregate anonymous advisories into a heatmap of what's happening in which region.

**Technical roadmap:**

- **Fact-ledger retrieval.** Populate `provenance.fact_ids` from a real ledger with retrieval scoring, replacing the current whitelist-derived IDs.
- **Playwright end-to-end tests.** Browser-flow regression suite against the live deployed app.
- **Session authorization (shipped).** Per-session bearer token returned at creation; required on `GET /api/session/:id` and `POST /api/session/:id/close`. Chat continuation is not token-gated so the demo remains frictionless — see §12 for the security trade-off.
- **Gold diagnostic expansion (shipped).** 7 → 13 records with contrastive coverage.
- **Safety regression suite (shipped).** 5 tests covering contraction negation, Swahili negation, non-string labels, empty labels, case-insensitive matching.
- **Mock mode (shipped).** Zero-token development via `MOCK_NKENNE=true`.
- **Agronomic correctness benchmark.** 500-case independent expert-reviewed test suite.
- **Multi-language expansion.** Yoruba, Nigerian Pidgin, Kikuyu — pending NKENNEAi API availability.
- **Vision-based diagnosis.** Photo upload for symptom confirmation.
- **Confidence calibration.** Rule-based escalation replaced by a calibrated classifier.

---

## 14. Third-party dependencies

**Runtime:** `express` (4.19), `multer` (2.0), `better-sqlite3` (13.0), `pino` (9.x), `pino-http` (10.x), `pino-pretty` (13.x), `helmet` (8.x), `cors` (2.8), `express-rate-limit` (7.x), `nanoid` (5.x), `dotenv` (16.x), `ajv` (8.x — used by `scripts/validate-gold.mjs`).

**External services:** NKENNEAi API (developers-api.nkenne.ai), Groq API (api.groq.com).

**Data sources:** Prior ARIS work — IITA, NAERLS, NRCRI, NCRI, NIHORT, NSPRI, NAPRI, NVRI, FMARD, NiMet, state ADPs.

**Pre-existing work disclosed:** The ARIS dataset (2,448 records), the `advisory_episode` schema, and the ARIS Qwen 1.5B fine-tune are the author's prior work from the Africa Deep Tech Challenge. The NKENNEAi hackathon build wraps this existing work with the voice pipeline, structured reasoning layer, bilingual UI, and production deployment.

---

## 15. License

MIT. See `LICENSE`.

---

## 16. Commercialisation roadmap

This section describes what would be required to move ARIS-SW from a working hackathon submission to a commercially deployable product. It is explicitly forward-looking — none of the items below are implemented in the current build.

**The distinction that matters.** A hackathon-ready application demonstrates that a workflow is *possible*. A commercial product demonstrates that the workflow is *safe, reliable, supportable, and economically sustainable at scale*. ARIS-SW is firmly in the first category. Getting to the second is seven workstreams of engineering, agronomy, and validation, estimated at 16 weeks for a small competent team.

### 16.1 Seven commercialisation workstreams

**1. Agronomic reliability (first release blocker).**

ARIS gives advice that can influence crop losses, pesticide use, and farmer income. This is the workstream that gates everything else.

- **Fact ledger.** Every recommendation must trace to a stable fact ID with source URL, exact claim, publication date, geographic applicability, and review status. Current `fact_ids` are curated labels attached from a whitelist entry — not retrieved evidence. This must be closed before commercial advice is given.
- **Evidence-gated diagnosis.** Current implementation requires a canonical label match, short-name, or 2+ distinct keyword hits. A commercial product needs crop-specific symptom discriminators with multiple plausible differentials, not a keyword threshold.
- **Independent benchmark.** 500+ expert-reviewed cases, held out from prompt construction and few-shot examples. Includes lookalike conditions, ambiguous complaints, wrong crop identification, and cases where refusal is correct.
- **Regional separation.** The dataset derives from Nigerian sources. East African deployment requires re-verification against TARI, KALRO, and NARO for recommendations that are not pan-African.

**2. Product architecture (dependability).**

- Timeouts, retries with backoff, circuit breakers, graceful degradation for every external API.
- Managed, backed-up database with migrations and tested restoration.
- Cache keys including conversation context, model version, prompt version, knowledge-base version.
- Full request/response schema validation and versioned endpoints.
- Background queue for long audio and translation jobs.
- Load testing, connection limits, capacity planning.
- Documented backup, recovery, incident procedures.

**3. Language and voice validation.**

- Test STT on real recordings from target users — multiple accents, background noise, agricultural vocabulary, quantities, dates, safety instructions.
- Test translation of crop names, symptom descriptions, and pesticide labels for accuracy and consistency.
- Preserve numbers, units, and timing instructions exactly — a mistranslated pre-harvest interval is a food-safety issue.
- Measure language support per-language, not by whether an API accepts a language code.
- Provide text fallback and replay mechanism when audio fails.

**4. Security, privacy, and data governance.**

- User and administrator authentication with role-based permissions.
- TLS, secret management, dependency scanning, secure deployment configuration.
- Redaction of sensitive information from logs; controlled retention and deletion of recordings and transcripts.
- Documented privacy notice, lawful processing basis, consent mechanism, data-subject request process.
- For Nigerian deployment, assess obligations under the Nigeria Data Protection Act 2023.
- Use OWASP API Security Top 10 as a baseline.
- Review provider data-handling and commercial-use terms.

**5. Production operations and support.**

- CI/CD pipeline with automated tests on every change.
- Separate development, staging, and production environments.
- Error reporting, structured logs, service health monitoring, alerts.
- Monitoring for API failures, latency, token consumption, translation errors, and diagnostic safety failures.
- Rollback capability.
- Customer support, incident escalation, agronomic review process.
- Documented uptime targets, maintenance windows, service limitations.

**6. Commercial model.**

Cost per completed advisory = STT + reasoning + translation + TTS + infrastructure, plus failed requests, retries, support, payments, taxes, and partner commissions.

Routes to market:

- **Direct-to-farmer.** Lightweight web app, messaging interface, or voice channel. Test willingness to pay carefully.
- **Institutional licensing.** Cooperatives, NGOs, agricultural programmes, extension services pay for access, reporting, training, and support. Recommended initial path.
- **Agricultural business partnerships.** Input retailers and agribusinesses sponsor access or integrate advisory features, with safeguards against biased recommendations.

**7. Controlled paid pilot.**

A small cohort through a cooperative or extension partner. Monitor failures, advice quality, retention, support demand, cost per successful advisory.

### 16.2 Launch-readiness checklist

Current state against a commercial launch standard. **Honest count: 2 of 12 complete, 3 partial, 7 not started.**

| # | Category | Item | Status |
|---|---|---|---|
| 1 | Agronomic safety | Reviewed source ledger with traceable advice | ❌ Roadmap |
| 2 | Agronomic safety | No known critical unsafe-advice failures in the release benchmark | ❌ No benchmark |
| 3 | Agronomic safety | Uncertain and high-risk cases handled through safe triage or referral | ✅ Implemented |
| 4 | Product reliability | Complete voice-to-advisory workflow tested on real recordings | ❌ Field audio untested |
| 5 | Product reliability | Timeouts, retries, fallbacks, and recovery verified | ⚠️ Partial (retries + fallback yes; circuit breaker + tested recovery no) |
| 6 | Product reliability | Backups restored successfully in a test | ❌ Not implemented |
| 7 | Security and privacy | Session ownership and access controls tested | ✅ Closed post-submission |
| 8 | Security and privacy | Privacy notice, retention, and deletion procedures in place | ❌ Not implemented |
| 9 | Security and privacy | Provider data-handling and commercial-use terms reviewed | ❌ Not reviewed |
| 10 | Commercial operations | Cost per successful advisory measured | ⚠️ Partial (token cost tracked, full cost no) |
| 11 | Commercial operations | Monitoring, alerts, and rollback operational | ⚠️ Partial (logs + health yes; alerts + rollback no) |
| 12 | Commercial operations | Pilot users, support owner, and success metrics defined | ❌ Not started |

### 16.3 Phased rollout (16 weeks for a small competent team)

These are planning estimates, not guaranteed delivery dates.

**Weeks 1–3 — Stabilise.**

Close remaining audit findings, enforce full schema validation, complete session access controls (done), document all external dependencies. Gate: no known critical security or diagnosis-control defect.

**Weeks 4–7 — Validate.**

Build reviewed knowledge base, create held-out benchmark, test real voice recordings, establish safety and language acceptance criteria. Gate: agronomic and language performance meets pre-agreed thresholds. **This phase requires an agronomist — it cannot be completed by engineers alone.**

**Weeks 8–11 — Production hardening.**

Managed infrastructure, backups, monitoring, privacy controls, CI/CD, cost limits, recovery procedures. Load and security testing.

**Weeks 12–16 — Controlled paid pilot.**

Small cohort through a cooperative or extension partner. Monitor failures, advice quality, retention, support demand, cost per successful advisory.

### 16.4 Design principle

A smaller agricultural advisor that knows when it does not know is more commercially valuable than a universal advisor that occasionally invents the answer. The evidence-gated diagnosis implemented after the audit follows this principle: single ambiguous keywords no longer commit a diagnosis, confidence only escalates when a specific evidence term is present, and unmatched labels are preserved as `unconfirmed` with cleared provenance and a field-confirmation question.

Expansion to more crops, more languages, and more regions should wait until the initial coverage is reliable. A feature that exists but occasionally gives wrong advice is worse than a feature that does not exist.

### 16.5 The immediate next step

The highest-leverage action is not another feature or another code refactor. It is a conversation with an agricultural extension officer in Nigeria or East Africa who will review 20 cases in exchange for being credited as an advisor on the next submission. Every workstream in this document assumes expert agronomic input is available. Without it, no amount of infrastructure makes the advice safe to act on.

The current repository is a working demonstration that the workflow is possible. Turning it into a product that farmers can depend on requires a team, not a sprint.
