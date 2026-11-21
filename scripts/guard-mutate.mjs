#!/usr/bin/env node
// guard-mutate —— **守卫有牙**的通用自验工具（ISS-606 提速方案 B）。
//
// ## 为什么需要它
// 本项目连续多轮独立审查里，最高频的 blocker 是「**守卫看着有牙、实际钉不住**」
// （`docs/code.md` §7.1 K8b：「从没红过的守卫等于没有守卫」）。而验证"有牙"的规范动作
// —— **注入一处该抓的缺陷、确认它变红、再还原** —— 手工做一次要 30-90s，一轮审查
// 十几条变异就是 10-15 分钟。本脚本把这件事变成**一条命令**。
//
// ## 用法
//   node scripts/guard-mutate.mjs --spec <变异清单.json> [--dry-run]
//
// 清单格式（每项一条变异）：
//   {
//     "cwd": "forge-pm",                      // 相对仓库根；测试在这里跑
//     "test": "bun test lib/import-mode.test.js",   // 跑的测试命令（数组亦可）
//     "mutations": [
//       { "name": "realpath 不归一（非 .native）",
//         "file": "lib/agent-tools.js",
//         "from": "realpathSync.native(x)",
//         "to":   "realpathSync(x)" }
//     ]
//   }
//
// ## 判据（三项，缺一不可）
//   ① **基线必须绿** —— 未注入时测试通过，否则后面"红"没意义（可能是本来就红）
//   ② **注入必须红** —— 该守卫看不住这个缺陷 = 没牙 ⇒ 报 FAIL
//   ③ **还原必须干净** —— 逐字节还原并比对 md5（证明"红"是变异引起的、且没留下污染）。
//      （不重跑：md5 相同即源码与原状完全一致，重跑等价于基线那次，无额外信息。）
//
// ## 安全
//   · 每个变异**只改一个文件**，改前备份内容到内存，**无论成败都在 finally 里还原**
//   · 还原后比对 md5；不一致 ⇒ 明确报错（绝不静默留下脏树）
//   · `--dry-run` 只打印将要做的替换与命中次数，**不动文件**
//
// ⚠️ 本脚本**不替代独立审查** —— 它验的是"作者自己知道的守卫能否被自己想到的缺陷击穿"。
//   独立审查的价值在"作者想不到的形态"（本仓历次 blocker 多由审查员自创变异抓出）。
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")

/** 读 `--key value` 形式的参数。 */
function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const hasFlag = (n) => process.argv.includes(`--${n}`)

const md5 = (s) => createHash("md5").update(s).digest("hex")

/** 跑测试命令，返回 {ok, out}（不抛 —— 红是预期结果之一）。 */
function runTest(cwd, testCmd) {
  // ⚠️ 字符串要**按空白拆** —— 否则 `execFileSync("bun test x", [])` 会把整串当可执行文件名
  //   （实测症状：基线恒红且输出为空，极易误判成"测试真红"）。
  const parts = Array.isArray(testCmd) ? testCmd : String(testCmd).trim().split(/\s+/)
  try {
    const out = execFileSync(parts[0], parts.slice(1), {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
    })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` }
  }
}

const specPath = arg("spec")
if (!specPath) {
  console.error("用法：node scripts/guard-mutate.mjs --spec <变异清单.json> [--dry-run]")
  process.exit(2)
}
const spec = JSON.parse(readFileSync(resolve(REPO_ROOT, specPath), "utf8"))
const cwd = resolve(REPO_ROOT, spec.cwd || ".")
const testCmd = spec.test || "bun test"
const dry = hasFlag("dry-run")

const results = []
let anyFail = false

// ⚠️ **中断保护**（实测踩过）：Ctrl-C / 超时 / 被 kill 时，`finally` **不保证执行**
//   ⇒ 注入的改动会**留在源码里**（我实测残留过一行 `// 注入：…`，丢了原始代码）。
//   ⇒ 用全局记住"当前正在改的文件 + 原文"，`exit`/信号钩子里无条件还原。
let inFlight = null // { file, orig }
// ⚠️ **落盘备份**：`execFileSync` 是**阻塞**的 ⇒ 信号钩子在子进程跑完前**执行不了**
//   （审查实测：`kill <pid>` / `kill -9` 时源码**残留注入**）。
//   故把原文**同时写一份到临时文件**；下次启动时若发现残留备份 ⇒ 先还原再干活。
const JOURNAL = join(REPO_ROOT, ".guard-mutate.journal.json")
function writeJournal(file, orig) {
  try { writeFileSync(JOURNAL, JSON.stringify({ file, orig })) } catch { /* 尽力而为 */ }
}
function clearJournal() {
  try { rmSync(JOURNAL, { force: true }) } catch { /* 尽力而为 */ }
}
/** 启动自愈：上次若被强杀留下注入 ⇒ 用 journal 还原。 */
function recoverFromJournal() {
  try {
    if (!existsSync(JOURNAL)) return
    const j = JSON.parse(readFileSync(JOURNAL, "utf8"))
    if (j && j.file && typeof j.orig === "string") {
      writeFileSync(j.file, j.orig)
      console.error(`⚠️  检测到上次中断残留，已自动还原：${j.file}`)
    }
    clearJournal()
  } catch { /* 尽力而为 */ }
}
recoverFromJournal()
function restoreInFlight() {
  if (!inFlight) return
  try {
    writeFileSync(inFlight.file, inFlight.orig)
    console.error(`\n⚠️  已从中断中还原：${inFlight.file}`)
  } catch { /* 尽力而为 */ }
  inFlight = null
}
process.on("exit", restoreInFlight)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { restoreInFlight(); process.exit(130) })
}

