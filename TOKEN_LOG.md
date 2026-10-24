# NKENNEAi Token Usage Log

Tracked automatically by `lib/nkenne.js`. Live balance available at `/api/health -> tokens.lastTokensRemaining`.

## Allocation

| Date | Amount | Source |
|---|---|---|
| 2026-10-23 | 1,000 | Initial hackathon allocation |
| 2026-10-24 | 1,000 | Additional request (approved) |

Total allocated: 2,000

## Development testing

| Endpoint | Purpose | Tokens | Status |
|---|---|---|---|
| translate EN-SW "My maize has holes" | Verify translation endpoint | 42 | OK |
| translate EN-SW "I am working on my app" | Verify translation endpoint | 5 | OK |
| tts "Habari, mimi ni mshauri wa kilimo" | Verify TTS output | ~200 | OK |
| translate EN-SW (verification) | Verify key after provisioning | 42 | OK |
| Full pipeline (Swahili complaint) | End-to-end test | ~120 | OK |
| Full pipeline (Swahili complaint) | Verification after code fixes | ~120 | OK |
| Full pipeline warm-cache run | Populate disk cache for demo | ~120 | OK |

Warmed cache means demo video can be re-recorded unlimited times at 0 NKENNEAi cost.

## Efficiency measures

- Disk cache for Groq responses — repeat inputs return in ms, 0 tokens
- Curated Swahili diagnosis map — 16 labels translated without API calls
- Per-field NKENNEAi translation cache — translated strings cached by content hash
- Batched translation — all advisory fields sent in one NKENNEAi call
- No retries on success — only 429 or validation failure triggers retry
- Sanity checks — NKENNEAi output rejected if implausible, falls back to English

## Known limitations

- NKENNEAi machine translation of scientific names produces garbage (e.g. "Kuku wa mahindi" for "Fall armyworm")
- Curated map covers 16 common diagnoses; anything outside it falls back to NKENNEAi or English
- Session tokens are not counted per-call; tokensTracked in /api/health reflects calls with a tokensUsed field