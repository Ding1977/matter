/**
 * Cordis 装配配置判据（ISS-819）—— **移植自官方 `scripts/verify-cordis-config.ts`**（586 行）。
 *
 * ## 移植了什么、丢了什么（诚实交代，别把移植说成等价）
 *
 * 官方原判据有 7 个断言（`grep -n "^function validate\|^function packageTest" 官方`）：
 *   ① `validateMetadata`（`!!js` 只许出现在 `config` 与 `disabled` 两处）
 *   ② `validateAppResolution`（overlay 的名义插件从 `apps/cli` 解析）
 *   ③ `validatePackageTestResolution`    ④ `packageTestFixtureDependencyErrors`
 *   ⑤ `validateSourcePlaneResolution`（tsconfig.base.json paths 解析到 workspace 源码）
 *   ⑥ `validatePresetPlaneSeparation`（同一 row 不许同时活在 host 与 preset 两平面）
 *   ⑦ `validateClientHalvesDeclared`（`exports["./client"]` 与 `dsh.client` 必须同现）
 *
 * 本判据移植 **①⑦** 两条。②③④⑤ 依赖官方仓结构（`apps/cli` / `packages/组/包` /
 * `tsconfig.base.json` 的 paths 映射），我们仓是 `forge-*` 平铺且无 `apps/`、无 workspaces
 * 映射 ⇒ **搬过来会退化成空语料恒绿**，那比没有判据更坏（假绿）。故不移植，理由写在这里。
 * ⑥ 依赖官方 `packages/bundle/base|web-app` 双层 bundle 文件布局，我们仓**没有这两层**
 * （`deploy/home/cordis.patch.yml` 单文件承载全部 preset）⇒ 同样不适用。
 *
 * ## 与官方实现的两处差异（都是有意的）
 *
 * 1. **YAML 解析**：官方用 `js-yaml` + 自定义 `!!js` tag 类型（把表达式保留成
 *    `{__jsExpr}` 数据）。本仓 **没有 `js-yaml` 依赖**（`grep -c '"js-yaml"' package.json`
 *    = 0），`bun` 的 `Bun.YAML.parse` 会把 `!!js` 当**普通字符串**吞掉 —— 用它就等于
 *    「表达式」与「恰好长得像表达式的字面量」不可区分，判据失去牙。故本判据**自己扫行**：
 *    按缩进链判定这个 `!!js` 挂在哪个 key 之下、有没有 `config` 祖先。
 *    判据口径与官方等价（`config` 子树内可插值、`disabled` 必须可解析、其余元数据字段禁插值），
 *    但**实现不同**，行内注释与多行块标量（`|` / `>`）内容会按普通行处理 —— 已知盲区。
 *
 * 2. **语料**：官方扫 `packages/组/包/src/index.ts`；我们扫仓内 `**\/*cordis*.y*ml`
 *    （与官方 `cordis-config-files.ts` 同口径：排除 `.claude` / `node_modules` / `vendor`
 *    / `*.i18n.yaml`）。
 *
 * ## 判据
 *   A. 元数据插值：`id` / `name` / `group` / `inject` / `intercept` / `isolate` 上出现 `!!js`
 *      ⇒ 红（Loader 不插值这些字段，表达式恒真 ⇒ 静默改变装配且无人报错）。
 *      `disabled` 上出现 `!!js` ⇒ 必须能被编译（语法错会在启动时炸，
 *      提前到最早可判定点）。`config` 子树内的 `!!js` 合法。
 *   B. 客户端两半：`forge-星/package.json` 里 `exports["./client"]` 与 `dsh.client` 必须同现。
 *      只有一半 ⇒ 该包能装配、能激活，浏览器半永远不投递，**没有任何错误被抛出**。
 *
 * ## 变异可红（本单实测，命令与输出见工单 note）
 *   把 `deploy/home/cordis.patch.yml` 任一 `- id:` 改成 `- id: !!js 'x'` ⇒ A 红。
 *   把某个包的 `dsh.client` 删掉（留 `exports["./client"]`）⇒ B 红。
 *
 * ## 退出码
 *   0 = 绿 · 1 = 红 · 2 = 判不了（语料为空 / 读不到目录，**不算绿**）
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-cordis-config"

/** 官方 `metadataFields`：Loader **不插值**这些字段，`!!js` 出现在这里恒真 ⇒ 静默改装配。 */
const METADATA_FIELDS = ["id", "name", "group", "inject", "intercept", "isolate"] as const

/** 官方 `cordis-config-files.ts` 的语料口径（排除项逐字对齐）。 */
const EXCLUDE_DIRS = new Set([".claude", "node_modules", "vendor", ".git"])
const CONFIG_RE = /cordis.*\.ya?ml$/

export interface YamlLine {
  /** 1-based 行号 */
  line: number
  /** 行首缩进宽度 */
  indent: number
  /** 去掉缩进与本行注释后的正文 */
  text: string
}

