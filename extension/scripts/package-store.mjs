// Packs dist/ into release/portlight-<version>.zip for the Chrome Web Store.
// Run after `npm run build` (npm run build:store does both, then verifies the zip).
//
// The store copy differs from dist/ in one way: manifest.json has no "key". The store
// assigns its own ID and rejects uploads that carry one; the dev build keeps it so the
// unpacked extension's ID stays pinned for install.sh.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const release = resolve(root, "release");

// Everything the extension loads at runtime. Anything else in dist/ (source maps, stray files) stays out.
const RUNTIME = /\.(html|js|css|png)$/;

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error(`dist/manifest.json is ${manifest.version}, package.json is ${pkg.version}; rebuild`);
delete manifest.key;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = walk(dist)
  .map((f) => relative(dist, f))
  .filter((f) => f !== "manifest.json" && RUNTIME.test(f))
  .sort();

const stage = mkdtempSync(join(tmpdir(), "portlight-store-"));
try {
  for (const f of files) {
    mkdirSync(dirname(join(stage, f)), { recursive: true });
    cpSync(join(dist, f), join(stage, f));
  }
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  mkdirSync(release, { recursive: true });
  const zip = join(release, `portlight-${pkg.version}.zip`);
  rmSync(zip, { force: true });
  // -X drops extra file attributes, -D leaves out directory entries.
  execFileSync("zip", ["-q", "-X", "-D", zip, "manifest.json", ...files], { cwd: stage, stdio: "inherit" });
  console.log(`${relative(root, zip)}: manifest.json + ${files.length} files, no "key", version ${pkg.version}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
