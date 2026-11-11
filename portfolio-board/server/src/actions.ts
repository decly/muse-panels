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
// the overnight session, which Nasdaq does not cover) are stored in
// per-session slots (pre_* / post_* / overnight_* — plan B: each
// session's last saved value, written only by that session's
// refreshes; ext_* is the effective view of the current session's
// slot derived at read time, and after_* mirrors the post slot),
// shown as annotations and in a clearly-labeled live estimate next
// to the official total; they never enter the official totals or
// the daily snapshots. The overnight price carries no trade
// timestamp: its overnight_as_of is the fetch moment.
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
  // Per-session saved extended prices (plan B): each session's own
  // last value, never overwritten by another session's refresh.
  // ext_* above is the effective view for the CURRENT session,
  // derived server-side from these slots in loadPortfolio.
  pre_price: z.number().nullable(),
  pre_change_percent: z.number().nullable(),
  pre_as_of: z.string().nullable(),
  post_price: z.number().nullable(),
  post_change_percent: z.number().nullable(),
  post_as_of: z.string().nullable(),
  overnight_price: z.number().nullable(),
  overnight_change_percent: z.number().nullable(),
  overnight_as_of: z.string().nullable(),
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
  // The current session window's start/end as ISO instants, and the
  // same window formatted as "HH:MM–HH:MM" ranges in ET and Beijing
  // time (bare clock times; cross-midnight ends carry no 次日 marker).
  // Null when the market is closed (no current window). Computed from
  // the real instants, so the Beijing range shifts by an hour across
  // US DST changes automatically.
  start: z.string().nullable(),
  end: z.string().nullable(),
  rangeEt: z.string().nullable(),
  rangeBj: z.string().nullable(),
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

// ---------- Per-session extended-price slots (plan B) ----------

type ExtSlotName = "pre" | "post" | "overnight";
type ExtSlot = {
  price: number | null;
  pct: number | null;
  asOf: string | null;
};

function slotOf(
  s: typeof schema.quoteSnapshots.$inferSelect,
  slot: ExtSlotName,
): ExtSlot {
  if (slot === "pre") {
    return { price: s.prePrice, pct: s.preChangePercent, asOf: s.preAsOf };
  }
  if (slot === "overnight") {
    return {
      price: s.overnightPrice,
      pct: s.overnightChangePercent,
      asOf: s.overnightAsOf,
    };
  }
  // Post slot, with the legacy after_* mirror as its fallback (rows
  // written before migration 0010 seeded the slot from after_*).
  return {
    price: s.postPrice ?? s.afterPrice,
    pct: s.postChangePercent ?? s.afterChangePercent,
    asOf: s.postAsOf ?? s.afterAsOf,
  };
}

// ---------- Extended-slot staleness gate (2026-11-12) ----------
//
// A saved extended slot belongs to the extended cycle that follows
// ONE specific regular close — the close its percent was measured
// against. Once a newer regular close lands in the stored quote,
// every slot saved at or before that close is stale: its price and
// its percent both reference the previous close, and pairing it with
// the new close corrupts the live estimate (2026-11-12 incident: at
// the start of the Nov 11 post session the board still held Nov 10's
// post slots — post_as_of 2026-11-11T00:49Z against the Nov 11 close
// — and priced the estimate $1,087.25 / −2.23% below the official
// total while actual after-hours prices sat at the close). A slot
// therefore counts only when its as_of is LATER than the close
// instant of the regular quote it would be paired with; at or
// before that instant it is treated as absent, per holding, so the
// holding falls back to its close price with no extended badge or
// detail line — the same degradation as a missing slot. The gate
// lives here, in the one place loadPortfolio assembles the effective
// ext_* view, so the estimate, the row badges and the detail line
// all share it; the overnight chain inherits it too, because its
// after-hours fallback is the post slot checked the same way.

// Parse a stored timestamp to epoch ms. Stored stamps are UTC ISO
// strings, except Nasdaq-sourced regular quotes whose as_of is the
// feed's prose stamp ("Closed at Nov 11, 2026 4:00 PM ET") — that
// shape goes through parseNasdaqStamp (ET wall clock → UTC) first,
// because Date.parse would read it in the server's local zone.
function parseStampMs(value: string | null): number | null {
  if (!value) return null;
  const nasdaq = parseNasdaqStamp(value);
  if (nasdaq) {
    const t = Date.parse(nasdaq);
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function etDateOf(ms: number): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: g("year"), m: g("month"), d: g("day") };
}

// The close instant (16:00 ET) of the regular quote a slot would be
// paired with, or null when the stored quote carries no parseable
// timestamp (no boundary can be established; slots then behave as
// before rather than being discarded on a guess). Normally that is
// the close of the stored quote's own ET date — using the 16:00
// close itself, not the raw as_of, because the finance channel
// stamps a settled close a few minutes after 16:00 and an early
// extended trade must not be judged against that lag. During the
// regular session the stored quote is an intraday print of that
// same ET date, so the latest SETTLED close is the previous
// weekday's — without this exception the gate would discard this
// morning's pre-market slot (saved before the open, measured
// against that previous close) as soon as the first intraday print
// landed.
function extCloseBoundaryMs(
  s: typeof schema.quoteSnapshots.$inferSelect,
  sessionKey: string,
): number | null {
  const regMs = parseStampMs(s.asOf);
  if (regMs == null) return null;
  let { y, m, d } = etDateOf(regMs);
  if (sessionKey === "regular") {
    const today = etDateOf(Date.now());
    if (y === today.y && m === today.m && d === today.d) {
      // Step back to the most recent weekday (Mon–Fri).
      do {
        const prev = new Date(Date.UTC(y, m - 1, d - 1));
        y = prev.getUTCFullYear();
        m = prev.getUTCMonth() + 1;
        d = prev.getUTCDate();
      } while ([0, 6].includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay()));
    }
  }
  return etWallClockToInstant(y, m, d, 16, 0).getTime();
}

// A slot (or one of the legacy mirrors) is usable unless it is
// PROVEN stale: no boundary, or no parseable slot stamp, leaves it
// as-is; a parseable stamp must be strictly later than the close
// boundary (a stamp exactly at the close belongs to the close, not
// to the extended cycle after it).
function extFresh(asOf: string | null, boundaryMs: number | null): boolean {
  if (boundaryMs == null) return true;
  const t = parseStampMs(asOf);
  if (t == null) return true;
  return t > boundaryMs;
}

// The effective extended quote for display: the saved slot of the
// session the board is opened in (plan B — only that session's saved
// price shows; the regular session keeps the status quo, where the
// inline rows are hidden client-side and the detail/estimate keep
// this morning's pre-market slot). Every candidate — the session
// slots, their cross-slot fallbacks, and the legacy ext_*/after_*
// mirrors — passes the staleness gate above, so a slot left over
// from before the latest regular close never surfaces. Cross-slot
// fallbacks mirror the pre-plan-B behavior: pre-market with no pre
// data yet shows the after-hours last trade, overnight with no
// Yahoo price shows the after-hours last trade (labeled
// 夜盘最近可得价 in the detail) — in both cases only when that
// after-hours save is itself fresh against the latest close.
function effectiveExt(
  s: typeof schema.quoteSnapshots.$inferSelect,
  sessionKey: string,
): { price: number; pct: number | null; asOf: string | null; session: ExtSlotName } | null {
  const boundary = extCloseBoundaryMs(s, sessionKey);
  const pick = (
    slot: ExtSlotName,
  ): { price: number; pct: number | null; asOf: string | null; session: ExtSlotName } | null => {
    const v = slotOf(s, slot);
    if (v.price == null || !extFresh(v.asOf, boundary)) return null;
    return { price: v.price, pct: v.pct, asOf: v.asOf, session: slot };
  };
  let eff: ReturnType<typeof pick> = null;
  if (sessionKey === "pre") {
    eff = pick("pre") ?? pick("post");
  } else if (sessionKey === "overnight") {
    eff = pick("overnight") ?? pick("post");
  } else if (sessionKey === "regular") {
    eff = pick("pre") ?? pick("post");
  } else {
    // post / closed: the after-hours slot is the latest extended save.
    eff = pick("post") ?? pick("pre");
  }
  if (eff) return eff;
  if (s.extPrice != null && extFresh(s.extAsOf, boundary)) {
    const sess =
      s.extSession === "pre" || s.extSession === "overnight"
        ? s.extSession
        : "post";
    return {
      price: s.extPrice,
      pct: s.extChangePercent,
      asOf: s.extAsOf,
      session: sess as ExtSlotName,
    };
  }
  if (s.afterPrice != null && extFresh(s.afterAsOf, boundary)) {
    return {
      price: s.afterPrice,
      pct: s.afterChangePercent,
      asOf: s.afterAsOf,
      session: "post",
    };
  }
  return null;
}

function toHoldingOut(
  h: typeof schema.holdings.$inferSelect,
  bySymbol: Map<string, typeof schema.quoteSnapshots.$inferSelect>,
  sessionKey: string = "closed",
): HoldingOut {
  const s = bySymbol.get(h.quoteSymbol);
  const eff = s ? effectiveExt(s, sessionKey) : null;
  // The after_* mirror emitted below is the post slot's legacy twin;
  // it passes the same staleness gate, because the client falls back
  // to it when ext_* is null — an ungated mirror would resurrect
  // exactly the stale post price the gate just removed.
  const afterOk =
    s != null &&
    s.afterPrice != null &&
    extFresh(s.afterAsOf, extCloseBoundaryMs(s, sessionKey));
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
          after_price: afterOk ? s.afterPrice : null,
          after_change_percent: afterOk ? s.afterChangePercent : null,
          after_as_of: afterOk ? s.afterAsOf : null,
          ext_price: eff?.price ?? null,
          ext_change_percent: eff?.pct ?? null,
          ext_as_of: eff?.asOf ?? null,
          ext_session: eff?.session ?? null,
          pre_price: s.prePrice,
          pre_change_percent: s.preChangePercent,
          pre_as_of: s.preAsOf,
          post_price: s.postPrice ?? s.afterPrice,
          post_change_percent:
            s.postChangePercent ?? s.afterChangePercent,
          post_as_of: s.postAsOf ?? s.afterAsOf,
          overnight_price: s.overnightPrice,
          overnight_change_percent: s.overnightChangePercent,
          overnight_as_of: s.overnightAsOf,
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
// Convert an America/New_York wall-clock time (y/m/d + hh:mm) to the
// real instant it denotes. The UTC offset is derived from Intl at a
// first guess and refined once, which lands on the right side of DST
// transitions for the (non-transition-hour) session boundaries.
function etWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hh: number,
  mm: number,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hh, mm);
  let instant = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const shownAsUtc = Date.UTC(
      g("year"),
      g("month") - 1,
      g("day"),
      g("hour") % 24,
      g("minute"),
      g("second"),
    );
    const next = wallAsUtc - (shownAsUtc - instant);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

// Format one session window (real start/end instants) as an
// "HH:MM–HH:MM" range in the given timezone. Cross-midnight ends are
// shown as bare clock times (no 次日 marker, per user request).
function formatSessionRange(start: Date, end: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const fields = (d: Date) => {
    const p = fmt.formatToParts(d);
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return {
      day: `${g("year")}-${g("month")}-${g("day")}`,
      hm: `${g("hour")}:${g("minute")}`,
    };
  };
  const s = fields(start);
  const e = fields(end);
  return `${s.hm}–${e.hm}`;
}

type UsSession = {
  key: UsSessionKey;
  label: string;
  start: string | null;
  end: string | null;
  rangeEt: string | null;
  rangeBj: string | null;
};

