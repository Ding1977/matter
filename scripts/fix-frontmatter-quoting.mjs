#!/usr/bin/env node
// 语料 title 引号修复（ISS-650）—— 只补 `title:` 一条字段的必要双引号，其余字节一个都不动。
//
// ## 为什么需要这个脚本
// `title: [需求] xxx` 里的行首 `[` 是 YAML 的**流式数组起始**：真 YAML 读侧要么报错、要么把
// 标题切成数组（本仓 `parseValue` 对以 `]` 收尾的同类值也会切）。写侧（`forge-service-kit/
// frontmatter.js`，ISS-650 同批已修）从此会按需加引号，但**存量文件不会自己变** ——
// 它们要等下一次回写；下一次回写之前，任何真 YAML 消费者读到它们都是错的。本脚本就是这一次。
//
// ## 纪律（本单硬约束，写在脚本里而不是靠记忆）
// · 默认 **dry-run**：只打印「将改哪些文件、哪一行、改前/改后」，不写盘，退出码 0。
// · `--apply` 才真写，且走内核原子写（`forge-service-kit/fs` 的 `writeFileAtomic`：同目录 tmp +
//   rename，POSIX 同文件系统内原子，读者不会看到半截文件）。
// · **只动 `title:` 这一条字段**：按行替换，不重新序列化整个 frontmatter，故不存在
//   「顺手重排字段」的可能（重排会让 4400+ 个文件产生无意义 diff，淹没真改动）。
// · 幂等：跑第二遍必须 0 改动；dry-run 阶段就在内存里验过这一条（见 `planFile` 的自检）。
// · 分母与 `scripts/md-corpus-guard.mjs` 同口径：跳隐藏目录、跳备份目录（`runs.bak-*` 之类），
//   否则会把语料副本当真相源改。
//
// ## 用法
//   node scripts/fix-frontmatter-quoting.mjs                    # dry-run（缺省）
//   node scripts/fix-frontmatter-quoting.mjs --apply            # 真写（原子写）
//   node scripts/fix-frontmatter-quoting.mjs --root <dir>       # 指定语料根（自测/预演用）
//   node scripts/fix-frontmatter-quoting.mjs --selftest         # 造临时夹具，双向验证后删除
//
// 语料根 = `$DSH_HOME/pm`，缺省 `~/.dsh-matter/pm`（**不写死绝对路径**）。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { parseFrontmatter, serializeFrontmatter } from "../forge-service-kit/lib/frontmatter.js"
import { writeFileAtomic } from "../forge-service-kit/lib/fs.js"

// ── 语料根（不写死绝对路径：DSH_HOME 优先，缺省 ~/.dsh-matter） ──────────────
/** 缺省语料根：`$DSH_HOME/pm`，没设 `DSH_HOME` 就 `~/.dsh-matter/pm`。 */
export const defaultRoot = (env = process.env, home = homedir()) =>
  join(env.DSH_HOME || join(home, ".dsh-matter"), "pm")

/**
 * 备份目录判据 —— 与 `scripts/md-corpus-guard.mjs` 的 `isBackupDir` **逐字同口径**
 * （文档名里带 `.bak`/`-bak`/`_bak` 段，实测 `runs.bak-iss972/` 是 270 个 md 的语料副本）。
 * 两份脚本各写一份是刻意的：守卫判「分母」，本脚本判「该不该改」，口径漂移时两边都会红。
 */
const isBackupDir = (name) => /(^|[.\-_])bak([.\-_\d]|$)/i.test(name)

/** 收集语料 md（跟软链、跳隐藏目录与备份目录），返回绝对路径升序。 */
export function collectMd(root) {
  const out = { files: [], skippedHidden: 0, skippedBackup: [] }
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) {
        out.skippedHidden++
        continue
      }
      const p = join(dir, e.name)
      let st
      try {
        st = statSync(p) // 跟软链；断链 = 不存在，直接跳过（不是「没有 frontmatter」）
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (isBackupDir(e.name)) out.skippedBackup.push(relative(root, p).split(sep).join("/"))
        else walk(p)
      } else if (st.isFile() && e.name.endsWith(".md")) out.files.push(p)
    }
  }
  walk(root)
  out.files.sort()
  return out
}

/**
 * 会不会被 YAML 读成非字符串（与写侧 `needsQuoting` 同一批判据，此处**独立书写**：
 * 脚本要能对「写侧规则漏了哪种」给出独立判断，而不是拿写侧验写侧）。
 * 注意：合法内联 JSON（`{...}`/`[...]` 且能 `JSON.parse`）**不算**歧义 —— 那是活动行
 * （ISS-611）与对象数组字段的正常形态，加引号反而会把它降级成字符串。
 *
 * 口径刻意**放宽**一点（如 `-x` / `?x` / `:x` 这里也判为歧义，写侧只在后跟空白时才加引号）：
 * 两个方向的错代价不对称 —— 这里多判一次，`titleLineFor` 会给出与原文相同的行、`wanted === line`
 * 于是不产生改动（无害）；这里少判一次，就等于放过一个本该修的标题（有害）。
 */
