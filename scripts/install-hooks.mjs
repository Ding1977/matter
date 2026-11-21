#!/usr/bin/env node
// scripts/install-hooks.mjs —— 让 `core.hooksPath` 可复现（ISS-718 · L1 编排层）
//
// ── 为什么需要这个文件 ────────────────────────────────────────────────
// 钩子脚本本身**在版本库里**（`scripts/git-hooks/{commit-msg,pre-commit,pre-push,reference-transaction}`），
// 但让 git 去那个目录找钩子的开关 `core.hooksPath` 是**本仓局部配置、不进版本库**。
// 后果不是"闸不严"，是**闸不在而你以为它在** —— 新克隆 / 电脑2 / 任何新工作树，
// `git commit` 与 `git push` 都不会被拦，且没有任何东西会报这个状态。
// 本文件把这个开关补上，由 `package.json` 的 `postinstall` 在 `bun install` 时自动跑。
//
// ── 两种调用模式（这个区分是硬约束，别合并）──────────────────────────
//   `--postinstall`（package.json 调）：**任何路径都 exit 0**。
//       实测 bun 的 postinstall 返回非零会让 `bun install` 整体失败
//       （`error: postinstall script from "x" exited with 2`，bun install rc=2）
//       ⇒ 装钩子是锦上添花，绝不许升级成「依赖装不上、机器起不来」。
//   不带参数（人手工调 / 判据调）：三态退出码 `0 干净 / 1 违规 / 2 判不了`，
//       与 `scripts/gates/README.md` §一 的口径一致。
//
//   ⚠️ 为什么不靠环境变量自动识别「我是不是 postinstall 里跑的」：
//      实测 bun 1.3.14 下 `npm_lifecycle_event` **是空的**（`(unset)`），
//      `process.stdout.isTTY` 在两条路径上都可能是 false ⇒ 推断不可靠。
//      所以由 package.json 显式传 `--postinstall`，不猜。
//
// ── 三条纪律 ──────────────────────────────────────────────────────────
//   1. **不覆盖别人的**。`core.hooksPath` 已被设成别的目录（husky / lefthook / 手工），
//      默认**一个字不动**，只把旧值与新值都报出来；要改必须显式 `--force`。
//      抢过来 = 静默拆掉别人正在用的闸。
//   2. **只写 local 层 + 只写相对路径**。相对值由 git 按**各工作树自己的根**解析（实测：
//      主树解析到主树的 `scripts/git-hooks`，工作树解析到工作树自己那份）⇒ 一个值覆盖
//      全部工作树，每棵树各用自己那份。不要改成绝对路径，也不要上
//      `extensions.worktreeConfig` + `--worktree`（那是为「每棵树配不同钩子目录」设计的，
//      我方没这需求，而它会改 `.git/config` 的格式扩展）。
//   3. **判据比解析后的真实目录，不比字符串**。绝对路径写法同样合法，只比字面会把
//      装好的闸报成没装（误报比不报更坏）。
//
// 用法：
//   node scripts/install-hooks.mjs                 # 查/装（人手工）
//   node scripts/install-hooks.mjs --postinstall   # postinstall 模式（永不非零）
//   node scripts/install-hooks.mjs --force         # 允许覆盖已指向别处的值
//   CI=true node scripts/install-hooks.mjs         # CI：只报不改
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 仓库相对路径 = 与 `scripts/git-hooks/` 的既有约定，别改成绝对路径。 */
const HOOKS_PATH_VALUE = 'scripts/git-hooks'
/**
 * 四个钩子必须都在。少一个就是「钩子目录不完整」，装上去只会变成假绿。
 * ⚠️ 这份清单是**唯一来源**：`scripts/gates/verify-hooks-installed.mjs` 从这里 import 后
 *    只做「比名字」的补充（见该文件头注），不要在判据里另抄一份 —— 两处各写一份就等于
 *    同一条规则有两个答案，某天加了钩子只改一边，判据会理直气壮地判绿。
 * ISS-721 加 `pre-commit`：官方 pre-commit 那 6 个 job 里能搬的 3 类落在了这个文件里。
 */
const HOOKS = ['commit-msg', 'pre-commit', 'pre-push', 'reference-transaction']
export { HOOKS }

const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

const log = (m) => console.log(`[git-hooks] ${m}`)
const warn = (m) => console.error(`[git-hooks] ⚠️ ${m}`)

