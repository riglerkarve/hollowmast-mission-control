//
// printprofit — integration panel showing the PrintProfit project's state.
//
// PrintProfit is a separate project (income-portfolio/) that sells pricing and
// costing tools to people who sell 3D prints. This panel surfaces its status
// from inside Mission Control: file listing, last commit, dev server health.
//
// THREE STATES, not two. The workspace standard says absence and failure must
// never look the same, so:
//   exists === false  — the directory is missing. Rendered as "project not
//                       found", which is a fact about the workspace, not a bug.
//   error is set       — the directory exists but could not be read. Rendered
//                       as a failure with the error text, never as "empty".
//   exists && no error — the project is there; show its files and status.
//
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let loadToken = 0;

async function api() {
  const r = await fetch('/api/printprofit', {
    headers: { 'x-mc-by': 'you' },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && (body.why || body.error)) || ('HTTP ' + r.status));
  return body;
}

// Human-readable file size — bytes at small sizes, KB/MB at larger ones. The
// stat block in inventory uses the same approach; this is the panel convention.
function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// Format an ISO date string as a short local date. If the input is not a valid
// date, return the raw string rather than 'Invalid Date', which reads as an
// error when it is not one.
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderMissing(d) {
  return `<div class="panel pp-panel">
    <div class="panel-header"><h1>PrintProfit</h1></div>
    <div class="card">
      <p class="pp-missing">PrintProfit directory not found. That is a missing
        project, not a broken panel.</p>
      <p class="pp-hint">Looked for: <code>${esc(d.path)}</code></p>
    </div>
  </div>`;
}

function renderError(msg) {
  return `<div class="panel pp-panel">
    <div class="panel-header"><h1>PrintProfit</h1></div>
    <div class="card">
      <p class="pp-alarm">Could not read PrintProfit data — ${esc(msg)}.
      That is a failure to look, not an empty project.</p>
    </div>
  </div>`;
}

function renderLoading() {
  return `<div class="panel pp-panel">
    <div class="panel-header"><h1>PrintProfit</h1></div>
    <div class="card">
      <p class="pp-loading">Reading PrintProfit status…</p>
    </div>
  </div>`;
}

function statBlock(label, value) {
  return `<div class="stat-block">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${value}</div>
  </div>`;
}

function renderSummary(d) {
  const commit = d.lastCommit;
  const dev = d.devServer || {};
  const fileCount = (d.files || []).length;

  const devStatus = dev.running
    ? `<span class="pp-up">running</span>`
    : `<span class="pp-down">not running</span>`;

  let commitHTML = '<div class="stat-value">No commits found</div>';
  if (commit) {
    commitHTML = `<div class="stat-value pp-mono">${esc((commit.sha || '').slice(0, 7))}</div>`;
  }

  return `<div class="stats-summary">
    ${statBlock('Files', fileCount)}
    ${statBlock('Last commit', commitHTML)}
    ${statBlock('Dev server', devStatus)}
  </div>`;
}

function renderDevServer(d) {
  const dev = d.devServer || {};
  if (dev.running) {
    const url = `http://127.0.0.1:${dev.port || 4321}`;
    return `<div class="card">
      <strong>Preview server</strong>
      <p class="pp-hint">The dev server is running on port ${dev.port}.</p>
      <p><a class="pp-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>
    </div>`;
  }
  return `<div class="card">
    <strong>Preview server</strong>
    <p class="pp-hint">The dev server is not running on port ${dev.port || 4321}.
      This is a state, not a failure — it may simply not have been started.</p>
  </div>`;
}

function renderFiles(d) {
  const files = d.files || [];
  if (!files.length) {
    return `<div class="card">
      <p class="pp-empty">No top-level files found. The directory exists but is empty.
        This is a real count, not a failed read.</p>
    </div>`;
  }

  const rows = files.map((f) => {
    const icon = f.isDirectory ? '📁' : '📄';
    const size = f.isDirectory ? '' : fmtSize(f.sizeBytes);
    return `<div class="pp-file-row">
      <span class="pp-file-icon" aria-hidden="true">${icon}</span>
      <span class="pp-file-name">${esc(f.name)}</span>
      <span class="pp-file-size">${esc(size)}</span>
    </div>`;
  }).join('');

  return `<div class="card">
    <strong>Top-level files (${files.length})</strong>
    <div class="pp-file-list">${rows}</div>
  </div>`;
}

function renderCommit(d) {
  const commit = d.lastCommit;
  if (!commit) {
    return `<div class="card">
      <strong>Last commit</strong>
      <p class="pp-hint">No git history found for this project. That may mean it is
        not a git repository, or git is unavailable.</p>
    </div>`;
  }
  return `<div class="card">
    <strong>Last commit</strong>
    <p class="pp-mono pp-commit-sha">${esc(commit.sha || '')}</p>
    <p class="pp-hint">${esc(fmtDate(commit.date))} — ${esc(commit.message || '')}</p>
  </div>`;
}

function renderSummaryText(d) {
  if (!d.summary) return '';
  return `<p class="pp-summary">${esc(d.summary)}</p>`;
}

function renderData(d) {
  return `<div class="panel pp-panel">
    <div class="panel-header"><h1>PrintProfit</h1></div>
    ${renderSummaryText(d)}
    ${renderSummary(d)}
    ${renderDevServer(d)}
    ${renderFiles(d)}
    ${renderCommit(d)}
  </div>`;
}

async function load() {
  const token = ++loadToken;
  if (!root) return;
  let d;
  try {
    d = await api();
  } catch (e) {
    if (token !== loadToken || !root) return;
    root.innerHTML = renderError(e.message);
    renderLede('printprofit', root);
    return;
  }
  if (token !== loadToken || !root) return;

  if (!d.exists) {
    root.innerHTML = renderMissing(d);
  } else if (d.error) {
    root.innerHTML = renderError(d.error);
  } else {
    root.innerHTML = renderData(d);
  }
  renderLede('printprofit', root);
}

export default {
  mount(el, opts) {
    root = el;
    loadToken++;
    root.innerHTML = renderLoading();
    load();
  },
  unmount() {
    loadToken++;
    root = null;
  },
};