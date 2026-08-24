//
// suno — Suno Ground Control: prompt library + per-take queue + credit rollup.
//
// This is a staging area for suno.com, not a control room. The owner still
// clicks generate himself; this panel exists to cut round-trip friction —
// copy a prompt, open suno.com, come back and log what happened. NOTHING HERE
// derives credits_used_today itself; that figure comes from GET /api/suno/summary,
// which is the one place SUM(queue_items.credits_spent) is computed. A panel
// that recomputed it from the queue list would agree until one of the two
// changed shape, then disagree without either erroring.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUSES = ['planned', 'generated', 'rejected', 'published'];
const OUTCOMES = ['usable', 'unusable', 'unreviewed'];

let root = null;
let state = null;

function optionsHTML(values, selected) {
  return values.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

function promptCardHTML(p) {
  const rate = p.success_rate == null ? '—' : `${p.success_rate}%`;
  return `<div class="suno-prompt-card" data-prompt-id="${p.id}">
    <div class="suno-prompt-head">
      <span class="suno-prompt-name">${esc(p.name)}</span>
      <span class="suno-prompt-rate" title="usable takes / total takes">${rate}</span>
    </div>
    <pre class="suno-prompt-style">${esc(p.style_text)}</pre>
    ${p.tags ? `<div class="suno-prompt-tags">${esc(p.tags)}</div>` : ''}
    <div class="suno-prompt-stats">${p.takes} take${p.takes === 1 ? '' : 's'} · ${p.published} published · ${p.usable} usable</div>
    <div class="suno-prompt-actions">
      <button class="suno-btn suno-btn-copy" data-copy="${esc(p.style_text)}">Copy prompt</button>
      <button class="suno-btn suno-btn-queue" data-queue-prompt="${p.id}">Add to queue</button>
      <button class="suno-btn suno-btn-edit" data-edit-prompt="${p.id}">Edit</button>
    </div>
  </div>`;
}

function queueRowHTML(item) {
  return `<tr class="suno-q-row" data-item-id="${item.id}">
    <td class="suno-q-prompt">${esc(item.prompt_name)}</td>
    <td>
      <select class="suno-status-select" data-item-id="${item.id}" data-field="status">
        ${optionsHTML(STATUSES, item.status)}
      </select>
    </td>
    <td>
      <select class="suno-outcome-select" data-item-id="${item.id}" data-field="outcome">
        ${optionsHTML(OUTCOMES, item.outcome)}
      </select>
    </td>
    <td class="suno-q-num">
      <input class="suno-credits-input" type="number" min="0" step="1" value="${esc(item.credits_spent)}"
        data-item-id="${item.id}" data-field="credits_spent" />
    </td>
    <td class="suno-q-notes">
      <input class="suno-notes-input" type="text" value="${esc(item.notes || '')}" placeholder="notes…"
        data-item-id="${item.id}" data-field="notes" />
    </td>
    <td class="suno-q-url">
      ${item.status === 'published'
        ? `<input class="suno-url-input" type="text" value="${esc(item.published_url || '')}" placeholder="published url…"
             data-item-id="${item.id}" data-field="published_url" />`
        : '<span class="suno-q-url-dim">—</span>'}
    </td>
    <td class="suno-q-date">${esc(String(item.created_at || '').slice(0, 10))}</td>
  </tr>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel suno-panel">
      <h1>Suno Ground Control</h1>
      <p class="suno-alarm">Could not load — ${esc(state.error)}. That is a failure to look, not an empty result.</p>
    </section>`;
    return;
  }

  if (!state.prompts || !state.queue || !state.summary) {
    root.innerHTML = `<section class="panel suno-panel"><h1>Suno Ground Control</h1>
      <p class="suno-loading">Loading…</p></section>`;
    return;
  }

  const { prompts } = state.prompts;
  const { items } = state.queue;
  const s = state.summary;

  const capPct = s.daily_free_cap ? Math.min(100, Math.round((s.credits_used_today / s.daily_free_cap) * 100)) : 0;

  root.innerHTML = `<section class="panel suno-panel">
    <h1>Suno Ground Control</h1>
    <p class="suno-lede">A staging area for suno.com — a prompt library, a per-take queue, and a
      credit rollup. Not an embed, not auto-generation: you still click generate yourself. This
      just cuts the round trip between "which prompt was that" and "did it work".</p>

    <div class="suno-summary${s.over_cap ? ' suno-summary-over' : ''}">
      <span class="suno-summary-label">Credits today</span>
      <span class="suno-summary-value">${s.credits_used_today} / ${s.daily_free_cap}</span>
      <span class="suno-summary-bar"><span class="suno-summary-bar-fill" style="width:${capPct}%"></span></span>
      <span class="suno-summary-note">${esc(s.cap_note)}</span>
    </div>

    <div class="suno-cols">
      <div class="suno-col-prompts">
        <div class="suno-col-head">
          <h2>Prompt library</h2>
          <button class="suno-btn suno-btn-add" id="sunoAddPrompt">+ New prompt</button>
        </div>
        <div id="sunoPromptForm" class="suno-form suno-hidden">
          <input id="sunoPromptName" type="text" placeholder="Name" />
          <textarea id="sunoPromptStyle" placeholder="Style / prompt text" rows="3"></textarea>
          <input id="sunoPromptTags" type="text" placeholder="Tags (optional)" />
          <div class="suno-form-actions">
            <button class="suno-btn suno-btn-save" id="sunoSavePrompt">Save</button>
            <button class="suno-btn suno-btn-cancel" id="sunoCancelPrompt">Cancel</button>
          </div>
        </div>
        <div class="suno-prompt-list">
          ${prompts.length
            ? prompts.map(promptCardHTML).join('')
            : '<p class="suno-empty">No prompts yet. Add one to start staging takes.</p>'}
        </div>
      </div>

      <div class="suno-col-queue">
        <h2>Queue — one row per take</h2>
        ${items.length ? `<table class="suno-table">
          <thead><tr>
            <th>Prompt</th><th>Status</th><th>Outcome</th><th class="suno-q-num">Credits</th>
            <th>Notes</th><th>Published URL</th><th>Added</th>
          </tr></thead>
          <tbody>${items.map(queueRowHTML).join('')}</tbody>
        </table>` : '<p class="suno-empty">No queue items yet. Generate on suno.com, then log each take here.</p>'}
      </div>
    </div>
  </section>`;

  wireEvents();
}

