#!/usr/bin/env node
/**
 * plugin-load-scout.mjs —— 装载现场侦察（**只读**，不打网络、不写盘）
 *
 * 为什么要单独一个工具：真机窗口的成败不在"代码写没写"，而在"跑着的那个进程读的是哪份代码"。
 * 而"换码"在这个项目里至少有三种不同手段，用错那种就是白打断老板一次：
 *   ① `ws.sh link` 只切**已经挂成软链**的包，而且**缺 dist 的工作树包会被静默跳过**（ISS-334 的白屏防护）；
 *   ② 插件能不能被某个引擎加载，看的是 profile 的 insert 名单（`cordis.patch.yml`），不是包在不在仓库里；
 *   ③ 两个引擎/两个家（`~/.dsh` = 3210 开发盘 / `~/.dsh-matter` 或 desktop profile = 生产 App）各读各的。
 * ⇒ "我把四个包都 link 了"完全可能是"两个没动、一个本引擎根本不加载"。这一段把这件事开跑前打在纸上。
 *
 * 用法：node scripts/plugin-load-scout.mjs [--pkg forge-pm ...] [--selftest] [--json]
 *       [--wt ISS-NNN|/abs/path] 把侦察根指到要被 ws.sh link 的那棵工作树（不给就用脚本所在检出）
 * 退出码：0 = 每个被点名的包都说得清怎么换；3 = 有包在本引擎"换不动"（NOMOUNT），窗口里别指望验到它。
 */
