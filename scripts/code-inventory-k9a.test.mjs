#!/usr/bin/env node
// scripts/code-inventory-k9a.test.mjs
// E6 / K9a（ISS-709）的**端到端变异验证**：证明这条零容忍判据不是哑的。
//
// 为什么单独成文件：`code-inventory.mjs --selftest-k9a` 验的是判据纯函数那一层；
// 本测试跑**真 CLI 子进程**，证的是「真探测器在真仓里真的数到了东西」。
//
// 背景（缺陷本体）：旧判据是两个互斥的结尾断言
//   `/(^|\.)exit$/.test(nm) && /process$/.test(nm)`
// 前者要求以 `exit` 结尾、后者要求以 `process` 结尾，同一字符串不可能同时满足
// ⇒ E6 恒 0 ⇒ K9a「库代码不得 process.exit」从上线起**从未响过**（有账无牙）。
// 只看「度量 = 0」分不清「真的一处都没有」和「探测器坏了」，所以这里两条都要钉：
//   ① 判据对真调用成立、对非调用不成立（判定力）；
//   ② 真仓里 E6 必须 > 0（探测器真的能看见东西）。
//
// 用法：bun test scripts/code-inventory-k9a.test.mjs --isolate
import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const INV = path.join(ROOT, "scripts", "code-inventory.mjs")
const run = (args) => execFileSync(process.execPath, [INV, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

// 全量盘点一次约 5s（要借 TS 编译器解析全仓）—— 跑一次共享给两条断言，不重复起子进程
let e6Cache = null
const e6 = () => {
  if (!e6Cache) e6Cache = JSON.parse(run(["--json"])).metrics.find((m) => m.id === "E6")
  return e6Cache
}

describe("E6/K9a 判据（ISS-709）", () => {
  test("--selftest-k9a 全绿：真调用必计、非调用不误计、旧正则判死", () => {
    const out = run(["--selftest-k9a"])
    expect(out).toContain("旧正则")
    // 一项都不许 ✗ —— 这是零容忍判据的自检，它自己哑了就没有意义
    expect(out).not.toContain("✗")
    expect(out).toMatch(/✓ \d+\/\d+ 项通过/)
  })

  /* ⚠️ ISS-771 修正一条**过期断言**（ISS-769 射程收窄的连带）：
     这条原来写 `expect(m.value).toBeGreaterThan(0)`，理由是「旧正则下 E6 恒 0 ⇒ 此断言必红」。
     但 ISS-769 把「可执行入口」从 K9a 射程里摘出去之后，真仓里的**真违规确实归零**（23 处全是
     electron-shell 的一次性调试脚本 / `*-cli.mjs` / `*-probe.mjs`）⇒ `E6 > 0` 不再是「探测器活着」的
     证据，反而变成一条**惩罚正确状态**的断言（修好了就红）。
     liveness（探测器是否还活着）已经由 `--selftest-k9a` 的正控钉住（喂 `process.exit(1)` 必须命中）+
     ISS-769 的端到端注入（普通 `lib/*.js` 写 process.exit ⇒ E6 0→1）。所以这里改成钉**账目自洽**：
     数与名单同账 + 射程豁免**可数**（不是静默清零）。 */
  test("E6 的名单与数同账，且射程豁免可数（不是静默清零）", () => {
    const m = e6()
    expect(m).toBeTruthy()
    expect(m.gate).toBe("K9a")
    // 数与名单同账（命中 0 时名单也必须为空 —— 不许"数 0 但名单还有货"）
    expect(Array.isArray(m.offenders)).toBe(true)
    for (const o of m.offenders) {
      expect(typeof o.k).toBe("string")
      expect(o.k.length).toBeGreaterThan(0)
      expect(o.n).toBeGreaterThan(0)
    }
    expect(m.offenders.reduce((s, o) => s + o.n, 0)).toBe(m.value)
    // 射程豁免**可数**：note 里必须打印「豁免 N 个文件 / M 处」且都 > 0。
    // 静默豁免 = 看不见 —— 这条断言就是防它退化成"把规则调瞎了所以 0"。
    expect(m.note).toMatch(/豁免 (\d+) 个文件 \/ (\d+) 处/)
    const [, files, calls] = m.note.match(/豁免 (\d+) 个文件 \/ (\d+) 处/)
    expect(Number(files)).toBeGreaterThan(0)
    expect(Number(calls)).toBeGreaterThan(0)
  }, 60_000)
})
