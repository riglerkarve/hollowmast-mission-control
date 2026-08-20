# Codex Worker — M153 Print Shop start decision

## Built

Started the newly registered **Print Shop** project with its mandated first deliverable, not an
unscoped build: [START-DECISION.md](../../print-shop/START-DECISION.md).

The brief provides:

- a no-spend first-niche decision process;
- UK-specific current electricity and Etsy fee placeholders, explicitly marked for recheck;
- separate cash-contribution and labour-priced-contribution calculations;
- a repeatability, commercial-IP and safety screen for any candidate; and
- the five unknowns that prevent a false niche choice (printer/equipment, actual tariff,
  capacity, channel and risk boundary).

No purchase, account, listing, customer promise or income claim was made.

## Verified

Read-only arithmetic check in `print-shop`:

```powershell
$rate = 0.2611
100,150,250 | ForEach-Object { (($_ / 1000.0) * 8) * $rate }
6.5 + 4 + 0.48
git diff --check
```

| 8-hour average draw | Electricity at £0.2611/kWh |
|---:|---:|
| 100W | £0.21 |
| 150W | £0.31 |
| 250W | £0.52 |

The percentage Etsy components total **10.98%** before fixed listing/processing fees and any
applicable VAT. `git diff --check` was clean.

Sources used are linked in the document: Ofgem's 1 July–30 September 2026 unit-rate page,
Etsy's UK fees, payment-processing and regulatory-operating-fee pages, GOV.UK digital-platform
selling guidance, and the validated M125 research. The document does not assert an unsourced
niche demand or profitability figure.

M153 is marked done on the board with `todo_notes` #215.

## Deviations

`print-shop/` has no project-local `AGENTS.md` or `README.md`; the project file is its
`CLAUDE.md`, and the workspace `AGENTS.md` remains the governing standard.

## Blocked

None for the completed decision-brief task. A specific niche must remain unselected until the
document's required equipment, tariff, capacity, sales-channel and risk inputs exist.

## Blocked on you

None.

## Next

When the five inputs are known, make one unlisted, non-safety-critical and commercially usable
test piece; record material, energy, time, weight and package size, then complete the two-readings
calculation before considering a listing or spend.
