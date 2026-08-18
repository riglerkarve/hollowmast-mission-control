// areas.cjs — is this file the game, or the tool that measures the game?
//
// The telemetry pipeline lives inside the repository it reports on, so without a
// split its own construction shows up as the cost of building Oxford Autoworks.
// It is not: it is meta-work, and it fails the project's own gate. Counting it is
// right; counting it as game work is not.
//
// Required by parse-session.cjs (per-prompt attribution), scan-repo.cjs (file
// counts) and render.cjs (churn and reads), so one rule governs all of them.
//
// Paths arrive normalised: forward slashes, relative to the project root, no
// leading "./". Anything outside the root is somebody's scratch file and is not
// this function's problem — callers exclude those before asking.
'use strict';

const AREA_TELEMETRY = 'telemetry';
const AREA_PROJECT = 'project';

// Deliberately a literal list rather than a "does the path contain telemetry"
// test. A game file that happens to mention the word — a HUD that reports
// telemetry to the player, say — belongs to the game, and a loose regex would
// quietly move it into the tool's column and inflate exactly the number this
// split exists to isolate.
const TELEMETRY_PREFIXES = [
  'scripts/telemetry/',
  'docs/telemetry/',
  '.claude/',
];
const TELEMETRY_FILES = [
  'scripts/telemetry.ps1',
];

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
