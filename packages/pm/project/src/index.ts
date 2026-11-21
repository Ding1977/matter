/**
 * `@matter/project` —— P2 三域的第二域：项目记录的 schema、写路径与活动流接线。
 *
 * ## 它由三件东西组成，缺一件都不算接上
 *
 * | 件 | 在哪 | 谁依赖它 |
 * |---|---|---|
 * | `ProjectProps`（zod schema + `.meta()`） | `spec.ts` | E-3 的 `projectRef` 块指它 |
 * | `defineDomain` 的业务域实例 `ProjectDomain` | `spec.ts` | `ctx.storage.domain.open()` |
 * | 活动流写入（`ctx.journal`） | 本文件 + `events.ts` | 活动流从空表变成有数据 |
 *
 * ## 为什么活动流写在这里，而不是订阅 `domain/changed`
 *
 * `domain/changed` **只带新值**（`@matter/storage-domain` 的契约明文：不带旧值，
 * 需要 diff 的消费者自己留上一版快照）。订阅方要算差异就得自己维护一份旧快照 ——
 * 那等于给记录造第二个家，而两个家迟早不同步。
 * ⇒ 差异在**写链的这一格**里算：本文件是项目记录的唯一写入口，旧值在这里顺手可见。
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
 * ## 与 `@matter/issue` 的差异（照形态复制，不照实现复制）
 *
 * | 项 | `@matter/issue` | 本包 | 为什么 |
 * |---|---|---|---|
 * | 事件词表 | 7 个状态各有信号名 | 通用 `status-change` | 旧树非 issues 域不发信号名（`entity-ops.js:671`） |
 * | 正文 | `body` + `body-change` 指纹 | **无 body 字段** | 核心 10 字段不含正文；没有产出方的事件名不进词表 |
 * | 派生视图 | 无 | `milestones` / `phases` 不进 schema | 读侧归一，容器前缀 id 需要容器身份（见 `spec.ts` 头注①） |
 * | 记录键类型 | `Branded<"IssueId">` | 裸 `string` | `@matter/storage` 没有 `ProjectId`，而补它要动 `packages/storage/*`（本单禁改）。见 `spec.ts` 的 `ProjectDomain` 注释 |
 *
 * ## 写链内核在 storage-journal（ISS-524）
 *
 * 串行写链 + CRUD 骨架是域无关机制，家在 `@matter/storage-journal` 的 `AuditFacility`。
 * 本类只给域差异（schema / 事件 / 错误 / 裸 string id）；`ProjectsFacility` 的公开面不变。
 *
 * @module @matter/project
 */

import type { Context } from "@deepseek-ai/cordis"
import type { Domain } from "@matter/storage-domain"
import type { JournalFacility } from "@matter/storage-journal"
import { AuditFacility, type AuditFacilitySpec } from "@matter/storage-journal"
import { ProjectDomain, PROJECT_TABLE, ProjectPatch, ProjectProps } from "./spec.ts"
import { diffEntries, createdEntries, deletedEntries, type ProjectEventContext } from "./events.ts"

export {
  PROJECT_HEALTHS, PROJECT_ID_RE, PROJECT_PRIORITIES, PROJECT_STATUSES, PROJECT_TABLE,
  ProjectDomain, ProjectPatch, ProjectProps,
} from "./spec.ts"
export {
  LOG_VALUE_MAX, PROJECT_EVENTS, PROJECT_STATUS_EVENT, createdEntries, deletedEntries,
  diffEntries, logValue, projectEntity, projectEntry, sameValue,
} from "./events.ts"
export type { ProjectEventContext } from "./events.ts"

/** Cordis 插件名。 */
export const name = "project"

/**
 * 三处依赖缺一不可：
 * · `storageDomain` —— 域设施，`ProjectDomain` 从它开；
 * · `journal` —— 活动流，审计往它落；
 * · `storage` —— 域设施本身依赖 hub，写在这里只是让「缺 hub」在加载期就表现出来。
 */
