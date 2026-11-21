#!/usr/bin/env node
// scripts/install-hooks.test.mjs —— 安装器 + 判据的端到端验证（ISS-718）
//
// 为什么必须真子进程 + 真 git 仓库：本文件全部价值在「git 配置到底写成了什么」。
// 纯函数单测看不见 `git config` 的真实行为，而「配了但没生效 / 生效了但指错」正是本单要防的
// 那类**静默失效**。所以每个用例都在 `mkdtempSync` 造的临时仓库里跑真 git。
//
// 被 `guard-baselines.sh` 的 `scripts/*.test.mjs` 那一格自动扫到（扫目录，不点名）。
//
// 用例分工：
//   安装器面（--postinstall 永不非零 / 装 / 幂等 / 不覆盖别人 / CI 只报不改 / 目录残缺不冒充成功）
//   判据面（verify-hooks-installed 三态：0 干净 / 1 违规 / 2 判不了）
//   变异面（把 core.hooksPath 改成错的 ⇒ 判据必须红；把判据的比对拆掉 ⇒ 自检必须红）
import { describe, expect, test, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER = path.join(ROOT, 'scripts', 'install-hooks.mjs')

// ⛔ P0（ISS-723）：本文件在临时仓库里跑 init/add/commit/config，**必须**剥掉继承来的 GIT_*。
//   `git commit` 跑钩子 / 钩子跑门禁时环境里带着 GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE，
//   而这些**优先于 cwd** ⇒ `git init .` 会初始化到真实仓库，随后 `add -A` / `commit -m init`
//   把真仓 HEAD 与索引摧毁（ISS-723 实测 2783 → 5）。
//   与 pre-commit 的 git_isolated()、verify-hooks-installed 的 cleanEnv() 同一教训。
const GIT_ENV_CLEAN = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k]
  return e
})()

/** 统一的 git 调用口：永远剥 GIT_*。新增调用一律用它，不要直接 execFileSync。 */
const gitAt = (cwd, args, opts = {}) =>
  execFileSync('git', args, { cwd, env: GIT_ENV_CLEAN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const GATE = path.join(ROOT, 'scripts', 'gates', 'verify-hooks-installed.mjs')
const HOOKS = ['commit-msg', 'pre-commit', 'pre-push', 'reference-transaction']

const made = []
afterEach(() => {
  for (const d of made.splice(0)) {
    // 有的用例故意把 .git 设成只读（造必失败），先放开才删得掉
    try {
      fs.chmodSync(path.join(d, '.git'), 0o755)
    } catch {
      /* 没这层就算了 */
    }
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* 清不掉不影响结论 */
    }
  }
})
const trap = (d) => (made.push(d), d)

/** 最小仓库：三个钩子齐全可执行 + 已提交初始快照。`opts.hooks=false` 造残缺检出。 */
function mkRepo({ hooks = true, mode = 0o755 } = {}) {
  const dir = trap(fs.mkdtempSync(path.join(os.tmpdir(), 'ih-')))
  if (hooks) {
    const d = path.join(dir, 'scripts', 'git-hooks')
    fs.mkdirSync(d, { recursive: true })
    for (const h of HOOKS) fs.writeFileSync(path.join(d, h), '#!/bin/sh\nexit 0\n', { mode })
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"probe","private":true}\n')
  const g = (...a) => gitAt(dir, a)
  g('init', '-q', '.')
  g('config', 'user.email', 'probe@example.invalid')
  g('config', 'user.name', 'probe')
  g('add', '-A')
  g('commit', '-q', '-m', 'init (ISS-1)')
  return dir
}

/** 跑安装器。`script` 允许换跑判据（两者对同一份状态的结论必须一致）。 */
function run(cwd, args = [], env = {}, script = INSTALLER) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const getHooksPath = (cwd) => spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd, encoding: 'utf8' }).stdout.trim()
const allRows = (cwd) =>
  (spawnSync('git', ['config', '--show-origin', '--show-scope', '--get-all', 'core.hooksPath'], { cwd, encoding: 'utf8' }).stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)

