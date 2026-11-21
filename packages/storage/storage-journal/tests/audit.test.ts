/**
 * ISS-524 搬入的审计共享机制层（`audit.ts`）的契约用例。
 *
 * 这些函数从 pm/issue 与 pm/project 的七段克隆收口而来；行为级测试在
 * `pm/issue|project/tests/domain.test.ts`（50 并发写链等）。本文件守**契约本身**：
 * 值换算口径、按值比较（不按引用）、条目缺省列、diff 骨架的顺序与跳过规则、
 * 写链的串行与降级。每条断言都写成「换成错误实现即红」。
 * @module storage-journal/tests/audit
 */

import { describe, expect, it, vi } from "vitest"
import type { JournalEntry } from "../src/index.ts"
import {
  AUDIT_VALUE_MAX,
  auditErrorText,
  auditValue,
  createAuditWriter,
  diffAuditEntries,
  makeAuditDiff,
  makeAuditEntry,
  sameAuditRecord,
  sameAuditValue,
} from "../src/index.ts"

describe("auditValue：值 → 审计行文本", () => {
  it("数组逗号拼接、对象 JSON 化、原始值 String 化", () => {
    expect(auditValue(["a", "b", "c"])).toBe("a, b, c")
    expect(auditValue({ a: 1 })).toBe('{"a":1}')
    expect(auditValue("plain")).toBe("plain")
    expect(auditValue(7)).toBe("7")
    expect(auditValue(null)).toBe("null")
    expect(auditValue(undefined)).toBe("undefined")
    expect(auditValue(true)).toBe("true")
  })

  it("JSON.stringify 产不出文本的对象（toJSON 回 undefined）⇒ 落到 String 兜底，不抛", () => {
    // JSON.stringify 对「顶层 toJSON 返回 undefined」的对象返回 undefined（非抛）⇒ ?? 右支可达。
    const weird = { toJSON: () => undefined }
    expect(auditValue(weird)).toBe(String(weird))
    expect(auditValue(weird)).toBe("[object Object]")
  })

  it("对象超长截断到 AUDIT_VALUE_MAX 并以省略号收尾；恰好不超长则原样", () => {
    expect(AUDIT_VALUE_MAX).toBe(200)
    const over = auditValue({ blob: "x".repeat(300) })
    expect(over).toHaveLength(AUDIT_VALUE_MAX + 1)
    expect(over.endsWith("…")).toBe(true)
    expect(over.startsWith('{"blob":"xxx')).toBe(true)
    // 恰好 200（`{"a":"` 6 字符 + 192 个 y + 收尾 2 字符）：不截断，无省略号。
    const exact = auditValue({ a: "y".repeat(192) })
    expect(exact).toHaveLength(AUDIT_VALUE_MAX)
    expect(exact.endsWith("…")).toBe(false)
  })
})

describe("sameAuditValue：按值比较，不按引用", () => {
  it("原始值同真；undefined 与一切非 undefined 不同", () => {
    expect(sameAuditValue(1, 1)).toBe(true)
    expect(sameAuditValue("a", "a")).toBe(true)
    expect(sameAuditValue(undefined, undefined)).toBe(true)
    expect(sameAuditValue(undefined, 1)).toBe(false)
    expect(sameAuditValue(1, undefined)).toBe(false)
    expect(sameAuditValue(1, "1")).toBe(false)
  })

  it("数组与扁平对象按内容比较：换引用不换内容 ⇒ 相同（审计不长 from/to 同值噪声行）", () => {
    expect(sameAuditValue(["a", "b"], ["a", "b"])).toBe(true)
    expect(sameAuditValue(["a"], ["b"])).toBe(false)
    expect(sameAuditValue({ a: 1 }, { a: 1 })).toBe(true)
    expect(sameAuditValue({ a: 1 }, { a: 2 })).toBe(false)
  })

  it("null 只与 null 相同，不与对象/数组混淆", () => {
    expect(sameAuditValue(null, null)).toBe(true)
    expect(sameAuditValue(null, { a: 1 })).toBe(false)
    expect(sameAuditValue({ a: 1 }, null)).toBe(false)
    expect(sameAuditValue(null, [1])).toBe(false)
  })
})

