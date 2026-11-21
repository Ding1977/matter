// 审计稿「仓库事实类」headline ↔ 基线 ↔ 现仓：一条轻量对账（ISS-563）
//
// 与隔壁 `audit-doc-sync.mjs --check` 的分工（不是重复，别合并）：
//   · 那边判的是「文档 == 基线」——两份产物**同源**（第一族逐 id 比，**含 D5 的消费者计数**）；
//     但同源不等于新鲜，两份可以**一起过期**。ISS-563 的现场就是这样：文档 B1 写 29 / 29、
//     基线也写 29 / 29，所有检查全绿，而盘上早已是 27 / 29（「消费者计数少一个」那条同型：
//     数字是旧环境的，没人看得出）。
//   · 本判据只补那边判不了的两格（都只读已落盘产物 + 一次 readdir，毫秒级，**不现跑 code-inventory**）：
//       ① 基线 ↔ **今天的仓库**：只读根 package.json 与顶层目录名（B1 包总数 / T1 首段包数）
//       ② 基线 ↔ **它自己的边表 deps**：D5（共享层消费者数）的去重 `from` 数复核 —— 纯基线内部对账
//     ⇒ 「文档 ↔ 基线」那一支**不在这里重写**（重写 = 双写；audit-doc-sync 第一族已经逐 id 判了）。
//     只读生成块（`<!-- code-inventory:begin … end -->`）：块外的表格与正文不参与判据。
//
// 明写的边界（别以为全盖住了）：
//   · **环境量故意不判**：B4/B5/B5b/B5c/B7/B8/B10（软链与 profile 声明）、H5a（依赖安装面）换台
//     机器 / 换 home 就变，钉进来 = 把环境当真相；B7 在 `.wt/<ISS>` 树里还会语义倒置（见 code-inventory 的 note）。
//   · **消费者计数（D5 型）的「基线 ↔ 现仓」新鲜度不判** —— ISS-563 证据① 正是这一格（文档与基线
//     一起旧，而仓里已经多了一个消费者）。D5 由 import 解析得出，复核它要**重解析全仓 import**
//     （= 现跑 code-inventory），门禁里不做。上面 ② 只能间接兜一半（拦「度量与自己的边表分家」）。
//     要真判这一格，得让基线落盘**每包消费者数**（复录口径变更，例如 `perPkg` 增 `cons` 字段）——
//     在那之前：D5 只保证「不比自己少」，**不保证「不比现仓旧」**。
//
// 用法：`node scripts/audit-freshness.mjs [--check]`（默认） | `--selftest`
// 退出码：0 = 一致（或参考件读不到 ⇒ 判「不判」，不许冒充「对得上」）· 2 = 分家 / 过期 / 缺产物
import fs from 'node:fs'
import path from 'node:path'
import { WORKTREE_DIR_NAMES, isWorktreePath } from './wt-exclude-lib.mjs' // ISS-724：工作树落点的唯一真相源

const ROOT = path.resolve(import.meta.dirname, '..')
const BASE = path.join(ROOT, 'scripts', 'baseline', 'code-inventory.json')
const DOC = path.join(ROOT, 'docs', 'code-audit.md')
const OPEN = '<!-- code-inventory:begin', CLOSE = '<!-- code-inventory:end -->'
const HEADLINE = ['B1', 'T1'] // 文档↔基线要比的 id：仓库事实类，只由本仓的文件决定，与机器/home/依赖安装面无关
const SHARED_ID = 'D5' // 消费者计数那一格：文档↔基线归 audit-doc-sync（逐 id 含它），本文件只判它 ↔ 基线自己的边表

/** 生成块里的度量行 `| ID | 度量 | 值 | 门禁 |` → Map(id → 值)。
 *  切列只切**未转义**的 `|`，切完把 `\|` 还原 —— 标题里合法存在 `|| true`（E5），
 *  生成器会转义成 `\|\|`（ISS-753 的同一颗坑，这里要按同一条口径解析）。 */
function docRows(txt) {
  const i = txt.indexOf(OPEN), j = txt.indexOf(CLOSE)
  if (i < 0 || j < 0) return null
  const rows = new Map()
  for (const line of txt.slice(i, j).split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|') || !t.endsWith('|')) continue
    const c = t.slice(1, -1).split(/(?<!\\)\|/).map((s) => s.trim().replace(/\\\|/g, '|'))
    if (c.length === 4 && /^[A-Z]\w*$/.test(c[0])) rows.set(c[0], c[2])
  }
  return rows
}

