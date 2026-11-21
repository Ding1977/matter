#!/usr/bin/env node
// scripts/lint-log-outlet.mjs
// 日志出口与错误 kind 的棘轮门禁（PRJ-016 / ISS-719 · 判据出处 docs/code-audit.md §E）。
//
// 管三件事，全部**只压新增**（存量 355 处 throw / 79 个文件的 console 不返工 —— 一起改 = 第 4 次重构风险）：
//   G1 host 半 `console.*` 出现次数（每包上限）—— 新代码请用 `forge-service-kit/log` 的 makeLogger
//   G2 host 半 `throw new XxxError(...)`（无 kind）出现次数（每包上限）—— 新代码用 `fail(kind, msg)`
//   G3 host 半**直接**调 `ctx.logger` 的次数（每包上限）—— 直接调会拿到"写进内存环形 buffer 没人看"的那一路
//
// 上限文件 = scripts/baseline/log-outlet.json。三种状态：
//   over  → 阻塞（新增了一处）
//   under → 提示"可收线"（不红，鼓励继续减）
//   ghost → 提示"该包已不再触犯"（不红 —— 惩罚改进的门禁没人愿意留）
//
// 扫描面 = `forge-*/lib` 下非测试 .js/.mjs 的**手写**文件。**生成物不计**（ISS-653）：
//   名单在下面的 GENERATED 常量里，点名到文件 + 写明是哪个脚本的产物；每次运行都会把
//   「排了哪些文件、因此少算了多少处」打到输出 —— 排除不许静默（静默排除 = 门禁看不见东西）。
//
// 用法：node scripts/lint-log-outlet.mjs [--check|--write|--json|--verbose|--selftest]
//   --write  重录上限（必须在提交说明里写清为什么允许）
//   --selftest 用临时 fixture 反向验证：该红能红 / 等于上限不红 / 测试文件与注释不误伤 / 生成物排除只排名单内 / under·ghost 不红
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLint, countByRulePackage, compareCeilings, ceilingsFrom } from './lint-common.mjs'

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..')
const BASELINE = path.join(ROOT, 'scripts', 'baseline', 'log-outlet.json')
const ARGV = process.argv.slice(2)

/** 扫描范围：各 forge 包的 lib 目录，排除测试与产物目录（口径写进上限文件，避免注释里出现通配符把本块注释提前关掉）。 */
function scanFiles(root = ROOT) {
  const out = []
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'out' || e.name === '__pycache__') continue
        walk(p)
        continue
      }
      if (!/\.(js|mjs)$/.test(e.name)) continue
      if (/\.test\.js$|\.test\.mjs$|\.d\.ts$/.test(e.name)) continue
      out.push(p)
    }
  }
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir)
    if (!fs.statSync(p).isDirectory()) continue
    if (dir.startsWith('forge-')) walk(path.join(p, 'lib'))
  }
  return out
}

/**
 * 生成物排除名单（ISS-653）。
 *
 * 为什么要有这一条：`lib/` 底下混着**构建产物**，判据量它就等于量第三方代码 —— 那种"债"永远还不掉
 * （下一次构建原样长回来）。实测样板：`forge-canvas/lib/canvas-core.js` 是 `bun scripts/build-core.mjs`
 * 的产物（入口 `src/core-entry.ts`、`external: []` ⇒ 内联 zod@3.25.76），其中 11 处 `throw new Error(...)`
 * 全是 zod 自己的，与「本仓代码该不该带 kind」无关。（同型前科：TC1 首跑 33 处里 30 处来自一个 1.9MB 的
 * esbuild 产物 —— 不排产物，数字就不是在量自己的代码。）
 *
 * 为什么**点名**而不是按行数/魔数猜：模糊规则（"大于 N 行"）会漏掉真手写的大文件、也会把这一条变成
 * 谁都不敢碰的黑盒。新增生成物时在这里加一条，并写明**是哪个脚本的产物** —— 写不出处所就不该排。
 *
 * 排除**不静默**：主流程会把「排了哪些文件、因此少算了多少处」打到输出里（静默排除 = 门禁看不见东西）。
 */
