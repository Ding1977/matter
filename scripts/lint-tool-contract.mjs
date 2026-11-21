#!/usr/bin/env node
// scripts/lint-tool-contract.mjs
// 给两条老铁律装上牙（PRJ-016 / ISS-736）：
//   TC1 · React hooks 数量恒定 —— `docs/project-code-rules.md` §1 铁律 4：分支里调 hook ⇒ 两次渲染的 hook 序号错位，
//         React #310 崩（ISS-183 M1 实测过崩相）。此前**只有文档、没有任何机器判据**。
//   （工具名字符集那一半由 `code-inventory` 的度量 `C3` 供数 ⇒ 只需接进 `lint-code` 的规则号，本脚本不重复实现。）
//
// 为什么不塞进 `code-inventory.mjs`：那份已 998 行，贴着 K2a 的 ≥1000 god module 红线（ISS-733 实测红过一次）
//   ⇒ 新判据一律外置。**hook 名口径与 code-inventory 一致（/^use[A-Z]/）**，改口径要两边一起改（这里指认源头，不另立定义）。
//
// 判据边界（误伤一片 = 门禁形同虚设）：
//   · 只算「可能被跳过的控制流」里的 hook 调用：if / 三元 / 循环 / try / switch / `&&` `||` `??` 短路；
//   · collectHooks **不跨函数边界**：`useEffect(() => { if (x) ... })` 回调里的事属于另一个函数体，
//     不影响本组件两次渲染的 hook 序号 ⇒ 不算违例（selftest 里钉死）；
//   · 测试文件（*.test.* / *.spec.*）与 *.stories.* 一律豁免。
//
// 用法：node scripts/lint-tool-contract.mjs [--check|--write|--json|--verbose|--selftest]
//   退出码：0 = 不超上限 · 1 = 超上限 / 缺基线 / 无可扫文件 · 2 = 拿不到 typescript
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE = path.join(ROOT, 'scripts', 'baseline', 'tool-contract.json')
const ARGV = process.argv.slice(2)
const relOf = (p) => path.relative(ROOT, p).split(path.sep).join('/')

const isHook = (name) => /^use[A-Z]/.test(String(name).split('.').pop())
const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'build', '.git', '.wt', '.tmp', 'static', 'mockups', 'vendor', 'coverage', 'preview', 'assets', 'public'])
const EXEMPT = /(\.test\.|\.spec\.|\.stories\.)/
/**
 * 非手写的产物一律不判：`*.min.js` 与超过 4000 行的单文件（实测本仓最大的命中源是
 * `forge-canvas/scripts/demo-ui.js` —— 1.9 MB 的 esbuild 包（开头就是 `var __create = Object.create`），
 * 33 处命中里 30 处来自这种包 ⇒ 不排掉的话门禁信号 100% 是噪声。
 * 这种产物该不该进 git 是另一件事（已另记），**不在本判据里顺手治**。
 */
const BUNDLE_RE = /\.min\.(js|jsx|ts|tsx)$/
const MAX_HANDWRITTEN_LINES = 4000

function loadTypeScript() {
  for (const c of ['forge-ui/node_modules/typescript', 'forge-pm/node_modules/typescript', 'node_modules/typescript']) {
    const abs = path.join(ROOT, c)
    if (!fs.existsSync(abs)) continue
    try { return createRequire(path.join(abs, 'package.json'))('typescript') } catch { /* 换下一个候选 */ }
  }
  console.error('✗ 找不到 typescript 编译器 —— 本门禁拒绝降级成正则凑的口径')
  process.exit(2)
}

function walkFiles(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) walkFiles(p, acc) }
    else if (/\.(tsx|ts|jsx|js)$/.test(e.name) && !EXEMPT.test(e.name)) acc.push(p)
  }
  return acc
}

/**
 * 核心判据：给一份源码，返回「在可跳过分支的控制流里调用 hook」的命中点。
 * 纯函数（不读盘、不打印）⇒ selftest 可以直接喂字符串构造场景。
 * 故意不加 export：本仓把〔没人 import 的导出〕本身当度量（Z2），自检在同文件里直接调即可。
 * @returns {{rel:string,line:number,hook:string,ctx:string}[]}
 */
