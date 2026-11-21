#!/usr/bin/env node
/* 跨包 window 事件守卫（ISS-571 · 风险册 R36，R33 的孪生）
 *
 * 一句话判据：**一个 window 事件名，派发方与监听方必须两端齐全；只剩一方 = 静默死路 = 红。**
 *
 * 为什么要立这条（本单的现场，五条死路全同形）：
 *   · `forge:open-pm-doc` 4 处派发 / 0 处监听 —— 连注释都自认「事件无监听方」，可它挂了很久，
 *     没有任何门禁会红，因为**少一半的东西编译得过、跑得动、测试也全绿**；
 *   · `forge:open-agent-session` / `forge:notify-deeplink` 是 `forgeNav` 桥缺席时的"兜底"，
 *     而兜底的接收方根本不存在 ⇒ 兜底本身是 no-op（比死路更坏：它让降级路径看起来还在）；
 *   · 反向孤儿 `forge:pm-create-issue`：监听在、派发方 0 —— 触发它的底栏按钮已随 ISS-565 删除。
 *   四种形状同一个病：**契约只说了一半，而没有任何东西会因此报错**（docs/code.md 的守卫纪律）。
 *
 * 判据三档（与 lint-code 同族的「零容忍 / 白名单带理由 / 未解析单列」）：
 *   1. 两端齐全 ⇒ 绿（不登记、不维护：成对出现就自动绿）；
 *   2. 只剩一方 ⇒ **红**，除非登记在 scripts/baseline/cross-pkg-events-whitelist.json，
 *      且**每条必须带理由**（空/占位/过短理由 = 红；照 lint-code 的「白名单必须带理由」先例）；
 *   3. 名字**解析不出来** ⇒ 单列进报告的「未解析」一栏，**并且判红**。
 *      为什么不放过：判不出 = 无法判定 ≠ 通过（本仓"不判不许冒充通过"的纪律）。想让名字可解析，
 *      就写成字符串字面量或简单常量，别用运行时拼出来的名字。
 *
 * 名字解析（`<X>` 支持四形，少一形就会把真事件漏成"没问题"）：
 *   ① 字符串字面量 `'forge:xxx'`；
 *   ② 简单常量 `const X = "forge:xxx"` —— **同文件**，以及**同文件别名**（`const A = B`）；
 *   ③ **import 进来的常量**：相对路径（`./x.ts`）与裸包名（`forge-native`）都解析，
 *      到目标文件的顶层 `const` 里取值（**不要求 export** —— 本仓 forge-native 的 TAB_EVENT 就是包内私有）；
 *   ④ **函数形参的字符串字面量联合类型**：`function f(name: "a" | "b")` ⇒ 两个名字都认
 *      （本仓现役：`activity-stream/items.tsx` 的 `emitAnchorEvent`）；形参默认值字面量同认。
 *   另支持 `as const` / 括号 / 非空断言 / satisfies 的包裹。
 *
 * 判什么、不判什么（边界一律报出来，不许静默当"没问题"）：
 *   · **判**：① 打过 `new CustomEvent(` 的名字；② 带命名空间（含 `:`）的监听名。
 *   · **不判**：其余监听名 = 原生 DOM 事件（`keydown` / `resize` / `pointermove`…）—— 它们天然没有
 *     `CustomEvent` 派发方，判它等于批量造假红。报告里报**计数**与名单，不判红。
 *   · **扫描面**：`forge-<pkg>/{src,lib}` 下的 `.ts/.tsx/.js/.jsx/.mjs`（排除 node_modules/dist/测试文件/
 *     构建产物 `*.generated.*` —— 判据结论不许取决于"这棵树建过没建过"）。
 *     测试文件排除的理由：测试里的 `addEventListener` 全是**替身实现**（形参名当事件名），必然解析不出
 *     ⇒ 整片假红。代价（"只在测试里出现的事件"漏判）如实写在这里，不假装扫全了。
 *   · **接收方必须是字面量 `window`**：`el.addEventListener("click")` / `document.addEventListener(…)`
 *     不是本守卫的对象（元素/文档事件不是跨包契约）。非 window 接收方的调用**计数**在报告里报出来，
 *     免得"没扫到"被读成"没有"。
 *   · `electron-shell` 不在扫描面：那边的 `forge:window-drag` 是 **IPC 通道**（`ipcMain.on`），
 *     不是 window CustomEvent，混进来就是假红。
 *   · `removeEventListener` 与 `addEventListener` 同记"监听方"（它证明该名字确有接收端在维护）；
 *     两者计数分开记在 --json 里，红/绿只看"该侧有没有"。
 *
 * 用法：
 *   node scripts/lint-cross-pkg-events.mjs --check     # 违例 ⇒ exit 1
 *   node scripts/lint-cross-pkg-events.mjs --json      # 机读（含每条违例的两端文件:行）
 *   node scripts/lint-cross-pkg-events.mjs --selftest  # 判据自检：正反控制 + 变异验证
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const WHITELIST = path.join(ROOT, 'scripts', 'baseline', 'cross-pkg-events-whitelist.json')
const ARGV = process.argv.slice(2)
export const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

/** 占位理由 = 还没想清楚凭什么允许 ⇒ 判红（白名单不许空转成"默认放过"）。与 lint-code 同表 + 长度下限。 */
export const PLACEHOLDER_WHY = ['', '待补', 'TODO', 'todo', '待定', '-', 'n/a', 'na', 'ok']
export const isReason = (s) =>
  typeof s === 'string' && !PLACEHOLDER_WHY.includes(s.trim()) && s.trim().length >= 6

