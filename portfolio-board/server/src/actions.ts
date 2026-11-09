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
// prices only. Extended-hours prices (Nasdaq extended-trading feeds
// for pre-market and after-hours; Yahoo chart meta.fulldayPrice for
// the overnight session, which Nasdaq does not cover) are stored
// separately (ext_* fields, plus the legacy after_* post-session
// mirror), shown as annotations and in a clearly-labeled live
// estimate next to the official total; they never enter the official
// totals or the daily snapshots. The overnight price carries no
// trade timestamp: its ext_as_of is the fetch moment, labeled 抓取于.
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
  // All-time highest close and the date (YYYY-MM-DD) it was set;
  // null until the one-time seed succeeds.
  peak_price: z.number().nullable(),
  peak_date: z.string().nullable(),
  // Highest close within the trailing 3-year window and its date;
  // null until its seed succeeds. Client derives 距高点 from this.
  peak3y_price: z.number().nullable(),
  peak3y_date: z.string().nullable(),
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

// Session boundaries (ET): pre 04:00–09:30, regular 09:30–16:00,
// post 16:00–20:00 (Mon–Fri), overnight 20:00–04:00. The overnight
// (Blue Ocean) session runs Sunday–Thursday nights: its evening leg
// (20:00–24:00) belongs to Sun–Thu and its after-midnight leg
// (00:00–04:00) to Mon–Fri, so Sunday evening is overnight (not
// closed) and Friday night / Saturday are closed (no session).
// Holidays are not modeled — on a holiday the feeds simply return
// the last session's data with its own timestamp.
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
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const eveningLeg =
    ["Sun", "Mon", "Tue", "Wed", "Thu"].includes(weekday) &&
    minutes >= 20 * 60;
  const morningLeg =
    ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday) &&
    minutes < 4 * 60;
  if (eveningLeg || morningLeg) {
    return { key: "overnight", label: SESSION_LABELS.overnight };
  }
  if (weekday === "Sat" || weekday === "Sun") {
    return { key: "closed", label: SESSION_LABELS.closed };
  }
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
    return { key: "pre", label: SESSION_LABELS.pre };
  }
  if (minutes < 16 * 60) {
    return { key: "regular", label: SESSION_LABELS.regular };
  }
  if (minutes < 20 * 60) {
    return { key: "post", label: SESSION_LABELS.post };
  }
  // Friday 20:00–24:00: no overnight session into the weekend.
  return { key: "closed", label: SESSION_LABELS.closed };
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
  const marketOrder = [
    "SPX",
    "NDX",
    "IXIC",
    "SSEC",
    "CSI300",
    "A500",
    "HSTECH",
    "N225",
    "VNI",
    "GOLD",
    "SGOLD",
  ];
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
      peak_price: m.peakPrice,
      peak_date: m.peakDate,
      peak3y_price: m.peak3yPrice,
      peak3y_date: m.peak3yDate,
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
// There is no Nasdaq feed for the overnight session (Blue Ocean) —
// overnight prices come from Yahoo fulldayPrice (see below); this
// post feed remains the per-symbol fallback when Yahoo yields
// nothing, with its own timestamp.
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

// ---------- Yahoo overnight (Blue Ocean) price ----------
//
// Nasdaq has no overnight quote stream, so during the overnight
// session (20:00–04:00 ET) the extended price comes from Yahoo
// Finance's chart API instead: meta.fulldayPrice is the latest price
// including pre/post/overnight (Blue Ocean) trades — during the
// overnight session it tracks the live overnight tape while Nasdaq's
// post feed still shows the stale after-hours last trade.
// fulldayPrice carries NO trade timestamp, so callers stamp ext_as_of
// with the fetch moment and the UI labels it 抓取于 (fetched at) —
// never as a trade time. Yahoo symbols match quoteSymbol except
// BRK.B, which Yahoo spells BRK-B. Any failure (non-OK status,
// missing / non-numeric / non-positive fulldayPrice) returns null and
// the caller keeps the existing after-hours fallback behavior.
async function fetchYahooOvernightPrice(
  quoteSymbol: string,
): Promise<number | null> {
  const yahooSymbol = quoteSymbol === "BRK.B" ? "BRK-B" : quoteSymbol;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: { meta?: { fulldayPrice?: number } }[];
      };
    };
    const p = json.chart?.result?.[0]?.meta?.fulldayPrice;
    return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
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

