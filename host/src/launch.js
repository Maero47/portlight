// Builds the argv for "reveal in file manager" and "open in editor", and launches it.
// Nothing here goes through a shell: every command is execFile/spawn with an argument array,
// and the editor is picked from a fixed table, never from request text.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { binDirs, findBinary, isExecutable } from "./containers.js";

/**
 * Editor ids the extension may ask for. `cli`: command names to look for; `mac`: app
 * bundle names for `open -a`; `macCli`/`win`: known binary locations when not on PATH.
 */
export const EDITORS = Object.freeze({
  vscode: {
    label: "Visual Studio Code",
    cli: ["code"],
    mac: ["Visual Studio Code"],
    win: ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe", "%ProgramFiles%\\Microsoft VS Code\\Code.exe"],
  },
  cursor: {
    label: "Cursor",
    cli: ["cursor"],
    mac: ["Cursor"],
    win: ["%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe"],
  },
  zed: {
    label: "Zed",
    cli: ["zed", "zeditor"],
    mac: ["Zed", "Zed Preview"],
    win: ["%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe"],
  },
  webstorm: {
    label: "WebStorm",
    cli: ["webstorm", "webstorm.sh", "webstorm64"],
    mac: ["WebStorm"],
    win: [],
  },
  sublime: {
    label: "Sublime Text",
    cli: ["subl"],
    mac: ["Sublime Text"],
    win: ["%ProgramFiles%\\Sublime Text\\subl.exe", "%ProgramFiles%\\Sublime Text 3\\subl.exe"],
  },
});

export const EDITOR_IDS = Object.keys(EDITORS);

/** Argv that shows a directory in Finder / the desktop file manager / Explorer. */
export function revealCommand(platform, dir) {
  if (platform === "darwin") return { file: "/usr/bin/open", args: [dir] };
  if (platform === "win32") return { file: "explorer.exe", args: [dir] };
  return { file: "xdg-open", args: [dir] };
}

function expandWin(p, env) {
  return p.replace(/%([^%]+)%/g, (m, k) => env[k] ?? m);
}

function existsAny(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Argv that opens `dir` in editor `id`, or null when the editor isn't installed.
 * macOS prefers the app bundle (`open -a <app> <dir>`, works with the browser's minimal
 * PATH), then a CLI. Linux uses the CLI. Windows uses real .exe files only, since
 * .cmd shims can't be started without a shell.
 * `exists`/`executable` are injectable so tests never touch the real filesystem.
 */
export function editorCommand(
  id,
  dir,
  { platform = process.platform, env = process.env, home = os.homedir(), exists = existsAny, executable = isExecutable } = {},
) {
  if (!Object.hasOwn(EDITORS, id)) return null;
  const ed = EDITORS[id];
  if (platform === "darwin") {
    for (const app of ed.mac) {
      for (const root of ["/Applications", path.join(home, "Applications"), path.join(home, "Applications/JetBrains Toolbox")]) {
        const bundle = path.join(root, `${app}.app`);
        if (exists(bundle)) return { file: "/usr/bin/open", args: ["-a", bundle, dir] };
      }
    }
  }
  if (platform === "win32") {
    for (const p of ed.win) {
      const f = expandWin(p, env);
      if (!f.includes("%") && exists(f)) return { file: f, args: [dir] };
    }
  }
  const toolbox =
    platform === "darwin"
      ? path.join(home, "Library/Application Support/JetBrains/Toolbox/scripts")
      : path.join(home, ".local/share/JetBrains/Toolbox/scripts");
  const dirs = [...binDirs({ platform, env, home }), ...(platform === "win32" ? [] : [toolbox])];
  for (const name of ed.cli) {
    const bin = findBinary(name, { platform, dirs, exists: executable });
    if (bin) return { file: bin, args: [dir] };
  }
  return null;
}

/**
 * Start a GUI program detached from the host. Resolves once it has spawned; rejects
 * with the spawn error (ENOENT when the program is missing).
 */
export function launchDetached(file, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false });
    } catch (err) {
      reject(err);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
