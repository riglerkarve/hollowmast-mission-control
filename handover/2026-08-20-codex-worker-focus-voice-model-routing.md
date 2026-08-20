# Handover — Focus transcript-to-model routing design

## Built

No source changes. The requested behaviour was traced against the existing Focus, voice, session and model contracts.

## Verified

- The Focus panel transcribes through `POST /api/voice/stt` and only displays the returned text.
- `server/ollama.js` is the approved model gateway. It exposes `ask()`; local `qwen3.5:4b` is the defined local default and the cloud tier must not receive sensitive payloads.
- `team_sessions` records roster/shift facts only. It is not a conversation transport, and Mission Control has no HTTP/API path to inject a message into the interactive Hermes CLI.
- The live Hermes process is currently configured to use `glm-5.2:cloud`; its log shows automatic background work, so it is not an appropriate silent destination for Focus transcripts.

## Blocked

- `public/panels/focus/focus.js`, `focus.css`, `server/index.js`, `server/ollama.js` and `server/routes/voice.js` are concurrently dirty. The required browser and route changes overlap those paths.
- A literal "everything" rule cannot bypass the workspace custody boundary: transcripts containing finance or wellbeing content must not be sent to a general model path.

## Candidate implementation once the active editor releases the paths

Create one persistent **local Focus conversation** owned by the existing voice route:

1. After STT succeeds, append the speaker turn to a Focus-owned conversation log and call `server/ollama.js` with the local `qwen3.5:4b` model only.
2. Return the answer to the Focus panel, render it as a model response and route it through the existing talk-back control only when enabled.
3. Preserve an explicit unavailable/refused state: no Ollama response is never displayed as a reply, and sensitive content is refused before model dispatch.
4. Record model/timing provenance; do not call this a Hermes session and do not inject terminal input.

This is a new persistent interaction feature, not a timer-session record. It needs its own schema ownership decision before implementation; it must not overload `focus_sessions`, whose purpose is time allocation.
