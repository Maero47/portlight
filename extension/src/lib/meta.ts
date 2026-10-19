import { extractTitle, type Fetcher } from "./probe.ts";

/**
 * Favicon and <title> of local web servers, so rows can show the app's own icon and name.
 * Fetched in the background after the list has painted, with short timeouts, never
 * following redirects off the machine, and cached per port + pid (a restarted server
 * gets a fresh look).
 */
export interface PageMeta {
  title: string | null;
  /** data: URL of the icon (≤ MAX_ICON_BYTES), or null. */
  icon: string | null;
  at: number;
}

const MAX_ICON_BYTES = 24 * 1024;
const MAX_HTML_BYTES = 32 * 1024;
const TIMEOUT_MS = 1200;
export const META_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 40;

const LINK_RE = /<link\b[^>]*>/gi;
const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined) ?? null;

/** Icon hrefs from <link rel="icon"> & co., best first (SVG and explicit icons before apple-touch). */
export function iconLinks(html: string): string[] {
  const found: { href: string; rank: number }[] = [];
  for (const m of html.matchAll(LINK_RE)) {
    const tag = m[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attr(tag, "href");
    if (!href) continue;
    let rank: number;
    if (rel.includes("icon")) rank = /\.svg(\?|#|$)/i.test(href) || /svg/i.test(attr(tag, "type") ?? "") ? 0 : 1;
    else if (rel.includes("apple-touch-icon")) rank = 2;
    else continue;
    found.push({ href, rank });
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.href);
}

/** Titles that say nothing about the app: framework starter templates and server defaults. */
const GENERIC_TITLE =
  /^(vite( ?\+ ?[\w .+]+)?|vite app|react app|create (next|react) app|next\.?js( app)?|svelte(kit)?( app)?|astro( basics)?|nuxt( app)?|vue( app)?|angular( app)?|remix( app)?|storybook|document|untitled|home|app|my app|welcome.*|index of .*|localhost(:\d+)?|\d{3}\b.*|not found|error|loading.*|jupyter.*|directory listing.*)$/i;

/** Is `title` worth showing next to `name` (the project/process the row already shows)? */
export function meaningfulTitle(title: string | null | undefined, ...already: (string | null | undefined)[]): string | null {
  const t = title?.replace(/\s+/g, " ").trim();
  if (!t || t.length < 2 || GENERIC_TITLE.test(t)) return null;
  const lower = t.toLowerCase();
  for (const a of already) if (a && a.toLowerCase() === lower) return null;
  return t;
}

/** Resolve an icon href against the server's origin; anything that leaves localhost is dropped. */
export function sameOriginUrl(href: string, port: number): string | null {
  if (/^data:image\//i.test(href)) return href;
  try {
    const base = `http://localhost:${port}/`;
    const u = new URL(href, base);
    return u.origin === new URL(base).origin ? u.href : null;
  } catch {
    return null;
  }
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, limit + 1);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function get(url: string, fetcher: Fetcher, timeoutMs: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { signal: ctrl.signal, cache: "no-store", credentials: "omit", redirect: "manual" });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const IMAGE_TYPE = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|webp|jpeg)\b/i;

async function fetchIcon(url: string, fetcher: Fetcher, timeoutMs: number): Promise<string | null> {
  if (url.startsWith("data:")) return url.length <= MAX_ICON_BYTES * 1.4 ? url : null;
  const res = await get(url, fetcher, timeoutMs);
  // SPA dev servers answer every path with index.html: only real images count.
  const type = res?.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!res || !IMAGE_TYPE.test(type)) return null;
  const bytes = await readLimited(res, MAX_ICON_BYTES).catch(() => null);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
  return `data:${type.toLowerCase()};base64,${toBase64(bytes)}`;
}

/** Title and icon of the server on `port`. Never throws; slow or odd servers just give nulls. */
export async function fetchPageMeta(port: number, fetcher: Fetcher = fetch, timeoutMs = TIMEOUT_MS, now = Date.now()): Promise<PageMeta> {
  let title: string | null = null;
  let links: string[] = [];
  const page = await get(`http://localhost:${port}/`, fetcher, timeoutMs);
  if (page && (page.headers.get("content-type") ?? "").includes("html")) {
    const bytes = await readLimited(page, MAX_HTML_BYTES).catch(() => null);
    if (bytes) {
      const html = new TextDecoder().decode(bytes);
      title = extractTitle(html);
      links = iconLinks(html);
    }
  }
  const candidates = [...new Set([...links.map((h) => sameOriginUrl(h, port)), `http://localhost:${port}/favicon.ico`])].filter(
    (u): u is string => !!u,
  );
  let icon: string | null = null;
  for (const url of candidates.slice(0, 3)) {
    icon = await fetchIcon(url, fetcher, timeoutMs);
    if (icon) break;
  }
  return { title, icon, at: now };
}

// ---------- cache ----------

const CACHE_KEY = "portlight.meta";

export function metaKey(port: number, pid: number | null): string {
  return `${port}:${pid ?? "http"}`;
}

export function loadMetaCache(storage: Pick<Storage, "getItem"> = localStorage, now = Date.now()): Map<string, PageMeta> {
  try {
    const raw = JSON.parse(storage.getItem(CACHE_KEY) ?? "{}") as Record<string, PageMeta>;
    return new Map(Object.entries(raw).filter(([, m]) => m && typeof m.at === "number" && now - m.at < META_TTL_MS));
  } catch {
    return new Map();
  }
}

/** Keep the newest entries only, so localStorage stays small. */
export function saveMetaCache(cache: Map<string, PageMeta>, storage: Pick<Storage, "setItem"> = localStorage): void {
  const newest = [...cache].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    /* quota or no storage: icons just load again next time */
  }
}
