// Mirrors the constants in ../../shared/protocol.ts (a test keeps them in sync).
import fs from "node:fs";

export const HOST_NAME = "com.portlight.host";
export const PROTOCOL_VERSION = 1;

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

export const HOST_VERSION = readVersion();
