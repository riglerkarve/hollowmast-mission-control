# Handover — M122 / M130 runtime blocker

## What I checked

- Claimed **M122** and **M130** for CODEX and marked both `in_progress` in the Mission Control board.
- Confirmed the prior shared-checkout blocker has cleared: `product/pricing-spreadsheet/build_spreadsheet.py` is clean.
- Audited the free calculator and CLI against M125. The live/default values are still `$0.17/kWh` and `8%` failure allowance; M125's stated defaults are `$0.18/kWh` and about `10%`. US Etsy components already agree: 6.5% transaction + 3% payment + $0.25 processing + $0.20 listing.
- Confirmed the current GBP spreadsheet preset expresses the current UK regulatory component: 6.5% + 0.48% regulatory, 4% + £0.20 processing, plus an approximately £0.16 converted listing fee (combined fee % `0.0698`, flat `0.36`, payment % `0.04`).
- `node scripts/price-link.cjs --selftest` passed.
- `node scripts/price-link.cjs --check-reply-kit` passed (5 fixtures).

## Blocker — do not work around

The required spreadsheet build/runtime is unavailable in this checkout: `python --version` returns PowerShell's **command not found** error. This is not a product failure and I did not modify any project files before it occurred. The next change needs to build the three workbook artefacts into a named temporary path and independently verify the regional constants in the buyer-facing GBP workbook; doing that without Python would violate the project rule against treating an unrun check as a pass.

No project files were changed and no `data/dashboard.db` path was touched.

## Resume

1. Restore the project Python runtime (or document the supported runtime path) with `openpyxl` available.
2. Add sourced fee constants and an independent generated-workbook check for the GBP Etsy preset; do not derive expected values from `build_spreadsheet.py`.
3. Make the calculator/CLI defaults `$0.18/kWh` and `10%`, keeping prefilled historical examples explicit.
4. Build to a named temporary output directory (not `data/dashboard.db`), run the current Node self-tests and reply-kit checks, and then commit this work as its own block.
