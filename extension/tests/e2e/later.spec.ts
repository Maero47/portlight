// Favicons & titles, idle cleanup, Open on Phone, share links, System Settings shortcuts.
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openPopup, SHOTS } from "./harness.ts";

mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, `${name}.png`);

const svg = (fill: string, glyph: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${fill}"/>${glyph}</svg>`;
const FAVICONS = {
  3000: svg("#111", `<path d="M9 23 16 9l7 14z" fill="#fff"/>`),
  5173: svg("#7c5cff", `<path d="M17 6 10 18h5l-1 8 8-13h-5z" fill="#ffd62e"/>`),
  8787: svg("#f38020", `<circle cx="16" cy="16" r="7" fill="#fff"/>`),
};

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    test("favicons and page titles", async ({ page }) => {
      const { errors } = await openPopup(page, {
        scheme,
        favicons: FAVICONS,
        httpPorts: { 3000: "Storefront — Spring Collection", 5173: "Vite + React + TS", 8787: "edge-cache" },
      });
      const r3000 = page.locator('li.row[data-key^="3000:"]');
      await expect(r3000.locator(".favicon")).toBeVisible();
      await expect(r3000.locator(".favicon")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
      // A real title replaces "node" on the second line; template and duplicate titles don't.
      await expect(r3000.locator(".page-title")).toHaveText("Storefront — Spring Collection");
      await expect(page.locator('li.row[data-key^="5173:"] .page-title')).toHaveCount(0);
      await expect(page.locator('li.row[data-key^="8787:"] .page-title')).toHaveCount(0);
      await expect(page.locator('li.row[data-key^="5173:"] .favicon')).toBeVisible();
      // Databases are never asked for a page.
      await expect(page.locator('li.row[data-key^="5432:"] .favicon')).toBeHidden();
      await page.mouse.move(0, 0);
      await page.screenshot({ path: shot(`favicons-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("idle cleanup", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme });
      const btn = page.locator("#idle");
      await expect(btn).toHaveText("Quit 1 Idle…");
      await btn.click();
      await expect(page.locator("#sweep")).toHaveClass(/open/);
      await expect(page.locator(".sweep-title")).toHaveText("Quit 1 idle server?");
      await expect(page.locator(".sweep-list li")).toHaveCount(1);
      await expect(page.locator(".sweep-list li")).toContainText("6006design-systemStorybook1d 2h");
      await expect(page.locator('[data-act="sweep-quit"]')).toBeFocused();
      await page.waitForTimeout(450);
      await page.screenshot({ path: shot(`idle-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("open on phone", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme });
      const row = page.locator('li.row[data-key^="8000:"]');
      await row.click({ button: "right" });
      await page.locator("#menu").getByRole("menuitem", { name: "Open on Phone…" }).click();
      await expect(row.locator(".qr")).toBeVisible();
      await expect(row.locator(".qr")).toHaveAttribute("aria-label", "QR code for http://192.168.1.23:8000");
      await expect(row.locator(".url-line code")).toHaveText("http://192.168.1.23:8000");
      await expect(row.getByRole("button", { name: "Done" })).toBeFocused();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(450);
      await page.screenshot({ path: shot(`phone-${scheme}`) });
      expect(errors).toEqual([]);
    });

    test("share a public link", async ({ page }) => {
      const { errors } = await openPopup(page, { scheme });
      const row = page.locator('li.row[data-key^="5173:"]');
      await row.click({ button: "right" });
      await page.locator("#menu").getByRole("menuitem", { name: "Share Public Link…" }).click();
      await expect(row.locator(".explain-lead")).toHaveText("Anyone with the link can open this server.");
      await expect(row.locator(".explain")).toContainText("cloudflared tunnel to localhost:5173");
      await page.waitForTimeout(450);
      await page.screenshot({ path: shot(`share-ask-${scheme}`) });
      await row.getByRole("button", { name: "Create Link" }).click();
      await expect(row.locator(".url-line code")).toHaveText("https://quiet-harbor-lights.trycloudflare.com");
      await expect(row.locator(".line2 .shared")).toHaveText("Public");
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot(`share-${scheme}`) });
      expect(errors).toEqual([]);
    });
  });
}

test("idle cleanup quits the whole tree and leaves busy servers alone", async ({ page }) => {
  // 6006 is idle; 3000 has a tab so it isn't; 5432 is a database, never "idle".
  await openPopup(page, { tabs: [{ url: "http://localhost:3000/", title: "Storefront" }] });
  await page.locator("#idle").click();
  await page.locator('[data-act="sweep-quit"]').click();
  await expect(page.locator('li.row[data-key^="6006:"]')).toHaveCount(0);
  await expect(page.locator("#sweep")).not.toHaveClass(/open/);
  await expect(page.locator("#idle")).toBeHidden();
  await expect(page.locator("#hints")).toBeVisible();
  const kills = await page.evaluate(() => (window as any).__requests.filter((r: any) => r.type === "kill"));
  expect(kills).toEqual([expect.objectContaining({ pid: 50120, signal: "TERM", tree: true })]);
});

