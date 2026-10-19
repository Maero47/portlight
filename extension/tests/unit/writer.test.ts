import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_WRITE_INTERVAL_MS, WriteScheduler } from "../../src/options/writer.ts";

type P = Record<string, unknown>;

function setup(opts: { latency?: number; onIdle?: () => void } = {}) {
  const writes: { at: number; patch: P }[] = [];
  const w = new WriteScheduler<P>(
    async (patch) => {
      writes.push({ at: Date.now(), patch });
      if (opts.latency) await new Promise((r) => setTimeout(r, opts.latency));
    },
    { onIdle: opts.onIdle },
  );
  return { w, writes };
}

describe("WriteScheduler", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it("writes the first edit at once", async () => {
    const { w, writes } = setup();
    w.schedule({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([{ at: 0, patch: { a: 1 } }]);
  });

  it("merges a burst into one trailing write, later keys winning", async () => {
    const { w, writes } = setup();
    w.schedule({ theme: "light" });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 50; i++) w.schedule({ theme: i % 2 ? "dark" : "system", n: i });
    w.schedule({ editor: "zed" });
    await vi.advanceTimersByTimeAsync(MIN_WRITE_INTERVAL_MS);
    expect(writes.map((x) => x.patch)).toEqual([{ theme: "light" }, { theme: "dark", n: 49, editor: "zed" }]);
    expect(writes[1]!.at).toBe(MIN_WRITE_INTERVAL_MS);
  });

  it("never writes more than 100 times a minute, however fast edits come", async () => {
    const { w, writes } = setup({ latency: 30 });
    // An edit every 10 ms for two minutes: 12 000 edits.
    for (let t = 0; t < 120_000; t += 10) {
      w.schedule({ v: t });
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(5_000);
    for (let i = 1; i < writes.length; i++) expect(writes[i]!.at - writes[i - 1]!.at).toBeGreaterThanOrEqual(MIN_WRITE_INTERVAL_MS);
    const perMinute = writes.filter((x) => x.at < 60_000).length;
    expect(perMinute).toBeLessThanOrEqual(100);
    expect(writes.at(-1)!.patch).toEqual({ v: 119_990 });
  });

  it("keeps one write in flight and waits for slow writes", async () => {
    const { w, writes } = setup({ latency: 2_000 });
    w.schedule({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);
    w.schedule({ a: 2 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes.map((x) => x.patch)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("flush writes staged edits right away", async () => {
    const { w, writes } = setup();
    w.schedule({ a: 1 });
    w.schedule({ a: 2 });
    expect(w.busy()).toBe(true);
    await w.flush();
    expect(writes.map((x) => x.patch)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(Date.now()).toBe(0);
    expect(w.busy()).toBe(false);
  });

  it("reports idle once drained, and survives a failing write", async () => {
    const onIdle = vi.fn();
    let fail = true;
    const w = new WriteScheduler<P>(async () => {
      if (fail) throw new Error("quota");
    }, { onIdle });
    w.schedule({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onIdle).toHaveBeenCalledTimes(1);
    fail = false;
    w.schedule({ a: 2 });
    await vi.advanceTimersByTimeAsync(MIN_WRITE_INTERVAL_MS);
    expect(onIdle).toHaveBeenCalledTimes(2);
    expect(w.writes).toBe(2);
  });
});
