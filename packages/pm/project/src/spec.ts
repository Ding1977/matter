/**
 * Project 域的声明：`ProjectProps` zod schema + `defineDomain` 的 spec。
 *
 * ## 与 `@matter/issue` 的关系：照形态复制，不照字段复制
 *
 * 一个事实只有一个家 —— 那些**两域字面相同**的规则（`.meta()` 放链最后、结构化 brand
 * 不用 `.transform()`、可选字段不设 `.default()`）在 E-0（ISS-519）里已经论证过并被用例钉住。
 * 本文件不复制那三段论证，只写 project **独有**的三件事：
 * ① 为什么 `milestones` / `phases` 不在本 schema 里（附实测证据）；
 * ② 展示字段（`color` / `icon` / `cover` / `subtitle`）的 `widget` 取值。
 *
 * ## ① `milestones` / `phases`：**不进 `ProjectProps`**
 *
 * 工具面说它们是「只读派生视图」，旧树实测证明那是**一回事的两种写法**，而不是两种存法：
 *
 * ```
 * $ grep -n "milestones\|phases" forge-pm/lib/md-store.js
 * :51   export function normMilestones(frontmatter)      ← 读时归一成 [{id,name,targetDate}]
 * :105  export function normPhases(frontmatter, cid)     ← 读时归一成 [{id:"<容器>:ph-N",name}]
 * ```
 *
 * 写侧**没有任何归一器**（`grep -rn "normMilestones\|normPhases" forge-pm/lib | grep -v test` ⇒
 * 只有 `md-store.js` 的定义与 `agent-tools-project.js` 的**读**调用），落盘的是调用方原样给的形状。
 * 实测 `$DSH_HOME/pm/projects/`（26 个实体）的两种落盘形态都真实存在：
 *
 * | 字段 | 落盘形态 | 实例 |
 * |---|---|---|
 * | `milestones` | 对象数组（10/26 有该字段，**全部**是对象数组） | `[{"id":"ms-1","name":"节点2","targetDate":null}]` |
 * | `phases` | **字符串数组**（1/26） | `[止血：工具全部可用, 数据可信…]` |
 * | `milestoneDates` | **0/26** —— 一个都没有 | — |
 *
 * ⇒ 结论：**派生视图**是读侧归一（`md-store.js` 的职责），**不是**「schema 里不存」。
 * 但把 `milestones` 收进 `ProjectProps` 会锁死两件事，而它们都还没有消费者：
 *   · 归一后的 `{id,name,targetDate}` 一旦成为 schema，字符串形态的存量数据就**过不了校验**
 *     （`invalid-record` ⇒ 整域 `open` 拒绝，见 `storage-domain/src/spec.ts` 的注释）；
 *   · `phases` 的 id 是**容器前缀**派生的（`<容器 id>:ph-N`），容器 id 就是本条记录的 `id` ——
 *     让 schema 只知道字段、不知道容器身份，等于把「派生」搬进「存储」再补一条反查。
 * ⇒ 本包不建这两个字段（「没有当前消费者就不建」）。旧形态的归一是 P9 迁移的事，
 *   迁移脚本有完整 frontmatter 与容器 id，那时才有它需要的信息。
 *
 * ## ② 展示字段的 `widget` 取值
 *
 * E-0 已定的词表：`text` / `select` / `date` / `person` / `ref` / `tags` / `markdown`。
 * 本域新增三个取值，**取值即渲染契约**（E-3 与前端照它取组件）：
 *
 * | 字段 | `widget` | 消费方实测出处 |
 * |---|---|---|
 * | `color` | `color` | `forge-pm/src/pm/shared/icon-picker.tsx:42` `PROJECT_ICON_COLORS`（12 色板） |
 * | `icon` | `icon` | 同上 `:44` `iconById()`（lucide 图标集，按 id 名取） |
 * | `cover` | `image` | `forge-pm/src/pm/shared/blocks/cover-image.tsx`（文件上传 → `assets/<id>/`） |
 * | `subtitle` | `text` | `forge-pm/src/pm/shared/blocks/subtitle-input.tsx`（单行文本，就地编辑） |
 *
 * ⛔ 不写 `'color-picker'` / `'icon-picker'` 这类**组件名**：`widget` 回答的是「这段数据是什么
 * 形态」，不是「用哪个 React 组件画」—— 同一个 `color` 可以是色板也可以是输入框，那是渲染层
 * 的选择，不是数据层的契约。照 E-0 的既有风格（`person` / `tags` / `markdown` 都是**数据形态**而非组件名）。
 *
 * @module @matter/project/src/spec
 */

