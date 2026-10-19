// Post-build: write manifest.json and copy the icons from ../assets/icons into dist/.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const artwork = resolve(root, "../assets/icons");
const SIZES = [16, 32, 48, 128];

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "src/manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(resolve(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

mkdirSync(resolve(dist, "icons"), { recursive: true });
for (const size of SIZES) copyFileSync(resolve(artwork, `icon-${size}.png`), resolve(dist, `icons/icon-${size}.png`));
console.log(`dist/manifest.json written; ${SIZES.length} icons copied from assets/icons`);
