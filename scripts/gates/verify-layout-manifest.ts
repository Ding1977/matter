/**
 * AGENTS.md Repository layout 与仓库目录的一致性判据（2332 号单）。
 *
 * 背景：公开仓白名单漏 `apps/` 的根因是 AGENTS.md 的 layout 没写它；同一份 layout
 * 还列了三个磁盘上不存在的组（llm/interaction/identity）——多了 3 个、少了 1 个，
 * 而没有任何机器判据会察觉。本判据把「layout 代码块列的目录 = 仓库真实顶层目录」变成闸：
 * 多一个（幻影）红、少一个（漏项）红。
 *
 * 三章：
 *   ① 顶层：`## Repository layout` 代码块的顶格目录 ⇄ git 跟踪的顶层目录（减豁免）；
 *   ② 组级：代码块里缩进列组的父目录（当前只有 `packages/`）⇄ 该父目录的 git 子目录；
 *   ③ fail-closed：AGENTS.md / layout 块 / git tree 读不到 ⇒ unjudged，不退回绿。
 *
 * ## 为什么真值取 git tree 而不是裸扫磁盘
 * 裸扫磁盘会把本机残留目录、未安装的 node_modules 算进真值，本机与 CI 读数不一致
 * （写判据硬边界：判据只许依赖仓内事实）。git tree 在本机与 CI 是同一份集合。
 * 由此产生的射程落差见 `note`：未入库的临时目录不会判「多一个」，机器目录本就不在 tree 里。
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const AGENTS = path.join(REPO, "AGENTS.md")

/**
 * 豁免清单：只在真值侧剔除，声明侧仍按原样对账。
 * 每条写明理由；`foo*` 为前缀通配（当前用于冻结旧树 forge-*）。
 */
export interface Exemption {
  match: string
  why: string
}
export const EXEMPTIONS: Exemption[] = [
  { match: "forge-*", why: "冻结只读旧树，按既定边界不入 layout（layout 只描述在建结构）" },
  { match: ".git", why: "VCS 元数据，机器目录（本就不在 git tree 里）" },
  { match: "node_modules", why: "依赖安装产物，机器目录（本就不在 git tree 里）" },
  { match: ".design", why: "设计草稿与私有格式资产，非 agent 入口结构" },
  { match: ".github", why: "CI 工作流配置，非运行时结构" },
  { match: ".qoder", why: "工具落盘目录（部分已 gitignore）" },
  { match: ".workbuddy", why: "工具落盘目录（已 gitignore）" },
  { match: "agent-shared", why: "跨 agent 共享记忆区，非本仓代码结构" },
  { match: "brand", why: "品牌资产目录，非代码结构" },
  { match: "cad-figma-redesign", why: "一次性 CAD/Figma 设计稿工程" },
  { match: "deploy", why: "部署配置，非运行时结构" },
  { match: "electron-shell", why: "独立嵌套 bun 子工程，非主仓包结构" },
  { match: "learning", why: "学习笔记归档" },
  { match: "plugins", why: "外部插件副本，非自有包" },
  { match: "research", why: "调研材料归档" },
  { match: "roles", why: "角色定义资料" },
  { match: "skills", why: "技能副本（真源在 .agents/skills/）" },
  { match: "specs", why: "已冻结的历史规格归档（新规划进 Matter 文档库）" },
  { match: "vscode-dsh-models", why: "VS Code 扩展配置目录" },
]

/** 名字是否命中豁免（含理由仅在 EXEMPTIONS 里，判据不写「恒为空」之类会腐坏的断言）。 */
export function exempted(name: string): boolean {
  return EXEMPTIONS.some((e) => (e.match.endsWith("*") ? name.startsWith(e.match.slice(0, -1)) : name === e.match))
}

/** layout 代码块解析结果：顶格目录 + 按父目录归拢的缩进组。 */
export interface Layout {
  top: string[]
  groups: Record<string, string[]>
}

/**
 * 从 AGENTS.md 正文解析 `## Repository layout` 后的第一个围栏代码块。
 * 返回 null = 没有这一章 / 没有代码块 / 代码块里无目录（都归 no-rule-table，不判绿）。
 */
