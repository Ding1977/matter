#!/usr/bin/env node
// 生成 `skills/linmo-lead/STATE.md` —— Linmo 技能包的**动态部分**。
//
// 为什么这样做（老板 2026-09-30：「再给自己配一个**可动态变化**的 skill」）：
//   skills/<id>/ 支持 `skillFiles: [SKILL.md, STATE.md]` 多文件内联（见 forge-pm/lib/roles.js）。
//   ⇒ 把**稳定的方法**写死在 `SKILL.md`，把**每轮都会变的事实**交给本脚本生成到 `STATE.md`。
//   角色卡 `roles/linmo.md` 声明 `skillFiles: [SKILL.md, STATE.md]` ⇒ 两者一起进系统提示词。
//
// 设计取舍：
//   · **直接扫 PM 数据根的文件**（根取法见下方 PM），不依赖 3210 / MCP 工具（服务坏了它也得出得来 —— 09-30 就坏过一次）；
//   · 只做**统计与清单**，不做判断（判断留给 Lead 本人，脚本不替他想）；
//   · 输出带**生成时间戳**，读到旧时间戳就知道该重跑；
//   · 任何异常都不抛：拿不到的段落写"（读不到）"，**不编造**；
//   · 产物头部**打印实际使用的根**：根不存在就显式写「拿不到」，**不许静默**（诚实的空态）。
//
// 用法：node scripts/gen-lead-state.mjs [--out <path>]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** PM 数据根（ISS-616）。取法**复用仓内既有口径**，不自造变量名：
 *    `FORGE_PM_ROOT`（3210/3211 实跑注入的那条）→ `$DSH_HOME/pm` → 生产盘 `~/.dsh-matter/pm`
 *    （后两条同 `scripts/migrate-phases.mjs` / `scripts/migrate-subtask-parents.mjs`）。
 *  旧写法 `join(homedir(), ".dsh", "pm")` 是**旧 web 盘**：裸跑会静默扫错库，头部还照写旧路径而不报警。 */
const PM = (() => {
  const env = process.env
  const explicit = String(env.FORGE_PM_ROOT || "").trim()
  if (explicit) return explicit
  if (env.DSH_HOME) return join(env.DSH_HOME, "pm")
  return join(env.HOME || homedir(), ".dsh-matter", "pm")
})()
const OUT = (() => {
  const i = process.argv.indexOf("--out")
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : join(process.cwd(), "skills", "linmo-lead", "STATE.md")
})()

const readFm = (p) => {
  try {
    const t = readFileSync(p, "utf8")
    const m = /^---\n([\s\S]*?)\n---/.exec(t)
    const fm = {}
    for (const line of (m ? m[1] : "").split("\n")) {
      const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line)
      if (kv) fm[kv[1]] = kv[2].trim().replace(/^"|"$/g, "")
    }
    return fm
  } catch {
    return {}
  }
}
const lsMd = (dir) => {
  try {
    return readdirSync(join(PM, dir)).filter((f) => f.endsWith(".md") && !/-(activity|comments)\.md$/.test(f))
  } catch {
    return []
  }
}
const sec = (title, lines) => [`## ${title}`, ...(lines.length ? lines : ["（读不到）"])].join("\n")

// ── 未结单 ────────────────────────────────────────────────
const OPEN = new Set(["backlog", "todo", "in_progress", "in_review"])
const CLOSED = new Set(["done", "canceled", "duplicate"])
const byStatus = {}
const openItems = []
for (const f of lsMd("issues")) {
  const p = join(PM, "issues", f)
  const fm = readFm(p)
  const st = fm.status || "?"
  byStatus[st] = (byStatus[st] || 0) + 1
  if (OPEN.has(st)) {
    let mtime = 0
    try { mtime = statSync(p).mtimeMs } catch {}
    openItems.push({ id: fm.id || f, status: st, pri: fm.priority || "-", title: (fm.title || "").slice(0, 46), mtime })
  }
}
const oldest = [...openItems].sort((a, b) => a.mtime - b.mtime).slice(0, 5)

