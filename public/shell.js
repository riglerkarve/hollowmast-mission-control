const PANELS = {
  servers: () => import('/panels/servers/servers.js'),
  'habit-tracker': () => import('/panels/habit-tracker/habit-tracker.js'),
  'launch-readiness': () => import('/panels/launch-readiness/launch-readiness.js'),
  'team-digest': () => import('/panels/team-digest/team-digest.js'),
  'todo': () => import('/panels/todo/todo.js'),
  'unsigned': () => import('/panels/unsigned/unsigned.js'),
  crm: () => import('/panels/crm/crm.js'),
  inventory: () => import('/panels/inventory/inventory.js'),
  focus: () => import('/panels/focus/focus.js'),
  reports: () => import('/panels/reports/reports.js'),
  finance: () => import('/panels/finance/finance.js'),
  budget: () => import('/panels/budget/budget.js'),
  income: () => import('/panels/income/income.js'),
  lifestyle: () => import('/panels/lifestyle/lifestyle.js'),
  wellbeing: () => import('/panels/wellbeing/wellbeing.js'),
  brain: () => import('/panels/brain/brain.js'),
  mail: () => import('./panels/mail/mail.js'),
  work: () => import('./panels/work/work.js'),
  exercise: () => import('./panels/exercise/exercise.js'),
  safety: () => import('/panels/safety/safety.js'),
  browsing: () => import('/panels/browsing/browsing.js'),
  atlas: () => import('/panels/atlas/atlas.js'),
  board: () => import('/panels/board/board.js'),
  team: () => import('/panels/team/team.js'),
  goals: () => import('/panels/goals/goals.js'),
  viability: () => import('/panels/viability/viability.js'),
  schedule: () => import('/panels/schedule/schedule.js'),
  projects: () => import('/panels/projects/projects.js'),
  machine: () => import('/panels/machine/machine.js'),
  analytics: () => import('/panels/analytics/analytics.js'),
  voice: () => import('/panels/voice/voice.js'),
  briefing: () => import('/panels/briefing/briefing.js'),
  activity: () => import('/panels/activity/activity.js'),
  inbox: () => import('/panels/inbox/inbox.js'),
  money: () => import('/panels/money/money.js'),
  // Reads /api/finance — purpose is an attribute of a transaction and finance owns those.
  purpose: () => import('/panels/purpose/purpose.js'),
  life: () => import('/panels/life/life.js'),
  system: () => import('/panels/system/system.js'),
  creative: () => import('/panels/creative/creative.js'),
  journal: () => import('/panels/journal/journal.js'),
  digest: () => import('/panels/digest/digest.js'),
  decisions: () => import('/panels/decisions/decisions.js'),
  changes: () => import('/panels/changes/changes.js'),
  workspace: () => import('/panels/workspace/workspace.js'),
  alerts: () => import('/panels/alerts/alerts.js'),
  ventures: () => import('/panels/ventures/ventures.js'),
  agents: () => import('/panels/agents/agents.js'),
  prioritize: () => import('/panels/prioritize/prioritize.js'),
  scribe: () => import('/panels/scribe/scribe.js'),
  stale: () => import('/panels/stale/stale.js'),
  'health-check': () => import('/panels/health-check/health-check.js'),
  'time-allocation': () => import('/panels/time-allocation/time-allocation.js'),
  timeline: () => import('/panels/timeline/timeline.js'),
  'api-explorer': () => import('/panels/api-explorer/api-explorer.js'),
  'workspace-overview': () => import('/panels/workspace-overview/workspace-overview.js'),
  'decision-radar': () => import('/panels/decision-radar/decision-radar.js'),
  standup: () => import('/panels/standup/standup.js'),
  hollowmast: () => import('/panels/hollowmast/hollowmast.js'),
  'weekly-metrics': () => import('/panels/weekly-metrics/weekly-metrics.js'),
  'git-heatmap': () => import('/panels/git-heatmap/git-heatmap.js'),
  'bulk-import': () => import('/panels/bulk-import/bulk-import.js'),
  printprofit: () => import('/panels/printprofit/printprofit.js'),
  search: () => import('/panels/search/search.js'),
  'dependency-graph': () => import('/panels/dependency-graph/dependency-graph.js'),
  'health-score': () => import('/panels/health-score/health-score.js'),
  'recurring-costs': () => import('/panels/recurring-costs/recurring-costs.js'),
  'goal-staleness': () => import('/panels/goal-staleness/goal-staleness.js'),
  'browsing-recall': () => import('/panels/browsing-recall/browsing-recall.js'),
  'safety-retro': () => import('/panels/safety-retro/safety-retro.js'),
  'claude-timeline': () => import('/panels/claude-timeline/claude-timeline.js'),
};

const panelRoot = document.getElementById('panelRoot');
const navItems = document.querySelectorAll('.nav-item');

