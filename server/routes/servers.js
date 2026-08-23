// servers — every local dev server in the workspace: is it up, and start it if not.
//
// Asked for 23 Aug 2026: "a place on mission control to launch all servers and show
// their status". Eight ports across the workspace, and the only place they were
// written down was CLAUDE.md prose, which nothing can read.
//
// ---------------------------------------------------------------------------------------
// TWO OWNERS ALREADY EXIST AND THIS FILE DUPLICATES NEITHER.
//
// `.claude/launch.json` in each project already declares the port AND the command --
// it is what the browser-pane preview tool reads, so it is maintained, and inventing a
// second list here would be the one-owner-per-figure rule broken on its most obvious
// case. `./projects` already declares which projects exist.
//
// So this route JOINS them and knows nothing of its own: for every declared project,
// read its launch.json, probe its ports. A project with no launch.json has no servers,
// which is a different thing from having servers that are down -- see the states below.
//
// ---------------------------------------------------------------------------------------
// LAUNCH IS LOOPBACK-ONLY, AND THAT IS NOT THE SAME DECISION AS THE GATE.
//
// server/gate.js already lets loopback through and challenges everything else, so a
// remote caller would meet it here too. That is not sufficient reason to expose start:
// reading finance data over the network is a disclosure risk, spawning a process is an
// EXECUTION risk, and they do not belong behind the same door. A registered phone should
// be able to see that HOLLOWMAST is down; it should not be able to run `npm` on this
// machine. So start() refuses any non-loopback caller regardless of gate state, and says
// so in the response rather than 404ing as if the route did not exist.
//
// ---------------------------------------------------------------------------------------
// THE FOUR STATES ARE THE POINT, AND THREE OF THEM ARE NOT "DOWN".
//
//   running        the port answered
//   stopped        the port did not answer AND we hold a command that would start it
//   no-command     declared with no runtimeExecutable -- an "attach" config, e.g. Oxford's
//                  garage-console. It cannot be started and is not broken.
//   unconfigured   the project has no launch.json at all. Nothing to be down.
//
// A panel that renders all four as a red lamp teaches the reader to ignore red lamps.
// "Nothing to run" and "should be running and is not" are opposite facts.

const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECTS } = require('./projects');

const router = express.Router();

const WORKSPACE = path.resolve(__dirname, '..', '..', '..');
const PROBE_MS = 400;

// A port probe, not an HTTP request. Several of these servers are not HTTP (Ollama is,
// but a Vite dev server mid-boot is not yet), and a connect() answers the question the
// panel actually asks: is something listening.
function probe(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(PROBE_MS);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

// Read a project's launch.json. Returns { configs } or { unreadable } -- never an empty
// list for a file that exists and failed to parse, because "no servers" and "the file is
// broken" must not render the same.
function launchConfigs(dir) {
  const p = path.join(WORKSPACE, dir, '.claude', 'launch.json');
  if (!fs.existsSync(p)) return { configs: [], present: false };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { configs: Array.isArray(j.configurations) ? j.configurations : [], present: true };
  } catch (e) {
    return { configs: [], present: true, unreadable: e.message };
  }
}

function isLoopback(req) {
  const ip = String(req.ip || req.socket.remoteAddress || '');
  return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
}

// The workspace directory for a project. PROJECTS carries `dir` where it differs from id.
const dirOf = (p) => p.dir || p.path || p.id;

async function collect() {
  const out = [];
  const seenPorts = new Map();

  for (const p of PROJECTS) {
    const dir = dirOf(p);
    const { configs, present, unreadable } = launchConfigs(dir);

    if (unreadable) {
      out.push({ project: p.id, name: p.name || p.id, dir, state: 'unreadable',
                 why: 'launch.json exists and does not parse: ' + unreadable });
      continue;
    }
    if (!present) {
      out.push({ project: p.id, name: p.name || p.id, dir, state: 'unconfigured',
                 why: 'no .claude/launch.json -- this project declares no servers' });
      continue;
    }

    for (const c of configs) {
      const port = Number(c.port) || null;
      const cmd = c.runtimeExecutable
        ? [c.runtimeExecutable, ...(c.runtimeArgs || [])].join(' ')
        : null;
      const up = port ? await probe(port) : false;

      // A port claimed by two projects is a real conflict and the panel must say so --
      // otherwise starting the second silently fails or, worse, appears to work because
      // the first one is answering.
      if (port) {
        const prior = seenPorts.get(port);
        seenPorts.set(port, (prior ? prior + ', ' : '') + `${p.id}:${c.name}`);
      }

      out.push({
        project: p.id, name: p.name || p.id, dir,
        config: c.name, port, command: cmd,
        state: up ? 'running' : (cmd ? 'stopped' : 'no-command'),
        why: up ? null
           : cmd ? 'not listening; a command is declared'
                 : 'declared with no runtimeExecutable -- an attach-only config, nothing to start',
      });
    }
  }

  // Second pass so the conflict is reported on every party to it, not just the last.
  const conflicts = [...seenPorts.entries()]
    .filter(([, v]) => v.includes(','))
    .map(([port, who]) => ({ port: Number(port), claimedBy: who }));
  for (const row of out) {
    if (row.port && conflicts.some((c) => c.port === row.port)) {
      row.portConflict = conflicts.find((c) => c.port === row.port).claimedBy;
    }
  }

  return { servers: out, conflicts };
}

