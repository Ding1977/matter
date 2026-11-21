/**
 * Issue 域的声明：`IssueProps` zod schema + `defineDomain` 的 spec。
 *
 * ## 为什么字段元数据用 `.meta()` 而不是另建一份元数据表
 *
 * 字段的「能不能写 / 用什么控件 / 进不进检索」是**同一个事实**的三个面，
 * 而 schema 已经是那个事实的家。另立一份表 ⇒ 两份数据迟早对不上（本仓已多次为此付账）。
 * zod 4.6.6 实测 `z.toJSONSchema()` **保留** meta（forward 与 round-trip 都保留），
 * 所以前端将来拿字段描述可以直接从 schema 出，不必再维护第二处。
 *
 * ## ⛔ 不用 `.transform()` 做 brand
 *
 * 结构化 brand：`z.string().regex(ISSUE_ID_RE).meta({ branded: "IssueId" })`。
 * `.transform()` 在默认 `io: "output"` 下 `toJSONSchema()` 会抛异常（zod 4.6.6 实测），
 * 而 brand 在运行期没有语义 —— 它只活在 TS 类型层（`Branded<"IssueId">`）。
 *
 * ## 只做 12 个核心字段，不做全量
 *
 * 旧树 `forge-pm/lib/domain.js` 的 `FIELD_META` 按 `scope` 摊出来是 **41 个** issues 字段
 * （不是 DOC-516 写的 41/33 任一数字能够直接对上，以本条实测为准）。本包**只建当前真有
 * 消费者的 12 个**，其余见文件末尾的 TODO 清单 —— 「每个抽象有当前的活」。
 *
 * @module @matter/issue/src/spec
 */

import { z } from "zod"
import { defineDomain, domainTable } from "@matter/storage-domain"
import type { IssueId } from "@matter/storage"

/**
 * 工单状态词表（旧树 `forge-pm/lib/domain.js:302` `ISSUE_STATUSES` 逐字）。
 * ⚠️ 这是新树的**唯一一份**：业务包不 import 旧树，旧树退役时这张表随本包留下。
 */
export const ISSUE_STATUSES = [
  "backlog", "todo", "in_progress", "in_review", "done", "canceled", "duplicate",
] as const

/** 优先级词表（旧树 `domain.js` 的 issues/projects 共用档位）。 */
export const ISSUE_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const

/** 需求类型词表（旧树 `domain.js:319` `ISSUE_KINDS` 逐字）。 */
export const ISSUE_KINDS = ["feature", "bug", "question"] as const

/**
 * 工单 id 的形状。**格式校验归业务包**（`@matter/storage` 的 README 明写
 * 「branded id 只做类型、不校验格式」）⇒ 本包是那个拥有方，两处入口共用这一条正则：
 * schema（落盘边界）与 `issueIdOf()`（调用方传参边界）。
 */
export const ISSUE_ID_RE = /^ISS-[0-9]+$/

/** 记录键前缀：`activity_log.entity` 与 `edges` 的节点身份都靠它认域。 */
export const ISSUE_ENTITY_PREFIX = "issues"

/**
 * 一条工单记录。**字段分三类**：不可变（id / created）、系统写（kind）、用户写（其余）。
 *
 * 可选字段一律 `.optional()` 而**不设 `.default()`**：默认值会让 PATCH 语义（只改一个字段）
 * 在解出记录时把其余字段材料化成默认值 —— 那等于「改标题」顺手把正文清空成 `""`。
 *
 * ⛔ `.meta()` **必须放在链的最后**：zod 4.6.6 实测，`z.string().meta({…}).optional()`
 * 得到的是一个新的 optional 包装层，`schema.meta()` 在它上面读回 `undefined`（内层那份
 * 元数据仍在 `toJSONSchema()` 里被合并出来，所以那种写法**能出 JSON schema 却读不到 meta**——
 * 一个只在「读元数据」这一侧裂开的静默不一致）。故可选字段写成 `.optional().meta({…})`。
 */
