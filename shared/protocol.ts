// Message contract between the Chrome extension and the native messaging host.
// Host name: "com.portlight.host". Transport: Chrome native messaging (JSON, length-prefixed).

export const HOST_NAME = "com.portlight.host";
export const PROTOCOL_VERSION = 1;

export type Request =
  | { id: string; type: "ping" }
  | { id: string; type: "list" }                                  // all TCP listeners on this machine
  | { id: string; type: "check"; ports: number[] }               // is each port free?
  | { id: string; type: "suggest"; near?: number; count?: number } // free ports, closest to `near`
  | { id: string; type: "kill"; pid: number; signal?: "TERM" | "KILL"; tree?: boolean } // tree: also its child processes
  | { id: string; type: "reveal"; pid: number }                                         // show the process cwd in Finder / file manager
  | { id: string; type: "openEditor"; pid: number; editor: string }                     // open the process cwd in an editor (one of EditorId)
  | { id: string; type: "netinfo" }                                                     // hostname + LAN addresses, for "Open on Phone"
  | { id: string; type: "openSettings"; pane: SettingsPane }                            // macOS only: open a fixed System Settings pane
  | { id: string; type: "tunnelStatus" }                                                // installed tunnel tools + running share links
  | { id: string; type: "tunnelStart"; port: number; provider?: TunnelProvider }       // public URL for one of your listening ports
  | { id: string; type: "tunnelStop"; port: number };

/** System Settings panes the host can open (macOS). */
export type SettingsPane = "airdrop-handoff" | "sharing";

/** Tunnel binaries the host may start; cloudflared is preferred (quick tunnels need no account). */
export type TunnelProvider = "cloudflared" | "ngrok";

export interface Tunnel {
  port: number;
  provider: TunnelProvider;
  url: string;              // public https URL
  startedAt: string;        // ISO
}

export interface LanAddress {
  name: string;             // interface, e.g. "en0"
  address: string;
  family: "IPv4" | "IPv6";
  virtual: boolean;         // VPN / VM / container bridge: rarely what a phone can reach
}

/** Editors the host accepts for openEditor; anything else is bad_request. */
export type EditorId = "vscode" | "cursor" | "zed" | "webstorm" | "sublime";

export interface Listener {
  port: number;
  address: string;          // "127.0.0.1", "::1", "0.0.0.0", "*", ...
  family: "IPv4" | "IPv6";
  pid: number | null;
  process: string | null;   // short command name, e.g. "node"
  command: string | null;   // full command line when available
  cwd: string | null;       // working directory of the process when available (project hint); null for container forwarders
  user: string | null;
  startedAt: string | null; // ISO time when available
  container?: ContainerInfo | null; // set when the port is published by a Docker/OrbStack/Podman container
}

export interface ContainerInfo {
  id: string;       // short id
  name: string;     // e.g. "api-db-1"
  image: string;    // e.g. "postgres:16"
  project?: string | null;   // compose project, when labelled
  containerPort?: number | null;
  workingDir?: string | null; // compose project directory (com.docker.compose.project.working_dir), when labelled
}

export type Response =
  | { id: string; ok: true; type: "pong"; version: number; platform: string; hostVersion: string }
  | { id: string; ok: true; type: "list"; listeners: Listener[]; scannedAt: string }
  | { id: string; ok: true; type: "check"; results: { port: number; free: boolean; listener?: Listener }[] }
  | { id: string; ok: true; type: "suggest"; ports: number[] }
  | { id: string; ok: true; type: "kill"; pid: number; killed?: number[] }    // killed: every pid signalled, `pid` first
  | { id: string; ok: true; type: "reveal"; path: string }
  | { id: string; ok: true; type: "openEditor"; path: string }
  | { id: string; ok: true; type: "netinfo"; hostname: string; addresses: LanAddress[] }  // best address first
  | { id: string; ok: true; type: "openSettings"; pane: SettingsPane }
  | { id: string; ok: true; type: "tunnelStatus"; providers: Record<TunnelProvider, boolean>; tunnels: Tunnel[] }
  | { id: string; ok: true; type: "tunnelStart"; tunnel: Tunnel }
  | { id: string; ok: true; type: "tunnelStop"; port: number; stopped: boolean }
  | { id: string; ok: false; error: { code: "bad_request" | "not_permitted" | "not_found" | "internal"; message: string } };
