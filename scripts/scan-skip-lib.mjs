/**
 * 扫描排除判据（ISS-561 / ISS-724）—— `code-inventory` 的「哪些文件不算本仓源码」。
 *
 * 从 `scripts/code-inventory.mjs` 搬出（ISS-772）：判据本体与它的正反控制自检放在同一处，
 * 改判据的人必然看见用例。⚠️ 判据只许吃**仓根相对路径**（吃绝对路径会让工作树整棵被跳过，实测盘点归零）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WORKTREE_PATH_RE } from './wt-exclude-lib.mjs' // ISS-724：工作树落点的唯一真相源

/* ISS-561：排除判据只许吃**仓根相对路径**。
   旧写法 `SKIP_PATH.test(p)` 吃的是绝对路径 ⇒ 在仓内工作树（`<主仓>/.wt/ISS-xxxx`，本机沙箱下唯一可用落点）
   里 ROOT 自身就含 `/.wt/`，于是**整棵树被跳过、盘点静默归零**（实测源文件 831 → 69、角色表 34 行全 0）。 */
/* ISS-724：工作树落点由共享名单给出（`.wt` 与 `.agents/worktrees` 都在里面）。
   为什么不能只靠上面的 `SKIP_DIR`（**按名字**判）：`.agents/worktrees` 是**两段**，
   名字级判据看不出它是工作树 ⇒ 搬家后会漏掉整整一个池子，盘点把上百棵树当本仓源码。 */
const SKIP_PATH = new RegExp(
  `(^|/)(node_modules|dist|out)/|${WORKTREE_PATH_RE.source}`
)

/** 判据本体（正反控制见 `--selftest-skip`） */
export const skipPath = (relPath) => SKIP_PATH.test(relPath)
/** **唯一允许触碰绝对路径的地方**：先折成仓根相对路径再判。
    抽成函数是为了让自测能直接喂「ROOT 自身含 `/.wt`」的场景（磁盘上造不出来），见 `--selftest-skip`。 */
export const skipAbs = (root, absPath) => skipPath(path.relative(root, absPath).split(path.sep).join('/'))

/** ISS-561 selftest：排除判据的**正反控制**。
    `cases` 钉判据语义；`live` 钉**调用点**（ROOT 自身在 `.wt` 工作树里的那一刀 —— 当年正是它让盘点归零）。 */
export function selftestSkip({ walk }) {
  const cases = [
    ['forge-pm/src/index.ts', false, '包内正常文件不许被排除'],
    ['.wt/ISS-561/forge-pm/src/index.ts', true, '仓根下的工作树仍要排（别把工作树的源码当本仓源码盘点）'],
    ['forge-pm/node_modules/foo/index.js', true, '依赖目录'],
    ['forge-pm/dist/a.ts', true, '产物目录'],
    ['forge-dist/src/a.ts', false, '名字含 dist 但不是路径段 ⇒ 不许误杀（子串误判控制）'],
    /* ISS-724：新落点 `.agents/worktrees` 是**两段**，名字级判据（SKIP_DIR）看不出来 —— 必须由路径判据兜住。
       少了这一条，搬家当天整整一个池子（50 棵树）会被当成本仓源码盘点。 */
    ['.agents/worktrees/ISS-1/forge-pm/src/index.ts', true, '新落点（两段）也要排'],
    ['forge-pm/.agents/worktrees/a/b.ts', true, '任意深度的新落点也要排'],
    ['.agents/skills/reviewer/SKILL.md', false, '`.agents/` 下非工作树（skills）不许被误杀'],
    ['a.agents/worktrees/b.ts', false, '子串相似但不含该路径段 ⇒ 不许误杀'],
  ]
  const live = [
    ['/x/dsh-forge/.wt/ISS-1', '/x/dsh-forge/.wt/ISS-1/forge-pm/src/index.ts', false, 'ROOT 在仓内工作树里：包内文件不许被排除（归零那一刀的回归线）'],
    ['/x/dsh-forge/.wt/ISS-1', '/x/dsh-forge/.wt/ISS-1/forge-pm/node_modules/a/index.js', true, '同上根，依赖目录仍要排'],
    ['/x/dsh-forge', '/x/dsh-forge/.wt/ISS-1/forge-pm/src/index.ts', true, '仓根下的工作树仍要排'],
    ['/x/dsh-forge', '/x/dsh-forge/forge-pm/src/index.ts', false, '普通根不变'],
  ]
  const fails = cases.filter(([p, want]) => skipPath(p) !== want)
  const failsLive = live.filter(([root, p, want]) => skipAbs(root, p) !== want)
  for (const [p, want] of fails) console.error(`  ✗ 判据「${p}」：期望 ${want ? '排除' : '保留'}`)
  for (const [root, p, want] of failsLive) console.error(`  ✗ 调用点「${root} + ${p}」：期望 ${want ? '排除' : '保留'}`)
  /* 端到端（落盘 fixture）：ROOT **自身**在 `.wt` 工作树里时，**真 walk** 必须还看得见包内文件。
     上面两组都是"谓词级"，钉不住调用点喂的是相对还是绝对路径（审查 low-1）—— 这一条钉得住。 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-skip-'))
  const fakeRoot = path.join(tmp, '.wt', 'ISS-1')
  fs.mkdirSync(path.join(fakeRoot, 'forge-pm', 'src'), { recursive: true })
  fs.writeFileSync(path.join(fakeRoot, 'forge-pm', 'src', 'index.ts'), '')
  fs.mkdirSync(path.join(fakeRoot, 'forge-pm', 'node_modules', 'a'), { recursive: true })
  fs.writeFileSync(path.join(fakeRoot, 'forge-pm', 'node_modules', 'a', 'index.js'), '')
  const e2eGot = walk(path.join(fakeRoot, 'forge-pm'), [], fakeRoot).map((x) => path.relative(fakeRoot, x).split(path.sep).join('/'))
  fs.rmSync(tmp, { recursive: true, force: true })
  const e2eWant = ['forge-pm/src/index.ts']
  const e2eOk = JSON.stringify(e2eGot) === JSON.stringify(e2eWant)
  if (!e2eOk) console.error(`  ✗ 端到端（ROOT 在 .wt 里）：期望 [${e2eWant}]，实得 [${e2eGot}]`)
  const total = cases.length + live.length + 1, ok = total - fails.length - failsLive.length - (e2eOk ? 0 : 1)
  console.log(`code-inventory --selftest-skip ${ok}/${total} 通过（判据 ${cases.length} + 调用点 ${live.length} + 端到端 1）`)
  return fails.length === 0 && failsLive.length === 0 && e2eOk ? 0 : 2
}
