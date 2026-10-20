import { test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { openPopup, SHOTS } from "../e2e/harness.ts";

// Short clips of the popup's motion for review: screenshots/motion/*.mp4 (needs ffmpeg).
// Run with `npm run record:motion`.
const OUT = resolve(SHOTS, "motion");
const RAW = resolve(OUT, ".raw");

async function clip(browser: Browser, name: string, scheme: "light" | "dark", run: (page: Page) => Promise<void>) {
  mkdirSync(RAW, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 360, height: 540 },
    deviceScaleFactor: 2,
    recordVideo: { dir: RAW, size: { width: 720, height: 1080 } },
  });
  const page = await context.newPage();
  await run(page);
  const video = page.video()!;
  await context.close();
  const webm = resolve(RAW, `${name}.webm`);
  renameSync(await video.path(), webm);
  // H.264 at a modest quality keeps each clip small; the first frames are blank page loading.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "0.25", "-i", webm, "-vf", "scale=360:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30", "-preset", "slow", "-movflags", "+faststart", "-an", resolve(OUT, `${name}.mp4`)]);
  rmSync(webm, { force: true });
}

const open = (page: Page, scheme: "light" | "dark") => openPopup(page, { scheme, reducedMotion: "no-preference" });

test("video: open", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const)
    await clip(browser, `open-${scheme}`, scheme, async (page) => {
      await open(page, scheme);
      await page.waitForTimeout(2600);
    });
});

test("video: refresh", async ({ browser }) => {
  await clip(browser, "refresh-light", "light", async (page) => {
    await open(page, "light");
    await page.waitForTimeout(1200);
    // Two servers stop and one starts; the next 2 s refresh picks it up.
    await page.evaluate(() =>
      (window as any).__mutate((l: any[]) => [
        ...l.filter((x) => x.port !== 5173 && x.port !== 6379),
        { ...l[0], port: 4321, pid: 61000, process: "node", cwd: "/Users/mali/code/blog", command: "node astro dev", startedAt: new Date().toISOString() },
      ]),
    );
    await page.waitForTimeout(3600);
  });
});

test("video: menu", async ({ browser }) => {
  await clip(browser, "menu-dark", "dark", async (page) => {
    await open(page, "dark");
    await page.waitForTimeout(900);
    const row = page.locator('li.row[data-key^="5173"]');
    await row.hover();
    await page.waitForTimeout(300);
    await row.locator('[data-act="menu"]').click();
    await page.waitForTimeout(900);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    await page.locator('li.row[data-key^="8000"]').click({ button: "right", position: { x: 180, y: 24 } });
    await page.waitForTimeout(900);
    await page.locator("#menu").getByRole("menuitem", { name: "Copy URL" }).click();
    await page.waitForTimeout(1200);
  });
});

test("video: panel", async ({ browser }) => {
  await clip(browser, "panel-light", "light", async (page) => {
    await open(page, "light");
    await page.waitForTimeout(900);
    const row = page.locator('li.row[data-key^="8000"]');
    await row.click({ button: "right", position: { x: 180, y: 24 } });
    await page.waitForTimeout(500);
    await page.locator("#menu").getByRole("menuitem", { name: "Open on Phone…" }).click();
    await page.waitForTimeout(1600);
    await row.getByRole("button", { name: "Done" }).click();
    await page.waitForTimeout(900);
    const pg = page.locator('li.row[data-key^="5432"]');
    await pg.hover();
    await pg.locator('[data-act="kill"]').click();
    await page.waitForTimeout(1100);
    await pg.locator('[data-act="quit"]').click();
    await page.waitForTimeout(1800);
  });
});
