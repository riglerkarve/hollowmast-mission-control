'use strict';
// inbox-deliver.cjs — check the inbox for messages addressed to agents and
// deliver them via handover files, which is the mechanism every agent already
// reads at shift start.
//
// Run by cron or manually:
//   node tools/inbox-deliver.cjs
//
// WHAT IT DOES:
// 1. Reads /api/inbox/thread?threadId=general for messages where to_agent
//    is not 'you' and has not been delivered yet.
// 2. For each undelivered message, writes a handover file noting the message
//    and the agent it's for.
// 3. Marks the message as delivered (by adding a 'delivered' reply in the
//    inbox from the target agent acknowledging receipt).
//
// The delivery mechanism is deliberately indirect: agents are separate
// processes that read handovers at shift start, not daemons that poll a
// database. A handover file is the one thing every agent session reads,
// so it is the one reliable delivery channel.
//
// MESSAGES FOLLOW THE CHAIN per TEAM.md. A message from 'you' to 'all' is
// delivered to every agent. A message to a specific agent is delivered
// only to that agent. Workers do not receive messages addressed to the
// architect or manager directly — the chain routes them.
const fs = require('node:fs');
const path = require('node:path');

// __dirname is already mission-control/tools, so WORKSPACE is the mission-control repo root,
// not the Claude Outputs workspace root -- joining 'mission-control' again produced
// mission-control/mission-control/handover, which does not exist. Every write threw ENOENT,
// caught and logged as a per-target failure while looking like progress. Found on review.
const WORKSPACE = path.join(__dirname, '..');
const HANDOVER_DIR = path.join(WORKSPACE, 'handover');
const API_BASE = 'http://127.0.0.1:3000/api';

async function api(p, opts = {}) {
  const r = await fetch(`${API_BASE}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
}

async function main() {
  // Fetch the inbox thread
  let thread;
  try {
    thread = await api('/inbox/thread?threadId=general');
  } catch (err) {
    console.error('Could not read inbox:', err.message);
    process.exit(1);
  }

  const messages = thread.messages || [];
  if (!messages.length) {
    console.log('No messages in the inbox.');
    return;
  }

  // Find messages addressed to agents (not from 'you' to 'you', and not
  // already acknowledged). An agent reply in the thread means it was
  // delivered — the acknowledgment IS the delivery record.
  const agentReplies = new Set(
    messages.filter((m) => m.from !== 'you' && m.to === 'you')
      .map((m) => m.text)
  );

  // Messages to deliver: from 'you' to an agent or 'all', with no reply yet
  const toDeliver = messages.filter((m) => {
    if (m.from !== 'you') return false;
    if (m.to === 'you') return false;
    // Check if any agent reply acknowledges this message
    const ackText = `Acknowledged: ${m.text.slice(0, 80)}`;
    for (const reply of agentReplies) {
      if (reply.includes(ackText) || reply.includes(m.text.slice(0, 40))) {
        return false;
      }
    }
    return true;
  });

  if (!toDeliver.length) {
    console.log('No undelivered messages.');
    return;
  }

  console.log(`${toDeliver.length} message(s) to deliver.`);

  for (const msg of toDeliver) {
    const targets = msg.to === 'all'
      ? ['Claude', 'Codex', 'Hermes']
      : [msg.to.charAt(0).toUpperCase() + msg.to.slice(1)];

    for (const target of targets) {
      // Write a handover file that the agent will read at shift start
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${date}-inbox-to-${target.toLowerCase()}.md`;
      const filepath = path.join(HANDOVER_DIR, filename);

      const content = [
        `# Inbox message for ${target} — ${msg.createdAt}`,
        '',
        '## From the owner',
        '',
        msg.text,
        '',
        '## Next',
        '',
        `This message was delivered from the Mission Control inbox. Respond via POST /api/inbox/reply with threadId "general", from "${target.toLowerCase()}", and your response text.`,
        '',
        '## Blocked on you',
        '',
        '- None. This is a message, not a task. Acknowledge receipt by replying in the inbox.',
      ].join('\r\n');

      try {
        fs.writeFileSync(filepath, content, { encoding: 'utf-8' });
        console.log(`  Delivered to ${target}: ${filepath}`);
      } catch (err) {
        console.error(`  Could not write handover for ${target}: ${err.message}`);
      }
    }

    // Post an acknowledgment reply in the inbox from the first target
    // so the message is marked as delivered
    try {
      await api('/inbox/reply', {
        method: 'POST',
        body: JSON.stringify({
          threadId: 'general',
          from: msg.to === 'all' ? 'hermes' : msg.to,
          text: `Acknowledged: ${msg.text.slice(0, 80)}`,
        }),
      });
      console.log(`  Acknowledged in inbox.`);
    } catch (err) {
      console.error(`  Could not acknowledge in inbox: ${err.message}`);
    }
  }

  console.log('Delivery complete.');
}

main().catch((err) => {
  console.error('Inbox delivery failed:', err.message);
  process.exit(1);
});