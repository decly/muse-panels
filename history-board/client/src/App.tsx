import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
Area,
AreaChart,
Bar,
BarChart,
CartesianGrid,
Cell,
Line,
LineChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";

type HistoryData = ApiResponse<typeof api, "getHistory">;
type Snapshot = HistoryData["history"][number];

const money = (v: number, digits = 2) =>
  v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const signedMoney = (v: number) =>
  `${v >= 0 ? "+" : "−"}$${money(Math.abs(v))}`;
const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const cnyFmt = (v: number) => `¥${money(v, 0)}`;

const ACCENT = "#c08a1e";
// 红涨绿跌 (Chinese market convention): gains red, losses green.
const UP = "#cf3a32";
const DOWN = "#128a4c";
const SPX_COLOR = "#5b7a99";
const NDX_COLOR = "#2a7f6f";
const GRID = "#d9dfe6";
const TICK = { fill: "#5d6b78", fontSize: 13 } as const;

const tooltipStyle = {
  backgroundColor: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 14,
} as const;

function dayLabel(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

function fullDate(date: string): string {
  return `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;
}

// Privacy masking, same convention as the main holdings board: the
// amount becomes bullets while the percentage stays visible （红涨绿跌
// coloring is also kept, driven by the real sign).
const MASK = "••••";

function ChangeBadge({
  usd,
  pct,
  masked = false,
}: {
  usd: number | null;
  pct: number | null;
  masked?: boolean;
}) {
  if (usd == null) return <span className="text-[var(--dim)]">—</span>;
  const up = usd >= 0;
  return (
    <span
      className="num inline-block rounded-md px-1.5 py-0.5 font-medium"
      style={{
        color: up ? "var(--up)" : "var(--down)",
        backgroundColor: up
          ? "color-mix(in srgb, var(--up) 13%, transparent)"
          : "color-mix(in srgb, var(--down) 13%, transparent)",
      }}
    >
      {masked ? MASK : signedMoney(usd)}
      {pct != null ? ` (${signedPct(pct)})` : ""}
    </span>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

// One display row for the selected view. For a single account it is
// that account's snapshot; for the global view it is the per-day sum
// across accounts, with `parts` keeping each account's contribution
// visible so the origin of every global row stays auditable.
type ViewRow = {
  date: string;
  label: string;
  usd: number;
  cny: number | null;
  day: number | null;
  dayPct: number | null;
  sec: number;
  cash: number;
  pnl: number | null;
  fx: number | null;
  spx: number | null;
  ndx: number | null;
  parts: { account_id: string; usd: number }[] | null;
};

function sumNullable(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((a, v) => a + v, 0);
}

function firstNonNull(values: (number | null)[]): number | null {
  for (const v of values) if (v != null) return v;
  return null;
}

function buildRows(snaps: Snapshot[], view: string): ViewRow[] {
  if (view !== "global") {
    return snaps
      .filter((s) => s.account_id === view)
      .map((s) => ({
        date: s.date,
        label: dayLabel(s.date),
        usd: s.account_value_usd,
        cny: s.account_value_cny,
        day: s.day_change_usd,
        dayPct: s.day_change_pct,
        sec: s.securities_value_usd,
        cash: s.cash_usd,
        pnl: s.total_pnl_usd,
        fx: s.fx_rate,
        spx: s.spx_price,
        ndx: s.ndx_price,
        parts: null,
      }));
  }
  // Global: group every account's snapshot by trading date and sum.
  // A date with records from only some accounts sums just those —
  // history never breaks and nothing is back-filled for an account
  // that had no record that day.
  const byDate = new Map<string, Snapshot[]>();
  for (const s of snaps) {
    const group = byDate.get(s.date);
    if (group) group.push(s);
    else byDate.set(s.date, [s]);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, group]) => {
      const usd = group.reduce((a, s) => a + s.account_value_usd, 0);
      const day = sumNullable(group.map((s) => s.day_change_usd));
      // Global day-change % is recomputed from the summed amounts:
      // day ÷ (total − day). Summing per-account percentages would
      // be wrong.
      const prevTotal = day != null ? usd - day : null;
      const dayPct =
        day != null && prevTotal != null && prevTotal > 0
          ? (day / prevTotal) * 100
          : null;
      const fx = firstNonNull(group.map((s) => s.fx_rate));
      return {
        date,
        label: dayLabel(date),
        usd,
        // CNY follows the board rule: global total × that day's rate.
        cny: fx != null ? usd * fx : sumNullable(group.map((s) => s.account_value_cny)),
        day,
        dayPct,
        sec: group.reduce((a, s) => a + s.securities_value_usd, 0),
        cash: group.reduce((a, s) => a + s.cash_usd, 0),
        pnl: sumNullable(group.map((s) => s.total_pnl_usd)),
        fx,
        spx: firstNonNull(group.map((s) => s.spx_price)),
        ndx: firstNonNull(group.map((s) => s.ndx_price)),
        parts: group.map((s) => ({
          account_id: s.account_id,
          usd: s.account_value_usd,
        })),
      };
    });
}

const VIEW_STORAGE_KEY = "history-account-view";
const PRIVACY_STORAGE_KEY = "history-privacy";

export function App() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["history"],
    queryFn: () => api.getHistory({}),
    // Cold start can hit a not-yet-ready server on the very first
    // request: opening from the library did this first, and opening
    // from the sidebar does it again with an even slower wake-up, so
    // a short retry window runs out and the board sits on "加载失败".
    // Keep retrying with backoff for a long window (~75s total)
    // before ever surfacing an error, so a first open eventually
    // renders data instead of a failure.
    retry: 10,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
    refetchOnReconnect: true,
  });
  const data = query.data;

  // If the first load still ends in the error state (server slower to
  // wake than the whole retry window), recover on its own instead of
  // leaving a dead error screen: refetch when the board becomes
  // visible again, when connectivity returns, and on a slow timer.
  // The manual 重新加载 button stays as an immediate fallback.
  // Stall watchdog for the first load: the retry policy above only
  // engages when a request actually settles as a failure. A request
  // that hangs inside the webview (never reaches the server, promise
  // never settles — the failure mode suspected from the 2026-11-11
  // todo-board incident) would otherwise leave this board on
  // "正在加载" forever: no retry, no error state, no recovery. While
  // the first load is still pending, periodically cancel the stuck
  // fetch and start a fresh one; the query stays in the loading
  // state throughout, so no error is shown for a stall.
  const queryIsPending = query.isPending;
  useEffect(() => {
    if (!queryIsPending) return;
    const kickStalled = async () => {
      try {
        await queryClient.cancelQueries({ queryKey: ["history"] });
        await queryClient.invalidateQueries({ queryKey: ["history"] });
      } catch {
        // A failed kick is harmless: the interval fires again.
      }
    };
    const timer = window.setInterval(() => {
      void kickStalled();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [queryIsPending, queryClient]);

  const queryIsError = query.isError;
  useEffect(() => {
    if (!queryIsError) return;
    const kick = () => {
      void queryClient.invalidateQueries({ queryKey: ["history"] });
    };
    const timer = window.setInterval(kick, 15000);
    const onVisible = () => {
      if (document.visibilityState === "visible") kick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", kick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", kick);
    };
  }, [queryIsError, queryClient]);

  // First load on an empty board: write the demo seed
  // record, exactly once per mount.
  const seed = useMutation({
    mutationFn: () => api.seedDemoRecord({}),
    retry: 3,
    retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 8000),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["history"] });
    },
  });
  const seedTried = useRef(false);
  useEffect(() => {
    if (data && data.history.length === 0 && !seedTried.current) {
      seedTried.current = true;
      seed.mutate();
    }
  }, [data, seed]);

  const [currency, setCurrency] = useState<"usd" | "cny">("usd");

  // Selected account view: "global" or an account id. Remembered
  // across opens, mirroring the main holdings board's account tabs.
  const [view, setView] = useState<string>(() => {
    try {
      return localStorage.getItem(VIEW_STORAGE_KEY) ?? "global";
    } catch {
      return "global";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      // Storage unavailable (private mode): the tab still works for
      // this session, it just isn't remembered.
    }
  }, [view]);

  // Privacy mode: hides every account-specific amount (percentages,
  // dates, record counts and public index closes stay visible).
  // Remembered across opens, mirroring the main holdings board.
  const [privacy, setPrivacy] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PRIVACY_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(PRIVACY_STORAGE_KEY, privacy ? "1" : "0");
    } catch {
      // Storage unavailable: the toggle still works for this session.
    }
  }, [privacy]);
  const mask = (s: string) => (privacy ? MASK : s);

  const accounts = data?.accounts ?? [];
  const accountName = (id: string) =>
    accounts.find((a) => a.id === id)?.name ?? id;
  const viewName = view === "global" ? "全局" : accountName(view);

  const hist = useMemo(() => {
    if (!data || data.history.length === 0) return null;
    const rows = buildRows(data.history, view);
    if (rows.length === 0) return null;
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return null;
    const baseSpx = rows.find((r) => r.spx != null)?.spx ?? null;
    const baseNdx = rows.find((r) => r.ndx != null)?.ndx ?? null;
    const chart = rows.map((r) => ({
      ...r,
      acctIdx: (r.usd / first.usd) * 100,
      spxIdx: r.spx != null && baseSpx != null ? (r.spx / baseSpx) * 100 : null,
      ndxIdx: r.ndx != null && baseNdx != null ? (r.ndx / baseNdx) * 100 : null,
    }));
    const cum = last.usd - first.usd;
    const peak = Math.max(...rows.map((r) => r.usd));
    const dayRows = rows.filter((r) => r.day != null);
    const best = dayRows.reduce<(typeof rows)[number] | null>(
      (a, r) => (a == null || (r.day ?? 0) > (a.day ?? 0) ? r : a),
      null,
    );
    const worst = dayRows.reduce<(typeof rows)[number] | null>(
      (a, r) => (a == null || (r.day ?? 0) < (a.day ?? 0) ? r : a),
      null,
    );
    return {
      rows: chart,
      days: rows.length,
      first,
      last,
      cum,
      cumPct: first.usd > 0 ? (cum / first.usd) * 100 : 0,
      peak,
      drawdownPct: peak > 0 ? ((last.usd - peak) / peak) * 100 : 0,
      best,
      worst,
    };
  }, [data, view]);

  const viewHasNoRecords =
    data != null &&
    data.history.length > 0 &&
    view !== "global" &&
    !data.history.some((s) => s.account_id === view);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10">
        {(query.isPending || (query.error && query.isFetching)) && (
          <p className="py-16 text-center text-sm text-[var(--dim)]">
            正在加载账户历史…
          </p>
        )}
        {query.error && !query.isFetching && (
          <div className="py-16 text-center">
            <p className="text-sm" style={{ color: "#cf3a32" }}>加载失败，正在自动重试；也可以点下方按钮立即重试。</p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium"
            >
              重新加载
            </button>
          </div>
        )}

        {data && (
          <div
            className="mt-3 flex gap-1 rounded-[var(--radius)] bg-[var(--surface)] p-1"
            role="tablist"
            aria-label="账户切换"
          >
            {[{ id: "global", name: "全局" }, ...accounts].map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={view === a.id}
                onClick={() => setView(a.id)}
                className="flex-1 rounded-md px-3 py-2 text-base font-medium"
                style={
                  view === a.id
                    ? { backgroundColor: "var(--accent)", color: "#000" }
                    : { color: "var(--dim)" }
                }
              >
                {a.name}
              </button>
            ))}
          </div>
        )}

        {data && data.history.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-base font-medium">还没有账户记录</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--dim)]">
              写入第一条示例记录（虚构数据）：示例账户总值 $10,000.00。之后每个交易日由主看板按账户同步写入。
            </p>
            <button
              type="button"
              disabled={seed.isPending}
              onClick={() => seed.mutate()}
              className="mt-5 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
            >
              写入首条记录
            </button>
          </div>
        )}

        {viewHasNoRecords && (
          <div className="py-16 text-center">
            <p className="text-base font-medium">{viewName}暂无记录</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--dim)]">
              {viewName}账户还没有每日快照，待数据录入后从录入当天开始积累；此前全局视图只包含已有记录的账户。
            </p>
          </div>
        )}

        {data && hist && (
          <>
            {/* Latest total + headline stats */}
            <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-[var(--dim)]">
                    最新总值（{viewName}） ·{" "}
                    <span className="whitespace-nowrap">
                      {fullDate(hist.last.date)}
                    </span>
                  </p>
                  <p className="num mt-1 text-2xl font-semibold leading-tight">
                    {mask(`$${money(hist.last.usd)}`)}
                  </p>
                  {hist.last.cny != null && (
                    <p className="num mt-1 whitespace-nowrap text-sm text-[var(--dim)]">
                      ≈ {mask(cnyFmt(hist.last.cny))}
                      {hist.last.fx != null && (
                        <span className="ml-1.5 text-[13px]">
                          （汇率 {hist.last.fx.toFixed(3)}）
                        </span>
                      )}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-base">
                    <span className="text-[var(--dim)]">当日</span>
                    <ChangeBadge
                      usd={hist.last.day}
                      pct={hist.last.dayPct}
                      masked={privacy}
                    />
                    {hist.last.pnl != null && (
                      <span className="text-[var(--dim)]">
                        总浮盈亏{" "}
                        <span
                          className="num"
                          style={{
                            color:
                              hist.last.pnl >= 0
                                ? "var(--up)"
                                : "var(--down)",
                          }}
                        >
                          {mask(signedMoney(hist.last.pnl))}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-1 flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPrivacy((p) => !p)}
                    aria-pressed={privacy}
                    aria-label={privacy ? "关闭隐私模式" : "开启隐私模式"}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-2"
                    style={privacy ? { color: "var(--accent)" } : undefined}
                  >
                    <EyeIcon off={privacy} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void query.refetch()}
                    disabled={query.isFetching}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-base disabled:opacity-50"
                  >
                    {query.isFetching ? "刷新中…" : "刷新"}
                  </button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3">
                  <p className="text-sm text-[var(--dim)]">记录天数</p>
                  <p className="num mt-1 text-lg font-medium">{hist.days} 天</p>
                  <p className="whitespace-nowrap text-[13px] text-[var(--dim)]">
                    自 {fullDate(hist.first.date)}
                  </p>
                </div>
                <div className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3">
                  <p className="text-sm text-[var(--dim)]">累计变化</p>
                  <p
                    className="num mt-1 text-lg font-medium"
                    style={{
                      color: hist.cum >= 0 ? "var(--up)" : "var(--down)",
                    }}
                  >
                    {mask(signedMoney(hist.cum))}
                  </p>
                  <p
                    className="num text-sm"
                    style={{
                      color: hist.cum >= 0 ? "var(--up)" : "var(--down)",
                    }}
                  >
                    {signedPct(hist.cumPct)}
                  </p>
                </div>
                <div className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3">
                  <p className="text-sm text-[var(--dim)]">历史最高</p>
                  <p className="num mt-1 text-lg font-medium">
                    {mask(`$${money(hist.peak, 0)}`)}
                  </p>
                  <p className="num text-sm text-[var(--dim)]">
                    距高点 {hist.drawdownPct.toFixed(2)}%
                  </p>
                </div>
                <div className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3">
                  <p className="text-sm text-[var(--dim)]">证券市值</p>
                  <p className="num mt-1 text-lg font-medium">
                    {mask(`$${money(hist.last.sec)}`)}
                  </p>
                  <p className="num text-sm text-[var(--dim)]">
                    占比{" "}
                    {hist.last.usd > 0
                      ? ((hist.last.sec / hist.last.usd) * 100).toFixed(1)
                      : "—"}
                    %
                  </p>
                </div>
                <div className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3">
                  <p className="text-sm text-[var(--dim)]">最好单日</p>
                  {hist.best?.day != null ? (
                    <>
                      <p
                        className="num mt-1 text-lg font-medium"
                        style={{
                          color:
                            hist.best.day >= 0 ? "var(--up)" : "var(--down)",
                        }}
                      >
                        {mask(signedMoney(hist.best.day))}
                      </p>
                      <p className="whitespace-nowrap text-[13px] text-[var(--dim)]">
                        {fullDate(hist.best.date)}
                      </p>
                    </>
                  ) : (
                    <p className="num mt-1 text-lg font-medium">—</p>
                  )}
                </div>
                <div className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3">
                  <p className="text-sm text-[var(--dim)]">最差单日</p>
                  {hist.worst?.day != null ? (
                    <>
                      <p
                        className="num mt-1 text-lg font-medium"
                        style={{
                          color:
                            hist.worst.day >= 0
                              ? "var(--up)"
                              : "var(--down)",
                        }}
                      >
                        {mask(signedMoney(hist.worst.day))}
                      </p>
                      <p className="whitespace-nowrap text-[13px] text-[var(--dim)]">
                        {fullDate(hist.worst.date)}
                      </p>
                    </>
                  ) : (
                    <p className="num mt-1 text-lg font-medium">—</p>
                  )}
                </div>
              </div>
            </section>

            {/* Account value curve */}
            <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">总值走势</h2>
                <div
                  className="flex overflow-hidden rounded-md border border-[var(--border)]"
                  role="group"
                  aria-label="曲线币种"
                >
                  {(
                    [
                      ["usd", "美元"],
                      ["cny", "人民币"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={currency === k}
                      onClick={() => setCurrency(k)}
                      className="px-3 py-1.5 text-sm font-medium"
                      style={
                        currency === k
                          ? {
                              backgroundColor: "var(--accent)",
                              color: "#000",
                            }
                          : { color: "var(--dim)" }
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={hist.rows}
                    margin={{ top: 6, right: 8, bottom: 0, left: 8 }}
                  >
                    <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                    <XAxis dataKey="label" tick={TICK} tickLine={false} />
                    <YAxis
                      tick={TICK}
                      tickLine={false}
                      width={72}
                      domain={["auto", "auto"]}
                      tickFormatter={(v: number) =>
                        privacy
                          ? MASK
                          : currency === "usd"
                            ? `$${money(v, 0)}`
                            : `¥${money(v, 0)}`
                      }
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value) => [
                        privacy
                          ? MASK
                          : currency === "usd"
                            ? `$${money(Number(value))}`
                            : cnyFmt(Number(value)),
                        currency === "usd" ? "总值（美元）" : "总值（人民币）",
                      ]}
                      labelFormatter={(label) => `${label}（月/日）`}
                    />
                    <Line
                      type="monotone"
                      dataKey={currency}
                      stroke={ACCENT}
                      strokeWidth={2.5}
                      dot={{ r: 4 }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Daily change bars */}
            <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <h2 className="text-lg font-semibold">每日涨跌</h2>
              <div className="mt-3 h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={hist.rows}
                    margin={{ top: 6, right: 8, bottom: 0, left: 8 }}
                  >
                    <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                    <XAxis dataKey="label" tick={TICK} tickLine={false} />
                    <YAxis
                      tick={TICK}
                      tickLine={false}
                      width={72}
                      tickFormatter={(v: number) =>
                        privacy ? MASK : `$${money(v, 0)}`
                      }
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value) => [
                        privacy ? MASK : signedMoney(Number(value)),
                        "当日变化",
                      ]}
                      labelFormatter={(label) => `${label}（月/日）`}
                    />
                    <Bar dataKey="day" radius={[3, 3, 0, 0]}>
                      {hist.rows.map((r) => (
                        <Cell
                          key={r.date}
                          fill={(r.day ?? 0) >= 0 ? UP : DOWN}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Securities vs cash structure */}
            <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <h2 className="text-lg font-semibold">证券与现金结构</h2>
              <div className="mt-2 flex gap-4 text-sm text-[var(--dim)]">
                <span>
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                    style={{ backgroundColor: ACCENT }}
                  />
                  证券市值
                </span>
                <span>
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                    style={{ backgroundColor: SPX_COLOR }}
                  />
                  现金
                </span>
              </div>
              <div className="mt-2 h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={hist.rows}
                    margin={{ top: 6, right: 8, bottom: 0, left: 8 }}
                  >
                    <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                    <XAxis dataKey="label" tick={TICK} tickLine={false} />
                    <YAxis
                      tick={TICK}
                      tickLine={false}
                      width={72}
                      domain={[0, "dataMax"]}
                      tickFormatter={(v: number) =>
                        privacy ? MASK : `$${money(v, 0)}`
                      }
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value, name) => [
                        privacy ? MASK : `$${money(Number(value))}`,
                        name === "sec" ? "证券市值" : "现金",
                      ]}
                      labelFormatter={(label) => `${label}（月/日）`}
                    />
                    <Area
                      type="monotone"
                      dataKey="sec"
                      stackId="1"
                      stroke={ACCENT}
                      fill={ACCENT}
                      fillOpacity={0.75}
                      dot={{ r: 3 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="cash"
                      stackId="1"
                      stroke={SPX_COLOR}
                      fill={SPX_COLOR}
                      fillOpacity={0.55}
                      dot={{ r: 3 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Account vs benchmarks, normalized to 100 */}
            <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <h2 className="text-lg font-semibold">与大盘对比（起点 = 100）</h2>
              <div className="mt-2 flex flex-wrap gap-4 text-sm text-[var(--dim)]">
                <span>
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                    style={{ backgroundColor: ACCENT }}
                  />
                  {view === "global" ? "全部账户" : viewName}
                </span>
                <span>
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                    style={{ backgroundColor: SPX_COLOR }}
                  />
                  标普500
                </span>
                <span>
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                    style={{ backgroundColor: NDX_COLOR }}
                  />
                  纳指100
                </span>
              </div>
              <div className="mt-2 h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={hist.rows}
                    margin={{ top: 6, right: 8, bottom: 0, left: 8 }}
                  >
                    <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                    <XAxis dataKey="label" tick={TICK} tickLine={false} />
                    <YAxis
                      tick={TICK}
                      tickLine={false}
                      width={48}
                      domain={["auto", "auto"]}
                      tickFormatter={(v: number) => v.toFixed(1)}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value, name) => [
                        Number(value).toFixed(2),
                        name === "acctIdx"
                          ? view === "global"
                            ? "全部账户"
                            : viewName
                          : name === "spxIdx"
                            ? "标普500"
                            : "纳指100",
                      ]}
                      labelFormatter={(label) => `${label}（月/日）`}
                    />
                    <Line
                      type="monotone"
                      dataKey="acctIdx"
                      stroke={ACCENT}
                      strokeWidth={2.5}
                      dot={{ r: 4 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="spxIdx"
                      stroke={SPX_COLOR}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="ndxIdx"
                      stroke={NDX_COLOR}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Daily detail table */}
            <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <h2 className="text-lg font-semibold">每日明细</h2>
              <div className="mt-3 hidden overflow-x-auto md:block">
                <table className="w-full text-base">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-sm text-[var(--dim)]">
                      <th className="py-2 pr-2 font-medium">交易日</th>
                      <th className="py-2 pr-2 text-right font-medium">总值</th>
                      <th className="py-2 pr-2 text-right font-medium">
                        当日变化
                      </th>
                      <th className="py-2 pr-2 text-right font-medium">证券</th>
                      <th className="py-2 pr-2 text-right font-medium">现金</th>
                      <th className="py-2 pr-2 text-right font-medium">
                        总浮盈亏
                      </th>
                      <th className="py-2 pr-2 text-right font-medium">
                        标普500
                      </th>
                      <th className="py-2 text-right font-medium">纳指100</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...hist.rows].reverse().map((r) => (
                      <tr
                        key={r.date}
                        className="border-b border-[var(--border)] last:border-0"
                      >
                        <td className="num whitespace-nowrap py-2 pr-2">
                          {r.date}
                          {r.parts && (
                            <div className="whitespace-nowrap text-sm font-normal text-[var(--dim)]">
                              {r.parts
                                .map(
                                  (p) =>
                                    `${accountName(p.account_id)} ${mask(`$${money(p.usd, 0)}`)}`,
                                )
                                .join(" · ")}
                            </div>
                          )}
                        </td>
                        <td className="num whitespace-nowrap py-2 pr-2 text-right font-medium">
                          {mask(`$${money(r.usd)}`)}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-2 text-right">
                          <ChangeBadge
                            usd={r.day}
                            pct={r.dayPct}
                            masked={privacy}
                          />
                        </td>
                        <td className="num whitespace-nowrap py-2 pr-2 text-right">
                          {mask(`$${money(r.sec)}`)}
                        </td>
                        <td className="num whitespace-nowrap py-2 pr-2 text-right">
                          {mask(`$${money(r.cash)}`)}
                        </td>
                        <td
                          className="num whitespace-nowrap py-2 pr-2 text-right"
                          style={{
                            color:
                              r.pnl == null
                                ? "var(--dim)"
                                : r.pnl >= 0
                                  ? "var(--up)"
                                  : "var(--down)",
                          }}
                        >
                          {r.pnl != null ? mask(signedMoney(r.pnl)) : "—"}
                        </td>
                        <td className="num py-2 pr-2 text-right">
                          {r.spx != null ? money(r.spx) : "—"}
                        </td>
                        <td className="num py-2 text-right">
                          {r.ndx != null ? money(r.ndx) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="mt-2 space-y-2 md:hidden">
                {[...hist.rows].reverse().map((r) => (
                  <li
                    key={r.date}
                    className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="num whitespace-nowrap font-medium">
                        {r.date}
                      </span>
                      <span className="num whitespace-nowrap text-lg font-semibold">
                        {mask(`$${money(r.usd)}`)}
                      </span>
                    </div>
                    {r.parts && (
                      <p className="num mt-1 whitespace-nowrap text-sm text-[var(--dim)]">
                        {r.parts
                          .map(
                            (p) =>
                              `${accountName(p.account_id)} ${mask(`$${money(p.usd, 0)}`)}`,
                          )
                          .join(" · ")}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--dim)]">
                      <ChangeBadge
                        usd={r.day}
                        pct={r.dayPct}
                        masked={privacy}
                      />
                      <span className="num">
                        证券 {mask(`$${money(r.sec, 0)}`)}
                      </span>
                      <span className="num">
                        现金 {mask(`$${money(r.cash, 0)}`)}
                      </span>
                      {r.pnl != null && (
                        <span
                          className="num"
                          style={{
                            color: r.pnl >= 0 ? "var(--up)" : "var(--down)",
                          }}
                        >
                          浮盈亏 {mask(signedMoney(r.pnl))}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <p className="mt-4 text-xs leading-relaxed text-[var(--dim)]">
              口径：按美股交易日记录，常规时段收盘价；每日快照由主看板按账户同步写入，本页不含个股数据；全局为同一天各账户之和，某账户当天无记录时只计入有记录的账户；人民币仅在总值处换算。
            </p>
          </>
        )}
      </main>
    </div>
  );
}

// Referenced so the Snapshot type stays part of the module's public
// surface for future panels.
export type { Snapshot };