// ─────────────────────────────────────────────────────────────────────────────
// 一、安装器：核心行为
// ─────────────────────────────────────────────────────────────────────────────
describe('install-hooks：装得上', () => {
  test('① 未设置 ⇒ 设成相对路径 scripts/git-hooks（不是绝对路径）', () => {
    const repo = mkRepo()
    expect(getHooksPath(repo)).toBe('') // 前提：新克隆就是这个状态
    const r = run(repo, ['--postinstall'])
    expect(r.code).toBe(0)
    expect(getHooksPath(repo)).toBe('scripts/git-hooks') // **相对**，与既有约定一致
    expect(allRows(repo)).toHaveLength(1) // 只写了一条，没重复
  })

  test('② 装完钩子真的会被 git 调用（配置对了 ≠ 闸挂上了）', () => {
    const repo = mkRepo()
    const marker = path.join(trap(fs.mkdtempSync(path.join(os.tmpdir(), 'ih-mk-'))), 'fired')
    fs.writeFileSync(
      path.join(repo, 'scripts', 'git-hooks', 'commit-msg'),
      `#!/bin/sh\necho fired >> ${JSON.stringify(marker)}\nexit 0\n`,
      { mode: 0o755 }
    )
    expect(run(repo, ['--postinstall']).code).toBe(0)
    gitAt(repo, ['commit', '--allow-empty', '-q', '-m', 'x'], { stdio: 'ignore' })
    expect(fs.readFileSync(marker, 'utf8')).toContain('fired')
  })

  test('③ 幂等：连跑两次，第二次不重复写、不报错', () => {
    const repo = mkRepo()
    expect(run(repo, ['--postinstall']).code).toBe(0)
    const first = allRows(repo)

    const second = run(repo, ['--postinstall'])
    expect(second.code).toBe(0)
    expect(second.out).toContain('已装') // 认出来了，不是"又写了一遍"
    expect(allRows(repo)).toEqual(first) // 配置逐字未变

    const third = run(repo, ['--postinstall']) // 第三次也一样
    expect(third.code).toBe(0)
    expect(allRows(repo)).toEqual(first)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、安装器：不许做的事
// ─────────────────────────────────────────────────────────────────────────────
describe('install-hooks：不越界', () => {
  test('④ 已指向同目录（写成绝对路径）⇒ 不重写、exit 0（比的是解析后目录）', () => {
    const repo = mkRepo()
    const abs = path.join(repo, 'scripts', 'git-hooks')
    gitAt(repo, ['config', 'core.hooksPath', abs], { stdio: 'ignore' })

    const r = run(repo, ['--postinstall'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('已装')
    expect(getHooksPath(repo)).toBe(abs) // 原样不动，不被"纠正"成相对路径
    expect(allRows(repo)).toHaveLength(1)
  })

  test('⑤ 已指向别人的 husky ⇒ 一个字不改（所有权保护）', () => {
    const repo = mkRepo()
    fs.mkdirSync(path.join(repo, '.husky'))
    fs.writeFileSync(path.join(repo, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    gitAt(repo, ['config', 'core.hooksPath', '.husky'], { stdio: 'ignore' })

    const r = run(repo, ['--postinstall'])
    expect(r.code).toBe(0) // postinstall 永不非零
    expect(r.out).toContain('已被占用')
    expect(getHooksPath(repo)).toBe('.husky') // 没抢
    expect(allRows(repo)).toHaveLength(1)
  })

  test('⑥ --force 才覆盖，且覆盖后指向我们（不是把保护删掉的假修复）', () => {
    const repo = mkRepo()
    gitAt(repo, ['config', 'core.hooksPath', '.husky'], { stdio: 'ignore' })
    const r = run(repo, ['--force'])
    expect(r.code).toBe(0)
    expect(getHooksPath(repo)).toBe('scripts/git-hooks')
  })

  test('⑦ CI=true ⇒ 只报不改', () => {
    const repo = mkRepo()
    const r = run(repo, ['--postinstall'], { CI: 'true' })
    expect(r.code).toBe(0)
    expect(getHooksPath(repo)).toBe('') // 一个字没写
    expect(allRows(repo)).toEqual([])
  })

  test('⑧ scripts/git-hooks/ 不存在 ⇒ 判不了（exit 2），不冒充成功', () => {
    const repo = mkRepo({ hooks: false })
    const r = run(repo)
    expect(r.code).toBe(2) // 判不了，不是 0（假绿）也不是 1（假红）
    expect(r.out).toContain('判不了')
    expect(getHooksPath(repo)).toBe('') // 判不了就不动手
  })

  test('⑨ postinstall 模式下任何失败也 exit 0（否则 bun install 整体失败）', () => {
    const repo = mkRepo({ hooks: false }) // 残缺检出：必然失败
    const r = run(repo, ['--postinstall'])
    expect(r.code).toBe(0) // 硬纪律
    expect(r.out).toContain('不影响依赖安装')
  })

  test('⑩ 执行位丢失 ⇒ 补回；补不了要出声（有钩子不生效是最坏形态）', () => {
    const repo = mkRepo({ mode: 0o644 }) // 全都不带执行位
    const r = run(repo, ['--postinstall'])
    expect(r.code).toBe(0)
    for (const h of HOOKS) fs.accessSync(path.join(repo, 'scripts', 'git-hooks', h), fs.constants.X_OK) // 真的补回来了
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、判据：三态 + 变异必须变红
// ─────────────────────────────────────────────────────────────────────────────
describe('verify-hooks-installed：三态', () => {
  test('⑪ 装好了 ⇒ 0', () => {
    const repo = mkRepo()
    expect(run(repo, ['--postinstall']).code).toBe(0) // 先装上
    const r = run(repo, ['--check'], {}, GATE)
    expect(r.code).toBe(0)
  })

  test('⑫ **变异**：装好后把 core.hooksPath 改成错的 ⇒ 判据必须红（exit 1）', () => {
    const repo = mkRepo()
    expect(run(repo, ['--postinstall']).code).toBe(0)
    expect(run(repo, ['--check'], {}, GATE).code).toBe(0) // 变异前绿

    gitAt(repo, ['config', 'core.hooksPath', '.husky'], { stdio: 'ignore' }) // ← 变异
    const r = run(repo, ['--check'], {}, GATE)
    expect(r.code).toBe(1) // 必须红
    expect(r.out).toContain('.husky') // 且点名旧值，不许只说"不对"
  })

  test('⑬ **变异**：未设置 ⇒ 判据红', () => {
    const repo = mkRepo()
    const r = run(repo, ['--check'], {}, GATE)
    expect(r.code).toBe(1)
    expect(r.out).toContain('未设置')
  })

  test('⑭ **变异**：钩子文件缺一个 ⇒ 判据红（开关对但目录不全 = 假绿）', () => {
    const repo = mkRepo()
    expect(run(repo, ['--postinstall']).code).toBe(0)
    fs.rmSync(path.join(repo, 'scripts', 'git-hooks', 'pre-push'))
    const r = run(repo, ['--check'], {}, GATE)
    expect(r.code).toBe(1)
    expect(r.out).toContain('pre-push')
  })

  test('⑮ **变异**：钩子丢了执行位 ⇒ 判据红（git 会静默跳过不可执行的钩子）', () => {
    const repo = mkRepo()
    expect(run(repo, ['--postinstall']).code).toBe(0)
    fs.chmodSync(path.join(repo, 'scripts', 'git-hooks', 'reference-transaction'), 0o644)
    const r = run(repo, ['--check'], {}, GATE)
    expect(r.code).toBe(1)
    expect(r.out).toContain('reference-transaction')
  })

  test('⑯ 判不了不当绿：不在 git 仓库里 ⇒ exit 2', () => {
    const dir = trap(fs.mkdtempSync(path.join(os.tmpdir(), 'ih-nogit-')))
    const r = run(dir, ['--check'], {}, GATE)
    expect(r.code).toBe(2)
    expect(r.out).toContain('判不了')
  })

  test('⑰ 判据自身 --selftest 全绿', () => {
    const r = run(ROOT, ['--selftest'], {}, GATE)
    expect(r.code).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、pre-commit：只查暂存，且**副作用为零**（ISS-721 / ISS-722）
//
// 为什么单列一节：这一节的判据不是「拦得住吗」，是**「跑完之后仓库还是原来的仓库吗」**。
// ISS-722 那次事故里，钩子「拦得住」全过，但它把工作树的 index 覆盖成了 3 个文件、
// 把 core.bare 改成了 true，97 个工作树的 git 一起失效。
// 教训：**只测「拦截生效」不测「副作用为零」，等于放行一切「顺手改仓库」的钩子。**
// 这条断言是元判据 —— 它咬的不只是这一个 bug，是将来任何同类缺陷。
// ─────────────────────────────────────────────────────────────────────────────
const REAL_PRECOMMIT = path.join(ROOT, 'scripts', 'git-hooks', 'pre-commit')

/** 装**真**钩子 + 它依赖的 secret-scan（不复制就无法测真行为）。 */
function mkRepoWithRealPrecommit() {
  const dir = mkRepo()
  fs.copyFileSync(REAL_PRECOMMIT, path.join(dir, 'scripts', 'git-hooks', 'pre-commit'))
  fs.chmodSync(path.join(dir, 'scripts', 'git-hooks', 'pre-commit'), 0o755)
  fs.mkdirSync(path.join(dir, 'scripts', 'baseline'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts', 'secret-scan.mjs'), path.join(dir, 'scripts', 'secret-scan.mjs'))
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'baseline', 'secret-scan-exempt.json'),
    path.join(dir, 'scripts', 'baseline', 'secret-scan-exempt.json')
  )
  const g = (...a) => gitAt(dir, a)
  g('add', '-A')
  g('commit', '-q', '-m', 'wire real hook (ISS-721)')
  // ⚠️ 必须在**接线提交之后**才装钩子，否则这次提交自己就会跑真 pre-commit
  //    （把测试装置的建仓动作也拦一遍，属于测试污染而非被测行为）。
  g('config', 'core.hooksPath', 'scripts/git-hooks')
  return dir
}

const gitOut = (cwd, ...args) =>
  gitAt(cwd, args).trim()

/** 一次提交的完整现场：before/after 的 index 条目数、core.bare、HEAD 树条目数。 */
function commitScene(cwd, fileName, content) {
  fs.writeFileSync(path.join(cwd, fileName), content)
  gitOut(cwd, 'add', fileName)
  // 基准必须在 `git add` **之后**取：一次正常 commit 不改 index 条目总数（只是把
  // 已暂存内容落到 tree），所以「不许动」的对照点是 add 后的那一刻。
  const before = {
    index: gitOut(cwd, 'ls-files').split('\n').filter(Boolean).length,
    bare: gitOut(cwd, 'config', '--get', 'core.bare'),
    head: gitOut(cwd, 'ls-tree', '-r', 'HEAD', '--name-only').split('\n').filter(Boolean).length,
  }
  const r = spawnSync('git', ['commit', '-m', `probe ${fileName} (ISS-721)`], { cwd, encoding: 'utf8' })
  const after = {
    code: r.status,
    index: gitOut(cwd, 'ls-files').split('\n').filter(Boolean).length,
    bare: gitOut(cwd, 'config', '--get', 'core.bare'),
    head: gitOut(cwd, 'ls-tree', '-r', 'HEAD', '--name-only').split('\n').filter(Boolean).length,
  }
  return { before, after, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('pre-commit：副作用为零', () => {
  test('⑱ **元判据**：在 worktree 里提交，index / core.bare 一个都不许动', () => {
    // 为什么必须用 worktree：普通仓里 git 给钩子的 GIT_INDEX_FILE 是**相对**路径
    // （`.git/index`），`cd` 之后就失效了，测不出这个 bug；只有 worktree 场景下
    // 它是**绝对**路径（`.git/worktrees/<n>/index`），才会覆盖真实 index。
    // ISS-722 就是在真实 worktree 里炸的，而我在普通临时仓里手工跑钩子 —— 完全绿。
    const main = mkRepoWithRealPrecommit()
    const wt = path.join(main, '..', `${path.basename(main)}-wt`)
    gitAt(main, ['worktree', 'add', '-q', wt, '-b', 'probe'], { stdio: 'ignore' })
    trap(wt)
    gitAt(wt, ['config', 'core.hooksPath', 'scripts/git-hooks'], { stdio: 'ignore' })

    const { before, after } = commitScene(wt, 'note.txt', 'hello\n')

    expect(after.code).toBe(0) // 干净的暂存内容应当放行
    expect(after.index).toBe(before.index) // index 条目数不许被削（ISS-722 就是被削成 3 条）
    expect(after.bare).toBe('false') // 不许被改成 true
    expect(after.head).toBe(before.head + 1) // HEAD 树只增一个，不是塌成几个文件
  })

  test('⑲ 拦得住的行尾空白：拦下且**不动仓库**', () => {
    const repo = mkRepoWithRealPrecommit()
    const { before, after, out } = commitScene(repo, 'bad.txt', 'trailing here   \n')
    expect(after.code).toBe(1) // 拦下
    expect(out).toContain('trailing whitespace') // 且点名原因
    expect(after.index).toBe(before.index) // 被拦时 index 也不许动
    expect(after.bare).toBe('false')
  })

  test('⑳ 拦得住的密钥：拦下且**不动仓库**', () => {
    const repo = mkRepoWithRealPrecommit()
    const key = `sk-ant-api03-${'C'.repeat(60)}`
    const { before, after, out } = commitScene(repo, 'leak.ts', `const k = "${key}"\n`)
    expect(after.code).toBe(1)
    expect(out).toContain('secret-scan')
    expect(after.index).toBe(before.index)
    expect(after.bare).toBe('false')
  })

  test('㉑ 空暂存（--allow-empty）⇒ 秒过，不空转', () => {
    const repo = mkRepoWithRealPrecommit()
    const t0 = Date.now()
    gitAt(repo, ['commit', '--allow-empty', '-q', '-m', 'empty (ISS-721)'], { stdio: 'ignore' })
    // 2s 是工单红线：慢的 pre-commit 会被 `--no-verify` 练成肌肉记忆，那比没有更糟
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test('㉒ --no-verify 仍能绕过（逃生口不许被锁死）', () => {
    const repo = mkRepoWithRealPrecommit()
    fs.writeFileSync(path.join(repo, 'bypass.txt'), 'trailing here   \n')
    gitOut(repo, 'add', 'bypass.txt')
    const r = spawnSync('git', ['commit', '--no-verify', '-m', 'bypass (ISS-721)'], { cwd: repo, encoding: 'utf8' })
    expect(r.status).toBe(0)
  })
})
