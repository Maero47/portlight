import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { pinnedExtensionId } from "../../scripts/extension-id.mjs";

export const ORIGIN = "https://portlight.test";
/** PORTLIGHT_DIST lets the perf runs serve another build (e.g. a baseline) through the same mocks. */
export const DIST = process.env.PORTLIGHT_DIST ?? resolve(import.meta.dirname, "../../dist");
export const SHOTS = resolve(import.meta.dirname, "../../screenshots");

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".json": "application/json",
};

export type Scenario = "list" | "empty" | "missing" | "forbidden";
export interface MockTab {
  url: string;
  title: string;
  windowId?: number;
}
export interface MockOptions {
  scenario: Scenario;
  id: string;
  settings?: Record<string, unknown>;
  tabs?: MockTab[];
  /** Answer reveal/openEditor like a host from before those requests existed. */
  oldHost?: boolean;
  /** Pretend a process comes straight back after Quit (launchd / brew services). */
  respawn?: number[];
  /** What the background worker reports about share links. */
  tunnel?: MockTunnel;
  /** LAN addresses for netinfo; null = a helper that doesn't know netinfo. */
  lan?: { name: string; address: string; family: "IPv4" | "IPv6"; virtual: boolean }[] | null;
  /** Extra chrome.storage.local entries, e.g. an earlier "Not now" on the install sheet. */
  local?: Record<string, unknown>;
}
export interface MockTunnel {
  providers?: { cloudflared: boolean; ngrok: boolean };
  /** Already running (or still starting, url null) when the popup opens. */
  running?: { port: number; url: string | null; state?: "starting" | "running" }[];
  /** start: answer with this URL (default), or fail with this message. */
  startError?: string;
  startDelayMs?: number;
}
export const PINNED_ID = pinnedExtensionId();

/**
 * Screenshot tests run with Reduce Motion on, where the popup still fades (short CSS transitions:
 * focus rings, hover). Turning transitions off makes every shot land on the settled frame instead
 * of somewhere in a 140 ms fade, so re-running the suite doesn't churn the PNGs.
 */
export async function settleTransitions(page: Page) {
  await page.addInitScript(() => {
    const css = "*, *::before, *::after { transition: none !important; }";
    const add = () => {
      const style = document.createElement("style");
      style.dataset.test = "settle";
      style.textContent = css;
      (document.head ?? document.documentElement).append(style);
    };
    if (document.documentElement) add();
    else document.addEventListener("DOMContentLoaded", add, { once: true });
  });
}

/** Serve the built extension from a fake origin and stub chrome.* with a mocked native host. */
export async function openPopup(
  page: Page,
  opts: {
    scenario?: Scenario;
    scheme?: "light" | "dark";
    httpPorts?: Record<number, string>;
    id?: string;
    settings?: Record<string, unknown>;
    tabs?: MockTab[];
    oldHost?: boolean;
    respawn?: number[];
    tunnel?: MockTunnel;
    lan?: MockOptions["lan"];
    local?: MockOptions["local"];
    /** Favicons (SVG markup) per port, linked from the page that port serves. */
    favicons?: Record<number, string>;
    /** Screenshots and most tests run with Reduce Motion on, so nothing is caught mid-animation. */
    reducedMotion?: "reduce" | "no-preference";
  } = {},
) {
  const { scenario = "list", scheme = "light", httpPorts = {}, id = PINNED_ID, settings, tabs, oldHost, respawn, tunnel, favicons = {}, reducedMotion = "reduce" } = opts;
  const lan = opts.lan === undefined ? [{ name: "en0", address: "192.168.1.23", family: "IPv4" as const, virtual: false }] : opts.lan;
  const errors: string[] = [];
  page.on("console", (m) => {
    // Chrome logs every refused or failed fetch itself (favicon lookups, HTTP probes); JS cannot silence those.
    if (m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(m.text());
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
    const url = new URL(route.request().url());
    const port = Number(url.port);
    // Playwright can't intercept /favicon.ico itself, so mocked pages link their icon (unit tests cover /favicon.ico).
    if (url.pathname === "/icon.svg" && favicons[port]) {
      return route.fulfill({ status: 200, contentType: "image/svg+xml", headers: { "access-control-allow-origin": "*" }, body: favicons[port] });
    }
    const title = httpPorts[port];
    if (title === undefined) return route.abort("connectionrefused");
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "access-control-allow-origin": "*" },
      body: `<!doctype html><title>${title}</title>${favicons[port] ? `<link rel="icon" href="/icon.svg">` : ""}`,
    });
  });

  await page.emulateMedia({ colorScheme: scheme, reducedMotion });
  if (reducedMotion === "reduce") await settleTransitions(page);
  await page.addInitScript(mockChrome, { scenario, id, settings, tabs, oldHost, respawn, tunnel, lan, local: opts.local } satisfies MockOptions);
  await page.goto(`${ORIGIN}/popup.html`);
  return { errors };
}

