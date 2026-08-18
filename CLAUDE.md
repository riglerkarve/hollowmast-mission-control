# Mission Control

A local, always-on Express + SQLite dashboard on **:3000**. Renamed from `business-dashboard`
on 17 Aug 2026. Focus, Reports, Money, the Second brain, the morning briefing, and the
Garage console folded in from :8688 — one local service where there were three.

**This is not a rewrite.** Decided 17 Aug 2026 (D3). The alternative was a clean-sheet
build, which would have cost 2–3 weeks and put the unbroken nightly backup chain at risk.
See the workspace `../CLAUDE.md` for how this fits the wider plan.

---

## The one thing to understand first

**There is no build step and almost no dependency.** One package — `express`. Persistence
is `node:sqlite`, which is built into Node 24, so there is no `better-sqlite3`, no native
module, and nothing to compile. The front end is plain ES modules loaded straight from
`public/`, no bundler.

Keep it that way. A build step here would mean the dashboard can break in a way that
needs fixing before you can see the thing that told you something was wrong.

```bash
npm start          # or let the MissionControl-Server scheduled task do it
```

Runs on `0.0.0.0`, so it is reachable from your phone on the LAN — which is how
notifications and quick capture are meant to work.

### The access key

Because of that bind, everything below `server/gate.js` is behind a shared secret:

- **Loopback is exempt.** `127.0.0.1` and `::1` pass straight through, so `npm start`,
  the browser on this machine, `scripts/watchdog.cjs` and every importer are unaffected.
  A local process could read `data/dashboard.db` directly anyway, so gating it buys nothing.
- **Anything arriving over the network must present the key.** `/api/*` answers `401`;
  a page request redirects to `/unlock`.
- **The key lives in `data/gate-key.txt`**, minted on first boot (72 bits, 12 characters)
  and printed in the startup banner. `MC_KEY` in the environment overrides it.
- **The phone unlocks once** at `http://<lan-ip>:3000/unlock` and stores an HttpOnly
  cookie for a year. The key goes in a form POST, never a query string, so it does not
  land in browser history or the access log.

**Why a cookie and not a header.** There is no shared fetch helper in `public/` —
`shared.js` is a chart renderer, and each of the thirteen panels defines its own local
`api()` wrapper. A cookie is attached by the browser to all of them, so the gate needed
**zero panel edits**. Anything scripted can send `X-MC-Key` instead.

This is a lock on the front door, not encryption: the traffic is still plain HTTP on the
LAN. It stops a device that joins the network from reading the ledger; it would not stop
someone who can watch the wire.

---

## The module contract

**This already exists in embryo — formalise it, do not invent a new one.**
`public/shell.js` holds a `PANELS` registry of dynamic imports, each module default-
exporting `{ mount(root), unmount() }`, and every route is already namespaced `/api/<name>`.
Every new capability follows that same shape:

```
server/routes/<module>.js      one router, mounted at /api/<module>, owns its tables
public/panels/<module>/        <module>.js exporting { mount, unmount } + <module>.css
                               registered in the PANELS map in shell.js
data/dashboard.db              ONE database. One schema. Migrated deliberately.
```

Three rules, and they are the whole architecture:

1. **A module never reads another module's tables.** It calls that module's API.
2. **Every figure has exactly one owner.** If two panels both compute a number from
   shared storage, they will disagree without either erroring. The second panel asks the
   first.
3. **A module must derive, decide, or tell you something.** A panel that only accepts
   input and shows it back is a chore with a nice font, and it fails the workspace gate.

`unmount()` is not optional. Panels that poll or hold timers must clean up, or switching
tabs leaks intervals that keep firing against a dead DOM.

The long form — the interface details that bite, the migration order, and the policy for
what the local model is and is not allowed to do — is in `ARCHITECTURE.md`.

---

## Schema

`server/db.js` creates the two original tables and the `schema_meta` table, then each
module migrates its own via `db.migrate('<module>', [ ...fns ])` — numbered,
append-only, one transaction each, version written in the same transaction as the change.

```
tasks | focus_sessions        the originals, CREATE TABLE IF NOT EXISTS
finance   finance_transactions · finance_rules · finance_accounts
budget    budget_lines · wishlist_items
todo      todo_items · todo_notes
income    income_streams · income_entries
lifestyle lifestyle_chores · lifestyle_done · lifestyle_intake
alerts    alert_kinds · alert_events
goals     goals · goal_steps
schedule  schedule_events
safety    safety_limits · safety_payees · safety_decisions
briefing  briefings
brain     brain_flags
wellbeing wellbeing_entries
health    health_metrics
```

