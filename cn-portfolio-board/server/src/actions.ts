// Actions for 看板 · A股持仓 (A-share holdings board, single Chinese
// securities account, all amounts CNY). Structure and 口径 mirror the
// US board （看板 · 美股持仓）: regular-close official basis, diluted-
// cost trade ledger, snapshot recompute after edits, checksummed
// export/import — minus multi-account tabs, FX, extended hours and
// news/calendar features. Quotes come from Eastmoney (push2 realtime +
// push2his daily klines).

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";

// ---------- Time helpers (Asia/Shanghai) ----------

const BJ_TZ = "Asia/Shanghai";

function dateInTz(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function beijingToday(): string {
  return dateInTz(new Date(), BJ_TZ);
}

// Whether right now (Beijing) falls inside an A-share trading
// session: Mon–Fri, 09:30–11:30 or 13:00–15:00. Exchange holidays
// are not modelled — on a weekday holiday the quote feed simply
// returns the previous trading day's quotes, which is harmless.
function inAShareSession(at: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BJ_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = dow[get("weekday")] ?? 0;
  if (weekday < 1 || weekday > 5) return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return (
    (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) ||
    (minutes >= 13 * 60 && minutes <= 15 * 60)
  );
}

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

// Shift a YYYY-MM-DD date by whole days (UTC arithmetic; the string is
// a plain calendar date, no timezone involved).
function shiftDate(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertDate(action: string, date: string): void {
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

// ---------- Eastmoney ----------

// Holding codes are stored as 6 digits; the secid market prefix comes
// from the first digit: Shanghai (5/6/9) → "1.", Shenzhen (0/1/2/3)
// → "0." (brief rule).
function secidForSymbol(symbol: string): string {
  const first = symbol.charAt(0);
  const market = first === "5" || first === "6" || first === "9" ? "1" : "0";
  return `${market}.${symbol}`;
}

// Display order drives the strip: the five A-share indices first
// (the collapsed strip keeps exactly the first two — 上证指数 /
// 中证A500), then the five benchmarks moved over from the US board
// （恒生科技 / 金龙中国 / 日经225 / 越南胡志明 / 上海黄金） so each
// index lives on exactly one board. `cnDate` marks the A-share
// session benchmarks: only their quote date may certify an A-share
// trading day for refreshCloseSnapshot — the moved-over instruments
// trade on other calendars (HXC's Beijing quote date is the next
// day; Au99.99 trades a night session), so their dates must never
// feed that check. All ten verified live 2026-11-15 via stock/get:
// every one reports f59 = 2, so the ulist batch scaling (f2 / 100)
// is unambiguous for all of them.
const BENCHMARKS: { key: string; label: string; secid: string; cnDate?: boolean }[] = [
  { key: "SSE", label: "上证指数", secid: "1.000001", cnDate: true },
  { key: "CSIA500", label: "中证A500", secid: "1.000510", cnDate: true },
  { key: "CSI300", label: "沪深300", secid: "1.000300", cnDate: true },
  { key: "SZSE", label: "深证成指", secid: "0.399001", cnDate: true },
  { key: "CHINEXT", label: "创业板指", secid: "0.399006", cnDate: true },
  { key: "HSTECH", label: "恒生科技", secid: "124.HSTECH" },
  { key: "HXC", label: "金龙中国", secid: "251.HXC" },
  { key: "N225", label: "日经225", secid: "100.N225" },
  { key: "VNI", label: "越南胡志明", secid: "100.VNINDEX" },
  { key: "SGOLD", label: "上海黄金", secid: "118.Au9999" },
];

// push2.eastmoney.com intermittently answers 502 through the egress
// proxy while the numbered node 82.push2.eastmoney.com responds (both
// probed live at build time); every realtime fetch tries the hosts in
// order and retries, keeping stored values when all attempts fail.
const PUSH2_HOSTS = ["82.push2.eastmoney.com", "push2.eastmoney.com"];

async function fetchJsonWithHosts(
  hosts: string[],
  path: string,
  attempts = 3,
  accept?: (json: unknown) => boolean,
): Promise<unknown | null> {
  const backoffMs = [0, 400, 1200, 2500];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const wait = backoffMs[attempt] ?? 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    for (const host of hosts) {
      try {
        const res = await fetch(`https://${host}${path}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const json: unknown = await res.json();
        if (json == null) continue;
        // An HTTP 200 can still carry no usable payload: Eastmoney
        // answers throttled or not-yet-ready requests with
        // `data: null` (and intermittently with empty bodies, which
        // fail res.json() above). When the caller supplies an accept
        // check, an unusable body counts as a failed attempt and the
        // retry loop keeps going — accepting it as success used to
        // end the fetch there, silently leaving the instrument on
        // its previous session's stored quote.
        if (accept && !accept(json)) continue;
        return json;
      } catch {
        // fall through to the next host / attempt
      }
    }
  }
  return null;
}

type EmQuote = {
  price: number;
  change: number | null;
  changePercent: number | null;
  prevClose: number | null;
  name: string | null;
  // Beijing date (YYYY-MM-DD) of the quote's own timestamp.
  quoteDate: string | null;
  asOf: string | null;
};

// One instrument's realtime quote via stock/get. f43 is the latest
// price scaled by 10^f59 (f59 is the authoritative decimal count: 3
// for ETFs, 2 for indexes and stocks); f60 previous close; f169 price
// change (same scale); f170 change percent ×100; f86 quote timestamp
// (unix seconds).
async function fetchEmQuote(secid: string): Promise<EmQuote | null> {
  const path = `/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=f43,f57,f58,f59,f60,f86,f169,f170`;
  const json = (await fetchJsonWithHosts(PUSH2_HOSTS, path, 4, (j) => {
    const d = (j as { data?: { f43?: unknown } | null } | null)?.data;
    return !!d && typeof d.f43 === "number" && d.f43 > 0;
  })) as {
    data?: {
      f43?: number;
      f58?: string;
      f59?: number;
      f60?: number;
      f86?: number;
      f169?: number;
      f170?: number;
    } | null;
  } | null;
  const d = json?.data;
  if (!d || typeof d.f43 !== "number" || !(d.f43 > 0)) return null;
  const scale = Math.pow(10, typeof d.f59 === "number" ? d.f59 : 2);
  const stamp =
    typeof d.f86 === "number" && d.f86 > 0 ? new Date(d.f86 * 1000) : null;
  return {
    price: d.f43 / scale,
    change: typeof d.f169 === "number" ? d.f169 / scale : null,
    changePercent: typeof d.f170 === "number" ? d.f170 / 100 : null,
    prevClose: typeof d.f60 === "number" && d.f60 > 0 ? d.f60 / scale : null,
    name: typeof d.f58 === "string" && d.f58.length > 0 ? d.f58 : null,
    quoteDate: stamp ? dateInTz(stamp, BJ_TZ) : null,
    asOf: stamp ? stamp.toISOString() : null,
  };
}

// Batch quote for the ten benchmarks via ulist.np (all ten carry
// 2 price decimals — verified per-instrument via stock/get f59, so
// the batch scaling is unambiguous here — holding ETFs report a
// wrong decimal count on this endpoint and are fetched
// per-instrument instead). f124 is the quote timestamp (unix seconds).
async function fetchEmBenchmarkQuotes(): Promise<Map<string, EmQuote>> {
  const out = new Map<string, EmQuote>();
  const secids = BENCHMARKS.map((b) => b.secid).join(",");
  const path = `/api/qt/ulist.np/get?secids=${encodeURIComponent(secids)}&fields=f2,f3,f4,f12,f13,f14,f124`;
  const json = (await fetchJsonWithHosts(PUSH2_HOSTS, path, 4, (j) => {
    const diff = (j as { data?: { diff?: unknown } | null } | null)?.data
      ?.diff;
    return Array.isArray(diff) && diff.length > 0;
  })) as {
    data?: {
      diff?: {
        f2?: number;
        f3?: number;
        f4?: number;
        f12?: string;
        f13?: number;
        f124?: number;
      }[];
    } | null;
  } | null;
  const diff = json?.data?.diff ?? [];
  for (const row of diff) {
    if (typeof row.f2 !== "number" || !(row.f2 > 0)) continue;
    if (typeof row.f12 !== "string" || typeof row.f13 !== "number") continue;
    const secid = `${row.f13}.${row.f12}`;
    const stamp =
      typeof row.f124 === "number" && row.f124 > 0
        ? new Date(row.f124 * 1000)
        : null;
    // Keyed by upper-cased secid: the feed reports Au99.99's code as
    // "AU9999" while BENCHMARKS carries the canonical "Au9999", and
    // the lookup must not depend on the feed's casing.
    out.set(secid.toUpperCase(), {
      price: row.f2 / 100,
      change: typeof row.f4 === "number" ? row.f4 / 100 : null,
      changePercent: typeof row.f3 === "number" ? row.f3 / 100 : null,
      prevClose: null,
      name: null,
      quoteDate: stamp ? dateInTz(stamp, BJ_TZ) : null,
      asOf: stamp ? stamp.toISOString() : null,
    });
  }
  return out;
}

// Daily closes from push2his (rows "日期，开，收，高，低，量"; index 2 is
// the close). The endpoint is flaky per request (intermittent empty
// bodies / 502s — observed live at build time and in the US board's
// production notes), so the fetch retries up to 3 attempts with
// backoff before giving up; callers keep old values on null.
async function fetchEmKlines(
  secid: string,
  beg: string,
): Promise<{ date: string; close: number }[] | null> {
  const path = `/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=${beg}&end=20500101&lmt=100000`;
  const json = (await fetchJsonWithHosts(["push2his.eastmoney.com"], path, 3, (j) => {
    const klines = (j as { data?: { klines?: unknown } | null } | null)?.data
      ?.klines;
    return Array.isArray(klines) && klines.length > 0;
  })) as {
    data?: { klines?: string[] } | null;
  } | null;
  const klines = json?.data?.klines ?? [];
  const rows: { date: string; close: number }[] = [];
  for (const line of klines) {
    const parts = line.split(",");
    const date = parts[0] ?? "";
    const close = Number(parts[2]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!Number.isFinite(close) || close <= 0) continue;
    rows.push({ date, close });
  }
  return rows.length > 0 ? rows : null;
}

type PeakSeed = { price: number; date: string };

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

// Eastmoney beg (YYYYMMDD) ~3 years + 45 days back from today (UTC):
// wide enough that the fetched series always covers the full window
// ending at its own last row.
function emBeg3y(): string {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(`${yearsBefore(today, 3)}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 45);
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(start.getUTCFullYear(), 4)}${p(start.getUTCMonth() + 1, 2)}${p(start.getUTCDate(), 2)}`;
}

async function fetchEmPeak3y(secid: string): Promise<PeakSeed | null> {
  const rows = await fetchEmKlines(secid, emBeg3y());
  if (!rows) return null;
  return windowPeak3y(rows);
}

// The peak to store alongside a fresh price: seed once when the
// stored peak is null or its date has slid out of the trailing-3-year
// window (a failed seed keeps the old value — never back-filled from
// just the current price, which would understate the drawdown),
// otherwise ratchet up only.
async function resolvePeak3y(
  existing: { peak3yPrice: number | null; peak3yDate: string | null },
  secid: string,
  price: number,
  quoteDate: string | null,
): Promise<{ peak3yPrice: number | null; peak3yDate: string | null }> {
  let peakPrice = existing.peak3yPrice;
  let peakDate = existing.peak3yDate;
  const windowStart = quoteDate ? yearsBefore(quoteDate, 3) : null;
  const expired =
    peakPrice == null ||
    peakDate == null ||
    (windowStart != null && peakDate < windowStart);
  if (expired) {
    const s = await fetchEmPeak3y(secid);
    if (s) {
      peakPrice = s.price;
      peakDate = s.date;
    }
  }
  if (peakPrice != null && price > peakPrice) {
    peakPrice = price;
    peakDate = quoteDate ?? peakDate;
  }
  return { peak3yPrice: peakPrice, peak3yDate: peakDate };
}

// ---------- Response schemas ----------

const quoteOut = z.object({
  price: z.number(),
  change: z.number().nullable(),
  change_percent: z.number().nullable(),
  prev_close: z.number().nullable(),
  as_of: z.string().nullable(),
  quote_date: z.string().nullable(),
});

const holdingOut = z.object({
  id: z.number(),
  symbol: z.string(),
  name: z.string(),
  qty: z.number(),
  cost_per_share: z.number(),
  kind: z.string(),
  quote: quoteOut.nullable(),
});

const marketOut = z.object({
  key: z.string(),
  label: z.string(),
  price: z.number().nullable(),
  change: z.number().nullable(),
  change_percent: z.number().nullable(),
  as_of: z.string().nullable(),
  peak3y_price: z.number().nullable(),
  peak3y_date: z.string().nullable(),
});

const snapshotOut = z.object({
  date: z.string(),
  account_value_cny: z.number(),
  securities_value_cny: z.number(),
  cash_cny: z.number(),
  total_pnl_cny: z.number().nullable(),
  day_change_cny: z.number().nullable(),
  day_change_pct: z.number().nullable(),
  csi300_price: z.number().nullable(),
  csi300_change_pct: z.number().nullable(),
  source: z.string(),
});

const boardResponse = z.object({
  holdings: z.array(holdingOut),
  // Null until the user records a cash balance.
  cash_cny: z.number().nullable(),
  cash_updated_at: z.string().nullable(),
  market: z.array(marketOut),
  history: z.array(snapshotOut),
  // ISO instant of the most recent quote fetch (any instrument).
  fetched_at: z.string().nullable(),
});

type BoardResponse = z.infer<typeof boardResponse>;

function toSnapshotOut(
  s: typeof schema.dailySnapshots.$inferSelect,
): z.infer<typeof snapshotOut> {
  return {
    date: s.date,
    account_value_cny: s.accountValueCny,
    securities_value_cny: s.securitiesValueCny,
    cash_cny: s.cashCny,
    total_pnl_cny: s.totalPnlCny,
    day_change_cny: s.dayChangeCny,
    day_change_pct: s.dayChangePct,
    csi300_price: s.csi300Price,
    csi300_change_pct: s.csi300ChangePct,
    source: s.source,
  };
}

// Loads the whole board in stored-quote terms (no fetching): holdings
// joined with their latest stored quotes, the cash row, the benchmark
// strip (always all ten rows, in the fixed display order, values null
// before the first refresh), and the snapshot history (newest first).
async function loadBoard(ctx: Ctx): Promise<BoardResponse> {
  const db = ctx.db<typeof schema>();
  const [holdingRows, quoteRows, stateRows, marketRows, snapRows] =
    await Promise.all([
      db.select().from(schema.holdings),
      db.select().from(schema.quoteSnapshots),
      db.select().from(schema.accountState),
      db.select().from(schema.marketSnapshots),
      db
        .select()
        .from(schema.dailySnapshots)
        .orderBy(desc(schema.dailySnapshots.date)),
    ]);
  const bySymbol = new Map(quoteRows.map((q) => [q.symbol, q]));
  const holdings: z.infer<typeof holdingOut>[] = holdingRows.map((h) => {
    const q = bySymbol.get(h.symbol);
    return {
      id: h.id,
      symbol: h.symbol,
      name: h.name,
      qty: h.qty,
      cost_per_share: h.costPerShare,
      kind: h.kind,
      quote:
        q && q.price != null
          ? {
              price: q.price,
              change: q.change,
              change_percent: q.changePercent,
              prev_close: q.prevClose,
              as_of: q.asOf,
              quote_date: q.quoteDate,
            }
          : null,
    };
  });
  const marketByKey = new Map(marketRows.map((m) => [m.key, m]));
  const market: z.infer<typeof marketOut>[] = BENCHMARKS.map((b) => {
    const m = marketByKey.get(b.key);
    return {
      key: b.key,
      label: b.label,
      price: m?.price ?? null,
      change: m?.change ?? null,
      change_percent: m?.changePercent ?? null,
      as_of: m?.asOf ?? null,
      peak3y_price: m?.peak3yPrice ?? null,
      peak3y_date: m?.peak3yDate ?? null,
    };
  });
  const stamps: number[] = [];
  for (const q of quoteRows) stamps.push(q.fetchedAt.getTime());
  for (const m of marketRows) stamps.push(m.fetchedAt.getTime());
  const state = stateRows[0];
  return {
    holdings,
    cash_cny: state?.cashCny ?? null,
    cash_updated_at: state ? state.updatedAt.toISOString() : null,
    market,
    history: snapRows.map(toSnapshotOut),
    fetched_at:
      stamps.length > 0
        ? new Date(Math.max(...stamps)).toISOString()
        : null,
  };
}

// ---------- Refresh ----------

type RefreshOutcome = {
  updated: number;
  failed: string[];
  // Beijing date of the benchmark quotes (the market's trading day),
  // null when no benchmark quote landed.
  quoteDate: string | null;
  board: BoardResponse;
};

// Fetches Eastmoney realtime quotes for the ten benchmarks and every
// holding, upserts the stored quotes, maintains the benchmark 3-year
// peaks, and returns the reloaded board. A failed instrument keeps its
// stored quote and is reported in `failed`.
async function refreshQuotesInternal(ctx: Ctx): Promise<RefreshOutcome> {
  const db = ctx.db<typeof schema>();
  const holdingRows = await db.select().from(schema.holdings);
  const failed: string[] = [];
  let updated = 0;
  const now = new Date();

  const benchQuotes = await fetchEmBenchmarkQuotes();
  // Gap-fill: a throttled batch response can omit individual rows;
  // give the missing benchmarks one more batch fetch after a pause
  // before any of them is written off as failed.
  const missingBench = BENCHMARKS.filter(
    (b) => !benchQuotes.get(b.secid.toUpperCase()),
  );
  if (missingBench.length > 0) {
    await new Promise((r) => setTimeout(r, 2500));
    const retryQuotes = await fetchEmBenchmarkQuotes();
    for (const b of missingBench) {
      const q = retryQuotes.get(b.secid.toUpperCase());
      if (q) benchQuotes.set(b.secid.toUpperCase(), q);
    }
  }
  const marketRows = await db.select().from(schema.marketSnapshots);
  const marketByKey = new Map(marketRows.map((m) => [m.key, m]));
  let quoteDate: string | null = null;
  for (const b of BENCHMARKS) {
    const q = benchQuotes.get(b.secid.toUpperCase());
    if (!q) {
      failed.push(b.label);
      continue;
    }
    // Only the A-share session benchmarks certify the trading day
    // (see BENCHMARKS): the moved-over instruments trade on other
    // calendars and their quote dates can be a day ahead.
    if (b.cnDate && q.quoteDate) quoteDate = q.quoteDate;
    const existing = marketByKey.get(b.key);
    const peak = await resolvePeak3y(
      {
        peak3yPrice: existing?.peak3yPrice ?? null,
        peak3yDate: existing?.peak3yDate ?? null,
      },
      b.secid,
      q.price,
      q.quoteDate,
    );
    const values = {
      key: b.key,
      label: b.label,
      secid: b.secid,
      price: q.price,
      change: q.change,
      changePercent: q.changePercent,
      asOf: q.asOf,
      peak3yPrice: peak.peak3yPrice,
      peak3yDate: peak.peak3yDate,
      fetchedAt: now,
    };
    await db
      .insert(schema.marketSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: schema.marketSnapshots.key,
        set: values,
      });
    updated += 1;
  }

  const storeHoldingQuote = async (
    h: (typeof holdingRows)[number],
  ): Promise<boolean> => {
    const q = await fetchEmQuote(secidForSymbol(h.symbol));
    if (!q) return false;
    const values = {
      symbol: h.symbol,
      price: q.price,
      change: q.change,
      changePercent: q.changePercent,
      prevClose: q.prevClose,
      asOf: q.asOf,
      quoteDate: q.quoteDate,
      source: "eastmoney",
      fetchedAt: now,
    };
    await db
      .insert(schema.quoteSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: schema.quoteSnapshots.symbol,
        set: values,
      });
    // The quote feed is the authority for the instrument's name; keep
    // the stored name in sync when the feed provides one.
    if (q.name && q.name !== h.name) {
      await db
        .update(schema.holdings)
        .set({ name: q.name })
        .where(eq(schema.holdings.id, h.id));
    }
    updated += 1;
    return true;
  };
  const failedHoldings: typeof holdingRows = [];
  for (const h of holdingRows) {
    if (!(await storeHoldingQuote(h))) failedHoldings.push(h);
  }
  if (failedHoldings.length > 0) {
    // Second-chance sweep: the per-instrument endpoint drops
    // individual requests intermittently, and a symbol that failed
    // the first pass usually answers a few seconds later. Without
    // this sweep a refresh that reported success (fresh 刷新于 stamp
    // from the instruments that did update) silently left part of
    // the book showing the previous session's price and 涨跌幅 —
    // the failure the user reported on 2026-11-16, when 5 of 14
    // holdings kept their 11/13 quotes through a 09:55 refresh.
    await new Promise((r) => setTimeout(r, 2500));
    for (const h of failedHoldings) {
      if (!(await storeHoldingQuote(h))) failed.push(h.symbol);
    }
  }

  const board = await loadBoard(ctx);
  return { updated, failed, quoteDate, board };
}

// ---------- Snapshots ----------

// Account totals from a board payload, or null when they cannot be
// stated on the close basis: every holding must carry a quote and the
// cash balance must be recorded.
function boardTotals(board: BoardResponse): {
  securities: number;
  totalCost: number;
  cash: number;
  total: number;
  pnl: number;
} | null {
  if (board.cash_cny == null) return null;
  let securities = 0;
  let totalCost = 0;
  for (const h of board.holdings) {
    if (!h.quote) return null;
    securities += h.quote.price * h.qty;
    totalCost += h.cost_per_share * h.qty;
  }
  return {
    securities,
    totalCost,
    cash: board.cash_cny,
    total: securities + board.cash_cny,
    pnl: securities - totalCost,
  };
}

// Writes (or overwrites) the snapshot row for `date` from the current
// board state, with the day change taken against the previous
// snapshot row. Returns false when totals cannot be stated.
async function writeSnapshot(
  ctx: Ctx,
  date: string,
  source: string,
): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const board = await loadBoard(ctx);
  const totals = boardTotals(board);
  if (!totals) return false;
  const rows = await db
    .select()
    .from(schema.dailySnapshots)
    .orderBy(asc(schema.dailySnapshots.date));
  const prev = rows.filter((r) => r.date < date).at(-1);
  const dayChange = prev ? totals.total - prev.accountValueCny : null;
  const csi = board.market.find((m) => m.key === "CSI300");
  const values = {
    date,
    accountValueCny: totals.total,
    securitiesValueCny: totals.securities,
    cashCny: totals.cash,
    totalPnlCny: totals.pnl,
    dayChangeCny: dayChange,
    dayChangePct:
      dayChange != null && prev && prev.accountValueCny > 0
        ? (dayChange / prev.accountValueCny) * 100
        : null,
    csi300Price: csi?.price ?? null,
    csi300ChangePct: csi?.change_percent ?? null,
    source,
    createdAt: new Date(),
  };
  await db
    .insert(schema.dailySnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: schema.dailySnapshots.date,
      set: values,
    });
  return true;
}

// Recomputes one snapshot row from per-symbol closes on its own date.
// Holdings quantities and cost pools are replayed from the trade
// ledger as of that date (a symbol with no ledger entries keeps its
// current quantity and cost — it never moved through the ledger);
// cash is the row's own stored cash for older rows and the current
// cash for the latest row. A close that cannot be sourced (no stored
// close for the latest row, no kline close for an older row) fails
// the row WITHOUT writing — the stored row stays as the fallback
// record rather than a partial figure being invented.
async function recomputeSnapshotRow(
  ctx: Ctx,
  target: typeof schema.dailySnapshots.$inferSelect,
  board: BoardResponse,
  allTrades: (typeof schema.trades.$inferSelect)[],
  storedQuotes: Map<string, typeof schema.quoteSnapshots.$inferSelect>,
  isLatest: boolean,
): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const date = target.date;
  let securities = 0;
  let totalCost = 0;
  for (const h of board.holdings) {
    const entries = allTrades.filter(
      (t) => t.symbol === h.symbol && t.date <= date,
    );
    let qty = h.qty;
    let costPer = h.cost_per_share;
    if (entries.length > 0) {
      const acc = replayDilutedCost(entries);
      qty = acc.qty;
      costPer =
        acc.qty > 0 && acc.poolKnown ? acc.pool / acc.qty : h.cost_per_share;
    }
    if (qty <= 0) continue;
    let close: number | null = null;
    if (isLatest) {
      close = storedQuotes.get(h.symbol)?.price ?? null;
    } else {
      const rows = await fetchEmKlines(
        secidForSymbol(h.symbol),
        shiftDate(date, -10).replaceAll("-", ""),
      );
      const eligible = (rows ?? []).filter((r) => r.date <= date);
      close = eligible.at(-1)?.close ?? null;
    }
    if (close == null || !(close > 0)) return false;
    securities += close * qty;
    totalCost += costPer * qty;
  }
  const cash = isLatest ? (board.cash_cny ?? target.cashCny) : target.cashCny;
  await db
    .update(schema.dailySnapshots)
    .set({
      accountValueCny: securities + cash,
      securitiesValueCny: securities,
      cashCny: cash,
      totalPnlCny: securities - totalCost,
    })
    .where(eq(schema.dailySnapshots.date, date));
  return true;
}

// Recomputes snapshot rows from `fromDate` forward (ascending), then
// re-derives every affected row's day change against its previous row
// (the row before fromDate included as the chain's base). Latest-row
// edits (fromDate undefined) recompute just the newest snapshot.
async function recomputeSnapshots(
  ctx: Ctx,
  fromDate?: string,
): Promise<{ recomputed: string[]; skipped: string[] }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.dailySnapshots)
    .orderBy(asc(schema.dailySnapshots.date));
  if (rows.length === 0) return { recomputed: [], skipped: [] };
  const startIdx = fromDate
    ? rows.findIndex((r) => r.date >= fromDate)
    : rows.length - 1;
  if (startIdx < 0) return { recomputed: [], skipped: [] };
  const board = await loadBoard(ctx);
  const allTrades = await db
    .select()
    .from(schema.trades)
    .orderBy(asc(schema.trades.date), asc(schema.trades.id));
  const quoteRows = await db.select().from(schema.quoteSnapshots);
  const storedQuotes = new Map(quoteRows.map((q) => [q.symbol, q]));
  const recomputed: string[] = [];
  const skipped: string[] = [];
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const ok = await recomputeSnapshotRow(
      ctx,
      row,
      board,
      allTrades,
      storedQuotes,
      i === rows.length - 1,
    );
    if (ok) recomputed.push(row.date);
    else skipped.push(row.date);
  }
  // Re-derive the day-change chain over the recomputed span.
  const fresh = await db
    .select()
    .from(schema.dailySnapshots)
    .orderBy(asc(schema.dailySnapshots.date));
  for (let i = Math.max(startIdx, 1); i < fresh.length; i++) {
    const row = fresh[i];
    const prev = fresh[i - 1];
    if (!row || !prev) continue;
    if (!recomputed.includes(row.date) && i !== startIdx) continue;
    const dayChange = row.accountValueCny - prev.accountValueCny;
    await db
      .update(schema.dailySnapshots)
      .set({
        dayChangeCny: dayChange,
        dayChangePct:
          prev.accountValueCny > 0
            ? (dayChange / prev.accountValueCny) * 100
            : null,
      })
      .where(eq(schema.dailySnapshots.date, row.date));
  }
  return { recomputed, skipped };
}

// Trigger-path wrapper: a failed recompute must never roll back or
// mask the edit that triggered it, so errors fold into the result.
async function tryRecomputeSnapshots(
  ctx: Ctx,
  fromDate?: string,
): Promise<{ recomputed: string[]; skipped: string[] }> {
  try {
    const result = await recomputeSnapshots(ctx, fromDate);
    if (result.recomputed.length > 0) ctx.invalidateQueries();
    return result;
  } catch {
    return { recomputed: [], skipped: [] };
  }
}

// ---------- Trade ledger （交易流水台账） ----------
//
// Pure record of the user's trades. The ledger never feeds holdings
// directly — but recording a backdated trade does trigger the
// snapshot recompute chain from the trade date forward (see
// recomputeSnapshots), because quantities and cost pools as of past
// dates are replayed from these entries.

const tradeSide = z.enum(["buy", "sell"]);
const tradePriceKind = z.enum(["actual", "estimated", "none"]);
const tradeSource = z.enum(["order", "snapshot_diff", "opening", "manual"]);

const tradeRowOut = z.object({
  id: z.number(),
  date: z.string(),
  symbol: z.string(),
  name: z.string().nullable(),
  side: tradeSide,
  qty: z.number(),
  price: z.number().nullable(),
  price_kind: tradePriceKind,
  source: tradeSource,
  note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const settledSymbolOut = z.object({
  symbol: z.string(),
  name: z.string().nullable(),
  // Settled P/L over CLOSED cycles only （已清仓结算）: Σ sell proceeds
  // − Σ buy amounts per closed cycle. Null when unknown (an unpriced
  // trade touched a closed cycle) — never reported as 0.
  settled_cny: z.number().nullable(),
  has_estimated: z.boolean(),
});

const tradesResponse = z.object({
  trades: z.array(tradeRowOut),
  settled: z.object({
    // Sum over valued symbols; null when any symbol's settled P/L is
    // unknown. 0 when no cycle has closed at all. Open positions never
    // appear here — their diluted cost lives on the holdings rows.
    total_cny: z.number().nullable(),
    has_estimated: z.boolean(),
    has_unknown: z.boolean(),
    by_symbol: z.array(settledSymbolOut),
  }),
});

type TradesResponse = z.infer<typeof tradesResponse>;

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
      throw new Error(`${action}: price_kind must be "none" when price is empty`);
    }
    return { price: null, priceKind: "none" };
  }
  const kind = priceKind ?? "actual";
  if (kind === "none") {
    throw new Error(`${action}: price_kind "none" requires an empty price`);
  }
  return { price, priceKind: kind };
}

// Diluted-cost replay （摊薄成本法） for one symbol, entries in
// ascending date order (record order within a date). A "cycle" runs
// from quantity 0 back to quantity 0. Within a cycle a single cost
// pool is kept: a buy adds qty × price to the pool, a sell SUBTRACTS
// qty × price (the proceeds) — sells never settle P/L on their own.
// While the position is open, its diluted cost per share is pool / qty
// (kept as-is, may be ≤ 0).
//
// Settlement is evaluated at TRADING-DAY granularity: a cycle settles
// only when the quantity is 0 after ALL of the symbol's trades on one
// date have been applied — the settled P/L then grows by the cycle's
// (Σ sells − Σ buys), i.e. −pool at that day's close, and the pool
// resets to 0 for the next cycle. A same-day sell-out followed by a
// buy-back is a 做T round trip: the cycle does NOT settle, the pool
// carries over. A buy-back on a later date opens a fresh cycle.
//
// An estimated price participates and flags has_estimated; an entry
// with no price makes the figures it touches unknown — the open pool
// while its cycle is open, and the settled figure once its cycle
// closes — reported as unknown, never as 0. A sell exceeding the
// recorded position likewise taints its cycle.
type DilutedAcc = {
  qty: number;
  pool: number;
  poolKnown: boolean;
  settled: number;
  settledKnown: boolean;
  hasClosedCycle: boolean;
  hasEstimated: boolean;
};

function replayDilutedCost(
  entries: (typeof schema.trades.$inferSelect)[],
): DilutedAcc {
  const acc: DilutedAcc = {
    qty: 0,
    pool: 0,
    poolKnown: true,
    settled: 0,
    settledKnown: true,
    hasClosedCycle: false,
    hasEstimated: false,
  };
  const EPS = 1e-9;
  let i = 0;
  while (i < entries.length) {
    const first = entries[i];
    if (!first) break;
    const date = first.date;
    let dayTouched = false;
    while (i < entries.length) {
      const t = entries[i];
      if (!t || t.date !== date) break;
      i += 1;
      dayTouched = true;
      if (t.priceKind === "estimated" && t.price != null) {
        acc.hasEstimated = true;
      }
      if (t.side === "buy") {
        if (t.price == null) {
          acc.poolKnown = false;
        } else if (acc.poolKnown) {
          acc.pool += t.qty * t.price;
        }
        acc.qty += t.qty;
        continue;
      }
      // sell
      const covered = Math.min(t.qty, Math.max(acc.qty, 0));
      if (t.price == null || covered < t.qty - EPS) {
        acc.poolKnown = false;
      } else if (acc.poolKnown) {
        acc.pool -= covered * t.price;
      }
      acc.qty -= covered;
    }
    if (dayTouched && acc.qty <= EPS) {
      acc.qty = 0;
      acc.hasClosedCycle = true;
      if (acc.poolKnown) {
        acc.settled += -acc.pool;
      } else {
        acc.settledKnown = false;
      }
      acc.pool = 0;
      acc.poolKnown = true;
    }
  }
  return acc;
}

async function loadTrades(ctx: Ctx): Promise<TradesResponse> {
  const db = ctx.db<typeof schema>();
  const [rows, holdingRows] = await Promise.all([
    db
      .select()
      .from(schema.trades)
      .orderBy(asc(schema.trades.date), asc(schema.trades.id)),
    db.select().from(schema.holdings),
  ]);
  const nameBySymbol = new Map(holdingRows.map((h) => [h.symbol, h.name]));
  const bySymbol = new Map<string, (typeof schema.trades.$inferSelect)[]>();
  for (const t of rows) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }
  const by_symbol: z.infer<typeof settledSymbolOut>[] = [];
  let total = 0;
  let hasUnknown = false;
  let hasEstimated = false;
  for (const symbol of [...bySymbol.keys()].sort(cmpStr)) {
    const acc = replayDilutedCost(bySymbol.get(symbol) ?? []);
    if (!acc.hasClosedCycle) continue;
    by_symbol.push({
      symbol,
      name: nameBySymbol.get(symbol) ?? null,
      settled_cny: acc.settledKnown ? acc.settled : null,
      has_estimated: acc.hasEstimated,
    });
    if (!acc.settledKnown) hasUnknown = true;
    else total += acc.settled;
    if (acc.hasEstimated) hasEstimated = true;
  }
  return {
    trades: rows
      .slice()
      .reverse()
      .map((t) => ({
        id: t.id,
        date: t.date,
        symbol: t.symbol,
        name: nameBySymbol.get(t.symbol) ?? null,
        side: t.side,
        qty: t.qty,
        price: t.price,
        price_kind: t.priceKind,
        source: t.source,
        note: t.note,
        created_at: t.createdAt.toISOString(),
        updated_at: t.updatedAt.toISOString(),
      })),
    settled: {
      total_cny: hasUnknown ? null : total,
      has_estimated: hasEstimated,
      has_unknown: hasUnknown,
      by_symbol,
    },
  };
}

// ---------- Export / import ----------
//
// Personal-data backup for the daily 06:50 job: the export carries
// every table (holdings, cash state, trades, snapshots, quotes,
// benchmark rows) as canonical JSON plus a SHA-256 checksum over the
// canonical serialization of `tables`. Import verifies the checksum
// when present, then replaces ONLY the tables the payload carries —
// a payload without a table leaves that table's live rows untouched.

const exportResponse = z.object({
  version: z.literal(1),
  exported_at: z.string(),
  checksum: z.string(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

type ExportPayload = z.infer<typeof exportResponse>;

// Canonical row serialization: keys sorted, rows sorted by each
// table's primary key, timestamps as ISO strings — the same database
// state always produces the same payload (and checksum).
function canonicalRows(
  rows: Record<string, unknown>[],
  keyOf: (r: Record<string, unknown>) => string,
): Record<string, unknown>[] {
  return rows
    .map((r) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(r).sort()) out[k] = r[k];
      return out;
    })
    .sort((a, b) => cmpStr(keyOf(a), keyOf(b)));
}

async function buildExport(ctx: Ctx): Promise<ExportPayload> {
  const db = ctx.db<typeof schema>();
  const [holdings, quotes, state, market, snaps, tradeRows] =
    await Promise.all([
      db.select().from(schema.holdings),
      db.select().from(schema.quoteSnapshots),
      db.select().from(schema.accountState),
      db.select().from(schema.marketSnapshots),
      db.select().from(schema.dailySnapshots),
      db.select().from(schema.trades),
    ]);
  const tables: ExportPayload["tables"] = {
    holdings: canonicalRows(
      holdings.map((h) => ({
        id: h.id,
        symbol: h.symbol,
        name: h.name,
        qty: h.qty,
        cost_per_share: h.costPerShare,
        kind: h.kind,
      })),
      (r) => String(r.symbol),
    ),
    account_state: canonicalRows(
      state.map((s) => ({
        id: s.id,
        cash_cny: s.cashCny,
        updated_at: s.updatedAt.toISOString(),
      })),
      (r) => String(r.id),
    ),
    trades: canonicalRows(
      tradeRows.map((t) => ({
        id: t.id,
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
      })),
      (r) => String(r.id).padStart(12, "0"),
    ),
    daily_snapshots: canonicalRows(
      snaps.map((s) => ({
        date: s.date,
        account_value_cny: s.accountValueCny,
        securities_value_cny: s.securitiesValueCny,
        cash_cny: s.cashCny,
        total_pnl_cny: s.totalPnlCny,
        day_change_cny: s.dayChangeCny,
        day_change_pct: s.dayChangePct,
        csi300_price: s.csi300Price,
        csi300_change_pct: s.csi300ChangePct,
        source: s.source,
        created_at: s.createdAt.toISOString(),
      })),
      (r) => String(r.date),
    ),
    quote_snapshots: canonicalRows(
      quotes.map((q) => ({
        symbol: q.symbol,
        price: q.price,
        change: q.change,
        change_percent: q.changePercent,
        prev_close: q.prevClose,
        as_of: q.asOf,
        quote_date: q.quoteDate,
        source: q.source,
        fetched_at: q.fetchedAt.toISOString(),
      })),
      (r) => String(r.symbol),
    ),
    market_snapshots: canonicalRows(
      market.map((m) => ({
        key: m.key,
        label: m.label,
        secid: m.secid,
        price: m.price,
        change: m.change,
        change_percent: m.changePercent,
        as_of: m.asOf,
        peak3y_price: m.peak3yPrice,
        peak3y_date: m.peak3yDate,
        fetched_at: m.fetchedAt.toISOString(),
      })),
      (r) => String(r.key),
    ),
  };
  const checksum = await checksumOf(tables);
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    checksum,
    tables,
  };
}

// SHA-256 over the UTF-8 encoding of `input`, hex output. Pure
// implementation (the action sandbox exposes no crypto global); used
// only as a content checksum for comparing exports, not for security.
function sha256Hex(input: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15] ?? 0, 7) ^ rotr(w[i - 15] ?? 0, 18) ^ ((w[i - 15] ?? 0) >>> 3);
      const s1 = rotr(w[i - 2] ?? 0, 17) ^ rotr(w[i - 2] ?? 0, 19) ^ ((w[i - 2] ?? 0) >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H as [
      number, number, number, number, number, number, number, number,
    ];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    const add = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) H[i] = ((H[i] ?? 0) + (add[i] ?? 0)) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

async function checksumOf(tables: ExportPayload["tables"]): Promise<string> {
  const canonical: Record<string, unknown> = {};
  for (const k of Object.keys(tables).sort()) canonical[k] = tables[k];
  return sha256Hex(JSON.stringify(canonical));
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const numOr = (v: unknown, fallback: number): number =>
  numOrNull(v) ?? fallback;
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const strOr = (v: unknown, fallback: string): string =>
  strOrNull(v) ?? fallback;
const dateOr = (v: unknown, fallback: Date): Date => {
  const s = strOrNull(v);
  if (!s) return fallback;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d;
};

async function importTables(
  ctx: Ctx,
  tables: ExportPayload["tables"],
): Promise<{ imported: string[] }> {
  const db = ctx.db<typeof schema>();
  const imported: string[] = [];
  const statements: BatchItem<"sqlite">[] = [];
  const now = new Date();
  const rowsOf = (name: string) => tables[name];

  const holdingsRows = rowsOf("holdings");
  if (holdingsRows) {
    statements.push(db.delete(schema.holdings));
    for (const r of holdingsRows) {
      const symbol = strOrNull(r.symbol);
      if (!symbol) continue;
      statements.push(
        db.insert(schema.holdings).values({
          symbol,
          name: strOr(r.name, symbol),
          qty: numOr(r.qty, 0),
          costPerShare: numOr(r.cost_per_share, 0),
          kind:
            r.kind === "fund" || r.kind === "stock" ? r.kind : "etf",
        }),
      );
    }
    imported.push("holdings");
  }
  const stateRows = rowsOf("account_state");
  if (stateRows) {
    statements.push(db.delete(schema.accountState));
    for (const r of stateRows) {
      statements.push(
        db.insert(schema.accountState).values({
          id: 1,
          cashCny: numOrNull(r.cash_cny),
          updatedAt: dateOr(r.updated_at, now),
        }),
      );
    }
    imported.push("account_state");
  }
  const tradeRows = rowsOf("trades");
  if (tradeRows) {
    statements.push(db.delete(schema.trades));
    for (const r of tradeRows) {
      const date = strOrNull(r.date);
      const symbol = strOrNull(r.symbol);
      if (!date || !symbol) continue;
      statements.push(
        db.insert(schema.trades).values({
          date,
          symbol,
          side: r.side === "sell" ? "sell" : "buy",
          qty: numOr(r.qty, 0),
          price: numOrNull(r.price),
          priceKind:
            r.price_kind === "estimated" || r.price_kind === "none"
              ? r.price_kind
              : "actual",
          source:
            r.source === "order" ||
            r.source === "snapshot_diff" ||
            r.source === "opening"
              ? r.source
              : "manual",
          note: strOrNull(r.note),
          createdAt: dateOr(r.created_at, now),
          updatedAt: dateOr(r.updated_at, now),
        }),
      );
    }
    imported.push("trades");
  }
  const snapRows = rowsOf("daily_snapshots");
  if (snapRows) {
    statements.push(db.delete(schema.dailySnapshots));
    for (const r of snapRows) {
      const date = strOrNull(r.date);
      if (!date) continue;
      statements.push(
        db.insert(schema.dailySnapshots).values({
          date,
          accountValueCny: numOr(r.account_value_cny, 0),
          securitiesValueCny: numOr(r.securities_value_cny, 0),
          cashCny: numOr(r.cash_cny, 0),
          totalPnlCny: numOrNull(r.total_pnl_cny),
          dayChangeCny: numOrNull(r.day_change_cny),
          dayChangePct: numOrNull(r.day_change_pct),
          csi300Price: numOrNull(r.csi300_price),
          csi300ChangePct: numOrNull(r.csi300_change_pct),
          source: strOr(r.source, "refresh"),
          createdAt: dateOr(r.created_at, now),
        }),
      );
    }
    imported.push("daily_snapshots");
  }
  const quoteRows = rowsOf("quote_snapshots");
  if (quoteRows) {
    statements.push(db.delete(schema.quoteSnapshots));
    for (const r of quoteRows) {
      const symbol = strOrNull(r.symbol);
      if (!symbol) continue;
      statements.push(
        db.insert(schema.quoteSnapshots).values({
          symbol,
          price: numOrNull(r.price),
          change: numOrNull(r.change),
          changePercent: numOrNull(r.change_percent),
          prevClose: numOrNull(r.prev_close),
          asOf: strOrNull(r.as_of),
          quoteDate: strOrNull(r.quote_date),
          source: strOrNull(r.source),
          fetchedAt: dateOr(r.fetched_at, now),
        }),
      );
    }
    imported.push("quote_snapshots");
  }
  const marketRows = rowsOf("market_snapshots");
  if (marketRows) {
    statements.push(db.delete(schema.marketSnapshots));
    for (const r of marketRows) {
      const key = strOrNull(r.key);
      if (!key) continue;
      statements.push(
        db.insert(schema.marketSnapshots).values({
          key,
          label: strOr(r.label, key),
          secid: strOr(r.secid, ""),
          price: numOrNull(r.price),
          change: numOrNull(r.change),
          changePercent: numOrNull(r.change_percent),
          asOf: strOrNull(r.as_of),
          peak3yPrice: numOrNull(r.peak3y_price),
          peak3yDate: strOrNull(r.peak3y_date),
          fetchedAt: dateOr(r.fetched_at, now),
        }),
      );
    }
    imported.push("market_snapshots");
  }

  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  return { imported };
}

// ---------- Actions ----------

const refreshResponse = z.object({
  updated: z.number(),
  failed: z.array(z.string()),
  board: boardResponse,
});

const intradayRefreshResponse = z.object({
  status: z.enum(["refreshed", "skipped_outside_session"]),
  updated: z.number(),
  failed: z.array(z.string()),
  // Beijing date of the benchmark quotes after a refresh; null when skipped.
  quote_date: z.string().nullable(),
});

const closeSnapshotResponse = z.object({
  status: z.enum(["written", "skipped_non_trading_day", "skipped_incomplete"]),
  // The snapshot date written, or the quote date observed when skipped.
  date: z.string().nullable(),
  board: boardResponse,
});

const baselineSnapshotResponse = z.object({
  status: z.enum(["written", "already_present"]),
  date: z.string(),
  board: boardResponse,
});

const editResponse = z.object({
  ok: z.literal(true),
  snapshot_recomputed: z.array(z.string()),
  snapshot_skipped: z.array(z.string()),
});

type EditResponse = z.infer<typeof editResponse>;

function editResult(r: {
  recomputed: string[];
  skipped: string[];
}): EditResponse {
  return {
    ok: true,
    snapshot_recomputed: r.recomputed,
    snapshot_skipped: r.skipped,
  };
}

const symbolArg = z
  .string()
  .regex(/^\d{6}$/, "symbol must be a 6-digit code");

export const Actions = {
  getBoard: defineAction({
    description:
      "Loads the whole A-share board: holdings with stored quotes, cash, the ten-benchmark strip, and the daily snapshot history.",
    request: z.object({}),
    response: boardResponse,
    async handler(ctx): Promise<BoardResponse> {
      return loadBoard(ctx);
    },
  }),

  refreshQuotes: defineAction({
    description:
      "Fetches Eastmoney realtime quotes for all holdings and the ten benchmarks (five A-share indices plus 恒生科技 / 金龙中国 / 日经225 / 越南胡志明 / 上海黄金； live intraday, closing prices after the close), updates stored quotes and 3-year peaks, and returns the board. Responses with no usable payload (data: null / empty) count as failed attempts and are retried; instruments still failing after a second-chance sweep keep their stored quotes and are named in `failed`. Never writes a snapshot.",
    request: z.object({}),
    response: refreshResponse,
    async handler(ctx): Promise<z.infer<typeof refreshResponse>> {
      const outcome = await refreshQuotesInternal(ctx);
      ctx.invalidateQueries();
      return {
        updated: outcome.updated,
        failed: outcome.failed,
        board: outcome.board,
      };
    },
  }),

  refreshIntradayQuotes: defineAction({
    description:
      "Scheduled intraday refresh (every 30 minutes): refreshes Eastmoney quotes exactly like the manual refreshQuotes, but only inside Beijing A-share trading sessions (Mon–Fri 09:30–11:30 and 13:00–15:00). Outside a session — lunch break, pre/post-market, weekends — it returns skipped_outside_session without fetching or writing anything. Never writes a snapshot. The manual refresh button is not gated by this.",
    request: z.object({}),
    response: intradayRefreshResponse,
    async handler(ctx): Promise<z.infer<typeof intradayRefreshResponse>> {
      if (!inAShareSession()) {
        return {
          status: "skipped_outside_session",
          updated: 0,
          failed: [],
          quote_date: null,
        };
      }
      const outcome = await refreshQuotesInternal(ctx);
      ctx.invalidateQueries();
      return {
        status: "refreshed",
        updated: outcome.updated,
        failed: outcome.failed,
        quote_date: outcome.quoteDate,
      };
    },
  }),

  refreshCloseSnapshot: defineAction({
    description:
      "Scheduled close refresh (weekdays 15:10 Beijing): refreshes all quotes, then writes/updates today's daily snapshot on the close basis — but only when the Eastmoney quote date is today; on non-trading days it writes nothing and reports skipped_non_trading_day.",
    request: z.object({}),
    response: closeSnapshotResponse,
    async handler(ctx): Promise<z.infer<typeof closeSnapshotResponse>> {
      const outcome = await refreshQuotesInternal(ctx);
      const today = beijingToday();
      if (!outcome.quoteDate || outcome.quoteDate !== today) {
        return {
          status: "skipped_non_trading_day",
          date: outcome.quoteDate,
          board: outcome.board,
        };
      }
      const written = await writeSnapshot(ctx, today, "refresh");
      ctx.invalidateQueries();
      if (!written) {
        return {
          status: "skipped_incomplete",
          date: today,
          board: await loadBoard(ctx),
        };
      }
      return { status: "written", date: today, board: await loadBoard(ctx) };
    },
  }),

  seedBaselineSnapshot: defineAction({
    description:
      "One-time write of the first snapshot: the baseline date's (Friday close, opening-entry baseline day) account state exactly as reconciled against the user's broker screenshots, so history has its first point today. Insert-only — a snapshot already stored for that date is left untouched and reported as already_present. After this row exists it is an ordinary snapshot: later edits recompute per the usual rules and the weekday 15:10 close refresh chains its day change from it.",
    request: z.object({}),
    response: baselineSnapshotResponse,
    handler: async (
      ctx,
    ): Promise<z.infer<typeof baselineSnapshotResponse>> => {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.dailySnapshots)
        .where(eq(schema.dailySnapshots.date, "2026-01-09"));
      if (existing.length > 0) {
        return {
          status: "already_present",
          date: "2026-01-09",
          board: await loadBoard(ctx),
        };
      }
      // Figures supplied by the user in the edit brief, reconciled
      // to the cent against the broker screenshots: totals
      // ¥100,000.00 = securities ¥90,000.00 + cash ¥10,000.00;
      // unrealised P/L +¥5,000.00 on the broker displayed-cost
      // basis; Friday day P/L +¥100.00 (+0.10%), verified as the
      // per-holding sum, not derived; CSI 300 close 4000.00
      // (+0.50%).
      await db.insert(schema.dailySnapshots).values({
        date: "2026-01-09",
        accountValueCny: 100000,
        securitiesValueCny: 90000,
        cashCny: 10000,
        totalPnlCny: 5000,
        dayChangeCny: 100,
        dayChangePct: 0.1,
        csi300Price: 4000,
        csi300ChangePct: 0.5,
        source: "manual",
        createdAt: new Date(),
      });
      ctx.invalidateQueries();
      return {
        status: "written",
        date: "2026-01-09",
        board: await loadBoard(ctx),
      };
    },
  }),

  addHolding: defineAction({
    description:
      "Adds a holding (6-digit code, name, quantity, cost per share) and recomputes the latest snapshot.",
    request: z.object({
      symbol: symbolArg,
      name: z.string().min(1),
      qty: z.number().positive(),
      cost_per_share: z.number().min(0),
      kind: z.enum(["etf", "fund", "stock"]).default("etf"),
    }),
    response: editResponse,
    async handler(ctx, args): Promise<EditResponse> {
      const db = ctx.db<typeof schema>();
      await db.insert(schema.holdings).values({
        symbol: args.symbol,
        name: args.name,
        qty: args.qty,
        costPerShare: args.cost_per_share,
        kind: args.kind,
      });
      ctx.invalidateQueries();
      return editResult(await tryRecomputeSnapshots(ctx));
    },
  }),

  updateHolding: defineAction({
    description:
      "Updates a holding's quantity, cost per share, or name, and recomputes the latest snapshot.",
    request: z.object({
      id: z.number().int().positive(),
      qty: z.number().positive().optional(),
      cost_per_share: z.number().min(0).optional(),
      name: z.string().min(1).optional(),
    }),
    response: editResponse,
    async handler(ctx, args): Promise<EditResponse> {
      const db = ctx.db<typeof schema>();
      const set: Partial<typeof schema.holdings.$inferInsert> = {};
      if (args.qty != null) set.qty = args.qty;
      if (args.cost_per_share != null) set.costPerShare = args.cost_per_share;
      if (args.name != null) set.name = args.name;
      if (Object.keys(set).length > 0) {
        await db
          .update(schema.holdings)
          .set(set)
          .where(eq(schema.holdings.id, args.id));
      }
      ctx.invalidateQueries();
      return editResult(await tryRecomputeSnapshots(ctx));
    },
  }),

  removeHolding: defineAction({
    description:
      "Removes a holding row and recomputes the latest snapshot. Trade ledger entries for the symbol are kept.",
    request: z.object({ id: z.number().int().positive() }),
    response: editResponse,
    async handler(ctx, args): Promise<EditResponse> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.holdings)
        .where(eq(schema.holdings.id, args.id));
      ctx.invalidateQueries();
      return editResult(await tryRecomputeSnapshots(ctx));
    },
  }),

  updateCash: defineAction({
    description:
      "Sets (or clears, with null) the account cash balance in CNY and recomputes the latest snapshot.",
    request: z.object({ cash_cny: z.number().min(0).nullable() }),
    response: editResponse,
    async handler(ctx, args): Promise<EditResponse> {
      const db = ctx.db<typeof schema>();
      const values = {
        id: 1,
        cashCny: args.cash_cny,
        updatedAt: new Date(),
      };
      await db
        .insert(schema.accountState)
        .values(values)
        .onConflictDoUpdate({
          target: schema.accountState.id,
          set: values,
        });
      ctx.invalidateQueries();
      return editResult(await tryRecomputeSnapshots(ctx));
    },
  }),

  getTrades: defineAction({
    description:
      "Lists the trade ledger (newest first) plus settled P/L per symbol under the diluted-cost method — closed cycles only.",
    request: z.object({}),
    response: tradesResponse,
    async handler(ctx): Promise<TradesResponse> {
      return loadTrades(ctx);
    },
  }),

  addTrade: defineAction({
    description:
      "Records a trade in the ledger (record-only; holdings are not changed). Recomputes snapshots from the trade date forward.",
    request: z.object({
      date: z.string(),
      symbol: symbolArg,
      side: tradeSide,
      qty: z.number().positive(),
      price: z.number().positive().nullable().optional(),
      price_kind: tradePriceKind.optional(),
      source: tradeSource.default("manual"),
      note: z.string().nullable().optional(),
    }),
    response: editResponse,
    async handler(ctx, args): Promise<EditResponse> {
      assertDate("addTrade", args.date);
      const { price, priceKind } = normalizeTradePrice(
        "addTrade",
        args.price,
        args.price_kind,
      );
      const db = ctx.db<typeof schema>();
      const now = new Date();
      await db.insert(schema.trades).values({
        date: args.date,
        symbol: args.symbol,
        side: args.side,
        qty: args.qty,
        price,
        priceKind,
        source: args.source,
        note: args.note ?? null,
        createdAt: now,
        updatedAt: now,
      });
      ctx.invalidateQueries();
      return editResult(await tryRecomputeSnapshots(ctx, args.date));
    },
  }),

  updateTrade: defineAction({
    description:
      "Updates a ledger entry and recomputes snapshots from the earlier of its old and new dates forward.",
    request: z.object({
      id: z.number().int().positive(),
      date: z.string().optional(),
      symbol: symbolArg.optional(),
      side: tradeSide.optional(),
      qty: z.number().positive().optional(),
      price: z.number().positive().nullable().optional(),
      price_kind: tradePriceKind.optional(),
      source: tradeSource.optional(),
      note: z.string().nullable().optional(),
    }),
    response: editResponse,
    async handler(ctx, args): Promise<EditResponse> {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.id, args.id));
      const row = existing[0];
      if (!row) throw new Error(`updateTrade: no trade with id ${args.id}`);
      const date = args.date ?? row.date;
      assertDate("updateTrade", date);
      const touchesPrice =
        args.price !== undefined || args.price_kind !== undefined;
      const { price, priceKind } = touchesPrice
        ? normalizeTradePrice(
            "updateTrade",
            args.price !== undefined ? args.price : row.price,
            args.price_kind ?? row.priceKind,
          )
        : { price: row.price, priceKind: row.priceKind };
      await db
        .update(schema.trades)
        .set({
          date,
          symbol: args.symbol ?? row.symbol,
          side: args.side ?? row.side,
          qty: args.qty ?? row.qty,
          price,
          priceKind,
          source: args.source ?? row.source,
          note: args.note !== undefined ? args.note : row.note,
          updatedAt: new Date(),
        })
        .where(eq(schema.trades.id, args.id));
      ctx.invalidateQueries();
      const from = row.date < date ? row.date : date;
      return editResult(await tryRecomputeSnapshots(ctx, from));
    },
  }),

  deleteTrade: defineAction({
    description:
      "Deletes a ledger entry and recomputes snapshots from its date forward.",
    request: z.object({ id: z.number().int().positive() }),
    response: editResponse,
    async handler(ctx, args): Promise<EditResponse> {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.id, args.id));
      const row = existing[0];
      if (!row) throw new Error(`deleteTrade: no trade with id ${args.id}`);
      await db.delete(schema.trades).where(eq(schema.trades.id, args.id));
      ctx.invalidateQueries();
      return editResult(await tryRecomputeSnapshots(ctx, row.date));
    },
  }),

  exportData: defineAction({
    description:
      "Exports all personal data tables (holdings, cash, trades, snapshots, quotes, benchmarks) as canonical JSON with a SHA-256 checksum, for the daily backup.",
    request: z.object({}),
    response: exportResponse,
    async handler(ctx): Promise<ExportPayload> {
      return buildExport(ctx);
    },
  }),

  importData: defineAction({
    description:
      "Imports a backup payload produced by exportData: verifies the checksum when present, then replaces only the tables the payload carries; tables absent from the file are left untouched.",
    request: z.object({
      payload: z.object({
        version: z.number().optional(),
        checksum: z.string().optional(),
        tables: z.record(
          z.string(),
          z.array(z.record(z.string(), z.unknown())),
        ),
      }),
    }),
    response: z.object({
      ok: z.literal(true),
      imported: z.array(z.string()),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; imported: string[] }> {
      const { payload } = args;
      if (payload.checksum) {
        const actual = await checksumOf(payload.tables);
        if (actual !== payload.checksum) {
          throw new Error("importData: checksum mismatch — file rejected");
        }
      }
      const { imported } = await importTables(ctx, payload.tables);
      ctx.invalidateQueries();
      return { ok: true as const, imported };
    },
  }),
} satisfies ActionsModule;
