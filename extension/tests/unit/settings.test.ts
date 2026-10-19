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

// ---------- storage ----------

import { afterEach, vi } from "vitest";
import { loadSettings, onSettingsChanged, saveSettings, writeSettings } from "../../src/lib/settings.ts";

const KEY = "portlight.settings";
type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

function fakeChrome(opts: { local?: unknown; sync?: unknown; syncGetThrows?: boolean; localSetRejects?: boolean; noSync?: boolean } = {}) {
  const ops: string[] = [];
  const data = { local: {} as Record<string, unknown>, sync: {} as Record<string, unknown> };
  if (opts.local !== undefined) data.local[KEY] = opts.local;
  if (opts.sync !== undefined) data.sync[KEY] = opts.sync;
  const listeners: Listener[] = [];
  const area = (name: "local" | "sync") => ({
    get: vi.fn(async (k: string) => {
      ops.push(`${name}.get`);
      if (name === "sync" && opts.syncGetThrows) throw new Error("sync unavailable");
      return k in data[name] ? { [k]: data[name][k] } : {};
    }),
    // Records synchronously, like the real API issues the call before returning a promise.
    set: vi.fn((items: Record<string, unknown>) => {
      ops.push(`${name}.set`);
      if (name === "local" && opts.localSetRejects) return Promise.reject(new Error("quota"));
      Object.assign(data[name], items);
      return Promise.resolve();
    }),
  });
  const storage: any = {
    local: area("local"),
    sync: opts.noSync ? undefined : area("sync"),
    onChanged: {
      addListener: (f: Listener) => listeners.push(f),
      removeListener: (f: Listener) => listeners.splice(listeners.indexOf(f), 1),
    },
  };
  vi.stubGlobal("chrome", { storage });
  const emit = (areaName: string, value: unknown) => listeners.forEach((f) => f({ [KEY]: { newValue: value } }, areaName));
  return { ops, data, emit, listeners };
}

describe("settings storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads from chrome.storage.local", async () => {
    const { ops } = fakeChrome({ local: { ...DEFAULT_SETTINGS, theme: "dark" }, sync: { theme: "light" } });
    expect((await loadSettings()).theme).toBe("dark");
    expect(ops).toEqual(["local.get"]);
  });

  it("moves settings from sync to local once, leaving sync alone", async () => {
    const { ops, data } = fakeChrome({ sync: { theme: "light", hiddenPorts: [5000, -1] } });
    const s = await loadSettings();
    expect(s.theme).toBe("light");
    expect(s.hiddenPorts).toEqual([5000]);
    expect(data.local[KEY]).toEqual(s);
    expect(data.sync[KEY]).toEqual({ theme: "light", hiddenPorts: [5000, -1] });
    ops.length = 0;
    await loadSettings();
    expect(ops).toEqual(["local.get"]);
  });

  it("migration is best effort", async () => {
    fakeChrome({ syncGetThrows: true });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    fakeChrome({ noSync: true });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    fakeChrome({ sync: { editor: "zed" }, localSetRejects: true });
    expect((await loadSettings()).editor).toBe("zed");
    fakeChrome();
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("saveSettings merges into local and never touches sync", async () => {
    const { ops, data } = fakeChrome({ local: { ...DEFAULT_SETTINGS, editor: "zed" } });
    const s = await saveSettings({ theme: "dark" });
    expect(s).toMatchObject({ editor: "zed", theme: "dark" });
    expect(data.local[KEY]).toEqual(s);
    expect(ops).toEqual(["local.get", "local.set"]);
  });

  it("writeSettings issues one local set synchronously, without reading", () => {
    const { ops, data } = fakeChrome({ local: { ...DEFAULT_SETTINGS } });
    const p = writeSettings({ ...DEFAULT_SETTINGS, idleAfterHours: 900 });
    // Nothing awaited yet: the call has already gone out.
    expect(ops).toEqual(["local.set"]);
    expect((data.local[KEY] as { idleAfterHours: number }).idleAfterHours).toBe(72); // normalized
    return p;
  });

  it("onSettingsChanged follows the local area only", () => {
    const { emit, listeners } = fakeChrome();
    const seen: string[] = [];
    const off = onSettingsChanged((s) => seen.push(s.theme));
    emit("sync", { theme: "dark" });
    emit("local", { theme: "light" });
    expect(seen).toEqual(["light"]);
    off();
    expect(listeners).toHaveLength(0);
  });

  it("caps list lengths and app names", () => {
    const s = normalizeSettings({
      hiddenPorts: Array.from({ length: 500 }, (_, i) => i + 1),
      hiddenProcesses: Array.from({ length: 500 }, (_, i) => `app-${i}-${"x".repeat(100)}`),
    });
    expect(s.hiddenPorts).toHaveLength(200);
    expect(s.hiddenProcesses).toHaveLength(200);
    expect(s.hiddenProcesses[0]).toHaveLength(64);
  });
});
