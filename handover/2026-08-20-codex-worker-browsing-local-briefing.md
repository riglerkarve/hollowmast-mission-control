# Codex Worker — Browsing local briefing

## Built

- Added source-aware, domain-only daily browsing aggregates. The next browser import now
  supplies seven-day attention comparisons without retaining browser URLs or page titles.
- Added an explicit local news-topic list and a Browsing-panel briefing workflow.
- Added fixed public BBC News, Business, and Technology RSS intake, then a structured
  `qwen3.5:4b` local-model ranking. The model receives only owner-added topic labels and
  public RSS metadata; browsing domains and browsing aggregates are never in its prompt.
- Added visible, separate states for no topic, feed failure, and local-model failure. The
  paid-not-visited list now limits itself to active recurring services.

## Verified

- `node tools/verify-browsing-briefing.cjs` passed, including daily trends, RSS parsing,
  topic create/delete routes, and the no-topic briefing guard.
- The verifier used and removed this isolated path:
  `C:\Users\jcwhi\AppData\Local\Temp\mc-browsing-briefing-2aKx6p\browsing-briefing-test.db`.
  It did not open or write `data/dashboard.db`.
- `node --check` passed for the route, importer, and verifier; the Browsing client module
  imported successfully as ESM; `git diff --check` passed.

## Deviations

- Did not run a live browser import or build a live briefing during verification, because
  either would write live data or call live services. The feature is exercised with an
  isolated fixture instead.
- The user asked that all personal data stay local. The design is stricter: browsing data is
  not sent to any model automatically, even a local one. Topics are explicit local choices;
  only fixed public feeds are fetched over the network.

## Next

- Restart Mission Control when the other in-progress route work is ready, then run
  `node tools/import-browsing.cjs` once to backfill daily aggregate history.
- Add a topic in Browsing and use “Build local briefing”; inspect the displayed source links
  and local-model failure state before treating it as a routine briefing.

## Blocked on you

- None.
