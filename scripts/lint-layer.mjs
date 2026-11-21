#!/usr/bin/env node
// scripts/lint-layer.mjs
// 分层契约门禁（ISS-697 · P0）—— 「依赖只能向下」从口头规矩变成机器会拦的断言。
//
// ## 为什么要有这条
//   `specs/architecture-layered-redesign-2026-11-06.md` 实测：目标分层其实已经长出来了
//   （入度 service-kit 17 / design 10 / ui 7，场景插件零业务包依赖），只是**没被声明**。
//   已有守卫 `forge-agents/lib/package-shape.test.js:39-82`（ISS-632）只挡「agents 不反向 import pm」
//   这一条边，换个包就没有门禁。本脚本把「层号 × 允许方向」做成通用判据。
//
// ## 判据（四条，判定单位 = 一条真实 import 语句）
//   LAYER-REVERSE  ⛔ 低层 import 高层（src < dst）⇒ 红。
//   LAYER-SAME    ⛔ 同层横向 import（src === dst）⇒ 红。存量如实登记在 baseline，新增即红。
//   LAYER-UNJUDGED⛔ 目标包不在层表 ⇒ 红。**不许静默当绿**（覆盖完整性，判据射程不够=假绿）。
//   LAYER-SUBPATH ⛔ subpathLayers 登记的键必须在目标包 package.json 的 exports 里真实存在 ⇒ 否则判红。
//                   （P1：防「随便给子路径贴个 L1 就把反向依赖洗白」——守卫自己也要有牙。）
//   LAYER-PHANTOM ⛔ layers 登记的每个包必须在仓库根目录下真实存在（同名目录 + package.json）⇒ 否则判红。
//                   （ISS-700：与 LAYER-UNJUDGED 成对——一条管「扫到未登记的包」，一条管
//                    「登记了不存在的包」。缺了这条，层表可以是化石而门禁继续绿：
//                    `forge-dsh-models` 登记为 L1，仓库根目录却从来没有这个目录。）
//                   ISS-701 起**键 = 包名**：目录名与 package.json 的 `name` 必须都等于键
//                   （原先 PHANTOM 把键当目录名判、judge() 把键当包名用，两处口径分裂）。
//   ✅ 允许且仅允许严格向下（src > dst）。
//
// ## ISS-701：四个射程缺口（两路独立审查各撞一遍，结论一致）
//   A 接线测不到：`--selftest` 只测纯函数 `judge()`，看不见 `buildLint()` 真正用的 rules 数组
//     ⇒ 摘掉一条规则、或把 check 换成 `() => []`，selftest 照样全绿。现在规则表由 `makeRules(ctx)`
//     产出，selftest 直接对**规则表本身**断言（id 集合 / level / 每条在构造违规上真的产出命中）。
//   B 包的身份由前缀定：`PKG_RE = /^forge-[a-z-]+/` 只认 `forge-` 前缀，而契约登记了
//     `electron-shell: 1` ⇒ 那 30 个源文件从不进扫描面，在里面注入 L1→L4 仍全绿。
//     现在扫描面与目标解析都由「仓库事实 + 契约」定（见 `knownPackages`）。
//   C 层表键口径分裂（见上 LAYER-PHANTOM 注）。
//   D waiver 是文件级 ⇒ 已豁免文件是**不设防区**：在 `forge-model/lib/store/bridge.js` 里新加一条
//     横向依赖仍然绿。现在 waiver 支持可选 `match`（对 detail 做子串匹配），14 条 LAYER-SAME 逐条登记。
//     ⚠️ `match` 缺省 = 旧行为（文件级），向后兼容 —— 但新登记一律带 match。
//
// ## P1：子路径层号（老板 2026-11-06 拍「细化契约」）
//   一个包可以同时有两种身份：host 半是 L4 场景插件，某个 exports 子路径却是被上层复用的
//   L1 UI 原语。`forge-mermaid/mermaid-block` 就是这种 —— PM(L3) 与 repowiki(L4) 借的是
//   纯渲染组件，不是场景能力。按包整体判层会把这种合法复用误判成反向依赖。
//   物理下沉仍留既有 P5 / E-1 同批（`docs/memory/p2-dep-edges-2026-10-04.md` §八 面 D）：
//   单搬组件会牵出 viewer.ts 与 chat-enhance.ts 的共享，范围会膨胀（ISS-675 教训）。
//
// ## 为什么不自己写剔注释/扫目录
//   · 骨架（规则表 + 带理由白名单 + 双向失效检测 + 退出码）复用 `scripts/lint-common.mjs`；
//   · 输入集合复用 `scripts/scan-input.mjs` 的 `trackedSet`（只量已入库文件，ISS-742）；
//   · import 提取走 **TypeScript AST**（与 `lexical-lib.mjs` 同一套引擎口径）：
//     `ts.createSourceFile` + Import/Export/CallExpression，注释、模板串、正则字面量里的
//     `/from "forge-pm/`、`require("forge-pm-editor")` 天然不算依赖。首版逐行正则被这三类
//     假 import 误伤 5 条（ISS-697 首扫实测）——本仓「别手搓词法层」的又一次验证。
//
// ## 故意不提供 --write
//   自动把新违规写进基线 = 门禁自废。收线只有一条路：人工修掉依赖 → 从 `layer-contract.json`
//   摘掉对应 waiver；摘慢了 `lint-common` 的 stale 检测会催（化石不能留）。
//
// ## 用法
//   node scripts/lint-layer.mjs --check        # 门禁主入口，输出 verdict=green|red
//   node scripts/lint-layer.mjs --json        # 结构化结果（测试/排查用）
//   node scripts/lint-layer.mjs --selftest    # 反向验证：该红能红、不该红的不红
//   node scripts/lint-layer.mjs --check --root <临时副本>   # 变异验证用，不污染工作树
//
// ⚠️ 本脚本只改本地门禁层，不碰 host/client 半 ⇒ 不需 build:host、不重启 3210。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createLint } from './lint-common.mjs'

