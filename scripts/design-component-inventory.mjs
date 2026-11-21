#!/usr/bin/env node
// scripts/design-component-inventory.mjs
// 组件现状盘点 —— 规范 §2 / 审计 §H / 门禁 R8 的数字来源（可机器复算，禁手抄进文档）
// 用法：node scripts/design-component-inventory.mjs [--json] [--verbose] [--selftest]
//                                              [--baseline-save | --compare]
//   · 基线在 scripts/baseline/design-components.json —— ISS-694 §M6 八批**每批合车后跑一次 --compare**，
//     由同一条命令出差异（口径与 code-inventory 一致：基线与门禁数字必须同源、可复算，禁手抄）。
//     --compare 返回码三态（ISS-635，口径同 scripts/ws.sh 的 0 绿 / 1 红 / 2 判不了）：本档**判不了（2）**——
//     分层与件数会随正常施工变化（件数↓ 也可能是好），红判据不在这里：组件层的回归由 lint-design 的 R 号
//     与 lint-code 的 K6a / K6d 判。返回 2 而不是 0，是因为 0 会被读取方当成"绿"，而本档没有绿可言。
//
// 口径（写死在此，改口径等于改门禁）：
//   · 扫描 forge-*/src 手写源码；排除 dist/ node_modules/ *.generated.* *.test.* 编辑器备份（"名.tsx~15448"）
//   · 「实现」= export function/const/class <大驼峰名>（不含下划线 ⇒ 常量不计入组件）∪ 本文件内声明后被 export{} 导出的名
//     ⚠️ 已知盲区（09-23 §M6-3 撞到，口径**故意未改**）：只数导出的 ⇒ **文件内的局部同名件在数字上隐形**。
//     活例：`PropRow` 盘点报 1 份，实际 forge-pm 项目页里还有一份局部同名件，而两份 className 不同
//     （`items-start gap-3 py-1` + label `w-14` 定宽  vs  `items-center justify-between gap-4 min-h-7` + 不定宽）。
//     ⇒ 读「一名多实现 = N」时要记得它是**下界**；改名那类局部去重（project-linear 的 ProjectPropRow）
//     不会体现在本表数字上。要不要把局部组件纳进射程 = 一次会让全部计数重排的口径变更，得单独一批做，
//     并与 lint-design 的 R8b/R8c 例外清单一起复录。
//     —— index.ts 只做再导出 ⇒ 不算实现，但它的再导出表用于把使用者归到真实源文件
//   · 「引用」= 别的文件的 import 子句里出现该名字，且说明符解析后的**真实源文件**就是该实现所在文件
//     （bare 包名 → <pkg>/src/index.ts → 顺再导出表落到源文件；相对路径 → 解析到具体文件）
//     ⇒ 同名不同件不会被混计
import fs from 'node:fs'
import path from 'node:path'
import { collectSources, makeCssCovered, selftestTailwindSource } from './tailwind-source-lib.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SKIP = /(\/dist\/|\/node_modules\/|\.generated\.|\.test\.|~\d{3,})/
const rel = (p) => path.relative(ROOT, p)
const pkgOf = (p) => rel(p).split('/')[0]

function walk(dir, acc = [], ext = /\.(tsx|ts)$/) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP.test(p)) walk(p, acc, ext) }
    else if (ext.test(e.name) && !SKIP.test(p)) acc.push(p)
  }
  return acc
}

