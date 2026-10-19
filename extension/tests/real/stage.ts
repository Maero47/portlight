// Helpers for tests that run the real extension against the real native host.
import { chromium, type BrowserContext, type Worker } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { projectFromCwd } from "../../src/lib/shape.ts";

export const EXT = resolve(import.meta.dirname, "../..");
export const ROOT = resolve(EXT, "..");
export const DIST = join(EXT, "dist");

/** Chromium's per-user profile dir inside a HOME, as host/scripts/browsers.sh knows it. */
function chromiumDir(home: string): string {
  return process.platform === "darwin"
    ? join(home, "Library/Application Support/Chromium")
    : join(home, ".config/chromium");
}

export interface Installed {
  home: string;
  /** Profile dir with NativeMessagingHosts/com.portlight.host.json in it. */
  userDataDir: string;
  output: string;
  cleanup(): void;
}

/**
 * Run the real ./install.sh against a throwaway HOME. Its Chromium profile dir doubles as
 * the browser's user data dir, and Chromium reads native host manifests from
 * <user-data-dir>/NativeMessagingHosts — so this is the same path a user's browser takes.
 */
export function installIntoTempHome(): Installed {
  const home = mkdtempSync(join(tmpdir(), "portlight-home-"));
  const userDataDir = chromiumDir(home);
  mkdirSync(userDataDir, { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  const output = execFileSync(join(ROOT, "install.sh"), [], { cwd: tmpdir(), env, encoding: "utf8" });
  return { home, userDataDir, output, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function hostManifest(userDataDir: string): { path: string; allowed_origins: string[] } {
  return JSON.parse(readFileSync(join(userDataDir, "NativeMessagingHosts/com.portlight.host.json"), "utf8"));
}

export async function launch(userDataDir: string): Promise<{ context: BrowserContext; worker: Worker; id: string }> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 360, height: 540 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  return { context, worker, id: new URL(worker.url()).host };
}

/** A port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

/** True when nothing accepts connections on the port (IPv4 or IPv6 loopback). */
export async function isFree(port: number): Promise<boolean> {
  const answers = (host: string) =>
    new Promise<boolean>((res) => {
      const c = connect({ port, host });
      c.once("connect", () => (c.destroy(), res(true)));
      c.once("error", () => res(false));
    });
  return !(await answers("127.0.0.1")) && !(await answers("::1"));
}

async function waitListening(port: number, host: string, child: ChildProcess, ms = 10_000) {
  const until = Date.now() + ms;
  const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server for :${port} exited with ${child.exitCode}`);
    const up = await new Promise<boolean>((res) => {
      const c = connect({ port, host: target });
      c.once("connect", () => (c.destroy(), res(true)));
      c.once("error", () => res(false));
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nothing listening on ${host}:${port}`);
}

export interface Server {
  port: number;
  pid: number;
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): void;
}

/**
 * Scratch space for fake projects. The popup shows no project for system paths such as
 * /private/var or /tmp on macOS, so use the checkout if it lives somewhere ordinary,
 * otherwise ~/.cache.
 */
export function projectsRoot(): { dir: string; cleanup(): void } {
  const inRepo = join(EXT, ".real-e2e");
  const base = projectFromCwd(join(inRepo, "probe")) === "probe" ? inRepo : join(homedir(), ".cache/portlight-e2e");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "run-"));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      try {
        rmdirSync(base); // only if no other run is using it
      } catch {}
    },
  };
}

const NODE_SERVER = `#!/usr/bin/env node
// Dynamic import works whether node treats this file as CommonJS or ESM.
import("node:http").then((http) => {
  http.createServer((_, res) => res.end("ok")).listen(Number(process.env.PORT), process.env.HOST);
});
process.on("SIGTERM", () => process.exit(0));
`;

const PY_SERVER = `import http.server, os, signal, sys
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
http.server.ThreadingHTTPServer((os.environ["HOST"], int(os.environ["PORT"])), http.server.SimpleHTTPRequestHandler).serve_forever()
`;

/**
 * Start a real HTTP server as its own process, looking like a dev tool:
 * `bin` is where its "binary" lives inside the project (e.g. node_modules/.bin/vite),
 * so the command line, cwd and process name are what a real one would report.
 */
export async function startServer(opts: {
  root: string;
  project: string;
  bin: string;
  args?: string[];
  port: number;
  host?: string;
  runtime?: "node" | "python3";
}): Promise<Server> {
  const { root, project, bin, args = [], port, host = "127.0.0.1", runtime = "node" } = opts;
  const cwd = join(root, project);
  const script = join(cwd, bin);
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, runtime === "node" ? NODE_SERVER : PY_SERVER);
  chmodSync(script, 0o755);
  const child = spawn(runtime === "node" ? process.execPath : "python3", [script, ...args], {
    cwd,
    env: { ...process.env, PORT: String(port), HOST: host },
    stdio: "ignore",
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
    child.once("exit", (code, signal) => res({ code, signal })),
  );
  await waitListening(port, host, child);
  return { port, pid: child.pid!, child, exited, stop: () => void child.kill("SIGKILL") };
}
