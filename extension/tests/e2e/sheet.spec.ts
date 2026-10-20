import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openPopup, SHOTS } from "./harness.ts";
import { ASK_AGAIN_MS, DISMISS_KEY } from "../../src/lib/onboard.ts";

// The "install the helper" sheet: shown over the HTTP fallback when the helper is missing,
// put away with Not now / close / Esc / a click outside, reopened from the banner.

mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, `${name}.png`);
const HTTP = { 3000: "Storefront — Next.js", 5173: "Vite + TS" };

const sheet = (page: Page) => page.getByRole("dialog", { name: "Install the Portlight helper" });
const stored = (page: Page) => page.evaluate((k) => (window as any).__store[k], DISMISS_KEY);
/** Let the sheet's open/close animations finish, so nothing is caught mid-frame. */
const settled = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));

for (const scheme of ["light", "dark"] as const) {
  test(`install sheet, ${scheme}`, async ({ page }) => {
    const { errors } = await openPopup(page, { scheme, scenario: "missing", httpPorts: HTTP });
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page)).toHaveAttribute("aria-modal", "true");
    await expect(sheet(page)).toHaveAccessibleDescription(/listening ports.*Nothing leaves your computer\./);
    await expect(page.locator(".sheet .code code")).toHaveText("npx portlight-host install");
    // The HTTP list keeps working underneath.
    await expect(page.locator("#status-text")).toHaveText("2 servers · HTTP only", { timeout: 15_000 });
    await settled(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: shot(`sheet-${scheme}`) });
    expect(errors.filter((e) => !e.includes("net::ERR_CONNECTION_REFUSED"))).toEqual([]);
  });
}

test("Homebrew is one click away, and the choice is remembered", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://portlight.test" });
  await openPopup(page, { scenario: "missing" });
  const npm = page.getByRole("radio", { name: "npm" });
  const brew = page.getByRole("radio", { name: "Homebrew" });
  await expect(npm).toHaveAttribute("aria-checked", "true");
  await brew.click();
  await expect(brew).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".sheet .code code")).toHaveText("brew install maero47/tap/portlight-host && portlight-host install");
  await page.getByRole("button", { name: "Copy install command" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("brew install maero47/tap/portlight-host && portlight-host install");
  // Arrow keys move within the radio group.
  await brew.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(npm).toBeFocused();
  await expect(npm).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowRight");
  await expect(brew).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(page.getByRole("radio", { name: "Homebrew" })).toHaveAttribute("aria-checked", "true");
  await settled(page);
  await page.screenshot({ path: shot("sheet-brew-light") });
});

test("the dev build gets a quiet ./install.sh hint", async ({ page }) => {
  await openPopup(page, { scenario: "missing" });
  await expect(page.locator(".sheet-hint.dev")).toHaveText("From a clone of the repo, ./install.sh does the same.");
});

test("on Windows: npx in PowerShell, with winget for Node.js", async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    viewport: { width: 360, height: 540 },
  });
  const page = await context.newPage();
  await openPopup(page, { scenario: "missing" });
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.locator(".sheet .code code")).toHaveText(["npx portlight-host install", "winget install OpenJS.NodeJS.LTS"]);
  await expect(page.locator(".sheet")).toContainText("PowerShell or Command Prompt");
  await expect(page.locator(".sheet")).not.toContainText("install.sh");
  await context.close();
});

test("Not now is remembered across reopen; the banner brings the sheet back", async ({ page }) => {
  await openPopup(page, { scenario: "missing", httpPorts: HTTP });
  await expect(sheet(page)).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("#sheet-layer")).toBeHidden();
  await expect(page.locator("#q")).toBeFocused();
  expect(await stored(page)).toMatchObject({ failure: "missing" });

  // Reopen the popup: same storage, no sheet, just the banner over the HTTP list.
  const store = await page.evaluate(() => structuredClone((window as any).__store));
  await openPopup(page, { scenario: "missing", httpPorts: HTTP, local: store });
  await expect(page.locator("li.row")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator("#banner")).toContainText("HTTP only. The helper isn’t installed.");
  await page.waitForTimeout(300);
  await expect(page.locator("#sheet-layer")).toBeHidden();

  const install = page.getByRole("button", { name: "Install…" });
  await install.click();
  await expect(sheet(page)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#sheet-layer")).toBeHidden();
  await expect(install).toBeFocused();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: shot("sheet-banner-light") });
});

