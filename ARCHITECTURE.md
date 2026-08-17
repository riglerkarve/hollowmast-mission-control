# Mission Control — module contract, migration plan, and the offload policy

Written 17 August 2026 as the Stage 0 deliverable. `CLAUDE.md` in this folder is the
short version that stays true for months; this is the working detail for Stage 1.

---

## 1. The module contract

The pattern already exists in `public/shell.js` and `server/routes/`. It is being
**formalised, not invented** — which is why it costs an afternoon rather than a rewrite.

A module is three files and one row in a registry:

```
server/routes/<module>.js       Express router mounted at /api/<module>
public/panels/<module>/<module>.js   default export { mount(root), unmount() }
public/panels/<module>/<module>.css
public/shell.js                 one line added to the PANELS map
```

### The three rules

**R1 — a module never reads another module's tables.** It calls that module's HTTP API.
The temptation is always "it's the same database, I'll just join". The moment you do,
the two modules cannot be changed independently and the schema becomes a shared global.

**R2 — every figure has exactly one owner.** If two panels compute the same number from
shared storage they *will* disagree, and neither will error. Whichever module owns the
concept exposes it; everyone else asks.

**R3 — a module must derive, decide, or tell you something.** A panel that only accepts
input and shows it back is a chore with a nice font. This is the workspace gate applied
locally, and it is the one that should actually reject work.

### Interface details that bite

- **`unmount()` is not optional.** Panels that poll or hold a timer must clear it, or
  switching tabs leaks intervals firing at a detached DOM.
- **Routers own their tables and their migrations.** A module's tables are created and
  migrated by its own route file, keyed to a `schema_version`.
- **Errors are values.** A panel must render "could not load" differently from "nothing
  to show" — an empty state and a broken fetch must never look the same, or a broken
  parser reads as good news and nobody investigates.

### Schema versioning — do this before the first module lands

Today `server/db.js` uses `CREATE TABLE IF NOT EXISTS` at require time. That is fine for
adding a table and is **not** a strategy for changing one.

Before the finance module imports twelve months of statements, add:

