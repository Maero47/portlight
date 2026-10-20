// Portlight settings page. Every control writes through saveSettings() the moment it
// changes, and onSettingsChanged() keeps this page in step with the popup and other tabs.

import { HostClient, HostConnectionError, chromeTransport } from "../lib/host.ts";
import { NODE_URL, detectOs, installPlan, thisDevice, yourDevices, type InstallMethod } from "../lib/platform.ts";
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings, writeSettings, type Settings } from "../lib/settings.ts";
import { icon } from "../popup/icons.ts";
import { WriteScheduler } from "./writer.ts";
import { heartbeat, roll, setReducedMotion, sleepWhenHidden } from "../lib/motion.ts";
import {
  EDITORS,
  GROUPS,
  IDLE_MAX_HOURS,
  addProcess,
  formatIdle,
  formatRefresh,
  mergePorts,
  parsePorts,
  parsePreferredPort,
  platformName,
  refreshOptions,
  removePort,
  removeProcess,
  stepIdle,
  toggleGroup,
} from "./model.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const root = document.documentElement;

let settings: Settings = { ...DEFAULT_SETTINGS };

const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
setReducedMotion(() => settings.motion === "reduced" || (settings.motion === "system" && reduceQuery.matches));
sleepWhenHidden();

// ---------- static bits ----------

const os = detectOs();
document.querySelectorAll("[data-device]").forEach((el) => (el.textContent = thisDevice(os)));
document.querySelectorAll("[data-device-possessive]").forEach((el) => (el.textContent = yourDevices(os)));
document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
  const name = el.dataset.icon as keyof typeof icon;
  el.innerHTML = icon[name](name === "check" ? 12 : 14);
});
$("version").textContent = manifestVersion();

function manifestVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "—";
  }
}

const announcer = $("announcer");
function announce(text: string) {
  announcer.textContent = "";
  requestAnimationFrame(() => (announcer.textContent = text));
}

// ---------- saving ----------

// Every write goes through one scheduler: edits are merged and storage is written at most once
// per MIN_WRITE_INTERVAL_MS. The page itself updates instantly; only the storage write is paced.
let savedTimer: ReturnType<typeof setTimeout> | undefined;
/** Bumped on every local edit, so a storage read that started earlier can tell it is stale. */
let edits = 0;
/**
 * What our own saves wrote in the last couple of seconds. A late echo of an older one must not
 * roll the page back; entries expire so a later identical change from the popup still lands.
 */
let ownWrites: { snap: string; at: number }[] = [];
const ECHO_MS = 2000;
const snapshot = (s: Settings) => JSON.stringify(s);

const writer = new WriteScheduler<Partial<Settings>>(
  async (patch) => {
    try {
      // saveSettings() reads, merges and writes, so changes made in the popup meanwhile survive.
      const saved = await saveSettings(patch);
      const now = Date.now();
      ownWrites = [...ownWrites.filter((w) => now - w.at < ECHO_MS), { snap: snapshot(saved), at: now }];
      showSaved();
    } catch (e) {
      console.warn("Portlight: could not save settings", e);
      announce("Couldn’t save. Try again.");
    }
  },
  // Once the last save lands, take storage as the truth (it may hold edits from the popup).
  { onIdle: () => resync() },
);

/** Apply an edit to the page now and hand it to the write scheduler. */
function commit(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  edits++;
  render();
  writer.schedule(patch);
  return writer.settled();
}

function resync() {
  const at = edits;
  void loadSettings().then((s) => adopt(s, at));
}

/** Take settings read from storage, unless the page has been edited since the read began. */
function adopt(s: Settings, at = edits) {
  if (!idle() || at !== edits) return;
  settings = s;
  render();
}

/** Nothing staged and nothing in flight: storage can be taken as the truth. */
const idle = () => !writer.busy();

/** Hooks that commit input a control is still holding back. */
const pendingInput: (() => void)[] = [];

/**
 * The tab is closing or hiding. saveSettings() reads before it writes, and a closing page is
 * torn down before that read returns, so a waiting edit would be lost. Write the page's full
 * merged settings with one storage call issued right here instead. The scheduler keeps its
 * edits too: if the page lives on (it was only hidden), its normal read-merge save follows and
 * lands after any older save still in flight, so nothing is rolled back.
 */
