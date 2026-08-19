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

## The rules that are not negotiable

- **Only the manager interrupts the owner.** Once a day, with options and a recommendation.
- **Every session hands over, every shift.** Silence is reported by name, so a missed handover
  is visible rather than invisible.
- **Nothing is delegated against an unconfirmed plan.** Enforced, not merely expected.
- **No second tracker, no second backlog.** One board. A number has one owner.
- **A tracker that cannot be read is never rendered as "nothing open."** Absence and failure
  must look different, everywhere, always.
