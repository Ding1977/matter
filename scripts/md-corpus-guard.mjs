#!/usr/bin/env node
// 语料守卫（ISS-850 / L3-4a）—— `~/.dsh/pm/**/*.md`（md + frontmatter）的四条不变量。
//
// 真相源 = md + frontmatter（`forge-pm/lib/pm-store.js:5`）。三批收敛（L3-1 writer 归一 /
// L3-2 坏数据修复 / L3-4b 转义值归一）之后，语料的**形状**本身成了一条会被悄悄破坏的契约：
// 任何一次"看起来无害"的回写都可能把标题切成数组、把对象数组写成 `[object Object]`、
// 把第二套 writer 的引号风格复活。守卫就是把它们钉成数字。
//
// ── 四条判据（每条一句话必红条件）──────────────────────────────────────────
// 1. 幂等：任一文件 `serialize(parse(x))` 与再跑一轮的结果不一致 ⇒ 红（列文件名）。
// 2. 对象数组可解析：`scopeFiles`/`scopeCommits` 的值不能 `JSON.parse` 成对象数组 ⇒ 红
//    （白名单仅 REV-016，理由见 WHITELIST）。
// 3. 第二风格禁入：迁移域（members/teams/queue/sessions/runs）里出现「**非必要**的双引号标量值」⇒ 红
//    （"第二套 writer 复活"的当场信号）。**必要引号不算**（ISS-650 收窄，口径见下 §判据 3）。
// 4. 风险行棘轮：三类风险行计数与基线比只许多不许少 ⇒ 新增即红（只报 + 棘轮，不自动改）。
//
// ── 地板：分母为 0 时**不许判**（ISS-650 批2 审查 · critical）─────────────────
// 症状（2026-10-25 实测）：真数据根是 `~/.dsh-matter/pm`（4561 个 md），而 **agent bash 里
//   `DSH_HOME=<home>/.dsh`、那个目录下 0 个 md**。脚本照默认根跑，打印
//   「文件 0 · ✓ 四条判据全绿 · exit 0」—— 因为判据 1 在分母 0 时直接返回 100%（idempotentRate），
//   判据 2/3/4 的计数全是 0。**任何人从 agent 会话跑这条门禁都得到假绿**，「门禁 N 红」的统计随之失真。
// 地板三件（顺序即优先级）：
//   ① 根解析认 `FORGE_PM_ROOT`（3210 进程 env 就有）> `DSH_HOME`+`/pm` > `~/.dsh/pm`；
//   ② 扫到的 md < `MIN_CORPUS_FILES`（1000；本库 4561）⇒ 打印「未扫到语料，不判」+ **exit 3**
//      （0 = 全绿 / 1 = 判据红 / 3 = 不判，三者可分），并指出该设哪个环境变量；
//   ③ 扫到 md 但一个带 frontmatter 的都没有（判据 1/2/3/4 全无输入）⇒ 同样「不判」exit 3。
// 地板不是判据：分母不对时判据本身没有意义，报绿等于撒谎；但也不报红 —— 根找错不是语料坏了。
// `--min-files <n>` 只给自测用（夹具只有 2~4 个 md），日常别传。
//
// ── 分母与字段先于判据（ISS-650 批2：尺子错一次，四条判据一起假红）─────────────
// · 分母：跟软链、跳隐藏目录、**跳备份目录**（目录名带 `.bak`/`-bak`/`_bak` 段 —— 判据见 isBackupDir，
//   实测 `runs.bak-iss972/` 是 270 个 md 的语料副本、`state.bak-iss971/` 0 个）。排除了多少会打在输出里。
// · 字段：只认**顶格**的 `key:` 行。frontmatter 是扁平的，行首空白一律属于块标量（`prompt: |` 下的
//   正文/代码）或折行续行。旧版不判缩进，把 `scopeFiles: parseJsonArr(...)` 这类代码行当字段 ⇒
//   判据 2/3/4 一起红（实测缩进行占 3/36/277+333+12 处）。
//
// ── 判据 3 的"必要引号"口径（ISS-650 收窄，2026-10-24）──────────────────────
// 旧口径：迁移域里**任何** `key: "value"` 都算第二风格。ISS-650 起写侧会按需加引号，
// 于是这个口径会把**正确写法**判红：`title: "[需求] x"` 裸写会被真 YAML 当流式集合起始、
// `title: "标题: 带冒号"` 会被截断/报错、`title: "true"` 会读成布尔 —— 这些引号是止血，不是病。
// 新口径：**只有「白加的引号」算第二风格**。必要性不在这里复制规则，而是让 **writer 自己**判：
// 把值解码后交给 `serializeFrontmatter` 重新序列化一次 —— 它加引号 ⇒ 必要（放行）；
// 它不加而盘上带引号 ⇒ 白加（判红）。见 `quotedScalarIsNecessary()`。
// 为什么不 import codec 内部的 `needsQuoting`：它没导出，而导出面被两条守卫钉死
// （kit 与 pm 各一份 test），为一条判据放宽导出契约是拆防线；用 writer 当口径更硬且零漂移。
//
// ── 判据 3 为什么要"遗产账本"（口径实证，别当成刷基线）──────────────────────
// L3-1 归一的是**writer**，不是历史数据：迁移域里 397 个文件由旧 writer 写出，至今仍是
// `type: "member"` 这种第二风格，且**下次写入时自然归一**（ISS-850 activity 12:31 记录：
// "与原文逐字节一致 = 2574/2975 = 86.5%（余下 13.5% 即 members/teams/queue/sessions/runs
// 的第二风格文件，会在下次写入时自然归一）"）。所以判据 3 的必红条件是
// **"迁移域内出现**非必要**的双引号标量值，且该文件不在冻结遗产账本里"**（"非必要"= 上半节口径）
// —— 即"不得**再**出现"，
// 而不是"历史遗留必须今天清零"（后者只能靠改 `~/.dsh/pm` 数据，不属本脚本职责；实测现存
// 3485 处，按绝对口径判红则守卫出生即红、接不进收工体检）。
// 账本只许**降**：文件被新 writer 重写后条目即过期（会报「该摘掉」）；账本要**增长**只能是
// 第二套 writer 复活，`--write-baseline` 会拒绝吸收（需 `--force-legacy-grow` 显式放行）。
// 想按绝对口径看现状：`--strict-second-style`。
//
// ── 判据 4 的「带引号的值不算风险」（ISS-650 批2 审查 · critical）──────────────
// 症状：写侧（`forge-service-kit` 的 `INNER_AMBIGUOUS`）给「值里含 `: `」的标量**加引号** ——
// 那是正确写法（不加会被真 YAML 截断/报错）。而旧判据 4 见 `: ` 就计风险 ⇒ 同一批改动让两边互相打脸：
// 实测 15 条命中里 **9 条是带引号的正确写法**（如 `title: "trader.module.css: .t196 …"`），
// 基线 `scripts/baseline/md-corpus.json` 又恰好收到等于旧现值（`secondColon:14`）⇒ 维持不到一天就红。
// 口径（选 A，不选「棘轮留 buffer」）：**先看原始写法** —— 值已用双引号闭合 ⇒ YAML 侧无歧义 ⇒ 不计。
// 为什么不选 B（基线 +N / 比例阈值）：那是把阈值放松去迁就尺子错，同一个错下次会以别的数字回来；
// A 修的是「判据与写侧口径不对齐」本身，棘轮数字一个都不动（本单没改基线文件一个字节）。
// 反向控制：同一条值去掉引号 ⇒ 立刻计入（`--selftest` 把两侧都钉住，见「判据4 · 带引号」两条）。
//
// ── 两条硬纪律 ──────────────────────────────────────────────────────────
// · `--selftest`：造**临时夹具目录**（绝不读真 `~/.dsh/pm`），每条判据**双向**验证
//   （该红的红、干净的不红）。“从没红过的守卫等于没有守卫”（K8b）。
// · 不判：根不存在 / 分母 < 阈值 ⇒ 打印「未扫到语料，不判」+ `exit 3`（**不是** exit 0：
//   旧版在这里 exit 0，于是「判不了」与「全绿」同码，谁都看不出自己扫了个空目录，见文件头 §地板）。
//
// 用法：node scripts/md-corpus-guard.mjs [--check] [--root <dir>] [--write-baseline]
//        [--force-legacy-grow] [--strict-second-style] [--min-files <n>] [--selftest] [--verbose]

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, join, relative, sep } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { parseFrontmatter, parseValue, serializeFrontmatter } from "../forge-service-kit/lib/frontmatter.js"

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url))
const SELF_PATH = fileURLToPath(import.meta.url)
const BASELINE_PATH = join(SCRIPT_DIR, "baseline", "md-corpus.json")

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const optOf = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined)
const VERBOSE = has("--verbose")
const STRICT = has("--strict-second-style")

