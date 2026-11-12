import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Today = ApiResponse<typeof api, "getToday">;
type Account = Today["accounts"][number];
type Mover = Today["movers"][number];
type EventItem = Today["events"][number];

const PRIVACY_KEY = "today-page-privacy";

function fmtMoney(v: number | null, digits = 2): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtSignedMoney(v: number | null): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}$${fmtMoney(Math.abs(v))}`;
}

// 红涨绿跌：red = up, green = down.
function pctColor(v: number | null): string | undefined {
  if (v == null || v === 0) return undefined;
  return v > 0 ? "var(--up)" : "var(--down)";
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${arrow} ${sign}${Math.abs(v).toFixed(2)}%`;
}

function fmtBeijingTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function eventDateLabel(dateStr: string, todayStr: string): string {
  const [y = 1970, m = 1, d = 1] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const md = `${m}月${d}日`;
  const diffDays = Math.round(
    (dt.getTime() - new Date(`${todayStr}T00:00:00Z`).getTime()) / 86400000,
  );
  if (diffDays === 0) return `今天 · ${md}`;
  if (diffDays === 1) return `明天 · ${md}`;
  return `${WEEKDAYS[dt.getUTCDay()] ?? ""} · ${md}`;
}

// Current Beijing wall-clock: date (YYYY-MM-DD) + minutes since midnight.
function beijingNow(): { date: string; minutes: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

// "21:30" -> minutes since midnight; free labels like "美股盘后" -> null.
function parseTimeMinutes(t: string | null): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isEventPast(
  e: EventItem,
  todayStr: string,
  nowMinutes: number,
): boolean {
  if (e.date < todayStr) return true;
  if (e.date > todayStr) return false;
  const mins = parseTimeMinutes(e.time_text);
  return mins != null && nowMinutes > mins;
}

// Split a prose paragraph into bullet points at natural breaks —
// newlines, sentence ends (。) and clause separators (；/;) — never
// inside parentheses. A pure 、-enumeration (3+ short items, e.g. the
// other-assets line) is broken into one point per item. Text that has
// no natural break stays as a single point, wording unchanged; only
// the punctuation that served as a separator is dropped.
function splitPoints(text: string): string[] {
  const splitAt = (s: string, delims: readonly string[]): string[] => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of s) {
      if (ch === "（" || ch === "(") depth += 1;
      else if (ch === "）" || ch === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && delims.includes(ch)) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const points: string[] = [];
  for (const seg of splitAt(text, ["\n", "。", "；", ";"])) {
    const parts = splitAt(seg, ["、"]);
    if (parts.length >= 3 && parts.every((p) => p.trim().length <= 32)) {
      points.push(...parts);
    } else {
      points.push(seg);
    }
  }
  const cleaned = points.map((p) => p.trim()).filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned : [text];
}

// Prose blocks render as an unordered bullet list, one point per row.
function BulletText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const points = splitPoints(text);
  return (
    <ul className={`space-y-1.5 ${className ?? ""}`}>
      {points.map((p, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            className="mt-[0.62em] h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--dim)]"
          />
          <span className="min-w-0 flex-1">{p}</span>
        </li>
      ))}
    </ul>
  );
}

function SectionTitle({ children, right }: { children: string; right?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <h2 className="text-lg font-semibold text-[var(--text)]">{children}</h2>
      {right ? (
        <span className="shrink-0 text-sm text-[var(--dim)]">{right}</span>
      ) : null}
    </div>
  );
}

function AccountRow({ a, privacy }: { a: Account; privacy: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="shrink-0 text-base text-[var(--text)]">{a.label}</span>
      <span className="flex flex-col items-end tabular-nums">
        <span className="text-lg leading-7 text-[var(--text)]">
          {privacy ? "••••••" : a.total_usd == null ? "—" : `$${fmtMoney(a.total_usd)}`}
        </span>
        <span className="flex items-baseline justify-end text-sm leading-5">
          <span
            className="w-[5.5rem] text-right"
            style={{ color: pctColor(a.day_change_pct) }}
          >
            {fmtPct(a.day_change_pct)}
          </span>
          <span
            className="w-[7rem] text-right"
            style={{ color: privacy ? undefined : pctColor(a.day_change_usd) }}
          >
            {a.day_change_usd == null
              ? ""
              : privacy
                ? "••••••"
                : fmtSignedMoney(a.day_change_usd)}
          </span>
        </span>
      </span>
    </div>
  );
}

