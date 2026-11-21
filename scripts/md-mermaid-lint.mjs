#!/usr/bin/env node
// scripts/md-mermaid-lint.mjs
// Markdown 里 mermaid 块的**结构法**校验（ISS-935 的第一半 · DOC-334 T9）
//
// 用法：node scripts/md-mermaid-lint.mjs [--check] [--file <md>…] [--selftest] [--verbose]
//   exit 0 全过 · exit 2 有违例 · exit 3 没给输入
//
// 它管什么：块级结构配平 —— 图类型头、subgraph/end 与 alt/loop/end 的配对、方括号与引号成对、
//   孤立箭头行。这些正是"文档里手改图"最常坏的（我自己改 DOC-334 的分层图时就差点把 end 数错）。
// 它不管什么（**写清楚，别让人以为全管**）：语法合法性与渲染。mermaid.parse 要真 DOM，
//   而本仓没有 jsdom/puppeteer/playwright 任何一个（09-29 实测）⇒ 那一半需要先定「为门禁加不加 devDep」，
//   属依赖决策（老板定），本脚本不假装自己做到了。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIAGRAM_HEAD = /^\s*(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|erDiagram|gantt|journey|pie|classDiagram|gitGraph|C4Context|mindmap|timeline|quadrantChart|requirementDiagram)\b/

const countIf = (lines, re) => lines.filter((l) => re.test(l)).length