Counted out of the running database on 17 Aug (`sqlite_master`), not off this list —
the previous version of this block named six modules when thirteen had migrated, which
is the direction that causes something to be built twice.

`goals` and `schedule` were built on 17 Aug and left unmounted — finished code that
`server/index.js` never required and `public/index.html` never linked. **Mounted 17 Aug**
after checking they were complete rather than abandoned: both carry seeded data (5 goals,
25 steps, 8 schedule events), both panels render with zero console errors, and neither had
been touched for over an hour. Schedule reports 2 overdue entries needing a decision;
Goals reports 5 active with 5 actionable today.

The lesson worth keeping: a module is not live because its table exists. Migrations run
when a route file is `require`d, so tables can be created by a module nothing serves —
which is exactly how these two came to be invisible while looking complete in the database.

**Never edit a migration that has shipped — add the next one.** Running older code against
a newer database throws rather than guessing. The ledger carries ten account-years of
imported statements; losing that to an unversioned change is the one unrecoverable failure
this project has.

**Money and measurements are INTEGERS.** `amount_pence`, `weight_grams`,
`sleep_minutes` — the unit is in the column name so a value cannot be misread, and no
total is ever a float.

## Safety — the guard, and why it starts refusing everything

`/api/safety` + `public/panels/safety/`. Backlog #11, and a prerequisite for #28: it had
to exist BEFORE anything that can spend, not alongside it.

`safety.check({ amountPence, payee, action, askedBy })` is the one place to ask. It is
exported the way finance's accessors are, so any future module calls it in-process.

**Three properties, and they are the design:**

1. **It fails closed.** Both ceilings default to `0` and the allowlist starts empty, so
   `check()` refuses everything until you set limits deliberately. Zero here is not a
   figure anyone invented — it is the absence of permission. `no_limits_set` is a
   distinct reason code from `over_transaction_ceiling` so "never configured" and "too
   expensive" can never be confused.
2. **There is no override.** `check()` takes no `force`, no `reason`, no admin flag.
   The refusal path cannot be argued with because there is no argument to pass. A ceiling
   is raised deliberately, in the panel, and that change is recorded as `set_by = 'user'`.
3. **Every call is recorded**, allowed or refused. A guard with no log cannot tell
   "nothing was refused" apart from "nothing ever asked" — the panel captions the empty
   case rather than showing a blank list.

`authorisedThisMonth()` is what THIS SYSTEM let through, never what you actually spent.
Finance owns real spending. Conflating them would let a grocery shop consume a purchase
ceiling.

**What it cannot do, stated because the backlog item's title promises more than code can
deliver.** "Nothing illegal, do not bankrupt the owner" are mechanical and are enforced.
"True analysis" is not mechanically enforceable — no function verifies that an analysis is
honest. The nearest real controls already exist: the briefing bars the local model from
emitting any figure, and every dashboard number comes from SQL.

**It is deliberately left unconfigured.** The ceilings and the allowlist are your
decisions; a governance module seeded with my invented limits would be the exact failure
it exists to prevent. Verified across 22 checks — fail-closed, both ceilings, allowlist
matching, monthly accumulation, four malformed-input cases and the absence of an override
— then reset, so the audit log starts empty for real decisions.

---

## The wishlist scope, and why there is no business headroom

`wishlist_items.scope` is `personal` or `business` (budget migration 2). The panel shows a
chip per item, a per-scope subtotal, and a re-tag button.

**Both scopes are judged against the SAME headroom, deliberately.** You are a sole trader,
so there is no second wallet — the money is one pot, and a per-purse headroom would assert
a separation the law does not grant. The split answers "how much of what I want is for the
business", which is a real question; it does not pretend the business can spend
independently.

The measurement behind that call, taken before the code was written:

| | Last 12 months of the ledger |
|---|---|
| Business account in | £1,034.91 |
| Business account out | £1,976.73 |
| Transactions | 42 |
| Last activity | 2026-03-25 |

The purse runs at a loss and has been dormant since March. A derived "business headroom"
would therefore be a constant zero — a figure that teaches you to ignore the panel rather
than telling you anything. `finance.accountKindSummary(kind, {months})` returns that
context and deliberately returns **no headroom**; the judgement stays with the caller.

