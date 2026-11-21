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
 * Gap to leave before the next DM job, from the meter's last reading. Meta's
 * budget is a rolling hour: room left unused expires, so the most DMs per hour
 * come from sending fast while there is room and, at the top, taking each slot
 * as old calls leave the window. A DM costs ~2.3s of total_time (~2%), so the
 * hour holds ~50; a code 4 refusal is cheap and requeued without spending an
 * attempt, which makes a retry each minute at the top cheaper than idling.
 */
export function delayForUsage(pct: number | undefined): number {
  if (pct == null || pct < 97) return 4_000; // 15/min
  return 60_000;
}

let latencyListener: ((kind: string, ms: number) => void) | null = null;

/** How long one Graph call took, by kind, to learn which calls fill total_time. */
export function recordCallLatency(kind: string, ms: number): void {
  latencyListener?.(kind, ms);
}

export function onCallLatency(fn: ((kind: string, ms: number) => void) | null): void {
  latencyListener = fn;
}

/** At or above this the reconciler skips its comment sweep: reads are heavy. */
export const SWEEP_SKIP_PCT = 75;
