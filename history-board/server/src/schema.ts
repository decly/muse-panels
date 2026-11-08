import {
integer,
primaryKey,
real,
sqliteTable,
text,
} from "drizzle-orm/sqlite-core";

// One row per (account, US trading day): the overall account totals
// only. This board deliberately stores no individual stock data —
// totals are computed elsewhere (the main holdings board) and synced
// in through the recordSnapshot action, per account. The primary key
// is (account_id, date) so accounts accumulate independent histories.
//
// Account ids are open strings ("broker-a", "broker-b", …) so future
// brokerage accounts slot in without a schema change. All rows that
// existed before the account dimension was added belong to Broker A
// (migration 0003 backfills account_id = 'broker-a'), including the
// demo 2026-11-06 record (source
// "manual", never overwritten by a sync — the protection applies
// per (date, account)). Benchmark closes ride along so the client
// can normalize account vs index curves from the same rows.
export const dailySnapshots = sqliteTable(
  "daily_snapshots",
  {
    // Brokerage account id, e.g. "broker-a" | "broker-b" (extensible).
    accountId: text("account_id").notNull().default("broker-a"),
    // US trading date, YYYY-MM-DD (America/New_York).
    date: text("date").notNull(),
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
  (table) => [primaryKey({ columns: [table.accountId, table.date] })],
);
