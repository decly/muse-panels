import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Stream = ApiResponse<typeof api, "getStream">;
type StreamEvent = Stream["events"][number];
type Category = StreamEvent["category"];

const CATEGORY_META: Record<Category, { label: string; color: string }> = {
  stock: { label: "股票", color: "#4c9aff" },
  earnings: { label: "财报", color: "#9e7bea" },
  gold: { label: "黄金", color: "#e8b93e" },
  oil: { label: "原油", color: "#e8833a" },
  bonds: { label: "美债", color: "#2fbfa5" },
  usd: { label: "美元", color: "#6f9fd8" },
  macro: { label: "宏观", color: "#e05d7a" },
};
const CATEGORY_ORDER: Category[] = ["stock", "earnings", "gold", "oil", "bonds", "usd", "macro"];

function CategoryIcon({ category, color }: { category: Category; color: string }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (category) {
    case "stock":
      return (
        <svg {...common}><polyline points="3 17 9 11 13 15 21 7" /><polyline points="15 7 21 7 21 13" /></svg>
      );
    case "earnings":
      return (
        <svg {...common}><line x1="5" y1="20" x2="5" y2="13" /><line x1="12" y1="20" x2="12" y2="5" /><line x1="19" y1="20" x2="19" y2="9" /></svg>
      );
    case "gold":
      return (
        <svg {...common}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" /></svg>
      );
    case "oil":
      return (
        <svg {...common}><path d="M12 3.5c3.2 4.1 6 7.6 6 10.6a6 6 0 1 1-12 0c0-3 2.8-6.5 6-10.6z" /></svg>
      );
    case "bonds":
      return (
        <svg {...common}><line x1="18" y1="5" x2="6" y2="19" /><circle cx="7.5" cy="7.5" r="2.6" /><circle cx="16.5" cy="16.5" r="2.6" /></svg>
      );
    case "usd":
      return (
        <svg {...common}><line x1="12" y1="3" x2="12" y2="21" /><path d="M16.5 6.5c-.8-1.2-2.4-2-4.5-2-2.8 0-4.5 1.6-4.5 3.6 0 5 9.4 2.7 9.4 7.3 0 2.1-2 3.6-4.9 3.6-2.2 0-3.9-.9-4.7-2.3" /></svg>
      );
    case "macro":
      return (
        <svg {...common}><circle cx="12" cy="12" r="8.5" /><ellipse cx="12" cy="12" rx="3.8" ry="8.5" /><line x1="3.5" y1="12" x2="20.5" y2="12" /></svg>
      );
  }
}

const bjDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const bjTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
});
const bjDayLabel = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short",
});
const bjFull = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

function dateKey(iso: string): string {
  return bjDate.format(new Date(iso));
}
function todayKey(): string {
  return bjDate.format(new Date());
}

// Upcoming-node dates are plain "YYYY-MM-DD" strings; format them in the
// Beijing calendar without timezone shifting (parse as local noon).
const nodeDayLabel = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  weekday: "short",
});

function nodeDateLabel(date: string): string {
  return nodeDayLabel.format(new Date(`${date}T12:00:00+08:00`));
}