router.get('/', async (_req, res) => {
  try {
    const { servers, conflicts } = await collect();
    const counted = (s) => servers.filter((x) => x.state === s).length;
    res.json({
      servers,
      conflicts,
      summary: {
        running: counted('running'),
        stopped: counted('stopped'),
        noCommand: counted('no-command'),
        unconfigured: counted('unconfigured'),
        unreadable: counted('unreadable'),
      },
      // Stated rather than assumed by the panel: this is what a probe of 400ms can and
      // cannot tell you. A server mid-boot reads as stopped and that is not a lie, it is
      // the honest answer to "is something listening right now".
      probe: { host: '127.0.0.1', timeoutMs: PROBE_MS,
               note: 'a TCP connect, not an HTTP request -- a booting server reads as stopped' },
    });
  } catch (e) {
    res.status(500).json({ error: 'could not enumerate servers: ' + e.message });
  }
});

router.post('/start', express.json(), async (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({
      error: 'start is loopback-only',
      why: 'reading state over the network is a disclosure decision; spawning a process is an '
         + 'execution decision, and they do not belong behind the same door. View from a phone, '
         + 'start from this machine.',
    });
  }

  const { project, config } = req.body || {};
  if (!project || !config) return res.status(400).json({ error: 'send { project, config }' });

  const p = PROJECTS.find((x) => x.id === project);
  if (!p) return res.status(404).json({ error: `unknown project: ${project}` });

  const dir = dirOf(p);
  const { configs, present } = launchConfigs(dir);
  if (!present) return res.status(404).json({ error: `${project} has no .claude/launch.json` });

  const c = configs.find((x) => x.name === config);
  if (!c) return res.status(404).json({ error: `no config named ${config} in ${project}` });
  if (!c.runtimeExecutable) {
    return res.status(409).json({ error: `${config} is attach-only`, why: 'no runtimeExecutable declared -- there is no command to run' });
  }

  // Refuse to start something already up, rather than spawning a second process that
  // will fail to bind and leave a confusing orphan.
  if (c.port && await probe(Number(c.port))) {
    return res.status(409).json({ error: `${config} is already listening on ${c.port}`, state: 'running' });
  }

  const cwd = path.join(WORKSPACE, dir);
  let child;
  try {
    child = spawn(c.runtimeExecutable, c.runtimeArgs || [], {
      cwd, detached: true, stdio: 'ignore', shell: true, windowsHide: true,
    });
    child.unref();
  } catch (e) {
    return res.status(500).json({ error: 'spawn failed: ' + e.message, cwd });
  }

  // VERIFY BY THE PORT, NEVER BY THE SPAWN SUCCEEDING. A detached spawn resolves
  // immediately and reports nothing about whether the server came up -- this repository
  // has the same rule for scheduled tasks, where schtasks reports SUCCESS and leaves the
  // child running. Poll the port and report what is actually true.
  const deadline = Date.now() + 12000;
  let up = false;
  while (c.port && Date.now() < deadline) {
    if (await probe(Number(c.port))) { up = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  res.json({
    ok: true, project, config, port: c.port || null, pid: child.pid,
    state: up ? 'running' : 'started-but-not-listening',
    why: up ? null
            : 'the process was spawned and the port did not answer within 12s. It may still be '
            + 'building (a Vite cold start can exceed this), or it may have exited. Re-check '
            + 'rather than assuming either.',
  });
});

module.exports = router;
