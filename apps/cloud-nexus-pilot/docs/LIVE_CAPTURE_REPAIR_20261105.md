# Live microphone prompt echo and guidance repair — 2026-11-05

The user’s real microphone test captured “What is Kubernetes?” but then repeatedly transcribed the application’s internal prose hint. The valid question’s guidance was cancelled as unrelated chunks changed the preferred-question state. The earlier generated-speech acceptance had tested one isolated clip and did not exercise this sequence.

## Changes

- Removed the descriptive transcription prompt. The provider receives audio and transcription settings without the application’s marketing/context text.
- Automatic PCM flushing now respects the minimum frame count; a timer cannot send a tiny remainder immediately after a full chunk. Pause and Stop still preserve the final remainder.
- Fully validated digital-silence WAV chunks complete through the existing authenticated reservation/replay path without calling a provider, consuming provider units, or inserting a transcript row. Nonzero quiet audio and antiphase stereo still reach transcription; no arbitrary energy threshold discards quiet speech.
- Empty provider responses no longer insert blank transcript rows. They still incur the normal usage when a provider was contacted.
- A complete question survives unrelated transcript chunks. Split prompts can rejoin, and punctuation/case changes do not cancel or repeat an answer. A genuinely new completed question can replace the active question. Explicit typed coaching keeps priority.
- Question correction uses the configured guidance model and falls back to the newest extracted question if the provider fails, rather than treating the whole transcript window as a question.

## Validation scope

Focused offline regressions cover prompt-free transcription, provider-error fallbacks, silence/replay/accounting, malformed WAV containers, quiet nonzero samples, antiphase stereo, split/new questions, stable guidance selection, and PCM timer/Pause/Stop behavior. The bounded live acceptance now includes one generated spoken question, two silent chunks and a replay, one answer, saved transcript/answer association, and export.

The exact-zero silence gate deliberately does not classify room noise. The browser’s physical microphone capture was demonstrated by the user’s screenshot, but the repaired microphone-to-answer flow still needs a fresh user recording after reload. This is an isolated local acceptance build; it does not establish production readiness, original-session recovery, or shared-tab capture.

No old transcript was deleted or rewritten. No new API key or billing change was required.

## Verified results

- Full application suite: 247/247 passed. Live-profile suite: 9/9 passed. Lint and production frontend/realtime build passed.
- At 06:31:54 UTC, the live generated-speech test passed with one transcription, two silent chunks plus one replay, and one saved guidance answer. Silent requests consumed zero local provider units and inserted no transcript rows. The ended session export contained exactly the one spoken question and its answer. Synthetic provider dispatch delta was zero; reserved usage returned to zero.
- Reloaded the rebuilt Chrome workspace, found the ended acceptance session through the saved-session picker, and visibly recovered the Kubernetes question and relevant answer. No microphone was started by automation.
- Evidence: `review/live-capture-repair/validation.json`, `live-speech-silence-acceptance.json`, `browser-recovery.json`, and `saved-answer.png`.