```sql
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

and a numbered migration list applied in order, with a test per migration. Losing an
imported ledger to an unversioned column rename is the one unrecoverable failure this
project has — everything else can be rebuilt from source.

---

## 2. The rename, and folding in `.garage`

Three local services become one. **The order matters and each step is verified by
observing behaviour, not by reading configuration.**

| # | Step | Verified by | Status |
|---|---|---|---|
| 1 | Add a static route serving the workspace root `index.html` and the Oxford Autoworks telemetry pages | Load both through :3000 and compare against :8688 | **done, byte-identical** |
| 2 | Rename the folder `business-dashboard` → `mission-control` | `npm start` serves the dashboard | **done 17 Aug** |
| 3 | Repoint `BusinessDashboard-Server` and `BusinessDashboard-Backup` at the new path, in the same change | Both tasks run; **a new backup file actually appears** | **done, file landed twice** |
| 4 | Retire `GarageServer` and `GarageTelemetryHourly` | Only after step 1 is confirmed | **done, GarageServer disabled** |

**`schtasks /end` does not stop the server.** Verified 17 Aug 2026: it prints
*"SUCCESS: ... has been terminated successfully"*, sets the task to Ready, and leaves the
node child running and still holding port 3000 — Task Scheduler kills the PowerShell
wrapper, and the node process it launched is not in a job object that dies with it. A
`/run` after that starts a second node which cannot bind, exits, and leaves you believing
you restarted the service. `scripts/start-server.ps1` now frees the port itself before
starting, which makes `/run` alone a reliable restart. **Step 4 below depends on this**:
retiring `GarageServer` means stopping it, and stopping it needs the same treatment.

**Steps 2 and 3 are one atomic change or the backups stop silently.** The scheduled tasks
carry absolute paths. A task pointing at a folder that no longer exists does not raise
anything you will see — it just stops producing, and the nightly chain has been unbroken
since 1 Aug.

Verify step 3 by watching a backup land, not by checking the task's exit code. An exit
code tells you the process ran; it does not tell you a file was written.

**Do not delete `backups/` or `data/` at any point.** Move them with the folder.

---

## 3. Where the local model is used — and where it is not

Ollama runs locally on `127.0.0.1:11434`: `qwen3.5:9b` at `num_ctx` 16384, ~84% on the
RTX 5050, 17–24 tok/s. Free, private, and offline. The question is only what it is
*good enough for*, and that is answered by measurement, not by preference.

### Measured, not assumed

`tools/llm-probe.cjs` runs the real job — categorising UK bank transaction descriptors
against the ledger's category list.

| Run | Unambiguous | Judgement calls | Speed |
|---|---|---|---|
| Baseline | **20/20** | 3/5 | ~440 ms/transaction, 25 per batched call |
| With business context in the prompt | **16/20** | 2/5 | ~380 ms/transaction |

**The second row is the finding.** Adding "the trader sells 3D-printed goods, buys
filament and printer parts" to the system prompt made it *worse*, reproducibly: it filed
Sainsbury's, Nando's and Greggs as "Business supplies". Naming a domain biases the model
toward that category across unrelated inputs.

So: **merchant-specific knowledge goes in a deterministic rules table**, not the prompt.
A `merchant_rules` row matching `PAYPAL *3DPRINTUK → Business supplies` is exact,
auditable, and cannot destabilise the other 24 rows. The model handles the long tail the
rules table has never seen.

### The policy

**Offload to Ollama when** the task is high-volume, low-stakes, reviewable, and its output
is structurally constrained:

- Categorising transactions — *as a suggestion the ledger shows for confirmation*
- Summarising a day's data into briefing prose (the numbers come from SQL, never the model)
- Tagging and clustering journal entries
- Drafting a wishlist item's description from a URL

**Never offload:**

- **Any number that appears anywhere.** Arithmetic is SQL's job. A model that computes a
  total gives you a plausible total, which is worse than no total.
- **Anything auto-applied without review**, including categorisation. 20/20 is not 100%
  on the next 20.
- **Anything in the wellbeing module.** Pattern surfacing there must be deterministic and
  inspectable — a local model must never generate advice about the user's mental health.
- **Architecture, project memory, or anything asserting a fact about the code.** A
  confabulated `CLAUDE.md` is worse than none, because it reads as verified.

### Two implementation rules

**Constrain the output with a JSON schema, not `format: 'json'`.** Plain `format: 'json'`
let the model return one object where an array was wanted. A schema with the categories as
an `enum` makes an out-of-vocabulary answer *structurally impossible* — the ledger can
never receive a category it has no column for. That is a guarantee, not a hope.

**Batch, and always have a path that works without the model.** 25 transactions in one
call is ~11 s; 25 separate calls would be minutes. And Ollama is a desktop app that may
simply not be running — every offloaded feature degrades to "uncategorised, sort it
yourself" rather than failing. `temperature: 0` throughout, so a re-run of the same
import gives the same suggestions.

### Operational trap

Killing `ollama.exe` orphans `llama-server.exe`, which keeps the VRAM. The next start then
dies with `CUDA error: shared object initialization failed`, which reads as a driver fault
and is actually just an exhausted 8 GB. Always stop `"ollama*","llama-server"` together and
confirm with `nvidia-smi --query-compute-apps=pid,process_name --format=csv`.

---

## 4. Observed 17 Aug 2026: the server dies silently

Found during the Stage 0 verification sweep. `BusinessDashboard-Server` had started
cleanly at 13:23 and was **not running** by 17:08. Exit code `0xC000013A`
(`STATUS_CONTROL_C_EXIT`) — terminated, not crashed. `logs/server-2026-08-17.log`
contains the startup banner and nothing else. `GarageServer`, started by the same logon
trigger, was still up.

Most likely I caused it with the forced process kills during the Ollama work. That does
not make the finding less real:

- **The log records starts, never stops.** A file whose last line is "Dashboard running"
  looks identical whether the server is up or was killed four hours ago. Absence and
  failure must not look the same.
- **`RestartCount=3 / RestartInterval=1M` did not fire**, because Task Scheduler's
  restart-on-failure keys on the task failing, and a terminated child does not reliably
  present as one.
- **Nothing told anyone.** The dashboard was down for ~4 hours and the only reason it was
  noticed is that a verification sweep happened to curl the port.

This is the **first requirement for the notifications module**, and it is a better one
than any of the alerts on the todo list: *the health of Mission Control itself*. An
uptime check that pings :3000 and says something when it does not answer is worth more
than every notification about the data inside it, because when the service is down every
one of those is silent too.

Log a shutdown line on `SIGINT`/`SIGTERM`/`exit` when the first module lands, so the log
can distinguish "running" from "stopped".

### Built, 17 Aug 2026 — and verified against a real kill

| Piece | File | What it does |
|---|---|---|
| Health | `server/routes/health.js` | `GET /api/health`. Runs a real SQLite query and answers **503 with `ok:false`** when it cannot — a dashboard that cannot read its own database is down, and an endpoint that returns `{ok:true}` without touching storage certifies the process, not the service. |
| Heartbeat | `server/heartbeat.js` | Writes `data/heartbeat.json` every 30 s, temp-then-rename. Records `stopped` on SIGINT/SIGTERM and `crashed` on an uncaught throw. |
| Alerts | `scripts/notify.ps1` | Windows toast. One notification channel, reused by the notifications module later. |
| Watchdog | `scripts/watchdog.cjs` | Separate process, `MissionControl-Watchdog` task, every 5 min. Probes, restarts, alerts on transition. |

**Why a heartbeat as well as a health endpoint.** The endpoint answers "is it up now" and
can never answer "when did it die". A shutdown handler does not fill that gap either: on
Windows a forced kill delivers **no signal**, so the graceful path simply does not run —
and a forced kill is how it usually dies. A timestamp that stops advancing is the only
death signal that survives being killed abruptly.

That also lets the watchdog separate two faults with the same symptom: a **stale**
heartbeat plus a dead port is a kill; a **fresh** heartbeat plus a dead port means the
process is alive and not serving, which is a different bug with a different fix.

**Alert discipline.** One alert per outage, then at most half-hourly while it stays down,
and one on recovery. A successful delivery is logged as well as a failed one — "we
alerted you" and "we tried to alert you" are different facts and the log has to hold both.

**Verified by breaking it, not by reading it.** The server was force-killed with
`Stop-Process -Force`, the same way it died at 13:23. All five paths were exercised:

```
healthy          ok - uptime 113s, 1 tasks
killed           DOWN - last heartbeat 0.7 min ago, killed, no shutdown signal delivered
                 restart succeeded          (new pid, health 200, 5s)
