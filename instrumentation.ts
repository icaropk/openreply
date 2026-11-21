export async function register() {
  // The worker registers its own listeners; this covers web and cron calls, which share Meta's budget.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { onAppUsage, onCallLatency } = await import("@/lib/meta/app-usage");
  const { recordAppUsageReading, recordCallLatencyReading } = await import("@/lib/ops/worker-health");
  onAppUsage((u) => void recordAppUsageReading(u).catch(() => {}));
  onCallLatency((k, ms) => void recordCallLatencyReading(k, ms).catch(() => {}));
}
