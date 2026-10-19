import type { Listener } from "../../../shared/protocol.ts";

/** Where a listener can be reached from. */
export type Scope = "local" | "network";

/** One row in the popup: a port held by one process (IPv4/IPv6 sockets merged). */
export interface PortRow {
  key: string;
  port: number;
  pid: number | null;
  process: string | null;
  /** Recognised dev tool or service, e.g. "Vite", "Next.js", "PostgreSQL". */
  tool: string | null;
  /** Short project hint derived from cwd, e.g. "portlight" or "shop/server". */
  project: string | null;
  cwd: string | null;
  command: string | null;
  user: string | null;
  addresses: string[];
  scope: Scope;
  startedAt: string | null;
  /** "host" = reported by the native host, "http" = found by the HTTP fallback probe. */
  source: "host" | "http";
  /** Page title and status code, only available from the HTTP probe. */
  title?: string | null;
  status?: number;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost|::ffff:127\.\d+\.\d+\.\d+)$/i;

/** Loopback addresses are private to this machine; anything else is reachable from the network. */
export function scopeOf(address: string): Scope {
  const a = address.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return LOOPBACK.test(a) ? "local" : "network";
}

export function isWildcard(address: string): boolean {
  const a = address.trim().replace(/^\[|\]$/g, "");
  return a === "*" || a === "0.0.0.0" || a === "::" || a === "::0";
}

/** Human description of where a row is reachable, used for tooltips and screen readers. */
export function describeScope(row: Pick<PortRow, "scope" | "addresses">): string {
  if (row.scope === "local") return "Only reachable from this Mac";
  if (row.addresses.some(isWildcard)) return "Listening on all interfaces — reachable from your network";
  return `Reachable on ${row.addresses.join(", ")}`;
}

const GENERIC_DIRS = new Set([
  "src", "app", "server", "client", "web", "api", "frontend", "backend", "packages", "apps",
  "dist", "build", "out", "public", "www", "site", "docs", "example", "examples", "demo",
]);

/** Folders people keep projects in — never useful as a project prefix. */
const CONTAINER_DIRS = new Set([
  "code", "projects", "project", "dev", "developer", "src", "repos", "repo", "git", "github", "workspace",
  "workspaces", "work", "sites", "documents", "desktop", "downloads", "tmp", "temp", "sandbox", "playground",
]);

/**
 * Turn a working directory into a short project label.
 * "/Users/me/code/shop/server" -> "shop/server"; home and root give null.
 */
export function projectFromCwd(cwd: string | null | undefined, home?: string | null): string | null {
  if (!cwd) return null;
  const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!norm || norm === "/" || /^[a-z]:$/i.test(norm)) return null;
  if (home && norm === home.replace(/\\/g, "/").replace(/\/+$/, "")) return null;
  if (/^\/(Users|home)\/[^/]+$/.test(norm) || /^\/root$/.test(norm)) return null;
  if (/^\/(usr|bin|sbin|System|Library|private|var|opt|etc|Applications)(\/|$)/.test(norm)) return null;
  const parts = norm.split("/").filter(Boolean);
  const base = parts[parts.length - 1];
  if (!base) return null;
  const parent = parts[parts.length - 2];
  if (GENERIC_DIRS.has(base.toLowerCase()) && parent && !/^(Users|home)$/.test(parent) && !CONTAINER_DIRS.has(parent.toLowerCase())) {
    return `${parent}/${base}`;
  }
  return base;
}

