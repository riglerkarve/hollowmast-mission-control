# Codex Worker - Universal Credit statement import check

## Verified

- Located 68 scanned Universal Credit statements at
  `C:\Users\jcwhi\OneDrive\Desktop\UC`, covering July 2021 through August 2026.
- Installed Tesseract locally after approval because the PDFs have no extractable text layer.
  A local dry OCR of the August 2026 statement read the payment schedule without uploading any
  statement content.
- Read the existing finance ledger deterministically. It already contains 134 DWP/Universal
  Credit credits in `starling-personal`, including the same split-payment pattern that the
  statements show.

## Deliberate non-write

- Did not insert Universal Credit statement payments as finance transactions. They are the
  same cash movements already recorded from the bank; importing them again would double-count
  income. The August statement's 25 August payment was still future-dated on 22 August, so it
  is not an actual bank transaction either.
- Did not add a second statement/provenance table: that would be a new finance data surface and
  needs architectural sequencing. The requested payments are already represented by the
  existing ledger, which is the current source of truth.

## Blocked on you

- None.
