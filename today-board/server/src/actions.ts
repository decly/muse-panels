// Actions for 看板 · 今日页 (daily today page).
//
// Data flow (see DATA-PLAN.md):
// - Account totals + overnight movers come from the two source boards
//   （投资组合看板 / 投资历史看板） through the assistant, which reads those
//   boards' public actions and pushes the digest here via `pushDigest`.
//   Artifacts cannot call each other's actions server-side, so this push
//   channel is the sync path — the same pattern as the history board's
//   recordSnapshot sync endpoint.
// - Gold (spot XAU/USD + SGE Au99.99, Sina feed — never COMEX) and the
//   benchmark index closes (Yahoo chart API) are pulled by `refreshToday`
//   itself and cached in market_cache.
// - Events are stored rows maintained by the assistant via
//   `upsertEvent` / `deleteEvent`, seeded once with the user-supplied list.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, lte, eq, count } from "drizzle-orm";
import * as schema from "./schema";

// ---------- shared shapes ----------

const accountShape = z.object({
  id: z.enum(["global", "broker-a", "broker-b"]),
  label: z.string().min(1),
  total_usd: z.number().nullable(),
  day_change_usd: z.number().nullable(),
  day_change_pct: z.number().nullable(),
});

const moverShape = z.object({
  symbol: z.string().min(1),
  change_pct: z.number().nullable(),
  close: z.number().nullable(),
  after_hours_note: z.string().nullable().optional(),
});

const goldPoint = z.object({
  price: z.number().nullable(),
  prev_close: z.number().nullable(),
  change_pct: z.number().nullable(),
});

const goldPayload = z.object({
  xau: goldPoint,
  sgold: goldPoint,
  source_date: z.string().nullable(),
});

const indexPoint = z.object({
  key: z.string(),
  label: z.string(),
  price: z.number().nullable(),
  change_pct: z.number().nullable(),
});

const eventShape = z.object({
  id: z.number(),
  date: z.string(),
  time_text: z.string().nullable(),
  title: z.string(),
  kind: z.string(),
  note: z.string().nullable(),
});

type GoldPayload = z.infer<typeof goldPayload>;
type IndexPoint = z.infer<typeof indexPoint>;

// ---------- helpers ----------

// Beijing (Asia/Shanghai) calendar date of an instant, YYYY-MM-DD.
function beijingDateString(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const WEEKDAY_NAMES = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
] as const;

// Weekday label derived from a stored YYYY-MM-DD calendar date — never
// from the read instant.
function weekdayOfDate(dateStr: string): string {
  const [y = 1970, m = 1, d = 1] = dateStr.split("-").map(Number);
  return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
}

function beijingToday(): { date: string } {
  return { date: beijingDateString(new Date()) };
}

function addDays(dateStr: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function getSection(
  ctx: Ctx,
  key: string,
): Promise<{ value: unknown; updatedAt: Date } | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.digestSections)
    .where(eq(schema.digestSections.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as unknown, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

async function setSection(ctx: Ctx, key: string, value: unknown): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const serialized = JSON.stringify(value);
  await db
    .insert(schema.digestSections)
    .values({ key, value: serialized, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.digestSections.key,
      set: { value: serialized, updatedAt: now },
    });
}

// 期号日期 (issue date): the Beijing calendar date of the most recent
// content write — pushDigest sections or a refreshToday market pull.
// Persisted as the "issue_date" digest section so the page header always
// shows the date of the report it is displaying, not the read date.
async function touchIssueDate(ctx: Ctx): Promise<void> {
  await setSection(ctx, "issue_date", { date: beijingDateString(new Date()) });
}

async function getCache(
  ctx: Ctx,
  key: string,
): Promise<{ payload: unknown; fetchedAt: Date } | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.marketCache)
    .where(eq(schema.marketCache.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    return { payload: JSON.parse(row.payload) as unknown, fetchedAt: row.fetchedAt };
  } catch {
    return null;
  }
}

async function setCache(ctx: Ctx, key: string, payload: unknown): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const serialized = JSON.stringify(payload);
  await db
    .insert(schema.marketCache)
    .values({ key, payload: serialized, fetchedAt: now })
    .onConflictDoUpdate({
      target: schema.marketCache.key,
      set: { payload: serialized, fetchedAt: now },
    });
}

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function pct(price: number | null, prev: number | null): number | null {
  if (price == null || prev == null || prev === 0) return null;
  return ((price - prev) / prev) * 100;
}

