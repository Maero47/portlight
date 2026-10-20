// Whether the popup opens the "install the helper" sheet on its own.
//
// Dismissing it ("Not now", close, Esc, a click outside) is remembered in chrome.storage.local,
// so the popup doesn't ask on every open; the slim banner above the list reopens it any time.
// It asks again by itself only when something has changed for the user:
//   - two weeks have passed (people dismiss to try the HTTP scan first, then forget), or
//   - the failure is a different one (missing → installed for another extension ID).
// An extension update alone doesn't bring it back: store updates arrive silently, so a sheet
// appearing then would have no visible cause. A connected helper clears the memory.

import type { HostFailure } from "./host.ts";

export type SheetFailure = Extract<HostFailure, "missing" | "forbidden">;

export interface Dismissal {
  /** ms since epoch. */
  at: number;
  failure: SheetFailure;
}

export const DISMISS_KEY = "portlight.helperSheet";
export const ASK_AGAIN_MS = 14 * 24 * 60 * 60 * 1000;

export function normalizeDismissal(raw: unknown): Dismissal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  if (r.failure !== "missing" && r.failure !== "forbidden") return null;
  return { at: r.at, failure: r.failure };
}

/** Open the sheet by itself for this failure? */
export function shouldAutoOpen(d: Dismissal | null, failure: SheetFailure, now = Date.now()): boolean {
  if (!d) return true;
  if (d.failure !== failure) return true;
  // A clock that went backwards counts as "just now", not as "long ago".
  return now - d.at >= ASK_AGAIN_MS;
}

export async function loadDismissal(): Promise<Dismissal | null> {
  try {
    const got = await chrome.storage.local.get(DISMISS_KEY);
    return normalizeDismissal(got[DISMISS_KEY]);
  } catch {
    return null;
  }
}

export async function saveDismissal(failure: SheetFailure, now = Date.now()): Promise<void> {
  try {
    await chrome.storage.local.set({ [DISMISS_KEY]: { at: now, failure } satisfies Dismissal });
  } catch {
    /* storage unavailable: it asks again next time */
  }
}

export async function clearDismissal(): Promise<void> {
  try {
    await chrome.storage.local.remove(DISMISS_KEY);
  } catch {
    /* nothing to clear */
  }
}
