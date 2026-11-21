#!/usr/bin/env node
// scripts/gates/lint-criteria-teeth.mjs —— K8a「判据必须有牙」的机械执行（ISS-729 第二段）
// 用法：node scripts/gates/lint-criteria-teeth.mjs --check | --write | --selftest | --census
//       [--source=doc|cards] [--strict]
//
// 为什么要有它：`docs/code.md:257` 的 K8a 要求「写进规范的判据必须指到一条可执行的验证程序」，
// 但 K8a 自己只有一个 `mode:'report'` 条目（`lint-code.mjs:141`）⇒ **不判红**。
// ⇒ 75 条 K 判据里有一批「无牙」的活得好好的，因为没有任何机制要求它们有牙。
//
// 判据（任一不满足即红）——**五道闸**：
//   R1 完整性：K 号集合 ↔ 台账 `criteria-teeth.json` 的键集合，双向相等（不多不少）
//   R2 地址有效：台账 `file` 必须存在，**且被某个门禁登记**（`guard-baselines.sh` 的
//      `check`/`selfcheck`/`livecheck`/`report_only` 行，或 `gates/registry.json` 的 active 条目）
//   R3 不认假牙：`mode === 'report'` 的条目**不算有牙**（report 档不判红）
//   R4 不认撞词：台账声明的 `id`（如 `TC1`）必须在那个脚本的**代码行**里出现，注释行不算；
//      且同一个 `id` 不许被两条判据同时认领（一则规则只能是一条判据的牙）
//   R5 映射完整（ISS-794）：规则卡 `implements` ↔ `lint-code` 的 `RULES` 双向对得上 ——
//      ① `kind: gate` 的卡 `implements` 不许为空（声称有门禁却不声明实现 = 假登记）；
//      ② `implements.gate` 必须等于 `judgedBy.gate`（声明两个门禁要写两张卡，不许一处写一套）；
//      ③ 声明 `gate: lint-code` 的 `rule` 必须在 `RULES` 里，且 `RULES` 的 `doc ?? 主号` 必须指回本卡
//         （这是 ISS-759 号错配的机器守护：`K2b→K2c` / `K4b→K4a` / `K7b→K4e` / `K5d→K5b` 都对得上）。
//      反向（`RULES` 有非 report 条目但无卡认领）当前是**报告档** `R5r`：3 处已知缺口在卡侧/脚本侧，
//      本单对 K 规则卡（2026-11-21 已整体删除）只读；把它做成红会让本单无法合入，做成绿会变成永远为真的假闸。
//
// ⛔ 台账**不许手写**：`criteria-teeth.json` 一律由 `--write` 生成。
//    真相源三处，台账只是索引：`docs/code.md` 行内字段 + `lint-code.mjs` 的 RULES + 门禁登记。
//    手写台账会成为第二真相源：人抄对了就变绿，比现在更危险。
//
// 行内字段两种（写在 `docs/code.md` 判据表格的同一行里）：
//   牙：`scripts/x.mjs` 的规则号 **TC1**     ← 声明这条判据靠哪个程序的哪个号判红
//   ⚠️ 不补：<具体理由>                      ← 决定不补（不是待办），理由必须说清为什么
//
// ── 影子期：真相源切换（ISS-794 / G3c 前置）──
// `--source=doc`（默认）= 现状：键集与「有牙/不补」读 `docs/code.md` 行内字段。
// `--source=cards`     = 新源：键集读 K 规则卡的 `id`，「有牙/不补」读 frontmatter 的
//                        `judgedBy.kind`（gate/external ⇒ 有牙；none ⇒ 不补）+ `implements` 定位门禁与规则号。
// 两源在**四处**上对不上（K2b/K2d/K5d/K7b）：卡侧说 `kind:none`，doc 侧记成有牙。
// 逐条核过：3 条是 ISS-759 号错配的残留（规则号被按名字硬配给另一条判据），1 条（K2d）是陈旧行内 `牙：`。
// 影子期用 `SHADOW_COMPAT` 显式复刻这 4 条，保证 `--check --source=cards` 与 doc 源读数一致；
// 加 `--strict` 去掉兼容层，读到的是**卡侧真值** 52/0/23/0 —— 那是切真相源时必须先清的账。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }
const LEDGER_REL = 'scripts/baseline/criteria-teeth.json'
const DOC_REL = 'docs/code.md'
// K 规则卡体系 2026-11-21 整体删除（老板拍板「丙」）。此常量仅为 `--source=cards` 影子分支
// 与自检夹具保留一个墓碑路径：该目录恒不存在 ⇒ loadCards 恒返回空，默认 `--source=doc`
// 的判红面不变。彻底退役该分支（连同 SHADOW_COMPAT / buildLedgerFromCards）另开单。
const RULES_DIR = 'docs/.retired-k-cards-2026-11-21'
const REGISTRY_REL = 'scripts/gates/registry.json'
const REG_KINDS = ['check', 'selfcheck', 'livecheck', 'report_only']
const MIN_WONTFIX_LEN = 8
/**
 * 影子期显式兼容：这 4 条在卡侧是 `judgedBy.kind: none`，在 doc 侧被记成"有牙"。
 * 全部**不是**卡侧漏登记，而是 doc 侧错配 —— 所以兼容层只复刻读数，不复刻 id 归属（`shadow` 条目不参与 R4 一号两主）。
 * 清零条件：K2b/K5d/K7b 靠 `RULES.doc` 已能正名（规则归 K2c/K5b/K4e），K2d 要删 `docs/code.md` 那行陈旧的 `牙：`。
 */
const SHADOW_COMPAT = new Map([
  ['K2b', 'lint-code RULES 按号命中，但 RULES.doc 指向 K2c（号错配残留）'],
  ['K5d', 'lint-code RULES 按号命中，但 RULES.doc 指向 K5b（号错配残留）'],
  ['K7b', 'lint-code RULES 按号命中，但 RULES.doc 指向 K4e（号错配残留）'],
  ['K2d', 'docs/code.md 行内「牙：scripts/scan-input.mjs」陈旧；卡侧论证 scan-input 是输入集合不是门禁'],
])

/* ───────────── 解析器（全部纯函数，--selftest 用 fixture 跑同一套）───────────── */

/** `code.md` 判据表格行：`| **K5a** | 正文 | 档 |` ⇒ Map<K, {body, line}> */
export function parseDocRows(docText) {
  const out = new Map()
  docText.split('\n').forEach((line, i) => {
    const m = /^\|\s*\*\*(K\d+[a-z]?)\*\*\s*\|(.*)$/.exec(line)
    if (m) out.set(m[1], { body: m[2], line: i + 1 })
  })
  return out
}

/** 行内 `牙：` 字段 ⇒ Map<K, {file, id}>。id=null = 整脚本判红（如三族棘轮的 FAMILIES，无单号） */
export function parseDocTeeth(rows) {
  const out = new Map()
  for (const [k, { body, line }] of rows) {
    const at = body.indexOf('牙：')
    if (at < 0) continue
    const tail = body.slice(at)
    const fileM = /`(scripts\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:mjs|sh))`/.exec(tail)
    if (!fileM) continue
    const after = tail.slice(fileM.index + fileM[0].length)
    // 规则号 = 紧跟文件路径的 `**XXX**`；取不到 ⇒ 整脚本级（id=null），不是"没牙"
    const idM = /^\s*(?:的规则号|规则|号)?\s*\*\*([A-Z][A-Z0-9]*(?:·[a-z])?)\*\*/.exec(after)
    out.set(k, { file: fileM[1], id: idM ? idM[1] : null, line })
  }
  return out
}

