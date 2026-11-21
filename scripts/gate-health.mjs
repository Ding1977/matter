#!/usr/bin/env node
// scripts/gate-health.mjs —— 门禁与代码健康度：基线快照 / 前后对比 / 单文件状态页（ISS-647）
//
//   --snapshot [--out <dir>] 采基线 JSON · --compare <a> <b> [--md] 报 delta · --page <base> [--against <prev>] [--out f] 状态页 · --selftest 反向验证
//
// 三条纪律：① **只读采集** —— 不改判据、不改 lint/guard/基线文件，只跑它们并解析输出，唯一写动作是自己的 JSON/HTML；
// ② **不自造口径** —— 数字都来自既有脚本的原样输出（解析规则见对应 parse*），解析不到的记 null 并在 notes 点名，
// **不许当 0**（0 = 测出来没有，null = 没测）；③ **可复算** —— 除 meta.takenAt 与 meta.durations（刻意排同一行）外两跑逐字节一致。
// 去重：棘轮只留每包前 3 条样本，故按包再跑一次**同一条** tsc 收全量原文去重（total/distinct/crossPkg，并自校验 total=棘轮现值）。
// 行数贴着 K2a 的 1000 行红线（N4 take 0）：新逻辑别再往里塞，块内因此不留空行、相邻断言并一行。

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const ROOT = path.resolve(import.meta.dirname, '..')
const NODE = process.execPath
const SCHEMA = 'gate-health/1'
const DEFAULT_OUT_DIR = path.join(ROOT, 'scripts', 'baseline', 'gate-health')
const PAGE_DIR = path.join(ROOT, 'docs', 'mockups')

/** 本脚本自己的产物（脏度量要排除它们，否则"跑一次快照"本身会让快照不可复算） */
const OWN_OUTPUT = [/^scripts\/baseline\/gate-health\//, /^docs\/mockups\/gate-health-[^/]*\.html$/]

/**
 * 已退役的数据来源（ISS-829）：这两格原先由 `gate-fast.mjs` / `guard-baselines.sh` 提供，二者已被
 * ISS-800 删除、职责归 `run-gates.mjs`。**不删调用就假绿**（不存在的脚本 ⇒ 退出码 1 / 127 ⇒ 被当
 * "0 个红"）；**光摘调用也假绿**（空数组照样印 0/0），故显式登记为「判不了」，让屏幕说人话。
 */
const RETIRED_SOURCES = {
  gates: 'guard-baselines.sh 已退役（ISS-800）⇒ 无逐格门禁数据，红项数**不可读**',
  quickGates: 'gate-fast.mjs 已退役（ISS-800）⇒ 无快闸现值/存量债',
}

// ── 采集：跑命令，原样留 stdout+stderr，同时计实测秒 ────────────────────

const ANSI = /\u001b\[[0-9;]*m/g
const stripAnsi = (s) => s.replace(ANSI, '')

/**
 * @returns {{out:string,status:number|null,sec:number}}
 * 非零退出码**不是**异常：门禁红就是非零，照收（status 记进 meta.exitCodes）。
 */
function runCmd(bin, args, cwd = ROOT) {
  const t0 = performance.now(), r = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
  const sec = (performance.now() - t0) / 1000; if (r.error) throw new Error(`${bin} ${args.join(' ')} 起不来：${r.error.message}`)
  return { out: stripAnsi(`${r.stdout ?? ''}${r.stderr ?? ''}`), status: r.status, sec: Math.round(sec * 100) / 100 }
}

/**
 * **命令没跑成 ≠ 0 个红**（ISS-829）。不能只判 `status !== 0`：门禁"有红项"的正常退出码是 **1**，
 * 而 `node <不存在的 .mjs>` 也是 **1**（ERR_MODULE_NOT_FOUND）、`bash <不存在的 .sh>` 是 **127** ——
 * 与业务红撞码。唯一可靠的分界是**文件在不在**，未找到特征兜底（软链悬空/解释器起不来）。
 * @returns {{out:string,status:number|null,sec:number,unjudged:string|null}}
 */
function judge(bin, args) {
  const f = args[0]
  if (path.isAbsolute(f) && !fs.existsSync(f)) return { out: '', status: null, sec: 0, unjudged: `脚本不存在：${path.relative(ROOT, f)}（ISS-800 退役？）` }
  const r = runCmd(bin, args), why = /ERR_MODULE_NOT_FOUND|command not found|No such file or directory/u.exec(r.out)?.[0]
  return { ...r, unjudged: r.status !== 0 && why ? `起不来（退出码 ${r.status}，${why}）` : null }
}

// ── 解析器：每一条都对着被解析脚本的真实输出行写，改动前先看那些脚本 ────────────────────

/**
 * 类型债去重：**按包跑一次 tsc 收全量错误原文**（与 host-typecheck-ratchet.mjs 同一条命令：
 * `tsc -p <cfg> --noEmit`，cwd 指到包目录），每行归一成仓库相对路径的键 `<文件>(行,列): error TSxxxx` 后去重。
 * 棘轮自己只留每包前 3 条样本（errs.slice(0,3)）⇒ 它的输出算不出"一笔债被两个包各记一次"。
 * 自校验：`total` 必须等于棘轮打印的现值合计；不等就记 mismatch 并在 notes 出声（口径不一致不许静默）。
 */
function typeDebtDedup(ratchet) {
  const tsc = ['forge-ui/node_modules/typescript/bin/tsc', 'forge-pm/node_modules/typescript/bin/tsc', 'node_modules/typescript/bin/tsc']
    .map((c) => path.join(ROOT, c)).find((f) => fs.existsSync(f))
  if (!tsc) return { tsc: false, total: null, distinct: null, crossPkg: null, note: '找不到 typescript ⇒ 去重不可算，记 null' }
  const per = []; for (const fam of ratchet.families) {
    const cfg = fam.family.includes('client') ? 'tsconfig.json' : 'tsconfig.lib.json' // 与棘轮 FAMILIES 表同源
    for (const row of fam.rows) {
      if (row.current === null) continue // 未判 / 未装齐 / 名册消失：棘轮没测，我也不测（null ≠ 0）
      const dir = path.join(ROOT, row.pkg)
      per.push({ family: fam.family, pkg: row.pkg, keys: tscErrorKeys(runCmd(process.execPath, [tsc, '-p', cfg, '--noEmit'], dir).out, dir) })
    }
  }
  const famExpect = Object.fromEntries(ratchet.families.map((f) => [f.family, f.rows.reduce((a, r) => a + (r.current ?? 0), 0)]))
  const byFamily = Object.fromEntries([...new Set(per.map((p) => p.family))].map((f) => [f, dedupOn(per.filter((p) => p.family === f), famExpect[f] ?? null)]))
  return { tsc: true, packages: per.length, expect: ratchet.summary.current, ...dedupOn(per, ratchet.summary.current), byFamily }
}

/** 错误原文 → 归一化的键。有位置的按仓库相对路径（跨包重复的那笔债才认得出来），无位置（TS6059 一类）按原文 */
function tscErrorKeys(out, dir) {
  const keys = []; for (const line of out.split('\n')) {
    if (!/error TS\d+/u.test(line)) continue
    const m = /^\s*(.+?)\((\d+),(\d+)\): (error TS\d+)/u.exec(line)
    keys.push(m ? `${path.relative(ROOT, path.resolve(dir, m[1]))}(${m[2]},${m[3]}): ${m[4]}` : line.trim().slice(0, 200))
  }
  return keys
}

/** 聚合：total = 逐包记账总数（应与棘轮现值合计相等）；distinct = 去重后；crossPkg = 被 ≥2 个包各记一次的 */
function dedupOn(per, expect = null) {
  const owner = new Map(); for (const p of per) for (const k of p.keys) { if (!owner.has(k)) owner.set(k, new Set()); owner.get(k).add(p.pkg) }
  const total = per.reduce((a, p) => a + p.keys.length, 0)
  // mismatch 必须在**这里**由数据算出来：写死 false 等于没有校验（审查员抓到的第一版就是这样）
  return { total, distinct: owner.size, crossPkg: [...owner.values()].filter((v) => v.size > 1).length, expect, mismatch: expect === null ? null : total !== expect }
}

/**
 * 门禁点名：取**括号深度 0** 处的第一个 `：` 之前的部分。
 * 为什么要按深度：`（ISS-944 · 漂移即红：出码用的…）` 这种把冒号写在括号里的写法很常见，
 * 按"第一个冒号"切会把点名截成半个括号，前后两份快照的键就对不上了（对比会假报"项消失+新项"）。
 */
const gateKeyOf = (name) => String(name).split('（')[0].trim() || String(name)
/** 门禁的**身份** = 第一个全角左括号之前的部分：`Prism …（需补 6 种…）` 与 `Prism …（语料在用的语言…）` 是同一条 */
const gateKey = (g) => g.key ?? gateKeyOf(g.name)

/**
 * `guard-baselines.sh` 与 `gate-fast.mjs` 的行解析器（含点名切分 `gateName`）**已于 ISS-829 删除**：
 * 两个脚本被 ISS-800 退役 ⇒ 解析器无调用方。要接回逐格数据，接 `run-gates.mjs --json`，别复活它们。
 */

/**
 * host-typecheck-ratchet.mjs --check：
 *   头行 `类型棘轮 · 3 族 · 44 个包 · 判红 13`
 *   族行 `  ── host 半（27 个包）`
 *   包行 `  ✓ forge-agent-protocol   错误    1 / 上限 1  等于上限`
 * 状态原样保留中文；`错误 — / 上限 未记录` 表示**不判**⇒ 数记 null（不是 0）。
 * 缩进 6 格的 `✗ pkg: …error TSxxxx…` 是样本（每包最多 3 条），既不算包行、也不能当全量。
 */
function parseRatchet(text) {
  const lines = text.split('\n')
  const head = /^类型棘轮 · (\d+) 族 · (\d+) 个包 · 判红 (\d+)/u.exec(lines[0] ?? '')
  const families = []
  const samples = []
  for (const raw of lines) {
    const fam = /^\s{2}──\s+(.+?)（(\d+) 个包）/u.exec(raw)
    if (fam) { families.push({ family: fam[1].trim(), declaredPackages: Number(fam[2]), rows: [] }); continue }
    const row = /^\s{2}([✓✗↓·])\s+(\S+)\s+错误\s+(\d+|—)\s+\/\s+上限\s+(\d+|未记录)\s+(.+)$/u.exec(raw)
    if (row && families.length) {
      families[families.length - 1].rows.push({
        pkg: row[2],
        current: row[3] === '—' ? null : Number(row[3]),
        ceiling: row[4] === '未记录' ? null : Number(row[4]),
        state: row[5].trim(),
        marker: row[1],
      })
      continue
    }
    const sample = /^\s{4,}([✗·])\s+(\S+?):\s+(.+)$/u.exec(raw)
    if (sample) samples.push({ pkg: sample[2], text: sample[3].trim() })
  }
  const rows = families.flatMap((f) => f.rows), sumOf = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0)
  return {
    families,
    samples,
    summary: {
      families: families.length,
      packages: rows.length,
      headerPackages: head ? Number(head[2]) : null,
      headerFamilies: head ? Number(head[1]) : null,
      redFromHeader: head ? Number(head[3]) : null,
      redCounted: rows.filter((r) => r.marker === '✗').length,
      unjudged: rows.filter((r) => r.marker === '·').length,
      current: sumOf(rows.map((r) => r.current)),
      ceiling: sumOf(rows.map((r) => r.ceiling)),
      nullCurrent: rows.filter((r) => r.current === null).length,
      nullCeiling: rows.filter((r) => r.ceiling === null).length,
    },
  }
}

/** 度量名 → 取值口径（都取"现值"那一格的首段数字，与 docs/code-audit.md 的表格同源） */
const INVENTORY_PICKS = [
  // seg = 取 value 里第几段（"a / b / c" 的分段），每段的含义见度量自己的 title
  { key: 'dupImplementations', id: 'D2', seg: 0, what: '同名多份实现' },
  { key: 'copyPasteClusters', id: 'D3', seg: 0, what: '跨文件复制粘贴簇' },
  // 口径备注：K2a 在 code-inventory 里**不存在**（K2a 是 lint 的"脚本行数 ≤1000"红线）；
  //   盘点器里量 god module 的是 N4「≥1000 行的源文件」。按"键名以实际输出为准"取 N4 并点名。
  { key: 'godModules', id: 'N4', seg: 0, what: 'god module（≥1000 行源文件）' },
  { key: 'zeroRefExports', id: 'Z2', seg: 1, what: '零引用导出（第二段，第一段是导出总数）' },
  { key: 'sourceLines', id: 'T1', seg: 2, what: '源码行数（第三段）' },
]

function pickInventory(json) {
  const byId = new Map((json.metrics ?? []).map((m) => [m.id, m]))
  const out = {}
  const notes = []
  for (const p of INVENTORY_PICKS) {
    const m = byId.get(p.id)
    if (!m) {
      out[p.key] = { id: p.id, value: null, number: null, title: null, missing: true }
      notes.push(`inventory.${p.key}：code-inventory 输出里没有度量 ${p.id}（${p.what}）⇒ 记 null，不当 0`)
      continue
    }
    // "315 / 86" → 315；"3233 / 584 / 18%" → 584（零引用导出）；"28 / 777 / 192330" → 192330（行数）
    const parts = String(m.value).split('/').map((s) => s.trim())
    const pick = parts[p.seg]
    const n = /^\d+$/u.test(pick ?? '') ? Number(pick) : null
    out[p.key] = { id: p.id, value: String(m.value), number: n, title: m.title ?? null, missing: n === null }
    if (n === null) notes.push(`inventory.${p.key}：${p.id} 的值「${m.value}」取不出数字 ⇒ 记 null`)
  }
  return { metrics: out, notes }
}

/** 流程税口径（原文，写进 notes 与页脚：读者要能自己复算，数字高不是问题、口径说不清才是） */
function taxNote() {
  return `processTax 三条口径（可自行复算）：① 提交总数 = \`git log --since="30 days ago" --oneline\` 的行数；② 门禁类 = 说明匹配 /${TAX_GATE.source}/u；③ 返工审查类 = 说明匹配 /${TAX_REWORK.source}/u。已知偏宽：F[0-9] 会命中任何带 F+数字 的说明（不止"返工"），故返工比例是上界不是精确值；lint 同理`
}

/** 流程税：近 30 天提交里"门禁/基线/棘轮"类与"返工/审查/F 号"类的占比 */
const TAX_GATE = /棘轮|门禁|基线|baseline|lint|ratchet|复录/u
const TAX_REWORK = /返工|审查|F[0-9]/u

function processTax() {
  const { out } = runCmd('git', ['log', '--since=30 days ago', '--oneline', '--no-decorate'])
  const commits = out.split('\n').filter((l) => l.trim())
  const gateChurn = commits.filter((l) => TAX_GATE.test(l)).length
  const rework = commits.filter((l) => TAX_REWORK.test(l)).length
  const ratio = (n) => (commits.length ? Math.round((n / commits.length) * 1000) / 10 : null)
  return { commits30d: commits.length, gateChurn, rework, gateRatio: ratio(gateChurn), reworkRatio: ratio(rework) }
}

/**
 * 树身份：`--git-dir` ≠ `--git-common-dir` ⇒ 本目录是 worktree（git 的判定，不靠路径字面量硬编码）。
 * 为什么要判：棘轮上限/产物/软链都是**某一棵树**的状态，工作树缺 build:client 产物时判据扫到的面小一圈
 * ⇒ 同一份代码在两棵树上本来是两个数（docs/memory/code-spec-inventory-2026-09-22.md §30）。
 * 所以快照必须自带"我从哪棵树取的"，读的人才知道这份数字能不能和另一份比。
 */
function classifyTree(gitDir, commonDir, branch) {
  const wt = path.resolve(gitDir) !== path.resolve(commonDir)
  return wt ? { treeKind: 'worktree', mainRoot: path.dirname(path.resolve(commonDir)) } : { treeKind: 'main', mainRoot: null }
}

/** meta：HEAD / 分支 / 树身份 / 脏文件数（排除本脚本自己的产物）/ 树指纹 */
const treeFingerprintOf = (...parts) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)

