const express = require('express');
const db = require('../db');
const provenance = require('../provenance');

// FOCUS SESSIONS, and who did them.
//
// `focus_sessions` predates the provenance work: it was created in db.js as one of the two
// original tables and carried no attribution at all. That was harmless while the only
// writer was the timer in the browser. It stopped being harmless the moment Claude's own
// work started being recorded here (18 Aug 2026, at the owner's request), because
// server/routes/stats.js reads this table in EIGHT places to compute streaks, totals and
// "days with a focus session" — every one of which would silently have become a claim
// about the owner's habits built from my hours.
//
// That is precisely the failure server/provenance.js exists to prevent, and it says so in
// its own header. So the column comes first and the recording second.
db.migrate('sessions', [
  (d) => provenance.addColumn(d, 'focus_sessions'),

  // v2 — a key for rows DERIVED from something else, so an importer can re-run without
  // double-counting. Claude's sessions are imported from the telemetry parse of its own
  // transcripts rather than logged by hand: a record that depends on the agent remembering
  // to log is a record that is wrong the first time it forgets.
  //
  // UNIQUE so re-import is an upsert rather than a duplicate. NULL for anything typed by a
  // person, and SQLite treats NULLs as distinct in a unique index, so hand-entered rows are
  // unaffected by it.
  (d) => {
    d.exec(`
      ALTER TABLE focus_sessions ADD COLUMN source_key TEXT;
      CREATE UNIQUE INDEX idx_focus_source_key ON focus_sessions(source_key);
    `);
  },

  // v3 — link a session to a BACKLOG item. Owner, 18 Aug 2026: "tasks on the focus app
  // should show the todo lists, this is its more native home."
  //
  // They are right and it was a contract violation. Two stores answered "what is there to
  // do": `tasks` (created in db.js, holding ONE demo row — "Call supplier about Q3 order")
  // and `todo_items` (101 real entries). The timer could only be pointed at the demo list,
  // which is a fair part of why it has one session in seventeen days.
  //
  // A NEW COLUMN RATHER THAN REPOINTING task_id, because the types genuinely differ:
  // tasks.id is INTEGER, todo_items.id is TEXT ('49', 'M3', 'O17'). There is no cast that
  // makes the existing foreign key point at the new table.
  //
  // task_id is KEPT, not dropped. One historical session references it, and destroying a
  // real record to tidy a schema is not a trade this project makes. Nothing new writes it.
  (d) => {
    d.exec(`
      ALTER TABLE focus_sessions ADD COLUMN todo_id TEXT REFERENCES todo_items(id) ON DELETE SET NULL;
      CREATE INDEX idx_focus_todo ON focus_sessions(todo_id);
    `);
  },

  // v4 — the telemetry importer can name a model only where one model served the whole
  // session. It is deliberately nullable: splitting a mixed-model session by token count
  // would turn a cost measure into fabricated time allocation.
  (d) => {
    d.exec(`
      ALTER TABLE focus_sessions ADD COLUMN model TEXT;
      CREATE INDEX idx_focus_model ON focus_sessions(model);
    `);
  },

  // v5 — a link chosen while a timer is running and a later manual correction are both
  // direct evidence, but they are not the same provenance. Keep the distinction on the
  // session itself so a project total can always say why it contains a row. Cost is stored
  // in integer micro-USD because the telemetry source reports USD; it is nullable rather
  // than treating a missing price as zero.
  (d) => {
    d.exec(`
      ALTER TABLE focus_sessions ADD COLUMN todo_link_source TEXT CHECK(todo_link_source IN ('timer', 'manual', 'telemetry', 'legacy'));
      ALTER TABLE focus_sessions ADD COLUMN todo_linked_by TEXT;
      ALTER TABLE focus_sessions ADD COLUMN todo_linked_at TEXT;
      ALTER TABLE focus_sessions ADD COLUMN cost_microusd INTEGER CHECK(cost_microusd IS NULL OR cost_microusd >= 0);
      UPDATE focus_sessions SET todo_link_source = 'legacy'
       WHERE todo_id IS NOT NULL AND todo_link_source IS NULL;
      CREATE INDEX idx_focus_link_source ON focus_sessions(todo_link_source);
    `);
  },

  // v6 — a project time target belongs to Focus, because Focus owns actual time and the
  // comparison. The project name is verified on write against the canonical backlog;
  // this table deliberately does not copy a project list.
  (d) => {
    d.exec(`
      CREATE TABLE focus_project_targets (
        project TEXT PRIMARY KEY,
        weekly_target_minutes INTEGER NOT NULL CHECK(weekly_target_minutes > 0 AND weekly_target_minutes <= 10080),
        set_by_whom TEXT NOT NULL DEFAULT 'unknown',
        set_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `);
  },

  // v7 — presence is intentionally separate from completed sessions. A timer that is
  // presently running is not a completed work record, and treating a stale browser tab as
  // active would be equally misleading. Each actor heartbeats its own row and reads expire
  // it after 90 seconds.
  (d) => {
    d.exec(`
      CREATE TABLE focus_active_sessions (
        actor TEXT PRIMARY KEY,
        todo_id TEXT REFERENCES todo_items(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `);
  },
]);