import { z } from "zod"
import { defineDomain, domainTable } from "@matter/storage-domain"

/**
 * 项目状态词表（旧树 `forge-pm/lib/domain.js:305` `PROJECT_STATUSES` 逐字）。
 * ⚠️ 这是新树的**唯一一份**：业务包不 import 旧树，旧树退役时这张表随本包留下。
 */
export const PROJECT_STATUSES = ["planned", "active", "paused", "completed", "archived"] as const

/**
 * 健康度词表（旧树 `forge-pm/lib/domain.js:604` `FIELD_OPTIONS.health.projects` 逐字）。
 * ⚠️ 只属 projects 域 —— issues / documents 没有 health。
 */
export const PROJECT_HEALTHS = ["on-track", "at-risk", "off-track"] as const

/**
 * 优先级词表。**与 issues 共用**（旧树 `domain.js:514`
 * 「`"priority": { scope: ["issues", "projects"], write: "user" }`，两域词表一致」）。
 * ⇒ 表内只有一个家：本常量与 `@matter/issue` 的 `ISSUE_PRIORITIES` 值相同，但两域是独立包，
 * 共用要靠 `@matter/storage` 承载 —— 那属于另一次搬家的写范围，不在本单。
 */
export const PROJECT_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const

/**
 * 项目 id 的形状。**格式校验归业务包**（`@matter/storage` 的 README 明写
 * 「branded id 只做类型、不校验格式」）⇒ 本包是那个拥有方，两处入口共用这一条正则：
 * schema（落盘边界）与 `projectIdOf()`（调用方传参边界）。
 *
 * 实测语料：`$DSH_HOME/pm/projects/` 26 个实体，`id:` 非 `PRJ-<数字>` 的 **0 个**。
 */
export const PROJECT_ID_RE = /^PRJ-[0-9]+$/

/** 记录键前缀：`activity_log.entity` 与 `edges` 的节点身份都靠它认域。 */
export const PROJECT_ENTITY_PREFIX = "projects"

/**
 * 一条项目记录。字段分三类：不可变（`id` / `created`）、系统写（`goal`）、用户写（其余）。
 *
 * 可选字段一律 `.optional()` 而**不设 `.default()`**：默认值会让 PATCH 语义（只改一个字段）
 * 在解出记录时把其余字段材料化成默认值 —— 那等于「改标题」顺手把 `goal` 清空成 `""`。
 *
 * ⛔ `.meta()` **必须放在链的最后**（`.optional().meta({…})`）。zod 4.6.6 实测：
 * `.meta().optional()` 得到新的 optional 包装层，`schema.meta()` 读回 `undefined`，
 * 而 `toJSONSchema()` 仍会合并出内层元数据 —— 「JSON schema 看着对、读 `.meta()` 的拿不到」。
 * 论证与用例在 E-0（`@matter/issue` 的 `tests/spec.test.ts`），本包不复制第二份。
 *
 * ⛔ brand 走 `.meta({ branded })` 而非 `.transform()`：后者在 `toJSONSchema` 默认 `io:'output'` 下抛异常。
 *
 * 10 个字段的分档依据（旧树 `FIELD_META` 的 `write` 档，逐条实测）：
 *   · `id` / `created` → `immutable`
 *   · `goal` → `system`（旧树 `domain.js:462`；但工具面 `matter_project update` 收 `goal` ⇒
 *     前端可经工具面改写。这里按**旧树写档**落，与 E-0 给 `kind` 落 `system` 同口径：
 *     `writable` 描述的是「谁能写」，不是「这个包放不放行」）
 *   · 其余 7 个 → `user`
 */
