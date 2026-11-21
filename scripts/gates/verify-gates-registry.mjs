#!/usr/bin/env node
// scripts/gates/verify-gates-registry.mjs
//
// 判据：**「新判据必须进 `scripts/gates/`」这条规则，有没有牙。**
// 权威依据：`scripts/gates/README.md` 的「丙规则」（原写 architecture-overview §3.6.4，该节从未存在，ISS-757 订正）。
//
// ── 为什么需要这条 ────────────────────────────────────────────────────
// 四层门禁架构（§3.6.1）里 L2「判据实现」至今没有落点：123 个 `.mjs` 全平铺在 `scripts/` 根，
// 判据、运维脚本、共用库、调度器混在一层。没有落点的后果不是"不好看"，是**规范写了也没有牙**：
// 下一个人照旧往 `scripts/` 根扔判据，因为没有任何机器判据会因此变红。
//
// 这条判据给它两个牙口：
//   (A) **孤儿判据**：`scripts/gates/` 下每个 `.mjs` 必须出现在 `run-gates.mjs` 登记表里。
//       放在这一层却不登记 = 没人调度它 = 写了等于没写。
//   (B) **层放错**：`scripts/` 根**新增**的、带判据形态的 `.mjs`，必须落 `scripts/gates/`。
//       存量（63 个）按丙规则不动，逐条登记在 `legacy-allowlist.json` 里。
//
// ── 判据 A 的口径：登记表怎么算"出现" ─────────────────────────────────
// ⛔ **不许用「文件名在源码里出现过就算」**——注释、字符串、日志文案里提一句就会骗过它。
//    实测本仓有 3 个文件只在注释里出现 `--selftest`，弱判据会当场判错。
//
// 真口径：**问调度器要它的登记表**，`node scripts/run-gates.mjs --list --json`，
// 把每格的 `command` 拆成 argv，逐个 token 解析成绝对路径，与判据文件的 realpath 比对。
// 依据：`run-gates.mjs` §12 `listGates()` 输出 `{id,label,tier,timeoutMs,badge,command}`，
// `command` = `[command, ...args].join(" ")`；登记表**不支持 glob**，登记就是字面路径
// （`args: ["scripts/gates/foo.mjs", "--check"]`）⇒ 路径比对是充分判据。
//
// 调度器不在本树时（`main` 上确实没有，它在 ISS-714 分支）⇒ 判 `INTERNAL(2)` 并明说判不了，
// **不静默放过**，也不因为"没登记表所以没孤儿"而假绿。
//
// ── 判据 B 的口径：什么叫"带判据形态" ─────────────────────────────────
// 三条特征，**先剥注释再判**（注释里的 `--selftest` 不算，那是文档不是行为）：
//   1. 出现字符串字面量 `--selftest`（判据的反向自检入口）
//   2. 出现 `rule: '<规则号>'`（判据声明自己执行哪条规则）
//   3. 出现 `{ rule, metric, mode }` 形状的对象（判据的三元结论形态）
// 只查 `scripts/` 根的直接文件，不进子目录（子目录由判据 A 管）。
//
// ── 豁免清单的棘轮 ───────────────────────────────────────────────────
// `scripts/gates/legacy-allowlist.json`：
//   · 每条必须有**非空 reason**（空理由 ⇒ 红）——理由是这个机制唯一的可审计面
//   · 条目指向的文件必须**真实存在**（文件没了 ⇒ 红）——否则"豁免"会变成永久免死金牌
//   · 条目指向的文件必须**仍然带判据形态**（形态没了 ⇒ 红）——债务已消灭，条目该删
//   · `entries.length <= maxEntries`（超上限 ⇒ 红）——**只减不增**；
//     要加一条必须同时把 `maxEntries` 调高，那在 `git diff` 里是一行看得见的账
//
// 用法：
//   node scripts/gates/verify-gates-registry.mjs            # 检查（同 --check）
//   node scripts/gates/verify-gates-registry.mjs --json     # 机器可读
//   node scripts/gates/verify-gates-registry.mjs --selftest # 反向验证（8 例，真造文件真删）
//   node scripts/gates/verify-gates-registry.mjs --repo <dir>  # 换根（自检/基线树对照用）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, '..', '..')
const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

const GATES_SUBDIR = 'scripts/gates'
const ROOT_SUBDIR = 'scripts'
const ALLOWLIST_NAME = 'legacy-allowlist.json'
const SCHEDULER = 'scripts/run-gates.mjs'

