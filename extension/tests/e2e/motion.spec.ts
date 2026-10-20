import { expect, test, type Page } from "@playwright/test";
import { openPopup } from "./harness.ts";

// Motion behaviour: loops stop when motion is reduced or the page is hidden, nothing blocks input,
// and transitions interrupted mid-flight settle where they should.

/** Infinite CSS/WAAPI animations that are currently running (the ambient loops). */
const loopNames = (page: Page) =>
  page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity)
        .map((a) => `${(a as CSSAnimation).animationName}@${((a.effect as KeyframeEffect).target as Element | null)?.className}`),
  );

const runningLoops = async (page: Page) => (await loopNames(page)).length;

test("ambient loops run with full motion", async ({ page }) => {
  await openPopup(page, { reducedMotion: "no-preference" });
  await expect(page.locator("li.row").first()).toBeVisible();
  // The three harbor lights.
  await expect.poll(() => runningLoops(page)).toBeGreaterThanOrEqual(3);
});

test("Reduce Motion (system) stops every ambient loop", async ({ page }) => {
  await openPopup(page, { reducedMotion: "reduce" });
  await expect(page.locator("li.row").first()).toBeVisible();
  await page.waitForTimeout(100);
  expect(await runningLoops(page)).toBe(0);
  // The harbor light is still there, just still.
  await expect(page.locator(".ambient")).toBeVisible();
});

test("the Reduced setting stops loops even when the system allows motion", async ({ page }) => {
  await openPopup(page, { reducedMotion: "no-preference", settings: { motion: "reduced" } });
  await expect(page.locator("li.row").first()).toBeVisible();
  await page.waitForTimeout(100);
  expect(await runningLoops(page)).toBe(0);
});

test("the Full setting keeps loops even with Reduce Motion on", async ({ page }) => {
  await openPopup(page, { reducedMotion: "reduce", settings: { motion: "full" } });
  await expect(page.locator("li.row").first()).toBeVisible();
  await expect.poll(() => runningLoops(page)).toBeGreaterThanOrEqual(3);
});

test("loops pause while the popup is hidden", async ({ page }) => {
  await openPopup(page, { reducedMotion: "no-preference" });
  await expect.poll(() => runningLoops(page)).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveClass(/asleep/);
  expect(await loopNames(page)).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => runningLoops(page)).toBeGreaterThanOrEqual(3);
});

test("a row can be clicked while the list is still cascading in", async ({ page }) => {
  await openPopup(page, { reducedMotion: "no-preference" });
  const row = page.locator('li.row[data-key^="5173"]');
  await row.waitFor();
  // The entrance is still running on this row when it is clicked.
  expect(await row.evaluate((el) => el.getAnimations().some((a) => a.playState === "running"))).toBe(true);
  await row.locator(".row-main").click({ position: { x: 120, y: 20 }, force: true });
  await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual(["http://localhost:5173"]);
});

test("rows added and removed mid-slide settle in order with no leftover transforms", async ({ page }) => {
  const { errors } = await openPopup(page, { reducedMotion: "no-preference", settings: { refreshMs: 500 } });
  await expect(page.locator("li.row")).toHaveCount(10);
  await page.waitForTimeout(800);
  const restart = (port: number, pid: number) =>
    page.evaluate(
      ({ port, pid }) =>
        (window as any).__mutate((l: any[]) => [
          ...l,
          { ...l[0], port, pid, cwd: `/Users/mali/code/app-${port}`, command: "node vite", startedAt: new Date().toISOString() },
        ]),
      { port, pid },
    );
  // Three changes, each landing while the previous slide is still moving.
  await restart(3001, 70001);
  await page.waitForTimeout(650);
  await page.evaluate(() => (window as any).__mutate((l: any[]) => l.filter((x) => x.port !== 3001 && x.port !== 5173)));
  await page.waitForTimeout(550);
  await restart(3002, 70002);
  await expect(page.locator("li.row:not(.leaving)")).toHaveCount(10);
  await page.waitForTimeout(1200);
  const ports = await page.locator("li.row .port").allTextContents();
  expect(ports.slice(0, 5)).toEqual(["3000", "3002", "6006", "8000", "8787"]);
  // Nothing is left mid-animation or offset.
  const stuck = await page.evaluate(() =>
    [...document.querySelectorAll("li")].filter((li) => li.getAnimations().length || getComputedStyle(li).transform !== "none").length,
  );
  expect(stuck).toBe(0);
  expect(await page.locator("li.leaving").count()).toBe(0);
  expect(errors).toEqual([]);
});

