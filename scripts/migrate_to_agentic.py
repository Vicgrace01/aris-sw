"""
Convert ARIS training JSONL (messages format) into advisory_episode v1 + SFT.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from to_messages import to_messages, validate


CROPS = [
    "maize", "rice", "cassava", "yam", "cowpea", "sorghum", "millet",
    "groundnut", "soybean", "tomato", "pepper", "onion", "okra",
    "plantain", "banana", "cocoa", "oil palm", "cashew", "ginger",
    "sesame", "melon", "sugarcane", "wheat", "potato", "sweet potato",
    "vegetable", "bean", "pigeon pea", "mango", "citrus", "orange",
]

SYMPTOMS = [
    "yellow", "wilting", "wilt", "holes", "spots", "lesion", "rot",
    "mould", "mold", "rust", "blight", "streak", "mosaic", "stunted",
    "stunting", "dying", "dead", "insect", "worm", "caterpillar", "larva",
    "aphid", "whitefly", "beetle", "grasshopper", "termite", "nematode",
    "frass", "chewed", "curling", "drooping", "discoloured", "discolored",
    "pale", "brown", "black", "powder", "smut", "gall",
]

REFUSAL_MARKERS = [
    "cannot provide", "cannot give", "cannot prescribe", "cannot help with",
    "outside agricultural", "outside the scope", "not within",
    "i do not know", "no live", "no internet access",
]

SOURCE_NAMES = [
    "NAERLS", "IITA", "NRCRI", "NCRI", "NIHORT", "NSPRI", "NAPRI",
    "NVRI", "FMARD", "NiMet", "ADP", "TARI", "KALRO", "NARO",
]

NIGERIA_ONLY_SOURCES = {
    "NAERLS", "NRCRI", "NCRI", "NIHORT", "NSPRI", "NAPRI", "NVRI",
    "FMARD", "NiMet", "ADP",
}


def _join(msgs, role):
    return " ".join(m["content"] for m in msgs if m.get("role") == role)


def _find_any(text, terms):
    low = text.lower()
    return [t for t in terms if t in low]


def _find_sources(text):
    return [s for s in SOURCE_NAMES if s in text]


def _classify(user_text, asst_text):
    crops = _find_any(user_text, CROPS)
    symps = _find_any(user_text, SYMPTOMS)
    refusal_hit = _find_any(asst_text, REFUSAL_MARKERS)
    if refusal_hit and not crops:
        return "refusal"
    if crops and symps:
        return "diagnostic_episode"
    return "fact_only"


def _refusal_category(user_text, asst_text):
    low = (user_text + " " + asst_text).lower()
    if "headache" in low or "medical" in low or "doctor" in low:
        return "medical", "your local health worker or clinic"
    if "exchange rate" in low or "price" in low or "market" in low:
        return "live_data", "a trusted financial or market source"
    if "veterinar" in low or "dose" in low or "pesticide" in low:
        return "veterinary_dose", "a licensed veterinarian or extension officer"
    if "i do not know" in low or "insufficient" in low:
        return "insufficient_info", "your local extension officer"
    return "out_of_scope", "your local extension officer"


def _first_sentence(text, max_len=240):
    text = text.strip()
    m = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)
    s = m[0] if m else text
    return s if len(s) <= max_len else s[: max_len - 1] + "..."


def _build_episode(idx, record, ledger_index):
    msgs = record["messages"]
    sys_prompt = next((m["content"] for m in msgs if m.get("role") == "system"), "")
    user_msgs = [m for m in msgs if m.get("role") == "user"]

    user_text = _join(msgs, "user")
    asst_text = _join(msgs, "assistant")

    kind = _classify(user_text, asst_text)
    crops = _find_any(user_text, CROPS)
    sources = _find_sources(asst_text + " " + sys_prompt)
    region_mismatch = any(s in NIGERIA_ONLY_SOURCES for s in sources)

    episode = {
        "episode_id": f"SW-EP-{idx:04d}",
        "schema_version": "agentic-v1",
        "language": "en",
        "channel": "text",
        "record_kind": kind,
        "legacy_system_prompt": sys_prompt,
        "context": {
            "crop": crops[0] if crops else None,
            "growth_stage": None,
            "location": {"country": None, "region": None, "agro_zone": None},
            "farm_size_ha": None,
            "chief_complaint_en": user_text.strip()[:1000],
            "chief_complaint_sw": None,
            "known_facts": [],
        },
        "provenance": {"fact_ids": [], "source_names": sources},
        "policy_trace": [],
        "review": {
            "needs_human": True,
            "human_notes": "",
            "source_region_mismatch": region_mismatch,
            "original_index": idx,
        },
    }

    if kind == "refusal":
        cat, redirect = _refusal_category(user_text, asst_text)
        episode["refusal"] = {
            "reason_en": asst_text.strip()[:500],
            "reason_sw": None,
            "category": cat,
            "redirect_to": redirect,
        }
        episode["policy_trace"] = [
            {"step": "intake", "action": "classify_out_of_scope", "args": {"category": cat}},
            {"step": "close", "action": "emit_refusal"},
        ]
        episode["review"]["human_notes"] = "Refusal case - verify reason wording."

    elif kind == "fact_only":
        episode["fact_body"] = {
            "answer_en": asst_text.strip(),
            "answer_sw": None,
            "multi_turn": (
                [{"role": m["role"], "content": m["content"]} for m in msgs[1:]]
                if len(user_msgs) > 1 else []
            ),
            "topic_tags": crops,
        }
        episode["policy_trace"] = [
            {"step": "intake", "action": "retrieve_facts", "args": {"query": user_text[:200]}},
            {"step": "advise", "action": "emit_fact"},
        ]
        episode["review"]["human_notes"] = "Fact-only record. Verify against ledger before merging."

    else:
        first_crop = crops[0] if crops else "unknown"
        episode["triage"] = {
            "observed_signs": _find_any(user_text, SYMPTOMS),
            "missing_discriminators": ["field_confirmation"],
            "questions": [{
                "field": "field_confirmation",
                "ask_en": "Can you confirm the symptoms on at least 10 plants in the field?",
                "ask_sw": None,
                "why": "Narrow diagnosis before advising treatment.",
            }],
        }
        episode["diagnosis"] = {
            "primary": {
                "label": f"possible disorder in {first_crop}",
                "label_sw": None,
                "confidence": "unconfirmed",
                "fact_ids": [],
            },
            "differentials": [],
            "confidence": "unconfirmed",
            "confidence_basis": "Derived from text-only description.",
            "confidence_ceiling_reason": "No photo, no field visit.",
        }
        episode["advice"] = {
            "immediate": [{"action_en": asst_text.strip()[:500], "action_sw": None, "timeframe": None, "fact_ids": []}],
            "preventive": [],
            "do_not": [{
                "text_en": "Do not apply any pesticide until confirmed by a field check.",
                "text_sw": None,
                "reason": "Unverified dosage is the highest-risk failure mode.",
            }],
            "safety_caveats": ["Diagnosis provisional.", "No dose given."],
        }
        episode["escalation"] = {
            "trigger_en": "If symptoms worsen or spread, contact your extension officer.",
            "trigger_sw": None,
            "referral": "Contact the ward agricultural extension officer.",
            "urgency": "medium",
        }
        episode["follow_up"] = {
            "check_in_days": 7,
            "success_indicator_en": "Symptoms do not spread to new plants.",
            "success_indicator_sw": None,
        }
        episode["policy_trace"] = [
            {"step": "intake", "action": "set_context", "args": {"crop": first_crop}},
            {"step": "triage", "action": "ask_clarification", "args": {"field": "field_confirmation"}},
            {"step": "diagnose", "action": "commit_diagnosis", "args": {"confidence": "unconfirmed"}},
            {"step": "advise", "action": "emit_advice"},
            {"step": "close", "action": "schedule_follow_up", "args": {"days": 7}},
        ]
        episode["review"]["human_notes"] = (
            "Diagnostic skeleton. Split original answer into immediate/preventive/do_not, "
            "add crop-specific triage questions, fill fact_ids from ledger."
        )

    if ledger_index:
        for sig in [episode["context"]["chief_complaint_en"][:80]] + crops + _find_any(user_text, SYMPTOMS):
            hit = ledger_index.get(sig.lower())
            if hit:
                episode["provenance"]["fact_ids"].extend(hit[:3])
        episode["provenance"]["fact_ids"] = sorted(set(episode["provenance"]["fact_ids"]))

    return episode


def _load_ledger(path):
    if not path:
        return {}
    idx = {}
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        text = (row.get("text") or row.get("claim") or "").lower()
        fid = row.get("fact_id") or row.get("id")
        if not fid:
            continue
        for crop in CROPS:
            if crop in text:
                idx.setdefault(crop, []).append(fid)
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sft", required=True)
    ap.add_argument("--ledger", default=None)
    ap.add_argument("--start-index", type=int, default=1)
    args = ap.parse_args()

    ledger = _load_ledger(args.ledger)

    episodes_out = open(args.out, "w", encoding="utf-8")
    sft_out = open(args.sft, "w", encoding="utf-8")
    total = valid = flagged = 0
    kind_counts = {"diagnostic_episode": 0, "fact_only": 0, "refusal": 0}

    for i, line in enumerate(Path(args.input).read_text(encoding="utf-8-sig").splitlines()):
        if not line.strip():
            continue
        record = json.loads(line)
        idx = args.start_index + i
        ep = _build_episode(idx, record, ledger)

        errs = validate(ep)
        if errs:
            ep["review"]["needs_human"] = True
            ep["review"]["human_notes"] += " SCHEMA: " + "; ".join(errs[:3])
            flagged += 1
        else:
            valid += 1
            sft_out.write(json.dumps(to_messages(ep), ensure_ascii=False) + "\n")

        episodes_out.write(json.dumps(ep, ensure_ascii=False) + "\n")
        kind_counts[ep["record_kind"]] += 1
        total += 1

    episodes_out.close()
    sft_out.close()

    print(f"Processed {total} records")
    print(f"  valid / SFT-ready : {valid}")
    print(f"  flagged for human : {flagged}")
    for k, v in kind_counts.items():
        print(f"  {k:20s}: {v}")
    print(f"\nWrote {args.out}  and  {args.sft}")


if __name__ == "__main__":
    main()