export function parseLayout(text: string): Layout | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Repository layout\s*$/.test(l.trim()))
  if (start < 0) return null
  let i = start + 1
  while (i < lines.length && !/^```/.test(lines[i].trim())) i++
  if (i >= lines.length) return null
  i++
  const top: string[] = []
  const groups: Record<string, string[]> = {}
  let current = ""
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line.trim())) break
    const m = /^([ \t]*)([A-Za-z0-9.][A-Za-z0-9_.-]*)\/\s*(.*)$/.exec(line)
    if (!m) continue
    const name = m[2]
    if (m[1].length === 0) {
      top.push(name)
      current = name
    } else if (current) {
      ;(groups[current] ??= []).push(name)
    }
  }
  return top.length ? { top, groups } : null
}

/**
 * 组级对账的父目录白名单：layout 代码块只有 `packages/` 用缩进列组。
 * 其余父目录（docs / scripts / .agents / apps）的子目录不在这份代码块的职责内。
 */
export const GROUP_SCOPED = ["packages"] as const

export interface LayoutInput {
  /** AGENTS.md 正文；null = 读不到 */
  layoutText: string | null
  /** git 跟踪的顶层目录；null = git tree 读不到 */
  topDirs: string[] | null
  /** 各父目录的 git 子目录（当前只需 packages） */
  groupDirs: Record<string, string[]>
}

/** 纯判据：spec 直接喂构造数据，不碰 IO。 */
export function judgeLayout(input: LayoutInput): GateResult {
  const gate = "verify-layout-manifest"
  if (input.layoutText === null) return unjudged(gate, "no-rule-table", "AGENTS.md 不存在或读不到")
  const layout = parseLayout(input.layoutText)
  if (!layout) return unjudged(gate, "no-rule-table", "AGENTS.md 的 ## Repository layout 代码块缺失或为空")
  if (input.topDirs === null) return unjudged(gate, "no-baseline", "git tree 读不到，无法取顶层目录真值")

  const findings: Finding[] = []
  const expectedTop = input.topDirs.filter((d) => !exempted(d))
  for (const d of layout.top.filter((d) => !expectedTop.includes(d))) findings.push({ detail: `顶层多列 ${d}/ —— 磁盘无此目录（幻影）` })
  for (const d of expectedTop.filter((d) => !layout.top.includes(d))) findings.push({ detail: `顶层漏列 ${d}/ —— 磁盘存在但未写进 layout（漏项）` })

  // 组级：显式列组的父目录 + GROUP_SCOPED（防「把一组全删了就没人判」的洞）。
  const parents = [...new Set([...Object.keys(layout.groups), ...GROUP_SCOPED])]
  for (const parent of parents) {
    if (!layout.top.includes(parent)) continue
    const declared = layout.groups[parent] ?? []
    const actual = (input.groupDirs[parent] ?? []).filter((d) => !exempted(d))
    for (const d of declared.filter((d) => !actual.includes(d))) findings.push({ detail: `${parent}/ 组级多列 ${d}/ —— 磁盘无此组（幻影）` })
    for (const d of actual.filter((d) => !declared.includes(d))) findings.push({ detail: `${parent}/ 组级漏列 ${d}/ —— 磁盘存在但未写进 layout` })
  }

  const exemptedCount = input.topDirs.length - expectedTop.length
  const detail = `顶层声明 ${layout.top.length} 项 · 真值 ${expectedTop.length} 项（豁免 ${exemptedCount} 项）· 组级父目录 ${parents.filter((p) => layout.top.includes(p)).length} 个`
  if (findings.length) return { gate, status: "failed", findings, detail }
  return { gate, status: "passed", detail }
}

/** 从 git 对象读目录，拿不到 ref ⇒ null（unjudged，不退回空集判绿）。 */
function gitDirs(tree: string): string[] | null {
  try {
    const out = execFileSync("git", ["-C", REPO, "ls-tree", "-d", "--name-only", tree], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return out.split("\n").filter(Boolean)
  } catch {
    return null
  }
}

/** 现场读取：AGENTS.md 正文 + git tree 真值。spec 的「真仓绿」直接用它，不复制 IO。 */
export function readTruth(): LayoutInput {
  let layoutText: string | null = null
  try {
    layoutText = fs.readFileSync(AGENTS, "utf8")
  } catch {
    // 读不到 ⇒ judgeLayout 返 unjudged(no-rule-table)
  }
  const topDirs = gitDirs("HEAD")
  const groupDirs: Record<string, string[]> = {}
  if (topDirs) {
    const packages = gitDirs("HEAD:packages")
    if (packages) groupDirs.packages = packages
  }
  return { layoutText, topDirs, groupDirs }
}

if (isMain(import.meta.url)) {
  runGate({ name: "verify-layout-manifest", main: () => judgeLayout(readTruth()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ verify-layout-manifest: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
