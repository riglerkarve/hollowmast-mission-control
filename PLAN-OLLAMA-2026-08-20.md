# Ollama — the plan, and why it is short

**Companion to `PLAN-2026-08-20-to-23.md`.** Read that one first; this covers only the model
tier.

---

## Start here: Ollama is not an agent

It has no scheduler, no memory between calls, and no way to pick up work. It is a model server.
**Every job below needs something to drive it**, and this week that is Codex during its own
shifts — not a new scheduled task.

That is a deliberate refusal. Five scheduled tasks already exist and each is a thing that can
silently stop. Adding a sixth during four unattended days is the same call the main plan makes
about MCP: **a standing capability that runs when nobody is watching gets decided before it gets
built**, not during.

If a recurring model job turns out to be worth having, it hangs off the existing briefing pass —
one run a day, no new task — which is exactly how the daily triggers were added.

---

## The honest state: its original job is finished

The local tier was justified by one measured job — categorising UK bank transaction descriptors.
That job is **complete**:

```
ledger rows            6,839
uncategorised              0
categorisation rules     110   (rules did 95.3%, the model 4.7%)
```

**There is no bulk work left of the kind this tier exists for.** What remains is small:

| Job | Items | Oracle | Est. time |
|---|---|---|---|
| Assign `project` to unlabelled backlog items | 127 | 81 already labelled | ~2–3 h |
| Re-score the 21 kinds written while rules-first was inverted | 21 | the rules themselves | ~20 min |

At the measured rate — `qwen3.5:4b`, 12.5s warm, batches of ten — that is **two to four hours of
model time in total**, not four days.

**Do not pad this.** Inventing jobs to keep a model busy is precisely the surface-you-must-feed
that the workspace gate rejects, and a model running for its own sake produces plausible output
nobody asked for. If both jobs finish on Thursday, the local tier is done for the week and that
is the correct outcome.

---

## Job 1 — `project` on 127 backlog items

`tools/llm-probe-project.cjs` exists and already has the shape.

**Score before you write.** The 81 labelled items are the oracle. Run blind against them, and
keep the two buckets separate: items whose title names the project are the easy end **by
construction**, so a blended accuracy figure flatters the model exactly where it matters least.
A score on the labelled set is an **upper bound** on the real job, never an estimate of it.

**The floor is 80%.** Below it, write nothing and say so. Above it, write — `project` is a filter
and a routing hint, not a figure; it is visible on the board and one `UPDATE` undoes it. That is
why a model is allowed near it at all.

**Report the misses individually.** An accuracy figure with the misses hidden is decoration.

---

## Job 2 — re-score the 21 model-written kinds

`ollama-shift.cjs` had rules-first inverted when those were written, so the deterministic pass
never ran on them. It is fixed.

**Report the disagreements. Do not overwrite.** Where the rules and the model now differ, that is
a finding about the **rule** as often as about the model — and there is already evidence for
that reading: a 4B and a 12B scored *identically* (10/12) and missed the **same two items**. Two
different models agreeing on a "wrong" answer is a signal about the test, not the models.

Check those two before treating 83% as a ceiling on capability. It may be a ceiling on the
oracle.

---

## What it must never be given

`server/ollama.js` enforces this on the payload, before the request is made. **The rule is yours
to keep, not the guard's** — a guard is a backstop, not a permission slip.

- **Anything naming finance, health, wellbeing, or a credential** may use a model **on this
  machine** and may never use one off it.
- **Nothing from the wellbeing module at all**, local or otherwise. Fixed policy: no prose, no
  pattern, no score.
- **No figure that appears anywhere.** Arithmetic is SQL's job. A plausible total is worse than
  no total.
- **Nothing auto-applied without a review path.** Every write above is reversible in one
  statement and visible on the board; that is the condition, not a nicety.

**The trap worth restating:** local and cloud models are served by the *same* endpoint.
`127.0.0.1:11434` is not evidence that data stayed here — only the absence of `-cloud` in the
model name is, and that is a suffix in a string.

---

## Which model, and why not the bigger one

```
qwen3.5:4b        3.4 GB   100% ON GPU   12.5s warm   honours JSON schemas   ← default
qwen3.5:9b        6.6 GB    64% on GPU   17.7s warm   batches timed out
gpt-oss:20b-cloud  cloud     n/a          1.25s       IGNORES JSON schemas
```

**Use `qwen3.5:4b` for everything here.** The 9B spills 36% to the CPU and is slower *and* less
reliable than the 4B that fits entirely. `gemma4:12b` was measured and deleted — it tied on
accuracy and cost 2.2× the disk and 2.8× the time.

**The cloud tier cannot do either job.** Both need a constrained enum, and `gpt-oss` ignores
schemas — returning `X1: Bug   X2: Feature Request` as plain text where JSON was demanded. It is
faster and larger and **fails the gate that matters**, which is not a smaller version of passing
it.

Three settings that are not optional:

```js
keep_alive: '15m'            // without it every batch reloads: 17.4s instead of 2.9s.
                             // This is what turned a 44-item probe into four timeouts.
format: <schema with enum>   // never bare format:'json'
options: { temperature: 0 }  // so a rerun of the same input gives the same answer
```

---

## When it fails — and it will, it is a desktop app

| Symptom | What it means |
|---|---|
| Connection refused on `:11434` | Ollama is not running. **"Could not look" — never a score of zero.** |
| A batch times out | Almost always no `keep_alive`, so the model reloaded. Check `/api/ps` for residency before blaming the model. |
| Empty `message.content` | It is a **thinking model** — the answer may be in `message.thinking`. An empty answer is not an empty question. |
| HTTP 200 with an `error` body | A retired cloud model. A naive `res.ok` check reads this as a successful empty answer. |
| Unparseable JSON from a cloud model | Expected. `gpt-oss` ignores schemas. Not a bug to fix — a tier not to use. |

**In every case: record it as could-not-look, and never as a result.** A model that did not answer
must never be scored as a model that answered wrongly.

---

## For the owner, on Sunday — one question, not a task

**Is the local tier still worth keeping, now that the job that justified it is finished?**

The evidence for keeping it: it is free, private, fits the card, honours schemas, and is the
*only* tier permitted to see finance or health data. That last one is not a small thing — it is
the only reason any model may go near the ledger.

The evidence against: after this week there is no queued work for it, and the measured record is
that deterministic rules did **95.3%** of the one real job while the model did **4.7%**.

**The recommendation:** keep it, and stop looking for work for it. It earns its place as the
tier that *can* see private data, not as a workhorse — and the moment somebody invents jobs to
justify a model, the model has started costing more than it returns.