const DIR_SKIP = new Set(['node_modules', 'dist', 'out', 'static', 'public', 'assets', '.git'])
const EXT_OK = ['.ts', '.tsx', '.js', '.jsx', '.mjs']
const IS_TEST = /(\.test\.|\.spec\.|__tests__)/
/** 构建产物（`*.generated.ts` 之类，gitignored）不进扫描面：判据的结论不许取决于"这棵树建过没建过"
 *  —— 建过就多扫两个文件、没建就少扫两个，同一份源码在两台机器上给出不同读数，门禁就不可信了
 *  （ISS-791 安装形状那条同族教训）。 */
const IS_GENERATED = /\.generated\./
const RECV_CUSTOM = 'custom-dispatch' // window.dispatchEvent(new CustomEvent(X))
const RECV_ADD = 'listen-add'         // window.addEventListener(X)
const RECV_REMOVE = 'listen-remove'   // window.removeEventListener(X)

/* ───────────────────────── 0. 解析器（借仓库里已有的 typescript，不新增依赖） ───────────────────────── */
function loadTs() {
  for (const c of ['forge-ui/node_modules/typescript', 'forge-pm/node_modules/typescript', 'node_modules/typescript']) {
    const abs = path.join(ROOT, c)
    if (!fs.existsSync(path.join(abs, 'package.json'))) continue
    try { return createRequire(path.join(abs, 'package.json'))('typescript') } catch { /* 换下一个候选 */ }
  }
  return null
}

/* ───────────────────────── 1. 名字解析（纯函数，自检直接调它） ───────────────────────── */
const unwrap = (ts, n) => {
  let x = n
  while (x && (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isTypeAssertionExpression(x)
    || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x))) x = x.expression
  return x
}

/** 字面量节点 → 字符串（字符串字面量 / 无插值模板串）；否则 null */
const litText = (ts, n) => {
  const x = unwrap(ts, n)
  if (!x) return null
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text
  return null
}

/** 类型注解 → 字符串字面量联合的取值表（`"a" | "b"`）；不是这种形状返回 null */
const typeLiterals = (ts, ann) => {
  if (!ann) return null
  const one = (t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null)
  if (ts.isUnionTypeNode(ann)) {
    const vals = ann.types.map(one)
    return vals.every((v) => v !== null) ? vals : null
  }
  if (ts.isLiteralTypeNode(ann) && ts.isStringLiteral(ann.literal)) return [ann.literal.text]
  return null
}

