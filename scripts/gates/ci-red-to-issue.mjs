#!/usr/bin/env node
// ci-red-to-issue.mjs —— CI 红了 ⇒ 自动建 Matter 单（ISS-715 ③「L4 强制层的实质内容」）
//
// ## 为什么需要它
// GitHub 分支保护在本仓**开不了**（私有仓免费版：`gh api repos/.../branches/main/protection`
// → 403 Upgrade to GitHub Pro）⇒ 「CI 红了谁负责」这件事在远端**没有强制点**。
// 这张单存在的意义就是补上那个点：红了就有一张单落在某个人/某个 agent 的清单里，
// 而不是躺在 Actions 页面里等人恰好点开。
//
// ## ⚠️ 为什么它**不是**在 GitHub Actions 里跑的
// 工单原方案写的是「CI 失败时（if: failure()）调 POST http://127.0.0.1:3210/forge-pm/*」。
// 实测这条**跑不通**，三条硬事实：
//   ① Actions runner 上的 127.0.0.1 是 **runner 自己的 localhost**，不是本机的 Matter 服务
//      ⇒ 那个 POST 只会 connection refused（本仓 CI 从未有过 tunnel / 反向暴露）；
//   ② 本机 `/forge-pm/create` 有**写身份闸**（`actor.js` 的 `writeIdentityProblem`）：
//      裸 curl 无 token 无 Origin ⇒ **403「无法判定写入方身份，已拒绝本次建单」**（实测）；
//      而成员凭证是 SHA-256 只存注册表、明文只在签发时打印一次 ⇒ runner 拿不到，也不该拿；
//   ③ 私有仓 Actions 默认不能读本机盘 ⇒ 也没有「写盘再由本地读」这条路。
// ⇒ 落地形态改成**两段**：
//   · CI 侧（`.github/workflows/ci.yml`）：失败时把 run-gates 的完整日志提成 **artifact**
//     + 把红名单写进 job summary（人点开 Actions 就看得见「哪几格红」）；
//   · 本机侧（本文件）：把那份日志/那个 run 翻成一张 Matter 单。
//     在**能看见 PM 库的机器上**跑 —— 本机、或者 Lead 会话里。
//
// ## 两种输入（都存在才叫落地，只做一种就是把问题挪到别处）
//   node scripts/gates/ci-red-to-issue.mjs --run <run_id>     # 拉远端 run（gh 认证 + 网络）
//   node scripts/gates/ci-red-to-issue.mjs --log <path>       # 直接读日志文件
//                                                       #   = 本地 run-gates 的输出，或从 Actions
//                                                       #     下载的 artifact（run-gates-ci-<id>.log）
// 默认 **dry-run**（只打印要建什么单，不落盘）；真建单要显式 `--create`。
//   为什么默认不写：本文件会被自动化调用，写面默认开 = 一次误调就在库里留垃圾单。
//
// ## 走的是哪条写入路（不新造写口）
// 直调 `forge-pm/lib/entity-ops.js` 的 `createEntityCore` —— 它**就是** `matter_issue(action=create)`
// 与 `POST /forge-pm/create` 后面的那一份实现（该文件头注：三条路同调一份，不各持一份）。
// 服务端发号、跨进程锁、枚举闸、tags 归一全在里面，本文件**不碰** id 生成与落盘。
// 不走 HTTP：那需要成员凭证，而本机脚本没有、也不该持有明文（注册表只存哈希）。
//
// ## 幂等（同一个 run 不重复建单）
// 判据 = 「未结案的单里，标题已含同一个 commit 短号 + 同一个 job 名」。
// 已存在则**不建**，并把已有单号打出来 —— 重复刷单会让清单失去信息价值（同 ISS-707 那类回环）。
//
// ## 用法
//   node scripts/gates/ci-red-to-issue.mjs --run 42176400924                 # dry-run
//   node scripts/gates/ci-red-to-issue.mjs --run 42176400924 --create        # 真建单
//   node scripts/gates/ci-red-to-issue.mjs --log /tmp/run-gates-ci.log --sha <sha> --create
//   node scripts/gates/ci-red-to-issue.mjs --selftest                        # 反向验证（不联网、不写库）
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..", "..")
const ARGV = process.argv.slice(2)
const flag = (n) => ARGV.includes(n)
const opt = (n, d) => {
  const i = ARGV.indexOf(n)
  return i < 0 ? d : ARGV[i + 1]
}

