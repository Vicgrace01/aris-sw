# Contributing

Thanks for considering a contribution. This project is small enough that ad-hoc PRs work well — no CLA, no issue template required.

## Local development

```bash
git clone https://github.com/Vicgrace01/aris-sw.git
cd aris-sw
npm install
cp .env.example .env      # add NKENNE_API_KEY + GROQ_API_KEY
node server.js
```

Open http://localhost:3000.

## Running tests

```bash
npm test
```

**43 tests, ~900ms, zero network calls, zero API tokens.**

Test files:
- `test/schema-validator.test.js` (12) — advisory shape validation
- `test/diagnosis-validator.test.js` (21) — evidence-gated matching, single-keyword rejection, confidence escalation rules
- `test/dataset.test.js` (10) — crop detection, few-shot determinism

## Adding a diagnosis to the whitelist

The whitelist is an evidence gate, not a lookup table. An entry that cannot be distinguished from a lookalike will produce a false-positive snap. Follow all five steps:

**1. Add an entry to `lib/diagnosis-validator.js` under `VALID_DIAGNOSES[crop]`:**

```javascript
{
  canonical: 'Full diagnosis name (Scientific name)',
  sw: 'Swahili translation (Scientific name)',
  keywords: ['kw1', 'kw2', 'kw3', 'kw4'],   // at least 2 distinct, ideally 4+
  factIds: ['ID-001', 'ID-002'],
  sources: ['IITA', 'NAERLS']
}
```

**The keywords matter more than anything else.** The scoring function only snaps when 2+ distinct keyword hits are present (score 5). A single keyword hit scores 1 and does not snap. Three or more keyword hits score 8 (very confident). Choose keywords that are genuinely distinguishing — not just symptom words common to multiple conditions.

Bad keywords: `['yellow']`, `['wilt']` — too generic, appear in many diagnoses
Good keywords: `['callosobruchus', 'seed beetle', 'exit hole', 'storage']` — specific to one condition

**2. Add a matching gold record to `data/gold_diagnostics.jsonl`** with the same `canonical` label. The few-shot selector prefers gold diagnostics, and having one is required for the model to produce the label in the first place.

**3. Add a positive test to `test/diagnosis-validator.test.js`:**

```javascript
test('enforceDiagnosis snaps on your new diagnosis', () => {
  const a = {
    diagnosis: { primary: { label: 'your new diagnosis', confidence: 'likely' }, differentials: [] },
    provenance: { fact_ids: [] },
    triage: { questions: [] }
  };
  const r = enforceDiagnosis(a, 'your-crop');
  assert.equal(r.matched, true);
  assert.equal(a.diagnosis.primary.label, 'Full diagnosis name (Scientific name)');
  assert.deepEqual(a.provenance.fact_ids, ['ID-001', 'ID-002']);
});
```

**4. Add a negative test proving a single ambiguous keyword does NOT snap:**

```javascript
test('single keyword "your-generic-kw" alone does NOT snap to your diagnosis', () => {
  const a = {
    diagnosis: { primary: { label: 'Your generic kw presentation', confidence: 'likely' }, differentials: [] },
    provenance: { fact_ids: [] },
    triage: { questions: [] }
  };
  const r = enforceDiagnosis(a, 'your-crop');
  assert.equal(r.matched, false);
  assert.equal(r.unsupported, true);
});
```

**5. Bump the cache version in `lib/groq.js`:**

```javascript
const CACHE_VERSION = 7;   // bump by +1
```

If you changed the `SYSTEM_PROMPT` (e.g. added a new hint about your diagnosis), also bump:

```javascript
const PROMPT_VERSION = '2.2.0';   // bump minor version
```

Without this, cached responses from before your change will be served on repeat inputs and your new entry will not fire.

**6. Run `npm test`.** All tests must pass. Test count grows by 2 for each entry.

## Modifying the diagnosis matching rules

The scoring model in `scoreMatch` is:

| Signal | Score |
|---|---|
| Full canonical label match | 15 |
| Short-name match (`Fall armyworm` for `Fall armyworm (Spodoptera frugiperda)`) | 12 |
| 3+ distinct keyword hits | 8 |
| 2 distinct keyword hits | 5 |
| 1 keyword hit | 1 |
| 0 hits | 0 |

**Snap threshold is 5.** Any change to this threshold changes how aggressively diagnoses are committed — run the full test suite after any modification. The tests in `test/diagnosis-validator.test.js` include positive cases (canonical snap, short-name snap, 2-keyword snap) and negative cases (single keyword, no keyword, negative answer confidence bumps) that must all keep passing.

If you lower the threshold below 5, you reintroduce the audit finding where single ambiguous keywords commit a diagnosis.

## Modifying the confidence escalation rules

`bumpConfidenceOnAnswer` requires **three** conditions to fire: (1) affirmative word, (2) no negation, (3) at least one evidence term. Removing any of the three conditions re-introduces a failure mode:

- Remove (2) → "No, I don't see frass" bumps confidence (audit finding)
- Remove (3) → bare "yes" bumps confidence (audit finding)
- Remove (1) → any input bumps confidence

The three tests named `bare "yes" without evidence term does NOT bump`, `negative answer does NOT bump`, `Swahili negative answer does NOT bump` exist to catch these regressions.

## Adding an endpoint

1. Add the route in `server.js` under the appropriate section, wrapped in `asyncHandler`.
2. Validate the request body — throw `Errors.validation(...)` on bad input.
3. If the endpoint returns session data, verify the session token (see `/api/session/:id` for the pattern).
4. Add the endpoint to `API.md` with request shape, response shape, and error responses.
5. Add an integration test to `test/`. Mock the upstream service via function injection rather than making a network call — the test suite runs with zero API tokens.

## Code style

- ESM modules (`import` / `export`)
- 2-space indent
- `const` before `let`; `let` only when reassigned
- Prefer early returns over nested conditionals
- Errors as `throw` with a message, not return codes
- No external test library — use `node:test` and `node:assert/strict`

## Commit messages

Use plain English. Start with a verb.

Examples:
- Fix diagnosis enforcement for cassava
- Add rate-limit headers to /api/chat
- Update README with Docker section
- Bump cache version after whitelist change

## Reporting issues

Open an issue with:
- What you were trying to do
- What happened (paste error from server log if available)
- What you expected
- Node version (`node -v`)
- OS

The server log is the most useful thing — every error is logged with a `requestId` that correlates to the response's `requestId` field.

## Security

Do not open a public issue for security problems. Email victornwaruwe@gmail.com directly.

Never commit:
- `.env` (already in `.gitignore`)
- Real API keys
- Session database (`data/sessions.db`)
- Persistent cache (`data/groq-cache.jsonl`) — except when pre-warming demo cache for deployment
- Logs containing API responses or token values

If you accidentally commit a key, rotate it immediately at the provider (NKENNEAi dashboard / Groq console) — assume it has been scraped.

## Deployment notes

If you contribute a change that affects the live URL:

- Bump `CACHE_VERSION` in `lib/groq.js` if the diagnosis or translation behavior changed
- Bump `PROMPT_VERSION` in `lib/groq.js` if the system prompt changed
- Render auto-redeploys from `main` — the new container starts with an empty disk cache and dataset load

See `REPORT.md` §11 for the full deployment procedure.