/** 行内 `不补：` 字段 ⇒ Map<K, reason> */
export function parseDocWontfix(rows) {
  const out = new Map()
  for (const [k, { body }] of rows) {
    const m = /不补：([^|]+)/.exec(body)
    if (m) out.set(k, m[1].trim())
  }
  return out
}

/** `gates/registry.json` 的 active 条目 ⇒ Map<scriptRel, [{kind:'registry', args:id}]>（R2 的**唯一**登记源） */
export function parseGateRegistry(jsonText) {
  const out = new Map()
  let arr
  try {
    arr = JSON.parse(jsonText)
  } catch {
    return out
  }
  for (const g of Array.isArray(arr) ? arr : []) {
    if (!g || (g.status && g.status !== 'active')) continue
    const file = g.script ?? g.file
    if (!file) continue
    if (!out.has(file)) out.set(file, [])
    out.get(file).push({ kind: 'registry', args: g.id ?? '' })
  }
  return out
}

/**
 * 全量 registry（**含** deprecated）⇒ Map<scriptRel, [{id, status}]>。
 *
 * 为什么需要它：`parseGateRegistry` 只给 active 条目，那是 R2 的登记源；但「已退役门禁」
 * 在 registry.json 里仍留着 status=deprecated 的条目（ISS-853 四步法：脚本/spec 留盘）。
 * 只拿 active 集无法区分「曾经登记、现已退役」与「压根没登记」—— 后者是 R2 要抓的真错，
 * 前者是旧树冻结、不该判红。本表提供**退役证明**：某 file 有条目但全非 active ⇒ 已退役。
 */
export function parseGateRegistryAll(jsonText) {
  const out = new Map()
  let arr
  try {
    arr = JSON.parse(jsonText)
  } catch {
    return out
  }
  for (const g of Array.isArray(arr) ? arr : []) {
    if (!g) continue
    const file = g.script ?? g.file
    if (!file) continue
    if (!out.has(file)) out.set(file, [])
    out.get(file).push({ id: g.id ?? '', status: g.status ?? 'active' })
  }
  return out
}

/**
 * 判一个牙载体 file 的归属门禁是否已退役（旧树冻结）：
 *   · 全量 registry 里**有**该 file 的条目，且**没有任何 active** 条目 ⇒ true（退役）；
 *   · 完全没有条目 ⇒ false（从未登记 —— R2 仍须判红，不给活门禁开后门）；
 *   · 有 active 条目 ⇒ false（门禁还活着）。
 * 状态来自 registry，不硬编码任何 gate 名单。
 */
export function isRetiredGate(file, registryAll) {
  const entries = registryAll.get(file)
  if (!entries || entries.length === 0) return false
  return !entries.some((e) => (e.status ?? 'active') === 'active')
}

/** 脚本的**代码行**（去掉整行注释）—— R4 只认代码行：注释里提到不算有牙 */
export function codeOnly(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l))
    .join('\n')
}

/** RULES 从模块取，**不 grep 源码**：正则会把 selftest fixture 里的 `K9z` 当真规则 */
export async function loadRules(root) {
  const p = path.join(root, 'scripts/lint-code.mjs')
  if (!fs.existsSync(p)) return new Map()
  const mod = await import(pathToFileURL(p).href + `?t=${Date.now()}`)
  const out = new Map()
  // `doc` 是 ISS-759 正名时加的：规则号 ↔ 文档号的错配映射（`K2b` 服务文档 `K2c` 等）。
  // R5 用它判「这条规则归哪张卡」；漏读它会把 4 条错配全部判成越界。
  for (const r of mod.RULES || []) out.set(r.rule, { mode: r.mode ?? 'zero', doc: r.doc ?? null })
  return out
}

/**
 * 规则卡 frontmatter ⇒ { kind, gate, impl:[{gate,rule,metric}], command, destination, body }
 * 为什么手写解析而不上 yaml：卡片 frontmatter 是**受控子集**（标量 + 行内 flow 列表 + 行内 flow map），
 *   为读 75 个文件引一个依赖不值。解析不出 frontmatter ⇒ **抛**，不静默当空
 *   （静默当空会把 75 条判成"无卡"⇒ 全绿，那是最坏的一种绿）。
 */
export function parseCard(id, text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!fm) throw new Error(`${RULES_DIR}/${id}.md 缺 frontmatter（影子期不能静默降级成空卡）`)
  const y = fm[1]
  const block = (name) => {
    const m = new RegExp(`(?:^|\\n)${name}:\\s*\\n((?:[ \\t]+.*\\n?)*)`).exec(y)
    return m ? m[1] : ''
  }
  const scalar = (name) => {
    const m = new RegExp(`(?:^|\\n)${name}:\\s*(.+)$`, 'm').exec(y)
    return m ? m[1].trim() : ''
  }
  const jb = block('judgedBy')
  const implBlk = block('implements')
  const impl = [...implBlk.matchAll(/\{[^}]*\}/g)].map((s) => ({
    gate: (/(?:^|\s)gate:\s*([A-Za-z0-9_-]+)/.exec(s[0]) || [])[1],
    rule: (/(?:^|\s)rule:\s*['"]?([A-Za-z0-9·]+)['"]?/.exec(s[0]) || [])[1],
    metric: (/(?:^|\s)metric:\s*([A-Za-z0-9·]+)/.exec(s[0]) || [])[1],
  }))
  return {
    kind: (/(?:^|\n)\s*kind:\s*(\S+)/.exec(jb) || [])[1] ?? null,
    gate: (/(?:^|\n)\s*gate:\s*(\S+)/.exec(jb) || [])[1] ?? null,
    destination: (/(?:^|\n)\s*destination:\s*"([^"]+)"/.exec(jb) || [])[1] ?? null,
    impl,
    command: scalar('command'),
    body: text,
  }
}

/** K 规则卡（已删除） ⇒ Map<K, card>。README 与模板不在射程 */
export function loadCards(root) {
  const dir = path.join(root, RULES_DIR)
  const out = new Map()
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/^K.*\.md$/.test(f)) continue
    const id = f.replace(/\.md$/, '')
    out.set(id, parseCard(id, fs.readFileSync(path.join(dir, f), 'utf8')))
  }
  return out
}

/**
 * 不补的「理由」从卡里取：`## 已知边界` 的第一段。取不到就退回 `destination` 锚点。
 * 为什么不用 `judgedBy.destination` 当唯一理由：锚点只说明"去哪看"，不说明"为什么不补"，
 *   而 R1 要求理由必须说清为什么（≥ MIN_WONTFIX_LEN 只是下限，不是标准）。
 */
export function cardReason(card) {
  const m = /## 已知边界\s*\n+([^\n]+)/.exec(card.body)
  const first = m ? m[1].replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').trim() : ''
  if (first.length >= MIN_WONTFIX_LEN) return first
  if (card.destination) return `降级登记（卡未写「已知边界」），去向 ${card.destination}`
  return ''
}

/* ───────────── 台账生成 ───────────── */

/**
 * 权威性优先级：行内 `牙：` > RULES 条目 > `不补：` > 缺失（判红）
 * 为什么行内优先：K5h 的牙挂在**另一个命名空间**（TC1），RULES 里根本没有这个键；
 *   K8a 自己也一样（旧 report 条目 vs 现在的真门禁本脚本）。
 *   ⇒ 只看 RULES 会把 5 条有牙的判据误判成无牙（Lead 第一轮的 21 条清单就栽在这）。
 */
