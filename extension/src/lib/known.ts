import type { Classifiable } from "./classify.ts";

/**
 * A small curated knowledge base for listeners people keep asking about
 * ("what is on port 5000?", "I killed postgres and it came back").
 */
export interface Known {
  /** Friendly name shown instead of the process name, e.g. "AirPlay Receiver". */
  name?: string;
  /** Small label next to the name, e.g. "macOS". */
  tool?: string;
  /** One or two plain sentences: what this is. */
  about: string;
  /** Where to turn it off, if anywhere. */
  fix?: string;
  /** A shell command that stops it properly, offered with a Copy button. */
  command?: string;
  /** Quitting would not help (the OS restarts it) or would do harm (all of Docker). */
  noQuit?: boolean;
}

interface Entry {
  match: (r: Classifiable, proc: string, cmd: string) => boolean;
  info: (r: Classifiable, proc: string, cmd: string) => Known;
}

const isProc = (...names: string[]) => {
  const set = new Set(names.map((n) => n.toLowerCase()));
  return (_r: Classifiable, proc: string) => set.has(proc.toLowerCase());
};

const RESTARTS = "macOS starts it again on its own, so quitting won’t free the port.";

const ENTRIES: Entry[] = [
  {
    // Since Monterey, AirPlay Receiver holds 5000 and 7000 — the #1 "EADDRINUSE on a Mac" surprise.
    match: (r, proc) => /^(ControlCenter|AirPlayXPCHelper)$/i.test(proc) && (r.port === 5000 || r.port === 7000),
    info: () => ({
      name: "AirPlay Receiver",
      tool: "macOS",
      about: `macOS listens here so other devices can AirPlay to this Mac. ${RESTARTS}`,
      fix: "Turn it off in System Settings › General › AirDrop & Handoff › AirPlay Receiver, or use another port.",
      noQuit: true,
    }),
  },
  {
    match: isProc("ControlCenter"),
    info: () => ({ name: "Control Center", tool: "macOS", about: `Part of the macOS menu bar. ${RESTARTS}`, noQuit: true }),
  },
  {
    match: isProc("rapportd"),
    info: () => ({
      name: "Continuity",
      tool: "macOS",
      about: `rapportd lets your Apple devices find each other for Handoff and Universal Clipboard. ${RESTARTS}`,
      fix: "Turning off Handoff in System Settings › General › AirDrop & Handoff quiets it.",
      noQuit: true,
    }),
  },
  {
    match: isProc("sharingd"),
    info: () => ({ name: "AirDrop & Sharing", tool: "macOS", about: `Handles AirDrop and sharing between devices. ${RESTARTS}`, noQuit: true }),
  },
  {
    match: isProc("launchd"),
    info: (r) => ({
      name: r.port === 22 ? "Remote Login" : "launchd socket",
      tool: "macOS",
      about: `macOS holds this port for a service and starts the service on the first connection. ${RESTARTS}`,
      fix: r.port === 22 ? "Turn it off in System Settings › General › Sharing › Remote Login." : undefined,
      noQuit: true,
    }),
  },
  {
    match: (r, proc) => /^sshd(-session)?$/i.test(proc) && r.port === 22,
    info: () => ({
      name: "Remote Login",
      tool: "SSH",
      about: "Lets other computers sign in to this one over SSH. The system restarts it on demand.",
      fix: "On a Mac: System Settings › General › Sharing › Remote Login.",
      noQuit: true,
    }),
  },
  {
    match: isProc("screensharingd"),
    info: () => ({
      name: "Screen Sharing",
      tool: "macOS",
      about: `Lets others view this screen. ${RESTARTS}`,
      fix: "Turn it off in System Settings › General › Sharing › Screen Sharing.",
      noQuit: true,
    }),
  },
  {
    match: isProc("ARDAgent"),
    info: () => ({
      name: "Remote Management",
      tool: "macOS",
      about: `Apple Remote Desktop’s agent. ${RESTARTS}`,
      fix: "Turn it off in System Settings › General › Sharing › Remote Management.",
      noQuit: true,
    }),
  },
  {
    match: (_r, proc) => /^(smbd|netbiosd)$/i.test(proc),
    info: () => ({
      name: "File Sharing",
      tool: "SMB",
      about: "Shares folders with other computers. The system restarts it on demand.",
      fix: "On a Mac: System Settings › General › Sharing › File Sharing.",
      noQuit: true,
    }),
  },
  {
    match: isProc("cupsd"),
    info: () => ({ name: "Printing", tool: "CUPS", about: "The print system. It starts again whenever something prints.", noQuit: true }),
  },
  {
    match: isProc("mDNSResponder", "avahi-daemon"),
    info: () => ({ name: "Bonjour", tool: "mDNS", about: "Finds printers and devices on your network. The system keeps it running.", noQuit: true }),
  },
  {
    match: (_r, proc) => /^systemd(-[\w]+)?$/i.test(proc),
    info: () => ({
      name: "systemd socket",
      tool: "Linux",
      about: "systemd holds this port and starts a service on the first connection, so quitting won’t free it.",
      fix: "Find it with systemctl list-sockets, then stop the .socket unit.",
      noQuit: true,
    }),
  },
  {
    match: (r, proc) => (proc === "System" || proc === "svchost.exe" || proc === "svchost") && r.port < 49152,
    info: (_r, proc) => ({
      name: proc === "System" ? "Windows" : "Windows service",
      tool: "Windows",
      about:
        proc === "System"
          ? "Windows itself holds this port (HTTP.sys, file sharing or another kernel service)."
          : "A Windows service host. Stop the service from the Services app instead of quitting it.",
      noQuit: true,
    }),
  },
  {
    // Docker Desktop / OrbStack proxies published ports; quitting it would stop every container.
    match: (r, proc, cmd) =>
      !r.container && (/^(com\.docker\.[\w.-]+|vpnkit(-bridge)?|docker-proxy|OrbStack( Helper)?|orbstack|gvproxy)$/i.test(proc) || /com\.docker\.|vpnkit/i.test(cmd)),
    info: (_r, proc) => ({
      name: /orb/i.test(proc) ? "OrbStack" : /gvproxy/i.test(proc) ? "Podman" : "Docker",
      tool: "Containers",
      about: "Forwards this port to a container. Quitting it would stop every container, not just this one.",
      command: /gvproxy/i.test(proc) ? "podman ps" : "docker ps",
      fix: "Find the container with the command below, then stop just that one.",
      noQuit: true,
    }),
  },
  {
    match: (r) => !!r.container,
    info: (r, proc) => {
      const c = r.container!;
      const cli = /gvproxy|podman/i.test(proc) ? "podman" : "docker";
      return {
        about: `Published by ${c.project ? `the “${c.project}” compose project` : "a container"}. Quitting the proxy would take every container down with it.`,
        command: SAFE_CONTAINER.test(c.name) ? `${cli} stop ${c.name}` : undefined,
        noQuit: true,
      };
    },
  },
  {
    match: (_r, proc) => /^figma[_ ]agent$/i.test(proc),
    info: () => ({ name: "Figma Agent", tool: "Figma", about: "Lets figma.com use the fonts installed on this computer. Figma starts it again when it needs it." }),
  },
  {
    match: isProc("Spotify"),
    info: () => ({ name: "Spotify", tool: "Spotify Connect", about: "Lets other devices on your network find and control Spotify." }),
  },
  {
    match: isProc("Dropbox"),
    info: () => ({ name: "Dropbox", tool: "LAN sync", about: "Dropbox syncs with other computers on your network over this port." }),
  },
  {
    match: (r, proc) => r.port === 63342 || /^(idea|webstorm|pycharm|goland|rubymine|phpstorm|clion|rider|datagrip)$/i.test(proc),
    info: () => ({ name: "JetBrains IDE", tool: "Built-in server", about: "The IDE’s built-in web server, used for previews and debugging." }),
  },
];