/** 沿 parent 链找最近的函数形参（形参名即事件名那一形；**优先于文件级常量**，免受同名遮蔽影响） */
const paramDecl = (ts, node, name) => {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) {
      for (const prm of p.parameters ?? []) {
        if (ts.isIdentifier(prm.name) && prm.name.text === name) return prm
      }
      return null // 就近的函数没有这个形参 ⇒ 不再往外找（外层同名形参不该被内层用到）
    }
  }
  return null
}

/**
 * 标识符名 → 事件名集合。解析不出来返回 null（调用方必须落进「未解析」，不许当"没问题"）。
 * ctx = { consts: Map<name, {init?, type?}>, imports: Map<local, spec>, file, resolveModule, constInFile }
 */
export function resolveIdent(ts, name, ctx, depth = 0) {
  if (depth > 6) return null
  // 形参（含联合字面量类型 / 默认值字面量）
  if (ctx.paramSource) {
    const prm = paramDecl(ts, ctx.paramSource, name)
    if (prm) {
      const vals = typeLiterals(ts, prm.type)
      if (vals) return vals
      const d = litText(ts, prm.initializer)
      if (d !== null) return [d]
    }
  }
  const decl = ctx.consts?.get(name)
  if (decl) {
    const vals = typeLiterals(ts, decl.type)
    if (vals) return vals
    const l = litText(ts, decl.init)
    if (l !== null) return [l]
    const inner = unwrap(ts, decl.init)
    if (inner && ts.isIdentifier(inner)) return resolveIdent(ts, inner.text, ctx, depth + 1)
    return null
  }
  const spec = ctx.imports?.get(name)
  if (spec) {
    const target = ctx.resolveModule(spec, ctx.file)
    const found = target && ctx.constInFile(target, name)
    if (found) {
      const sub = { ...ctx, file: found.file, consts: found.consts, imports: found.imports, paramSource: null }
      const d = found.consts.get(name)
      const vals = typeLiterals(ts, d?.type)
      if (vals) return vals
      const l = litText(ts, d?.init)
      if (l !== null) return [l]
      const inner = unwrap(ts, d?.init)
      if (inner && ts.isIdentifier(inner)) return resolveIdent(ts, inner.text, sub, depth + 1)
    }
  }
  return null
}

/** 站点表达式节点 → 事件名集合（字面量直取，标识符走 resolveIdent）；null = 未解析 */
export function resolveName(ts, node, ctx) {
  const lit = litText(ts, node)
  if (lit !== null) return [lit]
  const x = unwrap(ts, node)
  if (!x || !ts.isIdentifier(x)) return null
  return resolveIdent(ts, x.text, { ...ctx, paramSource: node })
}

/* ───────────────────────── 2. 单文件取数（AST，非正则猜） ───────────────────────── */
export function scanFile(ts, relPath, source) {
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true,
    relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const consts = new Map()   // 顶层/嵌套 const 的初始化与类型（不给形参：形参走 paramDecl）
  const imports = new Map()  // localName → 模块说明符
  const sites = []           // { nameNode, kind, line }
  const others = { nonWindow: 0, nonCustomDispatch: 0 }
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  const walk = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      if (n.initializer) consts.set(n.name.text, { init: n.initializer })
      else if (n.type) consts.set(n.name.text, { type: n.type })
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text
      const cl = n.importClause
      if (cl?.name) imports.set(cl.name.text, spec)
      if (cl?.namedBindings && ts.isNamedImports(cl.namedBindings)) {
        for (const el of cl.namedBindings.elements) imports.set((el.propertyName || el.name).text, spec)
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'window') {
      const method = n.expression.name.text
      const arg0 = n.arguments[0]
      if (method === 'addEventListener' || method === 'removeEventListener') {
        if (arg0) sites.push({ nameNode: arg0, kind: method === 'addEventListener' ? RECV_ADD : RECV_REMOVE, line: lineOf(n) })
      } else if (method === 'dispatchEvent') {
        const inner = arg0 && unwrap(ts, arg0)
        if (inner && ts.isNewExpression(inner) && ts.isIdentifier(inner.expression)
          && inner.expression.text === 'CustomEvent' && inner.arguments?.[0]) {
          sites.push({ nameNode: inner.arguments[0], kind: RECV_CUSTOM, line: lineOf(n) })
        } else others.nonCustomDispatch += 1
      }
    }
    // 扫描面边界：非 window 接收方的 add/removeEventListener（只计数，不判红）
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && (n.expression.name.text === 'addEventListener' || n.expression.name.text === 'removeEventListener')) {
      const recv = n.expression.expression
      if (!(ts.isIdentifier(recv) && recv.text === 'window')) others.nonWindow += 1
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return { consts, imports, sites, others }
}

