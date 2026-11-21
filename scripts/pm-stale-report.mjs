#!/usr/bin/env node
// scripts/pm-stale-report.mjs —— 存量「超期单」与「僵尸项目」的报告型清单（ISS-609 · L1.2 / L1.3）
//
// 为什么需要它：Matter 的病根是「只进不出」—— 单子进来之后没有任何触发点让它出去。
// 本脚本只做一件事：把「挂太久的」和「名义上活着、实际不动的」算出来，摆给人看。
// **它不关单、不改状态、不阻断任何流程**（见下面「只报不红」）。
//
// ── 口径 A：超期单（L1.2）──────────────────────────────────────────────
//   · 阈值（老板 2026-10-17 批「同意，建议」）：`in_review` > 7 天 · `backlog` > 30 天。
//     **参数化**，按需覆盖；改口径只改命令行，不改代码。
//   · 边界取**严格大于**：龄期 == 阈值当天**不报**，第 阈值+1 天才报（in_review 从第 8 天起报）。
//     字面就是「压 7 天」的口径；selftest 里有一条专门钉住这个边界，防止日后被人手改成 >=。
//   · 龄期起点 = **进入当前状态的那一刻** —— 取活动日志里最后一条把它带进当前状态的
//     `status-change` 事件的时刻。没有状态变更事件的（建单即 backlog）退回建单时刻。
//     ⚠️ **不拿 `created` 直接算**：否则「9 月建的单、10 月才转 in_review」会被误报成超期，
//     而它在 in_review 里其实只待了几天。这是本次对账（L1.1）实测出来的坑。
//   · **只报不红**：默认退出码**恒为 0**（`--fail-on=off`）。要接 CI 再显式开 `any`。
//
// ── 口径 B：僵尸项目（L1.3 · 满足任一即认定）────────────────────────────
//   Z1 终态未归档：status = completed 且未转 archived（项目域无 done/canceled，见 collectZombieProjects 注释）
//   Z2 计划未启动：status = planned 且自建单起 > <idle-days>
//   Z3 挂起超期  ：status = paused 且自最后一次状态变更 > <idle-days>
//   Z4 活跃无活动：status ∈ {active, in_progress} 且最后活动时刻距今 > <idle-days>
//   Z4 是「僵尸」的本义（名义活着、实际不动）；Z1~Z3 是生命周期缺终态。
//   本脚本对僵尸项目**只提议不执行** —— 项目状态变更属「先报后动」。
//
// ── 用法 ───────────────────────────────────────────────────────────────
//   node scripts/pm-stale-report.mjs                    # 只报，退出码 0
//   node scripts/pm-stale-report.mjs --json             # 机器可读（含 readAt / asOf / 口径）
//   node scripts/pm-stale-report.mjs --in-review-days=7 --backlog-days=30 --idle-days=30
//   node scripts/pm-stale-report.mjs --scope=issues|projects|all
//   node scripts/pm-stale-report.mjs --fail-on=off|any|issues|projects
//   node scripts/pm-stale-report.mjs --as-of=2026-10-17 # 固化「今天」⇒ 结果可复算
//   node scripts/pm-stale-report.mjs --root=<目录>       # 钉隔离根（缺省读生产根，**只读**）
//   node scripts/pm-stale-report.mjs --selftest         # 临时 fixture 反向验证，不碰真实根
//
// 退出码：0 = 正常（含「有超期但 fail-on=off」）· 1 = --fail-on 命中 · 2 = 用法/环境错

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DAY = 86400000

