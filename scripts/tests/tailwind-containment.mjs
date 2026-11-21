#!/usr/bin/env node
// 合并构建的**包含性守卫**（ISS-680 步骤②）。
//
// 背景：步骤②把「各包各自编译工具类」改成「forge-ui 的**合并构建**统一产出」，
//   各包输入只留 token 变量与局部 reset。风险是**静默掉样式**：合并构建的扫描范围或
//   theme key 少了一块，某些类就不会生成 —— 页面局部没样式、零报错、零日志。
//
// 判据：对每个包 P，把 P 自己的输入加上 utilities（= 它改前的产物口径）编译一遍，
//   得到「P 自己会生成的全部类名」；其中**真正被源码用到**的那些必须都在合并产物里（超集关系）。
//
// ⚠️ 为什么还要「被源码用到」这一层过滤（2026-09-21 实测教训）：
//   各包的产物里混着大量**幻影类** —— 它们不是任何源码写的，而是 Tailwind 扫到了
//   **上一轮产物的 CSS 文本**（`src/styles/tailwind.generated.ts` 不是 gitignore 的）再生成出来的
//   （forge-ui 输入里那段注释记过这个「自喂循环」）。实测：`.mx-4` `.my-6` `.diagonal-fractions`
//   `.h-84` 等在源码里出现 **0 次**。拿旧产物当基准会把这些幻影全判成缺口（假红），
//   而合并构建不再产出它们**本来就是对的**（少发死 CSS）。
//
// 跑法：node scripts/tests/tailwind-containment.mjs        （退出码 1 = 有真缺口）
// 为什么放 scripts/tests 而不是单测套件：它要真跑 8 次 Tailwind 编译（秒级），不该拖慢 bun test。
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const MERGED = "forge-ui" // 承担合并构建的那个包
const TMP = mkdtempSync(join(tmpdir(), "tw-cont-"))
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ } })

/** 递归收集某包「源码文本」（排除产物/测试）：用于判定一个类名是否真的被用到。 */
function sourceText(pkg) {
  const roots = [join(REPO, pkg, "src")]
  const skip = /(tailwind\.generated\.ts|\.test\.|node_modules|\/dist\/)/
  let acc = ""
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const full = join(dir, e)
      if (skip.test(full)) continue
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (/\.(tsx?|jsx?|mjs|html|css)$/.test(e)) { try { acc += readFileSync(full, "utf8") } catch { /* 忽略 */ } }
    }
  }
  for (const r of roots) walk(r)
  return acc
}


/** 找一份可用的 tailwindcss CLI（各包共用；缺的包不影响本守卫）。 */
function findCli() {
  for (const p of ["forge-ui", "forge-pm", "forge-model", "forge-canvas", "forge-browser"]) {
    const cli = join(REPO, p, "node_modules", ".bin", "tailwindcss")
    if (existsSync(cli)) return cli
  }
  throw new Error("找不到 tailwindcss CLI（任装一个包即可）")
}

/** 类名集合：从编译产物里抽 `.xxx` 形态的选择器 token。
 *  ⚠️ 必须**包含转义字符**（`\[` `\]` `\/`）——任意值类 `.z-\[9999\]`、透明度类 `.border-border\/60`
 *     是现在最常见的写法，抽不到它们守卫对这类就是**盲的**（实测漏判 42 个，差点误判 notify 未覆盖）。 */
function classSet(file) {
  const css = readFileSync(file, "utf8")
  return new Set(css.match(/\.[A-Za-z0-9_\\:\[\]\/.,%()!-]+(?=[\s,{:>])/g) || [])
}

function compile(cli, input, out) {
  execFileSync(cli, ["-i", input, "-o", out, "--silent"], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] })
}

const cli = findCli()
const plugins = []
for (const p of ["forge-ui", "forge-pm", "forge-model", "forge-canvas", "forge-browser", "forge-notify"]) {
  const input = join(REPO, p, "src", "styles", "tailwind-input.css")
  if (existsSync(input)) plugins.push({ p, input })
}

// ① 合并产物
const mergedOut = join(TMP, "merged.css")
compile(cli, join(REPO, MERGED, "src", "styles", "tailwind-input.css"), mergedOut)
const merged = classSet(mergedOut)

// ② 逐包：探针（本包输入 + utilities）= 它改前的口径
let gaps = 0
const skipped = []