// ⚠️ `scan-input.mjs` 在**模块加载时**按 `process.argv` 自带一次自检（--selftest 会触发）。
// 本门禁的 --selftest 不该把别人的自检打印进自己的输出 ⇒ 改成按需动态加载，
// 且只在 --check / --json 路径加载（selftest 不需要 trackedSet）。
let trackedSetFn = null

const requireCjs = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, '..')
const CONTRACT_REL = 'scripts/baseline/layer-contract.json'
const SRC_RE = /\.(js|mjs|cjs|ts|tsx|cts|mts)$/
const SKIP_DIR = /\/(dist|out|build|node_modules|__pycache__|static|preview|vendor|coverage)\//
const TS_CANDS = ['forge-ui/node_modules/typescript/lib/typescript.js', 'forge-pm/node_modules/typescript/lib/typescript.js']

/** AST 解析器是工具、不是被扫描对象：副本里没有 node_modules 时回退到脚本所在仓，不静默降级。 */
function loadTs(root) {
  for (const base of [root, DEFAULT_ROOT]) {
    for (const c of TS_CANDS) {
      const p = path.join(base, c)
      if (fs.existsSync(p)) return requireCjs(p)
    }
  }
  return null
}

/**
 * 包的**身份**从哪来：仓库根目录下的真实包（目录含 package.json）+ 契约层表的键。
 *
 * ISS-701 · 缺口 B：原先靠 `PKG_RE = /^forge-[a-z-]+/` 这个前缀认包 —— 契约登记了
 * `electron-shell: 1`，那批源文件却从不进扫描面（在里面注入 L1→L4 反向依赖仍然全绿）。
 * 前缀不是身份，契约与仓库事实才是。
 *
 * ⚠️ 为什么**不**只认 `contract.layers` 的键（工单初稿的写法）：那样 LAYER-UNJUDGED 会变成死规则 ——
 *   目标包不在集合里就没有边，没有边就永远判不出「目标包不在层表」。目标侧必须认「仓库里真实的包」，
 *   「有包但没登记层号」才仍然能红（这正是 LAYER-UNJUDGED 的全部射程）。
 *   副作用：未登记的**新包**其出边也进扫描面 ⇒ 它一旦 import 登记过的包，当场 UNJUDGED 判红，
 *   逼你登记而不是静默混过去；`@deepseek-ai/*` / `node:` / `electron` / 相对路径都不在集合里，自然跳过。
 */
