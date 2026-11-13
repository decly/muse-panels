import {
integer,
primaryKey,
real,
sqliteTable,
text,
uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Brokerage accounts. Seeded in code with the two built-in accounts
// (broker-a 券商A, broker-b 券商B）; new accounts can be added as rows later
// without a schema change.
export const accounts = sqliteTable("accounts", {
  // Stable machine id, e.g. "broker-a" | "broker-b".
  id: text("id").primaryKey(),
  // Display name shown on the account tab, e.g. "券商A".
  name: text("name").notNull(),
  sort: integer("sort").notNull(),
});

// The user's own holdings, seeded once with demo data and editable
// in the UI afterwards. Every row belongs to
// exactly one account; the same symbol may exist in several accounts.
export const holdings = sqliteTable(
  "holdings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: text("account_id").notNull().default("broker-a"),
    // Display symbol as the broker shows it, e.g. "BRK/B".
    symbol: text("symbol").notNull(),
    // Symbol the quote source resolves, e.g. "BRK.B".
    quoteSymbol: text("quote_symbol").notNull(),
    name: text("name").notNull(),
    qty: real("qty").notNull(),
    costPerShare: real("cost_per_share").notNull(),
    kind: text("kind", { enum: ["stock", "etf"] }).notNull(),
    theme: text("theme").notNull(),
  },
  (t) => [uniqueIndex("holdings_account_symbol_unique").on(t.accountId, t.symbol)],
);

