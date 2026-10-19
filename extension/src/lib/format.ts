/** Compact uptime: "now", "42s", "7m", "3h 05m", "2d 4h". Null when the start time is unknown. */
export function formatUptime(startedAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Longer spoken form for tooltips and screen readers. */
export function describeUptime(startedAt: string | null | undefined, now: number = Date.now()): string | null {
  const short = formatUptime(startedAt, now);
  if (!short) return null;
  if (short === "now") return "Started just now";
  const words = short
    .replace(/(\d+)d/, (_, n) => `${n} ${n === "1" ? "day" : "days"}`)
    .replace(/(\d+)h/, (_, n) => `${Number(n)} ${n === "1" ? "hour" : "hours"}`)
    .replace(/(\d+)m/, (_, n) => `${Number(n)} ${Number(n) === 1 ? "minute" : "minutes"}`)
    .replace(/(\d+)s/, (_, n) => `${n} seconds`);
  return `Running for ${words}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 ports in use" / "No ports in use". */
export function summary(count: number): string {
  return count === 0 ? "No ports in use" : `${plural(count, "port")} in use`;
}
