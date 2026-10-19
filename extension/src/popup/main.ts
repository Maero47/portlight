import { icon } from "./icons.ts";
import { HostClient, HostConnectionError, HostRequestError, portTransport, type HostFailure } from "../lib/host.ts";
import { installCommand, thisDevice, yourDevices } from "../lib/platform.ts";
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
import type { Listener } from "../../../shared/protocol.ts";

type Mode = "loading" | "host" | "missing" | "fallback" | "error";
type CheckState = "free" | "used" | "pending" | "unknown";

interface Confirm {
  key: string;
  phase: "ask" | "pending" | "stuck" | "error";
  message?: string;
}

interface Check {
  port: number;
  state: CheckState;
  row?: PortRow;
}

const REFRESH_MS = 2000;
const FALLBACK_RESCAN_MS = 8000;
const CACHE_KEY = "portlight.last";
const DEFAULT_NEAR = 3000;

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
};

// ---------- DOM helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const input = $<HTMLInputElement>("q");
const list = $<HTMLUListElement>("rows");
const stateEl = $("state");
const bodyEl = $("body");

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

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

for (const el of document.querySelectorAll<HTMLElement>("[data-icon]")) {
  const name = el.dataset.icon as keyof typeof icon;
  el.innerHTML = icon[name](name === "search" ? 15 : 14);
}
$("clear").innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

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

