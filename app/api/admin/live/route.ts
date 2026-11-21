import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { getAppUsageReading, getCallLatency } from "@/lib/ops/worker-health";

export const runtime = "nodejs";

// Live view for Diagnostics: the quota meter, the whole queue and the last
// hour's sends. Polled every few seconds, so it reads only this workspace's
// last hour and never calls Meta.
export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const since = new Date(Date.now() - 3600e3);

  const [usage, queue, latency, accounts, automations, logs, events, completed, waitingJobs, queuedJobs] = await Promise.all([
    getAppUsageReading(),
    getDMQueue().getJobCounts("waiting", "prioritized", "active", "delayed", "failed"),
    getCallLatency(),
    prisma.instagramAccount.findMany({ where: { workspaceId }, select: { id: true, username: true } }),
    prisma.automation.findMany({ where: { workspaceId }, select: { id: true, name: true, postId: true } }),
    prisma.dmLog.groupBy({
      by: ["instagramAccountId", "automationId", "status"],
      where: { workspaceId, updatedAt: { gte: since } },
      _count: true,
    }),
    // Only this workspace's posts are counted below, but don't load other
    // workspaces' payloads at all; direct Meta events may carry no workspace.
    prisma.webhookEvent.findMany({
      where: { createdAt: { gte: since }, OR: [{ workspaceId }, { workspaceId: null }] },
      select: { payload: true },
      take: 5000,
    }),
    // BullMQ keeps the last 1000 finished jobs with their enqueue and finish
    // times: comment arrival to DM, without any extra bookkeeping.
    getDMQueue().getJobs(["completed"], 0, 400),
    getDMQueue().getJobs(["waiting"], 0, 0, true),
    // shortcut: at most 500 of each state, so inflow undercounts past that; page through if it ever binds.
    getDMQueue().getJobs(["waiting", "prioritized"], 0, 499),
  ]);

  const accountName = new Map(accounts.map((a) => [a.id, a.username]));
  const automationName = new Map(automations.map((a) => [a.id, a.name]));
  const postName = new Map<string, string>();
  for (const a of automations) if (a.postId && !postName.has(a.postId)) postName.set(a.postId, a.name);

  const byAccount: Record<string, Record<string, number>> = {};
  const sentByCampaign: Record<string, number> = {};
  for (const row of logs) {
    const account = accountName.get(row.instagramAccountId) ?? "?";
    const statuses = (byAccount[account] ??= {});
    statuses[row.status] = (statuses[row.status] ?? 0) + row._count;
    if (row.status === "SENT") {
      const name = automationName.get(row.automationId) ?? "?";
      sentByCampaign[name] = (sentByCampaign[name] ?? 0) + row._count;
    }
  }

  // Comment webhooks name the media they were left on.
  const commentsByPost: Record<string, number> = {};
  for (const event of events) {
    const entries = (event.payload as { entry?: Array<{ changes?: Array<{ value?: { media?: { id?: string } } }> }> })?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const mediaId = change.value?.media?.id;
        if (!mediaId || !postName.has(mediaId)) continue;
        const name = postName.get(mediaId)!;
        commentsByPost[name] = (commentsByPost[name] ?? 0) + 1;
      }
    }
  }

  const top = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }));

  // Time a webhook comment job waited, from enqueue to finish, over the last 30 min (sweeps and rate-limit requeues wait on purpose).
  const cutoff = Date.now() - 30 * 60e3;
  const waits = completed
    .filter(
      (j) =>
        j?.name === "process-comment" &&
        (j.data as { source?: string })?.source === "WEBHOOK" &&
        !j.opts.delay &&
        j.finishedOn &&
        j.finishedOn >= cutoff
    )
    .map((j) => (j.finishedOn! - j.timestamp) / 60e3)
    .sort((a, b) => a - b);
  const pick = (q: number) => (waits.length ? Math.round(waits[Math.min(waits.length - 1, Math.floor(q * waits.length))] * 10) / 10 : null);
  const oldestWaiting = waitingJobs[0] ? Math.round((Date.now() - waitingJobs[0].timestamp) / 6e3) / 10 : null;

  // Drain in jobs, not DMs: the queue holds jobs, and many finish without a send (dedup, no keyword).
  const hourAgo = since.getTime();
  const outPerHour = completed.filter((j) => j?.name === "process-comment" && (j.finishedOn ?? 0) >= hourAgo).length;
  const inPerHour = [...completed, ...queuedJobs].filter((j) => j?.name === "process-comment" && j.timestamp >= hourAgo).length;

  let meters: { calls: number; cpu: number; time: number } | null = null;
  if (usage) {
    try {
      const raw = JSON.parse(usage.raw) as Record<string, number>;
      meters = { calls: raw.call_count ?? 0, cpu: raw.total_cputime ?? 0, time: raw.total_time ?? 0 };
    } catch {}
  }

  return NextResponse.json({
    success: true,
    data: {
      at: new Date().toISOString(),
      usage: usage ? { pct: usage.pct, at: usage.at, meters } : null,
      queue,
      byAccount,
      sentByCampaign: top(sentByCampaign),
      commentsByPost: top(commentsByPost),
      latency,
      dmWait: { samples: waits.length, medianMin: pick(0.5), p90Min: pick(0.9), oldestWaitingMin: oldestWaiting },
      drain: { inPerHour, outPerHour },
    },
  });
}
