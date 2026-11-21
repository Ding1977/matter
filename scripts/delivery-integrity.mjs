// 交付完整性对照（ISS-696 · 建议落在 PRJ-016 待拍表第 5 行 · 只报不红）
//
// 要治的是什么：本仓对「干了活没交代」与「交代了找不到落点」这两件事**没有任何判据**。老板 09-23 要的是
// "能防止结果倒退的机制"，而交付链这一维此前只被我手工核过一次（PRJ-016 的 53 张全部在 main 有带号提交）——
// 手工核过一次不等于有机制，下一批单照样会漏。本脚本把那次性的核对提成可重跑的对照。
//
// 两象限（口径 = Matter issue 域单的 frontmatter × `git log main` 正文里出现过的 `ISS-NNN`）：
//   A｜已交代但主干无带号：status ∈ {in_review, done} 而主干提交信息里查不到这个号 ⇒ "说了，没找到落点"；
//   B｜主干有带号但未推进：号在主干出现过，而 status ∈ {todo, backlog, in_progress} ⇒ "有落点，没交代"。
// ⚠️ **两象限都只报不红**，因为"提交信息里出现单号"既不充分也不必要：
//   不充分 = 别的提交只是引用它（报告、派生单、父单代审都会点名）；不必要 = 活被 squash 进父提交、
//   或压根干在别的仓库（PM 库存的是跨仓库的单，早期还没有带号纪律）。判红 = 按构造造假红。
//   ⇒ 计数走基线只报趋势；**点名只点"近 N 天内创建"的**（新单没有历史包袱，漏了就是真漏）。
//   升红的门槛留在 --strict 那段注释里：先跑一段看假红率，再决定，别第一天就红着让人无视。
// 第三件输出（也是只报）：给每条 A 找**疑似落点** —— 拿标题与提交标题求最长公共片段，≥8 字算"疑似落点"、6~7 字标成"弱线索"，
//   并写出该提交实际挂的号（父单收口的样子）与"被几张 A 单同时命中"（伞形提交的样子）。
//   这是把手工抽查提成机制：09-23 抽查实测两类形态都在 —— `e5ee231` 干的是 ISS-672 的活却挂 ISS-652（真挂错），
//   `fcb9f99` 挂父单 ISS-652 收口 ISS-652 Phase 1（合法伞形，不是缺陷）。所以这条只给线索、不给判决。
// ⚠️ 落地当天就撞到一个自造读数漂移：**A 的语义是"没被任何提交正文提到"，不是"没做"**。
//   我为了写这条 note 手算了 `ISS-509 / 637 / 672` 各 0 条提交，然后把这些号写进了提交信息 ——
//   下一次跑本脚本时这三张就自动离开 A 了（被提到 ⇒ 判"有落点"）。所以别把 A 当判决，它是一张"值得看一眼"的清单。
//
// 用法：node scripts/delivery-integrity.mjs [--selftest | --snapshot | --compare | --json] [--days 7] [--repo <path>]
// 退出码（ISS-635 三态，口径同 scripts/ws.sh 的 0 绿 / 1 红 / 2 判不了）：报告档一律 **2 = 判不了** ——
//   本档没有"新增违例"判据（口径"提交正文提到过单号"既不充分也不必要，见文件头）⇒ 不许返回 0 让读取方当成绿，
//   也不许返回 1 把计数漂移当回归。输入读不到（PM 数据根缺席 / main 分支不存在）同样 2，并明说判不了。
//   `--snapshot` / `--json` 是工具档（写基线 / 出机器结果），不受这条约束，仍返回 0。
// ⚠️ 判据函数**故意不 export**：Z2 量的就是"没人 import 的导出"，为自检加 export 会把零引用顶高一格（09-23 红过一次）。
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const A = process.argv
const PM = process.env.FORGE_PM_DIR || path.join(homedir(), ".dsh", "pm", "issues")
const BASE = path.join(ROOT, "scripts", "baseline", "delivery-integrity.json")
const REPO = A.includes("--repo") ? A[1 + A.indexOf("--repo")] : ROOT
const DAYS = Number(A.includes("--days") ? A[1 + A.indexOf("--days")] : 7)
// "本项目时代"的起点：带号纪律（ISS-282 交付链体检 + commit-msg 钩子）落地之后，早于此的不进判据面。
const ERA = "2026-09-08"
const TOLD = new Set(["in_review", "done"])
const UNTOLD = new Set(["todo", "backlog", "in_progress"])