function fmtPrice(key: string, price: number): string {
  // Display-only rounding: futures and spot gold show as integers; Brent crude
  // and the dollar index keep two decimals. Stored data keeps full precision.
  if (key === "dxy" || key === "brent") {
    return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return Math.round(price).toLocaleString("en-US");
}

function changeColor(pct: number): string {
  return pct >= 0 ? "var(--up)" : "var(--down)";
}

// A signed move figure: an explicit +/- sign or a ▲/▼ marker is required, so
// unsigned numbers (dates, years, plain prices) are never coloured. Matches
// "+0.4%", "-2.21%", "▲+11.7bp", "▼-4.58%", "+12bp", "▲ +11.91%".
const MOVE_RE = /[▲▼]\s*[+-]?\d+(?:\.\d+)?\s*(?:%|bp)|[+-]\d+(?:\.\d+)?\s*(?:%|bp)/g;

function moveColor(token: string): string {
  // 红涨绿跌: an explicit ▼ or a minus sign means down (green); ▲ / + is up (red).
  if (token.includes("▼")) return "var(--down)";
  if (token.includes("▲")) return "var(--up)";
  return token.trimStart().startsWith("-") ? "var(--down)" : "var(--up)";
}

/** Colour signed %/bp figures inside a plain text run; everything else stays as-is. */
function colorizeMoves(text: string, keyPrefix: string): ReactNode {
  const parts = text.split(MOVE_RE);
  if (parts.length === 1) return text;
  const matches = text.match(MOVE_RE) ?? [];
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part) out.push(<span key={`${keyPrefix}-t${i}`}>{part}</span>);
    const token = matches[i];
    if (token) {
      out.push(
        <span key={`${keyPrefix}-m${i}`} className="font-semibold" style={{ color: moveColor(token) }}>
          {token}
        </span>,
      );
    }
  });
  return out;
}

/** Render event text: holding tickers underlined, signed move figures coloured. */
function richText(text: string, tickers: string[]): ReactNode {
  if (tickers.length === 0) return colorizeMoves(text, "x");
  const escaped = tickers.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "g"));
  return parts.map((part, i) =>
    tickers.includes(part) ? (
      <span key={i} className="font-semibold text-[var(--text)] underline decoration-[var(--accent)] decoration-2 underline-offset-2">
        {part}
      </span>
    ) : (
      <span key={i}>{colorizeMoves(part, `p${i}`)}</span>
    ),
  );
}

type Mover = StreamEvent["movers"][number];

function fmtMoverChange(pct: number): string {
  const abs = Math.abs(pct);
  const num = Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace(/0$/, "");
  return `${pct >= 0 ? "▲ +" : "▼ -"}${num}%`;
}

