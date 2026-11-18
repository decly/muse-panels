// 看板 · A股持仓 — single-account A-share (CNY) holdings board.
// Mirrors the US board's structure: benchmark strip → overview →
// holdings (standard / table) → concentration → trade ledger →
// in-board history → data backup. All amounts ¥, 红涨绿跌， official
// basis is the regular-session close; the board starts empty and
// shows 等待录入 states until the user records holdings / cash.

import {
Fragment,
useEffect,
useRef,
useState,
type FormEvent,
type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
Area,
AreaChart,
Bar,
CartesianGrid,
Cell,
ComposedChart,
Label,
Line,
LineChart,
ReferenceDot,
ReferenceLine,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";

type Board = ApiResponse<typeof api, "getBoard">;
type Holding = Board["holdings"][number];
type Snapshot = Board["history"][number];
type TradesData = ApiResponse<typeof api, "getTrades">;
type TradeRow = TradesData["trades"][number];

// ---------- formatting ----------

const fmtMoney = (v: number, digits = 2) =>
  `¥${v.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;

const fmtSignedMoney = (v: number) =>
  `${v >= 0 ? "+" : "−"}${fmtMoney(Math.abs(v))}`;

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

const fmtQty = (v: number) =>
  v.toLocaleString("zh-CN", { maximumFractionDigits: 4 });

const fmtPrice = (v: number) =>
  v.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });

// 红涨绿跌： positive → red (--up), negative → green (--down).
function moveColor(v: number | null | undefined): string | undefined {
  if (v == null || v === 0) return undefined;
  return v > 0 ? "var(--up)" : "var(--down)";
}

function fmtFetchedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

function beijingToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDate(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
function weekdayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return WEEKDAYS[d.getDay()] ?? "";
}

// ---------- display names (code-first) ----------
//
// The 6-digit code is the primary identifier everywhere; names render
// as short display names. The stored name (broker name, overwritten
// by the Eastmoney quote name on every refresh) is never shown raw:
// a code → short-name map wins, and a generic shortening pass covers
// holdings not in the map.
const DISPLAY_NAME_MAP: Record<string, string> = {
  "513100": "纳指100ETF示例甲",
  "159941": "纳指100ETF示例乙",
  "513300": "纳指ETF示例",
  "164906": "中概互联ETF示例",
  "159338": "中证A500ETF示例",
};

function displayName(symbol: string, name: string): string {
  const mapped = DISPLAY_NAME_MAP[symbol];
  if (mapped) return mapped;
  return name
    .replace(/纳斯达克/g, "纳指")
    .replace(/互联网/g, "互联");
}

// ---------- first-load resilience (shared policy with the other boards) ----------

// Retry up to 3 failures with exponential backoff; a stalled request
// (one that never settles) is re-issued by the 30-second watchdog in
// App below.
const firstLoadRetry = (failureCount: number) => failureCount < 3;
const firstLoadRetryDelay = (attempt: number) =>
  Math.min(1000 * 2 ** attempt, 8000);

function useLocalBool(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : raw === "1";
    } catch {
      return initial;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      // storage unavailable; state still applies for this session
    }
  };
  return [value, set];
}

// ---------- small pieces ----------

function Pct({ v, className = "" }: { v: number | null; className?: string }) {
  if (v == null) return <span className={className}>—</span>;
  return (
    <span className={className} style={{ color: moveColor(v) }}>
      {fmtPct(v)}
    </span>
  );
}

// ---------- stale quotes ----------
//
// A refresh can partially fail (Eastmoney drops individual
// per-instrument requests): the failed holdings keep their previous
// session's price / 涨跌幅 while everything else updates, and the
// board-level 刷新于 stamp still shows the current time. To keep that
// from passing as fresh data, a holding whose quote_date is older
// than the newest quote_date on the board is marked 旧报价 wherever
// its numbers render. On a non-trading day every quote shares the
// same (last session) date, so nothing is marked.
const STALE_COLOR = "#d97706";

function fmtQuoteDate(d: string): string {
  // "2026-11-13" -> "11/13"
  return d.slice(5).replace("-", "/");
}

function latestHoldingQuoteDate(board: Board): string | null {
  let latest: string | null = null;
  for (const h of board.holdings) {
    const d = h.quote?.quote_date;
    if (d && (latest == null || d > latest)) latest = d;
  }
  return latest;
}

function isStaleQuote(h: Holding, latest: string | null): boolean {
  return (
    h.quote?.quote_date != null &&
    latest != null &&
    h.quote.quote_date < latest
  );
}

function StaleTag({ date, className = "" }: { date: string; className?: string }) {
  return (
    <span
      className={className}
      style={{ color: STALE_COLOR }}
      title="该持仓未随最近一次刷新更新，仍为旧报价"
    >
      旧报价 {fmtQuoteDate(date)}
    </span>
  );
}

function SectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mt-7 mb-2 flex items-baseline justify-between gap-2">
      <h2 className="text-base font-semibold">{children}</h2>
      {right}
    </div>
  );
}

// ---------- sticky section nav ----------
//
// Lightweight jump bar: five section anchors in board order. It lives
// in its own fixed layer (outside the market strip, so its clicks can
// never trigger the strip's collapse toggle), stays hidden while the
// page is at the very top so it costs no screen height, and fades in
// as soon as the user starts scrolling down. No scrollspy — plain
// smooth-scroll jumps to the section anchors (each carries a
// scroll-margin-top so its title lands clear of the bar).
const NAV_ITEMS = [
  { id: "sec-overview", label: "总览" },
  { id: "sec-holdings", label: "持仓" },
  { id: "sec-concentration", label: "集中度" },
  { id: "sec-history", label: "走势" },
  { id: "sec-trades", label: "流水" },
] as const;

function StickyNav() {
  const navRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // The shell scrolls the page inside the fixed
    // [data-generated-space-root] container, not the window — listen
    // to that scroller (window.scrollY never moves here).
    const scroller = navRef.current?.closest<HTMLElement>(
      "[data-generated-space-root]",
    );
    if (!scroller) return;
    const onScroll = () => {
      // Show as soon as the page starts scrolling down; the small
      // 8px margin avoids flicker from rubber-band bounce at the top.
      setVisible(scroller.scrollTop > 8);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "start",
    });
  };

  return (
    <nav
      ref={navRef}
      aria-label="板块导航"
      aria-hidden={!visible}
      className="fixed inset-x-0 z-50 transition-all duration-200"
      style={{
        top: "env(safe-area-inset-top, 0px)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(-100%)",
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <div
        className="mx-auto flex h-[34px] max-w-5xl items-stretch justify-between border-b border-[var(--border)] px-2 backdrop-blur-md sm:justify-start sm:gap-1 sm:px-4"
        style={{
          backgroundColor:
            "color-mix(in srgb, var(--bg) 82%, transparent)",
        }}
      >
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            tabIndex={visible ? 0 : -1}
            aria-label={`跳转到${item.label}`}
            onClick={() => jump(item.id)}
            className="flex-1 text-[13px] text-[var(--text)] sm:flex-none sm:px-3"
          >
            {item.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

// ---------- market strip ----------

function MarketStrip({ market }: { market: Board["market"] }) {
  const [collapsed, setCollapsed] = useLocalBool(
    "agu-board-market-collapsed",
    false,
  );
  const shown = collapsed
    ? market.filter((m) => m.key === "SSE" || m.key === "CSIA500")
    : market;
  return (
    // The whole strip is the collapse toggle (same behaviour as the
    // US board): clicking anywhere — the header or any benchmark row —
    // folds it to exactly the first two rows （上证指数 / 中证A500) or
    // expands it back to all ten; the choice persists. The header button has no
    // onClick of its own; its clicks bubble up to the section.
    <section
      aria-label="行情"
      onClick={() => setCollapsed(!collapsed)}
      className="cursor-pointer"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "展开行情条" : "折叠行情条"}
        className="flex w-full items-center justify-between py-2 text-left"
      >
        <span className="text-xs text-[var(--dim)]">
          行情 {collapsed ? "▸" : "▾"}
        </span>
      </button>
      <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
          {shown.map((m) => {
            const drawdown =
              m.price != null && m.peak3y_price != null && m.peak3y_price > 0
                ? (m.price / m.peak3y_price - 1) * 100
                : null;
            return (
              <li
                key={m.key}
                className="flex items-baseline justify-between gap-2 py-1.5"
              >
                <span className="text-sm">{m.label}</span>
                <span className="tnum flex items-baseline gap-2 text-sm">
                  <span className="w-[4.25rem] text-right font-medium">
                    {m.price != null
                      ? Math.round(m.price).toLocaleString("zh-CN")
                      : "—"}
                  </span>
                  <Pct v={m.change_percent} className="w-14 text-right" />
                  <span className="w-[5.5rem] whitespace-nowrap text-right text-xs text-[var(--dim)]">
                    {drawdown == null
                      ? "距高点 —"
                      : drawdown >= -0.05
                        ? <span style={{ color: "var(--up)" }}>接近3年新高</span>
                        : `距高点 ${drawdown.toFixed(2)}%`}
                  </span>
                </span>
              </li>
            );
          })}
      </ul>
      {market.every((m) => m.price == null) && (
        <p className="py-1 text-xs text-[var(--dim)]">
          暂无行情，点下方「刷新报价」拉取东方财富收盘数据。
        </p>
      )}
    </section>
  );
}

// ---------- totals ----------

type Totals = {
  securities: number;
  cost: number;
  pnl: number;
  pnlPct: number | null;
  dayChange: number | null;
  dayChangePct: number | null;
  total: number | null;
  complete: boolean;
};

function computeTotals(board: Board): Totals {
  let securities = 0;
  let cost = 0;
  let dayChange = 0;
  let dayKnown = board.holdings.length > 0;
  let complete = true;
  for (const h of board.holdings) {
    if (!h.quote) {
      complete = false;
      continue;
    }
    securities += h.quote.price * h.qty;
    cost += h.cost_per_share * h.qty;
    if (h.quote.change == null) dayKnown = false;
    else dayChange += h.quote.change * h.qty;
  }
  const pnl = securities - cost;
  const total = board.cash_cny != null ? securities + board.cash_cny : null;
  // 今日涨跌幅 uses the ACCOUNT-total basis — dayChange ÷ (total −
  // dayChange), cash included — the same 口径 the daily snapshots
  // store (writeSnapshot: dayChange ÷ previous account value) and
  // the 今日页 A股账户 block reports. Dividing by the previous
  // SECURITIES value instead (cash excluded) overstates the move
  // whenever cash is non-trivial, and the overview then disagrees
  // with the snapshot for the identical day-change amount. When
  // cash has not been recorded the account basis cannot be stated,
  // so fall back to the securities-only basis rather than hiding
  // the figure.
  const prevTotal = total != null ? total - dayChange : securities - dayChange;
  return {
    securities,
    cost,
    pnl,
    pnlPct: cost > 0 ? (pnl / cost) * 100 : null,
    dayChange: dayKnown ? dayChange : null,
    dayChangePct:
      dayKnown && prevTotal > 0 ? (dayChange / prevTotal) * 100 : null,
    total,
    complete,
  };
}

// ---------- overview ----------

function Overview({
  board,
  totals,
  privacy,
  setPrivacy,
  mask,
}: {
  board: Board;
  totals: Totals;
  privacy: boolean;
  setPrivacy: (v: boolean) => void;
  mask: (s: string) => string;
}) {
  const queryClient = useQueryClient();
  const [cashEditing, setCashEditing] = useState(false);
  const [cashInput, setCashInput] = useState("");
  // Partial-refresh outcome: the action reports the instruments it
  // could not fetch in `failed`; until now that list was dropped and
  // a refresh that left holdings on old quotes looked identical to a
  // full success. Keep the latest outcome visible under the stamp.
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: async () => await api.refreshQuotes({}),
    onSuccess: (res) => {
      queryClient.setQueryData(["board"], res.board);
      void queryClient.invalidateQueries({ queryKey: ["board"] });
      setRefreshNote(
        res.failed.length > 0
          ? `本次刷新有 ${res.failed.length} 项未取到新报价，仍显示旧值：${res.failed.join("、")}（持仓明细中以「旧报价」标注，可再次刷新）`
          : null,
      );
    },
    onError: () => setRefreshNote(null),
  });
  const cashMutation = useMutation({
    mutationFn: async (v: number | null) => await api.updateCash({ cash_cny: v }),
    onSuccess: () => {
      setCashEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });
  const empty = board.holdings.length === 0 && board.cash_cny == null;
  const fetched = fmtFetchedAt(board.fetched_at);
  const submitCash = (e: FormEvent) => {
    e.preventDefault();
    const v = cashInput.trim() === "" ? null : Number(cashInput);
    if (v != null && (!Number.isFinite(v) || v < 0)) return;
    cashMutation.mutate(v);
  };
  return (
    <section aria-label="总览" id="sec-overview" className="section-anchor">
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-sm text-[var(--dim)]">总览（人民币 · 收盘口径）</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={privacy}
            aria-label="隐私开关"
            onClick={() => setPrivacy(!privacy)}
            className="rounded-md border border-[var(--border)] px-2.5 text-xs"
          >
            {privacy ? "隐私开" : "隐私关"}
          </button>
          <button
            type="button"
            aria-label="刷新报价"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
            className="rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white disabled:opacity-50"
          >
            {refresh.isPending ? "刷新中…" : "刷新报价"}
          </button>
        </span>
      </div>
      <p className="mt-0.5 text-right text-xs text-[var(--dim)]">
        {fetched ? (
          <>
            刷新于{" "}
            {/* Only the time itself is highlighted (user request
                2026-11-17): bold, one size up, in the board's red —
                the surrounding label stays dim so the eye lands on
                the timestamp first and can judge freshness at a
                glance. */}
            <span
              className="tnum text-sm font-bold"
              style={{ color: "var(--up)" }}
            >
              {fetched}
            </span>
            （北京时间）
          </>
        ) : (
          "尚未刷新报价"
        )}
        {refresh.isError ? " · 上次刷新失败，显示已存报价" : ""}
      </p>
      {refreshNote && (
        <p
          className="mt-0.5 text-right text-xs"
          style={{ color: STALE_COLOR }}
          role="status"
        >
          {refreshNote}
        </p>
      )}

      {empty ? (
        <p className="mt-3 border border-dashed border-[var(--border)] px-3 py-4 text-sm text-[var(--dim)]">
          等待录入：暂无持仓与现金记录。券商截图确认后，可在下方「持仓明细」逐笔添加，或由我代为录入。
        </p>
      ) : (
        <>
          <div className="mt-3">
            <span className="text-sm text-[var(--dim)]">总账户值</span>
            {/* Total value deliberately renders one size below the stat
                figures (same rule as the US board, so it is not legible
                at a glance to bystanders); it scales with the rest of
                the overview, never above it. */}
            <span className="tnum ml-2 text-base font-semibold">
              {totals.total != null ? mask(fmtMoney(totals.total)) : "—"}
            </span>
            {totals.total == null && (
              <span className="ml-2 text-sm text-[var(--dim)]">
                （现金未录入，暂不合计）
              </span>
            )}
          </div>
          <dl className="tnum mt-4 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-[var(--border)] pt-4 sm:grid-cols-4">
            <div>
              <dt className="text-sm text-[var(--dim)]">证券市值</dt>
              <dd className="mt-0.5 text-base font-medium whitespace-nowrap sm:text-lg">
                {board.holdings.length === 0
                  ? mask(fmtMoney(0))
                  : totals.complete
                    ? mask(fmtMoney(totals.securities))
                    : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-[var(--dim)]">现金</dt>
              <dd className="mt-0.5 flex items-center gap-2 text-base font-medium whitespace-nowrap sm:text-lg">
                {board.cash_cny != null ? mask(fmtMoney(board.cash_cny)) : "未录入"}
                {!cashEditing && (
                  <button
                    type="button"
                    aria-label="修改现金"
                    onClick={() => {
                      setCashInput(
                        board.cash_cny != null ? String(board.cash_cny) : "",
                      );
                      setCashEditing(true);
                    }}
                    className="text-xs font-normal text-[var(--accent)] underline"
                  >
                    修改
                  </button>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-[var(--dim)]">总浮盈亏</dt>
              <dd
                className="mt-0.5 text-base font-medium whitespace-nowrap sm:text-lg"
                style={{ color: moveColor(totals.pnl) }}
              >
                {board.holdings.length === 0 || !totals.complete ? (
                  "—"
                ) : (
                  <>
                    {mask(fmtSignedMoney(totals.pnl))}
                    {totals.pnlPct != null && (
                      <span className="block text-sm font-normal">
                        {fmtPct(totals.pnlPct)}
                      </span>
                    )}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-[var(--dim)]">今日涨跌</dt>
              <dd
                className="mt-0.5 text-base font-medium whitespace-nowrap sm:text-lg"
                style={{ color: moveColor(totals.dayChange) }}
              >
                {totals.dayChange == null ? (
                  "—"
                ) : (
                  <>
                    {mask(fmtSignedMoney(totals.dayChange))}
                    {totals.dayChangePct != null && (
                      <span className="block text-sm font-normal">
                        {fmtPct(totals.dayChangePct)}
                      </span>
                    )}
                  </>
                )}
              </dd>
            </div>
          </dl>
          {cashEditing && (
            <form
              onSubmit={submitCash}
              className="mt-2 flex flex-wrap items-center gap-2"
            >
              <label className="text-xs text-[var(--dim)]" htmlFor="cash-input">
                现金（元，留空 = 清除）
              </label>
              <input
                id="cash-input"
                aria-label="现金金额"
                inputMode="decimal"
                value={cashInput}
                onChange={(e) => setCashInput(e.target.value)}
                className="tnum w-36 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
              />
              <button
                type="submit"
                disabled={cashMutation.isPending}
                className="rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white disabled:opacity-50"
              >
                保存现金
              </button>
              <button
                type="button"
                onClick={() => setCashEditing(false)}
                className="rounded-md border border-[var(--border)] px-3 text-xs"
              >
                取消
              </button>
            </form>
          )}
          {!totals.complete && board.holdings.length > 0 && (
            <p className="mt-2 text-xs text-[var(--dim)]">
              部分持仓尚无报价，点「刷新报价」补齐后再显示合计。
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ---------- holdings ----------

type HoldingRow = Holding & {
  mv: number | null;
  pnl: number | null;
  pnlPct: number | null;
  share: number | null;
  dayPnl: number | null;
};

function enrichHoldings(board: Board, totals: Totals): HoldingRow[] {
  const basis = totals.total ?? totals.securities;
  return board.holdings.map((h) => {
    const mv = h.quote ? h.quote.price * h.qty : null;
    const cost = h.cost_per_share * h.qty;
    const pnl = mv != null ? mv - cost : null;
    return {
      ...h,
      mv,
      pnl,
      pnlPct: pnl != null && cost > 0 ? (pnl / cost) * 100 : null,
      share: mv != null && basis > 0 ? (mv / basis) * 100 : null,
      dayPnl: h.quote?.change != null ? h.quote.change * h.qty : null,
    };
  });
}

function HoldingDetail({
  h,
  mask,
  stale,
  onDone,
}: {
  h: HoldingRow;
  mask: (s: string) => string;
  stale: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [qty, setQty] = useState(String(h.qty));
  const [cost, setCost] = useState(String(h.cost_per_share));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["board"] });
    void queryClient.invalidateQueries({ queryKey: ["trades"] });
  };
  const update = useMutation({
    mutationFn: async () =>
      await api.updateHolding({
        id: h.id,
        qty: Number(qty),
        cost_per_share: Number(cost),
      }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: async () => await api.removeHolding({ id: h.id }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = Number(qty);
    const c = Number(cost);
    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(c) || c < 0) return;
    update.mutate();
  };
  return (
    <div className="border-t border-[var(--border)] px-1 py-3">
      <dl className="tnum grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-[var(--dim)]">股数</dt>
          <dd>{mask(fmtQty(h.qty))}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--dim)]">成本价（不遮罩）</dt>
          <dd>{fmtPrice(h.cost_per_share)}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--dim)]">成本金额</dt>
          <dd>{mask(fmtMoney(h.cost_per_share * h.qty))}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--dim)]">今日盈亏</dt>
          <dd style={{ color: moveColor(h.dayPnl) }}>
            {h.dayPnl != null ? mask(fmtSignedMoney(h.dayPnl)) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--dim)]">市值</dt>
          <dd>{h.mv != null ? mask(fmtMoney(h.mv)) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--dim)]">浮盈亏</dt>
          <dd style={{ color: moveColor(h.pnl) }}>
            {h.pnl != null
              ? `${mask(fmtSignedMoney(h.pnl))} (${fmtPct(h.pnlPct ?? 0)})`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--dim)]">市值占比</dt>
          <dd>{h.share != null ? `${h.share.toFixed(2)}%` : "—"}</dd>
        </div>
        {h.quote?.iopv != null && (
          <div>
            <dt className="text-xs text-[var(--dim)]">参考净值（IOPV）</dt>
            <dd>{h.quote.iopv.toFixed(4)}</dd>
          </div>
        )}
        {h.quote?.premium_percent != null && (
          <div>
            <dt className="text-xs text-[var(--dim)]">溢价率</dt>
            <dd>
              <Pct v={h.quote.premium_percent} />
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-[var(--dim)]">报价日期</dt>
          <dd>
            {h.quote?.quote_date ? fmtQuoteDate(h.quote.quote_date) : "—"}
            {stale && (
              <span className="ml-1" style={{ color: STALE_COLOR }}>
                旧报价，未随最近刷新更新
              </span>
            )}
          </dd>
        </div>
      </dl>
      <form
        onSubmit={submit}
        className="mt-3 flex flex-wrap items-end gap-2"
      >
        <label className="text-xs text-[var(--dim)]">
          股数
          <input
            aria-label={`${h.symbol} ${displayName(h.symbol, h.name)} 股数`}
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="tnum mt-0.5 block w-28 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
          />
        </label>
        <label className="text-xs text-[var(--dim)]">
          成本价
          <input
            aria-label={`${h.symbol} ${displayName(h.symbol, h.name)} 成本价`}
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className="tnum mt-0.5 block w-28 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
          />
        </label>
        <button
          type="submit"
          disabled={update.isPending}
          className="rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white disabled:opacity-50"
        >
          保存修改
        </button>
        {confirmDelete ? (
          <button
            type="button"
            aria-label={`确认删除 ${h.symbol} ${displayName(h.symbol, h.name)}`}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            className="rounded-md px-3 text-xs font-medium disabled:opacity-50"
            style={{ color: "var(--up)" }}
          >
            确认删除该持仓？
          </button>
        ) : (
          <button
            type="button"
            aria-label={`删除 ${h.symbol} ${displayName(h.symbol, h.name)}`}
            onClick={() => setConfirmDelete(true)}
            className="rounded-md border border-[var(--border)] px-3 text-xs"
          >
            删除
          </button>
        )}
      </form>
      {(update.isError || remove.isError) && (
        <p className="mt-1 text-xs" style={{ color: "var(--up)" }}>
          保存失败，请重试。
        </p>
      )}
    </div>
  );
}

type SortKey = "stock" | "chg" | "dayPnl" | "premium" | "price" | "cost" | "pnlPct" | "pnl" | "mv" | "costAmt" | "qty" | "share";

function HoldingsSection({
  board,
  totals,
  mask,
}: {
  board: Board;
  totals: Totals;
  mask: (s: string) => string;
}) {
  const queryClient = useQueryClient();
  const [density, setDensity] = useState<"standard" | "table">(() => {
    try {
      return localStorage.getItem("agu-board-density") === "table"
        ? "table"
        : "standard";
    } catch {
      return "standard";
    }
  });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [aSymbol, setASymbol] = useState("");
  const [aName, setAName] = useState("");
  const [aQty, setAQty] = useState("");
  const [aCost, setACost] = useState("");
  const [aKind, setAKind] = useState<"etf" | "fund" | "stock">("etf");
  const [addError, setAddError] = useState<string | null>(null);
  // Table sorting is session-only; the default is always 占比 desc.
  const [sortKey, setSortKey] = useState<SortKey>("share");
  const [sortAsc, setSortAsc] = useState(false);

  const rows = enrichHoldings(board, totals);
  const byShare = [...rows].sort((a, b) => (b.share ?? -1) - (a.share ?? -1));
  const latestQuoteDate = latestHoldingQuoteDate(board);

  const pickDensity = (d: "standard" | "table") => {
    setDensity(d);
    try {
      localStorage.setItem("agu-board-density", d);
    } catch {
      // ignore
    }
  };

  const add = useMutation({
    mutationFn: async () =>
      await api.addHolding({
        symbol: aSymbol.trim(),
        name: aName.trim() || aSymbol.trim(),
        qty: Number(aQty),
        cost_per_share: Number(aCost),
        kind: aKind,
      }),
    onSuccess: () => {
      setShowAdd(false);
      setASymbol("");
      setAName("");
      setAQty("");
      setACost("");
      setAddError(null);
      void queryClient.invalidateQueries({ queryKey: ["board"] });
      void queryClient.invalidateQueries({ queryKey: ["trades"] });
    },
    onError: (e) => setAddError(e instanceof Error ? e.message : String(e)),
  });
  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(aSymbol.trim())) {
      setAddError("代码须为 6 位数字");
      return;
    }
    const q = Number(aQty);
    const c = Number(aCost);
    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(c) || c < 0) {
      setAddError("股数须大于 0，成本价不小于 0");
      return;
    }
    add.mutate();
  };

  const sortValue = (h: HoldingRow, key: SortKey): number | string | null => {
    switch (key) {
      case "stock":
        return h.symbol;
      case "chg":
        return h.quote?.change_percent ?? null;
      case "dayPnl":
        return h.dayPnl;
      case "premium":
        return h.quote?.premium_percent ?? null;
      case "price":
        return h.quote?.price ?? null;
      case "cost":
        return h.cost_per_share;
      case "pnlPct":
        return h.pnlPct;
      case "pnl":
        return h.pnl;
      case "mv":
        return h.mv;
      case "costAmt":
        return h.cost_per_share * h.qty;
      case "qty":
        return h.qty;
      case "share":
        return h.share;
    }
  };
  const tableRows = [...rows].sort((a, b) => {
    const va = sortValue(a, sortKey);
    const vb = sortValue(b, sortKey);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp =
      typeof va === "string" ? va.localeCompare(String(vb)) : va - Number(vb);
    return sortAsc ? cmp : -cmp;
  });
  const clickSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const columns: { key: SortKey; label: string; masked?: boolean }[] = [
    { key: "stock", label: "股票" },
    { key: "chg", label: "涨跌幅" },
    { key: "dayPnl", label: "今日盈亏", masked: true },
    { key: "premium", label: "溢价率" },
    { key: "price", label: "现价" },
    { key: "cost", label: "成本价" },
    { key: "pnlPct", label: "浮盈亏%" },
    { key: "pnl", label: "浮盈亏", masked: true },
    { key: "mv", label: "市值", masked: true },
    { key: "costAmt", label: "成本", masked: true },
    { key: "qty", label: "股数", masked: true },
    { key: "share", label: "占比" },
  ];
  const cell = (h: HoldingRow, key: SortKey): ReactNode => {
    switch (key) {
      case "stock":
        return (
          <span>
            <span className="tnum block font-bold whitespace-nowrap">
              {h.symbol}
            </span>
            <span className="block max-w-[8rem] truncate text-xs text-[var(--dim)]">
              {displayName(h.symbol, h.name)}
            </span>
            {isStaleQuote(h, latestQuoteDate) && h.quote?.quote_date && (
              <StaleTag date={h.quote.quote_date} className="block text-xs" />
            )}
          </span>
        );
      case "chg":
        return <Pct v={h.quote?.change_percent ?? null} />;
      case "dayPnl":
        return h.dayPnl != null ? (
          <span style={{ color: moveColor(h.dayPnl) }}>
            {mask(fmtSignedMoney(h.dayPnl))}
          </span>
        ) : (
          "—"
        );
      case "premium":
        return <Pct v={h.quote?.premium_percent ?? null} />;
      case "price":
        return h.quote ? fmtPrice(h.quote.price) : "—";
      case "cost":
        return fmtPrice(h.cost_per_share);
      case "pnlPct":
        return <Pct v={h.pnlPct} />;
      case "pnl":
        return h.pnl != null ? (
          <span style={{ color: moveColor(h.pnl) }}>
            {mask(fmtSignedMoney(h.pnl))}
          </span>
        ) : (
          "—"
        );
      case "mv":
        return h.mv != null ? mask(fmtMoney(h.mv)) : "—";
      case "costAmt":
        return mask(fmtMoney(h.cost_per_share * h.qty));
      case "qty":
        return mask(fmtQty(h.qty));
      case "share":
        return h.share != null ? `${h.share.toFixed(2)}%` : "—";
    }
  };

  return (
    <section aria-label="持仓明细" id="sec-holdings" className="section-anchor">
      <SectionTitle
        right={
          <span className="flex items-center gap-2">
            <span className="flex overflow-hidden rounded-md border border-[var(--border)] text-xs">
              <button
                type="button"
                aria-pressed={density === "standard"}
                aria-label="标准模式"
                onClick={() => pickDensity("standard")}
                className={`px-2.5 ${density === "standard" ? "bg-[var(--surface-alt)] font-medium" : ""}`}
              >
                标准
              </button>
              <button
                type="button"
                aria-pressed={density === "table"}
                aria-label="表格模式"
                onClick={() => pickDensity("table")}
                className={`px-2.5 ${density === "table" ? "bg-[var(--surface-alt)] font-medium" : ""}`}
              >
                表格
              </button>
            </span>
            <button
              type="button"
              aria-label="添加持仓"
              onClick={() => setShowAdd(!showAdd)}
              className="rounded-md border border-[var(--border)] px-2.5 text-xs"
            >
              {showAdd ? "收起" : "＋ 添加持仓"}
            </button>
          </span>
        }
      >
        持仓明细
      </SectionTitle>

      {showAdd && (
        <form
          onSubmit={submitAdd}
          className="mb-3 flex flex-wrap items-end gap-2 border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
        >
          <label className="text-xs text-[var(--dim)]">
            代码（6 位）
            <input
              aria-label="新持仓代码"
              inputMode="numeric"
              value={aSymbol}
              onChange={(e) => setASymbol(e.target.value)}
              className="tnum mt-0.5 block w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
            />
          </label>
          <label className="text-xs text-[var(--dim)]">
            名称（可留空，刷新后自动补）
            <input
              aria-label="新持仓名称"
              value={aName}
              onChange={(e) => setAName(e.target.value)}
              className="mt-0.5 block w-36 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
            />
          </label>
          <label className="text-xs text-[var(--dim)]">
            股数
            <input
              aria-label="新持仓股数"
              inputMode="decimal"
              value={aQty}
              onChange={(e) => setAQty(e.target.value)}
              className="tnum mt-0.5 block w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
            />
          </label>
          <label className="text-xs text-[var(--dim)]">
            成本价
            <input
              aria-label="新持仓成本价"
              inputMode="decimal"
              value={aCost}
              onChange={(e) => setACost(e.target.value)}
              className="tnum mt-0.5 block w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
            />
          </label>
          <label className="text-xs text-[var(--dim)]">
            类型
            <select
              aria-label="新持仓类型"
              value={aKind}
              onChange={(e) => setAKind(e.target.value as typeof aKind)}
              className="mt-0.5 block rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
            >
              <option value="etf">ETF</option>
              <option value="fund">场内基金</option>
              <option value="stock">股票</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={add.isPending}
            className="rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white disabled:opacity-50"
          >
            添加
          </button>
          {addError && (
            <span className="text-xs" style={{ color: "var(--up)" }}>
              {addError}
            </span>
          )}
        </form>
      )}

      {rows.length === 0 ? (
        <p className="border border-dashed border-[var(--border)] px-3 py-4 text-sm text-[var(--dim)]">
          暂无持仓 · 等待录入。
        </p>
      ) : density === "standard" ? (
        <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
          {byShare.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                aria-expanded={expanded === h.id}
                aria-label={`${h.symbol} ${displayName(h.symbol, h.name)} 明细`}
                onClick={() => setExpanded(expanded === h.id ? null : h.id)}
                className="block w-full px-1 py-2.5 text-left"
              >
                <span className="grid grid-cols-[minmax(0,1fr)_122px] gap-x-3">
                  <span className="min-w-0">
                    <span className="flex items-baseline text-sm">
                      <span className="tnum shrink-0 font-bold">
                        {h.symbol}
                      </span>
                      <span className="ml-2 min-w-0 truncate font-medium">
                        {displayName(h.symbol, h.name)}
                      </span>
                      {isStaleQuote(h, latestQuoteDate) &&
                        h.quote?.quote_date && (
                          <StaleTag
                            date={h.quote.quote_date}
                            className="ml-2 shrink-0 text-xs whitespace-nowrap"
                          />
                        )}
                    </span>
                    <span className="tnum mt-1 block truncate text-xs text-[var(--dim)]">
                      市值 {h.mv != null ? mask(fmtMoney(h.mv)) : "—"}
                    </span>
                    <span className="tnum mt-1 block text-xs whitespace-nowrap text-[var(--dim)]">
                      占比 {h.share != null ? `${h.share.toFixed(2)}%` : "—"}{" "}
                      · 溢价率{" "}
                      <span className="text-[var(--text)]">
                        {h.quote?.premium_percent != null
                          ? fmtPct(h.quote.premium_percent)
                          : "—"}
                      </span>
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="tnum block text-sm whitespace-nowrap">
                      {h.quote ? fmtPrice(h.quote.price) : "—"}
                      <Pct
                        v={h.quote?.change_percent ?? null}
                        className="ml-2 text-xs"
                      />
                    </span>
                    <span
                      className="tnum mt-1 block text-xs whitespace-nowrap"
                      style={{ color: moveColor(h.pnl) }}
                    >
                      {h.pnl != null ? mask(fmtSignedMoney(h.pnl)) : "—"}
                    </span>
                    <span className="tnum mt-1 block text-xs whitespace-nowrap">
                      {h.pnl != null ? (
                        <>
                          <span className="text-[var(--dim)]">浮盈亏 </span>
                          <Pct v={h.pnlPct} />
                        </>
                      ) : (
                        <span>—</span>
                      )}
                    </span>
                  </span>
                </span>
              </button>
              {expanded === h.id && (
                <HoldingDetail
                  h={h}
                  mask={mask}
                  stale={isStaleQuote(h, latestQuoteDate)}
                  onDone={() => setExpanded(null)}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="border-y border-[var(--border)]">
          <div className="overflow-auto" style={{ maxHeight: "75vh" }}>
            <table className="tnum w-full min-w-[1060px] border-collapse text-sm">
              <thead>
                <tr>
                  {columns.map((c, i) => (
                    <th
                      key={c.key}
                      className={`sticky top-0 border-b border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-xs font-medium whitespace-nowrap text-[var(--dim)] ${i === 0 ? "left-0 z-30 min-w-[9rem] text-left" : "z-20 text-right"}`}
                    >
                      <button
                        type="button"
                        aria-label={`按${c.label}排序`}
                        onClick={() => clickSort(c.key)}
                        className="min-h-0 px-0.5"
                      >
                        {c.label}
                        {sortKey === c.key ? (sortAsc ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((h) => {
                  const isOpen = expanded === h.id;
                  return (
                    <Fragment key={h.id}>
                      <tr
                        className="cursor-pointer border-t border-[var(--border)]"
                        onClick={() => setExpanded(isOpen ? null : h.id)}
                      >
                        {columns.map((c, i) => (
                          <td
                            key={c.key}
                            className={`px-2 py-2 whitespace-nowrap ${i === 0 ? "sticky left-0 bg-[var(--surface)]" : "text-right"}`}
                          >
                            {cell(h, c.key)}
                          </td>
                        ))}
                      </tr>
                      {isOpen && (
                        <tr>
                          <td
                            colSpan={columns.length}
                            className="border-t border-[var(--border)] p-0"
                          >
                            <div
                              className="sticky left-0"
                              style={{
                                width: "min(calc(100vw - 2rem), 46rem)",
                              }}
                            >
                              <HoldingDetail
                                h={h}
                                mask={mask}
                                stale={isStaleQuote(h, latestQuoteDate)}
                                onDone={() => setExpanded(null)}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="px-1 py-1.5 text-[11px] text-[var(--dim)]">
            点任意行在表格内展开该持仓明细（可直接编辑）；点表头排序仅本次会话有效。
          </p>
        </div>
      )}
    </section>
  );
}

// ---------- concentration ----------

// ---------- concentration ----------

// Concentration groups holdings by underlying exposure: ETFs from
// different issuers tracking the same index (e.g. the three Nasdaq-100
// ETFs) merge into one category. The symbol map wins; name keywords
// are the fallback for holdings added later; anything unmatched forms
// its own category under its own name. Colors are stable per category.
const CONC_CATEGORIES: {
  label: string;
  color: string;
  symbols: string[];
  keywords: string[];
}[] = [
  {
    label: "纳斯达克100",
    color: "#4e79a7",
    symbols: ["513100", "159941"],
    keywords: ["纳斯达克", "纳指"],
  },
  {
    label: "红利低波",
    color: "#f28e2b",
    symbols: ["512890"],
    keywords: ["红利"],
  },
  {
    label: "标普500",
    color: "#76b7b2",
    symbols: ["513500"],
    keywords: ["标普"],
  },
  { label: "黄金", color: "#c9a227", symbols: ["518800"], keywords: ["黄金"] },
  {
    label: "日经225",
    color: "#b07aa1",
    symbols: ["513880"],
    keywords: ["日经"],
  },
  {
    label: "恒生科技",
    color: "#e15759",
    symbols: ["513180"],
    keywords: ["恒生"],
  },
  {
    label: "沪深300",
    color: "#59a14f",
    symbols: ["159919"],
    keywords: ["沪深300"],
  },
  {
    label: "中证A500",
    color: "#9c755f",
    symbols: ["159338"],
    keywords: ["A500"],
  },
  {
    label: "中概互联",
    color: "#7f8c9b",
    symbols: ["164906"],
    keywords: ["中概", "互联网"],
  },
];
const CONC_FALLBACK_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#76b7b2",
  "#c9a227",
  "#b07aa1",
  "#59a14f",
  "#9c755f",
  "#7f8c9b",
];
const CONC_CASH_COLOR = "#a8adb3";

function categoryOf(
  h: HoldingRow,
  fallbackIdx: number,
): { label: string; color: string } {
  for (const c of CONC_CATEGORIES) {
    if (c.symbols.includes(h.symbol)) return c;
  }
  for (const c of CONC_CATEGORIES) {
    if (c.keywords.some((k) => h.name.includes(k))) return c;
  }
  return {
    label: displayName(h.symbol, h.name),
    color:
      CONC_FALLBACK_COLORS[fallbackIdx % CONC_FALLBACK_COLORS.length] ??
      "#7f8c9b",
  };
}

type ConcGroup = {
  label: string;
  color: string;
  share: number;
  mv: number | null;
  members: HoldingRow[];
};

function Concentration({
  board,
  totals,
  mask,
}: {
  board: Board;
  totals: Totals;
  mask: (s: string) => string;
}) {
  const rows = enrichHoldings(board, totals).filter((h) => h.share != null);
  const cashShare =
    board.cash_cny != null && totals.total != null && totals.total > 0
      ? (board.cash_cny / totals.total) * 100
      : null;
  if (rows.length === 0 && cashShare == null) return null;
  const groups = new Map<string, ConcGroup>();
  rows.forEach((h, i) => {
    const cat = categoryOf(h, i);
    const g = groups.get(cat.label) ?? {
      label: cat.label,
      color: cat.color,
      share: 0,
      mv: 0,
      members: [],
    };
    g.share += h.share ?? 0;
    g.mv = (g.mv ?? 0) + (h.mv ?? 0);
    g.members.push(h);
    groups.set(cat.label, g);
  });
  const list: ConcGroup[] = [...groups.values()];
  if (cashShare != null) {
    list.push({
      label: "现金",
      color: CONC_CASH_COLOR,
      share: cashShare,
      mv: board.cash_cny,
      members: [],
    });
  }
  list.sort((a, b) => b.share - a.share);
  // Derived concentration stats (same 口径 as the US board): every
  // share below uses the SECURITIES market value as denominator (cash
  // excluded), only quoted holdings count, and 浮盈亏 is the enriched
  // (price − diluted cost) × qty. Percentages show 1 decimal; bars
  // have a 1.5% minimum width; amounts go through the privacy mask
  // while percentages and bar widths stay visible.
  const priced = rows.filter((h) => h.mv != null);
  const secMv = totals.securities;
  const pctOfSec = (mv: number) => (secMv > 0 ? (mv / secMv) * 100 : 0);
  const byMvDesc = [...priced].sort((a, b) => (b.mv ?? 0) - (a.mv ?? 0));
  const topHoldings = byMvDesc.slice(0, 5);
  const losers = priced
    .filter((h) => (h.pnl ?? 0) < 0)
    .sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0));
  const totalLoss = losers.reduce((s, h) => s + Math.abs(h.pnl ?? 0), 0);
  const loserRows = losers.slice(0, 4);
  const winners = priced
    .filter((h) => (h.pnl ?? 0) > 0)
    .sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  const totalGain = winners.reduce((s, h) => s + (h.pnl ?? 0), 0);
  const winnerRows = winners.slice(0, 4);
  const top3MvShare = pctOfSec(
    byMvDesc.slice(0, 3).reduce((s, h) => s + (h.mv ?? 0), 0),
  );
  const top3LossShare =
    totalLoss > 0
      ? (losers
          .slice(0, 3)
          .reduce((s, h) => s + Math.abs(h.pnl ?? 0), 0) /
          totalLoss) *
        100
      : 0;
  const winCountShare =
    priced.length > 0 ? (winners.length / priced.length) * 100 : 0;
  const metricRows: { label: string; pct: number }[] = [
    { label: "前三大持仓占证券市值", pct: top3MvShare },
    ...(losers.length > 0
      ? [
          {
            label: `前三浮亏股占总浮亏（${losers
              .slice(0, 3)
              .map((h) => h.symbol)
              .join("、")}）`,
            pct: top3LossShare,
          },
        ]
      : []),
    { label: "盈利持仓家数占比", pct: winCountShare },
  ];
  return (
    <section aria-label="集中度" id="sec-concentration" className="section-anchor">
      <SectionTitle>集中度</SectionTitle>
      <div
        className="flex h-3 w-full overflow-hidden rounded-sm"
        role="img"
        aria-label="各类资产占比分段条"
      >
        {list.map((g) => (
          <span
            key={g.label}
            style={{ width: `${g.share}%`, background: g.color }}
          />
        ))}
      </div>
      <ul className="mt-3 space-y-2.5">
        {list.map((g) => (
          <li key={g.label} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ background: g.color }}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate whitespace-nowrap">
                {g.label}
                {g.members.length > 1 && (
                  <span className="text-xs text-[var(--dim)]">
                    {" "}
                    · {g.members.length}只
                  </span>
                )}
              </span>
              {g.members.length > 1 && (
                <span className="block text-[11px] leading-relaxed text-[var(--dim)]">
                  {g.members
                    .map(
                      (m) => `${m.symbol} ${displayName(m.symbol, m.name)}`,
                    )
                    .join("、")}
                </span>
              )}
            </span>
            <span className="tnum w-16 shrink-0 text-right font-medium whitespace-nowrap">
              {g.share.toFixed(2)}%
            </span>
            <span className="tnum w-[6.5rem] shrink-0 text-right text-xs whitespace-nowrap text-[var(--dim)]">
              {g.mv != null ? mask(fmtMoney(g.mv)) : "—"}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] text-[var(--dim)]">
        按底层敞口归类，同一指数的多只 ETF 合并；占比按总账户值计（现金未录入时按证券市值计）。
      </p>
      {priced.length > 0 && (
        <>
          <p className="mt-4 text-sm text-[var(--dim)]">前五大持仓（占证券市值）</p>
          <div className="mt-1.5 space-y-2">
            {topHoldings.map((h) => {
              const pct = pctOfSec(h.mv ?? 0);
              return (
                <div key={h.symbol}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate whitespace-nowrap">
                      <span className="font-semibold">{h.symbol}</span>{" "}
                      {displayName(h.symbol, h.name)}
                    </span>
                    <span className="tnum shrink-0 text-[var(--dim)]">
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-alt)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(pct, 1.5)}%`,
                        background: "var(--accent)",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {priced.length > 0 && (
        <div className="mt-4 space-y-2.5 border-t border-[var(--border)] pt-3">
          {metricRows.map((m) => (
            <div key={m.label} className="flex items-center gap-2.5">
              <span className="min-w-0 flex-1 text-sm leading-snug text-[var(--dim)]">
                {m.label}
              </span>
              <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-[var(--surface-alt)] min-[480px]:w-28">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(Math.max(m.pct, 1.5), 100)}%`,
                    background: m.pct >= 30 ? "var(--up)" : "var(--accent)",
                  }}
                />
              </div>
              <span className="tnum w-14 shrink-0 text-right text-sm font-medium">
                {m.pct.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      )}
      {winnerRows.length > 0 && (
        <>
          <p className="mt-4 text-sm text-[var(--dim)]">浮盈来源（占总浮盈）</p>
          <div className="mt-1.5 space-y-2">
            {winnerRows.map((h) => {
              const share =
                totalGain > 0 ? ((h.pnl ?? 0) / totalGain) * 100 : 0;
              return (
                <div key={h.symbol}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate whitespace-nowrap">
                      <span className="font-semibold">{h.symbol}</span>{" "}
                      {displayName(h.symbol, h.name)}
                    </span>
                    <span
                      className="tnum shrink-0 whitespace-nowrap"
                      style={{ color: "var(--up)" }}
                    >
                      {h.pnl != null ? mask(fmtSignedMoney(h.pnl)) : "—"} ·{" "}
                      {share.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-alt)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(share, 1.5)}%`,
                        background: "var(--up)",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {loserRows.length > 0 && (
        <>
          <p className="mt-4 text-sm text-[var(--dim)]">浮亏来源（占总浮亏）</p>
          <div className="mt-1.5 space-y-2">
            {loserRows.map((h) => {
              const share =
                totalLoss > 0
                  ? (Math.abs(h.pnl ?? 0) / totalLoss) * 100
                  : 0;
              return (
                <div key={h.symbol}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate whitespace-nowrap">
                      <span className="font-semibold">{h.symbol}</span>{" "}
                      {displayName(h.symbol, h.name)}
                    </span>
                    <span
                      className="tnum shrink-0 whitespace-nowrap"
                      style={{ color: "var(--down)" }}
                    >
                      {h.pnl != null ? mask(fmtSignedMoney(h.pnl)) : "—"} ·{" "}
                      {share.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-alt)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(share, 1.5)}%`,
                        background: "var(--down)",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

// ---------- trade ledger ----------

const SOURCE_LABELS: Record<TradeRow["source"], string> = {
  order: "订单",
  snapshot_diff: "快照差",
  opening: "期初",
  manual: "手动",
};

function TradesSection({ mask }: { mask: (s: string) => string }) {
  const queryClient = useQueryClient();
  const trades = useQuery({
    queryKey: ["trades"],
    queryFn: () => api.getTrades({}),
    retry: firstLoadRetry,
    retryDelay: firstLoadRetryDelay,
  });
  const pendingRef = useRef(false);
  pendingRef.current = trades.isPending;
  useEffect(() => {
    const timer = setInterval(() => {
      if (pendingRef.current) {
        void queryClient.refetchQueries({ queryKey: ["trades"] });
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [queryClient]);

  const [collapsed, setCollapsed] = useLocalBool(
    "agu-board-trades-collapsed",
    false,
  );
  const [windowDays, setWindowDays] = useState<number | null>(3);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [fDate, setFDate] = useState(beijingToday());
  const [fSymbol, setFSymbol] = useState("");
  const [fSide, setFSide] = useState<"buy" | "sell">("buy");
  const [fQty, setFQty] = useState("");
  const [fPrice, setFPrice] = useState("");
  const [fEstimated, setFEstimated] = useState(false);
  const [fSource, setFSource] = useState<TradeRow["source"]>("manual");
  const [fNote, setFNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["trades"] });
    void queryClient.invalidateQueries({ queryKey: ["board"] });
  };
  const resetForm = () => {
    setEditingId(null);
    setFDate(beijingToday());
    setFSymbol("");
    setFSide("buy");
    setFQty("");
    setFPrice("");
    setFEstimated(false);
    setFSource("manual");
    setFNote("");
    setFormError(null);
  };
  const startEdit = (t: TradeRow) => {
    setEditingId(t.id);
    setFDate(t.date);
    setFSymbol(t.symbol);
    setFSide(t.side);
    setFQty(String(t.qty));
    setFPrice(t.price != null ? String(t.price) : "");
    setFEstimated(t.price_kind === "estimated");
    setFSource(t.source);
    setFNote(t.note ?? "");
    setFormError(null);
    setShowForm(true);
  };
  const save = useMutation({
    mutationFn: async () => {
      const price = fPrice.trim() === "" ? null : Number(fPrice);
      const price_kind =
        price == null ? "none" : fEstimated ? "estimated" : "actual";
      const base = {
        date: fDate,
        symbol: fSymbol.trim(),
        side: fSide,
        qty: Number(fQty),
        price,
        price_kind: price_kind as "actual" | "estimated" | "none",
        source: fSource,
        note: fNote.trim() === "" ? null : fNote.trim(),
      };
      return editingId != null
        ? await api.updateTrade({ id: editingId, ...base })
        : await api.addTrade(base);
    },
    onSuccess: () => {
      invalidate();
      resetForm();
      setShowForm(false);
    },
    onError: (e) =>
      setFormError(e instanceof Error ? e.message : String(e)),
  });
  const del = useMutation({
    mutationFn: async (id: number) => await api.deleteTrade({ id }),
    onSuccess: () => {
      setConfirmDeleteId(null);
      invalidate();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(fSymbol.trim())) {
      setFormError("代码须为 6 位数字");
      return;
    }
    const q = Number(fQty);
    if (!Number.isFinite(q) || q <= 0) {
      setFormError("数量须大于 0");
      return;
    }
    if (fPrice.trim() !== "" && !(Number(fPrice) > 0)) {
      setFormError("价格须大于 0（未知价格请留空）");
      return;
    }
    save.mutate();
  };

  const data = trades.data;
  const cutoff =
    windowDays != null ? shiftDate(beijingToday(), -(windowDays - 1)) : null;
  const allRows = data?.trades ?? [];
  const rows =
    cutoff != null ? allRows.filter((t) => t.date >= cutoff) : allRows;
  const olderCount = allRows.length - rows.length;

  return (
    <section aria-label="交易流水" id="sec-trades" className="section-anchor">
      <SectionTitle
        right={
          <span className="flex items-center gap-2">
            <button
              type="button"
              aria-label="录入交易"
              onClick={() => {
                if (showForm) {
                  setShowForm(false);
                  resetForm();
                } else {
                  resetForm();
                  setShowForm(true);
                }
              }}
              className="rounded-md border border-[var(--border)] px-2.5 text-xs"
            >
              {showForm ? "收起" : "＋ 录入交易"}
            </button>
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "展开交易流水" : "折叠交易流水"}
              onClick={() => setCollapsed(!collapsed)}
              className="rounded-md border border-[var(--border)] px-2.5 text-xs"
            >
              {collapsed ? "展开" : "折叠"}
            </button>
          </span>
        }
      >
        交易流水
      </SectionTitle>

      {!collapsed && (
        <>
          <p className="mb-2 text-[11px] text-[var(--dim)]">
            台账只记录、不直接改持仓；盈亏按摊薄成本法重放（同日卖光买回算做T不结算，跨日清仓才结转）。
          </p>
          {data && data.settled.by_symbol.length > 0 && (
            <div className="tnum mb-3 border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
              <span className="text-xs text-[var(--dim)]">已清仓结算：</span>
              <span
                className="ml-1 font-medium"
                style={{ color: moveColor(data.settled.total_cny) }}
              >
                {data.settled.total_cny != null
                  ? mask(fmtSignedMoney(data.settled.total_cny))
                  : "未知"}
              </span>
              {data.settled.has_estimated && (
                <span className="ml-1 text-xs text-[var(--dim)]">（含估算）</span>
              )}
              {data.settled.has_unknown && (
                <span className="ml-1 text-xs text-[var(--dim)]">（含未知价）</span>
              )}
              <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--dim)]">
                {data.settled.by_symbol.map((s) => (
                  <span key={s.symbol}>
                    {s.symbol}
                    {s.name ? ` ${displayName(s.symbol, s.name)}` : ""}：
                    <span style={{ color: moveColor(s.settled_cny) }}>
                      {s.settled_cny != null
                        ? mask(fmtSignedMoney(s.settled_cny))
                        : "未知"}
                    </span>
                    {s.has_estimated ? "（估算）" : ""}
                  </span>
                ))}
              </span>
            </div>
          )}

          {showForm && (
            <form
              onSubmit={submit}
              className="mb-3 flex flex-wrap items-end gap-2 border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
            >
              <label className="text-xs text-[var(--dim)]">
                日期
                <input
                  aria-label="交易日期"
                  type="date"
                  value={fDate}
                  onChange={(e) => setFDate(e.target.value)}
                  className="tnum mt-0.5 block rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
                />
              </label>
              <label className="text-xs text-[var(--dim)]">
                代码
                <input
                  aria-label="交易代码"
                  inputMode="numeric"
                  value={fSymbol}
                  onChange={(e) => setFSymbol(e.target.value)}
                  className="tnum mt-0.5 block w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
                />
              </label>
              <label className="text-xs text-[var(--dim)]">
                方向
                <select
                  aria-label="交易方向"
                  value={fSide}
                  onChange={(e) => setFSide(e.target.value as "buy" | "sell")}
                  className="mt-0.5 block rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
                >
                  <option value="buy">买入</option>
                  <option value="sell">卖出</option>
                </select>
              </label>
              <label className="text-xs text-[var(--dim)]">
                数量
                <input
                  aria-label="交易数量"
                  inputMode="decimal"
                  value={fQty}
                  onChange={(e) => setFQty(e.target.value)}
                  className="tnum mt-0.5 block w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
                />
              </label>
              <label className="text-xs text-[var(--dim)]">
                价格（未知留空）
                <input
                  aria-label="交易价格"
                  inputMode="decimal"
                  value={fPrice}
                  onChange={(e) => setFPrice(e.target.value)}
                  className="tnum mt-0.5 block w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-[var(--dim)]">
                <input
                  type="checkbox"
                  aria-label="价格为估算"
                  checked={fEstimated}
                  onChange={(e) => setFEstimated(e.target.checked)}
                />
                估算价
              </label>
              <label className="text-xs text-[var(--dim)]">
                来源
                <select
                  aria-label="交易来源"
                  value={fSource}
                  onChange={(e) =>
                    setFSource(e.target.value as TradeRow["source"])
                  }
                  className="mt-0.5 block rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
                >
                  <option value="manual">手动</option>
                  <option value="order">订单</option>
                  <option value="snapshot_diff">快照差</option>
                  <option value="opening">期初</option>
                </select>
              </label>
              <label className="text-xs text-[var(--dim)]">
                备注
                <input
                  aria-label="交易备注"
                  value={fNote}
                  onChange={(e) => setFNote(e.target.value)}
                  className="mt-0.5 block w-36 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
                />
              </label>
              <button
                type="submit"
                disabled={save.isPending}
                className="rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white disabled:opacity-50"
              >
                {editingId != null ? "保存修改" : "录入"}
              </button>
              {formError && (
                <span className="text-xs" style={{ color: "var(--up)" }}>
                  {formError}
                </span>
              )}
            </form>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
            {([3, 7, 30, null] as const).map((d) => (
              <button
                key={String(d)}
                type="button"
                aria-pressed={windowDays === d}
                aria-label={d == null ? "显示全部交易" : `显示近${d}天交易`}
                onClick={() => setWindowDays(d)}
                className={`rounded-md border border-[var(--border)] px-2.5 ${windowDays === d ? "bg-[var(--surface-alt)] font-medium" : ""}`}
              >
                {d == null ? "全部" : `近${d}天`}
              </button>
            ))}
            {olderCount > 0 && cutoff != null && (
              <span className="text-[var(--dim)]">
                更早 {olderCount} 笔已隐藏，切到「全部」查看
              </span>
            )}
          </div>

          {trades.isPending ? (
            <p className="text-sm text-[var(--dim)]">加载中…</p>
          ) : trades.isError ? (
            <p className="text-sm text-[var(--dim)]">
              交易流水加载失败，
              <button
                type="button"
                aria-label="重试加载交易流水"
                onClick={() => void trades.refetch()}
                className="text-[var(--accent)] underline"
              >
                点此重试
              </button>
            </p>
          ) : rows.length === 0 ? (
            <p className="border border-dashed border-[var(--border)] px-3 py-4 text-sm text-[var(--dim)]">
              {allRows.length === 0
                ? "暂无交易记录 · 等待录入。"
                : "所选时间窗内暂无交易。"}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
              {rows.map((t) => (
                <li key={t.id} className="px-1 py-2.5">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate whitespace-nowrap">
                      <span
                        className="font-medium"
                        style={{
                          color:
                            t.side === "buy" ? "var(--up)" : "var(--down)",
                        }}
                      >
                        {t.side === "buy" ? "买入" : "卖出"}
                      </span>
                      <span className="tnum ml-2 font-bold">{t.symbol}</span>
                      <span className="ml-1.5 font-medium">
                        {t.name ? displayName(t.symbol, t.name) : ""}
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-xs whitespace-nowrap text-[var(--dim)]">
                      {t.date.slice(5)} 周{weekdayOf(t.date)}
                    </span>
                  </div>
                  <div className="tnum mt-1 text-sm whitespace-nowrap">
                    {fmtQty(t.qty)} 份 @{" "}
                    {t.price != null ? mask(fmtPrice(t.price)) : "未知价"}
                    {t.price_kind === "estimated" ? "（估算）" : ""} · 成交额{" "}
                    <span className="font-medium">
                      {t.price != null
                        ? mask(fmtMoney(t.qty * t.price))
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[var(--dim)]">
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {t.date} · {SOURCE_LABELS[t.source]}
                      </span>
                      <span className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          aria-label={`编辑 ${t.date} ${t.symbol} 交易`}
                          onClick={() => startEdit(t)}
                          className="min-h-0 text-[var(--accent)] underline"
                        >
                          编辑
                        </button>
                        {confirmDeleteId === t.id ? (
                          <button
                            type="button"
                            aria-label={`确认删除 ${t.date} ${t.symbol} 交易`}
                            disabled={del.isPending}
                            onClick={() => del.mutate(t.id)}
                            className="min-h-0 font-medium disabled:opacity-50"
                            style={{ color: "var(--up)" }}
                          >
                            确认删除？
                          </button>
                        ) : (
                          <button
                            type="button"
                            aria-label={`删除 ${t.date} ${t.symbol} 交易`}
                            onClick={() => setConfirmDeleteId(t.id)}
                            className="min-h-0 underline"
                          >
                            删除
                          </button>
                        )}
                      </span>
                    </div>
                    {t.note?.trim() ? (
                      <p className="mt-0.5 leading-relaxed break-words">
                        备注：{t.note}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// ---------- history ----------

// Colour of the account series in the history charts: the board's
// theme red (--up), which resolves to #cf3527 in light mode and
// #e5533d in dark mode — the account line reads red in both.
const ACCOUNT_LINE_COLOR = "var(--up)";

// Colour of the CSI 300 comparison series in the 与大盘对比 chart:
// a saturated deep blue — far in hue from the account's red and the
// SSE violet in both colour schemes (the previous warm amber sat too
// close to the account's red to tell apart at a glance).
const CSI_LINE_COLOR = "#2563eb";

// Colour of the SSE Composite （上证指数） series in the history
// charts: a teal clearly apart from the account's red and the
// CSI 300 deep blue in both colour schemes (the previous violet
// sat too close in hue to the CSI 300 blue to tell apart).
const SSE_LINE_COLOR = "#0d9488";

// 证券与现金结构 series colours: a saturated deep blue for securities
// and a warm amber for cash — far apart in hue, and the fill
// opacities are spread the other way than intuition suggests
// (securities 0.7, cash 0.9): the cash band is thin, and at low
// opacity it blends into the dark surface at nearly the same
// luminance as the blue, so it is kept near-opaque to stay
// unmistakable in both colour schemes. (The previous pair — slate
// accent over light slate-grey — was too close to distinguish.)
const SEC_AREA_COLOR = "#2563eb";
const CASH_AREA_COLOR = "#f59e0b";

// One 走势 stat card, in the overview's stat language: dim label,
// medium figure, optional smaller lines under the figure. Amounts go
// through the board's privacy mask; percentages and dates stay
// visible, and 红涨绿跌 colours match the rest of the board.
function HistoryStat({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-sm text-[var(--dim)]">{label}</dt>
      <dd className="mt-0.5 text-base font-medium sm:text-lg">{children}</dd>
    </div>
  );
}

function HistorySection({
  history,
  mask,
  privacy,
}: {
  history: Snapshot[];
  mask: (s: string) => string;
  privacy: boolean;
}) {
  // The daily snapshot table folds away by default (same habit as
  // the trade ledger's collapse, persisted); the stat cards and the
  // charts above it always stay visible.
  const [listCollapsed, setListCollapsed] = useLocalBool(
    "agu-board-history-list-collapsed",
    true,
  );
  const chartData = [...history].reverse();
  // A lone snapshot has no line to draw; both comparison series are
  // rendered as single annotated dots (see the ReferenceDots below)
  // so the first point is visible today instead of an empty chart.
  const singlePoint = chartData.length === 1 ? chartData[0] : undefined;

  // ----- stat cards -----
  // Everything below is derived at render time from the stored
  // snapshots; nothing here writes back.
  const firstSnap = chartData[0];
  const lastSnap = chartData[chartData.length - 1];
  const cumChange =
    firstSnap && lastSnap
      ? lastSnap.account_value_cny - firstSnap.account_value_cny
      : null;
  const cumPct =
    cumChange != null && firstSnap && firstSnap.account_value_cny > 0
      ? (cumChange / firstSnap.account_value_cny) * 100
      : null;
  let peakSnap: Snapshot | undefined;
  for (const s of chartData) {
    if (!peakSnap || s.account_value_cny > peakSnap.account_value_cny) {
      peakSnap = s;
    }
  }
  const fromPeak =
    peakSnap && lastSnap
      ? lastSnap.account_value_cny - peakSnap.account_value_cny
      : null;
  const fromPeakPct =
    fromPeak != null && peakSnap && peakSnap.account_value_cny > 0
      ? (fromPeak / peakSnap.account_value_cny) * 100
      : null;
  // Maximum drawdown: the deepest fall from a running peak to a
  // later trough over the chronological daily totals.
  let ddAmount = 0;
  let ddPeakValue = 0;
  let ddPeakDate: string | null = null;
  let ddTroughDate: string | null = null;
  {
    let runPeakValue = Number.NEGATIVE_INFINITY;
    let runPeakDate = "";
    for (const s of chartData) {
      if (s.account_value_cny > runPeakValue) {
        runPeakValue = s.account_value_cny;
        runPeakDate = s.date;
      }
      const dd = s.account_value_cny - runPeakValue;
      if (dd < ddAmount) {
        ddAmount = dd;
        ddPeakValue = runPeakValue;
        ddPeakDate = runPeakDate;
        ddTroughDate = s.date;
      }
    }
  }
  const ddPct = ddPeakValue > 0 ? (ddAmount / ddPeakValue) * 100 : null;
  // Best / worst single day by stored day change. The percentage is
  // derived on the account basis — day change ÷ (that day's total −
  // day change), the previous day's account total — never read from
  // the stored day_change_pct.
  let bestDay: Snapshot | undefined;
  let worstDay: Snapshot | undefined;
  for (const s of chartData) {
    if (s.day_change_cny == null) continue;
    if (!bestDay || s.day_change_cny > (bestDay.day_change_cny ?? 0)) {
      bestDay = s;
    }
    if (!worstDay || s.day_change_cny < (worstDay.day_change_cny ?? 0)) {
      worstDay = s;
    }
  }
  const derivedDayPct = (s: Snapshot): number | null => {
    if (s.day_change_cny == null) return null;
    const prev = s.account_value_cny - s.day_change_cny;
    return prev > 0 ? (s.day_change_cny / prev) * 100 : null;
  };
  const bestPct = bestDay ? derivedDayPct(bestDay) : null;
  const worstPct = worstDay ? derivedDayPct(worstDay) : null;

  // Comparison series: the account value and the benchmark closes
  // stored on each snapshot (CSI 300, SSE Composite) are all rebased
  // to cumulative % change since the first snapshot (every series
  // starts at 0%), so they share one % axis. A snapshot without a
  // stored close for a benchmark leaves a gap in that line rather
  // than an invented point.
  const base = chartData[0];
  const csiBase =
    chartData.find((s) => s.csi300_price != null)?.csi300_price ?? null;
  const sseBase =
    chartData.find((s) => s.sse_price != null)?.sse_price ?? null;
  const cmpData = chartData.map((s) => ({
    date: s.date,
    snap: s,
    acct:
      base && base.account_value_cny > 0
        ? (s.account_value_cny / base.account_value_cny - 1) * 100
        : 0,
    csi:
      csiBase != null && csiBase > 0 && s.csi300_price != null
        ? (s.csi300_price / csiBase - 1) * 100
        : null,
    sse:
      sseBase != null && sseBase > 0 && s.sse_price != null
        ? (s.sse_price / sseBase - 1) * 100
        : null,
  }));
  const lastCmp = cmpData[cmpData.length - 1];
  // 每日涨跌 overlay series: the SSE Composite's day change is not
  // stored on snapshots, so it is derived here from the adjacent
  // snapshots' sse_price closes (today ÷ previous snapshot day − 1).
  // The first snapshot has no predecessor and gets no line point.
  const dayChartData = chartData.map((s, i) => {
    const prev = i > 0 ? chartData[i - 1] : undefined;
    return {
      ...s,
      sse_day_pct:
        prev?.sse_price != null &&
        prev.sse_price > 0 &&
        s.sse_price != null
          ? (s.sse_price / prev.sse_price - 1) * 100
          : null,
    };
  });
  const pctTick = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  const axisTick = { fontSize: 11, fill: "var(--dim)" } as const;
  // Money axes （总值走势 / 证券与现金结构） go through the same
  // privacy rule as every other amount on the board: with privacy
  // on the tick labels read •••• instead of the ¥万 figure (same
  // convention as the US board's trend charts).
  const moneyTick = (v: number) =>
    privacy ? "••••" : `${(v / 10000).toFixed(0)}万`;

  return (
    <section aria-label="走势" id="sec-history" className="section-anchor">
      <SectionTitle
        right={
          history.length > 0 ? (
            <button
              type="button"
              aria-expanded={!listCollapsed}
              aria-label={listCollapsed ? "展开每日数据" : "折叠每日数据"}
              onClick={() => setListCollapsed(!listCollapsed)}
              className="rounded-md border border-[var(--border)] px-2.5 text-xs"
            >
              {listCollapsed ? "展开每日数据" : "折叠每日数据"}
            </button>
          ) : undefined
        }
      >
        走势
      </SectionTitle>
      {history.length === 0 ? (
        <p className="border border-dashed border-[var(--border)] px-3 py-4 text-sm text-[var(--dim)]">
          暂无快照 · 等待录入。每个交易日 15:10 收盘刷新后自动落盘当日快照。
        </p>
      ) : (
        <>
          <dl className="tnum grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
            <HistoryStat label="记录天数">{history.length}</HistoryStat>
            <HistoryStat label="累计变化">
              {cumChange != null ? (
                <>
                  <span style={{ color: moveColor(cumChange) }}>
                    {mask(fmtSignedMoney(cumChange))}
                  </span>
                  {cumPct != null && (
                    <span
                      className="block text-sm font-normal"
                      style={{ color: moveColor(cumChange) }}
                    >
                      {fmtPct(cumPct)}
                    </span>
                  )}
                </>
              ) : (
                "—"
              )}
            </HistoryStat>
            <HistoryStat label="历史最高/距高点">
              {peakSnap ? (
                <>
                  {mask(fmtMoney(peakSnap.account_value_cny))}
                  <span className="block text-xs font-normal text-[var(--dim)]">
                    {peakSnap.date}
                  </span>
                  {fromPeak != null && (
                    <span
                      className="block text-sm font-normal"
                      style={{ color: moveColor(fromPeak) }}
                    >
                      距高点 {mask(fmtSignedMoney(fromPeak))}
                      {fromPeakPct != null ? ` · ${fmtPct(fromPeakPct)}` : ""}
                    </span>
                  )}
                </>
              ) : (
                "—"
              )}
            </HistoryStat>
            <HistoryStat label="最大回撤">
              {chartData.length >= 2 ? (
                <>
                  <span style={{ color: moveColor(ddAmount) }}>
                    {mask(fmtSignedMoney(ddAmount))}
                  </span>
                  {ddPct != null && (
                    <span
                      className="block text-sm font-normal"
                      style={{ color: moveColor(ddAmount) }}
                    >
                      {fmtPct(ddPct)}
                    </span>
                  )}
                  {ddPeakDate && ddTroughDate && (
                    <span className="block text-xs font-normal text-[var(--dim)]">
                      {ddPeakDate} → {ddTroughDate}
                    </span>
                  )}
                </>
              ) : (
                "—"
              )}
            </HistoryStat>
            <HistoryStat label="最好单日">
              {bestDay && bestDay.day_change_cny != null ? (
                <>
                  <span style={{ color: moveColor(bestDay.day_change_cny) }}>
                    {mask(fmtSignedMoney(bestDay.day_change_cny))}
                  </span>
                  {bestPct != null && (
                    <span
                      className="block text-sm font-normal"
                      style={{ color: moveColor(bestDay.day_change_cny) }}
                    >
                      {fmtPct(bestPct)}
                    </span>
                  )}
                  <span className="block text-xs font-normal text-[var(--dim)]">
                    {bestDay.date}
                  </span>
                </>
              ) : (
                "—"
              )}
            </HistoryStat>
            <HistoryStat label="最差单日">
              {worstDay && worstDay.day_change_cny != null ? (
                <>
                  <span style={{ color: moveColor(worstDay.day_change_cny) }}>
                    {mask(fmtSignedMoney(worstDay.day_change_cny))}
                  </span>
                  {worstPct != null && (
                    <span
                      className="block text-sm font-normal"
                      style={{ color: moveColor(worstDay.day_change_cny) }}
                    >
                      {fmtPct(worstPct)}
                    </span>
                  )}
                  <span className="block text-xs font-normal text-[var(--dim)]">
                    {worstDay.date}
                  </span>
                </>
              ) : (
                "—"
              )}
            </HistoryStat>
          </dl>

          <div className="tnum mt-5 mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
            <span className="text-sm font-medium">总值走势</span>
            <span className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: ACCOUNT_LINE_COLOR }}
              />
              账户总值
            </span>
          </div>
          <div className="h-44 w-full" aria-label="账户总值走势图">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 6, right: 8, bottom: 0, left: 4 }}
              >
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => d.slice(5)}
                  tick={axisTick}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  minTickGap={40}
                />
                <YAxis
                  domain={
                    singlePoint
                      ? [
                          () => singlePoint.account_value_cny * 0.995,
                          () => singlePoint.account_value_cny * 1.005,
                        ]
                      : ["auto", "auto"]
                  }
                  width={40}
                  tick={axisTick}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={moneyTick}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const s = payload[0]?.payload as Snapshot | undefined;
                    if (!s) return null;
                    return (
                      <div className="tnum border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs">
                        <div>
                          {s.date} 周{weekdayOf(s.date)}
                        </div>
                        <div>总值 {mask(fmtMoney(s.account_value_cny))}</div>
                        <div>
                          当日{" "}
                          {s.day_change_cny != null ? (
                            <span
                              style={{ color: moveColor(s.day_change_cny) }}
                            >
                              {mask(fmtSignedMoney(s.day_change_cny))}
                            </span>
                          ) : (
                            "—"
                          )}
                        </div>
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="account_value_cny"
                  stroke={ACCOUNT_LINE_COLOR}
                  strokeWidth={1.8}
                  dot={chartData.length <= 40}
                  activeDot={{ r: 3 }}
                />
                {singlePoint && (
                  <ReferenceDot
                    x={singlePoint.date}
                    y={singlePoint.account_value_cny}
                    r={4.5}
                    fill={ACCOUNT_LINE_COLOR}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  >
                    <Label
                      value={`${singlePoint.date.slice(5)} · ${mask(fmtMoney(singlePoint.account_value_cny))}`}
                      position="top"
                      offset={10}
                      fill="var(--dim)"
                      fontSize={11}
                    />
                  </ReferenceDot>
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="tnum mt-4 mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
            <span className="text-sm font-medium">每日涨跌</span>
            <span className="text-[var(--dim)]">
              柱为账户当日涨跌幅（红涨绿跌），线为上证指数 当日涨跌幅
            </span>
          </div>
          <div className="h-36 w-full" aria-label="每日涨跌图">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={dayChartData}
                margin={{ top: 6, right: 8, bottom: 0, left: 4 }}
              >
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => d.slice(5)}
                  tick={axisTick}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  minTickGap={40}
                />
                <YAxis
                  width={52}
                  tick={axisTick}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={pctTick}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const s = payload[0]?.payload as
                      | (Snapshot & { sse_day_pct: number | null })
                      | undefined;
                    if (!s) return null;
                    return (
                      <div className="tnum border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs">
                        <div>
                          {s.date} 周{weekdayOf(s.date)}
                        </div>
                        <div>
                          账户当日{" "}
                          {s.day_change_pct != null ? (
                            <span
                              style={{ color: moveColor(s.day_change_pct) }}
                            >
                              {fmtPct(s.day_change_pct)}
                              {s.day_change_cny != null
                                ? ` (${mask(fmtSignedMoney(s.day_change_cny))})`
                                : ""}
                            </span>
                          ) : (
                            "—"
                          )}
                        </div>
                        <div>
                          上证指数 当日{" "}
                          {s.sse_day_pct != null ? (
                            <span
                              style={{ color: moveColor(s.sse_day_pct) }}
                            >
                              {fmtPct(s.sse_day_pct)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </div>
                      </div>
                    );
                  }}
                />
                <ReferenceLine y={0} stroke="var(--border)" />
                <Bar dataKey="day_change_pct" maxBarSize={26}>
                  {dayChartData.map((s) => (
                    <Cell
                      key={s.date}
                      fill={
                        s.day_change_pct == null || s.day_change_pct === 0
                          ? "var(--dim)"
                          : s.day_change_pct > 0
                            ? "var(--up)"
                            : "var(--down)"
                      }
                    />
                  ))}
                </Bar>
                <Line
                  type="monotone"
                  dataKey="sse_day_pct"
                  stroke={SSE_LINE_COLOR}
                  strokeWidth={1.5}
                  dot={{ r: 2 }}
                  activeDot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="tnum mt-4 mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
            <span className="text-sm font-medium">证券与现金结构</span>
            <span className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: SEC_AREA_COLOR }}
              />
              证券
            </span>
            <span className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: CASH_AREA_COLOR }}
              />
              现金
            </span>
          </div>
          <div className="h-36 w-full" aria-label="证券与现金结构图">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartData}
                margin={{ top: 6, right: 8, bottom: 0, left: 4 }}
              >
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => d.slice(5)}
                  tick={axisTick}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  minTickGap={40}
                />
                <YAxis
                  width={40}
                  tick={axisTick}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={moneyTick}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const s = payload[0]?.payload as Snapshot | undefined;
                    if (!s) return null;
                    return (
                      <div className="tnum border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs">
                        <div>
                          {s.date} 周{weekdayOf(s.date)}
                        </div>
                        <div>证券 {mask(fmtMoney(s.securities_value_cny))}</div>
                        <div>现金 {mask(fmtMoney(s.cash_cny))}</div>
                        <div>总值 {mask(fmtMoney(s.account_value_cny))}</div>
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="securities_value_cny"
                  stackId="1"
                  stroke={SEC_AREA_COLOR}
                  fill={SEC_AREA_COLOR}
                  fillOpacity={0.7}
                />
                <Area
                  type="monotone"
                  dataKey="cash_cny"
                  stackId="1"
                  stroke={CASH_AREA_COLOR}
                  fill={CASH_AREA_COLOR}
                  fillOpacity={0.9}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="tnum mt-4 mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
            <span className="text-sm font-medium">与大盘对比</span>
            <span className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: ACCOUNT_LINE_COLOR }}
              />
              账户累计
              <span
                className="font-medium"
                style={{ color: moveColor(lastCmp?.acct) }}
              >
                {lastCmp ? fmtPct(lastCmp.acct) : "—"}
              </span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: CSI_LINE_COLOR }}
              />
              沪深300 累计
              <span
                className="font-medium"
                style={{ color: moveColor(lastCmp?.csi) }}
              >
                {lastCmp?.csi != null ? fmtPct(lastCmp.csi) : "—"}
              </span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: SSE_LINE_COLOR }}
              />
              上证指数 累计
              <span
                className="font-medium"
                style={{ color: moveColor(lastCmp?.sse) }}
              >
                {lastCmp?.sse != null ? fmtPct(lastCmp.sse) : "—"}
              </span>
            </span>
            <span className="text-[var(--dim)]">
              相对首条快照归一化 · 起点 0%
            </span>
          </div>
          <div className="h-44 w-full" aria-label="账户与沪深300、上证指数走势对比图">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={cmpData}
                margin={{ top: 6, right: 8, bottom: 0, left: 4 }}
              >
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => d.slice(5)}
                  tick={axisTick}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  minTickGap={40}
                />
                <YAxis
                  domain={
                    singlePoint
                      ? [() => -1, () => 1]
                      : ["auto", "auto"]
                  }
                  width={52}
                  tick={axisTick}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={pctTick}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0]?.payload as
                      | (typeof cmpData)[number]
                      | undefined;
                    if (!p) return null;
                    const s = p.snap;
                    return (
                      <div className="tnum border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs">
                        <div>
                          {s.date} 周{weekdayOf(s.date)}
                        </div>
                        <div>
                          账户{" "}
                          <span style={{ color: moveColor(p.acct) }}>
                            {fmtPct(p.acct)}
                          </span>{" "}
                          · 总值 {mask(fmtMoney(s.account_value_cny))}
                        </div>
                        <div>
                          沪深300{" "}
                          {p.csi != null ? (
                            <span style={{ color: moveColor(p.csi) }}>
                              {fmtPct(p.csi)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </div>
                        <div>
                          上证指数{" "}
                          {p.sse != null ? (
                            <span style={{ color: moveColor(p.sse) }}>
                              {fmtPct(p.sse)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </div>
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="sse"
                  stroke={SSE_LINE_COLOR}
                  strokeWidth={1.5}
                  dot={cmpData.length <= 40}
                  activeDot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="csi"
                  stroke={CSI_LINE_COLOR}
                  strokeWidth={1.5}
                  dot={cmpData.length <= 40}
                  activeDot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="acct"
                  stroke={ACCOUNT_LINE_COLOR}
                  strokeWidth={1.8}
                  dot={cmpData.length <= 40}
                  activeDot={{ r: 3 }}
                />
                {singlePoint && (
                  <ReferenceDot
                    x={singlePoint.date}
                    y={0}
                    r={7}
                    fill={CSI_LINE_COLOR}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  >
                    <Label
                      value={`沪深300 ${singlePoint.csi300_price != null ? Math.round(singlePoint.csi300_price).toLocaleString("zh-CN") : "—"}`}
                      position="bottom"
                      offset={10}
                      fill="var(--dim)"
                      fontSize={11}
                    />
                  </ReferenceDot>
                )}
                {singlePoint && (
                  <ReferenceDot
                    x={singlePoint.date}
                    y={0}
                    r={4.5}
                    fill={ACCOUNT_LINE_COLOR}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  >
                    <Label
                      value={`${singlePoint.date.slice(5)} · ${mask(fmtMoney(singlePoint.account_value_cny))}`}
                      position="top"
                      offset={10}
                      fill="var(--dim)"
                      fontSize={11}
                    />
                  </ReferenceDot>
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {!listCollapsed && (
            <div className="mt-2 overflow-x-auto border-y border-[var(--border)]">
              <table className="tnum w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-xs text-[var(--dim)]">
                    <th scope="col" className="px-1 py-1.5 text-left font-normal">
                      日期
                    </th>
                    <th scope="col" className="px-1 py-1.5 text-right font-normal">
                      总值
                    </th>
                    <th scope="col" className="px-1 py-1.5 text-right font-normal">
                      证券
                    </th>
                    <th scope="col" className="px-1 py-1.5 text-right font-normal">
                      现金
                    </th>
                    <th scope="col" className="px-1 py-1.5 text-right font-normal">
                      当日涨跌
                    </th>
                    <th scope="col" className="px-1 py-1.5 text-right font-normal">
                      涨跌幅
                    </th>
                    <th scope="col" className="px-1 py-1.5 text-right font-normal">
                      上证指数
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {history.map((s) => (
                    <tr key={s.date}>
                      <td className="px-1 py-1.5 font-medium whitespace-nowrap">
                        {s.date.slice(5)}
                        <span className="ml-1 text-xs font-normal text-[var(--dim)]">
                          周{weekdayOf(s.date)}
                        </span>
                      </td>
                      <td className="px-1 py-1.5 text-right whitespace-nowrap">
                        {mask(fmtMoney(s.account_value_cny))}
                      </td>
                      <td className="px-1 py-1.5 text-right whitespace-nowrap">
                        {mask(fmtMoney(s.securities_value_cny))}
                      </td>
                      <td className="px-1 py-1.5 text-right whitespace-nowrap">
                        {mask(fmtMoney(s.cash_cny))}
                      </td>
                      <td
                        className="px-1 py-1.5 text-right whitespace-nowrap"
                        style={{ color: moveColor(s.day_change_cny) }}
                      >
                        {s.day_change_cny != null
                          ? mask(fmtSignedMoney(s.day_change_cny))
                          : "—"}
                      </td>
                      <td className="px-1 py-1.5 text-right whitespace-nowrap">
                        <Pct v={s.day_change_pct} />
                      </td>
                      <td className="px-1 py-1.5 text-right whitespace-nowrap">
                        {s.sse_price != null
                          ? Math.round(s.sse_price).toLocaleString("zh-CN")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-[var(--dim)]">
            走势数据为每日收盘口径快照（每个交易日 15:10
            收盘刷新后落盘）；当日涨跌按总账户值（含现金）口径计算，与总览一致。
          </p>
        </>
      )}
    </section>
  );
}
// ---------- data backup ----------

function DataSection() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const exportMut = useMutation({
    mutationFn: async () => await api.exportData({}),
    onSuccess: (payload) => {
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `A股持仓备份-${beijingToday()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus("已导出全部数据（含校验和）。");
    },
    onError: () => setStatus("导出失败，请重试。"),
  });
  const importMut = useMutation({
    mutationFn: async (payload: unknown) =>
      await api.importData({
        payload: payload as Parameters<typeof api.importData>[0]["payload"],
      }),
    onSuccess: (res) => {
      setStatus(
        res.imported.length > 0
          ? `已导入：${res.imported.join("、")}。文件里没有的表未动。`
          : "文件里没有可导入的数据表。",
      );
      void queryClient.invalidateQueries({ queryKey: ["board"] });
      void queryClient.invalidateQueries({ queryKey: ["trades"] });
    },
    onError: (e) =>
      setStatus(
        `导入失败：${e instanceof Error ? e.message : String(e)}`,
      ),
  });
  const onFile = (file: File | undefined) => {
    if (!file) return;
    void file
      .text()
      .then((text) => {
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed !== "object" ||
          parsed == null ||
          !("tables" in parsed)
        ) {
          setStatus("导入失败：不是有效的备份文件。");
          return;
        }
        importMut.mutate(parsed);
      })
      .catch(() => setStatus("导入失败：文件无法解析。"));
  };
  return (
    <section aria-label="数据备份">
      <SectionTitle>数据备份</SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="导出数据"
          disabled={exportMut.isPending}
          onClick={() => exportMut.mutate()}
          className="rounded-md border border-[var(--border)] px-3 text-xs disabled:opacity-50"
        >
          导出数据（JSON）
        </button>
        <label className="flex min-h-8 cursor-pointer items-center rounded-md border border-[var(--border)] px-3 text-xs">
          导入数据
          <input
            type="file"
            accept="application/json"
            aria-label="导入数据文件"
            className="hidden"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        {status && <span className="text-xs text-[var(--dim)]">{status}</span>}
      </div>
    </section>
  );
}

// ---------- app ----------

export function App() {
  const queryClient = useQueryClient();
  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => api.getBoard({}),
    retry: firstLoadRetry,
    retryDelay: firstLoadRetryDelay,
  });
  const pendingRef = useRef(false);
  pendingRef.current = board.isPending;
  useEffect(() => {
    const timer = setInterval(() => {
      if (pendingRef.current) {
        void queryClient.refetchQueries({ queryKey: ["board"] });
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [queryClient]);

  // 切回前台自动刷新：页面在后台/内存中停留时不会重读数据，回到
  // 前台时重新拉取看板与流水，展示定时刷新已写入的最新数据，无需
  // 手动关开页面。触发点不止 visibilitychange：部分手机 WebView
  // 从后台恢复页面时走 bfcache（pageshow）或只补发 focus，并不
  // 触发 visibilitychange——2026-11-17 用户在美股板复现「切回来
  // 仍显示旧时间」即属此类，故三个事件都监听同一处理函数；
  // React Query 对进行中的请求自动去重，多事件同至不会叠加。
  useEffect(() => {
    const refetch = () => {
      if (document.visibilityState !== "visible") return;
      void queryClient.refetchQueries({ queryKey: ["board"] });
      void queryClient.refetchQueries({ queryKey: ["trades"] });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refetch);
    window.addEventListener("pageshow", refetch);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refetch);
      window.removeEventListener("pageshow", refetch);
    };
  }, [queryClient]);

  const [privacy, setPrivacy] = useLocalBool("agu-board-privacy", false);
  const mask = (s: string) => (privacy ? "••••" : s);

  if (board.isPending) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto max-w-5xl px-4 py-16 text-center">
          <p className="text-sm text-[var(--dim)]">加载中…</p>
        </main>
      </div>
    );
  }
  if (board.isError && !board.data) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto max-w-5xl px-4 py-16 text-center">
          <p className="text-sm">看板加载失败（已自动重试）。</p>
          <button
            type="button"
            aria-label="重新加载看板"
            onClick={() => void board.refetch()}
            className="mt-3 rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-white"
          >
            重新加载
          </button>
        </main>
      </div>
    );
  }
  const data = board.data;
  if (!data) return null;
  const totals = computeTotals(data);
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <StickyNav />
      <main className="mx-auto max-w-5xl px-2 pb-12 sm:px-4">
        <MarketStrip market={data.market} />
        <Overview
          board={data}
          totals={totals}
          privacy={privacy}
          setPrivacy={setPrivacy}
          mask={mask}
        />
        <HoldingsSection board={data} totals={totals} mask={mask} />
        <Concentration board={data} totals={totals} mask={mask} />
        <HistorySection history={data.history} mask={mask} privacy={privacy} />
        <TradesSection mask={mask} />
        <DataSection />
      </main>
    </div>
  );
}