/* ───────────────────────── 3. 判据（纯函数，自检直接调它） ───────────────────────── */
/**
 * @param events   [{ name, dispatchers:[], listeners:[] }]
 * @param entries  白名单 { "<事件名>": "<理由>" }
 * @param opts     仅自检用的**变异开关**（生产路径恒为默认值）：
 *                 mode: 'both' | 'dispatch-only'   'dispatch-only' 模拟"只看派发"的坏判据
 *                 checkReason: true | false        false 模拟"白名单不校验理由"
 *                 unresolved: []                   未解析站点
 */
export function evaluate(events, entries = {}, opts = {}) {
  const mode = opts.mode || 'both'
  const checkReason = opts.checkReason !== false
  const findings = []
  const rows = []
  const used = new Set()

  for (const e of events) {
    const D = e.dispatchers.length
    const L = e.listeners.length
    // 监听侧 = add + remove（remove 证明该名字确有接收端在维护）；两者分开计数只为报告可读
    const adds = e.listeners.filter((s) => s.kind !== 'listen-remove').length
    const removes = L - adds
    let verdict = 'paired'
    if (D === 0 || L === 0) {
      // 变异开关：'dispatch-only' = 只看派发方 ⇒ 只剩监听的一律漏过（自检必须因此变红）
      const missedByMutant = mode === 'dispatch-only' && D === 0
      if (missedByMutant) verdict = 'paired'
      else if (Object.prototype.hasOwnProperty.call(entries, e.name)) {
        used.add(e.name)
        verdict = checkReason && !isReason(entries[e.name]) ? 'allow-no-reason' : 'whitelisted'
      } else verdict = D === 0 ? 'listen-only' : 'dispatch-only'
    }
    const red = verdict !== 'paired' && verdict !== 'whitelisted'
    if (red) {
      const detail = verdict === 'dispatch-only'
        ? `只剩派发 ${D} 处、监听 0 处 ⇒ 派发进空气（静默死路）`
        : verdict === 'listen-only'
          ? `只剩监听 ${L} 处、派发 0 处 ⇒ 监听永不触发（反向孤儿）`
          : `白名单条目「${e.name}」的理由不合格（"${String(entries[e.name] ?? '')}"，空/占位/不足 6 字符）—— 没有理由的豁免等于没有守卫`
      findings.push({ event: e.name, verdict, detail, dispatchers: e.dispatchers, listeners: e.listeners })
    }
    rows.push({ name: e.name, verdict, dispatchers: D, listeners: L, listenAdds: adds, listenRemoves: removes, packages: e.packages })
  }
  for (const s of opts.unresolved || []) {
    findings.push({
      event: '(未解析)', verdict: 'unresolved',
      detail: `解析不出事件名 ⇒ 判不出 ≠ 通过：${s.file}:${s.line} ${s.snippet}`,
      dispatchers: [], listeners: [],
    })
  }
  return { ok: findings.length === 0, findings, rows, stale: Object.keys(entries).filter((k) => !used.has(k)) }
}

/* ───────────────────────── 4. 真仓库扫描 ───────────────────────── */
function listFiles() {
  const out = []
  for (const pkg of fs.readdirSync(ROOT).sort()) {
    if (!pkg.startsWith('forge-')) continue
    for (const half of ['src', 'lib']) {
      const base = path.join(ROOT, pkg, half)
      if (!fs.existsSync(base)) continue
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (DIR_SKIP.has(e.name)) continue
          const abs = path.join(dir, e.name)
          if (e.isDirectory()) { walk(abs); continue }
          if (!EXT_OK.includes(path.extname(e.name)) || IS_TEST.test(abs) || IS_GENERATED.test(abs)) continue
          out.push(abs)
        }
      }
      walk(base)
    }
  }
  return out
}

