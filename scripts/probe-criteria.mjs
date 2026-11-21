#!/usr/bin/env node
// scripts/probe-criteria.mjs（ISS-709 产出物 · 复用工具，不是门禁）
//
// 用途：**度量判据的变异验证**。回答一个问题：
//   「这条判据数出来的数，是因为真的没有，还是因为探测器坏了？」
//
// 为什么需要它（两条真实事故，都是「探测器和它声称的判据对不上」）：
//   ① K9a（`code-inventory.mjs:477` 旧写法）：`/(^|\.)exit$/ && /process$/`
//      —— 两个互斥的结尾断言，结构上不可能同时成立 ⇒ E6 恒 0 ⇒ 零容忍规则从上线起没响过。
//   ② `code-inventory.mjs:552` fsWrites：判据挂在 `ts.isNewExpression` 上，
//      而写盘是**调用**不是 new ⇒ 该分支恒不可达（全仓 `new fs.writeFileSync` 0 处）。
//   共同点：**正则本身看着没错**，错在「正则挂错了节点」或「两个谓词互相排斥」。
//   ⇒ 只测「正则 vs 字符串」抓不到 ②，必须**按判据挂载的 AST 节点类型跑样例**。
//
// 三层验法（少一层就会漏）：
//   L1 正则层：正则 vs 它声称要匹配的字符串 —— 抓「结构上不可能」
//   L2 挂载层：按判据**实际挂的节点类型**构造样例跑 —— 抓「挂错分支」（:552 就是这层抓到的）
//   L3 对照组：拿一个更宽的"真判据"当 ground truth，比对差值 —— 抓「口径过窄」（:554 漏 134 处是这层抓到的）
//
// ⚠️ 本文件是**诊断探针**，不进任何门禁、不改任何度量、不写盘。
//    改判据请改 `code-inventory.mjs` 本体；本文件只负责证明改完之后判据**真的有牙**。
//
// 用法：
//   node scripts/probe-criteria.mjs              # 跑内置样例集（K9a + fsWrites + 同族调用判据）
//   node scripts/probe-criteria.mjs --k9a        # 只跑 K9a
//   node scripts/probe-criteria.mjs --fswrites   # 只跑 fsWrites
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..'), A = process.argv.slice(2)

/** 借仓库里已有的 typescript（不新增依赖）。候选顺序与 code-inventory.mjs 的 loadTs() 一致。 */
function loadTs() {
  for (const c of ['forge-ui/node_modules/typescript', 'forge-pm/node_modules/typescript', 'node_modules/typescript']) {
    const abs = path.join(ROOT, c)
    try { return createRequire(path.join(abs, 'package.json'))('typescript') } catch { /* 换下一个候选 */ }
  }
  console.error('✗ 找不到 typescript 编译器（试过 forge-ui / forge-pm / root 的 node_modules）')
  process.exit(2)
}
const ts = loadTs()

const parse = (code) => ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

