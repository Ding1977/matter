#!/usr/bin/env node
// scripts/dead-code-ledger.mjs
// 死码账本（ISS-723 的第一段：**只分类、只定性，不删一行代码**）
//
// 输入 = `scripts/baseline/dead-exports.json`（ISS-732 落的符号级零引用清单，成员与度量 Z2 同源）
//       + 一次 `git log` 扫描得到的"文件最近动过"表。
// 输出 = `docs/code-dead-code-ledger.md`（工具生成，顶部写复算命令）+ stdout 摘要。
//
// 为什么要单独一份账本而不是一张名单：删除决定的难度不在"有没有人 import"，而在
//   ① 这条是不是**双计**（.d.ts 与实现文件是同一批名字）；
//   ② 是不是**引擎按名装配**（机器看不见引用，删了就掉功能）；
//   ③ 最近有没有人动过（刚写的导出多半是"接入方还没来"，不是死码 —— 本仓 S3 内核就是这个形态）；
//   ④ 它在 host 半还是 client 半（host 侧导出常经装配/patch 生效，误删代价与表现形式不同）。
//   所以账本按这四轴分桶，把"该不该删"变成**一桶一桶地判**，而不是 817 条一起看。
//
// ⚠️ 口径边界（写死在这里，别让读者误以为这是全量死码清单）：
//   · 不含 `export default`（Z2 对它无判据）；不含动态/反射使用；`import type` 早就算消费者；
//   · 文件级（度量 Z1）的名单**已有**：`dead-exports.json` 的 `files` 段（ISS-732 产物自带，判据同源）⇒ 本账本直接渲染它
//     ——已记进 ISS-723，不在这批顺手加（那会动 `code-inventory.mjs` 的行数预算，它贴着 K2a 红线）。
//
// 用法：node scripts/dead-code-ledger.mjs [--write|--json|--selftest] [--now <ISO>]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const IN = path.join(ROOT, 'scripts', 'baseline', 'dead-exports.json')
const OUT = path.join(ROOT, 'docs', 'code-dead-code-ledger.md')
const ARGV = process.argv.slice(2)
const argvVal = (n, d) => { const i = ARGV.indexOf(n); return i < 0 ? d : ARGV[i + 1] }
const DAY = 86400

/** 一次 git log 扫描 ⇒ 文件相对路径 → 最后一次被碰的 unix 秒（不看内容，只看是否出现在提交里） */
function lastTouchFromGit(scopeDays = 730) {
  const map = new Map()
  try {
    const out = execFileSync('git', ['log', `--since=${scopeDays} days ago`, '--name-only', '--pretty=format:@%ct'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28,
    })
    let ts = 0
    for (const line of out.split('\n')) {
      const l = line.trim()
      if (!l) continue
      if (l.startsWith('@')) { ts = Number(l.slice(1)) ; continue }
      if (ts && !map.has(l)) map.set(l, ts) // 提交从新到旧 ⇒ 第一次出现就是最近一次
    }
  } catch {
    // 拿不到 git 记录不能静默当"全部都没动过"：那是把"判不了"伪装成结论（同 K9 一档的错）
    return null
  }
  return map
}

/**
 * 纯分类函数（selftest 直接喂数据）。
 * @param {Array<{pkg:string,file:string,line:number,name:string,kind:string,flags:string[]}>} items
 * @param {Map<string,number>|null} touch 文件 → 最近动过的秒；null = git 不可用
 * @param {number} nowSec
 */