/** 纯判据（不碰 IO，好两头自检）：tickets = [{id,status,created,title}]，seen = 主干出现过的单号集合。 */
function plan(tickets, seen, o) {
  const out = { A: [], B: [], A_old: 0, B_old: 0, judged: 0 }
  for (const t of tickets) {
    if (!/^ISS-\d+$/.test(t.id || "")) continue
    const created = String(t.created || "")
    if (created && created < o.era) continue // 早于带号纪律 ⇒ 不进分母（否则 100+ 张旧单淹没读数）
    out.judged++
    const recent = !o.sinceDate || created >= o.sinceDate
    const has = seen.has(t.id)
    if (TOLD.has(t.status) && !has) {
      if (recent) out.A.push(t)
      else out.A_old++
    } else if (UNTOLD.has(t.status) && has) {
      if (recent) out.B.push(t)
      else out.B_old++
    }
  }
  return out
}

function readCorpus() {
  const body = execFileSync("git", ["-C", REPO, "log", "main", "--format=%B"], { encoding: "utf8", maxBuffer: 256 << 20 })
  const seen = new Set()
  for (const m of body.matchAll(/\b(ISS-\d{3,4})\b/g)) seen.add(m[1]) // ⚠️ 用 m[1] 就必须带捕获组（首版漏了括号 ⇒ seen 只有一个 undefined，两象限全瞎）
  // 提交标题单独取一遍（给"疑似落点"用）：`--format=%h\x1f%s` ⇒ 一行一条，分隔符不会出现在标题里
  const commits = execFileSync("git", ["-C", REPO, "log", "main", "--format=%h\x1f%s"], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [h, ...rest] = l.split("\x1f")
      return { h, s: rest.join(" ") }
    })
  const tickets = readdirSync(PM)
    .filter((f) => f.endsWith(".md") && !/-activity\.md$|-comments\.md$/.test(f))
    .map((f) => {
      const fm = readFileSync(path.join(PM, f), "utf8").split("\n---")[0]
      const g = (k) => (fm.match(new RegExp("^" + k + ": (.*)$", "m")) || [, ""])[1].trim()
      return { id: g("id") || (f.match(/ISS-\d+/) || ["?"])[0], status: g("status"), created: g("created") || f.slice(0, 10), title: g("title"), file: f }
    })
  return { seen, commits, tickets }
}

const dayOffset = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)

/** 标题归一：去括号标签与标点/空白（提交信息与标题的排版差异不该影响"说的是不是同一件事"的比对）。 */
const normTitle = (s) => String(s || "").replace(/[【\[][^】\]]*[】\]]/g, "").replace(/[\s：:，,。.、/「」“”"'（）()\-—]+/g, "")
/** 最长公共子串（两行滚动 DP）—— 标题与提交说明是"改写过同一句话"，前缀匹配会因一个字不同整体失效，所以比片段而不是比前缀。 */
function longestCommon(a, b) {
  let best = ""
  let prev = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== b[j - 1]) continue
      cur[j] = prev[j - 1] + 1
      if (cur[j] > best.length) best = a.slice(i - cur[j], i)
    }
    prev = cur
  }
  return best
}
/**
 * 「疑似落点」匹配：A 里的单（说做了但主干查无此号）拿标题去撞提交标题，公共片段 ≥6 个字面字符算"像同一件事"，
 * 撞上了却挂着**别的号** ⇒ 就是"活落了、号挂错"（09-23 抽查实证：`e5ee231` 的标题是
 * "ws.sh rm 销毁前先保全未提交内容（工作树批量清理丢改动的根治）"，那是 ISS-672 的活，却挂了 ISS-652）。
 * 只报不判：命中与否都不改 A 的归属、不进任何红 —— 它只是把我"手工抽查"这个动作提成机制。
 */
function matchLanding(title, commits) {
  const nt = normTitle(title)
  if (nt.length < 6) return null // 标题本身太短 ⇒ 撞谁都是噪音，不猜
  let hit = null
  let best = 5
  for (const c of commits) {
    const L = longestCommon(nt, normTitle(c.s))
    if (/^ISS\d/.test(L)) continue // 公共片段只是一个单号引用 ⇒ 那是"父单/伞形提交被点名"，不是"同一件事"，不能算强线索
    if (L.length > best) {
      const ids = [...new Set([...c.s.matchAll(/\b(ISS-\d{3,4})\b/g)].map((x) => x[1]))]
      best = L.length
      hit = { h: c.h, s: c.s, len: L.length, frag: L, ids }
    }
  }
  return hit
}

