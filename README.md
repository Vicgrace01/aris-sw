<div align="center">

# 🌾 ARIS-SW

**Swahili voice-first agricultural advisory for smallholder farmers**

[![Live Demo](https://img.shields.io/badge/demo-live-22b57f?style=flat-square)](https://aris-sw.onrender.com)
[![NKENNEAi](https://img.shields.io/badge/NKENNEAi-STT%20%C2%B7%20Translate%20%C2%B7%20TTS-2b9bf0?style=flat-square)](https://nkenne.ai)
[![Tests](https://img.shields.io/badge/tests-33%20passing-22b57f?style=flat-square)](#testing)
[![License](https://img.shields.io/badge/license-MIT-8a9bb0?style=flat-square)](LICENSE)

[Live Demo](https://aris-sw.onrender.com) · [Technical Report](REPORT.md) · [Architecture](ARCHITECTURE.md) · [API Reference](API.md) · [Token Log](TOKEN_LOG.md)

</div>

---

> A farmer in Tanzania notices holes in her maize leaves. She cannot read English. She does not know an extension officer. She asks a shopkeeper, who sells her the wrong pesticide.
>
> ARIS-SW lets her speak Swahili into her phone and hear advice back — triaged, structured, safety-checked, and grounded in verified agricultural sources.

---

## 📋 Table of Contents

- [The Problem](#-the-problem)
- [What ARIS-SW Does](#-what-aris-sw-does)
- [See It Working](#-see-it-working)
- [How It Works](#-how-it-works)
- [NKENNEAi APIs Used](#-nkenneai-apis-used)
- [Why This Is Not a Wrapper](#-why-this-is-not-a-wrapper)
- [Tech Stack](#-tech-stack)
- [Quick Start](#-quick-start)
- [Testing](#-testing)
- [Project Structure](#-project-structure)
- [Documentation Map](#-documentation-map)
- [Roadmap](#-roadmap)
- [Known Limitations](#-known-limitations)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🔍 The Problem

East Africa has roughly **one agricultural extension officer for every 5,000 smallholder farmers**.

A farmer who notices a crop problem today has three options:

1. **Wait** for a rare extension visit — often weeks, sometimes never
2. **Ask a neighbour** — knowledge of uncertain accuracy, no source
3. **Buy a pesticide** on a shopkeeper's suggestion — and incorrect pesticide decisions are the highest-cost, highest-risk mistake a smallholder can make

Most digital advisory tools require typing in English. The farmer speaks Swahili. The result is a diagnostic gap measured in yield loss, not in inconvenience.

Existing AI chatbots make it worse, not better: they produce confident prose that can invent a pesticide dosage — the single most dangerous failure mode in farm advisory.

**ARIS-SW is built around that constraint.** It refuses to prescribe doses. It asks before it diagnoses. It escalates to a human when it should.

---

## ✅ What ARIS-SW Does

| Capability | What it means in practice |
|---|---|
| 🎤 **Voice-first** | Farmer speaks Swahili; system responds with Swahili audio |
| 🔀 **Multi-turn triage** | Asks 1–3 clarifying questions before committing to a diagnosis |
| 🧠 **Structured advisory** | Every response is a validated JSON object, not prose |
| 🛡️ **Safety by design** | Refuses pesticide/veterinary doses without field confirmation |
| 🌍 **Bilingual** | SW/EN toggle switches both labels and content |
| 📊 **Provenance** | Every advisory cites `fact_ids` and source bodies |
| 💾 **Cost-controlled** | Disk-cached responses; budget guard degrades gracefully |
| 🐳 **Deployable** | Multi-stage Docker, health check, structured logs |

### What the farmer sees

```
┌─────────────────────────────────────────────┐
│ Utambuzi        Fall armyworm (Spodoptera)  │
│ Hatua za haraka • Open the whorl of 10 …    │
│                 • Contact extension officer │
│ Usifanye        • Do not spray without …    │
│ Peleka kwa …    If >20% of plants show …    │
│                                             │
│              🔊 Sikiliza kwa Kiswahili      │
└─────────────────────────────────────────────┘
```

---

## 🎬 See It Working

**Live:** [https://aris-sw.onrender.com](https://aris-sw.onrender.com)

> ⚠️ Hosted on Render's free tier — sleeps after 15 minutes of inactivity. First request after a pause may take up to 60 seconds to wake. Subsequent requests are fast.

**Try this input:**

```
Mahindi yangu yana matundu kwenye majani
```

*("My maize has holes in the leaves.")*

You'll get a structured advisory in Swahili, 2 triage questions as clickable chips, and a play button for the audio. Answer a question to watch the diagnosis narrow and confidence escalate.

---

## ⚙️ How It Works

```
Farmer speaks Swahili
    │
    ▼  NKENNEAi Speech-to-Text
English transcript
    │
    ▼  Groq reasoning + 2,448-record ARIS dataset as few-shots
Structured advisory (JSON)
    │
    ▼  Schema validation → retry on failure
Validated advisory
    │
    ▼  Diagnosis whitelist enforcement + confidence escalation
Verified advisory
    │
    ▼  NKENNEAi Translation (batched; curated map + API fallback)
Swahili advisory
    │
    ▼  NKENNEAi Text-to-Speech
Swahili audio to farmer
```

<details>
<summary><strong>Request lifecycle in detail</strong></summary>

A single farmer turn touches:

1. **`POST /api/stt`** — NKENNEAi Speech-to-Text receives `audio/wav` multipart body → `{text, duration, language}`
2. **`POST /api/chat`** with `{sessionId?, input}`:
   - **Session resolution** — SQLite lookup or new session (nanoid ID)
   - **Triage detection** — if `pending_triage` exists, input is an answer to the first queued question
   - **Augmented context** — original complaint + prior triage answers
   - **Few-shot selection** — 3 examples, deterministic by crop + symptom overlap
   - **Groq reasoning** — Qwen 3.8 27B → JSON advisory (English)
   - **Schema validation** — retry once with corrective prompt on failure
   - **Diagnosis enforcement** — snap invented labels to curated whitelist
   - **Confidence escalation** — bump one level on confirmation discriminator
   - **Translation** — per-field, curated map preferred, sanity check on API output
   - **Persistence** — advisory written to session, input cached to disk by hash
3. **`POST /api/tts`** — NKENNEAi Text-to-Speech receives Swahili text → `audio/mpeg`

Typical warm latency: **2.5–4s** end-to-end. Voice-in adds ~1.2s for STT.

</details>

---

## 🔌 NKENNEAi APIs Used

| API | Endpoint | Role in core loop |
|---|---|---|
| **Speech-to-Text** | `POST /api/stt/v1/swahili/with-api-key` | Transcribes the farmer's voice |
| **Translation** | `POST /api/translate/with-api-key` | Renders English advisory fields into Swahili |
| **Text-to-Speech** | `POST /api/tts/v1/swahili/with-api-key` | Plays the advisory back as Swahili audio |

<details>
<summary><strong>Per-API integration details</strong></summary>

**STT** — multipart `audio_file`, 25 MB cap, WAV recommended (16-bit PCM). Handles `400` (missing field), `413` (oversized), `401` (invalid key). Typed input bypasses STT entirely — deliberate cost control.

**Translation** — batched: all translatable fields from one advisory sent in a single call (~80% token saving vs per-field). Normalises both `translated_text` and `translatedText` — docs and runtime disagree. Sanity check rejects runaway generation and token loops.

**TTS** — returns binary stream, not JSON. Checks `res.ok` before buffering. Failure is non-fatal: card renders, play button simply doesn't appear.

The fourth NKENNEAi API (speech translation, `/api/st/v1/…`) is deliberately not used — it returns translated text, not a structured advisory, so the reasoning step is still required. Full rationale in [REPORT.md §3.4](REPORT.md).

</details>

---

## 🧬 Why This Is Not a Wrapper

Three engineering decisions separate this from an API pass-through:

**1. Curated Swahili for diagnoses.**
NKENNEAi machine-translates scientific names into garbage — `Fall armyworm` became `Kuku wa mahindi` ("chickens of maize") and `Spodoptera frugiperda` triggered a 30-repetition token loop. Sixteen common diagnosis labels come from a hand-verified map. **Zero tokens, zero nonsense in the most visible field.**

**2. Diagnosis whitelist enforcement.**
Groq occasionally invents plausible-sounding labels (`Maize leaf spot`) that aren't in the dataset. A post-processor snaps any label to the closest valid diagnosis and attaches real `fact_ids`. The live demo returns `["FAW-001", "FAW-002", "FAW-003"]` — provenance, not empty arrays.

**3. Budget-guarded public demo.**
Deployed with `TOKEN_BUDGET_FLOOR=200`. When the NKENNEAi balance drops below the floor, the app degrades to English-only rather than returning errors. Judges testing the public URL cannot exhaust the allocation and see broken pages.

Each of these is a defensive layer against a *specific observed failure*, not a hypothetical. Full evidence in [REPORT.md §5](REPORT.md).

---

## 🛠 Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 22 | Native `fetch`, `node:test`, stable ESM |
| Server | Express 4 | Minimal, well-understood, no magic |
| Session store | `better-sqlite3` | Synchronous, zero-config, WAL mode |
| Reasoning | Groq · Qwen 3.8 27B | Free tier, strict JSON mode, ~1.5s warm |
| Voice | NKENNEAi STT / Translate / TTS | Only Swahili-capable stack available |
| Logging | `pino` | Structured JSON, request-ID correlation |
| Security | `helmet` + `cors` + `express-rate-limit` | Standard headers, per-IP throttling |
| Deploy | Render + multi-stage Docker | Free tier, health check, non-root user |

---

## 🚀 Quick Start

```bash
git clone https://github.com/Vicgrace01/aris-sw.git
cd aris-sw
npm install
cp .env.example .env      # add NKENNE_API_KEY + GROQ_API_KEY
node server.js            # http://localhost:3000
```

<details>
<summary><strong>Docker setup</strong></summary>

```bash
cp .env.production.example .env
# fill in both API keys
docker compose build
docker compose up -d
docker compose logs -f aris-sw
```

Health check: `curl http://localhost:3000/api/health`

</details>

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NKENNE_API_KEY` | ✅ | — | NKENNEAi auth |
| `GROQ_API_KEY` | ✅ | — | Groq auth |
| `NODE_ENV` | — | `development` | Toggles pretty logs, error sanitisation |
| `PORT` | — | `3000` | Listen port |
| `LOG_LEVEL` | — | `info` | pino level |
| `GROQ_MODEL` | — | `qwen/qwen3.8-27b` | Reasoning model |
| `GROQ_MAX_OUTPUT_TOKENS` | — | `400` | Output budget (OTPM ceiling) |
| `RATE_LIMIT_MAX` | — | `30` | Requests/min/IP |
| `TOKEN_BUDGET_FLOOR` | — | `200` | Budget guard threshold |
| `SESSION_DB_PATH` | — | `data/sessions.db` | SQLite location |
| `GROQ_CACHE_PATH` | — | `data/groq-cache.jsonl` | Disk cache location |

</details>

---

## 🧪 Testing

```bash
npm test
```

**33 tests · ~900ms · zero network calls · zero API tokens**

| File | Tests | Coverage |
|---|---|---|
| `test/schema-validator.test.js` | 12 | Advisory shape, type rejection, required fields |
| `test/diagnosis-validator.test.js` | 11 | Whitelist snapping, fact-ID attachment, confidence escalation |
| `test/dataset.test.js` | 10 | Crop detection (EN/SW), determinism, gold preference |

<details>
<summary><strong>What is not tested, and why</strong></summary>

- **NKENNEAi and Groq calls** — mocked by design, so the suite runs at zero token cost. Integration proof is the live demo and `TOKEN_LOG.md`.
- **Browser flows** — manual verification during development. Playwright suite is roadmap.
- **Field audio** — all STT tests used clean recordings. Real farmer audio (wind, dialect variation, background noise) is a known gap; disclosed in [REPORT.md §12](REPORT.md).

</details>

---

## 📁 Project Structure

```
aris-sw/
├── server.js                 Express routes
├── config.js                 Env validation, config object
├── lib/
│   ├── agent.js              Session orchestration
│   ├── dataset.js            Deterministic few-shot selection
│   ├── diagnosis-validator.js Whitelist + confidence escalation
│   ├── groq.js               Reasoning + disk cache + retries
│   ├── nkenne.js             NKENNEAi client + budget guard
│   ├── translator.js         Curated map + per-field cache + sanity check
│   ├── schema-validator.js   Advisory contract validation
│   ├── session-store.js      SQLite sessions
│   ├── logger.js             Structured logging
│   └── errors.js             Typed error codes
├── middleware/               Helmet, CORS, rate-limit, request-ID
├── public/                   Chat UI (SW/EN toggle, triage chips, audio)
├── schema/                   Full JSON Schema for advisory_episode
├── scripts/                  Migration, translation, healthcheck
├── test/                     33 tests
├── data/
│   ├── advisory_episodes.train.jsonl   2,448 records
│   └── gold_diagnostics.jsonl          7 gold episodes
├── Dockerfile                Multi-stage build
├── docker-compose.yml        One-command stack
├── README.md                 ← you are here
├── REPORT.md                 Technical deep dive
├── ARCHITECTURE.md           System diagram + data flow
├── API.md                    Endpoint reference
├── TOKEN_LOG.md              Every NKENNEAi call, with rationale
├── CONTRIBUTING.md           Setup, extension points
└── LICENSE                   MIT
```

---

## 🗺 Documentation Map

| Document | What it answers |
|---|---|
| [**REPORT.md**](REPORT.md) | Full technical report: per-API failure surface, error handling matrix, dataset strategy, token economics, adoption path, 15 sections |
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | System diagram, request lifecycle, design decisions, extension points, security model |
| [**API.md**](API.md) | Every endpoint, request/response shapes, error codes, rate limits |
| [**TOKEN_LOG.md**](TOKEN_LOG.md) | Allocation, every call logged, efficiency measures, known limitations |
| [**CONTRIBUTING.md**](CONTRIBUTING.md) | Local setup, how to add a diagnosis to the whitelist, code style |

---

## 🛣 Roadmap

| Priority | Item | Why it matters |
|---|---|---|
| P0 | Fact-ledger retrieval | Makes `provenance.fact_ids` fully literal instead of whitelist-derived |
| P0 | Playwright E2E suite | Browser-flow regression against the live deploy |
| P1 | Offline deployment (ARIS Qwen 1.5B on CPU) | Works where mobile data is prohibitively expensive |
| P1 | WhatsApp Business API integration | Median farmer has WhatsApp, not email |
| P2 | Extension-officer dashboard | Aggregate anonymised advisories into a regional outbreak heatmap |
| P2 | Photo-based diagnosis | Farmers describe symptoms better with a photo |
| P3 | Multi-language (Yoruba, Pidgin, Kikuyu) | Pending NKENNEAi availability |

---

## ⚠️ Known Limitations

- **Nigerian source bias** — dataset derives from IITA/NAERLS/NRCRI. FAW, CMD, and storage pests transfer to East Africa; crop spacing and fertiliser schedules are Nigeria-specific.
- **Only 7 gold diagnostics** — few-shot quality improves with 30+ hand-verified episodes.
- **STT untested against field audio** — clean recordings only; wind, dialect, and background noise are unproven.
- **NKENNEAi translation of scientific names is unreliable** — mitigated by curated map + sanity check + English fallback.
- **No persistent storage on free tier** — sessions and cache reset on redeploy.
- **No user accounts** — IP-based rate limiting.
- **No photo diagnosis** — NKENNEAi has no vision API.
- **Reasoning uses a general LLM, not the ARIS fine-tune** — latency trade-off; the 1.5B CPU model is the offline path.

Full disclosure with evidence: [REPORT.md §12](REPORT.md).

---

## 🤝 Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, how to add a diagnosis to the whitelist, code style, and commit conventions.

---

## 📄 License

MIT — see [LICENSE](LICENSE).

**Author:** Victor Chukwuebuka Nwaruwe (Vicgrace Labs) · [victornwaruwe@gmail.com](mailto:victornwaruwe@gmail.com)

---

<div align="center">

*Built for the NKENNEAi API Hackathon · October 2026*

</div>
