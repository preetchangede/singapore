// A small pool of mesher workers. Requests for the same bundle go to the same worker
// so each bundle is downloaded & decoded once.
type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void };

export class WorkerPool {
  workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  busy: number[] = [];

  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('../workers/mesher.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') return;
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        this.busy[i]--;
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
      };
      w.onerror = (e) => console.error('mesher worker failed to start:', e.message || e.type);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  init(msg: Record<string, unknown>) {
    for (const w of this.workers) w.postMessage({ type: 'init', ...msg });
  }

  workerFor(bx: number, by: number) {
    return ((bx * 73856093) ^ (by * 19349663)) >>> 0;
  }

  request<T>(bx: number, by: number, msg: Record<string, unknown>): Promise<T> {
    const wi = this.workerFor(bx, by) % this.workers.length;
    const id = this.nextId++;
    this.busy[wi]++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.workers[wi].postMessage({ ...msg, id });
    });
  }

  /** Send to a specific worker index (used to spread overview meshing). */
  requestOn<T>(wi: number, msg: Record<string, unknown>): Promise<T> {
    wi = wi % this.workers.length;
    const id = this.nextId++;
    this.busy[wi]++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.workers[wi].postMessage({ ...msg, id });
    });
  }

  broadcast(msg: Record<string, unknown>) {
    for (const w of this.workers) w.postMessage(msg);
  }

  prefetch(bx: number, by: number) {
    const wi = this.workerFor(bx, by) % this.workers.length;
    this.workers[wi].postMessage({ type: 'prefetch', bx, by });
  }

  get inflight() { return this.busy.reduce((a, b) => a + b, 0); }
}