describe("sameAuditRecord：逐字段按值比较，不依赖键序", () => {
  it("键序不同内容相同 ⇒ 相同；多键、少键、值变 ⇒ 不同", () => {
    expect(sameAuditRecord({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameAuditRecord({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameAuditRecord({ a: 1, b: 2 }, { a: 1 })).toBe(false)
    expect(sameAuditRecord({ a: 1 }, { a: 2 })).toBe(false)
  })

  it("复合字段（tags 数组）换引用不换内容 ⇒ 相同", () => {
    expect(sameAuditRecord({ tags: ["x", "y"] }, { tags: ["x", "y"] })).toBe(true)
    expect(sameAuditRecord({ tags: ["x"] }, { tags: ["x", "y"] })).toBe(false)
  })
})

describe("auditErrorText：错误 → 可读文案", () => {
  it("Error 取 message，其余 String 化", () => {
    expect(auditErrorText(new Error("boom"))).toBe("boom")
    expect(auditErrorText("plain failure")).toBe("plain failure")
    expect(auditErrorText(42)).toBe("42")
  })
})

describe("makeAuditEntry：条目缺省列的收口契约", () => {
  it("known=1 是缺省不写；非 1 显式写；actor 缺省不写、传了写", () => {
    const current = makeAuditEntry("issues/1", "created", { field: "title" }, 1, undefined, new Date(0))
    expect(current).not.toHaveProperty("known")
    expect(current).not.toHaveProperty("actor")

    const unknown = makeAuditEntry("issues/1", "created", {}, 0, undefined, new Date(0))
    expect(unknown.known).toBe(0)
    const retired = makeAuditEntry("issues/1", "created", {}, 2, undefined, new Date(0))
    expect(retired.known).toBe(2)

    const signed = makeAuditEntry("issues/1", "created", {}, 1, "linmo", new Date(0))
    expect(signed.actor).toBe("linmo")
  })

  it("mdAt 装事件自身时刻（at 与 mdAt 同源）；附加键保留、核心列覆盖同名附加键", () => {
    const when = new Date("2026-11-20T01:02:03.456Z")
    const entry = makeAuditEntry("issues/9", "field-change", { entity: "LIE", from: "a" }, 1, "iris", when)
    expect(entry.at).toBe(when.getTime())
    expect(entry.mdAt).toBe("2026-11-20T01:02:03.456Z")
    expect(entry.entity).toBe("issues/9")
    expect(entry.event).toBe("field-change")
    expect(entry.from).toBe("a")
  })

  it("at 缺省 ⇒ 取「现在」且 at/mdAt 同一瞬间（两次调用不留同形塌缩）", () => {
    const entry = makeAuditEntry("issues/1", "created", {}, 1)
    expect(entry.at).toBeTypeOf("number")
    expect(entry.mdAt).toBe(new Date(entry.at as number).toISOString())
  })
})

describe("diffAuditEntries：diff 骨架的顺序与跳过规则", () => {
  const created = (id: string, context: { tag: string }): JournalEntry[] =>
    [{ entity: `items/${id}`, event: "created", note: context.tag }]

  it("previous 缺失 ⇒ 走 created 工厂，id 与 context 原样透传", () => {
    const out = diffAuditEntries("i1", undefined, { a: 1 }, { tag: "seed" }, created, () => null)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ entity: "items/i1", event: "created", note: "seed" })
  })

  it("只报真变了的字段，按字段名排序；field 回调收到 id/before/after/context", () => {
    const seen: Array<[string, string, unknown, unknown]> = []
    const field = (id: string, name: string, before: unknown, after: unknown): JournalEntry => {
      seen.push([id, name, before, after])
      return { entity: `items/${id}`, event: "field-change", field: name }
    }
    const previous = { title: "old", tags: ["a"], status: "todo", kept: 1 }
    const next = { title: "new", tags: ["a"], status: "done", kept: 1, extra: "x" }
    const out = diffAuditEntries("i2", previous, next, { tag: "ctx" }, created, field)
    // tags 内容相同不报；title/status/extra 变了，按名排序。
    expect(out.map((e) => e.field)).toEqual(["extra", "status", "title"])
    expect(seen).toEqual([
      ["i2", "extra", undefined, "x"],
      ["i2", "status", "todo", "done"],
      ["i2", "title", "old", "new"],
    ])
  })

  it("field 回调返回 null ⇒ 该字段不记（表外状态等域侧口径）", () => {
    const field = (_id: string, name: string): JournalEntry | null =>
      name === "internal" ? null : { entity: "items/i3", event: "field-change", field: name }
    const out = diffAuditEntries("i3", { internal: 1, title: "a" }, { internal: 2, title: "b" }, {}, created, field)
    expect(out.map((e) => e.field)).toEqual(["title"])
  })

  it("字段删除（after 缺席）也报，before 原样给回调", () => {
    const out = diffAuditEntries("i4", { title: "a" }, {}, {}, created,
      (_id, name, before) => ({ entity: "items/i4", event: "field-change", field: name, from: String(before) }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ field: "title", from: "a" })
  })
})

describe("makeAuditDiff：绑定回调后行为等同骨架", () => {
  it("一行绑定：created 与 field 两条路径都走绑定后的闭包", () => {
    const created = (id: string): JournalEntry[] => [{ entity: `items/${id}`, event: "created" }]
    const field = (id: string, name: string): JournalEntry => ({ entity: `items/${id}`, event: "field-change", field: name })
    const diffEntries = makeAuditDiff<string, { title?: string }, unknown>(created, field)

    expect(diffEntries("i5", undefined, { title: "x" }, null)).toEqual([{ entity: "items/i5", event: "created" }])
    const changed = diffEntries("i5", { title: "x" }, { title: "y" }, null)
    expect(changed).toEqual([{ entity: "items/i5", event: "field-change", field: "title" }])
  })
})

describe("createAuditWriter：串行写链 + 落审计", () => {
  it("writeAudit 逐条按序 append；单条失败只 warn 且后续条目继续", () => {
    const appended: JournalEntry[] = []
    const warns: string[] = []
    let failOn = "bad-event"
    const writer = createAuditWriter(
      (entry) => { if (entry.event === failOn) throw new Error("journal down"); appended.push(entry); return appended.length },
      (m) => warns.push(m),
      "closed!",
    )
    const entries: JournalEntry[] = [
      { entity: "issues/1", event: "created" },
      { entity: "issues/1", event: "bad-event" },
      { entity: "issues/1", event: "field-change" },
    ]
    writer.writeAudit(entries)
    // 第一、三条仍落，失败那条只出声 —— 记录是主，审计是伴生。
    expect(appended.map((e) => e.event)).toEqual(["created", "field-change"])
    expect(warns).toEqual(["audit append failed (issues/1 bad-event): journal down"])
  })

  it("append 抛非 Error 也走同一条 warn（String 化文案）", () => {
    const warns: string[] = []
    const writer = createAuditWriter(() => { throw "plain string failure" }, (m) => warns.push(m), "closed!")
    writer.writeAudit([{ entity: "issues/2", event: "deleted" }])
    expect(warns).toEqual(["audit append failed (issues/2 deleted): plain string failure"])
  })

  it("enqueue 串行：慢任务先入队，后入队的等它完成；返回 job 的结果", async () => {
    const order: string[] = []
    let releaseSlow: (() => void) | undefined
    const writer = createAuditWriter(() => 1, () => {}, "closed!")
    const slow = writer.enqueue(async () => {
      await new Promise<void>((resolve) => { releaseSlow = resolve })
      order.push("slow-done")
      return "slow-result"
    })
    const fast = writer.enqueue(async () => { order.push("fast-done") })
    // 链把 fast 排在 slow 之后：slow 未放行前 fast 不得执行。
    await vi.waitFor(() => expect(releaseSlow).toBeDefined())
    expect(order).toEqual([])
    releaseSlow!()
    expect(await slow).toBe("slow-result")
    await fast
    expect(order).toEqual(["slow-done", "fast-done"])
  })

  it("上一个 job 拒绝不毒化链：下一个 enqueue 照常跑（链吞拒绝）", async () => {
    const writer = createAuditWriter(() => 1, () => {}, "closed!")
    const rejected = writer.enqueue(async () => { throw new Error("job failed") })
    const next = writer.enqueue(async () => "still-runs")
    await expect(rejected).rejects.toThrow("job failed")
    expect(await next).toBe("still-runs")
  })

  it("markClosed 后：isClosed 为真，enqueue 拒绝 closedMessage", async () => {
    const appended: JournalEntry[] = []
    const writer = createAuditWriter((e) => { appended.push(e); return 1 }, () => {}, "facility is closed")
    expect(writer.isClosed()).toBe(false)
    await writer.enqueue(async () => "ok")
    writer.markClosed()
    expect(writer.isClosed()).toBe(true)
    await expect(writer.enqueue(async () => "nope")).rejects.toThrow("facility is closed")
  })
})