// 昨夜动向 selection (deterministic, page-side): from the full pushed
// holdings set take the top 5 gainers and top 5 losers, then merge in
// every stock whose |day change| ≥ 5% that the top-5 cut missed. Zero
// changes belong to neither group; a symbol never appears twice.
function selectMoverGroups(movers: Mover[]): {
  gainers: Mover[];
  losers: Mover[];
} {
  const pctOf = (m: Mover) => m.change_pct ?? 0;
  const byAbsDesc = (a: Mover, b: Mover) =>
    Math.abs(pctOf(b)) - Math.abs(pctOf(a));
  const pick = (list: Mover[], inDirection: (v: number) => boolean) => {
    const inGroup = list.filter((m) => inDirection(pctOf(m)));
    const chosen = new Map<string, Mover>();
    for (const m of [...inGroup].sort(byAbsDesc).slice(0, 5)) {
      chosen.set(m.symbol, m);
    }
    for (const m of inGroup) {
      if (Math.abs(pctOf(m)) >= 5) chosen.set(m.symbol, m);
    }
    return [...chosen.values()].sort(byAbsDesc);
  };
  return {
    gainers: pick(movers, (v) => v > 0),
    losers: pick(movers, (v) => v < 0),
  };
}

function MoverRow({ m }: { m: Mover }) {
  const bigMove = m.change_pct != null && Math.abs(m.change_pct) >= 5;
  return (
    <div className="py-2">
      <div className="grid grid-cols-[1fr_6.5rem_7rem] items-baseline gap-2">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-base font-medium text-[var(--text)]">
            {m.symbol}
          </span>
          {bigMove ? (
            <span
              className="shrink-0 rounded-full border px-1.5 py-px text-xs font-semibold leading-4"
              style={{
                color: pctColor(m.change_pct),
                borderColor: pctColor(m.change_pct),
              }}
            >
              ≥5%
            </span>
          ) : null}
        </span>
        <span className="text-right text-base tabular-nums text-[var(--dim)]">
          {m.close == null ? "—" : `$${fmtMoney(m.close)}`}
        </span>
        <span
          className={`text-right text-base tabular-nums ${
            bigMove ? "font-bold" : "font-medium"
          }`}
          style={{ color: pctColor(m.change_pct) }}
        >
          {fmtPct(m.change_pct)}
        </span>
      </div>
      {m.after_hours_note ? (
        <p className="mt-0.5 text-sm text-[var(--gold)]">{m.after_hours_note}</p>
      ) : null}
    </div>
  );
}