// THE ONE PLACE THE FILTER IS WRITTEN. Exported and reused by stats.js rather than retyped
// per query: eight call sites means eight chances to forget one, and a forgotten filter
// does not error — it just quietly folds my hours into your streak. A shared fragment also
// means grep can PROVE every site is converted, which retyping never can.
//
// It excludes every known model actor rather than selecting 'you', and the difference is deliberate. The one
// pre-existing row is 'unknown': it was recorded on 2026-08-01, before any of this, and is
// almost certainly the owner's — but "almost certainly" is a guess, and the standing rule
// is never to guess 'you'. It stays visible, but every known model actor is excluded from
// the owner's totals so a multi-model time ledger cannot quietly lengthen a human streak.
const AGENT_ACTORS = ['claude', 'codex', 'ollama', 'scribe'];
const NOT_AGENT = `(by_whom IS NULL OR by_whom NOT IN (${AGENT_ACTORS.map((a) => `'${a}'`).join(', ')}))`;
const IS_CLAUDE = "by_whom = 'claude'";

const router = express.Router();

const VALID_KINDS = new Set(['work', 'short', 'long']);

router.post('/', (req, res) => {
  const { kind, durationMinutes, taskId, todoId, label } = req.body;

  if (!VALID_KINDS.has(kind)) {
    res.status(400).json({ error: `kind must be one of ${[...VALID_KINDS].join(', ')}` });
    return;
  }
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    res.status(400).json({ error: 'durationMinutes must be a positive number' });
    return;
  }

  let resolvedTaskId = null;
  if (taskId != null) {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(Number(taskId));
    resolvedTaskId = task ? task.id : null;
  }

  // A backlog id is VERIFIED against the backlog rather than trusted. An unknown id is
  // rejected outright instead of stored as a dangling reference — a session pointing at
  // nothing is worse than a session pointing at nothing in particular.
  let resolvedTodoId = null;
  if (todoId != null && String(todoId).trim() !== '') {
    const item = db.prepare('SELECT id FROM todo_items WHERE id = ?').get(String(todoId));
    if (!item) return res.status(400).json({ error: `no backlog item "${todoId}"` });
    resolvedTodoId = item.id;
  }

  // req.by, never a guess. A request that does not say who it is is recorded 'unknown'.
  const info = db
    .prepare(`INSERT INTO focus_sessions
      (task_id, todo_id, kind, duration_minutes, by_whom, todo_link_source, todo_linked_by, todo_linked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now','localtime') END)`)
    .run(resolvedTaskId, resolvedTodoId, kind, Math.round(minutes), req.by,
      resolvedTodoId ? 'timer' : null, resolvedTodoId ? req.by : null, resolvedTodoId);

  const row = db.prepare('SELECT * FROM focus_sessions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({
    id: row.id,
    taskId: row.task_id,
    todoId: row.todo_id,
    kind: row.kind,
    durationMinutes: row.duration_minutes,
    completedAt: row.completed_at,
    byWhom: row.by_whom,
    todoLinkSource: row.todo_link_source,
    label: label || undefined,
  });
});

