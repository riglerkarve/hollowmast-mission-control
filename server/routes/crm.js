'use strict';
//
// crm.js — who pays you, who has gone quiet, and what you said you would do about it.
//
// Owner request, 20 August 2026: "Add inventory control, crm", and when asked how far it
// should go, "Full CRM with pipeline and follow-ups".
//
// THE GATE, AND HOW THIS PASSES IT.
// A CRM is the archetype of the module this workspace rejects: you type in contacts and it
// shows you your contacts back. The version built here is different in one specific way --
// THE CLIENT LIST IS NOT TYPED. There are 218 distinct inbound counterparties sitting in
// the ledger already, and finance can tell you, per client, how much and how often and how
// long ago. That is derived, and it says something you did not enter: 63 of them are
// silent past twice their own payment cadence.
//
// So the split is deliberate:
//   DERIVED, never stored  — payments, totals, first/last date, average gap, lapsed
//   STORED, cannot derive  — is this actually a client, what stage, what did you promise
//
// Storing a total here would be the second place that number lives. The panel asks finance
// every time.
//
// ENDPOINTS
//   GET  /api/crm/clients            — tracked clients, joined to their derived history
//   GET  /api/crm/candidates         — ledger counterparties NOT yet tracked, richest first
//   POST /api/crm/clients            — start tracking one { counterparty, stage?, note? }
//   PATCH /api/crm/clients/:id       — stage, contact details, note
//   DELETE /api/crm/clients/:id      — stop tracking (does not touch the ledger)
//   GET  /api/crm/followups          — what you owe people, soonest first
//   POST /api/crm/followups          — { client_id, what, due_on }
//   POST /api/crm/followups/:id/done — mark done { note? }
//   GET  /api/crm/lapsed             — tracked clients past 2x their own cadence
//
const express = require('express');
const db = require('../db.js');
const finance = require('./finance.js');

const router = express.Router();

// The stages a client moves through. An ENUM rather than free text, because a pipeline
// whose stage names drift is a pipeline you cannot count.
const STAGES = ['lead', 'quoted', 'active', 'dormant', 'lost'];