function gitMeta() {
  const head = runCmd('git', ['rev-parse', 'HEAD']).out.trim()
  const branch = runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()
  const toplevel = runCmd('git', ['rev-parse', '--show-toplevel']).out.trim()
  const gitDir = runCmd('git', ['rev-parse', '--absolute-git-dir']).out.trim()
  const commonDir = path.resolve(ROOT, runCmd('git', ['rev-parse', '--git-common-dir']).out.trim())
  const porcelain = runCmd('git', ['status', '--porcelain']).out.split('\n').filter((l) => l.trim())
  // 自己的产物不参与脏度量：否则"跑一次快照"本身就会让快照不可复算（第一版踩过：两次只差这一格）
  const dirty = porcelain.filter((line) => !OWN_OUTPUT.some((re) => re.test(line.slice(3).trim().replace(/^"|"$/g, ''))))
  const tree = classifyTree(gitDir, commonDir, branch)
  // 树指纹：同一棵树、同一份工作区 ⇒ 同一个指纹；两次快照之间有任何改动 ⇒ 指纹不同 ⇒ 判"不可比"（不是"一致"）
  // 指纹必须吃**内容**：只拼 status 行时"同一个已改文件换了内容"算不出差别（审查员实测同一指纹）
  // 改了内容也必须换指纹；但**自己的产物**（基线 JSON / 页面）同样要排掉，否则只重渲页面就判"树变了"
  const changed = runCmd('git', ['diff', 'HEAD', '--name-only']).out.split('\n').filter(Boolean).filter((f) => !OWN_OUTPUT.some((re) => re.test(f)))
  const diffHash = crypto.createHash('sha256').update(changed.length ? runCmd('git', ['diff', 'HEAD', '--', ...changed]).out : '').digest('hex').slice(0, 16)
  const fingerprint = treeFingerprintOf(head, branch, toplevel, ...dirty.slice().sort(), diffHash)
  return { head, branch, ...tree, cwd: ROOT, toplevel, dirtyFiles: dirty.length, treeFingerprint: fingerprint }
}

/** 6 条已知"尺子造假账"前科（常量：这是历史结论，不从任何输出推导） */
const KNOWN_RULER_DEFECTS = [
  { id: 'H5b 42→3', what: '判据不认 peerDependencies：UI 包把 react/react-dom 放 peer 里 ⇒ 39 处假欠账', evidence: 'docs/code-migration.md S1-1 收尾（ISS-739 第 2 格）' }, { id: 'C7b 12→3', what: '口径把仓内脚本算进 host 半：9 处是 scripts/ 的开发工具，每加一个工具就顶高一格', evidence: 'docs/code-audit.md:288（C7b 明细）' },
  { id: 'R7b 152', what: '测试标题里的「退回 25s」被时长正则命中，棘轮上限被一条措辞假顶 151→152', evidence: 'docs/code-migration.md:121（ISS-731 复录）' }, { id: 'ISS-620', what: '包改名后白名单键没跟着改：一笔债在两个包里各报一次红（报两头红）', evidence: 'docs/memory/state-reality-gap-2026-10-20.md:11' },
  { id: 'Z2', what: '把 .d.ts 镜像条目当零引用导出：反向惩罚"补类型"这件事（891→814）', evidence: 'docs/code-audit.md:706' }, { id: 'K2b 77→78', what: '一层口径按第三段取：每加一个 src 根文件就涨一格，涨格的从来不是债', evidence: 'docs/code.md:244（K2c 口径修正段）' },
]

// ── 快照 ────────────────────

function collect() {
  const exitCodes = {}
  const durations = {}
  const treeNote = gitMeta() // 先取树身份：notes 里要写它，且要在跑任何耗时命令前拿到（避免中途被人改树）
  // ① 类型棘轮
  const ratchet = judge(NODE, [path.join(ROOT, 'scripts', 'host-typecheck-ratchet.mjs'), '--check'])
  exitCodes.hostRatchet = ratchet.status
  durations.hostRatchet = ratchet.sec
  // ② 盘点器
  const inv = judge(NODE, [path.join(ROOT, 'scripts', 'code-inventory.mjs'), '--json'])
  exitCodes.inventory = inv.status
  // 判不了的采集器：**不许当成 0 格 0 红**（ISS-829），逐条进 meta.unjudged 并在屏幕出声
  const unjudged = { ...RETIRED_SOURCES }
  if (ratchet.unjudged) unjudged.hostRatchet = ratchet.unjudged
  if (inv.unjudged) unjudged.inventory = inv.unjudged
  let invJson = null
  try { invJson = JSON.parse(inv.out.slice(inv.out.indexOf('{'))) } catch { invJson = null }
  const typeRatchet = parseRatchet(ratchet.out)
  const dedup = typeDebtDedup(typeRatchet) // 全量去重（与棘轮同一条 tsc 命令，只多收原文）
  typeRatchet.dedup = dedup
  if (dedup.mismatch) dedup.note = `去重那步的逐包累计 ${dedup.total} ≠ 棘轮现值 ${dedup.expect}：口径不一致，别用这个 distinct`
  const gates = []
  const dupKeys = [...gates.reduce((m, g) => m.set(g.key, (m.get(g.key) ?? 0) + 1), new Map())].filter(([, n]) => n > 1)
  if (dupKeys.length) notes.push(`⚠️ 门禁 key 撞车 ${dupKeys.length} 组（${dupKeys.map(([k, n]) => `${k}×${n}`).join(' · ')}）：对比按 key 匹配，撞车的两条会被当成同一条，得先改文案区分`)
  const quick = []
  const inventory = invJson
    ? pickInventory(invJson)
    : { metrics: Object.fromEntries(INVENTORY_PICKS.map((p) => [p.key, { id: p.id, value: null, number: null, title: null, missing: true }])), notes: ['inventory：code-inventory.mjs --json 输出解析失败 ⇒ 全记 null'] }
  const notes = []
  notes.push('可复算性：除 meta.takenAt 与 meta.durations 外逐字节稳定；这两个波动字段刻意放在同一行，方便 `sed s/"takenAt":.*//` 一次剥掉')
  notes.push(`树身份 meta.treeKind=${treeNote.treeKind}（cwd=${treeNote.cwd}）：棘轮上限、构建产物、软链都是某一棵树的状态，两棵树上同一份代码本来就有两个数（docs/memory/code-spec-inventory-2026-09-22.md §30）`)
  if (treeNote.treeKind !== 'main') notes.push(`⚠️ 本快照取自工作树（${treeNote.cwd}，主 checkout 在 ${treeNote.mainRoot ?? '未知'}）：数字可与主树比较**趋势**，不可当基线绝对数`)
  notes.push(`树指纹 meta.treeFingerprint：sha256(HEAD·分支·toplevel·排序后脏清单·git diff HEAD 内容哈希) 前 16 位（own 产物已剔除）——HEAD 相同而指纹不同 ⇒ 同一提交上工作区被改过 ⇒ 判"不可比"；HEAD 不同 ⇒ 跨提交前后对比，可比但只读趋势`)
  notes.push(taxNote())
  notes.push('durations 落在 meta 内（与 takenAt 同行）而不是顶层独立键：这是让上面的剥离规则天然覆盖两个波动字段的唯一排法')
  notes.push(`类型债去重口径：本脚本按包再跑一次与棘轮**同一条** tsc 命令（tsc -p <cfg> --noEmit，cwd 到包目录）收全量错误原文，键 = 仓库相对「文件(行,列): error TSxxxx」；total=${dedup.total}（应等于棘轮现值 ${dedup.expect}）· distinct=${dedup.distinct} · crossPkg=${dedup.crossPkg}（被 ≥2 个包各记一次的）`)
  if (dedup.mismatch) notes.push(`⚠️ 去重步与棘轮现值不一致（${dedup.total} ≠ ${dedup.expect}）：tsc 口径可能不同源，distinct 仅供参考`)
  notes.push('脏度量排除了本脚本自己的产物（scripts/baseline/gate-health/ 与 docs/mockups/gate-health-*.html），否则跑一次快照就会让快照不可复算')
  notes.push('god module 取 N4：code-inventory 里没有叫 K2a 的度量（K2a 是 lint 的"脚本行数 ≤1000"红线），N4 才是"≥1000 行源文件"')
  if (typeRatchet.summary.headerPackages !== null && typeRatchet.summary.headerPackages !== typeRatchet.summary.packages) notes.push(`棘轮头行 ${typeRatchet.summary.headerPackages} 包 ≠ 逐行解析到的 ${typeRatchet.summary.packages} 包：解析可能漏行，红项数以逐行为准`)
  if (typeRatchet.summary.redFromHeader !== null && typeRatchet.summary.redFromHeader !== typeRatchet.summary.redCounted) notes.push(`棘轮头行判红 ${typeRatchet.summary.redFromHeader} ≠ 逐行数出的 ${typeRatchet.summary.redCounted}：头行含 CI 严格档的"没在判"项，逐行只认 ✗`)
  for (const n of inventory.notes) notes.push(n)
  return {
    meta: {
      ...treeNote,
      takenAt: new Date().toISOString(),
      durations,
      exitCodes,
      // ISS-829：**判不了的来源逐条登记在这里**（不是省成 0 格 0 红）。空对象才表示"全测到了"。
      unjudged,
    },
    gates,
    quickGates: quick,
    typeRatchet,
    inventory: inventory.metrics,
    processTax: processTax(),
    knownRulerDefects: KNOWN_RULER_DEFECTS,
    notes,
  }
}

