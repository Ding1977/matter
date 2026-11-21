#!/usr/bin/env node
// scripts/code-inventory-k9c.test.mjs
// E5 / K9c（ISS-771）的**变异验证入口**：证明「探测 vs 吞失败」这条口径两半都钉住了。
//
// 为什么要有：K9c 从「`2>/dev/null` 一律计数」改成「只计吞失败」——这是一次**口径收窄**，
// 收窄最容易出的事故是「连牙一起砍掉」：把所有 `2>/dev/null` 都免了，于是这条规则变成恒绿。
// 所以自检里正控（探测不计）与反控（吞失败仍计）**条数必须相当**，且不许出现 ✗。
//
// 用法：bun test scripts/code-inventory-k9c.test.mjs --isolate
import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const INV = path.join(ROOT, "scripts", "code-inventory.mjs")
const run = (args) => execFileSync(process.execPath, [INV, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

describe("E5/K9c 判据（ISS-771 口径：只计吞失败）", () => {
  test("--selftest-k9c 全绿：探测不计、吞失败仍计、边界不误伤", () => {
    const out = run(["--selftest-k9c"])
    expect(out).not.toContain("✗")
    expect(out).toMatch(/✓ \d+\/\d+ 项通过/)
    // 反向控制必须真的在：没有反控，正控全绿也可能只是"把判据调瞎了"
    expect(out).toContain("反控 `git push 2>/dev/null` 仍计")
    expect(out).toContain("正控 `kill -0")
  })
})
