// 审计稿生成块 ↔ 基线：同一份测量的两份产物，必须一直同源（ISS-753）
//
// 为什么需要它：`code-inventory.mjs --baseline-save` 分支曾经无条件 `process.exit(0)`，
// 把排在后面的 `--write-audit` 整块跳掉 ⇒ 基线记成 861 个源文件，`docs/code-audit.md` 还写着 860。
// 文档里那句「数字只能由本命令产生」（防腐条款）成立的前提是**这条命令不会漏产**，
// 而脚本内部的先后顺序一旦再被挪动，同一个坑还会回来 —— 所以补一道事后交叉判据。
//
// 判据有两族，都**只读已落盘产物、不重跑扫描** ⇒ 微秒级，可常驻 guard：
//   第一族（ISS-753）审计稿 ↔ 基线：
//   ① 生成块表格里每个度量 id 的「值」逐字符等于基线 json 同 id 的 value；
//   ② 「取值手段」行「真解析 N 个源文件」的 N 等于基线 header.filesScanned；
//   ③ 两边 id 名册互不差项（文档多出 = 手改，基线多出 = 复录时没写全）。
//   第二族（ISS-761）基线 ↔ 三份侧产物：14 条等式 + 6 条「清单与自己的总数自洽」，
//   等式出处抄自生成器自己打印的口径（Z2/D2/D3/H5b/C8/C9/C9b/C9d/C10 ↔ dead-exports / dup-detail / route-literals）。
//   为什么要有第二族：复录是 `--baseline-save --write-audit --write-dead-exports --write-route-ledger --write-dup-detail`
//   再加一条 `k6a-screen --write`，**少跑一半不会有人报**（09-23 实测连漏两次，`clusterFns` 差了 13 个函数）。
// 三种红都可能是「无害的」（比如只改了文档没复录），但**分家本身**就是要拦的状态 ⇒ 一律 exit 2。
//
// 用法：node scripts/audit-doc-sync.mjs [--check]（默认） | --selftest（合成夹具，验两条族的红绿路径都能红）
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASE = path.join(ROOT, 'scripts', 'baseline', 'code-inventory.json')
const DOC = path.join(ROOT, 'docs', 'code-audit.md')
// 三份侧产物（第四份 k6a-screen.json 自己有 --check 且是逐字节重算，不在这里重复）
const DEAD = path.join(ROOT, 'scripts', 'baseline', 'dead-exports.json')
const ROUTES = path.join(ROOT, 'scripts', 'baseline', 'route-literals.json')
const DUP = path.join(ROOT, 'scripts', 'baseline', 'dup-detail.json')
const OPEN = '<!-- code-inventory:begin'
const CLOSE = '<!-- code-inventory:end -->'

/** 从基线 json 文本取 {filesScanned, metrics:[{id,value}]} */
function fromBaseline(txt) {
  const j = JSON.parse(txt)
  return { files: j.header.filesScanned, rows: j.metrics.map((m) => ({ id: m.id, v: String(m.value) })) }
}

/** 从文档生成块取 {filesScanned|null, metrics}：表格行 `| ID | 度量 | 值 | 门禁 |`，值取第 3 列。
 *  切列只切**未转义**的 `|`，切完把 `\|` 还原回 `|` —— 度量标题里合法存在 `|| true`（E5），
 *  生成器会转义成 `\|\|`，这里不还原就会假报分家。 */
function fromDoc(txt) {
  const i = txt.indexOf(OPEN), j = txt.indexOf(CLOSE)
  if (i < 0 || j < 0) return { missing: true, rows: [], files: null }
  const block = txt.slice(i, j)
  const head = block.match(/真解析 (\d+) 个源文件/)
  const rows = []
  for (const line of block.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|') || !t.endsWith('|')) continue
    const cells = t.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
    if (cells.length === 4 && /^[A-Z]\w*$/.test(cells[0])) rows.push({ id: cells[0], v: cells[2] })
  }
  return { files: head ? Number(head[1]) : null, rows }
}

/** 核心比对：返回违例行数组（空 = 同源）；纯函数 ⇒ 自检夹具不必碰真文件。
 *  ⚠️ 故意**不写 `export`**：本文件的 `--selftest` 就在同模块里调它，导出去没人 import，
 *  而度量 Z2 会把「导出但零引用」计一格 —— 实测 K10b 因此从 804 抬到 805（棘轮只许降）。 */
