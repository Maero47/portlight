import { describe, expect, test, vi } from "vitest";
import { HostConnectionError, HostRequestError, type HostClient } from "../../src/lib/host.ts";
import { createTunnelService, isTunnelMessage } from "../../src/lib/tunnels.ts";

const PROVIDERS = { cloudflared: true, ngrok: false };
const T = (port: number) => ({ port, provider: "cloudflared" as const, url: `https://p${port}.trycloudflare.com` as string | null, startedAt: "t", state: "running" as "running" | "starting" });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** A fake helper on a live connection: keeps its own tunnel list like the real host. */
function fakeLive(opts: { slow?: Promise<void>; listStarting?: boolean } = {}) {
  const tunnels: ReturnType<typeof T>[] = [];
  const calls: string[] = [];
  let closed = 0;
  const client = {
    tunnelStatus: vi.fn(async () => ({ providers: PROVIDERS, tunnels: [...tunnels] })),
    tunnelStart: vi.fn(async (port: number) => {
      calls.push(`start:${port}`);
      if (port === 4444) throw new HostRequestError("internal", "429 Too Many Requests");
      if (opts.slow) {
        // Like the host: listed as "starting" (unless it's an older host) until the URL arrives.
        const t = { ...T(port), url: null, state: "starting" as const };
        if (opts.listStarting !== false) tunnels.push(t);
        await opts.slow;
        if (!tunnels.includes(t) && opts.listStarting !== false) throw new HostRequestError("internal", "stopped before it printed a public URL");
        if (tunnels.includes(t)) tunnels.splice(tunnels.indexOf(t), 1);
      }
      tunnels.push(T(port));
      return { tunnel: T(port) };
    }),
    tunnelStop: vi.fn(async (port: number) => {
      calls.push(`stop:${port}`);
      tunnels.splice(tunnels.findIndex((t) => t.port === port), 1);
      return { stopped: true };
    }),
  } as unknown as HostClient;
  return { client, calls, tunnels, close: () => void closed++, closed: () => closed };
}

function setup(liveOpts: Parameters<typeof fakeLive>[0] = {}) {
  const live = fakeLive(liveOpts);
  const once = { tunnelStatus: vi.fn(async () => ({ providers: PROVIDERS, tunnels: [] })) } as unknown as HostClient;
  const timers: (() => void)[] = [];
  let made = 0;
  const svc = createTunnelService({
    live: () => (made++, { client: live.client, close: live.close }),
    once,
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => void timers.splice(0),
    now: () => 0,
  });
  return { svc, live, once, timers, made: () => made };
}