test("it asks again after two weeks, or for a different failure", async ({ page }) => {
  const old = { [DISMISS_KEY]: { at: Date.now() - ASK_AGAIN_MS - 1000, failure: "missing" } };
  await openPopup(page, { scenario: "missing", local: old });
  await expect(sheet(page)).toBeVisible();

  const recent = { [DISMISS_KEY]: { at: Date.now(), failure: "missing" } };
  await openPopup(page, { scenario: "forbidden", local: recent });
  await expect(page.getByRole("dialog", { name: "Reconnect the helper" })).toBeVisible();
});

test("a click outside dismisses it", async ({ page }) => {
  await openPopup(page, { scenario: "missing" });
  await expect(sheet(page)).toBeVisible();
  await page.mouse.click(180, 20);
  await expect(page.locator("#sheet-layer")).toBeHidden();
  expect(await stored(page)).toMatchObject({ failure: "missing" });
});

test("Esc closes it; focus stays trapped while open and returns afterwards", async ({ page }) => {
  await openPopup(page, { scenario: "missing", local: { [DISMISS_KEY]: { at: Date.now(), failure: "missing" } } });
  const install = page.getByRole("button", { name: "Install…" });
  await install.focus();
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy install command" })).toBeFocused();
  // The list underneath is inert.
  await expect(page.locator("#app")).toHaveJSProperty("inert", true);

  const inside = () => page.evaluate(() => !!document.activeElement?.closest("#sheet"));
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press("Tab");
    expect(await inside()).toBe(true);
  }
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await inside()).toBe(true);
  }
  // Shortcuts meant for the list don't leak through.
  await page.keyboard.press("/");
  expect(await inside()).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#sheet-layer")).toBeHidden();
  await expect(install).toBeFocused();
  await expect(page.locator("#app")).toHaveJSProperty("inert", false);
});

test("Check Again that finds nothing says so; once installed it closes and goes live", async ({ page }) => {
  await openPopup(page, { scenario: "missing", httpPorts: HTTP });
  await expect(sheet(page)).toBeVisible();
  await page.getByRole("button", { name: "Check Again" }).click();
  await expect(page.locator("#sheet-status")).toHaveText("Still can’t reach the helper. Make sure the command finished without errors.");
  await expect(page.getByRole("button", { name: "Check Again" })).toBeFocused();

  await page.evaluate(() => (window as any).__install());
  await page.getByRole("button", { name: "Check Again" }).click();
  await expect(page.getByRole("dialog", { name: "Helper connected" })).toBeVisible();
  await expect(page.locator("#sheet-layer")).toBeHidden({ timeout: 3000 });
  await expect(page.locator("#app")).toHaveAttribute("data-mode", "host");
  await expect(page.locator("li.row")).toHaveCount(10);
  await expect(page.locator("#banner")).toBeHidden();
  await expect(page.locator("#q")).toBeFocused();
  expect(await stored(page)).toBeUndefined();
});

test("while open it notices the helper by itself", async ({ page }) => {
  await openPopup(page, { scenario: "missing" });
  await expect(sheet(page)).toBeVisible();
  await page.evaluate(() => (window as any).__install());
  await expect(page.locator("#app")).toHaveAttribute("data-mode", "host", { timeout: 6000 });
  await expect(page.locator("#sheet-layer")).toBeHidden({ timeout: 3000 });
  await expect(page.locator("#status-text")).toHaveText("10 ports in use");
});

test("a connected helper clears an earlier Not now", async ({ page }) => {
  await openPopup(page, { local: { [DISMISS_KEY]: { at: Date.now(), failure: "missing" } } });
  await expect(page.locator("li.row")).toHaveCount(10);
  await expect.poll(() => stored(page)).toBeUndefined();
  await expect(page.locator("#sheet-layer")).toBeHidden();
});

/** Which properties the sheet's animations touch, sampled right as it opens. */
const openAndSample = (page: Page) =>
  page.evaluate(() => {
    (document.querySelector('[data-act="setup"]') as HTMLElement).click();
    const layer = document.getElementById("sheet-layer")!;
    return document
      .getAnimations()
      .filter((a) => layer.contains((a.effect as KeyframeEffect).target as Node))
      .flatMap((a) => Object.keys((a.effect as KeyframeEffect).getKeyframes()[0] ?? {}))
      .filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k));
  });

