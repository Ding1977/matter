#!/usr/bin/env node
// ── Tailwind 产物体检（2026-09-16，ISS-529 衍生工具）──────────────────────────────
//
// 为什么需要它：本项目多个包各自 build 一份 Tailwind 产物，运行时全部注入同一页面
// （实测 9 份）。一旦某个包的产物里出现**别人也在用的同名标准类**，就会按「同特异性后写者胜」
// 压掉对方的声明 —— 2026-09-16 的「模型 Tab 套餐页卡片恒全宽」就是这么来的
// （forge-ui 产物里的裸 `grid-cols-1` 压过 forge-model 的容器查询档）。
//
// 那份产物之所以含死类，根因是 `src/styles/tailwind.generated.ts`（上一轮产物的 CSS 快照，
// 躺在 src 下且未 gitignore）被 v4 自动扫描 → **自喂循环**：源码删掉的类被无限再生。
//
// 本工具回答四个问题（只读，不改任何文件；--probe 会临时置空 dump 但立即还原）：
//   ①【缺口】本包源码在用、本包产物却没有的类 —— 真类没生成（ISS-435 家族，会掉样式）
//   ②【可清】本包产物有、本包源码不用，但**使用方自家产物已自给** —— 清掉安全
//   ③【兜底】本包产物有、别的包源码在用，但**那个包的产物没有** —— 清掉会掉别人的样式，先修对方
//   ④【真死】全仓任何源码都不用 —— 纯历史化石，清掉安全
//
// 用法：
//   node scripts/tw-dead-classes.mjs                 # 全包体检
//   node scripts/tw-dead-classes.mjs forge-pm        # 指定包
//   node scripts/tw-dead-classes.mjs --probe         # 额外做 @source 体检（置空 dump 重编译对比）
//   node scripts/tw-dead-classes.mjs --json          # 机器可读

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PKGS = [
  "forge-ui",
  "forge-model",
  "forge-pm",
  "forge-browser",
  "forge-canvas",
  "forge-trader",
  "forge-agents",
  "forge-cad",
  "forge-codeguide",
  "forge-design",
  "forge-mermaid",
  "forge-model-limits",
  "forge-pm-notify",
  "forge-qoder-direct",
  "forge-shell",
  "forge-tailwind",
  "forge-window-chrome",
]

const args = process.argv.slice(2)
const PROBE = args.includes("--probe")
const JSONOUT = args.includes("--json")
const SAVE_BASELINE = args.includes("--baseline-save")
const COVERAGE = args.includes("--coverage")
const BASELINE = "/tmp/tw-union-baseline.json"   // 清理前的「全仓产物类名并集」基线（跨包覆盖保证的参照）
const only = args.filter((a) => !a.startsWith("--"))

// ── 工具：CSS 文本 → 类名集合 ────────────────────────────────────────────────
// 去转义（Tailwind 会把变体类写成 `.\@lg\:grid-cols-...`）后逐规则取「首个复合选择器」。
// ⚠️ 不能简单地按逗号/空白切：arbitrary 值里合法地含逗号与括号（`w-[min(400px,92%)]`），
//    按逗号切会得到 `w-[min(400px` 这种半截类名（2026-09-16 第一版就这么错的）。
//    正解 = 维护括号/方括号深度，只在**顶层**遇到 `,` `{` `>` 空格 时收尾。
// ⚠️ 别用正则字面量写「单反斜杠」——很容易写成 `/\\\\/g`（匹配两个反斜杠），转义去不掉会得到一屏假阳性。
const BS = String.fromCharCode(92)
function classesOf(cssText) {
  const set = new Set()
  const flat = cssText.split(BS).join("")
  for (const line of flat.split("\n")) {
    const t = line.trim()
    if (!t.startsWith(".")) continue
    let depth = 0, end = -1
    for (let i = 0; i < t.length; i++) {
      const ch = t[i]
      if (ch === "(" || ch === "[") depth++
      else if (ch === ")" || ch === "]") depth--
      else if (depth === 0 && (ch === "{" || ch === "," || ch === ">" || ch === " " || ch === "+" || ch === "~")) { end = i; break }
    }
    const sel = end === -1 ? t : t.slice(0, end)
    if (sel.length > 1) set.add(sel.slice(1))
  }
  return set
}

