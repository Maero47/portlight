import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASK_AGAIN_MS,
  DISMISS_KEY,
  clearDismissal,
  loadDismissal,
  normalizeDismissal,
  saveDismissal,
  shouldAutoOpen,
} from "../../src/lib/onboard.ts";

const NOW = Date.UTC(2026, 9, 20, 12);
const DAY = 24 * 60 * 60 * 1000;

describe("shouldAutoOpen", () => {
  it("opens when it was never dismissed", () => {
    expect(shouldAutoOpen(null, "missing", NOW)).toBe(true);
  });
  it("stays closed for two weeks after Not now", () => {
    const d = { at: NOW - 3 * DAY, failure: "missing" as const };
    expect(shouldAutoOpen(d, "missing", NOW)).toBe(false);
    expect(shouldAutoOpen({ ...d, at: NOW - ASK_AGAIN_MS + 1 }, "missing", NOW)).toBe(false);
    expect(shouldAutoOpen({ ...d, at: NOW - ASK_AGAIN_MS }, "missing", NOW)).toBe(true);
    expect(ASK_AGAIN_MS).toBe(14 * DAY);
  });
  it("asks again when the failure is a different one", () => {
    expect(shouldAutoOpen({ at: NOW, failure: "missing" }, "forbidden", NOW)).toBe(true);
  });
  it("a clock that went backwards doesn't count as long ago", () => {
    expect(shouldAutoOpen({ at: NOW + 5 * DAY, failure: "missing" }, "missing", NOW)).toBe(false);
  });
});

describe("normalizeDismissal", () => {
  it("keeps a valid record and drops anything else", () => {
    expect(normalizeDismissal({ at: NOW, failure: "forbidden" })).toEqual({ at: NOW, failure: "forbidden" });
    for (const bad of [null, undefined, 3, "x", {}, { at: "1", failure: "missing" }, { at: NOW, failure: "crashed" }, { at: Infinity, failure: "missing" }]) {
      expect(normalizeDismissal(bad)).toBeNull();
    }
  });
});

describe("storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage() {
    const data: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (k: string) => (k in data ? { [k]: data[k] } : {}),
          set: async (items: Record<string, unknown>) => void Object.assign(data, items),
          remove: async (k: string) => void delete data[k],
        },
      },
    });
    return data;
  }

  it("round-trips through chrome.storage.local and clears", async () => {
    const data = stubStorage();
    expect(await loadDismissal()).toBeNull();
    await saveDismissal("missing", NOW);
    expect(data[DISMISS_KEY]).toEqual({ at: NOW, failure: "missing" });
    expect(await loadDismissal()).toEqual({ at: NOW, failure: "missing" });
    await clearDismissal();
    expect(await loadDismissal()).toBeNull();
  });

  it("never throws without chrome.storage", async () => {
    vi.stubGlobal("chrome", undefined);
    expect(await loadDismissal()).toBeNull();
    await expect(saveDismissal("missing")).resolves.toBeUndefined();
    await expect(clearDismissal()).resolves.toBeUndefined();
  });
});