const files = []
const cssFiles = []
for (const pkg of fs.readdirSync(ROOT)) {
  const src = path.join(ROOT, pkg, 'src')
  if (/^forge-/.test(pkg) && fs.existsSync(src)) {
    files.push(...walk(src))
    cssFiles.push(...walk(src, [], /\.css$/))
  }
}
const fileSet = new Set(files)
const pick = (base) => {
  for (const c of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')])
    if (fileSet.has(c)) return c
  return null
}
/* 子路径说明符（`forge-design/ui/checkbox` 这种）先查该包 package.json 的 `exports` 映射（真相源），
   查不到再退回本仓约定 `<pkg>/src/<sub>`。
   ⚠️ 这一档 09-22 之前是缺的：原先只做 `ROOT/<spec>`，于是所有 `forge-design/ui/*`、`forge-x/hooks/*`
   的子路径 import 全部解析失败 ⇒ **明明有 5 个使用者的基元被记成"零引用"**。
   假零引用比假高估危险：M6-1 要按"零引用清单"删副本，解析不到就会把有人用的件当没人用的删掉。
   （09-23 是把 Checkbox 挪进 forge-design 时，--compare 报出"零引用 新增 1"才暴露的。） */
const exportsCache = new Map()
function exportsTargets(pkg, sub) {
  if (!exportsCache.has(pkg)) {
    let map = null
    try { map = JSON.parse(fs.readFileSync(path.join(ROOT, pkg, 'package.json'), 'utf8')).exports || null } catch { map = null }
    exportsCache.set(pkg, map)
  }
  const map = exportsCache.get(pkg)
  if (!map) return []
  const out = []
  const flatten = (v) => (typeof v === 'string' ? [v] : v ? Object.values(v).filter((x) => typeof x === 'string') : [])
  for (const [k, v] of Object.entries(map)) {
    if (k === './' + sub) out.push(...flatten(v))
    else if (k.endsWith('/*')) {
      const pre = k.slice(0, -1)
      if (k.startsWith('./') && sub.startsWith(pre.slice(2))) out.push(...flatten(v).map((t) => t.replace('*', sub.slice(pre.slice(2).length))))
    }
  }
  return out.map((t) => path.join(ROOT, pkg, t.replace(/^\.\//, '')))
}
function subpathCandidates(spec, pkg, sub) { return [...exportsTargets(pkg, sub), path.join(ROOT, spec), path.join(ROOT, pkg, 'src', sub)] }

const resolve = (fromFile, spec) => {
  if (/^[./]/.test(spec)) return pick(path.resolve(path.dirname(fromFile), spec))
  const [pkg, ...rest] = spec.split('/')
  if (!/^forge-/.test(pkg)) return null
  if (!rest.length) return pick(path.join(ROOT, pkg, 'src', 'index'))
  for (const c of subpathCandidates(spec, pkg, rest.join('/'))) { const hit = pick(c); if (hit) return hit }
  return null
}

// 一条正则同时吃 `import {A} from`、`export {A} from`、`export type {A} from`
// ⚠️ 必须分开处理 import 与 export 两种 `as`：
//   · `import { ListRow as RL }` —— **被引用的导出名是左边** `ListRow`，`RL` 只是本文件的局部别名；
//   · `export { ListRow as RL } from './x'` —— 再导出表的键是**右边** `RL`（对外叫什么）。
// 09-23 之前这里统一 `.pop()`（取右边）⇒ **所有别名 import 的使用者都漏计**：
// `forge-pm/src/pm/linear-issue-detail.tsx:32` 的 `import { ListRow as SharedListRow }` 被记成引用了
// `SharedListRow`，于是 ListRow 真实 5 个使用者只报 4 个 —— 与刚修的"子路径解析失败"同一族：
// 漏计使用者 = 让有人用的件出现在"零引用清单"里 = M6-1 按它删就会删错。
const NAMED = /\b(import|export)(?:\s+type)?\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
const STAR = /export\s+\*\s*(?:as\s+\w+\s*)?from\s*["']([^"']+)["']/g
function clausesOf(txt) {
  const out = []
  for (const m of txt.matchAll(NAMED)) {
    const names = m[2].split(',').map((raw) => {
      const t = raw.trim().replace(/^type\s+/, '')
      if (!t) return null
      const parts = t.split(/\s+as\s+/)
      return (m[1] === 'import' ? parts[0] : parts[parts.length - 1]).trim() || null
    }).filter(Boolean)
    out.push({ spec: m[3], names })
  }
  for (const m of txt.matchAll(STAR)) out.push({ spec: m[1], names: null })
  return out
}

const text = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))
const direct = new Map()
for (const f of files) {
  const t = text.get(f)
  const s = new Set()
  for (const m of t.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Z][A-Za-z0-9]*)\b/g)) s.add(m[1])
  for (const m of t.matchAll(/export\s*\{([^}]*)\}\s*;?(?!\s*from)/g))
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/)
      const exported = (parts[1] ?? parts[0])?.trim()
      if (exported && /^[A-Z][A-Za-z0-9]*$/.test(exported) && new RegExp(`\\b(?:const|function|let|class)\\s+${exported}\\b`).test(t)) s.add(exported)
    }
  direct.set(f, s)
}

