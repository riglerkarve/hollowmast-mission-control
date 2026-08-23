# Verification report — the dead/alive instrument rule

**For the Team Supervisor and the Team Manager.** Written by a third session (Survive),
23 Aug 2026. Commissioned as a read-only check of the debate the two of you argued about
which Mission Control instruments are dead, and the rule you landed on.

**Nothing in the repository or the database was modified by this audit.**

Every claim is marked **HELD**, **DID NOT HOLD**, or **COULD NOT CHECK**, with the
reproduction beside it. The third category is kept separate on purpose: it is the one that
gets silently folded into "fine".

> Not to be confused with `VERIFICATION-2026-08-23.md`, which is a different report on a
> different debate, written earlier the same day.

---

## Read this first — two caveats that bound the whole report

**1. Every count here is a timestamp, not a constant — so do not trust this page, run the
checker.**

```bash
node tools/verify-liveness-rule.cjs
```

The snapshot behind the prose is `data/dashboard.db` via `VACUUM INTO` at **2026-08-23T12:14Z**.
`verify-liveness-rule.cjs` re-derives all fifty figures from a fresh snapshot and sorts them into
**HELD**, **MOVED** (expected — the figure tracks live data and the finding stands), **CHANGED**
(a load-bearing figure moved, so a sentence below is now false, and it names which), and **COULD
NOT LOOK**. Exit 0 means every load-bearing finding still holds; 1 means one broke; 3 means it
could not look and the run is not clean.

This replaces the sentence that used to sit here, which read *"where my number differs from yours
by one, assume drift before assuming error."* That was an apology, not a check. **Thirty-five
minutes of drift while this was being written is why:**

| | at 12:14Z | at 12:49Z |
|---|---|---|
| `team_decisions` | 46 | 47 |
| non-internal tables | 85 | 86 — `finance_purposes`, finance migration v5, landed 13:45:28 local |
| panel directories | 69 | 70 — a `purpose` panel appeared, carrying POST and DELETE |
| panels with a write path | **31** | **32** |

That last row is the whole argument for the checker. Claim 6 said *"32 of 69"*. It was **31 of 69**
when measured, and it is now **32 of 70**. Anyone re-checking the numerator alone at the wrong
moment would have "confirmed" a figure that was wrong when it was stated. A figure agreeing with
you is not evidence unless you know what would have made it disagree.

**2. I did not re-examine what to *do* about any of this.** Finding (b) establishes that
deleting the cited tables would break live code. It does not say what should replace them.
That decision is still yours.

---

## How to reproduce it

`tools/verify-liveness-rule.cjs` does everything in this section automatically, including the
control. What follows is what it does, for anyone checking the checker.

There is no `sqlite3` CLI on this machine. Node 24 has `node:sqlite` built in, which is what
`server/db.js` already uses.

```js
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('<path>/dashboard.db', { readOnly: true });
db.exec("VACUUM INTO '<scratch>/snap.db'");
```

**The control, re-run before trusting any figure.** A plain file copy reads `tool_runs` at
**983** where the VACUUM snapshot reads **993**. The WAL warning is real. Check `CTRL` re-runs
this every time rather than citing the number, because a control you stop running is decoration.

But note what the control also shows: **every figure either of you cited is WAL-insensitive.**
The stale copy returns identical values for all of them. The method mattered in principle and
changed none of your numbers.

**One declared observer effect.** The checker calls `_run-log.cjs` like every other tool here,
which writes a row to `tool_runs` — a table this report cites. So running it increments one of
the figures it checks. `tool_runs` is treated as volatile and `CTRL` measures the WAL *gap*
rather than pinning a count, so the effect changes no finding. It is stated rather than hidden
because a tool that quietly moved its own evidence would be the exact defect this report was
commissioned to find.

**A caution earned during this audit.** My first reader-census reported *zero readers* for all
24 tables it examined. That was a shell heredoc consuming one backslash from a whitespace
escape, collapsing it to a literal letter — the pattern then matched nothing. Absence and
failure looked identical, and the result was flattering. Every checker below was run against a
positive control first. Do the same before believing a clean sweep.

---

## HELD