/** Runs in the page. Keep it self-contained. */
function mockChrome({ scenario, id, settings, tabs = [], oldHost = false, respawn = [], tunnel = {}, lan = [], local = {} }: MockOptions) {
  const now = Date.now();
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const L = (port: number, address: string, process: string, pid: number, cwd: string | null, command: string, startedMin: number, container: any = undefined) => ({
    port, address, family: address.includes(":") ? "IPv6" : "IPv4", pid, process, command, cwd, user: "mali", startedAt: ago(startedMin),
    ...(container ? { container } : {}),
  });
  const DOCKER = "/Applications/Docker.app/Contents/MacOS/com.docker.backend";
  const full = () => [
          L(3000, "127.0.0.1", "node", 48211, "/Users/mali/code/storefront", "node /Users/mali/code/storefront/node_modules/.bin/next dev", 134),
          L(3000, "::1", "node", 48211, "/Users/mali/code/storefront", "node /Users/mali/code/storefront/node_modules/.bin/next dev", 134),
          L(5173, "::1", "node", 51877, "/Users/mali/code/portlight/extension", "node /Users/mali/code/portlight/extension/node_modules/.bin/vite", 12),
          L(5432, "127.0.0.1", "postgres", 712, "/opt/homebrew/var/postgresql@16", "/opt/homebrew/opt/postgresql@16/bin/postgres -D /opt/homebrew/var/postgresql@16", 4410),
          L(6006, "0.0.0.0", "node", 50120, "/Users/mali/code/design-system", "node node_modules/.bin/storybook dev -p 6006", 60 * 26),
          L(6379, "127.0.0.1", "redis-server", 709, "/", "/opt/homebrew/opt/redis/bin/redis-server 127.0.0.1:6379", 4410),
          L(8000, "0.0.0.0", "python3.12", 52004, "/Users/mali/code/ledger/api", "/Users/mali/code/ledger/.venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0", 5),
          L(8787, "127.0.0.1", "workerd", 52990, "/Users/mali/code/edge-cache", "/Users/mali/code/edge-cache/node_modules/@cloudflare/workerd/bin/workerd serve", 0.4),
          // Not yours: macOS services (hidden by default), a desktop app helper, Docker containers.
          L(5000, "*", "ControlCenter", 611, "/", "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter", 6000),
          L(7000, "*", "ControlCenter", 611, "/", "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter", 6000),
          L(49163, "*", "rapportd", 604, "/", "/usr/libexec/rapportd", 6000),
          L(44950, "127.0.0.1", "figma_agent", 1290, "/", "/Applications/Figma Agent.app/Contents/MacOS/figma_agent", 3000),
          L(5433, "127.0.0.1", "com.docker.backend", 1402, null, DOCKER, 300, {
            id: "8f2c1a", name: "shop-db-1", image: "postgres:16-alpine", project: "shop", containerPort: 5432, workingDir: "/Users/mali/code/shop",
          }),
          L(6380, "127.0.0.1", "com.docker.backend", 1402, null, DOCKER, 300, {
            id: "41be07", name: "shop-cache-1", image: "redis:7", project: "shop", containerPort: 6379, workingDir: "/Users/mali/code/shop",
          }),
        ];
  let listeners = scenario === "list" ? full() : [];
  // Lets a test change what the "host" reports, e.g. a server restarting under a new pid.
  (window as any).__mutate = (fn: (l: any[]) => any[]) => void (listeners = fn(listeners));
  const opened: string[] = [];
  (window as any).__opened = opened;
  (window as any).__requests = [];
  (window as any).__spawns = [];
  let failure =
    scenario === "missing"
      ? "Specified native messaging host not found."
      : scenario === "forbidden"
        ? "Access to the specified native messaging host is forbidden."
        : null;
  // "Run the installer": from now on the host answers with the full list.
  (window as any).__install = () => {
    failure = null;
    listeners = full();
  };
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
      case "kill": {
        const gone = listeners.filter((l) => l.pid === msg.pid);
        listeners = listeners.filter((l) => l.pid !== msg.pid);
        // Respawned processes come back under a new PID, like launchd's KeepAlive.
        for (const l of gone) if (respawn.includes(l.port)) listeners.push({ ...l, pid: l.pid + 1000, startedAt: new Date().toISOString() });
        res = { type: "kill", pid: msg.pid, killed: [msg.pid] };
        break;
      }
      case "reveal":
      case "openEditor":
        if (oldHost) return { id: msg.id, ok: false, error: { code: "bad_request", message: `unknown request type: "${msg.type}"` } };
        res = { type: msg.type, path: listeners.find((l) => l.pid === msg.pid)?.cwd ?? "/" };
        break;
      case "netinfo":
        if (oldHost || lan === null) return { id: msg.id, ok: false, error: { code: "bad_request", message: `unknown request type: "${msg.type}"` } };
        res = { type: "netinfo", hostname: "studio.local", addresses: lan };
        break;
      case "openSettings":
        if (oldHost) return { id: msg.id, ok: false, error: { code: "bad_request", message: `unknown request type: "${msg.type}"` } };
        res = { type: "openSettings", pane: msg.pane };
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
  // chrome.storage (local + sync) with change events, so the popup's settings round-trip like the real thing.
  const store: Record<string, any> = { ...local, ...(settings ? { "portlight.settings": { version: 1, ...settings } } : {}) };
  const storageListeners: ((changes: any, area: string) => void)[] = [];
  (window as any).__store = store;
  const badges: string[] = [];
  (window as any).__badges = badges;
  const focused: any[] = [];
  (window as any).__focused = focused;
  (window as any).__optionsOpened = 0;
  let tabList = tabs.map((t, i) => ({ id: 100 + i, windowId: t.windowId ?? 1, url: t.url, title: t.title, active: false, lastAccessed: now - i * 1000 }));
  (window as any).__tabs = () => tabList;
  runtime.openOptionsPage = async () => void ((window as any).__optionsOpened += 1);
  // The background worker's share-link service, as the popup sees it through sendMessage.
  const providers = tunnel.providers ?? { cloudflared: true, ngrok: false };
  let running = (tunnel.running ?? []).map((t) => ({ state: "running", ...t, provider: "cloudflared", startedAt: new Date(now).toISOString() }));
  const tunnelMsgs: any[] = [];
  (window as any).__tunnelMsgs = tunnelMsgs;
  runtime.sendMessage = async (msg: any) => {
    if (msg?.type !== "portlight:tunnel") return undefined;
    tunnelMsgs.push(msg);
    if (msg.op === "start") {
      await new Promise((r) => setTimeout(r, tunnel.startDelayMs ?? 30));
      if (tunnel.startError) return { ok: false, code: "internal", message: tunnel.startError };
      running = [
        ...running,
        { port: msg.port, url: "https://quiet-harbor-lights.trycloudflare.com", state: "running", provider: "cloudflared", startedAt: new Date().toISOString() },
      ];
    } else if (msg.op === "stop") {
      running = running.filter((t) => t.port !== msg.port);
    }
    return { ok: true, providers: msg.op === "status" ? null : providers, tunnels: running };
  };
  const noopEvent = { addListener() {}, removeListener() {} };
  function area(data: Record<string, any>, name: string) {
    return {
      get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (items: Record<string, any>) => {
        const changes: any = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
          data[k] = structuredClone(v);
        }
        setTimeout(() => storageListeners.forEach((f) => f(changes, name)), 0);
      },
      remove: async (key: string) => {
        const changes = { [key]: { oldValue: data[key] } };
        delete data[key];
        setTimeout(() => storageListeners.forEach((f) => f(changes, name)), 0);
      },
    };
  }
  const chromeStub = {
    runtime,
    action: { setBadgeText: async (o: { text: string }) => void badges.push(o.text), setBadgeBackgroundColor: async () => {} },
    storage: {
      // Settings live in chrome.storage.local; sync is kept (empty) for the one-time migration read.
      local: area(store, "local"),
      sync: area({}, "sync"),
      onChanged: {
        addListener: (f: any) => storageListeners.push(f),
        removeListener: (f: any) => storageListeners.splice(storageListeners.indexOf(f), 1),
      },
    },
    tabs: {
      create: async (o: { url: string }) => void opened.push(o.url),
      // Real Chrome filters by the URL patterns; the mock keeps localhost, 127.0.0.1, [::1] and *.localhost.
      query: async (q: { url?: string[] }) =>
        tabList.filter((t) => !q.url || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)[:/]/.test(t.url)).map((t) => ({ ...t })),
      update: async (tabId: number, props: any) => void focused.push({ tabId, ...props }),
      remove: async (ids: number[]) => {
        tabList = tabList.filter((t) => !ids.includes(t.id));
      },
      onUpdated: noopEvent,
      onRemoved: noopEvent,
      onCreated: noopEvent,
    },
    windows: { update: async (windowId: number, props: any) => void focused.push({ windowId, ...props }) },
  };
  Object.defineProperty(window, "chrome", { value: chromeStub, configurable: true, writable: true });
}
