// End to end against the real native host: ./install.sh into a temp HOME, the built
// extension in Chromium, real TCP servers, and the popup reading them back.
import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pinnedExtensionId } from "../../scripts/extension-id.mjs";
import {
  EXT,
  freePort,
  hostManifest,
  installIntoTempHome,
  isFree,
  launch,
  projectsRoot,
  startServer,
  type Installed,
  type Server,
} from "./stage.ts";

test.skip(!["darwin", "linux"].includes(process.platform), "install.sh is for macOS and Linux");
test.describe.configure({ mode: "serial" });

let installed: Installed;
let projects: ReturnType<typeof projectsRoot>;
let context: BrowserContext;
let worker: Worker;
let id: string;
let page: Page;
const errors: string[] = [];
const servers: Record<"vite" | "api" | "docs", Server> = {} as never;
// A stand-in for cloudflared on PATH: prints a quick-tunnel URL, records its argv and pid, runs until stopped.
let fakeBin: string;
const FAKE_URL = "https://real-e2e-quick-tunnel.trycloudflare.com";
const FAKE_DELAY_MS = 6000;
const fakeRun = () => JSON.parse(readFileSync(join(fakeBin, "run.json"), "utf8")) as { argv: string[]; pid: number };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ICO = Buffer.from(
  "AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAD/gDP/AAAAAA==",
  "base64",
);

test.beforeAll(async () => {
  test.setTimeout(180_000);
  installed = installIntoTempHome();
  projects = projectsRoot();
  const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()];
  servers.vite = await startServer({ root: projects.dir, project: "harbor-web", bin: "node_modules/.bin/vite", args: ["--port", String(p1)], port: p1 });
  servers.api = await startServer({ root: projects.dir, project: "shop/server", bin: "bin/serve", port: p2, host: "0.0.0.0" });
  servers.docs = await startServer({ root: projects.dir, project: "field-notes", bin: "serve_docs.py", args: ["http.server"], port: p3, runtime: "python3" });
  // The Python server serves its project folder: give it a page title and a real favicon.ico.
  writeFileSync(join(projects.dir, "field-notes", "index.html"), "<!doctype html><title>Field Notes — Trail Log</title><h1>Notes</h1>");
  writeFileSync(join(projects.dir, "field-notes", "favicon.ico"), ICO);
  fakeBin = mkdtempSync(join(tmpdir(), "portlight-fake-cf-"));
  writeFileSync(
    join(fakeBin, "cloudflared"),
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(join(fakeBin, "run.json"))}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }));
process.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\\n");
setTimeout(() => process.stderr.write("INF |  ${FAKE_URL}  |\\n"), Number(process.env.PORTLIGHT_FAKE_CF_DELAY_MS ?? 0));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  // Chromium passes its environment to the native host, which looks for cloudflared on PATH.
  process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;
  // Slower than the popup's 2 s refresh and the worker's 5 s poll, like a real quick tunnel.
  process.env.PORTLIGHT_FAKE_CF_DELAY_MS = String(FAKE_DELAY_MS);
  ({ context, worker, id } = await launch(installed.userDataDir));
  page = await context.newPage();
  // Chrome logs refused/failed fetches (favicon lookups) itself; JS cannot silence those.
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${id}/popup.html`);
});

test.afterAll(async () => {
  await context?.close();
  for (const s of Object.values(servers)) s?.stop();
  projects?.cleanup();
  installed?.cleanup();
  if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
});

const row = (port: number) => page.locator(`li.row[data-key^="${port}:"]`);

test("install.sh builds and registers the host for the pinned extension ID", async () => {
  expect(installed.output).toContain("verified   host answers ping");
  expect(installed.output).toContain(join(EXT, "dist"));
  expect(id).toBe(pinnedExtensionId());
  expect(hostManifest(installed.userDataDir).allowed_origins).toEqual([`chrome-extension://${id}/`]);
  expect(hostManifest(installed.userDataDir).path.startsWith(installed.home)).toBe(true);
});

test("the popup lists real servers with port, process and project", async () => {
  await expect(page.locator("#app")).toHaveAttribute("data-mode", "host");
  await expect(page.locator("#app")).toHaveAttribute("data-live", "on");
  await expect(page.locator("#status-text")).toHaveText(/^\d+ ports? in use$/);

  const vite = row(servers.vite.port);
  await expect(vite.locator(".port")).toHaveText(String(servers.vite.port));
  await expect(vite.locator(".name")).toHaveText("harbor-web");
  await expect(vite.locator(".tool")).toHaveText("Vite");
  await expect(vite.locator(".proc")).toHaveText("node");
  await expect(vite.locator(".scope")).toHaveClass(/local/);

  const api = row(servers.api.port);
  await expect(api.locator(".name")).toHaveText("shop/server");
  await expect(api.locator(".scope")).toHaveText("Network");
  await expect(api.locator(".proc")).toHaveText("node");

  const docs = row(servers.docs.port);
  await expect(docs.locator(".name")).toHaveText("field-notes");
  await expect(docs.locator(".row-main")).toHaveAttribute("aria-label", /python/i);

  // Each row is one process: the PID the host reports is the server we started.
  await expect(vite.locator(".row-main")).toHaveAttribute("aria-label", new RegExp(`PID ${servers.vite.pid}\\b`));
  await expect(vite.locator(".row-main")).toHaveAttribute("title", /node_modules\/\.bin\/vite/);
});

