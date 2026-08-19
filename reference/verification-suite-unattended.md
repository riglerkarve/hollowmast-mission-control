# Verification suite: unattended-run proposal

This is a proposal only. It creates no scheduled task.

Run `node tools/verify-suite.cjs` after the normal backup window, from a process that writes its console output to a dated log. The command runs only checks whose tests are constructed to keep writes out of `data/dashboard.db`; temporary-database tests print their own temporary paths.

Do not treat an exit code of zero as a global all-clear. It means every automatic check passed and the suite contract matched its baseline. The report always lists manual checks separately. They remain manual because they would otherwise write live state, depend on external services, or deliberately modify the shared working tree.

Before any scheduling decision:

1. Review every `MANUAL` reason and decide whether its side effect is acceptable in a scheduled context.
2. Keep the job non-overlapping. A second run while a temporary-database verifier is cleaning up makes a failure harder to interpret.
3. Alert on non-zero exit and retain the full output; do not auto-retry a failed verification.
4. Re-run `node tools/verify-suite.cjs --write-baseline --confirm-write` only after reviewing a deliberate check-set change. The baseline records coverage and safety classifications, not a snapshot of personal data.
