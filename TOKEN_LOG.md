# Token Usage Log — ARIS-SW

**Cumulative NKENNEAi consumption.** Dashboard is the authoritative source of truth; this file documents what the tokens were spent on and why.

Last updated: 2026-10-25

---

## Allocation

| Date | Amount | Source |
|---|---|---|
| 2026-10-23 | 1,000 | Initial hackathon allocation |
| 2026-10-24 | 1,000 | Additional request (approved) |
| **Total** | **2,000** | |

**Balance: 0 tokens.** Full allocation consumed across 67 API calls during development and testing.

---

## Consumption summary

| Endpoint | Approximate calls | Approx tokens | Status |
|---|---|---|---|
| Text-to-text translation (TTT) | ~28 | ~750 | All successful |
| Text-to-speech (TTS) | ~9 | ~800 | All successful |
| Speech-to-text (STT) | 12 (8 success, 4 error) | ~292 | Intermittent |
| Speech translation (STS) — Speech Studio only, not used in app | 2 | 70 | Successful |
| Other translation attempts during iterative testing | ~16 | ~88 | Successful |
| **Total** | **~67** | **~2,000** | |

Full request history available in NKENNEAi Developer Tools → Request History.

---

## Development testing — endpoint verification

Early-stage work to confirm each endpoint responded correctly before wiring into the pipeline.

| Time | Endpoint | Purpose | Tokens | Status |
|---|---|---|---|---|
| 3:31:24 PM | TTT | Sanity-check the API with "test" | 1 | OK |
| 5:18:17 PM | TTT | Verify translation on real sentence | 13 | OK |
| 5:36:00 PM | TTT | Verify translation after code change | 73 | OK |

---

## Development testing — full pipeline

Each run executes the full chain: Groq reasoning → schema validation → diagnosis enforcement → translation → TTS.

| Time | Endpoint | Input preview | Tokens | Status |
|---|---|---|---|---|
| 5:44:38 PM | TTT | "Inspect the whorls of 10 plants…" | 13 | OK |
| 5:44:40 PM | TTT | "Do not apply any pesticide without…" | 25 | OK |
| 5:44:43 PM | TTT | "If symptoms spread to more than…" | 20 | OK |
| 5:44:46 PM | TTT | "Contact your local agricultural…" | 13 | OK |
| 5:44:57 PM | TTT | "Contact your local extension…" | 26 | OK |
| 5:44:59 PM | TTT | "Scout fields weekly for new whorls…" | 13 | OK |
| 5:47:58 PM | TTS | "Funza wa shina la mahindi (Bus…" | 140 | OK |
| 5:48:32 PM | TTT | "Inspect 10 plants in 5 spots to…" | 15 | OK |
| 6:17:15 PM | TTT | "Contact your local extension…" | 26 | OK |
| 6:23:58 PM | TTT | "Open the whorl of 10 plants to…" | 12 | OK |
| 6:28:43 PM | TTT | "Are the holes in the whorl or…" | 13 | OK |
| 6:34:40 PM | TTS | "Funza wa shina la mahindi" | 13 | OK |
| 6:35:54 PM | TTS | "Funza wa shina la mahindi. Kag…" | 126 | OK |

**Note on TTS token cost:** Two TTS calls in this batch cost 140 and 126 tokens because they included parenthetical scientific names. Subsequent fix strips parentheticals before send — same phrase now costs 13 tokens instead of 140. That single change reduced TTS cost by ~90% for the demo phrases.

---

## Speech-to-text testing

| Time | Endpoint | Tokens | Status | Note |
|---|---|---|---|---|
| 3:37:57 PM | STT | 57 | OK | First successful voice transcription |
| 3:38:18 PM | STT | 15 | OK | Shorter audio, successful |
| 3:39:12 PM | STT | 1 | ERROR | Format or content rejected |
| 3:40:00 PM | STT | 57 | OK | Full pipeline with transcription |
| 3:40:00 PM | STT | 1 | ERROR | Duplicate attempt |
| 4:31:21 PM | STT | 1 | ERROR | WebM format not yet converted to WAV |
| 4:30:58 PM | STT | 1 | ERROR | Same |
| 4:31:43 PM | STT | 27 | OK | After WAV conversion fix |
| 4:37:38 PM | STT | 45 | OK | Longer audio, successful |
| 4:49:23 PM | STT | 33 | OK | Post-fix verification |
| 4:56:11 PM | STT | 27 | OK | Post-fix verification |
| 4:56:37 PM | STT | 27 | OK | Post-fix verification |

