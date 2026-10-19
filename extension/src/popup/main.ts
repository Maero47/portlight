import { icon } from "./icons.ts";
import {
  HostClient,
  HostConnectionError,
  HostRequestError,
  isUnsupported,
  portTransport,
  type HostFailure,
} from "../lib/host.ts";
import { detectOs, installCommand, thisDevice, yourDevices } from "../lib/platform.ts";
import {
  busyPortCount,
  describeScope,
  filterRows,
  parsePort,
  shapeListeners,
  suggestFreePorts,
  urlFor,
  type PortRow,
} from "../lib/shape.ts";
import { describeUptime, formatUptime, plural, summary } from "../lib/format.ts";
import { COMMON_DEV_PORTS, probePort, probePorts, probeToRow } from "../lib/probe.ts";
import { GROUP_LABEL, GROUP_ORDER } from "../lib/classify.ts";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  onSettingsChanged,
  saveSettings,
  type Editor,
  type Settings,
} from "../lib/settings.ts";
import { badgeCount, bestTab, hiddenReason, isIdle, type HiddenReason, type TabRef } from "../lib/view.ts";
import { closeTabs, focusTab, localTabs, watchTabs } from "../lib/tabs.ts";
import { fetchPageMeta, loadMetaCache, meaningfulTitle, metaKey, saveMetaCache, type PageMeta } from "../lib/meta.ts";
import { exposeHint, phoneUrl } from "../lib/phone.ts";
import { qrSvg } from "../lib/qr.ts";
import { tunnelRequest, type TunnelReply } from "../lib/tunnels.ts";
import type { LanAddress, Listener, SettingsPane, Tunnel, TunnelProvider } from "../../../shared/protocol.ts";

type Mode = "loading" | "host" | "missing" | "fallback" | "error";
type CheckState = "free" | "used" | "pending" | "unknown";

interface Confirm {
  key: string;
  /** ask/pending/stuck: the Quit flow. info: what this is and why Quit is replaced. notice: a short message.
   *  phone: QR code for opening the port on a phone. share: the public-link panel. */
  phase: "ask" | "pending" | "stuck" | "error" | "info" | "notice" | "phone" | "share";
  message?: string;
}

/** "Quit N idle servers…" in the footer. */
interface Sweep {
  phase: "ask" | "pending" | "error";
  keys: string[];
  message?: string;
}

interface Check {
  port: number;
  state: CheckState;
  row?: PortRow;
}

type Item =
  | { kind: "header"; key: string; label: string }
  | { kind: "row"; key: string; row: PortRow; hidden: HiddenReason | null }
  | { kind: "more"; key: string; count: number };

const FALLBACK_RESCAN_MS = 8000;
const CACHE_KEY = "portlight.last";
const SETTINGS_CACHE_KEY = "portlight.settings.cache";
const OS = detectOs();

// One host process for as long as the popup is open, instead of one per request.
const host = new HostClient(portTransport());
const DEVICE = thisDevice();

const state = {
  mode: "loading" as Mode,
  rows: [] as PortRow[],
  stale: false,
  query: "",
  failure: null as HostFailure | null,
  error: "",
  recheckFailed: false,
  confirm: null as Confirm | null,
  scanning: false,
  check: null as Check | null,
  suggestion: null as number | null,
  showSkeleton: false,
  settings: loadSettingsCache(),
  /** Local tabs by port. */
  tabs: new Map<number, TabRef[]>(),
  /** "N hidden" was clicked: show hidden rows until the popup closes. */
  revealHidden: false,
  menu: null as { key: string; scrollTop: number } | null,
  /** Favicons and page titles by port:pid (lib/meta.ts). */
  meta: loadMetaCache(),
  /** LAN addresses for "Open on Phone"; loaded when that panel opens. */
  net: null as { hostname: string; addresses: LanAddress[] } | "loading" | "unsupported" | "error" | null,
  /** Share links, as the background worker reports them. */
  tunnels: [] as Tunnel[],
  /** Installed tunnel tools; null until the share panel asks. */
  providers: null as Record<TunnelProvider, boolean> | null,
  /** Ports whose share link is being created / the last error per port. */
  sharing: new Set<number>(),
  shareError: new Map<number, string>(),
  sweep: null as Sweep | null,
};

// ---------- DOM helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const input = $<HTMLInputElement>("q");
const list = $<HTMLUListElement>("rows");
const stateEl = $("state");
const bodyEl = $("body");
const menuEl = $("menu");

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  html = "",
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (html) el.innerHTML = html;
  return el;
}

function announce(text: string) {
  const a = $("announcer");
  a.textContent = "";
  requestAnimationFrame(() => (a.textContent = text));
}

function reducedMotion(): boolean {
  const m = state.settings.motion;
  return m === "reduced" || (m === "system" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

for (const el of document.querySelectorAll<HTMLElement>("[data-icon]")) {
  const name = el.dataset.icon as keyof typeof icon;
  el.innerHTML = icon[name](name === "search" ? 15 : 14);
}
$("clear").innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// ---------- settings ----------

function loadSettingsCache(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    return raw ? normalizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function applySettings(s: Settings, opts: { render?: boolean } = {}) {
  const prev = state.settings;
  state.settings = s;
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(s));
  } catch {
    /* first paint just uses defaults */
  }
  const root = document.documentElement;
  if (s.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  if (s.motion === "system") delete root.dataset.motion;
  else root.dataset.motion = s.motion;
  if (prev.refreshMs !== s.refreshMs) restartLoop();
  if (opts.render !== false) {
    render({ animate: true });
    pushBadge();
    if (prev.preferredPort !== s.preferredPort) void updateSuggestion();
  }
}

async function bootSettings() {
  try {
    applySettings(await loadSettings());
    onSettingsChanged((s) => applySettings(s));
  } catch {
    /* no chrome.storage (e.g. opened outside the extension): defaults */
  }
}

async function patchSettings(patch: Partial<Settings>) {
  // Apply right away so the row reacts under the pointer; storage confirms it a moment later.
  applySettings(normalizeSettings({ ...state.settings, ...patch }));
  try {
    await saveSettings(patch);
  } catch {
    /* storage unavailable: the change lasts until the popup closes */
  }
}

const EDITOR_LABEL: Record<Exclude<Editor, "none">, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
  webstorm: "WebStorm",
  sublime: "Sublime Text",
};

const REVEAL_LABEL = OS === "mac" ? "Reveal in Finder" : OS === "win" ? "Show in Explorer" : "Open Folder";

// ---------- clipboard / tabs ----------

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Swap a button's glyph to a checkmark for a moment. */
const restoreGlyph = new WeakMap<HTMLElement, string>();
function flashDone(btn: HTMLElement, glyphHost: HTMLElement = btn, size = 14) {
  if (!restoreGlyph.has(glyphHost)) restoreGlyph.set(glyphHost, glyphHost.innerHTML);
  btn.classList.add("done");
  glyphHost.innerHTML = icon.check(size);
  clearTimeout(Number(btn.dataset.doneTimer));
  btn.dataset.doneTimer = String(
    setTimeout(() => {
      btn.classList.remove("done");
      glyphHost.innerHTML = restoreGlyph.get(glyphHost) ?? icon.copy(size);
      restoreGlyph.delete(glyphHost);
    }, 1400),
  );
}

function tabsFor(port: number): TabRef[] {
  return state.tabs.get(port) ?? [];
}

/** Open a port: switch to the tab that already shows it, or open a new one. */
async function openPort(port: number) {
  const existing = bestTab(tabsFor(port));
  if (existing) {
    try {
      await focusTab(existing);
      return;
    } catch {
      /* tab vanished — open a fresh one */
    }
  }
  const url = urlFor(port);
  if (typeof chrome !== "undefined" && chrome.tabs?.create) void chrome.tabs.create({ url });
  else window.open(url, "_blank", "noopener");
}

async function copyUrl(row: PortRow, btn?: HTMLElement) {
  if (await copyText(urlFor(row.port))) {
    if (btn) flashDone(btn);
    announce(`Copied ${urlFor(row.port)}`);
  }
}

let tabsSeq = 0;
async function refreshTabs(rerender = true) {
  const seq = ++tabsSeq;
  const tabs = await localTabs();
  if (seq !== tabsSeq) return;
  const sig = (m: Map<number, TabRef[]>) =>
    [...m].map(([p, ts]) => `${p}:${ts.map((t) => `${t.id}/${t.title}`).join(",")}`).sort().join("|");
  const changed = sig(tabs) !== sig(state.tabs);
  state.tabs = tabs;
  if (changed && rerender) render({ animate: true });
}

// ---------- cache (instant first paint) ----------

function loadCache(): Listener[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, listeners } = JSON.parse(raw) as { at: number; listeners: Listener[] };
    return Date.now() - at < 10 * 60_000 && Array.isArray(listeners) ? listeners : null;
  } catch {
    return null;
  }
}

function saveCache(listeners: Listener[] | null) {
  try {
    if (listeners) localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), listeners }));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage unavailable — first paint is just slower */
  }
}

function setBadge(count: number | null) {
  try {
    void chrome.action?.setBadgeText({ text: count ? String(count > 99 ? "99+" : count) : "" });
    if (count) void chrome.action?.setBadgeBackgroundColor({ color: "#3A3A3C" });
  } catch {
    /* not running as an extension */
  }
}

function pushBadge() {
  if (state.mode === "host") setBadge(badgeCount(state.rows, state.settings));
}

// ---------- data ----------

let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  if (state.mode === "fallback") return Promise.resolve();
  inflight ??= (async () => {
    try {
      const [res] = await Promise.all([host.list(), refreshTabs(false)]);
      state.rows = shapeListeners(res.listeners);
      state.stale = false;
      state.mode = "host";
      followRestart();
      state.failure = null;
      saveCache(res.listeners);
      pushBadge();
    } catch (e) {
      if (e instanceof HostConnectionError && (e.kind === "missing" || e.kind === "forbidden")) {
        state.mode = "missing";
        state.failure = e.kind;
        state.rows = [];
        saveCache(null);
        setBadge(null);
      } else if (state.mode === "host" && !state.stale) {
        // A blip while live — keep the list, mark it stale, try again next tick.
        state.stale = true;
      } else {
        state.mode = "error";
        state.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      inflight = null;
    }
    render({ animate: true });
    void updateCheck();
    void updateSuggestion();
    scheduleMeta();
    void refreshTunnels();
  })();
  return inflight;
}

