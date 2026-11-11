// Actions for 看板 · 全天动态.
//
// Data split (per the build brief):
// - The quote strip is fetched by the server itself (refreshStrip, cron every
//   30 minutes; getStream lazily refreshes when the snapshot is stale).
// - Events are appended ONLY by the user's agent after verification
//   (appendEvent). The page never fetches or invents news.
// - Events older than 7 days are pruned on every write/read path.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, desc, eq, inArray, lt } from "drizzle-orm";
import * as schema from "./schema";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const STRIP_STALE_MS = 30 * 60 * 1000;

const stripItem = z.object({
  key: z.enum(["nq", "es", "gold", "brent", "dxy"]),
  label: z.string(),
  price: z.number().nullable(),
  changePct: z.number().nullable(),
  asOf: z.string().nullable(),
});
type StripItem = z.infer<typeof stripItem>;

const mover = z.object({
  ticker: z.string().min(1).max(10),
  // Display string, e.g. "$185.00" — may carry a session note ("$185.00 盘前").
  price: z.string().min(1).max(60),
  // Numeric move vs the regular close, e.g. -4.58 means ▼-4.58%.
  changePct: z.number().finite(),
});
type Mover = z.infer<typeof mover>;

const eventOut = z.object({
  id: z.number(),
  category: z.enum(schema.CATEGORIES),
  title: z.string(),
  keyNumbers: z.string().nullable(),
  note: z.string(),
  impact: z.string().nullable(),
  tickers: z.array(z.string()),
  movers: z.array(mover),
  eventTime: z.string(),
});

const eventUpdateResponse = z.object({
  ok: z.literal(true),
  updated: z.boolean(),
  id: z.number(),
});

const node = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "time must be HH:MM")
    .nullable()
    .optional(),
  event: z.string().min(1).max(200),
  tickers: z.array(z.string().min(1).max(10)).max(20).optional().default([]),
});
type UpcomingNode = z.infer<typeof node>;

const streamResponse = z.object({
  strip: z.array(stripItem),
  stripFetchedAt: z.string().nullable(),
  nodes: z.array(node),
  events: z.array(eventOut),
});
type StreamResponse = z.infer<typeof streamResponse>;

async function pruneOld(db: ReturnType<Ctx["db"]>) {
  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS);
  await db.delete(schema.events).where(lt(schema.events.eventTime, cutoff));
}