/**
 * 序列化：schema/meta 之外整块交给 JSON.stringify（稳定键序 + 2 空格缩进），
 * meta 里的 takenAt 与 durations 手工排成一行 —— 唯一目的就是让验收的 sed 一次剥干净。
 */
function serialize(snap) {
  const meta = snap.meta
  const J = JSON.stringify
  // 波动字段（takenAt + durations）刻意排同一行：验收的 `sed s/"takenAt":.*//` 一次剥干净，其余逐字节可复算
  const head = `{
  "schema": ${J(SCHEMA)},
  "meta": {
    "head": ${J(meta.head)},
    "branch": ${J(meta.branch)},
    "treeKind": ${J(meta.treeKind)},
    "treeFingerprint": ${J(meta.treeFingerprint)},
    "cwd": ${J(meta.cwd)},
    "dirtyFiles": ${meta.dirtyFiles},
    "exitCodes": ${J(meta.exitCodes)},
    "unjudged": ${J(meta.unjudged ?? {})},
    "takenAt": ${J(meta.takenAt)}, "durations": ${J(meta.durations)}
  },`
  const rest = {
    gates: snap.gates,
    quickGates: snap.quickGates,
    typeRatchet: snap.typeRatchet,
    inventory: snap.inventory,
    processTax: snap.processTax,
    knownRulerDefects: snap.knownRulerDefects,
    notes: snap.notes,
  }
  const body = JSON.stringify(rest, null, 2)
  return `${head}\n${body.slice(2)}\n`
}

/**
 * 日期一律按 Asia/Shanghai（老板看到的日期就是本机墙上的日期）：取 UTC 日期会在早八点前差一天。
 * 返回 { date: 'YYYY-MM-DD', stamp: 'YYYY-MM-DDTHHmm' }，文件名 / 页面标题 / 默认页名共用这一处。
 */
const TZ = 'Asia/Shanghai'
function wallClock(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const x = Object.fromEntries(f.formatToParts(d).map((t) => [t.type, t.value]))
  return { date: `${x.year}-${x.month}-${x.day}`, stamp: `${x.year}-${x.month}-${x.day}T${x.hour}${x.minute}` }
}

function cmdSnapshot(argv) {
  const i = argv.indexOf('--out')
  const outDir = i >= 0 ? path.resolve(argv[i + 1]) : DEFAULT_OUT_DIR
  const snap = collect()
  fs.mkdirSync(outDir, { recursive: true })
  // 同一分钟内连跑两次不能互相覆盖：撞名就加 -N（默认名 `<日期>T<HHmm>.json` 保持原样）
  // 工作树的产出**不占用基线文件名**：基线只有主 checkout 取的那份才算数（treeKind=main 才用纯时间戳）
  const base = `${wallClock().stamp}${snap.meta.treeKind === 'main' ? '' : '-worktree'}`
  let file = path.join(outDir, `${base}.json`)
  for (let n = 2; fs.existsSync(file); n++) file = path.join(outDir, `${base}-${n}.json`)
  fs.writeFileSync(file, serialize(snap))
  const red = snap.gates.filter((g) => !g.passed).length
  const dd = snap.typeRatchet.dedup
  const t = snap.typeRatchet.summary
  const tax = snap.processTax
  const uj = Object.entries(snap.meta.unjudged ?? {}), ujHas = (k) => uj.some(([x]) => x === k)
  if (snap.meta.treeKind !== 'main') console.log(`⚠️ 本快照取自工作树（${snap.meta.cwd}），数字不可与主树比较 —— 基线要在主 checkout 上取`)
  // ISS-829：**判不了的来源不许印成 `✓ 0/0`** —— 没有逐格数据时说"判不了"，不说"0 个红"。
  const gateLine = snap.gates.length ? `门禁红项 ${red}/${snap.gates.length}` : `门禁红项 ⛔ 判不了（0 格数据 ⇒ 不可读成 0 个红）`
  const quickLine = snap.quickGates.length ? snap.quickGates.map((q) => `${q.id} ${q.current}/${q.debt}`).join(' / ') : '⛔ 判不了'
  console.log(`${snap.gates.length ? '✓' : '⚠️'} 快照 ${path.relative(ROOT, file) || file}`, `  树 ${snap.meta.treeKind} · 指纹 ${snap.meta.treeFingerprint}`, `  ${gateLine} · 快闸 ${quickLine}`)
  for (const [k, v] of uj) console.log(`  ⛔ 判不了 ${k}：${v}`)
  const hd = dd?.byFamily?.['host 半'] ?? null
  // ISS-829：棘轮本身没跑成时，`0 包 / 现值 0` 同样是假绿 —— 一并改印「判不了」
  const ratchetLine = ujHas('hostRatchet') ? `类型棘轮 ⛔ 判不了（0 包不代表 0 条债）` : `类型棘轮 ${t.packages} 包 · 现值 ${t.current} / 上限 ${t.ceiling}（${t.nullCurrent} 包不判未计入 · ${t.nullCeiling} 包上限未记录）· 逐行判红 ${t.redCounted}`
  console.log(`  ${ratchetLine} · 去重现值 host ${hd ? `${hd.distinct}（逐包累计 ${hd.total} · 跨包重复 ${hd.crossPkg}）` : '未算'}`, `  耗时 秒：hostRatchet ${snap.meta.durations.hostRatchet} · 税比 ${tax.gateChurn}/${tax.commits30d}（${tax.gateRatio}%）· 返工 ${tax.rework}（${tax.reworkRatio}%）`)
}

// ── 对比：方向的判据只写一处（higherIsWorse），页面/控制台/markdown 都用它 ────────────────────

const KIND_BAD = '恶化', KIND_GOOD = '改善', KIND_INFO = '信息'

/** @param higherIsWorse true=数变大是坏事（债、红项）；false=数变大是好事（通过数） */
function numChange(scope, item, from, to, higherIsWorse = true) {
  if (from === to) return null
  if (from === null || from === undefined || to === null || to === undefined) return { kind: KIND_INFO, scope, item, from, to, note: '可测性/口径变化（一侧为 null）' }
  const up = to > from
  return { kind: up === higherIsWorse ? KIND_BAD : KIND_GOOD, scope, item, from, to, delta: to - from }
}

/** 方向无关的"变了没有"（换树、机器负载、规模）：只进信息档，不判好坏 */
function infoChange(scope, item, from, to) {
  if (from === to) return null
  return { kind: KIND_INFO, scope, item, from, to }
}

function boolChange(scope, item, fromBool, toBool) {
  if (fromBool === toBool) return null
  return { kind: fromBool && !toBool ? KIND_BAD : KIND_GOOD, scope, item, from: fromBool ? '绿' : '红', to: toBool ? '绿' : '红' }
}

/**
 * 可比性判定：树指纹 / 树身份 / 分支三者任一不同 ⇒ 两份快照**不可比**。
 * 这一条是为了不让"两次之间有人改了树"被读成"没变化"（那正好是最危险的那种假绿）。
 */
function comparability(a, b) {
  const why = []
  const crossCommit = a.meta.head !== b.meta.head
  // 分两档：**跨提交**（HEAD 不同）= 老板要的"修复前后对比"，按定义就是两棵树 ⇒ 可比，只标趋势；
  //          **同一提交**上指纹不同 = 有人中途改了工作区 ⇒ 不可比（幂等检查要的就是这一档）。
  if (!crossCommit) {
    if (a.meta.treeFingerprint !== b.meta.treeFingerprint) why.push(`同一提交但树指纹不同 ${a.meta.treeFingerprint} ≠ ${b.meta.treeFingerprint}`)
    if (a.meta.treeKind !== b.meta.treeKind) why.push(`树身份 ${a.meta.treeKind} ≠ ${b.meta.treeKind}`)
  }
  if (a.meta.branch !== b.meta.branch && !crossCommit) why.push(`分支 ${a.meta.branch} ≠ ${b.meta.branch}`)
  // 不看 cwd：本项目是双电脑（153 / 28），两台机器的快照永远"路径不同"⇒ 告警会变常驻噪声
  // 门禁增删/改名**不降级**：消失与新增那两格不可作数，但红项/耗时/棘轮等合计仍可读（批 2 实测 8/68 可信）
  const kb = new Set(b.gates.map(gateKey))
  const ka = new Set(a.gates.map(gateKey))
  const churn = { gone: a.gates.filter((g) => !kb.has(gateKey(g))), added: b.gates.filter((g) => !ka.has(gateKey(g))) }
  churn.text = churn.gone.length || churn.added.length ? `门禁项有增删/改名：消失 ${churn.gone.length} / 新增 ${churn.added.length}，逐项 delta 里消失与新增两格不可作数，合计仍可读` : ''
  churn.renames = churn.gone.length && churn.gone.length === churn.added.length ? churn.gone.map((g, i) => [gateKey(g), gateKey(churn.added[i])]) : []
  for (const s of [a, b]) if (s.typeRatchet?.dedup?.mismatch) why.push('去重自校验失败（total ≠ 棘轮现值），distinct 不可信')
  const mode = why.length ? 'blocked' : crossCommit ? 'cross-commit' : 'idempotent'
  const label = mode === 'cross-commit' ? `跨提交对比：HEAD ${a.meta.head.slice(0, 7)}→${b.meta.head.slice(0, 7)}，绝对值受树影响（产物/软链），趋势可比` : ''
  return { comparable: why.length === 0, why, mode, label, crossCommit, churn }
}