/** 建单署名。**不用** USER_ACTOR（那是老板），也不用笼统 "agent"——来源必须一眼看得出是机器。 */
const ACTOR = opt("--actor", "ci-red-watcher")

// ─────────────────────────────────────────────────────────────────────────────
// §1 取失败现场
// ─────────────────────────────────────────────────────────────────────────────

/** 从 run 拿：{ sha, branch, url, runId, jobs: [{name, steps}], log } */
function fromRun(runId) {
  const view = spawnSync("gh", ["run", "view", String(runId), "--json", "headSha,headBranch,url,jobs,conclusion"], { encoding: "utf8", cwd: ROOT })
  if (view.status !== 0) return { ok: false, error: `gh run view 失败：${(view.stderr || "").trim().split("\n")[0]}` }
  let j
  try {
    j = JSON.parse(view.stdout)
  } catch {
    return { ok: false, error: "gh run view 的 --json 输出不是合法 JSON" }
  }
  // --log-failed 只给失败 step 的行，量小且正是需要的；拿不到不算致命（下面会退化成"只有链接"）
  const logR = spawnSync("gh", ["run", "view", String(runId), "--log-failed"], { encoding: "utf8", cwd: ROOT, maxBuffer: 1 << 26 })
  return {
    ok: true,
    runId: String(runId),
    sha: j.headSha || "",
    branch: j.headBranch || "",
    url: j.url || "",
    jobs: (j.jobs || []).filter((x) => x.conclusion === "failure").map((x) => ({ name: x.name, steps: (x.steps || []).filter((s) => s.conclusion === "failure").map((s) => s.name) })),
    log: logR.status === 0 ? logR.stdout : "",
  }
}

/** 从日志文件拿：run-gates 的输出（本地跑 or Actions artifact 下载下来的） */
function fromLog(logPath) {
  if (!fs.existsSync(logPath)) return { ok: false, error: `日志文件不存在：${logPath}` }
  return {
    ok: true,
    runId: "",
    sha: opt("--sha", ""),
    branch: opt("--branch", ""),
    url: opt("--url", ""),
    jobs: [],
    log: fs.readFileSync(logPath, "utf8"),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §2 从日志里抠「哪几格红」——口径与 run-gates 的 summarize() 同源，不另立一套
// ─────────────────────────────────────────────────────────────────────────────
//
// run-gates 打出的是 `红名单：` 开头的一段，每格两行：
//   `  ✗ <id padded> <label>` / `      <note>`
// 这里只抠 **id 与 label**，不重新判定红绿（判据在 run-gates 里，本文件不越权重算）。
// 抠不到不是致命错误 —— 但必须**明说抠不到**，不许打印一个空清单冒充「没有红格」。
function redGates(log) {
  const out = []
  const lines = log.split("\n")
  const start = lines.findIndex((l) => l.trim() === "红名单：")
  if (start < 0) return { found: false, gates: [] }
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^(判不了（|跳过（|最慢五格|✓ |✗ [0-9])/.test(l.trim())) break
    const m = l.match(/^\s+[✗·]\s+(\S+)\s+(.*)$/)
    if (m) out.push({ id: m[1], label: m[2].trim() })
  }
  return { found: true, gates: out }
}

/** 「判不了」也要点名 —— 它不是绿（run-gates 的 exitCodeOf 与 summarize 都按这个口径）。 */
function unjudgedGates(log) {
  const out = []
  const lines = log.split("\n")
  const start = lines.findIndex((l) => l.startsWith("判不了（不是绿，也不是红）"))
  if (start < 0) return out
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^(跳过（|最慢五格|✓ |✗ [0-9])/.test(l.trim())) break
    const m = l.match(/^\s+!\s+(\S+)\s*(.*)$/)
    if (m) out.push({ id: m[1], label: (m[2] || "").trim() })
  }
  return out
}

