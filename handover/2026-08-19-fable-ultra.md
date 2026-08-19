# Handover - Fable Ultra (architect session, Mini Games), 19 Aug 2026

Scope this shift: one owner request, "Create fun mini game", taken directly (architect channel).
Repo: `Claude Outputs/Mini Games` (its own .git, separate from the shared HOLLOWMAST tree).

## Built

- **PEAL** - `Mini Games/peal.html`, a one-tap bell-ringing timing game. Tap to check a swinging
  church bell at the very top of its swing; later is worth more (GOOD 145-165 deg, GREAT 165-175,
  PERFECT 175-180, +200 on the stay 177+); a hair past 180 and it goes over - the only death.
  Single file, canvas 2D, WebAudio-synthesised bronze bell (5 inharmonic partials + clapper),
  localStorage best, touch + mouse + keyboard, portrait-first with a landscape HUD layout.
  Difficulty ramps by stroke count (T_rise 1.4 tutorial -> 1.10, x0.94 every 6 strokes, floor 0.55);
  every 4th stroke from 24 is HEAVY and telegraphed. Combo x1..x10, PEAL mode every 8 consecutive
  GREAT+. Commits `3beed35` (game + README row), `819636e` (published artifact link). Tree clean.
- Published as a Claude artifact: https://claude.ai/code/artifact/911d3a40-0324-4c4f-988e-b01c5e18978b
- Concept came from a 4-designer panel (timing / physics toy / spatial / British-everyday lenses)
  judged by a creative-director agent; PEAL won on "fun lives in the input, not in physics tuning".
- Memories written: `mini-games-peal` (knobs, what is untested) and `headless-canvas-verification`
  (how to verify a canvas game when the Browser pane does not composite).

## Verified

- Headless end-to-end: with rAF not ticking, drove `step()`/`draw()` by hand through the real
  `pull()` path - 31 auto-strokes at 170 deg scored 17,750 at combo 31 (x10, PEAL doubling), HEAVY
  telegraph fired on stroke 32, untouched rise died at 180 and the over panel populated correctly
  (score / NEW BEST / strokes / combo / "You never pulled").
- Rendering: a 5-cell contact sheet of real frames (title, mid-rise, PERFECT with bloom and +100,
  HEAVY callout, death whip with splinters). After the arc fix, pixel-sampled the rim: three gold
  brightness steps at 150/170/178 deg, red danger arc at 190, plain wood at 40/90, red stay peg.
- Review workflow: 4 lenses (logic, feel, platform, WebAudio) then one skeptical verifier per
  finding with instructions to refute. 9 findings confirmed, 0 refuted, all 9 fixed plus five
  unfiled hardening notes (mute-button focus, non-primary mouse buttons, share fallback, reduced
  motion on canvas shake, AudioContext `interrupted` state). Audio lens found nothing to file.
- NOT verified: no human has played it, on any device. See Risks.

## Deviations

- From the design brief: GOOD *holds* the combo rather than breaking it (brief said combo =
  consecutive GREAT+ only). Reason: most players would never see x2 otherwise; PEAL trigger and
  multiplier thresholds kept.
- Stay window widened 179 -> 177 deg after the feel reviewer computed 179-180 as 4-11 ms, below
  human timing; the tip copy now says it is three degrees from over.
- Added a rest phase: the bell waits mouth-down for a "pull off" tap, so the START tap does not
  also start the first stroke (the reviewer's double-tap-on-START scenario).
- Added a 25 ms grace frame on frame-detected death: a tap whose hardware timestamp precedes the
  crossing (touch delivery lags rAF) is honoured against the true crossing time; "1 ms late" is no
  longer fabricated, the panel says "Your pull landed just as it went over" when lateMs <= 0.
- Abandoned full-resolution image verification after the fix: re-emitting ~9.5 KB+ of base64 by
  hand dropped bytes twice (checksum caught both). Switched to pixel sampling. The three earlier
  chunks that did verify were the ones copied immediately after receipt.
- Workspace file says HOLLOWMAST is the only game being built; Mini Games' own file documents
  "adding a game" as one file / one row / one commit, and the owner asked directly. Stated the
  conflict in the first line of the reply and proceeded; PEAL is parked, not in any rotation.

## Risks

- **Unplayed on a phone.** Touch latency, the bell synth volume/clipping, and the landscape HUD
  (CSS `@media (orientation: landscape)` moves the HUD left) are code-reviewed only. If PERFECT
  feels unreachable, `EASE_K` 2.6 -> 3.0 at the top of the script widens every window without
  changing the rhythm; `T_RISE_START`/`RAMP` and the `TIER` boundaries are the other knobs.
- The artifact is public-shareable and was published before a human playtest.
- Learned, and it is the supervisor's sentence exactly: the check I ran myself was the one I
  misread. The event-timestamp tap mapping was the feature I was proudest of, and the logic
  reviewer showed the clamp to [0, 50ms] threw away the one case it existed for (a touch stamped
  before the last rAF). The headless harness confirmed my design was *consistent*; it could not
  tell me it was *wrong*, because it shared the assumption. Separately: my visual check of a
  hand-copied base64 blob "looked right" twice and was wrong twice - only the checksum disagreed.

## Next

- A `tools/peal-harness.cjs` on the SHUNT pattern (vm + stubbed browser + the three arms: passive /
  on-rhythm / reads-the-arc) so the feel numbers (windows 275/216/169/108 ms, PERFECT 52/41/32/20)
  are measured out of the shipped file rather than computed from the constants.
- Phone playtest, then tune EASE_K if needed. One commit, one README touch, no new mechanics.
- Nothing in flight. No staged files in `Mini Games` or `mission-control` from this session.

## Blocked on you

- Nothing blocking. One steering question, low priority: should Mini Games additions stay
  "owner-request only"? Three small games now sit on that shelf (GIVE WAY, PEAL, SHUNT) while the
  kill criterion reads "a fourth game starts before HOLLOWMAST ships". I read mini games as parked
  adjacent content, not a build in rotation - confirm or correct, no action needed either way.
