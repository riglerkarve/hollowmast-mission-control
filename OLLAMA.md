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

Currently offloaded: transaction categorisation (suggestion only, now identifies as the Scribe —
see below), mail sender classification (suggestion only), backlog `kind` labelling (applied
directly — a routing hint, one-UPDATE undo).

## What it must never touch

- **Any number that appears anywhere.** Arithmetic is SQL's job; a model's total is a plausible
  total, which is worse than no total.
- **Anything auto-applied without review.** 20/20 on a probe is not 100% on the next 20.
- **The wellbeing module — except through the Scribe, and even then only partway.** Owner
  decision, 20 Aug 2026: the *nothing-may-be-model-generated* clause was lifted, but only for the
  Scribe, and only with a write that does nothing until the owner reviews it (`scribe_proposals`).
  What did **not** change: nothing there may read as diagnosis, clinical advice or a risk score —
  a numeric value is refused structurally, unreviewably, because approving a score still enacts a
  score. No other caller may even read the module. See "The Scribe" below.
- **Architecture, project memory, or any claim about the code.** A confabulated fact reads as
  verified, which is worse than an absent one.
- **Sensitive data to a `-cloud` model.** `server/ollama.js`'s `SENSITIVE` regex checks the
  *payload*, not the caller's intent or the URL — cloud and local are both served from
  `127.0.0.1`, and a `-cloud` suffix in a model name is the only signal that data is about to
  leave the machine.

## The Scribe — exclusive custody of finance and wellbeing, added 20 Aug 2026

`server/scribe.js`. Two owner decisions, same night: give one tier exclusive custody of the two
most sensitive domains, and give the free local tier a real job for when the paid engines
(Claude, Codex) hit a weekly or session cap and the workspace would otherwise go dark.

**"No other model may even read them."** Not "no other model may write" — *read*.
`custodyAllows(module, engine, intent)` refuses any `engine !== 'scribe'` outright for `finance`
or `wellbeing`, in either direction. This is stricter than the general privacy gate above, which
only stops sensitive data reaching a *cloud* model — the Scribe's custody stops every model
except itself, local included.

**Every capability starts unproven and stays that way until measured.** `scribeCan(db, job)`
checks `scribe_capabilities`; a job with no row, a failed row, or a row older than 45 days is
refused. The table shipped **empty by design** — seeding it with predicted jobs would make it "a
list of predictions wearing a measurement's clothing." `tools/model-bakeoff.cjs` runs the four
gates (fits the card, honours a schema, classifies above a floor, discriminates inverted
evidence) and `POST /api/team/scribe/measure` records the result. As of 20 Aug the table holds
exactly one row: `team-manager-verdict`, **failed** — 0.5 against a floor of 0.8, because
qwen3.5:4b returned the same verdict for evidence that supported a claim and evidence that
contradicted it. Good at "which of four boxes"; not yet trusted with "is this true".

**Caps are declared, never detected.** Nothing here can see an upstream quota, and a detector
that cannot look and says "not capped" is indistinguishable from a working one until it matters.
An undeclared cap leaves the Scribe idle — the safe direction to be wrong in.

**`categorise-model.cjs` now identifies as the Scribe** (this session, 20 Aug) — it was built the
same night as the custody rule, doing exactly the Scribe's job, and had no way to know about it.
`db.setProcessActor('scribe')`, an explicit `custodyAllows` check, and `scribe.recordRun()` on
every exit. Not gated behind `scribeCan()` — that job has never been formally registered via
`POST /api/team/scribe/measure`, but it re-measures accuracy against a live oracle on every
single run, which is fresher evidence than a cached table row. Registering it formally (M117) is
still worth doing, so the owner can see it alongside the Scribe's other jobs in one place.

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

**A second bug found on the first live run, in `server/ollama.js` itself, not `ollama-run.cjs`:**
`ask()` DETECTED the qwen3.5 empty-`thinking`-response failure (reads `message.thinking` for
the diagnostic) but never actually sent `think: false` to prevent it — both callers this was
extracted from had that hardcoded, independently, with the same comment, and routing them
through `ask()` silently dropped it. First live run of `classify-senders.cjs` reproduced the
exact failure their comments warned about (`THE MODEL ANSWERED NOTHING on the oracle`). Fixed
by adding `think = false` as `ask()`'s own default, so every current and future caller gets it
without having to know to ask.

**A real finding, not a bug, from the run after that fix:** `classify-senders.cjs`'s oracle
(random sample of rule-classified senders) scored the model at 27% — refused, correctly, and
wrote nothing. Read the misses before assuming the model is unreliable: 28 of 29 were addresses
where the RULE's `transactional` label comes from the address **prefix** (`no-reply@`,
`notifications@`, `support@`...) regardless of what the sender's business actually is, while the
model — given only the address and no notion that a prefix shape overrides content — reasonably
inferred a **semantic** category from the domain instead (`do-not-reply@ses.binance.com` scored
`other`; a human would probably also not guess "transactional" from that address alone). The
oracle is measuring whether the model can guess an arbitrary structural convention, not whether
it can do the tail's actual job — and the tail, by construction, is exactly the addresses no
prefix rule already caught, so this mismatch cannot even occur on the real tail. **Not fixed
here.** A fair oracle for this script would need to exclude prefix-only rule matches (or the
model would need the prefix convention explained to it), and `gmail_senders` does not currently
record which specific rule classified a row, so building that filter is its own small piece of
work — left for whoever picks this up next, with the evidence attached rather than a floor
quietly loosened to make a number pass.

## Model tiers, measured 19 Aug 2026 on this machine (8151 MiB VRAM)

| Model | VRAM | GPU | Warm | Accuracy on the oracle | Honours a JSON schema |
|---|---|---|---|---|---|
| **qwen3.5:4b** (`LOCAL_DEFAULT`) | 3.4 GB | 100% | 12.5s | 10/12 (83%) | yes |
| qwen3.5:9b | 6.6 GB | 64% (spills to CPU) | 17.7s | 1/2, batches timed out | yes |
| ~~gemma4:12b~~ — **measured, then deleted, 19 Aug** | 7.6 GB | 61% | 35.3s | 10/12 (83%), tied with the 4B | yes |
| gpt-oss:20b-cloud (`CLOUD_DEFAULT`) | — (leaves the machine) | — | — | — | **no** — measured returning plain text against a strict schema, twice |
| gpt-oss:120b-cloud | — (leaves the machine) | — | — | — | unmeasured |

The 4B beats the 9B on every axis here because weights-plus-KV-cache is the real constraint, not
weights alone — a model that spills to CPU is slower **and** less reliable than one that fits.
gemma4:12b tied the 4B on accuracy and lost on everything else (2.2x the disk, 39% CPU spill,
2.8x slower warm) — **measured before being deleted**, deliberately: an unmeasured model sitting
on the shelf looks like a spare option, and deleting it unmeasured would have removed the
unknown without ever answering it. `LOCAL_MODELS` is now just the two rows above it. Do not
reach for a bigger local model without re-measuring; the smaller one has won twice now.

## How to work here

Before adding a new offload site: run `node tools/offload-router.cjs --policy`, check the task
against the three gates above, and route the call through `tools/ollama-run.cjs` — not a new
direct fetch to `11434`. Any script touching the database still needs its own
`db.setProcessActor(...)` call; `ollama-run.cjs` does not do that for you, because it does not
know what the caller's write means.
