# Income Portfolio — CP counts and reply-kit arithmetic

## Built

No product or marketing files changed. No account, campaign, community, or publishing action was
taken.

## Verified

Read-only fetch of the live guide index returned HTTP 200. It has six distinct guide article
paths (the other two guide links are the index itself in relative and absolute form):

```text
best-budget-3d-printers-print-business-2026
cost-to-run-3d-printer-per-hour
etsy-fees-3d-prints
hidden-costs-3d-printing-business
how-to-price-3d-prints
is-selling-3d-prints-profitable
```

CP-4 is therefore unchanged: six posts, below the stated ~15–25 post AdSense threshold.

Read-only fetch of deployed `data/metrics.json` reported:

```text
updated=2026-08-16
series_rows=1
cloudflare_status=pending-setup
cloudflare_manual=False
tool_visits_total=0
site_visits_total=0
```

CP-2 remains deliberately deferred. There is no confirmed real-visitor measurement; these zeros
are unmeasured, not evidence that no one visited. Nothing supports opening an Associates account
or starting its 180-day / three-sale clock.

For held reply-kit drafts #3–#7, ran the calculator CLI on every parameterised example and its
self-test:

```text
#3 Stripe: true cost $10.81; 50% price $23.60
#4 Etsy:   true cost $11.46; 50% price $29.41
#5 whistle true cost $0.29; $0.50 sale gives ~42% margin
#5 Pikachu true cost $5.59; cash 50% price $11.18 ("~$11")
#6 bracket true cost $4.93
selftest OK: dragon cost 8.25 -> price 21.48 -> 50.0%
```

The reply-kit numbers match the current `scripts/price-link.cjs` rounding. Draft #7's revenue,
order, and seasonality figures are thread facts rather than calculator outputs, so were not
recomputed here.

## Blocked

Nothing new in this block.

## Deviations / Candidates

None.

## Blocked on you

Nothing.

## Next

Independent planned work is exhausted or already recorded as blocked: the spreadsheet
cross-review needs a recorded author engine; CP-6 fresh-artifact verification has its recorded
marker failure; and live Cloudflare import needs `CF_API_TOKEN` plus validation of the shipped
beacon identifier. Do not post reply-kit drafts from an agent session.
