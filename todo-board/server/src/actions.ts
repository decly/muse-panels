// Actions for the todo board（看板 · 待办总览）.
//
// The board is maintained by the assistant in daily work through addItem /
// updateItem; the page reads via getBoard and lets the user act on items
// via actOnItem （拍板 / 优先 / 暂缓 / 取消 / 重新打开）. getBoard also prunes
// done items older than 14 days (server-side auto-cleanup per spec) and
// never returns cancelled items (user-cancelled archive).
//
// Every page-originated call (actOnItem / requestExecution) is appended to
// the action_log table — outcome and error code included — so a tap that
// appears to "do nothing" can be diagnosed from getActionLog afterwards.
// loadBoard also clears a stale execution_requested_at whenever the
// pending-execution count is zero, so a finished batch's dispatch time
// never leaks into the next batch.
//
// Dates are YYYY-MM-DD strings in Asia/Shanghai (the user's timezone);
// decision timestamps are "YYYY-MM-DD HH:mm" in the same timezone.
// Sorting:
//  - needs_decision: created_at ascending — waiting longest first
//  - in_progress:    due_date ascending, items without a date last
//  - done:           completed_at descending — newest first

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import * as schema from "./schema";

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const statusEnum = z.enum([
  "needs_decision",
  "in_progress",
  "done",
  "cancelled",
]);

const userDecisionSchema = z.object({
  choice: z.string().nullable(),
  text: z.string().nullable(),
  decidedAt: z.string(),
});

const cancelledDecisionSchema = z.object({
  choice: z.string().nullable(),
  text: z.string().nullable(),
  decidedAt: z.string(),
  cancelledAt: z.string(),
});

const itemSchema = z.object({
  id: z.number(),
  status: statusEnum,
  title: z.string(),
  note: z.string(),
  source: z.string(),
  dueDate: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  options: z.array(z.string()),
  userDecision: userDecisionSchema.nullable(),
  prioritizedAt: z.string().nullable(),
  snoozedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  executionResult: z.string().nullable(),
  cancelledDecision: cancelledDecisionSchema.nullable(),
});

const boardResponse = z.object({
  needsDecision: z.array(itemSchema),
  inProgress: z.array(itemSchema),
  done: z.array(itemSchema),
  counts: z.object({
    needsDecision: z.number(),
    inProgress: z.number(),
    done: z.number(),
  }),
  /** Beijing "YYYY-MM-DD HH:mm" of the latest「完成，开始执行」press, or null. */
  requestedAt: z.string().nullable(),
  /** Matters awaiting execution: an unexecuted decision (userDecision set,
   *  executedAt empty) or an unhandled priority mark. */
  pendingExecution: z.number(),
});

type ItemRow = typeof schema.items.$inferSelect;
type UserDecision = z.infer<typeof userDecisionSchema>;
type CancelledDecision = z.infer<typeof cancelledDecisionSchema>;

function parseOptions(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // fall through to empty
  }
  return [];
}

function parseDecision(raw: string | null): UserDecision | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (typeof p.decidedAt === "string") {
        return {
          choice: typeof p.choice === "string" ? p.choice : null,
          text: typeof p.text === "string" ? p.text : null,
          decidedAt: p.decidedAt,
        };
      }
    }
  } catch {
    // fall through to null
  }
  return null;
}

function parseCancelledDecision(
  raw: string | null,
): CancelledDecision | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (
        typeof p.decidedAt === "string" &&
        typeof p.cancelledAt === "string"
      ) {
        return {
          choice: typeof p.choice === "string" ? p.choice : null,
          text: typeof p.text === "string" ? p.text : null,
          decidedAt: p.decidedAt,
          cancelledAt: p.cancelledAt,
        };
      }
    }
  } catch {
    // fall through to null
  }
  return null;
}

