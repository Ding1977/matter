/**
 * 门禁退出码 → 四态（run-gates L3 的口径层）。
 *
 * 从 `scripts/run-gates.mjs` 搬出（ISS-772）：本段是纯函数、无 IO，
 * 只负责把 guard-baselines.sh 的四套退出码口径翻译成 passed / failed / unjudged。
 * 红绿不在这里重定 —— 逐条对齐 scripts/guard-baselines.sh。
 */
// ─────────────────────────────────────────────────────────────────────────────
// §1 判据口径 —— 逐条对齐 scripts/guard-baselines.sh，**不在这里重定红绿**
//
// guard-baselines.sh 的四种调用各有一套退出码口径（见该文件 check()/selfcheck()/livecheck()/report_only()）：
//   check       0 绿 / 3 判不了（分母为 0、根没找对）/ 其它 红；带 --classify 时再按详情文件的
//               差异前缀分档：有 `+` `-` ⇒ 回归（红）；只有 `~` ⇒ 基线过期（**不是红、也不是绿**）；认不出 ⇒ 按回归处理。
//   selfcheck   0 绿 / 其它 红（它内部有反向验证，跑失败就说明守卫自己坏了）。
//   livecheck   rc=3 判不了（与 check 同一条口径，ISS-744）/ rc≥2 不一致（红）/ rc=1 判据异常（guard 里同样进 fail=1）/ 0 绿。
//               ⚠️ 3 必须排在 ≥2 前面：它是三态里的第三格，不是「比 2 更红」。
//   report_only 0 无新增（绿）/ 1 有新增违例（红）/ 其它 判不了（出声、不进 fail、也绝不显示绿）。
//
// 这里只把「退出码 → 四态」写成纯函数，好让 --selftest 能反证「红不会被读成绿」（ISS-635 的原始形态）。
// ─────────────────────────────────────────────────────────────────────────────
import { EXIT, isUnjudged } from "./exit-codes.mjs"

export const STALE = { status: "unjudged", note: "基线过期（计数漂移，不是回归）" }

/** 详情差异形态：有 +/- ⇒ regress；只有 ~ ⇒ stale；认不出 ⇒ unknown（口径同 guard 的 drift_kind()）。 */
export function driftKind(out) {
  let plus = 0
  let minus = 0
  let tilde = 0
  for (const raw of out.split("\n")) {
    const t = raw.replace(/^\s+/, "")
    if (t.startsWith("+ ")) plus++
    else if (t.startsWith("- ")) minus++
    else if (t.startsWith("~ ")) tilde++
  }
  if (plus || minus) return "regress"
  if (tilde) return "stale"
  return "unknown"
}

export const VERDICT = {
  check: (rc, out, classify, codes) => {
    if (rc === EXIT.passed) return { status: "passed" }
    // ⚠️ ISS-832 的顺序在这里是判据，不是风格：`--classify` 的格（现只有 migration-baseline）
    //   用 rc 表「**有漂移**」，再看输出里 `+`/`-` 与 `~` 分「回归」与「基线过期」。
    //   对这类格，rc=2 是**有漂移**，不是判不了 —— 若让它先撞下面的 `isUnjudged`，
    //   一份真回归（清单增删）会被读成第三态，等于把红洗掉。故 classify 分支必须排在前面。
    //   仍然认 3 为判不了（那一档脚本自己用 3 表「没对照物」，与漂移无关）。
    if (classify) {
      if (isUnjudged(rc, codes)) {
        const kind = driftKind(out)
        if (kind === "stale") return STALE
        if (kind === "regress") return { status: "failed", note: "回归 —— 清单增删" }
        return { status: "failed", note: "不一致（差异形态认不出 ⇒ 按回归处理，不因为没看懂放绿）" }
      }
      return { status: "failed", note: `回归（exit ${rc}）` }
    }
    // ISS-832：判不了码走唯一入口 `isUnjudged()`（canonical 2 + legacy 3），别再裸写 `rc === 3`。
    //   原先只认 3 —— 一个脚本若按 canonical 口径退 2（缺 typescript / 判据自身崩），
    //   就被读成「回归（exit 2）」。干净机器上「没语料 / 没 home / 没构建」于是报成「判据被违反」。
    if (isUnjudged(rc, codes)) return { status: "unjudged", note: `判不了：分母为 0 / 数据根没找对（不是绿，也不是回归；exit ${rc}）` }
    return { status: "failed", note: `回归（exit ${rc}）` }
  },
  selfcheck: (rc) => (rc === EXIT.passed ? { status: "passed" } : { status: "failed", note: `自检失败（exit ${rc}）` }),
  livecheck: (rc, _out, _classify, codes) =>
    // ISS-744：rc=3 = 判不了（缺语料 / 缺产物 / 分母为 0）。它既不是绿也不是红 ——
    //   原先这里只有 `rc>=2 ⇒ 红`，于是三个「自报不判」的脚本把 exit 0 当逃生门（输出写"不判"、码上却是绿）；
    //   脚本改正为 exit 3 后，本档若仍读成红，就会从假绿翻成常红。两条都错，第三态才是对的。
    rc === 0
      ? { status: "passed" }
      : isUnjudged(rc, codes)
        ? { status: "unjudged", note: `判不了：缺语料 / 缺产物 / 分母为 0（不是绿，也不是回归；exit ${rc}）` }
        : { status: "failed", note: rc >= 2 ? `不一致（exit ${rc}）` : `判据异常（exit ${rc}）` },
  report_only: (rc) =>
    rc === EXIT.passed
      ? { status: "passed" }
      : rc === EXIT.failed
        ? { status: "failed", note: "有新增违例" }
        : { status: "unjudged", note: `判不了（exit ${rc}）` },
}