// ---------- Market benchmarks ----------

// Yahoo chart API: ^GSPC / ^NDX / ^IXIC / ^N225 are the cash indices
// on their regular-session basis. `tz` is the market's own timezone,
// used to date-stamp the all-time peak (seed + ratchet).
const BENCHMARKS = [
  { key: "SPX", label: "标普500", yahoo: "^GSPC", note: "指数 · 常规收盘", tz: "America/New_York" },
  { key: "NDX", label: "纳指100", yahoo: "^NDX", note: "指数 · 常规收盘", tz: "America/New_York" },
  { key: "IXIC", label: "纳指综合", yahoo: "^IXIC", note: "指数 · 常规收盘", tz: "America/New_York" },
  { key: "N225", label: "日经225", yahoo: "^N225", note: "指数 · 常规收盘", tz: "Asia/Tokyo" },
] as const;

// Eastmoney K-line indices (same endpoint family as the gold seeds
// below): A-share indices under market 1, global indices under market
// 100, Hong Kong indices under market 124. 100.VNINDEX is Eastmoney's
// Ho Chi Minh index (data.name 越南胡志明， verified live 2026-11-09;
// Yahoo has no VN-Index symbol). 124.HSTECH is the Hang Seng TECH
// Index (data.name 恒生科技指数， verified live 2026-11-09; Yahoo's
// ^HSTECH returns "No data found, symbol may be delisted", so
// Eastmoney is its source — price/change from the last two daily
// closes, peak seeded from the full history back to the 2014 base
// period: max close 10,945.22 on 2021-02-17).
// Price/change come from the last two daily closes; the peak seed is
// the same endpoint's full history. 中证A500's series carries
// back-calculated history before its 2024 launch — seeded as returned.
const EM_INDICES = [
  { key: "SSEC", label: "上证指数", secid: "1.000001", note: "指数 · 常规收盘" },
  { key: "CSI300", label: "沪深300", secid: "1.000300", note: "指数 · 常规收盘" },
  { key: "A500", label: "中证A500", secid: "1.000510", note: "指数 · 常规收盘" },
  { key: "HSTECH", label: "恒生科技", secid: "124.HSTECH", note: "指数 · 常规收盘" },
  { key: "VNI", label: "越南胡志明", secid: "100.VNINDEX", note: "指数 · 常规收盘" },
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
  // The daily closes are authoritative whenever the reported price IS
  // the latest close (always true outside that market's live session):
  // some index feeds report a bogus fulldayChange of 0 (^N225 does —
  // verified 2026-11-09: meta said 0 while the Nov 6 close was −5.97%
  // vs Nov 5). During a live session the price is intraday and ahead
  // of the last daily close, so the meta change stands.
  const closes = (r?.indicators?.quote?.[0]?.close ?? []).filter(
    (c): c is number => typeof c === "number",
  );
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  if (
    lastClose != null &&
    prevClose != null &&
    prevClose !== 0 &&
    Math.abs(lastClose - meta.regularMarketPrice) <=
      Math.max(0.01, meta.regularMarketPrice * 0.0005)
  ) {
    change = lastClose - prevClose;
    changePercent = ((lastClose - prevClose) / prevClose) * 100;
  } else if (change == null && lastClose != null && prevClose != null && prevClose !== 0) {
    change = lastClose - prevClose;
    changePercent = ((lastClose - prevClose) / prevClose) * 100;
  }
  const asOf =
    typeof meta.regularMarketTime === "number"
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString();
  return { price: meta.regularMarketPrice, change, changePercent, asOf, note: b.note };
}