// ── ③ 的铺垫：**按「运行页面」分组的提供者**（ISS-684）────────────────────────────
// ① 断言的是「源码用到的类 ⊆ **合并产物**」—— 它只覆盖**加载了 forge-ui 的页面**（会话A）。
// 会话B（3300 / web-b profile）**不加载 forge-ui**（`~/.dsh-b/profiles/web-b/cordis.patch.yml` 明写）
// ⇒ 那些类在 B 页面上**根本没有提供者**。ISS-684 的缺口不在"类集合"，而在"装配拓扑"。
// 所以这里按**页面**再判一次：该页面的提供者必须覆盖该页面消费者用到的类。
const B_PAGE_PKGS = ["forge-model"] // web-b profile 里唯一有 client 且写工具类的包
let topoGaps = 0
const topoDetail = []
console.log(`── 合并构建包含性守卫（ISS-680 步骤②）──`)
console.log(`   合并产物：${MERGED} → ${merged.size} 个类名 / ${Math.round(readFileSync(mergedOut, "utf8").length / 1024)}KB`)
for (const { p, input } of plugins) {
  if (p === MERGED) continue
  const src = readFileSync(input, "utf8")
  const probeSrc = src.replace(/^(@import [^\n]*\n)/m, "$1@import \"tailwindcss/utilities\";\n")
  const sidecar = join(REPO, p, "src", "styles", "_containment-probe.css")
  writeFileSync(sidecar, probeSrc)
  const probeOut = join(TMP, `${p}-probe-out.css`)
  try {
    compile(cli, sidecar, probeOut)
  } catch (err) {
    // 该包在本机解析不到 tailwindcss（如缺 node_modules）→ 跳过并明说，不假装通过
    skipped.push(p)
    console.log(`   ${p.padEnd(15)} ⚠ 跳过（本机无法编译：${String(err?.message || err).split("\n")[0].slice(0, 60)}）`)
    continue
  } finally {
    rmSync(sidecar, { force: true })
  }
  const probe = classSet(probeOut)
  const ownText = src + (existsSync(join(REPO, p, "src", "styles", "tailwind-theme-extra.css")) ? readFileSync(join(REPO, p, "src", "styles", "tailwind-theme-extra.css"), "utf8") : "")
  // 源码里的候选 token（**整词**匹配，不做子串）：
  //   ⚠️ 子串匹配会造一堆假阳性 —— 实测 `.bg-red-50` 命中 `bg-red-500/5`、`.border-sidebar` 命中
  //   `border-sidebar-border`、`.013` 命中 SVG 路径数据，全被误判成「真缺口」。
  const tokens = new Set((sourceText(p).match(/[A-Za-z0-9_:/[\]().,%-]+/g) || []))
  const missing = [...probe].filter((c) => !merged.has(c))
  const own = missing.filter((c) => ownText.includes(c))
  const used = (c) => tokens.has(c.replace(/^\./, ""))
  const phantom = missing.filter((c) => !ownText.includes(c) && !used(c))
  const real = missing.filter((c) => !ownText.includes(c) && used(c))
  gaps += real.length

  // ── ③ 消费者拓扑：该包同时是**会话B 页面的唯一样式提供者** ──
  //    ISS-684 正是死在这：utilities 一被删，它自己源码用到的类在 B 页面**没有任何提供者**
  //    （A 页面有合并产物兜着 ⇒ ① 照样全绿、事故彻底静默）。这里编译**实际输入**（不注入 utilities）
  //    = "该包在 B 页面实际能提供哪些类"，再与它源码真正用到的类比对。
  if (B_PAGE_PKGS.includes(p)) {
    const actualOut = join(TMP, `${p}-as-b-provider.css`)
    compile(cli, input, actualOut)
    const actual = classSet(actualOut)
    const missInPage = [...probe].filter((c) => used(c) && !actual.has(c))
    if (missInPage.length) {
      topoGaps += missInPage.length
      topoDetail.push(`${p}（B 页面唯一提供者）缺 ${missInPage.length} 个：${missInPage.slice(0, 8).join(" ")}`)
    }
  }

  console.log(`   ${p.padEnd(15)} 本包类名 ${String(probe.size).padStart(4)} → 缺 ${String(missing.length).padStart(3)}（自写类 ${own.length} / 幻影 ${phantom.length} / **真缺口 ${real.length}**）${real.length ? " ✗ " + real.slice(0, 10).join(" ") : " ✓"}`)
}
if (skipped.length) console.log(`   （跳过 ${skipped.length} 个包：${skipped.join(" / ")} —— 本机缺 tailwindcss，未验证）`)
console.log(gaps === 0 ? `── ① 结果：✓ 无真缺口（源码用到的类，合并产物全都有）──` : `── ① 结果：✗ ${gaps} 个真缺口（会静默掉样式）──`)

// ── ③ 消费者拓扑断言输出 ──
console.log(`── ③ 消费者拓扑断言（ISS-684）──`)
if (topoGaps === 0) {
  console.log(`   ✓ 每个运行页面的样式提供者都覆盖了它自己的类`)
  console.log(`     A（web）= ${MERGED} 合并产物 · B（web-b）= ${B_PAGE_PKGS.join("/")} 自包含（该 profile 不加载 ${MERGED}）`)
} else {
  console.log(`   ✗ 会话B 页面缺 ${topoGaps} 个类（会静默掉样式，症状 = 选择器/面板塌形）`)
  for (const d of topoDetail) console.log(`     ${d}`)
  console.log(`     判据：web-b profile 不加载 ${MERGED} ⇒ ${B_PAGE_PKGS.join("/")} **必须自包含工具类**`)
}
process.exit(gaps === 0 && topoGaps === 0 ? 0 : 1)
