// Chrome Web Store screenshots (1280×800) of the real popup with real data:
// ./install.sh into a temp HOME, the built extension, the real host, and real servers
// staged as typical dev projects. Run with `npm run store:shots`.
//
// The host reports every listener on the machine. To keep the maintainer's own
// processes out of public images, list responses are narrowed to the staged PIDs;
// everything shown is still what the real host returned for those processes.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { freePort, installIntoTempHome, isFree, launch, projectsRoot, ROOT, startServer, type Server } from "./stage.ts";

test.skip(!["darwin", "linux"].includes(process.platform), "install.sh is for macOS and Linux");

const OUT = join(ROOT, "assets/store");
const RAW = resolve(import.meta.dirname, "../../test-results/store-raw");

async function pick(preferred: number): Promise<number> {
  return (await isFree(preferred)) ? preferred : freePort();
}

/** Runs in the popup: only pass through listeners that belong to the staged servers. */
function onlyPids(pids: number[]) {
  const allow = new Set(pids);
  const keep = (l: any) => l && allow.has(l.pid);
  const narrow = (m: any) => {
    if (m?.type === "list") return { ...m, listeners: m.listeners.filter(keep) };
    if (m?.type === "check") return { ...m, results: m.results.map((r: any) => (r.listener && !keep(r.listener) ? { port: r.port, free: r.free } : r)) };
    return m;
  };
  const rt = (globalThis as any).chrome?.runtime;
  if (!rt?.connectNative) return;
  const connect = rt.connectNative.bind(rt);
  rt.connectNative = (name: string) => {
    const port = connect(name);
    const add = port.onMessage.addListener.bind(port.onMessage);
    port.onMessage.addListener = (fn: (m: any) => void) => add((m: any) => fn(narrow(m)));
    return port;
  };
  const send = rt.sendNativeMessage.bind(rt);
  rt.sendNativeMessage = (name: string, msg: any, cb: (m: any) => void) => send(name, msg, (m: any) => cb(narrow(m)));
}

const SLIDES = [
  {
    file: "screenshot-1-ports-1280x800.png",
    raw: "list-light",
    eyebrow: "Every localhost port",
    title: "See every port,<br>and who’s on it.",
    body: "Port, project, tool and process for every listener — refreshed while you look.",
    scheme: "light",
  },
  {
    file: "screenshot-2-check-1280x800.png",
    raw: "check-dark",
    eyebrow: "Type a port",
    title: "Know if it’s free<br>before you start.",
    body: "Busy ports name their owner. The footer always offers the nearest free one.",
    scheme: "dark",
  },
  {
    file: "screenshot-3-quit-1280x800.png",
    raw: "quit-light",
    eyebrow: "Clean up",
    title: "Quit a stray server<br>without a terminal.",
    body: "Only your own processes, only ones holding a port. Nothing leaves your computer.",
    scheme: "light",
  },
] as const;

let context: BrowserContext;
let cleanup: (() => void)[] = [];

test.afterAll(async () => {
  await context?.close();
  for (const f of cleanup.reverse()) f();
});

