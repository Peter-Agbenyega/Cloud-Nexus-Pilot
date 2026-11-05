# Live provider acceptance — 2026-11-05

Status: generated-speech transcription, guidance, persistence and export PASSED in the isolated local live app. Physical microphone acceptance remains pending.

## Result

At 05:28 UTC the app transcribed the 0.923125-second generated question as “What is Kubernetes?” and produced a relevant explanation of container orchestration. One successful transcription request and one guidance request completed. The transcript and associated answer were saved, the session ended, and its export was verified. A separate fresh sign-in retrieved the same ended session and answer.

The synthetic provider received zero requests during the successful acceptance run. Local reserved usage returned to zero. The recorded usage delta is local accounting units, not API dollars or tokens.

## Corrected configuration

- The user approved Peter Dev Lab / final-round-ai. The secure connector created and saved the project key to the previously approved private file outside git. No plaintext key appeared in tool output.
- The earlier key belonged to Personal / Cloudnexususa, a separate organization from the user's funded account.
- The first attempt with the funded key returned 403 for the short transcription alias and made no guidance request. That failed session is ended with no transcript or answer.
- Project model discovery returned the dated `gpt-4o-mini-transcribe-2025-12-15` model, while a direct lookup for the short alias returned 404. The live acceptance profile now pins that available snapshot; `gpt-4o-mini` remains the guidance model. The next bounded acceptance passed.
- The transcription adapter's application-wide default was not changed. Official model reference: https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe . The currently documented shutdown date for this family is 2027-02-26; a future hosted release must plan the provider upgrade before then.

## Local runtime and sign-in

Frontend: http://127.0.0.1:43102 . Realtime: ws://127.0.0.1:43311/ws/session . Identity/data remain on the isolated recovery stack at 59090.

The recovery test sign-in link http://127.0.0.1:59093/fixture-login now redirects to the live workspace when its explicit live flag is enabled. Only the two fixed recovery destinations are permitted; the original fixture cannot enable live sign-in. HTTP verification confirmed 302 to the live workspace, recovery-only cookies, workspace HTTP 200, the live-provider disclosure, and rejection of arbitrary redirect queries.

Expired recovery API credentials were renewed with the same signer. Account identities, public data and original-stack state were verified unchanged. The new credentials expire at 2026-11-06 05:23:25 UTC. The frontend/realtime build was regenerated for the renewed configuration before startup.

## Validation and limits

- Nine live-profile tests passed; four isolated fixture redirect and guard checks passed.
- Frontend production build, including lint/type validation, and realtime compilation passed.
- An independent reviewer checked the source diff and successful report.
- Live provider requests during this continuation: one failed alias transcription; then one successful snapshot transcription and one successful answer. No automatic provider retry loop was introduced.
- Evidence is under `review/live-provider-acceptance/`: `funded-provider-acceptance-20261105.json`, `session-reload-20261105.json`, `model-access-20261105.json`, and `recovery-renewal-20261105.json`.

This does not establish physical microphone or shared-tab capture, long-running/reconnect behavior, original-session recovery, or production deployment readiness. No merge or hosted rollout occurred.

## Physical microphone check

Open the recovery sign-in link on the Mac. Select **Use Microphone** (the default is **Share Tab Audio**), click **Start Session**, allow microphone access, and ask “What is Kubernetes?” Wait for the visible transcript and relevant answer, then click **End Session**. Recording begins only through the user's action.
