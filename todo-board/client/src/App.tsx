import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Board = ApiResponse<typeof api, "getBoard">;
type Item = Board["needsDecision"][number];
type ActArgs = Parameters<typeof api.actOnItem>[0];

/** Days between two dates (b - a), parsed as local calendar days. Inputs
 *  may be "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" — only the date part counts,
 *  so day-based labels （已等 X 天） are unaffected by the time component. */
function daysBetween(a: string, b: string): number {
  const pa = a.slice(0, 10).split("-").map(Number);
  const pb = b.slice(0, 10).split("-").map(Number);
  const da = new Date(pa[0] ?? 1970, (pa[1] ?? 1) - 1, pa[2] ?? 1);
  const db = new Date(pb[0] ?? 1970, (pb[1] ?? 1) - 1, pb[2] ?? 1);
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** "2026-11-08" -> "11月8日" */
function fmtDate(d: string): string {
  const parts = d.split("-").map(Number);
  const m = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return `${m}月${day}日`;
}

/** "2026-11-11 09:41" -> "11月11日 09:41" */
function fmtDateTime(dt: string): string {
  const [date, time] = dt.split(" ");
  return time ? `${fmtDate(date ?? "")} ${time}` : fmtDate(date ?? "");
}

/** Today as YYYY-MM-DD in Asia/Shanghai — matches the server's "today"
 *  so relative labels （已等 X 天 / 今天 / 明天） never drift by timezone. */
function todayBeijing(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function waitingLabel(item: Item, today: string): string {
  const days = daysBetween(item.createdAt, today);
  if (days <= 0) return "今天提出";
  if (days === 1) return "已等 1 天";
  return `已等 ${days} 天`;
}

function dueLabel(item: Item, today: string): string | null {
  if (!item.dueDate) return null;
  const diff = daysBetween(today, item.dueDate);
  if (diff < 0) return `节点 ${fmtDate(item.dueDate)} · 已过 ${-diff} 天`;
  if (diff === 0) return `节点 ${fmtDate(item.dueDate)} · 今天`;
  if (diff === 1) return `节点 ${fmtDate(item.dueDate)} · 明天`;
  return `节点 ${fmtDate(item.dueDate)} · ${diff} 天后`;
}

/** What the user picked: the option text, or their custom opinion. */
function decisionText(item: Item): string | null {
  const d = item.userDecision;
  if (!d) return null;
  return d.choice ?? d.text;
}

/** What the user had picked before withdrawing it via「取消拍板」. */
function cancelledText(item: Item): string | null {
  const d = item.cancelledDecision;
  if (!d) return null;
  return d.choice ?? d.text;
}

function MetaLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1.5 text-[12.5px] leading-[18px] text-[var(--dim)]">
      {children}
    </p>
  );
}

function NoteText({ text }: { text: string }) {
  return (
    <p className="mt-1 whitespace-pre-line text-sm leading-5 text-[var(--text)]">
      {text}
    </p>
  );
}

/** Server error codes from actOnItem, in words the user can act on. The raw
 *  server error string is appended in brackets in EVERY case, so what the
 *  server actually returned is never dropped and a screenshot of the
 *  failure carries the code for diagnosis. */
function errorText(code: string | null): string {
  const raw = code ? `（${code}）` : "";
  switch (code) {
    case "not_found":
      return `没找到这条事项，可能已经被处理了，列表已刷新。${raw}`;
    case "not_needs_decision":
      return `这条已经不在待拍板区了（可能已经拍过板），列表已刷新。${raw}`;
    case "not_pending_decision":
      return `这条当前没有待执行的拍板可取消，列表已刷新。${raw}`;
    case "not_in_progress":
      return `这条已经不在进行中了，列表已刷新。${raw}`;
    case "not_cancellable":
      return `这条现在不能取消，列表已刷新。${raw}`;
    case "not_done":
      return `这条不在已办区，列表已刷新。${raw}`;
    case "missing_choice_or_text":
      return `没有读到你的选择，请再点一次。${raw}`;
    case "request_timeout":
      return `请求超时：已经自动重试了一次，仍没能确认保存结果，这次操作按未保存处理。${raw}`;
    case "network_failed":
      return `网络连接失败：已经自动重试了一次，仍没能确认保存结果，这次操作按未保存处理。${raw}`;
    case "verify_failed":
      return `服务器有回应，但回读确认时没看到这次操作的结果，按未保存处理。${raw}`;
    default:
      return code
        ? `操作没成功${raw}，可以点重试再试一次。`
        : "操作没成功，可以点重试再试一次。";
  }
}

