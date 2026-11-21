#!/usr/bin/env node
// ISS-928 回滚：撤销迁移脚本**越权写入的项目级 `phases`**（连同引用它的 `phase`）。
//
// ## 为什么要回滚（独立审查 M3）
// `migrate-phases.mjs` 给**项目级**也建了 `phases`，而 DOC-415 §5 已由老板拍 **1A
// （里程碑与阶段分开保留、不自动搬）** —— 脚本自动建项目级 phases 等于**替老板做了
// 没被授权的动作**，并制造了「phases 与 milestones 同名并存」（实测 PRJ-006 一期/二期/三期
// 三个全重叠、PRJ-010 P0~P3 重叠、PRJ-016 S5 重叠）。
//
// 老板 2026-10-08 决定：**回滚项目级，单级阶段保留**（项目级留老板按 1A 手工整理）。
//
// ## 做什么
//   1. 删掉**项目** frontmatter 里的 `phases`（只动 `projects/`，不碰 `issues/`）
//   2. 清掉**引用这些项目级 id** 的单的 `phase`（否则留下 29 条 dangling）
//   3. **完整备份**（默认做）—— 与迁移脚本同一备份口径
//
// ## 用法（默认 dry-run）
//   node scripts/rollback-project-phases.mjs            # 只报告
//   node scripts/rollback-project-phases.mjs --apply    # 真写（先自动备份）
//   node scripts/rollback-project-phases.mjs --apply --no-backup
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { parseFrontmatter, serializeFrontmatter } from "../forge-pm/lib/frontmatter.js"

const PM_ROOT = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "pm")
  : join(process.env.HOME || "", ".dsh-matter", "pm")

const APPLY = process.argv.includes("--apply")
const NO_BACKUP = process.argv.includes("--no-backup")

const readDir = (dir) => {
  const abs = join(PM_ROOT, dir)
  if (!existsSync(abs)) return []
  return execFileSync("ls", [abs], { encoding: "utf8" })
    .split("\n")
    .filter((n) => n.endsWith(".md") && !/-comments\.md$|-activity\.md$/.test(n))
}

const load = (dir) =>
  readDir(dir).map((n) => {
    const rel = `${dir}/${n}`
    const full = join(PM_ROOT, rel)
    const { frontmatter, body } = parseFrontmatter(readFileSync(full, "utf8"))
    return { rel, full, fm: frontmatter, body }
  })

function main() {
  if (!existsSync(join(PM_ROOT, "issues"))) {
    console.error(`✗ 找不到 issues 目录：${join(PM_ROOT, "issues")}`)
    console.error("  用 DSH_HOME=<盘根> 指定（生产盘 = ~/.dsh-matter）")
    process.exit(1)
  }

  const projects = load("projects")
  const issues = load("issues")

  // ① 找出**项目级**阶段容器（只这些要回滚）
  const targets = projects
    .filter((p) => Array.isArray(p.fm.phases) && p.fm.phases.length > 0)
    .map((p) => ({ proj: p, ids: p.fm.phases.map((x) => String(x?.id ?? "")) }))

  const idSet = new Set(targets.flatMap((t) => t.ids).filter(Boolean))

  // ② 引用这些 id 的单（要一并清 `phase`，否则留 dangling）
  const refs = issues.filter((it) => it.fm.phase && idSet.has(String(it.fm.phase).trim()))

  console.log(`库根：${PM_ROOT}`)
  console.log(`项目级阶段容器：${targets.length} 个 · 被引用的单：${refs.length} 条\n`)
  for (const t of targets) {
    const names = (t.proj.fm.phases || []).map((x) => x?.name).filter(Boolean)
    console.log(`  ${t.proj.fm.id}（${t.proj.rel}）`)
    console.log(`    将删 phases：${names.join(" / ")}`)
    const mine = refs.filter((r) => idSet.has(String(r.fm.phase).trim()) && String(r.fm.phase).startsWith(`${t.proj.fm.id}:`))
    if (mine.length) console.log(`    将清 ${mine.length} 条引用：${mine.slice(0, 3).map((x) => x.fm.id).join(", ")}${mine.length > 3 ? " …" : ""}`)
  }

  if (targets.length === 0) {
    console.log("\n✓ 无项目级 phases（无需回滚）")
    return
  }
  if (!APPLY) {
    console.log("\n(dry-run) 未改动任何文件。确认无误后加 --apply 执行。")
    return
  }

  if (!NO_BACKUP) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backupDir = join(PM_ROOT, `.backup-rollback-phases-${stamp}`)
    mkdirSync(backupDir, { recursive: true })
    for (const rel of [...targets.map((t) => t.proj.rel), ...refs.map((r) => r.rel)]) {
      const src = join(PM_ROOT, rel)
      if (!existsSync(src)) continue
      const dst = join(backupDir, rel)
      mkdirSync(join(dst, ".."), { recursive: true })
      copyFileSync(src, dst)
    }
    console.log(`\n已备份 ${targets.length + refs.length} 个文件 → ${backupDir}`)
  }

  let okP = 0
  let okR = 0
  for (const t of targets) {
    delete t.proj.fm.phases
    try {
      writeFileSync(t.proj.full, serializeFrontmatter(t.proj.fm, t.proj.body), "utf8")
      okP++
    } catch (err) {
      console.error(`  ✗ ${t.proj.rel}: ${err.message}`)
    }
  }
  for (const r of refs) {
    delete r.fm.phase
    try {
      writeFileSync(r.full, serializeFrontmatter(r.fm, r.body), "utf8")
      okR++
    } catch (err) {
      console.error(`  ✗ ${r.rel}: ${err.message}`)
    }
  }
  console.log(`\n✓ 已删项目级 phases ${okP} 处 · 清理引用 ${okR} 条`)
  console.log("  ⚠️ 单级阶段（issues/ 自己的 phases）**未动** —— 按老板 1A 保留")
}

main()