test("store screenshots", async () => {
  test.setTimeout(300_000);
  mkdirSync(RAW, { recursive: true });
  const installed = installIntoTempHome();
  cleanup.push(installed.cleanup);
  const projects = projectsRoot();
  cleanup.push(projects.cleanup);

  const root = projects.dir;
  const staged: Server[] = [];
  const add = async (o: Parameters<typeof startServer>[0]) => {
    const s = await startServer(o);
    staged.push(s);
    cleanup.push(s.stop);
    return s;
  };
  // Started a little apart, so uptimes look like a working session (real start times).
  const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
  const web = await add({ root, project: "storefront", bin: "node_modules/.bin/next", args: ["dev"], port: await pick(3000) });
  await wait(50);
  await add({ root, project: "ledger/api", bin: ".venv/bin/uvicorn", args: ["main:app", "--reload"], port: await pick(8000), runtime: "python3" });
  await wait(20);
  await add({ root, project: "design-system", bin: "node_modules/.bin/storybook", args: ["dev", "-p", "6006"], port: await pick(6006), host: "0.0.0.0" });
  await wait(12);
  await add({ root, project: "edge-cache", bin: "node_modules/.bin/wrangler", args: ["dev"], port: await pick(8787) });
  await wait(8);
  await add({ root, project: "handbook", bin: "node_modules/.bin/astro", args: ["dev"], port: await pick(4321) });
  await wait(6);
  const vite = await add({ root, project: "dashboard", bin: "node_modules/.bin/vite", port: await pick(5173) });

  let id: string;
  ({ context, id } = await launch(installed.userDataDir));
  await context.addInitScript(onlyPids, staged.map((s) => s.pid));

  const open = async (scheme: "light" | "dark"): Promise<Page> => {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`chrome-extension://${id}/popup.html`);
    await expect(page.locator("li.row")).toHaveCount(staged.length);
    await page.waitForTimeout(400);
    return page;
  };

  // 1. The list, one row hovered so the actions show.
  let page = await open("light");
  await page.locator(`li.row[data-key^="${vite.port}:"]`).hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(RAW, "list-light.png") });
  await page.close();

  // 2. Checking a busy port, dark.
  page = await open("dark");
  await page.locator("#q").fill(String(web.port));
  await expect(page.locator("#check")).toContainText(`Port ${web.port} is in use`);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(RAW, "check-dark.png") });
  await page.close();

  // 3. Asking to quit one.
  page = await open("light");
  const row = page.locator(`li.row[data-key^="${web.port}:"]`);
  await row.hover();
  await row.locator('[data-act="kill"]').click();
  await expect(row.locator(".confirm-text")).toContainText("Quit");
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(RAW, "quit-light.png") });
  await page.close();

  // Compose each 1280×800 slide.
  const icon = readFileSync(join(ROOT, "assets/icons/icon-128.png")).toString("base64");
  const slide = await context.newPage();
  await slide.setViewportSize({ width: 1280, height: 800 });
  for (const s of SLIDES) {
    const shot = readFileSync(join(RAW, `${s.raw}.png`)).toString("base64");
    await slide.setContent(slideHtml({ ...s, shot, icon }));
    await slide.evaluate(() => document.fonts.ready);
    await slide.waitForTimeout(100);
    await slide.screenshot({ path: join(OUT, s.file), scale: "css" });
  }
});

function slideHtml(s: { eyebrow: string; title: string; body: string; scheme: string; shot: string; icon: string }) {
  const dark = s.scheme === "dark";
  return `<!doctype html><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 800px; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
    background: radial-gradient(120% 90% at 85% 40%, #34413c 0%, #28332f 55%, #222b28 100%);
    color: #f3f2e9; -webkit-font-smoothing: antialiased;
    display: grid; grid-template-columns: 1fr 492px; align-items: center; padding: 0 104px 0 112px; gap: 72px;
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 56px; font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
  .brand img { width: 36px; height: 36px; }
  .eyebrow { color: #e7a343; font-size: 17px; font-weight: 600; letter-spacing: 0.02em; margin-bottom: 18px; }
  h1 { font-size: 50px; line-height: 1.08; font-weight: 700; letter-spacing: -0.028em; }
  p { margin-top: 24px; font-size: 20px; line-height: 1.5; color: rgba(243, 242, 233, 0.66); max-width: 440px; letter-spacing: -0.005em; }
  .popup {
    width: 492px; height: 738px; border-radius: 16px; overflow: hidden;
    background: url(data:image/png;base64,${s.shot}) center / cover;
    box-shadow: 0 0 0 1px ${dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.18)"}, 0 2px 6px rgba(0,0,0,0.25), 0 30px 80px rgba(0,0,0,0.45);
  }
</style>
<div>
  <div class="brand"><img src="data:image/png;base64,${s.icon}" alt="">Portlight</div>
  <div class="eyebrow">${s.eyebrow}</div>
  <h1>${s.title}</h1>
  <p>${s.body}</p>
</div>
<div class="popup" role="img" aria-label="Portlight popup"></div>`;
}
