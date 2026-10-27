# Audio/client implementation evidence

Worker: `/root/audio_journey`. Worktree `/private/tmp/cnp-quality-gates`, branch `fix/pilot-quality-gates`. All source edits are in `apps/cloud-nexus-pilot`; no API, infrastructure, persistence adapter or manifest changes by this worker. No commit made. Base at final scoped checks: `9d90fa5c54ec7a8a5e9d0e5d5274e2a45a805cff`. Root integration must rerun gates after its final changes.

## Implemented

- Stateful area-average PCM resampling carries fractional phase between audio callbacks. Exact committed old implementation reproduced sample loss on one-second callback-split vectors: 44.1 kHz produced 15,999 and 48 kHz produced 15,984 samples, against 16,000 expected. Fixed implementation yields exact duration and matches the uninterrupted-vector output. See `resampling-reproduction.json`.
- WAV headers explicitly validate mono/interleaved stereo framing and sample-rate values. Live capture deliberately downmixes to mono. Nonfinite samples become silence; unsupported upsampling rejects.
- Pipeline setup has cancellation and a five-second resume deadline. Startup failure, consumer exceptions, repeated stop and callback errors clean up processor/source/gain/context independently. Pause does not enqueue new frames; queued audio may finish. RMS level is measured from actual callback samples; the UI throttles meter updates.
- Source selection rejects absent/disabled/ended audio, releases acquired video-only shares and never substitutes a microphone. Permission acquisition occurs before network waits to preserve the display-capture user gesture.
- Live transcription uses complete PCM/WAV chunks. The invalid seed-plus-MediaRecorder-fragment fallback was removed; unsupported PCM capture explicitly offers completed-file upload. No new provider was introduced.
- Transport validates session/chunk/source matches, ignores malformed/duplicate events, delivers concurrent results in upload order, deduplicates pending/completed chunk IDs, bounds concurrent uploads/count/bytes, aborts HTTP on timeout/stop and closes orphaned startup sessions. Reconnect keeps the owned session and can complete via durable HTTP saved acknowledgements.
- Capture stop flushes valid final PCM before invalidating ownership and waiting for bounded in-flight uploads. Retries are bounded; backpressure stops capture visibly and reports an audio gap. Source revocation reports that unacknowledged audio can be missing. The workspace's implicit auto-attach effect no longer restarts capture after Stop or stops an unrelated manual microphone capture.
- Transcript cleanup preserves words, short truthful answers, negations and technical `LIKE`; it no longer guesses those words are filler/silence.
- UI shows capture, paused/input-level, transport/request progress and server acknowledgement separately. Explicit recover/export/delete controls use the authenticated owner-scoped server routes, with bounded recovery reads. The remembered session identifier is only a cursor; server authorization remains authoritative. Deletion requires a matching server acknowledgement. Browser-local history is explicitly separate.

## Executed scope

`commands.json` contains actual command arguments, timestamps, exits and full log hashes. At the final scoped check:

- `npm run test:intelligence --workspace apps/cloud-nexus-pilot`: exit 0, **56/56 passed** (40 prior + 16 new synthetic tests).
- `npm run lint --workspace apps/cloud-nexus-pilot`: exit 0.
- `npm run typecheck --workspace apps/cloud-nexus-pilot`: exit 0.
- `git diff --check`: exit 0 during review.

The new tests execute callback-split 44.1/48 kHz vectors, clipping/silence/nonfinite input, WAV first/later headers/stereo framing, fake-WebAudio pause/final flush/cleanup/startup cancellation, video-only source rejection, SSE identity/malformed/ordering/dedup behavior, saved HTTP completion during reconnect, upload cancellation/queue bounds, startup failure cleanup and stubbed recovery/export-data/deletion ownership denial. They are unit/contract checks using synthetic samples and mocked browser/network interfaces.

## Acceptance limits

This is partial automated evidence for P-04/05/06/07/08/09/12/15. It does **not** prove physical microphone input, macOS sharing permission behavior, real provider transcription quality/latency, hosted identity/storage, rolling recovery, guidance quality or the complete browser journey. The PCM path still uses ScriptProcessorNode; an AudioWorklet migration is a separate measured change. Recover/export requires the root's configured authenticated durable store. No paid call, recording, deployment or hosted mutation was performed.

React review used the installed `vercel:react-best-practices` skill after two TSX edits: reviewed stable hooks, explicit user-event capture, bounded requests, scalar status rendering, labelled meter/buttons, storage minimization and listener cleanup. Independent review remains root's responsibility; this worker does not claim to have independently reviewed its own patch.

## Follow-up: owned guidance association and typed fallback (27 October)