test("idle cleanup: Escape cancels, hidden and short idle settings are respected", async ({ page }) => {
  await openPopup(page);
  await page.locator("#idle").click();
  await expect(page.locator("#sweep")).toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#sweep")).not.toHaveClass(/open/);
  await expect(page.locator("#idle")).toBeFocused();
  // Hiding the port takes it out of the cleanup too.
  await openPopup(page, { settings: { hiddenPorts: [6006] } });
  await expect(page.locator("li.row")).toHaveCount(9);
  await expect(page.locator("#idle")).toBeHidden();
  // A one-hour threshold catches the two-hour-old server as well (but not the database or containers).
  await openPopup(page, { settings: { idleAfterHours: 1 } });
  await expect(page.locator("#idle")).toHaveText("Quit 2 Idle…");
  // 0 turns idle detection off.
  await openPopup(page, { settings: { idleAfterHours: 0 } });
  await expect(page.locator("#idle")).toBeHidden();
});

test("open on phone: a localhost-only server explains the --host flag, then shows the code once restarted", async ({ page }) => {
  await openPopup(page);
  const row = page.locator('li.row[data-key^="5173:"]');
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Open on Phone…" }).click();
  await expect(row.locator(".explain-lead")).toHaveText("Only this Mac can open extension.");
  await expect(row.locator(".explain")).toContainText("Start Vite with this flag so it listens on your network too:");
  await expect(row.locator(".cmd-line code")).toHaveText("--host");
  await expect(row.locator(".qr")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(450);
  await page.screenshot({ path: shot("phone-local-light") });
  // The dev restarts Vite with --host: new pid, now on every interface. The panel follows it.
  await page.evaluate(() =>
    (window as any).__mutate((ls: any[]) =>
      ls.map((l) => (l.port === 5173 ? { ...l, pid: 61000, address: "0.0.0.0", family: "IPv4", command: `${l.command} --host` } : l)),
    ),
  );
  const restarted = page.locator('li.row[data-key="5173:61000"]');
  await expect(restarted.locator(".qr")).toBeVisible({ timeout: 6000 });
  await expect(restarted.locator(".url-line code")).toHaveText("http://192.168.1.23:5173");
});

test("open on phone: a Next.js server gets -H 0.0.0.0; old helpers and offline machines say so", async ({ page }) => {
  await openPopup(page);
  let row = page.locator('li.row[data-key^="3000:"]');
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Open on Phone…" }).click();
  await expect(row.locator(".cmd-line code")).toHaveText("-H 0.0.0.0");

  await openPopup(page, { lan: [] });
  row = page.locator('li.row[data-key^="8000:"]');
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Open on Phone…" }).click();
  await expect(row.locator(".confirm-text")).toHaveText("This Mac isn’t on a network right now.");

  await openPopup(page, { lan: null });
  row = page.locator('li.row[data-key^="8000:"]');
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Open on Phone…" }).click();
  await expect(row.locator(".confirm-text")).toHaveText("Open on Phone needs a newer helper. Run ./install.sh again to update it.");
});

test("phone and share are offered for web servers only", async ({ page }) => {
  await openPopup(page);
  for (const port of [5432, 5433]) {
    await page.locator(`li.row[data-key^="${port}:"]`).click({ button: "right" });
    await expect(page.locator("#menu")).not.toContainText("Phone");
    await expect(page.locator("#menu")).not.toContainText("Share");
    await page.keyboard.press("Escape");
  }
});

test("share: running link is copyable, marked on the row, and can be stopped", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://portlight.test" });
  await openPopup(page, { tunnel: { running: [{ port: 8000, url: "https://brisk-otter-dance.trycloudflare.com" }] } });
  const row = page.locator('li.row[data-key^="8000:"]');
  await expect(row.locator(".shared")).toHaveText("Public");
  await expect(row.locator(".row-main")).toHaveAttribute("aria-label", /shared with a public link/);
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Public Link…" }).click();
  await row.getByRole("button", { name: "Copy https://brisk-otter-dance.trycloudflare.com" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://brisk-otter-dance.trycloudflare.com");
  await row.getByRole("button", { name: "Open https://brisk-otter-dance.trycloudflare.com" }).click();
  expect(await page.evaluate(() => (window as any).__opened)).toEqual(["https://brisk-otter-dance.trycloudflare.com"]);
  await row.getByRole("button", { name: "Stop Sharing" }).click();
  await expect(row).not.toHaveClass(/confirming/);
  await expect(row.locator(".shared")).toHaveCount(0);
  const ops = await page.evaluate(() => (window as any).__tunnelMsgs.map((m: any) => m.op + (m.port ? `:${m.port}` : "")));
  expect(ops).toContain("stop:8000");
  // A shared server is not "idle" even with no tab: someone may be using it.
});

test("share: no cloudflared shows the install command; a failure shows the reason", async ({ page }) => {
  await openPopup(page, { tunnel: { providers: { cloudflared: false, ngrok: false } } });
  let row = page.locator('li.row[data-key^="5173:"]');
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Share Public Link…" }).click();
  await expect(row.locator(".explain-lead")).toHaveText("Share a public link with cloudflared");
  await expect(row.locator(".cmd-line code")).toHaveText("brew install cloudflared");
  await page.waitForTimeout(450);
  await page.screenshot({ path: shot("share-install-light") });

  await openPopup(page, { tunnel: { startError: "failed to request quick Tunnel: 429 Too Many Requests" } });
  row = page.locator('li.row[data-key^="5173:"]');
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Share Public Link…" }).click();
  await row.getByRole("button", { name: "Create Link" }).click();
  await expect(row.locator(".confirm-text.error")).toHaveText("failed to request quick Tunnel: 429 Too Many Requests");
  await expect(row.locator(".shared")).toHaveCount(0);
});

test("share: cancelling while the link is being created stops it quietly", async ({ page }) => {
  await openPopup(page, { tunnel: { startDelayMs: 800 } });
  const row = page.locator('li.row[data-key^="5173:"]');
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Share Public Link…" }).click();
  await row.getByRole("button", { name: "Create Link" }).click();
  await expect(row.locator(".confirm-text")).toHaveText("Creating a public link… This takes a few seconds.");
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row).not.toHaveClass(/confirming/);
  await page.waitForTimeout(900);
  await expect(row).not.toHaveClass(/confirming/);
  await expect(row.locator(".confirm-text.error")).toHaveCount(0);
});

test("AirPlay explanation opens AirDrop & Handoff settings", async ({ page }) => {
  const { errors } = await openPopup(page);
  await page.locator("#q").fill("5000");
  // The check card stays a calm summary; the button lives in the row's explanation.
  await expect(page.locator('#check [data-act="open-pane"]')).toHaveCount(0);
  const row = page.locator('li.row[data-key^="5000:"]');
  await row.hover();
  await row.locator('[data-act="info"]').click();
  await row.getByRole("button", { name: "Open AirDrop & Handoff Settings" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__requests.filter((r: any) => r.type === "openSettings").map((r: any) => r.pane)))
    .toEqual(["airdrop-handoff"]);
  expect(errors).toEqual([]);
});

test("System Settings buttons are macOS only", async ({ browser }) => {
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  await openPopup(page);
  await page.locator("#q").fill("5000");
  const row = page.locator('li.row[data-key^="5000:"]');
  await row.hover();
  await row.locator('[data-act="info"]').click();
  await expect(row.locator(".explain")).toBeVisible();
  await expect(page.locator('[data-act="open-pane"]')).toHaveCount(0);
  await ctx.close();
});

test("tabs on [::1] and *.localhost link to their ports", async ({ page }) => {
  await openPopup(page, {
    tabs: [
      { url: "http://[::1]:5173/", title: "Over IPv6" },
      { url: "http://shop.localhost:8000/docs", title: "API docs" },
    ],
  });
  await expect(page.locator('li.row[data-key^="5173:"] .tabs')).toHaveText("1 tab");
  await expect(page.locator('li.row[data-key^="8000:"] .tabs')).toHaveText("1 tab");
});

test("a link still starting (begun in an earlier popup) shows as being created, not as Public", async ({ page }) => {
  await openPopup(page, { tunnel: { running: [{ port: 5173, url: null, state: "starting" }] } });
  const row = page.locator('li.row[data-key^="5173:"]');
  await expect(page.locator("li.row")).toHaveCount(10);
  await expect(row.locator(".shared")).toHaveCount(0);
  await row.click({ button: "right" });
  await page.locator("#menu").getByRole("menuitem", { name: "Public Link…" }).click();
  await expect(row.locator(".confirm-text")).toHaveText("Creating a public link… This takes a few seconds.");
  await expect(row.getByRole("button", { name: "Create Link" })).toHaveCount(0);
});
