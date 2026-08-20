# Codex Worker — claimed backlog and M130 audit stop

## Built

- Claimed M127, M130, M131, M132, M133, M134, and M136 under `CODEX` in the central backlog, as requested. M130 was the only item marked in progress while its bounded audit began; it is now returned to `open` while remaining claimed, because the audit found a pre-existing correctness conflict that must not be fixed blindly.

## Verified

- M130 located the actual PrintProfit calculator at `income-portfolio/tools/print-cost-calculator/`; the Pages deploy workflow copies that exact file to the delivered `/tool/index.html` artefact.
- A read-only run of `node scripts/price-link.cjs` reported its actual defaults: `$0.17/kWh` and `8%` failure allowance, with default result `$8.44` true cost and `$21.94` suggested Etsy price.
- Direct source reads confirmed the same defaults in both the delivered calculator (`index.html`: inputs at lines 164 and 178) and the companion CLI (`scripts/price-link.cjs`: defaults at lines 43–44).
- The validated M125 research instead specifies `$0.18/kWh` (lines 36/91/107) and a user-adjustable failure/waste default of approximately `10%` (line 94). Its Etsy US schedule is otherwise matched by the calculator: 6.5% transaction + 3% processing + $0.45 fixed.

## Blocked

- **Confirmed M130 conflict:** the public calculator, the command-line link generator, content examples, share links, and the paid spreadsheet sample are coupled around the old `$0.17` / `8%` defaults. Changing only the calculator would break the documented calculator/spreadsheet agreement; changing all of them needs a single scoped artefact update and a rebuild/recalculation of the paid workbook. This check did not cause the mismatch.
- Per the unattended-week rule, implementation stopped at this pre-existing failed audit result. No public calculator, paid spreadsheet, or live database data was modified.

## Deviations

- The first `rg` command in the audit had an invalid shell-escaped regular expression; it was a command construction error, corrected immediately, and not evidence about the product. The repeated read-only query produced the findings above.

## Blocked on you

- None. The next action is an engineering consistency pass, not an owner decision: update all coupled defaults from M125, regenerate the workbook/site artefacts, and independently verify the delivered calculator and spreadsheet values.

## Next

- Resume with a scoped M130 correction: make the M125 defaults canonical in calculator/CLI/content/product samples, add a delivered-artifact preset checker, rebuild the site and spreadsheet, and report every changed example value. Only after that should M133/M131–M136 begin.
