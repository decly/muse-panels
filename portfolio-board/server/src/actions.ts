// Actions for the multi-account holdings dashboard.
//
// Holdings are the user's own rows, grouped by brokerage account
// (券商A broker-a / 券商B broker-b, seeded with demo data,
// editable in the UI per account). The "global" view is computed at
// read time: same-symbol rows across accounts merge into one (qty
// summed, cost weighted-averaged, per-account split kept in `parts`)
// and cash/history are summed across accounts. The official price
// basis is the US regular-session
// close: market value, day change and P/L are computed from regular
// prices only. Extended-hours prices (Nasdaq extended-trading feeds,
// pre-market and after-hours) are stored separately (ext_* fields,
// plus the legacy after_* post-session mirror), shown as annotations
// and in a clearly-labeled live estimate next to the official total;
// they never enter the official totals or the daily snapshots.
//
// Quote channels, in order:
//  1. ctx.tool.finance_ticker (managed channel) for every holding.
//  2. Nasdaq's public quote API as a fallback — the managed channel
//     cannot resolve some NYSE symbols; Nasdaq can.
// USD/CNY comes from open.er-api.com (ExchangeRate-API free endpoint),
// falling back to api.frankfurter.app; the rate and its timestamp are
// stored with every refresh. Cash is stored per account from the
// user-entered balances (demo seed: Broker A $800.00),
// editable in the UI per account; total account value = refreshed
// securities value + stored cash, per account and globally.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, eq } from "drizzle-orm";
import * as schema from "./schema";

// Built-in accounts, ensured on every portfolio load so the tabs exist
// even before any Broker B data is entered. New brokers later = new rows.
const BUILTIN_ACCOUNTS = [
  { id: "broker-a", name: "券商A", sort: 1 },
  { id: "broker-b", name: "券商B", sort: 2 },
] as const;

async function ensureAccounts(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts);
  const have = new Set(existing.map((a) => a.id));
  for (const a of BUILTIN_ACCOUNTS) {
    if (!have.has(a.id)) {
      await db
        .insert(schema.accounts)
        .values({ id: a.id, name: a.name, sort: a.sort })
        .onConflictDoNothing();
    }
  }
}

// Demo seed positions (fictional sample data - replace with your own):
// symbol (as displayed), quote symbol, name, qty, cost per share, kind, theme.
const DEMO_HOLDINGS = [
  { symbol: "AAPL", quoteSymbol: "AAPL", name: "Apple Inc", qty: 10, costPerShare: 180.00, kind: "stock", theme: "大型科技" },
  { symbol: "MSFT", quoteSymbol: "MSFT", name: "Microsoft Corp", qty: 6, costPerShare: 320.00, kind: "stock", theme: "大型科技" },
  { symbol: "JPM", quoteSymbol: "JPM", name: "JPMorgan Chase & Co", qty: 8, costPerShare: 190.00, kind: "stock", theme: "多元金融" },
  { symbol: "VOO", quoteSymbol: "VOO", name: "Vanguard S&P 500 ETF", qty: 12, costPerShare: 450.00, kind: "etf", theme: "宽基 ETF" },
] as const;

const quoteSchema = z.object({
  price: z.number().nullable(),
  change: z.number().nullable(),
  change_percent: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  week_52_high: z.number().nullable(),
  week_52_low: z.number().nullable(),
  market_cap: z.number().nullable(),
  market_status: z.string().nullable(),
  as_of: z.string().nullable(),
  after_price: z.number().nullable(),
  after_change_percent: z.number().nullable(),
  after_as_of: z.string().nullable(),
  ext_price: z.number().nullable(),
  ext_change_percent: z.number().nullable(),
  ext_as_of: z.string().nullable(),
  ext_session: z.string().nullable(),
  source: z.string().nullable(),
  fetched_at: z.string().nullable(),
});

const holdingPartSchema = z.object({
  account_id: z.string(),
  account_name: z.string(),
  holding_id: z.number(),
  qty: z.number(),
  cost_per_share: z.number(),
});

const holdingSchema = z.object({
  id: z.number(),
  account_id: z.string(),
  symbol: z.string(),
  quote_symbol: z.string(),
  name: z.string(),
  qty: z.number(),
  cost_per_share: z.number(),
  kind: z.string(),
  theme: z.string(),
  quote: quoteSchema.nullable(),
  // Non-null only on merged global rows: the per-account split.
  parts: z.array(holdingPartSchema).nullable(),
});

const fxSchema = z.object({
  rate: z.number().nullable(),
  source: z.string().nullable(),
  as_of: z.string().nullable(),
  fetched_at: z.string().nullable(),
});

const cashSchema = z.object({
  cash_usd: z.number(),
  snapshot_label: z.string(),
  updated_at: z.string(),
});

const marketSchema = z.object({
  key: z.string(),
  label: z.string(),
  price: z.number().nullable(),
  change: z.number().nullable(),
  change_percent: z.number().nullable(),
  as_of: z.string().nullable(),
  source: z.string().nullable(),
  note: z.string().nullable(),
});

const snapshotSchema = z.object({
  date: z.string(),
  account_id: z.string(),
  account_value_usd: z.number(),
  securities_value_usd: z.number(),
  cash_usd: z.number(),
  total_pnl_usd: z.number().nullable(),
  day_change_usd: z.number().nullable(),
  day_change_pct: z.number().nullable(),
  fx_rate: z.number().nullable(),
  account_value_cny: z.number().nullable(),
  spx_price: z.number().nullable(),
  ndx_price: z.number().nullable(),
  source: z.string(),
});

const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const accountDataSchema = z.object({
  account: accountSchema,
  holdings: z.array(holdingSchema),
  cash: cashSchema.nullable(),
  history: z.array(snapshotSchema),
});

const sessionSchema = z.object({
  // Current US session by America/New_York wall clock:
  // "pre" | "regular" | "post" | "overnight" | "closed".
  key: z.string(),
  label: z.string(),
});

