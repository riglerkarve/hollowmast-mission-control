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
//   manager     scrutinises the plan and confirms or returns it. THE ONLY ROLE IN THE CHAIN
//               THAT MAY INTERRUPT THE OWNER, once a day, as a steering quiz.
//   architect   OUTSIDE the chain, by the owner's decision on 19 Aug. Takes work directly from
//               him, owns sequencing and cross-project consistency, keeps a standing right to
//               put options to him. Still hands over every shift. It is a second channel to
//               the owner and that cost is stated rather than hidden — see ROLES below.
//
// This module records those facts and makes the sequence checkable. It cannot enforce them —
// no schema stops a session from typing a question into a chat window. What it can do is make
// a skipped step visible afterwards, which is the same bargain every other guard here makes.
'use strict';

const express = require('express');
const scribe = require('../scribe.js');
const db = require('../db');
const provenance = require('../provenance');
const { dispatch } = require('../dispatch');
const alerts = require('./alerts');

const router = express.Router();

// `architect` is deliberately LAST and deliberately outside the chain. The other three form
// the shift cycle: worker hands over, supervisor plans, manager confirms and delegates back.
// The architect takes work straight from the owner, owns sequencing and cross-project
// consistency, and keeps a standing right to put options to him.
//
// THE OWNER CHOSE THIS KNOWING THE COST, on 19 Aug, and the cost should stay written down:
// it is a SECOND channel to him alongside the manager's daily quiz, which is precisely what
// the structure exists to reduce. It holds because he wants it, not because it is tidy. If a
// second architect ever appears, that is the moment to collapse this back into the chain.
const ROLES = ['worker', 'supervisor', 'manager', 'architect', 'scribe'];

// The three that make up the shift cycle. A missing one stops the chain; a missing architect
// does not, so they are not checked the same way.
const CHAIN_ROLES = ['worker', 'supervisor', 'manager'];

// A handover is immutable prose, written by people rather than a form.  We only split a
// block when its top-level structure says exactly where every item begins: a list from the
// first non-blank line onwards.  Everything else remains ONE owner item.  That is less
// clever than trying to infer questions from sentences, but a whole preserved block is
// recoverable and individually resolvable; a plausible wrong split is neither.
function ownerItemKey(title, text) {
  return require('node:crypto').createHash('sha256')
    .update(`${String(title).trim().toLowerCase()}\0${String(text).replace(/\s+/g, ' ').trim().toLowerCase()}`)
    .digest('hex');
}

function ownerItemsFromBlock(text) {
  const source = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  if (!source || /^(?:[-*]\s*)?(?:none|nothing)(?:\.)?$/i.test(source)) {
    return { state: 'not_raised', items: [] };
  }

  const lines = source.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    // Deliberately top-level only.  Indented bullets are part of the item above them.
    if (/^(?:[-*]|\d+[.)])\s+\S/.test(lines[i])) starts.push(i);
  }
  // An introductory sentence, a malformed list, or unlisted prose is not a safe boundary.
  if (!starts.length || starts[0] !== 0) return { state: 'unsplit', items: [source] };

  const items = starts.map((at, i) => lines.slice(at, starts[i + 1] || lines.length).join('\n').trim())
    .filter(Boolean);
  // Do not manufacture two canonical asks from a duplicated bullet in one source block.
  const distinct = [...new Map(items.map((item) => [item.replace(/\s+/g, ' ').trim().toLowerCase(), item])).values()];
  return { state: 'split', items: distinct };
}

function ownerItemsForHandovers(handovers) {
  const ids = handovers.map((h) => h.id);
  if (!ids.length) return [];
  const q = ids.map(() => '?').join(',');
  return db.prepare(`SELECT f.handover_id, f.source_text, f.parse_state, o.id, o.title, o.text,
                            o.resolved_at, o.resolved_by, o.resolved_note, o.last_handover_id,
                            o.first_seen_at, o.last_seen_at, o.filing_count
                     FROM team_owner_item_filings f
                     JOIN team_owner_items o ON o.id = f.item_id
                     WHERE f.handover_id IN (${q})
                     ORDER BY f.handover_id, o.id`).all(...ids);
}