/**
 * 语料根：`FORGE_PM_ROOT` > `DSH_HOME`+`/pm` > `~/.dsh/pm`。
 * ⚠️ 只认 `DSH_HOME` 不够（ISS-650 批2 审查 critical）：**agent bash 里 `DSH_HOME=~/.dsh`，
 *   而那个目录下 0 个 md**（真数据在 `~/.dsh-matter/pm`）。`FORGE_PM_ROOT` 优先是因为
 *   3210 进程 env 本来就带着它（`<home>/.dsh-matter/pm`）—— 有它就不该再猜。
 */
const DEFAULT_ROOT = process.env.FORGE_PM_ROOT
  || (process.env.DSH_HOME || process.env.HOME + "/.dsh") + "/pm"
const ROOT = optOf("--root") || DEFAULT_ROOT

/**
 * 地板阈值：本库语料 4561 个 md（2026-10-26 实测，含备份目录外的一切）。低于它 = 根没找对，
 * 不是「语料真的少了」—— 一个几千文件的语料库不会一夜只剩几百。宁可不判，不许假绿。
 */
const MIN_CORPUS_FILES = 1000
const MIN_FILES = Number(optOf("--min-files") ?? MIN_CORPUS_FILES)

/** 迁移域：L3-1 归一后，这三套 writer 写过的域**不得再**出现第二风格。 */
const MIGRATION_DOMAINS = ["members", "teams", "queue", "sessions", "runs"]

/** 对象数组字段：值必须是 JSON 内联的对象数组。 */
const OBJECT_ARRAY_KEYS = ["scopeFiles", "scopeCommits"]

/**
 * 白名单：唯一一处已知不可 `JSON.parse` 的对象数组。
 *   `reviews/2026-08-27-REV-016-iss-091.md` = `[[object Object]×3]` —— 旧 writer 逐条 `String(e)`
 *   的产物，**结构化信息已永久丢失**（原对象内容不可逆），重写只会把它变成空数组。
 *   故此处承认丢失、只登记不判红（ISS-850 L3-2：7 处坏数据 → 6 处无损重建 + 这 1 处承认丢失）。
 * 到期口径：该文件的 frontmatter 被人工补回等价结构（或该单归档出真相源）之日 = 摘除白名单之日；
 *   摘除后条目变「过期」会被点名（不静默保留）。
 */
const WHITELIST = {
  "reviews/2026-08-27-REV-016-iss-091.md":
    "旧 writer `String(e)` 产物 `[[object Object]×3]`，结构已永久丢失（Lead 2026-09-26 承认）" +
    "⇒ 只登记不判红；补回等价结构或该单出真相源即摘除。",
}

/**
 * 三类风险行（只报 + 棘轮，不自动改）。口径写死在这里，别处不许再解释一遍：
 * · unclosedFlow —— 值以 `[`/`{` 起头却**没有**对应的收尾符。`parseValue` 会走到
 *   `slice(1,-1).split(",")` 那一支，于是 `title: [abc] def` 这种标题被**切成一个数组**，
 *   一次回写即永久变形（真语料现算 1）。
 * · secondColon —— 值里出现第二个 `: `，且该整行的值**不是** JSON 内联流
 *   （`[...]`/`{...}` 是 canonical writer 的正常产物，含 `": "` 天经地义，不能算风险），
 *   也**不是**带引号的标量值（ISS-650 批2：写侧给这类值加引号 = 正确写法，见文件头 §判据 4）。
 *   真 YAML 读侧只对**未加引号**的 `: ` 报错/截断（真语料现算 6；带引号的 9 处不计）。
 * · hashComment —— 值里出现 ` # `（空格-#-空格：真 YAML 里最明确的注释起始形态）。
 *   故意**不**收 `#123` 这种形态（`PR #11619` 之类在本仓遍地都是，收进来就是天天假红）
 *   （真语料现算 1）。
 */
const RISK_CLASSES = [
  ["unclosedFlow", "`key: [xxx] …` 未闭合流式起始（回写会把标题切成数组）"],
  ["secondColon", "值内第二个冒号（非 JSON 内联流、也未加引号的 `: `）"],
  ["hashComment", "值内含 ` # `（真 YAML 解析器的注释起始）"],
]

const RiskSummary = (r) => RISK_CLASSES.map(([k]) => `${k}=${r[k]}`).join(" / ")

// ────────────────────────── 读盘（只读，绝不写语料） ──────────────────────────

/**
 * 备份目录判据（ISS-650 批2）：目录名里带 **`.bak` / `-bak` / `_bak` 段**（大小写不敏感），
 * 紧跟 `-` `.` `_` 数字或到结尾。实测全仓就两种形态：`runs.bak-iss972`（270 个 md，语料副本）、
 * `state.bak-iss971`（0 个 md，状态快照）。
 * **故意不收** `backup` / `*.bkp`：收宽会把将来真叫 `backups/` 的语料域误排除，而现状没有这种形态
 * ——排太多与排太少都是坏尺子，判据按实测形态写死在这里。
 */
const isBackupDir = (name) => /(^|[.\-_])bak([.\-_\d]|$)/i.test(name)

