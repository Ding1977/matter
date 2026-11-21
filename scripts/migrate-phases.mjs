#!/usr/bin/env node
// ISS-928 / DOC-415 迁移：把**写在标题前缀里的阶段**变成真阶段实体。
//
// ## 为什么需要
// 存量把分期/阶段编码进**标题前缀**（`P0-1 CSRF 收口`、`S1 插件骨架`，全库 175 张单这么写）
// —— 任何视图都读不出来。DOC-415 把阶段实体化后，本脚本负责把这类存量**一次性**转成
// 「容器定义阶段实体 + 子单贴引用」的正确形状。
//
// ## 做什么（对每个"有子单的父单/项目"）
//   1. 扫它的子单标题，按 `^(P\d+|S\d+|M\d+|一期|二期|三期)` 提取阶段名（去重保序）
//   2. 在**容器** frontmatter 写 `phases: [{ id: "<容器 id>:ph-N", name: "P0" }]`
//   3. 给每个子单写 `phase: "<容器 id>:ph-N"`（贴引用）
//
// ## 用法（**默认 dry-run** —— 与 migrate-milestones 相反，理由见下）
//   node scripts/migrate-phases.mjs                     # 只报告
//   node scripts/migrate-phases.mjs --apply             # 真写（先自动备份）
//   node scripts/migrate-phases.mjs --apply --no-backup
//
// ⚠️ **为什么默认 dry-run**：改的是用户真实工作库（~/.dsh-matter/pm），一次误跑就是几十个
//   文件被改。宁可多一步 `--apply`。
// ⚠️ **幂等**：容器已有 `phases` 的跳过（不覆盖人工定义）；子单已有 `phase` 的跳过。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { parseFrontmatter, serializeFrontmatter } from "../forge-pm/lib/frontmatter.js"

const PM_ROOT = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "pm")
  : join(process.env.HOME || "", ".dsh-matter", "pm")

const APPLY = process.argv.includes("--apply")
const NO_BACKUP = process.argv.includes("--no-backup")

/** 阶段名提取：标题前缀（`P0-1 …` → `P0`；`一期·股票分析` → `一期`）。 */
function phaseOfTitle(title) {
  const t = String(title || "").trim()
  const m = /^(P\d+|S\d+|M\d+)\b/.exec(t)
  if (m) return m[1]
  const cn = /^([一二三四五六七八九十]+期)/.exec(t)
  return cn ? cn[1] : null
}

