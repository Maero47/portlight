import { describe, expect, it } from "vitest";
import { describeUptime, formatUptime, plural, summary } from "../../src/lib/format.ts";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe("formatUptime", () => {
  it.each([
    [2, "now"],
    [42, "42s"],
    [7 * 60 + 5, "7m"],
    [3 * 3600 + 5 * 60, "3h 05m"],
    [2 * 86400 + 4 * 3600, "2d 4h"],
    [3 * 86400, "3d"],
  ])("%ss → %s", (s, out) => expect(formatUptime(ago(s), NOW)).toBe(out));
  it("handles unknown, invalid and future times", () => {
    expect(formatUptime(null, NOW)).toBeNull();
    expect(formatUptime("nope", NOW)).toBeNull();
    expect(formatUptime(new Date(NOW + 60_000).toISOString(), NOW)).toBe("now");
  });
  it("has a spoken form", () => {
    expect(describeUptime(ago(3 * 3600 + 5 * 60), NOW)).toBe("Running for 3 hours 5 minutes");
    expect(describeUptime(ago(86400 + 3600), NOW)).toBe("Running for 1 day 1 hour");
    expect(describeUptime(ago(1), NOW)).toBe("Started just now");
    expect(describeUptime(null, NOW)).toBeNull();
  });
});

describe("summary", () => {
  it("pluralises", () => {
    expect(summary(0)).toBe("No ports in use");
    expect(summary(1)).toBe("1 port in use");
    expect(summary(12)).toBe("12 ports in use");
    expect(plural(2, "server")).toBe("2 servers");
  });
});
