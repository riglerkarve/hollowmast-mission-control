//
// alerts — alert kinds (standing, counts, mute) and recent events (verdicts).
//
// TWO SECTIONS, TWO FETCHES.
//   'Kinds' — one card per alert kind: label, kind, standing (muted / never
//   judged / on probation / earning its place), counts (total, sent,
//   suppressed, ignored, useful, unjudged), last fired date. Muted kinds show
//   an unmute button. A kind whose standing is 'should be muted' is
//   highlighted so it cannot be missed.
//   'Recent events' — the last alert events, newest first, with title, body,
//   kind, sent_at, and verdict. Each unjudged event has 'Useful' and 'Ignore'
//   buttons that POST the verdict. Already-judged events show their verdict
//   as a badge.
//
// NOTHING HERE DERIVES ANYTHING. The standing and counts come from the route.
// A panel that recomputed "should this be muted" would agree with the route
// until one was edited, and then disagree without either erroring — the exact
// failure this project keeps meeting.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Alert body prose is escaped, not parsed. A half-implemented markdown renderer
// that swallows a `**` is worse than plain text, because it silently changes
// what was recorded.
const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

const day = (s) => String(s || '').slice(0, 10);
const time = (s) => String(s || '').slice(11, 16);

let root = null;
let state = null;
let busy = null;  // event ids being judged, to disable double-submit

// Standing labels map the route's standing strings to human phrases. The
// route owns the vocabulary; the panel only renders it.
function standingLabel(k) {
  switch (k.standing) {
    case 'muted':              return 'muted';
    case 'never judged':       return 'never judged';
    case 'on probation':       return 'on probation';
    case 'earning its place':  return 'earning its place';
    case 'should be muted':    return 'should be muted';
    default:                   return esc(k.standing || '—');
  }
}

function standingClass(k) {
  switch (k.standing) {
    case 'muted':             return ' al-std-muted';
    case 'should be muted':   return ' al-std-mute-warn';
    case 'on probation':     return ' al-std-probation';
    case 'earning its place': return ' al-std-earning';
    default:                  return '';
  }
}

function kindCardHTML(k) {
  const muted = k.muted;
  const standingCls = standingClass(k);
  const unmute = muted
    ? `<button class="al-unmute" data-kind="${esc(k.kind)}">Unmute</button>`
    : '';
  const last = k.last
    ? `<span class="al-last">last fired ${esc(day(k.last))} ${esc(time(k.last))}</span>`
    : '<span class="al-last">never fired</span>';

  const counts = [
    ['total', k.total],
    ['sent', k.sent],
    ['suppressed', k.suppressed],
    ['ignored', k.ignored],
    ['useful', k.useful],
    ['unjudged', k.unjudged],
  ].map(([label, n]) =>
    `<span class="al-count"><span class="al-count-n">${esc(n == null ? 0 : n)}</span><span class="al-count-l">${esc(label)}</span></span>`
  ).join('');

  const mutedNote = muted
    ? `<p class="al-muted-note">Muted ${esc(day(k.mutedAt) || '?')} — ${esc(k.mutedReason || 'auto-muted after 2 ignores')}</p>`
    : '';

  const ignoresToMute = (k.ignoresToMute != null && k.ignoresToMute > 0)
    ? `<span class="al-to-mute">${esc(k.ignoresToMute)} more ignore${k.ignoresToMute === 1 ? '' : 's'} to mute</span>`
    : '';

  return `<article class="al-kind${standingCls}">
    <div class="al-kind-head">
      <h3 class="al-kind-label">${esc(k.label || k.kind)}</h3>
      <span class="al-kind-key">${esc(k.kind)}</span>
      ${unmute}
    </div>
    <div class="al-kind-meta">
      <span class="al-standing${standingCls}">${esc(standingLabel(k))}</span>
      ${last}
      ${ignoresToMute}
    </div>
    <div class="al-counts">${counts}</div>
    ${mutedNote}
  </article>`;
}

function verdictBadgeHTML(ev) {
  if (!ev.verdict) return '';
  const cls = ev.verdict === 'useful' ? ' al-v-useful' : ' al-v-ignored';
  return `<span class="al-verdict-badge${cls}">${esc(ev.verdict)}</span>`;
}

function eventVerdictButtonsHTML(ev) {
  if (ev.verdict) return '';
  const disabled = busy && busy.has(ev.id) ? ' disabled' : '';
  return `<div class="al-vote">
    <button class="al-btn al-btn-useful" data-event="${esc(ev.id)}" data-verdict="useful"${disabled}>Useful</button>
    <button class="al-btn al-btn-ignore" data-event="${esc(ev.id)}" data-verdict="ignored"${disabled}>Ignore</button>
  </div>`;
}

// M337 / decision #47 — THE PROPOSAL, SHOWN WITH ITS EVIDENCE.
//
// A session derives a verdict from observable state and offers it; he accepts or rejects.
// The reasoning renders beside it deliberately: a proposed verdict he cannot check is one
// he has to take on trust, and the whole reason this module was converted rather than cut
// is that HE is the one who knows whether an alert helped.
//
// NEVER PRE-SELECTED AND NEVER APPLIED. The buttons below are unchanged; the proposal only
// says which one a session would press, and why. An unproposed event shows nothing here
// rather than an empty proposal — three of five kinds cannot be derived at all, and a
// blank where a proposal would go must not read as "no opinion, probably ignore".
function proposalHTML(ev) {
  if (ev.verdict || !ev.proposed_verdict) return '';
  const cls = ev.proposed_verdict === 'useful' ? ' al-p-useful' : ' al-p-ignored';
  return `<div class="al-proposal">
    <span class="al-proposal-tag${cls}">proposed: ${esc(ev.proposed_verdict)}</span>
    <span class="al-proposal-why">${esc(ev.proposed_because || '')}</span>
  </div>`;
}