| Claim | Finding |
|---|---|
| **1** — journal 1, wellbeing 1, lifestyle_intake 0, cash_counts 0, exercise 1, crm_clients 1, focus_sessions 13 last 2026-08-19 01:35:04, alerts 31 events / 31 unjudged / 0 verdicts | **All arithmetic exact.** |
| **2** — gmail_messages 69,237 newest 2026-08-23; finance_transactions 6,839; browsing_domains 811; drive_files 43 | **All four exact.** Internal cross-check: `gmail_sync.messages_held` 65,616 + 3,621 = 69,237 exactly. |
| **3** — team_decisions 46; todo_items 427 with 21 declined | **Exact.** |
| **5** — 5 rows, 4 from `briefing-auto`, today's briefing printed the question 3 times at 27/27/32 | **Headline exactly right.** Briefing dated 2026-08-23, lines 7 / 16 / 25 of the stored markdown. |
| **7** — $224.93 lifetime, ~78 months, ~$2.88/month, 3 of 5 streams empty, currency USD | **All exact.** 2020-02 to 2026-08 is 78 months; 224.93 / 78 = 2.884. All 22 entries are USD. |

**Claim 3's *method* also holds, and this is worth stating because it was the obvious place to
find a mistake.** `decided_by` is the schema-sanctioned column — `team.js` comments it as
*"a session title, or 'owner'"*. The nine rows reading `role='architect', decided_by='owner'`
are the architect **recording** an owner decision, not deciding one; `role` is the recording
session's role. Choosing `decided_by` was correct.

---

## DID NOT HOLD

### 1. Claim 3 is off by one, permanently

Row `id=22` stores `decided_by='Owner'` with a capital O.

```
decided_by = 'owner'         33
lower(decided_by) = 'owner'  34
```

You said 32, which was probably right this morning — nine owner decisions landed today. But
the capitalisation split undercounts an exact-match query **forever**.

Worse, three columns in the same table disagree about who decided:

| Column | Owner-attributed rows |
|---|---|
| `decided_by = 'owner'` | 33 |
| `role = 'owner'` | 25 |
| `by_whom = 'you'` | **13** |

This is the same failure shape as the `Mission Control` / `mission-control` vocabulary bug the
workspace `CLAUDE.md` already documents.

**What would change the answer:** if `by_whom` is authoritative rather than `decided_by`, then
"he adjudicates" is 13/46 = **28%**, not 70%, and clause 3 of the rule weakens sharply. The
schema comment backs `decided_by`; the provenance layer writes `by_whom`. **This is genuinely
yours to settle and it swings the rule either way.**

### 2. Claim 4 is not a counterexample

`server/gate.js` **exempts loopback** — its own header states it: only a caller arriving over
the network must prove itself, because a local process could read the database file directly
anyway.

So `gate_devices = 0` means *the dashboard has never been opened from the phone*.
`gate_attempts = 0` confirms it — no unlock has ever been attempted. The key file exists
(`data/gate-key.txt`, 17 Aug), so enrolment was set up and simply never needed.

This is not a one-time act with a large payoff that was skipped. **The payoff is zero unless
you are off-machine.** Both sides read a row count as measuring owner diligence when it
measures network access.

### 3. Claim 5's "4 byte-identical" is wrong — and the reality is worse

sha1 of the `question` column:

```
id 7  db0b4d741d
id 8  db0b4d741d
id 9  db0b4d741d
id 10 6f51637c3a   <- 32 owner items, not 27
```

Only **three** are identical. But the `options` blob is byte-identical across **all four**
(`810600209f`) — so today's question claims 32 outstanding items while offering the four
options generated when there were 27. **The question contradicts its own options.**

### 4. Claim 5's reasoning has the arrow of time backwards

This is the most important correction in the report.

```
briefings.created_at        2026-08-23 07:00:32  (localtime)  = 06:00:32Z
team_steering 8,9,10        answered_at 11:33:37.896 / .909 / .916 Z
```

The answers were written **five and a half hours after** the briefing — all three in one
20-millisecond burst, identical answer text, `by_whom='unknown'`. At the moment the briefing
ran, those rows were genuinely unanswered.

"All ANSWERED, yet today's briefing printed the question 3 times" is an artefact of comparing a
06:00Z document against a post-11:33Z database. **There is no paradox.**

