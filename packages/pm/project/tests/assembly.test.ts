/**
 * 装配：`ctx.projects` 什么时候出现、什么时候消失。
 *
 * ## 为什么要单独一节
 *
 * 「域能打开」与「插件挂上了服务键」是两件事。`openProjects` 直接调能开，
 * `apply` 里漏掉 `ctx.provide("projects", …)` 也一样能开 —— 而后者意味着**没有任何消费者
 * 找得到它**，屏幕上却毫无异常。本节的判据就是这一对：
 *
 *   · `ctx.inject` 声明的三处依赖（`storage` / `storageDomain` / `journal`）缺任一处 ⇒ 不激活；
 *   · 三处齐 ⇒ `ctx.projects` 是实例，且卸载后消失。
 *
 * @module @matter/project/tests/assembly
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { describe, expect, it, vi } from "vitest"
import Storage from "@matter/storage"
import * as StorageJson from "@matter/storage-json"
import * as StorageDomain from "@matter/storage-domain"
import { openJournalFacility } from "@matter/storage-journal"
import * as ProjectPlugin from "../src/index.ts"
import { ProjectsFacility } from "../src/index.ts"

/** 建一个临时根目录。调用方负责删。 */
async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "matter-project-assembly-"))
}

describe("插件装配", () => {
  it("三处依赖齐才激活；缺 journal 时不激活（不是报错，是不出现）", async () => {
    // ⛔ 被测行为：`index.ts` 的 `export const inject = ["storage", "storageDomain", "journal"]`。
    //    把 "journal" 从数组删掉 ⇒ 第一条断言（激活前 `ctx.projects` 未定义）变红。
    const root = await tempRoot()
    const ctx = new Context()
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root: join(root, "records") })
      await ctx.plugin(StorageDomain, { backend: "json" })
      const fiber = await ctx.plugin(ProjectPlugin)

      // journal 还没提供 ⇒ fiber 等着，服务键不出现
      expect(ctx.get("projects")).toBeUndefined()

      const journal = await openJournalFacility(root)
      const disposeJournal = ctx.provide("journal", journal)
      await vi.waitFor(() => { expect(ctx.projects).toBeInstanceOf(ProjectsFacility) })

      // 依赖之一消失 ⇒ 服务键随之消失（不是留着半死的实例）
      disposeJournal()
      await vi.waitFor(() => { expect(ctx.get("projects")).toBeUndefined() })
      await fiber.dispose()
      journal.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("卸载后域已关：句柄不可再写，且域名可被重新打开", async () => {
    const root = await tempRoot()
    const ctx = new Context()
    const journal = await openJournalFacility(root)
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root: join(root, "records") })
      await ctx.plugin(StorageDomain, { backend: "json" })
      ctx.provide("journal", journal)
      const fiber = await ctx.plugin(ProjectPlugin)
      // `apply` 的返回是 promise：`ctx.plugin` 不 await 它内部那段 then（cordis 的 fiber
      // 只保证 apply 同步段跑完）⇒ 用 `vi.waitFor` 等键出现，而不是假设 `await` 就到齐。
      await vi.waitFor(() => { expect(ctx.projects).toBeInstanceOf(ProjectsFacility) })
      const projects = ctx.projects
      await projects.create({ id: "PRJ-1", title: "x", status: "active", created: "2026-11-17" })

      await fiber.dispose()
      // ⛔ 被测行为：`apply` 的 disposer 先 `dispose()` 摘键、再 `await facility.close()`。
      //    只摘键不关域 ⇒ 域名仍被占，下面那次重开会报 `already-open` ⇒ 本用例红。
      await expect(projects.create({ id: "PRJ-2", title: "y", status: "active", created: "2026-11-17" }))
        .rejects.toThrow(/closed/)

      const reopened = await ProjectPlugin.openProjects(ctx)
      await expect(reopened.get("PRJ-1")).toBeDefined()
      // 重开后活动流还是原来那一条 —— 域关过，审计没丢
      expect(journal.count()).toBe(1)
      await reopened.close()
    } finally {
      journal.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