test("the menu can be reopened while it is still fading out", async ({ page }) => {
  await openPopup(page, { reducedMotion: "no-preference" });
  const row = page.locator('li.row[data-key^="5173"]');
  await row.hover();
  const more = row.locator('[data-act="menu"]');
  await more.click();
  await page.keyboard.press("Escape");
  await more.click();
  await expect(page.locator("#menu")).toBeVisible();
  await expect(page.locator("#menu").getByRole("menuitem").first()).toBeFocused();
  await page.waitForTimeout(500);
  // The ghost of the closed menu is gone, and the open one is fully there.
  await expect(page.locator(".menu.ghost")).toHaveCount(0);
  expect(await page.locator("#menu").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
});

test("a rolling number always reads as the new value", async ({ page }) => {
  await openPopup(page, { reducedMotion: "no-preference" });
  await expect(page.locator("#suggest-port")).toHaveText("3001");
  await page.waitForTimeout(500);
  await page.locator("#q").fill("4321");
  // Mid-roll: digits are animating, but the text (and what a screen reader hears) is already 4322.
  await expect(page.locator("#suggest-port .dg").first()).toBeAttached();
  expect(await page.locator("#suggest-port").textContent()).toBe("4322");
  await expect(page.locator("#suggest-port .dg")).toHaveCount(0);
  await expect(page.locator("#suggest-port")).toHaveText("4322");
});

test("panels open and close repeatedly without getting stuck", async ({ page }) => {
  await openPopup(page, { reducedMotion: "no-preference" });
  const row = page.locator('li.row[data-key^="5432"]');
  await row.hover();
  for (let i = 0; i < 3; i++) {
    await row.locator('[data-act="kill"]').click();
    await page.waitForTimeout(80 + i * 60);
    await page.keyboard.press("Escape");
  }
  await row.locator('[data-act="kill"]').click();
  await expect(row.locator('[data-act="cancel"]')).toBeFocused();
  await page.waitForTimeout(600);
  const h = await row.locator(".confirm-inner").evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThan(20);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  expect(await row.locator(".confirm-inner").evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
});

const beats = (page: Page) =>
  page.evaluate(() => document.querySelector(".live-dot")!.getAnimations({ subtree: true }).filter((a) => a.id === "beat").length);

test("the live dot breathes when fresh data lands, and not with Reduce Motion", async ({ page }) => {
  await openPopup(page, { reducedMotion: "no-preference" });
  await expect.poll(() => beats(page)).toBe(1);
  // Between beats nothing runs on the dot.
  await expect.poll(() => beats(page), { timeout: 4000 }).toBe(0);
  // At most one beat every ~6 s, even with a 2 s refresh.
  await page.waitForTimeout(1500);
  expect(await beats(page)).toBe(0);
});

test("no heartbeat with Reduce Motion", async ({ page }) => {
  await openPopup(page, { reducedMotion: "reduce", settings: { refreshMs: 500 } });
  await expect(page.locator("#status-text")).toHaveText("10 ports in use");
  await page.waitForTimeout(1200);
  expect(await beats(page)).toBe(0);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`focus survives two neighbouring rows leaving together (${reducedMotion})`, async ({ page }) => {
    // Ungrouped, the list ends …8000, 8787, 44950. The last two stop in the same refresh while
    // 8787 has focus: focus must land on 8000, not bounce between the two leaving rows to <body>.
    await openPopup(page, { reducedMotion, settings: { groupRows: false, refreshMs: 500 } });
    await expect(page.locator("li.row")).toHaveCount(10);
    await expect(page.locator("li.row .port").last()).toHaveText("44950");
    await page.locator('li.row[data-key^="8787:"] .row-main').focus();
    await page.evaluate(() => (window as any).__mutate((l: any[]) => l.filter((x) => x.port !== 8787 && x.port !== 44950)));
    await expect(page.locator("li.row:not(.leaving)")).toHaveCount(8);
    await expect(page.locator('li.row[data-key^="8000:"] .row-main')).toBeFocused();
    // Still there once the leaving rows are gone from the DOM.
    await expect(page.locator("li.leaving")).toHaveCount(0);
    await expect(page.locator('li.row[data-key^="8000:"] .row-main')).toBeFocused();
  });
}
