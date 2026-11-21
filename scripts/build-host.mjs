#!/usr/bin/env node
// scripts/build-host.mjs —— 把 host half 打成**自包含**产物 dist/host.js（ISS-588 / DOC-393 P2 批二）
//
// 用法（各包 scripts 里，照 `scripts/tsc.mjs` 的共享脚本先例）：
//   "build:host": "bun ../scripts/build-host.mjs"   ← 必须用 bun（本脚本 import "bun" 的 build API；
//                                                     用 node 跑会 ERR_MODULE_NOT_FOUND，2026-10-04 四审实测）
//
// ## 为什么需要自包含（2026-10-04 五态实测，别再重新推一遍）
// 自有包之间用裸名互相声明依赖，而**这些名字在 npm 上不是我们的**（⚠️ 更正：2026-10-04 独立审查 F1 实测，
// 26 个名里 4 个被第三方占用 —— `forge-agents`=1.0.1 · `forge-browser`=1.2.0 · `forge-design`=1.0.14 ·
// `forge-ui`=0.8.1 且**存在 0.1.0**）。⚠️ 精确口径（二审 F1′ 纠正）：本仓当时的 11 处都是**精确 pin `0.1.0`**，
// 而 npm 上有 0.1.0 的只有 forge-ui（它恰恰没有内部声明）⇒ **当时的真实症状是大声 404，不是静默装错**；
// 本步是把"将来有人写 ^0.1.0 / 抬版"这类**未来风险**变成硬门禁（C13），不是修一个已发生的错）
// ⇒ 侵占名一律用 `workspace:*`（见 check-card-ready.py 的 C13），其余名字未发布故解析不到：
//   · `pnpm add <绝对路径>`（link）装得上，但链接后模块 realpath 在仓外 ⇒ Node 从 realpath 向上找，
//     **看不到 profile 里的兄弟包**（profile 装了也白装）
//   · tarball / `file:<目录>` 形态**装不上**：`forge-service-kit: Not Found — 404`
//   ⇒ 唯一"装得上且跑得起来"的形态 = 卡自包含：构建期把**未发布的 forge-*** 内联进来。
//
// ## 口径（别照抄成"全打包"）
// **只内联 `forge-*`**；已发布依赖一律 external（否则 leafer/three 这类大件也会被焊进来——
// 实测 canvas 会从 16 KB 涨到 273 KB）。**不 minify**：host 报错栈要能读，差的那十几 KB 不值当。
//
// ## 四条自检（缺一条就是静默失败）
//   ① dist/host.js 不得是符号链接（ISS-418 写穿：就地写会覆盖链接目标）
//   ② 本包 host 半**必须真的 import 了 forge-*** —— 否则本包不需要自包含产物（拒绝出货，防货郎式照抄）
//   ③ 声明/登记一致性（两条，都有牙）：③a **死声明** —— 声明过（deps+peer）的 forge-* 必须"登记外置 或 确实被 import"；
//      ③b **登记外置反向自检** —— 登记了就必须真的以外部 import 留在产物里
//      ⚠️ 不设"产物零裸残留"检查：那个方向**逻辑不可达**（未登记的一律被内联，连静态说明符的 import() 也被内联，
//      2026-10-04 三轮审查逐条注入确认）—— 写在头部只会让人以为存在第四道保险
//   ④ 产物必须导出插件契约 `name` + `apply`，且 `name` == 包名（否则引擎加载即失败而日志沉默）
import { build } from "bun"
import { mkdirSync, lstatSync, readlinkSync, readFileSync, statSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

const CWD = process.cwd()
const pkgPath = join(CWD, "package.json")
if (!existsSync(pkgPath)) {
  console.error(`✗ ${CWD} 下没有 package.json —— 本脚本要求在**包目录**里跑（照 scripts/tsc.mjs 的用法）`)
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
const ENTRY = "lib/index.js"
const OUT = "dist/host.js"
// ── 多入口（ISS-642）：`dsh.hostExtra: ["tools"]` ⇒ 追加 `lib/tools.js → dist/tools.js` ──
//   为什么需要：插件的「工具半」要能被 agent preset 单独列（不列即无），而「面板半」（路由 +
//   dsh.client）必须留在 profile bundle 层（客户端只扫**根树**，preset 子树里的 dsh.client 不被发现）。
//   一个 apply 同时干两件事时这两条诉求冲突 ⇒ 一个包要出两个可独立装载的产物。
//   **登记制**：不猜文件名，写在 package.json 里；没登记就一个都不建（存量 24 包行为不变）。
const EXTRAS = (pkg.dsh || {}).hostExtra || []
if (!Array.isArray(EXTRAS) || EXTRAS.some((e) => typeof e !== "string" || !/^[a-z][a-z0-9-]*$/.test(e))) {
  console.error(`✗ dsh.hostExtra 必须是「小写文件名」数组（如 ["tools"]），收到 ${JSON.stringify(EXTRAS)}`)
  process.exit(2)
}
/** 取「代码行」：逐行去掉 `//` 之后的内容、跳过块注释行（`*` 开头）。
 *  为什么要它：注释里会**写** import 例子（如 `// … 经 import("forge-agents/plans-usage") 懒加载消费`），
 *  直接对原文正则会把它们算成真 import（2026-10-04 独立审查 F2/F3 的伪命中就是这么来的）。 */
const codeLines = (t) => t.split('\n').map((l) => l.replace(/\/\/.*$/, '')).filter((l) => !/^\s*\*/.test(l)).join('\n')

// ── ② 先判"本包到底需不需要自包含"：host 半必须真的 import 了 forge-*
//    ⚠️ 只扫**非测试**文件：测试 import 别的包（如 forge-pm）不构成运行期依赖，
//    把它们算进来会让"内联清单"虚高（2026-10-04 实测：forge-agents 的测试 import forge-pm）
const hostFiles = readdirSync("lib", { recursive: true })
  .filter((f) => /\.(js|mjs|cjs)$/.test(String(f)) && !/\.test\.[a-z]+$/.test(String(f)))
  .map((f) => join("lib", String(f)))
const forgeImports = new Set()
/** 同包子面引用数（如 `forge-ui/browser-bridge`）—— **自引用的一种**：不构成跨包边，但同样要内联。 */
let selfSubpathImports = 0
for (const f of hostFiles) {
  const src = codeLines(readFileSync(f, "utf8"))
  for (const m of src.matchAll(/(?:from\s*|require\(\s*|import\(\s*|import\s+)["'](forge-[a-z-]+)(\/[^"']*)?["']/g)) {
    if (m[1] !== pkg.name) forgeImports.add(m[1])          // 跨包边
    else if (m[2]) selfSubpathImports += 1                 // 同包子面（ISS-607）
  }
}
if (forgeImports.size === 0 && selfSubpathImports === 0) {
  console.error(`✗ ${pkg.name} 的 host 半没有 import 任何 forge-* ⇒ 本包不需要自包含产物（不要照抄本步）`)
  process.exit(2)
}
// ⚠️ 2026-10-09（ISS-607）：只有**同包子面**引用时也必须产出自包含产物 —— 引擎按 `main` 直载
//   `dist/host.js`（node 直跑，不经 bundler），子面若留在产物里就是裸 import（同包名 node 未必解析得到）。
//   原判据只看「跨包 forge-*」⇒ forge-ui 把 bridge 收回同包（`forge-ui/browser-bridge`）后
//   **被判"不需要产物"而拒建**，dist/host.js 停在旧内容（产物新鲜度守卫因此抓到 stale）。
//   本条件放宽为「跨包边 > 0 **或** 同包子面 > 0」。
if (forgeImports.size === 0) {
  console.log(`· ${pkg.name} 仅含同包子面引用（${selfSubpathImports} 处）—— 仍需自包含产物，继续。`)
}

// ── ① 写穿护栏（照 forge-mermaid/scripts/build-client.mjs 同款，ISS-418）──────
try {
  if (lstatSync(OUT).isSymbolicLink()) {
    console.error(`✗ ${OUT} 是符号链接（写穿风险）→ ${readlinkSync(OUT)}`)
    process.exit(1)
  }
} catch (e) {
  if (e?.code !== "ENOENT") throw e
}
mkdirSync("dist", { recursive: true })

// 已发布的依赖保持外部；forge-*（未发布）一律内联。
// ⚠️⚠️ 生态底座必须**显式**外部化 —— 只从 dependencies/peerDependencies 算是错的：
//   @deepseek-ai/* 多在 devDependencies 或靠 hoisting 解析，照 dependencies 算会把
//   **整条 DSH 运行时链**（dsh-tools / dsh-llm / sandbox / crypto…）内联进来
//   （2026-10-04 实测：browser/ui/agents 的产物因此虚胖到 210+ KB）。口径与各包
//   `scripts/build-client.mjs` 完全一致：只把自家 forge-* 焊进来，底座一律 external。
const BASE_EXTERNAL = ["react", "react/*", "react-dom", "react-dom/*", "@deepseek-ai/*"]
const all = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) }
const published = Object.keys(all).filter((k) => !k.startsWith("forge-"))
// 允许外置清单（**登记制**）：`dsh.hostVendor: { external: ["forge-agents"], why: "…" }`。
// 为什么需要它：host 侧**合法的 in-process API**（DOC-256 §7.2：两插件同进程，PM → agents 单向 import）
//   不是"组件层跨业务包 import"（铁律④ 的实现只扫客户端 src，见 design-component-inventory.mjs:197-200）
//   ⇒ 这类边**登记即可**；内联它反而把 agents 整包（含 sqlite/pm-store）焊进产物（实测 +110～163 KB）。
const vendorCfg = (pkg.dsh || {}).hostVendor || {}
const registered = vendorCfg.external || []
for (const k of registered) {
  if (!k.startsWith("forge-")) { console.error(`✗ dsh.hostVendor.external 只接受 forge-* 包名，收到 "${k}"`); process.exit(2) }
  if (!(k in all)) { console.error(`✗ 登记外置的 "${k}" 不在本包 dependencies/peerDependencies ⇒ 登记与实际不符`); process.exit(2) }
}
if (registered.length && !vendorCfg.why) {
  console.error(`✗ 登记外置必须写 dsh.hostVendor.why（凭什么允许）—— 无理由的例外一律当违规`)
  process.exit(2)
}
const external = [...new Set([...BASE_EXTERNAL, ...published, ...registered])]
const flat = external.flatMap((k) => (k.includes("*") ? [k] : [k, `${k}/*`]))

// ── 构建目标表：主入口必建；`dsh.hostExtra` 登记的额外入口逐个建 ──
//   主入口保持 `lib/index.js → dist/host.js` 不变（24 个存量包的行为一字不动）。
const TARGETS = [
  { src: ENTRY, out: OUT, main: true },
  ...EXTRAS.map((e) => ({ src: `lib/${e}.js`, out: `dist/${e}.js`, main: false })),
]
for (const t of TARGETS) {
  if (!existsSync(t.src)) {
    console.error(`✗ ${pkg.name} 没有 ${t.src}${t.main ? "（本脚本只服务有 host 半的包）" : `（dsh.hostExtra 登记了 "${t.src.slice(4, -3)}" 但文件不存在）`}`)
    process.exit(2)
  }
}

const before = statSync(ENTRY).size
const built = []
for (const t of TARGETS) {
  const result = await build({
    entrypoints: [t.src],
    outdir: "dist",
    naming: t.out.slice("dist/".length),
    target: "node",
    format: "esm",
    minify: false,
    external: flat,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  built.push(t)
}

// ── ③ 不变量：**声明过的**（dependencies + peerDependencies）forge-* 要么登记外置、要么确实被 import ──
//    ⚠️ 口径修正（2026-10-04 独立审查 F2）：原先写成"产物零裸 forge-* 残留"，但未登记的
//    forge-* 依赖**会被内联**（不会"残留"）⇒ 那个写法恒真、等于没有保险。
//    ⚠️ 二次修正（同轮注入实测）：只查"产物里还有没有裸残留"也抓不到**死声明**
//    （声明了却从不 import ⇒ 产物里本来就没有它）⇒ 必须拿**检测到的 import 集**比对。
//    ③a 已声明 ⇒ 已登记外置 或 确实被 import（否则死声明）。⚠️ 射程 = dependencies + peerDependencies；
//    **devDependencies 不在射程**（那里的 forge-* 是构建期依赖，本就不该出现在产物里）
//              ③b 见下方「登记外置反向自检」：**不以"残留"为牙**（实测静态说明符的 import() 同样会被内联，
//                  「产物出现未登记 forge-* 裸 import」在本构建配置下逻辑不可达 ⇒ 不再宣称它有牙）
const declaredForge = Object.keys(all).filter((k) => k.startsWith("forge-"))
const unaccounted = declaredForge.filter((k) => !registered.includes(k) && !forgeImports.has(k))
if (unaccounted.length) {
  console.error(`✗ ${pkg.name} 声明了却在 host 半从不 import、也没登记外置的 forge-*：${unaccounted.join(", ")} ⇒ 死声明（要么删声明、要么写 dsh.hostVendor 登记）`)
  process.exit(1)
}
const code = codeLines(readFileSync(OUT, "utf8"))
// ③b（登记外置反向自检 —— **这条有牙**，2026-10-04 二审复算过）：登记了就必须**真的**以外部 import
//    留在产物里；查无 = 要么其实没被用到（该删登记）、要么被静默内联了（登记空转）。
//    ⚠️ 不写成"产物零裸 forge-* 残留"：那个方向逻辑不可达（未登记的一律被内联；静态说明符的
//    `import()` 同样被内联，实测），写了就等于没有保险 —— 别再往回改。
const leaked = [...new Set([...code.matchAll(/(?:from\s*|require\(\s*|import\(\s*|import\s+)["'](forge-[a-z-]+)(?:\/[^"']*)?["']/g)].map((m) => m[1]))]
for (const k of registered) {
  if (!leaked.includes(k)) {
    console.error(`✗ 登记外置的 "${k}" 在产物里查无外部 import ⇒ 要么它其实没被用到（该删登记），要么被内联了`)
    process.exit(1)
  }
}

// ── ④ 插件契约自检 ─────────────────────────────────────────────────────────
//   ⚠️ `name` 必须 == 包名，**只对主入口成立**（引擎按包名装载主入口）。
//   额外入口（工具半）必须导出 `apply`，但 `name` 是**该工具插件自己的名字**
//   （引擎按 Loader 条目的 `name` 字段装载它，而不是按包名）——`lib/tools.js` 里写
//   `export const name = "<包名>/tools"`，preset 行的 `name` 就写这个子路径。
for (const t of built) {
  const mod = await import(join(CWD, t.out))
  for (const k of ["name", "apply"]) {
    if (!(k in mod)) {
      console.error(`✗ ${t.out} 缺插件契约导出 "${k}"（引擎加载会失败且日志沉默）`)
      process.exit(1)
    }
  }
  if (t.main && mod.name !== pkg.name) {
    console.error(`✗ ${t.out} 导出 name="${mod.name}" ≠ 包名 "${pkg.name}"（引擎按包名装载主入口）`)
    process.exit(1)
  }
  if (!t.main && mod.name !== `${pkg.name}/${t.src.slice("lib/".length, -".js".length)}`) {
    console.error(`✗ ${t.out} 导出 name="${mod.name}"，应为 "${pkg.name}/${t.src.slice("lib/".length, -".js".length)}"（preset 行按这个子路径装载它）`)
    process.exit(1)
  }
}

const kb = (n) => (n / 1024).toFixed(1)
console.log(
  `✓ ${pkg.name} host 自包含产物：${ENTRY} ${kb(before)} KB → ${OUT} ${kb(statSync(OUT).size)} KB` +
    `（内联 ${[...forgeImports].filter((k) => !registered.includes(k)).sort().join("+")}；external ${external.length} 个${registered.length ? "，登记外置 " + registered.join("+") : ""}）`,
)
for (const t of built.filter((x) => !x.main)) {
  console.log(`✓ ${pkg.name}/${t.src.slice("lib/".length, -".js".length)} host 产物：${t.src} → ${t.out} ${kb(statSync(t.out).size)} KB`)
}