// ① 基线
const base = runTest(cwd, testCmd)
const baseOk = base.ok
console.log(`\n① 基线（未注入）：${baseOk ? "✅ 绿" : "❌ 红"}`)
if (!baseOk) {
  console.log("   ⚠️ 基线不绿 ⇒ 后续「红」无法归因于注入。请先修好基线。")
  console.log("--- 输出 ---"); console.log(base.out.split("\n").slice(-15).join("\n"))
  process.exit(1)
}

for (const m of spec.mutations || []) {
  const file = resolve(cwd, m.file)
  const orig = readFileSync(file, "utf8")
  const hits = orig.split(m.from).length - 1
  const label = m.name || `${m.file}: ${String(m.from).slice(0, 40)}`

  if (dry) {
    console.log(`\n[dry] ${label}\n  命中 ${hits} 处（应 = 1；>1 需在 from/to 里带足上下文）`)
    continue
  }
  if (hits !== 1) {
    results.push({ label, verdict: "SKIP", why: `from 命中 ${hits} 处（须恰好 1 处）` })
    anyFail = true
    continue
  }

  let verdict, why = ""
  try {
    inFlight = { file, orig } // 中断保护（内存 + 落盘双保险）
    writeJournal(file, orig)
    writeFileSync(file, orig.replace(m.from, m.to))
    const r = runTest(cwd, testCmd)
    if (r.ok) {
      verdict = "FAIL"
      why = "注入后仍全绿 ⇒ **守卫没牙**（该缺陷它看不住）"
    } else {
      verdict = "PASS"
      why = "注入后变红 ✅"
    }
  } finally {
    // ② 无条件还原 + 逐字节校验
    writeFileSync(file, orig)
    inFlight = null
    clearJournal()
    const back = readFileSync(file, "utf8")
    if (md5(back) !== md5(orig)) {
      verdict = "ERROR"
      why = "★ 还原后 md5 不一致（工作树可能残留污染）"
      anyFail = true
    }
  }
  if (verdict === "FAIL") anyFail = true
  results.push({ label, verdict, why })
  const icon = verdict === "PASS" ? "✅" : verdict === "FAIL" ? "❌" : "⚠️"
  console.log(`\n${icon} ${label}\n   ${verdict} — ${why}`)
}

// ⚠️ **空清单 ≠ 全绿**（审查发现）：`mutations: []` 或键名写错时，旧实现报
//   「有牙 0/0 ✅」并 exit 0 —— 与"守卫有牙"的主题正好相反（**真空通过**）。
// ⚠️ `--dry-run` 本就不收集 results（只打印命中）⇒ 不能拿"空 results"当错误
if (results.length === 0 && !dry) {
  console.error("\n❌ 清单里没有任何变异 ⇒ **不判**（空清单不等于「全部有牙」）；请检查 --spec 文件")
  process.exit(2)
}

console.log("\n── 汇总 ──")
for (const r of results) console.log(`  ${r.verdict.padEnd(6)} ${r.label}`)
const passed = results.filter((r) => r.verdict === "PASS").length
console.log(`\n有牙 ${passed}/${results.length}；${anyFail ? "❌ 存在没牙的守卫" : "✅ 全部有牙"}`)
process.exit(anyFail ? 1 : 0)
