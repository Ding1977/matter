#!/usr/bin/env node
// ISS-604 P1-③：父子断链迁移 —— 给「父列了子、子侧 parent 为空」的子单补写 parent。
//
// ## 为什么需要这个脚本
// 真相源 = **子侧 `parent` 标量**（与 Linear 一致）；父侧 `subtasks` 是 scan 期反查的派生视图。
// 历史上有两条写入路径各写一边，产生了两类断链。scan 的派生（P1-①）已能让**读**自愈，
// 但**盘上仍留着不一致**：父侧列了子、子侧 `parent` 是空的 ⇒ 子单在列表里不被识别为子任务
// （没有 ↳ 面包屑、不参与父单进度汇总）。本脚本把这类存量补齐。
//
// 实测（2026-10-07，~/.dsh-matter）：**33 条边**，全部是「父列了子、子未回指」这一个方向。
// 反向（子标了父、父未列子）**0 条** —— 那种形态读侧已由派生自愈，且父侧本就该由派生管，不需要写盘。
//
// ## 用法（默认 dry-run，写盘要显式 --apply —— 与 migrate-milestones 相反，理由见下）
//   node scripts/migrate-subtask-parents.mjs                 # 只报告，不动盘
//   node scripts/migrate-subtask-parents.mjs --apply         # 真写（先自动备份）
//   node scripts/migrate-subtask-parents.mjs --apply --no-backup
//
// ⚠️ **为什么默认 dry-run**：本脚本改的是**用户的真实工作库**（~/.dsh-matter/pm），
//   一次误跑就是 33 个文件的 frontmatter 被改。宁可多一步 `--apply`，不要「手滑即写」。
//   （migrate-milestones 是默认写盘 + --dry-run，那是历史写法；新脚本按项目「危险操作默认安全」的口径。）
//
// ⚠️ 幂等：已回指的子单跳过；重跑不产生 diff。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { parseFrontmatter, serializeFrontmatter } from "../forge-pm/lib/frontmatter.js"

const PM_ROOT = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "pm")
  : join(process.env.HOME || "", ".dsh-matter", "pm")

const APPLY = process.argv.includes("--apply")
const NO_BACKUP = process.argv.includes("--no-backup")

/** 读一条实体的 frontmatter + body（只认 md，跳过 comments/activity 侧车）。 */
function readEntity(rel) {
  const full = join(PM_ROOT, rel)
  if (!existsSync(full)) return null
  const { frontmatter, body } = parseFrontmatter(readFileSync(full, "utf8"))
  return { full, frontmatter, body }
}

function main() {
  const issuesDir = join(PM_ROOT, "issues")
  if (!existsSync(issuesDir)) {
    console.error(`✗ 找不到 issues 目录：${issuesDir}`)
    console.error("  用 DSH_HOME=<盘根> 指定（生产盘 = ~/.dsh-matter）")
    process.exit(1)
  }
  const names = readdirSyncList(issuesDir)
  const items = []
  for (const n of names) {
    const e = readEntity(join("issues", n))
    if (!e) continue
    items.push({ rel: join("issues", n), ...e })
  }
  const byRel = new Map(items.map((i) => [i.rel, i]))
  const byFmId = new Map(items.filter((i) => i.frontmatter.id).map((i) => [String(i.frontmatter.id), i]))

  /** 解析一个 subtasks 引用（rel 或短号）到实体。 */
  const resolve = (ref) => {
    const r = String(ref || "").trim()
    if (!r) return null
    return byRel.get(r) ?? byFmId.get(r) ?? null
  }
  const normRelList = (v) => {
    if (!Array.isArray(v)) return []
    const out = []
    for (const x of v) { const s = String(x ?? "").trim(); if (s) out.push(s) }
    return out
  }

  const plan = []
  for (const p of items) {
    const kids = normRelList(p.frontmatter.subtasks)
    for (const ref of kids) {
      const c = resolve(ref)
      if (!c) continue // 指向不存在的单：不猜、不建（另有悬空清理，不在本脚本范围）
      const cur = String(c.frontmatter.parent || "").trim()
      if (cur === p.rel) continue // 已回指，幂等跳过
      if (cur) {
        // 子侧已指向**别的**父单：冲突，不覆盖（可能是有意挪动）。如实报出来，交人判断。
        plan.push({ kind: "conflict", parent: p.rel, child: c.rel, cur, want: p.rel })
        continue
      }
      plan.push({ kind: "fill", parent: p.rel, child: c.rel, cur: "", want: p.rel })
    }
  }

  const fills = plan.filter((x) => x.kind === "fill")
  const conflicts = plan.filter((x) => x.kind === "conflict")

  console.log(`库根：${PM_ROOT}`)
  console.log(`issues：${items.length} 张`)
  console.log(`待补写：${fills.length} 条（父列了子、子侧 parent 空）`)
  if (conflicts.length) console.log(`冲突（子侧已指别处，**不覆盖**）：${conflicts.length} 条`)
  console.log("")

  if (conflicts.length) {
    for (const c of conflicts) {
      console.log(`  ⚠ 冲突 ${c.child}：现有 parent=${c.cur}，父单 ${c.parent} 也列了它 —— 需人工判`)
    }
    console.log("")
  }
  for (const f of fills) {
    const cf = byRel.get(f.child)?.frontmatter ?? {}
    console.log(`  ${f.child}  (${cf.id || "?"})  parent: (空) → ${f.parent}`)
  }

  if (fills.length === 0) {
    console.log("\n✓ 无待补写项（库已一致）")
    return
  }
  if (!APPLY) {
    console.log(`\n(dry-run) 未改动任何文件。确认无误后加 --apply 执行。`)
    return
  }

  // 备份（默认做；--no-backup 才跳过）
  if (!NO_BACKUP) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backupDir = join(PM_ROOT, `.backup-subtask-parents-${stamp}`)
    mkdirSync(join(backupDir, "issues"), { recursive: true })
    for (const f of fills) {
      const src = join(PM_ROOT, f.child)
      if (existsSync(src)) copyFileSync(src, join(backupDir, f.child))
    }
    console.log(`\n已备份 ${fills.length} 个文件 → ${backupDir}`)
  }

  let ok = 0
  for (const f of fills) {
    const e = byRel.get(f.child)
    if (!e) continue
    try {
      e.frontmatter.parent = f.parent
      writeFileSync(e.full, serializeFrontmatter(e.frontmatter, e.body), "utf8")
      ok++
    } catch (err) {
      console.error(`  ✗ ${f.child}: ${err.message}`)
    }
  }
  console.log(`\n✓ 已补写 ${ok}/${fills.length} 条`)
}

function readdirSyncList(dir) {
  return execFileSync("ls", [dir], { encoding: "utf8" })
    .split("\n")
    .filter((n) => n.endsWith(".md") && !/-comments\.md$/.test(n) && !/-activity\.md$/.test(n))
}

main()