**8 successful STT calls, 4 errors.** Two distinct failure clusters:

1. **Format mismatch (3 errors, before fix).** WebM audio from browser MediaRecorder was sent directly. NKENNEAi accepts WAV/MP3/M4A/FLAC/OGG — WebM was rejected. Fixed by decoding to raw PCM and re-encoding as WAV before upload.

2. **Intermittent content rejection (1 error, after fix).** Short or unclear audio sometimes returned empty transcription. Successful calls ranged 15–57 tokens; the one error cost 1 token.

Successful STT calls consumed 15–57 tokens each and produced transcriptions that fed into the reasoning and advisory pipeline. Field recordings with real farmers (wind, dialect variation, background noise) remain untested and are documented as a known limitation.

---

## Speech Studio testing (not used in app)

Two calls made through NKENNEAi's own Speech Studio interface to verify the STS (speech translation) endpoint. Not integrated into the app — documented for completeness.

| Time | Endpoint | Tokens | Status |
|---|---|---|---|
| 4:39:44 PM | STS | 35 | OK |
| 4:45:43 PM | STS | 35 | OK |

---

## Efficiency measures

- **Disk cache for Groq responses** — repeat demo inputs return in milliseconds, 0 NKENNEAi tokens after first successful run
- **Curated Swahili map** — 22+ diagnosis and advice strings pre-verified; zero API calls for those fields
- **Per-field translation cache** — translated strings cached by content hash for 1 hour
- **Per-field retry with delay** — 900ms spacing between translation calls
- **TTS parenthetical strip** — cut TTS cost from ~130 tokens to ~13 tokens per advisory by removing `(Spodoptera frugiperda)`-style text before send
- **Budget guard** — `TOKEN_BUDGET_FLOOR=200` prevents runtime errors when balance is low
- **Typed input bypasses STT** — one fewer API call per interaction
- **No retries on success** — retry only fires on 429 / non-JSON response / network error

**Per-demo-turn cost (fresh input, before optimizations):** ~250 tokens.
**Per-demo-turn cost (fresh input, after optimizations):** ~40–60 tokens translation + ~13 tokens TTS = **~55–75 tokens**.
**Per-demo-turn cost (repeat input):** 0 tokens (cache hit).

The gap between the two — roughly 3–4× reduction — is the sum of the curated map, parens strip, and cache work.

---

## Current deployment state

**Balance: 2 tokens.** The live URL at https://aris-sw.onrender.com continues to serve the demo flow because:

- The curated Swahili map covers the primary diagnosis (`Funza wa shina la mahindi`) and safety advice strings — no API call needed
- Response cache (`data/groq-cache.jsonl`) survives while the Render container is alive
- `TOKEN_BUDGET_FLOOR=200` means `assertBudget` throws before any NKENNEAi call, so no failed HTTP requests

**What works with 0 balance:** the first-turn card renders in Swahili (from curated map + cache). What does not: TTS audio (play button renders disabled), and any new input not covered by the curated map returns English.

If the hackathon dashboard shows a renewed allocation or if additional tokens are granted, the app resumes full functionality on next request — no code change required.

---

## Notes

- TTS calls return binary audio; the response does not include a `tokensUsed` field. TTS cost per call is visible on the NKENNEAi dashboard but not captured in the runtime session log.
- The NKENNEAi Developer Tools → Request History is the authoritative record. This file summarises it.
- Additional token requests do not provide a scoring advantage or disadvantage per the hackathon guidelines. This log exists for transparency about how the allocation was used.