/** 第一族：文档 headline 值 ↔ 基线同 id 值。纯函数 ⇒ 自检夹具不碰真文件。 */
function diffDoc(base, doc) {
  if (!doc) return ['生成块成对标记缺失（code-inventory:begin / end 有一头找不到）']
  const out = []
  for (const id of HEADLINE) {
    const b = base.get(id), d = doc.get(id)
    if (b === undefined) out.push(`${id} 基线里没有这一格 ⇒ 判据指向了不存在的度量（口径改了就要改这里）`)
    else if (d === undefined) out.push(`${id} 文档生成块里没有这一行（复录漏写，或有人手改了表）`)
    else if (d !== b) out.push(`${id} 文档「${d}」≠ 基线「${b}」⇒ 两份产物分了家（只重录了一边）`)
  }
  return out
}

/** 纯函数：从**顶层目录名**清单数包（`hasPkg(d)` = 该目录里有 package.json）。
 *  ⚠️ 「包」的判据是**目录里有 package.json**，不是目录名命中（ISS-650 批2）：只看名字会把
 *  只剩 `dist/` + `node_modules/` 的残骸（`forge-services`）算成一个包、把已退役包数成现役，
 *  于是基线永远比现仓少一个。口径与 code-inventory 的 `dirsWithPkg`（B1 右侧）同一套，别新造。
 *  抽成纯函数是为了自检能造出「目录在、package.json 不在」的残骸而不碰真仓。 */
function pkgCounts(dirNames, hasPkg) {
  const pkgDirs = dirNames.filter(hasPkg)
  return {
    b1Forge: pkgDirs.filter((d) => /^forge-/.test(d)).length,
    t1: pkgDirs.filter((d) => /^(forge-[a-z0-9-]+|electron-shell)$/.test(d)).length,
  }
}

/** 现仓事实（口径抄 code-inventory.mjs 的 B1 / T1 首段：只读根 package.json + 顶层目录名，不扫源码）。
 *  拿不到根清单 ⇒ 返回 null，调用方判「不判」——缺参考件不等于「对得上」。 */
function repoFacts() {
  const pj = path.join(ROOT, 'package.json')
  if (!fs.existsSync(pj)) return null
  let ws = []
  try { ws = JSON.parse(fs.readFileSync(pj, 'utf8')).workspaces || [] } catch { return null }
  // ISS-724：工作树落点先摘掉再数。今天它们**本来就不计**（判据是「顶层目录里有 package.json」，
  //   `.wt` / `.agents` 都没有该文件）⇒ 加这一刀不改任何数字，属于「落点搬家后仍然对」的防御。
  //   什么时候它会长牙：落点变成仓根平铺（`ISS-123/package.json`），或容器目录里出现 package.json。
  const wtIgnore = new Set(WORKTREE_DIR_NAMES)
  const dirs = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !wtIgnore.has(e.name) && !isWorktreePath(e.name))
    .map((e) => e.name)
  const c = pkgCounts(dirs, (d) => fs.existsSync(path.join(ROOT, d, 'package.json')))
  return { b1: `${ws.length} / ${c.b1Forge}`, t1pkg: String(c.t1) }
}

/** 第二族：基线 headline ↔ 现仓事实（facts=null ⇒ 返回 null = 判「不判」） */
function diffRepo(base, facts) {
  if (!facts) return null
  const out = []
  const b1 = base.get('B1'), t1 = base.get('T1')
  if (b1 !== undefined && b1 !== facts.b1) out.push(`B1 基线「${b1}」≠ 现仓「${facts.b1}」⇒ 基线过期（包增删后没有复录）`)
  const first = t1 === undefined ? undefined : String(t1).split(' / ')[0]
  if (first !== undefined && first !== facts.t1pkg) out.push(`T1 基线首段「${first}」≠ 现仓包数「${facts.t1pkg}」⇒ 基线过期`)
  return out
}

/** 第三族：基线**内部**自洽 —— D5（共享层消费者数）↔ 基线自己的边表 `deps`。
 *  口径出处 = code-inventory.mjs 的 `consumers`（`depEdges` 去重后的 `from` 数）；而落盘的 `deps`
 *  由 `pkgDeps` 生成、**丢自环边**（源码里那句 `if (to !== x.pkg)`）⇒ 差额只可能来自「这个包自己
 *  import 自己」，且 `from` 去重后每个包至多一条自环 ⇒ 差额 ∈ {0,1}。判据 = `0 ≤ D5 − 复核 ≤ 1`：
 *  差为负 = 度量比自己的边表还少（**ISS-563 证据① 的形状：计数少一个**）；差 > 1 = deps 丢自环
 *  解释不了。纯基线内部 ⇒ 不碰现仓。`D5.offenders` / `deps` 读不到 ⇒ 返回 null = 判「不判」。
 *  ⚠️ 这一族**不判新鲜度**：基线与仓一起旧时它照样绿（边界见文件头）。 */