// A missing project link is a visible data-quality gap, not a prompt for an algorithm to
// guess. This is the deliberate repair path: a person selects the backlog item they know
// the recorded session belongs to, and the writer and time of that decision are retained.
// Existing direct links are immutable here; replacing one would erase evidence rather than
// correct a gap.
router.patch('/:id/link', (req, res) => {
  const row = db.prepare('SELECT id, todo_id FROM focus_sessions WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'no such focus session' });
  if (row.todo_id != null) return res.status(409).json({ error: 'session already has direct project evidence' });

  const todoId = String((req.body || {}).todoId || '').trim();
  if (!todoId) return res.status(400).json({ error: 'todoId is required' });
  const item = db.prepare('SELECT id, title, project FROM todo_items WHERE id = ?').get(todoId);
  if (!item) return res.status(400).json({ error: `no backlog item "${todoId}"` });

  db.prepare(`UPDATE focus_sessions
                 SET todo_id = ?, todo_link_source = 'manual', todo_linked_by = ?,
                     todo_linked_at = datetime('now','localtime')
               WHERE id = ? AND todo_id IS NULL`)
    .run(item.id, req.by, row.id);
  res.json({ id: row.id, todoId: item.id, title: item.title, project: item.project || null, linkSource: 'manual', linkedBy: req.by });
});

// Presence is a live heartbeat, not an inference from a previous completed session.
// Unknown actors are refused: a row labelled unknown would be a claim that somebody is
// working without identifying them, which is less useful than an explicit absence.
router.get('/active', (req, res) => {
  const active = db.prepare(`
    SELECT a.actor, a.started_at AS startedAt, a.last_seen_at AS lastSeenAt,
           a.todo_id AS todoId, t.title AS todoTitle, t.project AS project
      FROM focus_active_sessions a
      LEFT JOIN todo_items t ON t.id = a.todo_id
     WHERE datetime(a.last_seen_at) >= datetime('now','localtime','-90 seconds')
     ORDER BY a.started_at ASC, a.actor ASC
  `).all();
  res.json({ active, recordedNothing: !active.length
    ? 'No contributor has sent a Focus heartbeat in the last 90 seconds.' : undefined });
});

router.put('/active', (req, res) => {
  if (req.by === 'unknown') return res.status(400).json({ error: 'active presence requires an explicit contributor' });
  const rawTodoId = (req.body || {}).todoId;
  let todoId = null;
  if (rawTodoId != null && String(rawTodoId).trim() !== '') {
    const item = db.prepare('SELECT id FROM todo_items WHERE id = ?').get(String(rawTodoId));
    if (!item) return res.status(400).json({ error: `no backlog item "${rawTodoId}"` });
    todoId = item.id;
  }
  db.prepare(`INSERT INTO focus_active_sessions (actor, todo_id, started_at, last_seen_at)
              VALUES (?, ?, datetime('now','localtime'), datetime('now','localtime'))
              ON CONFLICT(actor) DO UPDATE SET todo_id = excluded.todo_id,
                  started_at = CASE
                    WHEN datetime(focus_active_sessions.last_seen_at) < datetime('now','localtime','-90 seconds')
                    THEN excluded.started_at ELSE focus_active_sessions.started_at END,
                  last_seen_at = excluded.last_seen_at`)
    .run(req.by, todoId);
  res.json({ actor: req.by, todoId });
});

router.delete('/active', (req, res) => {
  if (req.by === 'unknown') return res.status(400).json({ error: 'active presence requires an explicit contributor' });
  db.prepare('DELETE FROM focus_active_sessions WHERE actor = ?').run(req.by);
  res.status(204).end();
});

router.get('/ledger/targets', (req, res) => {
  const targets = db.prepare(`SELECT project, weekly_target_minutes AS weeklyTargetMinutes,
                                     set_by_whom AS setByWhom, set_at AS setAt
                                FROM focus_project_targets ORDER BY project COLLATE NOCASE`).all();
  const knownProjects = db.prepare(`SELECT DISTINCT TRIM(project) AS project FROM todo_items
                                     WHERE project IS NOT NULL AND TRIM(project) <> ''
                                     ORDER BY project COLLATE NOCASE`).all().map((row) => row.project);
  res.json({ targets, knownProjects, recordedNothing: !targets.length ? 'No project time targets have been set.' : undefined });
});

router.put('/ledger/targets/:project', (req, res) => {
  const project = String(req.params.project || '').trim();
  const weeklyTargetMinutes = Math.round(Number((req.body || {}).weeklyTargetMinutes));
  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!Number.isInteger(weeklyTargetMinutes) || weeklyTargetMinutes < 1 || weeklyTargetMinutes > 10080) {
    return res.status(400).json({ error: 'weeklyTargetMinutes must be a whole number from 1 to 10080' });
  }
  const known = db.prepare("SELECT 1 FROM todo_items WHERE TRIM(project) = ? LIMIT 1").get(project);
  if (!known) return res.status(400).json({ error: 'project is not present on a backlog item' });
  db.prepare(`INSERT INTO focus_project_targets (project, weekly_target_minutes, set_by_whom, set_at)
              VALUES (?, ?, ?, datetime('now','localtime'))
              ON CONFLICT(project) DO UPDATE SET weekly_target_minutes = excluded.weekly_target_minutes,
                  set_by_whom = excluded.set_by_whom, set_at = excluded.set_at`)
    .run(project, weeklyTargetMinutes, req.by);
  res.json({ project, weeklyTargetMinutes, setByWhom: req.by });
});