export const inject = ["storage", "storageDomain", "journal"]

/** 一条项目记录的存储单元名（= `ProjectDomain.name`，诊断与报错文案用）。 */
export const PROJECT_DOMAIN_NAME = ProjectDomain.name

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 项目记录的门面：唯一的写路径 + 活动流落点。 */
    projects: ProjectsFacility
  }
}

/** 未找到指定项目。 */
export class ProjectNotFoundError extends Error {
  /** @param id - 项目 id。 */
  constructor(id: string) {
    super(`project '${id}' does not exist`)
    this.name = "ProjectNotFoundError"
  }
}

/** 项目 id 已被占用（建项目是「新建」，不是 upsert）。 */
export class ProjectExistsError extends Error {
  /** @param id - 项目 id。 */
  constructor(id: string) {
    super(`project '${id}' already exists`)
    this.name = "ProjectExistsError"
  }
}

/** @param value - 待校验记录；zod 校验失败原样抛 `ZodError`。 */
function parseProps(value: unknown): ProjectProps {
  return ProjectProps.parse(value)
}

/** 项目域注入共享内核的差异点。 */
const PROJECT_FACILITY_SPEC: AuditFacilitySpec<string, ProjectProps, ProjectEventContext> = {
  tableName: PROJECT_TABLE,
  closedMessage: `project facility '${PROJECT_DOMAIN_NAME}' is closed`,
  parse: parseProps,
  keyOf: (record) => record.id,
  idOf: (record) => record.id,
  notFound: (id) => new ProjectNotFoundError(id),
  exists: (id) => new ProjectExistsError(id),
  created: createdEntries,
  deleted: deletedEntries,
  diff: diffEntries,
}

/**
 * 项目记录的门面，挂在 `ctx.projects`（**复数**：拥有 `get` / `create` / `update` /
 * `remove` / `entries` / `close`）。写操作的串序、审计落点、空写判定全由共享内核收口；
 * 本类只绑定项目域的 schema、事件词表、错误类与裸 string id。
 */
export class ProjectsFacility extends AuditFacility<string, ProjectProps, ProjectPatch, ProjectEventContext> {
  /**
   * @param domain - 已打开的项目域（调用方持有生命周期）。
   * @param journal - 活动流；审计往它落。
   * @param warn - 审计写失败时的出声道（闭包，不传整个 `Context`）。
   */
  constructor(
    domain: Domain<typeof ProjectDomain>,
    journal: JournalFacility,
    warn: (message: string) => void,
  ) {
    super(domain, journal, warn, PROJECT_FACILITY_SPEC)
  }
}

/**
 * 打开项目域并构造门面。**宿主拥有返回值的生命周期**（`apply` 里作为 effect 的 disposer 关掉）。
 * @param ctx - 已注入 `storageDomain` 与 `journal` 的上下文。
 * @returns 已打开的门面。
 */
export async function openProjects(ctx: Context): Promise<ProjectsFacility> {
  const domain = await ctx.storageDomain.open(ProjectDomain)
  const logger = ctx.logger("project")
  return new ProjectsFacility(domain, ctx.journal, (message) => { logger.warn(message) })
}

/**
 * 挂载 `ctx.projects`：开局 → 提供键 → 卸载时关域。
 *
 * 注销顺序与 `@matter/storage-json` 同理：先摘服务键，再关域 —— 反过来会留下一段
 * 「键还在、域已关」的窗口，读到的是抛 `closed` 的句柄。
 * @param ctx - 插件上下文。
 * @returns 激活完成的 promise。
 */
export function apply(ctx: Context): Promise<void> {
  return openProjects(ctx).then((facility) => {
    ctx.effect(() => {
      const dispose = ctx.provide("projects", facility)
      return async () => {
        dispose()
        await facility.close()
      }
    })
  })
}