function persistNow() {
  // Controls that hold typed input back (a debounce timer, or "save on blur") hand it over first:
  // blur isn't guaranteed when a tab closes, and timers never fire on a page that is gone.
  for (const take of pendingInput) take();
  if (!writer.busy()) return;
  void writeSettings(settings).catch((e) => console.warn("Portlight: could not save settings", e));
  void writer.flush();
}
addEventListener("pagehide", persistNow);
document.addEventListener("visibilitychange", () => document.hidden && persistNow());

function showSaved() {
  const el = $("saved");
  el.classList.remove("show");
  void el.offsetWidth; // restart the transition when saves come in quick succession
  el.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove("show"), 1400);
  announce("Saved");
}

// ---------- appearance of this page ----------

function applyLook() {
  root.dataset.theme = settings.theme;
  root.dataset.motion = settings.motion;
}

// ---------- segmented controls ----------

for (const seg of document.querySelectorAll<HTMLElement>(".segmented[data-setting]")) {
  const key = seg.dataset.setting as "theme" | "motion";
  const inputs = [...seg.querySelectorAll<HTMLInputElement>("input")];
  seg.style.setProperty("--n", String(inputs.length));
  for (const input of inputs) {
    input.addEventListener("change", () => {
      if (input.checked) void commit({ [key]: input.value } as Partial<Settings>);
    });
  }
}

function renderSegmented() {
  for (const seg of document.querySelectorAll<HTMLElement>(".segmented[data-setting]")) {
    const key = seg.dataset.setting as "theme" | "motion";
    const inputs = [...seg.querySelectorAll<HTMLInputElement>("input")];
    const i = Math.max(0, inputs.findIndex((x) => x.value === settings[key]));
    inputs.forEach((x, j) => (x.checked = j === i));
    seg.style.setProperty("--i", String(i));
  }
}

// ---------- switches ----------

const switches = [...document.querySelectorAll<HTMLInputElement>("input.switch[data-setting]")];
for (const sw of switches) {
  const key = sw.dataset.setting as "groupRows" | "hideSystem";
  sw.addEventListener("change", () => void commit({ [key]: sw.checked } as Partial<Settings>));
}

// Badge groups: one switch per category, built once.
const badgeHost = $("badge-groups");
badgeHost.innerHTML = GROUPS.map(
  (g) => `<label class="row">
    <span class="row-label"><span class="label">${esc(g.label)}</span><span class="sub">${esc(g.hint)}</span></span>
    <input class="switch" type="checkbox" role="switch" data-group="${g.id}" />
  </label>`,
).join("");
const badgeSwitches = [...badgeHost.querySelectorAll<HTMLInputElement>("input[data-group]")];
for (const sw of badgeSwitches) {
  sw.addEventListener("change", () => {
    void commit({ badgeGroups: toggleGroup(settings.badgeGroups, sw.dataset.group as Settings["badgeGroups"][number], sw.checked) });
  });
}

function renderSwitches() {
  for (const sw of switches) sw.checked = Boolean(settings[sw.dataset.setting as "groupRows" | "hideSystem"]);
  for (const sw of badgeSwitches) sw.checked = settings.badgeGroups.includes(sw.dataset.group as Settings["badgeGroups"][number]);
  $("badge-note").textContent = settings.badgeGroups.length
    ? "The badge counts ports in the categories that are on."
    : "With every category off, the toolbar badge stays empty.";
}

// ---------- stepper ----------

const spin = document.querySelector<HTMLElement>(".stepper-arrows")!;
function stepBy(delta: number) {
  const next = stepIdle(settings.idleAfterHours, delta);
  if (next !== settings.idleAfterHours) void commit({ idleAfterHours: next });
}
spin.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-step]");
  if (b) stepBy(Number(b.dataset.step));
});
spin.addEventListener("keydown", (e) => {
  const map: Record<string, number> = { ArrowUp: 1, ArrowDown: -1, PageUp: 6, PageDown: -6 };
  if (e.key in map) stepBy(map[e.key]!);
  else if (e.key === "Home") stepBy(-IDLE_MAX_HOURS);
  else if (e.key === "End") stepBy(IDLE_MAX_HOURS);
  else return;
  e.preventDefault();
});

