import { describe, expect, it } from "vitest";
import { groupOf, type Classifiable } from "../../src/lib/classify.ts";
import { brewFormula, knownFor } from "../../src/lib/known.ts";
import { detectTool, shapeListeners } from "../../src/lib/shape.ts";
import { badgeCount, bestTab, hiddenReason, isIdle, tabPort, tabsByPort } from "../../src/lib/view.ts";
import { DEFAULT_SETTINGS } from "../../src/lib/settings.ts";
import type { Listener } from "../../../shared/protocol.ts";

const row = (port: number, process: string | null, command: string | null = null, extra: Partial<Classifiable> = {}): Classifiable => ({
  port,
  process,
  command,
  tool: detectTool(command, process),
  project: null,
  ...extra,
});

describe("groupOf", () => {
  it.each([
    [row(3000, "node", "node node_modules/.bin/next dev"), "dev"],
    [row(8000, "python3.12", "python -m uvicorn main:app"), "dev"],
    [row(4567, "ruby", "ruby app.rb"), "dev"],
    [row(9999, "my-server", "./my-server"), "dev"],
    [row(5432, "postgres", "/opt/homebrew/opt/postgresql@16/bin/postgres -D x"), "database"],
    [row(6379, "redis-server", "redis-server *:6379"), "database"],
    [row(27017, "mongod", null), "database"],
    [row(3306, "mysqld", null), "database"],
    [row(9200, "java", "java -cp elasticsearch.jar org.elasticsearch.bootstrap.Elasticsearch"), "database"],
    [row(5433, "com.docker.backend", "/Applications/Docker.app/Contents/MacOS/com.docker.backend"), "docker"],
    [row(8080, "OrbStack Helper", null), "docker"],
    [row(8080, "ssh", "ssh -F /Users/me/.colima/_lima/colima/ssh.config -L 8080:localhost:8080"), "docker"],
    [row(2222, "ssh", "ssh -L 2222:db:22 bastion"), "dev"],
    [row(5000, "ControlCenter", "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter"), "system"],
    [row(49163, "rapportd", "/usr/libexec/rapportd"), "system"],
    [row(22, "launchd", "/sbin/launchd"), "system"],
    [row(53, "systemd-resolved", null), "system"],
    [row(445, "System", null), "system"],
    [row(44950, "figma_agent", "/Applications/Figma Agent.app/Contents/MacOS/figma_agent"), "app"],
    [row(57621, "Spotify", null), "app"],
    [row(17600, "Dropbox", null), "app"],
    [row(6463, "Discord Helper", null), "app"],
  ] as const)("%o → %s", (r, g) => expect(groupOf(r)).toBe(g));

  it("a container always groups as docker, whatever proxies it", () => {
    expect(groupOf(row(5433, "postgres", null, { container: { id: "a1", name: "shop-db-1", image: "postgres:16" } }))).toBe("docker");
  });
});

describe("knownFor", () => {
  it("AirPlay Receiver on 5000 and 7000 explains itself and replaces Quit", () => {
    for (const port of [5000, 7000]) {
      const k = knownFor(row(port, "ControlCenter"))!;
      expect(k.name).toBe("AirPlay Receiver");
      expect(k.noQuit).toBe(true);
      expect(k.fix).toContain("System Settings › General › AirDrop & Handoff");
    }
  });
  it("rapportd and launchd are respawning system owners", () => {
    expect(knownFor(row(49163, "rapportd"))).toMatchObject({ name: "Continuity", noQuit: true });
    expect(knownFor(row(22, "launchd"))).toMatchObject({ name: "Remote Login", noQuit: true });
  });
  it("Docker's proxy without container info warns that quitting stops everything", () => {
    expect(knownFor(row(5433, "com.docker.backend"))).toMatchObject({ name: "Docker", noQuit: true, command: "docker ps" });
  });
  it("a container offers docker stop for just that container", () => {
    const k = knownFor(row(5433, "com.docker.backend", null, { container: { id: "a", name: "shop-db-1", image: "postgres:16", project: "shop" } }))!;
    expect(k.command).toBe("docker stop shop-db-1");
    expect(k.about).toContain("“shop” compose project");
    expect(k.noQuit).toBe(true);
  });
  it("Homebrew services keep Quit but explain the respawn", () => {
    const k = knownFor(row(5432, "postgres", "/opt/homebrew/opt/postgresql@16/bin/postgres -D /opt/homebrew/var/postgresql@16"))!;
    expect(k.command).toBe("brew services stop postgresql@16");
    expect(k.noQuit).toBeFalsy();
  });
  it("ordinary dev servers have no entry", () => {
    expect(knownFor(row(3000, "node", "node node_modules/.bin/vite"))).toBeNull();
    expect(knownFor(row(5000, "python3", "flask run"))).toBeNull();
  });
  it("brewFormula reads opt and Cellar paths", () => {
    expect(brewFormula("/usr/local/Cellar/redis/7.2.4/bin/redis-server")).toBe("redis");
    expect(brewFormula("/usr/bin/redis-server")).toBeNull();
  });
});

