// Installs the host for Chromium browsers on macOS, Linux and Windows (per user, no admin).
//
// The host is copied to a stable per-user directory (never the npx cache or a Homebrew
// Cellar version dir, which come and go), started through a launcher that pins an absolute
// node path (browsers start hosts with a minimal PATH), and registered with each browser:
// a manifest file in its NativeMessagingHosts folder (macOS/Linux) or an HKCU registry
// key pointing at one manifest file (Windows, via reg.exe).
//
// Everything OS-specific comes from a context object, so tests can run the win32 branch
// on any machine with a fake registry and a temp HOME.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "./framing.js";
import { DEFAULT_EXTENSION_IDS, STORE_EXTENSION_ID, idOfOrigin, isExtensionId, originOf } from "./ids.js";
import { HOST_NAME } from "./protocol.js";

const DESCRIPTION = "Portlight: reports which localhost ports are in use";
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

export class InstallError extends Error {}

/** Everything the installer reads from the outside world. Tests override any of it. */
export function createContext(overrides = {}) {
  const env = overrides.env ?? process.env;
  const platform = overrides.platform ?? process.platform;
  return {
    platform,
    env,
    home: overrides.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir(),
    execPath: overrides.execPath ?? process.execPath,
    nodeVersion: overrides.nodeVersion ?? process.versions.node,
    srcDir: overrides.srcDir ?? PACKAGE_DIR,
    log: overrides.log ?? ((s) => console.log(s)),
    warn: overrides.warn ?? ((s) => console.error(s)),
    reg: overrides.reg ?? runReg,
    ping: overrides.ping ?? pingLauncher,
  };
}

const line = (label, text) => `  ${label.padEnd(10)} ${text}`;

// ---------------------------------------------------------------- locations

