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

// --- Personal-data export / import -------------------------------------
//
// Stateless data actions for the muse-data backup flow: this board
// knows nothing about GitHub, repositories, or pushes. export returns
// the board's ONLY personal data — the daily_snapshots rows (overall
// account totals; the index closes and FX rate stored on a row are
// part of that personal history record and travel with it). There is
// no other table to export: this board stores no holdings and no
// market-quote cache.
//
// Format v2 (self-describing dataset envelope, the industry-standard
// shape for portable data packages): each exported table carries its
// own primary_key declaration alongside its rows, so generic tooling
// can validate and merge without hardcoding this board's schema.
// Serialization is deterministic — rows sorted by the declared
// primary key, fields in a fixed order — so the same state exports
// byte-identically except for exported_at; `checksum` is an FNV-1a
// hash over the canonical payload (format/version/panel/tables)
// without exported_at. Import accepts v2 and the legacy v1 envelope
// (tables as bare row arrays, panel named "history"), ignores unknown
// fields, and skips unknown tables (noted in the import summary)
// instead of failing on additive changes.

const personalDataRowSchema = z.object({
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
  created_at: z.string().nullable(),
});

type PersonalDataRow = z.infer<typeof personalDataRowSchema>;

// The one personal table this board owns, with its declared primary
// key (field names as they appear in the export rows).
const SNAPSHOTS_PRIMARY_KEY = ["date", "account_id"] as const;

const tableEnvelopeSchema = z.object({
  primary_key: z.array(z.string()),
  rows: z.array(personalDataRowSchema),
});

const personalDataSchema = z.object({
  format: z.literal("muse-personal-data"),
  version: z.literal(2),
  panel: z.literal("history-board"),
  exported_at: z.string(),
  tables: z.object({
    daily_snapshots: tableEnvelopeSchema,
  }),
});

const exportResponse = personalDataSchema.extend({
  checksum: z.string(),
});

type ExportResponse = z.infer<typeof exportResponse>;

// Field order in this literal IS the export field order — do not
// reorder; deterministic bytes depend on it.
function toPersonalRow(
  s: typeof schema.dailySnapshots.$inferSelect,
): PersonalDataRow {
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
    created_at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
  };
}

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

// Canonical payloads the checksum is computed over. The v2 form is
// the full envelope minus exported_at/checksum; the v1 form is kept
// so checksums on legacy v1 payloads can still be verified at import.
function canonicalPayloadV2(rows: PersonalDataRow[]): string {
  return JSON.stringify({
    format: "muse-personal-data",
    version: 2,
    panel: "history-board",
    tables: {
      daily_snapshots: {
        primary_key: [...SNAPSHOTS_PRIMARY_KEY],
        rows,
      },
    },
  });
}

function canonicalPayloadV1(rows: PersonalDataRow[]): string {
  return JSON.stringify({
    format: "muse-personal-data",
    version: 1,
    board: "history",
    tables: { daily_snapshots: rows },
  });
}

function sortRows(rows: PersonalDataRow[]): PersonalDataRow[] {
  return [...rows].sort((a, b) =>
    a.date < b.date
      ? -1
      : a.date > b.date
        ? 1
        : a.account_id < b.account_id
          ? -1
          : a.account_id > b.account_id
            ? 1
            : 0,
  );
}

async function buildExport(ctx: Ctx): Promise<ExportResponse> {
  const db = ctx.db<typeof schema>();
  const stored = await db.select().from(schema.dailySnapshots);
  const rows = sortRows(stored.map(toPersonalRow));
  return {
    format: "muse-personal-data",
    version: 2,
    panel: "history-board",
    exported_at: new Date().toISOString(),
    tables: {
      daily_snapshots: {
        primary_key: [...SNAPSHOTS_PRIMARY_KEY],
        rows,
      },
    },
    checksum: fnv1a64(canonicalPayloadV2(rows)),
  };
}

const importResponse = z.object({
  ok: z.boolean(),
  reason: z.string().nullable(),
  mode: z.string().nullable(),
  written: z.number(),
  skipped_protected: z.number(),
  // Tables present in the payload that this board does not know —
  // skipped wholesale (additive format evolution must not fail an
  // import), and named here so the caller sees what was left out.
  skipped_tables: z.array(z.string()),
  total_rows: z.number(),
});

type ImportResponse = z.infer<typeof importResponse>;

