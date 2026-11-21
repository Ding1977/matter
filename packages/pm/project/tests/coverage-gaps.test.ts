/**
 * @matter/project 的事件换算与审计降级分支补测（ISS-523 / C-0b）。
 *
 * 项目域没有 body / 状态信号层，故比 issue 少两条；其余防御面同口径。
 * @module @matter/project/tests/coverage-gaps
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ProjectProps } from "../src/index.ts"
import { diffEntries, logValue, projectEntry, sameValue } from "../src/index.ts"
import { openProjects } from "../src/index.ts"
import { bootContext } from "./helpers/harness.ts"

const draft = (id = "PRJ-1", extra: Record<string, unknown> = {}) => ({
  id, title: "第一项", status: "planned", created: "2026-11-17", ...extra,
}) as ProjectProps

describe("logValue：对象值的截断与 JSON.stringify 失效", () => {
  it("短对象 JSON 原样、长对象截断到 LOG_VALUE_MAX，toJSON 返回 undefined 时退化为 String", () => {
    expect(logValue({ a: 1 })).toBe('{"a":1}')
    const long = logValue({ blob: "x".repeat(300) })
    expect(long.length).toBe(201)
    expect(long.endsWith("…")).toBe(true)
    expect(logValue({ toJSON: () => undefined })).toBe("[object Object]")
  })
})

describe("事件换算的防御面", () => {
  it("表外事件名落 known: 0，不冒充现行词表", () => {
    expect(projectEntry("PRJ-1", "unknown-event", {})).toMatchObject({ known: 0 })
    expect(projectEntry("PRJ-1", "created", {})).not.toHaveProperty("known")
  })

  it("previous 缺失 ⇒ 建记录事件", () => {
    const entries = diffEntries("PRJ-1", undefined, draft())
    expect(entries).toHaveLength(1)
    expect(entries[0].event).toBe("created")
  })

  it("sameValue：null 与对象不等（不进 JSON.stringify 比较）", () => {
    expect(sameValue(null, { a: 1 })).toBe(false)
    expect(sameValue({ a: 1 }, null)).toBe(false)
  })
})

describe("门面：entries 与审计降级", () => {
  it("entries 可遍历；journal.append 抛 Error 与非 Error 都只 warn 不中断写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "matter-project-cov-"))
    const ctx = await bootContext(root)
    const warns: string[] = []
    ;(ctx as unknown as { logger: unknown }).logger = () => ({ warn: (m: string) => warns.push(m) })
    let thrown: unknown = new Error("audit down")
    const journal = ctx.journal as unknown as { append: (e: unknown) => void }
    journal.append = () => { throw thrown }

    const projects = await openProjects(ctx)
    await projects.create(draft("PRJ-90"))
    thrown = "plain string failure"
    await projects.create(draft("PRJ-91"))

    expect([...projects.entries()]).toHaveLength(2)
    expect(warns).toHaveLength(2)
    expect(warns[0]).toContain("audit down")
    expect(warns[1]).toContain("plain string failure")
    await projects.close()
    ctx.journal.close()
    await rm(root, { recursive: true, force: true })
  })
})
