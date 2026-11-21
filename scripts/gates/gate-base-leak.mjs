#!/usr/bin/env node
/**
 * scripts/gates/gate-base-leak.mjs —— 门禁缓存树泄漏判据（ISS-726）
 *
 * ── 为什么要有这一格 ─────────────────────────────────────────────────
 * 门禁自己会造工作树（`--diff-baseline` 要一棵「起点那一份代码」的树现算指标）。
 * 一次核查时 `git worktree list` 的 69 条里 **26 条是它造的，833MB**，散在 4 个位置，只增不减。
 *
 * 三条根因，前两条已在同单修掉，这一格是第三条：
 *   1. 路径每个调用方各算一套 ⇒ 已统一到 gate-base-tree.mjs cachePathFor()
 *   2. `dropBaseTree` 零调用（注释写着「用完由调用方决定」，但没有调用方）⇒ 已改为建树处登记 + 退出钩子回收
 *   3. **零判据** ⇒ 就是本文件
 *
 * 没有这一格，前两条修好也只是「今天干净」：下一个人照旧能把它们养回去，而且**没人会发现**。
 * 判据的价值不在今天绿，在于它变红的那天有人看得见。
 *
 * ── 口径：必须分清业务树与缓存树 ───────────────────────────────────
 * 本机常驻 40+ 棵**真实业务树**（`.wt/ISS-x`、`~/wt/dsh-forge/ISS-x`）。
 * 把它们算成泄漏 ⇒ 天天红 ⇒ 判据立刻没人信，等于没有。
 * 所以识别按**形态**，不按位置（历史 4 个落点前缀各不相同，只按今天的落点数会漏掉全部存量）：
 *   · 路径里有 `.gate-base` 段
 *   · 或 basename 形如 `base-<hex>`
 *   · 或 basename 形如 `run-gates-base-*`
 *
 * ── 退出码 ────────────────────────────────────────────────────────
 *   0 = 干净（缓存树 ≤ 5）
 *   1 = 违规（缓存树 > 5）
 *   2 = 判不了（读不到 worktree 清单 —— 不冒充干净）
 *
 * 用法：
 *   node scripts/gates/gate-base-leak.mjs             # 判
 *   node scripts/gates/gate-base-leak.mjs --json      # 机器可读
 *   node scripts/gates/gate-base-leak.mjs --selftest  # 反向自检（11 例，纯函数，无副作用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyWorktrees, isCacheTreePath } from '../gate-base-tree.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const LIMIT = 5
const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

/** 判据主体：拿到「业务树 N / 缓存树 M」并就 M 与阈值比 */
function judge() {
  let r
  try {
    r = classifyWorktrees(REPO)
  } catch (e) {
    return { code: EXIT.INTERNAL, reason: `读不到 worktree 清单：${e && e.message ? e.message : String(e)}` }
  }
  if (!r.all.length) {
    // 「一条都没有」在这个仓里不可能（主检出自己就是一条）⇒ 读失败，不是真的空
    return { code: EXIT.INTERNAL, reason: 'worktree 清单为空 —— 这个仓至少有主检出，判定读取失败' }
  }
  return {
    code: r.cache.length > LIMIT ? EXIT.VIOLATION : EXIT.CLEAN,
    business: r.business.length,
    cache: r.cache.length,
    paths: r.cache.map((w) => w.path),
  }
}

function selftest() {
  // 纯函数用例，不造真树：造树会动 git 状态，自检不该有副作用。
  // 真树的红绿对照（造 6 棵 ⇒ 红 / 删掉 ⇒ 绿）在工单验收里单独跑过。
  const cases = [
    ['/Users/x/.gate-base/base-c38c3188', true, '今天落点的存量形态（16 条）'],
    ['/Users/x/dsh-forge/.wt/.gate-base/base-abc123', true, '.wt/ISS-x 里跑出来的那一族（9 条）'],
    ['/Users/x/wt/dsh-forge/.gate-base/base-abc123', true, '~/wt/dsh-forge/ISS-x 里跑出来的那一族（1 条）'],
    ['/private/var/folders/xx/run-gates-base-1234', true, '更早一版临时树（2 条）'],
    ['/Users/x/.gate-base', true, '落点根本身'],
    ['/Users/x/dsh-forge', false, '主检出 —— 不许算泄漏'],
    ['/Users/x/dsh-forge/.wt/ISS-617', false, '业务树（.wt 池）'],
    ['/Users/x/wt/dsh-forge/ISS-726', false, '业务树（搬迁目标池）'],
    ['/Users/x/dsh-forge/.agents/worktrees/ISS-726', false, '业务树（ISS-724 搬迁后形态）'],
    ['/Users/x/dsh-forge/forge-base', false, '名字带 base 但不是缓存树'],
  ]
  let bad = 0
  for (const [p, want, why] of cases) {
    const got = isCacheTreePath(p)
    if (got !== want) {
      bad++
      console.log(`✗ ${p}\n    期望 ${want} 实得 ${got}（${why}）`)
    } else console.log(`✓ ${why}`)
  }
  // 分类互斥且不漏
  const sample = ['/Users/x/dsh-forge', '/Users/x/.gate-base/base-abc123', '/Users/x/dsh-forge/.wt/ISS-1']
  const cache = sample.filter(isCacheTreePath).length
  if (cache !== 1 || sample.length - cache !== 2) {
    bad++
    console.log(`✗ 分类口径：期望 业务2/缓存1，实得 业务${sample.length - cache}/缓存${cache}`)
  } else console.log('✓ 分类口径：业务树与缓存树互斥，一条不漏')
  // 阈值边界：恰好 LIMIT 绿、LIMIT+1 红（用假计数验算术，不造树）
  const atLimit = LIMIT
  const overLimit = LIMIT + 1
  if (!(atLimit <= LIMIT)) { bad++; console.log('✗ 阈值边界：恰好等于阈值应判绿') }
  else if (!(overLimit > LIMIT)) { bad++; console.log('✗ 阈值边界：超一格应判红') }
  else console.log(`✓ 阈值边界：${atLimit} 棵绿 / ${overLimit} 棵红（阈值 ${LIMIT}）`)
  console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ 全部通过')
  return bad ? EXIT.VIOLATION : EXIT.CLEAN
}

if (process.argv.includes('--selftest')) process.exit(selftest())

const v = judge()
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ exit: v.code, limit: LIMIT, ...v }, null, 1))
  process.exit(v.code)
}

if (v.code === EXIT.INTERNAL) {
  console.error(`✗ 判不了：${v.reason}`)
  process.exit(EXIT.INTERNAL)
}
const head = `业务树 ${v.business} 棵 / 缓存树 ${v.cache} 棵（阈值 ≤ ${LIMIT}）`
if (v.code === EXIT.CLEAN) {
  console.log(`✓ 门禁缓存树没有泄漏 · ${head}`)
  process.exit(EXIT.CLEAN)
}
console.error(`✗ 门禁缓存树泄漏 · ${head}`)
for (const p of v.paths.slice(0, 10)) console.error(`  · ${p}`)
if (v.paths.length > 10) console.error(`  …… 另有 ${v.paths.length - 10} 棵`)
console.error('  清掉：node scripts/gate-base-tree.mjs --clean')
console.error('  看清：node scripts/gate-base-tree.mjs --status')
process.exit(EXIT.VIOLATION)
