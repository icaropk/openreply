"use client";

import { useI18n } from "@/lib/i18n/provider";
import { delayForUsage } from "@/lib/meta/app-usage";
import { useEffect, useState } from "react";

interface LiveData {
  at: string;
  usage: { pct: number; at: number; meters: { calls: number; cpu: number; time: number } | null } | null;
  queue: Record<string, number>;
  byAccount: Record<string, Record<string, number>>;
  sentByCampaign: Array<{ name: string; count: number }>;
  commentsByPost: Array<{ name: string; count: number }>;
  latency: Array<{ kind: string; calls: number; avgMs: number }>;
}

const REFRESH_MS = 15_000;

function Meter({ label, value }: { label: string; value: number }) {
  const tone = value >= 90 ? "bg-red-500" : value >= 75 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="font-semibold tabular-nums text-foreground">{value}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded bg-border" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  );
}

function List({ rows, empty }: { rows: Array<{ name: string; count: number }>; empty: string }) {
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-1 text-sm">
      {rows.map((row) => (
        <li key={row.name} className="flex justify-between gap-3">
          <span className="truncate text-foreground">{row.name}</span>
          <span className="tabular-nums text-muted">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}

/** Live quota, queue and last-hour sends; reads only this server, never Meta. */
export default function LivePanel() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<LiveData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      if (document.hidden) return;
      try {
        const payload = await (await fetch("/api/admin/live")).json();
        if (!active) return;
        if (payload.success) {
          setData(payload.data);
          setFailed(false);
        } else setFailed(true);
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (!data) {
    return (
      <section className="panel rounded p-4 sm:p-6">
        <p className="text-sm text-muted">{failed ? t("Could not load live data.") : t("Loading live data…")}</p>
      </section>
    );
  }

  const meters = data.usage?.meters;
  const recent = (data.queue.waiting ?? 0) + (data.queue.active ?? 0);
  const backlog = (data.queue.prioritized ?? 0) + (data.queue.delayed ?? 0);
  const pace = data.usage ? Math.round((60_000 / delayForUsage(data.usage.pct)) * 10) / 10 : null;
  // Drain estimate from the last hour: comments on campaign posts in (an upper
  // bound: not every comment has the keyword) and DMs sent out.
  const sentPerHour = Object.values(data.byAccount).reduce((sum, c) => sum + (c.SENT ?? 0), 0);
  const inPerHour = data.commentsByPost.reduce((sum, row) => sum + row.count, 0);
  const total = recent + backlog;
  const hoursToEmpty = sentPerHour ? total / sentPerHour : null;
  const readingAge = data.usage ? Math.round((Date.parse(data.at) - data.usage.at) / 60_000) : null;

  return (
    <section className="panel rounded p-4 sm:p-6" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">{t("Live")}</h2>
        <p className="text-xs text-muted">
          {t("Updates every 15s · last update {time}", { time: new Date(data.at).toLocaleTimeString(locale) })}
        </p>
      </div>

      <div className="mt-4 grid gap-6 md:grid-cols-3">
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase text-muted">{t("Meta quota (last hour)")}</p>
          {meters ? (
            <>
              <Meter label={t("Processing time")} value={meters.time} />
              <Meter label={t("Calls")} value={meters.calls} />
              <Meter label={t("CPU time")} value={meters.cpu} />
              <p className="text-xs text-muted">
                {t("Pace: {perMinute} DMs per minute", { perMinute: pace ?? 0 })}
                {readingAge != null && readingAge > 0 ? ` · ${t("read {minutes} min ago", { minutes: readingAge })}` : ""}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">{t("No reading yet")}</p>
          )}
        </div>

        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase text-muted">{t("Queue")}</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-2xl font-bold tabular-nums text-foreground">{recent}</p>
              <p className="text-xs text-muted">{t("Recent comments (first)")}</p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-foreground">{backlog}</p>
              <p className="text-xs text-muted">{t("Catch-up and retries")}</p>
            </div>
          </div>
          <p className="text-xs text-muted">
            {t("In ~{in}/h · out {out}/h", { in: inPerHour, out: sentPerHour })}
            {" · "}
            {total === 0
              ? t("Queue empty")
              : hoursToEmpty == null
                ? t("No sends in the last hour")
                : inPerHour > sentPerHour
                  ? t("Not emptying at this pace ({hours}h if comments stopped)", { hours: hoursToEmpty.toFixed(1) })
                  : t("Empty in about {hours}h", { hours: hoursToEmpty.toFixed(1) })}
          </p>
          <p className="text-xs font-semibold uppercase text-muted">{t("Last hour by account")}</p>
          <ul className="space-y-1 text-sm">
            {Object.entries(data.byAccount).map(([account, counts]) => (
              <li key={account} className="flex justify-between gap-3">
                <span className="text-foreground">@{account}</span>
                <span className="tabular-nums text-muted">
                  {t("{sent} sent · {dedup} dedup · {failed} failed", {
                    sent: counts.SENT ?? 0,
                    dedup: counts.SKIPPED_DEDUP ?? 0,
                    failed: counts.FAILED ?? 0,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase text-muted">{t("Comments in the last hour")}</p>
          <List rows={data.commentsByPost} empty={t("No comments in the last hour.")} />
          <p className="text-xs font-semibold uppercase text-muted">{t("DMs sent in the last hour")}</p>
          <List rows={data.sentByCampaign} empty={t("No DMs sent in the last hour.")} />
        </div>
      </div>

      {data.latency.length ? (
        <div className="mt-6 overflow-x-auto">
          <p className="text-xs font-semibold uppercase text-muted">{t("Meta response time by call type")}</p>
          <table className="mt-2 w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 pr-4 font-medium">{t("Call type")}</th>
                <th className="py-1 pr-4 text-right font-medium">{t("Calls")}</th>
                <th className="py-1 text-right font-medium">{t("Average")}</th>
              </tr>
            </thead>
            <tbody>
              {data.latency.map((row) => (
                <tr key={row.kind} className="border-t border-border">
                  <td className="py-1 pr-4 text-foreground">{row.kind}</td>
                  <td className="py-1 pr-4 text-right text-muted">{row.calls}</td>
                  <td className="py-1 text-right text-foreground">{(row.avgMs / 1000).toFixed(2)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
