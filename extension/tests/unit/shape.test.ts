import { describe, expect, it } from "vitest";
import type { Listener } from "../../../shared/protocol.ts";
import {
  busyPortCount,
  describeScope,
  detectTool,
  filterRows,
  parsePort,
  projectFromCwd,
  scopeOf,
  shapeListeners,
  suggestFreePorts,
  urlFor,
} from "../../src/lib/shape.ts";

const L = (o: Partial<Listener> & { port: number }): Listener => ({
  address: "127.0.0.1",
  family: "IPv4",
  pid: 100,
  process: "node",
  command: null,
  cwd: null,
  user: "me",
  startedAt: null,
  ...o,
});

describe("scopeOf", () => {
  it.each(["127.0.0.1", "127.0.1.1", "::1", "[::1]", "localhost", "::ffff:127.0.0.1"])("%s is local", (a) =>
    expect(scopeOf(a)).toBe("local"),
  );
  it.each(["0.0.0.0", "*", "::", "192.168.1.20", "fe80::1%en0", "10.0.0.5"])("%s is network", (a) =>
    expect(scopeOf(a)).toBe("network"),
  );
  it("describes wildcard exposure", () => {
    expect(describeScope({ scope: "network", addresses: ["0.0.0.0"] })).toMatch(/all interfaces/);
    expect(describeScope({ scope: "network", addresses: ["192.168.1.2"] })).toBe("Reachable on 192.168.1.2");
    expect(describeScope({ scope: "local", addresses: ["::1"] })).toMatch(/this Mac/);
  });
});

describe("projectFromCwd", () => {
  it("uses the folder name", () => expect(projectFromCwd("/Users/me/code/portlight")).toBe("portlight"));
  it("ignores trailing slashes and backslashes", () => {
    expect(projectFromCwd("/Users/me/code/shop/")).toBe("shop");
    expect(projectFromCwd("C:\\Users\\me\\code\\shop")).toBe("shop");
  });
  it("keeps the parent for generic folder names", () => {
    expect(projectFromCwd("/Users/me/code/ledger/api")).toBe("ledger/api");
    expect(projectFromCwd("/Users/me/code/shop/server")).toBe("shop/server");
    expect(projectFromCwd("/Users/me/Developer/app")).toBe("app");
  });
  it("returns null for home, root and system folders", () => {
    for (const cwd of [null, "", "/", "/Users/me", "/home/me", "/root", "/usr/local/bin", "/opt/homebrew/var/pg", "/System/Library", "C:"])
      expect(projectFromCwd(cwd)).toBeNull();
    expect(projectFromCwd("/srv/me", "/srv/me")).toBeNull();
  });
});

describe("detectTool", () => {
  it.each([
    ["node /x/node_modules/.bin/next dev", "Next.js"],
    ["node /x/node_modules/.bin/vite --port 5173", "Vite"],
    ["node node_modules/.bin/storybook dev -p 6006", "Storybook"],
    ["python -m uvicorn main:app", "Uvicorn"],
    ["python manage.py runserver", "Django"],
    ["python3 -m http.server 8000", "Python HTTP"],
    ["/opt/homebrew/opt/postgresql@16/bin/postgres -D x", "PostgreSQL"],
    ["/usr/local/bin/redis-server 127.0.0.1:6379", "Redis"],
    ["ng serve", "Angular"],
  ])("%s → %s", (cmd, tool) => expect(detectTool(cmd)).toBe(tool));
  it("falls back to process name and returns null when unknown", () => {
    expect(detectTool(null, "postgres")).toBe("PostgreSQL");
    expect(detectTool("node server.js", "node")).toBeNull();
    expect(detectTool(null, null)).toBeNull();
  });
});

describe("shapeListeners", () => {
  it("merges IPv4 + IPv6 sockets of one process and keeps the widest scope", () => {
    const rows = shapeListeners([
      L({ port: 3000, address: "127.0.0.1" }),
      L({ port: 3000, address: "::", family: "IPv6", cwd: "/Users/me/code/app" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ port: 3000, scope: "network", addresses: ["127.0.0.1", "::"], project: "app" });
  });
  it("keeps different processes on the same port apart and sorts by port", () => {
    const rows = shapeListeners([L({ port: 8080, pid: 2 }), L({ port: 80, pid: 1 }), L({ port: 8080, pid: 3 })]);
    expect(rows.map((r) => r.key)).toEqual(["80:1", "8080:2", "8080:3"]);
    expect(busyPortCount(rows)).toBe(2);
  });
  it("drops invalid ports and tolerates missing pid", () => {
    const rows = shapeListeners([L({ port: 0 }), L({ port: 5000, pid: null, process: null })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("5000:?");
  });
  it("derives tool and project", () => {
    const [r] = shapeListeners([L({ port: 5173, command: "node node_modules/.bin/vite", cwd: "/Users/me/code/web/client" })]);
    expect(r).toMatchObject({ tool: "Vite", project: "web/client" });
  });
});

describe("parsePort", () => {
  it.each([
    ["3000", 3000],
    [" :8080 ", 8080],
    ["localhost:5173", 5173],
    ["http://localhost:4200/", 4200],
    ["127.0.0.1:9000", 9000],
    ["65535", 65535],
  ])("%s → %s", (input, port) => expect(parsePort(input)).toBe(port));
  it.each(["", "abc", "0", "65536", "30a0", "3000 4000", "localhost"])("rejects %j", (input) => expect(parsePort(input)).toBeNull());
});

describe("filterRows", () => {
  const rows = shapeListeners([
    L({ port: 3000, cwd: "/Users/me/code/storefront", command: "next dev" }),
    L({ port: 5432, pid: 7, process: "postgres", address: "0.0.0.0" }),
    L({ port: 30001, pid: 8, process: "ruby" }),
  ]);
  it("matches port prefixes", () => expect(filterRows(rows, "30").map((r) => r.port)).toEqual([3000, 30001]));
  it("matches project, tool and process case-insensitively", () => {
    expect(filterRows(rows, "STORE").map((r) => r.port)).toEqual([3000]);
    expect(filterRows(rows, "next.js").map((r) => r.port)).toEqual([3000]);
    expect(filterRows(rows, "postgres").map((r) => r.port)).toEqual([5432]);
  });
  it("requires every term and understands 'network'", () => {
    expect(filterRows(rows, "network postgres").map((r) => r.port)).toEqual([5432]);
    expect(filterRows(rows, "network ruby")).toEqual([]);
  });
  it("returns everything for an empty query", () => expect(filterRows(rows, "  ")).toHaveLength(3));
});

describe("suggestFreePorts", () => {
  it("returns the requested port when free", () => expect(suggestFreePorts([], 3000)).toEqual([3000]));
  it("skips busy ports going up", () => expect(suggestFreePorts([3000, 3001, 3003], 3000, 2)).toEqual([3002, 3004]));
  it("falls back below when the top is exhausted", () => expect(suggestFreePorts([65534, 65535], 65534, 1)).toEqual([65533]));
  it("never dips into privileged ports from a high start", () => {
    const busy = Array.from({ length: 65535 - 1023 }, (_, i) => 1024 + i);
    expect(suggestFreePorts(busy, 2000, 1)).toEqual([]);
  });
  it("builds URLs", () => expect(urlFor(5173)).toBe("http://localhost:5173"));
});
