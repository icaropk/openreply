import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';

const { usage, createInstagramContext } = vi.hoisted(() => ({
  usage: vi.fn(),
  createInstagramContext: vi.fn(async () => 'token'),
}));
vi.mock('@/lib/auth', () => ({ getCurrentWorkspaceId: async () => 'ws' }));
vi.mock('@/lib/instagram-accounts', () => ({
  getWorkspaceInstagramAccount: async () => ({ id: 'acc', instagramId: 'ig', username: 'me' }),
}));
vi.mock('@/lib/ops/worker-health', () => ({ getAppUsageReading: () => usage() }));
vi.mock('@/lib/instagram/provider', () => ({
  createInstagramContext,
  getConversations: async () => [],
  getConversationMessages: async () => [],
  sendDirectMessage: vi.fn(),
  MetaApiError: class extends Error {},
}));
import { GET as listGET } from '@/app/api/instagram/conversations/route';
import { GET as threadGET } from '@/app/api/instagram/conversations/[id]/route';

const req = () => new NextRequest('http://x/api/instagram/conversations?instagramAccountId=acc');
const calls = [
  () => listGET(req()),
  () => threadGET(req(), { params: Promise.resolve({ id: 'c1' }) }),
];

beforeEach(() => {
  usage.mockReset();
  createInstagramContext.mockClear();
});

it('returns 503 without touching Meta when app usage is at 90%', async () => {
  usage.mockResolvedValue({ pct: 90 });
  for (const call of calls) {
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: 'Meta quota is busy; showing cached inbox' });
  }
  expect(createInstagramContext).not.toHaveBeenCalled();
});

it('reads Meta when usage is below 90% or unknown', async () => {
  usage.mockResolvedValueOnce({ pct: 89 }).mockResolvedValueOnce(null);
  for (const call of calls) expect((await call()).status).toBe(200);
  usage.mockRejectedValueOnce(new Error('redis down'));
  expect((await calls[0]()).status).toBe(200);
});
