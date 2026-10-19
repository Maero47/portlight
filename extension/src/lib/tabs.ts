import { tabsByPort, type TabRef } from "./view.ts";

/**
 * Tabs pointed at local servers. No "tabs" permission: the existing host permissions for
 * http://localhost and http://127.0.0.1 are what let tabs.query match and read these URLs.
 */
export const LOCAL_TAB_PATTERNS = ["http://localhost/*", "http://127.0.0.1/*"];

export async function localTabs(): Promise<Map<number, TabRef[]>> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return new Map();
  try {
    return tabsByPort(await chrome.tabs.query({ url: LOCAL_TAB_PATTERNS }));
  } catch {
    return new Map();
  }
}

/** Bring a tab and its window to the front. */
export async function focusTab(t: TabRef): Promise<void> {
  await chrome.tabs.update(t.id, { active: true });
  try {
    await chrome.windows?.update(t.windowId, { focused: true });
  } catch {
    /* the window may have closed in between; the tab switch still happened */
  }
}

export async function closeTabs(tabs: TabRef[]): Promise<void> {
  if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id));
}

/** Re-run `cb` shortly after any tab opens, closes or navigates. Returns an unsubscribe. */
export function watchTabs(cb: () => void): () => void {
  if (typeof chrome === "undefined" || !chrome.tabs?.onUpdated) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(cb, 120);
  };
  const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo) => {
    if (info.url !== undefined || info.title !== undefined || info.status === "complete") kick();
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(kick);
  chrome.tabs.onCreated?.addListener(kick);
  return () => {
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(kick);
    chrome.tabs.onCreated?.removeListener(kick);
  };
}
