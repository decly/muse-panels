// 看板 · A股持仓 — single-account A-share (CNY) holdings board.
// Mirrors the US board's structure: benchmark strip → overview →
// holdings (standard / table) → concentration → trade ledger →
// in-board history → data backup. All amounts ¥, 红涨绿跌， official
// basis is the regular-session close; the board starts empty and
// shows 等待录入 states until the user records holdings / cash.

import {
useEffect,
useRef,
useState,
type FormEvent,
type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
CartesianGrid,
Line,
LineChart,
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

// ---------- market strip ----------

function MarketStrip({ market }: { market: Board["market"] }) {
  const [collapsed, setCollapsed] = useLocalBool(
    "agu-board-market-collapsed",
    false,
  );
  const shown = collapsed
    ? market.filter((m) => m.key === "CSI300" || m.key === "CSIA500")
    : market;
  return (
    <section aria-label="行情">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "展开行情条" : "折叠行情条"}
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center justify-between py-2 text-left"
      >
        <span className="text-xs text-[var(--dim)]">
          行情 {collapsed ? "▸" : "▾"}
        </span>
        {collapsed && (
          <span className="tnum text-xs text-[var(--dim)]">
            {shown
              .map(
                (m) =>
                  `${m.label} ${m.price != null ? Math.round(m.price).toLocaleString("zh-CN") : "—"}`,
              )
              .join(" · ")}
          </span>
        )}
      </button>
      {!collapsed && (
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
      )}
      {!collapsed && market.every((m) => m.price == null) && (
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
  const prevSecurities = securities - dayChange;
  return {
    securities,
    cost,
    pnl,
    pnlPct: cost > 0 ? (pnl / cost) * 100 : null,
    dayChange: dayKnown ? dayChange : null,
    dayChangePct:
      dayKnown && prevSecurities > 0
        ? (dayChange / prevSecurities) * 100
        : null,
    total: board.cash_cny != null ? securities + board.cash_cny : null,
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
  const refresh = useMutation({
    mutationFn: async () => await api.refreshQuotes({}),
    onSuccess: (res) => {
      queryClient.setQueryData(["board"], res.board);
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
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
    <section aria-label="总览">
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--dim)]">总览（人民币 · 收盘口径）</span>
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
      <p className="mt-0.5 text-right text-[11px] text-[var(--dim)]">
        {fetched ? `刷新于 ${fetched}（北京时间）` : "尚未刷新报价"}
        {refresh.isError ? " · 上次刷新失败，显示已存报价" : ""}
      </p>

      {empty ? (
        <p className="mt-3 border border-dashed border-[var(--border)] px-3 py-4 text-sm text-[var(--dim)]">
          等待录入：暂无持仓与现金记录。券商截图确认后，可在下方「持仓明细」逐笔添加，或由我代为录入。
        </p>
      ) : (
        <>
          <div className="mt-2">
            <span className="text-xs text-[var(--dim)]">总账户值</span>
            {/* Total value deliberately renders one size below body text
                (same rule as the US board, so it is not legible at a
                glance to bystanders). */}
            <span className="tnum ml-2 text-sm font-semibold">
              {totals.total != null ? mask(fmtMoney(totals.total)) : "—"}
            </span>
            {totals.total == null && (
              <span className="ml-2 text-xs text-[var(--dim)]">
                （现金未录入，暂不合计）
              </span>
            )}
          </div>
          <dl className="tnum mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-[var(--dim)]">证券市值</dt>
              <dd className="text-sm font-medium whitespace-nowrap sm:text-base">
                {board.holdings.length === 0
                  ? mask(fmtMoney(0))
                  : totals.complete
                    ? mask(fmtMoney(totals.securities))
                    : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--dim)]">现金</dt>
              <dd className="flex items-center gap-2 text-sm font-medium whitespace-nowrap sm:text-base">
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
              <dt className="text-xs text-[var(--dim)]">总浮盈亏</dt>
              <dd
                className="text-sm font-medium whitespace-nowrap sm:text-base"
                style={{ color: moveColor(totals.pnl) }}
              >
                {board.holdings.length === 0
                  ? "—"
                  : totals.complete
                    ? `${mask(fmtSignedMoney(totals.pnl))}${totals.pnlPct != null ? ` (${fmtPct(totals.pnlPct)})` : ""}`
                    : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--dim)]">今日涨跌</dt>
              <dd
                className="text-sm font-medium whitespace-nowrap sm:text-base"
                style={{ color: moveColor(totals.dayChange) }}
              >
                {totals.dayChange != null
                  ? `${mask(fmtSignedMoney(totals.dayChange))}${totals.dayChangePct != null ? ` (${fmtPct(totals.dayChangePct)})` : ""}`
                  : "—"}
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
  onDone,
}: {
  h: HoldingRow;
  mask: (s: string) => string;
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

type SortKey = "stock" | "chg" | "price" | "cost" | "pnlPct" | "pnl" | "mv" | "costAmt" | "qty" | "share";

// Standard-mode column budget (fits a 390px phone with no horizontal
// scroll and nothing clipped): name takes the remainder (≥ ~116px, so
// the longest names like 纳斯达克100ETF招商 fit on one line at 12px),
// then fixed right-aligned numeric columns — 涨跌幅 / 现价 / 成本价 /
// 浮盈亏% / 市值 (price columns render at 11px to stay narrow).
const HOLD_GRID = "minmax(0,1fr) 2.75rem 2.25rem 2.25rem 3.25rem 4.5rem";

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
            <span className="block text-xs whitespace-nowrap text-[var(--dim)]">
              {displayName(h.symbol, h.name)}
            </span>
          </span>
        );
      case "chg":
        return <Pct v={h.quote?.change_percent ?? null} />;
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
    <section aria-label="持仓明细">
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
        <div className="border-y border-[var(--border)]">
          <div
            className="grid items-baseline gap-0.5 border-b border-[var(--border)] px-1 py-1.5 text-[11px] whitespace-nowrap text-[var(--dim)]"
            style={{ gridTemplateColumns: HOLD_GRID }}
            aria-hidden="true"
          >
            <span>股票</span>
            <span className="text-right">涨跌幅</span>
            <span className="text-right">现价</span>
            <span className="text-right">成本价</span>
            <span className="text-right">浮盈亏%</span>
            <span className="text-right">市值</span>
          </div>
          <ul className="divide-y divide-[var(--border)]">
            {byShare.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  aria-expanded={expanded === h.id}
                  aria-label={`${h.name} 明细`}
                  onClick={() => setExpanded(expanded === h.id ? null : h.id)}
                  className="block w-full px-1 py-2 text-left"
                >
                  <span
                    className="grid items-baseline gap-0.5"
                    style={{ gridTemplateColumns: HOLD_GRID }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium tracking-tight whitespace-nowrap">
                        {h.name}
                      </span>
                      <span className="block text-[11px] text-[var(--dim)]">
                        {h.symbol}
                      </span>
                    </span>
                    <span className="tnum text-right text-xs whitespace-nowrap">
                      <Pct v={h.quote?.change_percent ?? null} />
                    </span>
                    <span className="tnum text-right text-[11px] whitespace-nowrap">
                      {h.quote ? fmtPrice(h.quote.price) : "—"}
                    </span>
                    <span className="tnum text-right text-[11px] whitespace-nowrap">
                      {fmtPrice(h.cost_per_share)}
                    </span>
                    <span className="tnum text-right text-xs whitespace-nowrap">
                      <Pct v={h.pnlPct} />
                    </span>
                    <span className="tnum text-right text-xs font-medium whitespace-nowrap">
                      {h.mv != null ? mask(fmtMoney(h.mv)) : "—"}
                    </span>
                  </span>
                </button>
                {expanded === h.id && (
                  <HoldingDetail
                    h={h}
                    mask={mask}
                    onDone={() => setExpanded(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="overflow-x-auto border-y border-[var(--border)]">
          <table className="tnum w-full min-w-[880px] border-collapse text-sm">
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th
                    key={c.key}
                    className={`bg-[var(--surface)] px-2 py-2 text-xs font-medium whitespace-nowrap text-[var(--dim)] ${i === 0 ? "sticky left-0 z-10 min-w-[9rem] text-left" : "text-right"}`}
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
              {tableRows.map((h) => (
                <tr
                  key={h.id}
                  className="cursor-pointer border-t border-[var(--border)]"
                  onClick={() => {
                    pickDensity("standard");
                    setExpanded(h.id);
                  }}
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
              ))}
            </tbody>
          </table>
          <p className="px-1 py-1.5 text-[11px] text-[var(--dim)]">
            点任意行回到标准模式编辑该持仓；点表头排序仅本次会话有效。
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
  return (
    <section aria-label="集中度">
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
    <section aria-label="交易流水">
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
                    {t.note && (
                      <p className="mt-0.5 leading-relaxed break-words">
                        备注：{t.note}
                      </p>
                    )}
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

function HistorySection({
  history,
  privacy,
  mask,
}: {
  history: Snapshot[];
  privacy: boolean;
  mask: (s: string) => string;
}) {
  const chartData = [...history].reverse();
  return (
    <section aria-label="历史">
      <SectionTitle>历史</SectionTitle>
      {history.length === 0 ? (
        <p className="border border-dashed border-[var(--border)] px-3 py-4 text-sm text-[var(--dim)]">
          暂无快照 · 等待录入。每个交易日 15:10 收盘刷新后自动落盘当日快照。
        </p>
      ) : (
        <>
          <div className="h-44 w-full" aria-label="总账户值曲线">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 6, right: 8, bottom: 0, left: 4 }}
              >
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => d.slice(5)}
                  tick={{ fontSize: 11, fill: "var(--dim)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  minTickGap={40}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  width={64}
                  tick={{ fontSize: 11, fill: "var(--dim)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) =>
                    privacy
                      ? "••••"
                      : v >= 10000
                        ? `${(v / 10000).toFixed(1)}万`
                        : String(Math.round(v))
                  }
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
                        <div>
                          总值 {mask(fmtMoney(s.account_value_cny))}
                        </div>
                        <div style={{ color: moveColor(s.day_change_cny) }}>
                          当日{" "}
                          {s.day_change_cny != null
                            ? `${mask(fmtSignedMoney(s.day_change_cny))} (${fmtPct(s.day_change_pct ?? 0)})`
                            : "—"}
                        </div>
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="account_value_cny"
                  stroke="var(--accent)"
                  strokeWidth={1.8}
                  dot={chartData.length <= 40}
                  activeDot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)]">
            {history.map((s) => (
              <li key={s.date} className="px-1 py-2">
                <div className="tnum flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">
                    {s.date.slice(5)}
                    <span className="ml-1 text-xs font-normal text-[var(--dim)]">
                      周{weekdayOf(s.date)}
                    </span>
                  </span>
                  <span>{mask(fmtMoney(s.account_value_cny))}</span>
                  <span
                    className="w-36 whitespace-nowrap text-right"
                    style={{ color: moveColor(s.day_change_cny) }}
                  >
                    {s.day_change_cny != null
                      ? `${mask(fmtSignedMoney(s.day_change_cny))} (${fmtPct(s.day_change_pct ?? 0)})`
                      : "—"}
                  </span>
                </div>
                <div className="tnum mt-0.5 flex flex-wrap gap-x-3 text-xs text-[var(--dim)]">
                  <span>证券 {mask(fmtMoney(s.securities_value_cny))}</span>
                  <span>现金 {mask(fmtMoney(s.cash_cny))}</span>
                  <span>
                    浮盈亏{" "}
                    <span style={{ color: moveColor(s.total_pnl_cny) }}>
                      {s.total_pnl_cny != null
                        ? mask(fmtSignedMoney(s.total_pnl_cny))
                        : "—"}
                    </span>
                  </span>
                  <span>
                    沪深300{" "}
                    {s.csi300_price != null
                      ? Math.round(s.csi300_price).toLocaleString("zh-CN")
                      : "—"}{" "}
                    <Pct v={s.csi300_change_pct} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
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
        <TradesSection mask={mask} />
        <HistorySection history={data.history} privacy={privacy} mask={mask} />
        <DataSection />
      </main>
    </div>
  );
}
