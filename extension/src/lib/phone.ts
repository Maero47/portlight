import type { LanAddress } from "../../../shared/protocol.ts";
import { isWildcard, scopeOf, type PortRow } from "./shape.ts";

/** "http://192.168.1.23:5173", with IPv6 literals bracketed. */
export function hostUrl(address: string, port: number): string {
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}

/**
 * The URL a phone on the same network would open, or null when there is none.
 * A server bound to one specific LAN address is only reachable there; otherwise the
 * host's best address wins (physical IPv4 first — the host already sorted them).
 */
export function phoneUrl(row: Pick<PortRow, "port" | "addresses">, addresses: LanAddress[]): string | null {
  const specific = row.addresses
    .map((a) => a.replace(/^\[|\]$/g, "").replace(/%.*$/, ""))
    .filter((a) => !isWildcard(a) && scopeOf(a) === "network");
  if (specific.length && !row.addresses.some(isWildcard)) {
    const pick = specific.find((a) => !a.includes(":")) ?? specific[0]!;
    return hostUrl(pick, row.port);
  }
  // Wildcards ("*", "0.0.0.0", "::" — dual-stack on macOS and Linux) answer on every address.
  const best = addresses.find((a) => !a.virtual) ?? addresses[0];
  return best ? hostUrl(best.address, row.port) : null;
}

export interface ExposeHint {
  /** What to add to the command that starts the server. */
  flag: string;
  tool: string;
}

/** Flags that make each dev server listen on the network instead of localhost only. */
const FLAGS: Record<string, (port: number) => string> = {
  Vite: () => "--host",
  SvelteKit: () => "--host",
  Astro: () => "--host",
  Nuxt: () => "--host",
  Remix: () => "--host",
  "Next.js": () => "-H 0.0.0.0",
  Gatsby: () => "-H 0.0.0.0",
  Storybook: () => "--host 0.0.0.0",
  webpack: () => "--host 0.0.0.0",
  Parcel: () => "--host 0.0.0.0",
  Angular: () => "--host 0.0.0.0",
  Uvicorn: () => "--host 0.0.0.0",
  Gunicorn: (p) => `--bind 0.0.0.0:${p}`,
  Flask: () => "--host=0.0.0.0",
  Django: (p) => `runserver 0.0.0.0:${p}`,
  "Python HTTP": () => "--bind 0.0.0.0",
  Rails: () => "-b 0.0.0.0",
  PHP: (p) => `-S 0.0.0.0:${p}`,
  Hugo: () => "--bind 0.0.0.0",
  Jekyll: () => "--host 0.0.0.0",
  Wrangler: () => "--ip 0.0.0.0",
  Jupyter: () => "--ip=0.0.0.0",
};

/** The flag for this row's tool, or null when Portlight doesn't know it. */
export function exposeHint(row: Pick<PortRow, "tool" | "port">): ExposeHint | null {
  const f = row.tool ? FLAGS[row.tool] : undefined;
  return f && row.tool ? { flag: f(row.port), tool: row.tool } : null;
}
