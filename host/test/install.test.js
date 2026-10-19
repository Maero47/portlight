// Runs install.sh / uninstall.sh against a throwaway HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("..", import.meta.url));
const ID = "abcdefghijklmnopabcdefghijklmnop";
const skip = !["darwin", "linux"].includes(process.platform);

function paths(home) {
  if (process.platform === "darwin") {
    const as = path.join(home, "Library/Application Support");
    return { profile: path.join(as, "Google/Chrome"), installDir: path.join(as, "Portlight/host") };
  }
  return { profile: path.join(home, ".config/google-chrome"), installDir: path.join(home, ".local/share/portlight/host") };
}

test("install.sh is idempotent, reports what it wrote, and uninstall.sh removes it", { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "portlight home "));
  const env = { ...process.env, HOME: home, NODE: process.execPath, XDG_CONFIG_HOME: "", XDG_DATA_HOME: "" };
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  const { profile, installDir } = paths(home);
  fs.mkdirSync(profile, { recursive: true });
  const manifestPath = path.join(profile, "NativeMessagingHosts/com.portlight.host.json");
  try {
    const first = execFileSync(path.join(DIR, "install.sh"), [ID], { env, encoding: "utf8" });
    assert.match(first, new RegExp(`wrote +${manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
    assert.equal(manifest.name, "com.portlight.host");
    assert.equal(manifest.type, "stdio");
    assert.equal(manifest.path, path.join(installDir, "portlight-host"));
    assert.ok(fs.statSync(manifest.path).mode & 0o111, "launcher is executable");

    const second = execFileSync(path.join(DIR, "install.sh"), [ID], { env, encoding: "utf8" });
    assert.doesNotMatch(second, /wrote/);
    assert.match(second, /unchanged/);

    const un = execFileSync(path.join(DIR, "uninstall.sh"), [], { env, encoding: "utf8" });
    assert.match(un, /removed/);
    assert.equal(fs.existsSync(manifestPath), false);
    assert.equal(fs.existsSync(installDir), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install.sh rejects a malformed extension id", { skip }, () => {
  assert.throws(() => execFileSync(path.join(DIR, "install.sh"), ["not-an-id"], { stdio: "pipe" }), /not a Chrome extension ID/);
});
