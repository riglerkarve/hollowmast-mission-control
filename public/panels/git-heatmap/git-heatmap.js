// git-heatmap — cross-project git activity heatmap for the workspace root.
//
// THREE SECTIONS, ONE FETCH.
//   'Activity heatmap' — a grid where each row is a project (top-level directory)
//   and each column is a day. Cells colored by commit count: 0=muted/empty,
//   1-2=light accent, 3+=full accent. Shows the last 30 days.
//   'Project totals' — per-project commit count over the period, sorted descending.
//   'Daily totals' — commits per day as a simple bar list (date + count).
//
// NOTHING HERE DERIVES ANYTHING. The counts come from the route, which runs
// `git log` in the workspace root. A panel that recomputed "which files changed"
// would agree with the route until one was edited, and then disagree without
// either erroring — the exact failure this project keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

function buildProjectList(days) {
  const set = new Set();
  for (const d of days) {
    for (const p of Object.keys(d.projects)) set.add(p);
  }
  return Array.from(set).sort();
}

function projectTotals(days) {
  const totals = {};
  for (const d of days) {
    for (const [p, c] of Object.entries(d.projects)) {
      totals[p] = (totals[p] || 0) + c;
    }
  }
  return Object.entries(totals)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function cellClass(count) {
  if (count === 0) return 'gh-cell-0';
  if (count <= 2) return 'gh-cell-1';
  return 'gh-cell-3';
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel gh-panel">
      <h1>Git activity</h1>
      <p class="gh-alarm">Could not read git activity — ${esc(state.error)}.
      That is a failure to look, not an empty heatmap.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel gh-panel"><h1>Git activity</h1>
      <p class="gh-loading">Reading git activity…</p></section>`;
    return;
  }

  const { days, totalCommits, daysWithCommits } = state.data;

  if (totalCommits === 0 && daysWithCommits === 0) {
    root.innerHTML = `<section class="panel gh-panel">
      <h1>Git activity</h1>
      <p class="gh-empty">No commits in the last 30 days. That is a real count, not a failed read.</p>
    </section>`;
    return;
  }

  const projects = buildProjectList(days);
  const dayKeys = days.map((d) => d.date);

  // Section 1: Activity heatmap
  let heatmapHTML = '';
  if (projects.length === 0) {
    heatmapHTML = '<p class="gh-empty">No project directories found in the last 30 days.</p>';
  } else {
    const headerCells = dayKeys
      .map((d) => `<th class="gh-th" title="${esc(d)}">${esc(d.slice(8))}</th>`)
      .join('');
    const rowsHTML = projects.map((p) => {
      const cells = dayKeys
        .map((d) => {
          const day = days.find((dd) => dd.date === d);
          const count = day && day.projects[p] ? day.projects[p] : 0;
          return `<td class="gh-cell ${cellClass(count)}" title="${esc(p)} ${esc(d)}: ${count}">
            ${count > 0 ? count : ''}
          </td>`;
        })
        .join('');
      return `<tr class="gh-row">
        <th class="gh-row-label">${esc(p)}</th>
        ${cells}
      </tr>`;
    }).join('');

    heatmapHTML = `<div class="gh-scroll">
      <table class="gh-grid">
        <thead><tr class="gh-head-row">
          <th class="gh-corner"></th>
          ${headerCells}
        </tr></thead>
        <tbody>${rowsHTML}</tbody>
      </table>
    </div>`;
  }

  // Section 2: Project totals
  const totals = projectTotals(days);
  const knownProjects = new Set(projects);
  const totalsHTML = totals.length
    ? totals.map((t) => {
        const bar = `<span class="gh-bar" style="--gh-bar: ${Math.min(t.count, 20)}"></span>`;
        return `<li class="gh-total-row">
          <span class="gh-total-name">${esc(t.name)}</span>
          ${bar}
          <span class="gh-total-count">${t.count}</span>
        </li>`;
      }).join('')
    : '<p class="gh-empty">No project directories found in the last 30 days.</p>';

  // Section 3: Daily totals
  const dailyHTML = days.map((d) => {
    const count = d.total;
    const barWidth = Math.min(count, 10);
    const bar = count > 0
      ? `<span class="gh-day-bar" style="--gh-day-bar: ${barWidth}"></span>`
      : '<span class="gh-day-bar gh-day-bar-0"></span>';
    return `<li class="gh-day-row">
      <span class="gh-day-date">${esc(d.date)}</span>
      ${bar}
      <span class="gh-day-count">${count}</span>
    </li>`;
  }).join('');

  root.innerHTML = `<section class="panel gh-panel">
    <h1>Git activity</h1>
    <p class="gh-lede">Which projects are moving and which are dormant. One commit can carry files from multiple projects.</p>

    <h2 class="gh-h2">Activity heatmap <span class="gh-n">${totalCommits}</span></h2>
    <p class="gh-asof">${daysWithCommits} of ${days.length} days had commits. ${totalCommits} commits total.</p>
    ${heatmapHTML}

    <h2 class="gh-h2">Project totals <span class="gh-n">${totals.length}</span></h2>
    <ul class="gh-totals">${totalsHTML}</ul>

    <h2 class="gh-h2">Daily totals <span class="gh-n">${daysWithCommits}</span></h2>
    <ul class="gh-daily">${dailyHTML}</ul>
  </section>`;
}

async function load() {
  try {
    state.data = await (await fetch('/api/git-heatmap')).json();
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
    renderLede('git-heatmap', el);
  },
  unmount() { root = null; state = null; },
};