/** 跑 git，**从不抛**：判据脚本里任何 crash 都该走 `2 判不了`，不是异常栈。
 *
 *  ⛔ P0（ISS-723）：必须剥掉继承来的 `GIT_*` 再跑。
 *     `git commit` 跑钩子 / 钩子再跑门禁时，环境里带着 `GIT_DIR` / `GIT_INDEX_FILE` /
 *     `GIT_WORK_TREE`，而它们**优先于 `cwd`**。于是 `git(cwd=临时仓, ['config', ...])`
 *     会读写**真实仓库**的 config —— 判据测的是真仓，结论却是临时仓的，双向都是错的。
 *     与 pre-commit 的 `git_isolated()` 同一教训（ISS-722 遗留面）。
 */
function cleanGitEnv() {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k]
  return e
}

function git(cwd, args) {
  try {
    const out = execFileSync('git', args, { cwd, env: cleanGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
    return { ok: true, out: out.trim() }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim(), code: e.status ?? null }
  }
}

/** 解析成真实目录；解析不了返回 ''（调用方必须把它当「判不了」，不许当「不相等」）。 */
function realDir(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return ''
  }
}

/** 仓库根；不在仓库里返回 ''。 */
function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).out
}

/**
 * 探当前状态，**只读不写**。返回：
 *   { status, ... }  status: 'ok' | 'unset' | 'wrong' | 'unjudged'
 * 判据脚本与本文件的写入路径共用这一个函数 —— 两处各写一份判据等于同一条规则有两个答案。
 */
export function inspect({ root = '' } = {}) {
  const repo = root || repoRoot(process.cwd())
  if (!repo) return { status: 'unjudged', reason: '不在 git 仓库里（或 git 不可用）' }

  const wantDir = realDir(path.join(repo, HOOKS_PATH_VALUE))
  if (!wantDir) return { status: 'unjudged', reason: `${HOOKS_PATH_VALUE}/ 不存在，判不了「指向对不对」` }

  const missing = HOOKS.filter((h) => !fs.existsSync(path.join(repo, HOOKS_PATH_VALUE, h)))
  const notExec = HOOKS.filter((h) => {
    const f = path.join(repo, HOOKS_PATH_VALUE, h)
    if (!fs.existsSync(f)) return false
    try {
      fs.accessSync(f, fs.constants.X_OK)
      return false
    } catch {
      return true
    }
  })

  const cur = git(repo, ['config', '--get', 'core.hooksPath']).out
  const curDir = cur ? realDir(path.isAbsolute(cur) ? cur : path.join(repo, cur)) : ''

  return {
    status: !cur ? 'unset' : curDir === wantDir ? 'ok' : 'wrong',
    repo,
    wantDir,
    cur,
    curDir,
    // 以上是「开关」，以下是「开关指向的目录里东西齐不齐」——两者缺一都不是可用状态。
    missing,
    notExec,
  }
}

/**
 * 装。**任何失败都不抛**，用返回值的 status 表达。
 * 返回 { status, ... }  status: 'ok' | 'installed' | 'unset' | 'wrong' | 'unjudged' | 'failed'
 */
export function install({ root = '', force = false, write = true } = {}) {
  const now = inspect({ root })

  if (now.status === 'unjudged') return now
  if (now.missing.length) return { ...now, status: 'failed', reason: `钩子文件缺失：${now.missing.join(' ')}（残缺检出，装了也是假绿）` }

  // 执行位兜底：检出后权限丢失时补回；补不上不算失败（git 会自己跳过不可执行的钩子，
  // 但那正是「有钩子不生效」的静默形态，所以要说出来）。
  if (now.notExec.length && write) {
    for (const h of now.notExec) {
      try {
        fs.chmodSync(path.join(now.repo, HOOKS_PATH_VALUE, h), 0o755)
      } catch {
        /* 下面统一报 */
      }
    }
    log(`已补执行位：${now.notExec.join(' ')}`)
  }

  if (now.status === 'ok') return { ...now, status: 'ok' }

  // 已指向别处 ⇒ 默认不动。这是所有权保护，不是失败：别人可能挂着 husky/lefthook。
  if (now.status === 'wrong' && !force) return { ...now, status: 'wrong' }
  if (!write) return now

  // 写入：local 层、相对路径。
  const scopeArgs = ['config', 'core.hooksPath', HOOKS_PATH_VALUE]
  const wrote = git(now.repo, scopeArgs)
  if (!wrote.ok) return { ...now, status: 'failed', reason: `写入失败：${wrote.out}` }

  // 写完回读：确认「解析后的目录」与「没有半装状态」。不符即撤销，不留垃圾。
  const after = inspect({ root: now.repo })
  if (after.status !== 'ok') {
    const prev = now.cur
    if (prev) git(now.repo, ['config', 'core.hooksPath', prev])
    else git(now.repo, ['config', '--unset-all', 'core.hooksPath'])
    return { ...after, status: 'failed', reason: `写完回读不符（实际 '${after.cur}'），已撤销` }
  }
  return { ...after, status: 'installed' }
}

