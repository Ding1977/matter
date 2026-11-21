#!/usr/bin/env node
// scripts/lint-layer.test.mjs
// 分层契约门禁（ISS-697）的**端到端变异验证**：证明判据不是恒绿的摆设。
//
// 为什么单独成文件：`lint-layer.mjs --selftest` 验的是纯函数那一层（fixture 上的正反例），
// 它证不到「真 CLI 在真仓 / 临时副本里真的读到了东西」。本测试跑真子进程：
//   ① 真仓必须绿（读不到 ⇒ 扫描器坏了，当场红，比输出里有个 ✓ 强得多）；
//   ② 注入未登记违规 ⇒ 必须红且点名文件与方向；
//   ③ 反向对照：注释/模板串里的假 import 不许判红（首版正则在这踩过 5 条误伤）；
//   ④ 删 waiver / 修好代码却不摘 waiver 两种化石形态都要红；
//   ⑤ P1 子路径层号：合法原语不红、守卫（exports 必须真实存在）能红；
//   ⑥ --selftest 自身绿；
//   ⑦ ISS-701 四个射程缺口：A 接线（摘规则 / 降 level / 换空 check 必须红）、B 扫描面由
//      契约定（electron-shell 注入 L1→L4 必须红）、C 层表键 = 包名、D waiver 收到边级。
// 副本而不是原地改：本仓有并发会话共用文件系统，原地注入会污染他人工作树。
//
// 用法：bun test scripts/lint-layer.test.mjs --isolate
import { describe, expect, test, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const GUARD = path.join(ROOT, "scripts", "lint-layer.mjs")
const CONTRACT = path.join(ROOT, "scripts", "baseline", "layer-contract.json")

const made = []
afterEach(() => {
  for (const d of made.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }
})

/** 跑真 CLI，红是预期结果之一，不抛。 */
function runGuard(args = ["--check"], root = ROOT) {
  try {
    return { code: 0, out: execFileSync("node", [GUARD, ...args, "--root", root], { encoding: "utf8", maxBuffer: 16 << 20 }) }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : -1, out: `${e.stdout || ""}${e.stderr || ""}` }
  }
}

/**
 * 造最小副本：scripts/baseline/layer-contract.json + 所有 waiver 指向的文件（原样复制）
 * + 被登记子路径所属包的 package.json（LAYER-SUBPATH 守卫要读它的 exports）
 * + 层表里每个包的最小目录与 package.json（ISS-700 LAYER-PHANTOM 守卫要读它）。
 * 原样复制是必须的 —— 少一个文件会触发 gone、内容改了会触发 stale，
 * 两种情况都会把「注入的那条违规」混进别的红里，用例就分不清红是哪来的。
 * 层表 stub 同理：副本里没有真实包目录，幽灵守卫会把整张层表判红，
 * 那时「绿」的用例再也不可能绿 —— 所以先铺 stub，再让真实文件覆盖同名项（如 forge-mermaid/package.json）。
 * 脚本本体仍跑真仓那份（DEFAULT_ROOT 指向真仓 ⇒ typescript AST 解析器找得到）。
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-layer-fixture-"))
  made.push(dir)
  const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"))
  const baseline = path.join(dir, "scripts", "baseline", "layer-contract.json")
  fs.mkdirSync(path.dirname(baseline), { recursive: true })
  fs.writeFileSync(baseline, JSON.stringify(contract, null, 2))
  for (const pkg of Object.keys(contract.layers || {})) {
    const manifest = path.join(dir, pkg, "package.json")
    fs.mkdirSync(path.dirname(manifest), { recursive: true })
    fs.writeFileSync(manifest, JSON.stringify({ name: pkg }))
  }
  const files = new Set()
  for (const list of Object.values(contract.waivers)) for (const w of list) files.add(w.file)
  for (const spec of Object.keys(contract.subpathLayers || {})) files.add(`${spec.split('/')[0]}/package.json`)
  for (const rel of files) {
    const dst = path.join(dir, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(path.join(ROOT, rel), dst)
  }
  return { dir, contract, baseline }
}

function writeInto(dir, rel, text) {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}

/**
 * ISS-701 · 缺口 A：**接线**写错必须红。
 * 做法 = 把门禁脚本复制到临时树、用 fn 改一处、跑真 `--selftest` 看退出码。
 * 为什么用副本而不是在原地改：本仓有并发会话共用文件系统（同上面 fixture 的理由）。
 * 为什么副本里要补一份 typescript：脚本的 DEFAULT_ROOT 跟着自己走，解析器找不到时
 * LAYER-AST 会以「抛错」的形式红 —— 那种红不是我们要证的（假红），所以先把解析器备齐。
 * fn 必须真的改到文本（返回值不等于原文），否则用例空转 —— 那比没有用例更坏。
 */
