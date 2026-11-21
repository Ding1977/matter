#!/usr/bin/env node
// ISS-282 / S5：交付链体检脚本 —— 带号率 + 未提交文件 + 僵尸分支 + done 单落点
//
// 背景（2026-09-08 审计）：main 近 60 天 191 提交只有 43 个带 ISS 号（22%）；
// 125 张 done 里 94 张在任何 ref 上都找不到带号提交；主 checkout 曾堆到 98 个
// 未提交文件。commit-msg 钩子管「以后必带号」，本脚本管「持续不退化」——
// 钩子可能被 --no-verify 绕过，体检脚本是第二道防线。
//
// 用法：
//   node scripts/git-health-check.mjs                 # 全项体检，任一不达标退出码 1
//   node scripts/git-health-check.mjs --days 30       # 带号率统计窗口改 30 天
//   node scripts/git-health-check.mjs --warn          # 只报告，永远退出 0（巡检用）
//   node scripts/git-health-check.mjs --json          # 机器可读输出
//   node scripts/git-health-check.mjs --repo <path>   # 指定仓库（默认当前目录向上找 .git）
//
// 退出码：0 = 全部达标；1 = 有不达标项；2 = 执行失败（不是 git 仓库等）

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { runGitSync } from "./git-lib.mjs"
// PM 的 frontmatter 解析器复用（别再写第二份"看着一样"的解析——ISS-696 的教训）
import { parseFrontmatter } from "../forge-service-kit/lib/frontmatter.js"
// done 落点判定**不另写一份**：直接复用门禁的同体（K6a「同体两份」的教训）——
//   `evaluateDoneLanding` / `branchesForIssue` 是纯函数。
// ⚠️ ISS-793：这两个函数**不在 `forge-pm/lib/index.js` 里**。ISS-587（`8f0a252c`）清「index 死 import」
//   时把整行 import 删了 ⇒ 本脚本自 2026-10-04 起**加载即崩**（`SyntaxError: Export named 'evaluateDoneLanding' not found`）。
//   而它是「非阻断」格 ⇒ full 档只打一个 `·`、不进红名单，36 天没人发现。
//   ⇒ 必须从**定义处**取：`forge-pm/lib/done-gate.js:225` / `:311`（都是 export）。**不要**去 index.js 加 re-export：
//   那会让一份「已被判定为死绑定」的导出复活（K10b 零引用导出正好会记这笔账）。
import { branchesForIssue, evaluateDoneLanding } from "../forge-pm/lib/done-gate.js"

const argv = process.argv.slice(2)
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def
}
const has = (name) => argv.includes(`--${name}`)

const DAYS = Number(flag("days", "7"))
const WARN_ONLY = has("warn")
const AS_JSON = has("json")
const REPO = resolve(flag("repo", process.cwd()))
// PM 真相源根：与 forge-pm/lib/domain.js 同口径（FORGE_PM_ROOT > ~/.dsh/pm）。
// 体检脚本要读"单"，单不在 git 里 —— 但"done 单是否真落到 main"必须两处一起看。
const PM_ROOT = resolve(flag("pm-root", process.env.FORGE_PM_ROOT || join(homedir(), ".dsh", "pm")))

// git() 的实现搬进 `scripts/git-lib.mjs`（ISS-696：避免与 review-pack.mjs 各写一份"看着一样"的包装）。
// 这里只留一行按本仓默认仓库转发的薄壳 —— 10 个调用点与语义（allowFail 才吞错）一字未动。
const git = (args, opts = {}) => runGitSync(REPO, args, opts)

function lines(s) {
  return String(s || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
}

const ISSUE_RE = /ISS-\d+|PRJ-\d+|REV-\d+|INI-\d+/
const checks = []
const add = (name, ok, detail, hint = "") => checks.push({ name, ok, detail, hint })

// ── 0. 仓库可用性 ────────────────────────────────────────────────
if (!existsSync(`${REPO}/.git`)) {
  console.error(`不是 git 仓库：${REPO}`)
  process.exit(2)
}
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).trim()

