// Actions for the standalone account-history board.
//
// This board stores ONLY overall account snapshots — one row per
// (account, US trading day) with the account total, securities value,
// cash, unrealized P/L, day change, USD/CNY rate, CNY total, and the
// S&P 500 / Nasdaq-100 closes. It holds no individual stock data and
// fetches no quotes: totals are computed by the main holdings board
// and synced in through recordSnapshot, separately per account.
// Account ids are open strings ("broker-a", "broker-b", …) so future
// brokerage accounts need no schema change. The first Broker A row
// (2026-11-06) comes from the demo seed and
// is never overwritten — the manual-record protection applies per
// (date, account).

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, eq } from "drizzle-orm";
import * as schema from "./schema";

// Known accounts, in tab order. The client renders one tab per entry
// plus a 全局 (global) tab that sums every account per day. New
// accounts are added here (and start syncing through recordSnapshot);
// no schema change is needed.
export const ACCOUNTS = [
  { id: "broker-a", name: "券商A" },
  { id: "broker-b", name: "券商B" },
] as const;

const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const snapshotSchema = z.object({
  account_id: z.string(),
  date: z.string(),
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

const historyResponse = z.object({
  accounts: z.array(accountSchema),
  history: z.array(snapshotSchema),
});

type HistoryResponse = z.infer<typeof historyResponse>;
type SnapshotOut = z.infer<typeof snapshotSchema>;

function toOut(s: typeof schema.dailySnapshots.$inferSelect): SnapshotOut {
  return {
    account_id: s.accountId,
    date: s.date,
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

async function loadHistory(ctx: Ctx): Promise<HistoryResponse> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.dailySnapshots);
  return {
    accounts: ACCOUNTS.map((a) => ({ id: a.id, name: a.name })),
    history: rows
      .map(toOut)
      .sort((a, b) =>
        a.date < b.date
          ? -1
          : a.date > b.date
            ? 1
            : a.account_id < b.account_id
              ? -1
              : a.account_id > b.account_id
                ? 1
                : 0,
      ),
  };
}

// Demo first record (fictional sample data): account value
// $10,000.00 = securities $9,200.00 + cash $800.00, day change
// +$150.00 (+1.52%), unrealized P/L +$320.00, USD/CNY 7.000000,
// CNY total ¥70,000.00, S&P 500 close 7,000.00, Nasdaq-100 close
// 25,000.00. Nothing is back-derived for earlier days or other
// accounts.
const SEED_SNAPSHOT = {
  accountId: "broker-a",
  date: "2026-11-06",
  accountValueUsd: 10000,
  securitiesValueUsd: 9200,
  cashUsd: 800,
  totalPnlUsd: 320,
  dayChangeUsd: 150,
  dayChangePct: 1.52,
  fxRate: 7,
  accountValueCny: 70000,
  spxPrice: 7000,
  ndxPrice: 25000,
  source: "demo",
} as const;

async function ensureSeedSnapshot(ctx: Ctx): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({ date: schema.dailySnapshots.date })
    .from(schema.dailySnapshots)
    .where(
      and(
        eq(schema.dailySnapshots.accountId, SEED_SNAPSHOT.accountId),
        eq(schema.dailySnapshots.date, SEED_SNAPSHOT.date),
      ),
    );
  if (existing.length > 0) return false;
  await db.insert(schema.dailySnapshots).values({
    ...SEED_SNAPSHOT,
    createdAt: new Date(),
  });
  return true;
}

const okResponse = z.object({ ok: z.literal(true) });

const recordResponse = z.object({
  recorded: z.boolean(),
  reason: z.string().nullable(),
  snapshot: snapshotSchema.nullable(),
});

const statusResponse = z.object({
  count: z.number(),
  latest_date: z.string().nullable(),
  latest_account_value_usd: z.number().nullable(),
  accounts: z.array(
    z.object({
      account_id: z.string(),
      count: z.number(),
      latest_date: z.string().nullable(),
    }),
  ),
});

export const Actions = {
  getHistory: defineAction({
    description:
      "Returns the known accounts (id + display name) and all stored daily account snapshots (overall totals only, each tagged with its account_id), ascending by US trading date.",
    request: z.object({}),
    response: historyResponse,
    handler: async (ctx): Promise<HistoryResponse> => loadHistory(ctx),
  }),

  seedDemoRecord: defineAction({
    description:
      "Seeds a demo first daily snapshot (total $10,000.00, securities $9,200.00, cash $800.00, day change +$150.00/+1.52%, unrealized P/L +$320.00, USD/CNY 7.000000, S&P 500 7,000.00, Nasdaq-100 25,000.00); a no-op when broker-a already has a record for that date.",
    request: z.object({}),
    response: z.object({ seeded: z.boolean() }),
    handler: async (ctx): Promise<{ seeded: boolean }> => {
      const seeded = await ensureSeedSnapshot(ctx);
      if (seeded) ctx.invalidateQueries();
      return { seeded };
    },
  }),

  recordSnapshot: defineAction({
    description:
      "Sync endpoint for external writers (the main holdings board's daily data): upserts one overall account snapshot keyed by (account_id, US trading date); account_id defaults to broker-a for legacy callers. A manual-sourced record for that (date, account) is never overwritten; when account_value_cny is omitted but fx_rate is given, the CNY total is derived as total × rate.",
    request: z.object({
      account_id: z.string().min(1).max(40).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      account_value_usd: z.number().nonnegative(),
      securities_value_usd: z.number().nonnegative(),
      cash_usd: z.number().nonnegative(),
      total_pnl_usd: z.number().nullable().optional(),
      day_change_usd: z.number().nullable().optional(),
      day_change_pct: z.number().nullable().optional(),
      fx_rate: z.number().positive().nullable().optional(),
      account_value_cny: z.number().nonnegative().nullable().optional(),
      spx_price: z.number().positive().nullable().optional(),
      ndx_price: z.number().positive().nullable().optional(),
      source: z.string().min(1).max(40).optional(),
    }),
    response: recordResponse,
    handler: async (ctx, args): Promise<z.infer<typeof recordResponse>> => {
      const db = ctx.db<typeof schema>();
      const accountId = args.account_id ?? "broker-a";
      const existing = await db
        .select()
        .from(schema.dailySnapshots)
        .where(
          and(
            eq(schema.dailySnapshots.accountId, accountId),
            eq(schema.dailySnapshots.date, args.date),
          ),
        );
      const prior = existing[0];
      if (prior?.source === "manual") {
        return {
          recorded: false,
          reason: "manual_record_protected",
          snapshot: toOut(prior),
        };
      }
      const fxRate = args.fx_rate ?? null;
      const accountValueCny =
        args.account_value_cny ??
        (fxRate != null ? args.account_value_usd * fxRate : null);
      const values = {
        accountId,
        date: args.date,
        accountValueUsd: args.account_value_usd,
        securitiesValueUsd: args.securities_value_usd,
        cashUsd: args.cash_usd,
        totalPnlUsd: args.total_pnl_usd ?? null,
        dayChangeUsd: args.day_change_usd ?? null,
        dayChangePct: args.day_change_pct ?? null,
        fxRate,
        accountValueCny,
        spxPrice: args.spx_price ?? null,
        ndxPrice: args.ndx_price ?? null,
        source: args.source ?? "sync",
        createdAt: new Date(),
      };
      await db
        .insert(schema.dailySnapshots)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.dailySnapshots.accountId, schema.dailySnapshots.date],
          set: values,
        });
      ctx.invalidateQueries();
      const rows = await db
        .select()
        .from(schema.dailySnapshots)
        .where(
          and(
            eq(schema.dailySnapshots.accountId, accountId),
            eq(schema.dailySnapshots.date, args.date),
          ),
        );
      const saved = rows[0];
      return {
        recorded: true,
        reason: null,
        snapshot: saved ? toOut(saved) : null,
      };
    },
  }),

  deleteSnapshot: defineAction({
    description:
      "Maintenance endpoint: deletes one stored snapshot keyed by (account_id, US trading date), e.g. to remove a test or erroneous sync row. Manual-sourced records are protected and are never deleted through this action.",
    request: z.object({
      account_id: z.string().min(1).max(40).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    response: z.object({
      deleted: z.boolean(),
      reason: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ deleted: boolean; reason: string | null }> => {
      const db = ctx.db<typeof schema>();
      const accountId = args.account_id ?? "broker-a";
      const existing = await db
        .select()
        .from(schema.dailySnapshots)
        .where(
          and(
            eq(schema.dailySnapshots.accountId, accountId),
            eq(schema.dailySnapshots.date, args.date),
          ),
        );
      const prior = existing[0];
      if (!prior) return { deleted: false, reason: "not_found" };
      if (prior.source === "manual") {
        return { deleted: false, reason: "manual_record_protected" };
      }
      await db
        .delete(schema.dailySnapshots)
        .where(
          and(
            eq(schema.dailySnapshots.accountId, accountId),
            eq(schema.dailySnapshots.date, args.date),
          ),
        );
      ctx.invalidateQueries();
      return { deleted: true, reason: null };
    },
  }),

  snapshotStatus: defineAction({
    description:
      "Read-only health check: returns how many daily snapshots are stored overall and per account, plus the latest trading date on record. No side effects; creates and modifies nothing.",
    request: z.object({}),
    response: statusResponse,
    handler: async (ctx): Promise<z.infer<typeof statusResponse>> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          accountId: schema.dailySnapshots.accountId,
          date: schema.dailySnapshots.date,
          accountValueUsd: schema.dailySnapshots.accountValueUsd,
        })
        .from(schema.dailySnapshots);
      const sorted = [...rows].sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
      );
      const latest = sorted[sorted.length - 1];
      const accounts = ACCOUNTS.map((a) => {
        const mine = rows.filter((r) => r.accountId === a.id);
        const mySorted = [...mine].sort((x, y) =>
          x.date < y.date ? -1 : x.date > y.date ? 1 : 0,
        );
        const myLatest = mySorted[mySorted.length - 1];
        return {
          account_id: a.id,
          count: mine.length,
          latest_date: myLatest?.date ?? null,
        };
      });
      return {
        count: rows.length,
        latest_date: latest?.date ?? null,
        latest_account_value_usd: latest?.accountValueUsd ?? null,
        accounts,
      };
    },
  }),
} satisfies ActionsModule;