const TOOLS: [RegExp, string][] = [
  [/\bnext(\.js)?\b.*\b(dev|start)\b|next-server|\/next\/dist\//i, "Next.js"],
  [/\bnuxt\b/i, "Nuxt"],
  [/\bastro\b/i, "Astro"],
  [/\bremix\b/i, "Remix"],
  [/\bsvelte-?kit\b/i, "SvelteKit"],
  [/\bstorybook\b/i, "Storybook"],
  [/\bvite\b/i, "Vite"],
  [/\bwebpack\b/i, "webpack"],
  [/\bparcel\b/i, "Parcel"],
  [/\besbuild\b/i, "esbuild"],
  [/\bng\b.*\bserve\b|@angular/i, "Angular"],
  [/\bgatsby\b/i, "Gatsby"],
  [/\bwrangler\b|workerd/i, "Wrangler"],
  [/\bexpo\b/i, "Expo"],
  [/\bjupyter\b/i, "Jupyter"],
  [/manage\.py\s+runserver|\bdjango\b/i, "Django"],
  [/\buvicorn\b/i, "Uvicorn"],
  [/\bgunicorn\b/i, "Gunicorn"],
  [/\bflask\b/i, "Flask"],
  [/http\.server|SimpleHTTPServer/i, "Python HTTP"],
  [/\brails\b|\bpuma\b/i, "Rails"],
  [/\bphp\b.*\s-S\s/i, "PHP"],
  [/\bhugo\b/i, "Hugo"],
  [/\bjekyll\b/i, "Jekyll"],
  [/\bdeno\b/i, "Deno"],
  [/\bbun\b/i, "Bun"],
  [/\bpostgres\b|\bpostmaster\b/i, "PostgreSQL"],
  [/\bredis-server\b/i, "Redis"],
  [/\bmongod\b/i, "MongoDB"],
  [/\bmysqld\b/i, "MySQL"],
  [/com\.docker|docker-proxy|vpnkit|\bdocker\b/i, "Docker"],
  [/\bollama\b/i, "Ollama"],
];

/** Recognise a well-known dev tool from the command line (falls back to the process name). */
export function detectTool(command: string | null | undefined, process?: string | null): string | null {
  const hay = `${command ?? ""} ${process ?? ""}`.trim();
  if (!hay) return null;
  for (const [re, label] of TOOLS) if (re.test(hay)) return label;
  return null;
}

function rowKey(port: number, pid: number | null): string {
  return `${port}:${pid ?? "?"}`;
}

/**
 * Merge raw listeners into rows: one row per (port, pid), IPv4 + IPv6 sockets combined.
 * The widest scope wins — if any socket is exposed, the row is exposed. Sorted by port.
 */
export function shapeListeners(listeners: Listener[], home?: string | null): PortRow[] {
  const map = new Map<string, PortRow>();
  for (const l of listeners) {
    if (!Number.isInteger(l.port) || l.port <= 0) continue;
    const key = rowKey(l.port, l.pid);
    const existing = map.get(key);
    if (existing) {
      if (!existing.addresses.includes(l.address)) existing.addresses.push(l.address);
      if (scopeOf(l.address) === "network") existing.scope = "network";
      existing.process ??= l.process;
      existing.command ??= l.command;
      existing.cwd ??= l.cwd;
      existing.user ??= l.user;
      existing.startedAt ??= l.startedAt;
      existing.project ??= projectFromCwd(l.cwd, home);
      existing.tool ??= detectTool(l.command, l.process);
      continue;
    }
    map.set(key, {
      key,
      port: l.port,
      pid: l.pid,
      process: l.process,
      tool: detectTool(l.command, l.process),
      project: projectFromCwd(l.cwd, home),
      cwd: l.cwd,
      command: l.command,
      user: l.user,
      addresses: [l.address],
      scope: scopeOf(l.address),
      startedAt: l.startedAt,
      source: "host",
    });
  }
  return [...map.values()].sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

/** Number of distinct busy ports (what the toolbar badge shows). */
export function busyPortCount(rows: Pick<PortRow, "port">[]): number {
  return new Set(rows.map((r) => r.port)).size;
}

/** Parse a user-typed port. Accepts "3000", ":3000", "localhost:3000". */
export function parsePort(input: string): number | null {
  const m = /^\s*(?:(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])?:)?(\d{1,5})\s*\/?\s*$/i.exec(input);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Case-insensitive filter across port, process, tool, project and command. */
export function filterRows(rows: PortRow[], query: string): PortRow[] {
  const q = query.trim().toLowerCase().replace(/^:/, "");
  if (!q) return rows;
  const terms = q.split(/\s+/);
  return rows.filter((r) => {
    const hay = [
      String(r.port), r.process, r.tool, r.project, r.command, r.title, r.scope === "network" ? "network exposed" : "local",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return terms.every((t) => (/^\d+$/.test(t) ? String(r.port).startsWith(t) || hay.includes(t) : hay.includes(t)));
  });
}

/**
 * Nearest free ports to `near`, preferring ports above it (dev servers count upward),
 * skipping anything in `busy`. Stays out of the privileged range unless asked for it.
 */
export function suggestFreePorts(busy: Iterable<number>, near = 3000, count = 1): number[] {
  const taken = new Set(busy);
  const out: number[] = [];
  const start = Math.min(Math.max(near, 1), 65535);
  const floor = start < 1024 ? 1 : 1024;
  for (let p = start; p <= 65535 && out.length < count; p++) if (!taken.has(p)) out.push(p);
  for (let p = start - 1; p >= floor && out.length < count; p--) if (!taken.has(p)) out.push(p);
  return out;
}

export function urlFor(port: number): string {
  return `http://localhost:${port}`;
}
