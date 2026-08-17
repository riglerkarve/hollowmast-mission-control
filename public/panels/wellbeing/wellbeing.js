// Wellbeing. Reads only /api/wellbeing.
//
// Three rules this panel exists under, from the workspace CLAUDE.md:
//   - nothing may read as diagnosis, clinical advice, or a risk score
//   - the support card is fixed and always present, whatever the data says
//   - the local model is never involved
//
// So the numbers shown are counts and recall. There is no trend line, no average mood,
// no colour that turns red, and no sentence that tells you how you are doing. The panel
// shows you what you recorded and when — you do the interpreting.

const MOODS = [
  [1, 'rough'], [2, 'low'], [3, 'ok'], [4, 'good'], [5, 'great'],
];

const TEMPLATE = `
  <div class="panel panel-wide">
    <div class="panel-header">
      <h1>Wellbeing</h1>
      <div class="badge"><span class="badge-icon">✎</span><span id="wbCount">—</span></div>
    </div>

    <section class="card">
      <h2 class="wb-h2">How is today?</h2>
      <p class="wb-hint">Press <kbd>1</kbd>–<kbd>5</kbd>, or click. A note on its own is fine too.</p>
      <div class="wb-moods" id="wbMoods">
        ${MOODS.map(([v, l]) => `<button class="wb-mood" data-mood="${v}"><span class="wb-mood-n">${v}</span><span class="wb-mood-l">${l}</span></button>`).join('')}
      </div>
      <textarea id="wbNote" class="wb-note" rows="3" placeholder="Anything you want to write down. Optional, and private to this machine."></textarea>
      <div class="wb-actions">
        <button class="btn primary" id="wbSaveNote">Save note</button>
        <span id="wbEcho" class="wb-echo"></span>
      </div>
    </section>

    <section class="card wb-support" id="wbSupport"></section>

    <div class="wb-split">
      <section class="card"><h2 class="wb-h2">What you have recorded</h2><div id="wbPatterns"></div></section>
      <section class="card"><h2 class="wb-h2">Recent entries</h2><div id="wbEntries"></div></section>
    </div>
  </div>
`;