function compareSnapshots(a, b) {
  const changes = [], cmp = comparability(a, b)
  const push = (c) => { if (c) changes.push(c) }
  // ── meta（信息档：换了树/换了 HEAD 时前后数字本来就不该直接比）
  if (a.meta.head !== b.meta.head) push({ kind: KIND_INFO, scope: 'meta', item: 'HEAD', from: a.meta.head.slice(0, 10), to: b.meta.head.slice(0, 10) })
  if (a.meta.branch !== b.meta.branch) push({ kind: KIND_INFO, scope: 'meta', item: '分支', from: a.meta.branch, to: b.meta.branch })
  for (const w of cmp.why) push({ kind: KIND_INFO, scope: 'meta', item: '不可比', from: w.split(' ≠ ')[0], to: w.split(' ≠ ')[1], note: '树/工作区不同 ⇒ 下面的 delta 只能看趋势' })
  // ── 门禁：红项计数 + 逐项红绿翻转 + 增删
  const redA = a.gates.filter((g) => !g.passed).length
  const redB = b.gates.filter((g) => !g.passed).length
  const byNameA = new Map(a.gates.map((g) => [gateKey(g), g]))
  const byNameB = new Map(b.gates.map((g) => [gateKey(g), g]))
  const gone = a.gates.filter((g) => !byNameB.has(gateKey(g)))
  const goneRed = gone.filter((g) => !g.passed).length
  // 红项合计：**集合变了就不许读成改善** —— 删掉一条红门禁会让 18→17 看着像收敛（审查员复现的假绿）
  const redChg = numChange('门禁', `红项 ${redA}/${a.gates.length}`, redA, redB, true)
  // 消失的红门禁**有新增补偿**（改名/合并）⇒ 合计按名义值读；纯删不补 ⇒ 账没了，不许读成改善
  const compensated = cmp.churn.added.length > 0
  if (redChg) {
    if (goneRed && !compensated) { redChg.kind = KIND_BAD; redChg.note = `其中 ${goneRed} 条红门禁整项消失且无新增补偿 ⇒ 合计下降不作为改善` }
    else if (goneRed) redChg.note = `其中 ${goneRed} 条红门禁整项消失、同时新增 ${cmp.churn.added.length} 条（疑改名/合并）⇒ 合计按名义值读`
    push(redChg)
  } else if (goneRed && !compensated) push({ kind: KIND_BAD, scope: '门禁', item: '红项合计', from: redA, to: redB, note: `${goneRed} 条红门禁整项消失且无新增补偿` })
  for (const ga of a.gates) {
    const gb = byNameB.get(gateKey(ga))
    if (!gb) { push({ kind: ga.passed ? KIND_INFO : KIND_BAD, scope: '门禁', item: ga.name, from: ga.passed ? '绿' : '红', to: '消失', note: ga.passed ? '绿门禁消失（判据被摘掉了）' : '红门禁消失：账没清，是门禁没了' }); continue }
    push(boolChange('门禁', gateKey(ga), ga.passed, gb.passed))
    if (ga.name !== gb.name) push(infoChange('门禁', `${gateKey(ga)} 文案`, ga.name, gb.name))
  }
  for (const gb of b.gates) {
    if (byNameA.has(gateKey(gb))) continue
    push({ kind: gb.passed ? KIND_INFO : KIND_BAD, scope: '门禁', item: gb.name, from: '不存在', to: gb.passed ? '绿' : '红', note: '新增门禁项' })
  }
  if (cmp.churn.gone.length || cmp.churn.added.length) push({ kind: KIND_INFO, scope: '门禁', item: '集合变化', from: `消失 ${cmp.churn.gone.length}`, to: `新增 ${cmp.churn.added.length}`, note: cmp.churn.text })
  for (const [o, n] of cmp.churn.renames) push({ kind: KIND_INFO, scope: '门禁', item: '疑似改名', from: o, to: n, note: '按红绿与位置对齐，未自动合并' })
  // ── 快闸：现值（债）与已登记存量债都不该变大
  const qA = new Map(a.quickGates.map((q) => [q.id, q]))
  for (const qa of a.quickGates) {
    if (b.quickGates.some((x) => x.id === qa.id)) continue
    push({ kind: qa.current > 0 ? KIND_BAD : KIND_INFO, scope: '快闸', item: qa.id, from: `${qa.current}/${qa.debt}`, to: '消失', note: qa.current > 0 ? '整格从输出里消失：账没清，是这格没跑' : '现值为 0 的格消失' })
  }
  for (const qb of b.quickGates) {
    const qa = qA.get(qb.id)
    if (!qa) { push({ kind: KIND_INFO, scope: '快闸', item: qb.id, from: '不存在', to: `${qb.current}/${qb.debt}` }); continue }
    push(numChange('快闸', `${qb.id} 现值`, qa.current, qb.current, true))
    push(numChange('快闸', `${qb.id} 存量债`, qa.debt, qb.debt, true))
  }
  for (const [side, s] of [['旧', a], ['新', b]]) if (s.typeRatchet?.dedup?.mismatch) push({ kind: KIND_BAD, scope: '类型债', item: `${side}快照去重自校验`, from: s.typeRatchet.dedup.total, to: s.typeRatchet.dedup.expect, note: 'total ≠ 棘轮现值 ⇒ distinct 不可信，先修采集' })
  // ── 类型棘轮：逐包现值 / 上限 / 状态
  const rowsA = new Map(a.typeRatchet.families.flatMap((f) => f.rows.map((r) => [`${f.family} / ${r.pkg}`, r])))
  const rowsB = new Map(b.typeRatchet.families.flatMap((f) => f.rows.map((r) => [`${f.family} / ${r.pkg}`, r])))
  for (const [k, rb] of rowsB) {
    const ra = rowsA.get(k)
    if (!ra) { push({ kind: KIND_INFO, scope: '类型棘轮', item: k, from: '不存在', to: `${rb.current ?? '—'} / ${rb.ceiling ?? '未记录'}` }); continue }
    push(numChange('类型棘轮', k, ra.current, rb.current, true))
    push(numChange('类型棘轮', `${k} 上限`, ra.ceiling, rb.ceiling, true)) // 抬上限 = 恶化
    if (ra.state !== rb.state) push({ kind: KIND_INFO, scope: '类型棘轮', item: `${k} 状态`, from: ra.state, to: rb.state })
  }
  for (const [k, ra] of rowsA) {
    if (rowsB.has(k)) continue
    const had = (ra.current ?? 0) > 0
    push({ kind: had ? KIND_BAD : KIND_INFO, scope: '类型棘轮', item: k, from: `${ra.current ?? '—'} / ${ra.ceiling ?? '未记录'}`, to: '消失', note: had ? '现值 > 0 的包整项消失：账没了不等于还了' : '现值 0 的包消失' })
  }
  push(numChange('类型棘轮', '判红包数', a.typeRatchet.summary.redCounted, b.typeRatchet.summary.redCounted, true))
  for (const k of ['distinct', 'total', 'crossPkg']) push(numChange('类型债', `${k}（去重口径）`, a.typeRatchet.dedup?.[k] ?? null, b.typeRatchet.dedup?.[k] ?? null, true))
  // ── 盘点器：结构度量（行数 T1 只是规模，不当债判）
  const dirOf = { dupImplementations: true, copyPasteClusters: true, godModules: true, zeroRefExports: true, sourceLines: null }
  for (const key of Object.keys(dirOf)) {
    const ma = a.inventory[key]
    const mb = b.inventory[key]
    if (!ma || !mb) {
      if (ma && !mb) push({ kind: (ma.number ?? 0) > 0 ? KIND_BAD : KIND_INFO, scope: '盘点', item: `${ma.id ?? key} ${key}`, from: fmtVal(ma.value), to: '消失', note: '度量整项消失' })
      continue
    }
    if (dirOf[key] === null) push(infoChange('盘点', `${ma.id} ${key}`, ma.number, mb.number)) // 规模不是债
    else push(numChange('盘点', `${ma.id} ${key}`, ma.number, mb.number, true))
  }
  // ── 流程税
  push(infoChange('流程税', '近 30 天提交数', a.processTax.commits30d, b.processTax.commits30d))
  push(numChange('流程税', '门禁/基线类提交', a.processTax.gateChurn, b.processTax.gateChurn, true))
  push(numChange('流程税', '返工/审查类提交', a.processTax.rework, b.processTax.rework, true))
  // ── 耗时（信息档：机器负载噪声，不判好坏）
  for (const k of Object.keys(a.meta.durations ?? {})) push(infoChange('耗时', `${k} 秒`, a.meta.durations[k], b.meta.durations?.[k]))
  return changes
}

const MARK = { 恶化: '✗', 改善: '✓', 信息: '·' }
const fmtVal = (v) => (v === null || v === undefined ? '—' : String(v))

const sideLine = (s) => `${s.meta.takenAt} · head ${s.meta.head.slice(0, 10)} · ${s.meta.branch}${s.meta.branch === s.meta.treeKind ? '' : ` · ${s.meta.treeKind}`} · 指纹 ${s.meta.treeFingerprint}`
const cmpLine = (cmp) => (cmp.mode === 'cross-commit' ? `· ${cmp.label}` : cmp.comparable ? '树指纹一致：同一棵树同一份工作区，逐项可比' : `⚠️ 不可比：${cmp.why.join(' · ')}`)

function renderConsole(a, b, changes) {
  const out = [], cmp = comparability(a, b)
  out.push(`gate-health --compare`, `  旧 ${sideLine(a)}`, `  新 ${sideLine(b)}`, `  ${cmpLine(cmp)}`)
  for (const c of changes) {
    const d = c.delta !== undefined && c.delta !== 0 ? ` (${c.delta > 0 ? '+' : ''}${fmtD(c.delta)}${c.delta > 0 ? '↑' : '↓'})` : ''
    out.push(`${MARK[c.kind]} ${c.kind}  [${c.scope}] ${c.item}  ${fmtVal(c.from)} → ${fmtVal(c.to)}${d}${c.note ? `  ${c.note}` : ''}`)
  }
  const n = (k) => changes.filter((c) => c.kind === k).length
  out.push(`合计：恶化 ${n(KIND_BAD)} · 改善 ${n(KIND_GOOD)} · 信息 ${n(KIND_INFO)}`)
  if (!changes.length && cmp.comparable) out.push(`· 0 变化：两份快照逐项一致（${cmp.mode === 'idempotent' ? '树指纹相同' : '跨提交'}）`)
  else if (!changes.length) out.push(`· 0 变化，但${cmp.comparable ? '' : '树指纹不同 ⇒ 不可比（这不是"一致"，是没东西可比）'}`)
  return out.join('\n')
}

function renderMarkdown(a, b, changes) {
  const out = []
  out.push(`# 门禁健康度对比`, '')
  const cmp = comparability(a, b)
  out.push(`- 旧：\`${sideLine(a)}\``, `- 新：\`${sideLine(b)}\``, '', cmpLine(cmp))
  out.push('')
  if (!changes.length) { out.push(cmp.comparable ? '**0 变化**：两份快照逐项一致。' : '**0 变化但不可比**：同一提交上工作区被改过，不能读成"没变"。'); return out.join('\n') }
  out.push('| 判定 | 范围 | 项目 | 旧 | 新 | 差 |', '|---|---|---|---|---|---|')
  for (const c of changes) {
    const d = c.delta === undefined || c.delta === 0 ? '—' : `${c.delta > 0 ? '+' : ''}${fmtD(c.delta)}`
    out.push(`| ${MARK[c.kind]} ${c.kind} | ${c.scope} | ${c.item} | ${fmtVal(c.from)} | ${fmtVal(c.to)} | ${d} |`)
  }
  const n = (k) => changes.filter((c) => c.kind === k).length
  out.push('', `合计：恶化 ${n(KIND_BAD)} · 改善 ${n(KIND_GOOD)} · 信息 ${n(KIND_INFO)}`)
  return out.join('\n')
}