export function buildLedger({ root, rows, docTeeth, wontfix, rules, registry }) {
  const criteria = {}
  const problems = []
  const keys = [...rows.keys()].sort()

  for (const k of keys) {
    const declared = docTeeth.get(k)
    const rule = rules.get(k)
    const why = wontfix.get(k)

    if (declared) {
      const reg = registry.get(declared.file) || []
      const mode = declared.id ? (rules.get(declared.id)?.mode ?? rule?.mode ?? null) : null
      criteria[k] = {
        kind: declared.id ? 'rule' : 'script',
        file: declared.file,
        id: declared.id,
        mode,
        registered: reg.length ? reg.map((r) => `${r.kind} ${r.args}`.trim()).join(' / ') : null,
        source: `${DOC_REL}:${declared.line} 牙字段`,
      }
      if (declared.id) {
        const sp = path.join(root, declared.file)
        if (fs.existsSync(sp) && !codeOnly(fs.readFileSync(sp, 'utf8')).includes(declared.id)) {
          problems.push(`R4 ${k}: 声明 ${declared.file} 的 **${declared.id}**，但该号只在注释/字符串里（提到过 ≠ 能拦住）`)
        }
      }
    } else if (rule && rule.mode !== 'report') {
      const file = 'scripts/lint-code.mjs'
      const reg = registry.get(file) || []
      criteria[k] = {
        kind: 'rule',
        file,
        id: k,
        mode: rule.mode,
        registered: reg.length ? reg.map((r) => `${r.kind} ${r.args}`.trim()).join(' / ') : null,
        source: 'lint-code RULES',
      }
    } else if (why) {
      // ⚠️ `不补：理由` 必须排在 report 档**之前**：report 档条目不是牙（R3），
      //    而人已经诚实写了「为什么不补」的条目，若被 R3 抢先判红，等于逼人删掉那段理由。
      //    「有真门禁」仍然排最前 —— 给一条真能判红的判据写「不补」是错的，不给它开口子。
      criteria[k] = { kind: 'wontfix', reason: why, source: `${DOC_REL} 不补字段` }
    } else if (rule) {
      criteria[k] = { kind: 'report', file: 'scripts/lint-code.mjs', id: k, mode: 'report', registered: null, source: 'lint-code RULES' }
      problems.push(`R3 ${k}: 只有 report 档条目 ⇒ 不判红，不算有牙（补真门禁，或在 code.md 写「不补：理由」）`)
    } else {
      problems.push(`R1 ${k}: 无牙且未声明「不补：理由」 ⇒ 补门禁，或诚实写明为什么不补`)
    }
  }

  // R1 反向：RULES 里有、code.md 没有的号（号被删了 / 拼错）
  // ⚠️ 子号形态（`K5b·n` / `K3c·b`）= 同一判据的细分规则，主号 `K5b`/`K3c` 在表格里就成立。
  //    把它们当「文档没有这条判据」是假红 —— 子号本来就不在表格行首（它们写在主号正文与变更日志里）。
  for (const k of rules.keys()) {
    if (rows.has(k)) continue
    const base = k.split('·')[0]
    if (base !== k && rows.has(base)) continue
    problems.push(`R1 ${k}: lint-code 有 rule 条目但 code.md 没有这条判据`)
  }

  return { criteria, problems, keys }
}

/**
 * 影子期新源：从规则卡生成台账（`--source=cards`）。
 * 判定只有一条规则：`judgedBy.kind`
 *   `gate` / `external` ⇒ 有牙。门禁脚本取卡片 `command` 里的 `scripts/...` 路径（卡自己声明的执行入口，
 *                        比维护一张 gate→file 表更不容易漂）；规则号取 `implements[0].rule`。
 *   `none`             ⇒ 不补，理由取卡片「已知边界」第一段。
 * `SHADOW_COMPAT` 里的 4 条单独复刻 doc 侧读数（见文件头），并标 `shadow:true` 不参与 R4 一号两主。
 * 返回值里的 `diff` 是**与 doc 源逐条比 kind/file/id** 的差异，`--check` 直接打印。
 */
export function buildLedgerFromCards({ root, cards, rules, registry, docTeeth, compat = true }) {
  const criteria = {}
  const problems = []
  const shadow = []
  const keys = [...cards.keys()].sort()
  const reg = (f) => {
    const r = (f && registry.get(f)) || []
    return r.length ? r.map((x) => `${x.kind} ${x.args}`.trim()).join(' / ') : null
  }
  for (const k of keys) {
    const card = cards.get(k)
    const impl = card.impl.filter((i) => i.rule)
    if (compat && card.kind === 'none' && SHADOW_COMPAT.has(k)) {
      const d = docTeeth.get(k)
      const rule = rules.get(k)
      const file = d?.file ?? 'scripts/lint-code.mjs'
      const id = d?.id ?? (rule && rule.mode !== 'report' ? k : null)
      criteria[k] = {
        kind: id ? 'rule' : 'script',
        file,
        id,
        mode: id ? (rules.get(id)?.mode ?? null) : null,
        registered: reg(file),
        shadow: true,
        source: `${RULES_DIR}/${k}.md judgedBy.kind=none（影子兼容：${SHADOW_COMPAT.get(k)}）`,
      }
      shadow.push(`${k}: 卡侧 kind:none，doc 侧记有牙 ⇒ ${SHADOW_COMPAT.get(k)}`)
      continue
    }
    if (card.kind === 'gate' || card.kind === 'external') {
      const file = (/(scripts\/[A-Za-z0-9_./-]+\.(?:mjs|ts))/.exec(card.command) || [])[1] ?? null
      const id = impl[0]?.rule ?? null
      const isRule = card.gate === 'lint-code' && id && rules.has(id)
      criteria[k] = {
        kind: isRule ? 'rule' : 'script',
        file,
        id: isRule ? id : null,
        mode: isRule ? (rules.get(id)?.mode ?? null) : null,
        registered: reg(file),
        source: `${RULES_DIR}/${k}.md judgedBy.kind=${card.kind}`,
      }
      if (!file) problems.push(`R2 ${k}: 卡片 judgedBy.kind=${card.kind}，但 command 里解析不出 scripts/*.mjs|ts 路径`)
      else if (!fs.existsSync(path.join(root, file))) problems.push(`R2 ${k}: 卡片 command 指向的 ${file} 不存在`)
      continue
    }
    if (card.kind === 'none') {
      criteria[k] = { kind: 'wontfix', reason: cardReason(card), source: `${RULES_DIR}/${k}.md judgedBy.kind=none` }
      continue
    }
    problems.push(`R1 ${k}: judgedBy.kind=${card.kind ?? '(缺)'} 不认识（只认 gate / external / none）`)
  }
  return { criteria, problems, keys, shadow }
}

/**
 * R5：rule → card 映射完整性（ISS-794 硬约束 5）。
 * 反向覆盖（RULES 有非 report 条目却无卡认领）单列在 `gaps`：当前 3 处，都是卡侧/脚本侧的事，
 * 本单只读改不了。做成红 = 本单无法合入；做成绿 = 永远为真的假闸。所以让它出声、可追踪、可升级。
 */