function main() {
  const issuesDir = join(PM_ROOT, "issues")
  const projectsDir = join(PM_ROOT, "projects")
  if (!existsSync(issuesDir)) {
    console.error(`✗ 找不到 issues 目录：${issuesDir}`)
    console.error("  用 DSH_HOME=<盘根> 指定（生产盘 = ~/.dsh-matter）")
    process.exit(1)
  }

  const readDir = (dir) => {
    if (!existsSync(dir)) return []
    return execFileSync("ls", [dir], { encoding: "utf8" })
      .split("\n")
      .filter((n) => n.endsWith(".md") && !/-comments\.md$|-activity\.md$/.test(n))
  }

  const load = (dir) =>
    readDir(dir).map((n) => {
      const rel = join(dir === issuesDir ? "issues" : "projects", n)
      const full = join(PM_ROOT, rel)
      const { frontmatter, body } = parseFrontmatter(readFileSync(full, "utf8"))
      return { rel, full, fm: frontmatter, body }
    })

  const issues = load(issuesDir)
  const projects = load(projectsDir)
  const byRel = new Map([...issues, ...projects].map((e) => [e.rel, e]))
  const byFmId = new Map([...issues, ...projects].filter((e) => e.fm.id).map((e) => [String(e.fm.id), e]))

  /** 容器 → 拟建阶段（按子单标题前缀推导）。 */
  //
  // ⚠️ **单级优先**（DOC-415 §3.1）：一张单可能同时属于某项目、又是某些子单的父单
  //   （实测：ISS-584 的 `project` 指向 PRJ-001，同时 `parent` 指向 ISS-582）。
  //   若两个容器都认领它，同一张单会被写两次、后写的赢 —— 阶段归属就随机了。
  //   规则：**有子单的单 ⇒ 它是容器（单级阶段优先）**；没有子单才归项目。
  const claimed = new Map() // 子单 rel → 容器 rel（防两个容器抢同一张单）
  const plans = []
  // 先处理**单容器**（优先级高），再处理项目容器
  const orderedContainers = [...issues, ...projects]
  for (const container of orderedContainers) {
    // 容器自己已有 phases（人工定义）⇒ 跳过（不覆盖人的意图）
    if (Array.isArray(container.fm.phases) && container.fm.phases.length > 0) continue
    const kids = []
    if (container.rel.startsWith("projects/")) {
      // 项目容器：子单 = project 指向它的 issues，且**尚未被单容器认领**
      for (const it of issues) {
        if (String(it.fm.project || "") !== container.rel) continue
        if (claimed.has(it.rel)) continue
        kids.push(it)
      }
    } else {
      // 单容器：子单 = 父侧 subtasks 或子侧 parent
      for (const it of issues) {
        if (it.rel === container.rel) continue
        const p = String(it.fm.parent || "").trim()
        const decl = Array.isArray(container.fm.subtasks) ? container.fm.subtasks : []
        if (p === container.rel || decl.includes(it.rel)) kids.push(it)
      }
    }
    if (kids.length < 2) continue // 单张子单不值得建阶段体系
    const order = []
    const assign = new Map() // 子 rel → 阶段名
    for (const k of kids) {
      if (k.fm.phase) continue // 已有引用 ⇒ 不覆盖
      const ph = phaseOfTitle(k.fm.title)
      if (!ph) continue
      if (!order.includes(ph)) order.push(ph)
      assign.set(k.rel, ph)
    }
    if (order.length === 0) continue
    const cid = String(container.fm.id || "")
    if (!cid) continue
    for (const rel of assign.keys()) claimed.set(rel, container.rel)
    plans.push({
      container,
      phases: order.map((name, i) => ({ id: `${cid}:ph-${i + 1}`, name })),
      assign,
    })
  }

  let nEnt = 0
  let nRef = 0
  for (const p of plans) {
    nEnt += p.phases.length
    nRef += p.assign.size
  }
  console.log(`库根：${PM_ROOT}`)
  console.log(`拟建阶段容器：${plans.length} 个 · 阶段实体：${nEnt} 个 · 回填引用：${nRef} 条\n`)
  for (const p of plans) {
    console.log(`  ${p.container.fm.id}（${p.container.rel}）`)
    console.log(`    阶段：${p.phases.map((x) => `${x.name}(${x.id})`).join("  ")}`)
    for (const [rel, ph] of p.assign) {
      const id = p.phases.find((x) => x.name === ph)?.id
      console.log(`      ${byRel.get(rel)?.fm.id || rel}  phase=${id}`)
    }
  }

  if (nRef === 0) {
    console.log("\n✓ 无可迁移项（库已一致或都已有 phase）")
    return
  }
  if (!APPLY) {
    console.log("\n(dry-run) 未改动任何文件。确认无误后加 --apply 执行。")
    return
  }

  if (!NO_BACKUP) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backupDir = join(PM_ROOT, `.backup-phases-${stamp}`)
    mkdirSync(backupDir, { recursive: true })
    const files = new Set()
    for (const p of plans) {
      files.add(p.container.rel)
      for (const rel of p.assign.keys()) files.add(rel)
    }
    for (const rel of files) {
      const src = join(PM_ROOT, rel)
      if (!existsSync(src)) continue
      const dst = join(backupDir, rel)
      mkdirSync(join(dst, ".."), { recursive: true })
      copyFileSync(src, dst)
    }
    console.log(`\n已备份 ${files.size} 个文件 → ${backupDir}`)
  }

  let okEnt = 0
  let okRef = 0
  for (const p of plans) {
    try {
      p.container.fm.phases = p.phases
      writeFileSync(p.container.full, serializeFrontmatter(p.container.fm, p.container.body), "utf8")
      okEnt += p.phases.length
    } catch (err) {
      console.error(`  ✗ ${p.container.rel}: ${err.message}`)
      continue
    }
    for (const [rel, ph] of p.assign) {
      const child = byRel.get(rel) || byFmId.get(String(rel))
      if (!child) continue
      const id = p.phases.find((x) => x.name === ph)?.id
      if (!id) continue
      try {
        child.fm.phase = id
        writeFileSync(child.full, serializeFrontmatter(child.fm, child.body), "utf8")
        okRef++
      } catch (err) {
        console.error(`  ✗ ${rel}: ${err.message}`)
      }
    }
  }
  console.log(`\n✓ 已写阶段实体 ${okEnt} 个 · 引用 ${okRef} 条`)
}

main()