/** 判据形态：字符串字面量 `--selftest` */
const RE_SELFTEST = /['"`]--selftest['"`]/
/** 判据形态：`rule: '<规则号>'` */
const RE_RULE = /\brule\s*:\s*['"`]/
/** 判据形态：`{ rule, ..., metric, ..., mode }` —— 三元结论对象 */
const RE_SHAPE = /\{[^{}]{0,200}\brule\b[^{}]{0,200}\bmetric\b[^{}]{0,300}\bmode\b/

/**
 * 把 JS 源码里的注释抹成空格，**保留字符串原样**、保留换行以便报行号。
 * 为什么不用正则 `/\*[\s\S]*?\*\//`：那会把字符串里的 `/*` 也当注释起点，
 * 一个正则字面量就能让整份文件误判。逐字符扫是这里唯一稳的写法。
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  let st = null // null | 'line' | 'block' | "'" | '"' | '`'
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (st === 'line') {
      if (c === '\n') { st = null; out += c } else out += ' '
      i++
      continue
    }
    if (st === 'block') {
      if (c === '*' && d === '/') { st = null; out += '  '; i += 2 }
      else { out += c === '\n' ? c : ' '; i++ }
      continue
    }
    if (st === "'" || st === '"' || st === '`') {
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
      if (c === st) st = null
      out += c
      i++
      continue
    }
    if (c === '/' && d === '/') { st = 'line'; out += '  '; i += 2; continue }
    if (c === '/' && d === '*') { st = 'block'; out += '  '; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') st = c
    out += c
    i++
  }
  return out
}

/** 判据形态检测（剥注释后）。返回命中的特征名数组，空数组 = 不像判据。 */
export function detectFeatures(rawSrc) {
  const s = stripComments(rawSrc)
  const feat = []
  if (RE_SELFTEST.test(s)) feat.push('--selftest')
  if (RE_RULE.test(s)) feat.push('rule:')
  if (RE_SHAPE.test(s)) feat.push('{rule,metric,mode}')
  return feat
}

const relPath = (root, abs) => path.relative(root, abs).split(path.sep).join('/')
const isTestFile = (name) => /\.test\.mjs$/.test(name)

/** `scripts/gates/` 下的判据脚本（排除单测：`*.test.mjs` 由测试运行器管，不是调度格子）。 */
function listGateScripts(root) {
  const dir = path.join(root, GATES_SUBDIR)
  if (!fs.existsSync(dir)) return null
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !isTestFile(e.name))
    .map((e) => path.join(dir, e.name))
    .sort()
}

/** `scripts/` 根的直接 `.mjs`（不含子目录，子目录归判据 A）。
 *
 * ⚠️ 必须与判据 A 同射程：`*.test.mjs` 是单测，归测试运行器管，**不是判据**。
 * 判据 A（`listGateScripts`）早就排除了它，本函数原先漏排 ⇒ 判据 B 把
 * `scripts/secret-scan.test.mjs` 报成「放错层的判据」（假阳性，实测于 2026-11-07 合并后）。
 * 两个方向射程不一致 = 同一条规则在两处答案不同，比单点漏判更难查。 */
function listRootScripts(root) {
  const dir = path.join(root, ROOT_SUBDIR)
  if (!fs.existsSync(dir)) return null
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !isTestFile(e.name))
    .map((e) => path.join(dir, e.name))
    .sort()
}

/**
 * 问调度器要登记表。**不解析源码**——源码里出现文件名不算登记（见文件头「真口径」）。
 * @returns {{ok:true, gates:any[]} | {ok:false, code:number, reason:string}}
 */
function loadRegistry(root) {
  const sched = path.join(root, SCHEDULER)
  if (!fs.existsSync(sched)) {
    return {
      ok: false,
      code: EXIT.INTERNAL,
      reason:
        `登记表判不了：${SCHEDULER} 不在本树（${root}）。\n` +
        `  · 这是「无法判定」，不是「没有孤儿」——不许当绿。\n` +
        `  · 该调度器属 ISS-714（未合入 main）；合入后本判据自动开始判（A）。`,
    }
  }
  const r = spawnSync(process.execPath, [sched, '--list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) {
    return {
      ok: false,
      code: EXIT.INTERNAL,
      reason:
        `登记表判不了：\`node ${SCHEDULER} --list --json\` 退出码 ${r.status ?? '(null)'}。\n` +
        `  · stderr 首行：${(r.stderr || '').split('\n').find((l) => l.trim()) ?? '(空)'}\n` +
        `  · 调度器自己坏了 ⇒ 本判据判不了，不当绿。`,
    }
  }
  let j
  try {
    j = JSON.parse(r.stdout)
  } catch {
    return {
      ok: false,
      code: EXIT.INTERNAL,
      reason: `登记表判不了：\`--list --json\` 输出不是合法 JSON（首 120 字符：${(r.stdout || '').slice(0, 120)}）。`,
    }
  }
  if (!j || !Array.isArray(j.gates)) {
    return { ok: false, code: EXIT.INTERNAL, reason: '登记表判不了：`--list --json` 没有 `gates` 数组。' }
  }
  return { ok: true, gates: j.gates }
}

/** argv 拆分：按空白切，但引号里的空白不切（登记表里 label 可能带空格）。 */
function splitArgv(cmd) {
  return (String(cmd).match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''))
}

/**
 * 登记表里被当成**路径参数**出现过的绝对路径集合。
 * 只认真的解析得到文件的 token —— `<internal>`（内置格）自然没有。
 */
function registryPathSet(root, gates) {
  const set = new Set()
  for (const g of gates) {
    if (typeof g?.command !== 'string') continue
    for (const tok of splitArgv(g.command)) {
      if (!tok.includes('/') && !tok.includes('\\')) continue
      const abs = path.resolve(root, tok)
      set.add(abs)
      try { set.add(fs.realpathSync(abs)) } catch { /* 不存在就算了，另一侧会比对失败 */ }
    }
  }
  return set
}

/** 判据 A：`scripts/gates/*.mjs` 必须在登记表里。 */
function judgeOrphans(root, gateScripts, gates) {
  const inRegistry = registryPathSet(root, gates)
  const schedSrc = fs.readFileSync(path.join(root, SCHEDULER), 'utf8')
  const findings = []
  for (const abs of gateScripts) {
    let real = abs
    try { real = fs.realpathSync(abs) } catch { /* 保底用原路径 */ }
    if (inRegistry.has(abs) || inRegistry.has(real)) continue
    // 弱判据会在这里放过：文件名在调度器源码里出现过就"算登记"。
    // 我们**明确报告**这件事，但结论仍是红 —— 出现 ≠ 登记。
    const name = path.basename(abs)
    const mentions = schedSrc.split(name).length - 1
    findings.push({
      rule: 'A',
      file: relPath(root, abs),
      message:
        `${relPath(root, abs)} 在 ${GATES_SUBDIR}/ 下，但不在 ${SCHEDULER} 登记表里。` +
        (mentions > 0
          ? `\n      ⚠ 文件名在调度器源码里出现 ${mentions} 次 —— 那是注释/字符串，**不顶事**：` +
            `没登记就没有格子调度它，写了等于没写。`
          : ''),
      hint: `在 ${SCHEDULER} 的 STANDALONE_GATES 加一格，args 含 "scripts/gates/${name}"。`,
    })
  }
  return findings
}

/** 读豁免清单。缺失 ⇒ 违约（这一层必须带清单）；损坏 ⇒ 判不了。 */
function readAllowlist(root) {
  const p = path.join(root, GATES_SUBDIR, ALLOWLIST_NAME)
  if (!fs.existsSync(p)) {
    return { ok: false, code: EXIT.VIOLATION, reason: `${GATES_SUBDIR}/${ALLOWLIST_NAME} 缺失：存量豁免必须逐条留理由，清单不能不在。` }
  }
  let j
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    return { ok: false, code: EXIT.INTERNAL, reason: `${GATES_SUBDIR}/${ALLOWLIST_NAME} 不是合法 JSON（${e.message}）⇒ 判不了。` }
  }
  if (!j || !Array.isArray(j.entries)) {
    return { ok: false, code: EXIT.INTERNAL, reason: `${GATES_SUBDIR}/${ALLOWLIST_NAME} 没有 entries 数组 ⇒ 判不了。` }
  }
  return { ok: true, allow: j }
}

