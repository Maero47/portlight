// One gate for every settings write from the options page.
//
// Settings live in chrome.storage.local, which has no write-rate quota, so this is not about
// limits any more. It keeps storage calm: controls can fire far faster than anyone needs to
// persist (held arrow keys, key repeat on Backspace, radio groups that wrap), and every write
// wakes each open surface's onChanged listener. Edits are merged here: the first edit after a
// quiet spell is written at once, later ones are merged into one trailing write at most every
// `minIntervalMs`, and only one write is ever in flight.

export const MIN_WRITE_INTERVAL_MS = 250;

export interface WriterOptions {
  minIntervalMs?: number;
  now?: () => number;
  /** Called when nothing is staged and nothing is in flight any more. */
  onIdle?: () => void;
}

export class WriteScheduler<P extends object> {
  private staged: P | null = null;
  private inFlight: Promise<void> | null = null;
  private lastStart = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private forced = false;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly onIdle?: () => void;
  /** Number of writes started, for tests and diagnostics. */
  writes = 0;

  constructor(private readonly write: (patch: P) => Promise<void>, opts: WriterOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? MIN_WRITE_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.onIdle = opts.onIdle;
  }

  /** Merge a patch into the next write (later keys win) and write when the gate allows. */
  schedule(patch: P): void {
    this.staged = { ...(this.staged ?? {}), ...patch } as P;
    this.pump();
  }

  /** Start writing anything staged right away, ignoring the interval. */
  flush(): Promise<void> {
    this.forced = true;
    this.pump();
    return this.settled();
  }

  /** True while an edit is staged or being written. */
  busy(): boolean {
    return this.staged !== null || this.inFlight !== null;
  }

  /** Resolves once everything staged so far has been written. */
  async settled(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  private pump(): void {
    if (this.inFlight || !this.staged) return;
    const wait = this.forced ? 0 : this.lastStart + this.minIntervalMs - this.now();
    if (wait > 0) {
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, wait);
      return;
    }
    this.run();
  }

  private run(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.forced = false;
    const patch = this.staged!;
    this.staged = null;
    this.lastStart = this.now();
    this.writes++;
    this.inFlight = Promise.resolve()
      .then(() => this.write(patch))
      .catch(() => {}) // the write function reports its own errors
      .finally(() => {
        this.inFlight = null;
        if (this.staged) this.pump();
        else this.onIdle?.();
      });
  }
}
