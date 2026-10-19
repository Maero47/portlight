import { HostClient, portTransport } from "./lib/host.ts";
import { createTunnelService, isTunnelMessage } from "./lib/tunnels.ts";
import { shapeListeners } from "./lib/shape.ts";
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from "./lib/settings.ts";
import { badgeCount } from "./lib/view.ts";

const host = new HostClient();
const ALARM = "portlight-refresh";

export async function setBadge(count: number | null): Promise<void> {
  await chrome.action.setBadgeText({ text: count ? String(count > 99 ? "99+" : count) : "" });
  if (count) {
    await chrome.action.setBadgeBackgroundColor({ color: "#3A3A3C" });
    await chrome.action.setBadgeTextColor?.({ color: "#FFFFFF" });
  }
}

async function settings(): Promise<Settings> {
  try {
    return await loadSettings();
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function refresh(): Promise<void> {
  try {
    const [res, s] = await Promise.all([host.list(), settings()]);
    // Only the groups the user chose (dev servers, databases, containers by default).
    await setBadge(badgeCount(shapeListeners(res.listeners), s));
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
// Changing badge groups or hiding a port updates the badge right away.
onSettingsChanged(() => void refresh());

// Share links outlive the popup, so the worker owns them (see lib/tunnels.ts).
const tunnels = createTunnelService({
  live: () => {
    const transport = portTransport();
    return { client: new HostClient(transport), close: () => transport.reset?.() };
  },
  once: host,
});

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  // The popup refreshes every couple of seconds while open and tells us the count.
  if (msg && typeof msg === "object" && (msg as { type?: string }).type === "portlight:count") {
    const count = (msg as { count: number | null }).count;
    void setBadge(typeof count === "number" ? count : null);
    return;
  }
  if (isTunnelMessage(msg)) {
    const op = msg.op === "start" || msg.op === "stop" ? { op: msg.op, port: msg.port } : { op: msg.op };
    void tunnels.handle(op as Parameters<typeof tunnels.handle>[0]).then(sendResponse);
    return true; // answer asynchronously
  }
});
