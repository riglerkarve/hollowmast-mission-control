// workspace.js — M258: one screen showing all projects with status
//
// EVERY VALUE HERE IS ESCAPED. Project names, commit subjects and git error text all reach
// this template from the filesystem and from git, and a commit subject containing a `<` was
// previously interpolated raw.
//
// WHAT COULD NOT BE MEASURED SAYS SO. A project whose git call failed is `unknown`, not
// `parked` — parked is a claim about activity, and making it from a measurement that never
// happened is how this panel spent its whole life reporting "0 projects" as a fact.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// What the card shows where a commit date would go, per git state. `no git history` was the
// only message available before, and it was shown for all three of "no repo", "no commits"
// and "git failed" — the last of which is not an absence of history at all.
const GIT_NOTE = {
  'not-a-repo': 'not a git repository',
  'no-commits': 'repository with no commits yet',
  error: 'could not read git — this is a failure to look, not an absence of history',
};

function cardHTML(p) {
  const history = p.lastCommit
    ? `<div class="ws-row"><span>last commit</span><b>${esc(p.lastCommit.date)}</b></div>
       <div class="ws-row ws-subject">${esc(p.lastCommit.subject)}</div>
       <div class="ws-row"><span>age</span><b>${esc(p.commitAge)}d</b></div>`
    : `<div class="ws-row ws-none">${esc(GIT_NOTE[p.git] || 'no git history')}</div>`;

  const gitErr = p.gitError
    ? `<div class="ws-row ws-none">${esc(p.gitError)}</div>` : '';

  // "0 open items" and "could not count them" are different facts, so the second is never
  // printed as the first.
  const items = p.itemsKnown === false
    ? '<div class="ws-row ws-none">open items — could not be counted</div>'
    : `<div class="ws-row"><span>open items</span><b>${esc(p.openItems)}</b></div>`;

  // 7-day commit count is only a real zero when git answered.
  const recent = p.git === 'error'
    ? '' : `<div class="ws-row"><span>7d commits</span><b>${esc(p.commits7d)}</b></div>`;

  return `<div class="ws-card ws-${esc(p.status)}">
    <div class="ws-card-head">
      <span class="ws-name">${esc(p.name)}</span>
      <span class="ws-badge ws-badge-${esc(p.status)}">${esc(p.status)}</span>
    </div>
    <div class="ws-card-body">${history}${gitErr}${recent}${items}</div>
  </div>`;
}

export default {
  mount(el, opts) {
    el.innerHTML = '<div class="ws-loading">Loading workspace…</div>';
    fetch('/api/workspace').then(r => r.json()).then(d => {
      // The route reports a bad workspace root as an error rather than as an empty list.
      // Rendering that as "0 projects" is exactly the confusion that hid this bug.
      if (d.error) {
        el.innerHTML = `<div class="ws-error">Could not read the workspace: ${esc(d.error)}.
          That is a failure to look, not an empty workspace.</div>`;
        return;
      }

      const ps = d.projects || [];
      const missing = d.missing || [];

      // Declared-but-absent projects are named. A list that quietly shrinks reads as the
      // whole workspace, which is the failure this endpoint shipped with.
      const missingHTML = missing.length
        ? `<div class="ws-row ws-none">${esc(missing.length)} declared project${missing.length === 1 ? '' : 's'} not found on disk:
           ${esc(missing.join(', '))}</div>`
        : '';

      const unknownHTML = d.unknownProjects
        ? `<span class="ws-stat"><b>${esc(d.unknownProjects)}</b> unknown</span>` : '';

      // One machine-level fact, said once. Repeating "could not read git" on every card
      // would describe twelve projects when the thing that is wrong is this server.
      const gitHTML = d.gitAvailable === false
        ? `<div class="ws-row ws-none">git is not available to the server, so activity could not be
           measured for any project. These are not parked projects — they are unmeasured ones.</div>`
        : '';

      el.innerHTML = `
        <div class="ws-head">
          <div class="ws-summary">
            <span class="ws-stat"><b>${esc(d.totalProjects)}</b> projects</span>
            <span class="ws-stat ws-active"><b>${esc(d.activeProjects)}</b> active</span>
            <span class="ws-stat"><b>${esc(d.dormantProjects)}</b> dormant</span>
            <span class="ws-stat"><b>${esc(d.parkedProjects)}</b> parked</span>
            ${unknownHTML}
          </div>
          ${gitHTML}
          ${missingHTML}
        </div>
        <div class="ws-grid">${ps.map(cardHTML).join('')}</div>
      `;

      // Called AFTER innerHTML is set, and as a statement rather than interpolated into the
      // template. It is async and returns a Promise, so `${renderLede(...)}` rendered the
      // literal text "[object Promise]" at the top of this panel — visible on screen. It was
      // also passed `opts` where the contract wants the container element, so even awaited it
      // would have inserted nothing.
      renderLede('workspace', el);
    }).catch(e => {
      el.innerHTML = '<div class="ws-error">Could not load workspace: ' + esc(String(e.message || e).slice(0, 80)) + '</div>';
    });
  },
  unmount() {},
};