function diffSharedDeps(raw) {
  const d5 = (raw?.metrics || []).find((m) => m.id === SHARED_ID)
  if (!d5 || !Array.isArray(d5.offenders) || !Array.isArray(raw.deps)) return null
  const inbound = new Map() // 包 → 跨包消费者集合（自环不计：deps 本来就不落自环边）
  for (const e of raw.deps) for (const to of e.to || []) {
    if (e.from === to) continue
    if (!inbound.has(to)) inbound.set(to, new Set())
    inbound.get(to).add(e.from)
  }
  const out = []
  for (const o of d5.offenders) {
    const lower = (inbound.get(o.k) || new Set()).size
    if (o.n < lower) out.push(`${SHARED_ID} 给 ${o.k} 记 ${o.n} 个消费者，而基线自己的边表 deps 里有 ${lower} 个跨包消费者 ⇒ 度量比自己的边表还少（ISS-563 证据① 的形状：计数少一个）`)
    else if (o.n - lower > 1) out.push(`${SHARED_ID} 给 ${o.k} 记 ${o.n} 个消费者，deps 复核得 ${lower} 个 ⇒ 多 ${o.n - lower} 个，超出自环能解释的上限 1（deps 只丢自环边）`)
  }
  return out
}

function selftest() {
  const base = new Map([['B1', '27 / 29'], ['T1', '30 / 662 / 160487'], ['B7', '0 / 22']])
  const facts = { b1: '27 / 29', t1pkg: '30' }
  // 第三族的夹具：forge-design 自引（deps 丢自环 ⇒ D5 记 3 = 2 个跨包 + 1 自环），其余三包 = 各自跨包数
  const raw = {
    metrics: [{ id: 'D5', value: 'design:3 service-kit:2 shell:1 agent-protocol:1', offenders: [{ k: 'forge-design', n: 3 }, { k: 'forge-service-kit', n: 2 }, { k: 'forge-shell', n: 1 }, { k: 'forge-agent-protocol', n: 1 }] }],
    deps: [
      { from: 'forge-agents', to: ['forge-design', 'forge-service-kit', 'forge-agent-protocol'] },
      { from: 'forge-model', to: ['forge-design', 'forge-service-kit'] },
      { from: 'forge-ui', to: ['forge-shell'] },
    ],
  }
  const withD5 = (n) => { const r = JSON.parse(JSON.stringify(raw)); r.metrics[0].offenders[0].n = n; return r }
  const one = (lines, id) => lines.length === 1 && lines[0].includes(id)
  const cases = [
    ['① 文档与基线一致 + 现仓事实一致 ⇒ 绿（阳性对照，两侧都要 0 条）', diffDoc(base, new Map(base)).length === 0 && diffRepo(base, facts).length === 0],
    ['② 文档 B1 与基线不符 ⇒ 恰好 1 条、点名 B1', one(diffDoc(base, new Map(base).set('B1', '29 / 29')), 'B1')],
    ['③ 文档缺 B1 行 ⇒ 红（复录漏写或被手删）', one(diffDoc(base, new Map([['T1', '30 / 662 / 160487']])), 'B1')],
    ['④ 生成块标记缺失 ⇒ 红，不许静默绿', diffDoc(base, null).length === 1],
    ['⑤ 基线 B1 与现仓不符 ⇒ 红、点名 B1（这一格 = 同源但都旧）', one(diffRepo(base, { b1: '29 / 29', t1pkg: '30' }), 'B1')],
    ['⑥ T1 首段（包数）与现仓不符 ⇒ 红、点名 T1', one(diffRepo(base, { b1: '27 / 29', t1pkg: '31' }), 'T1')],
    ['⑦ 现仓事实读不到 ⇒ 判「不判」（null），不冒充对得上', diffRepo(base, null) === null],
    ['⑧ 环境量 id（B7）故意不比：文档写了别的值也不红（换机器就变的东西不当判据）', diffDoc(base, new Map(base).set('B7', '9 / 22')).length === 0],
    // 反向：解析器只认生成块。块外放一行同 id 的表，不许被当成生成块的内容（否则复录漏写会被块外手抄的行掩盖）
    ['⑨ 只读生成块：块外同 id 的表不算数', docRows(`| B1 | 局外 | 4 / 4 | — |\n${OPEN}\n| B1 | x | 27 / 29 | — |\n${CLOSE}`).get('B1') === '27 / 29'],
    ['⑩ 转义过的标题（`\\|\\| true`）不会把这一行打成 6 列', docRows(`${OPEN}\n| E5 | 静默失败（\\|\\| true） | 200 | K9c |\n${CLOSE}`).get('E5') === '200'],
    // ── ISS-563 复审 MEDIUM-1：消费者计数（D5 型）的廉价对账 + 边界钉住 ──
    ['⑪ D5 ↔ 基线自己的边表 deps 一致（含 1 条自环的解释）⇒ 绿', diffSharedDeps(raw).length === 0],
    ['⑫ D5 比 deps 少一个消费者 ⇒ 恰好 1 条、点名那个包（证据① 的形状）', one(diffSharedDeps(withD5(1)), 'forge-design')],
    ['⑬ D5 比 deps 多 2 个以上 ⇒ 红（「丢自环」解释不了）', one(diffSharedDeps(withD5(5)), 'forge-design')],
    ['⑭ deps / D5.offenders 读不到 ⇒ 判「不判」（null），不冒充对得上', diffSharedDeps({ metrics: [{ id: 'D5', offenders: [] }] }) === null],
    ['⑮ 边界钉住：D5 不在本文件的文档↔基线清单里（那一支归 audit-doc-sync 第一族逐 id 判，含 D5；这里不双写）', !HEADLINE.includes('D5')],
    // ⑯/⑰ ISS-650 批2：包数口径 = 「目录里有 package.json」，不是「目录名命中」
    ['⑯ 包数只数有 package.json 的目录：残骸（目录在、package.json 不在，如 forge-services）不算包',
      (() => { const c = pkgCounts(['forge-a', 'forge-b', 'forge-services', 'electron-shell', 'docs'], (d) => d !== 'forge-services'); return c.b1Forge === 2 && c.t1 === 3 })()],
    ['⑰ 反向控制：同一个残骸目录一旦补上 package.json 就照常计入（不是恒不数）',
      (() => { const c = pkgCounts(['forge-a', 'forge-services'], () => true); return c.b1Forge === 2 && c.t1 === 2 })()],
  ]
  let bad = 0
  for (const [name, ok] of cases) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) bad++ }
  console.log(`audit-freshness selftest ${cases.length - bad}/${cases.length} 通过`)
  return bad ? 2 : 0
}