function readSnap(file) {
  const s = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  if (!s.meta || !Array.isArray(s.gates)) throw new Error(`${file} 不像 gate-health 快照（缺 meta / gates）`)
  return s
}

function cmdCompare(argv) {
  const i = argv.indexOf('--compare')
  const files = argv.slice(i + 1).filter((x) => !x.startsWith('--'))
  if (files.length < 2) { usage(); process.exit(2) }
  const a = readSnap(files[0])
  const b = readSnap(files[1])
  const changes = compareSnapshots(a, b)
  console.log(argv.includes('--md') ? renderMarkdown(a, b, changes) : renderConsole(a, b, changes))
}

// ── 状态页（单文件、无外链；配色与版式照 scripts/code-inventory-page.mjs 的对照器） ────────────────────

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const shortPath = (p) => String(p).replace(process.env.HOME ?? '', '~')
const pct = (x) => `${Math.max(0, Math.min(100, Math.round(x * 1000) / 10))}%`

/** 门禁红项进/退：方向由 higherIsWorse 决定，颜色只由"好坏"决定（恶化红 / 改善绿） */
/** 差值一律格式化过：计数用整数，耗时这类小数留 1 位（`a-b` 直接打印会出 4.8999999999999977 那种尾巴） */
const fmtD = (d) => (Number.isInteger(d) ? String(d) : (Math.round(d * 10) / 10).toFixed(1))

function deltaTag(baseVal, prevVal, higherIsWorse) {
  if (prevVal === null || prevVal === undefined || baseVal === null || baseVal === undefined) return ''
  if (baseVal === prevVal) return `<span class="dl same">＝ 无变化</span>`
  const up = baseVal > prevVal
  const kind = higherIsWorse === null ? KIND_INFO : up === higherIsWorse ? KIND_BAD : KIND_GOOD
  const cls = kind === KIND_BAD ? 'worse' : kind === KIND_GOOD ? 'better' : 'info'
  const arrow = up ? '↑' : '↓'
  const d = baseVal - prevVal
  return `<span class="dl ${cls}">${arrow}${d > 0 ? '+' : ''}${fmtD(d)} ${kind}</span>`
}

function bar(state, current, ceiling, marker) {
  // 档位按棘轮自己的标记定（marker 是判据的结论），中文状态只用于展示：
  //   未记录 / 未装齐 / 本族不判 ⇒ 灰（"没在判"不许画成绿）；✗ ⇒ 红；等于上限 ⇒ 黄；其余判过的 ⇒ 绿
  const tone = /未记录|未装齐|非 darwin/u.test(state) || marker === '·' ? 'na'
    : marker === '✗' ? 'over'
      : /等于上限/u.test(state) ? 'at' : 'under'
  const max = Math.max(current ?? 0, ceiling ?? 0, 1)
  const fill = current === null ? 0 : (current / max) * 100
  const tick = ceiling === null ? null : (ceiling / max) * 100
  const tickHtml = tick === null ? '' : `<u style="left:${pct(tick / 100)}"></u>`
  return `<div class="bar t-${tone}"><i style="width:${pct(fill / 100)}"></i>${tickHtml}</div>`
}

function renderPage(base, against) {
  const prev = against ?? null
  const cmp = prev ? comparability(prev, base) : null // 参数序 = 旧→新：集合变化与 HEAD 箭头才朝对方向
  const red = base.gates.filter((g) => !g.passed).length
  const prevRed = prev ? prev.gates.filter((g) => !g.passed).length : null
  const t = base.typeRatchet.summary
  const pt = prev?.typeRatchet?.summary ?? null
  const dd = base.typeRatchet.dedup ?? null
  const hd = dd?.byFamily?.['host 半'] ?? null
  const pdh = prev?.typeRatchet?.dedup?.byFamily?.['host 半'] ?? null
  const d = base.meta.durations ?? {}
  const pd = prev?.meta?.durations ?? null
  const tax = base.processTax
  const ptax = prev?.processTax ?? null
  const inv = base.inventory
  // ── KPI（ISS-829：没有逐格数据时说「判不了」，**不许把 0 格印成 0 红**）
  const ujPage = base.meta.unjudged ?? {}
  const kpis = [
    base.gates.length
      ? { k: '门禁红项', v: `${red}<span class="of">/${base.gates.length}</span>`, dl: prev ? deltaTag(red, prevRed, true) : '', sub: `逐格数据 ${base.gates.length} 项${cmp?.churn?.text ? ' · 有增删/改名' : ''}` }
      : { k: '门禁红项', v: '<span class="na">—</span>', dl: '', sub: `⛔ 判不了：${esc(ujPage.gates ?? '无逐格门禁数据')}` },
    { k: '类型债 现值（去重）', v: `${hd?.distinct ?? '—'}<span class="of">host 半</span>`, dl: prev && hd ? deltaTag(hd.distinct, pdh?.distinct ?? null, true) : '', sub: hd ? `逐包累计 ${hd.total} · 跨包重复 ${hd.crossPkg} 条 · client 半另 ${dd.byFamily['client 半']?.distinct ?? '—'}` : '未算（找不到 typescript）' },
    { k: '类型棘轮判红', v: `${t.redCounted}<span class="of">/${t.packages} 包</span>`, dl: prev ? deltaTag(t.redCounted, pt.redCounted, true) : '', sub: `上限合计 ${t.ceiling}（${t.nullCurrent} 包不判未计入 · ${t.nullCeiling} 包上限未记录）` },
    {
      k: '耗时（秒）',
      v: `<span class="tri">${d.hostRatchet ?? '—'}</span>`,
      dl: pd ? deltaTag(Math.round((d.hostRatchet ?? 0) * 10) / 10, Math.round((pd.hostRatchet ?? 0) * 10) / 10, null) : '',
      sub: '类型棘轮（快闸/全量守卫的载体已退役，ISS-800）',
    },
    { k: '近 30 天流程税', v: `${tax.gateRatio ?? '—'}<span class="of">%</span>`, dl: prev ? deltaTag(tax.gateChurn, ptax.gateChurn, true) : '', sub: `${tax.gateChurn}/${tax.commits30d} 提交是门禁/基线/棘轮类` },
  ]
  // ── 门禁总表：**只此一张表用 <tr>**（其余列表用 div），于是 `grep -c '<tr'` = 门禁行数
  const prevGate = new Map((prev?.gates ?? []).map((g) => [gateKey(g), g]))
  const gateRows = base.gates.map((g) => {
    const p = prevGate.get(gateKey(g))
    const flip = p && p.passed !== g.passed
    const flipTag = flip ? (g.passed ? '<span class="dl better">↓ 由红转绿 改善</span>' : '<span class="dl worse">↑ 由绿转红 恶化</span>') : ''
    return `<tr class="g ${g.passed ? 'pass' : 'fail'}"><td class="mk">${g.passed ? '✓' : '✗'}</td><td class="nm">${esc(g.name)}</td><td class="dp">${g.detailPath ? esc(g.detailPath) : ''}</td><td class="dg">${flipTag}</td></tr>`
  })
  // ── 棘轮分面
  const prevRows = new Map((prev?.typeRatchet?.families ?? []).flatMap((f) => f.rows.map((r) => [`${f.family} / ${r.pkg}`, r])))
  const famBlocks = base.typeRatchet.families.map((f) => {
    const rows = f.rows.map((r) => {
      const prow = prevRows.get(`${f.family} / ${r.pkg}`)
      const dl = prow ? deltaTag(r.current, prow.current, true) : ''
      return `<div class="rrow">${bar(r.state, r.current, r.ceiling, r.marker)}<div class="rline"><b>${esc(r.pkg)}</b><span class="num">${r.current === null ? '—' : r.current} / ${r.ceiling === null ? '未记录' : r.ceiling}</span><span class="st">${esc(r.state)}</span>${dl}</div></div>`
    }).join('\n')
    return `<section class="fam"><h3>${esc(f.family)}<span class="cnt">${f.rows.length} 包</span></h3>\n${rows}\n</section>`
  }).join('\n')
  // ── 债务与流程税
  const invRows = Object.entries(inv).map(([key, m]) => {
    const pv = prev?.inventory?.[key]
    const dl = pv ? deltaTag(m.number, pv.number, key === 'sourceLines' ? null : true) : ''
    return `<div class="drow inv"><span class="mid">${esc(m.id)}</span><span class="mval">${m.value === null ? '<i class="na">—</i>' : esc(m.value)}</span><span class="mt">${esc(m.title ?? key)}</span><span>${dl}</span></div>`
  }).join('\n')
  const defectRows = base.knownRulerDefects.map((x) => `<div class="drow"><span class="mid">${esc(x.id)}</span><span class="mt">${esc(x.what)}</span><span class="ev">${esc(x.evidence)}</span></div>`).join('\n')
  const cmdLine = `node scripts/gate-health.mjs --page ${baseFileLabel()}${prev ? ` --against ${prevFileLabel()}` : ''}`
  const banner = [
    base.meta.treeKind === 'main'
      ? ''
      : `<div class="banner warn">⚠️ 本快照取自<b>工作树</b>（<code>${esc(shortPath(base.meta.cwd))}</code>）：棘轮上限与构建产物是某一棵树的状态，数字可与主树比较<b>趋势</b>，不能当基线绝对值 —— 基线要在主 checkout 上取</div>`,
    cmp && cmp.mode === 'blocked' ? `<div class="banner warn">⚠️ 与对比基准<b>不可比</b>：${esc(cmp.why.join(' · '))}</div>` : cmp && cmp.mode === 'cross-commit' ? `<div class="banner">· ${esc(cmp.label)}</div>` : '',
    cmp && cmp.mode !== 'blocked' && cmp.churn.text ? `<div class="banner">· ${esc(cmp.churn.text)}</div>` : '',
  ].filter(Boolean).join('\n  ')
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>门禁健康度 · ${esc(wallClock(new Date(base.meta.takenAt)).date)}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1c1a;--mut:#6b6b66;--line:#e4e4e0;--acc:#2f5cff;--warn:#b4341c;--warn2:#a5661a;--ok:#1f7a4d;--card:#fff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
header{padding:32px 24px 20px;border-bottom:1px solid var(--line);background:var(--card)}
.wrap{max-width:1100px;margin:0 auto;padding:0 24px 80px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--mut);font-size:13px;margin:0}.meta{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:14px;font-size:12px;color:var(--mut)}
code{font-family:var(--mono);font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.banner{margin:16px 0 0;padding:10px 14px;border-radius:8px;font-size:12.5px;line-height:1.55;border:1px solid var(--line);background:var(--card)}.banner.warn{border-color:rgba(180,52,28,.45);background:rgba(180,52,28,.055);color:var(--warn)}.banner code{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.08);color:inherit}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:22px 0 6px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.kpi .v{font-size:30px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.1}.kpi .k{font-size:12px;color:var(--mut);margin:0 0 6px}.kpi .v .of{font-size:13px;font-weight:500;color:var(--mut);margin-left:4px}.kpi .v .tri{font-size:19px}.kpi .s{font-size:11.5px;color:var(--mut);margin-top:6px;line-height:1.4}.dl{font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;margin-left:6px}.dl.better{color:var(--ok)}.dl.worse{color:var(--warn)}.dl.info{color:var(--mut)}.dl.same{color:var(--mut);font-weight:400}
h2{font-size:17px;margin:34px 0 10px;display:flex;align-items:center;gap:9px}
h2 .cnt,h3 .cnt{font-size:12px;color:var(--mut);font-weight:500}
table{border-collapse:collapse;width:100%;font-size:13px;background:var(--card)}
.ghead{display:grid;grid-template-columns:34px 1fr 300px 150px;gap:8px;padding:7px 9px;font-size:12px;color:var(--mut);font-weight:600;background:var(--card);border-bottom:1px solid var(--line);border-radius:10px 10px 0 0}
td{border-bottom:1px solid var(--line);padding:6px 9px;vertical-align:top}
tr.pass td.mk{color:var(--ok)}tr.fail td.mk{color:var(--warn)}
tr.fail{background:rgba(180,52,28,.045)}td.dp{font-family:var(--mono);font-size:11px;color:var(--mut);word-break:break-all}
td.mk{font-weight:700;text-align:center}td.nm{line-height:1.45}
.fam{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:10px 0}.fam h3{font-size:14px;margin:0 0 8px;display:flex;gap:8px;align-items:baseline}.rrow{padding:5px 0;border-top:1px dashed var(--line)}.bar{position:relative;height:6px;border-radius:3px;background:var(--bg);border:1px solid var(--line);overflow:hidden}.bar i{display:block;height:100%;border-radius:2px;background:var(--mut)}.bar u{position:absolute;top:-1px;bottom:-1px;width:1px;background:var(--fg);opacity:.45}.bar.t-over i{background:var(--warn)}.bar.t-at i{background:var(--warn2)}.bar.t-under i{background:var(--ok)}.bar.t-na i{background:var(--mut)}.rline{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-top:3px;font-size:12.5px}.rline b{font-family:var(--mono);font-size:12px;min-width:170px}.rline .num{font-variant-numeric:tabular-nums;font-weight:600;min-width:96px}.rline .st{color:var(--mut);font-size:11.5px}.drows{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 16px;margin:10px 0}.drow{display:grid;grid-template-columns:120px 1fr 220px;gap:10px;padding:6px 0;border-top:1px dashed var(--line);font-size:12.5px;align-items:baseline}.drow.inv{grid-template-columns:64px 140px 1fr 130px}.drow:first-child{border-top:0}.drow .mid{font-family:var(--mono);font-size:11.5px;color:var(--mut)}.drow .mval{font-variant-numeric:tabular-nums;font-weight:600}.drow .mt{line-height:1.45}.drow .ev{font-family:var(--mono);font-size:11px;color:var(--mut);word-break:break-all}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:820px){.cols{grid-template-columns:1fr}.ghead{grid-template-columns:28px 1fr}.ghead span:nth-child(3),.ghead span:nth-child(4),td.dp,td.dg{display:none}.drow{grid-template-columns:90px 1fr}}
footer{border-top:1px solid var(--line);margin-top:40px;padding-top:14px;color:var(--mut);font-size:12px;line-height:1.7}
footer b{color:var(--fg)}
</style></head>
<body>
<header><div class="wrap" style="padding-bottom:0">
  <h1>门禁健康度状态页</h1>
  <p class="sub">${esc(base.gates.length)} 项门禁 · ${esc(t.packages)} 个宿主包的类型棘轮 · 结构度量 · 流程税 —— 一份快照的可视形态${prev ? '，右侧 delta 对比上一份快照' : ''}</p>
  <div class="meta">
    <span>采集 <b>${esc(wallClock(new Date(base.meta.takenAt)).date)} ${esc(base.meta.takenAt.slice(11, 19))}Z</b>（Asia/Shanghai ${esc(wallClock(new Date(base.meta.takenAt)).stamp.slice(11, 13))}:${esc(wallClock(new Date(base.meta.takenAt)).stamp.slice(13))}）</span>
    <span>head <code>${esc(base.meta.head.slice(0, 10))}</code></span>
    <span>分支 <b>${esc(base.meta.branch)}</b></span>
    <span>树 <b>${esc(base.meta.treeKind)}</b> · 指纹 <code>${esc(base.meta.treeFingerprint)}</code></span>
    <span>脏文件 <b>${base.meta.dirtyFiles}</b>（不含本脚本产物）</span>
    ${prev ? `<span>对比基准 <b>${esc(prev.meta.takenAt)}</b> · head <code>${esc(prev.meta.head.slice(0, 10))}</code></span>` : ''}
  </div>