describe("shapeListeners", () => {
  const L = (over: Partial<Listener>): Listener => ({
    port: 5433, address: "127.0.0.1", family: "IPv4", pid: 900, process: "com.docker.backend", command: null, cwd: null, user: "me", startedAt: null, ...over,
  });
  it("carries container info, group and known entry onto the row", () => {
    const container = { id: "a1", name: "shop-db-1", image: "postgres:16", project: "shop", containerPort: 5432 };
    const [r] = shapeListeners([L({ container }), L({ address: "::1", family: "IPv6" })]);
    expect(r).toMatchObject({ container, group: "docker", known: { command: "docker stop shop-db-1" } });
  });
  it("an old host without container fields still shapes", () => {
    const [r] = shapeListeners([L({ port: 3000, process: "node", command: "node vite" })]);
    expect(r).toMatchObject({ container: null, group: "dev", known: null });
  });
});

describe("hiding and the badge", () => {
  const rows = [
    { port: 3000, process: "node", group: "dev", container: null },
    { port: 5432, process: "postgres", group: "database", container: null },
    { port: 5000, process: "ControlCenter", group: "system", container: null },
    { port: 44950, process: "figma_agent", group: "app", container: null },
    { port: 5433, process: "com.docker.backend", group: "docker", container: { id: "a", name: "db", image: "pg" } },
  ] as const;
  const s = { ...DEFAULT_SETTINGS };

  it("hides system rows by default, and user-hidden ports and processes", () => {
    expect(rows.map((r) => hiddenReason(r, s))).toEqual([null, null, "system", null, null]);
    const t = { ...s, hideSystem: false, hiddenPorts: [3000], hiddenProcesses: ["FIGMA_AGENT", "com.docker.backend"] };
    expect(rows.map((r) => hiddenReason(r, t))).toEqual(["port", null, null, "process", null]);
  });
  it("the badge counts only the chosen groups and skips hidden ones", () => {
    expect(badgeCount(rows as any, s)).toBe(3); // dev, database, docker
    expect(badgeCount(rows as any, { ...s, badgeGroups: ["dev"] })).toBe(1);
    expect(badgeCount(rows as any, { ...s, hiddenPorts: [3000] })).toBe(2);
    expect(badgeCount(rows as any, { ...s, badgeGroups: ["system", "app"] })).toBe(2);
  });
});

describe("tabs", () => {
  it.each([
    ["http://localhost:3000/dash", 3000],
    ["http://127.0.0.1:5173/", 5173],
    ["http://[::1]:8000/", 8000],
    ["http://app.localhost:4000/", 4000],
    ["http://localhost/", 80],
    ["https://localhost/", 443],
    ["https://example.com:3000/", null],
    ["chrome://extensions", null],
    ["not a url", null],
  ] as const)("%s → %s", (url, port) => expect(tabPort(url)).toBe(port));

  it("groups tabs by port and picks the most recently used", () => {
    const m = tabsByPort([
      { id: 1, windowId: 1, url: "http://localhost:3000/", title: "A", lastAccessed: 10 },
      { id: 2, windowId: 2, url: "http://localhost:3000/b", title: "B", lastAccessed: 30 },
      { id: 3, windowId: 1, url: "https://github.com/", title: "GH" },
    ]);
    expect([...m.keys()]).toEqual([3000]);
    expect(bestTab(m.get(3000)!)?.id).toBe(2);
    expect(bestTab([])).toBeNull();
  });

  it("idle means a long-running dev server with no tab", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const r = { group: "dev", source: "host", startedAt: "2026-10-19T02:00:00Z" } as const;
    expect(isIdle(r, 0, 8, now)).toBe(true);
    expect(isIdle(r, 1, 8, now)).toBe(false);
    expect(isIdle(r, 0, 0, now)).toBe(false);
    expect(isIdle(r, 0, 12, now)).toBe(false);
    expect(isIdle({ ...r, group: "database" }, 0, 8, now)).toBe(false);
  });
});
