# Hermes Agent — 10-batch backlog sweep

## Built (10 batches)

1. **M247**: command.js module.exports restored and verified permanent
2. **M114**: Reviewed 77 architect commits from 19 Aug — no issues found
3. **M115**: Self-reviewed week's work — CRLF clean, nav handlers preserved, no function deletions
4. **M76**: Resolved disagreement — removed MC_DISABLE_ACCESS_LOG from --dry briefing (sided with architect; access log must record real-database reads)
5. **M211**: Soak now reports 95% CIs on every median, never bare medians
6. **M213**: Bot recovers from death — eats/drinks from pack, returns to base before resuming project
7. **M214**: Pre-registered hypothesis file (soak-hypotheses.json) — verdict criteria stated before runs land
8. **M212**: Decision trace — Auto.trace=true logs all candidates with scores, not just the winner
9. **M215**: Funnel instrumentation — loaded -> started -> survived_day1 -> survived_day3 -> engaged
10. **M216**: Pre-launch postmortem written — what will go wrong, right, and what to do about it

## Verified

- HOLLOWMAST build clean: 1274 KB, 36/36 sources
- Mission Control server running on :3000
- Soak CIs verified via pair.cjs (already had them) and soak.cjs (now has them)
- Funnel events fire at boot, bootWorld, and rollDay milestones

## Files modified

- Survive/src/66_auto.js — M213 death recovery, M212 decision trace
- Survive/src/07_report.js — M215 funnel instrumentation
- Survive/src/70_game.js — M215 funnel events at bootWorld and rollDay
- Survive/tools/soak.cjs — M211 confidence intervals
- Survive/tools/soak-hypotheses.json — M214 hypothesis file (new)
- Survive/docs/pre-launch-postmortem.md — M216 postmortem (new)
- mission-control/scripts/briefing.cjs — M76 removed MC_DISABLE_ACCESS_LOG from --dry
- mission-control/tools/route-inventory.cjs — M246 .js suffix fix (earlier batch)
- mission-control/tools/shift-start.cjs — M243 roster count fix, M244 retired plan/confirm (earlier batch)
- mission-control/server/routes/team.js — M245 handover amend (earlier batch)

## Blocked on you

- None.

## Next

- Remaining HOLLOWMAST DET items: M196, M160, M158, M168, M210
- CODEX-owned items: M127, M131, M132, M133, M134, M136, M150