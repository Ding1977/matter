/**
 * 预览种子幂等判据（ISS-905 · 验收 3）。
 *
 * 重跑不翻倍、不覆盖用户已有修改；长文 ≥2000 字；覆盖面（空标题/多块/四态）。
 *
 * @module apps/host/tests/seed
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createHostAssembly } from "../src/assembly.ts"
import { PREVIEW_SEEDS, seedPreviewDocuments } from "../src/seed.ts"

/** 长文正文纯文本长度（只数 rich 文本，与渲染层读到的字一致）。 */
function richLength(index: number): number {
  const record = PREVIEW_SEEDS[index]!.record
  return record.blocks
    .filter((block) => "rich" in block)
    .flatMap((block) => block.rich.map((part) => part.text))
    .join("").length
}

describe("预览种子数据（ISS-905）", () => {
  it("覆盖面：≥10 条、长文 ≥2000 字、空标题、多块、四态齐全", () => {
    expect(PREVIEW_SEEDS.length).toBeGreaterThanOrEqual(10)
    expect(richLength(0)).toBeGreaterThanOrEqual(2000)

    const ids = PREVIEW_SEEDS.map((seed) => seed.record.props.id)
    expect(new Set(ids).size).toBe(ids.length)

    expect(PREVIEW_SEEDS.some((seed) => seed.record.props.title.trim() === "")).toBe(true)
    expect(PREVIEW_SEEDS.some((seed) => seed.record.blocks.length >= 5)).toBe(true)

    const statuses = new Set(PREVIEW_SEEDS.map((seed) => seed.record.props.status).filter(Boolean))
    expect([...statuses].sort()).toEqual(["done", "draft", "in_progress", "revising"])
  })

  it("幂等：重跑不翻倍、不覆盖已保存的用户改动", async () => {
    const root = await mkdtemp(join(tmpdir(), "preview-seed-"))
    const host = await createHostAssembly({ root })
    try {
      const docs = host.ctx.documents
      const first = await seedPreviewDocuments(docs)
      expect(first).toEqual({ added: PREVIEW_SEEDS.length, skipped: 0, total: PREVIEW_SEEDS.length })
      expect(docs.size).toBe(PREVIEW_SEEDS.length)

      // 模拟用户在预览里改了标题并保存（真门面 update，落持久盘）。
      const target = PREVIEW_SEEDS[1]!.record.props.id
      const current = docs.get(target)!
      const changed = await docs.update(target, { props: { ...current.props, title: "用户改过的标题-2322" } })
      expect(changed.props.title).toBe("用户改过的标题-2322")

      // 重跑 seed：全跳过，条数不翻倍，用户改动不被覆盖。
      const second = await seedPreviewDocuments(docs)
      expect(second).toEqual({ added: 0, skipped: PREVIEW_SEEDS.length, total: PREVIEW_SEEDS.length })
      expect(docs.size).toBe(PREVIEW_SEEDS.length)
      expect(docs.get(target)?.props.title).toBe("用户改过的标题-2322")
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
