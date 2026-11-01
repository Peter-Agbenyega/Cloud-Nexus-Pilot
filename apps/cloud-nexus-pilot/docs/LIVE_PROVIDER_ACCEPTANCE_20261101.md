# Live provider acceptance — 2026-11-01

Status: key provisioned and authenticated; live application running locally; semantic acceptance BLOCKED by upstream HTTP 429.

## Current result
- User approved creation and the private local destination. The OpenAI Developers encrypted setup created Cloud-Nexus-Pilot in Personal / Cloudnexususa.
- The provider secret was saved outside git to the approved mode0600 live-provider.env; it was never printed.
- Official /v1/models returned 200. Both gpt-4o-mini and gpt-4o-mini-transcribe were listed. This proves authentication/model listing, not inference entitlement.
- One generated Kubernetes speech WAV was submitted through the authenticated application. OpenAI transcription returned HTTP 429; the app returned transcript_processing_failed.
- No guidance request was sent. No inference retry was made.
- Provider error bodies are currently discarded by the adapter. Therefore the exact reason (rate, credits, spend or usage limits) is NOT established.
- Browser billing inspection timed out. No payment, billing or limit change was made.
- The attempt session is ended, with no transcript or guidance events and zero remaining reserved local units. The existing conservative accounting retains usage for an unknown provider outcome.
- A durable one-shot marker prevents accidental reruns of the acceptance script.
- Physical microphone, complete semantic behavior, export of successful live output and production readiness remain unverified.

## Recovery activation
- Renewed only expired anon and service credentials for the recovery stack, keeping its existing signer.
- Verified new JWTs against the running PostgREST verifier before writing.
- Guarded against wrong container identity, purpose labels, environment, source checkout and gateway listener.
- Full public-table row digests and account-id digest matched before/after renewal.
- Credentials/metadata rollback copies remain private; the OpenAI key was not included in those copies.
- Stopped the old synthetic frontend/realtime consumers on 43101/43310. The synthetic provider fixture remains on 59093.
- Reloaded only the recovery gateway on 59090 from this checkout; live-origin CORS was verified.
- Rebuilt and started live frontend/realtime at 127.0.0.1:43102 / 43311.
- Recovery credentials expire 2026-11-02 21:02:33 UTC; startup/settlement fails closed after expiry.
- Original stack temporary state record was absent at inspection and remained absent. No original stack/database action was performed.
- Do not use the old fixture-login redirect: it still targets the stopped synthetic frontend.

## Source and checks
- Base checkpoint: 241620cd8644dcc9a5310a536a0d7f3f487d5938.
- Branch: fix/pilot-live-provider-acceptance-20261101.
- Checkout: ~/Cloud-Nexus-Pilot-live-acceptance.
- Prior preparation commit ecb45d2: frontend lint/typecheck, 210 frontend tests, 14 profile/auth-isolation tests and scoped production build passed.
- Activation: scoped production frontend build and realtime compilation passed; live profile check passed.
- Renewal and acceptance scripts pass Python compilation / Node syntax validation; git whitespace check passed.
- Live and synthetic profiles share the recovery identity/cookie namespace. Original-stack cookie namespace is unchanged.
- Live build excludes the provider key and requires a matching public configuration fingerprint.
- Recording starts only through user action. Generated speech is not physical microphone evidence.
- Old quality-gates checkout with missing files was not restored/reset/edited.

## Continuation
1. Confirm billing and limits for the key's actual organization/project: Personal / Cloudnexususa. Browser screenshot previously showed final-round-ai, so do not assume it is the same project.
2. Preserve safe provider error-code diagnostics on any newly authorized retry; never expose raw error bodies or credentials.
3. Review the recorded attempt before explicitly authorizing another bounded test. Do not delete or bypass the one-shot marker automatically.
4. Verify actual transcript and relevant Kubernetes answer, saved association, replay and reload after provider access works.
5. Arrange test-account browser sign-in to 43102 and perform a user-started physical microphone check.
6. Keep production rollout and original-session recovery unresolved until independently verified.

Evidence: review/live-provider-acceptance/activation-20261101.json. No live semantic success is claimed.
