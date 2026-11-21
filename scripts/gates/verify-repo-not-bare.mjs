#!/usr/bin/env node
// scripts/gates/verify-repo-not-bare.mjs
//
// 判据：**每个 checkout 的 `core.bare` 都是 false，且没有「已暂存删除但 HEAD 里还有」的文件**（ISS-797）
//
// ── 为什么需要这条判据 ────────────────────────────────────────────────
// `core.bare` 是 `.git/config` 里的一行，**不进版本库**，写成 true 之后该 checkout 立刻
// 失去 work tree 能力：`git status` 报 `fatal: this operation must be run in a work tree`。
// 2026-11-11 20:55 与 11-12 23:45 主 checkout 两度这样被改坏，**没有任何判据发现它**。
// 恶性循环：主 checkout 既没法正常干活，也没法修复自己。
//
// 此前两张单治的都是「谁改坏」：
//   · ISS-722 pre-commit 钩子写坏 core.bare
//   · ISS-723 verify-hooks-installed --selftest 继承 GIT_DIR 摧毁仓库
// 本判据补的是链条上缺的那一环：**改坏了要能被发现**。
//
// ── 判两条 ────────────────────────────────────────────────────────────
//   B1 · 逐个 checkout（主 checkout + 全部工作树）跑 `git rev-parse --is-bare-repository`，
//        要求结果为 `false`。**只查当前目录不够**：有 97~149 个工作树，同样会坏。
//
//   B2 · 「已暂存删除但 HEAD 里有」：`git diff --cached --name-status` 里状态 D 的路径，
//        若 `git cat-file -e HEAD:<path>` 成功 ⇒ 版本库里明明还有，却被暂存成删除。
//        这是 11-12 那天钩子全废的第二个原因（`--diff-baseline` 因 ERR_MODULE_NOT_FOUND 跑不起来）。
//
// ── B2 的豁免清单（ISS-809）────────────────────────────────────────────
// B2 原来没有豁免口子 ⇒ **正常退役一个文件也必然撞红**。实测 ISS-809 退役三个 ci-*.mjs
// 触发 3 条 B2，人只能绕（`--no-verify` / 拆成两次提交），绕法比判据本身更危险。
// 但豁免不能做成「垃圾桶」—— 一条 `"path": "x"` 就把牙齿换掉了，事后没人知道为什么删的。
// 所以豁免是**台账**，三条硬约束：
//   a) 每条必须带 `issue`（非空）。缺 issue ⇒ 该条**不采信**，照旧报误删并在 message 里说明。
//      理由是「为什么允许这次删除」这件事必须能追到一张单，否则豁免等于静音开关。
//   b) 清单读不到 / JSON 坏了 / 形状不对 ⇒ **退回全量报误删**（fail-closed）。
//      判据的零件坏掉时必须更严，不能更松 —— fail-open 会让「清单被删」变成一键关门的后门。
//   c) 登记了但**当前没被暂存删除** ⇒ **不报红**。退役单合入后清单还留着是正常态，
//      要求每次合入完再删清单，等于逼人做一次无收益的二次改动（也就没人做）。
//      只在这种情况下对「缺 issue」的条目 warn 到 stderr，不判红。
//
// ⚠️ 两条的**射程不同**，是故意的：
//    · B1 扫全部工作树 —— bare 是**持久损坏**，任何时刻、任何树都该红。
//    · B2 只扫**当前 checkout**（root）—— 暂存区是**工作中间态**（本来就可以做到一半），
//      扫全部工作树会让判据在「别人正有一张单在做」时恒红（实测：149 个工作树里
//      ISS-802 暂存删了 12 个文件 ⇒ 判据恒 exit 1 ⇒ 等于没有判据）。
//      B2 的真实目的场景是「你自己树里误删入库文件，push 前被抓住」，当前 checkout 正好覆盖。
//
// ⚠️ 为什么不用 `git status` 的返回码判 bare：它在 bare 仓里也可能返回 0，
//    且同时被 `.git/index` 损坏、权限、锁文件等十几种原因影响 ⇒ 红的原因说不准。
//    本判据只认 `rev-parse --is-bare-repository`，它的语义就是这一个问题。
//
// ⚠️ 为什么必须逐个路径查：实测在主仓 `core.bare=true` 之后，
//    **子工作树里跑 `rev-parse --is-bare-repository` 仍返回 false** ——
//    站在好树里根本看不见主仓已坏。只在当前目录判 = 对真实故障场景完全失明。
//
// ── 判不了不当绿也不当红（三态）────────────────────────────────────────
// `git` 不可用 / 路径不是 git 仓库 / `worktree list` 读不到 ⇒ **exit 2**，并说明判不了什么。
// 今天刚踩过 `loadRegistry() return []` 吞掉「读不到」造成 88 格假红 ——
// **判据跑不成必须是 2，不许沉默成绿，也不许伪装成红。**
//
// 用法：
//   node scripts/gates/verify-repo-not-bare.mjs             # 检查（同 --check）
//   node scripts/gates/verify-repo-not-bare.mjs --json      # 机器可读
//   node scripts/gates/verify-repo-not-bare.mjs --selftest  # 反向验证（真造仓库真变异）
//   node scripts/gates/verify-repo-not-bare.mjs --repo <dir> # 换根（自检 / 对照用）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

