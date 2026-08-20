# Income Portfolio — improvement tasks M120–M124

## Built

Created five explicit backlog tasks: M120–M124.

Completed and marked done:

- **M120** — `scripts/cf-analytics.mjs` now reads the public Cloudflare beacon token from both
  shipped sources, requires them to agree, defaults to that token, and rejects a mismatched
  `CF_SITE_TAG` override. Commit `3b26a54`.
- **M121** — added `scripts/verify-deploy-artifact.mjs`. It mirrors the deploy layout in a
  disposable temp path and verifies 11 content routes, the CP-9 tag, matching CP-5 beacon token,
  and case-sensitive CP-6 `DRAFT` / `[Owner:` residue with exact file/line reporting. Commit
  `1ebc0bc`.
- **M123** — registered the documented `Claude Fable 5` identity as engine `claude` in the team
  roster. The mandated dry cross-review of `7041baa` now reports independence holds.
- **M124** — added `--help` and `--check-reply-kit` to `scripts/price-link.cjs`, backed by five
  unrounded reply-kit fixtures. Commit `099ff2f`.

Also fixed `tools/codex-run.cjs` so its required commit-only path guard accepts an exact file
inside a Git-reported untracked directory without widening what it commits. Commit `7ce82d0`.

## Verified

```text
node scripts/cf-analytics.mjs --stub
```

Uses shipped site tag `273ea4c4d7fd49f8bf932114c654b919`, makes no request and writes no metrics.
A deliberate stale `CF_SITE_TAG=22c0...` override is refused.

```text
node scripts/verify-deploy-artifact.mjs --assemble
```

Passed: 11 content index pages, matching calculator token, CP-5/CP-6/CP-9 all hold in the
assembled artifact. This corrects the earlier CP-6 alarm: the old PowerShell check was
case-insensitive and matched ordinary lowercase “drafts”; the case-sensitive production marker
check finds no `DRAFT` or `[Owner:` residue.

```text
node scripts/price-link.cjs --selftest
node scripts/price-link.cjs --check-reply-kit
```

Both pass; all five held parameterised reply examples match their unrounded expected values.

## Blocked

**M122 — regional fee presets** is not started because
`income-portfolio/product/pricing-spreadsheet/build_spreadsheet.py` is already modified by
another session in the shared checkout. The task has a backlog note recording this exact block.
No attempt was made to overwrite, merge, or commit around that file.

## Deviations / Candidates

The analytics importer is correctly tied to the shipped beacon now, but live Cloudflare querying
still requires `CF_API_TOKEN`; no token was invented, stored, or used.

## Blocked on you

Nothing.

## Next

Once the other session commits or clears `build_spreadsheet.py`, resume M122: independently
source regional fee schedules, change only the fee presets as evidenced, build the actual GBP
artifact, and verify it independently of the generator.