router.delete('/ledger/targets/:project', (req, res) => {
  const project = String(req.params.project || '').trim();
  const found = db.prepare('DELETE FROM focus_project_targets WHERE project = ?').run(project);
  if (!found.changes) return res.status(404).json({ error: 'no target is set for this project' });
  res.status(204).end();
});

// Time spent per backlog item — the thing the old `tasks` list could never answer, because
// nothing you actually work on was ever in it.
//
// It asks the TODO module for titles rather than joining todo_items directly... except it
// does join, and that is deliberate and worth naming: focus_sessions.todo_id is a foreign
// key INTO todo_items, so the relationship is part of this table's own schema. Reading a
// title through a key this table declares is not reaching into another module's storage;
// inventing a second copy of the title here would be.
router.get('/by-item', (req, res) => {
  const rows = db.prepare(`
    SELECT s.todo_id AS id, t.title, t.status, t.priority,
           COUNT(*) AS sessions,
           COALESCE(SUM(s.duration_minutes), 0) AS minutes,
           MAX(s.completed_at) AS lastAt,
           s.by_whom AS byWhom
      FROM focus_sessions s
      JOIN todo_items t ON t.id = s.todo_id
     WHERE s.todo_id IS NOT NULL
     GROUP BY s.todo_id, s.by_whom
     ORDER BY minutes DESC
  `).all();

  res.json({
    items: rows,
    note: rows.length
      ? 'Grouped by who did the work as well as by item, so your minutes and Claude\'s are never summed.'
      : 'No session has been recorded against a backlog item yet.',
  });
});

