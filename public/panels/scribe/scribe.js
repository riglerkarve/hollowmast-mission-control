//
// scribe — the Scribe's proposal review queue.
//
// The Scribe (local model tier) can propose changes to wellbeing and other
// modules, but those proposals have NO EFFECT until the owner reviews them.
// This panel is the review surface — the one place where a pending proposal
// can be approved (enacted) or rejected, and where past decisions are visible.
//
// NOTHING HERE DERIVES ANYTHING. The proposal list comes from
// GET /api/team/scribe/proposals, and the review action goes through
// POST /api/team/scribe/proposals/:id/review. The route enforces staleness
// checks and wellbeing-owner-review rules; this panel is the UI on top.
//
// WELLBEING PROPOSALS: The API requires reviewed_by="you" for wellbeing
// proposals — the owner reviews his own health data, not a session. The
// panel sends "you" automatically for wellbeing proposals and disables the
// reviewer name field. For non-wellbeing proposals, the reviewer name is
// editable. This matches the route's enforcement at team.js:1501.
//
// CSS NOTE: This panel's stylesheet uses only existing shell.css tokens.
// Codex owns all Mission Control CSS (AGENTS.md §4b); this file should be
// reviewed by Codex when it is next active.
import { renderLede } from '/panels/lede/lede.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const prose = (s) => esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');

const day = (s) => String(s || '').slice(0, 10);
const time = (s) => String(s || '').slice(11, 16);

let root = null;
let state = null;

// ---- content check rendering ------------------------------------------------

function contentCheckHTML(cc) {
  if (!cc) return '';
  const flags = cc.flags && cc.flags.length
    ? `<span class="sc-flags">flagged: ${cc.flags.map(esc).join(', ')}</span>`
    : '<span class="sc-flags-none">no flagged words</span>';
  const why = cc.why ? `<p class="sc-why">${esc(cc.why)}</p>` : '';
  const notKeyed = cc.not_keyed && cc.not_keyed.length
    ? `<p class="sc-blind">Not keyed on: ${cc.not_keyed.map(esc).join('; ')}.</p>`
    : '';
  return `<div class="sc-check${cc.blocked ? ' sc-blocked' : ''}">
    <h5>Content check (wellbeing)</h5>
    ${flags}
    ${why}
    ${notKeyed}
  </div>`;
}

// ---- proposal card ----------------------------------------------------------

function diffHTML(p) {
  const cur = p.current_value != null ? String(p.current_value) : null;
  const val = p.proposed_value != null ? String(p.proposed_value) : null;

  // If target_table and target_id are null, this is a proposed new row, not a field edit.
  if (!p.target_table || !p.target_id) {
    return `<div class="sc-diff">
      <h5>Proposed value</h5>
      <p class="sc-proposed">${prose(p.proposed_value)}</p>
    </div>`;
  }

  return `<div class="sc-diff">
    <h5>Current</h5>
    <p class="sc-current${cur == null ? ' sc-null' : ''}">${cur == null ? '(empty)' : prose(cur)}</p>
    <h5>Proposed</h5>
    <p class="sc-proposed">${val == null ? '(empty)' : prose(val)}</p>
  </div>`;
}

function metaHTML(p) {
  const parts = [];
  parts.push(`<span class="sc-module">${esc(p.module)}</span>`);
  if (p.job) parts.push(`<span class="sc-job">${esc(p.job)}</span>`);
  if (p.model) parts.push(`<span class="sc-model">${esc(p.model)}</span>`);
  if (p.field) parts.push(`<span class="sc-field">field: ${esc(p.field)}</span>`);
  if (p.target_table && p.target_id) parts.push(`<span class="sc-target">${esc(p.target_table)}#${esc(p.target_id)}</span>`);
  return `<p class="sc-meta">${parts.join(' ')}</p>`;
}

function reviewInfoHTML(p) {
  if (p.status === 'pending') return '';
  const parts = [];
  parts.push(`<span class="sc-status sc-status-${esc(p.status)}">${esc(p.status)}</span>`);
  if (p.reviewed_by) parts.push(`<span class="sc-by">by ${esc(p.reviewed_by)}</span>`);
  if (p.reviewed_at) parts.push(`<span class="sc-when">${esc(day(p.reviewed_at))} ${esc(time(p.reviewed_at))}</span>`);
  if (p.review_note) parts.push(`<span class="sc-note">${esc(p.review_note)}</span>`);
  return `<p class="sc-review">${parts.join(' ')}</p>`;
}

function actionsHTML(p) {
  if (p.status !== 'pending') return '';
  const isWellbeing = p.module === 'wellbeing';
  const reviewerValue = isWellbeing ? 'you' : '';
  const reviewerDisabled = isWellbeing ? 'disabled' : '';
  const wellbeingNote = isWellbeing
    ? '<p class="sc-wb-note">Wellbeing is reviewed by the owner. reviewed_by is locked to "you".</p>'
    : '';
  return `<div class="sc-actions" data-id="${p.id}" data-module="${esc(p.module)}">
    ${wellbeingNote}
    <input class="sc-reviewer" type="text" placeholder="reviewed by" value="${reviewerValue}" ${reviewerDisabled}>
    <button class="sc-approve" data-id="${p.id}">Approve</button>
    <button class="sc-reject" data-id="${p.id}">Reject</button>
    <input class="sc-note-input" type="text" placeholder="note (optional)">
  </div>`;
}

