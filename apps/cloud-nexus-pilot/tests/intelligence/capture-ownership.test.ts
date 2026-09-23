import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureOwnership } from "../../lib/realtime/capture-ownership";

function fakeStream() {
  let stops = 0;
  const stream = { getTracks: () => [{ stop: () => { stops += 1; } }] } as unknown as MediaStream;
  return { stream, stops: () => stops };
}

test("late permission grant after teardown closes fake tracks instead of adopting them", () => {
  const owner = new CaptureOwnership();
  const token = owner.begin()!;
  owner.cancel();
  const fake = fakeStream();
  assert.equal(owner.adopt(token, fake.stream), false);
  assert.equal(fake.stops(), 1);
});

test("startup failure closes the acquired fake stream before a fresh start", () => {
  const owner = new CaptureOwnership();
  const token = owner.begin()!;
  const fake = fakeStream();
  assert.equal(owner.adopt(token, fake.stream), true);
  owner.cancel();
  assert.equal(fake.stops(), 1);
  assert.equal(owner.isCurrent(token), false);
  owner.finish(token);
  assert.notEqual(owner.begin(), null);
});

test("stop during async startup keeps a lock until old startup settles", () => {
  const owner = new CaptureOwnership();
  const token = owner.begin()!;
  assert.equal(owner.begin(), null);
  owner.cancel();
  assert.equal(owner.begin(), null);
  owner.finish(token);
  const next = owner.begin()!;
  assert.equal(owner.isCurrent(token), false);
  owner.finish(token);
  assert.equal(owner.begin(), null);
  assert.equal(owner.isCurrent(next), true);
});