/** Per-user browser locations. `profile` existing means "installed". */
export function locations(ctx) {
  const { platform, env, home } = ctx;
  if (platform === "darwin") {
    const as = path.join(home, "Library", "Application Support");
    const installDir = path.join(as, "Portlight", "host");
    const browsers = [
      ["Google Chrome", "Google/Chrome"],
      ["Google Chrome Beta", "Google/Chrome Beta"],
      ["Google Chrome Dev", "Google/Chrome Dev"],
      ["Google Chrome Canary", "Google/Chrome Canary"],
      ["Chromium", "Chromium"],
      ["Brave", "BraveSoftware/Brave-Browser"],
      ["Microsoft Edge", "Microsoft Edge"],
      ["Microsoft Edge Beta", "Microsoft Edge Beta"],
      ["Microsoft Edge Dev", "Microsoft Edge Dev"],
      ["Arc", "Arc/User Data"],
      ["Vivaldi", "Vivaldi"],
    ].map(([label, rel]) => fileBrowser(label, path.join(as, ...rel.split("/"))));
    return { installDir, launcher: path.join(installDir, "portlight-host"), browsers };
  }
  if (platform === "linux") {
    const data = env.XDG_DATA_HOME || path.join(home, ".local", "share");
    const cfg = env.XDG_CONFIG_HOME || path.join(home, ".config");
    const installDir = path.join(data, "portlight", "host");
    const browsers = [
      ["Google Chrome", "google-chrome"],
      ["Google Chrome Beta", "google-chrome-beta"],
      ["Google Chrome Unstable", "google-chrome-unstable"],
      ["Chromium", "chromium"],
      ["Brave", "BraveSoftware/Brave-Browser"],
      ["Microsoft Edge", "microsoft-edge"],
      ["Microsoft Edge Beta", "microsoft-edge-beta"],
      ["Microsoft Edge Dev", "microsoft-edge-dev"],
      ["Vivaldi", "vivaldi"],
    ].map(([label, rel]) => fileBrowser(label, path.join(cfg, ...rel.split("/"))));
    return { installDir, launcher: path.join(installDir, "portlight-host"), browsers };
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const installDir = path.join(local, "Portlight", "host");
    // Chrome Beta/Dev/Canary read the same key as Chrome stable.
    const browsers = [
      ["Google Chrome", "Google\\Chrome", ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome SxS"]],
      ["Chromium", "Chromium", ["Chromium"]],
      ["Brave", "BraveSoftware\\Brave-Browser", ["BraveSoftware/Brave-Browser"]],
      ["Microsoft Edge", "Microsoft\\Edge", ["Microsoft/Edge", "Microsoft/Edge Beta", "Microsoft/Edge Dev", "Microsoft/Edge SxS"]],
      ["Vivaldi", "Vivaldi", ["Vivaldi"]],
    ].map(([label, vendor, dirs]) => ({
      label,
      regKey: `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${HOST_NAME}`,
      profiles: dirs.map((d) => path.join(local, ...d.split("/"), "User Data")),
    }));
    return {
      installDir,
      launcher: path.join(installDir, "portlight-host.cmd"),
      manifest: path.join(installDir, `${HOST_NAME}.json`),
      browsers,
    };
  }
  throw new InstallError(`unsupported platform: ${platform}`);
}

function fileBrowser(label, profile) {
  return { label, profiles: [profile], manifest: path.join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`) };
}

/**
 * Linux browsers from Snap or Flatpak. Their sandbox can't start native messaging hosts,
 * so the installer only mentions them and writes nothing there.
 */
export function sandboxedBrowsers(ctx) {
  const snaps = [["Chromium (Snap)", "chromium"], ["Brave (Snap)", "brave"]];
  const flatpaks = [
    ["Chromium (Flatpak)", "org.chromium.Chromium"],
    ["Ungoogled Chromium (Flatpak)", "io.github.ungoogled_software.ungoogled_chromium"],
    ["Google Chrome (Flatpak)", "com.google.Chrome"],
    ["Brave (Flatpak)", "com.brave.Browser"],
    ["Microsoft Edge (Flatpak)", "com.microsoft.Edge"],
    ["Vivaldi (Flatpak)", "com.vivaldi.Vivaldi"],
  ];
  return [
    ...snaps.filter(([, n]) => fs.existsSync(path.join(ctx.home, "snap", n))),
    ...flatpaks.filter(([, id]) => fs.existsSync(path.join(ctx.home, ".var", "app", id))),
  ].map(([label]) => label);
}

const isInstalled = (b) => b.profiles.some((p) => fs.existsSync(p));

// ---------------------------------------------------------------- node

/**
 * The node the launcher pins: $NODE if set, else the one running us. A Homebrew Cellar
 * path (versioned, gone after `brew upgrade node`) becomes the stable opt/ symlink.
 */
export function resolveNode(ctx) {
  let node = ctx.env.NODE || ctx.execPath;
  if (!path.isAbsolute(node)) throw new InstallError(`NODE must be an absolute path, got ${node}`);
  if (!fs.existsSync(node)) throw new InstallError(`node not found at ${node}`);
  let version = ctx.nodeVersion;
  if (ctx.env.NODE) {
    const r = spawnSync(node, ["-p", "process.versions.node"], { encoding: "utf8" });
    if (r.status !== 0) throw new InstallError(`could not run ${node}`);
    version = r.stdout.trim();
  }
  if (Number(version.split(".")[0]) < 18) throw new InstallError(`Node.js 18+ is required, found ${version} at ${node}`);
  if (ctx.platform !== "win32") {
    node = fs.realpathSync(node);
    const m = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(node);
    if (m) {
      const stable = `${m[1]}/opt/${m[2]}/bin/node`;
      try {
        if (fs.realpathSync(stable) === node) node = stable;
      } catch {}
    }
  }
  return { node, version };
}

// ---------------------------------------------------------------- files

export function launcherScript(platform, node, installDir) {
  if (platform === "win32") {
    // %~dp0 is the launcher's own folder (with a trailing backslash), so spaces are fine.
    // `%` in the node path would be expanded by cmd; doubling it keeps it literal.
    return `@echo off\r\n"${node.replace(/%/g, "%%")}" "%~dp0src\\main.js" %*\r\n`;
  }
  return `#!/bin/sh\nexec ${shQuote(node)} ${shQuote(path.join(installDir, "src", "main.js"))} "$@"\n`;
}

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export function manifestJson(launcher, ids) {
  return (
    JSON.stringify(
      { name: HOST_NAME, description: DESCRIPTION, path: launcher, type: "stdio", allowed_origins: ids.map(originOf) },
      null,
      2,
    ) + "\n"
  );
}

function readManifest(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    return m && m.name === HOST_NAME ? m : null;
  } catch {
    return null;
  }
}

/** Write `content` to `file` unless it already holds exactly that. */
function put(ctx, file, content, mode) {
  let same = false;
  try {
    same = fs.readFileSync(file, "utf8") === content;
  } catch {}
  if (same) {
    ctx.log(line("unchanged", file));
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    ctx.log(line("wrote", file));
  }
  if (mode !== undefined) fs.chmodSync(file, mode);
  return !same;
}

/** The files that make up the host: package.json and src/*.js. */
function hostFiles(srcDir) {
  const src = fs.readdirSync(path.join(srcDir, "src")).filter((f) => f.endsWith(".js"));
  return ["package.json", ...src.map((f) => path.join("src", f))];
}

// ---------------------------------------------------------------- registry

function runReg(args) {
  const r = spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });
  if (r.error) throw new InstallError(`could not run reg.exe: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The default value of a registry key, or null when the key is missing. */
export function regDefault(ctx, key) {
  const r = ctx.reg(["query", key, "/ve"]);
  if (r.status !== 0) return null;
  // "    (Default)    REG_SZ    C:\..." — the "(Default)" label is localised, so match the type.
  for (const l of r.stdout.split(/\r?\n/)) {
    const m = /\sREG_(?:EXPAND_)?SZ\s+(.*)$/.exec(l);
    if (m) return m[1].trim();
  }
  return "";
}

// ---------------------------------------------------------------- ping

/** Start the launcher the way the browser does and send it one ping. */
export function pingLauncher(ctx, launcher, origin) {
  const input = encode({ id: "install", type: "ping" });
  const opts = { input, timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 };
  const r =
    ctx.platform === "win32"
      ? // Chrome runs `cmd.exe /d /c "<launcher>" <origin> --parent-window=0`.
        spawnSync(ctx.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${launcher}" ${origin} --parent-window=0"`], {
          ...opts,
          windowsVerbatimArguments: true,
        })
      : spawnSync(launcher, [origin], opts);
  if (r.error) return { ok: false, error: r.error.message };
  const out = r.stdout ?? Buffer.alloc(0);
  if (out.length >= 4) {
    const len = os.endianness() === "LE" ? out.readUInt32LE(0) : out.readUInt32BE(0);
    try {
      const msg = JSON.parse(out.subarray(4, 4 + len).toString("utf8"));
      if (msg.type === "pong") return { ok: true, message: msg };
    } catch {}
  }
  const err = (r.stderr ?? "").toString().trim();
  return { ok: false, error: err || `exit code ${r.status}, no pong` };
}

