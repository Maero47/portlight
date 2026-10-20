#!/usr/bin/env node
// Entry point. Started by a browser it is the native messaging host; typed in a terminal
// it is the `portlight-host` CLI (install / uninstall / status).
import { isBrowserLaunch } from "./mode.js";

const args = process.argv.slice(2);
if (isBrowserLaunch(args, Boolean(process.stdin.isTTY))) {
  const { runHost } = await import("./host.js");
  runHost();
} else {
  const { main } = await import("./cli.js");
  process.exitCode = await main(args);
}
