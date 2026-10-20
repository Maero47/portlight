import { describe, expect, it } from "vitest";
import { EXTENSION_IDS, detectOs, installPlan, installText, isKnownId, thisDevice, yourDevices } from "../../src/lib/platform.ts";
import { pinnedExtensionId } from "../../scripts/extension-id.mjs";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};
const DEV = EXTENSION_IDS.dev;
const OTHER = "abcdefghijklmnopabcdefghijklmnop";
const NPX = "npx portlight-host install";
const BREW = "brew install maero47/tap/portlight-host && portlight-host install";

describe("platform", () => {
  it("detects the OS from the user agent", () => {
    expect(detectOs(UA.mac)).toBe("mac");
    expect(detectOs(UA.win)).toBe("win");
    expect(detectOs(UA.linux)).toBe("linux");
  });
  it("only says Mac on a Mac", () => {
    expect(thisDevice("mac")).toBe("this Mac");
    expect(thisDevice("win")).toBe("this computer");
    expect(thisDevice("linux")).toBe("this computer");
    expect(yourDevices("linux")).not.toMatch(/Mac/);
  });
});

describe("known extension IDs", () => {
  it("the dev ID is the one the manifest key pins", () => {
    expect(DEV).toBe(pinnedExtensionId());
  });
  it("an empty store slot never matches", () => {
    expect(isKnownId("")).toBe(false);
    expect(isKnownId(DEV)).toBe(true);
    expect(isKnownId(OTHER)).toBe(false);
  });
});

describe("installPlan", () => {
  it("macOS and Linux: npm first, Homebrew second, no ID for a known build", () => {
    for (const os of ["mac", "linux"] as const) {
      const p = installPlan(DEV, os);
      expect(p.choices.map((c) => [c.method, c.label, c.command])).toEqual([
        ["npm", "npm", NPX],
        ["brew", "Homebrew", BREW],
      ]);
      expect(p.needsId).toBe(false);
      expect(p.nodeSetup).toBeNull();
    }
  });
  it("Windows: npx only, with winget for Node.js", () => {
    const p = installPlan(DEV, "win");
    expect(p.choices.map((c) => c.command)).toEqual([NPX]);
    expect(p.nodeSetup).toBe("winget install OpenJS.NodeJS.LTS");
    expect(p.devCommand).toBeNull();
  });
  it("an unknown ID goes along with every command", () => {
    const mac = installPlan(OTHER, "mac");
    expect(mac.needsId).toBe(true);
    expect(mac.choices.map((c) => c.command)).toEqual([`${NPX} --extension-id ${OTHER}`, `${BREW} --extension-id ${OTHER}`]);
    expect(installPlan(OTHER, "win").choices[0]!.command).toBe(`${NPX} --extension-id ${OTHER}`);
  });
  it("a helper set up for another ID (forbidden) always gets the ID, even for a known build", () => {
    const p = installPlan(DEV, "linux", { forbidden: true });
    expect(p.needsId).toBe(true);
    expect(p.choices[0]!.command).toBe(`${NPX} --extension-id ${DEV}`);
    // ./install.sh from the repo fixes it too, so the dev hint stays.
    expect(p.devCommand).toBe("./install.sh");
  });
  it("the repo's ./install.sh is offered only to the dev build on macOS and Linux", () => {
    expect(installPlan(DEV, "mac").devCommand).toBe("./install.sh");
    expect(installPlan(OTHER, "mac").devCommand).toBeNull();
    expect(installPlan(DEV, "win").devCommand).toBeNull();
  });
  it("installText quotes the first command", () => {
    expect(installText(DEV, "mac")).toBe(NPX);
    expect(installText(OTHER, "linux")).toBe(`${NPX} --extension-id ${OTHER}`);
  });
});
