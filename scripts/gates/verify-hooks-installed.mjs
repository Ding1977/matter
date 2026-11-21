#!/usr/bin/env node
// scripts/gates/verify-hooks-installed.mjs
//
// 判据：**钩子是不是真的装上了**（ISS-718 · L1 编排层）
//
// ── 为什么需要这条判据 ────────────────────────────────────────────────
// 钩子脚本在版本库里，但让 git 去找它们的开关 `core.hooksPath` 是**本仓局部配置、不进版本库**。
// 于是存在一个没有任何东西会报的状态：文件在、可执行、`git commit` 却一声不响。
// 闸不严至少你知道它在；**闸不在而你以为它在** —— 今天一整轮就在这个状态里推代码。
//
// 本判据把那个状态变成一条看得见的三态结论：`0 干净 / 1 违规 / 2 判不了`。
//
// ── 判据比什么（两条都要，缺一即红）──────────────────────────────────
//   A. **开关**：`core.hooksPath` 解析后的真实目录 == `<repo>/scripts/git-hooks`
//        ⚠️ 比解析后目录，**不比字符串**：绝对路径写法同样合法，只比字面会把装好的闸报成没装。
//   B. **内容**：四个钩子文件都在 **且** 都可执行（清单见 `install-hooks.mjs` 的 `HOOKS`）
//        ⚠️ 缺执行位 = git 会静默跳过它。只看"文件存在"会把这种情况判绿，正是本单要防的形态。
//
//   只判 A 不判 B，就是「开关拨到空房间」；只判 B 不判 A，就是「房间里有闸但没接线」。
//
// ── 判不了不当绿 ──────────────────────────────────────────────────────
// `git` 不可用 / 不在 git 仓库里 / `scripts/git-hooks/` 不存在 ⇒ **exit 2**，并说明判不了什么。
// 不因为"读不到所以没问题"而放过（ISS-751 的同一颗教训：没在判必须显成字）。
//
// ── 与安装器共用一份判据 ──────────────────────────────────────────────
// 状态探测复用 `scripts/install-hooks.mjs` 的 `inspect()`。两处各写一份 = 同一条规则有两个答案，
// 那种分歧比单点漏判更难查（`verify-gates-registry.mjs` 头部记过同一形态）。
//
// 用法：
//   node scripts/gates/verify-hooks-installed.mjs             # 检查（同 --check）
//   node scripts/gates/verify-hooks-installed.mjs --json      # 机器可读
//   node scripts/gates/verify-hooks-installed.mjs --selftest  # 反向验证（真造仓库真变异）
//   node scripts/gates/verify-hooks-installed.mjs --repo <dir> # 换根（自检用）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// HOOKS 也一起 import：判「齐不齐」的清单**只能有一份**，就是安装器里那份。
// ISS-721 之前这里另有 `const HOOKS = [...三个]` —— 加 `pre-commit` 时若只改安装器，
// 判据照旧判三个 ⇒ 报绿，缺的那个永远不被点名。那正是「判据与实现各说一套」的静默失效。
import { HOOKS, inspect } from '../install-hooks.mjs'

const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

// 判谁：**当前工作目录所在的仓库**，不是本文件所在位置。
// 理由：`core.hooksPath` 是**哪个仓库的**配置，判据就该判哪个仓库。按「本文件在哪」定死，
// 会得到一个很坏的假绿：从 A 仓调到 B 树时，它照样报 A 仓的结论（实测踩过 —— 判据永远绿）。
// run-gates 与 pre-push 都在仓库根执行（`cwd: REPO`），故默认值就是对的。
// `--repo <dir>` 只给自检 / 对照用。
const DEFAULT_ROOT = process.cwd()

