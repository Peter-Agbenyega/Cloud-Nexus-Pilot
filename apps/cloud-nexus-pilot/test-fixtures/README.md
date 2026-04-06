# Test Fixtures

Create or copy a small known WAV file to:

- `apps/cloud-nexus-pilot/test-fixtures/known-sample.wav`

Recommended fixture:

- mono WAV
- short spoken phrase
- clear English speech
- under 30 seconds
- avoid silence-only clips if you want a non-empty transcript result

From inside `apps/cloud-nexus-pilot`, run:

- `npm run test:transcribe`
- `npm run test:streaming`

Or pass a fixture path explicitly from inside `apps/cloud-nexus-pilot`:

- `npm run test:transcribe -- /absolute/path/to/sample.wav`
- `npm run test:streaming -- /absolute/path/to/sample.wav`

From the repo root, the equivalent commands are:

- `npm run test:transcribe --workspace apps/cloud-nexus-pilot`
- `npm run test:streaming --workspace apps/cloud-nexus-pilot`