const portfolioResponse = z.object({
  session: sessionSchema,
  // Per-account views, in tab order.
  accounts: z.array(accountDataSchema),
  // Merged global view: same-symbol rows combined across accounts,
  // cash summed, history summed per date (account_id "global").
  holdings: z.array(holdingSchema),
  last_fetched_at: z.string().nullable(),
  fx: fxSchema.nullable(),
  cash: cashSchema.nullable(),
  market: z.array(marketSchema),
  history: z.array(snapshotSchema),
});

type PortfolioResponse = z.infer<typeof portfolioResponse>;
type HoldingOut = z.infer<typeof holdingSchema>;
type SnapshotOut = z.infer<typeof snapshotSchema>;

function toHoldingOut(
  h: typeof schema.holdings.$inferSelect,
  bySymbol: Map<string, typeof schema.quoteSnapshots.$inferSelect>,
): HoldingOut {
  const s = bySymbol.get(h.quoteSymbol);
  return {
    id: h.id,
    account_id: h.accountId,
    symbol: h.symbol,
    quote_symbol: h.quoteSymbol,
    name: h.name,
    qty: h.qty,
    cost_per_share: h.costPerShare,
    kind: h.kind,
    theme: h.theme,
    quote: s
      ? {
          price: s.price,
          change: s.change,
          change_percent: s.changePercent,
          high: s.high,
          low: s.low,
          week_52_high: s.week52High,
          week_52_low: s.week52Low,
          market_cap: s.marketCap,
          market_status: s.marketStatus,
          as_of: s.asOf,
          after_price: s.afterPrice,
          after_change_percent: s.afterChangePercent,
          after_as_of: s.afterAsOf,
          ext_price: s.extPrice,
          ext_change_percent: s.extChangePercent,
          ext_as_of: s.extAsOf,
          ext_session: s.extSession,
          source: s.source,
          fetched_at: s.fetchedAt.toISOString(),
        }
      : null,
    parts: null,
  };
}

// Merges per-account rows of the same symbol into one global row: qty
// summed, cost per share weighted-averaged by qty, and the per-account
// split preserved in `parts`. Quote fields ride along from any part
// (quotes are keyed by symbol, so all parts share one quote).
function mergeHoldings(
  rows: HoldingOut[],
  accountNames: Map<string, string>,
): HoldingOut[] {
  const groups = new Map<string, HoldingOut[]>();
  for (const r of rows) {
    const g = groups.get(r.symbol);
    if (g) g.push(r);
    else groups.set(r.symbol, [r]);
  }
  const merged: HoldingOut[] = [];
  for (const g of groups.values()) {
    const first = g[0];
    if (!first) continue;
    if (g.length === 1) {
      merged.push({
        ...first,
        parts: [
          {
            account_id: first.account_id,
            account_name: accountNames.get(first.account_id) ?? first.account_id,
            holding_id: first.id,
            qty: first.qty,
            cost_per_share: first.cost_per_share,
          },
        ],
      });
      continue;
    }
    const totalQty = g.reduce((s, r) => s + r.qty, 0);
    const totalCost = g.reduce((s, r) => s + r.qty * r.cost_per_share, 0);
    merged.push({
      ...first,
      id: -first.id,
      account_id: "global",
      qty: totalQty,
      cost_per_share: totalQty > 0 ? totalCost / totalQty : 0,
      parts: g.map((r) => ({
        account_id: r.account_id,
        account_name: accountNames.get(r.account_id) ?? r.account_id,
        holding_id: r.id,
        qty: r.qty,
        cost_per_share: r.cost_per_share,
      })),
    });
  }
  return merged;
}

function toSnapshotOut(
  s: typeof schema.dailySnapshots.$inferSelect,
): SnapshotOut {
  return {
    date: s.date,
    account_id: s.accountId,
    account_value_usd: s.accountValueUsd,
    securities_value_usd: s.securitiesValueUsd,
    cash_usd: s.cashUsd,
    total_pnl_usd: s.totalPnlUsd,
    day_change_usd: s.dayChangeUsd,
    day_change_pct: s.dayChangePct,
    fx_rate: s.fxRate,
    account_value_cny: s.accountValueCny,
    spx_price: s.spxPrice,
    ndx_price: s.ndxPrice,
    source: s.source,
  };
}