**Existing rows were all defaulted to `personal`, not guessed.** Deciding which of the
seven were really business purchases would put an invented judgement into the one table
whose entire purpose is recording yours.

One thing found while building it, worth remembering: `.bg-split` was already the budget
panel's two-column page grid. A new rule of the same name appended to the end of
`budget.css` silently overrode `display: grid` with `display: flex` **and** took the
900px media query with it, because later rules win. The scope element is `.bg-scope-split`.
Grep the stylesheet for a class name before adding one.

---

## The Backlog module, and the one-writer rule

`/api/todo` + `public/panels/todo/` hold the 93-item backlog that used to live in
`claude todo.ods` on the Desktop. One store, two views: **Yours — decisions** (owner
`YOU`, 26 items) and **The build queue** (everything else, 67 items).

**The spreadsheet is now a DERIVED artefact. Regenerate it from `Export CSV`; never
edit it alongside the store.** This is not housekeeping — the drift is already on
record. The store was seeded from the .ods at 21:29 on 17 Aug, a new item was written
into the .ods at 21:54, and within half an hour the two disagreed with no error and no
way to tell which was right. That is the "two writers, no merge" failure the module was
built to end, and it reappeared inside thirty minutes.

`GET /api/todo/export.csv` takes an optional `?view=mine|build`. It emits a UTF-8 BOM
because Excel and LibreOffice both read a BOM-less UTF-8 CSV as the system codepage, and
it quotes per RFC 4180 — 59 of the 93 seeded rows carry a comma inside the rationale
field, so a naive `join(',')` would shift every column right of it on exactly the rows
worth reading.

New items added through the panel get `M`-prefixed ids (`M1`, `M2`, …). The seed owns
the bare numbers and the `O` prefix, so a manual item can never collide with a
spreadsheet row.

---

## Self-assessment preparation

`tools/tax-year-report.cjs` — five tax years off the business account, UK 6 April
boundary computed in SQL from the date rather than from a year column.

```bash
node tools/tax-year-report.cjs              # all years, with the caveats
node tools/tax-year-report.cjs 2023/2024    # one year
node tools/tax-year-report.cjs --csv        # machine-readable, for an accountant
```

Latest run is in `reports/tax/` as both text and CSV.

**`--csv` was in this tool's usage text from the start and had never been implemented** —
the flag was accepted, ignored, and the human report printed instead, so it looked like it
had worked. Now real. It reads the same `years()` and `rows()` the printed report uses;
a second query would be a second owner for every figure. It emits one row per direction,
with per-direction counts: the first version repeated the category total on both the in and
out rows and stated the same 56 transactions twice.

Cross-checked against an independent SQL query: turnover **£62,400.81 over 252 payments**,
agreeing to the penny and the row.

**What it deliberately will not produce is an expenses total.** Turnover is knowable from
the bank; allowable expenses largely are not, because the business account was used
personally throughout and a large share of what left it was cash. The report buckets every
category by how much can be said about it — `TURNOVER`, `MAYBE BUSINESS`, `UNKNOWN`,
`UNEVIDENCED`, `LOOKS PERSONAL`, `NOT AN EXPENSE` — so a guess cannot be quietly upgraded
into a deduction. £21,647.41 of cash is the single largest item and no software will ever
attribute it.

It also answers backlog #34 (limited company) against your own stated criterion, "urgency
scales with income": turnover fell from £24,281.29 to £1,034.91 across five years and the
account has taken in nothing for 197 days, so by that rule the urgency is nil — and
incorporating a non-trading company adds annual filings that start immediately. Worth a
trigger (turnover returning) rather than a date.

None of this is tax advice, and the tool says so in both formats — including in the CSV's
own last row, because a tidy grid implies a confidence the data does not support.

---

## The services audit, and the classifier I nearly built twice

`GET /api/finance/recurring`, surfaced in the Money panel. Backlog #39 — derived from the
ledger, never typed.

**The first version was useless in an instructive way.** It grouped every counterparty by
recurrence, and returned Tesco (175 charges) as "stopped charging", Co-op as "every ~2
days", KFC as "every ~329 days", and several friends as services. Shopping recurs, so
shops dominate any list built on recurrence alone.

The tempting rescue was a second signal — subscriptions charge a consistent amount.
Measured, it does not separate: Spotify scores 0.00 and Netflix 0.14 on
median-absolute-deviation over the median, but **Google Play scores 0.60** (it is many app
purchases, not one subscription) and lands among the supermarkets, while repeated
round-number transfers to a person score 0.34 and land among the services. Any cut-off
would have been a number I chose.

