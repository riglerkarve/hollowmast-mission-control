<!--
M125 (Mission Control backlog) -- "Research the viability of 3D printing for profit at home".
Provenance, because it matters for how much to trust this file:

  1. First draft: gpt-oss:20b-cloud via tools/ollama-cloud-research.ps1. The generation stream
     died mid-response; the harness misreported that as a success (team_decisions #29/#30).
  2. Second draft: qwen3.5:4b (local), same script. Produced a real file this time, but read
     critically it contained an internal math error (labour cost didn't match its own stated
     inputs) and several precise-sounding statistics with no real source, stated with false
     confidence.
  3. This file: a dedicated research pass with real web access, tasked specifically with
     checking or replacing every shaky claim from the second draft -- verifying electricity/
     filament/Etsy-fee figures against real sources with shown arithmetic, and explicitly
     flagging what could not be verified rather than repeating unsourced numbers.

Read the "Sources Checked" and "Could Not Verify" sections at the end before treating anything
above them as settled. The core profitability question -- is this actually worth doing -- has
no rigorous public evidence behind it; this file says so rather than manufacturing certainty.
-->

# Profitable Home 3D Printing: A Validated 2026 Reality Check

**Executive finding:** The verifiable cost inputs (electricity, filament, Etsy fees) are all
lower or more moderate than the first draft claimed, worked below. The profitability *question*
itself — can a hobbyist realistically earn meaningful side income doing this — has almost no
rigorous public evidence behind it. Most search results with precise-sounding answers are
unsourced content-marketing, not data, and this brief says so rather than repeating the number.

---

## Real Costs Per Print: Worked, Not Asserted

**Electricity.** Wattmeter measurements put open-frame printers (Ender 3-class, Prusa MK4) at
100–150W average while printing, and enclosed/chamber-heated printers (Bambu X1 Carbon) at
200–250W; heating spikes exceed 300W but aren't the sustained draw. EIA's 2026 residential
average is close to **$0.18/kWh** (17.9–18.8¢ across sources this year). An 8-hour print at a
representative 150W: 0.15kW × 8h = 1.2 kWh × $0.18 = **~$0.22**. Across the printer range, that's
**$0.14–$0.36 per 8-hour print** — not the draft's $0.60–$1.20, which implied a 400W sustained
draw closer to a heating spike than a typical average.

**Filament.** PLA runs **$15–22/kg** in 2026 (median ~$20/kg); PETG is now comparable, sometimes
cheaper. Waste/failure evidence is thinner than the draft implied: one genuine academic source
(ScienceDirect, "Causes of Desktop FDM Fabrication Failures in an Open Studio Environment," 2019)
measured 41.1% failures — among novice users on shared university equipment, a poor proxy for a
motivated seller on their own tuned machine. Beyond that, only non-academic aggregator sites
report experience-tiered rates (beginner 15–25%, intermediate 8–15%, advanced 3–8%), uncited.
No reliable population-level figure exists for "typical waste %." The draft's flat "30%+" is
unsupported; treat any number here as an estimate.

**Labor.** Fixing the draft's own arithmetic: 3 hours printing + double that (6 hours) finishing
= 9 hours. At $15/hour that's **$135**, not the $145 stated — the draft's own numbers don't
produce $145 under any reading. A plain multiplication error, not a sourcing problem.

**Marketplace fees (Etsy, US, cross-checked against Etsy's own help-center/handbook pages and a
fee guide that quotes Etsy's schedule directly — the `legal/fees` page itself blocked automated
fetching, see below):** $0.20 listing fee, 6.5% transaction fee on item price + shipping, and
3% + $0.25 payment processing via Etsy Payments — roughly **9.5% + $0.45 fixed per sale**, not the
draft's separate "PayPal 2.9%" line, which is stale (PayPal is now a funding option inside Etsy
Payments, not a second fee stack). There is no US "regulatory operating fee" — that's UK/EU-only.

---

## What The Draft Got Right, and What It Didn't Source

Scale, niche, and finishing quality as real profitability levers — that framing holds up. But
several *specific numbers* under those headings have no source anywhere in extensive searching:
the "3-to-1" competition ratio, the "60% to 85%" yield-from-supports claim, the 80/20
finishing-hours rule (a generic Pareto trope asserted as domain data), and the "$85–120 finished
vs. $30–40 raw" pricing spread. None should be presented as fact. "Etsy search volume analysis
points to saturation" is also unverified — no keyword analysis was run by the draft or this review.

## Is It Actually Profitable? The Honest Answer