export function mappingProblems({ cards, rules }) {
  const problems = []
  const gaps = []
  const base = (r) => r.split('·')[0]
  const owned = new Set()
  for (const [id, card] of cards) {
    if (card.kind === 'gate' && !card.impl.length) {
      problems.push(`R5 ${id}: judgedBy.kind=gate 但 implements 为空（声称有门禁，却不声明它靠哪条规则判）`)
    }
    for (const i of card.impl) {
      if (i.gate && card.gate && i.gate !== card.gate) {
        problems.push(`R5 ${id}: implements.gate=${i.gate} 与 judgedBy.gate=${card.gate} 不一致（一张卡只许写一个门禁）`)
      }
      if (i.gate !== 'lint-code') continue
      owned.add(i.rule)
      const r = rules.get(i.rule)
      if (!r) {
        problems.push(`R5 ${id}: 声明 lint-code 规则 ${i.rule}，但 RULES 里没有这个号（编造的实现）`)
        continue
      }
      const target = r.doc ?? base(i.rule)
      if (target !== id) problems.push(`R5 ${id}: 声明 ${i.rule}，但 RULES 的归属指向 ${target}（号错位：改 implements 或改 RULES.doc）`)
    }
  }
  for (const [rule, r] of rules) {
    if (r.mode === 'report' || owned.has(rule)) continue
    gaps.push(`R5r ${rule}: lint-code 有 rule（mode=${r.mode}${r.doc ? `，doc=${r.doc}` : ''}）但没有任何卡的 implements 声明它`)
  }
  return { problems, gaps }
}

/** 两源逐条比 kind/file/id，给 `--check --source=cards` 打差异表（`shadow` 条目单列，不算差异） */
export function ledgerDiff(a, b, keys) {
  const out = []
  for (const k of keys) {
    const x = a[k]
    const y = b[k]
    if (!x || !y) {
      out.push(`${k}: ${x ? 'doc 有 / cards 无' : 'cards 有 / doc 无'}`)
      continue
    }
    if (x.shadow || y.shadow) continue
    const f = (e) => `${e.kind}:${e.file ?? '-'}#${e.id ?? '-'}`
    if (x.kind !== y.kind || x.file !== y.file || x.id !== y.id) out.push(`${k}: doc ${f(x)} ≠ cards ${f(y)}`)
  }
  return out
}

/* ───────────── 校验（读台账 + 现场复核，不信台账自称）───────────── */

export function validate({ root, criteria, keys, registry, registryAll = new Map(), problems: seed = [], out = null }) {
  const problems = [...seed]
  const retiredHits = []
  const lk = Object.keys(criteria)
  for (const k of keys) if (!criteria[k]) problems.push(`R1 ${k}: code.md 有判据但台账缺条目`)
  for (const k of lk) if (!keys.includes(k)) problems.push(`R1 ${k}: 台账有条目但 code.md 无此判据`)

  const idOwner = new Map()
  for (const [k, e] of Object.entries(criteria)) {
    if (e.kind === 'wontfix') {
      if (!e.reason || e.reason.length < MIN_WONTFIX_LEN) {
        problems.push(`R1 ${k}: wontfix 但理由缺失或过短（「不补」必须说清为什么，不许写「待办」）`)
      }
      continue
    }
    if (e.kind === 'report') {
      if (!problems.some((p) => p.startsWith(`R3 ${k}`))) problems.push(`R3 ${k}: report 档不算有牙`)
      continue
    }
    // R2：文件存在 + 被某个门禁登记（registry.json 的 active 条目）。
    // 旧树冻结豁免（ISS-886 老板拍板 A）：若该牙载体的归属门禁**已退役**（registry.json 里
    //   有该脚本的条目但全是 deprecated、无 active）⇒ 判据随旧树退役，R2 不再判「没有门禁跑它」。
    //   判据只信 registry 的 status 派生集，不硬编码 gate 名单；
    //   若 registry 里**根本没有**该脚本条目 ⇒ 不是退役而是「从未登记」，R2 照旧判红（不开后门）。
    if (!fs.existsSync(path.join(root, e.file))) {
      problems.push(`R2 ${k}: 台账指向的 ${e.file} 不存在`)
    } else if (!(registry.get(e.file) || []).length) {
      if (isRetiredGate(e.file, registryAll)) retiredHits.push(`${k}→${e.file}`)
      else problems.push(`R2 ${k}: ${e.file} 既不在 guard-baselines.sh 有登记行，也不在 gates/registry.json 里 ⇒ 没有任何门禁跑它`)
    }
    // R4：号必须在代码行里；且一号码主
    if (e.id) {
      const key = `${e.file}#${e.id}`
      // ⚠️ 影子兼容条目（`shadow`）只复刻**读数**，不复刻 id 归属：它记的那个号在卡侧归另一条判据，
      //    让它参与"一号两主"会造出一条由兼容层自己引起的假红（K2b/K5d/K7b 正是这种）。
      if (e.shadow) {
        // 不登记 owner，但仍要验号在代码行里
      } else if (idOwner.has(key)) {
        problems.push(`R4 ${k}: 号 ${e.id} 已被 ${idOwner.get(key)} 认领（一则规则只能是一条判据的牙）`)
      } else idOwner.set(key, k)
      const sp = path.join(root, e.file)
      if (fs.existsSync(sp) && !codeOnly(fs.readFileSync(sp, 'utf8')).includes(e.id)) {
        problems.push(`R4 ${k}: ${e.file} 的 ${e.id} 只在注释/字符串里`)
      }
    }
  }
  if (out) out.retiredHits = retiredHits
  return problems
}

/* ───────────── 主流程 ───────────── */

export async function load(root) {
  const docText = fs.readFileSync(path.join(root, DOC_REL), 'utf8')
  const rows = parseDocRows(docText)
  // R2 的登记源：`gates/registry.json` 的 active 条目（**唯一**）。
  //
  // ISS-800：原先这里还有第二源 —— 读 `scripts/guard-baselines.sh` 的登记行文本，且 guard 优先、
  // registry.json 只作补充。该 shell 聚合器本单退役，两源合一时没有任何一张卡靠 guard 独有登记通过
  // （实测：合并后 62 个文件，registry.json 侧覆盖 62 个，guard 独有 0 个）⇒ 删掉第一源是**恒等变换**。
  // 改前改后 `--check` 判定结果 `comm -3` 为空。
  const rp = path.join(root, REGISTRY_REL)
  const regText = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : ''
  const registry = parseGateRegistry(regText)
  return {
    rows,
    docTeeth: parseDocTeeth(rows),
    wontfix: parseDocWontfix(rows),
    registry,
    registryAll: parseGateRegistryAll(regText),
    rules: await loadRules(root),
    cards: loadCards(root),
  }
}

/** 四个数：有牙 / report / 不补 / 缺失 —— `缺失` 必须把台账里根本没有的键也数进去，否则总数对不上 */
export function census(criteria, keys) {
  const pick = (f) => keys.filter((k) => criteria[k] && f(criteria[k]))
  const teeth = pick((e) => e.kind === 'rule' || e.kind === 'script')
  const report = pick((e) => e.kind === 'report')
  const wontfix = pick((e) => e.kind === 'wontfix')
  return {
    total: keys.length,
    teeth: teeth.length,
    report: report.length,
    wontfix: wontfix.length,
    none: keys.length - teeth.length - report.length - wontfix.length,
  }
}

