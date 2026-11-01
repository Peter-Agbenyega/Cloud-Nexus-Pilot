import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureRetryQueue, capturePresentation, shouldRetryChunk, stoppedCaptureFeedback } from "../../features/transcription/capture-recovery";

test("retry exhaustion is bounded; auth/quota/storage failures require explicit recovery", () => {
  assert.deepEqual([0,1,2,3].map(n => shouldRetryChunk(new Error("network timeout"),n)),[true,true,false,false]);
  for (const status of [400,401,403,408,409,413,415,429,503]) assert.equal(shouldRetryChunk({status},0),false);
  assert.equal(shouldRetryChunk({status:502},0),true);
});

test("stop clears timers and stale timer callbacks cannot revive stopped or restarted capture", () => {
  const pending = new Map<number,()=>void>(); let id=0, calls=0;
  const queue=new CaptureRetryQueue({set:cb=>{const key=++id;pending.set(key,()=>{pending.delete(key);cb();});return key;},clear:key=>{pending.delete(key);}});
  queue.begin();queue.schedule(()=>calls++,100);
  const stale=[...pending.values()][0]!;
  queue.cancel();assert.equal(pending.size,0);stale();assert.equal(calls,0);
  queue.schedule(()=>calls++,100);assert.equal(pending.size,0);
  queue.begin();stale();assert.equal(calls,0);
  queue.schedule(()=>calls++,100);[...pending.values()][0]!();assert.equal(calls,1);
  queue.cancel();assert.equal(pending.size,0);
});

test("terminal capture never advertises listening/retrying or offers Pause; restart remains explicit", () => {
  for (const status of ["failed","stopped","stopping"] as const) {
    const view=capturePresentation(false,false,status);
    assert.equal(view.stopped,true);assert.equal(view.canPause,false);assert.doesNotMatch(view.label,/listening|retrying/i);
    assert.equal(view.canRetry,status!=="stopping");
  }
  assert.equal(capturePresentation(true,true,"paused").canPause,true);
  assert.equal(capturePresentation(true,false,"listening").stopped,false);
  assert.equal(capturePresentation(true,false,"failed").canPause,false);
});


test("billing failures stop retries and do not suggest typed guidance on the same exhausted provider", () => {
  for (const code of ["provider_credit_balance_exhausted", "provider_spend_limit_exceeded", "provider_usage_limit_exceeded", "provider_quota_exhausted"]) {
    const error = { status: 429, code };
    assert.equal(shouldRetryChunk(error, 0), false);
    const feedback = stoppedCaptureFeedback(error);
    assert.match(feedback, /billing must be restored/);
    assert.doesNotMatch(feedback, /or use typed guidance/);
  }
  assert.match(stoppedCaptureFeedback({ status: 401 }), /explicitly restart/);
});
