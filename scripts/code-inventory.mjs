#!/usr/bin/env node
// 代码现状盘点 —— docs/code-audit.md 的数字唯一来源（可机器复算，禁手抄进文档；改口径 = 改这里）
// 用法：node scripts/code-inventory.mjs [--json|--md] [--verbose] [--list] [--top N] [--only B,Z] [--baseline-save|--compare]
//                                       [--write-dead-exports] [--selftest]
//   · --list 把 E5/E8（门禁 K9c/K9f）的违例**逐条打到 文件:行**（ISS-622）—— 棘轮只说"多了 8 处"，
//     还债的人需要知道是哪 8 行。判据口径不受影响，`sites` 只是同一批命中点的位置。
//   · --write-dead-exports 把**符号级**零引用导出清单落进 scripts/baseline/dead-exports.json（ISS-732）
//     —— 主基线只存每度量前 10 个 offender 且 Z2 是**按包聚合**的数，回答不了"到底是哪 838 个"。
//     本文件**不改任何判据口径**，只额外打三个降噪标记（.d.ts 双份 / 入口按名装配 / 名字在字符串里出现过）⇒ 死码账本（ISS-723）的输入。
//   · --selftest 只验符号级清单的三个纯函数判据（打标 / 排序稳定 / 不改成员），不扫真仓库。
//
// 口径（写死在此，与设计侧 design-component-inventory.mjs 同源纪律）：
//   · 「实现」= 有函数体/类体的声明；只做再导出的 index.* 判为 barrel ⇒ 不算实现（否则虚增重名与零引用）
//   · 「引用」= 别的文件的 import 子句里出现该名字，**且说明符解析后的真实源文件**就是该实现所在文件
//     （bare 包名顺 package.json exports / 默认入口落到源文件；相对路径解析到具体文件）
//     ⇒ 同名不同件不会混计（按"名字全仓出现次数"算引用是错的，设计侧上一版就栽在这里）
//   · 「相似块」= 两个**不同文件**里的函数体，规范化 token 后 12-gram 有交集即同簇
//     （标识符→I / 字符串→S / 数字→N，关键字与标点保留 ⇒ 只换变量名的复制粘贴会命中）
//   · 取值手段：TypeScript 编译器 API 真解析（非正则猜）。解析不到 typescript ⇒ 直接退出不出数，
//     拒绝降级成"正则凑的口径"。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process' // 只为取证环境那一行读 git（HEAD/脏文件数）；不起子进程做别的
// 死码清单的打标与自检（ISS-732）分在独立文件：本文件已贴着 K2a 的 1000 行红线，往里加能力=抬棘轮
import { annotateDead, addStringsToPool, addTokensToPool, collectBuiltArtifacts, selftestDead, buildDeadArtifact, LOAD_CONTRACT_NAMES } from './dead-exports-lib.mjs'
import { selftestK9c, silentShellHitLines, stripShellComments } from './shell-silent-lib.mjs' // ISS-774：E5/K9c 判据与自检外置
import { WORKTREE_DIR_NAMES, WORKTREE_PATH_RE } from './wt-exclude-lib.mjs' // ISS-724：工作树落点的唯一真相源
import { buildRouteArtifactV2, isDocLine, routeHalves, selftestRoutes, loadCrossBundleBaseline } from './route-ledger-lib.mjs'
import { readSharedMirror, privatePkgs, profilesOf } from './assembly-anchors-lib.mjs'
import { buildDupArtifact } from './dup-detail-lib.mjs' // 重复/簇/hoisting 的全量明细（ISS-739）：组装外置，本文件贴着 1000 行红线
import { countQuotes, codeOnly } from './lexical-lib.mjs' // ISS-762：词法类度量的取数口径（注释不是代码）——同样外置，理由同上
import { trackedSet } from './scan-input.mjs' // 判据的输入集合 = 已入库文件（ISS-742）
import { hostInjectedWhy, classifyShared, selftestCaliber } from './caliber-lib.mjs' // ISS-624：两处口径的判据本体（同样外置，理由见下方块注释）
import { clusterDupFuncs, dupEdgeHolds, firstFuncShapeOf, funcShapeOf, selftestDupCriterion, text } from './dup-shape-lib.mjs' // ISS-772：D3 判据本体与自检外置
import { skipAbs, skipPath, selftestSkip } from './scan-skip-lib.mjs' // ISS-772：扫描排除判据与自检外置

const ROOT = path.resolve(import.meta.dirname, '..'), A = process.argv.slice(2)
const MODE = A.includes('--json') ? 'json' : A.includes('--md') ? 'md' : 'text'
const VERBOSE = A.includes('--verbose'), SAVE = A.includes('--baseline-save'), CMP = A.includes('--compare'), LIST = A.includes('--list')
const flagVal = (name, dflt) => { const i = A.indexOf(name); return i < 0 ? dflt : A[i + 1] }
const ONLY = flagVal('--only') ? new Set(flagVal('--only').split(',').map((s) => s.trim().toUpperCase())) : null
// TOP 只用于**展示层**（verbose 与 --md 各截一份，人看的）；喂白名单门禁的度量一律走 topOfAll ——
// 白名单判的是"offender 全集 ⊆ 名单"，截断会让第 11 条起**门禁看不见**（09-22 实证：D7 有 13 条，首版 K6g 把后 3 条误报成化石；H5a/H5c/C9d 现值 2/1/1 属隐患未发作）。
const TOP = Number(flagVal('--top', 10)) || 10, topOfAll = (arr) => arr
// 相似块检测的灵敏度可外部调（默认口径写死，调参只为验证"0 是真 0 还是判据太严"）
const SHINGLE = Number(flagVal('--shingle', 12)) || 12, JAC = Number(flagVal('--jac', 0.6)) || 0.6
const BASELINE = path.join(ROOT, 'scripts', 'baseline', 'code-inventory.json'), DEAD = path.join(ROOT, 'scripts', 'baseline', 'dead-exports.json'), ROUTES = path.join(ROOT, 'scripts', 'baseline', 'route-literals.json'), DUP = path.join(ROOT, 'scripts', 'baseline', 'dup-detail.json')
const WRITE_DEAD = A.includes('--write-dead-exports') || A.includes('--write-route-ledger') || A.includes('--write-dup-detail') // 两份"还账明细"同一次测量出，别各跑一遍（口径会漂）
// 两个落盘目标**必须**在 SAVE 分支之前读到：下面几个分支各自 `process.exit(0)`，要不要退取决于后面还有没有产物等着写
const ROLES_TARGET = flagVal('--roles'), AUDIT_TARGET = flagVal('--write-audit') // 要求四份就落四份，不许"要求四份、只落三份"（ISS-753 实测踩过）
/* 取证环境快照（ISS-563）：**必须在任何产物落盘之前取**。复录会先写基线/三份侧产物，
   之后再取就等于把"自己刚写的脏文件"记进取证环境（实测 dirty 4），那是自欺不是取证。 */
const ENV_AT = MODE === 'md' || AUDIT_TARGET ? { head: gitEnv(['rev-parse', '--short', 'HEAD']), st: gitEnv(['status', '--porcelain']) } : null
/* 取证环境（ISS-563）——生成块里的装配/依赖类读数是**这台机器**的状态，不是仓库真相。
   政策 = **不剔除环境量，但必须显式标注 + 记录取证现场**：否则"换台机器 / 换个 home 就能复现出另一份审计稿"，
   而读者无从判断手上这份是在哪录的（本单现场：装配列指向别人工作树，包数早已过期却没人看得出）。
   ENV_NOTE 是给读者的那一句（标注的含义）；envLine() 是现场快照本身（谁在哪儿录的）。
   ⚠️ 这两个符号**必须住在 AUDIT_TARGET 分支之前**：`--write-audit` 在文件中部就调用 mdBody()，
   放到文件末尾的 `const` 会撞 TDZ（实测：基线/侧产物都写完了，审计稿才 ReferenceError 崩掉）。 */
const ENV_NOTE = '> 标注**（环境量）**= 该读数取自**本机现场**（home 里的软链与声明、已安装的 node_modules 等）：换台机器或换 home 就会变，**不是仓库真相** —— 只许与同一台机器的前一次读数纵向比，不许跨机比、不许当门禁阈值。仓库事实类读数 = B1（包总数）与 T1（包数 / 源文件数 / 行数）。'

/* ───────────────────────────────── 0. 解析器（借仓库里已有的 typescript，不新增依赖） ───────────────────────────────── */
function loadTs() {
  for (const c of ['forge-ui/node_modules/typescript', 'forge-pm/node_modules/typescript', 'node_modules/typescript']) {
    const abs = path.join(ROOT, c)
    if (!fs.existsSync(abs)) continue
    try { return { ts: createRequire(path.join(abs, 'package.json'))('typescript'), from: c } } catch { /* 换下一个候选 */ }
  }
  console.error('✗ 找不到 typescript 编译器（试过 forge-ui / forge-pm / root 的 node_modules）')
  console.error('  盘点拒绝出数：正则凑的口径不可复算。先装依赖再跑。')
  process.exit(2)
}
const { ts, from: TS_FROM } = loadTs()
const TS_VERSION = ts.version

/* ───────────────────────────────── 1. 扫描范围 ───────────────────────────────── */
const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'build', '.git', ...WORKTREE_DIR_NAMES, '.tmp', '.bun-tmp', 'static', 'mockups', 'vendor', 'coverage', '.next', '.dsh'])
const FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')
const pkgOf = (p) => rel(p).split('/')[0]

/* 自测**必须早退在扫描之前**：否则扫描侧的 fail-closed 守卫会先 exit 2，自测的判别力被它盖住（分辨不出谁抓的）。 */
if (A.includes('--selftest-skip')) process.exit(selftestSkip({ walk }))

/* ═════ ISS-624：两处口径的判据本体 → scripts/caliber-lib.mjs ═════
   为什么外置：本文件自带「贴着 K2a 的 1000 行红线，加能力先外置」的规矩（lexical-lib / dup-detail-lib /
   route-ledger-lib 都是这么来的）。判据本体与它的用例放在同一个模块里 ⇒ 改判据的人必然看见用例。 */
if (A.includes('--selftest-caliber')) process.exit(selftestCaliber()) // 自测早退在扫描之前（同 --selftest-skip 的纪律）
// ISS-631：**测试文件判定（唯一判据 —— 别在别处新造正则，那正是本单要治的「两份尺」）**
//   · `xxx.test.ts` / `xxx.spec.js` —— 测试用例文件
//   · `test-preload.js` / `test-helper.ts` 这类**测试辅助文件** —— 文件名以 `test-` 开头。
//     它们被测试运行器/夹具按**文件名**加载，没有任何生产代码 import ⇒ 与用例文件同一语义。
//     （2026-10-20 实测：3 个 `lib/test-preload.js` 长期被当零引用死码计入 Z1 基线。）
//   ⚠️ 认的是「**文件名**以 test- 开头」，不是「路径里含 test」—— 后者会误伤 `lib/testable/` 这类真代码目录。
//   ⚠️ 判据语义：`Z1` 量的是「**生产**文件里没人 import 的」，测试文件（含辅助件）由运行器按名发现，
//     零引用是**正常态**而非坏味道。混成一个数字会逼人「不写测试」或「抬基线」。
const isTestFile = (p) =>
  /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(p) || /(^|\/)test-[a-z0-9-]+\.(ts|tsx|js|jsx|mjs)$/.test(p)

const PKG_DIRS = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^(forge-[a-z0-9-]+|electron-shell)$/.test(e.name))
  .map((e) => e.name)

function walk(dir, acc, root = ROOT) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, acc, root) }
    else if (FILE_RE.test(e.name) && !skipAbs(root, p) && !/~\d{3,}/.test(e.name)) acc.push(p)
  }
  return acc
}
let codeFiles = []
for (const pkg of PKG_DIRS) codeFiles = codeFiles.concat(walk(path.join(ROOT, pkg), []))
/* ISS-561 有牙的那一半：盘点**绝不允许静默归零**。
   判据用"零个包的源文件都见不到"这个不可能为真的签名 —— 真有包空着也不会误报（只认全空）。
   （旧行为：跑在仓内工作树里出一张 34 行全 0 的角色表，退出码 0、无任何警告。） */
if (PKG_DIRS.length >= 5 && !codeFiles.some((f) => PKG_DIRS.includes(pkgOf(f)))) {
  console.error(`✗ 盘点在 ${PKG_DIRS.length} 个包里一个源文件都没见到 —— 这不是"仓库是空的"，是扫描面坏了。`)
  console.error('  先查：① 是否跑在仓内工作树（<主仓>/.wt/<ISS>）—— 排除判据必须按仓根相对路径判（ISS-561）')
  console.error(`        ② ROOT=${ROOT} ③ 软链/权限。拒绝出数：静默归零的账目比没有账目更危险。`)
  process.exit(2)
}
const SCRIPTS_DIR = path.join(ROOT, 'scripts')
const toolFiles = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && FILE_RE.test(e.name)).map((e) => path.join(SCRIPTS_DIR, e.name))
const shellFiles = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.sh$/.test(e.name)).map((e) => path.join(SCRIPTS_DIR, e.name))
const TEST_SH_DIR = path.join(SCRIPTS_DIR, 'tests')
const testSh = fs.existsSync(TEST_SH_DIR) ? fs.readdirSync(TEST_SH_DIR).filter((f) => /\.sh$/.test(f)).map((f) => path.join(TEST_SH_DIR, f)) : []

// vendor / 产物级文件：单独登记，不进重复与死码判定
// ⚠️ 行数阈值只用来排"打包产物"，不能排 god module —— 本仓最大的手写文件是 forge-pm/lib/index.js（6297 行），
//    阈值一旦设到 4000 就会把**最需要审查的文件整份排除在盘点外**（第一版就栽在这里，C1/C8 因此虚低）。
const VENDOR_NAME = /(standalone|tsWorker|monaco|pdfjs|mermaid|bundle|vendor)\.[cm]?[jt]sx?$/
const vendor = [], kept = []
const TRACKED = trackedSet(ROOT) // 拿不到 git ⇒ TRACKED.all=true，不过滤但报告里要写明
for (const f of codeFiles.concat(toolFiles)) {
  const txt = fs.readFileSync(f, 'utf8')
  const lines = txt.split('\n')
  const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0)
  if (lines.length > 20000 || maxLen > 3000 || VENDOR_NAME.test(path.basename(f))) vendor.push({ k: rel(f), n: lines.length })
  else ((TRACKED.all || TRACKED.has(rel(f))) ? kept.push(f) : TRACKED.missing.push(rel(f))) // ISS-742：未入库的不参与测量，但要被点名（静默排除 = 看不见）
}

/* ───────────────────────────────── 2. 解析 + 逐文件事实 ───────────────────────────────── */
const SK = { '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.js': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS }
const isFn = (n) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))

/* ── ISS-770：Z2 的两个形态盲区（判据面修正，不是改数字）─────────────────────────
 *
 * ① **`.d.ts` 不是实现面**。声明文件里的 `export const X` / `export function f` 不会被任何
 *    import 命中：消费方 `import { X } from "pkg"` 解析到的是 `lib/index.js`（走 barrel），
 *    类型则走 `.d.ts` 这个**同一模块的另一种视图**。旧口径把 `.d.ts` 的声明当实现计数
 *    ⇒ 实测 595 条零引用里 **231 条（39%）** 是这一类假阳性（`forge-agent-protocol/lib/index.d.ts`
 *    一家就 20 条）。Z1（零引用**文件**）早就排除 `.d.ts` 了（见 ENTRY_RE 那段），Z2 漏了同一条。
 *
 * ② **`scripts/` 的子目录也要能"消费"**。`toolFiles` 只 `readdirSync` 了 scripts/ 根（非递归），
 *    于是 `scripts/gates/*.mjs` 从未进 SRC ⇒ 它们的 import 不进 `used`。实测反例：
 *      `scripts/gates/lint-oxlint.mjs:45` `import { WORKTREE_IGNORE_GLOBS } from '../wt-exclude-lib.mjs'`
 *    该 import 真实存在且 346 行在用，但 Z2 报它零引用 —— 照它删，`lint-oxlint` 会当场
 *    `SyntaxError: does not provide an export named`。
 *    ⇒ 这些文件只做**消费者**（贡献"谁 import 了谁"），**不进 SRC**：它们自己的导出不算、
 *      自己的行数不算、不参与任何其它度量（否则等于偷偷扩大盘面）。
 *
 * ⚠️ 两条都是**收窄假阳性**，不放过真死码：真没人 import 的 `.js` 导出照旧计数（反向控制见 `--selftest-z2`）。 */
const isDeclFile = (relPath) => /\.d\.ts$/.test(relPath)

/**
 * 从一棵树里收集「消费者 import」：只取 scripts/ 子树里**不在被测面内**的非测试代码。
 * @param {string} root 仓根（绝对路径）
 * @param {(relPath:string)=>boolean} inSurface 该文件是否已在被测面（SRC）里
 * @returns {Array<{rel:string,spec:string,names:string[],ns:?string,def:?string,star:boolean}>}
 */
function collectConsumerImports(root, inSurface) {
  const out = []
  const scriptsDir = path.join(root, 'scripts')
  if (!fs.existsSync(scriptsDir)) return out
  const relOf = (p) => path.relative(root, p).split(path.sep).join('/')
  for (const f of walk(scriptsDir, [], root)) {
    const r = relOf(f)
    if (inSurface(r) || isTestFile(r)) continue
    let sf
    try {
      sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, SK[path.extname(f)] || ts.ScriptKind.JS)
    } catch { continue }
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && st.moduleSpecifier) {
        const ic = st.importClause
        const names = []
        let ns = null, def = null
        if (ic) {
          if (ic.name) def = ic.name.text
          if (ic.namedBindings) {
            if (ts.isNamespaceImport(ic.namedBindings)) ns = ic.namedBindings.name.text
            else for (const e of ic.namedBindings.elements) names.push((e.propertyName || e.name).text)
          }
        }
        out.push({ rel: r, spec: st.moduleSpecifier.text, names, ns, def, star: false })
        continue
      }
      // `export { X } from "…"` 也是消费（再导出方把 X 从别处取走）；`export * from` 同理（整份）
      if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
        const names = []
        const ec = st.exportClause
        if (ec && ts.isNamedExports(ec)) for (const e of ec.elements) names.push((e.propertyName || e.name).text)
        out.push({ rel: r, spec: st.moduleSpecifier.text, names, ns: null, def: null, star: !ec })
      }
    }
  }
  return out
}

/** 把一批消费者 import 记进 used 三集合（口径与主循环里那段**逐条一致**，别在这里另发明规则）。 */
function feedConsumers(imports, add) {
  for (const im of imports) {
    const t = add.resolve(im.rel, im.spec)
    if (!t) continue
    if (!t.includes('/UNRESOLVED/')) add.usedFile(t)
    for (const n of im.names) add.used(`${t}::${n}`)
    if (im.ns || im.star) add.wildcard(t)
    if (im.def) add.used(`${t}::default`)
    if (!im.names.length && !im.ns && !im.def) add.wildcard(t) // 副作用 import / 整份再导出
  }
}


/* ───────── selftest（早退，不扫真仓库；判据与用例在 dead-exports-lib.mjs） ───────── */
if (A.includes("--selftest")) process.exit(selftestDead())
if (A.includes("--selftest-routes")) process.exit(selftestRoutes())

if (A.includes('--selftest-k9c')) process.exit(selftestK9c())

/** `--selftest-z2`（ISS-770）：Z2 两个形态修正的**单元级**验证。
 *  为什么要有：这次动的是**度量定义**（谁算实现面、谁能算消费者），不是改数字 ——
 *  只靠端到端注入证明不了「新形态被认 / 旧形态仍被认」，必须把三条口径各自钉住：
 *    ① `.d.ts` 不算实现面（且 `.js` 仍算）
 *    ② `scripts/` 子目录的 import 能算消费
 *    ③ 反向控制：同批里**没人 import 的导出仍然算零引用**（没把牙砍掉） */
