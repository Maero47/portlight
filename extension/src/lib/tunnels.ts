import type { Tunnel, TunnelProvider } from "../../../shared/protocol.ts";
import { HostConnectionError, HostRequestError, isUnsupported, type HostClient } from "./host.ts";

/**
 * Share links live in the background worker, not the popup: the popup closes the moment
 * you click elsewhere to paste the link, and its helper process (and so the tunnel) would
 * go with it. The worker holds one connectNative port while any tunnel runs — which also
 * keeps the worker alive — and drops it when the last one stops, so the helper exits.
 */
/**
 * status: running tunnels, from memory (never starts a helper; providers may be null).
 * providers: also checks which tunnel tools are installed (may start a one-off helper).
 */
export type TunnelOp = { op: "status" } | { op: "providers" } | { op: "start"; port: number } | { op: "stop"; port: number };
export type TunnelMessage = { type: "portlight:tunnel" } & TunnelOp;

export interface TunnelState {
  providers: Record<TunnelProvider, boolean> | null;
  tunnels: Tunnel[];
}
export type TunnelReply =
  | ({ ok: true } & TunnelState)
  | { ok: false; code: string; message: string };

export function isTunnelMessage(m: unknown): m is TunnelMessage {
  return !!m && typeof m === "object" && (m as { type?: unknown }).type === "portlight:tunnel";
}

function failure(e: unknown): TunnelReply {
  if (isUnsupported(e)) return { ok: false, code: "unsupported", message: "This needs a newer helper." };
  if (e instanceof HostRequestError) return { ok: false, code: e.code, message: e.message };
  if (e instanceof HostConnectionError) return { ok: false, code: e.kind, message: e.message };
  return { ok: false, code: "internal", message: e instanceof Error ? e.message : String(e) };
}

export interface TunnelService {
  handle(op: TunnelOp): Promise<TunnelReply>;
  /** Check on running tunnels; drops the connection once none are left. */
  poll(): Promise<void>;
  readonly connected: boolean;
}

/**
 * `live()` makes a client on a long-lived connection (its `transport.reset` disconnects it),
 * `once` answers status questions without keeping a helper around.
 */
export function createTunnelService(opts: {
  live: () => { client: HostClient; close: () => void };
  once: HostClient;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  pollMs?: number;
  now?: () => number;
}): TunnelService {
  const { live, once, pollMs = 5000, now = Date.now } = opts;
  let providers: { value: Record<TunnelProvider, boolean>; at: number } | null = null;
  const PROVIDERS_TTL_MS = 60_000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  type Conn = { client: HostClient; close: () => void };
  let conn: Conn | null = null;
  let timer: unknown = null;
  /** tunnelStart requests in flight, by port. While any is pending the helper must stay: closing it kills the tunnel being born. */
  const pending = new Map<number, number>();
  let starting = 0;
  /** Ports whose start the user cancelled while it was pending. */
  const cancelled = new Set<number>();

  const close = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    conn?.close();
    conn = null;
  };

  /**
   * Drop the helper only when it is still the one we asked (a reply can arrive after a
   * stop + new start replaced it), no start is pending, and it reports no tunnels at all
   * (the host lists starting tunnels too).
   */
  const closeIfIdle = (asked: Conn, tunnels: Tunnel[]) => {
    if (conn === asked && starting === 0 && tunnels.length === 0) close();
  };

  async function status(checkProviders = false): Promise<TunnelState> {
    const c = conn;
    if (!c) {
      // No live helper means no tunnels; only ask a one-off helper when tools must be checked.
      if (checkProviders && (!providers || now() - providers.at > PROVIDERS_TTL_MS)) {
        providers = { value: (await once.tunnelStatus()).providers, at: now() };
      }
      return { providers: providers?.value ?? null, tunnels: [] };
    }
    const r = await c.client.tunnelStatus();
    providers = { value: r.providers, at: now() };
    closeIfIdle(c, r.tunnels);
    // The host registers a tunnel only after checking the port; until then our own pending
    // start is the truth, so every status reply agrees that it is starting.
    const tunnels = [...r.tunnels];
    for (const port of pending.keys()) {
      if (tunnels.some((t) => t.port === port)) continue;
      const provider: TunnelProvider = r.providers.cloudflared || !r.providers.ngrok ? "cloudflared" : "ngrok";
      tunnels.push({ port, provider, url: null, startedAt: new Date(now()).toISOString(), state: "starting" });
    }
    return { providers: r.providers, tunnels };
  }

  async function poll() {
    const c = conn;
    if (!c) return;
    try {
      await status();
    } catch {
      // The helper went away (and took its tunnels with it): start clean next time.
      // Not while a start is pending — that request fails on its own and cleans up after.
      if (conn === c && starting === 0) close();
    }
  }

  async function handle(op: TunnelOp): Promise<TunnelReply> {
    try {
      if (op.op === "start") {
        const c = (conn ??= live());
        if (timer === null) timer = setTimer(() => void poll(), pollMs);
        const settle = () => {
          starting--;
          const n = (pending.get(op.port) ?? 1) - 1;
          if (n > 0) pending.set(op.port, n);
          else pending.delete(op.port);
        };
        starting++;
        pending.set(op.port, (pending.get(op.port) ?? 0) + 1);
        try {
          await c.client.tunnelStart(op.port);
        } catch (e) {
          settle();
          cancelled.delete(op.port);
          await poll();
          throw e;
        }
        settle();
        if (cancelled.delete(op.port)) {
          // Cancelled, yet the helper still produced a link (e.g. an older helper that doesn't
          // honour a stop mid-start): take it down again, and never report it as a success.
          await c.client.tunnelStop(op.port).catch(() => {});
          await poll();
          return { ok: false, code: "cancelled", message: `the share link for port ${op.port} was cancelled` };
        }
      } else if (op.op === "stop") {
        // A cancelled start is no longer reported as starting; `starting` still keeps the helper until it settles.
        if (pending.delete(op.port)) cancelled.add(op.port);
        if (conn) await conn.client.tunnelStop(op.port);
      }
      return { ok: true, ...(await status(op.op === "providers")) };
    } catch (e) {
      return failure(e);
    }
  }

  return {
    handle,
    poll,
    get connected() {
      return conn !== null;
    },
  };
}

/** Popup side: ask the background worker. */
export async function tunnelRequest(op: TunnelOp): Promise<TunnelReply> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return { ok: false, code: "unavailable", message: "Not running as an extension." };
  }
  try {
    const reply = (await chrome.runtime.sendMessage({ type: "portlight:tunnel", ...op } satisfies TunnelMessage)) as TunnelReply | undefined;
    return reply ?? { ok: false, code: "unavailable", message: "The background worker did not answer." };
  } catch (e) {
    return { ok: false, code: "unavailable", message: e instanceof Error ? e.message : String(e) };
  }
}
