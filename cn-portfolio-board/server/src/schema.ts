// Schema for the A-share （中国证券账户） holdings board. Single account,
// all amounts in CNY. Mirrors the US board's （看板 · 美股持仓） table
// shapes minus accounts / FX / extended-hours: holdings, latest quotes,
// one cash row, benchmark strip rows, daily total snapshots (totals
// only — no per-stock data, same 口径 as the US history board), and the
// record-only trade ledger replayed under the diluted-cost method.

import {
integer,
real,
sqliteTable,
text,
uniqueIndex,
} from "drizzle-orm/sqlite-core";

// The user's own A-share holdings (ETFs and broad-based index funds),
// entered from broker screenshots and editable in the UI. Symbol is the
// 6-digit code; the Eastmoney market prefix is derived from its first
// digit at quote time (5/6/9 → Shanghai "1.", 0/1/2/3 → Shenzhen "0.").
export const holdings = sqliteTable(
  "holdings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    qty: real("qty").notNull(),
    costPerShare: real("cost_per_share").notNull(),
    kind: text("kind", { enum: ["etf", "fund", "stock"] })
      .notNull()
      .default("etf"),
  },
  (t) => [uniqueIndex("holdings_symbol_unique").on(t.symbol)],
);

// Latest Eastmoney quote per holding symbol, upserted by refreshQuotes.
// `price` is the latest traded price (intraday: live; after the close:
// the closing price) — the only price basis that ever enters market
// value, P/L and snapshots. quote_date is the Beijing date of the
// quote's own timestamp, used to recognise trading days. `iopv` is the
// ETF's intraday indicative NAV （参考净值）, fetched from Tencent's
// quote feed alongside the Eastmoney price (Eastmoney's push2 quote
// carries no IOPV); null for non-ETFs and whenever the IOPV fetch
// failed — the premium rate is derived from price vs iopv at read
// time and never stored.
export const quoteSnapshots = sqliteTable("quote_snapshots", {
  symbol: text("symbol").primaryKey(),
  price: real("price"),
  iopv: real("iopv"),
  change: real("change"),
  changePercent: real("change_percent"),
  prevClose: real("prev_close"),
  asOf: text("as_of"),
  quoteDate: text("quote_date"),
  source: text("source"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// The single account's cash balance (one row, id = 1). Cash has no live
// feed; cash_cny stays null until the user records it, and the board
// shows a 等待录入 state instead of inventing a figure.
export const accountState = sqliteTable("account_state", {
  id: integer("id").primaryKey(),
  cashCny: real("cash_cny"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A-share benchmark strip （上证指数 / 深证成指 / 沪深300 / 中证A500 /
// 创业板指）, one row per key, upserted by refreshQuotes. peak3y_price /
// peak3y_date hold the highest close within the trailing 3-year window
// (ending at the latest close): seeded once from ~3 years of Eastmoney
// daily closes, ratcheted up by refreshes, and re-seeded when the
// stored peak date slides out of the window (a failed re-seed keeps
// the old value). 距高点 renders from price vs peak3y_price.
export const marketSnapshots = sqliteTable("market_snapshots", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  secid: text("secid").notNull(),
  price: real("price"),
  change: real("change"),
  changePercent: real("change_percent"),
  asOf: text("as_of"),
  peak3yPrice: real("peak3y_price"),
  peak3yDate: text("peak3y_date"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per A-share trading day: overall account totals only (no
// individual stock data). Written by refreshCloseSnapshot on trading
// days and recomputed after holdings / cash / trade edits. The CSI 300
// close and the SSE Composite close ride along so the history view
// can compare against both benchmarks from the same rows. source:
// "refresh" | "manual".
export const dailySnapshots = sqliteTable("daily_snapshots", {
  // Beijing trading date, YYYY-MM-DD.
  date: text("date").primaryKey(),
  accountValueCny: real("account_value_cny").notNull(),
  securitiesValueCny: real("securities_value_cny").notNull(),
  cashCny: real("cash_cny").notNull(),
  totalPnlCny: real("total_pnl_cny"),
  dayChangeCny: real("day_change_cny"),
  dayChangePct: real("day_change_pct"),
  csi300Price: real("csi300_price"),
  csi300ChangePct: real("csi300_change_pct"),
  // SSE Composite （上证指数） close on the snapshot date; written by
  // refreshCloseSnapshot alongside the CSI 300 close, backfilled for
  // the pre-existing rows from Eastmoney daily klines (secid
  // 1.000001). Null when the close could not be sourced.
  ssePrice: real("sse_price"),
  source: text("source").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Trade ledger （交易流水台账）: one row per recorded trade. The ledger
// is a pure record — it never writes holdings directly; P/L is derived
// at read time by replaying each symbol under the diluted-cost method
// （摊薄成本法）: buys add qty × price to the cycle's cost pool, sells
// subtract their proceeds, the open position's diluted cost is
// pool ÷ qty (shown as-is, may be ≤ 0), and a cycle's P/L settles
// only when the quantity returns to 0 at a trading day's end (a
// same-day sell-out + buy-back is a 做T round trip and does not
// settle). price is nullable: price_kind "none" means the execution
// price is unknown (price must then be null; a non-null price requires
// kind "actual" or "estimated"). qty is a positive real. date is the
// trade date, YYYY-MM-DD text.
export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side", { enum: ["buy", "sell"] }).notNull(),
  qty: real("qty").notNull(),
  price: real("price"),
  priceKind: text("price_kind", {
    enum: ["actual", "estimated", "none"],
  }).notNull(),
  source: text("source", {
    enum: ["order", "snapshot_diff", "opening", "manual"],
  }).notNull(),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
