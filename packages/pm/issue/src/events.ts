/**
 * 工单变更的事件词表与「上一版 → 本版」的差异换算。
 *
 * ## 为什么活动流由**差异**得出，而不是由调用方各自 append
 *
 * 活动流要回答的是「谁在什么时候把哪个字段从什么改成了什么」。若每个写入口各自
 * append，那**漏一个入口就是一条静默缺失的审计**，而且漏了不报错。这里改成：
 * 记录的唯一写路径是 `ctx.issues`（`index.ts`），它拿写前快照与写后记录做差，
 * 差异再换算成事件。⇒ 审计的形状由**一处**决定。
 *
 * ## 差异只能在这里算
 *
 * `domain/changed` 只带新值（`@matter/storage-domain` 的契约如此），订阅方没有旧值可比。
 * 旧值只在写链的**这一格**里同时可见 ⇒ 差异必须在这里发生。放到订阅方做，
 * 那个订阅方就成了记录状态的第二个家。
 *
 * ## 词表照旧树，不自造
 *
 * 旧树 `forge-pm/lib/domain.js` 已定：ISS 的 7 个状态各有一个**信号名**
 * （`ISSUE_STATUS_EVENT`），正文走 `body-change`（记指纹，不记正文），其余字段走
 * `field-change`，建单走 `issue-created`，删除走 `deleted`。本文件逐字沿用 ——
 * 换名字的代价是存量事件与将来迁移对不上，而 `activityUid` 的幂等保证正是为迁移准备的。
 *
 * ## ⛔ 与旧树的一处有意分歧：`from` / `to` 恒出现
 *
 * 旧树在值为 `null` 时**省略**该键（`entity-ops.js:876-877`）。省略让「这个字段被删掉了」
 * 与「这个事件根本没讲这个字段」在 payload 上长得一样。本仓改为恒出现、缺值写 `null`：
 * 多两个键的代价换掉一类静默歧义。
 *
 * ## 机制在家 storage-journal，词表在本文件（ISS-524）
 *
 * `logValue` / `sameValue` / entry 核心列拼装 / diff 骨架是域无关机制，已并入
 * `@matter/storage-journal` 的 `audit.ts`（一物一家）。本文件只保留工单**独有**的东西：
 * 状态信号词表、正文指纹、`fieldEntry` 的字段口径。公开导出名不变（再导出）。
 *
 * @module @matter/issue/src/events
 */

import { createHash } from "node:crypto"
import type { JournalEntry } from "@matter/storage-journal"
import {
  auditValue,
  makeAuditEntry,
  makeAuditDiff,
} from "@matter/storage-journal"
// 公开 API 名保持不变：机制实现搬到 journal，这里只做别名再导出。
export {
  AUDIT_VALUE_MAX as LOG_VALUE_MAX,
  auditValue as logValue,
  sameAuditValue as sameValue,
} from "@matter/storage-journal"
import type { IssueProps } from "./spec.ts"
import { ISSUE_ENTITY_PREFIX } from "./spec.ts"

/**
 * 状态 → 信号事件名（旧树 `domain.js:164-172` `ISSUE_STATUS_EVENT` 逐字）。
 * ⛔ 表外状态没有信号名 ⇒ 不猜一个通用名冒充（那会让野名进流）。
 */
export const ISSUE_STATUS_EVENT: Readonly<Record<string, string>> = Object.freeze({
  backlog: "issue-reopened",
  todo: "issue-queued",
  in_progress: "issue-started",
  in_review: "issue-delivered",
  done: "issue-accepted",
  canceled: "issue-canceled",
  duplicate: "issue-duplicate",
})

/** 本包可能写出的全部事件名。表外的名字落 `known: 0`（可查，但不冒充现行词表）。 */
export const ISSUE_EVENTS: ReadonlySet<string> = new Set([
  "issue-created", "field-change", "body-change", "deleted",
  ...Object.values(ISSUE_STATUS_EVENT),
])

/** 正文指纹保留的十六进制位数（旧树 `entity-ops.js:65` `BODY_HASH_LEN` 同值）。 */
const BODY_HASH_LEN = 12

/** 一次写入的署名人与发生时刻。 */
export interface IssueEventContext {
  /** 触发者；不可自报的通道推导值。缺省不写（`append` 落 `null`）。 */
  readonly actor?: string | null
  /** 事件发生时刻，缺省「现在」。 */
  readonly at?: Date
}

/**
 * 记录的对外身份（`activity_log.entity` 与 `edges` 的节点）。
 * @param id - 工单 id。
 * @returns `issues/<id>`。
 */
export function issueEntity(id: string): string {
  return `${ISSUE_ENTITY_PREFIX}/${id}`
}

/** 正文指纹：`{hash, lines}`，**不含正文**（旧树 `bodyFingerprint`，ISS-502）。 */
export interface BodyFingerprint {
  /** sha256 前 12 位。 */
  readonly hash: string
  /** 行数（空正文记 0）。 */
  readonly lines: number
}

/**
 * 正文指纹。判据是「事后能判定这两次之间正文变了」，故 sha256 前 12 位 + 行数就够；
 * 贴全文会让整条审计流被正文淹没，而那正是「审计没人看」的起点。
 * @param text - 正文。
 * @returns 指纹。
 */
export function bodyFingerprint(text: string): BodyFingerprint {
  const hash = createHash("sha256").update(text, "utf8").digest("hex").slice(0, BODY_HASH_LEN)
  return { hash, lines: text === "" ? 0 : text.split("\n").length }
}

