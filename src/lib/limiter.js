export class BusyError extends Error {
  name = 'BusyError';
}

/**
 * Limits how much work runs at once:
 *  - a global concurrency cap with a bounded FIFO wait queue, and
 *  - a per-user cap on jobs in flight (running or queued).
 */
export class JobLimiter {
  #active = 0;
  #queue = [];
  #perUser = new Map();

  constructor({ concurrency = 5, perUser = 2, maxQueue = 100 } = {}) {
    this.concurrency = concurrency;
    this.perUser = perUser;
    this.maxQueue = maxQueue;
  }

  /** Reserve a slot for `userId`; returns false when they're at their limit. */
  acquireUser(userId) {
    const count = this.#perUser.get(userId) ?? 0;
    if (count >= this.perUser) return false;
    this.#perUser.set(userId, count + 1);
    return true;
  }

  releaseUser(userId) {
    const count = (this.#perUser.get(userId) ?? 1) - 1;
    if (count > 0) this.#perUser.set(userId, count);
    else this.#perUser.delete(userId);
  }

  /**
   * Run `task` once a global slot is free.
   * @template T
   * @param {() => Promise<T>} task
   * @param {{signal?: AbortSignal, onQueued?: (position: number) => void}} [options]
   * @returns {Promise<T>}
   */
  async run(task, { signal, onQueued } = {}) {
    signal?.throwIfAborted();
    if (this.#active < this.concurrency) {
      this.#active++;
    } else {
      if (this.#queue.length >= this.maxQueue) throw new BusyError('Too many queued jobs');
      await new Promise((resolve, reject) => {
        const entry = {
          resolve: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          const index = this.#queue.indexOf(entry);
          if (index !== -1) this.#queue.splice(index, 1);
          reject(signal.reason);
        };
        this.#queue.push(entry);
        signal?.addEventListener('abort', onAbort, { once: true });
        onQueued?.(this.#queue.length);
      });
      // The slot was handed over by the finishing job; #active is unchanged.
    }
    try {
      return await task();
    } finally {
      const next = this.#queue.shift();
      if (next) next.resolve();
      else this.#active--;
    }
  }

  get stats() {
    return { active: this.#active, queued: this.#queue.length, users: this.#perUser.size };
  }
}
