// wt-exclude-lib.mjs —— 「哪些目录是工作树、判据该不该跳过」的**唯一真相源**（ISS-724 第一步）
//
// 为什么单独一份：工作树的落点要搬家（`~/wt/dsh-forge` → 仓内 `.agents/worktrees/`），
// 而排除规则本来分散在 6+ 个判据里各写一份。搬家当天必然漏改 ⇒ 上百棵工作树的源码被当成本仓源码盘点，
// oxlint 基线（3690）当场爆掉。漏一个就是一个洞，而洞的位置不可预测 ⇒ 名单收成一处，判据 import 它。
//
// 口径（ISS-561 的教训，别再犯）：判据一律吃**仓根相对路径**，不吃绝对路径。
// 当年判据拿绝对路径判，于是仓内工作树里「ROOT 自身」就含 `/.wt/` ⇒ 整棵树被跳过、盘点静默归零。
// 所以本文件的入参只接受相对路径；绝对路径由调用方先折（`path.relative(ROOT, abs)`）。
//
// 本文件**不是判据**：没有退出码、不打印、不读盘。它是判据的共用底层。

/**
 * 工作树的**仓根相对目录**清单 —— 唯一真相源。
 * 要加新落点（例如将来搬到 `vendor/worktrees/`）只改这一行，所有判据自动跟上。
 * 元素可以是单段（`.wt`）或多段（`.agents/worktrees`）。
 */
export const WORKTREE_DIRS = ['.wt', '.agents/worktrees']

/** 按 `/` 切段，丢掉空段与 `.`（`./.wt/x` 与 `.wt/x` 等价）。 */
const segments = (p) => String(p ?? '').split('/').filter((s) => s && s !== '.')

const SEGS = WORKTREE_DIRS.map(segments)

/**
 * 相对路径是否落在某棵工作树里（段级匹配，任意深度）。
 *
 * 为什么是**段**而不是子串：`forge-dist/` 不含 `dist` 段但名字里有 `dist`，
 * 子串口径会误杀 —— 同类误杀本仓有过先例（见 code-inventory 的 `forge-dist` 反例用例）。
 *
 * @param {string} relPath 仓根相对路径，`/` 分隔
 * @returns {boolean}
 */
export function isWorktreePath(relPath) {
  const segs = segments(relPath)
  return SEGS.some((t) => {
    for (let i = 0; i + t.length <= segs.length; i++) {
      if (t.every((name, j) => segs[i + j] === name)) return true
    }
    return false
  })
}

/**
 * **单段**落点名（`.wt`），给「按 `e.name` 判目录」的调用点用。
 * ⚠️ 多段落点（`.agents/worktrees`）在名字级判不出来 ⇒ 那类调用点必须改用 `isWorktreePath`，
 *    否则只排掉了 `.wt` 而漏掉 `.agents/worktrees`，正是本单要防的那一半。
 */
export const WORKTREE_DIR_NAMES = WORKTREE_DIRS.filter((d) => !d.includes('/'))

/**
 * 正则形态：给「拿一条正则判相对路径」的判据用（可直接 `new RegExp(a.source + '|' + b.source)`）。
 * 前后都要求路径边界，避免 `x.wt/`、`a.agents/worktrees/` 这类子串误判。
 * ⚠️ 名单为空时必须**永不命中**：空括号会让正则变成 `(^|/)()(/|$)` ⇒ 匹配一切 ⇒
 *    判据把整棵树判成脏、扫描面塌缩（实测 capability 源文件 1319→6、channel 候选 1133→0），
 *    症状与"排除写错"一模一样但方向相反（那边漏扫，这边全扫）。宁可明写 `$^`。
 */
export const WORKTREE_PATH_RE = WORKTREE_DIRS.length
  ? new RegExp(
      '(^|/)(' +
        WORKTREE_DIRS.map((d) => d.split('/').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\/')).join('|') +
        ')(/|$)'
    )
  : /$^/

/**
 * glob 形态：给「按 glob 排除」的判据用（oxlint 的 `ignorePatterns` 就是这一族）。
 * 两段都要：`dir/**` 排仓根处的落点，`**` + `/` + `dir/**` 排任意深度的落点。
 */
export const WORKTREE_IGNORE_GLOBS = WORKTREE_DIRS.flatMap((d) => [`${d}/**`, `**/${d}/**`])