/**
 * A server restarted with --host comes back under a new pid (a new row key). Keep the
 * phone/share panel open on it, so the QR code appears the moment it is reachable.
 */
function followRestart() {
  const c = state.confirm;
  if (!c || (c.phase !== "phone" && c.phase !== "share") || state.rows.some((r) => r.key === c.key)) return;
  const port = Number(c.key.split(":")[0]);
  const next = state.rows.find((r) => r.port === port && r.source === "host");
  state.confirm = next ? { ...c, key: next.key } : null;
}

let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

function fallbackPorts(): number[] {
  // Common dev ports, the user's extra ports, and every port an open tab points at.
  const extra = state.settings.extraProbePorts.filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
  return [...new Set([...COMMON_DEV_PORTS, ...extra, ...state.tabs.keys()])].sort((a, b) => a - b);
}

async function scanFallback(first = false) {
  if (state.mode !== "fallback") return;
  state.scanning = true;
  if (first) render();
  await refreshTabs(false);
  const found: PortRow[] = first ? [] : state.rows.slice();
  const seen = new Set<number>();
  await probePorts(fallbackPorts(), {
    onOpen: (r) => {
      seen.add(r.port);
      const row = probeToRow(r);
      const i = found.findIndex((x) => x.port === r.port);
      if (i >= 0) found[i] = row;
      else found.push(row);
      if (first) {
        state.rows = found.slice().sort((a, b) => a.port - b.port);
        render({ animate: true });
      }
    },
  });
  if (state.mode !== "fallback") return;
  state.rows = found.filter((r) => seen.has(r.port)).sort((a, b) => a.port - b.port);
  state.scanning = false;
  render({ animate: true });
  scheduleMeta();
  void updateSuggestion();
  fallbackTimer = setTimeout(() => void scanFallback(), FALLBACK_RESCAN_MS);
}

function startFallback() {
  state.mode = "fallback";
  state.rows = [];
  state.confirm = null;
  void scanFallback(true);
  input.focus();
}

function leaveFallback() {
  clearTimeout(fallbackTimer);
  state.mode = "missing";
  state.rows = [];
  state.scanning = false;
  render();
}

// ---------- port check & suggestion ----------

function queryPort(): number | null {
  const q = state.query.trim();
  if (q.replace(/\D/g, "").length < 2) return null;
  return parsePort(q);
}

let checkSeq = 0;

async function updateCheck() {
  const port = queryPort();
  const seq = ++checkSeq;
  if (port == null || (state.mode !== "host" && state.mode !== "fallback")) {
    state.check = null;
    renderCheck();
    return;
  }
  const known = state.rows.find((r) => r.port === port);
  if (state.mode === "host") {
    // Answer instantly from the list we already have, then confirm with the host.
    state.check = { port, state: known ? "used" : "free", row: known };
    renderCheck();
    try {
      const res = await host.check([port]);
      if (seq !== checkSeq) return;
      const r = res.results.find((x) => x.port === port);
      if (!r) return;
      const row = r.listener ? (shapeListeners([r.listener])[0] ?? known) : undefined;
      state.check = { port, state: r.free ? "free" : "used", row };
      renderCheck();
    } catch {
      /* keep the instant answer */
    }
  } else {
    if (known) {
      state.check = { port, state: "used", row: known };
      renderCheck();
      return;
    }
    state.check = { port, state: "pending" };
    renderCheck();
    const r = await probePort(port);
    if (seq !== checkSeq) return;
    state.check = r.open ? { port, state: "used", row: probeToRow(r) } : { port, state: "unknown" };
    renderCheck();
  }
}

let suggestSeq = 0;

async function updateSuggestion() {
  const near = queryPort() ?? state.settings.preferredPort;
  const seq = ++suggestSeq;
  if (state.mode !== "host" && state.mode !== "fallback") {
    state.suggestion = null;
    renderFooter();
    return;
  }
  // If you typed a free port, the check card already offers it — suggest the next one instead.
  const typed = queryPort();
  const pick = (ports: number[]) => ports.find((p) => p !== typed) ?? null;
  state.suggestion = pick(suggestFreePorts(state.rows.map((r) => r.port), near, 2));
  renderFooter();
  if (state.mode !== "host") return;
  try {
    const res = await host.suggest(near, 2);
    if (seq !== suggestSeq) return;
    const p = pick(res.ports);
    if (p != null) state.suggestion = p;
    renderFooter();
  } catch {
    /* local suggestion stands */
  }
}

// ---------- row actions ----------

function rowByKey(key: string): PortRow | undefined {
  return state.rows.find((r) => r.key === key) ?? stoppedRows().find((r) => r.key === key);
}

function hostErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof HostRequestError && e.code === "not_permitted") return "Not permitted — it belongs to another user.";
  if (e instanceof HostRequestError && e.code === "not_found") return "That process has already exited.";
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

async function kill(key: string, signal: "TERM" | "KILL") {
  const row = rowByKey(key);
  if (!row?.pid) return;
  state.confirm = { key, phase: "pending" };
  render();
  try {
    await host.kill(row.pid, signal);
    const deadline = Date.now() + (signal === "KILL" ? 3000 : 2500);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 350));
      await refresh();
      if (!rowByKey(key)) break;
    }
    if (rowByKey(key)) {
      state.confirm = { key, phase: "stuck" };
    } else {
      // Something (launchd, brew services, a process manager) may have started it straight back up.
      const back = state.rows.find((r) => r.port === row.port && r.process === row.process && r.key !== key);
      state.confirm = back
        ? { key: back.key, phase: "info", message: `${row.process ?? "It"} started again right away — something keeps restarting it.` }
        : null;
      announce(back ? `${row.process ?? "The process"} restarted on port ${row.port}` : `Quit ${row.process ?? "process"} on port ${row.port}`);
    }
  } catch (e) {
    state.confirm = { key, phase: "error", message: hostErrorMessage(e, "Couldn’t quit the process.") };
  }
  render();
}

function askKill(key: string) {
  const row = rowByKey(key);
  if (!row || state.mode !== "host") return;
  if (row.known?.noQuit) {
    showInfo(key);
    return;
  }
  if (!row.pid) return;
  state.confirm = { key, phase: "ask" };
  render();
}

function showInfo(key: string) {
  state.confirm = state.confirm?.key === key && state.confirm.phase === "info" ? null : { key, phase: "info" };
  render();
}

function cancelConfirm(refocus = true) {
  const key = state.confirm?.key;
  state.confirm = null;
  render();
  if (refocus && key) rowEls.get(key)?.querySelector<HTMLElement>(".row-main")?.focus();
}

async function hostAction(key: string, what: "reveal" | "editor") {
  const row = rowByKey(key);
  if (!row?.pid) return;
  const editor = state.settings.editor;
  const label = what === "reveal" ? REVEAL_LABEL : `Open in ${editor === "none" ? "editor" : EDITOR_LABEL[editor]}`;
  try {
    const res = what === "reveal" ? await host.reveal(row.pid) : await host.openEditor(row.pid, editor);
    announce(`${what === "reveal" ? "Revealed" : "Opened"} ${res.path}`);
  } catch (e) {
    state.confirm = {
      key,
      phase: "notice",
      message: isUnsupported(e)
        ? `${label} needs a newer helper. Run ${installText()} again to update it.`
        : hostErrorMessage(e, `${label} didn’t work.`),
    };
    render();
  }
}

// ---------- favicons & titles ----------

const metaInflight = new Set<string>();
const metaQueue: { key: string; port: number }[] = [];
let metaActive = 0;
let metaSaveTimer: ReturnType<typeof setTimeout> | undefined;

/** Rows worth asking for an icon and title: web servers you run, not databases or the OS. */
function wantsMeta(r: PortRow): boolean {
  return (r.source === "host" || r.source === "http") && r.group === "dev" && !r.container && !r.known;
}

function metaFor(r: PortRow): PageMeta | undefined {
  return state.meta.get(metaKey(r.port, r.pid));
}

/** Fetch what's missing, three at a time, after the list has painted. */
function scheduleMeta() {
  for (const r of state.rows) {
    if (!wantsMeta(r)) continue;
    const key = metaKey(r.port, r.pid);
    if (state.meta.has(key) || metaInflight.has(key)) continue;
    metaInflight.add(key);
    metaQueue.push({ key, port: r.port });
  }
  while (metaActive < 3 && metaQueue.length) {
    const job = metaQueue.shift()!;
    metaActive++;
    void fetchPageMeta(job.port)
      .then((m) => {
        state.meta.set(job.key, m);
        if (m.icon || m.title) render();
        clearTimeout(metaSaveTimer);
        metaSaveTimer = setTimeout(() => saveMetaCache(state.meta), 400);
      })
      .finally(() => {
        metaActive--;
        scheduleMeta();
      });
  }
}

/** The page title, when it says more than the name the row already shows. */
function pageTitle(r: PortRow, name: string): string | null {
  if (r.source === "tab") return null;
  return meaningfulTitle(metaFor(r)?.title ?? r.title, name, r.project, r.tool, r.known?.tool);
}

// ---------- phone & share ----------

const DB_IMAGE = /(^|\/)(postgres|postgis|mysql|mariadb|redis|valkey|mongo|memcached|elasticsearch|opensearch|rabbitmq|kafka|zookeeper|clickhouse|cassandra|neo4j|nats)\b/i;

/** Rows that can be opened from a phone or shared: web-ish things you run, not databases or the OS. */
function canShare(r: PortRow): boolean {
  if (state.mode !== "host" || r.source !== "host") return false;
  if (r.container) return !DB_IMAGE.test(r.container.image);
  return (r.group === "dev" || r.group === "app") && !r.known?.noQuit;
}