// 再导出表（两轮传播，支持 index → 子 index）
const surface = new Map(files.map((f) => [f, new Map([...direct.get(f)].map((n) => [n, f]))]))
for (let round = 0; round < 2; round++) {
  for (const f of files) for (const c of clausesOf(text.get(f))) {
    const t = resolve(f, c.spec)
    if (!t || t === f) continue
    if (c.names === null) {
      for (const [n, owner] of surface.get(t)) if (!surface.get(f).has(n)) surface.get(f).set(n, owner)
    } else {
      for (const n of c.names) if (surface.get(t).has(n) && !surface.get(f).has(n)) surface.get(f).set(n, surface.get(t).get(n))
    }
  }
}

const importers = new Map()
for (const [f, m] of surface) for (const [n, owner] of m) if (direct.get(owner)?.has(n)) importers.set(`${owner}|${n}`, new Set())
for (const f of files) for (const c of clausesOf(text.get(f))) {
  if (/\/index\.tsx?$/.test(rel(f))) continue   // 桶文件（barrel）的再导出不算"有人用"
  const t = resolve(f, c.spec)
  if (!t || t === f || !c.names) continue
  for (const n of c.names) {
    const owner = surface.get(t)?.get(n)
    const key = `${owner}|${n}`
    if (owner && importers.has(key) && owner !== f) importers.get(key).add(f)
  }
}

const defs = []
for (const f of files) {
  if (/\/index\.tsx?$/.test(rel(f))) continue
  const r = rel(f), pkg = pkgOf(f)
  const layer = pkg === 'forge-design' && /forge-design\/src\/ui\//.test(r) ? 'BASE'
    : /\/components\/ui\//.test(r) ? 'COPY'
    : pkg === 'forge-design' ? 'L2'
    : /card-kit/.test(r) ? 'KIT'
    : 'BIZ'
  for (const n of direct.get(f)) defs.push({ name: n, abs: f, pkg, layer, uses: (importers.get(`${f}|${n}`) ?? new Set()).size })
}
const byName = new Map()
for (const d of defs) (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)).push(d)
const dup = [...byName.entries()].filter(([, v]) => v.length > 1)
/* 「引用」有**两条通道**：JS 的 import 子句（上面的 importers）与样式表的 @source（Tailwind v4 扫源码文本）。
   只看前者会把**类供体**当成零引用 —— 删掉它 JS 一字不动，产物里的原子类却静默消失（09-23 实测撞到，
   详见 tailwind-source-lib.mjs 头注释）。所以：uses===0 且不在任何 @source 射程内，才算真的没人用。 */
const twSrc = collectSources(cssFiles)
const cssCovered = makeCssCovered(files, twSrc)
for (const d of defs) d.cssRef = cssCovered.has(d.abs)
// ⚠️ 口径**故意没改**：`零引用实现` 仍然只数 import 通道。
//   想用它做删除判据的人请读这段：把"被 @source 射程覆盖"直接当"有人用"是错的 ——
//   一个零引用文件落在扫描范围内 ≠ 它的类被**渲染出来的组件**需要（多数只是顺带扫到）。
//   真正的删除判据是**产物级**的：删完重建，逐个消失的类断言"现存源码里再没人提它"
//   （已抽成 scripts/design-delete-verify.mjs，§M6-1 第 2 子批就是这么过的）。
//   这里只保留两个静态信号：cssRefCount（顺带扫到的零引用件，提示"可能有供体关系"）与 dangling（悬空 @source = 死配置）。
const zero = defs.filter((d) => d.uses === 0)
const cssDonor = defs.filter((d) => d.uses === 0 && d.cssRef)
const layerCount = {}, layerFiles = {}
for (const d of defs) { layerCount[d.layer] = (layerCount[d.layer] ?? 0) + 1; (layerFiles[d.layer] ??= new Set()).add(d.abs) }
const baseUi = fs.existsSync(path.join(ROOT, 'forge-design/src/ui')) ? fs.readdirSync(path.join(ROOT, 'forge-design/src/ui')) : []
const copies = {}
for (const f of files) {
  const m = rel(f).match(/^(forge-[^/]+)\/src\/.*\/ui\/([^/]+\.tsx?)$/)
  if (m && m[1] !== 'forge-design') (copies[m[1]] ??= []).push(m[2] + (baseUi.includes(m[2]) ? '' : '†'))
}
const crossPkg = new Set()
for (const f of files) for (const c of clausesOf(text.get(f))) {
  const p = c.spec.split('/')[0]
  if (/^forge-/.test(p) && p !== pkgOf(f) && p !== 'forge-design') crossPkg.add(`${rel(f)} → ${p} {${(c.names ?? []).join(',')}}`)
}
const WATCH = ['ListBlock', 'DetailBlock', 'ListToolbar', 'GroupHeader', 'PropertiesPanel', 'PropRow', 'ListRow', 'IssueLine', 'ForgeList', 'Tab', 'PanelPopover', 'PanelDialog', 'DisplayPopover', 'Card', 'MetaText', 'Button', 'Badge', 'Tag']