function cardHTML(p) {
  const cc = p.module === 'wellbeing' ? contentCheckHTML(p.content_check) : '';
  return `<article class="sc-card sc-status-${esc(p.status)}">
    ${metaHTML(p)}
    ${diffHTML(p)}
    ${cc}
    ${reviewInfoHTML(p)}
    ${actionsHTML(p)}
  </article>`;
}

// ---- render -----------------------------------------------------------------

function render() {
  if (!root || !state) return;

  if (state.error) {
    root.innerHTML = `<section class="panel sc-panel">
      <h1>Scribe proposals</h1>
      <p class="sc-alarm">Could not read proposals — ${esc(state.error)}.
      That is a failure to look, not an empty queue.</p>
    </section>`;
    return;
  }

  if (!state.data) {
    root.innerHTML = `<section class="panel sc-panel"><h1>Scribe proposals</h1>
      <p class="sc-loading">Reading the queue…</p></section>`;
    return;
  }

  const pending = state.data.pending || [];
  const reviewed = state.data.reviewed || [];

  const pendingHTML = pending.length
    ? pending.map(cardHTML).join('')
    : '<p class="sc-empty">No pending proposals. The Scribe has nothing awaiting review.</p>';

  const reviewedHTML = reviewed.length
    ? reviewed.map(cardHTML).join('')
    : '<p class="sc-empty">No reviewed proposals yet.</p>';

  root.innerHTML = `<section class="panel sc-panel">
    <h1>Scribe proposals</h1>
    <p class="sc-lede">Proposals from the Scribe (local model) that need review before they take
      effect. Approving enacts the change; rejecting discards it. Wellbeing proposals are
      reviewed by the owner — reviewed_by is locked to "you" for those.</p>

    <h2 class="sc-h2">Pending <span class="sc-n">${pending.length}</span></h2>
    ${pendingHTML}

    <h2 class="sc-h2">Reviewed <span class="sc-n">${reviewed.length}</span></h2>
    ${reviewedHTML}
  </section>`;

  wireActions();
}

// ---- actions ----------------------------------------------------------------

async function submitReview(id, decision, reviewer, note) {
  try {
    const r = await fetch(`/api/team/scribe/proposals/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mc-by': 'you' },
      body: JSON.stringify({ decision, reviewed_by: reviewer, note: note || null }),
    });
    const data = await r.json();
    if (!r.ok) {
      alert(`Review failed: ${data.error || r.status}\n${data.why || ''}`);
    }
  } catch (e) {
    alert(`Review failed: ${e.message}`);
  }
  await load();
}

function wireActions() {
  if (!root) return;
  root.querySelectorAll('.sc-actions').forEach((div) => {
    const id = div.dataset.id;
    const isWellbeing = div.dataset.module === 'wellbeing';
    const approveBtn = div.querySelector('.sc-approve');
    const rejectBtn = div.querySelector('.sc-reject');
    const reviewerInput = div.querySelector('.sc-reviewer');
    const noteInput = div.querySelector('.sc-note-input');

    if (approveBtn) approveBtn.addEventListener('click', async () => {
      const reviewer = isWellbeing ? 'you' : (reviewerInput.value || '').trim();
      if (!reviewer) { alert('reviewed_by is required'); return; }
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      await submitReview(id, 'approve', reviewer, noteInput.value);
    });

    if (rejectBtn) rejectBtn.addEventListener('click', async () => {
      const reviewer = isWellbeing ? 'you' : (reviewerInput.value || '').trim();
      if (!reviewer) { alert('reviewed_by is required'); return; }
      rejectBtn.disabled = true;
      approveBtn.disabled = true;
      await submitReview(id, 'reject', reviewer, noteInput.value);
    });
  });
}

// ---- load -------------------------------------------------------------------

async function load() {
  try {
    const [pendingRes, enactedRes, rejectedRes, staleRes] = await Promise.all([
      fetch('/api/team/scribe/proposals?status=pending', { headers: { 'x-mc-by': 'you' } }),
      fetch('/api/team/scribe/proposals?status=enacted', { headers: { 'x-mc-by': 'you' } }),
      fetch('/api/team/scribe/proposals?status=rejected', { headers: { 'x-mc-by': 'you' } }),
      fetch('/api/team/scribe/proposals?status=stale', { headers: { 'x-mc-by': 'you' } }),
    ]);

    const [pending, enacted, rejected, stale] = await Promise.all([
      pendingRes.json(), enactedRes.json(), rejectedRes.json(), staleRes.json(),
    ]);

    // Merge reviewed proposals, newest first by created_at
    const reviewed = [
      ...(enacted.proposals || []),
      ...(rejected.proposals || []),
      ...(stale.proposals || []),
    ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    state.data = { pending: pending.proposals || [], reviewed };
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
    renderLede('scribe', el);
  },
  unmount() { root = null; state = null; },
};