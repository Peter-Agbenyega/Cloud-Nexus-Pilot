import { RequestBoundaryError } from "./request-boundary";
// Ephemeral per-runtime memory admission, not identity, quota or persistence.
// Durable usage/concurrency is independently reserved in PostgreSQL before any
// provider call. This bounds buffers even for rejected signed-in requests.
declare global { var __pilotIngressAdmission: Map<string, number> | undefined; }
export function acquireIngress(ownerId: string): () => void {
  const active = globalThis.__pilotIngressAdmission ??= new Map();
  const total = [...active.values()].reduce((sum, count) => sum + count, 0);
  const owned = active.get(ownerId) ?? 0;
  if (owned >= 2 || total >= 32) throw new RequestBoundaryError(429, "input_busy", "The processing queue is full. Pause capture and retry when current work finishes.");
  active.set(ownerId, owned + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = active.get(ownerId) ?? 0;
    if (count <= 1) active.delete(ownerId); else active.set(ownerId, count - 1);
  };
}