// Global history: per-date sums across the accounts that have a row
// that day. Days before an account existed simply sum fewer accounts
// (the curve never fabricates that account's past). Benchmark closes
// and FX are market-wide, taken from any row of the day.
function mergeSnapshots(rows: SnapshotOut[]): SnapshotOut[] {
  const byDate = new Map<string, SnapshotOut[]>();
  for (const r of rows) {
    const g = byDate.get(r.date);
    if (g) g.push(r);
    else byDate.set(r.date, [r]);
  }
  const out: SnapshotOut[] = [];
  for (const [date, g] of byDate) {
    const sum = (f: (r: SnapshotOut) => number | null): number | null => {
      const vals = g.map(f).filter((v): v is number => v != null);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const accountValue = sum((r) => r.account_value_usd) ?? 0;
    const dayChange = sum((r) => r.day_change_usd);
    const prevTotal = dayChange != null ? accountValue - dayChange : null;
    const fxRate = g.find((r) => r.fx_rate != null)?.fx_rate ?? null;
    out.push({
      date,
      account_id: "global",
      account_value_usd: accountValue,
      securities_value_usd: sum((r) => r.securities_value_usd) ?? 0,
      cash_usd: sum((r) => r.cash_usd) ?? 0,
      total_pnl_usd: sum((r) => r.total_pnl_usd),
      day_change_usd: dayChange,
      day_change_pct:
        dayChange != null && prevTotal != null && prevTotal > 0
          ? (dayChange / prevTotal) * 100
          : null,
      fx_rate: fxRate,
      account_value_cny: fxRate != null ? accountValue * fxRate : null,
      spx_price: g.find((r) => r.spx_price != null)?.spx_price ?? null,
      ndx_price: g.find((r) => r.ndx_price != null)?.ndx_price ?? null,
      source: g.some((r) => r.source === "manual")
        ? "manual"
        : "refresh",
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------- US market session (America/New_York wall clock) ----------

type UsSessionKey = "pre" | "regular" | "post" | "overnight" | "closed";

const SESSION_LABELS: Record<UsSessionKey, string> = {
  pre: "盘前",
  regular: "盘中",
  post: "盘后",
  overnight: "夜盘",
  closed: "休市",
};

// Session boundaries (ET, weekdays): pre 04:00–09:30, regular
// 09:30–16:00, post 16:00–20:00, overnight 20:00–04:00; weekends are
// closed. Holidays are not modeled — on a holiday the feeds simply
// return the last session's data with its own timestamp.
function currentUsSession(at: Date = new Date()): {
  key: UsSessionKey;
  label: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") {
    return { key: "closed", label: SESSION_LABELS.closed };
  }
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
    return { key: "pre", label: SESSION_LABELS.pre };
  }
  if (minutes < 16 * 60) {
    return { key: "regular", label: SESSION_LABELS.regular };
  }
  if (minutes < 20 * 60) {
    return { key: "post", label: SESSION_LABELS.post };
  }
  return { key: "overnight", label: SESSION_LABELS.overnight };
}

async function loadPortfolio(ctx: Ctx): Promise<PortfolioResponse> {
  await ensureAccounts(ctx);
  const db = ctx.db<typeof schema>();
  const accountRows = (await db.select().from(schema.accounts)).sort(
    (a, b) => a.sort - b.sort,
  );
  const accountNames = new Map(accountRows.map((a) => [a.id, a.name]));
  const rows = await db.select().from(schema.holdings);
  const snaps = await db.select().from(schema.quoteSnapshots);
  const fxRows = await db.select().from(schema.fxSnapshots);
  const cashRows = await db.select().from(schema.accountBalances);
  const marketRows = await db.select().from(schema.marketSnapshots);
  const bySymbol = new Map(snaps.map((s) => [s.quoteSymbol, s]));
  let lastFetched: string | null = null;
  for (const s of snaps) {
    const f = s.fetchedAt.toISOString();
    if (!lastFetched || f > lastFetched) lastFetched = f;
  }
  const allHoldings = rows.map((h) => toHoldingOut(h, bySymbol));
  const cashByAccount = new Map(cashRows.map((c) => [c.accountId, c]));
  const snapRows = await db.select().from(schema.dailySnapshots);
  const allSnapshots = snapRows.map(toSnapshotOut);
  const accounts = accountRows.map((a) => {
    const cashRow = cashByAccount.get(a.id);
    return {
      account: { id: a.id, name: a.name },
      holdings: allHoldings.filter((h) => h.account_id === a.id),
      cash: cashRow
        ? {
            cash_usd: cashRow.cashUsd,
            snapshot_label: cashRow.snapshotLabel,
            updated_at: cashRow.updatedAt.toISOString(),
          }
        : null,
      history: allSnapshots
        .filter((s) => s.account_id === a.id)
        .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)),
    };
  });
  // Global cash: sum of the accounts that have a cash row; label and
  // timestamp describe the combination, not any single source row.
  const presentCash = cashRows;
  const globalCash =
    presentCash.length > 0
      ? {
          cash_usd: presentCash.reduce((s, c) => s + c.cashUsd, 0),
          snapshot_label: "各账户现金合计",
          updated_at: presentCash
            .map((c) => c.updatedAt.toISOString())
            .sort()
            .at(-1) as string,
        }
      : null;
  const fxRow = fxRows[0];
  const marketOrder = ["SPX", "NDX", "GOLD", "SGOLD"];
  const market = marketRows
    .map((m) => ({
      key: m.key,
      label: m.label,
      price: m.price,
      change: m.change,
      change_percent: m.changePercent,
      as_of: m.asOf,
      source: m.source,
      note: m.note,
    }))
    .sort(
      (a, b) => marketOrder.indexOf(a.key) - marketOrder.indexOf(b.key),
    );
  return {
    session: currentUsSession(),
    accounts,
    holdings: mergeHoldings(allHoldings, accountNames),
    last_fetched_at: lastFetched,
    market,
    history: mergeSnapshots(allSnapshots),
    fx: fxRow
      ? {
          rate: fxRow.rate,
          source: fxRow.source,
          as_of: fxRow.asOf,
          fetched_at: fxRow.fetchedAt.toISOString(),
        }
      : null,
    cash: globalCash,
  };
}

// ---------- Nasdaq public API (fallback quote + after-hours) ----------

function parseMoneyText(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[$,%+]/g, "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

const NASDAQ_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
};

type RegularQuote = {
  price: number;
  change: number | null;
  changePercent: number | null;
  high: number | null;
  low: number | null;
  week52High: number | null;
  week52Low: number | null;
  marketCap: number | null;
  marketStatus: string | null;
  asOf: string | null;
};

async function fetchNasdaqQuote(
  quoteSymbol: string,
  kind: string,
): Promise<RegularQuote | null> {
  const assetclass = kind === "etf" ? "etf" : "stocks";
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(quoteSymbol)}/info?assetclass=${assetclass}`;
  const res = await fetch(url, { headers: NASDAQ_HEADERS });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: {
      primaryData?: {
        lastSalePrice?: string;
        netChange?: string;
        percentageChange?: string;
        lastTradeTimestamp?: string;
      };
      marketStatus?: string;
      keyStats?: { fiftyTwoWeekHighLow?: { value?: string } };
    } | null;
  };
  const d = json.data;
  const p = d?.primaryData;
  if (!d || !p) return null;
  const price = parseMoneyText(p.lastSalePrice);
  if (price == null) return null;
  let w52l: number | null = null;
  let w52h: number | null = null;
  const range = d.keyStats?.fiftyTwoWeekHighLow?.value;
  if (range && range !== "NA") {
    const parts = range.split("-").map((x) => parseMoneyText(x.trim()));
    w52l = parts[0] ?? null;
    w52h = parts[1] ?? null;
  }
  return {
    price,
    change: parseMoneyText(p.netChange),
    changePercent: parseMoneyText(p.percentageChange),
    high: null,
    low: null,
    week52High: w52h,
    week52Low: w52l,
    marketCap: null,
    marketStatus: d.marketStatus ? d.marketStatus.toLowerCase() : null,
    asOf: p.lastTradeTimestamp ?? null,
  };
}

type ExtendedQuote = { price: number; asOf: string | null };

// Nasdaq extended-trading feed, parameterized by session: markettype
// "pre" (04:00–09:30 ET) and "post" (16:00–20:00 ET) share one shape —
// infoTable.rows[0].consolidated is "<price> <chg> (<pct>)" for the
// session's last trade and lastUpdateInfo[0] its update stamp (both
// verified live 2026-11-08). Outside its session the pre feed returns
// consolidated = null, which we treat as "no data" (never guessed).
// There is no Nasdaq feed for the overnight session (Blue Ocean), so
// overnight hours reuse the post session's last trade, timestamped.
async function fetchNasdaqExtended(
  quoteSymbol: string,
  kind: string,
  markettype: "pre" | "post",
): Promise<ExtendedQuote | null> {
  const assetclass = kind === "etf" ? "etf" : "stocks";
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(quoteSymbol)}/extended-trading?assetclass=${assetclass}&markettype=${markettype}`;
  const res = await fetch(url, { headers: NASDAQ_HEADERS });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: {
      lastUpdateInfo?: string[];
      infoTable?: { rows?: { consolidated?: string | null }[] };
      tradeDetailTable?: { rows?: { price?: string }[] };
    } | null;
  };
  const d = json.data;
  if (!d) return null;
  let price: number | null = null;
  const consolidated = d.infoTable?.rows?.[0]?.consolidated;
  if (consolidated) {
    price = parseMoneyText(consolidated.split(/\s+/)[0]);
  }
  if (price == null) {
    // Fallback: the most recent individual trade in the session.
    const lastTrade = d.tradeDetailTable?.rows?.[0]?.price;
    if (lastTrade) price = parseMoneyText(lastTrade);
  }
  if (price == null) return null;
  const upd = d.lastUpdateInfo?.[0];
  const asOf = upd
    ? upd.replace(/^Data last updated\s*/i, "").replace(/\.\s*$/, "")
    : null;
  return { price, asOf };
}