/** Compact per-stock table for multi-stock move events: 代码 | 现价 | 涨跌. */
function MoversTable({ movers }: { movers: Mover[] }) {
  return (
    <table className="mt-2 w-full border-collapse">
      <tbody>
        {movers.map((m) => (
          <tr key={m.ticker} className="border-b border-[var(--border)] last:border-b-0">
            <td className="py-1 pr-3 text-left align-baseline text-[15px] font-semibold">{m.ticker}</td>
            <td className="py-1 pr-3 text-right align-baseline text-[15px] tabular-nums text-[var(--dim)]">{m.price}</td>
            <td
              className="py-1 text-right align-baseline text-[15px] font-semibold tabular-nums"
              style={{ color: changeColor(m.changePct) }}
            >
              {fmtMoverChange(m.changePct)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Category | "all">("all");

  const stream = useQuery({
    queryKey: ["stream"],
    queryFn: () => api.getStream({}),
    refetchInterval: 5 * 60 * 1000,
  });

  const refresh = useMutation({
    mutationFn: async () => await api.refreshStrip({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["stream"] }),
  });

  const data = stream.data;
  const events = useMemo(() => {
    const all = data?.events ?? [];
    return filter === "all" ? all : all.filter((e) => e.category === filter);
  }, [data, filter]);

  const counts = useMemo(() => {
    const map = new Map<Category, number>();
    for (const e of data?.events ?? []) map.set(e.category, (map.get(e.category) ?? 0) + 1);
    return map;
  }, [data]);

  // Group events by Beijing calendar day, preserving order.
  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; items: StreamEvent[] }> = [];
    for (const e of events) {
      const key = dateKey(e.eventTime);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(e);
      else out.push({ key, label: bjDayLabel.format(new Date(e.eventTime)), items: [e] });
    }
    return out;
  }, [events]);

  // Group upcoming nodes by date, preserving the server's ascending order.
  const nodeGroups = useMemo(() => {
    const out: Array<{ date: string; label: string; items: Stream["nodes"] }> = [];
    for (const n of data?.nodes ?? []) {
      const last = out[out.length - 1];
      if (last && last.date === n.date) last.items.push(n);
      else out.push({ date: n.date, label: nodeDateLabel(n.date), items: [n] });
    }
    return out;
  }, [data]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      {/* Quote strip */}
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
        <div className="mx-auto max-w-3xl px-3 pt-2">
          {stream.isPending ? (
            <p className="py-3 text-sm text-[var(--dim)]">行情加载中…</p>
          ) : data && data.strip.length > 0 ? (
            <div className="grid grid-cols-5 items-start gap-1">
              {data.strip.map((item) => (
                <div key={item.key} className="min-w-0 py-1">
                  <p className="h-4 whitespace-nowrap text-[11px] leading-4 text-[var(--dim)]">{item.label}</p>
                  <p className="h-6 text-[16px] font-semibold leading-6 tabular-nums">
                    {item.price != null ? fmtPrice(item.key, item.price) : "—"}
                  </p>
                  <p
                    className="h-4 whitespace-nowrap text-[12px] leading-4 tabular-nums"
                    style={{ color: item.changePct != null ? changeColor(item.changePct) : "var(--dim)" }}
                  >
                    {item.changePct != null
                      ? `${item.changePct >= 0 ? "▲" : "▼"} ${item.changePct >= 0 ? "+" : ""}${item.changePct.toFixed(1)}%`
                      : "暂无数据"}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-3 text-sm text-[var(--dim)]">行情暂不可用，稍后自动重试。</p>
          )}
          <div className="flex items-center gap-2 pb-1.5">
            <p className="min-w-0 flex-1 truncate text-[12px] leading-4 text-[var(--dim)]">
              {data?.stripFetchedAt
                ? `行情抓取于 ${bjFull.format(new Date(data.stripFetchedAt))}（北京时间）· 每 30 分钟更新`
                : " "}
            </p>
            <button
              type="button"
              aria-label="刷新行情条"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
              className="shrink-0 whitespace-nowrap rounded-md px-2 text-[13px] text-[var(--dim)] active:bg-[var(--surface)] disabled:opacity-50"
            >
              {refresh.isPending ? "刷新中…" : "刷新行情"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 pb-10">
        {/* Upcoming nodes */}
        {nodeGroups.length > 0 ? (
          <section aria-label="近期节点" className="pt-3">
            <h2 className="pb-1 text-[13px] font-semibold tracking-wide text-[var(--dim)]">近期节点</h2>
            <div className="divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)] px-3 py-1">
              {nodeGroups.map((group) => (
                <div key={group.date} className="flex items-baseline gap-2.5 py-1.5">
                  <span className="w-[92px] shrink-0 whitespace-nowrap text-[13px] font-medium tabular-nums text-[var(--dim)]">
                    {group.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    {group.items.map((n, i) => (
                      <p key={i} className="break-words text-[14px] leading-6">
                        {n.time ? (
                          <span className="mr-2 font-medium tabular-nums">{n.time}</span>
                        ) : null}
                        {richText(n.event, n.tickers)}
                        {n.tickers.length > 0 ? (
                          <span className="ml-2">
                            {n.tickers.map((t) => (
                              <span
                                key={t}
                                className="mr-2 font-semibold underline decoration-[var(--accent)] decoration-2 underline-offset-2"
                              >
                                {t}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Category filter */}
        <nav aria-label="事件类别筛选" className="flex flex-wrap gap-1.5 pt-3">
          <button
            type="button"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
            className={`rounded-full border px-3 text-[14px] ${
              filter === "all"
                ? "border-[var(--text)] bg-[var(--surface)] font-semibold"
                : "border-[var(--border)] text-[var(--dim)]"
            }`}
          >
            全部{data ? ` ${data.events.length}` : ""}
          </button>
          {CATEGORY_ORDER.map((cat) => {
            const meta = CATEGORY_META[cat];
            const active = filter === cat;
            return (
              <button
                key={cat}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(active ? "all" : cat)}
                className="flex items-center gap-1.5 rounded-full border px-3 text-[14px]"
                style={{
                  borderColor: active ? meta.color : "var(--border)",
                  color: active ? meta.color : "var(--dim)",
                  background: active ? "var(--surface)" : "transparent",
                  fontWeight: active ? 600 : 400,
                }}
              >
                <CategoryIcon category={cat} color={meta.color} />
                {meta.label}
                {counts.get(cat) ? ` ${counts.get(cat)}` : ""}
              </button>
            );
          })}
        </nav>

        {/* Event stream */}
        {stream.isPending ? (
          <p className="py-10 text-center text-sm text-[var(--dim)]">事件流加载中…</p>
        ) : stream.isError ? (
          <div className="py-10 text-center">
            <p className="text-sm text-[var(--dim)]">加载失败，请重试。</p>
            <button
              type="button"
              onClick={() => stream.refetch()}
              className="mt-2 rounded-md border border-[var(--border)] px-4 text-sm"
            >
              重新加载
            </button>
          </div>
        ) : events.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-[15px] font-medium">
              {filter === "all" ? "最近 7 天暂无事件" : `最近 7 天暂无「${CATEGORY_META[filter].label}」事件`}
            </p>
            <p className="mx-auto mt-2 max-w-sm text-[14px] leading-6 text-[var(--dim)]">
              异动监测、财报与宏观数据经核实后会追加到这里，最新事件在最上方。
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h2 className="pb-1 pt-4 text-[13px] font-semibold tracking-wide text-[var(--dim)]">
                {group.key === todayKey() ? `今天 · ${group.label}` : group.label}
              </h2>
              <div className="divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)] px-3">
                {group.items.map((e) => {
                  const meta = CATEGORY_META[e.category];
                  return (
                    <article key={e.id} className="min-w-0 py-3">
                      <div className="flex items-start gap-2">
                        <time className="w-[52px] shrink-0 text-[15px] font-medium leading-7 tabular-nums text-[var(--dim)]">
                          {bjTime.format(new Date(e.eventTime))}
                        </time>
                        <span
                          className="mt-[3px] flex shrink-0 items-center gap-1 rounded px-1.5 py-[1px] text-[12px] font-semibold"
                          style={{ color: meta.color, background: `${meta.color}1f` }}
                        >
                          <CategoryIcon category={e.category} color={meta.color} />
                          {meta.label}
                        </span>
                        <h3 className="min-w-0 flex-1 break-words text-[17px] font-medium leading-7">
                          {richText(e.title, e.tickers)}
                        </h3>
                      </div>
                      {e.movers.length > 0 ? <MoversTable movers={e.movers} /> : null}
                      {e.keyNumbers ? (
                        <p className="mt-1.5 break-words text-[15px] font-semibold leading-6 tabular-nums">
                          {richText(e.keyNumbers, e.tickers)}
                        </p>
                      ) : null}
                      <p className="mt-1.5 break-words text-[15px] leading-[1.5] text-[var(--dim)]">
                        {richText(e.note, e.tickers)}
                      </p>
                      {e.impact ? (
                        <p className="mt-2 break-words border-l-[3px] bg-[var(--bg)] py-1 pl-2.5 pr-2 text-[14px] leading-6" style={{ borderColor: meta.color }}>
                          <span className="mr-1.5 font-semibold" style={{ color: meta.color }}>
                            解读
                          </span>
                          {richText(e.impact, e.tickers)}
                        </p>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ))
        )}

        <p className="pt-4 text-center text-[12px] text-[var(--dim)]">
          事件保留最近 7 天 · 时间均为北京时间
        </p>
      </main>
    </div>
  );
}