// Commands built from process data end up pasted into a terminal, so anything interpolated
// must match the tool's real naming rules; otherwise no command is offered.
const SAFE_FORMULA = /^[A-Za-z0-9][A-Za-z0-9@._+-]*$/;
const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/; // Docker's own rule for container names

/** "postgresql@16" from "/opt/homebrew/opt/postgresql@16/bin/postgres"; null if it isn't a plain formula name. */
export function brewFormula(command: string | null | undefined): string | null {
  const m = /(?:\/opt\/homebrew|\/usr\/local|\/home\/linuxbrew\/\.linuxbrew)\/(?:opt|Cellar)\/([^/\s]+)\//.exec(command ?? "");
  const f = m?.[1];
  return f && SAFE_FORMULA.test(f) ? f : null;
}

const BREW_SERVICES =
  /^(postgres(ql)?|mysql|mariadb|redis|valkey|mongodb|memcached|rabbitmq|nginx|httpd|elasticsearch|opensearch|minio|influxdb|etcd|php|dnsmasq|clickhouse|meilisearch|ollama)([@-][A-Za-z0-9.@_+-]*)?$/i;

/** What Portlight knows about a listener, or null for an ordinary one. */
export function knownFor(r: Classifiable): Known | null {
  const proc = (r.process ?? "").trim();
  const cmd = r.command ?? "";
  for (const e of ENTRIES) if (e.match(r, proc, cmd)) return e.info(r, proc, cmd);
  // Homebrew services run under launchd with KeepAlive: quit them and they come straight back.
  const formula = brewFormula(cmd);
  if (formula && BREW_SERVICES.test(formula)) {
    return {
      about: "Installed with Homebrew. If you started it with brew services, launchd restarts it right after Quit.",
      command: `brew services stop ${formula}`,
    };
  }
  return null;
}