function diffDoc(base, doc) {
  if (doc.missing) return ['生成块成对标记缺失（OPEN/CLOSE 有一头找不到）']
  const out = []
  const bm = new Map(base.rows.map((r) => [r.id, r.v])), dm = new Map(doc.rows.map((r) => [r.id, r.v]))
  for (const [id, v] of bm) {
    if (!dm.has(id)) out.push(`${id} 基线有、文档无（复录时漏写或表格被手改）`)
    else if (dm.get(id) !== v) out.push(`${id} 文档「${dm.get(id)}」≠ 基线「${v}」`)
  }
  for (const id of dm.keys()) if (!bm.has(id)) out.push(`${id} 文档有、基线无（手改了文档）`)
  if (doc.files === null) out.push('「取值手段」行没有「真解析 N 个源文件」')
  else if (doc.files !== base.files) out.push(`源文件数 文档 ${doc.files} ≠ 基线 ${base.files}`)
  return out
}

/* ── 第二族判据：度量 ↔ 侧产物对账（ISS-761）───────────────────────────────
 * 为什么还要这一族：`--baseline-save` 与 `--write-audit` 是一起跑的（ISS-753 就是为它立的判据），
 * 但 `--write-dead-exports / --write-route-ledger / --write-dup-detail` 与 `k6a-screen --write`
 * 是**另外的 flag/脚本**。09-23 实测：连做两次复录都没写侧产物 ——
 * `dead-exports.exports` 停在 2784 而 Z2 已是 2786、`dup-detail.clusterFns` 停在 653 而 D3 已是 666，
 * 一片 ✓。清单滞后的真实代价不是数字难看，是**按清单去定位的人会点错行**
 * （ISS-739 的 K6a 点名、ISS-732 的死码账本、ISS-715 的端点归全都读这些文件）。
 *
 * 等式的出处不靠猜：全部抄自生成器自己打印的口径（`code-inventory.mjs:871-872` 里那些「=D2/=D3/=C9/=C9b/=C10/=H5b」），
 * 且**只比已落盘的两份数**，不重跑扫描 ⇒ 与 diffDoc 同档（微秒级，可常驻 guard）。 */
const PAIRS = [
  ['dead-exports', ['totals', 'exports'], 'Z2', 0],
  // ISS-654：Z2 第 2 段是**坏ness**（= 全量零引用 − entryFile 装载契约那批），K10b 的 take 也是第 2 段。
  //   此前这里比 zeroRef（全量），K10b 改用 badness 后两边必然分家 —— 等式要跟判据走，不是跟列表走。
  ['dead-exports', ['totals', 'zeroRefBadness'], 'Z2', 1],
  ['dead-exports', ['totals', 'zeroFiles'], 'Z1', null],
  ['dup-detail', ['totals', 'sameNameImpl'], 'D2', 0],
  ['dup-detail', ['totals', 'sameNameCrossPkg'], 'D2', 1],
  ['dup-detail', ['totals', 'dupClusters'], 'D3', 0],
  ['dup-detail', ['totals', 'clusterFns'], 'D3', 1],
  // ISS-672：H5b 量的是**处数**（`undeclaredSoft.length`，import 语句条数），不是对数。
  //   此处原配 `hoistingPairs`（对数）⇒ 两侧量的不是同一个东西。为什么一直没红：真仓 H5b 与
  //   hoistingPairs 长期都是 0，**等式在零值上恒成立**（fixture 里也是 `['H5b','0']` 且侧产物
  //   hoistingPairs: 0）⇒ 直到真出现 hoisting import（实测 3 处 / 2 对）才暴露。
  //   判据归属的三条独立证据：① code-inventory.mjs 的 H5b value = undeclaredSoft.length（处数）；
  //   ② dup-detail-lib.mjs 的 hoistingOnly = 处数求和、hoistingPairs = hoisting.length（对数）；
  //   ③ 该库自己的自检原文「H5b 条数 = hoistingOnly 站点数」。
  ['dup-detail', ['totals', 'hoistingOnly'], 'H5b', null],
  ['route-literals', ['totals', 'literals'], 'C8', 0],
  ['route-literals', ['totals', 'uniqPaths'], 'C8', 1],
  ['route-literals', ['totals', 'sameHalfCopies'], 'C9', null],
  ['route-literals', ['totals', 'crossPkgPaths'], 'C9b', null],
  ['route-literals', ['totals', 'alienPairs'], 'C10', null],
  ['route-literals', ['totals', 'danglingRefs'], 'C9d', null],
]
// 侧产物**自己内部**也要自洽（totals 说是 793 条，数组就得有 793 条）——
// 只比 totals 会放过「改了数没重生成清单」这一半，而拿去干活的是清单不是数。
const SELF_ARRAYS = [
  ['dead-exports', ['totals', 'zeroRef'], 'items'],
  ['dead-exports', ['totals', 'zeroFiles'], 'files'],
  ['dup-detail', ['totals', 'sameNameImpl'], 'sameNameImpl'],
  ['dup-detail', ['totals', 'dupClusters'], 'dupClusters'],
  ['route-literals', ['totals', 'sameHalfCopies'], 'sameHalf'],
  ['route-literals', ['totals', 'alienPairs'], 'alien'],
]
const pick = (o, pathArr) => pathArr.reduce((x, k) => (x == null ? undefined : x[k]), o)

