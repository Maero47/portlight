// The cross-platform installer, run against throwaway HOMEs. darwin and linux use the real
// launcher and a real ping; win32 runs with a fake reg.exe and a stubbed ping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import { DEFAULT_EXTENSION_IDS, DEV_EXTENSION_ID, STORE_EXTENSION_ID } from "../src/ids.js";
import {
  createContext,
  install,
  InstallError,
  launcherScript,
  locations,
  nodeOfLauncher,
  resolveNode,
  status,
  uninstall,
} from "../src/installer.js";
import { isBrowserLaunch } from "../src/mode.js";

const DIR = fileURLToPath(new URL("..", import.meta.url));
const MAIN = path.join(DIR, "src/main.js");
const OTHER = "abcdefghijklmnopabcdefghijklmnop";
const THIRD = "ponmlkjihgfedcbaponmlkjihgfedcba";
const posix = process.platform !== "win32";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portlight home "));
}

/** A context for `platform` rooted in `home`, collecting output. */
function ctxFor(platform, home, extra = {}) {
  const out = [];
  const ctx = createContext({
    platform,
    home,
    env: { HOME: home, ...(platform === "win32" ? { LOCALAPPDATA: path.join(home, "AppData", "Local") } : {}), ...extra.env },
    log: (s) => out.push(s),
    warn: (s) => out.push(`stderr: ${s}`),
    ...extra,
  });
  ctx.out = out;
  ctx.text = () => out.join("\n");
  ctx.clear = () => out.splice(0);
  return ctx;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// ------------------------------------------------------------------ ids

test("the default IDs are the pinned dev ID plus the store slot when filled", () => {
  assert.equal(DEV_EXTENSION_ID, "mfnkpeccejhabclngfmkadokknojffeo");
  assert.deepEqual(DEFAULT_EXTENSION_IDS, [DEV_EXTENSION_ID, STORE_EXTENSION_ID].filter(Boolean));
  for (const id of DEFAULT_EXTENSION_IDS) assert.match(id, /^[a-p]{32}$/);
});

test("the pinned dev ID matches the key in the extension manifest", () => {
  const out = execFileSync(process.execPath, [path.join(DIR, "../extension/scripts/extension-id.mjs")], { encoding: "utf8" });
  assert.equal(out.trim(), DEV_EXTENSION_ID);
});

// ------------------------------------------------------------------ mode

test("a browser launch runs the host; a person in a terminal gets the CLI", () => {
  assert.equal(isBrowserLaunch([`chrome-extension://${OTHER}/`], true), true, "macOS/Linux launch");
  assert.equal(isBrowserLaunch([`chrome-extension://${OTHER}/`, "--parent-window=0"], false), true, "Windows launch");
  assert.equal(isBrowserLaunch(["--parent-window=1234", `chrome-extension://${OTHER}/`], false), true);
  assert.equal(isBrowserLaunch([], false), true, "piped stdin, as with scripts/frame.js");
  assert.equal(isBrowserLaunch([], true), false, "terminal with no args shows help");
  assert.equal(isBrowserLaunch(["install"], false), false);
  assert.equal(isBrowserLaunch(["status"], true), false);
});

function pingVia(args) {
  const frame = execFileSync(process.execPath, [path.join(DIR, "scripts/frame.js"), '{"id":"t","type":"ping"}']);
  const r = spawnSync(process.execPath, [MAIN, ...args], { input: frame, timeout: 10000 });
  return JSON.parse(r.stdout.subarray(4).toString("utf8"));
}

test("main.js started with Chrome's arguments answers as the native host", () => {
  assert.equal(pingVia([`chrome-extension://${OTHER}/`]).type, "pong");
  assert.equal(pingVia([`chrome-extension://${OTHER}/`, "--parent-window=0"]).type, "pong");
});

test("main.js with no arguments in a terminal prints help and exits", { skip: !posix || !hasPython() }, () => {
  // python's pty gives the child a real terminal on stdin.
  const PTY = [
    "import os, pty, sys",
    "pid, fd = pty.fork()",
    "if pid == 0: os.execv(sys.argv[1], sys.argv[1:])",
    "out = b''",
    "while True:",
    "    try: d = os.read(fd, 4096)",
    "    except OSError: break",
    "    if not d: break",
    "    out += d",
    "os.waitpid(pid, 0)",
    "sys.stdout.write(out.decode())",
  ].join("\n");
  const r = spawnSync("python3", ["-c", PTY, process.execPath, MAIN], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(r.signal, null, "did not hang");
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /portlight-host install/);
});

function hasPython() {
  return spawnSync("python3", ["--version"]).status === 0;
}

// ------------------------------------------------------------------ cli

test("cli: help, version, and usage errors", async () => {
  const ctx = ctxFor("darwin", os.tmpdir());
  assert.equal(await main(["--help"], ctx), 0);
  assert.match(ctx.text(), /portlight-host install \[--extension-id <id>\]/);
  assert.match(ctx.text(), /portlight-host uninstall/);
  assert.match(ctx.text(), /portlight-host status/);
  ctx.clear();
  assert.equal(await main([], ctx), 0);
  assert.match(ctx.text(), /Usage:/);
  ctx.clear();
  assert.equal(await main(["--version"], ctx), 0);
  assert.equal(ctx.text(), readJson(path.join(DIR, "package.json")).version);
  ctx.clear();
  assert.equal(await main(["frobnicate"], ctx), 2);
  assert.match(ctx.text(), /unknown command: frobnicate/);
  ctx.clear();
  assert.equal(await main(["install", "--nope"], ctx), 2);
  assert.match(ctx.text(), /unknown option: --nope/);
  ctx.clear();
  assert.equal(await main(["install", "--extension-id"], ctx), 2);
  ctx.clear();
  assert.equal(await main(["install", "--extension-id", "not-an-id"], ctx), 1);
  assert.match(ctx.text(), /not a Chrome extension ID/);
});

// ------------------------------------------------------------------ darwin / linux

for (const platform of ["darwin", "linux"]) {
  test(`${platform}: install writes host, launcher and manifests; re-run is a no-op; uninstall removes it all`, { skip: !posix }, async () => {
    const home = tempHome();
    try {
      const ctx = ctxFor(platform, home);
      const loc = locations(ctx);
      const chromium = loc.browsers.find((b) => b.label === "Chromium");
      const brave = loc.browsers.find((b) => b.label === "Brave");
      fs.mkdirSync(chromium.profiles[0], { recursive: true });
      fs.mkdirSync(brave.profiles[0], { recursive: true });

      assert.equal(await main(["install"], ctx), 0);
      const first = ctx.text();
      assert.match(first, new RegExp(`wrote +${esc(chromium.manifest)}`));
      assert.match(first, new RegExp(`wrote +${esc(brave.manifest)}`));
      assert.match(first, /skipped +Google Chrome \(not installed\)/);
      assert.match(first, /verified {3}host answers ping/);
      assert.match(first, /Done: 2 browser\(s\)/);

      if (platform === "darwin") assert.equal(loc.installDir, path.join(home, "Library/Application Support/Portlight/host"));
      else assert.equal(loc.installDir, path.join(home, ".local/share/portlight/host"));

      const m = readJson(chromium.manifest);
      assert.deepEqual(m, {
        name: "com.portlight.host",
        description: "Portlight: reports which localhost ports are in use",
        path: path.join(loc.installDir, "portlight-host"),
        type: "stdio",
        allowed_origins: DEFAULT_EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
      });
      assert.ok(fs.statSync(m.path).mode & 0o111, "launcher is executable");
      assert.equal(nodeOfLauncher(fs.readFileSync(m.path, "utf8")), fs.realpathSync(process.execPath));
      for (const f of fs.readdirSync(path.join(DIR, "src"))) {
        assert.ok(fs.existsSync(path.join(loc.installDir, "src", f)), `installed ${f}`);
      }
      assert.ok(!fs.existsSync(path.join(loc.installDir, "test")), "only the host is copied");

      ctx.clear();
      assert.equal(await main(["install"], ctx), 0);
      assert.doesNotMatch(ctx.text(), /\bwrote\b/);
      assert.match(ctx.text(), /unchanged/);

      ctx.clear();
      assert.equal(await main(["status"], ctx), 0);
      assert.match(ctx.text(), /Everything looks fine/);
      assert.match(ctx.text(), /ping +ok/);

      ctx.clear();
      assert.equal(await main(["uninstall"], ctx), 0);
      assert.match(ctx.text(), new RegExp(`removed +${esc(chromium.manifest)}`));
      assert.match(ctx.text(), new RegExp(`removed +${esc(loc.installDir)}`));
      assert.equal(fs.existsSync(chromium.manifest), false);
      assert.equal(fs.existsSync(brave.manifest), false);
      assert.equal(fs.existsSync(loc.installDir), false);
      assert.equal(fs.existsSync(path.dirname(loc.installDir)), false, "empty Portlight folder removed too");
      assert.ok(fs.existsSync(chromium.profiles[0]), "the browser profile itself is untouched");

      ctx.clear();
      assert.equal(await main(["status"], ctx), 1);
      assert.match(ctx.text(), /not installed/);
      assert.match(ctx.text(), /problem: host files are missing/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${platform}: extension IDs merge across installs instead of being replaced`, { skip: !posix }, () => {
    const home = tempHome();
    try {
      const ctx = ctxFor(platform, home);
      const loc = locations(ctx);
      const chromium = loc.browsers.find((b) => b.label === "Chromium");
      fs.mkdirSync(chromium.profiles[0], { recursive: true });
      const origins = () => readJson(chromium.manifest).allowed_origins;

      install(ctx, { ids: [OTHER] });
      assert.deepEqual(origins(), [...DEFAULT_EXTENSION_IDS, OTHER].map((id) => `chrome-extension://${id}/`));
      install(ctx, {});
      assert.deepEqual(origins(), [...DEFAULT_EXTENSION_IDS, OTHER].map((id) => `chrome-extension://${id}/`), "kept without the flag");
      install(ctx, { ids: [THIRD, OTHER] });
      assert.deepEqual(origins(), [...DEFAULT_EXTENSION_IDS, OTHER, THIRD].map((id) => `chrome-extension://${id}/`), "no duplicates");

      // A browser installed later gets the full list too.
      const brave = loc.browsers.find((b) => b.label === "Brave");
      fs.mkdirSync(brave.profiles[0], { recursive: true });
      install(ctx, {});
      assert.deepEqual(readJson(brave.manifest).allowed_origins, origins());

      const s = status(ctx);
      assert.deepEqual(s.browsers.find((b) => b.label === "Brave").ids, [...DEFAULT_EXTENSION_IDS, OTHER, THIRD]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${platform}: --all-browsers registers browsers that don't look installed; none found is an error`, { skip: !posix }, async () => {
    const home = tempHome();
    try {
      const ctx = ctxFor(platform, home);
      assert.equal(await main(["install"], ctx), 1);
      assert.match(ctx.text(), /no supported browser found/);
      ctx.clear();
      assert.equal(await main(["install", "--all-browsers"], ctx), 0);
      for (const b of locations(ctx).browsers) assert.ok(fs.existsSync(b.manifest), b.label);
      assert.doesNotMatch(ctx.text(), /skipped/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("linux: XDG_CONFIG_HOME and XDG_DATA_HOME are honoured", () => {
  const ctx = ctxFor("linux", "/home/u", { env: { XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "/data" } });
  const loc = locations(ctx);
  assert.equal(loc.installDir, path.join("/data", "portlight", "host"));
  assert.equal(loc.browsers.find((b) => b.label === "Google Chrome").manifest, path.join("/cfg/google-chrome/NativeMessagingHosts/com.portlight.host.json"));
});

test("an install over files from an older version drops the stale ones", { skip: !posix }, () => {
  const home = tempHome();
  try {
    const ctx = ctxFor("darwin", home);
    const loc = locations(ctx);
    fs.mkdirSync(path.join(loc.installDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(loc.installDir, "src", "gone.js"), "");
    install(ctx, { allBrowsers: true });
    assert.equal(fs.existsSync(path.join(loc.installDir, "src", "gone.js")), false);
    assert.match(ctx.text(), /removed +.*gone\.js/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a failed ping fails the install", { skip: !posix }, () => {
  const home = tempHome();
  try {
    const ctx = ctxFor("darwin", home, { ping: () => ({ ok: false, error: "boom" }) });
    assert.throws(() => install(ctx, { allBrowsers: true }), (e) => e instanceof InstallError && /did not answer a ping:\nboom/.test(e.message));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ node path

test("the launcher pins Homebrew's stable opt/ node instead of the versioned Cellar path", { skip: !posix }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "portlight brew ")));
  try {
    const cellarBin = path.join(root, "Cellar/node/22.9.0/bin");
    fs.mkdirSync(cellarBin, { recursive: true });
    fs.writeFileSync(path.join(cellarBin, "node"), ""); // never run: nodeVersion comes from the context
    fs.mkdirSync(path.join(root, "opt"));
    fs.symlinkSync("../Cellar/node/22.9.0", path.join(root, "opt/node"));
    const ctx = ctxFor("darwin", root, { execPath: path.join(cellarBin, "node") });
    assert.equal(resolveNode(ctx).node, path.join(root, "opt/node/bin/node"));
    // Without the opt link the Cellar path is kept.
    fs.rmSync(path.join(root, "opt/node"));
    assert.equal(resolveNode(ctx).node, path.join(cellarBin, "node"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("node older than 18 is refused", () => {
  const ctx = ctxFor("darwin", os.tmpdir(), { nodeVersion: "16.20.0" });
  assert.throws(() => resolveNode(ctx), /Node\.js 18\+ is required, found 16\.20\.0/);
});

test("launcher scripts quote paths with spaces and quotes, and nodeOfLauncher reads them back", () => {
  const sh = launcherScript("darwin", "/Users/o'neil/my node/bin/node", "/Users/o'neil/Library/Application Support/Portlight/host");
  assert.equal(
    sh,
    `#!/bin/sh\nexec '/Users/o'\\''neil/my node/bin/node' '/Users/o'\\''neil/Library/Application Support/Portlight/host/src/main.js' "$@"\n`,
  );
  assert.equal(nodeOfLauncher(sh), "/Users/o'neil/my node/bin/node");

  const cmd = launcherScript("win32", "C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\A B\\AppData\\Local\\Portlight\\host");
  assert.equal(cmd, '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "%~dp0src\\main.js" %*\r\n');
  assert.equal(nodeOfLauncher(cmd), "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(launcherScript("win32", "C:\\100%\\node.exe", "x").split("\r\n")[1], '"C:\\100%%\\node.exe" "%~dp0src\\main.js" %*');
  assert.equal(nodeOfLauncher(launcherScript("win32", "C:\\100%\\node.exe", "x")), "C:\\100%\\node.exe");

  // Launchers written by the old shell installer.
  assert.equal(nodeOfLauncher('#!/bin/sh\nexec "/usr/bin/node" "/x/src/main.js" "$@"\n'), "/usr/bin/node");
});

test("the posix launcher really runs from a path with spaces and a quote", { skip: !posix }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portlight it's here "));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/main.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
    const launcher = path.join(dir, "portlight-host");
    fs.writeFileSync(launcher, launcherScript(process.platform, process.execPath, dir), { mode: 0o755 });
    assert.equal(execFileSync(launcher, ["a b", "c"], { encoding: "utf8" }).trim(), '["a b","c"]');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ win32 (mocked)

/** An in-memory HKCU that answers like reg.exe. */
function fakeReg() {
  const keys = new Map();
  const calls = [];
  const reg = (args) => {
    calls.push(args);
    const [op, key] = args;
    if (!/^HKCU\\Software\\/.test(key)) return { status: 1, stdout: "", stderr: "ERROR: Invalid key name." };
    if (op === "query") {
      if (!keys.has(key)) return { status: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
      return { status: 0, stdout: `\r\n${key}\r\n    (Default)    REG_SZ    ${keys.get(key)}\r\n\r\n`, stderr: "" };
    }
    if (op === "add") {
      assert.deepEqual(args.slice(2, 6), ["/ve", "/t", "REG_SZ", "/d"]);
      assert.equal(args[7], "/f");
      keys.set(key, args[6]);
      return { status: 0, stdout: "The operation completed successfully.\r\n", stderr: "" };
    }
    if (op === "delete") {
      assert.equal(args[2], "/f");
      keys.delete(key);
      return { status: 0, stdout: "The operation completed successfully.\r\n", stderr: "" };
    }
    throw new Error(`unexpected reg ${args.join(" ")}`);
  };
  return { reg, keys, calls };
}

function winCtx(home, extra = {}) {
  const r = fakeReg();
  const pings = [];
  const ctx = ctxFor("win32", home, {
    reg: r.reg,
    ping: (_c, launcher, origin) => {
      pings.push({ launcher, origin });
      return { ok: true, message: { type: "pong", version: 1, hostVersion: "0.1.0" } };
    },
    ...extra,
  });
  return Object.assign(ctx, { regState: r, pings });
}

test("win32: install writes a .cmd launcher, one manifest, and HKCU keys for installed browsers", async () => {
  const home = tempHome();
  try {
    const ctx = winCtx(home);
    const local = path.join(home, "AppData", "Local");
    fs.mkdirSync(path.join(local, "Microsoft", "Edge", "User Data"), { recursive: true });
    fs.mkdirSync(path.join(local, "Google", "Chrome SxS", "User Data"), { recursive: true }); // Canary
    const loc = locations(ctx);
    assert.equal(loc.installDir, path.join(local, "Portlight", "host"));
    assert.equal(loc.launcher, path.join(loc.installDir, "portlight-host.cmd"));

    assert.equal(await main(["install", "--extension-id", OTHER], ctx), 0);
    const text = ctx.text();
    const edgeKey = "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.portlight.host";
    const chromeKey = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.portlight.host";
    assert.match(text, new RegExp(`wrote +${esc(edgeKey)}`));
    assert.match(text, new RegExp(`wrote +${esc(chromeKey)}`), "Canary shares Chrome's key");
    assert.match(text, /skipped +Brave \(not installed\)/);
    assert.match(text, /skipped +Vivaldi \(not installed\)/);
    assert.match(text, new RegExp(`wrote +${esc(loc.launcher)}`));
    assert.match(text, /Done: 2 browser\(s\)/);
    assert.deepEqual([...ctx.regState.keys.keys()].sort(), [chromeKey, edgeKey].sort());
    for (const v of ctx.regState.keys.values()) assert.equal(v, loc.manifest);

    const m = readJson(loc.manifest);
    assert.equal(m.path, loc.launcher, "absolute launcher path");
    assert.deepEqual(m.allowed_origins, [...DEFAULT_EXTENSION_IDS, OTHER].map((id) => `chrome-extension://${id}/`));
    const cmd = fs.readFileSync(loc.launcher, "utf8");
    assert.equal(cmd, `@echo off\r\n"${process.execPath}" "%~dp0src\\main.js" %*\r\n`);
    assert.ok(fs.existsSync(path.join(loc.installDir, "src", "main.js")));
    assert.deepEqual(ctx.pings, [{ launcher: loc.launcher, origin: `chrome-extension://${DEFAULT_EXTENSION_IDS[0]}/` }]);

    // Re-run: nothing written, keys left alone, IDs kept.
    ctx.clear();
    ctx.regState.calls.length = 0;
    assert.equal(await main(["install"], ctx), 0);
    assert.doesNotMatch(ctx.text(), /\bwrote\b/);
    assert.match(ctx.text(), new RegExp(`unchanged +${esc(edgeKey)}`));
    assert.ok(!ctx.regState.calls.some((c) => c[0] === "add"));
    assert.deepEqual(readJson(loc.manifest).allowed_origins, [...DEFAULT_EXTENSION_IDS, OTHER].map((id) => `chrome-extension://${id}/`));

    ctx.clear();
    assert.equal(await main(["status"], ctx), 0);
    assert.match(ctx.text(), new RegExp(`Microsoft Edge +${esc(loc.manifest)} \\(${esc(edgeKey)}\\)`));
    assert.match(ctx.text(), new RegExp(`allows ${DEFAULT_EXTENSION_IDS.join(", ")}, ${OTHER}`));
    const s = status(ctx);
    assert.equal(s.ok, true);
    assert.equal(s.node, process.execPath);
    assert.equal(s.browsers.find((b) => b.label === "Brave").registered, false);

    ctx.clear();
    assert.equal(await main(["uninstall"], ctx), 0);
    assert.match(ctx.text(), new RegExp(`removed +${esc(edgeKey)}`));
    assert.match(ctx.text(), new RegExp(`removed +${esc(chromeKey)}`));
    assert.match(ctx.text(), new RegExp(`removed +${esc(loc.installDir)}`));
    assert.equal(ctx.regState.keys.size, 0);
    assert.equal(fs.existsSync(loc.installDir), false);
    assert.ok(!ctx.regState.calls.some((c) => c[0] === "delete" && /Brave/.test(c[1])), "only deletes keys that exist");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("win32: keys a previous install wrote are kept current even if the browser folder is gone", () => {
  const home = tempHome();
  try {
    const ctx = winCtx(home);
    const key = "HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\com.portlight.host";
    ctx.regState.keys.set(key, "C:\\old\\com.portlight.host.json");
    const r = install(ctx, {});
    assert.deepEqual(r.browsers, ["Vivaldi"]);
    assert.equal(ctx.regState.keys.get(key), locations(ctx).manifest);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("win32: --all-browsers writes every key; a reg.exe failure is reported", () => {
  const home = tempHome();
  try {
    const ctx = winCtx(home);
    install(ctx, { allBrowsers: true });
    assert.equal(ctx.regState.keys.size, locations(ctx).browsers.length);

    const failing = winCtx(tempHome(), {
      reg: (args) => (args[0] === "add" ? { status: 1, stdout: "", stderr: "ERROR: Access is denied." } : { status: 1, stdout: "", stderr: "" }),
    });
    assert.throws(() => install(failing, { allBrowsers: true }), /reg add HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.portlight\.host failed: ERROR: Access is denied\./);
    fs.rmSync(failing.home, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("win32: upgrading from the PowerShell installer keeps its IDs and drops its .bat", () => {
  const home = tempHome();
  try {
    const ctx = winCtx(home);
    const loc = locations(ctx);
    fs.mkdirSync(loc.installDir, { recursive: true });
    fs.writeFileSync(path.join(loc.installDir, "portlight-host.bat"), "@echo off\r\n");
    // ConvertTo-Json output from the old install.ps1.
    fs.writeFileSync(
      loc.manifest,
      JSON.stringify({ name: "com.portlight.host", description: "x", path: path.join(loc.installDir, "portlight-host.bat"), type: "stdio", allowed_origins: [`chrome-extension://${THIRD}/`] }),
    );
    install(ctx, { allBrowsers: true });
    assert.equal(fs.existsSync(path.join(loc.installDir, "portlight-host.bat")), false);
    assert.deepEqual(readJson(loc.manifest).allowed_origins, [...DEFAULT_EXTENSION_IDS, THIRD].map((id) => `chrome-extension://${id}/`));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("win32: the registry default value is read whatever the localised label", async () => {
  const { regDefault } = await import("../src/installer.js");
  const ctx = { reg: () => ({ status: 0, stdout: "\r\nHKEY_CURRENT_USER\\Software\\X\r\n    (Standard)    REG_SZ    C:\\Users\\A B\\m.json\r\n" }) };
  assert.equal(regDefault(ctx, "HKCU\\Software\\X"), "C:\\Users\\A B\\m.json");
  assert.equal(regDefault({ reg: () => ({ status: 1, stdout: "" }) }, "HKCU\\Software\\X"), null);
});

test("unsupported platforms are refused", () => {
  assert.throws(() => locations(ctxFor("aix", os.tmpdir())), /unsupported platform: aix/);
});

// ------------------------------------------------------------------ polish

test("a host that doesn't answer is never registered with a browser", { skip: !posix }, () => {
  const home = tempHome();
  try {
    const ctx = ctxFor("darwin", home, { ping: () => ({ ok: false, error: "boom" }) });
    const loc = locations(ctx);
    fs.mkdirSync(loc.browsers.find((b) => b.label === "Chromium").profiles[0], { recursive: true });
    assert.throws(() => install(ctx, {}), /did not answer a ping/);
    for (const b of loc.browsers) assert.equal(fs.existsSync(b.manifest), false, b.label);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("win32: a host that doesn't answer gets no registry keys", () => {
  const home = tempHome();
  try {
    const ctx = winCtx(home, { ping: () => ({ ok: false, error: "boom" }) });
    assert.throws(() => install(ctx, { allBrowsers: true }), /did not answer a ping/);
    assert.equal(ctx.regState.keys.size, 0);
    assert.ok(!ctx.regState.calls.some((c) => c[0] === "add"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("linux: Snap and Flatpak browsers get a note and nothing written", { skip: !posix }, () => {
  const home = tempHome();
  try {
    fs.mkdirSync(path.join(home, "snap/chromium"), { recursive: true });
    fs.mkdirSync(path.join(home, ".var/app/com.brave.Browser"), { recursive: true });
    const ctx = ctxFor("linux", home);
    install(ctx, { allBrowsers: true });
    assert.match(ctx.text(), /note +Chromium \(Snap\), Brave \(Flatpak\) run in a sandbox/);
    assert.deepEqual(fs.readdirSync(path.join(home, "snap/chromium")), []);
    assert.deepEqual(fs.readdirSync(path.join(home, ".var/app/com.brave.Browser")), []);

    const plain = ctxFor("linux", tempHome());
    install(plain, { allBrowsers: true });
    assert.doesNotMatch(plain.text(), /sandbox/);
    fs.rmSync(plain.home, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("until the store ID is known, install points store users at --extension-id", { skip: !posix || Boolean(STORE_EXTENSION_ID) }, () => {
  const home = tempHome();
  try {
    const ctx = ctxFor("darwin", home);
    install(ctx, { allBrowsers: true });
    assert.match(ctx.text(), /Chrome Web Store\?.*\n {2}portlight-host install --extension-id <id>/);
    ctx.clear();
    install(ctx, { allBrowsers: true, ids: [OTHER] });
    assert.doesNotMatch(ctx.text(), /Chrome Web Store\?/, "not when an ID was just given");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