async function loadNet() {
  state.net = "loading";
  render();
  try {
    const res = await host.netinfo();
    state.net = { hostname: res.hostname, addresses: res.addresses };
  } catch (e) {
    state.net = isUnsupported(e) ? "unsupported" : "error";
  }
  render();
}

function openPhone(key: string) {
  state.confirm = { key, phase: "phone" };
  render();
  void loadNet();
}

function applyTunnelReply(r: TunnelReply, port?: number) {
  if (r.ok) {
    state.tunnels = r.tunnels;
    if (r.providers) state.providers = r.providers;
    if (port != null) state.shareError.delete(port);
  } else if (port != null) {
    state.shareError.set(
      port,
      r.code === "unsupported" ? `Sharing needs a newer helper. Run ${installText()} again to update it.` : r.message,
    );
  }
}

let tunnelSeq = 0;
/** Cheap: the worker answers from memory and never starts a helper for this. */
async function refreshTunnels() {
  if (state.mode !== "host") return;
  const seq = ++tunnelSeq;
  const r = await tunnelRequest({ op: "status" });
  if (seq !== tunnelSeq || !r.ok) return;
  const sig = () => state.tunnels.map((t) => `${t.port}:${t.state}:${t.url}`).join();
  const before = sig();
  applyTunnelReply(r);
  if (before !== sig()) render();
}

/** The running share link on `port` (it has a URL). */
function tunnelFor(port: number): (Tunnel & { url: string }) | undefined {
  return state.tunnels.find((t): t is Tunnel & { url: string } => t.port === port && t.state === "running" && !!t.url);
}

/** A link is being created on `port`: by this popup, or one that was open before it (the worker owns it). */
function shareStarting(port: number): boolean {
  return state.sharing.has(port) || state.tunnels.some((t) => t.port === port && t.state === "starting");
}

async function openShare(key: string) {
  const r = rowByKey(key);
  if (!r) return;
  state.shareError.delete(r.port);
  state.confirm = { key, phase: "share" };
  render();
  applyTunnelReply(await tunnelRequest({ op: "providers" }), r.port);
  render();
}

async function startShare(key: string) {
  const r = rowByKey(key);
  if (!r || state.sharing.has(r.port)) return;
  state.sharing.add(r.port);
  state.shareError.delete(r.port);
  render();
  const reply = await tunnelRequest({ op: "start", port: r.port });
  // Cancelled while it was starting: the failure is expected, not news.
  const cancelled = !state.sharing.has(r.port);
  state.sharing.delete(r.port);
  if (cancelled) {
    // The worker makes sure nothing is left running; show what it now reports.
    await refreshTunnels();
    return;
  }
  applyTunnelReply(reply, r.port);
  const t = tunnelFor(r.port);
  if (t) announce(`Public link ready: ${t.url}`);
  render();
}

async function stopShare(port: number) {
  const wasRunning = !!tunnelFor(port);
  state.sharing.delete(port);
  applyTunnelReply(await tunnelRequest({ op: "stop", port }), port);
  announce(wasRunning ? `Stopped sharing port ${port}` : "Cancelled");
  if (state.confirm?.phase === "share" && !state.shareError.has(port)) cancelConfirm();
  else render();
}

async function openPane(pane: SettingsPane, key?: string) {
  try {
    await host.openSettings(pane);
  } catch (e) {
    const message = isUnsupported(e)
      ? `This shortcut needs a newer helper. Run ${installText()} again to update it.`
      : hostErrorMessage(e, "Couldn’t open System Settings.");
    if (key) {
      state.confirm = { key, phase: "notice", message };
      render();
    } else announce(message);
  }
}

// ---------- idle cleanup ----------

/** Idle dev servers you could quit in one go: visible, yours, not containers or OS services. */
function idleRows(): PortRow[] {
  if (state.mode !== "host") return [];
  const seen = new Set<number>();
  return state.rows.filter((r) => {
    const ok =
      !!r.pid &&
      r.source === "host" &&
      !r.container &&
      !r.known?.noQuit &&
      !hiddenReason(r, state.settings) &&
      !state.tunnels.some((t) => t.port === r.port) &&
      isIdle(r, tabsFor(r.port).length, state.settings.idleAfterHours);
    // One entry per process (a server on two ports is quit once).
    if (!ok || seen.has(r.pid!)) return false;
    seen.add(r.pid!);
    return true;
  });
}

function openSweep() {
  const rows = idleRows();
  if (!rows.length) return;
  closeMenu(false);
  state.confirm = null;
  state.sweep = { phase: "ask", keys: rows.map((r) => r.key) };
  render();
}

function closeSweep() {
  state.sweep = null;
  render();
  $("idle").focus({ preventScroll: true });
}

async function runSweep() {
  const sw = state.sweep;
  if (!sw || sw.phase === "pending") return;
  const rows = sw.keys.map((k) => rowByKey(k)).filter((r): r is PortRow => !!r?.pid);
  state.sweep = { ...sw, phase: "pending" };
  render();
  const failed: string[] = [];
  await Promise.all(
    rows.map(async (r) => {
      try {
        await host.kill(r.pid!, "TERM", true);
      } catch (e) {
        // Already gone counts as done.
        if (!(e instanceof HostRequestError && e.code === "not_found")) failed.push(`${r.port}: ${hostErrorMessage(e, "couldn’t quit")}`);
      }
    }),
  );
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && rows.some((r) => rowByKey(r.key))) {
    await new Promise((res) => setTimeout(res, 350));
    await refresh();
  }
  const still = rows.filter((r) => rowByKey(r.key));
  if (failed.length || still.length) {
    const lines = failed.length ? failed : still.map((r) => `${r.port} is still running.`);
    state.sweep = { phase: "error", keys: still.map((r) => r.key), message: lines.join(" ") };
  } else {
    state.sweep = null;
    announce(`Quit ${plural(rows.length, "idle server")}`);
    input.focus({ preventScroll: true });
  }
  render();
}

// ---------- rendering ----------

const rowEls = new Map<string, HTMLLIElement>();
const auxEls = new Map<string, HTMLLIElement>();

function displayName(r: PortRow): { name: string; unknown: boolean } {
  if (r.source === "tab") return { name: r.title || `localhost:${r.port}`, unknown: false };
  // No project folder: the page's own title names it better than "node".
  const title = r.source === "host" && !r.project ? meaningfulTitle(metaFor(r)?.title, r.tool, r.process) : null;
  const name = r.container?.name ?? r.known?.name ?? r.project ?? title ?? r.title ?? r.tool ?? r.process;
  if (name) return { name, unknown: false };
  return { name: r.source === "http" ? "Web server" : "Unknown process", unknown: true };
}

function toolLabel(r: PortRow, name: string): string {
  if (r.container) return r.container.image;
  const t = r.known?.tool ?? r.tool;
  return t && t !== name ? t : "";
}