// 判谁的仓库：**当前工作目录所在的仓库**，不是本文件所在位置（同 verify-hooks-installed 的理由）。
// run-gates / pre-push 都在仓库根执行（`cwd: REPO`），故默认值就是对的。
const DEFAULT_ROOT = process.cwd()

/**
 * ⛔ 剥掉继承来的 GIT_* 环境变量（ISS-723 的教训，同一颗雷）：
 *   `git commit` 跑钩子时会把 GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE 导出到环境，
 *   而这些变量**优先于 cwd** ⇒ 不剥干净就会判到**另一个仓库**上去。
 *   剥干净后 cwd 才真正说了算。
 */
function cleanEnv() {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k]
  return e
}

/** 跑一条 git 命令，返回 { ok, out, err }。**不抛**，由调用方决定这是红还是判不了。 */
function git(args, cwd) {
  try {
    const out = execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: out.trim(), err: '' }
  } catch (e) {
    const err = String((e && (e.stderr || e.message)) || e).trim()
    return { ok: false, out: '', err }
  }
}

/**
 * 收集要判的路径：主 checkout + 全部工作树。
 * `worktree list --porcelain` 的 `worktree <path>` 行是稳定格式（逐行解析，不靠 awk 列对齐）。
 */
export function collectCheckouts(root) {
  if (!fs.existsSync(root)) return { ok: false, error: `路径不存在（${root}）` }
  const r = git(['worktree', 'list', '--porcelain'], root)
  if (!r.ok) return { ok: false, error: `git worktree list 读不到（${root}）：${r.err}` }
  const dirs = r.out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean)
  if (!dirs.length) return { ok: false, error: `worktree list 返回 0 条路径（${root}）⇒ 判不了` }
  return { ok: true, dirs }
}

/** 路径归一化：macOS 的 /var 是真 /private/var，软链也要归一。
 *  不归一 ⇒ 输出里的路径与调用方给的路径字面不等（实测踩过）。 */