// ---------- All-time peak (highest close) seeds + rolling ratchet ----------
//
// peak_price / peak_date power the 距高点 line. A peak is seeded ONCE,
// only while the stored value is null, from long history:
//  - SPX / NDX / IXIC / N225: Yahoo chart daily closes, range=10y
//    (the same endpoint fetchBenchmark uses, wider range) — max close
//    + the date of its bar, read in the market's own timezone
//    (America/New_York for the US indices, Asia/Tokyo for N225).
//  - SSEC / CSI300 / A500 / VNI: Eastmoney K-line full history (the
//    fetchEastmoneyKlines endpoint below) — max close + its date.
//    A500's series includes back-calculated history predating its
//    2024 launch; it is seeded exactly as returned.
//  - GOLD (spot XAU/USD; live price from Sina): the seed comes from
//    Eastmoney's London-gold K-line (secid 122.XAU, daily, full
//    history back to 1992) — max close + its date. Yahoo's XAUUSD=X
//    was delisted (verified 2026-11-08) and Stooq is unreachable
//    through the server egress, so Eastmoney is primary and Stooq's
//    XAU/USD spot CSV (s=xauusd) stays as the fallback — always spot,
//    never GC=F futures. Either seed is accepted only when the
//    series' last close sits within 1.5% of the board's live Sina
//    spot price; otherwise the GOLD peak stays null.
//  - SGOLD: Eastmoney K-line for SGE Au99.99 (secid 118.Au9999, daily,
//    full history back to 2004) — max close column + its date string.
// After seeding, refreshQuotes only ever ratchets the peak up: a new
// price above the stored peak replaces it (date = the new price's
// asOf date); a lower price never touches it, and a later seed attempt
// never overwrites an existing peak.

type PeakSeed = { price: number; date: string };

// YYYY-MM-DD of an instant in a given IANA timezone.
function dateInTz(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Date (YYYY-MM-DD) an asOf stamp belongs to, in the market's own
// timezone (US series → America/New_York, China series → Asia/Shanghai).
function asOfDate(asOf: string | null, timeZone: string): string | null {
  if (!asOf) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return asOf;
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return null;
  return dateInTz(d, timeZone);
}

async function fetchYahooPeak(
  yahooSymbol: string,
  timeZone: string = "America/New_York",
): Promise<PeakSeed | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=10y&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: {
          timestamp?: (number | null)[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    };
    const r = json.chart?.result?.[0];
    const stamps = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    let best: PeakSeed | null = null;
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i];
      const t = stamps[i];
      if (typeof c !== "number" || !(c > 0)) continue;
      if (typeof t !== "number") continue;
      if (!best || c > best.price) {
        best = { price: c, date: dateInTz(new Date(t * 1000), timeZone) };
      }
    }
    return best;
  } catch {
    return null;
  }
}

// GOLD seed fallback: Stooq's XAU/USD spot daily history CSV
// (Date,Open,High,Low,Close,Volume). Used only while the GOLD peak
// is null (via resolvePeak's seed-once rule); the live GOLD price
// stays on Sina hf_XAU. Consistency guard: the CSV's last close must
// be within 1.5% of the board's current spot price (referencePrice),
// otherwise the whole seed is refused — a stale or mismatched series
// must never pose as the all-time high.
async function fetchStooqGoldPeak(
  referencePrice: number | null,
): Promise<PeakSeed | null> {
  try {
    const res = await fetch("https://stooq.com/q/d/l/?s=xauusd&i=d", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    let best: PeakSeed | null = null;
    let lastClose: number | null = null;
    for (const line of text.split(/\r?\n/)) {
      const parts = line.split(",");
      const date = parts[0] ?? "";
      const close = Number(parts[4]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!Number.isFinite(close) || close <= 0) continue;
      lastClose = close;
      if (!best || close > best.price) best = { price: close, date };
    }
    if (!best || lastClose == null) return null;
    if (referencePrice == null || !(referencePrice > 0)) return null;
    if (Math.abs(lastClose - referencePrice) / referencePrice > 0.015) {
      return null;
    }
    return best;
  } catch {
    return null;
  }
}

// GOLD seed (primary): Eastmoney K-line for London spot gold
// (secid 122.XAU — data.name 黄金/美元， code XAU; daily closes back
// to 1992-05-19, the full listed history). Same endpoint and row
// shape as the SGOLD seed below. Consistency guard, identical to the
// Stooq fallback's: the series' last close must be within 1.5% of
// the board's live Sina spot price (referencePrice), otherwise the
// seed is refused and the GOLD peak stays null.
async function fetchEastmoneyGoldPeak(
  referencePrice: number | null,
): Promise<PeakSeed | null> {
  try {
    const url =
      "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=122.XAU&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=0&end=20500101&lmt=100000";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { klines?: string[] } | null;
    };
    const klines = json.data?.klines ?? [];
    // Each row: "日期,开,收,高,低,量" — index 2 is the close; rows are
    // chronological, so the last valid close is the latest close.
    let best: PeakSeed | null = null;
    let lastClose: number | null = null;
    for (const line of klines) {
      const parts = line.split(",");
      const date = parts[0] ?? "";
      const close = Number(parts[2]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!Number.isFinite(close) || close <= 0) continue;
      lastClose = close;
      if (!best || close > best.price) best = { price: close, date };
    }
    if (!best || lastClose == null) return null;
    if (referencePrice == null || !(referencePrice > 0)) return null;
    if (Math.abs(lastClose - referencePrice) / referencePrice > 0.015) {
      return null;
    }
    return best;
  } catch {
    return null;
  }
}

