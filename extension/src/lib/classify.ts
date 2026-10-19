import type { Group } from "./settings.ts";
import type { ContainerInfo } from "../../../shared/protocol.ts";

/** What classification needs from a row. */
export interface Classifiable {
  port: number;
  process: string | null;
  command: string | null;
  tool: string | null;
  project: string | null;
  container?: ContainerInfo | null;
}

export const GROUP_ORDER: readonly Group[] = ["dev", "database", "docker", "app", "system"];

export const GROUP_LABEL: Record<Group, string> = {
  dev: "Dev Servers",
  database: "Databases",
  docker: "Containers",
  app: "Apps",
  system: "System",
};

const DATABASE_TOOLS = new Set(["PostgreSQL", "Redis", "MongoDB", "MySQL"]);

const DATABASE_PROCESS =
  /^(postgres|postmaster|mysqld|mariadbd|mongod|mongos|redis-server|valkey-server|keydb-server|memcached|clickhouse(-server)?|cockroach|influxd|etcd|nats-server|minio|surreal|meilisearch|typesense-server|qdrant|neo4j|cassandra|couchdb|beam\.smp|rabbitmq-server|sqld|turso|dragonfly)$/i;

const DATABASE_COMMAND = /\b(elasticsearch|opensearch|kafka\.Kafka|zookeeper|neo4j|cassandra|rabbitmq)\b/i;

const DOCKER_PROCESS =
  /^(com\.docker\.[\w.-]+|docker-proxy|dockerd|vpnkit(-bridge)?|OrbStack( Helper)?|orbstack|limactl|podman|gvproxy|colima|containerd|rancher-desktop|ssh)$/i;

const DOCKER_COMMAND = /com\.docker\.|docker-proxy|vpnkit|OrbStack|[/_.]lima\b|\bgvproxy\b|\bcolima\b/i;

/** macOS, Linux and Windows services that belong to the OS, not to you. */
const SYSTEM_PROCESS = new Set(
  [
    // macOS
    "ControlCenter", "rapportd", "launchd", "mDNSResponder", "sharingd", "AirPlayXPCHelper", "AirPlayUIAgent",
    "remoted", "remotepairingd", "identityservicesd", "cupsd", "netbiosd", "smbd", "screensharingd", "ARDAgent",
    "UserEventAgent", "WiFiAgent", "symptomsd", "apsd", "configd", "kdc", "sshd", "sshd-session", "httpd",
    "SystemUIServer", "Finder", "universalaccessd", "coreaudiod", "bluetoothd", "airportd", "nsurlsessiond",
    "assistantd", "familycircled", "timed", "usbmuxd", "lockdownd", "AMPDevicesAgent", "MTLCompilerService",
    // Linux
    "systemd", "systemd-resolved", "systemd-resolve", "systemd-networkd", "systemd-timesyncd", "avahi-daemon",
    "dnsmasq", "chronyd", "rpcbind", "rpc.statd", "exim4", "master", "postfix", "cups-browsed", "NetworkManager",
    "dhclient", "xrdp", "xrdp-sesman", "kdeconnectd", "gsd-sharing",
    // Windows
    "System", "svchost.exe", "svchost", "lsass.exe", "wininit.exe", "services.exe", "spoolsv.exe", "Idle",
    "System Idle Process", "smss.exe", "csrss.exe", "winlogon.exe", "jhi_service.exe",
  ].map((s) => s.toLowerCase()),
);

const SYSTEM_COMMAND = /^(\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/lib\/systemd\/|\/usr\/lib\/systemd\/|C:\\Windows\\)/i;

/** Runtimes that almost always mean "a dev server you started". */
const DEV_PROCESS =
  /^(node|nodejs|bun|deno|python[\d.]*|Python|ruby|php(-fpm)?|java|go|cargo|rustc|dotnet|beam|erl|elixir|uvicorn|gunicorn|hypercorn|puma|rails|caddy|nginx|httpd-dev|hugo|jekyll|workerd|esbuild|vite|next-server|air|tsx|ts-node|ollama|lmstudio|llama-server|jupyter[\w-]*)$/i;

/** A packaged desktop app: anything run out of an .app bundle or Program Files. */
const APP_COMMAND = /\.app\/Contents\/|\/Applications\/|\\Program Files( \(x86\))?\\|\/opt\/google\/|\/snap\/|\/usr\/share\/code\//i;

function base(process: string | null): string {
  return (process ?? "").trim();
}

/**
 * Sort a listener into the group the popup shows it under.
 * Order matters: a container beats its proxy process, a database beats a generic runtime,
 * and the OS beats "packaged app".
 */
export function groupOf(r: Classifiable): Group {
  const proc = base(r.process);
  const cmd = r.command ?? "";
  if (r.container) return "docker";
  if (r.tool && DATABASE_TOOLS.has(r.tool)) return "database";
  if (DATABASE_PROCESS.test(proc) || DATABASE_COMMAND.test(cmd)) return "database";
  if (r.tool === "Docker" || DOCKER_PROCESS.test(proc) || DOCKER_COMMAND.test(cmd)) {
    // A bare "ssh" is only Docker when it forwards for a VM; otherwise it's an ordinary tunnel.
    if (proc.toLowerCase() !== "ssh" || DOCKER_COMMAND.test(cmd)) return "docker";
  }
  if (SYSTEM_PROCESS.has(proc.toLowerCase()) || SYSTEM_COMMAND.test(cmd)) return "system";
  if (r.tool) return "dev";
  if (DEV_PROCESS.test(proc)) return "dev";
  if (APP_COMMAND.test(cmd)) return "app";
  // Desktop helpers tend to have human names ("Figma Agent", "Spotify", "Code Helper").
  if (/\s/.test(proc) || /^[A-Z][a-z]/.test(proc) || /\.exe$/i.test(proc)) return "app";
  return "dev";
}