// ── 1. 带号率（核心） ────────────────────────────────────────────
{
  const base = git(["rev-parse", "--verify", "main"], { allowFail: true }).trim() ? "main" : "HEAD"
  const subjects = lines(git(["log", base, `--since=${DAYS} days ago`, "--format=%s"], { allowFail: true }))
  const tagged = subjects.filter((s) => ISSUE_RE.test(s))
  const rate = subjects.length ? Math.round((tagged.length / subjects.length) * 100) : 100
  const missing = subjects.filter((s) => !ISSUE_RE.test(s)).slice(0, 10)
  add(
    `带号率（近 ${DAYS} 天 · ${base}）`,
    rate >= 80,
    `${tagged.length}/${subjects.length} = ${rate}%（目标 ≥80%）`,
    missing.length ? `未带号样本：${missing.join(" ｜ ")}` : ""
  )
}

// ── 2. 未提交文件（丢三天风险） ──────────────────────────────────
{
  const dirty = lines(git(["status", "--porcelain"], { allowFail: true }))
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"], { allowFail: true }))
  add(
    "未提交变更",
    dirty.length <= 20,
    `工作区 ${dirty.length} 条（其中未跟踪 ${untracked.length} 个文件）`,
    dirty.length > 20 ? "超过 20 条：先按会话切片提交，或至少 git stash create 存一份快照（ISS-282 S1 做法）" : ""
  )
}

// ── 3. 僵尸分支（无主、超期未合并） ──────────────────────────────
{
  const unmerged = lines(git(["branch", "--no-merged", "main", "--format=%(refname:short)"], { allowFail: true }))
  const zombies = []
  for (const b of unmerged) {
    const counts = git(["rev-list", "--left-right", "--count", `main...${b}`], { allowFail: true }).trim().split(/\s+/)
    const ahead = Number(counts[1] || 0)
    const behind = Number(counts[0] || 0)
    const lastDate = git(["log", "-1", "--format=%ad", "--date=short", b], { allowFail: true }).trim()
    const days = lastDate ? Math.round((Date.now() - new Date(lastDate).getTime()) / 86400000) : 999
    // 无单号命名（分支名不含 ISS/PRJ）且超 7 天未动 = 僵尸候选
    if (!/ISS-\d+|PRJ-\d+/.test(b) && (days > 7 || ahead > 10)) zombies.push(`${b}（ahead ${ahead} / behind ${behind} / ${lastDate}）`)
  }
  add("僵尸分支", zombies.length === 0, zombies.length ? `${zombies.length} 条：${zombies.join(" ｜ ")}` : "无", zombies.length ? "逐条决定 合入 / 打 tag 后删" : "")
}

// ── 4. 主干新鲜度 ────────────────────────────────────────────────
{
  const d = git(["log", "-1", "--format=%ad", "--date=short", "main"], { allowFail: true }).trim()
  const stale = d ? Math.round((Date.now() - new Date(`${d}T00:00:00+08:00`).getTime()) / 86400000) : 999
  add("主干新鲜度", stale <= 3, `main tip = ${d}（距今 ${stale} 天）`, stale > 3 ? "主干冻结超过 3 天：交付都堆在分支和脏区里（ISS-282 现象）" : "")
}

