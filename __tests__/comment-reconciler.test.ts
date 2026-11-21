/**
 * Comment reconciliation — ad copies of a boosted post.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, queueAdd, readComments } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRaw: vi.fn(),
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  queueAdd: vi.fn(),
  readComments: vi.fn(),
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: queueAdd }),
}));
vi.mock("@/lib/instagram/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instagram/provider")>()),
  createInstagramContext: async () => ({
    provider: "META",
    accessToken: "local-test",
  }),
  getRecentMediaComments: readComments,
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  adMediaFor,
  reconcileComments,
} from "../lib/polling/comment-reconciler";
import { recordAppUsage, SWEEP_SKIP_PCT } from "@/lib/meta/app-usage";

const POST = "18023946917554990";
const AD = "17899788633163100";

describe("adMediaFor", () => {
  beforeEach(() => {
    mockPrisma.$queryRaw.mockReset();
  });

  it("returns the ad media ids seen for the post", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("never returns the post itself, so it is not swept twice", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: AD },
      { mediaId: POST },
    ]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("drops rows without a media id", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: null },
      { mediaId: AD },
    ]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("returns nothing when the post was never boosted", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });

  it("swallows a query failure, leaving the post itself still swept", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });
});

describe("comment polling does not recreate unsafe sends", () => {
  beforeEach(() => {
    queueAdd.mockReset();
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "campaign",
        name: "Campaign",
        workspaceId: "workspace",
        postId: POST,
        matchAnyWord: false,
        keywords: ["AI"],
        publicReplyEnabled: true,
        instagramAccount: {
          id: "connection",
          instagramId: "owner",
          provider: "META",
          accessToken: "test",
        },
      },
    ]);
    readComments.mockResolvedValue([
      {
        id: "old",
        text: "AI",
        from: { id: "reader" },
        timestamp: new Date().toISOString(),
      },
      {
        id: "new",
        text: "AI",
        from: { id: "another-reader" },
        timestamp: new Date().toISOString(),
      },
    ]);
  });
  it.each([
    { status: "FAILED", attempts: 1, dmDeliveryUnconfirmed: true },
    { status: "FAILED", attempts: 3, dmDeliveryUnconfirmed: false },
    {
      status: "FAILED",
      attempts: 1,
      errorMessage: "MetaApiError 1: An unknown error has occurred.",
    },
    { status: "PENDING", attempts: 1, dmDeliveryUnconfirmed: true },
  ])(
    "leaves an unsafe old comment alone while continuing new comments: %j",
    async (state) => {
      mockPrisma.dmLog.findMany.mockResolvedValue([
        { commentId: "old", publicReplySentAt: new Date(), ...state },
      ]);
      await reconcileComments();
      await reconcileComments();
      expect(queueAdd).toHaveBeenCalledTimes(2);
      for (const [, data] of queueAdd.mock.calls)
        expect(data.commentId).toBe("new");
    },
  );
});

describe("comment polling per sweep", () => {
  const campaign = (id: string, publicReplyEnabled: boolean) => ({
    id,
    name: id,
    workspaceId: "workspace",
    postId: POST,
    matchAnyWord: true,
    keywords: [],
    publicReplyEnabled,
    instagramAccount: {
      id: "connection",
      instagramId: "owner",
      provider: "META",
      accessToken: "test",
    },
  });

  beforeEach(() => {
    queueAdd.mockReset();
    readComments.mockReset();
    mockPrisma.dmLog.findMany.mockReset();
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([]);
    readComments.mockResolvedValue([
      { id: "c1", text: "hi", from: { id: "dmed" }, timestamp: new Date().toISOString() },
      { id: "c2", text: "hi", from: { id: "fresh" }, timestamp: new Date().toISOString() },
    ]);
  });

  it("skips a person this campaign already DM'd when there is no public reply", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign("a", false)]);
    mockPrisma.dmLog.findMany.mockImplementation(async ({ where }) =>
      where.commenterId ? [{ commenterId: "dmed" }] : []
    );
    await reconcileComments();
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][1].commenterId).toBe("fresh");
  });

  it("still enqueues an already-DM'd person when a public reply is due", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign("a", true)]);
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    await reconcileComments();
    expect(queueAdd).toHaveBeenCalledTimes(2);
  });

  it("reads a post's comments once for campaigns sharing it", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign("a", true),
      campaign("b", true),
    ]);
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    await reconcileComments();
    expect(readComments).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledTimes(4);
  });

  it("stops reading once app usage is high", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign("a", true)]);
    recordAppUsage(JSON.stringify({ total_time: SWEEP_SKIP_PCT }));
    try {
      await reconcileComments();
    } finally {
      recordAppUsage(JSON.stringify({ total_time: 0 }));
    }
    expect(readComments).not.toHaveBeenCalled();
  });

  it("still sweeps when the only high reading is stale", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([campaign("a", true)]);
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      recordAppUsage(JSON.stringify({ total_time: SWEEP_SKIP_PCT }));
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await reconcileComments();
    } finally {
      vi.useRealTimers();
      recordAppUsage(JSON.stringify({ total_time: 0 }));
    }
    expect(readComments).toHaveBeenCalledTimes(1);
  });
});
