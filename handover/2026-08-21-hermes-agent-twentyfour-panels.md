# Hermes Agent — shift 2026-08-21 morning

## Built

Five more dashboard panels + 5 new API routes:

1. **Recurring costs** (+route) — reads finance_transactions for subscription/recurring
   patterns, groups by counterparty, shows total paid, avg monthly, last date.
   Fixed schema mismatch: uses counterparty/reference/amount_pence (not description/amount).

2. **Goal staleness** (+route) — reads goals + goal_steps, flags goals whose steps
   haven't moved in 30+ days (stale) or 7+ days (slowing). Fixed schema mismatch:
   goal_steps has done_on, not updated_at or created_at.

3. **Browsing recall** (+route) — top 20 domains visited in last 7 days from
   browsing_domain_days. Fixed: subagent used better-sqlite3 directly instead of
   the workspace's ../db module — rewrote to use require('../db').

4. **Safety retrospective** (+route) — spending decisions over time, quietest/busiest
   month comparison, top payees, active limits, recent decisions.

5. **CLAUDE.md timeline** (+route) — parses CLAUDE.md for dated entries (Settled
   section, Learned entries) and renders as a browsable vertical timeline.

All registered in shell.js, nav items in index.html, command.js updated, routes
registered in server/index.js. Server restarted.

## Verified

- All 10 panel files serve 200
- All 5 API routes return 200
- routes-check: 62/62 routes mounted
- health-check: 64/64 panels healthy, 0 broken
- Server restart confirmed: PID changed + /api/status 200

## Cumulative tally (all shifts combined)

24 new panels, 3 broken panels fixed, 12 new API routes.
Dashboard health: 38/41 → 64/64. Panel count: 41 → 64. Route count: 50 → 62.

## Deviations

- Fixed 3 subagent route bugs: recurring-costs schema (counterparty not description),
  goal-staleness schema (done_on not updated_at), browsing-recall module (../db not
  better-sqlite3). These are the kind of schema mismatches that happen when subagents
  guess column names instead of checking PRAGMA table_info.
- CSS: 30+ CSS files now awaiting Codex review.

## Blocked

- Nothing.

## Next

- The remaining backlog items are larger features needing design decisions:
  creative module, viability calculator, habit tracking, briefing improvements.
- These are not panel-wiring tasks — they need owner input on behavior.