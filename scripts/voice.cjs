#!/usr/bin/env node
//
// voice.cjs — "Major Tom". Backlog #22.
//
//   node scripts/voice.cjs            speak the current standing line
//   node scripts/voice.cjs --dry      print what would be said, stay silent
//   node scripts/voice.cjs --say "…"  speak a specific line
//
// ------------------------------------------------------------------------------------
// THE WORDS COME FROM SQL. Same rule as the briefing: the local model may introduce
// figures, never produce them. Here it does not appear at all — every sentence below is
// assembled from counts this database already holds, because a spoken figure is the worst
// place for a plausible number. You cannot scroll back and check what a voice said.
//
// AND IT IS NEVER FUNNY ABOUT MONEY, HEALTH OR WELLBEING. That is backlog #60, which
// overrides #59's "comedic control centre" and is applied here rather than left as an
// intention: the lines are chosen from a serious set whenever the subject is one of those,
// and there is no joke register in this file at all.
// ------------------------------------------------------------------------------------
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const sayIdx = args.indexOf('--say');

const PS1 = path.join(__dirname, 'say.ps1');

function speak(text) {
  if (DRY) { console.log(`would say: ${text}`); return { spoken: false, dry: true }; }
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Text', text],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    return { spoken: true };
  } catch (err) {
    // Degrade like every other offloaded thing here: say why, do not pretend it worked.
    console.error(`could not speak: ${String(err.stderr || err.message).trim().slice(0, 200)}`);
    return { spoken: false, error: true };
  }
}

// Built from the modules' own accessors, never by reading their tables.
function line() {
  const stats = require('../server/routes/stats');
  const lifestyle = require('../server/routes/lifestyle');
  const schedule = require('../server/routes/schedule');

  const bits = [];

  // Chores and appointments are neutral subjects, so they lead.
  try {
    const due = lifestyle.dueSummary();
    if (due.due.length) {
      const names = due.due.map((c) => c.name).join(', ');
      bits.push(`Due today: ${names}.`);
    }
  } catch { /* module absent — silence is correct, not an invented line */ }

  try {
    const up = schedule.upcoming(2);
    if (up.overdue && up.overdue.length) {
      bits.push(`${up.overdue.length} thing${up.overdue.length === 1 ? '' : 's'} on the schedule ${up.overdue.length === 1 ? 'is' : 'are'} past its day.`);
    }
  } catch { /* same */ }

  try {
    const s = stats.standing();
    const live = (s.streaks || []).filter((x) => x.days > 1);
    if (live.length) {
      const best = live.sort((a, b) => b.days - a.days)[0];
      bits.push(`${best.days} days running on ${best.label.replace(/^days with an? /, '')}.`);
    }
  } catch { /* same */ }

  // NOTHING ABOUT MONEY, HEALTH OR THE JOURNAL IS SPOKEN. Not because the figures are
  // wrong, but because a voice cannot be re-read, cannot be checked, and arrives whether
  // or not the room is empty. Those belong on a page you chose to open.
  if (!bits.length) return 'Nothing due, and nothing overdue. That is all this can honestly say.';
  return bits.join(' ');
}

const text = sayIdx >= 0 ? String(args[sayIdx + 1] || '').trim() : line();
if (!text) { console.error('nothing to say'); process.exit(2); }

const r = speak(text);
if (!DRY && r.spoken) console.log(`said: ${text}`);
if (r.error) process.exit(1);
