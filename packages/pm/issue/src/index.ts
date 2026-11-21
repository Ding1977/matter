/**
 * `@matter/issue` —— P2 三域的第一域：工单记录的 schema、写路径与活动流接线。
 *
 * ## 它由三件东西组成，缺一件都不算接上
 *
 * | 件 | 在哪 | 谁依赖它 |
 * |---|---|---|
 * | `IssueProps`（zod schema + `.meta()`） | `spec.ts` | E-3 的 `issueRef` 块指它 |
 * | `defineDomain` 的业务域实例 `IssueDomain` | `spec.ts` | `ctx.storage.domain.open()` |
 * | 活动流写入（`ctx.journal`） | 本文件 + `events.ts` | 活动流从空表变成有数据 |
 *
 * ## 为什么活动流写在这里，而不是订阅 `domain/changed`
 *
 * `domain/changed` **只带新值**（`@matter/storage-domain` 的契约明文：不带旧值，
 * 需要 diff 的消费者自己留上一版快照）。订阅方要算差异就得自己维护一份旧快照 ——
 * 那等于给记录造第二个家，而两个家迟早不同步。
 * ⇒ 差异在**写链的这一格**里算：本文件是工单记录的唯一写入口，旧值在这里顺手可见。
 *
 * ## 写序（不可颠倒）
 *
 * 1. 读上一版（同步，内存）
 * 2. `table.put` —— 先落盘、再改内存、再发 `domain/changed`
 * 3. 落盘**成功之后**才写活动流
 *
 * 第 3 步在 `await` 之后：若先写审计再落盘，后端拒绝写入时审计里会留下一条**从未发生的变更** ——
 * 而那种行在盘上看起来与真行一模一样。
 *
 * 代价：后端写入成功、活动流写入失败时，审计缺一条（日志里有 warn）。这个方向的错
 * 比反过来轻：记录本身没坏，缺的那条可由记录现状反查。
 *
 * ## 写链内核在 storage-journal（ISS-524）
 *
 * 串行写链 + CRUD 骨架是域无关机制，家在 `@matter/storage-journal` 的 `AuditFacility`。
 * 本类只给域差异（schema / 事件 / 错误 / id 归一）；`IssuesFacility` 的公开面不变。
 *
 * @module @matter/issue
 */

import type { Context } from "@deepseek-ai/cordis"
import { issueId, type IssueId } from "@matter/storage"
import type { Domain } from "@matter/storage-domain"
import type { JournalFacility } from "@matter/storage-journal"
import { AuditFacility, type AuditFacilitySpec } from "@matter/storage-journal"
import { IssueDomain, ISSUE_TABLE, IssuePatch, IssueProps } from "./spec.ts"
import { diffEntries, createdEntries, deletedEntries, type IssueEventContext } from "./events.ts"

export {
  ISSUE_ID_RE, ISSUE_KINDS, ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TABLE,
  IssueDomain, IssuePatch, IssueProps,
} from "./spec.ts"
export {
  ISSUE_EVENTS, ISSUE_STATUS_EVENT, LOG_VALUE_MAX, bodyFingerprint, createdEntries, deletedEntries,
  diffEntries, issueEntity, issueEntry, logValue, sameValue,
} from "./events.ts"
export type { BodyFingerprint, IssueEventContext } from "./events.ts"

/** Cordis 插件名。 */
export const name = "issue"

/**
 * 三处依赖缺一不可：
 * · `storageDomain` —— 域设施，`IssueDomain` 从它开；
 * · `journal` —— 活动流，审计往它落；
 * · `storage` —— 域设施本身依赖 hub，写在这里只是让「缺 hub」在加载期就表现出来。
 */
export const inject = ["storage", "storageDomain", "journal"]

/** 一条工单记录的存储单元名（= `IssueDomain.name`，诊断与报错文案用）。 */
export const ISSUE_DOMAIN_NAME = IssueDomain.name

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 工单记录的门面：唯一的写路径 + 活动流落点。 */
    issues: IssuesFacility
  }
}