/** 判据 B：`scripts/` 根新增的判据形态脚本必须落 `scripts/gates/`。 */
function judgeMisplacement(root, rootScripts, allow) {
  const findings = []
  const byFile = new Map()
  for (const e of allow.entries) {
    const f = typeof e?.file === 'string' ? e.file.replace(/^\.\//, '') : ''
    if (!f) {
      findings.push({ rule: 'B', file: '(清单条目缺 file 字段)', message: '豁免清单有条目没有 file 字段。', hint: '补 file，或删掉这条。' })
      continue
    }
    if (byFile.has(f)) {
      findings.push({ rule: 'B', file: f, message: `豁免清单里 ${f} 重复登记 ${byFile.get(f) + 1} 次。`, hint: '去重：重复条目会让"只减不增"的账算不清。' })
    }
    byFile.set(f, (byFile.get(f) ?? 0) + 1)
    // 理由必须非空（反例 C）
    const reason = typeof e.reason === 'string' ? e.reason.trim() : ''
    if (!reason) {
      findings.push({ rule: 'B', file: f, message: `豁免清单里 ${f} 的 reason 为空。`, hint: '空理由 = 不可审计的免死金牌。写清"为什么这个存量能留在根上"，或删掉条目。' })
    }
    // 文件必须真实存在（反例 D）
    const abs = path.join(root, f)
    if (!fs.existsSync(abs)) {
      findings.push({ rule: 'B', file: f, message: `豁免清单登记的 ${f} 不存在。`, hint: '文件删了/改名了 ⇒ 条目该删；残留条目会让清单只涨不跌。' })
      continue
    }
    // 必须仍然带判据形态（债务消灭 ⇒ 条目该删）
    const feat = detectFeatures(fs.readFileSync(abs, 'utf8'))
    if (!feat.length) {
      findings.push({ rule: 'B', file: f, message: `豁免清单登记的 ${f} 已不带判据形态（现在不像判据了）。`, hint: '债务已消灭 ⇒ 删掉这条豁免，让清单真的只减。' })
    }
  }
  // 棘轮：只减不增
  const cap = Number(allow.maxEntries)
  if (!Number.isInteger(cap) || cap < 0) {
    findings.push({ rule: 'B', file: `${GATES_SUBDIR}/${ALLOWLIST_NAME}`, message: 'maxEntries 缺失或不是非负整数。', hint: '补上条目数上限，它是"只减不增"唯一的机械约束。' })
  } else if (allow.entries.length > cap) {
    findings.push({
      rule: 'B',
      file: `${GATES_SUBDIR}/${ALLOWLIST_NAME}`,
      message: `豁免清单 ${allow.entries.length} 条 > 上限 ${cap} 条。`,
      hint: '清单只许变短。真要加豁免，必须同时把 maxEntries 调高 —— 那在 git diff 里看得见，赖不掉。',
    })
  }
  // 根上的判据形态脚本：不在清单里 ⇒ 红（反例 B）
  for (const abs of rootScripts) {
    const feat = detectFeatures(fs.readFileSync(abs, 'utf8'))
    if (!feat.length) continue
    const rel = relPath(root, abs)
    if (byFile.has(rel)) continue
    findings.push({
      rule: 'B',
      file: rel,
      message: `${rel} 带判据形态（${feat.join(', ')}）却放在 ${ROOT_SUBDIR}/ 根，且不在豁免清单里。`,
      hint: `按丙规则（scripts/gates/README.md）新判据必须落 ${GATES_SUBDIR}/。移到那里并登记，或证明它不是判据。`,
    })
  }
  return findings
}

/**
 * 跑两条判据。
 * @returns {{code:number, findings:any[], notes:string[], stats:object}}
 */
export function runCheck(root = DEFAULT_ROOT) {
  const notes = []
  const findings = []

  const gateScripts = listGateScripts(root)
  const rootScripts = listRootScripts(root)
  if (!gateScripts) {
    return {
      code: EXIT.INTERNAL,
      findings: [],
      notes: [`判不了：${GATES_SUBDIR}/ 不存在（${root}）。这一层是丙规则的落点，它不能"暂时没有"。`],
      stats: {},
    }
  }
  if (!rootScripts) {
    return { code: EXIT.INTERNAL, findings: [], notes: [`判不了：${ROOT_SUBDIR}/ 不存在（${root}）。`], stats: {} }
  }

  // ── A ──
  const reg = loadRegistry(root)
  let aJudged = false
  if (!reg.ok) {
    notes.push(reg.reason)
    if (reg.code === EXIT.INTERNAL) {
      // 判据 A 判不了：不当作绿，也不当作红 —— 用 2 让上层看得见"这一半没判"。
      notes.push('（判据 A 未判 ⇒ 退出码 2；判据 B 照判。）')
    }
  } else {
    aJudged = true
    findings.push(...judgeOrphans(root, gateScripts, reg.gates))
  }

  // ── B ──
  const al = readAllowlist(root)
  let bJudged = false
  if (!al.ok) {
    findings.push({ rule: 'B', file: `${GATES_SUBDIR}/${ALLOWLIST_NAME}`, message: al.reason, hint: '清单是本层交付物的一部分。' })
    if (al.code === EXIT.INTERNAL) notes.push('（判据 B 未判 ⇒ 退出码 2。）')
  } else {
    bJudged = true
    findings.push(...judgeMisplacement(root, rootScripts, al.allow))
  }

  const unjudged = !reg.ok || !al.ok
  const code = findings.length ? EXIT.VIOLATION : unjudged ? EXIT.INTERNAL : EXIT.CLEAN
  return {
    code,
    findings,
    notes,
    stats: {
      gateScripts: gateScripts.length,
      rootScripts: rootScripts.length,
      registryGates: reg.ok ? reg.gates.length : null,
      allowlistEntries: al.ok ? al.allow.entries.length : null,
      allowlistMax: al.ok ? al.allow.maxEntries : null,
      aJudged,
      bJudged,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 自检：8 例，**真造文件、真跑、真删**
// 正向 1 例证明它不只会红；反向 7 例证明它在该红的时候真的红。
// 反向尤其要有 A（孤儿）与 B（放错层）：只有正向自检的门禁绿的时候你分不清
// 是"没问题"还是"判据坏了"。
// ─────────────────────────────────────────────────────────────────────────────
function makeFixture(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gates-reg-${tag}-`))
  fs.mkdirSync(path.join(root, 'scripts', 'gates'), { recursive: true })
  // 最小登记表替身：只实现 --list --json 契约（形状取自 run-gates.mjs §12 listGates）。
  // 为什么用替身而不是真的 run-gates.mjs：main 上它不存在（它在 ISS-714）；
  // 真调度器的对照在自检第 9 例（存在时跑真树）与交付证据里单独做。
  fs.writeFileSync(
    path.join(root, 'scripts', 'run-gates.mjs'),
    `import fs from 'node:fs'\nimport path from 'node:path'\n` +
      `const dir = path.dirname(new URL(import.meta.url).pathname)\n` +
      `const spec = JSON.parse(fs.readFileSync(path.join(dir, 'fixture-registry.json'), 'utf8'))\n` +
      `if (!process.argv.includes('--list')) process.exit(2)\n` +
      `console.log(JSON.stringify({ total: spec.length, derivedFromGuardBaselines: 0, byTier: { fast: spec.length, full: spec.length, ci: 0 },\n` +
      `  gates: spec.map((s, i) => ({ id: 'g' + i, label: s.label ?? 'fixture', tier: 'fast', timeoutMs: 60000, allowFailure: false, badge: 'standalone', command: s.command })) }, null, 1))\n`
  )
  fs.writeFileSync(
    path.join(root, 'scripts', 'gates', ALLOWLIST_NAME),
    JSON.stringify({ why: 'fixture', maxEntries: 0, entries: [] }, null, 1)
  )
  return root
}
const writeRegistry = (root, spec) => fs.writeFileSync(path.join(root, 'scripts', 'fixture-registry.json'), JSON.stringify(spec))
const writeGate = (root, name, body = '// fixture gate\n') => fs.writeFileSync(path.join(root, 'scripts', 'gates', name), body)
const writeRoot = (root, name, body) => fs.writeFileSync(path.join(root, 'scripts', name), body)
const writeAllow = (root, obj) => fs.writeFileSync(path.join(root, 'scripts', 'gates', ALLOWLIST_NAME), JSON.stringify(obj, null, 1))

function selftest() {
  const cases = []
  const run = (name, expectCode, mutate) => {
    const root = makeFixture(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
    try {
      mutate(root)
      const r = runCheck(root)
      cases.push({ name, expectCode, gotCode: r.code, ok: r.code === expectCode, findings: r.findings, notes: r.notes, stats: r.stats })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  const gateCmd = (root, name) => `${process.execPath} ${path.join(root, 'scripts', 'gates', name)} --check`

  // ① 正向：gates/ 下的都登记了 ⇒ 绿
  run('正向 · gates/ 下全部已登记', EXIT.CLEAN, (root) => {
    writeGate(root, 'aa-probe.mjs', "if (argv.includes('--selftest')) {}\n")
    writeRegistry(root, [{ command: gateCmd(root, 'aa-probe.mjs') }])
  })

  // ② 反向 A：gates/ 下有孤儿 ⇒ 红
  run('反向 A · gates/ 下未登记（孤儿判据）', EXIT.VIOLATION, (root) => {
    writeGate(root, 'aa-probe.mjs', "if (argv.includes('--selftest')) {}\n")
    writeGate(root, 'zz-probe.mjs', "if (argv.includes('--selftest')) {}\n")
    writeRegistry(root, [{ command: gateCmd(root, 'aa-probe.mjs') }])
  })

  // ③ 反向 A′：孤儿名字**只在注释里出现过** ⇒ 仍然红（证明不是弱判据）
  run('反向 A′ · 文件名只在调度器注释里出现（弱判据陷阱）', EXIT.VIOLATION, (root) => {
    writeGate(root, 'aa-probe.mjs', '// x\n')
    writeGate(root, 'zz-probe.mjs', '// x\n')
    fs.appendFileSync(path.join(root, 'scripts', 'run-gates.mjs'), '\n// 注意：zz-probe.mjs 曾经登记过，后来被删了\n')
    writeRegistry(root, [{ command: gateCmd(root, 'aa-probe.mjs') }])
  })

  // ④ 反向 B：scripts/ 根新增判据形态脚本、不在清单 ⇒ 红
  run('反向 B · 根上新增带 --selftest 的脚本（放错层）', EXIT.VIOLATION, (root) => {
    writeRegistry(root, [])
    writeRoot(root, 'zz-new-lint.mjs', "if (process.argv.includes('--selftest')) { check() }\n")
  })

  // ⑤ 反向 B′：形态来自 rule: / {rule,metric,mode}（不只 --selftest）⇒ 也红
  run('反向 B′ · 根上新增带 {rule,metric,mode} 的脚本', EXIT.VIOLATION, (root) => {
    writeRegistry(root, [])
    writeRoot(root, 'zz-metric.mjs', "const d = { rule: 'K9x', metric: 'C1', mode: 'whitelist', spec: '§1', text: 'x' }\nexport default d\n")
  })

  // ⑥ 反向 C：清单条目理由为空 ⇒ 红
  run('反向 C · 清单条目 reason 为空', EXIT.VIOLATION, (root) => {
    writeRegistry(root, [])
    writeRoot(root, 'zz-old.mjs', "if (process.argv.includes('--selftest')) {}\n")
    writeAllow(root, { why: 'f', maxEntries: 9, entries: [{ file: 'scripts/zz-old.mjs', reason: '   ' }] })
  })

  // ⑦ 反向 D：清单条目指向的文件不存在 ⇒ 红
  run('反向 D · 清单条目指向已不存在的文件', EXIT.VIOLATION, (root) => {
    writeRegistry(root, [])
    writeAllow(root, { why: 'f', maxEntries: 9, entries: [{ file: 'scripts/zz-gone.mjs', reason: '存量' }] })
  })

  // ⑧ 反向 E：清单涨过上限 ⇒ 红（只减不增）
  run('反向 E · 清单条数超过 maxEntries（只减不增）', EXIT.VIOLATION, (root) => {
    writeRegistry(root, [])
    writeRoot(root, 'zz-old.mjs', "if (process.argv.includes('--selftest')) {}\n")
    writeAllow(root, { why: 'f', maxEntries: 0, entries: [{ file: 'scripts/zz-old.mjs', reason: '存量' }] })
  })

  // ⑨ 正向 B：清单合法豁免 ⇒ 绿（避免"清单一律判红"的假红）
  run('正向 B · 合法豁免条目（有理由 + 文件在 + 仍带形态）', EXIT.CLEAN, (root) => {
    writeRegistry(root, [])
    writeRoot(root, 'zz-old.mjs', "if (process.argv.includes('--selftest')) {}\n")
    writeAllow(root, { why: 'f', maxEntries: 1, entries: [{ file: 'scripts/zz-old.mjs', reason: '存量（丙规则前就在根上）' }] })
  })

  // ⑩ 判不了：调度器不在 ⇒ INTERNAL(2)，不许假绿
  run('判不了 · 调度器不在本树（必须 exited 2，不许绿）', EXIT.INTERNAL, (root) => {
    fs.rmSync(path.join(root, 'scripts', 'run-gates.mjs'), { force: true })
    writeGate(root, 'aa-probe.mjs', '// x\n')
  })

  // ⑪ 单测不被要求登记（*.test.mjs 归测试运行器）
  run('正向 C · gates/ 下的 *.test.mjs 不要求登记', EXIT.CLEAN, (root) => {
    writeGate(root, 'aa-probe.mjs', '// x\n')
    writeGate(root, 'aa-probe.test.mjs', '// x\n')
    writeRegistry(root, [{ command: gateCmd(root, 'aa-probe.mjs') }])
  })

  const pass = cases.filter((c) => c.ok).length
  const json = process.argv.includes('--json')
  if (json) {
    console.log(JSON.stringify({ selftest: true, pass, total: cases.length, cases }, null, 1))
  } else {
    console.log(`verify-gates-registry --selftest`)
    for (const c of cases) {
      console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(52)} 期望 ${c.expectCode} 实得 ${c.gotCode}`)
      if (!c.ok) {
        console.log(`      findings: ${c.findings.map((f) => `[${f.rule}] ${f.file}`).join('; ') || '(无)'}`)
        if (c.notes.length) console.log(`      notes: ${c.notes.join(' / ')}`)
      }
    }
    console.log(`\n${pass}/${cases.length} 例通过`)
    // 顺带报存量盘面：证明自检之外，本树真扫得到东西（不是空跑绿）
    const live = runCheck(DEFAULT_ROOT)
    console.log(
      `本树盘面：${GATES_SUBDIR} ${live.stats.gateScripts ?? '?'} 个判据脚本 · ` +
        `${ROOT_SUBDIR}/ 根 ${live.stats.rootScripts ?? '?'} 个 .mjs · ` +
        `登记表 ${live.stats.registryGates ?? '判不了'} 格 · 豁免 ${live.stats.allowlistEntries ?? '?'}/${live.stats.allowlistMax ?? '?'} 条`
    )
  }
  return pass === cases.length ? EXIT.CLEAN : EXIT.VIOLATION
}

// ─────────────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node scripts/gates/verify-gates-registry.mjs [--check|--selftest|--json] [--repo <dir>]')
    console.log('  --check     判据 A（孤儿判据）+ B（层放错），默认动作')
    console.log('  --selftest  11 例反向自检（真造文件、真跑、真删）')
    console.log('  --json      机器可读输出')
    console.log('  --repo      换根（自检/基线树对照用），默认本仓根')
    return EXIT.CLEAN
  }
  if (argv.includes('--selftest')) return selftest()

  const i = argv.indexOf('--repo')
  const root = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : DEFAULT_ROOT
  const r = runCheck(root)

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ root, code: r.code, stats: r.stats, notes: r.notes, findings: r.findings }, null, 1))
    return r.code
  }

  console.log(`verify-gates-registry · ${root}`)
  console.log(
    `  判据 A（孤儿） ${r.stats.aJudged ? `已判 · ${GATES_SUBDIR} ${r.stats.gateScripts} 个脚本 vs 登记表 ${r.stats.registryGates} 格` : '未判（见下）'}`
  )
  console.log(
    `  判据 B（放错层） ${r.stats.bJudged ? `已判 · ${ROOT_SUBDIR}/ 根 ${r.stats.rootScripts} 个 .mjs · 豁免 ${r.stats.allowlistEntries}/${r.stats.allowlistMax} 条` : '未判（见下）'}`
  )
  for (const n of r.notes) console.log(`\n  ${n}`)
  if (r.findings.length) {
    console.log(`\n✗ ${r.findings.length} 条违规：`)
    for (const f of r.findings) {
      console.log(`\n  [${f.rule}] ${f.message}`)
      if (f.hint) console.log(`       → ${f.hint}`)
    }
  } else if (r.code === EXIT.CLEAN) {
    console.log('\n✓ 两条判据都干净：没有孤儿判据，没有新增的放错层脚本。')
  }
  const label = { [EXIT.CLEAN]: 'CLEAN', [EXIT.VIOLATION]: 'VIOLATION', [EXIT.INTERNAL]: 'INTERNAL（判不了）' }[r.code]
  console.log(`\n退出码 ${r.code} · ${label}`)
  return r.code
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main())
}

export { listGateScripts, listRootScripts, loadRegistry, DEFAULT_ROOT, EXIT }