Checked rather than assumed: the upsert at `scripts/briefing.cjs:808` refreshes `created_at` on
conflict, so 07:00:32 really is when that markdown was last written.

**The defect — corrected 23 Aug after `survive-1e` caught what I had missed.** I originally named
the date-only dedupe as the bug. It is real, and it is the *second* one. Both are recorded here
because the first draft's diagnosis was downstream of the actual cause.

`server/routes/team.js:1628`, `ensureSteering` dedupes on **date only**:

```sql
SELECT id, asked_by FROM team_steering WHERE substr(asked_at,1,10) = ?
```

One question per calendar day, no content check. But that is not why the question repeats.

**The owner answered it, and answering resolves nothing.** Two steering rows carry
`by_whom='you'` — #2 answered in 21 minutes, and **#7, a `briefing-auto` question, answered the
same day it was asked**. Rows #8, #9 and #10 were each asked *after* #7 was already answered
(compared as instants, not strings):

| | asked | answered | by |
|---|---|---|---|
| #7 | 20 Aug 06:31:05Z | 20 Aug 16:07:56Z | **you** |
| #8 | 21 Aug 03:30:58Z | 23 Aug 11:33:37.896Z | unknown |
| #9 | 22 Aug 16:57:05Z | 23 Aug 11:33:37.909Z | unknown |
| #10 | 23 Aug 00:00:26Z | 23 Aug 11:33:37.916Z | unknown |

The item his answer to #7 selected is `team_owner_items` id 2 — *"Chrome extension has been
unreachable since ~15:20"*, `first_seen_at` 19 Aug, `filing_count` **5**, and `resolved_at`
**still NULL**. The answer wrote to `team_steering.answer` and stopped there.

> **Corrected 23 Aug, and the correction is mine to own.** This paragraph originally read *"the
> only path that ever sets `resolved_at` is `team.js:126`."* That is false. There are **three**
> writers of `team_owner_items.resolved_at` — `:128` (the handover path), **`:803` (a per-item
> HTTP resolve endpoint)** and `:813` (a legacy whole-block path) — plus `:815` writing
> `team_handovers.owner_resolved_at`.
>
> I missed them because I ran `grep -n "resolved_at" server/routes/team.js | **head -8**`. The
> truncation cut at line 723 and hid 803 and 813. **A filter that dropped candidates and did not
> report its residue** — law 3, which this report cites against other people twice. Caught by
> `survive-1e`, not by me.

**The corrected finding is sharper, because two independent gaps stack.** A resolve path exists at
`:803`. But reaching it requires passing the roster gate at `:778`, which establishes the
resolver's *engine* so it can refuse same-engine review — a rule written to stop two sessions on
one model reviewing each other, and correctly failing closed on an unknown engine. `engineOf('owner')`
is falsy, so **the human owner is permanently refused with `403 "resolver is not on the roster"`**
by a check that was never aimed at him. That is **M336**, filed P1 today.

So the accurate statement is:

> **A resolve path exists. He is locked out of it by a roster check meant for sessions. And
> nothing connects his answer to it even if he were not.**

Two distinct defects, and **neither fixes the other**. Fix only M336 and the briefing still
recomposes the question, because answering still does not resolve. Fix only the missing edge and
it calls an endpoint that rejects him.

So `openOwnerItems()` still returns item 2 as the oldest open item and the briefing recomposes the
identical question every morning. Corroborating:

```
team_owner_items resolved BY THE OWNER    0 of 48
still open                               42 of 48
```

The six that are resolved were closed by the Architect, Codex Worker and Team Manager, and every
`resolved_note` says *parser false positive* or *no owner action required*. Not one was resolved
by him acting on it.

**Why the ordering matters for anyone fixing this.** A content-aware dedupe would not help. The
question is not copied from yesterday's row — it is **recomposed from data that has not changed**.
Suppressing the duplicate hides the symptom and leaves a man answering into a table that forgets
him. The missing edge is `answer → resolve`, not `question → question`.

### 5. Claim 6 is 31, not 32

69 panel directories confirmed. I tested six write idioms with comments and string literals
stripped: literal `method:`, variable `method:`, `api.post/put/patch/del`, `sendBeacon`,
`XHR .open`, and form submit.