function findConditionalHooks(ts, rel, source) {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, /\.tsx?$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX)
  const hits = []
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const SK = ts.SyntaxKind
  const SKIPPABLE = new Set([SK.IfStatement, SK.ConditionalExpression, SK.ForStatement, SK.ForOfStatement, SK.ForInStatement,
    SK.WhileStatement, SK.DoStatement, SK.TryStatement, SK.SwitchStatement, SK.BinaryExpression])
  const SHORT = new Set([SK.AmpersandAmpersandToken, SK.BarBarToken, SK.QuestionQuestionToken])
  const isSkippable = (n) => SKIPPABLE.has(n.kind) && (!ts.isBinaryExpression(n) || SHORT.has(n.operatorToken.kind))
  const isFnBoundary = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isClassDeclaration(n)
  const ctxName = (n) => (ts.isConditionalExpression(n) ? '三元' : n.kind === SK.IfStatement ? 'if' : ts.isBinaryExpression(n) ? '短路'
    : n.kind === SK.TryStatement ? 'try' : n.kind === SK.SwitchStatement ? 'switch' : '循环')

  /** 在一棵子树里找 hook 调用；遇到嵌套函数就停（那是另一个函数体） */
  const collectHooks = (node, ctx) => {
    const stack = [node]
    while (stack.length) {
      const n = stack.pop()
      if (n !== node && isFnBoundary(n)) continue
      if (ts.isCallExpression(n)) {
        const nm = n.expression.getText(sf)
        if (isHook(nm)) hits.push({ rel, line: lineOf(n), hook: nm.split('.').pop(), ctx })
      }
      ts.forEachChild(n, (c) => { stack.push(c) }) // 回调必须返回 undefined，否则 TS 停止遍历子树
    }
  }
  const visit = (n) => {
    if (isSkippable(n)) collectHooks(n, ctxName(n))
    ts.forEachChild(n, visit) // 组件本体就是函数 ⇒ 这里必须穿过函数边界，〔不跨越〕只体现在 collectHooks 里
  }
  ts.forEachChild(sf, visit)
  return hits.sort((a, b) => a.line - b.line || a.hook.localeCompare(b.hook))
}

/* ───────────── selftest：五类可跳过分支都要能红，两类合规不能误伤 ───────────── */
function selftest() {
  const ts = loadTypeScript()
  const cases = []
  const push = (n, ok, note = '') => cases.push({ n, ok: !!ok, note })
  const scan = (src) => findConditionalHooks(ts, 'fixture.tsx', src)
  const fx = {
    if红: 'function C({a}){ if(a){ const [x]=useState(0); return <b>{x}{a}</b> } return <b>1</b> }',
    循环红: 'function C({a}){ for(let i=0;i<a;i++){ const v=useMemo(()=>a,[a]); } return <b>{v}</b> }',
    短路红: 'function C({a}){ const x=a&&useFlag(); return <b>{x}</b> }',
    三元红: 'function C({a}){ const x=a?useA():useB(); return <b>{x}</b> }',
    try红: 'function C({a}){ try{ useCtx() }catch(e){ } return <b>{a}</b> }',
    回调绿: 'function C({a}){ useEffect(()=>{ if(a){ console.log(1) } },[a]); const [x,setX]=useState(0); return <b onClick={()=>setX(1)}>{x}</b> }',
    顶层绿: 'function C({a}){ const [x]=useState(0); const y=useMemo(()=>x*2,[x]); return <b>{y}{a}</b> }',
    非hook绿: 'function C({a}){ if(a){ doThing() } return <b>{a}</b> }',
  }
  push('if 分支里调 hook 判红', scan(fx.if红).some((h) => h.hook === 'useState'))
  push('循环里调 hook 判红', scan(fx.循环红).some((h) => h.hook === 'useMemo'))
  push('短路表达式里调 hook 判红', scan(fx.短路红).some((h) => h.hook === 'useFlag'))
  push('三元两个分支都判红', scan(fx.三元红).filter((h) => /^use[AB]$/.test(h.hook)).length === 2)
  push('try 里调 hook 判红', scan(fx.try红).some((h) => h.hook === 'useCtx'))
  const green = scan(fx.回调绿)
  push('回调内的条件不误伤（不跨函数边界）', green.length === 0, JSON.stringify(green))
  push('合规组件 0 命中', scan(fx.顶层绿).length === 0)
  push('非 hook 调用不算（doThing 不是 useThing）', scan(fx.非hook绿).length === 0)
  push('同输入两次跑逐字节一致（可复算）', JSON.stringify(scan(fx.短路红)) === JSON.stringify(scan(fx.短路红)))
  let bad = 0
  console.log('lint-tool-contract --selftest（内建 fixture，不扫真实仓库）')
  for (const c of cases) { console.log(`  ${c.ok ? '✓' : '✗'} ${c.n}${c.note ? '（' + c.note + '）' : ''}`); if (!c.ok) bad++ }
  console.log(bad ? `\n✗ 反向验证失败 ${bad}/${cases.length} —— 门禁没牙或误伤，别接进 guard` : `\n✓ ${cases.length}/${cases.length} 项通过：五类可跳过分支都判红、跨函数边界与合规组件不误伤`)
  return bad ? 1 : 0
}
if (ARGV.includes('--selftest')) process.exit(selftest())