db.migrate('crm', [
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS crm_clients (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        counterparty TEXT NOT NULL UNIQUE,   -- the ledger key. This is the JOIN to finance,
                                             -- and the only thing copied from it.
        display_name TEXT,                   -- what you call them, if not the bank string
        stage        TEXT NOT NULL DEFAULT 'active',
        contact_name TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        note         TEXT,
        tracked_at   TEXT NOT NULL,
        tracked_by   TEXT
      );

      -- What you said you would do, and by when. This is the half a CRM cannot derive:
      -- nothing in a bank statement records that you promised someone a quote on Friday.
      CREATE TABLE IF NOT EXISTS crm_followups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id  INTEGER NOT NULL,
        what       TEXT NOT NULL,
        due_on     TEXT,
        created_at TEXT NOT NULL,
        done_at    TEXT,
        done_note  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_crm_followups_due ON crm_followups(done_at, due_on);
    `);
  },
]);

// Derived history for one counterparty, from FINANCE. Never from finance_transactions.
//
// Built once per request into a Map rather than called per client: the accessor groups the
// whole ledger each time, so calling it inside a loop over 174 clients would regroup 6,839
// rows 174 times.
function historyIndex() {
  const idx = new Map();
  try {
    for (const r of finance.counterparties({ direction: 'in' })) idx.set(r.counterparty, r);
  } catch (e) {
    return { ok: false, why: 'finance.counterparties() failed: ' + e.message, idx };
  }
  return { ok: true, idx };
}

function shape(row, hist) {
  const h = hist ? hist.get(row.counterparty) : null;
  return {
    ...row,
    // null means "finance has no record of this counterparty", which is a different thing
    // from zero payments and must not render as GBP 0.00.
    history: h || null,
    history_state: h ? 'derived from the ledger' : 'no ledger record for this counterparty',
  };
}

router.get('/clients', (req, res) => {
  const rows = db.prepare('SELECT * FROM crm_clients ORDER BY stage, counterparty').all();
  const h = historyIndex();
  const out = rows.map((r) => shape(r, h.idx));
  const open = db.prepare('SELECT client_id, COUNT(*) n FROM crm_followups WHERE done_at IS NULL GROUP BY client_id').all();
  const byClient = new Map(open.map((o) => [o.client_id, o.n]));
  res.json({
    clients: out.map((c) => ({ ...c, open_followups: byClient.get(c.id) || 0 })),
    count: out.length,
    stages: STAGES,
    // Absence and failure must not look the same: an empty list because nothing is tracked
    // reads identically to an empty list because the ledger could not be read.
    state: !h.ok ? 'LEDGER UNREADABLE: ' + h.why
         : out.length === 0 ? 'No clients tracked yet. GET /api/crm/candidates lists who the ledger already knows pays you.'
         : null,
  });
});

// Everyone the ledger says pays you, who is not yet tracked. This is the derived half and
// the reason the module passes the gate -- the list exists before you type anything.
router.get('/candidates', (req, res) => {
  const h = historyIndex();
  if (!h.ok) return res.status(503).json({ error: 'ledger unreadable', why: h.why });

  const tracked = new Set(db.prepare('SELECT counterparty FROM crm_clients').all().map((r) => r.counterparty));

  // Own transfers and benefits are not clients. finance already knows which counterparties
  // look like the owner moving his own money -- ask it rather than inventing a rule here.
  let ownSuspects = new Set();
  let ownState = null;
  try {
    const s = finance.ownTransferSuspects();
    // The field is `ownTransferStrings`. The first version of this guessed `s.suspects`,
    // got undefined, fell back to [], excluded nothing -- and still reported success.
    // A guessed field name that misses is indistinguishable from a filter with nothing to
    // do, and it fails FLATTERINGLY: the candidate list looked clean while the owner's own
    // name sat at the top of it.
    if (!s || s.ok === false) {
      ownState = 'COULD NOT EXCLUDE own transfers: ' + ((s && s.message) || 'accessor reported not-ok')
               + ' -- the list below still contains them and is NOT a clean client list';
    } else if (!Array.isArray(s.ownTransferStrings)) {
      ownState = 'COULD NOT EXCLUDE own transfers: finance.ownTransferSuspects() returned no '
               + 'ownTransferStrings array (shape changed?) -- the list below is NOT clean';
    } else {
      ownSuspects = new Set(s.ownTransferStrings.filter(Boolean));
      ownState = 'excluded ' + ownSuspects.size + ' own-transfer string(s) via finance.ownTransferSuspects()';
    }
  } catch (e) {
    ownState = 'COULD NOT EXCLUDE own transfers (' + e.message.slice(0, 60) + ') -- the list below '
             + 'therefore still contains your own transfers and is NOT a clean client list';
  }

  const minPence = Number(req.query.min_pence || 5000);
  const all = [...h.idx.values()];
  const candidates = all.filter((c) => !tracked.has(c.counterparty)
                                    && !ownSuspects.has(c.counterparty)
                                    && c.total_pence >= minPence);

  res.json({
    candidates,
    count: candidates.length,
    // A filter must report its residue. Three things were dropped and each for a different
    // reason, so each is counted separately -- a single "filtered N" would hide which.
    residue: {
      already_tracked: all.filter((c) => tracked.has(c.counterparty)).length,
      own_transfers: all.filter((c) => ownSuspects.has(c.counterparty)).length,
      below_min: all.filter((c) => c.total_pence < minPence).length,
      min_pence: minPence,
      own_transfer_state: ownState,
    },
    not_keyed_on: [
      'whether a payment was for work or a refund',
      'one-off payers who happen to exceed the threshold',
      'counterparties whose bank string changed between payments -- these appear twice',
    ],
  });
});

router.post('/clients', express.json(), (req, res) => {
  const b = req.body || {};
  const cp = String(b.counterparty || '').trim();
  if (!cp) return res.status(400).json({ error: 'counterparty is required -- it is the ledger key' });
  const stage = b.stage ? String(b.stage) : 'active';
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'stage must be one of: ' + STAGES.join(', ') });

  const exists = db.prepare('SELECT id FROM crm_clients WHERE counterparty = ?').get(cp);
  if (exists) return res.status(409).json({ error: 'already tracked', id: exists.id });

  const info = db.prepare(
    'INSERT INTO crm_clients (counterparty, display_name, stage, contact_name, contact_email, contact_phone, note, tracked_at, tracked_by) '
  + 'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(cp, b.display_name || null, stage, b.contact_name || null, b.contact_email || null,
        b.contact_phone || null, b.note || null, new Date().toISOString(), req.get('x-mc-by') || null);

  const h = historyIndex();
  const row = db.prepare('SELECT * FROM crm_clients WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, client: shape(row, h.idx) });
});

router.patch('/clients/:id', express.json(), (req, res) => {
  const b = req.body || {};
  const row = db.prepare('SELECT * FROM crm_clients WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such client' });
  if (b.stage && !STAGES.includes(String(b.stage))) {
    return res.status(400).json({ error: 'stage must be one of: ' + STAGES.join(', ') });
  }
  const fields = ['display_name', 'stage', 'contact_name', 'contact_email', 'contact_phone', 'note'];
  const set = [], vals = [];
  for (const f of fields) if (b[f] !== undefined) { set.push(f + ' = ?'); vals.push(b[f] === null ? null : String(b[f])); }
  if (!set.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(row.id);
  db.prepare('UPDATE crm_clients SET ' + set.join(', ') + ' WHERE id = ?').run(...vals);
  const h = historyIndex();
  res.json({ ok: true, client: shape(db.prepare('SELECT * FROM crm_clients WHERE id = ?').get(row.id), h.idx) });
});

router.delete('/clients/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM crm_clients WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such client' });
  db.prepare('DELETE FROM crm_followups WHERE client_id = ?').run(row.id);
  db.prepare('DELETE FROM crm_clients WHERE id = ?').run(row.id);
  // Said explicitly because deleting a "client" sounds like it might touch money.
  res.json({ ok: true, removed: row.counterparty, note: 'Stopped tracking. No ledger data was changed.' });
});

router.get('/followups', (req, res) => {
  const rows = db.prepare(
    'SELECT f.*, c.counterparty, c.display_name FROM crm_followups f '
  + '  JOIN crm_clients c ON c.id = f.client_id '
  + ' WHERE f.done_at IS NULL ORDER BY (f.due_on IS NULL), f.due_on ASC'
  ).all();
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    followups: rows.map((r) => ({ ...r, overdue: !!(r.due_on && r.due_on < today) })),
    count: rows.length,
    overdue: rows.filter((r) => r.due_on && r.due_on < today).length,
    state: rows.length === 0 ? 'Nothing outstanding. This is a real count, not a failed read.' : null,
  });
});

router.post('/followups', express.json(), (req, res) => {
  const b = req.body || {};
  const what = String(b.what || '').trim();
  if (!b.client_id || !what) return res.status(400).json({ error: 'client_id and what are required' });
  const c = db.prepare('SELECT id FROM crm_clients WHERE id = ?').get(b.client_id);
  if (!c) return res.status(404).json({ error: 'no such client' });
  const info = db.prepare('INSERT INTO crm_followups (client_id, what, due_on, created_at) VALUES (?,?,?,?)')
    .run(c.id, what, b.due_on || null, new Date().toISOString());
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.post('/followups/:id/done', express.json(), (req, res) => {
  const row = db.prepare('SELECT * FROM crm_followups WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such followup' });
  if (row.done_at) return res.status(409).json({ error: 'already done', at: row.done_at });
  db.prepare('UPDATE crm_followups SET done_at = ?, done_note = ? WHERE id = ?')
    .run(new Date().toISOString(), (req.body || {}).note || null, row.id);
  res.json({ ok: true });
});

// Tracked clients who have gone quiet past twice their OWN cadence. A fixed threshold would
// flag a client who pays yearly and miss one who pays weekly.
router.get('/lapsed', (req, res) => {
  const h = historyIndex();
  if (!h.ok) return res.status(503).json({ error: 'ledger unreadable', why: h.why });
  const rows = db.prepare("SELECT * FROM crm_clients WHERE stage NOT IN ('lost')").all();
  const withH = rows.map((r) => shape(r, h.idx));
  const lapsed = withH.filter((c) => c.history && c.history.lapsed === true);
  res.json({
    lapsed, count: lapsed.length,
    // `lapsed: null` means there is no cadence to judge against -- one payment gives no
    // rhythm, and guessing one would manufacture a finding.
    unjudgeable: withH.filter((c) => c.history && c.history.lapsed === null).length,
    no_ledger_record: withH.filter((c) => !c.history).length,
    basis: 'silent for more than twice that client\'s own average gap between payments',
  });
});

module.exports = router;
module.exports.STAGES = STAGES;