function selftestZ2() {
  const cases = []
  const push = (n, ok, note) => cases.push({ n, ok: !!ok, note })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-z2-'))
  const mk = (relPath, body) => { const p = path.join(dir, relPath); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p }

  mk('scripts/a.mjs', 'export const USED_BY_GATES = 1\nexport const REALLY_DEAD = 2\n')
  mk('scripts/gates/b.mjs', "import { USED_BY_GATES } from '../a.mjs'\nexport const PASSTHRU = USED_BY_GATES\n")
  mk('scripts/side.mjs', "import './a.mjs'\n")

  /* ① 实现面：`.d.ts` 不是，`.js` 是 */
  push('`.d.ts` 不算实现面', isDeclFile('pkg/lib/index.d.ts') === true)
  push('反向控制：`.js` / `.mjs` / `.ts` 仍算实现面',
    !isDeclFile('forge-pm/lib/index.js') && !isDeclFile('scripts/x.mjs') && !isDeclFile('pkg/src/a.ts'))

  /* ② 消费者：scripts 子目录的 import 要被认（旧口径断在这里） */
  const imports = collectConsumerImports(dir, () => false)
  const used = new Set(), usedFile = new Set(), wildcard = new Set()
  const posix = (a, b) => path.posix.normalize(path.posix.join(path.posix.dirname(a), b))
  feedConsumers(imports, {
    resolve: (fromRel, spec) => posix(fromRel, spec),
    used: (k) => used.add(k),
    usedFile: (k) => usedFile.add(k),
    wildcard: (k) => wildcard.add(k),
  })
  push('scripts/gates/ 的具名 import 记成消费',
    used.has('scripts/a.mjs::USED_BY_GATES'), `used=${[...used].join(',')}`)
  push('被消费的文件本身记成 usedFile', usedFile.has('scripts/a.mjs'), `usedFile=${[...usedFile].join(',')}`)

  /* ③ 反向控制：同文件里没人 import 的导出仍算零引用（判据没被放宽成恒不报） */
  push('反向控制：没人 import 的导出仍算零引用', !used.has('scripts/a.mjs::REALLY_DEAD'))
  push('反向控制：同批里另一个入口文件的导出不算被消费（没整目录洗白）',
    !used.has('scripts/gates/b.mjs::PASSTHRU'))
  /* 副作用 import ⇒ 整份被用（既有口径，别在加消费者时弄丢） */
  push('副作用 import 仍整份洗白', wildcard.has('scripts/a.mjs'), `wildcard=${[...wildcard].join(',')}`)

  let bad = 0
  console.log('code-inventory --selftest-z2（Z2 形态：实现面 + 消费者射程）')
  for (const c of cases) { console.log(`  ${c.ok ? '✓' : '✗'} ${c.n}${c.note && !c.ok ? '（' + c.note + '）' : ''}`); if (!c.ok) bad++ }
  console.log(bad ? `\n✗ 反向验证失败 ${bad}/${cases.length}` : `\n✓ ${cases.length}/${cases.length} 项通过：.d.ts 不算实现面、scripts 子目录能算消费、真死码仍计`)
  return bad ? 1 : 0
}
if (A.includes("--selftest-z2")) process.exit(selftestZ2())

/** E6/K9a 的判据本体：调用表达式的 callee 文本**最后两段恰为 `process.exit`**。
 *  认 `process.exit(...)` / `globalThis.process.exit(...)` / `global.process.exit(...)`；
 *  不认裸 `exit()`、`myprocess.exit()`、`process.exitCode = 1`（赋值不是 CallExpression，本就不进这条分支）。
 *  ⛔ 不改方向、不加豁免：K9a 原文是「**库代码**不得 process.exit」，射程由 E6 聚合的 `half` 过滤决定，不在这条正则里放宽。
 *  ⚠️ 必须住在 `--selftest-k9a` **之前**：那段自检在模块求值期就跑，放后面会撞 TDZ
 *     （同 ENV_NOTE/AUDIT_TARGET 那一处已记录的坑）。 */
const PROCESS_EXIT_RE = /(?:^|\.)process\.exit$/

/** E6/K9a 的**射程**判据（ISS-769）：「库代码」不等于「非 other 半」。
 *
 * 实测 23 处 process.exit 全是**进程自己的 main**，没有一处是被宿主加载的库：
 *   · `electron-shell/scripts/*.mjs`（17 处）—— 一次性 CDP 调试 / 构建脚本，跑完就该给 shell 返回退出码；
 *   · `forge-messenger/lib/{inflight,resume}-cli.mjs`（3 处）—— 首行 shebang 的 CLI 入口；
 *   · `forge-service-kit/lib/fs-lock-probe.mjs`（3 处）—— 测试替身，被 fork 出去当「对侧进程」。
 * 把它们算成库代码，等于要求 CLI **不能**返回退出码 —— 那不是纪律，是判据不认识形态。
 *
 * ⛔ 判据本体（上面的 PROCESS_EXIT_RE）一个字不动，只在**聚合层**排除四类可执行入口：
 *   ① 首行 shebang（`#!`）
 *   ② 包内 `scripts/` 目录（一次性工具的家）
 *   ③ `*-cli.*`（按约定命名的 CLI 入口）
 *   ④ `*-probe.*`（按约定命名的测试替身）
 * 反向控制：普通 `lib/foo.js` 里的 `process.exit` **仍然计数** —— 见 `--selftest-k9a` 的「射程」段。
 * ⚠️ 同样必须住在 `--selftest-k9a` 之前（那里在模块求值期就调用它，放后面会撞 TDZ）。 */
const EXEC_ENTRY_DIR_RE = /(^|\/)scripts\//
const EXEC_ENTRY_NAME_RE = /(^|\/)[^/]*-(cli|probe)\.(mjs|cjs|js)$/
const isExecutableEntry = (x) => x.shebang === true || EXEC_ENTRY_DIR_RE.test(x.rel) || EXEC_ENTRY_NAME_RE.test(x.rel)

/**
 * `--selftest-k9a`（ISS-709）：E6 判据的**变异验证**。
 *
 * 为什么必须有这一条：K9a 是零容忍档，而它的探测器此前是**结构上不可能命中**的正则
 * （`/(^|\.)exit$/ && /process$/` —— 两个互斥的结尾断言）⇒ 度量恒 0、规则从未响过。
 * 只看「度量是 0」分不清「真的一处都没有」和「探测器坏了」；这条自检把两者钉开。
 *
 * 判据输入**走真路径**：和主扫描一样用 TS AST 取 callee 文本，而不是手写字符串喂正则
 * （手写能过、真解析不过的情况正是上一版的坑：`process.exit` 在 AST 里的 callee 文本是真值）。
 */
function selftestK9a() {
  const cases = []
  const push = (n, ok, note) => cases.push({ n, ok, note })

  /** 一段源码里被判据认下的 callee 文本 —— 与主扫描 `ts.isCallExpression` 分支同一取法。 */
  const hits = (src) => {
    const sf = ts.createSourceFile('fx.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const out = []
    const visit = (node) => {
      if (ts.isCallExpression(node)) { const nm = text(node.expression, sf); if (PROCESS_EXIT_RE.test(nm)) out.push(nm) }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }

  /* ① 正样本：真调用必须计数 —— 否则规则还是哑的 */
  push('正样本 `process.exit(1)` 命中', hits('process.exit(1)').length === 1, JSON.stringify(hits('process.exit(1)')))
  push('正样本 `process.exit(r.code)` 命中', hits('process.exit(r.code)').length === 1)
  push('正样本 `globalThis.process.exit(0)` 命中', hits('globalThis.process.exit(0)').length === 1)
  push('正样本 `global.process.exit(0)` 命中', hits('global.process.exit(0)').length === 1)
  push('正样本 两处真调用 = 2', hits('process.exit(1); process.exit(0)').length === 2)

  /* ② 反样本：不许误计 —— 误计会把零容忍规则变成噪音，最后还是被加豁免 */
  push('反样本 裸 `exit()` 不命中', hits('exit()').length === 0, JSON.stringify(hits('exit()')))
  push('反样本 `myexit()` 不命中', hits('myexit()').length === 0)
  push('反样本 `myprocess.exit(0)` 不命中', hits('myprocess.exit(0)').length === 0)
  push('反样本 `process.exitCode = 1` 不命中（赋值不是调用）', hits('process.exitCode = 1').length === 0)
  push('反样本 字符串里的 "process.exit(1)" 不命中', hits('const s = "process.exit(1)"').length === 0)
  push('反样本 注释里的 process.exit 不命中', hits('// process.exit(1)\nconst a = 1').length === 0)
  push('反样本 `proc.exit(0)` 不命中（前缀必须是 process）', hits('proc.exit(0)').length === 0)

  /* ③ 旧正则必须**判死** —— 证明这一条不是装饰：同一批正样本喂旧式两谓词，命中数必须是 0 */
  const OLD = (nm) => /(^|\.)exit$/.test(nm) && /process$/.test(nm)
  const oldOnSamples = ['process.exit', 'globalThis.process.exit', 'exit', 'process'].filter(OLD).length
  push('旧正则对 4 个样例命中 0（证明它恒假）', oldOnSamples === 0, `命中 ${oldOnSamples} / 4`)
  push('旧正则在真 `process.exit(1)` 上必为假（这是缺陷本体）', hits('process.exit(1)').length === 1 && !OLD('process.exit'))

  /* ④ 射程（ISS-769）：可执行入口排除，但**库代码一律不放行**。
     每条都配一个「同一形态的库文件仍然计数」的反向控制 —— 单测「排除生效」只能证明砍对了入口，
     证明不了没把牙一起砍掉。 */
  const scoped = (rel, shebang = false) => isExecutableEntry({ rel, shebang })
  push('射程 普通 lib/foo.js 不算入口（仍进判据）', scoped('forge-x/lib/foo.js') === false)
  push('射程 反控：lib/foo.js 里 process.exit 仍计数（射程没砍到库代码）',
    !scoped('forge-x/lib/foo.js') && hits('process.exit(1)').length === 1)
  push('射程 包内 scripts/ 下的工具算入口', scoped('electron-shell/scripts/cdp-shot.mjs') === true)
  push('射程 *-cli.mjs 算入口', scoped('forge-messenger/lib/inflight-cli.mjs') === true)
  push('射程 *-probe.mjs 算入口（测试替身）', scoped('forge-service-kit/lib/fs-lock-probe.mjs') === true)
  push('射程 首行 shebang 算入口（文件名没有 -cli 也算）', scoped('forge-x/lib/run.mjs', true) === true)
  push('射程 反控：名字像入口但不在 scripts/ 且无 shebang 的普通库文件不算入口',
    scoped('forge-x/lib/cli-helper.js') === false && scoped('forge-x/lib/probe.js') === false)
  push('射程 反控：`lib/scripts.js` 不算 scripts/ 目录（前缀必须整段匹配）',
    scoped('forge-x/lib/scripts.js') === false)

  let bad = 0
  console.log('code-inventory --selftest-k9a（E6 判据变异验证）')
  for (const c of cases) { console.log(`  ${c.ok ? '✓' : '✗'} ${c.n}${c.note && !c.ok ? '（' + c.note + '）' : ''}`); if (!c.ok) bad++ }
  console.log(bad ? `\n✗ 反向验证失败 ${bad}/${cases.length}` : `\n✓ ${cases.length}/${cases.length} 项通过：真调用必计、非调用不误计、旧正则判死`)
  return bad ? 1 : 0
}
if (A.includes('--selftest-k9a')) process.exit(selftestK9a())

if (A.includes("--selftest-dup")) process.exit(selftestDupCriterion({ ts, jac: JAC, shingle: SHINGLE }))

const F = []            // 逐文件事实
/** 全仓「identifier 形状的字符串字面量」池：只给死码清单打 stringRef 标记用（信息，不参与任何判据计数） */
const POOLS = { strings: new Map(), prodTokens: new Map(), testTokens: new Map() }
/** 路径形状调用：只在这些调用的实参里认"路径字符串"（口径与"为什么不能放宽"见下方 Z1 的两段长注释，ISS-653） */
const CALL_PATH_RE = /(^|\.)(join|resolve|fork|spawn|spawnSync|execFile|execFileSync|execSync|readFileSync|readFile|existsSync|createRequire|file)$/
/** "把文件当程序跑"的调用：只有这类才算"这个文件被引用"（读源码的 `readFileSync` **不算** —— 守卫测试会按名读源文件，
 *  那是"读文本"，不是"消费模块"；实测按 readFileSync 认会连带洗白 58 个文件、Z2 590→383） */
const EXEC_RE = /(^|\.)(fork|spawn|spawnSync|execFile|execFileSync)$/
/** 目录锚点的**直接**写法（可再 `join(anchor, "..")` 上跳，见 VariableStatement 分支） */
const DIRECT_ANCHOR_RE = /^(?:import\.meta\.dir(?:name)?|__dirname|dirname\(fileURLToPath\(import\.meta\.url\)\)|fileURLToPath\(new URL\(\s*["']\.["']\s*,\s*import\.meta\.url\)\))$/
const parseFail = []
for (const f of kept) {
  const source = fs.readFileSync(f, 'utf8')
  const ext = path.extname(f)
  if (ext === '.sh') { F.push({ rel: rel(f), pkg: pkgOf(f), shell: true, text: source, lines: source.split('\n').length }); continue }
  let sf
  try { sf = ts.createSourceFile(f, source, ts.ScriptTarget.Latest, true, SK[ext] || ts.ScriptKind.TS) } catch (e) { parseFail.push({ k: rel(f), d: String(e.message) }); continue }
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) parseFail.push({ k: rel(f), n: sf.parseDiagnostics.length })
  const r = rel(f)
  addStringsToPool(source, POOLS.strings); addTokensToPool(source, r, isTestFile(r) ? POOLS.testTokens : POOLS.prodTokens) // 打标用的池，不参与任何判据计数（见 dead-exports-lib.mjs）
  const half = /^lib\//.test(r.slice(r.indexOf('/') + 1)) ? 'host' : /(^|\/)(src|surfaces|components)\//.test(r) ? 'client' : pkgOf(f) === 'electron-shell' ? 'host' : 'other' // ISS-769：host 只认**包根** lib/（旧写法把 src/lib/ 也算 host ⇒ H10 假阳性 + N2/N3/H6/H7/B8 把 client 文件算进 host）
  const rec = {
    rel: r, pkg: pkgOf(f), shell: false, isTest: isTestFile(r),
    lines: source.split('\n').length,
    half: isTestFile(r) ? 'test' : half,
    imports: [],       // {spec, names[], ns, def, line, typeOnly}
    decls: [],         // {name, kind, exported, impl, line}
    exportStar: [],
    reExportOnly: true,
    calls: {},         // 调用名 → 次数
    toolDefs: [], toolSites: 0, sections: [], slots: [], storageDomains: [], routeLiterals: [],
    fsWrites: 0, throwNewError: 0, errSubclass: 0, dynamicImports: 0,
    throwNewErrorSites: [], // ISS-622：E8/K9f 的**位置**（{line}）—— 计数口径一字不改，只多记"债在哪一行"
    consoles: 0, logger: 0, emptyCatch: 0, emptyCatchSites: [], silentCatch: 0, processExit: 0, // ISS-771：E3 也要「债在哪一行」
    shebang: source.startsWith('#!'), // ISS-769：K9a 射程用（可执行入口 ≠ 库代码，见 isExecutableEntry）
    zodObject: 0, addPropsMissing: [], todo: 0, hooks: 0, jsxTags: new Set(),
    funcs: [],         // {name, line, toks[]}
    nodeBuiltin: [], reactUse: 0, tsAnnotationsInJs: [],
    quotes: { d: 0, s: 0 }, semi: 0, noSemi: 0,
    pathCalls: [],     // ISS-653：路径形状调用的实参（喂 Z1 的"锚点相对字符串引用"判定）
    pathConsts: new Map(), // ISS-653：`const NAME = join(anchor, "...")` 这类路径常量 → 实参形状
    execArgs: [],      // ISS-653：fork/spawn/execFile 这类"把文件当程序执行"的调用实参原文
    anchors: new Map(), // ISS-653：目录锚点 const（`import.meta.dirname` / `dirname(fileURLToPath(import.meta.url))`）→ 上跳层数
  }
  rec.imports = []
  const addCall = (nm, line) => { rec.calls[nm] = (rec.calls[nm] || 0) + 1 }
  const top = sf.statements
  for (const st of top) {
    const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1
    if (ts.isImportDeclaration(st) && st.moduleSpecifier) {
      const ic = st.importClause
      const names = []
      let ns = null, def = null
      if (ic) {
        if (ic.name) def = ic.name.text
        if (ic.namedBindings) {
          if (ts.isNamespaceImport(ic.namedBindings)) ns = ic.namedBindings.name.text
          else for (const e of ic.namedBindings.elements) names.push(e.propertyName ? e.propertyName.text : e.name.text) // ISS-770：别名导入（`{ X as Y }`）要记**原位置**的 X —— 记本地位 Y 会让 X 被误判成零引用
        }
      }
      rec.imports.push({ spec: st.moduleSpecifier.text, names, ns, def, line, typeOnly: !!(ic && ic.isTypeOnly) })
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      const names = []
      if (st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) names.push(e.propertyName ? e.propertyName.text : e.name.text) // ISS-770：再导出同样要记**目标模块里的原名**（`export { A as B } from './m'` ⇒ 对 './m' 记 A）
      if (!st.exportClause) rec.exportStar.push(st.moduleSpecifier.text)
      rec.imports.push({ spec: st.moduleSpecifier.text, names, ns: null, def: null, line, typeOnly: !!st.isTypeOnly, fromReexport: true })
    } else if (ts.isExportDeclaration(st) && st.exportClause) {
      rec.reExportOnly = false
      for (const e of st.exportClause.elements) rec.decls.push({ name: e.name.text, kind: 'reexport', exported: true, impl: false, line })
    } else if (ts.isVariableStatement(st)) {
      const ex = (ts.getModifiers(st) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      if (ex) rec.reExportOnly = false
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        const ini = d.initializer
        // ISS-653：目录锚点（`import.meta.dirname` / `dirname(fileURLToPath(import.meta.url))`，可再 `join(anchor,"..")` 上跳）
        //   —— 只有锚点相对的路径字符串才认（见下方 Z1），普通变量拼出来的路径不认（那类多半是临时目录，认了就成假白名单）。
        const iniText = ini ? text(ini, sf) : ''
        if (DIRECT_ANCHOR_RE.test(iniText)) rec.anchors.set(d.name.text, 0)
        else {
          const m = iniText.match(/^join\(\s*([A-Za-z_$][\w$]*)\s*,\s*["']\.\.["']\s*\)$/)
          if (m && rec.anchors.has(m[1])) rec.anchors.set(d.name.text, rec.anchors.get(m[1]) + 1)
        }
        if (ini && ts.isCallExpression(ini) && CALL_PATH_RE.test(text(ini.expression, sf))) rec.pathConsts.set(d.name.text, { base: ini.arguments[0] ? text(ini.arguments[0], sf) : '', lits: ini.arguments.map((a) => (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) ? a.text : null)) })
        const dk = !ini ? 'const' : isFn(ini) || ts.isClassExpression(ini) ? 'function' : ts.isObjectLiteralExpression(ini) ? 'object' : ts.isCallExpression(ini) ? 'factory' : 'const'
        rec.decls.push({ name: d.name.text, kind: dk, exported: ex, impl: !!ini && (isFn(ini) || ts.isClassExpression(ini)), line })
      }
    } else if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      if (!st.name) continue
      const ex = (ts.getModifiers(st) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      if (ex) rec.reExportOnly = false
      const kind = ts.isFunctionDeclaration(st) ? 'function' : ts.isClassDeclaration(st) ? 'class' : ts.isEnumDeclaration(st) ? 'enum' : ts.isInterfaceDeclaration(st) ? 'interface' : 'type'
      // ISS-653：`impl` 的判据是「**有函数/类体**」（D2 的同名"多份**实现**"，判据原文见 docs/code.md §5）。
      //   原写法只看 kind ⇒ `.d.ts` 里 `export declare function foo(): void`（**无体**）也被记成一份"实现"，
      //   同包的 `lib/x.js` 再算一份 ⇒ 单是"声明镜像"就凭空造出 87 组同名"重复实现"（324 组里 87 组）。
      //   ⚠️ 只改 impl 这一个标记：`exported` 不动（Z2 零引用导出靠它）、decls 照旧全收（Z2 的导出面不变）。
      const hasBody = !/\.d\.ts$/.test(rec.rel) && (!ts.isFunctionDeclaration(st) || !!st.body)
      rec.decls.push({ name: st.name.text, kind, exported: ex, impl: hasBody && (kind === 'function' || kind === 'class' || kind === 'enum'), line })
    } else if (ts.isImportEqualsDeclaration(st)) {
      rec.imports.push({ spec: text(st.moduleReference, sf).replace(/^require\(["']|["']\)$/g, ''), names: [], ns: null, def: st.name.text, line, typeOnly: false })
    } else {
      if (!(ts.isFunctionDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isEmptyStatement(st))) rec.reExportOnly = false
    }
  }
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  ts.forEachChild(sf, function visit(node) {
    if (ts.isCallExpression(node)) {
      const nm = text(node.expression, sf)
      addCall(nm, lineOf(node))
      if (/^console\.(log|warn|error|info|debug|trace|table|dir)$/.test(nm)) rec.consoles++
      if (/logger\s*\.\s*(info|warn|error|debug|trace|fatal)/.test(nm)) rec.logger++
      /* E6/K9a：`process.exit(...)` 调用点。ISS-709 修：旧写法是两个**互相排斥**的谓词
         `/(^|\.)exit$/ && /process$/` —— 前者要求以 `exit` 结尾、后者要求以 `process` 结尾，
         同一字符串不可能同时满足 ⇒ E6 恒 0、K9a 从上线起没响过（"有账无牙"）。
         现在合成一条，锚定「最后两段恰为 process.exit」：`globalThis.process.exit` / `global.process.exit` 都认，
         `myprocess.exit` / 裸 `exit()` / `process.exitCode` 都不认（判据方向见 --selftest-k9a）。 */
      if (PROCESS_EXIT_RE.test(nm)) rec.processExit++
      if (/^use[A-Z]/.test(nm.split('.').pop())) rec.hooks++
      if (/^(z\.)?object$/.test(nm)) rec.zodObject++
      if (/require$/.test(nm) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) rec.imports.push({ spec: node.arguments[0].text, names: [], ns: null, def: null, line: lineOf(node), typeOnly: false })
      // ISS-653：路径形状调用的实参（供 Z1 认"锚点相对的字符串路径引用"，口径见 CALL_PATH_RE 与下方 Z1）
      if (CALL_PATH_RE.test(nm)) rec.pathCalls.push({ argText: text(node, sf), base: node.arguments[0] ? text(node.arguments[0], sf) : '', lits: node.arguments.map((a) => (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) ? a.text : null)) })
      if (EXEC_RE.test(nm)) for (const a of node.arguments) rec.execArgs.push(text(a, sf))
      if (/import$/.test(nm) === false && /\bfetch$/.test(nm)) addCall('fetch', lineOf(node))
      if (/slots\.register$|surfaces\.register$|registerSurface$/.test(nm)) {
        const a0 = node.arguments[0]
        rec.slots.push({ line: lineOf(node), id: a0 && ts.isStringLiteral(a0) ? a0.text : null })
      }
      if (/storage\s*\.\s*domain$/.test(nm)) { const a0 = node.arguments[0]; rec.storageDomains.push({ line: lineOf(node), name: a0 && ts.isStringLiteral(a0) ? a0.text : '<dynamic>' }) }
      if (/systemPrompt\s*\.\s*(section|context|variable)$/.test(nm)) {
        const a0 = node.arguments[0]
        if (a0 && ts.isObjectLiteralExpression(a0)) rec.sections.push({ line: lineOf(node), keys: a0.properties.map(propName).filter(Boolean), which: nm.split('.').pop() })
      }
      if (/defineTool$/.test(nm)) {
        rec.toolSites++
        const arg = node.arguments[0]
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const get = (k) => arg.properties.find((p) => propName(p) === k)
          const outP = get('output')
          const outInit = outP && ts.isPropertyAssignment(outP) ? outP.initializer : null
          const outObj = outInit && ts.isObjectLiteralExpression(outInit) ? outInit : null
          const nameP = get('name')
          rec.toolDefs.push({
            line: lineOf(node),
            literal: true,
            name: nameP && ts.isPropertyAssignment(nameP) && ts.isStringLiteral(nameP.initializer) ? nameP.initializer.text : null,
            hasParams: !!get('parameters'),
            hasOutput: !!outP,
            hasRender: outObj ? outObj.properties.some((p) => propName(p) === 'render') : false,
            renderHelper: outInit ? /\w+Render\s*\(/.test(text(outInit, sf)) : false,
            hasSchema: outObj ? outObj.properties.some((p) => propName(p) === 'schema') : false,
          })
        } else {
          // 参数不是对象字面量（经 helper / 变量构造）⇒ 静态判不了 render，必须显式记成盲区，不能当成"合规"
          rec.toolDefs.push({ line: lineOf(node), literal: false, name: null, hasOutput: false, hasRender: false, renderHelper: false, hasSchema: false, opaqueArg: arg ? text(arg, sf).slice(0, 40) : '<无参>' })
        }
      }
      if (node.expression && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        rec.dynamicImports++
        rec.imports.push({ spec: node.arguments[0].text, names: [], ns: '*', def: null, line: lineOf(node), typeOnly: false, dynamic: true })
      }
      // HTTP 路由注册：常见形态 xxx.get("/path") / addRoute / route(...) / createServer handler
      const rm = nm.match(/^(?:\w+\.)?(get|post|put|del|delete|patch|head|options)$/)
      if (rm && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && String(node.arguments[0].text).startsWith('/')) {
        rec.routeLiterals.push({ line: lineOf(node), verb: rm[1].toUpperCase(), p: node.arguments[0].text, via: '注册点' })
      }
      if (/\bdefineRoute$|\baddRoute$|\bapp\.(use|all)$|\bserver\.route$/.test(nm) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        rec.routeLiterals.push({ line: lineOf(node), verb: '*', p: node.arguments[0].text, via: '注册点' })
      }
      if (nm === 'require' || /^(ctx\.)?require$/.test(nm)) { /* CJS：已在顶层收集 */ }
      // JSON Schema 风格对象（type:"object" 且带 properties）缺 additionalProperties
      if (/defineTool$/.test(nm)) {
        const stack = [node]
        while (stack.length) {
          const n = stack.pop()
          if (ts.isObjectLiteralExpression(n)) {
            const props = n.properties
            const typeP = props.find((p) => propName(p) === 'type')
            const isObjType = typeP && ts.isPropertyAssignment(typeP) && ts.isStringLiteral(typeP.initializer) && typeP.initializer.text === 'object'
            if (isObjType && props.some((p) => propName(p) === 'properties') && !props.some((p) => propName(p) === 'additionalProperties')) {
              rec.addPropsMissing.push({ line: lineOf(n) })
            }
          }
          ts.forEachChild(n, (c) => { stack.push(c) }) // ⚠️ 回调必须返回 undefined：`(c) => stack.push(c)` 返回数组长度（真值）会让 TS **停止遍历子树**
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const ne = text(node.expression, sf)
      if (/^(Error|TypeError|RangeError|AggregateError)$/.test(ne)) { rec.throwNewError++; rec.throwNewErrorSites.push({ line: lineOf(node) }) }
      if (/EventSource$|WebSocket$/.test(ne)) addCall('new ' + ne, lineOf(node))
      if (/(writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|openSync)$/.test(ne)) rec.fsWrites++
    }
    if (ts.isCallExpression(node) === false && ts.isPropertyAccessExpression(node) && /(writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|writeFile|appendFile)$/.test(node.name.text)) rec.fsWrites++
    if (ts.isClassDeclaration(node) && node.heritageClauses && /Error/.test(text(node.heritageClauses[0], sf))) rec.errSubclass++
    if (ts.isCatchClause(node)) {
      const inner = node.block ? text(node.block, sf) : '{}'
      const noStmts = !node.block || node.block.statements.length === 0
      if (noStmts) {
        // ⚠️ 判据要落在正确的对象上：`{}` 也满足"只有注释"的正则 ⇒ 第一版把全部真空 catch 记成了"注释式"（0 vs 388 的假差异）
        const hasComment = /\/\/|\/\*/.test(inner)
        if (hasComment) rec.silentCatch++
        else { rec.emptyCatch++; rec.emptyCatchSites.push(lineOf(node)) }
      } else if (node.block.statements.length === 1 && /^\s*(void|\/\/|\/\*|\/\*[\s\S]*\*\/)/.test(text(node.block.statements[0], sf))) rec.silentCatch++
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxClosingElement(node)) {
      const tag = text(node.tagName, sf)
      if (/^[A-Z]/.test(tag)) rec.jsxTags.add(tag)
    }
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // D3 的两个判据吃同一份形状（归一 token 序列 + 语句级指纹），见 funcShapeOf 上方注释
      const shape = funcShapeOf(ts, node, sf)
      if (shape) {
        const nm = ts.isFunctionDeclaration(node) && node.name ? node.name.text
          : ts.isMethodDeclaration(node) && node.name ? text(node.name, sf)
          : ts.isVariableDeclaration(node.parent) ? text(node.parent.name, sf) : '<anon>'
        rec.funcs.push({ name: nm, line: lineOf(node), toks: shape.toks, stmts: shape.stmts })
      }
    }
    ts.forEachChild(node, visit)
  })
  // host / client 误用 + 风格 + 注释
  for (const im of rec.imports) {
    if (/^(node:)?(fs|path|os|child_process|crypto|http|https|net|readline|worker_threads|module|url|zlib|stream|assert|dns|tls)(\/.*)?$/.test(im.spec)) rec.nodeBuiltin.push({ spec: im.spec, line: im.line })
    if (/^react(-dom)?$/.test(im.spec)) rec.reactUse++
  }
  Object.assign(rec.quotes, countQuotes(ts, sf)) // ISS-762 乙案：只数字符串字面量里的引号（注释/标识符/正则/模板文本都不算）
  for (const [i, l] of source.split('\n').entries()) {
    if (/;\s*$/.test(l.trim())) rec.semi++
    else if (/[)\]}'"a-zA-Z0-9]$/.test(l.trim()) && !/^\s*(\/\/|\*|\/\*|#)/.test(l.trim())) rec.noSemi++
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(l)) rec.todo++
    // 端点字面量（HTTP 面是跨引擎契约，注册 API 各家不同 ⇒ 按字面量计）；**注释里的提及不算**（口径见 isDocLine）
    for (const m of l.matchAll(/["'`](\/forge-[a-z0-9-]+(?:\/[A-Za-z0-9_\-.{}:/]*)?)["'`]/g)) {
      if (!isDocLine(l, m.index) && !rec.routeLiterals.some((r) => r.line === i + 1 && r.p === m[1])) rec.routeLiterals.push({ line: i + 1, verb: '?', p: m[1], via: '字面量' })
    }
  }
  if (rec.half === 'host' && /\.(js|mjs|cjs)$/.test(rec.rel)) {
    /* host 半 `.js` 里的 TS 类型注解（H13）。
     *
     * 为什么要有这一条：`docs/code.md` 的 K4c 写着「host 半 .js 严禁 TS 类型注解」——
     * `.js` 里的 `(x: string)` 是**语法错误**，进程起来那一刻就崩。但实测发现
     * **门禁从来没在拦它**：K4c 挂的是 H11（tsconfig 档位种数），而这里算出的
     * `tsAnnotationsInJs` 只写不读，是死代码（2026-10-19 · ISS-625 查出）。
     * 本步先让它被消费（挂 H13，**暂不挂门禁**）；号义修正另单。
     *
     * 注释剥离（与 K9c 的 stripShellComments 同族）：判据量的是「有没有这么写」，
     * 不是「有没有举例说明它」。误报的代价很实——不敢在注释里写反例，文档质量损失。
     *   ① 整行注释 ⇒ 整行丢
     *   ② 行内注释 ⇒ 只丢注释起点之后，保留代码（复用 isDocLine 的行内判定，它已处理引号与 `//`）
     *   ③ 判不准 ⇒ **不剥**（多报 < 漏报，保守方向）
     */
    const annoRe = /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\w+\s*:\s*(?:string|number|boolean|any)\b/
    for (const [i, line] of source.split('\n').entries()) {
      const hit = line.match(annoRe)
      if (!hit) continue
      // isDocLine(line, idx) = 「idx 这个位置在注释里吗」。整行注释 / 行内 `//` 之后都返回 true。
      if (isDocLine(line, hit.index ?? 0)) continue
      rec.tsAnnotationsInJs.push({ line: i + 1, text: line.trim().slice(0, 80) })
    }
  }
  F.push(rec)
}
function propName(p) {
  if (!p.name) return null
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text
  return text(p.name, null) || null
}

const shellFacts = shellFiles.map((f) => ({ rel: rel(f), text: fs.readFileSync(f, 'utf8') }))
const NS = F.filter((x) => !x.shell)
const SRC = NS.filter((x) => !x.isTest)
const TST = NS.filter((x) => x.isTest)
const PKG_OF_SRC = [...new Set(SRC.map((x) => x.pkg))].sort()

/* ───────────────────────────────── 3. 度量 ───────────────────────────────── */
const SEC = { B: 'B 包与装配', N: 'N 目录与形态', H: 'H 半区与依赖方向', C: 'C 契约与铁律', D: 'D 重复与共享层', T: 'T 测试与门禁', E: 'E 错误处理与可观测', Z: 'Z 死码与引用' }
const METRICS = []
const M = (sec, id, title, value, extra = {}) => {
  if (ONLY && !ONLY.has(sec)) return
  METRICS.push({ sec, id, title, value, offenders: extra.offenders || [], sites: extra.sites || [], unit: extra.unit || '', note: extra.note || '', gate: extra.gate || '', scanN: extra.scanN === undefined ? null : extra.scanN, ...(extra.skip ? { skip: true } : {}), ...(extra.env ? { env: true } : {}) })
}
const topOf = (arr) => arr.slice(0, TOP)
const cnt = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); m.set(k, (m.get(k) || 0) + 1) } return [...m.entries()].sort((a, b) => b[1] - a[1]) }
const group = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x) } return m }

/* ── 先建跨包 import 边表（B5/H 两章都要用） ── */
const pkgDeps = new Map()   // pkg -> Set(pkg)
const depEdges = []
const pkgPkgJson = (p) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p, 'package.json'), 'utf8')) } catch { return {} } }
for (const x of SRC.concat(TST)) {
  for (const im of x.imports) {
    const spec = im.spec || ''
    if (!/^\.{1,2}\//.test(spec) && /^forge-[a-z0-9-]+/.test(spec)) {
      const to = spec.split('/')[0]
      if (!pkgDeps.has(x.pkg)) pkgDeps.set(x.pkg, new Set())
      if (to !== x.pkg) pkgDeps.get(x.pkg).add(to)
      depEdges.push({ from: x.pkg, to, k: x.rel, line: im.line })
    }
  }
}

/* ═════ B 包与装配 ═════ */
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const declared = new Set(rootPkg.workspaces || [])
const dirsWithPkg = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'package.json'))).map((e) => e.name)
const forgeDirs = dirsWithPkg.filter((d) => /^forge-/.test(d))
const orphans = forgeDirs.filter((d) => !declared.has(d))
const ghostWs = [...declared].filter((d) => !fs.existsSync(path.join(ROOT, d)))
M('B', 'B1', '包总数：workspace 声明 / 盘上有 package.json 的 forge-*', `${declared.size} / ${forgeDirs.length}`, { note: '真相源 = 根 package.json workspaces 字段' })
M('B', 'B2', '未列入 workspaces 的 forge 包（无锁、无 typecheck、靠手工 symlink 苟活）', orphans.length, { offenders: orphans.map((o) => ({ k: o })), gate: 'K1a' })
M('B', 'B3', 'workspaces 里声明了但磁盘没有的包', ghostWs.length, { offenders: ghostWs.map((o) => ({ k: o, d: '装不上 ⇒ 任何 import 它的人都悬空' })), gate: 'K1g', scanN: declared.size })

