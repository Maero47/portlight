import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseDockerPorts,
  parseContainerPs,
  isContainerEngine,
  attachContainers,
  createContainerSource,
  findBinary,
  binDirs,
} from "../src/containers.js";

const fx = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const L = (o) => ({ address: "*", family: "IPv4", pid: 1, process: "node", command: "node x", cwd: "/p", user: "me", startedAt: null, ...o });

test("parseDockerPorts: single, ranges, IPv6, unpublished and udp", () => {
  assert.deepEqual(parseDockerPorts("0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp"), [
    { hostIp: "0.0.0.0", hostPort: 5433, containerPort: 5432 },
    { hostIp: "::", hostPort: 5433, containerPort: 5432 },
  ]);
  assert.deepEqual(parseDockerPorts("0.0.0.0:9000-9001->9000-9001/tcp").map((p) => [p.hostPort, p.containerPort]), [[9000, 9000], [9001, 9001]]);
  assert.deepEqual(parseDockerPorts("1110/tcp, 0.0.0.0:53->53/udp"), []);
  assert.deepEqual(parseDockerPorts(""), []);
  assert.deepEqual(parseDockerPorts(undefined), []);
});

test("parseContainerPs: docker ps NDJSON fixture", () => {
  const list = parseContainerPs(fx("docker-ps.ndjson"));
  const at = (port) => list.filter((p) => p.hostPort === port);
  // postgres published on v4 and v6, compose labels survive commas inside other labels
  assert.equal(at(5433).length, 2);
  assert.deepEqual(at(5433)[0].container, {
    id: "96675005c079",
    name: "shop-postgres-1",
    image: "postgres:16-alpine",
    project: "shop",
    containerPort: 5432,
    workingDir: "/Users/dev/shop",
  });
  assert.equal(at(9001)[0].container.containerPort, 9001);
  assert.equal(at(9001)[0].container.project, "shop");
  assert.equal(at(8025)[0].hostIp, "127.0.0.1");
  assert.equal(at(8025)[0].container.project, null);
  assert.equal(at(1110).length, 0, "unpublished port");
  assert.equal(at(5353).length, 0, "udp");
  assert.equal(at(8080)[0].container.name, "web", "first of several names");
  assert.ok(!list.some((p) => p.container.name === "old-db-1"), "exited containers are skipped");
});

test("parseContainerPs: podman ps --format json fixture", () => {
  const list = parseContainerPs(fx("podman-ps.json"));
  assert.deepEqual(
    list.map((p) => [p.hostIp, p.hostPort, p.container.containerPort]),
    [["0.0.0.0", 16379, 6379], ["127.0.0.1", 17000, 7000], ["127.0.0.1", 17001, 7001], ["127.0.0.1", 17002, 7002]],
  );
  assert.deepEqual(list[0].container, {
    id: "0f9e8d7c6b5a",
    name: "cache_redis_1",
    image: "docker.io/library/redis:7-alpine",
    project: "cache",
    containerPort: 6379,
    workingDir: null,
  });
  assert.deepEqual(parseContainerPs("[broken"), []);
  assert.deepEqual(parseContainerPs(""), []);
});

test("isContainerEngine recognises the port forwarders of each engine", () => {
  const yes = [
    { process: "com.docker.backend" },
    { process: "com.docker.back" }, // lsof truncates command names
    { process: "vpnkit-bridge" },
    { process: "docker-proxy" },
    { process: "OrbStack Helper" },
    { process: "limactl" },
    { process: "gvproxy" },
    { process: "rootlessport" },
    { process: "ssh", command: "ssh: /Users/dev/.colima/_lima/colima/ssh.sock [mux]" },
    { process: "ssh", command: "ssh: /home/dev/.lima/default/ssh.sock [mux]" },
  ];
  const no = [{ process: "node" }, { process: "ssh", command: "ssh -L 5432:db:5432 bastion" }, { process: "postgres" }, {}, null];
  for (const l of yes) assert.equal(isContainerEngine(l), true, JSON.stringify(l));
  for (const l of no) assert.equal(isContainerEngine(l), false, JSON.stringify(l));
});