/** 数一个备份目录里的 md 个数（只用于报告「排除了多少」，不参与任何判据）。 */
function countMdFiles(dir, seen = new Set()) {
  let real
  try { real = realpathSync(dir) } catch { return 0 }
  if (seen.has(real)) return 0 // 软链成环
  seen.add(real)
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  let n = 0
  for (const e of entries) {
    const p = join(dir, e.name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) n += countMdFiles(p, seen)
    else if (st.isFile() && e.name.endsWith(".md")) n++
  }
  return n
}

/**
 * 收集语料 md（**跟软链**、**跳过隐藏目录与备份目录**）。
 * · 跟软链是必须的：`~/.dsh/pm/documents/` 里 69 个 md 是指向仓外的软链，只认
 *   `dirent.isFile()` 会静默把它们漏掉（实测分母从 2974 掉到 2905）。
 * · 跳过隐藏目录：`.trash` 是回收站、`.git` 是 pm-backup 的仓库 —— 都不是真相源。
 * · 跳过备份目录（判据见 `isBackupDir`）：`runs.bak-iss972/` 是 270 个 md 的**语料副本**，
 *   它原来被当语料扫进来，判据 2/3/4 都在数同一批内容的影子（ISS-650 批2）。
 *   排掉几个目录、排掉多少个 md 会打在输出里（excludedBackups），不许静默缩小分母。
 *   断链 = 不存在，直接跳过（不是"没有 frontmatter"）。
 */
function walkMd(dir, base = dir, acc = { files: [], excluded: [] }, seen = new Set()) {
  let real
  try { real = realpathSync(dir) } catch { return acc }
  if (seen.has(real)) return acc // 软链成环时只走一次
  seen.add(real)
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    const p = join(dir, e.name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (isBackupDir(e.name)) {
        acc.excluded.push({ dir: relative(base, p).split(sep).join("/"), mdFiles: countMdFiles(p) })
        continue
      }
      walkMd(p, base, acc, seen)
    } else if (st.isFile() && e.name.endsWith(".md")) acc.files.push(relative(base, p).split(sep).join("/"))
  }
  return acc
}

/**
 * frontmatter 的原始行（key / rawValue / 行号）；只认 `---` 围栏内**顶格**的单行 `k: v`。
 * ⚠️ 「顶格」是硬判据（ISS-650 批2）：真 frontmatter 是扁平的，行首空白一律属于块标量
 * （`prompt: |` 下的正文/代码）或折行的续行，**不是字段**。旧版不判缩进，把块标量里的代码行
 * 当字段 ⇒ `scopeFiles: parseJsonArr(frontmatter.scopeFiles)` 被当对象数组、
 * `const base = x ? "main": "HEAD"` 被当第二风格/风险行 —— 判据 2/3/4 一起假红
 * （实测判据 2 的 3 处、判据 3 的 36 处、判据 4 的 277/333/12 处全是缩进行）。
 */
function rawFmLines(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return null
  const out = []
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s/.test(line)) continue // 缩进行 = 块标量内容 / 续行，不是字段行
    if (/^-\s+/.test(line)) continue // 顶格的块状列表项，不是字段行
    const ci = line.indexOf(":")
    if (ci <= 0) continue
    const key = line.slice(0, ci).trim()
    if (!key) continue
    out.push({ key, raw: line.slice(ci + 1).trim(), line: i + 2 })
  }
  return out
}

const isFlowInline = (raw) =>
  (raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))
const isQuotedScalar = (raw) => raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')

/**
 * 这条引号是不是**必要**的（ISS-650 收窄判据 3 的口径）。
 *
 * 真实义：把被引号包着的标量解码，再让 **writer 自己**重新序列化一次 ——
 *   · writer 给它加引号 ⇒ 引号必要（`[需求] x` 裸写会被真 YAML 当流式集合起始、`标题: 带冒号`
 *     会被截断/报错、`true`/`123` 会读成布尔/数字）⇒ 属于**正确写法**，不算第二风格；
 *   · writer 不给它加引号 ⇒ 引号是白加的（`name: "张三"`、`type: "member"`）⇒ 旧第二套 writer
 *     的指纹，照旧判红。
 *
 * ⚠️ 为什么不 `import { needsQuoting }`：那个谓词**没有导出**，而 codec 的导出面被两条守卫钉死
 *    （`forge-service-kit/lib/frontmatter.test.js`「导出面恰好五个名字」+
 *    `forge-pm/lib/frontmatter-writer-equivalence.test.js`），为一条判据去放宽那两条契约，
 *    等于用「拆防线」换「一条判据」。改用 **writer 当口径**更硬：真正决定加不加引号的就是它，
 *    `needsQuoting` 只是它的内部谓词 —— 既不新增导出，也不复制一份规则（复制 = 下一次漂移）。
 * ⚠️ 探针用固定键名 `x`（不拿语料里的 key）：key 可能带引号/怪字符，探针只关心**值的形态**。
 */
function quotedScalarIsNecessary(raw) {
  const decoded = parseValue(raw)
  if (typeof decoded !== "string") return false // 引号里解不出字符串 ⇒ 一定是白加/坏值
  const line = serializeFrontmatter({ x: decoded }, "").split("\n")[1] ?? ""
  return line.startsWith('x: "') // writer 会给这个值加引号 ⇒ 必要
}

