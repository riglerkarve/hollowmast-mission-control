// PROJECTS — every project, its state, and a way into the control centres that exist.
//
// Reads only /api/projects. The route derives git state; this file renders it and adds
// nothing of its own. Deliberately NOT a bookmarks page: the question it answers that a
// list of links cannot is "which of these has drifted", so the commit age and the
// uncommitted count are the point and the link is the convenience.

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Projects</h1>
      <div class="badge"><span class="badge-icon">▤</span><span id="prjCount">—</span></div>
    </div>

    <section class="card">
      <div id="prjList"></div>
    </section>

    <section class="card">
      <h2 class="prj-h2">What this serves, and what it refuses</h2>
      <div id="prjSafety"></div>
    </section>
  </div>
`;

let root = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(p) {
  const r = await fetch(`/api/projects${p}`, { headers: { 'x-mc-by': 'you' } });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error((b && b.error) || `HTTP ${r.status}`);
  return b;
}

// "2 minutes ago" vs "9 days ago" — git's own wording, kept rather than reformatted so the
// figure cannot drift from what `git log` would tell you at a prompt.
function gitCell(g) {
  if (g === null) return '<span class="prj-dim">not a git repo</span>';
  if (g.error) return `<span class="prj-warn">${esc(g.error)}</span>`;
  const dirty = g.uncommitted === null
    ? '<span class="prj-warn">uncommitted count unreadable</span>'
    : g.uncommitted > 0
      ? `<span class="prj-dirty">${g.uncommitted} uncommitted</span>`
      : '<span class="prj-clean">clean</span>';
  return `<span class="prj-git">${esc(g.hash)} · ${esc(g.ago)}</span> · ${dirty}
          <span class="prj-subject">${esc(g.subject)}</span>`;
}

async function load() {
  const box = root.querySelector('#prjList');
  let d;
  try {
    d = await api('/');
  } catch (err) {
    box.innerHTML = `<p class="prj-error">Could not read the project list: ${esc(err.message)}
      — that is a failure to look, not a report that you have no projects.</p>`;
    return;
  }

  root.querySelector('#prjCount').textContent = `${d.projects.length} projects`;

  const byTrack = {};
  for (const p of d.projects) (byTrack[p.track] = byTrack[p.track] || []).push(p);

  box.innerHTML = Object.entries(byTrack).map(([track, list]) => `
    <h3 class="prj-track">${esc(track)}</h3>
    <ul class="prj-list">
      ${list.map((p) => `
        <li class="${p.exists ? '' : 'prj-gone'}">
          <div class="prj-top">
            <span class="prj-name">${esc(p.name)}</span>
            ${p.href
    ? `<a class="prj-open" href="${esc(p.href)}" target="_blank" rel="noopener">Open control centre →</a>`
    : `<span class="prj-none">${esc(p.state)}</span>`}
          </div>
          <div class="prj-meta">${gitCell(p.git)}</div>
          <div class="prj-note">${esc(p.note)}</div>
        </li>`).join('')}
    </ul>`).join('');

  root.querySelector('#prjSafety').innerHTML = `
    <p class="prj-note">${esc(d.servedFrom)}</p>
    <p class="prj-note">${esc(d.caveat)}</p>
    <p class="prj-note prj-dim">Servable file types: <code>${esc(d.servable)}</code></p>`;
}

export default {
  async mount(el) {
    el.innerHTML = TEMPLATE;
    root = el;
    load();
  },
  unmount() { root = null; },
};
