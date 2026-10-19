import { test } from "node:test";
import assert from "node:assert/strict";
import { lanAddresses, settingsCommand } from "../src/system.js";

test("lanAddresses: physical IPv4 first, no loopback or link-local, virtual adapters last", () => {
  const ifaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }, { address: "::1", family: "IPv6", internal: true }],
    bridge100: [{ address: "192.168.64.1", family: "IPv4", internal: false }],
    utun3: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
    en0: [
      { address: "fe80::1c2b:3a4d:5e6f:7a8b", family: "IPv6", internal: false },
      { address: "2a02:1810::42", family: "IPv6", internal: false },
      { address: "192.168.1.23", family: "IPv4", internal: false },
    ],
    en7: [{ address: "169.254.10.20", family: "IPv4", internal: false }],
    eth1: [{ address: "10.0.0.5", family: 4, internal: false }],
  };
  assert.deepEqual(
    lanAddresses(ifaces).map((a) => `${a.name} ${a.address}${a.virtual ? " (virtual)" : ""}`),
    ["en0 192.168.1.23", "eth1 10.0.0.5", "en0 2a02:1810::42", "bridge100 192.168.64.1 (virtual)", "utun3 100.101.102.103 (virtual)"],
  );
  assert.deepEqual(lanAddresses({}), []);
  assert.deepEqual(lanAddresses(null), []);
});

test("settingsCommand: fixed macOS panes only, legacy ids before Ventura", () => {
  assert.deepEqual(settingsCommand("airdrop-handoff", "darwin", "25.0.0"), {
    file: "/usr/bin/open",
    args: ["x-apple.systempreferences:com.apple.AirDrop-Handoff-Settings.extension"],
  });
  assert.deepEqual(settingsCommand("sharing", "darwin", "23.1.0").args, ["x-apple.systempreferences:com.apple.Sharing-Settings.extension"]);
  assert.deepEqual(settingsCommand("airdrop-handoff", "darwin", "21.6.0").args, ["x-apple.systempreferences:com.apple.preferences.sharing"]);
  assert.equal(settingsCommand("airdrop-handoff", "linux", "6.1.0"), null);
  assert.equal(settingsCommand("airdrop-handoff", "win32", "10.0"), null);
  for (const bad of ["x-apple.systempreferences:com.apple.Users", "toString", "__proto__", ""]) {
    assert.equal(settingsCommand(bad, "darwin", "25.0.0"), null, bad);
  }
});
