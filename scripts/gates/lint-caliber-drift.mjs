#!/usr/bin/env node
/**
 * 度量口径漂移判据（ISS-795）—— 「口径变了，棘轮基线必须同批动」。
 *
 * ## 要治的病（今天真实踩到两次）
 * **正确**：ISS-770 改 Z2 射程（`.d.ts` 不算实现面 + `scripts/` 子目录算消费者），
 *   同批把 `K10b` 基线 580→362，并在 `ratchetNotes` 写明理由。
 * **错误**：`554f1f65`（ISS-777）把 `code-inventory.json` 复录了（C9 5→8、C10 11→14、
 *   D2 253→275、E8 357→386），**没同批动 `code-gates.json` 的 ceiling**。
 *   ⇒ 上限按旧口径定、实测是新口径，两个读数没有可比性；`lint-code` 的红里混着
 *   「真新增债」与「口径漂移」，排查时极易误判（ISS-795 就是这么被坑的）。
 *
 * 现有判据都抓不到：`audit-doc-sync` 只查「基线 ↔ 侧产物」同源，不查 ceiling；
 * `lint-code` 只比「实时实测 vs ceiling」，它不知道 ceiling 是按哪个口径定的。
 *
 * ## 判法（指纹，不看 git 历史）
 * `scripts/baseline/caliber.json` 记录 `code-inventory.mjs` 里**决定度量口径的那组常量**
 * 的规范化原文 + 指纹（sha256 over 键排序后的 JSON）：
 *   SHINGLE · JAC · SKIP_DIR · FILE_RE · VENDOR_NAME · isTestFile · D2_EXEMPT · D2_KERNEL_OWNED
 * 一致 ⇒ 绿；不一致 ⇒ 红并**逐条点名哪几个常量变了**（旧 → 新，截断 80 字符）；
 * `caliber.json` 读不到 / 坏 JSON ⇒ **判不了 exit 2**（不冒充绿）。
 *
 * ## 三条设计陷阱（本文件刻意避开的）
 * 1. **不用 git 历史判「同批」**：`git log -1 -- <file>` 在 shallow clone / CI 里不可靠 ⇒ 用指纹。
 * 2. **不扫整份文件算哈希**：改一行注释就红 = 噪音 = 长红 = 没人看 ⇒ 只抽这 8 个声明。
 * 3. **抽取失败判红不判绿**：常量改名/删掉 ⇒ 报「口径载体缺失」，否则判据恒绿。
 *
 * 用法：
 *   node scripts/gates/lint-caliber-drift.mjs --check      # 默认
 *   node scripts/gates/lint-caliber-drift.mjs --write      # 承认新口径（会打印逐条变化）
 *   node scripts/gates/lint-caliber-drift.mjs --selftest   # 四格反向验证
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const CARRIER = path.join(REPO, 'scripts/code-inventory.mjs')
const BASELINE = path.join(REPO, 'scripts/baseline/caliber.json')

/** 决定度量口径的常量：**只认这 8 个**（增删这张表本身也是口径变更，必须同批改基线）。 */
export const CONST_NAMES = ['SHINGLE', 'JAC', 'SKIP_DIR', 'FILE_RE', 'VENDOR_NAME', 'isTestFile', 'D2_EXEMPT', 'D2_KERNEL_OWNED']

const README = '口径指纹。code-inventory.mjs 里这 8 个常量决定度量口径；任何一个变了，本文件的 fingerprint 就会变，此时必须同批更新 scripts/baseline/code-gates.json 的 ceiling，并在其 ratchetNotes 写明为什么（否则「上限按旧口径、实测新口径」，读数没有可比性 —— ISS-777 的原形）。改完跑 node scripts/gates/lint-caliber-drift.mjs --write 承认新口径。'

const norm = (s) => s.replace(/\s+/g, ' ').trim()
const clip = (s) => (s.length > 80 ? `${s.slice(0, 77)}...` : s)

