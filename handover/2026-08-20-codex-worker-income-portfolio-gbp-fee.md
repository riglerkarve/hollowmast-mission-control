# Codex Worker — Income Portfolio GBP fee audit

## Built

- No product code changed. Started the required independent review and non-USD artefact audit for PrintProfit.

## Verified

- `node ../mission-control/tools/cross-review.cjs 7041baa --repo income-portfolio --author "Architect" --dry` identified the author engine as Claude and the reviewer as Codex, so an independent review is permitted. The dry run did not record a review.
- Read the committed `product/pricing-spreadsheet/dist/PrintProfit-Pro-Pricing-Spreadsheet-GBP.xlsx` directly with `openpyxl`, not the generator. Its `Settings` rows contain `Etsy (UK)` marketplace fee `0.0682`, flat fee `0.36`, and payment fee `0.04`; its Offsite Ads row contains `0.2182`.
- Official Etsy UK sources checked on 2026-08-20 state a 6.5% transaction fee, 4% + £0.20 payment processing, a £0.16 listing fee, and a 0.48% UK Regulatory Operating fee: https://www.etsy.com/in-en/sell and https://help.etsy.com/hc/en-gb/articles/1500011073202-What-is-a-Regulatory-Operating-Fee
- Therefore the marketplace component should be 6.98% (`0.065 + 0.0048`), not 6.82% (`0.065 + 0.0032`); the matching Offsite Ads row should be 21.98%, not 21.82%. The flat £0.36 and 4% payment entries agree with the stated components.

## Blocked

- This is a pre-existing money-math discrepancy in a committed, publicly sold GBP edition. Per the workspace rule, I stopped at the finding and did not alter the spreadsheet generator, artefact, calculator, listing, or any live product.
- eBay’s business fee varies by category, so the generic `eBay (UK, business)` preset cannot be confirmed from a single official rate without a declared product category. Stripe UK’s 1.5% + £0.20 standard-card rate matches the workbook; PayPal has no calculator preset to compare.

## Candidates

- `scripts/check-delivered-xlsx.cjs` was invoked on the committed GBP file. It printed the file header but did not emit its required pass/fail/could-not-check conclusion before returning; that should be reproduced separately before relying on it for the GBP edition.

## Blocked on you


## Next

- Assign a scoped correction that updates the current UK Etsy regulatory fee in the generator, regenerates GBP artefacts, and verifies a freshly downloaded Payhip GBP delivery file against the official fee schedule before any promotion relies on its suggested prices.
