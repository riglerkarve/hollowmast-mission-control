# Codex Worker

## Built

- Committed Emberfall change `8825f40` (`Migrate legacy profile saves`).
- `SessionStore` now upgrades pre-Profile saves that lack `createdAt`, `resources`, and `avatar` when read, then writes the repaired JSON back to SQLite.
- Partial ledger shapes are normalized without fabricating unrecorded history; an invalid or absent avatar uses the default.
- Updated Emberfall's README to replace the resolved migration caveat with the implemented behavior.

## Verified

- `npm run check` completed: both TypeScript configurations passed; Vitest reported 4 files / 137 tests passing.
- New store regressions load a pre-profile row, perform an accepted `guildTick`, and assert the repaired state is persisted. A second test covers a partial ledger and invalid avatar.
- `npm run sim -- --hours 8` completed before the storage-only migration. Its deterministic balance report is unchanged by this work.

## Blocked

- `git pull --ff-only` cannot run in this checkout because `master` has no configured upstream or remote. No pullable shared changes were available.

## Deviations

- The 8-hour balance run still reports that the adaptive `reader` wins both total XP and XP per decision at casual attention (1.06x over `banker`), so attention is not yet traded against efficiency at that cadence. This is a measured tuning candidate, not changed by a storage reliability task.
- Twice-a-day attention still sees near-zero guild interaction. The README defines guild request/Derby progress as deliberately presence-gated; changing it requires a design decision rather than an incidental fix.

## Blocked on you

- Nothing.

## Next

- If Emberfall remains active, run a scoped balance experiment for casual-attention band choice, with pinned seeds and simulator before/after output.
- Add a proper remote/upstream before expecting shared-checkout pull protection in this repository.
