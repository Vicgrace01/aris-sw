# Contributing

Thanks for considering a contribution. This project is small enough that ad-hoc PRs work well — no CLA, no issue template required.

## Local development

    git clone https://github.com/Vicgrace01/aris-sw.git
    cd aris-sw
    npm install
    cp .env.example .env
    node server.js

Open http://localhost:3000.

## Running tests

    npm test

33 tests, ~1s, no network calls, no API tokens spent.

## Adding a diagnosis to the whitelist

1. Add an entry to lib/diagnosis-validator.js under VALID_DIAGNOSES[crop] with fields: canonical, sw, keywords, factIds, sources.
2. Add a gold record to data/gold_diagnostics.jsonl with the same label.
3. Add a test to test/diagnosis-validator.test.js.
4. Run npm test.

## Adding an endpoint

1. Add the route in server.js under the appropriate section, wrapped in asyncHandler.
2. Validate the request body — throw Errors.validation on bad input.
3. Add the endpoint to API.md.
4. Add an integration test to test/.

## Code style

- ESM modules (import/export)
- 2-space indent
- const before let; let only when reassigned
- Prefer early returns over nested conditionals
- Errors as throw with a message, not return codes

## Commit messages

Use plain English. Start with a verb.

Examples:
- Fix diagnosis enforcement for cassava
- Add rate-limit headers to /api/chat
- Update README with Docker section

## Reporting issues

Open an issue with:
- What you were trying to do
- What happened (paste error from server log if available)
- What you expected
- Node version (node -v)
- OS

The server log is the most useful thing — every error is logged with a requestId.

## Security

Do not open a public issue for security problems. Email victornwaruwe@gmail.com directly.

Never commit:
- .env (already in .gitignore)
- Real API keys
- Session database (data/sessions.db)
- Persistent cache (data/groq-cache.jsonl)

If you accidentally commit a key, rotate it immediately at the provider.