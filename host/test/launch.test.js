import { test } from "node:test";
import assert from "node:assert/strict";
import { EDITOR_IDS, editorCommand, revealCommand } from "../src/launch.js";

const only = (set) => (f) => set.includes(f);

test("revealCommand per platform", () => {
  assert.deepEqual(revealCommand("darwin", "/Users/dev/app"), { file: "/usr/bin/open", args: ["-a", "Finder", "/Users/dev/app"] });
  assert.deepEqual(revealCommand("darwin", "/Applications/Foo.app").args, ["-a", "Finder", "/Applications/Foo.app"], "never launches a bundle");
  assert.equal(revealCommand("win32", "C:\\a,/select,C:\\b"), null, "Explorer comma switches");
  assert.deepEqual(revealCommand("linux", "/home/dev/app"), { file: "xdg-open", args: ["/home/dev/app"] });
  assert.deepEqual(revealCommand("win32", "C:\\dev\\app"), { file: "explorer.exe", args: ["C:\\dev\\app"] });
});

test("editor ids are a fixed whitelist", () => {
  assert.deepEqual(EDITOR_IDS, ["vscode", "cursor", "zed", "webstorm", "sublime"]);
  for (const bad of ["vim", "toString", "__proto__", "code; rm -rf /", ""]) {
    assert.equal(editorCommand(bad, "/p", { platform: "darwin", exists: () => true, executable: () => true }), null, bad);
  }
});

test("macOS prefers the app bundle via open -a, then a CLI, else null", () => {
  const opts = (bundles, bins = []) => ({ platform: "darwin", env: { PATH: "/usr/bin:/bin" }, home: "/Users/dev", exists: only(bundles), executable: only(bins) });
  assert.deepEqual(editorCommand("vscode", "/Users/dev/app", opts(["/Applications/Visual Studio Code.app"])), {
    file: "/usr/bin/open",
    args: ["-a", "/Applications/Visual Studio Code.app", "/Users/dev/app"],
  });
  assert.deepEqual(editorCommand("webstorm", "/p", opts(["/Users/dev/Applications/WebStorm.app"])).args, ["-a", "/Users/dev/Applications/WebStorm.app", "/p"]);
  assert.deepEqual(editorCommand("cursor", "/p", opts([], ["/opt/homebrew/bin/cursor"])), { file: "/opt/homebrew/bin/cursor", args: ["/p"] });
  assert.deepEqual(
    editorCommand("webstorm", "/p", opts([], ["/Users/dev/Library/Application Support/JetBrains/Toolbox/scripts/webstorm"])).file,
    "/Users/dev/Library/Application Support/JetBrains/Toolbox/scripts/webstorm",
  );
  assert.equal(editorCommand("sublime", "/p", opts([])), null);
});

test("Linux uses the CLI from PATH or well-known dirs", () => {
  const o = (bins) => ({ platform: "linux", env: { PATH: "/usr/bin" }, home: "/home/dev", exists: () => false, executable: only(bins) });
  assert.deepEqual(editorCommand("zed", "/home/dev/app", o(["/home/dev/.local/bin/zeditor"])), { file: "/home/dev/.local/bin/zeditor", args: ["/home/dev/app"] });
  assert.deepEqual(editorCommand("sublime", "/p", o(["/usr/bin/subl"])), { file: "/usr/bin/subl", args: ["/p"] });
  assert.equal(editorCommand("vscode", "/p", o([])), null);
});

test("Windows uses real .exe paths only (never .cmd shims that need a shell)", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local", PATH: "C:\\bin" };
  const exe = "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
  assert.deepEqual(editorCommand("vscode", "C:\\dev\\app", { platform: "win32", env, exists: only([exe]), executable: () => false }), {
    file: exe,
    args: ["C:\\dev\\app"],
  });
  const cmdOnly = editorCommand("vscode", "C:\\p", { platform: "win32", env, exists: () => false, executable: (f) => f.endsWith(".cmd") });
  assert.equal(cmdOnly, null);
});