async function main() {
  const root = process.cwd()
  const argv = process.argv.slice(2)
  const mode = argv.find((a) => ['--check', '--write', '--selftest', '--census'].includes(a)) || '--check'
  const source = (argv.find((a) => a.startsWith('--source=')) || '--source=doc').slice('--source='.length)
  const strict = argv.includes('--strict')
  if (mode === '--selftest') return selftest()
  if (source !== 'doc' && source !== 'cards') {
    console.error(`✗ --source 只认 doc | cards，收到 ${source}`)
    return EXIT.INTERNAL
  }
  if (mode === '--write' && source !== 'doc') {
    // 影子期不写第二份台账：台账是"唯一索引"，写两份就是两个真相源（文件头那条纪律）。
    console.error('✗ --write 只支持 --source=doc（影子期不产出第二份台账；看差异用 --check --source=cards）')
    return EXIT.INTERNAL
  }

  const { rows, docTeeth, wontfix, registry, registryAll, rules, cards } = await load(root)
  const docKeys = [...rows.keys()].sort()
  const validateOut = {}

  let criteria
  let gen
  let keys
  let shadow = []
  // R5 与真相源无关（它比的是卡 ↔ RULES），**两种模式都跑**：默认 doc 源也必须守住映射完整性，
  // 否则新判据只在影子期生效，切源那天才发现卡已经漂了。
  const mapping = mappingProblems({ cards, rules })
  if (source === 'doc') {
    ;({ criteria, problems: gen } = buildLedger({ root, rows, docTeeth, wontfix, rules, registry }))
    keys = docKeys
  } else {
    ;({ criteria, problems: gen, keys, shadow } = buildLedgerFromCards({ root, cards, rules, registry, docTeeth, compat: !strict }))
    // 键集影子对拍：卡 id 集合必须与 doc 表格 K 号集合逐一对上（切换真相源的第一道前提）
    const cardKeys = new Set(keys)
    for (const k of docKeys) if (!cardKeys.has(k)) gen.push(`R1 ${k}: ${DOC_REL} 有判据，但 ${RULES_DIR}/${k}.md 不存在`)
    for (const k of keys) if (!docKeys.includes(k)) gen.push(`R1 ${k}: ${RULES_DIR}/${k}.md 存在，但 ${DOC_REL} 没有这条判据`)
  }
  const c = census(criteria, keys)

  console.log(`K8a 判据有牙率 · ${source === 'doc' ? DOC_REL : `${RULES_DIR}/K*.md`} K 号 ${c.total} 条${strict ? '（--strict：无影子兼容）' : ''}`)
  console.log(`  ① 有牙（有 rule/script 声明）：${c.teeth} / ${c.total}`)
  console.log(`  ② report 档（有条目不判红，不算有牙）：${c.report} / ${c.total}`)
  console.log(`  ③ 声明不补（带具体理由）：${c.wontfix} / ${c.total}`)
  console.log(`  ④ 无牙且未声明：${c.none} / ${c.total}`)
  if (shadow.length) {
    console.log(`  ⚠️ 影子兼容 ${shadow.length} 条（卡侧 kind:none，doc 侧记有牙；切换真相源前必须清零）：`)
    for (const s of shadow) console.log(`    · ${s}`)
  }
  if (mapping.gaps.length) {
    console.log(`  ⚠️ R5r 反向覆盖缺口 ${mapping.gaps.length} 条（报告档，不判红）：`)
    for (const g of mapping.gaps) console.log(`    · ${g}`)
  }

  if (mode === '--write') {
    const lp = path.join(root, LEDGER_REL)
    fs.mkdirSync(path.dirname(lp), { recursive: true })
    fs.writeFileSync(lp, JSON.stringify({
      _readme: [
        '⛔ 由 scripts/gates/lint-criteria-teeth.mjs --write 生成，**不要手改**。',
        '真相源三处：docs/code.md 的行内字段（牙：/ 不补：）· scripts/lint-code.mjs 的 RULES · 门禁登记（guard-baselines.sh / gates/registry.json）。',
        '改判据牙位 = 改那三处之一，再跑 --write。手改本文件会被 --check 判红（与真相源不符）。',
      ],
      _generatedBy: 'node scripts/gates/lint-criteria-teeth.mjs --write',
      _count: c,
      criteria,
    }, null, 2) + '\n')
    console.log(`\n✓ 已写 ${LEDGER_REL}`)
    if (gen.length) {
      console.log(`  ⚠️ 重算期发现 ${gen.length} 条问题（--check 会判红）：`)
      for (const p of gen.slice(0, 12)) console.log(`    ✗ ${p}`)
    }
    return EXIT.CLEAN
  }

  // --check / --census：现场复核 + 台账漂移（防手改台账"抄对就变绿"）
  const lp = path.join(root, LEDGER_REL)
  if (!fs.existsSync(lp)) {
    console.error(`\n✗ 台账不存在：${LEDGER_REL} ⇒ 先跑 node scripts/gates/lint-criteria-teeth.mjs --write`)
    return EXIT.VIOLATION
  }
  const onDisk = JSON.parse(fs.readFileSync(lp, 'utf8')).criteria || {}
  const drift = []
  if (source === 'doc') {
    for (const k of keys) if (!onDisk[k]) drift.push(`R1 ${k}: 台账缺条目（真相源有）`)
    for (const k of Object.keys(onDisk)) if (!keys.includes(k)) drift.push(`R1 ${k}: 台账有条目但 code.md 无此判据`)
    for (const [k, e] of Object.entries(onDisk)) {
      const w = criteria[k]
      if (!w) continue
      if (e.kind !== w.kind || e.file !== w.file || e.id !== w.id) {
        drift.push(`R1 ${k}: 台账与真相源不符（台账 ${e.kind}:${e.file}#${e.id} ≠ 真相源 ${w.kind}:${w.file}#${w.id}）⇒ 重跑 --write`)
      }
    }
  } else {
    // 影子期：台账仍由 doc 源生成，所以**不拿它做漂移判据**（否则切源第一天就必然红）。
    // 改为逐条打印两源差异 —— 这是 G3c 的工单，不是本单的失败。
    const diff = ledgerDiff(onDisk, criteria, keys)
    if (diff.length) {
      console.log(`\n  ⚠️ 与现行台账（doc 源）逐条差异 ${diff.length} 条（不计入判红；切真相源时要逐条定性）：`)
      for (const d of diff.slice(0, 20)) console.log(`    · ${d}`)
      if (diff.length > 20) console.log(`    · …… 其余 ${diff.length - 20} 条略`)
    }
  }

  const all = [...new Set([...gen, ...mapping.problems, ...validate({ root, criteria, keys, registry, registryAll, problems: gen, out: validateOut }), ...drift])]
  if (validateOut.retiredHits && validateOut.retiredHits.length) {
    console.log(`\n  ℹ️ 旧树冻结豁免 ${validateOut.retiredHits.length} 条（归属门禁已退役、非 active）：${validateOut.retiredHits.join('、')}`)
  }
  if (!all.length) {
    console.log('\n✓ 全部 K 判据要么有牙（登记行可指），要么诚实声明了不补的理由')
    return EXIT.CLEAN
  }
  // 判红：无牙未声明 / R2 地址无效 / R3 假牙 / R4 撞词 / R5 映射不完整 / 台账漂移
  console.error(`\n✗ K8a 判据有牙率不达标：${all.length} 条`)
  for (const p of all.slice(0, 40)) console.error(`  ✗ ${p}`)
  if (all.length > 40) console.error(`  …… 其余 ${all.length - 40} 条略`)
  return EXIT.VIOLATION
}

/* ───────────── 自检（K8b：反向验证，注入坏法必须红）───────────── */