function recordOwnerItems(handover, at) {
  const parsed = ownerItemsFromBlock(handover.needs_owner);
  db.prepare('UPDATE team_handovers SET owner_items_state = ? WHERE id = ?')
    .run(parsed.state, handover.id);
  for (const text of parsed.items) {
    const fingerprint = ownerItemKey(handover.title, text);
    db.prepare(`INSERT INTO team_owner_items
                  (title, text, fingerprint, first_seen_at, last_seen_at, last_handover_id, filing_count)
                VALUES (?,?,?,?,?,?,1)
                ON CONFLICT(fingerprint) DO UPDATE SET
                  last_seen_at=excluded.last_seen_at,
                  last_handover_id=excluded.last_handover_id,
                  filing_count=team_owner_items.filing_count + 1`)
      .run(handover.title, text, fingerprint, at, at, handover.id);
    const item = db.prepare('SELECT * FROM team_owner_items WHERE fingerprint = ?').get(fingerprint);
    db.prepare(`INSERT OR IGNORE INTO team_owner_item_filings
                  (handover_id, item_id, source_text, parse_state)
                VALUES (?,?,?,?)`).run(handover.id, item.id, text, parsed.state);
    // A legacy whole-block resolution was a real recorded fact.  During migration it applies
    // to each item that block contained; new individual resolutions never mark the whole
    // handover resolved.
    if (handover.owner_resolved_at) {
      db.prepare(`UPDATE team_owner_items
                  SET resolved_at=?, resolved_by=?, resolved_note=?
                  WHERE id=? AND resolved_at IS NULL`)
        .run(handover.owner_resolved_at, handover.owner_resolved_by, handover.owner_resolved_note, item.id);
    }
  }
  return parsed;
}

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

  // 2. A `needs_owner` item can be ANSWERED WITHOUT THE OWNER, and until this existed there
  //    was no way to say so.
  //
  //    Caught within an hour of the module going live, by the thing going live. My own first
  //    handover asked "who is the Team Manager? nothing can be confirmed until that seat is
  //    filled" — and the seat filled itself twenty minutes later. The item was true when
  //    written, is now resolved, and the shift view was still queueing it for the owner.
  //
  //    That is the exact failure this whole structure exists to prevent: a stale question
  //    spending his attention. And it is not rare — a shift's worth of blockers routinely
  //    clears before anyone reads them.
  //
  //    The handover itself is NEVER edited. It is what a session reported at a moment, and
  //    rewriting it would make the record disagree with what was actually said. The resolution
  //    is a separate fact recorded beside it, with who resolved it and how.
  (d) => {
    d.exec('ALTER TABLE team_handovers ADD COLUMN owner_resolved_at TEXT');
    d.exec('ALTER TABLE team_handovers ADD COLUMN owner_resolved_by TEXT');
    d.exec('ALTER TABLE team_handovers ADD COLUMN owner_resolved_note TEXT');
  },

  // 3. Decisions that have no other home.
  //
  // Owner instruction, 19 Aug: "ensure every plan and decision is being recorded". Measured
  // before adding this, three of the four kinds already were — a manager's verdict lives on
  // team_plans, an owner's answer on team_steering, a supervisor's plan in its own body. The
  // gap was every OTHER call: the architect's sequencing, a scope change, a deferral, a "no".
  // Those lived in commit messages and CLAUDE.md, which is durable but not reviewable — you
  // cannot ask a commit log "what did we decide this week and what would change it".
  //
  // THIS TABLE DOES NOT DUPLICATE THE OTHER THREE. A verdict recorded here as well would be
  // two owners for one fact, disagreeing the first time one was edited. The review report
  // JOINS all four; each fact keeps exactly one home.
  //
  // `revisit_when` is the field that makes it more than a log. The workspace rule is that a
  // "no" I cannot justify later is just a mood — so a decision states what would change it,
  // and the report surfaces the ones whose condition has a date attached and has passed.
  (d) => {
    d.exec(`
      CREATE TABLE team_decisions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        at           TEXT NOT NULL,
        shift        TEXT NOT NULL,
        decided_by   TEXT NOT NULL,     -- a session title, or 'owner'
        role         TEXT,
        decision     TEXT NOT NULL,     -- what was decided, in one line
        because      TEXT NOT NULL,     -- the reasoning. Required: see below.
        cost_if_wrong TEXT,             -- what it costs if this turns out wrong
        revisit_when TEXT,              -- the condition that would reopen it
        recheck_at   TEXT,              -- a date, where the condition has one
        supersedes   INTEGER REFERENCES team_decisions(id),
        evidence     TEXT               -- commit sha, file:line, a measurement
      )`);
    provenance.addColumn(d, 'team_decisions');
  },

  // 4. A plan can be SUPERSEDED, and until this existed that looked identical to a stall.
  //
  // Reported by another session and reproduced here: plan #3 was drafted 15:31 and neither
  // confirmed nor returned, so the report called it "drafted, never put to the manager". Plan
  // #4's own opening line is "revision of id 3, folding in the answer to steering #2", drafted
  // three minutes later and confirmed four minutes after that. It was replaced, not abandoned.
  //
  // Supersession and stalling produce IDENTICAL NULLS in confirmed_at and returned_at. The
  // report was crying wolf on a plan that had been correctly handled, which is the failure
  // that gets a checker switched off.
  (d) => {
    d.exec('ALTER TABLE team_plans ADD COLUMN superseded_by INTEGER REFERENCES team_plans(id)');
  },

  // 5. THE OWNER CAN ANSWER ANY ITEM, not just a steering question.
  //
  // Owner instruction, 19 Aug: "Allow me to respond to each item on the reports, bugs etc on
  // the dashboard." Until now his only reply channel was the steering card — one question a
  // day, chosen by the manager. Everything else he read was read-only: a bug, a handover, a
  // decision, a gap. He could form a view on any of it and had nowhere to put it.
  //
  // KEYED BY (kind, ref) FOR THE SAME REASON team_assignments IS. The things he responds to
  // live in different stores — board_items mirrors a file this repo does not own, todo_items
  // is the backlog, handovers and decisions are here — and a response table per store is how
  // the same reply ends up in two places. One table, one channel, one thing for the manager
  // to read.
  //
  // `actioned_at` is what stops this being a comment box. A response nobody picks up is the
  // owner spending attention into a void, which is the exact failure this structure exists to
  // prevent, running in the opposite direction. Unactioned responses are a reported gap.
  (d) => {
    d.exec(`
      CREATE TABLE team_responses (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          TEXT NOT NULL,
        shift       TEXT NOT NULL,
        kind        TEXT NOT NULL,     -- board | todo | handover | decision | plan | gap
        ref         TEXT NOT NULL,     -- B054 | M73 | handover id | decision id | gap kind
        label       TEXT,              -- what the item said, so the reply reads on its own later
        response    TEXT NOT NULL,
        verdict     TEXT,              -- agree | disagree | drop | later  (optional, his shorthand)
        actioned_at TEXT,
        actioned_by TEXT,
        action_note TEXT
      )`);
    d.exec('CREATE INDEX team_responses_target ON team_responses (kind, ref)');
    provenance.addColumn(d, 'team_responses');
  },

  // 6. WHICH ENGINE a roster member is, because from 19 Aug the team is not all one model.
  //
  // Owner: "codex will also have worker roles - working alongside you and the team managers."
  // That amends the earlier call that Codex would be a reviewer and nothing else, and it
  // creates a problem the roster could not previously express.
  //
  // THE REVIEWER MUST NOT SHARE THE AUTHOR'S BLIND SPOTS. That sentence is the whole reason a
  // second model was chosen: the most expensive recurring failure recorded in this workspace
  // is a checker built from the same assumption as the code confirming the code. If Codex
  // writes a commit as a worker and Codex also reviews it, that failure is rebuilt exactly,
  // with two models involved and no more independence than one.
  //
  // So `engine` is recorded per member and a review can be checked against it. It is nullable
  // for the rows already there, and unknown is a real value: a member whose engine nobody
  // recorded must NOT be assumed to be Claude, because that assumption is the one that would
  // let a self-review through.
  (d) => {
    d.exec("ALTER TABLE team_sessions ADD COLUMN engine TEXT");   // claude | codex | other | NULL
    // Everything on the roster before this line was a Claude Code session -- that is a fact
    // about how they got there (the roster was seeded from CCD sessions), not an assumption.
    d.exec("UPDATE team_sessions SET engine = 'claude' WHERE engine IS NULL");
  },

  // 7. Reviews, with BOTH engines on every row.
  //
  // Owner's rules, 19 Aug: a review by the same engine that wrote the code is REFUSED and
  // recorded as "not reviewed"; and when the two engines disagree, the Team Manager
  // arbitrates.
  //
  // `author_engine` and `reviewer_engine` are both stored because independence is a property
  // of the PAIR, and a row holding only the reviewer cannot be checked afterwards. `outcome`
  // separates the three states that must never merge: reviewed, refused-for-independence, and
  // could-not-run. The second is an honest absence; the third is a failure. A schema that
  // recorded only "no findings" would render all three identically, which is the exact shape
  // the owner rejected when he chose refusal over a lower-confidence label.
  //
  // arbiter_engine exists because the arbiter is NOT neutral and he accepted that knowingly:
  // the Manager is a Claude session, so on a Claude-versus-Codex disagreement it shares one
  // side's engine. It cannot be enforced away, so it is recorded and becomes countable -- a
  // lean toward the arbiter's own engine shows up as data rather than as a suspicion.
  (d) => {
    d.exec(`
      CREATE TABLE team_reviews (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        at              TEXT NOT NULL,
        shift           TEXT NOT NULL,
        target          TEXT NOT NULL,      -- a commit sha, a branch, or 'uncommitted'
        repo            TEXT NOT NULL,
        author          TEXT,               -- roster title, where known
        author_engine   TEXT,               -- claude | codex | unknown
        reviewer        TEXT NOT NULL,
        reviewer_engine TEXT NOT NULL,
        outcome         TEXT NOT NULL,      -- reviewed | refused_same_engine | could_not_run
        findings        INTEGER,            -- NULL when not reviewed; 0 is a real answer
        body            TEXT,
        note            TEXT
      )`);
    d.exec(`
      CREATE TABLE team_arbitrations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        review_id     INTEGER REFERENCES team_reviews(id),
        finding       TEXT NOT NULL,
        claimed_by    TEXT NOT NULL,        -- which engine raised it
        disputed_by   TEXT NOT NULL,
        arbiter       TEXT NOT NULL,
        arbiter_engine TEXT NOT NULL,       -- so a lean toward its own engine is countable
        ruling        TEXT NOT NULL,        -- upheld | rejected
        because       TEXT NOT NULL
      )`);
    provenance.addColumn(d, 'team_reviews');
  },

  // 8. WHICH MODEL AND EFFORT A TASK WAS MEANT TO GET, AND WHICH IT ACTUALLY GOT.
  //
  // Owner instruction, 19 Aug: "Enforce model and effort use in sessions." Enforcement here
  // has three honest strengths, and pretending they are one would be the lie:
  //
  //   ENFORCED   anything spawned. Codex takes `-m <model>` and `model_reasoning_effort` per
  //              invocation, and a Claude subagent takes model and effort as parameters. The
  //              wrapper sets them from the recommendation, so there is nothing to comply with.
  //   CHECKED    a Claude session already running. It CAN read its own effort -- CLAUDE_EFFORT
  //              is in the environment -- so it can compare itself and refuse. It CANNOT read
  //              its own model; nothing in the environment names it. So the model is declared,
  //              not detected, and a declaration is a claim rather than a measurement.
  //   RECORDED   everything else. The recommendation and what was actually used both sit on
  //              the assignment, and a mismatch with no stated reason is a reported gap.
  //
  // `override_reason` exists because the recommendation is a rule of thumb over item text and
  // will sometimes be wrong. Overriding it is fine; overriding it SILENTLY is not, because
  // then the table cannot tell a considered exception from a session ignoring it. Same shape
  // as the mandatory verdict and the mandatory `because` on a decision.
  (d) => {
    for (const c of ['rec_model', 'rec_effort', 'used_model', 'used_effort', 'override_reason']) {
      d.exec(`ALTER TABLE team_assignments ADD COLUMN ${c} TEXT`);
    }
  },

  // 9. Owner-facing asks are items, not an opaque handover field.
  //
  // `needs_owner` stays on the handover forever: it is the exact report a session made, and
  // both the existing writer and old readers continue to use it.  This pair of tables is the
  // derived, addressable representation.  A filing links to a canonical item, so a verbatim
  // re-filing refreshes that item rather than creating another queue entry.  The link keeps
  // provenance without making each re-filing a second ask.
  (d) => {
    d.exec(`
      CREATE TABLE team_owner_items (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        title            TEXT NOT NULL,
        text             TEXT NOT NULL,
        fingerprint      TEXT NOT NULL UNIQUE,
        first_seen_at    TEXT NOT NULL,
        last_seen_at     TEXT NOT NULL,
        last_handover_id INTEGER REFERENCES team_handovers(id),
        filing_count     INTEGER NOT NULL DEFAULT 1,
        resolved_at      TEXT,
        resolved_by      TEXT,
        resolved_note    TEXT
      )`);
    d.exec(`
      CREATE TABLE team_owner_item_filings (
        handover_id INTEGER NOT NULL REFERENCES team_handovers(id),
        item_id     INTEGER NOT NULL REFERENCES team_owner_items(id),
        source_text TEXT NOT NULL,
        parse_state TEXT NOT NULL,  -- split | unsplit
        PRIMARY KEY (handover_id, item_id)
      )`);
    d.exec('CREATE INDEX team_owner_item_filings_item ON team_owner_item_filings (item_id)');
    d.exec('ALTER TABLE team_handovers ADD COLUMN owner_items_state TEXT');

    const rows = d.prepare('SELECT * FROM team_handovers WHERE needs_owner IS NOT NULL ORDER BY id').all();
    for (const handover of rows) recordOwnerItems(handover, handover.at);
    // Handover rows with no owner field did not raise an ask.  This explicit state avoids
    // rendering an absent field as either a resolved queue or a parser failure.
    d.prepare(`UPDATE team_handovers SET owner_items_state = 'not_raised'
               WHERE needs_owner IS NULL AND owner_items_state IS NULL`).run();
  },

  // 9 -- THE SCRIBE. Owner decision, 20 August 2026.
  //
  // Two asks in one: the free local tier holds finance and wellbeing exclusively, AND it
  // does real work when the paid subscriptions hit their weekly or session caps. The
  // second is what makes this a continuity tier rather than a vanity one -- Claude Code
  // is capped weekly and Codex runs on a subscription, so without this the workspace
  // simply stops when they are spent, and the owner is the one who finds out.
  //
  // The capabilities table ships EMPTY on purpose. An unmeasured job is refused, not
  // attempted. Seeding it with the jobs I expect a 4B to manage would make this a record
  // of my predictions rather than of its measurements, which is the exact failure the
  // table exists to prevent.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scribe_capabilities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job         TEXT NOT NULL UNIQUE,
        status      TEXT NOT NULL DEFAULT 'unproven',  -- unproven | proven | failed
        score       REAL,
        floor       REAL NOT NULL DEFAULT 0.8,
        sample_n    INTEGER,
        oracle      TEXT,        -- WHERE the truth came from. A job scored against an
                                 -- oracle the model supplied is not scored at all.
        misses      TEXT,        -- every individual miss. An accuracy figure with the
                                 -- misses hidden is decoration.
        residue     TEXT,        -- what the measurement could NOT look at, and why.
        model       TEXT,
        measured_at TEXT,
        measured_by TEXT,
        notes       TEXT
      );

      -- Every attempt, including the refusals. A table holding only successes cannot
      -- distinguish 'ran and wrote nothing' from 'never ran', and this tier runs
      -- unattended by design.
      CREATE TABLE IF NOT EXISTS scribe_runs (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        job      TEXT NOT NULL,
        model    TEXT,
        at       TEXT NOT NULL,
        items    INTEGER,
        wrote    INTEGER NOT NULL DEFAULT 0,
        refused  INTEGER NOT NULL DEFAULT 0,
        reason   TEXT,
        detail   TEXT
      );

      -- A cap is DECLARED, never detected. Nothing in this process can see an upstream
      -- quota, and a cap-detector that cannot look reports 'not capped' in exactly the
      -- same words as one that looked and found nothing. Undeclared means idle, which is
      -- the safe direction to be wrong in.
      CREATE TABLE IF NOT EXISTS scribe_caps (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tier        TEXT NOT NULL,        -- claude | codex | ollama-cloud
        declared_at TEXT NOT NULL,
        declared_by TEXT,
        until       TEXT,                 -- NULL = until explicitly cleared
        note        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scribe_runs_at ON scribe_runs(at DESC);
      CREATE INDEX IF NOT EXISTS idx_scribe_caps_tier ON scribe_caps(tier);
    `);
  },

  // 10 -- THE REVIEW QUEUE. Owner decision, 20 August 2026:
  //   "well being can write BUT gets reviewed before it can enact"
  //
  // This changes a fixed policy and it is worth being exact about which half. The rule
  // had two clauses. 'Nothing in wellbeing may be model-generated' is the one the owner
  // just changed. 'Nothing may read as diagnosis, clinical advice, or a risk score' is a
  // separate clause he did NOT change, and review does not satisfy it -- a reviewer who
  // approves a risk score has still enacted a risk score. It stays enforced on content.
  //
  // WHY A QUEUE RATHER THAN A FLAG. 'Reviewed before it can enact' is only real if the
  // write physically cannot land first. A boolean the writer checks is a rule the writer
  // can forget; a row that has no effect until somebody moves it is a mechanism.
  //
  // current_value IS CAPTURED AT PROPOSE TIME, and this is the load-bearing column.
  // Between proposing and approving, the underlying row can change -- another session,
  // the owner, an import. Enacting a proposal built against a value that has since moved
  // silently overwrites whatever replaced it. So enactment re-reads the row and refuses
  // if it no longer matches: approved and still-applicable are different questions.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scribe_proposals (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        job            TEXT,
        module         TEXT NOT NULL,
        target_table   TEXT NOT NULL,
        target_id      TEXT,
        field          TEXT NOT NULL,
        proposed_value TEXT,
        current_value  TEXT,      -- as read AT PROPOSE TIME. If it has moved by approval,
                                  -- the proposal is stale and must not enact.
        reason         TEXT,
        model          TEXT,
        created_at     TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|enacted|stale
        reviewed_by    TEXT,
        reviewed_at    TEXT,
        review_note    TEXT,
        enacted_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scribe_prop_status ON scribe_proposals(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scribe_prop_module ON scribe_proposals(module);
    `);
  },

  // 11 -- who ASKED a steering question, not just who answered it.
  //
  // The daily quiz is the owner's own instruction and it has run ONCE since 19 Aug,
  // because it depended on a manager session being alive to type it and usually one is
  // not. So the briefing pass now composes one itself -- which makes the asker a fact
  // worth recording. A question the owner wrote, a question a manager wrote, and a
  // question a nightly job assembled from a SQL count are three different things, and
  // only the last one is allowed to be wrong without anybody having been careless.
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('team_steering')").all().map(r => r.name);
    if (!cols.includes('asked_by')) db.exec('ALTER TABLE team_steering ADD COLUMN asked_by TEXT');
    if (!cols.includes('source')) db.exec('ALTER TABLE team_steering ADD COLUMN source TEXT');
  },

  // A QUESTION MUST REMEMBER WHAT IT WAS COMPOSED FROM. M348.
  //
  // Measured 23 Aug: he answered steering #7 on 20 Aug, himself, the same day. The system
  // then asked him the SAME question on the 21st, 22nd and 23rd. Not because the composer
  // duplicates -- because his answer wrote team_steering.answer and stopped. The item it
  // was composed from (team_owner_items #2, filing_count 5) still reads resolved_at NULL,
  // openOwnerItems() still returns it as the oldest open item, and the composer correctly
  // regenerates the identical question from data that is correctly still open.
  //
  // So the missing edge is answer -> resolve, and the first thing it needs is a link that
  // does not currently exist: the INSERT recorded asked_at, shift, question, options,
  // recommend, asked_by and source, and nothing about WHICH rows produced it.
  //
  // RECORDED AT COMPOSITION, NOT RE-DERIVED AT ANSWER TIME, and that is the whole point.
  // Re-deriving "the oldest open item" when the answer arrives would resolve whatever is
  // oldest THEN -- which after three days of drift is a different row. It would look like
  // it worked and close the wrong item silently, which is worse than closing none.
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('team_steering')").all().map(r => r.name);
    if (!cols.includes('ref_kind')) db.exec('ALTER TABLE team_steering ADD COLUMN ref_kind TEXT');
    if (!cols.includes('ref_ids')) db.exec('ALTER TABLE team_steering ADD COLUMN ref_ids TEXT');
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
  const engine = (req.body || {}).engine || null;
  if (!id || !title) return res.status(400).json({ error: 'id and title are required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO team_sessions (id, title, role, project, cwd, first_seen, last_seen)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET title=excluded.title, role=excluded.role,
                project=excluded.project, cwd=excluded.cwd, last_seen=excluded.last_seen`)
    .run(id, title, role, project || null, cwd || null, now, now);
  if (engine) db.prepare('UPDATE team_sessions SET engine = ? WHERE id = ?').run(engine, id);
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

  let info;
  let ownerItems;
  let amended = false;
  db.withTransaction(() => {
    // M245: If this session already filed a handover for this shift, amend it
    // instead of inserting a second row. The old code always INSERTed, so a
    // session that filed twice (common when a shift is interrupted and resumed)
    // created two rows — the supervisor saw both, and the shift report counted
    // double. Amending keeps the original row id and updates the content, so
    // references to the handover id elsewhere stay valid.
    const existing = db.prepare('SELECT id FROM team_handovers WHERE title = ? AND shift = ? ORDER BY at DESC LIMIT 1')
      .get(b.title, shift);
    if (existing) {
      db.prepare(`UPDATE team_handovers SET done = ?, blocked = ?, candidates = ?, needs_owner = ?, next = ?, at = ?
                  WHERE id = ?`)
        .run(b.done || null, b.blocked || null, b.candidates || null, b.needs_owner || null, b.next || null, now, existing.id);
      info = { lastInsertRowid: existing.id, changes: db.prepare('SELECT changes()').get()['changes()'] };
      amended = true;
      // Remove old owner item filings and re-derive, so a re-file with different
      // needs_owner stays in sync. The filings table links handovers to items;
      // the items themselves persist (they may be referenced by other handovers).
      db.prepare('DELETE FROM team_owner_item_filings WHERE handover_id = ?').run(existing.id);
      ownerItems = recordOwnerItems({ id: existing.id, title: b.title, needs_owner: b.needs_owner }, now);
    } else {
      info = db.prepare(`
        INSERT INTO team_handovers (session_id, title, role, project, shift, at, done, blocked,
                                    candidates, needs_owner, next)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(b.session_id || (known && known.id) || b.title, b.title, role,
          b.project || (known && known.project) || null, shift, now,
          b.done || null, b.blocked || null, b.candidates || null, b.needs_owner || null, b.next || null);
      ownerItems = recordOwnerItems({ id: info.lastInsertRowid, title: b.title, needs_owner: b.needs_owner }, now);
    }
  });

  // AN UNREGISTERED SESSION IS A FINDING ON ITS OWN, independent of what its own needs_owner
  // field says. Before this, "not on the roster" was a line handover.cjs printed to a console
  // that may not be watched — a session could file every handover honestly and still go
  // unnoticed for hours, because nothing durable recorded the absence itself. Hermes Agent ran
  // ~2 hours unregistered on 20 Aug before anyone but the owner knew it existed; its own
  // needs_owner field said "None" every time, because self-reporting can't surface "nobody
  // knows I'm here" — only the roster check can. Routed through alerts.js (the module that
  // already owns "should this get raised", including self-muting) rather than a second alerting
  // mechanism invented here.
  if (!known) {
    alerts.record('unregistered-session', `Unregistered session filed a handover: "${b.title}"`,
      `Not on the team roster. Add it: POST /api/team/roster, or node tools/team-roster.cjs --set "${b.title}" <role>.`);
  }

  const missing = ['done', 'blocked', 'next'].filter((k) => !b[k]);
  return res.json({
    ok: true,
    id: info.lastInsertRowid,
    shift,
    role,
    amended,
    inRoster: !!known,
    missing,
    ownerItems: { state: ownerItems.state, count: ownerItems.items.length },
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
  // A current shift can itself contain re-filings.  Read the latest filing for each canonical
  // item once, otherwise the supervisor's queue would inflate even though reportFor does not.
  const items = [...new Map(ownerItemsForHandovers(handovers).map((item) => [item.id, item])).values()];

  // SILENCE IS REPORTED, and this is the half a list of handovers cannot give you. A session
  // that handed nothing over looks identical to one that had nothing to say, and the second is
  // rare. Naming who did NOT report is what makes the read a shift start rather than an inbox.
  const silent = roster.filter((s) => !reported.has(s.title)).map((s) => ({ title: s.title, role: s.role, project: s.project, lastSeen: s.last_seen }));

  return {
    shift: handovers.length ? handovers[0].shift : shiftLabel(),
    handovers,
    silent,
    // Resolved items are separated, NOT hidden. The manager needs to know it does not have to
    // ask; the supervisor needs to see that the blocker cleared. Dropping them entirely would
    // make a question that got answered look like one that was never raised.
    needsOwner: items.filter((i) => !i.resolved_at)
      .map((i) => ({ id: i.id, from: i.title, text: i.text, handoverId: i.handover_id, state: i.parse_state })),
    needsOwnerResolved: items.filter((i) => i.resolved_at)
      .map((i) => ({ id: i.id, from: i.title, text: i.text, handoverId: i.handover_id,
        by: i.resolved_by, note: i.resolved_note, state: i.parse_state })),
    blocked: handovers.filter((h) => h.blocked).map((h) => ({ from: h.title, text: h.blocked })),
  };
}

router.get('/shift', (req, res) => res.json(shiftView(req.query.shift)));

// Resolve one canonical owner item.  The handover id proves the caller is addressing an item
// that was actually filed in that report; the item id means a five-ask block can lose just one.
// Which engine a session runs on, by roster title. Returns null when unknown -- and every
// caller must treat null as 'could not check' rather than 'fine'.
function engineOf(title) {
  if (!title) return null;
  const r = db.prepare('SELECT engine FROM team_sessions WHERE title = ? AND retired_at IS NULL').get(String(title));
  return r && r.engine ? String(r.engine) : null;
}

router.post('/handover/:id/resolve-owner', express.json(), (req, res) => {
  const { by, note } = req.body || {};
  if (!by || !note) return res.status(400).json({ error: 'by and note are both required — a resolution with no account of how is a dropped question' });
  const h = db.prepare('SELECT * FROM team_handovers WHERE id = ?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'no such handover' });
  if (!h.needs_owner) return res.status(400).json({ error: 'that handover has no owner-facing item' });

  // ONE ENGINE MAY NOT CLEAR ITS OWN WORK -- owner decision, 20 August 2026.
  //
  // The examination that produced this found the manager and the worker were the same
  // session (Codex filed 34 handovers as worker and 26 as manager), and that BOTH of the
  // two resolved handovers in the whole database had been resolved by their own author.
  // One of those was mine. So this was not an occasional lapse -- self-resolution was the
  // default behaviour, and nothing anywhere said no.
  //
  // The rule is ENGINE, not session, and that is the whole point. Two Claude sessions
  // share a model, a training run and a set of blind spots; one confirming the other looks
  // like review and reproduces the same misses. Cross-engine review is the only mechanism
  // here with a track record of catching what the author could not see -- it found a P1, a
  // dark theme swallowed by a stray comment, and an inverted rules pass, none of which the
  // author's own checks could detect.
  // THE OWNER IS NOT A SESSION, AND THE RULE ABOVE DOES NOT APPLY TO HIM. Added 23 Aug 2026
  // after the Team Manager reported being BLOCKED executing decision #44's prune. The blocker
  // was this check: `by: "owner"` returned 403 "resolver is not on the roster", because he is
  // a human and humans are not on a roster of Claude sessions. So "42 owner items outstanding,
  // zero resolved by the owner" was a fact about the SCHEMA, not about him — he was locked out
  // of the only mechanism for clearing his own queue.
  //
  // THE SAME-ENGINE RULE EXISTS BECAUSE TWO CLAUDE SESSIONS SHARE BLIND SPOTS. A human shares
  // none of them; he is the ground truth the rule is a proxy for. Refusing him is the check
  // firing in exactly the case it was built to protect.
  //
  // KEYED ON PROVENANCE, NOT ON THE `by` STRING, and that is the security of it. `by` is free
  // text a caller chooses; X-MC-By is the established owner signal, sent by the browser
  // panels and validated against a fixed list in server/provenance.js. That module also
  // records why loopback is NOT usable as a signal — the browser, a Claude session running
  // curl, and every importer all arrive on 127.0.0.1, so the network says nothing about who
  // is typing, and only an explicit claim does. This is exactly as strong as that, and no
  // stronger; it is the same claim the rest of the system already trusts for attribution.
  //
  // DELIBERATELY NOT FIXED BY ADDING A ROSTER ROW WITH engine 'human', which was the first
  // proposal. That would make the check pass by an accident of data rather than by intent,
  // model a person as a session with a cwd and a last_seen, and be silently undone by anyone
  // tidying the roster. A rule that should not apply to him is better stated than evaded.
  const ownerIsResolving = req.by === 'you';

  if (!ownerIsResolving) {
    const resolver = String(by).trim();
    const authorEngine = engineOf(resolver === h.title ? h.title : h.title);
    const resolverEngine = engineOf(resolver);
    if (resolver === h.title) {
      return res.status(403).json({
        error: 'a session may not resolve its own handover',
        why: 'The owner-facing item was raised by ' + h.title + '. Clearing it requires somebody else.',
      });
    }
    // An UNKNOWN engine is not a matching one, and must not be treated as a pass. If the
    // resolver is not on the roster we cannot tell whether the rule is satisfied, so the
    // answer is 'could not check', which fails closed.
    if (!resolverEngine) {
      return res.status(403).json({
        error: 'resolver is not on the roster',
        why: 'Cannot establish which engine ' + resolver + ' runs on, so cannot establish that it '
           + 'differs from the author. Register the session first -- an unverifiable rule is not a satisfied one.',
      });
    }
    if (authorEngine && resolverEngine === authorEngine) {
      return res.status(403).json({
        error: 'same-engine resolution refused',
        why: resolver + ' and ' + h.title + ' both run on ' + resolverEngine + '. A reviewer sharing '
           + "the author's model shares the author's blind spots, so this would look like review and "
           + 'reproduce the same misses. Route it to a session on a different engine.',
        author_engine: authorEngine, resolver_engine: resolverEngine,
      });
    }
  }
  const items = ownerItemsForHandovers([h]);
  if (!items.length) return res.status(409).json({ error: 'this handover raised no owner item' });
  const now = new Date().toISOString();
  const itemId = (req.body || {}).item_id;
  if (itemId != null) {
    const item = items.find((x) => x.id === Number(itemId));
    if (!item) return res.status(404).json({ error: 'no such owner item on this handover' });
    if (item.resolved_at) return res.status(409).json({ error: `already resolved by ${item.resolved_by}` });
    db.prepare('UPDATE team_owner_items SET resolved_at=?, resolved_by=?, resolved_note=? WHERE id=?')
      .run(now, String(by).trim(), String(note).trim(), item.id);
    return res.json({ ok: true, itemId: item.id, resolved: 1 });
  }

  // Compatibility for callers of the old endpoint: without item_id it still resolves the
  // whole legacy block, but reports exactly how many items that means.  New callers pass
  // item_id and never mutate the immutable handover row's legacy resolution fields.
  const open = items.filter((x) => !x.resolved_at);
  db.withTransaction(() => {
    const update = db.prepare('UPDATE team_owner_items SET resolved_at=?, resolved_by=?, resolved_note=? WHERE id=?');
    for (const item of open) update.run(now, String(by).trim(), String(note).trim(), item.id);
    db.prepare('UPDATE team_handovers SET owner_resolved_at=?, owner_resolved_by=?, owner_resolved_note=? WHERE id=?')
      .run(now, String(by).trim(), String(note).trim(), h.id);
  });
  return res.json({ ok: true, resolved: open.length, legacyWholeBlock: true });
});

// Marking a handover read is how "the supervisor started their shift" becomes a fact rather
// than an assumption. An unread handover from two shifts ago is a real finding.
router.post('/handover/:id/read', express.json(), (req, res) => {
  const info = db.prepare('UPDATE team_handovers SET read_at = ? WHERE id = ? AND read_at IS NULL')
    .run(new Date().toISOString(), req.params.id);
  res.json({ ok: true, changed: info.changes });
});

// -------------------------------------------------------------------------------- plan

router.post('/plan', express.json(), (req, res) => {
    return res.status(410).json({
      error: 'RETIRED_CYCLE',
      why: 'The plan/confirm/assign cycle was retired by owner decision on 20 August 2026. It ran for '
         + 'two hours on 19 Aug and then stopped, while 88 commits shipped from a markdown plan instead. '
         + 'A dormant mechanism is worse than an absent one: it reported plans:0 and confirmed:0 '
         + 'truthfully, and those zeros read as nothing-to-do rather than nobody-is-here.',
      instead: 'Work is planned in a plan document and tracked on /api/board. Handovers, decisions and '
             + 'the daily steering question are unchanged.',
      history_preserved: 'The existing rows are NOT deleted -- they are the only record of how this '
                       + 'worked while in use. GET /api/team/plan still reads them.',
    });
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

// Mark a draft as replaced by a later plan. This is the supervisor's to set — it is the only
// role that knows whether it revised a plan or abandoned it, and both leave the same nulls.
router.post('/plan/:id/superseded-by/:newId', express.json(), (req, res) => {
    return res.status(410).json({
      error: 'RETIRED_CYCLE',
      why: 'The plan/confirm/assign cycle was retired by owner decision on 20 August 2026. It ran for '
         + 'two hours on 19 Aug and then stopped, while 88 commits shipped from a markdown plan instead. '
         + 'A dormant mechanism is worse than an absent one: it reported plans:0 and confirmed:0 '
         + 'truthfully, and those zeros read as nothing-to-do rather than nobody-is-here.',
      instead: 'Work is planned in a plan document and tracked on /api/board. Handovers, decisions and '
             + 'the daily steering question are unchanged.',
      history_preserved: 'The existing rows are NOT deleted -- they are the only record of how this '
                       + 'worked while in use. GET /api/team/plan still reads them.',
    });
  const old = db.prepare('SELECT * FROM team_plans WHERE id = ?').get(req.params.id);
  const neu = db.prepare('SELECT * FROM team_plans WHERE id = ?').get(req.params.newId);
  if (!old || !neu) return res.status(404).json({ error: 'no such plan' });
  if (neu.id <= old.id) return res.status(400).json({ error: 'a plan can only be superseded by a LATER one' });
  if (old.confirmed_at) return res.status(409).json({ error: 'that plan was confirmed — it was acted on, not replaced' });
  db.prepare('UPDATE team_plans SET superseded_by = ? WHERE id = ?').run(neu.id, old.id);
  return res.json({ ok: true });
});

router.get('/plan', (req, res) => {
  res.json({ plans: db.prepare('SELECT * FROM team_plans ORDER BY id DESC LIMIT 20').all() });
});

// -------------------------------------------------------------------------- delegation

router.post('/assign', express.json(), (req, res) => {
    return res.status(410).json({
      error: 'RETIRED_CYCLE',
      why: 'The plan/confirm/assign cycle was retired by owner decision on 20 August 2026. It ran for '
         + 'two hours on 19 Aug and then stopped, while 88 commits shipped from a markdown plan instead. '
         + 'A dormant mechanism is worse than an absent one: it reported plans:0 and confirmed:0 '
         + 'truthfully, and those zeros read as nothing-to-do rather than nobody-is-here.',
      instead: 'Work is planned in a plan document and tracked on /api/board. Handovers, decisions and '
             + 'the daily steering question are unchanged.',
      history_preserved: 'The existing rows are NOT deleted -- they are the only record of how this '
                       + 'worked while in use. GET /api/team/plan still reads them.',
    });
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

  // THE RECOMMENDATION IS ATTACHED AT ASSIGNMENT TIME, not looked up later. Derived from the
  // item the assignment names, so the delegating session does not choose it and cannot forget
  // it. If the item cannot be found the recommendation is null rather than guessed — a made-up
  // "sonnet/medium" would be indistinguishable from a derived one the moment it was stored.
  let rec = null;
  try {
    const item = source === 'todo'
      ? db.prepare('SELECT id, title, rationale, kind, priority, cluster, owner, project FROM todo_items WHERE id = ?').get(String(ref))
      : db.prepare('SELECT ref, title, kind, severity AS priority, project FROM board_items WHERE source = ? AND ref = ?').get(source, String(ref));
    if (item) rec = dispatch(item);
  } catch { /* recommendation unavailable; recorded as null, which reads as "not derived" */ }

  const info = db.prepare(`INSERT INTO team_assignments
      (plan_id, source, ref, session_id, shift, at, note, rec_model, rec_effort)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(plan.id, source, ref, sid, plan.shift, new Date().toISOString(), note || null,
      rec ? rec.model : null, rec ? rec.effort : null);
  return res.json({ ok: true, id: info.lastInsertRowid, recommended: rec });
});

// A session declares what it actually used. The MODEL is a declaration and the EFFORT can be
// measured by the session itself (CLAUDE_EFFORT is in its environment), so they are recorded
// with different confidence and the report says which is which.
//
// A mismatch is allowed and needs a reason. Refusing the write would push sessions into not
// reporting at all, and an unreported mismatch is worse than a stated one.
router.post('/assign/:id/used', express.json(), (req, res) => {
    return res.status(410).json({
      error: 'RETIRED_CYCLE',
      why: 'The plan/confirm/assign cycle was retired by owner decision on 20 August 2026. It ran for '
         + 'two hours on 19 Aug and then stopped, while 88 commits shipped from a markdown plan instead. '
         + 'A dormant mechanism is worse than an absent one: it reported plans:0 and confirmed:0 '
         + 'truthfully, and those zeros read as nothing-to-do rather than nobody-is-here.',
      instead: 'Work is planned in a plan document and tracked on /api/board. Handovers, decisions and '
             + 'the daily steering question are unchanged.',
      history_preserved: 'The existing rows are NOT deleted -- they are the only record of how this '
                       + 'worked while in use. GET /api/team/plan still reads them.',
    });
  const b = req.body || {};
  const row = db.prepare('SELECT * FROM team_assignments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such assignment' });
  const usedModel = String(b.model || '').trim();
  const usedEffort = String(b.effort || '').trim();
  if (!usedModel && !usedEffort) return res.status(400).json({ error: 'model or effort is required' });

  const mismatch = (usedModel && row.rec_model && usedModel !== row.rec_model)
    || (usedEffort && row.rec_effort && usedEffort !== row.rec_effort);
  const reason = String(b.override_reason || '').trim();
  if (mismatch && !reason) {
    return res.status(400).json({
      error: 'this differs from the recommendation, so override_reason is required',
      recommended: `${row.rec_model}/${row.rec_effort}`,
      used: `${usedModel || row.rec_model}/${usedEffort || row.rec_effort}`,
      detail: 'Overriding is fine. Overriding silently is not -- otherwise a considered exception and a session ignoring the recommendation look identical afterwards.',
    });
  }
  db.prepare('UPDATE team_assignments SET used_model = ?, used_effort = ?, override_reason = ? WHERE id = ?')
    .run(usedModel || null, usedEffort || null, reason || null, row.id);
  return res.json({ ok: true, mismatch: !!mismatch });
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

// WHO ANSWERED IS RECORDED, and the first version did not record it — the UPDATE set the
// answer and the timestamp and left `by_whom` at whatever the INSERT had put there, which is
// the asking session. So "the owner decided" and "a session decided on his behalf" were the
// same row, and I had already produced one of each: steering #2 was answered by the owner
// through the architect session, and only the prose said so.
//
// That distinction is the whole point of this table. Every other decision here can be
// re-derived from data; a steering answer cannot, because it IS the owner's judgement. An
// answer wrongly attributed to him is exactly the fabrication provenance.js exists to
// prevent, and unlike an honest gap it cannot be found again later.
router.post('/steering/:id/answer', express.json(), (req, res) => {
  const { answer } = req.body || {};
  if (!answer) return res.status(400).json({ error: 'answer is required' });
  const row = db.prepare('SELECT answer FROM team_steering WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such steering question' });
  // Answering twice is refused rather than overwritten, matching tools/steering-answer.cjs:
  // the first answer is the one the team acted on, and a changed decision is a new question.
  if (row.answer) return res.status(409).json({ error: 'already answered — a changed decision is a new question, not an edit' });
  db.prepare('UPDATE team_steering SET answer = ?, answered_at = ?, by_whom = ? WHERE id = ?')
    .run(answer, new Date().toISOString(), req.by || 'unknown', req.params.id);

  // ---------------------------------------------------------------------------------------
  // M348 — THE ANSWER -> RESOLVE EDGE. Until this existed, answering wrote the answer and
  // stopped: he answered steering #7 himself on 20 August, the item it was composed from
  // stayed open, openOwnerItems() kept returning it, and the composer correctly regenerated
  // the identical question on the 21st, 22nd and 23rd. The loop had no exit.
  //
  // IT RESOLVES ONLY WHAT THE CALLER NAMES. `resolves` is an explicit list of owner-item
  // ids. Free text is never parsed for intent -- "take the oldest first" cannot be mapped
  // to a row without guessing, and closing the WRONG item is worse than closing none,
  // because a wrongly-closed item stops being asked about and nobody looks again.
  //
  // THREE CONSTRAINTS, each refusing rather than silently doing less:
  //   1. Owner only. Same rule and same reasoning as the resolve-owner endpoint: a session
  //      clearing his queue on his behalf is what produced "42 open, 0 resolved by him".
  //   2. Only ids this question actually offered, from ref_ids recorded at composition. A
  //      caller cannot close an arbitrary row through the steering channel.
  //   3. Only ref_kind 'owner_item'. A due DECISION is revisited by taking a new decision
  //      that supersedes it -- clearing a revisit date is not the same act and must not be
  //      reachable from here.
  const out = { ok: true, by: req.by || 'unknown' };
  const asked = Array.isArray((req.body || {}).resolves) ? (req.body || {}).resolves.map(Number) : [];

  if (!asked.length) {
    // NOT an error, and deliberately distinguished from a failed resolve: most answers are
    // prose and close nothing. Saying so is what stops "resolved: 0" reading as a fault.
    out.resolved = { count: 0, why: 'no resolves[] sent — the answer was recorded and no item was closed' };
    return res.json(out);
  }

  const meta = db.prepare('SELECT ref_kind, ref_ids FROM team_steering WHERE id = ?').get(req.params.id);
  let offered = [];
  try { offered = JSON.parse(meta && meta.ref_ids ? meta.ref_ids : '[]'); } catch { offered = []; }

  if (req.by !== 'you') {
    out.resolved = { count: 0, refused: 'owner-only',
      why: 'Resolving is the owner adjudicating. A session recording his answer should send the '
         + 'answer alone; if he also cleared items, he clears them. This is the same rule as '
         + 'the resolve-owner endpoint and for the same reason.' };
    return res.json(out);
  }
  if (meta && meta.ref_kind !== 'owner_item') {
    out.resolved = { count: 0, refused: 'not-resolvable',
      why: `this question is about ${meta.ref_kind || 'nothing recorded'}; only owner items can be `
         + 'closed by answering. A due decision is revisited by taking a new one that supersedes it.' };
    return res.json(out);
  }
  if (!offered.length) {
    // The pre-M348 rows have no ref_ids and must not be silently treated as "offered nothing".
    out.resolved = { count: 0, refused: 'no-link-recorded',
      why: 'this question was composed before ref_ids existed, so what it was about was never '
         + 'recorded. Resolve the item directly rather than through this channel.' };
    return res.json(out);
  }

  const now = new Date().toISOString();
  const note = 'Resolved by the owner answering steering #' + req.params.id;
  const upd = db.prepare('UPDATE team_owner_items SET resolved_at=?, resolved_by=?, resolved_note=? '
                       + 'WHERE id=? AND resolved_at IS NULL');
  const closed = [], skipped = [];
  db.withTransaction(() => {
    for (const id of asked) {
      if (!offered.includes(id)) { skipped.push({ id, why: 'not offered by this question' }); continue; }
      const r = upd.run(now, 'owner', note, id);
      if (r.changes) closed.push(id);
      else skipped.push({ id, why: 'already resolved, or no such item' });
    }
  });

  out.resolved = { count: closed.length, ids: closed };
  if (skipped.length) out.resolved.skipped = skipped;
  res.json(out);
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

// ------------------------------------------------------------------------------ report

// ONE OWNER FOR "WHAT THE SHIFT DID AND WHAT IT MISSED. `tools/shift-report.cjs` computed
// this itself when it was the only reader. The panel is a second reader, and two readers
// deriving the same gaps from the same tables is the failure this project keeps meeting: they
// agree until one is edited, and then they disagree without either erroring. So the
// derivation lives here, the tool renders markdown from it, and the panel renders HTML.
function shifts() {
  return db.prepare(`SELECT shift, MAX(at) last FROM (
      SELECT shift, at FROM team_handovers
      UNION ALL SELECT shift, drafted_at at FROM team_plans
      UNION ALL SELECT shift, asked_at at FROM team_steering
      UNION ALL SELECT shift, at FROM team_decisions
    ) GROUP BY shift ORDER BY shift DESC`).all();
}

// A free-text revisit condition and a date are deliberately separate fields. A condition
// such as "when the next review fails" cannot honestly become a calendar alert just because
// it contains the word "when". Only a real ISO calendar date is eligible for the automatic
// due list; the undated remainder is returned explicitly so it does not disappear from view.
function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dueDecisions() {
  const asOf = db.prepare("SELECT date('now', 'localtime') AS day").get().day;
  const rows = db.prepare(`
    SELECT d.*,
      EXISTS(SELECT 1 FROM team_decisions successor WHERE successor.supersedes = d.id) AS superseded
    FROM team_decisions d
    ORDER BY d.id DESC
  `).all();
  const due = [];
  const residue = { undated: [], future: [], malformed: [], superseded: [] };

  for (const row of rows) {
    const recheckAt = row.recheck_at == null ? '' : String(row.recheck_at).trim();
    const item = { ...row, recheck_at: recheckAt || null };
    if (row.superseded) {
      residue.superseded.push(item);
    } else if (!recheckAt) {
      residue.undated.push(item);
    } else if (!isCalendarDate(recheckAt)) {
      residue.malformed.push(item);
    } else if (recheckAt > asOf) {
      residue.future.push(item);
    } else {
      due.push(item);
    }
  }

  return {
    asOf,
    state: due.length ? 'due' : 'none-due',
    items: due,
    residue,
    // A zero due count means exactly that. It does not mean the register is empty or that
    // every decision is safe to forget: undated conditions still need a human-triggered review.
    note: due.length
      ? `${due.length} decision(s) have a dated recheck on or before ${asOf}.`
      : `No dated decision rechecks are due on ${asOf}. ${residue.undated.length} decision(s) have a revisit condition but no calendar date.`,
  };
}

function reportFor(shift) {
  // DEFAULTS TO THE LATEST SHIFT THAT HAS ANYTHING IN IT, not to the clock. Caught at 18:00
  // today: the label rolled to `-evening`, the report came back empty, and an empty report
  // reads as "the team did nothing" rather than "this shift has not started". The first is a
  // damning claim about people; the second is a timestamp. They must not render the same.
  const latest = shifts()[0];
  const s = shift || (latest && latest.shift) || shiftLabel();
  const handovers = db.prepare('SELECT * FROM team_handovers WHERE shift = ? ORDER BY at').all(s);
  const plans = db.prepare('SELECT * FROM team_plans WHERE shift = ? ORDER BY id').all(s);
  const steering = db.prepare('SELECT * FROM team_steering WHERE shift = ? ORDER BY id').all(s)
    .map((r) => ({ ...r, options: r.options ? JSON.parse(r.options) : null }));
  const decisions = db.prepare('SELECT * FROM team_decisions WHERE shift = ? ORDER BY id').all(s);
  const decisionsDue = dueDecisions();
  const assignments = db.prepare('SELECT * FROM team_assignments WHERE shift = ? ORDER BY id').all(s);
  const roster = db.prepare('SELECT * FROM team_sessions WHERE retired_at IS NULL').all();
  const ownerItemFilings = ownerItemsForHandovers(handovers);
  const ownerItems = [...new Map(ownerItemFilings.map((item) => [item.id, item])).values()];
  const byHandover = new Map();
  for (const item of ownerItemFilings) {
    if (!byHandover.has(item.handover_id)) byHandover.set(item.handover_id, []);
    byHandover.get(item.handover_id).push(item);
  }
  for (const handover of handovers) handover.owner_items = byHandover.get(handover.id) || [];

  const unread = handovers.filter((h) => !h.read_at);
  const confirmedNoWork = plans.filter((x) => x.confirmed_at && !assignments.some((a) => a.plan_id === x.id));

  // A DRAFT WITH A LATER PLAN BEHIND IT IS AMBIGUOUS, NOT STALLED. `superseded_by` settles it
  // when set; when it is not, a draft followed by another plan in the same shift is reported
  // as "superseded or abandoned, nothing records which" rather than asserted to be a stall.
  // Naming the ambiguity is the honest move — picking one is how a report loses its reader.
  const drafts = plans.filter((x) => !x.confirmed_at && !x.returned_at && !x.superseded_by);
  const maybeSuperseded = drafts.filter((x) => plans.some((y) => y.id > x.id));
  const trulyStalled = drafts.filter((x) => !plans.some((y) => y.id > x.id));

  // Canonical owner items, rather than handover rows, own this count.  Filings preserve every
  // original report, but a verbatim re-filing only refreshes its canonical item.
  const untriaged = ownerItems.filter((item) => !item.resolved_at);
  const refilings = ownerItemFilings.filter((item) => !item.resolved_at).length - untriaged.length;
  const openQ = steering.filter((x) => !x.answer);
  const reported = new Set(handovers.map((h) => h.title));
  const silent = roster.filter((r) => !reported.has(r.title));
  // Responses are NOT filtered to this shift: a reply the owner left yesterday that nobody
  // actioned is still open today, and scoping it to the shift would quietly retire it.
  const openResponses = db.prepare(`SELECT * FROM team_responses WHERE actioned_at IS NULL ORDER BY id`).all();
  const allResponses = db.prepare(`SELECT * FROM team_responses ORDER BY id DESC LIMIT 200`).all();

  const badAttrib = steering.filter((x) => x.answer && (!x.by_whom || x.by_whom === 'unknown'));

  // THE OWNER KEPT ALL SIX ON 19 AUG, having been offered the chance to delete any he did not
  // care about. So each is here because he decided it earns its line, not because it was easy
  // to compute — and the `kind` is the label the panel shows, because these are not a sequence
  // and numbering them would imply an order the data does not have.
  const gaps = [
    ['unread', unread.length, `${unread.length} of ${handovers.length} handovers never read`,
      unread.map((h) => h.title),
      'A handover nobody reads is a shift that reported into nothing, and the session that wrote it has no way to know.'],
    ['hanging', trulyStalled.length, `${trulyStalled.length} plan(s) drafted, never put to the manager`,
      trulyStalled.map((d) => `#${d.id}`),
      'Neither confirmed nor returned, and nothing came after them, so nothing can be delegated against them and nothing marks them abandoned.'],
    ['unresolved', maybeSuperseded.length, `${maybeSuperseded.length} draft(s) left open with a later plan behind them`,
      maybeSuperseded.map((d) => `#${d.id}`),
      'Superseded or abandoned — nothing records which, because both leave confirmed_at and returned_at null. Set superseded_by to settle it.'],
    ['undelegated', confirmedNoWork.length, `${confirmedNoWork.length} confirmed plan(s) with no work delegated`,
      confirmedNoWork.map((d) => `#${d.id}`),
      'The chain ran handover to plan to confirm, and stopped. From every other view this looks identical to success.'],
    ['untriaged', untriaged.length, `${untriaged.length} distinct owner-facing ask(s) untriaged`,
      untriaged.map((item) => `${item.title} #${item.id}`),
      `These are the only route a worker has to the owner. Until the manager triages them they reach nobody.${refilings ? ` Counted as DISTINCT ASKS: ${refilings} further filing(s) re-state one of these verbatim, so they update the same item rather than enlarge the queue.` : ''}`],
    ['unanswered', openQ.length, `${openQ.length} steering question(s) waiting on the owner`, [], ''],
    // SILENCE ONLY MEANS SOMETHING ONCE A SHIFT HAS STARTED REPORTING. With zero handovers
    // filed, every session on the roster is "silent" by construction — the evening shift
    // opened with a plan and no handovers and the report accused all ten of filing nothing,
    // which is a damning sentence about people generated by the clock. A shift that has not
    // reported yet is a timestamp; a shift where some reported and others did not is a gap.
    ['silent', handovers.length ? silent.length : 0, `${silent.length} session(s) on the roster filed nothing`,
      silent.map((x) => x.title),
      'Silence and having nothing to say look identical from here, and the second is rare.'],
    ['unattributed', badAttrib.length, `${badAttrib.length} answered question(s) attributed to unknown`, [],
      'This is the one table holding the owner\'s own judgement; an unattributed row cannot be told from a session answering for him.'],
    // THE LOOP RUNNING THE OTHER WAY. Every other gap here is the team failing to reach the
    // owner. This one is the owner reaching the team and nobody picking it up — attention
    // spent into a void, which is the same failure with the arrow reversed and is the easier
    // one to miss, because a reply that was read and ignored leaves exactly the same row as
    // one that was never opened.
    ['unactioned', openResponses.length, `${openResponses.length} of the owner's responses have not been actioned`,
      openResponses.slice(0, 8).map((r) => `${r.kind} ${r.ref}`),
      'He replied and nothing came back. A response with no action is worse than no response, because he has no way to tell which.'],
  ].filter((g) => g[1] > 0).map(([kind, n, head, names, why]) => ({ kind, n, head, names, why }));

  return {
    shift: s,
    handovers,
    plans,
    steering,
    decisions,
    decisionsDue,
    assignments,
    roster,
    ownerItems,
    ownerItemFilings,
    responses: allResponses,
    gaps,
    counts: {
      handovers: handovers.length,
      ownerAsks: untriaged.length,
      ownerRefilings: refilings,
      roster: roster.length,
      plans: plans.length,
      confirmed: plans.filter((x) => x.confirmed_at).length,
      assignments: assignments.length,
      decisions: decisions.length + steering.filter((x) => x.answer).length + plans.filter((x) => x.verdict).length,
      steering: steering.length,
    },
  };
}

router.get('/shifts', (req, res) => res.json({ shifts: shifts() }));
router.get('/report', (req, res) => res.json(reportFor(req.query.shift)));

// -------------------------------------------------------------------------- responses

const VERDICTS = ['agree', 'disagree', 'drop', 'later'];

router.post('/respond', express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.kind || !b.ref) return res.status(400).json({ error: 'kind and ref are required — a response with no target cannot be acted on' });
  if (!b.response || !String(b.response).trim()) return res.status(400).json({ error: 'response is required' });
  if (b.verdict && !VERDICTS.includes(b.verdict)) return res.status(400).json({ error: `verdict must be one of ${VERDICTS.join(', ')}` });
  const info = db.prepare(`
    INSERT INTO team_responses (at, shift, kind, ref, label, response, verdict, by_whom)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(new Date().toISOString(), b.shift || shiftLabel(), b.kind, String(b.ref),
      b.label || null, String(b.response).trim(), b.verdict || null, req.by || 'unknown');
  res.json({ ok: true, id: info.lastInsertRowid });
});

// Every response, or the ones on one item. The panel asks for all of them once and groups
// them itself rather than making a request per row.
router.get('/responses', (req, res) => {
  const { kind, ref, open } = req.query;
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (ref) { where.push('ref = ?'); args.push(String(ref)); }
  if (open === '1') where.push('actioned_at IS NULL');
  res.json({
    responses: db.prepare(`SELECT * FROM team_responses ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 300`).all(...args),
  });
});

// The manager marks a response actioned, with a note saying what was done about it. The note
// is required for the same reason a verdict is: "actioned" with no account of how is
// indistinguishable from someone clearing their queue.
router.post('/responses/:id/actioned', express.json(), (req, res) => {
  // TRIMMED, not merely truthy. "   " is a truthy string, so the first version accepted a
  // whitespace-only note and marked the response actioned with no account of what was done —
  // clearing the unactioned gap while violating the rule this endpoint exists to enforce.
  // The `response` field was already trimmed; these two were not, which is the kind of
  // inconsistency that survives review because both lines read as validation.
  const by = String((req.body || {}).by || '').trim();
  const note = String((req.body || {}).note || '').trim();
  if (!by || !note) return res.status(400).json({ error: 'by and note are both required, and neither may be blank — "actioned" with no account of what was done is a cleared queue, not a closed loop' });
  const row = db.prepare('SELECT * FROM team_responses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such response' });
  if (row.actioned_at) return res.status(409).json({ error: `already actioned by ${row.actioned_by}` });
  db.prepare('UPDATE team_responses SET actioned_at = ?, actioned_by = ?, action_note = ? WHERE id = ?')
    .run(new Date().toISOString(), by, note, row.id);
  return res.json({ ok: true });
});

// --------------------------------------------------------------------------- decisions

// `because` IS REQUIRED, and that refusal is the whole value of the table. A decision with no
// reasoning cannot be reviewed, cannot be argued with later, and cannot be told apart from a
// preference — the workspace rule is that a "no" I cannot justify later is just a mood. The
// same argument that makes a manager's verdict mandatory makes this one mandatory.
router.post('/decision', express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.decision) return res.status(400).json({ error: 'decision is required' });
  if (!b.because) return res.status(400).json({ error: 'because is required — a decision with no reasoning cannot be reviewed later, which is the only reason to record it' });
  if (!b.decided_by) return res.status(400).json({ error: 'decided_by is required' });
  if (b.recheck_at && !isCalendarDate(String(b.recheck_at).trim())) {
    return res.status(400).json({ error: 'recheck_at must be a real YYYY-MM-DD calendar date' });
  }
  const info = db.prepare(`
    INSERT INTO team_decisions (at, shift, decided_by, role, decision, because, cost_if_wrong,
                                revisit_when, recheck_at, supersedes, evidence, by_whom)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(new Date().toISOString(), b.shift || shiftLabel(), b.decided_by, b.role || null,
      b.decision, b.because, b.cost_if_wrong || null, b.revisit_when || null,
      b.recheck_at || null, b.supersedes || null, b.evidence || null, req.by || 'unknown');
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.get('/decisions', (req, res) => {
  if (req.query.due === '1') return res.json(dueDecisions());
  res.json({ state: 'ok', decisions: db.prepare('SELECT * FROM team_decisions ORDER BY id DESC LIMIT 100').all() });
});

// ------------------------------------------------------------------- arbitrations
//
// M340. team_arbitrations was created at :386 and NOTHING has ever been able to
// write to it: zero INSERTs, zero routes, in the whole server tree. The Team
// Manager hit it personally -- they tried to record the M76 Claude-versus-Codex
// arbitration, went looking for the route, and reported the ruling in prose
// because no mechanism existed.
//
// BUILT RATHER THAN DROPPED, on the evidence rather than on sentiment. The
// schema's own comment beside `arbiter_engine` says it exists "so a lean toward
// its own engine is countable" -- that is a designed measurement, and it only
// ever works if rows accumulate. A table with one attempted use and a stated
// analytical purpose is not the dormant-mechanism shape the project rules
// against; a table nobody has ever reached for would be.
//
// WHAT THE TALLY CAN AND CANNOT SAY, stated here because the number will outlive
// this comment. `arbiter_engine` makes engine self-preference COUNTABLE, not
// PROVEN: an arbiter upholding a finding from its own engine may be right. The
// GET returns the counts and refuses to compute a rate, because a bias figure off
// a handful of rulings is exactly the forecast-from-thin-data this workspace
// forbids. Read the rulings; the tally only tells you where to look.
router.post('/arbitration', express.json(), (req, res) => {
  const b = req.body || {};
  for (const f of ['finding', 'claimed_by', 'disputed_by', 'arbiter', 'ruling', 'because']) {
    if (!String(b[f] || '').trim()) return res.status(400).json({ error: `${f} is required` });
  }
  const ruling = String(b.ruling).trim().toLowerCase();
  if (!['upheld', 'rejected'].includes(ruling)) {
    return res.status(400).json({ error: "ruling must be 'upheld' or 'rejected'" });
  }
  // The arbiter must not be either disputant. An arbitration decided by one of
  // the two sides is not an arbitration, and the row would still read like one
  // afterwards -- which is worse than refusing it now.
  const arbiter = String(b.arbiter).trim();
  if (arbiter === String(b.claimed_by).trim() || arbiter === String(b.disputed_by).trim()) {
    return res.status(409).json({
      error: 'the arbiter may not be one of the disputants',
      why: `${arbiter} is a side in this dispute. A ruling by a party to it reads identically to a `
         + 'neutral one once written down, so it is refused rather than recorded and caveated.',
    });
  }
  // NOT resolved by lookup alone: engineOf returns null for a retired or
  // unregistered session, and null must not silently become "unknown engine" in a
  // column whose entire purpose is counting engines. Take the caller's value when
  // the roster cannot answer, and say which it was.
  const looked = engineOf(arbiter);
  const arbiterEngine = looked || String(b.arbiter_engine || '').trim();
  if (!arbiterEngine) {
    return res.status(400).json({
      error: 'arbiter_engine could not be established',
      why: `${arbiter} is not on the roster, so the engine cannot be looked up. Pass arbiter_engine `
         + 'explicitly, or register the session. An arbitration with an unknown engine cannot answer '
         + 'the one question this table exists to answer.',
    });
  }
  const info = db.prepare(`
    INSERT INTO team_arbitrations (at, review_id, finding, claimed_by, disputed_by,
                                   arbiter, arbiter_engine, ruling, because)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(new Date().toISOString(), b.review_id || null, String(b.finding).trim(),
      String(b.claimed_by).trim(), String(b.disputed_by).trim(), arbiter, arbiterEngine,
      ruling, String(b.because).trim());
  res.json({ ok: true, id: info.lastInsertRowid, arbiter_engine: arbiterEngine,
    engine_source: looked ? 'roster' : 'supplied by caller' });
});

router.get('/arbitrations', (req, res) => {
  const rows = db.prepare('SELECT * FROM team_arbitrations ORDER BY id DESC LIMIT 100').all();
  // Counts, never a rate. See the note above the POST.
  const sameEngine = rows.filter((r) => engineOf(r.claimed_by) === r.arbiter_engine);
  res.json({
    state: 'ok',
    arbitrations: rows,
    tally: {
      total: rows.length,
      upheld: rows.filter((r) => r.ruling === 'upheld').length,
      rejected: rows.filter((r) => r.ruling === 'rejected').length,
      arbiter_shared_engine_with_claimant: sameEngine.length,
      upheld_where_arbiter_shared_claimant_engine: sameEngine.filter((r) => r.ruling === 'upheld').length,
      note: 'Counts only. No rate is computed: a self-preference figure off a handful of rulings '
          + 'would be a forecast from thin data. These say where to read, not what happened.',
    },
  });
});


// ---------------------------------------------------------------------------
// THE SCRIBE -- owner decision, 20 August 2026.
//
// "I want the free model to do actual work should all my subscriptions hit the weekly
// or session caps." Claude Code is capped weekly, Codex runs on a subscription, and a
// model on this machine has no cap at all. So the Scribe is a CONTINUITY tier: the
// thing that still turns when the paid ones stop.
//
// What keeps it honest is that it can only do jobs somebody MEASURED it doing. The
// capability table ships empty and an unmeasured job is refused rather than attempted.
// ---------------------------------------------------------------------------

router.get('/scribe', (req, res) => {
  const caps = db.prepare('SELECT * FROM scribe_capabilities ORDER BY job').all();
  const proven = caps.filter(c => scribe.scribeCan(db, c.job).allowed);
  res.json({
    capabilities: caps.map(c => ({ ...c, gate: scribe.scribeCan(db, c.job) })),
    proven_count: proven.length,
    // Said explicitly, because a UI that renders an empty list without this sentence
    // reads as 'nothing is wrong' when it means 'nothing has been established'.
    state: caps.length === 0
      ? 'NOTHING MEASURED YET. The Scribe can currently do no work at all, and that is the '
        + 'shipped state rather than a fault. Each job it may take has to be scored against '
        + 'an oracle first.'
      : proven.length + ' of ' + caps.length + ' jobs proven.',
    custody: scribe.CUSTODY,
    capped: scribe.cappedTiers(db),
    measurement_ttl_days: scribe.MEASUREMENT_TTL_DAYS,
    recent_runs: db.prepare('SELECT * FROM scribe_runs ORDER BY at DESC LIMIT 25').all(),
  });
});

// Record a measurement. This is the ONLY way a capability becomes usable.
//
// oracle and sample_n are required and the request is refused without them: a score with
// no stated source is the shape of a number somebody assumed, and this table exists
// specifically so that cannot happen quietly.
router.post('/scribe/measure', express.json(), (req, res) => {
  const b = req.body || {};
  const job = String(b.job || '').trim();
  if (!job) return res.status(400).json({ error: 'job is required' });
  if (b.score === undefined || b.score === null) return res.status(400).json({ error: 'score is required' });
  if (!b.oracle) return res.status(400).json({
    error: 'oracle is required',
    why: 'A score with no stated source cannot be audited, and a model scored against an '
       + 'oracle it supplied itself is not scored at all. Name where the truth came from.',
  });
  if (!b.sample_n) return res.status(400).json({
    error: 'sample_n is required',
    why: 'An accuracy figure without its denominator hides whether it came from 12 items or 1200.',
  });

  const score = Number(b.score);
  const floor = b.floor === undefined ? 0.8 : Number(b.floor);
  const status = score >= floor ? 'proven' : 'failed';

  db.prepare(
    'INSERT INTO scribe_capabilities (job, status, score, floor, sample_n, oracle, misses, residue, model, measured_at, measured_by, notes) '
  + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?) '
  + 'ON CONFLICT(job) DO UPDATE SET status=excluded.status, score=excluded.score, floor=excluded.floor, '
  + 'sample_n=excluded.sample_n, oracle=excluded.oracle, misses=excluded.misses, residue=excluded.residue, '
  + 'model=excluded.model, measured_at=excluded.measured_at, measured_by=excluded.measured_by, notes=excluded.notes'
  ).run(job, status, score, floor, Number(b.sample_n), String(b.oracle),
        b.misses ? JSON.stringify(b.misses) : null,
        b.residue ? String(b.residue) : null,
        b.model ? String(b.model) : null,
        new Date().toISOString(), b.measured_by ? String(b.measured_by) : null,
        b.notes ? String(b.notes) : null);

  res.json({ ok: true, job, status, score, floor, gate: scribe.scribeCan(db, job) });
});

// Declare a paid tier spent. Nothing here can SEE a quota, so this is asserted, never
// detected -- and an undeclared cap leaves the Scribe idle, which is the safe way to be
// wrong. `until` may be null, meaning 'until somebody clears it'.
router.post('/scribe/cap', express.json(), (req, res) => {
  const b = req.body || {};
  const tier = String(b.tier || '').trim();
  if (!tier) return res.status(400).json({ error: 'tier is required (claude | codex | ollama-cloud)' });
  db.prepare('INSERT INTO scribe_caps (tier, declared_at, declared_by, until, note) VALUES (?,?,?,?,?)')
    .run(tier, new Date().toISOString(), b.declared_by ? String(b.declared_by) : null,
         b.until ? String(b.until) : null, b.note ? String(b.note) : null);
  res.json({ ok: true, capped: scribe.cappedTiers(db) });
});

router.post('/scribe/uncap', express.json(), (req, res) => {
  const tier = String((req.body || {}).tier || '').trim();
  if (!tier) return res.status(400).json({ error: 'tier is required' });
  const now = new Date().toISOString();
  const r = db.prepare('UPDATE scribe_caps SET until = ? WHERE tier = ? AND (until IS NULL OR until > ?)')
    .run(now, tier, now);
  // `changes` counts rows MATCHED, not rows meaningfully altered -- an inert run prints
  // the same number -- so say what was matched rather than claiming what was fixed.
  res.json({ ok: true, rows_matched: r.changes, capped: scribe.cappedTiers(db) });
});


// --- THE REVIEW QUEUE ------------------------------------------------------
// Owner decision, 20 Aug 2026: "well being can write BUT gets reviewed before it can
// enact." A proposal is inert by construction -- it is a row in its own table and no
// reader of the wellbeing module can see it -- so 'cannot enact before review' is a
// property of the mechanism rather than a rule a writer has to remember.

router.post('/scribe/propose', express.json(), (req, res) => {
  const b = req.body || {};
  const module_ = String(b.module || '').trim();
  const field = String(b.field || '').trim();
  const targetTable = String(b.target_table || '').trim();
  // target_table is required, and the column is NOT NULL to match. A proposal that does
  // not say where it would land cannot be reviewed -- the reviewer would be approving a
  // value with no destination. The first version of this route let it through and the
  // insert failed with a raw constraint error, which is the wrong place to find out.
  if (!module_ || !field || !targetTable) {
    return res.status(400).json({
      error: 'module, field and target_table are required',
      why: 'A proposal with no destination cannot be reviewed: there is no diff to show.',
    });
  }

  const custody = scribe.custodyAllows(module_, 'scribe', 'write');
  if (!custody.allowed && !custody.requires_review) {
    return res.status(403).json({ error: 'refused', why: custody.why });
  }

  // The clause the owner did not change. Enforced on CONTENT, so review cannot clear it.
  let check = null;
  if (module_ === 'wellbeing') {
    check = scribe.wellbeingContentCheck(field, b.proposed_value);
    if (check.blocked) {
      scribe.recordRun(db, { job: b.job, model: b.model, items: 1, wrote: 0, refused: 1,
        reason: 'content-blocked', detail: { field, why: check.why } });
      return res.status(403).json({ error: 'refused on content', why: check.why });
    }
  }

  // Read what this would replace, NOW, so the reviewer sees the change and so enactment
  // can tell whether the ground moved underneath the proposal.
  let current = null;
  if (b.target_id) {
    try {
      const row = db.prepare('SELECT * FROM ' + targetTable.replace(/[^a-z_]/gi, '') +
                             ' WHERE id = ?').get(b.target_id);
      current = row ? String(row[field] == null ? '' : row[field]) : null;
    } catch (e) { current = null; }
  }

  const info = db.prepare(
    'INSERT INTO scribe_proposals (job, module, target_table, target_id, field, proposed_value, '
  + 'current_value, reason, model, created_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(b.job || null, module_, targetTable, b.target_id || null, field,
        b.proposed_value == null ? null : String(b.proposed_value), current,
        b.reason || null, b.model || null, new Date().toISOString(), 'pending');

  scribe.recordRun(db, { job: b.job, model: b.model, items: 1, wrote: 0, refused: 0,
    reason: 'proposed, awaiting review', detail: { proposal: info.lastInsertRowid } });

  res.json({ ok: true, proposal_id: info.lastInsertRowid, status: 'pending',
             content_check: check, enacted: false,
             note: 'Recorded as a proposal. It has NO effect until reviewed.' });
});

router.get('/scribe/proposals', (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db.prepare('SELECT * FROM scribe_proposals WHERE status = ? ORDER BY created_at DESC').all(status);
  res.json({
    status, count: rows.length,
    proposals: rows.map(r => ({
      ...r,
      // Recomputed at READ time, not stored -- a flag stored at propose time would go on
      // describing text that has since been edited.
      content_check: r.module === 'wellbeing' ? scribe.wellbeingContentCheck(r.field, r.proposed_value) : null,
    })),
    // Said out loud because an empty pending list and a broken query render identically.
    state: rows.length === 0 ? 'No proposals with status ' + status + '. This is a real count, not a failed read.' : null,
  });
});

// Approve or reject. Approval ENACTS in the same call, because a queue with an approved
// state that nothing acts on is a queue that silently does nothing.
router.post('/scribe/proposals/:id/review', express.json(), (req, res) => {
  const b = req.body || {};
  const p = db.prepare('SELECT * FROM scribe_proposals WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'no such proposal' });
  if (p.status !== 'pending') return res.status(409).json({ error: 'already ' + p.status });

  const by = String(b.reviewed_by || '').trim();
  if (!by) return res.status(400).json({ error: 'reviewed_by is required' });

  // WELLBEING IS REVIEWED BY THE OWNER, not by a session. This is his own health data,
  // and a worker approving a statement about his mood is not the review he asked for.
  // Flagged for him rather than assumed: if he wants it delegated he can say so.
  if (p.module === 'wellbeing' && by !== 'you') {
    return res.status(403).json({
      error: 'wellbeing is reviewed by the owner',
      why: 'This is the owner\'s own health data. A session approving a statement about his mood '
         + 'is not the review the decision asked for. Send reviewed_by="you" from the dashboard, '
         + 'or have the owner relax this explicitly.',
    });
  }

  const now = new Date().toISOString();
  const approve = b.decision === 'approve';

  if (!approve) {
    db.prepare('UPDATE scribe_proposals SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?')
      .run('rejected', by, now, b.note || null, p.id);
    return res.json({ ok: true, status: 'rejected' });
  }

  // STALENESS. Between proposing and approving, the row can move -- another session, an
  // import, the owner. Enacting against a value that has changed silently overwrites
  // whatever replaced it, and the reviewer approved a diff that no longer exists.
  if (p.target_table && p.target_id) {
    let live = null;
    try {
      const row = db.prepare('SELECT * FROM ' + String(p.target_table).replace(/[^a-z_]/gi, '') +
                             ' WHERE id = ?').get(p.target_id);
      live = row ? String(row[p.field] == null ? '' : row[p.field]) : null;
    } catch (e) { live = null; }

    if (String(live) !== String(p.current_value)) {
      db.prepare('UPDATE scribe_proposals SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?')
        .run('stale', by, now, 'Value moved between proposal and approval.', p.id);
      return res.status(409).json({
        error: 'stale', enacted: false,
        why: 'The value changed after this was proposed, so the diff reviewed is not the diff that '
           + 'would be applied. Re-propose against the current value.',
        was: p.current_value, now: live,
      });
    }

    db.prepare('UPDATE ' + String(p.target_table).replace(/[^a-z_]/gi, '') +
               ' SET ' + String(p.field).replace(/[^a-z_]/gi, '') + ' = ? WHERE id = ?')
      .run(p.proposed_value, p.target_id);
  }

  db.prepare('UPDATE scribe_proposals SET status=?, reviewed_by=?, reviewed_at=?, review_note=?, enacted_at=? WHERE id=?')
    .run('enacted', by, now, b.note || null, now, p.id);
  scribe.recordRun(db, { job: p.job, model: p.model, items: 1, wrote: 1, refused: 0,
    reason: 'enacted after review by ' + by, detail: { proposal: p.id } });

  res.json({ ok: true, status: 'enacted', enacted_at: now });
});


// ---------------------------------------------------------------------------
// THE DAILY STEERING QUESTION, COMPOSED WITHOUT A MANAGER
//
// Owner instruction, 19 Aug: "The team manager will quiz the owner every day to get
// steering directions." Measured on 20 Aug: it had run ONCE, ever. Not because anyone
// refused -- because the question required a live manager session to type it, and for
// twelve of the last fourteen hours there wasn't one.
//
// A capability that only works when the right session happens to be awake is not a
// capability. So the briefing pass composes it, from data.
//
// THE HARD PART IS NOT ASKING -- IT IS NOT ASKING.
// 'An alert you learn to dismiss is worse than no alert, because it teaches you to
// ignore the channel.' A daily question that fires whether or not anything needs
// deciding trains exactly that. So this returns NOTHING unless there is a real
// candidate, and 'nothing to ask' is reported as its own state rather than as silence.
//
// AND THE RECOMMENDATION IS ARITHMETIC, NEVER JUDGEMENT.
// The endpoint refuses a question with no recommendation, on the grounds that a question
// without one hands the thinking back. That rule was written for a reasoning author. A
// job that assembles a question from a COUNT cannot honour it the same way, so the
// recommendation here is always something derivable and checkable -- the oldest, the
// most-refiled -- and it says which, so it can be audited rather than trusted.
// THE canonical answer to "what is outstanding for the owner", and the only one.
//
// Two things it does that a bare COUNT(*) does not.
//
// It DROPS the parse artefacts. A handover that writes "- None" under Blocked on you
// produces an owner item saying "None", and six of the thirty-three unresolved rows were
// that. Codex had already spotted one by hand and resolved it with the note "filed
// inadvertently". Counting them inflates the headline by 22% with rows that ask nothing.
//
// And it REPORTS WHAT IT DROPPED. A filter that quietly removes rows makes the survivors
// look cleaner than they are, and it always fails flatteringly -- if the None-matcher were
// too greedy it would silently eat real asks and the count would just look better. So the
// residue is returned alongside the answer, and every caller can print it.
//
// NOTE THE SCOPE, because there is a second number with the same name: the shift report's
// `gaps` says "N distinct owner-facing ask(s) untriaged" for ONE SHIFT. This is all-time
// outstanding. Both are right; they answer different questions, and the briefing says
// 'outstanding' rather than 'untriaged' so the two cannot be read as the same figure.
// A handover that writes "- None" under Blocked on you still produces an owner-item row.
// Six of thirty-three unresolved rows were exactly that, and Codex had already resolved
// one by hand with the note "filed inadvertently".
//
// Exported so every reader uses the SAME test. It was inlined in openOwnerItems first, and
// fromTeam went on pushing the rows it dropped -- a shared fix only reaches the callers
// that actually call it, and the ones that bypass it keep the bug.
function isNoneOwnerItem(text) {
  return /^[-*\s]*(none|n\/a|nothing)\b/i.test(String(text == null ? '' : text).trim());
}

function openOwnerItems() {
  let rows;
  try {
    rows = db.prepare('SELECT id, title, text, first_seen_at FROM team_owner_items WHERE resolved_at IS NULL ORDER BY id ASC').all();
  } catch (e) {
    return { ok: false, why: 'team_owner_items unreadable: ' + e.message };
  }
  const isNone = isNoneOwnerItem;
  const dropped = rows.filter((r) => isNone(r.text));
  const items = rows.filter((r) => !isNone(r.text));
  return {
    ok: true, items, count: items.length,
    residue: { dropped: dropped.length, why: 'handover said None under Blocked on you', ids: dropped.map((d) => d.id) },
    total_rows: rows.length,
  };
}

// TRUNCATE ON A BOUNDARY, NOT A CHARACTER COUNT. M338.
//
// The steering question quotes the oldest owner item and closed the quote after a
// raw slice(0,160), so every rendering ended mid-sentence on an open quotation
// mark -- twelve times across the three blocks in the 23 Aug briefing. A cut like
//
//     "- **Chrome extension has been unreachable since ~15:20**, so both itch
//      items above (upload, description) could n
//
// reads as corruption rather than as an excerpt, and the reader cannot tell
// whether the sentence mattered.
//
// Prefer a sentence end, then a word boundary, and only fall back to a hard cut
// when a single token is longer than the budget. The ellipsis is what makes it an
// excerpt: without a visible marker a boundary-truncated line reads as the whole
// item, which is a worse failure than an ugly one -- it is a silent one.
//
// The search window is the last 40% of the budget. Cutting back further to reach
// a full stop would drop more than it keeps, and an excerpt that discards half
// its content to look tidy is optimising the wrong thing.
function clip(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const window = Math.floor(max * 0.6);
  const head = t.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (sentence >= window) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(' ');
  if (word >= window) return head.slice(0, word).replace(/[,;:\-*\s]+$/, '') + '…';
  return head.replace(/[,;:\-*\s]+$/, '') + '…';
}

function ensureSteering(opts) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const already = db.prepare('SELECT id, asked_by FROM team_steering WHERE substr(asked_at,1,10) = ?').get(today);
  if (already) {
    return { asked: false, state: 'already-asked-today', id: already.id, by: already.asked_by || 'a session' };
  }

  // Candidate 1: owner-facing items raised in handovers and never triaged.
  let items = [];
  try {
    const oi = openOwnerItems();
    if (!oi.ok) return { asked: false, state: 'could-not-look', why: oi.why };
    items = oi.items;
  } catch (e) {
    // COULD NOT LOOK. Must not be reported as 'nothing to ask' -- a broken read and an
    // empty queue are the failure this whole codebase keeps re-learning to separate.
    return { asked: false, state: 'could-not-look', why: 'team_owner_items unreadable: ' + e.message };
  }

  // Candidate 2: decisions whose revisit_when date has arrived.
  let due = [];
  try {
    due = db.prepare(
      'SELECT id, decision, revisit_when FROM team_decisions '
    + " WHERE revisit_when IS NOT NULL AND revisit_when <> '' AND revisit_when <= ? "
    + ' ORDER BY revisit_when ASC'
    ).all(today);
  } catch (e) { due = []; }

  if (!items.length && !due.length) {
    return { asked: false, state: 'nothing-to-ask',
             why: 'No untriaged owner item and no decision due for revisit. Asking anyway would '
                + 'teach the owner to dismiss this channel.' };
  }

  let question, options, recommend;
  // M348: what this question is ABOUT, recorded at composition so answering can resolve it.
  // The ids are in the same order as `options`, so option[n] is refIds[n] -- the caller
  // answering with a choice can name exactly what it closed without re-deriving anything.
  let refKind = null, refIds = [];

  if (items.length) {
    const oldest = items[0];
    // No age claim here: first_seen_at is when the ITEM ROW was written, not when the ask
    // was raised, and it printed '0 days' for an ask filed yesterday. The count is the claim.
    question = items.length + ' owner item' + (items.length === 1 ? '' : 's') + ' raised in handovers '
             + 'are still outstanding. The earliest is: "'
             + clip(oldest.text || oldest.title, 160) + '"';
    options = items.slice(0, 4).map(i => clip(i.text || i.title, 120));
    recommend = 'Take the oldest first (#' + oldest.id + '). This is arithmetic, not judgement: it is '
              + 'the earliest first_seen_at of ' + items.length + ' unresolved rows, chosen because it has '
              + 'been waiting longest and for no other reason. If another matters more, that is exactly '
              + 'the steer this question exists to collect.';
    refKind = 'owner_item';
    refIds = items.slice(0, 4).map(i => i.id);
  } else {
    const d = due[0];
    question = due.length + ' decision' + (due.length === 1 ? '' : 's') + ' reached the date it was marked '
             + 'for revisiting. The earliest is #' + d.id + ' (' + d.revisit_when + '): "'
             + clip(d.decision, 160) + '"';
    options = due.slice(0, 4).map(x => '#' + x.id + ' (' + x.revisit_when + ') ' + clip(x.decision, 100));
    recommend = 'Revisit #' + d.id + ' first -- it is the earliest revisit_when that has passed. Arithmetic, '
              + 'not a view about which matters most.';
    // Decisions are NOT given a ref_kind that answering can act on. A due decision is
    // revisited by taking a new decision that supersedes it, which is a judgement with a
    // rationale -- not a row to mark closed. Recording it as resolvable would invite the
    // answer path to clear a revisit date and call that a decision having been revisited.
    refKind = 'decision_due';
    refIds = due.slice(0, 4).map(x => x.id);
  }

  const info = db.prepare(
    'INSERT INTO team_steering (asked_at, shift, question, options, recommend, asked_by, source, ref_kind, ref_ids) '
  + 'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(now.toISOString(), shiftLabel(), question, JSON.stringify(options), recommend,
        'briefing-auto', 'composed from SQL, not written by a session',
        refKind, JSON.stringify(refIds));

  return { asked: true, id: info.lastInsertRowid, question, recommend, options,
           note: 'Composed by the briefing pass, not by a manager. The recommendation is arithmetic.' };
}

router.post('/steering/ensure', express.json(), (req, res) => res.json(ensureSteering(req.body || {})));

module.exports = router;
module.exports.shiftView = shiftView;
module.exports.shiftLabel = shiftLabel;
module.exports.openSteering = openSteering;
module.exports.reportFor = reportFor;
module.exports.dueDecisions = dueDecisions;
module.exports.shifts = shifts;
module.exports.ROLES = ROLES;
module.exports.CHAIN_ROLES = CHAIN_ROLES;
module.exports.ownerItemKey = ownerItemKey;
module.exports.ownerItemsFromBlock = ownerItemsFromBlock;

module.exports.ensureSteering = ensureSteering;
module.exports.openOwnerItems = openOwnerItems;
module.exports.isNoneOwnerItem = isNoneOwnerItem;
