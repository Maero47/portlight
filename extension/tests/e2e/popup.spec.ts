import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openPopup, PINNED_ID, SHOTS } from "./harness.ts";

mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, `${name}.png`);

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    test("list", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme });
      // 10 of your ports, grouped; macOS's own 3 wait behind "3 hidden".
      await expect(page.locator("li.row")).toHaveCount(10);
      await expect(page.locator("#status-text")).toHaveText("10 ports in use");
      await expect(page.locator(".section-label")).toHaveText(["Dev Servers", "Databases", "Containers", "Apps"]);
      await expect(page.locator(".more-btn")).toContainText("3 hidden");
      await expect(page.locator("#suggest-port")).toHaveText("3001");
      // Project names, recognised tools and exposure are all visible.
      await expect(page.locator("li.row").first()).toContainText("storefront");
      await expect(page.locator("li.row").first()).toContainText("Next.js");
      await expect(page.locator('li.row[data-key^="8000"]')).toContainText("ledger/api");
      await expect(page.locator('li.row[data-key^="8000"] .scope')).toHaveText("Network");
      await page.locator('li.row[data-key^="5173"]').hover();
      await page.waitForTimeout(350);
      await page.screenshot({ path: shot(`list-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("empty", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme, scenario: "empty" });
      await expect(page.locator(".state h2")).toHaveText("Nothing is listening");
      await page.mouse.move(0, 0);
      await page.screenshot({ path: shot(`empty-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("host missing onboarding", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme, scenario: "missing" });
      await expect(page.locator(".onboard h2")).toHaveText("Connect the Portlight helper");
      await expect(page.locator(".code code")).toHaveText("./install.sh");
      await expect(page.locator("#status-text")).toHaveText("Not connected");
      await page.screenshot({ path: shot(`onboarding-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("free-port check", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme });
      await expect(page.locator("li.row")).toHaveCount(10);
      await page.locator("#q").fill("4321");
      await expect(page.locator("#check")).toContainText("Port 4321 is free");
      await expect(page.locator("#suggest-label")).toHaveText("Free near 4321");
      await expect(page.locator("#suggest-port")).toHaveText("4322");
      await expect(page.locator("#state")).toBeHidden();
      await page.screenshot({ path: shot(`check-free-${scheme}`) });
      await page.locator("#q").fill("8000");
      await expect(page.locator("#check")).toContainText("Port 8000 is in use");
      await expect(page.locator("#check")).toContainText("ledger/api");
      await expect(page.locator("#suggest-port")).toHaveText("8001");
      await page.screenshot({ path: shot(`check-used-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("http-only fallback", async ({ page }) => {
      const { errors } = await openPopup(page, {
        scheme,
        scenario: "missing",
        httpPorts: { 3000: "Storefront — Next.js", 5173: "Vite + TS", 8080: "" },
      });
      await page.getByRole("button", { name: "Scan common ports over HTTP" }).click();
      await expect(page.locator("li.row")).toHaveCount(3);
      await expect(page.locator("#status-text")).toHaveText("3 servers · HTTP only", { timeout: 15_000 });
      await expect(page.locator("li.row").first()).toContainText("Storefront — Next.js");
      await expect(page.locator('li.row [data-act="kill"]').first()).toBeHidden();
      await page.mouse.move(0, 0);
      await page.screenshot({ path: shot(`fallback-${scheme}`) });
      // Closed ports are expected to refuse; Chrome logs those itself and JS cannot silence them.
      expect(errors.filter((e) => !e.includes("net::ERR_CONNECTION_REFUSED"))).toEqual([]);
    });
  });
}

test("kill asks inline, then removes the row", async ({ page }) => {
  const { errors } = await openPopup(page);
  const row = page.locator('li.row[data-key^="6006"]');
  await row.hover();
  await row.locator('[data-act="kill"]').click();
  await expect(row).toHaveClass(/confirming/);
  await expect(row.locator(".confirm-text")).toContainText("Quit node");
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot("kill-confirm-light") });
  await row.getByRole("button", { name: "Quit", exact: true }).click();
  await expect(page.locator('li.row[data-key^="6006"]')).toHaveCount(0);
  await expect(page.locator("#status-text")).toHaveText("9 ports in use");
  expect(errors).toEqual([]);
});

