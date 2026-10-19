// Network addresses for "Open on Phone", and the few System Settings panes Portlight links to.
import os from "node:os";

/** Interfaces that are never how a phone on the same Wi-Fi reaches this machine. */
const VIRTUAL_IFACE = /^(lo|utun|awdl|llw|bridge|docker|br-|veth|vmnet|vboxnet|virbr|tailscale|zt|ham|gif|stf|anpi|ap\d|tun|tap|wg|cni|flannel|podman|lima|orb)/i;

/**
 * Non-internal addresses a device on the same network could use, best first:
 * physical IPv4 (en0, wlan0, eth0, Wi-Fi) before virtual adapters, IPv4 before IPv6,
 * no link-local addresses (169.254/16, fe80::/10).
 */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces ?? {})) {
    for (const a of addrs ?? []) {
      if (!a || a.internal) continue;
      const family = a.family === 4 || a.family === "IPv4" ? "IPv4" : "IPv6";
      const address = String(a.address);
      if (family === "IPv4" ? address.startsWith("169.254.") : /^fe[89ab]/i.test(address)) continue;
      out.push({ name, address, family, virtual: VIRTUAL_IFACE.test(name) });
    }
  }
  const rank = (a) => (a.virtual ? 2 : 0) + (a.family === "IPv6" ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * System Settings panes the extension may open (macOS 13+ and macOS 12 System Preferences).
 * The pane id comes from a fixed table; the request only picks a key.
 */
export const SETTINGS_PANES = Object.freeze({
  "airdrop-handoff": {
    modern: "x-apple.systempreferences:com.apple.AirDrop-Handoff-Settings.extension",
    legacy: "x-apple.systempreferences:com.apple.preferences.sharing",
  },
  sharing: {
    modern: "x-apple.systempreferences:com.apple.Sharing-Settings.extension",
    legacy: "x-apple.systempreferences:com.apple.preferences.sharing",
  },
});

/** argv for opening a settings pane, or null when the platform has no such pane. Darwin 22 = macOS 13. */
export function settingsCommand(pane, platform = process.platform, release = os.release()) {
  if (platform !== "darwin" || !Object.hasOwn(SETTINGS_PANES, pane)) return null;
  const major = Number.parseInt(String(release), 10);
  const url = Number.isFinite(major) && major < 22 ? SETTINGS_PANES[pane].legacy : SETTINGS_PANES[pane].modern;
  return { file: "/usr/bin/open", args: [url] };
}