// ── 参数 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    root: "",
    inReviewDays: 7,
    backlogDays: 30,
    idleDays: 30,
    scope: "all",
    failOn: "off",
    asOf: "",
    limit: 30,
    json: false,
    selftest: false,
    help: false,
  }
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/)
    if (!m) throw new Error(`不认识的参数：${a}（--help 看用法）`)
    const [, k, v] = m
    switch (k) {
      case "root": o.root = v ?? ""; break
      case "in-review-days": o.inReviewDays = num(k, v); break
      case "backlog-days": o.backlogDays = num(k, v); break
      case "idle-days": o.idleDays = num(k, v); break
      case "scope": o.scope = v ?? "all"; break
      case "fail-on": o.failOn = v ?? "off"; break
      case "as-of": o.asOf = v ?? ""; break
      case "limit": o.limit = num(k, v); break
      case "json": o.json = true; break
      case "selftest": o.selftest = true; break
      case "help": o.help = true; break
      default: throw new Error(`不认识的参数：--${k}`)
    }
  }
  if (!["off", "any", "issues", "projects"].includes(o.failOn)) throw new Error(`--fail-on 只认 off|any|issues|projects，收到 ${o.failOn}`)
  if (!["all", "issues", "projects"].includes(o.scope)) throw new Error(`--scope 只认 all|issues|projects，收到 ${o.scope}`)
  if (o.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(o.asOf)) throw new Error(`--as-of 要 YYYY-MM-DD，收到 ${o.asOf}`)
  return o
}
function num(k, v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} 要非负数字，收到 ${v}`)
  return n
}

/** 缺省根：显式 --root > 环境变量 > 生产盘（~/.dsh-matter/pm）> App 盘（~/.dsh/pm）。只读。 */
function defaultRoot() {
  if (process.env.MATTER_PM_ROOT) return process.env.MATTER_PM_ROOT
  for (const p of [path.join(os.homedir(), ".dsh-matter", "pm"), path.join(os.homedir(), ".dsh", "pm")]) {
    if (fs.existsSync(path.join(p, "issues"))) return p
  }
  return path.join(os.homedir(), ".dsh-matter", "pm")
}

// ── 解析 ────────────────────────────────────────────────────────────────
/** 只读 frontmatter 的**单行标量**；结构化字段（数组/对象）原样留字符串 —— 本脚本不消费它们。 */
function readFrontmatter(text) {
  if (!text.startsWith("---")) return {}
  const end = text.indexOf("\n---", 3)
  if (end < 0) return {}
  const out = {}
  for (const line of text.slice(4, end).split("\n")) {
    const i = line.indexOf(":")
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) continue
    out[k] = line.slice(i + 1).trim()
  }
  return out
}

/** 活动日志 → 事件数组。块间用 `\n---\n` 分隔，只取带 `event:` 标头的块。 */
function readEvents(activityPath) {
  let raw = ""
  try {
    raw = fs.readFileSync(activityPath, "utf8")
  } catch {
    return []
  }
  const out = []
  for (const block of raw.split(/\n---\n(?=type: activity-log)/).slice(1)) {
    const g = (k) => {
      const m = block.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))
      return m ? m[1].trim() : ""
    }
    const event = g("event")
    if (!event) continue
    out.push({ event, at: g("at"), from: g("from"), to: g("to"), field: g("field") })
  }
  return out
}

const ms = (iso) => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : NaN
}

/** 某一状态段的起点 = 最后一条 `status-change` 且 `to === 当前态`；退回建单时刻。
 *  返回 source 是为了让报告能区分「真的按状态变更算」与「退回了建单日」—— 两者的可信度不同。 */
function statusEnteredAt(events, status, fallbackCreated) {
  let best = ""
  for (const e of events) if (e.event === "status-change" && e.to === status && e.at) best = e.at
  if (best) return { at: best, source: "status-change" }
  const c = events.find((e) => e.event === "created" && e.at)
  if (c) return { at: c.at, source: "created-event" }
  if (fallbackCreated) return { at: `${fallbackCreated}T00:00:00Z`, source: "frontmatter.created" }
  return { at: "", source: "unknown" }
}

function listEntityFiles(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((f) => f.endsWith(".md") && !/-(activity|comments)\.md$/.test(f))
    .sort()
    .map((f) => ({ file: path.join(dir, f), rel: path.join(path.basename(dir), f) }))
}

// ── 口径 A：超期单 ──────────────────────────────────────────────────────
const STALE_STATUS = () => ({
  in_review: "in-review",
  backlog: "backlog",
})

function collectStaleIssues(root, o, now) {
  const thresholds = { in_review: o.inReviewDays, backlog: o.backlogDays }
  const rows = []
  const unreadable = []
  const seenIds = new Map()
  for (const { file, rel } of listEntityFiles(path.join(root, "issues"))) {
    let text = ""
    try {
      text = fs.readFileSync(file, "utf8")
    } catch (e) {
      unreadable.push({ rel, why: String(e && e.message) })
      continue
    }
    const fm = readFrontmatter(text)
    const status = fm.status || ""
    const limit = thresholds[status]
    if (limit === undefined) continue // 非 in_review / backlog ⇒ 不在本口径内
    const events = readEvents(file.replace(/\.md$/, "-activity.md"))
    const entered = statusEnteredAt(events, status, fm.created)
    const startMs = ms(entered.at) || ms(fm.created) || NaN
    if (!Number.isFinite(startMs)) {
      unreadable.push({ rel, why: `龄期起点读不到（status=${status}，无 status-change 也无 created）` })
      continue
    }
    const ageDays = Math.floor((now - startMs) / DAY)
    if (ageDays <= limit) continue
    const id = fm.id || path.basename(file, ".md")
    // 重号：同一 id 出现在多份文件（本库实测存在，例 ISS-271 / ISS-273）⇒ 必须标出来，
    // 否则报告里出现两行同名、读的人不知道是「重复行」还是「两张不同的单」。
    const dupOf = seenIds.has(id) ? seenIds.get(id) : null
    if (!dupOf) seenIds.set(id, rel)
    rows.push({
      id,
      rel,
      dupOf,
      status,
      ageDays,
      limitDays: limit,
      enteredAt: entered.at,
      enteredSource: entered.source,
      overByDays: ageDays - limit,
      title: (fm.title || "").slice(0, 70),
    })
  }
  rows.sort((a, b) => b.ageDays - a.ageDays)
  const dups = [...seenIds.keys()].filter((id) => rows.filter((r) => r.id === id).length > 1)
  return { rows, unreadable, thresholds, dups }
}

// ── 口径 B：僵尸项目 ────────────────────────────────────────────────────
function collectZombieProjects(root, o, now) {
  const rows = []
  const unreadable = []
  for (const { file, rel } of listEntityFiles(path.join(root, "projects"))) {
    let text = ""
    try {
      text = fs.readFileSync(file, "utf8")
    } catch (e) {
      unreadable.push({ rel, why: String(e && e.message) })
      continue
    }
    const fm = readFrontmatter(text)
    const status = fm.status || ""
    if (!status) {
      unreadable.push({ rel, why: "无 status 字段 ⇒ 不判（不许猜）" })
      continue
    }
    const events = readEvents(file.replace(/\.md$/, "-activity.md"))
    const lastAt = events.map((e) => e.at).filter(Boolean).sort().pop() || ""
    const entered = statusEnteredAt(events, status, fm.created)
    const idleStartMs = ms(lastAt) || ms(fm.created) || NaN
    const idleDays = Number.isFinite(idleStartMs) ? Math.floor((now - idleStartMs) / DAY) : null
    const inStateDays = (() => {
      const t = ms(entered.at)
      return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null
    })()

    const reasons = []
    // Z1 口径（2026-10-20 修正 · 入库时发现的错口径）：项目域状态词表是
    // `planned｜active｜paused｜completed｜archived`（真相源 `forge-pm/src/pm/api.ts` PROJECT_STATUS_LABEL），
    // **没有 done / canceled** —— 原实现判 `done | canceled` 在真实数据上恒不命中（等于没这条判据）。
    // 终态 = `completed`；未归档 = 仍是 completed 而非 archived。
    if (status === "completed") reasons.push("Z1")
    if (status === "planned" && inStateDays !== null && inStateDays > o.idleDays) reasons.push("Z2")
    if (status === "paused" && entered.source === "status-change" && inStateDays !== null && inStateDays > o.idleDays) reasons.push("Z3")
    if ((status === "active" || status === "in_progress") && idleDays !== null && idleDays > o.idleDays) reasons.push("Z4")
    if (!reasons.length) continue

    rows.push({
      id: fm.id || path.basename(file, ".md"),
      rel,
      status,
      created: fm.created || "",
      lastActivityAt: lastAt,
      idleDays,
      inStateDays,
      reasons,
      title: (fm.title || "").slice(0, 60),
    })
  }
  const rank = { Z1: 0, Z2: 1, Z3: 2, Z4: 3 }
  rows.sort((a, b) => rank[a.reasons[0]] - rank[b.reasons[0]] || (b.idleDays ?? -1) - (a.idleDays ?? -1))
  return { rows, unreadable }
}

// ── 渲染 ────────────────────────────────────────────────────────────────
const REASON_TEXT = {
  Z1: "终态未归档（生命周期缺终态）",
  Z2: "planned 长期未启动",
  Z3: "paused 长期挂起",
  Z4: "活跃但长期无活动（僵尸本义）",
}

function renderHuman(rep, o) {
  const L = []
  L.push(`Matter 存量超期/僵尸报告 · asOf=${rep.asOf} · readAt=${rep.readAt}`)
  L.push(`根：${rep.root}（只读；未改任何单据）`)
  L.push(`口径：in_review > ${o.inReviewDays} 天 · backlog > ${o.backlogDays} 天 · 项目闲置 > ${o.idleDays} 天 · fail-on=${o.failOn}`)
  L.push(`边界：龄期取**严格大于**（== 阈值当天不报）`)
  L.push("")
  if (o.scope === "all" || o.scope === "issues") {
    const n = rep.staleIssues.count
    L.push(`【超期单】${n} 张（in_review ${rep.staleIssues.byStatus.in_review || 0} · backlog ${rep.staleIssues.byStatus.backlog || 0}）`)
    if (rep.staleIssues.dups.length) L.push(`  ⚠️ 重号 ${rep.staleIssues.dups.length} 组（同一 id 多份文件，行尾标 ⟳）：${rep.staleIssues.dups.join(" · ")}`)
    const shown = o.limit === 0 ? rep.staleIssues.rows : rep.staleIssues.rows.slice(0, o.limit)
    for (const r of shown) {
      const src = r.enteredSource === "status-change" ? "" : `⟨源:${r.enteredSource}⟩`
      L.push(`  ${String(r.id).padEnd(11)} ${r.status.padEnd(9)} 挂 ${String(r.ageDays).padStart(3)} 天（超 ${String(r.overByDays).padStart(2)}）起于 ${(r.enteredAt || "?").slice(0, 10)}${src}${r.dupOf ? " ⟳" : ""} ${r.title}`)
    }
    if (shown.length < n) L.push(`  …（共 ${n} 张，此处只列前 ${shown.length}；全量用 --json，或 --limit=0 打印全部）`)
    if (rep.staleIssues.unreadable.length) L.push(`  ⚠️ 读不到 ${rep.staleIssues.unreadable.length} 条：${rep.staleIssues.unreadable.map((u) => u.rel).join(", ")}`)
    L.push("")
  }
  if (o.scope === "all" || o.scope === "projects") {
    const n = rep.zombieProjects.count
    L.push(`【僵尸项目】${n} 个（${rep.zombieProjects.byReason.map((x) => `${x.reason} ${x.count}`).join(" · ")}）`)
    for (const r of rep.zombieProjects.rows) {
      L.push(`  ${String(r.id).padEnd(9)} ${r.status.padEnd(12)} [${r.reasons.join("+")}] 闲置 ${r.idleDays === null ? "?" : r.idleDays} 天 · 建单 ${r.created} ${r.title}`)
      L.push(`      ${r.reasons.map((x) => REASON_TEXT[x]).join("；")}`)
    }
    if (!n) L.push("  （无）")
    if (rep.zombieProjects.unreadable.length) L.push(`  ⚠️ 不判 ${rep.zombieProjects.unreadable.length} 个：${rep.zombieProjects.unreadable.map((u) => `${u.rel}（${u.why}）`).join("; ")}`)
    L.push("")
  }
  L.push("只报不红：本报告不阻断任何流程；默认退出码 0。要接 CI 用 --fail-on=any|issues|projects。")
  return L.join("\n")
}

function buildReport(root, o, now) {
  const readAt = new Date(now).toISOString()
  const asOf = o.asOf || readAt.slice(0, 10)
  const rep = { root, readAt, asOf, criteria: { inReviewDays: o.inReviewDays, backlogDays: o.backlogDays, idleDays: o.idleDays, failOn: o.failOn, scope: o.scope }, staleIssues: null, zombieProjects: null }
  if (o.scope === "all" || o.scope === "issues") {
    const s = collectStaleIssues(root, o, now)
    const byStatus = {}
    for (const r of s.rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1
    rep.staleIssues = { count: s.rows.length, byStatus, thresholds: s.thresholds, dups: s.dups, rows: s.rows, unreadable: s.unreadable }
  }
  if (o.scope === "all" || o.scope === "projects") {
    const z = collectZombieProjects(root, o, now)
    const byReason = ["Z1", "Z2", "Z3", "Z4"].map((reason) => ({ reason, count: z.rows.filter((r) => r.reasons.includes(reason)).length })).filter((x) => x.count)
    rep.zombieProjects = { count: z.rows.length, byReason, rows: z.rows, unreadable: z.unreadable }
  }
  return rep
}

function exitFor(rep, o) {
  if (o.failOn === "off") return 0
  const nIssues = rep.staleIssues ? rep.staleIssues.count : 0
  const nProj = rep.zombieProjects ? rep.zombieProjects.count : 0
  if (o.failOn === "any") return nIssues + nProj > 0 ? 1 : 0
  if (o.failOn === "issues") return nIssues > 0 ? 1 : 0
  return nProj > 0 ? 1 : 0
}

// ── 自检（临时 fixture，**绝不碰真实根**）──────────────────────────────
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-stale-selftest-"))
  const fails = []
  const ok = (cond, msg) => {
    console.log(`${cond ? "✓" : "✗"} ${msg}`)
    if (!cond) fails.push(msg)
  }
  const day = (n) => new Date(Date.now() - n * DAY).toISOString()
  const DAYS = day

  const write = (kind, name, fm, events) => {
    const dir = path.join(tmp, kind)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name + ".md"), `---\ntype: ${kind === "issues" ? "issue" : "project"}\n${fm}\n---\n\n正文占位\n`)
    fs.writeFileSync(path.join(dir, name + "-activity.md"), `---\ntype: activity-log\nfor: ${kind}/${name}.md\n---\n\n` + events.map((e) => `---\ntype: activity-log\nfor: ${kind}/${name}.md\nevent: ${e.event}\nat: ${e.at}\n${e.from ? `from: ${e.from}\n` : ""}${e.to ? `to: ${e.to}\n` : ""}---\n\n`).join(""))
  }

  const NOW = Date.now()
  const dayAgo = (n) => new Date(NOW - n * DAY).toISOString()

  // 单（issues）
  write("issues", "2026-01-01-ISS-0001-over", "id: ISS-0001\nstatus: in_review\ncreated: 2026-01-01\ntitle: 超期 in_review", [{ event: "created", at: dayAgo(100) }, { event: "status-change", at: dayAgo(10), from: "backlog", to: "in_review" }])
  write("issues", "2026-01-02-ISS-0002-fresh", "id: ISS-0002\nstatus: in_review\ncreated: 2026-01-02\ntitle: 未超期 in_review", [{ event: "created", at: dayAgo(3) }, { event: "status-change", at: dayAgo(3), from: "backlog", to: "in_review" }])
  write("issues", "2026-01-03-ISS-0003-backlog-over", "id: ISS-0003\nstatus: backlog\ncreated: 2026-01-03\ntitle: 超期 backlog（无状态变更，退回建单）", [{ event: "created", at: dayAgo(40) }])
  write("issues", "2026-01-04-ISS-0004-backlog-fresh", "id: ISS-0004\nstatus: backlog\ncreated: 2026-01-04\ntitle: 未超期 backlog", [{ event: "created", at: dayAgo(5) }])
  write("issues", "2026-01-05-ISS-0005-done", "id: ISS-0005\nstatus: done\ncreated: 2026-01-05\ntitle: 终态不进超期清单", [{ event: "created", at: dayAgo(200) }])
  // ★ 关键反差：created 很老、但刚转 in_review ⇒ **不该**被报（证明龄期起点不是 created）
  write("issues", "2026-01-06-ISS-0006-oldcreated", "id: ISS-0006\nstatus: in_review\ncreated: 2026-01-06\ntitle: created 老但刚转 in_review", [{ event: "created", at: dayAgo(300) }, { event: "status-change", at: dayAgo(1), from: "in_progress", to: "in_review" }])

  // 项目（projects）
  write("projects", "2026-01-10-PRJ-101-done", "id: PRJ-101\nstatus: completed\ncreated: 2026-01-10\ntitle: 终态未归档", [{ event: "created", at: dayAgo(60) }])
  write("projects", "2026-01-11-PRJ-102-planned", "id: PRJ-102\nstatus: planned\ncreated: 2026-01-11\ntitle: planned 未启动", [{ event: "created", at: dayAgo(40) }])
  write("projects", "2026-01-12-PRJ-103-paused", "id: PRJ-103\nstatus: paused\ncreated: 2026-01-12\ntitle: paused 挂起", [{ event: "created", at: dayAgo(80) }, { event: "status-change", at: dayAgo(45), from: "active", to: "paused" }])
  write("projects", "2026-01-13-PRJ-104-活跃无活动", "id: PRJ-104\nstatus: active\ncreated: 2026-01-13\ntitle: 活跃无活动", [{ event: "created", at: dayAgo(90) }, { event: "field-change", at: dayAgo(45) }])
  write("projects", "2026-01-14-PRJ-105-健康", "id: PRJ-105\nstatus: active\ncreated: 2026-01-14\ntitle: 健康", [{ event: "created", at: dayAgo(90) }, { event: "field-change", at: dayAgo(2) }])
  write("projects", "2026-01-15-PRJ-106-无status", "title: 无 status ⇒ 不判", [{ event: "created", at: dayAgo(99) }])
  // ISS-609 入库时的口径钉：`done` 不是项目域词（项目域只有 planned/active/paused/completed/archived），
  // 它曾经被当成 Z1 的判据 ⇒ 该判据在真实数据上恒不命中。这行夹具保证「改回 done」会立刻红。
  write("projects", "2026-01-16-PRJ-107-done-词表外", "id: PRJ-107\nstatus: done\ncreated: 2026-01-16\ntitle: 词表外状态（不该被判 Z1）", [{ event: "created", at: dayAgo(60) }])

  const run = (argv) => {
    const o = parseArgs(argv)
    o.root = tmp
    return buildReport(tmp, o, NOW)
  }

  // ① 阈值生效 + 龄期起点正确
  const r1 = run(["--as-of=2026-01-01"])
  const ids = r1.staleIssues.rows.map((x) => x.id).sort()
  ok(JSON.stringify(ids) === JSON.stringify(["ISS-0001", "ISS-0003"]), `超期单 = ISS-0001(10天 in_review) + ISS-0003(40天 backlog)，实得 [${ids.join(",")}]`)
  ok(!ids.includes("ISS-0006"), "ISS-0006（created 300 天前、1 天前才转 in_review）**不报** —— 证明龄期起点取的是状态变更时刻，不是 created")
  ok(!ids.includes("ISS-0002") && !ids.includes("ISS-0004"), "阈值内的两张不报")
  ok(!ids.includes("ISS-0005"), "done 不进超期口径")

  // ② 阈值参数化 + 边界语义（严格大于）
  const ids20 = run(["--in-review-days=20"]).staleIssues.rows.map((x) => x.id)
  ok(!ids20.includes("ISS-0001"), "--in-review-days=20 ⇒ ISS-0001(10天) 不再算超期（阈值真的参数化了）")
  const ids0 = run(["--in-review-days=0", "--backlog-days=0"]).staleIssues.rows.map((x) => x.id).sort()
  ok(JSON.stringify(ids0) === JSON.stringify(["ISS-0001", "ISS-0002", "ISS-0003", "ISS-0004", "ISS-0006"]), `阈值归零 ⇒ 五张非终态全部浮出（含 created 300 天前、1 天前才转 in_review 的 ISS-0006），实得 [${ids0.join(",")}]`)
  const ids3 = run(["--in-review-days=3", "--backlog-days=3"]).staleIssues.rows.map((x) => x.id)
  ok(!ids3.includes("ISS-0002"), "边界：龄期 == 阈值当天**不报**（ISS-0002 恰好 3 天，--in-review-days=3 ⇒ 不报）⇒ 判据是 >，不是 >=")

  // ③ 演示三段：造 → 浮出 → 撤下 → 消失
  const demoDir = path.join(tmp, "demo")
  write("issues", "2026-01-20-ISS-918-demo", "id: ISS-918\nstatus: in_review\ncreated: 2026-01-20\ntitle: 演示用超期单", [{ event: "created", at: dayAgo(30) }, { event: "status-change", at: dayAgo(9), from: "backlog", to: "in_review" }])
  const before = run([]).staleIssues.rows.map((x) => x.id)
  ok(before.includes("ISS-918"), "演示 ①造：新写的超期单立刻浮出")
  for (const f of ["2026-01-20-ISS-918-demo.md", "2026-01-20-ISS-918-demo-activity.md"]) fs.unlinkSync(path.join(tmp, "issues", f))
  const after = run([]).staleIssues.rows.map((x) => x.id)
  ok(!after.includes("ISS-918"), "演示 ②撤：文件移走后该单立刻消失")
  ok(before.length === after.length + 1, `演示 ③计数守恒：浮出前 ${before.length} → 撤下后 ${after.length}（差 1）`)

  // ④ 僵尸项目四档 + 不判
  const z = run([]).zombieProjects
  const zim = Object.fromEntries(z.rows.map((x) => [x.id, x.reasons.join("+")]))
  ok(zim["PRJ-101"] === "Z1", `PRJ-101 终态未归档 ⇒ Z1（实得 ${zim["PRJ-101"]}）`)
  ok(!zim["PRJ-107"], `PRJ-107 项目 status=done 是**词表外**值，不该被当成 Z1 终态（实得 ${zim["PRJ-107"] || "不报"}）—— 这条钉住「Z1 判 completed 而非 done」`)
  ok(zim["PRJ-102"] === "Z2", `PRJ-102 planned 40 天 ⇒ Z2（实得 ${zim["PRJ-102"]}）`)
  ok(zim["PRJ-103"] === "Z3", `PRJ-103 paused 45 天 ⇒ Z3（实得 ${zim["PRJ-103"]}）`)
  ok(zim["PRJ-104"] === "Z4", `PRJ-104 active 45 天无活动 ⇒ Z4（实得 ${zim["PRJ-104"]}）`)
  ok(!zim["PRJ-105"], "PRJ-105 两天前有活动 ⇒ 不判僵尸")
  ok(z.unreadable.some((u) => u.rel.includes("PRJ-106")), "PRJ-106 无 status ⇒ 进「不判」名单，而不是被猜成某档")

  // ⑤ 只报不红：默认 0；显式开才非零
  const o = parseArgs([])
  ok(exitFor(run([]), o) === 0, "默认 --fail-on=off ⇒ 有超期也退 0（只报不红）")
  ok(exitFor(run([]), parseArgs(["--fail-on=any"])) === 1, "--fail-on=any ⇒ 有超期退 1（有牙，但默认不开）")
  // 阈值拉到不可能命中 + 只看 issues（Z1「终态未归档」按设计无阈值，故必须排除 projects 才谈得上"零命中"）
  const zeroHit = buildReport(tmp, { ...parseArgs(["--scope=issues"]), root: tmp, inReviewDays: 9999, backlogDays: 9999 }, NOW)
  ok(exitFor(zeroHit, parseArgs(["--fail-on=any"])) === 0, "--fail-on=any + 零命中 ⇒ 退 0（自证 --fail-on 不是恒 1）")

  // ⑥ 重号：同一 id 多份文件必须被标出来（本库实测存在：ISS-271 / ISS-273 各两个文件）
  write("issues", "2026-02-01-ISS-913-dup-a", "id: ISS-913\nstatus: in_review\ncreated: 2026-02-01\ntitle: 重号 A", [{ event: "created", at: dayAgo(30) }])
  write("issues", "2026-02-02-ISS-913-dup-b", "id: ISS-913\nstatus: in_review\ncreated: 2026-02-02\ntitle: 重号 B", [{ event: "created", at: dayAgo(30) }])
  const dupRep = run([]).staleIssues
  ok(dupRep.rows.filter((r) => r.id === "ISS-913").length === 2, "重号的同一 id 两份文件都进清单（不静默去重）")
  ok(dupRep.dups.includes("ISS-913"), `重号在 dups 里点名（实得 [${dupRep.dups.join(",")}]）`)
  ok(dupRep.rows.find((r) => r.title === "重号 B").dupOf !== null, "第二份带 dupOf 标记 ⇒ 报告里能分辨「重复行」与「两张不同的单」")

  // ⑦ 龄期来源要可辨（退回建单日的行必须标出来，不能让读的人以为都按状态变更算）
  const src = Object.fromEntries(run([]).staleIssues.rows.map((r) => [r.id, r.enteredSource]))
  ok(src["ISS-0003"] === "created-event", `无状态变更的单，来源标 created-event（实得 ${src["ISS-0003"]}）`)
  ok(src["ISS-0001"] === "status-change", `有状态变更的单，来源标 status-change（实得 ${src["ISS-0001"]}）`)

  // ⑧ 根不存在 ⇒ 不虚报空态
  const missing = buildReport(path.join(tmp, "nope"), parseArgs([]), NOW)
  ok(missing.staleIssues.count === 0 && missing.zombieProjects.count === 0, "根不存在时返回 0 条（调用方需自行分辨「真空」与「读不到」）")

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${fails.length === 0 ? "✓" : "✗"} selftest ${fails.length === 0 ? "全部通过" : `失败 ${fails.length} 条`}（fixture 落在临时目录，已清理；**未读写真实 Matter 根**）`)
  return fails.length === 0 ? 0 : 1
}

// ── main ────────────────────────────────────────────────────────────────
function main() {
  let o
  try {
    o = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`✗ ${e.message}`)
    process.exit(2)
  }
  if (o.help) {
    console.log(fs.readFileSync(new URL(import.meta.url).pathname, "utf8").split("\n").slice(0, 40).join("\n"))
    return 0
  }
  if (o.selftest) return selftest()

  const root = o.root || defaultRoot()
  if (!fs.existsSync(path.join(root, "issues"))) {
    console.error(`✗ 根 ${root} 下没有 issues/ —— 拒绝对不存在的根报「0 条」（那会把读不到说成真的空）。用 --root 指定。`)
    return 2
  }
  const now = o.asOf ? Date.parse(`${o.asOf}T00:00:00Z`) : Date.now()
  const rep = buildReport(root, o, now)
  if (o.json) console.log(JSON.stringify(rep, null, 2))
  else console.log(renderHuman(rep, o))
  return exitFor(rep, o)
}

process.exit(main())
