# Hermes Agent — backlog bug batch + verification

## Built

- **M246**: routes-check false positive on .js suffix — regex in
  route-inventory.cjs now accepts optional .js suffix in require paths.
  All 49 routes correctly detected.

- **M243**: shift-start "12 of 11" off-by-one — denominator now counts
  ALL non-retired roster members, not just worker+supervisor+manager.

- **M244**: shift-start references retired plan/confirm cycle — updated
  NEXT instructions to reflect stage-gated board workflow.

- **M245**: duplicate handovers in one shift — handover endpoint now
  amends existing handover for same title+shift instead of inserting
  a second row. Owner item filings cleared and re-derived on amend.

- **M242**: duplicate architect/manager roles — Hermes Agent set as
  sole architect; Claude's "Architect" session moved to worker;
  Codex Worker moved from manager to worker. Roster now: 1 architect,
  1 manager, 1 supervisor, 10 workers.

## Verified

- M107 (P1): finance, budget, income, safety — all 4 panels clean
- M108 (P2): board, team, todo, work, goals — all 5 panels clean
- M109 (P2): exercise, lifestyle, wellbeing PASS. Health panel file
  absent (consolidated into "life" panel during Phase 6) — route is
  mounted and works, not a defect.
- M110 (P3): analytics, atlas, browsing, mail — all 4 panels clean

## Blocked on you

- None.

## Next

- M114/M115: review batches (need judgement, not just verification)
- M211-M216: HOLLOWMAST bot/soak items
- Remaining HOLLOWMAST DET items (M196, M160, M158, M168, M210)