import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../../src/lib/settings.ts";
import { DIST, ORIGIN, PINNED_ID, SHOTS } from "./harness.ts";

// The options page against a mocked chrome.storage (local, plus sync for migration) and native host.
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, `${name}.png`);
const KEY = "portlight.settings";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

test.use({ viewport: { width: 720, height: 900 } });

type Host = "connected" | "missing" | "forbidden";

async function openOptions(
  page: Page,
  opts: { scheme?: "light" | "dark"; host?: Host; stored?: unknown; storedSync?: unknown } = {},
) {
  const { scheme = "light", host = "connected", stored, storedSync } = opts;
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/**`, (route) => {
    const file = resolve(DIST, `.${new URL(route.request().url()).pathname}`);
    if (!file.startsWith(DIST) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
  });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.addInitScript(mockChrome, { host, stored: stored ?? null, storedSync: storedSync ?? null, id: PINNED_ID, key: KEY });
  await page.goto(`${ORIGIN}/options.html`);
  await expect(page.locator("#page")).toHaveAttribute("aria-busy", "false");
  return { errors };
}

/** Runs in the page. Keep it self-contained. */
function mockChrome({ host, stored, storedSync, id, key }: { host: Host; stored: unknown; storedSync: unknown; id: string; key: string }) {
  const area: Record<string, unknown> = stored ? { [key]: stored } : {};
  const syncData: Record<string, unknown> = storedSync ? { [key]: storedSync } : {};
  const listeners: ((c: any, a: string) => void)[] = [];
  const w = window as any;
  w.__store = area;
  w.__writes = 0;
  w.__syncStore = syncData;
  /** Every storage call in order, e.g. "local.get", "local.set". */
  w.__ops = [];
  w.__writeTimes = [];
  const failure =
    host === "missing"
      ? "Specified native messaging host not found."
      : host === "forbidden"
        ? "Access to the specified native messaging host is forbidden."
        : null;
  const runtime: any = {
    id,
    lastError: undefined,
    getManifest: () => ({ version: "0.1.0" }),
    sendNativeMessage(_h: string, msg: any, cb: (r: any) => void) {
      setTimeout(() => {
        if (failure) {
          runtime.lastError = { message: failure };
          cb(undefined);
          runtime.lastError = undefined;
          return;
        }
        cb({ id: msg.id, ok: true, type: "pong", version: 1, platform: "darwin", hostVersion: "0.1.0" });
      }, 15);
    },
  };
  const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const makeArea = (name: "local" | "sync", data: Record<string, unknown>) => ({
    async get(k: string) {
      w.__ops.push(`${name}.get`);
      return k in data ? { [k]: clone(data[k]) } : {};
    },
    // The data changes synchronously, as the real call is issued before the promise returns.
    async set(items: Record<string, unknown>) {
      w.__ops.push(`${name}.set`);
      const changes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      if (name === "local") {
        w.__writes++;
        w.__writeTimes.push(performance.now());
      }
      setTimeout(() => listeners.forEach((f) => f(changes, name)), 0);
    },
  });
  const local = makeArea("local", area);
  const sync = makeArea("sync", syncData);
  // Lets a test play "another tab changed a setting".
  w.__externalSet = (v: unknown) => local.set({ [key]: v });
  w.__externalSyncSet = (v: unknown) => sync.set({ [key]: v });
  const chromeStub = {
    runtime,
    storage: {
      local,
      sync,
      onChanged: {
        addListener: (f: any) => listeners.push(f),
        removeListener: (f: any) => listeners.splice(listeners.indexOf(f), 1),
      },
    },
  };
  Object.defineProperty(window, "chrome", { value: chromeStub, configurable: true, writable: true });
}

const stored = (page: Page) => page.evaluate((k) => (window as any).__store[k] as Settings | undefined, KEY);
const expectStored = (page: Page, partial: Partial<Settings>) =>
  expect.poll(() => stored(page)).toMatchObject(partial);

for (const scheme of ["light", "dark"] as const) {
  test(`options page, ${scheme}`, async ({ page }) => {
    const { errors } = await openOptions(page, {
      scheme,
      stored: { ...DEFAULT_SETTINGS, hiddenPorts: [5000, 7000], hiddenProcesses: ["Spotify", "rapportd"], extraProbePorts: [4200, 8888] },
    });
    await expect(page.locator("#helper-text")).toHaveText("Connected");
    await expect(page.locator("#helper-sub")).toHaveText("Version 0.1.0 on macOS.");
    await expect(page.locator("#version")).toHaveText("0.1.0");
    await expect(page.locator("#idle-value")).toHaveText("8 hours");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: shot(`options-${scheme}`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("helper missing shows the install command", async ({ page }) => {
  const { errors } = await openOptions(page, { host: "missing" });
  await expect(page.locator("#helper-text")).toHaveText("Not installed");
  await expect(page.locator("#install-cmd")).toHaveText("./install.sh");
  await expect(page.locator("#helper-sub")).toHaveText("Reads ports and processes on this Mac.");
  await page.locator("#helper").screenshot({ path: shot("options-helper-missing-light") });
  expect(errors).toEqual([]);
});

test("helper for another ID asks for a reinstall", async ({ page }) => {
  await openOptions(page, { host: "forbidden" });
  await expect(page.locator("#helper-text")).toHaveText("Needs reinstall");
  await expect(page.locator("#install-text")).toContainText("different extension ID");
});

test("every setting round-trips through chrome.storage.local", async ({ page, browser }) => {
  const { errors } = await openOptions(page);
  expect(await stored(page)).toBeUndefined();

  await page.getByRole("radio", { name: "Dark" }).check({ force: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radiogroup", { name: "Motion" }).getByText("Reduced").click();
  await page.getByRole("switch", { name: /Group by category/ }).click();
  await page.getByRole("switch", { name: /Hide system services/ }).click();
  const spin = page.getByRole("spinbutton", { name: "Mark as idle after" });
  await spin.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#idle-value")).toHaveText("10 hours");
  await page.getByRole("button", { name: "Fewer hours" }).click();
  await expect(spin).toHaveAttribute("aria-valuenow", "9");
  await page.getByLabel("Refresh while open").selectOption("5000");
  await page.getByLabel("Open projects in").selectOption("zed");
  await page.getByLabel("Suggest from").fill("4000");
  await page.getByLabel("Suggest from").press("Enter");
  await page.getByRole("switch", { name: /Apps/ }).click();
  await page.getByRole("switch", { name: /Containers/ }).click();
  await page.locator("#hidden-ports-input").fill("9229, 5000-5002");
  await page.locator("#hidden-ports-input").press("Enter");
  await expect(page.locator('[aria-label="Hidden ports"] .token')).toHaveText(["5000", "5001", "5002", "9229"]);
  await page.getByRole("button", { name: "Remove 5001" }).click();
  await page.locator("#hidden-apps-input").fill("Spotify");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("#hidden-apps-input").fill("rapportd");
  await page.locator("#hidden-apps-input").press("Enter");
  await page.getByRole("button", { name: "Show rapportd again" }).click();
  await page.locator("#probe-input").fill("4200");
  await page.locator("#probe-input").press("Enter");

  const expected: Settings = {
    version: 1,
    theme: "dark",
    motion: "reduced",
    groupRows: false,
    hideSystem: false,
    idleAfterHours: 9,
    refreshMs: 5000,
    editor: "zed",
    preferredPort: 4000,
    badgeGroups: ["dev", "database", "app"],
    hiddenPorts: [5000, 5002, 9229],
    hiddenProcesses: ["Spotify"],
    extraProbePorts: [4200],
  };
  await expect.poll(() => stored(page)).toEqual(expected);
  await expect(page.locator("#saved")).toHaveClass(/show/);
  expect(errors).toEqual([]);

  // A fresh page reading the same storage shows every value.
  const again = await browser.newPage({ viewport: { width: 720, height: 900 } });
  await openOptions(again, { stored: expected });
  await expect(again.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(again.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(again.getByRole("radio", { name: "Reduced" })).toBeChecked();
  await expect(again.getByRole("switch", { name: /Group by category/ })).not.toBeChecked();
  await expect(again.getByRole("switch", { name: /Hide system services/ })).not.toBeChecked();
  await expect(again.locator("#idle-value")).toHaveText("9 hours");
  await expect(again.getByLabel("Refresh while open")).toHaveValue("5000");
  await expect(again.getByLabel("Open projects in")).toHaveValue("zed");
  await expect(again.getByLabel("Suggest from")).toHaveValue("4000");
  await expect(again.getByRole("switch", { name: /Apps/ })).toBeChecked();
  await expect(again.getByRole("switch", { name: /Containers/ })).not.toBeChecked();
  await expect(again.locator('[aria-label="Hidden ports"] .token')).toHaveText(["5000", "5002", "9229"]);
  await expect(again.locator("#hidden-apps .item-name")).toHaveText(["Spotify"]);
  await expect(again.locator('[aria-label="Extra ports to scan"] .token')).toHaveText(["4200"]);
  await again.close();
});

test("invalid ports are explained and nothing is saved", async ({ page }) => {
  const { errors } = await openOptions(page);
  const input = page.locator("#hidden-ports-input");
  await input.fill("3000 70000");
  await input.press("Enter");
  await expect(page.locator("#hidden-ports-error")).toHaveText("“70000”: Ports go from 1 to 65535.");
  await expect(input).toHaveValue("70000");
  await expectStored(page, { hiddenPorts: [3000] });
  await page.locator('.row.stacked:has([data-setting="hiddenPorts"])').screenshot({ path: shot("options-token-error-light") });
  await input.fill("3001");
  await expect(page.locator("#hidden-ports-error")).toBeHidden();
  await input.press("Backspace");
  await input.press("Backspace");
  await input.press("Backspace");
  await input.press("Backspace");
  await input.press("Backspace"); // empty field: removes the last token
  await expectStored(page, { hiddenPorts: [] });

  const pref = page.getByLabel("Suggest from");
  await pref.fill("99999");
  await pref.press("Enter");
  await expect(page.locator("#preferred-error")).toHaveText("Ports go from 1 to 65535");
  await expect(pref).toHaveAttribute("aria-invalid", "true");
  expect((await stored(page))?.preferredPort).toBe(3000);
  expect(errors).toEqual([]);
});

test("reset asks inline, then restores defaults", async ({ page }) => {
  await openOptions(page, { stored: { ...DEFAULT_SETTINGS, theme: "dark", hiddenPorts: [5000], editor: "cursor" } });
  await page.getByRole("button", { name: "Reset…" }).click();
  await expect(page.locator("#reset")).toHaveAttribute("data-state", "confirming");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.locator("#reset").screenshot({ path: shot("options-reset-confirm-dark") });
  await page.keyboard.press("Escape");
  await expect(page.locator("#reset")).toHaveAttribute("data-state", "idle");
  expect((await stored(page))?.theme).toBe("dark");

  await page.getByRole("button", { name: "Reset…" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(() => stored(page)).toEqual(DEFAULT_SETTINGS);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  await expect(page.getByLabel("Open projects in")).toHaveValue("vscode");
});

test("changes made elsewhere show up live", async ({ page }) => {
  await openOptions(page);
  await page.evaluate((v) => (window as any).__externalSet(v), { ...DEFAULT_SETTINGS, hiddenProcesses: ["Dropbox"], refreshMs: 7000 });
  await expect(page.locator("#hidden-apps .item-name")).toHaveText(["Dropbox"]);
  // An unusual interval stays selectable instead of being lost.
  await expect(page.getByLabel("Refresh while open")).toHaveValue("7000");
  await expect(page.getByLabel("Refresh while open").locator("option:checked")).toHaveText("Every 7 seconds");
});

test("keyboard can remove any port, not just the last", async ({ page }) => {
  await openOptions(page, { stored: { ...DEFAULT_SETTINGS, hiddenPorts: [5000, 5001, 5002, 9229] } });
  const input = page.locator("#hidden-ports-input");
  await input.focus();
  // Shift+Tab walks back through the × buttons: 9229, 5002, 5001.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Remove 5001" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expectStored(page, { hiddenPorts: [5000, 5002, 9229] });
  // Focus moves to the neighbour, so Delete keeps going.
  await expect(page.getByRole("button", { name: "Remove 5002" })).toBeFocused();
  await page.keyboard.press("Delete");
  await expectStored(page, { hiddenPorts: [5000, 9229] });
  await expect(page.getByRole("button", { name: "Remove 9229" })).toBeFocused();
});

/** Storage write times in the page, to check the pace of writes. */
const writeTimes = (page: Page) => page.evaluate(() => (window as any).__writeTimes as number[]);
function expectPaced(times: number[]) {
  // The scheduler starts a write at most every 250 ms; storage.set lands a read later, so allow
  // some jitter.
  for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(200);
}

test("200 rapid edits across mixed controls become a few paced writes", async ({ page }) => {
  const seeded = Array.from({ length: 40 }, (_, i) => 5000 + i);
  await openOptions(page, { stored: { ...DEFAULT_SETTINGS, hiddenPorts: seeded } });
  const t0 = await page.evaluate(() => performance.now());

  // Radio groups wrap, so arrow keys can change them forever: 40 + 40 changes.
  await page.locator('input[name="theme"][value="system"]').focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  await page.locator('input[name="motion"][value="system"]').focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  // Stepper and port field: 40 + 40.
  await page.getByRole("spinbutton", { name: "Mark as idle after" }).focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  await page.getByLabel("Suggest from").focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  // Backspace in the empty token input removes one port per press: 40.
  await page.locator("#hidden-ports-input").focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("Backspace");

  // The page is instant even though storage is paced.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light"); // 40 steps over 3 options
  await expect(page.locator('[aria-label="Hidden ports"] .token')).toHaveCount(0);
  const expected: Partial<Settings> = { theme: "light", motion: "full", idleAfterHours: 48, preferredPort: 3040, hiddenPorts: [] };
  await expectStored(page, expected);
  await expect(page.getByLabel("Suggest from")).toHaveValue("3040");

  const times = await writeTimes(page);
  const elapsed = times.at(-1)! - t0;
  expectPaced(times);
  // 200 edits became a handful of writes, all to storage.local.
  expect(times.length).toBeLessThanOrEqual(Math.floor(elapsed / 250) + 2);
  expect(times.length).toBeLessThan(20);
  expect(await page.evaluate(() => (window as any).__ops.filter((o: string) => o.startsWith("sync.set")))).toEqual([]);
  console.log(`200 edits → ${times.length} writes over ${Math.round(elapsed)} ms`);
});

test("holding a key writes at a steady pace with the final value", async ({ page }) => {
  await openOptions(page);
  const pref = page.getByLabel("Suggest from");
  await pref.focus();
  for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowUp");
  await expect(pref).toHaveValue("3060");
  await expectStored(page, { preferredPort: 3060 });
  expectPaced(await writeTimes(page));
});

test("a single change is written at once", async ({ page }) => {
  await openOptions(page);
  await page.getByRole("switch", { name: /Group by category/ }).click();
  // Under the 250 ms interval: the first edit after a quiet spell isn't delayed.
  await expect.poll(async () => (await stored(page))?.groupRows, { timeout: 150 }).toBe(false);
});

test("closing the tab writes waiting edits synchronously, without reading first", async ({ page }) => {
  await openOptions(page);
  // All in one synchronous turn, as when a tab closes: two steps (one written, one waiting),
  // then pagehide. Whatever is in storage when the handler returns is all a closing page gets.
  const result = await page.evaluate((key) => {
    const w = window as any;
    const spin = document.querySelector<HTMLElement>(".stepper-arrows")!;
    const step = () => spin.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    step(); // 7
    step(); // 6
    const before = w.__ops.length;
    dispatchEvent(new PageTransitionEvent("pagehide"));
    return { ops: w.__ops.slice(before), idle: w.__store[key]?.idleAfterHours };
  }, KEY);
  expect(result).toEqual({ ops: ["local.set"], idle: 6 });
  // If the page lives on, the save that was already in flight doesn't roll it back.
  await page.waitForTimeout(600);
  expect((await stored(page))?.idleAfterHours).toBe(6);
  await expect(page.locator("#idle-value")).toHaveText("6 hours");
});

test("hiding the tab with nothing waiting writes nothing", async ({ page }) => {
  await openOptions(page);
  const ops = await page.evaluate(() => {
    const w = window as any;
    const before = w.__ops.length;
    dispatchEvent(new PageTransitionEvent("pagehide"));
    return w.__ops.slice(before);
  });
  expect(ops).toEqual([]);
});

test("settings saved by an older build in sync are moved to local", async ({ page }) => {
  const old = { ...DEFAULT_SETTINGS, theme: "dark", editor: "zed", hiddenPorts: [5000] };
  const { errors } = await openOptions(page, { storedSync: old });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Open projects in")).toHaveValue("zed");
  await expect.poll(() => stored(page)).toEqual(old);
  // Later edits go to local only; the sync copy is left as it was.
  await page.getByLabel("Open projects in").selectOption("cursor");
  await expectStored(page, { editor: "cursor" });
  expect(await page.evaluate((k) => (window as any).__syncStore[k].editor, KEY)).toBe("zed");
  expect(errors).toEqual([]);
});

test("only changes in the local area reach the page", async ({ page }) => {
  await openOptions(page);
  await page.evaluate((v) => (window as any).__externalSyncSet(v), { ...DEFAULT_SETTINGS, editor: "zed" });
  await page.evaluate((v) => (window as any).__externalSet(v), { ...DEFAULT_SETTINGS, theme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Open projects in")).toHaveValue("vscode");
});

test("the popup can later set a value this page wrote before", async ({ page }) => {
  await openOptions(page);
  const editor = page.getByLabel("Open projects in");
  await editor.selectOption("zed");
  await editor.selectOption("cursor");
  await expectStored(page, { editor: "cursor" });
  const zed = { ...(await stored(page))!, editor: "zed" };
  await page.waitForTimeout(2200);
  await page.evaluate((v) => (window as any).__externalSet(v), zed);
  await expect(editor).toHaveValue("zed");
});
