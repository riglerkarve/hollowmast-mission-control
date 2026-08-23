// The BRIEFING module. Named 'briefing', not 'reports': the focus-statistics panel
// already owns /api/stats under the name Reports, and two modules called the same
// thing is precisely what the module contract forbids. Caught before either shipped.
const express = require('express');
const db = require('../db');

db.migrate('briefing', [
  (d) => {
    d.exec(`
      CREATE TABLE briefings (
        date       TEXT PRIMARY KEY,          -- ISO date the briefing is FOR
        markdown   TEXT NOT NULL,
        facts      TEXT NOT NULL,             -- the JSON the prose was written from
        prose_by   TEXT,                      -- 'model' | NULL when Ollama was unavailable
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `);
  },
]);

const router = express.Router();

router.get('/', (req, res) => {
  const limit = Math.min(90, Math.max(1, Number(req.query.limit) || 30));
  res.json(db.prepare(
    `SELECT date, prose_by, created_at, length(markdown) AS bytes
     FROM briefings ORDER BY date DESC LIMIT ?`
  ).all(limit));
});

router.get('/latest', (req, res) => {
  const row = db.prepare('SELECT * FROM briefings ORDER BY date DESC LIMIT 1').get();
  // An empty table and a failed generator must not render the same. 404 with a reason.
  if (!row) return res.status(404).json({ error: 'no briefing has been generated yet' });
  res.json({ ...row, facts: JSON.parse(row.facts) });
});

// --- Major Tom ------------------------------------------------------------------------
// Backlog #22. The speaking was already built and verified in scripts/voice.cjs on 18 Aug
// and then CALLED BY NOTHING — no route, no task, no button. It has been sitting silent
// since. That is the fifth instance of the same failure in this project, so the work here
// is connecting it, not writing it.
//
// ON REQUEST ONLY, never unprompted. A voice that speaks when you did not ask arrives
// whether or not the room is empty, cannot be re-read, and becomes the thing you learn to
// mute — the same bar every notification here has to clear, and harder, because muting a
// voice means turning off the speakers.
//
// THERE IS NO TEXT PARAMETER, DELIBERATELY. This endpoint shells out to PowerShell, so any
// caller-supplied string would be an injection surface on a server that binds 0.0.0.0.
// The route speaks the line the system computed from SQL and nothing else, which removes
// the class of bug rather than trying to sanitise it. The CLI keeps --say for local use,
// where you already have a shell.
const voice = require('../../scripts/voice.cjs');

router.get('/speak', (req, res) => {
  // GET returns what WOULD be said, so the panel can show the words before speaking them
  // and you are never surprised by what comes out.
  try {
    res.json({ line: voice.line() });
  } catch (err) {
    res.status(503).json({ error: `could not compose a line: ${err.message}` });
  }
});

router.post('/speak', async (req, res) => {
  let line;
  try {
    line = voice.line();
  } catch (err) {
    return res.status(503).json({ error: `could not compose a line: ${err.message}` });
  }

  // speakAsync, NOT speak. The synchronous one blocks Node's single thread for the whole
  // sentence: measured at 5,084 ms of total server unavailability for one line, on an
  // endpoint the watchdog polls and treats a timeout as DOWN.
  const r = await voice.speakAsync(line);
  // Three outcomes, never two: spoken, could-not-speak, and nothing-worth-saying. A silent
  // success and a broken speech synthesiser must not render the same.
  if (r.error) {
    return res.status(503).json({
      line,
      spoken: false,
      error: 'System.Speech did not answer — the line is above, it just was not said aloud.',
    });
  }
  res.json({ line, spoken: Boolean(r.spoken) });
});