// ── 成员（只报事实：assignable 与原因） ────────────────────
const members = lsMd("members").map((f) => readFm(join(PM, "members", f)))
const memByType = {}
for (const m of members) memByType[m.memberType || "?"] = (memByType[m.memberType || "?"] || 0) + 1
/** 档案侧可判定的 assignable —— 与 `forge-pm/lib/member-registry.js` 的 `assignableOf()` **同口径的那一半**
 *  （`status` + `memberType`）。引擎侧那半（`enabled` / `healthy` / 并发）本脚本读不到（直扫文件、不查引擎），
 *  故不冒充已核 —— 判语里写明"引擎侧未核"。 */
const assignableOfMd = (m) => {
  if (m.status === "removed") return { ok: false, reason: "已移除" }
  if (m.memberType !== "agent") return m.status === "active" ? { ok: true } : { ok: false, reason: "成员已挂起" }
  if (m.status === "suspended") return { ok: false, reason: "已挂起" }
  if (m.status !== "active") return { ok: false, reason: "状态异常" }
  return { ok: true, reason: "" }
}
const byAssignable = members.map((m) => ({ m, asg: assignableOfMd(m) }))
const notAssignable = byAssignable.filter((x) => !x.asg.ok)
/** 成员段的事实行：空档案时写"读不到"的由来（**不冒充"全部可指派"** —— 读不到 ≠ 真的没有）。 */
const asgLine = !members.length
  ? `（读不到成员档案：\`${PM}/members\` 为空或不存在）`
  : notAssignable.length
    ? `**不可指派 ${notAssignable.length} / ${members.length}**：${notAssignable.map(({ m, asg }) => `${m.id || "?"}(${asg.reason})`).join(" · ")}`
    : `**可指派 ${members.length} 名**（按档案 status；引擎启用/健康/并发**未核** —— 本文件只扫文件）`

const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")
const days = (ms) => (ms ? Math.floor((Date.now() - ms) / 86400000) : "?")

const pmMissing = !existsSync(PM)

const out = `# Linmo 当轮状态（**由脚本生成，勿手改**）

> 生成时间：**${new Date().toISOString()}**
> 数据源：${pmMissing
  ? `**拿不到：\`${PM}\` 不存在**（不是"没有数据" —— 是根指错了或盘没起；下面各段一律读不到）`
  : `\`${PM}\`（**直接扫文件**，不依赖服务 —— 服务坏时它也能用）`}
> 重跑：\`node scripts/gen-lead-state.mjs\`（建议每轮开始前或定时跑）

${sec("未结单（Lead 的待办池）", [
  `合计 **${openItems.length}** 张：${fmt(byStatus)}\n`,
  openItems.length ? "**最久没动的 5 张**（可能是僵尸，优先看）：" : "",
  ...oldest.map((i) => `- \`${i.id}\` ${i.status} · ${i.pri} · 已 ${days(i.mtime)} 天 · ${i.title}`),
])}

${sec("成员（human / agent 统一表）", [
  `共 **${members.length}** 名：${fmt(memByType)}`,
  asgLine,
])}

## 怎么用这份状态

1. 先看"未结单最久没动的 5 张" —— 僵尸单优先清（要么推进、要么取消）。
2. **本文件会过期**：判断前先看上面的生成时间戳；超过一轮就重跑。
3. 这份只是**事实**，不是判断 —— 该派谁、该不该批，由 Lead（你）决定。

> 团队协作侧（Agent Teams 的成员与任务板）**不在本文件**：用 \`list_agents\` / \`team_task_list\` 实时查。
`

if (pmMissing) console.error(`⚠️ 数据根不存在：${PM}（产物已写出，但各段为空 —— 请核对根路径）`)

try {
  writeFileSync(OUT, out, "utf8")
  console.log(`✓ 已生成 ${OUT}`)
  console.log(`  数据根 ${PM}${pmMissing ? "（不存在）" : ""} · 未结单 ${openItems.length} · 成员 ${members.length} · 不可指派 ${notAssignable.length}`)
} catch (e) {
  console.error("✗ 写入失败:", e?.message || e)
  process.exit(1)
}