let root = null;
let onKey = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(p, opts) {
  const res = await fetch(`/api/wellbeing${p}`, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

// Rendered from the server's fixed block, never from anything derived. It is drawn before
// the data loads and is not removed or reordered by any later render.
function renderSupport(s) {
  root.querySelector('#wbSupport').innerHTML = `
    <h2 class="wb-h2">If you need to talk to someone</h2>
    <p class="wb-emergency">${esc(s.emergency)}</p>
    <ul class="wb-contacts">
      ${s.contacts.map((c) => `
        <li>
          <span class="wb-c-name">${esc(c.name)}</span>
          <span class="wb-c-how">${esc(c.how)}</span>
          <span class="wb-c-when">${esc(c.when)} · ${esc(c.cost)}</span>
        </li>`).join('')}
    </ul>
    <p class="wb-hint wb-dim">Checked ${esc(s.checkedOn)} against nhs.uk and samaritans.org.
    These are here every time, whatever you have or have not written.</p>
  `;
}

async function save(mood) {
  const noteEl = root.querySelector('#wbNote');
  const echo = root.querySelector('#wbEcho');
  echo.textContent = 'saving…';
  echo.className = 'wb-echo';

  try {
    const r = await api('/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mood, note: noteEl.value }),
    });

    // Recall, not assessment. Both halves are facts already in the table.
    const bits = [];
    if (r.moodLabel) bits.push(`Logged “${r.moodLabel}”.`);
    else bits.push('Note saved.');
    bits.push(`That is ${r.recall.daysLoggedInLast14} of the last 14 days.`);
    if (r.recall.lastTimeYouLoggedThis) {
      const { daysAgo, date } = r.recall.lastTimeYouLoggedThis;
      bits.push(`Last time you logged this was ${daysAgo === 0 ? 'earlier today' : `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`} (${date}).`);
    } else if (r.moodLabel) {
      bits.push('First time you have logged this one.');
    }

    echo.textContent = bits.join(' ');
    echo.className = 'wb-echo ok';
    noteEl.value = '';
    await Promise.all([loadPatterns(), loadEntries()]);
  } catch (err) {
    echo.textContent = `Not saved: ${err.message}`;
    echo.className = 'wb-echo bad';
  }
}

async function loadPatterns() {
  const el = root.querySelector('#wbPatterns');
  let p;
  try { p = await api('/patterns'); } catch (err) {
    el.innerHTML = `<p class="wb-error">Could not read your entries: ${esc(err.message)}</p>`;
    return;
  }

  if (p.support) renderSupport(p.support);

  if (p.state === 'empty') {
    // "Nothing recorded" and "could not read" are different facts and read differently.
    el.innerHTML = `<p class="empty-hint">${esc(p.message)}</p>`;
    root.querySelector('#wbCount').textContent = 'nothing yet';
    return;
  }

  root.querySelector('#wbCount').textContent = `${p.total} entr${p.total === 1 ? 'y' : 'ies'}`;

  const maxMood = Math.max(...p.byMood.map((m) => m.count), 1);
  const maxDay = Math.max(...p.byWeekday.map((d) => d.daysLogged), 1);

  el.innerHTML = `
    <ul class="wb-facts">
      <li><b>${p.daysLoggedInLast7}</b> of the last 7 days</li>
      <li><b>${p.daysLoggedInLast14}</b> of the last 14 days</li>
      <li>Last entry <b>${p.daysSinceLastEntry === 0 ? 'today' : `${p.daysSinceLastEntry} day${p.daysSinceLastEntry === 1 ? '' : 's'} ago`}</b></li>
      <li><b>${p.entriesWithNotes}</b> of ${p.total} have a note</li>
      <li>First entry ${esc(p.firstEntry)}</li>
    </ul>

    ${p.byMood.length ? `
      <h3 class="wb-h3">How often you logged each</h3>
      <ul class="wb-bars">
        ${p.byMood.map((m) => `
          <li><span class="wb-bar-l">${esc(m.label)}</span>
              <span class="wb-bar-t"><span class="wb-bar-f" style="width:${(m.count / maxMood) * 100}%"></span></span>
              <span class="wb-bar-v">${m.count}</span></li>`).join('')}
      </ul>` : ''}

    <h3 class="wb-h3">Which days you tend to write</h3>
    <ul class="wb-bars">
      ${p.byWeekday.map((d) => `
        <li><span class="wb-bar-l">${esc(d.day.slice(0, 3))}</span>
            <span class="wb-bar-t"><span class="wb-bar-f" style="width:${(d.daysLogged / maxDay) * 100}%"></span></span>
            <span class="wb-bar-v">${d.daysLogged}</span></li>`).join('')}
    </ul>

    <p class="wb-hint wb-dim">${esc(p.note)}</p>
  `;
}

async function loadEntries() {
  const el = root.querySelector('#wbEntries');
  let d;
  try { d = await api('/entries?limit=30'); } catch (err) {
    el.innerHTML = `<p class="wb-error">Could not load entries: ${esc(err.message)}</p>`;
    return;
  }
  if (!d.entries.length) { el.innerHTML = '<p class="empty-hint">Nothing written yet.</p>'; return; }

  el.innerHTML = `<ul class="wb-entries">${d.entries.map((e) => `
    <li>
      <span class="wb-e-head">
        <span class="wb-e-date">${esc(e.date)}</span>
        ${e.moodLabel ? `<span class="wb-e-mood">${esc(e.moodLabel)}</span>` : ''}
        <button class="wb-del" data-id="${e.id}" title="Delete this entry">×</button>
      </span>
      ${e.note ? `<span class="wb-e-note">${esc(e.note)}</span>` : ''}
    </li>`).join('')}</ul>`;

  el.querySelectorAll('.wb-del').forEach((b) => {
    b.addEventListener('click', async () => {
      // Your own words, deleted immediately and without a confirmation dialogue arguing
      // with you about it.
      await api(`/entries/${b.dataset.id}`, { method: 'DELETE' }).catch(() => {});
      await Promise.all([loadPatterns(), loadEntries()]);
    });
  });
}

export default {
  mount(el) {
    root = el;
    el.innerHTML = TEMPLATE;

    // Draw the support card immediately from the server's fixed block, before any data
    // loads and regardless of whether it loads at all.
    api('/support').then(renderSupport).catch(() => {
      root.querySelector('#wbSupport').innerHTML =
        '<h2 class="wb-h2">If you need to talk to someone</h2>'
        + '<p class="wb-emergency">If life is in danger, call 999 or go to A&amp;E.</p>'
        + '<ul class="wb-contacts"><li><span class="wb-c-name">Samaritans</span>'
        + '<span class="wb-c-how">Call 116 123</span><span class="wb-c-when">24 hours, every day · Free</span></li>'
        + '<li><span class="wb-c-name">Shout</span><span class="wb-c-how">Text SHOUT to 85258</span>'
        + '<span class="wb-c-when">24 hours, every day · Free</span></li></ul>'
        + '<p class="wb-hint wb-dim">The server did not answer, so this is the built-in copy.</p>';
    });

    el.querySelectorAll('.wb-mood').forEach((b) => {
      b.addEventListener('click', () => save(Number(b.dataset.mood)));
    });
    el.querySelector('#wbSaveNote').addEventListener('click', () => save(null));

    // One keystroke, as the gate requires. Ignored while typing, so writing "felt like a
    // 3 today" in the note box does not silently log a 3.
    onKey = (ev) => {
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key >= '1' && ev.key <= '5') { ev.preventDefault(); save(Number(ev.key)); }
    };
    document.addEventListener('keydown', onKey);

    loadPatterns();
    loadEntries();
  },

  // Not optional: a document-level key handler left behind would keep logging moods from
  // any other panel.
  unmount() {
    if (onKey) document.removeEventListener('keydown', onKey);
    onKey = null;
    root = null;
  },
};
