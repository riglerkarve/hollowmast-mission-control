//
// respond.js — the owner's reply control, attached to any item on any panel.
//
// Owner instruction, 19 Aug 2026: "Allow me to respond to each item on the reports, bugs etc
// on the dashboard." His only reply channel was the steering card — one question a day, chosen
// by the manager. Everything else he read was read-only.
//
// ONE IMPLEMENTATION, USED BY BOTH PANELS. The board shows bugs and backlog items; the shift
// shows handovers, decisions and gaps. A reply box copied into each would be two controls
// posting to one table, drifting the week after — the same rule that put the real backlog
// panel inside Focus rather than a second rendering of it.
//
// It is deliberately NOT a comment thread. There is a verdict, a line of reasoning, and a
// record of whether anyone acted on it. A thread invites conversation the owner has no time
// for; this invites a decision, which is the thing only he can give.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const VERDICTS = [
  ['agree', 'Agree'],
  ['disagree', 'Disagree'],
  ['drop', 'Drop it'],
  ['later', 'Later'],
];

// Existing replies render above the box. A response the owner already gave, shown back to him
// with whether it was actioned, is what stops him repeating himself into a queue nobody works.
export function responsesHTML(list) {
  if (!list || !list.length) return '';
  return `<div class="rs-prev">${list.map((r) => `
    <div class="rs-prev-one${r.actioned_at ? ' rs-done' : ''}">
      <p class="rs-prev-head">
        ${r.verdict ? `<span class="rs-v rs-v-${esc(r.verdict)}">${esc(r.verdict)}</span>` : ''}
        <span class="rs-when">${esc(String(r.at).slice(5, 16).replace('T', ' '))}</span>
        ${r.actioned_at
    ? `<span class="rs-state">actioned by ${esc(r.actioned_by)}</span>`
    : '<span class="rs-state rs-open">not actioned yet</span>'}
      </p>
      <p class="rs-prev-body">${esc(r.response)}</p>
      ${r.action_note ? `<p class="rs-note">${esc(r.action_note)}</p>` : ''}
    </div>`).join('')}</div>`;
}

export function responderHTML(kind, ref, label, existing) {
  return `<div class="rs" data-kind="${esc(kind)}" data-ref="${esc(ref)}" data-label="${esc(label || '')}">
    ${responsesHTML(existing)}
    <button type="button" class="rs-open-btn">Respond${existing && existing.length ? ` (${existing.length})` : ''}</button>
    <div class="rs-form" hidden>
      <div class="rs-verdicts">
        ${VERDICTS.map(([v, l]) => `<button type="button" class="rs-vbtn" data-v="${v}">${l}</button>`).join('')}
      </div>
      <textarea class="rs-text" rows="3" placeholder="What should happen, and why. The reasoning is the part the team can apply next time."></textarea>
      <div class="rs-actions">
        <button type="button" class="rs-send">Send to the Team Manager</button>
        <span class="rs-msg"></span>
      </div>
    </div>
  </div>`;
}

// Delegated from one listener on the panel root, so a re-render cannot leave orphaned
// handlers behind and nothing has to be re-wired per item.
export function wireResponders(root, onSent) {
  if (!root || root.__rsWired) return;
  root.__rsWired = true;

  root.addEventListener('click', async (ev) => {
    const openBtn = ev.target.closest('.rs-open-btn');
    if (openBtn) {
      const form = openBtn.parentElement.querySelector('.rs-form');
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('.rs-text').focus();
      return;
    }

    const vb = ev.target.closest('.rs-vbtn');
    if (vb) {
      // A verdict is a toggle, not a radio that can get stuck: clicking the selected one
      // clears it, so there is no state he cannot get out of without reloading.
      const on = vb.classList.contains('on');
      vb.parentElement.querySelectorAll('.rs-vbtn').forEach((b) => b.classList.remove('on'));
      if (!on) vb.classList.add('on');
      return;
    }

    const send = ev.target.closest('.rs-send');
    if (!send) return;

    const box = send.closest('.rs');
    const form = send.closest('.rs-form');
    const text = form.querySelector('.rs-text');
    const msg = form.querySelector('.rs-msg');
    const chosen = form.querySelector('.rs-vbtn.on');
    if (!text.value.trim()) { msg.textContent = 'Say something first — a verdict alone tells the team what, not why.'; return; }

    send.disabled = true;
    msg.textContent = 'Sending…';
    try {
      const r = await fetch('/api/team/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mc-by': 'you' },
        body: JSON.stringify({
          kind: box.dataset.kind,
          ref: box.dataset.ref,
          label: box.dataset.label,
          response: text.value.trim(),
          verdict: chosen ? chosen.dataset.v : null,
        }),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.json().catch(() => ({}))).error || ''}`);
      // Reload from the server rather than patching the DOM optimistically: a reply that
      // shows as sent and was not is the one failure this control must not have.
      if (onSent) await onSent();
    } catch (e) {
      send.disabled = false;
      msg.textContent = `Not sent — ${e.message}. Nothing was recorded; try again.`;
    }
  });
}
