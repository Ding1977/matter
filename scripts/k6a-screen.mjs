// K6a 还账点名器（ISS-739）：把度量 D2 的 244 组同名实现分成「可并 / 闭包绑定 / 无同体 / UI 家族」四档。
//
// 为什么要有这个文件：D2 只回答"有几组同名"，回答不了"这一组今天能不能并、并到哪、谁挡着"。
// 上一轮我用一次性脚本量出 48 组可并 / 20 组闭包绑定 / 36 组 UI 家族，**但脚本用完就删了**，
// 于是这批账又退回成点不上名的数字 —— 与「度量只存前 N 条 offender 就没法逐条还」是同一类缺陷
// （治法也一样：把判断落成可重跑的判据 + 全量明细 side artifact，见 ISS-732 / dup-detail.json）。
//
// 口径纪律：
//  · 组成员一律取 `scripts/baseline/dup-detail.json` 的 `sameNameImpl`（= 度量 D2 的同一份数组），
//    本脚本**不另算一套同名分组**，只加"动得了动不了"的第二层判断 ⇒ 组数恒等于 D2，`--check` 核这条。
//  · 站点行号来自那份明细；定位不到声明 = 明细过期 ⇒ `--check` 判红（催随复录一起重生成），不许静默跳过。
//  · 判据保守：组内只要有同体那份引用了本文件模块级绑定，就点名它为闭包绑定 ——
//    宁可少报可并。前一轮的实测教训是反方向：`ts.forEachChild` 会访问函数自身的名字，
//    没排掉就把 62/68 组误判成"闭包不可并"（还显得很有道理），所以自检第 ③ 条专门钉这个。
//
// 用法：node scripts/k6a-screen.mjs [--write 落明细] [--check 同源且可复算] [--selftest] [--verbose]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..'), A = process.argv.slice(2)
// typescript 借仓库里已有的那份，按候选路径显式解析 —— **不能裸 `import ts from "typescript"`**：
// 工作树里没有该包的 node_modules（09-22 实测 ERR_MODULE_NOT_FOUND），口径与 code-inventory.mjs §0 一致。
const ts = (() => {
  for (const c of ['forge-ui/node_modules/typescript', 'forge-pm/node_modules/typescript', 'node_modules/typescript']) {
    try { return createRequire(path.join(path.resolve(ROOT, c), 'package.json'))('typescript') } catch { /* 换下一个候选 */ }
  }
  console.error('✗ 找不到 typescript 编译器（试过 forge-ui / forge-pm / root 的 node_modules）'); process.exit(2)
})()
const DUP = path.join(ROOT, 'scripts', 'baseline', 'dup-detail.json')
const OUT = path.join(ROOT, 'scripts', 'baseline', 'k6a-screen.json')
const VERBOSE = A.includes('--verbose')
const absOf = (rel) => (path.isAbsolute(rel) ? rel : path.join(ROOT, rel))
const isFnNode = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n)

/* ───────────────────── 1. 站点 → 声明节点 → 实现体 → 自由标识符 ───────────────────── */

const sfCache = new Map()
function sourceOf(rel) {
  if (sfCache.has(rel)) return sfCache.get(rel)
  const abs = absOf(rel)
  const sf = fs.existsSync(abs) ? ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true) : null
  sfCache.set(rel, sf)
  return sf
}

/** 模块级绑定名（顶层 function/class/enum + 顶层 const/let），用来判"体内引用了本文件的谁" */
function moduleBindings(sf) {
  const names = new Set()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) { if (st.name) names.add(st.name.text) }
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text)
  }
  return names
}

/** 找 `name` 的声明：行号命中优先，否则取行距最近的一个（行号漂了也不静默丢整组） */
function locateDecl(sf, name, wantLine) {
  const cands = []
  for (const st of sf.statements) {
    const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
      if (st.name?.text === name) cands.push({ body: st.body, line })
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const ini = d.initializer
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !ini) continue
        if (isFnNode(ini) || ts.isClassExpression(ini)) cands.push({ body: ini.body, line })
      }
    }
  }
  if (!cands.length) return null
  return cands.find((c) => c.line === wantLine) || cands.reduce((a, b) => (Math.abs(b.line - wantLine) < Math.abs(a.line - wantLine) ? b : a), cands[0])
}