/** 按图类型分别配平：flowchart 数 subgraph，sequence 数 alt/opt/loop/par/critical/rect 开块 */
export function lintBlock(text, where) {
  const problems = []
  const lines = text.split('\n')
  const body = lines.filter((l) => l.trim() !== '')
  if (body.length === 0) return [{ kind: 'empty-block', at: where, detail: '空的 mermaid 块' }]
  const head = body[0]
  if (!DIAGRAM_HEAD.test(head)) {
    problems.push({ kind: 'unknown-diagram', at: `${where} (首行)`, detail: `首行不是已知图类型：${head.trim().slice(0, 40)}` })
    return problems
  }
  const isFlow = /^\s*(flowchart|graph)\b/.test(head)
  const isSeq = /^\s*sequenceDiagram\b/.test(head)
  const opens = isFlow ? countIf(lines, /^\s*subgraph(\s|$)/) : isSeq ? countIf(lines, /^\s*(alt|opt|loop|par|and|critical|break|rect)(\s|$)/) : 0
  const ends = isFlow || isSeq ? countIf(lines, /^\s*end\s*$/) : 0
  if (opens !== ends) {
    problems.push({
      kind: 'unbalanced-block', at: where,
      detail: `${isFlow ? 'subgraph' : 'alt/opt/loop/…'} 开了 ${opens} 个、end 收了 ${ends} 个 ⇒ 不配平`,
    })
  }
  // 括号配平只在"标签写在同一行"的图里有意义：erDiagram 的 `||--o{` 与跨行 { 属性块 } 天生不配平，
  // 上一版按行判 ⇒ 全仓误报 68 条。花括号整条撤（跨行块无法按行判），方/圆括号限定 flowchart/graph/sequence。
  const bracketCheck = /^\s*(flowchart|graph|sequenceDiagram)\b/.test(head)
  lines.forEach((l, i) => {
    const at = `${where}:${i + 1}`
    const t = l.trim()
    if (t.startsWith("%%")) return // 注释行不算（判据只落有效行）
    if (bracketCheck) {
      for (const [open, close] of [["[", "]"], ["(", ")"]]) {
        const o = (l.split(open).length - 1)
        const c = (l.split(close).length - 1)
        if (o !== c) problems.push({ kind: "unbalanced-bracket", at, detail: `${open}${close} 不配平（${o} vs ${c}）：${t.slice(0, 50)}` })
      }
    }
    if (((l.match(/"/g) || []).length) % 2 !== 0) problems.push({ kind: "odd-quotes", at, detail: `引号不成对：${t.slice(0, 50)}` })
  })

  /* ── 语法档（09-29 加，仍**不依赖浏览器**）：抓"结构对但渲染坏"的那几类 ──
     这些不是随手加严：每一条都对应"文档里看着像图、打开是文字或空白"的真实故障形态。
     parse 级校验要真 DOM（甲）或浏览器 harness（乙），那条决策还在老板手上；
     这一档先把零依赖能抓的抓掉，不假装自己做到了 parse。 */
  const idents = new Set()
  const effective = lines.map((l) => l.trim()).filter((t) => t !== "" && !t.startsWith("%%"))
  // 第一趟：先把节点 id 收齐（style/class 可能写在节点定义之前，边扫边判会假红 ⇒ 分两趟）
  for (const t of effective) {
    for (const m of t.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*(?=\[|\(|\{|--|-\.|==)/g)) idents.add(m[1])
    for (const m of t.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*)\s*(?:--+>|-\.+>|==+>|<-+|->+)/g)) idents.add(m[1])
    for (const m of t.matchAll(/(?:--+>|-\.+>|==+>|<--+|\.->)\s*([A-Za-z][A-Za-z0-9_]*)/g)) idents.add(m[1])
    const sg = /^\s*subgraph\s+([A-Za-z][A-Za-z0-9_]*)/.exec(t)
    if (sg) idents.add(sg[1])
  }
  // 第二趟：逐行判
  lines.forEach((l, i) => {
    const raw = l.trim()
    if (raw === "" || raw.startsWith("%%")) return
    const at = `${where}:${i + 1}`
    /* 判之前先把**引号里的标签内容**抹掉：`R["runId[]"]`、`MG["mergeProviders()"]`、
       `-->|"GET /agent/runs → 过滤"|` 这些写法完全合法，但按裸文本判就会假红
       （第一版正是这样在 specs/ 上误报 13 条，09-29 自查发现）。标签是给人看的字符串，
       不参与语法判据 ⇒ 只判结构外面的部分。 */
    const t = raw.replace(/"[^"]*"/g, '""')
    if (isFlow) {
      /* "->" 非法的判法：只看它**前面那个字符**。合法写法里 -> 前面必然是 `-`（-->）或 `.`（-.->）；
         裸 `->` 前面是空格或行首（mermaid 会把整行当文字/报错）。
         ⚠️ 第一版我用"剥掉合法连接符再找 ->"，把 `-.文字.->` 这种带说明的点线误判成违例
         （全仓 12 条假红，09-29 自查发现）—— 带说明的箭头中间是任意文本，没法用固定词表穷举。 */
      if (/(?:^|\s)->/.test(t)) problems.push({ kind: "bad-arrow", at, detail: `出现不是合法连接符的 "->"（flowchart 要 "-->" 或 "-.说明.->"）：${t.slice(0, 60)}` })
      if (/(?:-->|---|==>)\s*$/.test(t)) problems.push({ kind: "missing-target", at, detail: `连接符右边没有目标节点：${t.slice(0, 60)}` })
      if (/\b[A-Za-z][A-Za-z0-9_]*\s*[\[(]\s*[\])]/.test(t) || /\b[A-Za-z][A-Za-z0-9_]*\s*\{\s*\}/.test(t))
        problems.push({ kind: "empty-shape", at, detail: `空标签形状 A[] / A() / A{}：mermaid 会解析失败 ⇒ 要么写标签要么别加括号` })
    }
    if (isFlow && /^\s*(?:style|class)\s+([A-Za-z][A-Za-z0-9_]*)\b/.test(t)) {
      const target = /^\s*(?:style|class)\s+([A-Za-z][A-Za-z0-9_]*)\b/.exec(t)[1]
      if (idents.size > 0 && !idents.has(target))
        problems.push({ kind: "style-unknown-node", at, detail: `style/class 指向「${target}」，但本块没有以它为 id 的节点（含 subgraph）⇒ 这条样式静默失效` })
    }
  })
  if (isFlow && /^\s*flowchart\s*$/i.test(body[0]))
    problems.push({ kind: "direction-missing", at: `${where} (首行)`, detail: "flowchart 没写方向（TD/LR/BT/RL）⇒ 整图不渲染" })
  return problems
}

/** 从 md 里提 mermaid 块（围栏必须独占一行且成对） */
export function extractBlocks(md, file) {
  const out = []
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^```mermaid\s*$/.test(lines[i])) continue
    const start = i
    let j = i + 1
    let closed = false
    for (; j < lines.length; j++) if (/^```\s*$/.test(lines[j])) { closed = true; break }
    if (!closed) { out.push({ text: '', at: `${file}:${start + 1}`, unterminated: true }); i = j; continue }
    out.push({ text: lines.slice(start + 1, j).join('\n'), at: `${file}:${start + 1}` })
    i = j
  }
  return out
}

function repoMarkdown() {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  return raw.split('\0').filter((f) => f.endsWith('.md')).filter((f) => !/^docs\/memory\//.test(f) && !/^node_modules\//.test(f))
}

function run(files) {
  const problems = []
  let blocks = 0
  for (const f of files) {
    let md
    try { md = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
    for (const b of extractBlocks(md, f)) {
      blocks++
      if (b.unterminated) { problems.push({ kind: 'unterminated-fence', at: b.at, detail: 'mermaid 块的 ``` 收尾围栏缺失' }); continue }
      problems.push(...lintBlock(b.text, b.at))
    }
  }
  return { blocks, problems }
}

/* ───────────── 自检（K8b：注入必红 / 干净不误伤 / 反向不谎报） ───────────── */
const CLEAN = [
  '```mermaid', 'flowchart LR', '  subgraph A["甲"]', '    X["一"]', '  end', '  X --> Y["二"]', '```',
  '```mermaid', 'sequenceDiagram', '  A->>B: 请求', '  alt 成功', '    B-->>A: 返回', '  else 失败', '    B-->>A: 报错', '  end', '```',
].join('\n')
const BROKEN_SUBGRAPH = ['```mermaid', 'flowchart TB', '  subgraph A["甲"]', '    X["一"]', '  X --> Y', '```'].join('\n')
const BROKEN_SEQ = ['```mermaid', 'sequenceDiagram', '  alt 成功', '    B-->>A: 返回', '```'].join('\n')
const BROKEN_FENCE = ['```mermaid', 'flowchart LR', '  A --> B', ''].join('\n')
const BROKEN_HEAD = ['```mermaid', 'flokchart LR', '  A --> B', '```'].join('\n')
const BROKEN_QUOTE = ['```mermaid', 'flowchart LR', '  A["未关引号] --> B', '```'].join('\n')
// 语法档的正反控制样本（⑫ 是反向：全是合法写法，误判一条就算这档判据坏了）
const BAD_ARROW = ['```mermaid', 'flowchart LR', '  A -> B', '```'].join('\n')
const MISSING_TARGET = ['```mermaid', 'flowchart LR', '  A["一"] -->', '```'].join('\n')
const EMPTY_SHAPE = ['```mermaid', 'flowchart LR', '  A[] --> B["乙"]', '```'].join('\n')
const DIR_MISSING = ['```mermaid', 'flowchart', '  A --> B', '```'].join('\n')
const STYLE_UNKNOWN = ['```mermaid', 'flowchart LR', '  A --> B', '  style Zzz fill:#fff,stroke-width:2px', '```'].join('\n')
const STYLE_UNKNOWN_OK = ['```mermaid', 'flowchart LR', '  A["甲"] -->|通过| B["乙"]', '  A -.-> C["丙"]', '  class A accent', '  style B fill:#fff', '```'].join('\n')
// 标签里带 [] / () / -> 的合法写法（specs/ 里真实存在；第一版把这类误判成违例，报了 13 条假红）
const QUOTED_LABELS = ['```mermaid', 'flowchart LR', '  D["issue 详情<br/>runId[]"] -->|"GET /agent/runs<br/>按 issueId 过滤"| R["runId[]"]', '  M["mergeProviders()"] --> R', '  R -.->|"探测 probe()"| S', '```'].join('\n')

if (process.argv[1] && import.meta.url === (() => { try { return new URL('file://' + fs.realpathSync(process.argv[1])).href } catch { return '' } })() && process.argv.includes('--selftest')) {
  const t = (name, md, want) => {
    const bs = extractBlocks(md, 't.md')
    const got = bs.flatMap((b) => (b.unterminated ? ['unterminated-fence'] : lintBlock(b.text, 't')))
    const kinds = new Set(got.map((g) => (typeof g === 'string' ? g : g.kind)))
    const ok = want === null ? kinds.size === 0 : kinds.has(want)
    console.log(`${ok ? '✓' : '✗'} ${name}`)
    return ok
  }
  const cases = [
    t('① 干净样本（flowchart 配平 + sequenceDiagram 的 alt/end）不误判', CLEAN, null),
    t('② subgraph 少一个 end 必被抓', BROKEN_SUBGRAPH, 'unbalanced-block'),
    t('③ sequenceDiagram 的 alt 少 end 必被抓', BROKEN_SEQ, 'unbalanced-block'),
    t('④ 围栏没收尾必被抓', BROKEN_FENCE, 'unterminated-fence'),
    t('⑤ 图类型头写错必被抓', BROKEN_HEAD, 'unknown-diagram'),
    t('⑥ 引号不成对必被抓', BROKEN_QUOTE, 'odd-quotes'),
    t('⑦ "->" 少一个杠（flowchart 非法连接符）必被抓', BAD_ARROW, 'bad-arrow'),
    t('⑧ 连接符右边没有目标必被抓', MISSING_TARGET, 'missing-target'),
    t('⑨ 空标签形状 A[] 必被抓', EMPTY_SHAPE, 'empty-shape'),
    t('⑩ flowchart 没写方向必被抓', DIR_MISSING, 'direction-missing'),
    t('⑪ style 指向本块没有的节点必被抓（样式静默失效）', STYLE_UNKNOWN, 'style-unknown-node'),
    t('⑫ 反向控制：合法连接符 / 有目标 / 有标签 / 有方向 / style 指到真节点 ⇒ 一律不误判', STYLE_UNKNOWN_OK, null),
    t('⑬ 引号里的 [] / () / 连接符是标签文本，不算语法违例（specs/ 真实写法，防第一版那 13 条假红复发）', QUOTED_LABELS, null),
  ]
  const fails = cases.filter((c) => !c)
  console.log(`md-mermaid-lint selftest ${cases.length - fails.length}/${cases.length} 通过`)
  process.exit(fails.length ? 2 : 0)
}

const args = process.argv.slice(2)
if (args.includes('--file')) {
  const files = []
  for (let i = 0; i < args.length; i++) if (args[i] === '--file') files.push(args[++i])
  if (files.length === 0) { console.error('✗ --file 后面没有路径'); process.exit(2) }
  const res = files.map((f) => run([path.relative(ROOT, path.resolve(f))])).reduce((a, x) => ({ blocks: a.blocks + x.blocks, problems: [...a.problems, ...x.problems] }), { blocks: 0, problems: [] })
  console.log(`扫 ${res.blocks} 个 mermaid 块 · 违例 ${res.problems.length}`)
  for (const p of res.problems) console.log(`   · [${p.kind}] ${p.at} ${p.detail}`)
  process.exit(res.problems.length ? 2 : 0)
}
if (args.includes('--check')) {
  const { blocks, problems } = run(repoMarkdown())
  console.log(`md-mermaid-lint · 扫 ${blocks} 个 mermaid 块（docs/specs，不含 docs/memory）· 违例 ${problems.length}`)
  for (const p of problems.slice(0, 20)) console.log(`   · [${p.kind}] ${p.at} ${p.detail}`)
  if (problems.length > 20) console.log(`   …另 ${problems.length - 20} 条，见 --verbose 全量`)
  console.log(problems.length ? `✗ 结构违例 ${problems.length} 条（注：本门禁做块级配平 + 一档语法检查，仍不做 parse/渲染，见文件头）` : '✓ 结构全过（不含渲染校验，见文件头）')
  process.exit(problems.length ? 2 : 0)
}
console.log('用法：--selftest | --check | --file <md>…（没输入算没判，exit 3）')
process.exit(3)
