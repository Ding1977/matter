// 依赖卫生门禁（ISS-777 建议第 3 条「长期化」：把"声明未用"提成通用度量 + 棘轮）
//
// 为什么需要：§M6-1 删掉各包 `components/ui/` 副本时**没跟着删依赖声明** —— 09-23 现算 71 条"声明了但没人 import"
// （8 个包），而全仓只有 `forge-agents` 自己写了"包形态"这条自检（那 2 条在 ISS-776 被抓到并修掉）。
// 只有一个包里有守卫 = 别的包每删一份使用者就再攒一次孤儿，而且没人知道。本脚本把那条自检提成通用判据。
//
// ⚠️ 四条历史教训（都是我自己栽过的，写死在这儿防止重演）：
//  ① **「在 bun.lock 里出现」不算在用** —— 锁文件照抄 package.json 的声明，拿它判"在用"是恒真判据
//     （第一版就这么量的：71 条被压成 3 条，差点让我以为没问题）。
//  ② **判据不许内联进 shell** —— 第二版把正则塞进 `bash -c`，转义坏掉 ⇒ 把真在用的 `@radix-ui/react-dialog`
//     误判成未用（虚高到 79 条）。所以判据只在文件里，且自带四条控制（`--selftest`），正反都有。
//  ③ **「这条声明没人 import」不等于「这条声明可以摘」** —— 声明还有两重静态查不出来的身份：
//     **版本钉**（原由文件中心插件钉 `@deepseek-ai/dsh-client-ui-primitives@0.1.2-alpha.2`，全仓只有这一个版本提供 `anser`，
//     摘了 ⇒ forge-shell / forge-session-b / forge-ui 三个包 `Cannot find package 'anser'`）；
//     **安装面入口**（`@deepseek-ai/*` 在 A 包声明一次，B 包的 `declare module` 扩充才解析得到 ——
//     摘掉 monitor/pm/cad 里的 7 条，错却报在**别的包**：TS2664 无法扩展尚未声明的模块）。
//     ⇒ 本脚本的输出永远只是**候选清单**，"摘哪些"由人逐条判，判据本身不许直接判红可删。
//  ④ **只在"受影响的包"上跑测试不算数** —— 上面那个 `anser` 是在三个**没被改动**的包里炸出来的
//     （我第一批只验了改动包，全绿就以为完事）。验收口径见下一节，必须是全量。
//
// 口径：
//  - 包的范围 = 根 `package.json` 的 `workspaces`（bun 字面目录列表）**加上** `pnpm-workspace.yaml` 的
//    `packages:`（新树 glob，目录扫描展开）—— 绝不把 glob 字面塞进 `workspaces`：探针实测那样会被当成
//    目录名、`package.json` 全不存在 ⇒ "无 workspace 包可读⇒判不了"。看 `dependencies` + `devDependencies`。
//  - 某依赖"在用"当且仅当该包自己的源/配置里出现下列任一通道：
//      import / require / 动态 import / `export * from`（含子路径）· CSS 的 `@source`（类供体：摘了会静默少发类，ISS-771）
//      · **CSS 的 `@import` / `@plugin` / `@config`**（ISS-787 补）——Tailwind v4 的 `@import "tailwindcss/theme"`
//        与跨包相对写法 `@import "../../../forge-model/src/styles/tailwind-theme-extra.css"` 都是真实取用；
//        上一版只认 `@source`，于是 `tailwindcss` / `forge-model` 被判成"声明未用"并在 ISS-777 第一批里被摘掉。
//      · **代码文件里按 `node_modules/<pkg>` 路径取用**（ISS-787 补）——three@0.172 的 exports map 不暴露
//        `examples/jsm/*`，`forge-cad/scripts/build-client.mjs` 只能 `resolve("node_modules/three", file)` 这么取，
//        静态 import 通道看不见它。只扫代码文件：同样的字符串出现在 json/md 里不算（那是恒真的另一种形状）。
//      · `tsconfig.json` 里出现的名字（`types` / `extends`）· `package.json` 的 scripts（工具链按名字被调用）
//      · **`declare module "<pkg>"` 类型扩充**（ISS-777 后半补）——它不是 import，但把声明摘掉后 TS 会从
//        "扩充既有模块"退化成"凭空声明一个新模块"：**typecheck 仍然 0 错，扩充却静默失效**
//        （实测：摘掉 `@deepseek-ai/dsh-client-ui-slots` 后 forge-monitor 的 tsc 干净通过，slot-map.ts 已不生效）。
//      · **dev 件的 bin 名出现在 `<pkg>/scripts/*` 的正文里**（ISS-777 后半补）——`@tailwindcss/cli` 的 bin 是
//        `tailwindcss`，真调用点在构建脚本里（`./node_modules/.bin/tailwindcss`）。旧规则只看 package.json.scripts，
//        于是 8 个包的工具链声明被判成"可摘" —— 这是 ISS-787 同族的**第三条通道盲区**。
//      · 源文件里的 `/// <reference path>` 之外的 `types=` 引用
//    ⚠️ 补通道一律**宁可判成在用**：这条判据的误判方向恰好是"可以删"，而删错的代价是
//       **干净检出上构建即红、主 checkout 却全绿**（那里的 node_modules 是旧现场，会替缺声明兜底）—— ISS-787 就是这么踩出来的。
//  - 生成物与噪声不算消费者：`node_modules`/`dist`/`out`/`.git`/`build`/`coverage`、编辑器备份 `*~*`、`registry-report.json`；
//    普通 `*.json` 与 `*.md` 不读（防止"文档里提了一句"被当成在用 —— 那正是恒真的另一种形状）。
//  - **只报候选，不教人删**：三方件的内部动态加载（B3）与宿主注入面（B4）必须人逐条判。
//  - **具名豁免（ISS-635）**：有一类声明**必然**在本口径下落空却不能删 —— 官方包把自己的**运行期**依赖
//    写进了它的 devDependencies（`@deepseek-ai/dsh-client-ui-primitives` 就是一例：快照 0.2.1-rc.2 里
//    dependencies 0 条、26 条全在 devDependencies，而它 lib/index.js 运行期 import 了这些包）⇒ 被当依赖安装时不会装，
//    使用方**必须替它声明**，而使用方源码里永远不会出现那个包名（是官方包在 import）。
//    ⇒ 这一格只认 `INSTALL_FACE_ALLOW` 里的**具名条目 + 理由 + 摘除条件**（本文件唯一一处豁免入口），三条纪律：
//      ① **豁免只是不判红，不从候选集里消失**（count/byPkg/--verbose 照实报，理由随条目一起打出来）；
//      ② **只按 `包 → 依赖` 整键精确匹配**，不是前缀也不是包级 ⇒ 新攒的孤儿照样红；
//      ③ **条目 0 命中即报「该摘」并判红** —— 化石名单比没有名单更坏（同 lint-design 的 R9a）。
//  - 真要摘，验收口径 = **干净克隆 + 全量**（ISS-777 后半踩出来的，替代旧"四步验证"）：
//      `git clone --no-hardlinks file://<repo> /tmp/x` → `bun install --frozen-lockfile` → `node scripts/ci-local.mjs`（全仓测试，不是只跑改动包）
//      → 各包 `build:client` 后产物 sha256 对比。
//    ⚠️ **主 checkout 全绿不算证据**：那里的 `node_modules` 是旧现场 + `ws.sh` 依赖镜像，会替缺声明兜底（ISS-787 与 ③④ 两次都是这么过的）。
//    ⚠️ 在克隆里跑 ci-local 有一条**必红、且不是回归**：`guard-baselines` 的 B7 装配一致性按"当前这棵树的根"判定生产引擎的插件软链，
//       克隆的根当然不是引擎在用的那个根 ⇒ 实测 **34 条**「指向非主 checkout」（同一命令在主 checkout 上 exit 0、零 ✗）。
//       判"有没有倒退"时把 B7 单独看，**其余项必须全绿**。
//
//  - **绝对判据（ISS-884）**："未用依赖=0"判的是**运行档 `dependencies` 的未豁免候选**（`reds`）；
//    `ceiling` 棘轮退休，判据改为 `reds.length === 0`，不再跟基线比总数。四条边界（老板 2026-11-18 18:40 已拍板）：
//      ① **peer 排除**：只扫 `dependencies`，不扫 `peerDependencies`。新树 6 包的 `@deepseek-ai/cordis` 是
//         宿主外部注入的 peer，且 `verify-plugin-shape` 强制它同时是 peer+dev（当前绿）—— 纳入判红会当场冲突。
//      ② **dev 排除**：`devDependencies` 走既有三条精确规则（@types 环境声明 / bin 名被 scripts 调用 /
//         `<pkg>/scripts/*` 正文），`devCeiling` 恒 null、只报不判，不并进运行档这条 0 判据。
//      ③ **tests 算消费者**：`readSources()` 不跳过 `tests/`，测试里真 import 的声明算在用
//         （storage-json 在 issue/project 的 dev 声明由 tests 真 import —— 现判据已这样算，保持）。
//      ④ **具名豁免保留**：`INSTALL_FACE_ALLOW` 只在候选集免判红、不从统计消失 —— 条目仍在 `items` /
//         `exempt` / `byPkg` / `candidateCount` 照实报；`count`（绝对判据读数）只数未豁免的 `reds`。
//
// 用法：node scripts/deps-hygiene.mjs [--selftest | --compare | --check | --write | --json | --verbose]
//   `--compare` / `--check` / 不带参数 = 同一个动作「照基线判红」。`--compare` 这个名字是
//   `scripts/guard-baselines.sh` 的 report_only 档按名调用的入口（ISS-635 起写进用法，不再是"未知参数当无参"）。
// 退出码：0 = 未超上限；1 = 超上限（只许降不许升）/ 有新增违例 / 具名豁免名单过期（该摘）；
//         2 = 判据读不到（显式"判不了"，不冒充通过）。
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const BASE = path.join(ROOT, "scripts", "baseline", "deps-hygiene.json")
const A = process.argv
const SKIP_DIR = new Set(["node_modules", "dist", "out", ".git", "build", "coverage", ".next"])
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|scss)$/