// --- Morning Briefing ----------------------------------------------------------------
//
// GET /api/briefing/morning — a three-section digest assembled from every data source
// the dashboard already owns. The point is the opposite of the stored briefings above:
// those are prose written once and read later; this is facts computed now and read now.
//
// The three sections are the three things you need before the first coffee:
//   needsYou  — items that are waiting on a decision from you (P1 board items, stuck
//               backlog, open steering questions, handover items blocked on you)
//   happened  — things that changed since the last briefing (new backlog items, agents
//               currently active, decisions recorded, sessions completed today)
//   moved     — state transitions worth knowing about (items stuck >7 days, plans
//               confirmed, work delegated, overdue schedule items)
//
// EACH SOURCE IS CALLED THROUGH ITS EXPORTED FUNCTION, not through an HTTP round-trip.
// A fetch to localhost would need the port (fragile), the gate middleware (which would
// reject a call without an x-mc-by header), and the provenance middleware (which would
// label the call 'unknown'). Calling the function directly is faster, simpler, and
// does not pretend a server is its own client.
//
// ABSENCE AND FAILURE MUST NOT LOOK THE SAME. A source that returns nothing
// contributes zero items; a source that THROWS is recorded in `failed` so the panel
// can show "finance could not be read" rather than rendering an empty finance section
// that reads as "finance is fine".
const board = require('./board');
const team = require('./team');
const brain = require('./brain');
const serendipity = require('./serendipity');
const creative = require('./creative');