test("the toolbar badge counts busy ports from the real host", async () => {
  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  expect(Number(badge)).toBeGreaterThanOrEqual(3);
});

test("check: a busy port names its owner, a free port says free", async () => {
  await page.locator("#q").fill(String(servers.api.port));
  await expect(page.locator("#check")).toContainText(`Port ${servers.api.port} is in use`);
  await expect(page.locator("#check")).toContainText("shop/server");
  await expect(page.locator("#check")).toHaveAttribute("data-state", "used");

  const free = await freePort();
  await page.locator("#q").fill(String(free));
  await expect(page.locator("#check")).toContainText(`Port ${free} is free`);
  await expect(page.locator("#check")).toHaveAttribute("data-state", "free");

  // The host's own answer, not just the list: ask it directly over the same channel.
  const res = await page.evaluate(
    (ports) => new Promise<any>((r) => chrome.runtime.sendNativeMessage("com.portlight.host", { id: "c", type: "check", ports }, r)),
    [servers.api.port, free],
  );
  expect(res.results).toEqual([
    expect.objectContaining({ port: servers.api.port, free: false, listener: expect.objectContaining({ pid: servers.api.pid }) }),
    expect.objectContaining({ port: free, free: true }),
  ]);
});

test("suggest offers a port that is actually free", async () => {
  const near = servers.vite.port;
  await page.locator("#q").fill(String(near));
  await expect(page.locator("#suggest-label")).toHaveText(`Free near ${near}`);
  await expect(page.locator("#suggest-port")).toHaveText(/^\d+$/);
  const suggested = Number(await page.locator("#suggest-port").textContent());
  expect(suggested).not.toBe(near);
  expect(Math.abs(suggested - near)).toBeLessThan(50);
  expect(await isFree(suggested)).toBe(true);
  await page.locator("#q").fill("");
});

test("favicon and page title come from the real server", async () => {
  const docs = row(servers.docs.port);
  await expect(docs.locator(".favicon")).toBeVisible();
  await expect(docs.locator(".favicon")).toHaveAttribute("src", /^data:image\/(x-icon|vnd\.microsoft\.icon);base64,/);
  // The title replaces "python3" on the second line; the process stays in the label.
  await expect(docs.locator(".page-title")).toHaveText("Field Notes — Trail Log");
  // A server with no title or icon keeps the old look.
  await expect(row(servers.api.port).locator(".favicon")).toBeHidden();
  await expect(row(servers.api.port).locator(".proc")).toHaveText("node");
});

test("open on phone uses the host's real LAN address, or explains why not", async () => {
  const api = row(servers.api.port);
  await api.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Open on Phone…" }).click();
  const net = await page.evaluate(() => new Promise<any>((r) => chrome.runtime.sendNativeMessage("com.portlight.host", { id: "n", type: "netinfo" }, r)));
  expect(net.ok).toBe(true);
  if (net.addresses.length) {
    const best = net.addresses.find((a: any) => !a.virtual) ?? net.addresses[0];
    const host = best.address.includes(":") ? `[${best.address}]` : best.address;
    await expect(api.locator(".qr")).toBeVisible();
    await expect(api.locator(".url-line code")).toHaveText(`http://${host}:${servers.api.port}`);
  } else {
    await expect(api.locator(".confirm-text")).toContainText("isn’t on a network");
  }
  await api.getByRole("button", { name: /Done|OK/ }).click();
  // The Vite stand-in only listens on 127.0.0.1: no QR, the flag instead.
  const vite = row(servers.vite.port);
  await vite.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Open on Phone…" }).click();
  await expect(vite.locator(".cmd-line code")).toHaveText("--host");
  await expect(vite.locator(".qr")).toHaveCount(0);
  await vite.getByRole("button", { name: "Done" }).click();
});

