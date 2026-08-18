const PANELS = {
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
  safety: () => import('/panels/safety/safety.js'),
  browsing: () => import('/panels/browsing/browsing.js'),
  atlas: () => import('/panels/atlas/atlas.js'),
  goals: () => import('/panels/goals/goals.js'),
  schedule: () => import('/panels/schedule/schedule.js'),
  projects: () => import('/panels/projects/projects.js'),
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

  activePanel = mod.default;
  activePanel.mount(panelRoot, { signal: mountAbort.signal });

  navItems.forEach((btn) => btn.classList.toggle('active', btn.dataset.panel === name));
  history.replaceState(null, '', `#${name}`);
}

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
    mountPanel(window.location.hash.replace('#', '') || 'focus');
  });
  return true;
}

const initial = window.location.hash.replace('#', '') || 'focus';
quietCurtain().then((gated) => { if (!gated) mountPanel(PANELS[initial] ? initial : 'focus'); });
