import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { HOST_NAME, PROTOCOL_VERSION } from "../src/protocol.js";

test("host constants match shared/protocol.ts", () => {
  const ts = fs.readFileSync(new URL("../../shared/protocol.ts", import.meta.url), "utf8");
  assert.equal(/HOST_NAME = "([^"]+)"/.exec(ts)[1], HOST_NAME);
  assert.equal(Number(/PROTOCOL_VERSION = (\d+)/.exec(ts)[1]), PROTOCOL_VERSION);
  for (const t of ["ping", "list", "check", "suggest", "kill", "reveal", "openEditor"]) assert.ok(ts.includes(`type: "${t}"`), t);
});
