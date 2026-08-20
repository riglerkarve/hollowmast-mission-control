# Income Portfolio — Cloudflare analytics credential wall

## Built

Added `income-portfolio/scripts/cf-analytics.mjs`, a zero-dependency importer for Cloudflare
Web Analytics page-load counts. It:

- queries the account-scoped GraphQL endpoint with the existing account and site IDs (both
  environment-overridable);
- separates `/profitprint/tool/` counts into `tool_visits` and all other paths into
  `site_visits`;
- preserves manual sales/revenue fields when merging daily rows;
- only marks the Cloudflare source live and writes `data/metrics.json` after a successful
  non-dry-run response; and
- includes `--stub`, which is permanently dry-run only and makes neither a network request
  nor a metrics write.

## Verified

```text
node scripts/cf-analytics.mjs --stub
```

Printed the built-in response classification:

```text
2026-08-18  tool_visits: 3  site_visits: 4
2026-08-19  tool_visits: 0  site_visits: 2
DRY RUN: data/metrics.json was not changed.
```

```text
node --check scripts/cf-analytics.mjs
git diff --check
```

Both exited 0. The real mode was also run with no token; it correctly stopped before a request
or write:

```text
BLOCKED: CF_API_TOKEN is not set. No request was sent and data/metrics.json was not changed.
```

## Blocked

`CF_API_TOKEN` is absent. A least-privilege token with Cloudflare **Account Analytics: Read**
is required to run the live pull. No token was invented, requested, or stored.

## Deviations / Candidates

The GraphQL request is dry-run-tested only; Cloudflare validates the account's exact schema,
site tag access, and live response when the required token is eventually supplied. Do not call
the stub result live analytics data.

## Blocked on you

Nothing.

## Next

When an authorised token exists, run the importer first with `--dry-run`, inspect its JSON
summary, then run without that flag to update `data/metrics.json`.
