# Codex Worker — M107 rendered-claim audit

## Built

- Completed the source-level claim inventory for the finance, budget, income and safety panels.
- No product code or finance data was changed. The four panel worktree diffs are limited to the same `renderLede(...)` import/call; none changes the claims audited below.

## Verified

Status key: **holds** means the current panel text follows from the route implementation; **cannot be checked** means it asserts a live-world or whole-system fact that this source-only, no-finance-data audit cannot establish; **does not hold** is a concrete mismatch.

### Finance

| Rendered claim | Status | Evidence |
|---|---|---|
| Own-account transfers are excluded from the spending breakdown. | **holds** | `/spending`, `monthlySpend`, P&L and forecast all filter `Own transfer` in `server/routes/finance.js`. |
| Each own transfer appears twice, once per side. | **cannot be checked** | That is a ledger/import convention, not an enforced database invariant. The code correctly excludes tagged rows, but cannot prove every real transfer has both rows. |
| Cash withdrawals are not shown as a spending category because the ledger does not know what they bought. | **holds** for the modelling/display rule; **cannot be checked** for the real-world knowledge claim | `/spending` and P&L split `Cash withdrawn` out; the database has no purchase-level cash reconciliation data. |
| A partial current month is compared with the previous month only through the same day. | **holds** | `/spending` computes `throughDay` from `ledgerEnd` and applies it to both month queries. |
| P&L marks a partial final month and says where the ledger ends. | **holds** | `profitAndLoss()` computes `partial` from the account-kind statement span and the panel renders both fields. |
| Services are measured to ledger end, not today, so import lag is not added. | **holds** | `recurring()` uses `ledgerSpan().last`; the panel renders `asOf` and `ledgerStaleDays`. |
| A service with too little history is not called non-recurring. | **holds** | `recurring()` returns it separately with the explicit `not the same as not recurring` reason. |
| Only regular income is forecast, with residual shown and never added. | **holds** | `incomeForecast()` requires at least six observations and CV <= 0.35, returns residual separately, and the panel renders both. |
| The forecast excludes the latest month *because it is partial*. | **does not hold** | `incomeForecast()` always queries `month < lastMonth` and always emits an `excludedNote` saying the last month ended mid-month. There is no condition that checks whether `span.last` is the calendar month's final day. A complete latest month is therefore excluded but described as partial. |
| Net-worth headline is dated by its stalest input and is called cash-in-bank when no assets are recorded. | **holds** | `netWorth()` takes the earliest input date and returns distinct asset/no-asset caveats; the panel chooses its headline from `assetsRecorded`. |
| The access log is a floor, not a total. | **holds** | `/access-log` exposes `isFloor`, `blindTo` and the same limitation text from `server/db.js`; the panel renders the limitation beside the count. |
| Own-transfer suspects are name-similarity candidates only and never recategorise anything. | **holds** | `ownTransferSuspects()` is read-only and returns `ok: false` rather than an all-clear where no owner spelling exists; the panel labels it a guess that changes nothing. |
| The access log counts every ledger read in the system. | **cannot be checked** as an absolute claim | The implementation says it covers callers through `server/db.js` and explicitly lists bypasses. A whole-repository/runtime instrumentation proof is outside this panel audit. |

### Budget

| Rendered claim | Status | Evidence |
|---|---|---|
| Derived lines use a category median from the requested complete-history window, rather than a mean. | **holds** | `budget /derive` calls `finance.typicalMonthly()` and writes its median/basis; `typicalMonthly()` omits the final import month. |
| A manually set line is never re-derived over. | **holds** | The `ON CONFLICT ... WHERE budget_lines.source <> 'manual'` clause protects it. |
| Partial coverage is shown rather than treated as a full month. | **holds** | `headroom()` returns explicit coverage, day count and ledger-end note; the panel shows it whenever incomplete. |
| Headroom is income minus spent money and essential budget still due. | **holds** | That is the exact `headroomPence` expression in `headroom()`. |
| Unbudgeted spend remains counted in spend, rather than disappearing. | **holds** | `headroom()` finds categories without a line and returns them separately while `spentTotal` includes all spending. |
| Cash withdrawals are excluded throughout. | **holds** | Budget uses `finance.monthlySpend()` with its default `includeCash: false`; `typicalMonthly()` has the same default. |
| Thin history is surfaced rather than hidden. | **holds** | API basis includes months-present and panel `thinLines()` emits the qualifying warning. |
| Personal and business wishlist scopes share one headroom. | **holds** | `/wishlist` computes one `monthlyHeadroom` and intentionally uses it for both scope summaries. |
| Approving a wishlist item records a decision and does not buy it. | **holds** within this codebase | The status route updates only `wishlist_items`; there is no payment integration or payment-details route. |
| Nothing in the codebase can buy anything. | **cannot be checked** as a universal negative | Budget has no payment path, but proving every present and future code path across the application is absent needs a dedicated whole-repository audit. |