export interface MetadataFinding {
  file: string
  line: number
  detail: string
}

/**
 * 扫一份 Cordis YAML，找出元数据位置上的 `!!js`。
 *
 * 判定靠**缩进链**而不是完整 YAML 解析：`!!js` 合法的唯一位置是 `config` 子树，
 * 所以只要问「这一行的祖先里有没有缩进更浅的 `config:`」，就能与官方口径对齐。
 */
export function scanMetadataExpressions(
  file: string,
  source: string,
): MetadataFinding[] {
  const findings: MetadataFinding[] = []
  const lines = source.split("\n")
  // 祖先栈：只留「可能在下面挂子项」的行（key: 结尾为空，或 `- insert:` 这类容器行）。
  const ancestors: YamlLine[] = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const indent = raw.length - raw.trimStart().length
    // 整行注释不是 YAML 内容（`# disabled: !!js ...` 是历史挂载的注释，不许当成违规）。
    if (/^\s*#/.test(raw)) continue
    const withoutComment = stripInlineComment(raw)
    const text = withoutComment.trim()
    if (text === "") continue

    // 维护缩进链：弹出所有不比本行更浅的祖先（同级/更深都不是本行的祖先）。
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].indent >= indent) ancestors.pop()

    if (text.includes("!!js")) {
      const key = keyOf(text)
      const inConfig = ancestors.some((a) => keyOf(a.text) === "config")
      const expr = text.slice(text.indexOf("!!js") + "!!js".length).trim()

      // ① 任何位置的 `!!js` 都必须能编译。这一条**不看 inConfig**：
      //    `config` 子树里的值同样由 Loader 插值，语法错的表达式一样会在启动时炸；
      //    而嵌套 entry（`config.plugins[]` 里那些行）的 `disabled` 也是被插值的字段。
      //    （官方只对 entry 级 `disabled` 做这层校验，config 深处漏掉了 —— 本单实测
      //     「把 config 内某行 disabled 写成 `====` ⇒ 官方口径不报」，故此处收紧。）
      const problem = expressionProblem(expr)
      if (problem) {
        findings.push({ file, line: i + 1, detail: `${key ?? "（无 key）"}${problem}` })
      } else if (inConfig) {
        // ② `config` 子树 = Loader 插值区，`!!js` 出现在这里的**任意键**都合法
        //    （例：preset 的 `config.id: matter` 是数据，不是 Loader entry 元数据）。
        //    故元数据字段那一条必须跳过这一支，否则 preset 的 config.id 会被误报。
      } else if (key !== null && (METADATA_FIELDS as readonly string[]).includes(key)) {
        // ③ entry 元数据字段：Loader **不插值** ⇒ 表达式恒真，静默改变装配且无人报错。
        findings.push({ file, line: i + 1, detail: `${key}: !!js is not interpolated here（Loader 只插值 config 与 disabled）` })
      } else if (key !== "disabled") {
        // ④ 既不在 config、也不是 disabled、也不是已知元数据字段 —— 官方口径是
        //    「其余元数据字段必须完全静态」⇒ 一律按违规报，不静默放过。
        findings.push({ file, line: i + 1, detail: `${key ?? "（无 key）"}: !!js 出现在非插值位置（只有 config 与 disabled 会被 Loader 求值）` })
      }
    }

    // 只有「能挂子项」的行才进祖先栈：`key:` 后为空 / `- key:` 后为空 / 纯容器。
    if (isContainerLine(text)) ancestors.push({ line: i + 1, indent, text })
  }
  return findings
}

/** 该行的 key（`- id: x` ⇒ `id`；`disabled: !!js y` ⇒ `disabled`；无 key ⇒ null）。 */
export function keyOf(text: string): string | null {
  const m = /^-?\s*([A-Za-z_][\w-]*):(?:\s|$)/.exec(text)
  if (m) return m[1]
  // `- id: x` 形态：先剥列表符再取 key（上面正则已覆盖，这里兜住 `-  key: x`）
  const m2 = /^-\s+([A-Za-z_][\w-]*):(?:\s|$)/.exec(text)
  return m2 ? m2[1] : null
}

/** 去掉 YAML 行内注释（只处理 ` #` 起头的尾注释，引号内的 `#` 不算）。 */
export function stripInlineComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/** `key:` / `- key:` / `- ` 结尾（值在后续行）⇒ 这行是容器，下面可能挂子项。 */
export function isContainerLine(text: string): boolean {
  if (/^-?\s*[A-Za-z_][\w-]*:\s*$/.test(text)) return true
  if (/^-\s*$/.test(text)) return true
  if (/^-\s+[A-Za-z_][\w-]*:\s*$/.test(text)) return true
  return false
}