// Shared Eastmoney K-line fetch (daily bars, klt=101): rows are
// "日期，开，收，高，低，量" in chronological order; index 2 is the
// close. `beg` is YYYYMMDD or "0" for the full listed history.
// push2his is flaky per request (intermittent empty bodies / 502s —
// observed live for individual secids while sibling requests in the
// same batch succeed), and a single failed attempt used to be enough
// to skip a one-shot consumer for a whole refresh cycle: CSI300's
// trailing-3-year peak seed failed exactly that way in production
// (2026-11-09) while the other ten benchmarks' seeds landed, leaving
// its 距高点 cell empty. So the fetch retries up to 3 attempts with
// backoff on any failure shape (network error, non-OK status,
// unparseable/empty body, zero usable rows) before giving up; the
// callers' keep-old-value-on-null behavior is unchanged.
async function fetchEastmoneyKlines(
  secid: string,
  beg: string,
): Promise<{ date: string; close: number }[] | null> {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=${beg}&end=20500101&lmt=100000`;
  const backoffMs = [0, 400, 1200];
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    const wait = backoffMs[attempt] ?? 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        data?: { klines?: string[] } | null;
      };
      const klines = json.data?.klines ?? [];
      const rows: { date: string; close: number }[] = [];
      for (const line of klines) {
        const parts = line.split(",");
        const date = parts[0] ?? "";
        const close = Number(parts[2]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (!Number.isFinite(close) || close <= 0) continue;
        rows.push({ date, close });
      }
      if (rows.length > 0) return rows;
    } catch {
      // fall through to the next attempt
    }
  }
  return null;
}

// Peak seed from an Eastmoney series' full history: max close + date.
async function fetchEastmoneyKlinePeak(
  secid: string,
): Promise<PeakSeed | null> {
  const rows = await fetchEastmoneyKlines(secid, "0");
  if (!rows) return null;
  let best: PeakSeed | null = null;
  for (const r of rows) {
    if (!best || r.close > best.price) best = { price: r.close, date: r.date };
  }
  return best;
}

// Eastmoney index quote: the last close is the price, the previous
// close gives the day change; asOf is the last row's own date (that
// market's latest trading day — Asia-Pacific indices refresh on their
// own calendar, independent of the US session).
async function fetchEastmoneyIndexQuote(secid: string): Promise<{
  price: number;
  change: number | null;
  changePercent: number | null;
  asOf: string;
} | null> {
  const d = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  const beg = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const rows = await fetchEastmoneyKlines(secid, beg);
  const last = rows?.[rows.length - 1];
  if (!rows || !last) return null;
  const prev = rows[rows.length - 2];
  const change = prev ? last.close - prev.close : null;
  return {
    price: last.close,
    change,
    changePercent:
      change != null && prev && prev.close !== 0
        ? (change / prev.close) * 100
        : null,
    asOf: last.date,
  };
}

async function fetchSgoldPeak(): Promise<PeakSeed | null> {
  return fetchEastmoneyKlinePeak("118.Au9999");
}

// Computes the peak to store alongside a fresh price: seed once when
// the stored peak is null (a failed seed leaves it null — never
// back-filled from just the current price, which would understate the
// drawdown), otherwise ratchet up only.
async function resolvePeak(
  existing: { peakPrice: number | null; peakDate: string | null } | undefined,
  price: number,
  asOf: string | null,
  timeZone: string,
  seed: () => Promise<PeakSeed | null>,
): Promise<{ peakPrice: number | null; peakDate: string | null }> {
  let peakPrice = existing?.peakPrice ?? null;
  let peakDate = existing?.peakDate ?? null;
  if (peakPrice == null) {
    const s = await seed();
    if (s) {
      peakPrice = s.price;
      peakDate = s.date;
    }
  }
  if (peakPrice != null && price > peakPrice) {
    peakPrice = price;
    peakDate = asOfDate(asOf, timeZone) ?? peakDate;
  }
  return { peakPrice, peakDate };
}

// ---------- Trailing-3-year peak (peak3y) seeds + maintenance ----------
//
// peak3y_price / peak3y_date are the highest close within the trailing
// 3-year window (right end = the series' latest close date; a close
// counts when its date is >= latest date minus 3 calendar years). The
// strip's 距高点 is computed against this peak; the all-time peak
// above is stored and maintained unchanged alongside it.
// Maintenance differs from the all-time peak in one way: a stored
// peak3y can EXPIRE — once its date slides out of the window it no
// longer bounds the drawdown, and the next-highest close inside the
// window is not recoverable from the scalar. So resolvePeak3y
// re-seeds from the source series whenever the stored date has slid
// out (and once, while null); a failed re-seed keeps the old value
// rather than clearing it. Between expiries it ratchets up exactly
// like the all-time peak. Seeds come from the same sources as the
// all-time seeds, windowed:
//  - Yahoo indices: chart API range=5y daily closes (fetched wider
//    than 3y so the window's right end is never truncated), windowed
//    by bar date in the market's own timezone.
//  - Eastmoney indices + SGOLD + GOLD: the shared K-line endpoint
//    with beg ~3 years back (plus a small buffer), windowed by the
//    last row's date. GOLD keeps its spot-only rule and 1.5%
//    last-close consistency guard (Eastmoney 122.XAU primary, Stooq
//    XAU/USD CSV fallback — never GC=F futures).

// YYYY-MM-DD exactly `years` calendar years before the given date
// (Feb 29 clamps to Feb 28 in a non-leap target year).
function yearsBefore(dateStr: string, years: number): string {
  const parts = dateStr.split("-").map(Number);
  const y = (parts[0] ?? 1970) - years;
  const m = parts[1] ?? 1;
  let d = parts[2] ?? 1;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) d = daysInMonth;
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(m, 2)}-${p(d, 2)}`;
}

