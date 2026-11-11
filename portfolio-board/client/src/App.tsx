import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Portfolio = ApiResponse<typeof api, "getPortfolio">;
type Holding = Portfolio["holdings"][number];

const money = (v: number, digits = 2) =>
  v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const signedMoney = (v: number) => `${v >= 0 ? "+" : "-"}$${money(Math.abs(v))}`;
const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const cny = (v: number) => `¥${money(v, 0)}`;
// After-hours moves at or beyond this size (vs the regular close) get a
// standalone flag; smaller ones stay visible in the row detail only.
const AFTER_ALERT_PCT = 3;

// Effective extended-hours quote for a holding: the ext_* fields,
// which the server derives from the per-session saved slots
// (pre_*/post_*/overnight_*, plan B) for the CURRENT session — so
// the first paint already shows that session's last saved price
// before any new refresh lands. Falls back to the legacy after_*
// post-session mirror for rows stored before the ext fields
// existed. Extended prices are always annotation / live-estimate
// material — never the official basis.
function effExt(q: Holding["quote"]): {
  price: number;
  pct: number | null;
  asOf: string | null;
  session: string;
} | null {
  if (!q) return null;
  if (q.ext_price != null) {
    return {
      price: q.ext_price,
      pct: q.ext_change_percent,
      asOf: q.ext_as_of,
      session: q.ext_session ?? "post",
    };
  }
  if (q.after_price != null) {
    return {
      price: q.after_price,
      pct: q.after_change_percent,
      asOf: q.after_as_of,
      session: "post",
    };
  }
  return null;
}

const extLabel = (session: string) =>
  session === "pre" ? "盘前" : session === "overnight" ? "夜盘" : "盘后";
// Table mode (replaces the old two-line compact list): columns in the
// user-confirmed order. Clicking a header sorts by that column.
type SortKey =
  | "symbol"
  | "dayPct"
  | "price"
  | "cost"
  | "pnlPct"
  | "pnl"
  | "mv"
  | "qty"
  | "weight";
const TABLE_COLS: { key: SortKey; label: string }[] = [
  { key: "symbol", label: "股票" },
  { key: "dayPct", label: "涨跌幅" },
  { key: "price", label: "现价" },
  { key: "cost", label: "成本价" },
  { key: "pnlPct", label: "浮盈亏%" },
  { key: "pnl", label: "浮盈亏" },
  { key: "mv", label: "市值" },
  { key: "qty", label: "股数" },
  { key: "weight", label: "占比" },
];
const SORT_KEYS: SortKey[] = TABLE_COLS.map((c) => c.key);

// Segment colors for the concentration stacked bar, assigned in
// descending theme-size order.
const THEME_COLORS = [
  "#d29922",
  "#4c8dff",
  "#2ebd6e",
  "#e5534b",
  "#38b6c9",
  "#9a7bff",
  "#e07b39",
  "#8b98a5",
];

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

// "刷新于 M/D HH:MM" for the server-recorded quote fetch time shown
// under the refresh button. Takes the ISO instant getPortfolio returns
// (quote_snapshots.fetched_at, max over the batch) and only formats it
// in Beijing time — never a client-side clock. Null when there is no
// usable timestamp, in which case the line is hidden entirely.
function fmtFetchedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hourCycle: "h23",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `刷新于 ${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

// Extended-hours detail time, one bare numeric time for every
// session. Overnight ext_as_of is the Yahoo fetch moment (fulldayPrice
// has no trade timestamp); pre/post ext_as_of is the Nasdaq session's
// last-trade stamp, stored server-side as a UTC ISO instant. Rows
// stored before that cleanup still hold the raw Nasdaq page stamp
// ("Nov 6, 2026 4:15 PM ET This page refreshes every 30 seconds") —
// parse the ET wall-clock stamp out of those here. A value with no
// parseable time yields null and the detail shows no time line at
// all: the raw source copy is never rendered. List rows (standard +
// table) show no time at all, so the columns stay aligned.
const EXT_MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wallAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wallAsUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function parseLegacyEtStamp(raw: string): Date | null {
  const m = raw.match(
    /([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AaPp])[Mm]/,
  );
  if (!m) return null;
  const month = EXT_MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
  if (month == null) return null;
  let hour = Number(m[4]) % 12;
  if ((m[6] ?? "").toLowerCase() === "p") hour += 12;
  const wallAsUtc = Date.UTC(
    Number(m[3]),
    month,
    Number(m[2]),
    hour,
    Number(m[5]),
  );
  const utc = wallAsUtc - tzOffsetMs(new Date(wallAsUtc), "America/New_York");
  const refined =
    wallAsUtc - tzOffsetMs(new Date(utc), "America/New_York");
  return new Date(refined);
}

function fmtExtTime(asOf: string | null): string | null {
  if (!asOf) return null;
  if (!Number.isNaN(new Date(asOf).getTime())) return fmtTime(asOf);
  const legacy = parseLegacyEtStamp(asOf);
  return legacy ? fmtTime(legacy.toISOString()) : null;
}

function RowDetail({
  h,
  privacy,
  readOnly,
  sessionKey,
  onSave,
  onRemove,
  saving,
}: {
  h: Holding;
  privacy: boolean;
  // Global view is read-only: no qty/cost editing, no removal.
  readOnly?: boolean;
  // Current US session key from the portfolio response; during the
  // overnight session a "post" extended price is only the latest
  // available (after-hours last trade, Yahoo yielded nothing) and is
  // labeled as such. Every session's time renders as one bare numeric
  // time via fmtExtTime (the overnight one is its fetch moment).
  sessionKey?: string;
  onSave: (qty: number, cost: number) => void;
  onRemove: () => void;
  saving: boolean;
}) {
  const mask = (s: string) => (privacy ? "••••" : s);
  const [qty, setQty] = useState(String(h.qty));
  const [cost, setCost] = useState(String(h.cost_per_share));
  const q = h.quote;
  const ext = effExt(q);
  const extTime = ext ? fmtExtTime(ext.asOf) : null;
  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="grid grid-cols-3 gap-x-2 gap-y-3 text-sm text-[var(--dim)]">
        <div>
          持股
          <div className="num mt-0.5 text-base text-[var(--text)]">
            {mask(`${h.qty} 股`)}
          </div>
        </div>
        <div>
          成本价
          <div className="num mt-0.5 text-base text-[var(--text)]">
            {mask(`$${money(h.cost_per_share)}`)}
          </div>
        </div>
        <div>
          今日盈亏
          <div
            className="num mt-0.5 text-base"
            style={{
              color:
                q?.change == null
                  ? "var(--text)"
                  : q.change >= 0
                    ? "var(--up)"
                    : "var(--down)",
            }}
          >
            {q?.change == null
              ? "—"
              : mask(signedMoney(q.change * h.qty))}
          </div>
        </div>
        <div>
          日内高 / 低
          <div className="num mt-0.5 text-base leading-snug text-[var(--text)]">
            {q?.high != null && q?.low != null ? (
              <>
                高 {money(q.high)}
                <br />
                低 {money(q.low)}
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
        <div>
          52 周区间
          <div className="num mt-0.5 text-base leading-snug text-[var(--text)]">
            {q?.week_52_low != null && q?.week_52_high != null ? (
              <>
                低 {money(q.week_52_low)}
                <br />
                高 {money(q.week_52_high)}
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
        <div>
          {ext ? `${extLabel(ext.session)}价` : "延长时段价"}
          <div className="num mt-0.5 text-base text-[var(--text)]">
            {ext ? `$${money(ext.price)}` : "—"}
            {ext?.pct != null && (
              <span
                className="block text-sm"
                style={{
                  color: ext.pct >= 0 ? "var(--up)" : "var(--down)",
                }}
              >
                {signedPct(ext.pct)}
              </span>
            )}
            {extTime && (
              <span className="block text-xs font-normal text-[var(--dim)]">
                {extTime}
              </span>
            )}
            {ext && sessionKey === "overnight" && ext.session !== "overnight" && (
              <span className="block text-xs font-normal text-[var(--dim)]">
                夜盘最近可得价
              </span>
            )}
          </div>
        </div>
      </div>

      {h.parts && h.parts.length > 1 && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <p className="text-sm text-[var(--dim)]">分账户分布</p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {h.parts.map((p) => (
              <li
                key={p.account_id}
                className="flex items-baseline justify-between gap-2"
              >
                <span>{p.account_name}</span>
                <span className="num text-[var(--dim)]">
                  {mask(`${p.qty} 股`)} · 成本{" "}
                  {mask(`$${money(p.cost_per_share)}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!readOnly && (
      <div className="mt-3 flex items-end gap-2">
        <label className="flex-1 text-sm text-[var(--dim)]">
          股数
          <input
            aria-label={`${h.symbol} 股数`}
            className="num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </label>
        <label className="flex-1 text-sm text-[var(--dim)]">
          成本价 $
          <input
            aria-label={`${h.symbol} 成本价`}
            className="num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            const nq = Number(qty);
            const nc = Number(cost);
            if (Number.isFinite(nq) && Number.isFinite(nc)) onSave(nq, nc);
          }}
          className="rounded-md bg-[var(--accent)] px-3 py-2 text-base font-medium text-black disabled:opacity-50"
        >
          保存
        </button>
        <button
          type="button"
          aria-label={`删除 ${h.symbol}`}
          onClick={onRemove}
          className="rounded-md border border-[var(--border)] px-3 py-2 text-base text-[var(--danger)]"
        >
          删除
        </button>
      </div>
      )}
    </div>
  );
}

type TradesData = ApiResponse<typeof api, "getTrades">;
type TradeRow = TradesData["trades"][number];

const TRADE_SOURCE_LABELS: Record<TradeRow["source"], string> = {
  order: "订单截图",
  snapshot_diff: "快照差分",
  opening: "期初",
  manual: "手动",
};