if (process.argv.includes('--selftest')) process.exit(selftest())

if (!fs.existsSync(BASE) || !fs.existsSync(DOC)) {
  console.error(`✗ 缺产物：${fs.existsSync(BASE) ? '' : path.relative(ROOT, BASE) + ' '}${fs.existsSync(DOC) ? '' : path.relative(ROOT, DOC)}（先跑一次复录；缺产物判红，不当成通过）`)
  process.exit(2)
}
const raw = JSON.parse(fs.readFileSync(BASE, 'utf8'))
const base = new Map(raw.metrics.map((m) => [m.id, String(m.value)]))
const badDoc = diffDoc(base, docRows(fs.readFileSync(DOC, 'utf8')))
const badRepo = diffRepo(base, repoFacts())
const badShared = diffSharedDeps(raw)
if (badDoc.length + (badRepo || []).length + (badShared || []).length) {
  console.log(`✗ 审计稿的仓库事实类 headline 过期 / 分家（${HEADLINE.join(' · ')} · ISS-563）`)
  for (const l of badDoc) console.log(`   · [文档↔基线] ${l}`)
  for (const l of badRepo || []) console.log(`   · [基线↔现仓] ${l}`)
  for (const l of badShared || []) console.log(`   · [基线↔自己的边表 deps] ${l}`)
  console.log('   → 全量复录一条命令：node scripts/code-inventory.mjs --baseline-save --write-dead-exports --write-route-ledger --write-dup-detail --write-audit docs/code-audit.md')
  console.log('     再补一条（读 dup-detail，必须在 --write-dup-detail **之后**）：node scripts/k6a-screen.mjs --write')
  process.exit(2)
}
const notJudged = []
if (!badRepo) notJudged.push('基线 ↔ 现仓（B1 · T1 首段）')
if (!badShared) notJudged.push(`${SHARED_ID} ↔ 基线自己的边表 deps`)
if (notJudged.length) {
  console.log(`· 审计稿 headline（${HEADLINE.join(' · ')}）与基线一致；以下**不判**（参考件读不到 ⇒ 不冒充「对得上」，边界见文件头）：${notJudged.join('；')}`)
  process.exit(0)
}
console.log(`✓ 审计稿 headline 与基线一致，且基线对得上现仓、D5 对得上自己的边表（${HEADLINE.join(' · ')} · B1 ${base.get('B1')} · T1 ${base.get('T1')} · ${SHARED_ID} ${base.get(SHARED_ID)}）`)