function realDir(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** B1：`rev-parse --is-bare-repository` 必须是 false。 */
function checkBare(dir) {
  const shown = realDir(dir)
  const r = git(['rev-parse', '--is-bare-repository'], dir)
  if (!r.ok) return { judged: false, error: `rev-parse 失败：${r.err}` }
  if (r.out === 'true') {
    return {
      judged: true,
      finding: {
        rule: 'B1',
        path: shown,
        message: `${shown} 的 core.bare = true ⇒ 该 checkout 已失去 work tree 能力（git status 会报 fatal）`,
        fix: `sed -i '' 's/^\\tbare = true$/\\tbare = false/' ${JSON.stringify(path.join(shown, '.git', 'config'))}  # 或 git -C ${JSON.stringify(dir)} config core.bare false`,
      },
    }
  }
  // 既不是 true 也不是 false ⇒ 输出形状变了，判不了，不许猜成 false。
  if (r.out !== 'false') return { judged: false, error: `rev-parse 输出既非 true 也非 false（"${r.out}"）` }
  return { judged: true }
}

/** B2 豁免清单（相对被判仓库根）。见文件头「B2 的豁免清单」三条硬约束。 */
const MANIFEST = 'scripts/baseline/repo-not-bare-exempt.json'

/**
 * 读 B2 豁免清单。**任何异常都返回 {ok:false}**，由调用方按 fail-closed 处理：
 * 清单读不到 = 没有豁免，**不是**「全部豁免」。判据的零件坏掉时必须更严。
 * 形状：{ "deleted": [{ path, issue, why }] }（顶层数组也接受，向后兼容）。
 */
export function loadExempt(root) {
  let raw
  try {
    raw = fs.readFileSync(path.join(root, MANIFEST), 'utf8')
  } catch (e) {
    return { ok: false, error: `${MANIFEST} 读不到（${e.code || e.message}）` }
  }
  let j
  try {
    j = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `${MANIFEST} 不是合法 JSON（${e.message}）` }
  }
  const list = Array.isArray(j) ? j : j && Array.isArray(j.deleted) ? j.deleted : null
  if (!list) return { ok: false, error: `${MANIFEST} 形状不对（应为 {"deleted":[{"path","issue","why"}]}）` }

  const exempt = new Map()
  const noIssue = []
  for (const e of list) {
    if (!e || typeof e !== 'object' || !e.path) continue
    const p = String(e.path).split(path.sep).join('/')
    // a) 缺 issue ⇒ 该条不采信（记进 noIssue，命中时照旧报误删并点名原因）。
    const issue = typeof e.issue === 'string' ? e.issue.trim() : ''
    if (!issue) {
      noIssue.push(p)
      continue
    }
    if (!exempt.has(p)) exempt.set(p, { path: p, issue, why: e.why })
  }
  return { ok: true, exempt, noIssue }
}

/** B2：已暂存删除、但 HEAD 里确实还有 ⇒ 误删（豁免清单命中则跳过）。 */
function checkStagedDeletes(dir) {
  const shown = realDir(dir)
  const r = git(['diff', '--cached', '--name-status'], dir)
  if (!r.ok) return { judged: false, error: `diff --cached 失败：${r.err}` }
  const deleted = r.out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((cols) => cols.length >= 2 && cols[0] === 'D')
    .map((cols) => cols[1])
    .filter(Boolean)

  const ex = loadExempt(dir)
  const findings = []
  const warnings = []
  const used = new Set()
  for (const f of deleted) {
    // HEAD 里没有 ⇒ 是新增后又被删，正常，不算误删。
    if (!git(['cat-file', '-e', `HEAD:${f}`], dir).ok) continue
    if (ex.ok && ex.exempt.has(f)) {
      used.add(f) // 登了账、也带 issue ⇒ 有意删除，放行
      continue
    }
    const missingIssue = ex.ok && ex.noIssue.includes(f)
    findings.push({
      rule: 'B2',
      path: shown,
      file: f,
      message: missingIssue
        ? `${shown} 暂存区把 ${f} 记为删除，但 HEAD 里还有 ⇒ 误删入库文件；豁免条目缺 issue，不予采信（豁免是台账，必须能追到一张单）`
        : `${shown} 暂存区把 ${f} 记为删除，但 HEAD 里还有 ⇒ 误删入库文件（基线/钩子会因 ERR_MODULE_NOT_FOUND 整段跑不起来）${ex.ok ? '' : `；豁免清单${ex.error} ⇒ 按无豁免处理`}`,
      fix: `git -C ${JSON.stringify(shown)} restore --staged ${JSON.stringify(f)} && git -C ${JSON.stringify(shown)} checkout -- ${JSON.stringify(f)}`,
    })
  }
  // c) 登记了但当前没被暂存删除 ⇒ 不报红（退役单合入后清单还留着是正常态）。
  //    只有「缺 issue」的这类条目顺带 warn 一声 —— 它是坏账，但不该拦人。
  if (ex.ok) {
    for (const p of ex.noIssue) if (!used.has(p) && !deleted.includes(p)) warnings.push(`豁免条目缺 issue，未生效：${p}`)
  }
  return { judged: true, findings, warnings, exemptUsed: [...used] }
}


