// Pin the extension ID by putting a public key into src/manifest.json.
//
//   node scripts/keygen.mjs                  new key pair (refuses if one exists)
//   node scripts/keygen.mjs --from KEY.pem   re-derive the manifest key from a saved private key
//
// The private key goes to ../.keys/portlight-extension.pem, which is gitignored.
// Only the public half ships. A new key means a new extension ID, so keep the .pem
// somewhere safe; with it you can always restore the same ID.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, MANIFEST } from "./extension-id.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PEM = resolve(repo, ".keys/portlight-extension.pem");

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
let privatePem;

if (fromIdx >= 0) {
  const file = args[fromIdx + 1];
  if (!file) throw new Error("--from needs a path to a PEM private key");
  privatePem = readFileSync(file, "utf8");
} else {
  if (existsSync(DEFAULT_PEM)) {
    console.error(`${DEFAULT_PEM} already exists. Use --from to reuse it; delete it first to change the extension ID.`);
    process.exit(1);
  }
  ({ privateKey: privatePem } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }));
  mkdirSync(dirname(DEFAULT_PEM), { recursive: true, mode: 0o700 });
  writeFileSync(DEFAULT_PEM, privatePem, { mode: 0o600 });
  console.log(`private key  ${DEFAULT_PEM}  (gitignored — back it up)`);
}

const der = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "der" });
const key = Buffer.from(der).toString("base64");

// Keep "key" right after "version" so the manifest stays readable.
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const out = {};
for (const [k, v] of Object.entries(manifest)) {
  if (k === "key") continue;
  out[k] = v;
  if (k === "version") out.key = key;
}
writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + "\n");
console.log(`manifest key ${MANIFEST}`);
console.log(`extension ID ${extensionIdFromKey(key)}`);