function wireEvents() {
  const addBtn = root.querySelector('#sunoAddPrompt');
  const form = root.querySelector('#sunoPromptForm');
  if (addBtn && form) {
    addBtn.addEventListener('click', () => {
      form.classList.toggle('suno-hidden');
      delete form.dataset.editId;
      root.querySelector('#sunoPromptName').value = '';
      root.querySelector('#sunoPromptStyle').value = '';
      root.querySelector('#sunoPromptTags').value = '';
    });
  }
  const cancelBtn = root.querySelector('#sunoCancelPrompt');
  if (cancelBtn) cancelBtn.addEventListener('click', () => form.classList.add('suno-hidden'));

  const saveBtn = root.querySelector('#sunoSavePrompt');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const name = root.querySelector('#sunoPromptName').value.trim();
      const styleText = root.querySelector('#sunoPromptStyle').value.trim();
      const tags = root.querySelector('#sunoPromptTags').value.trim();
      if (!name || !styleText) return;
      const editId = form.dataset.editId;
      const url = editId ? `/api/suno/prompts/${editId}` : '/api/suno/prompts';
      const method = editId ? 'PATCH' : 'POST';
      await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, style_text: styleText, tags: tags || null }),
      });
      form.classList.add('suno-hidden');
      await loadPrompts();
      render();
    });
  }

  root.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      } catch (e) {
        btn.textContent = 'Copy failed';
      }
    });
  });

  root.querySelectorAll('[data-edit-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.editPrompt;
      const p = state.prompts.prompts.find((x) => String(x.id) === String(id));
      if (!p) return;
      form.classList.remove('suno-hidden');
      form.dataset.editId = id;
      root.querySelector('#sunoPromptName').value = p.name;
      root.querySelector('#sunoPromptStyle').value = p.style_text;
      root.querySelector('#sunoPromptTags').value = p.tags || '';
      form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  root.querySelectorAll('[data-queue-prompt]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const promptId = btn.dataset.queuePrompt;
      await fetch('/api/suno/queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: Number(promptId) }),
      });
      await Promise.all([loadQueue(), loadPrompts(), loadSummary()]);
      render();
    });
  });

  root.querySelectorAll('[data-item-id][data-field]').forEach((el) => {
    const fire = async () => {
      const id = el.dataset.itemId;
      const field = el.dataset.field;
      let value = el.value;
      if (field === 'credits_spent') value = Number(value) || 0;
      await fetch(`/api/suno/queue/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      await Promise.all([loadQueue(), loadPrompts(), loadSummary()]);
      render();
    };
    if (el.tagName === 'SELECT') el.addEventListener('change', fire);
    else el.addEventListener('change', fire);
  });
}

async function loadPrompts() {
  try {
    state.prompts = await (await fetch('/api/suno/prompts')).json();
    state.error = null;
  } catch (e) { state.error = e.message; }
}
async function loadQueue() {
  try {
    state.queue = await (await fetch('/api/suno/queue')).json();
    state.error = null;
  } catch (e) { state.error = e.message; }
}
async function loadSummary() {
  try {
    state.summary = await (await fetch('/api/suno/summary')).json();
    state.error = null;
  } catch (e) { state.error = e.message; }
}

async function loadAll() {
  await Promise.all([loadPrompts(), loadQueue(), loadSummary()]);
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { prompts: null, queue: null, summary: null, error: null };
    render();
    loadAll();
    renderLede('suno', el);
  },
  unmount() { root = null; state = null; },
};
