// scripts/lint-code.mjs 的 **CLI 层**判据（ISS-671）
//
// ## 为什么另起一个文件，而不都塞进 --selftest
// `--selftest` 验的是纯函数（`baselineStamp` / `staleBaseline` / `attributeFinding` / `evaluate`），
// 但本单最关键的一条语义落在 **CLI 分支**里：**「基线过期」不许改退出码**。
// 那是 `process.exit(...)` 那几行的事 —— 纯函数测不到它。把 `if (staleWarn) exit(1)` 加进去，
// 自检照样全绿而门禁开始把「基线旧了」报成「代码坏了」。
// 本仓 ISS-637 的原话：**验到的那一层必须就是被改的那一层**。
//
// ## 为什么起真子进程 + `--dump`
// 退出码是进程级事实，只有真跑才看得到。`--dump <file>` 喂一份现成的盘点产物，
// 从而**不重复扫全仓**（一次 code-inventory 约 5s，逐用例跑会把本文件拖到分钟级，
// 分钟级的守卫会被绕开）。这份 dump 在本文件开头生成一次，之后所有用例共用。
//
// ## 为什么基线一律用临时副本
// `scripts/baseline/code-gates.json` 是**真相源**：拿它当试验田改「10 天前」再改回来，
// 改坏一次就等于伪造了判定标准。所有用例都经 `--baseline <tmp>` 注入。
//
// 跑法：node scripts/lint-code.test.mjs          （退出码 0 = 全绿；直接读人话）
//       bun test --isolate scripts/lint-code.test.mjs
//
// ⚠️ 本文件**尚未接进 `scripts/guard-baselines.sh`**（那不在本单的写范围里）。
//    就绪的接法：`selfcheck scripts/lint-code.test.mjs --check "..."` —— `selfcheck()` 对非 .sh
//    一律用 $NODE 跑 `node <script> <arg>`，本文件忽略多余实参，因此那一行可直接落。
//    在接进去之前，**有牙的是 `--selftest`（已在 guard 里）**，本文件是它够不着的那一层的补充。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'lint-code.mjs')
const REAL_BASELINE = path.join(ROOT, 'scripts', 'baseline', 'code-gates.json')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-code-cli-'))

const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 27 })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const day = 86400000
const isoAgo = (n) => new Date(Date.now() - n * day).toISOString()
const baselineCopy = (name, mutate) => {
  const j = JSON.parse(fs.readFileSync(REAL_BASELINE, 'utf8'))
  if (mutate) mutate(j)
  const p = path.join(TMP, name)
  fs.writeFileSync(p, JSON.stringify(j, null, 1))
  return p
}

/* 一份现成的盘点产物：本文件所有用例共用（唯一一次全仓扫描）。 */
const DUMP = path.join(TMP, 'inventory.json')
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'code-inventory.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.status !== 0) {
    console.error(`✗ 前置失败：code-inventory 扫不出来（exit ${r.status}）\n${String(r.stderr || '').slice(0, 600)}`)
    process.exit(2)
  }
  fs.writeFileSync(DUMP, r.stdout)
}
const metrics = JSON.parse(fs.readFileSync(DUMP, 'utf8')).metrics
/** 现值（按 gate 号取），用来把临时基线裁成"正好差 n 处" */
const nowOf = (gate) => {
  const m = metrics.find((x) => (x.gate || '') === gate)
  const nums = String(m.value).match(/-?\d+/g) || []
  // K10b 的坏ness 在第 2 段（第 1 段是导出总数）—— 与 RULES 里 take:1 同口径
  return Number(gate === 'K10b' ? nums[1] : nums[0])
}
/** 把所有被判规则的现值就地记成上限 ⇒ 临时基线自身「全绿」，好让过期警告成为唯一变量 */
const greenCeiling = (j) => {
  for (const m of metrics) {
    if (m.gate && m.gate in j.ceiling) j.ceiling[m.gate] = nowOf(m.gate)
  }
}

/* ── 验收 1：过期必须出声，但**退出码不变** ───────────────────────────────── */
test('验收1：writtenAt 10 天前 ⇒ 有过期警告，退出码仍是 0（警告不是红）', () => {
  const bl = baselineCopy('stale.json', (j) => { greenCeiling(j); j.writtenAt = isoAgo(10) })
  const r = run(['--check', '--dump', DUMP, '--baseline', bl])
  assert.match(r.out, /基线已过期 10 天/, '过期必须打出警告')
  assert.match(r.out, /取自 writtenAt/, '警告要点名判据用的是哪一级时间戳')
  assert.equal(r.code, 0, '基线旧了不是代码错 —— 它在退出码上必须与「违例」区分开')
})

/* ── 验收 2：阈值内不许响（长鸣的警告 = 没有警告） ─────────────────────────── */
test('验收2：writtenAt 3 天前 ⇒ 无警告，退出码 0', () => {
  const bl = baselineCopy('fresh.json', (j) => { greenCeiling(j); j.writtenAt = isoAgo(3) })
  const r = run(['--check', '--dump', DUMP, '--baseline', bl])
  assert.doesNotMatch(r.out, /基线已过期/, '阈值内报警 = 噪音，会被无视')
  assert.equal(r.code, 0)
})