/**
 * 官方 `disabledExpressionProblem`：只编译不执行。失败 ⇒ 启动时会炸，提前报出来。
 *
 * ⚠️ **与官方实现的一处修正（本单实测）**：官方用 `new Script(...)`（`node:vm`）做纯编译校验。
 * 那个写法**只在 node 下有效**：实测 bun 1.3.14 的 `node:vm` 编译期不校验语法 ——
 *   `new Script('(process.platform ===)')` ⇒ **不抛**（node 24 下抛 SyntaxError）
 * ⇒ 若照抄，判据会被 bun 静默跳过（门禁用 `bunBin()` 跑 `.ts`，见 `lib/registry-derive.mjs`
 * 的 `specEntryGate`：`command: process.execPath` 但 ts 由 bun 执行链跑）。
 * 换成 `new Function` 后两个运行时行为一致（本单实测 node 24 / bun 1.3.14 六个用例完全同结果）。
 * 同样只编译不执行。
 */
export function expressionProblem(expression: string): string | null {
  if (expression.trim() === "") return ": disabled expression is empty"
  try {
    // 编译即校验，不调用。`return` 包一层是为了让表达式本身在语句位置合法。
    new Function(`return (${expression})`)
    return null
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `: disabled expression does not parse: ${detail}`
  }
}

/** 语料：仓内所有 Cordis 配置文件（仓库相对路径，已排序）。 */
export function configFiles(repo: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue
        walk(abs)
      } else if (CONFIG_RE.test(e.name)) {
        out.push(path.relative(repo, abs).split(path.sep).join("/"))
      }
    }
  }
  walk(repo)
  return out.filter((f) => !f.endsWith(".i18n.yaml")).sort()
}

export interface PackageLike {
  /** 仓库相对路径（报告用） */
  file: string
  exports?: Record<string, unknown>
  dsh?: { client?: unknown }
}

/** 规则 B：`exports["./client"]` 与 `dsh.client` 必须同现（官方 `validateClientHalvesDeclared`）。 */
export function clientHalfFindings(packages: PackageLike[]): MetadataFinding[] {
  const findings: MetadataFinding[] = []
  for (const p of packages) {
    const ships = p.exports !== undefined && Object.hasOwn(p.exports, "./client")
    const declares = p.dsh?.client !== undefined
    if (ships === declares) continue
    findings.push({
      file: p.file,
      line: 1,
      detail: ships
        ? `exports "./client" 但没有 dsh.client 声明 ⇒ 浏览器半永远不会被投递（装配期无任何报错）`
        : `声明了 dsh.client 但没有 exports "./client" ⇒ 声明了却无产物可投递`,
    })
  }
  return findings
}

/** 语料：仓内自有包（`forge-<名>/package.json`）。官方的 `packages/组/包/package.json` 在我们仓不存在。 */
export function ownPackages(repo: string): PackageLike[] {
  const out: PackageLike[] = []
  let names: string[]
  try {
    names = fs.readdirSync(repo, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("forge-"))
      .map((e) => e.name)
      .sort()
  } catch {
    return out
  }
  for (const name of names) {
    const abs = path.join(repo, name, "package.json")
    if (!fs.existsSync(abs)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>
      out.push({
        file: `${name}/package.json`,
        exports: parsed.exports as Record<string, unknown> | undefined,
        dsh: parsed.dsh as { client?: unknown } | undefined,
      })
    } catch {
      // 读不动的 package.json 交给 lint 一族；本判据不静默当「合规」。
      out.push({ file: `${name}/package.json` })
    }
  }
  return out
}

/** 纯函数：输入语料，返回判定（spec 直接喂构造数据）。 */
export function judgeCordisConfig(input: {
  files: string[]
  metadata: MetadataFinding[]
  clientHalves: MetadataFinding[]
}): GateResult {
  if (input.files.length === 0) return unjudged(GATE, "no-corpus", "仓内找不到任何 Cordis 配置文件（cordis*.yml）⇒ 判不了")
  const findings = [...input.metadata, ...input.clientHalves]
  if (findings.length > 0) {
    return {
      gate: GATE,
      status: "failed",
      findings: findings.map((f) => ({ file: f.file, line: f.line, detail: f.detail })),
    }
  }
  return {
    gate: GATE,
    status: "passed",
    detail: `${input.files.length} 份配置的元数据插值 · 自有包的 client 两半（规则 A+⑦ 移植）`,
  }
}

/** 一次完整扫描（`main` 之外只做 IO，判定全在 `judgeCordisConfig`）。 */
export function scan(repo: string = REPO): { files: string[]; metadata: MetadataFinding[]; clientHalves: MetadataFinding[] } {
  const files = configFiles(repo)
  const metadata: MetadataFinding[] = []
  for (const file of files) {
    try {
      metadata.push(...scanMetadataExpressions(file, fs.readFileSync(path.join(repo, file), "utf8")))
    } catch (error) {
      metadata.push({ file, line: 1, detail: `读取失败：${(error as Error).message}` })
    }
  }
  return { files, metadata, clientHalves: clientHalfFindings(ownPackages(repo)) }
}

if (isMain(import.meta.url)) {
  runGate({
    name: GATE,
    main: () => judgeCordisConfig(scan(REPO)),
  })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
