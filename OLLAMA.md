# Ollama — the local model's standing brief in this workspace

Companion to `CODEX.md`, same shape, different kind of worker. Ollama has no session that reads
a charter at startup — it is an inference endpoint other scripts call — so this file is not
onboarding for an agent. It is the one place a future session (Claude or Codex) reads before
adding, changing, or auditing anywhere Ollama is used, so the same drift that motivated
`tools/ollama-run.cjs` does not happen again. Full measured history: `ARCHITECTURE.md` §3.
The hard NEVER rules: `CLAUDE.md`, `ARCHITECTURE.md` §3 "The policy", `tools/offload-router.cjs`.

---

## What it's trusted for

A task qualifies only if it is **all three**: low-stakes (wrong is cheap and visible), reviewable
(shows up somewhere a human sees it before it's final), and structurally constrained (a JSON
schema with an `enum`, never bare `format: 'json'`). `tools/offload-router.cjs --policy` is the
live decision table, not this paragraph — read the tool, not a copy of it.

Currently offloaded: transaction categorisation (suggestion only), mail sender classification
(suggestion only), backlog `kind` labelling (applied directly — a routing hint, one-UPDATE undo).

## What it must never touch

- **Any number that appears anywhere.** Arithmetic is SQL's job; a model's total is a plausible
  total, which is worse than no total.
- **Anything auto-applied without review.** 20/20 on a probe is not 100% on the next 20.
- **The wellbeing module.** Not the panel, not the prose, not a pattern — fixed policy, not a
  gate score.
- **Architecture, project memory, or any claim about the code.** A confabulated fact reads as
  verified, which is worse than an absent one.
- **Sensitive data to a `-cloud` model.** `server/ollama.js`'s `SENSITIVE` regex checks the
  *payload*, not the caller's intent or the URL — cloud and local are both served from
  `127.0.0.1`, and a `-cloud` suffix in a model name is the only signal that data is about to
  leave the machine.

## The one path everything goes through now — `tools/ollama-run.cjs`, built 19 Aug 2026

Before today, three separate scripts (`ollama-shift.cjs`, `categorise-model.cjs`,
`classify-senders.cjs`) each hand-rolled their own version of the same three things, and two of
them had quietly drifted from the rule that matters most: `categorise-model.cjs` and
`classify-senders.cjs` were calling Ollama's HTTP API directly, which skips `server/ollama.js`'s
`ask()` — the one place the cloud-privacy gate above actually runs. Nothing had exploited that
yet (both hardcoded a local model), but nothing was stopping a later edit from doing so either,
and `categorise-model.cjs` hands the model real finance counterparty/reference text.

**Verified live, not assumed:** a synthetic `-cloud` call carrying the word "bank" through
`askBatched()` now returns `REFUSED before sending` from `server/ollama.js`, via the exact path
these callers use.

`require('./ollama-run.cjs')` — **the extension is not optional.** Node's default resolver
tries `.js` / `.json` / `.node` for an extension-less require, never `.cjs`. This cost the first
live run of the refactor a `MODULE_NOT_FOUND` before it was caught; every other tool here that
requires a sibling `.cjs` file already spells the extension out, and this one now matches.

Three exports:
- `checkAvailable()` — the one reachability check. Degrades to "not categorised, do it
  yourself", never a crash or a silent partial write.
- `scoreOracle({ oracle, floor, ... })` — re-measures accuracy against a **rule-derived** oracle
  **every run**, not a number trusted from a historical probe. A model swap, a prompt edit, or
  the model simply not being warmed can all move accuracy, and a cached number would not know.
- `askBatched({ buildPrompt, parseResponse, ... })` — chunks items, calls through
  `ollama.ask()`, hands parsing back to the caller (the three existing callers key answers three
  different ways and forcing one convention would have meant rewriting prompts, not just
  plumbing).

## Current state

**Routed through it:** `categorise-model.cjs` (gained the accuracy-floor gate it did not have
before), `classify-senders.cjs`.

**Not yet, deliberately:** `ollama-shift.cjs` already goes through `server/ollama.js` correctly
and already re-measures its own oracle every run — it duplicates logic `ollama-run.cjs` now
centralises, but it was not unsafe, so touching it was lower priority than closing the two
callers that were. `llm-probe.cjs`, `llm-probe-mail.cjs`, `llm-probe-project.cjs` are benchmark
harnesses against hand-labelled synthetic data, not production write paths — routing them
through the wrapper would couple a raw-endpoint measurement to the wrapper's own behaviour,
which is the opposite of what a benchmark is for. Left on a direct fetch on purpose.

## Model tiers, measured 19 Aug 2026 on this machine (8151 MiB VRAM)

| Model | VRAM | GPU | Warm | Honours a JSON schema |
|---|---|---|---|---|
| **qwen3.5:4b** (`LOCAL_DEFAULT`) | 3.4 GB | 100% | 12.5s | yes |
| qwen3.5:9b | 6.6 GB | 64% (spills to CPU) | 17.7s | yes |
| gemma4:12b | 7.6 GB | exceeds the card | unmeasured | unknown |
| gpt-oss:20b-cloud | — (leaves the machine) | — | — | **no** — measured returning plain text against a strict schema, twice |
| gpt-oss:120b-cloud | — (leaves the machine) | — | — | unmeasured |

The 4B beats the 9B on every axis here because weights-plus-KV-cache is the real constraint, not
weights alone — a model that spills to CPU is slower **and** less reliable than one that fits.
Do not reach for a bigger local model without re-measuring; the smaller one already won once.

## How to work here

Before adding a new offload site: run `node tools/offload-router.cjs --policy`, check the task
against the three gates above, and route the call through `tools/ollama-run.cjs` — not a new
direct fetch to `11434`. Any script touching the database still needs its own
`db.setProcessActor(...)` call; `ollama-run.cjs` does not do that for you, because it does not
know what the caller's write means.
