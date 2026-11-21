/**
 * 死代码闸的第一段：`v8 ignore` 必须带真理由（ISS-844 / W0-GATE-G8）。
 *
 * ## 本单**只**做这一条，不做覆盖率（写给将来的人看）
 *
 * 工单原本要三件：① 新树 per-file 100% coverage 配置 ② `v8 ignore` 必带理由 ③ 逐位置报告器。
 * 实际只交 ②，理由**不是**「时间不够」，是**只有 ② 现在能验证**：
 *
 *   · ① 与 ③ 的判据是「覆盖率跑出来没有」—— 而新树 `packages/` **现在一个源文件都没有**。
 *     没有语料就编不出正例，也编不出反例。**编不出反例的判据等于没判**（本仓同族教训：
 *     `verify-plugin-shape.ts` 文件头把第 9 条明确标成「简化版」，因为完整推导没有真实
 *     manifest 可对照，照抄 73 行等于搬一堆永远走不到的分支）。
 *   · ② 的输入是**源码里的注释**，与有没有覆盖率产物无关 ⇒ 今天就能造正例、造反例、
 *     造变异，今天就能红。前面两个 builder 零产出的形态正是「做的东西无法验证」。
 *   · 前两件不是被否决，是**欠着**：等新树有真实包与真实覆盖率产物，另开单接。
 *
 * ## 判什么
 *
 * 出处（**逐字**）：DSH `~/dsh-src/packages/client/AGENTS.md:130`
 *   > Genuinely unreachable defensive arms take a `/* v8 ignore -- <reason> *\/` comment
 *   > with a **real reason, never a bare ignore**.
 *
 * | 形态 | 判定 |
 * |---|---|
 * | `/* v8 ignore *\/` | ⛔ 红（裸 ignore） |
 * | `/* v8 ignore next *\/` | ⛔ 红（`next` 是**位置指令**不是理由） |
 * | `/* v8 ignore next 8 *\/` | ⛔ 红（`8` 是行数不是理由） |
 * | `/* v8 ignore -- <理由> *\/` | ✅ 绿（理由 `trim()` 后 ≥ `MIN_REASON` 字符） |
 * | `/* v8 ignore next -- <理由> *\/` | ✅ 绿 |
 * | `/* v8 ignore start -- <理由> *\/` / `else` / `if` / `file` | ✅ 绿 |
 * | `/* v8 ignore stop *\/` | ✅ 绿（**配对终止符，语义上没有「理由」这一栏**） |
 *
 * ### 为什么 `stop` 放行（这不是漏洞，是 v8 的语义）
 *
 * `start`/`stop` 是一对区间标记：理由写在 **`start` 那一侧**，`stop` 只负责关区间。
 * 实测 DSH 全树（`packages/* / *` 共 3050 个 src 文件）：`start` 79 条**全部**带理由，
 * `stop` 79 条**全部**不带 —— 若把 `stop` 也判红，那 79 条会在落地当天全红，
 * 而修法只能是给每条终止符抄一遍 start 的理由（同一句话说两遍，正是「注释即噪声」）。
 * 同口径见上游实现 `ast-v8-to-istanbul`（`dist/index.mjs:190`）：它的两个正则
 * `p`（`if|else|next|file`）与 `h`（`start|stop`）**本来就分家**，`h` 那一组从不解析理由。
 *
 * ### 为什么必须「锚定在注释开头」
 *
 * 判据只看**注释开头**是不是指令（`ANCHOR`），不做子串匹配。实测 DSH 树里有几处注释
 * **正文提到** `v8 ignore` 而本身不是指令，例如
 * `packages/experimental/ptc-runtime-python/src/index.ts:1910` 的
 * `// (oxlint block-disable so both \`v8 ignore next\` and the rule`。
 * 子串匹配会把这种散文判红，而它连指令都不是 —— 假红会让这条门禁被静默关掉。
 * 本判据实测：3050 个文件里这种「提及但非指令」的注释 1 处，被正确排除。
 *
 * ## 语料从哪来（为什么用 AST 而不是正则/grep）
 *
 * 正则扫 `/* v8 ignore *\/` 会**假红**：字符串、模板串、正则字面量、JSX 文本里的同样字符
 * 都不是注释。实测反例：`const re = /[/*] v8 ignore/`（正则里含 `/*`）用裸 scanner 会被当成
 * 一个多行注释（`/*] v8 ignore/`）⇒ 假红一条根本不存在的问题。
 *
 * 本判据的口径：**先把字面量区间抹成空格（保长度与换行），再跑 TypeScript 的 scanner 取注释**。
 *   · 抹字面量 ⇒ 字符串/模板/正则/JSX 文本里的「注释」不再被当成注释；
 *   · 抹成**空格而不是删除** ⇒ 偏移与行号不变，报出来的 `path:line` 就是编辑器里的那一行。
 *
 * **为什么不能只靠 scanner 一句也不抹**：实测 `packages/experimental/ptc-runtime-python/src/index.ts`
 * 里有一段 `/…/` 形态的内容会让 scanner 把后面 2000 多行里的注释全部吞掉（该文件 20 条指令
 * 裸扫只看到 5 条）⇒ 15 条指令静默漏判 = 假绿。抹字面量后 20/20 全部看到。
 *
 * **为什么不能只靠 AST 的 `getLeadingCommentRanges`**：它挂在节点上，**没有节点的地方就取不到**
 * 注释（纯注释文件、`<div>{/* … *\/}</div>` 里的 JSX 空表达式容器）。实测那种 JSX 注释一个都取不到。
 *
 * ## 射程（说清不判什么，别把这行读成「已覆盖」）
 *
 * · 扫 `packages/<group>/<pkg>/src/**\/*.{ts,tsx}` —— 与 DSH 覆盖率闸的射程同划法
 *   （`docs/testing.md:10`：per-file 100% on `packages/* / * / src`）。
 *   ⚠️ `packages/* / * / src` 是**两段**野卡，不是任意深度；本判据照同一形状走。
 * · `tests/` 在射程内（DSH 把测试放在 `<pkg>/tests/`，不在 `src/` 下）—— 天然不进。
 * · 不判 `.js` / `.mjs` / `.d.ts`：新树源码是 TS；`.d.ts` 没有可执行行，`v8 ignore` 无意义。
 * · 不判 `/* istanbul ignore *\/` / `node:coverage ignore`：它们是**别的工具**的指令，
 *   本格只执行 DSH AGENTS.md 那一条原话。要收它们先改规范，不在判据里顺手扩大射程。
 *
 * ## 退出码
 *   0 = 绿 · 1 = 红 · 2 = 判不了（0 个包 / 0 个文件 / 找不到 typescript ⇒ `no-corpus` / `no-binary`）
 *
 * ⛔ **0 个文件绝不许判绿**：新树现在就是 0 个包，屏幕上出现 ✓ 会是「一行源码没扫，判据说没事」
 * 的假绿（本仓同族：ISS-731/2174/2180/2182 四单都是「扫空算绿」，逐一改成退 2）。
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "lint-dead-code"

/** 语料根：`packages/<group>/<pkg>/src`（与 DSH 覆盖率闸同射程，见文件头）。 */
export const CORPUS_ROOT = "packages"