function eventHTML(ev) {
  const sentAt = ev.sent_at
    ? `<span class="al-ev-when">${esc(day(ev.sent_at))} ${esc(time(ev.sent_at))}</span>`
    : '<span class="al-ev-when">—</span>';
  const body = ev.body ? `<p class="al-ev-body">${prose(ev.body)}</p>` : '';
  return `<article class="al-ev">
    <div class="al-ev-head">
      <span class="al-ev-kind">${esc(ev.kind)}</span>
      ${sentAt}
      ${verdictBadgeHTML(ev)}
    </div>
    <h4 class="al-ev-title">${esc(ev.title || '(no title)')}</h4>
    ${body}
    ${proposalHTML(ev)}
    ${eventVerdictButtonsHTML(ev)}
  </article>`;
}

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel al-panel">
      <h1>Alerts</h1>
      <p class="al-alarm">Could not read alerts — ${esc(state.error)}.
      That is a failure to look, not an empty ledger.</p>
    </section>`;
    return;
  }

  if (!state.kinds && !state.events) {
    root.innerHTML = `<section class="panel al-panel"><h1>Alerts</h1>
      <p class="al-loading">Reading alerts…</p></section>`;
    return;
  }

  const kinds = state.kinds || { state: 'none-sent', total: 0, rule: '', kinds: [] };
  const events = state.events || { total: 0, events: [] };

  // Empty state: the ledger is real but no alerts have ever been sent. This is
  // NOT an error — it is a working system that has had nothing to say. Render
  // it as a calm note, distinct from the alarm above.
  if (kinds.state === 'none-sent') {
    root.innerHTML = `<section class="panel al-panel">
      <h1>Alerts</h1>
      <p class="al-lede">Alert rules, their standing, and the events they have sent. A rule that
        fires without anyone judging whether it was useful is noise that looks like signal.</p>
      <p class="al-empty">No alerts have been sent yet. The ledger is empty, not broken — the rules
        are watching but have had nothing to say.</p>
    </section>`;
    return;
  }

  const kindsHTML = (kinds.kinds || []).length
    ? (kinds.kinds || []).map(kindCardHTML).join('')
    : '<p class="al-empty">No alert kinds registered yet.</p>';

  const eventsHTML = (events.events || []).length
    ? (events.events || []).map(eventHTML).join('')
    : '<p class="al-empty">No recent events. Alerts that have not fired are not failures — they are quiet.</p>';

  root.innerHTML = `<section class="panel al-panel">
    <h1>Alerts</h1>
    <p class="al-lede">Alert rules, their standing, and the events they have sent. A rule that
      fires without anyone judging whether it was useful is noise that looks like signal.</p>

    <h2 class="al-h2">Kinds <span class="al-n">${esc((kinds.kinds || []).length)}</span></h2>
    <p class="al-asof">Rule: <span class="al-mono">${esc(kinds.rule || '—')}</span>. ${esc(kinds.total || 0)} total alerts sent.</p>
    ${kindsHTML}

    <h2 class="al-h2">Recent events <span class="al-n">${esc(events.total || 0)}</span></h2>
    ${eventsHTML}
  </section>`;

  bindActions();
}

function bindActions() {
  if (!root) return;

  // Unmute buttons
  root.querySelectorAll('.al-unmute').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.kind;
      btn.disabled = true;
      try {
        await fetch(`/api/alerts/kinds/${encodeURIComponent(kind)}/unmute`, { method: 'POST' });
        await load();
      } catch (e) {
        btn.disabled = false;
      }
    });
  });

  // Verdict buttons
  root.querySelectorAll('.al-btn[data-event]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.event;
      const verdict = btn.dataset.verdict;
      if (!id || !verdict) return;
      if (busy && busy.has(id)) return;
      if (!busy) busy = new Set();
      busy.add(id);
      // Disable both buttons for this event immediately
      root.querySelectorAll(`.al-btn[data-event="${CSS.escape(id)}"]`).forEach((b) => { b.disabled = true; });
      try {
        await fetch(`/api/alerts/events/${encodeURIComponent(id)}/verdict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verdict }),
        });
        await load();
      } catch (e) {
        // Re-enable on failure
        root.querySelectorAll(`.al-btn[data-event="${CSS.escape(id)}"]`).forEach((b) => { b.disabled = false; });
      } finally {
        busy.delete(id);
      }
    });
  });
}

async function load() {
  try {
    const [kindsRes, eventsRes] = await Promise.all([
      fetch('/api/alerts'),
      fetch('/api/alerts/events?limit=50'),
    ]);
    if (!kindsRes.ok) throw new Error(`alerts ${kindsRes.status}`);
    if (!eventsRes.ok) throw new Error(`events ${eventsRes.status}`);
    state.kinds = await kindsRes.json();
    state.events = await eventsRes.json();
    state.error = null;
  } catch (e) {
    state.error = e.message;
    state.kinds = null;
    state.events = null;
  }
  render();
}

export default {
  mount(el, opts) {
    root = el;
    state = { kinds: null, events: null, error: null };
    busy = null;
    render();
    load();
    renderLede('alerts', el);
  },
  unmount() { root = null; state = null; busy = null; },
};
