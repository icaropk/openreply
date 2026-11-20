import { describe, expect, it } from "vitest";
import { delayForUsage, getAppUsage, recordAppUsage } from "../lib/meta/app-usage";

describe("Meta app usage meter", () => {
  it("keeps the highest of the three meters", () => {
    recordAppUsage('{"call_count":14,"total_cputime":0,"total_time":52}');
    expect(getAppUsage()?.pct).toBe(52);
  });

  it("ignores a missing or malformed header", () => {
    recordAppUsage('{"call_count":20}');
    recordAppUsage(null);
    recordAppUsage("not json");
    expect(getAppUsage()?.pct).toBe(20);
  });

  it("slows down as the hour fills and pauses near the limit", () => {
    expect(delayForUsage(undefined)).toBe(4_000);
    expect(delayForUsage(49)).toBe(4_000);
    expect(delayForUsage(60)).toBe(10_000);
    expect(delayForUsage(80)).toBe(30_000);
    expect(delayForUsage(90)).toBe(5 * 60_000);
    expect(delayForUsage(177)).toBe(5 * 60_000);
  });
});
