# API Reference

Base URL: `http://localhost:3000` (dev) or `https://aris-sw.onrender.com` (deployed).

All responses include `requestId` in the JSON body and `X-Request-Id` header for correlation.

All errors follow `{ error: CODE, message: string, details?: any, requestId: string }`.

---

## Authentication

Only `/api/session/:id` and `/api/session/:id/close` require authentication. All other endpoints are open (rate-limited per IP).

Session authentication uses a per-session bearer token. The token is returned **once** by `/api/chat` when a new session is created, or by `POST /api/session`. Store it client-side and send it as `Authorization: Bearer <token>` on session retrieval.

`POST /api/chat` itself does **not** require the token — a conversation can continue by sending just `sessionId`. See REPORT.md §12 for the trade-off this implies.

---

## `GET /api/health`

Liveness and telemetry. No authentication.

**Response 200**:

```json
{
  "ok": true,
  "env": "production",
  "uptime": 141,
  "dataset": {
    "total": 2448,
    "clean": 2120,
    "templatedExcluded": 335,
    "goldDiagnostics": 7,
    "swahiliAvailable": false,
    "byKind": { "diagnostic_episode": 7, "fact_only": 2031, "refusal": 82 },
    "crops": 16
  },
  "tokens": {
    "calls": 2,
    "tokensTracked": 0,
    "lastTokensRemaining": 530,
    "budget": {
      "floor": 200,
      "lastTokensRemaining": 530,
      "exhausted": false,
      "blockedCalls": 0
    }
  },
  "groqCache": {
    "size": 1,
    "persistent": true,
    "path": "/app/data/groq-cache.jsonl",
    "cacheVersion": 7,
    "promptVersion": "2.2.0",
    "model": "qwen/qwen3.8-27b",
    "translation": { "size": 0, "knownLabels": 22 }
  },
  "requestId": "CaWSfpIbZsxS"
}
```

Fields of note:
- `tokens.budget.exhausted` — when `true`, NKENNEAi API calls are blocked (advisory renders in English only)
- `groqCache.cacheVersion` and `promptVersion` — bump these in `lib/groq.js` to invalidate stale cache entries
- `dataset.goldDiagnostics` — count of hand-verified diagnostic episodes used for few-shot selection

---

## `POST /api/chat`

Session-aware chat. Creates a session on first call, resumes on subsequent calls. Handles triage answers automatically.

**Request**:

```json
{
  "sessionId": "o2Sb0wd3ME50Tm_n",
  "input": "Mahindi yangu yana matundu kwenye majani"
}
```

`sessionId` is optional. Omit it on the first message — the response will include both a new `sessionId` and a new `sessionToken`.

**Response 200**:

```json
{
  "sessionId": "o2Sb0wd3ME50Tm_n",
  "sessionToken": "KB7yVgAl-KBnDc_F9h0x6kWoD2MaaMMe",
  "advisory": {
    "record_kind": "diagnostic_episode",
    "language": "en",
    "channel": "voice",
    "context": { "crop": "maize", "growth_stage": "vegetative", "chief_complaint_en": "Maize leaves have holes." },
    "triage": {
      "observed_signs": ["holes in leaves"],
      "missing_discriminators": ["presence_of_frass"],
      "questions": [
        {
          "field": "presence_of_frass",
          "ask_en": "Do you see sawdust-like waste inside the leaf whorl?",
          "ask_sw": "Unaona kinyesi kinachofanana na vumbi la mbao ndani ya kilele cha mmea?",
          "why": "Fresh frass indicates FAW activity."
        }
      ]
    },
    "diagnosis": {
      "primary": {
        "label": "Maize stem borer (Busseola fusca)",
        "label_sw": "Funza wa shina la mahindi (Busseola fusca)",
        "confidence": "possible"
      },
      "differentials": [
        { "label": "Fall armyworm (Spodoptera frugiperda)", "ruled_out_because": "..." }
      ],
      "confidence_basis": "Voice description only; discrminators not yet answered."
    },
    "advice": {
      "immediate": [
        { "action_en": "Inspect the whorls of 10 plants for larvae or frass.", "action_sw": "Angalia mizizi ya mimea 10 kwa ajili ya wadudu au frass.", "timeframe": "today" }
      ],
      "preventive": [
        { "action_en": "Scout fields weekly during vegetative stage.", "action_sw": "...", "timeframe": "next season" }
      ],
      "do_not": [
        { "text_en": "Do not apply any pesticide without a confirmed diagnosis.", "text_sw": "Usitumie dawa yoyote bila utambuzi uliothibitishwa...", "reason": "Unverified dosage is highest-risk." }
      ]
    },
    "escalation": {
      "trigger_en": "If symptoms spread to more than 20% of plants...",
      "trigger_sw": "Ikiwa dalili zinaenea kwa zaidi ya 20% ya mimea...",
      "referral": "Contact your local agricultural extension officer.",
      "urgency": "medium"
    },
    "provenance": {
      "fact_ids": ["SB-001", "SB-002"],
      "source_names": ["IITA", "NAERLS"]
    },
    "policy_trace": [
      { "step": "intake", "action": "set_context" },
      { "step": "triage", "action": "ask_clarification" },
      { "step": "diagnose", "action": "commit_likely" },
      { "step": "advise", "action": "emit_advice" },
      { "step": "close", "action": "schedule_follow_up" }
    ]
  },
  "advisoryMessageId": "BQX1sGl_iPKs0ZCt",
  "pendingQuestions": [
    {
      "field": "presence_of_frass",
      "ask_en": "Do you see sawdust-like waste inside the leaf whorl?",
      "ask_sw": "Unaona kinyesi kinachofanana na vumbi la mbao ndani ya kilele cha mmea?",
      "why": "Fresh frass indicates FAW activity."
    }
  ],
  "cached": false,
  "translation": { "total": 6, "translated": 5, "fallback": 1 },
  "diagnosisEnforced": true,
  "diagnosisUnsupported": false,
  "degraded": false,
  "metadata": {
    "retried": false,
    "fewShotsUsed": 3,
    "detectedLang": "sw",
    "detectedCrop": "maize",
    "cached": false
  },
  "cacheMeta": {
    "cacheVersion": 7,
    "promptVersion": "2.2.0",
    "model": "qwen/qwen3.8-27b"
  },
  "requestId": "Igvg9bpk_7LK"
}
```

