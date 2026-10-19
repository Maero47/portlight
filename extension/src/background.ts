import { HostClient } from "./lib/host.ts";
import { busyPortCount, shapeListeners } from "./lib/shape.ts";

const host = new HostClient();
const ALARM = "portlight-refresh";

export async function setBadge(count: number | null): Promise<void> {
  await chrome.action.setBadgeText({ text: count ? String(count > 99 ? "99+" : count) : "" });
  if (count) {
    await chrome.action.setBadgeBackgroundColor({ color: "#3A3A3C" });
    await chrome.action.setBadgeTextColor?.({ color: "#FFFFFF" });
  }
}

async function refresh(): Promise<void> {
  try {
    const res = await host.list();
    await setBadge(busyPortCount(shapeListeners(res.listeners)));
  } catch {
    // No host (or it failed): an empty badge is more honest than a stale number.
    await setBadge(null);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  void refresh();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  void refresh();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void refresh();
});

// The popup refreshes every couple of seconds while open and tells us the count.
chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (msg && typeof msg === "object" && (msg as { type?: string }).type === "portlight:count") {
    const count = (msg as { count: number | null }).count;
    void setBadge(typeof count === "number" ? count : null);
  }
});