function currentUsSession(at: Date = new Date()): UsSession {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  // ET wall-clock date n days from today (date fields only).
  const shiftDay = (n: number) => {
    const d = new Date(Date.UTC(year, month - 1, day + n));
    return {
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
    };
  };
  const atTime = (
    date: { y: number; m: number; d: number },
    hh: number,
    mm: number,
  ) => etWallClockToInstant(date.y, date.m, date.d, hh, mm);

  // Resolve the session key and its ET wall-clock window
  // ([startDayOffset, startHh, startMm] → [endDayOffset, endHh, endMm]).
  let key: UsSessionKey = "closed";
  let win: [number, number, number, number, number, number] | null = null;
  const eveningLeg =
    ["Sun", "Mon", "Tue", "Wed", "Thu"].includes(weekday) &&
    minutes >= 20 * 60;
  const morningLeg =
    ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday) &&
    minutes < 4 * 60;
  if (eveningLeg) {
    key = "overnight";
    win = [0, 20, 0, 1, 4, 0];
  } else if (morningLeg) {
    key = "overnight";
    win = [-1, 20, 0, 0, 4, 0];
  } else if (weekday !== "Sat" && weekday !== "Sun") {
    if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
      key = "pre";
      win = [0, 4, 0, 0, 9, 30];
    } else if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) {
      key = "regular";
      win = [0, 9, 30, 0, 16, 0];
    } else if (minutes >= 16 * 60 && minutes < 20 * 60) {
      key = "post";
      win = [0, 16, 0, 0, 20, 0];
    }
    // Friday 20:00–24:00 stays closed: no overnight into the weekend.
  }

  if (!win) {
    return {
      key,
      label: SESSION_LABELS[key],
      start: null,
      end: null,
      rangeEt: null,
      rangeBj: null,
    };
  }
  const [sd, sh, sm, ed, eh, em] = win;
  const start = atTime(shiftDay(sd), sh, sm);
  const end = atTime(shiftDay(ed), eh, em);
  return {
    key,
    label: SESSION_LABELS[key],
    start: start.toISOString(),
    end: end.toISOString(),
    rangeEt: formatSessionRange(start, end, "America/New_York"),
    rangeBj: formatSessionRange(start, end, "Asia/Shanghai"),
  };
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
  const session = currentUsSession();
  const allHoldings = rows.map((h) => toHoldingOut(h, bySymbol, session.key));
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
    session,
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
  type NasdaqDataBlock = {
    lastSalePrice?: string;
    netChange?: string;
    percentageChange?: string;
    lastTradeTimestamp?: string;
  };
  const json = (await res.json()) as {
    data?: {
      primaryData?: NasdaqDataBlock;
      secondaryData?: NasdaqDataBlock;
      marketStatus?: string;
      keyStats?: { fiftyTwoWeekHighLow?: { value?: string } };
    } | null;
  };
  const d = json.data;
  if (!d) return null;
  // During an extended session (Pre-Market / After-Hours) Nasdaq's
  // primaryData is the LIVE extended-hours trade, not the regular
  // close — verified live 2026-11-09 pre-market: primaryData
  // carried a real-time extended-hours print while secondaryData
  // carried the settled regular close. The regular
  // quote — this board's official basis — is secondaryData in
  // those sessions. Outside them primaryData is the regular quote
  // (live intraday, or the last close when the market is closed).
  const status = (d.marketStatus ?? "").toLowerCase();
  let p: NasdaqDataBlock | undefined = d.primaryData;
  if (
    (status === "pre-market" || status === "after-hours") &&
    d.secondaryData &&
    parseMoneyText(d.secondaryData.lastSalePrice) != null
  ) {
    p = d.secondaryData;
  }
  if (!p) return null;
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

// Wrong-instrument guard for regular-quote candidates, checked
// against the stored close. The band is deliberately wide — it
// detects a DIFFERENT security (a $7.63 quote for a $141 stock),
// not a big genuine move: outside the regular session a candidate
// must be the settled close itself (a one-session catch-up after
// a missed refresh still lands well inside the band); during the
// regular session the candidate's implied previous close
// (price − change) must match the stored close the same way.
function regularQuotePlausible(
  q: RegularQuote,
  cachedPrice: number | null,
  sessionKey: string,
): boolean {
  if (cachedPrice == null || !(cachedPrice > 0)) return true;
  const inBand = (v: number) => {
    if (!(v > 0)) return false;
    const r = v / cachedPrice;
    return r >= 0.4 && r <= 2.5;
  };
  if (sessionKey === "regular" && q.change != null) {
    const impliedPrev = q.price - q.change;
    if (impliedPrev > 0) return inBand(impliedPrev);
  }
  return inBand(q.price);
}

type ExtendedQuote = { price: number; asOf: string | null };

// Nasdaq's lastUpdateInfo stamp is page copy, not a clean timestamp:
// "Data last updated Nov 9, 2026 5:45 AM ET. This page refreshes
// every 30 seconds." Extract just the ET wall-clock stamp and store
// it as a UTC ISO instant, so the UI renders a bare numeric time for
// pre/post exactly like the overnight fetch stamp. Anything that
// does not parse is dropped (null) rather than stored as prose.
const ET_MONTHS: Record<string, number> = {
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

// Offset (ms) of an IANA timezone at an instant: the zone's wall
// clock read as UTC, minus the instant itself.
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

// America/New_York wall-clock time → the UTC instant it names (the
// offset is resolved at the instant itself, so DST is handled).
function etWallToUtc(
  year: number,
  monthIdx: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const wallAsUtc = Date.UTC(year, monthIdx, day, hour, minute);
  const utc = wallAsUtc - tzOffsetMs(new Date(wallAsUtc), "America/New_York");
  const refined = wallAsUtc - tzOffsetMs(new Date(utc), "America/New_York");
  return new Date(refined);
}

function parseNasdaqStamp(raw: string): string | null {
  const m = raw.match(
    /([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AaPp])[Mm]/,
  );
  if (!m) return null;
  const month = ET_MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
  if (month == null) return null;
  let hour = Number(m[4]) % 12;
  if ((m[6] ?? "").toLowerCase() === "p") hour += 12;
  return etWallToUtc(
    Number(m[3]),
    month,
    Number(m[2]),
    hour,
    Number(m[5]),
  ).toISOString();
}

// Nasdaq extended-trading feed, parameterized by session: markettype
// "pre" (04:00–09:30 ET) and "post" (16:00–20:00 ET) share one shape —
// infoTable.rows[0].consolidated is "<price> <chg> (<pct>)" for the
// session's last trade and a "Data last updated …" entry inside
// lastUpdateInfo its update stamp (both verified live 2026-11-08;
// the stamp's position in that array varies by session — see below).
// Outside its session the pre feed returns
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
  // lastUpdateInfo mixes the "Data last updated <stamp>" entry with
  // page copy ("This page refreshes every 30 seconds."), and which
  // slot the stamp sits in varies by session — during a live
  // pre-market it is second, after hours it is first. Take the first
  // entry that actually carries a parseable stamp.
  let asOf: string | null = null;
  for (const info of d.lastUpdateInfo ?? []) {
    asOf = parseNasdaqStamp(info);
    if (asOf) break;
  }
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
    dayChangePct: 3.04,
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

// ---------- Snapshot recalculation after backfilled trades ----------
//
// A daily snapshot row is computed once, at the refresh that first
// records that trading day. When the user afterwards backfills a
// trade for that day (addHolding / updateHolding / removeHolding /
// updateCash), the stored row would otherwise stay at its pre-trade
// values — and the history board's daily sync, which treats this
// board's snapshots as authoritative, would propagate the stale row
// over the corrected one. Recalculation closes that gap: it rebuilds
// one account's snapshot row for one trading day from the CURRENT
// holdings and cash, priced at that day's regular-session close.
//
// Price basis (red line, unchanged): only quote_snapshots.price —
// the stored regular-session close — is ever used. Extended-hours
// prices (pre_* / post_* / overnight_* slots, ext_* view, after_*)
// never enter a snapshot. quote_snapshots holds only the latest
// close per symbol, so a recalculation is exact while the stored
// close still belongs to the target day — which is precisely the
// trigger scope below (the account's LATEST snapshot day, edited
// shortly after that session). Recalculating an older day after
// quotes have rolled to a newer close is out of scope by design.
//
// Fallback for a missing close: if any current holding has no stored
// regular price, the recalculation FAILS without writing — the
// existing snapshot row stays as the fallback record rather than a
// partial or extended-price figure being invented for the missing
// symbol. The caller's holdings/cash edit still stands (see
// tryRecalcLatestSnapshot).
//
// Field口径:
//  - securities = Σ qty × regular close; total P/L = securities −
//    Σ qty × cost (current costs).
//  - cash = the account's CURRENT stored cash balance (so a
//    backfilled trade's updateCash lands in the snapshot); when the
//    account has no cash row, the snapshot row's own cash is kept.
//  - account value = securities + cash; CNY = value × the row's
//    stored fx_rate (kept, never re-fetched here).
//  - day change = account value − the PREVIOUS trading day's
//    snapshot total for the same account (and its %); the first
//    recorded day has no previous row, so its stored day change
//    (the seed口径) is preserved.
//  - spx/ndx closes and the row's source label are preserved as
//    stored: a recalculated "refresh" row stays "refresh", and
//    source="manual" rows are NEVER recalculated (same
//    protection as recordDailySnapshot / the history board).

const snapshotRecalcSchema = z.object({
  status: z.enum([
    "updated",
    "skipped_no_snapshot",
    "skipped_protected",
    "failed",
  ]),
  date: z.string().nullable(),
  reason: z.string().nullable(),
  account_value_usd: z.number().nullable(),
  securities_value_usd: z.number().nullable(),
  cash_usd: z.number().nullable(),
  total_pnl_usd: z.number().nullable(),
  day_change_usd: z.number().nullable(),
  day_change_pct: z.number().nullable(),
});

type SnapshotRecalc = z.infer<typeof snapshotRecalcSchema>;

function recalcMiss(
  status: SnapshotRecalc["status"],
  date: string | null,
  reason: string | null,
): SnapshotRecalc {
  return {
    status,
    date,
    reason,
    account_value_usd: null,
    securities_value_usd: null,
    cash_usd: null,
    total_pnl_usd: null,
    day_change_usd: null,
    day_change_pct: null,
  };
}

async function recalcSnapshotRow(
  ctx: Ctx,
  accountId: string,
  targetDate?: string,
): Promise<SnapshotRecalc> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.dailySnapshots)
    .where(eq(schema.dailySnapshots.accountId, accountId));
  const target = targetDate
    ? rows.find((r) => r.date === targetDate)
    : rows
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  if (!target) {
    return recalcMiss(
      "skipped_no_snapshot",
      targetDate ?? null,
      "account has no snapshot row to recalculate",
    );
  }
  if (target.source === "manual") {
    return recalcMiss(
      "skipped_protected",
      target.date,
      "manual-sourced snapshot rows are never recalculated",
    );
  }
  const holdingRows = await db
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.accountId, accountId));
  const quoteRows = await db.select().from(schema.quoteSnapshots);
  const bySymbol = new Map(quoteRows.map((q) => [q.quoteSymbol, q]));
  const missing: string[] = [];
  let totalMv = 0;
  let totalCost = 0;
  for (const h of holdingRows) {
    const price = bySymbol.get(h.quoteSymbol)?.price ?? null;
    if (price == null || !(price > 0)) {
      missing.push(h.symbol);
      continue;
    }
    totalMv += price * h.qty;
    totalCost += h.costPerShare * h.qty;
  }
  if (missing.length > 0) {
    return recalcMiss(
      "failed",
      target.date,
      `missing_regular_quote:${missing.join(",")}`,
    );
  }
  const cashRows = await db
    .select()
    .from(schema.accountBalances)
    .where(eq(schema.accountBalances.accountId, accountId));
  const cashUsd = cashRows[0]?.cashUsd ?? target.cashUsd;
  const accountValue = totalMv + cashUsd;
  const totalPnl = totalMv - totalCost;
  const prev = rows
    .filter((r) => r.date < target.date)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  const dayChangeUsd = prev
    ? accountValue - prev.accountValueUsd
    : target.dayChangeUsd;
  const dayChangePct =
    prev && prev.accountValueUsd > 0 && dayChangeUsd != null
      ? (dayChangeUsd / prev.accountValueUsd) * 100
      : prev
        ? null
        : target.dayChangePct;
  const fxRate = target.fxRate;
  await db
    .update(schema.dailySnapshots)
    .set({
      accountValueUsd: accountValue,
      securitiesValueUsd: totalMv,
      cashUsd,
      totalPnlUsd: totalPnl,
      dayChangeUsd,
      dayChangePct,
      accountValueCny: fxRate != null ? accountValue * fxRate : target.accountValueCny,
    })
    .where(
      and(
        eq(schema.dailySnapshots.date, target.date),
        eq(schema.dailySnapshots.accountId, accountId),
      ),
    );
  return {
    status: "updated",
    date: target.date,
    reason: null,
    account_value_usd: accountValue,
    securities_value_usd: totalMv,
    cash_usd: cashUsd,
    total_pnl_usd: totalPnl,
    day_change_usd: dayChangeUsd,
    day_change_pct: dayChangePct,
  };
}

