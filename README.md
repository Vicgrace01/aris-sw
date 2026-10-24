# ARIS-SW

Swahili voice-first agricultural advisory — NKENNEAi API Hackathon finalist

ARIS-SW gives smallholder farmers in East Africa a voice-first agricultural advisor in Swahili. A farmer speaks their problem; the app transcribes, triages, diagnoses, and responds with a structured advisory that cites verified sources and refuses to prescribe unsafe doses.

## Problem

East Africa has roughly one agricultural extension officer per 5,000 smallholder farmers. Farmers describe crop problems verbally, but most digital tools require typing in English. Existing chatbots produce free-form answers that can invent pesticide dosages — the highest-risk failure mode in farm advisory.

## Solution

ARIS-SW combines three components:

1. Voice-first in Swahili — farmer speaks, system responds with audio advice
2. Structured advisory — every response follows the advisory_episode schema with triage, diagnosis, differentials, action plan, refusal logic, and escalation threshold
3. Grounded on a curated dataset — 2,448 structured records from prior ARIS work seed the reasoning model with real agricultural advisory examples

## Target users

- Smallholder farmers in Tanzania, Kenya, Uganda who speak Swahili
- Extension officers who need a first-pass triage tool
- AgTech NGOs deploying advisory services at scale

## Features

- Voice input — speak Swahili, get an advisory
- Multi-turn triage — the system asks clarifying questions before committing
- Bilingual — SW/EN toggle switches both labels and content
- Structured output — every response is a validated JSON advisory, not prose
- Grounded diagnoses — labels snap to a curated whitelist; invented diagnoses are rejected
- Persistent cache — repeated demo inputs cost 0 tokens after the first call
- Full observability — request IDs, structured logs, token tracking, session history
- Docker-ready — docker compose up runs the whole stack

## NKENNEAi APIs used

| API | Endpoint | Role in the app |
|---|---|---|
| Speech-to-Text | POST /api/stt/v1/swahili/with-api-key | Transcribes the farmer voice input |
| Translation | POST /api/translate/with-api-key | Renders English advisory fields into Swahili |
| Text-to-Speech | POST /api/tts/v1/swahili/with-api-key | Plays the advisory back as Swahili audio |

The reasoning step uses Groq free tier (qwen/qwen3.8-27b) with few-shot examples from the ARIS dataset, validated against the project schema.

## Dataset

- data/advisory_episodes.train.jsonl — 2,448 structured records migrated from prior ARIS training data
- data/gold_diagnostics.jsonl — 7 hand-verified diagnostic episodes covering fall armyworm/stem borer (maize), cassava mosaic, bacterial wilt (tomato), striga, cowpea storage pest, groundnut rosette, and rice yellow mottle
- 335 templated records automatically excluded from few-shot selection

Few-shots are selected per query by crop. The diagnosis label is enforced post-hoc against a curated per-crop whitelist to prevent hallucinated diagnoses.

## Setup (local)

    npm install
    cp .env.example .env
    # Add your keys to .env:
    #   NKENNE_API_KEY=...
    #   GROQ_API_KEY=...
    node server.js

Open http://localhost:3000.

## Setup (Docker)

    cp .env.production.example .env
    # Fill in NKENNE_API_KEY and GROQ_API_KEY
    docker compose build
    docker compose up -d
    docker compose logs -f aris-sw

App runs at http://localhost:3000. Health: curl http://localhost:3000/api/health.

## Testing

    npm test

33 tests, no network calls, 0 API tokens spent. Covers schema validation, diagnosis enforcement, confidence escalation, and few-shot determinism.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | /api/health | Health, dataset stats, token usage, cache stats |
| POST | /api/chat | Main chat endpoint (creates session on first call) |
| POST | /api/reason | Stateless reasoning (for direct testing) |
| POST | /api/session | Create an empty session |
| GET | /api/session/:id | Retrieve session with full history |
| POST | /api/session/:id/close | Close a session |
| POST | /api/stt | NKENNEAi speech-to-text |
| POST | /api/translate | NKENNEAi translation |
| POST | /api/tts | NKENNEAi text-to-speech |

Full reference: see API.md.

## Architecture

See ARCHITECTURE.md for a full system diagram, data flow walkthrough, and design decisions.

## Token discipline

- Warmed cache: frequently-demoed inputs are cached on disk (survives restart), so re-runs cost 0 NKENNEAi tokens
- Curated diagnosis map: 16 common diagnosis labels use pre-verified Swahili (0 tokens)
- Per-field translation cache: translated advice fields cached by content hash
- Batch translation: all translatable fields sent in one NKENNEAi call per advisory
- Sanity checks: NKENNEAi output that fails plausibility checks is rejected and replaced with English fallback
- Token usage visible in /api/health — see tokens.lastTokensRemaining

TOKEN_LOG.md records every NKENNEAi call with endpoint, tokens, and status.

## Known limitations

- Swahili input works for common cases; unusual phrasings may still require English
- Few-shot pool size: only 7 gold diagnostic episodes; expanding to 30+ would improve consistency
- Cache is in-memory + disk, cleared by deleting data/groq-cache.jsonl
- No user authentication: rate limit is IP-based (30 requests/min default)
- Reasoning model: uses Groq free tier; production would upgrade to Groq Dev Tier or self-hosted model
- Not tested against real farmer audio; STT pipeline works via NKENNEAi API but has not been exercised with field recordings
- Swahili rendering for free-form advice text depends on NKENNEAi translation quality; curated labels guarantee accuracy but action items may vary
- Nigerian sources: dataset is from Nigerian agricultural research (IITA, NAERLS); some advice is transferable to East Africa (FAW, CMD, storage pests), some is region-specific

## Third-party libraries

Runtime: express, multer, better-sqlite3, pino, pino-http, pino-pretty, helmet, cors, express-rate-limit, nanoid, dotenv

External services: NKENNEAi API, Groq API

## Disclosure

Prior ARIS work (dataset, schema, model architecture) is disclosed. The NKENNEAi hackathon build wraps this existing work with the voice pipeline.

## License

MIT — see LICENSE.

## Author

Victor Chukwuebuka Nwaruwe (Vicgrace Labs) — victornwaruwe@gmail.com