/* ───────────────────────── 扫描与门禁 ───────────────────────── */
const ts = loadTypeScript()
const hits = []
/** 被当产物排除的文件（要打印出来：静默排除 = 门禁看不见东西，与〔判不了当 0〕同一种错） */
const skippedBundle = []
let scanned = 0
for (const pkg of fs.readdirSync(ROOT)) {
  if (!/^forge-/.test(pkg) || !fs.existsSync(path.join(ROOT, pkg))) continue
  for (const f of walkFiles(path.join(ROOT, pkg), [])) {
    scanned++
    let src
    try { src = fs.readFileSync(f, 'utf8') } catch { continue }
    if (BUNDLE_RE.test(f) || src.split('\n').length > MAX_HANDWRITTEN_LINES) { skippedBundle.push(relOf(f)); continue }
    for (const h of findConditionalHooks(ts, relOf(f), src)) hits.push(h)
  }
}
const byRule = { TC1: hits.length }
if (scanned === 0) { console.error('✗ 一个文件都没扫到 —— 判不了，不当 0'); process.exit(1) }
const readCaps = () => (fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')).ceilings || {} : {})

if (ARGV.includes('--write')) {
  const prev = readCaps()
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify({
    recordedAt: new Date().toISOString().slice(0, 10),
    tool: 'lint-tool-contract.mjs --write',
    note: 'TC1 = 可跳过分支里调 hook 的处数。棘轮：只许降不许升（新增即红）。存量清零归各业务批次，不在本门禁里顺手改渲染逻辑。'
      + ' 存量原为三处（forge-ui 的 home / register / global-search）同一形态：注入式 hook prop —— props.useSessionPendingInteraction'
      + ' ? props.useSessionPendingInteraction(...) : undefined，是刻意的依赖注入接缝（同文件注释里记过它引发的真实缺陷）。'
      + ' ⚠️ ISS-566 起存量清零（home 于 ISS-565 删、register 那处随帧删、global-search 于 ISS-566 删）⇒ TC1 实测 0。'
      + ' 两条路里选了〔记进棘轮 + 点名〕，**没有把判据窄化成只认裸标识符调用**：窄化就等于让这类〔条件里调 hook〕从此隐形。',
    ceilings: byRule,
  }, null, 1) + '\n')
  const changed = Object.keys(byRule).filter((k) => prev[k] !== byRule[k]).map((k) => `${k} ${prev[k]}→${byRule[k]}`).join(' ')
  console.log(`✓ 已录 TC1 = ${byRule.TC1}（变化 ${changed || '无'}）`)
  console.log('  ⚠️ 把上限调高 = 承认可以继续新增，必须在提交说明里写理由')
  process.exit(0)
}
const caps = readCaps()
const over = []
for (const k of Object.keys(byRule)) {
  if (caps[k] === undefined) over.push(`${k} 无基线记录（先跑 --write；缺基线不等于免检）`)
  else if (byRule[k] > caps[k]) over.push(`${k} 超上限 ${caps[k]} → ${byRule[k]}`)
}
console.log(`lint-tool-contract · 扫 ${scanned - skippedBundle.length} 文件（另排除产物 ${skippedBundle.length} 个）· TC1（条件里调 hook）命中 ${hits.length}${caps.TC1 !== undefined ? ` / 上限 ${caps.TC1}` : ' / 无基线'}`)
if (ARGV.includes('--verbose') && skippedBundle.length) for (const f of skippedBundle) console.log(`  ⊘ 排除产物 ${f}（>4000 行或 *.min.*）`)
for (const h of (ARGV.includes('--verbose') || ARGV.includes('--json') ? hits : hits.slice(0, 10))) console.log(`  · ${h.rel}:${h.line} ${h.hook}（${h.ctx}）`)
if (ARGV.includes('--json')) console.log(JSON.stringify({ hits, ceilings: caps }, null, 1))
if (over.length) { for (const o of over) console.log(`✗ ${o}`); process.exit(1) }
console.log(hits.length ? `\n⚠️ 存量 ${hits.length} 处（棘轮只拦新增；清零归各自批次）` : '\n✓ 零命中')
process.exit(0)