// TIME LEDGER — Focus is a record of where time went, not only a timer for the person
// looking at it. The rows already hold the two facts needed for that question: `by_whom`
// says who recorded the work and `todo_id` can lead to a project's canonical label.
//
// The three missing-link states remain separate. A session with no backlog item has no
// project evidence at all; a session linked to an item without a project is known work with
// an incomplete project label; an unknown actor is a provenance gap. Folding any of them
// into a named person or project would manufacture an allocation that the record cannot
// support.
router.get('/ledger', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = `-${days - 1} days`;
  const WORK_IN_WINDOW = `s.kind = 'work' AND date(s.completed_at) >= date('now','localtime', ?)`;
  const actor = "COALESCE(NULLIF(TRIM(s.by_whom), ''), 'unknown')";

  const actors = db.prepare(`
    SELECT ${actor} AS actor, NULLIF(TRIM(s.model), '') AS model, COUNT(*) AS sessions,
           COALESCE(SUM(s.duration_minutes), 0) AS minutes,
           COUNT(s.cost_microusd) AS costKnownSessions,
           CASE WHEN COUNT(s.cost_microusd) = 0 THEN NULL ELSE SUM(s.cost_microusd) END AS costMicrousd,
           COALESCE(SUM(s.todo_id IS NULL), 0) AS unlinkedSessions,
           COALESCE(SUM(CASE WHEN s.todo_id IS NULL THEN s.duration_minutes ELSE 0 END), 0) AS unlinkedMinutes
      FROM focus_sessions s
     WHERE ${WORK_IN_WINDOW}
     GROUP BY ${actor}, NULLIF(TRIM(s.model), '')
     ORDER BY minutes DESC, actor ASC, model ASC
  `).all(since);

  const projects = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(t.project), ''), 'unassigned') AS project,
           COUNT(*) AS sessions, COALESCE(SUM(s.duration_minutes), 0) AS minutes,
           COUNT(s.cost_microusd) AS costKnownSessions,
           CASE WHEN COUNT(s.cost_microusd) = 0 THEN NULL ELSE SUM(s.cost_microusd) END AS costMicrousd,
           COUNT(DISTINCT ${actor}) AS contributors
      FROM focus_sessions s
      JOIN todo_items t ON t.id = s.todo_id
     WHERE ${WORK_IN_WINDOW}
     GROUP BY COALESCE(NULLIF(TRIM(t.project), ''), 'unassigned')
     ORDER BY minutes DESC, project ASC
  `).all(since);

  const actorDays = db.prepare(`
    SELECT ${actor} AS actor, date(s.completed_at) AS day,
           COALESCE(SUM(s.duration_minutes), 0) AS minutes
      FROM focus_sessions s
     WHERE ${WORK_IN_WINDOW}
     GROUP BY ${actor}, date(s.completed_at)
     ORDER BY actor ASC, day ASC
  `).all(since);

  const projectDays = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(t.project), ''), 'unassigned') AS project,
           date(s.completed_at) AS day, COALESCE(SUM(s.duration_minutes), 0) AS minutes
      FROM focus_sessions s
      JOIN todo_items t ON t.id = s.todo_id
     WHERE ${WORK_IN_WINDOW}
     GROUP BY COALESCE(NULLIF(TRIM(t.project), ''), 'unassigned'), date(s.completed_at)
     ORDER BY project ASC, day ASC
  `).all(since);

  const models = db.prepare(`
    SELECT ${actor} AS actor, NULLIF(TRIM(s.model), '') AS model,
           COUNT(*) AS sessions, COALESCE(SUM(s.duration_minutes), 0) AS minutes,
           COUNT(s.cost_microusd) AS costKnownSessions,
           CASE WHEN COUNT(s.cost_microusd) = 0 THEN NULL ELSE SUM(s.cost_microusd) END AS costMicrousd
      FROM focus_sessions s
     WHERE ${WORK_IN_WINDOW} AND NULLIF(TRIM(s.model), '') IS NOT NULL
     GROUP BY ${actor}, NULLIF(TRIM(s.model), '')
     ORDER BY minutes DESC, actor ASC, model ASC
  `).all(since);

  const unlinked = db.prepare(`
    SELECT s.id, date(s.completed_at) AS day, s.completed_at AS completedAt,
           ${actor} AS actor, NULLIF(TRIM(s.model), '') AS model,
           s.duration_minutes AS minutes, s.source_key AS sourceKey,
           s.cost_microusd AS costMicrousd
      FROM focus_sessions s
     WHERE ${WORK_IN_WINDOW} AND s.todo_id IS NULL
     ORDER BY s.completed_at DESC, s.id DESC
  `).all(since);

  const missing = db.prepare(`
    SELECT
      COALESCE(SUM(s.todo_id IS NULL), 0) AS unlinkedSessions,
      COALESCE(SUM(CASE WHEN s.todo_id IS NULL THEN s.duration_minutes ELSE 0 END), 0) AS unlinkedMinutes,
      COALESCE(SUM(s.todo_id IS NOT NULL AND (t.project IS NULL OR TRIM(t.project) = '')), 0) AS unprojectedSessions,
      COALESCE(SUM(CASE WHEN s.todo_id IS NOT NULL AND (t.project IS NULL OR TRIM(t.project) = '') THEN s.duration_minutes ELSE 0 END), 0) AS unprojectedMinutes,
      COALESCE(SUM(${actor} = 'unknown'), 0) AS unattributedSessions,
      COALESCE(SUM(CASE WHEN ${actor} = 'unknown' THEN s.duration_minutes ELSE 0 END), 0) AS unattributedMinutes
      FROM focus_sessions s
      LEFT JOIN todo_items t ON t.id = s.todo_id
     WHERE ${WORK_IN_WINDOW}
  `).get(since);

  const quality = db.prepare(`
    SELECT COUNT(*) AS sessions,
           COALESCE(SUM(s.todo_id IS NOT NULL), 0) AS linkedSessions,
           COALESCE(SUM(${actor} <> 'unknown'), 0) AS attributedSessions,
           COALESCE(SUM(NULLIF(TRIM(s.model), '') IS NOT NULL), 0) AS modelKnownSessions,
           COUNT(s.cost_microusd) AS costKnownSessions
      FROM focus_sessions s
     WHERE ${WORK_IN_WINDOW}
  `).get(since);

  const targets = db.prepare(`SELECT project, weekly_target_minutes AS weeklyTargetMinutes,
                                     set_by_whom AS setByWhom, set_at AS setAt
                                FROM focus_project_targets ORDER BY project COLLATE NOCASE`).all();
  const knownProjects = db.prepare(`SELECT DISTINCT TRIM(project) AS project FROM todo_items
                                     WHERE project IS NOT NULL AND TRIM(project) <> ''
                                     ORDER BY project COLLATE NOCASE`).all().map((row) => row.project);

  res.json({
    days,
    actors,
    projects,
    actorDays,
    projectDays,
    models,
    unlinked,
    missing,
    quality,
    targets,
    knownProjects,
    note: 'Work sessions only. Contributor labels are stored provenance values (for example you, Claude, Codex, Ollama, Scribe, or unknown). A specific model is shown only where telemetry recorded exactly one; mixed or missing model data is not guessed. USD cost is shown only where telemetry recorded it. Project allocation comes only from a linked backlog item; a later user-selected repair is marked manual.',
    recordedNothing: !actors.length
      ? 'No work sessions were recorded in this window. That is absence from this ledger, not evidence that nobody worked.'
      : undefined,
  });
});

