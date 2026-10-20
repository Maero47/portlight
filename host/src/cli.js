// The `portlight-host` command: install, uninstall, status.
import { createContext, install, InstallError, status, uninstall } from "./installer.js";
import { HOST_NAME, HOST_VERSION } from "./protocol.js";

export const HELP = `portlight-host ${HOST_VERSION}: native helper for the Portlight browser extension

Usage:
  portlight-host install [--extension-id <id>]... [--all-browsers]
      Copy the helper to a per-user folder and register it with every installed
      Chromium browser (Chrome, Chromium, Brave, Edge, Arc, Vivaldi). Safe to re-run;
      IDs allowed by an earlier install are kept.
  portlight-host uninstall
      Remove everything install wrote.
  portlight-host status [--json]
      Show what is installed where, which extension IDs are allowed, and whether the
      helper answers. Also available as \`doctor\`.

Options:
  --extension-id <id>  also allow this extension (32 letters a-p, see chrome://extensions)
  --all-browsers       register even with browsers that don't look installed
  -h, --help           show this help
  -v, --version        print the version
`;

function parseInstall(args) {
  const ids = [];
  let allBrowsers = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all-browsers") allBrowsers = true;
    else if (a === "--extension-id" || a === "--id") {
      if (i + 1 >= args.length) throw new UsageError(`${a} needs a value`);
      ids.push(args[++i]);
    } else if (a.startsWith("--extension-id=")) ids.push(a.slice("--extension-id=".length));
    else if (a.startsWith("-")) throw new UsageError(`unknown option: ${a}`);
    else ids.push(a); // bare IDs, as the old install.sh took them
  }
  return { ids, allBrowsers };
}

class UsageError extends Error {}

/** Runs one CLI command and returns the exit code. */
export async function main(args, ctx = createContext()) {
  const [cmd, ...rest] = args;
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "-h":
      case "--help":
        ctx.log(HELP.trimEnd());
        return 0;
      case "-v":
      case "--version":
      case "version":
        ctx.log(HOST_VERSION);
        return 0;
      case "install": {
        if (rest.includes("-h") || rest.includes("--help")) return main(["help"], ctx);
        const r = install(ctx, parseInstall(rest));
        if (r.browsers.length === 0) {
          ctx.warn("warning: no supported browser found; re-run with --all-browsers to register anyway");
          return 1;
        }
        ctx.log(`Done: ${r.browsers.length} browser(s). Reload the Portlight extension to connect.`);
        return 0;
      }
      case "uninstall":
        if (rest.length) throw new UsageError(`uninstall takes no arguments`);
        uninstall(ctx);
        ctx.log("Done.");
        return 0;
      case "status":
      case "doctor": {
        const json = rest.includes("--json");
        const unknown = rest.filter((a) => a !== "--json");
        if (unknown.length) throw new UsageError(`unknown option: ${unknown[0]}`);
        const s = status(ctx);
        if (json) ctx.log(JSON.stringify(s, null, 2));
        else printStatus(ctx, s);
        return s.ok ? 0 : 1;
      }
      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.warn(`error: ${err.message}\n`);
      ctx.warn(HELP.trimEnd());
      return 2;
    }
    if (err instanceof InstallError) {
      ctx.warn(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

function printStatus(ctx, s) {
  const row = (label, text) => ctx.log(`  ${label.padEnd(22)} ${text}`);
  ctx.log(`Portlight host (${HOST_NAME})`);
  row("files", s.version ? `${s.installDir} (v${s.version})` : `not installed (${s.installDir})`);
  if (s.launcher) row("launcher", s.launcher);
  if (s.node) row("node", s.node);
  for (const b of s.browsers) {
    if (b.registered) row(b.label, `${b.manifest}${b.key ? ` (${b.key})` : ""}\n  ${"".padEnd(22)} allows ${b.ids.join(", ") || "nothing"}`);
    else if (b.installed) row(b.label, "installed, not registered");
  }
  if (s.launcher) row("ping", s.ping.ok ? `ok (host ${s.ping.message.hostVersion ?? "?"}, protocol ${s.ping.message.version ?? "?"})` : `failed`);
  ctx.log("");
  if (s.ok) ctx.log("Everything looks fine.");
  else for (const p of s.problems) ctx.log(`problem: ${p}`);
}