**Residue reported, per the filter rule:** zero panels lack a `.js` file; zero read-only panels
mention POST/PATCH in prose only; **zero panels match a non-literal write idiom.** So 31 is
robust under any reasonable definition — the count does not depend on which idiom you key on.

Also found: **68 of 69 panels are registered** in `public/shell.js`. Only `lede` is orphaned.
(`CLAUDE.md` still says *"Panels in the registry 63"* — stale.)

> **This figure moved while the report was being written, and the movement is instructive.** A
> `purpose` panel landed at ~12:48Z carrying POST and DELETE, taking the count to **32 of 70**
> with two orphans (`lede`, `purpose`). So claim 6's numerator is now right and its denominator
> wrong. Run the checker rather than reading this paragraph: checks `6a`–`6e` re-derive it.

### 6. Claim 7's "one dead since Dec 2024" is false at the stream level

True of `income_entries`. But `income_balances` shows `source='honeygain-api'` writing **daily**:

```
2026-08-18  2048
2026-08-19  2051
2026-08-20  2056
2026-08-21  2060
2026-08-22  2066
2026-08-23  2071   at 06:00:33
```

Honeygain is accruing. Only the **manual transcription** of it died. This is your own rule
working perfectly, and it was cited as a dead stream.

Three smaller points on the same claim:

- **`income_entries.currency` defaults to `'GBP'`** while all 22 rows are USD. The next entry
  recorded without an explicit currency silently mixes into the total.
- **`period` mixes two semantics** — serpclix rows are month-starts, honeygain rows are payout
  dates — and there are multi-year gaps (2022-04 to 2023-03, 2024-12 to 2026-02). So $2.88/month
  is *recorded income divided by elapsed months*, not a monthly rate. It is also nominal: 2020
  and 2026 dollars summed.
- **serpclix 2026-08-01 = $60.45**, recorded 18 Aug. 27% of lifetime income was booked this month.

---

## (a) Does the rule hold across tables you did not cite?

**No. It fails in both directions.**

### Clause 3 fails hardest

Nineteen tables are empty. **Fourteen of them require no recurring owner act at all** — they are
session- or script-operated:

`team_arbitrations` · `brain_decisions` · `brain_flags` · `work_items` · `viability_scenarios` ·
`analytics_traffic` · `crm_followups` · `todo_kind_log` · `focus_active_sessions` ·
`focus_project_targets` · `browsing_news_topics` · `browsing_news_briefings` ·
`browsing_news_feedback` · `scribe_caps`

Clause 3 predicts these should be the working ones. They have zero rows.

### Clause 1 fails on omitted evidence

The five emptiest recurring instruments were cited; the ones that work were skipped:

| Table | Rows | Newest | Provenance |
|---|---|---|---|
| `lifestyle_foods` | 25 | — | `by_whom='you'` |
| `lifestyle_chores` | 16 | **2026-08-23** | — |
| `lifestyle_done` | 6 | 2026-08-21 | `by_whom='you'` |
| `lifestyle_meals` | 6 | 2026-08-20 | `by_whom='you'` |

All recurring owner capture. All with data. **You selected your evidence and said so; this is
what the selection cost.**

### Two confounders neither side controlled for

**Age.** From `schema_meta`:

```
journal              2026-08-20 07:18    three days old
crm                  2026-08-20 15:05    three days old
viability            2026-08-23 01:39    created TODAY, 0 rows
creative             2026-08-23 10:43    three hours old, 8 rows
```

Calling a three-day-old table dead is not supportable. `viability_scenarios = 0` is a table
created this morning.

**Rows per act.** A manual capture yields one row per act. The gmail OAuth act yielded 69,237
rows plus a daily sync. *"One-time acts produce the richest data"* is close to tautological when
the one-time act is a bulk import of years of history.

### The discriminating test — and the rule loses it

The rule predicts one-time-owner-act tables are the rich, living ones. The alternative
hypothesis is that liveness tracks **automated writers**, with owner involvement a correlate.
These predict opposite things for the same tables:

