import { chromium, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST } from "./harness.ts";

// Chrome's Local Network Access (LNA) gates requests to localhost from less-private contexts.
// The HTTP-only fallback fetches http://localhost:PORT from the extension popup, and tab linking
// reads localhost tab URLs; both rely only on the manifest's host permissions. These tests load the
// real build in Chromium with no native host and check both, with LNA as shipped and forced on.
const MODES = {
  default: [] as string[],
  "LNA enforced": ["--enable-features=LocalNetworkAccessChecks:LocalNetworkAccessChecksWarn/false"],
};

for (const [mode, flags] of Object.entries(MODES)) {
  test(`HTTP fallback and tab linking work under Local Network Access (${mode})`, async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>LNA probe target</title><p>ok</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const userDataDir = mkdtempSync(join(tmpdir(), "portlight-lna-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, ...flags],
    });
    try {
      let [worker] = context.serviceWorkers();
      worker ??= await context.waitForEvent("serviceworker");
      const id = new URL(worker.url()).host;

      // A real tab on the server, so the popup can link it (no "tabs" permission involved).
      const tab = await context.newPage();
      await tab.goto(`http://localhost:${port}/`);
      await expect(tab).toHaveTitle("LNA probe target");

      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => {
        // Probes are expected to hit refusals and non-2xx answers (AirPlay's 403 on 5000/7000), which
        // Chrome logs itself; anything else is a failure.
        if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(m.text());
      });
      await page.goto(`chrome-extension://${id}/popup.html`);
      await expect(page.locator("#app")).toHaveAttribute("data-mode", /^(fallback|host)$/);
      test.skip((await page.locator("#app").getAttribute("data-mode")) === "host", "a native host is installed for this profile");

      // The port is random, so it reaches the scan through the user's extra probe ports.
      await page.evaluate((p) => chrome.storage.local.set({ "portlight.settings": { version: 1, extraProbePorts: [p] } }), port);
      // Without a helper the popup scans by itself; the install sheet sits on top until put away.
      await page.reload();
      await page.getByRole("button", { name: "Not now" }).click();
      const row = page.locator(`li.row[data-key="${port}:http"]`);
      await expect(row.locator(".name")).toHaveText("LNA probe target", { timeout: 20_000 });
      await expect(row.locator(".tabs")).toHaveText("1 tab");

      // Direct fetch from the extension page: no LNA prompt, no CORS block.
      const status = await page.evaluate(async (p) => (await fetch(`http://localhost:${p}/`, { cache: "no-store" })).status, port);
      expect(status).toBe(200);

      // Clicking the row switches to that tab rather than opening a duplicate.
      const before = context.pages().length;
      await row.locator(".row-main").click();
      await expect.poll(() => tab.evaluate(() => document.visibilityState)).toBe("visible");
      expect(context.pages().length).toBe(before);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
