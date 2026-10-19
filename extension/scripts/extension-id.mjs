// The extension ID is derived from the public key in src/manifest.json ("key"),
// so it is the same on every machine that loads the unpacked build.
//
//   node scripts/extension-id.mjs   → prints the pinned ID
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), "../src/manifest.json");

/** Chrome's rule: SHA-256 of the DER public key, first 32 hex digits, 0-f mapped to a-p. */
export function extensionIdFromKey(base64Der) {
  const hex = createHash("sha256").update(Buffer.from(base64Der, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export function pinnedExtensionId(manifestPath = MANIFEST) {
  const { key } = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!key) throw new Error(`${manifestPath} has no "key"; run scripts/keygen.mjs`);
  return extensionIdFromKey(key);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(pinnedExtensionId());
}