// ---------------------------------------------------------------- state

/** IDs allowed by any manifest an earlier install wrote. */
export function previousIds(ctx, loc = locations(ctx)) {
  const files = loc.manifest ? [loc.manifest] : loc.browsers.map((b) => b.manifest);
  const ids = [];
  for (const f of files) {
    for (const o of readManifest(f)?.allowed_origins ?? []) {
      const id = idOfOrigin(o);
      if (id) ids.push(id);
    }
  }
  return ids;
}

const unique = (xs) => [...new Set(xs)];

// ---------------------------------------------------------------- commands

/**
 * Install or update. Returns { ids, browsers: [label], ping }. Throws InstallError on
 * anything the user has to fix.
 */
export function install(ctx, { ids: extra = [], allBrowsers = false } = {}) {
  for (const id of extra) {
    if (!isExtensionId(id)) throw new InstallError(`'${id}' is not a Chrome extension ID (32 letters a-p, see chrome://extensions)`);
  }
  const loc = locations(ctx);
  const { node, version } = resolveNode(ctx);
  const ids = unique([...DEFAULT_EXTENSION_IDS, ...previousIds(ctx, loc), ...extra]);
  if (ids.length === 0) throw new InstallError("no extension ID to allow; pass --extension-id <id>");

  ctx.log(`Installing Portlight host (${HOST_NAME})`);
  ctx.log(line("node", `${node} (v${version})`));

  // 1. Host files.
  const files = hostFiles(ctx.srcDir);
  for (const f of files) put(ctx, path.join(loc.installDir, f), fs.readFileSync(path.join(ctx.srcDir, f), "utf8"));
  const srcOut = path.join(loc.installDir, "src");
  for (const f of fs.readdirSync(srcOut)) {
    if (!files.includes(path.join("src", f))) {
      fs.rmSync(path.join(srcOut, f), { recursive: true, force: true });
      ctx.log(line("removed", path.join(srcOut, f)));
    }
  }

  // 2. Launcher with an absolute node path.
  put(ctx, loc.launcher, launcherScript(ctx.platform, node, loc.installDir), ctx.platform === "win32" ? undefined : 0o755);
  const oldBat = path.join(loc.installDir, "portlight-host.bat"); // from the PowerShell-only installer
  if (ctx.platform === "win32" && fs.existsSync(oldBat)) {
    fs.rmSync(oldBat, { force: true });
    ctx.log(line("removed", oldBat));
  }

  // 3. The installed copy must answer before any browser is pointed at it.
  const ping = ctx.ping(ctx, loc.launcher, originOf(ids[0]));
  if (!ping.ok) throw new InstallError(`the installed host did not answer a ping:\n${ping.error}`);
  ctx.log(line("verified", "host answers ping"));

  // 4. Register with each browser.
  const manifest = manifestJson(loc.launcher, ids);
  const registered = [];
  if (ctx.platform === "win32") {
    put(ctx, loc.manifest, manifest);
    for (const b of loc.browsers) {
      const current = regDefault(ctx, b.regKey);
      if (!allBrowsers && current === null && !isInstalled(b)) {
        ctx.log(line("skipped", `${b.label} (not installed)`));
        continue;
      }
      if (current === loc.manifest) {
        ctx.log(line("unchanged", b.regKey));
      } else {
        const r = ctx.reg(["add", b.regKey, "/ve", "/t", "REG_SZ", "/d", loc.manifest, "/f"]);
        if (r.status !== 0) throw new InstallError(`reg add ${b.regKey} failed: ${r.stderr || r.stdout}`.trim());
        ctx.log(line("wrote", b.regKey));
      }
      registered.push(b.label);
    }
  } else {
    for (const b of loc.browsers) {
      if (!allBrowsers && !isInstalled(b) && !fs.existsSync(b.manifest)) {
        ctx.log(line("skipped", `${b.label} (not installed)`));
        continue;
      }
      put(ctx, b.manifest, manifest);
      registered.push(b.label);
    }
  }


  if (ctx.platform === "linux") {
    const found = sandboxedBrowsers(ctx);
    if (found.length) {
      ctx.log(line("note", `${found.join(", ")} run in a sandbox (Snap/Flatpak) that can't start native helpers; use a non-sandboxed build for Portlight`));
    }
  }

  ctx.log("");
  ctx.log("Manifest:");
  for (const l of manifest.trimEnd().split("\n")) ctx.log(`  ${l}`);
  ctx.log("");
  if (!STORE_EXTENSION_ID && extra.length === 0) {
    ctx.log("Installed Portlight from the Chrome Web Store? Allow its ID too (shown in chrome://extensions):");
    ctx.log("  portlight-host install --extension-id <id>");
    ctx.log("");
  }
  return { ids, browsers: registered, ping, launcher: loc.launcher, installDir: loc.installDir };
}