**Response fields to check**:

| Field | Meaning |
|---|---|
| `sessionToken` | Present **only** on new session creation. Store client-side; required for `/api/session/:id` |
| `cached: true` | Served from disk cache — 0 NKENNEAi tokens spent |
| `pendingQuestions` | Non-empty means triage questions are queued; the next `/api/chat` call with the same `sessionId` is treated as the answer to the first one |
| `diagnosisEnforced: true` | Groq's label matched a whitelist entry confidently and was snapped to canonical |
| `diagnosisUnsupported: true` | No confident whitelist match — model's label preserved as `unconfirmed`, `provenance.fact_ids` cleared |
| `degraded: true` | Reasoning failed entirely; a fallback refusal advisory is returned. Never crashes |
| `translation` | `total` is the number of translatable fields (grows with triage questions); `translated` is how many held Swahili; `fallback` is English-with-marker count |
| `cacheMeta` | Version stamps for the cache entry. All three must match the current build for a cache hit |

---

## `POST /api/reason`

Stateless reasoning (no session, no persistence). Same advisory schema as `/api/chat`, no cache lookup, no cache write. Useful for testing.

**Request**:

```json
{ "input": "Mahindi yangu yana matundu kwenye majani" }
```

**Response 200** — same shape as `/api/chat` minus `sessionId`, `sessionToken`, `advisoryMessageId`, `pendingQuestions`:

```json
{
  "advisory": { ... },
  "retried": false,
  "fewShotsUsed": 3,
  "selectionMode": "diagnostic_only",
  "selectedExamples": [
    { "id": "SW-GOLD-0001", "kind": "diagnostic_episode" },
    { "id": "SW-GOLD-0004", "kind": "diagnostic_episode" },
    { "id": "SW-GOLD-0007", "kind": "diagnostic_episode" }
  ],
  "detectedLang": "sw",
  "detectedCrop": "maize",
  "cached": false,
  "translation": { "total": 6, "translated": 6, "fallback": 0 },
  "diagnosisEnforced": true,
  "diagnosisUnsupported": false,
  "cacheMeta": { "cacheVersion": 7, "promptVersion": "2.2.0", "model": "qwen/qwen3.8-27b" },
  "requestId": "..."
}
```

`selectionMode` is `"diagnostic_only"` when the input contains a crop and symptom words, `"mixed"` otherwise. `selectedExamples` shows which gold or dataset records fed the few-shot prompt — useful for debugging why a particular advisory was produced.

---

## `POST /api/session`

Create an empty session explicitly (rather than waiting for the first `/api/chat`).

**Request**:

```json
{ "context": {} }
```

`context` is optional. Any values there become the initial session context.

**Response 201**:

```json
{
  "sessionId": "A4G3ze-EREQB_9Fj",
  "sessionToken": "KB7yVgAl-KBnDc_F9h0x6kWoD2MaaMMe",
  "session": {
    "id": "A4G3ze-EREQB_9Fj",
    "createdAt": 1792857600000,
    "updatedAt": 1792857600000,
    "status": "active",
    "context": {},
    "messages": [],
    "pendingTriage": null
  },
  "requestId": "..."
}
```

**The `sessionToken` is returned only here** (or on the first `/api/chat` call). It cannot be retrieved later. Store it.

---

## `GET /api/session/:id`

Retrieve full session with message history. **Requires authentication.**

**Headers**:

```
Authorization: Bearer KB7yVgAl-KBnDc_F9h0x6kWoD2MaaMMe
```

**Response 200**:

```json
{
  "session": {
    "id": "A4G3ze-EREQB_9Fj",
    "createdAt": 1792857600000,
    "updatedAt": 1792857680000,
    "status": "active",
    "context": { "crop": "maize", "lastConfidence": "possible" },
    "messages": [
      {
        "id": "msg-1",
        "role": "user",
        "kind": "user_text",
        "content": { "text": "Mahindi yangu yana matundu kwenye majani" },
        "createdAt": 1792857601000
      },
      {
        "id": "msg-2",
        "role": "assistant",
        "kind": "advisory",
        "content": { "record_kind": "diagnostic_episode", "diagnosis": { ... } },
        "createdAt": 1792857610000
      }
    ],
    "pendingTriage": {
      "questions": [ { "field": "presence_of_frass", "ask_en": "...", "ask_sw": "..." } ],
      "advisoryMessageId": "msg-2"
    }
  },
  "requestId": "..."
}
```

**Response 401** if the token is missing or does not match:

```json
{
  "error": "UNAUTHORIZED",
  "message": "A valid session token is required to retrieve this session",
  "requestId": "..."
}
```

---

## `POST /api/session/:id/close`

Mark session as closed and clear pending triage. **Requires authentication.**

**Headers**:

```
Authorization: Bearer KB7yVgAl-KBnDc_F9h0x6kWoD2MaaMMe
```

**Response 200**:

```json
{
  "sessionId": "A4G3ze-EREQB_9Fj",
  "status": "closed",
  "previousStatus": "active",
  "requestId": "..."
}
```

**Response 401** if the token is missing or invalid.

---

## `POST /api/stt`

NKENNEAi Speech-to-Text. Multipart form-data with `audio` field.

**Request**: `audio` = WAV / MP3 / M4A / FLAC / OGG blob, max 25 MB. Browser WebM is converted to WAV client-side before upload — the endpoint does not accept WebM.

**Response 200**:

```json
{
  "text": "Mahindi yangu yana matundu",
  "duration": 3.45,
  "language": "swahili",
  "requestId": "..."
}
```

**Response 500** if transcription returns empty (no recognizable Swahili found in the audio):

```json
{
  "error": "UPSTREAM_FAILED",
  "message": "Empty transcription result",
  "requestId": "..."
}
```

---

## `POST /api/translate`

NKENNEAi translation. English ↔ Swahili only (hackathon constraint).

**Request**:

```json
{ "text": "Inspect the whorls of 10 plants for larvae or frass.", "from": "English", "to": "Swahili" }
```

**Response 200**:

```json
{
  "translatedText": "Angalia mizizi ya mimea 10 kwa ajili ya wadudu au frass.",
  "tokensRemaining": 530,
  "requestId": "..."
}
```

**Response 502** if NKENNEAi returns a non-JSON body (Cloudflare block page, transient gateway error) after internal retries:

```json
{
  "error": "UPSTREAM_FAILED",
  "message": "Non-JSON response from NKENNEAi (HTTP 403)",
  "requestId": "..."
}
```

**Response 429** if the NKENNEAi token budget is below `TOKEN_BUDGET_FLOOR` (default 200):

```json
{
  "error": "UPSTREAM_FAILED",
  "message": "TOKEN_BUDGET_EXHAUSTED (translate): 0 left, floor 200",
  "requestId": "..."
}
```

---

## `POST /api/tts`

NKENNEAi Text-to-Speech. Returns binary audio.

**Request**:

```json
{ "text": "Funza wa shina la mahindi" }
```

Parenthetical scientific names are stripped before send — `Funza wa shina la mahindi (Busseola fusca)` becomes `Funza wa shina la mahindi`. TTS engines fail on the parenthetical form.

**Response 200**: `Content-Type: audio/mpeg` (or `audio/wav`) — binary stream.

**Response 502** if TTS fails after 3 retries. The frontend renders a disabled play button with tooltip rather than omitting the button entirely.

**Response 429** if token budget exhausted — same shape as translate.

---

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Invalid request body (missing field, wrong type, exceeds length limit) |
| `UNAUTHORIZED` | 401 | Missing or invalid session bearer token |
| `NOT_FOUND` | 404 | Route or session not found |
| `RATE_LIMITED` | 429 | More than 60 requests/min/IP (deployed) or 30 (dev default) |
| `UPSTREAM_FAILED` | 502 | NKENNEAi or Groq returned an error, or token budget exhausted |
| `UPSTREAM_TIMEOUT` | 504 | Upstream service timed out |
| `SCHEMA_INVALID` | 500 | Reasoning output failed schema after retry |
| `INTERNAL_ERROR` | 500 | Unexpected error. In development, the message is surfaced; in production it is sanitised |

---

## Rate limits

- **Production (deployed)**: 60 requests / 60 seconds / IP (`RATE_LIMIT_MAX=60`)
- **Development (default)**: 30 requests / 60 seconds / IP (`RATE_LIMIT_MAX=30`)

`RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers are returned on every response so clients can back off gracefully.

`/api/chat` with a **cached** input still counts against the rate limit — the request is logged and processed; only the NKENNEAi token cost is skipped. This is intentional: rate limits protect the server from load, not just token expenditure.