const GENERATED = [
  { file: 'forge-canvas/lib/canvas-core.js', from: 'forge-canvas/scripts/build-core.mjs（入口 src/core-entry.ts，内联 zod@3.25.76）' },
]

/** 按 rel 路径把扫描面切成「生成物 / 手写」两份。允许注入名单，供 selftest 在临时 fixture 上验证机制。 */
function splitGenerated(files, root = ROOT, allowed = new Set(GENERATED.map((g) => g.file))) {
  const gen = []
  const hand = []
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    ;(allowed.has(rel) ? gen : hand).push(f)
  }
  return { gen, hand }
}

const CODE_ONLY = (line) => !/^\s*(\/\/|\*|\/\*)/.test(line)
const pkgOf = (rel) => rel.split('/')[0]

const RULES = [
  {
    id: 'G1', spec: '§E1',
    why: 'host 半别再各写 console.*：无前缀、无级别开关、去向不可统一改。用 makeLogger(ctx, "<包名>")（forge-service-kit/log）',
    check: (c) => c.eachLine(({ file, line }) => {
      if (!CODE_ONLY(line)) return null
      const m = line.match(/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/)
      return m ? `console.${m[1]}` : null
    }),
  },
  {
    id: 'G2', spec: '§E8',
    why: '裸 throw 让上层只能按 message 猜。用 forge-agent-protocol 的 fail(kind, msg)，kind 词表 = FAIL_KINDS',
    check: (c) => c.eachLine(({ file, line }) => {
      if (!CODE_ONLY(line)) return null
      const m = line.match(/throw\s+new\s+(Error|TypeError|RangeError|SyntaxError)\s*\(/)
      return m ? `throw new ${m[1]}(` : null
    }),
  },
  {
    id: 'G3', spec: '§E2',
    why: 'ctx.logger 直调的那一路在本仓实测**不落 web.log**（没有 console exporter），排障时等于没写；要镜像请经 makeLogger',
    check: (c) => c.eachLine(({ file, line }) => {
      if (!CODE_ONLY(line)) return null
      const m = line.match(/ctx\.logger\s*[?[]?\.\s*(info|warn|error|debug)\s*[?(]/)
      return m ? `ctx.logger.${m[1]}` : null
    }),
  },
]

function build(filesOverride, rootOverride) {
  return createLint({
    name: 'lint-log-outlet',
    root: rootOverride || ROOT,
    // 不给 filesOverride 时 = 真实仓库的手写面（扫描面减去 GENERATED）
    files: filesOverride ? () => filesOverride : () => splitGenerated(scanFiles(ROOT)).hand,
    rules: RULES,
    whitelist: {},
  })
}

/** 手工算 counts（selftest 与主流程共用一条路径，避免两套口径） */
function computeCounts(lint) {
  const res = lint.run()
  return { res, counts: countByRulePackage(res.findings, (f) => pkgOf(f.file)) }
}

/* ───────────────────────────── selftest ───────────────────────────── */
function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-outlet-selftest-'))
  const real = fs.realpathSync(dir) // macOS 的 /var 本身是软链，不 realpath 会算出两个包名
  const pkg = path.join(real, 'forge-demo')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'lib', 'a.js'), [
    'export function f(ctx) {',
    '  console.log("一行")',
    '  // console.log 写在注释里不该算',
    '  ctx.logger?.warn("直接调镜像")',
    '  throw new Error("裸 throw")',
    '}',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(pkg, 'lib', 'a.test.js'), 'console.log("测试文件不该被扫")\n')
  const files = [path.join(pkg, 'lib', 'a.js')]
  const lint = build(files, real)
  const { counts } = computeCounts(lint)

  const cases = []
  const push = (name, ok, note = '') => cases.push({ name, ok, note })

  push('G1 只数代码行（注释那行不算）', (counts.G1 || {})['forge-demo'] === 1, JSON.stringify(counts.G1 || {}))
  push('G2 抓到裸 throw', (counts.G2 || {})['forge-demo'] === 1)
  push('G3 抓到 ctx.logger 直调', (counts.G3 || {})['forge-demo'] === 1)
  push('测试文件不进扫描面', !JSON.stringify(counts).includes('测试'))

  const caps = { G1: { 'forge-demo': 1 }, G2: { 'forge-demo': 1 }, G3: { 'forge-demo': 1 } }
  push('等于上限 → 不红', compareCeilings(counts, caps).over.length === 0)
  const tightened = { ...caps, G1: { 'forge-demo': 0 } }
  const t = compareCeilings(counts, tightened)
  push('收紧一格就红（有牙）', t.over.length === 1 && t.over[0].rule === 'G1', JSON.stringify(t.over))
  push('当前值低于上限 → under 但不红', (() => {
    const r = compareCeilings(counts, { G1: { 'forge-demo': 5 } })
    return r.under.length === 1 && r.over.length === 0
  })())
  push('上限里登记了已消失的包 → ghost 提示而非红', (() => {
    const r = compareCeilings(counts, { G1: { 'forge-gone': 3 } })
    return r.ghost.length === 1 && r.over.length === 0
  })())
  // 反向：规则真会随内容变红 —— 追加一行 console，G1 应变成 2
  fs.appendFileSync(path.join(pkg, 'lib', 'a.js'), 'console.warn("新增的一处")\n')
  const again = computeCounts(build(files, real))
  push('新增一行 console 立刻多算一格', again.counts.G1['forge-demo'] === 2 && compareCeilings(again.counts, caps).over.length === 1)

  // 生成物排除：只排**名单内**的文件 —— 名单外同内容文件仍算数（排除不许变成"整类免检"）
  const genFile = path.join(pkg, 'lib', 'gen.js')
  fs.writeFileSync(genFile, 'throw new Error("生成物里的裸 throw")\n')
  const 名单 = new Set([path.relative(real, genFile).split(path.sep).join('/')])
  const 切 = splitGenerated([path.join(pkg, 'lib', 'a.js'), genFile], real, 名单)
  push('生成物按名单切分（名单内进 gen、名单外仍进手写面）', 切.gen.length === 1 && 切.hand.length === 1)
  const 手写G2 = computeCounts(build(切.hand, real)).counts.G2['forge-demo']
  const 全量G2 = computeCounts(build([...切.hand, ...切.gen], real)).counts.G2['forge-demo']
  push('排除真让计数下降（不是空转）', 全量G2 === 手写G2 + 1, `全量=${全量G2} 手写=${手写G2}`)
  fs.rmSync(genFile, { force: true })

  fs.rmSync(dir, { recursive: true, force: true })
  const fails = cases.filter((c) => !c.ok)
  console.log('lint-log-outlet --selftest（临时 fixture，不扫真实仓库）')
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.note ? '（' + c.note + '）' : ''}`)
  console.log(fails.length ? `\n✗ 反向验证失败 ${fails.length}/${cases.length} 项` : `\n✓ ${cases.length}/${cases.length} 项通过：该红能红、等上限不红、注释与测试文件不误伤、改进不被罚`)
  return fails.length ? 1 : 0
}

/* ───────────────────────────── 主流程 ───────────────────────────── */
if (ARGV.includes('--selftest')) process.exit(selftest())

if (!fs.existsSync(BASELINE) && !ARGV.includes('--write')) {
  console.error('✗ 缺上限文件 scripts/baseline/log-outlet.json —— 先跑 --write 建立基线（第一次跑必须有人看一眼再录）')
  process.exit(2)
}
const saved = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { ceilings: {} }
// 扫描面切两份：手写面进判据；生成物名单外的部分只用来报「排掉了多少处」（不静默排除）
const SCANNED = scanFiles()
const { gen, hand } = splitGenerated(SCANNED)
const { res, counts } = computeCounts(build(hand))
const 排除命中 = computeCounts(build(gen)).counts
const 排除处数 = Object.values(排除命中).reduce((a, by) => a + Object.values(by).reduce((x, y) => x + y, 0), 0)
const { over, under, ghost } = compareCeilings(counts, saved.ceilings || {})

if (ARGV.includes('--write')) {
  const prev = saved.ceilings || {}
  fs.writeFileSync(BASELINE, JSON.stringify({
    recordedAt: new Date().toISOString().slice(0, 10),
    tool: 'lint-log-outlet.mjs --write',
    scope: 'forge-*/lib 下非测试 .js/.mjs 的手写文件（GENERATED 名单内的生成物不计）；只数代码行（注释不计）',
    ceilings: ceilingsFrom(counts),
  }, null, 1) + '\n')
  const changed = []
  for (const [rule, pkgs] of Object.entries(counts)) {
    for (const [pkg, n] of Object.entries(pkgs)) if ((prev[rule] && prev[rule][pkg]) !== n) changed.push(`${rule}/${pkg}: ${prev[rule] ? prev[rule][pkg] : '新'} → ${n}`)
  }
  console.log(`✓ 上限已录：${Object.keys(counts).length} 条规则 · 变化 ${changed.length} 条`)
  for (const c of changed.slice(0, 40)) console.log('  · ' + c)
  process.exit(0)
}

const total = Object.values(counts).reduce((a, by) => a + Object.values(by).reduce((x, y) => x + y, 0), 0)
const 排除明细 = GENERATED.filter((g) => gen.some((f) => path.relative(ROOT, f).split(path.sep).join('/') === g.file))
if (ARGV.includes('--json')) {
  console.log(JSON.stringify({
    counts, over, under: under.length, ghost: ghost.length, findings: res.findings.length,
    excluded: { files: 排除明细.map((g) => g.file), hits: 排除处数, why: 排除明细.map((g) => `${g.file} ← ${g.from}`) },
  }, null, 1))
  process.exit(over.length ? 1 : 0)
}

console.log(`lint-log-outlet · 扫 ${hand.length} 文件 · 命中 ${total}（G1 console · G2 裸 throw · G3 ctx.logger 直调）`)
// 排除不静默：排了哪些文件、各是谁的产物、因此少算了几处 —— 都打在输出里
if (排除明细.length) {
  console.log(`  排除生成物 ${排除明细.length} 个文件 / ${排除处数} 处（不计入上限）：`)
  for (const g of 排除明细) console.log(`    · ${g.file} ← ${g.from}`)
}
for (const o of over) console.log(`  ✗ ${o.rule} ${o.pkg} 新增到 ${o.count} / 上限 ${o.cap} —— 改用它：${RULES.find((r) => r.id === o.rule).why}`)
if (ARGV.includes('--verbose')) {
  const top = Object.entries(counts).flatMap(([rule, pkgs]) => Object.entries(pkgs).map(([pkg, n]) => ({ rule, pkg, n })))
    .sort((a, b) => b.n - a.n).slice(0, 12)
  console.log('  当前大头：' + top.map((t) => `${t.rule}/${t.pkg}=${t.n}`).join(' '))
}
for (const u of under.slice(0, 10)) console.log(`  ↓ ${u.rule} ${u.pkg} ${u.count} / 上限 ${u.cap}（可收线，跑 --write）`)
for (const g of ghost.slice(0, 10)) console.log(`  ⚑ ${g.rule} ${g.pkg} 已不再触犯（上限里还留着 ${g.cap}），跑 --write 收掉`)
console.log(over.length ? `\n✗ ${over.length} 项超上限 —— 新增一处就要在提交里说明；确要放宽请改判据本身，别抬上限` : `\n✓ 无新增（${under.length} 项可收线 · ${ghost.length} 项已清零）`)
process.exit(over.length ? 1 : 0)