**The categoriser already answers this question**, with 108 auditable rules over 95.3% of
the ledger. Building a second classifier would have been a second owner for "what kind of
thing is this". So the category is the gate — `Subscriptions` and `Phone & internet` — and
recurrence is only the fact reported inside it. 170 noisy rows became 21 real services.

Three things it refuses to fake:

- **It does not claim a billing cycle.** Netflix's gaps run 28…927 days, median 41, which
  is the average of a subscription that lapsed twice. The spread is returned beside the
  median and the panel prints it as *"irregular: 28–927d, so that is an average, not a
  cycle"*. A median is shown and then undermined rather than left looking authoritative.
- **It measures staleness from the ledger's end, not today.** The ledger is an import;
  counting from today would add the import lag to every row and make live services look
  abandoned.
- **It reports its residue.** A counterparty with fewer than 3 charges has no gap to
  measure, but dropping it silently hid the single most recent service charge in the whole
  ledger — **Anthropic, £18.00, one charge, 9 days before the ledger ends**. A subscription
  that started last month is indistinguishable from one that never recurred, so it is shown
  in its own bucket instead of filtered into nothing.

`unclear` is a real status and is folded into neither: five counterparties have a median
gap of 0 because most charges land the same day as the one before, so no answer would be
honest.

**It is an inventory, not a verdict.** Nothing in the route or the panel comments on what
any service is for, and there is no styling for "expensive".

---

## The daily triggers

`scripts/triggers.cjs` — the things worth interrupting you for. Run it bare to see what
would fire without sending anything:

```bash
node scripts/triggers.cjs
```

It is called from `briefing.cjs`'s `--notify` block, so there is **one notification pass a
day and no new scheduled task**. Five live services already depend on Task Scheduler; each
task added is another thing that can silently stop.

Three checks, each firing on a sign change or a date passing — never on a threshold anyone
invented:

| Kind | Fires when |
|---|---|
| `schedule_overdue` | a scheduled day passed with no decision recorded |
| `budget_headroom` | headroom goes **negative** — a sign change, not a limit |
| `ledger_stale` | the ledger is more than 40 days old, the same boundary the briefing already switches wording at |

Each check returns one of **three** states — `fires`, `clear`, or `error` — because
"looked and it was fine" and "could not look" must never render the same. That paid for
itself immediately: `budget.breaches()` threw on its first run (an omitted month reaching
SQLite as `undefined`) and surfaced as `error` instead of passing silently as `clear`.

### Self-care lives in wellbeing, not beside the bins

The original todo read "chores, laundry, bins, **shower**". Shower is the one item on that
list that is not housework, and the owner's call on 18 Aug was to reframe it rather than
add it as a chore.

Putting it in the chore module would have given it an interval, a due date, an "overdue by
3 days" and a phone notification — a machine telling you to wash. So it is
`wellbeing_entries.self_care` (wellbeing migration 2), and every property is deliberate:

- **Free text, not a checklist.** A preset list of self-care items is a list you can fail,
  and on a bad day it reads as an accusation.
- **No interval, no due date, no overdue state.** Nothing schedules it, so nothing can
  report it as late.
- **Excluded from triggers and the briefing.** Verified: zero mentions of `self_care` in
  either file. It is never pushed at you.
- **Recalled by date only.** `/patterns` was left untouched on purpose — "3 of 7 days"
  here would be a judgement wearing a number.
- An entry may be self-care ALONE, with no mood and no note. Refusing that would make the
  field feel like an afterthought to the "real" entry.

The support card is unaffected and still renders unconditionally.

### Anchored chores: when the schedule is not yours to move

Most chores are *due = last done + interval*. The clock starts when you last did it, which
is right for laundry.

**It is wrong for anything the outside world schedules**, and wrong in a way that degrades
silently. Bins are collected on alternating Thursday mornings. Put them out on Friday
because you missed Thursday, and an interval model books the next one 14 days from Friday
— so it drifts off the real collection and stays wrong, permanently, with no error.

So `lifestyle_chores` gained `anchor_date` and `lead_days` (migration 2). An anchored
chore derives its next date from the CALENDAR — a known real occurrence plus whole
multiples of the interval — and **recording it does not move the schedule**.

Verified: with recycling anchored to Thu 2026-08-20 and "did it" recorded on Saturday
2026-08-15, the next collection stayed **2026-08-20**. The interval model would have said
2026-08-29, nine days wrong.