const S = {
  扫描文件数: files.length, 组件实现总数: defs.length, 组件名不重复: byName.size,
  多份实现名字: dup.length, 跨包多份实现: dup.filter(([, v]) => new Set(v.map((x) => x.pkg)).size > 1).length,
  分层: Object.fromEntries(Object.keys(layerCount).sort().map((k) => [k, `${layerCount[k]} 件 / ${layerFiles[k].size} 文件`])),
  ui副本: Object.fromEntries(Object.entries(copies).map(([k, v]) => [k, v.length])),
  ui副本文件总数: Object.values(copies).reduce((a, b) => a + b.length, 0),
  业务包跨包import: crossPkg.size,
  同名多份: dup.map(([n, v]) => ({ 名: n, 份数: v.length, 包: [...new Set(v.map((x) => x.pkg))].join(','), 文件: v.map((x) => rel(x.abs)).join(' | ') })).sort((a, b) => b.份数 - a.份数),
  零引用实现: zero.length,
  零引用清单: zero.map((d) => `${d.name} — ${rel(d.abs)}`).sort(),
  cssRefCount: cssDonor.length,
  CSS供体清单: [...new Set(cssDonor.map((d) => rel(d.abs)))].sort(),
  悬空source: twSrc.dangling.map((d) => `${d.css} → ${d.raw}`).sort(),
  跨包import清单: [...crossPkg].sort(),
  /* ISS-944 纯增量：完整「组件名 → 实现」表，供出码的 component_map 派生用。
     只加键、不改任何既有口径与计数；同名多份仍由上面的 dup 表达。 */
  组件表: [...byName.entries()].map(([name, v]) => ({
    名: name,
    实现: v.map((d) => ({ 文件: rel(d.abs), 包: d.pkg, 分层: d.layer, 使用者: d.uses })),
  })).sort((a, b) => a.名.localeCompare(b.名)),
  重点件: WATCH.map((n) => defs.filter((d) => d.name === n).map((d) => `${n.padEnd(17)} [${d.pkg.padEnd(13)}] ${String(d.uses).padStart(2)} 个使用者  ${rel(d.abs)}`)).flat(),
}