/** 实现体文本：Block / ClassBody 取大括号内整体，无大括号的箭头取那个表达式
 *  （09-22 两次误报"不等价"都是因为配平取体一路吞到下一对花括号） */
const bodyText = (sf, decl) => (decl?.body ? decl.body.getText(sf).trim() : null)
const normBody = (t) => (t == null ? null : t.replace(/\s+/g, ' ').trim())

/** 体内自由标识符：排掉属性名、对象字面量键、label、以及被体内局部声明遮住的；**含"函数自己的名字"**
 *  —— 具名递归不是闭包依赖，这一条是 09-22 那次 62/68 误判的根因 */
function freeIdsInBody(body, selfName) {
  const out = new Set(), local = new Set()
  const collectLocal = (n) => {
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) local.add(n.name.text)
    else if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name && ts.isIdentifier(n.name)) local.add(n.name.text)
    else if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) local.add(n.variableDeclaration.name.text)
    ts.forEachChild(n, collectLocal)
  }
  if (body) {
    collectLocal(body)
    const visit = (n) => {
      if (ts.isIdentifier(n)) {
        const p = n.parent
        const skip = (p && ts.isPropertyAccessExpression(p) && p.name === n) || (p && ts.isPropertyAssignment(p) && p.name === n) ||
          (p && (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p))) ||
          n.text === selfName || local.has(n.text)
        if (!skip) out.add(n.text)
      }
      ts.forEachChild(n, visit)
    }
    visit(body)
  }
  return out
}

/* ───────────────────────────── 2. 分组判定 ───────────────────────────── */

const isUiSite = (rel) => /(^|\/)ui\//.test(rel) || rel.endsWith('.tsx')
/** 半区口径**抄** code-inventory.mjs:142（`lib/`=host、`src|surfaces|components/`=client、其余 other）——
 *  两半不共享运行时（各自的 bundle 分开构建），所以"同体但跨半区"的一对**并不成一份**，
 *  这是上一版判据的一个漏判：`sleep` 曾把 `forge-notify/lib/index.js` 与 `forge-pm/src/...ts` 报成可并。 */
