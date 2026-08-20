export async function cooperativeYield() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  if (globalThis.scheduler?.postTask) return globalThis.scheduler.postTask(() => {}, { priority: "background" });
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function processInBatches(items, process, { batchSize = 256, signal, yieldTask = cooperativeYield } = {}) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const end = Math.min(items.length, offset + batchSize);
    for (let index = offset; index < end; index++) results.push(await process(items[index], index));
    if (end < items.length) await yieldTask();
  }
  return results;
}

export class Instrumentation {
  constructor() {
    this.counters = new Map();
    this.timings = new Map();
  }
  increment(name, amount = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }
  async time(name, operation) {
    const start = performance.now();
    try {
      return await operation();
    } finally {
      const elapsed = performance.now() - start;
      const values = this.timings.get(name) ?? [];
      values.push(elapsed);
      this.timings.set(name, values);
    }
  }
  snapshot() {
    const timings = Object.fromEntries(
      [...this.timings].map(([name, values]) => [name, {
        count: values.length,
        totalMs: values.reduce((sum, value) => sum + value, 0),
        maxMs: Math.max(0, ...values),
      }])
    );
    return { counters: Object.fromEntries(this.counters), timings };
  }
}
