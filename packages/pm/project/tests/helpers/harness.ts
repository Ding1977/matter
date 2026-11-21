/**
 * 项目域测试的装配：真 storage hub + 真 JSON 后端 + 真 journal，落在临时目录。
 *
 * ## 与 `@matter/issue` 的 harness 逐行同构，但**不复用它的文件**
 *
 * 跨包 import 别人的测试辅助有两个代价（E-0 的头注已论证过；本包不重复）：
 *   · 那条路径不在任何 `exports` 里 —— 形状随时可能为对方的用例而改；
 *   · 两个域若共享一份 harness，改一处会同时动两边，而它们本该独立演进。
 * 本文件只做一件事：把 E-0 那份换成 `projects` 域。**没有多出来的能力**。
 *
 * ## 为什么用真 `@matter/storage-json` 而不是内存替身
 *
 * 内存后端**证明不了「落盘」**，而验收要的正是这一条（重建现场后仍读得回来）。
 *
 * @module @matter/project/tests/helpers/harness
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import Storage from "@matter/storage"
// ⛔ 函数插件必须**按命名空间整体**挂：`@matter/storage-json` / `@matter/storage-domain`
// 都**没有** `export default`（那正是 `verify-plugin-entry-exports` 在挡的事故形态）。
import * as StorageJson from "@matter/storage-json"
import * as StorageDomain from "@matter/storage-domain"
import { openJournalFacility, type JournalFacility } from "@matter/storage-journal"
import { ProjectsFacility, openProjects } from "../../src/index.ts"

/** 一套已装配好的现场。 */
export interface Harness {
  /** 宿上下文（`ctx.projects` 是否挂上由各用例自己看）。 */
  readonly ctx: Context
  /** 活动流（独立于项目域，单测可直接 append / count）。 */
  readonly journal: JournalFacility
  /** 项目门面。 */
  readonly projects: ProjectsFacility
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
  const root = reuseRoot ?? await mkdtemp(join(tmpdir(), "matter-project-"))
  const ctx = await bootContext(root)
  const journal = ctx.journal
  const projects = await openProjects(ctx)
  return {
    ctx,
    journal,
    projects,
    root,
    shutdown: async () => {
      await projects.close()
      journal.close()
    },
    dispose: async () => {
      await projects.close()
      journal.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * 只装配上下文与 journal（不打开项目域）。给「装配/注销」类用例用。
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