/** 单次度量（只读）。返回一个纯数据 payload，判据与打印都从它出发。 */
export function measure(root) {
  const walked = walkMd(root)
  const files = walked.files.sort()
  const res = {
    files: files.length,
    excludedBackups: walked.excluded.sort((a, b) => a.dir.localeCompare(b.dir)),
    fmFiles: 0,
    idempotentBad: [],
    objArrayTotal: 0,
    objArrayBad: [],
    objArrayWhitelisted: [],
    objArrayStaleWhitelist: [],
    secondStyle: [],
    secondStyleNecessary: [], // ISS-650：必要引号（正确写法），只计数报告，**不进**判据
    secondStyleFiles: [],
    risk: { unclosedFlow: 0, secondColon: 0, hashComment: 0 },
    riskDetail: { unclosedFlow: [], secondColon: [], hashComment: [] },
  }
  for (const rel of files) {
    let text
    try { text = readFileSync(join(root, rel), "utf8") } catch { continue }
    const fmLines = rawFmLines(text)
    if (fmLines === null) continue
    res.fmFiles++

    // ── 判据 1：幂等（serialize(parse(x)) 必须是定点）──
    const p1 = parseFrontmatter(text)
    const r1 = serializeFrontmatter(p1.frontmatter, p1.body)
    const p2 = parseFrontmatter(r1)
    const r2 = serializeFrontmatter(p2.frontmatter, p2.body)
    if (r1 !== r2) res.idempotentBad.push(rel)

    // ── 判据 2：对象数组可解析 ──
    for (const { key, raw, line } of fmLines) {
      if (!OBJECT_ARRAY_KEYS.includes(key)) continue
      res.objArrayTotal++
      let ok = false
      try {
        const v = JSON.parse(raw)
        ok = Array.isArray(v) && v.every((e) => e && typeof e === "object" && !Array.isArray(e))
      } catch { ok = false }
      if (!ok) {
        if (WHITELIST[rel]) res.objArrayWhitelisted.push({ rel, key, raw, line })
        else res.objArrayBad.push({ rel, key, raw, line })
      }
    }

    // ── 判据 3：第二风格（迁移域内**非必要**的双引号标量值）──
    // ISS-650：必要引号（`title: "[需求] x"` 这种）是**正确写法** —— 裸写会被真 YAML 当流式
    // 集合起始。所以这里只认「白加的引号」，口径交给 writer 自己判（见 quotedScalarIsNecessary）。
    if (MIGRATION_DOMAINS.includes(rel.split("/")[0])) {
      for (const { key, raw, line } of fmLines) {
        if (!isQuotedScalar(raw)) continue
        if (quotedScalarIsNecessary(raw)) res.secondStyleNecessary.push({ rel, key, raw, line })
        else res.secondStyle.push({ rel, key, raw, line })
      }
    }

    // ── 判据 4：风险行三类（只计数，不改）──
    for (const { key, raw, line } of fmLines) {
      if ((raw.startsWith("[") && !raw.endsWith("]")) || (raw.startsWith("{") && !raw.endsWith("}"))) {
        res.risk.unclosedFlow++
        res.riskDetail.unclosedFlow.push({ rel, key, raw, line })
      }
      // 带引号的标量值不算风险：引号已经把 `: ` 消歧（写侧正是这么写的，见文件头 §判据 4）。
      if (!isFlowInline(raw) && !isQuotedScalar(raw) && /: /.test(raw)) {
        res.risk.secondColon++
        res.riskDetail.secondColon.push({ rel, key, raw, line })
      }
      if (raw.includes(" # ")) {
        res.risk.hashComment++
        res.riskDetail.hashComment.push({ rel, key, raw, line })
      }
    }
  }
  // 白名单过期：登记了却不再命中（说明已修好/已出真相源 ⇒ 该摘掉）
  const wlHits = new Set(res.objArrayWhitelisted.map((x) => x.rel))
  for (const w of Object.keys(WHITELIST)) if (!wlHits.has(w)) res.objArrayStaleWhitelist.push(w)
  // ⚠️ 分母 0 时**没有**幂等率可言。旧版在这里直接返回 100 ⇒ 判据 1 恒真 —— 这正是
  //   地板一要拦的形态（见文件头 §地板）：main() 在分母 < MIN_FILES 时先「不判」退出，判据根本不跑。
  //   这里返回 null 而不是 0/100：0 会被读成"全坏"、100 会被读成"全好"，两者都是编造。
  res.idempotentRate = res.fmFiles
    ? Number((((res.fmFiles - res.idempotentBad.length) / res.fmFiles) * 100).toFixed(1))
    : null
  res.secondStyleFiles = [...new Set(res.secondStyle.map((h) => h.rel))].sort()
  return res
}

/** 幂等率的打印形态：分母 0 时明说没有分母，绝不印 100%（那正是假绿的来源）。 */
const rateText = (m) => (m.fmFiles ? `${m.idempotentRate}%` : "n/a（分母 0）")

// ────────────────────────── 四条判据（纯函数，便于双向自测） ──────────────────────────

function fmtHit({ rel, key, raw, line }, max = 78) {
  const v = raw.length > max ? raw.slice(0, max) + "…" : raw
  return `${rel}:${line}  ${key}: ${v}`
}

/**
 * 判据结果：全部返回 `{ id, name, red, summary, detail[], note? }`。
 * `baseline` 可以为 null（基线缺席）—— 那时判据 3 按最严（账本为空）、判据 4 无从比较，
 * 两条都**判红**而不是静默放行（K8b：没牙的守卫等于没有守卫）。
 */
export function judgeResults(m, baseline, opts = {}) {
  const ledger = new Set(opts.ledger || [])
  const strict = opts.strict ?? STRICT
  const out = []

  // 判据 1 —— 幂等
  const idemOk = m.idempotentBad.length === 0
  out.push({
    id: 1,
    name: "幂等（serialize(parse(x)) 是定点）",
    red: !idemOk,
    summary: idemOk
      ? `${m.fmFiles}/${m.fmFiles} 文件二次规范化是定点（幂等率 ${rateText(m)}）`
      : `${m.idempotentBad.length}/${m.fmFiles} 文件二次规范化不是定点（再跑一轮还会变）`,
    detail: m.idempotentBad.map((f) => `    ${f}`),
  })

  // 判据 2 —— 对象数组可解析
  const objOk = m.objArrayBad.length === 0
  out.push({
    id: 2,
    name: `对象数组可解析（${OBJECT_ARRAY_KEYS.join("/")}）`,
    red: !objOk,
    summary: objOk
      ? `${m.objArrayTotal} 处全部可 JSON.parse 成对象数组（白名单 ${m.objArrayWhitelisted.length} 处：REV-016）`
      : `${m.objArrayBad.length} 处不可 JSON.parse 成对象数组（且不在白名单）`,
    detail: m.objArrayBad.map((h) => `    ${fmtHit(h)}`),
    note: m.objArrayStaleWhitelist.length
      ? `! 白名单过期（登记了却不再命中 ⇒ 该摘掉）：${m.objArrayStaleWhitelist.join(", ")}`
      : undefined,
  })

  // 判据 3 —— 第二风格
  const legacyHits = m.secondStyle.filter((h) => ledger.has(h.rel))
  const newHits = strict ? m.secondStyle : m.secondStyle.filter((h) => !ledger.has(h.rel))
  const legacyFiles = [...new Set(legacyHits.map((h) => h.rel))].sort()
  const stale = strict ? [] : [...ledger].filter((f) => !m.secondStyleFiles.includes(f)).sort()
  const sc3Ok = newHits.length === 0
  const notes = []
  if (stale.length) notes.push(`! 遗产账本可缩小（已归一，该摘掉）：${stale.length} 文件，如 ${stale.slice(0, 3).join(" / ")}`)
  if (sc3Ok && !strict && ledger.size === 0 && m.secondStyle.length)
    notes.push(`! 遗产账本为空（基线缺席）⇒ 现存 ${m.secondStyle.length} 处遗留全部按新增处理`)
  out.push({
    id: 3,
    name: "第二风格禁入（迁移域内不得再出现**非必要**的双引号标量值）",
    red: !sc3Ok,
    summary: sc3Ok
      ? `迁移域 0 处新增第二风格（冻结遗产账本 ${ledger.size} 文件 / 现存 ${legacyFiles.length} 文件 · ${legacyHits.length} 处为 L3-1 归一前的遗留，只许降；必要引号 ${(m.secondStyleNecessary || []).length} 处已放行）`
      : strict
        ? `迁移域内命中 ${newHits.length} 处第二风格（--strict-second-style 绝对口径，覆盖 ${[...new Set(newHits.map((h) => h.rel))].length} 文件）`
        : `迁移域内出现 ${newHits.length} 处第二风格，且不在冻结遗产账本里（第二套 writer 复活）`,
    detail: newHits.slice(0, VERBOSE ? 1e9 : 12).map((h) => `    ${fmtHit(h)}`),
    note: notes.join("\n") || undefined,
  })

  // 判据 4 —— 风险行棘轮
  const riskBase = baseline?.metrics?.riskLines
  if (!riskBase) {
    out.push({
      id: 4,
      name: "风险行棘轮（三类只许降不许升）",
      red: true,
      summary: "基线缺席 ⇒ 棘轮无从比较（不静默放行；跑 --write-baseline 落基线）",
      detail: RISK_CLASSES.map(([k, d]) => `    · ${k} = ${m.risk[k]}  ${d}`),
    })
  } else {
    const grew = RISK_CLASSES.filter(([k]) => m.risk[k] > (riskBase[k] ?? 0))
    out.push({
      id: 4,
      name: "风险行棘轮（三类只许降不许升）",
      red: grew.length > 0,
      summary: grew.length
        ? grew.map(([k]) => `${k} 新增 ${m.risk[k] - (riskBase[k] ?? 0)}（${m.risk[k]} > 基线 ${riskBase[k] ?? 0}）`).join("；")
        : RISK_CLASSES.map(([k]) => `${k} ${m.risk[k]}≤${riskBase[k] ?? 0}`).join(" · "),
      detail: grew.flatMap(([k, d]) => [
        `    ✗ ${k}：${m.risk[k]} > ${riskBase[k] ?? 0} —— ${d}`,
        ...m.riskDetail[k].slice(0, 10).map((h) => `    ${fmtHit(h)}`),
      ]),
    })
  }
  return out
}