test("escape cancels the kill confirmation", async ({ page }) => {
  await openPopup(page);
  const row = page.locator('li.row[data-key^="5432"]');
  await row.hover();
  await row.locator('[data-act="kill"]').click();
  await expect(row).toHaveClass(/confirming/);
  await page.keyboard.press("Escape");
  await expect(row).not.toHaveClass(/confirming/);
  await expect(row.locator(".row-main")).toBeFocused();
});

test("keyboard: arrows move, enter opens, ⌘K returns to search", async ({ page }) => {
  await openPopup(page);
  await expect(page.locator("li.row")).toHaveCount(10);
  await expect(page.locator("#q")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("li.row .row-main").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("li.row .row-main").nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).__opened)).toEqual(["http://localhost:5173"]);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#q")).toBeFocused();
  await page.keyboard.type("redis");
  // The Redis server and the redis:7 container.
  await expect(page.locator("li.row")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator("#q")).toHaveValue("");
  await expect(page.locator("li.row")).toHaveCount(10);
});

test("copy URL and suggested port", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://portlight.test" });
  await openPopup(page);
  const row = page.locator("li.row").first();
  await row.hover();
  await row.locator('[data-act="copy"]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("http://localhost:3000");
  await expect(row.locator('[data-act="copy"]')).toHaveClass(/done/);
  await page.locator("#suggest").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("3001");
});

test("forbidden host shows the reconnect variant", async ({ page }) => {
  await openPopup(page, { scenario: "forbidden" });
  await expect(page.locator(".onboard h2")).toHaveText("Reconnect the helper");
});

test("an extension ID other than the pinned one is passed to the installer", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://portlight.test" });
  const other = "abcdefghijklmnopabcdefghijklmnop";
  expect(other).not.toBe(PINNED_ID);
  await openPopup(page, { scenario: "missing", id: other });
  await expect(page.locator(".code code")).toHaveText(`./install.sh ${other}`);
  await page.getByRole("button", { name: "Copy install command" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`./install.sh ${other}`);
});

test("talks to the host over one connectNative port", async ({ page }) => {
  await openPopup(page);
  await expect(page.locator("li.row")).toHaveCount(10);
  await page.locator("#q").fill("4321");
  await expect(page.locator("#check")).toContainText("Port 4321 is free");
  await expect
    .poll(() => page.evaluate(() => (window as any).__requests.map((r: any) => r.type)))
    .toEqual(expect.arrayContaining(["list", "check", "suggest"]));
  expect(await page.evaluate(() => (window as any).__spawns)).toEqual(["connectNative"]);
});