function renderStepper() {
  const h = settings.idleAfterHours;
  // The hours roll like a counter once the page is up; the first render just sets them.
  const value = $("idle-value");
  if (root.classList.contains("ready")) roll(value, formatIdle(h));
  else value.textContent = value.dataset.roll = formatIdle(h);
  spin.setAttribute("aria-valuenow", String(h));
  spin.setAttribute("aria-valuetext", formatIdle(h));
  spin.querySelector<HTMLButtonElement>('[data-step="1"]')!.disabled = h >= IDLE_MAX_HOURS;
  spin.querySelector<HTMLButtonElement>('[data-step="-1"]')!.disabled = h <= 0;
}

// ---------- pop-up buttons ----------

const refreshSel = $<HTMLSelectElement>("refresh");
const editorSel = $<HTMLSelectElement>("editor");
editorSel.innerHTML = EDITORS.map((e) => `<option value="${e.id}">${esc(e.label)}</option>`).join("");
refreshSel.addEventListener("change", () => void commit({ refreshMs: Number(refreshSel.value) }));
editorSel.addEventListener("change", () => void commit({ editor: editorSel.value as Settings["editor"] }));

function renderSelects() {
  const opts = refreshOptions(settings.refreshMs);
  const html = opts.map((ms) => `<option value="${ms}">${formatRefresh(ms)}</option>`).join("");
  if (refreshSel.dataset.html !== html) {
    refreshSel.innerHTML = html;
    refreshSel.dataset.html = html;
  }
  refreshSel.value = String(settings.refreshMs);
  editorSel.value = settings.editor;
}

// ---------- preferred port ----------

const preferred = $<HTMLInputElement>("preferred");
const preferredError = $("preferred-error");
let preferredTimer: ReturnType<typeof setTimeout> | undefined;

function checkPreferred(saveNow: boolean) {
  const r = parsePreferredPort(preferred.value);
  clearTimeout(preferredTimer);
  preferredTimer = undefined;
  if (!r.ok) {
    // Only nag once someone has stopped typing or left the field.
    if (saveNow) setFieldError(preferred, preferredError, r.reason);
    return;
  }
  setFieldError(preferred, preferredError, null);
  if (r.port === settings.preferredPort) return;
  if (saveNow) void commit({ preferredPort: r.port });
  else preferredTimer = setTimeout(() => checkPreferred(true), 600);
}
// Typed but still waiting for the debounce: commit it now, the same as Enter or blur would.
pendingInput.push(() => {
  if (preferredTimer !== undefined) checkPreferred(true);
});
preferred.addEventListener("input", () => {
  preferred.value = preferred.value.replace(/\D+/g, "");
  if (preferred.getAttribute("aria-invalid") === "true") setFieldError(preferred, preferredError, null);
  checkPreferred(false);
});
preferred.addEventListener("blur", () => {
  checkPreferred(true);
  if (preferred.getAttribute("aria-invalid") !== "true") preferred.value = String(settings.preferredPort);
});
preferred.addEventListener("keydown", (e) => {
  if (e.key === "Enter") checkPreferred(true);
  if (e.key === "Escape") {
    preferred.value = String(settings.preferredPort);
    setFieldError(preferred, preferredError, null);
    preferred.blur();
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    const n = Math.min(65535, Math.max(1, settings.preferredPort + (e.key === "ArrowUp" ? 1 : -1)));
    clearTimeout(preferredTimer);
    preferredTimer = undefined;
    preferred.value = String(n);
    setFieldError(preferred, preferredError, null);
    if (n !== settings.preferredPort) void commit({ preferredPort: n });
  }
});

function renderPreferred() {
  if (document.activeElement !== preferred) preferred.value = String(settings.preferredPort);
}

function setFieldError(field: HTMLElement, msg: HTMLElement, text: string | null) {
  field.toggleAttribute("aria-invalid", Boolean(text));
  if (text) field.setAttribute("aria-invalid", "true");
  msg.hidden = !text;
  msg.textContent = text ?? "";
}

// ---------- token fields (port lists) ----------