test("attachContainers: engine-owned and owner-less listeners get the container; others don't", async () => {
  const published = parseContainerPs(fx("docker-ps.ndjson"));
  const listeners = [
    L({ port: 5433, pid: 14333, process: "ssh", command: "ssh: /Users/dev/.colima/_lima/colima/ssh.sock [mux]" }),
    L({ port: 8080, pid: null, process: null, command: null, cwd: null, user: null, address: "0.0.0.0" }), // root's docker-proxy
    L({ port: 9000, pid: 42, process: "node" }), // a dev server that happens to share a published port: not the container
    L({ port: 3000, pid: 7 }),
  ];
  const out = await attachContainers(listeners, published, async () => "free");
  const by = (port) => out.find((l) => l.port === port);
  assert.equal(by(5433).container.name, "shop-postgres-1");
  assert.equal(by(5433).pid, 14333, "keeps the real owner");
  assert.equal(by(5433).cwd, null, "the forwarder's cwd is not a project");
  assert.equal(by(9000).cwd, "/p");
  assert.equal(by(8080).container.name, "web");
  assert.equal(by(9000).container, null);
  assert.equal(by(3000).container, null);
  assert.equal(out.length, 4, "published ports that don't answer are not invented");
});

test("attachContainers: published ports with no visible listener appear when they answer", async () => {
  const published = parseContainerPs(fx("docker-ps.ndjson"));
  const probed = [];
  const out = await attachContainers([L({ port: 3000 })], published, async (p) => {
    probed.push(p);
    return p === 5433 || p === 8025 ? "busy" : "free";
  });
  const pg = out.filter((l) => l.port === 5433);
  assert.deepEqual(
    pg.map((l) => [l.address, l.family, l.pid]),
    [["0.0.0.0", "IPv4", null], ["::", "IPv6", null]],
  );
  assert.equal(pg[0].container.containerPort, 5432);
  assert.equal(out.find((l) => l.port === 8025).address, "127.0.0.1");
  assert.ok(!out.some((l) => l.port === 9000));
  assert.deepEqual(out.map((l) => l.port), [...out.map((l) => l.port)].sort((a, b) => a - b), "sorted by port");
  assert.ok(probed.includes(5433) && !probed.includes(3000));
});

test("container source: caches, shares in-flight calls, and survives a dead engine", async () => {
  let t = 0;
  let calls = 0;
  let mode = "ok";
  const exec = async (file, args, opts) => {
    calls++;
    assert.equal(opts.strict, true);
    assert.ok(opts.timeout <= 2000, "tight timeout");
    if (mode === "down") {
      const e = new Error("Cannot connect to the Docker daemon");
      e.code = 1;
      throw e;
    }
    return fx("docker-ps.ndjson");
  };
  const src = createContainerSource({ exec, find: (n) => (n === "docker" ? "/x/docker" : null), now: () => t });
  const [a, b] = await Promise.all([src(), src()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.ok(a.length > 0);
  t = 1000;
  await src();
  assert.equal(calls, 1, "fresh within the TTL");
  t = 5000;
  mode = "down";
  assert.deepEqual(await src(), []);
  assert.equal(calls, 2);
  t = 12000;
  await src();
  assert.equal(calls, 2, "a dead engine is not asked again right away");
  t = 25000;
  mode = "ok";
  assert.ok((await src()).length > 0);

  const none = createContainerSource({ exec: async () => assert.fail("no CLI, no exec"), find: () => null });
  assert.deepEqual(await none(), []);
});

test("findBinary searches extra dirs (browser PATH is minimal) and only .exe on Windows", () => {
  const dirs = binDirs({ platform: "darwin", env: { PATH: "/usr/bin:/bin" }, home: "/Users/dev" });
  assert.ok(dirs.includes("/opt/homebrew/bin") && dirs.includes("/Users/dev/.orbstack/bin"));
  assert.equal(findBinary("docker", { platform: "darwin", dirs, exists: (f) => f === "/opt/homebrew/bin/docker" }), "/opt/homebrew/bin/docker");
  assert.equal(findBinary("docker", { platform: "darwin", dirs, exists: () => false }), null);
  const win = findBinary("docker", { platform: "win32", dirs: ["C:\\bin"], exists: (f) => f.endsWith("docker.exe") });
  assert.match(win, /docker\.exe$/);
});
