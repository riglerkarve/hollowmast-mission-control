# Codex Worker — M114 architect-commit review (partial)

## Built

- No product code changed. Began the independent review of the 19 August Architect (Claude) commit sequence.

## Verified

- `GET /api/team/roster` identifies the `Architect` session as engine `claude`, so a Codex review is independent.
- The earlier independent handover had already reviewed commits `9518721`, `815dbec`, `4d5d949`, and `14a4886`; its P1 found the rules-first write bug in `tools/ollama-shift.cjs`.
- Reviewed the corrective commit `3aece425d41665f4260c0d85509b059786821402` (`Rules-first was inverted by one variable name -- found by Codex`). Its write path now correctly derives `ruled` from unlabelled `tail` rows and writes those before `modelTail`.

## Blocked

- Reproduced a P2 reporting defect in the corrective commit. The report defines `settled` from `known` rows that already have a kind, defines `tail` from unlabelled `rows`, then prints `settled.length / rows.length` as the percentage that “needed no model at all”. Those values describe different populations: the numerator is the oracle, while the claimed numerator should be rule-settleable unlabelled rows (`ruled`, currently computed only later inside `--apply`). The displayed percentage is therefore not the claimed coverage and can be arbitrarily misleading.
- Per the governing plan, I stopped at this pre-existing review finding and did not continue to the remaining Architect commits or M115.

## Deviations

- This was source/diff reproduction only; it did not invoke Ollama or run `ollama-shift` against `data/dashboard.db`.

## Blocked on you

## Next

- The owner of `tools/ollama-shift.cjs` should calculate the report’s rule-settleable unlabelled count before printing it, use that count as the numerator, and report the oracle separately. Independently review that correction before resuming the remaining M114 commits.