/** 未找到指定工单。 */
export class IssueNotFoundError extends Error {
  /** @param id - 工单 id。 */
  constructor(id: string) {
    super(`issue '${id}' does not exist`)
    this.name = "IssueNotFoundError"
  }
}

/** 工单 id 已被占用（建单是「新建」，不是 upsert）。 */
export class IssueExistsError extends Error {
  /** @param id - 工单 id。 */
  constructor(id: string) {
    super(`issue '${id}' already exists`)
    this.name = "IssueExistsError"
  }
}

/** @param value - 待校验记录；zod 校验失败原样抛 `ZodError`。 */
function parseProps(value: unknown): IssueProps {
  return IssueProps.parse(value)
}

/** 工单域注入共享内核的差异点。 */
const ISSUE_FACILITY_SPEC: AuditFacilitySpec<IssueId, IssueProps, IssueEventContext> = {
  tableName: ISSUE_TABLE,
  closedMessage: `issue facility '${ISSUE_DOMAIN_NAME}' is closed`,
  parse: parseProps,
  keyOf: (record) => issueId(record.id),
  idOf: (record) => record.id,
  notFound: (id) => new IssueNotFoundError(id),
  exists: (id) => new IssueExistsError(id),
  created: createdEntries,
  deleted: deletedEntries,
  diff: diffEntries,
}

/**
 * 工单记录的门面，挂在 `ctx.issues`（**复数**：拥有 `get` / `create` / `update` /
 * `remove` / `entries` / `close`）。写操作的串序、审计落点、空写判定全由共享内核收口；
 * 本类只绑定工单域的 schema、事件词表、错误类与 branded id。
 */
export class IssuesFacility extends AuditFacility<IssueId, IssueProps, IssuePatch, IssueEventContext> {
  /**
   * @param domain - 已打开的工单域（调用方持有生命周期）。
   * @param journal - 活动流；审计往它落。
   * @param warn - 审计写失败时的出声道（闭包，不传整个 `Context`）。
   */
  constructor(
    domain: Domain<typeof IssueDomain>,
    journal: JournalFacility,
    warn: (message: string) => void,
  ) {
    super(domain, journal, warn, ISSUE_FACILITY_SPEC)
  }
}

/**
 * 打开工单域并构造门面。**宿主拥有返回值的生命周期**（`apply` 里作为 effect 的 disposer 关掉）。
 * @param ctx - 已注入 `storageDomain` 与 `journal` 的上下文。
 * @returns 已打开的门面。
 */
export async function openIssues(ctx: Context): Promise<IssuesFacility> {
  const domain = await ctx.storageDomain.open(IssueDomain)
  const logger = ctx.logger("issue")
  return new IssuesFacility(domain, ctx.journal, (message) => { logger.warn(message) })
}

/**
 * 挂载 `ctx.issues`：开局 → 提供键 → 卸载时关域。
 *
 * 注销顺序与 `@matter/storage-json` 同理：先摘服务键，再关域 —— 反过来会留下一段
 * 「键还在、域已关」的窗口，读到的是抛 `closed` 的句柄。
 * @param ctx - 插件上下文。
 * @returns 激活完成的 promise。
 */
export function apply(ctx: Context): Promise<void> {
  return openIssues(ctx).then((facility) => {
    ctx.effect(() => {
      const dispose = ctx.provide("issues", facility)
      return async () => {
        dispose()
        await facility.close()
      }
    })
  })
}

// ─── 视图配置（P4 V 轨数据半）—— 放在末尾以免挪动上面 ctx.issues 等被 catalog 记行号的声明 ───
export {
  FILTER_LOGICS, FILTER_OPS, SORT_DIRS, VIEW_TYPES,
  FilterCondition, FilterGroup, GroupRule, SortRule, ViewConfig, ViewConfigList, ViewField,
  minimalView,
  DEFAULT_DEBOUNCE_MS, VIEWS_DESCRIPTOR, ViewConfigStore, ViewStoreClosedError,
} from "./views/index.ts"
export type { ViewConfig as ViewConfigT, ViewConfigList as ViewConfigListT, ViewsStoreOptions } from "./views/index.ts"
