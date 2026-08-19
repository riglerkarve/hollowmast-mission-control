# Ollama — the plan, and why it is short

**Companion to `PLAN-2026-08-20-to-23.md`.** Read that one first; this covers only the model
tier.

---

## Start here: Ollama is not an agent — with one correction

It has no scheduler, no memory between calls, and no way to pick up work. It is a model server.
**Every job below needs something to drive it**, and this week that is Codex during its own
shifts — not a new scheduled task.

**The correction, found after this plan was first written.** `ollama launch <name>` exists and
offers **19 agent integrations** — Claude Code, Codex, OpenCode, Hermes, Qwen Code, Cline and
others. So Ollama *can* drive an agent, and the sentence above was too absolute.

But it changes less than it appears to, because of what it launches them **against**:

> `ollama launch claude` runs Claude Code **backed by an Ollama model** — `qwen3.5:4b` or
> `gpt-oss:120b-cloud` — not by Opus. `ollama launch codex` does the same to Codex.

**For the two agents already working here, that is a downgrade, not an upgrade.** Claude Code
runs on Opus 5 and Codex on gpt-5.6-terra through a paid subscription. Re-pointing either at a
4B model would make it dramatically weaker at the work it is doing.

**And there is a specific hazard: `ollama launch codex` would reconfigure the Codex that is
about to run 27 unattended tasks.** Its live config is `model = "gpt-5.6-terra"`,
`model_reasoning_effort = "high"`, `auth_mode = chatgpt`. **This was deliberately NOT tested** —
finding out by trying it could break the agent mid-plan, and a four-day unattended run is the
worst possible moment to discover a reconfiguration.

**Do not run any `ollama launch` command this week.** If one is wanted later, see the last
section.

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

## Which model — re-measured 20 August, and the answer changed

**A model's file size is not its memory footprint, and that is what decides this.** The KV
cache lives in VRAM beside the weights, so a model's fit depends on the context it runs at:

```
qwen3.5:4b   3.4 GB file   5.3 GB resident  100% ON GPU   15s    schemas: yes   verdicts: NO
qwen3:8b     5.2 GB file  11.6 GB resident   54% spills   71s    <- at its DEFAULT 40K ctx
qwen3:8b     5.2 GB file   6.2 GB resident  100% ON GPU   18s    <- at num_ctx 8192  FITS
qwen3.5:9b   6.6 GB file        --           64% spills   --     batches timed out
```

**Use `qwen3.5:4b` for BOTH jobs in this plan.** They are classification against an enum,
which is the one shape it is measurably good at, and it is the faster of the two.

**But there is now a second local model and it can do something the 4B cannot.** Given the
same question twice with the evidence inverted, `qwen3:8b` returns REJECT then ACCEPT —
the verdict tracks the evidence. `qwen3.5:4b` does not, which is why it was refused the Team
Manager role (decision #21) and why `team-manager-verdict` sits in the capability table as a
recorded **failure**.

So: **4B for volume, 8B at `num_ctx 8192` for anything that needs a verdict.** Do not switch
between them inside one job — a reload costs 30–60s.

**The classification numbers CANNOT rank these two and this must not be reported as if they
can.** The oracle is contaminated (**M116**): up to 21 of ~70 stored labels were written by a
model and nothing records which, so a high score may be a model agreeing with its own earlier
pass rather than reading the items. The 4B scored 12/12 and the 8B 8/12 — and all four of the
8B's misses are the same shape, `Personal goal — X` items it calls `question` where the store
says `chore`. That is **one systematic disagreement, not eight errors**, and on at least one
of them (*CBT or driving licence*) the 8B is arguably right and the stored label wrong.

**`gemma4:12b` was measured and deleted** — it tied on accuracy and cost 2.2× the disk and
2.8× the time. **The cloud tier cannot do either job**: both need a constrained enum and
`gpt-oss` ignores schemas, returning `X1: Bug   X2: Feature Request` as plain text where JSON
was demanded. Larger and faster and **failing the gate that matters**, which is not a smaller
version of passing it.

Re-measure any candidate with `node tools/model-bakeoff.cjs --ctx 8192 <model>` rather than
trusting this table. The first run of that harness produced two wrong answers of its own —
it called a model unfit when it had merely not finished loading, and called a missing answer
a constant verdict. Both were absence rendered as failure.

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

---

## If a third agent is ever wanted — which, and why not yet

`ollama launch` offers 19 harnesses. The only role a third one could usefully fill here is a
**third independent review voice**, because cross-engine review is the one thing that has
demonstrably found what neither engine finds alone. Anything else duplicates Claude Code or
Codex, and the bottleneck this week is verification capacity, not agent capacity.

**Why not this week, and it is the same reasoning as MCP:** an agent harness is a standing
capability, installing one reconfigures things that currently work, and four unattended days is
the worst window in which to discover either.

**The technical objection is larger than the timing one.** The local models that fit this card
are 4B. A 4B is genuinely good at *one* thing — constrained classification against an enum,
where it scored 10/12 — and agentic coding is the opposite shape: multi-step tool use, file
edits, judgement under ambiguity. A small model does not fail loudly at that; it produces
**plausible edits**, which is the most expensive failure available in a repository.

The cloud alternative fails a different gate: `gpt-oss:120b` is capable and fast, and it
**ignores JSON schemas** (measured) and **leaves the machine**. An agent with file access
backed by it is a code-egress decision, not a model choice.

**If one is chosen later, in order:**

| | | |
|---|---|---|
| **1** | `opencode` or `qwen` | Plain coding agents, no self-modification. Qwen's model family is the one already measured here and it honours schemas. |
| **2** | `cline` | Well-defined scope, but adds an editor dependency this workspace does not otherwise have. |
| **avoid** | `hermes` | Described as a **self-improving** agent. An agent that modifies its own behaviour while nobody is watching is the single property this entire team structure exists to prevent — every rule here assumes the agent it constrains stays the agent it constrained. |

**And test it on one bounded task with a known answer before it is given anything real** — the
same way Codex earned its place, by being measured on work whose outcome was already known.
