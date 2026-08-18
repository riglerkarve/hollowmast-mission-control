// areas.cjs — is this file Mission Control, or the tool that measures Mission Control?
//
// The telemetry pipeline lives inside the repository it reports on, so without a
// split its own construction shows up as the cost of building the dashboard. It
// is not: it is meta-work, and it fails the project's own gate. Counting it is
// right; counting it as project work is not.
//
// Required by parse-session.cjs (per-prompt attribution, and the per-file edit
// and read split). Oxford AutoWorks also had scan-repo.cjs and render.cjs behind
// this rule; NEITHER EXISTS HERE — verified 18 Aug 2026, tools/telemetry/ holds
// exactly parse-session.cjs, config.json and this file. parse-session.cjs is the
// only consumer in this project, so `isTelemetry` and `emptyAreas` currently have
// no caller and are kept as the module's published shape, not as live code.
//
// Paths arrive normalised: forward slashes, relative to the project root, no
// leading "./". Anything outside the root is somebody's scratch file and is not
// this function's problem — callers exclude those before asking.
//
// -----------------------------------------------------------------------------
// RE-ROOTED FOR THIS PROJECT, 18 Aug 2026 (backlog #M18).
//
// This file was copied byte-identically from Oxford AutoWorks by #M16, and it
// still carried OXFORD'S paths: 'scripts/telemetry/', 'docs/telemetry/',
// '.claude/' and the file 'scripts/telemetry.ps1'. Measured against a frozen
// snapshot of all 13 workspace transcripts, ALL FOUR classified NOTHING — not one
// of those directories or files exists in this repo (checked with `test -e`, and
// `find . -name .claude` returns nothing under the project root; the workspace's
// .claude/ lives one level up, outside PROJECT_ROOT, so it can never reach this
// function at all). Four constants, zero matches: the split was inert, and both
// of this project's telemetry files were silently being counted as dashboard work.
// -----------------------------------------------------------------------------
'use strict';

const AREA_TELEMETRY = 'telemetry';
const AREA_PROJECT = 'project';

// Deliberately a literal list rather than a "does the path contain telemetry"
// test. A project file that happens to mention the word — a panel that displays
// telemetry to the owner, say, or server/routes/sessions.js which CONSUMES the
// parse — belongs to Mission Control, and a loose regex would quietly move it
// into the tool's column and inflate exactly the number this split exists to
// isolate. That is not hypothetical here: `grep -ril telemetry --include=*.js
// --include=*.cjs .` outside tools/telemetry/ matches SEVEN files —
// data/seed/backlog-2026-08-17.cjs, scripts/briefing.cjs, server/routes/garage.js,
// server/routes/sessions.js, server/routes/todo.js and
// tools/import-claude-sessions.cjs, which are product code, PLUS
// tools/telemetry.cjs, which is the driver and IS telemetry.
//
// That seventh file is the whole point rather than an exception to it: a name
// regex cannot separate "mentions telemetry" from "is telemetry", which is why
// the lists below are explicit paths. This comment said "six ... every one of
// them product code" until the verifier ran the command; the omitted file was
// the one the classification exists to catch.
const TELEMETRY_PREFIXES = [
  // The pipeline itself: parse-session.cjs, config.json, this file.
  'tools/telemetry/',
  // Its OUTPUT — sessions.json and ledger.jsonl. The analogue of Oxford's
  // 'docs/telemetry/', which held the rendered pages. The directory EXISTS
  // (checked, not assumed), and on the frozen snapshot it classifies ZERO paths:
  // nothing has yet been Read or Edited under it. It is here because reading the
  // parse output while debugging the parse is measuring-the-measurer, not because
  // it is currently doing work. If it is still at zero in a month, delete it
  // rather than let a dead constant sit here a second time.
  'data/telemetry/',
];
const TELEMETRY_FILES = [
  // The driver: resolves the transcripts, shells out to parse-session, strips the
  // composite score, writes the ledger. Oxford's equivalent was
  // 'scripts/telemetry.ps1'. NOT a prefix — 'tools/telemetry' as a prefix would
  // also swallow a future 'tools/telemetry-export.cjs' without anyone deciding it.
  'tools/telemetry.cjs',
];

// DELIBERATELY PROJECT, NOT TELEMETRY, and the call is worth stating because it
// is the one a future reader will want to overturn:
//
//   tools/import-claude-sessions.cjs   consumes data/telemetry/sessions.json
//   server/routes/sessions.js          serves what that importer wrote
//   public/panels/projects/            renders it
//
// All three are DOWNSTREAM of the measuring apparatus, not part of it. They
// derive something the owner opens — Claude's hours as focus sessions — so they
// pass the gate and are product. Only the pipeline that turns transcripts into
// numbers is meta-work. Moving these three would add, on the frozen snapshot,
// 2 edits + 0 reads (the importer), 5 edits + 1 read (the route) and 1 edit +
// 2 reads (the panel's .js and .css) to the telemetry column — 8 edits against
// the 4 the change below actually moves, i.e. it would more than double the
// bucket and start overstating the thing this file exists to bound.

function areaOf(relPath) {
  if (!relPath || typeof relPath !== 'string') return AREA_PROJECT;
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  for (const f of TELEMETRY_FILES) if (p === f) return AREA_TELEMETRY;
  for (const d of TELEMETRY_PREFIXES) if (p.startsWith(d)) return AREA_TELEMETRY;
  return AREA_PROJECT;
}

const isTelemetry = p => areaOf(p) === AREA_TELEMETRY;

// An empty pair of buckets, so every consumer accumulates the same shape.
const emptyAreas = () => ({
  [AREA_TELEMETRY]: { cost: 0, prompts: 0, edits: 0, reads: 0, files: 0 },
  [AREA_PROJECT]: { cost: 0, prompts: 0, edits: 0, reads: 0, files: 0 },
  unattributed: { cost: 0, prompts: 0, edits: 0, reads: 0, files: 0 },
});

module.exports = {
  AREA_TELEMETRY, AREA_PROJECT,
  TELEMETRY_PREFIXES, TELEMETRY_FILES,
  areaOf, isTelemetry, emptyAreas,
};
