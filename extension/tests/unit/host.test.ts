import { describe, expect, it } from "vitest";
import { classifyNativeError, HostClient, HostConnectionError, HostRequestError, type Transport } from "../../src/lib/host.ts";

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
