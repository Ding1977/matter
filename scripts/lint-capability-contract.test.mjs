#!/usr/bin/env node
// scripts/lint-capability-contract.test.mjs
// 能力契约门禁（ISS-681）自己的**变异验证**：证明判据不是恒绿的摆设。
//
// 为什么单独成文件、为什么跑真子进程：
//   本仓最高频的审查 blocker 是「守卫看着有牙、实际钉不住」（`docs/code.md` §7.1 K8b：
//   从没红过的守卫等于没有守卫）。而 `--selftest` 验的是**纯函数**那一层
//   （`judgeCapabilities` 的正反例）；它证不到「探针真的从适配器里读到了东西」——
//   如果 `probeAdapter` 因为夹具形状漂移而永远读到 `undefined`，纯函数那层照样全绿。
//   所以这里做**端到端两层**验证：
//     ① 对**真仓**跑一次 `--check`：必须读到 4 个适配器包、零 unjudged
//        （读不到 ⇒ 探针坏了，这条当场红 —— 比"输出里有个 ✓"强得多）；
//     ② 在**临时副本**里注入违规，跑真 CLI：必须 exit 1 且点名那条。
//        副本而不是原地改，是为了不污染工作树（本仓有并发会话共用文件系统）。
//
// 用法：bun test scripts/lint-capability-contract.test.mjs --isolate
//      （也接在 guard-baselines 的 --selftest 里，见该文件的 selfcheck 行）
import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const GUARD = path.join(ROOT, "scripts", "lint-capability-contract.mjs")
const BASELINE = path.join(ROOT, "scripts", "baseline", "capability-contract.json")

/** 跑守卫，返回 {code, out}（红是预期结果之一，不抛）。 */
function runGuard(args = ["--check"], root = ROOT) {
  const cmd = ["node", GUARD, ...args]
  if (root !== ROOT) cmd.push("--root", root)
  try {
    return { code: 0, out: execFileSync(cmd[0], cmd.slice(1), { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }) }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : -1, out: `${e.stdout || ""}${e.stderr || ""}` }
  }
}

/** 真仓当前状态（读一次，多条用例共用 —— 每条都重扫 1200 个文件没必要）。 */
const REAL = runGuard(["--json"])

/** 登记表里的四个包 —— 临时树必须**四个都在**：缺一个就成了 unjudged，
 *  那会把"探不了"混进"有违规"，用例就分不清红是哪来的。 */
const PKGS = ["forge-trae-direct", "forge-workbuddy-direct", "forge-qoder-direct", "forge-cli-provider"]

/**
 * 造一棵**可探**的临时树：四个包全拷（lib 是**复制**不是软链 —— 软链会让注入写回真仓，那是事故），
 * 依赖靠**软链**借用真仓的 node_modules（本仓不 hoist，第三方在各包自己的 node_modules 里）。
 * 基线默认取真仓那份 ⇒ 树在"未注入"状态下的结论与真仓一致（= 只欠着 C2 两条）。
 */
function makeTree({ baseline } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capcheck-"))
  fs.mkdirSync(path.join(dir, "scripts", "baseline"), { recursive: true })
  fs.copyFileSync(GUARD, path.join(dir, "scripts", "lint-capability-contract.mjs"))
  for (const pkg of PKGS) {
    const dst = path.join(dir, pkg)
    fs.mkdirSync(dst, { recursive: true })
    fs.cpSync(path.join(ROOT, pkg, "lib"), path.join(dst, "lib"), { recursive: true })
    fs.copyFileSync(path.join(ROOT, pkg, "package.json"), path.join(dst, "package.json"))
    // 依赖借用：软链真仓同名目录（探针会 import `forge-service-kit` 这类 workspace 依赖）
    const nm = path.join(ROOT, pkg, "node_modules")
    if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(dst, "node_modules"), "dir")
  }
  const base = baseline === undefined ? fs.readFileSync(BASELINE, "utf8") : JSON.stringify(baseline, null, 1)
  fs.writeFileSync(path.join(dir, "scripts", "baseline", "capability-contract.json"), base)
  return dir
}

