#!/usr/bin/env node
// scripts/watch-home-links.test.mjs
// Home 软链观测器（ISS-699 · D-1）的端到端验证：探针有效、结论不假绿。
//
// 关键点：`lsof` 是快照、业务读是瞬时 readFileSync ⇒ 「采样命中 0」不等于零读。
// 所以测试盯的是「阳性对照必须命中」与「判不了时不许报绿」，而不是「零读」。
// 阳性对照的判据是「命中数 === 采样数」（fd 全程打开 ⇒ 每次采样必然可见），
// 不是「>0」：后者会把「部分失明」当探针有效（ISS-699 复审 F3）。
//
// 用法：bun test scripts/watch-home-links.test.mjs --isolate
import { describe, expect, test, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { judgeProbe } from "./watch-home-links.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const GUARD = path.join(ROOT, "scripts", "watch-home-links.mjs")

const made = []
afterEach(() => {
  for (const d of made.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }
})

function run(args, env = {}) {
  const opts = { encoding: "utf8", maxBuffer: 16 << 20, env: { ...process.env, ...env } }
  try {
    return { code: 0, out: execFileSync("node", [GUARD, ...args], opts) }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : -1, out: `${e.stdout || ""}${e.stderr || ""}` }
  }
}

describe("Home 软链只读观测器（ISS-699 · D-1）", () => {
  test("判据 1 / --selftest：解析与阳性对照自身绿", () => {
    const r = run(["--selftest"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("verdict=green")
    expect(r.out).toMatch(/\d+\/\d+ 项通过/)
  })

  test("判据 1 / 短窗口：探针有效、home 下全部软链逐条有命中计数", () => {
    const r = run(["--json", "--duration", "3", "--interval", "100"])
    expect(r.code).toBe(0)
    const d = JSON.parse(r.out)
    expect(d.verdict).toBe("observable")
    expect(d.lsofOk).toBe(true)
    expect(d.positiveControl.passed).toBe(true)
    expect(d.samples).toBeGreaterThan(5)
    // F3：对照 fd 全程打开 ⇒ **每次采样都必然命中**。只判 >0 会放过「17 次采样只见 1 次」的部分失明。
    expect(d.positiveControl.hits).toBe(d.samples)
    expect(Array.isArray(d.links)).toBe(true)
    // ⚠️ 不硬编码软链总数：D-2 摘除 D3 后是 6 条，之后还可能变。
    //    这里改钉「探针必须看到 home 下当前所有软链」，比固定数字更有牙。
    const realLinks = fs.readdirSync(path.join(os.homedir(), ".dsh"))
      .filter((n) => fs.lstatSync(path.join(os.homedir(), ".dsh", n)).isSymbolicLink())
    expect(d.links.length).toBe(realLinks.length)
    expect(realLinks.length).toBeGreaterThan(0)
    for (const l of d.links) {
      expect(typeof l.hits).toBe("number")
      expect(typeof l.target).toBe("string")
      expect(typeof l.targetExists).toBe("boolean")
    }
  })

  test("判据 F3 变异：17 次采样只命中阳性对照 1 次（部分失明）⇒ 判不 observable", () => {
    // 直接打判据纯函数：CLI 无法在这台机器上造出部分失明，而这条判据正是 F3 指出的没牙处。
    const partial = judgeProbe({ samples: 17, positiveHits: 1 })
    expect(partial.passed).toBe(false)
    expect(partial.verdict).toBe("unobservable")
    // 反向控制：全命中才算有效；空窗口不算有效（不许拿 0 采样当绿）
    expect(judgeProbe({ samples: 17, positiveHits: 17 }).verdict).toBe("observable")
    expect(judgeProbe({ samples: 0, positiveHits: 0 }).passed).toBe(false)
  })

  test("判据 F1 回归：home 无软链（HOME 指向空目录）⇒ --selftest 不崩、exit 0、明确写跳过", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "watch-links-nohome-"))
    made.push(home)
    const r = run(["--selftest"], { HOME: home })
    expect(r.code).toBe(0)
    expect(r.out).not.toContain("TypeError")
    expect(r.out).toContain("跳过")
    expect(r.out).toContain("verdict=green")
  })

  test("判据 F2 回归：自造临时 HOME 时自检只用那个 home 做可选观测，不绑真机布局", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "watch-links-fakehome-"))
    made.push(home)
    const dsh = path.join(home, ".dsh")
    fs.mkdirSync(dsh)
    const data = path.join(home, "data.json")
    fs.writeFileSync(data, "{}\n")
    fs.symlinkSync(data, path.join(dsh, ".forge-plans.yaml"))
    const r = run(["--selftest"], { HOME: home })
    expect(r.code).toBe(0)
    expect(r.out).toContain("verdict=green")
    expect(r.out).toContain(path.join(home, ".dsh")) // 打印的是这个临时 home，不是 <home>/.dsh
  })

  test("判据 1 / 诚实边界：瞬时读检出率被如实给出（0~1）", () => {
    const d = JSON.parse(run(["--json", "--duration", "3", "--interval", "100"]).out)
    const tc = d.transientControl
    expect(tc.reads).toBeGreaterThan(0)
    expect(tc.detectionRate).toBeGreaterThanOrEqual(0)
    expect(tc.detectionRate).toBeLessThanOrEqual(1)
    expect(tc.note).toContain("零读证据")
  })

  test("判不了不当绿：home 下没有软链 ⇒ verdict=unobservable 且退出码非 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-links-empty-"))
    made.push(dir)
    const r = run(["--json", "--duration", "1", "--home", dir])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("unobservable")
  })

  test("只读性：观测前后 home 下软链目标与数量不变", () => {
    const home = path.join(os.homedir(), ".dsh")
    const before = fs.readdirSync(home)
      .filter((n) => fs.lstatSync(path.join(home, n)).isSymbolicLink())
      .map((n) => [n, fs.readlinkSync(path.join(home, n))])
      .sort()
    run(["--json", "--duration", "2", "--interval", "100"])
    const after = fs.readdirSync(home)
      .filter((n) => fs.lstatSync(path.join(home, n)).isSymbolicLink())
      .map((n) => [n, fs.readlinkSync(path.join(home, n))])
      .sort()
    expect(after).toEqual(before)
    // 软链数会随 D-2 摘链变化，只钉「至少还有软链可观测」+「跑观测前后完全一致」
    expect(before.length).toBeGreaterThan(0)
  })
})