/** 包名 → 包目录（裸包名 import 的解析用） */
function packageIndex() {
  const m = new Map()
  for (const pkg of fs.readdirSync(ROOT)) {
    const pj = path.join(ROOT, pkg, 'package.json')
    if (!fs.existsSync(pj)) continue
    try {
      const name = JSON.parse(fs.readFileSync(pj, 'utf8')).name
      if (name) m.set(name, path.join(ROOT, pkg))
    } catch { /* 坏 package.json 不当解析目标 */ }
  }
  return m
}

function analyzeRepo(ts, files) {
  const pkgOf = (abs) => path.relative(ROOT, abs).split(path.sep)[0]
  const cache = new Map()
  const readParsed = (abs) => {
    if (cache.has(abs)) return cache.get(abs)
    let source
    try { source = fs.readFileSync(abs, 'utf8') } catch { return null }
    const r = scanFile(ts, path.relative(ROOT, abs), source)
    cache.set(abs, { ...r, file: abs })
    return cache.get(abs)
  }
  const pkgs = packageIndex()
  const findInDir = (dir, name, seen = new Set()) => {
    if (!dir || seen.has(dir) || !fs.existsSync(dir)) return null
    seen.add(dir)
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (DIR_SKIP.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        const hit = findInDir(abs, name, seen)
        if (hit) return hit
        continue
      }
      if (!EXT_OK.includes(path.extname(e.name)) || IS_TEST.test(abs) || IS_GENERATED.test(abs)) continue
      const parsed = readParsed(abs)
      if (parsed?.consts.has(name)) return { file: abs, consts: parsed.consts, imports: parsed.imports }
    }
    return null
  }
  const ctx = {
    consts: new Map(), imports: new Map(), file: '', paramSource: null,
    resolveModule(spec, from) {
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(from), spec)
        const cands = [base, ...EXT_OK.map((x) => base + x), ...EXT_OK.map((x) => path.join(base, 'index' + x))]
        // `./x.js` 在 TS 源码里指的常是 `./x.ts`
        if (/\.(js|jsx|mjs)$/.test(base)) cands.push(base.replace(/\.(js|jsx|mjs)$/, '.ts'), base.replace(/\.(js|jsx|mjs)$/, '.tsx'))
        return cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null
      }
      // 裸包名：只认本仓 forge-* 包（外部包不参与判据）
      const head = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      const root = pkgs.get(head)
      return root ? `${root}\u0000pkg` : null
    },
    constInFile(target, name) {
      if (target.endsWith('\u0000pkg')) return findInDir(target.slice(0, -4), name)
      const parsed = readParsed(target)
      return parsed ? { file: target, consts: parsed.consts, imports: parsed.imports } : null
    },
  }

  const byName = new Map()
  const unresolved = []
  const other = { nonWindow: 0, nonCustomDispatch: 0 }
  for (const abs of files) {
    const parsed = readParsed(abs)
    if (!parsed) continue
    other.nonWindow += parsed.others.nonWindow
    other.nonCustomDispatch += parsed.others.nonCustomDispatch
    const local = { ...ctx, consts: parsed.consts, imports: parsed.imports, file: abs }
    for (const s of parsed.sites) {
      const names = resolveName(ts, s.nameNode, local)
      if (!names || !names.length) {
        let snippet = ''
        try { snippet = s.nameNode.getText().slice(0, 60).replace(/\s+/g, ' ') } catch { /* 片段取不到不影响判据 */ }
        unresolved.push({ file: path.relative(ROOT, abs), line: s.line, snippet })
        continue
      }
      for (const name of names) {
        if (!byName.has(name)) byName.set(name, { name, dispatchers: [], listeners: [], packages: new Set() })
        const rec = byName.get(name)
        const site = { file: path.relative(ROOT, abs), line: s.line, pkg: pkgOf(abs), kind: s.kind }
        rec.packages.add(pkgOf(abs))
        if (s.kind === RECV_CUSTOM) rec.dispatchers.push(site)
        else rec.listeners.push(site)
      }
    }
  }

  // 判什么：打过 CustomEvent 的名字 + 带命名空间的监听名；其余 = 原生 DOM 事件（只报不判）
  const native = []
  const events = []
  for (const rec of byName.values()) {
    if (rec.dispatchers.length === 0 && !rec.name.includes(':')) { native.push(rec.name); continue }
    events.push({ ...rec, packages: [...rec.packages].sort() })
  }
  events.sort((a, b) => a.name.localeCompare(b.name))
  return { events, unresolved, native: native.sort(), other, scanned: files.length }
}