// Sina feed: field [0] = last price, field [7] = previous close, [12] = date.
async function fetchSinaGold(): Promise<GoldPayload | null> {
  try {
    const r = await fetch("https://hq.sinajs.cn/list=hf_XAU,gds_AU9999", {
      headers: { Referer: "https://finance.sina.com.cn" },
    });
    if (!r.ok) return null;
    const text = await r.text();
    const grab = (name: string): string[] | null => {
      const m = text.match(new RegExp(`hq_str_${name}="([^"]*)"`));
      if (!m || !m[1]) return null;
      return m[1].split(",");
    };
    const xauF = grab("hf_XAU");
    const sgF = grab("gds_AU9999");
    if (!xauF && !sgF) return null;
    const point = (f: string[] | null) => {
      const price = f ? num(f[0]) : null;
      const prev = f ? num(f[7]) : null;
      return { price, prev_close: prev, change_pct: pct(price, prev) };
    };
    return {
      xau: point(xauF),
      sgold: point(sgF),
      source_date: (xauF ? xauF[12] : undefined) ?? (sgF ? sgF[12] : undefined) ?? null,
    };
  } catch {
    return null;
  }
}

const INDEX_DEFS = [
  { sym: "%5EGSPC", key: "SPX", label: "标普500" },
  { sym: "%5ENDX", key: "NDX", label: "纳指100" },
  { sym: "%5EIXIC", key: "IXIC", label: "纳指综合" },
] as const;