function knownPackages(root, layers) {
  const names = new Set(Object.keys(layers || {}))
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return names }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const manifest = path.join(root, e.name, 'package.json')
    if (!fs.existsSync(manifest)) continue
    names.add(e.name)
    // 目录名与 package.json 的 name 都算（本仓 `vscode-dsh-models/` 的 name 是 `forge-dsh-models`）：
    // 只认目录名会让「import 它」的边静默消失，那比判红更坏。
    try {
      const n = JSON.parse(fs.readFileSync(manifest, 'utf8')).name
      if (typeof n === 'string' && n) names.add(n)
    } catch { /* 坏 manifest：目录名仍算包；能否登记由 LAYER-PHANTOM 判 */ }
  }
  return names
}

/** 取 import specifier 的包名：scoped 包取前两段（`@scope/name`），其余取第一段。
 *  名字不在 `knownPackages` 里 ⇒ 不是本仓的包（`node:fs` / `electron` / 相对路径 / `@deepseek-ai/*`），跳过。 */
function pkgOfSpec(text) {
  const parts = String(text || '').split('/')
  if (!parts[0]) return ''
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** 输入集合：只量已入库文件；拿不到 git（临时副本）⇒ 走目录遍历并显式报降级，不静默出空集。 */
function sourceFiles(root, pkgs) {
  if (!trackedSetFn) throw new Error('trackedSet 未加载（CLI 应只在 --check/--json 路径调 buildLint）')
  const tracked = trackedSetFn(root)
  const accept = (rel) => pkgs.has(rel.split('/')[0]) && SRC_RE.test(rel) && !SKIP_DIR.test('/' + rel)
  const out = []
  if (tracked.all) {
    const walk = (dir) => {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || /^(dist|out|build|__pycache__)$/.test(e.name)) continue
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else {
          const rel = path.relative(root, abs).split(path.sep).join('/')
          if (accept(rel)) out.push(abs)
        }
      }
    }
    walk(root)
  } else {
    for (const rel of tracked) if (accept(rel)) out.push(path.join(root, rel))
  }
  return { files: out.sort(), degraded: tracked.all }
}

/**
 * 用 TypeScript AST 扫真实 import 语句。
 * 覆盖：具名/多行/副作用 import、export ... from、import("x")、require("x")、import type。
 * 注释、模板串、正则字面量里的同名文本一律不算（AST 天然排除，不靠正则猜）。
 */
function scanEdges(files, read, rel, ts, pkgs) {
  const edges = []
  const kindOf = (f) => f.endsWith('.tsx') ? ts.ScriptKind.TSX
    : /\.(ts|mts|cts)$/.test(f) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  for (const abs of files) {
    const src = read(abs)
    if (!src) continue
    const srcPkg = rel(abs).split('/')[0]
    if (!pkgs.has(srcPkg)) continue
    const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, kindOf(abs))
    const push = (spec, node) => {
      const text = String(spec || '')
      const dst = pkgOfSpec(text)
      if (!dst || dst === srcPkg || !pkgs.has(dst)) return
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      // spec 保留完整子路径（如 forge-mermaid/mermaid-block），子路径层号靠它命中；
      // 只留包名会把「借一个 L1 原语」和「依赖整个 L4 插件」混成同一件事。
      edges.push({ src: srcPkg, dst, spec: text, file: rel(abs), line })
    }
    const walk = (n) => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
        const mod = n.moduleSpecifier
        if (mod && ts.isStringLiteral(mod)) push(mod.text, n)
      }
      if (ts.isImportTypeNode(n) && n.argument && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
        push(n.argument.literal.text, n)
      }
      if (ts.isCallExpression(n) && n.arguments.length && ts.isStringLiteral(n.arguments[0])) {
        const e = n.expression
        if ((ts.isIdentifier(e) && e.text === 'require') || e.kind === ts.SyntaxKind.ImportKeyword) push(n.arguments[0].text, n)
      }
      ts.forEachChild(n, walk)
    }
    walk(sf)
  }
  return edges
}

