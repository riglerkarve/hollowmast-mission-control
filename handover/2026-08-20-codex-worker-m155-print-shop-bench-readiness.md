# Codex Worker — Print Shop physical-venture block (M155)

## Built

The owner clarified that Print Shop is an **actual at-home 3D-printing income venture**, not a
calculator product. I discarded the uncommitted calculator prototype before it shipped and
redirected the block to the physical operation.

Created `print-shop/BENCH-READINESS.md`, a no-spend protocol for:

- identifying the actual printer, material, condition, connection and manual before any test;
- using only that printer's manufacturer-approved first test;
- retaining a failed first print as readiness evidence rather than hiding it; and
- recording one physical capture card (mass, material source, elapsed time, active labour,
  package, energy-measurement source and outcome) before any candidate product is considered.

M154 (calculator) was declined with board note #217 before completion. No calculator code was
committed. M155 is completed with board note #219.

## Verified

Read-only workstation inventory, retried with the required local-device access, reported:

```
Name: Microsoft Print to PDF
Driver: Microsoft Print To PDF
```

No recognisable Bambu, Prusa, Creality/Ender or USB-serial device was present. This is written
as **unknown, not no printer**: a physical printer could be off, networked or connected to a
different machine.

`git diff --check` passed for `print-shop`. A content check confirmed the protocol visibly names
the unknown state, no-printer stop, manufacturer-approved test, capture card, bench-tested gate,
and prohibition on creating an Etsy account.

No printer was powered, configured or repaired. No material was bought. No account, listing,
payment method, customer commitment, external order or income claim was made.

## Deviations

The user's “one hour” block was redirected during the block from calculator work to physical
venture groundwork. The completed deliverable reflects the clarification rather than preserving
an artifact that would have made Print Shop look like another software project.

## Blocked

The actual printer, if one exists, is not discoverable from this workstation. Its exact model,
manual, material availability and physical condition must be identified at the bench before a
first test can happen. This is a real-world input, not a gap a session should fill by guessing.

## Blocked on you

None.

## Next

At the physical bench, fill the identification record in `BENCH-READINESS.md`, then run only the
exact printer's manufacturer-recommended first test while present. Use the capture card to record
the outcome. That single real piece establishes whether the venture is bench-ready; it does not
yet select a product or authorise spending.
