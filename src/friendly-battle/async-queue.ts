/**
 * Minimal async queue — shared between daemon.ts and tcp-direct.ts.
 *
 * `push` enqueues a value (or resolves a pending waiter immediately).
 * `shift` dequeues a value (or waits up to `timeoutMs`).
 * `fail`  rejects all pending waiters with the given error.
 */
export class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
  }> = [];
  private readonly createTimeoutError: (label: string, timeoutMs: number) => Error;

  constructor(createTimeoutError?: (label: string, timeoutMs: number) => Error) {
    this.createTimeoutError =
      createTimeoutError ?? ((label, ms) => new Error(`${label} timed out after ${ms}ms`));
  }

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    this.values.push(value);
  }

  fail(error: Error): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  shift(timeoutMs: number, label: string): Promise<T> {
    if (this.values.length > 0) {
      return Promise.resolve(this.values.shift() as T);
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
      } as {
        resolve: (value: T) => void;
        reject: (error: Error) => void;
        timer?: NodeJS.Timeout;
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(this.createTimeoutError(label, timeoutMs));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  get size(): number {
    return this.values.length;
  }
}
