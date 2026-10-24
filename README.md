<div align="center">

# 🌾 ARIS-SW

**Swahili voice-first agricultural advisory for smallholder farmers**

[![Live Demo](https://img.shields.io/badge/demo-live-22b57f?style=flat-square)](https://aris-sw.onrender.com)
[![NKENNEAi](https://img.shields.io/badge/NKENNEAi-STT%20%C2%B7%20Translate%20%C2%B7%20TTS-2b9bf0?style=flat-square)](https://nkenne.ai)
[![Tests](https://img.shields.io/badge/tests-36%20passing-22b57f?style=flat-square)](#testing)
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
| 📊 **Provenance** | Confidently-matched diagnoses cite `fact_ids` and source bodies; unmatched cases are marked `unconfirmed` with empty provenance |
| 💾 **Cost-controlled** | Disk-cached responses; budget guard degrades gracefully |
| 🐳 **Deployable** | Multi-stage Docker, health check, structured logs |

### What the farmer sees
