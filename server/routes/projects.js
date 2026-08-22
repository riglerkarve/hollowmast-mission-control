// PROJECTS — one place to see every project's state, and to reach the control centres
// that already exist. Asked for 18 Aug 2026: "a simple harness that shows each project
// focused dashboard / control centre".
//
// ---------------------------------------------------------------------------------------
// A DECLARED REGISTRY, NOT A DIRECTORY SCAN, AND THAT IS THE SECURITY DECISION.
//
// This server binds 0.0.0.0 so the dashboard works from a phone. Scanning the workspace
// and serving whatever it finds would mean a new directory becomes publicly readable the
// moment it appears — including one holding something nobody thought about. So projects
// are LISTED below by hand. An unlisted directory is invisible here, which is the failure
// mode you want: it fails closed.
//
// This follows server/routes/garage.js, which already refused a root mount for the same
// reason — mission-control/data/dashboard.db and its backups sit under that root, and a
// static mount would have published ten account-years of bank transactions to the LAN.
//
// WHAT IS SERVED FROM A PROJECT: only files under its declared dashboard directory, and
// only extensions a browser needs to render a page. Not .cjs, not .sh, not .md — those are
// source and notes, and nothing in a dashboard needs them fetched over HTTP.
//
// WHAT IS DERIVED RATHER THAN TYPED: last commit, how long ago, and uncommitted file count.
// A launcher that only links is a bookmarks page and fails module-contract rule 3. The
// question this pane answers that no bookmark does is "which of these has drifted".
// ---------------------------------------------------------------------------------------
'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const router = express.Router();
const ROOT = path.resolve(__dirname, '..', '..', '..');   // the workspace, one above mission-control

// Hand-declared. `dash` is the ONLY directory served for each entry, and it is relative to
// the project. A project with dash: null appears in the list and serves nothing.
//  is the public URL, and only the two published projects carry one. It lives here
// rather than in the analytics module because a public address is an attribute of the
// project, and a second list of projects is a second place the truth lives.
const PROJECTS = [
  { id: 'hollowmast', name: 'HOLLOWMAST', dir: 'Survive', dash: 'dash', live: 'https://hollowmast.com', entry: 'index.html',
    track: 'Game', note: 'Nearest to shipping. One self-contained HTML file, zero dependencies.' },
  { id: 'printprofit', name: 'PrintProfit', dir: 'income-portfolio', dash: 'dashboard', live: 'https://riglerkarve.github.io/profitprint/', entry: 'index.html',
    track: 'Income', note: 'Live to the public, £0 earned. Blocked on distribution.' },
  { id: 'dropshipping', name: 'Dropshipping', dir: 'dropshipping', dash: null, entry: null,
    track: 'Dropshipping', note: 'Registered 18 Aug 2026 as its own track. Nothing built: niche, platform, supplier and budget ceiling are all undecided. First project here that cannot run on zero.' },
  { id: 'print-shop', name: 'Print Shop', dir: 'print-shop', dash: null, entry: null,
    track: 'Print Shop', note: 'Registered 20 Aug 2026 as its own track, explicitly not a PrintProfit replacement. Nothing built: equipment, niche, storefront and budget ceiling are all undecided; own cost model waits on M125 research validation.' },
  { id: 'mission-control', name: 'Mission Control', dir: 'mission-control', dash: null, entry: null,
    track: 'Ops', note: 'This. Its control centre is the thing you are looking at.' },
  { id: 'garage', name: 'The Garage', dir: '.garage', dash: null, entry: null,
    track: 'Ops', note: 'Folded in 17 Aug — served at /garage, not from here.', href: '/garage/' },
  { id: 'oxford', name: 'Oxford AutoWorks', dir: 'Oxford AutoWorks', dash: null, entry: null,
    track: 'Game', note: 'Kept and documented, not in the rotation. UE5, 4.7 GB.' },
  { id: 'thin-air', name: 'thin-air', dir: 'thin-air', dash: null, entry: null,
    track: 'Game', note: 'Kept and documented, not in the rotation. Playable.' },
  { id: 'fallow', name: 'Fallow', dir: 'Fallow', dash: null, entry: null,
    track: 'Game', note: 'Design only, no code.' },
  { id: 'emberfall', name: 'emberfall', dir: 'emberfall', dash: null, entry: null,
    track: 'Game', note: 'Kept and documented, not in the rotation.' },
  { id: 'high-society', name: 'high-society-420-tycoon', dir: 'high-society-420-tycoon', dash: null, entry: null,
    track: 'Game', note: 'Idle clicker. Kept and documented.' },
  { id: 'mini-games', name: 'Mini Games', dir: 'Mini Games', dash: null, entry: null,
    track: 'Game', note: 'GIVE WAY. Kept and documented.' },
  { id: 'second-brain', name: 'SecondBrain', dir: 'SecondBrain', dash: null, entry: null,
    track: '—', note: 'Obsidian vault, effectively empty. The real second brain is the memory store.' },
];