type PortKey = "hiddenPorts" | "extraProbePorts";
const tokenFields = [...document.querySelectorAll<HTMLElement>(".tokens[data-setting]")].map((box) => {
  const key = box.dataset.setting as PortKey;
  const input = box.querySelector("input")!;
  const list = box.querySelector("ul")!;
  const error = $(input.getAttribute("aria-describedby")!.split(" ")[1]!);
  return { key, box, input, list, error };
});

for (const f of tokenFields) {
  const accept = (): boolean => {
    const { ports, invalid } = parsePorts(f.input.value);
    if (ports.length) {
      const before = settings[f.key];
      const next = mergePorts(before, ports);
      if (next.join() !== before.join()) {
        void commit({ [f.key]: next } as Partial<Settings>);
        const added = next.filter((p) => !before.includes(p));
        flashTokens(f.list, added);
      }
    }
    if (invalid.length) {
      // Keep only what was wrong in the field so it can be fixed in place.
      f.input.value = invalid.map((i) => i.token).join(" ");
      setFieldError(f.box, f.error, `“${invalid[0]!.token}”: ${invalid[0]!.reason}.`);
      f.box.classList.remove("shake");
      void f.box.offsetWidth;
      f.box.classList.add("shake");
      return false;
    }
    f.input.value = "";
    setFieldError(f.box, f.error, null);
    return true;
  };
  f.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "," || (e.key === " " && /^\d+$/.test(f.input.value.trim()))) {
      if (!f.input.value.trim()) return;
      e.preventDefault();
      accept();
    } else if (e.key === "Backspace" && !f.input.value) {
      const last = settings[f.key].at(-1);
      if (last !== undefined) {
        e.preventDefault();
        void commit({ [f.key]: removePort(settings[f.key], last) } as Partial<Settings>);
        announce(`Removed ${last}`);
      }
    } else if (e.key === "Escape") {
      f.input.value = "";
      setFieldError(f.box, f.error, null);
    }
  });
  // Backspace or Delete on a focused ×, as in a macOS token field.
  f.list.addEventListener("keydown", (e) => {
    const rm = (e.target as HTMLElement).closest<HTMLElement>("[data-remove]");
    if (!rm || (e.key !== "Backspace" && e.key !== "Delete")) return;
    e.preventDefault();
    removeToken(f, Number(rm.dataset.remove), true);
  });
  f.input.addEventListener("input", () => {
    if (f.box.getAttribute("aria-invalid") === "true") setFieldError(f.box, f.error, null);
  });
  f.input.addEventListener("blur", () => {
    if (f.input.value.trim()) accept();
  });
  // Ports typed but not yet confirmed are saved on blur; do the same when the tab goes away.
  pendingInput.push(() => {
    if (f.input.value.trim()) accept();
  });
  f.input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!/[\s,;]/.test(text.trim())) return;
    e.preventDefault();
    f.input.value = `${f.input.value} ${text}`.trim();
    accept();
  });
  f.box.addEventListener("click", (e) => {
    const rm = (e.target as HTMLElement).closest<HTMLElement>("[data-remove]");
    if (rm) {
      removeToken(f, Number(rm.dataset.remove), e.detail === 0);
      return;
    }
    if (e.target === f.box || e.target === f.list) f.input.focus();
  });
}

type TokenField = (typeof tokenFields)[number];

/** Remove one port. From the keyboard, focus lands on the neighbouring ×, else the input. */
function removeToken(f: TokenField, port: number, keyboard: boolean) {
  const list = settings[f.key];
  const i = list.indexOf(port);
  const neighbour = list[i + 1] ?? list[i - 1];
  void commit({ [f.key]: removePort(list, port) } as Partial<Settings>);
  announce(`Removed ${port}`);
  const next = keyboard && neighbour !== undefined ? f.list.querySelector<HTMLElement>(`[data-remove="${neighbour}"]`) : null;
  (next ?? f.input).focus();
}

function renderTokens() {
  for (const f of tokenFields) {
    const ports = settings[f.key];
    const html = ports
      .map(
        (p) =>
          `<li class="token" data-port="${p}"><span>${p}</span><button type="button" class="token-x" data-remove="${p}" aria-label="Remove ${p}"><svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.75 1.75l4.5 4.5M6.25 1.75l-4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></li>`,
      )
      .join("");
    if (f.list.dataset.html !== html) {
      f.list.innerHTML = html;
      f.list.dataset.html = html;
    }
    f.input.placeholder = ports.length ? "Add" : "Add port, e.g. 3000 or 8000-8010";
  }
}