function looksAmbiguous(raw) {
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const v = JSON.parse(raw)
      if (v !== null && typeof v === "object") return false
    } catch {
      /* 非 JSON ⇒ 真正的「伪装成流式节点的文本」，必须加引号 */
    }
    return true
  }
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(raw)) return true
  if (/:[ \t]|[ \t]#/.test(raw)) return true
  if (/^(?:true|false|null|~|yes|no|on|off)$/i.test(raw)) return true
  if (/^[-+]?(?:0x[0-9a-f_]+|\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) return true
  if (/^[-+]?\.(?:inf|nan)$/i.test(raw)) return true
  return raw !== raw.trim()
}

/** 一条 `title:` 行该被写成什么 —— 交给共享 writer（单一真相源：规则只有一份）。 */
function titleLineFor(raw) {
  const block = serializeFrontmatter({ title: raw }, "")
  const line = block.split("\n")[1] // block = `---` / `title: …` / `---`
  if (!line || !line.startsWith("title: ")) throw new Error(`writer 未产出 title 行：${JSON.stringify(block)}`)
  return line
}

/**
 * 单文件规划（纯函数，不写盘）：只替换 `title:` 那一行，其余字节原样。
 *
 * @returns {{changed: boolean, edits: Array<{line:number,before:string,after:string}>, text: string, error?: string}}
 */
export function planFile(text) {
  const res = { changed: false, edits: [], text }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return res // 没有 frontmatter ⇒ 不属本单
  const fmBlock = m[1]
  const eol = m[0].includes("\r\n") ? "\r\n" : "\n"
  const lines = fmBlock.split(/\r?\n/)
  const next = lines.map((line, i) => {
    if (/^\s/.test(line)) return line // 缩进行 = 块标量内容/续行，不是字段
    const hit = /^title:(.*)$/.exec(line)
    if (!hit) return line
    const raw = hit[1].trim()
    if (!raw) return line // 空值：`title: ` 是既有往返行为，不属本单
    if (/^[|>]/.test(raw)) return line // 块标量（多行值）：不是本次的「流式起始」形态
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return line // 已加过 ⇒ 幂等的关键
    if (!looksAmbiguous(raw)) return line
    const wanted = titleLineFor(raw)
    if (wanted === line) return line
    res.edits.push({ line: i + 2, before: line, after: wanted }) // +2：`---` 占第 1 行，且从 1 计
    res.lastRaw = raw // 自检的**期望值**取「原行上写的那串字」，不取旧 parse 的结果
    return wanted
  })
  if (!res.edits.length) return res
  // 只把 frontmatter 块内的这些行换掉：块首偏移 = 开围栏那一行之后
  const blockStart = m[0].indexOf("\n") + 1
  const blockEnd = blockStart + fmBlock.length
  res.text = text.slice(0, blockStart) + next.join(eol) + text.slice(blockEnd)
  res.changed = true

  // ── 自检（每次规划都做，不依赖 --selftest）：写侧改完必须读得回原值、其它字段不变、且幂等 ──
  // 期望值刻意取「原行上 `title:` 之后的那串字」，**不取**旧 parse 的结果：旧 parse 对
  // `title: [a] [b]` 给的是数组、对 `title: true` 给的是布尔 —— 拿它当标准，等于把坏形状
  // 当正确答案（本脚本存在的理由正是它坏了）。
  const before = parseFrontmatter(text).frontmatter
  const after = parseFrontmatter(res.text).frontmatter
  for (const [k, v] of Object.entries(before)) {
    if (k === "title") continue
    if (JSON.stringify(v) !== JSON.stringify(after[k])) {
      res.error = `字段 ${k} 被波及（本单不许改其它字段）`
      return res
    }
  }
  if (typeof after.title !== "string" || after.title !== res.lastRaw) {
    res.error = `title 读回值不是原文字：「${res.lastRaw}」→ ${JSON.stringify(after.title)}`
    return res
  }
  if (after.title === String(before.title)) {
    // 修前就已经读得对（本仓口径）—— 不是错，但值得知道：这类是「预防性加引号」，不是止血。
    res.preventive = true
  }
  if (planFile(res.text).changed) {
    res.error = "二次规划仍在改（写→读→再写不是定点）"
    return res
  }
  return res
}

/** 对一棵语料目录跑一遍规划（不写盘）。 */
export function planRoot(root) {
  const collected = collectMd(root)
  const report = {
    root,
    files: collected.files.length,
    skippedHidden: collected.skippedHidden,
    skippedBackup: collected.skippedBackup,
    changed: [], // { file, edits[] }
    errors: [],
  }
  for (const abs of collected.files) {
    let text
    try {
      text = readFileSync(abs, "utf8")
    } catch (e) {
      report.errors.push({ file: abs, error: `读失败：${e.message}` })
      continue
    }
    const plan = planFile(text)
    if (plan.error) report.errors.push({ file: abs, error: plan.error })
    if (plan.changed) report.changed.push({ file: abs, text, edits: plan.edits, next: plan.text })
  }
  report.edits = report.changed.reduce((n, c) => n + c.edits.length, 0)
  return report
}

// ───────────────────────────── CLI ─────────────────────────────

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const optOf = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)