// Trigger-path wrapper: a failed recalculation must never roll back
// or mask the holdings/cash edit that triggered it, so every error
// is folded into the returned status instead of throwing.
async function tryRecalcSnapshot(
  ctx: Ctx,
  accountId: string,
  targetDate?: string,
): Promise<SnapshotRecalc> {
  try {
    const result = await recalcSnapshotRow(ctx, accountId, targetDate);
    if (result.status === "updated") ctx.invalidateQueries();
    return result;
  } catch (e) {
    return recalcMiss(
      "failed",
      targetDate ?? null,
      (e instanceof Error ? e.message : String(e)).slice(0, 200),
    );
  }
}

// ---------- Actions ----------

const refreshResponse = z.object({
  updated: z.number(),
  failed: z.array(z.string()),
  fx_updated: z.boolean(),
  portfolio: portfolioResponse,
});

const extendedRefreshResponse = z.object({
  updated: z.number(),
  // True when the current US session is regular/closed and the run
  // deliberately wrote nothing.
  skipped: z.boolean(),
  session: z.string(),
  portfolio: portfolioResponse,
});

// ---------- Trade ledger （交易流水台账） ----------
//
// Pure record of the user's trades, per account. The ledger never
// feeds holdings, quotes, totals or daily snapshots — it exists so
// backfilled trades can be replayed exactly and realized P/L on sells
// can be computed. Entries arrive from order fill records (source
// "order"), whole-account snapshot diffs (source "snapshot_diff"),
// the opening initialization (source "opening": side "buy" at the
// broker cost price first recorded) or manual entry ("manual").

const tradeSide = z.enum(["buy", "sell"]);
const tradePriceKind = z.enum(["actual", "estimated", "none"]);
const tradeSource = z.enum(["order", "snapshot_diff", "opening", "manual"]);

const tradeRowResponse = z.object({
  id: z.number(),
  account_id: z.string(),
  account_name: z.string(),
  // Trade date, YYYY-MM-DD.
  date: z.string(),
  symbol: z.string(),
  side: tradeSide,
  qty: z.number(),
  price: z.number().nullable(),
  price_kind: tradePriceKind,
  source: tradeSource,
  note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

type TradeRowResponse = z.infer<typeof tradeRowResponse>;

const realizedSymbolSchema = z.object({
  symbol: z.string(),
  // Null when the symbol's realized P/L is unknown (a sell price was
  // unknown, or the cost basis at that point was unknown) — unknown
  // is reported as unknown, never as 0.
  realized_usd: z.number().nullable(),
  // True when at least one valued sell used an estimated price.
  has_estimated: z.boolean(),
});

const realizedSummarySchema = z.object({
  // Sum over the valued symbols. Null when any symbol's realized
  // P/L is unknown (has_unknown); with no sells at all it is 0.
  total_usd: z.number().nullable(),
  has_estimated: z.boolean(),
  has_unknown: z.boolean(),
  by_symbol: z.array(realizedSymbolSchema),
});

const realizedAccountSchema = realizedSummarySchema.extend({
  account_id: z.string(),
});

type RealizedSummary = z.infer<typeof realizedSummarySchema>;

const tradesResponse = z.object({
  trades: z.array(tradeRowResponse),
  realized: z.object({
    global: realizedSummarySchema,
    accounts: z.array(realizedAccountSchema),
  }),
});

type TradesResponse = z.infer<typeof tradesResponse>;

const tradeOkResponse = z.object({ ok: z.literal(true) });

// price / price_kind consistency: an empty price is only consistent
// with price_kind "none"; a present price must be "actual" or
// "estimated" (defaulting to "actual" when the caller omits it).
function normalizeTradePrice(
  action: string,
  price: number | null | undefined,
  priceKind: "actual" | "estimated" | "none" | undefined,
): { price: number | null; priceKind: "actual" | "estimated" | "none" } {
  if (price == null) {
    if (priceKind != null && priceKind !== "none") {
      throw new Error(
        `${action}: price_kind must be "none" when price is empty`,
      );
    }
    return { price: null, priceKind: "none" };
  }
  const kind = priceKind ?? "actual";
  if (kind === "none") {
    throw new Error(
      `${action}: price_kind "none" requires an empty price`,
    );
  }
  return { price, priceKind: kind };
}

function assertTradeDate(action: string, date: string): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) {
    throw new Error(`${action}: date must be YYYY-MM-DD, got "${date}"`);
  }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3])
  ) {
    throw new Error(`${action}: date "${date}" is not a real calendar date`);
  }
}

async function requireTradeAccount(ctx: Ctx, accountId: string): Promise<void> {
  await ensureAccounts(ctx);
  const db = ctx.db<typeof schema>();
  const known = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  if (known.length === 0) {
    throw new Error(`unknown account "${accountId}"`);
  }
}

function toTradeRow(
  t: typeof schema.trades.$inferSelect,
  accountName: string,
): TradeRowResponse {
  return {
    id: t.id,
    account_id: t.accountId,
    account_name: accountName,
    date: t.date,
    symbol: t.symbol,
    side: t.side,
    qty: t.qty,
    price: t.price,
    price_kind: t.priceKind,
    source: t.source,
    note: t.note,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  };
}

// Realized P/L replay for one (account, symbol) position, entries in
// ascending date order: buys/opening entries fold into a weighted
// average cost; a sell realizes qty × (sell price − average cost at
// that moment). A sell whose price is unknown (price_kind "none") or
// whose cost basis is unknown at that point (an earlier buy carried
// no price, or the sell exceeds the recorded position) makes the
// symbol's realized P/L unknown (null) rather than 0; a sell valued
// with an estimated price counts but flags has_estimated.
type RealizedAcc = {
  qty: number;
  costSum: number;
  costKnown: boolean;
  realized: number;
  unknown: boolean;
  hasEstimated: boolean;
  hasSell: boolean;
};

function replayRealized(
  entries: (typeof schema.trades.$inferSelect)[],
): RealizedAcc {
  const acc: RealizedAcc = {
    qty: 0,
    costSum: 0,
    costKnown: true,
    realized: 0,
    unknown: false,
    hasEstimated: false,
    hasSell: false,
  };
  const EPS = 1e-9;
  for (const t of entries) {
    if (t.side === "buy") {
      if (t.price == null) {
        // Shares acquired at an unknown price: any existing known
        // cost can no longer describe the blended position.
        if (acc.qty + t.qty > EPS) acc.costKnown = false;
      } else if (acc.costKnown) {
        acc.costSum += t.qty * t.price;
      } else if (acc.qty <= EPS) {
        acc.costSum = t.qty * t.price;
        acc.costKnown = true;
      }
      // (cost unknown + shares held + priced buy: stays unknown)
      acc.qty += t.qty;
      continue;
    }
    // sell
    acc.hasSell = true;
    const covered = Math.min(t.qty, Math.max(acc.qty, 0));
    if (t.price == null || !acc.costKnown || covered < t.qty - EPS) {
      acc.unknown = true;
    } else if (covered > EPS) {
      const avgCost = acc.costSum / acc.qty;
      acc.realized += covered * (t.price - avgCost);
      if (t.priceKind === "estimated") acc.hasEstimated = true;
    }
    if (acc.qty > EPS && covered > 0) {
      const avgCost = acc.costSum / acc.qty;
      acc.costSum -= avgCost * covered;
      acc.qty -= covered;
      if (acc.qty <= EPS) {
        acc.qty = 0;
        acc.costSum = 0;
        acc.costKnown = true;
      }
    } else if (covered > 0) {
      acc.qty = Math.max(0, acc.qty - covered);
    }
  }
  return acc;
}

function summarizeRealized(
  accs: Map<string, RealizedAcc>,
): RealizedSummary {
  const by_symbol: RealizedSummary["by_symbol"] = [];
  let total = 0;
  let hasUnknown = false;
  let hasEstimated = false;
  for (const symbol of [...accs.keys()].sort(cmpStr)) {
    const acc = accs.get(symbol);
    if (!acc || !acc.hasSell) continue;
    by_symbol.push({
      symbol,
      realized_usd: acc.unknown ? null : acc.realized,
      has_estimated: acc.hasEstimated,
    });
    if (acc.unknown) hasUnknown = true;
    else total += acc.realized;
    if (acc.hasEstimated) hasEstimated = true;
  }
  return {
    total_usd: hasUnknown ? null : total,
    has_estimated: hasEstimated,
    has_unknown: hasUnknown,
    by_symbol,
  };
}

// Loads every trade, returns the list (newest first, optionally
// filtered to one account) plus realized-P/L summaries computed by
// replaying each (account, symbol) position in date order — one
// summary per account and one merged global summary.
async function loadTrades(
  ctx: Ctx,
  accountId?: string,
): Promise<TradesResponse> {
  const db = ctx.db<typeof schema>();
  await ensureAccounts(ctx);
  const [rows, accountRows] = await Promise.all([
    db.select().from(schema.trades),
    db.select().from(schema.accounts),
  ]);
  const nameById = new Map(accountRows.map((a) => [a.id, a.name]));
  const ascending = [...rows].sort(
    (x, y) => cmpStr(x.date, y.date) || x.id - y.id,
  );
  // Replay per (account, symbol).
  const perAccount = new Map<string, Map<string, RealizedAcc>>();
  const grouped = new Map<string, (typeof rows)[number][]>();
  for (const t of ascending) {
    const key = `${t.accountId} ${t.symbol}`;
    const list = grouped.get(key);
    if (list) list.push(t);
    else grouped.set(key, [t]);
  }
  for (const [key, entries] of grouped) {
    const sep = key.indexOf(" ");
    const accId = key.slice(0, sep);
    const symbol = key.slice(sep + 1);
    let bySymbol = perAccount.get(accId);
    if (!bySymbol) {
      bySymbol = new Map();
      perAccount.set(accId, bySymbol);
    }
    bySymbol.set(symbol, replayRealized(entries));
  }
  // Global summary merges the per-account accumulators by symbol.
  const globalAccs = new Map<string, RealizedAcc>();
  for (const bySymbol of perAccount.values()) {
    for (const [symbol, acc] of bySymbol) {
      const g = globalAccs.get(symbol);
      if (!g) {
        globalAccs.set(symbol, { ...acc });
      } else {
        g.hasSell = g.hasSell || acc.hasSell;
        g.realized += acc.realized;
        g.unknown = g.unknown || acc.unknown;
        g.hasEstimated = g.hasEstimated || acc.hasEstimated;
      }
    }
  }
  const accountsSummary = accountRows
    .map((a) => a.id)
    .sort(cmpStr)
    .map((id) => ({
      account_id: id,
      ...summarizeRealized(perAccount.get(id) ?? new Map()),
    }));
  const list = rows
    .filter((t) => !accountId || t.accountId === accountId)
    .sort((x, y) => cmpStr(y.date, x.date) || y.id - x.id)
    .map((t) => toTradeRow(t, nameById.get(t.accountId) ?? t.accountId));
  return {
    trades: list,
    realized: {
      global: summarizeRealized(globalAccs),
      accounts: accountsSummary,
    },
  };
}

