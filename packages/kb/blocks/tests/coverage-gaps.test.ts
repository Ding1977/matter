/**
 * @matter/blocks 判别辅助的词表外分支补测（ISS-528）。
 *
 * spec.test.ts 已盖满 28 个合法类型的全部判别路径；本文件只补两个「词表之外」
 * 才会经过的分支，都写成「换成错误实现即红」的形态：
 *   ① blockGroup 三谓词全 false ⇒ assertNever 抛 UnhandledBlockTypeError
 *      —— 这是封闭联合兜底、assertNever 本体与该错误类构造器的唯一运行期载体；
 *   ② 容器合法但不带 children ⇒ blockChildren 兜底空数组（`children ?? []` 右分支）。
 * @module @matter/blocks/tests/coverage-gaps
 */

import { describe, expect, it } from "vitest"
import {
  Block, assertNever, blockChildren, blockGroup, isContainer, UnhandledBlockTypeError,
} from "../src/index.ts"
import type { Block as BlockValue } from "../src/index.ts"

describe("blockGroup 的词表外兜底（assertNever 封闭性的运行期载体）", () => {
  it("三谓词全 false ⇒ 抛 UnhandledBlockTypeError：instanceof、错误名与 JSON 序列化消息", () => {
    const bogus = { id: "x", type: "NOPE" } as unknown as BlockValue
    let caught: unknown
    try {
      blockGroup(bogus)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UnhandledBlockTypeError)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe("UnhandledBlockTypeError")
    // 消息是 JSON 序列化形态（带引号），沿用封闭性断言的原句
    expect((caught as Error).message).toBe('unhandled BlockType: "NOPE"')
  })

  it("assertNever 直接调用抛同款错误（值经 JSON.stringify，不是裸值）", () => {
    expect(() => assertNever("raw" as never)).toThrow('unhandled BlockType: "raw"')
  })

  it("UnhandledBlockTypeError 可独立构造：instanceof Error、name 与消息文本", () => {
    const error = new UnhandledBlockTypeError("quote-me")
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(UnhandledBlockTypeError)
    expect(error.name).toBe("UnhandledBlockTypeError")
    expect(error.message).toBe("unhandled BlockType: quote-me")
  })
})

describe("blockChildren 的容器缺 children 兜底", () => {
  it("三种合法容器不带 children ⇒ 空数组（运行期安全网，不是 undefined）", () => {
    for (const value of [
      { id: "tg", type: "toggle", title: "t" },
      { id: "cl", type: "columns" },
      { id: "sb", type: "syncedBlock", ref: "b-root" },
    ]) {
      const block = Block.parse(value)
      expect(isContainer(block), `type=${value.type}`).toBe(true)
      expect(blockChildren(block), `type=${value.type}`).toEqual([])
    }
  })
})