/** 一条人能直接照抄的修复命令（不许让人去翻文档才知道怎么修）。 */
const fixHint = (repo) => `git -C ${repo} config core.hooksPath ${HOOKS_PATH_VALUE}`

function main(argv) {
  const postinstall = argv.includes('--postinstall')
  const force = argv.includes('--force')
  const ci = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
  const dryRun = ci || process.env.DRY_RUN === '1'

  const r = install({ force, write: !dryRun })

  // ── postinstall 模式：**结论只有一种退出码** ──────────────────────────
  if (postinstall) {
    if (r.status === 'ok') return log(`已装：core.hooksPath=${HOOKS_PATH_VALUE}`)
    if (r.status === 'installed') return log(`已写 core.hooksPath=${HOOKS_PATH_VALUE}（local 层，各工作树各自解析）`)
    if (r.status === 'wrong')
      return warn(`core.hooksPath 已被占用：'${r.cur}'（未覆盖，可能是 husky/lefthook 在管）—— 要让本仓用自己的钩子：git config --unset core.hooksPath`)
    warn(`装钩子未完成（不影响依赖安装，钩子没接上而已）：${r.reason ?? r.status}`)
    if (r.repo) warn(`  手工修：${fixHint(r.repo)}`)
    return undefined // 落回 0，见文件尾部
  }

  // ── 手工 / 判据模式：三态 ────────────────────────────────────────────
  if (r.status === 'unjudged') {
    warn(`判不了：${r.reason}`)
    return EXIT.INTERNAL
  }
  if (r.status === 'failed') {
    warn(r.reason)
    return EXIT.VIOLATION
  }
  if (r.status === 'ok') {
    const exec = r.notExec.length ? ` · ⚠️ 缺执行位：${r.notExec.join(' ')}` : ''
    log(`已装：core.hooksPath=${r.cur}${r.cur === HOOKS_PATH_VALUE ? '' : `（解析为 ${r.wantDir}）`}${exec}`)
    return r.notExec.length ? EXIT.VIOLATION : EXIT.CLEAN
  }
  if (r.status === 'wrong') {
    warn(`core.hooksPath 指向别处，**未覆盖**：`)
    warn(`  旧值：'${r.cur}'${r.curDir ? ` → ${r.curDir}` : ''}`)
    warn(`  期望：'${HOOKS_PATH_VALUE}' → ${r.wantDir}`)
    warn(`  要改（确认那个钩子目录可以放弃后）：node scripts/install-hooks.mjs --force`)
    warn(`  或手工：git -C ${r.repo} config core.hooksPath ${HOOKS_PATH_VALUE}`)
    return EXIT.VIOLATION
  }
  if (r.status === 'installed') {
    log(`已写 core.hooksPath=${HOOKS_PATH_VALUE}（local 层，各工作树各自解析）`)
    return EXIT.CLEAN
  }
  // dryRun 且原本 unset：只报没写
  warn(`未设置 core.hooksPath（CI / DRY_RUN 下只报不改）：git -C ${r.repo} config core.hooksPath ${HOOKS_PATH_VALUE}`)
  return EXIT.VIOLATION
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const postinstall = process.argv.includes('--postinstall')
  let code
  try {
    code = main(process.argv.slice(2))
  } catch (e) {
    warn(`安装器自身异常：${e?.message ?? e}`)
    code = postinstall ? EXIT.CLEAN : EXIT.INTERNAL
  }
  // 纪律：postinstall 绝不非零（见文件头「两种调用模式」）。
  process.exitCode = postinstall ? EXIT.CLEAN : (code ?? EXIT.CLEAN)
}
