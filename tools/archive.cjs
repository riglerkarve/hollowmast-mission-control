#!/usr/bin/env node
//
// archive.cjs — copy a superseded file to _archive, verify it, and only then, in a LATER
// run, remove the original. Backlog #8.
//
//   node tools/archive.cjs                          list candidates, touch nothing
//   node tools/archive.cjs --stage <file> [...]     copy + verify. Originals stay.
//   node tools/archive.cjs --sweep                  remove originals that are VERIFIED archived
//   node tools/archive.cjs --sweep --apply          actually remove them
//
// ------------------------------------------------------------------------------------
// THE RULE, FROM THE BACKLOG ITEM ITSELF: never move a file in the same run that reads it.
// Copy, verify the copy, then remove.
//
// It is two runs on purpose, and the gap is the whole safety property. A copy-then-delete
// inside one process looks careful and is not: if the write is buffered, the disk is full,
// the path is wrong, or the process dies between the two calls, the delete still happens
// and the only copy is the one that failed. Staging and sweeping as separate invocations
// means the original outlives any single failure, and the sweep can insist on evidence that
// was written by an earlier, completed run.
//
// The evidence is a SHA-256 of both files, compared byte-for-byte before anything is
// removed — not a size check, not an mtime. Matching sizes are not matching bytes.
// ------------------------------------------------------------------------------------
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');            // the workspace
const ARCHIVE = path.join(ROOT, '_archive');
const MANIFEST = path.join(ARCHIVE, 'staged.jsonl');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

const sha256 = (f) => {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(f));
  return h.digest('hex');
};

const readManifest = () => (fs.existsSync(MANIFEST)
  ? fs.readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

// ---------------------------------------------------------------------------- candidates
// Groups files that look like versions of one document: same leading words, different
// trailing date or revision. It SUGGESTS and never acts — deciding which version is
// superseded is a judgement about content, and this file does not make it.
function candidates() {
  const dirs = [ROOT, path.join(os.homedir(), 'OneDrive', 'Desktop')];
  const groups = new Map();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;

      // Strip a trailing date, "rev N", or an ALL-CAPS marker to find the shared stem.
      const stem = name
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
        .replace(/\brev\s*\d+\b/gi, '')
        .replace(/\b(MERGED|ANALYSIS|FINAL|COPY|OLD|BACKUP)\b/g, '')
        .replace(/[-_\s]+/g, ' ')
        .trim()
        .toLowerCase();
      if (!stem) continue;

      if (!groups.has(stem)) groups.set(stem, []);
      groups.get(stem).push({ full, name, dir, size: st.size, mtime: st.mtime });
    }
  }

  return [...groups.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([stem, files]) => ({ stem, files: files.sort((a, b) => b.mtime - a.mtime) }));
}

// ---------------------------------------------------------------------------- stage
function stage(files) {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const staged = readManifest();

  for (const f of files) {
    const src = path.resolve(f);
    if (!fs.existsSync(src)) { console.error(`  MISSING  ${src}`); continue; }

    const base = path.basename(src);
    const dest = path.join(ARCHIVE, base);
    if (fs.existsSync(dest) && sha256(dest) !== sha256(src)) {
      // Never overwrite a different file that happens to share a name.
      console.error(`  REFUSED  ${base} — a DIFFERENT file of that name is already archived`);
      continue;
    }

    fs.copyFileSync(src, dest);

    // Verify by hashing BOTH, after the write. A size match is not a byte match.
    const a = sha256(src);
    const b = sha256(dest);
    if (a !== b) {
      fs.unlinkSync(dest);
      console.error(`  FAILED   ${base} — copy does not match, archive copy removed`);
      continue;
    }

    staged.push({ src, dest, sha256: a, bytes: fs.statSync(src).size, stagedAt: new Date().toISOString() });
    console.log(`  staged   ${base}  (${a.slice(0, 12)}…)  ORIGINAL LEFT IN PLACE`);
  }

  fs.writeFileSync(MANIFEST, staged.map((s) => JSON.stringify(s)).join('\n') + '\n');
  console.log(`\n${files.length} file(s) considered. Originals are untouched.`);
  console.log('Run --sweep in a SEPARATE run to remove originals that still verify.');
}

// ---------------------------------------------------------------------------- sweep
function sweep() {
  const staged = readManifest();
  if (!staged.length) { console.log('Nothing staged. Run --stage <file> first.'); return; }

  let removable = 0;
  for (const s of staged) {
    const hasSrc = fs.existsSync(s.src);
    const hasDest = fs.existsSync(s.dest);

    if (!hasSrc) { console.log(`  done     ${path.basename(s.src)} — original already gone`); continue; }
    if (!hasDest) { console.log(`  BLOCKED  ${path.basename(s.src)} — archive copy is MISSING`); continue; }

    // Re-verify at sweep time, not just at stage time. The archive copy may have been
    // touched, and the original may have CHANGED since it was staged — in which case the
    // archived version is not this file any more and removing it would lose the edit.
    const nowSrc = sha256(s.src);
    const nowDest = sha256(s.dest);

    if (nowSrc !== s.sha256) { console.log(`  BLOCKED  ${path.basename(s.src)} — original CHANGED since staging`); continue; }
    if (nowDest !== s.sha256) { console.log(`  BLOCKED  ${path.basename(s.src)} — archive copy does not match what was staged`); continue; }

    removable++;
    if (APPLY) {
      fs.unlinkSync(s.src);
      console.log(`  REMOVED  ${path.basename(s.src)} — verified copy in _archive`);
    } else {
      console.log(`  would remove  ${path.basename(s.src)} — both hashes still match`);
    }
  }

  if (!APPLY) console.log(`\n${removable} file(s) would be removed. Re-run with --apply to do it.`);
}

// ---------------------------------------------------------------------------- cli
const stageIdx = args.indexOf('--stage');
if (stageIdx >= 0) {
  const files = args.slice(stageIdx + 1).filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('--stage needs at least one file'); process.exit(2); }
  stage(files);
} else if (args.includes('--sweep')) {
  sweep();
} else {
  const groups = candidates();
  console.log('POSSIBLE VERSION GROUPS — suggestions only, nothing is touched.\n');
  if (!groups.length) console.log('  No filename groups that look like versions of one document.');
  for (const g of groups) {
    console.log(`  "${g.stem}"`);
    g.files.forEach((f, i) => {
      console.log(`     ${i === 0 ? 'newest ' : '       '} ${String(f.size).padStart(8)} bytes  ${f.mtime.toISOString().slice(0, 16).replace('T', ' ')}  ${f.name}`);
    });
    console.log('');
  }
  console.log('Which of these is superseded is a judgement about CONTENT, and this tool does');
  console.log('not make it. Pass the ones you mean to --stage.');
}
