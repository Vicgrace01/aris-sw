# API Reference

Base URL: `http://localhost:3000` (dev) or your deployed URL.

All responses include `requestId` in the JSON body and `X-Request-Id` header for correlation.

All errors follow `{ error: CODE, message: string, details?: any, requestId: string }`.

---

## `GET /api/health`

Liveness + telemetry.

**Response 200**:
```json
{
  "ok": true,
  "env": "development",
  "uptime": 141,
  "dataset": {
    "total": 2448, "clean": 2120, "templatedExcluded": 335,
    "goldDiagnostics": 7, "swahiliAvailable": false,
    "byKind": { "diagnostic_episode": 7, "fact_only": 2031, "refusal": 82 },
    "crops": 16
  },
  "tokens": { "calls": 2, "tokensTracked": 0, "lastTokensRemaining": 983 },
  "groqCache": { "size": 1, "persistent": true, "path": "...", "translation": { "size": 0, "knownLabels": 16 } },
  "requestId": "CaWSfpIbZsxS"
}
POST /api/chat
Session-aware chat. Creates a session on first call, resumes on subsequent calls. Handles triage answers automatically.

Request:

json
{ "sessionId": "o2Sb0wd3ME50Tm_n", "input": "Mahindi yangu yana matundu kwenye majani" }
sessionId is optional. Omit it on the first message — the response will include the new sessionId.

Response 200:

json
{
  "sessionId": "o2Sb0wd3ME50Tm_n",
  "advisory": {
    "record_kind": "diagnostic_episode",
    "context": { "crop": "maize", "growth_stage": "vegetative", "chief_complaint_en": "Maize leaves have holes." },
    "triage": { "observed_signs": ["holes in leaves"], "missing_discriminators": ["presence_of_frass"], "questions": [ ... ] },
    "diagnosis": {
      "primary": { "label": "Fall armyworm (Spodoptera frugiperda)", "label_sw": "Viwavi jeshi (Spodoptera frugiperda)", "confidence": "possible" },
      "differentials": [ { "label": "...", "ruled_out_because": "..." } ],
      "confidence_basis": "..."
    },
    "advice": {
      "immediate": [ { "action_en": "...", "action_sw": "...", "timeframe": "today" } ],
      "preventive": [ ... ],
      "do_not": [ { "text_en": "...", "text_sw": "...", "reason": "..." } ]
    },
    "escalation": { "trigger_en": "...", "trigger_sw": "...", "referral": "...", "urgency": "medium" },
    "provenance": { "fact_ids": ["FAW-001", "FAW-002", "FAW-003"], "source_names": ["IITA", "NAERLS"] },
    "policy_trace": [ ... ]
  },
  "advisoryMessageId": "BQX1sGl_iPKs0ZCt",
  "pendingQuestions": [ { "field": "presence_of_frass", "ask_en": "...", "ask_sw": "..." } ],
  "cached": false,
  "translation": { "total": 5, "translated": 4, "fallback": 1 },
  "diagnosisEnforced": true,
  "metadata": { "retried": false, "fewShotsUsed": 3, "detectedLang": "sw", "detectedCrop": "maize" },
  "requestId": "Igvg9bpk_7LK"
}
Fields to check:

cached: true — served from disk cache, 0 tokens

pendingQuestions — non-empty means there are triage questions waiting

diagnosisEnforced: true — Groq's label was snapped to the whitelist

degraded: true — reasoning failed; a fallback refusal advisory is returned (never crashes)

POST /api/reason
Stateless reasoning (no session). Same advisory schema, no persistence. Useful for testing.

Request: { "input": "text" }

Response: { advisory: {...}, retried, fewShotsUsed, detectedLang, detectedCrop, cached, translation, diagnosisEnforced, requestId }

POST /api/session
Create an empty session explicitly.

Request: { "context": {} } (optional)

Response 201: { "sessionId": "...", "session": {...}, "requestId": "..." }

GET /api/session/:id
Retrieve full session with message history.

Response: { "session": { "id", "createdAt", "status", "context", "messages": [...], "pendingTriage": {...} }, "requestId" }

POST /api/session/:id/close
Mark session as closed and clear pending triage.

Response: { "sessionId": "...", "status": "closed", "previousStatus": "active", "requestId" }

POST /api/stt
NKENNEAi speech-to-text. Multipart form-data with audio field.

Request: audio = .wav / .mp3 / .m4a / .flac / .ogg blob (max 25MB)

Response 200: { "text": "Mahindi yangu yana matundu", "duration": 3.45, "language": "swahili", "requestId" }

POST /api/translate
NKENNEAi translation. English ⇄ Swahili only (hackathon constraint).

Request: { "text": "...", "from": "English", "to": "Swahili" }

Response: { "translatedText": "...", "tokensRemaining": 900, "requestId" }

POST /api/tts
NKENNEAi text-to-speech. Returns binary audio.

Request: { "text": "..." }

Response 200: Content-Type: audio/mpeg (binary stream)

Error codes
CodeHTTPMeaning
VALIDATION_ERROR400Invalid request body
NOT_FOUND404Route or session not found
RATE_LIMITED429>30 requests/min (default)
UPSTREAM_FAILED502NKENNEAi or Groq returned an error
UPSTREAM_TIMEOUT504Upstream timed out
SCHEMA_INVALID500Reasoning output failed schema after retry
INTERNAL_ERROR500Unexpected (surfaces message in dev)
Rate limits
30 requests / 60 seconds / IP (default, configurable via RATE_LIMIT_MAX)

RateLimit-Remaining and RateLimit-Reset headers returned on every response

/api/chat with a cached input still counts against the limit — that's intentional