#!/usr/bin/env node
// scripts/lint-common.mjs
// 门禁骨架 —— lint-design / lint-code 等自研门禁的共用引擎：规则表 + 带理由白名单 + --selftest 反向验证
// 用法：作为模块 `import { createLint } from './lint-common.mjs'`；调试用 `node scripts/lint-common.mjs --demo`
//
// 为什么要有它（PRJ-016 / ISS-700）：规矩没有牙就会被绕过（AGENTS §4 写了"禁止 kill 3210"还是被 kill 过）。
// 本仓已有的唯一门禁 lint-scripts.mjs 把这套机制写死在自己文件里 —— 设计侧 R1~R8、代码侧 K1~K10 还要各来一份，
// 于是"白名单失效检测""反向验证""退出码口径"会被抄第三遍、第四遍（正是本仓在治的病）。抽成一份。
//
// 三条硬口径（照 lint-scripts.mjs §7 的教训写死）：
//   ① **判据要落在正确的对象上** —— 规则只拿得到"内容 + 路径"，别拿文件名当内容判
//   ② **误伤比缺门禁更赶人** —— 白名单必须带 reason；失效检测双向（条目不再命中要报、文件消失也要报）
//   ③ **守卫自己也要被守** —— --selftest 用内建 fixture 证明"该红能红、不该红的不红、豁免失效会报"
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

/**
 * @param {object} cfg
 * @param {string} cfg.name            门禁名（如 lint-code）
 * @param {() => string[]} cfg.files   扫描范围（返回绝对路径数组）
 * @param {Rule[]} cfg.rules           规则表
 * @param {Object<string,WhitelistEntry[]>} [cfg.whitelist]  ruleId → 豁免清单
 * @param {string} [cfg.root]          相对路径的基准（默认 process.cwd()）
 */