function classifyLedger(items, touch, nowSec) {
  const rows = items.map((e) => {
    const bucket = e.flags.includes('declFile') ? 'A-dts双计'
      : e.flags.includes('entryFile') ? 'B-按名装配'
      : e.flags.includes('stringRef') ? 'C-字符串可见'
      : 'D-真候选'
    const half = /(^|\/)lib\//.test(e.file) ? 'host' : /(\/src\/|\/surfaces\/|\/components\/)/.test(e.file) ? 'client' : 'other'
    let fresh = '无 git 记录'
    if (touch) {
      const t = touch.get(e.file)
      if (!t) fresh = '>2 年'
      else {
        const d = Math.floor((nowSec - t) / DAY)
        fresh = d <= 30 ? '≤30 天' : d <= 90 ? '31-90 天' : d <= 365 ? '91-365 天' : '>365 天'
      }
    }
    return { ...e, bucket, half, fresh }
  })
  const tally = (key) => {
    const m = new Map()
    for (const r of rows) {
      const k = typeof key === 'function' ? key(r) : r[key]
      m.set(k, (m.get(k) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }
  return { rows, byBucket: tally('bucket') }
}

/**
 * 文件级一节（纯函数 ⇒ 能被自检直接喂数据）：产物里有 `files` 段就出表；没有就**显式说这一档缺席**。
 * 缺席不等于 0 —— 照 §8 那套纪律：判不了要说话，不许把"没数据"读成"没有死文件"。
 * @param {Array<{pkg:string,file:string,lines:number,half:string}>|undefined} files
 */
function fileSection(files) {
  if (!Array.isArray(files) || !files.length) {
    return [
      '## 三、文件级（整个文件都没人 import · 度量 Z1 同源）',
      '',
      '> ⚠️ **本产物里没有 `files` 段**（多半是旧版盘点器落的）。缺席不是 0：先跑 `node scripts/code-inventory.mjs --write-dead-exports` 重落一份再判。',
      '',
    ]
  }
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1)
  const byPkg = new Map(), byHalf = new Map()
  for (const f of files) { bump(byPkg, f.pkg); bump(byHalf, f.half || 'other') }
  const flat = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => k + ' ' + v).join(' · ')
  const big = [...files].sort((a, b) => (b.lines || 0) - (a.lines || 0) || a.file.localeCompare(b.file)).slice(0, 12)
  return [
    '## 三、文件级（整个文件都没人 import · 度量 Z1 同源）',
    '',
    '共 **' + files.length + ' 个文件**。按包：' + flat(byPkg),
    '',
    '按半区：' + flat(byHalf) + ' —— host 侧的删除代价与表现不同（装配面可能按名取整个文件），先看第一节 B 桶那条理由。',
    '',
    '| 最大的 12 个（行数 = 白占的维护面） | 行数 | 半区 |',
    '|---|---|---|',
    ...big.map((f) => '| ' + f.file + ' | ' + f.lines + ' | ' + f.half + ' |'),
    '',
  ]
}

/* ─────────────────── selftest（fixture 喂纯函数，不碰真仓库） ─────────────────── */
function selftestLedger() {
  const cases = []
  const push = (n, ok, note = '') => cases.push({ n, ok: !!ok, note })
  const items = [
    { pkg: 'forge-db', file: 'forge-db/src/view.d.ts', line: 3, name: 'T1', kind: 'interface', flags: ['declFile'] },
    { pkg: 'forge-pm', file: 'forge-pm/lib/index.js', line: 9, name: 'runThing', kind: 'function', flags: ['entryFile'] },
    { pkg: 'forge-ui', file: 'forge-ui/src/x.ts', line: 4, name: 'helper', kind: 'function', flags: ['stringRef'] },
    { pkg: 'forge-service-kit', file: 'forge-service-kit/lib/fs.js', line: 7, name: 'writeMe', kind: 'function', flags: [] },
    { pkg: 'forge-canvas', file: 'forge-canvas/scripts/demo-core.js', line: 2, name: 'drawMe', kind: 'function', flags: [] },
  ]
  const nowSec = 1700000000
  const touch = new Map([['forge-ui/src/x.ts', nowSec - 10 * DAY], ['forge-service-kit/lib/fs.js', nowSec - 400 * DAY]])
  const r = classifyLedger(items, touch, nowSec)
  const find = (name) => r.rows.find((x) => x.name === name)
  push('四个桶各归一处（dts / 按名装配 / 字符串 / 真候选）', find('T1').bucket === 'A-dts双计' && find('runThing').bucket === 'B-按名装配' && find('helper').bucket === 'C-字符串可见' && find('writeMe').bucket === 'D-真候选')
  push('半区判定按路径（lib=host / src=client / 其余=other）', find('runThing').half === 'host' && find('helper').half === 'client' && find('T1').half === 'client' && find('drawMe').half === 'other')
  push('新鲜度分档（≤30 天 / >365 天 / git 里没有 = >2 年）', find('helper').fresh === '≤30 天' && find('writeMe').fresh === '>365 天' && find('T1').fresh === '>2 年')
  push('git 不可用时不假装"没动过"，写"无 git 记录"', classifyLedger(items, null, nowSec).rows.every((x) => x.fresh === '无 git 记录'))
  push('桶计数与总数对得上（不增不删）', r.byBucket.reduce((s, [, n]) => s + n, 0) === items.length)
  const docA = fileSection([{ pkg: 'forge-x', file: 'forge-x/lib/a.js', lines: 30, half: 'host' }, { pkg: 'forge-x', file: 'forge-x/src/b.ts', lines: 8, half: 'client' }]).join('\n')
  push('文件级：有 files 时出表（总数 / 半区 / 按包都算对）', docA.includes('共 **2 个文件**') && docA.includes('host 1') && docA.includes('client 1') && docA.includes('forge-x/lib/a.js'))
  const docB = fileSection(undefined).join('\n')
  push('文件级：产物没 files 段时明说"缺席不是 0"（不静默当没有）', docB.includes('缺席不是 0') && !docB.includes('共 **0'))
  push('同输入两次跑结果一致（可复算）', JSON.stringify(classifyLedger(items, touch, nowSec).rows) === JSON.stringify(r.rows))
  let bad = 0
  console.log('dead-code-ledger --selftest（内建 fixture，不扫真实仓库）')
  for (const c of cases) { console.log(`  ${c.ok ? '✓' : '✗'} ${c.n}${c.note ? '（' + c.note + '）' : ''}`); if (!c.ok) bad++ }
  console.log(bad ? `\n✗ 反向验证失败 ${bad}/${cases.length}` : `\n✓ ${cases.length}/${cases.length} 项通过：四轴分桶各有归属、git 缺席不伪装成结论`)
  return bad ? 1 : 0
}
if (ARGV.includes('--selftest')) process.exit(selftestLedger())

/* ─────────────────────────── 生成账本 ─────────────────────────── */
if (!fs.existsSync(IN)) { console.error(`✗ 缺输入 ${path.relative(ROOT, IN)} —— 先跑 node scripts/code-inventory.mjs --write-dead-exports`); process.exit(2) }
const data = JSON.parse(fs.readFileSync(IN, 'utf8'))
const nowSec = argvVal('--now') ? Math.floor(new Date(argvVal('--now')).getTime() / 1000) : Math.floor(Date.now() / 1000)
const touch = lastTouchFromGit()
if (!touch) console.error('! git log 不可用 ⇒ 新鲜度一律记"无 git 记录"，不当结论用')
const { rows, byBucket } = classifyLedger(data.items, touch, nowSec)
const tallyBy = (pred, key) => {
  const m = new Map()
  for (const r of rows.filter(pred)) {
    const k = key(r)
    m.set(k, (m.get(k) || 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}
const d = rows.filter((r) => r.bucket === 'D-真候选')
const L = []
L.push('# 死码账本（符号级 · 只分类不删除）')
L.push('')
L.push('> **工具生成，别手改**：`node scripts/dead-code-ledger.mjs --write`（复算口径 = `scripts/baseline/dead-exports.json` 的 ' + data.items.length + ' 条，成员与度量 Z2 同源 · ISS-732）。')
L.push('> 本文件回答的是"**这堆零引用导出各自属于哪种情形**"，不是"哪些可以删"。删除决定归 ISS-723 后续批次 + 老板点头。')
L.push('')
L.push('## 一、四个分桶（先说清每一桶为什么不能一起删）')
L.push('')
L.push('| 桶 | 条数 | 为什么不能直接删 |')
L.push('|---|---|---|')
const WHY = {
  'A-dts双计': '`*.d.ts` 里的名字与实现文件是**同一批**（同一符号计了两次）⇒ 先并掉，不是删除候选',
  'B-按名装配': '引擎按名字取用（插件入口 / 工具注册表）⇒ 静态 import 看不见，删了直接掉功能',
  'C-字符串可见': '名字在全仓字符串里出现过（可能动态 import / 配置表 / 反射），也可能是巧合 ⇒ 要去人过一眼',
  'D-真候选': '静态分析里没人取用、也没上面三种噪声 ⇒ 只有这一桶值得逐条判"该不该删"',
}
for (const [b, n] of byBucket) L.push(`| ${b} | ${n} | ${WHY[b] || ''} |`)
L.push('')
L.push(`合计 ${rows.length} 条（= 度量 Z2 第二段的 ${data.totals.zeroRef}；两边同源，不会出现两份数）。`)
L.push('')
L.push('## 二、真候选桶（D）再按三轴切')
L.push('')
L.push('| 轴 | 分布 |')
L.push('|---|---|')
L.push('| 半区 | ' + tallyBy((r) => r.bucket === 'D-真候选', (r) => r.half).map(([k, v]) => `${k} ${v}`).join(' · ') + ' |')
L.push('| 声明类型 | ' + tallyBy((r) => r.bucket === 'D-真候选', (r) => r.kind || 'unknown').map(([k, v]) => `${k} ${v}`).join(' · ') + ' |')
L.push('| 最近动过 | ' + tallyBy((r) => r.bucket === 'D-真候选', (r) => r.fresh).map(([k, v]) => `${k} ${v}`).join(' · ') + ' |')
L.push('')
L.push('按包（D 桶 top 12）：' + tallyBy((r) => r.bucket === 'D-真候选', (r) => r.pkg).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(' · '))
L.push('')
for (const line of fileSection(data.files)) L.push(line)
L.push('## 四、读这张表的人要知道的三件事')
L.push('')
L.push('1. **"最近动过"排在"删"前面**：S3 这几批刚往内核沉了广播器 / 原子写 / 日志出口，那一串导出**本来就是留给接入方的口子**（`forge-model`/`forge-canvas` 没声明依赖 ⇒ 接它们要 bun.lock 窗口，见 ISS-718/717 后半）。近 90 天动过的条目按定义不是死码，是从未接上的活口子。')
L.push('2. **类型/接口（`type` / `interface`）占比高的包要单独判**：契约包（`forge-agent-protocol` / `forge-design`）的类型被跨包按名引用时，机器看得见 import 但看不见"人在文档里叫它"，删之前先确认它不是对外契约。')
L.push('3. **文件级（§三）只是"没人 import"的名单，不是"可以删"的名单**：Z1 底层没有"字符串可见"这一层（Z2 有），构建入口 / 测试 preload / 独立注入脚本都会假阳性 —— 实测 5 个（ISS-723 第一批已逐个点名，见 `docs/code-dead-code-disposition.md`）。**逐条定性的结论在那边，本文件只出事实。**')
L.push('')
if (ARGV.includes('--json')) console.log(JSON.stringify({ buckets: Object.fromEntries(byBucket), dRows: d.length }, null, 1))
else if (ARGV.includes('--write')) { fs.writeFileSync(OUT, L.join('\n') + '\n'); console.log(`✓ 已写 ${path.relative(ROOT, OUT)}（${rows.length} 条分类 · D 真候选 ${d.length}）`) }
else {
  console.log(`dead-code-ledger · ${rows.length} 条 · ` + byBucket.map(([b, n]) => `${b} ${n}`).join(' · '))
  console.log(`  账本产物要落盘：node scripts/dead-code-ledger.mjs --write${touch ? '' : '（当前 git log 不可用：新鲜度会全记"无 git 记录"）'}`)
  process.exit(0)
}
