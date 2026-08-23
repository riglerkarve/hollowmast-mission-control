//
// hollowmast — build status for the HOLLOWMAST (Survive) project.
//
// FIVE STAT BLOCKS, ONE FETCH.
//   Build file — the size of the built index.html, formatted as KB. If it does
//   not exist, that is not an error: it means a build has not been done.
//   Build time — when the build file was last written (filesystem mtime).
//   Sources — the file count under Survive/src/.
//   Last commit — the short hash and date of the last commit touching Survive/.
//   Dev server — whether the Vite dev server is listening on port 5177. Down is
//   a status, not a failure.
//
// NOTHING HERE DERIVES ANYTHING. The numbers come from the route, which reads
// disk and git at request time. A panel that recomputed the file size would
// agree with the route until one was edited, and then disagree without either
// erroring — the exact failure this project keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

// Format bytes as KB with one decimal place. 0 bytes (or missing) renders as '—'
// so a missing build never looks like a 0 KB build.
function kb(bytes) {
  if (!bytes || bytes <= 0) return '—';
  return (bytes / 1024).toFixed(1) + ' KB';
}

// Short commit hash — first 8 chars. null renders as '—'.
function shortSha(sha) {
  if (!sha) return '—';
  return String(sha).slice(0, 8);
}

// Commit date — the full ISO date string from git, trimmed to date + time.
function commitDate(date) {
  if (!date) return '—';
  return String(date).slice(0, 16).replace('T', ' ');
}

function statBlock(label, value, sub, live) {
  const subHTML = sub ? `<p class="hm-sub">${esc(sub)}</p>` : '';
  const liveClass = live ? ' hm-live' : '';
  return `<div class="hm-stat${liveClass}">
    <h3 class="hm-label">${esc(label)}</h3>
    <p class="hm-value">${esc(value)}</p>
    ${subHTML}
  </div>`;
}

// Show the path without the long repo prefix, so it reads as a relative path.
function pathLabel(p) {
  if (!p) return '';
  const prefix = 'C:/Users/jcwhi/Claude Outputs/';
  if (String(p).startsWith(prefix)) return String(p).slice(prefix.length);
  return p;
}

function renderBuildFile(bf) {
  if (!bf || !bf.exists) {
    return statBlock('Build file', 'No build file found',
      'A build has not been done — not an error.', false);
  }
  return statBlock('Build file', kb(bf.sizeBytes), pathLabel(bf.path), false);
}

// Build time — the build file's mtime. Only meaningful when the file exists;
// a missing build has no build time, and that renders as '—', not a failure.
function renderBuildTime(bf) {
  if (!bf || !bf.exists || !bf.mtime) {
    return statBlock('Build time', '—', 'No build file to date.', false);
  }
  return statBlock('Build time', commitDate(bf.mtime), 'Filesystem write time of the build.', false);
}

function renderSources(s) {
  if (!s || !s.exists) {
    return statBlock('Sources', '—', 'No src/ directory found.', false);
  }
  return statBlock('Sources', String(s.count) + ' files', pathLabel(s.path), false);
}

function renderCommit(lc) {
  if (!lc || (!lc.sha && !lc.date)) {
    return statBlock('Last commit', '—', 'No commit history for Survive/.', false);
  }
  return statBlock('Last commit', shortSha(lc.sha), commitDate(lc.date), false);
}

function renderDevServer(ds) {
  if (!ds || !ds.running) {
    return statBlock('Dev server', 'Dev server not running',
      `Port ${ds ? ds.port : 5177} — a status, not a failure.`, false);
  }
  return statBlock('Dev server', 'Running', `Port ${ds.port}`, true);
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel hm-panel">
      <h1>HOLLOWMAST</h1>
      <p class="hm-alarm">Could not read HOLLOWMAST status — ${esc(state.error)}.
      That is a failure to look, not a missing build.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel hm-panel"><h1>HOLLOWMAST</h1>
      <p class="hm-loading">Reading build status…</p></section>`;
    return;
  }

  const d = state.data;
  root.innerHTML = `<section class="panel hm-panel">
    <h1>HOLLOWMAST</h1>
    <p class="hm-lede">Build status — last build size, source count, commit, and whether the
      dev server is running.</p>

    <div class="hm-grid">
      ${renderBuildFile(d.buildFile)}
      ${renderBuildTime(d.buildFile)}
      ${renderSources(d.sources)}
      ${renderCommit(d.lastCommit)}
      ${renderDevServer(d.devServer)}
    </div>
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/hollowmast')).json();
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { data: null, error: null };
    render();
    load();
    renderLede('hollowmast', el);
  },
  unmount() { root = null; state = null; },
};
