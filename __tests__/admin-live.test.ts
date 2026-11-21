import { describe, expect, it, vi } from "vitest";

const now = Date.now();
const min = 60e3;
const job = (name: string, source: string | undefined, enqueuedAgo: number, finishedAgo?: number, delay?: number) => ({
  name,
  data: { source },
  opts: delay ? { delay } : {},
  timestamp: now - enqueuedAgo * min,
  finishedOn: finishedAgo == null ? undefined : now - finishedAgo * min,
});

const completed = [
  job("process-comment", "WEBHOOK", 5, 3), // waited 2 min: counted everywhere
  job("process-comment", "POLLING", 20, 10), // sweep: out/in, not a wait
  job("process-comment", "WEBHOOK", 30, 1, 60e3), // rate-limit requeue: not a wait
  job("process-postback", "WEBHOOK", 4, 2), // not a comment job
  job("process-comment", "WEBHOOK", 120, 90), // finished over an hour ago
];
const queued = [job("process-comment", "WEBHOOK", 2), job("process-comment", "POLLING", 200)];

vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: async () => "ws" }));
vi.mock("@/lib/ops/worker-health", () => ({ getAppUsageReading: async () => null, getCallLatency: async () => [] }));
vi.mock("@/lib/db/client", () => {
  const empty = { findMany: async () => [] };
  return { prisma: { instagramAccount: empty, automation: empty, webhookEvent: empty, dmLog: { groupBy: async () => [] } } };
});
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    getJobCounts: async () => ({}),
    getJobs: async (types: string[], _start: number, end: number) =>
      types[0] === "completed" ? completed : end === 0 ? queued.slice(0, 1) : queued,
  }),
}));

import { GET } from "../app/api/admin/live/route";

describe("admin live route", () => {
  it("counts webhook waits and drain in comment jobs", async () => {
    const { data } = await (await GET()).json();
    expect(data.dmWait.samples).toBe(1);
    expect(data.dmWait.medianMin).toBe(2);
    expect(data.drain).toEqual({ outPerHour: 3, inPerHour: 4 });
  });
});