// ---------- USD/CNY ----------

async function fetchUsdCny(): Promise<{
  rate: number;
  source: string;
  asOf: string;
} | null> {
  // Primary: ExchangeRate-API free endpoint (updates daily, carries an
  // explicit last-update timestamp).
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (res.ok) {
      const json = (await res.json()) as {
        result?: string;
        rates?: { CNY?: number };
        time_last_update_utc?: string;
      };
      const rate = json.rates?.CNY;
      if (json.result === "success" && typeof rate === "number" && rate > 0) {
        const t = json.time_last_update_utc
          ? new Date(json.time_last_update_utc)
          : null;
        return {
          rate,
          source: "ExchangeRate-API (open.er-api.com)",
          asOf:
            t && !Number.isNaN(t.getTime())
              ? t.toISOString()
              : new Date().toISOString(),
        };
      }
    }
  } catch {
    // fall through to the backup source
  }
  // Backup: Frankfurter (ECB reference rates, dated by trading day).
  try {
    const res = await fetch(
      "https://api.frankfurter.app/latest?from=USD&to=CNY",
      { headers: { "User-Agent": "Mozilla/5.0" } },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        rates?: { CNY?: number };
        date?: string;
      };
      const rate = json.rates?.CNY;
      if (typeof rate === "number" && rate > 0) {
        return {
          rate,
          source: "Frankfurter (api.frankfurter.app)",
          asOf: json.date ?? new Date().toISOString(),
        };
      }
    }
  } catch {
    // both sources failed; caller keeps the last cached rate
  }
  return null;
}

// ---------- Market benchmarks (Yahoo Finance chart API) ----------

// ^GSPC / ^NDX are the cash indices on their regular-session basis.
const BENCHMARKS = [
  { key: "SPX", label: "标普500", yahoo: "^GSPC", note: "指数 · 常规收盘" },
  { key: "NDX", label: "纳指100", yahoo: "^NDX", note: "指数 · 常规收盘" },
] as const;

async function fetchBenchmark(b: (typeof BENCHMARKS)[number]): Promise<{
  price: number;
  change: number | null;
  changePercent: number | null;
  asOf: string;
  note: string;
} | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(b.yahoo)}?range=5d&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    chart?: {
      result?: {
        meta?: {
          regularMarketPrice?: number;
          fulldayChange?: number;
          fulldayChangePercent?: number;
          regularMarketTime?: number;
          shortName?: string;
        };
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }[];
    };
  };
  const r = json.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return null;
  let change =
    typeof meta.fulldayChange === "number" ? meta.fulldayChange : null;
  let changePercent =
    typeof meta.fulldayChangePercent === "number"
      ? meta.fulldayChangePercent
      : null;
  if (change == null) {
    const closes = (r?.indicators?.quote?.[0]?.close ?? []).filter(
      (c): c is number => typeof c === "number",
    );
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    if (last != null && prev != null && prev !== 0) {
      change = last - prev;
      changePercent = ((last - prev) / prev) * 100;
    }
  }
  const asOf =
    typeof meta.regularMarketTime === "number"
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString();
  return { price: meta.regularMarketPrice, change, changePercent, asOf, note: b.note };
}

// ---------- Gold: spot XAU/USD + Shanghai Gold (Sina quote feed) ----------

// One Sina request carries both codes:
//  - hf_XAU: London spot gold (XAU/USD) — fields [0]=last, [7]=prev close,
//    [6]=time, [12]=date (Beijing time).
//  - gds_AU9999: SGE Au99.99 in CNY per gram — same field layout.
// Fallbacks: spot price from gold-api.com (no change); Shanghai gold
// converted from spot × USD/CNY ÷ 31.1035 (troy oz → gram), labeled as
// a converted price, never as the exchange price.
const TROY_OZ_GRAMS = 31.1035;

