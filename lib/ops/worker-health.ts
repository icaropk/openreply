import { getRedisConnection } from "@/lib/queue/client";
import type { AppUsage } from "@/lib/meta/app-usage";

const WORKER_HEALTH_KEY = "health:worker:dm";
const WORKER_ALERTS_KEY = "alerts:worker:dm";
const WORKER_HEARTBEAT_TTL_SECONDS = 120;
const APP_USAGE_KEY = "meta:app-usage";
const CALL_LATENCY_KEY = "meta:latency";

export interface WorkerHeartbeat {
  status: "running";
  worker: "dm";
  pid: number;
  hostname?: string;
  startedAt?: string;
  checkedAt: string;
}

export interface WorkerHealth {
  healthy: boolean;
  heartbeat: WorkerHeartbeat | null;
  ageMs: number | null;
}

export interface WorkerAlert {
  level: "warning" | "error";
  message: string;
  jobId?: string;
  instagramAccountId?: string;
  commentId?: string;
  createdAt: string;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function recordWorkerHeartbeat(
  heartbeat: Omit<WorkerHeartbeat, "checkedAt" | "status" | "worker">
) {
  const payload: WorkerHeartbeat = {
    ...heartbeat,
    status: "running",
    worker: "dm",
    checkedAt: new Date().toISOString(),
  };

  await getRedisConnection().set(
    WORKER_HEALTH_KEY,
    JSON.stringify(payload),
    "EX",
    WORKER_HEARTBEAT_TTL_SECONDS
  );
}

export async function getWorkerHealth(): Promise<WorkerHealth> {
  const heartbeat = parseJson<WorkerHeartbeat>(
    await getRedisConnection().get(WORKER_HEALTH_KEY)
  );

  if (!heartbeat) {
    return { healthy: false, heartbeat: null, ageMs: null };
  }

  const ageMs = Date.now() - new Date(heartbeat.checkedAt).getTime();
  return {
    healthy: ageMs <= WORKER_HEARTBEAT_TTL_SECONDS * 1000,
    heartbeat,
    ageMs,
  };
}

export async function recordWorkerAlert(alert: Omit<WorkerAlert, "createdAt">) {
  const payload: WorkerAlert = {
    ...alert,
    createdAt: new Date().toISOString(),
  };

  const redis = getRedisConnection();
  await redis.lpush(WORKER_ALERTS_KEY, JSON.stringify(payload));
  await redis.ltrim(WORKER_ALERTS_KEY, 0, 24);
}

export async function getWorkerAlerts(limit = 10): Promise<WorkerAlert[]> {
  const values = await getRedisConnection().lrange(
    WORKER_ALERTS_KEY,
    0,
    Math.max(0, limit - 1)
  );

  return values
    .map((value) => parseJson<WorkerAlert>(value))
    .filter((value): value is WorkerAlert => Boolean(value));
}

/** The worker's latest reading of Meta's app-wide quota meter. */
export async function recordAppUsageReading(usage: AppUsage) {
  await getRedisConnection().set(APP_USAGE_KEY, JSON.stringify(usage), "EX", 3600);
}

export async function getAppUsageReading(): Promise<AppUsage | null> {
  return parseJson<AppUsage>(await getRedisConnection().get(APP_USAGE_KEY));
}

/** Running count and total ms of Graph calls by kind (see callKind). */
export async function recordCallLatencyReading(kind: string, ms: number) {
  await getRedisConnection()
    .multi()
    .hincrby(CALL_LATENCY_KEY, `${kind}:n`, 1)
    .hincrby(CALL_LATENCY_KEY, `${kind}:ms`, ms)
    .expire(CALL_LATENCY_KEY, 2 * 24 * 3600)
    .exec();
}

/** Average Graph call time by kind, from recordCallLatencyReading. */
export async function getCallLatency(): Promise<
  Array<{ kind: string; calls: number; avgMs: number }>
> {
  const raw = await getRedisConnection().hgetall(CALL_LATENCY_KEY);
  const kinds = new Set(Object.keys(raw).map((k) => k.slice(0, k.lastIndexOf(":"))));
  return [...kinds]
    .map((kind) => {
      const calls = Number(raw[`${kind}:n`]) || 0;
      return { kind, calls, avgMs: calls ? Math.round(Number(raw[`${kind}:ms`]) / calls) : 0 };
    })
    .sort((a, b) => b.calls * b.avgMs - a.calls * a.avgMs);
}