function cap(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function isoNow() {
  return new Date().toISOString();
}

function fromBoard(needsYou, happened, moved, failed) {
  let data;
  try {
    data = board.summary();
  } catch (e) {
    failed.push({ source: 'board', reason: cap(e && e.message, 120) });
    return;
  }

  // P1 items from the external trackers — the highest-severity open bugs.
  for (const item of (data.items || [])) {
    if (item.status === 'open' && item.severity === 'P1') {
      needsYou.push({
        text: cap(`${item.ref}: ${item.title}`, 100),
        source: 'board',
        urgency: 'P1',
      });
    }
  }

  // New items since yesterday — backlog rows created in the last 24h.
  try {
    const recent = db.prepare(
      `SELECT id, title FROM todo_items
        WHERE status = 'open'
          AND datetime(created_at) >= datetime('now','localtime','-1 day')
        ORDER BY created_at DESC LIMIT 10`
    ).all();
    for (const r of recent) {
      happened.push({
        text: cap(`${r.id}: ${r.title}`, 100),
        who: 'you',
        when: isoNow(),
      });
    }
  } catch (e) {
    failed.push({ source: 'board:recent', reason: cap(e && e.message, 120) });
  }

  // Items stuck >7 days — open backlog rows older than a week.
  try {
    const stuck = db.prepare(
      `SELECT id, title, created_at FROM todo_items
        WHERE status = 'open'
          AND julianday('now','localtime') - julianday(created_at) > 7
        ORDER BY created_at ASC LIMIT 10`
    ).all();
    for (const r of stuck) {
      moved.push({
        text: cap(`${r.id}: ${r.title}`, 100),
        from: 'open',
        to: 'stuck >7d',
        when: r.created_at,
      });
    }
  } catch (e) {
    failed.push({ source: 'board:stuck', reason: cap(e && e.message, 120) });
  }
}

function fromSessions(happened, failed) {
  try {
    // Query focus_active_sessions directly — the sessions route does not export
    // a function for this, only an Express handler.
    const active = db.prepare(`
      SELECT a.actor, a.started_at AS startedAt, a.last_seen_at AS lastSeenAt,
             a.todo_id AS todoId, t.title AS todoTitle
        FROM focus_active_sessions a
        LEFT JOIN todo_items t ON t.id = a.todo_id
       WHERE datetime(a.last_seen_at) >= datetime('now','localtime','-90 seconds')
       ORDER BY a.started_at ASC
    `).all();
    for (const a of active) {
      const label = a.todoTitle
        ? `working on ${cap(a.todoTitle, 60)}`
        : 'active (no task linked)';
      happened.push({
        text: cap(`${a.actor} ${label}`, 100),
        who: a.actor,
        when: a.startedAt,
      });
    }
  } catch (e) {
    failed.push({ source: 'sessions', reason: cap(e && e.message, 120) });
  }
}

function fromTeam(needsYou, happened, moved, failed) {
  let report;
  try {
    report = team.reportFor();
  } catch (e) {
    failed.push({ source: 'team', reason: cap(e && e.message, 120) });
    return;
  }

  // Open steering questions waiting on the owner.
  for (const q of (report.steering || [])) {
    if (!q.answer) {
      needsYou.push({
        text: cap(`Steering: ${q.question}`, 100),
        source: 'team',
        urgency: 'P2',
      });
    }
  }

  // Untriaged owner items — handover asks that have not been resolved.
  for (const item of (report.ownerItems || [])) {
    // Same predicate as openOwnerItems, not a second copy of it: a handover that wrote
    // "None" under Blocked on you is not an ask, and three of these were at the top of
    // needsYou saying "All work is proceeding."
    if (!item.resolved_at && !team.isNoneOwnerItem(item.text)) {
      needsYou.push({
        text: cap(`${item.title}: ${item.text}`, 100),
        source: 'team',
        urgency: 'P2',
      });
    }
  }

  // Decisions recorded this shift.
  for (const d of (report.decisions || [])) {
    happened.push({
      text: cap(`Decision: ${d.decision}`, 100),
      who: d.decided_by || 'team',
      when: d.at,
    });
  }

  // Confirmed plans and delegated work — state transitions.
  for (const p of (report.plans || [])) {
    if (p.confirmed_at) {
      moved.push({
        text: cap(`Plan #${p.id} confirmed`, 100),
        from: 'drafted',
        to: 'confirmed',
        when: p.confirmed_at,
      });
    }
  }
  for (const a of (report.assignments || [])) {
    moved.push({
      text: cap(`${a.source}:${a.ref} assigned to ${a.session_id}`, 100),
      from: 'unassigned',
      to: a.session_id,
      when: a.at,
    });
  }
}

function fromStats(happened, failed) {
  try {
    // Query focus_sessions directly for today's work session count.
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM focus_sessions
        WHERE kind = 'work' AND date(completed_at) = date('now','localtime')`
    ).get();
    if (row && row.c > 0) {
      happened.push({
        text: cap(`${row.c} focus session(s) completed today`, 100),
        who: 'you',
        when: isoNow(),
      });
    }
  } catch (e) {
    failed.push({ source: 'stats', reason: cap(e && e.message, 120) });
  }
}

function fromFinance(happened, failed) {
  try {
    // Finance may not be set up (no tables, no data). That is absence, not failure.
    const row = db.prepare(
      `SELECT COUNT(*) AS imported,
              SUM(CASE WHEN category IS NULL THEN 1 ELSE 0 END) AS uncategorised
         FROM finance_transactions`
    ).get();
    if (row && row.imported > 0) {
      happened.push({
        text: cap(`${row.imported} transactions imported, ${row.uncategorised || 0} uncategorised`, 100),
        who: 'finance',
        when: isoNow(),
      });
    }
  } catch (e) {
    // Finance is optional — record the failure so absence and failure look different.
    failed.push({ source: 'finance', reason: cap(e && e.message, 120) });
  }
}

function fromSchedule(needsYou, moved, failed) {
  try {
    const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
    const events = db.prepare(
      `SELECT id, title, starts_at, status, kind
         FROM schedule_events
        WHERE starts_at >= ? AND status = 'scheduled'
        ORDER BY starts_at ASC LIMIT 10`
    ).all(today);
    for (const e of events) {
      if (e.kind === 'deadline') {
        needsYou.push({
          text: cap(`Due today: ${e.title}`, 100),
          source: 'schedule',
          urgency: 'P2',
        });
      }
      moved.push({
        text: cap(`${e.title}`, 100),
        from: 'scheduled',
        to: 'due today',
        when: e.starts_at,
      });
    }
  } catch (e) {
    failed.push({ source: 'schedule', reason: cap(e && e.message, 120) });
  }
}

// The owner's own cross-venture decisions (brain_decisions), not the AI team's
// (team_decisions -- already surfaced via fromTeam/ensureSteering). recheck_at only becomes
// a reminder if something reads it; before this, dueOwnerDecisions() had no caller at all,
// so a dated recheck sat in the panel doing nothing unless you happened to open it.
//
// Summarised as one line, not one push per decision -- the same choice fromUnread makes for
// owner items, for the same reason: a briefing that grows one line per stale reminder trains
// you to stop reading it.
function fromBrain(needsYou, failed) {
  let due;
  try {
    due = brain.dueOwnerDecisions();
  } catch (e) {
    failed.push({ source: 'brain', reason: cap(e && e.message, 120) });
    return;
  }
  if (!due.items.length) return;
  const earliest = due.items.slice().sort((a, b) => (a.recheck_at < b.recheck_at ? -1 : 1))[0];
  needsYou.push({
    text: cap(`${due.items.length} owner decision${due.items.length === 1 ? '' : 's'} due for `
      + `recheck. Earliest: ${earliest.venture} — ${earliest.decision}`, 100),
    source: 'brain',
    urgency: 'P2',
  });
}

// THE READING END OF THE TEAM, WHICH DID NOT EXIST.
//
// Measured 20 Aug 2026: 51 of 51 handovers had never been read, 3 owner-facing asks were
// untriaged, and the daily steering question -- the owner's own explicit instruction --
// had run once, ever.
//
// Every one of those was already TRUE in the data and already reported: the shift report's
// `gaps` array named all ten silent sessions unprompted. Nothing was broken. The report was
// correct and nobody was looking at it, which is the same failure as an alert nobody reads
// -- the cost is paid in producing it and nothing comes back.
//
// So this goes FIRST in needsYou, ahead of the board and the schedule. Not because unread
// handovers outrank a P1, but because a P1 gets found anyway and this does not: it is the
// class of problem whose only symptom is that nobody noticed it.
//
// It counts rather than summarising. A count is arithmetic and cannot be wrong in an
// interesting way; a summary of 51 unread handovers would be a model deciding what mattered
// in work nobody has read, which is the exact inversion of the point.
function fromUnread(needsYou, happened, failed) {
  const db = require('../db.js');

  // --- handovers nobody has read ---
  let unread = null;
  try {
    unread = db.prepare('SELECT COUNT(*) n FROM team_handovers WHERE read_at IS NULL').get().n;
  } catch (e) {
    failed.push({ source: 'handovers', error: 'could not count unread handovers: ' + e.message });
  }

  if (unread) {
    needsYou.push({
      text: cap(unread + ' handover' + (unread === 1 ? '' : 's') + ' never read', 100),
      source: 'team', urgency: 'P1',
    });
  }

  // --- owner items still outstanding ---
  //
  // ONE OWNER for this figure: team.openOwnerItems(). The first version of this function
  // ran its own COUNT(*) and printed 33 where the shift report printed 3 -- a second place
  // a number lives, created inside the change meant to fix the reading end.
  //
  // The residue is printed, not hidden. Six of the thirty-three rows are handovers that
  // wrote 'None' under Blocked on you, and a filter that drops rows silently makes the
  // survivors look cleaner than they are.
  const oi = team.openOwnerItems();
  if (!oi.ok) {
    failed.push({ source: 'owner-items', error: oi.why });
  } else if (oi.count) {
    needsYou.push({
      text: cap(oi.count + ' owner item' + (oi.count === 1 ? '' : 's') + ' outstanding'
              + (oi.residue.dropped ? ' (+' + oi.residue.dropped + ' handovers that said None)' : ''), 100),
      source: 'team', urgency: 'P1',
    });
  }

  // --- the daily question, composed if nobody composed it ---
  //
  // NOT pushed to needsYou here: fromTeam already surfaces any open steering question, and
  // doing both printed the identical line twice at two different urgencies.
  try {
    const r = team.ensureSteering({});
    if (r.asked) {
      happened.push({
        text: cap('Composed today\'s steering question from data -- no manager session was live', 110),
        source: 'team',
      });
    } else if (r.state === 'could-not-look') {
      // Distinct from having nothing to ask. A broken read must never render as a quiet day.
      failed.push({ source: 'steering', error: r.why });
    }
  } catch (e) {
    failed.push({ source: 'steering', error: 'could not compose a steering question: ' + e.message });
  }
}

// --- Serendipity + Creative spark ----------------------------------------------------
//
// M219. Both Serendipity (daily cross-project connection) and Creative spark (idea
// prompt) already generate one thing per day and previously required a separate panel
// visit to see. This is not a new module -- it reads what dailyConnection()/dailySpark()
// already compute, the same deterministic-per-day value the panels show, so the line in
// the briefing and the line on the panel never disagree.
//
// OPTIONAL means what it says: this can add nothing (no PROJECTS configured) without
// that reading as a failure, so a genuine throw still goes to `failed` and an empty
// project list just contributes zero lines -- the same absence/failure split every
// other source here keeps.
function fromSerendipity(happened, failed) {
  try {
    const c = serendipity.dailyConnection();
    if (c && c.text) {
      happened.push({
        text: cap(`Serendipity: ${c.text}`, 140),
        who: 'serendipity',
        when: isoNow(),
      });
    }
  } catch (e) {
    failed.push({ source: 'serendipity', reason: cap(e && e.message, 120) });
  }

  try {
    const s = creative.dailySpark();
    if (s && s.text) {
      happened.push({
        text: cap(`Creative spark: ${s.text}`, 140),
        who: 'creative',
        when: isoNow(),
      });
    }
  } catch (e) {
    failed.push({ source: 'creative', reason: cap(e && e.message, 120) });
  }
}

function morningBriefing() {
  const needsYou = [];
  const happened = [];
  const moved = [];
  const failed = [];

  fromUnread(needsYou, happened, failed);
  fromBoard(needsYou, happened, moved, failed);
  fromSessions(happened, failed);
  fromTeam(needsYou, happened, moved, failed);
  fromStats(happened, failed);
  fromFinance(happened, failed);
  fromSchedule(needsYou, moved, failed);
  fromBrain(needsYou, failed);
  fromSerendipity(happened, failed);

  return { needsYou, happened, moved, failed };
}

router.get('/morning', (req, res) => {
  res.json(morningBriefing());
});

// GET /api/briefing/text — the same data as plain text, for voice/TTS.
// One section per paragraph, items as bullet lines. This is what the "Read aloud"
// button fetches and sends to /api/voice/tts.
router.get('/text', (req, res) => {
  const b = morningBriefing();
  const lines = [];

  lines.push('Morning briefing.');
  lines.push('');

  if (b.needsYou.length) {
    lines.push('Needs you:');
    for (const item of b.needsYou) {
      lines.push(`  ${item.urgency === 'P1' ? '[P1] ' : ''}${item.text}`);
    }
  } else {
    lines.push('Needs you: Nothing needs you.');
  }
  lines.push('');

  if (b.happened.length) {
    lines.push('Happened:');
    for (const item of b.happened) {
      lines.push(`  ${item.who}: ${item.text}`);
    }
  } else {
    lines.push('Happened: Quiet since last briefing.');
  }
  lines.push('');

  if (b.moved.length) {
    lines.push('Moved:');
    for (const item of b.moved) {
      lines.push(`  ${item.text} (${item.from} -> ${item.to})`);
    }
  } else {
    lines.push('Moved: Nothing moved.');
  }

  if (b.failed.length) {
    lines.push('');
    lines.push('Sources that could not be read:');
    for (const f of b.failed) {
      lines.push(`  ${f.source}: ${f.reason}`);
    }
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n'));
});

// The date route is LAST because `:date` is a wildcard that would shadow /morning and
// /text if placed before them. Express matches in definition order.
router.get('/:date', (req, res) => {
  const row = db.prepare('SELECT * FROM briefings WHERE date = ?').get(req.params.date);
  if (!row) return res.status(404).json({ error: `no briefing for ${req.params.date}` });
  res.json({ ...row, facts: JSON.parse(row.facts) });
});

module.exports = router;
