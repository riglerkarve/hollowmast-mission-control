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
const { execFileSync, execFile } = require('node:child_process');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const sayIdx = args.indexOf('--say');

const PS1 = path.join(__dirname, 'say.ps1');

// SYNCHRONOUS, and only safe from the CLI. execFileSync blocks the whole thread until the
// sentence finishes being spoken, which is correct for a script that exits afterwards and
// catastrophic inside the server — see speakAsync below.
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

// THE VERSION THE SERVER MUST USE. Measured 18 Aug 2026 with the sync one wired to a route:
// a single sentence stalled /api/status for 5,084 ms. Node is one thread, so the entire
// dashboard served nothing for the length of the sentence — and the watchdog probes that
// exact endpoint every five minutes and treats a timeout as DOWN, so speaking could have
// triggered a spurious restart of the service.
//
// This spawns the same command without blocking the event loop, so other requests are
// served while PowerShell talks. The caller still awaits a real result, so "spoken" and
// "speech is unavailable" stay distinguishable.
function speakAsync(text) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Text', text],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ spoken: true });
        resolve({
          spoken: false,
          error: true,
          reason: String(stderr || err.message).trim().slice(0, 200),
        });
      });
  });
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
      const n = up.overdue.length;
      bits.push(`${n} thing${n === 1 ? ' on the schedule is past its day' : 's on the schedule are past their day'}.`);
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

// Guarded so this file can be REQUIRED by a route without speaking on import. Without the
// guard, requiring it would talk at whoever restarted the server — and the module was
// written, verified and then never called by anything, which is how it sat silent since it
// was built. Connecting it is the actual work of #22; the speaking was already done.
if (require.main === module) {
  const text = sayIdx >= 0 ? String(args[sayIdx + 1] || '').trim() : line();
  if (!text) { console.error('nothing to say'); process.exit(2); }

  const r = speak(text);
  if (!DRY && r.spoken) console.log(`said: ${text}`);
  if (r.error) process.exit(1);
}

module.exports = { line, speak, speakAsync };
