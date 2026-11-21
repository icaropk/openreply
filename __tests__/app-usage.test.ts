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

  it("slows down as the hour fills and retries each minute past the limit", () => {
    expect(delayForUsage(undefined)).toBe(4_000);
    expect(delayForUsage(59)).toBe(4_000);
    expect(delayForUsage(70)).toBe(30_000);
    expect(delayForUsage(90)).toBe(70_000);
    expect(delayForUsage(98)).toBe(60_000);
    expect(delayForUsage(177)).toBe(60_000);
  });
});
