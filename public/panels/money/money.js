// money — merged Finance + Budget + Income panel.
//
// Three tabs, one panel. Each tab mounts the original sub-panel into a
// shared container. No routes change, no data moves, no CSS is duplicated —
// each sub-panel's stylesheet is loaded by the shell's panelStyles loader
// when this panel loads its own sheet.
//
// The merge is structural only: the nav has one item instead of three, and
// the user sees tabs instead of three separate panels. Everything else —
// the route, the table, the render — stays in the original panel files.
import { panelStyles } from '/shell.js';

const SUB_PANELS = [
  { name: 'finance', label: 'Money' },
  { name: 'budget', label: 'Budget' },
  { name: 'income', label: 'Income' },
  { name: 'crm', label: 'Clients' },
];

let root = null;
let activeTab = 'finance';
let mounted = {};  // name -> module
let container = null;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Money</h1></div>
    <div class="mny-tabs" id="mnyTabs"></div>
    <div id="mnyBody"></div>
  </div>`;

async function switchTab(name) {
  if (!root) return;
  activeTab = name;

  // Update tab styling
  const tabs = root.querySelectorAll('.mny-tab');
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));

  // Unmount the current sub-panel
  for (const [n, mod] of Object.entries(mounted)) {
    if (n !== name && typeof mod.unmount === 'function') {
      mod.unmount();
    }
  }

  // Load the sub-panel's stylesheet
  panelStyles(name);

  // Import if not yet loaded
  if (!mounted[name]) {
    try {
      const mod = await import(`/panels/${name}/${name}.js`);
      mounted[name] = mod.default;
    } catch (err) {
      if (container) container.innerHTML = `<p class="vc-err">Could not load ${esc(name)}: ${esc(err.message)}</p>`;
      return;
    }
  }

  if (!root) return;

  // Mount the sub-panel into the body
  const body = root.querySelector('#mnyBody');
  if (!body) return;
  body.innerHTML = '';
  if (mounted[name] && typeof mounted[name].mount === 'function') {
    mounted[name].mount(body);
  }
}

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;

    // Render tabs
    const tabRow = el.querySelector('#mnyTabs');
    tabRow.innerHTML = SUB_PANELS.map((p) =>
      `<button class="mny-tab${p.name === activeTab ? ' active' : ''}" data-tab="${p.name}">${esc(p.label)}</button>`
    ).join('');
    tabRow.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-tab]');
      if (btn) switchTab(btn.dataset.tab);
    });

    container = el.querySelector('#mnyBody');
    switchTab(activeTab);
  },
  unmount() {
    for (const [name, mod] of Object.entries(mounted)) {
      if (typeof mod.unmount === 'function') mod.unmount();
    }
    mounted = {};
    root = null;
    container = null;
  },
};