/** 纯判定：给边与层表（含子路径层号），分三类。null 层号 = 判不了，进 unjudged，不许当绿。 */
function judge(edges, layers, subpathLayers = {}) {
  const reverse = []
  const same = []
  const unjudged = []
  for (const e of edges) {
    const s = layers[e.src]
    const hasSub = Object.prototype.hasOwnProperty.call(subpathLayers, e.spec)
    const d = hasSub ? subpathLayers[e.spec] : layers[e.dst]
    const tag = hasSub ? `（子路径原语 L${d}：${e.spec}）` : ''
    if (s == null || d == null) {
      unjudged.push({ ...e, detail: `包/子路径不在层表：${e.src}(L${s ?? '?'}) → ${e.spec}（L${d ?? '?'}）` })
    } else if (s < d) {
      reverse.push({ ...e, detail: `反向依赖 L${s}→L${d}${tag}：${e.src} → ${e.spec}` })
    } else if (s === d) {
      same.push({ ...e, detail: `同层横向 L${s}→L${d}${tag}：${e.src} → ${e.spec}` })
    }
  }
  return { reverse, same, unjudged }
}

/** 守卫：登记的子路径必须真在目标包 package.json 的 exports 里（支持 `./ui/*` 这类通配）。 */
function verifySubpath(root, spec) {
  const parts = String(spec).split('/')
  if (parts.length < 2) return false
  const pkg = parts[0]
  const sub = './' + parts.slice(1).join('/')
  const manifest = path.join(root, pkg, 'package.json')
  if (!fs.existsSync(manifest)) return false
  let ex
  try { ex = JSON.parse(fs.readFileSync(manifest, 'utf8')).exports } catch { return false }
  if (!ex || typeof ex !== 'object') return false
  for (const key of Object.keys(ex)) {
    if (key === sub) return true
    if (key.includes('*')) {
      const re = '^' + key.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$'
      if (new RegExp(re).test(sub)) return true
    }
  }
  return false
}

/** 守卫：层表登记的包必须真实存在 —— 仓库根目录下有同名目录、含 package.json、且其 `name` 等于键。
 *
 * ISS-701 · 缺口 C：键的**口径只能有一个**。原先「同名目录 + package.json」把键当目录名判，
 * 而 `judge()` 把键当 **import specifier 的包名**用 —— 两处分裂。本仓 `vscode-dsh-models/` 的
 * package.json `name` 是 `forge-dsh-models`：登记键 `vscode-dsh-models` 能过 PHANTOM，而
 * `import "forge-dsh-models"` 的边被 UNJUDGED 判红（键对不上）。现在键 = 包名，目录名必须与之一致。
 * @returns {string|null} null = 没问题；否则是**为什么不是这个包**（供判红点名，别只说「不存在」）
 */
function layerPackageProblem(root, name) {
  const dir = path.join(root, String(name))
  let st = null
  try { st = fs.statSync(dir) } catch { return `仓库根目录下没有同名目录 ${name}/` }
  if (!st.isDirectory()) return `${name} 存在但不是目录`
  let pkgName = null
  try { pkgName = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name } catch {
    return `${name}/ 缺 package.json 或解析失败`
  }
  if (pkgName !== String(name)) return `${name}/package.json 的 name 是「${pkgName ?? '(缺失)'}」，与层表键不一致`
  return null
}

function verifyLayerPackage(root, name) {
  return layerPackageProblem(root, name) === null
}

/** 层表幽灵条目：登记了但仓库里不存在的包。返回命中（供规则用），空数组 = 层表无化石。 */
function phantomLayers(root, layers) {
  return Object.keys(layers || {})
    .map((name) => ({ name, problem: layerPackageProblem(root, name) }))
    .filter((x) => x.problem)
    .map(({ name, problem }) => ({
      file: CONTRACT_REL,
      line: 0,
      detail: `层表登记的包在仓库里对不上：${name}（L${layers[name]}）—— ${problem}`,
    }))
}