| Table | Label | Newest write |
|---|---|---|
| `alert_events` | **DEAD** | 2026-08-23 12:06:31 — 8 min before snapshot |
| `tool_runs` | not cited | 2026-08-23T12:12:35Z |
| `income_balances` | not cited | 2026-08-23 06:00:33 |
| `gmail_messages` | ALIVE | 2026-08-23 |
| `finance_transactions` | ALIVE | 2026-08-11 |
| `drive_files` | ALIVE | all 43 rows within two seconds, 18 Aug 09:15 |
| `browsing_domains` | ALIVE | **all 811 rows at one instant**, 18 Aug 01:38:27 |
| `health_metrics` | not cited | **all 269 rows at one instant**, 17 Aug 21:16:59 |

**Three of the four ALIVE tables are frozen single imports.** A table labelled DEAD has a newer
write than all three. And `gmail_messages` moves because `gmail_sync.last_run_at` fired at
07:00:04 today — a **scheduled task**, not the owner's one-time act still paying out.

The word ALIVE is doing double duty in claim 2: *rich* for three of them, *receiving data* for one.

---

## (b) Is any dead table read by a live panel?

**Yes. Deletion would be destructive in every cited case but one.**

| Table | Readers |
|---|---|
| `focus_sessions` | **seven**, including `scripts/briefing.cjs:159` — deleting it breaks the 07:00 job that ran this morning |
| `gate_devices` | `server/gate.js` — **auth middleware** |
| `gate_attempts` | `server/gate.js` |
| `wellbeing_entries` | `stats.js` **as well as** its own route — feeds an aggregate |
| `journal_entries`, `cash_counts`, `exercise_sessions`, `crm_clients`, `lifestyle_intake`, `alert_events` | each read by its own live route |

68 of 69 panels are registered, so "live panel" is very nearly all of them.

**`team_arbitrations` was the only genuinely orphaned table**: 0 rows, 0 readers, 0 writers.

> **Superseded the same day.** M340 built the write path — `POST /api/team/arbitration` at
> `team.js:1365` — so it is no longer an orphan and this report should no longer be cited as an
> argument for deleting it. It was built rather than dropped on the schema's own evidence: the
> comment beside `arbiter_engine` says it exists *"so a lean toward its own engine is countable"*,
> which is a designed measurement that only works if rows accumulate, and the Team Manager had
> already tried to use the table once and reported the M76 ruling in prose because no route
> existed. Check `8e` was rewritten in the same change — it previously asserted 0 rows forever and
> called the table safe to delete, and `table-census.cjs` flagged it as an assertion reader that
> the first real arbitration would break.

**A side effect worth knowing.** `alerts.js` implements *"a kind marked ignored twice mutes
itself."* With 0 verdicts that rule has **never fired**. The dead adjudication loop has silently
disabled the alert system's own self-tuning.

---

## (c) Does anything else carry the `requests.jsonl` defect?

**Yes, twice. The withdrawal was correct, and the same switch is still in the set.**

Counted properly via `readRequests()` — never by grepping `status`, per `CLAUDE.md`:

```
rows 91 · events 107 · bad 0 · dangling 0 · open 9
authored "owner (mid-turn)"            2
authored "supervisor (relaying owner)" 3
```

By total rows it looks alive; by owner acts it is the same order as `journal = 1`. **The
denominator was switched between the two.** (The file also still carries one id collision:
`R027` has 2 rows and 4 events landing on the collided id.)

**The same switch survives in your set:**

1. **`alert_events` (0 of 31 adjudicated → DEAD) vs `todo_items` (21 of 427 → WORKING).**
   Both are *"a session generates, the owner adjudicates"*. Rates 0% and 4.9%. Neither is a
   functioning review loop. Opposite labels.
2. **`alert_events` (automated writer, row 8 minutes before snapshot → DEAD) vs
   `gmail_messages` (automated writer, rows today → ALIVE).** Identical shape on the write side.
   The only difference is a `verdict` column, which is a property of the **feedback loop**, not
   of the instrument.

**Also misfiled:** `focus_sessions` is not an owner instrument at all. Twelve of its thirteen
rows are `by_whom='claude'`, one is `unknown`, **zero are the owner's**. It sits in the DEAD
bucket labelled *"recurring owner act"*, describing something the owner never did.

---

## COULD NOT CHECK

