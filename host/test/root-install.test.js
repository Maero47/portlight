// Runs the root install.sh in a scratch copy of the repo layout, with a fake npm and a
// stub host installer, to check when it re-runs `npm ci` in extension/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const skip = !["darwin", "linux"].includes(process.platform);

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portlight root "));
  const write = (rel, body, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body, { mode });
  };
  fs.copyFileSync(path.join(REPO, "install.sh"), path.join(root, "install.sh"));
  fs.chmodSync(path.join(root, "install.sh"), 0o755);
  write("extension/package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  write("extension/scripts/extension-id.mjs", 'console.log("abcdefghijklmnopabcdefghijklmnop");\n');
  write("host/install.sh", "#!/bin/sh\nexit 0\n", 0o755);
  // Fake npm: logs its args; `ci` wipes and recreates node_modules like the real one.
  write(
    "bin/npm",
    `#!/bin/sh\necho "$*" >>"${path.join(root, "npm.log")}"\nif [ "$1" = ci ]; then rm -rf node_modules && mkdir node_modules; fi\n`,
    0o755,
  );
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, PATH: `${path.join(root, "bin")}:${process.env.PATH}` };
  const run = () => execFileSync(path.join(root, "install.sh"), [], { env, encoding: "utf8" });
  const ciCount = () =>
    fs.existsSync(path.join(root, "npm.log"))
      ? fs.readFileSync(path.join(root, "npm.log"), "utf8").split("\n").filter((l) => l.startsWith("ci ")).length
      : 0;
  return { root, run, ciCount };
}

test("root install.sh re-runs npm ci only when extension/package-lock.json changes", { skip }, () => {
  const { root, run, ciCount } = scratch();
  try {
    assert.match(run(), /installing build tools/);
    assert.equal(ciCount(), 1, "first run installs");

    assert.doesNotMatch(run(), /installing build tools/);
    assert.equal(ciCount(), 1, "unchanged lockfile skips npm ci");

    // A pull that adds a dependency: node_modules exists but is stale.
    fs.writeFileSync(path.join(root, "extension/package-lock.json"), '{"lockfileVersion":3,"packages":{"node_modules/jsqr":{}}}\n');
    assert.match(run(), /installing build tools/);
    assert.equal(ciCount(), 2, "changed lockfile re-runs npm ci");

    assert.doesNotMatch(run(), /installing build tools/);
    assert.equal(ciCount(), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("root install.sh re-runs npm ci for a node_modules installed before the stamp existed", { skip }, () => {
  const { root, run, ciCount } = scratch();
  try {
    fs.mkdirSync(path.join(root, "extension/node_modules"));
    assert.match(run(), /installing build tools/);
    assert.equal(ciCount(), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