/** Remove every manifest, registry key and file install() writes. */
export function uninstall(ctx) {
  const loc = locations(ctx);
  ctx.log(`Uninstalling Portlight host (${HOST_NAME})`);
  const removed = [];
  for (const b of loc.browsers) {
    if (b.regKey) {
      if (regDefault(ctx, b.regKey) !== null) {
        const r = ctx.reg(["delete", b.regKey, "/f"]);
        if (r.status !== 0) throw new InstallError(`reg delete ${b.regKey} failed: ${r.stderr || r.stdout}`.trim());
        ctx.log(line("removed", b.regKey));
        removed.push(b.regKey);
      }
    } else if (fs.existsSync(b.manifest)) {
      fs.rmSync(b.manifest, { force: true });
      ctx.log(line("removed", b.manifest));
      removed.push(b.manifest);
      try {
        fs.rmdirSync(path.dirname(b.manifest)); // only if empty
      } catch {}
    }
  }
  if (fs.existsSync(loc.installDir)) {
    fs.rmSync(loc.installDir, { recursive: true, force: true });
    ctx.log(line("removed", loc.installDir));
    removed.push(loc.installDir);
    try {
      fs.rmdirSync(path.dirname(loc.installDir));
    } catch {}
  }
  if (removed.length === 0) ctx.log("  nothing to remove");
  return { removed };
}