/** 按顶层逗号切分（忽略括号/引号里的逗号）。这些声明里没有跨行模板串，够用。 */
function splitTopLevel(text) {
  const out = []
  let cur = ''
  let depth = 0
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      cur += c
      if (c === '\\') {
        cur += text[i + 1] ?? ''
        i++
        continue
      }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      cur += c
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    if (c === ')' || c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** 一条声明语句的文本：从声明行起，直到下一个顶层声明/空行/注释。 */
function captureStatement(lines, start) {
  let end = start
  while (end + 1 < lines.length) {
    const next = lines[end + 1]
    if (!next.trim()) break
    if (/^\s*(const|let|var|function|class|export|import|\/\/)/.test(next)) break
    end++
  }
  return lines.slice(start, end + 1).join('\n')
}

/**
 * 从源码里按名抽取 8 个常量的**规范化原文**。
 * 返回 `{ constants, missing }`：`missing` 非空 ⇒ 口径载体缺失（判红，不许跳过）。
 */
export function extractCaliber(source) {
  const lines = String(source).split('\n')
  const constants = {}
  const missing = []
  for (const name of CONST_NAMES) {
    const declRe = new RegExp(`^\\s*(const|let|var)\\s+.*(^|[,\\s])${name}\\s*=`)
    let start = -1
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*(const|let|var)\s/.test(lines[i])) continue
      if (new RegExp(`(^|[,\\s])${name}\\s*=`).test(lines[i])) {
        start = i
        break
      }
    }
    void declRe
    if (start < 0) {
      missing.push(name)
      continue
    }
    const stmt = captureStatement(lines, start)
    const piece = splitTopLevel(norm(stmt)).find((p) => new RegExp(`(^|[\\s(])(const|let|var)?\\s*${name}\\s*=`).test(p))
    if (!piece) {
      missing.push(name)
      continue
    }
    const m = piece.match(new RegExp(`${name}\\s*=([\\s\\S]*)$`))
    constants[name] = m ? norm(m[1]) : ''
  }
  return { constants, missing }
}

/** 指纹 = 键排序后的 JSON 的 sha256（与书写顺序、缩进无关）。 */
export function fingerprint(constants) {
  const ordered = {}
  for (const k of Object.keys(constants).sort()) ordered[k] = constants[k]
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex')}`
}

export function buildBaseline(source) {
  const { constants, missing } = extractCaliber(source)
  if (missing.length) throw new Error(`口径载体缺失：抽不到 ${missing.join('、')}`)
  return { _readme: README, fingerprint: fingerprint(constants), constants }
}

