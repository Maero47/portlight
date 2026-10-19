import { HOST_NAME, type Request, type Response } from "../../../shared/protocol.ts";

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type RequestBody = DistributiveOmit<Request, "id">;
type OkType = Extract<Response, { ok: true }>["type"];
type Ok<T extends OkType> = Extract<Response, { ok: true; type: T }>;

export type HostFailure = "missing" | "forbidden" | "crashed" | "timeout" | "unavailable";

/** Transport-level failure (host absent, crashed, …). Protocol errors use HostRequestError. */
export class HostConnectionError extends Error {
  constructor(public readonly kind: HostFailure, message: string) {
    super(message);
    this.name = "HostConnectionError";
  }
}

/** The host answered, but with { ok: false }. */
export class HostRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HostRequestError";
  }
}

/** Map chrome.runtime.lastError messages onto something the UI can act on. */
export function classifyNativeError(message: string | undefined): HostFailure {
  const m = (message ?? "").toLowerCase();
  if (m.includes("not found")) return "missing";
  if (m.includes("forbidden")) return "forbidden";
  if (m.includes("exited") || m.includes("communicating")) return "crashed";
  return "unavailable";
}

export interface Transport {
  (msg: Request): Promise<Response>;
  /** Drop the connection, e.g. after a timeout, so the next request starts a fresh host. */
  reset?: () => void;
}

let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(++seq).toString(36)}`;

/**
 * One long-lived host process per page via connectNative. Requests are matched to
 * responses by id. The host exits when the page goes away (Chrome closes its stdin).
 * Falls back to one process per request where connectNative is missing.
 */
export function portTransport(): Transport {
  let port: chrome.runtime.Port | null = null;
  const pending = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void }>();

  const fail = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const connect = (): chrome.runtime.Port => {
    if (port) return port;
    const p = chrome.runtime.connectNative(HOST_NAME);
    p.onMessage.addListener((res: Response) => {
      const waiter = res && pending.get(res.id);
      if (!waiter) return;
      pending.delete(res.id);
      waiter.resolve(res);
    });
    p.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message;
      if (port === p) port = null;
      fail(new HostConnectionError(message ? classifyNativeError(message) : "crashed", message ?? "The host closed the connection."));
    });
    return (port = p);
  };

  const send: Transport = (msg) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.connectNative) return chromeTransport(msg);
    return new Promise((resolve, reject) => {
      pending.set(msg.id, { resolve, reject });
      try {
        connect().postMessage(msg);
      } catch (e) {
        pending.delete(msg.id);
        port = null;
        reject(new HostConnectionError("unavailable", e instanceof Error ? e.message : String(e)));
      }
    });
  };
  send.reset = () => {
    const p = port;
    port = null;
    p?.disconnect();
    fail(new HostConnectionError("timeout", "The host did not answer in time."));
  };
  return send;
}

/** One short-lived host process per request via sendNativeMessage. */
export const chromeTransport: Transport = (msg) =>
  new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendNativeMessage) {
      reject(new HostConnectionError("unavailable", "Native messaging is not available here."));
      return;
    }
    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, msg, (res: Response | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new HostConnectionError(classifyNativeError(err.message), err.message ?? "Native host error"));
        else if (!res) reject(new HostConnectionError("crashed", "The host closed without answering."));
        else resolve(res);
      });
    } catch (e) {
      reject(new HostConnectionError("unavailable", e instanceof Error ? e.message : String(e)));
    }
  });

export class HostClient {
  constructor(private readonly transport: Transport = chromeTransport, private readonly timeoutMs = 8000) {}

  async request<T extends OkType>(body: RequestBody): Promise<Ok<T>> {
    const msg = { ...body, id: nextId() } as Request;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HostConnectionError("timeout", "The host did not answer in time."));
        this.transport.reset?.();
      }, this.timeoutMs);
    });
    try {
      const res = await Promise.race([this.transport(msg), timeout]);
      if (!res.ok) throw new HostRequestError(res.error.code, res.error.message);
      return res as Ok<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  ping() {
    return this.request<"pong">({ type: "ping" });
  }
  list() {
    return this.request<"list">({ type: "list" });
  }
  check(ports: number[]) {
    return this.request<"check">({ type: "check", ports });
  }
  suggest(near?: number, count = 1) {
    return this.request<"suggest">({ type: "suggest", near, count });
  }
  kill(pid: number, signal: "TERM" | "KILL" = "TERM") {
    return this.request<"kill">({ type: "kill", pid, signal });
  }
}