test("full motion: the sheet rises on a spring", async ({ page }) => {
  await openPopup(page, { scenario: "missing", reducedMotion: "no-preference", local: { [DISMISS_KEY]: { at: Date.now(), failure: "missing" } } });
  await expect(page.locator("#banner")).toBeVisible();
  expect(await openAndSample(page)).toContain("transform");
});

for (const how of ["system", "setting"] as const) {
  test(`reduced motion (${how}): the sheet only fades`, async ({ page }) => {
    await openPopup(page, {
      scenario: "missing",
      reducedMotion: how === "system" ? "reduce" : "no-preference",
      settings: how === "setting" ? { motion: "reduced" } : undefined,
      local: { [DISMISS_KEY]: { at: Date.now(), failure: "missing" } },
    });
    await expect(page.locator("#banner")).toBeVisible();
    if (how === "setting") await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
    const props = await openAndSample(page);
    expect(props).toContain("opacity");
    expect(props).not.toContain("transform");
    await expect(sheet(page)).toBeVisible();
  });
}

// ---------- the fallback scan across live / fallback switches ----------

test("fallback → live → fallback mid-scan leaves exactly one rescan chain and the newest rows", async ({ page }) => {
  // Count the HTTP rescan timers (8 s) that are still pending.
  await page.addInitScript(() => {
    const pending = new Set<number>();
    const set = window.setTimeout.bind(window);
    const clear = window.clearTimeout.bind(window);
    (window as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => {
      const id: number = set(
        (...a: any[]) => {
          pending.delete(id);
          typeof fn === "function" && fn(...a);
        },
        ms,
        ...rest,
      );
      if (ms === 8000) pending.add(id);
      return id;
    };
    (window as any).clearTimeout = (id?: number) => {
      if (id !== undefined) pending.delete(id);
      clear(id);
    };
    (window as any).__rescans = () => pending.size;
  });
  await openPopup(page, {
    scenario: "missing",
    httpPorts: { 3000: "Storefront" },
    probeDelayMs: 600,
    settings: { refreshMs: 500 },
    local: { [DISMISS_KEY]: { at: Date.now(), failure: "missing" } },
  });
  await expect(page.locator("#app")).toHaveAttribute("data-mode", "fallback");
  // The first scan's probes are still out: the helper arrives, then goes away again.
  await page.evaluate(() => {
    (window as any).__install();
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator("#app")).toHaveAttribute("data-mode", "host");
  await page.evaluate(() => (window as any).__uninstall());
  await expect(page.locator("#app")).toHaveAttribute("data-mode", "fallback");
  // Both scans' probes have answered by now.
  await expect(page.locator("#status-text")).toHaveText("1 server · HTTP only");
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__rescans())).toBe(1);
  await expect(page.locator("li.row")).toHaveCount(1);
});

test("HTTP scan chosen after an error: the banner offers Try Again, not the installer", async ({ page }) => {
  // The helper is installed but exits without answering: the popup shows its error state.
  await openPopup(page, { scenario: "crashed", httpPorts: HTTP });
  await expect(page.locator(".state h2")).toHaveText("Couldn’t read ports");
  await page.getByRole("button", { name: "Use HTTP Scan" }).click();
  await expect(page.locator("#banner")).toContainText("HTTP only. The helper isn’t answering.");
  await expect(page.getByRole("button", { name: "Install…" })).toHaveCount(0);
  await expect(page.locator("#sheet-layer")).toBeHidden();

  const retry = page.getByRole("button", { name: "Try Again" });
  await retry.click();
  await expect(page.locator("#app")).toHaveAttribute("data-mode", "fallback");
  await expect(page.locator("#sheet-layer")).toBeHidden();
  await expect(page.locator("#announcer")).toHaveText("The helper still isn’t answering.");

  await page.evaluate(() => (window as any).__install());
  await retry.click();
  await expect(page.locator("#app")).toHaveAttribute("data-mode", "host");
  await expect(page.locator("li.row")).toHaveCount(10);
});