/** @param {{rows:Map<string,string>}} base @param {Object<string, any|null>} arts 名字 → 解析后的 json（缺文件传 null） */
function diffArtifacts(base, arts) {
  const out = []
  for (const [artName, field, metricId, slot] of PAIRS) {
    const art = arts[artName]
    const mv = base.rows.get(metricId)
    if (mv === undefined) { out.push(`${metricId} 在基线里没有这一格（判据指向了不存在的度量）`); continue }
    if (!art) { out.push(`${artName}.json 读不到 ⇒ ${metricId} 无从对账（缺产物不等于对得上）`); continue }
    const av = pick(art, field)
    if (av === undefined) { out.push(`${artName}.${field.join('.')} 不存在 ⇒ 侧产物的形状变了，判据要跟着改`); continue }
    const want = slot === null ? mv : String(mv).split(' / ')[slot]
    if (String(av) !== String(want))
      out.push(`${metricId} 基线「${mv}」≠ ${artName}.${field.join('.')} ${av} ⇒ 侧产物没随这次复录重生成（或度量动了清单没动）`)
  }
  for (const [artName, field, arrKey] of SELF_ARRAYS) {
    const art = arts[artName]
    if (!art) continue // 上面已经报过缺文件
    const n = Array.isArray(art[arrKey]) ? art[arrKey].length : -1
    const v = pick(art, field)
    if (String(n) !== String(v)) out.push(`${artName}: 数组 ${arrKey} 有 ${n} 条，但 ${field.join('.')} 写着 ${v} ⇒ 清单与自己的总数都不自洽`)
  }
  return out
}