export function createLint(cfg) {
  const { name, files, rules, whitelist = {}, root = process.cwd() } = cfg
  const rel = (p) => path.relative(root, p).split(path.sep).join('/')
  const readMemo = new Map()
  const read = (p) => {
    if (!readMemo.has(p)) {
      try { readMemo.set(p, fs.readFileSync(p, 'utf8')) } catch { readMemo.set(p, '') }
    }
    return readMemo.get(p)
  }
  const ctx = {
    root, files, read, rel,
    /** 按行给规则用：回调返回真值即产出一条命中 */
    eachLine(fn) {
      const out = []
      for (const f of files()) {
        const lines = read(f).split('\n')
        lines.forEach((line, i) => {
          const hit = fn({ file: f, rel: rel(f), line, n: i + 1, lines })
          if (hit) out.push({ file: rel(f), line: i + 1, detail: typeof hit === 'string' ? hit : hit.detail })
        })
      }
      return out
    },
    /** 跳过注释行的行扫描（教训：判据被注释命中过） */
    eachCodeLine(fn) {
      return this.eachLine((c) => (/^\s*(\/\/|\*|\/\*|#)/.test(c.line) ? null : fn(c)))
    },
  }

  const isOn = (entry) => !Array.isArray(entry.appliesToProfiles) || entry.appliesToProfiles.length === 0

  /** 跑一遍：返回 { findings, stale, gone, errored } */
  function run() {
    const findings = []
    const errored = []
    const hitIndex = new Map() // ruleId → Map(file → detail[])；存 detail 是为了 match 的化石检测
    for (const rule of rules) {
      let hits = []
      try {
        hits = rule.check(ctx) || []
      } catch (e) {
        errored.push({ id: rule.id, error: String(e && e.message) })
        continue
      }
      const byFile = new Map()
      for (const h of hits) {
        const list = byFile.get(h.file) || []
        list.push(String(h.detail || ''))
        byFile.set(h.file, list)
      }
      hitIndex.set(rule.id, byFile)
      for (const h of hits) {
        // 豁免粒度（ISS-701）：可选 `match` 对 detail 做子串匹配 ⇒ 能把豁免收到**边级**。
        // 没有 match 时行为与原先完全相同（文件级），向后兼容；新登记一律带 match。
        // 为什么必须有这一档：文件级豁免意味着「已豁免的文件是不设防区」—— 在
        // forge-model/lib/store/bridge.js（已豁免）里新加一条 import，门禁照绿。
        const wl = (whitelist[rule.id] || []).filter((e) =>
          e.file === h.file && (!e.match || String(h.detail || '').includes(e.match))
        )
        if (wl.length) continue
        findings.push({ rule: rule.id, level: rule.level || 'block', why: rule.why, file: h.file, line: h.line || null, detail: h.detail || '' })
      }
    }
    // 白名单双向失效检测
    const stale = []
    const gone = []
    for (const [ruleId, list] of Object.entries(whitelist)) {
      const hits = hitIndex.get(ruleId)
      for (const e of list || []) {
        if (!isOn(e)) continue
        const abs = path.join(root, e.file)
        if (!fs.existsSync(abs)) { gone.push({ rule: ruleId, file: e.file, reason: e.reason }); continue }
        if (!hits) { stale.push({ rule: ruleId, file: e.file, reason: e.reason, why: '规则已不存在或不再产出命中 ⇒ 名单该摘' }); continue }
        const details = hits.get(e.file)
        if (!details) { stale.push({ rule: ruleId, file: e.file, reason: e.reason, why: '该文件现已不命中 ⇒ 豁免是化石，摘掉' }); continue }
        // ISS-701：带 match 的条目要按 match 再判一次 —— 文件还在命中不等于**这一条**还在命中。
        // 缺了这一步，match 写窄之后旧条目会静默失效成化石（豁免不生效也不报警）。
        if (e.match && !details.some((d) => d.includes(String(e.match)))) {
          stale.push({ rule: ruleId, file: e.file, reason: e.reason, why: `该文件的命中已不含 match「${e.match}」⇒ 豁免是化石，摘掉` })
        }
      }
    }
    return { findings, stale, gone, errored }
  }

  function format(res, { verbose = false } = {}) {
    const out = []
    const blocks = res.findings.filter((f) => f.level === 'block')
    const warns = res.findings.filter((f) => f.level === 'warn')
    out.push(`${name} · 扫描 ${files().length} 文件 · 规则 ${rules.length} 条 · 命中 ${res.findings.length}（阻塞 ${blocks.length} / 提醒 ${warns.length}）`)
    for (const f of [...blocks, ...warns]) {
      out.push(`  ${f.level === 'block' ? '✗' : '⚠'} ${f.rule}  ${f.file}${f.line ? ':' + f.line : ''}  ${f.detail}`)
      if (verbose) out.push(`      为什么：${f.why}`)
    }
    for (const s of res.stale) out.push(`  ⚑ 白名单已失效（该摘）：${s.rule} → ${s.file}（原理由：${s.reason}）`)
    for (const g of res.gone) out.push(`  ⚑ 白名单指向的文件不存在：${g.rule} → ${g.file}（原理由：${g.reason}）`)
    for (const e of res.errored) out.push(`  ✗ 规则 ${e.id} 执行报错（当阻塞处理，别当"没问题"）：${e.error}`)
    return { text: out.join('\n'), exit: blocks.length || res.stale.length || res.gone.length || res.errored.length ? EXIT.VIOLATION : EXIT.CLEAN }
  }

  return { run, format, ctx, rules, whitelist }
}

/** 供门禁脚本统一走的 CLI 入口 */
export function runCli(lint, argv = process.argv.slice(2)) {
  const res = lint.run()
  if (argv.includes('--json')) { console.log(JSON.stringify(res, null, 1)); return res.findings.length ? EXIT.VIOLATION : EXIT.CLEAN }
  const { text, exit } = lint.format(res, { verbose: argv.includes('--verbose') })
  console.log(text)
  return exit
}

/* ───────────────────── 棘轮（ratchet）：存量不返工，只压新增 ───────────────────── */

/**
 * 把命中按「规则 → 归属（默认包名）→ 条数」聚合。
 * 为什么要按归属而不是只数总数（lint-design 那版只数总数）：
 *   总数 2093 这种数字没法行动 —— 谁涨了一格看不出来，收口了也看不出来。
 * @param {{rule:string,file:string}[]} findings
 * @param {(file:string)=>string} [ownerOf] 归属判据，默认取相对路径首段
 */
export function countByRulePackage(findings, ownerOf) {
  const owner = ownerOf || ((f) => String(f.file || "").split("/")[0] || "(root)")
  const out = {}
  for (const f of findings) {
    const o = owner(f)
    const byRule = (out[f.rule] = out[f.rule] || {})
    byRule[o] = (byRule[o] || 0) + 1
  }
  return out
}

/**
 * 比对上限。返回 over（阻塞）/ under（可收线，不阻塞）/ ghost（上限里登记了但当前不触犯 —— 收线信号）。
 * @param {Object<string,Object<string,number>>} counts
 * @param {Object<string,Object<string,number>>} ceilings
 */
export function compareCeilings(counts, ceilings) {
  const over = []
  const under = []
  const ghost = []
  for (const [rule, pkgs] of Object.entries(ceilings || {})) {
    for (const [pkg, cap] of Object.entries(pkgs || {})) {
      const n = (counts[rule] && counts[rule][pkg]) || 0
      if (n > cap) over.push({ rule, pkg, count: n, cap })
      else if (n === 0 && cap > 0) ghost.push({ rule, pkg, cap })
      else if (n < cap) under.push({ rule, pkg, count: n, cap })
    }
  }
  return { over, under, ghost }
}

/** 从 counts 生成上限文件内容（--write 用；只记当前值，不做四舍五入的"预留空间"）。 */
export function ceilingsFrom(counts) {
  return JSON.parse(JSON.stringify(counts))
}

/* ───────────────────────── --selftest：守卫自己要有牙 ───────────────────────── */

/** 内建 fixture：造一份"必红"文件 + 一份"不该红"文件，证明判据既不漏也不误伤 */
export function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-selftest-'))
  const bad = path.join(dir, 'bad.js')
  const good = path.join(dir, 'good.js')
  fs.writeFileSync(bad, 'const x = 1\n// 说明\ndebugger\ncatch-nothing\n')
  fs.writeFileSync(good, 'const y = 2\n// debugger 写在注释里不该算\n')
  const files = () => [bad, good]
  const noDebugger = {
    id: 'T1', why: '自检规则：非注释行不许出现 debugger',
    check: (c) => c.eachCodeLine(({ line }) => (line.includes('debugger') ? '命中 debugger' : null)),
  }
  const never = { id: 'T2', why: '自检规则：永不命中（证明"不该红的不红"）', check: () => [] }

  const cases = []
  const push = (name, ok, note = '') => cases.push({ name, ok, note })

  // ① 该红能红
  const a = createLint({ name: 'selftest-A', root: dir, files, rules: [noDebugger, never] })
  const ra = a.run()
  push('该红能红（bad.js 命中 T1）', ra.findings.length === 1 && ra.findings[0].file === 'bad.js' && a.format(ra).exit === EXIT.VIOLATION, `实际 ${ra.findings.length} 条`)
  // ② 不该红的不红（注释里的 debugger 不算 + 空规则不报）
  push('注释不误伤 · 阻塞退出码非 0', ra.findings.every((f) => f.file === 'bad.js') && a.format(ra).exit === EXIT.VIOLATION)
  const rb = createLint({ name: 'selftest-B', root: dir, files, rules: [never] }).run()
  push('无命中时退出码 0', rb.findings.length === 0)
  // ③ 白名单生效 ⇒ 不红
  const wl = { T1: [{ file: 'bad.js', reason: '自检：证明豁免确实生效' }] }
  const rc = createLint({ name: 'selftest-C', root: dir, files, rules: [noDebugger, never], whitelist: wl }).run()
  push('白名单命中 ⇒ 归零', rc.findings.length === 0 && rc.stale.length === 0 && rc.gone.length === 0)
  // ④ 白名单双向失效：条目不再命中要报（把规则换成针对 good.js 的）
  const wlStale = { T1: [{ file: 'good.js', reason: '自检：该文件其实不命中' }] }
  const rd = createLint({ name: 'selftest-D', root: dir, files, rules: [noDebugger], whitelist: wlStale }).run()
  push('豁免失效会报（stale）', rd.stale.length === 1 && rd.stale[0].file === 'good.js')
  // ⑤ 白名单指向不存在的文件要报
  const wlGone = { T1: [{ file: 'not-here.js', reason: '自检：文件不存在' }] }
  const re = createLint({ name: 'selftest-E', root: dir, files, rules: [noDebugger], whitelist: wlGone }).run()
  push('名单指向缺失文件会报（gone）', re.gone.length === 1)
  // ⑥ 规则抛错当阻塞，不当"没问题"
  const boom = { id: 'T9', why: '故意炸', check: () => { throw new Error('boom') } }
  const rf = createLint({ name: 'selftest-F', root: dir, files, rules: [boom] }).run()
  push('规则报错不静默（计入 errored 且退出码非 0）', rf.errored.length === 1 && createLint({ name: 'x', files, rules: [boom] }).format(rf).exit === EXIT.VIOLATION)
  // ⑦ 判据落在正确对象上：拿文件名当内容的规则会漏 ⇒ 反证 eachCodeLine 用的是行
  const nameBased = { id: 'T8', why: '故意用文件名判（错误示范）', check: (c) => c.files().filter((f) => f.endsWith('.js')).map((f) => ({ file: c.rel(f) })) }
  push('行判据与文件判据可区分（证明 ctx 提供的是内容）', createLint({ name: 'x', root: dir, files, rules: [nameBased] }).run().findings.length === 2)
  // ⑧ 豁免粒度（ISS-701）：文件级豁免 = 已豁免文件是不设防区 ⇒ 可选 match 收到边级
  const twoEdges = {
    id: 'T3', why: '自检：同一文件两条命中',
    check: () => ([
      { file: 'bad.js', line: 1, detail: '边 A：x → alpha' },
      { file: 'bad.js', line: 2, detail: '边 B：x → beta' },
    ]),
  }
  const withWl = (w) => createLint({ name: 'x', root: dir, files, rules: [twoEdges], whitelist: { T3: w } }).run()
  const rEdge = withWl([{ file: 'bad.js', match: '→ alpha', reason: '自检：只免第一条边' }])
  push('边级豁免：match 命中只免那一条，同文件其余命中仍红', rEdge.findings.length === 1 && rEdge.findings[0].detail.includes('beta') && rEdge.stale.length === 0)
  const rAll = withWl([{ file: 'bad.js', reason: '自检：不带 match = 文件级，向后兼容' }])
  push('边级豁免没破坏向后兼容：不带 match 仍是文件级（全免）', rAll.findings.length === 0 && rAll.stale.length === 0)
  const rFossil = withWl([{ file: 'bad.js', match: '→ gamma', reason: '自检：这条 match 已对不上' }])
  push('带 match 的条目对不上 ⇒ 报 stale，且两条命中都不被误免', rFossil.stale.length === 1 && rFossil.findings.length === 2)

  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
  const fails = cases.filter((c) => !c.ok)
  console.log('lint-common --selftest')
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.note ? '（' + c.note + '）' : ''}`)
  console.log(fails.length ? `\n✗ 反向验证失败 ${fails.length}/${cases.length} 项 —— 骨架不成立，别接真规则` : `\n✓ ${cases.length}/${cases.length} 项通过：该红能红、不该红的不红、豁免生效且失效双向会报、规则炸不静默`)
  return fails.length ? EXIT.VIOLATION : EXIT.CLEAN
}

if (process.argv[1] && /lint-common\.mjs$/.test(process.argv[1])) {
  const a = process.argv.slice(2)
  if (a.includes('--selftest')) process.exit(selftest())
  console.log('这是模块，不是门禁本体。用法：import { createLint, runCli } from scripts/lint-common.mjs')
  console.log('  node scripts/lint-common.mjs --selftest   # 反向验证骨架有牙')
  process.exit(EXIT.CLEAN)
}