function renderReport(r, base) {
  const L = [`交付完整性对照 · 判 ${r.p.judged} 张（${r.tickets.length} 张 issue 域单 × 主干带号 ${r.seen.size} 个 · 点名窗口 ${DAYS} 天 · ERA ${ERA}）`]
  if (!base) return L.concat(["  ! 基线缺席 ⇒ 先跑 --snapshot（没基线看得见清单，看不见趋势）"])
  const d = (k, now) => {
    const was = base[k]
    if (was === undefined) return `? → ${now}`
    return `${was} → ${now}${now === was ? "" : now > was ? " ↑ 变多" : " ↓ 变少"}`
  }
  L.push(`  · A 已交代无落点（近窗口）${d("A", r.p.A.length)} · 存量另计 ${d("A_old", r.p.A_old)}`)
  L.push(`  · B 有落点未推进（近窗口）${d("B", r.p.B.length)} · 存量另计 ${d("B_old", r.p.B_old)}`)
  const hits = r.p.A.map((t) => ({ t, m: matchLanding(t.title, r.commits || []) }))
  const share = {}
  for (const h of hits) if (h.m) share[h.m.h] = (share[h.m.h] || 0) + 1
  for (const { t, m } of hits) {
    L.push(`    A ${t.id} ${t.status} · ${String(t.title).slice(0, 52)}`)
    if (!m) {
      L.push(`      ↳ 主干无相近标题的提交 ⇒ 要么真没落点，要么修法落在本仓之外（引擎侧 / settings.yaml / cordis.patch.yml / 纯运行态验证）`)
      continue
    }
    const 强 = m.len >= 8
    const 挂了 = m.ids && m.ids.length ? `它挂 ${m.ids.join("/")}` : "它没挂任何号"
    const 多 = share[m.h] > 1 ? `；同一提交被 ${share[m.h]} 张单命中 ⇒ 更像伞形/批量提交` : ""
    L.push(`      ↳ ${强 ? "疑似落点" : "弱线索（<8 字共同片段，多半是巧合）"} ${m.h}「${m.s.slice(0, 44)}」共同片段 ${m.len} 字「${m.frag}」，${挂了}（不含 ${t.id}）${多}`)
  }
  for (const t of r.p.B) L.push(`    B ${t.id} ${t.status} · ${String(t.title).slice(0, 52)}`)
  if (!r.p.A.length && !r.p.B.length) L.push("    ✓ 近窗口内两象限都是空的")
  L.push("  （两象限只报不红：提交里出现单号既不充分也不必要 ⇒ 判红就是按构造造假红，见文件头）")
  return L
}