async function fetchYahoo(symbol: string): Promise<{ price: number; changePct: number; asOf: string } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    };
    const meta = json.chart?.result?.[0]?.meta;
    const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    const prev = typeof meta?.chartPreviousClose === "number" ? meta.chartPreviousClose : null;
    const time = typeof meta?.regularMarketTime === "number" ? meta.regularMarketTime : null;
    if (price == null || prev == null || prev === 0) return null;
    return {
      price,
      changePct: ((price - prev) / prev) * 100,
      asOf: time != null ? new Date(time * 1000).toISOString() : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function fetchSinaSpotGold(): Promise<{ price: number; changePct: number; asOf: string } | null> {
  try {
    const res = await fetch("https://hq.sinajs.cn/list=hf_XAU", {
      headers: { Referer: "https://finance.sina.com.cn" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const match = text.match(/"([^"]*)"/);
    if (!match?.[1]) return null;
    const fields = match[1].split(",");
    const price = Number(fields[0]);
    const prevClose = Number(fields[7]);
    if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose === 0) return null;
    return { price, changePct: ((price - prevClose) / prevClose) * 100, asOf: new Date().toISOString() };
  } catch {
    return null;
  }
}

const STRIP_DEFS: Array<{ key: StripItem["key"]; label: string }> = [
  { key: "nq", label: "纳指100期货" },
  { key: "es", label: "标普500期货" },
  { key: "gold", label: "现货黄金" },
  { key: "brent", label: "布伦特原油" },
  { key: "dxy", label: "美元指数" },
];

async function fetchStripFresh(): Promise<StripItem[]> {
  const [nq, es, goldSina, brent, dxy] = await Promise.all([
    fetchYahoo("NQ=F"),
    fetchYahoo("ES=F"),
    fetchSinaSpotGold(),
    fetchYahoo("BZ=F"),
    fetchYahoo("DX-Y.NYB"),
  ]);
  let gold = goldSina;
  if (!gold) gold = await fetchYahoo("GC=F");
  const byKey: Record<StripItem["key"], { price: number; changePct: number; asOf: string } | null> = {
    nq, es, gold, brent, dxy,
  };
  return STRIP_DEFS.map((def) => {
    const q = byKey[def.key];
    return {
      key: def.key,
      label: def.label,
      price: q?.price ?? null,
      changePct: q?.changePct ?? null,
      asOf: q?.asOf ?? null,
    };
  });
}

async function loadLatestSnapshot(db: ReturnType<Ctx["db"]>) {
  const rows = await db
    .select()
    .from(schema.stripSnapshots)
    .orderBy(desc(schema.stripSnapshots.id))
    .limit(1);
  return rows[0] ?? null;
}

function parseItems(raw: string): StripItem[] {
  try {
    const parsed = z.array(stripItem).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Fetch the strip, merge over the previous snapshot for any failed symbol, save, and prune. */
async function refreshStripNow(ctx: Ctx): Promise<{ items: StripItem[]; fetchedAt: Date }> {
  const db = ctx.db<typeof schema>();
  const previous = await loadLatestSnapshot(db);
  const previousItems = previous ? parseItems(previous.items) : [];
  const fresh = await fetchStripFresh();
  const merged = fresh.map((item) => {
    if (item.price != null) return item;
    const old = previousItems.find((p) => p.key === item.key);
    return old ?? item;
  });
  const fetchedAt = new Date();
  await db.insert(schema.stripSnapshots).values({ items: JSON.stringify(merged), fetchedAt });
  // Keep only the latest 3 snapshots.
  const ids = await db
    .select({ id: schema.stripSnapshots.id })
    .from(schema.stripSnapshots)
    .orderBy(desc(schema.stripSnapshots.id));
  const staleIds = ids.slice(3).map((r) => r.id);
  if (staleIds.length > 0) {
    await db.delete(schema.stripSnapshots).where(inArray(schema.stripSnapshots.id, staleIds));
  }
  await pruneOld(db);
  return { items: merged, fetchedAt };
}

function parseTickers(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // fall through
  }
  return [];
}

function parseMovers(raw: string): Mover[] {
  try {
    const parsed = z.array(mover).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function normalizeMovers(list: Mover[]): Mover[] {
  return list
    .map((m) => ({ ticker: m.ticker.trim().toUpperCase(), price: m.price.trim(), changePct: m.changePct }))
    .filter((m) => m.ticker.length > 0 && m.price.length > 0);
}

async function loadStream(ctx: Ctx): Promise<StreamResponse> {
  const db = ctx.db<typeof schema>();
  await pruneOld(db);
  let snapshot = await loadLatestSnapshot(db);
  // A snapshot whose items no longer parse against the current strip keys
  // (e.g. it still holds the retired "wti" cell) counts as stale: refresh now
  // so the old cell never renders.
  if (
    !snapshot ||
    parseItems(snapshot.items).length === 0 ||
    Date.now() - snapshot.fetchedAt.getTime() > STRIP_STALE_MS
  ) {
    const refreshed = await refreshStripNow(ctx);
    snapshot = { id: 0, items: JSON.stringify(refreshed.items), fetchedAt: refreshed.fetchedAt };
  }
  const rows = await db
    .select()
    .from(schema.events)
    .orderBy(desc(schema.events.eventTime), desc(schema.events.id))
    .limit(300);
  const nodeRows = await db
    .select()
    .from(schema.upcomingNodes)
    .orderBy(asc(schema.upcomingNodes.date), asc(schema.upcomingNodes.time), asc(schema.upcomingNodes.id));
  return {
    strip: parseItems(snapshot.items),
    stripFetchedAt: snapshot.fetchedAt.toISOString(),
    nodes: nodeRows.map((row) => ({
      date: row.date,
      time: row.time,
      event: row.event,
      tickers: parseTickers(row.tickers),
    })),
    events: rows.map((row) => ({
      id: row.id,
      category: row.category,
      title: row.title,
      keyNumbers: row.keyNumbers,
      note: row.note,
      impact: row.impact,
      tickers: parseTickers(row.tickers),
      movers: parseMovers(row.movers),
      eventTime: row.eventTime.toISOString(),
    })),
  };
}

export const Actions = {
  getStream: defineAction({
    description: "Returns the current quote strip, the upcoming-nodes list (date ascending), and the event stream (newest first, last 7 days) so the agent can verify what the board shows.",
    request: z.object({}),
    response: streamResponse,
    async handler(ctx): Promise<StreamResponse> {
      return loadStream(ctx);
    },
  }),

  refreshStrip: defineAction({
    description: "Fetches the five strip quotes (NQ/ES futures, spot gold, Brent crude, DXY) from Yahoo/Sina and saves a new strip snapshot.",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      fetchedAt: z.string(),
      items: z.array(stripItem),
    }),
    async handler(ctx) {
      const { items, fetchedAt } = await refreshStripNow(ctx);
      ctx.invalidateQueries();
      return { ok: true as const, fetchedAt: fetchedAt.toISOString(), items };
    },
  }),

  appendEvent: defineAction({
    description: "Appends one verified event to the stream (category, short summary title, key figures, driver/source note, optional one-line impact read, tickers, optional per-stock movers table rows, event time); it appears at the top ordered by event time. For multi-stock move events pass movers ([{ticker, price, changePct}]) and keep per-stock prices/changes out of the title and keyNumbers.",
    request: z.object({
      category: z.enum(schema.CATEGORIES),
      title: z.string().min(1).max(200),
      keyNumbers: z.string().max(200).nullable().optional(),
      note: z.string().min(1).max(1000),
      impact: z.string().max(120).nullable().optional(),
      tickers: z.array(z.string().min(1).max(10)).max(20).default([]),
      movers: z.array(mover).max(30).default([]),
      eventTime: z
        .string()
        .refine((s) => !Number.isNaN(Date.parse(s)), "eventTime must be an ISO 8601 datetime"),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const tickers = args.tickers.map((t) => t.trim().toUpperCase()).filter((t) => t.length > 0);
      const result = await db
        .insert(schema.events)
        .values({
          category: args.category,
          title: args.title.trim(),
          keyNumbers: args.keyNumbers?.trim() ? args.keyNumbers.trim() : null,
          note: args.note.trim(),
          impact: args.impact?.trim() ? args.impact.trim() : null,
          tickers: JSON.stringify(tickers),
          movers: JSON.stringify(normalizeMovers(args.movers)),
          eventTime: new Date(args.eventTime),
        })
        .returning({ id: schema.events.id });
      const inserted = result[0];
      if (!inserted) throw new Error("appendEvent: insert returned no rows");
      await pruneOld(db);
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  updateEvent: defineAction({
    description: "Updates fields of an existing event by id — any subset of title, keyNumbers, note, impact, tickers, movers, eventTime, category. Pass null for keyNumbers or impact to clear that field; pass movers: [] to clear the movers table.",
    request: z.object({
      id: z.number().int().positive(),
      title: z.string().min(1).max(200).optional(),
      keyNumbers: z.string().max(200).nullable().optional(),
      note: z.string().min(1).max(1000).optional(),
      impact: z.string().max(120).nullable().optional(),
      tickers: z.array(z.string().min(1).max(10)).max(20).optional(),
      movers: z.array(mover).max(30).optional(),
      eventTime: z
        .string()
        .refine((s) => !Number.isNaN(Date.parse(s)), "eventTime must be an ISO 8601 datetime")
        .optional(),
      category: z.enum(schema.CATEGORIES).optional(),
    }),
    response: eventUpdateResponse,
    async handler(ctx, args): Promise<z.infer<typeof eventUpdateResponse>> {
      const db = ctx.db<typeof schema>();
      const patch: Partial<{
        category: (typeof schema.CATEGORIES)[number];
        title: string;
        keyNumbers: string | null;
        note: string;
        impact: string | null;
        tickers: string;
        movers: string;
        eventTime: Date;
      }> = {};
      if (args.category !== undefined) patch.category = args.category;
      if (args.title !== undefined) patch.title = args.title.trim();
      if (args.keyNumbers !== undefined) {
        patch.keyNumbers = args.keyNumbers?.trim() ? args.keyNumbers.trim() : null;
      }
      if (args.note !== undefined) patch.note = args.note.trim();
      if (args.impact !== undefined) {
        patch.impact = args.impact?.trim() ? args.impact.trim() : null;
      }
      if (args.tickers !== undefined) {
        const tickers = args.tickers
          .map((t) => t.trim().toUpperCase())
          .filter((t) => t.length > 0);
        patch.tickers = JSON.stringify(tickers);
      }
      if (args.movers !== undefined) {
        patch.movers = JSON.stringify(normalizeMovers(args.movers));
      }
      if (args.eventTime !== undefined) patch.eventTime = new Date(args.eventTime);
      if (Object.keys(patch).length === 0) {
        return { ok: true as const, updated: false, id: args.id };
      }
      const result = await db
        .update(schema.events)
        .set(patch)
        .where(eq(schema.events.id, args.id))
        .returning({ id: schema.events.id });
      await pruneOld(db);
      ctx.invalidateQueries();
      return { ok: true as const, updated: result.length > 0, id: args.id };
    },
  }),

  setUpcomingNodes: defineAction({
    description: "Replaces the full upcoming-nodes list shown at the top of the board (earnings dates, macro releases and other known schedule points). The passed array is the complete current list; an empty array clears it. Returns how many nodes were written.",
    request: z.object({
      nodes: z.array(node).max(100),
    }),
    response: z.object({ written: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows: Array<typeof schema.upcomingNodes.$inferInsert> = args.nodes.map((n) => ({
        date: n.date,
        time: n.time?.trim() ? n.time.trim() : null,
        event: n.event.trim(),
        tickers: JSON.stringify(
          n.tickers.map((t) => t.trim().toUpperCase()).filter((t) => t.length > 0),
        ),
      }));
      await db.delete(schema.upcomingNodes);
      if (rows.length > 0) {
        await db.insert(schema.upcomingNodes).values(rows);
      }
      ctx.invalidateQueries();
      return { written: rows.length };
    },
  }),
} satisfies ActionsModule;
