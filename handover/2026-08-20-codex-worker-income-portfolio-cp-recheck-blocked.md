# Income Portfolio — fresh deploy-artifact re-check stopped

## Built

No product source files changed. `npm run build` regenerated the local Astro `dist/` successfully;
the Income Portfolio tracked worktree was clean afterwards.

The freshly built site was assembled into this temporary verification path to mirror the deploy
workflow (content `dist/`, calculator, dashboard, and metrics):

```text
C:\Users\jcwhi\AppData\Local\Temp\income-portfolio-cp-20260820-013746
```

## Verified

```text
npm run build
```

Completed successfully and reported **11 page(s) built**.

The combined-artifact marker check reported:

```text
content_pages=12 google_verification_pages=11 content_beacon_pages=11 tool_beacon=1 tool_token=1 draft_or_owner_markers=1
```

So the fresh 11 content pages contain the Google verification tag and Cloudflare beacon, and the
calculator contains its beacon and the expected public beacon token. However, the combined
artifact contains one `DRAFT` or `[Owner:` marker. CP-6 therefore cannot be claimed re-verified.

## Blocked

The fresh artifact check failed on the remaining `DRAFT`/`[Owner:` residue. Per the work rule,
I stopped here: I did not locate, edit, suppress, or work around that marker.

## Deviations / Candidates

While reading the delivered calculator beacon, I noticed it uses public site token
`273ea4c4d7fd49f8bf932114c654b919`; the newly added analytics importer's default was copied from
the task record's different site ID `22c0da83544c4442b3cb06a4cadabc12`. This is a candidate for
the next authorised review block, not a completed fix. The importer is already committed in
Income Portfolio commit `32aaa5e` and must not be run live until its actual query identifier is
validated against the delivered beacon/account.

## Blocked on you

Nothing.

## Next

Reproduce and locate the single CP-6 marker in the temporary assembled artifact, then let the
responsible session decide whether it is a production residue or an intentional static comment.
Only after that check passes should CP-6 be reported as re-verified. Independently validate the
analytics script's site identifier before a token-backed run.
