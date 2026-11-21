#!/usr/bin/env node
// B0/ISS-200 里程碑实体化迁移脚本（幂等可重跑）
// 干两件事：
//   1. 项目 frontmatter：旧 `milestones: string[]` + `milestoneDates: string[]` → 对象数组
//      `milestones: [{id,name,targetDate?}]`（id = ms-N，稳定，改名/排序不变）
//   2. 项目下 issue：`milestone: <名字>` → `milestone: <对应 id>`（引用 id，改名不断链）
// 用法：node scripts/migrate-milestones.mjs [--dry-run]
// 真相源 = ~/.dsh/pm（由 DSH_HOME/--pm-root 覆盖）
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter, serializeFrontmatter } from "../forge-pm/lib/frontmatter.js"

const PM_ROOT = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "pm")
  : join(process.env.HOME || "", ".dsh", "pm")
const DRY = process.argv.includes("--dry-run")

function mdFiles(dir) {
  const abs = join(PM_ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((n) => n.endsWith(".md") && !/-comments\.md$/.test(n) && !/-activity\.md$/.test(n))
    .map((n) => join(abs, n))
}

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

let changed = 0
const report = []

// 1) 项目 → 实体数组
const projectFiles = mdFiles("projects").filter((f) => !/updates\//.test(f))
for (const file of projectFiles) {
  const text = readFileSync(file, "utf8")
  const { frontmatter, body } = parseFrontmatter(text)
  const raw = frontmatter.milestones
  const dates = Array.isArray(frontmatter.milestoneDates) ? frontmatter.milestoneDates.map((d) => String(d ?? "").trim()) : []
  // 已是对象数组（含 id）→ 跳过
  if (Array.isArray(raw) && raw.some((m) => m && typeof m === "object")) {
    // 但可能要补 id（对象数组但缺 id 的容错）
    let touched = false
    const ents = raw.map((m, i) => {
      if (m && typeof m === "object") {
        if (!m.id) { touched = true; return { ...m, id: `ms-${i + 1}` } }
        return m
      }
      touched = true
      return { id: `ms-${i + 1}`, name: String(m), targetDate: dates[i] || null }
    })
    if (touched) {
      const out = serializeFrontmatter({ ...frontmatter, milestones: ents }, body)
      if (!DRY) writeFileSync(file, out)
      changed++
      report.push(`project ${file}: 对象数组补 id`)
    }
    continue
  }
  // 旧形态 string[] → 实体数组
  if (Array.isArray(raw) && raw.length >= 0) {
    const names = raw.map((m) => String(m ?? "").trim()).filter(Boolean)
    const ents = names.map((name, i) => ({
      id: `ms-${i + 1}`,
      name,
      targetDate: dates[i] || null,
    }))
    const { milestoneDates, ...rest } = frontmatter
    const out = serializeFrontmatter({ ...rest, milestones: ents }, body)
    if (!DRY) writeFileSync(file, out)
    changed++
    report.push(`project ${file}: string[](${names.length}) → 实体数组`)
  }
}

// 2) issue：milestone 名字 → id（按所属项目的实体数组映射）
//    先建 project rel → {name: id} 映射
const projMap = new Map() // rel(projects/x.md) → Map(name → id)
for (const file of projectFiles) {
  const rel = file.slice(PM_ROOT.length + 1)
  const { frontmatter } = parseFrontmatter(readFileSync(file, "utf8"))
  const raw = frontmatter.milestones
  if (Array.isArray(raw)) {
    const m = new Map()
    raw.forEach((e, i) => {
      if (e && typeof e === "object") m.set(String(e.name), String(e.id ?? `ms-${i + 1}`))
      else m.set(String(e), `ms-${i + 1}`)
    })
    projMap.set(rel, m)
    projMap.set(rel.replace(/^projects\//, ""), m) // 兼容 project: projects/x.md 或 x.md
    const fmId = frontmatter.id
    if (fmId) projMap.set(`PRJ-${String(fmId).replace(/^PRJ-/, "")}`, m)
  }
}

const issueFiles = mdFiles("issues")
for (const file of issueFiles) {
  const text = readFileSync(file, "utf8")
  const { frontmatter, body } = parseFrontmatter(text)
  const mv = frontmatter.milestone
  if (!mv || typeof mv !== "string" || !mv.trim()) continue
  const proj = frontmatter.project
  const map = proj ? projMap.get(String(proj)) : null
  if (!map) continue // 无归属项目或项目无里程碑
  const id = map.get(mv)
  if (!id || id === mv) continue // 已是 id 或项目无此名
  const out = serializeFrontmatter({ ...frontmatter, milestone: id }, body)
  if (!DRY) writeFileSync(file, out)
  changed++
  report.push(`issue ${file}: milestone "${mv}" → ${id}`)
}

console.log(DRY ? `[dry-run] 将改动 ${changed} 个文件：` : `已迁移 ${changed} 个文件：`)
for (const r of report) console.log("  " + r)
