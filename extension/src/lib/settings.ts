// User settings shared by the popup, the options page and the background worker.
// Stored in chrome.storage.sync under one key so every surface sees the same values.

export type Group = "dev" | "database" | "docker" | "app" | "system";
export type Theme = "system" | "light" | "dark";
export type Editor = "vscode" | "cursor" | "zed" | "webstorm" | "sublime" | "none";

export interface Settings {
  version: 1;
  theme: Theme;
  /** Hide ports whose group is "system" (ControlCenter, rapportd, …). */
  hideSystem: boolean;
  /** Ports the user hid explicitly. */
  hiddenPorts: number[];
  /** Process names the user hid explicitly (e.g. "Spotify"). */
  hiddenProcesses: string[];
  /** Which groups the toolbar badge counts. */
  badgeGroups: Group[];
  /** Group rows by category in the popup. */
  groupRows: boolean;
  /** Port the "free port" suggestion starts from. */
  preferredPort: number;
  /** Extra ports for the HTTP-only fallback scan. */
  extraProbePorts: number[];
  /** Live refresh interval while the popup is open (ms). */
  refreshMs: number;
  /** Editor used by "Open in editor". */
  editor: Editor;
  /** Ambient/background motion and transitions. "system" follows prefers-reduced-motion. */
  motion: "system" | "full" | "reduced";
  /** Servers running longer than this with no open tab are marked idle (hours, 0 = off). */
  idleAfterHours: number;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: "system",
  hideSystem: true,
  hiddenPorts: [],
  hiddenProcesses: [],
  badgeGroups: ["dev", "database", "docker"],
  groupRows: true,
  preferredPort: 3000,
  extraProbePorts: [],
  refreshMs: 2000,
  editor: "vscode",
  motion: "system",
  idleAfterHours: 8,
};

const KEY = "portlight.settings";

export const MIN_PORT = 1;
export const MAX_PORT = 65535;
export const MIN_REFRESH_MS = 500;
export const MAX_IDLE_HOURS = 72;

const GROUPS: readonly Group[] = ["dev", "database", "docker", "app", "system"];
const THEMES: readonly Theme[] = ["system", "light", "dark"];
const EDITORS: readonly Editor[] = ["vscode", "cursor", "zed", "webstorm", "sublime", "none"];
const MOTIONS: readonly Settings["motion"][] = ["system", "full", "reduced"];

export function isPort(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

/** Clamp into [lo, hi]; anything that isn't a finite number becomes `lo`. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const oneOf = <T>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);
const ports = (v: unknown[]): number[] => [...new Set(v.filter(isPort))];

/**
 * Fill missing or invalid fields with defaults (forward-compatible with older saves).
 * Values of the right type are also kept within range, so a hand-edited or stale save
 * can't hand the UI a 0 ms refresh or a port like -1.
 */
export function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    version: 1,
    theme: oneOf(THEMES, r.theme, d.theme),
    hideSystem: typeof r.hideSystem === "boolean" ? r.hideSystem : d.hideSystem,
    hiddenPorts: Array.isArray(r.hiddenPorts) ? ports(r.hiddenPorts) : [...d.hiddenPorts],
    hiddenProcesses: Array.isArray(r.hiddenProcesses)
      ? r.hiddenProcesses.filter((p): p is string => typeof p === "string" && p.trim() !== "")
      : [...d.hiddenProcesses],
    badgeGroups: Array.isArray(r.badgeGroups) ? GROUPS.filter((g) => (r.badgeGroups as unknown[]).includes(g)) : [...d.badgeGroups],
    groupRows: typeof r.groupRows === "boolean" ? r.groupRows : d.groupRows,
    preferredPort: finite(r.preferredPort) ? Math.round(clamp(r.preferredPort, MIN_PORT, MAX_PORT)) : d.preferredPort,
    extraProbePorts: Array.isArray(r.extraProbePorts) ? ports(r.extraProbePorts) : [...d.extraProbePorts],
    refreshMs: finite(r.refreshMs) ? Math.round(Math.max(MIN_REFRESH_MS, r.refreshMs)) : d.refreshMs,
    editor: oneOf(EDITORS, r.editor, d.editor),
    motion: oneOf(MOTIONS, r.motion, d.motion),
    idleAfterHours: finite(r.idleAfterHours) ? Math.round(clamp(r.idleAfterHours, 0, MAX_IDLE_HOURS)) : d.idleAfterHours,
  };
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.sync.get(KEY);
  return normalizeSettings(got[KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "sync" && changes[KEY]) cb(normalizeSettings(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