1. **Who adjudicated `todo_items`.** No `by_whom` column. 239 rows carry `decided_at` across
   144 distinct moments over 5 days, but the largest burst is **seventeen in one second**, and
   **7 of the 21 declined rows have no `decided_at` at all**. "He adjudicates" is unverifiable
   from this table.
2. **Provenance generally.** Only **19 of 85** non-internal tables carry a
   `by_whom` / `tracked_by` / `author` column. For the other 66, "who acted" is not recorded.
   **This is the honest ceiling on the whole debate** — the rule's central variable is
   unmeasurable across 78% of the schema.
3. **Whether the owner ever *saw* any of it.** No read receipts anywhere except
   `team_handovers.read_at`.
4. **`income_balances` units.** `amount = 2071`, `currency = USD`. Cannot tell from the schema
   whether that is $20.71 or $2,071 without the Honeygain API contract. Does not affect the
   liveness finding.
5. **Whether the 27 → 32 owner-item jump is real growth** or a change in `openOwnerItems()`'s
   filter.
6. **Cross-clock comparisons.** **51 tables** default to `datetime('now','localtime')`; the
   `team_*`, `tool_runs`, `analytics_probes`, `scribe_*`, `board_imports` set writes ISO-Z. In
   BST that is a **one-hour offset**. It happened not to matter for claim 5 — the gap was five
   and a half hours — but any comparison under an hour across that boundary would invert. Check
   which clock a column uses before differencing two tables.

---

## The rule, reframed

The mechanism is not owner involvement. It is **whether anything other than a human writes on a
schedule.** That single variable predicts every table in the census, including the ones that
break all three clauses.

Owner effort is a **correlate**: the tables needing recurring human input happen to be the ones
with no scheduled writer, and the bulk imports happen to be rich because one act imported years
of history. Where the two come apart, the automated writer wins — `browsing_domains` and
`drive_files` were one-time owner acts and are frozen; `alert_events` and `income_balances` need
no owner act and wrote today.

**The practical advice survives the reframing and gets sharper.** Honeygain is the proof: the
manual transcription died in December 2024, the API collector has written every morning this
week. The lesson is not *"one-time acts beat recurring acts"*. It is:

> **Automate the collector, and only ask the owner for what cannot be collected.**

---

## Open items

Two things I would have filed, but the brief was read-only. **Decide whether these go to the
backlog and who owns them:**

- **`answer → resolve` has no code path.** Answering a steering question writes
  `team_steering.answer` and never touches `team_owner_items.resolved_at`, so the briefing
  recomposes the same question the next morning. This is the one that matters; the dedupe below
  is downstream of it. **Stacks with M336** — the resolve endpoint that *does* exist (`team.js:803`)
  refuses the owner with `403 "resolver is not on the roster"`, because the roster gate at `:778`
  establishes an engine to refuse same-engine review and the human has none. Fixing either alone
  leaves the loop open.
- `server/routes/team.js:1628` — `ensureSteering` dedupes on date only. Real, worth fixing,
  **not the cause** — see the correction under claim 5.
- `team_decisions` `id=22` — `decided_by='Owner'` breaks exact-match counting of owner decisions.

**And push back on this report.** Specifically:

- If you think `by_whom` rather than `decided_by` is authoritative for `team_decisions`, say so —
  it changes clause 3 from 70% to 28%.
- If any table called frozen here has a writer I did not find, name it. The reader census covered
  `server/`, `public/`, `scripts/`, `tools/` — **245 files** — with comments and strings stripped.
  It would miss a writer in a scheduled `.ps1` or an external process.

**Before citing any figure above, run the checker.** If it exits 0, the prose is safe to quote.
If it prints CHANGED, it names the sentence that broke. If it prints COULD NOT LOOK, nothing was
verified and the run is not clean — that case is kept separate precisely because a checker that
failed to look and a checker that found nothing wrong print the same reassuring silence
otherwise.

*Checker caveat, stated because it applies to the checker too: its first run raised six alarms,
**four of them false** — checks returning an enriched string like `"yes, by 5.6 h"` were compared
against the recorded `"yes"`, so a stable finding reported itself as broken. Verdict and evidence
are now separate values. If it ever starts alarming on things that read fine, suspect that split
before suspecting the data.*