No rigorous source — academic study, large-sample survey, verified financial disclosure —
quantifying typical hobbyist profitability was found. Results are dominated by SEO sites reusing
near-identical unsourced stats ("65% never break even," specific dollar ranges); one was fetched
directly and its central claim had no traceable citation. All3DP profiles *successful* sellers,
but that's survivorship bias, not a base rate. Scattered self-reports (a few hundred dollars from
casual selling; one claim of ~$8,000 revenue over 8 months treating it as a real business) are
unverified and skew toward people motivated to post.

**Reasonable inference, not a citation:** given the verified inputs above — materials ~$1–3 per
part, electricity $0.15–0.35 per 8-hour print, Etsy fees ~9.5% + $0.45/sale — a hobbyist who
doesn't price their own labor can look cash-positive on paper. Price finishing time at any real
hourly rate and break-even or a loss looks like the likely outcome for generic, low-differentiation
items. That's directionally consistent with the weakly-sourced "most side hustles don't clear real
profit" narrative above — but it's an inference from verified unit costs, not a sourced finding.

## Bottom Line for PrintProfit's Calculator

- Electricity: wattage × hours × $0.18/kWh; expose wattage as a user input (100–250W covers
  nearly all consumer FDM printers).
- Filament: price per gram from a $/kg input (~1.5–2.2¢/g), not a fixed "average part" cost.
- Failure/waste: user-adjustable %, default ~10% as a conservative estimate, clearly editable.
- Etsy fees: 6.5% transaction + 3% + $0.25 processing + $0.20 listing (US) — not a flat "9.4%."
- Labor: user input at their own hourly rate; multiply correctly (this brief's fix is the check).

---

## Sources Checked

- **FDM printer power draw:** community wattmeter data via Bambu Lab Community Forum
  (forum.bambulab.com), and cross-referenced summaries on Filamino, LayerMath, and Call3D
  covering Ender 3, Bambu A1/X1C, and general 50–250W FDM range.
- **US electricity rate:** EIA Electric Power Monthly figures as reported by
  electricityrateperkwh.com, SolarReviews, and ChooseEnergy for 2026 (range 17.9–18.8¢/kWh);
  used $0.18/kWh as a representative midpoint.
- **Etsy US fee schedule:** cross-checked via search snippets from Etsy's own help center
  (help.etsy.com, "What are the Fees and Taxes for Selling on Etsy") and Etsy's Seller Handbook
  pricing pages, plus Craftybase's fee guide, which itself cites Etsy's published numbers. A
  direct fetch of etsy.com/legal/fees/ returned HTTP 403 (blocked), so this is verification via
  secondary sources quoting Etsy, not a first-hand read of Etsy's own page — noted below.
- **PLA/PETG pricing:** filamentpricetracker.com, 3dprintingcostcalculator.com, and spoolmath.com
  2026 price aggregators.
- **Failure rates:** ScienceDirect, "Causes of Desktop FDM Fabrication Failures in an Open Studio
  Environment" (academic, 2019, 41.1% failure in a shared-makerspace/novice-user setting);
  several non-academic aggregator sites (3dprinterly.com, print-calc.com) for anecdotal
  experience-tiered rates.
- **Profitability landscape:** direct fetch of layermath.com's profitability article to check its
  citation trail for a specific stat (found none); broader search across Reddit, All3DP, Shopify,
  and Payhip content for real-world figures (found scattered, unverified self-reports, no survey).

## Could Not Verify

- **Etsy's own fee page directly** — blocked (403 Forbidden) on automated fetch; relied on
  secondary sources that quote it.
- **Any rigorous, representative statistic on typical home-seller profitability, waste rate, or
  competitive saturation.** Nothing indexed and searchable meets that bar; the space is
  dominated by unsourced content-marketing repeating similar-sounding numbers.
- **The original draft's 3-to-1 competition ratio, 60–85% yield-from-supports claim, 80/20
  finishing-hours rule, and $85–120-vs-$30–40 finished/raw pricing spread** — no source found for
  any of these anywhere in an extensive search. Recommend treating as unsupported and not
  reusing them in published material.
- **"Etsy search volume analysis points to saturation"** — neither this review nor the original
  draft actually ran a keyword/search-volume analysis; the claim remains unverified in both.
- **The specific "3,000 print-hours / $3,666 revenue over 8 months" and "65% never break even /
  10% profit" figures** surfaced during research — both trace back to a single content-marketing
  site's self-reported, non-methodological "anonymised" data. Not reliable enough to cite as fact;
  included above only as an illustration of the weak state of public evidence on this question.
