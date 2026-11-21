#!/usr/bin/env node
// scripts/lint-writer-uniqueness.test.mjs
// 唯一写者门禁（ISS-698）的**端到端变异验证**：证明判据不是恒绿的摆设。
//
// `--selftest` 验的是内部 fixture 那一层；这里跑真 CLI + 临时 home 副本，
// 证的是「真机上读得到东西、该红能红、注释不误伤、判不了不当绿」。
// 副本而不是原地改：真机 home 是运行态配置，绝不在验证里动它。
//
// 用法：bun test scripts/lint-writer-uniqueness.test.mjs --isolate
import { describe, expect, test, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const GUARD = path.join(ROOT, "scripts", "lint-writer-uniqueness.mjs")
const REAL_APP = path.join(os.homedir(), ".dsh")
const REAL_DEV = path.join(os.homedir(), ".dsh-matter")
const LAYOUT = {
  appPatch: "profiles/desktop/cordis.patch.yml",
  appPkg: "profiles/desktop/package.json",
  devPatch: "profiles/web/cordis.patch.yml",
  devPkg: "profiles/web/package.json",
}
// D1/D2 白名单：`docs/home-links-contract.md` §1 登记在册的 6 条软链（App home 借读 dev home）。
// ⚠️ D-2（ISS-699）已摘 D3 `forge-model.db`，**不要把它写回断言**；回滚是契约允许的动作，
//    所以它若重新出现不算违规（下面的「白名单外」判定已把它排除）。
// 为什么钉名单不钉数量（ISS-699 复审 F4）：`>= 5` 在「6 条被摘成 1 条」时仍然绿，
//    而硬编码 `>= 11`（4 配置 + 7 软链）又在 D-2 摘链后必红 —— 数个数两边都错。
const LINK_WHITELIST = [
  "AGENTS.md",
  ".forge-plans-modelsdev.json",
  ".forge-plans-models.yaml",
  ".forge-plans-catalog.json",
  ".forge-plans-live.json",
  ".forge-plans.yaml",
]

function symlinkNames(home) {
  try {
    return fs.readdirSync(home).filter((n) => fs.lstatSync(path.join(home, n)).isSymbolicLink()).sort()
  } catch { return [] }
}

/** 白名单里缺了谁：不在 ⇒ 缺；在但目标解析不到（断链）⇒ 也算缺（读不到等于没有）。
 *  抽成纯函数只为让「摘掉一条就必须红」本身可测 —— 见下面 F4 变异用例。 */
function missingFromWhitelist(home) {
  const have = new Set(symlinkNames(home))
  return LINK_WHITELIST.filter((n) => !have.has(n) || !fs.existsSync(path.join(home, n)))
}

const made = []
afterEach(() => {
  for (const d of made.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }
})

function runGuard(args = ["--check"], app = REAL_APP, dev = REAL_DEV) {
  const cmd = ["node", GUARD, ...args, "--app-home", app, "--dev-home", dev]
  try {
    return { code: 0, out: execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", maxBuffer: 16 << 20 }) }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : -1, out: `${e.stdout || ""}${e.stderr || ""}` }
  }
}

/** 造最小 home 副本：从真机原样复制 4 个配置文件（不改真机一个字节）。 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-uniqueness-fixture-"))
  made.push(dir)
  const app = path.join(dir, "app")
  const dev = path.join(dir, "dev")
  fs.mkdirSync(path.join(app, "profiles/desktop"), { recursive: true })
  fs.mkdirSync(path.join(dev, "profiles/web"), { recursive: true })
  const P = {}
  for (const [k, rel] of Object.entries(LAYOUT)) {
    const src = path.join(k.startsWith("app") ? REAL_APP : REAL_DEV, rel)
    const dst = path.join(k.startsWith("app") ? app : dev, rel)
    fs.copyFileSync(src, dst)
    P[k] = dst
  }
  return { dir, app, dev, P }
}

function sha(p) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12) } catch { return "MISSING" }
}

describe("唯一写者门禁（ISS-698 · E-0）", () => {
  test("判据 1：真机当前绿，且显式输出 verdict=green", () => {
    const r = runGuard(["--check"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("verdict=green")
  })

  test("判据 6 / 只读性：跑门禁前后真机 4 配置 + 登记软链全部不变", () => {
    const snapshot = () => [
      ...Object.entries(LAYOUT).map(([k, rel]) => path.join(k.startsWith("app") ? REAL_APP : REAL_DEV, rel)),
      ...symlinkNames(REAL_APP).map((n) => path.join(REAL_APP, n)),
    ].map((p) => [p, fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : sha(p)])
    const before = snapshot()
    runGuard(["--check"])
    expect(snapshot()).toEqual(before)
    // 钉名单（不钉数量）：这 6 条里任何一条被非法摘掉或断链 ⇒ 红并点名。
    expect(missingFromWhitelist(REAL_APP)).toEqual([])
    // 反向：真机 home 冒出白名单外的软链 ⇒ 报出来（契约文档 §1 要同步）。D3 回滚不在此列。
    expect(symlinkNames(REAL_APP).filter((n) => !LINK_WHITELIST.includes(n) && n !== "forge-model.db")).toEqual([])
  })

  test("判据 F4 变异：临时 home 缺一条登记软链 ⇒ 名单断言必须点名报缺", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-uniqueness-links-"))
    made.push(dir)
    const last = LINK_WHITELIST[LINK_WHITELIST.length - 1]
    const linkIn = (home, n) => fs.symlinkSync(fs.readlinkSync(path.join(REAL_APP, n)), path.join(home, n))
    for (const n of LINK_WHITELIST) if (n !== last) linkIn(dir, n)
    expect(missingFromWhitelist(dir)).toEqual([last]) // 摘掉一条 ⇒ 必须红并点名，而不是「数量还行」
    linkIn(dir, last)
    expect(missingFromWhitelist(dir)).toEqual([]) // 反向控制：补齐后不再报缺（说明不是恒红）
  })

  test("判据 2：删 App forge-pm 的 proxyBase ⇒ 红且点名 W1", () => {
    const { app, dev, P } = fixture()
    fs.writeFileSync(P.appPatch, fs.readFileSync(P.appPatch, "utf8").replace(/proxyBase: http:\/\/127\.0\.0\.1:3210\n/, ""))
    const r = runGuard(["--check"], app, dev)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("W1")
    expect(r.out).toContain("verdict=red")
  })

  test("判据 2b：删 App forge-model 的 proxyBase ⇒ 同样判红", () => {
    const { app, dev, P } = fixture()
    const s = fs.readFileSync(P.appPatch, "utf8")
    const last = s.lastIndexOf("proxyBase: http://127.0.0.1:3210")
    fs.writeFileSync(P.appPatch, s.slice(0, last) + s.slice(last).replace(/proxyBase: http:\/\/127\.0\.0\.1:3210\n/, ""))
    const r = runGuard(["--check"], app, dev)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("W1")
  })

  test("判据 3a：dev 加非注释回指 App ⇒ 红且点名 W2", () => {
    const { app, dev, P } = fixture()
    fs.writeFileSync(P.devPatch, fs.readFileSync(P.devPatch, "utf8") + "- id: bad\n  config:\n    proxyBase: http://127.0.0.1:19387\n")
    const r = runGuard(["--check"], app, dev)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("W2")
  })

  test("判据 3b 反向对照：只在注释里加回指 ⇒ 不判红（dev patch 18-20 行本就有）", () => {
    const { app, dev, P } = fixture()
    fs.writeFileSync(P.devPatch, fs.readFileSync(P.devPatch, "utf8") + "# 回滚说明：把 proxyBase 指回 19387\n")
    const r = runGuard(["--check"], app, dev)
    expect(r.code).toBe(0)
    expect(r.out).toContain("verdict=green")
  })

  test("判据 4a：App patch 缺失 ⇒ 红且点名 W4（判不了不当绿）", () => {
    const { app, dev, P } = fixture()
    fs.rmSync(P.appPatch)
    const r = runGuard(["--check"], app, dev)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("W4")
  })

  test("判据 4b：bundles 空壳 ⇒ 红且点名 W3", () => {
    const { app, dev, P } = fixture()
    fs.writeFileSync(P.appPkg, JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const r = runGuard(["--check"], app, dev)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("W3")
  })

  test("App proxyBase 指错方向（19387）⇒ 红", () => {
    const { app, dev, P } = fixture()
    fs.writeFileSync(P.appPatch, fs.readFileSync(P.appPatch, "utf8").replace(/:3210/g, ":19387"))
    expect(runGuard(["--check"], app, dev).code).not.toBe(0)
  })

  test("判据 5：--selftest 自身绿", () => {
    const r = runGuard(["--selftest"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/\d+\/\d+ 项通过/)
    expect(r.out).toContain("verdict=green")
  })

  // ISS-701 · 缺口 E：`read()` 原先吞异常返回 ''，「读不到」被当成「空文件」⇒ W2 无话可说、判绿。
  test("E 变异：dev patch 读不动（chmod 000）⇒ 红且点名 W4（判不了不许静默当绿）", () => {
    if (!process.getuid || process.getuid() === 0) return // root 下 000 仍可读，这条判不了
    const { app, dev, P } = fixture()
    fs.chmodSync(P.devPatch, 0o000)
    try {
      const r = runGuard(["--check"], app, dev)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain("W4")
      expect(r.out).toContain("读不动")
      expect(r.out).toContain("verdict=red")
    } finally {
      fs.chmodSync(P.devPatch, 0o644) // 收尾：让 afterEach 的 rmSync 干净收场
    }
  })
})
