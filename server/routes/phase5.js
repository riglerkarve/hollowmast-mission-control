'use strict';
//
// phase5.js — HOLLOWMAST's Phase 5 commercial decision gate, collected in one place.
//
// GET /api/phase5 — returns { gate, criteria, minSample, notes }
//
// M148 (owner request 23 Aug, confirmed quiz round 4 20 Aug): Phase 5's conditions are
// scattered across the workspace CLAUDE.md, HOLLOWMAST's own LAUNCH.md, and several
// handovers. This route collects them into one place. IT DOES NOT DUPLICATE
// /api/launch-readiness, which is a mechanical build/bug/commit checklist for whether the
// game is fit to SHIP. This route is the separate, later question LAUNCH.md calls
// "Phase 5 — the decision gate (Week 9+)": once it has shipped and been played, should it
// go commercial? Different question, different criteria, different owner (only the owner
// decides this one; nothing here computes a verdict).
//
// LAUNCH.md ("Phase 5 — The decision gate") is the source of truth for the criteria text.
// A criterion is reported one of three ways, and the difference matters:
//   'measured'    — a live number was read just now (build files, git, a probed endpoint).
//   'pending'     — measurable in principle, but the input this route needs is missing
//                   (no admin key on file, no playtest run yet). Not a failure to look —
//                   the thing being measured has not happened yet.
//   'qualitative' — LAUNCH.md itself says this needs the owner's judgement (Discord being
//                   "active without you starting every conversation", people asking "can I
//                   buy this"). No amount of code answers these; the route says so rather
//                   than inventing a number.
//
// GATE STATUS reported here is the MINIMUM SAMPLE precondition only ("not evaluated before
// 100 sessions and 30 days of data" — LAUNCH.md's own words). It is not a go/no-go verdict.
// The commercial/free decision itself is the owner's, against evidence this route surfaces.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const router = express.Router();

const SURVIVE_DIR = 'C:/Users/jcwhi/Claude Outputs/Survive';
const REPO_ROOT = 'C:/Users/jcwhi/Claude Outputs';
const ADMIN_KEY_FILE = path.join(__dirname, '..', '..', 'data', 'reports-admin-key.txt');
const REPORTS_SUMMARY_URL = 'https://reports.hollowmast.com/summary';
const PLAYTEST_DIR = path.join(SURVIVE_DIR, 'playtest');
// LAUNCH.md, "The minimum sample": not evaluated before 100 sessions and 30 days of data.
const MIN_SESSIONS = 100;
const MIN_DAYS = 30;
// LAUNCH.md "Go commercial if" — median session over 20 minutes.
const MEDIAN_TARGET_SEC = 20 * 60;

// ---- read the admin key, if the owner has saved one ------------------------
function readAdminKey() {
  try {
    if (!fs.existsSync(ADMIN_KEY_FILE)) return null;
    const key = fs.readFileSync(ADMIN_KEY_FILE, 'utf8').trim();
    return key || null;
  } catch (e) {
    return null;
  }
}

// ---- telemetry: sessions, median playtime, schema, from the live worker ----
// Live network call, 5s timeout. Absence (no key, unreachable, non-200) is reported as
// 'pending' with a reason, never as a thrown error — the route always resolves.
async function readTelemetrySummary() {
  const key = readAdminKey();
  if (!key) {
    return { available: false, why: 'No admin key on file at data/reports-admin-key.txt. '
      + 'See tools/owner-setup-stats-codex.ps1 for how to get it from the Cloudflare dashboard.' };
  }
  try {
    const ctl = AbortSignal.timeout(5000);
    const res = await fetch(`${REPORTS_SUMMARY_URL}?key=${encodeURIComponent(key)}`, { signal: ctl });
    if (!res.ok) {
      return { available: false, why: `reports.hollowmast.com/summary answered ${res.status} — `
        + (res.status === 403 ? 'the saved key is wrong or has been rotated.' : 'not 200.') };
    }
    const data = await res.json();
    return { available: true, data };
  } catch (e) {
    return { available: false, why: `Could not reach reports.hollowmast.com: ${String(e.message || e).split('\n')[0]}` };
  }
}

