export type QueueMode = "redis" | "memory";

export interface QueueAdapter {
  mode: QueueMode;
  enqueue(queue: string, payload: Record<string, unknown>): Promise<void>;
}

class InMemoryQueueAdapter implements QueueAdapter {
  mode: QueueMode = "memory";

  async enqueue(queue: string, payload: Record<string, unknown>): Promise<void> {
    console.debug("[queue:memory] enqueue", { queue, payload });
  }
}

export function createQueueAdapter(): QueueAdapter {
  // Phase 1 local-safe default: no Redis required to run foundation endpoints.
  return new InMemoryQueueAdapter();
}