function EventRow({
  e,
  past,
  variant,
}: {
  e: EventItem;
  past: boolean;
  variant: "today" | "recent";
}) {
  const [, rm = "", rd = ""] = e.date.split("-");
  return (
    <div className={`flex items-start gap-3 py-2.5 ${past ? "opacity-55" : ""}`}>
      {variant === "today" ? (
        <span className="mt-0.5 flex w-[4.5rem] shrink-0 items-center justify-center rounded-md bg-[var(--accent)] px-1 py-1 text-sm font-semibold tabular-nums text-[var(--bg)]">
          {e.time_text ?? "全天"}
        </span>
      ) : (
        <span
          className={`mt-0.5 flex w-[4.5rem] shrink-0 flex-col items-center justify-center rounded-md border px-1 py-1 tabular-nums ${
            past
              ? "border-[var(--border)] text-[var(--dim)]"
              : "border-[var(--border)] bg-[var(--surface)]"
          }`}
        >
          <span className="text-sm font-semibold leading-5 text-[var(--text)]">
            {Number(rm)}/{Number(rd)}
          </span>
          <span className="text-xs leading-4 text-[var(--dim)]">
            {e.time_text ?? "全天"}
          </span>
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold leading-6 text-[var(--text)]">
          {e.title}
        </span>
        {e.note ? (
          <span className="mt-0.5 block text-sm leading-5 text-[var(--dim)]">
            {e.note}
          </span>
        ) : null}
      </span>
      <span className="mt-1 shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-xs leading-4 text-[var(--dim)]">
        {e.kind}
      </span>
    </div>
  );
}

export function App() {
  const [privacy, setPrivacy] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(PRIVACY_KEY) === "1";
    } catch {
      return false;
    }
  });

  const today = useQuery({
    queryKey: ["today"],
    queryFn: () => api.getToday({}),
    // First-screen load resilience: transient action-request failures
    // (webview stalls, cold starts, brief 5xx) retry automatically —
    // 3 retries after the initial attempt with exponential backoff
    // (1s → 2s → 4s, capped at 8s). While retries are in flight the
    // query stays in its pending state, so the page shows only the
    // loading indicator; the error state (with its manual retry
    // button) appears only after every attempt has failed.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
  });

  const togglePrivacy = () => {
    setPrivacy((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(PRIVACY_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const data = today.data;
  const refreshedLabel = fmtBeijingTime(data?.market_refreshed_at ?? null);
  const nowBj = beijingNow();
  const moverGroups = selectMoverGroups(data?.movers ?? []);

  // Group events by date; within a day, order by clock time ascending
  // (timed events first in time order, untimed/free-label ones after).
  const eventGroups: Array<{ date: string; items: EventItem[] }> = [];
  for (const e of data?.events ?? []) {
    const g = eventGroups.find((x) => x.date === e.date);
    if (g) g.items.push(e);
    else eventGroups.push({ date: e.date, items: [e] });
  }
  for (const g of eventGroups) {
    g.items = g.items
      .map((e, i) => ({ e, i, mins: parseTimeMinutes(e.time_text) }))
      .sort((a, b) => {
        const am = a.mins ?? Number.POSITIVE_INFINITY;
        const bm = b.mins ?? Number.POSITIVE_INFINITY;
        return am !== bm ? am - bm : a.i - b.i;
      })
      .map((x) => x.e);
  }
  // Split into 今日 (Beijing today) and 近期 (later dates): today's group
  // renders first with emphasis; when today has no events it is omitted.
  const todayGroup = eventGroups.find((g) => g.date === data?.date_beijing);
  const recentGroups = eventGroups.filter(
    (g) => g.date !== data?.date_beijing,
  );
  const [, todayM = "", todayD = ""] = (data?.date_beijing ?? "").split("-");

  const [yStr = "", mStr = "", dStr = ""] = (data?.date_beijing ?? "").split("-");

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-8">
        {/* Header: Beijing date + overview line */}
        <header className="pt-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-2xl font-semibold leading-snug text-[var(--text)]">
                {yStr && mStr && dStr
                  ? `${Number(mStr)}月${Number(dStr)}日`
                  : "今日"}
                {data?.weekday_beijing ? (
                  <span className="ml-2 text-lg font-normal text-[var(--dim)]">
                    {data.weekday_beijing}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={togglePrivacy}
                  aria-pressed={privacy}
                  aria-label="隐私模式开关"
                  className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)]"
                >
                  {privacy ? "隐私已开" : "隐私"}
                </button>
              </div>
              {refreshedLabel ? (
                <p className="mt-1 text-right text-xs leading-4 text-[var(--dim)]">
                  生成于 {refreshedLabel}
                </p>
              ) : null}
            </div>
          </div>
          {data?.overview ? (
            <BulletText
              text={data.overview}
              className="mt-2 text-lg leading-relaxed text-[var(--text)]"
            />
          ) : null}
        </header>

        {today.isPending ? (
          <p className="py-12 text-center text-base text-[var(--dim)]">
            {today.failureCount > 0
              ? `加载中，正在重试（第 ${today.failureCount} 次）…`
              : "加载中…"}
          </p>
        ) : today.error ? (
          <div className="py-12 text-center">
            <p className="text-base text-[var(--text)]">加载失败</p>
            <button
              type="button"
              onClick={() => today.refetch()}
              aria-label="重新加载"
              className="mt-3 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-base text-[var(--text)]"
            >
              重试
            </button>
          </div>
        ) : data ? (
          <>
            {/* 指数（三大指数，页面最前） */}
            {data.indices.length > 0 ? (
              <section
                aria-label="指数"
                className="mt-5 border-t border-[var(--border)] pt-3"
              >
                <SectionTitle>指数</SectionTitle>
                <div className="grid grid-cols-3 gap-2">
                  {data.indices.map((ix) => (
                    <div key={ix.key} className="flex min-w-0 flex-col">
                      <span className="text-sm text-[var(--dim)]">{ix.label}</span>
                      <span className="mt-0.5 whitespace-nowrap text-lg leading-7 tabular-nums text-[var(--text)]">
                        {ix.price == null ? "—" : fmtMoney(ix.price, 0)}
                      </span>
                      <span
                        className="whitespace-nowrap text-base tabular-nums"
                        style={{ color: pctColor(ix.change_pct) }}
                      >
                        {fmtPct(ix.change_pct)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* 账户总览 */}
            <section
              aria-label="账户总览"
              className="mt-6 border-t border-[var(--border)] pt-3"
            >
              <SectionTitle
                right={
                  data.accounts_as_of_date
                    ? `收盘口径 · ${data.accounts_as_of_date}`
                    : undefined
                }
              >
                账户总览
              </SectionTitle>
              {data.accounts.length > 0 ? (
                <div className="divide-y divide-[var(--border)]">
                  {data.accounts.map((a) => (
                    <AccountRow key={a.id} a={a} privacy={privacy} />
                  ))}
                </div>
              ) : (
                <p className="py-2 text-base text-[var(--dim)]">
                  账户数据待今日晨报推送后显示。
                </p>
              )}
            </section>

            {/* 昨夜动向 */}
            <section
              aria-label="昨夜动向"
              className="mt-6 border-t border-[var(--border)] pt-3"
            >
              <SectionTitle right={data.movers_session_label ?? undefined}>
                昨夜动向
              </SectionTitle>
              {data.movers.length > 0 ? (
                <div className="space-y-4">
                  {(
                    [
                      { title: "涨幅居前", items: moverGroups.gainers },
                      { title: "跌幅居前", items: moverGroups.losers },
                    ] as const
                  )
                    .filter((g) => g.items.length > 0)
                    .map((g) => (
                      <div key={g.title}>
                        <p className="flex items-baseline gap-2 text-sm font-semibold text-[var(--dim)]">
                          <span>{g.title}</span>
                          <span className="font-normal">{g.items.length} 只</span>
                        </p>
                        <div className="divide-y divide-[var(--border)]">
                          {g.items.map((m) => (
                            <MoverRow key={m.symbol} m={m} />
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="py-2 text-base text-[var(--dim)]">
                  昨夜持仓动向待晨报推送后显示。
                </p>
              )}
              {data.after_hours_notes.length > 0 ? (
                <div className="mt-1.5 space-y-0.5">
                  {data.after_hours_notes.map((n, i) => (
                    <p key={i} className="text-sm text-[var(--gold)]">
                      盘后异动：{n}
                    </p>
                  ))}
                </div>
              ) : null}
            </section>

            {/* 今日事件（时间线列表） */}
            <section
              aria-label="今日事件"
              className="mt-6 border-t border-[var(--border)] pt-3"
            >
              <SectionTitle>今日事件</SectionTitle>
              {eventGroups.length > 0 ? (
                <div className="space-y-5">
                  {todayGroup ? (
                    <div>
                      <p className="flex items-center gap-2">
                        <span className="text-base font-semibold text-[var(--text)]">
                          今日 · {Number(todayM)}月{Number(todayD)}日
                        </span>
                        <span
                          className="rounded-full px-2 py-0.5 text-xs font-semibold leading-4"
                          style={{
                            backgroundColor: "var(--gold)",
                            color: "var(--bg)",
                          }}
                        >
                          今日重点
                        </span>
                      </p>
                      <div className="mt-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3">
                        <div className="divide-y divide-[var(--border)]">
                          {todayGroup.items.map((e) => (
                            <EventRow
                              key={e.id}
                              e={e}
                              variant="today"
                              past={isEventPast(e, nowBj.date, nowBj.minutes)}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {recentGroups.length > 0 ? (
                    <div>
                      <p className="text-sm font-semibold text-[var(--dim)]">
                        近期
                      </p>
                      <div className="mt-1 space-y-3">
                        {recentGroups.map((g) => (
                          <div key={g.date}>
                            <p className="text-sm font-medium text-[var(--dim)]">
                              {eventDateLabel(g.date, data.date_beijing)}
                            </p>
                            <div className="divide-y divide-[var(--border)]">
                              {g.items.map((e) => (
                                <EventRow
                                  key={e.id}
                                  e={e}
                                  variant="recent"
                                  past={isEventPast(
                                    e,
                                    nowBj.date,
                                    nowBj.minutes,
                                  )}
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="py-2 text-base text-[var(--dim)]">
                  近期暂无已排事件。
                </p>
              )}
            </section>

            {/* 黄金 */}
            <section
              aria-label="黄金"
              className="mt-6 border-t border-[var(--border)] pt-3"
            >
              <SectionTitle
                right={
                  data.gold?.source_date ? `数据日 ${data.gold.source_date}` : undefined
                }
              >
                黄金
              </SectionTitle>
              {data.gold ? (
                <div className="divide-y divide-[var(--border)]">
                  <div className="grid grid-cols-[1fr_7rem_6rem] items-baseline gap-2 py-2.5">
                    <span className="min-w-0 text-base text-[var(--text)]">
                      现货黄金{" "}
                      <span className="text-sm text-[var(--dim)]">XAU/USD</span>
                    </span>
                    <span className="text-right text-lg tabular-nums text-[var(--text)]">
                      {data.gold.xau.price == null
                        ? "—"
                        : `$${fmtMoney(data.gold.xau.price)}`}
                    </span>
                    <span
                      className="text-right text-sm tabular-nums"
                      style={{ color: pctColor(data.gold.xau.change_pct) }}
                    >
                      {fmtPct(data.gold.xau.change_pct)}
                    </span>
                  </div>
                  <div className="grid grid-cols-[1fr_7rem_6rem] items-baseline gap-2 py-2.5">
                    <span className="min-w-0 text-base text-[var(--text)]">
                      上海黄金{" "}
                      <span className="text-sm text-[var(--dim)]">Au99.99 · 元/克</span>
                    </span>
                    <span className="text-right text-lg tabular-nums text-[var(--text)]">
                      {data.gold.sgold.price == null
                        ? "—"
                        : `¥${fmtMoney(data.gold.sgold.price)}`}
                    </span>
                    <span
                      className="text-right text-sm tabular-nums"
                      style={{ color: pctColor(data.gold.sgold.change_pct) }}
                    >
                      {fmtPct(data.gold.sgold.change_pct)}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="py-2 text-base text-[var(--dim)]">
                  黄金价格待每日晨间生成后显示。
                </p>
              )}
            </section>

            {/* 其他资产（仅在助手推送后显示） */}
            {data.other_assets ? (
              <section
                aria-label="其他资产"
                className="mt-6 border-t border-[var(--border)] pt-3"
              >
                <SectionTitle>其他资产</SectionTitle>
                <BulletText
                  text={data.other_assets}
                  className="text-base leading-relaxed text-[var(--text)]"
                />
              </section>
            ) : null}

            {/* 技术要点（仅在助手推送当期总览句后显示） */}
            {data.tech_line ? (
              <section
                aria-label="技术要点"
                className="mt-6 border-t border-[var(--border)] pt-3"
              >
                <SectionTitle>技术要点</SectionTitle>
                <BulletText
                  text={data.tech_line}
                  className="text-base leading-relaxed text-[var(--text)]"
                />
              </section>
            ) : null}

            <footer className="mt-6 border-t border-[var(--border)] pt-3">
              <p className="text-xs leading-5 text-[var(--dim)]">
                账户与昨夜动向为美股常规时段收盘口径；盘后异动单独标注。金额单位为美元（上海黄金为人民币/克）。
              </p>
            </footer>
          </>
        ) : null}
      </main>
    </div>
  );
}