// Fractional-share quantities render like the holdings table:
// thousands separators, up to 4 decimals, no forced trailing zeros.
const fmtQty = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 4 });

// Trade ledger section （交易流水）, always the last section on the
// page (after 集中度与结构）. Follows the account tabs: the global
// view merges both accounts and is read-only (rows carry the account
// name); a single-account view can add / edit / delete entries. The
// realized-P/L summary at the top follows the same tab scope.
// Privacy mode masks the user's own execution prices and amounts
// (they are account records, not public quotes); quantities, symbols,
// dates and direction stay visible.
function TradesSection({
  accountId,
  readOnly,
  mask,
}: {
  // Null = global (merged, read-only).
  accountId: string | null;
  readOnly: boolean;
  // Privacy masking (execution prices + amounts) rides in via mask.
  mask: (s: string) => string;
}) {
  const queryClient = useQueryClient();
  const tradesQuery = useQuery({
    queryKey: ["trades"],
    queryFn: () => api.getTrades({}),
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["trades"] });
  const addTrade = useMutation({
    mutationFn: (args: Parameters<typeof api.addTrade>[0]) =>
      api.addTrade(args),
    onSuccess: invalidate,
  });
  const updateTrade = useMutation({
    mutationFn: (args: Parameters<typeof api.updateTrade>[0]) =>
      api.updateTrade(args),
    onSuccess: invalidate,
  });
  const deleteTrade = useMutation({
    mutationFn: (id: number) => api.deleteTrade({ id }),
    onSuccess: invalidate,
  });

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [fDate, setFDate] = useState("");
  const [fSymbol, setFSymbol] = useState("");
  const [fSide, setFSide] = useState<"buy" | "sell">("buy");
  const [fQty, setFQty] = useState("");
  const [fPrice, setFPrice] = useState("");
  const [fPriceKind, setFPriceKind] = useState<
    "actual" | "estimated" | "none"
  >("actual");
  const [fSource, setFSource] = useState<TradeRow["source"]>("manual");
  const [fNote, setFNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(
    null,
  );

  const data = tradesQuery.data;
  const rows = (data?.trades ?? []).filter(
    (t) => !accountId || t.account_id === accountId,
  );
  const summary = data
    ? accountId
      ? (data.realized.accounts.find((a) => a.account_id === accountId) ??
        data.realized.global)
      : data.realized.global
    : null;

  // Group the (already date-desc) rows by trade date.
  const groups: { date: string; rows: TradeRow[] }[] = [];
  for (const t of rows) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) last.rows.push(t);
    else groups.push({ date: t.date, rows: [t] });
  }

  const resetForm = () => {
    setEditingId(null);
    setFDate("");
    setFSymbol("");
    setFSide("buy");
    setFQty("");
    setFPrice("");
    setFPriceKind("actual");
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
    setFPriceKind(t.price_kind);
    setFSource(t.source);
    setFNote(t.note ?? "");
    setFormError(null);
    setShowForm(true);
  };
  const submitForm = (e: FormEvent) => {
    e.preventDefault();
    const qty = Number(fQty);
    const priceText = fPrice.trim();
    const price = priceText === "" ? null : Number(priceText);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fDate)) {
      setFormError("请选择成交日期");
      return;
    }
    if (!fSymbol.trim()) {
      setFormError("请填写代码");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setFormError("数量必须是正数");
      return;
    }
    if (price != null && (!Number.isFinite(price) || price <= 0)) {
      setFormError("成交价必须是正数，或留空表示未知");
      return;
    }
    // Price and its kind must agree: empty price ⇔ kind "none".
    const kind: "actual" | "estimated" | "none" =
      price == null ? "none" : fPriceKind === "none" ? "actual" : fPriceKind;
    const payload = {
      date: fDate,
      symbol: fSymbol.trim(),
      side: fSide,
      qty,
      price,
      price_kind: kind,
      source: fSource,
      note: fNote.trim() ? fNote.trim() : null,
    };
    const onDone = () => {
      setShowForm(false);
      resetForm();
    };
    const onErr = (err: unknown) =>
      setFormError(err instanceof Error ? err.message : "保存失败，请重试");
    if (editingId != null) {
      updateTrade.mutate(
        { id: editingId, ...payload },
        { onSuccess: onDone, onError: onErr },
      );
    } else if (accountId) {
      addTrade.mutate(
        { account_id: accountId, ...payload },
        { onSuccess: onDone, onError: onErr },
      );
    }
  };
  const saving = addTrade.isPending || updateTrade.isPending;

  const inputCls =
    "num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]";
  const textInputCls =
    "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]";

  return (
    <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">交易流水</h2>
        {!readOnly && (
          <button
            type="button"
            onClick={() => {
              if (showForm) {
                setShowForm(false);
                resetForm();
              } else {
                resetForm();
                setShowForm(true);
              }
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm"
          >
            {showForm ? "收起" : "＋ 记录一笔"}
          </button>
        )}
      </div>

      {summary && (
        <div className="mt-2">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-sm text-[var(--dim)]">已实现盈亏</span>
            {summary.total_usd == null ? (
              <span className="num text-base font-semibold">—</span>
            ) : (
              <span
                className="num text-base font-semibold"
                style={{
                  color:
                    summary.total_usd >= 0 ? "var(--up)" : "var(--down)",
                }}
              >
                {mask(signedMoney(summary.total_usd))}
              </span>
            )}
            {summary.has_estimated && (
              <span className="text-xs text-[var(--dim)]">含估算</span>
            )}
            {summary.has_unknown && (
              <span className="text-xs text-[var(--dim)]">部分未知</span>
            )}
          </div>
          {summary.by_symbol.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-[var(--dim)]">
              {summary.by_symbol.map((s) => (
                <span key={s.symbol} className="num whitespace-nowrap">
                  {s.symbol}{" "}
                  {s.realized_usd == null ? (
                    "—"
                  ) : (
                    <span
                      style={{
                        color:
                          s.realized_usd >= 0 ? "var(--up)" : "var(--down)",
                      }}
                    >
                      {mask(signedMoney(s.realized_usd))}
                    </span>
                  )}
                  {s.has_estimated ? " · 估" : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {showForm && !readOnly && (
        <form
          className="mt-3 rounded-md border border-[var(--border)] p-3"
          onSubmit={submitForm}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm text-[var(--dim)]">
              成交日期
              <input
                aria-label="成交日期"
                type="date"
                className={inputCls}
                value={fDate}
                onChange={(e) => setFDate(e.target.value)}
              />
            </label>
            <label className="text-sm text-[var(--dim)]">
              代码
              <input
                aria-label="交易代码"
                className={inputCls}
                value={fSymbol}
                onChange={(e) => setFSymbol(e.target.value)}
                placeholder="如 NVDA"
              />
            </label>
            <label className="text-sm text-[var(--dim)]">
              方向
              <select
                aria-label="买卖方向"
                className={textInputCls}
                value={fSide}
                onChange={(e) => setFSide(e.target.value as "buy" | "sell")}
              >
                <option value="buy">买入</option>
                <option value="sell">卖出</option>
              </select>
            </label>
            <label className="text-sm text-[var(--dim)]">
              数量（股）
              <input
                aria-label="交易数量"
                className={inputCls}
                inputMode="decimal"
                value={fQty}
                onChange={(e) => setFQty(e.target.value)}
              />
            </label>
            <label className="text-sm text-[var(--dim)]">
              成交价 $（可留空）
              <input
                aria-label="成交价"
                className={inputCls}
                inputMode="decimal"
                value={fPrice}
                onChange={(e) => setFPrice(e.target.value)}
                placeholder="留空 = 价未知"
              />
            </label>
            <label className="text-sm text-[var(--dim)]">
              价格类型
              <select
                aria-label="价格类型"
                className={textInputCls}
                value={fPriceKind}
                onChange={(e) =>
                  setFPriceKind(
                    e.target.value as "actual" | "estimated" | "none",
                  )
                }
              >
                <option value="actual">实际成交价</option>
                <option value="estimated">估算价</option>
                <option value="none">价格未知</option>
              </select>
            </label>
            <label className="text-sm text-[var(--dim)]">
              来源
              <select
                aria-label="记录来源"
                className={textInputCls}
                value={fSource}
                onChange={(e) =>
                  setFSource(e.target.value as TradeRow["source"])
                }
              >
                <option value="order">订单截图</option>
                <option value="snapshot_diff">快照差分</option>
                <option value="opening">期初</option>
                <option value="manual">手动</option>
              </select>
            </label>
            <label className="text-sm text-[var(--dim)]">
              备注（可空）
              <input
                aria-label="交易备注"
                className={textInputCls}
                value={fNote}
                onChange={(e) => setFNote(e.target.value)}
              />
            </label>
          </div>
          {formError && (
            <p className="mt-2 text-sm text-[var(--danger)]">{formError}</p>
          )}
          <button
            type="submit"
            disabled={saving}
            className="mt-3 w-full rounded-md bg-[var(--accent)] px-3 py-2 text-base font-medium text-black disabled:opacity-50"
          >
            {editingId != null ? "保存修改" : "记录这笔交易"}
          </button>
        </form>
      )}

      {tradesQuery.isPending ? (
        <p className="mt-4 text-sm text-[var(--dim)]">正在加载交易流水…</p>
      ) : tradesQuery.error ? (
        <div className="mt-4">
          <p className="text-sm text-[var(--danger)]">交易流水加载失败。</p>
          <button
            type="button"
            onClick={() => tradesQuery.refetch()}
            className="mt-2 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            重新加载
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--dim)]">
          暂无交易记录。
          {readOnly
            ? ""
            : "点上方「＋ 记录一笔」添加，或发来订单截图 / 整户持仓后由记录补入。"}
        </p>
      ) : (
        <div className="mt-2">
          {groups.map((g) => (
            <div key={g.date} className="mt-3">
              <p className="num text-sm font-medium text-[var(--dim)]">
                {g.date}
              </p>
              <ul className="mt-1 divide-y divide-[color-mix(in_srgb,var(--border)_55%,transparent)]">
                {g.rows.map((t) => {
                  const amount =
                    t.price != null ? t.qty * t.price : null;
                  return (
                    <li key={t.id} className="py-2">
                      <div className="flex items-baseline gap-2">
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold"
                          style={{
                            color:
                              t.side === "buy"
                                ? "var(--up)"
                                : "var(--down)",
                            background:
                              t.side === "buy"
                                ? "color-mix(in srgb, var(--up) 10%, transparent)"
                                : "color-mix(in srgb, var(--down) 10%, transparent)",
                          }}
                        >
                          {t.side === "buy" ? "买入" : "卖出"}
                        </span>
                        <span className="num min-w-0 truncate text-base font-medium">
                          {t.symbol}
                        </span>
                        {readOnly && (
                          <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs text-[var(--dim)]">
                            {t.account_name}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-sm">
                          {amount == null ? (
                            <span className="text-[var(--dim)]">—</span>
                          ) : (
                            <span className="num">
                              {mask(`$${money(amount)}`)}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="num mt-0.5 text-sm text-[var(--dim)]">
                        {fmtQty(t.qty)} 股 @{" "}
                        {t.price == null ? (
                          "价未知"
                        ) : (
                          <>
                            {mask(`$${money(t.price)}`)}
                            {t.price_kind === "estimated" ? "（估）" : ""}
                          </>
                        )}
                        <span className="ml-2 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs">
                          {TRADE_SOURCE_LABELS[t.source]}
                        </span>
                      </div>
                      {t.note && (
                        <p className="mt-0.5 text-sm text-[var(--dim)]">
                          {t.note}
                        </p>
                      )}
                      {!readOnly && (
                        <div className="mt-1 flex gap-2 text-sm">
                          <button
                            type="button"
                            aria-label={`编辑 ${t.symbol} 交易记录`}
                            onClick={() => startEdit(t)}
                            className="rounded border border-[var(--border)] px-2 py-0.5"
                          >
                            编辑
                          </button>
                          {confirmDeleteId === t.id ? (
                            <>
                              <button
                                type="button"
                                aria-label={`确认删除 ${t.symbol} 交易记录`}
                                disabled={deleteTrade.isPending}
                                onClick={() =>
                                  deleteTrade.mutate(t.id, {
                                    onSuccess: () =>
                                      setConfirmDeleteId(null),
                                  })
                                }
                                className="rounded border border-[var(--danger)] px-2 py-0.5 text-[var(--danger)] disabled:opacity-50"
                              >
                                确认删除
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded border border-[var(--border)] px-2 py-0.5"
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              aria-label={`删除 ${t.symbol} 交易记录`}
                              onClick={() => setConfirmDeleteId(t.id)}
                              className="rounded border border-[var(--border)] px-2 py-0.5"
                            >
                              删除
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const portfolio = useQuery({
    queryKey: ["portfolio"],
    queryFn: () => api.getPortfolio({}),
    // Cold start: the first action call after the board has been idle can
    // fail transiently while the server worker spins up, before the
    // handler ever runs. Retry with backoff so a cold open self-heals;
    // the query stays in its loading state while retrying and only
    // surfaces the error after every attempt has failed. Permanent 4xx
    // errors are not retried — they would fail identically every time.
    retry: (failureCount, error) => {
      if (failureCount >= 3) return false;
      const status = (error as { status?: unknown })?.status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        return false;
      }
      return true;
    },
    retryDelay: (attempt) => Math.min(600 * 2 ** attempt, 4000),
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshQuotes({}),
    onSuccess: (res) => {
      queryClient.setQueryData(["portfolio"], res.portfolio);
    },
  });

  // Fetch-on-open: refresh when there is no cache or it is stale. The
  // staleness window tightens to 2 minutes while an extended session
  // is live （盘前/盘后/夜盘）, so the realtime extended prices and the
  // live estimate are near-current on open; otherwise 5 minutes.
  const autoRefreshed = useRef(false);
  useEffect(() => {
    if (autoRefreshed.current || !portfolio.data) return;
    const last = portfolio.data.last_fetched_at;
    const sk = portfolio.data.session.key;
    const staleMs =
      sk === "pre" || sk === "post" || sk === "overnight"
        ? 2 * 60 * 1000
        : 5 * 60 * 1000;
    const stale =
      !last || Date.now() - new Date(last).getTime() > staleMs;
    if (stale && portfolio.data.holdings.length > 0) {
      autoRefreshed.current = true;
      refresh.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio.data]);

  // While an extended session is live, keep tracking: re-refresh every
  // 2 minutes for as long as the board stays open and visible. The
  // official close-basis figures never change from this — only the
  // extended annotations and the labeled live estimate move.
  const refreshPending = useRef(false);
  refreshPending.current = refresh.isPending;
  const sessionKey = portfolio.data?.session.key;
  useEffect(() => {
    if (sessionKey !== "pre" && sessionKey !== "post" && sessionKey !== "overnight")
      return;
    const t = setInterval(() => {
      if (!refreshPending.current && !document.hidden) refresh.mutate();
    }, 2 * 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const seed = useMutation({
    mutationFn: () => api.seedHoldings({}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      refresh.mutate();
    },
  });

  const update = useMutation({
    mutationFn: (args: { id: number; qty: number; cost_per_share: number }) =>
      api.updateHolding(args),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["portfolio"] }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.removeHolding({ id }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["portfolio"] }),
  });
  const updateCash = useMutation({
    mutationFn: (args: { account_id: string; cash_usd: number }) =>
      api.updateCash(args),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["portfolio"] }),
  });
  const add = useMutation({
    mutationFn: (args: {
      account_id: string;
      symbol: string;
      name: string;
      qty: number;
      cost_per_share: number;
      kind: "stock" | "etf";
      theme: string;
    }) => api.addHolding(args),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      refresh.mutate();
    },
  });

  const [expanded, setExpanded] = useState<number | null>(null);
  const [showCashEdit, setShowCashEdit] = useState(false);
  const [cashInput, setCashInput] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [newName, setNewName] = useState("");
  const [newQty, setNewQty] = useState("");
  const [newCost, setNewCost] = useState("");
  const [newTheme, setNewTheme] = useState("半导体");
  // Privacy mask: hides only the user's private asset amounts (account
  // total, CNY amount, securities value, cash, per-holding market value,
  // qty, cost price, P/L amounts, concentration amounts, and the
  // day-change amounts — both the overview 今日涨跌 total and each
  // holding's 今日盈亏). Percentages (including the day-change %) and
  // public market data (index strip, quote prices and their moves)
  // always stay visible. Exception (user, 2026-11-08): the holdings
  // table's 成本价 column is NOT masked; the expanded detail's cost
  // stays masked. Persisted across opens.
  const [privacy, setPrivacy] = useState<boolean>(() => {
    try {
      return localStorage.getItem("portfolio-board-privacy") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("portfolio-board-privacy", privacy ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [privacy]);
  const mask = (s: string) => (privacy ? "••••" : s);
  // Holdings list density: "standard" (card rows) or "table" (the
  // sortable table that replaced the old two-line compact list on
  // 2026-11-08, user-confirmed). A saved v2 "compact" now lands on
  // "table" — the compact slot became the table.
  const [density, setDensity] = useState<"standard" | "table">(() => {
    try {
      const v = localStorage.getItem("portfolio-board-density-v2");
      return v === "compact" || v === "table" ? "table" : "standard";
    } catch {
      return "standard";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("portfolio-board-density-v2", density);
    } catch {
      /* storage unavailable */
    }
  }, [density]);
  // Table sort: default 市值 descending (same as the card list). Clicking
  // a header selects that column (numbers descending, 股票 ascending);
  // clicking the active column flips direction. Persisted like density.
  const [tableSort, setTableSort] = useState<{
    key: SortKey;
    dir: 1 | -1;
  }>(() => {
    try {
      const raw = localStorage.getItem("portfolio-board-table-sort");
      if (raw) {
        const p = JSON.parse(raw) as { key?: string; dir?: number };
        if (p.key && (SORT_KEYS as string[]).includes(p.key)) {
          return { key: p.key as SortKey, dir: p.dir === 1 ? 1 : -1 };
        }
      }
    } catch {
      /* storage unavailable or malformed */
    }
    return { key: "mv", dir: -1 };
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "portfolio-board-table-sort",
        JSON.stringify(tableSort),
      );
    } catch {
      /* storage unavailable */
    }
  }, [tableSort]);
  const toggleSort = (key: SortKey) =>
    setTableSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 1 ? -1 : 1 }
        : { key, dir: key === "symbol" ? 1 : -1 },
    );
  // Account tab: "global" (all accounts merged, read-only) or one
  // account id. Persisted across opens; falls back to global when the
  // saved account no longer exists.
  const [accountView, setAccountView] = useState<string>(() => {
    try {
      return localStorage.getItem("kanban-account-view") ?? "global";
    } catch {
      return "global";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("kanban-account-view", accountView);
    } catch {
      /* storage unavailable */
    }
  }, [accountView]);
  const switchAccount = (v: string) => {
    setAccountView(v);
    setExpanded(null);
    setShowAdd(false);
    setShowCashEdit(false);
  };
  // Market strip collapse: the ten benchmark rows can be folded down
  // to just the first two (SPX / NDX, user-confirmed 2026-11-09); the
  // column-header row doubles as the full-width toggle and always
  // stays visible. Default expanded; the choice persists across opens.
  const [marketExpanded, setMarketExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem("portfolio-board-market-expanded") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "portfolio-board-market-expanded",
        marketExpanded ? "1" : "0",
      );
    } catch {
      /* storage unavailable */
    }
  }, [marketExpanded]);

  const data = portfolio.data;

  // The active view: global merges every account (read-only); a single
  // account shows just its own holdings/cash and stays editable.
  const view = useMemo(() => {
    if (!data) return null;
    const acc = data.accounts.find((a) => a.account.id === accountView);
    if (accountView !== "global" && acc) {
      return {
        key: acc.account.id,
        label: acc.account.name,
        holdings: acc.holdings,
        cash: acc.cash,
        readOnly: false,
      };
    }
    return {
      key: "global",
      label: "全局",
      holdings: data.holdings,
      cash: data.cash,
      readOnly: true,
    };
  }, [data, accountView]);

  const derived = useMemo(() => {
    if (!data || !view) return null;
    const rows = view.holdings.map((h) => {
      const price = h.quote?.price ?? null;
      const mv = price != null ? price * h.qty : null;
      const costBasis = h.cost_per_share * h.qty;
      const dayChange =
        h.quote?.change != null ? h.quote.change * h.qty : null;
      const pnl = price != null ? (price - h.cost_per_share) * h.qty : null;
      const pnlPct =
        price != null
          ? ((price - h.cost_per_share) / h.cost_per_share) * 100
          : null;
      return { h, price, mv, costBasis, dayChange, pnl, pnlPct };
    });
    // One consistent basis: every aggregate covers only holdings that have
    // a quote. An unpriced holding (no quote from the source) is excluded
    // from market value, cost, P/L and theme totals alike, and named in the
    // UI note, so all figures reconcile.
    const priced = rows.filter((r) => r.mv != null);
    const totalMv = priced.reduce((s, r) => s + (r.mv ?? 0), 0);
    const totalCost = priced.reduce((s, r) => s + r.costBasis, 0);
    const fullCost = rows.reduce((s, r) => s + r.costBasis, 0);
    const totalDay = priced.reduce((s, r) => s + (r.dayChange ?? 0), 0);
    const prevTotal = totalMv - totalDay;
    const dayPct = prevTotal > 0 ? (totalDay / prevTotal) * 100 : 0;
    const totalPnl = totalMv - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const sorted = [...rows].sort(
      (a, b) => (b.mv ?? b.costBasis) - (a.mv ?? a.costBasis),
    );
    const themes = new Map<string, number>();
    for (const r of priced) {
      themes.set(r.h.theme, (themes.get(r.h.theme) ?? 0) + (r.mv ?? 0));
    }
    const themeRows = [...themes.entries()]
      .map(([theme, v]) => ({ theme, v, pct: totalMv > 0 ? (v / totalMv) * 100 : 0 }))
      .sort((a, b) => b.v - a.v);
    const alphabet = rows
      .filter((r) => r.h.symbol === "GOOG" || r.h.symbol === "GOOGL")
      .reduce((s, r) => s + (r.mv ?? 0), 0);
    const semi = themes.get("半导体") ?? 0;
    const losers = rows
      .filter((r) => (r.pnl ?? 0) < 0)
      .sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0));
    const totalLoss = losers.reduce((s, r) => s + (r.pnl ?? 0), 0);
    const top3Loss = losers.slice(0, 3).reduce((s, r) => s + (r.pnl ?? 0), 0);
    // Top holdings with GOOG + GOOGL merged into one Alphabet exposure.
    const byCompany = new Map<
      string,
      { label: string; sub: string; mv: number }
    >();
    for (const r of priced) {
      const isAlphabet = r.h.symbol === "GOOG" || r.h.symbol === "GOOGL";
      const key = isAlphabet ? "ALPHABET" : r.h.symbol;
      const cur = byCompany.get(key) ?? {
        label: isAlphabet ? "GOOG + GOOGL" : r.h.symbol,
        sub: isAlphabet ? "合并口径" : r.h.name,
        mv: 0,
      };
      cur.mv += r.mv ?? 0;
      byCompany.set(key, cur);
    }
    const topHoldings = [...byCompany.values()]
      .sort((a, b) => b.mv - a.mv)
      .slice(0, 5)
      .map((t) => ({
        ...t,
        pct: totalMv > 0 ? (t.mv / totalMv) * 100 : 0,
      }));
    const loserRows = losers.slice(0, 4).map((r) => ({
      symbol: r.h.symbol,
      pnl: r.pnl ?? 0,
      share: totalLoss < 0 ? Math.abs((r.pnl ?? 0) / totalLoss) * 100 : 0,
    }));
    const asOf =
      data.holdings
        .map((h) => h.quote?.as_of)
        .filter((x): x is string => !!x)
        .sort()
        .at(-1) ?? null;
    const marketStatus =
      data.holdings.find((h) => h.quote?.market_status)?.quote?.market_status ??
      null;
    const fxRate = data.fx?.rate ?? null;
    const cashUsd = view.cash?.cash_usd ?? null;
    const accountValue =
      cashUsd != null ? totalMv + cashUsd : null;
    const extAlerts = rows
      .map((r) => ({ r, e: effExt(r.h.quote) }))
      .filter(
        (x) => x.e?.pct != null && Math.abs(x.e.pct) >= AFTER_ALERT_PCT,
      )
      .map((x) => ({
        symbol: x.r.h.symbol,
        extPrice: x.e?.price ?? null,
        extPct: x.e?.pct ?? 0,
        extSession: x.e?.session ?? "post",
        extAsOf: x.e?.asOf ?? null,
      }))
      .sort((a, b) => Math.abs(b.extPct) - Math.abs(a.extPct));
    const alertSessions = new Set(extAlerts.map((a) => a.extSession));
    const extAlertLabel =
      alertSessions.size === 1
        ? extLabel(extAlerts[0]?.extSession ?? "post")
        : "延长时段";
    // Live estimate (unofficial): extended price where one exists,
    // regular close otherwise, × qty + cash — compared against the
    // official close-basis account value. Holdings without any quote
    // stay excluded, on the same basis as the official totals.
    const estSecurities = priced.reduce((s, r) => {
      const e = effExt(r.h.quote);
      return s + (e ? e.price : (r.price ?? 0)) * r.h.qty;
    }, 0);
    const estCovered = priced.filter(
      (r) => effExt(r.h.quote) != null,
    ).length;
    const estAccountValue =
      estCovered > 0 && cashUsd != null ? estSecurities + cashUsd : null;
    const estDiff =
      estAccountValue != null && accountValue != null
        ? estAccountValue - accountValue
        : null;
    const estDiffPct =
      estDiff != null && accountValue != null && accountValue > 0
        ? (estDiff / accountValue) * 100
        : null;
    const estSessions = new Set(
      priced
        .map((r) => effExt(r.h.quote)?.session)
        .filter((x): x is string => !!x),
    );
    const estLabel =
      data.session.key === "overnight"
        ? estSessions.has("overnight")
          ? "夜盘"
          : "夜盘最近可得"
        : estSessions.size === 1
          ? extLabel([...estSessions][0] ?? "post")
          : "延长时段";
    return {
      rows: sorted,
      totalMv,
      totalCost,
      fullCost,
      pricedCount: priced.length,
      totalDay,
      dayPct,
      totalPnl,
      totalPnlPct,
      themeRows,
      alphabetPct: totalMv > 0 ? (alphabet / totalMv) * 100 : 0,
      semiPct: totalMv > 0 ? (semi / totalMv) * 100 : 0,
      topLosers: losers.slice(0, 3).map((r) => r.h.symbol).join("、"),
      lossConcentration:
        totalLoss < 0 ? Math.abs(top3Loss / totalLoss) * 100 : 0,
      topHoldings,
      loserRows,
      totalLoss,
      asOf,
      marketStatus,
      fxRate,
      cashUsd,
      accountValue,
      extAlerts,
      extAlertLabel,
      estAccountValue,
      estDiff,
      estDiffPct,
      estLabel,
      anyQuotes: rows.some((r) => r.price != null),
      missingQuotes: rows
        .filter((r) => r.price == null)
        .map((r) => r.h.symbol),
    };
  }, [data, view]);

  // Table rows: derived rows + weight, re-sorted by the active table
  // column. Rows without a value for the sort column (e.g. no quote)
  // always sink to the bottom, whichever direction is active.
  const tableRows = useMemo(() => {
    if (!derived) return [];
    const withWeight = derived.rows.map((r) => ({
      r,
      weight:
        r.mv != null && derived.totalMv > 0
          ? (r.mv / derived.totalMv) * 100
          : null,
    }));
    const value = (
      r: (typeof derived.rows)[number],
      weight: number | null,
    ): number | string | null => {
      switch (tableSort.key) {
        case "symbol":
          return r.h.symbol;
        case "dayPct":
          return r.h.quote?.change_percent ?? null;
        case "price":
          return r.price;
        case "cost":
          return r.h.cost_per_share;
        case "pnlPct":
          return r.pnlPct;
        case "pnl":
          return r.pnl;
        case "mv":
          return r.mv;
        case "qty":
          return r.h.qty;
        case "weight":
          return weight;
      }
    };
    return [...withWeight].sort((a, b) => {
      const va = value(a.r, a.weight);
      const vb = value(b.r, b.weight);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp =
        typeof va === "string"
          ? va.localeCompare(vb as string)
          : va - (vb as number);
      return cmp * tableSort.dir;
    });
  }, [derived, tableSort]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10">
        {portfolio.isPending && (
          <p className="py-16 text-center text-sm text-[var(--dim)]">
            正在加载持仓…
          </p>
        )}
        {portfolio.error && (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--danger)]">
              持仓加载失败，请稍后重试。
            </p>
            <button
              type="button"
              onClick={() => portfolio.refetch()}
              disabled={portfolio.isFetching}
              className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-base disabled:opacity-50"
            >
              {portfolio.isFetching ? "加载中…" : "重新加载"}
            </button>
          </div>
        )}

        {data && data.holdings.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-base font-medium">还没有持仓记录</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--dim)]">
              导入示例持仓（虚构数据）先看效果，之后可逐只改成你自己的持仓，按最新报价跟踪。
            </p>
            <button
              type="button"
              disabled={seed.isPending}
              onClick={() => seed.mutate()}
              className="mt-5 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
            >
              导入示例持仓
            </button>
          </div>
        )}

        {data && derived && view && data.holdings.length > 0 && (
          <>
            {/* Market strip: single-column compact list at the very top
                (plan C, 2026-11-08) — one row per benchmark with four
                aligned columns: bold name | right-aligned price | day
                change badge | 距高点 (drawdown). A slim column-header
                row （现价 / 日涨跌 / 距高点） sits above the rows so the
                drawdown column needs no in-row label — just the number.
                The drawdown is measured against the trailing-3-year
                highest close (peak3y, dual-stored server-side with the
                all-time peak since 2026-11-09); a row at its 3-year
                peak still reads 历史新高. Public market data, never
                masked by privacy mode.
                Fixed-width right columns keep the rows aligned and
                overflow-free at phone width. Eleven benchmarks since
                2026-11-09 （纳指综合 / 上证 / 沪深300 / 中证A500 /
                恒生科技 / 日经225 / 越南胡志明 added). Prices render
                as integers (display-only rounding via money(v, 0);
                the stored price and the 距高点 math keep full
                precision), which lets the price column run narrower
                and gives the two percentage columns more room. The
                header row itself is the collapse toggle (full-width
                button, ~36px tall): tapping anywhere on it folds the
                strip down to the first two rows （标普500 / 纳指100）
                or expands it back to all eleven; default expanded
                and the choice persists. */}
            {data.market.length > 0 && (
              <section
                aria-label="市场行情"
                className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] px-3 py-1.5"
              >
                <div className="divide-y divide-[color-mix(in_srgb,var(--border)_55%,transparent)]">
                  {/* Column-header row = the collapse toggle: the
                      whole row is one full-width button (~36px tall),
                      so tapping anywhere on it — labels included —
                      folds/expands the strip. The name column shows the
                      state hint （收起/展开 + arrow) instead of a label
                      (names are self-evident); the three right columns
                      keep the exact widths / alignment of the data
                      rows below, in both states, so nothing shifts. */}
                  <button
                    type="button"
                    aria-expanded={marketExpanded}
                    aria-label={marketExpanded ? "收起市场行情" : "展开市场行情"}
                    onClick={() => setMarketExpanded((v) => !v)}
                    className="flex min-h-[36px] w-full items-center gap-x-2 text-left text-[11px] leading-4 text-[var(--dim)] transition-opacity active:opacity-50"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1">
                      {marketExpanded ? "收起" : "展开"}
                      <span aria-hidden className="text-[8px]">
                        {marketExpanded ? "▲" : "▼"}
                      </span>
                    </span>
                    <span aria-hidden="true" className="w-[74px] shrink-0 text-right">现价</span>
                    <span aria-hidden="true" className="w-[74px] shrink-0">日涨跌</span>
                    <span aria-hidden="true" className="w-[62px] shrink-0 text-right">
                      距高点
                    </span>
                  </button>
                  {(marketExpanded
                    ? data.market
                    : data.market.slice(0, 2)
                  ).map((m) => {
                    const cp = m.change_percent;
                    const badgeColor =
                      cp == null
                        ? "var(--dim)"
                        : cp >= 0
                          ? "var(--up)"
                          : "var(--down)";
                    const badgeBg =
                      cp == null
                        ? "transparent"
                        : cp >= 0
                          ? "color-mix(in srgb, var(--up) 9%, transparent)"
                          : "color-mix(in srgb, var(--down) 9%, transparent)";
                    // Current drawdown from the trailing-3-year highest
                    // close （距高点）: null peak3y (seed not landed yet)
                    // → the column stays empty, no placeholder text.
                    // The all-time peak stays stored server-side; only
                    // the 3-year figure drives this column.
                    const dd =
                      m.price != null &&
                      m.peak3y_price != null &&
                      m.peak3y_price > 0
                        ? ((m.price - m.peak3y_price) / m.peak3y_price) * 100
                        : null;
                    return (
                      <div
                        key={m.key}
                        className="flex items-center gap-x-2 py-[5px]"
                      >
                        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap text-[15px] font-semibold leading-[22px]">
                          <span>{m.label}</span>
                          {m.key === "SGOLD" ? (
                            <span className="text-[11px] font-normal text-[var(--dim)]">
                              元/克
                              {m.source === "换算" ? " · 换算价" : ""}
                            </span>
                          ) : null}
                        </p>
                        <span className="num w-[74px] shrink-0 whitespace-nowrap text-right text-[17px] font-semibold leading-[22px] tracking-tight">
                          {m.price != null
                            ? m.key === "GOLD"
                              ? `$${money(m.price, 0)}`
                              : m.key === "SGOLD"
                                ? `¥${money(m.price, 0)}`
                                : money(m.price, 0)
                            : "—"}
                        </span>
                        <span className="flex w-[74px] shrink-0 items-center">
                          <span
                            className="num inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[14px] font-bold leading-tight"
                            style={{ color: badgeColor, backgroundColor: badgeBg }}
                          >
                            {cp != null && cp !== 0 && (
                              <span aria-hidden className="text-[9px]">
                                {cp > 0 ? "▲" : "▼"}
                              </span>
                            )}
                            {cp != null ? signedPct(cp) : "—"}
                          </span>
                        </span>
                        <span className="num w-[62px] shrink-0 whitespace-nowrap text-right text-[13px] font-medium leading-[22px]">
                          {dd != null &&
                            (dd > -0.05 ? (
                              <span style={{ color: "var(--up)" }}>
                                历史新高
                              </span>
                            ) : (
                              <span style={{ color: "var(--down)" }}>
                                {dd.toFixed(1)}%
                              </span>
                            ))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Account tabs: 全局 (all accounts merged, read-only) plus
                one tab per account. Everything below the tabs follows
                the selected view; the market strip above is
                market-wide and never switches. */}
            <nav
              aria-label="账户切换"
              className="mt-3 flex gap-1 rounded-[var(--radius)] bg-[var(--surface)] p-1"
            >
              {[
                { id: "global", name: "全局" },
                ...data.accounts.map((a) => a.account),
              ].map((t) => {
                const active = view.key === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => switchAccount(t.id)}
                    className="flex-1 rounded-md px-3 py-2 text-base"
                    style={
                      active
                        ? {
                            background: "var(--accent)",
                            color: "#000",
                            fontWeight: 600,
                          }
                        : { color: "var(--dim)" }
                    }
                  >
                    {t.name}
                  </button>
                );
              })}
            </nav>
            <div className="mt-2 text-xs leading-snug text-[var(--dim)]">
              <p>
                当前美东时段：{data.session.label}
                {data.session.key === "overnight"
                  ? data.holdings.some(
                      (h) => h.quote?.ext_session === "overnight",
                    )
                    ? " · 夜盘价实时抓取自 Yahoo"
                    : " · 夜盘显示盘后最后成交价"
                  : ""}
              </p>
              {data.session.rangeEt && data.session.rangeBj && (
                <p className="num mt-0.5 whitespace-nowrap">
                  美东 {data.session.rangeEt} · 北京 {data.session.rangeBj}
                </p>
              )}
            </div>
            {view.readOnly && (
              <p className="mt-1.5 text-xs text-[var(--dim)]">
                全局 · 只读汇总，切到单账户可编辑
              </p>
            )}

            {/* Hero: account value on top (kept small), then a 2x2 grid:
                今日涨跌 | 总浮盈亏 / 证券总市值 | 现金, side by side at
                every width. Amounts use compact sizes so nothing clips
                at 390px. */}
            {(view.holdings.length > 0 || view.cash != null) && (
            <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-[var(--dim)]">总账户值</p>
                  <p className="num mt-1 whitespace-nowrap text-2xl font-semibold tracking-tight">
                    {derived.anyQuotes && derived.accountValue != null
                      ? mask(`$${money(derived.accountValue)}`)
                      : "—"}
                  </p>
                  {derived.anyQuotes &&
                    derived.accountValue != null &&
                    derived.fxRate != null && (
                      <p className="num mt-1 whitespace-nowrap text-[13px] text-[var(--dim)]">
                        ≈{" "}
                        {mask(cny(derived.accountValue * derived.fxRate))}
                        （汇率 {derived.fxRate.toFixed(3)}）
                      </p>
                    )}
                  {data.session.key !== "regular" &&
                    derived.estDiff != null &&
                    derived.estAccountValue != null && (
                      <p className="mt-1 text-[13px] leading-snug">
                        <span className="text-[var(--dim)]">
                          实时估算（{derived.estLabel}）
                        </span>{" "}
                        <span className="num">
                          {mask(`$${money(derived.estAccountValue)}`)}
                        </span>{" "}
                        <span
                          className="num whitespace-nowrap font-medium"
                          style={{
                            color:
                              derived.estDiff >= 0
                                ? "var(--up)"
                                : "var(--down)",
                          }}
                        >
                          相对收盘 {mask(signedMoney(derived.estDiff))}
                          {derived.estDiffPct != null
                            ? ` · ${signedPct(derived.estDiffPct)}`
                            : ""}
                        </span>
                      </p>
                    )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={privacy ? "显示账户数值" : "隐藏账户数值"}
                    aria-pressed={privacy}
                    onClick={() => setPrivacy((v) => !v)}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-2 text-[var(--dim)]"
                  >
                    {privacy ? (
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
                        <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
                        <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
                        <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
                        <path d="m2 2 20 20" />
                      </svg>
                    ) : (
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
                        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => refresh.mutate()}
                    disabled={refresh.isPending}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-base disabled:opacity-50"
                  >
                    {refresh.isPending ? "刷新中…" : "刷新报价"}
                  </button>
                  </div>
                  {fmtFetchedAt(data.last_fetched_at) && (
                    <p className="num whitespace-nowrap text-right text-[11px] leading-none text-[var(--dim)]">
                      {fmtFetchedAt(data.last_fetched_at)}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div
                  className="min-w-0 rounded-[var(--radius)] p-2.5"
                  style={{
                    backgroundColor: derived.anyQuotes
                      ? derived.totalDay >= 0
                        ? "color-mix(in srgb, var(--up) 14%, transparent)"
                        : "color-mix(in srgb, var(--down) 14%, transparent)"
                      : "var(--surface-2)",
                  }}
                >
                  <p className="text-sm text-[var(--dim)]">今日涨跌</p>
                  <p
                    className="num mt-1 whitespace-nowrap text-lg font-semibold leading-tight"
                    style={{
                      color: derived.anyQuotes
                        ? derived.totalDay >= 0
                          ? "var(--up)"
                          : "var(--down)"
                        : "var(--text)",
                    }}
                  >
                    {derived.anyQuotes
                      ? mask(signedMoney(derived.totalDay))
                      : "—"}
                  </p>
                  <p
                    className="num mt-0.5 text-base font-medium"
                    style={{
                      color:
                        derived.totalDay >= 0 ? "var(--up)" : "var(--down)",
                    }}
                  >
                    {derived.anyQuotes ? signedPct(derived.dayPct) : ""}
                  </p>
                </div>
                <div className="min-w-0 rounded-[var(--radius)] bg-[var(--surface-2)] p-2.5">
                  <p className="text-sm text-[var(--dim)]">总浮盈亏</p>
                  <p
                    className="num mt-1 whitespace-nowrap text-base font-medium leading-tight"
                    style={{
                      color:
                        derived.totalPnl >= 0 ? "var(--up)" : "var(--down)",
                    }}
                  >
                    {derived.anyQuotes
                      ? mask(signedMoney(derived.totalPnl))
                      : "—"}
                  </p>
                  <p
                    className="num mt-0.5 text-sm"
                    style={{
                      color:
                        derived.totalPnl >= 0 ? "var(--up)" : "var(--down)",
                    }}
                  >
                    {derived.anyQuotes
                      ? signedPct(derived.totalPnlPct)
                      : ""}
                  </p>
                </div>
                <div className="min-w-0 rounded-[var(--radius)] bg-[var(--surface-2)] p-2.5">
                  <p className="text-sm text-[var(--dim)]">证券总市值</p>
                  <p className="num mt-1 whitespace-nowrap text-base font-medium">
                    {derived.anyQuotes
                      ? mask(`$${money(derived.totalMv)}`)
                      : "—"}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--dim)]">
                    {derived.missingQuotes.length > 0
                      ? `${derived.pricedCount} 只已报价`
                      : `${view.holdings.length} 只持仓`}
                  </p>
                </div>
                <div className="min-w-0 rounded-[var(--radius)] bg-[var(--surface-2)] p-2.5">
                  <div className="flex items-baseline justify-between gap-1">
                    <p className="text-sm text-[var(--dim)]">现金</p>
                    {!view.readOnly && (
                    <button
                      type="button"
                      aria-label="更新现金余额"
                      onClick={() => {
                        setCashInput(
                          derived.cashUsd != null
                            ? String(derived.cashUsd)
                            : "",
                        );
                        setShowCashEdit((v) => !v);
                      }}
                      className="text-sm text-[var(--accent)]"
                    >
                      更新
                    </button>
                    )}
                  </div>
                  {/* Cash amount on its own line (same size/leading as
                      the 证券总市值 amount opposite), with the cash share
                      on the line below — mirroring the opposite card's
                      holding-count line (same mt / text-xs) so the
                      percentage and the holding count sit on one
                      horizontal line across the two cards. */}
                  <p className="num mt-1 whitespace-nowrap text-base font-medium">
                    {derived.cashUsd != null
                      ? mask(`$${money(derived.cashUsd)}`)
                      : "—"}
                  </p>
                  {derived.cashUsd != null &&
                    derived.accountValue != null &&
                    derived.accountValue > 0 && (
                      <p className="num mt-0.5 text-xs text-[var(--dim)]">
                        占比{" "}
                        {(
                          (derived.cashUsd / derived.accountValue) *
                          100
                        ).toFixed(1)}
                        %
                      </p>
                    )}
                  {view.readOnly && (
                    <p className="mt-0.5 text-xs leading-snug text-[var(--dim)]">
                      {data.accounts
                        .map(
                          (a) =>
                            `${a.account.name} ${
                              a.cash != null
                                ? mask(`$${money(a.cash.cash_usd)}`)
                                : "—"
                            }`,
                        )
                        .join(" · ")}
                    </p>
                  )}
                </div>
              </div>
              {showCashEdit && (
                <form
                  className="mt-2 flex items-end gap-2 rounded-[var(--radius)] bg-[var(--surface-2)] p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = Number(cashInput);
                    if (Number.isFinite(v) && v >= 0) {
                      updateCash.mutate({
                        account_id: view.key,
                        cash_usd: v,
                      });
                      setShowCashEdit(false);
                    }
                  }}
                >
                  <label className="flex-1 text-sm text-[var(--dim)]">
                    现金余额 $（{view.label} · {view.cash?.snapshot_label ?? "余额快照"}，可改）
                    <input
                      aria-label="现金余额"
                      className="num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-base text-[var(--text)]"
                      inputMode="decimal"
                      value={cashInput}
                      onChange={(e) => setCashInput(e.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={updateCash.isPending}
                    className="rounded-md bg-[var(--accent)] px-3 py-2 text-base font-medium text-black disabled:opacity-50"
                  >
                    保存
                  </button>
                </form>
              )}
              {derived.missingQuotes.length > 0 && (
                <p className="mt-2 text-sm text-[var(--danger)]">
                  {derived.missingQuotes.join("、")} 暂无报价，未计入汇总
                </p>
              )}
            </section>
            )}

            {/* Extended-hours big moves (annotation only) */}
            {derived.extAlerts.length > 0 && (
              <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
                <h2 className="text-lg font-semibold">
                  {derived.extAlertLabel}异动（≥ ±{AFTER_ALERT_PCT}%）
                </h2>
                <ul className="mt-2 space-y-1.5 text-base">
                  {derived.extAlerts.map((a) => (
                    <li
                      key={a.symbol}
                      className="flex items-baseline justify-between gap-2"
                    >
                      <span className="num font-medium">{a.symbol}</span>
                      <span className="num text-[var(--dim)]">
                        {extLabel(a.extSession)} $
                        {a.extPrice != null ? money(a.extPrice) : "—"}{" "}
                        <span
                          style={{
                            color:
                              a.extPct >= 0 ? "var(--up)" : "var(--down)",
                          }}
                        >
                          {signedPct(a.extPct)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Holdings list. Section order below the overview is
                user-confirmed (2026-11-09): 持仓明细 first, then
                集中度与结构 — do not swap them back. */}
            <section className="mt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">持仓明细</h2>
                <div className="flex items-center gap-2">
                  <div
                    role="group"
                    aria-label="持仓列表密度"
                    className="flex overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
                  >
                    {(
                      [
                        ["standard", "标准"],
                        ["table", "表格"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={density === value}
                        onClick={() => setDensity(value)}
                        className="px-2.5 py-1.5"
                        style={
                          density === value
                            ? {
                                background: "var(--accent)",
                                color: "#000",
                                fontWeight: 600,
                              }
                            : { color: "var(--dim)" }
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {!view.readOnly && (
                  <button
                    type="button"
                    onClick={() => setShowAdd((v) => !v)}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm"
                  >
                    {showAdd ? "收起" : "＋ 添加持仓"}
                  </button>
                  )}
                </div>
              </div>

              {showAdd && (
                <form
                  className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const q = Number(newQty);
                    const c = Number(newCost);
                    if (
                      newSymbol.trim() &&
                      newName.trim() &&
                      Number.isFinite(q) &&
                      Number.isFinite(c)
                    ) {
                      add.mutate({
                        account_id: view.key,
                        symbol: newSymbol,
                        name: newName,
                        qty: q,
                        cost_per_share: c,
                        kind: "stock",
                        theme: newTheme,
                      });
                      setNewSymbol("");
                      setNewName("");
                      setNewQty("");
                      setNewCost("");
                      setShowAdd(false);
                    }
                  }}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-sm text-[var(--dim)]">
                      代码
                      <input
                        aria-label="新持仓代码"
                        className="num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]"
                        value={newSymbol}
                        onChange={(e) => setNewSymbol(e.target.value)}
                        placeholder="如 AAPL"
                      />
                    </label>
                    <label className="text-sm text-[var(--dim)]">
                      名称
                      <input
                        aria-label="新持仓名称"
                        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="公司名称"
                      />
                    </label>
                    <label className="text-sm text-[var(--dim)]">
                      股数
                      <input
                        aria-label="新持仓股数"
                        className="num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]"
                        inputMode="decimal"
                        value={newQty}
                        onChange={(e) => setNewQty(e.target.value)}
                      />
                    </label>
                    <label className="text-sm text-[var(--dim)]">
                      成本价 $
                      <input
                        aria-label="新持仓成本价"
                        className="num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]"
                        inputMode="decimal"
                        value={newCost}
                        onChange={(e) => setNewCost(e.target.value)}
                      />
                    </label>
                    <label className="text-sm text-[var(--dim)]">
                      主题
                      <select
                        aria-label="新持仓主题"
                        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]"
                        value={newTheme}
                        onChange={(e) => setNewTheme(e.target.value)}
                      >
                        {[
                          "半导体",
                          "大型科技",
                          "AI 算力",
                          "能源与电力",
                          "航天",
                          "多元金融",
                          "宽基 ETF",
                          "红利 ETF",
                          "其他",
                        ].map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button
                    type="submit"
                    disabled={add.isPending}
                    className="mt-3 w-full rounded-md bg-[var(--accent)] px-3 py-2 text-base font-medium text-black disabled:opacity-50"
                  >
                    添加并刷新报价
                  </button>
                </form>
              )}

              {view.holdings.length === 0 ? (
                <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-6 text-center">
                  <p className="text-base font-medium">
                    {view.label}账户暂无持仓
                  </p>
                  <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--dim)]">
                    {view.key === "broker-b"
                      ? "这个账户还没有持仓记录，可以点上方「＋ 添加持仓」手动添加，或先更新现金余额。"
                      : "这个账户还没有持仓记录，可以点上方「＋ 添加持仓」手动添加。"}
                  </p>
                  {view.cash == null && !view.readOnly && (
                    <button
                      type="button"
                      onClick={() => {
                        setCashInput("");
                        setShowCashEdit(true);
                      }}
                      className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-base"
                    >
                      更新现金余额
                    </button>
                  )}
                  {showCashEdit && !view.readOnly && (
                    <form
                      className="mx-auto mt-3 flex max-w-sm items-end gap-2 text-left"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const v = Number(cashInput);
                        if (Number.isFinite(v) && v >= 0) {
                          updateCash.mutate({
                            account_id: view.key,
                            cash_usd: v,
                          });
                          setShowCashEdit(false);
                        }
                      }}
                    >
                      <label className="flex-1 text-sm text-[var(--dim)]">
                        现金余额 $
                        <input
                          aria-label="现金余额"
                          className="num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-base text-[var(--text)]"
                          inputMode="decimal"
                          value={cashInput}
                          onChange={(e) => setCashInput(e.target.value)}
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={updateCash.isPending}
                        className="rounded-md bg-[var(--accent)] px-3 py-2 text-base font-medium text-black disabled:opacity-50"
                      >
                        保存
                      </button>
                    </form>
                  )}
                </div>
              ) : density === "table" ? (
                <div
                  className="mt-3 overflow-auto rounded-[var(--radius)] bg-[var(--surface)]"
                  style={{ maxHeight: "68vh" }}
                >
                  <table className="w-max min-w-full border-collapse">
                    <thead>
                      <tr>
                        {TABLE_COLS.map((c, i) => {
                          const active = tableSort.key === c.key;
                          return (
                            <th
                              key={c.key}
                              aria-sort={
                                active
                                  ? tableSort.dir === 1
                                    ? "ascending"
                                    : "descending"
                                  : undefined
                              }
                              className={`sticky top-0 whitespace-nowrap px-2.5 py-2 ${
                                i === 0 ? "text-left" : "text-right"
                              }`}
                              style={{
                                background: "var(--surface-2)",
                                zIndex: i === 0 ? 30 : 20,
                                ...(i === 0 ? { left: 0 } : {}),
                              }}
                            >
                              <button
                                type="button"
                                onClick={() => toggleSort(c.key)}
                                aria-label={`按${c.label}排序`}
                                className="text-xs font-medium text-[var(--dim)]"
                                style={
                                  active
                                    ? {
                                        color: "var(--text)",
                                        fontWeight: 700,
                                      }
                                    : undefined
                                }
                              >
                                {c.label}
                                {active
                                  ? tableSort.dir === 1
                                    ? " ↑"
                                    : " ↓"
                                  : ""}
                              </button>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map(({ r, weight }) => {
                        const h = r.h;
                        const q = h.quote;
                        const isOpen = expanded === h.id;
                        const dayColor =
                          q?.change_percent == null
                            ? "var(--dim)"
                            : q.change_percent >= 0
                              ? "var(--up)"
                              : "var(--down)";
                        const pnlColor =
                          r.pnl == null
                            ? "var(--dim)"
                            : r.pnl >= 0
                              ? "var(--up)"
                              : "var(--down)";
                        // Extended-hours price/pct stack as a small
                        // second line in the 现价 / 涨跌幅 cells outside
                        // the regular session; hidden during 盘中.
                        const ext = effExt(q);
                        const showExt =
                          data.session.key !== "regular" && ext != null;
                        const cell =
                          "num whitespace-nowrap border-t border-[var(--border)] px-2.5 py-2 text-sm";
                        return (
                          <Fragment key={h.id}>
                            <tr
                              onClick={() =>
                                setExpanded(isOpen ? null : h.id)
                              }
                              className="cursor-pointer"
                            >
                              <td
                                className={`${cell} sticky left-0`}
                                style={{
                                  background: "var(--surface)",
                                  zIndex: 10,
                                }}
                              >
                                <button
                                  type="button"
                                  aria-label={`${h.symbol} 详情`}
                                  aria-expanded={isOpen}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpanded(isOpen ? null : h.id);
                                  }}
                                  className="num text-[15px] font-semibold text-[var(--text)]"
                                >
                                  {h.symbol}
                                </button>
                              </td>
                              <td className={`${cell} text-right`}>
                                <span
                                  className="block font-medium"
                                  style={{ color: dayColor }}
                                >
                                  {q?.change_percent != null
                                    ? signedPct(q.change_percent)
                                    : "—"}
                                </span>
                                {showExt && ext && ext.pct != null && (
                                  <span className="block text-xs font-normal leading-snug">
                                    <span className="text-[var(--dim)]">
                                      {extLabel(ext.session)}
                                    </span>{" "}
                                    <span
                                      style={{
                                        color:
                                          ext.pct >= 0
                                            ? "var(--up)"
                                            : "var(--down)",
                                      }}
                                    >
                                      {signedPct(ext.pct)}
                                    </span>
                                  </span>
                                )}
                              </td>
                              <td className={`${cell} text-right`}>
                                <span className="block">
                                  {r.price != null
                                    ? `$${money(r.price)}`
                                    : "—"}
                                </span>
                                {showExt && ext && (
                                  <span className="num block text-xs leading-snug text-[var(--dim)]">
                                    ${money(ext.price)}
                                  </span>
                                )}
                              </td>
                              <td className={`${cell} text-right`}>
                                {/* Cost column stays visible under privacy
                                    (user request 2026-11-08); the expanded
                                    detail still masks it. */}
                                {`$${money(h.cost_per_share)}`}
                              </td>
                              <td
                                className={`${cell} text-right font-medium`}
                                style={{ color: pnlColor }}
                              >
                                {r.pnlPct != null
                                  ? signedPct(r.pnlPct)
                                  : "—"}
                              </td>
                              <td
                                className={`${cell} text-right`}
                                style={{ color: pnlColor }}
                              >
                                {r.pnl != null
                                  ? mask(signedMoney(r.pnl))
                                  : "—"}
                              </td>
                              <td className={`${cell} text-right`}>
                                {r.mv != null
                                  ? mask(`$${money(r.mv)}`)
                                  : "—"}
                              </td>
                              <td className={`${cell} text-right`}>
                                {mask(
                                  h.qty.toLocaleString("en-US", {
                                    maximumFractionDigits: 2,
                                  }),
                                )}
                              </td>
                              <td className={`${cell} text-right`}>
                                {weight != null
                                  ? `${weight.toFixed(1)}%`
                                  : "—"}
                              </td>
                            </tr>
                            {isOpen && (
                              <tr>
                                <td
                                  colSpan={TABLE_COLS.length}
                                  className="border-t border-[var(--border)] p-0"
                                >
                                  <div
                                    className="sticky left-0 px-3 pb-2"
                                    style={{
                                      width:
                                        "min(calc(100vw - 2rem), 46rem)",
                                    }}
                                  >
                                    <RowDetail
                                      h={h}
                                      privacy={privacy}
                                      readOnly={view.readOnly}
                                      sessionKey={data.session.key}
                                      saving={update.isPending}
                                      onSave={(nq, nc) =>
                                        update.mutate({
                                          id: h.id,
                                          qty: nq,
                                          cost_per_share: nc,
                                        })
                                      }
                                      onRemove={() =>
                                        remove.mutate(h.id)
                                      }
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
              ) : (
              <div className="mt-3 space-y-1.5">
                {derived.rows.map((r) => {
                  const h = r.h;
                  const q = h.quote;
                  const weight =
                    r.mv != null && derived.totalMv > 0
                      ? (r.mv / derived.totalMv) * 100
                      : null;
                  const isOpen = expanded === h.id;
                  const compact = false;
                  const dayColor =
                    q?.change_percent == null
                      ? "var(--dim)"
                      : q.change_percent >= 0
                        ? "var(--up)"
                        : "var(--down)";
                  const dayBg =
                    q?.change_percent == null
                      ? "transparent"
                      : q.change_percent >= 0
                        ? "color-mix(in srgb, var(--up) 13%, transparent)"
                        : "color-mix(in srgb, var(--down) 13%, transparent)";
                  const pnlColor =
                    r.pnl == null
                      ? "var(--dim)"
                      : r.pnl >= 0
                        ? "var(--up)"
                        : "var(--down)";
                  const ext = effExt(q);
                  const extAlert =
                    ext?.pct != null &&
                    Math.abs(ext.pct) >= AFTER_ALERT_PCT;
                  // Extended-hours price shows inline outside the
                  // regular session only; during 盘中 the row stays
                  // close-only (user request 2026-11-08).
                  const showExt = data.session.key !== "regular";
                  return (
                    <article
                      key={h.id}
                      className={`rounded-[var(--radius)] bg-[var(--surface)] ${compact ? "p-2" : "p-2.5"}`}
                    >
                      <button
                        type="button"
                        aria-label={`${h.symbol} 详情`}
                        className="block w-full text-left"
                        onClick={() => setExpanded(isOpen ? null : h.id)}
                      >
                        {compact ? (
                          <>
                            {/* Compact: two lines only — symbol, price and
                                day badge (plus any after-hours flag) on
                                line 1; 市值·占比 and P/L amount (%) on
                                line 2. Name/theme live in the expanded
                                detail. */}
                            <div className="flex items-center justify-between gap-2">
                              <span className="num shrink-0 text-base font-semibold leading-tight">
                                {h.symbol}
                              </span>
                              <span className="flex shrink-0 items-center gap-1.5">
                                <span className="num whitespace-nowrap text-base font-medium leading-tight">
                                  {r.price != null ? (
                                    `$${money(r.price)}`
                                  ) : (
                                    <span className="text-sm text-[var(--dim)]">
                                      暂无报价
                                    </span>
                                  )}
                                </span>
                                <span
                                  className="num inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[13px] font-medium"
                                  style={{
                                    color: dayColor,
                                    backgroundColor: dayBg,
                                  }}
                                >
                                  {q?.change_percent != null
                                    ? signedPct(q.change_percent)
                                    : "—"}
                                </span>
                                {extAlert && ext && (
                                  <span
                                    className="num whitespace-nowrap text-xs font-medium"
                                    style={{
                                      color:
                                        (ext.pct ?? 0) >= 0
                                          ? "var(--up)"
                                          : "var(--down)",
                                    }}
                                  >
                                    {extLabel(ext.session)}{" "}
                                    {signedPct(ext.pct ?? 0)}
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] leading-snug">
                              <span className="num shrink-0 whitespace-nowrap text-[var(--dim)]">
                                市值{" "}
                                {r.mv != null ? mask(`$${money(r.mv)}`) : "—"}
                                {weight != null
                                  ? ` · ${weight.toFixed(1)}%`
                                  : ""}
                              </span>
                              <span
                                className="num shrink-0 whitespace-nowrap"
                                style={{ color: pnlColor }}
                              >
                                {r.pnl != null && r.pnlPct != null ? (
                                  <>
                                    {mask(signedMoney(r.pnl))} (
                                    {signedPct(r.pnlPct)})
                                  </>
                                ) : (
                                  "—"
                                )}
                              </span>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <span className="num text-base font-semibold leading-snug">
                                  {h.symbol}
                                </span>
                                <p className="truncate text-xs leading-snug text-[var(--dim)]">
                                  {h.name}
                                </p>
                              </div>
                              <div className="shrink-0 text-right">
                                <p className="num whitespace-nowrap text-base font-medium leading-snug">
                                  {r.price != null ? (
                                    `$${money(r.price)}`
                                  ) : (
                                    <span className="text-sm text-[var(--dim)]">
                                      暂无报价
                                    </span>
                                  )}
                                </p>
                                <span
                                  className="num mt-1 inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium"
                                  style={{
                                    color: dayColor,
                                    backgroundColor: dayBg,
                                  }}
                                >
                                  {q?.change_percent != null
                                    ? `今日 ${signedPct(q.change_percent)}`
                                    : "—"}
                                </span>
                              </div>
                            </div>
                            {/* Line 3 is one full-width row shared by both
                                sides: 主题·占比 on the left, the extended-
                                hours price right-aligned — same line, same
                                baseline, so the two sides can never drift
                                apart vertically. No kind segment and no
                                truncation: the theme always shows in full
                                and no bare "…" can appear. When there is
                                no extended price (regular session), the row
                                keeps the same height with left content only. */}
                            <div className="mt-0.5 flex items-baseline justify-between gap-x-3 text-xs leading-snug">
                              <span className="num whitespace-nowrap text-[var(--dim)]">
                                {h.theme}
                                {weight != null && (
                                  <> · 占比 {weight.toFixed(2)}%</>
                                )}
                              </span>
                              {showExt && ext && (
                                <span className="num shrink-0 whitespace-nowrap text-[13px]">
                                  <span className="text-[var(--dim)]">
                                    {extLabel(ext.session)}
                                  </span>{" "}
                                  ${money(ext.price)}
                                  {ext.pct != null && (
                                    <span
                                      className={
                                        extAlert ? "font-semibold" : ""
                                      }
                                      style={{
                                        color:
                                          ext.pct >= 0
                                            ? "var(--up)"
                                            : "var(--down)",
                                      }}
                                    >
                                      {" "}
                                      {signedPct(ext.pct)}
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>
                            <div className="mt-1.5 flex flex-nowrap items-baseline justify-between gap-x-2 border-t border-[var(--border)] pt-1.5 text-[13px]">
                              <span className="num whitespace-nowrap text-[var(--dim)]">
                                市值{" "}
                                {r.mv != null ? mask(`$${money(r.mv)}`) : "—"}
                              </span>
                              <span
                                className="num shrink-0 whitespace-nowrap"
                                style={{ color: pnlColor }}
                              >
                                浮盈亏{" "}
                                {r.pnl != null && r.pnlPct != null ? (
                                  <>
                                    {mask(signedMoney(r.pnl))} (
                                    {signedPct(r.pnlPct)})
                                  </>
                                ) : (
                                  "—"
                                )}
                              </span>
                            </div>
                          </>
                        )}
                      </button>
                      {isOpen && (
                        <RowDetail
                          h={h}
                          privacy={privacy}
                          readOnly={view.readOnly}
                          sessionKey={data.session.key}
                          saving={update.isPending}
                          onSave={(nq, nc) =>
                            update.mutate({
                              id: h.id,
                              qty: nq,
                              cost_per_share: nc,
                            })
                          }
                          onRemove={() => remove.mutate(h.id)}
                        />
                      )}
                    </article>
                  );
                })}
              </div>
              )}
              <p className="mt-4 text-xs leading-relaxed text-[var(--dim)]">
                报价 {fmtTime(derived.asOf)}
                {derived.marketStatus
                  ? ` · 美股${derived.marketStatus === "open" ? "交易中" : "已收盘"}`
                  : ""}
                {" · "}每日 06:30 自动刷新
                {view.readOnly
                  ? " · 全局只读，切到具体账户可改股数/成本"
                  : " · 点持仓可改股数/成本"}
                {refresh.data && refresh.data.failed.length > 0
                  ? ` · ${refresh.data.failed.join("、")} 未取到新报价`
                  : ""}
              </p>
            </section>
            {/* Concentration, visualized: 100% stacked theme bar, top-5
                holdings bars, loss-source bars, key metric rows. All
                figures derive from the active view's holdings + latest
                quotes (global view = merged across accounts). */}
            {view.holdings.length > 0 && (
            <section className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <h2 className="text-lg font-semibold">集中度与结构</h2>

              <p className="mt-3 text-sm text-[var(--dim)]">主题占比（占证券市值）</p>
              <div
                className="mt-1.5 flex h-4 w-full overflow-hidden rounded-md"
                role="img"
                aria-label={derived.themeRows
                  .map((t) => `${t.theme} ${t.pct.toFixed(1)}%`)
                  .join("，")}
              >
                {derived.themeRows.map((t, i) => (
                  <div
                    key={t.theme}
                    className="h-full"
                    style={{
                      width: `${t.pct}%`,
                      background:
                        THEME_COLORS[i % THEME_COLORS.length],
                    }}
                  />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {derived.themeRows.map((t, i) => (
                  <span
                    key={t.theme}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{
                        background:
                          THEME_COLORS[i % THEME_COLORS.length],
                      }}
                    />
                    {t.theme}
                    <span className="num text-[var(--dim)]">
                      {t.pct.toFixed(1)}%
                    </span>
                  </span>
                ))}
              </div>

              <p className="mt-4 text-sm text-[var(--dim)]">
                前五大持仓（占证券市值）
              </p>
              <div className="mt-1.5 space-y-2">
                {derived.topHoldings.map((t) => (
                  <div key={t.label}>
                    <div className="flex items-baseline justify-between gap-2 text-base">
                      <span className="num min-w-0 truncate font-medium">
                        {t.label}
                        <span className="ml-1.5 text-sm font-normal text-[var(--dim)]">
                          {t.sub}
                        </span>
                      </span>
                      <span className="num shrink-0 text-[var(--dim)]">
                        {t.pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.max(t.pct, 1.5)}%`,
                          background: "var(--accent)",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {derived.loserRows.length > 0 && (
                <>
                  <p className="mt-4 text-sm text-[var(--dim)]">
                    浮亏来源（占总浮亏）
                  </p>
                  <div className="mt-1.5 space-y-2">
                    {derived.loserRows.map((l) => (
                      <div key={l.symbol}>
                        <div className="flex items-baseline justify-between gap-2 text-base">
                          <span className="num font-medium">{l.symbol}</span>
                          <span
                            className="num shrink-0"
                            style={{ color: "var(--down)" }}
                          >
                            {mask(signedMoney(l.pnl))} ·{" "}
                            {l.share.toFixed(1)}%
                          </span>
                        </div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(l.share, 1.5)}%`,
                              background: "var(--down)",
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="mt-4 space-y-2.5 border-t border-[var(--border)] pt-3">
                {[
                  {
                    label: "Alphabet 单一公司敞口",
                    pct: derived.alphabetPct,
                  },
                  { label: "半导体主题（含 SMH）", pct: derived.semiPct },
                  ...(derived.topLosers
                    ? [
                        {
                          label: `前三浮亏股占总浮亏（${derived.topLosers}）`,
                          pct: derived.lossConcentration,
                        },
                      ]
                    : []),
                ].map((m) => (
                  <div
                    key={m.label}
                    className="flex items-center gap-2.5"
                  >
                    <span className="min-w-0 flex-1 text-sm leading-snug text-[var(--dim)]">
                      {m.label}
                    </span>
                    <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-[var(--surface-2)] min-[480px]:w-28">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(Math.max(m.pct, 1.5), 100)}%`,
                          background:
                            m.pct >= 30 ? "var(--danger)" : "var(--accent)",
                        }}
                      />
                    </div>
                    <span className="num w-14 shrink-0 text-right text-sm font-medium">
                      {m.pct.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </section>
            )}

            {/* Trade ledger: always the last section (user-confirmed
                placement 2026-11-11, after 集中度与结构）. Follows the
                account tabs; keyed by view so switching tabs resets
                its form state. */}
            <TradesSection
              key={view.key}
              accountId={view.key === "global" ? null : view.key}
              readOnly={view.readOnly}
              mask={mask}
            />

          </>
        )}
      </main>
    </div>
  );
}
