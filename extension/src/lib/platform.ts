export type Os = "mac" | "win" | "linux";

/** Synchronous, so the very first paint already uses the right words. */
export function detectOs(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): Os {
  if (/Windows/i.test(ua)) return "win";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "linux";
}

/** "this Mac" on macOS, "this computer" elsewhere. */
export function thisDevice(os: Os = detectOs()): string {
  return os === "mac" ? "this Mac" : "this computer";
}

/** "your Mac’s" on macOS, "this computer’s" elsewhere. */
export function yourDevices(os: Os = detectOs()): string {
  return os === "mac" ? "your Mac’s" : "this computer’s";
}

/**
 * Extension IDs the helper's installer allows without being told. Keep in step with the
 * installer (host/). Any other ID is passed with --extension-id.
 */
export const EXTENSION_IDS = {
  /** The unpacked build from the repo; the manifest "key" pins it (scripts/extension-id.mjs). */
  dev: "mfnkpeccejhabclngfmkadokknojffeo",
  /** Chrome Web Store listing. */
  store: "khdojfoihgghehobdalaonjocjmolfjk",
} as const;

export function isKnownId(id: string): boolean {
  return id !== "" && Object.values(EXTENSION_IDS).includes(id as never);
}

export type InstallMethod = "npm" | "brew";

export interface InstallChoice {
  method: InstallMethod;
  /** What the segmented control says. */
  label: string;
  /** One line to paste into a terminal. */
  command: string;
}

export interface InstallPlan {
  /** npm first (every OS); Homebrew too on macOS and Linux. */
  choices: InstallChoice[];
  /** The installer has to be told this extension's ID (unknown ID, or a helper set up for another one). */
  needsId: boolean;
  /** Windows without Node.js: run this first. */
  nodeSetup: string | null;
  /** Quiet hint for people running the unpacked build from a clone of the repo. */
  devCommand: string | null;
}

export const NODE_URL = "https://nodejs.org";

/**
 * What to run to install (or reconnect) the helper. `forbidden`: a helper is installed but
 * doesn't allow this extension, so the ID always goes along.
 */
export function installPlan(id: string, os: Os = detectOs(), opts: { forbidden?: boolean } = {}): InstallPlan {
  const needsId = !!opts.forbidden || !isKnownId(id);
  const flag = needsId ? ` --extension-id ${id}` : "";
  const choices: InstallChoice[] = [{ method: "npm", label: "npm", command: `npx portlight-host install${flag}` }];
  if (os !== "win") {
    choices.push({ method: "brew", label: "Homebrew", command: `brew install maero47/tap/portlight-host && portlight-host install${flag}` });
  }
  return {
    choices,
    needsId,
    nodeSetup: os === "win" ? "winget install OpenJS.NodeJS.LTS" : null,
    devCommand: os !== "win" && id === EXTENSION_IDS.dev ? "./install.sh" : null,
  };
}

/** The one command to quote in short messages ("Run … again to update it"). */
export function installText(id: string, os: Os = detectOs()): string {
  return installPlan(id, os).choices[0]!.command;
}