function selftest() {
  const rows = [{ id: 'B1', v: '30' }, { id: 'Z2', v: '2795 / 804 / 29%' }]
  const doc = (r, files) => ({ files, rows: r.map((x) => ({ ...x })) })

  const cases = [
    ['① 一致 ⇒ 绿', diffDoc({ files: 861, rows }, doc(rows, 861)).length === 0],
    ['② 值陈旧 ⇒ 红', diffDoc({ files: 861, rows }, doc([{ id: 'B1', v: '29' }, rows[1]], 861)).length === 1],
    ['③ 文档缺行 ⇒ 红', diffDoc({ files: 861, rows }, doc([rows[0]], 861)).length === 1],
    ['④ 文档多行（手改）⇒ 红', diffDoc({ files: 861, rows }, doc([...rows, { id: 'Q9', v: 'x' }], 861)).length === 1],
    ['⑤ 源文件数分家 ⇒ 红', diffDoc({ files: 861, rows }, doc(rows, 860)).length === 1],
    ['⑥ 成对标记丢了 ⇒ 红', diffDoc({ files: 861, rows }, { missing: true, rows: [], files: null }).length === 1],
    // 反向：解析器不能把别表当生成块 —— 造一份「块外还有一张表」的文档，块内只有两条
    ['⑦ 只读生成块（块外的表不算）⇒ 绿', fromDoc(`| X1 | 局外 | 1 | — |\n${OPEN}\n> 真解析 861 个源文件\n| B1 | x | 30 | — |\n| Z2 | y | 2795 / 804 / 29% | — |\n${CLOSE}`).rows.length === 2],
    // 真数据里 E5 的标题带 `|| true`：生成器转义成 `\|\|` 之后必须仍然认得（不认得就会假报分家）
    ['⑧ 未转义裸 `|` ⇒ 认不出这行（= 修生成器前的真实状态，判红）', diffDoc({ files: 861, rows: [{ id: 'E5', v: '200' }] }, fromDoc(`${OPEN}\n> 真解析 861 个源文件\n| E5 | 静默失败（|| true） | 200 | K9c |\n${CLOSE}`)).length === 1],
    ['⑨ 转义后 ⇒ 认得且同源（= 修完生成器的状态，判绿）', diffDoc({ files: 861, rows: [{ id: 'E5', v: '200' }] }, fromDoc(`${OPEN}\n> 真解析 861 个源文件\n| E5 | 静默失败（\\|\\| true） | 200 | K9c |\n${CLOSE}`)).length === 0],
  ]
  /* 侧产物那一族（ISS-761）：夹具的数一律与真基线同形（「2786 / 793 / 28%」这类多段值），
     免得判据只在理想形状下绿。数组用 new Array(n) 撑长度，内容不参与判据。 */
  const base = {
    rows: new Map([
      ['Z1', '41'], ['Z2', '2786 / 793 / 28%'], ['D2', '236 / 112'], ['D3', '73 / 666'],
      ['H5b', '3'], ['C8', '341 / 193 / 15'], ['C9', '10'], ['C9b', '18'], ['C9d', '1'], ['C10', '19'],
    ]),
  }
  const arts = () => ({
    'dead-exports': { totals: { exports: 2786, zeroRef: 793, zeroRefBadness: 793, zeroFiles: 41 }, items: new Array(793), files: new Array(41) },
    'dup-detail': { totals: { sameNameImpl: 236, sameNameCrossPkg: 112, dupClusters: 73, clusterFns: 666, hoistingOnly: 3, hoistingPairs: 2 }, sameNameImpl: new Array(236), dupClusters: new Array(73) },
    'route-literals': { totals: { literals: 341, uniqPaths: 193, sameHalfCopies: 10, crossPkgPaths: 18, alienPairs: 19, danglingRefs: 1 }, sameHalf: new Array(10), alien: new Array(19) },
  })
  const artCases = (mutate, want) => {
    const a = arts()
    mutate(a)
    const got = diffArtifacts(base, a)
    return got.length === want.n && (want.includes ? got.every((l) => l.includes(want.includes)) : true)
  }
  cases.push(
    ['⑩ 侧产物与度量同源 ⇒ 绿（阳性对照：全填对时必须 0 条）', diffArtifacts(base, arts()).length === 0],
    ['⑪ dead-exports.exports 滞后 2 ⇒ 恰好 1 条、且点名的正是 Z2 那一格',
      artCases((a) => { a['dead-exports'].totals.exports = 2784 }, { n: 1, includes: 'Z2' })],
    ['⑫ dup-detail.clusterFns 滞后 13 ⇒ 恰好 1 条、点名 D3',
      artCases((a) => { a['dup-detail'].totals.clusterFns = 653 }, { n: 1, includes: 'D3' })],
    ['⑬ route-literals 的 literals 与 C8 分家 ⇒ 恰好 1 条、点名 C8',
      artCases((a) => { a['route-literals'].totals.literals = 340 }, { n: 1, includes: 'C8' })],
    ['⑭ 侧产物缺文件 ⇒ 必须报（缺产物不等于对得上），不许静默绿',
      // 注意覆盖顺序：`{a:null, ...arts()}` 会被后面的同名键盖回去（这一版测试就是这么假绿过一次的）
      diffArtifacts(base, { ...arts(), 'dead-exports': null }).length >= 1
      && diffArtifacts(base, { ...arts(), 'dead-exports': null }).every((l) => l.includes('读不到'))],
    ['⑮ 清单与自己的 totals 不自洽 ⇒ 单独能红（只比 totals 会放过这一半）',
      artCases((a) => { a['dead-exports'].items = new Array(700) }, { n: 1, includes: '不自洽' })],
    /* ISS-672：H5b 配错列的回归钉。fixture 里 hoistingOnly=3 / hoistingPairs=2 **故意不同** ——
       旧版两边都是 0，等式恒成立，所以这个缺陷从 ISS-761 起一直绿。把配对改回 hoistingPairs 时，
       本条与 ⑩ 会同时红（⑰ 红是因为 2≠3，⑩ 红是因为阳性对照不再是 0 条）。 */
    ['⑰ H5b 认的是处数（hoistingOnly）不是对数：对数故意写错不许假绿、处数写错必须红',
      (() => {
        // 只喂 H5b 这一格：其余 PAIRS 需要的度量不在这份 base 里 ⇒ 必须先滤出 H5b 那一条，否则混进无关报错
        const h = (totals) => diffArtifacts({ rows: new Map([['H5b', '3']]) }, { 'dup-detail': { totals } }).filter((l) => l.includes('H5b'))
        const ok = h({ hoistingOnly: 3, hoistingPairs: 99 })            // 处数对、对数故意乱写 ⇒ 不许红
        const bad = h({ hoistingOnly: 2, hoistingPairs: 3 })            // 处数错、对数正好等于 3 ⇒ 必须红（配错列就抓到这里）
        return ok.length === 0 && bad.length === 1
      })()],
    ['⑯ 度量改了名/删了 ⇒ 判据自己先报，不拿「对上了」糊过去',
      diffArtifacts({ rows: new Map([['Z2', '2786 / 793 / 28%']]) }, arts()).some((l) => l.includes('没有这一格'))],
  )
  let bad = 0
  for (const [name, ok] of cases) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) bad++ }
  console.log(`audit-doc-sync selftest ${cases.length - bad}/${cases.length} 通过`)
  return bad ? 2 : 0
}