const halfOfSite = (rel) => (/(^|\/)lib\//.test(rel) ? 'host' : /(^|\/)(src|surfaces|components)\//.test(rel) ? 'client' : 'other')

/** 一组同名 ⇒ {verdict, subsets, blockers}。纯函数：输入已解析好的条目，自检靠它（故意不 export —— 见 K10b/Z2） */
function judgeGroup(name, items) {
  const byBody = new Map()
  for (const it of items) {
    const k = normBody(it.body)
    if (k === null) continue
    if (!byBody.has(k)) byBody.set(k, [])
    byBody.get(k).push(it)
  }
  const pairs = [...byBody.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length)
  const sites = items.map((i) => i.site)
  const ui = items.some((i) => isUiSite(i.rel))
  if (!pairs.length) return { name, verdict: 'no-identical', n: sites.length, sites, ui, subsets: [], blockers: {} }
  const blockers = {}
  for (const [, grp] of pairs) for (const it of grp) {
    const need = [...freeIdsInBody(it.bodyNode, name)].filter((id) => it.bindings.has(id))
    if (need.length) blockers[it.site] = need.sort()
  }
  const subsets = pairs.map(([k, grp]) => {
    const halves = [...new Set(grp.map((it) => it.half))].sort()
    const pkgs = [...new Set(grp.map((it) => it.pkg))].sort()
    return {
      sites: grp.map((it) => it.site).sort(), hash: k.slice(0, 40),
      halves, pkgs, crossHalf: halves.length > 1, samePkg: pkgs.length === 1,
      blocked: grp.some((it) => blockers[it.site]),
    }
  })
  const cleanSameHalf = subsets.filter((s) => !s.blocked && !s.crossHalf)
  const cleanAny = subsets.filter((s) => !s.blocked)
  return {
    name, n: sites.length, sites, ui, blockers, subsets,
    verdict: cleanSameHalf.length ? 'mergeable' : cleanAny.length ? 'cross-half' : subsets.some((s) => s.blocked) ? 'closure-bound' : 'no-identical',
  }
}

function buildScreen(dup) {
  const groups = [], misses = []
  for (const g of dup.sameNameImpl) {
    const items = []
    for (const site of g.sites) {
      const idx = site.lastIndexOf(':')
      const rel = site.slice(0, idx), line = Number(site.slice(idx + 1))
      const sf = sourceOf(rel)
      if (!sf) { misses.push(site + '（文件不在）'); continue }
      const decl = locateDecl(sf, g.name, line)
      if (!decl) { misses.push(site + '（声明定位不到 ⇒ dup-detail.json 过期）'); continue }
      items.push({ site, rel, line, pkg: rel.split('/')[0], half: halfOfSite(rel), body: bodyText(sf, decl), bodyNode: decl.body, bindings: moduleBindings(sf) })
    }
    if (items.length >= 2) groups.push(judgeGroup(g.name, items))
  }
  const num = (pred) => groups.filter(pred).length
  const sites = (pred) => groups.filter(pred).reduce((s, g) => s + g.sites.length, 0)
  groups.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    tool: 'k6a-screen.mjs', source: 'scripts/baseline/dup-detail.json（= 度量 D2 的同一份数组）',
    note: 'K6a 还账点名清单。**组数恒等于 D2**（--check 核这条）：本文件只加"动得了动不了"的第二层判断。' +
      'mergeable = 存在 ≥2 份逐字节同体、这些同体都不引用本文件的模块级绑定、且**都在同一半区**；cross-half = 有同体但分属 host(`lib/`) 与 client(`src/`) 两半 —— 两半各自打包、不共享运行时 ⇒ 并不成一份（要么先解决共享层的构建布局，那是 ISS-715 甲案的对象）；closure-bound = 有同体但被本模块单例/表/helper 绑住（blockers 点名是谁）；' +
      'no-identical = 无同体（走 K6b：下沉内核 / 并入既有件 / 留一行"为什么不并"）；ui = 该组含 src/**/ui/ 或 .tsx 站点，**归 ISS-694 老板目测批**，不算"我能自己并"的那批。' +
      '⚠️ mergeable 只等于"技术上无阻塞"，并到哪一包仍按 docs/code.md §5 与架构基准「新代码该放哪」定；本表不判该不该并。',
    totals: {
      groups: groups.length,
      mergeable: num((g) => g.verdict === 'mergeable'),
      mergeableSites: sites((g) => g.verdict === 'mergeable'),
      mergeableNonUi: num((g) => g.verdict === 'mergeable' && !g.ui),
      mergeableNonUiSites: sites((g) => g.verdict === 'mergeable' && !g.ui),
      mergeableSamePkg: num((g) => g.verdict === 'mergeable' && g.subsets.some((s) => s.samePkg && !s.blocked && !s.crossHalf)),
      crossHalf: num((g) => g.verdict === 'cross-half'),
      crossHalfSites: sites((g) => g.verdict === 'cross-half'),
      closureBound: num((g) => g.verdict === 'closure-bound'),
      closureSites: sites((g) => g.verdict === 'closure-bound'),
      noIdentical: num((g) => g.verdict === 'no-identical'),
      noIdenticalSites: sites((g) => g.verdict === 'no-identical'),
      uiGroups: num((g) => g.ui),
      uiSites: sites((g) => g.ui),
      locateMisses: misses.length,
    },
    groups: groups.map((g) => ({ name: g.name, verdict: g.verdict, ui: !!g.ui, n: g.n, sites: g.sites, subsets: g.subsets, blockers: g.blockers })),
    misses,
  }
}