/**
 * 拼一条活动流条目。
 *
 * ## `mdAt` 在新树里装什么（**判断，不是照抄**）
 *
 * 旧树的 `mdAt` 是 markdown 侧车里那行 `at:` 的**原样时间戳**，进 uid 是为了让
 * 「迁移脚本重跑」认得出同一件事 —— 关键在于那个值是**事件自身的发生时刻**，
 * 与「这次 append 跑了多久」无关。新树没有 md 侧车，等价物就是事件时刻本身。
 *
 * 两种装法各自的坏处，都实测过（`tests/audit.test.ts` 有对应用例）：
 *
 * | `mdAt` | 同一事件 append 两次 | `todo→in_review→todo→in_review` |
 * |---|---|---|
 * | `null` | 只留一行 ✓ | **只剩一条 delivered**（第二次真实发生被静默吞掉）✗ |
 * | 事件时刻（本实现） | 只留一行 ✓（同一条目同 `at`） | 两条 delivered ✓ |
 *
 * ⛔ 所以不能留空：`stablePayload` 会排除 `at`（journal 的契约明文「重跑一次它的值必然不同」），
 * 若 `mdAt` 也空，两次**真实**的同形事件就塌成一次 —— 那是审计流最不该犯的错。
 *
 * 代价：`mdAt` 这个名字在新树里名不副实（它不再是「侧车里的」）。改名要动
 * `@matter/storage-journal` 的列与 uid 算法（P1 契约），不在本单写范围。
 *
 * @param id - 工单 id。
 * @param event - 事件名。
 * @param payload - 附加键（进 uid，按 key 排序）。
 * @param context - 署名人与发生时刻。
 * @returns 可直接交给 `ctx.journal.append` 的条目。
 */
export function issueEntry(
  id: string,
  event: string,
  payload: Record<string, unknown>,
  context: IssueEventContext = {},
): JournalEntry {
  const known = ISSUE_EVENTS.has(event) ? 1 : 0
  return makeAuditEntry(issueEntity(id), event, payload, known, context.actor, context.at)
}

/**
 * 建记录 → 一条 `issue-created`。
 * @param id - 工单 id。
 * @param context - 署名人与发生时刻。
 * @returns 单条条目。
 */
export function createdEntries(id: string, context: IssueEventContext = {}): JournalEntry[] {
  return [issueEntry(id, "issue-created", {}, context)]
}

/**
 * 删记录 → 一条 `deleted`（旧树的通用回收站事件名，不是生命周期信号名）。
 * @param id - 工单 id。
 * @param context - 署名人与发生时刻。
 * @returns 单条条目。
 */
export function deletedEntries(id: string, context: IssueEventContext = {}): JournalEntry[] {
  return [issueEntry(id, "deleted", {}, context)]
}

/**
 * 上一版 → 本版，逐字段换算成事件。
 *
 * 只报**真变了**的字段：一次 `put` 把整条记录重写一遍是常态，不比较就会给每个字段
 * 都记一条假变更，而假变更会把审计流变成噪声 —— 噪声流与没有流一样没用。
 *
 * @param id - 工单 id。
 * @param previous - 上一版快照；`undefined` 表示此前不存在（⇒ 建单）。
 * @param next - 本版快照。
 * @param context - 署名人与发生时刻。
 * @returns 事件条目，按字段名序（顺序稳定，uid 与回放才能对齐）。
 */
export const diffEntries = makeAuditDiff<string, IssueProps, IssueEventContext>(createdEntries, fieldEntry)

/**
 * 一个字段的变更 → 该字段口径的事件：状态走信号名、正文走指纹、其余走 `field-change`。
 * @param id - 工单 id。
 * @param field - 字段名。
 * @param before - 旧值。
 * @param after - 新值。
 * @param context - 署名人与发生时刻。
 * @returns 条目；没有可记录的口径时 `null`。
 */
function fieldEntry(
  id: string,
  field: string,
  before: unknown,
  after: unknown,
  context: IssueEventContext,
): JournalEntry | null {
  if (field === "body") return bodyEntry(id, before, after, context)
  if (field === "status") {
    const signal = ISSUE_STATUS_EVENT[String(after)]
    // 状态值不在词表里 ⇒ 没有信号名。写面已过 zod（`index.ts`），走到这里说明值是从
    // schema 之外塞进来的；此时**不记**比记一个编出来的名字诚实。
    if (signal === undefined) return null
    return issueEntry(id, signal, { field, from: normalize(before), to: normalize(after) }, context)
  }
  return issueEntry(id, "field-change", { field, from: normalize(before), to: normalize(after) }, context)
}

/**
 * 正文变更 → `body-change`（记指纹，不记正文）。
 * @param id - 工单 id。
 * @param before - 旧正文。
 * @param after - 新正文。
 * @param context - 署名人与发生时刻。
 * @returns 条目。
 */
function bodyEntry(
  id: string,
  before: unknown,
  after: unknown,
  context: IssueEventContext,
): JournalEntry {
  const from = bodyFingerprint(typeof before === "string" ? before : "")
  const to = bodyFingerprint(typeof after === "string" ? after : "")
  return issueEntry(id, "body-change", {
    field: "body",
    fromHash: from.hash,
    toHash: to.hash,
    fromLines: from.lines,
    toLines: to.lines,
    lineDelta: to.lines - from.lines,
  }, context)
}

/**
 * 缺值统一成 `null`（见文件头那条有意分歧）。
 * @param value - 字段值。
 * @returns 字符串形式或 `null`。
 */
function normalize(value: unknown): string | null {
  return value === undefined ? null : auditValue(value)
}