/** 判一次。返回 { code, findings[], stats }。**只读**，绝不改仓库任何状态。 */
export function judge(root = DEFAULT_ROOT) {
  const s = inspect({ root })

  if (s.status === 'unjudged') {
    return { code: EXIT.INTERNAL, findings: [], unjudged: s.reason, stats: { repo: s.repo ?? '' } }
  }

  const findings = []
  // A. 开关
  if (s.status === 'unset') {
    findings.push({ rule: 'H1', message: 'core.hooksPath **未设置** ⇒ 钩子一个都不会被执行' })
  } else if (s.status === 'wrong') {
    findings.push({
      rule: 'H2',
      message: `core.hooksPath 指向别处：'${s.cur}'（期望 'scripts/git-hooks'）⇒ 本仓的钩子不会被使用`,
    })
  }
  // B. 内容
  if (s.missing.length) findings.push({ rule: 'H3', message: `钩子文件缺失：${s.missing.join(' ')}` })
  if (s.notExec.length) findings.push({ rule: 'H4', message: `钩子缺执行位（git 会静默跳过）：${s.notExec.join(' ')}` })

  return {
    code: findings.length ? EXIT.VIOLATION : EXIT.CLEAN,
    findings,
    stats: { repo: s.repo, hooksPath: s.cur ?? '', status: s.status, hooks: HOOKS.length },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 自检：**必须造出会红的样本**。只有正向自检的门禁等于没有门禁 ——
// 它绿的时候你分不清「没问题」还是「判据坏了」。
// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const tmp = []
  // ⛔ P0（ISS-723）：selftest 里的 git 调用**必须**剥掉继承来的 GIT_* 环境变量。
  //   原因：`git commit` 跑钩子时会把 GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE 导出到环境，
  //   而这些变量**优先于 cwd** ⇒ `execFileSync('git', ['init','-q','.'], { cwd: dir })`
  //   会初始化到**真实仓库**，随后 `add -A` / `commit -m init` 把真实仓库的 HEAD 与索引
  //   改写成一条只有 5 个文件的 init 提交（实测：主库索引 2783 → 5）。
  //   最小复现：`GIT_DIR=<真仓>/.git node verify-hooks-installed.mjs --selftest`
  //   ⇒ 真仓 ls-files 从 2783 掉到 5。
  //   与 scripts/git-hooks/pre-commit 的 git_isolated() 同一教训（ISS-722 的遗留面）：
  //   **凡在临时目录跑 git，一律先剥 GIT_***。剥干净后 cwd 才真正说了算。
  const cleanEnv = () => {
    const e = { ...process.env }
    for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k]
    return e
  }
  const mkrepo = ({ hooks = true, mode = 0o755 } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhk-'))
    tmp.push(dir)
    if (hooks) {
      const d = path.join(dir, 'scripts', 'git-hooks')
      fs.mkdirSync(d, { recursive: true })
      for (const h of HOOKS) fs.writeFileSync(path.join(d, h), '#!/bin/sh\nexit 0\n', { mode })
    }
    const g = (...a) => execFileSync('git', a, { cwd: dir, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    g('init', '-q', '.')
    g('config', 'user.email', 'probe@example.invalid')
    g('config', 'user.name', 'probe')
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'init')
    return dir
  }
  const set = (repo, v) => execFileSync('git', ['config', 'core.hooksPath', v], { cwd: repo, env: cleanEnv(), stdio: 'ignore' })

  let pass = 0
  let fail = 0
  const ck = (name, cond, detail = '') => {
    if (cond) {
      pass++
      console.log(`  ✓ ${name}`)
    } else {
      fail++
      console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }

  try {
    // 正向
    const ok = mkrepo()
    set(ok, 'scripts/git-hooks')
    const r1 = judge(ok)
    ck('正向·相对路径装了 ⇒ 绿', r1.code === EXIT.CLEAN, `code=${r1.code}`)

    // 正向：绝对路径写法必须同样判绿（这条钉住"比解析后目录，不比字符串"）
    const absRepo = mkrepo()
    set(absRepo, path.join(absRepo, 'scripts', 'git-hooks'))
    const r2 = judge(absRepo)
    ck('正向·绝对路径也算装了（比解析后目录）', r2.code === EXIT.CLEAN, `code=${r2.code}`)

    // 反向 ①：未设置
    const un = mkrepo()
    const r3 = judge(un)
    ck('反向·未设置 ⇒ 红且点名 H1', r3.code === EXIT.VIOLATION && r3.findings.some((f) => f.rule === 'H1'), `code=${r3.code}`)

    // 反向 ②：指向别处
    const wr = mkrepo()
    fs.mkdirSync(path.join(wr, '.husky'))
    set(wr, '.husky')
    const r4 = judge(wr)
    ck(
      '反向·指向 husky ⇒ 红且点名 H2 并带出旧值',
      r4.code === EXIT.VIOLATION && r4.findings.some((f) => f.rule === 'H2' && f.message.includes('.husky')),
      JSON.stringify(r4.findings)
    )

    // 反向 ③：钩子文件缺
    const miss = mkrepo()
    set(miss, 'scripts/git-hooks')
    fs.rmSync(path.join(miss, 'scripts', 'git-hooks', 'pre-push'))
    const r5 = judge(miss)
    ck(
      '反向·缺 pre-push ⇒ 红且点名 H3（开关对但目录不全是假绿）',
      r5.code === EXIT.VIOLATION && r5.findings.some((f) => f.rule === 'H3' && f.message.includes('pre-push')),
      JSON.stringify(r5.findings)
    )

    // 反向 ④：缺执行位
    const noexec = mkrepo()
    set(noexec, 'scripts/git-hooks')
    fs.chmodSync(path.join(noexec, 'scripts', 'git-hooks', 'commit-msg'), 0o644)
    const r6 = judge(noexec)
    ck(
      '反向·缺执行位 ⇒ 红且点名 H4（git 会静默跳过）',
      r6.code === EXIT.VIOLATION && r6.findings.some((f) => f.rule === 'H4' && f.message.includes('commit-msg')),
      JSON.stringify(r6.findings)
    )

    // 反向 ⑤：判不了不当绿
    const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'vhk-nogit-'))
    tmp.push(nogit)
    const r7 = judge(nogit)
    ck('反向·不在 git 仓库 ⇒ 2 判不了（不许当绿）', r7.code === EXIT.INTERNAL, `code=${r7.code}`)

    // 反向 ⑥：目录整个不存在 ⇒ 判不了
    const emptyRepo = mkrepo({ hooks: false })
    const r8 = judge(emptyRepo)
    ck('反向·scripts/git-hooks 不存在 ⇒ 2 判不了', r8.code === EXIT.INTERNAL, `code=${r8.code}`)
  } finally {
    for (const d of tmp) {
      try {
        fs.chmodSync(path.join(d, '.git'), 0o755)
      } catch {
        /* ok */
      }
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* ok */
      }
    }
  }

  console.log(`\n  ${fail === 0 ? '✓' : '✗'} 自检 ${pass}/${pass + fail} 通过（正向 2 · 反向 6）`)
  return fail === 0 ? EXIT.CLEAN : EXIT.VIOLATION
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest()

  const ri = argv.indexOf('--repo')
  const root = ri >= 0 ? argv[ri + 1] : DEFAULT_ROOT
  const r = judge(root)

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ code: r.code, findings: r.findings, unjudged: r.unjudged ?? null, stats: r.stats }, null, 2))
    return r.code
  }

  if (r.code === EXIT.INTERNAL) {
    console.error(`✗ 判不了：${r.unjudged}`)
    console.error(`  （判不了不当绿：这条判据没在判，不是"没问题"）`)
    return r.code
  }
  if (r.code === EXIT.CLEAN) {
    console.log(`✓ 钩子已装：core.hooksPath 指向 scripts/git-hooks · ${HOOKS.length} 个钩子齐全且可执行`)
    return r.code
  }
  console.error(`✗ 钩子没装好（${r.findings.length} 条）：`)
  for (const f of r.findings) console.error(`  [${f.rule}] ${f.message}`)
  console.error(`\n  修复：node scripts/install-hooks.mjs        # 幂等；等价于重跑一次 bun install`)
  console.error(`  已指向别处而要强改：node scripts/install-hooks.mjs --force`)
  return r.code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