/**
 * 理由的最短长度（`trim()` 之后按字符数算）。
 *
 * 为什么是 5 而不是 12：本仓另一处同类阈值 `WHY_MIN_LEN = 12`（`lib/registry-derive.mjs`，
 * 管 `allowFailureWhy`）判的是**豁免理由**，那里 12 有依据。这里判的是**覆盖率指令的理由**，
 * 两者不是一件事，抄 12 会与工单给的判据打架（工单原文：`-- <理由>` 且 `trim()` 后 ≥5 字符）。
 * 实测 DSH 全树 964 条带理由的指令：最短 13 字符、中位 66 —— 5 这个下限在真实语料上
 * **一条都不误伤**，同时挡得住 `-- ok` / `-- x` 这类敷衍。
 */
export const MIN_REASON = 5

/**
 * 指令锚点：注释正文（已去掉 `//` 或 `/*` `*\/`）**开头**必须是 `v8 ignore`。
 * `\s*` 前缀吃掉缩进与 JSDoc 的 `*`；`\b` 保证 `v8 ignored` 之类不误命中。
 */
const ANCHOR = /^\s*\**\s*v8\s+ignore\b/

/** v8 认的指令词（`ast-v8-to-istanbul:190` 的两个正则合起来就是这七个）。 */
const DIRECTIVES = new Set(["next", "start", "stop", "if", "else", "file"])

/** 配对终止符：语义上没有「理由」这一栏（见文件头「为什么 stop 放行」）。 */
const NO_REASON_SLOT = new Set(["stop"])

