// Decides whether this process is the native host (started by a browser) or the CLI.

/**
 * Chrome starts a host with the caller's origin, `chrome-extension://<id>/`, and on
 * Windows also `--parent-window=<hwnd>`. With no arguments and piped stdin we are the host
 * too (debugging with scripts/frame.js). No arguments in a terminal means a person typed
 * `portlight-host`: show help instead of waiting for frames that never come.
 */
export function isBrowserLaunch(args, stdinIsTTY) {
  if (args.some((a) => a.startsWith("chrome-extension://") || a.startsWith("--parent-window="))) return true;
  return args.length === 0 && !stdinIsTTY;
}