export const ProjectProps = z.strictObject({
  id: z.string().regex(PROJECT_ID_RE).meta({ writable: "immutable", widget: "text", indexable: true }),
  title: z.string().min(1).meta({ writable: "user", widget: "text", indexable: true }),
  status: z.enum(PROJECT_STATUSES).meta({ writable: "user", widget: "select", indexable: false }),
  created: z.iso.date().meta({ writable: "immutable", widget: "date", indexable: false }),
  priority: z.enum(PROJECT_PRIORITIES).optional().meta({ writable: "user", widget: "select", indexable: false }),
  health: z.enum(PROJECT_HEALTHS).optional().meta({ writable: "user", widget: "select", indexable: true }),
  lead: z.string().optional().meta({ writable: "user", widget: "person", indexable: false }),
  startDate: z.iso.date().optional().meta({ writable: "user", widget: "date", indexable: false }),
  targetDate: z.iso.date().optional().meta({ writable: "user", widget: "date", indexable: false }),
  goal: z.string().optional().meta({ writable: "system", widget: "text", indexable: false }),
  tags: z.array(z.string()).optional().meta({ writable: "user", widget: "tags", indexable: false }),
})

/** 一条项目记录（schema 的推断类型）。 */
export type ProjectProps = z.infer<typeof ProjectProps>

/**
 * 局部更新（PATCH）：去掉不可变字段后全部可选。
 *
 * ⛔ 不是「宽松一点的 ProjectProps」：`id` / `created` 必须真的改不了 —— 可选还不够，
 * 传进来要当场被拒；未知键要报错，不能静默丢弃（丢一个拼错的键等于静默少改一个字段）。
 */
export const ProjectPatch = ProjectProps.omit({ id: true, created: true }).partial()

/** 局部更新的入参类型。 */
export type ProjectPatch = z.infer<typeof ProjectPatch>

/**
 * 记录表名。同时是后端 unit 内的子目录名 ⇒ 必须匹配 `UNIT_NAME_RE`。
 * ⛔ 单数：它是一张「项目表」，不是项目集合的列表页。
 */
export const PROJECT_TABLE = "project"

/**
 * 域声明。`name` 同时是后端 unit 名，故用 `pm_project`（带域前缀，与 `pm_issue` 同形）。
 *
 * ## 键类型用裸 `string`，不是 `Branded<"ProjectId">` —— 一条本单够不着的前置
 *
 * E-0 的 `domainTable<IssueId, IssueProps>` 用的是 `@matter/storage/src/brand.ts` 的 `IssueId`。
 * 本包**没有对应物**：`grep -n "export" packages/storage/storage/src/brand.ts` ⇒ 只有
 * `IssueId` / `issueId` 两条，没有 `ProjectId` / `projectId`。
 *
 * 补它要改 `packages/storage/storage/src/brand.ts`，而本单的硬约束是
 * **⛔ 不动 `packages/storage/*`**（那是 P1 交付）⇒ 本包不自行其是地造第二处 brand，
 * 也不偷偷放宽成 `as` 断言。用裸 `string` 的代价是编译期少一道拦（把 `"DOC-1"` 传给
 * `get()` 不报错，运行期才 `undefined`），已作为缺口写进单里报 Lead。
 */
export const ProjectDomain = defineDomain({
  name: "pm_project",
  version: 1,
  tables: {
    [PROJECT_TABLE]: domainTable<string, ProjectProps>(ProjectProps),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// TODO（P2 后续，等真消费者出现再加，不预建）
//
// 旧树 `FIELD_META` 摊到 projects 域的其余字段，按「有没有消费者」分两堆：
//
//   · **有落盘数据但今天无读方**（实测 $DSH_HOME/pm/projects，26 个实体）：
//     resources 24/26 · health 25/26（已建）· lead 8/26（已建）· goal 16/26（已建）
//     · tags 16/26（已建）· color 6/26 · icon 7/26 · attachments 1/26
//     ⇒ 后四个是展示字段，等 E-3 的块引擎/前端真接上再加。加的时候 `widget` 取值按本文件
//       头注表②，**不要就地发明第四个名字**。
//
//   · **零落盘数据、当前无消费者**（实测 0/26）：
//     subtitle · cover · milestone · milestoneDates · milestoneDates 派生形态
//     ⇒ 一个字段都没有写过，说明今天没人需要它。「没写过」与「写空了」在盘上长得一样，
//       所以不预建。
//
//   · **派生视图，按本文件头注①不进 schema**：
//     milestones · phases（读侧归一，写侧零归一器；容器前缀 id 需要容器身份）
//
//   · **跨域引用**（旧树 `domain.js` 的 `initiative` / `projects`）：
//     等 E-2 / 倡议域落地后有消费者再加。加 `relations` 类字段前先看
//     `@matter/storage-journal` 的 `EDGE_FIELDS`：边表只投影那几个，别造一条没人投影的关联。
// ─────────────────────────────────────────────────────────────────────────────
