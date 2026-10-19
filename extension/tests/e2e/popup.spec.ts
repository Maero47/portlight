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
      await expect(page.locator("li.row")).toHaveCount(7);
      await expect(page.locator("#status-text")).toHaveText("7 ports in use");
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
      await expect(page.locator("li.row")).toHaveCount(7);
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
  await expect(page.locator("#status-text")).toHaveText("6 ports in use");
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
  await expect(page.locator("li.row")).toHaveCount(7);
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
  await expect(page.locator("li.row")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#q")).toHaveValue("");
  await expect(page.locator("li.row")).toHaveCount(7);
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
  await expect(page.locator("li.row")).toHaveCount(7);
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