export const IssueProps = z.strictObject({
  id: z.string().regex(ISSUE_ID_RE).meta({ writable: "immutable", widget: "text", indexable: true }),
  title: z.string().min(1).meta({ writable: "user", widget: "text", indexable: true }),
  status: z.enum(ISSUE_STATUSES).meta({ writable: "user", widget: "select", indexable: false }),
  kind: z.enum(ISSUE_KINDS).meta({ writable: "system", widget: "select", indexable: false }),
  created: z.iso.date().meta({ writable: "immutable", widget: "date", indexable: false }),
  priority: z.enum(ISSUE_PRIORITIES).optional().meta({ writable: "user", widget: "select", indexable: false }),
  assignee: z.string().optional().meta({ writable: "user", widget: "person", indexable: false }),
  due: z.iso.date().optional().meta({ writable: "user", widget: "date", indexable: false }),
  project: z.string().optional().meta({ writable: "user", widget: "ref", indexable: false }),
  parent: z.string().optional().meta({ writable: "user", widget: "ref", indexable: false }),
  tags: z.array(z.string()).optional().meta({ writable: "user", widget: "tags", indexable: false }),
  body: z.string().optional().meta({ writable: "user", widget: "markdown", indexable: true }),
})

/** 一条工单记录（schema 的推断类型）。 */
export type IssueProps = z.infer<typeof IssueProps>

/**
 * 局部更新（PATCH）：**去掉不可变字段**后全部可选。
 *
 * ⛔ 这里不是「宽松一点的 IssueProps」：
 *   · `id` / `created` 必须真的改不了 —— 可选还不够，传进来要当场被拒；
 *   · 未知键要报错，不能静默丢弃（丢一个拼错的键等于静默少改一个字段）。
 * `omit` 之后 `partial` 仍保留 `strictObject` 的严格性（zod 4.6.6 实测，`tests/spec.test.ts` 钉住）。
 */
export const IssuePatch = IssueProps.omit({ id: true, created: true }).partial()

/** 局部更新的入参类型。 */
export type IssuePatch = z.infer<typeof IssuePatch>

/**
 * 记录表名。同时是后端 unit 内的子目录名 ⇒ 必须匹配 `UNIT_NAME_RE`。
 *
 * ⛔ 单数：它是一张「工单表」，不是工单集合的列表页。
 */
export const ISSUE_TABLE = "issue"

/**
 * 域声明。`name` 同时是后端 unit 名，故用 `pm_issue`（带域前缀，避免与将来
 * `kb_document` / `pm_project` 之外的东西撞名）。
 *
 * `layout` 不写：`defineDomain` 只接受 `per-record`，写它是噪声；
 * 不写时 `descriptorOf` 也不会把该键投影出去（已由 storage-domain 的用例钉住）。
 */
export const IssueDomain = defineDomain({
  name: "pm_issue",
  version: 1,
  tables: {
    [ISSUE_TABLE]: domainTable<IssueId, IssueProps>(IssueProps),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// TODO（P2 后续，等真消费者出现再加，不预建）
//
// 旧树 `FIELD_META` 摊到 issues 域的其余 29 个字段，按用途分组：
//   · 派单/执行：assignee 已做；estimate / agentSession / delegateAgent / delegateAt /
//     delegateRun / budget / cycle / branch / commit / worktree / session
//   · 层级与关联：parent / project 已做；blocked_by / subtasks / relations / phases / phase /
//     milestone / projects
//   · 验收与审查：acceptance / verdict / reviewVerdict / git-waived / archived / deleted
//   · 其它：type / owner / resources / write_scope / aiReview（已废止，不建）
//
// 加字段前先确认「谁在写它、谁在读它」—— 没有当前消费者的字段不进 schema，
// 否则它会变成一个永远为空的键，而空键与「还没写」在盘上长得一样。
// ⚠️ 加 `relations` / `blocked_by` / `parent` 三类之外的关联字段前，先看
// `@matter/storage-journal` 的 `EDGE_FIELDS`：边表只投影那三个，别造一条没人投影的关联。
// ─────────────────────────────────────────────────────────────────────────────