The root's independent server review identified that the real guidance caller omitted its owned session ID. Fixed the actual ready/live caller using `requestOwnedGuidance`, which prepares an authenticated acknowledged session through the existing route, then sends the authoritative session ID and SHA-256 question/transcript-revision IDs. An explicit typed-question form works without audio acquisition; an ended session produces a new owned session, while an active owned session is reused. Unauthenticated/unacknowledged creation and cancellation prevent the guidance request entirely. The client request and final-response read share a 30-second deadline.

Recovered succeeded guidance now renders with the saved question/turn metadata in both the ready/live panel and standalone transcript surface. Earlier guidance lacking question metadata is labelled as such. The hook only marks server saves from acknowledged results; local interview persistence remains separate. Recover/export/delete controls remain available without recording.

A shared bounded final-event reader handles UTF-8/CRLF splits, requires a completed final answer, rejects malformed/truncated/oversized output, and cancels/releases its stream reader. The ready panel no longer simulates token typing after the server has delivered a final answer. New detected questions, pause transitions and stop transitions abort the previous guidance request and clear its current answer; late aborted results cannot publish. The live panel now exposes Pause/Resume and a measured selected-source meter. Typed actions without an active capture do not get cancelled merely because no microphone is running.

Eight new behavioral regressions cover ownership/session preparation and association, zero guidance requests on denied/cancelled preparation, committed-only history restoration, and bounded stream completion/cancellation. Latest actual intelligence result: **66/66 passing** (includes root-added provider tests), frontend lint/typecheck both exit **0**. See `guidance-commands.json` and complete `guidance-verified-*.log` files. `guidance-source.json` binds the source snapshot. The earlier 56-test record remains a historical scoped checkpoint, not the current integrated total. Root must rebuild and revalidate after final server integration.

No commit, deployment, live provider test or physical recording was performed. The new rendered controls were typechecked and their request/stream helpers executed with stubs; a compiled browser exercise remains separate evidence for the root to collect.

## Final follow-up: pre-capture disclosure and account discovery

Added `CaptureDisclosure` before audio source/start controls in the ready panel and transcript surface. It requests authenticated safe capabilities with a five-second abort, 8 KB response cap, no-store fetch and unmount cleanup. It displays exact configured provider enums, distinguishes a selected synthetic fixture from live availability, and has an honest unverified/configuration-unavailable state with retry. The copy addresses visible user initiation, participant/organizational permission, missing shared-audio tracks, explicit microphone/WAV fallback, transient Pilot audio, separate provider retention, and separate server/browser-local text deletion. Borrowed-stream surfaces explain that ending the parent shared session releases that source. No checkbox or hidden capture action was introduced. The source card now says supported shared tabs and enable Share audio rather than claiming universal Zoom/Teams/Meet capture.

Added one shared `SavedSessionPicker` to ready/live and transcript saved controls. Explicit Find uses the root's authenticated account list route and labels the most recent 100 records at most. The browser needs no remembered session ID. Selected metadata alone does not change the current server cursor: recover accepts an optional selected ID and adopts/persists it only after the owner-scoped full read acknowledges that ID. Denial never substitutes browser-local data. List response bytes, record count, IDs and dates are bounded/validated; discovery cancellation is independent of root's preserved file-upload cancellation.

Three meaningful metadata helper tests cover new-browser discovery, denied account access and malformed/oversized/over-count responses. Latest scoped run: **69/69 intelligence tests**, lint and typecheck all exit 0, recorded in `disclosure-picker-commands.json` with full log hashes. UI cleanup/accessibility reviewed with the previously loaded React skill: labelled native select/buttons, polite configuration status, independent abort/timer cleanup and explicit user-triggered data discovery. No mirror tests for static disclosure prose were added. Root's final compiled browser/build exercise remains authoritative for the integrated UI.

Source frozen for root integration. A possible stale recovery-response race under simultaneous Start/clear/delete was reported to root for a small generation guard; no unreported fix is claimed here.

## Recovery race guard follow-up

Applied a separate `recoveryEpochRef` in the transcription hook without changing streaming-generation identity or disturbing in-flight live chunks. Teardown, a successful capture startup lock, explicit guidance-session preparation and local transcript selection invalidate older recovery results. Recovery increments/captures its epoch and starting server-session cursor, then checks both after its acknowledged read and before displaying errors. Deletion invalidates previous recovery before dispatch; a late delete acknowledgement may remove that deleted metadata item but cannot clear a newly selected/captured view. A stale failure likewise cannot replace the current error state.

Scoped lint and TypeScript both passed on this small hook guard; command records and hashes are in `recovery-epoch-commands.json` and `recovery-epoch-source.json`. No mirror test of the epoch comparison was added. The real browser race exercise and final integrated build remain root verification. Source frozen again; no commit by this worker.
