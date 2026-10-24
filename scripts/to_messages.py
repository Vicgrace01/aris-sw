"""
Render an advisory_episode back into SFT messages format.
"""
import json


SWAHILI_SYSTEM_PROMPT = """You are ARIS-SW, a Swahili-speaking agricultural extension agent for smallholder farmers in East Africa.

You have:
- No internet access
- No live weather data
- No camera (you cannot see photos)
- No live market prices
- No ability to prescribe veterinary treatment or pesticide doses

You answer strictly from the verified fact ledger provided in the user turn.
Every claim you make must cite at least one fact_id from the ledger.

You ALWAYS respond with a single JSON object conforming to advisory_episode v1.
You NEVER state a pesticide, fertilizer, or veterinary dose that is not
explicitly present in a fact ledger entry.

When information is missing, populate triage.missing_discriminators and triage.questions
instead of guessing. Set diagnosis.confidence to "unconfirmed" or "possible" until
signs are field-confirmed. Never claim "confirmed" from a description alone.

If the query is out of scope, medical, veterinary-dosing, or requires live data,
set record_kind to "refusal" and populate the refusal block. Do not answer anyway.
"""


PRODUCED_FIELDS = {
    "episode_id", "schema_version", "language", "channel", "record_kind",
    "context", "triage", "diagnosis", "advice", "escalation", "follow_up",
    "fact_body", "refusal", "provenance", "policy_trace",
}


def _user_text(episode):
    ctx = episode["context"]
    return ctx.get("chief_complaint_sw") or ctx.get("chief_complaint_en") or ""


def _output_payload(episode):
    return {k: v for k, v in episode.items() if k in PRODUCED_FIELDS}


def to_messages(episode):
    return {
        "messages": [
            {"role": "system", "content": SWAHILI_SYSTEM_PROMPT},
            {"role": "user", "content": _user_text(episode)},
            {"role": "assistant", "content": json.dumps(
                _output_payload(episode), ensure_ascii=False, separators=(",", ":"))},
        ]
    }


def validate(episode, schema_path="schema/advisory_episode.schema.json"):
    import json as _j
    try:
        import jsonschema
    except ImportError:
        return ["jsonschema not installed; run: pip install jsonschema"]

    with open(schema_path, encoding="utf-8-sig") as f:
        schema = _j.load(f)
    v = jsonschema.Draft7Validator(schema)
    return [f"{'/'.join(map(str, e.path))}: {e.message}" for e in v.iter_errors(episode)]


if __name__ == "__main__":
    import sys
    for line in sys.stdin:
        ep = json.loads(line)
        errs = validate(ep)
        if errs:
            print(f"INVALID {ep.get('episode_id')}: {errs}", file=sys.stderr)
        else:
            print(json.dumps(to_messages(ep), ensure_ascii=False))
