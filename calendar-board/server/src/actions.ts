// Actions for the 事件日历 (event calendar) board.
//
// The board is the single source of truth for calendar events (phase 1:
// holdings earnings + macro schedule). Data is maintained by the
// assistant through upsertEvent / deleteEvent; the board itself never
// fetches external data. All dates/times are Beijing wall-clock values:
// date = YYYY-MM-DD, timeText = 盘前 / 盘后 or an HH:MM Beijing time.
//
// getCalendar returns the rolling window: past 7 days + future 30 days,
// computed against the Asia/Shanghai calendar date.

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import * as schema from "./schema";

// ---------- Beijing date helpers ----------

function beijingToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Sort bucket within one day: pre-market first, untimed next, timed
// releases after that, after-close earnings last.
function timeBucket(timeText: string | null): number {
  if (!timeText) return 1;
  if (timeText.includes("盘前")) return 0;
  if (timeText.includes("盘后")) return 3;
  if (/^\d{1,2}:\d{2}/.test(timeText)) return 2;
  return 1;
}

function parseTickers(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// ---------- Shared shapes ----------

const eventShape = z.object({
  id: z.number(),
  date: z.string(),
  timeText: z.string().nullable(),
  kind: z.enum(["earnings", "macro"]),
  title: z.string(),
  tickers: z.array(z.string()),
  importance: z.enum(["key", "normal"]),
  confirmed: z.boolean(),
  note: z.string().nullable(),
  source: z.string().nullable(),
});

type EventRow = typeof schema.events.$inferSelect;

function toEvent(row: EventRow): z.infer<typeof eventShape> {
  return {
    id: row.id,
    date: row.date,
    timeText: row.timeText,
    kind: row.kind,
    title: row.title,
    tickers: parseTickers(row.tickers),
    importance: row.importance,
    confirmed: row.confirmed === 1,
    note: row.note,
    source: row.source,
  };
}

// ---------- Example seed events (fictional) ----------

const SEED_EVENTS = [
  {
    date: "2026-01-12",
    timeText: "盘后",
    kind: "earnings" as const,
    title: "示例公司甲 财报",
    tickers: [] as string[],
    importance: "normal" as const,
    confirmed: true,
    note: "示例说明：预期数字为虚构示例。",
    source: "示例来源（虚构）",
    sort: 0,
  },
  {
    date: "2026-01-14",
    timeText: "21:30",
    kind: "macro" as const,
    title: "美国 CPI 公布（示例）",
    tickers: [] as string[],
    importance: "key" as const,
    confirmed: true,
    note: "示例说明。",
    source: "示例来源（虚构）",
    sort: 0,
  },
  {
    date: "2026-01-15",
    timeText: "盘后",
    kind: "earnings" as const,
    title: "示例公司乙 财报",
    tickers: [] as string[],
    importance: "key" as const,
    confirmed: true,
    note: "示例说明：预期数字为虚构示例。",
    source: "示例来源（虚构）",
    sort: 0,
  },
];

export const Actions = {
  getCalendar: defineAction({
    description:
      "Returns all calendar events in the current window (past 7 days + future 30 days, Beijing dates), sorted by date and time of day.",
    request: z.object({}),
    response: z.object({
      today: z.string(),
      windowStart: z.string(),
      windowEnd: z.string(),
      events: z.array(eventShape),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const today = beijingToday();
      const windowStart = addDays(today, -7);
      const windowEnd = addDays(today, 30);
      const rows = await db
        .select()
        .from(schema.events)
        .where(
          and(
            gte(schema.events.date, windowStart),
            lte(schema.events.date, windowEnd),
          ),
        )
        .orderBy(asc(schema.events.date), asc(schema.events.sort), asc(schema.events.id));
      const events = rows
        .map(toEvent)
        .sort((a, b) => {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          const bucketDiff = timeBucket(a.timeText) - timeBucket(b.timeText);
          if (bucketDiff !== 0) return bucketDiff;
          return a.id - b.id;
        });
      return { today, windowStart, windowEnd, events };
    },
  }),

  upsertEvent: defineAction({
    description:
      "Creates or updates one calendar event. With an id it updates that row; otherwise it matches on (date + kind + title) and updates the existing row, or inserts a new one.",
    request: z.object({
      id: z.number().int().positive().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      timeText: z.string().max(40).nullable().optional(),
      kind: z.enum(["earnings", "macro"]),
      title: z.string().min(1).max(200),
      tickers: z.array(z.string().max(20)).max(20).optional(),
      importance: z.enum(["key", "normal"]).optional(),
      confirmed: z.boolean().optional(),
      note: z.string().max(1000).nullable().optional(),
      source: z.string().max(300).nullable().optional(),
      sort: z.number().int().optional(),
    }),
    response: z.object({ id: z.number(), created: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const values = {
        date: args.date,
        timeText: args.timeText ?? null,
        kind: args.kind,
        title: args.title,
        tickers: JSON.stringify(args.tickers ?? []),
        importance: args.importance ?? "normal",
        confirmed: args.confirmed === false ? 0 : 1,
        note: args.note ?? null,
        source: args.source ?? null,
        sort: args.sort ?? 0,
        updatedAt: new Date(),
      };

      let existing: EventRow | undefined;
      if (args.id != null) {
        const rows = await db
          .select()
          .from(schema.events)
          .where(eq(schema.events.id, args.id))
          .limit(1);
        existing = rows[0];
      } else {
        const rows = await db
          .select()
          .from(schema.events)
          .where(
            and(
              eq(schema.events.date, args.date),
              eq(schema.events.kind, args.kind),
              eq(schema.events.title, args.title),
            ),
          )
          .limit(1);
        existing = rows[0];
      }

      if (existing) {
        await db
          .update(schema.events)
          .set(values)
          .where(eq(schema.events.id, existing.id));
        ctx.invalidateQueries();
        return { id: existing.id, created: false };
      }

      const inserted = await db
        .insert(schema.events)
        .values(values)
        .returning({ id: schema.events.id });
      const row = inserted[0];
      if (!row) throw new Error("upsertEvent: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id, created: true };
    },
  }),

  deleteEvent: defineAction({
    description: "Deletes one calendar event by id.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ deleted: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .delete(schema.events)
        .where(eq(schema.events.id, args.id))
        .returning({ id: schema.events.id });
      ctx.invalidateQueries();
      return { deleted: result.length > 0 };
    },
  }),

  seedEvents: defineAction({
    description:
      "Writes the initial example seed events (fictional company earnings plus one macro release). Only runs when the events table is empty.",
    request: z.object({}),
    response: z.object({ seeded: z.boolean(), count: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select({ id: schema.events.id }).from(schema.events).limit(1);
      if (existing.length > 0) {
        return { seeded: false, count: 0 };
      }
      for (const s of SEED_EVENTS) {
        await db.insert(schema.events).values({
          date: s.date,
          timeText: s.timeText,
          kind: s.kind,
          title: s.title,
          tickers: JSON.stringify(s.tickers),
          importance: s.importance,
          confirmed: s.confirmed ? 1 : 0,
          note: s.note,
          source: s.source,
          sort: s.sort,
        });
      }
      ctx.invalidateQueries();
      return { seeded: true, count: SEED_EVENTS.length };
    },
  }),
} satisfies ActionsModule;
