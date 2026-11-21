/**
 * 项目变更的事件词表与「上一版 → 本版」的差异换算。
 *
 * ## 为什么活动流由**差异**得出，而不是由调用方各自 append
 *
 * 活动流要回答的是「谁在什么时候把哪个字段从什么改成了什么」。若每个写入口各自 append，
 * 那**漏一个入口就是一条静默缺失的审计**，而且漏了不报错。这里改成：记录的唯一写路径是
 * `ctx.projects`（`index.ts`），它拿写前快照与写后记录做差，差异再换算成事件。
 * ⇒ 审计的形状由**一处**决定。（与 `@matter/issue` 同一条理由，那边有用例钉住；本包不复制论证。）
 *
 * ## 词表照旧树，**但 project 与 issue 不是同一套**
 *
 * 这是本包与 E-0 最大的一处差异，实测出处：
 *
 * ```
 * $ forge-pm/lib/entity-ops.js:378
 *   const createdEvent = createdDomain === "issues" ? "issue-created" : "created"
 * $ forge-pm/lib/entity-ops.js:617
 *   const ev = isStatus ? (evDomain === "issues" ? ISSUE_STATUS_EVENT[...] : "status-change") : "field-change"
 * ```
 *
 * ⇒ issues 域的状态流转走**信号层**（`issue-started` / `issue-delivered` … 7 个名字各一个），
 * 其余域（含 projects）**没有信号层**：建记录发通用 `created`，状态变更发通用 `status-change`。
 * 旧树 `domain.js:166` 的 `ISSUE_STATUS_EVENT` 是 issues 专用映射，project 照抄它会造出
 * 一批旧树从没产出过的野名（`known` 落 0，而 0 是「谁在写野名」的入口）。
 *
 * 语料佐证（`$DSH_HOME/pm/projects/*-activity.md` 全部事件名去重计数）：
 * `created` 24 · `field-change` 11 · `status-change` 7 · `deleted` 1 —— 与上表逐项对上。
 * （同批还有 `agent-note` / `comment-added` 等**非本包写入口**产生的事件，那些归审计侧车，不在本包）
 *
 * ## ⛔ 与旧树的一处有意分歧：`from` / `to` 恒出现
 *
 * 旧树在值为 `null` 时**省略**该键（`entity-ops.js:622-623`）。省略让「这个字段被删掉了」
 * 与「这个事件根本没讲这个字段」在 payload 上长得一样。本仓改为恒出现、缺值写 `null`：
 * 多两个键的代价换掉一类静默歧义。（同 E-0，两条域共用一条口径）
 *
 * ## 机制在家 storage-journal，词表在本文件（ISS-524）
 *
 * `logValue` / `sameValue` / entry 核心列拼装 / diff 骨架是域无关机制，已并入
 * `@matter/storage-journal` 的 `audit.ts`（一物一家）。本文件只保留项目**独有**的东西：
 * 通用 `created` / `status-change` 词表与 `fieldEntry` 的字段口径。公开导出名不变（再导出）。
 *
 * @module @matter/project/src/events
 */

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
import type { ProjectProps } from "./spec.ts"
import { PROJECT_ENTITY_PREFIX } from "./spec.ts"

/**
 * 本包可能写出的全部事件名（旧树 `domain.js` 的 `DETAIL_EVENTS` 里 names 的那几个，逐字）。
 *
 * ⛔ 没有 `body-change`：本包的 schema 不含 `body`（核心 10 字段，见 `spec.ts`）。
 * 一个没有产出方的事件名与一个永远为空的字段是同一种病 —— 词表里停了它，读的人就会以为有人在写。
 */
export const PROJECT_EVENTS: ReadonlySet<string> = new Set([
  "created", "field-change", "status-change", "deleted",
])

/**
 * 状态变更用的事件名。**没有信号层** —— 见文件头「词表照旧树」。
 * 常量而非内联，是因为它是本包唯一一处「状态走通用名」的判定，读的人该在这里看到结论。
 */
export const PROJECT_STATUS_EVENT = "status-change"

/** 一次写入的署名人与发生时刻。 */
export interface ProjectEventContext {
  /** 触发者；不可自报的通道推导值。缺省不写（`append` 落 `null`）。 */
  readonly actor?: string | null
  /** 事件发生时刻，缺省「现在」。 */
  readonly at?: Date
}

