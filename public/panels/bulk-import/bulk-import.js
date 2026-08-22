//
// bulk-import — paste a JSON or CSV list and import items into the board.
//
// This panel is a WRITE surface for the board, the one the board itself is not: the
// board reads external trackers and never writes to them, and this panel writes to
// board_items with source = 'bulk-import'. It exists so the owner can seed the board
// from a list without editing a tracker file.
//
// ABSENCE AND FAILURE MUST LOOK DIFFERENT. An empty textarea is "paste something";
// a parse error is "your input is malformed"; a failed import is "the server refused
// it". These are three different states and they get three different messages, because
// a failure that looks like good news is the failure this workspace keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let root = null;
let state = null;

// Parse JSON or CSV input. Returns { items, error }.
// JSON: { items: [...] } or a bare array.
// CSV: ref,title,project,kind per line. First line is treated as a header if it
// contains "title" or "ref" (case-insensitive), so a pasted spreadsheet works.
function parseInput(text) {
  const trimmed = text.trim();
  if (!trimmed) return { items: [], error: null };

  // Try JSON first — the most structured input, and the one the template produces.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      const items = Array.isArray(data) ? data : (data.items || []);
      const normalized = items.map(normalizeItem).filter(Boolean);
      return { items: normalized, error: null };
    } catch (e) {
      return { items: [], error: `Invalid JSON — ${e.message}` };
    }
  }

  // CSV: comma-separated, ref,title,project,kind per line.
  const lines = trimmed.split(/\r?\n/);
  const items = [];
  let startIdx = 0;

  // Detect a header row: if the first line contains "title" or "ref" it is a header,
  // not data. This lets a pasted spreadsheet with column names work without editing.
  const firstLower = lines[0].toLowerCase();
  if (firstLower.includes('title') || firstLower.includes('ref')) {
    startIdx = 1;
  }

  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',').map((s) => s.trim());
    const it = normalizeItem({
      ref: parts[0] || '',
      title: parts[1] || '',
      project: parts[2] || '',
      kind: parts[3] || '',
    });
    if (it) items.push(it);
  }

  return { items, error: null };
}

// Normalize a raw item from JSON or CSV. Returns null if the item has no title —
// the one required field. kind defaults to 'backlog', project to '(unassigned)'.
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  if (!title) return null;
  return {
    ref: String(raw.ref || '').trim() || null,
    title,
    project: String(raw.project || '').trim() || '(unassigned)',
    kind: String(raw.kind || 'backlog').trim() || 'backlog',
  };
}

function previewTable(items) {
  if (!items.length) return '';
  const rows = items.map((it, i) => `<tr>
    <td class="bi-ref">${esc(it.ref || `(auto-${i + 1})`)}</td>
    <td class="bi-title">${esc(it.title)}</td>
    <td class="bi-proj">${esc(it.project)}</td>
    <td class="bi-kind">${esc(it.kind)}</td>
  </tr>`).join('');
  return `<table class="bi-table"><thead><tr>
    <th>Ref</th><th>Title</th><th>Project</th><th>Kind</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

function render() {
  if (!root || !state) return;

  const { input, parsed, importing, result, error } = state;

  // ERROR STATE — a parse or import failure. Distinct from the empty state below:
  // this is a failure to process, not "nothing pasted yet". The accent border makes
  // it unmistakable against the muted empty-state text.
  const errorHTML = error
    ? `<p class="bi-alarm">Import failed — ${esc(error)}. Check your JSON format.</p>`
    : '';

  // RESULT STATE — the import completed. Shows the counts so "imported 0" is visible
  // and distinguishable from "nothing was sent".
  const resultHTML = result
    ? `<p class="bi-result">Imported ${result.imported} items, ${result.failed} skipped/failed.</p>`
    : '';

  // PREVIEW — what will be imported if the button is pressed. Shown only when there
  // is parsed input with items, so it does not clutter the empty state.
  const previewHTML = parsed && parsed.items.length
    ? `<h2 class="bi-h2">Preview <span class="bi-n">${parsed.items.length}</span></h2>
       ${previewTable(parsed.items)}`
    : '';

  // EMPTY STATE — no input yet. This is an invitation, not an error: muted text,
  // no border, no alarm colour.
  const emptyHTML = (!input || !input.trim()) && !result && !error
    ? `<p class="bi-empty">Paste JSON or CSV to import. Each item needs at least a title.</p>`
    : '';

  const importDisabled = !parsed || !parsed.items.length || importing;

  root.innerHTML = `<section class="panel bi-panel">
    <h1>Bulk import</h1>
    <p class="bi-lede">Paste a JSON or CSV list of items to import into the board. Each item
      needs at least a title; ref, project and kind are optional. Items already on the board
      with the same ref and title are skipped, not duplicated.</p>

    ${errorHTML}
    ${resultHTML}

    <textarea class="bi-input" rows="12"
      placeholder='JSON:\n{ "items": [{ "ref": "M001", "title": "Fix login", "project": "Mission Control", "kind": "backlog" }] }\n\nCSV (ref,title,project,kind):\nM001,Fix login,Mission Control,backlog'>${esc(input || '')}</textarea>

    <div class="bi-actions">
      <button class="bi-btn bi-btn-primary"${importDisabled ? ' disabled' : ''}>${importing ? 'Importing…' : 'Import'}</button>
      <button class="bi-btn" id="biTemplate">Download template</button>
    </div>

    ${emptyHTML}
    ${previewHTML}
  </section>`;

  // Wire the textarea — live preview as the user types.
  const ta = root.querySelector('.bi-input');
  if (ta) {
    ta.addEventListener('input', () => {
      state.input = ta.value;
      const p = parseInput(ta.value);
      state.parsed = p;
      state.error = p.error;
      // Clear a stale result when the user starts editing again.
      if (state.result) state.result = null;
      render();
    });
  }

  // Wire the import button.
  const importBtn = root.querySelector('.bi-btn-primary');
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      if (!state.parsed || !state.parsed.items.length) return;
      state.importing = true;
      state.error = null;
      render();
      try {
        const r = await fetch('/api/bulk-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-mc-by': 'you' },
          body: JSON.stringify({ items: state.parsed.items }),
        });
        if (!r.ok) throw new Error(`server answered ${r.status}`);
        const data = await r.json();
        state.result = data;
        state.error = null;
        state.input = '';
        state.parsed = { items: [], error: null };
      } catch (e) {
        state.error = e.message;
        state.result = null;
      }
      state.importing = false;
      render();
    });
  }

  // Wire the template download button.
  const tplBtn = root.getElementById('biTemplate');
  if (tplBtn) {
    tplBtn.addEventListener('click', () => {
      const template = JSON.stringify({
        items: [{ ref: 'M001', title: 'Example item', project: 'Mission Control', kind: 'backlog' }],
      }, null, 2);
      const blob = new Blob([template], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bulk-import-template.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

export default {
  mount(el, opts) {
    root = el;
    state = {
      input: '',
      parsed: { items: [], error: null },
      importing: false,
      result: null,
      error: null,
    };
    render();
    renderLede('bulk-import', el);
  },
  unmount() { root = null; state = null; },
};
