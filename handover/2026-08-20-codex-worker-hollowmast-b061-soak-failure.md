# Codex Worker — HOLLOWMAST B061 soak failure

## Built

- No HOLLOWMAST source changed. This block attempted the documented B061 measurement only.

## Verified

- Started the stock command `node tools/soak.cjs --seeds 11,4242,90210 --days 70 --out <temporary>/long70.json`.
- The sole intended output path was `C:\Users\jcwhi\AppData\Local\Temp\hollowmast-b061-long70-3092f14f2aa9481bb5d4fdb82536a421\long70.json`. No project or dashboard database path was written.

## Blocked

- The soak ended during seed 11 after progress through day 5 and before its normal per-seed summary. It produced no fatal diagnostic and did not create the named `long70.json` report.
- Therefore no 70-day result exists from this run, and no claim about wins or towers is made from its partial progress. This is an unexplained check failure not caused by this block; I did not retry, change the harness, or continue to another experiment.

## Deviations

- The empty temporary directory is left under the named system-temporary location; there is no test artefact to inspect or reuse.

## Blocked on you


## Next

- Diagnose why `tools/soak.cjs` exits silently before it can write an output report, using a separately scoped reproduction. Only then re-run B061's 70-day, three-seed measurement.