function toItem(row: ItemRow): z.infer<typeof itemSchema> {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    note: row.note,
    source: row.source,
    dueDate: row.dueDate,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    options: parseOptions(row.options),
    userDecision: parseDecision(row.userDecision),
    prioritizedAt: row.prioritizedAt,
    snoozedAt: row.snoozedAt,
    cancelledAt: row.cancelledAt,
    executedAt: row.executedAt,
    executionResult: row.executionResult,
    cancelledDecision: parseCancelledDecision(row.cancelledDecision),
  };
}

/** A matter awaits execution when the user has decided (or prioritised) it
 *  and no execution trace has been written yet. Cancelled matters never
 *  count; done matters are settled. */
function awaitsExecution(row: ItemRow): boolean {
  if (row.status === "cancelled" || row.status === "done") return false;
  if (row.executedAt) return false;
  return Boolean(row.userDecision) || Boolean(row.prioritizedAt);
}

const EXECUTION_REQUESTED_KEY = "execution_requested_at";

async function readRequestedAt(ctx: Ctx): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.boardMeta)
    .where(eq(schema.boardMeta.key, EXECUTION_REQUESTED_KEY))
    .limit(1);
  return rows[0]?.value ?? null;
}

/** Today (or today + offsetDays) as YYYY-MM-DD in Asia/Shanghai. */
function beijingDate(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Current time as "YYYY-MM-DD HH:mm:ss" in Asia/Shanghai (log rows). */
function beijingNowSeconds(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Append one row to the page-action audit log, pruning to the newest 200
 *  rows. Best-effort: a logging failure must never fail the action itself. */
const ACTION_LOG_KEEP = 200;
async function logAction(
  ctx: Ctx,
  action: string,
  itemId: number | null,
  ok: boolean,
  detail: string,
): Promise<void> {
  try {
    const db = ctx.db<typeof schema>();
    await db.insert(schema.actionLog).values({
      at: beijingNowSeconds(),
      action,
      itemId,
      ok: ok ? 1 : 0,
      detail: detail.slice(0, 300),
    });
    await db.run(
      sql`DELETE FROM action_log WHERE id NOT IN (SELECT id FROM action_log ORDER BY id DESC LIMIT ${ACTION_LOG_KEEP})`,
    );
  } catch {
    // Audit logging is diagnostic only; swallow failures.
  }
}

/** Current time as "YYYY-MM-DD HH:mm" in Asia/Shanghai. */
function beijingNow(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Done items are kept for the most recent 14 days (today included). */
const DONE_KEEP_DAYS = 14;

/** Load the full board (pruning stale done items first). Shared by
 *  getBoard and actOnItem so a page action returns the refreshed board. */
async function loadBoard(
  ctx: Ctx,
): Promise<z.infer<typeof boardResponse>> {
  const db = ctx.db<typeof schema>();

  // Auto-prune: drop done items completed before the 14-day window.
  const cutoff = beijingDate(-(DONE_KEEP_DAYS - 1));
  await db
    .delete(schema.items)
    .where(
      and(
        eq(schema.items.status, "done"),
        lt(schema.items.completedAt, cutoff),
      ),
    );

  const decisionRows = await db
    .select()
    .from(schema.items)
    .where(eq(schema.items.status, "needs_decision"))
    .orderBy(asc(schema.items.createdAt), asc(schema.items.id));

  const progressRows = await db
    .select()
    .from(schema.items)
    .where(eq(schema.items.status, "in_progress"));
  // Sort in memory: due_date ascending, items without a date last.
  const inProgress = [...progressRows].sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
  });

  const doneRows = await db
    .select()
    .from(schema.items)
    .where(eq(schema.items.status, "done"))
    .orderBy(desc(schema.items.completedAt), desc(schema.items.id));

  const pendingExecution =
    decisionRows.filter(awaitsExecution).length +
    inProgress.filter(awaitsExecution).length;

  // The dispatch timestamp describes the CURRENT pending batch only. When
  // nothing awaits execution any more (batch executed, decisions withdrawn,
  // items cancelled…), a leftover timestamp from a finished batch is stale:
  // clear it so the next batch never shows the previous dispatch time.
  let requestedAt = await readRequestedAt(ctx);
  if (pendingExecution === 0 && requestedAt !== null) {
    await db
      .delete(schema.boardMeta)
      .where(eq(schema.boardMeta.key, EXECUTION_REQUESTED_KEY));
    requestedAt = null;
  }

  return {
    needsDecision: decisionRows.map(toItem),
    inProgress: inProgress.map(toItem),
    done: doneRows.map(toItem),
    counts: {
      needsDecision: decisionRows.length,
      inProgress: inProgress.length,
      done: doneRows.length,
    },
    requestedAt,
    pendingExecution,
  };
}

export const Actions = {
  getBoard: defineAction({
    description:
      "返回待办总览看板三组当前内容（待你拍板 / 进行中 / 已办，含每条的选项与用户拍板记录），并自动清除完成超过 14 天的已办事项；已取消事项不返回。",
    request: z.object({}),
    response: boardResponse,
    async handler(ctx) {
      return loadBoard(ctx);
    },
  }),

  actOnItem: defineAction({
    description:
      "页面按钮的用户操作：decide（拍板，带 choice 选项或 text 自定义意见，事项转进行中并标记已拍板·待执行）/ cancel_decision（取消拍板：仅限已拍板未执行的事项，退回待拍板、清除拍板记录并把被取消的拍板留痕写入 cancelledDecision）/ prioritize（优先）/ snooze（暂缓，清节点日期）/ cancel（取消归档）/ reopen（已办重新打开）。返回更新后的完整看板。",
    request: z.object({
      itemId: z.number().int().positive(),
      action: z.enum([
        "decide",
        "cancel_decision",
        "prioritize",
        "snooze",
        "cancel",
        "reopen",
      ]),
      choice: z.string().min(1).max(200).optional(),
      text: z.string().min(1).max(500).optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      board: boardResponse.nullable(),
    }),
    async handler(ctx, args) {
      // The whole transition runs in an inner function so every outcome —
      // applied or rejected — lands in the action log exactly once.
      const apply = async (): Promise<{
        ok: boolean;
        error: string | null;
        board: z.infer<typeof boardResponse> | null;
      }> => {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.items)
        .where(eq(schema.items.id, args.itemId))
        .limit(1);
      const row = existing[0];
      if (!row) {
        return { ok: false, error: "not_found", board: null };
      }

      const today = beijingDate();
      const patch: Partial<ItemRow> = {};

      switch (args.action) {
        case "decide": {
          if (row.status !== "needs_decision") {
            return { ok: false, error: "not_needs_decision", board: null };
          }
          const choice = args.choice?.trim() || null;
          const text = args.text?.trim() || null;
          if (!choice && !text) {
            return { ok: false, error: "missing_choice_or_text", board: null };
          }
          const picked = choice ?? text ?? "";
          patch.status = "in_progress";
          patch.userDecision = JSON.stringify({
            choice,
            text,
            decidedAt: beijingNow(),
          } satisfies UserDecision);
          patch.note = row.note
            ? `${row.note}\n你已拍板：${picked}`
            : `你已拍板：${picked}`;
          break;
        }
        case "cancel_decision": {
          // Only an unexecuted decision can be withdrawn: the item returns
          // to needs_decision, the decision itself moves into
          // cancelledDecision as a trace (旧拍板内容 + 取消时间）.
          const prev = parseDecision(row.userDecision);
          if (
            row.status !== "in_progress" ||
            !prev ||
            row.executedAt
          ) {
            return { ok: false, error: "not_pending_decision", board: null };
          }
          patch.status = "needs_decision";
          patch.userDecision = null;
          patch.cancelledDecision = JSON.stringify({
            choice: prev.choice,
            text: prev.text,
            decidedAt: prev.decidedAt,
            cancelledAt: beijingNow(),
          } satisfies CancelledDecision);
          // Undo the「你已拍板：…」line decide appended to the note, so the
          // item reads as it did before the decision.
          const pickedPrev = prev.choice ?? prev.text ?? "";
          const appended = `你已拍板：${pickedPrev}`;
          if (row.note === appended) {
            patch.note = "";
          } else if (row.note.endsWith(`\n${appended}`)) {
            patch.note = row.note.slice(0, -(appended.length + 1));
          }
          break;
        }
        case "prioritize": {
          if (row.status !== "in_progress") {
            return { ok: false, error: "not_in_progress", board: null };
          }
          patch.prioritizedAt = row.prioritizedAt ?? today;
          break;
        }
        case "snooze": {
          if (row.status !== "in_progress") {
            return { ok: false, error: "not_in_progress", board: null };
          }
          patch.snoozedAt = today;
          patch.dueDate = null;
          break;
        }
        case "cancel": {
          if (row.status === "done" || row.status === "cancelled") {
            return { ok: false, error: "not_cancellable", board: null };
          }
          patch.status = "cancelled";
          patch.cancelledAt = today;
          break;
        }
        case "reopen": {
          if (row.status !== "done") {
            return { ok: false, error: "not_done", board: null };
          }
          patch.status = "in_progress";
          patch.completedAt = null;
          break;
        }
      }

      await db
        .update(schema.items)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.items.id, args.itemId));
      // A fresh decision / priority mark is new pending work the last
      // dispatch did not cover: clear requestedAt so the board shows the
      // un-dispatched state again until the user presses发令 once more.
      if (args.action === "decide" || args.action === "prioritize") {
        await db
          .delete(schema.boardMeta)
          .where(eq(schema.boardMeta.key, EXECUTION_REQUESTED_KEY));
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, board: await loadBoard(ctx) };
      };
      const result = await apply();
      await logAction(
        ctx,
        `actOnItem:${args.action}`,
        args.itemId,
        result.ok,
        result.ok
          ? (args.choice ?? args.text ?? "").trim()
          : (result.error ?? "unknown_error"),
      );
      return result;
    },
  }),

  requestExecution: defineAction({
    description:
      "用户在面板按下「完成，开始执行」发令：把面板级 execution_requested_at 刷新为当前北京时间（YYYY-MM-DD HH:mm），巡检据此与各事项的待执行状态执行。返回更新后的完整看板（含 requestedAt 与待执行件数）。",
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      board: boardResponse.nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const now = beijingNow();
      await db
        .insert(schema.boardMeta)
        .values({ key: EXECUTION_REQUESTED_KEY, value: now })
        .onConflictDoUpdate({
          target: schema.boardMeta.key,
          set: { value: now },
        });
      ctx.invalidateQueries();
      const board = await loadBoard(ctx);
      await logAction(
        ctx,
        "requestExecution",
        null,
        true,
        `pending=${board.pendingExecution}`,
      );
      return { ok: true, error: null, board };
    },
  }),

  addItem: defineAction({
    description:
      "新增一条事项到待办总览看板：status 分组（needs_decision 待拍板 / in_progress 进行中 / done 已办）、标题、说明、来源，可选创建日期与拍板选项 options（字符串数组）。写入纪律：status=in_progress 必须带 dueDate（真节点日期或检查日期均可），缺失直接拒绝并返回 due_date_required_for_in_progress。",
    request: z.object({
      status: statusEnum,
      title: z.string().min(1).max(200),
      note: z.string().max(500).default(""),
      source: z.string().max(100).default(""),
      dueDate: dateString.nullable().optional(),
      createdAt: dateString.optional(),
      completedAt: dateString.nullable().optional(),
      options: z.array(z.string().min(1).max(100)).max(6).optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      id: z.number().nullable(),
    }),
    async handler(ctx, args) {
      // Write discipline: an in_progress item must carry a due date
      // (a real milestone date or a check-in date noted as such).
      if (args.status === "in_progress" && !args.dueDate) {
        return {
          ok: false,
          error: "due_date_required_for_in_progress",
          id: null,
        };
      }
      const db = ctx.db<typeof schema>();
      const today = beijingDate();
      const result = await db
        .insert(schema.items)
        .values({
          status: args.status,
          title: args.title,
          note: args.note,
          source: args.source,
          dueDate: args.dueDate ?? null,
          createdAt: args.createdAt ?? today,
          completedAt:
            args.status === "done"
              ? (args.completedAt ?? today)
              : (args.completedAt ?? null),
          options: JSON.stringify(args.options ?? []),
          cancelledAt: args.status === "cancelled" ? today : null,
        })
        .returning({ id: schema.items.id });
      const inserted = result[0];
      if (!inserted) {
        return { ok: false, error: "insert_failed", id: null };
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, id: inserted.id };
    },
  }),

  importInitialBacklog: defineAction({
    description:
      "一次性导入看板建立时的示例存量事项（等拍板、已排期、近两日已办）；按标题去重，重复调用不会重复写入。仓库归档版已将事项内容替换为虚构示例。",
    request: z.object({}),
    response: z.object({ inserted: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      // 示例存量事项：覆盖待拍板 / 进行中 / 已办三种状态，演示选项按钮、
      // 节点日期与完成留痕的写法（虚构内容，与真实事项无关）。
      const backlog: Array<{
        status: "needs_decision" | "in_progress" | "done";
        title: string;
        note: string;
        source: string;
        dueDate: string | null;
        createdAt: string;
        completedAt: string | null;
        options: string[];
      }> = [
        {
          status: "needs_decision",
          title: "示例：图表配色方案选哪一套",
          note: "助手已给出三套配色评估、等拍板；选定后按所选方案改版并在实机页面核对。",
          source: "示例来源",
          dueDate: null,
          createdAt: "2026-01-05",
          completedAt: null,
          options: ["方案甲", "方案乙", "方案丙"],
        },
        {
          status: "in_progress",
          title: "示例：月度报告数据复核",
          note: "数据已汇总，复核口径后交付。",
          source: "示例来源",
          dueDate: "2026-01-09",
          createdAt: "2026-01-06",
          completedAt: null,
          options: [],
        },
        {
          status: "in_progress",
          title: "示例：提醒系列：示例公司甲（1月12日）、示例公司乙（1月17日）",
          note: "每场事件日提前约一小时提醒；最后一场提醒后本系列结束。",
          source: "示例来源",
          dueDate: "2026-01-17",
          createdAt: "2026-01-04",
          completedAt: null,
          options: [],
        },
        {
          status: "in_progress",
          title: "示例：备份恢复演练",
          note: "恢复流程只做过文件级核对，尚未实机演练一次；找个低峰时段完整走一遍。",
          source: "示例来源",
          dueDate: "2026-01-20",
          createdAt: "2026-01-07",
          completedAt: null,
          options: [],
        },
        {
          status: "done",
          title: "示例：新面板上线并完成接线",
          note: "功能与数据通道均已就绪，首批内容已入账。",
          source: "示例来源",
          dueDate: null,
          createdAt: "2026-01-03",
          completedAt: "2026-01-03",
          options: [],
        },
        {
          status: "done",
          title: "示例：页面改为纯静态生成",
          note: "页面每日早晨生成一次，全天不变。",
          source: "示例来源",
          dueDate: null,
          createdAt: "2026-01-02",
          completedAt: "2026-01-02",
          options: [],
        },
      ];

      let inserted = 0;
      for (const item of backlog) {
        const existing = await db
          .select({ id: schema.items.id })
          .from(schema.items)
          .where(eq(schema.items.title, item.title))
          .limit(1);
        if (existing.length > 0) continue;
        await db.insert(schema.items).values({
          status: item.status,
          title: item.title,
          note: item.note,
          source: item.source,
          dueDate: item.dueDate,
          createdAt: item.createdAt,
          completedAt: item.completedAt,
          options: JSON.stringify(item.options),
        });
        inserted += 1;
      }
      if (inserted > 0) ctx.invalidateQueries();
      return { inserted };
    },
  }),

  backfillItemFields: defineAction({
    description:
      "一次性数据补全（幂等，只填空缺）：给两条示例待拍板事项补选项按钮（三选一、二选一各一条）；给两条无日期的示例进行中事项补日期并在 note 末尾注明性质（节点日期 / 检查日期）。仓库归档版已将目标事项替换为虚构示例。",
    request: z.object({}),
    response: z.object({ updated: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      let updated = 0;

      const optionTargets: Array<{ title: string; options: string[] }> = [
        {
          title: "示例事项甲：三选一",
          options: ["选项一", "选项二", "选项三"],
        },
        {
          title: "示例事项乙：二选一",
          options: ["已经完成了", "还没完成，帮我排查"],
        },
      ];
      for (const target of optionTargets) {
        const rows = await db
          .select()
          .from(schema.items)
          .where(eq(schema.items.title, target.title));
        for (const row of rows) {
          if (row.status !== "needs_decision") continue;
          if (parseOptions(row.options).length > 0) continue;
          await db
            .update(schema.items)
            .set({
              options: JSON.stringify(target.options),
              updatedAt: new Date(),
            })
            .where(eq(schema.items.id, row.id));
          updated += 1;
        }
      }

      const dateTargets: Array<{
        id: number;
        dueDate: string;
        noteSuffix: string;
      }> = [
        {
          id: 1, // 示例事项丙（节点日期）
          dueDate: "2026-01-15",
          noteSuffix:
            "节点日期：1月15日晨窗口内完成核对。",
        },
        {
          id: 2, // 示例事项丁（检查日期）
          dueDate: "2026-01-20",
          noteSuffix:
            "检查日期：1月20日（无硬期限，到期前找低峰时段执行；到期未做必须顺延并给出新日期）。",
        },
      ];
      for (const target of dateTargets) {
        const rows = await db
          .select()
          .from(schema.items)
          .where(eq(schema.items.id, target.id));
        const row = rows[0];
        if (!row || row.status !== "in_progress") continue;
        const patch: Partial<ItemRow> = {};
        if (!row.dueDate) patch.dueDate = target.dueDate;
        if (!row.note.includes(target.noteSuffix)) {
          patch.note = row.note
            ? `${row.note}\n${target.noteSuffix}`
            : target.noteSuffix;
        }
        if (Object.keys(patch).length === 0) continue;
        await db
          .update(schema.items)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(schema.items.id, row.id));
        updated += 1;
      }

      if (updated > 0) ctx.invalidateQueries();
      return { updated };
    },
  }),

  updateItem: defineAction({
    description:
      "按 id 修改一条事项的任意字段（含拍板选项 options、用户操作记录 userDecision / prioritizedAt / snoozedAt / cancelledAt、已取消拍板留痕 cancelledDecision（{choice, text, decidedAt, cancelledAt}，可写可清）与执行留痕 executedAt（北京时间 YYYY-MM-DD HH:mm）/ executionResult（一句结果，≤200 字））；可改 status 在分组间移动（转已办时自动记完成日期，转出已办时清除完成日期）。写入纪律：修改后 status=in_progress 时 dueDate 必须非空（真节点日期或检查日期均可），否则拒绝并返回 due_date_required_for_in_progress。",
    request: z.object({
      id: z.number().int().positive(),
      status: statusEnum.optional(),
      title: z.string().min(1).max(200).optional(),
      note: z.string().max(500).optional(),
      source: z.string().max(100).optional(),
      dueDate: dateString.nullable().optional(),
      createdAt: dateString.optional(),
      completedAt: dateString.nullable().optional(),
      options: z.array(z.string().min(1).max(100)).max(6).optional(),
      userDecision: userDecisionSchema.nullable().optional(),
      prioritizedAt: dateString.nullable().optional(),
      snoozedAt: dateString.nullable().optional(),
      cancelledAt: dateString.nullable().optional(),
      executedAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "expected YYYY-MM-DD HH:mm")
        .nullable()
        .optional(),
      executionResult: z.string().max(200).nullable().optional(),
      cancelledDecision: cancelledDecisionSchema.nullable().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      item: itemSchema.nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.items)
        .where(eq(schema.items.id, args.id))
        .limit(1);
      const row = existing[0];
      if (!row) {
        return { ok: false, error: "not_found", item: null };
      }

      const nextStatus = args.status ?? row.status;
      // Write discipline: an item that ends up in_progress must carry a
      // due date (real milestone or check-in date). Moving INTO done /
      // cancelled needs none; actOnItem's snooze is the sanctioned way to
      // park an in-progress item without a date.
      const nextDueDate =
        args.dueDate !== undefined ? args.dueDate : row.dueDate;
      const nextSnoozedAt =
        args.snoozedAt !== undefined ? args.snoozedAt : row.snoozedAt;
      if (nextStatus === "in_progress" && !nextDueDate && !nextSnoozedAt) {
        return {
          ok: false,
          error: "due_date_required_for_in_progress",
          item: null,
        };
      }
      let completedAt: string | null;
      if (args.completedAt !== undefined) {
        completedAt = args.completedAt;
      } else if (nextStatus === "done") {
        completedAt = row.completedAt ?? beijingDate();
      } else {
        completedAt = null;
      }

      const updated = await db
        .update(schema.items)
        .set({
          status: nextStatus,
          title: args.title ?? row.title,
          note: args.note ?? row.note,
          source: args.source ?? row.source,
          dueDate: args.dueDate !== undefined ? args.dueDate : row.dueDate,
          createdAt: args.createdAt ?? row.createdAt,
          completedAt,
          options:
            args.options !== undefined
              ? JSON.stringify(args.options)
              : row.options,
          userDecision:
            args.userDecision !== undefined
              ? args.userDecision === null
                ? null
                : JSON.stringify(args.userDecision)
              : row.userDecision,
          prioritizedAt:
            args.prioritizedAt !== undefined
              ? args.prioritizedAt
              : row.prioritizedAt,
          snoozedAt:
            args.snoozedAt !== undefined ? args.snoozedAt : row.snoozedAt,
          cancelledAt:
            args.cancelledAt !== undefined
              ? args.cancelledAt
              : nextStatus === "cancelled"
                ? (row.cancelledAt ?? beijingDate())
                : row.cancelledAt,
          executedAt:
            args.executedAt !== undefined ? args.executedAt : row.executedAt,
          executionResult:
            args.executionResult !== undefined
              ? args.executionResult
              : row.executionResult,
          cancelledDecision:
            args.cancelledDecision !== undefined
              ? args.cancelledDecision === null
                ? null
                : JSON.stringify(args.cancelledDecision)
              : row.cancelledDecision,
          updatedAt: new Date(),
        })
        .where(eq(schema.items.id, args.id))
        .returning();
      const updatedRow = updated[0];
      if (!updatedRow) {
        return { ok: false, error: "not_found", item: null };
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, item: toItem(updatedRow) };
    },
  }),

  getActionLog: defineAction({
    description:
      "读取页面操作审计日志（最近若干条，最新在前）：每次 actOnItem（拍板/取消拍板/优先/暂缓/取消/重新打开）与 requestExecution（发令）调用各一行，含北京时间（到秒）、动作、事项 id、成功与否与细节（所选选项或错误码），用于事后定位「点了没反应」类问题。",
    request: z.object({
      limit: z.number().int().min(1).max(200).optional(),
    }),
    response: z.object({
      entries: z.array(
        z.object({
          id: z.number(),
          at: z.string(),
          action: z.string(),
          itemId: z.number().nullable(),
          ok: z.boolean(),
          detail: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.actionLog)
        .orderBy(desc(schema.actionLog.id))
        .limit(args.limit ?? 50);
      return {
        entries: rows.map((r) => ({
          id: r.id,
          at: r.at,
          action: r.action,
          itemId: r.itemId,
          ok: r.ok === 1,
          detail: r.detail,
        })),
      };
    },
  }),
} satisfies ActionsModule;