/** 摘要行（`✓ N 绿 / ✗ M 红 ...`）原样带进正文：数字不用本文件重算。 */
function summaryLine(log) {
  return (log.split("\n").find((l) => /^✓ \d+ 绿 \/ ✗ \d+ 红/.test(l.trim())) || "").trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 幂等：已建过就不重复建
// ─────────────────────────────────────────────────────────────────────────────
//
// 判据刻意用「commit 短号 + job 名」同时命中，而不是只用 sha：
// 同一次 run 里两个 job 各自红是不同的责任面（check 是判据红，secret-scan 是密钥红），
// 合成一张单会把两件事粘死；但同 job 同 sha 反复重跑只该有一张单。

/**
 * **纯函数**：从 scan() 的结果里挑出参与去重的单。
 * 抽出来是为了能自检 —— 这段逻辑曾经读过不存在的 `it.full`，症状是**静默失效**：
 * 每次都判「没有同键单」⇒ 每跑一次就多建一张单（实测两次跑出 ISS-001 / ISS-002）。
 * 静默的幂等失效比没有幂等更坏：库里长出一串同题单，而你以为有去重。
 */
function existingFrom(items, titleKey) {
  const hits = []
  for (const it of items) {
    if (it.dir !== "issues" || it.deleted) continue
    const st = String(it.status || "")
    if (st === "done" || st === "canceled" || st === "duplicate") continue
    if (String(it.title || "").includes(titleKey)) hits.push({ id: it.fmId || it.id, status: st, title: it.title })
  }
  return hits
}

async function findExisting(titleKey) {
  // `scan()` 的每一项**已经**是解析好的前端字段（`{ id, fmId, dir, title, status, ... }`），
  // 不必再按 `it.full` 去 readFrontmatter —— 那个字段根本不存在（实测踩到：幂等失效、重复建单）。
  const { scan } = await import(path.join(ROOT, "forge-pm/lib/md-store.js"))
  return existingFrom(scan(), titleKey)
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 组单
// ─────────────────────────────────────────────────────────────────────────────

function buildIssue(ctx) {
  const sha8 = (ctx.sha || "").slice(0, 8)
  const jobName = ctx.jobs.length ? ctx.jobs.map((j) => j.name).join(" + ") : opt("--job", "run-gates ci")
  const titleKey = sha8 ? `${jobName} / ${sha8}` : `${jobName} / (无 sha)`
  const red = redGates(ctx.log)
  const unj = unjudgedGates(ctx.log)
  const sum = summaryLine(ctx.log)

  const L = []
  L.push(`CI 红了，自动建单（\`scripts/gates/ci-red-to-issue.mjs\` · ISS-715 ③）。`)
  L.push("")
  L.push("## 现场")
  L.push("")
  L.push(`| 项 | 值 |`)
  L.push(`|---|---|`)
  L.push(`| job | ${ctx.jobs.length ? ctx.jobs.map((j) => `\`${j.name}\``).join(" · ") : "（来自日志，未取 job 名）"} |`)
  L.push(`| commit | \`${ctx.sha || "未知"}\` |`)
  if (ctx.branch) L.push(`| 分支 | \`${ctx.branch}\` |`)
  if (ctx.runId) L.push(`| run | [#${ctx.runId}](${ctx.url}) |`)
  if (sum) L.push(`| 读数 | \`${sum}\` |`)
  L.push("")
  if (ctx.jobs.some((j) => j.steps.length)) {
    L.push("失败步骤：")
    for (const j of ctx.jobs) for (const s of j.steps) L.push(`- \`${j.name}\` → ${s}`)
    L.push("")
  }
  L.push("## 失败格清单")
  L.push("")
  if (red.found && red.gates.length) {
    L.push("| 格 | 名称 |")
    L.push("|---|---|")
    for (const g of red.gates) L.push(`| \`${g.id}\` | ${g.label} |`)
  } else if (red.found) {
    L.push("（日志里有「红名单：」但没抠到格名 —— 输出格式可能变了，见日志原文）")
  } else {
    L.push("（**日志里没有「红名单：」区段** ⇒ 抠不出来。不是「没有红格」：多半是门禁步骤没跑到 / 日志没拿到，见下面链接）")
  }
  L.push("")
  if (unj.length) {
    L.push("判不了（不是绿，也不是红 —— 同 run-gates 口径）：")
    for (const g of unj) L.push(`- \`${g.id}\` ${g.label}`)
    L.push("")
  }
  L.push("## 怎么修")
  L.push("")
  L.push("```bash")
  L.push("# 只跑红的那一格（先 --list 查全表）")
  L.push("node scripts/run-gates.mjs --tier ci --only <格名>")
  L.push("# 复现整档")
  L.push("node scripts/run-gates.mjs --tier ci")
  L.push("```")
  L.push("")
  if (ctx.url) L.push(`原始 run：[${ctx.url}](${ctx.url})`)
  L.push("")
  L.push(`> 自动建单署名 \`${ACTOR}\`；同一 commit 短号 + 同一 job 只建一次（幂等见脚本头注）。`)

  return {
    titleKey,
    title: `CI 红：${titleKey}`,
    body: L.join("\n"),
    fields: { tags: ["type/bug"], priority: "high", status: "todo" },
    red,
    unjudged: unj,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const runId = opt("--run", "")
  const logPath = opt("--log", "")
  if (!runId && !logPath) {
    console.error("✗ 要么 --run <run_id>，要么 --log <日志文件>。两种都没有 = 没有现场可翻。")
    return 2
  }
  const ctx = runId ? fromRun(runId) : fromLog(logPath)
  if (!ctx.ok) {
    console.error(`✗ 取不到现场：${ctx.error}`)
    return 2
  }

  const issue = buildIssue(ctx)
  console.log(`标题：${issue.title}`)
  console.log(`红格：${issue.red.found ? issue.red.gates.length + " 格" : "抠不到（日志里没有「红名单：」）"}`)
  console.log(`判不了：${issue.unjudged.length} 格`)

  const existing = await findExisting(issue.titleKey)
  if (existing.length) {
    console.log(`✓ 已存在同键未结案的单，不重复建：${existing.map((x) => x.id).join(" / ")}`)
    for (const x of existing) console.log(`   ${x.id}（${x.status}）${x.title}`)
    return 0
  }

  if (!flag("--create")) {
    console.log("")
    console.log("── dry-run（没有 --create，不落盘）──────────────────────────")
    console.log(issue.body)
    console.log("────────────────────────────────────────────────────────")
    console.log("真建单：加 --create")
    return 0
  }

  const { createEntityCore } = await import(path.join(ROOT, "forge-pm/lib/entity-ops.js"))
  const out = createEntityCore({ dir: "issues", title: issue.title, body: issue.body, fields: issue.fields, actor: ACTOR })
  if (!out.ok) {
    console.error(`✗ 建单失败（${out.status}）：${out.error}`)
    return 1
  }
  console.log(`✓ 已建单 ${out.id}：${issue.title}`)
  if (out.warnings?.length) for (const w of out.warnings) console.log(`  ! ${w}`)
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 自检：把「日志解析」与「幂等」这两条**会静默失效**的地方变成能咬的断言
// ─────────────────────────────────────────────────────────────────────────────
//
// 为什么值得自检：本文件的价值全在「红了到底有没有建出单」。解析器一旦读不到红名单，
// 症状是**建出一张写着"抠不到"的单**或者干脆不建 —— 两种都静默。故用合成日志反证。
function selftest() {
  const bad = []
  let okN = 0
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) okN++
    else bad.push(`${name}：得 ${JSON.stringify(got)}，应 ${JSON.stringify(want)}`)
  }

  const realish = [
    "run-gates · ci 档 · 144 格 · 10 并发",
    "✓ [140/144]  1.21s lint-layer 分层契约",
    "✓ 133 绿 / ✗ 2 红 / - 0 跳过 · ! 1 判不了（不算绿）   （ci 档 · 300.1s · 10 并发）",
    "红名单：",
    "  ✗ migration-baseline                 迁移基线（ISS-570）",
    "      回归 —— 清单增删",
    "  ✗ client-artifacts                   客户端产物齐",
    "      缺 dist/client.js：forge-ui",
    "判不了（不是绿，也不是红）：",
    "  ! install-shape                      判不了（exit 2）",
    "最慢五格：guard-baselines 301s",
  ].join("\n")

  eq("能抠出红格 id 与条数", redGates(realish).gates.map((g) => g.id), ["migration-baseline", "client-artifacts"])
  eq("能找到「红名单：」区段", redGates(realish).found, true)
  eq("能抠出判不了的格", unjudgedGates(realish).map((g) => g.id), ["install-shape"])
  eq("摘要行原样取出", summaryLine(realish).startsWith("✓ 133 绿"), true)
  // 反控：没有「红名单：」区段时必须 found=false（＝不许把"没读到"当"没有红格"）
  eq("反控：空日志不冒充「零红格」", redGates("跑挂了\n").found, false)
  // 反控：区段存在但一格也没抠到时 gates 为空而 found 为真（两种失败要能区分）
  eq("反控：「红名单：」存在但无格 ⇒ found=true / gates=[]", redGates("红名单：\n最慢五格：x\n"), { found: true, gates: [] })
  // 边界：判不了区段后面紧跟红名单也不再往回收（避免两个区段互相吞）
  eq("边界：判不了区段不越界吞红名单", unjudgedGates(["判不了（不是绿，也不是红）：", "  ! a  x", "红名单：", "  ✗ b  y"].join("\n")).map((x) => x.id), ["a"])

  eq("标题键含 sha 短号与 job 名", buildIssue({ sha: "abcdef1234", branch: "main", url: "", runId: "", jobs: [{ name: "check", steps: ["门禁"] }], log: realish }).titleKey, "check / abcdef12")
  eq("标题以「CI 红：」开头（工单硬要求）", buildIssue({ sha: "abcdef1234", jobs: [], log: realish, url: "", runId: "", branch: "" }).title.startsWith("CI 红："), true)
  eq("日志里没有红名单时正文必须明说抠不到", buildIssue({ sha: "a", jobs: [], log: "什么都没有", url: "", runId: "", branch: "" }).body.includes("日志里没有「红名单：」区段"), true)
  // ── 幂等解析（ISS-715 实测踩到过：findExisting 读了不存在的 `it.full` ⇒ 静默失效 ⇒ 重复建单）──
  // 两条都要：真正的单被认出，且 done/canceled 的单**不**参与去重（否则修好后再红就永远建不出新单）。
  eq("幂等：认得出 todo 的同键单", existingFrom([{ dir: "issues", fmId: "ISS-001", title: "CI 红：x / abc12345", status: "todo", deleted: false }], "x / abc12345").map((h) => h.id), ["ISS-001"])
  eq("幂等：done/canceled 不参与去重（修好后又红要能建新单）", existingFrom([{ dir: "issues", fmId: "ISS-002", title: "CI 红：x / abc12345", status: "done", deleted: false }], "x / abc12345"), [])

  if (bad.length) {
    console.log("✗ ci-red-to-issue 自检失败：")
    for (const b of bad) console.log(`  ✗ ${b}`)
    console.log(`✗ ${bad.length} 项不过（${okN} 项通过）`)
    return 1
  }
  console.log(`✓ ${okN}/${okN} 项通过：日志解析两态可分 · 判不了区段不越界 · 标题形状对`)
  return 0
}

if (import.meta.main) {
  if (flag("--selftest")) process.exit(selftest())
  else process.exit(await main())
}

export { redGates, unjudgedGates, summaryLine, buildIssue }