import { readFileSync, readlinkSync, readdirSync, lstatSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ARGV = process.argv.slice(2)
const JSON_OUT = ARGV.includes("--json")
// 被侦察的根：默认 = 本脚本所在检出；`--wt` 指到要被 link 的工作树后，dist 判据也跟着换根。
let ROOT = REPO
let WT_GIVEN = false

/** 解析 `--wt <ISS-NNN|绝对路径>`，顺带把 ROOT 定下来。没给就用脚本所在检出（并在报告里说清）。 */
function wtArg() {
  const i = ARGV.indexOf("--wt")
  if (i < 0) return REPO
  const v = ARGV[i + 1] || ""
  if (!v || v.startsWith("--")) throw new Error("--wt 需要 <ISS-NNN> 或工作树绝对路径")
  const root = (process.env.DSH_FORGE_WT_ROOT || join(homedir(), "wt", "dsh-forge")).replace(/\/$/, "")
  const p = v.startsWith("/") ? v : join(root, v)
  WT_GIVEN = true
  if (!existsSync(p)) throw new Error("找不到工作树：" + p + "（先 ws.sh new " + v + "）")
  ROOT = resolve(p)
  return ROOT
}

/** 被点名的包：默认为"这批活动过的四个"。 */
function pkgList() {
  const i = ARGV.indexOf("--pkg")
  if (i < 0) return ["forge-pm", "forge-agents", "forge-messenger", "forge-teammate-model"]
  const out = []
  for (const x of ARGV.slice(i + 1)) {
    if (!x) continue
    if (x.startsWith("--")) break          // 遇到下一个开关就停：否则 `--pkg X --wt Y` 会把 Y 当包名
    out.push(x)
  }
  return out
}

/** DSH 家目录们（跟随 DSH_HOME，与 ws.sh 同口径；再把已知的第二个家一起扫，两个引擎各读各的）。 */
function homes() {
  const home = process.env.HOME || ""
  const out = [process.env.DSH_HOME || join(home, ".dsh"), join(home, ".dsh-matter")]
  return out.filter((h, i, a) => h && existsSync(h) && a.indexOf(h) === i)
}

/**
 * 这个包"dist 这一关过不过"。⚠️ 判据与 ws.sh 的 has_client() 必须**同一条**（10-01 修）：
 * 带 client 的包要有 dist；纯 host 插件（没有 src/dsh/client-entry.*、也没有 build:client）
 * 压根不会有产物，直接算过关 —— 两边不一致的话，侦察说"能切"而脚本说"跳过"，
 * 窗口里就又是一次"命令跑成功了但没换码"。
 */
function hasDist(pkg) {
  if (existsSync(join(ROOT, pkg, "dist"))) return true
  try {
    if (readdirSync(join(ROOT, pkg, "src", "dsh")).some((f) => /^client-entry\./.test(f))) return false
  } catch { /* 没这个目录 = 没有 client */ }
  try {
    if (/"build:client"/.test(readFileSync(join(ROOT, pkg, "package.json"), "utf8"))) return false
  } catch { /* 读不到 package.json 就当真没有 */ }
  return true
}

/** 只读地取装载事实：软链指向 + profile 名单。任何一步读失败都如实记下来，不猜"应该挂着"。 */
function loadFacts(pkg, hs) {
  const links = []
  const patches = []
  for (const h of hs) {
    const link = join(h, "profiles", "node_modules", pkg)
    try {
      if (lstatSync(link).isSymbolicLink()) links.push({ home: h, target: readlinkSync(link) })
      else links.push({ home: h, target: null, note: "同名条目不是软链" })
    } catch { /* 没有 = 没挂，这本身就是读数 */ }
    for (const prof of ["web", "desktop"]) {
      const yml = join(h, "profiles", prof, "cordis.patch.yml")
      try {
        const t = readFileSync(yml, "utf8")
        // insert 名单里的形态是 `- id: <包名>`（缩进两格或在列表项里）；只看 id 这一行，不猜别的键
        if (new RegExp("^\\s*(?:-\\s+)?id:\\s*" + pkg + "\\s*$", "m").test(t)) patches.push(prof + "@" + h)
      } catch { /* 文件不存在就当真不存在 */ }
    }
  }
  return { pkg, links, patches, dist: hasDist(pkg) }
}

/**
 * 纯判据：给装载事实 ⇒ 这个包在这台机器上**要怎么才换得动**。
 * 判据搬成纯函数是为了能被自测（上面那条退出码要是不能判红，就又是一条恒绿守卫）。
 * @param {{links:Array<{target:string|null}>,patches:string[],dist:boolean}} f
 * @param {string} wt 当前检出的绝对路径（跑这个脚本的那份代码所在）
 */
export function judgeLoad(f, wt) {
  const declared = f.patches.length > 0
  if (!declared) return { verdict: "NOMOUNT", how: "两份 profile 的 insert 名单里都没有这个包 ⇒ 这个引擎不加载它；在窗口里 link/改路径都验不到它，要去挂它的那盘验" }
  const mounted = f.links.filter((l) => l.target)
  if (mounted.length === 0) return { verdict: "NOPATH", how: "名单里有、但 profiles/node_modules 没有软链 ⇒ 它是按解析路径加载的，换码要动的是路径（或补软链），不是 link" }
  const onWt = mounted.some((l) => String(l.target).startsWith(wt))
  if (onWt) return { verdict: "ONWT", how: "软链已指向本检出 ⇒ 这份代码在场" }
  if (!f.dist) return { verdict: "LINKSKIP", how: "能 link，但本检出这个包没有 dist ⇒ `ws.sh link` 会**静默跳过**它（ISS-334 白屏防护）。要么先构建产物，要么承认这一格本轮验不到，别把 link 成功当上线" }
  return { verdict: "LINKABLE", how: "软链在主检出且有 dist ⇒ `ws.sh link` 切得动（切完必须重启宿主壳才生效）" }
}

/* ── 自测（不读盘、不打网；正控制 + 反控制成对）──────────────────── */
if (ARGV.includes("--selftest")) {
  const WT = "/Users/x/wt/dsh-forge/ISS-999"
  const cases = []
  const push = (name, got, want) => cases.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })
  push("NOMOUNT：名单里没它 ⇒ 换不动（不许混在链接里假装验过）", judgeLoad({ links: [], patches: [], dist: true }, WT).verdict, "NOMOUNT")
  push("NOPATH：有名单但没软链 ⇒ 换码手段不是 link", judgeLoad({ links: [], patches: ["web@h"], dist: true }, WT).verdict, "NOPATH")
  push("LINKSKIP：能 link 但缺 dist ⇒ 会被静默跳过（这条最容易骗过窗口）", judgeLoad({ links: [{ target: "/Users/x/dsh-forge/forge-pm" }], patches: ["web@h"], dist: false }, WT).verdict, "LINKSKIP")
  push("LINKABLE：主检出 + 有 dist ⇒ 切得动", judgeLoad({ links: [{ target: "/Users/x/dsh-forge/forge-pm" }], patches: ["web@h"], dist: true }, WT).verdict, "LINKABLE")
  push("ONWT：已经在切过来的工作树上 ⇒ 在场", judgeLoad({ links: [{ target: WT + "/forge-pm" }], patches: ["web@h"], dist: true }, WT).verdict, "ONWT")
  const bad = cases.filter((c) => !c.ok)
  for (const c of cases) console.log((c.ok ? "  ok  " : "  FAIL ") + c.name + (c.ok ? "" : " got=" + JSON.stringify(c.got) + " want=" + JSON.stringify(c.want)))
  console.log(bad.length ? "✗ 装载判据自测 " + bad.length + "/" + cases.length + " 条失败 —— 判据本身坏了" : "✓ 装载判据自测 " + cases.length + " 条全过（含反控制）")
  process.exit(bad.length ? 1 : 0)
}