/** L2：按**判据实际挂载的节点类型**遍历，返回命中的文本 —— 这是 `:552` 能被抓到的关键一层。 */
function collectByMount(code, mount, match) {
  const sf = parse(code)
  const hits = []
  const visit = (node) => {
    const isMount =
      (mount === 'new' && ts.isNewExpression(node)) ||
      (mount === 'call' && ts.isCallExpression(node)) ||
      (mount === 'propAccess' && ts.isPropertyAccessExpression(node)) ||
      (mount === 'anyCallLike' && (ts.isCallExpression(node) || ts.isNewExpression(node)))
    if (isMount) {
      const txt = ts.isNewExpression(node) || ts.isCallExpression(node) ? node.expression.getText(sf) : node.name.getText(sf)
      if (match(txt)) hits.push(txt)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

/** 一组 L2/L3 断言：正样本必须命中、反样本必须不命中。返回坏掉的条目。 */
function runGroup(title, mount, match, positives, negatives) {
  const bad = []
  for (const s of positives) {
    const h = collectByMount(s, mount, match)
    if (!h.length) bad.push({ kind: '漏报（该中不中）', sample: s, got: h })
  }
  for (const s of negatives) {
    const h = collectByMount(s, mount, match)
    if (h.length) bad.push({ kind: '误报（不该中却中）', sample: s, got: h })
  }
  console.log(`  ${bad.length ? '✗ 坏' : '✓'} ${title}（挂载点=${mount}）`)
  for (const b of bad) console.log(`      ${b.kind}: ${JSON.stringify(b.sample)} → 命中 ${JSON.stringify(b.got)}`)
  return bad
}

/* ───────────── K9a / E6：process.exit 判据 ───────────── */
function probeK9a() {
  console.log('\n[K9a / E6] process.exit')
  const GOOD = /(?:^|\.)process\.exit$/
  const OLD = (nm) => /(^|\.)exit$/.test(nm) && /process$/.test(nm)
  const bad = runGroup(
    '现判据：最后两段恰为 process.exit',
    'call', (t) => GOOD.test(t),
    ['process.exit(1)', 'process.exit(r.code)', 'globalThis.process.exit(0)', 'global.process.exit(0)'],
    ['exit()', 'myexit()', 'myprocess.exit(0)', 'proc.exit(0)', 'process.exitCode = 1', 'const s = "process.exit(1)"', '// process.exit(1)'],
  )
  // L1：证明旧谓词恒假 —— 这是缺陷本体，必须留证
  const oldHits = ['process.exit', 'globalThis.process.exit', 'exit', 'process'].filter(OLD).length
  console.log(`  ${oldHits === 0 ? '✓' : '✗'} 旧判据对 4 个样例同时成立数 = ${oldHits}（0 才说明它恒假）`)
  if (oldHits !== 0) bad.push({ kind: '旧判据非恒假', sample: '4 样本', got: oldHits })
  return bad
}

/* ───────────── fsWrites / C7b：写盘判据 ───────────── */
function probeFsWrites() {
  console.log('\n[fsWrites / C7b] 写盘调用')
  const RE = /(writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|writeFile|appendFile|openSync)$/
  const bad = []
  // ⚠️ L2 的核心：同一个正则，挂 new 与挂 call 结果完全不同
  const real = 'fs.writeFileSync("/a","x")'
  const onCall = collectByMount(real, 'call', (t) => RE.test(t)).length
  const onNew = collectByMount(real, 'new', (t) => RE.test(t)).length
  console.log(`  ${onCall === 1 ? '✓' : '✗'} 真写盘调用在 call 分支命中 = ${onCall}`)
  console.log(`  ${onNew === 0 ? '✓' : '✗'} 同一调用在 new 分支命中 = ${onNew}（:552 挂在 new 上 ⇒ 恒不可达）`)
  if (onCall !== 1 || onNew !== 0) bad.push({ kind: '挂载点判据异常', sample: real, got: { onCall, onNew } })

  // L3 对照组：**完整判据（挂 call）** vs **`:554` 现判据（挂 propAccess + node.name.text）**
  //   ⚠️ 这一层必须逐字复刻现判据，否则测的是"我以为的判据"而不是"真的判据"。
  const wide = [
    'fs.writeFileSync("/a","x")',
    'writeFileSync("/a","x")',            // 裸标识符 —— :554 漏掉的那一类
    'await fs.promises.writeFile("/a",cb)',
    'appendFileSync("/a","x")',
  ]
  const fullOnCall = (code) => collectByMount(code, 'call', (t) => RE.test(t)).length
  // :554 的真实形状：只在 PropertyAccessExpression 且 node.name.text 命中时计数
  const asWritten554 = (code) => {
    const sf = parse(code)
    let n = 0
    const visit = (node) => {
      if (ts.isCallExpression(node) === false && ts.isPropertyAccessExpression(node) && RE.test(node.name.text)) n++
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return n
  }
  const miss = wide.filter((s) => fullOnCall(s) > 0 && asWritten554(s) === 0)
  console.log(`  ${miss.length ? '✗' : '✓'} 对照组：完整判据覆盖 ${wide.filter((s) => fullOnCall(s) > 0).length}/${wide.length}，现判据(:554) 漏 ${miss.length} 类`)
  for (const s of miss) console.log(`      现判据漏: ${JSON.stringify(s)}`)
  if (miss.length) bad.push({ kind: ':554 口径过窄（漏裸标识符调用）', sample: 'wide 组', got: `${miss.length} 类漏` })
  return bad
}

/* ───────────── 同族调用判据（code-inventory.mjs 里同处一室的那些） ───────────── */
function probeFamily() {
  console.log('\n[同族判据] 调用表达式上的其余计数器')
  const bad = []
  bad.push(...runGroup(':475 consoles', 'call', (t) => /^console\.(log|warn|error|info|debug|trace|table|dir)$/.test(t),
    ['console.log("x")', 'console.error("e")'], ['myconsole.log("x")', 'console.logger("x")']))
  bad.push(...runGroup(':476 logger', 'call', (t) => /logger\s*\.\s*(info|warn|error|debug|trace|fatal)/.test(t),
    ['logger.info("x")', 'this.logger.error("e")'], ['log.info("x")']))
  bad.push(...runGroup(':479 zodObject', 'call', (t) => /^(z\.)?object$/.test(t),
    ['z.object({})', 'object({})'], ['myObj.object({})', 'z.objectlike({})']))
  bad.push(...runGroup(':480 require', 'call', (t) => /require$/.test(t),
    ['require("m")'], ['requireX("m")']))
  bad.push(...runGroup(':484 fetch', 'call', (t) => /\bfetch$/.test(t),
    ['fetch("u")', 'window.fetch("u")'], ['fetchx("u")', 'prefetch("u")']))
  bad.push(...runGroup(':485 slots', 'call', (t) => /slots\.register$|surfaces\.register$|registerSurface$/.test(t),
    ['ctx.slots.register("a",x)', 'ctx.surfaces.register("a",x)', 'registerSurface("a",x)'], ['slots.registerX("a")']))
  bad.push(...runGroup(':489 storageDomain', 'call', (t) => /storage\s*\.\s*domain$/.test(t),
    ['ctx.storage.domain("a")'], ['storage.domainX("a")']))
  bad.push(...runGroup(':490 systemPrompt', 'call', (t) => /systemPrompt\s*\.\s*(section|context|variable)$/.test(t),
    ['ctx.systemPrompt.section({})'], ['systemPrompt.sectionX({})']))
  bad.push(...runGroup(':494 defineTool', 'call', (t) => /defineTool$/.test(t),
    ['defineTool({name:"x"})', 'ctx.defineTool({})'], ['defineToolX({})']))
  return bad
}

/* ───────────── 主入口 ───────────── */
const only = A.find((a) => /^--(k9a|fswrites|family)$/.test(a))
if (A.includes('--help') || A.includes('-h')) {
  console.log('用法：node scripts/probe-criteria.mjs [--k9a|--fswrites|--family]')
  process.exit(0)
}

console.log('度量判据变异验证（ISS-709）—— 三层：L1 正则 / L2 挂载点 / L3 对照组')
let bad = []
if (!only || only === '--k9a') bad = bad.concat(probeK9a())
if (!only || only === '--fswrites') bad = bad.concat(probeFsWrites())
if (!only || only === '--family') bad = bad.concat(probeFamily())

console.log('')
if (bad.length) {
  console.log(`✗ ${bad.length} 处不达标 —— 判据与它声称要数的东西对不上`)
  process.exit(1)
}
console.log('✓ 全部通过：正样本必中、反样本不中、挂载点可达')