const relTo = (root, abs) => relative(root, abs).split(sep).join("/")

function printReport(report, { applied }) {
  const root = report.root
  const lines = []
  lines.push(`语料根：${root}`)
  lines.push(`扫描 md：${report.files}（跳过隐藏项 ${report.skippedHidden} 个 · 备份目录 ${report.skippedBackup.length} 个）
`)
  if (!report.changed.length) {
    lines.push("✓ 没有需要加引号的 title —— 语料已是目标形态（未写盘）")
  } else {
    lines.push(`${applied ? "已写" : "将改"} ${report.changed.length} 个文件 · ${report.edits} 行`)
    const flat = []
    for (const c of report.changed) for (const e of c.edits) flat.push({ file: relTo(root, c.file), ...e })
    for (const e of flat) lines.push(`    ${e.file}:${e.line}\n      - ${e.before}\n      + ${e.after}`)
  }
  if (report.errors.length) {
    lines.push(`✗ 自检失败 ${report.errors.length} 处（这些文件**未**处理）：`)
    for (const e of report.errors) lines.push(`    ${relTo(root, e.file)}  ${e.error}`)
  }
  return lines.join("\n")
}

/** 把整体 plan 结果落盘（原子写；先解析真身，绝不把软链替换成普通文件）。 */
export function applyReport(report) {
  const written = []
  for (const c of report.changed) {
    const real = realpathSync(c.file) // 软链：改真身，保住 documents/ 下那 69 个指向仓外的链接
    writeFileAtomic(real, c.next)
    written.push(real)
  }
  return written
}

