# Codex Worker — M147 safety-ceiling verification

## Built

No code was changed. M147 was claimed by CODEX, verified, recorded on the board, and closed as a completed verification task.

## Verified

**Result: the safety module does not support per-venture ceilings.**

Reproduction (read-only; no test opened or wrote `data/dashboard.db`):

```powershell
Get-Content server/routes/safety.js
Get-Content ../dropshipping/CLAUDE.md
Get-Content ../print-shop/CLAUDE.md
```

- `safety_limits` has only `per_transaction_pence` and `per_month_pence` keys.
- `check({ amountPence, payee, action, askedBy })` has no venture/project argument.
- `authorisedThisMonth()` sums every allowed decision into one global monthly amount.
- Both project briefs require a ceiling before the first purchase.

The global guard still fails closed correctly, but one venture's permitted spend would consume the same monthly ceiling as the other's. It cannot express independent ceilings.

The board note is `todo_notes` #210 on M147. M147 is marked done because the requested verification has a definite result.

## Blocked

The unattended-week plan requires stopping when a check uncovers a failure not caused by this session. This pre-existing capability gap is therefore recorded, not fixed or worked around. Supporting venture ceilings would require a deliberately scoped data/API/UI design, not a silent extension of this audit.

## Deviations

M143, M146, M150, and M105 were claimed for the same batch but were not started after this finding. They remain open and owned by CODEX for a future resumed block.

## Blocked on you

None.

## Next

Have the supervisor/architect decide whether the safety guard needs a venture identifier and separate per-venture monthly/transaction limits before either venture's first purchase. Resume the claimed items only after that stop condition is cleared.
