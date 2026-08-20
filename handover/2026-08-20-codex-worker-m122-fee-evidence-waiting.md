# M122 — regional fee preset evidence gathered; shared generator still in flight

## Built

No files changed in Income Portfolio. The only outstanding task is M122.

## Verified

Read the other session's uncommitted diff, without editing it. It changes UK Etsy percentage
fees from 6.82% to 6.98% and Etsy+Offsite Ads from 21.82% to 21.98%.

Independently checked current first-party schedules:

- Etsy regulatory operating fee: United Kingdom **0.48%** —
  https://help.etsy.com/hc/en-us/articles/1500011073202-What-is-a-Regulatory-Operating-Fee
- Etsy transaction fee: **6.5%** —
  https://help.etsy.com/hc/en-gb/articles/115014483627-What-are-the-Fees-and-Taxes-for-Selling-on-Etsy
- UK Etsy Payments: **4% + £0.20** —
  https://help.etsy.com/hc/en-gb/articles/115015628847-What-are-Payment-Processing-Fees-for-Selling-on-Etsy
- Stripe UK standard cards: **1.5% + £0.20** —
  https://stripe.com/gb/pricing

The in-flight correction is therefore supported: `6.5% + 0.48% = 6.98%`; adding 15% Offsite
Ads gives 21.98%. Existing £0.36 flat cost (`£0.20` processing + about `£0.16` listing) and 4%
payment processing remain consistent with the cited fees.

## Blocked

`income-portfolio/product/pricing-spreadsheet/build_spreadsheet.py` remains modified by another
session after a 30-second recheck. It is the exact file M122 must change, so I did not edit,
stage, build from, or commit around it.

## Deviations / Candidates

No new candidate. eBay is category-dependent and must not be represented as a universally
verified single rate without a declared category.

## Blocked on you

Nothing.

## Next

Once the shared generator file is committed or clean, build the GBP spreadsheet, inspect the
delivered `.xlsx` directly (not through the generator), and mark M122 done only if its Etsy and
Offsite values are 6.98% and 21.98% respectively.
