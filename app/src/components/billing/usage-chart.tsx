import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BillingUsageDaily } from "@/lib/billing/queries";

/**
 * Zero-filled local days from the period start to its end, capped at 62.
 *
 * The provider only sends the days something happened, but a trend with holes reads as a chart
 * that failed to load rather than as quiet days. A pathological span (a period answer gone wrong)
 * is capped so one bad response cannot ask the browser to draw a thousand bars.
 */
export function fillDays(
  from: string | undefined,
  to: string | undefined,
  days: BillingUsageDaily["days"],
): BillingUsageDaily["days"] {
  if (from === undefined || to === undefined) return [...days];
  const byDate = new Map(days.map((day) => [day.date, day]));
  const filled: BillingUsageDaily["days"] = [];
  const cursor = new Date(from);
  const end = new Date(to);
  const empty = (date: string) => ({ date, tokens: 0, inputTokens: 0, outputTokens: 0, calls: 0 });
  while (cursor.getTime() <= end.getTime() && filled.length < 62) {
    const date = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    filled.push(byDate.get(date) ?? empty(date));
    cursor.setDate(cursor.getDate() + 1);
  }
  return filled;
}

/** The period's daily tokens, one bar per day, in the design system's own chart token. */
export function UsageChart({ daily }: { daily: BillingUsageDaily }) {
  const { t } = useTranslation("settings");
  const data = fillDays(daily.fromDatetime, daily.toDatetime, daily.days);
  if (data.length === 0) {
    return <p className="text-muted-foreground mt-2 text-sm">{t("usagePage.chartEmpty")}</p>;
  }
  return (
    <div className="mt-4">
      <div role="img" aria-label={t("usagePage.trendTitle")} className="h-60 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11 }}
              tickFormatter={(value: string, index: number) =>
                index === 0 || index === data.length - 1 || value.endsWith("-01")
                  ? value.slice(5)
                  : ""
              }
            />
            <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={48} />
            <Tooltip
              cursor={{ fill: "var(--muted)", opacity: 0.4 }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="rounded-lg border bg-card px-3 py-2 text-xs">
                    <p className="font-medium tabular-nums">{String(label)}</p>
                    <p className="text-muted-foreground mt-1 tabular-nums">
                      {t("usagePage.eventTokens")}: {payload[0]?.value as number}
                    </p>
                    <p className="text-muted-foreground tabular-nums">
                      {t("usagePage.eventIn")}: {(payload[0]?.payload as { inputTokens: number }).inputTokens} · {t("usagePage.eventOut")}: {(payload[0]?.payload as { outputTokens: number }).outputTokens}
                    </p>
                  </div>
                ) : null
              }
            />
            <Bar dataKey="tokens" fill="var(--chart-2)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {daily.truncated ? (
        <p className="text-muted-foreground mt-2 text-xs">
          {t("usagePage.trendTruncated", {
            total: daily.days.reduce((sum, day) => sum + day.calls, 0),
          })}
        </p>
      ) : null}
    </div>
  );
}