if (process.argv.includes('--selftest')) process.exit(selftest())

// 真判据
if (!fs.existsSync(BASE) || !fs.existsSync(DOC)) {
  console.error(`✗ 缺产物：${fs.existsSync(BASE) ? '' : BASE + ' '}${fs.existsSync(DOC) ? '' : DOC}（先跑一次合并复录）`)
  process.exit(2)
}
const base = fromBaseline(fs.readFileSync(BASE, 'utf8'))
const docTxt = fs.readFileSync(DOC, 'utf8')
const doc = fromDoc(docTxt)
const bad = diffDoc(base, doc)
// 侧产物：读不到也要进判据（当成 null 让 diffArtifacts 报「缺产物」，而不是在这里静默跳过）
const arts = {}
for (const [name, file] of [['dead-exports', DEAD], ['route-literals', ROUTES], ['dup-detail', DUP]]) {
  try { arts[name] = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { arts[name] = null }
}
const artBad = diffArtifacts({ rows: new Map(base.rows.map((r) => [r.id, r.v])) }, arts)
if (bad.length || artBad.length) {
  if (bad.length) {
    console.log(`✗ 审计稿与基线分了家（${bad.length} 处 · ISS-753）`)
    for (const b of bad.slice(0, 12)) console.log(`   · ${b}`)
    if (bad.length > 12) console.log(`   · …另有 ${bad.length - 12} 处`)
  }
  if (artBad.length) {
    console.log(`✗ 基线与侧产物分了家（${artBad.length} 处 · ISS-761 —— 复录只跑一半就会到这里报）`)
    for (const b of artBad.slice(0, 12)) console.log(`   · ${b}`)
    if (artBad.length > 12) console.log(`   · …另有 ${artBad.length - 12} 处`)
  }
  console.log('   → 复录一条命令全落：node scripts/code-inventory.mjs --baseline-save --write-dead-exports --write-route-ledger --write-dup-detail --write-audit docs/code-audit.md')
  console.log('     再补一条（第四份侧产物不归 code-inventory 管，且必须在 --write-dup-detail **之后**跑：它读 dup-detail）：node scripts/k6a-screen.mjs --write')
  console.log('     ⚠️ 要在**主 checkout** 跑（工作树的 symlink 与生成文件会让 B7/N7 记下不同的数）')
  process.exit(2)
}
console.log(`✓ 审计稿与基线同源（${base.rows.length} 项度量 · ${base.files} 个源文件 · 生成块与基线出自同一份测量）· 侧产物 ${PAIRS.length + SELF_ARRAYS.length} 处等式对上（${Object.keys(arts).join(' / ')}）`)
