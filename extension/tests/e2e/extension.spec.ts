import { chromium, expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST } from "./harness.ts";

// Loads the real unpacked build. No native host is mocked here, so the popup
// should land on onboarding (or on live data if a host happens to be installed).
test("the built extension loads, registers its worker and opens the popup cleanly", async () => {
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toContain("nativeMessaging");

  const userDataDir = mkdtempSync(join(tmpdir(), "portlight-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    expect(id).toMatch(/^[a-p]{32}$/);

    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`chrome-extension://${id}/popup.html`);
    await expect(page.locator("#app")).toHaveAttribute("data-mode", /^(missing|host)$/);
    if ((await page.locator("#app").getAttribute("data-mode")) === "missing") {
      await expect(page.locator(".code code")).toHaveText(`host/install.sh ${id}`);
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
