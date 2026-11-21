/**
 * @matter/issue 的事件换算与审计降级分支补测（ISS-523 / C-0b）。
 *
 * 这些分支都是「写面拦得住、但事件换算层仍要诚实处理」的防御面：
 * 对象值截断、外来事件名、表外状态、正文非字符串、审计追加失败。
 * @module @matter/issue/tests/coverage-gaps
 */

import { describe, expect, it } from "vitest"
import type { IssueProps } from "../src/index.ts"
import {
  bodyFingerprint, diffEntries, issueEntry, logValue, sameValue,
} from "../src/index.ts"
import { openIssues } from "../src/index.ts"
import { bootBare } from "./helpers/harness.ts"

const draft = (id = "ISS-1", extra: Record<string, unknown> = {}) => ({
  id, title: "第一张", status: "todo", kind: "feature", created: "2026-11-17", ...extra,
}) as IssueProps

describe("logValue：对象值的截断与 JSON.stringify 失效", () => {
  it("短对象 JSON 原样、长对象截断到 LOG_VALUE_MAX，toJSON 返回 undefined 时退化为 String", () => {
    expect(logValue({ a: 1 })).toBe('{"a":1}')
    const long = logValue({ blob: "x".repeat(300) })
    expect(long.length).toBe(201)
    expect(long.endsWith("…")).toBe(true)
    // JSON.stringify 对 toJSON()=>undefined 返回 undefined ⇒ ?? 右侧必须接住。
    expect(logValue({ toJSON: () => undefined })).toBe("[object Object]")
  })
})

describe("事件换算的防御面", () => {
  it("空正文指纹 lines=0", () => {
    expect(bodyFingerprint("")).toMatchObject({ lines: 0 })
  })

  it("表外事件名落 known: 0，不冒充现行词表", () => {
    expect(issueEntry("ISS-1", "unknown-event", {})).toMatchObject({ known: 0 })
    expect(issueEntry("ISS-1", "issue-created", {})).not.toHaveProperty("known")
  })

  it("previous 缺失 ⇒ 建单事件", () => {
    const entries = diffEntries("ISS-1", undefined, draft())
    expect(entries).toHaveLength(1)
    expect(entries[0].event).toBe("issue-created")
  })

  it("sameValue：null 与对象不等（不进 JSON.stringify 比较）", () => {
    expect(sameValue(null, { a: 1 })).toBe(false)
    expect(sameValue({ a: 1 }, null)).toBe(false)
  })

  it("表外状态值不记事件（不编造信号名）", () => {
    const next = { ...draft(), status: "zap" } as IssueProps
    expect(diffEntries("ISS-1", draft(), next)).toEqual([])
  })

  it("正文前后非字符串 ⇒ 按空正文算指纹，仍记 body-change", () => {
    const next = { ...draft(), body: 123 } as IssueProps
    const entries = diffEntries("ISS-1", draft(), next)
    expect(entries).toHaveLength(1)
    expect(entries[0].event).toBe("body-change")
    expect(entries[0]).toMatchObject({ fromLines: 0, toLines: 0, lineDelta: 0 })
  })
})

describe("门面：entries 与审计降级", () => {
  it("entries 可遍历；journal.append 抛 Error 与非 Error 都只 warn 不中断写入", async () => {
    const bare = await bootBare()
    const warns: string[] = []
    // 只替换 logger 的出声口，断言 warn 文案确实带上了两种错误形状。
    ;(bare.ctx as unknown as { logger: unknown }).logger = () => ({ warn: (m: string) => warns.push(m) })
    let thrown: unknown = new Error("audit down")
    const journal = bare.journal as unknown as { append: (e: unknown) => void }
    journal.append = () => { throw thrown }

    const issues = await openIssues(bare.ctx)
    await issues.create(draft("ISS-90"))
    thrown = "plain string failure"
    await issues.create(draft("ISS-91"))

    expect([...issues.entries()]).toHaveLength(2)
    expect(warns).toHaveLength(2)
    expect(warns[0]).toContain("audit down")
    expect(warns[1]).toContain("plain string failure")
    await issues.close()
    await bare.dispose()
  })
})