// ---------- Personal-data export / import (stateless data actions) ----------
//
// The user's own data is exactly five tables: accounts, holdings,
// account_balances, daily_snapshots, trades. The three market caches
// (quote_snapshots, market_snapshots, fx_snapshots) are NEVER part of
// an export — every value in them can be re-fetched from market
// sources. The fx_rate / spx_price / ndx_price values stored INSIDE a
// daily_snapshots row are part of that personal history record and
// travel with the row. These actions are deliberately stateless with
// respect to any repository or backup pipeline: export returns the
// payload, import consumes one; nothing here knows about git.
//
// Format history: v1 was {board: "portfolio", tables: name -> rows[]}.
// v2 (current export) is a self-describing dataset envelope:
// {panel: "portfolio-board", tables: name -> {primary_key, rows}}.
// Import accepts both; see the v2 notes below. The trades table
// joined the personal set in 2026-11; backups written before that
// (v1 files, and v2 files whose tables carry only the original four)
// must keep importing — see the checksum note at v2Checksum.

const personalAccountRow = z.object({
  id: z.string(),
  name: z.string(),
  sort: z.number(),
});

const personalHoldingRow = z.object({
  account_id: z.string(),
  symbol: z.string(),
  quote_symbol: z.string(),
  name: z.string(),
  qty: z.number(),
  cost_per_share: z.number(),
  kind: z.enum(["stock", "etf"]),
  theme: z.string(),
});

const personalBalanceRow = z.object({
  account_id: z.string(),
  cash_usd: z.number(),
  snapshot_label: z.string(),
  // ISO timestamp of the stored row; null only for hand-written files.
  updated_at: z.string().nullable(),
});

const personalSnapshotRow = z.object({
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

const personalTradeRow = z.object({
  id: z.number(),
  account_id: z.string(),
  date: z.string(),
  symbol: z.string(),
  side: tradeSide,
  qty: z.number(),
  price: z.number().nullable(),
  price_kind: tradePriceKind,
  source: tradeSource,
  note: z.string().nullable(),
  // ISO timestamps of the stored row, mirroring the account_balances
  // updated_at precedent.
  created_at: z.string(),
  updated_at: z.string(),
});

const personalTables = z.object({
  accounts: z.array(personalAccountRow),
  holdings: z.array(personalHoldingRow),
  account_balances: z.array(personalBalanceRow),
  daily_snapshots: z.array(personalSnapshotRow),
});

// The four original tables are always present; `trades` is present
// only when the payload (or a fresh export) carries the trades table.
// Pre-ledger backups (v1 files, and v2 files with only the four
// tables) normalize to trades === undefined, which keeps their
// canonical form — and therefore their checksum — byte-identical to
// what the pre-ledger exporter produced, and tells the importer to
// leave the live trades table completely untouched.
type PersonalTables = z.infer<typeof personalTables> & {
  trades?: z.infer<typeof personalTradeRow>[];
};

// --- v2 self-describing dataset envelope (industry-standard shape) ---
// Each table carries its own primary_key declaration alongside its
// rows, so generic tooling can validate, sort and merge without
// hard-coding this panel's keys. Additive evolution rule: unknown
// fields (top level, per-table envelope, or per-row) are IGNORED and
// unknown tables are SKIPPED (and reported in the import summary) —
// neither fails the import. Only a format mismatch, a version newer
// than the importer understands, or a checksum mismatch rejects the
// whole file.
const TABLE_PRIMARY_KEYS = {
  accounts: ["id"],
  holdings: ["account_id", "symbol"],
  account_balances: ["account_id"],
  daily_snapshots: ["date", "account_id"],
  trades: ["id"],
} as const;

// Tables a v2 payload may carry. "trades" is known but OPTIONAL: a
// v2 file written before the trade ledger existed carries only the
// original four and is still a valid, importable backup.
const KNOWN_TABLE_NAMES: readonly string[] = [
  "accounts",
  "holdings",
  "account_balances",
  "daily_snapshots",
  "trades",
];

// In a v1 payload the trades table does not exist as a concept; a
// stray "trades" key there counts as an unknown table.
const KNOWN_TABLE_NAMES_V1: readonly string[] = [
  "accounts",
  "holdings",
  "account_balances",
  "daily_snapshots",
];

function tableEnvelope<Row extends z.ZodType>(row: Row) {
  return z.looseObject({
    primary_key: z.array(z.string()),
    rows: z.array(row),
  });
}

// Export envelope: always carries all five tables (trades included,
// possibly empty).
const personalTablesV2 = z.looseObject({
  accounts: tableEnvelope(personalAccountRow),
  holdings: tableEnvelope(personalHoldingRow),
  account_balances: tableEnvelope(personalBalanceRow),
  daily_snapshots: tableEnvelope(personalSnapshotRow),
  trades: tableEnvelope(personalTradeRow),
});

type PersonalTablesV2 = z.infer<typeof personalTablesV2>;

// Import envelope: identical, except trades is optional so pre-ledger
// v2 backups still validate.
const personalTablesV2Import = z.looseObject({
  accounts: tableEnvelope(personalAccountRow),
  holdings: tableEnvelope(personalHoldingRow),
  account_balances: tableEnvelope(personalBalanceRow),
  daily_snapshots: tableEnvelope(personalSnapshotRow),
  trades: tableEnvelope(personalTradeRow).optional(),
});

type PersonalTablesV2Import = z.infer<typeof personalTablesV2Import>;

// v1 file shape: tables map table name -> bare row array, panel
// identified by `board: "portfolio"`. Still accepted on import and
// normalized to the v2 envelope shape before the restore/merge flow.
const personalTablesV1 = z.looseObject({
  accounts: z.array(personalAccountRow),
  holdings: z.array(personalHoldingRow),
  account_balances: z.array(personalBalanceRow),
  daily_snapshots: z.array(personalSnapshotRow),
});

const personalDataFileV1 = z.looseObject({
  format: z.literal("muse-personal-data"),
  version: z.literal(1),
  board: z.literal("portfolio"),
  exported_at: z.string().optional(),
  checksum: z.string().optional(),
  tables: personalTablesV1,
});

const personalDataFileV2 = z.looseObject({
  format: z.literal("muse-personal-data"),
  version: z.literal(2),
  panel: z.literal("portfolio-board"),
  exported_at: z.string().optional(),
  checksum: z.string().optional(),
  tables: personalTablesV2Import,
});

// Union of every format version this importer understands. A version
// greater than 2 (or a different format / panel) matches neither arm
// and is rejected wholesale by request validation — nothing written.
const personalDataFile = z.union([personalDataFileV2, personalDataFileV1]);

const personalExportResponse = z.object({
  format: z.literal("muse-personal-data"),
  version: z.literal(2),
  panel: z.literal("portfolio-board"),
  exported_at: z.string(),
  // Content checksum over the canonical serialization of `tables`
  // only (exported_at excluded), so two exports of the same state
  // compare equal byte-for-byte apart from the timestamp.
  checksum: z.string(),
  tables: personalTablesV2,
});

type PersonalExportResponse = z.infer<typeof personalExportResponse>;

// Deterministic 128-bit string hash (cyrb128) rendered as hex. Used
// only as a content checksum for comparing exports, not for security.
function contentChecksum(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    h4 = Math.imul(h4 ^ ch, 668265263);
    h3 = Math.imul(h3 ^ ch, 2246822519);
    h4 = Math.imul(h4 ^ (h4 >>> 21), 2654435761);
    h3 = Math.imul(h3 ^ (h3 >>> 24), 1597334677);
    h3 ^= Math.imul(h4 ^ (h4 >>> 15), 3266489909);
    h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507);
    h4 ^= Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  }
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507);
  h3 ^= Math.imul(h4 ^ (h4 >>> 13), 3266489909);
  h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507);
  h4 ^= Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h2) + hex(h1) + hex(h4) + hex(h3);
}

const cmpStr = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

// Reads the five personal tables and serializes them canonically:
// rows sorted by natural key, fields in a fixed order, so the same
// database state always produces the same payload (and checksum).
// Exports always carry trades (possibly an empty array).
async function buildPersonalTables(ctx: Ctx): Promise<PersonalTables> {
  const db = ctx.db<typeof schema>();
  const [accountRows, holdingRows, balanceRows, snapshotRows, tradeRows] =
    await Promise.all([
      db.select().from(schema.accounts),
      db.select().from(schema.holdings),
      db.select().from(schema.accountBalances),
      db.select().from(schema.dailySnapshots),
      db.select().from(schema.trades),
    ]);
  const accounts = accountRows
    .map((a) => ({ id: a.id, name: a.name, sort: a.sort }))
    .sort((x, y) => x.sort - y.sort || cmpStr(x.id, y.id));
  const holdings = holdingRows
    .map((h) => ({
      account_id: h.accountId,
      symbol: h.symbol,
      quote_symbol: h.quoteSymbol,
      name: h.name,
      qty: h.qty,
      cost_per_share: h.costPerShare,
      kind: h.kind,
      theme: h.theme,
    }))
    .sort(
      (x, y) =>
        cmpStr(x.account_id, y.account_id) || cmpStr(x.symbol, y.symbol),
    );
  const account_balances = balanceRows
    .map((b) => ({
      account_id: b.accountId,
      cash_usd: b.cashUsd,
      snapshot_label: b.snapshotLabel,
      updated_at: b.updatedAt.toISOString(),
    }))
    .sort((x, y) => cmpStr(x.account_id, y.account_id));
  const daily_snapshots = snapshotRows
    .map((s) => ({
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
    }))
    .sort(
      (x, y) => cmpStr(x.date, y.date) || cmpStr(x.account_id, y.account_id),
    );
  const trades = tradeRows
    .map((t) => ({
      id: t.id,
      account_id: t.accountId,
      date: t.date,
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      price: t.price,
      price_kind: t.priceKind,
      source: t.source,
      note: t.note,
      created_at: t.createdAt.toISOString(),
      updated_at: t.updatedAt.toISOString(),
    }))
    .sort((x, y) => x.id - y.id);
  return { accounts, holdings, account_balances, daily_snapshots, trades };
}

