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
 * What to run in the Portlight folder to connect the helper.
 * The unpacked build carries a pinned ID, which ./install.sh already knows;
 * any other ID (e.g. a store install) is passed explicitly.
 */
export function installCommand(id: string, pinnedId: string, os: Os = detectOs()): { cmd: string; args: string } {
  if (os === "win") return { cmd: "powershell -ExecutionPolicy Bypass -File host\\install.ps1", args: id };
  return { cmd: "./install.sh", args: id === pinnedId ? "" : id };
}