/* ───────────────────────────── 3. 自检（临时文件写 os.tmpdir，不进盘点射程） ───────────────────────────── */

function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k6a-screen-'))
  let bad = 0
  const t = (n, ok) => { console.log(`${ok ? '✓' : '✗'} ${n}`); if (!ok) bad++ }
  const item = (tag, code, name, line) => {
    const abs = path.join(dir, tag)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, code)
    const sf = ts.createSourceFile(abs, code, ts.ScriptTarget.Latest, true)
    const decl = locateDecl(sf, name, line)
    return { site: tag + ':' + line, rel: tag, line, pkg: tag.split('/')[0], half: halfOfSite(tag), body: bodyText(sf, decl), bodyNode: decl?.body, bindings: moduleBindings(sf) }
  }
  const a = item('a.js', 'export function helper(x) { return x + 1 }\n', 'helper', 1)
  const b = item('b.js', 'function helper(x) { return x + 1 }\nexport { helper }\n', 'helper', 1)
  t('① 两份同体、体内无本模块绑定 ⇒ mergeable', judgeGroup('helper', [a, b]).verdict === 'mergeable')
  // 闭包档必须拿**同体的两份**测：没有同体就轮不到闭包判断（那组直接归 no-identical）
  const c = item('c.js', 'const TABLE = { a: 1 }\nexport function helper(x) { return TABLE[x] }\n', 'helper', 2)
  const d2 = item('d2.js', 'const TABLE = { a: 1 }\nfunction helper(x) { return TABLE[x] }\nexport { helper }\n', 'helper', 2)
  const g2 = judgeGroup('helper', [c, d2])
  t('② 同体两份都引用本文件模块级 const ⇒ closure-bound 且逐处点名 TABLE', g2.verdict === 'closure-bound' && (g2.blockers[c.site] || []).join() === 'TABLE' && (g2.blockers[d2.site] || []).join() === 'TABLE')
  const r1 = item('r1.js', 'function helper(x) { return x > 0 ? helper(x - 1) : 0 }\nexport { helper }\n', 'helper', 1)
  const r2 = item('r2.js', 'function helper(x) { return x > 0 ? helper(x - 1) : 0 }\nexport { helper }\n', 'helper', 1)
  t('③ 同体的具名递归 ⇒ 自名不算闭包，仍 mergeable（09-22 的 forEachChild 陷阱）', judgeGroup('helper', [r1, r2]).verdict === 'mergeable')
  const e = item('e.js', 'export const statusColor = (s) => COLORS[s] ?? "gray"\n', 'statusColor', 1)
  t('④ 无大括号的单行箭头也取到体（配平吞体的回归）', typeof normBody(e.body) === 'string' && normBody(e.body).startsWith('COLORS'))
  const f2 = item('f.js', 'export function helper(x) { return x + 2 }\n', 'helper', 1)
  t('⑤ 变异对照：一个字符之差 ⇒ no-identical（不许报同体）', judgeGroup('helper', [a, f2]).verdict === 'no-identical')
  const ua = item('p/ui/row.tsx', 'export const Row = (props) => <div>{props.x}</div>\n', 'Row', 1)
  const ub = item('q/ui/row.tsx', 'export const Row = (props) => <div>{props.x}</div>\n', 'Row', 1)
  const g4 = judgeGroup('Row', [ua, ub])
  t('⑥ .tsx / ui/ 站点 ⇒ 归 UI 家族（ISS-694 批）', g4.ui === true && g4.verdict === 'mergeable')
  const g5 = judgeGroup('helper', [a, b, c, d2])
  t('⑦ 同组里"干净的一对 + 带闭包的一对"并存 ⇒ mergeable，但 blockers 仍逐处点名', g5.verdict === 'mergeable' && !!g5.blockers[c.site] && !g5.blockers[a.site] && g5.subsets.length === 2)
  // ⑧ 跨半区：两半各自打包、不共享运行时 ⇒ 同体也并不成一份（上一版把这判成"可并"，是漏判）
  const h1 = item('x/lib/sleep.js', 'function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }\nexport { sleep }\n', 'sleep', 1)
  const h2 = item('x/src/sleep.ts', 'function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }\nexport { sleep }\n', 'sleep', 1)
  const g6 = judgeGroup('sleep', [h1, h2])
  t('⑧ 同体但一份在 lib/ 一份在 src/ ⇒ cross-half（不算可并，附理由）', g6.verdict === 'cross-half' && g6.subsets[0].crossHalf === true)
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`k6a-screen selftest ${8 - bad}/8 通过`)
  return bad ? 2 : 0
}
if (A.includes('--selftest')) process.exit(selftest())