/** Tabs open on ports with nothing listening — the server behind them has stopped. */
function stoppedRows(): PortRow[] {
  if (state.mode !== "host") return [];
  const busy = new Set(state.rows.map((r) => r.port));
  const out: PortRow[] = [];
  for (const [port, tabs] of state.tabs) {
    if (busy.has(port)) continue;
    out.push({
      key: `${port}:tab`,
      port,
      pid: null,
      process: null,
      tool: null,
      project: null,
      cwd: null,
      command: null,
      user: null,
      addresses: [],
      scope: "local",
      startedAt: null,
      source: "tab",
      title: bestTab(tabs)?.title ?? null,
      container: null,
      group: "dev",
      known: null,
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

function createRow(r: PortRow): HTMLLIElement {
  const li = h("li", { class: "row", "data-key": r.key });
  li.innerHTML = `
    <button class="row-main" type="button">
      <span class="port"></span>
      <span class="meta">
        <span class="line1"><img class="favicon" alt="" hidden /><span class="name"></span><span class="tool"></span></span>
        <span class="line2"></span>
      </span>
      <span class="trail"><span class="uptime"></span></span>
    </button>
    <div class="actions">
      <button class="icon-btn" type="button" data-act="open">${icon.open(15)}</button>
      <button class="icon-btn" type="button" data-act="copy">${icon.copy(15)}</button>
      <button class="icon-btn" type="button" data-act="menu" aria-haspopup="menu">${icon.more(15)}</button>
      <button class="icon-btn danger" type="button" data-act="kill">${icon.stop(15)}</button>
      <button class="icon-btn" type="button" data-act="info">${icon.info(15)}</button>
      <button class="icon-btn" type="button" data-act="close-tabs">${icon.xmark(15)}</button>
    </div>
    <div class="confirm"><div class="confirm-inner"><div class="confirm-content"></div></div></div>`;
  return li;
}

function setHtml(el: HTMLElement, html: string) {
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

function updateRow(li: HTMLLIElement, r: PortRow, hidden: HiddenReason | null) {
  const { name, unknown } = displayName(r);
  const tool = toolLabel(r, name);
  const uptime = formatUptime(r.startedAt);
  const tabs = tabsFor(r.port);
  const idle = isIdle(r, tabs.length, state.settings.idleAfterHours);
  const main = li.querySelector<HTMLButtonElement>(".row-main")!;
  const set = (sel: string, text: string) => {
    const el = li.querySelector<HTMLElement>(sel)!;
    if (el.textContent !== text) el.textContent = text;
  };
  set(".port", String(r.port));
  set(".name", name);
  li.querySelector(".name")!.classList.toggle("unknown", unknown);
  set(".tool", tool);
  set(".uptime", uptime ?? "");
  li.classList.toggle("is-hidden", !!hidden);
  li.classList.toggle("stopped", r.source === "tab");
  li.classList.toggle("linked", tabs.length > 0 && r.source !== "tab");
  const fav = li.querySelector<HTMLImageElement>(".favicon")!;
  const iconUrl = r.source !== "tab" ? (metaFor(r)?.icon ?? null) : null;
  if (iconUrl) {
    if (fav.getAttribute("src") !== iconUrl) fav.src = iconUrl;
    fav.hidden = false;
  } else if (!fav.hidden) {
    fav.hidden = true;
    fav.removeAttribute("src");
  }
  const title = pageTitle(r, name);
  const shared = r.source === "host" ? tunnelFor(r.port) : undefined;

  const tabWord = plural(tabs.length, "tab");
  const tabsHtml =
    tabs.length && r.source !== "tab"
      ? `<span class="sep">·</span><span class="tabs" title="Open in ${tabWord} — click to switch">${icon.tab(12)}${tabWord}</span>`
      : "";
  const idleHtml = idle
    ? `<span class="sep">·</span><span class="idle" title="Running ${esc(describeUptime(r.startedAt)?.replace(/^Running for /, "") ?? "")} with no tab open">Idle</span>`
    : "";
  // A public link is the loudest kind of exposure, so it is always on the row while it runs.
  const sharedHtml = shared
    ? `<span class="shared" title="Public link: ${esc(shared.url)}">${icon.link(12)}Public</span><span class="sep">·</span>`
    : "";

  let line2: string;
  if (r.source === "tab") {
    line2 = `<span class="gone-label">Server stopped</span><span class="sep">·</span><span class="proc">${tabWord}</span>`;
  } else if (r.source === "http") {
    line2 = `<span class="proc">Answered HTTP${r.status ? ` ${r.status}` : ""}</span>${tabsHtml}`;
  } else if (title && !r.container) {
    // The page title says more than "node"; the process stays in the tooltip and label.
    line2 =
      sharedHtml +
      (r.scope === "network"
        ? `<span class="scope network">${icon.network(12)}Network</span><span class="sep">·</span>`
        : `<span class="scope local" title="Only reachable from ${DEVICE}">${icon.lock(12)}</span>`) +
      `<span class="proc page-title" title="${esc(title)}">${esc(title)}</span>` +
      tabsHtml +
      idleHtml;
  } else {
    let proc: string;
    if (r.container) {
      const c = r.container;
      proc = [c.project, c.containerPort && c.containerPort !== r.port ? `container port ${c.containerPort}` : "container"]
        .filter(Boolean)
        .join(" · ");
    } else {
      proc = r.process && r.process !== name ? r.process : r.pid ? `PID ${r.pid}` : "";
    }
    // Local is the norm, so it gets a quiet glyph; exposure is the exception and gets a word.
    line2 =
      sharedHtml +
      (r.scope === "network"
        ? `<span class="scope network">${icon.network(12)}Network</span>${proc ? `<span class="sep">·</span><span class="proc">${esc(proc)}</span>` : ""}`
        : `<span class="scope local" title="Only reachable from ${DEVICE}">${icon.lock(12)}</span>${proc ? `<span class="proc">${esc(proc)}</span>` : ""}`) +
      tabsHtml +
      idleHtml;
  }
  setHtml(li.querySelector<HTMLElement>(".line2")!, line2);

  if (r.source === "tab") {
    main.setAttribute("aria-label", `Port ${r.port}, ${name}. Server stopped, ${tabWord} still open. Switch to tab.`);
    main.title = tabs.map((t) => t.url).join("\n");
  } else {
    const details = [
      `Port ${r.port}`,
      name,
      tool,
      title ?? "",
      shared ? "shared with a public link" : "",
      r.process && r.process !== name && !r.container ? r.process : "",
      r.pid ? `PID ${r.pid}` : "",
      describeScope(r, DEVICE),
      describeUptime(r.startedAt) ?? "",
      tabs.length ? `open in ${tabWord}` : "",
      idle ? "idle" : "",
      hidden ? "hidden" : "",
    ].filter(Boolean);
    main.setAttribute("aria-label", `${details.join(", ")}. ${tabs.length ? "Switch to tab." : "Open in a new tab."}`);
    main.title = [r.container?.workingDir, r.command, r.cwd, describeScope(r, DEVICE)].filter(Boolean).join("\n") || urlFor(r.port);
  }

  const btn = (act: string) => li.querySelector<HTMLElement>(`[data-act="${act}"]`)!;
  const isTab = r.source === "tab";
  const canQuit = r.source === "host" && !!r.pid && state.mode === "host" && !r.known?.noQuit;
  const openBtn = btn("open");
  openBtn.hidden = !isTab;
  openBtn.setAttribute("aria-label", `Switch to the tab on port ${r.port}`);
  openBtn.title = "Switch to tab  ↩";
  const copyBtn = btn("copy");
  copyBtn.hidden = isTab;
  copyBtn.setAttribute("aria-label", `Copy ${urlFor(r.port)}`);
  copyBtn.title = "Copy URL  ⌘C";
  const menuBtn = btn("menu");
  menuBtn.hidden = isTab;
  menuBtn.setAttribute("aria-label", `More actions for port ${r.port}`);
  menuBtn.setAttribute("aria-expanded", String(state.menu?.key === r.key));
  menuBtn.title = "More";
  const killBtn = btn("kill");
  killBtn.hidden = !canQuit;
  killBtn.setAttribute("aria-label", `Quit ${r.process ?? "process"} on port ${r.port}`);
  killBtn.title = "Quit process  ⌘⌫";
  const infoBtn = btn("info");
  infoBtn.hidden = !(r.known?.noQuit && r.source === "host");
  infoBtn.setAttribute("aria-label", `About ${name}`);
  infoBtn.title = "Why can’t I quit this?";
  const closeBtn = btn("close-tabs");
  closeBtn.hidden = !isTab;
  closeBtn.setAttribute("aria-label", `Close ${tabWord} on port ${r.port}`);
  closeBtn.title = tabs.length > 1 ? `Close ${tabWord}` : "Close tab";

  renderConfirm(li, r);
}

function commandHtml(cmd: string): string {
  return `<div class="cmd-line"><code>${esc(cmd)}</code><button class="icon-btn" type="button" data-act="copy-cmd" data-cmd="${esc(cmd)}" aria-label="Copy ${esc(cmd)}" title="Copy command">${icon.copy(14)}</button></div>`;
}

const PANE_LABEL: Record<SettingsPane, string> = {
  "airdrop-handoff": "Open AirDrop & Handoff Settings",
  sharing: "Open Sharing Settings",
};

function paneButton(k: PortRow["known"]): string {
  if (!k?.pane || OS !== "mac" || state.mode !== "host") return "";
  return `<button class="btn" type="button" data-act="open-pane" data-pane="${k.pane}">${esc(PANE_LABEL[k.pane])}</button>`;
}

function urlLineHtml(url: string): string {
  return `<div class="cmd-line url-line"><code>${esc(url)}</code>
    <button class="icon-btn" type="button" data-act="copy-cmd" data-cmd="${esc(url)}" aria-label="Copy ${esc(url)}" title="Copy link">${icon.copy(14)}</button>
    <button class="icon-btn" type="button" data-act="open-url" data-url="${esc(url)}" aria-label="Open ${esc(url)}" title="Open in a new tab">${icon.open(14)}</button></div>`;
}

const doneRow = `<div class="confirm-row end"><button class="btn" type="button" data-act="cancel">Done</button></div>`;

function phoneHtml(r: PortRow, name: string): string {
  const net = state.net;
  if (net === null || net === "loading") return `<div class="confirm-row"><span class="confirm-text">Finding ${DEVICE === "this Mac" ? "this Mac’s" : "this computer’s"} network address…</span></div>`;
  if (net === "unsupported" || net === "error") {
    const msg = net === "unsupported" ? `Open on Phone needs a newer helper. Run ${installText()} again to update it.` : "Couldn’t read this computer’s network addresses.";
    return `<div class="confirm-row"><span class="confirm-text">${esc(msg)}</span><button class="btn" type="button" data-act="cancel">OK</button></div>`;
  }
  if (r.scope === "local") {
    const hint = exposeHint(r);
    const how = hint
      ? `Start ${esc(hint.tool)} with this flag so it listens on your network too:`
      : "Start it listening on 0.0.0.0 (all interfaces) instead of localhost.";
    return `<div class="explain"><p class="explain-lead">Only ${esc(DEVICE)} can open ${esc(name)}.</p>
      <p>It listens on localhost, so a phone can’t reach it. ${how}</p>${hint ? commandHtml(hint.flag) : ""}</div>${doneRow}`;
  }
  const url = phoneUrl(r, net.addresses);
  if (!url) {
    return `<div class="confirm-row"><span class="confirm-text">${esc(DEVICE === "this Mac" ? "This Mac" : "This computer")} isn’t on a network right now.</span><button class="btn" type="button" data-act="cancel">OK</button></div>`;
  }
  return `<div class="phone">
      <div class="qr-frame">${qrSvg(url, { size: 104, label: `QR code for ${url}` })}</div>
      <div class="phone-copy">
        <p class="explain-lead">Scan with your phone’s camera</p>
        <p>It needs to be on the same Wi‑Fi. Anyone on this network can open it too.</p>
      </div>
    </div>${urlLineHtml(url)}${doneRow}`;
}

const INSTALL_TUNNEL: Record<string, string> = {
  mac: "brew install cloudflared",
  win: "winget install --id Cloudflare.cloudflared",
};

function shareHtml(r: PortRow): string {
  const port = r.port;
  const t = tunnelFor(port);
  const err = state.shareError.get(port);
  const browser = "Chrome";
  if (t) {
    return `<div class="explain"><p class="explain-lead">Public link <span class="muted">· ${esc(t.provider)}</span></p>${urlLineHtml(t.url)}
      <p>Anyone with the link can open this server. Sharing stops when you stop it, when the server quits, or when ${browser} closes.</p></div>
      <div class="confirm-row end"><button class="btn" type="button" data-act="stop-share">Stop Sharing</button><button class="btn" type="button" data-act="cancel">Done</button></div>`;
  }
  if (shareStarting(port)) {
    return `<div class="confirm-row"><span class="confirm-text">Creating a public link… This takes a few seconds.</span><button class="btn" type="button" data-act="stop-share">Cancel</button></div>`;
  }
  if (err) {
    return `<div class="confirm-row"><span class="confirm-text error">${esc(err)}</span><button class="btn" type="button" data-act="cancel">OK</button></div>`;
  }
  const p = state.providers;
  if (!p) return `<div class="confirm-row"><span class="confirm-text">Checking for cloudflared…</span></div>`;
  if (!p.cloudflared && !p.ngrok) {
    const cmd = INSTALL_TUNNEL[OS];
    return `<div class="explain"><p class="explain-lead">Share a public link with cloudflared</p>
      <p>It’s free and needs no account. ${cmd ? "Install it once, then come back:" : "Install it from Cloudflare’s downloads page (developers.cloudflare.com), then come back."}</p>
      ${cmd ? commandHtml(cmd) : ""}</div>${doneRow}`;
  }
  const tool = p.cloudflared ? "cloudflared" : "ngrok";
  return `<div class="explain"><p class="explain-lead">Anyone with the link can open this server.</p>
      <p>Portlight starts a ${tool} tunnel to localhost:${port} and gives you a public https link. Share it only with people you trust.</p></div>
      <div class="confirm-row end"><button class="btn" type="button" data-act="cancel">Cancel</button><button class="btn primary" type="button" data-act="start-share">Create Link</button></div>`;
}

function renderConfirm(li: HTMLLIElement, r: PortRow) {
  const c = state.confirm?.key === r.key ? state.confirm : null;
  li.classList.toggle("confirming", !!c);
  const box = li.querySelector<HTMLElement>(".confirm-content")!;
  // Phone and share panels change with live data (network, tunnel state), so their content is the signature.
  const live = c?.phase === "phone" ? phoneHtml(r, displayName(r).name) : c?.phase === "share" ? shareHtml(r) : "";
  const sig = c ? `${c.phase}|${c.message ?? ""}|${live}` : "";
  if (box.dataset.sig === sig) return;
  const prevPhase = box.dataset.sig?.split("|")[0];
  box.dataset.sig = sig;
  if (!c) {
    // Leave content in place while the panel collapses; clear afterwards.
    setTimeout(() => {
      if (!box.dataset.sig) box.innerHTML = "";
    }, 450);
    return;
  }
  const proc = esc(r.process ?? "this process");
  const k = r.known;
  // Homebrew services and the like: Quit works, but it's worth knowing it may come back.
  const note = k && !k.noQuit ? `<div class="confirm-note">${esc(k.about)}${k.command ? commandHtml(k.command) : ""}</div>` : "";
  let html = "";
  const stacked = c.phase === "info" || c.phase === "phone" || c.phase === "share";
  box.classList.toggle("stack", stacked || ((c.phase === "ask" || c.phase === "stuck") && !!note));
  box.classList.toggle("wide", live.includes('class="phone"'));
  if (c.phase === "ask") {
    html = `${note}<div class="confirm-row"><span class="confirm-text">Quit <strong>${proc}</strong>?</span>
      <button class="btn" type="button" data-act="cancel">Cancel</button>
      <button class="btn destructive" type="button" data-act="quit">Quit</button></div>`;
  } else if (c.phase === "pending") {
    html = `<div class="confirm-row"><span class="confirm-text">Quitting <strong>${proc}</strong>…</span></div>`;
  } else if (c.phase === "stuck") {
    html = `${note}<div class="confirm-row"><span class="confirm-text"><strong>${proc}</strong> is still running.</span>
      <button class="btn" type="button" data-act="cancel">Cancel</button>
      <button class="btn destructive" type="button" data-act="force">Force Quit</button></div>`;
  } else if (c.phase === "info") {
    const lead = c.message ? `<p class="explain-lead">${esc(c.message)}</p>` : "";
    const about = k ? `<p>${esc(k.about)}</p>` : "";
    const fix = k?.fix ? `<p class="explain-fix">${esc(k.fix)}</p>` : "";
    html = `<div class="explain">${lead}${about}${fix}${k?.command ? commandHtml(k.command) : ""}</div>
      <div class="confirm-row end">${paneButton(k)}<button class="btn" type="button" data-act="cancel">Done</button></div>`;
  } else if (c.phase === "phone" || c.phase === "share") {
    html = live;
  } else if (c.phase === "notice") {
    html = `<div class="confirm-row"><span class="confirm-text">${esc(c.message ?? "")}</span>
      <button class="btn" type="button" data-act="cancel">OK</button></div>`;
  } else {
    html = `<div class="confirm-row"><span class="confirm-text error">${esc(c.message ?? "Couldn’t quit the process.")}</span>
      <button class="btn" type="button" data-act="cancel">OK</button></div>`;
  }
  // Live panels re-render in place; keep focus where it was unless the panel just opened.
  const hadFocus = box.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.act : undefined;
  box.innerHTML = html;
  // Taller panels can open below the fold: bring the whole row into view once it has grown.
  if (c.phase === "phone" || c.phase === "share" || c.phase === "info") {
    setTimeout(() => {
      if (box.dataset.sig?.startsWith(c.phase)) li.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    }, reducedMotion() ? 0 : 320);
  }
  if ((c.phase === "phone" || c.phase === "share") && prevPhase === c.phase) {
    const again = hadFocus ? box.querySelector<HTMLElement>(`[data-act="${hadFocus}"]`) : null;
    if (again) {
      again.focus({ preventScroll: true });
      return;
    }
    // Only pull focus into the panel when it hasn't gone somewhere else meanwhile.
    const a = document.activeElement;
    if (a && a !== document.body && !li.contains(a)) return;
  }
  const focusTarget = box.querySelector<HTMLElement>('[data-act="quit"], [data-act="force"], [data-act="start-share"], [data-act="cancel"], [data-act="stop-share"]');
  // Skip if the panel was dismissed before the frame (e.g. a quick Escape).
  if (focusTarget) requestAnimationFrame(() => box.dataset.sig === sig && focusTarget.focus({ preventScroll: true }));
  if (c.phase === "pending") li.querySelector<HTMLElement>(".row-main")?.focus({ preventScroll: true });
}

function nextRowMain(el: HTMLElement): HTMLElement | null {
  for (const dir of ["nextElementSibling", "previousElementSibling"] as const) {
    let n = el[dir] as HTMLElement | null;
    while (n && !(n.matches("li.row") && !n.classList.contains("leaving"))) n = n[dir] as HTMLElement | null;
    const main = n?.querySelector<HTMLElement>(".row-main");
    if (main) return main;
  }
  return null;
}

function removeEl(el: HTMLLIElement, animate: boolean) {
  if (el.contains(document.activeElement)) (nextRowMain(el) ?? input).focus({ preventScroll: true });
  if (!animate || reducedMotion()) {
    el.remove();
    return;
  }
  el.classList.add("leaving");
  el.style.height = `${el.offsetHeight}px`;
  el.style.overflow = "hidden";
  el.style.transition = "opacity 180ms ease, transform 260ms var(--ease-out), height 280ms var(--ease-out) 80ms";
  requestAnimationFrame(() => (el.style.height = "0px"));
  setTimeout(() => el.remove(), 420);
}

let firstPaint = true;

function createAux(item: Exclude<Item, { kind: "row" }>): HTMLLIElement {
  if (item.kind === "header") return h("li", { class: "section-label", role: "presentation", "data-key": item.key });
  const li = h("li", { class: "more", role: "presentation", "data-key": item.key });
  li.innerHTML = `<button class="more-btn" type="button" data-act="toggle-hidden"></button>`;
  return li;
}

function updateAux(li: HTMLLIElement, item: Exclude<Item, { kind: "row" }>) {
  if (item.kind === "header") {
    if (li.textContent !== item.label) li.textContent = item.label;
    return;
  }
  const btn = li.querySelector<HTMLButtonElement>(".more-btn")!;
  const html = state.revealHidden
    ? `<span class="more-count">${item.count} hidden</span><span class="more-act">Hide</span>`
    : `<span class="more-count">${item.count} hidden</span><span class="more-act">Show</span>`;
  setHtml(btn, html);
  btn.setAttribute("aria-expanded", String(state.revealHidden));
  btn.setAttribute("aria-label", state.revealHidden ? `Hide ${plural(item.count, "hidden port")} again` : `Show ${plural(item.count, "hidden port")}`);
}

function renderList(items: Item[], animate: boolean) {
  const keepRows = new Set(items.filter((i) => i.kind === "row").map((i) => i.key));
  const keepAux = new Set(items.filter((i) => i.kind !== "row").map((i) => i.key));
  for (const [key, el] of rowEls) {
    if (!keepRows.has(key)) {
      rowEls.delete(key);
      removeEl(el, animate);
    }
  }
  for (const [key, el] of auxEls) {
    if (!keepAux.has(key)) {
      auxEls.delete(key);
      el.remove();
    }
  }
  let prev: HTMLLIElement | null = null;
  for (const item of items) {
    let el: HTMLLIElement | undefined;
    if (item.kind === "row") {
      el = rowEls.get(item.key);
      if (!el) {
        el = createRow(item.row);
        rowEls.set(item.key, el);
        if (animate && !firstPaint && !reducedMotion()) {
          el.classList.add("entering");
          const node = el;
          requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("entering")));
        }
      }
      updateRow(el, item.row, item.hidden);
    } else {
      el = auxEls.get(item.key);
      if (!el) {
        el = createAux(item);
        auxEls.set(item.key, el);
      }
      updateAux(el, item);
    }
    // Skip over rows that are animating out so new items don't jump around them.
    let anchor: ChildNode | null = prev ? prev.nextSibling : list.firstChild;
    while (anchor && anchor !== el && (anchor as HTMLElement).classList?.contains("leaving")) anchor = anchor.nextSibling;
    if (anchor !== el) list.insertBefore(el, anchor);
    prev = el;
  }
  if (keepRows.size) firstPaint = false;
}

/** The rows the list shows right now, with group headers and the "N hidden" affordance. */
function buildItems(): { items: Item[]; visible: number } {
  if (state.mode !== "host" && state.mode !== "fallback") return { items: [], visible: 0 };
  const s = state.settings;
  const searching = !!state.query.trim();
  const candidates = filterRows([...state.rows, ...stoppedRows()], state.query).map((row) => ({
    row,
    hidden: row.source === "tab" ? null : hiddenReason(row, s),
  }));
  const hiddenCount = candidates.filter((c) => c.hidden).length;
  // Searching is explicit, so it finds hidden ports too; otherwise they wait behind "N hidden".
  const shown = searching || state.revealHidden ? candidates : candidates.filter((c) => !c.hidden);

  const bucket = (r: PortRow) => (r.source === "tab" ? "stopped" : r.group);
  const order = [...GROUP_ORDER, "stopped"] as const;
  const groups = new Set(shown.map((c) => bucket(c.row)));
  const items: Item[] = [];
  const pushRow = (c: (typeof shown)[number]) => items.push({ kind: "row", key: c.row.key, row: c.row, hidden: c.hidden });
  if (s.groupRows && groups.size > 1) {
    for (const g of order) {
      const members = shown.filter((c) => bucket(c.row) === g);
      if (!members.length) continue;
      items.push({ kind: "header", key: `h:${g}`, label: g === "stopped" ? "Tabs Without a Server" : GROUP_LABEL[g] });
      members.forEach(pushRow);
    }
  } else {
    // Ungrouped: live servers by port, tabs whose server stopped at the end.
    shown.filter((c) => c.row.source !== "tab").forEach(pushRow);
    shown.filter((c) => c.row.source === "tab").forEach(pushRow);
  }
  if (!searching && hiddenCount) items.push({ kind: "more", key: "more", count: hiddenCount });
  return { items, visible: shown.length };
}

function skeletonHtml(n = 4) {
  return Array.from(
    { length: n },
    (_, i) => `<li class="skeleton" aria-hidden="true"><span class="sk port-sk"></span>
      <span class="sk-lines"><span class="sk" style="width:${[62, 48, 70, 55][i % 4]}%"></span><span class="sk" style="width:${[38, 44, 30, 41][i % 4]}%;height:8px"></span></span></li>`,
  ).join("");
}

function showState(html: string, cls = "") {
  stateEl.hidden = false;
  stateEl.className = `state ${cls}`.trim();
  if (stateEl.dataset.html !== html) {
    stateEl.innerHTML = html;
    stateEl.dataset.html = html;
  }
}

function hideState() {
  stateEl.hidden = true;
  stateEl.dataset.html = "";
  stateEl.innerHTML = "";
  stateEl.className = "state";
}

function extensionId(): string {
  return (typeof chrome !== "undefined" && chrome.runtime?.id) || "<extension-id>";
}

function installText(): string {
  const { cmd, args } = installCommand(extensionId(), __PINNED_ID__);
  return args ? `${cmd} ${args}` : cmd;
}

function onboardingHtml(): string {
  const { cmd, args } = installCommand(extensionId(), __PINNED_ID__);
  const forbidden = state.failure === "forbidden";
  return `<div class="onboard">
    <div class="onboard-head">
      <div class="state-mark">${icon.plug(24)}</div>
      <h2>${forbidden ? "Reconnect the helper" : "Connect the Portlight helper"}</h2>
      <p>${
        forbidden
          ? "The helper is installed, but for a different extension ID. Run the installer again to allow this one."
          : `Chrome can’t see which app owns a port. A small helper reads ${yourDevices()} listening ports and answers only this extension.`
      }</p>
    </div>
    <ol class="steps">
      <li class="step"><span class="step-n">1</span><div class="step-text">In the Portlight folder, run:
        <div class="code"><code><span class="cmd">${esc(cmd)}</span>${args ? ` ${esc(args)}` : ""}</code>
          <button class="icon-btn" type="button" data-act="copy-install" aria-label="Copy install command" title="Copy command">${icon.copy(15)}</button>
        </div></div></li>
      <li class="step"><span class="step-n">2</span><div class="step-text">Come back and check again. <span class="muted">No restart needed.</span></div></li>
    </ol>
    <div class="onboard-actions">
      <button class="btn primary large" type="button" data-act="recheck">Check Again</button>
      <button class="btn plain large" type="button" data-act="fallback">Scan common ports over HTTP</button>
    </div>
    <p class="onboard-note" role="status">${
      state.recheckFailed ? "Still can’t reach the helper. Make sure the script finished without errors." : "Nothing leaves your computer."
    }</p>
  </div>`;
}

function renderBody(animate: boolean) {
  bodyEl.setAttribute("aria-busy", String(state.mode === "loading" || state.scanning));

  if (state.mode === "missing") {
    renderList([], false);
    showState(onboardingHtml(), "onboarding");
    stateEl.className = "";
    return;
  }
  if (state.mode === "loading") {
    renderList([], false);
    if (state.showSkeleton) {
      hideState();
      list.innerHTML = skeletonHtml();
    }
    return;
  }
  list.querySelectorAll(".skeleton").forEach((s) => s.remove());

  if (state.mode === "error") {
    renderList([], false);
    showState(
      `<div class="state-mark">${icon.warning(22)}</div>
       <h2>Couldn’t read ports</h2>
       <p>${esc(state.error || "The helper stopped responding.")}</p>
       <div class="actions-row">
         <button class="btn primary" type="button" data-act="retry">Try Again</button>
         <button class="btn" type="button" data-act="fallback">Use HTTP Scan</button>
       </div>`,
      "error",
    );
    return;
  }

  const { items, visible } = buildItems();
  renderList(items, animate);
  if (state.menu && !rowEls.has(state.menu.key)) closeMenu(false);

  if (visible) {
    hideState();
  } else if (state.query.trim()) {
    if (state.check) hideState();
    else
      showState(
        `<div class="state-mark">${icon.search(20)}</div><h2>No matches</h2>
         <p>Nothing in use matches “${esc(state.query.trim())}”.</p>`,
      );
  } else if (state.mode === "fallback" && state.scanning) {
    showState(
      `<div class="state-mark">${icon.waves(22)}</div><h2>Scanning common ports…</h2>
       <p>Knocking on ${fallbackPorts().length} ports where dev servers usually live.</p>`,
    );
  } else if (state.mode === "fallback") {
    showState(
      `<div class="state-mark">${icon.waves(22)}</div><h2>No web servers found</h2>
       <p>Nothing answered on the usual dev ports. Databases and other non-web services need the helper to show up.</p>`,
    );
  } else if (items.length) {
    // Everything is hidden: the "N hidden" row is the whole list.
    hideState();
  } else {
    showState(
      `<div class="state-mark">${icon.waves(22)}</div><h2>Nothing is listening</h2>
       <p>Nothing is listening right now. Start a dev server and it appears here.</p>`,
      "empty",
    );
  }
}

/** Ports the user sees (hidden ones don't count towards "N ports in use"). */
function visibleCount(): number {
  return busyPortCount(state.rows.filter((r) => !hiddenReason(r, state.settings)));
}

function renderChrome() {
  app.dataset.mode = state.mode;
  app.dataset.live = state.mode === "host" && !state.stale ? "on" : state.mode === "fallback" ? "http" : "off";
  let text: string;
  switch (state.mode) {
    case "loading":
      text = "Looking…";
      break;
    case "host":
      text = state.stale ? "Reconnecting…" : summary(visibleCount());
      break;
    case "fallback":
      text = state.scanning && !state.rows.length ? "Scanning…" : `${plural(visibleCount(), "server")} · HTTP only`;
      break;
    case "missing":
      text = "Not connected";
      break;
    default:
      text = "Unavailable";
  }
  const st = $("status-text");
  if (st.textContent !== text) st.textContent = text;

  const wrap = $("search-wrap");
  wrap.classList.toggle("has-text", !!state.query);
  $("clear").hidden = !state.query;
  $("search-hint").hidden = !!state.query;

  const banner = $("banner");
  if (state.mode === "fallback") {
    banner.hidden = false;
    setHtml(
      banner,
      `${icon.waves(14)}<span><strong>HTTP only.</strong> Showing dev servers that answer on common ports. <button class="link" type="button" data-act="setup">Install the helper</button> to see every port and its app.</span>`,
    );
  } else {
    banner.hidden = true;
    banner.dataset.html = "";
  }
}

function renderCheck() {
  const box = $("check");
  const c = state.check;
  if (!c) {
    box.hidden = true;
    box.innerHTML = "";
    box.dataset.sig = "";
    return;
  }
  const httpOnly = state.mode === "fallback";
  let title = "";
  let sub = "";
  let note = "";
  let action = "";
  if (c.state === "free") {
    title = `Port ${c.port} is <em>free</em>`;
    sub = c.port < 1024 ? "Privileged port — binding it needs admin rights." : "Nothing is listening on it.";
    action = `<button class="btn" type="button" data-act="copy-port" data-port="${c.port}"><span class="bglyph">${icon.copy(13)}</span><span>Copy</span></button>`;
  } else if (c.state === "used") {
    const r = c.row;
    const who = r ? [displayName(r).name, toolLabel(r, displayName(r).name), r.source === "host" && !r.container ? r.process : ""] : [];
    const uniq = [...new Set(who.filter(Boolean) as string[])];
    title = `Port ${c.port} is in use`;
    sub = uniq.length ? `by ${esc(uniq.join(" · "))}` : httpOnly ? "A web server answered." : "Something is listening on it.";
    // The one place people meet AirPlay Receiver: they typed 5000 because their server failed to start.
    if (r?.known?.noQuit) note = esc(r.known.fix ?? r.known.about);
    const hasTab = tabsFor(c.port).length > 0;
    // Nothing to open on a port the OS holds (AirPlay, Remote Login…), unless a tab already points there.
    action =
      r?.group === "system" && !hasTab
        ? ""
        : `<button class="btn" type="button" data-act="open-port" data-port="${c.port}">${hasTab ? "Show Tab" : "Open"}</button>`;
  } else if (c.state === "pending") {
    title = `Checking ${c.port}…`;
    sub = "Knocking over HTTP.";
  } else {
    title = `Port ${c.port} looks <em>free</em>`;
    sub = "No web server answered. HTTP only — other services can’t be seen.";
    action = `<button class="btn" type="button" data-act="copy-port" data-port="${c.port}"><span class="bglyph">${icon.copy(13)}</span><span>Copy</span></button>`;
  }
  const sig = `${c.port}|${c.state}|${sub}|${note}|${action}`;
  if (box.dataset.sig === sig) return;
  const appearing = box.hidden;
  box.dataset.sig = sig;
  box.dataset.state = c.state === "unknown" ? "free" : c.state;
  box.innerHTML = `<span class="check-dot" aria-hidden="true"></span>
    <div class="check-copy"><div class="check-title">${title}</div><div class="check-sub">${sub}</div>${note ? `<div class="check-note">${note}</div>` : ""}</div>${action}`;
  box.hidden = false;
  if (!appearing) box.style.animation = "none";
  else box.style.animation = "";
}

function renderFooter() {
  const pill = $<HTMLButtonElement>("suggest");
  const port = state.suggestion;
  const portEl = $("suggest-port");
  const txt = port ? String(port) : "—";
  if (portEl.textContent !== txt) portEl.textContent = txt;
  pill.disabled = !port;
  const near = queryPort();
  $("suggest-label").textContent =
    state.mode === "fallback" ? "Likely free" : near != null ? `Free near ${near}` : "Free port";
  pill.setAttribute("aria-label", port ? `Copy free port ${port}` : "No free port suggestion");
  pill.title = port ? "Copy port number" : "";

  // "Quit N Idle…" takes the keyboard hints' place only while there is something to clean up.
  const idle = state.query.trim() ? [] : idleRows();
  const idleBtn = $<HTMLButtonElement>("idle");
  const label = idle.length ? `Quit ${idle.length} Idle…` : "";
  if (idleBtn.textContent !== label) idleBtn.textContent = label;
  idleBtn.hidden = !idle.length;
  idleBtn.setAttribute("aria-expanded", String(!!state.sweep));
  idleBtn.title = idle.length
    ? `${plural(idle.length, "dev server")} running over ${state.settings.idleAfterHours} h with no tab open`
    : "";
  $("hints").hidden = !!idle.length;
  if (state.sweep && !idle.length && state.sweep.phase === "ask") state.sweep = null;
  renderSweep();
}

function renderSweep() {
  const box = $("sweep");
  const content = $("sweep-content");
  const sw = state.sweep;
  box.classList.toggle("open", !!sw);
  const sig = sw ? `${sw.phase}|${sw.keys.join(",")}|${sw.message ?? ""}` : "";
  if (content.dataset.sig === sig) return;
  content.dataset.sig = sig;
  if (!sw) {
    setTimeout(() => {
      if (!content.dataset.sig) content.innerHTML = "";
    }, 450);
    return;
  }
  const rows = sw.keys.map((k) => rowByKey(k)).filter((r): r is PortRow => !!r);
  const items = rows
    .map((r) => {
      const { name } = displayName(r);
      const tool = toolLabel(r, name);
      return `<li><span class="sweep-port">${r.port}</span><span class="sweep-name">${esc(name)}</span>${tool ? `<span class="sweep-tool">${esc(tool)}</span>` : ""}<span class="sweep-age">${esc(formatUptime(r.startedAt) ?? "")}</span></li>`;
    })
    .join("");
  const n = rows.length;
  let head: string;
  let actions: string;
  if (sw.phase === "error") {
    head = `<p class="sweep-title error">${esc(sw.message ?? "Some servers didn’t quit.")}</p>`;
    actions = `<button class="btn" type="button" data-act="sweep-cancel">OK</button>`;
  } else {
    const pending = sw.phase === "pending";
    head = `<p class="sweep-title">${pending ? `Quitting ${plural(n, "idle server")}…` : `Quit ${plural(n, "idle server")}?`}</p>
      <p class="sweep-sub">Running over ${state.settings.idleAfterHours} hours with no tab open. Their child processes quit too.</p>`;
    actions = `<button class="btn" type="button" data-act="sweep-cancel"${pending ? " disabled" : ""}>Cancel</button>
      <button class="btn destructive" type="button" data-act="sweep-quit"${pending ? " disabled" : ""}>Quit ${n}</button>`;
  }
  content.innerHTML = `${head}${items ? `<ul class="sweep-list">${items}</ul>` : ""}<div class="confirm-row end">${actions}</div>`;
  if (sw.phase !== "pending") {
    const target = content.querySelector<HTMLElement>('[data-act="sweep-quit"]') ?? content.querySelector<HTMLElement>('[data-act="sweep-cancel"]');
    requestAnimationFrame(() => content.dataset.sig === sig && target?.focus({ preventScroll: true }));
  }
}

function render(opts: { animate?: boolean } = {}) {
  renderChrome();
  renderBody(!!opts.animate);
  renderCheck();
  renderFooter();
}

// ---------- row menu ----------

interface MenuItem {
  act: string;
  label: string;
  hint?: string;
  danger?: boolean;
}

function menuItems(r: PortRow): MenuItem[][] {
  const s = state.settings;
  const sections: MenuItem[][] = [];
  const tabs = tabsFor(r.port);
  sections.push([
    { act: "m-open", label: tabs.length ? "Switch to Tab" : "Open in New Tab", hint: "↩" },
    { act: "m-copy", label: "Copy URL", hint: "⌘C" },
  ]);
  if (canShare(r)) {
    sections.push([
      { act: "m-phone", label: "Open on Phone…" },
      { act: "m-share", label: state.tunnels.some((t) => t.port === r.port) ? "Public Link…" : "Share Public Link…" },
    ]);
  }
  if (r.source === "host" && r.pid && state.mode === "host" && !r.container) {
    const files: MenuItem[] = [{ act: "m-reveal", label: REVEAL_LABEL }];
    if (s.editor !== "none") files.push({ act: "m-editor", label: `Open in ${EDITOR_LABEL[s.editor]}` });
    sections.push(files);
  }
  const reason = hiddenReason(r, s);
  const hide: MenuItem[] = [
    s.hiddenPorts.includes(r.port)
      ? { act: "m-unhide-port", label: `Show Port ${r.port}` }
      : { act: "m-hide-port", label: `Hide Port ${r.port}` },
  ];
  if (r.process && !r.container && r.source === "host") {
    const hiddenProc = s.hiddenProcesses.some((p) => p.toLowerCase() === r.process!.toLowerCase());
    hide.push(
      hiddenProc
        ? { act: "m-unhide-proc", label: `Show All “${r.process}”` }
        : { act: "m-hide-proc", label: `Hide All “${r.process}”` },
    );
  }
  if (reason === "system") hide.push({ act: "m-show-system", label: "Always Show System Ports" });
  sections.push(hide);
  if (r.source === "host" && state.mode === "host") {
    if (r.known?.noQuit) sections.push([{ act: "info", label: "Why Can’t I Quit This?" }]);
    else if (r.pid) sections.push([{ act: "kill", label: `Quit ${r.process ?? "Process"}…`, hint: "⌘⌫", danger: true }]);
  }
  return sections;
}

function openMenu(key: string, at?: { x: number; y: number }) {
  const r = rowByKey(key);
  const li = rowEls.get(key);
  if (!r || !li || r.source === "tab") return;
  if (state.confirm && state.confirm.key !== key) state.confirm = null;
  state.menu = { key, scrollTop: bodyEl.scrollTop };
  menuEl.innerHTML = menuItems(r)
    .map((sec) =>
      sec
        .map(
          (m) =>
            `<button class="menu-item${m.danger ? " danger" : ""}" type="button" role="menuitem" tabindex="-1" data-act="${m.act}" data-key="${esc(key)}"><span>${esc(m.label)}</span>${m.hint ? `<span class="menu-hint">${m.hint}</span>` : ""}</button>`,
        )
        .join(""),
    )
    .join(`<div class="menu-sep" role="separator"></div>`);
  menuEl.setAttribute("aria-label", `Actions for port ${r.port}`);
  menuEl.hidden = false;
  li.classList.add("menu-open");
  render();

  // Place under the ⋯ button (or at the pointer), kept inside the popup.
  const anchor = li.querySelector<HTMLElement>('[data-act="menu"]')!.getBoundingClientRect();
  const w = menuEl.offsetWidth;
  const hgt = menuEl.offsetHeight;
  let x = at ? at.x : anchor.right - w;
  let y = at ? at.y : anchor.bottom + 4;
  if (y + hgt > innerHeight - 8) y = at ? at.y - hgt : anchor.top - hgt - 4;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  y = Math.max(8, y);
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  menuEl.style.transformOrigin = `${at ? "left" : "right"} ${y < anchor.top ? "bottom" : "top"}`;
  menuEl.classList.remove("in");
  void menuEl.offsetWidth;
  menuEl.classList.add("in");
  menuEl.querySelector<HTMLElement>(".menu-item")?.focus({ preventScroll: true });
}

function closeMenu(refocus = true) {
  const key = state.menu?.key;
  if (!key) return;
  state.menu = null;
  menuEl.hidden = true;
  menuEl.innerHTML = "";
  const li = rowEls.get(key);
  li?.classList.remove("menu-open");
  li?.querySelector('[data-act="menu"]')?.setAttribute("aria-expanded", "false");
  if (refocus) li?.querySelector<HTMLElement>(".row-main")?.focus({ preventScroll: true });
}

async function runMenuAction(act: string, key: string) {
  const r = rowByKey(key);
  closeMenu(!["kill", "info", "m-phone", "m-share"].includes(act));
  if (!r) return;
  const s = state.settings;
  switch (act) {
    case "m-open":
      await openPort(r.port);
      break;
    case "m-copy":
      await copyUrl(r, rowEls.get(key)?.querySelector<HTMLElement>('[data-act="copy"]') ?? undefined);
      break;
    case "m-reveal":
      await hostAction(key, "reveal");
      break;
    case "m-phone":
      openPhone(key);
      break;
    case "m-share":
      await openShare(key);
      break;
    case "m-editor":
      await hostAction(key, "editor");
      break;
    case "m-hide-port":
      await patchSettings({ hiddenPorts: [...new Set([...s.hiddenPorts, r.port])] });
      announce(`Port ${r.port} hidden`);
      break;
    case "m-unhide-port":
      await patchSettings({ hiddenPorts: s.hiddenPorts.filter((p) => p !== r.port) });
      announce(`Port ${r.port} shown`);
      break;
    case "m-hide-proc":
      await patchSettings({ hiddenProcesses: [...new Set([...s.hiddenProcesses, r.process!])] });
      announce(`${r.process} hidden`);
      break;
    case "m-unhide-proc":
      await patchSettings({ hiddenProcesses: s.hiddenProcesses.filter((p) => p.toLowerCase() !== r.process!.toLowerCase()) });
      announce(`${r.process} shown`);
      break;
    case "m-show-system":
      await patchSettings({ hideSystem: false });
      announce("System ports shown");
      break;
    case "kill":
      askKill(key);
      break;
    case "info":
      showInfo(key);
      break;
  }
}

// ---------- events ----------

function rowFromEvent(target: Element): { key: string; row: PortRow; li: HTMLLIElement } | null {
  const li = target.closest<HTMLLIElement>("li.row");
  const key = li?.dataset.key;
  const row = key ? rowByKey(key) : undefined;
  return li && key && row ? { key, row, li } : null;
}

document.addEventListener("click", async (e) => {
  const target = e.target as Element;
  if (state.menu && !menuEl.contains(target) && !target.closest('[data-act="menu"]')) closeMenu(false);
  const btn = target.closest<HTMLElement>("[data-act], .row-main");
  if (!btn) return;
  const act = btn.dataset.act ?? "row";
  if (btn.classList.contains("menu-item")) {
    await runMenuAction(act, btn.dataset.key!);
    return;
  }
  const hit = rowFromEvent(btn);

  switch (act) {
    case "row":
    case "open":
      if (hit) await openPort(hit.row.port);
      break;
    case "copy":
      if (hit) await copyUrl(hit.row, btn);
      break;
    case "menu":
      if (hit) {
        if (state.menu?.key === hit.key) closeMenu();
        else openMenu(hit.key);
      }
      break;
    case "kill":
      if (hit) askKill(hit.key);
      break;
    case "info":
      if (hit) showInfo(hit.key);
      break;
    case "close-tabs":
      if (hit) {
        await closeTabs(tabsFor(hit.row.port));
        announce(`Closed ${plural(tabsFor(hit.row.port).length, "tab")} on port ${hit.row.port}`);
        await refreshTabs();
      }
      break;
    case "quit":
      if (hit) await kill(hit.key, "TERM");
      break;
    case "force":
      if (hit) await kill(hit.key, "KILL");
      break;
    case "cancel":
      cancelConfirm();
      break;
    case "start-share":
      if (hit) await startShare(hit.key);
      break;
    case "stop-share":
      if (hit) await stopShare(hit.row.port);
      break;
    case "open-url":
      if (typeof chrome !== "undefined" && chrome.tabs?.create) void chrome.tabs.create({ url: btn.dataset.url! });
      else window.open(btn.dataset.url, "_blank", "noopener");
      break;
    case "open-pane":
      await openPane(btn.dataset.pane as SettingsPane, hit?.key);
      break;
    case "sweep":
      if (state.sweep) closeSweep();
      else openSweep();
      break;
    case "sweep-cancel":
      closeSweep();
      break;
    case "sweep-quit":
      await runSweep();
      break;
    case "copy-cmd": {
      if (await copyText(btn.dataset.cmd!)) {
        flashDone(btn, btn, 14);
        announce(`Copied ${btn.dataset.cmd}`);
      }
      break;
    }
    case "toggle-hidden":
      state.revealHidden = !state.revealHidden;
      render({ animate: true });
      announce(state.revealHidden ? "Hidden ports shown" : "Hidden ports hidden again");
      break;
    case "settings":
      try {
        await chrome.runtime.openOptionsPage();
      } catch {
        announce("Settings aren’t available in this build");
      }
      break;
    case "copy-port": {
      const p = btn.dataset.port!;
      if (await copyText(p)) {
        flashDone(btn, btn.querySelector<HTMLElement>(".bglyph") ?? btn, 13);
        announce(`Copied ${p}`);
      }
      break;
    }
    case "open-port":
      await openPort(Number(btn.dataset.port));
      break;
    case "copy-install": {
      if (await copyText(installText())) {
        flashDone(btn, btn, 15);
        announce("Install command copied");
      }
      break;
    }
    case "recheck": {
      btn.setAttribute("disabled", "");
      state.recheckFailed = false;
      await refresh();
      if (state.mode === "missing") {
        state.recheckFailed = true;
        render();
      }
      break;
    }
    case "fallback":
      startFallback();
      break;
    case "setup":
      leaveFallback();
      break;
    case "retry":
      state.mode = "loading";
      render();
      await refresh();
      break;
  }
});

document.addEventListener("contextmenu", (e) => {
  const hit = rowFromEvent(e.target as Element);
  if (!hit || hit.row.source === "tab") return;
  e.preventDefault();
  openMenu(hit.key, { x: e.clientX, y: e.clientY });
});

$("suggest").addEventListener("click", async () => {
  const p = state.suggestion;
  if (!p) return;
  if (await copyText(String(p))) {
    flashDone($("suggest"), $("suggest").querySelector<HTMLElement>(".suggest-glyph")!, 14);
    announce(`Copied ${p}`);
  }
});

$("clear").addEventListener("click", () => {
  setQuery("");
  input.focus();
});

function setQuery(q: string) {
  input.value = q;
  state.query = q;
  state.confirm = null;
  closeMenu(false);
  void updateCheck(); // sets the instant answer synchronously, so render() below sees it
  render();
  void updateSuggestion();
}

input.addEventListener("input", () => setQuery(input.value));

bodyEl.addEventListener(
  "scroll",
  () => {
    app.classList.toggle("scrolled", bodyEl.scrollTop > 0);
    // Close when the list really moves; a late scroll event from bringing the row into view doesn't count.
    if (state.menu && Math.abs(bodyEl.scrollTop - state.menu.scrollTop) > 4) closeMenu(false);
  },
  { passive: true },
);

function rowMains(): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>("li.row:not(.leaving) .row-main")];
}

function focusRow(i: number) {
  const mains = rowMains();
  const el = mains[Math.max(0, Math.min(i, mains.length - 1))];
  el?.focus();
  el?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}

function menuKeys(e: KeyboardEvent): boolean {
  if (!state.menu) return false;
  const items = [...menuEl.querySelectorAll<HTMLElement>(".menu-item")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "Escape") {
    e.preventDefault();
    closeMenu();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = items.length;
    const next = e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
    items[next]?.focus();
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    items[e.key === "Home" ? 0 : items.length - 1]?.focus();
  } else if (e.key === "Tab") {
    e.preventDefault();
    closeMenu();
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
    // Type-to-select, like a native menu.
    const k = e.key.toLowerCase();
    const start = i + 1;
    const hit = [...items.slice(start), ...items.slice(0, start)].find((el) => el.textContent?.trim().toLowerCase().startsWith(k));
    hit?.focus();
  } else {
    return false;
  }
  return true;
}

document.addEventListener("keydown", (e) => {
  if (menuKeys(e)) return;
  const target = e.target as HTMLElement;
  const inSearch = target === input;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    input.focus();
    input.select();
    return;
  }
  if (e.key === "/" && !inSearch && target.tagName !== "INPUT") {
    e.preventDefault();
    input.focus();
    input.select();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (state.sweep && state.sweep.phase !== "pending") closeSweep();
    else if (state.confirm) cancelConfirm();
    else if (state.query) {
      setQuery("");
      input.focus();
    } else if (!inSearch && state.mode !== "missing") input.focus();
    else window.close();
    return;
  }

  const mains = rowMains();
  const idx = mains.indexOf(target);

  if (inSearch) {
    if (e.key === "ArrowDown" && mains.length) {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (mains[0]) mains[0].click();
      else if (state.check?.state === "free" || state.check?.state === "unknown") {
        void copyText(String(state.check.port)).then(() => announce(`Copied ${state.check?.port}`));
      }
    }
    return;
  }

  if (idx >= 0) {
    const hit = rowFromEvent(target);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(idx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (idx === 0) input.focus();
      else focusRow(idx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(mains.length - 1);
    } else if (mod && e.key.toLowerCase() === "c" && hit) {
      e.preventDefault();
      void copyUrl(hit.row, hit.li.querySelector<HTMLElement>('[data-act="copy"]') ?? undefined);
    } else if ((e.key === "Backspace" || e.key === "Delete") && hit) {
      e.preventDefault();
      askKill(hit.key);
    } else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && hit) {
      e.preventDefault();
      openMenu(hit.key);
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      // Typing on a row keeps refining the search.
      input.focus();
    }
  }
});

// ---------- boot ----------

let loop: ReturnType<typeof setInterval> | undefined;
function restartLoop() {
  clearInterval(loop);
  loop = setInterval(
    () => {
      if (document.visibilityState === "visible" && (state.mode === "host" || state.mode === "error")) void refresh();
    },
    Math.max(500, state.settings.refreshMs || DEFAULT_SETTINGS.refreshMs),
  );
}

applySettings(state.settings, { render: false });
const cached = loadCache();
if (cached) {
  state.mode = "host";
  state.stale = false;
  state.rows = shapeListeners(cached);
}
render();
void updateSuggestion();
setTimeout(() => {
  if (state.mode === "loading") {
    state.showSkeleton = true;
    render();
  }
}, 120);

input.focus();
void bootSettings();
void refresh();
restartLoop();
const unwatchTabs = watchTabs(() => void refreshTabs());
addEventListener("pagehide", () => {
  clearInterval(loop);
  clearTimeout(fallbackTimer);
  unwatchTabs();
});
