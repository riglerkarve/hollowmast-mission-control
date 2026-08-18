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

### The access key, and per-device tokens

Because of that bind, everything below `server/gate.js` is gated. **The key ENROLS; a
per-device token AUTHENTICATES** — rebuilt 18 Aug 2026 (#M3).

- **Loopback is exempt.** `127.0.0.1` and `::1` pass straight through, so `npm start`,
  the browser on this machine, `scripts/watchdog.cjs` and every importer are unaffected.
  A local process could read `data/dashboard.db` directly anyway, so gating it buys nothing
  — and gating it would take the backup, the watchdog and every importer down with it.
- **Anything arriving over the network must present a device token.** `/api/*` answers
  `401`; a page request redirects to `/unlock`.
- **The key lives in `data/gate-key.txt`**, minted on first boot (72 bits, 12 characters)
  and printed in the startup banner. `MC_KEY` overrides it. It is now only used to *enrol*.
- **`POST /unlock` with the key mints a random 256-bit token for that device** and returns
  it in an HttpOnly cookie. The key goes in a form POST, never a query string.

**What the previous single-secret design got wrong**, and each of these was real rather
than theoretical:

| Weakness | Now |
|---|---|
| Every device presented the same string, so revoking one meant re-keying all | Each device is a row, revocable **on its own** |
| A one-year cookie nothing server-side knew about | 30-day **sliding idle** expiry (`MC_DEVICE_DAYS`); a device in daily use never expires, one in a drawer does |
| `/unlock` accepted guesses as fast as the network allowed | 5 failures then a doubling lockout, capped at 6h, cleared by a correct key |
| The cookie *was* the credential, stored in plain form | Only **`sha256(token)`** is stored — the database file does not contain a usable credential, which matters because that file is the thing being protected |

**Fails closed.** `deviceFor()` never throws: a database problem returns null and the
caller denies. Since loopback is exempt, failing closed cannot take the ops chain down.

**The device API gates itself inline** — `app.get('/api/gate/devices', gate, …)`. `index.js`
calls `gate.mount(app)` *before* `app.use(gate.gate)`, so anything registered there is
otherwise unauthenticated. Correct for `/unlock`; for a revoke button it would have been a
hole that hands an attacker the controls. Explicit so reordering `index.js` cannot open it.

**`X-MC-Key` still works as break-glass**, deliberately kept: locking yourself out of a
machine that is not the server has no other remedy. It is the shared secret with all its
weaknesses — not revocable per device — so it is given no session and no device row.

**Managed in the Safety panel** ("Devices that can reach this over the network"), because a
revoke button nobody can find is a revocation that never happens. Revoked and expired rows
stay visible, dimmed — "this device used to have access" is a fact worth reading.

**Verified by 31 tests against the real LAN address**, not loopback: testing this on
`127.0.0.1` exercises the exempt path and proves nothing. Covered fail-closed, lockout
(including that a *correct* key is still refused while locked), token ≠ key, hash-only
storage, per-device revocation not affecting siblings, enforced expiry, and loopback
staying open throughout.

**This is a lock on the front door, not encryption.** The traffic is still plain HTTP on
the LAN — anyone who can watch the wire sees the token in flight, exactly as they
previously saw the key. Per-device tokens make access revocable and expiring; they encrypt
nothing. Real TLS is a separate, larger question (a self-signed cert means trusting a root
on the phone). The panel says so at full size rather than in fine print.

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
atlas     atlas_countries
browsing  browsing_domains
briefing  briefings
brain     brain_flags
wellbeing wellbeing_entries · wellbeing_quiet
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

## The purchase proposition, and the guard's first caller

`GET /api/budget/wishlist/:id/proposition`, behind "Before you decide" on each proposed
item. Backlog #28 — it prepares, and there is no code path in it that could buy anything.

**The figure it exists for is `displaces`.** Per-item affordability is already there, and
it is the thing that misleads: six items each affordable on their own is exactly how a
wishlist commits double what exists. So the proposition answers what approving THIS one
stops you affording. Measured live: the £89.99 printer/scanner fits inside £191.52 of
headroom, and approving it displaces the £149.00 computer chair.

**It does not call `safety.check()`, deliberately.** The guard records every call, so
consulting it to draw a screen would fill the audit log with refusals generated by
*looking* — and the log's whole value is that it records real decisions. Viewing a
proposition is not asking permission, so it reads `safety.limits()` and compares. Verified:
opening propositions for three items, and again through the panel, left the log at exactly
the two boundary probes that were already there.

**The guard's verdict is shown as information, never as a block.** `withinAutomatable`
answers "could this system ever authorise this by itself" — with the ceilings at £20, the
answer is no for every wishlist item. The panel says so in those words: *"That is not a
limit on what you may buy — it is a limit on what anything here may do without you."* A
guard that appeared to forbid the owner their own purchases would be resented and then
disabled, and it would deserve to be.

**Cost of waiting is months of headroom and nothing else.** No ledger figure prices a
delay, so it does not manufacture urgency it cannot support.

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

## Who has read the ledger — the access log, and why it is instrumented in `db.js`

`GET /api/finance/access-log`, shown as "Who has read this ledger" in the Money panel.
Backlog #14. Your decision on 17 Aug was that personal finance data is **allowed** to a
frontier model, kept under review. This is the "under review" half — the item's own words
were that it means nothing without a log, or it is only a good intention.

**Instrumented in `server/db.js`, not on the routes, and that choice is the whole point.**
A route-level log would have looked immaculate and been mostly wrong. On 18 Aug I read this
ledger three ways in one session:

| How | Would a route log see it? |
|---|---|
| `GET /api/finance/*` | yes |
| `require('../server/db')` in `tools/tax-year-report.cjs` | **no** |
| a bare `node -e` script | **no** |

Everything in this repo that touches the database goes through `db.js`, so that is the
chokepoint that sees the server and every tool alike. Proven, not assumed: running the tax
tool as a separate process moved `claude` from 6 reads to 17.

**It is a floor, never a total, and the panel says so at full size.** Verified by doing the
thing it claims not to see — a direct `new DatabaseSync` read of all 6,839 rows left the
counter at 17, unchanged. A governance log that quietly under-reports is worse than none,
because it manufactures confidence. So the caveat gets the same visual weight as the
numbers, at 11.04:1 measured.

**Two design details worth keeping.** Aggregated to one row per (day, table, actor, op),
because a row per query would be a write for every read. And recorded at `prepare()` rather
than execution, which slightly **over**-counts — the safe direction for an egress log.

**It exposed a real gap in provenance.** `X-MC-By` was built to answer "who wrote this row",
so panels send it on POST/PATCH only. Measured: **13 panels define their own `api()`
wrapper and not one sent it on a GET.** Every time you opened the Money panel it was logged
as `unknown` — precisely the actor the log exists to isolate. Fixed in the finance panel
only; the other twelve still under-attribute their reads, which is harmless while
`SENSITIVE_PREFIXES` is just `finance_` and becomes a bug the moment it is not.

`unknown` is a real value and is never assumed to be you — same rule as the rest of
provenance.

## The second brain — and the half you write

`/api/brain` + `public/panels/brain/`. Backlog #M2, 18 Aug 2026: *"make sure the second
brain is storing more than just memories."*

**Measured before building, and I was wrong twice.** I guessed the `type` vocabulary was
unused — it is not (feedback 92, project 21, reference 19, all 132 files typed). I then
guessed the panel did not render types — it already had type tabs, filtering and counts.
The actual gap was narrower and worse: **the only write path in the whole module was
`POST /:name/flag`.** Every entry was a lesson *I* wrote after getting something wrong, and
the 19 tagged `reference` are facts about tooling, not resources. `user` had zero entries
because there had never been a way to create one.

**Owner entries live in SQLite, not as `.md` files, and that follows the rule already at
the top of `brain.js` rather than overriding it:** the store is hand-maintained across
sessions with no merge, and a second writer is how it rots. So `brain_notes` is Mission
Control's, and it reaches Claude through **one generated file this module owns** —
`_notes.md`, rebuilt in full on every change, deleted when the last entry goes. Exactly the
contract `_flags.md` already had.

**Backlinks are the derivation that makes it more than a text box.** Outbound links were
always shown; nothing computed the reverse. Now a `[[name]]` written in your note appears
*on that memory* as "Linked from — your note", so writing one changes what the store shows
you, not just what it stores.

**Three bugs caught while building it, all of the silent kind:**

- **`GET /:name` was registered above `/notes`.** Express matches in order, so
  `/api/brain/notes` resolved as a memory named "notes" and 404'd. The catch-all now sits
  at the **bottom of the file** with a comment saying why; anything specific added later
  must go above it.
- **`_notes.md` appeared as a 133rd memory**, type `unknown` — the file filter excluded
  `_flags.md` *by name*. Now excluded by `_` prefix, so the next generated file cannot
  repeat it. Verified: API reports 132, disk reports 132, types sum to 132.
- **`.brain-dim` was used in three places and never defined.** An invented class renders as
  nothing and raises no error. Every static class in the panel is now audited against the
  sheet.

**`MEMORY.md` now points at both generated files.** It is the file that loads at session
start, so a generated file nobody points at is a file nobody reads — `_flags.md` had that
gap too, silently, since it was built.

**Left empty.** Your entries start with yours, same rule as the atlas and the wishlist
scopes. One thing worth knowing about encoding, since it looked like a bug and was not:
`£`, `—`, `’`, `é` and `→` all survive HTTP → SQLite → disk intact. The corruption I first
saw came from `curl -d` in the shell, not from the app.

## The Backlog module, and the one-writer rule

`/api/todo` + `public/panels/todo/` hold the backlog that used to live in `claude todo.ods`
on the Desktop. One store, two views: **Yours — decisions** (owner `YOU`) and **The
build queue** (everything else).

**It has no nav entry. It lives inside Focus** — owner instruction, 18 Aug 2026: *"move
the entire backlog to the focus app"*, following *"tasks on the focus app should show the
todo lists, this is its more native home"*.

**The panel is NOT reimplemented there.** `todo.js` already exported the `{ mount,
unmount }` contract, so `focus.js` mounts the real panel into `#focusBacklog` with
`{ embedded: true }` — which drops its outer `.panel` wrapper and demotes its `h1`. One
implementation, one owner. Copying the list rendering into Focus would have been the
two-stores failure this module was built to end, one level up.

Focus keeps exactly one fact of its own: which item the timer records against. The
**Focus** button on each item **writes nothing** — it dispatches a bubbling `td:focus`
event and the host decides, so `todo.js` still knows nothing about a timer and still works
standalone if it is ever put back in the nav. Every mutation also emits `td:changed`, so a
timer pointed at an item closed elsewhere in the list stops pointing at it.

**Both panels use `.mode-tab`** — the timer’s work/short/long and the backlog’s
mine/build. Focus captures its three with `querySelectorAll` **before** the backlog mounts,
and the backlog scopes its own to its root. Verified both directions in the browser, and
verified leak-free: three away-and-back cycles leave exactly one `.td-panel`, one `h1` and
one click handler. `focus.unmount()` must keep calling `backlogPanel.unmount()` — without
it the embedded panel’s in-flight fetch resolves into a dead DOM.

`todo` was removed from the `PANELS` registry, so an old `#todo` deep link falls back to
Focus, which is where the backlog now is. `todo.css` is still loaded from `index.html` —
the embedded panel needs it.

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

## The offload router — the policy as code, and the audit that checks it

```bash
node tools/offload-router.cjs            # audit the call sites, then the decision table
node tools/offload-router.cjs --policy   # just the table
```

Backlog #21 and #13, which are one item. `route(task)` encodes the ARCHITECTURE.md offload
policy so a new feature has something to ask rather than a paragraph to remember, and the
audit half scans for model call sites and checks them against it.

**The order is rules → local → frontier, and the first question is never "which model" but
"is a model needed at all".** That is the measured finding, not a preference: on the real
categorisation job the rules table did 95.3% and the model 4.7%, and naming the business in
the prompt broke four answers that were already right.

**It found a contradiction in the written policy.** ARCHITECTURE.md says offload when a task
is "high-volume, low-stakes, reviewable, and structurally constrained" — then lists
"summarising a day's data into briefing prose" as a local task. One sentence a day is not
high-volume, so read as a conjunction the rule refuses its own example. Resolved the way the
evidence points: **the local model is free, so volume argues against FRONTIER, never against
local.** The binding three are low-stakes, reviewable, structurally constrained; volume is
recorded and not required.

Validated against reality rather than against itself — the routed tier matches what the code
actually does in **5 of 5** cases, including the one that matters: the router refuses
wellbeing, and `server/routes/wellbeing.js` contains no model call at all.

**The audit reports what it cannot see, and that list is longer than what it can.** It
checks three mechanical things in source text: a schema or enum, temperature 0, and no bare
`format:'json'`. It cannot see whether a task is low-stakes, whether output is auto-applied,
whether a number came from the model, or whether there is a path when Ollama is down. A
green audit that silently checked three of seven things would be worse than none.

Two differences currently reported, both real and neither automatically a bug:

- `scripts/briefing.cjs` uses `temperature: 0.2` where the policy says 0 throughout. No
  comment records why. For one sentence of prose a little variation may be wanted — but it
  is an undocumented divergence, which is the thing worth surfacing.
- `tools/llm-probe.cjs` contains `format:'json'` because it MEASURED the difference. The
  check cannot tell a file that uses a string from one that mentions it, and says so.

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

**Making Tax Digital, added 18 Aug.** Unlike incorporation, this is a dated obligation
rather than a judgement call, and the date that decides it is already running: mandation
from **April 2028 at £20,000 is tested on the 2026/2027 tax year**, which started 6 April
2026. (April 2026 tested 2024/25 at £50,000; April 2027 tests 2025/26 at £30,000.)

The business account shows **£0.00 in over 127 of the 365 days** of that year. The check
reports this as a **floor rather than a total** — the year has 238 days left and the figure
can only rise — because for a threshold test a lower bound is the useful shape.

**And it states what it cannot see, which is the half that could make it wrong.** Qualifying
income is gross self-employment *and* property income across every source; this reads one
account. Other accounts took **£21,597.85 over 163 payments** categorised `Income - people`
in the ledger's last twelve months — a direction label that says nothing about whether any
of it was payment for work. So the honest reading is "the business account shows nothing
this tax year", never "you are below the threshold". That figure is **computed, not typed**:
the first draft had £22,628 written into the prose and it was already wrong by £1,030.

None of this is tax advice, and the tool says so in both formats — including in the CSV's
own last row, because a tidy grid implies a confidence the data does not support. The MTD
and incorporation sections print only on the all-years run and are absent from `--csv`;
verified, and the CSV is byte-identical to the previous day's, so a section was added to
the human report without moving a single figure.

---

## Atlas — a grid that admits it is a grid

`/api/atlas` + `public/panels/atlas/`. Backlog #65.

**Self-contained, and that is why it works.** Nothing in the ledger could drive it — 21
Travel transactions across five years is not a travel history — so it is a ONE-OFF capture.
That is the distinction the gate cares about: a surface you must keep feeding is rejected;
a list you tick a handful of times a decade and then read forever is not.

**It is a grid, and it says so on its own face.** A geographic projection needs real country
path data. Authoring outlines from memory would be fabricating geography that *looks*
authoritative — the most expensive kind of wrong, because nobody checks a map's coastlines.
So it draws a labelled cell per country, grouped into six regions, and the panel states
plainly that it does not pretend to know where anywhere is. If a real SVG world map ever
arrives from a source, the cells can be swapped for paths without touching the data.

**The percentage is BY COUNT, deliberately.** An area-weighted figure needs 193 land-area
values, and quoting those from memory is exactly the plausible-number trap this project has
been bitten by repeatedly. Count is arithmetic on a list you can see. If area figures ever
arrive from a real source they become a SECOND percentage, clearly labelled — never blended
into this one.

Seeded with the 193 UN member states (Africa 54, Asia 46, Europe 44, North America 23,
Oceania 14, South America 12 — verified to total 193). The seed is a starting point, not the
vocabulary: `POST /countries` adds anything missing, and the denominator moves with it.

**Left empty.** The UK is the obvious first click and I did not make it — the same rule as
the wishlist scopes and the chore history: your record does not start with my assumptions.

---

## Browsing — domains only, and why that is the whole design

`/api/browsing` + `tools/import-browsing.cjs`. Backlog #12.

**No URLs and no page titles are read into the database — ever, by either file.** This is
not squeamishness. `dashboard.db` is served on `0.0.0.0` behind one shared secret and
already holds ten account-years of bank transactions; a full URL history would mean a
single leaked key exposes every page you have read, which is a materially different loss
from a spending total. Domain-level aggregates answer what the item asks and cost far less
if they escape. The domain is extracted **in SQL**, so no URL reaches the importer process.

Current import: 811 domains, 14,172 visits, 2026-06-30 to 2026-08-18. Edge only; Chrome and
Firefox are not installed and are reported as absent rather than as zero.

**What it derives**, because an import that only stores fails the gate: where attention
concentrates, and **paid for but not visited** — services the ledger charges for that never
appear in browsing. That is the one question neither module can answer alone, so browsing
asks finance rather than duplicating its figures. Eight came back, all already
`stopped charging` — so the honest reading is historical, not live waste.

The match is crude and says so on its own face: comparing a merchant name to a domain is a
guess about a string, so the list is captioned as candidates to check, never as proof a
service went unused.

**Two machine facts this depends on, both found the hard way:**

- **The History file is locked while Edge runs**, and Edge runs as ~14 processes. It is
  copied first and the copy read read-only — which is why this works without asking you to
  close the browser. The copy is deleted in a `finally`, so it goes even if the read throws.
- **Timestamps are Windows FILETIME**, microseconds since 1601-01-01. A raw value is about
  1.34e16, larger than `Number.MAX_SAFE_INTEGER`, and `node:sqlite` throws
  `ERR_OUT_OF_RANGE` rather than rounding silently. The conversion to unix seconds is done
  **in SQL**, so the oversized number never reaches JavaScript.

It does not judge what is on the list. No "wasted time" figure, now or later — that would be
a weighting I invented, presented back as a measurement.

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

### Quiet hours: a curtain, never a lock

Backlog #29, "enforce time away". Its own rationale was the specification: *a limit you set
in advance and can always override — not a lock you cannot open, because a wellbeing feature
that traps you is the failure mode, not the feature.*

`wellbeing_quiet` (migration 3) holds one row. **Off by default** — a boundary nobody asked
for is an imposition.

Every property is a refusal as much as a feature:

- **It gates the UI only.** `/api/*` is never blocked, because the watchdog, the briefing
  and the nightly backup run through it. A wellbeing setting must not be able to take the
  ops chain down at 23:00. Verified: with the curtain active, `/api/status`, `/api/todo`
  and `/api/briefing/latest` all still answered 200.
- **The override is one click, full size, always visible, never delayed.** A dismissal that
  is hard to find is a lock wearing a friendly label.
- **Nothing is recorded about it.** No override count, no adherence, no streak. There is a
  settings row and no event log, deliberately: the moment a "you ignored quiet hours four
  times this week" figure exists, the feature has become a judgement about the user.
- **If the check itself fails, the curtain does not close.** A broken fetch must never lock
  you out of your own dashboard.
- The override lasts for one page view — not persisted, so it cannot silently stay off
  forever; not re-prompted, so it does not nag once answered.

Two bugs caught before shipping. The overnight window (23:00–07:00) crosses midnight, so the
test is an OR, not an AND — inverted, quiet hours would have been the only time the
dashboard worked; nine cases now cover both window shapes and the disabled case. And
`String(message)` turned an explicit JSON `null` into the string `"null"`, which is truthy,
so the curtain would have displayed the word "null" as its message: clearing a value and
omitting one are different requests.

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
standing condition, not an event. It already leads the backlog list inside Focus.

Each trigger has its own alert kind, so muting the briefing does not mute an overdue
appointment. The two-ignores auto-mute in `notify.cjs` is per kind, which is the point of
having kinds at all.

---

## Archiving — two runs, because one looks careful and is not

```bash
node tools/archive.cjs                        # suggest version groups, touch nothing
node tools/archive.cjs --stage <file> ...      # copy + verify. Originals stay put.
node tools/archive.cjs --sweep [--apply]       # remove originals that STILL verify
```

Backlog #8, built to the rule its own rationale set: **never move a file in the same run
that reads it. Copy, verify the copy, then remove.**

**The two runs are the safety property, not ceremony.** A copy-then-delete inside one
process looks careful and is not: if the write is buffered, the disk fills, the path is
wrong, or the process dies between the calls, the delete still happens and the only copy is
the one that failed. Staging and sweeping as separate invocations means the original
outlives any single failure, and the sweep can demand evidence written by an earlier,
completed run.

**The evidence is SHA-256 of both files, re-checked at sweep time** — not size, not mtime.
Matching sizes are not matching bytes ([[never-retype-bytes]] is the same wound).

Three outcomes, all proven on a throwaway set before the tool was trusted:

| | |
|---|---|
| staged, still identical | **REMOVED**, verified copy in `_archive` |
| original **changed** after staging | **BLOCKED** — the archive holds a different file now, and removing would lose the edit |
| archive copy **missing** at sweep | **BLOCKED** — removing would lose the file outright |

It also refuses to overwrite a *different* file that happens to share a name.

**It suggests and does not decide.** Filename grouping finds version families — it correctly
spotted the four `claude todo` spreadsheets — but which one is superseded is a judgement
about content, so the tool prints them and waits for explicit paths. **Nothing of the
owner's was staged or moved.**

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

### The watchdog was blind to restarts — fixed 18 Aug 2026

Found while researching backlog #26, and it is the same law failing inside the tool built
to enforce it. The watchdog probes every 5 minutes and reports what it finds **at that
instant**, so a server that restarts *between* two probes is up for both and logs `ok`
twice. Measured on this project's own logs:

| | ok-checks | non-ok lines | restarts concealed behind an `ok` |
|---|---|---|---|
| 17 Aug | 54 | 29 | **21** |
| 18 Aug | 22 | **0** | **11** |

A perfectly clean log for a day the service restarted eleven times. "Stable for ten hours"
and "flapping every nine minutes" rendered identically.

Today's restarts turned out to be development activity — but **nothing in the log could
establish that**, which is precisely the defect. A crash loop would have looked the same.

**Detected on `startedAt`, not on uptime arithmetic.** The obvious test — compare uptime
against the previous uptime plus elapsed wall-clock — needs a tolerance constant, and it
false-positives every time this laptop sleeps, because wall-clock advances while the
process clock does not. `/api/status` already returns `startedAt` and `pid`. A changed
`startedAt` **is** a restart: no threshold to choose, and sleeping cannot fake one.

Verified against a real restart, not a hand-edited state file: the check across pid
26348 → 25796 logged `ok BUT RESTARTED` with both pids and both start times, counted it,
and the following check returned to plain `ok` without double-counting.

**Deliberately not a notification.** Restarting during development is normal, and an alert
that fires while you work is one you learn to dismiss. Same call already made for
per-category budget breaches: log and briefing, never pushed at you. The witnessed count
is carried through the DOWN path too — dropping it there would clear the baseline on every
outage and silently reintroduce the blindness.

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