/* ───────────── 自检：解析面（假零引用的根因就在这里，必须有牙） ───────────── */
if (process.argv.includes('--selftest')) {
  const hit = (from, spec) => resolve(from, spec) ? rel(resolve(from, spec)) : null
  const cases = [
    ['① 子路径走 exports 映射：forge-design/ui/checkbox → src/ui/checkbox', hit('forge-pm/src/pm/x.tsx', 'forge-design/ui/checkbox') === 'forge-design/src/ui/checkbox.tsx'],
    ['② 裸包名走 src/index', hit('forge-pm/src/pm/x.tsx', 'forge-design') === 'forge-design/src/index.ts'],
    // ③ 的锚点用**真在仓库里的文件**（上一版拿 `./shared/list-row` 当例子，被 §M6-2 删掉后这条用例会假红）
    ['③ 相对路径照旧解析（拿真存在的 ./list-row 验）', hit('forge-design/src/index.ts', './list-row') === 'forge-design/src/list-row.tsx'],
    ['④ 非 forge 的三方包 ⇒ null（组件归属判据不管三方）', hit('forge-pm/src/pm/x.tsx', 'lucide-react') === null],
    ['⑤ 不存在的子路径 ⇒ null，不许瞎猜到一个同名文件', hit('forge-pm/src/pm/x.tsx', 'forge-design/ui/__no_such__.tsx') === null],
    ['⑥ exports 里没有的模式退回 <pkg>/src/<sub>', subpathCandidates('forge-design/kits/foo', 'forge-design', 'kits/foo').some((x) => /forge-design\/src\/kits\/foo$/.test(x))],
    ['⑦ 别名 import 记的是**被引用的导出名**（ListRow as RL ⇒ 算 ListRow 的使用者）', JSON.stringify(clausesOf('import { ListRow as RL } from "forge-design"')) === '[{"spec":"forge-design","names":["ListRow"]}]'],
    ['⑧ 别名再导出记的是**对外名字**（export { ListRow as RL } ⇒ 表里键是 RL）', JSON.stringify(clausesOf('export { ListRow as RL } from "./list-row"')) === '[{"spec":"./list-row","names":["RL"]}]'],
    ['⑨ 混合与 type 前缀不吃亏（import { type X, ListRow } ⇒ 只算 ListRow 与 X，不产生空串）', JSON.stringify(clausesOf('import { type X, ListRow } from "forge-design"')) === '[{"spec":"forge-design","names":["X","ListRow"]}]'],
  ]
  let bad = 0
  for (const [n, ok] of cases) { console.log(`${ok ? '✓' : '✗'} ${n}`); if (!ok) bad++ }
  // 第二条引用通道（样式表 @source）单独一套用例：它判的是"删文件会不会让 CSS 静默掉类"，
  // 正是 §M6-1 后面几批要用的判据 ⇒ 牙必须在这里，不能等施工时靠人想起来。
  const tw = selftestTailwindSource((line) => console.log(line))
  bad += tw.total - tw.pass
  const live = cssFiles.length > 0 && (twSrc.dirs.size > 0 || twSrc.files.size > 0)
  console.log(`${live ? '✓' : '✗'} ⑩ 本仓确有样式表 @source 在射程内（否则这一支等于没接上）`)
  if (!live) bad++
  console.log(`design-component-inventory selftest ${cases.length + tw.total + 1 - bad}/${cases.length + tw.total + 1} 通过`)
  process.exit(bad ? 2 : 0)
}

/* ───────────────────── 基线：存 / 对照（ISS-694 §M6 八批的复算锚点） ───────────────────── */
const BASELINE = path.join(ROOT, 'scripts', 'baseline', 'design-components.json')
const KEY = ['组件实现总数', '组件名不重复', '多份实现名字', '跨包多份实现', '零引用实现', 'ui副本文件总数', '业务包跨包import']
/** 只存"会随施工变化"的量；不存文件清单里的行号类易碎信息 ⇒ 同一份代码两次跑逐字节一致 */
const designSnapshot = () => JSON.stringify({
  header: { tool: 'design-component-inventory.mjs', date: new Date().toISOString().slice(0, 10), 扫描文件数: S.扫描文件数 },
  关键数: Object.fromEntries(KEY.map((k) => [k, S[k]])),
  分层: S.分层,
  ui副本: S.ui副本,
  同名多份: Object.fromEntries(S.同名多份.map((d) => [d.名, `${d.份数} [${d.包}]`])),
  零引用清单: Object.fromEntries(S.零引用清单.map((x) => [x, 1])),
  跨包import清单: Object.fromEntries(S.跨包import清单.map((x) => [x, 1])),
  CSS供体清单: Object.fromEntries(S.CSS供体清单.map((x) => [x, 1])),
}, null, 1) + '\n'