describe("tunnel service (background worker)", () => {
  test("status is free: no helper is started just to say 'nothing running'", async () => {
    const { svc, once, made } = setup();
    expect(await svc.handle({ op: "status" })).toEqual({ ok: true, providers: null, tunnels: [] });
    expect(once.tunnelStatus).not.toHaveBeenCalled();
    expect(made()).toBe(0);
    expect(await svc.handle({ op: "providers" })).toEqual({ ok: true, providers: PROVIDERS, tunnels: [] });
    expect(await svc.handle({ op: "providers" })).toEqual({ ok: true, providers: PROVIDERS, tunnels: [] });
    expect(once.tunnelStatus).toHaveBeenCalledTimes(1); // cached
  });

  test("start keeps one live connection; stopping the last tunnel closes it (the helper exits)", async () => {
    const { svc, live, made, timers } = setup();
    expect(await svc.handle({ op: "start", port: 5173 })).toEqual({ ok: true, providers: PROVIDERS, tunnels: [T(5173)] });
    await svc.handle({ op: "start", port: 3000 });
    expect(made()).toBe(1);
    expect(svc.connected).toBe(true);
    expect(timers.length).toBe(1);
    expect((await svc.handle({ op: "status" })).ok && (await svc.handle({ op: "status" }) as any).tunnels.length).toBe(2);
    await svc.handle({ op: "stop", port: 5173 });
    expect(svc.connected).toBe(true);
    expect(await svc.handle({ op: "stop", port: 3000 })).toEqual({ ok: true, providers: PROVIDERS, tunnels: [] });
    expect(svc.connected).toBe(false);
    expect(live.closed()).toBe(1);
    expect(timers.length).toBe(0);
  });

  test("a failed start reports the reason and doesn't leave a helper running", async () => {
    const { svc, live } = setup();
    expect(await svc.handle({ op: "start", port: 4444 })).toEqual({ ok: false, code: "internal", message: "429 Too Many Requests" });
    expect(svc.connected).toBe(false);
    expect(live.closed()).toBe(1);
  });

  test("polling notices when the host's watchdog stopped the last tunnel", async () => {
    const { svc, live, timers } = setup();
    await svc.handle({ op: "start", port: 5173 });
    live.tunnels.splice(0); // the server quit; the host closed its tunnel
    timers[0]!();
    await vi.waitFor(() => expect(svc.connected).toBe(false));
  });

  test("a helper that went away is treated as no tunnels", async () => {
    const { svc, live } = setup();
    await svc.handle({ op: "start", port: 5173 });
    (live.client.tunnelStatus as any).mockRejectedValueOnce(new HostConnectionError("crashed", "gone"));
    await svc.poll();
    expect(svc.connected).toBe(false);
  });

  test("old helpers answer 'unsupported'", async () => {
    const { svc, live } = setup();
    (live.client.tunnelStart as any).mockRejectedValueOnce(new HostRequestError("bad_request", 'unknown request type: "tunnelStart"'));
    (live.client.tunnelStatus as any).mockRejectedValueOnce(new HostRequestError("bad_request", "unknown"));
    expect(await svc.handle({ op: "start", port: 1 })).toMatchObject({ ok: false, code: "unsupported" });
  });

  // Regression: status/poll during a pending start used to see no tunnels, close the helper,
  // and so kill the tunnel that was still waiting for its URL.
  for (const listStarting of [true, false]) {
    test(`status and poll while a start is pending keep the helper (host ${listStarting ? "lists" : "doesn't list"} starting tunnels)`, async () => {
      const gate = deferred();
      const { svc, live, timers } = setup({ slow: gate.promise, listStarting });
      const started = svc.handle({ op: "start", port: 5173 });
      await vi.waitFor(() => expect(live.calls).toEqual(["start:5173"]));
      for (let i = 0; i < 3; i++) {
        const st = await svc.handle({ op: "status" });
        // Starting either way: the host lists it, or the worker fills in its own pending start.
        expect(st).toMatchObject({ ok: true, tunnels: [{ port: 5173, state: "starting", url: null }] });
        timers[0]!(); // the worker's 5 s poll
        await svc.poll();
      }
      expect(svc.connected).toBe(true);
      expect(live.closed()).toBe(0);
      gate.resolve();
      expect(await started).toEqual({ ok: true, providers: PROVIDERS, tunnels: [T(5173)] });
      expect(svc.connected).toBe(true);
    });
  }

  test("a poll that fails while a start is pending doesn't close the helper", async () => {
    const gate = deferred();
    const { svc, live } = setup({ slow: gate.promise });
    const started = svc.handle({ op: "start", port: 5173 });
    await vi.waitFor(() => expect(live.calls).toEqual(["start:5173"]));
    (live.client.tunnelStatus as any).mockRejectedValueOnce(new HostConnectionError("timeout", "slow"));
    await svc.poll();
    expect(live.closed()).toBe(0);
    gate.resolve();
    expect((await started).ok).toBe(true);
  });

  test("cancelling a pending start: the stop goes through, then the idle helper closes", async () => {
    const gate = deferred();
    const { svc, live } = setup({ slow: gate.promise });
    const started = svc.handle({ op: "start", port: 5173 });
    await vi.waitFor(() => expect(live.calls).toEqual(["start:5173"]));
    expect(await svc.handle({ op: "stop", port: 5173 })).toMatchObject({ ok: true, tunnels: [] });
    expect(svc.connected).toBe(true); // the start is still settling
    gate.resolve();
    expect(await started).toMatchObject({ ok: false });
    expect(svc.connected).toBe(false);
    expect(live.closed()).toBe(1);
  });

  test("a late status reply from a replaced helper never closes the new one", async () => {
    const { svc, live } = setup();
    await svc.handle({ op: "start", port: 5173 });
    // A status call is in flight on helper A when the last link stops and a new start begins.
    let release!: (v: unknown) => void;
    (live.client.tunnelStatus as any).mockImplementationOnce(() => new Promise((r) => (release = r)));
    const lateStatus = svc.handle({ op: "status" });
    await svc.handle({ op: "stop", port: 5173 });
    expect(svc.connected).toBe(false);
    const gate = deferred();
    (live.client.tunnelStart as any).mockImplementationOnce(async (port: number) => {
      await gate.promise;
      live.tunnels.push(T(port));
      return { tunnel: T(port) };
    });
    const next = svc.handle({ op: "start", port: 3000 });
    release({ providers: PROVIDERS, tunnels: [] });
    await lateStatus;
    expect(svc.connected).toBe(true);
    gate.resolve();
    expect((await next).ok).toBe(true);
    expect(svc.connected).toBe(true);
  });

  test("message guard", () => {
    expect(isTunnelMessage({ type: "portlight:tunnel", op: "status" })).toBe(true);
    expect(isTunnelMessage({ type: "portlight:count" })).toBe(false);
    expect(isTunnelMessage(null)).toBe(false);
  });
});