/** Visible failure feedback: a prominent, persistent alert box — it never
 *  auto-dismisses and is only cleared by a later successful save. It names
 *  the failure plainly and keeps an in-place retry that re-sends the exact
 *  same action. */
function ActionError({
  message,
  onRetry,
  busy,
}: {
  message: string;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <div
      role="alert"
      className="mt-3 rounded-lg border-2 border-[var(--accent)] bg-[var(--surface)] px-3 py-2.5 shadow-md"
    >
      <p className="text-[13.5px] font-bold leading-5 text-[var(--accent)]">
        未保存成功，请重试
      </p>
      <p className="mt-0.5 text-[12.5px] leading-[18px] text-[var(--text)]">
        {message}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={onRetry}
        className="mt-2 min-h-9 cursor-pointer touch-manipulation rounded-full bg-[var(--accent)] px-4 py-1.5 text-[13px] font-semibold leading-[18px] text-white active:opacity-80 disabled:opacity-50"
      >
        {busy ? "正在重试…" : "重试保存"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 请求硬化层：写操作（actOnItem / requestExecution）统一走这里。       */
/* 单次请求 8 秒超时；超时或网络失败时，先回读确认是否其实已落库，     */
/* 没落库才自动重试一次；请求成功返回后也要再回读一次看板，校验结果   */
/* 真的落库（拍板类校验 userDecision 与待执行数），校验不过按失败处理。*/
/* 业务性拒绝（ok:false 的错误码）不重试，直接按原样上报。             */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT_MS = 8000;

class RequestTimeoutError extends Error {
  constructor() {
    super("request_timeout");
    this.name = "RequestTimeoutError";
  }
}

/** Race a promise against a timeout; a hung request in the webview (the
 *  intermittent "tap did nothing" failure) rejects instead of hanging
 *  forever, so the retry / error path actually gets to run. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new RequestTimeoutError()),
      ms,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        window.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function findItem(board: Board, itemId: number): Item | undefined {
  return [
    ...board.needsDecision,
    ...board.inProgress,
    ...board.done,
  ].find((i) => i.id === itemId);
}

/** Post-condition check on a freshly read board: did this action's effect
 *  actually land? For decide that means the item is in progress with the
 *  exact decision recorded and counted as pending execution. */
function actLanded(board: Board, args: ActArgs): boolean {
  const item = findItem(board, args.itemId);
  switch (args.action) {
    case "decide": {
      if (!item || item.status !== "in_progress" || !item.userDecision) {
        return false;
      }
      const picked = (args.choice ?? args.text ?? "").trim();
      const recorded =
        item.userDecision.choice ?? item.userDecision.text ?? "";
      if (picked && recorded !== picked) return false;
      return board.pendingExecution >= 1 || item.executedAt !== null;
    }
    case "cancel_decision":
      return Boolean(
        item &&
          item.status === "needs_decision" &&
          !item.userDecision &&
          item.cancelledDecision,
      );
    case "prioritize":
      return Boolean(
        item && item.status === "in_progress" && item.prioritizedAt,
      );
    case "snooze":
      return Boolean(item && item.status === "in_progress" && item.snoozedAt);
    case "cancel":
      // Cancelled items are archived server-side and never returned.
      return !item;
    case "reopen":
      return Boolean(item && item.status === "in_progress");
    default:
      return false;
  }
}

/** Independent read-back of the board (own 8s timeout). Null when the
 *  read itself could not be completed. */
async function readBackBoard(): Promise<Board | null> {
  try {
    return await withTimeout(api.getBoard({}), REQUEST_TIMEOUT_MS);
  } catch {
    return null;
  }
}

type ActResult = ApiResponse<typeof api, "actOnItem">;

async function hardenedActOnItem(args: ActArgs): Promise<ActResult> {
  let lastTransport: "request_timeout" | "network_failed" = "network_failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: ActResult;
    try {
      res = await withTimeout(api.actOnItem(args), REQUEST_TIMEOUT_MS);
    } catch (err) {
      // Timeout / transport failure: the reply may simply be lost while
      // the write actually landed — check before retrying blindly.
      lastTransport =
        err instanceof RequestTimeoutError
          ? "request_timeout"
          : "network_failed";
      const fresh = await readBackBoard();
      if (fresh && actLanded(fresh, args)) {
        return { ok: true, error: null, board: fresh };
      }
      continue; // automatic single retry
    }
    if (!res.ok || !res.board) {
      // A business rejection can also be the echo of a first attempt that
      // timed out but landed (e.g. decide → not_needs_decision): confirm
      // against a fresh read before reporting failure.
      const fresh = await readBackBoard();
      if (fresh && actLanded(fresh, args)) {
        return { ok: true, error: null, board: fresh };
      }
      return res;
    }
    // Response received: verify with an independent read-back.
    const fresh = await readBackBoard();
    if (fresh) {
      return actLanded(fresh, args)
        ? { ok: true, error: null, board: fresh }
        : { ok: false, error: "verify_failed", board: null };
    }
    // Read-back itself unreachable: fall back to the board the write
    // response already carried (it is loaded after the write server-side).
    return actLanded(res.board, args)
      ? res
      : { ok: false, error: "verify_failed", board: null };
  }
  return { ok: false, error: lastTransport, board: null };
}

type DispatchResult = ApiResponse<typeof api, "requestExecution">;

async function hardenedRequestExecution(): Promise<DispatchResult> {
  let lastTransport: "request_timeout" | "network_failed" = "network_failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: DispatchResult;
    try {
      res = await withTimeout(api.requestExecution({}), REQUEST_TIMEOUT_MS);
    } catch (err) {
      lastTransport =
        err instanceof RequestTimeoutError
          ? "request_timeout"
          : "network_failed";
      const fresh = await readBackBoard();
      if (fresh && fresh.requestedAt) {
        return { ok: true, error: null, board: fresh };
      }
      continue; // automatic single retry
    }
    if (!res.ok || !res.board) return res;
    const fresh = await readBackBoard();
    if (fresh) {
      return fresh.requestedAt
        ? { ok: true, error: null, board: fresh }
        : { ok: false, error: "verify_failed", board: null };
    }
    return res.board.requestedAt
      ? res
      : { ok: false, error: "verify_failed", board: null };
  }
  return { ok: false, error: lastTransport, board: null };
}

type ActFn = (args: ActArgs) => void;

function DecisionItem({
  item,
  today,
  act,
  busy,
  error,
  onRetry,
  highlighted,
}: {
  item: Item;
  today: string;
  act: ActFn;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  highlighted: boolean;
}) {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const cancelled = cancelledText(item);
  return (
    <li
      id={`item-${item.id}`}
      className={`border-l-4 border-l-[var(--accent)] bg-[var(--accent-soft)] px-3.5 py-3 ${
        highlighted ? "shadow-[inset_0_0_0_2px_var(--teal)]" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-base font-semibold leading-6 text-[var(--text)]">
          {item.title}
        </h3>
        <span className="shrink-0 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[12px] font-semibold leading-5 text-white">
          {waitingLabel(item, today)}
        </span>
      </div>
      {item.note ? <NoteText text={item.note} /> : null}
      {/* 取消拍板留痕：曾经拍过板又撤回的事项，弱化一行说明 */}
      {cancelled && item.cancelledDecision ? (
        <p className="mt-1 text-[12.5px] leading-[18px] text-[var(--dim)]">
          曾拍板：{cancelled} · 已于{" "}
          {fmtDateTime(item.cancelledDecision.cancelledAt)} 取消
        </p>
      ) : null}
      <MetaLine>
        {item.source ? <span>来源：{item.source} · </span> : null}
        <span>{fmtDateTime(item.createdAt)}提出</span>
        {item.dueDate ? <span> · 希望 {fmtDate(item.dueDate)} 前定</span> : null}
      </MetaLine>

      {/* 拍板操作：小号胶囊选项，轻样式、次级层级，一行排不下自动换行 */}
      <div className="mt-2.5">
        {item.options.length > 0 ? (
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={`为「${item.title}」拍板`}
          >
            {item.options.map((opt) => (
              <button
                key={opt}
                type="button"
                disabled={busy}
                onClick={() =>
                  act({ itemId: item.id, action: "decide", choice: opt })
                }
                className="min-h-8 cursor-pointer touch-manipulation rounded-full border border-[var(--accent)] bg-[var(--surface)] px-3 py-1.5 text-[13px] font-medium leading-[18px] text-[var(--accent)] active:bg-[var(--accent)] active:text-white disabled:opacity-50"
              >
                {opt}
              </button>
            ))}
          </div>
        ) : null}
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed || busy) return;
            // Keep the draft until the save is confirmed: on success the
            // card leaves this section (and unmounts); on failure the text
            // stays put so nothing the user typed is lost.
            act({ itemId: item.id, action: "decide", text: trimmed });
          }}
        >
          <label className="sr-only" htmlFor={`custom-idea-${item.id}`}>
            其他想法（写一句你的处理意见）
          </label>
          <input
            id={`custom-idea-${item.id}`}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="其他想法：写一句你的处理意见…"
            maxLength={200}
            className="min-h-8 min-w-0 flex-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[13px] leading-[18px] text-[var(--text)] placeholder:text-[var(--dim)]"
          />
          <button
            type="submit"
            disabled={busy || !trimmed}
            className="min-h-8 shrink-0 cursor-pointer touch-manipulation rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[13px] font-medium leading-[18px] text-[var(--accent)] active:bg-[var(--bg)] disabled:opacity-50"
          >
            提交
          </button>
        </form>
        {busy ? (
          <p className="mt-2 text-[12.5px] leading-[18px] text-[var(--dim)]">
            正在记下…（网络慢时会自动重试一次，请稍候）
          </p>
        ) : null}
        {error ? (
          <ActionError message={error} onRetry={onRetry} busy={busy} />
        ) : null}
      </div>
    </li>
  );
}

function ProgressItem({
  item,
  today,
  act,
  busy,
  error,
  onRetry,
  highlighted,
}: {
  item: Item;
  today: string;
  act: ActFn;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  highlighted: boolean;
}) {
  const picked = decisionText(item);
  const snoozed = Boolean(item.snoozedAt) && !item.dueDate;
  const due = snoozed ? null : dueLabel(item, today);
  const dueDiff = item.dueDate ? daysBetween(today, item.dueDate) : null;
  const urgent = !snoozed && dueDiff !== null && dueDiff <= 0; // overdue or due today
  return (
    <li
      id={`item-${item.id}`}
      className={`bg-[var(--surface)] px-3.5 py-3 ${
        highlighted ? "shadow-[inset_0_0_0_2px_var(--teal)]" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-base font-medium leading-6 text-[var(--text)]">
          {item.title}
        </h3>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {picked ? (
            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[12px] font-semibold leading-5 text-white">
              {item.executedAt ? "已拍板 · 已执行" : "已拍板 · 待执行"}
            </span>
          ) : null}
          {item.prioritizedAt ? (
            <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[12px] font-semibold leading-5 text-[var(--accent)]">
              已优先
            </span>
          ) : null}
          {snoozed ? (
            <span className="rounded-full bg-[var(--bg)] px-2 py-0.5 text-[12px] font-medium leading-5 text-[var(--dim)]">
              已暂缓
            </span>
          ) : null}
          {due ? (
            <span
              className={`rounded-full px-2 py-0.5 text-[12px] font-medium leading-5 ${
                urgent
                  ? "bg-[var(--accent-soft)] font-semibold text-[var(--accent)]"
                  : "bg-[var(--teal-soft)] text-[var(--teal)]"
              }`}
            >
              {due}
            </span>
          ) : null}
        </div>
      </div>
      {item.note ? <NoteText text={item.note} /> : null}
      {/* 执行留痕（变动表）：确认段 + 执行段，落在事项本身上 */}
      {picked || item.executedAt ? (
        <div className="mt-2 rounded-lg bg-[var(--accent-soft)] px-2.5 py-1.5 text-[13px] leading-5">
          {picked && item.userDecision ? (
            <p className="font-medium text-[var(--accent)]">
              已确认：{picked}
              <span className="font-normal">
                （{fmtDateTime(item.userDecision.decidedAt)}拍板）
              </span>
            </p>
          ) : null}
          {item.executedAt ? (
            <p className="font-medium text-[var(--teal)]">
              已执行 {fmtDateTime(item.executedAt)}
              {item.executionResult ? (
                <span className="font-normal text-[var(--text)]">
                  {" "}
                  · {item.executionResult}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="text-[var(--accent)]">待执行</p>
          )}
          {/* 取消拍板：仅已拍板未执行的事项可撤回（已执行的不显示） */}
          {picked && !item.executedAt ? (
            <div className="mt-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  act({ itemId: item.id, action: "cancel_decision" })
                }
                className="min-h-8 cursor-pointer touch-manipulation rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-[12.5px] font-medium leading-[18px] text-[var(--dim)] active:opacity-80 disabled:opacity-50"
              >
                取消拍板
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <MetaLine>
        {item.source ? <span>来源：{item.source} · </span> : null}
        <span>{fmtDateTime(item.createdAt)}开始</span>
        {snoozed && item.snoozedAt ? (
          <span> · {fmtDateTime(item.snoozedAt)}暂缓</span>
        ) : null}
      </MetaLine>

      <div
        className="mt-2.5 flex flex-wrap gap-1.5"
        role="group"
        aria-label={`对「${item.title}」的操作`}
      >
        <button
          type="button"
          disabled={busy || Boolean(item.prioritizedAt)}
          onClick={() => act({ itemId: item.id, action: "prioritize" })}
          className="min-h-8 cursor-pointer touch-manipulation rounded-full bg-[var(--teal-soft)] px-3 py-1.5 text-[13px] font-semibold leading-[18px] text-[var(--teal)] active:opacity-80 disabled:opacity-50"
        >
          {item.prioritizedAt ? "已优先" : "优先处理"}
        </button>
        <button
          type="button"
          disabled={busy || snoozed}
          onClick={() => act({ itemId: item.id, action: "snooze" })}
          className="min-h-8 cursor-pointer touch-manipulation rounded-full bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium leading-[18px] text-[var(--text)] active:opacity-80 disabled:opacity-50"
        >
          {snoozed ? "已暂缓" : "暂缓"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => act({ itemId: item.id, action: "cancel" })}
          className="min-h-8 cursor-pointer touch-manipulation rounded-full bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium leading-[18px] text-[var(--dim)] active:opacity-80 disabled:opacity-50"
        >
          取消
        </button>
      </div>
      {busy ? (
        <p className="mt-2 text-[12.5px] leading-[18px] text-[var(--dim)]">
          正在记下…（网络慢时会自动重试一次，请稍候）
        </p>
      ) : null}
      {error ? (
        <ActionError message={error} onRetry={onRetry} busy={busy} />
      ) : null}
    </li>
  );
}

function DoneItem({
  item,
  act,
  busy,
  error,
  onRetry,
  highlighted,
}: {
  item: Item;
  act: ActFn;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  highlighted: boolean;
}) {
  return (
    <li
      id={`item-${item.id}`}
      className={`bg-[var(--surface)] px-3.5 py-2.5 opacity-70 ${
        highlighted ? "shadow-[inset_0_0_0_2px_var(--teal)]" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--teal)]">
          ✓
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium leading-[22px] text-[var(--text)] line-through decoration-[var(--dim)] decoration-1">
            {item.title}
          </h3>
          {item.note ? (
            <p className="mt-0.5 whitespace-pre-line text-[13px] leading-[19px] text-[var(--dim)]">
              {item.note}
            </p>
          ) : null}
          <p className="mt-1 text-[12px] leading-[17px] text-[var(--dim)]">
            {item.source ? <span>来源：{item.source} · </span> : null}
            {item.completedAt ? (
              <span>{fmtDateTime(item.completedAt)}办完</span>
            ) : null}
          </p>
          <div className="mt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => act({ itemId: item.id, action: "reopen" })}
              className="min-h-8 cursor-pointer touch-manipulation rounded-full bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium leading-[18px] text-[var(--text)] active:opacity-80 disabled:opacity-50"
            >
              重新打开
            </button>
            {error ? (
              <ActionError message={error} onRetry={onRetry} busy={busy} />
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

function SectionHead({
  title,
  count,
  accent,
}: {
  title: string;
  count: number;
  accent?: boolean;
}) {
  return (
    <h2
      className={`text-[15px] font-semibold leading-6 ${
        accent ? "text-[var(--accent)]" : "text-[var(--text)]"
      }`}
    >
      {title}
      <span className="ml-2 text-[13px] font-normal text-[var(--dim)]">
        {count} 件
      </span>
    </h2>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <p className="bg-[var(--surface)] px-3.5 py-3 text-sm text-[var(--dim)]">
      {text}
    </p>
  );
}

/**
 * Scroll to a section by id. `scrollIntoView({ behavior: "smooth" })` alone
 * silently does nothing in some embedded webviews (no smooth-scroll support
 * on the inner scroll container), so fall back to an instant scrollIntoView
 * and, if the section still isn't near the viewport top, set the scroll
 * container's scrollTop directly.
 */
function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  try {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {
    el.scrollIntoView();
  }
  window.setTimeout(() => {
    if (el.getBoundingClientRect().top > 48) {
      el.scrollIntoView();
      if (el.getBoundingClientRect().top > 48) {
        const scroller =
          document.scrollingElement ?? document.documentElement;
        const top =
          el.getBoundingClientRect().top + scroller.scrollTop - 16;
        scroller.scrollTop = Math.max(0, top);
      }
    }
  }, 450);
}

/** Confirmation copy after a successful page action. A decide names the
 *  option (or custom opinion) that was recorded, so the user can see at a
 *  glance exactly what landed. */
function successText(args: ActArgs): string {
  switch (args.action) {
    case "decide": {
      const picked = args.choice ?? args.text;
      return picked
        ? `已记下拍板：${picked} · 已转到「进行中 · 待执行」`
        : "已记下你的拍板，这条已转到「进行中 · 待执行」";
    }
    case "cancel_decision":
      return "已取消拍板，这条已回到「待你拍板」";
    case "prioritize":
      return "已标记优先处理";
    case "snooze":
      return "已暂缓这条事项";
    case "cancel":
      return "已取消这条事项";
    case "reopen":
      return "已重新打开，转到「进行中」";
    default:
      return "已保存";
  }
}

/** Bring an item card into view by its anchor id (same fallback chain as
 *  scrollToSection: smooth, then instant, then direct scrollTop). */
function scrollToItem(id: number) {
  const el = document.getElementById(`item-${id}`);
  if (!el) return;
  try {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    el.scrollIntoView();
  }
  window.setTimeout(() => {
    const rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      el.scrollIntoView({ block: "center" });
    }
  }, 450);
}

export function App() {
  const queryClient = useQueryClient();
  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => api.getBoard({}),
  });
  // Visible success confirmation: a banner names what was saved, and the
  // affected card is scrolled into view and outlined until it fades.
  const [notice, setNotice] = useState<{
    text: string;
    itemId: number;
    key: number;
  } | null>(null);
  // Last failed action, kept with its exact args so「重试」re-sends it.
  const [actFailure, setActFailure] = useState<{
    itemId: number;
    message: string;
    args: ActArgs;
  } | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const scrollTimer = window.setTimeout(
      () => scrollToItem(notice.itemId),
      60,
    );
    const clearTimer = window.setTimeout(() => setNotice(null), 5000);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [notice]);

  const actMutation = useMutation({
    // All page writes go through the hardened layer: 8s timeout, one
    // automatic retry on timeout / network failure, and a read-back
    // verification that the effect really landed before reporting success.
    mutationFn: async (args: ActArgs) => await hardenedActOnItem(args),
    onSuccess: (res, args) => {
      // actOnItem returns the refreshed board: swap it in in place —
      // no navigation, no refetch flicker.
      if (res.ok && res.board) {
        queryClient.setQueryData(["board"], res.board);
        setActFailure(null);
        setNotice({
          text: successText(args),
          itemId: args.itemId,
          key: Date.now(),
        });
      } else {
        setActFailure({
          itemId: args.itemId,
          message: errorText(res.error),
          args,
        });
        void queryClient.invalidateQueries({ queryKey: ["board"] });
      }
    },
    onError: (_err, args) => {
      // Unexpected failure outside the hardened layer's handled paths
      // (it converts timeout / network / verify failures into ok:false
      // results itself). Say so plainly and keep the in-place retry.
      setActFailure({
        itemId: args.itemId,
        message:
          "网络或服务异常（已自动重试一次），这次操作没有保存下来。可以点重试再试一次。",
        args,
      });
    },
  });
  const dispatchMutation = useMutation({
    mutationFn: async () => await hardenedRequestExecution(),
    onSuccess: (res) => {
      if (res.ok && res.board) {
        queryClient.setQueryData(["board"], res.board);
        setDispatchError(null);
      } else {
        setDispatchError(errorText(res.error));
        void queryClient.invalidateQueries({ queryKey: ["board"] });
      }
    },
    onError: () => {
      setDispatchError(
        "网络或服务异常（已自动重试一次），发令没有确认保存下来。用下方按钮重试发令。",
      );
    },
  });
  const act: ActFn = (args) => actMutation.mutate(args);
  const retryAct = () => {
    if (actFailure) actMutation.mutate(actFailure.args);
  };
  const busyId = actMutation.isPending
    ? (actMutation.variables?.itemId ?? null)
    : null;
  const errorFor = (item: Item): string | null =>
    actFailure && actFailure.itemId === item.id ? actFailure.message : null;
  const highlightedId = notice?.itemId ?? null;

  const today = todayBeijing();
  const [doneExpanded, setDoneExpanded] = useState(false);
  const DONE_PREVIEW = 5;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      <main
        className={`mx-auto w-full max-w-2xl px-4 ${
          board.data && board.data.pendingExecution > 0 ? "pb-32" : "pb-10"
        }`}
      >
        {board.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">
            正在加载…
          </p>
        ) : board.error ? (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--dim)]">加载失败，稍后再试。</p>
            <button
              type="button"
              onClick={() => board.refetch()}
              className="mt-3 rounded-lg bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)]"
            >
              重新加载
            </button>
          </div>
        ) : (
          <>
            {/* 计数小结：点击滚动到对应分组；sticky 吸顶固定，
                内容滚动时这行不跟着走 */}
            <nav
              aria-label="跳转到分组"
              className="sticky top-2 z-10 mt-4 flex items-stretch gap-1 rounded-xl bg-[var(--surface)] px-2 py-1.5 shadow-md"
            >
              <button
                type="button"
                aria-label={`待你拍板，共 ${board.data.counts.needsDecision} 件，点击查看`}
                onClick={() => scrollToSection("section-needs-decision")}
                className="flex-1 cursor-pointer touch-manipulation rounded-lg px-2 py-1.5 text-left text-[15px] leading-6 active:bg-[var(--accent-soft)]"
              >
                <span className="font-semibold text-[var(--accent)]">
                  待你拍板{" "}
                  <span className="text-[19px] font-bold">
                    {board.data.counts.needsDecision}
                  </span>
                </span>
              </button>
              <span aria-hidden="true" className="my-2 w-px bg-[var(--border)]" />
              <button
                type="button"
                aria-label={`进行中，共 ${board.data.counts.inProgress} 件，点击查看`}
                onClick={() => scrollToSection("section-in-progress")}
                className="flex-1 cursor-pointer touch-manipulation rounded-lg px-2 py-1.5 text-left text-[15px] leading-6 text-[var(--text)] active:bg-[var(--teal-soft)]"
              >
                进行中{" "}
                <span className="text-[19px] font-bold">
                  {board.data.counts.inProgress}
                </span>
              </button>
              <span aria-hidden="true" className="my-2 w-px bg-[var(--border)]" />
              <button
                type="button"
                aria-label={`已办，共 ${board.data.counts.done} 件，点击查看`}
                onClick={() => scrollToSection("section-done")}
                className="flex-1 cursor-pointer touch-manipulation rounded-lg px-2 py-1.5 text-left text-[15px] leading-6 text-[var(--dim)] active:bg-[var(--bg)]"
              >
                已办{" "}
                <span className="text-[19px] font-bold">
                  {board.data.counts.done}
                </span>
              </button>
            </nav>

            {/* 待你拍板 */}
            <section
              id="section-needs-decision"
              aria-label="待你拍板"
              className="mt-6 scroll-mt-4"
            >
              <SectionHead
                title="待你拍板"
                count={board.data.needsDecision.length}
                accent
              />
              {board.data.needsDecision.length === 0 ? (
                <div className="mt-2 overflow-hidden rounded-xl">
                  <EmptyLine text="没有等你决定的事。" />
                </div>
              ) : (
                <ul className="mt-2 flex flex-col gap-2 overflow-hidden rounded-xl">
                  {board.data.needsDecision.map((item) => (
                    <DecisionItem
                      key={item.id}
                      item={item}
                      today={today}
                      act={act}
                      busy={busyId === item.id}
                      error={errorFor(item)}
                      onRetry={retryAct}
                      highlighted={highlightedId === item.id}
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* 进行中 */}
            <section
              id="section-in-progress"
              aria-label="进行中"
              className="mt-8 scroll-mt-4"
            >
              <SectionHead
                title="进行中"
                count={board.data.inProgress.length}
              />
              {board.data.inProgress.length === 0 ? (
                <div className="mt-2 overflow-hidden rounded-xl">
                  <EmptyLine text="暂无进行中的事项。" />
                </div>
              ) : (
                <ul className="mt-2 flex flex-col gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)]">
                  {board.data.inProgress.map((item) => (
                    <ProgressItem
                      key={item.id}
                      item={item}
                      today={today}
                      act={act}
                      busy={busyId === item.id}
                      error={errorFor(item)}
                      onRetry={retryAct}
                      highlighted={highlightedId === item.id}
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* 已办 */}
            <section
              id="section-done"
              aria-label="已办"
              className="mt-8 scroll-mt-4"
            >
              <SectionHead title="已办" count={board.data.done.length} />
              {board.data.done.length === 0 ? (
                <div className="mt-2 overflow-hidden rounded-xl">
                  <EmptyLine text="最近 14 天暂无已办事项。" />
                </div>
              ) : (
                <>
                  <ul className="mt-2 flex flex-col gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)]">
                    {(doneExpanded
                      ? board.data.done
                      : board.data.done.slice(0, DONE_PREVIEW)
                    ).map((item) => (
                      <DoneItem
                        key={item.id}
                        item={item}
                        act={act}
                        busy={busyId === item.id}
                        error={errorFor(item)}
                        onRetry={retryAct}
                        highlighted={highlightedId === item.id}
                      />
                    ))}
                  </ul>
                  {board.data.done.length > DONE_PREVIEW ? (
                    <button
                      type="button"
                      aria-expanded={doneExpanded}
                      onClick={() => setDoneExpanded((v) => !v)}
                      className="mt-2 w-full rounded-lg bg-[var(--surface)] px-4 py-2 text-[13px] font-medium text-[var(--dim)]"
                    >
                      {doneExpanded
                        ? "收起"
                        : `展开全部 ${board.data.done.length} 条已办`}
                    </button>
                  ) : null}
                </>
              )}
              <p className="mt-2 text-[12px] leading-5 text-[var(--dim)]">
                已办只保留最近 14 天，更早的自动清除。
              </p>
            </section>
          </>
        )}
      </main>

      {/* 保存成功确认：浮动横幅，5 秒后自动消失；对应卡片同时被滚动定位
          并描边高亮（见 notice 状态与 scrollToItem）。 */}
      {notice ? (
        <div
          key={notice.key}
          role="status"
          className={`fixed inset-x-0 z-30 flex justify-center px-4 ${
            board.data && board.data.pendingExecution > 0
              ? "bottom-24"
              : "bottom-6"
          }`}
        >
          <p className="flex items-center gap-2 rounded-full bg-[var(--teal)] px-4 py-2 text-[13.5px] font-semibold leading-5 text-white shadow-lg">
            <span aria-hidden="true">✓</span>
            {notice.text}
          </p>
        </div>
      ) : null}

      {/* 发令底栏：固定在视口底部，不随页面滚动；仅当存在待执行事项时出现，
          已发令后变为状态显示，待执行清零自动隐藏。 */}
      {!board.isPending &&
      !board.error &&
      board.data &&
      board.data.pendingExecution > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[var(--bg)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5">
          <div className="mx-auto w-full max-w-2xl">
            {board.data.requestedAt ? (
              <button
                type="button"
                disabled={dispatchMutation.isPending}
                onClick={() => dispatchMutation.mutate()}
                aria-label={`已发令，待执行 ${board.data.pendingExecution} 件，点击重新发令`}
                className="flex min-h-11 w-full cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-xl bg-[var(--teal-soft)] px-4 py-2.5 text-center active:opacity-80 disabled:opacity-50"
              >
                <span className="text-[15px] font-semibold leading-6 text-[var(--teal)]">
                  已发令 · 待执行 {board.data.pendingExecution} 件
                </span>
                <span className="text-[12.5px] leading-5 text-[var(--dim)]">
                  {fmtDateTime(board.data.requestedAt)}发出
                </span>
              </button>
            ) : (
              <button
                type="button"
                disabled={dispatchMutation.isPending}
                onClick={() => dispatchMutation.mutate()}
                className="min-h-11 w-full cursor-pointer touch-manipulation rounded-xl bg-[var(--accent)] px-4 py-2.5 text-[15px] font-semibold leading-6 text-white active:opacity-80 disabled:opacity-50"
              >
                {dispatchMutation.isPending
                  ? "正在发令…"
                  : `完成，开始执行（待执行 ${board.data.pendingExecution} 件）`}
              </button>
            )}
            {dispatchError ? (
              <div
                role="alert"
                className="mt-2 rounded-lg border-2 border-[var(--accent)] bg-[var(--surface)] px-3 py-2.5 shadow-md"
              >
                <p className="text-[13.5px] font-bold leading-5 text-[var(--accent)]">
                  发令未确认成功
                </p>
                <p className="mt-0.5 text-[12.5px] leading-[18px] text-[var(--text)]">
                  {dispatchError}
                </p>
                <button
                  type="button"
                  disabled={dispatchMutation.isPending}
                  onClick={() => dispatchMutation.mutate()}
                  className="mt-2 min-h-9 w-full cursor-pointer touch-manipulation rounded-full bg-[var(--accent)] px-4 py-1.5 text-[13px] font-semibold leading-[18px] text-white active:opacity-80 disabled:opacity-50"
                >
                  {dispatchMutation.isPending ? "正在重试…" : "重试发令"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
