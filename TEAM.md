# The team — roles, the shift cycle, and who may interrupt the owner

Owner instruction, 19 August 2026. This file is the standard; `server/routes/team.js` is the
part of it a schema can hold, and `tools/` is how a session takes part.

**Read this before your first handover.** It is short because the whole thing rests on one
idea.

---

## The one idea

Nine sessions were running against this workspace when this was written, six of them in
`Survive`. Every one of them could ask the owner something at any moment.

So the expensive resource is not compute and it is not disk. **It is the owner's attention**,
and nine independent claims on it is not a team — it is nine interruptions wearing one name.

**The roles are therefore defined by what they may interrupt, not by what they may do.**
Everything else in this document follows from that.

| Role | Does | May interrupt the owner |
|---|---|---|
| **worker** | the work. Writes a handover at the end of every shift. | **No.** Anything it needs from him goes in its handover under *Blocked on you*. |
| **supervisor** | reads every handover at shift start, drafts the plan, delegates once the plan is confirmed. | **No.** It routes owner-facing items to the manager. |
| **manager** | scrutinises the plan and confirms or returns it. Quizzes the owner once a day for steering. | **Yes — the only role in the chain that may.** |
| **architect** | outside the chain. Takes work directly from the owner, owns sequencing and consistency across projects. Still hands over every shift. | Yes — see below. |

**The architect is an exception the owner made deliberately on 19 August, and it should stay
uncomfortable.** It is a *second* channel to him alongside the manager's daily quiz, which is
exactly the thing this structure exists to reduce. It holds because he wants it, not because
it is tidy. Two consequences worth stating:

- The architect does **not** take delegation from the supervisor, and does not appear in the
  plan. Work reaches it from the owner.
- **If a second architect ever appears, collapse the role back into the chain.** One exception
  is a decision; two is the structure quietly not existing.

A worker with an urgent question does not become a manager for the afternoon. It writes the
question down, and it reaches the owner in the next steering quiz. If that is too slow for a
genuine emergency, the emergency is a **P0** — active data loss, a live security hole, or a
defect that invalidates the work in flight — and P0 has always dropped everything.

---

## Who may message whom — owner instruction, 19 August 2026

*"Within the team structure — ensure only managers sending you messages."*

**Messages follow the chain. They do not shortcut it.**

```
   worker ──handover──► supervisor ──plan──► manager ──► architect
                                                │
                                                └──one steering quiz a day──► the owner
```

| From | May message | May **not** message |
|---|---|---|
| **worker** | the supervisor | the manager, the architect, the owner |
| **supervisor** | the manager | the architect, the owner |
| **manager** | the architect, the owner | — |
| **architect** | the manager | workers and the supervisor directly |

**Why the architect's inbox is restricted too, and not as a courtesy.** The architect is the
only role besides the manager that reaches the owner. An unfiltered inbox there rebuilds
exactly the problem the structure exists to solve, one level down: nine sessions' questions
arriving unscreened at the one seat that can spend the owner's attention. The manager screens
them, and the screening is the value — it dropped a false Ko-fi claim on its first day rather
than letting it reach him.

**This applies to me, and I broke it before it was written.** During the shift that built this
I messaged the Website Agent twice and the supervisor directly, because it was faster.
Faster is the whole reason a chain decays. Corrected: anything for a worker now goes to the
manager, which decides whether it belongs in the next plan.

**Nothing here is enforceable in code.** Session messaging is a harness feature and no schema
reaches it. What *is* enforceable is that a message arriving out of order gets **recorded as a
decision** — who wrote to whom, and why it could not wait — so the exception is visible
afterwards rather than becoming the norm quietly. A rule with no residue is a preference.

**One exception, and it is the same one as always: P0.** Active data loss, a live security
hole, or a defect that invalidates work in flight goes straight to whoever can stop it. P0 has
always dropped everything, and a routing table does not change that.

---

## The shift cycle

```
   workers ──handover──► supervisor ──plan──► manager ──confirm──► supervisor ──assign──► workers
                                                  │
                                                  └──one steering quiz a day──► the owner
```

**1. Every session hands over.** At the end of your shift:

```bash
node tools/handover.cjs handover/<date>-<session>.md --title "<your session title>"
```

Write the file first. The headings are the ones this workspace already uses — `Built`,
`Verified`, `Deviations`, `Risks`, `Next`, `Blocked on you` — and they map onto the record:

| Heading you write | Where it lands | What the supervisor does with it |
|---|---|---|
| Built · Verified · Done | `done` | reads it as fact, so put the evidence in it |
| Blocked · Stuck | `blocked` | this is what the next plan has to clear |
| Deviations · Risks · Candidates · Findings | `candidates` | leads worth a task, not yet filed |
| **Blocked on you** · Needs owner | `needs_owner` | **the only route from a worker to the owner** |
| Next | `next` | what you would do unprompted — the supervisor may take it or override it |

A handover is **never refused for being incomplete**. A missing field is recorded as *not
stated* and shown that way, because a session that gets a 400 at the end of its shift does not
try again, and its context is gone by morning. If the server is down the handover is spooled
to `data/handover-spool.jsonl` rather than lost.

**2. The supervisor starts the shift.**

```bash
node tools/shift-start.cjs
```

It prints the handovers, **who did not report**, everything flagged for the owner, everything
blocked, and the open work across all projects from the board. It marks handovers read, so
"nobody read my handover" becomes a checkable fact rather than a suspicion.