// Latest quote per quote_symbol, upserted by refreshQuotes. Quotes are
// shared across accounts (one row per symbol, not per holding).
// `price` is always the regular-session price (the official basis).
// After-hours fields come from Nasdaq's extended-trading feed and are
// annotation-only: they never enter market value or P/L.
export const quoteSnapshots = sqliteTable("quote_snapshots", {
  quoteSymbol: text("quote_symbol").primaryKey(),
  price: real("price"),
  change: real("change"),
  changePercent: real("change_percent"),
  high: real("high"),
  low: real("low"),
  week52High: real("week_52_high"),
  week52Low: real("week_52_low"),
  marketCap: real("market_cap"),
  marketStatus: text("market_status"),
  asOf: text("as_of"),
  afterPrice: real("after_price"),
  // Percent move of the after-hours price versus the regular close.
  afterChangePercent: real("after_change_percent"),
  afterAsOf: text("after_as_of"),
  // Session-aware extended-hours snapshot (plan B, 2026-11-08): the
  // most relevant extended-session last trade — pre-market when the
  // pre session is the live/recent one, after-hours otherwise. Stored
  // separately from the regular close and never used in totals.
  // extSession: "pre" | "post" | "overnight". The overnight price
  // comes from Yahoo chart meta.fulldayPrice (Nasdaq has no overnight
  // stream); its ext_as_of is the fetch moment (fulldayPrice carries
  // no trade timestamp) and is labeled 抓取于 in the UI. When Yahoo
  // yields nothing for a symbol, the row keeps the after-hours last
  // trade ("post"), labeled as the latest available price. after_*
  // stays as the post-session mirror for backward compatibility.
  extPrice: real("ext_price"),
  // Percent move of the extended price versus its session's regular
  // close (previous close for pre-market, same-day close for post).
  extChangePercent: real("ext_change_percent"),
  extAsOf: text("ext_as_of"),
  extSession: text("ext_session"),
  // Per-session saved extended prices (plan B, 2026-11-09): each
  // extended session keeps its OWN last value — price, percent move
  // versus that session's regular close, and timestamp — in its own
  // slot, and a refresh writes only the slot of the session it runs
  // in, so the pre-market refresh never overwrites the after-hours
  // or overnight saves (and vice versa). getPortfolio derives the
  // effective ext_* view from the slot matching the current session,
  // so opening the board shows the last saved price for the current
  // session immediately, before any new refresh lands. The legacy
  // ext_* columns above stay as a mirror of the most recent slot
  // write for backward compatibility; after_* remains the
  // post-session mirror and seeds the post slot (migration 0010).
  prePrice: real("pre_price"),
  preChangePercent: real("pre_change_percent"),
  preAsOf: text("pre_as_of"),
  postPrice: real("post_price"),
  postChangePercent: real("post_change_percent"),
  postAsOf: text("post_as_of"),
  overnightPrice: real("overnight_price"),
  overnightChangePercent: real("overnight_change_percent"),
  overnightAsOf: text("overnight_as_of"),
  // Which channel supplied the regular quote: "finance" | "nasdaq".
  source: text("source"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Latest USD/CNY rate, upserted by refreshQuotes (one row, pair = "USD/CNY").
export const fxSnapshots = sqliteTable("fx_snapshots", {
  pair: text("pair").primaryKey(),
  rate: real("rate"),
  source: text("source"),
  asOf: text("as_of"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Market benchmarks (S&P 500, Nasdaq-100, Nasdaq Composite, Shanghai
// Composite, CSI 300, CSI A500, Hang Seng TECH, Nasdaq Golden Dragon
// China, Nikkei 225, Vietnam
// Ho Chi Minh Index, spot gold, Shanghai gold), one row per key, upserted by
// refreshQuotes. peak_price / peak_date
// hold the all-time highest close and the date it was set (YYYY-MM-DD):
// seeded once from long history when empty, afterwards only ratcheted
// up by refreshQuotes — never lowered. peak3y_price / peak3y_date hold
// the highest close within the trailing 3-year window (ending at the
// latest close): seeded once from ~3 years of daily closes, ratcheted
// up the same way, and re-seeded from the source series whenever the
// stored peak date slides out of the window (a failed re-seed keeps
// the old value). The client renders the current drawdown （距高点）
// from price vs peak3y_price; the all-time peak is kept alongside so
// the display basis can switch back without re-seeding.
export const marketSnapshots = sqliteTable("market_snapshots", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  price: real("price"),
  change: real("change"),
  changePercent: real("change_percent"),
  asOf: text("as_of"),
  source: text("source"),
  note: text("note"),
  peakPrice: real("peak_price"),
  peakDate: text("peak_date"),
  peak3yPrice: real("peak3y_price"),
  peak3yDate: text("peak3y_date"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per account per US trading day, written by refreshQuotes
// (deduped by date + account) plus a demo record seeded once. The global history is the per-date sum
// across accounts, computed at read time, never stored. Benchmark closes
// ride along so the client can normalize account vs index curves from
// the same rows. source: "manual" (never overwritten by a refresh)
// | "refresh".
export const dailySnapshots = sqliteTable(
  "daily_snapshots",
  {
    // US trading date, YYYY-MM-DD (America/New_York).
    date: text("date").notNull(),
    accountId: text("account_id").notNull().default("broker-a"),
    accountValueUsd: real("account_value_usd").notNull(),
    securitiesValueUsd: real("securities_value_usd").notNull(),
    cashUsd: real("cash_usd").notNull(),
    totalPnlUsd: real("total_pnl_usd"),
    dayChangeUsd: real("day_change_usd"),
    dayChangePct: real("day_change_pct"),
    fxRate: real("fx_rate"),
    accountValueCny: real("account_value_cny"),
    spxPrice: real("spx_price"),
    ndxPrice: real("ndx_price"),
    source: text("source").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.date, t.accountId] })],
);

// Cash balance per account (one row per account_id), from the user's
// broker balances entered by hand. Cash has no live feed; each row stays a
// labeled snapshot the user can update in the UI until they provide a
// newer figure.
export const accountBalances = sqliteTable("account_balances", {
  accountId: text("account_id").primaryKey(),
  cashUsd: real("cash_usd").notNull(),
  snapshotLabel: text("snapshot_label").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Trade ledger (交易流水台账, added 2026-11-11): one row per recorded
// trade, per account. The ledger is a pure record — it never feeds
// holdings, quotes, totals or daily snapshots. Entries come from order
// fill records (source "order", price_kind "actual"), from whole-account
// snapshot diffs (source "snapshot_diff", price often "estimated"),
// from the opening initialization (source "opening": side "buy" at the
// broker cost price first recorded, price_kind "actual", so replaying
// every entry from an empty position reproduces the current holdings
// and weighted-average costs), or manual entry (source "manual").
// price is nullable: price_kind "none" means the execution price is
// unknown (price must then be null; a non-null price requires kind
// "actual" or "estimated"). qty is a positive real — fractional shares
// are supported. date is the trade date, YYYY-MM-DD text.
export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: text("account_id").notNull().default("broker-a"),
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