function loadContract(root) {
  const p = path.join(root, CONTRACT_REL)
  if (!fs.existsSync(p)) return { layers: {}, waivers: {}, missing: true }
  try { return { ...JSON.parse(fs.readFileSync(p, 'utf8')), missing: false } } catch (e) {
    return { layers: {}, waivers: {}, missing: true, error: String(e && e.message) }
  }
}

/** 规则表（ISS-701 · 缺口 A 的可测落点）。
 *
 * 原先 rules 数组写在 `buildLint()` 内部 ⇒ `--selftest` 只测得到纯函数 `judge()`，测不到接线：
 * 把 LAYER-UNJUDGED 从数组里摘掉、或把某条的 check 换成 `() => []`，selftest 照样全绿
 * （两路独立审查互不知情，各撞一遍）。抽成 makeRules(ctx) 后，selftest 直接对**规则表本身**断言。
 * `RULE_IDS` 是期望集合的唯一真相源：增删规则必须两处同改，不一致即红。
 */
const RULE_IDS = ['LAYER-AST', 'LAYER-SUBPATH', 'LAYER-PHANTOM', 'LAYER-REVERSE', 'LAYER-SAME', 'LAYER-UNJUDGED']

function makeRules({ root, contract, ts, judged }) {
  const toHits = (list) => list.map((e) => ({ file: e.file, line: e.line, detail: e.detail }))
  return [
    { id: 'LAYER-AST', level: 'block', why: 'AST 解析器必须可用，判不了不许当绿', check: () => { if (!ts) throw new Error('找不到 typescript：' + TS_CANDS.join(' / ')); return [] } },
    { id: 'LAYER-SUBPATH', level: 'block', why: '子路径层号必须在目标包 exports 里真实存在，不许凭空贴层号洗白', check: () => Object.keys(contract.subpathLayers || {})
      .filter((spec) => !verifySubpath(root, spec))
      .map((spec) => ({ file: CONTRACT_REL, line: 0, detail: `登记的子路径在目标包 package.json 的 exports 里不存在：${spec}` })) },
    { id: 'LAYER-PHANTOM', level: 'block', why: '层表登记的包必须真实存在，且键 = 包名（目录名与 package.json 的 name 都等于键）', check: () => phantomLayers(root, contract.layers) },
    { id: 'LAYER-REVERSE', level: 'block', why: '依赖只能向下：低层不许 import 高层', check: () => toHits(judged().reverse) },
    { id: 'LAYER-SAME', level: 'block', why: '同层不互相 import：走服务 / slot / 事件', check: () => toHits(judged().same) },
    { id: 'LAYER-UNJUDGED', level: 'block', why: '覆盖完整性：目标包必须登记层号，判不了不许当绿', check: () => toHits(judged().unjudged) },
  ]
}

function buildLint(root) {
  const contract = loadContract(root)
  const layers = contract.layers || {}
  const pkgs = knownPackages(root, layers)
  const input = sourceFiles(root, pkgs)
  const ts = loadTs(root)
  const files = () => input.files
  const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
  const rel = (p) => path.relative(root, p).split(path.sep).join('/')
  const cache = { value: null }
  const judged = () => {
    if (!cache.value) cache.value = ts
      ? judge(scanEdges(files(), read, rel, ts, pkgs), layers, contract.subpathLayers || {})
      : { reverse: [], same: [], unjudged: [] }
    return cache.value
  }
  const rules = makeRules({ root, contract, ts, judged })
  const whitelist = contract.waivers || {}
  const lint = createLint({ name: 'lint-layer', root, files, rules, whitelist })
  return { lint, contract, input, rules }
}

