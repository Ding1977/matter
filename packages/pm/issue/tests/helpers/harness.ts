/**
 * 工单域测试的装配：真 storage hub + 真 JSON 后端 + 真 journal，落在临时目录。
 *
 * ## 为什么用真 `@matter/storage-json` 而不是内存替身
 *
 * `storage-domain` 的用例自带 `tests/helpers/memory-backend.ts`，但那是**它自己**的测试基建
 * （其头注明写「共享测试基础设施」只在本包内）。跨包 import 别人的测试辅助有两个代价：
 *   · 那条路径不在任何 `exports` 里 —— 它的形状随时可能为了对方的用例而改；
 *   · 内存后端**证明不了「落盘」**，而验收要的正是这一条。
 * 本文件因此走真后端：`@matter/storage-json` 写的是真文件，换一个现场（同一根目录）读得回来。
 *
 * ## 装配照 DSH 的三角色形态，行序无关
 *
 * `Storage`（定义）→ `@matter/storage-json`（提供方，自己注册后端键与服务键）
 * → `@matter/storage-domain`（表单）→ 本包（消费者）。
 * `storage-domain` 的 `apply` 用 `ctx.inject([storage.backend.json])` 等那个键出现，
 * 所以插件**怎么排都不影响**激活顺序（函数插件由 cordis 排，包内不需 sleep/重试）。
 *
 * @module @matter/issue/tests/helpers/harness
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import Storage from "@matter/storage"
// ⛔ 函数插件必须**按命名空间整体**挂：`@matter/storage-json` / `@matter/storage-domain`
// 都**没有** `export default`（那正是 `verify-plugin-entry-exports` 在挡的事故形态 ——
// 有 `apply` 的入口再带 `default`，Loader 的 `unwrapExports` 会解包成裸函数并丢掉
// `name`/`inject`/`Config`）。所以这里 `import * as X` 再 `ctx.plugin(X, config)`。
import * as StorageJson from "@matter/storage-json"
import * as StorageDomain from "@matter/storage-domain"
import { openJournalFacility, type JournalFacility } from "@matter/storage-journal"
import { IssuesFacility, openIssues } from "../../src/index.ts"

/** 一套已装配好的现场。 */
export interface Harness {
  /** 宿上下文（`ctx.issues` 是否挂上由各用例自己看）。 */
  readonly ctx: Context
  /** 活动流（独立于工单域，单测可直接 append / count）。 */
  readonly journal: JournalFacility
  /** 工单门面。 */
  readonly issues: IssuesFacility
  /** 临时根目录（记录在 `<root>/records`，journal 在 `<root>/journal.db`）。 */
  readonly root: string
  /** 关掉全部资源。幂等。**不删目录** —— 「重启」用例要复用同一个根。 */
  shutdown(): Promise<void>
  /** 收尾：shutdown + 删临时目录。 */
  dispose(): Promise<void>
}

/**
 * 起一套现场。
 * @param reuseRoot - 已有根目录（模拟重启）；不给则新建临时目录。
 * @returns 已装配的现场。
 */
export async function boot(reuseRoot?: string): Promise<Harness> {
  const root = reuseRoot ?? await mkdtemp(join(tmpdir(), "matter-issue-"))
  const ctx = await bootContext(root)
  const journal = ctx.journal
  const issues = await openIssues(ctx)
  return {
    ctx,
    journal,
    issues,
    root,
    shutdown: async () => {
      await issues.close()
      journal.close()
    },
    dispose: async () => {
      await issues.close()
      journal.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * 只装配上下文与 journal（不打工单域）。给「装配/注销」类用例用。
 *
 * `journal` 由这里 `openJournalFacility` + `provide` 提供：等价于挂 `@matter/storage-journal`
 * 插件，但不需要它的配置面（`root` 直接是测试根）。
 * @param root - 临时根目录（必须已存在）。
 * @returns 装配好的上下文。
 */
export async function bootContext(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, "records") })
  await ctx.plugin(StorageDomain, { backend: "json" })
  const journal = await openJournalFacility(root)
  ctx.provide("journal", journal)
  return ctx
}

/**
 * 与 {@link boot} 同，但不打开工单域 —— 给「`ctx.issues` 何时出现」的用例。
 * @returns 现场（`issues` 字段在调用方自己 `openIssues` 之前不可用，故不提供）。
 */
export async function bootBare(): Promise<{ ctx: Context; journal: JournalFacility; root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "matter-issue-bare-"))
  const ctx = await bootContext(root)
  return {
    ctx,
    journal: ctx.journal,
    root,
    dispose: async () => {
      ctx.journal.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
