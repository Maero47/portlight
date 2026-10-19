import { describe, expect, test } from "vitest";
import { exposeHint, hostUrl, phoneUrl } from "../../src/lib/phone.ts";

const LAN = [
  { name: "en0", address: "192.168.1.23", family: "IPv4" as const, virtual: false },
  { name: "en0", address: "2a02:1810::42", family: "IPv6" as const, virtual: false },
  { name: "bridge100", address: "192.168.64.1", family: "IPv4" as const, virtual: true },
];

describe("phone URLs", () => {
  test("wildcard listeners use the best LAN address", () => {
    for (const addresses of [["0.0.0.0"], ["*"], ["::"], ["127.0.0.1", "*"]]) {
      expect(phoneUrl({ port: 5173, addresses }, LAN), addresses.join()).toBe("http://192.168.1.23:5173");
    }
  });
  test("a server bound to one address is only reachable there", () => {
    expect(phoneUrl({ port: 8000, addresses: ["10.0.0.7"] }, LAN)).toBe("http://10.0.0.7:8000");
    expect(phoneUrl({ port: 8000, addresses: ["2a02:1810::42"] }, LAN)).toBe("http://[2a02:1810::42]:8000");
  });
  test("virtual adapters only when nothing else exists; none at all gives null", () => {
    expect(phoneUrl({ port: 3000, addresses: ["*"] }, [LAN[2]!])).toBe("http://192.168.64.1:3000");
    expect(phoneUrl({ port: 3000, addresses: ["*"] }, [])).toBeNull();
    expect(hostUrl("fe80::1", 1)).toBe("http://[fe80::1]:1");
  });
});

describe("expose hints", () => {
  test("framework flags", () => {
    expect(exposeHint({ tool: "Vite", port: 5173 })).toEqual({ tool: "Vite", flag: "--host" });
    expect(exposeHint({ tool: "Next.js", port: 3000 })?.flag).toBe("-H 0.0.0.0");
    expect(exposeHint({ tool: "Django", port: 8000 })?.flag).toBe("runserver 0.0.0.0:8000");
    expect(exposeHint({ tool: "Rails", port: 3000 })?.flag).toBe("-b 0.0.0.0");
    expect(exposeHint({ tool: "PostgreSQL", port: 5432 })).toBeNull();
    expect(exposeHint({ tool: null, port: 1 })).toBeNull();
  });
});