function flashTokens(list: HTMLElement, ports: number[]) {
  requestAnimationFrame(() => {
    for (const p of ports) list.querySelector(`[data-port="${p}"]`)?.classList.add("new");
  });
}

// ---------- hidden apps ----------

const appsList = $("hidden-apps");
const appsForm = $<HTMLFormElement>("hidden-apps-form");
const appsInput = $<HTMLInputElement>("hidden-apps-input");
const appsAdd = $<HTMLButtonElement>("hidden-apps-add");

appsInput.addEventListener("input", () => {
  const v = appsInput.value.trim().toLowerCase();
  appsAdd.disabled = !v || settings.hiddenProcesses.some((p) => p.toLowerCase() === v);
});
appsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const next = addProcess(settings.hiddenProcesses, appsInput.value);
  if (next.length !== settings.hiddenProcesses.length) {
    void commit({ hiddenProcesses: next });
    announce(`Hid ${next.at(-1)}`);
  }
  appsInput.value = "";
  appsAdd.disabled = true;
});
appsList.addEventListener("click", (e) => {
  const rm = (e.target as HTMLElement).closest<HTMLElement>("[data-remove]");
  if (!rm) return;
  const name = rm.dataset.remove!;
  const li = rm.closest("li")!;
  const sibling = (li.nextElementSibling ?? li.previousElementSibling)?.querySelector<HTMLElement>("[data-remove]");
  void commit({ hiddenProcesses: removeProcess(settings.hiddenProcesses, name) });
  announce(`${name} is visible again`);
  (sibling ?? appsInput).focus();
});

