import { describe, expect, it } from "vitest";
import { clamp, DEFAULT_SETTINGS, isPort, normalizeSettings } from "../../src/lib/settings.ts";

describe("normalizeSettings", () => {
  it("returns defaults for nothing or junk", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("x")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ theme: 3, hideSystem: "yes", hiddenPorts: "3000" })).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid values", () => {
    const s = { ...DEFAULT_SETTINGS, theme: "dark", editor: "zed", refreshMs: 5000, hiddenPorts: [5000, 9229], badgeGroups: ["app"] };
    expect(normalizeSettings(s)).toEqual(s);
  });

  it("does not share array instances with the defaults", () => {
    const s = normalizeSettings({});
    s.hiddenPorts.push(1);
    expect(DEFAULT_SETTINGS.hiddenPorts).toEqual([]);
  });

  it("clamps numbers into range", () => {
    expect(normalizeSettings({ refreshMs: 0 }).refreshMs).toBe(500);
    expect(normalizeSettings({ refreshMs: 1234.6 }).refreshMs).toBe(1235);
    expect(normalizeSettings({ idleAfterHours: -3 }).idleAfterHours).toBe(0);
    expect(normalizeSettings({ idleAfterHours: 500 }).idleAfterHours).toBe(72);
    expect(normalizeSettings({ preferredPort: 0 }).preferredPort).toBe(1);
    expect(normalizeSettings({ preferredPort: 70000 }).preferredPort).toBe(65535);
    expect(normalizeSettings({ preferredPort: 3000.4 }).preferredPort).toBe(3000);
  });

  it("falls back to defaults for non-finite numbers", () => {
    expect(normalizeSettings({ refreshMs: NaN, idleAfterHours: Infinity, preferredPort: -Infinity })).toMatchObject({
      refreshMs: DEFAULT_SETTINGS.refreshMs,
      idleAfterHours: DEFAULT_SETTINGS.idleAfterHours,
      preferredPort: DEFAULT_SETTINGS.preferredPort,
    });
  });

  it("filters port lists to unique valid ports", () => {
    const s = normalizeSettings({ hiddenPorts: [3000, -1, 0, 70000, 3.5, "80", 3000, 8080], extraProbePorts: [null, 4200] });
    expect(s.hiddenPorts).toEqual([3000, 8080]);
    expect(s.extraProbePorts).toEqual([4200]);
  });

  it("keeps only known enum values, groups and non-empty names", () => {
    const s = normalizeSettings({
      theme: "sepia",
      editor: "emacs",
      motion: "fast",
      badgeGroups: ["docker", "bogus", "dev", "dev"],
      hiddenProcesses: ["Spotify", "", "  ", 4, null],
    });
    expect(s.theme).toBe("system");
    expect(s.editor).toBe("vscode");
    expect(s.motion).toBe("system");
    expect(s.badgeGroups).toEqual(["dev", "docker"]);
    expect(s.hiddenProcesses).toEqual(["Spotify"]);
  });

  it("always writes version 1", () => {
    expect(normalizeSettings({ version: 7 }).version).toBe(1);
  });
});

describe("isPort / clamp", () => {
  it("guards ports", () => {
    expect([1, 65535].every(isPort)).toBe(true);
    expect([0, 65536, 1.5, NaN, "80"].some(isPort)).toBe(false);
  });

  it("clamps and treats non-finite as the lower bound", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(NaN, 0, 3)).toBe(0);
  });
});
