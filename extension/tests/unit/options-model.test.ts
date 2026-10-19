import { describe, expect, it } from "vitest";
import {
  addProcess,
  cleanProcessName,
  formatIdle,
  formatRefresh,
  isPort,
  MAX_LIST,
  MAX_RANGE,
  mergePorts,
  parsePorts,
  parsePreferredPort,
  platformName,
  refreshOptions,
  removePort,
  removeProcess,
  stepIdle,
  toggleGroup,
} from "../../src/options/model.ts";

describe("parsePorts", () => {
  it("accepts commas, spaces and semicolons", () => {
    expect(parsePorts("3000, 5173 8080;9229")).toEqual({ ports: [3000, 5173, 8080, 9229], invalid: [] });
  });

  it("expands ranges, including spaced and en-dash ranges", () => {
    expect(parsePorts("8000-8002").ports).toEqual([8000, 8001, 8002]);
    expect(parsePorts("8000 - 8001").ports).toEqual([8000, 8001]);
    expect(parsePorts("8000–8001").ports).toEqual([8000, 8001]);
  });

  it("drops duplicates and keeps input order", () => {
    expect(parsePorts("5173 3000 5173 3000-3001").ports).toEqual([5173, 3000, 3001]);
  });

  it("reports each bad token with a reason, keeping the good ones", () => {
    const r = parsePorts("3000, 70000, abc, 0, 12.5, -4");
    expect(r.ports).toEqual([3000]);
    expect(r.invalid.map((i) => i.token)).toEqual(["70000", "abc", "0", "12.5", "-4"]);
    expect(r.invalid[0]!.reason).toBe("Ports go from 1 to 65535");
    expect(r.invalid[1]!.reason).toBe("Not a port number");
    expect(r.invalid[2]!.reason).toMatch(/Port 0/);
  });

  it("rejects backwards, oversized and out-of-range ranges", () => {
    expect(parsePorts("9000-8000").invalid[0]!.reason).toMatch(/low to high/);
    expect(parsePorts(`1-${MAX_RANGE + 1}`).invalid[0]!.reason).toMatch(/limited/);
    expect(parsePorts(`1-${MAX_RANGE}`).ports).toHaveLength(MAX_RANGE);
    expect(parsePorts("65535-65536").invalid[0]!.reason).toMatch(/65535/);
  });

  it("returns nothing for blank input", () => {
    expect(parsePorts("  ,, ")).toEqual({ ports: [], invalid: [] });
  });
});

describe("port lists", () => {
  it("merges sorted, unique and only valid ports", () => {
    expect(mergePorts([8080, 3000], [5173, 3000, 0, 70000, 1.5])).toEqual([3000, 5173, 8080]);
  });

  it("caps the list so chrome.storage.sync stays far below its item limit", () => {
    const many = Array.from({ length: MAX_LIST + 50 }, (_, i) => i + 1);
    expect(mergePorts([], many)).toHaveLength(MAX_LIST);
  });

  it("removes one port", () => {
    expect(removePort([3000, 5173], 3000)).toEqual([5173]);
  });

  it("isPort guards types and bounds", () => {
    expect(isPort(1)).toBe(true);
    expect(isPort(65535)).toBe(true);
    expect(isPort(65536)).toBe(false);
    expect(isPort("80")).toBe(false);
    expect(isPort(NaN)).toBe(false);
  });
});

describe("preferred port", () => {
  it("accepts a plain port and trims space", () => {
    expect(parsePreferredPort(" 4000 ")).toEqual({ ok: true, port: 4000 });
  });

  it("explains what is wrong", () => {
    expect(parsePreferredPort("")).toEqual({ ok: false, reason: "Enter a port" });
    expect(parsePreferredPort("4k")).toEqual({ ok: false, reason: "Not a port number" });
    expect(parsePreferredPort("99999")).toEqual({ ok: false, reason: "Ports go from 1 to 65535" });
  });
});

describe("hidden apps", () => {
  it("cleans names and ignores blanks", () => {
    expect(cleanProcessName("  Spotify   Helper ")).toBe("Spotify Helper");
    expect(cleanProcessName("   ")).toBeNull();
    expect(cleanProcessName("x".repeat(100))).toHaveLength(64);
  });

  it("adds case-insensitively unique names in order", () => {
    expect(addProcess(["Spotify"], "rapportd")).toEqual(["Spotify", "rapportd"]);
    expect(addProcess(["Spotify"], "spotify")).toEqual(["Spotify"]);
    expect(addProcess(["Spotify"], " ")).toEqual(["Spotify"]);
  });

  it("removes by exact name", () => {
    expect(removeProcess(["Spotify", "rapportd"], "Spotify")).toEqual(["rapportd"]);
  });
});

describe("idle stepper", () => {
  it("steps within 0…72 and reads 0 as Off", () => {
    expect(stepIdle(8, 1)).toBe(9);
    expect(stepIdle(0, -1)).toBe(0);
    expect(stepIdle(72, 1)).toBe(72);
    expect(formatIdle(0)).toBe("Off");
    expect(formatIdle(1)).toBe("1 hour");
    expect(formatIdle(8)).toBe("8 hours");
  });
});

describe("refresh interval", () => {
  it("formats seconds", () => {
    expect(formatRefresh(1000)).toBe("Every second");
    expect(formatRefresh(2000)).toBe("Every 2 seconds");
    expect(formatRefresh(1500)).toBe("Every 1.5 seconds");
  });

  it("keeps an unusual stored value selectable", () => {
    expect(refreshOptions(2000)).toEqual([1000, 2000, 3000, 5000, 10000]);
    expect(refreshOptions(7000)).toEqual([1000, 2000, 3000, 5000, 7000, 10000]);
  });
});

describe("badge groups", () => {
  it("toggles one group and keeps canonical order", () => {
    expect(toggleGroup(["docker", "dev"], "database", true)).toEqual(["dev", "database", "docker"]);
    expect(toggleGroup(["dev", "database"], "dev", false)).toEqual(["database"]);
    expect(toggleGroup(["dev"], "dev", true)).toEqual(["dev"]);
  });
});

it("names platforms the way people say them", () => {
  expect(platformName("darwin")).toBe("macOS");
  expect(platformName("win32")).toBe("Windows");
  expect(platformName("linux")).toBe("Linux");
  expect(platformName("freebsd")).toBe("freebsd");
});
