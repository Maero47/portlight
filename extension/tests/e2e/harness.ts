import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { pinnedExtensionId } from "../../scripts/extension-id.mjs";

export const ORIGIN = "https://portlight.test";
export const DIST = resolve(import.meta.dirname, "../../dist");
export const SHOTS = resolve(import.meta.dirname, "../../screenshots");

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".json": "application/json",
};

export type Scenario = "list" | "empty" | "missing" | "forbidden";
export const PINNED_ID = pinnedExtensionId();

/** Serve the built extension from a fake origin and stub chrome.* with a mocked native host. */
export async function openPopup(
  page: Page,
  opts: { scenario?: Scenario; scheme?: "light" | "dark"; httpPorts?: Record<number, string>; id?: string } = {},
) {
  const { scenario = "list", scheme = "light", httpPorts = {}, id = PINNED_ID } = opts;
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/$/, "/popup.html");
    const file = resolve(DIST, `.${path}`);
    if (!file.startsWith(DIST) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
  });
  // HTTP fallback probes: only the ports in `httpPorts` answer.
  await page.route(/^http:\/\/localhost:\d+\//, (route) => {
    const port = Number(new URL(route.request().url()).port);
    const title = httpPorts[port];
    if (title === undefined) return route.abort("connectionrefused");
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "access-control-allow-origin": "*" },
      body: `<!doctype html><title>${title}</title>`,
    });
  });

  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.addInitScript(mockChrome, { scenario, id });
  await page.goto(`${ORIGIN}/popup.html`);
  return { errors };
}

/** Runs in the page. Keep it self-contained. */
function mockChrome({ scenario, id }: { scenario: Scenario; id: string }) {
  const now = Date.now();
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const L = (port: number, address: string, process: string, pid: number, cwd: string | null, command: string, startedMin: number) => ({
    port, address, family: address.includes(":") ? "IPv6" : "IPv4", pid, process, command, cwd, user: "mali", startedAt: ago(startedMin),
  });
  let listeners =
    scenario === "list"
      ? [
          L(3000, "127.0.0.1", "node", 48211, "/Users/mali/code/storefront", "node /Users/mali/code/storefront/node_modules/.bin/next dev", 134),
          L(3000, "::1", "node", 48211, "/Users/mali/code/storefront", "node /Users/mali/code/storefront/node_modules/.bin/next dev", 134),
          L(5173, "::1", "node", 51877, "/Users/mali/code/portlight/extension", "node /Users/mali/code/portlight/extension/node_modules/.bin/vite", 12),
          L(5432, "127.0.0.1", "postgres", 712, "/opt/homebrew/var/postgresql@16", "/opt/homebrew/opt/postgresql@16/bin/postgres -D /opt/homebrew/var/postgresql@16", 4410),
          L(6006, "0.0.0.0", "node", 50120, "/Users/mali/code/design-system", "node node_modules/.bin/storybook dev -p 6006", 47),
          L(6379, "127.0.0.1", "redis-server", 709, "/", "/opt/homebrew/opt/redis/bin/redis-server 127.0.0.1:6379", 4410),
          L(8000, "0.0.0.0", "python3.12", 52004, "/Users/mali/code/ledger/api", "/Users/mali/code/ledger/.venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0", 5),
          L(8787, "127.0.0.1", "workerd", 52990, "/Users/mali/code/edge-cache", "/Users/mali/code/edge-cache/node_modules/@cloudflare/workerd/bin/workerd serve", 0.4),
        ]
      : [];
  const opened: string[] = [];
  (window as any).__opened = opened;
  (window as any).__requests = [];
  (window as any).__spawns = [];
  const failure =
    scenario === "missing"
      ? "Specified native messaging host not found."
      : scenario === "forbidden"
        ? "Access to the specified native messaging host is forbidden."
        : null;
  const answer = (msg: any): any => {
    (window as any).__requests.push(msg);
    const busy = new Set(listeners.map((l) => l.port));
    let res: any;
    switch (msg.type) {
      case "ping":
        res = { type: "pong", version: 1, platform: "darwin", hostVersion: "0.1.0" };
        break;
      case "list":
        res = { type: "list", listeners, scannedAt: new Date().toISOString() };
        break;
      case "check":
        res = {
          type: "check",
          results: msg.ports.map((p: number) => ({ port: p, free: !busy.has(p), listener: listeners.find((l) => l.port === p) })),
        };
        break;
      case "suggest": {
        const out: number[] = [];
        for (let p = msg.near ?? 3000; out.length < (msg.count ?? 1); p++) if (!busy.has(p)) out.push(p);
        res = { type: "suggest", ports: out };
        break;
      }
      case "kill":
        listeners = listeners.filter((l) => l.pid !== msg.pid);
        res = { type: "kill", pid: msg.pid };
        break;
    }
    return { id: msg.id, ok: true, ...res };
  };
  const runtime: any = {
    id,
    lastError: undefined,
    sendNativeMessage(_host: string, msg: any, cb: (r: any) => void) {
      (window as any).__spawns.push("sendNativeMessage");
      setTimeout(() => {
        if (failure) {
          runtime.lastError = { message: failure };
          cb(undefined);
          runtime.lastError = undefined;
          return;
        }
        cb(answer(msg));
      }, 15);
    },
    connectNative(_host: string) {
      (window as any).__spawns.push("connectNative");
      const onMsg: ((m: any) => void)[] = [];
      const onDisc: (() => void)[] = [];
      let open = true;
      const drop = () => {
        if (!open) return;
        open = false;
        runtime.lastError = { message: failure };
        onDisc.forEach((f) => f());
        runtime.lastError = undefined;
      };
      if (failure) setTimeout(drop, 15);
      return {
        onMessage: { addListener: (f: (m: any) => void) => onMsg.push(f) },
        onDisconnect: { addListener: (f: () => void) => onDisc.push(f) },
        postMessage(msg: any) {
          if (!open) throw new Error("Attempting to use a disconnected port object");
          if (failure) return;
          setTimeout(() => open && onMsg.forEach((f) => f(answer(msg))), 15);
        },
        disconnect() {
          open = false;
        },
      };
    },
  };
  const chromeStub = {
    runtime,
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { create: async (o: { url: string }) => void opened.push(o.url) },
  };
  Object.defineProperty(window, "chrome", { value: chromeStub, configurable: true, writable: true });
}
