'use strict';

// PROVENANCE — who wrote a row. Backlog #38, and the prerequisite for #16.
//
// The problem it solves, measured: on 18 Aug the richest timestamped table in the database
// was `todo_items.decided_at`, 94 rows — and nearly every recent one was written by a Claude
// session closing backlog items, not by the owner. Any feature that derives "what you do
// repeatedly" or "when you were working" from those rows would report MY footprint as the
// owner's habits. That is not a rough proxy; it is fabricated data about a person.
//
// THE DEFAULT IS 'unknown', NOT 'you'. A request that does not say who it is gets recorded
// as unknown, because guessing 'you' is exactly the error this exists to prevent, and an
// honest gap can be filtered out later while a wrong attribution cannot be found again.
//
//   X-MC-By: you       the browser panels send this — they are the human surface
//   X-MC-By: claude    scripts and tools run by an agent set this
//   X-MC-By: import    importers writing bulk data from a file
//   (absent)           unknown
//
// Loopback is NOT used as the signal. It cannot be: the browser, a Claude session running
// curl, and every importer all arrive on 127.0.0.1, so the network tells you nothing about
// who is typing. Only an explicit claim does.
const VALID = ['you', 'claude', 'import'];

function readBy(req) {
  const raw = String((req && req.get && req.get('x-mc-by')) || '').trim().toLowerCase();
  return VALID.includes(raw) ? raw : 'unknown';
}

// Express middleware: exposes req.by on every request. Cheap, and means a route never has
// to remember the header name.
function middleware(req, res, next) {
  req.by = readBy(req);
  next();
}

// The migration a module runs to add the column to one of its own tables. Kept here so the
// wording and the default are identical everywhere rather than retyped per module.
function addColumn(d, table) {
  d.exec(`ALTER TABLE ${table} ADD COLUMN by_whom TEXT NOT NULL DEFAULT 'unknown';`);
}

module.exports = { VALID, readBy, middleware, addColumn };
