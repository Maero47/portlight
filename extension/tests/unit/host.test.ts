import { afterEach, describe, expect, it } from "vitest";
import { classifyNativeError, HostClient, HostConnectionError, HostRequestError, portTransport, type Transport } from "../../src/lib/host.ts";

describe("classifyNativeError", () => {
  it.each([
    ["Specified native messaging host not found.", "missing"],
    ["Access to the specified native messaging host is forbidden.", "forbidden"],
    ["Native host has exited.", "crashed"],
    ["Error when communicating with the native messaging host.", "crashed"],
    [undefined, "unavailable"],
  ])("%s → %s", (msg, kind) => expect(classifyNativeError(msg)).toBe(kind));
});

describe("HostClient", () => {
  it("adds ids and returns ok responses", async () => {
    const seen: string[] = [];
    const t: Transport = async (m) => {
      seen.push(m.id);
      return { id: m.id, ok: true, type: "suggest", ports: [3001] };
    };
    const c = new HostClient(t);
    expect((await c.suggest(3000)).ports).toEqual([3001]);
    await c.suggest(3000);
    expect(new Set(seen).size).toBe(2);
  });
  it("turns { ok: false } into HostRequestError", async () => {
    const t: Transport = async (m) => ({ id: m.id, ok: false, error: { code: "not_permitted", message: "nope" } });
    await expect(new HostClient(t).kill(1)).rejects.toMatchObject({ name: "HostRequestError", code: "not_permitted" });
    await expect(new HostClient(t).kill(1)).rejects.toBeInstanceOf(HostRequestError);
  });
  it("times out", async () => {
    const t: Transport = () => new Promise(() => {});
    await expect(new HostClient(t, 20).list()).rejects.toMatchObject({ kind: "timeout" });
  });
  it("reports unavailable outside an extension", async () => {
    await expect(new HostClient().ping()).rejects.toBeInstanceOf(HostConnectionError);
  });
});

/** Minimal stand-in for chrome.runtime.connectNative. */
function fakeChrome(reply: (msg: any, port: FakePort) => void) {
  const ports: FakePort[] = [];
  const runtime: any = {
    lastError: undefined,
    connectNative: () => {
      const port = new FakePort(runtime, reply);
      ports.push(port);
      return port;
    },
  };
  (globalThis as any).chrome = { runtime };
  return { runtime, ports };
}

class FakePort {
  msgL: ((m: any) => void)[] = [];
  discL: (() => void)[] = [];
  sent: any[] = [];
  disconnected = false;
  onMessage = { addListener: (f: (m: any) => void) => this.msgL.push(f) };
  onDisconnect = { addListener: (f: () => void) => this.discL.push(f) };
  constructor(private runtime: any, private reply: (msg: any, port: FakePort) => void) {}
  postMessage(m: any) {
    this.sent.push(m);
    queueMicrotask(() => this.reply(m, this));
  }
  respond(m: any) {
    for (const f of this.msgL) f(m);
  }
  /** The host went away, with an optional chrome.runtime.lastError message. */
  drop(message?: string) {
    this.runtime.lastError = message ? { message } : undefined;
    for (const f of this.discL) f();
    this.runtime.lastError = undefined;
  }
  disconnect() {
    this.disconnected = true;
  }
}

describe("portTransport", () => {
  afterEach(() => delete (globalThis as any).chrome);

  it("reuses one host process and matches responses by id, even out of order", async () => {
    const held: any[] = [];
    const { ports } = fakeChrome((m, port) => {
      held.push(m);
      const answer = (x: any) => port.respond({ id: x.id, ok: true, type: "suggest", ports: [Number(x.near)] });
      if (held.length === 2) [...held].reverse().forEach(answer);
      if (held.length > 2) answer(m);
    });
    const c = new HostClient(portTransport());
    const [a, b] = await Promise.all([c.suggest(3000), c.suggest(4000)]);
    expect(a.ports).toEqual([3000]);
    expect(b.ports).toEqual([4000]);
    expect((await c.suggest(5000)).ports).toEqual([5000]); // still the same port
    expect(ports).toHaveLength(1);
    expect(ports[0]!.sent).toHaveLength(3);
  });

  it("rejects in-flight requests when the host is missing, then reconnects", async () => {
    let first = true;
    const { ports } = fakeChrome((m, port) => {
      if (first) {
        first = false;
        port.drop("Specified native messaging host not found.");
      } else port.respond({ id: m.id, ok: true, type: "pong", version: 1, platform: "darwin", hostVersion: "0.1.0" });
    });
    const c = new HostClient(portTransport());
    await expect(c.list()).rejects.toMatchObject({ name: "HostConnectionError", kind: "missing" });
    await expect(c.ping()).resolves.toMatchObject({ type: "pong" });
    expect(ports).toHaveLength(2);
  });

  it("treats a silent disconnect as a crash", async () => {
    fakeChrome((_m, port) => port.drop());
    await expect(new HostClient(portTransport()).list()).rejects.toMatchObject({ kind: "crashed" });
  });

  it("drops a hung host after a timeout so the next request gets a fresh one", async () => {
    let n = 0;
    const { ports } = fakeChrome((m, port) => {
      if (n++ > 0) port.respond({ id: m.id, ok: true, type: "pong", version: 1, platform: "linux", hostVersion: "0.1.0" });
    });
    const c = new HostClient(portTransport(), 20);
    await expect(c.list()).rejects.toMatchObject({ kind: "timeout" });
    expect(ports[0]!.disconnected).toBe(true);
    await expect(c.ping()).resolves.toMatchObject({ type: "pong" });
    expect(ports).toHaveLength(2);
  });
});