// A timeline bar is an aggregate; this route provides its rows on demand so the default
// ledger remains compact even when a 90-day window contains hundreds of sessions.
router.get('/ledger/sessions', (req, res) => {
  const day = String(req.query.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
  const requestedActor = req.query.actor == null ? null : String(req.query.actor).trim();
  const requestedProject = req.query.project == null ? null : String(req.query.project).trim();
  if (requestedActor && requestedActor.length > 40) return res.status(400).json({ error: 'actor is too long' });
  if (requestedProject && requestedProject.length > 160) return res.status(400).json({ error: 'project is too long' });

  const actor = "COALESCE(NULLIF(TRIM(s.by_whom), ''), 'unknown')";
  const where = ["s.kind = 'work'", 'date(s.completed_at) = ?'];
  const args = [day];
  if (requestedActor) { where.push(`${actor} = ?`); args.push(requestedActor); }
  if (requestedProject) {
    where.push("COALESCE(NULLIF(TRIM(t.project), ''), 'unassigned') = ?");
    args.push(requestedProject);
  }
  const sessions = db.prepare(`
    SELECT s.id, s.completed_at AS completedAt, ${actor} AS actor,
           NULLIF(TRIM(s.model), '') AS model, s.duration_minutes AS minutes,
           s.cost_microusd AS costMicrousd, s.source_key AS sourceKey,
           s.todo_id AS todoId, t.title AS todoTitle,
           COALESCE(NULLIF(TRIM(t.project), ''), 'unassigned') AS project,
           s.todo_link_source AS todoLinkSource, s.todo_linked_by AS todoLinkedBy
      FROM focus_sessions s
      LEFT JOIN todo_items t ON t.id = s.todo_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.completed_at DESC, s.id DESC
     LIMIT 100
  `).all(...args);
  res.json({ day, actor: requestedActor || null, project: requestedProject || null, sessions,
    recordedNothing: !sessions.length ? 'No matching work sessions were recorded for that day.' : undefined });
});

// The export is intentionally a row-per-attribution, not a blended total. A consumer can
// sum it, but cannot accidentally turn a missing model or project into a named one.
router.get('/ledger/report.csv', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 7));
  const since = `-${days - 1} days`;
  const actor = "COALESCE(NULLIF(TRIM(s.by_whom), ''), 'unknown')";
  const rows = db.prepare(`
    SELECT ${actor} AS actor, NULLIF(TRIM(s.model), '') AS model,
           CASE WHEN s.todo_id IS NULL THEN 'unlinked'
                ELSE COALESCE(NULLIF(TRIM(t.project), ''), 'unassigned') END AS project,
           COUNT(*) AS sessions, COALESCE(SUM(s.duration_minutes), 0) AS minutes,
           COUNT(s.cost_microusd) AS cost_known_sessions,
           CASE WHEN COUNT(s.cost_microusd) = 0 THEN NULL ELSE SUM(s.cost_microusd) END AS cost_microusd
      FROM focus_sessions s
      LEFT JOIN todo_items t ON t.id = s.todo_id
     WHERE s.kind = 'work' AND date(s.completed_at) >= date('now','localtime', ?)
     GROUP BY ${actor}, NULLIF(TRIM(s.model), ''),
              CASE WHEN s.todo_id IS NULL THEN 'unlinked'
                   ELSE COALESCE(NULLIF(TRIM(t.project), ''), 'unassigned') END
     ORDER BY minutes DESC, actor ASC, model ASC, project ASC
  `).all(since);
  const cell = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [['actor', 'model', 'project', 'sessions', 'minutes', 'cost_known_sessions', 'cost_microusd'],
    ...rows.map((row) => [row.actor, row.model, row.project, row.sessions, row.minutes, row.cost_known_sessions, row.cost_microusd])]
    .map((row) => row.map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="focus-allocation-${days}d.csv"`);
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
});

// What Claude has actually worked on. Kept as a SEPARATE reading rather than a filter on
// the main stats, because the two answer different questions and blending them is the whole
// thing this is designed against: "how much did you focus" and "how much did the agent
// grind" are not the same number and must never share one.
router.get('/claude', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));

  const totals = db.prepare(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(duration_minutes), 0) AS minutes,
            MIN(date(completed_at)) AS since
       FROM focus_sessions
      WHERE ${IS_CLAUDE} AND date(completed_at) >= date('now','localtime',?)`
  ).get(`-${days - 1} days`);

  const byDay = db.prepare(
    `SELECT date(completed_at) AS day, COUNT(*) AS sessions,
            COALESCE(SUM(duration_minutes), 0) AS minutes
       FROM focus_sessions
      WHERE ${IS_CLAUDE} AND date(completed_at) >= date('now','localtime',?)
      GROUP BY day ORDER BY day DESC`
  ).all(`-${days - 1} days`);

  const yours = db.prepare(
    `SELECT COUNT(*) AS sessions FROM focus_sessions WHERE ${NOT_AGENT}`
  ).get();

  res.json({
    days,
    ...totals,
    byDay,
    // Stated beside it so the comparison is never implied to be like-for-like: one is an
    // agent recording its own runs, the other is a person choosing to start a timer.
    yourSessionsAllTime: yours.sessions,
    note: 'Claude sessions are recorded separately and are EXCLUDED from your streaks, '
      + 'totals and "days with a focus session". They are not a measure of your work, and '
      + 'the two are never summed.',
    recordedNothing: totals.sessions === 0
      ? 'No Claude sessions in this window. That is a statement about the record, not about '
        + 'whether work happened — sessions are recorded only when something calls this route.'
      : undefined,
  });
});

module.exports = router;
module.exports.NOT_AGENT = NOT_AGENT;
module.exports.IS_CLAUDE = IS_CLAUDE;
