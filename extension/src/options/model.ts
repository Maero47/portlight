// Pure logic behind the options page controls. No DOM, so it is unit-tested directly.

import { clamp, isPort, MAX_IDLE_HOURS, MAX_PORT, MIN_PORT, type Editor, type Group } from "../lib/settings.ts";

export { clamp, isPort, MAX_PORT, MIN_PORT };
/** A range like "3000-3010" may add at most this many ports at once. */
export const MAX_RANGE = 100;
/** chrome.storage.sync caps one item at 8 KB; this keeps a port list far below it. */
export const MAX_LIST = 200;

export interface PortParse {
  ports: number[];
  /** Tokens that were not ports, with a short reason the UI can show. */
  invalid: { token: string; reason: string }[];
}

/**
 * Parse what someone typed into a port list: "3000, 5173 8080-8082".
 * Accepts commas, spaces and semicolons as separators and "a-b" (or "a–b") ranges.
 * Returns valid ports in input order, without duplicates.
 */
export function parsePorts(input: string): PortParse {
  const ports: number[] = [];
  const invalid: PortParse["invalid"] = [];
  const seen = new Set<number>();
  const add = (p: number) => {
    if (!seen.has(p)) {
      seen.add(p);
      ports.push(p);
    }
  };
  // Join "3000 - 3010" into one range token before splitting on spaces.
  const normalized = input.replace(/(\d)\s*[-–—]\s*(?=\d)/g, "$1-");
  for (const token of normalized.split(/[\s,;]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      const bad = [a, b].find((n) => !isPort(n));
      if (bad !== undefined) invalid.push({ token, reason: outOfRange(bad) });
      else if (b < a) invalid.push({ token, reason: "Ranges go from low to high" });
      else if (b - a + 1 > MAX_RANGE) invalid.push({ token, reason: `Ranges are limited to ${MAX_RANGE} ports` });
      else for (let p = a; p <= b; p++) add(p);
      continue;
    }
    if (!/^\d+$/.test(token)) {
      invalid.push({ token, reason: "Not a port number" });
      continue;
    }
    const n = Number(token);
    if (!isPort(n)) invalid.push({ token, reason: outOfRange(n) });
    else add(n);
  }
  return { ports, invalid };
}

function outOfRange(n: number): string {
  return n === 0 ? "Port 0 isn’t a real port" : `Ports go from ${MIN_PORT} to ${MAX_PORT}`;
}

/** Merge new ports into a stored list: dedupe, drop junk, keep it sorted and bounded. */
export function mergePorts(current: readonly number[], added: readonly number[]): number[] {
  const out = [...new Set([...current, ...added].filter(isPort))].sort((a, b) => a - b);
  return out.slice(0, MAX_LIST);
}

export function removePort(current: readonly number[], port: number): number[] {
  return current.filter((p) => p !== port);
}

/** Clean a process name for the hidden-apps list. Returns null when there is nothing to add. */
export function cleanProcessName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, " ");
  if (!name) return null;
  return name.slice(0, 64);
}

/** Add a process name, case-insensitively unique, keeping the user's spelling and order. */
export function addProcess(current: readonly string[], input: string): string[] {
  const name = cleanProcessName(input);
  if (!name) return [...current];
  if (current.some((p) => p.toLowerCase() === name.toLowerCase())) return [...current];
  return [...current, name].slice(0, MAX_LIST);
}

export function removeProcess(current: readonly string[], name: string): string[] {
  return current.filter((p) => p !== name);
}

/** Validate the "free port" starting point typed into a text field. */
export function parsePreferredPort(input: string): { ok: true; port: number } | { ok: false; reason: string } {
  const t = input.trim();
  if (!t) return { ok: false, reason: "Enter a port" };
  if (!/^\d+$/.test(t)) return { ok: false, reason: "Not a port number" };
  const n = Number(t);
  if (!isPort(n)) return { ok: false, reason: outOfRange(n) };
  return { ok: true, port: n };
}

// ---------- stepper / interval ----------

export const IDLE_MAX_HOURS = MAX_IDLE_HOURS;

/** Step the idle threshold; 0 means off. */
export function stepIdle(hours: number, delta: number): number {
  return clamp(Math.round(hours) + delta, 0, IDLE_MAX_HOURS);
}

export function formatIdle(hours: number): string {
  if (hours <= 0) return "Off";
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export const REFRESH_CHOICES = [1000, 2000, 3000, 5000, 10000] as const;

export function formatRefresh(ms: number): string {
  const s = ms / 1000;
  if (s === 1) return "Every second";
  return `Every ${Number.isInteger(s) ? s : s.toFixed(1)} seconds`;
}

/** The choices to offer, including an unusual stored value so it is never silently lost. */
export function refreshOptions(current: number): number[] {
  const list: number[] = [...REFRESH_CHOICES];
  if (current > 0 && !list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}

// ---------- labels ----------

export const EDITORS: { id: Editor; label: string }[] = [
  { id: "vscode", label: "Visual Studio Code" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "webstorm", label: "WebStorm" },
  { id: "sublime", label: "Sublime Text" },
  { id: "none", label: "None" },
];

export const GROUPS: { id: Group; label: string; hint: string }[] = [
  { id: "dev", label: "Dev servers", hint: "Vite, Next.js, Uvicorn…" },
  { id: "database", label: "Databases", hint: "Postgres, Redis, MySQL…" },
  { id: "docker", label: "Containers", hint: "Docker, OrbStack, Podman" },
  { id: "app", label: "Apps", hint: "Desktop apps with a local port" },
  { id: "system", label: "System services", hint: "ControlCenter, rapportd…" },
];

/** Toggle one group in the badge set, keeping the canonical order. */
export function toggleGroup(current: readonly Group[], group: Group, on: boolean): Group[] {
  const set = new Set(current);
  if (on) set.add(group);
  else set.delete(group);
  return GROUPS.map((g) => g.id).filter((id) => set.has(id));
}

export function platformName(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform || "Unknown";
  }
}
