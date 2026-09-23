/** Owns permission requests and streams across asynchronous UI teardown. */
export class CaptureOwnership {
  private generation = 0;
  private pending: number | null = null;
  private stream: MediaStream | null = null;

  begin(): number | null {
    // Keep the lock until startup settles, even if stop/unmount invalidates it.
    if (this.pending !== null) return null;
    const token = ++this.generation;
    this.pending = token;
    return token;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  adopt(token: number, stream: MediaStream): boolean {
    if (!this.isCurrent(token)) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    this.stream = stream;
    return true;
  }

  cancel(): void {
    this.generation += 1;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  finish(token: number): void {
    if (this.pending === token) this.pending = null;
  }
}
