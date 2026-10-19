import { describe, expect, it, vi } from "vitest";
import { COMMON_DEV_PORTS, extractTitle, probePort, probePorts, probeToRow, type Fetcher } from "../../src/lib/probe.ts";

const html = (title: string, status = 200) =>
  new Response(`<!doctype html><html><head><title>${title}</title></head><body>${"x".repeat(9000)}</body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

describe("COMMON_DEV_PORTS", () => {
  it("covers the usual suspects, sorted and unique", () => {
    for (const p of [3000, 3010, 4200, 5000, 5010, 5173, 5180, 8000, 8080, 8090, 8100, 8888, 9000]) expect(COMMON_DEV_PORTS).toContain(p);
    expect([...COMMON_DEV_PORTS].sort((a, b) => a - b)).toEqual(COMMON_DEV_PORTS);
    expect(new Set(COMMON_DEV_PORTS).size).toBe(COMMON_DEV_PORTS.length);
  });
});

describe("extractTitle", () => {
  it("decodes entities and collapses whitespace", () =>
    expect(extractTitle("<title>\n  Tom &amp; Jerry&#39;s   app </title>")).toBe("Tom & Jerry's app"));
  it("returns null without a title", () => {
    expect(extractTitle("<html></html>")).toBeNull();
    expect(extractTitle("<title>   </title>")).toBeNull();
  });
});

describe("probePort", () => {
  it("treats any HTTP response as open and reads the title", async () => {
    const fetcher: Fetcher = async () => html("Shop", 404);
    expect(await probePort(3000, fetcher)).toEqual({ port: 3000, open: true, status: 404, title: "Shop" });
  });
  it("treats network errors as closed", async () => {
    const fetcher: Fetcher = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await probePort(3000, fetcher)).toEqual({ port: 3000, open: false });
  });
  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const fetcher: Fetcher = (_url, init) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const p = probePort(8080, fetcher, 500);
    await vi.advanceTimersByTimeAsync(501);
    expect(await p).toEqual({ port: 8080, open: false });
    vi.useRealTimers();
  });
  it("does not read bodies of non-HTML responses", async () => {
    const fetcher: Fetcher = async () => new Response("{}", { headers: { "content-type": "application/json" } });
    expect(await probePort(9000, fetcher)).toMatchObject({ open: true, title: null });
  });
  it("requests localhost without credentials", async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(""));
    await probePort(5173, fetcher);
    expect(fetcher.mock.calls[0]![0]).toBe("http://localhost:5173/");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: "omit", cache: "no-store" });
  });
});

describe("probePorts", () => {
  it("respects the concurrency limit and reports open ports as they appear", async () => {
    let active = 0;
    let peak = 0;
    const open = new Set([3000, 5173]);
    const fetcher: Fetcher = async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      const port = Number(new URL(url).port);
      if (!open.has(port)) throw new TypeError("refused");
      return new Response("ok");
    };
    const seen: number[] = [];
    const results = await probePorts([3000, 3001, 3002, 5173, 8000], { fetcher, concurrency: 2, onOpen: (r) => seen.push(r.port) });
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.map((r) => r.open)).toEqual([true, false, false, true, false]);
    expect(seen.sort()).toEqual([3000, 5173]);
  });
  it("maps results to HTTP-only rows", () => {
    expect(probeToRow({ port: 3000, open: true, status: 200, title: "Shop" })).toMatchObject({
      key: "3000:http",
      source: "http",
      pid: null,
      title: "Shop",
      status: 200,
    });
  });
});
