// system — merged Machine + Analytics panel.
import { panelStyles } from '/shell.js';

const SUB_PANELS = [
  { name: 'machine', label: 'Machine' },
  { name: 'analytics', label: 'Analytics' },
];

let root = null;
let activeTab = 'machine';
let mounted = {};
let container = null;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>System</h1></div>
    <div class="mny-tabs" id="sysTabs"></div>
    <div id="sysBody"></div>
  </div>`;

async function switchTab(name) {
  if (!root) return;
  activeTab = name;
  const tabs = root.querySelectorAll('.mny-tab');
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const [n, mod] of Object.entries(mounted)) {
    if (n !== name && typeof mod.unmount === 'function') mod.unmount();
  }
  panelStyles(name);
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
  const body = root.querySelector('#sysBody');
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
    const tabRow = el.querySelector('#sysTabs');
    tabRow.innerHTML = SUB_PANELS.map((p) =>
      `<button class="mny-tab${p.name === activeTab ? ' active' : ''}" data-tab="${p.name}">${esc(p.label)}</button>`
    ).join('');
    tabRow.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-tab]');
      if (btn) switchTab(btn.dataset.tab);
    });
    container = el.querySelector('#sysBody');
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