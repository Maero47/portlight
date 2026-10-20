import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

// Checks the Web Store zip itself (npm run build:store makes it, then runs this).
const ROOT = resolve(import.meta.dirname, "../..");
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const ZIP = join(ROOT, "release", `portlight-${VERSION}.zip`);

let dir: string;
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "portlight-zip-"));
  execFileSync("unzip", ["-q", ZIP, "-d", dir]);
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

test("the manifest has no key and carries the package.json version", () => {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest).not.toHaveProperty("key");
  expect(manifest.version).toBe(VERSION);
  expect(VERSION).not.toBe("0.0.0");
});

test("every file the manifest and pages reference is in the zip, and nothing else is", () => {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const refs = new Set<string>([
    m.action.default_popup,
    m.options_ui.page,
    m.background.service_worker,
    ...Object.values<string>(m.icons),
    ...Object.values<string>(m.action.default_icon),
  ]);
  for (const page of [m.action.default_popup, m.options_ui.page]) {
    const html = readFileSync(join(dir, page), "utf8");
    for (const [, url = ""] of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      if (!/^[a-z]+:/.test(url)) refs.add(join(dirname(page), url));
    }
  }
  for (const ref of refs) expect(existsSync(join(dir, ref)), ref).toBe(true);

  const files = walk(dir).map((f) => relative(dir, f));
  expect(files.filter((f) => !/^(manifest\.json|[\w/.-]+\.(html|js|css|png))$/.test(f))).toEqual([]);
  expect(files.filter((f) => /\.map$|test|spec|screenshot/i.test(f))).toEqual([]);
});

test("the unzipped extension loads in Chromium and the popup renders in fallback mode", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "portlight-zip-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;

    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`chrome-extension://${id}/popup.html`);
    // Without the key the ID is not one the helper answers, so this is always the HTTP fallback.
    await expect(page.locator("#app")).toHaveAttribute("data-mode", "fallback");
    await expect(page.getByRole("dialog")).toBeVisible();
    // An unpinned ID is not in the helper's defaults, so the popup asks for it explicitly.
    await expect(page.locator(".sheet .code code")).toHaveText(`npx portlight-host install --extension-id ${id}`);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
