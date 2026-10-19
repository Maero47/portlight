import type { PortRow } from "./shape.ts";

/**
 * HTTP-only fallback used when the native host is not installed.
 * We can only see ports that answer HTTP; databases, sockets and anything
 * that refuses the request look free. The UI labels these results accordingly.
 */

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

export const COMMON_DEV_PORTS: readonly number[] = [
  ...new Set([
    80, 1234, 1313, 1337,
    ...range(3000, 3010), 3030, 3333,
    4000, 4173, 4200, 4321, 4400, 4444,
    ...range(5000, 5010), ...range(5173, 5180), 5500, 5555,
    6006, 7000, 7070, 7777,
    ...range(8000, 8100), 8443, 8787, 8888,
    9000, 9001, 9090, 9229, 9999,
  ]),
].sort((a, b) => a - b);

export interface ProbeResult {
  port: number;
  open: boolean;
  status?: number;
  title?: string | null;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Pull <title> out of the first few KB of an HTML document. */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m?.[1]) return null;
  const t = m[1]
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
  return t ? t.slice(0, 80) : null;
}

async function readHead(res: Response, limit = 4096): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(buf.subarray(0, limit));
}

/** Probe one port. Any HTTP response — even a 404 or 500 — means something is listening. */
export async function probePort(port: number, fetcher: Fetcher = fetch, timeoutMs = 900): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(`http://localhost:${port}/`, {
      method: "GET",
      signal: ctrl.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
    });
    let title: string | null = null;
    const type = res.headers?.get?.("content-type") ?? "";
    if (type.includes("html")) {
      try {
        title = extractTitle(await readHead(res));
      } catch {
        /* body unreadable — still open */
      }
    }
    return { port, open: true, status: res.status, title };
  } catch {
    return { port, open: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe many ports with bounded concurrency, reporting each open port as it is found. */
export async function probePorts(
  ports: readonly number[],
  opts: { fetcher?: Fetcher; timeoutMs?: number; concurrency?: number; onOpen?: (r: ProbeResult) => void } = {},
): Promise<ProbeResult[]> {
  const { fetcher = fetch, timeoutMs = 900, concurrency = 24, onOpen } = opts;
  const results: ProbeResult[] = new Array(ports.length);
  let next = 0;
  async function worker() {
    while (next < ports.length) {
      const i = next++;
      const r = await probePort(ports[i]!, fetcher, timeoutMs);
      results[i] = r;
      if (r.open) onOpen?.(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  return results;
}

export function probeToRow(r: ProbeResult): PortRow {
  return {
    key: `${r.port}:http`,
    port: r.port,
    pid: null,
    process: null,
    tool: null,
    project: null,
    cwd: null,
    command: null,
    user: null,
    addresses: ["localhost"],
    scope: "local",
    startedAt: null,
    source: "http",
    title: r.title ?? null,
    status: r.status,
  };
}