</div></header>
<div class="wrap">
  ${banner}
  <div class="kpis">
    ${kpis.map((x) => `<article class="kpi"><p class="k">${x.k}${x.dl}</p><div class="v">${x.v}</div><p class="s">${x.sub}</p></article>`).join('\n    ')}
  </div>
  <h2>① 门禁总表 <span class="cnt">${red} 红 / ${base.gates.length} 项（红项附明细路径）</span></h2>
  <div class="ghead"><span></span><span>门禁</span><span>失败明细</span><span>对比</span></div>
  <table class="gates"><colgroup><col style="width:34px"><col><col style="width:300px"><col style="width:150px"></colgroup><tbody>
${gateRows.join('\n')}
  </tbody></table>
  <h2>② 类型棘轮分面 <span class="cnt">现值 ${t.current} / 上限 ${t.ceiling}（${t.nullCurrent} 包不判未计入 · ${t.nullCeiling} 包上限未记录）· 判红 ${t.redCounted} 包 · 条：超限红 / 等于上限黄 / 低于上限绿 / 未判灰</span></h2>
  ${famBlocks}
  <h2>③ 债务与流程税</h2>
  <div class="cols">
    <div>
      <h3>结构度量（code-inventory）</h3>
      <div class="drows">
${invRows}
      </div>
      <h3>流程税（近 30 天${tax.commits30d} 次提交）</h3>
      <div class="drows">
        <div class="drow"><span class="mid">门禁/基线类</span><span class="mval">${tax.gateChurn}（${tax.gateRatio ?? '—'}%）</span><span class="mt">提交说明命中 棘轮|门禁|基线|baseline|lint|ratchet|复录</span></div>
        <div class="drow"><span class="mid">返工/审查类</span><span class="mval">${tax.rework}（${tax.reworkRatio ?? '—'}%）</span><span class="mt">提交说明命中 返工|审查|F&lt;数字&gt;</span></div>
        <div class="drow"><span class="mid">提交总数</span><span class="mval">${tax.commits30d}</span><span class="mt">git log --since="30 days ago" --oneline 的条数</span></div>
      </div>
    </div>
    <div>
      <h3>已知「尺子造假账」前科（${base.knownRulerDefects.length} 条）</h3>
      <div class="drows">
${defectRows}
      </div>
    </div>
  </div>
  <footer>
    <b>生成命令</b>：<code>${esc(cmdLine)}</code><br>
    <b>数据来源</b>：<code>scripts/host-typecheck-ratchet.mjs --check</code> · <code>scripts/code-inventory.mjs --json</code> · <code>git log</code> —— 数字一律取自这些脚本的原样输出，本页不自己算判据。<b>逐格门禁与快闸两格自 ISS-829 起标记「判不了」</b>：它们的载体 <code>guard-baselines.sh</code> / <code>gate-fast.mjs</code> 已被 ISS-800 退役，本页不再提供这两份数据（**不是 0 红**）。<br>
    <b>口径</b>：只读采集，不改判据（本页与快照脚本只解析既有门禁的输出，任何一条判据的松紧都没有动）。<br>
    <b>税比口径</b>：${esc(taxNote())}<br>
    <b>可比性</b>：HEAD 不同 = 跨提交前后对比（可比，标注趋势）；HEAD 相同而树指纹不同 = 同一提交上工作区被改过 ⇒ 判「不可比」。树指纹 = sha256(HEAD·分支·toplevel·脏清单·diff 内容哈希) 前 16 位。<br>
    <b>去重现值</b>：${hd ? `host 半 distinct ${hd.distinct}（逐包累计 ${hd.total} · 跨包重复 ${hd.crossPkg}）· 全部三族 distinct ${dd.distinct}` : '未算'} —— 口径：按包跑与棘轮同一条 tsc 收全量原文，键 = 仓库相对「文件(行,列): error TSxxxx」　<b>快照</b>：<code>node scripts/gate-health.mjs --snapshot</code>
  </footer>