/* 装配真相源有 **三处**（2026-09-22 实测修正；早版只读 profile 的 insert 段，
   把「只靠软链 + 自带 patch 上电」的包（如 forge-combo-model / forge-role）误判成"从未挂载"——它们靠
   「软链进 profiles/node_modules + 包自带 dsh.bundle.patch 自动合并」上电）：
   ① profile 的 cordis.patch.yml（insert 段与顶层 - id 都算）
   ② 包自带 patch（package.json 的 dsh.bundle.patch 指向的文件，被自动合并）
   ③ profiles/node_modules 里的软链（决定 ② 有没有机会生效）
   ⚠️ ①③ 是本机状态，双电脑各一份 ⇒ 这三项只作告警，不作跨机可复算的硬门禁。 */
function mountFile(f) {
  if (!fs.existsSync(f)) return null
  const ids = new Set()
  for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
    const l = raw.trimEnd()
    if (!l.trim() || l.trim().startsWith('#')) continue
    const m = l.match(/^\s*-?\s*id:\s*(forge-[\w-]+)/)
    if (m) ids.add(m[1])
  }
  return ids
}
// 现役两个 home（2026-10-01 · ISS-557）：A = ~/.dsh（官方 App 19387），B = ~/.dsh-matter（3210 独立服务）。
// profile 名自动发现（口径在 assembly-anchors-lib.mjs）—— 旧硬编码 ['web','web-b'] 被查实四个面全不在跑。
const AH = { A: path.join(process.env.HOME || '', '.dsh'), B: path.join(process.env.HOME || '', '.dsh-matter') }
const PATCH_FILES = Object.fromEntries(Object.entries(AH).flatMap(([t, h]) => profilesOf(h).map((p) => [`${t}(${p})`, path.join(h, 'profiles', p, 'cordis.patch.yml')])))
const MOUNTS = Object.fromEntries(Object.entries(PATCH_FILES).map(([k, f]) => [k, mountFile(f)]).filter(([, v]) => v))
const MOUNTED = new Set(Object.values(MOUNTS).flatMap((s) => [...s]))
const LINK_A = new Set(readSharedMirror(AH.A).keys())
const LINK_B = new Set(readSharedMirror(AH.B).keys())
const PRIVATE_A = privatePkgs(AH.A)
const PRIVATE_B = privatePkgs(AH.B), ASSEMBLY_VISIBLE = Object.values(PATCH_FILES).some((f) => fs.existsSync(f)) || MOUNTED.size > 0 || LINK_A.size > 0 || LINK_B.size > 0 // 本机有没有"装配真相源"；没有 ⇒ 依赖可达性的判据一律不判（ISS-751 的 CI 收尾）
/** 包是否自带 bundle.patch（有 ⇒ 只要被链上就自动 insert） */
const selfPatch = new Set(PKG_DIRS.filter((p) => {
  const d = pkgPkgJson(p)
  const relPath = d && d.dsh && d.dsh.bundle && d.dsh.bundle.patch
  return !!relPath && fs.existsSync(path.join(ROOT, p, String(relPath).replace(/^\.\//, '')))
}))
{
  const disk = new Set(PKG_DIRS.filter((p) => p !== 'electron-shell'))
  const ghost = [...MOUNTED].filter((m) => !disk.has(m))
  // 第二锚点进可达集（ISS-757 收尾 + 台账 §47），**只对有自带 patch 的包生效**：解析得到 + 自带 patch = 引擎自动 insert ⇒ 真在跑；
  // 不带 patch 的只是"能被解析"、角色仍是库包（放宽到"私有层有就算可达"会让 B5c 5→1，那是改松不是修洞）。
  const reachable = (p) => LINK_A.has(p) || LINK_B.has(p) || MOUNTED.has(p) || (((PRIVATE_A.has(p) || PRIVATE_B.has(p)) && selfPatch.has(p)))
  M('B', 'B4', '装配三源：profile 声明 / A 软链 / B 软链 / 包自带 patch', `${MOUNTED.size} · ${LINK_A.size} · ${LINK_B.size} · ${selfPatch.size}`, { env: true, note: '真相源 = ~/.dsh{,-b}/profiles/{web,web-b}/cordis.patch.yml + profiles/node_modules + package.json 的 dsh.bundle.patch；**B5 的可达还含第二锚点** `<home>/profiles/<profile>/node_modules`（引擎先按 profile 目录解析，ISS-757 收尾）' })
  const importedBy = new Map()
  for (const e of depEdges) { if (!importedBy.has(e.to)) importedBy.set(e.to, new Set()); importedBy.get(e.to).add(e.from) }
  const unreachable = [...disk].filter((p) => !reachable(p))
  const neverUsed = unreachable.filter((p) => !(importedBy.get(p) || new Set()).size)
  M('B', 'B5', '三不靠：两个引擎都不可达（含 profile 私有锚点）、且没有任何包 import 它（跑不到也没人依赖）', neverUsed.length, { env: true, offenders: neverUsed.map((o) => ({ k: o, n: SRC.filter((x) => x.pkg === o).length, d: '源文件数' })), gate: 'K1b', skip: !ASSEMBLY_VISIBLE, note: 'skip=true = 这台机器上**没有装配真相源**（CI runner / 新机首次检出：四个 cordis.patch.yml 都不在，两个 shared 镜像也空）⇒ “不可达”这条判不了，K1b 必须**不判**而不是判成 17 个新增三不靠包（ISS-751 的 CI 收尾）' })
  M('B', 'B5b', '未进 profile 声明但靠"软链 + 自带 patch"上电的包（隐式装配：换机器/重装即掉）', [...disk].filter((p) => !MOUNTED.has(p) && (LINK_A.has(p) || LINK_B.has(p)) && selfPatch.has(p)).length, { env: true, offenders: [...disk].filter((p) => !MOUNTED.has(p) && (LINK_A.has(p) || LINK_B.has(p)) && selfPatch.has(p)).map((p) => ({ k: p, d: ((LINK_A.has(p) ? 'A' : '') + (LINK_B.has(p) ? ' B' : '')).trim() })) }) // trim：只链 A 时旧写法产出 "A "，审计稿行尾空格会被 pre-commit 的 whitespace 判据拒（ISS-777）
  M('B', 'B5c', '库包（不可达引擎但被别的包 import，不挂载是对的）', unreachable.filter((p) => (importedBy.get(p) || new Set()).size).length, { env: true, offenders: unreachable.filter((p) => (importedBy.get(p) || new Set()).size).map((p) => ({ k: p, d: [...(importedBy.get(p) || new Set())].join(' ') })) })
  M('B', 'B6', '装配表声明了但盘上没有的 id（装配死引用）', ghost.length, { offenders: ghost.map((o) => ({ k: o })), gate: 'K1c' })
  const onlyA = [...LINK_A].filter((p) => !LINK_B.has(p) && disk.has(p))
  M('B', 'B10', '只链进 A 没链进 B 的包（两引擎能力面差异的清单，不是错，是要显式）', onlyA.length, { env: true, offenders: onlyA.map((p) => ({ k: p, d: selfPatch.has(p) ? '自带 patch ⇒ A 里上电' : '仅软链' })) })
}
// profiles/node_modules 的 symlink 归属（全局单例，ISS-416 的机制根因）
const profNm = path.join(process.env.HOME || '', '.dsh/profiles/node_modules')
if (fs.existsSync(profNm)) {
  const links = fs.readdirSync(profNm).filter((e) => /^forge-/.test(e))
  const toWorktree = []
  for (const l of links) {
    let real = ''
    try { real = fs.realpathSync(path.join(profNm, l)) } catch { real = '<断链>' }
    if (real !== path.join(ROOT, l) && !real.startsWith(ROOT + path.sep)) toWorktree.push({ k: l, d: real })
    else if (real.startsWith(ROOT + path.sep + '.wt' + path.sep)) toWorktree.push({ k: l, d: real })
  }
  M('B', 'B7', '服务侧 symlink：指向主 checkout 的 / 全部链接', `${links.length - toWorktree.length} / ${links.length}`, { env: true, offenders: toWorktree.map((t) => ({ k: t.k, d: t.d })), note: '指向工作树 = 生产 3210 跑的是别人的分支（§4 工作区隔离）。⚠️ 本行按**本树的根**判"主 checkout"：在仓内工作树（`.wt/<ISS-NNN>`）里取证时，指向主 checkout 的链接同样会被算成 offender ⇒ 工作树里的读数与主 checkout 不可横比，两边的取证现场见生成块顶部那行「取证环境」' })
}

/* ═════ N 目录与形态 ═════ */
const extCount = cnt(SRC.concat(TST), (x) => path.extname(x.rel))
M('N', 'N1', '源文件扩展名分布（含 .js / .mjs ⇒ 无类型兜底的占比）', extCount.map(([k, v]) => `${k}:${v}`).join(' '), { note: '铁律：.js 严禁 TS 注解，且 .js 无 typecheck 兜底' })
const hostJs = SRC.filter((x) => x.half === 'host' && /\.(js|mjs|cjs)$/.test(x.rel))
const hostTs = SRC.filter((x) => x.half === 'host' && /\.ts$/.test(x.rel))
M('N', 'N2', 'host 半语言构成：.js（裸奔）/ .ts（有类型）', `${hostJs.length} / ${hostTs.length}`, { offenders: topOf(cnt(hostJs, (x) => x.pkg)).map(([k, v]) => ({ k, n: v, d: 'host .js 文件数' })) })
const clientHostMix = SRC.filter((x) => x.half === 'host' && /\.[jt]sx$/.test(x.rel))
M('N', 'N3', 'host 半里出现 JSX 文件（多半是分半归属写错）', clientHostMix.length, { offenders: clientHostMix.map((x) => ({ k: x.rel })) })
const huge = SRC.filter((x) => x.lines >= 1000).sort((a, b) => b.lines - a.lines)
const big = SRC.filter((x) => x.lines >= 500 && x.lines < 1000)
M('N', 'N4', '≥1000 行的源文件（god module）/ 500~999 行', `${huge.length} / ${big.length}`, { offenders: topOf(huge).map((x) => ({ k: x.rel, n: x.lines })), gate: 'K2a' })
// 「各起名字」的证据 = client 半**第三级目录名**种数（src/pm / src/components ...）。⚠️ 一层 = 文件名之外的目录段：旧写法按 seg[2] 取，把 `src/endpoints.ts` 当成一个"目录" ⇒ 每加一个 src 根文件涨一格，K2b 上限因此被假顶 77→78（涨格的不是债，是尺子；细则与"规则号 N5 挂 K2b 而文本在 K2c"的错配都登记在 docs/code.md K2c）
const subDirs = group(SRC.filter((x) => x.half === 'client'), (x) => { const seg = x.rel.split('/'); return seg.length > 2 ? `${seg[0]}/${seg[1]}/${seg.slice(2, -1).join('/')}` : `${seg[0]}/${seg[1]}` })
const dirNames = new Set([...subDirs.keys()].map((k) => k.split('/').slice(2).filter(Boolean).join('/')))
M('N', 'N5', 'client 半子目录名种数（同一层各起名字 = 新人/agent 找不到落点）', `${dirNames.size} 个名字 / ${subDirs.size} 个目录`, { offenders: [...subDirs.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, TOP).map(([k, v]) => ({ k, n: v.length })), gate: 'K2b' })
const clientEntry = PKG_DIRS.map((p) => {
  for (const c of [`${p}/src/dsh/client-entry.tsx`, `${p}/src/dsh/client-entry.ts`, `${p}/src/client-entry.tsx`, `${p}/src/index.tsx`]) if (fs.existsSync(path.join(ROOT, c))) return { k: p, d: c }
  const has = SRC.some((x) => x.pkg === p && x.half === 'client')
  return has ? { k: p, d: '<非标准路径>' } : null
}).filter((x) => x && x.d !== '<非标准路径>' && /client-entry/.test(x.d))
const pkgsWithClient = PKG_DIRS.filter((p) => p !== 'electron-shell' && SRC.some((x) => x.pkg === p && x.half === 'client'))
M('N', 'N6', 'client 入口命名统一（src/dsh/client-entry.{tsx,ts}）的包 / 有 client 半的包', `${clientEntry.length} / ${pkgsWithClient.length}`, { offenders: pkgsWithClient.filter((p) => !clientEntry.some((c) => c.k === p)).map((p) => ({ k: p, d: '有 client 半但入口不在标准路径' })) })
// 风格漂移（无 formatter 的后果）
const quoteMixed = SRC.filter((x) => x.quotes.d > 5 && x.quotes.s > 5)
const semiMixed = SRC.filter((x) => x.semi > 10 && x.noSemi > 10 && Math.min(x.semi, x.noSemi) / Math.max(x.semi, x.noSemi) > 0.2)
M('N', 'N7', '引号风格混用（同一文件 " 与 \' 各 >5 次）', `${quoteMixed.length} / ${SRC.length}`, { offenders: topOf(cnt(quoteMixed, (x) => x.pkg)).map(([k, v]) => ({ k, n: v })), note: '没有 formatter ⇒ 风格只能靠自觉 ⇒ 自觉不可复算' })
M('N', 'N8', '分号风格混用（同文件带分号/不带分号都 >10 行且比例 >0.2）', semiMixed.length, { offenders: topOf(cnt(semiMixed, (x) => x.pkg)).map(([k, v]) => ({ k, n: v })) })
const todoTotal = SRC.concat(TST).reduce((s, x) => s + x.todo, 0)
M('N', 'N9', 'TODO/FIXME/XXX/HACK 注释总数', todoTotal, { offenders: topOf(cnt(SRC.concat(TST).filter((x) => x.todo), (x) => x.pkg)).map(([k, v]) => ({ k, n: v })), note: '规范口径：TODO 必须有单号，无主 TODO = 债务不记账' })

/* ═════ H 半区与依赖方向 ═════ */
M('H', 'H1', '跨包 import 边（文件级去重后）/ 出现过的包→包组合', `${depEdges.length} / ${depEdges.length ? group(depEdges, (e) => e.from + '→' + e.to).size : 0}`, { offenders: topOf(cnt(depEdges, (e) => `${e.from} → ${e.to}`)).map(([k, v]) => ({ k, n: v })) })
// 环检测（包级）
const adj = new Map([...pkgDeps].map(([k, v]) => [k, [...v]]))
const cycles = []
{
  const state = new Map()
  const dfs = (n, stack) => {
    state.set(n, 1)
    for (const m of (adj.get(n) || [])) {
      if (state.get(m) === 1) { const i = stack.indexOf(m); if (i >= 0) cycles.push(stack.slice(i).concat(m)) }
      else if (!state.get(m)) dfs(m, stack.concat(m))
    }
    state.set(n, 2)
  }
  for (const n of adj.keys()) if (!state.get(n)) dfs(n, [n])
}
const uniqCycles = [...group(cycles.map((c) => [...c].sort().join(' ⇄ ')), (x) => x).keys()]
M('H', 'H2', '包级 import 环（同处改两包 ⇒ 无法独立验证/无法独立发布）', uniqCycles.length, { offenders: uniqCycles.map((c) => ({ k: c })), gate: 'K3a' })
// 决策 15 的方向红线：PM → agents 单向，协议包零依赖
const wrongDir = depEdges.filter((e) => (e.to === 'forge-pm' && ['forge-agents', 'forge-agent-protocol', 'forge-service-kit', 'forge-design', 'forge-shell'].includes(e.from)) || ((e.from === 'forge-agent-protocol' || e.from === 'forge-design' || e.from === 'forge-service-kit') && /^forge-(?!agent-protocol|design|service-kit)/.test(e.to)))
M('H', 'H3', '依赖方向违规（AGENTS 决策 15：PM→agents 单向；契约/共享包不得 import 业务包）', wrongDir.length, { offenders: topOf(wrongDir.map((e) => ({ k: `${e.k}:${e.line}`, d: `${e.from} → ${e.to}` }))), gate: 'K3b' })
const protoDeps = [...(adj.get('forge-agent-protocol') || [])]
M('H', 'H4', 'forge-agent-protocol（契约包）的出边（应为 0，有边就不是契约）', protoDeps.length, { offenders: protoDeps.map((p) => ({ k: p })), gate: 'K3g',
  /* ISS-629 补丁：分母必须与被判对象**同生共死**。
     原来写 adj.size（依赖图节点数 ≈ 19 个别的包）——那是**第五种假判据形态：分母与被判对象脱钩**
     （前四种：没人调用 / 恒绿 / 空转 / 用错词表）。后果：契约包若被删/改名，protoDeps 恒空、
     adj.size 照样 > 0 ⇒ 规则判绿，而被判的东西**整个不存在了**。
     现在分母 = 契约包是否真在盘点集合里：不在 ⇒ scanN=0 ⇒ lint-code 判「判据失效」（红），
     而不是拿无关的包数糊弄过去。 */
  scanN: SRC.some((x) => x.pkg === 'forge-agent-protocol') ? 1 : 0 })
// 未声明依赖：先排掉"本来就不该声明"的模块（node 内置的不带前缀写法 / bun API / electron / 测试运行时）
const NODE_BUILTIN = new Set(['fs','path','os','http','https','net','url','util','zlib','stream','crypto','child_process','events','readline','module','assert','dns','tls','worker_threads','perf_hooks','querystring','string_decoder','tty','v8','vm','buffer','constants','dgram','inspector','sea','test'])
const RUNTIME_PROVIDED = new Set(['bun', 'bun:test', 'electron', 'vitest'])  // 运行时提供、本就不该写进 dependencies
const aliasImports = []   // 路径别名 import（@/... 由各包构建脚本各配一份 alias）
const undeclaredHard = []   // 未声明且解析不到 ⇒ 换机器/重装依赖即崩（ISS-504 同型）
const undeclaredSoft = []   // 未声明但靠 hoisting 侥幸可解析 ⇒ 隐式耦合
/* ISS-624｜**宿主注入模块**（host-injected）豁免 —— 这是改口径，不是放水，边界逐条写在下面。
   原口径的问题：`vscode` 由 VSCode / TraeCode **扩展宿主在运行时注入**，扩展工程既不该也不需要把它写进
   dependencies（真写进去反而装不上），也不存在"解析不到 ⇒ 换机器即崩"这回事。旧口径把它记成
   「未声明且解析不到（ISS-504 同型）」= 纯误报。实测 offender：
   `forge-trae-direct/trae-extension/extension.js:31` 的 `require("vscode")`。
   新口径（三条**全中**才免，缺一条就照旧记违例）：
     ① 说明符**整串**命中 HOST_INJECTED —— `vscode/foo` 这类子路径不放行（那才是真解析不到）
     ② 从该文件目录**向上第一个** package.json 里 `engines.<键>` 或 `extensionKind` 有声明
        ⇒ 证明"这个目录确实是一个扩展工程"，不是普通源码目录
     ③ 那份 package.json 所在目录**不在根 workspaces 里** —— 扩展随 vsix 装进宿主，不是本仓构建对象
   反例（改完必须仍被抓，变异验证见交付说明）：普通源码里的 `import x from "no-such-pkg"`（①不命中）；
   在 workspace 包内写 `require("vscode")`（③不命中）。
   豁免不静默：每次运行把免掉的处数与证据写进 H5a 的 note，跳数一眼可见。 */
// 判据本体是上方的纯函数 hostInjectedWhy（可在 --selftest-caliber 里喂假事实）；这里只做 IO 绑定。
const HOST_CTX = {
  dirname: (p) => path.posix.dirname(p),
  hasPkg: (d) => fs.existsSync(path.join(ROOT, d, 'package.json')),
  pkgJson: (d) => pkgPkgJson(d),
  isDeclared: (d) => declared.has(d),
}
const hostInjectedWaived = []
for (const x of SRC.concat(TST)) {
  const pj = pkgPkgJson(x.pkg)
  const own = new Set([...Object.keys(pj.dependencies || {}), ...Object.keys(pj.devDependencies || {}), ...Object.keys(pj.peerDependencies || {})]) // peer 也是声明（本仓把 react/react-dom 放 peer 是约定俗成的 UI 库写法）
  for (const im of x.imports) {
    const spec = im.spec || ''
    if (!spec || /^[./]/.test(spec) || /^node:/.test(spec) || /^bun:/.test(spec)) continue
    if (spec.startsWith('@/')) { aliasImports.push({ k: `${x.rel}:${im.line}`, pkg: x.pkg, spec }); continue }
    const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (!bare || NODE_BUILTIN.has(bare) || RUNTIME_PROVIDED.has(spec) || RUNTIME_PROVIDED.has(bare)) continue
    if (/^forge-/.test(bare)) { if (bare !== x.pkg && !own.has(bare)) undeclaredSoft.push({ k: `${x.rel}:${im.line}`, d: `${x.pkg} 用了 ${bare}，本包 package.json 未声明（靠 root 提升侥幸可解析）` }); continue }
    const hiWhy = hostInjectedWhy(x.rel, spec, HOST_CTX)
    if (hiWhy) { hostInjectedWaived.push({ k: `${x.rel}:${im.line}`, d: hiWhy }); continue } // ISS-624：宿主注入（两条可解析性档都不该记它）
    const resolvable = fs.existsSync(path.join(ROOT, x.pkg, 'node_modules', bare)) || fs.existsSync(path.join(ROOT, 'node_modules', bare))
    const o = { k: `${x.rel}:${im.line}`, pkg: x.pkg, mod: bare }
    if (own.has(bare)) continue
    if (resolvable) undeclaredSoft.push({ ...o, d: `${x.pkg} import ${bare}：未声明，靠 hoisting 侥幸可解析` })
    else undeclaredHard.push({ ...o, d: `${x.pkg} import ${bare}：未声明且解析不到（ISS-504 型：引擎加载那一刻才炸）` })
  }
}
M('H', 'H5a', '未声明且解析不到的 import（换台机器/重装依赖即崩，ISS-504 同型）', undeclaredHard.length, { env: true, offenders: topOfAll(undeclaredHard).map((u) => ({ k: u.k, d: u.d })), note: `本项依赖**已安装的 node_modules**：本次有 ${PKG_DIRS.filter((p) => !fs.existsSync(path.join(ROOT, p, 'node_modules'))).length} / ${PKG_DIRS.length} 个包缺依赖 ⇒ 缺依赖时本项虚高（无安装的干净工作树实测 2 → 44，同一条 commit 两棵树不同数就是这里来的，ISS-742）；基线与上限只许在依赖完整的参照树上录。**ISS-624 宿主注入豁免**（判据 hostInjectedWhy，三条全中才免：说明符整串命中 + 上级 package.json 声明 engines/extensionKind + 不在 workspaces）：本次免 ${hostInjectedWaived.length} 处${hostInjectedWaived.length ? `（${hostInjectedWaived.map((w) => `${w.k} ← ${w.d}`).join('；')}）` : ''}；免掉的处数写在这里，是为了让"豁免"本身可数，不是静默清零`, gate: 'K3c' })
M('H', 'H5b', '未声明但靠 hoisting 侥幸可解析的 import（隐式耦合：换包管理器/升版本即断）', undeclaredSoft.length, { offenders: topOf(cnt(undeclaredSoft, (u) => `${u.pkg} → ${u.mod}`)).map(([k, v]) => ({ k, n: v, d: '命中处数' })), gate: 'K3c' })
M('H', 'H5c', '路径别名 import（@/... ）的包数 / 处数（每包的构建脚本要各配一份 alias ⇒ 编译能过、运行时另一回事）', `${new Set(aliasImports.map((a) => a.pkg)).size} / ${aliasImports.length}`, { offenders: topOfAll(cnt(aliasImports, (a) => a.pkg)).map(([k, v]) => ({ k, n: v, d: '别名 import 处数' })), gate: 'K3f' })
// 半区误用
const clientNode = SRC.filter((x) => x.half === 'client' && x.nodeBuiltin.length)
const hostReact = SRC.filter((x) => x.half === 'host' && x.reactUse > 0)
M('H', 'H6', 'client 半 import node 内置模块（浏览器侧必炸或靠宿主 polyfill）', clientNode.length, { offenders: topOf(clientNode).map((x) => ({ k: x.rel, n: x.nodeBuiltin.length, d: x.nodeBuiltin.slice(0, 3).map((b) => b.spec).join(', ') })), gate: 'K3d' })
/* H7 的同族盲区（ISS-629 补丁 · 显式登记，不修）：
   ① **识别器自身是否工作**——`x.half === 'host'` 来自包的半身判定（package.json exports / 目录约定）。
      若判定整体坏掉（例如所有包都被判成 client），`hostReact` 会恒为空、H7 恒绿，
      而分母 scanN 也跟着变 0 ⇒ 好在会落进「判据空转」红，不会静默。
      但**部分坏**（少数包 half 判错）仍不可见 —— 这是本项口径内的盲区，不是判据失效。
   ② 只认静态 `import` 语句；`require("react")` 与动态说明符的覆盖依赖导入提取器，未单独断言。 */
M('H', 'H7', 'host 半 import react（bundle 污染 / 无渲染上下文）', hostReact.length, { offenders: topOf(hostReact).map((x) => ({ k: x.rel })), gate: 'K3h', scanN: SRC.filter((x) => x.half === 'host').length })
// exports 形态合规：按**角色**判，不一刀切（插件要两半 + dsh.client；库包只要入口）
const roleOf = (p) => {
  const src = SRC.filter((x) => x.pkg === p)
  const host = src.some((x) => x.half === 'host')
  const client = src.some((x) => x.half === 'client')
  const mounted = MOUNTED.has(p) || LINK_A.has(p) || LINK_B.has(p)
  if (mounted && host && client) return '插件（两半）'
  if (mounted) return '插件（' + (host ? '仅 host' : '仅 client') + '）'
  if (host && client) return '未挂载的两半包'
  return '库包'
}
const ROLES = PKG_DIRS.filter((p) => p !== 'electron-shell').map((p) => ({ k: p, role: roleOf(p) }))
M('B', 'B8', '包角色分布（判据：是否挂进 cordis + 有没有两半 ⇒ 决定它该长成什么样）', cnt(ROLES, (r) => r.role).map(([k, v]) => `${k}:${v}`).join(' '), { env: true, offenders: topOf(cnt(ROLES, (r) => r.role)).map(([k, v]) => ({ k, n: v, d: ROLES.filter((r) => r.role === k).map((r) => r.k).slice(0, 6).join(' ') })) })
const exportIssues = []
for (const p of PKG_DIRS.filter((x) => x !== 'electron-shell')) {
  const pj = pkgPkgJson(p)
  const ex = pj.exports || {}
  const role = roleOf(p)
  const src = SRC.filter((x) => x.pkg === p)
  const hasHost = src.some((x) => x.half === 'host')
  const hasClient = src.some((x) => x.half === 'client')
  if (hasHost && !ex['.'] && !pj.main) exportIssues.push({ k: p, d: `有 host 半但 exports["."] 与 main 都缺（${role}）` })
  if (hasClient && !ex['./client'] && !ex['.']) exportIssues.push({ k: p, d: `有 client 半但没有任何 client 入口（${role}）` })
  if (/^插件/.test(role) && !pj.dsh) exportIssues.push({ k: p, d: '挂在 cordis 上当插件用，但 package.json 无 dsh 声明（引擎不知道注入什么）' })
  if (role === '未挂载的两半包') exportIssues.push({ k: p, d: '有两半却没挂载也没被别的包 import ⇒ 角色待定（插件 or 库）' })
}
const roleBad = new Set(exportIssues.map((e) => e.k))
M('H', 'H8', 'exports 形态与角色不符的包（按 B8 的角色分别要求，不一刀切）', `${roleBad.size} / ${PKG_DIRS.filter((x) => x !== 'electron-shell').length}`, { offenders: exportIssues.map((e) => ({ k: e.k, d: e.d })), gate: 'K3e', skip: !ASSEMBLY_VISIBLE, note: '与 B5 同一条前置：本机没有装配真相源 ⇒ 角色判不了（CI 上 5→16 那种假红就是这么来的）' })
// tsconfig 覆盖面与选项抄写
const tsconfigs = []
for (const p of PKG_DIRS) {
  const dir = path.join(ROOT, p)
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  const nested = entries.filter((e) => /^tsconfig.*\.json$/.test(e)).map((e) => `${p}/${e}`)
  const extra = [`${p}/tsconfig.json`, `${p}/tsconfig.lib.json`, `${p}/src/tsconfig.json`].filter((r) => !nested.includes(r) && fs.existsSync(path.join(ROOT, r)))
  for (const f of [...nested, ...extra]) {
    let j = null
    try {
      // tsconfig 是 JSONC：允许注释与尾逗号 ⇒ 解析要两者都剥，否则会把"能跑的"配置读成空 include（静默误判）
      const raw = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')
      j = JSON.parse(raw)
    } catch (e) { j = { _fail: String(e && e.message).slice(0, 60) } }
    tsconfigs.push({ pkg: f.split('/')[0], file: f, co: (j.compilerOptions || {}), include: j.include || [], extendsFrom: j.extends || null, fail: j._fail || null })
  }
}
const pkgsNoTsconfig = PKG_DIRS.filter((p) => !tsconfigs.some((t) => t.pkg === p))
M('H', 'H9', '零 tsconfig 的包（typecheck 门禁完全盲区）', pkgsNoTsconfig.length, { offenders: pkgsNoTsconfig.map((p) => ({ k: p, d: `${SRC.filter((x) => x.pkg === p).length} 个源文件无类型检查` })), gate: 'K4a' })
const noLibGate = PKG_DIRS.filter((p) => p !== 'electron-shell').filter((p) => {
  const has = SRC.some((x) => x.pkg === p && x.half === 'host')
  if (!has) return false
  const tc = tsconfigs.filter((t) => t.pkg === p)
  const coversHost = tc.some((t) => (t.include || []).some((i) => /lib/.test(i)) || (t.extendsFrom && t.file.includes('.lib.')))
  const pj = pkgPkgJson(p)
  const scriptCovers = /tsconfig\.lib\.json/.test((pj.scripts || {}).typecheck || '')
  return !(coversHost || scriptCovers)
})
M('H', 'H10', '有 host 半但 host 不在任何 tsconfig 范围内（ISS-504 根因仍在）', noLibGate.length, { offenders: noLibGate.map((p) => ({ k: p, n: SRC.filter((x) => x.pkg === p && x.half === 'host').length })), gate: 'K4b' })
const optSign = (co) => ['strict', 'noUncheckedIndexedAccess', 'target', 'module', 'moduleResolution', 'jsx'].map((k) => `${k}=${co[k] === undefined ? '-' : String(co[k])}`).join(' ')
const optGroups = group(tsconfigs.filter((t) => !t.extendsFrom), (t) => optSign(t.co))
M('H', 'H11', '基础 tsconfig 的"编译器选项档位"种数（每多一档 = 一份手写抄写，改不动）', optGroups.size, { offenders: [...optGroups.entries()].map(([k, v]) => ({ k: `${k}`, n: v.length, d: v.map((x) => x.file).join(', ') })), note: '合规形态：一份 base + 各包 extends（当前无 base）', gate: 'K4c' })
const nonStrict = tsconfigs.filter((t) => t.co.strict === false && !t.file.includes('.lib.'))
M('H', 'H12', '主 tsconfig 里 strict:false（严格度不达标，且与 forge-ui 口径不一致）', nonStrict.length, { offenders: nonStrict.map((t) => ({ k: t.file })) })
/* H13：host 半 `.js` 里的 TS 类型注解。
 * 为什么单列：`.js` 里的 `(x: string)` 是语法错误 ⇒ 进程起来那一刻崩（ISS-416 同型）。
 * `docs/code.md` 的 K4c 本该拦它，但实测 K4c 挂的是 H11（tsconfig 档位种数）⇒ **假门禁**。
 * 本度量先让检测被消费，挂门禁是下一步（ISS-625 第二步）。
 * offenders 带行号与原文片段：光报数人不知道去改哪。 */
const tsAnno = SRC.filter((x) => x.tsAnnotationsInJs?.length > 0)
M('H', 'H13', 'host 半 `.js` 里的 TS 类型注解（`.js` 里写 `(x: string)` 是语法错误 ⇒ 进程起来即崩）', tsAnno.reduce((s, x) => s + x.tsAnnotationsInJs.length, 0), { offenders: tsAnno.flatMap((x) => x.tsAnnotationsInJs.map((a) => ({ k: `${x.rel}:${a.line}`, d: a.text }))) })

/* ═════ C 契约与铁律 ═════ */
const toolSites = SRC.reduce((s, x) => s + x.toolSites, 0)
const tools = SRC.flatMap((x) => x.toolDefs.map((t) => ({ ...t, pkg: x.pkg, k: x.rel })))
const literalTools = tools.filter((t) => t.literal)
const opaqueTools = tools.filter((t) => !t.literal)
const noRender = literalTools.filter((t) => t.hasOutput && !t.hasRender && !t.renderHelper)
const noOutput = literalTools.filter((t) => !t.hasOutput)
M('C', 'C1', 'defineTool 调用点：总数（可静态判定 / 经 helper 传参判不了）', `${toolSites}（${literalTools.length} / ${opaqueTools.length}）`, { offenders: topOf(cnt(tools, (t) => t.pkg)).map(([k, v]) => ({ k, n: v })), note: '判不了的 ⇒ 显式盲区登记，不能记成"合规"' })
M('C', 'C2', '铁律 1「output.render 必填」缺位（只统计可静态判定的那部分）', noRender.length + noOutput.length, { offenders: [...noOutput.map((t) => ({ k: `${t.k}:${t.line}`, d: '整个 output 缺位 ⇒ 崩 userRender' })), ...noRender.map((t) => ({ k: `${t.k}:${t.line}`, d: '有 output 无 render' }))], gate: 'K5a' })
const badNames = literalTools.filter((t) => t.name && !/^[a-zA-Z0-9_-]+$/.test(t.name))
M('C', 'C3', '铁律 2「工具名 ^[a-zA-Z0-9_-]+$」违规', badNames.length, { offenders: badNames.map((t) => ({ k: `${t.k}:${t.line}`, d: t.name })) })
const toolNames = literalTools.filter((t) => t.name)
const dupTool = [...group(toolNames, (t) => t.name).entries()].filter(([, v]) => v.length > 1)
M('C', 'C4', '工具名重复定义（同名两处 ⇒ 后注册者静默失效，ISS-620 同型）', dupTool.length, { offenders: dupTool.map(([n, v]) => ({ k: n, n: v.length, d: [...new Set(v.map((t) => `${t.k}:${t.line}`))].join(' ') })), note: `取不到字面量名的调用 ${literalTools.filter((t) => !t.name).length} 处`, gate: 'K5d' })
const addProps = SRC.flatMap((x) => x.addPropsMissing.map((a) => ({ k: `${x.rel}:${a.line}`, pkg: x.pkg })))
M('C', 'C5', '铁律 5「内嵌 object 必须带 additionalProperties」缺位（type:"object" 且有 properties 的 schema 对象）', addProps.length, { offenders: topOf(cnt(addProps, (a) => a.pkg)).map(([k, v]) => ({ k, n: v })), gate: 'K5b' })
const badSection = SRC.flatMap((x) => x.sections.filter((s) => !s.keys.includes('name') || !s.keys.includes('text')).map((s) => ({ k: `${x.rel}:${s.line}`, d: `键=[${s.keys.join(',')}]（铁律 4：写成 id/content 不报错但每 turn 崩）` })))
M('C', 'C6', '铁律 4 systemPrompt.section() 键集不合规（必须含 name + text）', badSection.length, { offenders: topOf(badSection), note: `全仓 section() 调用 ${SRC.reduce((s, x) => s + x.sections.length, 0)} 处` , gate: 'K5c' })
const domains = SRC.flatMap((x) => x.storageDomains.map((d) => ({ ...d, pkg: x.pkg, k: x.rel })))
const fsWriteFiles = SRC.filter((x) => x.fsWrites > 0 && x.pkg !== 'scripts')
M('C', 'C7', 'ctx.storage.domain 使用点（AGENTS §2/code-rules §2 声称的持久化机制）', domains.length, { note: domains.length === 0 ? '⚠️ 0 处使用 ⇒ 文档写的机制在实现里不存在（forge-notify/lib/index.js:48 已自认"运行引擎无 ctx.storage.domain"）' : '' })
M('C', 'C7b', 'host 半直接 fs 同步写盘的文件数（真实生效的持久化机制）', fsWriteFiles.length, { offenders: topOf(cnt(fsWriteFiles, (x) => x.pkg)).map(([k, v]) => ({ k, n: v, d: '写盘调用点数' })), note: '与 C7 对照 ⇒ "文档说的存储" vs "实际的存储" 差多少。口径按规范 K5e 原文收在 **host 半**：`scripts/` 的 dev 工具不计（ISS-736 实测：改前 offenders scripts 9 / electron-shell 2 / forge-service-kit 1 = 12，其中 9 处是仓内脚本 —— 每加一个开发工具就把棘轮顶高一格，那不是 K5e 要管的事；判据算法一字未动，只收窄范围）', gate: 'K5e' })
const routes = SRC.flatMap((x) => x.routeLiterals.map((r) => ({ ...r, pkg: x.pkg, k: x.rel })))
const uniqPath = [...group(routes.map((r) => r.p), (x) => x).keys()]
const routePrefix = group(routes, (r) => r.p.split('/')[1] || r.p)
M('C', 'C8', 'HTTP 端点：字面量数 / 去重 path 数 / 一级前缀数', `${routes.length} / ${uniqPath.length} / ${routePrefix.size}`, { offenders: [...routePrefix.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => ({ k: '/' + k, n: v.length, d: [...new Set(v.map((r) => r.pkg))].join(' ') })), note: '口径 = "/forge-x/..." 字符串字面量（各包注册 API 形态不一，按字面量计最稳）' })
const xbAssets = loadCrossBundleBaseline(ROOT).entries, { sameHalf, dangling, crossBundle, staleCrossBundle } = routeHalves(routes, xbAssets) // 名单三档：缺失/坏结构⇒不豁免（保守），读不懂⇒当场炸；理由见 `loadCrossBundleBaseline` 文档块（ISS-793）
M('C', 'C9', '同一 path 在**同一半区内**被抄到 ≥2 个文件（改一端忘另一端的现场；跨半区成对不算，另有 C9d）', sameHalf.length, { note: `已按别名登记表（route-aliases.json 的 kind=cross-bundle-pair）免计 ${crossBundle.length} 条（名单与实际文件集合不符的 ${staleCrossBundle.length} 条 ⇒ 不豁免，明细见 route-literals.json 的 staleCrossBundle）`, offenders: topOf(sameHalf.map((c) => ({ k: c.p, n: c.files.length, d: c.halves.join(' ') }))), sites: sameHalf.flatMap((c) => c.files.map((r) => ({ k: r.k, line: r.line, p: c.p }))), gate: 'K5f' })
M('C', 'C9d', '悬空端点引用：client/mcp/scripts 写了本包前缀而本包 host 未注册（跨半区核一致的牙；静态资源 URL 已排除）', dangling.length, { offenders: topOfAll(dangling.map((d) => ({ k: `${d.k}:${d.line}`, n: 1, d: `${d.half} → ${d.p}` }))), gate: 'K5i' })
const crossPkgPath = [...group(routes, (r) => r.p).entries()].filter(([, v]) => new Set(v.map((r) => r.pkg)).size > 1)
M('C', 'C9b', '同一 path 出现在 ≥2 个包（跨包抢同一端点 / 代理他包路由）', crossPkgPath.length, { offenders: topOf(crossPkgPath).map(([p, v]) => ({ k: p, n: new Set(v.map((r) => r.pkg)).size, d: [...new Set(v.map((r) => r.pkg))].join(' ') })) })
const alien = routes.filter((r) => r.p.split('/')[1] && r.p.split('/')[1] !== r.pkg)
M('C', 'C10', '在自己包里写别人的路由前缀（边界渗漏：如 forge-pm 代答 /forge-plans）', new Set(alien.map((r) => `${r.pkg} → /${r.p.split('/')[1]}`)).size, { offenders: topOf(cnt(alien.map((r) => ({ k: `${r.pkg} → /${r.p.split('/')[1]}`, pkg: r.pkg })), (o) => o.k)).map(([k, v]) => ({ k, n: v })), sites: alien.map((r) => ({ k: r.k, line: r.line, p: r.p, prefix: '/' + r.p.split('/')[1] })), gate: 'K5g' })
const sse = SRC.filter((x) => /text\/event-stream|EventSource|res\.write\(`?data:/.test(x.shell ? '' : codeOnly(ts, fs.readFileSync(path.join(ROOT, x.rel), 'utf8')))) // ISS-762：注释里的提及不算（此前 EventSource 只出现在注释里也被记成一笔）
M('C', 'C11', '自己实现 SSE / 事件流推送的文件数（DSH 事件面跨进程不通 ⇒ 每包一份 = 该沉共享层）', sse.length, { offenders: topOf(sse).map((x) => ({ k: x.rel })), note: '结论出处：DOC-258 §4.1a（宿主→浏览器白名单加不进插件）' })

/* ═════ D 重复与共享层 ═════ */
const impls = []
for (const x of SRC) {
  if (x.reExportOnly && /\.index\.|\/index\./.test('/' + x.rel)) continue
  for (const d of x.decls) if (d.impl && (d.exported || d.kind === 'function')) impls.push({ name: d.name, kind: d.kind, pkg: x.pkg, k: x.rel, line: d.line })
}
const byName = group(impls, (i) => i.name)

/* D2 的口径修正（2026-10-19 · ISS-620 收口 · 老板批甲+丙）
 *
 * 甲（豁免）：K6a 的判据是「同名实现必须证明语义不同，否则并一份」。
 *   但以下几类是**规范要求同名**，同名是正确形态不是债：
 *   · apply  —— cordis 插件入口，框架按名字调用，不可能改名（实测 35 处 / 22 包）
 *   · selftest —— 各门禁脚本的自检入口约定（实测 20 处）
 *   · check  —— 门禁脚本的检查入口约定（实测 7 处）
 *   · main   —— CLI 入口约定（实测 6 处）
 *   豁免只减 4 个名字、68 处，不动剩余 274 个 —— 那才是真债（小工具函数各写一遍）。
 *
 * 丙（分层）：json / readBody / parseQuery 三个名字已被 **K6f/D7** 单独度量
 *   （内核件就地重抄）。同一笔债不许被两个判据各记一次 —— 从 D2 里剔除，
 *   让 K6a 只管「非内核件的同名实现」，K6f 只管那三个 kernel helper。
 */
const D2_EXEMPT = new Set(['apply', 'selftest', 'check', 'main'])
const D2_KERNEL_OWNED = new Set(['json', 'readBody', 'parseQuery'])
const multi = [...byName.entries()]
  .filter(([name]) => !D2_EXEMPT.has(name) && !D2_KERNEL_OWNED.has(name))
  .filter(([, v]) => new Set(v.map((y) => y.k)).size > 1)
const multiCross = multi.filter(([, v]) => new Set(v.map((y) => y.pkg)).size > 1)
M('D', 'D1', '函数/类实现声明总数（barrel 已排除）', impls.length)
M('D', 'D2', '同名多份实现（不同文件里同名且有函数/类体）/ 其中跨包', `${multi.length} / ${multiCross.length}`, { offenders: topOf(multi.sort((a, b) => b[1].length - a[1].length).map(([n, v]) => ({ k: n, n: v.length, d: v.map((y) => `${y.k}:${y.line}`).slice(0, 4).join(' ') }))), sites: multi.flatMap(([n, v]) => v.map((y) => ({ k: `${n} @ ${y.k}`, file: y.k, line: y.line, name: n }))), gate: 'K6a' })
const kernelCopies = SRC.filter((x) => x.pkg !== 'forge-service-kit' && /(^|\/)lib\//.test(x.rel)).flatMap((x) => (fs.readFileSync(path.join(ROOT, x.rel), 'utf8').match(/^[ \t]*(export[ \t]+)?(async[ \t]+)?function[ \t]+(json|readBody|parseQuery)\b/gm) || []).map((m) => ({ k: x.rel, pkg: x.pkg, name: (m.match(/function[ \t]+(\w+)/) || [])[1] || m })))
M('D', 'D7', '内核件就地重抄处数：包内自己定义 json / readBody / parseQuery 共几处（HTTP 三件套 = 响应形状，两份必然漂移）', kernelCopies.length, { offenders: topOfAll(cnt(kernelCopies, (x) => x.pkg + ' · ' + x.name)).map(([k, v]) => ({ k, n: v, d: '本包定义了 kernel 已有的 HTTP helper' })), note: 'K6c「通用能力只许一份」的点名面。按处计才量得出还账 —— 按文件计的话「一个包抄两件」与「抄五件」同分。forge-monitor 早就写着「抄了会被契约闸拦住」，而那道闸此前并不存在（09-23 实测：只有那一句注释）⇒ 这条就是补上的那颗牙。逐包与 kernel 同体才许机械迁移；不同体（少 gzip、少 origin 校验、换 for await）是语义差异：要么把差异并回内核并补测试，要么在本包注释写清为什么不并，不许靠「看起来一样」顺手统一。', gate: 'K6f' })
/* ── D3：跨文件复制粘贴函数簇 ────────────────────────────────────────────────
 * 判据两条**同时**成立才算一条边（ISS-654 补第二颗牙，实现见 clusterDupFuncs）：
 *   ① 归一 token 12-gram Jaccard ≥ JAC —— 形状相近；
 *   ② 共享至少一条**归一语句逐字相同** —— 真抄了同一句。
 * 只有 ① 时 `isoAt` 会和一个语义无关的 `withIndex(res, (index) => …)` 聚成一簇（ISS-654 实测的假账）。
 * 变异验证：`node scripts/code-inventory.mjs --selftest-dup`（真复制必聚 / 相似非复制必不聚）。 */
const allFuncs = SRC.flatMap((x) => x.funcs.map((fn) => ({ pkg: x.pkg, k: x.rel, name: fn.name, line: fn.line, toks: fn.toks, stmts: fn.stmts })))
const clusters = clusterDupFuncs(allFuncs, JAC, SHINGLE)
const dupPairs = clusters.length
if (A.includes('--debug-dup')) {
  const shinglesOf = (f) => { const s = new Set(); for (let i = 0; i + SHINGLE <= f.toks.length; i++) s.add(f.toks.slice(i, i + SHINGLE).join('.')); return s }
  let maxJac = 0, maxPair = ''
  const sample = allFuncs.slice(0, 1200).map((f) => ({ ...f, set: shinglesOf(f) }))
  const hotPairs = []
  for (let i = 0; i < sample.length; i++) for (let j = i + 1; j < sample.length; j++) {
    if (sample[i].k === sample[j].k) continue
    let inter = 0
    for (const s of sample[i].set) if (sample[j].set.has(s)) inter++
    const jc = inter / Math.max(1, Math.min(sample[i].set.size, sample[j].set.size))
    if (jc >= JAC && !dupEdgeHolds(sample[i], sample[j], JAC, SHINGLE)) hotPairs.push(`${sample[i].k}:${sample[i].line} ↔ ${sample[j].k}:${sample[j].line}`)
    if (jc > maxJac) { maxJac = jc; maxPair = `${sample[i].k}:${sample[i].line} ↔ ${sample[j].k}:${sample[j].line}` }
  }
  console.error(`[debug-dup] funcs(≥40 token)=${allFuncs.length} 簇=${clusters.length} 前 1200 函数里的最大 Jaccard=${maxJac.toFixed(3)} @ ${maxPair} · 只过①不过②（相似非复制，已被第二颗牙挡掉）的成对样本 ${hotPairs.length} 对${hotPairs.length ? '：' + hotPairs.slice(0, 8).join(' | ') : ''}`)
}
const dupLines = clusters.reduce((s, c) => s + (c.length - 1) * Math.min(...c.map((x) => x.toks.length)), 0)
M('D', 'D3', '跨文件复制粘贴函数簇（≥2 文件；①归一 12-gram Jaccard≥0.6 **且** ②共享一条归一语句逐字相同）/ 涉及函数数', `${clusters.length} / ${clusters.reduce((s, c) => s + c.length, 0)}`, { offenders: topOf(clusters).map((c) => ({ k: `${c[0].name} 等 ${c.length} 份`, n: Math.min(...c.map((x) => x.toks.length)), d: c.slice(0, 4).map((x) => `${x.k}:${x.line}`).join(' ') })), note: `粗估重复体量 ${dupLines} tokens · ${dupPairs} 簇`, gate: 'K6b' })
// 通用能力自实现清单
const CAPS = [
  ['原子写 / 临时文件 rename', /atomicWrite|writeAtomic|safeWrite|\.tmp['"]\s*\)|renameSync|fs\.rename/],
  ['JSON 读写封装', /readJson|writeJson|loadJson|saveJson|readJSON|writeJSON/],
  ['frontmatter 解析', /frontmatter|matter\(|parseFm|splitFm|---\\n.*title/],
  ['YAML 读写', /js-yaml|yaml\.load|yaml\.stringify|loadSync/],
  ['HTTP 客户端封装', /function\s+\w*(fetch|request|httpGet|apiFetch|callApi)\w*|async\s+\w*fetch\w*\s*\(/],
  ['SSE / 事件流', /text\/event-stream|EventSource|\\n\\ndata:/],
  ['重试 / 退避', /\bretry|backoff|maxAttempts|attempt\s*<|sleep\(\s*\*\*/],
  ['加锁 / 互斥', /acquireLock|\.lock\b|withLock|writerLock|Mutex/],
  ['防抖 / 节流', /debounce|throttle|requestAnimationFrame\(/],
  ['日期时间格式化', /function\s+(fmt|format)[A-Za-z]*Date|formatDate|toISOString\(\)\.slice|date-fns/],
  ['HTML / 转义', /escapeHtml|escapeReg|encodeURIComponent|sanitizeHtml/],
  ['子进程 spawn', /spawn\(|execFile|child_process/],
  ['端口占用探测', /lsof|EADDRINUSE|getPort|findPort/],
  ['token / cookie 解析', /cookie|token=|authorization/i],
  ['日志封装', /makeLogger|createLogger|logInfo|function\s+log\w*\(/],
  ['错误类型 / kind 定义', /class\s+\w*Error|errorKind|kind:\s*['"]quota|AppError/],
]
const capRows = []
for (const [name, re] of CAPS) {
  const hits = SRC.filter((x) => re.test(fs.readFileSync(path.join(ROOT, x.rel), 'utf8')))
  const pkgs = new Set(hits.map((h) => h.pkg))
  if (hits.length) capRows.push({ name, files: hits.length, pkgs: pkgs.size, sample: hits.slice(0, 3).map((h) => h.rel) })
}
M('D', 'D4', '通用能力被多包各自实现的项（能力 : 文件数 : 包数）', capRows.filter((r) => r.pkgs >= 2).length, { offenders: capRows.filter((r) => r.pkgs >= 2).sort((a, b) => b.pkgs - a.pkgs).map((r) => ({ k: r.name, n: r.files, d: `${r.pkgs} 个包各写一份：${r.sample.join(', ')}` })), note: '判据出处：AGENTS 决策 18「重复的构建逻辑算长期成本」', gate: 'K6c' })
// 共享层是否被绕过
/* ISS-624｜**已退役包**识别 —— 同样一句：这是改口径，不是放水，边界写在下面。
   原口径的问题：D5 的共享层名单里 `forge-shell` 早已整包淘汰（ISS-607 · 2026-10-09，目录都删了），
   于是 D5 恒报 `shell:0`，读起来像「共享层消费者归零 = 共享层失效」，实则是「包已退役、名单没跟着清」。
   同型第二种形态：`electron-shell/` 目录还在、没有任何源文件 import 它、也不在根 workspaces 里。
   ⚠️ 但它**不是**"零锁零 typecheck"（2026-10-19 审查实测纠正）：它有 `electron-shell/tsconfig.lib.json`、
      在 `scripts/baseline/shell-tsc.json` 的类型族里、且被 `scripts/ci-local.mjs` 的 EXTRA_TARGETS 纳入 CI 射程
      —— 它是**本仓开发面**的一部分（有 package.json、有 4 个测试文件）。原注释写"零 typecheck"是错的，
      正是这个错误印象让退役判据只看了 ①②。
   ⇒ 所以退役判据必须加第 ④ 条（不在开发面名单），见 classifyShared 的块注释。
   是「包已退役、目录未删」—— 它压根不是共享层，不该出现在 D5 的分母里。
   新口径（**三条全中**才判退役，缺一条照旧计入 ⇒ 该报的真信号一个都不许丢）：
     ① 不在根 package.json 的 workspaces 里（不参与构建/锁/typecheck）
     ② 零消费者（没有任何源文件 import 它 —— 用 import 说明符判，不用 depEdges：后者只记 `forge-*`，
        对 electron-shell 这种名字结构性看不见，拿它判会把"看不见"当成"没有"）
     ③ 目录还在（⇒ 待清理的遗留）或目录已删（⇒ 名单残留，同一件事的两种形态，分开点名）
   ⚠️ **反例（必须仍被计入）**：在 workspaces 里但零消费者的共享包 —— 那才是「要么该下沉的没沉，要么包多余」，
      真正的信号。它不满足 ①，D5 照旧报 0 并让人去看。
   ⚠️ 退役判定**每次运行重算**，不写死跳过名单：包一旦被 import 回来（②失效）或重新进 workspaces（①失效），
      它自动回到 D5 统计里 —— 豁免不会变成永久后门。 */
const shared = ['forge-design', 'forge-service-kit', 'forge-shell', 'forge-agent-protocol']
const consumerPkgs = (p) => new Set(SRC.concat(TST).filter((x) => x.imports.some((im) => { const s = im.spec || ''; return s === p || s.startsWith(p + '/') })).map((x) => x.pkg))
const dirExists = (p) => fs.existsSync(path.join(ROOT, p))

/* F1（ISS-624 独立审查 critical）：**退出双写** —— 判据本体只在 caliber-lib.mjs 一份。
 * 原实现：库里写了 classifyShared（带 13 个自测用例），生产这边内联重写了另一份，
 * 于是「改库里的逻辑，生产行为不变」⇒ 用例全绿但生产没接上（比没写测试更隐蔽）。
 * 现在生产**直接调库**：判据改哪里，生产就跟着变（这正是 F1 的验收判据）。
 *
 * F2（major）：退役判据补第三条 —— **开发面名单里的包不算退役**。
 * `electron-shell` 不在 workspaces、也零 import，但它在 scripts/ci-local.mjs 的 EXTRA_TARGETS 里
 * （ci-local.mjs:59 原话：「非 workspace、但属于本仓开发面的目录（ISS-764）：目前只有 electron-shell」），
 * 且 lsof 实测 7 个 Electron 监听、在 CI 射程与 shell-tsc 类型族里 ⇒ 判它退役是错的。
 * 名单**从脚本现读**（不写死），脚本读不到就按空处理 —— 只会多报，不会误判退役。 */
/** devSurfaceDirs 的失败原因（''=正常）。由 D5 的 note 与 stderr 消费 —— 不进度量值。
 *  ⚠️ 声明必须在 devSurfaceDirs 之前：放后面靠"赋值时声明已执行"侥幸不报 TDZ，顺序一改就炸。 */
let DEV_SURFACE_ERR = ''
function devSurfaceDirs() {
  /* K9 家族（ISS-624 审查观察项 2）：**读不到 ≠ 名单为空**。
   * 原实现 `catch { return [] }` 把两种状态混成一种 —— 文件读不出（换分支/改名/权限）与
   * 「名单本来就是空的」在调用方看着一模一样，于是 D5 会在无提示的情况下把
   * electron-shell 重新判成"已退役待清理"，而没人知道豁免为什么失效了。
   * 现在把失败显式记下来，由 D5 的 note 与 stderr 各说一句（不影响度量值：失效方向仍是多报）。 */
  try {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'ci-local.mjs'), 'utf8')
    /* F2②（ISS-624 独立审查）：原正则 `\[([^\]]*)\]` **换行即失配** ——
     * 审查员实测：把 `:61` 改成多行数组，D5 行为就悄悄变了（退回多报待清理）。
     * 改用 `[\s\S]*?` 容忍换行 + 非贪婪；并且**从 `const EXTRA_TARGETS` 起找到配对的 `]`**，
     * 不靠"单行"这个假设。
     *
     * 为什么不按审查员建议改成 `import { EXTRA_TARGETS }`：`ci-local.mjs` 是**带顶层副作用的脚本**
     * （`:79 for (const pkg of targets)` 就是跑 CI），import 它等于顺手跑一遍全量 CI。
     * 那比"正则脆弱"的代价大得多。⇒ 保持读文件，但把正则做宽容、把失败做可见。
     *
     * ⚠️ 失效方向不变：解析失败 ⇒ extraTargets 为空 ⇒ electron-shell 回到"待清理"（多报，不漏报），
     *    且 `DEV_SURFACE_ERR` 会在 stderr 与 D5 的 note 各说一句。 */
    const anchor = src.search(/EXTRA_TARGETS\s*=/)
    if (anchor < 0) {
      DEV_SURFACE_ERR = 'ci-local.mjs 里找不到 EXTRA_TARGETS 赋值（写法变了？）'
      return []
    }
    const arrStart = src.indexOf('[', anchor)
    const arrEnd = arrStart < 0 ? -1 : src.indexOf(']', arrStart)
    if (arrStart < 0 || arrEnd < 0) {
      DEV_SURFACE_ERR = 'EXTRA_TARGETS 后面找不到数组字面量'
      return []
    }
    return [...src.slice(arrStart, arrEnd + 1).matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
  } catch (e) {
    DEV_SURFACE_ERR = `ci-local.mjs 读不出：${String(e.message).slice(0, 80)}`
    return []
  }
}

const _sharedClass = classifyShared({
  shared,
  isDeclared: (k) => declared.has(k),
  importsOf: (k) => consumerPkgs(k),
  extraTargets: devSurfaceDirs,
})
const consumers = _sharedClass.rows
const retired = _sharedClass.retired
const live = _sharedClass.live

/** 连线自检失败标志。true ⇒ 走「判据失效」档让门禁红，而不是当成正常读数。
 *  ⚠️ 声明必须在下面的校验块之前（同 devSurfaceDirs 的 TDZ 教训）。 */
let WIRING_FAIL = false

/* F1 守卫（ISS-624 独立审查 critical）：**生产消费端断掉时必须红**。
 *
 * 审查员抓到的问题：我验过「改库 ⇒ 生产跟着变」，但没验「生产那头断掉 ⇒ 能不能发现」。
 * 实测复现：把 `const retired = _sharedClass.retired` 改成 `const retired = []`，
 * `--selftest-caliber` 仍 exit 0、`lint-code --check` 也 exit 0 —— **断线完全无声**。
 * 根因：`--selftest-caliber` 在扫描之前早退，它只喂假事实给库里的纯函数，
 * **根本不碰生产这条连线** ⇒ 那条自测对"连线"结构性失明。
 *
 * 这条守卫不测库（库有自己的用例），只测**连线本身**：
 *   ① retired/live/rows 三个变量必须真的是 classifyShared 的产物（同一次调用、可相互推导）
 *   ② retired 与 rows 的划分必须自洽（每个 row 要么在 retired 要么在 live，且不重叠、不丢失）
 * 任一条不成立 ⇒ 判据失效（与「判据失效」同档，门禁红），不是"警告"。
 * ⚠️ 变异验证：把 retired 改成常量 [] ⇒ ② 立刻不成立 ⇒ 红；还原 ⇒ 绿。 */
{
  const _rowsN = consumers.length
  const _splitOk = _rowsN === retired.length + live.length
    && retired.every((r) => !live.some((l) => l.k === r.k))
    && consumers.every((c) => retired.some((r) => r.k === c.k) || live.some((l) => l.k === c.k))
  const _retiredShaped = retired.every((r) => typeof r.k === 'string' && typeof r.n === 'number')
  if (!_splitOk || !_retiredShaped) {
    console.error(`✗ D5 连线自检失败：retired/live 与 rows 不自洽（rows=${_rowsN} · retired=${retired.length} · live=${live.length}）`
      + ' ⇒ 生产消费端可能断了（classifyShared 的返回值没被这里接住），判据失效')
    WIRING_FAIL = true
  }
}

/* 目录还在、不在 workspaces 的包（本项：electron-shell）。分两档 —— 两档都必须**看得见**：
   · 零消费者 ⇒ 退役后的遗留目录，待清理（不动它，删目录是另一单）
   · **有消费者** ⇒ 这一档最危险：不在 workspaces 就意味着不参与锁/typecheck/构建，
     它靠手工 symlink 或 root hoisting 才能解析 ⇒ 换台机器即断。旧口径下它**在 D5 里彻底消失**
     （既不在 shared 名单、又被 staleDirs 的零消费者条件排掉），比归错类更坏 —— 变异验证实测踩到。
     ⇒ 单独点名，不计入 shared 的消费者数，但绝不允许静默。 */
/* F2：**开发面目录不进 staleDirs** —— 它属于本仓开发面（ci-local.mjs 的 EXTRA_TARGETS），
 * 不是「已退役待清理的遗留」。原实现把它列成「零消费者 ⇒ 待清理」，等于让一个在用的目录
 * 长期挂着一个"该删"的标签；人看多了就不再看这一栏。 */
const _devSet = new Set(devSurfaceDirs())

/* 观察项 2 的消费端：读失败要**出声**。不带它的话，D5 只在数值上"多报一个待清理"，
 * 而人看到的是一句「electron-shell 待清理」，完全不知道是豁免名单读炸了。 */
if (DEV_SURFACE_ERR) console.error(`⚠️ D5 开发面名单读取失败：${DEV_SURFACE_ERR} ⇒ electron-shell 会退回「待清理」分类（多报，不漏报）`)
const staleDirs = PKG_DIRS.filter((p) => !declared.has(p) && !shared.includes(p) && !_devSet.has(p))
M('D', 'D5', '共享层消费者数（消费者少 = 要么该下沉的没沉，要么包多余）',
  `${live.map((c) => `${c.k.replace('forge-', '')}:${c.n}`).join(' ')}${retired.length ? ` · 已退役不计:${retired.map((c) => `${c.k.replace('forge-', '')}${dirExists(c.k) ? '(目录遗留)' : '(目录已删/名单残留)'}`).join(' ')}` : ''}`,
  { offenders: consumers.map((c) => ({
      k: c.k, n: c.n,
      ...(retired.includes(c) ? { d: `已退役：不在 workspaces + 零消费者 + ${dirExists(c.k) ? '目录还在（待清理，另单）' : '目录已删（名单残留，应从 shared 名单删掉这一格）'}` } : {}),
    })).concat(staleDirs.map((p) => {
      const n = consumerPkgs(p).size
      return { k: p, n, d: n === 0
        ? '已退役：不在 workspaces + 零消费者，目录还在 ⇒ 待清理（删目录是另一单，本项只点名不计入 D5）'
        : `**不在 workspaces 但有 ${n} 个消费者**（${[...consumerPkgs(p)].join('、')}）⇒ 靠手工软链/root 提升才解析得到，换台机器即断；这不是"退役包"，要么补登记进 workspaces、要么让消费者改掉` }
    })),
    note: `ISS-624 口径：**已退役包不参与 D5 统计**，单列为「待清理 / 名单残留」，判据三条全中（不在 workspaces + 零消费者 + 目录在/不在两种形态分开点名），每次运行重算、不写死跳过名单。在 workspaces 里却零消费者的共享包照旧计入 0 —— 那才是"要么该沉的没沉，要么包多余"的真信号。当前退役：${retired.length ? retired.map((c) => c.k).join('、') : '无'}；待清理目录：${staleDirs.length ? staleDirs.join('、') : '无'}${DEV_SURFACE_ERR ? `。⚠️ **开发面名单读取失败**（${DEV_SURFACE_ERR}）⇒ 开发面豁免未生效，electron-shell 会出现在"待清理"里（多报，不漏报）` : ''}`,
    gate: 'K6d' })
const uiCopies = SRC.filter((x) => /(^|\/)src\/(components\/)?ui\//.test(x.rel) && x.pkg !== 'forge-design')
M('D', 'D6', 'forge-design 之外另起 ui/ 目录的包（家族 C 基元必须全项目一份）', new Set(uiCopies.map((x) => x.pkg)).size, { offenders: topOf(cnt(uiCopies, (x) => x.pkg)).map(([k, v]) => ({ k, n: v, d: '副本文件数' })), gate: 'K6e' })

/* ═════ T 测试与门禁 ═════ */
const perPkg = PKG_OF_SRC.map((p) => {
  const s = SRC.filter((x) => x.pkg === p)
  const t = TST.filter((x) => x.pkg === p)
  const lines = s.reduce((a, b) => a + b.lines, 0)
  const expects = t.reduce((a, b) => a + (b.calls['expect'] || 0), 0)
  return { p, src: s.length, sloc: lines, tests: t.length, expects }
})
const noTest = perPkg.filter((x) => x.tests === 0)
M('T', 'T1', '包数 / 源文件数 / 源码行数（已排 vendor 与产物）', `${perPkg.length} / ${SRC.length} / ${SRC.reduce((a, b) => a + b.lines, 0)}`, { note: `本行只数**非测试的模块文件**；表头「真解析 N 个源文件」与 N1 的扩展名分布含测试与 scripts ⇒ 两个数天然不等（651 与 864 不是矛盾）。` + (vendor.length ? `另有 ${vendor.length} 个 vendor/巨型文件未计入` : '') })
M('T', 'T2', '零测试文件的包', noTest.length, { offenders: noTest.map((x) => ({ k: x.p, n: x.src, d: `${x.sloc} 行无任何测试` })), gate: 'K7a' })
const weak = perPkg.filter((x) => x.tests > 0 && x.src / x.tests > 20)
M('T', 'T3', '源文件/测试比 >20 的包（"有测试"但覆盖不到）', weak.length, { offenders: weak.sort((a, b) => b.src / b.tests - a.src / a.tests).map((x) => ({ k: x.p, n: Math.round(x.src / x.tests), d: `${x.src} 源文件 / ${x.tests} 测试 / ${x.expects} 断言` })) })
const scriptMatrix = PKG_DIRS.map((p) => { const s = (pkgPkgJson(p).scripts || {}); return { p, typecheck: !!s.typecheck, test: !!s.test, build: !!(s['build:client'] || s.build) } })
const missingScripts = scriptMatrix.filter((x) => !x.typecheck || !x.test)
M('T', 'T4', '缺 typecheck 或 test script 的包（门禁连入口都没有）', missingScripts.length, { offenders: missingScripts.map((x) => ({ k: x.p, d: [!x.typecheck && 'typecheck', !x.test && 'test'].filter(Boolean).join('+') + ' 缺' })), gate: 'K7b' })
const tcScripts = scriptMatrix.filter((x) => x.typecheck && !/tsc/.test((pkgPkgJson(x.p).scripts || {}).typecheck))
M('T', 'T5', 'typecheck 脚本里不含 tsc（名字对、事没做）', tcScripts.length, { offenders: tcScripts.map((x) => ({ k: x.p, d: (pkgPkgJson(x.p).scripts || {}).typecheck })), gate: 'K7i', scanN: scriptMatrix.length })
// 门禁脚本与"有牙率"
const lintScripts = fs.readdirSync(SCRIPTS_DIR).filter((f) => /^lint-.*\.mjs$/.test(f))
const GUARD_EVIDENCE = [
  ['§1.1 output.render 必填', /render/],
  ['§1.2 工具名正则', /K5b·n/],
  ['§1.3 Tailwind 交叉覆盖', /tailwind/i],
  ['§1.4 systemPrompt.section 字段', /systemPrompt/],
  ['§1.5 additionalProperties', /additionalProperties/],
  ['§1.6 React hooks 数量恒定', /TC1/],
  ['§6 .js 禁 TS 注解', /allowJs|checkJs|\bfake\b/],
  ['§6 host 半依赖声明自检', /Cannot find package|undeclared|K3c/], // 牙长在 lint-code 的规则号上（K3c 白名单 + K3c·b 棘轮），不在英文关键词上
  ['设计门禁 R1~R8', /R[1-8][a-g]/],
  ['脚本红线 R1~R5', /set -u|nohup/],
  // 只认精确规则号：`CC1/CC2` 的唯一出处是 scripts/lint-channel-contract.mjs（改名即掉格，反向验证做过）
  ['§10 活推送必须有游标与非推送重拉', /CC1|CC2/],
]
const guardEvidenceText = lintScripts.map((f) => fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8')).join('\n')
  + testSh.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  + fs.readdirSync(path.join(SCRIPTS_DIR)).filter((f) => /\.mjs$/.test(f) && !/^code-inventory/.test(f)).map((f) => fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8')).join('\n')
const gated = GUARD_EVIDENCE.filter(([, re]) => re.test(guardEvidenceText))
M('T', 'T6', '门禁脚本数（scripts/lint-*.mjs）', `${lintScripts.length}`, { offenders: lintScripts.map((f) => ({ k: f })), note: '设计侧规范要求的 lint-design.mjs 不在其中 ⇒ 设计门禁至今无牙' })
M('T', 'T7', 'code-rules / design-rules 里的铁律有多少"有牙"（脚本里能找到判据）', `${gated.length} / ${GUARD_EVIDENCE.length}`, { offenders: GUARD_EVIDENCE.filter(([, re]) => !re.test(guardEvidenceText)).map(([t]) => ({ k: t, d: '只有文档，没有机器判据' })), note: '判据来源 = scripts/*.mjs + scripts/tests/*.sh 全文正则；命中只证明"提到过"，不证明"能拦住"', gate: 'K8a' })
const guardCall = shellFiles.some((f) => /guard/.test(fs.readFileSync(f, 'utf8')))
M('T', 'T8', 'ws.sh 是否把体检串成一条命令（守卫无人调用 = 等于没有）', guardCall ? 'ws.sh 含 guard' : '未接', { note: '对照：ISS-689 的教训——守卫要接进入口命令' })

/* ═════ E 错误处理与可观测 ═════ */
const hostConsole = SRC.filter((x) => x.half === 'host' && x.consoles > 0)
M('E', 'E1', 'host 半用 console.* 的文件数（DSH 无 console exporter ⇒ 写了等于没写，ISS-620）', hostConsole.length, { offenders: topOf(hostConsole.sort((a, b) => b.consoles - a.consoles)).map((x) => ({ k: x.rel, n: x.consoles })), gate: 'K9e' })
const loggerFiles = SRC.filter((x) => x.logger > 0)
M('E', 'E2', '用 ctx.logger.* 的文件数（正解路径）', loggerFiles.length, { offenders: topOf(cnt(loggerFiles, (x) => x.pkg)).map(([k, v]) => ({ k, n: v })) })
const ec = SRC.filter((x) => x.emptyCatch > 0)
M('E', 'E3', '空 catch 块（吞异常 ⇒ 事故无痕迹）', ec.reduce((s, x) => s + x.emptyCatch, 0), { offenders: topOf(ec.sort((a, b) => b.emptyCatch - a.emptyCatch)).map((x) => ({ k: x.rel, n: x.emptyCatch })), sites: ec.flatMap((x) => x.emptyCatchSites.map((line) => ({ k: x.rel, line }))), note: 'ISS-771：补 sites（file:line）—— 棘轮只比「多出来的那几处」，没有行号就没法 blame、没法追责（此前只有 per-file 计数）', gate: 'K9b' })
const sc = SRC.filter((x) => x.silentCatch > 0)
M('E', 'E4', '注释式吞异常（catch 里只有注释/noop）', sc.reduce((s, x) => s + x.silentCatch, 0), { offenders: topOf(sc).map((x) => ({ k: x.rel, n: x.silentCatch })) })

/* ISS-622：E5/K9c 也要"债在哪一行"。判据口径与改前**逐字等价**：仍是 stripShellComments 之后
   数 `|| true` / `2>/dev/null` 的**出现次数**，只是从"整份文件一次 match"换成"逐行 match 再累加"
   —— 同一文本、同一正则、无跨行匹配 ⇒ 两者恒等（实测 407 = 407，逐文件也一一对上）。
   ⚠️ 必须用 `l.match(...g).length` 而不是 `regex.test(l)`：test 每行至多记 1，而**同一行可以命中 2 次**
   （`cmd 2>/dev/null || true` 这种），全仓有 116 行是这种 —— 用 test 会把 407 悄悄变成 283。 */
const silentShell = shellFacts.map((s) => {
  const sites = []
  stripShellComments(s.text).split('\n').forEach((l, i) => {
    for (const line of silentShellHitLines(l, i + 1)) sites.push({ line })
  })
  return { k: s.rel, n: sites.length, sites }
}).filter((x) => x.n > 0)
M('E', 'E5', 'shell 里的静默失败（**吞失败的** `2>/dev/null` / `|| true` · ISS-416 的机制根因）', silentShell.reduce((s, x) => s + x.n, 0), { offenders: topOf(silentShell.sort((a, b) => b.n - a.n)).map((x) => ({ k: x.k, n: x.n })), sites: silentShell.flatMap((x) => x.sites.map((t) => ({ k: x.k, line: t.line }))), note: 'ISS-771 口径：只把**吞失败**算欠账，**探测**不算 —— 命令的退出码有消费者时（行首 if/elif/while/until · 重定向后紧跟 `||`/`&&` · 或本身就是 `|| true`）判为探测。实测 461→87：被去掉的 374 处是 `readlink`/`lsof`/`kill -0`/`git …` 这类**正常路径上就会返回非零**的探测，删它们的 `2>/dev/null` 只会污染运维日志。残留（已知边界，别当 bug）：`git push || true` 这种真吞失败在语法上与探测无法区分，仍会漏；条件位是整行判的，`if a; then cmd 2>/dev/null; fi` 一行写完会把后者也免掉（全仓无此写法）。变异验证见 `--selftest-k9c`（11 条，5 正控 4 反控 2 边界）。', gate: 'K9c' })
const pexit = SRC.filter((x) => x.processExit > 0 && x.half !== 'other' && !isExecutableEntry(x))
/* 被射程排除的那些 —— **不静默**：条数与文件名进 note，随每次出数打印（静默豁免 = 看不见）。 */
const pexitWaived = SRC.filter((x) => x.processExit > 0 && x.half !== 'other' && isExecutableEntry(x))
M('E', 'E6', '库代码里 process.exit（会带走宿主进程）', pexit.reduce((s, x) => s + x.processExit, 0), {
  offenders: pexit.map((x) => ({ k: x.rel, n: x.processExit })),
  note: `ISS-769 射程：**可执行入口不算库代码**（首行 shebang / 包内 scripts/ / *-cli.* / *-probe.*）；`
    + `本次豁免 ${pexitWaived.length} 个文件 / ${pexitWaived.reduce((s, x) => s + x.processExit, 0)} 处`
    + `${pexitWaived.length ? `：${pexitWaived.map((x) => `${x.rel}(${x.processExit})`).join(' · ')}` : ''}。`
    + '反向控制：普通 lib/*.js 里的 process.exit 仍计数（`--selftest-k9a` 的「射程」段）。',
  gate: 'K9a',
})
const errSub = SRC.filter((x) => x.errSubclass > 0)
M('E', 'E7', '自定义 Error 子类定义数（有类型 ⇒ 上层可按 instanceof 分流）', SRC.reduce((s, x) => s + x.errSubclass, 0), { offenders: errSub.map((x) => ({ k: x.rel, n: x.errSubclass })), note: '对照物是 E8：throw new Error 的调用点数' })
const throwCount = SRC.reduce((s, x) => s + x.throwNewError, 0)
M('E', 'E8', 'throw new Error(...) 调用点（无 kind/code ⇒ 上层只能按 message 字符串猜）', throwCount, { offenders: topOf(cnt(SRC.filter((x) => x.throwNewError > 3), (x) => x.pkg)).map(([k, v]) => ({ k, n: v, d: '该包 >3 处的文件数' })), sites: SRC.flatMap((x) => x.throwNewErrorSites.map((t) => ({ k: x.rel, line: t.line }))), gate: 'K9f' })

/* ═════ Z 死码与引用 ═════ */
const SHELL_ALL = shellFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  + fs.readdirSync(SCRIPTS_DIR).filter((f) => /\.mjs$/.test(f) && !/^code-inventory/.test(f)).map((f) => fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8')).join('\n')
  + JSON.stringify(rootPkg)
  + PKG_DIRS.map((p) => { try { return fs.readFileSync(path.join(ROOT, p, 'README.md'), 'utf8') } catch { return '' } }).join('\n')
const fileSet = new Set(kept.map(rel))
const pkgEntry = new Map(PKG_DIRS.map((p) => [p, `${p}/src/index.ts`]))
function resolveSpec(fromRel, spec) {
  if (!spec) return null
  if (/^\.{1,2}\//.test(spec)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
    for (const c of [base, base + '.ts', base + '.tsx', base + '.js', base + '.jsx', base + '.mjs', base + '/index.ts', base + '/index.tsx', base + '/index.js']) if (fileSet.has(c)) return c
    return null
  }
  if (/^node:/.test(spec)) return null
  const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  if (!/^forge-/.test(bare)) return null
  const sub = spec.slice(bare.length + 1)
  const pj = pkgPkgJson(bare)
  if (sub && pj.exports) {
    const key = './' + sub
    const mapped = pj.exports[key] || pj.exports['./*']
    const def = typeof mapped === 'string' ? mapped : mapped && (mapped.types || mapped.default || mapped.import)
    if (def) { const cand = path.posix.normalize(bare + '/' + String(def).replace(/^\.\//, '').replace(/\*$/, sub)); for (const c of [cand, cand + '.ts', cand + '.tsx', cand + '/index.ts']) if (fileSet.has(c)) return c }
  }
  if (!sub) {
    for (const c of [`${bare}/src/index.ts`, `${bare}/src/index.tsx`, `${bare}/lib/index.js`, `${bare}/index.js`]) if (fileSet.has(c)) return c
    return null
  }
  for (const c of [`${bare}/${sub}`, `${bare}/src/${sub}`, `${bare}/${sub}.ts`, `${bare}/${sub}.tsx`, `${bare}/${sub}.js`, `${bare}/src/${sub}.ts`, `${bare}/src/${sub}.tsx`]) if (fileSet.has(c)) return c
  return `${bare}/UNRESOLVED/${sub}`
}
const used = new Set()          // "file::name"
const usedFile = new Set()      // 被任意方式引用的文件
const usedWildcard = new Set()  // 被 namespace / 副作用 / 动态 import 整体吃进 ⇒ 该文件所有导出都算被用
for (const x of SRC.concat(TST)) {
  for (const im of x.imports) {
    // ⚠️ `import type` 也算消费者：类型导出被引用 = 有人在依赖它。第一版跳过 typeOnly，
    //    把 forge-agent-protocol / forge-design 的类型全部误判成死码（契约包首当其冲）。
    const t = resolveSpec(x.rel, im.spec)
    if (!t) continue
    if (!t.includes('/UNRESOLVED/')) usedFile.add(t)
    for (const n of im.names) used.add(`${t}::${n}`)
    if (im.ns || im.dynamic) usedWildcard.add(t)
    if (im.def) used.add(`${t}::default`)
    if (!im.names.length && !im.ns && !im.def && !im.fromReexport) usedWildcard.add(t) // ⚠️ 空子句=副作用 import ⇒ 整份文件洗白；搬家时别把 import 掏空（09-23 实测会假降 K10b）
  }
  // ISS-733：`export * from './a'` 吃进 a 的整个导出面（逐名要真求模块图，全仓只 3 处）⇒ 与 namespace/副作用 import 同纪律；usedFile 已记过所以 Z1 不变，只有 Z2 降（实测 -21）
  for (const spec of x.exportStar) { const t = resolveSpec(x.rel, spec); if (t) usedWildcard.add(t) }
}
/* ISS-770 ②：scripts/ 的子目录（scripts/gates/ 等）是**消费者**，但不在被测面里 ——
 * 不补这一段，它们 import 的符号会被判成零引用（实测 `WORKTREE_IGNORE_GLOBS`）。 */
feedConsumers(collectConsumerImports(ROOT, (r) => fileSet.has(r)), {
  resolve: resolveSpec,
  used: (k) => used.add(k),
  usedFile: (k) => usedFile.add(k),
  wildcard: (k) => usedWildcard.add(k),
})
/* ── ISS-653：Z1 的第二条边 —— **被当成程序执行的锚点相对路径** ────────────────
 * 起因：Z1 只沿 import 图走，可仓里有引用**天生不经过 import**，实测造成假阳性：
 *   ① 子进程夹具 `forge-service-kit/lib/fs-lock-probe.mjs` —— `const HERE = dirname(fileURLToPath(import.meta.url))`
 *      + `const PROBE = join(HERE, "fs-lock-probe.mjs")` + `fork(PROBE)`，被当成互斥测试的对侧进程
 *   ② 打包器 `forge-trae-direct/trae-extension/` —— 见下面的「嵌套 package 入口」豁免
 * 口径（**故意收窄**；三条实测过的放宽都会把判据变成恒不报）：
 *   · 只认 **`fork`/`spawn`/`spawnSync`/`execFile`/`execFileSync`** 的实参（"把文件当程序跑"才算引用）；
 *     ⛔ 不认 `readFileSync`/`existsSync` —— 守卫测试按名读源文件是**读文本**、不是消费模块，
 *        实测按它认会洗白 58 个文件、Z2 从 590 假降到 383；
 *   · 路径必须**从目录锚点起算**（`import.meta.dirname` / `__dirname` / `dirname(fileURLToPath(import.meta.url))`，
 *     或由它 `join(anchor,"..")` 得出的 const）；普通变量当基座的路径不认（多半落在临时目录）；
 *   · 解析结果必须是**同包内、盘上真有**的源文件；
 *   · ⛔ 不认"目录被引用 ⇒ 目录下每个文件都算被用"：`join(root,"lib")` 这类"遍历/复制目录"的写法一放进来
 *     就洗白 863 个文件（Z2 590→166）—— 目录被遍历 ≠ 里面每个文件都被用。
 *   · 命中只当"整份被用"（与 namespace / 副作用 import 同档）⇒ 只改 Z1/Z2 的输入，不动 import 图。
 */
const srcRels = new Set(SRC.concat(TST).map((x) => x.rel))
const stringRef = new Set() // 被字符串路径点到的源文件
{
  /** 把一个"锚点相对"的路径常量解析成盘上路径；base 不是锚点则返回 null */
  const resolvePathConst = (x, argText) => {
    const pc = x.pathConsts.get(argText) || (x.pathCalls || []).find((c) => c.argText === argText)
    if (!pc) return null
    const depth = DIRECT_ANCHOR_RE.test(pc.base) ? 0 : x.anchors.has(pc.base) ? x.anchors.get(pc.base) : null
    if (depth === null) return null
    let cur = path.posix.dirname(x.rel)
    for (let i = 0; i < depth; i++) cur = path.posix.dirname(cur)
    for (const lit of pc.lits) {
      if (lit === null) continue // 非字面量实参（锚点本身、变量）：不参与拼接
      if (lit === '..') cur = path.posix.dirname(cur)
      else if (lit && lit !== '.') cur = cur + '/' + lit.replace(/^\/+/, '')
    }
    return path.posix.normalize(cur)
  }
  for (const x of SRC.concat(TST)) {
    for (const argText of x.execArgs || []) {
      // 实参可能裹在数组里（`spawn(BUN, [PROBE])`）⇒ 把里面的标识符逐个试一遍
      for (const tok of [argText, ...(String(argText).match(/[A-Za-z_$][\w$]*/g) || [])]) {
        const cand = resolvePathConst(x, tok)
        // 只认同包内（跨包锚点相对的多是"跑别人的产物"，不是"这个模块被消费"）
        if (cand && srcRels.has(cand) && cand.split('/')[0] === x.rel.split('/')[0]) stringRef.add(cand)
      }
    }
  }
  for (const rel of stringRef) usedWildcard.add(rel)
}
/* ── ISS-653：Z1 的第三条豁免 —— **嵌套自包含 package 的入口** ────────────────
 * `forge-trae-direct/trae-extension/` 是一个**自带 package.json 的子工程**（TraeCode 侧扩展），
 * 由宿主按 `main` 字段加载、被打包器整个收走 —— 没有任何文件 import `extension.js`，但它就是入口。
 * 这与 Z1 既有的「`lib/index.js` 是入口」是同一条道理，只是包套在包里面 ⇒ 按 `package.json` 的
 * `main`/`module`/`browser`/`exports` 目标把入口文件列出来，一并豁免。口径只认**已声明在 package.json 里的
 * 入口**，不认"目录下代码随便挑一个"。
 */
const pkgEntryFiles = new Set() // package.json 声明的入口文件
const seenPkgDirs = new Set()
for (const x of SRC.concat(TST)) {
  const dir = path.posix.dirname(x.rel)
  if (seenPkgDirs.has(dir)) continue
  seenPkgDirs.add(dir)
  const pj = path.join(ROOT, dir, 'package.json')
  if (!fs.existsSync(pj)) continue
  let meta
  try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')) } catch { continue }
  const targets = [meta.main, meta.module, meta.browser]
  const walkExports = (v) => { if (typeof v === 'string') targets.push(v); else if (v && typeof v === 'object') for (const vv of Object.values(v)) walkExports(vv) }
  walkExports(meta.exports)
  for (const t of targets) {
    if (typeof t !== 'string' || !t.startsWith('.')) continue
    const rel = path.posix.normalize(dir + '/' + t)
    for (const c of [rel, rel + '.js', rel + '.mjs', rel + '.ts', rel + '.tsx', rel + '/index.js', rel + '/index.ts']) if (srcRels.has(c)) pkgEntryFiles.add(c)
  }
}
const ENTRY_RE = /(\/lib\/index\.js$|\/src\/dsh\/client-entry\.tsx?$|^electron-shell\/|(^|\/)scripts\/|\/dsh\/)/
const zeroFile = SRC.filter((x) => !usedFile.has(x.rel) && !usedWildcard.has(x.rel) && !ENTRY_RE.test(x.rel) && !pkgEntryFiles.has(x.rel) && !/\.d\.ts$/.test(x.rel))
M('Z', 'Z1', '零引用源文件（没有任何文件 import 它、且不是入口）', zeroFile.length, { offenders: topOf(cnt(zeroFile, (x) => x.pkg)).map(([k, v]) => ({ k, n: v, d: '零引用文件数' })), note: '入口豁免：lib/index.js、src/dsh/client-entry.*、electron-shell/、scripts/、*.d.ts、**嵌套 package.json 的入口**（ISS-653）；namespace/副作用/动态 import 一律算"整份被用"；**锚点相对的字符串路径引用**（join(HERE,…)/fork，ISS-653）也算。⚠️ 仍会漏掉靠反射式取用的情况 ⇒ 删之前逐条人工过', gate: 'K10a' })
const exported = []
for (const x of SRC) {
  if (x.reExportOnly) continue
  if (isDeclFile(x.rel)) continue // ISS-770 ①：`.d.ts` 是同一模块的类型视图，不是实现面（与 Z1 早有的 `.d.ts` 豁免同口径）
  for (const d of x.decls) if (d.exported && d.kind !== 'reexport') exported.push({ name: d.name, k: x.rel, line: d.line, pkg: x.pkg, kind: d.kind })
}
const zeroExport = exported.filter((e) => !used.has(`${e.k}::${e.name}`) && !usedWildcard.has(e.k))
/* ── ISS-654：K10b 的**坏ness 段**不含三件装载契约名 ───────────────────────
 * `name` / `inject` / `apply` 是 cordis 插件的**装载契约**：引擎按名字从 module.exports 上取，
 * 一个都不许删（删了插件不上电）。它们不是"没人用的导出"，只是"import 解析器看不见有人用"
 * —— 这正是 docs/code.md §K10b 已写明的漏判类型之「装配期按 id 加载」。
 *
 * ⚠️ **只按名字剔，不按路径圈地**（ISS-654 · 独立审查退回 high ①）。第一版剔的是整个 `ENTRY_RE`
 * （`lib/index.js` / `src/dsh/client-entry.*` / `scripts/` / `/dsh/` 全算），实测剔掉 **237** 条，
 * 其中只有 **84** 条是三件契约名 —— 另 **153** 条（`scripts/*.mjs` 的 helper 导出、
 * `lib/index.js` 里的常量与协议名）**跟着免计了**。那不是"装配盲区"，是判据面被路径正则悄悄放宽，
 * 且与上面这段论证（说的是三件契约名）范围对不上。现在收窄回名字本身；
 * 代价是 K10b 数值上升 —— 那 153 条确实是零引用导出，本来就该算。
 *
 * 清单 dead-exports.json 仍列全量、`entryFile` 标记照旧（"这个文件是装配面，值得人看一眼"）：
 * 标记是提示，判据是名字，两者不再混为一谈。
 * 变异验证：`scripts/*.mjs` 里加一个零引用导出 ⇒ **现在会计入**（第一版不计）；删掉 ⇒ 回落。 */
const LOAD_CONTRACT = new Set(LOAD_CONTRACT_NAMES) // 名字集定义在 dead-exports-lib.mjs（侧产物 zeroRefBadness 也用同一份，防口径分裂）
const zeroExportBad = zeroExport.filter((e) => !LOAD_CONTRACT.has(e.name))
if (WRITE_DEAD) {
  // 成员一律取本文件的 zeroExport / zeroFile（判据唯一持有处）；组装与打标在 dead-exports-lib 里，那边有自检
  const art = buildDeadArtifact({ exported, zeroExport, zeroFile, stringPool: POOLS.strings, entryRe: ENTRY_RE, src: SRC, tst: TST, resolveSpec, prodTokens: POOLS.prodTokens, testTokens: POOLS.testTokens, artifacts: TRACKED.all ? null : collectBuiltArtifacts(ROOT, TRACKED) }) // 拿不到 git ⇒ 不判（宁可不标，也不把看不见产物说成没有产物）
  fs.writeFileSync(DEAD, JSON.stringify(art, null, 1) + '\n')
  console.log(`✓ 已写 ${path.relative(ROOT, DEAD)}`)
  console.log(`  符号级：零引用导出 ${art.totals.zeroRef} / 导出总数 ${art.totals.exports} · 标记 declFile ${art.flags.declFile} / entryFile ${art.flags.entryFile} / stringRef ${art.flags.stringRef} / 产物自用 ${art.flags.builtArtifactSource} / 只被测试文本钉住 ${art.flags.testPinnedBySourceText} / 未解释 ${art.flags.none}`)
  console.log(`  文件级：零引用源文件 ${art.totals.zeroFiles} 个（判据同源 = 度量 Z1）`)
  console.log('  ⚠️ 两份清单都只报"没人 import"，不判"该删"——判断归 ISS-723，动手归老板点头之后的批次')
  // 路由明细（ISS-715）：成员取上面算好的 routes 同一份数组 ⇒ totals.copiedPaths 必然等于度量 C9
  const rart = buildRouteArtifactV2(routes, xbAssets); fs.writeFileSync(ROUTES, JSON.stringify(rart, null, 1) + '\n'); console.log(`  路由明细：${path.relative(ROOT, ROUTES)} · 同半区抄写 ${rart.totals.sameHalfCopies}（=C9 新口径）· 跨半区成对 ${rart.totals.crossHalfPairs} · 悬空 ${rart.totals.danglingRefs}（=C9d）· 旧口径全抄写 ${rart.totals.copiedPaths} · 跨包 ${rart.totals.crossPkgPaths}（=C9b）· 渗漏对 ${rart.totals.alienPairs}（=C10）· 跨 bundle 免计 ${rart.totals.crossBundleAssets} 名单腐烂 ${rart.totals.staleCrossBundle}`)
  const dart = buildDupArtifact({ multi, multiCross, clusters, undeclaredSoft }); fs.writeFileSync(DUP, JSON.stringify(dart, null, 1) + '\n'); console.log(`  重复明细：${path.relative(ROOT, DUP)} · 同名多份 ${dart.totals.sameNameImpl}（其中跨包 ${dart.totals.sameNameCrossPkg}，=D2）· 复制粘贴簇 ${dart.totals.dupClusters}（含 ${dart.totals.clusterFns} 个函数，=D3）· 靠 hoisting 的 import ${dart.totals.hoistingOnly} 处（=H5b） / ${dart.totals.hoistingPairs} 对`)
  if (!SAVE) process.exit(0) // 带 --baseline-save 不许提前退：复录要同一份测量同时出四份产物（09-23 踩过：合并跑时基线静默没写，只有三份明细变了）
}
M('Z', 'Z2', '导出总数 / 零引用导出（import 解析后无人取用，**不含三件装载契约名**）/ 占比', `${exported.length} / ${zeroExportBad.length} / ${Math.round(zeroExportBad.length * 100 / Math.max(1, exported.length))}%`, { offenders: topOf(cnt(zeroExportBad, (x) => x.pkg)).map(([k, v]) => ({ k, n: v, d: '零引用导出数' })), note: '**第 2 段只剔 `name`/`inject`/`apply` 三件装载契约名**（ISS-654：cordis 按名从 module.exports 取用，import 解析器必然看不见 —— 详见 zeroExportBad 上方注释；**不按路径剔**，`scripts/`、`lib/index.js`、`/dsh/` 下的其它导出照算，审查退回时实测这三处曾被误豁免 153 条）。全量清单仍在 dead-exports.json，带 entryFile 标记（标记是"这文件是装配面，看一眼"的提示，不是判据）。不含 default export（`export default` 不产生具名声明，本项对其无判据）；**再导出 `export {X} from` 同样不在射程**（脚本头 line 11 的 barrel 口径：只做再导出的文件不算实现，否则虚增重名与零引用）⇒ 纯转发的死再导出 Z1/Z2 都看不见，删掉它两个数都不会动（09-23 实测：删 agent-run.tsx 的 7 个转发名，Z2 一字未动，只有设计侧「业务包跨包 import」64→62 记到了这笔账）；解析失败的说明符见 Z3。**逐条是谁**在 `scripts/baseline/dead-exports.json`（`--write-dead-exports` 落盘，带三个降噪标记 + `testWashed`，ISS-732 / ISS-765）—— 本表只存每包前 10 个。**ISS-770 射程修正**（两条都是收窄假阳性、不放过真死码）：① **`.d.ts` 不是实现面** —— 消费方 import 的是 `lib/index.js`（barrel），`.d.ts` 是同一模块的类型视图，旧口径把它的声明当实现计数，实测 595 里 231 条（39%）是这类假阳性；与 Z1 早已排除 `.d.ts` 同口径。② **`scripts/` 子目录（`scripts/gates/` 等）作为消费者参与符号解析** —— 旧口径只 readdir 了 scripts 根，`scripts/gates/lint-oxlint.mjs:45` 对 `WORKTREE_IGNORE_GLOBS` 的真 import 看不见（照它删会让 lint-oxlint 崩）。修正后 595→362，基线同批 580→362（理由见 `scripts/baseline/code-gates.json` 的 note）。单元级验证见 `--selftest-z2`（含反向控制：真没人 import 的导出仍计）。', gate: 'K10b' })
const unresolved = [...new Set(SRC.flatMap((x) => x.imports.map((i) => ({ r: x.rel, t: resolveSpec(x.rel, i.spec), s: i.spec })).filter((o) => o.t && /UNRESOLVED/.test(o.t)).map((o) => `${o.r} → ${o.s}`)))]
/* Z3 的同族盲区（ISS-629 补丁 · 显式登记，不修）：
   ① **`parseFail` 的文件不进规则**——语法解析失败的文件，其 import 根本没被提取，
      自然也不会有「解析不到」的记录。所以 Z3 = 0 **不等于**全仓 import 都健康，
      只等于「能解析的文件里没有解析不到的导入」。
      这条盲区在输出头部有对账：`解析失败 N 个`（本次实测 0，但它是独立计数）。
   ② 只统计**跨包** spec（`forge-*` 且解析不到）——相对路径解析失败走另一分支返回 null，
      不计入（实测造 `./__nonexistent.js` 造不出违例，就是这么发现的）。
   ③ 动态说明符（`import(x)` / 变量路径）进反向图盲区，不在本项射程。 */
M('Z', 'Z3', '解析不到的 import（写了路径但文件不在）', unresolved.length, { offenders: topOf(unresolved).map((u) => ({ k: u })), gate: 'K10f', scanN: SRC.reduce((n, x) => n + x.imports.length, 0) })
const deadScripts = toolFiles.map((f) => rel(f)).filter((r) => {
  const name = path.basename(r)
  const hay = SHELL_ALL
  return !hay.includes(name)
})
M('Z', 'Z4', 'scripts/*.mjs 在仓库任何 .sh/.mjs/.json 里都不被点名（无主脚本）', deadScripts.length, { offenders: deadScripts.map((s) => ({ k: s })), note: '人手工跑的脚本不算死码 ⇒ 本项只作候选，需人工判定后归档' })
M('Z', 'Z5', '盘点范围外的代码目录（本次未量化 = 显式盲区）', ['agent-shared', 'vscode-dsh-models', 'learning', 'cad-figma-redesign', 'skills'].join(', '), { note: '与设计侧同样留"未覆盖清单"，不当成 0' })

/* ───────────────────────────────── 4. 输出 ───────────────────────────────── */
const HEADER = {
  tool: 'code-inventory.mjs', date: new Date().toISOString().slice(0, 10),
  node: process.version, ts: TS_VERSION, tsFrom: TS_FROM,
  packages: PKG_DIRS.length, filesScanned: kept.length, filesShell: shellFiles.length, vendorSkipped: vendor.length,
  parseFail: parseFail.length,
}
// ★ ISS-582：进 JSON 的是**真缺口**（未入库 **且未被 .gitignore 排除**）——
//   被忽略的多是构建产物（如 `src/styles/tailwind.generated.ts`），它们本就不该入库，
//   报成"缺口"会让警告在主 checkout **恒亮** ⇒ 告警疲劳，正好抵消本单目的（复审 medium）。
const GAP_SET = new Set((gitEnv(['ls-files', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean))
const TRACKED_GAP = TRACKED.missing.filter((f) => GAP_SET.has(f))
const payload = { header: HEADER, metrics: METRICS.map((m) => ({ ...m, offenders: m.offenders })), packages: perPkg, deps: [...pkgDeps.entries()].map(([k, v]) => ({ from: k, to: [...v] })), vendor, parseFail, trackedMissing: TRACKED_GAP, trackedAll: TRACKED.all } // ISS-582

if (SAVE) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify(payload, null, 1))
  console.log(`✓ 基线已存 ${rel(BASELINE)}（${METRICS.length} 项度量）`)
  console.log('  对照命令：node scripts/code-inventory.mjs --compare')
  if (!ROLES_TARGET && !AUDIT_TARGET) process.exit(0) // 过去无条件退 ⇒ 合并跑时 --write-audit/--roles 静默没写（09-23 实测：基线记 861 个源文件，审计稿还写着 860）→ ISS-753
}
if (CMP) {
  if (!fs.existsSync(BASELINE)) { console.error('✗ 没有基线，先跑 --baseline-save'); process.exit(2) }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  const bm = new Map(base.metrics.map((m) => [m.id, String(m.value)]))
  const rows = METRICS.map((m) => ({ id: m.id, title: m.title, before: bm.has(m.id) ? bm.get(m.id) : '<新增>', after: String(m.value), changed: bm.has(m.id) ? bm.get(m.id) !== String(m.value) : true }))
  const changed = rows.filter((r) => r.changed)
  console.log(`对照基线（存于 ${base.header.date}）：${changed.length} / ${rows.length} 项变了\n`)
  for (const r of changed) console.log(`  ${r.id.padEnd(4)} ${r.title.slice(0, 46).padEnd(48)} ${r.before} → ${r.after}`)
  console.log('\n⚠️ 本命令只报"变了"，好坏由人判（数值方向含义不一致：违规数↓ 是收敛，包数↑ 是新增）')
  // ISS-635 三态返回码（0 绿 / 1 红 / 2 判不了）：本档**判不了**，返回 2 而不是 0 —— 0 会被读取方当成"绿"。
  // 为什么不在这里判新增违例：带 K 号的违例度量（`gate` 字段非空的那批）**已经**由 lint-code 门禁按
  // zero / whitelist / ratchet 三档逐条判（基线 scripts/baseline/code-gates.json，每支都进守卫退出码）；
  // 本档再判一遍 = 同一件事两份判据（口径漂移 + 双倍红），而且"包数↑/文件数↑/行数↑"这类中性漂移
  // 没有方向可言，一概判红就是长红 —— 长红的门禁等于没有门禁。
  console.log('判不了 —— 本档不判「新增违例」：带 K 号的违例度量由 lint-code 门禁判（scripts/lint-code.mjs --check）；本档只报计数漂移')
  process.exit(2)
}

// --roles <file>：生成「包角色表」（ISS-703 交付物）——每一列都由本脚本现算，禁手抄
// （ROLES_TARGET / AUDIT_TARGET 已上移到第 39 行附近 —— SAVE 分支要据它们判断能不能提前退）
if (ROLES_TARGET) {
  const OPEN = '<!-- code-roles:begin · 由 `node scripts/code-inventory.mjs --roles docs/code-roles.md` 生成，手改即被覆盖 -->'
  const CLOSE = '<!-- code-roles:end -->'
  const rows = PKG_DIRS.filter((x) => x !== 'electron-shell').map((pkg) => {
    const src = SRC.filter((x) => x.pkg === pkg)
    const hasHost = src.some((x) => x.half === 'host')
    const hasClient = src.some((x) => x.half === 'client')
    const pj = pkgPkgJson(pkg)
    const inA = LINK_A.has(pkg), inB = LINK_B.has(pkg), declared = MOUNTED.has(pkg), patch = selfPatch.has(pkg)
    const role = roleOf(pkg)
    const tcs = tsconfigs.filter((t) => t.pkg === pkg)
    const hostCovered = !hasHost || tcs.some((t) => (t.include || []).some((i) => /lib/.test(i)) || t.file.includes('.lib.'))
    const consumers = new Set(depEdges.filter((e) => e.to === pkg).map((e) => e.from)).size
    const flags = []
    if (!declared && (inA || inB) && patch) flags.push('隐式装配')
    if (!declared && !inA && !inB && !consumers) flags.push('三不靠')
    if (hasHost && !tcs.length) flags.push('零 tsconfig')
    else if (hasHost && !hostCovered) flags.push('host 不在检查范围')
    if (!(pj.dependencies || {}) && src.length > 5) flags.push('无 deps 声明')
    if (!pj.scripts || !pj.scripts.typecheck) flags.push('缺 typecheck')
    if (!pj.scripts || !pj.scripts.test) flags.push('缺 test')
    return { pkg, role, host: hasHost ? '✓' : '', client: hasClient ? '✓' : '', decl: declared ? '✓' : '', a: inA ? '✓' : '', b: inB ? '✓' : '', sp: patch ? '✓' : '', files: src.length, cons: consumers, todo: flags.join(' · ') || '—' }
  })
  const head = '| 包 | 角色 | host | client | ① profile 声明 | ② 自带 patch | ③ 软链 A | ③ 软链 B | 源文件 | 消费者 | 待办（现算） |\n|---|---|---|---|---|---|---|---|---:|---:|---|'
  const body = rows.map((r) => `| \`${r.pkg}\` | ${r.role} | ${r.host} | ${r.client} | ${r.decl} | ${r.sp} | ${r.a} | ${r.b} | ${r.files} | ${r.cons} | ${r.todo} |`).join('\n')
  const abs = path.resolve(ROOT, ROLES_TARGET)
  const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''
  const i = cur.indexOf(OPEN), j = cur.indexOf(CLOSE)
  if (i < 0 || j < 0) { console.error(`✗ ${ROLES_TARGET} 里找不到成对标记（code-roles:begin / end）`); process.exit(2) }
  fs.writeFileSync(abs, cur.slice(0, i + OPEN.length) + '\n' + head + '\n' + body + '\n' + cur.slice(j))
  console.log(`✓ 角色表已写入 ${ROLES_TARGET}（${rows.length} 个包 · 现算）`)
  if (!AUDIT_TARGET) process.exit(0) // 同一次测量里还排着审计稿 ⇒ 继续往下走（ISS-753）
}

// --write-audit <file>：把度量表写进文档的成对标记之间 ⇒ 文档里的数字只能由本命令产生（防腐条款）
if (AUDIT_TARGET) {
  const OPEN = '<!-- code-inventory:begin · 由 `node scripts/code-inventory.mjs --write-audit docs/code-audit.md` 生成，手改即被覆盖 -->'
  const CLOSE = '<!-- code-inventory:end -->'
  const abs = path.resolve(ROOT, AUDIT_TARGET)
  const body = mdBody()
  const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''
  const i = cur.indexOf(OPEN), j = cur.indexOf(CLOSE)
  if (i < 0 || j < 0) { console.error(`✗ ${AUDIT_TARGET} 里找不到成对标记，先在文档中放好：\n${OPEN}\n${CLOSE}`); process.exit(2) }
  const next = cur.slice(0, i + OPEN.length) + '\n' + body + '\n' + cur.slice(j)
  fs.writeFileSync(abs, next)
  console.log(`✓ 已写入 ${AUDIT_TARGET}（${METRICS.length} 项度量 · ${body.split('\n').length} 行）`)
  process.exit(0)
}

/* 取证环境的两个函数（ENV_NOTE / 政策全文见文件头部 ENV_AT 那一块）。函数声明会被提升，
   所以住在这里是安全的；`const ENV_NOTE` 不行 ⇒ 它留在头部。 */
function gitEnv(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}
function envLine() {
  const head = ENV_AT ? ENV_AT.head : ''
  const st = ENV_AT ? ENV_AT.st : ''
  const state = !head ? '未知（无 git）' : st ? `dirty ${st.split('\n').filter((l) => l.trim()).length}` : 'clean'
  const homes = [['~/.dsh', AH.A], ['~/.dsh-matter', AH.B]].map(([n, h]) => `${n} ${fs.existsSync(h) ? '✓' : '✗'}`).join(' · ')
  return `> 取证环境（随复录重写，不是仓库真相；工作区状态取自本次运行**开始前**）：HEAD ${head || '<无 git>'} · 工作区 ${ROOT} ${state} · DSH homes ${homes}${process.env.DSH_HOME ? ` · DSH_HOME ${process.env.DSH_HOME}` : ''} · node ${process.version} / ts ${TS_VERSION}`
}

function mdBody() {
  const out = [], cell = (s) => String(s).replace(/\|/g, '\\|') // markdown 表格单元格：值里带裸 `|` 会把列打散
  out.push(envLine())
  out.push(ENV_NOTE)
  out.push(`> 取值手段：TypeScript ${TS_VERSION}（${TS_FROM}）真解析 ${kept.length} 个源文件 + ${shellFiles.length} 个 shell；vendor/产物级 ${vendor.length} 个已排除；未入库跳过 ${TRACKED.missing.length} 个${TRACKED.all ? "（无 git，本次未过滤）" : ""}${TRACKED.missing.length ? "：" + TRACKED.missing.join(" ") : ""}；AST 解析失败 ${parseFail.length} 个。**这里的「源文件」含测试文件与 scripts/，而表内 T1 的「源文件数」只数非测试的模块文件 ⇒ 两个数天然不等，不是矛盾**。跑法 \`node scripts/code-inventory.mjs --md\`，基线 \`--baseline-save\` / \`--compare\`。`)
  for (const sec of ['B', 'N', 'H', 'C', 'D', 'T', 'E', 'Z']) {
    const ms = METRICS.filter((m) => m.sec === sec)
    if (!ms.length) continue
    out.push(`\n### ${SEC[sec]}\n`)
    out.push('| # | 度量 | 值 | 门禁候选 |\n|---|---|---|---|')
    for (const m of ms) out.push(`| ${m.id} | ${cell(m.env ? `${m.title}（环境量）` : m.title)} | ${cell(m.value)} | ${m.gate || '—'} |`) // cell() 转义裸 `|`：E5 标题里的 `|| true` 曾把这一行打成 6 列（ISS-753，由 audit-doc-sync 抓到）
    for (const m of ms) {
      if (!m.offenders.length) continue
      out.push(`\n**${m.id} 明细**${m.note ? '（' + m.note + '）' : ''}\n`)
      for (const o of m.offenders) out.push(`- \`${o.k}\`${o.n !== undefined ? ' ×' + o.n : ''}${o.d ? ' — ' + o.d : ''}`)
    }
  }
  return out.join('\n')
}

/* ISS-622 · --list：把门禁度量的违例逐条打到 `文件:行`。
   动机：棘轮只说「K9f 339 → 347」，还债的人不知道这 8 处是哪 8 行（实测按包名反查 git 会得出"这几个文件根本没改"的错结论）。
   纪律：**只多打位置，不动判据** —— sites 与 offenders/值同源（同一批命中点），打印不影响任何计数。
   棘轮上限从 scripts/baseline/code-gates.json 的 ceiling 读（**只读、纯展示**）：读不到就只打现值，
   不因读不到基线而崩 —— 否则"看一眼债在哪"要先修基线。 */
function ratchetCeiling(gate) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'baseline', 'code-gates.json'), 'utf8')).ceiling[gate] } catch { return undefined }
}
function printSites() {
  const ms = METRICS.filter((m) => m.gate && m.sites.length)
  console.log('')
  if (!ms.length) { console.log('--list：本次没有可列位置的违例（E5/E8 的 sites 为空 ⇒ 要么真 0 处，要么该度量被 --only 排除）'); return }
  for (const m of ms) {
    const c = ratchetCeiling(m.gate)
    console.log(`${m.gate} ${m.title}${c === undefined ? `（${m.value}）` : `（${c} → ${m.value}）`}`)
    // 按文件分组、行号升序。同一行命中多次（如 `cmd 2>/dev/null || true`）**只打一次** ——
    // 那是"改一行清两处"，重复打只会让还债清单看起来比实际长；差量用下面那行如实交代，不许静默不符。
    const shown = new Set()
    for (const [k, arr] of group(m.sites, (s) => s.k)) for (const s of [...new Set(arr.map((t) => t.line))].sort((a, b) => a - b)) { console.log(`  ${k}:${s}`); shown.add(k + ':' + s) }
    if (shown.size !== m.sites.length) console.log(`  （共 ${m.sites.length} 处命中 · ${shown.size} 个不同位置：同一行可能同时命中两个模式，改一行清两处）`)
  }
}

