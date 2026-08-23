//
// standup — a plain-text daily standup derived from the shift digest, not a
// form to fill in. The digest route (/api/digest) reads handovers, git activity,
// and the board, then returns { summary, highlights, working, concerns,
// generatedAt }. This panel renders that as a readable document and offers a
// Copy button so the whole standup can be pasted into a thread.
//
// NOTHING HERE IS TYPED IN. The standup text is derived from the digest data.
// If the digest is empty, the briefing pass has not run — that is reported as
// an empty state, distinct from a fetch failure which is reported as an error.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Digest prose is escaped, not parsed. A half-implemented markdown renderer that
// swallows a `**` is worse than plain text, because it silently changes what was said.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

const day = (s) => String(s || '').slice(0, 10);
const time = (s) => String(s || '').slice(11, 16);

let root = null;
let state = null;

// Build the plain-text standup from the digest data. This is the block the Copy
// button writes to the clipboard — a readable plain-text standup, not HTML.
function buildPlainText(d) {
  const lines = [];
  lines.push('DAILY STANDUP');
  if (d.generatedAt) lines.push(`Generated: ${d.generatedAt}`);
  lines.push('');
  if (d.summary) {
    lines.push('SUMMARY');
    lines.push(d.summary);
    lines.push('');
  }
  if (d.highlights && d.highlights.length) {
    lines.push('HIGHLIGHTS');
    d.highlights.forEach((h) => {
      const who = h.who ? ` [${h.who}]` : '';
      const when = h.when ? ` ${h.when}` : '';
      lines.push(`- ${h.text}${who}${when}`);
    });
    lines.push('');
  }
  if (d.working && d.working.length) {
    lines.push('WHO IS WORKING');
    d.working.forEach((w) => {
      const status = w.status || 'not reporting';
      lines.push(`- ${w.agent}: ${status} — ${w.task || ''}`);
    });
    lines.push('');
  }
  if (d.git && (d.git.moved.length || d.git.totalCommits)) {
    lines.push('GIT ACTIVITY (today)');
    d.git.moved.forEach((p) => {
      lines.push(`- ${p.project}: ${p.commits} commit${p.commits === 1 ? '' : 's'}${p.lastSubject ? ` — ${p.lastSubject}` : ''}`);
    });
    if (d.git.quietCount) lines.push(`- ${d.git.quietCount} other project(s) quiet today`);
    if (d.git.unmeasurable && d.git.unmeasurable.length) {
      lines.push(`- ${d.git.unmeasurable.length} project(s) unmeasurable: ${d.git.unmeasurable.map((p) => p.project).join(', ')}`);
    }
    lines.push('');
  }
  if (d.concerns && d.considerations && d.concerns.length) {
    lines.push('CONCERNS');
    d.concerns.forEach((c) => lines.push(`- ${c}`));
    lines.push('');
  }
  return lines.join('\n');
}

function highlightsHTML(items) {
  if (!items || !items.length) return '<p class="su-empty">No highlights in this digest.</p>';
  return items.map((h) => {
    const who = h.who ? `<span class="su-who">${esc(h.who)}</span>` : '';
    const when = h.when ? `<span class="su-when">${esc(h.when)}</span>` : '';
    return `<article class="su-item">
      <p class="su-text">${prose(h.text)}</p>
      <p class="su-attr">${who}${when}</p>
    </article>`;
  }).join('');
}

function workingHTML(items) {
  if (!items || !items.length) return '<p class="su-empty">No agents reporting in this digest.</p>';
  return items.map((w) => {
    const status = w.status || 'not reporting';
    const isMissing = !w.status || w.status === 'not reporting';
    const statusCls = isMissing ? ' su-status-missing' : '';
    return `<article class="su-item su-work">
      <p class="su-agent">${esc(w.agent)}</p>
      <p class="su-attr"><span class="su-status${statusCls}">${esc(status)}</span></p>
      ${w.task ? `<p class="su-task">${prose(w.task)}</p>` : ''}
    </article>`;
  }).join('');
}