/** 裸类名（无变体/无 arbitrary 值）——只有这批会跨产物同名打架，才是清理决策的对象。 */
const isPlain = (c) => /^[a-z][a-z0-9-]*(\/[0-9.]+)?$/.test(c)

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")

// ── 工具：源码 → 该包「用到」的类候选 ───────────────────────────────────────
// v4 是从**文本**里提取候选（注释也算，见 ISS-381），所以这里也按文本抓：
// 先取所有引号字符串（含模板串），再按空白切词，最后**用「全仓产物类名并集」过滤**
// —— 只保留真实存在于某份产物里的词，非类名串（中文文案、size="md"、URL）自然被滤掉。
function filesUnder(dir) {
  const out = []
  const walk = (d) => {
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue
        walk(p)
      } else if (/\.(tsx?|css|html)$/.test(e.name) && !e.name.endsWith(".generated.ts")) {
        try { out.push(readFileSync(p, "utf8")) } catch {}
      }
    }
  }
  walk(dir)
  return out.join("\n")
}
function tokensInSource(text) {
  const toks = new Set()
  for (const m of text.matchAll(/["'`]([^"'`\n]{1,400})["'`]/g)) {
    for (const w of m[1].split(/\s+/)) if (w && !w.includes("${") && w.length < 200) toks.add(w)
  }
  return toks
}

// ── 本包的**有效扫描范围** = 自己的 src + tailwind-input.css 里 @source 声明的目标 ──────
// 为什么必须算上声明目标：像 forge-ui 会 `@source forge-design/src`（它要渲染那些 shadcn 组件），
// 于是 forge-design 里用到的类**本来就该出现在 forge-ui 产物里**。只拿"本包 src"判会把它们
// 误判成死类（2026-09-16 第一版就是这么把 111 个正常共享类算成"可清"的）。
function scanScopeText(pkgDir) {
  const parts = [filesUnder(join(pkgDir, "src"))]
  const inputPath = join(pkgDir, "src/styles/tailwind-input.css")
  if (!existsSync(inputPath)) return parts.join("\n")
  const css = readFileSync(inputPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  for (const m of css.matchAll(/^\s*@source\s+(?!not\b)"([^"]+)"/gm)) {
    const target = join(pkgDir, "src/styles", m[1])
    try { parts.push(statSync(target).isDirectory() ? filesUnder(target) : readFileSync(target, "utf8")) } catch {}
  }
  return parts.join("\n")
}

// ── 载入各包产物与源码 ──────────────────────────────────────────────────────
const prod = {}, prodRaw = {}, src = {}, scope = {}
for (const p of PKGS) {
  const cssPath = join(ROOT, p, "dist/tailwind.css")
  prodRaw[p] = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : ""
  prod[p] = classesOf(prodRaw[p])
  src[p] = filesUnder(join(ROOT, p, "src"))                 // 本包源码
  scope[p] = scanScopeText(join(ROOT, p))            // 本包源码 + 已声明 @source 目标
}
const union = new Set()
for (const p of PKGS) for (const c of prod[p]) union.add(c)

// ── 「真正注入页面」的产物清单（自动推导，不手写）──────────────────────────────
// 为什么必须区分：**产物存在 ≠ 产物上电**。forge-notify 就踩过 —— 它有完整的
// tailwind-input.css + tailwind.generated.ts + dist/tailwind.css，但构建不编译、client-entry
// 不注入 → 那份产物从未进页面（2026-09-16 接线前实测：线上 9 份样式表里没有它）。后果：它独有的
// 6 个类（弹层动画/居中/作用域 reset）在页面上永远是空的，而「所有产物并集」这种口径会**给它开绿灯**
// （文件在磁盘上存在），体检报平安。判据 = 该包 client-entry 同时有 `TAILWIND_CSS` 与 style 注入动作。
function injectedPackages() {
  const out = new Set()
  for (const p of PKGS) {
    const dir = join(ROOT, p, "src/dsh")
    let files = []
    try { files = readdirSync(dir).filter((f) => /^client-entry\.tsx?$/.test(f)) } catch { continue }
    for (const f of files) {
      const s = readFileSync(join(dir, f), "utf8")
      if (s.includes("TAILWIND_CSS") && /createElement\(\s*["']style["']\s*\)/.test(s)) out.add(p)
    }
  }
  return out
}
const INJECTED = injectedPackages()
/** 有效并集 = 只有**上了电**的产物才算提供者（体检与覆盖保证都以此为准）。 */
const liveUnion = new Set()
for (const p of INJECTED) for (const c of prod[p]) liveUnion.add(c)

// ── @source 体检：置空 dump 后重新编译，看产物掉了什么 ──────────────────────
function probeSource(p) {
  const dump = join(ROOT, p, "src/styles/tailwind.generated.ts")
  const input = join(ROOT, p, "src/styles/tailwind-input.css")
  const cli = join(ROOT, p, "node_modules/@tailwindcss/cli/dist/index.mjs")
  if (!existsSync(dump) || !existsSync(input) || !existsSync(cli)) return null
  const backup = readFileSync(dump, "utf8")
  const out = `/tmp/tw-probe-${p}.css`
  try {
    writeFileSync(dump, "export const TAILWIND_CSS: string = \"\"\n")
    execFileSync(process.execPath.split("/").slice(0, -1).concat("node").join("/") || "node",
      [cli, "-i", input, "-o", out, "--silent"], { cwd: join(ROOT, p), stdio: "ignore" })
    return classesOf(readFileSync(out, "utf8"))
  } catch (e) {
    return { error: String(e).slice(0, 120) }
  } finally {
    writeFileSync(dump, backup) // 无论成败都还原（绝不留下被置空的 dump）
  }
}

// ── 逐包体检 ────────────────────────────────────────────────────────────────
const report = []
for (const p of PKGS) {
  if (only.length && !only.includes(p)) continue
  const mine = prod[p]
  const mySrcToks = tokensInSource(src[p])
  const text = prodRaw[p].split(BS).join("")

  // ① 缺口：本包源码在用、且全仓产物并集里存在（说明是个真类）、但本包产物没有
  const missing = [...mySrcToks].filter((t) => union.has(t) && !mine.has(t)).sort()

  // ②③④ 本包产物里、本包源码「不用」的**裸类名**（变体/arbitrary 类名天然唯一，不会跨包打架）
  const unusedMine = []
  for (const c of mine) {
    if (!isPlain(c)) continue
    if (new RegExp("(^|[\\s\"'`(])" + esc(c) + "([\\s\"'`)]|$)").test(scope[p])) continue
    unusedMine.push(c)
  }
  const owners = {}, canClear = [], fallback = [],真死 = []
  for (const c of unusedMine) {
    const used = PKGS.filter((q) => q !== p && new RegExp("(^|[\\s\"'`(])" + esc(c) + "([\\s\"'`)]|$)").test(src[q]))
    if (!used.length) { 真死.push(c); continue }
    const selfSufficient = used.every((q) => prod[q].has(c) && INJECTED.has(q))
    owners[c] = used.join("+")
    ;(selfSufficient ? canClear : fallback).push(c)
  }
  const probe = PROBE ? probeSource(p) : null
  let probeInfo = null
  if (probe && !probe.error) {
    const dumped = [...mine].filter((c) => !probe.has(c))          // 靠 dump 供养的类
    // 关键判据：dump 供养的类里，有没有「本包源码真在用」的？有 = 本包 @source 已断（真类靠 dump 兜）。
    const realNeeded = dumped.filter((c) => mySrcToks.has(c))
    probeInfo = { 无dump时产物类数: probe.size, 依赖dump供养: dumped.length, 本包真在用却靠dump: realNeeded.length, 例: realNeeded.slice(0, 8) }
  } else if (probe?.error) probeInfo = { error: probe.error }

  report.push({ 包: p, 产物类数: mine.size, 本包源码用到但产物缺失: missing.length, 缺口语义例: missing.slice(0, 12),
    可清死类: canClear.length, 需先修对方: fallback.length, 全仓真死: 真死.length, 真死例: 真死.slice(0, 12), probe: probeInfo })
}

if (JSONOUT) { console.log(JSON.stringify(report, null, 2)); process.exit(0) }

// ── 基线保存 / 跨包覆盖保证 ────────────────────────────────────────────────
// 为什么要基线：产物在 dist/ 且不入库（gitignore），清理后**旧产物无法从 git 找回**，
// 所以必须在动手前把「全仓产物类名并集」存下来。之后每次清理都拿它做一次保证：
//   【基线并集 ∩ 全仓源码在用的候选】 ⊆ 【当前并集】
// 即：清理前任何人可能在用的类，清理后至少还有**某一份产物**提供它 → 不会出现"无人定义"的元素类。
// 这条比逐包看数字强：它防的是 forge-ui 那种假阴性——断链时被供养的是**别的包**的类
// （本包 src 里根本看不到），只看本包会误判为安全。
if (SAVE_BASELINE) {
  writeFileSync(BASELINE, JSON.stringify([...union].sort(), null, 0))
  console.log(`已保存基线：${BASELINE}（${union.size} 个类名，来自 ${PKGS.length} 份产物）`)
  process.exit(0)
}
if (COVERAGE) {
  if (!existsSync(BASELINE)) { console.error(`缺基线 ${BASELINE} —— 先跑 --baseline-save（必须在任何清理之前）`); process.exit(2) }
  const base = new Set(JSON.parse(readFileSync(BASELINE, "utf8")))
  // 全仓源码在用的候选（并集），再用基线过滤成"真实类名"（滤掉文案/size 之类的假 token）
  const allSrcToks = new Set()
  for (const p of PKGS) for (const t of tokensInSource(src[p])) if (base.has(t) && isPlain(t)) allSrcToks.add(t)
  const gaps = [...allSrcToks].filter((t) => !liveUnion.has(t)).sort()
  console.log(`跨包覆盖保证（只算**已注入**的 ${INJECTED.size} 份产物：${[...INJECTED].map((x) => x.replace("forge-", "")).join(" ")}）：基线 ${base.size} 类 · 全仓源码在用的裸类 ${allSrcToks.size} 个 · 当前有效并集 ${liveUnion.size}`)
  if (!gaps.length) console.log("  ✅ 无缺口：清理前可能被用到的类，清理后仍有产物提供")
  else { console.log(`  ❌ 缺口 ${gaps.length} 个（清理后无人定义，元素会掉样式）：`); console.log("     " + gaps.join(" ")) }
  process.exit(gaps.length ? 1 : 0)
}

for (const r of report) {
  console.log(`\n═══ ${r.包} ═══`)
  console.log(`  产物类数 ${r.产物类数} · 缺口(本包在用但产物缺) ${r.本包源码用到但产物缺失} · 可清死类 ${r.可清死类} · 兜底(需先修对方) ${r.需先修对方} · 全仓真死 ${r.全仓真死}`)
  if (r.缺口语义例.length) console.log(`   ① 缺口例: ${r.缺口语义例.join(" ")}`)
  if (r.真死例.length) console.log(`   ④ 真死例: ${r.真死例.join(" ")}`)
  if (r.probe) console.log(`   probe: ${r.probe.error ? "失败 " + r.probe.error : `无 dump 时产物类数 ${r.probe.无dump时产物类数}（依赖 dump 供养 ${r.probe.依赖dump供养}，其中【本包真在用却靠 dump】= ${r.probe.本包真在用却靠dump} ${r.probe.例?.length ? "例: " + r.probe.例.join(" ") : ""}）`}`)
}
