# Hermes Agent — three new features

## Built

- **Smart prioritization** (GET /api/prioritize) — ranks every open board
  item by a transparent score: P1 +40, P2 +25, P3 +10, owner-YOU +15,
  +1/day stale (max 30), bug +10, question +5. The score and reason are
  visible in the response. Voice shortcuts: "today" "priorities" "next".
  Top item: M67 (PayPal credits, P1, 30 days stale, score 90).

- **Voice quick-actions** — one-tap buttons on the voice panel (desktop)
  and mobile shell. Six buttons: Briefing, Today, Stuck, Who's working,
  Start focus, Inbox. Each sends its command to the voice command route
  and executes the result. No speaking required — tap and it acts.

- **Focus mode (Zen)** — strip the dashboard to briefing only. Activated
  by #zen in the URL or keyboard shortcut Z then E. Hides the sidebar,
  full-width content, shows the briefing. The "I want to think" view.

## Verified

- /api/prioritize: 69 open items, top score=90, reason visible
- Voice shortcut "today" -> /api/prioritize
- shell.js has toggleZen (3 references)
- Mobile has 8 m-qa references (5 buttons + handler + CSS)
- Voice panel has 8 vc-qa references (6 buttons + handler + CSS)
- Server restarted, PID changed, /api/status 200

## Deviations

- None.

## Blocked on you

- None.

## Next

- Continue adding features as directed.