function mutateSelftest(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-layer-mutant-"))
  made.push(dir)
  const src = fs.readFileSync(GUARD, "utf8")
  const next = fn(src)
  expect(typeof next).toBe("string")
  expect(next).not.toBe(src)
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true })
  fs.writeFileSync(path.join(dir, "scripts", "lint-layer.mjs"), next)
  fs.copyFileSync(path.join(ROOT, "scripts", "lint-common.mjs"), path.join(dir, "scripts", "lint-common.mjs"))
  fs.mkdirSync(path.join(dir, "forge-ui"), { recursive: true })
  fs.symlinkSync(path.join(ROOT, "forge-ui", "node_modules"), path.join(dir, "forge-ui", "node_modules"), "dir")
  try {
    return { code: 0, out: execFileSync("node", [path.join(dir, "scripts", "lint-layer.mjs"), "--selftest"], { encoding: "utf8", maxBuffer: 16 << 20 }) }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : -1, out: `${e.stdout || ""}${e.stderr || ""}` }
  }
}

describe("分层契约门禁（ISS-697 P0 + P1）", () => {
  // ⚠️ 真仓用例必须显式放宽超时：1300+ 文件的 TS AST 全量扫描实测 5~6s，
  // bun 默认 5s ⇒ 在慢机 / 冷缓存上会以「超时」而不是「判断错」变红（假红最误导人）。
  test("判据 1：真仓当前绿，且显式输出 verdict=green", () => {
    const r = runGuard(["--check"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("verdict=green")
  }, 30_000)

  test("判据 5 / 覆盖完整性：真仓无 findings、无 errored、扫描面 > 1000 文件", () => {
    const r = runGuard(["--json"])
    expect(r.code).toBe(0)
    const d = JSON.parse(r.out)
    expect(d.findings.length).toBe(0)
    expect(d.errored.length).toBe(0)
    expect(d.scanned).toBeGreaterThan(1000)
  }, 30_000)

  test("判据 2：注入一条未登记的 L3→L4 ⇒ 红且点名文件与方向", () => {
    const { dir } = fixture()
    writeInto(dir, "forge-pm/src/__layer_inject.ts", 'import { X } from "forge-trader/panel"\n')
    const r = runGuard(["--check"], dir)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("__layer_inject.ts")
    expect(r.out).toContain("L3→L4")
    expect(r.out).toContain("verdict=red")
  })

  test("反向对照：注释与模板字符串里的假 import 不判红", () => {
    const { dir } = fixture()
    writeInto(dir, "forge-pm/src/__layer_comment.ts",
      '// import { MermaidBlock } from "forge-mermaid/mermaid-block"\n' +
      'const s = `require("forge-mermaid/mermaid-block")`\n' +
      '/* from "forge-mermaid/mermaid-block" */\n')
    const r = runGuard(["--check"], dir)
    expect(r.code).toBe(0)
    expect(r.out).toContain("verdict=green")
  })

  test("P1 正向对照：借已登记的 L1 子路径原语不判红", () => {
    const { dir } = fixture()
    writeInto(dir, "forge-pm/src/__layer_primitive.ts", 'import { MermaidBlock } from "forge-mermaid/mermaid-block"\n')
    const r = runGuard(["--check"], dir)
    expect(r.code).toBe(0)
    expect(r.out).toContain("verdict=green")
  })

  test("P1 守卫有牙：登记 exports 里不存在的子路径 ⇒ 判红", () => {
    const { dir, contract, baseline } = fixture()
    contract.subpathLayers = { "forge-mermaid/nope": 1 }
    fs.writeFileSync(baseline, JSON.stringify(contract, null, 2))
    const r = runGuard(["--check"], dir)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("LAYER-SUBPATH")
  })

  test("ISS-700 变异：层表登记不存在的包 ⇒ LAYER-PHANTOM 判红并点名", () => {
    const { dir, contract, baseline } = fixture()
    contract.layers["forge-nonexistent-pkg"] = 1
    fs.writeFileSync(baseline, JSON.stringify(contract, null, 2))
    const r = runGuard(["--check"], dir)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("LAYER-PHANTOM")
    expect(r.out).toContain("forge-nonexistent-pkg")
    expect(r.out).toContain("verdict=red")
  })

  test("ISS-700 反向对照：副本里层表每个包都有真实目录 ⇒ 不出现 LAYER-PHANTOM", () => {
    const r = runGuard(["--check"], fixture().dir)
    expect(r.code).toBe(0)
    expect(r.out).not.toContain("LAYER-PHANTOM")
    expect(r.out).toContain("verdict=green")
  })

  test("判据 3a：删掉一条已登记欠账 ⇒ 违规重新暴露，判红", () => {
    const { dir, contract, baseline } = fixture()
    contract.waivers["LAYER-SAME"] = contract.waivers["LAYER-SAME"].filter((w) => w.file !== "forge-ui/lib/browser-bridge.js")
    fs.writeFileSync(baseline, JSON.stringify(contract, null, 2))
    const r = runGuard(["--check"], dir)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("browser-bridge.js")
    expect(r.out).toContain("verdict=red")
  })

  test("判据 3b：代码修好却不摘 waiver ⇒ 基线化石报红", () => {
    const { dir } = fixture()
    const p = path.join(dir, "forge-ui/lib/browser-bridge.js")
    fs.writeFileSync(p, "// P1 收口：跨包依赖已移除\n")
    const r = runGuard(["--check"], dir)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("白名单已失效")
  })

  test("判据 4：--selftest 自身绿（该红能红、不该红的不红）", () => {
    const r = runGuard(["--selftest"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/\d+\/\d+ 项通过/)
    // ISS-701：条数不许缩水（缺口 A 那 4 条是「接线可测」的落点，摘掉就等于退回原来的盲区）
    expect(r.out).toContain("26/26 项通过")
    expect(r.out).toContain("verdict=green")
  })

  /* ── ISS-701 · 缺口 A：规则接线必须能被 selftest 测到 ────────────────── */
  test("A0 反向控制：未改判据的副本 --selftest 仍绿（否则下面三条「变异即红」是假红）", () => {
    const r = mutateSelftest((s) => s.replace("#!/usr/bin/env node", "#!/usr/bin/env node\n// 对照：判据未改动"))
    expect(r.code).toBe(0)
    expect(r.out).toContain("verdict=green")
  })

  test("A1 变异：从 rules 数组摘掉 LAYER-UNJUDGED ⇒ --selftest 必须非 0", () => {
    const r = mutateSelftest((s) => s.replace(/^[ \t]*\{ id: 'LAYER-UNJUDGED'.*\n/m, ""))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("verdict=red")
  })

  test("A2 变异：把某条 level: 'block' 改成 'warn' ⇒ --selftest 必须非 0", () => {
    const r = mutateSelftest((s) => s.replace("{ id: 'LAYER-PHANTOM', level: 'block'", "{ id: 'LAYER-PHANTOM', level: 'warn'"))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("verdict=red")
  })

  test("A3 变异：把 LAYER-AST 的 check 改成 () => [] ⇒ --selftest 必须非 0", () => {
    const r = mutateSelftest((s) => s.replace(/check: \(\) => \{ if \(!ts\) throw[^\n]*?return \[\] \}/, "check: () => []"))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("verdict=red")
  })

  /* ── ISS-701 · 缺口 B：扫描面由契约定，不由前缀定 ───────────────────── */
  test("B 变异：electron-shell（L1）里 require(\"forge-trader/lib\") ⇒ 判红且点名 L1→L4", () => {
    const { dir } = fixture()
    writeInto(dir, "electron-shell/main.js", 'const _t = require("forge-trader/lib")\n')
    const r = runGuard(["--check"], dir)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("electron-shell")
    expect(r.out).toContain("L1→L4")
    expect(r.out).toContain("verdict=red")
  })

  test("B 反向对照：electron-shell 只 import electron / node:* / 相对路径 ⇒ 不判红", () => {
    const { dir } = fixture()
    writeInto(dir, "electron-shell/main.js", 'const { app } = require("electron")\nconst fs = require("node:fs")\nconst p = require("./preload")\n')
    const r = runGuard(["--check"], dir)
    expect(r.code).toBe(0)
    expect(r.out).toContain("verdict=green")
  })

  /* ── ISS-701 · 缺口 C：层表键 = 包名 ─────────────────────────────────── */
  test("C 变异：层表登记 vscode-dsh-models（目录名 ≠ package.json 的 name）⇒ LAYER-PHANTOM 判红", () => {
    const { dir, contract, baseline } = fixture()
    contract.layers["vscode-dsh-models"] = 1
    fs.writeFileSync(baseline, JSON.stringify(contract, null, 2))
    // 本仓的真实形态：目录叫 vscode-dsh-models，package.json 的 name 是 forge-dsh-models
    writeInto(dir, "vscode-dsh-models/package.json", JSON.stringify({ name: "forge-dsh-models" }))
    const r = runGuard(["--check"], dir)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("LAYER-PHANTOM")
    expect(r.out).toContain("vscode-dsh-models")
    expect(r.out).toContain("forge-dsh-models")
  })

  /* ── ISS-701 · 缺口 D：waiver 从文件级收到边级 ──────────────────────── */
  test("D 变异：已豁免文件里新增一条未登记的同层边 ⇒ 判红；补进 waiver 带 match ⇒ 转绿", () => {
    const { dir, contract, baseline } = fixture()
    const p = path.join(dir, "forge-model/lib/store/bridge.js")
    fs.writeFileSync(p, 'import __m from "forge-messenger/lib"\nexport const __probe = __m\n\n' + fs.readFileSync(p, "utf8"))
    const red = runGuard(["--check"], dir)
    expect(red.code).not.toBe(0)
    expect(red.out).toContain("bridge.js")
    expect(red.out).toContain("forge-messenger")
    expect(red.out).toContain("verdict=red")
    // 登记进 waiver（带 match）⇒ 转绿：证明离谱的不是「文件被豁免过」，而是「这条边没登记」
    contract.waivers["LAYER-SAME"].push({ file: "forge-model/lib/store/bridge.js", match: "→ forge-messenger", reason: "测试：临时登记这条边" })
    fs.writeFileSync(baseline, JSON.stringify(contract, null, 2))
    const green = runGuard(["--check"], dir)
    expect(green.code).toBe(0)
    expect(green.out).toContain("verdict=green")
  })

  test("D 反向控制：已登记的边仍在豁免内（14 条 match 都写对了）⇒ 真仓绿", () => {
    const r = runGuard(["--check"])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain("白名单已失效")
  }, 30_000)
})
