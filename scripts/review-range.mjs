#!/usr/bin/env node
// 审查区间口径工具（2026-10-07 · ISS-602）
//
// 治什么：派审时「区间口径」有两种，语义不同、极易混用，且混用**静默**出错：
//   `main...<branch>`（三点）= 相对 merge-base ⇒ **只含本单改动** ⇒ 用于 `git diff`
//   `main..<branch>`（两点） = 到 main 当前       ⇒ **只含本单提交** ⇒ 用于 commit 计数/列表
// 实测教训（ISS-993）：某单自身 4 个提交，用三点数出 **11 个** ——
//   多出的 7 条是**别人在 main 上的提交** ⇒ 审查面被污染（会去审不属于本单的代码）。
//
// 本工具把「两套口径各自该用哪个」变成**机器可判**：
//   · 输出交接头（区间 + N + commit 清单），供派审方原样贴给审查员；
//   · 输出 diff 该用哪条命令；
//   · 若 commit 清单条数与 N 不符 ⇒ 非 0 退出（交接完整性门，防"交接失真导致审查不完整"）。
//
// 用法：
//   node scripts/review-range.mjs <branch> [--base main] [--json]
//   node scripts/review-range.mjs --selftest
import { execFileSync } from "node:child_process"

const REPO = process.env.DSH_FORGE_REPO || process.cwd()
const git = (args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim()

/** 纯函数：交接头（可单测）。 */
export function buildHandoff({ range, count, commits, diffCmd }) {
  const lines = [
    `区间 = ${range}（${count} 个提交）`,
    ``,
    `看改了什么（**三点**，只含本单改动）：`,
    `  ${diffCmd}`,
    ``,
    `本单提交（**两点**，恰好 ${count} 条）：`,
    ...commits.map((c) => `  ${c}`),
  ]
  return lines.join("\n")
}

/** 纯函数：交接完整性判据 —— 清单条数必须等于 N。 */
export function checkHandoff(count, commitLines) {
  const n = Array.isArray(commitLines) ? commitLines.length : 0
  return n === count
    ? { ok: true, count: n }
    : { ok: false, count: n, reason: `commit 清单 ${n} 条 ≠ N=${count}（三点/两点混用？交接失真 ⇒ 审查不完整）` }
}

function gather(branch, base = "main") {
  const range2 = `${base}..${branch}`   // 两点：只含本单提交
  const range3 = `${base}...${branch}`  // 三点：相对 merge-base
  const count = Number(git(["rev-list", "--count", range2]))
  const commits = git(["log", range2, "--format=%h %s"]).split("\n").filter(Boolean)
  const diffCmd = `git diff --stat ${range3}`
  const files = git(["diff", "--name-only", range3]).split("\n").filter(Boolean)
  return { branch, base, range2, range3, count, commits, diffCmd, files }
}

/**
 * 编排（**可注入依赖**，便于真行为测试）。
 *
 * 为什么抽出来（独立审查 B1）：原 `main()` 内联了 gather、打印与 `process.exit`，
 *   测试只能覆盖**纯函数** `buildHandoff`/`checkHandoff` ⇒
 *   "算了 `chk` 却不影响退出码""`count` 传的不是真 N"这两类**全部漏过**
 *   （实测：两个变异都让 `--selftest` 全绿）。
 *   ⚠️ 且"清单≠N"在真实路径里造不出来（清单与 count 同源于 git）⇒ 只能靠**注入**验消费端。
 *
 * @param {{gather: Function, out: Function, err: Function, exit: Function, argv: string[]}} deps
 * @returns {number} 期望的退出码（调用方据此 exit；测试可直接断言返回值）
 */
export function runMain(deps) {
  const { gather: gatherFn, out, err, exit } = deps
  const argv = deps.argv || []
  if (argv.includes("--json")) { /* 占位：--json 在下方 g 取出后处理 */ }
  const branch = argv.find((a) => !a.startsWith("--"))
  const bi = argv.indexOf("--base")
  const base = bi > 0 ? argv[bi + 1] : "main"
  if (!branch) { err("用法: node scripts/review-range.mjs <branch> [--base main] [--json]"); return 2 }
  let g
  try { g = gatherFn(branch, base) } catch (e) { err(`取区间失败：${e.message}`); return 2 }
  const chk = checkHandoff(g.count, g.commits)
  if (argv.includes("--json")) {
    out(JSON.stringify({ ...g, handoffOk: chk.ok }, null, 2))
  } else {
    out(buildHandoff({ range: g.range2, count: g.count, commits: g.commits, diffCmd: g.diffCmd }))
    out("")
    out(`本单改动文件（${g.files.length} 个，三点区间）：`)
    for (const f of g.files.slice(0, 20)) out(`  ${f}`)
    if (g.files.length > 20) out(`  …另有 ${g.files.length - 20} 个`)
  }
  // ⚠️ 消费端：chk 不 ok ⇒ 必须非 0（这条**只能靠注入测**，真实路径造不出清单≠N）
  if (!chk.ok) { err(`\n✗ 交接完整性门：${chk.reason}`); return 1 }
  return 0
}

/** 自测：7 条。②③④ 类是「保留字面量 / 换输入 / 断消费端」——它们是变异表要求的必测类。 */
function selftest() {
  let pass = 0, fail = 0
  const noRecurse = process.env.REVIEW_RANGE_NO_RECURSE === "1"
  const ok = (m) => { pass++; console.log(`  ✓ ${m}`) }
  const no = (m) => { fail++; console.log(`  ✗ ${m}`) }
  const noop = { out: () => {}, err: () => {}, exit: () => {} }

  // ①②③ 纯函数层
  checkHandoff(3, ["a", "b", "c"]).ok ? ok("清单条数 == N ⇒ 放行") : no("应放行")
  !checkHandoff(4, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]).ok
    ? ok("清单 11 条 ≠ N=4 ⇒ 拒（三点混用的形状）") : no("应拒")
  !checkHandoff(2, []).ok ? ok("清单为空 ⇒ 拒") : no("应拒")
  const h = buildHandoff({ range: "main..ISS-1", count: 2, commits: ["x", "y"], diffCmd: "git diff --stat main...ISS-1" })
  ;(h.includes("main..ISS-1") && h.includes("2 个提交") && h.includes("main...ISS-1"))
    ? ok("交接头含 区间/N/diff 命令三者") : no("交接头缺要素")

  // ④⑤⑥ **消费端真行为**（独立审查 B1 的正解）：
  //   前两版我试过"非法分支""非法基线"，**变异仍然全绿** —— 因为它们测的是 gather 抛错，
  //   而变异在 `chk` 的消费。且"清单≠N"在真实路径**造不出来**（清单与 count 同源于 git）
  //   ⇒ 只能**注入** gather 来造场景。
  const fake = (count, n) => (_b, _base) => ({
    branch: "X", base: "main", range2: "main..X", range3: "main...X",
    count, commits: Array.from({ length: n }, (_, i) => `c${i}`),
    diffCmd: "git diff --stat main...X", files: [],
  })
  const r1 = runMain({ gather: fake(4, 11), argv: ["X"], ...noop })
  r1 === 1 ? ok("清单 11 条 ≠ N=4 ⇒ 返回 1（消费端真在起作用）") : no(`清单≠N 却返回 ${r1}（消费端没起作用）`)
  const r2 = runMain({ gather: fake(2, 2), argv: ["X"], ...noop })
  r2 === 0 ? ok("清单 == N ⇒ 返回 0（④ 不是恒真）") : no(`清单==N 却返回 ${r2}`)
  const r3 = runMain({ gather: () => { throw new Error("boom") }, argv: ["X"], ...noop })
  r3 === 2 ? ok("gather 抛错 ⇒ 返回 2（失败不静默）") : no(`gather 抛错却返回 ${r3}`)
  const r4 = runMain({ gather: fake(1, 1), argv: [], ...noop })
  r4 === 2 ? ok("缺 branch 参数 ⇒ 返回 2") : no(`缺参数却返回 ${r4}`)

  // ⑧ **软链路径下仍能执行**（独立审查 B2 第二轮的牙）：第一版后缀式在软链下失效
  //    （实测 /tmp → /private/tmp ⇒ 连 --selftest 都 exit=2）；第二版用 realpath 归一。
  //    这条断言**真造软链**跑一次子进程 —— 只读源码字符串挡不住回归（实测：改回后缀式，
  //    在软链路径下 8/8 全绿，因为 selftest 自己跑在真实路径下、测不到软链）。
  if (!noRecurse) try {
    const tmp = mkdtempSync(join(tmpdir(), "rr-link-"))
    mkdirSync(join(tmp, "real"), { recursive: true })
    mkdirSync(join(tmp, "link"), { recursive: true })
    copyFileSync(fileURLToPath(import.meta.url), join(tmp, "real", "review-range.mjs"))
    symlinkSync(join(tmp, "real", "review-range.mjs"), join(tmp, "link", "alias.mjs"))  // ⚠️ 必须**别名**：同名软链挡不住后缀式
    const r = execFileSync(process.execPath, [join(tmp, "link", "alias.mjs"), "--selftest"], {
      encoding: "utf8", env: { ...process.env, REVIEW_RANGE_NO_RECURSE: "1" },
    })
    r.includes("通过") ? ok("**别名软链**下可执行（realpath 归一生效；同名软链挡不住后缀式回归）") : no("软链下输出异常")
    rmSync(tmp, { recursive: true, force: true })
  } catch (e) {
    no(`软链路径下**不可执行**（应能）：${String(e.message || e).slice(0, 60)}`)
  }

  // ⚠️ **断言数下限**（独立审查 B1 第二轮）：删掉任一断言后，本自测只会"少报一项"，
  //   仍然全绿、exit=0（实测：删「清单为空 ⇒ 拒」⇒ 7 项全绿）⇒ **删断言无人发现**。
  //   依据 `docs/code.md` K8b（从没红过的守卫等于没有守卫）+ K8f（守卫自己也要被反向验证覆盖）。
  //   ⚠️ 全仓无"断言数下限"先例（`ws-lease-selftest` 也没有）⇒ 这是新增判据，非复用。
  const BASELINE = noRecurse ? 8 : 9   // 断言数基线：新增断言请同步抬此数
  const total = pass + fail
  if (total < BASELINE) {
    fail++
    console.log(`  ✗ 断言数 ${total} < 基线 ${BASELINE} —— **有断言被删**（删除断言不得静默变绿）`)
  }
  console.log(`\n通过 ${pass} 项 · 失败 ${fail} 项（基线 ${BASELINE}）`)
  return fail === 0 ? 0 : 1
}