type GoldQuote = {
  price: number;
  change: number | null;
  changePercent: number | null;
  asOf: string;
};

function parseSinaRow(text: string, code: string): string[] | null {
  const m = text.match(new RegExp(`hq_str_${code}="([^"]*)"`));
  if (!m || !m[1]) return null;
  return m[1].split(",");
}

function sinaGoldQuote(fields: string[]): GoldQuote | null {
  const price = Number(fields[0]);
  if (!Number.isFinite(price) || price <= 0) return null;
  const prevClose = Number(fields[7]);
  const hasPrev = Number.isFinite(prevClose) && prevClose > 0;
  const date = fields[12] ?? "";
  const time = fields[6] ?? "";
  const asOf =
    /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time)
      ? new Date(`${date}T${time}+08:00`).toISOString()
      : new Date().toISOString();
  return {
    price,
    change: hasPrev ? price - prevClose : null,
    changePercent: hasPrev ? ((price - prevClose) / prevClose) * 100 : null,
    asOf,
  };
}

async function fetchGoldQuotes(fxRate: number | null): Promise<{
  spot: (GoldQuote & { source: string }) | null;
  shanghai: (GoldQuote & { source: string; note: string }) | null;
}> {
  let spot: (GoldQuote & { source: string }) | null = null;
  let shanghai: (GoldQuote & { source: string; note: string }) | null = null;
  try {
    const res = await fetch(
      "https://hq.sinajs.cn/list=hf_XAU,gds_AU9999",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://finance.sina.com.cn",
        },
      },
    );
    if (res.ok) {
      const text = await res.text();
      const xau = parseSinaRow(text, "hf_XAU");
      if (xau) {
        const q = sinaGoldQuote(xau);
        if (q) spot = { ...q, source: "新浪财经" };
      }
      const au = parseSinaRow(text, "gds_AU9999");
      if (au) {
        const q = sinaGoldQuote(au);
        if (q)
          shanghai = { ...q, source: "新浪财经", note: "上金所 Au99.99 · 元/克" };
      }
    }
  } catch {
    // fall through to the fallbacks below
  }
  if (!spot) {
    try {
      const res = await fetch("https://api.gold-api.com/price/XAU", {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.ok) {
        const json = (await res.json()) as {
          price?: number;
          updatedAt?: string;
        };
        if (typeof json.price === "number" && json.price > 0) {
          spot = {
            price: json.price,
            change: null,
            changePercent: null,
            asOf: json.updatedAt ?? new Date().toISOString(),
            source: "Gold API",
          };
        }
      }
    } catch {
      spot = null;
    }
  }
  if (!shanghai && spot && fxRate != null && fxRate > 0) {
    const perGram = (spot.price * fxRate) / TROY_OZ_GRAMS;
    shanghai = {
      price: perGram,
      change:
        spot.change != null ? (spot.change * fxRate) / TROY_OZ_GRAMS : null,
      changePercent: spot.changePercent,
      asOf: spot.asOf,
      source: "换算",
      note: "现货金换算 · 元/克",
    };
  }
  return { spot, shanghai };
}

// ---------- Daily account snapshots ----------

// Demo first record (fictional sample data): account value $10,000.00 =
// securities $9,200.00 + cash $800.00, day change +$150.00 (+1.52%),
// unrealized P/L +$320.00. Nothing is back-derived for earlier days.
const SEED_SNAPSHOT_DATE = "2026-11-06";

async function ensureSeedSnapshot(ctx: Ctx): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({ date: schema.dailySnapshots.date })
    .from(schema.dailySnapshots)
    .where(
      and(
        eq(schema.dailySnapshots.date, SEED_SNAPSHOT_DATE),
        eq(schema.dailySnapshots.accountId, "broker-a"),
      ),
    );
  if (existing.length > 0) return false;
  const fxRows = await db.select().from(schema.fxSnapshots);
  const marketRows = await db.select().from(schema.marketSnapshots);
  const fxRate = fxRows[0]?.rate ?? null;
  const spx = marketRows.find((m) => m.key === "SPX")?.price ?? null;
  const ndx = marketRows.find((m) => m.key === "NDX")?.price ?? null;
  await db.insert(schema.dailySnapshots).values({
    date: SEED_SNAPSHOT_DATE,
    accountId: "broker-a",
    accountValueUsd: 10000,
    securitiesValueUsd: 9200,
    cashUsd: 800,
    totalPnlUsd: 320,
    dayChangeUsd: 150,
    dayChangePct: 1.52,
    fxRate,
    accountValueCny: fxRate != null ? 10000 * fxRate : null,
    spxPrice: spx,
    ndxPrice: ndx,
    source: "demo",
    createdAt: new Date(),
  });
  return true;
}

