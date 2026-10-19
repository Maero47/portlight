import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { HOST_NAME, PROTOCOL_VERSION } from "../src/protocol.js";

test("host constants match shared/protocol.ts", () => {
  const ts = fs.readFileSync(new URL("../../shared/protocol.ts", import.meta.url), "utf8");
  assert.equal(/HOST_NAME = "([^"]+)"/.exec(ts)[1], HOST_NAME);
  assert.equal(Number(/PROTOCOL_VERSION = (\d+)/.exec(ts)[1]), PROTOCOL_VERSION);
  for (const t of ["ping", "list", "check", "suggest", "kill", "reveal", "openEditor", "netinfo", "openSettings", "tunnelStatus", "tunnelStart", "tunnelStop"]) assert.ok(ts.includes(`type: "${t}"`), t);
});

test("every request type in shared/protocol.ts has a handler", async () => {
  const ts = fs.readFileSync(new URL("../../shared/protocol.ts", import.meta.url), "utf8");
  const reqBlock = /export type Request =([\s\S]*?);\n/.exec(ts)[1];
  const types = [...reqBlock.matchAll(/type: "(\w+)"/g)].map((m) => m[1]);
  const { createHandler } = await import("../src/handler.js");
  const handle = createHandler({ scan: async () => [], containers: async () => [], probe: async () => "free" });
  for (const type of types) {
    const r = await handle({ id: "x", type });
    assert.ok(!(r.ok === false && /unknown request type/.test(r.error.message)), type);
  }
});
