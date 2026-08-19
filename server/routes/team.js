//
// team.js — who is working, what they handed over, and who may interrupt the owner.
//
// Owner instruction, 19 Aug 2026: "Standardize team structures... Please have each session
// record write a handover. This handover will then be read by the team supervisor at the
// beginning of their shift. They will plan with the Team Manager... this team manager will
// scrutinize the plan and confirm... the supervisor then delegates tasks for the next shift
// for each session. Only the team manager may interrupt the owner at any time." And, sent
// separately: "The team manager will quiz the owner every day to get steering directions."
//
// THE POINT OF THE STRUCTURE IS THE INTERRUPT BUDGET. Nine sessions were running against this
// workspace when this was written, six of them in Survive. Any of them could ask the owner
// something at any moment, so the real cost of the team is not confusion — it is nine
// independent claims on one person's attention. Routing every question through one role turns
// that into one conversation a day.
//
// So the roles are defined by what they may INTERRUPT, not by what they may do:
//
//   worker      does the work. Writes a handover at shift end. NEVER interrupts the owner;
//               anything it needs from him goes in its handover as `needs_owner`.
//   supervisor  reads every handover at shift start, drafts a plan, delegates once the plan
//               is confirmed. Does not interrupt the owner either.
//   manager     scrutinises the plan and confirms or returns it. THE ONLY ROLE THAT MAY
//               INTERRUPT THE OWNER, and it does so once a day, as a steering quiz.
//
// This module records those facts and makes the sequence checkable. It cannot enforce them —
// no schema stops a session from typing a question into a chat window. What it can do is make
// a skipped step visible afterwards, which is the same bargain every other guard here makes.
'use strict';

const express = require('express');
const db = require('../db');
const provenance = require('../provenance');

const router = express.Router();

const ROLES = ['worker', 'supervisor', 'manager'];

db.migrate('team', [
  (d) => {
    // The roster. One row per session that has ever reported in — never deleted, because
    // "this session used to exist and stopped reporting" is a fact worth being able to read.
    d.exec(`
      CREATE TABLE team_sessions (
        id         TEXT PRIMARY KEY,        -- the CCD sessionId, or a name if unknown
        title      TEXT NOT NULL,
        role       TEXT NOT NULL,           -- worker | supervisor | manager
        project    TEXT,
        cwd        TEXT,
        first_seen TEXT NOT NULL,
        last_seen  TEXT NOT NULL,
        retired_at TEXT
      )`);

    // One handover per session per shift. `shift` is a date-and-part label rather than a
    // number, so two sessions handing over on the same day land in the same shift without
    // any coordination between them.
    d.exec(`
      CREATE TABLE team_handovers (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL,
        title        TEXT NOT NULL,
        role         TEXT NOT NULL,
        project      TEXT,
        shift        TEXT NOT NULL,
        at           TEXT NOT NULL,
        done         TEXT,                  -- what shipped, with evidence
        blocked      TEXT,                  -- what stopped, and on what
        candidates   TEXT,                  -- found but not filed: leads for the supervisor
        needs_owner  TEXT,                  -- the ONLY route from a worker to the owner
        next         TEXT,                  -- what this session would do next, unprompted
        read_at      TEXT                   -- when a supervisor actually read it
      )`);

    // A plan is drafted by the supervisor and must be confirmed by the manager before any
    // delegation hangs off it. Kept as one row with two timestamps rather than a status
    // field, because "drafted but never confirmed" is the state worth being able to see.
    d.exec(`
      CREATE TABLE team_plans (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        shift        TEXT NOT NULL,
        drafted_by   TEXT NOT NULL,
        drafted_at   TEXT NOT NULL,
        body         TEXT NOT NULL,
        confirmed_by TEXT,
        confirmed_at TEXT,
        returned_at  TEXT,
        verdict      TEXT                   -- the manager's reasoning, either way
      )`);

    // Delegation. Keyed by (source, ref) so ONE table covers backlog items and imported
    // tracker items alike — assignment is a fact about the work, and the work lives in two
    // stores. A second assignment table per store is how the same item ends up assigned twice.
    d.exec(`
      CREATE TABLE team_assignments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id     INTEGER REFERENCES team_plans(id),
        source      TEXT NOT NULL,          -- 'todo' | 'hollowmast-bugs' | ...
        ref         TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        shift       TEXT NOT NULL,
        at          TEXT NOT NULL,
        note        TEXT
      )`);

    // The manager's daily steering quiz. One row per question, with the owner's answer.
    // Answered questions are never deleted: the reason a decision was taken is the thing
    // that gets lost, and a decision I cannot justify later is just a mood.
    d.exec(`
      CREATE TABLE team_steering (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        asked_at    TEXT NOT NULL,
        shift       TEXT NOT NULL,
        question    TEXT NOT NULL,
        options     TEXT,                   -- JSON array; each carries its cost of being wrong
        recommend   TEXT,                   -- the manager's pick, stated before the answer
        answer      TEXT,
        answered_at TEXT
      )`);

    provenance.addColumn(d, 'team_handovers');
    provenance.addColumn(d, 'team_plans');
    provenance.addColumn(d, 'team_steering');
  },
]);