/** What is installed where, which IDs each browser allows, and whether the host answers. */
export function status(ctx) {
  const loc = locations(ctx);
  const pkg = readJson(path.join(loc.installDir, "package.json"));
  const launcher = fs.existsSync(loc.launcher) ? loc.launcher : null;
  const node = launcher ? nodeOfLauncher(fs.readFileSync(launcher, "utf8")) : null;
  const browsers = loc.browsers.map((b) => {
    let manifestPath = b.manifest ?? null;
    let registered;
    if (b.regKey) {
      const v = regDefault(ctx, b.regKey);
      registered = v !== null;
      manifestPath = v || null;
    } else {
      registered = fs.existsSync(b.manifest);
    }
    const m = registered && manifestPath ? readManifest(manifestPath) : null;
    return {
      label: b.label,
      installed: isInstalled(b),
      registered,
      manifest: registered ? manifestPath : null,
      key: b.regKey ?? null,
      path: m?.path ?? null,
      ids: (m?.allowed_origins ?? []).map(idOfOrigin).filter(Boolean),
    };
  });
  const firstIds = browsers.find((b) => b.ids.length)?.ids ?? DEFAULT_EXTENSION_IDS;
  const ping = launcher ? ctx.ping(ctx, loc.launcher, originOf(firstIds[0] ?? DEFAULT_EXTENSION_IDS[0])) : { ok: false, error: "not installed" };
  const problems = [];
  if (!pkg) problems.push("host files are missing: run `portlight-host install`");
  if (node && !fs.existsSync(node)) problems.push(`the launcher's node (${node}) no longer exists: run \`portlight-host install\` again`);
  if (!browsers.some((b) => b.registered)) problems.push("no browser has the host registered");
  for (const b of browsers) {
    if (b.registered && b.path && b.path !== loc.launcher) problems.push(`${b.label}'s manifest points at ${b.path}, not ${loc.launcher}`);
  }
  if (launcher && !ping.ok) problems.push(`the host did not answer a ping: ${ping.error}`);
  return {
    ok: problems.length === 0,
    installDir: loc.installDir,
    version: pkg?.version ?? null,
    launcher,
    node,
    browsers,
    ping,
    problems,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The node path pinned in a launcher written by launcherScript(). */
export function nodeOfLauncher(text) {
  const sh = /^exec '((?:[^']|'\\'')*)'/m.exec(text);
  if (sh) return sh[1].replace(/'\\''/g, "'");
  const cmd = /^"([^"]+)" "%~dp0/m.exec(text);
  if (cmd) return cmd[1].replace(/%%/g, "%");
  const old = /^exec "([^"]+)"/m.exec(text); // launchers from the shell installer
  return old ? old[1] : null;
}