if (MODE === 'json') {
  console.log(JSON.stringify(payload, null, 1))
} else if (MODE === 'md') {
  console.log(mdBody())
} else {
  console.log(`代码盘点 · ${HEADER.date} · node ${process.version} · typescript ${TS_VERSION}@${TS_FROM}`)
  console.log(`范围：${PKG_DIRS.length} 个包 + scripts/ · ${kept.length} 个源文件（vendor ${vendor.length} 个已排除 · 解析失败 ${parseFail.length}）`)
  /* ISS-629 · Z5 盲区显式化（DOC-447 §5）：这几个目录**没纳入盘点**，不是"零违例"。
     一行明示，免得读者把「没量」读成「没有」。取 Z5 自己的值，不重写目录清单（唯一真相源）。 */
  {
    const z5 = METRICS.find((m) => m.id === 'Z5')
    console.log(z5
      ? `盲区：${z5.value.split(',').length} 个目录未纳入盘点（${z5.value}）—— 不是 0，是没量（Z5）`
      : '盲区：Z5 读不到 —— 盘点范围外目录未知（不许当成 0）')
  }
  console.log('')
  for (const sec of ['B', 'N', 'H', 'C', 'D', 'T', 'E', 'Z']) {
    const ms = METRICS.filter((m) => m.sec === sec)
    if (!ms.length) continue
    console.log(`\x1b[1m${SEC[sec]}\x1b[0m`)
    for (const m of ms) console.log(`  ${m.id.padEnd(4)} ${String(m.value).padEnd(18)} ${m.title}${m.gate ? '  [门禁 ' + m.gate + ']' : ''}`)
    if (VERBOSE) for (const m of ms) for (const o of m.offenders) console.log(`        ${m.id} · ${o.k}${o.n !== undefined ? ' ×' + o.n : ''}${o.d ? ' — ' + o.d : ''}`)
  }
  if (LIST) printSites()
  console.log('\n用法：--json 出机器结果 · --md 出审计稿表格 · --verbose 列明细 · --list 列 E5/E8 违例的 文件:行 · --top N 截断 · --only B,Z 选章 · --baseline-save/--compare 基线对照')
}

/* F1 守卫的出口（ISS-624）：连线断了就不能 exit 0 —— 否则「跑过了」又变成一句没有牙的话。
 * 走 exit 1（判据失效档，不是 2 的"输入错误"），与 lint-code 对「判据失效」的处理同档。 */
if (WIRING_FAIL) process.exit(1)