let activePanel = null;

// Two switches can be in flight at once, because this function AWAITS the dynamic import
// before it mounts. Leave a panel and come straight back while its module is still loading
// and the two calls interleave: the second one mounts, then the first one's import resolves
// and mounts ON TOP, overwriting the panel that legitimately won.
//
// The panel that got clobbered then crashes, and its own generation guard cannot see this,
// because the damage was done by a different module writing to the shared root. Measured:
// with an uncached module and a 0 ms gap between clicks, projects.js threw
// "Cannot set properties of null (setting 'textContent')" and #prjCount was absent from
// the DOM entirely. It only reproduces on a FIRST visit -- once the module is cached the
// await resolves in a microtask and the window closes, which is why it reads as random.
let mountToken = 0;
let mountAbort = null;   // aborted when the panel that owns it is torn down

// A panel’s stylesheet loads WITH the panel, not before every panel.
//
// Measured 18 Aug: index.html pulled 20 stylesheets on first paint, and 112,892 of the
// 148,433 CSS bytes — 76% — belonged to panels that were not on screen. The JS was already
// lazy (17 dynamic imports); the CSS was not, which was an inconsistency rather than a
// decision. On localhost that costs nothing. This dashboard is meant to be opened from a
// phone on the LAN, where it is 18 extra round trips before anything paints.
//
// It AWAITS the load. Mounting first would show one unstyled frame, and a flash of
// unstyled content on every panel switch is a worse defect than the one being fixed.
// A stylesheet that fails to load resolves anyway: a panel with plain styling beats a
// panel that never appears.
// EXPORTED, because a panel can be mounted from somewhere other than the registry and the
// stylesheet must follow it there. It did not, and the cost was invisible: `todo` was removed
// from PANELS when the backlog moved inside Focus, so nothing triggered todo.css, and the
// backlog rendered 1,378 elements against ZERO matching rules for as long as it lived there.
// Nothing errored — an unstyled panel is a working panel that looks wrong, which is why it
// survived review. One owner for "load this panel's sheet"; embedders call it too. (M72)
const sheetsLoaded = new Set();
export function panelStyles(name) {
  if (sheetsLoaded.has(name)) return Promise.resolve();
  const href = `/panels/${name}/${name}.css`;
  if (document.querySelector(`link[href="${href}"]`)) { sheetsLoaded.add(name); return Promise.resolve(); }
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.addEventListener('load', () => { sheetsLoaded.add(name); resolve(); });
    link.addEventListener('error', () => resolve());   // unstyled beats absent
    document.head.appendChild(link);
  });
}
async function mountPanel(name) {
  const loader = PANELS[name];
  if (!loader) return;
  const token = ++mountToken;

  if (activePanel && typeof activePanel.unmount === 'function') {
    activePanel.unmount();
  }
  // Nothing is mounted from here until we mount. Without this, a superseded call that
  // returns below would leave activePanel pointing at a panel it already unmounted, and
  // the next switch would unmount it a second time.
  activePanel = null;
  // Cancel the outgoing panel's in-flight work. Every panel nulls its own root in
  // unmount(), so a fetch resolving after a switch dereferences null and throws
  // "Cannot read properties of null". Measured 18 Aug: 7 panels threw while the contrast
  // audit drove all 14 in sequence.
  //
  // NOT the race mountToken fixes. That one stops the WRONG PANEL mounting after a slow
  // import; this is the right panel resolving after its own teardown, and the token cannot
  // see it. A first attempt at this gave each panel its own container and detached it on
  // switch, on the theory that the writes were landing in an emptied root -- they are not,
  // the root reference itself is null, and that fix silenced nothing.
  //
  // The signal reaches mount() as a second argument, which todo.mount(el, opts) already
  // accepts and focus.mount(el0) ignores. A panel that passes it to fetch never runs its
  // continuation; one that does not still needs its own guard, because aborting cannot
  // un-write code that never checks.
  if (mountAbort) mountAbort.abort();
  mountAbort = new AbortController();
  panelRoot.innerHTML = '';

  let mod;
  try {
    mod = await loader();
  } catch (err) {
    // A failed import and an empty panel are NOT the same thing, and by this point the
    // root is already cleared and activePanel already null -- so without this the pane
    // goes blank, the nav button never lights, and the only trace is an unhandled
    // rejection in a console nobody has open. Say what happened, in the pane.
    if (token !== mountToken) return;
    panelRoot.innerHTML = `<div class="panel"><div class="panel-header"><h1>${name}</h1></div>`
      + '<section class="card"><p class="empty-hint">This panel failed to load: '
      + `${String(err && err.message ? err.message : err).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}`
      + '<br>That is a failure to load, not an empty panel. Reload the page; if it persists '
      + 'the panel module itself is broken.</p></section></div>';
    navItems.forEach((btn) => btn.classList.toggle('active', btn.dataset.panel === name));
    history.replaceState(null, '', `#${name}`);
    return;
  }
  // Superseded while importing. The switch that overtook us has already unmounted us,
  // cleared the root and mounted its own panel; writing now would overwrite it.
  if (token !== mountToken) return;

  await panelStyles(name);
  if (token !== mountToken) return;
  activePanel = mod.default;
  activePanel.mount(panelRoot, { signal: mountAbort.signal });

  navItems.forEach((btn) => btn.classList.toggle('active', btn.dataset.panel === name));
  history.replaceState(null, '', `#${name}`);
}

