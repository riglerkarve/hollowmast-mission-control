const PANELS = {
  focus: () => import('/panels/focus/focus.js'),
  reports: () => import('/panels/reports/reports.js'),
  finance: () => import('/panels/finance/finance.js'),
  budget: () => import('/panels/budget/budget.js'),
  todo: () => import('/panels/todo/todo.js'),
  income: () => import('/panels/income/income.js'),
  lifestyle: () => import('/panels/lifestyle/lifestyle.js'),
  wellbeing: () => import('/panels/wellbeing/wellbeing.js'),
  brain: () => import('/panels/brain/brain.js'),
  safety: () => import('/panels/safety/safety.js'),
  browsing: () => import('/panels/browsing/browsing.js'),
  goals: () => import('/panels/goals/goals.js'),
  schedule: () => import('/panels/schedule/schedule.js'),
};

const panelRoot = document.getElementById('panelRoot');
const navItems = document.querySelectorAll('.nav-item');

let activePanel = null;

async function mountPanel(name) {
  const loader = PANELS[name];
  if (!loader) return;

  if (activePanel && typeof activePanel.unmount === 'function') {
    activePanel.unmount();
  }
  panelRoot.innerHTML = '';

  const mod = await loader();
  activePanel = mod.default;
  activePanel.mount(panelRoot);

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