// ────────────────────────── 基线 ──────────────────────────

function readBaseline() {
  try { return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) } catch { return null }
}

export function buildBaseline(m, prev, opts = {}) {
  const prevLedger = prev?.legacySecondStyle?.files ?? null
  const grown = prevLedger ? m.secondStyleFiles.filter((f) => !prevLedger.includes(f)) : []
  if (grown.length && !has("--force-legacy-grow")) {
    // quiet：自测里这条是**预期通过**的判据，别在自测输出里打一个会被读成"失败"的 ✗
    //（guard-baselines.sh 自己的注释：报告里出现与事实相反的符号，比缺一条检查更贵）。
    if (!opts.quiet) {
      console.log(`✗ 拒绝写基线：冻结遗产账本要**增长** ${grown.length} 个文件 —— 这不是刷基线，是第二套 writer 复活的信号：`)
      for (const f of grown.slice(0, 20)) console.log(`    + ${f}`)
      console.log("  → 先查这几处是不是旧 writer 写出来的；确认无误再 `--force-legacy-grow`。")
    }
    return null
  }
  const now = new Date().toISOString()
  return {
    generatedAt: now,
    metric: "md-corpus-guard（ISS-850/L3-4a）· 真相源 = $DSH_HOME/pm 下 md + frontmatter（跟软链、跳过隐藏目录）",
    note: [
      "判据 1/2 是绝对判据，不许靠本文件通过；判据 3 只把**冻结遗产账本**里的文件当既有事实。",
      "metrics.riskLines 是判据 4 的上限（只许降不许升）；legacySecondStyle 是判据 3 的冻结遗产账本（只许降）。",
      "数字来源：`node scripts/md-corpus-guard.mjs --write-baseline` 在 " + now.slice(0, 10) + " 的真语料上现算，逐项见 metrics。",
    ].join(" "),
    metrics: {
      files: m.files,
      fmFiles: m.fmFiles,
      idempotentRate: m.idempotentRate,
      idempotentBad: m.idempotentBad.length,
      objArrayOccurrences: m.objArrayTotal,
      objArrayBad: m.objArrayBad.length,
      objArrayWhitelisted: m.objArrayWhitelisted.length,
      secondStyleHits: m.secondStyle.length, // 只数**非必要**引号（ISS-650 收窄）
      secondStyleNecessaryHits: m.secondStyleNecessary.length, // 必要引号（正确写法），仅供对照
      secondStyleFiles: m.secondStyleFiles.length,
      riskLines: { ...m.risk },
      riskNote: Object.fromEntries(RISK_CLASSES.map(([k, d]) => [k, d])),
    },
    legacySecondStyle: {
      frozenAt: now,
      note: [
        "冻结时刻的第二风格遗产：L3-1 writer 归一（commit 09f80a25）之前由旧 writer 写的迁移域文件，",
        "按 ISS-850 activity 12:31 的记录「下次写入时自然归一」。判据 3 = 迁移域内出现**非必要**的双引号标量值",
        "（ISS-650 收窄：必要引号由 writer 口径放行，见脚本头 §判据 3），且文件不在本账本里 ⇒ 红。**只许降**：文件被新 writer 重写后条目即过期（守卫会报「该摘掉」）；",
        "本账本增长 = 第二套 writer 复活，不是正常刷基线（--write-baseline 会拒绝吸收）。",
      ].join(""),
      files: m.secondStyleFiles,
    },
  }
}

// ────────────────────────── selftest（临时夹具，不读真语料） ──────────────────────────

const CLEAN_FM = `---
type: issue
id: ISS-0000
title: 干净夹具
status: todo
tags: [a, b]
scopeFiles: [{"path":"x.md","status":"M"}]
created: 2026-09-26
---
正文
`

const CLEAN_MEMBER_FM = `---
type: member
id: MEM-000
name: 干净成员
teams: [TEA-001]
---
正文
`

const FIXTURES = {
  // ① 非幂等：JSON 内联数组的元素里带真换行 ⇒ 第一轮把数组 join 成多行（`criteria: [a` + `b]`），
  //    第二轮 `[a` 被当未闭合流切片 ⇒ 变 `[]`。serialize→parse→serialize 会变。
  //    ⚠️ Lead 建议的 `k: |` 形状实测**是幂等的**（见提交说明），故夹具用这条实测能红的。
  nonIdempotent: `---\ncriteria: ["a\\nb"]\nok: 1\n---\n正文\n`,
  objArray: `---\nscopeCommits: [[object Object]]\n---\n正文\n`, // ② 不可 JSON.parse
  objArrayWhitelisted: `---\nscopeCommits: [[object Object]×3]\n---\n正文：REV-016 承认丢失\n`, // ②' 白名单那条 → 不判红
  secondStyle: `---\ntype: "member"\nid: "MEM-999"\n---\n正文\n`, // ③ 第二风格（白加引号）
  // ③-a 必要引号（ISS-650）：裸写会被真 YAML 当流式集合起始 ⇒ 是正确写法，**不许**判第二风格
  necessaryQuote: `---\ntype: member\nid: MEM-999\ntitle: "[需求] x"\n---\n正文\n`,
  // ③-b 非必要引号：`普通标题` 没有任何歧义却被套了引号 ⇒ 旧 writer 指纹，必须判红
  unnecessaryQuote: `---\ntype: member\nid: MEM-999\ntitle: "普通标题"\n---\n正文\n`,
  risk: `---\ntitle: [abc] def\nk: a: b\nk2: x # y\n---\n正文\n`, // ④ 三类风险行各一处
  // ④-a/④-b（ISS-650 批2 审查 · critical）判据 4 的地板：**值含 `: ` 但已加引号** ⇒ YAML 侧无歧义，
  //   不许计 secondColon（写侧对这类值就是加引号，两边必须同一口径）；同一条值裸写 ⇒ 必计。
  //   两个夹具刻意只差一对引号：排除是不是"恒不数"，就看裸写那条还在不在。
  quotedColon: `---\ntype: issue\nid: ISS-0002\ntitle: "trader.module.css: .t196 缺闭合花括号"\n---\n正文\n`,
  bareColon: `---\ntype: issue\nid: ISS-0003\ntitle: trader.module.css: .t196 缺闭合花括号\n---\n正文\n`,
  // ⑤（ISS-650 批2）块标量里的缩进行**不是字段**：`prompt: |` 下的代码行照着 ②③④ 的形状写，
  //    但行首有空白 ⇒ rawFmLines 必须跳过它们（旧版把这三行当字段 ⇒ 判据 2/3/4 假红）。
  blockScalar: `---\nid: ISS-0001\nprompt: |\n  scopeFiles: parseJsonArr(frontmatter.scopeFiles),\n  type: "member"\n  title: [abc] def\n  k2: x # y\n---\n正文\n`,
}