const hs = homes()
// `--wt <ISS-NNN|绝对路径>`：把侦察的根指到**要被 link 的那棵工作树**。
// 不带就是脚本所在检出 —— 而 ws.sh link 切走的是目标工作树的包，两者不同根时，
// 下面每条 dist 结论说的都是另一棵树（独立审查 ISS-583 L5 指出的口径错位）。
const wt = wtArg()
const rows = []
for (const pkg of pkgList()) {
  const f = loadFacts(pkg, hs)
  const v = judgeLoad(f, wt)
  rows.push({ pkg, verdict: v.verdict, how: v.how, links: f.links.map((l) => l.home.replace(hs[0], "~") + "→" + (l.target || l.note || "无")), patches: f.patches.map((p) => p.replace(hs[0], "~")), dist: f.dist })
}
if (JSON_OUT) {
  console.log(JSON.stringify({ repo: wt, homes: hs, rows }))
} else {
  const rootNote = WT_GIVEN
    ? "（--wt 指定的那棵 —— dist 判据跟着它换根）"
    : "（脚本所在检出 —— 没带 --wt ⇒ 若你要验的是别的工作树，这里的 dist 结论说的是另一棵树）"
  console.log("装载现场（只读）· 检出 " + wt + rootNote + " · 家 " + hs.join(" / "))
  for (const r of rows) {
    const mark = r.verdict === "ONWT" || r.verdict === "LINKABLE" ? "✓" : r.verdict === "LINKSKIP" || r.verdict === "NOPATH" ? "△" : "✗"
    console.log(`${mark} ${r.pkg.padEnd(21)} [${r.verdict}] ${r.how}`)
    console.log(`    软链: ${r.links.join("  ") || "无"} · insert: ${r.patches.join(" / ") || "无"} · dist关: ${r.dist ? "过（有产物，或本就是纯 host 插件不需要）" : "不过（带 client 却缺产物 ⇒ link 会被跳过）"}`)
  }
  const stuck = rows.filter((r) => r.verdict === "NOMOUNT" || r.verdict === "LINKSKIP" || r.verdict === "NOPATH")
  if (stuck.length) console.log(`\n⚠ 有 ${stuck.length} 个包不是"link 一下就行"：窗口里要么换手段，要么承认这几格本轮验不到 —— 别把"命令跑成功了"当成"新代码在场"。`)
}
process.exit(rows.some((r) => r.verdict === "NOMOUNT") ? 3 : 0)
