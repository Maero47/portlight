import { test, type Page } from "@playwright/test";
import { openPopup } from "../e2e/harness.ts";

/** Records every rAF timestamp and every long task / long animation frame from the first script on. */
async function recordFrames(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__frames = [] as number[];
    w.__long = [] as { type: string; start: number; dur: number }[];
    const tick = (t: number) => {
      w.__frames.push(t);
      // Stopped for the idle window: a rAF loop would itself make the page draw every frame.
      if (!w.__stopFrames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    for (const type of ["longtask", "long-animation-frame"]) {
      try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push({ type, start: e.startTime, dur: e.duration }))).observe({
          type,
          buffered: true,
        });
      } catch {
        /* not supported */
      }
    }
  });
}

async function frameStats(page: Page, from: number, to: number) {
  return page.evaluate(
    ({ from, to }) => {
      const w = window as any;
      const f = (w.__frames as number[]).filter((t) => t >= from && t <= to);
      const d = f.slice(1).map((t, i) => t - f[i]!);
      const sorted = [...d].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const longest = sorted.at(-1) ?? 0;
      const dropped = d.filter((x) => x > median * 1.5).length;
      const long = (w.__long as any[]).filter((e) => e.start >= from && e.start <= to);
      return { frames: f.length, medianMs: +median.toFixed(2), longestMs: +longest.toFixed(1), dropped, longTasks: long.filter((e) => e.type === "longtask").length, longAnimationFrames: long.filter((e) => e.type === "long-animation-frame").length };
    },
    { from, to },
  );
}

async function cpuMs(page: Page) {
  const browserCdp = await page.context().browser()!.newBrowserCDPSession();
  const { processInfo } = (await browserCdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; cpuTime: number }[] };
  await browserCdp.detach();
  const byType: Record<string, number> = {};
  for (const p of processInfo) byType[p.type] = (byType[p.type] ?? 0) + p.cpuTime * 1000;
  return byType;
}

for (const motion of ["no-preference", "reduce"] as const) {
  test(`motion numbers (${motion})`, async ({ page }) => {
    await recordFrames(page);
    const t0 = Date.now();
    await openPopup(page, { reducedMotion: motion, settings: { refreshMs: 2000 } });
    await page.locator("li.row").first().waitFor();
    await page.waitForTimeout(1500);
    const open = await frameStats(page, 0, 1e9);

    // Refresh with rows changing: two servers stop, one starts.
    const mark = await page.evaluate(() => performance.now());
    await page.evaluate(() =>
      (window as any).__mutate((l: any[]) => [
        ...l.filter((x) => x.port !== 5173 && x.port !== 6379),
        { ...l[0], port: 4321, pid: 61000, process: "node", cwd: "/Users/mali/code/blog", command: "node astro dev", startedAt: new Date().toISOString() },
      ]),
    );
    await page.waitForTimeout(2800);
    const refresh = await frameStats(page, mark, mark + 2800);

    // Idle: the popup open and doing nothing for 10 s (the 2 s refresh keeps running, as in real use).
    await page.mouse.move(0, 0);
    await page.evaluate(() => ((window as any).__stopFrames = true));
    await page.waitForTimeout(1000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const m = async () => Object.fromEntries(((await cdp.send("Performance.getMetrics")).metrics as { name: string; value: number }[]).map((x) => [x.name, x.value]));
    const before = await m();
    const cpu0 = await cpuMs(page);
    await page.waitForTimeout(10_000);
    const after = await m();
    const cpu1 = await cpuMs(page);
    const cpu = Object.fromEntries(Object.keys(cpu1).map((k) => [k, Math.round((cpu1[k] ?? 0) - (cpu0[k] ?? 0))]));
    const idle = {
      mainThreadTaskMs: Math.round(((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000),
      scriptMs: Math.round(((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000),
      layoutMs: Math.round(((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000),
      recalcStyleMs: Math.round(((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) * 1000),
      layouts: (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0),
      processCpuMs: cpu,
    };
    console.log(JSON.stringify({ motion, open, refresh, idle, wallMs: Date.now() - t0 }, null, 1));
  });
}