function main() {
  if (process.argv.slice(2).includes("--selftest")) process.exit(selftest())
  const code = runMain({
    gather, argv: process.argv.slice(2),
    out: (s) => console.log(s), err: (s) => console.error(s), exit: (c) => process.exit(c),
  })
  process.exit(code)

}

// 仅在**直接执行**时跑 main（被 import 时不跑，便于单测）。
// ⚠️ 判据用**归一化后的真实路径**比较（独立审查 B2 第二轮）：
//   第一版用 `argv[1].endsWith("review-range.mjs")` ⇒ 改名/复制即**静默不执行**；
//   第二版改 `import.meta.url === pathToFileURL(argv[1]).href` ⇒ **软链路径下失效**
//     （实测 macOS `/tmp` → `/private/tmp`：`--selftest` 都 exit=2，整个工具不可用）。
//   ⇒ 两边都先 `realpathSync` 归一（解析软链），再比。
//   ⚠️ 且**输出的是"能不能跑"**，不再把"报错退出"说成"能跑"——
//     前一版我自述"改名/复制/软链都能跑"是**夸大**（实测改名即 exit=2），此处如实纠正。
import { pathToFileURL, fileURLToPath } from "node:url"
import { realpathSync, mkdtempSync, mkdirSync, copyFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const samePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}
const isDirectRun = (() => {
  const a = process.argv[1]
  if (!a) return false
  try { return samePath(fileURLToPath(import.meta.url), a) } catch { return false }
})()
if (isDirectRun) {
  main()
} else if (process.argv[1] && !process.env.REVIEW_RANGE_AS_MODULE) {
  // 被 import 是正常用法（REVIEW_RANGE_AS_MODULE=1 时静默）；否则说明调用方式不对 ⇒ 出声
  console.error("review-range：未以直接执行方式运行（argv[1] 与模块路径不一致）")
  console.error("  → 若你是复制/改名后调用，请 `node <真实路径>/review-range.mjs <branch>`；")
  console.error("  → 若这是 `import` 用法，设 REVIEW_RANGE_AS_MODULE=1 消除本提示。")
  process.exit(2)
}
