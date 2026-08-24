# M142 — proving backup restore against a genuinely separate location

Owner request, 23 Aug (quiz round 3, 20 Aug): the existing restore tooling
(`tools/restore-backup.cjs`) only proves a backup is *readable* — it copies the
newest snapshot into a temp folder on THIS machine and diffs it read-only
against the live database. That proves "the file isn't corrupt", not "this
machine is gone and I can get back up". This document proves the second claim,
using only what would exist if this laptop's disk failed today.

## What "off this machine" actually means here

Per `scripts/backup.js` and `data/backup-extra.txt`, exactly one destination
survives the disk dying: `C:/Users/jcwhi/OneDrive/MissionControl-Backups`,
which OneDrive syncs to Microsoft's servers. Everything else
(`mission-control/backups/`, `../../MissionControl-Backups`) is still on the
single fixed drive (`Get-CimInstance Win32_LogicalDisk` reports one). The
database copy in the OneDrive folder is AES-256-GCM encrypted
(`tools/backup-crypt.cjs`); the passphrase lives in `data/backup-key.txt`,
which is gitignored and — per the tool's own design note — is required to
ALSO exist somewhere off this disk (password manager / paper note), because
if the only copy of the key is on the dying disk, encryption converts a
recoverable loss into an unrecoverable one.

So a real restore needs exactly two off-machine artifacts:
1. `dashboard-<stamp>.db.enc` from the OneDrive folder (the data)
2. `mission-control-<stamp>.bundle` from the OneDrive folder (the code/history — the
   git bundle also gets copied into the OneDrive destination since
   `scripts/backup.js` iterates all `DESTS` for both the db and the bundle)
3. The passphrase, recovered from wherever the owner stored it off-disk (a
   password manager, in practice — not from this laptop)

## What was actually tested, 24 Aug 2026

Ran on this machine but treating it as if it were a brand new machine: no
step touched `mission-control/`, `mission-control/backups/`, or
`mission-control/data/` after the initial two files were copied out.

1. Copied the newest `.db.enc` and `.bundle` from `C:/Users/jcwhi/OneDrive/MissionControl-Backups`
   into a scratch folder (`disaster-test-20260824-010127`), simulating "this is
   all I have left, retrieved from the cloud onto new hardware".
2. `git clone mission-control.bundle mission-control-restored` — reconstructed
   the full source tree and commit history from the bundle alone. No git remote,
   no reference to the original working tree.
3. Typed the passphrase (`RubyWhiteford2026`, the same value that lives in
   `data/backup-key.txt`, retrieved as if from a password manager) into a fresh
   `data/backup-key.txt` inside the reconstructed tree.
4. `node tools/backup-crypt.cjs decrypt <db.enc> data/dashboard.db` — decrypted
   using only that freshly-placed passphrase file. Succeeded (32,239,616 bytes).
5. `npm install` inside the reconstructed tree — 68 packages, clean.
6. Verified the decrypted database directly: `PRAGMA integrity_check` → `ok`,
   88 tables, `finance_transactions` = 6,839 rows (matches the live count
   documented in `server/routes/garage.js`), `gmail_messages` = 69,237 rows.
7. Booted the actual server (`node server/index.js`) against the reconstructed
   tree + decrypted database on a scratch port. `GET /` returned 200 and served
   real application HTML (the board sources panel, HOLLOWMAST bug counts, etc.)
   — not just a readable file, a running application.
8. Killed the process, no writes were made back to the original repo, backups/,
   or data/ at any point.

## Result

PASS. A restore onto a genuinely separate location (no code, no data, only
what OneDrive holds plus the passphrase from wherever it's stored off-disk) was
proven to reconstruct a fully working Mission Control instance: correct code
at the correct commit, all 88 tables intact, transaction count matching, and
the live server actually serving requests from the restored data.

## What this does NOT prove, honestly stated

- **Not tested on a different physical machine.** This ran on the same laptop,
  deliberately avoiding every path that only exists on this disk. That is a
  faithful proxy for "if this disk died and I set up a new machine with
  OneDrive synced", but it is not literally a second machine. To close that
  last gap: on any other machine with Node.js and OneDrive (or a manual
  download of the two files) installed, run the same 4 commands
  (`git clone <bundle> <dir>`, place the passphrase, `backup-crypt.cjs
  decrypt`, `npm install && node server/index.js`). Nothing above depends on
  this machine's registry, PATH, or installed software beyond Node — no native
  modules outside `node:sqlite` (built-in) and `express` (installed via npm).
- **Depends on the passphrase actually being off-disk.** This is a process
  fact, not a code fact: `data/backup-key.txt` says to store it in a password
  manager, but nothing here can verify the owner did that. If the passphrase
  only lives on this laptop, the encrypted OneDrive copy is exactly the
  "30 MB file nobody alive can open" scenario `backup-crypt.cjs` warns about.
- **OneDrive sync itself was not verified end-to-end** (i.e. did not confirm
  from a second device that the OneDrive folder actually has cloud copies
  rather than just a local sync client that hasn't uploaded yet). Checking
  the OneDrive web UI (onedrive.com) for these files would close this gap in
  under a minute.

## Scratch artifacts

The test ran in `C:/Users/jcwhi/disaster-test-20260824-010127` (outside the
repo). It was NOT deleted automatically (recursive delete needs interactive
approval on this box); it's a self-contained folder safe to delete manually:
`rm -rf "C:/Users/jcwhi/disaster-test-20260824-010127"`.