/** 一种违规。`line` 必须有 —— 没有行号的意见改不动。 */
export interface V8Finding {
  file: string
  line: number
  /** 注释原文（单行化后截断），供报告直接引用 */
  comment: string
  detail: string
}

/** 一条已解析的指令。spec 直接构造这种数据喂给 `judgeDirectives`（纯函数，不碰 IO）。 */
export interface Directive {
  file: string
  line: number
  /** 指令词；`""` = 连指令词都没有的裸 ignore（`/* v8 ignore *\/`） */
  kind: string
  /** `--` 之后的文本（已 trim）；`null` = 注释里没有 `--` */
  reason: string | null
  /** 注释原文，报告里回显用 */
  comment: string
}

/** 单条注释的指令解析（纯函数）。不是指令 ⇒ 返回 null（散文提及不判）。 */
export function parseDirective(file: string, line: number, rawComment: string): Directive | null {
  const body = stripCommentDelimiters(rawComment)
  if (!ANCHOR.test(body)) return null
  const rest = body.replace(ANCHOR, "")
  const wordMatch = /^\s*([A-Za-z]+)/.exec(rest)
  const word = wordMatch && DIRECTIVES.has(wordMatch[1]) ? wordMatch[1] : ""
  // 位置参数（`next 8` 的 `8`）不是指令词也不是理由，跳过它再看 `--`。
  const tail = word ? rest.slice(wordMatch![0].length) : rest
  const dash = /^\s*(?:\d+\s*)?--\s*([\s\S]*)$/.exec(tail)
  return {
    file,
    line,
    kind: word,
    reason: dash ? collapse(dash[1]) : null,
    comment: collapse(rawComment),
  }
}

function stripCommentDelimiters(raw: string): string {
  if (raw.startsWith("//")) return raw.slice(2)
  if (raw.startsWith("/*")) return raw.slice(2, raw.endsWith("*/") ? -2 : raw.length)
  return raw
}

/** 多行注释压成单行：报告里回显不用带一堆换行与缩进。 */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * **纯函数**：一批指令 → 判定。spec 直接喂构造数据。
 *
 * 三条红：① 没有理由 ② 理由太短 ③ 裸 ignore（连指令词都没有）。
 * `stop` 不进这三条（见文件头）。
 */
export function judgeDirectives(directives: readonly Directive[], filesScanned: number): GateResult {
  if (filesScanned === 0) {
    return unjudged(
      GATE,
      "no-corpus",
      `${CORPUS_ROOT}/<group>/<pkg>/src 下 0 个 .ts/.tsx（新树 W1 之前就是这个状态）⇒ 没有可判的对象，不判绿`,
    )
  }
  const findings: V8Finding[] = []
  for (const d of directives) {
    if (NO_REASON_SLOT.has(d.kind)) continue
    const shown = d.comment.length > 90 ? `${d.comment.slice(0, 90)}…` : d.comment
    if (!d.reason) {
      findings.push({
        file: d.file,
        line: d.line,
        comment: shown,
        detail: d.kind
          ? `\`v8 ignore ${d.kind}\` 没有理由 —— 加 \`-- <为什么这行测不到>\`（DSH packages/client/AGENTS.md:130：never a bare ignore）`
          : "裸 `v8 ignore`：既没说作用范围也没有理由 —— 写 `v8 ignore next -- <理由>`",
      })
      continue
    }
    if ([...d.reason].length < MIN_REASON) {
      findings.push({
        file: d.file,
        line: d.line,
        comment: shown,
        detail: `理由太短（${[...d.reason].length} 字符 < ${MIN_REASON}）：「${d.reason}」是敷衍不是理由 —— 说清为什么这行**测不到**`,
      })
    }
  }
  if (findings.length === 0) {
    return {
      gate: GATE,
      status: "passed",
      detail: `${filesScanned} 个源文件 · ${directives.length} 条 v8 ignore 指令，全部带理由（理由 ≥${MIN_REASON} 字符）`,
    }
  }
  return {
    gate: GATE,
    status: "failed",
    findings: findings.map((f) => ({ file: f.file, line: f.line, detail: f.detail })),
    detail: `${filesScanned} 个源文件 · ${directives.length} 条指令中有 ${findings.length} 条没有真理由`,
  }
}

/** 扫到的语料：文件清单 + 每条指令。 */
export interface Corpus {
  files: string[]
  directives: Directive[]
}

