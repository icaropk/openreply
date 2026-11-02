import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserInfo, getUserMedia, sendPrivateReply } from "../lib/meta/client";

/**
 * Unified login system-user tokens only work on graph.facebook.com and have no
 * Instagram `/me`, so META_GRAPH_HOST swaps the host and callers pass the
 * account ID instead.
 */
function stubFetch() {
  const fetchMock = vi.fn(async () => Response.json({ data: [], id: "1", username: "u" }));
  vi.stubGlobal("fetch", fetchMock);
  return () => String((fetchMock.mock.calls as unknown as [string][])[0][0]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("META_GRAPH_HOST", () => {
  it("keeps graph.instagram.com and /me by default", async () => {
    const url = stubFetch();
    await getUserMedia("t");
    expect(url()).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/me\/media\?/);
  });

  it("sends to the configured host", async () => {
    vi.stubEnv("META_GRAPH_HOST", "graph.facebook.com");
    const url = stubFetch();
    await sendPrivateReply("t", "1784", "c1", "hi");
    expect(url()).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/1784\/messages$/);
  });

  it("reads the account node, without user_id, when given its ID", async () => {
    const url = stubFetch();
    await getUserInfo("t", "1784");
    const parsed = new URL(url());
    expect(parsed.pathname).toMatch(/\/1784$/);
    expect(parsed.searchParams.get("fields")).not.toContain("user_id");
  });
});
