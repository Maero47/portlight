import { chromium, expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST } from "./harness.ts";

// The real unpacked build: the manifest's options page exists, opens, and saves to real chrome.storage.local.
test("the built extension opens its options page and saves to chrome.storage.local", async () => {
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  expect(manifest.options_ui).toEqual({ page: "options.html", open_in_tab: true });

  const userDataDir = mkdtempSync(join(tmpdir(), "portlight-e2e-options-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;

    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`chrome-extension://${id}/${manifest.options_ui.page}`);
    await expect(page.locator("#page")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#version")).toHaveText(manifest.version);
    await expect(page.locator("#helper-text")).toHaveText(/^(Connected|Not installed|Needs reinstall|Not responding)$/);

    await page.getByLabel("Open projects in").selectOption("cursor");
    await expect
      .poll(() => worker.evaluate(async () => ((await chrome.storage.local.get("portlight.settings"))["portlight.settings"] as { editor?: string } | undefined)?.editor))
      .toBe("cursor");
    await page.reload();
    await expect(page.getByLabel("Open projects in")).toHaveValue("cursor");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