/**
 * 判一次。返回 { code, findings[], unjudged?, stats }。**只读**，绝不改仓库任何状态。
 * @param {string} root 判哪个仓库（默认 cwd）
 */
export function judge(root = DEFAULT_ROOT) {
  const c = collectCheckouts(root)
  if (!c.ok) return { code: EXIT.INTERNAL, findings: [], unjudged: c.error, stats: { root, checkouts: 0, judged: 0 } }

  const findings = []
  const unjudged = []
  const warnings = []
  let judged = 0

  const rootReal = realDir(root)
  for (const dir of c.dirs) {
    // 路径可能已被删除（工作树登记残留）⇒ 这是「判不了」，不是「坏」也不是「好」。
    if (!fs.existsSync(dir)) {
      unjudged.push(`${dir}（路径不存在，工作树登记残留？）`)
      continue
    }
    const b = checkBare(dir)
    if (!b.judged) {
      // git 命令本身失败 ⇒ 判不了。**不许**当成 false（会假绿），也不许当成 true（会假红）。
      unjudged.push(`${dir}（${b.error}）`)
      continue
    }
    if (b.finding) findings.push(b.finding)
    judged++

    // B2 只判当前 checkout（见文件头「射程不同」的说明）。
    // 判不了 root ⇒ 整条判据判不了，不许沉默成绿。
    if (realDir(dir) !== rootReal) continue
    const s = checkStagedDeletes(dir)
    if (!s.judged) {
      unjudged.push(`${dir}（暂存区判不了：${s.error}）`)
      continue
    }
    findings.push(...s.findings)
    if (s.warnings && s.warnings.length) warnings.push(...s.warnings)
  }

  // 一条都没判成 ⇒ 判不了；有判成的，按判成的结果给红/绿，但把判不了的显式带出去。
  if (!judged) {
    return { code: EXIT.INTERNAL, findings: [], unjudged: unjudged.join('；'), warnings, stats: { root, checkouts: c.dirs.length, judged: 0 } }
  }

  return {
    code: findings.length ? EXIT.VIOLATION : EXIT.CLEAN,
    findings,
    unjudged: unjudged.length ? unjudged.join('；') : undefined,
    warnings,
    stats: { root, checkouts: c.dirs.length, judged, b1: findings.filter((f) => f.rule === 'B1').length, b2: findings.filter((f) => f.rule === 'B2').length },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 自检：**必须造出会红的样本**。只有正向自检的门禁等于没有门禁 ——
// 它绿的时候你分不清「没问题」还是「判据坏了」。
// ⚠️ 全部样本走 fs.mkdtempSync，**绝不碰真实 checkout 的 core.bare**（碰了就卡死本仓）。
// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const tmp = []
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const mkdir = (tag) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `vbare-${tag}-`))
    tmp.push(d)
    return d
  }
  const mkrepo = () => {
    const dir = mkdir('repo')
    g(dir, 'init', '-q', '.')
    g(dir, 'config', 'user.email', 'probe@example.invalid')
    g(dir, 'config', 'user.name', 'probe')
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n')
    fs.writeFileSync(path.join(dir, 'keep.mjs'), 'export const x = 1\n')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-q', '-m', 'init')
    return dir
  }
  const setBare = (repo, v) => g(repo, 'config', 'core.bare', String(v))
  const addWorktree = (repo, tag) => {
    const p = path.join(os.tmpdir(), `vbare-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
    tmp.push(p)
    g(repo, 'worktree', 'add', '-q', p, '-b', `probe-${tag}-${Math.random().toString(36).slice(2, 7)}`)
    return p
  }

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
  /** 走命令行而不是直接调 judge：证明退出码这一层也是对的。 */
  const runCli = (argv) => {
    try {
      const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...argv], { env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (e) {
      return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') }
    }
  }

  try {
    // ① 正常仓 ⇒ 0
    const ok = mkrepo()
    const r1 = runCli(['--repo', ok])
    ck('正常仓（bare=false）⇒ exit 0', r1.code === EXIT.CLEAN, `code=${r1.code} ${r1.out.trim()}`)

    // ② 改成 bare ⇒ 1，且输出里**印出那个路径**（这是本单的核心牙齿）
    const bad = mkrepo()
    setBare(bad, true)
    const r2 = runCli(['--repo', bad])
    ck('本仓 bare=true ⇒ exit 1 且输出含该路径', r2.code === EXIT.VIOLATION && r2.out.includes(bad), `code=${r2.code} 含路径=${r2.out.includes(bad)}`)

    // ③ 已暂存删除但 HEAD 里有 ⇒ 1（B2）
    const del = mkrepo()
    fs.rmSync(path.join(del, 'keep.mjs'))
    g(del, 'add', '-A')
    const r3 = runCli(['--repo', del])
    ck('已暂存删除但 HEAD 有 keep.mjs ⇒ exit 1 且点名该文件', r3.code === EXIT.VIOLATION && r3.out.includes('keep.mjs') && r3.out.includes(del), `code=${r3.code}`)
    // 反例：**从未 commit 过**的文件被删掉，HEAD 里本来就没有 ⇒ 不算误删（别把正常删除报成红）
    const del2 = mkrepo()
    fs.writeFileSync(path.join(del2, 'never-committed.txt'), 'y\n')
    g(del2, 'add', '-A') // 暂存新增
    fs.rmSync(path.join(del2, 'never-committed.txt')) // 再删掉
    g(del2, 'add', '-A')
    const r3b = judge(del2)
    ck('从未 commit 的文件被删（HEAD 里没有）不算误删 ⇒ 0', r3b.code === EXIT.CLEAN, `code=${r3b.code} findings=${JSON.stringify(r3b.findings)}`)

    // ③x B2 豁免清单（ISS-809）。四个方向都要有样本 —— 只测「能放行」等于没测：
    //     放行对不对 / 不登账还红不红 / 清单坏了是不是 fail-closed / 缺 issue 会不会被滥用。
    const writeManifest = (repo, body) => {
      const p = path.join(repo, MANIFEST)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
    }

    // A：**登了账（带 issue）+ 真被暂存删除 ⇒ 绿**（本单要解决的正题）
    const exA = mkrepo()
    writeManifest(exA, { deleted: [{ path: 'keep.mjs', issue: 'ISS-809', why: '退役：无调用方' }] })
    fs.rmSync(path.join(exA, 'keep.mjs'))
    g(exA, 'add', '-A')
    const rA = runCli(['--repo', exA])
    ck('暂存删除**有** issue 登记的路径 ⇒ exit 0（豁免生效）', rA.code === EXIT.CLEAN, `code=${rA.code} ${rA.out.trim()}`)

    // B：**没登账 ⇒ 照旧红**（豁免不是整条判据的静音开关）
    const exB = mkrepo()
    writeManifest(exB, { deleted: [{ path: 'other.mjs', issue: 'ISS-809', why: '别的文件' }] })
    fs.rmSync(path.join(exB, 'keep.mjs'))
    g(exB, 'add', '-A')
    const rB = runCli(['--repo', exB])
    ck(
      '暂存删除**没**登记的路径 ⇒ exit 1 且 1 条 B2',
      rB.code === EXIT.VIOLATION && /\[B2\]/.test(rB.out) && rB.out.includes('keep.mjs'),
      `code=${rB.code} ${rB.out.trim()}`,
    )

    // B2 fail-closed：清单 JSON 坏了 ⇒ 必须**退回全量报误删**，不许"读不懂就全豁免"
    const exC = mkrepo()
    writeManifest(exC, '{ "deleted": [ // 坏掉的 JSON')
    fs.rmSync(path.join(exC, 'keep.mjs'))
    g(exC, 'add', '-A')
    const rC = runCli(['--repo', exC])
    ck(
      '豁免清单 JSON 坏了 ⇒ 仍 exit 1（fail-closed，不许当全豁免）',
      rC.code === EXIT.VIOLATION && rC.out.includes('keep.mjs'),
      `code=${rC.code} ${rC.out.trim()}`,
    )
    // 清单文件整个不存在 ⇒ 同一条底线（判据没坏，只是没登记）
    const exC2 = mkrepo()
    fs.rmSync(path.join(exC2, 'keep.mjs'))
    g(exC2, 'add', '-A')
    const rC2 = runCli(['--repo', exC2])
    ck('没有豁免清单文件 ⇒ 仍 exit 1（同上，读不到 = 无豁免）', rC2.code === EXIT.VIOLATION, `code=${rC2.code}`)

    // B3 缺 issue 的条目**不予采信** ⇒ 照旧红，且 message 要讲清为什么
    const exD = mkrepo()
    writeManifest(exD, { deleted: [{ path: 'keep.mjs', why: '没写单号' }] })
    fs.rmSync(path.join(exD, 'keep.mjs'))
    g(exD, 'add', '-A')
    const rD = runCli(['--repo', exD])
    ck(
      '豁免条目缺 issue ⇒ 不予采信、仍 exit 1 且 message 点名缺 issue',
      rD.code === EXIT.VIOLATION && rD.out.includes('缺 issue'),
      `code=${rD.code} ${rD.out.trim()}`,
    )

    // B4 登了账但**当前没删**（退役单已合入、清单还留着）⇒ 不许报红
    const exE = mkrepo()
    writeManifest(exE, { deleted: [{ path: 'keep.mjs', issue: 'ISS-809', why: '已合入' }] })
    const rE = runCli(['--repo', exE])
    ck('登记了但当前没被暂存删除 ⇒ exit 0（不许要求合入后回来删清单）', rE.code === EXIT.CLEAN, `code=${rE.code} ${rE.out.trim()}`)

    // ④ 不在 git 仓库 ⇒ 2（不许 0，也不许 1）
    const noGit = mkdir('nogit')
    const r4 = runCli(['--repo', noGit])
    ck('不在 git 仓库 ⇒ exit 2（判不了，不当绿也不当红）', r4.code === EXIT.INTERNAL, `code=${r4.code}`)

    // ⑤ 路径不存在 ⇒ 2
    const r5 = runCli(['--repo', path.join(os.tmpdir(), `vbare-absent-${Date.now().toString(36)}`)])
    ck('路径不存在 ⇒ exit 2', r5.code === EXIT.INTERNAL, `code=${r5.code}`)

    // ⑥ 覆盖工作树：主仓 + 3 工作树全查（stats.judged ≥ 4）
    const multi = mkrepo()
    const wts = [addWorktree(multi, 'w0'), addWorktree(multi, 'w1'), addWorktree(multi, 'w2')]
    const r6 = judge(multi)
    ck('主仓 + 3 工作树共 4 条路径全被判到 ⇒ 0', r6.code === EXIT.CLEAN && r6.stats.judged >= 4, `code=${r6.code} judged=${r6.stats.judged}`)

    // ⑦ 本单真实故障场景：主仓坏、人站在好工作树里 ⇒ 仍必须红并点名主仓
    //
    // ⚠️ 实测反直觉事实：`core.bare` 在**共享的 `.git/config`** 里 ⇒ 在任何工作树里
    //    `git config core.bare true` 改的都是同一个值，而 `rev-parse --is-bare-repository`
    //    的回答按各 checkout 自己的 work tree 状态给：**主仓 true / 工作树 false**。
    //    ⇒ 断言只能是「至少一处报 bare 且点名主仓」，不能写成「精确点名某个工作树」。
    setBare(multi, true)
    const r7 = runCli(['--repo', wts[1]])
    ck('主仓坏而人站在好工作树里 ⇒ exit 1 且点名主仓', r7.code === EXIT.VIOLATION && r7.out.includes(multi), `code=${r7.code} 含主仓=${r7.out.includes(multi)}`)
    setBare(multi, false)

    // ⑦b B2 射程回归：**别的工作树**有暂存删除，不应把当前 tree 判红。
    //     否则 149 个工作树里只要有一张单在做，判据就恒红 ⇒ 等于没有判据（实测踩过）。
    const scopeMain = mkrepo()
    const scopeOther = addWorktree(scopeMain, 'scope')
    fs.rmSync(path.join(scopeOther, 'keep.mjs'))
    g(scopeOther, 'add', '-A') // 在**别的**工作树里制造暂存删除
    const r7b = runCli(['--repo', scopeMain])
    ck('别的工作树有暂存删除 ⇒ 当前树仍 exit 0（B2 只扫当前 checkout）', r7b.code === EXIT.CLEAN, `code=${r7b.code} ${r7b.out.trim()}`)
    // 但当前树自己有，必须红
    fs.rmSync(path.join(scopeMain, 'keep.mjs'))
    g(scopeMain, 'add', '-A')
    const r7c = runCli(['--repo', scopeMain])
    ck('当前树自己有暂存删除 ⇒ exit 1', r7c.code === EXIT.VIOLATION, `code=${r7c.code}`)

    // ⑧ --json 形状可机读，且带出路径
    const r8 = runCli(['--json', '--repo', bad])
    let parsed = null
    try {
      parsed = JSON.parse(r8.out)
    } catch {
      /* 下面断言会报 */
    }
    ck(
      '--json ⇒ 可解析且 findings 带 path',
      r8.code === EXIT.VIOLATION && parsed && parsed.code === EXIT.VIOLATION && parsed.findings.some((f) => f.path === realDir(bad)),
      `code=${r8.code} json=${parsed ? 'ok' : 'parse-fail'}`,
    )
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

  console.log(`\n  ${fail === 0 ? '✓' : '✗'} 自检 ${pass}/${pass + fail} 通过（正常 6 · 反例 9 · 判不了 2；其中 B2 豁免 6 例）`)
  return fail === 0 ? EXIT.CLEAN : EXIT.VIOLATION
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest()

  const ri = argv.indexOf('--repo')
  const root = ri >= 0 ? argv[ri + 1] : DEFAULT_ROOT
  if (ri >= 0 && !root) {
    console.error('✗ 判不了：--repo 后面要跟一个目录')
    return EXIT.INTERNAL
  }
  const r = judge(root)

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ code: r.code, findings: r.findings, unjudged: r.unjudged ?? null, warnings: r.warnings ?? [], stats: r.stats }, null, 2))
    return r.code
  }

  if (r.code === EXIT.INTERNAL) {
    console.error(`✗ 判不了：${r.unjudged}`)
    console.error(`  （判不了不当绿：这条判据没在判，不是"没问题"）`)
    return r.code
  }
  // 不判红的告警（坏账 / 清单有问题）走 stderr，**不改变退出码**。
  for (const w of r.warnings ?? []) console.error(`⚠ ${w}`)
  if (r.unjudged) console.error(`⚠ 有路径没判成（不计入红绿，需人工看）：${r.unjudged}`)
  if (r.code === EXIT.CLEAN) {
    console.log(`✓ ${r.stats.judged} 个 checkout 都不是 bare、无已暂存误删（主 checkout + ${r.stats.checkouts - 1} 个工作树）`)
    return r.code
  }
  console.error(`✗ 发现 ${r.findings.length} 处违规：`)
  for (const f of r.findings) console.error(`  [${f.rule}] ${f.message}`)
  console.error(`\n  修复：`)
  for (const f of r.findings) console.error(`    ${f.fix}`)
  console.error(`  修完确认：git -C <路径> rev-parse --is-bare-repository   # 应为 false`)
  return r.code
}

// 入口守卫：用 realpath 两侧归一，避免经软链路径调用时 `import.meta.url`（真路径）
// 与 `process.argv[1]`（链接路径）不相等 ⇒ 主逻辑整段不执行却报绿。
function invokedDirectly() {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    return fs.realpathSync(arg) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return path.resolve(arg) === fileURLToPath(import.meta.url)
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2))
}