// ── 5. done 单落点（ISS-282 B / ISS-993：与 done 门禁**同一判据**，不另写一份） ──────
// 为什么必须有这一条：本文件头注从 ISS-282 起就宣称有"done 单落点"，但**从未实装** ——
//   "19 分支未并入 + 3 张 done 无落点"时它照样报 ok:true 全绿（挂着的宣称比没有更坏）。
// 判据与门禁同源：frontmatter 的 branch/commit **或按单号回推的磁盘分支**必须是 main 的祖先；
//   无线索 = 豁免（存量不追溯）但**报出规模**（ISS-282 评论①的"单→落点"维度）。
{
  const issuesDir = join(PM_ROOT, "issues")
  if (!existsSync(issuesDir)) {
    add("done 单落点", true, `跳过：找不到 PM 库 ${issuesDir}（用 --pm-root 或 FORGE_PM_ROOT 指定）`)
  } else {
    const allBranches = lines(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], { allowFail: true }))
      .filter((b) => b !== "main")
    // ⚠️ 不能用 allowFail 判祖先：`merge-base --is-ancestor` 成功时**也不打印**（空串 = 成功与失败同形）
    //   ⇒ 这里显式 try/catch 取真假（git-lib 的契约：默认抛错、allowFail 才吞）。
    const probeRef = (ref) => {
      try { runGitSync(REPO, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) } catch { return "missing" }
      try { runGitSync(REPO, ["merge-base", "--is-ancestor", ref, "main"]); return "ancestor" } catch { return "exists-not-merged" }
    }
    let doneTotal = 0
    let exempt = 0
    const rejected = []
    for (const f of readdirSync(issuesDir)) {
      if (!f.endsWith(".md")) continue
      let fm = null
      try { fm = parseFrontmatter(readFileSync(join(issuesDir, f), "utf8")).frontmatter } catch { continue }
      if (String((fm && fm.status) || "") !== "done") continue
      doneTotal++
      const id = (fm && fm.id) || f
      const r = await evaluateDoneLanding(fm, { probeRef, matchingBranches: branchesForIssue(id, allBranches) })
      if (r.exempt) exempt++
      else if (!r.ok) rejected.push(`${r.ref}（${id}${r.kind === "branch-by-id" ? " ·按单号回推" : ""}）`)
    }
    add(
      "done 单落点",
      rejected.length === 0,
      `${doneTotal} 张 done：未并入/找不到 ${rejected.length} · 豁免（无线索）${exempt}`,
      rejected.length
        ? `先合并这些分支（或补 frontmatter.commit=<已并入 main 的 sha>）：${rejected.slice(0, 6).join(" ｜ ")}`
        : "",
    )
  }
}

// ── 6. 当前分支：主 checkout 必须停 main（与 scripts/ws.sh guard 同一真相） ─────
// 旧版写"非 main 也 OK，只要是带单号的分支" —— 而 ws.sh guard 对同一状态 exit 2
//   ⇒ 两个工具**相反结论**（ISS-282 评论③）。主 checkout 只有一个正确位置：main；
//   在途工作该放工作树（~/wt/dsh-forge/<ISS>）。工作树自身不适用本条（.git 是文件指针）。
{
  const gitEntry = `${REPO}/.git`
  const isWorktree = existsSync(gitEntry) && statSync(gitEntry).isFile()
  const ok = isWorktree || branch === "main"
  add(
    "当前分支",
    ok,
    `HEAD = ${branch}${isWorktree ? "（工作树：.git 是文件指针，本条不适用）" : ""}`,
    ok ? "" : "主 checkout 该停 main（与 ws.sh guard 同一真相）；在途工作放工作树：ws.sh new <ISS-NNN>"
  )
}

// ── 输出 ─────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok)

if (AS_JSON) {
  console.log(JSON.stringify({ repo: REPO, branch, days: DAYS, checks, ok: failed.length === 0 }, null, 2))
} else {
  console.log(`\n交付链体检 · ${REPO}\n${"─".repeat(60)}`)
  for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name}：${c.detail}`)
  if (failed.length) {
    console.log(`${"─".repeat(60)}`)
    for (const c of failed) if (c.hint) console.log(`   ▸ ${c.name}：${c.hint}`)
  }
  console.log(`${"─".repeat(60)}\n结论：${failed.length === 0 ? "全部达标" : `${failed.length} 项不达标`}\n`)
}

process.exit(WARN_ONLY ? 0 : failed.length === 0 ? 0 : 1)
