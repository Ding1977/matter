/**
 * 门禁退出码的**唯一定义**（ISS-832）。
 *
 * 依据：`scripts/gates/README.md` §一 与 `scripts/lib/gate-runtime.ts` 头注。
 *
 * 为什么单独成文件（本单要修的病）：
 *   同一个数字原先在三处各写一遍 —— `gate-runtime.ts:39` 的 `EXIT`、
 *   `run-gates-verdict.mjs` 里的裸 `3`、`gates/README.md` 的表格。
 *   三处各写一遍 = 迟早不一致，而不一致的表现是**静默改口径**（见本文件 isUnjudged 的注释）。
 *
 * ## 两套词表并存的事实（不是设计，是存量）
 *
 *   · **canonical（本常量）**：0 干净 / 1 违规 / 2 判不了。新载体（`.ts` + runGate）走这套。
 *   · **legacy**：部分存量脚本作者已用 **3 = 判不了**（`assembly-diff-check` 一个脚本里
 *     就同时有 `exit(2)` 表违规与 `exit(3)` 表不判）。本文件不改它们的码，只在读侧双认。
 *
 * ⚠️ **双认的边界**：读侧认 {2, 3} 都算判不了。所以任何仍用 `2` 表**违规**的脚本，
 *    要么把那个站点改成 1（本单已改 4 个脚本），要么在它那一格上写 `unjudgedCodes: [3]`
 *    （只认 3 为判不了，2 继续当违规）。**两者都不做 = 把真红洗成第三态。**
 *    `check-pm-suite-twice` 走的是后者：它正被 ISS-833 重写，改脚本会撞车。
 *
 * 这条边界不是纸面约定 —— 本单实测踩到过：双认上线后 `check-pm-suite-twice` 的
 * 「两遍不一致」从红变成「判不了」，靠 `--tier full` 的红项集合差才看出来。
 * 所以**每次放宽读侧，都要跑一遍全档并比对红项集合**，不能只跑 fast。
 */

/** canonical 三态码。**改这里 = 改全仓口径**，三处读者（gate-runtime / run-gates-verdict / README）都跟它走。 */
export const EXIT = { passed: 0, failed: 1, unjudged: 2 }

/** legacy「判不了」码：存量脚本已按它写（不改它们，只在读侧双认）。 */
export const LEGACY_UNJUDGED = 3

/**
 * 「这个退出码算不算判不了」——**读侧唯一入口**，别再散写 `rc === 2 || rc === 3`。
 *
 * @param {number|null|undefined} rc 子进程退出码
 * @param {number[]} [codes] 该格接受的判不了码；缺省 = 双认 {2, 3}
 */
export function isUnjudged(rc, codes) {
  const accepted = Array.isArray(codes) ? codes : [EXIT.unjudged, LEGACY_UNJUDGED]
  return accepted.includes(rc)
}

/**
 * 退出码口径的**权威表格行**。`scripts/gates/README.md` 必须逐字包含它 ——
 * 由 `scripts/gates/verify-exit-codes.ts` 判（数字对不上就红）。
 *
 * 为什么用「整行字符串」而不是「解析 README 里的数字」：
 *   解析数字的判据改个措辞就挂（假红）。整行比对把「措辞」也纳入契约：
 *   要改措辞就同时改这里，`git diff` 里两边都看得见。代价是改文案要动两处 —— 有意如此。
 */
export function exitTableLine() {
  // 数字带反引号 —— 与 README 的排版约定一致（专有名词/码值走代码体）。
  // 这一行的**字形**也是契约：措辞变了本判据就红，逼你两边同时改。
  return `\`${EXIT.passed}\` 干净 / \`${EXIT.failed}\` 违规 / \`${EXIT.unjudged}\` 判不了（INTERNAL）`
}