// A shift label both a human and a script can produce without consulting anything.
function shiftLabel(d = new Date()) {
  const h = d.getHours();
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const day = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `${day}-${part}`;
}

// ------------------------------------------------------------------------------ roster

router.get('/roster', (req, res) => {
  res.json({ roles: ROLES, sessions: db.prepare('SELECT * FROM team_sessions ORDER BY role, title').all() });
});

router.post('/roster', express.json(), (req, res) => {
  const { id, title, role, project, cwd } = req.body || {};
  if (!id || !title) return res.status(400).json({ error: 'id and title are required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO team_sessions (id, title, role, project, cwd, first_seen, last_seen)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET title=excluded.title, role=excluded.role,
                project=excluded.project, cwd=excluded.cwd, last_seen=excluded.last_seen`)
    .run(id, title, role, project || null, cwd || null, now, now);
  return res.json({ ok: true, session: db.prepare('SELECT * FROM team_sessions WHERE id = ?').get(id) });
});

// ---------------------------------------------------------------------------- handover

router.post('/handover', express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title is required — a handover with no author cannot be chased' });

  // A HANDOVER IS NEVER REFUSED FOR BEING INCOMPLETE. The whole point is that it exists at the
  // end of a shift; bouncing it for a missing field loses it entirely, and a session that gets
  // a 400 at the end of its shift will not try again. Missing fields are recorded as missing.
  const known = db.prepare('SELECT * FROM team_sessions WHERE id = ? OR title = ?').get(b.session_id || '', b.title);
  const role = ROLES.includes(b.role) ? b.role : (known && known.role) || 'worker';
  const now = new Date().toISOString();
  const shift = b.shift || shiftLabel();

  const info = db.prepare(`
    INSERT INTO team_handovers (session_id, title, role, project, shift, at, done, blocked,
                                candidates, needs_owner, next)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.session_id || (known && known.id) || b.title, b.title, role,
      b.project || (known && known.project) || null, shift, now,
      b.done || null, b.blocked || null, b.candidates || null, b.needs_owner || null, b.next || null);

  const missing = ['done', 'blocked', 'next'].filter((k) => !b[k]);
  return res.json({
    ok: true,
    id: info.lastInsertRowid,
    shift,
    role,
    inRoster: !!known,
    missing,
    note: missing.length
      ? `Recorded. ${missing.join(', ')} left empty — the supervisor will see them as "not stated", which is different from "nothing to report".`
      : 'Recorded in full.',
  });
});

// What the supervisor reads at the start of a shift.
function shiftView(sinceShift) {
  const handovers = sinceShift
    ? db.prepare('SELECT * FROM team_handovers WHERE shift = ? ORDER BY at').all(sinceShift)
    : db.prepare(`SELECT * FROM team_handovers WHERE shift = (SELECT shift FROM team_handovers ORDER BY at DESC LIMIT 1)
                  ORDER BY at`).all();

  const roster = db.prepare('SELECT * FROM team_sessions WHERE retired_at IS NULL').all();
  const reported = new Set(handovers.map((h) => h.title));

  // SILENCE IS REPORTED, and this is the half a list of handovers cannot give you. A session
  // that handed nothing over looks identical to one that had nothing to say, and the second is
  // rare. Naming who did NOT report is what makes the read a shift start rather than an inbox.
  const silent = roster.filter((s) => !reported.has(s.title)).map((s) => ({ title: s.title, role: s.role, project: s.project, lastSeen: s.last_seen }));

  return {
    shift: handovers.length ? handovers[0].shift : shiftLabel(),
    handovers,
    silent,
    needsOwner: handovers.filter((h) => h.needs_owner).map((h) => ({ from: h.title, text: h.needs_owner })),
    blocked: handovers.filter((h) => h.blocked).map((h) => ({ from: h.title, text: h.blocked })),
  };
}

router.get('/shift', (req, res) => res.json(shiftView(req.query.shift)));

// Marking a handover read is how "the supervisor started their shift" becomes a fact rather
// than an assumption. An unread handover from two shifts ago is a real finding.
router.post('/handover/:id/read', express.json(), (req, res) => {
  const info = db.prepare('UPDATE team_handovers SET read_at = ? WHERE id = ? AND read_at IS NULL')
    .run(new Date().toISOString(), req.params.id);
  res.json({ ok: true, changed: info.changes });
});

// -------------------------------------------------------------------------------- plan

router.post('/plan', express.json(), (req, res) => {
  const { shift, drafted_by: by, body } = req.body || {};
  if (!by || !body) return res.status(400).json({ error: 'drafted_by and body are required' });
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO team_plans (shift, drafted_by, drafted_at, body) VALUES (?,?,?,?)')
    .run(shift || shiftLabel(), by, now, body);
  res.json({ ok: true, id: info.lastInsertRowid, confirmed: false, note: 'Drafted. Nothing may be delegated against it until the manager confirms.' });
});

// THE MANAGER'S VERDICT IS REQUIRED IN BOTH DIRECTIONS. Confirming without reasoning would
// make the review a rubber stamp with a timestamp, which is worse than no review because it
// looks like one happened.
router.patch('/plan/:id', express.json(), (req, res) => {
  const { confirmed, by, verdict } = req.body || {};
  if (!by) return res.status(400).json({ error: 'by is required — a confirmation with no author cannot be questioned' });
  if (!verdict) return res.status(400).json({ error: 'verdict is required, whether confirming or returning. A stamp without reasoning is not scrutiny.' });
  const plan = db.prepare('SELECT * FROM team_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'no such plan' });
  const now = new Date().toISOString();
  if (confirmed) db.prepare('UPDATE team_plans SET confirmed_by=?, confirmed_at=?, verdict=?, returned_at=NULL WHERE id=?').run(by, now, verdict, plan.id);
  else db.prepare('UPDATE team_plans SET returned_at=?, verdict=?, confirmed_by=NULL, confirmed_at=NULL WHERE id=?').run(now, verdict, plan.id);
  return res.json({ ok: true, plan: db.prepare('SELECT * FROM team_plans WHERE id = ?').get(plan.id) });
});

router.get('/plan', (req, res) => {
  res.json({ plans: db.prepare('SELECT * FROM team_plans ORDER BY id DESC LIMIT 20').all() });
});

// -------------------------------------------------------------------------- delegation

router.post('/assign', express.json(), (req, res) => {
  const { plan_id: planId, source, ref, session_id: sid, note } = req.body || {};
  if (!source || !ref || !sid) return res.status(400).json({ error: 'source, ref and session_id are required' });

  // DELEGATION REQUIRES A CONFIRMED PLAN, and this is the one place the sequence is actually
  // enforced rather than merely recorded. It is enforceable here because assignment is an act
  // this module performs; the earlier steps are acts performed in a chat window, where no
  // schema reaches.
  const plan = planId ? db.prepare('SELECT * FROM team_plans WHERE id = ?').get(planId) : null;
  if (!plan) return res.status(400).json({ error: 'plan_id is required: work is delegated against a plan, not ad hoc' });
  if (!plan.confirmed_at) {
    return res.status(409).json({
      error: 'that plan has not been confirmed by the manager',
      detail: plan.returned_at ? `it was returned at ${plan.returned_at}: ${plan.verdict}` : 'it is still a draft',
    });
  }

  const info = db.prepare('INSERT INTO team_assignments (plan_id, source, ref, session_id, shift, at, note) VALUES (?,?,?,?,?,?,?)')
    .run(plan.id, source, ref, sid, plan.shift, new Date().toISOString(), note || null);
  return res.json({ ok: true, id: info.lastInsertRowid });
});

router.get('/assignments', (req, res) => {
  const rows = db.prepare(`SELECT a.*, s.title FROM team_assignments a
                           LEFT JOIN team_sessions s ON s.id = a.session_id
                           ORDER BY a.id DESC LIMIT 200`).all();
  res.json({ assignments: rows });
});

// ---------------------------------------------------------------------------- steering

// The manager's daily quiz. Every question carries options and a recommendation, because a
// question with neither is a request for the owner to do the thinking, which is the opposite
// of what this role is for.
router.post('/steering', express.json(), (req, res) => {
  const { question, options, recommend } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question is required' });
  if (!recommend) return res.status(400).json({ error: 'recommend is required: a question with no recommendation hands the thinking back' });
  const info = db.prepare('INSERT INTO team_steering (asked_at, shift, question, options, recommend) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), shiftLabel(), question, options ? JSON.stringify(options) : null, recommend);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.post('/steering/:id/answer', express.json(), (req, res) => {
  const { answer } = req.body || {};
  if (!answer) return res.status(400).json({ error: 'answer is required' });
  db.prepare('UPDATE team_steering SET answer = ?, answered_at = ? WHERE id = ?')
    .run(answer, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

function openSteering() {
  return db.prepare('SELECT * FROM team_steering WHERE answer IS NULL ORDER BY asked_at').all()
    .map((r) => ({ ...r, options: r.options ? JSON.parse(r.options) : null }));
}

router.get('/steering', (req, res) => {
  res.json({
    open: openSteering(),
    answered: db.prepare('SELECT * FROM team_steering WHERE answer IS NOT NULL ORDER BY answered_at DESC LIMIT 20').all(),
  });
});

module.exports = router;
module.exports.shiftView = shiftView;
module.exports.shiftLabel = shiftLabel;
module.exports.openSteering = openSteering;
module.exports.ROLES = ROLES;
