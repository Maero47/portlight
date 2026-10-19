import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../../src/lib/settings.ts";
import { DIST, ORIGIN, PINNED_ID, SHOTS } from "./harness.ts";

// The options page against a mocked chrome.storage.sync and native host.
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, `${name}.png`);
const KEY = "portlight.settings";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

test.use({ viewport: { width: 720, height: 900 } });

type Host = "connected" | "missing" | "forbidden";

async function openOptions(page: Page, opts: { scheme?: "light" | "dark"; host?: Host; stored?: unknown } = {}) {
  const { scheme = "light", host = "connected", stored } = opts;
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/**`, (route) => {
    const file = resolve(DIST, `.${new URL(route.request().url()).pathname}`);
    if (!file.startsWith(DIST) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
  });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.addInitScript(mockChrome, { host, stored: stored ?? null, id: PINNED_ID, key: KEY });
  await page.goto(`${ORIGIN}/options.html`);
  await expect(page.locator("#page")).toHaveAttribute("aria-busy", "false");
  return { errors };
}

/** Runs in the page. Keep it self-contained. */
function mockChrome({ host, stored, id, key }: { host: Host; stored: unknown; id: string; key: string }) {
  const area: Record<string, unknown> = stored ? { [key]: stored } : {};
  const listeners: ((c: any, a: string) => void)[] = [];
  const w = window as any;
  w.__store = area;
  w.__writes = 0;
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
  const sync = {
    async get(k: string) {
      return k in area ? { [k]: clone(area[k]) } : {};
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(area[k]), newValue: clone(v) };
        area[k] = clone(v);
      }
      w.__writes++;
      setTimeout(() => listeners.forEach((f) => f(changes, "sync")), 0);
    },
  };
  // Lets a test play "another tab changed a setting".
  w.__externalSet = (v: unknown) => sync.set({ [key]: v });
  const chromeStub = {
    runtime,
    storage: {
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

test("every setting round-trips through chrome.storage.sync", async ({ page, browser }) => {
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