/** 改一处源码（断言命中数 = 1，避免"改了但没改对"悄悄变成假绿）。 */
function patch(file, from, to) {
  const src = fs.readFileSync(file, "utf8")
  const n = src.split(from).length - 1
  expect(`命中 ${n} 处：${from.slice(0, 50)}`).toBe("命中 1 处：" + from.slice(0, 50))
  fs.writeFileSync(file, src.replace(from, to))
}

describe("能力契约门禁 · 真仓现状", () => {
  test("① 探针在真仓读得到东西（5 个适配器包 · unjudged 只许是登记过的结构不适用项）", () => {
    const r = JSON.parse(REAL.out)
    expect(r.registered).toEqual([
      "forge-cli-provider",
      "forge-qoder-direct",
      "forge-router-direct",
      "forge-trae-direct",
      "forge-workbuddy-direct",
    ])
    /* unjudged 分两类，**不许混为一谈**（ISS-681 C0 补登记时拆开，2026-11-04）：
     *   a) 「探针坏了」：夹具/签名漂移导致探不了 ⇒ **判据整体失效**，必须为 0。
     *   b) 「结构不适用」：虚拟 provider 没有 resolveModel/listMapper ⇒ 本来就不该被这个探针覆盖，
     *      登记在 `probeUnsupported` 里，附原因。
     * ⇒ 断言从「unjudged 必须为 0」改成「每个 unjudged 都必须带 `probeUnsupported` 标记」：
     *    a 类没有那个标记 ⇒ 照样红（保住原来的牙）；b 类被显式登记 ⇒ 允许。
     * 原来的「必须为 0」在加上 router 之后无法成立，但**不能靠删断言了事** ——
     * 那样 a 类（真 · 探针坏了）就再也没人拦了。 */
    expect(r.unjudged.every((u) => /虚拟 provider|探针结构不适用/.test(u.reason))).toBe(true)
    // 扫描面不能塌缩（1200 量级；塌缩会被脚本自己 exit 2 拦住，这里再钉一层）
    expect(r.scanned).toBeGreaterThan(500)
  })

  test("② 已修的两家**零违规**（workbuddy 显式 text、trae 声明与实际一致）", () => {
    const r = JSON.parse(REAL.out)
    const bad = r.offenders.filter((o) => o.pkg === "forge-trae-direct" || o.pkg === "forge-workbuddy-direct")
    expect(bad).toEqual([])
  })

  test("③ 存量基线与实况同口径（基线里每条都还真的在欠着，没有化石）", () => {
    const r = JSON.parse(REAL.out)
    const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"))
    const live = new Set(r.offenders.map((o) => `${o.rule}|${o.pkg}`))
    for (const o of base.offenders) {
      expect(`${o.rule}|${o.pkg} 仍欠着`).toBe(live.has(`${o.rule}|${o.pkg}`) ? `${o.rule}|${o.pkg} 仍欠着` : `${o.rule}|${o.pkg} 已成化石，该从基线删掉`)
    }
  })
})