if (!fs.existsSync(DUP)) { console.error('✗ 没有 scripts/baseline/dup-detail.json（先跑 code-inventory --write-dup-detail）'); process.exit(2) }
const dup = JSON.parse(fs.readFileSync(DUP, 'utf8'))
const art = buildScreen(dup)
const txt = JSON.stringify(art, null, 1) + '\n'
const fmt = (k) => `  ${k.padEnd(20)} ${JSON.stringify(art.totals[k])}`

if (A.includes('--write')) {
  fs.writeFileSync(OUT, txt)
  console.log(`✓ 已写 ${path.relative(ROOT, OUT)}（${art.totals.groups} 组 = D2）`)
  console.log(Object.keys(art.totals).map(fmt).join('\n'))
  process.exit(0)
}

if (A.includes('--check')) {
  const errs = []
  if (art.totals.groups !== dup.totals.sameNameImpl) errs.push(`组数 ${art.totals.groups} ≠ D2 ${dup.totals.sameNameImpl}（本脚本只加第二层判断，不许改组）`)
  if (art.totals.locateMisses) errs.push(`${art.totals.locateMisses} 个站点定位不到声明 ⇒ dup-detail.json 过期，随复录一起重生成`)
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null
  if (prev !== null && prev !== txt) errs.push('已落盘的 k6a-screen.json 与本次现算不一致 ⇒ 要么该 --write，要么判据不可复算')
  if (errs.length) { console.log('✗ k6a-screen 判据核不过'); for (const e of errs) console.log('   · ' + e); process.exit(2) }
  console.log(`✓ k6a-screen 与 D2 同源且可复算（${art.totals.groups} 组 · 站点全部定位成功）`)
  process.exit(0)
}

console.log(`K6a 还账点名 · ${art.totals.groups} 组（= D2）`)
for (const k of ['mergeable', 'mergeableSites', 'mergeableNonUi', 'mergeableSamePkg', 'crossHalf', 'closureBound', 'noIdentical', 'uiGroups', 'uiSites']) console.log(fmt(k))
if (VERBOSE) {
  for (const g of art.groups.filter((x) => x.verdict === 'mergeable' && !x.ui)) console.log(`  可并·非UI  ${g.name} ×${g.n} ⇒ ${g.subsets.filter((s) => !s.blocked && !s.crossHalf).map((s) => s.sites.join(' ')).join(' | ')}`)
  for (const g of art.groups.filter((x) => x.verdict === 'cross-half')) console.log(`  跨半区    ${g.name} ×${g.n} ⇒ ${g.subsets.map((s) => s.sites.join(' ')).join(' | ')}`)
  for (const g of art.groups.filter((x) => x.verdict === 'closure-bound')) console.log(`  闭包绑定  ${g.name} ×${g.n} ⇒ ${Object.entries(g.blockers).map(([s, ids]) => `${s}:${ids.join(',')}`).join(' ')}`)
}
console.log('\n⚠️ mergeable 只等于"技术上无阻塞且同半区"；并到哪一包按 docs/code.md §5 定，ui 那一档归 ISS-694（老板逐批目测）')
