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

const initial = window.location.hash.replace('#', '') || 'focus';
mountPanel(PANELS[initial] ? initial : 'focus');