describe("能力契约门禁 · 注入必须红（在临时副本里做，不碰工作树）", () => {
  test("④ C1：声明 image 但本包发不出图 ⇒ exit 1 且点名该包", () => {
    const dir = makeTree()
    try {
      // 注入：拿上游 supportsImages 当自己的能力声明（**正是本单要治的那个错**）
      patch(
        path.join(dir, "forge-workbuddy-direct", "lib", "adapter.js"),
        'const out = { provider, id, name, inputModalities: ["text"] }',
        'const out = { provider, id, name, inputModalities: entry?.supportsImages === true ? ["text", "image"] : ["text"] }',
      )
      const r = runGuard(["--check"], dir)
      expect(r.code).toBe(1)
      expect(r.out).toContain("+ C1 forge-workbuddy-direct")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("⑤ C2：不写 inputModalities（= undefined = 引擎放行）⇒ exit 1 且点名该包", () => {
    const dir = makeTree()
    try {
      patch(
        path.join(dir, "forge-workbuddy-direct", "lib", "adapter.js"),
        'const out = { provider, id, name, inputModalities: ["text"] }',
        "const out = { provider, id, name }",
      )
      const r = runGuard(["--check"], dir)
      expect(r.code).toBe(1)
      expect(r.out).toContain("+ C2 forge-workbuddy-direct")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("⑥ 基线**不许**吞掉新违规：同一个包修好后又在另一条规则上违规，仍要红", () => {
    const dir = makeTree({ baseline: { offenders: [{ rule: "C1", pkg: "forge-workbuddy-direct", detail: "存量" }], unjudged: [], adapters: [] } })
    try {
      // 基线里登记的是 C1，这里造的是 **C2** ⇒ 键含规则号 ⇒ 不许被同包的旧账对冲成绿
      patch(
        path.join(dir, "forge-workbuddy-direct", "lib", "adapter.js"),
        'const out = { provider, id, name, inputModalities: ["text"] }',
        "const out = { provider, id, name }",
      )
      const r = runGuard(["--check"], dir)
      expect(r.code).toBe(1)
      expect(r.out).toContain("+ C2 forge-workbuddy-direct")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("⑦ C0：表外的新适配器包必须被点名（射程有牙，不靠人记得加表）", () => {
    const dir = makeTree()
    try {
      // 造一个"新适配器包"：真调 registerAdapter，但没进登记表
      fs.mkdirSync(path.join(dir, "forge-newdirect", "lib"), { recursive: true })
      fs.writeFileSync(path.join(dir, "forge-newdirect", "package.json"), JSON.stringify({ name: "forge-newdirect", type: "module" }))
      fs.writeFileSync(path.join(dir, "forge-newdirect", "lib", "index.js"), "export function apply(ctx) { ctx.llm.registerAdapter(['x'], {}) }\n")
      const r = runGuard(["--check"], dir)
      expect(r.code).toBe(1)
      expect(r.out).toContain("+ C0 forge-newdirect")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("⑧ 修好后必须绿（同一个临时树，注入→还原→再跑 ⇒ exit 0）", () => {
    const dir = makeTree()
    try {
      const f = path.join(dir, "forge-workbuddy-direct", "lib", "adapter.js")
      const orig = fs.readFileSync(f, "utf8")
      fs.writeFileSync(f, orig.replace('const out = { provider, id, name, inputModalities: ["text"] }', "const out = { provider, id, name }"))
      expect(runGuard(["--check"], dir).code).toBe(1) // 注入 ⇒ 红
      fs.writeFileSync(f, orig)
      const ok = runGuard(["--check"], dir)
      expect(ok.code).toBe(0) // 还原 ⇒ 绿（证明"红"是注入引起的，不是环境本来就红）
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("⑨ unjudged 不许冒充绿：探不了的包比基线多 ⇒ 红", () => {
    const dir = makeTree()
    try {
      // 把映射器改坏 ⇒ 探针 import 得到但取不到函数 ⇒ 整包判不了
      patch(path.join(dir, "forge-workbuddy-direct", "lib", "adapter.js"), "export function toModelInfo(", "export function toModelInfoRenamed(")
      const r = runGuard(["--check"], dir)
      expect(r.code).toBe(1)
      expect(r.out).toContain("判不了")
      expect(r.out).toContain("forge-workbuddy-direct")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("⑩ 扫描面塌缩 ⇒ exit 2 且拒绝报绿（空树不许读成「零违例」）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capcheck-empty-"))
    try {
      fs.mkdirSync(path.join(dir, "scripts"), { recursive: true })
      fs.copyFileSync(GUARD, path.join(dir, "scripts", "lint-capability-contract.mjs"))
      const r = runGuard(["--check"], dir)
      expect(r.code).toBe(2)
      expect(r.out).toContain("扫描面塌缩")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})