/** 目录遍历：跳过产物目录与编辑器备份；返回 [{p, text}]（只读会被当消费者的文件）。 */
function readSources(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let ents
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch (e) {
      continue
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) stack.push(p)
        continue
      }
      if (e.name.includes("~") || e.name === "registry-report.json") continue
      const isJson = e.name === "package.json" || e.name === "tsconfig.json" || /^tsconfig\..*\.json$/.test(e.name)
      if (!isJson && !SRC_EXT.test(e.name)) continue // 其余文件（含普通 json / md）不参与"在用"判断
      try {
        out.push({ p, text: readFileSync(p, "utf8") })
      } catch (err) {
        /* 读不到就跳过：宁可少算消费者，也会在控制①那种"真在用却被判未用"上暴露 —— 但那由 --selftest 管 */
      }
    }
  }
  return out
}

/** 从一个源/配置文件里抽出"被引用的包名"集合（含子路径归并到包名）。 */
function namesIn(src) {
  const isPkgJson = src.p.endsWith("package.json")
  const isTsConfig = /(^|\/)tsconfig[^/]*\.json$/.test(src.p)
  const set = new Set()
  const add = (spec) => {
    if (!spec) return
    const s = String(spec).trim()
    if (!s || s.startsWith(".") || s.startsWith("/") || s.startsWith("node:")) return
    const parts = s.replace(/^@source\s*/, "").split(/[/?#\s]/)
    set.add(s.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0])
  }
  if (isPkgJson) {
    let j
    try {
      j = JSON.parse(src.text)
    } catch (e) {
      return set
    }
    // scripts 里的可执行名算消费者（`tailwindcss -i …`、`bun run build:client` 之类）
    for (const s of Object.values(j.scripts || {})) for (const m of String(s).matchAll(/([A-Za-z0-9@._/-]+)/g)) add(m[1])
    return set
  }
  if (isTsConfig) {
    for (const m of src.text.matchAll(/"([A-Za-z0-9@._/-]+)"/g)) add(m[1]) // types / extends / plugins 里的名字
    return set
  }
  for (const m of src.text.matchAll(/(?:from|require|import)\s*\(?\s*["']([^"']+)["']/g)) add(m[1])
  for (const m of src.text.matchAll(/export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g)) add(m[1])
  for (const m of src.text.matchAll(/@source\s+["']?([^\s"')]+)/g)) add(m[1])
  // ISS-777 后半 · 第四条通道：**`declare module "<pkg>"` 类型扩充**。它的写法不是 import，
  // 但把声明摘掉之后 TS 会把它从"扩充既有模块"退化成"凭空声明一个新模块"——**typecheck 照样 0 错，扩充却静默失效**
  // （实测过：摘掉 `@deepseek-ai/dsh-client-ui-slots` 后 forge-monitor 的 tsc 干净通过，而 slot-map.ts 的扩充已不生效）。
  // 所以这条必须算消费者，且是"看不见不等于没作用"的典型：宁可判成在用。
  for (const m of src.text.matchAll(/declare\s+module\s+["']([^"']+)["']/g)) add(m[1])
  // ── ISS-787：两条被我漏掉的真实取用通道（误判方向恰好是「可以删」，所以新通道一律**宁可判成在用**）──
  //  ① CSS 的 @import / @plugin / @config：Tailwind v4 的 `@import "tailwindcss/theme"` 与
  //     `@import "../../../forge-model/src/styles/tailwind-theme-extra.css"` 都是跨包取用，
  //     而上一版只认 @source ⇒ `tailwindcss`、`forge-model` 被判成"声明未用"并被摘掉。
  //     相对路径里的包名靠 cssDonors 抽（它同时认 node_modules/<pkg> 与 ../../../<pkg>/src 两种写法）。
  for (const m of src.text.matchAll(/@(?:import|plugin|config)\s+["']?([^\s"')]+)/g)) for (const n of cssDonors(m[1])) add(n)
  //  ② 构建脚本按路径直接取：three@0.172 的 exports map 不暴露 examples/jsm/*，
  //     `forge-cad/scripts/build-client.mjs` 只能 `resolve("node_modules/three", file)` ⇒ 静态 import 看不见。
  //     只扫代码文件（md/json 里提一句 node_modules 不算消费者）。
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(src.p)) for (const m of src.text.matchAll(/node_modules\/((?:@[\w.-]+\/[\w.-]+)|[\w.-]+)/g)) add(m[1])
  for (const m of src.text.matchAll(/\btypes\s*:\s*\[([^\]]*)\]/g)) for (const q of m[1].matchAll(/["']([^"']+)["']/g)) add(q[1])
  return set
}

/**
 * 纯判据（可注入 `resolveBin` ⇒ 自检不必依赖 node_modules）：
 * pkgs = [{name, deps, devDeps, sources:[{p,text}]}] ⇒ {orphans, cssOnly, devUnused, devUnknown, devUsedByRule}
 *
 * `devDependencies` 为什么不能与运行档同尺（这是本文件最重要的一条口径）：工具链是**按 bin 名**被调用的 ——
 * 声明 `@tailwindcss/cli`、scripts 里写的是 `tailwindcss`；`@types/*` 走的是环境声明，源码里只出现被声明类型的那个包名。
 * 拿"包名字面有没有出现在源码里"去量 dev 档，会把 117 条全判成孤儿，而误判方向恰好是"可以删"。
 * 三条解释规则（都用**精确匹配**，不用宽松子串 —— 宽松子串能把 117 条全解释掉，但那等于没有判据）：
 *  ① `@types/node` / `@types/bun` ⇒ 该包有 tsconfig 就算在用（环境声明，摘了 tsc 直接瞎）；
 *  ② `@types/<x>`（`@types/<scope>__<name>` 还原成 `<scope>/<name>`）⇒ 源码真 import 了 `<x>` 才算在用；
 *  ③ 其余 dev 件 ⇒ 读它自己 `package.json` 的 `bin` 名，只要有一个名字出现在**工具链调用面**里就算在用。
 *     ISS-777 后半把这条调用面从"只看 package.json 的 scripts 字段"**扩到"也包括 `<pkg>/scripts/*` 里的正文"**：
 *     8 个包的 `@tailwindcss/cli` 实际是在 `scripts/build-client.mjs` 里按 `./node_modules/.bin/tailwindcss` 调的，
 *     旧口径看不见它 ⇒ 把 8 条真在用的工具链判成"可摘"，这正是本判据最危险的那个误判方向。
 * 规则③里"读不到 bin"（没装依赖 / CI 上没 node_modules）⇒ 记 `devUnknown` 并**显式不判**，绝不把"看不见"当成"没用到"。
 */
function scanPackages(pkgs, opts = {}) {
  const resolveBin = opts.resolveBin || (() => null)
  const orphans = []
  const cssOnly = []
  const devUnused = []
  const devUnknown = []
  let devUsedByRule = 0
  for (const p of pkgs) {
    const all = new Set()
    const donors = new Set()
    let hasTsConfig = false
    for (const s of p.sources || []) {
      for (const n of namesIn(s)) all.add(n)
      if (/(^|\/)tsconfig[^/]*\.json$/.test(s.p)) hasTsConfig = true
      if (/\.(css|scss)$/.test(s.p)) for (const m of s.text.matchAll(/@source\s+["']?([^\s"')]+)/g)) for (const n of cssDonors(String(m[1]))) donors.add(n)
    }
    const scriptsText = (p.scripts || []).join(" ")
    // ISS-777 后半 · 第三条通道：**构建脚本内部按 bin 名调用**工具链。
    // 规则③原先只看 package.json 的 scripts 字段，于是 8 个包的 `@tailwindcss/cli` 被判成"没被调用"——
    // 而真正的调用点在 `<pkg>/scripts/build-client.mjs` 里（`const tailwindBin = "./node_modules/.bin/tailwindcss"`）。
    // 这类文件里的**注释也算命中**是故意的：这条判据的误判方向是"可以删"，宁可判成在用（同 ISS-787 的处置）。
    let toolText = scriptsText
    for (const s of p.sources || []) if (/(^|\/)scripts\//.test(s.p)) toolText += "\n" + s.text
    for (const dep of Object.keys(p.deps || {})) {
      if (all.has(dep)) continue
      if (donors.has(dep)) {
        cssOnly.push({ pkg: p.name, dep })
        continue
      }
      orphans.push({ pkg: p.name, dep })
    }
    for (const dep of Object.keys(p.devDeps || {})) {
      if (all.has(dep) || donors.has(dep)) continue
      const t = dep.match(/^@types\/(.+)$/)
      if (t) {
        if ((t[1] === "node" || t[1] === "bun") && hasTsConfig) {
          devUsedByRule++
          continue
        }
        const target = t[1].startsWith("_") ? t[1].slice(1) : t[1].replace("__", "/")
        if (all.has(target)) {
          devUsedByRule++
          continue
        }
        devUnused.push({ pkg: p.name, dep, why: "@types 的目标没被 import" })
        continue
      }
      const bins = resolveBin(p.name, dep)
      if (bins === null) {
        devUnknown.push({ pkg: p.name, dep })
        continue
      }
      // bin 名允许出现在路径尾部（`./node_modules/.bin/tailwindcss`）与命令行里（`tailwindcss -i …`），
      // 所以左边界要含 `/` 与 `.`，右边界要含 `/` 与引号/空白 —— 这样 `tailwindcss-merge` 不会被误算成 `tailwindcss`。
      if (bins.some((b) => new RegExp("(^|[\\s\"'&|;(/.])" + b.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "(?=$|[\\s\"'&|;)/,])").test(toolText))) {
        devUsedByRule++
        continue
      }
      devUnused.push({ pkg: p.name, dep, why: bins.length ? "bin " + bins.join(",") + " 未被 scripts 调用" : "无 bin，且源码没引用" })
    }
  }
  return { orphans, cssOnly, devUnused, devUnknown, devUsedByRule }
}

/** `@source "../node_modules/<pkg>/dist/x.js"` ⇒ 类供体是 <pkg>（scoped 包取两段）。这条通道摘了会静默少发类（ISS-771）。 */
function cssDonors(spec) {
  const clean = spec.replace(/["']/g, "")
  const i = clean.indexOf("node_modules/")
  const rest = i >= 0 ? clean.slice(i + "node_modules/".length) : clean
  const parts = rest.split("/").filter((x) => x && x !== "..") // 相对写法 `@source "../../../forge-design/src"` ⇒ 去掉 ../ 后首段就是包名
  if (!parts[0]) return []
  const name = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
  return [name]
}

// ── ISS-635 · 具名豁免名单：本文件**唯一一处**豁免入口（形态照 `scripts/lint-design.mjs` 的 CLASS_ALLOW）──
//
// 为什么必须有它：`orphans` 只回答"这条声明在本包源码里有没有被引用"。有一类声明**必然**在这个口径下落空、
// 却**不能删**：官方包把它自己的**运行期**依赖写进了 devDependencies（被当依赖安装时不会装），于是使用方
// 必须替它声明，而**使用方源码里永远不会出现那个包名**（是官方包的 lib 在 import）。
// 没有具名入口的话，过去的唯一出路是把基线 `ceiling` 从 0 改成 2（该棘轮已随 ISS-884 退休）—— 那是把棘轮往回拨：从此第 3、第 4 条同类
// 声明也被同一个数字悄悄接受，而这一格的全部职责就是"只拦新增"。
//
// 三条纪律（少一条就退化成"失明"或"化石"，两种本仓都栽过）：
//  ① **豁免只是"不判红"，不从候选集里消失**：count / byPkg / --verbose 一律照实报，理由与摘除条件随条目打出来。
//     把条目移出候选集 = 让"这两条还在不在"永久看不见（ISS-771 同族：看不见 ≠ 没有）。
//  ② **只按 `包 → 依赖` 整键精确匹配**：不是前缀、不是包级、不是"这个包里的都算" ⇒ 新攒的孤儿照样红。
//  ③ **条目 0 命中即报「该摘」并判红**：0 命中只有三种原因 —— 依赖被真删了 / 它变成真在用（那该走真通道，
//     不是豁免）/ **键写错了**。三种都该把条目摘掉，否则名单会长成谁也看不懂的化石
//     （`lint-design.mjs` 的 R9a 就是靠这条抓出自己写错的条目）。
//
// ⚠️ 加条目的门槛：先有"摘了就坏"的证据（报错原文 / 类型退化 / 构建差异），再写清**什么条件下可以摘**。
//    写不出摘除条件的豁免不许进这张表 —— 那是把判据变成"永远绿"。
const INSTALL_FACE_ALLOW = {
  "forge-ui → simple-icons": {
    why:
      "安装面入口 + 版本来源：官方 @deepseek-ai/dsh-client-ui-primitives 把运行期依赖全写在 devDependencies" +
      "（快照 0.2.1-rc.2 实测：dependencies 0 条 / devDependencies 26 条），而它 lib/index.js:28 运行期" +
      ' `import { siGithub, … } from "simple-icons"` ⇒ 被当依赖安装时不会装，只有使用方声明才装得到。' +
      "forge-ui 源码里不会出现这个包名（是官方包在 import），故静态判据必然报它未用。" +
      "实测摘掉 ⇒ 构建/测试出 3 处 `Cannot find package 'simple-icons'`。",
    until:
      "官方包把 simple-icons 挪回自己的 dependencies（或本仓采用的版本已修）⇒ 本条可摘。" +
      '复检：node -p "Object.keys(require(\'./forge-ui/node_modules/@deepseek-ai/dsh-client-ui-primitives/package.json\').dependencies||{})" —— ' +
      "输出里出现 simple-icons 即到期。",
  },
  "forge-ui → @deepseek-ai/dsh-client-store": {
    why:
      "安装面入口 + **版本钉**：官方 primitives 的 lib/index.js:35 运行期" +
      ' `import { createSnapshotStore } from "@deepseek-ai/dsh-client-store"`' +
      "（快照 0.2.1-rc.2，同 simple-icons 那条：dependencies 0 条 / 26 条全在 devDependencies，被当依赖安装时不会装）。" +
      "forge-ui 声明它同时把版本钉在与 primitives 同版；摘掉后改由传递依赖解析，版本可漂到别处 ⇒ " +
      "实测 3 处 TS 类型退化（不是 import 报错，是类型对不上）。",
    until:
      "官方包把 @deepseek-ai/dsh-client-store 挪回自己的 dependencies（同版 install-face 不再需要本仓兜底）⇒ 本条可摘。" +
      '复检：node -p "Object.keys(require(\'./forge-ui/node_modules/@deepseek-ai/dsh-client-ui-primitives/package.json\').dependencies||{})" ' +
      "输出里出现它即到期；到期后摘本条再跑 `cd forge-ui && bun run typecheck`（应 0 错）。",
  },
}

/**
 * 具名豁免的**纯判据**（名单可注入 ⇒ `--selftest` 不必依赖真实名单，且能造出"名单外新孤儿 / 条目 0 命中"两种反例）：
 *   orphans ⇒ { kept, exempt, stale }
 *  · kept   = 未命中名单 ⇒ **仍按绝对判据判红**（`over` 只算它：豁免绝不替别人兜底）；
 *  · exempt = 命中名单 ⇒ 仍是候选（调用方照实报 count/byPkg/--verbose），只是不判红，理由与摘除条件随条目带出；
 *  · stale  = 名单里 0 命中的键 ⇒ 必须报「该摘」并判红（纪律 ③，防化石）。
 */
function applyAllow(orphans, allow) {
  const kept = []
  const exempt = []
  const hit = new Set()
  for (const o of orphans) {
    const key = o.pkg + " → " + o.dep
    if (Object.hasOwn(allow, key)) {
      hit.add(key)
      exempt.push({ ...o, key, why: allow[key].why, until: allow[key].until })
    } else kept.push({ ...o, key })
  }
  const stale = Object.keys(allow).filter((k) => !hit.has(k))
  return { kept, exempt, stale }
}

/**
 * workspace 目录清单（相对 ROOT、统一 `/` 分隔）——两处声明并集，去重：
 *  ① 根 package.json 的 `workspaces`：bun 只认字面目录，26 个 forge-*（旧树）；
 *  ② pnpm-workspace.yaml 的 `packages:`：新树 glob `packages/<group>/<pkg>`（pnpm 语法）—— glob 逐段扫目录展开，
 *     **不把 glob 字面当目录名**（那会全部 `package.json` 不存在 ⇒ "无包可读⇒判不了"，探针实测）。
 * 不引入 yaml 依赖：只认 `packages:` 下缩进的 `- <pattern>` 这一小段，其余键（allowBuilds 等）忽略。
 */
function workspaceDirs() {
  const root = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  const dirs = []
  const add = (rel) => {
    const key = String(rel).split(path.sep).join("/").replace(/^\.\//, "")
    if (!dirs.includes(key)) dirs.push(key)
  }
  for (const w of root.workspaces || []) if (typeof w === "string" && !w.startsWith("!")) add(w)
  const yml = path.join(ROOT, "pnpm-workspace.yaml")
  if (existsSync(yml)) {
    let inPackages = false
    for (const line of readFileSync(yml, "utf8").split(/\r?\n/)) {
      if (/^\S/.test(line)) {
        inPackages = /^packages\s*:/.test(line)
        continue
      }
      if (!inPackages) continue
      const m = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(line)
      if (!m || m[1].startsWith("!")) continue
      const pattern = m[1]
      if (!/[*?]/.test(pattern)) {
        add(pattern)
        continue
      }
      // glob：逐段推进，`*`/`?` 只匹配一段目录名、不跨 `/`；纯目录扫描，不靠正则凑"包名".
      let cur = [ROOT]
      for (const seg of pattern.split("/")) {
        const next = []
        if (/[*?]/.test(seg)) {
          let re = "^"
          for (const ch of seg) re += ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          re += "$"
          const rx = new RegExp(re)
          for (const base of cur) {
            let ents
            try {
              ents = readdirSync(base, { withFileTypes: true })
            } catch (e) {
              continue
            }
            for (const e of ents) if (e.isDirectory() && !e.name.startsWith(".") && rx.test(e.name)) next.push(path.join(base, e.name))
          }
        } else {
          for (const base of cur) {
            const d = path.join(base, seg)
            if (existsSync(d)) next.push(d)
          }
        }
        cur = next
      }
      for (const d of cur) add(path.relative(ROOT, d))
    }
  }
  return dirs
}

function readWorkspaces() {
  const pkgs = []
  for (const w of workspaceDirs()) {
    const dir = path.join(ROOT, w)
    const pj = path.join(dir, "package.json")
    if (!existsSync(pj)) continue
    let j
    try {
      j = JSON.parse(readFileSync(pj, "utf8"))
    } catch (e) {
      continue
    }
    // 判据只覆盖 `dependencies`（运行期声明）。`peerDependencies` 同样不扫（ISS-884：cordis 是外部注入 peer，
    // 且 verify-plugin-shape 强制 peer+dev 并存）—— 见开头绝对判据四条边界①。`devDependencies` 走三条解释规则，
    // 因为工具链是按 **bin 名**被 scripts 调用的（声明 `@tailwindcss/cli`、脚本写 `tailwindcss`）、@types 走环境声明。
    pkgs.push({
      name: w,
      deps: { ...(j.dependencies || {}) },
      devDeps: { ...(j.devDependencies || {}) },
      scripts: Object.values(j.scripts || {}).map(String),
      sources: readSources(dir),
    })
  }
  return pkgs
}

/**
 * 读某个依赖自己声明的 bin 名；**读不到就返回 null ⇒ 这一档不判**（没装依赖的树/CI 上 node_modules 缺席是常态）。
 * ⚠️ 本仓是 bun workspace：依赖装在**各包自己的 node_modules**（根 `node_modules` 只有少数几件），
 *   所以解析要按 `<pkg>/node_modules/<dep>` 找，只查根目录会把 `typescript`、`@tailwindcss/cli` 全判成"读不到"
 *   （第一版就栽在这儿：44 条 dev 件因此进不了判据面）。
 */
const binCache = new Map()
function resolveBinFromDisk(pkgName, dep) {
  const key = pkgName + "::" + dep
  if (binCache.has(key)) return binCache.get(key)
  const places = [path.join(ROOT, pkgName, "node_modules", dep), path.join(ROOT, "node_modules", dep)]
  for (const base of places) {
    const pj = path.join(base, "package.json")
    if (!existsSync(pj)) continue
    let j
    try {
      j = JSON.parse(readFileSync(pj, "utf8"))
    } catch (e) {
      continue
    }
    let bins
    if (!j.bin) bins = []
    else if (typeof j.bin === "string") bins = [String(j.name || dep).replace(/^@[^/]+\//, "")]
    else bins = Object.keys(j.bin)
    binCache.set(key, bins)
    return bins
  }
  binCache.set(key, null)
  return null
}

function selftest() {
  const cases = []
  const push = (n, ok) => cases.push({ n, ok })
  const P = (deps, sources) => [{ name: "p", deps, sources }]
  // 控制①（正向·最关键）：真 import 了 ⇒ 绝不许判"未用"（这条判据坏过一次，把真在用的判成孤儿最危险）
  const a = scanPackages(P({ "@radix-ui/react-dialog": "1", clsx: "1" }, [{ p: "/x/a.ts", text: 'import { Dialog } from "@radix-ui/react-dialog"\nimport c from "clsx"' }]))
  push("控制①：源文件真 import ⇒ 不判未用（正向）", a.orphans.length === 0)
  // 控制②（反向）：声明了且全包无任何引用 ⇒ 判未用
  const b = scanPackages(P({ "some-unused": "1" }, [{ p: "/x/a.ts", text: 'import { Dialog } from "react"' }]))
  push("控制②：无人引用 ⇒ 判未用（反向）", b.orphans.length === 1 && b.orphans[0].dep === "some-unused")
  // 控制③：CSS `@source` 类供体 ⇒ 单列一档，不混进"可摘候选"（摘了会静默少发类 = ISS-771）
  const c = scanPackages(P({ "pkg-donor": "1", "real-orphan": "1" }, [{ p: "/x/a.css", text: '@source "../node_modules/pkg-donor/dist/index.js";\n@tailwind utilities;' }]))
  push("控制③：只在 CSS @source 出现 ⇒ 进 cssOnly 不进 orphans", c.cssOnly.length === 1 && c.cssOnly[0].dep === "pkg-donor" && c.orphans.length === 1 && c.orphans[0].dep === "real-orphan")
  const cs = scanPackages(P({ "@scope/donor": "1" }, [{ p: "/x/a.css", text: '@source "../node_modules/@scope/donor/dist/index.js";' }]))
  push("控制③b：scoped 包的 @source 取两段名", cs.cssOnly.length === 1 && cs.cssOnly[0].dep === "@scope/donor")
  // 控制④：bun.lock 那种"照抄声明"不进消费者 —— 用 .json 文件模拟：普通 json 里提到包名 ⇒ 仍判未用
  const d = scanPackages(P({ "doc-only": "1" }, [{ p: "/x/registry-report.json", text: '{"doc-only":true}' }]))
  push("控制④：文档/清单类 json 提到名字 ⇒ 不算在用（恒真判据的形状）", d.orphans.length === 1)
  // 控制⑤：tsconfig 的 types 与 scripts 里的工具名算消费者
  const e = scanPackages(P({ "@types/node": "1", tailwindcss: "1" }, [{ p: "/x/tsconfig.json", text: '{"compilerOptions":{"types":["node"]}}' }, { p: "/x/package.json", text: '{"scripts":{"build":"tailwindcss -i a.css -o b.css"}}' }]))
  push("控制⑤：tsconfig types / package scripts 算在用", e.orphans.filter((o) => o.dep === "tailwindcss").length === 0)
  // 控制⑥：子路径 import 归并到包名（`forge-design/ui/cn` 用的是 forge-design）
  const f = scanPackages(P({ "forge-design": "1" }, [{ p: "/x/a.tsx", text: 'import { cn } from "forge-design/ui/cn"' }]))
  push("控制⑥：子路径引用归并到包名", f.orphans.length === 0)
  // —— dev 档：三条解释规则 + "读不到 bin 就整档不判"（正反都要有牙）
  const dvBin = scanPackages([{ name: "p", deps: {}, devDeps: { "@tailwindcss/cli": "1" }, scripts: ["tailwindcss -i a.css -o b.css"], sources: [{ p: "/x/package.json", text: "{}" }] }], { resolveBin: () => ["tailwindcss"] })
  push("控制⑦：dev 件的 bin 名被 scripts 调用 ⇒ 不判未用（正向）", dvBin.devUnused.length === 0 && dvBin.devUsedByRule === 1)
  const dvTypes = scanPackages([{ name: "p", deps: {}, devDeps: { "@types/react": "1" }, scripts: [], sources: [{ p: "/x/a.ts", text: "import React from \"react\"" }] }], { resolveBin: () => [] })
  push("控制⑧：@types/<x> 且源码真 import 了 x ⇒ 不判未用", dvTypes.devUnused.length === 0 && dvTypes.devUsedByRule === 1)
  const dvAmb = scanPackages([{ name: "p", deps: {}, devDeps: { "@types/node": "1" }, scripts: [], sources: [{ p: "/x/a.ts", text: "import fs from \"node:fs\"" }] }], { resolveBin: () => [] })
  push("控制⑨a：无 tsconfig 时 @types/node 不套环境豁免（该判就判）", dvAmb.devUnused.length === 1)
  const dvAmb2 = scanPackages([{ name: "p", deps: {}, devDeps: { "@types/node": "1" }, scripts: [], sources: [{ p: "/x/tsconfig.json", text: "{\"compilerOptions\":{}}" }] }], { resolveBin: () => [] })
  push("控制⑨b：有 tsconfig ⇒ @types/node 算环境声明（不误判）", dvAmb2.devUnused.length === 0 && dvAmb2.devUsedByRule === 1)
  const dvUnk = scanPackages([{ name: "p", deps: {}, devDeps: { "mystery-kit": "1" }, scripts: [], sources: [] }], { resolveBin: () => null })
  push("控制⑩：bin 读不到 ⇒ 记 devUnknown（显式不判），不当成孤儿", dvUnk.devUnknown.length === 1 && dvUnk.devUnused.length === 0)
  const dvBad = scanPackages([{ name: "p", deps: {}, devDeps: { "some-tool": "1" }, scripts: ["echo nothing"], sources: [] }], { resolveBin: (_pkg, d) => (d === "some-tool" ? ["st"] : null) })
  push("控制⑪：有 bin 但 scripts 没调用 ⇒ 判未用（反向）", dvBad.devUnused.length === 1 && /bin st/.test(dvBad.devUnused[0].why))
  // ── 控制⑫/⑬：ISS-787 补的两条通道（这两条不补，`tailwindcss`/`three`/`forge-model` 会被判成可摘）──
  const impCss = scanPackages(P({ tailwindcss: "1", "forge-model": "1" }, [{ p: "/x/src/styles/tailwind-input.css", text: '@import "tailwindcss/theme" source(none);\n@import "../../../forge-model/src/styles/tailwind-theme-extra.css";' }]))
  push("控制⑫a：CSS 的 @import（裸包名 + 相对跨包两种写法）⇒ 算在用（正向）", impCss.orphans.length === 0)
  const impPath = scanPackages(P({ three: "1" }, [{ p: "/x/scripts/build-client.mjs", text: 'return { path: resolve("node_modules/three", file) }' }]))
  push("控制⑫b：构建脚本按 node_modules/<pkg> 路径取用 ⇒ 算在用（正向）", impPath.orphans.length === 0)
  const impNeg = scanPackages(P({ "phantom-pkg": "1" }, [{ p: "/x/notes.json", text: '{"see":"node_modules/phantom-pkg 里读过"}' }, { p: "/x/a.ts", text: "export const x = 1" }]))
  push("控制⑬：同样的字符串只在 json 里出现 ⇒ 不算在用（防新通道开成恒真）", impNeg.orphans.length === 1 && impNeg.orphans[0].dep === "phantom-pkg")
  // ── 控制⑭/⑮：ISS-777 后半补的两条（不补就会把 8 条工具链与 3 条类型扩充判成可摘）──
  const devBinInScript = scanPackages(
    [{ name: "p", deps: {}, devDeps: { "@tailwindcss/cli": "1", "unused-kit": "1" }, scripts: ["bun scripts/build-client.mjs"], sources: [{ p: "/x/scripts/build-client.mjs", text: 'const tailwindBin = "./node_modules/.bin/tailwindcss"' }] }],
    { resolveBin: (_p, d) => (d === "@tailwindcss/cli" ? ["tailwindcss"] : d === "unused-kit" ? ["kit-noone"] : null) },
  )
  push("控制⑭a：dev 件的 bin 名只出现在包内 scripts/ 正文 ⇒ 算在用（正向）", !devBinInScript.devUnused.some((x) => x.dep === "@tailwindcss/cli") && devBinInScript.devUsedByRule === 1)
  // ⚠️ 反向控制写成**恰好一条**：上一版这里是 `devUnused.length === 0 || 含 unused-kit`，
  //    前半截在"通道开成恒真"时恰好成立 ⇒ 这条控制自己就是恒绿的（同 ISS-787 的坏法，被我自己又犯了一次）。
  push("控制⑭b：同包里真没人调的 dev 件照样判未用（反向，防通道开成恒真）", devBinInScript.devUnused.length === 1 && devBinInScript.devUnused[0].dep === "unused-kit")
  const declMod = scanPackages(P({ "@deepseek-ai/dsh-client-ui-slots": "1", "no-augment": "1" }, [{ p: "/x/src/dsh/slot-map.ts", text: 'declare module "@deepseek-ai/dsh-client-ui-slots" {\n  interface Slots { a: string }\n}' }]))
  push("控制⑮：`declare module \"<pkg>\"` 类型扩充 ⇒ 算消费者（摘了会静默失效，不是报错）", declMod.orphans.length === 1 && declMod.orphans[0].dep === "no-augment")
  // ── 控制⑯~⑲（ISS-635）：具名豁免机制的三条牙 —— 与本单三条变异验证一一对应，缺一条机制就退化成"失明"或"化石" ──
  const allowSample = {
    "p → keep-me": {
      why: "官方包把运行期依赖写进自己的 devDeps，使用方必须替它声明（摘了 Cannot find package）",
      until: "官方包把它挪回 dependencies",
    },
  }
  const e1 = applyAllow(
    [
      { pkg: "p", dep: "keep-me" },
      { pkg: "p", dep: "brand-new-orphan" },
    ],
    allowSample,
  )
  push(
    "控制⑯a：命中名单 ⇒ 进 exempt，且**仍在候选里**（kept+exempt = 全部候选，count 不缩小），理由与摘除条件随条目带出",
    e1.exempt.length === 1 && e1.exempt[0].key === "p → keep-me" && !!e1.exempt[0].why && !!e1.exempt[0].until && e1.kept.length + e1.exempt.length === 2,
  )
  push("控制⑯b：豁免不顺带豁免别人 —— 同包新攒的孤儿照进 kept（判红）", e1.kept.length === 1 && e1.kept[0].dep === "brand-new-orphan")
  const e2 = applyAllow([{ pkg: "q", dep: "keep-me" }], allowSample)
  push("控制⑰：键含包名 —— 别的包声明同名依赖不算命中（kept 照判 + 原条目进 stale）", e2.kept.length === 1 && e2.exempt.length === 0 && e2.stale.length === 1)
  const e3 = applyAllow([], allowSample)
  push("控制⑱：名单条目 0 命中 ⇒ 进 stale（报「该摘」，防化石）", e3.stale.length === 1 && e3.stale[0] === "p → keep-me" && e3.exempt.length === 0)
  push(
    "控制⑲：真实名单自身合规 —— 每条键形如 `包 → 依赖`、有 why（≥20 字）与 until（摘除条件，写不出就不许进表）",
    Object.entries(INSTALL_FACE_ALLOW).every(([k, v]) => k.includes(" → ") && String((v && v.why) || "").length >= 20 && !!(v && v.until)),
  )
  const bad = cases.filter((x) => !x.ok)
  console.log(bad.length ? "✗ 自检失败：" + bad.map((x) => x.n).join(" / ") : `✓ ${cases.length}/${cases.length} 项控制通过：正向不误判、反向抓得到、@source 与 json 两档不混`)
  process.exit(bad.length ? 1 : 0)
}

if (A.includes("--selftest")) selftest()

let pkgs
try {
  pkgs = readWorkspaces()
} catch (e) {
  console.log("! 读不到 workspace 结构（" + String((e && e.message) || e).slice(0, 70) + "）⇒ 判不了，不冒充 0")
  process.exit(2)
}
if (!pkgs.length) {
  console.log("! 没有任何 workspace 包可读 ⇒ 判不了（这不是「没有孤儿」）")
  process.exit(2)
}
const { orphans, cssOnly, devUnused, devUnknown, devUsedByRule } = scanPackages(pkgs, { resolveBin: resolveBinFromDisk })
const byPkg = {}
for (const o of orphans) byPkg[o.pkg] = (byPkg[o.pkg] || 0) + 1
// ⚠️ 豁免**从候选集里扣不出任何东西**：`orphans` / `byPkg` / count 全部照实，豁免只作用在"判红"这一格
//    —— `reds` 才是绝对判据（`reds.length === 0`）判的那一列（ISS-635，见 INSTALL_FACE_ALLOW 上方三条纪律）。
const allow = applyAllow(orphans, INSTALL_FACE_ALLOW)
const reds = allow.kept
const exemptKeys = new Set(allow.exempt.map((e) => e.key))
// dev 档**整档一起判**：只要有一条读不到 bin，这一档就不判 —— 半判比不判更坏（会让人以为 dev 档已经干净）。
const devJudged = devUnknown.length === 0

if (A.includes("--write")) {
  // dev 档**故意不录上限**（devCeiling 恒为 null）：规则③还没覆盖"宿主运行期注入"与"构建脚本内按名调用"两类真用法，
  // 拿带已知误判的集合去卡红 = 造风；等这两类口径补严再开这一格（届时的录法：只在 devUnknown=0 的树上录）。
  const devCeiling = null
  const body = {
    recordedAt: new Date().toISOString(),
    // ISS-884：ceiling 棘轮退休 —— 绝对判据"未用依赖=0"不跟基线比总数，基线只留读数与清单。
    count: reds.length, // 未豁免未用依赖（绝对判据读数，必须为 0）
    candidateCount: orphans.length, // 候选总数照实报（含具名豁免）—— 不许用"豁免掉"来假装干净
    cssOnly: cssOnly.length,
    devCeiling,
    devCount: devUnused.length,
    devUnknown: devUnknown.length,
    devUsedByRule,
    devItems: devUnused.map((o) => `${o.pkg} → ${o.dep}（${o.why}）`),
    byPkg,
    items: reds.map((o) => o.pkg + " → " + o.dep),
    exemptItems: allow.exempt.map((o) => `${o.key}（具名豁免：见 scripts/deps-hygiene.mjs 的 INSTALL_FACE_ALLOW）`),
    note: "ISS-884：ceiling 棘轮已退休，判据改绝对口径『未用依赖=0』（未豁免候选须为 0）。count = 未豁免未用依赖（须 0），candidateCount = 候选总数（含具名豁免，不从统计消失），items/exemptItems 逐条带理由与摘除条件（ISS-635：豁免只免判红，不减候选）。dev 档需三条精确规则（@types 环境豁免 / @types 目标被 import / bin 名被 scripts 调用），任一读不到 bin 就整档不判。",
  }
  writeFileSync(BASE, JSON.stringify(body, null, 2))
  console.log(`✓ 基线已存 scripts/baseline/deps-hygiene.json（运行档候选 ${orphans.length} / 其中具名豁免 ${allow.exempt.length} / 未豁免未用 ${reds.length}（绝对判据须 0）· dev 档 ${devUnused.length} / 上限 ${body.devCeiling === null ? "不判" : body.devCeiling} · @source ${cssOnly.length} · bin 读不到 ${devUnknown.length}）`)
  process.exit(0)
}
const base = existsSync(BASE) ? JSON.parse(readFileSync(BASE, "utf8")) : null
const devCeiling = base ? base.devCeiling ?? null : null
// ISS-884：ceiling 退休 —— 绝对判据"未用依赖=0"：未豁免候选 `reds` 必须为 0，与基线总数无关。
const over = reds.length !== 0
const devOver = devJudged && devCeiling !== null && devUnused.length > devCeiling
// 名单过期（0 命中）= 该摘 ⇒ 与"新增违例"同档判红，不许静默（纪律 ③）。
const allowStale = allow.stale.length > 0
if (A.includes("--json")) {
  console.log(
    JSON.stringify({
      count: reds.length, // 未豁免未用依赖（绝对判据读数，须 0）
      candidateCount: orphans.length, // 候选总数（含具名豁免，不从统计消失）
      redCount: reds.length,
      judge: "unused=0",
      exempt: allow.exempt.map((o) => ({ key: o.key, why: o.why, until: o.until })),
      staleAllow: allow.stale,
      cssOnly: cssOnly.length,
      devCount: devUnused.length,
      devCeiling,
      devJudged,
      devUnknown: devUnknown.length,
      devUsedByRule,
      byPkg,
      items: orphans,
      devItems: devUnused,
    }),
  )
  process.exit(over || devOver || allowStale ? 1 : 0)
}
const devReadout = !devJudged
  ? `dev 档**不判**：${devUnknown.length} 条读不到依赖自己的 bin（没装依赖的树 / CI 常态），半判比不判更坏`
  : `dev 档候选 ${devUnused.length} 条（规则解释掉 ${devUsedByRule} 条）—— **只报不判**：这一档还剩两类静态看不见的真用法：` +
    "`@deepseek-ai/cordis` 由 DSH 宿主在运行期注入（B4 形态，源码里根本不出现）；`@deepseek-ai/dsh-client-ui-*` 是**安装面入口**" +
    "（本包不 import 它，但别包/别处的 `declare module` 扩充要靠它被装进来才解析得到 —— 见开头教训 ③）"
console.log(`依赖卫生 · dependencies 声明未用（未豁免）${reds.length} 条 / 绝对判据须 0 · 候选总数 ${orphans.length} 条 · 具名豁免 ${allow.exempt.length} 条（只免判红，候选照实报）· CSS @source 供体 ${cssOnly.length} 条（不混进候选）· ${devReadout}`)
for (const [p, n] of Object.entries(byPkg).sort((x, y) => y[1] - x[1])) console.log(`  · ${p.padEnd(22)} ${n} 条`)
// 豁免条目逐条打出来（纪律 ①：条目**仍在候选里**，只是这一格不判红）—— 理由与摘除条件就在行上，不看源码也知道为什么留着。
if (allow.exempt.length) {
  console.log(`  ○ 具名豁免 ${allow.exempt.length} 条（仍在候选集里，不判红；名单 = scripts/deps-hygiene.mjs 的 INSTALL_FACE_ALLOW）`)
  for (const o of allow.exempt) console.log(`      ◇ ${o.key}｜为什么不能删：${o.why}｜摘除条件：${o.until}`)
}
if (A.includes("--verbose")) {
  for (const o of orphans) console.log(`      运行档 ${o.pkg} → ${o.dep}${exemptKeys.has(o.pkg + " → " + o.dep) ? "（具名豁免）" : ""}`)
  for (const o of devUnused) console.log(`      dev 档 ${o.pkg} → ${o.dep}（${o.why}）`)
  for (const o of devUnknown) console.log(`      不判 ${o.pkg} → ${o.dep}（bin 读不到）`)
}
if (over) console.log(`  ✗ 运行档未豁免未用依赖 ${reds.length} 条（绝对判据 unused=0）—— 点名见 --verbose；删了使用者就要删声明（B4 那类先核宿主注入面）`)
if (devOver) console.log(`  ✗ dev 档比上限多 ${devUnused.length - devCeiling} 条 —— 同样只拦新增（规则解释掉的不算）`)
// ISS-635：名单条目 0 命中 = 该摘（依赖已被真删 / 已变真在用 / 键写错），与"新增违例"同档判红 ——
// 化石名单比没有名单更坏：它会让下一个人以为"这一条确实需要豁免"，从而照抄一个已经作废的理由。
if (allowStale) console.log(`  ✗ 具名豁免名单过期 ${allow.stale.length} 条（该摘）：${allow.stale.join(" / ")} —— 0 命中 = 依赖已被真删 / 已变成真在用 / 键写错，三种都该把条目摘出 INSTALL_FACE_ALLOW`)
// ISS-635：超上限 = 新增违例 ⇒ exit 1（进守卫退出码）；未超上限的条数漂移 ⇒ 0（只报）；
// 没有基线 ⇒ 2（判不了：不是绿，也不是回归）—— 与上面第 53 行的三态声明同一条口径。
if (!base) {
  console.log("  ! 无基线 ⇒ 判不了（不是「没问题」）；录基线：node scripts/deps-hygiene.mjs --write")
  process.exit(2)
}
if (!over && !devOver && !allowStale) console.log(`  ✓ 运行档未豁免未用依赖 0 条（绝对判据 unused=0）${allow.exempt.length ? `；另 ${allow.exempt.length} 条具名豁免已具名接受，候选总数仍报 ${orphans.length}` : ""}。候选 ≠ 可直接摘：终判口径 = 干净克隆 + \`bun install --frozen-lockfile\` + 全量 ci-local（主 checkout 全绿不算证据，见开头教训 ③④）`)
process.exit(over || devOver || allowStale ? 1 : 0)