// Records one snapshot per account per US trading day from the
// just-refreshed portfolio (the global row is derived at read time).
// Only runs for an account when every one of its holdings has a quote
// (totals complete) and a trading date can be derived; a
// manual-sourced row for the same date + account is never
// overwritten. Accounts with no holdings (e.g. Broker B before the user
// is still empty) record nothing.
async function recordDailySnapshot(
  ctx: Ctx,
  portfolio: PortfolioResponse,
): Promise<void> {
  // Trading date: the S&P 500 benchmark's session timestamp, read in
  // America/New_York; fall back to the latest quote timestamp.
  const spx = portfolio.market.find((m) => m.key === "SPX");
  const ndx = portfolio.market.find((m) => m.key === "NDX");
  const stamp =
    spx?.as_of ??
    portfolio.holdings
      .map((h) => h.quote?.as_of)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ??
    null;
  if (!stamp) return;
  const stampDate = new Date(stamp);
  if (Number.isNaN(stampDate.getTime())) return;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(stampDate);

  const db = ctx.db<typeof schema>();
  for (const acc of portfolio.accounts) {
    const accountId = acc.account.id;
    const priced = acc.holdings.filter((h) => h.quote?.price != null);
    if (acc.holdings.length === 0 || priced.length !== acc.holdings.length) {
      continue;
    }
    const cashUsd = acc.cash?.cash_usd;
    if (cashUsd == null) continue;
    const existing = await db
      .select({ source: schema.dailySnapshots.source })
      .from(schema.dailySnapshots)
      .where(
        and(
          eq(schema.dailySnapshots.date, date),
          eq(schema.dailySnapshots.accountId, accountId),
        ),
      );
    if (existing[0]?.source === "manual") continue;

    let totalMv = 0;
    let totalCost = 0;
    let totalDay = 0;
    for (const h of priced) {
      const price = h.quote?.price ?? 0;
      totalMv += price * h.qty;
      totalCost += h.cost_per_share * h.qty;
      totalDay += (h.quote?.change ?? 0) * h.qty;
    }
    const prevTotal = totalMv - totalDay;
    const fxRate = portfolio.fx?.rate ?? null;
    const accountValue = totalMv + cashUsd;
    const values = {
      date,
      accountId,
      accountValueUsd: accountValue,
      securitiesValueUsd: totalMv,
      cashUsd,
      totalPnlUsd: totalMv - totalCost,
      dayChangeUsd: totalDay,
      dayChangePct: prevTotal > 0 ? (totalDay / prevTotal) * 100 : null,
      fxRate,
      accountValueCny: fxRate != null ? accountValue * fxRate : null,
      spxPrice: spx?.price ?? null,
      ndxPrice: ndx?.price ?? null,
      source: "refresh",
      createdAt: new Date(),
    };
    await db
      .insert(schema.dailySnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.dailySnapshots.date, schema.dailySnapshots.accountId],
        set: values,
      });
  }
}

// ---------- Actions ----------

const refreshResponse = z.object({
  updated: z.number(),
  failed: z.array(z.string()),
  fx_updated: z.boolean(),
  portfolio: portfolioResponse,
});