/** 语料根是否真的存在且是目录（区分「0 个文件」的两种成因，报告里要说清是哪一种）。 */
export function corpusExists(root: string = REPO): boolean {
  try {
    return fs.statSync(path.join(root, CORPUS_ROOT)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 是不是本判据认的源文件。
 *
 * `src/` **内部**的任意深度都收（包可以有 `src/client/x.ts` 这样的子层）——
 * 「恰好两段」限的是**包的位置**（`packages/<group>/<pkg>`），不是包内的目录深度。
 * `.d.ts` 排除：声明文件没有可执行行，`v8 ignore` 在那里无意义（写了也没人执行）。
 */
function isSourceTs(name: string): boolean {
  if (name.endsWith(".d.ts")) return false
  return /\.tsx?$/.test(name)
}

/**
 * 收 `packages/<group>/<pkg>/src/**` 下的 `.ts/.tsx`（相对仓库根，posix 分隔、已排序）。
 *
 * 用 fs 遍历而不是 `git ls-files`：门禁要在**开发期**也判得到刚写、还没 `git add` 的文件。
 * 包的深度**恰好两段**（group / pkg），与 `packages/* / * / src` 同形 ——
 * `packages/a/b/c/src` 这种三段嵌套不进射程（那是包布局本身的问题，
 * 由 `verify-plugin-shape` 判「包必须住在 packages/<group>/<pkg>」）。
 */
export function collectFiles(root: string = REPO): string[] {
  const base = path.join(root, CORPUS_ROOT)
  let groups: fs.Dirent[]
  try {
    groups = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const next = `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue
        walk(path.join(dir, e.name), next)
      } else if (e.isFile() && isSourceTs(e.name)) {
        out.push(next)
      }
    }
  }
  for (const g of groups) {
    if (!g.isDirectory() || g.name.startsWith(".") || g.name === "node_modules") continue
    let pkgs: fs.Dirent[]
    try {
      pkgs = fs.readdirSync(path.join(base, g.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const p of pkgs) {
      if (!p.isDirectory() || p.name.startsWith(".") || p.name === "node_modules") continue
      walk(path.join(base, g.name, p.name, "src"), `${CORPUS_ROOT}/${g.name}/${p.name}/src`)
    }
  }
  return out.sort()
}

/** 本判据认得的 typescript 入口（与 `lint-layer-new.ts` / `gen-layer-graph.ts` 同一套候选）。 */
export const TS_CANDS = [
  "node_modules/typescript/lib/typescript.js",
  "forge-ui/node_modules/typescript/lib/typescript.js",
  "forge-pm/node_modules/typescript/lib/typescript.js",
]

/** 找 typescript；找不到 ⇒ null（调用方判 `no-binary`，不许假装判过）。 */
export function loadTs(root: string = REPO): unknown | null {
  for (const base of [root, REPO]) {
    let req: NodeRequire
    try {
      req = createRequire(path.join(base, "package.json"))
    } catch {
      continue
    }
    for (const c of TS_CANDS) {
      const abs = path.join(base, c)
      if (!fs.existsSync(abs)) continue
      try {
        // 传**绝对路径**：`forge-ui/node_modules/...` 当模块名解析会被当成 scope 包查 node_modules
        // （实测：写成 req(c) 时候选全 MISS ⇒ 本判据在真仓里恒 unjudged）。
        return req(abs)
      } catch {
        /* 换下一个候选 */
      }
    }
    try {
      return req("typescript")
    } catch {
      /* 换下一个 base */
    }
  }
  return null
}

/** 需要在扫描前抹掉的「字面量」类节点（它们里面的同样字符不是注释）。 */
const LITERAL_KINDS = [
  "StringLiteral",
  "NoSubstitutionTemplateLiteral",
  "RegularExpressionLiteral",
  "JsxText",
  "TemplateHead",
  "TemplateMiddle",
  "TemplateTail",
] as const

/**
 * 把字面量区间抹成空格（**保长度、保留换行**），其余原样返回。
 *
 * 抹成空格而不是删掉，是为了让后续 scanner 报出的偏移/行号与原文逐字对应 ——
 * 报错要能定位到编辑器里那一行（工单要求 `path:line`）。
 */
export function blankLiterals(ts: any, text: string, fileName: string): string {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kindOf(ts, fileName))
  const literalKinds = new Set<number>(LITERAL_KINDS.map((k) => ts.SyntaxKind[k]))
  const chars = text.split("")
  const walk = (n: any): void => {
    if (literalKinds.has(n.kind)) {
      for (let i = n.getStart(sf); i < n.end; i++) {
        if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " "
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return chars.join("")
}

function kindOf(ts: any, fileName: string): unknown {
  return /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/**
 * 一个文件的全部 `v8 ignore` 指令（IO 边界内唯一的解析动作）。
 *
 * 三步：① 抹字面量 ② scanner 取注释 token ③ 逐条 `parseDirective`。
 * 文件读不了 / 解析不了时**不静默跳过**：返回 `error` 让调用方判红 ——
 * 跳过等于「这个文件的裸 ignore 永远不被告发」，正是本判据要防的形态。
 */
export function directivesIn(ts: any, file: string, text: string): { directives: Directive[]; error?: string } {
  let blanked: string
  try {
    blanked = blankLiterals(ts, text, file)
  } catch (e) {
    return { directives: [], error: `解析不了（${(e as Error).message}）⇒ 这个文件的 v8 ignore 没判成` }
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kindOf(ts, file))
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, blanked)
  const out: Directive[] = []
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k !== ts.SyntaxKind.SingleLineCommentTrivia && k !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    const pos = scanner.getTokenPos()
    const raw = text.slice(pos, pos + scanner.getTokenText().length)
    if (!/v8\s+ignore/.test(raw)) continue
    const line = sf.getLineAndCharacterOfPosition(pos).line + 1
    const d = parseDirective(file, line, raw)
    if (d) out.push(d)
  }
  return { directives: out }
}

/** IO：读语料 + 逐文件解析。读不到的类型文件记红，不吞。 */
export function scanCorpus(root: string = REPO): { corpus: Corpus; errors: V8Finding[]; reason?: string } {
  const files = collectFiles(root)
  if (files.length === 0) return { corpus: { files, directives: [] }, errors: [] }
  const ts = loadTs(root)
  if (!ts) return { corpus: { files, directives: [] }, errors: [], reason: "no-binary" }
  const directives: Directive[] = []
  const errors: V8Finding[] = []
  for (const rel of files) {
    let text: string
    try {
      text = fs.readFileSync(path.join(root, rel), "utf8")
    } catch (e) {
      errors.push({ file: rel, line: 1, comment: "", detail: `读不了（${(e as Error).message}）⇒ 这个文件没判成` })
      continue
    }
    if (!/v8\s+ignore/.test(text)) continue
    const r = directivesIn(ts, rel, text)
    if (r.error) errors.push({ file: rel, line: 1, comment: "", detail: r.error })
    directives.push(...r.directives)
  }
  return { corpus: { files, directives }, errors }
}

/** 装配一次完整判定（main 与 spec 共用，避免「自检的和门禁跑的不是同一条路」）。 */
export function evaluate(root: string = REPO): GateResult {
  const hasCorpus = corpusExists(root)
  const { corpus, errors, reason } = scanCorpus(root)
  if (reason === "no-binary") {
    return unjudged(GATE, "no-binary", `找不到 typescript（候选：${TS_CANDS.join(" / ")} / typescript）⇒ 取不到注释，判不了`)
  }
  if (corpus.files.length === 0) {
    const why = hasCorpus
      ? `${CORPUS_ROOT}/<group>/<pkg>/src 下 0 个 .ts/.tsx（目录在，是空的）`
      : `${CORPUS_ROOT}/ 目录不存在（新树 W1 之前就是这个状态）`
    return unjudged(GATE, "no-corpus", `${why} ⇒ 没有可判的对象，不判绿`)
  }
  const judged = judgeDirectives(corpus.directives, corpus.files.length)
  if (errors.length === 0) return judged
  // 读不了/解析不了的文件与「裸 ignore」是同一档：都让这个文件没被判成。
  const merged = judged.status === "failed" ? judged.findings ?? [] : []
  return {
    gate: GATE,
    status: "failed",
    findings: [...merged, ...errors.map((e) => ({ file: e.file, line: e.line, detail: e.detail }))],
    detail: `${corpus.files.length} 个源文件 · 其中 ${errors.length} 个没判成 + ${(judged.findings ?? []).length} 条裸/敷衍 ignore`,
  }
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-plugin-shape.ts 的注释）。
  runGate({ name: GATE, main: () => evaluate() })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
