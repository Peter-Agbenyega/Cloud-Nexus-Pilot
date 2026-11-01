# Live provider acceptance preparation — 2026-11-01

Status: PREPARED; live semantic acceptance remains BLOCKED.

## Verified source and runtime
- Base checkpoint: 241620cd8644dcc9a5310a536a0d7f3f487d5938.
- Branch: fix/pilot-live-provider-acceptance-20261101.
- Durable checkout: ~/Cloud-Nexus-Pilot-live-acceptance.
- Existing synthetic runtime: ~/Cloud-Nexus-Pilot-voice-investigation, clean at 2440be5 when inspected.
- Old /private/tmp/cnp-quality-gates checkout has many missing tracked files. It was not restored, reset or edited.
- Original database, original services and running synthetic consumers were not modified.
- GitHub did not contain the supplied checkpoint at initial inspection; local Git objects supplied the exact source.

## Changes
- Explicit live profile uses only https://api.openai.com/v1, gpt-4o-mini and gpt-4o-mini-transcribe.
- Recovery identity/data remain on 127.0.0.1:59090; proposed live frontend/realtime use separate 43102/43311 loopback ports.
- scripts/pilot/live-local.mjs loads private mode0600 environment files without printing secrets, pins the live origin, and omits the OpenAI key during build.
- scripts/pilot/local.mjs preserves the default fixture restrictions and requires matching public configuration/build fingerprints before startup.
- Live and synthetic mode flags cannot conflict.
- Expired, malformed or wrong-role recovery token claims prevent live startup; this local preflight does not replace signature/account validation.
- Recovery cookie namespace is preserved for browser and server authentication. Live and synthetic test profiles intentionally share the recovery identity; original-stack namespace is unchanged.
- A visible live-provider disclosure explains external processing and charges. No automatic recording.
- Recovery gateway source permits the new live origin only; running gateway was not restarted.

## Validation
- Frontend lint PASS.
- Frontend typecheck PASS.
- Full frontend tests PASS: 210.
- Profile/auth-isolation tests PASS: 14.
- Scoped live-profile production frontend build and realtime compilation PASS.
- Independent source review PASS after correcting build/profile matching, mixed flags and request origin.
- Evidence: review/live-provider-acceptance/.
- Browser interaction and live provider inference NOT RUN.

## Credential findings
The protected live-provider.env file exists, but Node's actual environment parser reported OPENAI_API_KEY empty. An earlier regular-expression presence check was misleading and is not credential evidence. A native hidden-entry dialog was opened on the owner's Mac; it saves only to the private mode0600 file and never returns the key to chat.

The recovery anon/service JWTs are expired. Preserve the existing signer, accounts, consumed usage, records and database. Before activation, perform a guarded renewal of this recovery profile, reload its gateway, and rebuild affected consumers. Do not use original-stack renewal/bootstrap/seed helpers.

## Continuation
1. Confirm the key was entered privately; use the runtime parser, never print the value.
2. Authenticate the official API and check configured model access with bounded, redacted diagnostics.
3. Renew only recovery-profile credentials using its existing signer; preserve/verify identity and accounting, then rebuild. The current build fingerprint will correctly reject updated public tokens until rebuilt.
4. Review and restart only the recovery gateway for the additional CORS origin, preserving original-stack processes.
5. Run Node22 scripts/pilot/live-local.mjs check, build, then start. Check opens no network connection; build contains no provider key. Start alone does not send audio.
6. Submit one known short generated Kubernetes WAV and one question-specific guidance request through authenticated app routes. Inspect actual words/content, saved association, replay and reload. Generated speech is not physical-microphone evidence.
7. Perform a user-started physical microphone check; stop capture and verify recording indicators clear.
8. Keep production readiness and original saved-session recovery unresolved until separately verified.

No live success, production deployment, original-session recovery, or physical capture is claimed.