// Canonical form of a tables payload: rows rebuilt with the fixed
// field order and sorted by each table's primary key. Both checksum
// flavors are computed over canonical forms, so key order / row order
// differences in a hand-carried file never cause a false mismatch,
// and unknown fields/tables (already stripped or ignored before this
// point) never enter the checksum. The trades key is carried ONLY
// when the payload carries the trades table: a pre-ledger payload
// canonicalizes to exactly its historical four-table form, so its
// checksum still verifies (see v2Checksum).
function canonicalizeTables(t: PersonalTables): PersonalTables {
  const base: PersonalTables = {
    accounts: t.accounts
      .map((a) => ({ id: a.id, name: a.name, sort: a.sort }))
      .sort((x, y) => x.sort - y.sort || cmpStr(x.id, y.id)),
    holdings: t.holdings
      .map((h) => ({
        account_id: h.account_id,
        symbol: h.symbol,
        quote_symbol: h.quote_symbol,
        name: h.name,
        qty: h.qty,
        cost_per_share: h.cost_per_share,
        kind: h.kind,
        theme: h.theme,
      }))
      .sort(
        (x, y) =>
          cmpStr(x.account_id, y.account_id) || cmpStr(x.symbol, y.symbol),
      ),
    account_balances: t.account_balances
      .map((b) => ({
        account_id: b.account_id,
        cash_usd: b.cash_usd,
        snapshot_label: b.snapshot_label,
        updated_at: b.updated_at,
      }))
      .sort((x, y) => cmpStr(x.account_id, y.account_id)),
    daily_snapshots: t.daily_snapshots
      .map((s) => ({
        date: s.date,
        account_id: s.account_id,
        account_value_usd: s.account_value_usd,
        securities_value_usd: s.securities_value_usd,
        cash_usd: s.cash_usd,
        total_pnl_usd: s.total_pnl_usd,
        day_change_usd: s.day_change_usd,
        day_change_pct: s.day_change_pct,
        fx_rate: s.fx_rate,
        account_value_cny: s.account_value_cny,
        spx_price: s.spx_price,
        ndx_price: s.ndx_price,
        source: s.source,
      }))
      .sort(
        (x, y) => cmpStr(x.date, y.date) || cmpStr(x.account_id, y.account_id),
      ),
  };
  if (t.trades) {
    base.trades = t.trades
      .map((r) => ({
        id: r.id,
        account_id: r.account_id,
        date: r.date,
        symbol: r.symbol,
        side: r.side,
        qty: r.qty,
        price: r.price,
        price_kind: r.price_kind,
        source: r.source,
        note: r.note,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
      .sort((x, y) => x.id - y.id);
  }
  return base;
}

// Wraps canonical tables in the v2 envelope: every table declares its
// own primary_key next to its rows. Exports always include trades.
function buildTablesEnvelope(t: PersonalTables): PersonalTablesV2 {
  const c = canonicalizeTables(t);
  return {
    accounts: {
      primary_key: [...TABLE_PRIMARY_KEYS.accounts],
      rows: c.accounts,
    },
    holdings: {
      primary_key: [...TABLE_PRIMARY_KEYS.holdings],
      rows: c.holdings,
    },
    account_balances: {
      primary_key: [...TABLE_PRIMARY_KEYS.account_balances],
      rows: c.account_balances,
    },
    daily_snapshots: {
      primary_key: [...TABLE_PRIMARY_KEYS.daily_snapshots],
      rows: c.daily_snapshots,
    },
    trades: {
      primary_key: [...TABLE_PRIMARY_KEYS.trades],
      rows: c.trades ?? [],
    },
  };
}

// The pre-ledger four-table envelope, byte-identical to what the
// exporter produced before trades existed. Used ONLY to verify (and
// conceptually reproduce) the checksums of old v2 backups.
function buildLegacyTablesEnvelope(t: PersonalTables) {
  const c = canonicalizeTables(t);
  return {
    accounts: {
      primary_key: [...TABLE_PRIMARY_KEYS.accounts],
      rows: c.accounts,
    },
    holdings: {
      primary_key: [...TABLE_PRIMARY_KEYS.holdings],
      rows: c.holdings,
    },
    account_balances: {
      primary_key: [...TABLE_PRIMARY_KEYS.account_balances],
      rows: c.account_balances,
    },
    daily_snapshots: {
      primary_key: [...TABLE_PRIMARY_KEYS.daily_snapshots],
      rows: c.daily_snapshots,
    },
  };
}

function v1Checksum(t: PersonalTables): string {
  return contentChecksum(JSON.stringify(canonicalizeTables(t)));
}

// The checksum follows the table set the payload actually carries:
// a payload WITH trades checks against the five-table canonical
// envelope; a pre-ledger payload (no trades) checks against the
// legacy four-table envelope, so backups written before the trade
// ledger existed still verify and import.
function v2Checksum(t: PersonalTables): string {
  return contentChecksum(
    JSON.stringify(
      t.trades ? buildTablesEnvelope(t) : buildLegacyTablesEnvelope(t),
    ),
  );
}

// Normalizes an accepted v1 or v2 payload to the internal tables
// shape plus the list of unknown tables that were skipped. v1's
// `board: "portfolio"` and v2's `panel: "portfolio-board"` name the
// same panel; the union schema has already enforced the right
// identifier for the payload's version.
function normalizePersonalImport(data: z.infer<typeof personalDataFile>): {
  tables: PersonalTables;
  ignoredTables: string[];
  version: 1 | 2;
} {
  const rawTables = data.tables as unknown as Record<string, unknown>;
  const knownNames =
    data.version === 1 ? KNOWN_TABLE_NAMES_V1 : KNOWN_TABLE_NAMES;
  const ignoredTables = Object.keys(rawTables)
    .filter((k) => !knownNames.includes(k))
    .sort(cmpStr);
  if (data.version === 1) {
    // v1 predates the trade ledger: trades is "missing" by definition
    // and the live trades table is left untouched by the import.
    const t = data.tables as unknown as PersonalTables;
    return {
      tables: {
        accounts: t.accounts,
        holdings: t.holdings,
        account_balances: t.account_balances,
        daily_snapshots: t.daily_snapshots,
      },
      ignoredTables,
      version: 1,
    };
  }
  const t = data.tables as unknown as PersonalTablesV2Import;
  const tables: PersonalTables = {
    accounts: t.accounts.rows,
    holdings: t.holdings.rows,
    account_balances: t.account_balances.rows,
    daily_snapshots: t.daily_snapshots.rows,
  };
  // A pre-ledger v2 file has no trades key at all: keep trades
  // undefined (missing) so its checksum verifies against the legacy
  // four-table form and the import never touches the live trades.
  if (t.trades) {
    tables.trades = t.trades.rows;
  }
  return {
    tables,
    ignoredTables,
    version: 2,
  };
}

// Semantic validation beyond the zod shape: duplicate natural keys
// inside the file, or rows pointing at accounts the file does not
// define, make the whole file invalid — nothing is written.
function validatePersonalTables(t: PersonalTables): void {
  const accountIds = new Set<string>();
  for (const a of t.accounts) {
    if (accountIds.has(a.id)) {
      throw new Error(`importPersonalData: duplicate account id "${a.id}"`);
    }
    accountIds.add(a.id);
  }
  const holdingKeys = new Set<string>();
  for (const h of t.holdings) {
    const key = `${h.account_id} ${h.symbol}`;
    if (holdingKeys.has(key)) {
      throw new Error(
        `importPersonalData: duplicate holding ${h.account_id}/${h.symbol}`,
      );
    }
    holdingKeys.add(key);
    if (!accountIds.has(h.account_id)) {
      throw new Error(
        `importPersonalData: holding ${h.symbol} references unknown account "${h.account_id}"`,
      );
    }
  }
  const balanceKeys = new Set<string>();
  for (const b of t.account_balances) {
    if (balanceKeys.has(b.account_id)) {
      throw new Error(
        `importPersonalData: duplicate balance for account "${b.account_id}"`,
      );
    }
    balanceKeys.add(b.account_id);
    if (!accountIds.has(b.account_id)) {
      throw new Error(
        `importPersonalData: balance references unknown account "${b.account_id}"`,
      );
    }
  }
  const snapshotKeys = new Set<string>();
  for (const s of t.daily_snapshots) {
    const key = `${s.date} ${s.account_id}`;
    if (snapshotKeys.has(key)) {
      throw new Error(
        `importPersonalData: duplicate snapshot ${s.date}/${s.account_id}`,
      );
    }
    snapshotKeys.add(key);
    if (!accountIds.has(s.account_id)) {
      throw new Error(
        `importPersonalData: snapshot ${s.date} references unknown account "${s.account_id}"`,
      );
    }
  }
  if (t.trades) {
    const tradeIds = new Set<number>();
    for (const r of t.trades) {
      if (tradeIds.has(r.id)) {
        throw new Error(`importPersonalData: duplicate trade id ${r.id}`);
      }
      tradeIds.add(r.id);
      if (!accountIds.has(r.account_id)) {
        throw new Error(
          `importPersonalData: trade ${r.id} references unknown account "${r.account_id}"`,
        );
      }
    }
  }
}

function parseStoredTimestamp(value: string | null): Date {
  if (value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

const tableCountSchema = z.object({
  written: z.number(),
  skipped: z.number(),
});

const personalImportResponse = z.object({
  ok: z.literal(true),
  mode: z.enum(["restore", "merge"]),
  // Format version of the accepted payload (1 or 2).
  source_version: z.number(),
  // Unknown tables present in the payload, skipped (not an error).
  ignored_tables: z.array(z.string()),
  tables: z.object({
    accounts: tableCountSchema,
    holdings: tableCountSchema,
    account_balances: tableCountSchema,
    daily_snapshots: tableCountSchema,
    trades: tableCountSchema,
  }),
});

type PersonalImportResponse = z.infer<typeof personalImportResponse>;

export const Actions = {
  getPortfolio: defineAction({
    description:
      "Returns all accounts （券商A/券商B…) with their stored holdings, per-account cash and per-account daily history, plus the merged global view (same-symbol holdings combined across accounts, cash and history summed), the latest cached regular-close quotes, session-aware extended-hours annotations (pre-market / after-hours), the current US market session (America/New_York), the cached USD/CNY rate, and market benchmarks (S&P 500, Nasdaq-100, Nasdaq Composite, Shanghai Composite, CSI 300, CSI A500, Nikkei 225, Vietnam Ho Chi Minh Index, spot gold XAU/USD, Shanghai Gold Au99.99 in CNY/gram) — each benchmark carrying both its all-time highest close (peak_price/peak_date) and its trailing-3-year highest close (peak3y_price/peak3y_date).",
    request: z.object({}),
    response: portfolioResponse,
    handler: async (ctx): Promise<PortfolioResponse> => loadPortfolio(ctx),
  }),

  getTrades: defineAction({
    description:
      "Returns the trade ledger （交易流水）: every recorded trade (optionally filtered to one account_id), newest first (date desc, id desc), each row carrying its account name. Also returns realized-P/L summaries computed by replaying each (account, symbol) position in date order — buys/opening entries fold into a weighted-average cost, a sell realizes qty × (sell price − average cost at that moment); a sell valued with an estimated price counts but flags has_estimated, and a sell with an unknown price or an unknown cost basis makes that symbol's realized P/L null (unknown, never 0) and the containing total null with has_unknown set. Summaries are provided globally and per account. The ledger is a pure record: nothing here touches holdings, quotes, totals or daily snapshots.",
    request: z.object({
      account_id: z.string().min(1).max(40).optional(),
    }),
    response: tradesResponse,
    handler: async (ctx, args): Promise<TradesResponse> =>
      loadTrades(ctx, args.account_id),
  }),

  addTrade: defineAction({
    description:
      "Adds one entry to the trade ledger for an account: trade date (YYYY-MM-DD), symbol, side (buy/sell), quantity (positive, fractional shares allowed), execution price (nullable — when empty, price_kind must be \"none\"; when present, price_kind is \"actual\" or \"estimated\", defaulting to \"actual\"), source (order = order fill record, snapshot_diff = whole-account snapshot diff, opening = opening initialization at the broker cost price, manual), and an optional note. Pure record: it never changes holdings, cash, quotes or snapshots.",
    request: z.object({
      account_id: z.string().min(1).max(40),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      symbol: z.string().min(1).max(12),
      side: tradeSide,
      qty: z.number().positive(),
      price: z.number().positive().nullable().optional(),
      price_kind: tradePriceKind.optional(),
      source: tradeSource,
      note: z.string().max(500).nullable().optional(),
    }),
    response: tradeRowResponse,
    handler: async (ctx, args): Promise<TradeRowResponse> => {
      await requireTradeAccount(ctx, args.account_id);
      assertTradeDate("addTrade", args.date);
      const { price, priceKind } = normalizeTradePrice(
        "addTrade",
        args.price,
        args.price_kind,
      );
      const db = ctx.db<typeof schema>();
      const now = new Date();
      const inserted = await db
        .insert(schema.trades)
        .values({
          accountId: args.account_id,
          date: args.date,
          symbol: args.symbol.trim().toUpperCase(),
          side: args.side,
          qty: args.qty,
          price,
          priceKind,
          source: args.source,
          note: args.note?.trim() ? args.note.trim() : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("addTrade: insert returned no rows");
      ctx.invalidateQueries();
      const accounts = await db
        .select({ name: schema.accounts.name })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, args.account_id));
      return toTradeRow(row, accounts[0]?.name ?? args.account_id);
    },
  }),

  updateTrade: defineAction({
    description:
      "Partially updates one trade-ledger entry by id (any subset of date, symbol, side, qty, price, price_kind, source, note; price may be set to null to mark the execution price unknown). The merged entry must keep price and price_kind consistent (empty price ⇔ price_kind \"none\"). Pure record: holdings, cash, quotes and snapshots are never touched.",
    request: z.object({
      id: z.number().int().positive(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      symbol: z.string().min(1).max(12).optional(),
      side: tradeSide.optional(),
      qty: z.number().positive().optional(),
      price: z.number().positive().nullable().optional(),
      price_kind: tradePriceKind.optional(),
      source: tradeSource.optional(),
      note: z.string().max(500).nullable().optional(),
    }),
    response: tradeRowResponse,
    handler: async (ctx, args): Promise<TradeRowResponse> => {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.id, args.id));
      const row = existing[0];
      if (!row) throw new Error(`updateTrade: no trade with id ${args.id}`);
      if (args.date !== undefined) assertTradeDate("updateTrade", args.date);
      // Consistency is judged on the merged entry: e.g. setting only
      // price_kind "none" while a price stands is rejected, as is
      // clearing the price while a priced kind stands.
      const mergedPrice =
        args.price !== undefined ? args.price : row.price;
      const mergedKind =
        args.price_kind !== undefined ? args.price_kind : row.priceKind;
      const { price, priceKind } = normalizeTradePrice(
        "updateTrade",
        mergedPrice,
        mergedKind,
      );
      const updated = await db
        .update(schema.trades)
        .set({
          date: args.date ?? row.date,
          symbol: args.symbol
            ? args.symbol.trim().toUpperCase()
            : row.symbol,
          side: args.side ?? row.side,
          qty: args.qty ?? row.qty,
          price,
          priceKind,
          source: args.source ?? row.source,
          note:
            args.note !== undefined
              ? args.note?.trim()
                ? args.note.trim()
                : null
              : row.note,
          updatedAt: new Date(),
        })
        .where(eq(schema.trades.id, args.id))
        .returning();
      const out = updated[0];
      if (!out) throw new Error(`updateTrade: no trade with id ${args.id}`);
      ctx.invalidateQueries();
      const accounts = await db
        .select({ name: schema.accounts.name })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, out.accountId));
      return toTradeRow(out, accounts[0]?.name ?? out.accountId);
    },
  }),

  deleteTrade: defineAction({
    description:
      "Deletes one trade-ledger entry by id. Pure record removal: holdings, cash, quotes and snapshots are never touched.",
    request: z.object({ id: z.number().int().positive() }),
    response: tradeOkResponse,
    handler: async (ctx, args): Promise<z.infer<typeof tradeOkResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.trades)
        .where(eq(schema.trades.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  exportPersonalData: defineAction({
    description:
      "Exports ONLY the user's personal data as a self-describing dataset envelope ({format: \"muse-personal-data\", version: 2, panel: \"portfolio-board\", exported_at, checksum, tables}): tables maps each of accounts, holdings, account_balances, daily_snapshots and trades to {primary_key, rows} — each table declares its own primary key, rows carry all fields (daily snapshot rows keep their embedded fx_rate/spx_price/ndx_price as part of the personal history record; trade rows carry their created_at/updated_at as ISO strings). The trades table is always present, possibly empty. Market-derived caches (quote_snapshots including the extended-hours slots, market_snapshots, fx_snapshots) are never included. Serialization is deterministic — rows sorted by primary key, fixed field order — and `checksum` covers the canonical tables envelope only (exported_at excluded), so two exports of the same state are byte-identical apart from the timestamp. Read-only; knows nothing about any repository or backup pipeline.",
    request: z.object({}),
    response: personalExportResponse,
    handler: async (ctx): Promise<PersonalExportResponse> => {
      const tables = await buildPersonalTables(ctx);
      return {
        format: "muse-personal-data" as const,
        version: 2 as const,
        panel: "portfolio-board" as const,
        exported_at: new Date().toISOString(),
        checksum: v2Checksum(tables),
        tables: buildTablesEnvelope(tables),
      };
    },
  }),

  importPersonalData: defineAction({
    description:
      "Imports a personal-data payload produced by exportPersonalData back into the five personal tables — and nothing else; the market caches are never touched. Accepts BOTH the v2 envelope (version 2, panel \"portfolio-board\", tables as {primary_key, rows}) and the legacy v1 shape (version 1, board \"portfolio\", tables as bare row arrays, normalized to v2 internally); v1's board identifier and v2's panel identifier name the same panel. Backward compatibility is strict: a payload whose tables carry no trades entry — every v1 file, and v2 backups written before the trade ledger existed (whose checksum follows the legacy four-table canonical form) — imports exactly as before and leaves the live trades table completely untouched in BOTH modes (its count reports written 0 / skipped 0 and it never appears in ignored_tables); a payload WITH trades has that table restored wholesale (restore) or upserted by id (merge). Unknown fields are ignored and unknown tables are skipped and reported in `ignored_tables` — neither fails the import. A format mismatch, a version greater than 2, or a payload checksum that does not match the canonical content (computed over the table set the file actually carries) rejects the whole import with nothing written, as does any validation failure (row shapes, duplicate natural keys — including duplicate trade ids, account references). mode \"restore\" replaces the tables the file actually carries with the file's contents (accounts land exactly as the file defines them, overriding any seed/demo accounts) and requires confirm=true. mode \"merge\" upserts by natural key (accounts by id, holdings by (account_id, symbol), balances by account_id, daily_snapshots by (date, account_id), trades by id), never deletes rows absent from the file, and never overwrites an existing source=\"manual\" daily snapshot (the same protection recordDailySnapshot applies); restore onto an empty board is not subject to that skip. Returns per-table written/skipped counts (all five tables) plus source_version and ignored_tables.",
    request: z.object({
      data: personalDataFile,
      mode: z.enum(["restore", "merge"]),
      confirm: z.boolean(),
    }),
    response: personalImportResponse,
    handler: async (ctx, args): Promise<PersonalImportResponse> => {
      const normalized = normalizePersonalImport(args.data);
      const t = normalized.tables;
      // Integrity gate: when the payload carries a checksum it must
      // match the canonical content (v1 flavor for v1 payloads, v2
      // envelope flavor for v2) — a mismatch means the file was
      // corrupted or tampered with; reject before any write.
      const providedChecksum = args.data.checksum;
      if (providedChecksum) {
        const computed =
          normalized.version === 1 ? v1Checksum(t) : v2Checksum(t);
        if (computed !== providedChecksum) {
          throw new Error(
            "importPersonalData: checksum mismatch — payload content does not match its checksum",
          );
        }
      }
      validatePersonalTables(t);
      if (args.mode === "restore" && args.confirm !== true) {
        throw new Error(
          "importPersonalData: restore mode requires confirm=true",
        );
      }
      const db = ctx.db<typeof schema>();
      const accountValues = t.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        sort: a.sort,
      }));
      const holdingValues = t.holdings.map((h) => ({
        accountId: h.account_id,
        symbol: h.symbol,
        quoteSymbol: h.quote_symbol,
        name: h.name,
        qty: h.qty,
        costPerShare: h.cost_per_share,
        kind: h.kind,
        theme: h.theme,
      }));
      const balanceValues = t.account_balances.map((b) => ({
        accountId: b.account_id,
        cashUsd: b.cash_usd,
        snapshotLabel: b.snapshot_label,
        updatedAt: parseStoredTimestamp(b.updated_at),
      }));
      const snapshotValues = t.daily_snapshots.map((s) => ({
        date: s.date,
        accountId: s.account_id,
        accountValueUsd: s.account_value_usd,
        securitiesValueUsd: s.securities_value_usd,
        cashUsd: s.cash_usd,
        totalPnlUsd: s.total_pnl_usd,
        dayChangeUsd: s.day_change_usd,
        dayChangePct: s.day_change_pct,
        fxRate: s.fx_rate,
        accountValueCny: s.account_value_cny,
        spxPrice: s.spx_price,
        ndxPrice: s.ndx_price,
        source: s.source,
        createdAt: new Date(),
      }));
      // Null when the file carries no trades table (v1 files and
      // pre-ledger v2 backups): both modes then leave the live
      // trades table completely untouched.
      const tradeValues = t.trades
        ? t.trades.map((r) => ({
            id: r.id,
            accountId: r.account_id,
            date: r.date,
            symbol: r.symbol,
            side: r.side,
            qty: r.qty,
            price: r.price,
            priceKind: r.price_kind,
            source: r.source,
            note: r.note,
            createdAt: parseStoredTimestamp(r.created_at),
            updatedAt: parseStoredTimestamp(r.updated_at),
          }))
        : null;

      if (args.mode === "restore") {
        // Replace the personal tables the file actually carries,
        // atomically: children first on delete, accounts first on
        // insert. A file without a trades table does not delete or
        // replace the live trades.
        const statements: Parameters<typeof db.batch>[0][number][] = [
          db.delete(schema.holdings),
          db.delete(schema.accountBalances),
          db.delete(schema.dailySnapshots),
        ];
        if (tradeValues) {
          statements.push(db.delete(schema.trades));
        }
        statements.push(db.delete(schema.accounts));
        if (accountValues.length > 0) {
          statements.push(db.insert(schema.accounts).values(accountValues));
        }
        if (holdingValues.length > 0) {
          statements.push(db.insert(schema.holdings).values(holdingValues));
        }
        if (balanceValues.length > 0) {
          statements.push(
            db.insert(schema.accountBalances).values(balanceValues),
          );
        }
        if (snapshotValues.length > 0) {
          statements.push(
            db.insert(schema.dailySnapshots).values(snapshotValues),
          );
        }
        if (tradeValues && tradeValues.length > 0) {
          statements.push(db.insert(schema.trades).values(tradeValues));
        }
        await db.batch(
          statements as unknown as Parameters<typeof db.batch>[0],
        );
        ctx.invalidateQueries();
        return {
          ok: true as const,
          mode: args.mode,
          source_version: normalized.version,
          ignored_tables: normalized.ignoredTables,
          tables: {
            accounts: { written: accountValues.length, skipped: 0 },
            holdings: { written: holdingValues.length, skipped: 0 },
            account_balances: { written: balanceValues.length, skipped: 0 },
            daily_snapshots: { written: snapshotValues.length, skipped: 0 },
            trades: { written: tradeValues?.length ?? 0, skipped: 0 },
          },
        };
      }

      // merge: upsert by natural key; existing rows absent from the
      // file are kept. Screenshot-sourced snapshots are protected,
      // exactly as in recordDailySnapshot.
      let accountsWritten = 0;
      for (const v of accountValues) {
        await db
          .insert(schema.accounts)
          .values(v)
          .onConflictDoUpdate({
            target: schema.accounts.id,
            set: { name: v.name, sort: v.sort },
          });
        accountsWritten += 1;
      }
      let holdingsWritten = 0;
      for (const v of holdingValues) {
        await db
          .insert(schema.holdings)
          .values(v)
          .onConflictDoUpdate({
            target: [schema.holdings.accountId, schema.holdings.symbol],
            set: {
              quoteSymbol: v.quoteSymbol,
              name: v.name,
              qty: v.qty,
              costPerShare: v.costPerShare,
              kind: v.kind,
              theme: v.theme,
            },
          });
        holdingsWritten += 1;
      }
      let balancesWritten = 0;
      for (const v of balanceValues) {
        await db
          .insert(schema.accountBalances)
          .values(v)
          .onConflictDoUpdate({
            target: schema.accountBalances.accountId,
            set: {
              cashUsd: v.cashUsd,
              snapshotLabel: v.snapshotLabel,
              updatedAt: v.updatedAt,
            },
          });
        balancesWritten += 1;
      }
      const existingSnapshots = await db
        .select({
          date: schema.dailySnapshots.date,
          accountId: schema.dailySnapshots.accountId,
          source: schema.dailySnapshots.source,
        })
        .from(schema.dailySnapshots);
      const protectedKeys = new Set(
        existingSnapshots
          .filter((s) => s.source === "manual")
          .map((s) => `${s.date} ${s.accountId}`),
      );
      let snapshotsWritten = 0;
      let snapshotsSkipped = 0;
      for (const v of snapshotValues) {
        if (protectedKeys.has(`${v.date} ${v.accountId}`)) {
          snapshotsSkipped += 1;
          continue;
        }
        await db
          .insert(schema.dailySnapshots)
          .values(v)
          .onConflictDoUpdate({
            target: [schema.dailySnapshots.date, schema.dailySnapshots.accountId],
            set: {
              accountValueUsd: v.accountValueUsd,
              securitiesValueUsd: v.securitiesValueUsd,
              cashUsd: v.cashUsd,
              totalPnlUsd: v.totalPnlUsd,
              dayChangeUsd: v.dayChangeUsd,
              dayChangePct: v.dayChangePct,
              fxRate: v.fxRate,
              accountValueCny: v.accountValueCny,
              spxPrice: v.spxPrice,
              ndxPrice: v.ndxPrice,
              source: v.source,
            },
          });
        snapshotsWritten += 1;
      }
      let tradesWritten = 0;
      if (tradeValues) {
        for (const v of tradeValues) {
          await db
            .insert(schema.trades)
            .values(v)
            .onConflictDoUpdate({
              target: schema.trades.id,
              set: {
                accountId: v.accountId,
                date: v.date,
                symbol: v.symbol,
                side: v.side,
                qty: v.qty,
                price: v.price,
                priceKind: v.priceKind,
                source: v.source,
                note: v.note,
                createdAt: v.createdAt,
                updatedAt: v.updatedAt,
              },
            });
          tradesWritten += 1;
        }
      }
      if (
        accountsWritten +
          holdingsWritten +
          balancesWritten +
          snapshotsWritten +
          tradesWritten >
        0
      ) {
        ctx.invalidateQueries();
      }
      return {
        ok: true as const,
        mode: args.mode,
        source_version: normalized.version,
        ignored_tables: normalized.ignoredTables,
        tables: {
          accounts: { written: accountsWritten, skipped: 0 },
          holdings: { written: holdingsWritten, skipped: 0 },
          account_balances: { written: balancesWritten, skipped: 0 },
          daily_snapshots: {
            written: snapshotsWritten,
            skipped: snapshotsSkipped,
          },
          trades: { written: tradesWritten, skipped: 0 },
        },
      };
    },
  }),

  refreshQuotes: defineAction({
    description:
      "Refreshes regular-session quotes for the union of holding symbols across all accounts (finance channel primary, Nasdaq API cross-check/fallback — outside the regular session both are fetched and must agree, with Nasdaq winning disagreements because its symbol-addressed endpoint cannot return a wrong instrument the way the finance channel's fuzzy matching once did for MRVL; the Nasdaq read itself uses secondaryData during Pre-Market/After-Hours, where primaryData is the live extended trade rather than the close), extended-hours annotations (Nasdaq pre-market feed while the pre session is live/just ended, Nasdaq after-hours feed in the post session; during the overnight session 20:00–04:00 ET the extended price comes from Yahoo Finance chart meta.fulldayPrice with ext_session \"overnight\" and ext_as_of set to the fetch moment, shown in the detail as a bare numeric time; Nasdaq pre/post stamps are parsed server-side from the feed's page copy into UTC ISO instants before storing, and the detail renders them through the same bare-numeric-time format, falling back per-symbol to the after-hours last trade when Yahoo yields nothing), and the live USD/CNY rate; seeds (once, from long history) and ratchets the all-time highest close (peak_price/peak_date) behind each market benchmark, and maintains the trailing-3-year highest close (peak3y_price/peak3y_date — seeded once from ~3 years of daily closes, ratcheted up, and re-seeded from the source series when the stored peak date slides out of the 3-year window) that the strip's 距高点 figure is computed from; records one daily snapshot per account; returns the refreshed portfolio.",
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

          const prev = existingBySymbol.get(h.quoteSymbol);
          const cachedPrice =
            prev && prev.price != null && prev.price > 0 ? prev.price : null;

          let financeQuote: RegularQuote | null = null;
          try {
            const res = await ctx.tool.finance_ticker(h.quoteSymbol);
            const inst = res.content.instrument;
            // Guard against wrong-instrument matches: a non-USD price is
            // not this holding (e.g. a foreign same-name listing).
            if (inst && inst.price != null && inst.currency === "USD") {
              financeQuote = {
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
            }
          } catch {
            financeQuote = null;
          }

          // Acceptance. The finance channel fuzzy-matches instruments
          // and intermittently returns a DIFFERENT security for a
          // symbol — verified live 2026-11-09 pre-market: a wrong
          // instrument priced in single digits against a triple-digit
          // close; stored as the \"close\", it also became the
          // pre-market % reference and printed an absurd
          // four-digit percentage. Nasdaq's endpoint is addressed by symbol and
          // cannot mismatch, so: during the regular session the
          // finance candidate is plausibility-checked against the
          // stored close with Nasdaq as fallback; outside the
          // regular session (where the close is a settled fact) BOTH
          // sources are fetched and cross-checked — agreement keeps
          // finance primary, a wild disagreement defers to Nasdaq
          // (which also heals a previously poisoned stored close),
          // and a lone implausible finance quote is discarded so
          // the stored close stands and ext slots still refresh
          // against it via the !regular path below.
          let regular: RegularQuote | null = null;
          let source: string | null = null;
          if (session.key === "regular") {
            if (
              financeQuote &&
              regularQuotePlausible(financeQuote, cachedPrice, session.key)
            ) {
              regular = financeQuote;
              source = "finance";
            } else {
              let nasdaqQuote: RegularQuote | null = null;
              try {
                nasdaqQuote = await fetchNasdaqQuote(h.quoteSymbol, h.kind);
              } catch {
                nasdaqQuote = null;
              }
              if (
                nasdaqQuote &&
                regularQuotePlausible(nasdaqQuote, cachedPrice, session.key)
              ) {
                regular = nasdaqQuote;
                source = "nasdaq";
              } else if (financeQuote && nasdaqQuote) {
                // Both implausible against the cache yet consistent
                // with each other: the cache missed a session, not a
                // wrong instrument.
                const r = financeQuote.price / nasdaqQuote.price;
                if (r >= 0.4 && r <= 2.5) {
                  regular = financeQuote;
                  source = "finance";
                }
              }
            }
          } else {
            let nasdaqQuote: RegularQuote | null = null;
            try {
              nasdaqQuote = await fetchNasdaqQuote(h.quoteSymbol, h.kind);
            } catch {
              nasdaqQuote = null;
            }
            if (financeQuote && nasdaqQuote) {
              const r = financeQuote.price / nasdaqQuote.price;
              if (r >= 0.9 && r <= 1.1) {
                regular = financeQuote;
                source = "finance";
              } else {
                regular = nasdaqQuote;
                source = "nasdaq";
              }
            } else if (nasdaqQuote) {
              regular = nasdaqQuote;
              source = "nasdaq";
            } else if (
              financeQuote &&
              regularQuotePlausible(financeQuote, cachedPrice, session.key)
            ) {
              regular = financeQuote;
              source = "finance";
            }
          }
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
            // Per-session slots (plan B): a refresh writes ONLY the
            // slot of the session it runs in — the post feed fetched
            // during pre-market is the display fallback, never a
            // reason to overwrite the post slot, and the after_*
            // mirror follows the post slot only when the post slot
            // itself is being written (post/closed sessions).
            if (prev && prev.price != null && prev.price > 0) {
              const pctVsCached =
                (q: ExtendedQuote) =>
                  ((q.price - (prev.price as number)) / (prev.price as number)) *
                  100;
              if (session.key === "pre" && pre) {
                await db
                  .update(schema.quoteSnapshots)
                  .set({
                    prePrice: pre.price,
                    preChangePercent: pctVsCached(pre),
                    preAsOf: pre.asOf,
                    extPrice: pre.price,
                    extChangePercent: pctVsCached(pre),
                    extAsOf: pre.asOf,
                    extSession: "pre",
                  })
                  .where(
                    eq(schema.quoteSnapshots.quoteSymbol, h.quoteSymbol),
                  );
              } else if (
                (session.key === "post" || session.key === "closed") &&
                after
              ) {
                await db
                  .update(schema.quoteSnapshots)
                  .set({
                    postPrice: after.price,
                    postChangePercent: pctVsCached(after),
                    postAsOf: after.asOf,
                    afterPrice: after.price,
                    afterChangePercent: pctVsCached(after),
                    afterAsOf: after.asOf,
                    extPrice: after.price,
                    extChangePercent: pctVsCached(after),
                    extAsOf: after.asOf,
                    extSession: "post",
                  })
                  .where(
                    eq(schema.quoteSnapshots.quoteSymbol, h.quoteSymbol),
                  );
              } else if (session.key === "overnight" && overnight) {
                await db
                  .update(schema.quoteSnapshots)
                  .set({
                    overnightPrice: overnight.price,
                    overnightChangePercent: pctVsCached(overnight),
                    overnightAsOf: overnight.asOf,
                    extPrice: overnight.price,
                    extChangePercent: pctVsCached(overnight),
                    extAsOf: overnight.asOf,
                    extSession: "overnight",
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
          // Per-session extended slots (plan B; annotation + live
          // estimate only, never the official totals). The percent is
          // measured against the close its session references: the
          // previous close for pre-market, the same-day close for
          // after-hours/overnight. A refresh writes ONLY the slot of
          // the session it runs in; the other two slots keep their
          // saved values untouched. When the current session's feed
          // has no data this refresh, that slot keeps its saved value
          // too (never cleared, never fabricated).
          const prevClose =
            regular.change != null ? regular.price - regular.change : null;
          // Slot values start from the stored saves.
          let prePrice = prev?.prePrice ?? null;
          let preChangePercent = prev?.preChangePercent ?? null;
          let preAsOf = prev?.preAsOf ?? null;
          let postPrice = prev?.postPrice ?? prev?.afterPrice ?? null;
          let postChangePercent =
            prev?.postChangePercent ?? prev?.afterChangePercent ?? null;
          let postAsOf = prev?.postAsOf ?? prev?.afterAsOf ?? null;
          let overnightPrice = prev?.overnightPrice ?? null;
          let overnightChangePercent = prev?.overnightChangePercent ?? null;
          let overnightAsOf = prev?.overnightAsOf ?? null;
          // The legacy ext_* mirror follows the slot written now (or
          // stays as stored when nothing is written).
          let extPrice: number | null = prev?.extPrice ?? null;
          let extChangePercent: number | null = prev?.extChangePercent ?? null;
          let extAsOf: string | null = prev?.extAsOf ?? null;
          let extSession: string | null = prev?.extSession ?? null;
          const writeSlot = (
            q: ExtendedQuote,
            s: "pre" | "post" | "overnight",
            ref: number,
          ) => {
            if (!(ref > 0)) return;
            const pct = ((q.price - ref) / ref) * 100;
            if (s === "pre") {
              prePrice = q.price;
              preChangePercent = pct;
              preAsOf = q.asOf;
            } else if (s === "post") {
              postPrice = q.price;
              postChangePercent = pct;
              postAsOf = q.asOf;
            } else {
              overnightPrice = q.price;
              overnightChangePercent = pct;
              overnightAsOf = q.asOf;
            }
            extPrice = q.price;
            extChangePercent = pct;
            extAsOf = q.asOf;
            extSession = s;
          };
          if (session.key === "pre") {
            // Only the pre slot is written; the post feed fetched
            // alongside is display fallback material, not a write.
            if (pre) writeSlot(pre, "pre", regular.price);
          } else if (session.key === "regular") {
            // This morning's pre-market belongs to the pre slot,
            // measured against the previous close (price − change).
            if (pre && prevClose != null) {
              writeSlot(pre, "pre", prevClose);
            }
          } else if (session.key === "overnight") {
            // Only the overnight slot is written; a Yahoo miss keeps
            // the saved overnight value and the display falls back
            // to the post slot (after-hours last trade).
            if (overnight) writeSlot(overnight, "overnight", regular.price);
          } else {
            // post / closed: only the post slot is written.
            if (after) writeSlot(after, "post", regular.price);
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
            // after_* mirrors the post slot: it moves only when the
            // post slot itself was just written (post/closed session).
            afterPrice: postPrice,
            afterChangePercent: postChangePercent,
            afterAsOf: postAsOf,
            extPrice,
            extChangePercent,
            extAsOf,
            extSession,
            prePrice,
            preChangePercent,
            preAsOf,
            postPrice,
            postChangePercent,
            postAsOf,
            overnightPrice,
            overnightChangePercent,
            overnightAsOf,
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

      // Daily snapshot: seed the verified manual record once, then
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

  refreshExtendedQuotes: defineAction({
    description:
      "Extended-hours-only refresh for the 30-minute scheduled save (plan B): when the current US session (America/New_York) is pre-market, after-hours, or overnight, it fetches that session's extended prices (Nasdaq pre/post feeds; Yahoo fulldayPrice overnight) and writes ONLY that session's saved slot (pre_*/post_*/overnight_* on quote_snapshots), leaving the other two slots untouched. During the regular session or when the market is closed it writes nothing at all. It never touches the regular-close quote fields, the fetched_at staleness stamp, FX, benchmarks, or the daily snapshots — the official close basis is exclusively refreshQuotes' job. A symbol whose feed yields nothing keeps its slot's saved value.",
    request: z.object({}),
    response: extendedRefreshResponse,
    handler: async (
      ctx,
    ): Promise<z.infer<typeof extendedRefreshResponse>> => {
      const now = new Date();
      const session = currentUsSession(now);
      if (
        session.key !== "pre" &&
        session.key !== "post" &&
        session.key !== "overnight"
      ) {
        return {
          updated: 0,
          skipped: true,
          session: session.key,
          portfolio: await loadPortfolio(ctx),
        };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.holdings);
      const seenSymbols = new Set<string>();
      const targets: (typeof rows)[number][] = [];
      for (const h of rows) {
        if (!seenSymbols.has(h.quoteSymbol)) {
          seenSymbols.add(h.quoteSymbol);
          targets.push(h);
        }
      }
      const existing = await db.select().from(schema.quoteSnapshots);
      const existingBySymbol = new Map(
        existing.map((s) => [s.quoteSymbol, s]),
      );
      let updated = 0;
      await Promise.all(
        targets.map(async (h) => {
          const prev = existingBySymbol.get(h.quoteSymbol);
          // No stored regular close → no reference to measure the
          // extended move against; skip rather than fabricate.
          if (!prev || prev.price == null || !(prev.price > 0)) return;
          const ref = prev.price;
          let q: ExtendedQuote | null = null;
          try {
            if (session.key === "pre") {
              q = await fetchNasdaqExtended(h.quoteSymbol, h.kind, "pre");
            } else if (session.key === "post") {
              q = await fetchNasdaqExtended(h.quoteSymbol, h.kind, "post");
            } else {
              const p = await fetchYahooOvernightPrice(h.quoteSymbol);
              if (p != null) q = { price: p, asOf: now.toISOString() };
            }
          } catch {
            q = null;
          }
          // Feed yielded nothing: the slot keeps its saved value.
          if (!q) return;
          const pct = ((q.price - ref) / ref) * 100;
          const slotSet =
            session.key === "pre"
              ? {
                  prePrice: q.price,
                  preChangePercent: pct,
                  preAsOf: q.asOf,
                }
              : session.key === "post"
                ? {
                    postPrice: q.price,
                    postChangePercent: pct,
                    postAsOf: q.asOf,
                    afterPrice: q.price,
                    afterChangePercent: pct,
                    afterAsOf: q.asOf,
                  }
                : {
                    overnightPrice: q.price,
                    overnightChangePercent: pct,
                    overnightAsOf: q.asOf,
                  };
          await db
            .update(schema.quoteSnapshots)
            .set({
              ...slotSet,
              extPrice: q.price,
              extChangePercent: pct,
              extAsOf: q.asOf,
              extSession: session.key,
            })
            .where(eq(schema.quoteSnapshots.quoteSymbol, h.quoteSymbol));
          updated += 1;
        }),
      );
      if (updated > 0) ctx.invalidateQueries();
      return {
        updated,
        skipped: false,
        session: session.key,
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
    description:
      "Updates the quantity and/or cost per share of one holding, then recalculates that account's latest daily snapshot from the current holdings at the stored regular close (backfilled-trade convergence; manual-sourced rows are protected and skipped). The edit itself always stands: the recalculation outcome rides along as snapshot_recalc (updated / skipped_no_snapshot / skipped_protected / failed) instead of failing the edit.",
    request: z.object({
      id: z.number().int().positive(),
      qty: z.number().nonnegative(),
      cost_per_share: z.number().nonnegative(),
    }),
    response: z.object({
      ok: z.literal(true),
      snapshot_recalc: snapshotRecalcSchema,
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: true; snapshot_recalc: SnapshotRecalc }> => {
      const db = ctx.db<typeof schema>();
      const before = await db
        .select({ accountId: schema.holdings.accountId })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, args.id));
      const accountId = before[0]?.accountId;
      await db
        .update(schema.holdings)
        .set({ qty: args.qty, costPerShare: args.cost_per_share })
        .where(eq(schema.holdings.id, args.id));
      ctx.invalidateQueries();
      const snapshot_recalc = accountId
        ? await tryRecalcSnapshot(ctx, accountId)
        : recalcMiss("failed", null, "holding_not_found");
      return { ok: true as const, snapshot_recalc };
    },
  }),

  updateCash: defineAction({
    description:
      "Updates one account's stored cash balance (USD) from a newer user-provided figure; that account's total value, the global total and its CNY conversion follow from it. Afterwards the account's latest daily snapshot is recalculated so a backfilled trade's cash leg lands in that day's stored row; the outcome rides along as snapshot_recalc and never fails the cash update itself.",
    request: z.object({
      account_id: z.string().min(1).max(40),
      cash_usd: z.number().nonnegative(),
    }),
    response: z.object({
      ok: z.literal(true),
      snapshot_recalc: snapshotRecalcSchema,
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: true; snapshot_recalc: SnapshotRecalc }> => {
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
      const snapshot_recalc = await tryRecalcSnapshot(ctx, args.account_id);
      return { ok: true as const, snapshot_recalc };
    },
  }),

  addHolding: defineAction({
    description:
      "Adds a new holding row to one account (account_id, symbol, quantity, cost per share, theme). If the symbol already exists in that account, its quantity is added and the cost is re-averaged instead of creating a duplicate row. Afterwards the account's latest daily snapshot is recalculated from the updated holdings at the stored regular close (backfilled-trade convergence); the outcome rides along as snapshot_recalc and never fails the add itself (a brand-new symbol with no stored close yet reports failed/missing_regular_quote and the snapshot keeps its prior values until a quote refresh lands).",
    request: z.object({
      account_id: z.string().min(1).max(40),
      symbol: z.string().min(1).max(12),
      name: z.string().min(1).max(80),
      qty: z.number().nonnegative(),
      cost_per_share: z.number().nonnegative(),
      kind: z.enum(["stock", "etf"]),
      theme: z.string().min(1).max(20),
    }),
    response: z.object({
      id: z.number(),
      snapshot_recalc: snapshotRecalcSchema,
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ id: number; snapshot_recalc: SnapshotRecalc }> => {
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
        const snapshot_recalc = await tryRecalcSnapshot(
          ctx,
          args.account_id,
        );
        return { id: existingRow.id, snapshot_recalc };
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
      const snapshot_recalc = await tryRecalcSnapshot(ctx, args.account_id);
      return { id: inserted.id, snapshot_recalc };
    },
  }),

  removeHolding: defineAction({
    description:
      "Removes one holding row by id, then recalculates that account's latest daily snapshot from the remaining holdings at the stored regular close (a backfilled full exit lands in that day's stored row). The removal always stands; the recalculation outcome rides along as snapshot_recalc.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.literal(true),
      snapshot_recalc: snapshotRecalcSchema,
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: true; snapshot_recalc: SnapshotRecalc }> => {
      const db = ctx.db<typeof schema>();
      const before = await db
        .select({ accountId: schema.holdings.accountId })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, args.id));
      const accountId = before[0]?.accountId;
      await db.delete(schema.holdings).where(eq(schema.holdings.id, args.id));
      ctx.invalidateQueries();
      const snapshot_recalc = accountId
        ? await tryRecalcSnapshot(ctx, accountId)
        : recalcMiss("failed", null, "holding_not_found");
      return { ok: true as const, snapshot_recalc };
    },
  }),

  recalcDailySnapshot: defineAction({
    description:
      "Recalculates one account's daily snapshot row from the current holdings and cash at the stored regular-session close (quote_snapshots.price only — extended-hours prices never enter a snapshot). With a date, that trading day's row is the target; without one, the account's latest snapshot row. Screenshot-sourced rows are never overwritten (skipped_protected), an account with no snapshot row reports skipped_no_snapshot, and a holding without a stored regular close reports failed and leaves the row untouched.",
    request: z.object({
      account_id: z.string().min(1).max(40),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    response: snapshotRecalcSchema,
    handler: async (ctx, args): Promise<SnapshotRecalc> => {
      return await tryRecalcSnapshot(ctx, args.account_id, args.date);
    },
  }),

  recalcLatestSnapshots: defineAction({
    description:
      "Recalculates the latest daily snapshot row of every account from its current holdings and cash at the stored regular close — the one-time convergence for backfilled trades recorded after a snapshot was first written (manual rows stay protected). Returns one recalculation result per account; a failed account never blocks the others.",
    request: z.object({}),
    response: z.object({
      results: z.array(
        z.object({
          account_id: z.string(),
          recalc: snapshotRecalcSchema,
        }),
      ),
    }),
    handler: async (
      ctx,
    ): Promise<{
      results: { account_id: string; recalc: SnapshotRecalc }[];
    }> => {
      await ensureAccounts(ctx);
      const db = ctx.db<typeof schema>();
      const accountRows = (await db.select().from(schema.accounts)).sort(
        (a, b) => a.sort - b.sort,
      );
      const results: { account_id: string; recalc: SnapshotRecalc }[] = [];
      for (const a of accountRows) {
        results.push({
          account_id: a.id,
          recalc: await tryRecalcSnapshot(ctx, a.id),
        });
      }
      return { results };
    },
  }),
} satisfies ActionsModule;