</div>
</body></html>`

  return html
}

/** 页面上显示的输入文件名（只取 basename，避免把绝对路径写进产物） */
let BASE_LABEL = ''
let PREV_LABEL = ''
const baseFileLabel = () => BASE_LABEL || '<base.json>'
const prevFileLabel = () => PREV_LABEL || '<prev.json>'

function cmdPage(argv) {
  const i = argv.indexOf('--page')
  const file = argv.slice(i + 1).find((x) => !x.startsWith('--'))
  if (!file) { usage(); process.exit(2) }
  const againstIdx = argv.indexOf('--against')
  const againstFile = againstIdx >= 0 ? argv[againstIdx + 1] : null
  const outIdx = argv.indexOf('--out')
  BASE_LABEL = path.basename(file)
  PREV_LABEL = againstFile ? path.basename(againstFile) : ''
  const base = readSnap(file)
  const against = againstFile ? readSnap(againstFile) : null
  const html = renderPage(base, against)
  const out = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.join(PAGE_DIR, `gate-health-${wallClock(new Date(base.meta.takenAt)).date}.html`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, html)
  const rows = (html.match(/<tr/gu) ?? []).length
  console.log(`✓ 状态页 ${path.relative(ROOT, out) || out}（${(html.length / 1024).toFixed(0)} KB）`, `  门禁行 <tr> ${rows} = ${base.gates.length} 项 · 外链 ${/(https?:\/\/)/u.test(html) ? '有（不合格）' : '0'}`)
  if (rows !== base.gates.length) { console.error(`✗ 页面门禁行 ${rows} ≠ 快照项 ${base.gates.length}`); process.exit(1) }
}

// ── 自检：反向验证（变异必须报恶化，还原必须报 0 变化） ────────────────────

function fixture() {
  return {
    meta: { head: 'f'.repeat(40), branch: 'ISS-647', treeKind: 'worktree', treeFingerprint: '0123456789abcdef', cwd: '/tmp/wt/ISS-647', toplevel: '/tmp/wt/ISS-647', dirtyFiles: 0, exitCodes: { gateFast: 0, guard: 2, hostRatchet: 1, inventory: 0 }, takenAt: '2026-01-01T00:00:00.000Z', durations: { gateFast: 7.5, guard: 178, hostRatchet: 40 } },
    gates: [
      { name: '绿门禁 A', passed: true, detailPath: null },
      { name: '红门禁 B', passed: false, detailPath: '/tmp/x.txt' },
      { name: '绿门禁 C', passed: true, detailPath: null },
    ],
    quickGates: [{ id: 'design', label: '设计门禁 R 号', current: 3, debt: 112 }],
    typeRatchet: {
      families: [
        { family: 'host 半', declaredPackages: 2, rows: [
          { pkg: 'forge-a', current: 5, ceiling: 5, state: '等于上限', marker: '✓' },
          { pkg: 'forge-b', current: 9, ceiling: 4, state: '超上限 4 → 9', marker: '✗' },
        ] },
        { family: '壳（非 workspace）', declaredPackages: 1, rows: [
          { pkg: 'electron-shell', current: null, ceiling: 0, state: '未装齐 ⇒ 本族不判', marker: '·' },
        ] },
      ],
      samples: [{ pkg: 'forge-b', text: 'lib/x.js(1,1): error TS2339: boom' }],
      dedup: { tsc: true, packages: 2, total: 14, distinct: 12, crossPkg: 1, expect: 14, mismatch: false, byFamily: { 'host 半': { total: 14, distinct: 12, crossPkg: 1 }, 'client 半': { total: 0, distinct: 0, crossPkg: 0 } } },
      summary: { families: 2, packages: 3, headerFamilies: 2, headerPackages: 3, redFromHeader: 1, redCounted: 1, unjudged: 1, current: 14, ceiling: 9, nullCurrent: 1, nullCeiling: 0 },
    },
    inventory: {
      dupImplementations: { id: 'D2', value: '315 / 86', number: 315, title: '同名多份实现' },
      copyPasteClusters: { id: 'D3', value: '111 / 630', number: 111, title: '复制粘贴簇' },
      godModules: { id: 'N4', value: '27 / 64', number: 27, title: 'god module' },
      zeroRefExports: { id: 'Z2', value: '3233 / 584 / 18%', number: 584, title: '零引用导出' },
      sourceLines: { id: 'T1', value: '28 / 777 / 192330', number: 192330, title: '源码行数' },
    },
    processTax: { commits30d: 100, gateChurn: 12, rework: 3, gateRatio: 12, reworkRatio: 3 },
    knownRulerDefects: KNOWN_RULER_DEFECTS,
    notes: [],
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x))

function selftest() {
  const results = []
  const t = (name, ok, note) => results.push({ name, ok, note })
  const base = fixture()
  const same = clone(base)
  // ① 自身比对必须 0 变化
  { const c = compareSnapshots(base, same)
    t('自身比对 0 变化（不多报）', c.length === 0, `${c.length} 条变化`) }
  // ② 门禁绿→红 必须报「恶化」，且不许混进「改善」
  { const mut = clone(base)
    mut.gates[0].passed = false
    const c = compareSnapshots(base, mut)
    const hit = c.find((x) => x.scope === '门禁' && x.item === '绿门禁 A')
    t('门禁由绿改红 ⇒ 报恶化', !!hit && hit.kind === '恶化', hit ? `${hit.from} → ${hit.to}：${hit.kind}` : '没报'); t('该变异不产生「改善」', c.every((x) => x.kind !== '改善'), `改善 ${c.filter((x) => x.kind === '改善').length} 条`) }
  // ③ 门禁红→绿 必须报「改善」（反向不搞反）
  { const mut = clone(base)
    mut.gates[1].passed = true
    const c = compareSnapshots(base, mut)
    const hit = c.find((x) => x.scope === '门禁' && x.item === '红门禁 B')
    t('门禁由红改绿 ⇒ 报改善', !!hit && hit.kind === '改善', hit ? `${hit.from} → ${hit.to}：${hit.kind}` : '没报') }
  // ④ 某个包现值 +1 必须报「恶化」
  { const mut = clone(base)
    mut.typeRatchet.families[0].rows[0].current += 1
    const c = compareSnapshots(base, mut)
    const hit = c.find((x) => x.scope === '类型棘轮' && x.item === 'host 半 / forge-a')
    t('包现值 +1 ⇒ 报恶化', !!hit && hit.kind === '恶化' && hit.delta === 1, hit ? `${hit.from} → ${hit.to}：${hit.kind}` : '没报') }
  // ⑤ 包现值 −1 必须报「改善」
  { const mut = clone(base)
    mut.typeRatchet.families[0].rows[0].current -= 1
    const c = compareSnapshots(base, mut)
    const hit = c.find((x) => x.scope === '类型棘轮' && x.item === 'host 半 / forge-a')
    t('包现值 −1 ⇒ 报改善', !!hit && hit.kind === '改善', hit ? `${hit.from} → ${hit.to}：${hit.kind}` : '没报') }
  // ⑥ 抬上限必须报「恶化」（把尺子松掉 = 变坏）
  { const mut = clone(base)
    mut.typeRatchet.families[0].rows[0].ceiling = 8
    const c = compareSnapshots(base, mut)
    const hit = c.find((x) => x.scope === '类型棘轮' && x.item === 'host 半 / forge-a 上限')
    t('抬上限 ⇒ 报恶化（不把松判据当改善）', !!hit && hit.kind === '恶化', hit ? `${hit.from} → ${hit.to}：${hit.kind}` : '没报') }
  // ⑦ 两处变异**还原**后必须 0 变化
  { const mut = clone(base)
    mut.gates[0].passed = false
    mut.typeRatchet.families[0].rows[0].current += 1
    const dirty = compareSnapshots(base, mut)
    const restored = clone(mut)
    restored.gates[0].passed = true
    restored.typeRatchet.families[0].rows[0].current -= 1
    const c = compareSnapshots(base, restored)
    t('变异后还原 ⇒ 0 变化', dirty.length > 0 && c.length === 0, `变异时 ${dirty.length} 条，还原后 ${c.length} 条`) }
  // ⑧ 可复算：takenAt/durations 变化必须被 sed 剥离，其余逐字节一致
  { const a = clone(base)
    a.meta.takenAt = '2026-01-01T00:00:00.000Z'
    a.meta.durations = { gateFast: 7.5, guard: 178, hostRatchet: 40 }
    const b = clone(base)
    b.meta.takenAt = '2026-01-02T03:04:05.678Z'
    b.meta.durations = { gateFast: 9.1, guard: 201.4, hostRatchet: 55.2 }
    const strip = (s) => s.split('\n').map((l) => l.replace(/"takenAt":.*$/u, '')).join('\n')
    const sa = strip(serialize(a))
    const sb = strip(serialize(b))
    t('剥离 takenAt 后两跑逐字节一致（含 durations 波动）', sa === sb, sa === sb ? `${sa.length} 字符一致` : '仍有差异 ⇒ 波动字段没排在同一行'); t('不剥离时两跑必然不同（证明剥离不是恒真）', serialize(a) !== serialize(b), '文件确实不同'); t('JSON 可解析且 meta.durations 就位', (() => { try { const o = JSON.parse(serialize(a)); return o.meta.durations.guard === 178 && o.gates.length === 3 } catch { return false } })(), '') }
  // ⑨ 页面：门禁行数 == gates.length、无外链、四块齐全
  { const html = renderPage(base, null)
    const rows = (html.match(/<tr/gu) ?? []).length
    t('页面 <tr> 行数 == 门禁项数', rows === base.gates.length, `${rows} vs ${base.gates.length}`); t('页面无 http/https 外链', !/https?:\/\//u.test(html), '正则 https?:// 命中 0'); t('页面 KPI 用去重后现值（distinct），并给出逐包累计/跨包重复', html.includes('>12<') && html.includes('逐包累计 14') && html.includes('跨包重复 1'), ''); t('页面日期按 Asia/Shanghai（不比 UTC 差一天）', html.includes(wallClock(new Date(base.meta.takenAt)).date), wallClock(new Date(base.meta.takenAt)).date); t('页面四块齐全（KPI / 门禁表 / 棘轮 / 流程税）', ['门禁红项', '门禁总表', '类型棘轮分面', '债务与流程税'].every((k) => html.includes(k)), ''); t('页面列出全部门禁名', base.gates.every((g) => html.includes(esc(g.name))), ''); t('红门禁附明细路径文本', html.includes('/tmp/x.txt'), ''); t('页面未标 ::against 时不出现 delta', !html.includes('dl worse') && !html.includes('dl better'), '') }
  // ⑩ 页面 delta 方向：红项变多 ⇒ worse（红），变少 ⇒ better（绿）
  { const worse = clone(base)
    worse.gates[2].passed = false
    const hW = renderPage(worse, base)
    const better = clone(base)
    better.gates[1].passed = true
    const hB = renderPage(better, base)
    t('红项变多 ⇒ delta 标 worse（红）', hW.includes('dl worse') && hW.includes('恶化'), ''); t('红项变少 ⇒ delta 标 better（绿）', hB.includes('dl better') && hB.includes('改善'), '') }
  // ⑪ 盘点器缺键：记 null 并点名，不许当 0
  { const picked = pickInventory({ metrics: [{ id: 'D2', title: 'x', value: '315 / 86' }] })
    const missing = picked.metrics.godModules
    t('inventory 缺键 ⇒ null 且 notes 点名', missing.number === null && missing.missing === true && picked.notes.some((n) => n.includes('N4')), `number=${missing.number}`); t('inventory 已有键取现值（D2 = 315）', picked.metrics.dupImplementations.number === 315, String(picked.metrics.dupImplementations.number))
    const t1 = pickInventory({ metrics: [{ id: 'T1', title: 'x', value: '28 / 777 / 192330' }] }).metrics.sourceLines
    t('T1 取第三段（行数而不是包数）', t1.number === 192330, String(t1.number))
    const z2 = pickInventory({ metrics: [{ id: 'Z2', title: 'x', value: '3233 / 584 / 18%' }] }).metrics.zeroRefExports
    t('Z2 取第二段（零引用导出，不是导出总数）', z2.number === 584, String(z2.number)) }
  // ⑫ 可比性：树指纹不同 ⇒ 判"不可比"，不许说成"0 变化一致"
  { const other = clone(base)
    other.meta.treeFingerprint = 'ffeeddccbbaa9988'
    const c = compareSnapshots(base, other)
    const cmp = comparability(base, other)
    t('指纹不同 ⇒ 判不可比', !cmp.comparable && cmp.why.some((w) => w.includes('树指纹')), cmp.why.join(' · ')); t('HEAD 不同 ⇒ 可比且带「跨提交」标注', (() => { const nb = clone(base); nb.meta.head = 'a'.repeat(40); const c2 = comparability(base, nb); return c2.comparable && c2.mode === 'cross-commit' && c2.label.includes('跨提交对比') })(), ''); t('HEAD 不同时页面挂中性说明、不挂"不可比"红横幅', (() => { const nb = clone(base); nb.meta.head = 'a'.repeat(40); const h = renderPage(nb, base); return h.includes('跨提交对比') && !h.includes('与对比基准<b>不可比</b>') })(), ''); t('HEAD 相同 + 指纹相同 ⇒ 可比（幂等档）', (() => { const c2 = comparability(base, clone(base)); return c2.comparable && c2.mode === 'idempotent' })(), ''); t('不可比时仍不谎报"一致"', renderConsole(base, other, c).includes('不可比'), ''); t('指纹相同 ⇒ 判可比', comparability(base, clone(base)).comparable, '')
    const wt = classifyTree('/repo/.git/worktrees/ISS-1', '/repo/.git', 'ISS-1')
    const mn = classifyTree('/repo/.git', '/repo/.git', 'main')
    t('树身份：git-dir ≠ common-dir ⇒ worktree', wt.treeKind === 'worktree' && wt.mainRoot === '/repo', JSON.stringify(wt)); t('树身份：两者相同 ⇒ main', mn.treeKind === 'main' && mn.mainRoot === null, JSON.stringify(mn)) }
  // ⑬ 去重自校验 mismatch **由数据算出**（第一版返回恒 undefined、fixture 写死 false ⇒ 死代码假绿）
  { t('mismatch 真算：total 2 ≠ expect 99 ⇒ true', dedupOn([{ pkg: 'a', keys: ['k1'] }, { pkg: 'b', keys: ['k2'] }], 99).mismatch === true, '')
    t('mismatch：一致时 false', dedupOn([{ pkg: 'a', keys: ['k1'] }], 1).mismatch === false, '')
    const bad = clone(base); bad.typeRatchet.dedup = { ...bad.typeRatchet.dedup, mismatch: true }
    t('去重自校验失败 ⇒ --compare 明面报出', compareSnapshots(base, bad).some((c) => String(c.item).includes('去重自校验')), ''); t('去重自校验失败 ⇒ 判不可比（distinct 不可信）', !comparability(base, bad).comparable, comparability(base, bad).why.join(' · ').slice(0, 40)) }
  // ⑫b 门禁身份 = 全名第一个全角左括号之前（括号尾巴是**文案**不是身份：修好一条门禁会改它的尾巴）
  {
    const a2 = clone(base); a2.gates = [{ name: '门禁甲（ISS-1 · 旧说法）', passed: true }, { name: '门禁乙（ISS-2）', passed: false }]
    const b2 = clone(base); b2.gates = [{ name: '门禁甲（需补 6 种，实现均覆盖（顺序检查跳过））', passed: true }, { name: '门禁乙（ISS-2）', passed: false }]
    const c = compareSnapshots(a2, b2)
    t('同 key 不同文案 ⇒ 不算消失/新增', !c.some((x) => x.to === '消失' || x.from === '不存在'), c.map((x) => `${x.kind}:${x.item}`).join('|').slice(0, 60)); t('同 key 不同文案且红绿不变 ⇒ 只出信息', c.every((x) => x.kind === KIND_INFO), c.map((x) => x.kind).join('')); t('同 key 不同文案 ⇒ 仍判可比', comparability(a2, b2).comparable, comparability(a2, b2).why.join(' · ').slice(0, 40)); t('key 取第一个全角左括号之前（无括号用全名）', gateKeyOf('Prism 语言集与语料一致（ISS-603 · 需要补）') === 'Prism 语言集与语料一致' && gateKeyOf('无括号门禁') === '无括号门禁', '')
    const d2 = clone(b2); d2.gates = d2.gates.filter((g) => gateKey(g) !== '门禁乙')
    t('真消失（key 不在 B）仍判恶化、但合计不降级（展示仍用全名）', compareSnapshots(b2, d2).some((x) => gateKeyOf(String(x.item)) === '门禁乙' && x.kind === '恶化' && String(x.item).includes('ISS-2')) && comparability(b2, d2).churn.text.includes('消失 1'), '') }
  // ⑫c 集合变化提示 + 改名线索 + 耗时 1 位小数（批 2 的三个表述级假信号）
  {
    const na = clone(base); na.gates = [{ name: '旧门禁甲（旧文案）', passed: true }, { name: '旧门禁乙（旧文案）', passed: false }]
    const nb = clone(base); nb.gates = [{ name: '新门禁甲（改名）', passed: true }, { name: '新门禁乙（改名）', passed: false }]
    const cc = compareSnapshots(na, nb), cp = comparability(na, nb)
    t('集合变化出提示行（消失 N / 新增 N，合计仍可读）', cc.some((x) => String(x.item) === '集合变化' && x.note.includes('合计仍可读')), cp.churn.text); t('等量消失/新增 ⇒ 疑似改名线索', cc.some((x) => String(x.item) === '疑似改名' && x.from === '旧门禁甲' && x.to === '新门禁甲'), cp.churn.renames.join('|')); t('有增删≠不可比（合计仍可读）', cp.comparable, cp.why.join(' · ')); t('红门禁消失但有新增补偿 ⇒ 红项合计仍读改善；纯删不补 ⇒ 恶化', (() => { const ca = clone(base); ca.gates = [{ name: '红甲（旧）', passed: false }, { name: '红乙（旧）', passed: false }]; const cb = clone(base); cb.gates = [{ name: '新红丙（改名后）', passed: true }]; const ok1 = compareSnapshots(ca, cb).some((x) => String(x.item).startsWith('红项') && x.kind === KIND_GOOD); const ca2 = clone(base); ca2.gates = [{ name: '红甲（旧）', passed: false }]; const cb2 = clone(base); cb2.gates = []; return ok1 && compareSnapshots(ca2, cb2).some((x) => String(x.item).startsWith('红项') && x.kind === KIND_BAD) })() && true, '')
    const tail = deltaTag(165.06, 160.1600000001, null) // 造出 4.8999999999999977 那种尾巴
    t('耗时 delta 只留 1 位小数（无浮点尾巴）', /\+4\.9 /.test(tail) && !/\d\.\d{3,}/.test(tail), tail) }
  // ⑬b 反向遍历：包 / 门禁整项消失不许静默（审查员复现的两条假绿）
  { const gp = clone(base); gp.typeRatchet.families[0].rows = gp.typeRatchet.families[0].rows.filter((r) => r.pkg !== 'forge-a')
    const c1 = compareSnapshots(base, gp)
    t('现值 > 0 的包整项消失 ⇒ 恶化', c1.some((c) => c.scope === '类型棘轮' && String(c.item).includes('forge-a') && c.kind === '恶化'), ''); t('存在消失项时不许印「逐项一致」', !renderConsole(base, gp, c1).includes('逐项一致'), renderConsole(base, gp, c1).split('\n').pop())
    const z0 = clone(base); z0.typeRatchet.families[0].rows.push({ pkg: 'forge-zero', current: 0, ceiling: 0, state: '零错误（阻塞门禁）', marker: '✓' })
    const z1 = clone(z0); z1.typeRatchet.families[0].rows = z1.typeRatchet.families[0].rows.filter((r) => r.pkg !== 'forge-zero')
    const dm = clone(base); dm.quickGates = []; delete dm.inventory.godModules
    const c4 = compareSnapshots(base, dm)
    t('快闸格整项消失 ⇒ 恶化', c4.some((x) => x.scope === '快闸' && x.kind === '恶化'), ''); t('盘点度量整项消失 ⇒ 恶化', c4.some((x) => x.scope === '盘点' && x.kind === '恶化'), ''); t('现值 0 的包消失 ⇒ 信息', compareSnapshots(z0, z1).some((c) => String(c.item).includes('forge-zero') && c.kind === '信息'), '')
    const dg = clone(base); dg.gates = dg.gates.filter((g) => g.passed)
    const c3 = compareSnapshots(base, dg)
    t('删红门禁 ⇒ 红项合计报恶化（不是改善）', c3.some((x) => String(x.item).startsWith('红项') && x.kind === '恶化'), c3.filter((x) => String(x.item).startsWith('红项')).map((x) => x.kind).join('')); t('删红门禁 ⇒ 集合变化被标注（不降级整次对比）', comparability(base, dg).churn.text.includes('消失 1') && comparability(base, dg).comparable, ''); t('删红门禁 ⇒ 该门禁本身报恶化', c3.some((x) => x.item === '红门禁 B' && x.kind === '恶化'), '') }
  // ⑬c 指纹吃内容（只拼 status 行时"同一文件换了内容"算不出差别）
  { t('指纹：内容哈希不同 ⇒ 指纹不同', treeFingerprintOf('h', 'b', 't', 'x1', 'd1') !== treeFingerprintOf('h', 'b', 't', 'x1', 'd2'), '')
    t('指纹：同输入 ⇒ 同指纹', treeFingerprintOf('h', 'b', 't', 'x', 'd') === treeFingerprintOf('h', 'b', 't', 'x', 'd'), '') }
  // ⑭ 去重：同一条债被两个包各记一次只算一条（ISS-620 式两头红）
  { const A = tscErrorKeys('lib/x.js(1,2): error TS2339: boom\nlib/y.js(9,9): error TS2304: onlyA', path.join(ROOT, 'forge-a'))
    const B = tscErrorKeys('../forge-a/lib/x.js(1,2): error TS2339: boom\nlib/z.js(3,3): error TS2322: onlyB', path.join(ROOT, 'forge-b'))
    const d = dedupOn([{ pkg: 'forge-a', keys: A }, { pkg: 'forge-b', keys: B }])
    t('去重：跨包重复归一成同一键', A[0] === 'forge-a/lib/x.js(1,2): error TS2339' && B[0] === A[0], `${A[0]} / ${B[0]}`); t('去重：total 3 / distinct 3？按包记账 4 → 去重 3', d.total === 4 && d.distinct === 3 && d.crossPkg === 1, JSON.stringify(d)); t('去重：只被一个包记的不算 crossPkg', d.crossPkg === 1, `crossPkg=${d.crossPkg}`) }
  // ⑭ 流程税口径必须逐字可复算（三条正则原文进 notes）
  { const n = taxNote()
    t('税比口径：三条正则原文都在 notes 里', n.includes('git log --since="30 days ago" --oneline') && n.includes(TAX_GATE.source) && n.includes(TAX_REWORK.source), n.slice(0, 60)) }
  // ⑮ 解析器：喂真实形态的一行，钉住三处容易写错的边界
  { const r = parseRatchet(['类型棘轮 · 1 族 · 3 个包 · 判红 1', '  ── host 半（3 个包）', '  ✓ forge-a              错误    1 / 上限 1  等于上限', '  ✗ forge-b              错误    — / 上限 0  名册里消失了', '      ✗ forge-b: lib/x.js(1,1): error TS2339: boom'].join('\n'))
    t('棘轮解析：包行以逐行为准、样本行不算包', r.summary.packages === 2 && r.summary.redCounted === 1 && r.summary.headerPackages === 3, `${r.summary.packages} 包 / 红 ${r.summary.redCounted} / 头行 ${r.summary.headerPackages}`); t('棘轮解析：「错误 —」记 null 而不是 0', r.families[0].rows[1].current === null, String(r.families[0].rows[1].current)); t('棘轮解析：状态原样保留中文', r.families[0].rows[0].state === '等于上限', r.families[0].rows[0].state) }
  // ⑯ **ISS-829 的牙**：命令没跑成 ⇒ 判不了（不是 0 个红）；有红项的业务退出码 1 仍照常解析
  { const miss = judge(NODE, [path.join(ROOT, 'scripts', 'gate-fast.mjs'), '--check'])
    t('不存在的 .mjs ⇒ 判不了（不是 0 个红）', miss.unjudged !== null && miss.status === null, String(miss.unjudged))
    t('不存在的 .sh ⇒ 判不了（127 撞码也不许当 0 红）', judge('bash', [path.join(ROOT, 'scripts', 'guard-baselines.sh')]).unjudged !== null, String(judge('bash', [path.join(ROOT, 'scripts', 'guard-baselines.sh')]).status))
    // **反例形态**：真跑成但报红（退出码 1）必须留在"有红"，不许被当"判不了" —— 否则红会被悄悄升级成"没数据"
    const fake = path.join(ROOT, 'scripts', '.selftest-exit1.mjs')
    fs.writeFileSync(fake, 'process.exit(1)\n')
    try { const red = judge(NODE, [fake]); t('真跑红（退出码 1、无未找到特征）⇒ 不是判不了', red.unjudged === null && red.status === 1, `status=${red.status} unjudged=${red.unjudged}`) } finally { fs.unlinkSync(fake) } }
  const fail = results.filter((r) => !r.ok)
  console.log(`gate-health --selftest（${results.length} 条）`)
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.note ? `（${r.note}）` : ''}`)
  console.log(fail.length ? `\n✗ 反向验证失败 ${fail.length} 项` : `\n✓ 有牙：变异必报恶化、还原必报 0 变化、页面无外链且门禁行数对得上、缺键记 null`)
  process.exit(fail.length ? 1 : 0)
}

// ─────────────────────────────────────────────────────────────────────────────

function usage() {
  console.error(`用法：--snapshot [--out <dir>] | --compare <a.json> <b.json> [--md] | --page <base.json> [--against <prev.json>] [--out <file>] | --selftest`) // eslint-disable-line
}

const ARGV = process.argv.slice(2)
if (ARGV.includes('--selftest')) selftest()
else if (ARGV.includes('--snapshot')) cmdSnapshot(ARGV)
else if (ARGV.includes('--compare')) cmdCompare(ARGV)
else if (ARGV.includes('--page')) cmdPage(ARGV)
else { usage(); process.exit(2) }