test.describe("on Linux", () => {
  test.use({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" });
  test("copy never says Mac", async ({ page }) => {
    await openPopup(page, { scenario: "missing" });
    await expect(page.locator(".onboard")).toContainText("this computer’s listening ports");
    await expect(page.locator(".code code")).toHaveText("./install.sh");
    await openPopup(page);
    await expect(page.locator(".scope.local").first()).toHaveAttribute("title", "Only reachable from this computer");
    expect(await page.locator("body").innerText()).not.toMatch(/\bMac\b/);
  });
});

// ---------- grouping, hiding, explanations, tabs, containers ----------

const TABS = [
  { url: "http://localhost:3000/products", title: "Storefront" },
  { url: "http://localhost:5173/", title: "Portlight popup" },
  { url: "http://127.0.0.1:5173/options.html", title: "Portlight options", windowId: 2 },
  { url: "http://localhost:4000/admin", title: "Admin — Remix" },
  { url: "https://github.com/", title: "GitHub" },
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode features`, () => {
    test("containers, apps and the hidden affordance", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme });
      const db = page.locator('li.row[data-key^="5433:"]');
      await expect(db.locator(".name")).toHaveText("shop-db-1");
      await expect(db.locator(".tool")).toHaveText("postgres:16-alpine");
      await expect(db.locator(".line2")).toContainText("shop · container port 5432");
      await page.locator(".more").scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await page.screenshot({ path: shot(`containers-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("show hidden reveals system ports, dimmed", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme });
      await page.locator(".more-btn").click();
      await expect(page.locator(".section-label").last()).toHaveText("System");
      await expect(page.locator("li.row.is-hidden")).toHaveCount(3);
      await expect(page.locator('li.row[data-key^="5000:"] .name')).toHaveText("AirPlay Receiver");
      await expect(page.locator(".more-btn")).toContainText("Hide");
      // Showing hidden rows doesn't change what counts as "in use".
      await expect(page.locator("#status-text")).toHaveText("10 ports in use");
      await page.locator(".more").scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await page.screenshot({ path: shot(`hidden-shown-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("AirPlay Receiver on 5000 explains instead of offering Quit", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme });
      await page.locator("#q").fill("5000");
      await expect(page.locator("#check")).toContainText("Port 5000 is in use");
      await expect(page.locator("#check")).toContainText("by AirPlay Receiver · macOS");
      await expect(page.locator('#check [data-act="open-port"]')).toHaveCount(0);
      await expect(page.locator("#check .check-note")).toContainText("System Settings › General › AirDrop & Handoff › AirPlay Receiver");
      // Searching finds the hidden row too; it has no Quit, only an explanation.
      const row = page.locator('li.row[data-key^="5000:"]');
      await expect(row).toHaveClass(/is-hidden/);
      await row.hover();
      await expect(row.locator('[data-act="kill"]')).toBeHidden();
      await row.locator('[data-act="info"]').click();
      await expect(row.locator(".explain")).toContainText("quitting won’t free the port");
      await page.waitForTimeout(450);
      await page.screenshot({ path: shot(`airplay-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("tabs: linked rows and tabs whose server stopped", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme, tabs: TABS });
      await expect(page.locator('li.row[data-key^="3000:"] .tabs')).toHaveText("1 tab");
      await expect(page.locator('li.row[data-key^="5173:"] .tabs')).toHaveText("2 tabs");
      await expect(page.locator('li.row[data-key^="6006:"] .idle')).toHaveText("Idle");
      const stopped = page.locator('li.row[data-key="4000:tab"]');
      await expect(stopped.locator(".name")).toHaveText("Admin — Remix");
      await expect(stopped.locator(".line2")).toHaveText("Server stopped·1 tab");
      await expect(page.locator(".section-label").last()).toHaveText("Tabs Without a Server");
      // Stopped tabs don't count as ports in use.
      await expect(page.locator("#status-text")).toHaveText("10 ports in use");
      await page.locator('li.row[data-key^="5173:"]').hover();
      await page.waitForTimeout(350);
      await page.screenshot({ path: shot(`tabs-${scheme}`) });
      await stopped.scrollIntoViewIfNeeded();
      await stopped.hover();
      await page.waitForTimeout(350);
      await page.screenshot({ path: shot(`tabs-stopped-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("row menu", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme, tabs: TABS });
      const row = page.locator('li.row[data-key^="5173:"]');
      await row.hover();
      await row.locator('[data-act="menu"]').click();
      await expect(page.locator("#menu")).toBeVisible();
      await expect(page.locator("#menu .menu-item")).toHaveText([
        "Switch to Tab↩", "Copy URL⌘C", "Reveal in Finder", "Open in VS Code", "Hide Port 5173", "Hide All “node”", "Quit node…⌘⌫",
      ]);
      await expect(page.locator("#menu .menu-item").first()).toBeFocused();
      await page.waitForTimeout(250);
      await page.screenshot({ path: shot(`menu-${scheme}`) });
      expect(errors).toEqual([]);
    });
  });
}

test("clicking a port that has a tab focuses it instead of opening another", async ({ page }) => {
  await openPopup(page, { tabs: TABS });
  await expect(page.locator('li.row[data-key^="5173:"] .tabs')).toHaveText("2 tabs");
  await page.locator('li.row[data-key^="5173:"] .row-main').click();
  // The most recently used of the two tabs, and its window.
  expect(await page.evaluate(() => (window as any).__focused)).toEqual([
    { tabId: 101, active: true },
    { windowId: 1, focused: true },
  ]);
  await page.locator('li.row[data-key^="8000:"] .row-main').click();
  expect(await page.evaluate(() => (window as any).__opened)).toEqual(["http://localhost:8000"]);
});

test("a stopped server's tabs can be switched to or closed", async ({ page }) => {
  await openPopup(page, { tabs: TABS });
  const stopped = page.locator('li.row[data-key="4000:tab"]');
  await stopped.hover();
  await expect(stopped.locator('[data-act="kill"]')).toBeHidden();
  await stopped.locator('[data-act="open"]').click();
  expect(await page.evaluate(() => (window as any).__focused[0])).toEqual({ tabId: 103, active: true });
  await stopped.locator('[data-act="close-tabs"]').click();
  await expect(page.locator('li.row[data-key="4000:tab"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__tabs().map((t: any) => t.id))).not.toContain(103);
});

test("quitting a server with an open tab turns it into a stopped-tab row", async ({ page }) => {
  await openPopup(page, { tabs: TABS });
  const row = page.locator('li.row[data-key^="3000:"]');
  await row.hover();
  await row.locator('[data-act="kill"]').click();
  await row.getByRole("button", { name: "Quit", exact: true }).click();
  await expect(page.locator('li.row[data-key="3000:tab"] .line2')).toContainText("Server stopped");
  // Quit asks the host to take the whole process tree down.
  const kills = await page.evaluate(() => (window as any).__requests.filter((r: any) => r.type === "kill"));
  expect(kills).toEqual([expect.objectContaining({ pid: 48211, signal: "TERM", tree: true })]);
});

test("a container row offers docker stop instead of Quit, Reveal or Editor", async ({ page }) => {
  await openPopup(page);
  const row = page.locator('li.row[data-key^="5433:"]');
  await row.hover();
  await expect(row.locator('[data-act="kill"]')).toBeHidden();
  await row.locator('[data-act="info"]').click();
  await expect(row.locator(".explain")).toContainText("“shop” compose project");
  await expect(row.locator(".cmd-line code")).toHaveText("docker stop shop-db-1");
  await row.locator('[data-act="menu"]').click();
  await expect(page.locator("#menu .menu-item")).toHaveText(["Open in New Tab↩", "Copy URL⌘C", "Hide Port 5433", "Why Can’t I Quit This?"]);
  await expect(row.locator(".row-main")).toHaveAttribute("title", /\/Users\/mali\/code\/shop/);
});

test("hide a port from the menu: saved, gone, counted out of the badge, and undoable", async ({ page }) => {
  await openPopup(page);
  const row = page.locator('li.row[data-key^="44950:"]');
  await expect(row.locator(".name")).toHaveText("Figma Agent");
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Hide Port 44950" }).click();
  await expect(page.locator('li.row[data-key^="44950:"]')).toHaveCount(0);
  await expect(page.locator(".more-btn")).toContainText("4 hidden");
  await expect(page.locator("#status-text")).toHaveText("9 ports in use");
  expect(await page.evaluate(() => (window as any).__store["portlight.settings"].hiddenPorts)).toEqual([44950]);

  await page.locator(".more-btn").click();
  await page.locator('li.row[data-key^="44950:"]').click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Show Port 44950" }).click();
  await expect(page.locator('li.row[data-key^="44950:"]')).not.toHaveClass(/is-hidden/);
  expect(await page.evaluate(() => (window as any).__store["portlight.settings"].hiddenPorts)).toEqual([]);
});

test("hide all of a process", async ({ page }) => {
  await openPopup(page);
  await page.locator('li.row[data-key^="6379:"]').click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Hide All “redis-server”" }).click();
  await expect(page.locator('li.row[data-key^="6379:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__store["portlight.settings"].hiddenProcesses)).toEqual(["redis-server"]);
});

test("settings: ungrouped, system shown, preferred port, badge groups", async ({ page }) => {
  await openPopup(page, { settings: { groupRows: false, hideSystem: false, preferredPort: 8000, badgeGroups: ["dev"] } });
  await expect(page.locator("li.row")).toHaveCount(13);
  await expect(page.locator(".section-label")).toHaveCount(0);
  await expect(page.locator(".more")).toHaveCount(0);
  await expect(page.locator("#suggest-port")).toHaveText("8001");
  // The badge counts dev servers only: 3000, 5173, 6006, 8000, 8787.
  await expect.poll(() => page.evaluate(() => (window as any).__badges.at(-1))).toBe("5");
});

test("settings: theme and editor apply, and react to changes from the options page", async ({ page }) => {
  await openPopup(page, { scheme: "light", settings: { theme: "dark", editor: "zed" } });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(28, 28, 30)");
  await page.locator('li.row[data-key^="3000:"]').click({ button: "right" });
  await expect(page.locator("#menu")).toContainText("Open in Zed");
  await page.keyboard.press("Escape");
  // Another surface (the options page) saves; the open popup follows.
  await page.evaluate(() => (window as any).chrome.storage.sync.set({ "portlight.settings": { version: 1, theme: "light", editor: "none", groupRows: false } }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".section-label")).toHaveCount(0);
  await page.locator('li.row[data-key^="3000:"]').click({ button: "right" });
  await expect(page.locator("#menu")).not.toContainText("Zed");
  await expect(page.locator("#menu")).toContainText("Reveal in Finder");
});

test("reveal and editor talk to the host, and explain when the helper is too old", async ({ page }) => {
  await openPopup(page, { oldHost: true });
  const row = page.locator('li.row[data-key^="5173:"]');
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Reveal in Finder" }).click();
  await expect(row.locator(".confirm-text")).toHaveText("Reveal in Finder needs a newer helper. Run ./install.sh again to update it.");
  await row.getByRole("button", { name: "OK" }).click();
  await expect(row).not.toHaveClass(/confirming/);

  await openPopup(page);
  await page.locator('li.row[data-key^="5173:"]').click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Open in VS Code" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__requests.filter((r: any) => r.type === "openEditor")))
    .toEqual([expect.objectContaining({ pid: 51877, editor: "vscode" })]);
  await expect(page.locator("li.row.confirming")).toHaveCount(0);
});

test("menu keyboard: context-menu key opens, arrows move, escape returns to the row", async ({ page }) => {
  await openPopup(page);
  await expect(page.locator("li.row")).toHaveCount(10);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#menu .menu-item").nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#menu .menu-item").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#menu")).toBeHidden();
  await expect(page.locator('li.row[data-key^="3000:"] .row-main')).toBeFocused();
});

test("a Homebrew service that comes back after Quit says so", async ({ page }) => {
  await openPopup(page, { respawn: [5432] });
  const row = page.locator('li.row[data-key^="5432:"]');
  await row.hover();
  await row.locator('[data-act="kill"]').click();
  await expect(row.locator(".confirm-note")).toContainText("brew services");
  await expect(row.locator(".cmd-line code")).toHaveText("brew services stop postgresql@16");
  await row.getByRole("button", { name: "Quit", exact: true }).click();
  const back = page.locator('li.row[data-key="5432:1712"]');
  await expect(back.locator(".explain-lead")).toHaveText("postgres started again right away — something keeps restarting it.");
  await expect(back.locator(".cmd-line code")).toHaveText("brew services stop postgresql@16");
});

test("the gear opens the options page", async ({ page }) => {
  await openPopup(page);
  await page.getByRole("button", { name: "Settings" }).click();
  expect(await page.evaluate(() => (window as any).__optionsOpened)).toBe(1);
});

test("HTTP fallback probes the user's extra ports and ports open in tabs", async ({ page }) => {
  await openPopup(page, {
    scenario: "missing",
    settings: { extraProbePorts: [4567] },
    tabs: [{ url: "http://localhost:6123/", title: "Odd port app" }],
    httpPorts: { 4567: "Sinatra", 6123: "Odd port app" },
  });
  await page.getByRole("button", { name: "Scan common ports over HTTP" }).click();
  await expect(page.locator('li.row[data-key="4567:http"]')).toContainText("Sinatra");
  await expect(page.locator('li.row[data-key="6123:http"] .tabs')).toHaveText("1 tab");
});