/**
 * 把「旧 guard 登记行语法」翻译成 registry.json 条目数组（ISS-800 夹具适配）。
 *
 * 为什么保留旧语法而不改写 18 处调用：那些夹具行是在验**别的**判据（R3 report 档、R4 注释不算、
 * R1 wontfix 过短…），逐条改写会把本单变成一次大范围夹具重写，风险与收益不成比例。
 * 这里只做一件事：取出行里的脚本路径，包成 `{script, status:"active"}`。
 * 注释行（`#` 开头）与起首非法的行一律不产出条目 —— 与旧解析器同样跳过。
 */
function regLinesToRegistry(lines) {
  const out = []
  for (const line of lines) {
    if (/^\s*(#|\/\/)/.test(line)) continue
    const m = new RegExp(`^(${REG_KINDS.join('|')})\\s+(\\S+)`).exec(line)
    if (!m) continue
    out.push({ id: `fixture-${out.length}`, kind: 'legacy', script: m[2], status: 'active' })
  }
  return out
}

async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teeth-'))
  let pass = 0
  let fail = 0
  const t = (name, ok) => {
    if (ok) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}`) }
  }
  /**
   * `cards` = { K1a: { kind, gate, impl:[{gate,rule}], command, body } } ⇒ 写 K1a 卡（墓碑路径下）。
   * 只写最小 frontmatter：影子期的解析器只读这几个字段，多写反而掩盖解析缺口。
   */
  const mk = (docLines, regLines, files = {}, cards = null, rawReg = null) => {
    const dir = fs.mkdtempSync(path.join(tmp, 'r-'))
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'scripts', 'baseline'), { recursive: true })
    fs.writeFileSync(path.join(dir, DOC_REL), docLines.join('\n') + '\n')
    // ISS-800：登记源只剩 `gates/registry.json`。夹具仍按旧的 guard 行语法书写（18 处调用不必改），
    // 在这里就地翻译成 registry 条目 —— 翻译只保留脚本名，因为 R2 判的就是「这个文件有没有被登记」。
    // rawReg（ISS-886）：需要带 status 的退役态夹具时直接给原始条目数组，不再翻译。
    fs.mkdirSync(path.join(dir, 'scripts', 'gates'), { recursive: true })
    fs.writeFileSync(path.join(dir, REGISTRY_REL), JSON.stringify(rawReg ?? regLinesToRegistry(regLines), null, 2) + '\n')
    fs.writeFileSync(path.join(dir, 'scripts/lint-code.mjs'), `export const RULES = [{ rule: 'K1a', mode: 'zero' }]\n`)
    if (cards) {
      fs.mkdirSync(path.join(dir, RULES_DIR), { recursive: true })
      for (const [id, card] of Object.entries(cards)) {
        const impl = (card.impl || []).map((i) => `  - { gate: ${i.gate}, rule: ${i.rule}, metric: ${i.metric || 'x'} }`)
        const fm = [
          '---',
          `id: ${id}`,
          'mode: report',
          'tier: []',
          impl.length ? `implements:\n${impl.join('\n')}` : 'implements: []',
          'judgedBy:',
          `  kind: ${card.kind}`,
          card.gate ? `  gate: ${card.gate}` : card.destination ? `  destination: "${card.destination}"` : '',
          card.command ? `command: "${card.command}"` : 'command: null',
          '---',
          '',
          `# ${id}`,
          '',
          '## 已知边界',
          '',
          card.body || '机器判不准这条：没有可机判的静态形态，按降级登记，去向见 destination。',
          '',
        ].filter((l) => l !== '').join('\n')
        fs.writeFileSync(path.join(dir, RULES_DIR, `${id}.md`), fm + '\n')
      }
    }
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), body)
    }
    return dir
  }
  /** 跑一次完整流水，返回 problems */
  const run = async (dir, mutate) => {
    const { rows, docTeeth, wontfix, registry, registryAll, rules } = await load(dir)
    const keys = [...rows.keys()].sort()
    const { criteria, problems } = buildLedger({ root: dir, rows, docTeeth, wontfix, rules, registry })
    const c = mutate ? mutate(criteria) : criteria
    return validate({ root: dir, criteria: c, keys, registry, registryAll, problems })
  }
  /** 卡片源跑一次：返回 { problems, census, shadow, gaps } */
  const runCards = async (dir, { strict = false, mutate } = {}) => {
    const { docTeeth, registry, registryAll, rules, cards } = await load(dir)
    const { criteria, problems, keys, shadow } = buildLedgerFromCards({ root: dir, cards, rules, registry, docTeeth, compat: !strict })
    const m = mappingProblems({ cards, rules })
    const c = mutate ? mutate(criteria) : criteria
    return {
      problems: [...new Set([...problems, ...m.problems, ...validate({ root: dir, criteria: c, keys, registry, registryAll, problems })])],
      census: census(c, keys),
      shadow,
      gaps: m.gaps,
    }
  }
  const REG_OK = ['selfcheck scripts/lint-code.mjs --check "x"']
  // ⚠️ fixture 自身要守规矩：K1b 必须真的写 `不补：<理由>`（写「不补的」不算字段——
  //    这正是本门禁要抓的「看着像声明了」，selftest 第一版自己就栽在这格）
  const DOC_OK = [
    '| **K1a** | 有 rule 条目的判据 | ⛔ |',
    '| **K1b** | 机器判不准的那条：不补：这条要靠人审判「等价性证明」本身，没有可机判的形态 | ⚠️ |',
  ]

  // ① 正例：有牙 + 不补 都不红（证明下面的红不是恒红）
  {
    const probs = await run(mk(DOC_OK, REG_OK))
    t('① 正例：一条有 rule 条目 + 一条带理由的不补 ⇒ 全绿（证明红不是恒红）', probs.length === 0)
  }

  // ② R2 反向：摘掉登记行 ⇒ 必须红
  {
    const probs = await run(mk(['| **K1a** | 有 rule 条目的判据 | ⛔ |'], []))
    t('② R2 反向：摘掉 guard-baselines 登记行 ⇒ K1a 变红', probs.some((p) => p.startsWith('R2 K1a')))
  }

  // ③ R2 变异（验收第 2 条）：台账 file 改成不存在的路径 ⇒ 必须红
  {
    const probs = await run(mk(DOC_OK, REG_OK), (c) => {
      c.K1a = { ...c.K1a, kind: 'rule', file: 'scripts/definitely-not-here.mjs', id: 'K1a', mode: 'zero' }
      return c
    })
    t('③ R2 变异：台账 file 改成不存在的路径 ⇒ 红', probs.some((p) => p.startsWith('R2 K1a')))
  }
  // ③b 同一台账改回正确路径 ⇒ 变绿（证明上一格红的原因是"路径不存在"，不是恒红）
  {
    const probs = await run(mk(DOC_OK, REG_OK))
    t('③b 恢复正确路径 ⇒ 变绿（证明 ③ 的红来自那条路径，不是恒红）', probs.length === 0)
  }

  // ④ R3 变异：唯一实现改成 report 档 ⇒ 必须红
  {
    const dir = mk(['| **K1a** | 有 rule 条目的判据 | ⛔ |'], REG_OK, {
      'scripts/lint-code.mjs': `export const RULES = [{ rule: 'K1a', mode: 'report' }]\n`,
    })
    const probs = await run(dir)
    t('④ R3 变异：rule 改成 report 档 ⇒ 红（report 不判红 = 没牙）', probs.some((p) => p.startsWith('R3 K1a')))
  }

  // ⑤ R4 变异：号只在注释里 ⇒ 必须红（本单的病因：提到过 ≠ 能拦住）
  {
    const doc = ['| **K1a** | 牙：`scripts/comment-only.mjs` 的规则号 **TC1** | ⛔ |']
    const reg = ['selfcheck scripts/comment-only.mjs --check "x"']
    const probs = await run(mk(doc, reg, { 'scripts/comment-only.mjs': '// 这里提到 TC1 只是注释\nexport const x = 1\n' }))
    t('⑤ R4 变异：规则号只在注释里 ⇒ 红（注释里"提到过"不算有牙）', probs.some((p) => p.startsWith('R4 K1a')))
  }
  // ⑤b 同一条把号搬进代码行 ⇒ R4 不再红（证明 ⑤ 红的原因是"只在注释里"）
  {
    const doc = ['| **K1a** | 牙：`scripts/comment-only.mjs` 的规则号 **TC1** | ⛔ |']
    const reg = ['selfcheck scripts/comment-only.mjs --check "x"']
    const probs = await run(mk(doc, reg, { 'scripts/comment-only.mjs': 'export const byRule = { TC1: 0 }\n' }))
    t('⑤b 号搬进代码行 ⇒ R4 变绿（证明 ⑤ 红的原因确为"只在注释里"）', !probs.some((p) => p.startsWith('R4 K1a')))
  }

  // ⑥ R4 一号两主：两条判据认领同一个号 ⇒ 红
  {
    const doc = [
      '| **K1a** | 牙：`scripts/g.mjs` 的规则号 **G1** | ⛔ |',
      '| **K1b** | 牙：`scripts/g.mjs` 的规则号 **G1** | ⛔ |',
    ]
    const probs = await run(mk(doc, ['selfcheck scripts/g.mjs --check "x"'], { 'scripts/g.mjs': 'export const byRule = { G1: 0 }\n' }))
    t('⑥ R4 一号两主：两条判据认领同一个号 ⇒ 红', probs.some((p) => p.includes('已被 K1a 认领')))
  }

  // ⑦ R1 双向：台账少一条 / 多一条都必须红
  {
    const dir = mk(DOC_OK, REG_OK)
    const miss = await run(dir, (c) => { delete c.K1b; return c })
    t('⑦ R1：台账缺一条 ⇒ 红', miss.some((p) => p.startsWith('R1 K1b')))
    const extra = await run(dir, (c) => { c.K9x = { kind: 'wontfix', reason: '凭空多出来的一条必须被抓到' }; return c })
    t('⑦ R1：台账多一条 ⇒ 红', extra.some((p) => p.startsWith('R1 K9x')))
  }

  // ⑧ 不判绿：什么都没写 ⇒ 必须红
  {
    const probs = await run(mk(['| **K9c** | 什么都没写 | ⛔ |'], []))
    t('⑧ 无牙且未声明不补 ⇒ 红（不静默跳过、不判绿）', probs.some((p) => p.startsWith('R1 K9c')))
  }

  // ⑨ wontfix 理由太短 ⇒ 红（防「不补：待办」糊过去）
  {
    const probs = await run(mk(['| **K9c** | 不补：待办 | ⛔ |'], []))
    t('⑨ wontfix 理由过短 ⇒ 红（「不补」必须说清为什么）', probs.some((p) => p.startsWith('R1 K9c') && p.includes('过短')))
  }

  // ⑩ 登记源唯一化后的解析口径（ISS-800：guard 退役，R2 只认 registry.json）
  //
  // 改前这格测的是 `guard-baselines.sh` 登记行的四语法（check/selfcheck/livecheck/report_only）。
  // guard 退役后那段解析器一并删了，本格改为守**新唯一源**的三条判别力：
  //   · `status:"active"` 之外的条目不算登记（否则已退役的门禁会被当成还在跑）；
  //   · `script` 字段是键（legacy 与 spec 两种条目都用它）；
  //   · 坏 JSON ⇒ 空表（不抛、不冒充"都登记了"）。
  {
    const reg = parseGateRegistry(
      JSON.stringify([
        { id: 'a', kind: 'legacy', script: 'scripts/a.mjs', status: 'active' },
        { id: 'b', kind: 'spec', script: 'scripts/b.mjs', status: 'active' },
        { id: 'c', kind: 'legacy', script: 'scripts/c.mjs', status: 'retired' },
      ])
    )
    const badJson = parseGateRegistry('{ 这不是 JSON')
    t(
      '⑩ registry.json 解析：只认 active、script 为键、坏 JSON 退化成空表',
      ['a', 'b'].every((x) => reg.has(`scripts/${x}.mjs`)) && !reg.has('scripts/c.mjs') && badJson.size === 0
    )
  }

  // ⑪ 行内「牙：整脚本」无规则号 ⇒ 记 script 型，不算缺失
  {
    const doc = ['| **K1a** | 牙：`scripts/ratchet.mjs` 三族上限 | ⛔ |']
    const probs = await run(mk(doc, ['selfcheck scripts/ratchet.mjs --check "x"'], { 'scripts/ratchet.mjs': 'export const FAMILIES = []\n' }))
    t('⑪ 行内「牙：某脚本」不带规则号 ⇒ 记 script 型且不判缺失（K4d 三族棘轮就是这形态）', probs.length === 0)
  }

  // ⑫ 子目录路径必须被解析（ISS-747）：判据 B 要求新判据落 `scripts/gates/`，
  //    牙字段若解析不了 `scripts/gates/x.mjs`，该条会**静默降级成无牙**（正则是硬闸）。
  //    ⚠️ 这一格是那条正则唯一的守护。样本必须是**两层**：正则是 `(?:dir/)*`（任意层），
  //    只有 ≥2 层才能把「收窄成一层 `(?:dir/)?`」和「收成 scripts/ 根」两种回归都判红。
  //    （ISS-747c 实测：样本用一层时，正则收窄成 `?` 仍全绿——那格守着空气。）
  {
    const doc = ['| **K1a** | 牙：`scripts/gates/sub/ratchet.mjs` 深层子目录里的判据 | ⛔ |']
    const probs = await run(mk(doc, ['selfcheck scripts/gates/sub/ratchet.mjs --check "x"'], { 'scripts/gates/sub/ratchet.mjs': 'export const FAMILIES = []\n' }))
    t('⑫ 牙字段指向深层子目录脚本（scripts/gates/sub/x.mjs）⇒ 仍能解析成 script 型、不判缺失', probs.length === 0)
  }

  /** 影子期：`--source=doc` 的完整流水（含 R5）—— ⑱ 用它守住"R5 只在卡片源生效"这个回归 */
  const runDoc = async (dir) => {
    const { rows, docTeeth, wontfix, registry, registryAll, rules, cards } = await load(dir)
    const keys = [...rows.keys()].sort()
    const { criteria, problems } = buildLedger({ root: dir, rows, docTeeth, wontfix, rules, registry })
    const m = mappingProblems({ cards, rules })
    return [...new Set([...problems, ...m.problems, ...validate({ root: dir, criteria, keys, registry, registryAll, problems })])]
  }

  // ⑬-⑱ 影子期（ISS-794）：卡片源、R5 映射完整性、双源读数对拍
  const CARDS_OK = {
    K1a: { kind: 'gate', gate: 'lint-code', impl: [{ gate: 'lint-code', rule: 'K1a' }], command: 'node scripts/lint-code.mjs --check' },
    K1b: {
      kind: 'none',
      destination: 'docs/code-audit.md#k1b-degraded',
      body: '这条机器判不准：要比对「等价性证明」本身，静态扫不出两个实现是否等价。',
    },
  }

  // ⑬ 卡片源正例：gate 卡给有牙、none 卡给不补 ⇒ 全绿（证明卡片源不是恒红）
  {
    const r = await runCards(mk(DOC_OK, REG_OK, {}, CARDS_OK))
    t('⑬ 卡片源正例：judgedBy.kind=gate ⇒ 有牙、kind=none ⇒ 不补 ⇒ 全绿', r.problems.length === 0 && r.census.teeth === 1 && r.census.wontfix === 1)
  }

  // ⑭ R5 反向：声称 kind:gate 却 implements 为空 ⇒ 必须红（假登记的第一形态）
  {
    const cards = { K1a: { ...CARDS_OK.K1a, impl: [] }, K1b: CARDS_OK.K1b }
    const r = await runCards(mk(DOC_OK, REG_OK, {}, cards))
    t('⑭ R5：kind:gate 但 implements 为空 ⇒ 红（声称有门禁却不声明实现）', r.problems.some((p) => p.startsWith('R5 K1a')))
  }

  // ⑮ R5 错位：卡声明 K1a，但 RULES.doc 把 K1a 判给别的号 ⇒ 必须红（ISS-759 号错配的守护）
  {
    const rules = "export const RULES = [{ rule: 'K1a', mode: 'zero', doc: 'K9z' }]\n"
    const r = await runCards(mk(DOC_OK, REG_OK, { 'scripts/lint-code.mjs': rules }, CARDS_OK))
    t('⑮ R5：RULES.doc 把规则判给别的号，卡却认领它 ⇒ 红（号错位）', r.problems.some((p) => p.startsWith('R5 K1a') && p.includes('K9z')))
  }

  // ⑯ R5r 反向覆盖：RULES 有非 report 条目却无卡认领 ⇒ 进报告档 gaps，不进判红
  {
    const cards = { K1b: CARDS_OK.K1b }
    const r = await runCards(mk(DOC_OK, REG_OK, {}, cards))
    t('⑯ R5r：RULES 有规则但无卡声明 ⇒ 记报告档缺口（不判红，避免永远为真的假闸）',
      r.gaps.some((g) => g.includes('K1a')) && !r.problems.some((p) => p.startsWith('R5r')))
  }

  // ⑰ 双源读数对拍：无错配的 fixture 上，doc 源与卡片源四个数必须一致
  {
    const dir = mk(DOC_OK, REG_OK, {}, CARDS_OK)
    const docProbs = await run(dir)
    const docCensus = census((await (async () => {
      const { rows, docTeeth, wontfix, registry, rules } = await load(dir)
      return buildLedger({ root: dir, rows, docTeeth, wontfix, rules, registry }).criteria
    })()), ['K1a', 'K1b'])
    const r = await runCards(dir)
    t('⑰ 双源对拍：同一 fixture 上 doc 源与卡片源读数一致（影子期的核心前提）',
      docProbs.length === 0 && r.problems.length === 0 &&
      JSON.stringify(docCensus) === JSON.stringify(r.census))
  }

  // ⑱ R5 与真相源无关：doc 源下坏卡也必须判红（防「新判据只在影子期生效」这个回归）
  {
    const cards = { K1a: { ...CARDS_OK.K1a, impl: [] }, K1b: CARDS_OK.K1b }
    const probs = await runDoc(mk(DOC_OK, REG_OK, {}, cards))
    t('⑱ R5 在 doc 源下同样生效：卡片 implements 为空 ⇒ 红（不是只在 --source=cards 才查）',
      probs.some((p) => p.startsWith('R5 K1a')))
  }

  // ── ⑲-㉓ 旧树冻结豁免（ISS-886 老板拍板 A）：RULES 牙归属门禁退役 ⇒ 不判 R2 红 ──
  // 夹具：doc 里 K1a 有 RULES 牙（指向 scripts/lint-code.mjs），registry 用 rawReg 控制 status。
  const RET_DOC = ['| **K1a** | 有 rule 条目的判据 | ⛔ |']
  const retiredRun = async (regEntries) => {
    const dir = mk(RET_DOC, [], {}, null, regEntries)
    const { rows, docTeeth, wontfix, registry, registryAll, rules } = await load(dir)
    const keys = [...rows.keys()].sort()
    const { criteria, problems } = buildLedger({ root: dir, rows, docTeeth, wontfix, rules, registry })
    const out = {}
    const probs = validate({ root: dir, criteria, keys, registry, registryAll, problems, out })
    return { probs, out }
  }

  // ⑲ 阳性：归属门禁 status=deprecated（在盘、非 active）⇒ RULES 牙转不红，且如实记账豁免
  {
    const { probs, out } = await retiredRun([{ id: 'lint-code', script: 'scripts/lint-code.mjs', status: 'deprecated' }])
    t('⑲ 退役门禁的 RULES 牙 ⇒ R2 不判红 + 记 retiredHit（阳性）',
      !probs.some((p) => p.startsWith('R2 K1a')) && out.retiredHits.some((h) => h.includes('K1a')))
  }

  // ⑳ 阴性：同一牙、门禁仍 active ⇒ 不豁免（证明没给活门禁开后门）
  {
    const { probs, out } = await retiredRun([{ id: 'lint-code', script: 'scripts/lint-code.mjs', status: 'active' }])
    t('⑳ active 门禁的 RULES 牙 ⇒ 无 retiredHit（不开后门；登记有效本就不红）',
      out.retiredHits.length === 0 && !probs.some((p) => p.startsWith('R2 K1a')))
  }

  // ㉑ 阴性（真后门测试）：registry 里**根本没有**该脚本 ⇒ 仍是 R2 红（从未登记 ≠ 退役）
  {
    const { probs, out } = await retiredRun([{ id: 'other', script: 'scripts/other.mjs', status: 'deprecated' }])
    t('㉑ 牙载体无任何 registry 条目 ⇒ R2 照旧红、无 retiredHit（退役豁免不开后门）',
      probs.some((p) => p.startsWith('R2 K1a')) && out.retiredHits.length === 0)
  }

  // ㉒ 边界：不含任何牙载体的空 registry / 坏 JSON ⇒ 空表，R2 照旧红
  {
    const { probs } = await retiredRun([])
    t('㉒ 空 registry ⇒ R2 照旧红（不把「空」当成「全退役」）', probs.some((p) => p.startsWith('R2 K1a')))
    const badAll = parseGateRegistryAll('{ 不是 JSON')
    t('㉒b parseGateRegistryAll 坏 JSON ⇒ 空表', badAll.size === 0)
  }

  // ㉓ 边界：多条目混合（同一脚本既有 active 又有 deprecated）⇒ 有 active 就不算退役
  {
    const notRetired = isRetiredGate('scripts/x.mjs', new Map([['scripts/x.mjs', [{ id: 'a', status: 'active' }, { id: 'b', status: 'deprecated' }]]]))
    const retired = isRetiredGate('scripts/y.mjs', new Map([['scripts/y.mjs', [{ id: 'c', status: 'deprecated' }]]]))
    const missing = isRetiredGate('scripts/z.mjs', new Map())
    t('㉓ isRetiredGate：有 active 不豁免 / 全 deprecated 才豁免 / 无条目不豁免',
      notRetired === false && retired === true && missing === false)
  }

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '✓' : '✗'} lint-criteria-teeth selftest：${pass} 通过 / ${fail} 失败`)
  return fail === 0 ? EXIT.CLEAN : EXIT.VIOLATION
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(EXIT.INTERNAL) })
}