/* ───────────────────────── 5. 白名单 ───────────────────────── */
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST)) return {}
  let j
  try { j = JSON.parse(fs.readFileSync(WHITELIST, 'utf8')) } catch (e) {
    console.error(`✗ 白名单不是合法 JSON（${path.relative(ROOT, WHITELIST)}）：${e.message}`)
    process.exit(EXIT.INTERNAL)
  }
  const entries = j.entries ?? {}
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    console.error('✗ 白名单 entries 必须是 { "<事件名>": "<理由>" } 形状')
    process.exit(EXIT.INTERNAL)
  }
  return entries
}

/* ───────────────────────── 6. 报告 ───────────────────────── */
const fmtSites = (list) => list.map((s) => `${s.file}:${s.line}`).join(' · ')

function report(res, entries, { json }) {
  const judged = evaluate(res.events, entries, { unresolved: res.unresolved })
  if (json) {
    const byName = new Map(res.events.map((e) => [e.name, e]))
    process.stdout.write(JSON.stringify({
      ok: judged.ok,
      scannedFiles: res.scanned,
      events: judged.rows.map((r) => ({
        ...r,
        dispatchers: byName.get(r.name).dispatchers,
        listeners: byName.get(r.name).listeners,
      })),
      findings: judged.findings,
      unresolved: res.unresolved,
      staleWhitelist: judged.stale,
      nativeEvents: res.native,
      outOfFace: res.other,
    }, null, 2) + '\n')
    return judged.ok ? EXIT.CLEAN : EXIT.VIOLATION
  }
  console.log(`跨包 window 事件守卫（ISS-571）· 扫描 ${res.scanned} 文件（forge-*/{src,lib}，测试文件与构建产物不计）`)
  for (const r of judged.rows) {
    const mark = r.verdict === 'paired' ? '✓' : r.verdict === 'whitelisted' ? '·' : '✗'
    const why = r.verdict === 'whitelisted' ? `（白名单：${entries[r.name]}）` : ''
    const listen = r.listenAdds + (r.listenRemoves ? `(+${r.listenRemoves} remove)` : '')
    console.log(`  ${mark} ${r.name.padEnd(30)} 派发 ${r.dispatchers} · 监听 ${listen}  [${r.packages.join(', ')}]${why}`)
  }
  console.log(`  · 原生 DOM 事件（不判）${res.native.length} 个：${res.native.join(', ') || '—'}`)
  console.log(`  · 扫描面外只报：非 window 接收方 ${res.other.nonWindow} 处 · 非 CustomEvent 派发 ${res.other.nonCustomDispatch} 处`)
  if (res.unresolved.length) {
    console.log(`  ✗ 未解析 ${res.unresolved.length} 处（判不出 ≠ 通过）：`)
    for (const u of res.unresolved) console.log(`      ${u.file}:${u.line}  ${u.snippet}`)
  } else console.log('  ✓ 未解析 0 处（每个站点的事件名都解析出来了）')
  if (judged.stale.length) console.log(`  ! 白名单未命中 ${judged.stale.length} 条（死路已清就该删条目）：${judged.stale.join(', ')}`)
  const single = judged.findings.filter((f) => f.verdict !== 'unresolved')
  if (!judged.ok) {
    console.log(`\n✗ ${single.length} 条单方事件 + ${res.unresolved.length} 处未解析 ⇒ 静默死路不许留`)
    for (const f of single) {
      console.log(`  ✗ ${f.event}：${f.detail}`)
      if (f.dispatchers.length) console.log(`      派发：${fmtSites(f.dispatchers)}`)
      if (f.listeners.length) console.log(`      监听：${fmtSites(f.listeners)}`)
      console.log('      → 要么补齐另一端，要么整条删掉；确要留单方：登记 scripts/baseline/cross-pkg-events-whitelist.json 并写理由')
    }
  } else console.log('\n✓ 全部判定事件两端齐全（或已带理由登记）')
  return judged.ok ? EXIT.CLEAN : EXIT.VIOLATION
}

