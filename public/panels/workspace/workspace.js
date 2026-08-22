// workspace.js — M258: one screen showing all projects with status
import { renderLede } from '/panels/lede/lede.js';

export default {
  mount(el, opts) {
    el.innerHTML = '<div class="ws-loading">Loading workspace…</div>';
    fetch('/api/workspace').then(r => r.json()).then(d => {
      const ps = d.projects || [];
      const statusColor = { active: 'var(--accent-text)', dormant: 'var(--muted)', parked: 'var(--muted)' };
      const statusBg = { active: 'var(--accent-soft)', dormant: 'transparent', parked: 'transparent' };

      el.innerHTML = `
        <div class="ws-head">
          ${renderLede ? renderLede('workspace', opts) : ''}
          <div class="ws-summary">
            <span class="ws-stat"><b>${d.totalProjects}</b> projects</span>
            <span class="ws-stat ws-active"><b>${d.activeProjects}</b> active</span>
            <span class="ws-stat"><b>${d.dormantProjects}</b> dormant</span>
            <span class="ws-stat"><b>${d.parkedProjects}</b> parked</span>
          </div>
        </div>
        <div class="ws-grid">
          ${ps.map(p => `
            <div class="ws-card ws-${p.status}">
              <div class="ws-card-head">
                <span class="ws-name">${p.name}</span>
                <span class="ws-badge ws-badge-${p.status}">${p.status}</span>
              </div>
              <div class="ws-card-body">
                ${p.lastCommit ? `
                  <div class="ws-row"><span>last commit</span><b>${p.lastCommit.date}</b></div>
                  <div class="ws-row ws-subject">${p.lastCommit.subject}</div>
                  <div class="ws-row"><span>age</span><b>${p.commitAge}d</b></div>
                ` : '<div class="ws-row ws-none">no git history</div>'}
                <div class="ws-row"><span>7d commits</span><b>${p.commits7d}</b></div>
                <div class="ws-row"><span>open items</span><b>${p.openItems}</b></div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }).catch(e => {
      el.innerHTML = '<div class="ws-error">Could not load workspace: ' + String(e.message || e).slice(0, 80) + '</div>';
    });
  },
  unmount() {},
};