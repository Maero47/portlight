import { describe, expect, test, vi } from "vitest";
import { HostConnectionError, HostRequestError, type HostClient } from "../../src/lib/host.ts";
import { createTunnelService, isTunnelMessage } from "../../src/lib/tunnels.ts";

const PROVIDERS = { cloudflared: true, ngrok: false };
const T = (port: number) => ({ port, provider: "cloudflared" as const, url: `https://p${port}.trycloudflare.com`, startedAt: "t" });

/** A fake helper on a live connection: keeps its own tunnel list like the real host. */
function fakeLive() {
  const tunnels: ReturnType<typeof T>[] = [];
  const calls: string[] = [];
  let closed = 0;
  const client = {
    tunnelStatus: vi.fn(async () => ({ providers: PROVIDERS, tunnels: [...tunnels] })),
    tunnelStart: vi.fn(async (port: number) => {
      calls.push(`start:${port}`);
      if (port === 4444) throw new HostRequestError("internal", "429 Too Many Requests");
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

function setup() {
  const live = fakeLive();
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

  test("message guard", () => {
    expect(isTunnelMessage({ type: "portlight:tunnel", op: "status" })).toBe(true);
    expect(isTunnelMessage({ type: "portlight:count" })).toBe(false);
    expect(isTunnelMessage(null)).toBe(false);
  });
});