// MindVirus OS command bar — import and wire Ctrl+K
import { toggle as toggleCmdBar } from '/mvos/commandbar.js';
import { mountNudgeBar } from '/nudge.js';

// Wire the ⌘K trigger button in the sidebar header
const mvosBtn = document.getElementById('mvosTrigger');
if (mvosBtn) mvosBtn.addEventListener('click', () => toggleCmdBar());

navItems.forEach((btn) => {
  btn.addEventListener('click', () => mountPanel(btn.dataset.panel));
});


// QUIET HOURS — backlog #29. A limit you set and can always open.
//
// It is a curtain over this page, not a lock: the override is one click, always visible,
// never delayed, and NEVER RECORDED. Nothing counts how often it is used, because the
// moment that number exists the feature has become a judgement about you rather than a
// boundary you chose.
//
// It gates the UI only. /api is untouched — the watchdog, the briefing and the nightly
// backup run through there, and a wellbeing setting must never be able to take the ops
// chain down at 23:00.
//
// The override lasts for this page view only. Not persisted, so it cannot silently stay
// off forever; not re-prompted either, so it does not nag once you have answered.
let quietOverridden = false;

async function quietCurtain() {
  if (quietOverridden) return false;
  let q;
  try {
    q = await (await fetch('/api/wellbeing/quiet')).json();
  } catch {
    // If the check itself fails, do NOT gate. A broken fetch must never lock you out of
    // your own dashboard — absence of an answer is not a reason to close the curtain.
    return false;
  }
  if (!q.active) return false;

  panelRoot.innerHTML = `
    <div class="panel">
      <section class="card quiet-card">
        <h1 class="quiet-h1">Quiet hours</h1>
        <p class="quiet-p">${q.message ? String(q.message).replace(/[&<>"']/g, '') : 'You set this window to be away from it.'}</p>
        <p class="quiet-sub">${q.from}–${q.to}. Nothing here is recording whether you stop.</p>
        <button class="btn primary" id="quietGo">Carry on anyway</button>
      </section>
    </div>`;
  panelRoot.querySelector('#quietGo').addEventListener('click', () => {
    quietOverridden = true;
    mountPanel(window.location.hash.replace('#', '') || 'workspace-overview');
  });
  return true;
}

const initial = window.location.hash.replace('#', '') || 'workspace-overview';
quietCurtain().then((gated) => { if (!gated) mountPanel(PANELS[initial] ? initial : 'workspace-overview'); });

// Outside #panelRoot, so a panel switch never clears it. mountNudgeBar checks quiet hours
// itself, the same way quietCurtain above does — belt and braces, since the two are
// independent modules and neither should assume the other already gated.
const nudgeBar = document.getElementById('nudgeBar');
if (nudgeBar) mountNudgeBar(nudgeBar);

// ZEN MODE — strip the dashboard to briefing + voice only.
// Activated by #zen in the URL or by a keyboard shortcut (Z then E).
// The sidebar hides, the content goes full-width, and only the briefing
// panel is shown. Voice quick-actions are available via the voice panel.
// This is the "I want to think" view — not the control room.
let zenActive = false;
function toggleZen() {
  zenActive = !zenActive;
  const sidebar = document.querySelector('.sidebar');
  const content = document.querySelector('.content');
  if (!sidebar || !content) return;
  if (zenActive) {
    sidebar.style.display = 'none';
    content.style.marginLeft = '0';
    mountPanel('briefing');
  } else {
    sidebar.style.display = '';
    content.style.marginLeft = '';
  }
}
// Check for #zen on load
if (window.location.hash === '#zen') toggleZen();
// Keyboard shortcut: press Z then E quickly
let zenKeyTimer = null;
document.addEventListener('keydown', (e) => {
  if (e.key === 'z' && !e.target.matches('input, textarea, select')) {
    zenKeyTimer = setTimeout(() => { zenKeyTimer = null; }, 600);
  } else if (e.key === 'e' && zenKeyTimer && !e.target.matches('input, textarea, select')) {
    clearTimeout(zenKeyTimer);
    zenKeyTimer = null;
    toggleZen();
  }
});