### Income

| Rendered claim | Status | Evidence |
|---|---|---|
| An empty income ledger and a failed request render differently. | **holds** | `summarise()` uses `no-entries`; the panel's fetch error is a distinct error state and message. |
| Mixed currencies are not added or silently converted. | **holds** | `summarise()` totals by currency, sets `grandTotalPence` to null for mixed currencies, and states no FX rate exists. |
| “Per recorded month” divides by recorded months, not calendar months. | **holds** | The panel divides by `d.monthsRecorded`; route also exposes a separately named calendar-month average per stream. |
| Missing months remain visible rather than being reconciled into a single average. | **holds** | Route computes `monthsMissing`; panel states the distinction in rendered copy. |
| An hourly rate appears only when matching amount-and-time records exist, and uses only those months. | **holds** | `summarise()` filters entries with positive `effort_minutes` and calculates both numerator and denominator from that subset. |
| No time logged produces no invented hourly rate. | **holds** | `hourlyPence` is null without timed entries and the route returns `no-effort`. |
| A run-rate projection is withheld until six recorded months exist and is median-based. | **holds** | `projection` returns `too-thin` under six months; otherwise it uses the last-six median and explains its basis. |
| Entries cannot be recorded in a future month. | **holds** | `POST /entries` rejects a period after `thisMonth()`. |
| Income tracking does not log into services or automate earning. | **holds** within this module | No external-service client or credentials path exists in `server/routes/income.js`; this is not a proof about unrelated modules. |
| Balance snapshots do not fabricate a daily rate across a gap or after a payout. | **holds** | `earningRate()` retains spans, omits gaps and negative payout deltas from its average. |

### Safety

| Rendered claim | Status | Evidence |
|---|---|---|
| Unconfigured ceilings fail closed. | **holds** | Safety migrations seed both ceilings at zero and `check()` adds `no_limits_set` unless both are positive. |
| Both ceilings must be set before anything can pass. | **holds** | `check()` requires positive transaction and monthly limits; `/limits` rejects a per-transaction ceiling above monthly. |
| An empty payee allowlist refuses every named payee. | **holds** | `check()` requires a normalised matching row in `safety_payees`. |
| Names are matched case-insensitively with collapsed whitespace. | **holds** | `norm()` trims, lowercases and collapses whitespace before the allowlist lookup. |
| Authorised money is what the system allowed, not what the user actually spent. | **holds** | `authorisedThisMonth()` sums only allowed `safety_decisions`; finance remains a separate source of spending. |
| Each decision, including a refusal, is recorded. | **holds** | `check()` unconditionally inserts a `safety_decisions` row after evaluating reasons. |
| The log distinguishes never asked from refused/allowed decisions. | **holds** | Route returns separate `recent`, `totals` and `summary` states; panel preserves them. |
| There is no per-call override. | **holds** | `check()` accepts no force/reason/admin bypass and all guard callers use that function. |
| Nothing can pass above either ceiling. | **holds** | `check()` adds transaction and monthly-ceiling reasons independently, including cumulative authorised monthly amount. |
| Nothing in the codebase can move money. | **cannot be checked** as a universal negative | Safety itself only answers/records guard decisions. A full external-integration audit is required to establish this for the complete codebase. |

## Findings

- **M107 is not complete.** The finance forecast's rendered partial-month rationale does not hold for a ledger whose latest imported date is the final day of the month. The projection omits that complete month anyway.
- Per the governing plan, this is recorded and no corrective change was made in this block.

## Risks

- This was deliberately a source-level audit. It did not request live finance, budget or income endpoints because those would expose personal financial data to the worker. Therefore factual values in the live ledger, browser rendering, and external service/device history are not asserted here.
- No test opened or wrote `data/dashboard.db`; no temporary database was created because no test was run after the claim failure was found.

## Next

- A separately authorised fix should make `incomeForecast()` distinguish a genuinely partial last month from a complete latest month, and add a synthetic temporary-DB regression test that prints its `MC_DB_PATH`.

## Blocked

- Stopped at the M107 failure above, as required by `PLAN-2026-08-20-to-23.md`: do not fix or work around a failed claim audit within the same block.