// ---- repo visibility, from git ----------------------------------------------
// LAUNCH.md Phase 2: "Public or private is your call... decide at the Phase 5 gate." This
// is reported as a current fact, not a pass/fail — visibility is the owner's decision to
// make AT this gate, not a precondition of reaching it. gh is used because origin is a
// GitHub remote; if gh is missing or not authed, the state is reported as unknown rather
// than guessed.
function readRepoVisibility() {
  try {
    const out = execSync('gh repo view --json visibility,nameWithOwner', {
      cwd: SURVIVE_DIR, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 8000,
    }).trim();
    const parsed = JSON.parse(out);
    return { known: true, visibility: parsed.visibility, repo: parsed.nameWithOwner };
  } catch (e) {
    return { known: false, why: 'Could not read repo visibility via gh — gh missing, not authenticated, or no network.' };
  }
}

// ---- human playtest capture folders on disk ---------------------------------
// DESIGN.md: "no human playtest data has ever existed" as of 23 Aug. DEPLOY.md: the
// scheduled human playtest is Thursday 27 Aug, deploy after. This counts what
// docs/PLAYTEST.md's capture mechanism has actually written to playtest/, excluding the
// folder deliberately named _SYNTHETIC-not-a-real-playtest (a fabricated sample used only
// to validate the report tooling — counting it as real evidence would be exactly the
// failure that folder's name exists to prevent).
function readPlaytestCaptures() {
  try {
    if (!fs.existsSync(PLAYTEST_DIR)) return { exists: false, folders: 0 };
    const entries = fs.readdirSync(PLAYTEST_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_SYNTHETIC') && e.name !== 'session');
    return { exists: true, folders: entries.length, names: entries.map((e) => e.name).sort() };
  } catch (e) {
    return { exists: false, folders: 0, error: String(e.message || e).split('\n')[0] };
  }
}

// ---- route -------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const telemetry = await readTelemetrySummary();
    const repoVis = readRepoVisibility();
    const playtest = readPlaytestCaptures();

    const criteria = [];

    // 1. Minimum sample — the precondition before the gate is even evaluated.
    if (telemetry.available) {
      const sessions = telemetry.data.sessions || 0;
      const met = sessions >= MIN_SESSIONS;
      criteria.push({
        id: 'min-sample',
        name: `Minimum sample — ${MIN_SESSIONS} sessions and ${MIN_DAYS} days of data`,
        type: 'measured',
        met,
        detail: `${sessions} session${sessions === 1 ? '' : 's'} recorded. `
          + (met ? 'Sample size is met.' : `Below ${MIN_SESSIONS} — the gate stays shut, and that is the rule working, not a delay.`)
          + ' (Days-of-data is not yet tracked by reports.hollowmast.com/summary — it has no first-report timestamp — so only the session count is measured here.)',
      });
    } else {
      criteria.push({
        id: 'min-sample', name: `Minimum sample — ${MIN_SESSIONS} sessions and ${MIN_DAYS} days of data`,
        type: 'pending', met: null, detail: telemetry.why,
      });
    }

    // 2. Median session over 20 minutes.
    if (telemetry.available) {
      const median = telemetry.data.medianPlaytimeSec || 0;
      const samples = telemetry.data.playtimeSamples || 0;
      const met = median >= MEDIAN_TARGET_SEC;
      criteria.push({
        id: 'median-session', name: 'Median session over 20 minutes',
        type: 'measured', met,
        detail: samples
          ? `Median ${Math.round(median / 60)}m over ${samples} sample${samples === 1 ? '' : 's'} `
            + `(mean ${Math.round((telemetry.data.meanPlaytimeSec || 0) / 60)}m). `
            + (samples < MIN_SESSIONS ? 'Sample is too small to trust yet.' : (met ? 'Target met.' : 'Below target.'))
          : 'No sessions have reported a playtime yet.',
      });
    } else {
      criteria.push({
        id: 'median-session', name: 'Median session over 20 minutes',
        type: 'pending', met: null, detail: telemetry.why,
      });
    }

    // 3. People return unprompted across days — install id exists in the shipped build
    // (LAUNCH.md / CLAUDE.md: Report.iid()), but the worker's /summary has no unique-id
    // count, so returning-vs-new cannot be read from it yet. State the gap plainly.
    criteria.push({
      id: 'returns-unprompted', name: 'People return unprompted across days',
      type: 'pending', met: null,
      detail: 'The persisted install identifier (Report.iid(), owner decision 18 Aug) is live in the '
        + 'shipped build and privacy.html was corrected first, so the game CAN answer this. '
        + 'reports.hollowmast.com/summary does not yet report unique install-id counts, only session '
        + 'counts — so this criterion has no route to a number until that endpoint is extended.',
    });

    // 4. Discord active without the owner starting every conversation — LAUNCH.md names this
    // explicitly as something to read off Discord, not compute.
    criteria.push({
      id: 'discord-active', name: 'Discord is active without you starting every conversation',
      type: 'qualitative', met: null,
      detail: 'LAUNCH.md names this as a judgement call on the server itself (discord.gg/UGM2AFzy4m, '
        + 'server HOLLOWMAST). No API integration exists here to read Discord activity — this needs '
        + 'the owner to look.',
    });

    // 5. Commercial interest asked for unprompted.
    criteria.push({
      id: 'commercial-interest', name: '"Can I buy this / will it be on Steam" asked more than a handful of times',
      type: 'qualitative', met: null,
      detail: 'LAUNCH.md names this as something the owner hears directly (Discord, Reddit, itch comments). '
        + 'Not something this route can read.',
    });

    // 6. Human playtest has happened at all — DESIGN.md: none exists yet. DEPLOY.md: scheduled
    // for Thursday 27 Aug, playtest before deploy.
    criteria.push({
      id: 'human-playtest', name: 'A real human playtest has been run (not synthetic, not a bot)',
      type: playtest.folders > 0 ? 'measured' : 'pending',
      met: playtest.folders > 0 ? null : false,
      detail: playtest.folders > 0
        ? `${playtest.folders} capture folder${playtest.folders === 1 ? '' : 's'} on disk under Survive/playtest/ `
          + '(excludes the folder deliberately named _SYNTHETIC-not-a-real-playtest). These are dev/QA '
          + 'capture-tooling passes recorded while building the capture itself, not the scheduled human '
          + 'playtest session — DEPLOY.md schedules that for Thursday 27 Aug, before deploy.'
        : 'DESIGN.md: no human playtest data has ever existed. Scheduled per DEPLOY.md for Thursday 27 Aug '
          + '(playtest first, deploy after — team_decisions #40 confirming #39).',
    });

    // 7. Repo visibility — a decision to make AT this gate, reported as a current fact only.
    criteria.push({
      id: 'repo-visibility', name: 'Repo visibility decision (private stays private, or opens at the gate)',
      type: repoVis.known ? 'measured' : 'pending', met: null,
      detail: repoVis.known
        ? `${repoVis.repo} is currently ${repoVis.visibility}. LAUNCH.md: "private now and decide at the `
          + 'Phase 5 gate" — private→public is free, the reverse is impossible. Not a pass/fail: this is the '
          + 'owner\'s call to make here, this row just states where it currently stands.'
        : repoVis.why,
    });

    const measuredKnown = criteria.filter((c) => c.type === 'measured' && c.met != null);
    const minSampleCriterion = criteria.find((c) => c.id === 'min-sample');
    const minSampleMet = minSampleCriterion.type === 'measured' && minSampleCriterion.met === true;

    res.json({
      gate: {
        // This is ONLY the minimum-sample precondition, per LAUNCH.md's own wording — never
        // a go/no-go verdict. The commercial/free decision stays the owner's, made against
        // the criteria below once the sample is met.
        evaluable: minSampleMet,
        note: minSampleMet
          ? 'Minimum sample is met — the gate can be evaluated against the criteria below.'
          : 'The gate is not evaluated before the minimum sample (100 sessions, 30 days). '
            + 'Below that, nothing here is a verdict yet — read the criteria for what is known so far.',
      },
      criteria,
      minSample: { sessions: MIN_SESSIONS, days: MIN_DAYS },
      source: 'Survive/LAUNCH.md — "Phase 5 — The decision gate (Week 9+)"',
      distinctFrom: '/api/launch-readiness — that route checks whether the build is fit to ship '
        + '(build file, source, commits, dev server, open bugs, itch page). This route is the later, '
        + 'separate question of whether to go commercial once it has shipped and been played.',
    });
  } catch (e) {
    // Only a failure to look is a 500. Individual criteria carry their own state above.
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
