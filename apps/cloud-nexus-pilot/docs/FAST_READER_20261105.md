# Faster guidance and aligned reading workspace — 2026-11-05

The user confirmed physical microphone transcription and answer delivery, but reported slow responses and difficulty moving between the question and answer. This change makes the question visible beside its associated answer and starts showing useful answer text before the complete response finishes.

## Behavior

- Equal square question-left/answer-right panels on desktop, stacked on narrow screens. Independent scrolling preserves alignment. Primary text contrast is 16.24:1; secondary text contrast is 10.90:1. Comfortable and larger text sizes are available. Full explanations expand inside the answer panel.
- Typed, detected, and recovered answers retain their associated question. Input, saved-session tools, optional context, privacy details, and transcript history sit below the main reading area.
- Capture windows are two seconds instead of four. The second transcript buffer was removed: provider-final words appear immediately and existing fragment-completion guards assemble questions. Complete locally detected questions skip the redundant model normalization request; unresolved prompts retain correction.
- The server streams a decoded, bounded `speakNow` preview while the remaining structured answer is generated. The UI explicitly marks it as a draft, clears it on failure/cancellation, and only presents completion after final validation and persistence. Raw JSON never appears in the reader.
- The model writes the direct opening first. Full technical detail remains available; duplicate compatibility fields are now supplied by the server. Saved-history refresh no longer blocks first answer display.

## Measurements

A single bounded before/after live comparison used the same generated question, “What is Kubernetes?”, and configured OpenAI models. First readable answer text (40 characters) arrived in **3938.30ms before** and **871.84ms after**. Completed answer arrival was **3938.29ms before** and **2994.97ms after**. These are HTTP transport measurements, excluding microphone chunk accumulation, frontend detection, and browser paint; they are not a universal latency guarantee.

The separate typed browser test displayed “What is Terraform?” on the left and its correct answer on the right, with a first-text indication of **1.0s**. Recovery retained the same question/answer pair. Desktop panels measured 455.5×455.5px at the same vertical position. Narrow-screen testing found no horizontal overflow, and the viewport was restored afterward.

The user’s physical microphone was not activated by automation. A fresh microphone test is still needed to measure end-to-end latency in the user’s environment. Room noise continues through transcription so quiet speech is not discarded. Two-second capture windows increase request cadence; the six-request concurrency limit remains in force.

## Verification

- Full application suite: **258/258 passed**. Live-profile suite: **9/9 passed**. Lint and frontend/realtime production build passed.
- Focused tests cover split question completion, local detection bypass, correction caching, safe JSON-string previews, split UTF-8/escape sequences, incomplete/malformed output, provider failure, cancellation, stream bounds, and final-only persistence.
- Before and after live tests verified speech transcription, digital-silence zero usage, replay, saved association, export, and zero synthetic-provider dispatch. Browser typed generation, text-size controls, responsive layout, and saved-session recovery passed.
- Evidence: `review/fast-reader-20261105/{before,after,comparison,validation}.json` and `desktop-reader.png`.

The local app was rebuilt and restarted on port43102. No API key, billing setting, original transcript, or production deployment was changed.
