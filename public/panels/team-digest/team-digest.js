//
// team-digest — a plain-language version of the shift, for the owner.
//
// The full team report (/api/team/report) is written for the supervisor: it
// carries every handover, plan, gap and decision with its own jargon.  An owner
// who just wants to know "what happened and what needs me?" should not have to
// parse it.  This panel reads /api/digest — which paraphrases the report into a
// short, plain-English summary — and renders it in words a non-participant can
// follow.
//
// NOTHING HERE DERIVES GAPS OF ITS OWN.  The route owns that truth; this panel
// only displays what the route returns.  A panel that recomputed "what the
// process missed" would agree with the route until one was edited, and then
// disagree without either erroring — the exact failure the team route was
// written to prevent.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Prose is escaped, not parsed. A half-implemented markdown renderer that
// swallows a `**` is worse than plain text, because it silently changes what
// was recorded.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

let root = null;
let state = null;

// Build the plain-text version of the digest for the Copy button.  This is the
// same content rendered as HTML below, flattened to text so it can be pasted
// into a note or a message without carrying markup.  No jargon is added — only
// the words the route already chose, laid out in lines.
function toPlainText(d) {
  const lines = [];

  lines.push('Team Digest');
  lines.push('');
  lines.push(d.summary || '(No summary.)');
  lines.push('');

  if (d.highlights && d.highlights.length) {
    lines.push('Highlights');
    for (const h of d.highlights) {
      const who = h.who ? ` (${h.who})` : '';
      lines.push(`  • ${h.text}${who}`);
    }
    lines.push('');
  }

  if (d.working && d.working.length) {
    lines.push('Who is working');
    for (const w of d.working) {
      const mark = w.status === 'active' ? 'active' : 'not reporting';
      lines.push(`  • ${w.agent} — ${mark}: ${w.task}`);
    }
    lines.push('');
  }

  if (d.concerns && d.concerns.length) {
    lines.push('Concerns');
    for (const c of d.concerns) {
      lines.push(`  ! ${c.text}`);
    }
    lines.push('');
  }

  if (d.generatedAt) {
    lines.push(`Generated ${d.generatedAt}`);
  }

  return lines.join('\n');
}

function summaryHTML(d) {
  if (!d.summary) return '';
  return `<h2 class="td-headline">${prose(d.summary)}</h2>`;
}

function highlightsHTML(d) {
  const hs = d.highlights || [];
  if (!hs.length) return '';
  const items = hs.map((h) => {
    const who = h.who ? ` <span class="td-who">${esc(h.who)}</span>` : '';
    return `<li class="td-hl">${prose(h.text)}${who}</li>`;
  }).join('');
  return `<div class="td-section">
    <h3 class="td-h3">Highlights</h3>
    <ul class="td-list">${items}</ul>
  </div>`;
}

function workingHTML(d) {
  const ws = d.working || [];
  if (!ws.length) return '';
  const items = ws.map((w) => {
    const active = w.status === 'active';
    const cls = active ? 'td-w-active' : 'td-w-silent';
    const mark = active ? 'active' : 'not reporting';
    return `<li class="td-w ${cls}">
      <span class="td-w-name">${esc(w.agent)}</span>
      <span class="td-w-mark">${mark}</span>
      <span class="td-w-task">${prose(w.task)}</span>
    </li>`;
  }).join('');
  return `<div class="td-section">
    <h3 class="td-h3">Who is working</h3>
    <ul class="td-roster">${items}</ul>
  </div>`;
}

function concernsHTML(d) {
  const cs = d.concerns || [];
  if (!cs.length) return '';
  const items = cs.map((c) => {
    const severe = c.severity === 'severe';
    const cls = severe ? 'td-c-severe' : 'td-c-note';
    return `<li class="td-c ${cls}">
      <span class="td-c-mark" aria-hidden="true">!</span>
      <span class="td-c-text">${prose(c.text)}</span>
    </li>`;
  }).join('');
  return `<div class="td-section">
    <h3 class="td-h3">Concerns</h3>
    <ul class="td-concerns">${items}</ul>
  </div>`;
}

function generatedHTML(d) {
  if (!d.generatedAt) return '';
  return `<p class="td-asof">Generated ${esc(d.generatedAt)}</p>`;
}

function copyButtonHTML() {
  return `<button class="td-copy" type="button">Copy</button>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel td-panel">
      <h1>Team Digest</h1>
      <p class="td-alarm">Could not read the digest — ${esc(state.error)}.
      That is a failure to look, not an empty briefing.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel td-panel"><h1>Team Digest</h1>
      <p class="td-loading">Reading the briefing…</p></section>`;
    return;
  }

  const d = state.data;

  // Empty state: the route returned successfully but there is nothing to show.
  // This is distinct from an error — absence and failure must never look the
  // same — so it gets its own copy and its own wording.
  const hasContent = d.summary || (d.highlights && d.highlights.length) ||
    (d.working && d.working.length) || (d.concerns && d.concerns.length);
  if (!hasContent) {
    root.innerHTML = `<section class="panel td-panel">
      <h1>Team Digest</h1>
      <p class="td-empty">No digest available. The briefing pass generates this.</p>
    </section>`;
    return;
  }

  root.innerHTML = `<section class="panel td-panel">
    <div class="td-header">
      <h1>Team Digest</h1>
      ${copyButtonHTML()}
    </div>
    ${summaryHTML(d)}
    ${highlightsHTML(d)}
    ${workingHTML(d)}
    ${concernsHTML(d)}
    ${generatedHTML(d)}
  </section>`;

  const btn = root.querySelector('.td-copy');
  if (btn) btn.addEventListener('click', onCopy);
}

async function onCopy() {
  if (!root || !state || !state.data) return;
  const btn = root.querySelector('.td-copy');
  if (btn) btn.disabled = true;
  try {
    const text = toPlainText(state.data);
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1400);
    }
  } catch (e) {
    if (btn) { btn.textContent = 'Copy failed'; btn.disabled = false; }
  }
}

async function load() {
  try {
    const r = await fetch('/api/digest');
    if (!r.ok) throw new Error(`${r.status}`);
    state.data = await r.json();
    state.error = null;
  } catch (e) {
    state.data = null;
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
    renderLede('team-digest', el);
  },
  unmount() { root = null; state = null; },
};