function concernsHTML(items) {
  if (!items || !items.length) return '<p class="su-empty">No concerns in this digest.</p>';
  return items.map((c) => `<article class="su-item"><p class="su-text">${prose(typeof c === 'string' ? c : c.text || '')}</p></article>`).join('');
}

function gitHTML(git) {
  if (!git || (!git.moved.length && !git.quietCount && !(git.unmeasurable && git.unmeasurable.length))) {
    return '<p class="su-empty">No git activity data in this digest.</p>';
  }
  const rows = git.moved.map((p) => `<article class="su-item">
      <p class="su-agent">${esc(p.project)} <span class="su-status">${p.commits} commit${p.commits === 1 ? '' : 's'}</span></p>
      ${p.lastSubject ? `<p class="su-task">${prose(p.lastSubject)}</p>` : ''}
    </article>`).join('');
  const tail = [];
  if (git.quietCount) tail.push(`<p class="su-empty">${esc(git.quietCount)} other project(s) quiet today.</p>`);
  if (git.unmeasurable && git.unmeasurable.length) {
    tail.push(`<p class="su-empty">${esc(git.unmeasurable.length)} project(s) unmeasurable: ${esc(git.unmeasurable.map((p) => p.project).join(', '))}.</p>`);
  }
  return rows + tail.join('');
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel su-panel">
      <h1>Daily standup</h1>
      <p class="su-alarm">Could not read digest — ${esc(state.error)}.
      That is a failure to look, not an empty standup.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel su-panel">
      <h1>Daily standup</h1>
      <p class="su-loading">Reading the digest…</p>
    </section>`;
    return;
  }

  const d = state.data;

  // Empty state: the digest returned but has no content at all.
  const hasContent = d.summary || (d.highlights && d.highlights.length) ||
    (d.working && d.working.length) || (d.concerns && d.concerns.length) ||
    (d.git && (d.git.moved.length || d.git.quietCount || (d.git.unmeasurable && d.git.unmeasurable.length)));
  if (!hasContent) {
    root.innerHTML = `<section class="panel su-panel">
      <h1>Daily standup</h1>
      <p class="su-lede">A plain-text standup derived from handovers, git activity, and the board.
      Not a thing to fill in — a thing to read.</p>
      <p class="su-empty">No digest data available. The standup is generated, not typed —
      if nothing is here, the briefing pass has not run.</p>
    </section>`;
    return;
  }

  const summaryHTML = d.summary
    ? `<p class="su-summary">${prose(d.summary)}</p>`
    : '';

  const generatedHTML = d.generatedAt
    ? `<p class="su-asof">Generated ${esc(day(d.generatedAt))} ${esc(time(d.generatedAt))}.</p>`
    : '';

  const plainText = buildPlainText(d);

  root.innerHTML = `<section class="panel su-panel">
    <h1>Daily standup</h1>
    <p class="su-lede">A plain-text standup derived from handovers, git activity, and the board.
    Not a thing to fill in — a thing to read.</p>

    <div class="su-toolbar">
      <button class="su-copy" type="button">Copy</button>
    </div>

    ${generatedHTML}
    ${summaryHTML}

    <h2 class="su-h2">Highlights</h2>
    ${highlightsHTML(d.highlights)}

    <h2 class="su-h2">Who is working</h2>
    ${workingHTML(d.working)}

    <h2 class="su-h2">Git activity (today)</h2>
    ${gitHTML(d.git)}

    <h2 class="su-h2">Concerns</h2>
    ${concernsHTML(d.concerns)}
  </section>`;

  // Wire the Copy button: writes the derived plain-text standup to the clipboard.
  const btn = root.querySelector('.su-copy');
  if (btn) {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(plainText);
        btn.textContent = 'Copied';
        btn.classList.add('su-copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('su-copied'); }, 2000);
      } catch (e) {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }
    });
  }
}

async function load() {
  try {
    state.data = await (await fetch('/api/digest')).json();
    state.error = null;
  } catch (e) {
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
    renderLede('standup', el);
  },
  unmount() { root = null; state = null; },
};