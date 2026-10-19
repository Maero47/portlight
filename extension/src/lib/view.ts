import type { PortRow } from "./shape.ts";
import type { Settings } from "./settings.ts";

export type HiddenReason = "port" | "process" | "system";

/** Why the user's settings hide this row, or null when it is shown. */
export function hiddenReason(
  r: Pick<PortRow, "port" | "process" | "group" | "container">,
  s: Pick<Settings, "hiddenPorts" | "hiddenProcesses" | "hideSystem">,
): HiddenReason | null {
  if (s.hiddenPorts.includes(r.port)) return "port";
  // A container's proxy process is shared by every container, so hide-by-process never applies to it.
  const proc = r.process?.toLowerCase();
  if (proc && !r.container && s.hiddenProcesses.some((p) => p.toLowerCase() === proc)) return "process";
  if (s.hideSystem && r.group === "system") return "system";
  return null;
}

/** What the toolbar badge shows: distinct ports in the chosen groups that the user hasn't hidden. */
export function badgeCount(
  rows: Pick<PortRow, "port" | "process" | "group" | "container">[],
  s: Pick<Settings, "hiddenPorts" | "hiddenProcesses" | "badgeGroups">,
): number {
  const ports = new Set<number>();
  for (const r of rows) {
    if (!s.badgeGroups.includes(r.group)) continue;
    const reason = hiddenReason(r, { ...s, hideSystem: false });
    if (!reason) ports.add(r.port);
  }
  return ports.size;
}

/** A browser tab pointed at a local server. */
export interface TabRef {
  id: number;
  windowId: number;
  port: number;
  title: string;
  url: string;
  active: boolean;
  lastAccessed?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** The local port a tab URL points at, or null if it isn't a local http(s) page. */
export function tabPort(url: string | undefined): number | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !host.endsWith(".localhost")) return null;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function tabsByPort(
  tabs: { id?: number; windowId?: number; url?: string; title?: string; active?: boolean; lastAccessed?: number }[],
): Map<number, TabRef[]> {
  const out = new Map<number, TabRef[]>();
  for (const t of tabs) {
    const port = tabPort(t.url);
    if (port == null || t.id == null || t.windowId == null) continue;
    const ref: TabRef = {
      id: t.id,
      windowId: t.windowId,
      port,
      title: t.title || t.url || "",
      url: t.url!,
      active: !!t.active,
      lastAccessed: t.lastAccessed,
    };
    const list = out.get(port);
    if (list) list.push(ref);
    else out.set(port, [ref]);
  }
  return out;
}

/** The tab to bring forward: the most recently used one. */
export function bestTab(tabs: TabRef[]): TabRef | null {
  if (!tabs.length) return null;
  return tabs.reduce((a, b) => ((b.lastAccessed ?? 0) > (a.lastAccessed ?? 0) ? b : a));
}

/** A dev server that has run for hours with no tab open is probably forgotten. */
export function isIdle(
  r: Pick<PortRow, "group" | "startedAt" | "source">,
  openTabs: number,
  idleAfterHours: number,
  now = Date.now(),
): boolean {
  if (idleAfterHours <= 0 || openTabs > 0 || r.group !== "dev" || r.source !== "host" || !r.startedAt) return false;
  const t = Date.parse(r.startedAt);
  return !Number.isNaN(t) && now - t >= idleAfterHours * 3_600_000;
}
