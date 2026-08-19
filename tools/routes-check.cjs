#!/usr/bin/env node
//
// routes-check.cjs — is every route file actually reachable?
//
//   node tools/routes-check.cjs              check against the running server
//   node tools/routes-check.cjs --no-http    static checks only, server not needed
//
// EXISTS BECAUSE "BUILT IS NOT CONNECTED" KEEPS HAPPENING HERE. On 18 Aug alone,
// server/routes/mail.js was written, migrated, imported into and never mounted — caught only
// by curling the URL, and drive.js nearly went the same way. Reading the file tells you the
// handler exists; only a request tells you anything reaches it.
//
// THREE DISTINCT FAILURES, and they need different fixes, so they are reported separately:
//   1. a route file nothing requires        — dead code, or a forgotten mount
//   2. a required file that is never mounted — the mail.js case: loaded, migrations run,
//                                              tables created, zero endpoints reachable
//   3. a mounted prefix that does not answer — mounted but broken
'use strict';
require('./_run-log.cjs').record();

const { inventory } = require('./route-inventory.cjs');

const NO_HTTP = process.argv.includes('--no-http');
const BASE = process.env.MC_BASE || 'http://127.0.0.1:3000';
const { files, required, mounts } = inventory();

const mountedFiles = new Set(mounts.map((m) => m.file).filter(Boolean));

const notRequired = files.filter((f) => !required.has(f));
const notMounted = files.filter((f) => required.has(f) && !mountedFiles.has(f));
// Deliberate: the mount path need not match the filename. uptime serves /api/status and
// garage serves /garage. Reported as INFO so a reader is not left wondering, never as a fault.
const renamed = mounts.filter((m) => m.file && !m.prefix.endsWith(`/${m.file}`));

console.log(`  ${files.length} route file(s), ${mounts.length} mount(s)\n`);

let bad = 0;
if (notRequired.length) { bad++; console.log(`  NOT REQUIRED by index.js — dead or forgotten:\n    ${notRequired.join('\n    ')}\n`); }
if (notMounted.length) {
  bad++;
  console.log('  REQUIRED BUT NEVER MOUNTED — migrations run, tables exist, NO endpoint reachable:');
  console.log(`    ${notMounted.join('\n    ')}\n`);
}
if (!notRequired.length && !notMounted.length) console.log('  every route file is required and mounted\n');

if (renamed.length) {
  console.log('  mounted under a path that is not its filename (deliberate — noted, not a fault):');
  renamed.forEach((m) => console.log(`    ${String(m.file).padEnd(12)} -> ${m.prefix}`));
  console.log('');
}

(async () => {
  if (NO_HTTP) { process.exitCode = bad ? 1 : 0; return; }

  console.log(`  probing ${BASE} …`);

  // IS THE SERVER THERE AT ALL? Ask once, before probing 28 prefixes. Without this a stopped
  // service renders as 28 route failures -- a real outage described as a code problem, which
  // sends the reader to the wrong file. I nearly "fixed" this checker because of it.
  try {
    await fetch(BASE + "/api/status", { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    const why = (e.cause && e.cause.code) || e.name;
    console.log("    THE SERVER IS NOT ANSWERING at " + BASE + " (" + why + ").");
    console.log("    Not probing the routes: every one would report a failure it did not cause.");
    console.log("    Start it with: node tools/restart.cjs   then run this again.");
    console.log("    The static checks above are unaffected and still valid.");
    return;
  }
  let unreachable = 0;
  for (const m of mounts) {
    let code;
    try {
      const r = await fetch(BASE + m.prefix, { signal: AbortSignal.timeout(8000) });
      code = r.status;
    } catch (err) { code = `ERR ${err.name}`; }

    // A 404 on the PREFIX is not necessarily a fault: several routers define no '/' handler
    // (wellbeing, health). "The prefix 404s" and "the module is broken" are different claims
    // and this must not conflate them — so 404 is flagged for a human, never failed.
    const ok = typeof code === 'number' && code < 500;
    if (!ok) unreachable++;
    const note = code === 404 ? '  (no root handler? check a real sub-path)' : '';
    console.log(`    ${String(code).padStart(7)}  ${m.prefix}${note}`);
  }
  if (unreachable) { bad++; console.log(`\n  ${unreachable} prefix(es) failed or errored.`); }
  console.log(bad ? '\n  PROBLEMS FOUND' : '\n  all mounts answer');
  process.exitCode = bad ? 1 : 0;
})();
