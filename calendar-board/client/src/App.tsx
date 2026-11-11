import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type CalEvent = ApiResponse<typeof api, "getCalendar">["events"][number];
type Filter = "all" | "earnings" | "macro";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function parseDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

function addDays(dateStr: string, days: number): string {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(from: string, to: string): number {
  return Math.round(
    (parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000,
  );
}

// Monday (YYYY-MM-DD) of the week containing dateStr.
function weekMonday(dateStr: string): string {
  const dow = parseDate(dateStr).getUTCDay(); // 0 = Sunday
  return addDays(dateStr, -((dow + 6) % 7));
}

function formatDay(dateStr: string): string {
  const d = parseDate(dateStr);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

function relativeLabel(today: string, dateStr: string): string | null {
  const diff = diffDays(today, dateStr);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  if (diff === -1) return "昨天";
  return null;
}

function EventRow({ event }: { event: CalEvent }) {
  const isEarn = event.kind === "earnings";
  return (
    <li className="flex gap-3 py-3">
      <span
        aria-hidden
        className="mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: isEarn ? "var(--earn)" : "var(--macro)" }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-base font-medium text-[var(--text)]">
            {event.importance === "key" && (
              <span aria-label="重点事件" className="mr-1 text-[var(--earn)]">
                ★
              </span>
            )}
            {event.title}
          </span>
          {!event.confirmed && (
            <span className="rounded bg-[var(--earn-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--earn)]">
              未确认
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-[var(--dim)]">
          <span
            className="rounded px-1.5 py-0.5 text-xs font-medium"
            style={{
              color: isEarn ? "var(--earn)" : "var(--macro)",
              backgroundColor: isEarn ? "var(--earn-soft)" : "var(--macro-soft)",
            }}
          >
            {isEarn ? "财报" : "宏观"}
          </span>
          {event.timeText && <span>{event.timeText}</span>}
          {event.tickers.map((t) => (
            <span
              key={t}
              className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs font-semibold text-[var(--text)]"
            >
              {t}
            </span>
          ))}
        </div>
        {event.note && (
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            {event.note}
          </p>
        )}
        {event.source && (
          <p className="mt-0.5 text-xs text-[var(--dim)]">来源：{event.source}</p>
        )}
      </div>
    </li>
  );
}

function DayGroup({
  dateStr,
  today,
  events,
}: {
  dateStr: string;
  today: string;
  events: CalEvent[];
}) {
  const rel = relativeLabel(today, dateStr);
  const weekday = WEEKDAYS[parseDate(dateStr).getUTCDay()] ?? "";
  return (
    <div>
      <div className="flex items-baseline gap-2 pt-4 pb-1">
        <span className="text-base font-semibold text-[var(--text)]">
          {formatDay(dateStr)}
        </span>
        <span className="text-sm text-[var(--dim)]">{weekday}</span>
        {rel && (
          <span className="text-sm font-medium text-[var(--accent)]">{rel}</span>
        )}
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {events.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </ul>
    </div>
  );
}

function groupByDay(events: CalEvent[]): [string, CalEvent[]][] {
  const map = new Map<string, CalEvent[]>();
  for (const e of events) {
    const list = map.get(e.date);
    if (list) list.push(e);
    else map.set(e.date, [e]);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "earnings", label: "财报" },
  { key: "macro", label: "宏观" },
];

export function App() {
  const [filter, setFilter] = useState<Filter>("all");
  const [pastOpen, setPastOpen] = useState(false);

  const calendar = useQuery({
    queryKey: ["calendar"],
    queryFn: () => api.getCalendar({}),
  });

  const data = calendar.data;
  const sections = useMemo(() => {
    if (!data) return null;
    const today = data.today;
    const thisMonday = weekMonday(today);
    const nextMonday = addDays(thisMonday, 7);
    const afterNext = addDays(thisMonday, 14);
    const visible = data.events.filter(
      (e) => filter === "all" || e.kind === filter,
    );
    const past = visible.filter((e) => e.date < today);
    const future = visible.filter((e) => e.date >= today);
    return {
      today,
      past: groupByDay(past),
      thisWeek: groupByDay(future.filter((e) => e.date < nextMonday)),
      nextWeek: groupByDay(
        future.filter((e) => e.date >= nextMonday && e.date < afterNext),
      ),
      later: groupByDay(future.filter((e) => e.date >= afterNext)),
      futureCount: future.length,
      pastCount: past.length,
    };
  }, [data, filter]);

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      <main className="mx-auto w-full max-w-2xl px-4 pb-10">
        {/* Type filter */}
        <div
          role="tablist"
          aria-label="事件类型筛选"
          className="sticky top-0 z-10 -mx-4 bg-[var(--bg)] px-4 pt-3 pb-2"
        >
          <div className="flex rounded-[var(--radius)] bg-[var(--surface)] p-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-base font-medium transition-colors ${
                  filter === f.key
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--dim)]"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {data && (
            <p className="pt-2 text-sm text-[var(--dim)]">
              未来 30 天 · 北京时间
              {sections && sections.futureCount > 0
                ? ` · 共 ${sections.futureCount} 条`
                : ""}
            </p>
          )}
        </div>

        {calendar.isPending && (
          <p className="py-16 text-center text-base text-[var(--dim)]">
            加载中…
          </p>
        )}

        {calendar.error && (
          <div className="py-16 text-center">
            <p className="text-base text-[var(--text)]">加载失败</p>
            <button
              onClick={() => calendar.refetch()}
              className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] px-4 py-2 text-base font-medium text-[var(--accent)]"
            >
              重试
            </button>
          </div>
        )}

        {sections && (
          <>
            {sections.futureCount === 0 && (
              <p className="py-16 text-center text-base text-[var(--dim)]">
                未来 30 天暂无
                {filter === "all" ? "" : filter === "earnings" ? "财报" : "宏观"}
                事件
              </p>
            )}

            {[
              { title: "本周", days: sections.thisWeek },
              { title: "下周", days: sections.nextWeek },
              { title: "更远", days: sections.later },
            ]
              .filter((s) => s.days.length > 0)
              .map((s) => (
                <section key={s.title} aria-label={s.title}>
                  <h2 className="mt-6 border-b-2 border-[var(--text)] pb-1.5 text-lg font-bold text-[var(--text)]">
                    {s.title}
                  </h2>
                  <div>
                    {s.days.map(([dateStr, events]) => (
                      <DayGroup
                        key={dateStr}
                        dateStr={dateStr}
                        today={sections.today}
                        events={events}
                      />
                    ))}
                  </div>
                </section>
              ))}

            {sections.pastCount > 0 && (
              <section aria-label="已过去" className="mt-8 opacity-60">
                <button
                  onClick={() => setPastOpen((v) => !v)}
                  aria-expanded={pastOpen}
                  className="flex w-full items-center justify-between border-b border-[var(--border)] pb-1.5 text-left"
                >
                  <span className="text-lg font-bold text-[var(--text)]">
                    已过去（近 7 天 · {sections.pastCount} 条）
                  </span>
                  <span aria-hidden className="text-[var(--dim)]">
                    {pastOpen ? "▾" : "▸"}
                  </span>
                </button>
                {pastOpen &&
                  sections.past.map(([dateStr, events]) => (
                    <DayGroup
                      key={dateStr}
                      dateStr={dateStr}
                      today={sections.today}
                      events={events}
                    />
                  ))}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