`lead_days` exists because the useful moment is the night before, not the morning of. Both
bin chores carry lead 1, so they tip to due on the Wednesday for a Thursday round — which
is exactly when the `chores_due` notification fires.

Two consequences worth knowing:

- **An anchored chore has no `never done` state.** A collection happens whether or not you
  ever recorded putting the bins out, so "no history" is absence of a RECORD, not absence
  of a schedule. Both bins correctly left the briefing's never-recorded list.
- `dueInDays` still counts to the ACTION rather than the event, so the briefing, the
  trigger and the sort never need to know which kind of chore they are looking at.

Current setting, from the owner on 18 Aug: fortnightly Thursdays, recycling 2026-08-20,
general waste 2026-08-27, alternating.

### Chores: why one thing is both a notification and a briefing line

Backlog #52. The module already derived the schedule; what was missing was that a chore
could come due and **nothing told you** — the briefing reported chores *recorded* as work
achieved, never chores *due*, so it only worked if you remembered to open the panel.

`lifestyle.dueSummary()` publishes both halves and the split is the whole design:

| | Fires on | Carried by | Why |
|---|---|---|---|
| `tippedToday` | `dueInDays === 0` | the `chores_due` notification | an EVENT — a chore is 0 days due exactly once per cycle, so it cannot repeat and needs no "last notified" state |
| `due` | `dueInDays <= 0` | the briefing's "Due today" section | a STANDING STATE — everything owed, including what was missed while the laptop was asleep |

Notifying on the standing state would fire every morning until you did it, which is how an
alert teaches you to ignore the channel. Notifying only on the tip means a chore three
days late is silent on the phone and visible in the briefing — verified: with Laundry at 0
days and Bins at −3, only Laundry fired.

`neverDone` is carried separately by both and folded into neither. A chore with no history
has no date to count an interval from, so calling it "due" or "not due" would be inventing
one. This is why the briefing says "Nothing due" **and then** names the chores that have
never been recorded — "nothing due" on its own would imply you are on top of things.

**Deliberately NOT a trigger: per-category budget breaches.** Two are over right now, and
one is "Other" at £75.50 against a £3.00 budget — a category whose median is near zero
turns a trivial sum into an enormous percentage. Any absolute threshold that fixed it
would be a number I chose. Those go in the briefing, which you read; they are not pushed
at you. **Also not a trigger: "26 items are blocked on you"** — true every day, so it is a
standing condition, not an event. It already leads the Backlog panel.

Each trigger has its own alert kind, so muting the briefing does not mute an overdue
appointment. The two-ignores auto-mute in `notify.cjs` is per kind, which is the point of
having kinds at all.

---

## Version control — and why .gitignore is a security control here

`git init` on 18 Aug 2026. Two commits, no remote. Until then everything in this
directory existed in exactly one copy: the nightly backup covers `data/dashboard.db`,
not a single line of code.

**`.gitignore` is not housekeeping in this repo.** Excluded, and each for a reason:

| Excluded | Why |
|---|---|
| `data/*.db`, `-wal`, `-shm` | ten account-years, 6,839 real bank transactions, plus health and wellbeing data |
| `data/gate-key.txt` | the LAN access secret — committing it publishes the gate |
| `backups/` | 41 MB of copies of the same database |
| `reports/` | the daily briefing and the tax reports quote real spending figures; both regenerate on demand |
| `logs/`, `*.log` | can echo query strings and data values |
| `node_modules/` | one dependency, no native builds |

**Verified by VALUE, not by filename.** The live gate key was searched for as a string
across all 70 staged files before the first commit, along with bank counterparties and
sort-code patterns. The only hits were the categorisation rules table in
`tools/seed-rules.cjs` — generic UK retailer names used as matching patterns, which is
the feature itself — and `86400000`, milliseconds per day. Checking that
`data/dashboard.db` is listed in `.gitignore` proves the rule exists; searching for the
key's actual characters proves no copy leaked somewhere else.

**There is no remote, deliberately.** Private-to-public stays available; history does not
in practice, so the exclusions are set before anything could be pushed. If a remote is
ever added, re-run the by-value scan first.

`.gitattributes` pins line endings. Without it autocrlf converts on checkout and the next
session opens to 70 files marked modified without having touched one, which buries a real
change. `.ps1` is pinned CRLF (and separately must stay pure ASCII — PowerShell 5.1 reads
a BOM-less file as ANSI); `.sh` is pinned LF, because CRLF breaks a shebang.

