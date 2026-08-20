# Ollama Cloud — the research tier's standing brief

Companion to `CODEX.md` and `OLLAMA.md`, same shape. Like local Ollama, the cloud tier has no
session that reads a charter at startup — it is a model, not an agent, and needs a driver
(currently Codex, during its own shifts, the same way it already drives local jobs per
`PLAN-OLLAMA-2026-08-20.md`). This file is what that driver reads before sending it anything.

**Why cloud, and why only for this.** Local (`qwen3.5:4b`) was tested tonight on one bounded
agentic-coding task with a known answer and failed it — plausible, well-commented code that threw
on every real input (`decision #26` in `team_decisions`). That is a finding about *agentic coding*
on a 4B, not about research or prose. Cloud (`gpt-oss:20b-cloud` / `120b-cloud`) is bigger, faster,
and **measured to ignore a JSON schema entirely** — useless for the structured classification jobs
local Ollama already owns, but schema-constrained output was never what research or ideation
needs. Use cloud for what it is actually good at instead of routing around what it failed at.

---

## What it's trusted for

**Research and project ideas — for tracks that already exist.** Market/competitive research,
distribution ideas for PrintProfit, launch-readiness research for HOLLOWMAST, options analysis
for an open backlog question, drafting the four-question MCP-gate-style writeups. Prose output,
not code, not a structural decision, not a number.

**Not a mandate to propose new projects.** Workspace `CLAUDE.md` is explicit and load-bearing:
*"HOLLOWMAST is the only game being built until it ships"*, *"One active build per track at a
time"*, and a **fourth game starting before HOLLOWMAST ships is a named kill criterion.**
"Project ideas" means ideas *for* Mission Control, PrintProfit, and HOLLOWMAST as they stand —
features, content, distribution angles, research questions worth answering — not proposals to
start a new, separate build. If a research output reads like "here is a new project", that is a
finding to flag to the owner, not a queue item to act on.

**Everything it produces is a proposal, never a decision.** Nothing from this tier is applied,
scheduled, or acted on directly — it is filed on the board as a candidate, the same "second
brain" as everywhere else in this workspace (board + handover chain, not `brain_notes`), and a
human or a separate review step decides whether it goes anywhere.

## What it must never touch

- **Anything the `SENSITIVE` regex in `server/ollama.js` would catch** — finance, health,
  wellbeing, credentials, account numbers. This is not a suggestion to route around because a
  particular research question feels harmless; it is checked on payload content and refuses
  before sending, the same as every other cloud call in this workspace.
- **The wellbeing module**, full stop — not even the partial exception the Scribe holds. That
  exception is specific to the Scribe's local tier, under review, and does not extend to cloud.
- **Anything requiring a JSON schema or structured output.** Measured: `gpt-oss:20b-cloud`
  returns plain text against a strict schema. Use local Ollama (via `tools/ollama-run.cjs`) for
  anything that needs an enum-constrained answer; use cloud only for free-form prose.
- **Code.** Not because of a rule here specifically, but because tonight's bounded test is the
  only real evidence this workspace has about a small local model doing agentic work, and it
  failed. Cloud coding ability has not been tested at all here. Until it is, on a bounded task
  with a known answer the same way local was, it is not trusted with a file edit.
- **A number that appears anywhere**, same as local Ollama and the same reason: arithmetic is
  SQL's job, and a plausible total is worse than no total.

## How it's driven, until something more automatic is built

There is no `ollama-cloud-run.cjs` yet — this session built `tools/ollama-run.cjs` for the local,
schema-constrained jobs, and cloud's job shape (single-turn prose, no schema, no file access) is
different enough that reusing it as-is would be forcing a fit rather than finding one. For now:

1. A single call through `server/ollama.js`'s `ask()` with `model: 'gpt-oss:20b-cloud'` (or the
   120b variant for a harder question) and no `schema` — the privacy gate applies automatically
   because it is the same function every other caller in this workspace already goes through.
2. The output is **read by a person or a Claude/Codex session before it becomes anything else** —
   written to a file under `reference/` or filed as a board item, not auto-applied.
3. If this becomes a recurring enough job to be worth a dedicated script, build one the way
   `tools/ollama-run.cjs` was built: centralise the actual repeated pattern, not a guess at what
   it might need.

## The standard this tier starts at

Zero. Local Ollama earned trust for categorisation through a measured probe before it was used
for real (`llm-probe.cjs`, 95.3%/4.7% rules-vs-model). The Scribe ships with an empty capability
table by design and proves each job before it is allowed to run it. Cloud research gets the same
treatment: **read the first few outputs closely rather than assuming the pattern holds**, and if
something reads as confidently wrong, that is itself a finding worth filing, not a one-off to
shrug at — a model producing plausible-but-wrong prose is a smaller blast radius than plausible-
but-wrong code, but it is the same failure shape tonight already found once.
