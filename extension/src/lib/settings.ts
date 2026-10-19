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

/** Fill missing or invalid fields with defaults (forward-compatible with older saves). */
export function normalizeSettings(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS } as Settings;
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const d = DEFAULT_SETTINGS[k];
    const v = r[k];
    if (v === undefined) continue;
    if (Array.isArray(d) ? Array.isArray(v) : typeof v === typeof d) (s as any)[k] = v;
  }
  s.version = 1;
  return s;
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
