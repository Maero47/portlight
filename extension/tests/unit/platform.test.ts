import { describe, expect, it } from "vitest";
import { detectOs, installCommand, thisDevice, yourDevices } from "../../src/lib/platform.ts";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};
const PINNED = "mfnkpeccejhabclngfmkadokknojffeo";
const OTHER = "abcdefghijklmnopabcdefghijklmnop";

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
  it("needs no ID for the pinned build, and passes any other ID", () => {
    expect(installCommand(PINNED, PINNED, "mac")).toEqual({ cmd: "./install.sh", args: "" });
    expect(installCommand(OTHER, PINNED, "linux")).toEqual({ cmd: "./install.sh", args: OTHER });
    expect(installCommand(PINNED, PINNED, "win").cmd).toMatch(/host\\install\.ps1$/);
    expect(installCommand(PINNED, PINNED, "win").args).toBe(PINNED);
  });
});
