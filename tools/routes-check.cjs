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

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NO_HTTP = process.argv.includes('--no-http');
const BASE = process.env.MC_BASE || 'http://127.0.0.1:3000';

const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const files = fs.readdirSync(path.join(ROOT, 'server', 'routes'))
  .filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));

const required = new Set([...index.matchAll(/require\('\.\/routes\/([a-z0-9-]+)'\)/g)].map((m) => m[1]));
// Capture the VARIABLE each router is bound to, so a mount can be traced back to its file
// even when the mount path differs from the filename — which two of them deliberately do.
const varOf = new Map([...index.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/routes\/([a-z0-9-]+)'\)/g)]
  .map((m) => [m[1], m[2]]));
const mounts = [...index.matchAll(/app\.use\('([^']+)',\s*(\w+)\)/g)]
  .map((m) => ({ prefix: m[1], file: varOf.get(m[2]) || null, variable: m[2] }));

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
