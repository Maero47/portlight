// Portlight's motion language, shared by the popup and the options page.
//
// One spring model everywhere: Apple's damping ratio + response, sampled into CSS `linear()`.
// The CSS tokens (--spring, --spring-pop in the stylesheets) are the same curves, written out.
// Everything here animates transform and opacity only, starts from what is on screen right now
// (so it can be interrupted), and does nothing when motion is reduced.

/** Step response of a spring with damping ratio `zeta` and `response` seconds, as a CSS linear() easing. */
export function springEasing(zeta: number, response: number, durationMs: number, points = 24): string {
  const w0 = (2 * Math.PI) / response;
  const out: string[] = [];
  for (let i = 0; i < points; i++) {
    const t = ((durationMs / 1000) * i) / (points - 1);
    let x: number;
    if (zeta >= 1) x = 1 - (1 + w0 * t) * Math.exp(-w0 * t);
    else {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      x = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    }
    out.push(i === points - 1 ? "1" : x.toFixed(3));
  }
  return `linear(${out.join(", ")})`;
}

export interface Spring {
  easing: string;
  duration: number;
}

/** Critically damped, response 0.35 s: rows moving, panels, entrances. Same curve as CSS --spring. */
export const SETTLE: Spring = { easing: springEasing(1, 0.35, 420), duration: 420 };
/** Critically damped, response 0.25 s: menus, small things that should feel immediate. */
export const QUICK: Spring = { easing: springEasing(1, 0.25, 300), duration: 300 };
/** Damping 0.72, response 0.38 s (≈4 % overshoot): only for completions — a copy check, a badge appearing. */
export const POP: Spring = { easing: springEasing(0.72, 0.38, 560, 29), duration: 560 };
/** Exits are quicker than entrances and never bounce. */
export const EXIT = { easing: "cubic-bezier(0.32, 0.72, 0, 1)", duration: 180 };

let reduced = () => false;

/** Who decides whether motion is reduced (settings.motion + prefers-reduced-motion). */
export function setReducedMotion(fn: () => boolean) {
  reduced = fn;
}

export function motionReduced(): boolean {
  return reduced();
}

/** Element.animate that respects reduced motion and never throws (e.g. on a detached node). */
export function play(el: Element, keyframes: Keyframe[], opts: KeyframeAnimationOptions): Animation | null {
  if (reduced()) return null;
  try {
    return el.animate(keyframes, opts);
  } catch {
    return null;
  }
}

/** Cancel this element's animations with the given id. */
export function cancel(el: Element, id: string) {
  for (const a of el.getAnimations()) if (a.id === id) a.cancel();
}

// ---------- FLIP ----------

/** Where each element is on screen right now, mid-animation included (the "presentation" value). */
export function measure(els: Iterable<HTMLElement>): Map<HTMLElement, number> {
  const m = new Map<HTMLElement, number>();
  for (const el of els) m.set(el, el.getBoundingClientRect().top);
  return m;
}

/**
 * Slide elements from where they were (`before`) to where layout now puts them. Any slide still
 * running is replaced from its current position, so a second change mid-flight never jumps.
 */
export function flip(before: Map<HTMLElement, number>, spring: Spring = SETTLE) {
  if (reduced()) return;
  // Read every new position first, then start the animations: one layout, no thrash.
  const moves: [HTMLElement, number][] = [];
  for (const [el] of before) cancel(el, "flip");
  for (const [el, top] of before) {
    if (!el.isConnected) continue;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) >= 0.5) moves.push([el, dy]);
  }
  for (const [el, dy] of moves) {
    const a = play(el, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], { ...spring, composite: "add" });
    if (a) a.id = "flip";
  }
}

// ---------- rolling digits ----------

/**
 * Set `text`, rolling the digits that changed like an odometer: up when the number grows,
 * down when it shrinks. The outgoing digit is drawn by CSS from data-old, so textContent is
 * always just the new text (screen readers and tests see one value).
 */
export function roll(el: HTMLElement, text: string) {
  const prev = el.dataset.roll ?? el.textContent ?? "";
  if (prev === text && el.textContent === text) return;
  el.dataset.roll = text;
  const digits = (s: string) => s.replace(/\D/g, "");
  const animate = !reduced() && el.isConnected && prev.length > 0 && /\d/.test(prev) && /\d/.test(text) && prev.length === text.length;
  if (!animate) {
    el.textContent = text;
    // A change of kind ("—" → "3001", "59m" → "1h 00m"): a quick cross-fade instead of a jump.
    if (prev && prev !== text) play(el, [{ opacity: 0.25 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    return;
  }
  const up = Number(digits(text)) >= Number(digits(prev));
  el.textContent = "";
  const anims: Animation[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const old = prev[i]!;
    if (ch === old || !/\d/.test(ch + old)) {
      el.append(ch);
      continue;
    }
    const slot = document.createElement("span");
    slot.className = "dg";
    const inner = document.createElement("span");
    inner.className = up ? "dg-in up" : "dg-in down";
    inner.dataset.old = old;
    inner.textContent = ch;
    slot.append(inner);
    el.append(slot);
    // Lower digits move a touch later, like a real counter turning over.
    const a = play(inner, [{ transform: `translateY(${up ? 100 : -100}%)` }, { transform: "none" }], {
      ...SETTLE,
      delay: (text.length - 1 - i) * 18,
      fill: "backwards",
    });
    if (a) anims.push(a);
  }
  void Promise.allSettled(anims.map((a) => a.finished)).then(() => {
    if (el.dataset.roll === text) el.textContent = text;
  });
}

// ---------- small helpers ----------

/** A badge or glyph arriving: scale up from 0.8 with a little life. */
export function popIn(el: Element, from = 0.8) {
  play(el, [{ opacity: 0, transform: `scale(${from})` }, { opacity: 1, transform: "none" }], { ...POP, fill: "backwards" });
}

/** Fade + slide an element in from `dy` px. */
export function riseIn(el: Element, dy = 6, delay = 0) {
  play(el, [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: "none" }], { ...SETTLE, delay, fill: "backwards" });
}

/** A short, decaying horizontal shake for errors. */
export function shake(el: Element) {
  play(
    el,
    [
      { transform: "none" },
      { transform: "translateX(-4px)", offset: 0.18 },
      { transform: "translateX(3px)", offset: 0.42 },
      { transform: "translateX(-1.5px)", offset: 0.68 },
      { transform: "none" },
    ],
    { duration: 380, easing: "ease-out" },
  );
}

/**
 * A status dot's heartbeat: one soft ring breathes out of `dot` (its ::after). Called when fresh
 * data actually arrives, at most every `minGapMs`, so the pulse means "this is live" and nothing
 * runs (or costs anything) between beats.
 */
export function heartbeat(dot: Element, minGapMs = 5800) {
  const now = performance.now();
  const last = Number((dot as HTMLElement).dataset.beat ?? -Infinity);
  if (document.hidden || now - last < minGapMs) return;
  const a = play(dot, [{ opacity: 0.5, transform: "scale(1)" }, { opacity: 0, transform: "scale(3.2)" }], {
    duration: 1500,
    easing: "cubic-bezier(0.2, 0.6, 0.35, 1)",
    pseudoElement: "::after",
  });
  if (a) {
    a.id = "beat";
    (dot as HTMLElement).dataset.beat = String(now);
  }
}

/** Pause CSS loops while the page is hidden; they cost nothing then. */
export function sleepWhenHidden(root: HTMLElement = document.documentElement) {
  const sync = () => root.classList.toggle("asleep", document.hidden);
  document.addEventListener("visibilitychange", sync);
  sync();
}