function openPort(port: number) {
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

// ---------- data ----------

let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  if (state.mode === "fallback") return Promise.resolve();
  inflight ??= (async () => {
    try {
      const res = await host.list();
      state.rows = shapeListeners(res.listeners);
      state.stale = false;
      state.mode = "host";
      state.failure = null;
      saveCache(res.listeners);
      setBadge(busyPortCount(state.rows));
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
  })();
  return inflight;
}

let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

async function scanFallback(first = false) {
  if (state.mode !== "fallback") return;
  state.scanning = true;
  if (first) render();
  const found: PortRow[] = first ? [] : state.rows.slice();
  const seen = new Set<number>();
  await probePorts(COMMON_DEV_PORTS, {
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
  const near = queryPort() ?? DEFAULT_NEAR;
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

// ---------- kill ----------

function rowByKey(key: string) {
  return state.rows.find((r) => r.key === key);
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
      state.confirm = null;
      announce(`Quit ${row.process ?? "process"} on port ${row.port}`);
    }
  } catch (e) {
    const message =
      e instanceof HostRequestError && e.code === "not_permitted"
        ? "Not permitted — it belongs to another user."
        : e instanceof HostRequestError && e.code === "not_found"
          ? "That process has already exited."
          : e instanceof Error
            ? e.message
            : String(e);
    state.confirm = { key, phase: "error", message };
  }
  render();
}

function askKill(key: string) {
  const row = rowByKey(key);
  if (!row?.pid || state.mode !== "host") return;
  state.confirm = { key, phase: "ask" };
  render();
}

function cancelConfirm(refocus = true) {
  const key = state.confirm?.key;
  state.confirm = null;
  render();
  if (refocus && key) rowEls.get(key)?.querySelector<HTMLElement>(".row-main")?.focus();
}

// ---------- rendering ----------

const rowEls = new Map<string, HTMLLIElement>();

function displayName(r: PortRow): { name: string; unknown: boolean } {
  const name = r.project ?? r.title ?? r.tool ?? r.process;
  if (name) return { name, unknown: false };
  return { name: r.source === "http" ? "Web server" : "Unknown process", unknown: true };
}

function createRow(r: PortRow): HTMLLIElement {
  const li = h("li", { class: "row", "data-key": r.key });
  li.innerHTML = `
    <button class="row-main" type="button">
      <span class="port"></span>
      <span class="meta">
        <span class="line1"><span class="name"></span><span class="tool"></span></span>
        <span class="line2"></span>
      </span>
      <span class="trail"><span class="uptime"></span></span>
    </button>
    <div class="actions">
      <button class="icon-btn" type="button" data-act="copy">${icon.copy(15)}</button>
      <button class="icon-btn" type="button" data-act="open">${icon.open(15)}</button>
      <button class="icon-btn danger" type="button" data-act="kill">${icon.stop(15)}</button>
    </div>
    <div class="confirm"><div class="confirm-inner"><div class="confirm-content"></div></div></div>`;
  return li;
}

function updateRow(li: HTMLLIElement, r: PortRow) {
  const { name, unknown } = displayName(r);
  const tool = r.tool && r.tool !== name ? r.tool : "";
  const uptime = formatUptime(r.startedAt);
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

  let line2: string;
  if (r.source === "http") {
    line2 = `<span class="proc">Answered HTTP${r.status ? ` ${r.status}` : ""}</span>`;
  } else {
    const proc = r.process && r.process !== name ? r.process : r.pid ? `PID ${r.pid}` : "";
    // Local is the norm, so it gets a quiet glyph; exposure is the exception and gets a word.
    line2 =
      r.scope === "network"
        ? `<span class="scope network">${icon.network(12)}Network</span>${proc ? `<span class="sep">·</span><span class="proc">${esc(proc)}</span>` : ""}`
        : `<span class="scope local" title="Only reachable from ${DEVICE}">${icon.lock(12)}</span>${proc ? `<span class="proc">${esc(proc)}</span>` : ""}`;
  }
  const l2 = li.querySelector<HTMLElement>(".line2")!;
  if (l2.dataset.html !== line2) {
    l2.innerHTML = line2;
    l2.dataset.html = line2;
  }

  const details = [
    `Port ${r.port}`,
    name,
    tool,
    r.process && r.process !== name ? r.process : "",
    r.pid ? `PID ${r.pid}` : "",
    describeScope(r, DEVICE),
    describeUptime(r.startedAt) ?? "",
  ].filter(Boolean);
  main.setAttribute("aria-label", `${details.join(", ")}. Open in a new tab.`);
  main.title = [r.command, r.cwd, describeScope(r, DEVICE)].filter(Boolean).join("\n") || urlFor(r.port);

  const copyBtn = li.querySelector<HTMLElement>('[data-act="copy"]')!;
  copyBtn.setAttribute("aria-label", `Copy ${urlFor(r.port)}`);
  copyBtn.title = "Copy URL  ⌘C";
  const openBtn = li.querySelector<HTMLElement>('[data-act="open"]')!;
  openBtn.setAttribute("aria-label", `Open port ${r.port} in a new tab`);
  openBtn.title = "Open in new tab  ↩";
  const killBtn = li.querySelector<HTMLElement>('[data-act="kill"]')!;
  killBtn.hidden = !r.pid || state.mode !== "host";
  killBtn.setAttribute("aria-label", `Quit ${r.process ?? "process"} on port ${r.port}`);
  killBtn.title = "Quit process  ⌘⌫";

  renderConfirm(li, r);
}

function renderConfirm(li: HTMLLIElement, r: PortRow) {
  const c = state.confirm?.key === r.key ? state.confirm : null;
  li.classList.toggle("confirming", !!c);
  const box = li.querySelector<HTMLElement>(".confirm-content")!;
  const sig = c ? `${c.phase}|${c.message ?? ""}` : "";
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  if (!c) {
    // Leave content in place while the panel collapses; clear afterwards.
    setTimeout(() => {
      if (!box.dataset.sig) box.innerHTML = "";
    }, 450);
    return;
  }
  const proc = esc(r.process ?? "this process");
  let html = "";
  if (c.phase === "ask") {
    html = `<span class="confirm-text">Quit <strong>${proc}</strong>?</span>
      <button class="btn" type="button" data-act="cancel">Cancel</button>
      <button class="btn destructive" type="button" data-act="quit">Quit</button>`;
  } else if (c.phase === "pending") {
    html = `<span class="confirm-text">Quitting <strong>${proc}</strong>…</span>`;
  } else if (c.phase === "stuck") {
    html = `<span class="confirm-text"><strong>${proc}</strong> is still running.</span>
      <button class="btn" type="button" data-act="cancel">Cancel</button>
      <button class="btn destructive" type="button" data-act="force">Force Quit</button>`;
  } else {
    html = `<span class="confirm-text error">${esc(c.message ?? "Couldn’t quit the process.")}</span>
      <button class="btn" type="button" data-act="cancel">OK</button>`;
  }
  box.innerHTML = html;
  const focusTarget = box.querySelector<HTMLElement>('[data-act="quit"], [data-act="force"], [data-act="cancel"]');
  // Skip if the panel was dismissed before the frame (e.g. a quick Escape).
  if (focusTarget) requestAnimationFrame(() => box.dataset.sig === sig && focusTarget.focus({ preventScroll: true }));
  if (c.phase === "pending") li.querySelector<HTMLElement>(".row-main")?.focus({ preventScroll: true });
}

function removeRow(key: string, el: HTMLLIElement, animate: boolean) {
  rowEls.delete(key);
  if (el.contains(document.activeElement)) {
    const next =
      (el.nextElementSibling ?? el.previousElementSibling)?.querySelector<HTMLElement>(".row-main") ?? input;
    next.focus({ preventScroll: true });
  }
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

function renderRows(rows: PortRow[], animate: boolean) {
  const keep = new Set(rows.map((r) => r.key));
  for (const [key, el] of rowEls) if (!keep.has(key)) removeRow(key, el, animate);
  let prev: HTMLLIElement | null = null;
  for (const r of rows) {
    let el = rowEls.get(r.key);
    if (!el) {
      el = createRow(r);
      rowEls.set(r.key, el);
      if (animate && !firstPaint && !reducedMotion()) {
        el.classList.add("entering");
        const node = el;
        requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("entering")));
      }
    }
    updateRow(el, r);
    const anchor: ChildNode | null = prev ? prev.nextSibling : list.firstChild;
    if (anchor !== el) list.insertBefore(el, anchor);
    prev = el;
  }
  if (rows.length) firstPaint = false;
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
  const visible = state.mode === "host" || state.mode === "fallback" ? filterRows(state.rows, state.query) : [];
  bodyEl.setAttribute("aria-busy", String(state.mode === "loading" || state.scanning));

  if (state.mode === "missing") {
    renderRows([], false);
    showState(onboardingHtml(), "onboarding");
    stateEl.className = "";
    return;
  }
  if (state.mode === "loading") {
    renderRows([], false);
    if (state.showSkeleton) {
      hideState();
      list.innerHTML = skeletonHtml();
    }
    return;
  }
  list.querySelectorAll(".skeleton").forEach((s) => s.remove());

  if (state.mode === "error") {
    renderRows([], false);
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

  renderRows(visible, animate);

  if (visible.length) {
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
       <p>Knocking on ${COMMON_DEV_PORTS.length} ports where dev servers usually live.</p>`,
    );
  } else if (state.mode === "fallback") {
    showState(
      `<div class="state-mark">${icon.waves(22)}</div><h2>No web servers found</h2>
       <p>Nothing answered on the usual dev ports. Databases and other non-web services need the helper to show up.</p>`,
    );
  } else {
    showState(
      `<div class="state-mark">${icon.waves(22)}</div><h2>Nothing is listening</h2>
       <p>Nothing is listening right now. Start a dev server and it appears here.</p>`,
      "empty",
    );
  }
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
      text = state.stale ? "Reconnecting…" : summary(busyPortCount(state.rows));
      break;
    case "fallback":
      text = state.scanning && !state.rows.length ? "Scanning…" : `${plural(busyPortCount(state.rows), "server")} · HTTP only`;
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
    const html = `${icon.waves(14)}<span><strong>HTTP only.</strong> Showing dev servers that answer on common ports. <button class="link" type="button" data-act="setup">Install the helper</button> to see every port and its app.</span>`;
    if (banner.dataset.html !== html) {
      banner.innerHTML = html;
      banner.dataset.html = html;
    }
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
  let action = "";
  if (c.state === "free") {
    title = `Port ${c.port} is <em>free</em>`;
    sub = c.port < 1024 ? "Privileged port — binding it needs admin rights." : "Nothing is listening on it.";
    action = `<button class="btn" type="button" data-act="copy-port" data-port="${c.port}"><span class="bglyph">${icon.copy(13)}</span><span>Copy</span></button>`;
  } else if (c.state === "used") {
    const r = c.row;
    const who = r ? [displayName(r).name, r.tool && r.tool !== displayName(r).name ? r.tool : "", r.source === "host" ? r.process : ""] : [];
    const uniq = [...new Set(who.filter(Boolean) as string[])];
    title = `Port ${c.port} is in use`;
    sub = uniq.length ? `by ${esc(uniq.join(" · "))}` : httpOnly ? "A web server answered." : "Something is listening on it.";
    action = `<button class="btn" type="button" data-act="open-port" data-port="${c.port}">Open</button>`;
  } else if (c.state === "pending") {
    title = `Checking ${c.port}…`;
    sub = "Knocking over HTTP.";
  } else {
    title = `Port ${c.port} looks <em>free</em>`;
    sub = "No web server answered. HTTP only — other services can’t be seen.";
    action = `<button class="btn" type="button" data-act="copy-port" data-port="${c.port}"><span class="bglyph">${icon.copy(13)}</span><span>Copy</span></button>`;
  }
  const sig = `${c.port}|${c.state}|${sub}`;
  if (box.dataset.sig === sig) return;
  const appearing = box.hidden;
  box.dataset.sig = sig;
  box.dataset.state = c.state === "unknown" ? "free" : c.state;
  box.innerHTML = `<span class="check-dot" aria-hidden="true"></span>
    <div class="check-copy"><div class="check-title">${title}</div><div class="check-sub">${sub}</div></div>${action}`;
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
}

function render(opts: { animate?: boolean } = {}) {
  renderChrome();
  renderBody(!!opts.animate);
  renderCheck();
  renderFooter();
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
  const btn = target.closest<HTMLElement>("[data-act], .row-main");
  if (!btn) return;
  const act = btn.dataset.act ?? "row";
  const hit = rowFromEvent(btn);

  switch (act) {
    case "row":
    case "open":
      if (hit) openPort(hit.row.port);
      break;
    case "copy":
      if (hit) await copyUrl(hit.row, btn);
      break;
    case "kill":
      if (hit) askKill(hit.key);
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
    case "copy-port": {
      const p = btn.dataset.port!;
      if (await copyText(p)) {
        flashDone(btn, btn.querySelector<HTMLElement>(".bglyph") ?? btn, 13);
        announce(`Copied ${p}`);
      }
      break;
    }
    case "open-port":
      openPort(Number(btn.dataset.port));
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
  void updateCheck(); // sets the instant answer synchronously, so render() below sees it
  render();
  void updateSuggestion();
}

input.addEventListener("input", () => setQuery(input.value));

bodyEl.addEventListener("scroll", () => app.classList.toggle("scrolled", bodyEl.scrollTop > 0), { passive: true });

function rowMains(): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>("li.row:not(.leaving) .row-main")];
}

function focusRow(i: number) {
  const mains = rowMains();
  const el = mains[Math.max(0, Math.min(i, mains.length - 1))];
  el?.focus();
  el?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}

document.addEventListener("keydown", (e) => {
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
    if (state.confirm) cancelConfirm();
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
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      // Typing on a row keeps refining the search.
      input.focus();
    }
  }
});

// ---------- boot ----------

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
void refresh();
const loop = setInterval(() => {
  if (document.visibilityState === "visible" && (state.mode === "host" || state.mode === "error")) void refresh();
}, REFRESH_MS);
addEventListener("pagehide", () => {
  clearInterval(loop);
  clearTimeout(fallbackTimer);
});