/** 纯函数：给定载体源码与基线，给结论。 */
export function judge(source, baseline) {
  if (!baseline || typeof baseline !== 'object' || !baseline.constants || typeof baseline.constants !== 'object') {
    return { status: 'unjudged', findings: [], detail: 'scripts/baseline/caliber.json 缺失或结构不对 ⇒ 判不了（不是绿）' }
  }
  const { constants, missing } = extractCaliber(source)
  if (missing.length) {
    return {
      status: 'failed',
      findings: [`口径载体缺失：code-inventory.mjs 里抽不到 ${missing.join('、')} —— 常量改名/删除？判据不能因此变绿（ISS-795 陷阱 3）`],
      detail: `抽出 ${Object.keys(constants).length}/${CONST_NAMES.length} 个口径常量`,
    }
  }
  const old = baseline.constants
  const findings = []
  for (const name of CONST_NAMES) {
    const a = norm(String(old[name] ?? ''))
    const b = norm(String(constants[name] ?? ''))
    if (a !== b) findings.push(`${name}: ${clip(a) || '（缺失）'} → ${clip(b) || '（缺失）'}`)
  }
  const fp = fingerprint(constants)
  if (findings.length) {
    findings.push(
      `指纹 ${baseline.fingerprint || '（无）'} → ${fp}。出路二选一：① 回滚口径；② node scripts/gates/lint-caliber-drift.mjs --write 承认新口径 —— 但承认时必须**同批**更新 scripts/baseline/code-gates.json 的 ceiling，并在 ratchetNotes 写明为什么（否则上限按旧口径、实测新口径，读数不可比）`,
    )
    return { status: 'failed', findings, detail: `${findings.length - 1} 个口径常量变了` }
  }
  if (baseline.fingerprint && baseline.fingerprint !== fp) {
    return { status: 'failed', findings: [`常量原文一致但指纹不符（基线被手改过？）：${baseline.fingerprint} → ${fp}`], detail: '指纹不一致' }
  }
  return { status: 'passed', findings: [], detail: `8 个口径常量与基线一致（${fp.slice(0, 19)}…）` }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function readBaseline() {
  if (!fs.existsSync(BASELINE)) return null
  try {
    return JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  } catch {
    return { __bad: true }
  }
}

function report(r) {
  if (r.status === 'passed') {
    console.log(`✓ lint-caliber-drift: passed`)
    if (r.detail) console.log(`   ${r.detail}`)
    return 0
  }
  if (r.status === 'unjudged') {
    console.log(`! lint-caliber-drift: unjudged（no-baseline）—— ${r.detail}`)
    return 2
  }
  console.log(`✗ lint-caliber-drift: failed（${r.findings.length} 条）`)
  for (const f of r.findings) console.log(`   · ${f}`)
  return 1
}

function selftest() {
  const src = fs.readFileSync(CARRIER, 'utf8')
  const base = buildBaseline(src)
  const cases = []
  const t = (name, pass, extra = '') => cases.push({ name, pass, extra })

  // ⓪ 真实载体能抽全 8 个（抽取器本身的地基）
  const real = extractCaliber(src)
  t('抽取：真实 code-inventory.mjs 抽全 8 个常量', real.missing.length === 0, real.missing.join('、'))
  t('判据：当前口径 vs 当前基线 ⇒ 绿', judge(src, base).status === 'passed')

  // ① 只改口径 ⇒ 必红且点名
  const mutated = src.replace(/const SHINGLE = Number\(flagVal\('--shingle', 12\)\) \|\| 12/, "const SHINGLE = Number(flagVal('--shingle', 13)) || 13")
  const r1 = judge(mutated, base)
  t('① 只改 SHINGLE 12→13 ⇒ 红', r1.status === 'failed')
  t('① 红里点名「SHINGLE: … → …」', r1.findings.some((f) => f.startsWith('SHINGLE:')))
  t('① 红里给出出路（--write + 同批改 ceiling）', r1.findings.some((f) => f.includes('--write') && f.includes('code-gates.json')))

  // ② 口径 + --write 承认 ⇒ 必绿
  const r2 = judge(mutated, buildBaseline(mutated))
  t('② 改口径后 --write 承认 ⇒ 绿', r2.status === 'passed')

  // ③ 反向控：常量改名 ⇒ 必红（报载体缺失，不是绿）
  const renamed = src.replace(/\bSHINGLE\b/g, 'SHINGLE_N')
  const r3 = judge(renamed, base)
  t('③ 常量改名 SHINGLE→SHINGLE_N ⇒ 红（不是绿）', r3.status === 'failed')
  t('③ 红里写「口径载体缺失」并点名 SHINGLE', r3.findings.some((f) => f.includes('口径载体缺失') && f.includes('SHINGLE')))

  // ④ 基线删掉 ⇒ 判不了（exit 2），不是绿
  t('④ 基线缺失 ⇒ unjudged（不是绿）', judge(src, null).status === 'unjudged')
  t('④ 坏 JSON 也判不了', judge(src, { __bad: true }).status === 'unjudged')

  const failed = cases.filter((c) => !c.pass)
  for (const c of cases) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.pass || !c.extra ? '' : `（${c.extra}）`}`)
  console.log(failed.length ? `✗ ${cases.length - failed.length} 通过 / ${failed.length} 失败` : `✓ ${cases.length} 通过 / 0 失败`)
  return failed.length ? 1 : 0
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest()
  if (!fs.existsSync(CARRIER)) {
    console.log(`! lint-caliber-drift: unjudged（no-corpus）—— 缺口径载体 ${path.relative(REPO, CARRIER)}`)
    return 2
  }
  const src = fs.readFileSync(CARRIER, 'utf8')
  if (argv.includes('--write')) {
    const next = buildBaseline(src)
    const prev = readBaseline()
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
    fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`✓ 已写口径基线：${path.relative(REPO, BASELINE)}（${next.fingerprint.slice(0, 19)}…）`)
    if (prev && prev.constants) {
      for (const name of CONST_NAMES) {
        const a = norm(String(prev.constants[name] ?? ''))
        const b = norm(String(next.constants[name] ?? ''))
        if (a !== b) console.log(`   · ${name}: ${clip(a) || '（缺失）'} → ${clip(b) || '（缺失）'}`)
      }
    }
    console.log('   ⚠️ 承认新口径后，必须同批更新 scripts/baseline/code-gates.json 的 ceiling，并在 ratchetNotes 写明理由')
    return 0
  }
  return report(judge(src, readBaseline()))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