export const Actions = {
  getPortfolio: defineAction({
    description:
      "Returns all accounts （券商A/券商B…) with their stored holdings, per-account cash and per-account daily history, plus the merged global view (same-symbol holdings combined across accounts, cash and history summed), the latest cached regular-close quotes, session-aware extended-hours annotations (pre-market / after-hours), the current US market session (America/New_York), the cached USD/CNY rate, and market benchmarks (S&P 500, Nasdaq-100, spot gold XAU/USD, Shanghai Gold Au99.99 in CNY/gram).",
    request: z.object({}),
    response: portfolioResponse,
    handler: async (ctx): Promise<PortfolioResponse> => loadPortfolio(ctx),
  }),

  refreshQuotes: defineAction({
    description:
      "Refreshes regular-session quotes for the union of holding symbols across all accounts (finance channel, Nasdaq API fallback), extended-hours annotations from Nasdaq (pre-market feed while the pre session is live/just ended, after-hours feed otherwise; overnight reuses the after-hours last trade), and the live USD/CNY rate; records one daily snapshot per account; returns the refreshed portfolio.",
    request: z.object({}),
    response: refreshResponse,
    handler: async (ctx): Promise<z.infer<typeof refreshResponse>> => {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.holdings);
      // Quotes are shared per symbol: refresh the union of quote
      // symbols across all accounts, once each.
      const seenSymbols = new Set<string>();
      const targets: (typeof rows)[number][] = [];
      for (const h of rows) {
        if (!seenSymbols.has(h.quoteSymbol)) {
          seenSymbols.add(h.quoteSymbol);
          targets.push(h);
        }
      }
      const existing = await db.select().from(schema.quoteSnapshots);
      const existingBySymbol = new Map(existing.map((s) => [s.quoteSymbol, s]));
      const failed: string[] = [];
      let updated = 0;
      const now = new Date();
      const session = currentUsSession(now);

      await Promise.all(
        targets.map(async (h) => {
          // Extended-hours annotations are independent of the regular
          // quote. The post feed is fetched on every refresh (as
          // before); the pre feed joins while the pre session is live
          // or has just ended (regular session).
          let after: ExtendedQuote | null = null;
          try {
            after = await fetchNasdaqExtended(h.quoteSymbol, h.kind, "post");
          } catch {
            after = null;
          }
          let pre: ExtendedQuote | null = null;
          if (session.key === "pre" || session.key === "regular") {
            try {
              pre = await fetchNasdaqExtended(h.quoteSymbol, h.kind, "pre");
            } catch {
              pre = null;
            }
          }

          let regular: RegularQuote | null = null;
          let source: string | null = null;
          try {
            const res = await ctx.tool.finance_ticker(h.quoteSymbol);
            const inst = res.content.instrument;
            // Guard against wrong-instrument matches: a non-USD price is
            // not this holding (e.g. a foreign same-name listing).
            if (inst && inst.price != null && inst.currency === "USD") {
              regular = {
                price: inst.price,
                change: inst.change ?? null,
                changePercent: inst.change_percent ?? null,
                high: inst.high ?? null,
                low: inst.low ?? null,
                week52High: inst.week_52_high ?? null,
                week52Low: inst.week_52_low ?? null,
                marketCap: inst.market_cap ?? null,
                marketStatus: inst.market_status ?? null,
                asOf: inst.as_of ?? null,
              };
              source = "finance";
            }
          } catch {
            regular = null;
          }
          if (!regular) {
            try {
              regular = await fetchNasdaqQuote(h.quoteSymbol, h.kind);
              if (regular) source = "nasdaq";
            } catch {
              regular = null;
            }
          }

          const prev = existingBySymbol.get(h.quoteSymbol);
          if (!regular) {
            failed.push(h.symbol);
            // Still refresh the extended annotations against the cached
            // regular close when we have one. Outside the regular
            // session the cached price IS the reference close (the
            // previous close during pre-market, the same-day close
            // during post/overnight), so the session-aware ext fields
            // can be updated too; during the regular session the cached
            // price is intraday and is not a valid reference, so ext
            // stays as stored.
            if (after && prev && prev.price != null) {
              await db
                .update(schema.quoteSnapshots)
                .set({
                  afterPrice: after.price,
                  afterChangePercent:
                    ((after.price - prev.price) / prev.price) * 100,
                  afterAsOf: after.asOf,
                })
                .where(eq(schema.quoteSnapshots.quoteSymbol, h.quoteSymbol));
            }
            if (prev && prev.price != null && session.key !== "regular") {
              const chosen =
                session.key === "pre"
                  ? pre
                    ? { q: pre, s: "pre" as const }
                    : after
                      ? { q: after, s: "post" as const }
                      : null
                  : after
                    ? { q: after, s: "post" as const }
                    : null;
              if (chosen) {
                await db
                  .update(schema.quoteSnapshots)
                  .set({
                    extPrice: chosen.q.price,
                    extChangePercent:
                      ((chosen.q.price - prev.price) / prev.price) * 100,
                    extAsOf: chosen.q.asOf,
                    extSession: chosen.s,
                  })
                  .where(
                    eq(schema.quoteSnapshots.quoteSymbol, h.quoteSymbol),
                  );
              }
            }
            return;
          }

          // Drop impossible 52-week ranges the upstream sometimes returns
          // (e.g. a low above the current price, from a mixed-up listing);
          // an absent range is honest, a wrong one is not.
          let w52h = regular.week52High;
          let w52l = regular.week52Low;
          if (
            (w52l != null && w52l > regular.price) ||
            (w52h != null && w52h < regular.price)
          ) {
            w52h = null;
            w52l = null;
          }
          // Session-aware extended quote (annotation + live estimate
          // only; never enters the official totals). The percent is
          // measured against the close its session references: the
          // previous close for pre-market, the same-day close for
          // after-hours. When the relevant feed has no data this
          // refresh, the stored snapshot is kept with its timestamp.
          let extPrice: number | null = prev?.extPrice ?? null;
          let extChangePercent: number | null = prev?.extChangePercent ?? null;
          let extAsOf: string | null = prev?.extAsOf ?? null;
          let extSession: string | null = prev?.extSession ?? null;
          const prevClose =
            regular.change != null ? regular.price - regular.change : null;
          let chosen: {
            q: ExtendedQuote;
            s: "pre" | "post";
            ref: number;
          } | null = null;
          if (session.key === "pre") {
            if (pre) chosen = { q: pre, s: "pre", ref: regular.price };
            else if (after) chosen = { q: after, s: "post", ref: regular.price };
          } else if (session.key === "regular") {
            // This morning's pre-market, measured against the previous
            // close (price − change). No pre data → keep stored ext.
            if (pre && prevClose != null && prevClose > 0) {
              chosen = { q: pre, s: "pre", ref: prevClose };
            }
          } else {
            // post / overnight / closed: after-hours is the latest
            // extended session; overnight reuses its last trade.
            if (after) chosen = { q: after, s: "post", ref: regular.price };
          }
          if (chosen && chosen.ref > 0) {
            extPrice = chosen.q.price;
            extChangePercent =
              ((chosen.q.price - chosen.ref) / chosen.ref) * 100;
            extAsOf = chosen.q.asOf;
            extSession = chosen.s;
          }
          const values = {
            quoteSymbol: h.quoteSymbol,
            price: regular.price,
            change: regular.change,
            changePercent: regular.changePercent,
            high: regular.high,
            low: regular.low,
            week52High: w52h,
            week52Low: w52l,
            marketCap: regular.marketCap,
            marketStatus: regular.marketStatus,
            asOf: regular.asOf,
            afterPrice: after?.price ?? null,
            afterChangePercent:
              after != null
                ? ((after.price - regular.price) / regular.price) * 100
                : null,
            afterAsOf: after?.asOf ?? null,
            extPrice,
            extChangePercent,
            extAsOf,
            extSession,
            source,
            fetchedAt: now,
          };
          await db
            .insert(schema.quoteSnapshots)
            .values(values)
            .onConflictDoUpdate({
              target: schema.quoteSnapshots.quoteSymbol,
              set: values,
            });
          updated += 1;
        }),
      );

      // USD/CNY, refreshed alongside the quotes.
      let fxUpdated = false;
      let effectiveFxRate: number | null = null;
      try {
        const fx = await fetchUsdCny();
        if (fx) {
          effectiveFxRate = fx.rate;
          const fxValues = {
            pair: "USD/CNY",
            rate: fx.rate,
            source: fx.source,
            asOf: fx.asOf,
            fetchedAt: now,
          };
          await db
            .insert(schema.fxSnapshots)
            .values(fxValues)
            .onConflictDoUpdate({
              target: schema.fxSnapshots.pair,
              set: fxValues,
            });
          fxUpdated = true;
        }
      } catch {
        fxUpdated = false;
      }
      if (effectiveFxRate == null) {
        const cachedFx = await db.select().from(schema.fxSnapshots);
        effectiveFxRate = cachedFx[0]?.rate ?? null;
      }

      // Market benchmarks, refreshed alongside the quotes.
      await Promise.all(
        BENCHMARKS.map(async (b) => {
          try {
            const bench = await fetchBenchmark(b);
            if (!bench) return;
            const values = {
              key: b.key,
              label: b.label,
              price: bench.price,
              change: bench.change,
              changePercent: bench.changePercent,
              asOf: bench.asOf,
              source: "Yahoo Finance",
              note: bench.note,
              fetchedAt: now,
            };
            await db
              .insert(schema.marketSnapshots)
              .values(values)
              .onConflictDoUpdate({
                target: schema.marketSnapshots.key,
                set: values,
              });
          } catch {
            // keep the last cached benchmark row
          }
        }),
      );

      // Gold: spot XAU/USD + Shanghai Gold (CNY per gram).
      try {
        const gold = await fetchGoldQuotes(effectiveFxRate);
        const goldRows = [
          gold.spot
            ? {
                key: "GOLD",
                label: "现货黄金",
                price: gold.spot.price,
                change: gold.spot.change,
                changePercent: gold.spot.changePercent,
                asOf: gold.spot.asOf,
                source: gold.spot.source,
                note: "现货 XAU/USD · 美元/盎司",
                fetchedAt: now,
              }
            : null,
          gold.shanghai
            ? {
                key: "SGOLD",
                label: "上海黄金",
                price: gold.shanghai.price,
                change: gold.shanghai.change,
                changePercent: gold.shanghai.changePercent,
                asOf: gold.shanghai.asOf,
                source: gold.shanghai.source,
                note: gold.shanghai.note,
                fetchedAt: now,
              }
            : null,
        ];
        for (const values of goldRows) {
          if (!values) continue;
          await db
            .insert(schema.marketSnapshots)
            .values(values)
            .onConflictDoUpdate({
              target: schema.marketSnapshots.key,
              set: values,
            });
        }
      } catch {
        // keep the last cached gold rows
      }

      // Daily snapshot: seed the demo record once, then
      // record/refresh today's trading-day row from the new quotes.
      try {
        await ensureSeedSnapshot(ctx);
        await recordDailySnapshot(ctx, await loadPortfolio(ctx));
      } catch {
        // snapshot bookkeeping never blocks the quote refresh
      }

      ctx.invalidateQueries();
      return {
        updated,
        failed,
        fx_updated: fxUpdated,
        portfolio: await loadPortfolio(ctx),
      };
    },
  }),

  seedDailySnapshot: defineAction({
    description:
      "Seeds a demo first daily snapshot for the Broker A account (account value $10,000.00, day change +$150.00); a no-op when that date already has a Broker A record.",
    request: z.object({}),
    response: z.object({ seeded: z.boolean() }),
    handler: async (ctx): Promise<{ seeded: boolean }> => {
      const seeded = await ensureSeedSnapshot(ctx);
      if (seeded) ctx.invalidateQueries();
      return { seeded };
    },
  }),

  seedHoldings: defineAction({
    description:
      "Seeds the demo holdings exactly once (under the broker-a account); a no-op when that account already has holdings.",
    request: z.object({}),
    response: z.object({ seeded: z.number() }),
    handler: async (ctx): Promise<{ seeded: number }> => {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, "broker-a"))
        .limit(1);
      if (existing.length > 0) return { seeded: 0 };
      await db.insert(schema.holdings).values(
        DEMO_HOLDINGS.map((h) => ({ ...h, accountId: "broker-a" })),
      );
      ctx.invalidateQueries();
      return { seeded: DEMO_HOLDINGS.length };
    },
  }),

  updateHolding: defineAction({
    description: "Updates the quantity and/or cost per share of one holding.",
    request: z.object({
      id: z.number().int().positive(),
      qty: z.number().nonnegative(),
      cost_per_share: z.number().nonnegative(),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.holdings)
        .set({ qty: args.qty, costPerShare: args.cost_per_share })
        .where(eq(schema.holdings.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  updateCash: defineAction({
    description:
      "Updates one account's stored cash balance (USD) from a newer user-provided figure; that account's total value, the global total and its CNY conversion follow from it.",
    request: z.object({
      account_id: z.string().min(1).max(40),
      cash_usd: z.number().nonnegative(),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await ensureAccounts(ctx);
      const known = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, args.account_id));
      if (known.length === 0) {
        throw new Error(`updateCash: unknown account "${args.account_id}"`);
      }
      const values = {
        accountId: args.account_id,
        cashUsd: args.cash_usd,
        snapshotLabel: "用户手动更新",
        updatedAt: new Date(),
      };
      await db
        .insert(schema.accountBalances)
        .values(values)
        .onConflictDoUpdate({
          target: schema.accountBalances.accountId,
          set: values,
        });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  addHolding: defineAction({
    description:
      "Adds a new holding row to one account (account_id, symbol, quantity, cost per share, theme). If the symbol already exists in that account, its quantity is added and the cost is re-averaged instead of creating a duplicate row.",
    request: z.object({
      account_id: z.string().min(1).max(40),
      symbol: z.string().min(1).max(12),
      name: z.string().min(1).max(80),
      qty: z.number().nonnegative(),
      cost_per_share: z.number().nonnegative(),
      kind: z.enum(["stock", "etf"]),
      theme: z.string().min(1).max(20),
    }),
    response: z.object({ id: z.number() }),
    handler: async (ctx, args): Promise<{ id: number }> => {
      const db = ctx.db<typeof schema>();
      await ensureAccounts(ctx);
      const known = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, args.account_id));
      if (known.length === 0) {
        throw new Error(`addHolding: unknown account "${args.account_id}"`);
      }
      const symbol = args.symbol.trim().toUpperCase();
      const quoteSymbol = symbol === "BRK/B" ? "BRK.B" : symbol;
      const dup = await db
        .select()
        .from(schema.holdings)
        .where(
          and(
            eq(schema.holdings.accountId, args.account_id),
            eq(schema.holdings.symbol, symbol),
          ),
        );
      const existingRow = dup[0];
      if (existingRow) {
        const totalQty = existingRow.qty + args.qty;
        const mergedCost =
          totalQty > 0
            ? (existingRow.qty * existingRow.costPerShare +
                args.qty * args.cost_per_share) /
              totalQty
            : args.cost_per_share;
        await db
          .update(schema.holdings)
          .set({ qty: totalQty, costPerShare: mergedCost })
          .where(eq(schema.holdings.id, existingRow.id));
        ctx.invalidateQueries();
        return { id: existingRow.id };
      }
      const result = await db
        .insert(schema.holdings)
        .values({
          accountId: args.account_id,
          symbol,
          quoteSymbol,
          name: args.name.trim(),
          qty: args.qty,
          costPerShare: args.cost_per_share,
          kind: args.kind,
          theme: args.theme.trim(),
        })
        .returning({ id: schema.holdings.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addHolding: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  removeHolding: defineAction({
    description: "Removes one holding row by id.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.holdings).where(eq(schema.holdings.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),
} satisfies ActionsModule;