async function fetchYahooIndex(
  sym: string,
  key: string,
  label: string,
): Promise<IndexPoint | null> {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=1d`,
    );
    if (!r.ok) return null;
    const j = (await r.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            fulldayChangePercent?: number;
          };
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const res = j.chart?.result?.[0];
    const meta = res?.meta;
    const price =
      typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    if (price == null) return null;
    const closes = (res?.indicators?.quote?.[0]?.close ?? []).filter(
      (c): c is number => typeof c === "number" && Number.isFinite(c),
    );
    let changePct: number | null =
      typeof meta?.fulldayChangePercent === "number"
        ? meta.fulldayChangePercent
        : null;
    // Yahoo's fulldayChange can be a stale 0 when the price already IS the
    // latest close; recompute from the last two closes in that case (the
    // main board documented this quirk).
    if (closes.length >= 2) {
      const last = closes[closes.length - 1] ?? null;
      const prev = closes[closes.length - 2] ?? null;
      if (last != null && prev != null && Math.abs(price - last) < 0.01) {
        changePct = pct(last, prev);
      }
    }
    return { key, label, price, change_pct: changePct };
  } catch {
    return null;
  }
}

// ---------- response schemas ----------

const todayResponse = z.object({
  date_beijing: z.string(),
  weekday_beijing: z.string(),
  overview: z.string().nullable(),
  overview_updated_at: z.string().nullable(),
  accounts: z.array(accountShape),
  accounts_as_of_date: z.string().nullable(),
  accounts_updated_at: z.string().nullable(),
  movers: z.array(moverShape),
  movers_session_label: z.string().nullable(),
  after_hours_notes: z.array(z.string()),
  movers_updated_at: z.string().nullable(),
  indices: z.array(indexPoint),
  indices_fetched_at: z.string().nullable(),
  gold: goldPayload.nullable(),
  gold_fetched_at: z.string().nullable(),
  events: z.array(eventShape),
  other_assets: z.string().nullable(),
  other_assets_updated_at: z.string().nullable(),
  tech_line: z.string().nullable(),
  tech_updated_at: z.string().nullable(),
  market_refreshed_at: z.string().nullable(),
});

const okResponse = z.object({
  ok: z.literal(true),
  updated: z.array(z.string()),
});

const refreshResponse = z.object({
  ok: z.literal(true),
  gold_ok: z.boolean(),
  indices_ok: z.boolean(),
  refreshed_at: z.string(),
});

// ---------- actions ----------

export const Actions = {
  getToday: defineAction({
    description:
      "Returns everything the 今日页 renders: the report's issue date (date_beijing/weekday_beijing — the Beijing date of the most recent content write, persisted by pushDigest/refreshToday, NOT the read-time date), the assistant-pushed overview line, per-account totals （全局/券商A/券商B， close-basis), the full pushed movers set (the page itself selects the top-5 gainers, top-5 losers and every |change| ≥ 5% stock for display), the cached benchmark index closes and gold prices (spot XAU/USD + SGE Au99.99), upcoming events, and the optional other-assets and tech-brief lines (null when never pushed, so the page hides those blocks).",
    request: z.object({}),
    response: todayResponse,
    async handler(ctx): Promise<z.infer<typeof todayResponse>> {
      const db = ctx.db<typeof schema>();
      // `date` (read-time Beijing date) still anchors the events window
      // below; the header date comes from the stored issue date instead.
      const { date } = beijingToday();

      const overviewS = await getSection(ctx, "overview");
      const accountsS = await getSection(ctx, "accounts");
      const moversS = await getSection(ctx, "movers");
      const otherS = await getSection(ctx, "other_assets");
      const techS = await getSection(ctx, "tech_line");

      const overviewVal = overviewS?.value as { text?: string } | null;
      const accountsVal = accountsS?.value as {
        as_of_date?: string | null;
        accounts?: z.infer<typeof accountShape>[];
      } | null;
      const moversVal = moversS?.value as {
        session_label?: string | null;
        movers?: z.infer<typeof moverShape>[];
        after_hours_notes?: string[];
      } | null;
      const otherVal = otherS?.value as { text?: string } | null;
      const techVal = techS?.value as { text?: string } | null;

      const goldC = await getCache(ctx, "gold");
      const indicesC = await getCache(ctx, "indices");
      const goldParsed = goldC ? goldPayload.safeParse(goldC.payload) : null;
      const indicesParsed = indicesC
        ? z.array(indexPoint).safeParse(indicesC.payload)
        : null;

      const eventRows = await db
        .select()
        .from(schema.events)
        .where(
          lte(schema.events.date, addDays(date, 30)),
        )
        .orderBy(asc(schema.events.date), asc(schema.events.sort), asc(schema.events.id))
        .limit(60);
      const upcoming = eventRows.filter((e) => e.date >= date);

      const refreshedCandidates = [goldC?.fetchedAt, indicesC?.fetchedAt]
        .filter((d): d is Date => d instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime());

      // Header date = the stored 期号日期. When it has never been written
      // (pre-fix content), derive the initial value from the content's own
      // timestamps: overview first, then accounts, then the market
      // refresh — never from the read instant.
      const issueS = await getSection(ctx, "issue_date");
      const issueVal = issueS?.value as { date?: string } | null;
      let issueDate: string | null =
        typeof issueVal?.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(issueVal.date)
          ? issueVal.date
          : null;
      if (issueDate == null) {
        const fallbackAt =
          overviewS?.updatedAt ??
          accountsS?.updatedAt ??
          refreshedCandidates[0] ??
          null;
        issueDate = fallbackAt ? beijingDateString(fallbackAt) : date;
      }

      return {
        date_beijing: issueDate,
        weekday_beijing: weekdayOfDate(issueDate),
        overview: overviewVal?.text ?? null,
        overview_updated_at: overviewS?.updatedAt.toISOString() ?? null,
        accounts: accountsVal?.accounts ?? [],
        accounts_as_of_date: accountsVal?.as_of_date ?? null,
        accounts_updated_at: accountsS?.updatedAt.toISOString() ?? null,
        movers: (moversVal?.movers ?? []).map((m) => ({
          ...m,
          after_hours_note: m.after_hours_note ?? null,
        })),
        movers_session_label: moversVal?.session_label ?? null,
        after_hours_notes: moversVal?.after_hours_notes ?? [],
        movers_updated_at: moversS?.updatedAt.toISOString() ?? null,
        indices: indicesParsed?.success ? indicesParsed.data : [],
        indices_fetched_at: indicesC?.fetchedAt.toISOString() ?? null,
        gold: goldParsed?.success ? goldParsed.data : null,
        gold_fetched_at: goldC?.fetchedAt.toISOString() ?? null,
        events: upcoming.map((e) => ({
          id: e.id,
          date: e.date,
          time_text: e.timeText,
          title: e.title,
          kind: e.kind,
          note: e.note,
        })),
        other_assets: otherVal?.text ?? null,
        other_assets_updated_at: otherS?.updatedAt.toISOString() ?? null,
        tech_line: techVal?.text ?? null,
        tech_updated_at: techS?.updatedAt.toISOString() ?? null,
        market_refreshed_at:
          refreshedCandidates[0]?.toISOString() ?? null,
      };
    },
  }),

  pushDigest: defineAction({
    description:
      "Assistant push channel: writes one day's digest sections to the 今日页. Every field is optional — only the sections present are overwritten. `overview` is the one-line morning summary; `accounts` carries 全局/券商A/券商B totals with day change on the regular-close basis plus `accounts_as_of_date` (the US trading date); `movers` carries the FULL merged holdings set for the session — every holding's symbol, regular-session change %, close and optional after-hours note (the page deterministically selects the top-5 gainers, top-5 losers and every stock with |change| ≥ 5% from it) — with `movers_session_label` and `after_hours_notes`; `other_assets` is the one-line 10Y/WTI/DXY summary; `tech_line` is the weekly tech-brief overview sentence. Passing null for overview/other_assets/tech_line clears that section so its block hides.",
    request: z.object({
      overview: z.string().nullable().optional(),
      accounts: z.array(accountShape).optional(),
      accounts_as_of_date: z.string().nullable().optional(),
      movers: z.array(moverShape).optional(),
      movers_session_label: z.string().nullable().optional(),
      after_hours_notes: z.array(z.string()).optional(),
      other_assets: z.string().nullable().optional(),
      tech_line: z.string().nullable().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const updated: string[] = [];

      if (args.overview !== undefined) {
        if (args.overview == null) {
          const db = ctx.db<typeof schema>();
          await db
            .delete(schema.digestSections)
            .where(eq(schema.digestSections.key, "overview"));
        } else {
          await setSection(ctx, "overview", { text: args.overview });
        }
        updated.push("overview");
      }

      if (args.accounts !== undefined || args.accounts_as_of_date !== undefined) {
        const prev = (await getSection(ctx, "accounts"))?.value as {
          as_of_date?: string | null;
          accounts?: unknown;
        } | null;
        await setSection(ctx, "accounts", {
          as_of_date:
            args.accounts_as_of_date !== undefined
              ? args.accounts_as_of_date
              : (prev?.as_of_date ?? null),
          accounts: args.accounts !== undefined ? args.accounts : (prev?.accounts ?? []),
        });
        updated.push("accounts");
      }

      if (
        args.movers !== undefined ||
        args.movers_session_label !== undefined ||
        args.after_hours_notes !== undefined
      ) {
        const prev = (await getSection(ctx, "movers"))?.value as {
          session_label?: string | null;
          movers?: unknown;
          after_hours_notes?: string[];
        } | null;
        await setSection(ctx, "movers", {
          session_label:
            args.movers_session_label !== undefined
              ? args.movers_session_label
              : (prev?.session_label ?? null),
          movers: args.movers !== undefined ? args.movers : (prev?.movers ?? []),
          after_hours_notes:
            args.after_hours_notes !== undefined
              ? args.after_hours_notes
              : (prev?.after_hours_notes ?? []),
        });
        updated.push("movers");
      }

      if (args.other_assets !== undefined) {
        if (args.other_assets == null) {
          const db = ctx.db<typeof schema>();
          await db
            .delete(schema.digestSections)
            .where(eq(schema.digestSections.key, "other_assets"));
        } else {
          await setSection(ctx, "other_assets", { text: args.other_assets });
        }
        updated.push("other_assets");
      }

      if (args.tech_line !== undefined) {
        if (args.tech_line == null) {
          const db = ctx.db<typeof schema>();
          await db
            .delete(schema.digestSections)
            .where(eq(schema.digestSections.key, "tech_line"));
        } else {
          await setSection(ctx, "tech_line", { text: args.tech_line });
        }
        updated.push("tech_line");
      }

      if (updated.length > 0) {
        // Any content write starts a new issue: stamp its Beijing date.
        await touchIssueDate(ctx);
        ctx.invalidateQueries();
      }
      return { ok: true as const, updated };
    },
  }),

  upsertEvent: defineAction({
    description:
      "Creates or updates one event on the 今日页 event list (earnings, macro releases like CPI, ex-dividend dates). `date` is the Beijing calendar date (YYYY-MM-DD); `time_text` is a free Beijing-time label such as '21:30' or '美股盘后'. Omit `id` to create; pass it to update that event.",
    request: z.object({
      id: z.number().int().positive().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      time_text: z.string().nullable().optional(),
      title: z.string().min(1),
      kind: z.string().min(1).default("其他"),
      note: z.string().nullable().optional(),
      sort: z.number().int().default(0),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.id !== undefined) {
        await db
          .update(schema.events)
          .set({
            date: args.date,
            timeText: args.time_text ?? null,
            title: args.title,
            kind: args.kind,
            note: args.note ?? null,
            sort: args.sort,
          })
          .where(eq(schema.events.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const result = await db
        .insert(schema.events)
        .values({
          date: args.date,
          timeText: args.time_text ?? null,
          title: args.title,
          kind: args.kind,
          note: args.note ?? null,
          sort: args.sort,
        })
        .returning({ id: schema.events.id });
      const inserted = result[0];
      if (!inserted) throw new Error("upsertEvent: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteEvent: defineAction({
    description: "Deletes one event from the 今日页 event list by id.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.events).where(eq(schema.events.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  refreshToday: defineAction({
    description:
      "Daily generation (scheduled 06:45 Beijing; the page itself is static with no manual refresh): pulls spot gold XAU/USD + SGE Au99.99 from the Sina feed and the S&P 500 / Nasdaq-100 / Nasdaq Composite regular-session closes from Yahoo, caches them, and stamps the generation time. Assistant-pushed digest sections and events are never touched. Failed feeds keep their last cached values.",
    request: z.object({}),
    response: refreshResponse,
    async handler(ctx): Promise<z.infer<typeof refreshResponse>> {
      const [gold, ...indexResults] = await Promise.all([
        fetchSinaGold(),
        ...INDEX_DEFS.map((d) => fetchYahooIndex(d.sym, d.key, d.label)),
      ]);

      let goldOk = false;
      if (gold) {
        await setCache(ctx, "gold", gold);
        goldOk = true;
      }

      const indices = indexResults.filter((x): x is IndexPoint => x != null);
      let indicesOk = false;
      if (indices.length > 0) {
        // Merge with any previously cached indices so one feed's bad day
        // doesn't blank the whole line.
        const prev = await getCache(ctx, "indices");
        const prevParsed = prev
          ? z.array(indexPoint).safeParse(prev.payload)
          : null;
        const byKey = new Map<string, IndexPoint>();
        if (prevParsed?.success) {
          for (const p of prevParsed.data) byKey.set(p.key, p);
        }
        for (const p of indices) byKey.set(p.key, p);
        const merged = INDEX_DEFS.map((d) => byKey.get(d.key)).filter(
          (x): x is IndexPoint => x != null,
        );
        await setCache(ctx, "indices", merged);
        indicesOk = true;
      }

      // The morning generation also stamps the issue date (same Beijing
      // date as the 06:30 pushDigest, so the two never conflict).
      await touchIssueDate(ctx);
      ctx.invalidateQueries();
      return {
        ok: true as const,
        gold_ok: goldOk,
        indices_ok: indicesOk,
        refreshed_at: new Date().toISOString(),
      };
    },
  }),

  seedEvents: defineAction({
    description:
      "Seeds an initial example event list (one macro release plus fictional company earnings; all Beijing time). A no-op when the events table already has rows.",
    request: z.object({}),
    response: z.object({ seeded: z.boolean(), count: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ value: count() })
        .from(schema.events);
      const n = existing[0]?.value ?? 0;
      if (n > 0) return { seeded: false, count: n };
      const seeds = [
        { date: "2026-01-10", timeText: "21:30", title: "美国 CPI 公布（示例）", kind: "宏观", note: null, sort: 1 },
        { date: "2026-01-10", timeText: "美股盘后", title: "示例公司甲 财报", kind: "财报", note: "示例说明", sort: 2 },
        { date: "2026-01-12", timeText: "美股盘后", title: "示例公司乙 财报", kind: "财报", note: "示例说明", sort: 1 },
        { date: "2026-01-17", timeText: "美股盘后", title: "示例公司丙 财报", kind: "财报", note: "示例说明", sort: 1 },
      ];
      for (const s of seeds) {
        await db.insert(schema.events).values(s);
      }
      ctx.invalidateQueries();
      return { seeded: true, count: seeds.length };
    },
  }),
} satisfies ActionsModule;