function writeFixture(root, rel, text) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "md-corpus-guard-selftest-"))
  const clean = join(dir, "clean")
  const dirty = join(dir, "dirty")
  const recs = []
  const record = (name, ok, extra = "") => {
    recs.push({ name, ok })
    console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` —— ${extra}` : ""}`)
  }
  try {
    console.log(`── 夹具（临时目录，绝不读真 ~/.dsh/pm）：${dir} ──`)
    console.log('   ① 非幂等 criteria: ["a\\nb"]   ② scopeCommits: [[object Object]]   ③ type: "member"   ④ title: [abc] def / k: a: b / k2: x # y')
    console.log('   ④\' 带引号 vs 裸写的 `: ` 值（判据 4 地板）   ⑤ 块标量缩进行 / *.bak* 备份目录')
    writeFixture(clean, "issues/2026-01-01-ISS-0000-clean.md", CLEAN_FM)
    writeFixture(clean, "members/2026-01-01-MEM-000-clean.md", CLEAN_MEMBER_FM)
    // ⑤ 块标量里的缩进行 + 两个备份目录里的"影子语料"：都不许进扫描面（ISS-650 批2）
    writeFixture(clean, "issues/2026-01-01-ISS-0001-block.md", FIXTURES.blockScalar)
    writeFixture(clean, "runs.bak-iss000/2026-01-01-ISS-0000-shadow.md", FIXTURES.objArray)
    writeFixture(clean, "issues/probe.bak-run/bad-shadow.md", FIXTURES.secondStyle)

    writeFixture(dirty, "issues/2026-01-01-ISS-0000-clean.md", CLEAN_FM)
    writeFixture(dirty, "members/2026-01-01-MEM-000-clean.md", CLEAN_MEMBER_FM)
    writeFixture(dirty, "issues/bad1-nonidempotent.md", FIXTURES.nonIdempotent)
    writeFixture(dirty, "reviews/bad2-objarray.md", FIXTURES.objArray)
    writeFixture(dirty, "reviews/2026-08-27-REV-016-iss-091.md", FIXTURES.objArrayWhitelisted)
    writeFixture(dirty, "members/bad3-secondstyle.md", FIXTURES.secondStyle)
    writeFixture(dirty, "issues/bad4-risk.md", FIXTURES.risk)

    // ISS-650：判据 3 收窄后的双向夹具（迁移域里「必要引号」vs「非必要引号」各一条，
    // 两条放在**同一个根**里 ⇒ 尺子只要能把它们分开，就证明它不是恒绿也不是恒红）
    const quoted = join(dir, "quoted")
    writeFixture(quoted, "members/ok-necessary.md", FIXTURES.necessaryQuote)
    writeFixture(quoted, "members/bad-unnecessary.md", FIXTURES.unnecessaryQuote)

    const mClean = measure(clean)
    const mDirty = measure(dirty)
    const baseClean = { metrics: { riskLines: { ...mClean.risk } }, legacySecondStyle: { files: [] } }
    const byId = (rs, id) => rs.find((r) => r.id === id)
    const j = (m, baseline, opts) => judgeResults(m, baseline, opts)

    // ── 判据 1：双向 ──
    const c1 = byId(j(mClean, baseClean, { ledger: [] }), 1)
    const b1 = byId(j(mDirty, baseClean, { ledger: [] }), 1)
    record("判据1 幂等：干净夹具不红", c1.red === false, `幂等率 ${rateText(mClean)}`)
    record("判据1 幂等：注入 ① 必红", b1.red === true && b1.detail.some((d) => d.includes("bad1-nonidempotent")),
      `红 ${mDirty.idempotentBad.length} 个（${mDirty.idempotentBad.join(", ")}）`)

    // ── 判据 2：双向（含白名单反向控制）──
    const c2 = byId(j(mClean, baseClean, { ledger: [] }), 2)
    const b2 = byId(j(mDirty, baseClean, { ledger: [] }), 2)
    record("判据2 对象数组：干净夹具不红", c2.red === false, `${mClean.objArrayTotal} 处可解析`)
    record("判据2 对象数组：注入 ② 必红", b2.red === true && mDirty.objArrayBad.length === 1,
      `红 ${mDirty.objArrayBad.length} 处（${mDirty.objArrayBad.map((h) => h.rel).join(", ")}）`)
    record("判据2 对象数组：白名单 REV-016 那条不红（反向控制）",
      mDirty.objArrayBad.every((h) => !h.rel.includes("REV-016")) && mDirty.objArrayWhitelisted.length === 1,
      `白名单命中 ${mDirty.objArrayWhitelisted.length} 处、未计入红`)

    // ── 判据 3：双向（遗产账本口径 + 绝对口径）──
    const c3 = byId(j(mClean, baseClean, { ledger: [] }), 3)
    const b3 = byId(j(mDirty, baseClean, { ledger: [] }), 3)
    const b3ledger = byId(j(mDirty, baseClean, { ledger: ["members/bad3-secondstyle.md"] }), 3)
    const b3strict = byId(j(mDirty, baseClean, { ledger: [], strict: true }), 3)
    record("判据3 第二风格：干净夹具（含迁移域 canonical 文件）不红", c3.red === false,
      `迁移域命中 ${mClean.secondStyle.length} 处`)
    record("判据3 第二风格：注入 ③ 必红", b3.red === true && b3.summary.includes("复活"),
      `红 ${mDirty.secondStyle.length} 处（${mDirty.secondStyleFiles.join(", ")}）`)
    record("判据3 第二风格：③ 列入遗产账本后不红（双向：账本不是恒绿）", b3ledger.red === false,
      "账本 1 文件 ⇒ 新增 0 处")
    record("判据3 第二风格：--strict-second-style 下账本内也照红", b3strict.red === true,
      `绝对口径命中 ${mDirty.secondStyle.length} 处`)

    // ── 判据 3 的必要性口径（ISS-650）：必要引号放行 / 非必要引号照旧红 ──
    const mQuoted = measure(quoted)
    const q3 = byId(j(mQuoted, { metrics: { riskLines: { ...mQuoted.risk } }, legacySecondStyle: { files: [] } }, { ledger: [] }), 3)
    record("判据3 收窄：必要引号（`title: \"[需求] x\"`）不算第二风格",
      mQuoted.secondStyleNecessary.length === 1 && mQuoted.secondStyle.length === 1,
      `必要 ${mQuoted.secondStyleNecessary.length} 处放行 / 非必要 ${mQuoted.secondStyle.length} 处计入`)
    record("判据3 收窄：同一根里的非必要引号（`title: \"普通标题\"`）照旧判红",
      q3.red === true && q3.detail.some((d) => d.includes("bad-unnecessary")),
      `红 ${mQuoted.secondStyle.length} 处 → ${mQuoted.secondStyle.map((h) => h.rel).join(", ")}`)
    record("判据3 收窄：放行不是因为恒绿 —— 同一根里必要引号**没有**出现在红名单里",
      !q3.detail.some((d) => d.includes("ok-necessary")), "红名单只含 bad-unnecessary.md")

    // ── 判据 3 的反作弊：刷基线不许**吸收**新遗产（否则一次 --write-baseline 就把牙拔了）──
    const grewRefused = buildBaseline(mDirty, { legacySecondStyle: { files: [] } }, { quiet: true })
    const grewAllowed = buildBaseline(mDirty, { legacySecondStyle: { files: mDirty.secondStyleFiles } }, { quiet: true })
    record("判据3 反作弊：遗产账本要增长 ⇒ --write-baseline 拒绝吸收（返回 null，需 --force-legacy-grow）",
      grewRefused === null, "prev 账本为空而夹具含 1 个第二风格文件")
    record("判据3 反作弊：账本无增长时照常写（反向控制：拒绝不是恒拒绝）",
      grewAllowed !== null && grewAllowed.legacySecondStyle.files.length === mDirty.secondStyleFiles.length,
      `写出的账本 ${grewAllowed?.legacySecondStyle?.files?.length} 文件`)

    // ── 判据 4：双向（基线 = 干净夹具计数；再验基线缺席不静默）──
    const c4 = byId(j(mClean, baseClean, { ledger: [] }), 4)
    const b4 = byId(j(mDirty, baseClean, { ledger: [] }), 4)
    const b4nobase = byId(j(mDirty, null, { ledger: [] }), 4)
    const grewAll = RISK_CLASSES.every(([k]) => mDirty.risk[k] > mClean.risk[k])
    record("判据4 风险行棘轮：干净夹具对同源基线不红", c4.red === false, RiskSummary(mClean.risk))
    record("判据4 风险行棘轮：注入 ④ 后三类都新增 ⇒ 必红", b4.red === true && grewAll,
      `夹具 ${RiskSummary(mDirty.risk)} vs 基线 ${RiskSummary(mClean.risk)}`)
    record("判据4 风险行棘轮：基线缺席 ⇒ 判红而不是静默放行", b4nobase.red === true, b4nobase.summary)

    // ── 判据 4 的地板（ISS-650 批2 审查 critical）：带引号的 `: ` 值不算风险 ──
    // 两个夹具只差一对引号 ⇒ 三条断言合起来证明「排除」既不恒真也不恒假：
    //   ① 带引号那条**不**进 secondColon；② 裸写那条**必须**进；③ 计数正好 1（不是 0 也不是 2）。
    const colonRoot = join(dir, "colon")
    writeFixture(colonRoot, "issues/quoted-colon.md", FIXTURES.quotedColon)
    writeFixture(colonRoot, "issues/bare-colon.md", FIXTURES.bareColon)
    const mColon = measure(colonRoot)
    const colonRels = mColon.riskDetail.secondColon.map((h) => h.rel)
    record("判据4 · 带引号：`title: \"trader.module.css: .t196 …\"`（写侧正确写法）不计入 secondColon",
      mColon.risk.secondColon === 1 && !colonRels.includes("issues/quoted-colon.md"),
      `命中 ${mColon.risk.secondColon} 处：${colonRels.join(", ") || "（无）"}`)
    record("判据4 · 反向控制：同一条值去掉引号 ⇒ 立刻计入（排除不是「恒不数」）",
      colonRels.includes("issues/bare-colon.md"),
      `裸写那条在命中名单里：${colonRels.includes("issues/bare-colon.md")}`)

    // ── 尺子本身（ISS-650 批2）：顶格才认字段 / 备份目录不进扫描面 ──
    record("尺子：块标量里的缩进行不当字段（⑤ 的 scopeFiles/第二风格/风险行都不计入）",
      mClean.objArrayTotal === 1 && mClean.secondStyle.length === 0
      && Object.values(mClean.risk).every((n) => n === 0),
      `对象数组 ${mClean.objArrayTotal} 处（只有干净夹具那 1 处）· 第二风格 ${mClean.secondStyle.length} 处 · 风险行 ${RiskSummary(mClean.risk)}`)
    record("尺子：备份目录（*.bak*）不进扫描面（顶层 runs.bak-* 与嵌套 issues/*.bak-* 各一处）",
      mClean.files === 3 && mClean.excludedBackups.length === 2
      && mClean.excludedBackups.every((x) => x.mdFiles === 1)
      && mClean.excludedBackups.some((x) => x.dir === "runs.bak-iss000")
      && mClean.excludedBackups.some((x) => x.dir === "issues/probe.bak-run"),
      `文件 ${mClean.files} · 排除 ${mClean.excludedBackups.map((x) => `${x.dir}(${x.mdFiles})`).join(" / ")}`)
    // 反向控制：把同一条坏行**顶格**写进语料 ⇒ 判据 2 必须红（证明上一条不是"恒不数"）
    writeFixture(clean, "issues/bad5-toplevel.md", FIXTURES.objArray)
    const mProbe = measure(clean)
    record("尺子反向控制：同一条坏行改成顶格 ⇒ 判据 2 必红（缩进能免，顶格不能免）",
      byId(j(mProbe, baseClean, { ledger: [] }), 2).red === true && mProbe.objArrayBad.length === 1,
      `红 ${mProbe.objArrayBad.length} 处（${mProbe.objArrayBad.map((h) => `${h.rel}:${h.line}`).join(", ")}）`)

    // ── 地板（ISS-650 批2 审查 critical）：分母为 0 ⇒ 不许判、不许绿。真跑子进程，验 stdout 与退出码 ──
    // 旧行为是「--root 不存在 ⇒ 不判 + exit 0」⇒ 与「四条判据全绿」同码，扫了空目录的人看不出差别。
    const runCli = (extra) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [SELF_PATH, ...extra], { encoding: "utf8" }) }
      } catch (e) {
        return { code: e.status ?? -1, out: String(e.stdout ?? "") + String(e.stderr ?? "") }
      }
    }
    const missing = join(dir, "no-such-corpus")
    const rMissing = runCli(["--check", "--root", missing])
    record("地板①：--root 不存在 ⇒ 「未扫到语料，不判」+ exit 3（旧版 exit 0 = 与全绿同码）",
      rMissing.code === 3 && rMissing.out.includes("未扫到语料，不判"), `exit=${rMissing.code}`)

    const emptyRoot = join(dir, "empty-corpus")
    mkdirSync(emptyRoot, { recursive: true })
    const rEmpty = runCli(["--check", "--root", emptyRoot])
    record("地板①：根存在但 0 个 md ⇒ 「未扫到语料，不判」+ exit 3，且**不许**出现「四条判据全绿」",
      rEmpty.code === 3 && rEmpty.out.includes("未扫到语料，不判") && !rEmpty.out.includes("四条判据全绿"),
      `exit=${rEmpty.code}：${rEmpty.out.split("\n").find((l) => l.includes("不判")) ?? ""}`)

    // 反向控制用**独立小根**（不复用 clean：它在上面已被塞了坏行做反向验证，拿来当"该绿的根"会误判）
    const miniRoot = join(dir, "mini-corpus")
    writeFixture(miniRoot, "issues/2026-01-01-ISS-0000-clean.md", CLEAN_FM)
    writeFixture(miniRoot, "issues/2026-01-01-ISS-0001-block.md", FIXTURES.blockScalar)
    const rReal = runCli(["--check", "--root", miniRoot, "--min-files", "1"])
    record("地板①反向控制：真夹具（--min-files 1）不许报「不判」（地板不是恒不判）",
      rReal.code === 0 && !rReal.out.includes("不判"),
      `exit=${rReal.code}（2 个干净 md 对真基线 ⇒ 该全绿）`)

    const failed = recs.filter((r) => !r.ok)
    console.log(failed.length
      ? `\n✗ 守卫自检失败：${failed.length}/${recs.length} 条`
      : `\n✓ 守卫自检通过：${recs.length}/${recs.length} 条（每条判据都有「该红」与「不红」两侧）`)
    return failed.length === 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ────────────────────────── main ──────────────────────────

