import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordAppUsageReading, recordCallLatencyReading, recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments, sweepBlockedAt } from "@/lib/polling/comment-reconciler";
import { attachPendingNextReels } from "@/lib/automation/attach-next-reel";
import os from "node:os";
import { onAppUsage, onCallLatency } from "@/lib/meta/app-usage";

const worker = createDMWorker();

// Share the quota meter with the web app's Diagnostics page.
onAppUsage((usage) => void recordAppUsageReading(usage).catch(() => {}));
onCallLatency((kind, ms) => void recordCallLatencyReading(kind, ms).catch(() => {}));
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    const attached = await attachPendingNextReels();
    if (attached.bound > 0 || attached.failedAccounts > 0) {
      console.log("[DM Worker] Next-reel attachment:", attached);
    }
    // No or stale reading is allowed: the sweep's first read refreshes the meter
    // and the reconciler stops itself once usage is high.
    const blockedAt = sweepBlockedAt();
    if (blockedAt != null) {
      console.log(`[DM Worker] Skipping comment sweep: Meta app usage at ${blockedAt}%`);
      return;
    }
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