if (process.argv.includes('--baseline-save')) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, designSnapshot())
  console.log(`✓ 基线已存 ${rel(BASELINE)}（${S.组件实现总数} 件 / ${S.扫描文件数} 个文件 · 对照命令 --compare）`)
  process.exit(0)
}
if (process.argv.includes('--compare')) {
  if (!fs.existsSync(BASELINE)) { console.error('✗ 没有基线，先跑 node scripts/design-component-inventory.mjs --baseline-save'); process.exit(2) }
  const b = JSON.parse(fs.readFileSync(BASELINE, 'utf8')), n = JSON.parse(designSnapshot())
  const rows = []
  for (const k of KEY) if (b.关键数[k] !== n.关键数[k]) rows.push(`  关键数 ${k.padEnd(14)} ${b.关键数[k]} → ${n.关键数[k]}`)
  for (const k of Object.keys(n.分层)) if (b.分层[k] !== n.分层[k]) rows.push(`  分层 ${k.padEnd(6)} ${b.分层[k]} → ${n.分层[k]}`)
  for (const k of Object.keys(n.ui副本)) if ((b.ui副本[k] ?? 0) !== n.ui副本[k]) rows.push(`  ui 副本 ${k.padEnd(14)} ${b.ui副本[k] ?? '∅'} → ${n.ui副本[k]} 件`)
  for (const k of Object.keys(b.ui副本)) if (!(k in n.ui副本)) rows.push(`  ui 副本 ${k.padEnd(14)} ${b.ui副本[k]} → 0 件（该包副本已清空）`)
  const dm = (o, cur, label) => {
    const added = Object.keys(cur).filter((x) => !(x in o)), gone = Object.keys(o).filter((x) => !(x in cur))
    const chg = Object.keys(cur).filter((x) => x in o && o[x] !== cur[x])
    if (gone.length) rows.push(`  ${label} 消失 ${gone.length}：${gone.slice(0, 8).join('、')}${gone.length > 8 ? ` …另有 ${gone.length - 8} 条` : ''}`)
    if (added.length) rows.push(`  ${label} 新增 ${added.length}：${added.slice(0, 8).join('、')}${added.length > 8 ? ` …另有 ${added.length - 8} 条` : ''}`)
    for (const x of chg) rows.push(`  ${label} 变化 ${x}：${o[x]} → ${cur[x]}`)
  }
  dm(b.同名多份, n.同名多份, '同名多份件')
  dm(b.零引用清单, n.零引用清单, '零引用')
  dm(b.跨包import清单, n.跨包import清单, '跨包 import')
  console.log(`对照设计侧基线（存于 ${b.header.date} · 扫描文件数 ${b.header.扫描文件数}→${n.header.扫描文件数}）：${rows.length} 处变化`)
  for (const r of rows) console.log(r)
  if (!rows.length) console.log('  （无变化 —— 这批没动组件层）')
  console.log('判不了 —— 本档不判「新增违例」：件数/分层随正常施工变化，组件层的红在 lint-design 的 R 号与 lint-code 的 K6a/K6d；本档只报漂移')
  process.exit(2) // ISS-635 三态：0 绿 / 1 红 / 2 判不了 —— 本档没有绿可言，不许返回 0 让读取方当成绿
}

if (process.argv.includes('--json')) { fs.writeSync(1, JSON.stringify(S, null, 1) + '\n'); process.exit(0) } // 同步写：console.log 后立刻 exit 会在管道上截断输出（09-29 实测断在 65536 字节）
console.log(`扫描 ${S.扫描文件数} 个手写源码文件（排除 generated / test / dist / 备份）`)
console.log('\n分层（件 / 文件）:')
for (const [k, v] of Object.entries(S.分层)) console.log(`  ${k.padEnd(5)} ${v}`)
console.log('\n关键数:')
for (const k of ['组件实现总数', '组件名不重复', '多份实现名字', '跨包多份实现', '零引用实现', 'ui副本文件总数', '业务包跨包import']) console.log(`  ${k} = ${S[k]}`)
console.log('\n重点件（使用者数 = 真实 import 该实现的文件数）:')
for (const r of S.重点件) console.log('  ' + r)
if (process.argv.includes('--verbose')) {
  console.log('\nui 副本（† = forge-design 无同名文件）:')
  for (const [k, v] of Object.entries(S.ui副本)) console.log(`  ${k.padEnd(16)} ${v}: ${copies[k].join(' ')}`)
  console.log('\n同名多份实现:')
  for (const d of S.同名多份) console.log(`  ${d.名.padEnd(24)} ${d.份数} 份 [${d.包}]  ${d.文件}`)
  console.log(`\n零引用实现 ${S.零引用清单.length} 条:\n  ` + S.零引用清单.join('\n  '))
  console.log(`\n跨包 import ${S.跨包import清单.length} 条:\n  ` + S.跨包import清单.join('\n  '))
}