function renderApps() {
  const names = settings.hiddenProcesses;
  const html = names.length
    ? names
        .map(
          (n) =>
            `<li class="item"><span class="item-name">${esc(n)}</span><button type="button" class="icon-btn remove" data-remove="${esc(n)}" aria-label="Show ${esc(n)} again" title="Remove">${minusGlyph}</button></li>`,
        )
        .join("")
    : `<li class="item empty">No hidden apps</li>`;
  if (appsList.dataset.html !== html) {
    appsList.innerHTML = html;
    appsList.dataset.html = html;
  }
}
const minusGlyph = `<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.75" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 10h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// ---------- reset ----------

const resetGroup = $("reset");
const resetAsk = $<HTMLButtonElement>("reset-ask");
const setResetOpen = (open: boolean) => {
  resetGroup.dataset.state = open ? "confirming" : "idle";
  resetAsk.setAttribute("aria-expanded", String(open));
  $("reset-confirm").inert = !open;
  if (open) $("reset-cancel").focus();
};
setResetOpen(false);
resetAsk.addEventListener("click", () => setResetOpen(true));
$("reset-cancel").addEventListener("click", () => {
  setResetOpen(false);
  resetAsk.focus();
});
$("reset-confirm").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setResetOpen(false);
    resetAsk.focus();
  }
});
$("reset-do").addEventListener("click", async () => {
  setResetOpen(false);
  for (const f of tokenFields) setFieldError(f.box, f.error, null);
  setFieldError(preferred, preferredError, null);
  await commit({ ...DEFAULT_SETTINGS });
  resetAsk.focus();
  announce("All settings are back to their defaults");
});

// ---------- helper status ----------

const host = new HostClient(chromeTransport, 5000);

async function checkHost() {
  const box = $("helper");
  const text = $("helper-text");
  const recheck = $<HTMLButtonElement>("recheck");
  box.dataset.state = "checking";
  text.textContent = "Checking…";
  recheck.disabled = true;
  try {
    const pong = await host.ping();
    box.dataset.state = "connected";
    text.textContent = "Connected";
    heartbeat(box.querySelector(".status-dot")!, 0);
    $("helper-sub").textContent = `Version ${pong.hostVersion} on ${platformName(pong.platform)}.`;
    $("helper-install").hidden = true;
  } catch (e) {
    const kind = e instanceof HostConnectionError ? e.kind : "unavailable";
    const missing = kind === "missing" || kind === "forbidden";
    box.dataset.state = missing ? "missing" : "error";
    text.textContent = kind === "missing" ? "Not installed" : kind === "forbidden" ? "Needs reinstall" : "Not responding";
    $("helper-sub").textContent = `Reads ports and processes on ${thisDevice(os)}.`;
    $("helper-install").hidden = false;
    helperFailure = kind;
    $("install-text").textContent =
      kind === "forbidden"
        ? "The helper is installed for a different extension ID. Run the installer again to allow this one:"
        : kind === "missing"
          ? "Run this once in a terminal, then check again. No restart needed."
          : "The helper didn’t answer. Running the installer again usually fixes it:";
    renderInstall();
  } finally {
    recheck.disabled = false;
  }
}

function extensionId(): string {
  return (typeof chrome !== "undefined" && chrome.runtime?.id) || "<extension-id>";
}

// Same commands as the popup's install sheet (lib/platform.ts).
let helperFailure = "missing";
let installMethod: InstallMethod = "npm";
try {
  if (localStorage.getItem("portlight.installMethod") === "brew") installMethod = "brew";
} catch {
  /* npm */
}

function renderInstall() {
  const plan = installPlan(extensionId(), os, { forbidden: helperFailure === "forbidden" });
  const seg = $("install-method");
  seg.hidden = plan.choices.length < 2;
  const choice = plan.choices.find((c) => c.method === installMethod) ?? plan.choices[0]!;
  const inputs = [...seg.querySelectorAll<HTMLInputElement>("input")];
  inputs.forEach((x) => (x.checked = x.value === choice.method));
  seg.style.setProperty("--i", String(Math.max(0, inputs.findIndex((x) => x.checked))));
  $("install-cmd").textContent = choice.command;
  const hint = $("install-hint");
  if (plan.nodeSetup) {
    hint.innerHTML = `Needs Node.js 18 or later. Don’t have it? Run <code>${esc(plan.nodeSetup)}</code> first.`;
  } else if (choice.method === "npm") {
    hint.innerHTML = `Needs Node.js 18 or later, from <a href="${NODE_URL}" target="_blank" rel="noopener">nodejs.org</a>.`;
  } else {
    hint.textContent = "Homebrew installs the helper, then it connects itself to Chrome.";
  }
  if (plan.devCommand) hint.insertAdjacentHTML("beforeend", ` From a clone of the repo, <code>${esc(plan.devCommand)}</code> does the same.`);
}

$("install-method").addEventListener("change", (e) => {
  installMethod = (e.target as HTMLInputElement).value as InstallMethod;
  try {
    localStorage.setItem("portlight.installMethod", installMethod);
  } catch {
    /* this page only */
  }
  renderInstall();
});

$("recheck").addEventListener("click", () => void checkHost());
$("copy-install").addEventListener("click", async () => {
  const btn = $("copy-install");
  const text = $("install-cmd").textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  btn.classList.add("done");
  btn.innerHTML = icon.check(14);
  announce("Copied");
  setTimeout(() => {
    btn.classList.remove("done");
    btn.innerHTML = icon.copy(14);
  }, 1400);
});

// ---------- render ----------

function render() {
  applyLook();
  renderSegmented();
  renderSwitches();
  renderStepper();
  renderSelects();
  renderPreferred();
  renderTokens();
  renderApps();
}

// Toolbar hairline once the page scrolls under it.
const toolbar = $("toolbar");
const onScroll = () => toolbar.classList.toggle("scrolled", window.scrollY > 4);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

async function start() {
  try {
    settings = await loadSettings();
  } catch (e) {
    console.warn("Portlight: could not load settings", e);
  }
  render();
  $("page").setAttribute("aria-busy", "false");
  // Turn transitions on only after the first paint, so nothing animates into place.
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("ready")));
  onSettingsChanged((s) => {
    const snap = snapshot(s);
    const recent = ownWrites.filter((w) => Date.now() - w.at < ECHO_MS);
    const stale = recent.some((w) => w.snap === snap) && recent.at(-1)?.snap !== snap;
    if (stale) return; // a late echo of an older save of ours
    adopt(s);
  });
  void checkHost();
}

void start();
