import { describe, expect, test } from "vitest";
import { fetchPageMeta, iconLinks, loadMetaCache, meaningfulTitle, META_TTL_MS, metaKey, saveMetaCache, sameOriginUrl, type PageMeta } from "../../src/lib/meta.ts";

type Route = { status?: number; type?: string; body: string | Uint8Array };
function fakeFetch(routes: Record<string, Route>, log: string[] = []) {
  return async (url: string, init: RequestInit) => {
    log.push(url);
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    const r = routes[url];
    if (!r) throw new TypeError("Failed to fetch");
    return new Response(r.body as BodyInit, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html" } });
  };
}

describe("page meta", () => {
  test("title and <link rel=icon>, preferring SVG", async () => {
    const log: string[] = [];
    const m = await fetchPageMeta(
      5173,
      fakeFetch(
        {
          "http://localhost:5173/": {
            body: `<html><head><title>Harbor &amp; Co</title><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" type="image/svg+xml" href="/vite.svg"></head>`,
          },
          "http://localhost:5173/vite.svg": { type: "image/svg+xml", body: "<svg/>" },
        },
        log,
      ),
      500,
      42,
    );
    expect(m).toEqual({ title: "Harbor & Co", icon: `data:image/svg+xml;base64,${btoa("<svg/>")}`, at: 42 });
    expect(log).toEqual(["http://localhost:5173/", "http://localhost:5173/vite.svg"]);
  });

  test("falls back to /favicon.ico; SPA index.html answers are not icons", async () => {
    const log: string[] = [];
    const m = await fetchPageMeta(
      3000,
      fakeFetch(
        {
          "http://localhost:3000/": { body: `<title>Shop</title><link rel=icon href=/missing.png>` },
          "http://localhost:3000/missing.png": { body: "<!doctype html><title>Shop</title>" },
          "http://localhost:3000/favicon.ico": { type: "image/x-icon", body: new Uint8Array([0, 0, 1, 0]) },
        },
        log,
      ),
    );
    expect(m.icon).toBe("data:image/x-icon;base64,AAABAA==");
    expect(log).toEqual(["http://localhost:3000/", "http://localhost:3000/missing.png", "http://localhost:3000/favicon.ico"]);
  });

  test("a server that isn't HTTP, or refuses, gives nulls and never throws", async () => {
    const m = await fetchPageMeta(5432, fakeFetch({}));
    expect([m.title, m.icon]).toEqual([null, null]);
  });

  test("oversized icons and icons on other origins are skipped", async () => {
    const big = new Uint8Array(30 * 1024);
    const log: string[] = [];
    const m = await fetchPageMeta(
      8000,
      fakeFetch(
        {
          "http://localhost:8000/": { body: `<link rel="icon" href="https://cdn.example.com/x.png">` },
          "http://localhost:8000/favicon.ico": { type: "image/png", body: big },
        },
        log,
      ),
    );
    expect(m.icon).toBeNull();
    expect(log.some((u) => u.includes("example.com"))).toBe(false);
  });

  test("iconLinks and sameOriginUrl", () => {
    expect(iconLinks(`<link href='/a.png' rel='shortcut icon'><link rel=icon href=/b.svg>`)).toEqual(["/b.svg", "/a.png"]);
    expect(sameOriginUrl("favicon.png", 3000)).toBe("http://localhost:3000/favicon.png");
    expect(sameOriginUrl("//evil.test/x.ico", 3000)).toBeNull();
    expect(sameOriginUrl("http://localhost:3001/x.ico", 3000)).toBeNull();
    expect(sameOriginUrl("data:image/png;base64,AA==", 3000)).toBe("data:image/png;base64,AA==");
  });

  test("meaningfulTitle drops starter templates and repeats", () => {
    for (const t of ["Vite + React + TS", "Vite App", "React App", "Create Next App", "Document", "localhost:3000", "404: Not Found", "  ", null]) {
      expect(meaningfulTitle(t), String(t)).toBeNull();
    }
    expect(meaningfulTitle("storefront", "Storefront")).toBeNull();
    expect(meaningfulTitle("Storefront — Spring  Collection", "storefront")).toBe("Storefront — Spring Collection");
  });

  test("cache keeps fresh entries only, newest first, capped", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const now = 10 * META_TTL_MS;
    const cache = new Map<string, PageMeta>();
    for (let i = 0; i < 50; i++) cache.set(metaKey(3000 + i, i), { title: `t${i}`, icon: null, at: now - i * 1000 });
    cache.set(metaKey(9999, null), { title: "old", icon: null, at: now - META_TTL_MS - 1 });
    saveMetaCache(cache, storage);
    const back = loadMetaCache(storage, now);
    expect(back.size).toBe(40);
    expect(back.has("3000:0")).toBe(true);
    expect(back.has("9999:http")).toBe(false);
    expect(loadMetaCache({ getItem: () => "not json" })).toEqual(new Map());
  });
});