// Import accepts both envelope generations. v2: `panel` +
// tables as {primary_key, rows} envelopes + `checksum`. v1: `board`
// ("history") + tables as bare row arrays + `content_checksum`.
// Unknown top-level and per-table fields are ignored by design.
const importRequestData = z.object({
  format: z.string(),
  version: z.number(),
  board: z.string().optional(),
  panel: z.string().optional(),
  exported_at: z.string().optional(),
  checksum: z.string().optional(),
  content_checksum: z.string().optional(),
  tables: z
    .object({
      daily_snapshots: z.union([
        z.array(personalDataRowSchema),
        tableEnvelopeSchema,
      ]),
    })
    .catchall(z.unknown()),
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

  exportPersonalData: defineAction({
    description:
      "Read-only export of this board's personal data only: every daily_snapshots row (all fields, including the per-row index closes and FX rate that belong to the personal history record), deterministically serialized as a self-describing v2 envelope {format: 'muse-personal-data', version: 2, panel: 'history-board', exported_at, checksum, tables: {daily_snapshots: {primary_key: ['date', 'account_id'], rows}}} — rows sorted by the declared primary key with fixed field order, checksum over the canonical payload without exported_at. No side effects; knows nothing about any repository or push.",
    request: z.object({}),
    response: exportResponse,
    handler: async (ctx): Promise<ExportResponse> => buildExport(ctx),
  }),

  importPersonalData: defineAction({
    description:
      "Restores personal data previously produced by exportPersonalData (format v2 envelope, or legacy v1 which is normalized onto the same path). Validates format/version/panel first and rejects the whole file without writing when invalid or when a carried checksum does not match the payload. Unknown tables are skipped and named in the summary; unknown fields are ignored. mode=restore replaces daily_snapshots wholesale with the file's rows (single batch: clear then insert) and requires confirm=true. mode=merge upserts by (date, account_id) without deleting rows absent from the file, and never overwrites an existing manual-sourced protected record. Returns written/skipped counts.",
    request: z.object({
      data: importRequestData,
      mode: z.enum(["restore", "merge"]),
      confirm: z.boolean(),
    }),
    response: importResponse,
    handler: async (ctx, args): Promise<ImportResponse> => {
      // Normalize both envelope generations onto one row list.
      // v2 wraps rows in {primary_key, rows}; v1 is a bare array.
      const rawTable = args.data.tables.daily_snapshots;
      const incoming: PersonalDataRow[] = Array.isArray(rawTable)
        ? rawTable
        : rawTable.rows;
      const skippedTables = Object.keys(args.data.tables).filter(
        (name) => name !== "daily_snapshots",
      );
      const reject = (reason: string): ImportResponse => ({
        ok: false,
        reason,
        mode: args.mode,
        written: 0,
        skipped_protected: 0,
        skipped_tables: skippedTables,
        total_rows: incoming.length,
      });
      if (args.data.format !== "muse-personal-data")
        return reject("bad_format");
      if (args.data.version !== 1 && args.data.version !== 2)
        return reject("unsupported_version");
      // v1 named the panel in `board` ("history"); v2 uses `panel`
      // ("history-board"). Both denote this same board.
      const panelId = args.data.panel ?? args.data.board;
      if (panelId !== "history-board" && panelId !== "history")
        return reject("wrong_board");
      const rows = sortRows(incoming);
      // Integrity: when the payload carries a checksum, it must match
      // the canonical form of its own generation — a mismatch means
      // the file is corrupt or tampered with; reject without writing.
      const carriedChecksum =
        args.data.version === 2
          ? (args.data.checksum ?? args.data.content_checksum)
          : (args.data.content_checksum ?? args.data.checksum);
      if (carriedChecksum != null) {
        const expected =
          args.data.version === 2
            ? fnv1a64(canonicalPayloadV2(rows))
            : fnv1a64(canonicalPayloadV1(rows));
        if (carriedChecksum !== expected) return reject("checksum_mismatch");
      }
      if (args.mode === "restore" && !args.confirm)
        return reject("confirmation_required");
      for (const r of rows) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.account_id.length === 0)
          return reject("invalid_row");
      }
      const db = ctx.db<typeof schema>();
      const toDb = (r: PersonalDataRow) => {
        const created = r.created_at ? new Date(r.created_at) : new Date();
        return {
          accountId: r.account_id,
          date: r.date,
          accountValueUsd: r.account_value_usd,
          securitiesValueUsd: r.securities_value_usd,
          cashUsd: r.cash_usd,
          totalPnlUsd: r.total_pnl_usd,
          dayChangeUsd: r.day_change_usd,
          dayChangePct: r.day_change_pct,
          fxRate: r.fx_rate,
          accountValueCny: r.account_value_cny,
          spxPrice: r.spx_price,
          ndxPrice: r.ndx_price,
          source: r.source,
          createdAt: Number.isNaN(created.getTime()) ? new Date() : created,
        };
      };
      if (args.mode === "restore") {
        // Wholesale replacement in one batch: clear, then insert the
        // file's rows. An explicit confirmed restore is the recovery
        // path, so manual protection does not apply here (it
        // guards syncs and merges, not a deliberate full restore).
        await db.batch([
          db.delete(schema.dailySnapshots),
          ...rows.map((r) => db.insert(schema.dailySnapshots).values(toDb(r))),
        ]);
        ctx.invalidateQueries();
        return {
          ok: true,
          reason: null,
          mode: args.mode,
          written: rows.length,
          skipped_protected: 0,
          skipped_tables: skippedTables,
          total_rows: rows.length,
        };
      }
      // merge: upsert per (date, account_id); existing rows absent
      // from the file stay untouched, and an existing
      // manual-sourced record is never overwritten — same
      // protection semantics as recordSnapshot.
      const existing = await db.select().from(schema.dailySnapshots);
      const protectedKeys = new Set(
        existing
          .filter((s) => s.source === "manual")
          .map((s) => `${s.date}|${s.accountId}`),
      );
      let written = 0;
      let skipped = 0;
      for (const r of rows) {
        if (protectedKeys.has(`${r.date}|${r.account_id}`)) {
          skipped++;
          continue;
        }
        const values = toDb(r);
        await db
          .insert(schema.dailySnapshots)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.dailySnapshots.accountId, schema.dailySnapshots.date],
            set: values,
          });
        written++;
      }
      if (written > 0) ctx.invalidateQueries();
      return {
        ok: true,
        reason: null,
        mode: args.mode,
        written,
        skipped_protected: skipped,
        skipped_tables: skippedTables,
        total_rows: rows.length,
      };
    },
  }),
} satisfies ActionsModule;