// Max close within the trailing-3-year window of a chronological
// daily series; the window's right end is the series' last row date.
function windowPeak3y(
  rows: { date: string; close: number }[],
): PeakSeed | null {
  const last = rows[rows.length - 1];
  if (!last) return null;
  const cutoff = yearsBefore(last.date, 3);
  let best: PeakSeed | null = null;
  for (const r of rows) {
    if (r.date < cutoff) continue;
    if (!best || r.close > best.price) best = { price: r.close, date: r.date };
  }
  return best;
}

async function fetchYahooPeak3y(
  yahooSymbol: string,
  timeZone: string = "America/New_York",
): Promise<PeakSeed | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5y&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: {
          timestamp?: (number | null)[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    };
    const r = json.chart?.result?.[0];
    const stamps = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    const rows: { date: string; close: number }[] = [];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i];
      const t = stamps[i];
      if (typeof c !== "number" || !(c > 0)) continue;
      if (typeof t !== "number") continue;
      rows.push({ date: dateInTz(new Date(t * 1000), timeZone), close: c });
    }
    return windowPeak3y(rows);
  } catch {
    return null;
  }
}

// Eastmoney beg (YYYYMMDD) ~3 years + 45 days back from today (UTC):
// wide enough that the fetched series always covers the full window
// ending at its own last row.
function eastmoneyBeg3y(): string {
  const now = new Date();
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  const today = `${p(now.getUTCFullYear(), 4)}-${p(now.getUTCMonth() + 1, 2)}-${p(now.getUTCDate(), 2)}`;
  const start = new Date(`${yearsBefore(today, 3)}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 45);
  return `${p(start.getUTCFullYear(), 4)}${p(start.getUTCMonth() + 1, 2)}${p(start.getUTCDate(), 2)}`;
}

// 3y peak seed from an Eastmoney K-line series (indices, SGOLD).
async function fetchEastmoneyKlinePeak3y(
  secid: string,
): Promise<PeakSeed | null> {
  const rows = await fetchEastmoneyKlines(secid, eastmoneyBeg3y());
  if (!rows) return null;
  return windowPeak3y(rows);
}

// GOLD 3y seed (primary): Eastmoney London spot gold (122.XAU),
// windowed like the all-time seed, with the same 1.5% last-close
// consistency guard against the board's live Sina spot price.
async function fetchEastmoneyGoldPeak3y(
  referencePrice: number | null,
): Promise<PeakSeed | null> {
  const rows = await fetchEastmoneyKlines("122.XAU", eastmoneyBeg3y());
  if (!rows) return null;
  const last = rows[rows.length - 1];
  if (!last) return null;
  if (referencePrice == null || !(referencePrice > 0)) return null;
  if (Math.abs(last.close - referencePrice) / referencePrice > 0.015) {
    return null;
  }
  return windowPeak3y(rows);
}

// GOLD 3y seed (fallback): Stooq's XAU/USD spot daily CSV, windowed,
// same consistency guard as the all-time Stooq seed.
async function fetchStooqGoldPeak3y(
  referencePrice: number | null,
): Promise<PeakSeed | null> {
  try {
    const res = await fetch("https://stooq.com/q/d/l/?s=xauusd&i=d", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const rows: { date: string; close: number }[] = [];
    for (const line of text.split(/\r?\n/)) {
      const parts = line.split(",");
      const date = parts[0] ?? "";
      const close = Number(parts[4]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!Number.isFinite(close) || close <= 0) continue;
      rows.push({ date, close });
    }
    const last = rows[rows.length - 1];
    if (!last) return null;
    if (referencePrice == null || !(referencePrice > 0)) return null;
    if (Math.abs(last.close - referencePrice) / referencePrice > 0.015) {
      return null;
    }
    return windowPeak3y(rows);
  } catch {
    return null;
  }
}

// Computes the 3y peak to store alongside a fresh price: seed once
// while null; re-seed when the stored peak date has slid out of the
// trailing-3-year window ending at the new price's date (a failed
// re-seed keeps the stored value); otherwise ratchet up only.
async function resolvePeak3y(
  existing:
    | { peak3yPrice: number | null; peak3yDate: string | null }
    | undefined,
  price: number,
  asOf: string | null,
  timeZone: string,
  seed: () => Promise<PeakSeed | null>,
): Promise<{ peak3yPrice: number | null; peak3yDate: string | null }> {
  let peak3yPrice = existing?.peak3yPrice ?? null;
  let peak3yDate = existing?.peak3yDate ?? null;
  const latestDate =
    asOfDate(asOf, timeZone) ?? dateInTz(new Date(), timeZone);
  const missing = peak3yPrice == null || peak3yDate == null;
  const expired =
    !missing &&
    peak3yDate != null &&
    peak3yDate < yearsBefore(latestDate, 3);
  if (missing || expired) {
    const s = await seed();
    if (s) {
      peak3yPrice = s.price;
      peak3yDate = s.date;
    }
  }
  if (peak3yPrice != null && price > peak3yPrice) {
    peak3yPrice = price;
    peak3yDate = asOfDate(asOf, timeZone) ?? peak3yDate;
  }
  return { peak3yPrice, peak3yDate };
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
// overwritten. Accounts with no holdings (e.g. Broker B with nothing
// entered yet) record nothing.
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
      "Returns all accounts （券商A/券商B…) with their stored holdings, per-account cash and per-account daily history, plus the merged global view (same-symbol holdings combined across accounts, cash and history summed), the latest cached regular-close quotes, session-aware extended-hours annotations (pre-market / after-hours), the current US market session (America/New_York), the cached USD/CNY rate, and market benchmarks (S&P 500, Nasdaq-100, Nasdaq Composite, Shanghai Composite, CSI 300, CSI A500, Nikkei 225, Vietnam Ho Chi Minh Index, spot gold XAU/USD, Shanghai Gold Au99.99 in CNY/gram) — each benchmark carrying both its all-time highest close (peak_price/peak_date) and its trailing-3-year highest close (peak3y_price/peak3y_date).",
    request: z.object({}),
    response: portfolioResponse,
    handler: async (ctx): Promise<PortfolioResponse> => loadPortfolio(ctx),
  }),

  refreshQuotes: defineAction({
    description:
      "Refreshes regular-session quotes for the union of holding symbols across all accounts (finance channel, Nasdaq API fallback for BE), extended-hours annotations (Nasdaq pre-market feed while the pre session is live/just ended, Nasdaq after-hours feed in the post session; during the overnight session 20:00–04:00 ET the extended price comes from Yahoo Finance chart meta.fulldayPrice with ext_session \"overnight\" and ext_as_of set to the fetch moment — labeled 抓取于 in the UI — falling back per-symbol to the after-hours last trade when Yahoo yields nothing), and the live USD/CNY rate; seeds (once, from long history) and ratchets the all-time highest close (peak_price/peak_date) behind each market benchmark, and maintains the trailing-3-year highest close (peak3y_price/peak3y_date — seeded once from ~3 years of daily closes, ratcheted up, and re-seeded from the source series when the stored peak date slides out of the 3-year window) that the strip's 距高点 figure is computed from; records one daily snapshot per account; returns the refreshed portfolio.",
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
          // Overnight session: the extended price comes from Yahoo's
          // fulldayPrice (the only live overnight source) instead of
          // Nasdaq. Its asOf is the FETCH moment (fulldayPrice has no
          // trade timestamp) — the UI labels it 抓取于 accordingly.
          // A null result keeps the after-hours fallback below.
          let overnight: ExtendedQuote | null = null;
          if (session.key === "overnight") {
            const p = await fetchYahooOvernightPrice(h.quoteSymbol);
            if (p != null) {
              overnight = { price: p, asOf: now.toISOString() };
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
                  : session.key === "overnight" && overnight
                    ? { q: overnight, s: "overnight" as const }
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
            s: "pre" | "post" | "overnight";
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
          } else if (session.key === "overnight") {
            // Overnight: Yahoo fulldayPrice is the live price, measured
            // against the regular close. When Yahoo yields nothing for
            // this symbol, fall back to the after-hours last trade
            // (the previous behavior), timestamped as Nasdaq's own.
            if (overnight) {
              chosen = { q: overnight, s: "overnight", ref: regular.price };
            } else if (after) {
              chosen = { q: after, s: "post", ref: regular.price };
            }
          } else {
            // post / closed: after-hours is the latest extended session.
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

      // Market benchmarks, refreshed alongside the quotes. Existing
      // rows are read first so the peak can seed (once) / ratchet.
      const existingMarket = await db.select().from(schema.marketSnapshots);
      const existingMarketByKey = new Map(
        existingMarket.map((m) => [m.key, m]),
      );
      await Promise.all(
        BENCHMARKS.map(async (b) => {
          try {
            const bench = await fetchBenchmark(b);
            if (!bench) return;
            const peak = await resolvePeak(
              existingMarketByKey.get(b.key),
              bench.price,
              bench.asOf,
              b.tz,
              () => fetchYahooPeak(b.yahoo, b.tz),
            );
            const peak3y = await resolvePeak3y(
              existingMarketByKey.get(b.key),
              bench.price,
              bench.asOf,
              b.tz,
              () => fetchYahooPeak3y(b.yahoo, b.tz),
            );
            const values = {
              key: b.key,
              label: b.label,
              price: bench.price,
              change: bench.change,
              changePercent: bench.changePercent,
              asOf: bench.asOf,
              source: "Yahoo Finance",
              note: bench.note,
              peakPrice: peak.peakPrice,
              peakDate: peak.peakDate,
              peak3yPrice: peak3y.peak3yPrice,
              peak3yDate: peak3y.peak3yDate,
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

      // Eastmoney indices （上证 / 沪深300 / 中证A500 / 恒生科技 / 越南胡志明）:
      // price + day change from the last two daily closes, peak
      // seeded once from the same endpoint's full history.
      await Promise.all(
        EM_INDICES.map(async (b) => {
          try {
            const q = await fetchEastmoneyIndexQuote(b.secid);
            if (!q) return;
            const peak = await resolvePeak(
              existingMarketByKey.get(b.key),
              q.price,
              q.asOf,
              "Asia/Shanghai",
              () => fetchEastmoneyKlinePeak(b.secid),
            );
            const peak3y = await resolvePeak3y(
              existingMarketByKey.get(b.key),
              q.price,
              q.asOf,
              "Asia/Shanghai",
              () => fetchEastmoneyKlinePeak3y(b.secid),
            );
            const values = {
              key: b.key,
              label: b.label,
              price: q.price,
              change: q.change,
              changePercent: q.changePercent,
              asOf: q.asOf,
              source: "东方财富",
              note: b.note,
              peakPrice: peak.peakPrice,
              peakDate: peak.peakDate,
              peak3yPrice: peak3y.peak3yPrice,
              peak3yDate: peak3y.peak3yDate,
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

      // Gold: spot XAU/USD + Shanghai Gold (CNY per gram). Peaks seed
      // once (GOLD from Eastmoney's London-gold full-history K-line,
      // secid 122.XAU, with Stooq's XAU/USD spot CSV as fallback now
      // that Yahoo's XAUUSD=X is delisted — a failed or inconsistent
      // seed leaves it null, never a futures substitute; SGOLD from
      // the Eastmoney full-history K-line) and ratchet on every
      // refresh.
      try {
        const gold = await fetchGoldQuotes(effectiveFxRate);
        const goldPeak = gold.spot
          ? await resolvePeak(
              existingMarketByKey.get("GOLD"),
              gold.spot.price,
              gold.spot.asOf,
              "Asia/Shanghai",
              () =>
                fetchEastmoneyGoldPeak(gold.spot?.price ?? null).then(
                  (s) => s ?? fetchStooqGoldPeak(gold.spot?.price ?? null),
                ),
            )
          : null;
        const goldPeak3y = gold.spot
          ? await resolvePeak3y(
              existingMarketByKey.get("GOLD"),
              gold.spot.price,
              gold.spot.asOf,
              "Asia/Shanghai",
              () =>
                fetchEastmoneyGoldPeak3y(gold.spot?.price ?? null).then(
                  (s) => s ?? fetchStooqGoldPeak3y(gold.spot?.price ?? null),
                ),
            )
          : null;
        const sgoldPeak = gold.shanghai
          ? await resolvePeak(
              existingMarketByKey.get("SGOLD"),
              gold.shanghai.price,
              gold.shanghai.asOf,
              "Asia/Shanghai",
              fetchSgoldPeak,
            )
          : null;
        const sgoldPeak3y = gold.shanghai
          ? await resolvePeak3y(
              existingMarketByKey.get("SGOLD"),
              gold.shanghai.price,
              gold.shanghai.asOf,
              "Asia/Shanghai",
              () => fetchEastmoneyKlinePeak3y("118.Au9999"),
            )
          : null;
        const goldRows = [
          gold.spot && goldPeak
            ? {
                key: "GOLD",
                label: "现货黄金",
                price: gold.spot.price,
                change: gold.spot.change,
                changePercent: gold.spot.changePercent,
                asOf: gold.spot.asOf,
                source: gold.spot.source,
                note: "现货 XAU/USD · 美元/盎司",
                peakPrice: goldPeak.peakPrice,
                peakDate: goldPeak.peakDate,
                peak3yPrice: goldPeak3y?.peak3yPrice ?? null,
                peak3yDate: goldPeak3y?.peak3yDate ?? null,
                fetchedAt: now,
              }
            : null,
          gold.shanghai && sgoldPeak
            ? {
                key: "SGOLD",
                label: "上海黄金",
                price: gold.shanghai.price,
                change: gold.shanghai.change,
                changePercent: gold.shanghai.changePercent,
                asOf: gold.shanghai.asOf,
                source: gold.shanghai.source,
                note: gold.shanghai.note,
                peakPrice: sgoldPeak.peakPrice,
                peakDate: sgoldPeak.peakDate,
                peak3yPrice: sgoldPeak3y?.peak3yPrice ?? null,
                peak3yDate: sgoldPeak3y?.peak3yDate ?? null,
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