**Still unversioned elsewhere in the workspace:** `thin-air`, `emberfall`, `Fallow`,
`SecondBrain`. `Survive`, `income-portfolio` and `Mini Games` are repos.

---

## Backups — do not break these

`scripts/backup.js` runs nightly at **23:55 local** via the **MissionControl-Backup**
scheduled task, keeps 14 days, and uses `VACUUM INTO` rather than copying files — which is the
correct choice, because a plain copy of a WAL database is not guaranteed consistent.

The chain has been unbroken since 1 Aug 2026. **Any change to the data directory, the
scheduled task, or the service path must keep it running**, and must be verified by
checking that a new backup actually appears — not by reading the task's exit code.

## Uptime — built 17 Aug 2026, do not remove it

`GET /api/status` runs a real SQLite query and answers **503 `ok:false`** when it cannot.
(It was `/api/health` until the health module needed that name — see ARCHITECTURE.md §11.)
`server/heartbeat.js` writes `data/heartbeat.json` every 30 s. `scripts/watchdog.cjs` runs
every 5 minutes from the **MissionControl-Watchdog** task, in its own process, and
restarts and alerts. Detail in `ARCHITECTURE.md`.

It exists because the server was found dead for four hours with a log whose last line
still read "Dashboard running". **Absence and failure must not look the same** — that is
the whole point, and it applies to every panel you add, not just the process.

Two machine facts this depends on, both verified the hard way:

- **`schtasks /end` does not stop the server.** It prints SUCCESS, sets the task Ready,
  and leaves node holding the port. `start-server.ps1` frees the port itself; keep it
  idempotent or restarts silently stop working.
- **Every `.ps1` here must be pure ASCII.** PowerShell 5.1 reads them as ANSI without a
  BOM, so a UTF-8 dash in a quoted string breaks the parse and the task exits 1 having
  logged nothing. `grep -rnP '[-ÿ]' scripts/*.ps1`

---

## The rename and the fold-in — both done, 17 Aug 2026

The folder is `mission-control`; the tasks are `MissionControl-Server`, `-Backup`,
`-Watchdog` and `-Briefing`. Nothing in the code needed changing: every path is
`__dirname`-relative, which was established by search *before* the move.

`.garage` is served at `/garage` as an **allowlist**, not a static mount — six named
files and two asset directories. `GarageServer` is *Disabled*, not deleted;
`Enable-ScheduledTask -TaskName GarageServer` restores it. `GarageTelemetryHourly` must
keep running: it writes the ledger the console displays.

**Why an allowlist and not a static route:** this server binds `0.0.0.0`. Mounting the
workspace root would have published `data/dashboard.db` and its backups — ten account-years
of bank transactions — to the LAN, unauthenticated. The old server was safe doing exactly
that only because it bound `127.0.0.1`.

---

## Never do these

- **Never add a build step**, a bundler, or a framework.
- **Never add a native dependency.** `node:sqlite` is built in; keep the dependency count
  at one.
- **Never let a second database appear.** One file, one schema.
- **Never write a panel that only stores what you typed.** See rule 3.
- **Never show a forecast from thin data.** A prediction off three points costs trust in
  every other number on the page. Wait for 6–8 weeks of history.
- **Never break the backup chain to ship a feature.**
- **Never reuse a route filename.** `reports` collided with the focus-stats panel and was
  renamed to `briefing`; `health` was worse — the health module was written straight over
  the uptime endpoint and took the server down. Grep `server/routes/` first.
- **Never let the local model near the wellbeing module**, and never let anything there
  read as diagnosis, advice, or a risk score. Counts and recall only. The support card is
  fixed, always rendered, and never conditional on the data.
- **Never let an empty state and a failed fetch render the same.** A broken parser then
  reads as good news and nobody investigates it.

## How to work here

- Read `../CLAUDE.md` first — it holds the settled decisions and the sequencing, then
  `ARCHITECTURE.md` here for the module contract in full.
- Modules land one at a time, each ending in something you would actually open.
- New route → new panel → register in `shell.js`. If a change touches all three plus the
  schema, it is a migration and wants a test.
- The server binds `0.0.0.0` deliberately. Anything added must stay safe on a home LAN:
  no secrets in responses, no destructive endpoint without confirmation. It is not
  authenticated and should not be exposed beyond the LAN.