restart fails    ALERTED: Mission Control is DOWN ... exit 1
still down       suppressed duplicate alert - already notified within 30 min
recovered        RECOVERED after 0.4 min down -> ALERTED
```

Run `node scripts/watchdog.cjs --dry` to check without restarting or alerting.

### Keep every `.ps1` in this project pure ASCII

Windows PowerShell 5.1 reads `.ps1` as ANSI unless the file carries a BOM. A UTF-8 em
dash inside a double-quoted string becomes mojibake the parser reads as an early string
terminator, and the task then exits 1 having written nothing at all — which looks exactly
like a permissions problem and is not one. Cost about fifteen minutes on 17 Aug 2026.

```bash
grep -rnP '[\x80-\xFF]' scripts/*.ps1
```

---

## 5. The finance ledger — imported 17 Aug 2026

Five years of Starling personal exports: **63 monthly files, 2021-06 to 2026-08, no gaps,
one header shape throughout, 4,133 transactions, zero malformed rows.**

**The import is proved by arithmetic, not by a row count.** The sum of every transaction
is £135,464.70 in and £135,464.67 out, netting **£0.03 — exactly the closing balance**.
A missing row, a duplicated row, a sign error or a rounding error would all break that
identity. A count only proves the importer counted.

Every amount is additionally round-tripped: parsed to integer pence, formatted back, and
compared to the source string. All 4,133 matched.

### Decisions the real data forced

**Money is INTEGER PENCE.** Parsed from the string, never `parseFloat * 100`.

**The dedupe key is `file:row`, not content.** 15 of the 4,133 rows are byte-identical to
another row with the balance included. Content hashing would silently drop them.

**Starling's `Spending Category` is provenance, never our category.** Measured:

| Bank category | Share | What it actually is |
|---|---|---|
| PAYMENTS | 41.8% | a mechanism bucket — 40.7% Faster Payment, 23.5% ATM, 22.3% Transfer |
| INCOME | 25.8% | direction — 1,064 of 1,065 rows are inbound |
| everything else | 32.4% | genuine categories |

Two thirds of the ledger is labelled by direction and mechanism. Using it as the target
vocabulary would mean a spending view where the largest category is "money left".

**The rules table keys on counterparty AND direction.** Predicted, then measured:

| Key | Single-category keys | Rows covered |
|---|---|---|
| counterparty | 382 / 418 | 2,113 (51.1%) |
| counterparty + direction | 436 / 451 | **3,047 (73.7%)** |

For a person, "PAYMENTS" vs "INCOME" is the sign of the amount. Adding direction is worth
22.6 points of deterministic coverage.

**How little hand-authoring this needs.** By volume, not by merchant:

```
top  10 counterparties -> 52.4% of rows
top  25               -> 67.3%
top  50               -> 79.3%
top 100               -> 88.7%
226 parties seen once -> 5.5% of rows   <- the only part the model is for
```

Twenty-five rules cover two thirds of five years. This is a much smaller job for the local
model than section 3 assumed, and that is the right direction given 20/20 is not 100%.

**Cash is the real blind spot.** 449 rows (10.9%), **£38,219 net withdrawn over 63 months**
— about £607/month that leaves the account and becomes invisible. No import can fix this;
it is the gap manual entry exists to close, and any spending total must say so rather than
quietly under-report.

### Two more scheduler traps, both found by testing

**`schtasks /run` immediately after `/end` is silently dropped.** `/end` returns SUCCESS
at once but the state lags a second or two, and a `/run` inside that window does nothing:
no error, `LastRunTime` unchanged, task still on the old process. Two "restarts" that never
happened. The watchdog now polls `schtasks /query` until the task leaves `Running`, and
gives up loudly rather than reporting a restart it did not perform.

**Heartbeat age cannot tell a kill from a hang.** The beat is every 30 s, so a
just-killed server still has a heartbeat seconds old — measured, it called a real kill
"alive and NOT serving". Whether the PID still exists is the definitive test
(`process.kill(pid, 0)`); the timestamp only says *when*. The three states now read
differently: **gone** (killed), **alive and beating** (running, not serving), **alive and
not beating** (wedged).

### Two accounts, and a filename that cannot tell them apart

Both Starling accounts export as `StarlingStatement_YYYY-MM.csv`. The second download is
distinguishable only by the browser's ` (1)` suffix. **`--account` is therefore required
and never inferred** — an importer that guessed from the filename would silently merge a
business account into a personal one.

Which set is which was settled by content, not by name: the ` (1)` set's largest
counterparty is `Jonathan Whiteford` ×724, the exact mirror of `Private Security Services`
×724 in the other set. Those are the two halves of the same 724 transfers.

| Account | Rows | Range | Sum of transactions | Closing balance |
|---|---|---|---|---|
| Starling (personal) | 4,133 | 2021-06-16 .. 2026-08-11 | £0.03 | **£0.03** |
| Private Security Services (business) | 2,706 | 2021-06-16 .. 2026-05-31 | £0.00 | **£0.00** |

Both verified independently by the same identity.

**`Own transfer` is now 1,948 rows, 28.5% of the ledger**, and the reason it must exist is
sharper with two accounts: each transfer between them appears **twice**, once from each
side. Any combined figure that does not exclude this category double-counts nearly a third
of the ledger.

**Whitespace normalisation is not cosmetic.** `Jonathan Whiteford` and
`Jonathan  Whiteford ` are the same person and different strings; the second spelling is
47 rows. Patterns and counterparties are both collapsed to single-spaced, trimmed,
lower-case before matching.

A note on how that nearly went wrong: the normaliser was first written as `/s+/` rather
than `/\s+/` — a lost backslash — which strips the letter *s*. Coverage still went **up**,
because the pattern and the counterparty are mangled identically, so `tesco` and `te co`
still matched. A green number is not a working function; the fix was caught by asserting
`norm('Tesco') === 'tesco'`, not by watching the percentage.

### Current rule coverage — 72 rules, both accounts

```
6,839 transactions   4,858 matched (71.0%)   1,981 unmatched (29.0%)
```

What is left is overwhelmingly person-to-person: **39.0% Faster Payment in, 29.8% Faster
Payment out** — 69% of the remainder, across 258 distinct counterparties most of which
appear once or twice. These are the rows the model is for, and they are the rows where
"who is this person" is a judgement no merchant table can hold.

### The model's actual contribution: 324 rows of 6,839 (4.7%)

Rules-then-model, in that order, over the whole ledger:

```
108 rules   6,515 rows  95.3%   deterministic, auditable, in finance_rules
model         324 rows   4.7%   suggestions only, category_source='model', reviewed=0
                                134s, 414 ms/row, 0 unparseable, 0 out-of-vocabulary
```

414 ms/row against the probe's 440 — the measurement held on ten times the data. The
schema `enum` did its job: not one out-of-vocabulary answer was structurally possible.

**Two things the spot check exposed, and both are the point of having a review queue.**

*The model filed `Scottish Power` as **Fuel**.* Defensible from the word "Power" and wrong,
and it is not really the model's error — **the vocabulary has no `Utilities` category**.
Electricity, gas and water have nowhere honest to go. That is a gap in what I derived, and
the model surfaced it by being forced to pick something.

*`Security Industry Auth` (£184) and `Get Licensed` (£370) are SIA licensing* — business
costs sitting in the personal ledger. That is exactly the evidence todo 14 needs, and it
argues the business flag is worth more than I assumed.

The model's most common answer for the genuinely opaque was `Other` — `Pcs*popa
Distribution` ×10, `SumUp` ×4, `Curb` ×3. Declining is the correct behaviour and the
prompt says so explicitly.

### Precedence, top to bottom

```
manual   a human decision; immune to re-running rules or the model
rule     deterministic, 108 of them, re-derived on every run
model    a proposal, never accepted, always reviewed = 0
```

`POST /api/finance/transactions/:id/category` promotes a row to `manual` and validates the
category against `finance_rules` — an unknown one is a 400, not a new category invented by
a typo.

---

## 6. Todo 14 — and why the todo item had it backwards

`tools/business-split-report.cjs`, schema v2 (`business`, `business_source` on
transactions and rules). The flag defaults from the account the money left — the strongest
evidence available, recorded as `business_source = 'account'` so it can be told apart from
a decision later.

The item reads *"move business expenses to business account"*. The data says business
expenses are **already** on the business account, and the real exposure is the other way.

| Finding | Rows | Amount |
|---|---|---|
| Business-looking spend on the **personal** account | 12 | **£251** (£184 of it one SIA licence) |
| Personal-looking spend on the **business** account | 829 | **£7,904** |
| Cash withdrawn from the business account | 259 | **£21,647 — 37.7% of all business outgoings** |

The move list is essentially empty. Acting on the item as written would have fixed £251
and left £29,551 untouched.

**Business account by UK tax year**, own transfers excluded:

```
2021/2022   in 24,281   out 20,368   of which cash  4,625
2022/2023   in 15,543   out 11,109   of which cash  6,192
2023/2024   in 20,352   out 17,337   of which cash  6,322
2024/2025   in  1,389   out  5,682   of which cash  3,449
2025/2026   in  1,035   out  2,888   of which cash  1,060
```

### The filter that had to be thrown away

The first test for "business spend on the personal account" was *"the business account has
also paid this merchant"*. It returned 200+ rows and 62 KB of output, because for a sole
trader both accounts buy from Amazon, CeX and Argos. It was a **correct answer to a much
broader question** than the one asked, and it read as a finding.

The test that means something is **skew**: at least 3 rows on the business account and at
least 80% of that merchant's rows there. Overlap is normal life; skew is a signal. That
cut 200+ rows to 12.

The report now prints its residue — **172 merchants appear on both accounts and were
excluded** — and states what it does not key on: amount, date, or what was actually
bought. A business laptop and a personal one from the same shop are identical to it.

---

## 7. Todo 13 — the morning briefing

`scripts/briefing.cjs` + `server/routes/reports.js` (schema `reports` v1), scheduled daily
at 07:00 as **MissionControl-Briefing**, `StartWhenAvailable` so a sleeping laptop gets a
late briefing rather than none.

**Every number is SQL. The model writes one sentence and is forbidden from containing a
figure** — and that is enforced, not requested.

The first version asked for "at most two" numbers repeated. It rendered 323 as
**"Thirty-two three transactions await review"** — a wrong figure in a calm, confident
sentence, which is precisely the failure the no-numbers-from-a-model rule exists to
prevent. The prompt now forbids quantities entirely, and a guard discards any candidate
sentence containing a digit *or* a number word. Seven cases asserted, including the
original failure and a deliberate false positive ("no **one** has reviewed these") that
the guard rejects — it errs toward discarding, which is the correct direction.

If the sentence is discarded, or Ollama is not running, the briefing says which happened
and prints every number unchanged. A briefing without prose is still a briefing.

**The hardest thing here was not the model.** The ledger is an *import*, not a feed: it
ends when the last statement ended. A naive "yesterday's spending" section would render
empty and read as *you spent nothing*. The briefing compares the last 28 **ledger** days
with the 28 before, states the ledger's age, and past 40 days says outright that it is
stale rather than reporting a silent zero.

**Relation to `income-portfolio/scripts/daily-briefing.mjs`:** it keeps that script's two
best ideas — narrative inputs expire, and zero is reported as zero — but is a separate
program, because that one runs in GitHub Actions where this SQLite database does not
exist. A known divergence with a stated reason, not an oversight.

---

## 8. The Money panel — the ledger is finally openable

`public/panels/finance/` over `GET /api/finance/spending` and `/months`. Month selector
across all 63 months, account tabs, category bars against the previous month, cash
reported separately.

**Three things it must never do**, each of which would make it lie quietly:

1. **Include `Own transfer` in any total.** With two accounts every transfer appears
   twice. Including them inflates five-year income by 40%.
2. **Present `Cash withdrawn` as a category of spending.** It is shown in its own card
   with the reason. Folding it in would imply the ledger knows where it went.
3. **Compare a partial month with a whole one.** The ledger ends 2026-08-11, so August is
   11 days. Both months are clipped to the same day-of-month and the panel says so.

Two more absence-versus-failure cases it distinguishes by sentence, not by an empty box:
a category that fell to **zero** still appears (it would otherwise vanish, hiding the
largest change there is), and selecting *Business* for August says *"this account's
statements end 2026-05-31"* rather than *"no spending"* — one is missing data, the other
is a month without spending.

### The comparison bar took three attempts, all measured

The reference for last month had to be tellable apart from both the empty track and this
month's fill.

| Attempt | vs empty track | vs this month's fill |
|---|---|---|
| A third tint of the accent | 2.05:1 at best | 2.05:1 at best |
| An outlined box | 4.97:1 | **1.15:1** |
| **A tick at the point it reached** | **9.38:1** | **2.38:1** |

Three tints of one hue cannot be separated — the luminance range is not there. The
outline fixed the track but scored 1.15:1 where it crossed the fill, i.e. invisible in
exactly the case that mattered, which was 7 rows out of 7. The tick is a different
*instrument*, not a different shade, and it carries the only fact the reference holds:
where last month got to.

**One honest caveat.** In light mode the accent bar against its own track is 2.56:1,
under the 3:1 a graphical object should meet. That is the app's existing palette rather
than anything this panel introduced, and it is acceptable here only because **every bar's
value is printed as text beside it at 5.9:1** — nothing is carried by colour alone.

### CSS tokens must come from the sheet, not from memory

The first draft used `--bg-input`, `--bg-hover`, `--ok`, `--bad`, `--warn`. **None exist.**
Every one silently fell back to a hardcoded dark colour, so in light mode both new panels
would have drawn dark input boxes on a white card. The real tokens are `--accent`,
`--accent-soft`, `--bg`, `--card`, `--border`, `--ink`, `--muted`, `--ring-bg`, `--short`,
`--long`, `--work`, and the theme defines a light and a dark value for each.

A `var(--name, #fallback)` that never resolves is invisible in the theme you happen to be
using. Grep the stylesheet for the token before relying on it.

---

## 9. The `.garage` fold-in — done 17 Aug, and NOT the way section 2 described it

Section 2 said "add a static route serving the workspace root". **Do not do that**, and
the plan was wrong to say it so plainly.

`.garage/garage-server.cjs` served the entire workspace root and that was safe, because it
bound `127.0.0.1`. **Mission Control binds `0.0.0.0` on purpose**, so the same mount
through this server would have published to anything on the LAN, with no authentication:

```
mission-control/data/dashboard.db        the live ledger, 6,839 real bank transactions
mission-control/backups/*.db             20 more copies, 13 MB in total
every CLAUDE.md, every project's source   ~1,116 files within three directory levels
```

Nothing about the fold-in needed any of it. **The console links to six files.**

### What was built instead

`server/routes/garage.js`, mounted at `/garage`, is an **allowlist**: six named files plus
two directories they legitimately draw assets from. Paths are normalised *before* the
membership test, so `Mini Games/../mission-control/data/dashboard.db` is refused rather
than passing a prefix check and resolving elsewhere. A blocked-extension rule
(`.db`, `.sqlite`, `.env`, `.key`, …) applies even inside an allowed directory, so a
database dropped there later does not become reachable by accident.

A refusal says *"not served, this is an allowlist"* rather than a bare 404 — otherwise a
file that is present and deliberately refused sends you hunting for a missing one.

**15 cases asserted** against the resolver directly, then live over HTTP: the six console
files serve, the ledger, its backups, every `CLAUDE.md`, HOLLOWMAST source, an unlisted
docs file, and both traversal forms are refused.

### Update, 17 Aug 2026 — the front door itself is now locked

The allowlist above was the right call and stands. But it only ever constrained *what*
`/garage` would serve; it did not answer the prior question, which is **who is asking**.
Every `/api/*` route was still unauthenticated to anything on the LAN, and the machine's
WiFi profile was found sitting on the **Public** category with inbound Allow rules for the
Node runtime — so the trusted-home-LAN assumption behind the `0.0.0.0` bind was not
holding.

`server/gate.js` closes it without giving up the phone: **loopback passes, the network
must present a key.** See `CLAUDE.md` for the mechanism and the unlock flow.

**The check that mattered before writing it** was not the design, it was the caller audit.
A gate that also blocks `scripts/watchdog.cjs` would take the service down every five
minutes while reporting a successful restart. One sweep across the whole workspace for
`127.0.0.1:3000`/`localhost:3000` found exactly **one** HTTP caller — the watchdog — and it
is on loopback, so the exemption covers it. `briefing.cjs`, `backup.js` and both importers
talk to SQLite directly and never touch the port.

**Verified over HTTP, both sides of the boundary**, since a gate that only proves it lets
you in has not been tested at all:

| Caller | `/api/finance/summary` | `/garage` | `/` |
|---|---|---|---|
| `127.0.0.1`, no key | 200 | 200 | 200 |
| `192.168.0.135`, no key | **401** | **302 → /unlock** | **302 → /unlock** |
| `192.168.0.135`, correct key | 200 | 200 | 200 |
| `192.168.0.135`, wrong key | **401** | — | — |

The wrong-key row is four cases, not one: a plain wrong string, a **truncation** of the
real key, and a **single-character case flip** of it (`…211s` → `…211S`) all return 401,
which is what distinguishes a real comparison from a prefix or length test.

One reading that looks like a failure and is not: after unlocking, `document.cookie` does
**not** contain `mc_key`. That is the `HttpOnly` flag working — page scripts cannot read
it. Confirm the cookie from the `Set-Cookie` header, never from the DOM.

### Verified byte for byte, not by status code

Two servers both answering 200 with different bytes is the failure a status check misses.

```
/index.html                                     8,088 B   d44d541f96d5932e ==
/Mini Games/give-way.html                      32,522 B   23a91f02491eb1ef ==
/Oxford AutoWorks/docs/session-dashboard.html 283,634 B   197066bab23720f1 ==
/Oxford AutoWorks/docs/session-playbook.html  188,643 B   701d19a7e773bcde ==
/Oxford AutoWorks/docs/telemetry/README.md     21,014 B   e6b4f3774e6d727b ==
/Oxford AutoWorks/docs/telemetry/ledger.jsonl  20,501 B   a2ecdec8b49f48f6 ==
```

Identical content and identical `content-type` on both. Every relative link was then
resolved in a browser: all five console links stay inside `/garage/`, and the telemetry
page's `../../index.html` back-link resolves to `/garage/index.html`, 200.

### The retirement

`GarageServer` is **Disabled, not unregistered** — `Enable-ScheduledTask -TaskName
GarageServer` restores it. Port 8688 now refuses connections. Stopping it needed the
documented trap handled again: `schtasks /end` orphaned the node child, so the process
holding the port was stopped directly, and only after confirming its command line
contained `garage-server.cjs`.

**`GarageTelemetryHourly` is untouched and must stay.** It writes
`Oxford AutoWorks/docs/telemetry/ledger.jsonl`; it does not serve anything. Retiring it
would silently stop the data the console displays while the console kept working.

### Express 4, not 5

`router.get('/*splat', …)` is Express 5 syntax. Under the Express 4 in this project it
matched **nothing** and returned no error — every path 404'd, including the ones that
should serve, which read as a path-resolution bug. The v4 form is `'*'` with
`req.params[0]`.

---

## 10. The rename — done 17 Aug 2026

`business-dashboard` → `mission-control`, and the scheduled tasks renamed with it.

| Task | Was | Now |
|---|---|---|
| Server | `BusinessDashboard-Server` | `MissionControl-Server` |
| Backup | `BusinessDashboard-Backup` | `MissionControl-Backup`, 23:55 local |
| Watchdog | — | `MissionControl-Watchdog`, repointed |
| Briefing | — | `MissionControl-Briefing`, repointed |

**Nothing in the codebase needed changing.** Every path inside the project is
`__dirname`-relative, so the folder moved cleanly — including the Garage route, whose
`ROOT` is `__dirname/../../..` and still resolves to the workspace. The only absolute
references anywhere were the four scheduled tasks and the documentation. That was
established by search *before* the move, not discovered afterwards.

### What actually went wrong

**The rename failed the first time: "the item is in use".** No process command line matched
the folder and port 3000 was free — the handle belonged to a backgrounded `grep` still
walking the 4.7 GB Oxford AutoWorks tree, plus the shell's own working directory. A file
handle has no command line to grep for. Stopping the search and moving the shell out let
it rename on the first retry.

**I nearly moved the backup an hour earlier.** Recreating the trigger I read `22-55` off
the backup *filenames* and set 22:55. The filenames are UTC (`...T22-55-02-312Z.db`); the
task ran at **23:55 local**. Caught by printing the old trigger's `StartBoundary`
(`23:55:00+01:00`) beside the new one instead of trusting the value I had inferred. A
timestamp with a `Z` on it is not the local time, and a backup silently moving an hour is
the kind of drift nobody ever notices.

### Verified, in this order

1. Health 200 from the new path; all four panels and all four APIs 200.
2. Ledger intact — 6,839 transactions, 6,515 by rule, 323 awaiting review, 1 manual.
3. Garage route still serves its six files and still refuses the ledger.
4. **A backup file appeared.** Twice. The scheduler reported exit 0 both times, which is
   not the evidence — the evidence is `21 → 22 files` and a 2.06 MB file on disk.
5. The server was force-killed and the **watchdog recovered it under the new task name**,
   in 10 s, and alerted.

Rollback material is in the session scratchpad: a `VACUUM INTO` copy of the database taken
before the move, and the four original task definitions as exported XML.

---

## 11. Wellbeing and Health — 17 Aug 2026

### Wellbeing (`wellbeing` v1, `/api/wellbeing`, panel `#wellbeing`)

Built under three constraints from the workspace file, none of them stylistic:

> *"Never build anything in the wellbeing module that reads as diagnosis, clinical advice,
> or a risk score. Journal, patterns, signposting. The signposting panel is fixed and
> always present, regardless of what the data says."*

and *"never offload … anything in the wellbeing module"* to the local model.

So **every figure is a count or a recall of something already recorded.** Nothing is
weighted, scored, averaged into a trend, or interpreted. *"You have logged 9 of the last
14 days"* is a fact. *"Your mood is declining"* is a clinical claim this module is not
allowed to make and could not stand behind. The mood buttons are visually **uniform** —
colouring 1 red and 5 green would turn a private note to yourself into a verdict.

**The support card is served unconditionally** by `/api/wellbeing/support`, rendered
before any data loads, and present when the table is empty, when the query fails, and even
when the server does not answer (the panel carries a built-in copy). Nothing can suppress
it and nothing reorders it.

Numbers verified 17 Aug against **nhs.uk** and **samaritans.org**, and the check date and
sources ship with the data so they can be re-checked rather than trusted indefinitely:
Samaritans 116 123 · Shout, text SHOUT to 85258 · NHS 111 · CALM 0800 58 58 58 ·
Papyrus 0800 068 41 41.

**Capture is one keystroke**, as the gate requires, and returns recall immediately:
*"Logged 'good'. That is 3 of the last 14 days. First time you have logged this one."*
Two behaviours were tested rather than assumed — a bare `3` logs; a `3` typed **into the
note box does not**, so writing "felt like a 3 today" cannot silently record one. And the
document-level key handler is removed on `unmount()`: without that, pressing a number on
any other panel would keep logging moods. Both verified in the browser.

### Health (`health` v1, `/api/health`, importer unverified)

`health_metrics` is a long table — `(date, metric)` — not a wide row per day, because the
sources fill different metrics at different times. A wide row would let an import overwrite
a hand-entered weight with a NULL, and that is very hard to notice. Precedence matches the
ledger: **manual beats import**, enforced in SQL (`WHERE source <> 'manual'`) and tested.

**No Samsung Health export exists on this machine, so the importer has never seen the real
format, and it says so in its own header.** `--inspect` is the default and writes nothing:
it reports filenames, which row it believes is the header, the column names it found, and
whether the columns it needs are among them. Only after reading that should `--import` run.

That design earned itself immediately. The first header-finder looked for "the first row
that looks like column names" and locked onto Samsung's **metadata line** every time —
its first cell, `com.samsung.shealth.step_daily_trend`, looks exactly like a column name.
It reported `NOT IMPORTABLE` rather than importing nonsense. The fix was to look for the
row *containing the columns we actually need*: a header is identified by what you are
looking for in it, not by looking header-ish.

Tested against a synthetic export in the shape the importer **declares** — which proves
the parser, not the format. Steps and weights landed correctly, weight converted kg → grams
(82.4 → 82400), a manual value survived a re-import, and unrecognised files printed their
first rows so the real column names can be read off.

### The filename collision that took the server down

`server/routes/health.js` already existed — it was the uptime endpoint — and the health
module was written **straight over it**. The server then failed to start with a duplicate
`healthRouter` declaration, which is the lucky outcome; a non-colliding name would have
left the uptime check silently gone.

Fixed by giving each its own name: liveness is now `server/routes/uptime.js` at
**`/api/status`** ("is the service alive"), and `/api/health` belongs to the health module.
The watchdog's probe URL moved in the same change and was re-verified against a live kill.

This is the second name collision today — `reports` was the first, caught before it shipped
because the file did not already exist. **Grep `server/routes/` before naming a module.**

---

## 12. The Samsung import, run for real — and the zeros that were not zeros

269 daily values imported from the real export: steps 95 days, sleep 50, hr_min and
hr_median 62 each.

**27 of the 95 step-days recorded zero.** A zero-step day and a day the watch sat on a
desk are the same row, and only one of them means you did not walk. Heart rate is an
independent witness — if the watch took readings, it was on the wrist.

Measured: **all 27 zero-step days had no heart-rate readings whatsoever.** Every zero was
a missing day, not a still day. Counting them drags the median from **1,689 to 1,293 — a
31% understatement** of a number that otherwise reads as fact.

The rows are **not deleted**; the export really did say zero and that is worth keeping.
They are marked `noData` and excluded from summary statistics, and `/api/health/series`
returns **both** medians — `median` and `medianIfZerosCounted` — so the gap is visible
rather than something to be argued about later.

### The vocabularies drifted

`METRICS` in the route still advertised `resting_hr` and `weight_grams` after the importer
had been rewritten to produce `hr_min` and `hr_median`. The panel could therefore offer a
metric the route answered `unknown metric` to — the two only disagreed at runtime, on a
path nothing had exercised.

Caught by a check that is now worth keeping: **assert that every metric the module
advertises actually resolves.** Six advertised, six resolve. `weight_grams` and `meals`
are marked `source: 'manual only'`, so an empty chart reads as "nothing entered yet"
rather than as "no activity".

---

## 13. Self-assessment preparation — and why it produces no expenses figure

`tools/tax-year-report.cjs`. Five UK tax years off the business account, boundary computed
in SQL (6 April to 5 April) rather than from a year column, because a day's error moves
income between years.

**It deliberately does not produce an allowable-expenses total, and that is the finding.**
Turnover is knowable from the bank with reasonable confidence. Expenses are not, because
the account was used personally throughout and 37.7% of everything that left it was cash.
A tool that emitted a tidy expenses figure here would be inventing one.

```
year        turnover       out   maybe-biz    unknown       cash   personal
2021/2022   24,187.43  20,367.69   9,302.79   2,956.15   4,625.00   3,364.81
2022/2023   15,543.45  11,109.38   1,627.42   1,130.60   6,192.16   2,159.20
2023/2024   20,250.93  17,337.49   3,308.63   6,084.73   6,321.75   1,622.38
2024/2025    1,389.00   5,681.86     198.79   1,321.25   3,448.50     713.32
2025/2026    1,030.00   2,888.06      92.88   1,691.00   1,060.00      44.18
TOTAL       62,400.81  57,384.48  14,530.51  13,183.73  21,647.41   7,903.89
```

Every category carries a stated confidence band — `TURNOVER`, `MAYBE BUSINESS`, `UNKNOWN`,
`UNEVIDENCED`, `LOOKS PERSONAL`, `NOT AN EXPENSE`, `REDUCES COSTS` — so the report cannot
quietly promote a guess into a deduction. **"Maybe business" is explicitly labelled a
shortlist to check against receipts, not a total.**

Three figures are the whole story: **£21,647 of cash** no import will ever attribute,
**£13,184 of transfers to named people** whose purpose only the user knows (wages and
personal transfers are treated very differently), and **£7,904 of clearly personal
spending** out of the business account, which is not deductible and is the argument for
separating the two.

Turnover fell from £24,187 to £1,030 across the five years. Stated as a fact in the data;
no conclusion drawn from it here.

This file totals transactions. It does not decide what is allowable, whether any allowance
applies, or which years remain open — and it says so in its own output.

---

## 14. Lifestyle module (subagent-built, wired 17 Aug)

`server/routes/lifestyle.js` + `public/panels/lifestyle/`, mounted at `/api/lifestyle`.

**Stored: three columns.** `interval_days`, one row per "did it", and `meals` per date.
There is no schedule, no due date, no outstanding list and no state column anywhere.

**Derived per request:** `daysSinceDone`, `dueInDays`, `nextDueOn`, and a state of
`due | soon | ok | never done`. Verified: recording Laundry twice produced
`state=due, daysSince=9, dueIn=-2, nextDue=2026-08-15` while the untouched chores stayed
`never done`.

Two things it gets right that were the whole point of the design:

**`never done` is a first-class state** carrying `null` for every day-count plus a `why`
string — *"there is no date to count an interval from. This is not the same as 'not
due'."* Never a fabricated zero.

**The median gap is withheld rather than shown thin.** With two recordings it returns
`medianDays: null, gapsCounted: 1` and states *"Needs 4 recorded days to have 3 gaps to
take a median of; there are 2."* That is the thin-data rule enforced by the module itself.

Intake has **three** states, not two: recorded-and-at-floor, recorded-and-below, and
**not recorded** — a day with no entry is never counted as a day below the floor, because
inferring a miss from silence would be inventing data about the user's eating.

---

## 15. Three modules built by subagents, 17 Aug

Income, lifestyle and todo were built in parallel by three agents. **Each was told to create
only its own route and panel; the parent did all `index.js` / `shell.js` / `index.html`
wiring.** Those three files are the only ones every module must touch, so leaving them to
one writer removed the single collision risk. It held: none of the three was edited by an
agent.

Worth recording because two agents reported otherwise — both saw the shared files' mtimes
move mid-run and inferred a rival session. It was the parent wiring the previous agent's
module. **A changed mtime is evidence of a write, not of who wrote it**, and both agents
drew a confident conclusion from it. Checked rather than believed: the files contained no
reference to any of the three modules until the parent added them.

### What each agent decided that was better than the brief

**Income — currencies are never summed.** Honeygain and Coinbase pay in USD. With no FX
rate available, a made-up rate makes a made-up total, so `grandTotalPence` is `null` when
currencies are mixed and the panel says why. It also added a nullable `effort_minutes`,
because the "worth it?" column the brief demanded had no input otherwise — and NULL is not
0, since zero would claim an infinite hourly rate. Its own verification caught two real
defects: a "primary currency" chosen by sorting cents against pence, and an update echoing
the request rather than the stored row.

**Lifestyle — the median gap is withheld below three gaps**, with the count and the reason,
rather than shown thin. `never done` carries `null` day-counts and a `why` string. Intake
has three states so a day with no entry is never counted as a day below the floor.

**Todo — it refused to build the dependency graph.** Several rationales say "Depends on 11"
or "Blocks 46", but the same regex also matches "63 months", "108 rules" and "weeks 8-11".
Its judgement: *a link graph that is quietly 30% wrong is worse than none* — it needs a
column entered deliberately. It also reports the residue of its own effort estimate:
*"120 h covers 42 of 55 open items. 13 carry no estimate and are NOT in that figure."*

### Verified after wiring, not taken on report

Ten routes answer 200. Nine panels render with zero console errors. The todo views
**partition exactly** — 26 blocked on you plus 67 buildable equals 93, no overlap — checked
against the API rather than the panel. No horizontal overflow at desktop width.

The headline the backlog now shows on open: **26 of 81 open items are waiting on you, 32.1%
of what is left, and nothing in the build queue can clear any of them.**

---

## 16. Reports show work, and the two money questions the ledger could finally answer

### Item 45 — the briefing leads with what got done

`scripts/briefing.cjs` opens with **"What got done"** rather than spending. It asks each
module through an accessor — `tasks.completedSince`, `todo.decidedSince`,
`lifestyle.activitySince`, `wellbeing.daysWrittenSince` — and reads none of their tables,
so no figure ends up with two owners.

**`tasks` had no completion date.** A finished task carried no timestamp, which made the
most obvious work signal in the app unanswerable. Fixed by a migration (`tasks` v1) adding
`completed_at`, stamped on the transition to done and **cleared on reopen**, so the date
always means "finished on" and never "was finished once". The backfill is deliberately
NULL — the already-done rows have no honest completion date, and inventing one would make
the first weeks wrong in a way nothing could later detect.

The section reports its own blind spots: *"12 backlog items were already done or declined
when imported, with no date recorded — they are real work this count cannot show."*

Wellbeing publishes a **count of days written and nothing else** — no mood value, no
average, no direction. Whether you wrote is a fact about the week; what you wrote is not
the briefing's business, and the module will not hand it over.

### Item 34 — answered with the user's own criterion

The item said *"limited company within 2 years, urgency scales by income"*. So the check
applies that rule rather than an opinion about incorporation:

```
2021/2022  £24,281   57 payments
2022/2023  £15,543  138 payments
2023/2024  £20,352   58 payments
2024/2025   £1,389   15 payments
2025/2026   £1,035    4 payments
```

**Nothing has come into the business account for 197 days.** Urgency scales with income;
there is no income to scale it with. Incorporating a non-trading company adds annual
accounts, a confirmation statement and a CT return from day one regardless of earnings.
Recorded as a **trigger, not a date**: revisit when the account takes money in again.

### Item 36 — a forecast, and the residue that makes it readable

`GET /api/finance/income-outlook`. The standing rule forbids forecasting from thin data;
63 months is not thin, but most of it is dead. Each source must clear three tests before
it may be projected: **≥6 paying months**, **≥75% regularity** (distinct paying months
over its span, inclusive), and **paid within 45 days**.

One source qualifies: DWP PIP, £558.40/month, 100% regular over 29 months.

**£141,171.87 of historical income comes from sources that have stopped** and is excluded
by name and reason — Valhalla Security silent 1,006 days, Insight Security 1,725, VLM
1,522. Without that residue a £6,700 annual figure reads as the user's income rather than
as the fraction still arriving.

The monthly figure is the **median of months that actually paid**, not the mean: a single
arrears payment would otherwise set a monthly number that never occurs.

**A metric that reported 150% caught an error in the making.** The first regularity
calculation divided distinct months by a *rounded* span and produced impossible
percentages. A figure over 100 is proof the denominator is wrong, not evidence of a strong
signal, and it was fixed before anything was built on it.