// ── --selftest：造临时夹具，双向验证（该改的改、不该动的逐字节不动、第二遍 0 改动） ──
function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "iss1549-quote-"))
  const write = (rel, body) => {
    const p = join(dir, rel)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, body)
    return p
  }
  const fm = (titleLine, extra = "") => `---\ntype: issue\nid: ISS-000\n${titleLine}\nstatus: todo\n${extra}---\n\n正文\n`
  const cases = {
    // 该加引号（4 类 + 一条「以 `]` 收尾」—— 它不加引号会被 parseValue 切成数组）
    "issues/bracket.md": fm("title: [缺陷] 全屏时顶部留白不收起（多 48px 空白）"),
    "issues/bracket-close.md": fm("title: [a] [b]"),
    "issues/colon.md": fm("title: 标题: 带冒号"),
    "issues/bool.md": fm("title: true"),
    "issues/number.md": fm("title: 123"),
    // 不该动
    "issues/normal.md": fm("title: 正常标题"),
    "issues/already.md": fm('title: "[已加引号]"'),
    "issues/no-fm.md": "# 没有 frontmatter\n",
    "issues/block.md": "---\ntype: issue\ntitle: |\n  多行\n  标题\n---\n",
    // 排除面
    "issues.bak-iss1/old.md": fm("title: [缺陷] 副本里不该被改"),
    ".trash/gone.md": fm("title: [缺陷] 回收站里不该被改"),
  }
  const absOf = {}
  for (const [rel, body] of Object.entries(cases)) absOf[rel] = write(rel, body)
  const original = Object.fromEntries(Object.entries(absOf).map(([rel, p]) => [rel, readFileSync(p, "utf8")]))

  const problems = []
  const pass = (ok, msg) => (ok ? console.log(`  ✓ ${msg}`) : (problems.push(msg), console.log(`  ✗ ${msg}`)))

  console.log(`[selftest] 夹具：${dir}`)
  const plan = planRoot(dir)
  const changedRels = plan.changed.map((c) => relTo(dir, c.file)).sort()

  console.log("\n判据 1：该加引号的被点名（不该动的没被点名）")
  const mustChange = [
    "issues/bool.md",
    "issues/bracket-close.md",
    "issues/bracket.md",
    "issues/colon.md",
    "issues/number.md",
  ]
  pass(JSON.stringify(changedRels) === JSON.stringify(mustChange), `命中 = ${changedRels.join(", ")}`)
  pass(plan.errors.length === 0, `无自检失败（${plan.errors.length} 处）`)

  console.log("\n判据 2：不该动的逐字节不变（含备份目录/回收站被排除）")
  for (const rel of ["issues/normal.md", "issues/already.md", "issues/no-fm.md", "issues/block.md", "issues.bak-iss1/old.md", ".trash/gone.md"]) {
    pass(original[rel] === readFileSync(absOf[rel], "utf8"), `${rel} 未变`)
  }

  console.log("\n判据 3：dry-run 真的不写盘")
  pass(Object.entries(absOf).every(([rel, p]) => original[rel] === readFileSync(p, "utf8")), "规划阶段零写盘")

  console.log("\n判据 4：--apply 后形态正确，且读回值 = 原行上写的那串字")
  applyReport(plan)
  /** 原文件里 `title:` 行的字面文本（这才是「标题本来是什么」—— 撕掉引号规则前 parse 拿到的可能是数组/布尔）。 */
  const rawTitleOf = (text) => /^title:(.*)$/m.exec(text)[1].trim()
  for (const rel of ["issues/bracket.md", "issues/colon.md", "issues/bool.md", "issues/number.md", "issues/bracket-close.md"]) {
    const text = readFileSync(absOf[rel], "utf8")
    const title = parseFrontmatter(text).frontmatter.title
    const expected = rawTitleOf(original[rel])
    pass(text.includes('title: "'), `${rel} 落盘带双引号`)
    pass(title === expected, `${rel} 读回值 = 原文字：${JSON.stringify(title).slice(0, 46)}`)
  }
  // 「修之前确实是坏的」正面证据：这三类在**没加引号时** parse 出来的根本不是字符串
  // （`[a] [b]` → 数组、`true` → 布尔、`123` → 数字）。这是「引号不是美容，是止血」的判据。
  for (const rel of ["issues/bracket-close.md", "issues/bool.md", "issues/number.md"]) {
    const before = parseFrontmatter(original[rel]).frontmatter.title
    pass(typeof before !== "string", `${rel} 修前 parse 形状 = ${Array.isArray(before) ? "array" : typeof before}（不是字符串）`)
  }
  // 另外两类修前读得对，但没有引号时**真 YAML 读侧**会错（行首 `[` / 值内 `: `）—— 属预防非止血。
  for (const rel of ["issues/bracket.md", "issues/colon.md"]) {
    pass(typeof parseFrontmatter(original[rel]).frontmatter.title === "string", `${rel} 修前本仓读得对（预防性加引号）`)
  }
  // 只改 title 行：其它行逐行一致
  const after = readFileSync(absOf["issues/bracket.md"], "utf8")
  const strip = (s) => s.split("\n").filter((l) => !l.startsWith("title:")).join("\n")
  pass(strip(after) === strip(original["issues/bracket.md"]), "除 title 行外逐字节不变（不顺手重排字段）")

  console.log("\n判据 5：幂等 —— 第二遍 0 改动")
  const second = planRoot(dir)
  pass(second.changed.length === 0, `第二遍改动 = ${second.changed.length}（应为 0）`)

  rmSync(dir, { recursive: true, force: true })
  console.log(problems.length ? `\n✗ selftest 失败 ${problems.length} 项` : "\n✓ selftest 通过")
  return problems.length ? 1 : 0
}

function main() {
  if (has("--selftest")) return selftest()
  const root = optOf("--root") || defaultRoot()
  if (!existsSync(root)) {
    console.error(`语料根不存在，不判：${root}`)
    return 2
  }
  const report = planRoot(root)
  console.log(printReport(report, { applied: false }))
  if (report.errors.length) {
    console.error("\n自检失败 ⇒ 未写任何文件")
    return 1
  }
  if (!has("--apply")) {
    console.log("\n（dry-run：未写任何文件。加 --apply 才真写，走原子写 tmp+rename）")
    return 0
  }
  const written = applyReport(report)
  console.log(`\n已原子写入 ${written.length} 个文件。`)
  // 写完立刻复核一遍幂等（真盘上的第二遍）
  const again = planRoot(root)
  console.log(again.changed.length === 0 ? "✓ 复核：第二遍 0 改动（幂等）" : `✗ 复核：第二遍仍有 ${again.changed.length} 个文件要改`)
  return again.changed.length === 0 ? 0 : 1
}

// 只在作为脚本运行时跑 main（被 import 时——如别的脚本/selftest 探针——不产生副作用）。
// argv[1] 可能是 `-`（stdin 跑法）或断链 ⇒ 先 existsSync，不许让 main 守卫自己抛错。
const invoked = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : null
if (invoked && invoked === fileURLToPath(import.meta.url)) process.exitCode = main()
