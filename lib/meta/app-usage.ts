/**
 * Meta's app-wide quota meter.
 *
 * Every Graph response carries `x-app-usage` ({call_count, total_time,
 * total_cputime}, each a % of the hourly budget). Unified login tokens all draw
 * on this one budget, and past 100% Meta answers code 4 for every account, so
 * the DM worker paces itself from the latest reading instead of a fixed rate.
 */

export interface AppUsage {
  /** Highest of the three meters, in % of the hourly budget. */
  pct: number;
  at: number;
  raw: string;
}

let latest: AppUsage | null = null;
let listener: ((usage: AppUsage) => void) | null = null;

export function recordAppUsage(header: string | null | undefined): void {
  if (!header) return;
  try {
    const u = JSON.parse(header) as Record<string, unknown>;
    const pct = Math.max(
      ...["call_count", "total_time", "total_cputime"].map((k) => Number(u[k]) || 0)
    );
    latest = { pct, at: Date.now(), raw: header };
    listener?.(latest);
  } catch {
    // A malformed header must never break the call it came with.
  }
}

export function getAppUsage(): AppUsage | null {
  return latest;
}

export function onAppUsage(fn: ((usage: AppUsage) => void) | null): void {
  listener = fn;
}

/**
 * Gap to leave before the next DM job, from the meter's last reading. Fast
 * while there is room, slower as the hour fills, and a pause near the limit
 * (the next job after it reads the meter again).
 */
export function delayForUsage(pct: number | undefined): number {
  if (pct == null || pct < 75) return 4_000; // 15/min
  if (pct < 90) return 6_000; // 10/min
  if (pct < 100) return 15_000; // 4/min
  return 5 * 60_000;
}

/** At or above this the reconciler skips its comment sweep: reads are heavy. */
export const SWEEP_SKIP_PCT = 75;
