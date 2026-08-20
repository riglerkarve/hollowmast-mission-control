// life — merged Lifestyle + Exercise + Wellbeing panel.
// Same pattern as money: three tabs, each mounts the original sub-panel.
import { panelStyles } from '/shell.js';
import { mountSupportCard } from '/panels/wellbeing/wellbeing.js';

const SUB_PANELS = [
  { name: 'lifestyle', label: 'Lifestyle' },
  { name: 'exercise', label: 'Exercise' },
  { name: 'wellbeing', label: 'Wellbeing' },
];

let root = null;
let activeTab = 'lifestyle';
let mounted = {};
let container = null;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const TEMPLATE = `
  <div class="panel">
    <div class="panel-header"><h1>Life</h1></div>
    <div class="mny-tabs" id="lifeTabs"></div>
    <div id="lifeBody"></div>
    <section class="card wb-support" id="lifeSupport"></section>
  </div>`;

async function switchTab(name) {
  if (!root) return;
  activeTab = name;
  const tabs = root.querySelectorAll('.mny-tab');
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  // The Wellbeing sub-panel draws its own identical support card inside #lifeBody, so the
  // persistent one is hidden (not removed -- it keeps rendering underneath) only for that
  // one tab, to avoid showing the same fixed card twice on screen at once.
  const persistent = root.querySelector('#lifeSupport');
  if (persistent) persistent.style.display = name === 'wellbeing' ? 'none' : '';
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
  const body = root.querySelector('#lifeBody');
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
    const tabRow = el.querySelector('#lifeTabs');
    tabRow.innerHTML = SUB_PANELS.map((p) =>
      `<button class="mny-tab${p.name === activeTab ? ' active' : ''}" data-tab="${p.name}">${esc(p.label)}</button>`
    ).join('');
    tabRow.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-tab]');
      if (btn) switchTab(btn.dataset.tab);
    });
    container = el.querySelector('#lifeBody');
    switchTab(activeTab);

    // The support card is fixed and always present per the workspace CLAUDE.md wellbeing
    // rule -- gating it behind the Wellbeing sub-tab (as switchTab does for everything else)
    // would mean it never renders for someone who only ever opens Lifestyle or Exercise.
    // Loaded here, once, outside the tab-gated body, so it survives every switchTab() call.
    panelStyles('wellbeing');
    mountSupportCard(el.querySelector('#lifeSupport'));
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