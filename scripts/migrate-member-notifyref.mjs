#!/usr/bin/env node
// ISS-683 阶段1：成员档案身份字段 `inbox` → `notifyRef` 的存量搬运（一次性，幂等）。
//
// ## 为什么要改这个键名
// 我们的 `inbox`（= 这个成员**收消息的地址**）与 DSH 自己的 `inbox`（= agent 的
// `next-turn`/`next-step` 消息队列，见 `forge-messenger/lib/inflight.js` 的 `agent.inbox`）
// **同名异义**，查的人会以为说的是同一件事。ISS-683 阶段1 拍板改名。
// ⚠️ 改的只是「成员档案里存这个值的字段名」：收件箱 API 的地址语义、`to` 里的写法、
//   `inbox/MSG-NNNN.md` 与 `inbox-cursors.json` 全部不变。
//
// ## 用法（默认 dry-run，写盘要显式 --apply）
//   node scripts/migrate-member-notifyref.mjs              # 只报告
//   node scripts/migrate-member-notifyref.mjs --apply      # 真写（先备份到 <root>/.backup-notifyref-<时间>/）
//   FORGE_PM_ROOT=/tmp/x node scripts/migrate-member-notifyref.mjs   # 指定根（测试/隔离实例）
//
// ## 口径
//   ① **只改键名，不动值**：frontmatter 块里把 `inbox:` 这一行替换成 `notifyRef:`，其余字节不变
//      （不走 serializeFrontmatter 全量重写 —— 那会顺带改引号风格，迁移不该捎带别的事）。
//   ② **幂等**：已有 `notifyRef` 的档案跳过；重跑不产生 diff。
//   ③ **冲突不猜**：同一档案里 `inbox` 与 `notifyRef` 同时存在且值不同 ⇒ 报告并跳过，交人来判。
//   ④ **只碰 members/**：teams/queue/issues 里的 `inbox` 与本次改名无关。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { parseFrontmatter } from "../forge-pm/lib/frontmatter.js"

const PM_ROOT = process.env.FORGE_PM_ROOT
  || (process.env.DSH_HOME ? join(process.env.DSH_HOME, "pm") : join(process.env.HOME || "", ".dsh-matter", "pm"))
const MEMBERS_DIR = join(PM_ROOT, "members")

const APPLY = process.argv.includes("--apply")
const OLD_KEY = "inbox"
const NEW_KEY = "notifyRef"

/** frontmatter 块的文本切片：返回块内起止偏移（不含两条 `---` 行），失败 null。 */
function fmBlockRange(text) {
  const open = /^---\r?\n/.exec(text)
  if (!open) return null
  const start = open[0].length
  const rest = text.slice(start)
  const close = /\n---\r?\n|^---\r?\n/.exec(rest)
  if (!close) return null
  return { start, end: start + close.index }
}

/**
 * 把 frontmatter 块里的第一行 `inbox:` 改成 `notifyRef:`，其余字节原样。
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
function rewriteKey(text) {
  const range = fmBlockRange(text)
  if (!range) return { ok: false, reason: "找不到 frontmatter 块" }
  const block = text.slice(range.start, range.end)
  const lines = block.split("\n")
  const idx = lines.findIndex((l) => new RegExp(`^${OLD_KEY}\\s*:`).test(l))
  if (idx < 0) return { ok: false, reason: `frontmatter 里没有顶格 ${OLD_KEY}: 行（可能是缩进/嵌套形态，不猜）` }
  lines[idx] = lines[idx].replace(new RegExp(`^${OLD_KEY}`), NEW_KEY)
  const next = text.slice(0, range.start) + lines.join("\n") + text.slice(range.end)
  // 自检：改完必须解析出同一个值挂在 notifyRef 上，否则不写盘
  const before = parseFrontmatter(text).frontmatter
  const after = parseFrontmatter(next).frontmatter
  if (after[NEW_KEY] !== before[OLD_KEY] || OLD_KEY in after) {
    return { ok: false, reason: "改写后自检失败（值不一致或旧键仍在），不写盘" }
  }
  return { ok: true, text: next }
}

function main() {
  if (!existsSync(MEMBERS_DIR)) {
    console.log(`[migrate] 没有成员目录，无事可做: ${MEMBERS_DIR}`)
    return
  }
  const backupDir = join(PM_ROOT, `.backup-notifyref-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  const rows = []
  for (const f of readdirSync(MEMBERS_DIR).sort()) {
    if (!f.endsWith(".md")) continue
    const full = join(MEMBERS_DIR, f)
    const text = readFileSync(full, "utf8")
    let fm
    try {
      fm = parseFrontmatter(text).frontmatter
    } catch (err) {
      rows.push({ f, action: "skip", why: `解析失败: ${err?.message || err}` })
      continue
    }
    if (!(OLD_KEY in fm)) {
      rows.push({ f, action: "skip", why: fm[NEW_KEY] !== undefined ? "已是 notifyRef" : "无该字段" })
      continue
    }
    if (NEW_KEY in fm && String(fm[NEW_KEY]) !== String(fm[OLD_KEY])) {
      rows.push({ f, action: "conflict", why: `inbox=${JSON.stringify(fm[OLD_KEY])} 与 notifyRef=${JSON.stringify(fm[NEW_KEY])} 不一致` })
      continue
    }
    const r = rewriteKey(text)
    if (!r.ok) {
      rows.push({ f, action: "skip", why: r.reason })
      continue
    }
    if (!APPLY) {
      rows.push({ f, action: "would-rename", why: `${OLD_KEY}=${JSON.stringify(fm[OLD_KEY])} → ${NEW_KEY}` })
      continue
    }
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(full, join(backupDir, f))
    writeFileSync(full, r.text)
    rows.push({ f, action: "renamed", why: `${OLD_KEY}=${JSON.stringify(fm[OLD_KEY])} → ${NEW_KEY}` })
  }

  const changed = rows.filter((r) => r.action === "renamed" || r.action === "would-rename")
  for (const r of rows) if (r.action !== "skip") console.log(`[migrate] ${r.action.padEnd(12)} ${r.f}  ${r.why}`)
  console.log(
    `[migrate] 根=${PM_ROOT} 模式=${APPLY ? "apply" : "dry-run"} ` +
      `改名=${changed.length} 跳过=${rows.filter((r) => r.action === "skip").length} ` +
      `冲突=${rows.filter((r) => r.action === "conflict").length}`,
  )
  if (changed.length && APPLY) console.log(`[migrate] 备份目录: ${backupDir}`)
  if (rows.some((r) => r.action === "conflict")) process.exitCode = 2
}

main()