function selftest() {
  const cases = []
  const push = (name, ok) => cases.push({ name, ok })
  const T = (id, status, created) => ({ id, status, created, title: "t" + id })
  const O = { era: ERA, sinceDate: "2026-09-15" }
  const a = plan([T("ISS-901", "in_review", "2026-09-20")], new Set(), O)
  push("已交代但主干无带号 ⇒ 进 A（牙：正向）", a.A.length === 1 && a.A[0].id === "ISS-901")
  const b = plan([T("ISS-900", "in_progress", "2026-09-20")], new Set(["ISS-900"]), O)
  push("主干有带号但状态未推进 ⇒ 进 B（牙：正向）", b.B.length === 1 && b.B[0].id === "ISS-900")
  const ok = plan([T("ISS-902", "done", "2026-09-20"), T("ISS-903", "backlog", "2026-09-20"), T("ISS-904", "canceled", "2026-09-20"), T("ISS-905", "todo", "2026-09-20")], new Set(["ISS-902", "ISS-903"]), O)
  push("done 有落点 ⇒ 不报；backlog 有落点 ⇒ 是 B（不是漏报）", ok.A.length === 0 && ok.B.length === 1 && ok.B[0].id === "ISS-903")
  const clean = plan([T("ISS-904", "canceled", "2026-09-20"), T("ISS-905", "todo", "2026-09-20")], new Set(), O)
  push("已取消 / 无落点的待办 ⇒ 一条都不报（牙：反向）", clean.A.length === 0 && clean.B.length === 0 && clean.judged === 2)
  const pre = plan([T("ISS-906", "done", "2026-08-01")], new Set(), O)
  push("早于 ERA 的旧单不进分母也不报", pre.judged === 0 && pre.A.length === 0)
  const outWin = plan([T("ISS-907", "done", "2026-09-10")], new Set(), O)
  push("窗口外的（旧）只进存量计数、不点名", outWin.A.length === 0 && outWin.A_old === 1)
  push("非 issue 域（REV/DOC/PRJ）不进判据面", plan([T("REV-001", "done", "2026-09-20")], new Set(), O).judged === 0)
  // 「疑似落点」匹配：两头都要有牙（真阳性用 09-23 实测那笔挂错号的提交形状做样本）
  const CS = [{ h: "e5ee231", s: "fix(scripts): ws.sh rm 销毁前先保全未提交内容（工作树批量清理丢改动的根治）（ISS-652）" }]
  push("标题片段撞上别的号 ⇒ 报疑似落点（牙：正向）", !!matchLanding("【缺陷】工作树批量清理把未提交改动一起销毁", CS))
  push("标题不相干 ⇒ 不猜（牙：反向）", matchLanding("供应商详情页搜索框不过滤", CS) === null)
  push("标题太短 ⇒ 不猜（防撞谁都是噪音）", matchLanding("修个 bug", CS) === null)
  push("公共片段只是单号引用 ⇒ 不算疑似落点（父单/伞形提交点名不是同一件事）",
    matchLanding("ISS-652 Phase 7：派单入口改造与薄表落库", [{ h: "zzzzzzz", s: "fix(forge-pm): 闸门满=延后不是失败（ISS-652）" }]) === null)
  const bad = cases.filter((c) => !c.ok)
  console.log(bad.length ? "✗ 自检失败：" + bad.map((c) => c.name).join(" / ") : `✓ ${cases.length}/${cases.length} 项通过：两象限各有牙，且三种「不该报」的形态一条不报`)
  process.exit(bad.length ? 1 : 0)
}

if (A.includes("--selftest")) selftest()
if (!existsSync(PM)) {
  console.log(`! 读不到 PM 数据根（${PM}）⇒ 判不了，这不是「没有欠账」（换机 / CI 上的正常态）`)
  process.exit(2)
}
let r
try {
  const c = readCorpus()
  const p = plan(c.tickets, c.seen, { era: ERA, sinceDate: dayOffset(DAYS) })
  r = { seen: c.seen, commits: c.commits, tickets: c.tickets, p }
} catch (e) {
  console.log("! 主干提交读不到（" + String((e && e.message) || e).slice(0, 70) + "）⇒ 判不了")
  process.exit(2)
}
if (A.includes("--snapshot")) {
  writeFileSync(BASE, JSON.stringify({ recordedAt: new Date().toISOString(), repo: path.basename(REPO), days: DAYS, era: ERA, judged: r.p.judged, A: r.p.A.length, B: r.p.B.length, A_old: r.p.A_old, B_old: r.p.B_old }, null, 2))
  console.log(`✓ 基线已存 ${path.relative(ROOT, BASE)}（判 ${r.p.judged} 张 · 近窗口 A ${r.p.A.length} / B ${r.p.B.length} · 存量 A ${r.p.A_old} / B ${r.p.B_old}）`)
  process.exit(0)
}
if (A.includes("--json")) {
  console.log(JSON.stringify({ judged: r.p.judged, A: r.p.A.map((t) => t.id), B: r.p.B.map((t) => t.id), A_old: r.p.A_old, B_old: r.p.B_old }))
  process.exit(0)
}
const base = existsSync(BASE) ? JSON.parse(readFileSync(BASE, "utf8")) : null
for (const l of renderReport(r, base)) console.log(l)
// ISS-635：报告档返回 2（判不了）而不是 0 —— 本档两象限都不构成缺陷判据（见文件头），
// 返回 0 会让守卫把它显示成绿。既不冒充绿，也不拿"计数漂移"造假红。
console.log('判不了 —— 本档只报不判：口径「提交正文提到过单号」既不充分也不必要，没有「新增违例」判据')
process.exit(2)