/* ───────────────────────── 7. 自检（正反控制 + 变异验证） ───────────────────────── */
function selftest(ts) {
  const cases = []
  const push = (n, ok) => cases.push([n, !!ok])
  const mk = (name, d, l) => ({
    name,
    dispatchers: d ? [{ file: 'forge-a/src/x.ts', line: 1, pkg: 'forge-a' }] : [],
    listeners: l ? [{ file: 'forge-b/src/y.ts', line: 2, pkg: 'forge-b' }] : [],
    packages: ['forge-a', 'forge-b'],
  })
  const dead = (name, reason) => ({ [name]: reason })

  // ── 正反控制（判据本身） ──
  push('成对（派发+监听）⇒ 绿', evaluate([mk('forge:pair', 1, 1)]).ok === true)
  push('只剩派发 ⇒ 红（dispatch-only）', (() => { const r = evaluate([mk('forge:dead', 1, 0)]); return !r.ok && r.findings[0].verdict === 'dispatch-only' })())
  push('只剩监听 ⇒ 红（listen-only · 反向孤儿）', (() => { const r = evaluate([mk('forge:orphan', 0, 1)]); return !r.ok && r.findings[0].verdict === 'listen-only' })())
  push('白名单带理由 ⇒ 绿（豁免通道真的生效）', evaluate([mk('forge:dead', 1, 0)], dead('forge:dead', '自检：历史遗留，等 ISS-926 迁移，此条仅为验证豁免通道')).ok === true)
  push('白名单空理由 ⇒ 红', evaluate([mk('forge:dead', 1, 0)], dead('forge:dead', '')).findings.some((f) => f.verdict === 'allow-no-reason'))
  push('白名单占位理由（待补）⇒ 红', evaluate([mk('forge:dead', 1, 0)], dead('forge:dead', '待补')).findings.some((f) => f.verdict === 'allow-no-reason'))
  push('白名单过短理由（"ok"）⇒ 红', evaluate([mk('forge:dead', 1, 0)], dead('forge:dead', 'ok')).findings.some((f) => f.verdict === 'allow-no-reason'))
  push('未解析 ⇒ 单列且判红（不静默当没问题）', (() => {
    const r = evaluate([mk('forge:pair', 1, 1)], {}, { unresolved: [{ file: 'forge-a/src/x.ts', line: 9, snippet: 'evName' }] })
    return r.ok === false && r.findings.some((f) => f.verdict === 'unresolved')
  })())
  push('白名单未命中 ⇒ 报 stale（死路清了条目就该删）', evaluate([mk('forge:pair', 1, 1)], dead('forge:gone', '自检：条目已过期')).stale.includes('forge:gone'))

  // ── 名字解析四形（少一形就会把真事件漏成"没问题"） ──
  const one = (src) => {
    const r = scanFile(ts, 'forge-a/src/fixture.ts', src)
    const ctx = { consts: r.consts, imports: r.imports, file: path.join(ROOT, 'forge-a/src/fixture.ts'), paramSource: null, resolveModule: () => null, constInFile: () => null }
    const got = r.sites.map((s) => resolveName(ts, s.nameNode, ctx)).filter(Boolean).flat()
    return { got, unresolved: r.sites.filter((s) => !resolveName(ts, s.nameNode, ctx)).length }
  }
  push('① 字符串字面量解析得出', one('window.addEventListener("forge:lit", f)\n').got.join() === 'forge:lit')
  push('② 同文件常量解析得出', one('const X = "forge:const"\nwindow.addEventListener(X, f)\n').got.join() === 'forge:const')
  push('②b 常量别名（const A = B）解析得出', one('const B = "forge:alias"\nconst A = B\nwindow.addEventListener(A, f)\n').got.join() === 'forge:alias')
  push('②c `as const` 包裹解析得出', one('const X = "forge:asconst" as const\nwindow.addEventListener(X, f)\n').got.join() === 'forge:asconst')
  push('④ 形参字面量联合类型 ⇒ 两个名字都认', one('function f(name: "forge:p" | "forge:q") { window.dispatchEvent(new CustomEvent(name)) }\n').got.sort().join() === 'forge:p,forge:q')
  push('④b 形参默认值字面量解析得出', one('function f(name = "forge:def") { window.dispatchEvent(new CustomEvent(name)) }\n').got.join() === 'forge:def')
  push('④c 内外层同名形参不串（就近取内层）', one('function a(name: "forge:outer") {}\nfunction b(name: "forge:inner") { window.dispatchEvent(new CustomEvent(name)) }\n').got.join() === 'forge:inner')
  push('⑤ 认不出（裸变量 / 运行时拼接）⇒ 落进未解析，不静默放过', one('window.addEventListener(name, f)\nwindow.addEventListener(`forge:${x}`, f)\n').unresolved === 2)
  push('CustomEvent 派发与 add/removeEventListener 都收进站点', scanFile(ts, 'f.ts', 'window.addEventListener("e", f)\nwindow.removeEventListener("e", f)\nwindow.dispatchEvent(new CustomEvent("e"))\n').sites.length === 3)
  push('非 window 接收方不算窗口事件（`el.addEventListener("click")`）', (() => {
    const r = scanFile(ts, 'f.ts', 'el.addEventListener("click", f)\nwindow.addEventListener("resize", f)\n')
    return r.sites.length === 1 && r.others.nonWindow === 1
  })())
  push('注释里的用法不算（注释不是代码）', scanFile(ts, 'f.ts', '// window.dispatchEvent(new CustomEvent("forge:c"))\nconst a = 1\n').sites.length === 0)

  // ── 变异验证：判据被改弱，本自检**必须因此变红** ──
  // 这两条不是装饰：不写它们，"判据被改成恒绿"与"判据没问题"在输出上长得一模一样。
  const mutants = [
    { expect: 'red', ev: mk('forge:m-dispatch', 1, 0) },
    { expect: 'red', ev: mk('forge:m-listen', 0, 1) },
  ]
  const mutantMissed = (mode, checkReason) => mutants.filter((f) =>
    evaluate([f.ev], { 'forge:m-dispatch': '' }, { mode, checkReason }).ok === true).length
  push('变异①「只看派发」⇒ 自检变红（只剩监听那条不再被拦）', mutantMissed('dispatch-only', true) > 0)
  push('变异②「白名单不校验理由」⇒ 自检变红（空理由不再被拦）',
    evaluate([mk('forge:m-dispatch', 1, 0)], { 'forge:m-dispatch': '' }, { checkReason: false }).ok === true)
  push('反向控制：正常档下上面两个 mutant fixture 都判红（证明变异抓的是真东西）', mutantMissed('both', true) === 0)

  let fail = 0
  console.log('lint-cross-pkg-events --selftest（判据：两端齐全 · 白名单带理由 · 未解析不静默）')
  for (const [n, ok] of cases) { console.log(`  ${ok ? '✓' : '✗'} ${n}`); if (!ok) fail++ }
  console.log(fail ? `\n✗ ${fail} 项失败` : `\n✓ ${cases.length}/${cases.length} 项通过`)
  return fail ? EXIT.VIOLATION : EXIT.CLEAN
}

/* ───────────────────────── 8. 入口 ───────────────────────── */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const ts = loadTs()
  if (!ts) {
    console.error('✗ 找不到 typescript 编译器（试过 forge-ui / forge-pm / root 的 node_modules）—— 判不出 ≠ 通过')
    process.exit(EXIT.INTERNAL)
  }
  if (ARGV.includes('--selftest')) process.exit(selftest(ts))
  process.exit(report(analyzeRepo(ts, listFiles()), loadWhitelist(), { json: ARGV.includes('--json') }))
}