/**
 * 记录的对外身份（`activity_log.entity` 与 `edges` 的节点）。
 * @param id - 项目 id。
 * @returns `projects/<id>`。
 */
export function projectEntity(id: string): string {
  return `${PROJECT_ENTITY_PREFIX}/${id}`
}

/**
 * 拼一条活动流条目。
 *
 * ## `mdAt` 装事件自身的时刻（与 E-0 同一条判断）
 *
 * 旧树的 `mdAt` 是 markdown 侧车里那行 `at:` 的**原样时间戳**，进 uid 是为了让「迁移脚本重跑」
 * 认得出同一件事 —— 关键在于那个值是**事件自身的发生时刻**。新树没有 md 侧车，等价物就是它。
 *
 * ⛔ 不能留空：`stablePayload` 会排除 `at`（journal 的契约明文「重跑一次它的值必然不同」），
 * 若 `mdAt` 也空，两次**真实**的同形事件（`active → paused → active`）就塌成一次 ——
 * 那是审计流最不该犯的错。E-0 的 `tests/domain.test.ts` 有对应用例。
 *
 * @param id - 项目 id。
 * @param event - 事件名。
 * @param payload - 附加键（进 uid，按 key 排序）。
 * @param context - 署名人与发生时刻。
 * @returns 可直接交给 `ctx.journal.append` 的条目。
 */
export function projectEntry(
  id: string,
  event: string,
  payload: Record<string, unknown>,
  context: ProjectEventContext = {},
): JournalEntry {
  const known = PROJECT_EVENTS.has(event) ? 1 : 0
  return makeAuditEntry(projectEntity(id), event, payload, known, context.actor, context.at)
}

/**
 * 建记录 → 一条 `created`（**不是** `project-created`：旧树非 issues 域发通用名）。
 * @param id - 项目 id。
 * @param context - 署名人与发生时刻。
 * @returns 单条条目。
 */
export function createdEntries(id: string, context: ProjectEventContext = {}): JournalEntry[] {
  return [projectEntry(id, "created", {}, context)]
}

/**
 * 删记录 → 一条 `deleted`（旧树的通用回收站事件名）。
 * @param id - 项目 id。
 * @param context - 署名人与发生时刻。
 * @returns 单条条目。
 */
export function deletedEntries(id: string, context: ProjectEventContext = {}): JournalEntry[] {
  return [projectEntry(id, "deleted", {}, context)]
}

/**
 * 上一版 → 本版，逐字段换算成事件。
 *
 * 只报**真变了**的字段：一次 `put` 把整条记录重写一遍是常态，不比较就会给每个字段
 * 都记一条假变更，而假变更会把审计流变成噪声 —— 噪声流与没有流一样没用。
 *
 * @param id - 项目 id。
 * @param previous - 上一版快照；`undefined` 表示此前不存在（⇒ 建记录）。
 * @param next - 本版快照。
 * @param context - 署名人与发生时刻。
 * @returns 事件条目，按字段名序（顺序稳定，uid 与回放才能对齐）。
 */
export const diffEntries = makeAuditDiff<string, ProjectProps, ProjectEventContext>(createdEntries, fieldEntry)

/**
 * 一个字段的变更 → 该字段口径的事件：状态走 `status-change`，其余走 `field-change`。
 * @param id - 项目 id。
 * @param field - 字段名。
 * @param before - 旧值。
 * @param after - 新值。
 * @param context - 署名人与发生时刻。
 * @returns 条目。
 */
function fieldEntry(
  id: string,
  field: string,
  before: unknown,
  after: unknown,
  context: ProjectEventContext,
): JournalEntry {
  const event = field === "status" ? PROJECT_STATUS_EVENT : "field-change"
  return projectEntry(id, event, { field, from: normalize(before), to: normalize(after) }, context)
}

/**
 * 缺值统一成 `null`（见文件头那条有意分歧）。
 * @param value - 字段值。
 * @returns 字符串形式或 `null`。
 */
function normalize(value: unknown): string | null {
  return value === undefined ? null : auditValue(value)
}