test("share link: created through the background worker, survives the popup closing, stops on request", async () => {
  test.setTimeout(60_000);
  const api = row(servers.api.port);
  await api.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Share Public Link…" }).click();
  await expect(api.locator(".explain-lead")).toHaveText("Anyone with the link can open this server.");
  await api.getByRole("button", { name: "Create Link" }).click();
  await expect(api.locator(".confirm-text")).toHaveText("Creating a public link… This takes a few seconds.");
  // While the URL is pending, status questions (popup refreshes, the worker's poll) must see it
  // as starting, and must not close the helper that owns it.
  const states: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < FAKE_DELAY_MS - 1000) {
    const st = await page.evaluate(() => chrome.runtime.sendMessage({ type: "portlight:tunnel", op: "status" }));
    states.push(st.tunnels.map((t: any) => `${t.port}:${t.state}`).join() || "none");
    await new Promise((r) => setTimeout(r, 700));
  }
  expect(states.length).toBeGreaterThan(4);
  expect(new Set(states)).toEqual(new Set([`${servers.api.port}:starting`]));
  await expect(api.locator(".url-line code")).toHaveText(FAKE_URL, { timeout: 15_000 });
  await expect(api.locator(".shared")).toHaveText("Public");
  const run = fakeRun();
  expect(run.argv).toEqual(["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${servers.api.port}`, "--http-host-header", `127.0.0.1:${servers.api.port}`]);
  expect(alive(run.pid)).toBe(true);

  // Closing the popup (and its helper) leaves the tunnel running in the worker's helper.
  await page.close();
  await new Promise((r) => setTimeout(r, 1000));
  expect(alive(run.pid)).toBe(true);
  page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${id}/popup.html`);
  const again = row(servers.api.port);
  await expect(again.locator(".shared")).toHaveText("Public");

  await again.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Public Link…" }).click();
  await again.getByRole("button", { name: "Stop Sharing" }).click();
  await expect(again.locator(".shared")).toHaveCount(0);
  await expect.poll(() => alive(run.pid), { timeout: 5000 }).toBe(false);
});

test("kill quits a real process and the row goes away", async () => {
  const target = row(servers.vite.port);
  await target.hover();
  await target.locator('[data-act="kill"]').click();
  await expect(target.locator(".confirm-text")).toContainText("Quit node?");
  await target.getByRole("button", { name: "Quit", exact: true }).click();
  const { signal, code } = await servers.vite.exited;
  expect(signal === "SIGTERM" || code === 0).toBe(true);
  await expect(row(servers.vite.port)).toHaveCount(0);
  expect(await isFree(servers.vite.port)).toBe(true);
  await expect(row(servers.api.port)).toHaveCount(1);
});

test("the real host refuses to kill a process that is not listening", async () => {
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const res = await page.evaluate(
      (pid) => new Promise<any>((r) => chrome.runtime.sendNativeMessage("com.portlight.host", { id: "k", type: "kill", pid }, r)),
      sleeper.pid!,
    );
    // The host only signals a PID that owns a listening port right now.
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(sleeper.exitCode).toBeNull();
  } finally {
    sleeper.kill("SIGKILL");
  }
});

test("one connectNative port is faster than a process per request", async () => {
  test.setTimeout(90_000);
  const N = 10;
  const timings = await page.evaluate(async (n) => {
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const viaSend = (type: string) =>
      new Promise<void>((r) => chrome.runtime.sendNativeMessage("com.portlight.host", { id: "s", type }, () => r()));
    const port = chrome.runtime.connectNative("com.portlight.host");
    let next: (() => void) | null = null;
    port.onMessage.addListener(() => next?.());
    const viaPort = (type: string) =>
      new Promise<void>((r) => {
        next = r;
        port.postMessage({ id: "p", type });
      });
    await viaPort("ping"); // the port's one-time start-up is not per request
    const out: Record<string, number> = {};
    for (const type of ["ping", "list"]) {
      for (const [name, fn] of [["send", viaSend], ["port", viaPort]] as const) {
        const xs: number[] = [];
        for (let i = 0; i < n; i++) {
          // Past the host's 300 ms scan cache, like the popup's 2 s polling.
          await new Promise((r) => setTimeout(r, 350));
          const t = performance.now();
          await fn(type);
          xs.push(performance.now() - t);
        }
        out[`${type}.${name}`] = Math.round(median(xs) * 10) / 10;
      }
    }
    port.disconnect();
    return out;
  }, N);
  const dir = join(EXT, "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transport-timings.json"), JSON.stringify(timings, null, 2));
  console.log(`median ms over ${N} requests:`, JSON.stringify(timings));
  expect(timings["ping.port"]!).toBeLessThan(timings["ping.send"]!);
  expect(timings["list.port"]!).toBeLessThan(timings["list.send"]!);
});

test("the popup keeps one host process while open, and none after it closes", async () => {
  const hosts = () =>
    execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(installed.home) && l.includes("main.js"));
  await expect.poll(hosts).toHaveLength(1);
  expect(errors).toEqual([]);
  await page.close();
  await expect.poll(hosts, { timeout: 5000 }).toHaveLength(0);
});