/* ─────────────── --selftest：本门禁判据自己的正反例（不是骨架那层） ─────────────── */
function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-layer-selftest-'))
  const layers = { 'forge-a': 1, 'forge-b': 2, 'forge-c': 3, 'forge-d': 4, 'forge-e': 4 }
  const mk = (pkg, name, body) => {
    const p = path.join(dir, pkg)
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, name), body)
    return path.join(p, name)
  }
  const cases = []
  const push = (name, ok, note = '') => cases.push({ name, ok, note })

  const down = mk('forge-c', 'ok.ts', 'import { x } from "forge-a/lib"\n')
  const reverse = mk('forge-c', 'bad.ts', 'import { x } from "forge-d/ui"\n')
  const same = mk('forge-d', 'same.ts', 'import { x } from "forge-e/ui"\n')
  const multi = mk('forge-c', 'multi.ts', 'import {\n  x,\n  y,\n} from "forge-b/lib"\n')
  const req = mk('forge-c', 'req.js', 'const x = require("forge-a/lib")\n')
  const comment = mk('forge-c', 'comment.ts', '// import { x } from "forge-d/ui"\n/* from "forge-d/ui" */\n')
  const guardLiteral = mk('forge-c', 'guard.test.js', 'for (const re of [/from "forge-d/, /require\\("forge-d/]) { void re }\n')
  const unknown = mk('forge-c', 'unknown.ts', 'import { x } from "forge-zzz/lib"\n')

  // `forge-zzz` 是「真实存在、但不在层表」的包 —— LAYER-UNJUDGED 要判的正是这个形态。
  // （ISS-701 · 缺口 B 之后，包的身份由 knownPackages 认，所以先把它造成真包。）
  fs.mkdirSync(path.join(dir, 'forge-zzz'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'forge-zzz', 'package.json'), JSON.stringify({ name: 'forge-zzz' }))
  const pkgs = knownPackages(dir, layers)

  const read = (p) => fs.readFileSync(p, 'utf8')
  const rel = (p) => path.relative(dir, p).split(path.sep).join('/')
  const all = [down, reverse, same, multi, req, comment, guardLiteral, unknown]
  const ts = loadTs(DEFAULT_ROOT)
  const edges = ts ? scanEdges(all, read, rel, ts, pkgs) : []
  const j = judge(edges, layers)

  push('AST 解析器可用（判不了不许当绿）', !!ts)
  push('该红能红：L3→L4 反向被判出', j.reverse.some((e) => e.file.endsWith('bad.ts')))
  push('该红能红：L4→L4 横向被判出', j.same.some((e) => e.file.endsWith('same.ts')))
  push('判不了不当绿：未登记包进 unjudged', j.unjudged.some((e) => e.dst === 'forge-zzz'))
  push('不该红的不红：严格向下 L3→L1/L2 不命中', !j.reverse.some((e) => e.file.endsWith('ok.ts') || e.file.endsWith('multi.ts') || e.file.endsWith('req.js')))
  push('多行 import 与 require() 都真的被读到', edges.some((e) => e.file.endsWith('multi.ts') && e.dst === 'forge-b') && edges.some((e) => e.file.endsWith('req.js') && e.dst === 'forge-a'))
  push('注释不误伤（整行注释里的 import 不算）', !edges.some((e) => e.file.endsWith('comment.ts')))
  push('守卫正则字面量不误伤（体检踩过的假环）', !edges.some((e) => e.file.endsWith('guard.test.js')))
  push('同包自引用不算跨包依赖', !edges.some((e) => e.src === e.dst))

  // P1 子路径层号：正反例 + 守卫有牙（不许凭空贴层号洗白）
  fs.writeFileSync(path.join(dir, 'forge-d', 'package.json'), JSON.stringify({
    name: 'forge-d', exports: { './ui': './src/ui.tsx', './ui/*': './src/ui/*' },
  }))
  const subSpec = 'forge-d/ui'
  const subEdge = { src: 'forge-c', dst: 'forge-d', spec: subSpec, file: 'forge-c/sub.ts', line: 1 }
  const jSub = judge([subEdge], layers, { [subSpec]: 1 })
  push('子路径原语生效：借 L1 组件不算反向依赖', jSub.reverse.length === 0 && jSub.same.length === 0)
  push('未登记的同包子路径仍按包层号判（不许洗白）', judge([subEdge], layers).reverse.length === 1)
  push('子路径守卫：真实 exports 的登记通过', verifySubpath(dir, subSpec) === true)
  push('子路径守卫：exports 里不存在的键判红', verifySubpath(dir, 'forge-d/nope') === false)
  push('子路径守卫：./ui/* 通配能匹配子路径', verifySubpath(dir, 'forge-d/ui/mermaid-block') === true)

  // LAYER-PHANTOM 层表幽灵条目：登记的包必须真实存在（同名目录 + package.json + name 等于键），
  // 与 LAYER-UNJUDGED 成对
  for (const p of ['forge-a', 'forge-b', 'forge-c', 'forge-e']) {
    fs.mkdirSync(path.join(dir, p), { recursive: true })
    fs.writeFileSync(path.join(dir, p, 'package.json'), JSON.stringify({ name: p }))
  }
  fs.mkdirSync(path.join(dir, 'forge-nopkg'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'forge-nopkg', 'index.js'), 'export const x = 1\n')
  // ISS-701 · 缺口 C 的现场形态取其真实一例：本仓 `vscode-dsh-models/` 的 package.json name 是
  // `forge-dsh-models`（目录名 ≠ 包名）⇒ 键按目录名登记能过 PHANTOM，而 import 边判不到。
  fs.mkdirSync(path.join(dir, 'forge-dirname'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'forge-dirname', 'package.json'), JSON.stringify({ name: 'forge-realname' }))
  push('层表幽灵守卫：登记的包真实存在 ⇒ 不红', Object.keys(layers).every((p) => verifyLayerPackage(dir, p)) && phantomLayers(dir, layers).length === 0)
  push('层表幽灵守卫：登记了不存在的包 ⇒ 红且点名', phantomLayers(dir, { ...layers, 'forge-absent': 1 }).some((h) => h.detail.includes('forge-absent')))
  push('层表幽灵守卫：目录在但缺 package.json 也算幽灵', verifyLayerPackage(dir, 'forge-nopkg') === false && phantomLayers(dir, { 'forge-nopkg': 1 }).length === 1)
  push('层表幽灵守卫：条数按登记条目算，不误伤别的包', phantomLayers(dir, { ...layers, 'forge-absent': 1 }).length === 1)
  push('层表幽灵守卫：目录名与 package.json 的 name 不一致 ⇒ 红且点名两边（ISS-701 缺口 C）',
    verifyLayerPackage(dir, 'forge-dirname') === false
    && phantomLayers(dir, { 'forge-dirname': 1 }).some((h) => h.detail.includes('forge-dirname') && h.detail.includes('forge-realname')))

  // ── ISS-701 · 缺口 A：**接线**必须也能被测到 ───────────────────────────────
  // 上面那 20 多条全在测纯函数（judge / scanEdges / verifySubpath / verifyLayerPackage），
  // 一条也碰不到 `buildLint()` 真正交给 createLint 的 rules 数组。于是「摘掉一条规则」
  // 「把某条 check 换成 () => []」在 selftest 里全是绿的（两路独立审查各撞一遍）。
  // 这里改成对**规则表本身**断言三件事：id 集合、level、每条在构造的违规上真的产出命中。
  const hitOf = (id) => ({ file: `forge-c/${id}.ts`, line: 1, detail: `自检构造：${id}` })
  const mkRules = (o = {}) => makeRules({
    root: dir,
    ts: 'ts' in o ? o.ts : ts,
    contract: o.contract || {
      layers: { ...layers, 'forge-absent': 1 },  // 目录不存在 ⇒ LAYER-PHANTOM 必命中
      subpathLayers: { 'forge-a/absent': 1 },    // exports 里没有 ⇒ LAYER-SUBPATH 必命中
    },
    judged: o.judged || (() => ({
      reverse: [hitOf('LAYER-REVERSE')],
      same: [hitOf('LAYER-SAME')],
      unjudged: [hitOf('LAYER-UNJUDGED')],
    })),
  })
  const ids = mkRules().map((r) => r.id)
  push('接线可测：规则表 id 集合与 RULE_IDS 完全一致（从数组摘掉任一条 ⇒ 红）',
    ids.length === RULE_IDS.length && RULE_IDS.every((id) => ids.includes(id)))
  push('接线可测：每条规则都是 block 级且带 why（降成 warn ⇒ 红）',
    mkRules().every((r) => r.level === 'block' && String(r.why || '').trim().length > 0))
  const silent = []
  for (const r of mkRules()) {
    if (r.id === 'LAYER-AST') continue // 它的牙是「AST 缺席必须抛」，不是「产出命中」，见下一条
    let n = 0
    try { n = (r.check({}) || []).length } catch { n = -1 }
    if (n <= 0) silent.push(r.id)
  }
  push('接线可测：五条行为规则在构造的违规上各产出命中（check 换成 ()=>[] ⇒ 红）', silent.length === 0, silent.join(','))
  let astThrew = false
  try { mkRules({ ts: null }).find((r) => r.id === 'LAYER-AST').check({}) } catch { astThrew = true }
  push('接线可测：LAYER-AST 在 AST 缺席时抛错（check 换成 ()=>[] ⇒ 红）', astThrew)

  // 白名单：生效归零 + 化石双向（复用骨架，不自己写一遍）
  const files = () => all
  const wl = {
    'LAYER-REVERSE': [{ file: rel(reverse), reason: '自检：证明豁免确实生效' }],
    'LAYER-SAME': [{ file: rel(same), reason: '自检：证明豁免确实生效' }],
    'LAYER-UNJUDGED': [{ file: rel(unknown), reason: '自检：证明豁免确实生效' }],
  }
  const mkLint = (w) => createLint({
    name: 'selftest', root: dir, files, whitelist: w,
    rules: [
      { id: 'LAYER-REVERSE', check: () => j.reverse.map((e) => ({ file: e.file, line: e.line, detail: e.detail })) },
      { id: 'LAYER-SAME', check: () => j.same.map((e) => ({ file: e.file, line: e.line, detail: e.detail })) },
      { id: 'LAYER-UNJUDGED', check: () => j.unjudged.map((e) => ({ file: e.file, line: e.line, detail: e.detail })) },
    ],
  })
  const r1 = mkLint(wl).run()
  push('白名单命中 ⇒ 归零', r1.findings.length === 0 && r1.stale.length === 0 && r1.gone.length === 0)
  const r2 = mkLint({ 'LAYER-REVERSE': [{ file: rel(down), reason: '自检：该文件其实不命中' }] }).run()
  push('豁免失效会报（stale）', r2.stale.length === 1)
  const r3 = mkLint({ 'LAYER-REVERSE': [{ file: 'nope.ts', reason: '自检：文件不存在' }] }).run()
  push('名单指向缺失文件会报（gone）', r3.gone.length === 1)

  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  const bad = cases.filter((c) => !c.ok)
  console.log('lint-layer --selftest（本门禁判据的正反例）')
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.note ? '（' + c.note + '）' : ''}`)
  const code = bad.length ? 1 : 0
  console.log(code ? `\n✗ ${bad.length}/${cases.length} 项失败` : `\n✓ ${cases.length}/${cases.length} 项通过：该红能红、不该红的不红、注释与守卫字符串不误伤、豁免失效双向会报`)
  console.log(`verdict=${code ? 'red' : 'green'}`)
  return code
}

/* ─────────────────────────────── CLI ─────────────────────────────── */
const argv = process.argv.slice(2)
if (argv.includes('--selftest')) process.exit(selftest())

const { trackedSet } = await import('./scan-input.mjs')
trackedSetFn = trackedSet

const rootIdx = argv.indexOf('--root')
const root = rootIdx >= 0 && argv[rootIdx + 1] ? path.resolve(argv[rootIdx + 1]) : DEFAULT_ROOT
const { lint, contract, input } = buildLint(root)
const res = lint.run()

if (argv.includes('--json')) {
  console.log(JSON.stringify({ root, degraded: input.degraded, scanned: input.files.length, contractMissing: contract.missing, ...res }, null, 1))
  process.exit(res.findings.length || res.stale.length || res.gone.length || res.errored.length ? 1 : 0)
}

const { text, exit } = lint.format(res, { verbose: argv.includes('--verbose') })
console.log(text)
if (input.degraded) console.log('  ⚑ 输入集合降级：副本无 .git，未做入库过滤（已走目录遍历，未静默出空集）')
if (contract.missing) console.log(`  ✗ 契约文件缺失/坏：${CONTRACT_REL} ⇒ 层表为空，全部判不了（不静默当绿）`)
console.log(`verdict=${exit ? 'red' : 'green'}`)
process.exit(exit || (contract.missing ? 2 : 0))