// Only what a browser needs to draw a page. Deliberately excludes .cjs, .sh, .md and
// anything else: those are source and notes, and no dashboard fetches them over HTTP.
const SERVABLE = new Set(['.html', '.css', '.js', '.json', '.jsonl', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff2', '.map']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

// git, asked rather than parsed out of .git by hand. Returns null on any failure, and the
// caller renders that as "not a repo / could not read" rather than as "no changes".
function gitInfo(dir) {
  return new Promise((resolve) => {
    const cwd = path.join(ROOT, dir);
    if (!fs.existsSync(path.join(cwd, '.git'))) return resolve(null);
    execFile('git', ['-C', cwd, 'log', '-1', '--format=%h|%ar|%s'], { timeout: 5000 }, (e1, log) => {
      if (e1) return resolve({ error: 'could not read git log' });
      execFile('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 5000 }, (e2, st) => {
        const [hash, ago, subject] = String(log).trim().split('|');
        resolve({
          hash,
          ago,
          subject: (subject || '').slice(0, 70),
          uncommitted: e2 ? null : String(st).trim().split('\n').filter(Boolean).length,
        });
      });
    });
  });
}

router.get('/', async (req, res) => {
  // EVERY PROJECT IS INSPECTED IN PARALLEL. This loop used to await gitInfo() one project
  // at a time, and gitInfo spawns TWO git subprocesses. Measured 18 Aug: three of the seven
  // entries are real repositories, a git pair costs ~130ms each, and the route answered in
  // ~410ms warm — the slowest endpoint in the dashboard, and almost exactly 3 x 130.
  //
  // The work was never dependent: no project needs another project’s answer. Sequential
  // await here bought nothing and cost the sum instead of the maximum.
  const out = await Promise.all(PROJECTS.map(async (p) => {
    const dir = path.join(ROOT, p.dir);
    const exists = fs.existsSync(dir);
    const dashDir = p.dash ? path.join(dir, p.dash) : null;
    const hasDash = Boolean(dashDir && fs.existsSync(path.join(dashDir, p.entry || 'index.html')));

    return {
      ...p,
      exists,
      // Absence and failure differ: a project directory that is gone is a different
      // statement from one that has no dashboard.
      state: !exists ? 'missing from disk' : hasDash ? 'has a control centre' : 'no control centre',
      href: p.href || (hasDash ? `/api/projects/${p.id}/dash/${p.entry}` : null),
      git: exists ? await gitInfo(p.dir) : null,
    };
  }));

  res.json({
    projects: out,
    servedFrom: 'a hand-declared list. A directory that is not listed above is not reachable '
      + 'through this route, however it is named — the registry fails closed on purpose.',
    servable: [...SERVABLE].join(' '),
    caveat: 'Only files under each project\'s declared dashboard directory are served, and '
      + 'only browser-renderable types. Source, shell scripts and notes are refused.',
  });
});

// Serve a file from ONE project's declared dashboard directory.
router.get('/:id/dash/*', (req, res) => {
  const p = PROJECTS.find((x) => x.id === req.params.id);
  if (!p || !p.dash) return res.status(404).type('text').send('no such project dashboard');

  const base = path.resolve(ROOT, p.dir, p.dash);
  const rel = String(req.params[0] || p.entry || 'index.html');
  const file = path.resolve(base, rel);

  // Containment check AFTER normalisation, which is the only point at which it means
  // anything — '../' inside rel is harmless until the path is resolved. path.relative is
  // used rather than startsWith, because startsWith('/a/b') also matches '/a/bc'.
  const inside = path.relative(base, file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return res.status(403).type('text').send('refused: outside the project dashboard directory');
  }

  const ext = path.extname(file).toLowerCase();
  if (!SERVABLE.has(ext)) {
    return res.status(403).type('text')
      .send(`refused: ${ext || 'no extension'} is not served. Only browser-renderable files `
        + 'are, and source is deliberately not among them.');
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.status(404).type('text').send('not found in that dashboard');
    res.type(TYPES[ext] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
});

// What actually moved, per project, for the briefing.
//
// Owner request 18 Aug 2026: the briefing should encompass all projects and their progress.
// It knew a great deal about the owner's data and nothing about the twelve things on the disk.
//
// PROGRESS IS COMMITS, and that is a deliberate narrowing rather than the best available
// measure. A commit is a fact with a timestamp that nobody has to remember to record. Anything
// richer -- percent complete, velocity, "on track" -- would be a weighting I chose, presented
// back as a measurement, which is the one figure nobody can audit.
//
// FOUR PROJECTS ARE NOT REPOSITORIES AT ALL: thin-air, emberfall, Fallow and
// high-society-420-tycoon. Work on those is INVISIBLE here, and they are reported as
// unmeasurable rather than as zero. A project with no version control and a project nobody
// touched look identical to any commit count, and calling both "no progress" would quietly
// libel the first.
function progressSince(sinceISO) {
  const since = String(sinceISO || '').slice(0, 10);
  const moved = [];
  const quiet = [];
  const unmeasurable = [];

  for (const p of PROJECTS) {
    const cwd = path.join(ROOT, p.dir);
    if (!fs.existsSync(cwd)) {
      unmeasurable.push({ id: p.id, name: p.name, why: 'directory not found' });
      continue;
    }
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      unmeasurable.push({ id: p.id, name: p.name, track: p.track, why: 'not under version control' });
      continue;
    }
    const git = (args) => {
      try {
        return execFileSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', timeout: 8000 }).trim();
      } catch (e) { return null; }
    };

    // THE TIME IS NOT OPTIONAL. `--since=2026-08-18` returns 0 on a repository with 119
    // commits that same day; `--since=2026-08-18T00:00` returns all 119. Measured here, on
    // this repo, minutes after committing to it. A bare ISO date is parsed by approxidate in a
    // way that excludes the day it names, and it fails SILENTLY -- the briefing would have
    // reported "nothing moved" on a day with thirty commits, which is a flattering lie rather
    // than an error.
    const inWindow = since ? git(['rev-list', '--count', `--since=${since}T00:00`, 'HEAD']) : null;
    const total = git(['rev-list', '--count', 'HEAD']);
    const last = git(['log', '-1', '--format=%cd|%s', '--date=format:%Y-%m-%d %H:%M']);
    if (total === null) {
      unmeasurable.push({ id: p.id, name: p.name, track: p.track, why: 'git would not answer' });
      continue;
    }
    const [lastAt, lastSubject] = String(last || '|').split('|');
    const n = Number(inWindow || 0);
    const row = {
      id: p.id,
      name: p.name,
      track: p.track,
      commits: n,
      total: Number(total),
      lastAt: lastAt || null,
      lastSubject: (lastSubject || '').slice(0, 72),
      uncommitted: (git(['status', '--porcelain']) || '').split('\n').filter(Boolean).length,
    };
    if (n > 0) moved.push(row); else quiet.push(row);
  }

  moved.sort((a, b) => b.commits - a.commits);
  quiet.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));

  return {
    since,
    moved,
    quiet,
    unmeasurable,
    totalCommits: moved.reduce((a, r) => a + r.commits, 0),
    note: 'Progress is commits in the window. Projects with no repository are listed as '
      + 'unmeasurable, never as zero: work there is real and simply invisible to this.',
  };
}


module.exports = router;
module.exports.PROJECTS = PROJECTS;
module.exports.progressSince = progressSince;