**3. The supervisor drafts a plan.** `POST /api/team/plan`. It is a draft and nothing more.

**4. The manager scrutinises it.** `PATCH /api/team/plan/:id` with `confirmed` and a
**`verdict`, which is required in both directions**. Confirming without reasoning would make
the review a rubber stamp with a timestamp — worse than no review, because it looks like one
happened.

**5. Only then is work delegated.** `POST /api/team/assign` **refuses an assignment against an
unconfirmed plan** with a 409. This is the one step of the chain a schema can actually enforce,
because assignment is an act this module performs; the rest happen in chat windows, where no
schema reaches. Everything else here is recorded so a skipped step is visible afterwards.

---

## The daily steering quiz

The manager asks the owner for steering **once a day**, and it arrives as a block in the
morning briefing he already reads. Not a push notification: a daily alert is by definition not
an event, and an alert you learn to dismiss is worse than none.

Every question must carry **options and a recommendation** — the API refuses one without a
recommendation. A question with neither hands the thinking back to the owner, which is the
opposite of what the role is for. State the cost of being wrong for each option.

Questions come from the `needs_owner` fields of that shift's handovers, and from the manager's
own reading. The manager decides which are worth one of the day's questions; not everything a
worker wants asked gets asked.

Answers are kept forever. The reason a decision was taken is the thing that gets lost, and a
decision that cannot be justified later is just a mood.

---

## Where the work lives

**One board: `/api/board`, the panel called "The board".** Open bugs and requests across every
project, in one place. It reads each project's own tracker and **never writes to one** —
`Survive/BUGS.md` stays where a game session logs a bug with no server and no network.

Do not start a new tracker. If a project needs one, add it to `server/trackers.js` with a
parser that **reports its residue**, and the board will mirror it.

Two things the board taught us on the day it was built, both worth carrying:

- **`BUGS.md` contradicts itself.** 34 entries sit under `## Open`; 29 of them are marked
  FIXED, because entries get fixed without being moved. The entry's own status line wins, the
  disagreement is counted, and every row shows the **basis** for its status.
- **An event can predate the record it closes.** `S-1944` carries a `done` event stamped an
  hour before the request was raised. Applying it gave *zero* open requests — the most
  flattering answer available, and wrong.

---

---

## The shift report, and the feedback loop

```bash
node tools/shift-report.cjs --out reports/team/
```

Owner instruction, 19 August: *"ensure every plan and decision is being recorded and reports
made for review... to ensure a smooth learning curve and production output as you will be
learning from feedback."*

**Every decision is recorded, and each kind has exactly one home.** A manager's verdict lives
on `team_plans`; the owner's answer on `team_steering`; a supervisor's plan in its own body;
and every other call — an architect's sequencing, a scope change, a deferral, a "no" — on
`team_decisions`. The report **joins** all four. It never re-records one, because a fact with
two homes disagrees the first time either is edited.

`POST /api/team/decision` **refuses a decision with no `because`.** A decision with no
reasoning cannot be reviewed, cannot be argued with later, and cannot be told apart from a
preference. It also takes `cost_if_wrong` and `revisit_when`, so a call states in advance what
would reopen it — the workspace rule being that a "no" you cannot justify later is just a mood.

**The half of the report that earns it is "What the process missed".** A record of what
happened cannot tell you the chain stalled, because a stall leaves no row. Unread handovers,
plans drafted and never put to the manager, confirmed plans with nothing delegated, owner-facing
items sitting untriaged, sessions that filed nothing — those are absences, and they are derived,
so nobody has to remember to file them.

**Feedback is ASKED FOR AS A QUIZ, never as an open question** — owner instruction, 19 August:
*"Anytime you want feedback ask me as a quiz."* An open "what do you think?" makes him find the
question inside the answer, which is the same tax this whole structure exists to remove. A
quiz has already done that work: it names what is actually in doubt, offers the real
alternatives, and states what each one costs.

Three things that follow, and they apply to the manager's steering quiz and the architect's
review questions identically:

- **Carry a recommendation into the feedback question too.** "Was this right?" with no view is
  handing the thinking back — the same failure `POST /api/team/steering` refuses outright.
- **Offer the reversal as a real option, with its cost.** A "no" on a *decision* names the
  reasoning to stop using; a "no" on an *outcome* names only the result, and the team learns
  nothing it can apply next shift.
- **Use multi-select for "which of these matter".** A list of gaps or findings is not mutually
  exclusive, and forcing one pick invents a priority he did not set.

**Feedback comes back through the manager**, and lands in the next plan. That is the loop: the
report says what was decided and why, the owner says which reasoning to stop using, and the
manager carries it into the work. A "no" on a decision is more useful than a "no" on an
outcome, because it names the thinking rather than the result.

---

## The rules that are not negotiable

- **Only the manager interrupts the owner.** Once a day, with options and a recommendation.
- **Messages follow the chain.** Workers write to the supervisor, the supervisor to the manager,
  the manager to the architect and the owner. Only the manager messages the architect. A message
  sent out of order is recorded as a decision, with why it could not wait.
- **Every decision carries its reasoning.** The API refuses one without it.
- **Every session hands over, every shift.** Silence is reported by name, so a missed handover
  is visible rather than invisible.
- **Nothing is delegated against an unconfirmed plan.** Enforced, not merely expected.
- **No second tracker, no second backlog.** One board. A number has one owner.
- **A tracker that cannot be read is never rendered as "nothing open."** Absence and failure
  must look different, everywhere, always.