function main() {
  if (has("--selftest")) {
    process.exitCode = selftest() ? 0 : 1
    return
  }

  /**
   * 地板（见文件头 §地板）：判不了就说判不了，**exit 3**。
   * 为什么不是 exit 0（旧行为）：0 同时表示「四条判据全绿」—— 两者同码时，扫了空目录的人看不见。
   * 为什么不是 exit 1：判据红要说清是**哪条**判据红；根找错跟语料好坏无关，别把环境问题伪装成数据问题。
   */
  const unjudged = (why, detail) => {
    console.log(`· 根 ${ROOT}`)
    console.log(`✗ 未扫到语料，不判：${why}${detail ? `（${detail}）` : ""}`)
    console.log("  ⇒ 不报红也不报绿，但**不是通过**：exit 3（全绿 = 0 / 判据红 = 1 / 不判 = 3，三者可分）")
    console.log("  本库真语料在 `~/.dsh-matter/pm`（4561 个 md）；agent bash 的 `DSH_HOME` 常是 `~/.dsh`（0 个 md）。")
    console.log("  指定根：`FORGE_PM_ROOT=<pm 目录>` / `DSH_HOME=<home>` / `--root <目录>`。")
    process.exitCode = 3
  }

  if (!existsSync(ROOT)) { unjudged(`根不存在（${ROOT}）`); return }

  const m = measure(ROOT)
  // 分母 < 阈值 ⇒ 四条判据都没有意义（判据 1 的 0/0 会算成 100%，判据 2/3/4 的计数全是 0）。
  if (!(m.files >= MIN_FILES)) { unjudged("扫到的 md 少于阈值，分母不可信", `${m.files} < ${MIN_FILES}`); return }
  // 分母够大但一个带 frontmatter 的都没有 ⇒ 判据 1/2/3/4 全无输入，同样不许判。
  if (m.fmFiles === 0) { unjudged("扫到的 md 里 0 个带 frontmatter，四条判据全无输入", `${m.files} 个 md`); return }

  const prev = readBaseline()

  if (has("--write-baseline")) {
    const payload = buildBaseline(m, prev)
    if (!payload) { process.exitCode = 1; return }
    mkdirSync(join(SCRIPT_DIR, "baseline"), { recursive: true })
    writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n")
    console.log(`语料守卫（ISS-850/L3-4a）· root=${ROOT}`)
    console.log(`· 文件 ${m.files}（有 frontmatter ${m.fmFiles}）· 幂等率 ${rateText(m)}`)
    console.log(`· 对象数组 ${m.objArrayTotal} 处（不可解析 ${m.objArrayBad.length} · 白名单 ${m.objArrayWhitelisted.length}）`)
    console.log(`· 第二风格 ${m.secondStyle.length} 处 / ${m.secondStyleFiles.length} 文件（冻结为遗产账本）`)
    console.log(`· 风险行 ${RiskSummary(m.risk)}`)
    console.log(`· 已写基线 ${relative(process.cwd(), BASELINE_PATH)}（生成 ${payload.generatedAt}）`)
    process.exitCode = 0
    return
  }

  const ledger = prev?.legacySecondStyle?.files ?? []
  const results = judgeResults(m, prev, { ledger })
  console.log(`语料守卫（ISS-850/L3-4a）· root=${ROOT}${STRICT ? " · --strict-second-style" : ""}`)
  console.log(`· 文件 ${m.files}（有 frontmatter ${m.fmFiles}）· 幂等率 ${rateText(m)}`
    + ` · 基线 ${prev ? prev.generatedAt : "缺席"}`)
  if (m.excludedBackups.length) {
    console.log(`· 已排除备份目录 ${m.excludedBackups.length} 个（共 ${m.excludedBackups.reduce((a, b) => a + b.mdFiles, 0)} 个 md，不进任何判据）：`
      + m.excludedBackups.map((x) => `${x.dir}(${x.mdFiles})`).join(" / "))
  }
  for (const r of results) {
    console.log(`${r.red ? "✗" : "✓"} 判据${r.id} ${r.name}：${r.summary}`)
    for (const d of r.detail) console.log(d)
    if (r.note) for (const n of r.note.split("\n")) console.log(`    ${n}`)
  }
  const red = results.filter((r) => r.red)
  if (red.length) {
    console.log(`\n✗ 语料守卫不通过（${red.length}/4 条判据红）`)
    process.exitCode = 1
  } else {
    console.log("\n✓ 语料守卫通过：四条判据全绿")
    process.exitCode = 0
  }
}

// 只在作为脚本运行时跑 main（被 import 时——如 selftest 探针——不产生副作用）。
// argv[1] 可能是 `-`（stdin 跑法）或断链 ⇒ 先 existsSync，不许让 main 守卫自己抛错。
const invoked = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : null
if (invoked && invoked === realpathSync(SELF_PATH)) main()