/* ── 验收 3：三级兜底 + 失败安全 ──────────────────────────────────────────── */
test('验收3a：writtenAt 缺失 ⇒ 认 recordedAt 并标出来源', () => {
  const bl = baselineCopy('rec.json', (j) => { greenCeiling(j); delete j.writtenAt; j.recordedAt = isoAgo(10).slice(0, 10) })
  const r = run(['--check', '--dump', DUMP, '--baseline', bl])
  assert.match(r.out, /基线已过期 \d+ 天/)
  assert.match(r.out, /取自 recordedAt/)
})

test('验收3b：两个字段都缺失 ⇒ 用文件 mtime 兜底', () => {
  const bl = baselineCopy('mtime.json', (j) => { greenCeiling(j); delete j.writtenAt; delete j.recordedAt })
  const old = new Date(Date.now() - 10 * day)
  fs.utimesSync(bl, old, old)
  const r = run(['--check', '--dump', DUMP, '--baseline', bl])
  assert.match(r.out, /取自 mtime/, 'mtime 是第三级，必须在文案里现身')
})

test('验收3c：三级都取不到 ⇒ **不报**（失败安全，不是"当今天"也不是"报过期"）', () => {
  // 造文件的 mtime 不可读不现实；「三级都拿不到」这一格由 --selftest 的纯函数用例钉住
  // （那里能直接构造 baselineStamp({}, undefined)）。这里只断言那一格**确实在自检里**，
  // 且自检此时是绿的 —— 不去耦合「自检退出码」与「本用例」，否则别的用例一红就把这条带红。
  const r = run(['--selftest'])
  assert.match(r.out, /失败安全：三级都拿不到 ⇒ 不报（不是"报过期"，也不是"当今天"）/, '纯函数口径必须由自检覆盖')
})

/* ── 验收 4：构造「新增 1 处」⇒ 报告指出疑似引入的提交 ────────────────────── */
test('验收4：K9f 上限收到现值-1（正好新增 1 处）⇒ 判出新增且 exit 1（定位归属由 --selftest 覆盖）', () => {
  const cap = nowOf('K9f')
  const bl = baselineCopy('plus1.json', (j) => { j.ceiling.K9f = cap - 1 })
  const r = run(['--check', '--dump', DUMP, '--baseline', bl])
  assert.match(r.out, new RegExp(`K9f.*新增：${cap - 1} → ${cap}`), '先把「新增 1 处」判出来')
  // ⚠️ 这里**不验** `↳ sha 日期 标题`：窗口由 git 硬算（`attributionWindow`，lint-code.mjs:194-215），
  //    而本测试的工作树改动未提交 ⇒ anchor(=基线文件最新提交)..HEAD 无提交 ⇒ 必然走「无法定位」。
  //    该形状由 `--selftest` 的 renderFinding 单测钉住（lint-code.mjs:743-746）；
  //    归属逻辑（找不找得到 commit、强嫌疑 vs 疑似）由 winStub + attributeFinding 注入验（:722-741）。
  assert.equal(r.code, 1, '有新增违例 ⇒ exit 1（「判出来了」≠「返回码对」——ISS-685 就是 flag 组合错了但 exit code 才对发现问题的）')
})

/* ── 验收 5：定位不到时明说理由，不许静默返回空 ───────────────────────────── */
test('验收5：--baseline 指到不存在的文件 ⇒ exit 2 并说清，不静默回落到仓库基线', () => {
  const r = run(['--check', '--dump', DUMP, '--baseline', path.join(TMP, 'nope.json')])
  assert.equal(r.code, 2, '「我以为在验副本，其实验的是真相源」是假绿的标准形态 ⇒ 必须拦住')
  assert.match(r.out, /--baseline 指的文件不存在/)
})

test('验收5b：--baseline 后面缺值 ⇒ exit 2，不许回落', () => {
  const r = run(['--check', '--baseline', '--json'])
  assert.equal(r.code, 2)
  assert.match(r.out, /--baseline 后面缺路径/)
})

/* ── --json：过期警告单列一档，不许混进 findings（混进去就等于变红） ──────── */
test('--json 把过期警告放在 baselineWarning，findings 里没有它', () => {
  const bl = baselineCopy('json-stale.json', (j) => { greenCeiling(j); j.writtenAt = isoAgo(10) })
  const r = run(['--check', '--json', '--dump', DUMP, '--baseline', bl])
  const j = JSON.parse(r.out)
  assert.match(String(j.baselineWarning), /基线已过期/)
  assert.equal(j.findings.length, 0, '过期不许进 findings（机器读的人会据此判红）')
  assert.equal(r.code, 0)
})

test('--json 不过期时 baselineWarning 为 null（字段在、但如实为空）', () => {
  const bl = baselineCopy('json-fresh.json', (j) => { greenCeiling(j); j.writtenAt = isoAgo(1) })
  const r = run(['--check', '--json', '--dump', DUMP, '--baseline', bl])
  assert.equal(JSON.parse(r.out).baselineWarning, null)
})
