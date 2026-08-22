'use strict';

// One source-level inventory for checks that must agree about what the server exposes.
// This deliberately reads server/index.js rather than requiring it: requiring the server
// starts a listener and runs migrations, neither of which a static checker should do.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'server', 'routes');

function joined(prefix, suffix) {
  if (suffix === '*' || suffix === '/*') return `${prefix}/${suffix === '*' ? '*' : '*'}`;
  if (suffix === '/') return prefix;
  return `${prefix}${suffix}`;
}

function matchGets(source, receiver) {
  // GET paths in this application are literal strings. Keeping this inventory deliberately
  // narrow makes an unfamiliar registration form a visible omission in the checker rather
  // than a fabricated endpoint.
  const re = new RegExp(`${receiver}\\.get\\(\\s*'([^']+)'`, 'g');
  return [...source.matchAll(re)].map((match) => match[1]);
}

function inventory() {
  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const files = fs.readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.replace(/\.js$/, ''));
  // M246: The require regex must accept an optional .js suffix. Node.js treats
  // require('./routes/command') and require('./routes/command.js') identically,
  // but the old regex only matched the unsuffixed form — so a route required
  // with .js was reported as "NOT REQUIRED" (dead code) even though it was
  // loaded and mounted correctly. The fix: optionally match .js before the
  // closing quote, and strip it from the captured name so the Set still holds
  // bare names that match the filenames from readdirSync.
  const required = new Set([...index.matchAll(/require\('\.\/routes\/([a-z0-9-]+(?:\.js)?)'\)/g)]
    .map((match) => match[1].replace(/\.js$/, '')));
  const variableToFile = new Map([...index.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/routes\/([a-z0-9-]+(?:\.js)?)'\)/g)]
    .map((match) => [match[1], match[2].replace(/\.js$/, '')]));
  const mounts = [...index.matchAll(/app\.use\('([^']+)',\s*(\w+)\)/g)]
    .map((match) => ({ prefix: match[1], file: variableToFile.get(match[2]) || null, variable: match[2] }));

  const endpoints = [];
  for (const mount of mounts) {
    if (!mount.file) continue;
    const source = fs.readFileSync(path.join(ROUTES_DIR, `${mount.file}.js`), 'utf8');
    for (const route of matchGets(source, 'router')) {
      endpoints.push({ method: 'GET', path: joined(mount.prefix, route), file: mount.file, route });
    }
  }

  // gate.mount(app) registers routes directly on the application, ahead of the gate. It is
  // part of the public contract too, but has no router mount to discover above.
  const gateSource = fs.readFileSync(path.join(ROOT, 'server', 'gate.js'), 'utf8');
  for (const route of matchGets(gateSource, 'app')) {
    endpoints.push({ method: 'GET', path: route, file: 'gate', route });
  }

  return { ROOT, files, required, mounts, endpoints };
}

module.exports = { inventory };
