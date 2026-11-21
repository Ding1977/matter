/**
 * 新树分层契约判据（ISS-843 · W0-GATE-G7）—— L0–L4 双轴里**逻辑轴**的唯一机器执行者。
 *
 * 为什么必须新开一格、不扩 `scripts/lint-layer.mjs`：
 *   旧格的包身份来自 `knownPackages()`，它**只读仓库根目录一层**
 *   （`lint-layer.mjs:111-116`：`fs.readdirSync(root)` + `root/<name>/package.json`），
 *   且 `LAYER-PHANTOM` 要求层表键在**根目录**下同名存在（`:255-266`）。
 *   ⇒ 新树的 `packages/<group>/<pkg>/` 既进不了认列表、登记键也必然判幽灵。
 *   改它的扫描面对旧树 1313 个文件同时生效（认列变化 ⇒ 边集合变化），风险面远大于新开一格。
 *   层表也随之分家：旧表 `scripts/baseline/layer-contract.json` 管根一层 `forge-*`，
 *   新表 `scripts/baseline/layer-contract-next.json` 管 `packages/* / *`，两表格式相同、射程不重叠。
 *
 * 判据（三条，判定单位 = 一条真实 import 语句；层号越大越靠上）：
 *   LAYER-REVERSE  ⛔ 低层 import 高层（src < dst）⇒ 红。层号可以 type-only 也不行 ——
 *                      「能以类型依赖」就已经是编译期耦合，单向就是单向。
 *   LAYER-INJECT   ⛔ L4 场景插件向下（dst < L4）**取到值** ⇒ 红。下行不是不许，
 *                      **取值**才不许：L4 拿 L1–L3 的能力一律经注入服务 / slot；
 *                      `import type` 合法（DSH `packages/client/AGENTS.md:40` 的同一口径）。
 *                      例外：`subpathLayers` 登记的共享原语子路径（纯静态叶子，如 UI 组件）
 *                      可取值 —— 与旧格 P1 同理，且该登记必须在该包 exports 里真实存在
 *                      （`LAYER-SUBPATH` 守着，不许凭空贴层号洗白）。
 *   LAYER-SAME     ⛔ 跨功能插件 import 值（两个 L4 包之间取非 type-only）⇒ 红。
 *                      照抄 DSH `packages/client/AGENTS.md:40`：功能插件不得运行时 import
 *                      另一个功能插件的值；共享走注入服务，UI 走 slot。
 *                      ⚠️ 规则 id 是 `LAYER-SAME`（同层横向）而不是另起一个词，为的是与旧表
 *                      `waivers` 的桶名**同词** —— 桶键与规则 id 一旦不同词，豁免写进去
 *                      永远匹配不到命中 = 静默失效的豁免口（写本单时真踩过）。
 *                      非法桶名由 `LAYER-WAIVER` 当场判红。
 *
 * 覆盖完整性（不许静默当绿）：
 *   LAYER-UNJUDGED ⛔ `packages/* / *` 下有包但层表没登记 ⇒ 红（端点不在层表的边不单独报，
 *                    由这条按包报一次 —— 否则一个漏登记包会产出几十条同源噪音）。
 *   LAYER-PHANTOM  ⛔ 层表登记了、`packages/` 下却没有这个包 ⇒ 红（层表不许当化石）。
 *   LAYER-SUBPATH  ⛔ `subpathLayers` 登记的键必须在目标包 `exports` 里真实存在 ⇒ 否则红
 *                    （防「随便给子路径贴个 L1 就把反向依赖洗白」，旧格 P1 同口径）。
 *   LAYER-PACKAGE  ⛔ 包自身形状坏（缺 name / manifest 解析失败 / 两包同名）⇒ 红。
 *                    缺 name 的包被 import 时**解析不出边** ⇒ 静默漏判，比判红坏。
 *   LAYER-WAIVER   ⛔ `waivers` 的桶名不是已知规则 id ⇒ 红（那一桶豁免永远不生效）。
 *   0 个包 ⇒ unjudged（退出码 2）**不是绿**：「0 条违规」与「0 个包」不是一件事。
 *   找不到 typescript / 读不到层表 ⇒ 同样 unjudged，绝不冒充绿。
 *
 * 扫描根（ISS-843 第二段）：只扫 `packages/<group>/<pkg>/src/**`，**不含 `tests/**`**。
 *   与 DSH `scripts/verify-client-domain-graph.ts:85` 同口径：只扫 `src/`，测试目录不在射程。
 *   官方那格的写法是 `join(CLIENT_DIR, pkg, 'src/client')` + `statSync` 不是目录就 `continue` ——
 *   它全文件没有一行 `tests` / `.spec` 排除逻辑，因为扫描根天然避开了测试目录。
 *   ⇒ 我们照同一划法，**不给测试开豁免口**：测试从别包取值构造被测对象是**正当用法**，
 *     不是违反；写进 `waivers` 等于把正当用法记成「待还的债」，新树会攒出 20+ 条永久豁免。
 *
 * ⛔ 本判据**不判**什么（射程外，别把这行读成「已覆盖」）：
 *   · **`src/` 之外的一切**：`tests/**`（正当取值构造被测对象）、包根脚本、`lib/` 产物。
 *   · L1/L2/L3 内部的**同层横向**依赖（如 L3 的 `product/issue` 直接 import `product/doc`）。
 *     旧格 `lint-layer.mjs` 的 `LAYER-SAME` 管这一面；本判据的 `LAYER-SAME` 只含「跨功能插件」
 *     （L4↔L4）。要收 L3 内部这一面，先得有「L3 内部合法通道」的设计结论
 *     （走 `product/query` / `product/api` 还是允许直接互引），那是架构裁决、不是本单能拍的
 *     ⇒ 此处显式留白，不假装判过。
 *   · `package.json` 的 `dependencies` / `peerDependencies` 声明与源码 import 是否一致
 *     （那是 workspace 约束与依赖清单类判据的射程）。
 *   · 运行期动态解析（`ctx.inject` 之类名字串）—— 静态扫不到，属注入服务的域。
 *
 * 包身份怎么认（不硬编码 scope）：包名一律从各包 `package.json` 的 `name` 现读，
 *   层表键 = `packages/` 下的**两段相对路径** `<group>/<pkg>`。所以 `@matter/*` / `@scope/*` /
 *   裸名都能判，改 scope 不需要改本判据（写死 scope 是把一次约定当成永久的机器契约）。
 *
 * 与旧格的复用关系（诚实交代）：旧格的 `scanEdges()` **没有 export**（`scripts/lint-layer.mjs`
 *   全文 0 个 export），而且它的包身份取自路径首段（`rel(abs).split('/')[0]`），与新树的两段键
 *   不同型 ⇒ 既 import 不了、也不该照搬。这里按同一套 AST 思路重写：`ts.createSourceFile` +
 *   Import/Export/ImportType/CallExpression 遍历，注释 / 模板串 / 正则字面量里的 `import` 天然不算。
 *
 * 用法：
 *   node scripts/gates/lint-layer-new.ts --check                  # 门禁主入口（0 绿 / 1 红 / 2 判不了）
 *   node scripts/gates/lint-layer-new.ts --check --root <目录>     # 在临时副本上判（变异验证用）
 *   node scripts/gates/lint-layer-new.ts --selftest                # 正反例（走同名 .spec.ts）
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "lint-layer-new"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const CONTRACT_REL = "scripts/baseline/layer-contract-next.json"
const PACKAGES_REL = "packages"

/**
 * 层号常量（唯一出处，散在代码里迟早漂移）。
 * L0 基座留号不用：新树目前没有 L0 包，但「L0 ≤ 一切」这条口径要有位置。
 */
export const LAYER = { BASE: 0, PRIMITIVE: 1, CAPABILITY: 2, PRODUCT: 3, SCENARIO: 4 } as const
/** 功能插件所在层：只有这一层受「跨功能插件禁 import 值」与「向下只许取值禁」两条约束。 */
export const FEATURE_LAYER: number = LAYER.SCENARIO

const SRC_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/
/**
 * 扫描根目录名 = `src`。与 DSH `verify-client-domain-graph.ts:85` 同口径：只扫 `src/`。
 * 包里的 `tests/`、包根脚本、`lib/` 产物都在射程外（`lib` 另有 SKIP_DIR 兜一层）。
 */
const SRC_DIR = "src"
/** `lib` 也跳过：新树产物是 `lib/`（规划 §5.2），产物里的 import 不是源码依赖。 */
const SKIP_DIR = /^(node_modules|dist|lib|build|out|coverage|__pycache__|\.git|static|preview|vendor)$/
const TS_CANDS = [
  "forge-ui/node_modules/typescript/lib/typescript.js",
  "forge-pm/node_modules/typescript/lib/typescript.js",
  "node_modules/typescript/lib/typescript.js",
]

/* ───────────────────────────── 扫描（IO） ───────────────────────────── */

export interface PkgRef {
  /** 层表键：`packages/` 下的两段相对路径 `<group>/<pkg>` */
  key: string
  /** 仓库相对目录 `packages/<group>/<pkg>` */
  dir: string
  /** `package.json` 的 name；缺则 null（没法被 specifier 引用 ⇒ 边会静默消失） */
  name: string | null
}

export interface LayerEdge {
  /** 源包键 */
  src: string
  /** 目标包键 */
  dst: string
  /** 完整 import specifier（子路径层号靠它命中） */
  spec: string
  /** 仓库相对文件 */
  file: string
  line: number
  /** 只带类型（`import type` / 全是 `type` 具名 / `import(...)` 类型位置）；副作用 import 算值。 */
  typeOnly: boolean
}

function dirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIR.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 发现 `packages/<group>/<pkg>/package.json`。组目录是纯容器（无 package.json）⇒ 自然不入选。 */
export function discoverPackages(root: string): {
  packages: PkgRef[]
  dirExists: boolean
  problems: string[]
} {
  const base = path.join(root, PACKAGES_REL)
  if (!fs.existsSync(base)) return { packages: [], dirExists: false, problems: [] }
  const packages: PkgRef[] = []
  const problems: string[] = []
  for (const g of dirs(base)) {
    for (const p of dirs(path.join(base, g))) {
      const relDir = `${PACKAGES_REL}/${g}/${p}`
      const manifest = path.join(root, relDir, "package.json")
      if (!fs.existsSync(manifest)) continue
      let name: string | null = null
      try {
        const j = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown }
        name = typeof j.name === "string" && j.name.trim() ? j.name.trim() : null
      } catch (e) {
        problems.push(`${relDir}/package.json 解析失败：${(e as Error).message}`)
      }
      if (!name) problems.push(`${relDir}/package.json 缺 name ⇒ 别的包 import 它时解析不出边（静默漏判，比判红坏）`)
      packages.push({ key: `${g}/${p}`, dir: relDir, name })
    }
  }
  packages.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { packages, dirExists: true, problems }
}

/** 包名 → 包键。重名 = 边无法定位 ⇒ 单独判红（两个包都叫同一个名字时，任何判据都只能猜）。 */
export function nameIndex(packages: PkgRef[]): { map: Map<string, string>; dups: string[] } {
  const map = new Map<string, string>()
  const dups: string[] = []
  for (const p of packages) {
    if (!p.name) continue
    const prev = map.get(p.name)
    if (prev) dups.push(`${p.name}：${prev} 与 ${p.key} 同名 ⇒ import 它的边归属不明`)
    else map.set(p.name, p.key)
  }
  return { map, dups }
}

/** 解析器是**工具**、不是被扫描的对象：先看副本里有没有，再回退到本脚本所在仓，都不静默降级。 */
function loadTs(root: string): unknown | null {
  for (const base of [root, REPO]) {
    const req = createRequire(path.join(base, "package.json"))
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

/**
 * 扫描根 = `packages/<g>/<p>/src/**`，**不含 `tests/**`**。
 *
 * 与 DSH `scripts/verify-client-domain-graph.ts:85` 同口径：只扫 `src/`，测试目录不在射程。
 * 官方那格的写法是 `join(CLIENT_DIR, pkg, 'src/client')` + `statSync` 不是目录就 `continue` ——
 * 它全文件没有一行 `tests` / `.spec` 排除逻辑，因为**扫描根天然避开了测试目录**。
 * 我们照这个划法：不给测试开豁免口（豁免名单是「待还的债」，而测试取别包的值构造被测对象
 * 是**正当用法**，写进豁免等于把正当用法记成欠账，新树会攒出 20+ 条永久豁免）。
 *
 * ⚠️ 代价（如实记下）：本判据因此**判不到** `src/` 之外任何文件的依赖方向，
 *    包括 `tests/`、包根的脚本、以及将来的 `src/client` 之外的分支。这是有意的射程收缩，
 *    不是遗漏 —— 见文件头「射程外」一节。
 */
function walkFiles(root: string, relDir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIR.test(e.name) && !e.name.startsWith(".")) walk(path.join(rel, e.name))
      } else if (SRC_RE.test(e.name)) out.push(path.join(rel, e.name).split(path.sep).join("/"))
    }
  }
  walk(path.join(relDir, SRC_DIR))
  return out.sort()
}

/**
 * AST 扫 import 边。覆盖：具名 / 多行 / 副作用 import、`export ... from`、`import("x")`、
 * `require("x")`、`import type`。注释与字符串里的同名文本天然不算（AST 不认字面量内容）。
 * 边只认**跨包**：同包内相对 import 与包内自引用一律不产出。
 */
export function scanEdges(opts: { root: string; packages: PkgRef[]; ts: unknown }): LayerEdge[] {
  const ts = opts.ts as any
  const { map: byName } = nameIndex(opts.packages)
  const keySet = new Set(opts.packages.map((p) => p.key))
  const base = path.join(opts.root, PACKAGES_REL)
  const edges: LayerEdge[] = []

  /** 绝对路径 → 包键（只看前两段；组容器下的散文件返回 null）。 */
  const keyOfAbs = (abs: string): string | null => {
    const rel = path.relative(base, abs).split(path.sep)
    if (rel.length < 3) return null
    const key = `${rel[0]}/${rel[1]}`
    return keySet.has(key) ? key : null
  }

  /** specifier → [包键, 完整 spec]。相对路径按「落在哪个包」归；包名按现读的 name 归。 */
  const resolve = (spec: string, fromAbs: string, srcKey: string): string | null => {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const target = keyOfAbs(path.resolve(path.dirname(fromAbs), spec))
      return target && target !== srcKey ? target : null
    }
    const parts = spec.split("/")
    const head = parts[0].startsWith("@") ? 2 : 1
    if (parts.length < head) return null
    const key = byName.get(parts.slice(0, head).join("/"))
    return key && key !== srcKey ? key : null
  }

  for (const pkg of opts.packages) {
    for (const relFile of walkFiles(opts.root, pkg.dir)) {
      const abs = path.join(opts.root, relFile)
      let source = ""
      try {
        source = fs.readFileSync(abs, "utf8")
      } catch {
        continue
      }
      const kind = relFile.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : /\.(ts|mts|cts)$/.test(relFile)
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS
      const sf = ts.createSourceFile(relFile, source, ts.ScriptTarget.Latest, true, kind)

      const push = (spec: string, node: any, typeOnly: boolean) => {
        const dst = resolve(spec, abs, pkg.key)
        if (!dst) return
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        edges.push({ src: pkg.key, dst, spec, file: relFile, line, typeOnly })
      }

      const walk = (n: any) => {
        if (ts.isImportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
          push(n.moduleSpecifier.text, n, declIsTypeOnly(ts, n))
        } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
          push(n.moduleSpecifier.text, n, exportIsTypeOnly(ts, n))
        } else if (
          ts.isImportTypeNode(n) &&
          n.argument &&
          ts.isLiteralTypeNode(n.argument) &&
          ts.isStringLiteral(n.argument.literal)
        ) {
          push(n.argument.literal.text, n, true)
        } else if (ts.isCallExpression(n) && n.arguments.length && ts.isStringLiteral(n.arguments[0])) {
          const callee = n.expression
          if (
            (ts.isIdentifier(callee) && callee.text === "require") ||
            callee.kind === ts.SyntaxKind.ImportKeyword
          ) {
            push((n.arguments[0] as any).text, n, false)
          }
        }
        ts.forEachChild(n, walk)
      }
      walk(sf)
    }
  }
  return edges
}

/** `import` 声明是否只带类型：`import type`、或全部具名 specifier 都加了 `type`。
 *  默认 / 命名空间 / 副作用 import 一律算**值**（副作用 import 会执行目标模块）。 */
function declIsTypeOnly(ts: any, n: any): boolean {
  const clause = n.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  const nb = clause.namedBindings
  if (nb && ts.isNamedImports(nb) && nb.elements.length > 0) return nb.elements.every((e: any) => e.isTypeOnly)
  return false
}

function exportIsTypeOnly(ts: any, n: any): boolean {
  if (n.isTypeOnly) return true
  const specs = n.exportClause
  if (specs && ts.isNamedExports(specs) && specs.elements.length > 0) return specs.elements.every((e: any) => e.isTypeOnly)
  return false
}

/* ───────────────────────────── 判定（纯函数） ───────────────────────────── */

export interface WaiverEntry {
  /** 仓库相对文件（必填：豁免必须指到一处命中） */
  file: string
  /** 可选：对命中 detail 的子串匹配 ⇒ 把豁免收到**边级**（不带 = 文件级，旧行为） */
  match?: string
  /** 为什么可以欠着（空 = 判红：豁免不许当免死金牌） */
  reason: string
}

export interface LayerContract {
  layers?: Record<string, number>
  subpathLayers?: Record<string, number>
  waivers?: Record<string, WaiverEntry[]>
}

export interface JudgeInput {
  contract: LayerContract | null
  contractError?: string
  packages: PkgRef[]
  packagesDirExists: boolean
  /** 包自身的形状问题（缺 name / manifest 坏 / 重名） */
  packageProblems: string[]
  edges: LayerEdge[]
  astAvailable: boolean
  /** 子路径登记校验：该 specifier 是否真在目标包 exports 里 */
  subpathExists: (spec: string) => boolean
}

interface Hit {
  rule: string
  file?: string
  line?: number
  detail: string
}

/**
 * 可豁免的规则 id —— **也必须是 `waivers` 的合法桶键**。
 *
 * 为什么把「桶键必须在这里」做成一等判据：桶键与规则 id 一旦不同词，写进契约的豁免
 * 匹配不到任何命中 ⇒ **豁免静默失效**（表现是门禁永远红，或你以为免了其实没免）。
 * 写本单时踩过一次：判据 3 原本发 `LAYER-CROSS`，而格式里 `waivers` 的桶叫 `LAYER-SAME`
 * ⇒ 那一桶写什么都不生效。现在两边同名，且非法桶名当场判红。
 *
 * 起手的 `layer-contract-next.json` 只带格式里的两桶（REVERSE / SAME）；
 * `LAYER-INJECT` 桶在真出现第一条需要豁免的 L4 取值下行时再加（空桶不预置，免得看起来像已有欠账）。
 */
export const WAIVABLE_RULES = ["LAYER-REVERSE", "LAYER-SAME", "LAYER-INJECT"] as const
/** 覆盖完整性类规则：它们不豁免（「表错了」不是「边欠着」），出现在 waivers 桶里就是配置错。 */
export const NON_WAIVABLE_RULES = ["LAYER-UNJUDGED", "LAYER-PHANTOM", "LAYER-SUBPATH", "LAYER-PACKAGE"] as const

export function judgeLayerNew(input: JudgeInput): GateResult {
  if (!input.astAvailable) {
    return unjudged(GATE, "no-binary", `找不到 typescript（候选：${TS_CANDS.join(" / ")} / typescript）⇒ 扫不出 import 边，判不了`)
  }
  if (!input.contract) {
    return unjudged(GATE, "no-baseline", `层表不存在或不可解析：${CONTRACT_REL}${input.contractError ? `（${input.contractError}）` : ""}`)
  }
  if (!input.packagesDirExists) {
    return unjudged(GATE, "no-corpus", `${PACKAGES_REL}/ 不存在 ⇒ 新树还没有落盘，判不了（不是绿）`)
  }
  if (input.packages.length === 0) {
    return unjudged(
      GATE,
      "no-corpus",
      `${PACKAGES_REL}/*/* 下 0 个包（层表登记 ${Object.keys(input.contract.layers ?? {}).length} 条）⇒ 判不了，不是绿`,
    )
  }

  const layers = input.contract.layers ?? {}
  const subpathLayers = input.contract.subpathLayers ?? {}
  const hits: Hit[] = []
  const registered = new Set(Object.keys(layers))

  // ── 层表自身的形状（不参与豁免：这些是「表错了」，不是「边欠着」）──
  for (const key of [...registered].sort()) {
    if (!input.packages.some((p) => p.key === key)) {
      hits.push({
        rule: "LAYER-PHANTOM",
        file: CONTRACT_REL,
        detail: `层表登记的包在 ${PACKAGES_REL}/ 下不存在：${key}（L${layers[key]}）—— 层表不许当化石`,
      })
    }
  }
  for (const p of input.packages) {
    if (!registered.has(p.key)) {
      hits.push({
        rule: "LAYER-UNJUDGED",
        file: `${p.dir}/package.json`,
        detail: `包未登记层号：${p.key}（${p.name ?? "缺 name"}）⇒ 它的进出边全部判不了`,
      })
    }
  }
  for (const spec of Object.keys(subpathLayers)) {
    if (!input.subpathExists(spec)) {
      hits.push({
        rule: "LAYER-SUBPATH",
        file: CONTRACT_REL,
        detail: `登记的子路径在目标包 package.json 的 exports 里不存在：${spec}（不许凭空贴层号洗白）`,
      })
    }
  }
  for (const d of input.packageProblems) hits.push({ rule: "LAYER-PACKAGE", detail: d })

  // ── 三条依赖方向判据 ──
  const isSubPathHit = (e: LayerEdge) => Object.prototype.hasOwnProperty.call(subpathLayers, e.spec)
  for (const e of input.edges) {
    const s = layers[e.src]
    const d = isSubPathHit(e) ? subpathLayers[e.spec] : layers[e.dst]
    // 端点没登记：由 LAYER-UNJUDGED 按包报过一次，这里不重复产出同源噪音。
    if (s == null || d == null) continue
    const how = e.typeOnly ? "（import type）" : ""
    const sub = isSubPathHit(e) ? `（子路径登记 L${d}：${e.spec}）` : ""
    if (s < d) {
      hits.push({
        rule: "LAYER-REVERSE",
        file: e.file,
        line: e.line,
        detail: `反向依赖 L${s}→L${d}${how}${sub}：${e.src} → ${e.spec}`,
      })
    } else if (s === d && s === FEATURE_LAYER && !e.typeOnly) {
      // 规则 id 用 LAYER-SAME（同层横向）—— 与旧表 waivers 桶同名，桶键与规则 id 必须同词。
      hits.push({
        rule: "LAYER-SAME",
        file: e.file,
        line: e.line,
        detail: `跨功能插件取到值 L${s}→L${d}：${e.src} → ${e.spec}（共享走注入服务，UI 走 slot；只许 import type）`,
      })
    } else if (s === FEATURE_LAYER && d < FEATURE_LAYER && !e.typeOnly && !isSubPathHit(e)) {
      hits.push({
        rule: "LAYER-INJECT",
        file: e.file,
        line: e.line,
        detail: `场景插件直接取值 L${s}→L${d}：${e.src} → ${e.spec}（下行只许 import type，值走注入服务）`,
      })
    }
  }

  // ── 豁免：命中剔除 + 双向失效检测（理由空 ⇒ 红；没命中的条目 ⇒ 化石 ⇒ 红）──
  const waivers = input.contract.waivers ?? {}
  // 桶键守卫（放在最前）：非法桶名意味着那一桶的豁免**永远匹配不到命中**。
  // 不判这一条的话，写法错一个词的表现是「门禁照红，而你以为已经免了」——
  // 静默失效的豁免口比没有豁免口更坏：它让人以为问题已经被处置。
  for (const rule of Object.keys(waivers)) {
    if ((WAIVABLE_RULES as readonly string[]).includes(rule)) continue
    const why = (NON_WAIVABLE_RULES as readonly string[]).includes(rule)
      ? "它判的是「层表/包形状错了」，不是「边欠着」⇒ 不许豁免"
      : `不是本判据的规则 id（合法桶：${WAIVABLE_RULES.join(" / ")}）⇒ 写进去的豁免永远不会生效`
    hits.push({ rule: "LAYER-WAIVER", file: CONTRACT_REL, detail: `waivers 里有非法桶 ${rule}：${why}` })
  }
  const kept: Hit[] = []
  for (const h of hits) {
    const list = waivers[h.rule] ?? []
    const hitEntry = list.find(
      (w) => w.file === h.file && (!w.match || String(h.detail).includes(w.match)),
    )
    if (!hitEntry) {
      kept.push(h)
      continue
    }
    if (!String(hitEntry.reason ?? "").trim()) {
      kept.push({ ...h, detail: `${h.detail}（豁免缺 reason：不许当免死金牌）` })
    }
  }
  for (const [rule, list] of Object.entries(waivers)) {
    // 非法桶已经在上面判过一条，这里不重复产出「化石」噪音（同一个根因只报一次）。
    if (!(WAIVABLE_RULES as readonly string[]).includes(rule)) continue
    for (const w of list ?? []) {
      const used = hits.some(
        (h) => h.rule === rule && h.file === w.file && (!w.match || String(h.detail).includes(w.match)),
      )
      if (!used) {
        kept.push({
          rule,
          file: w.file,
          detail: `${CONTRACT_REL} 的豁免是化石：${rule} 在 ${w.file} 已不命中 ⇒ 摘掉（豁免不许留存）`,
        })
      }
    }
  }

  if (kept.length) {
    return {
      gate: GATE,
      status: "failed",
      findings: kept.map((h) => ({ file: h.file, line: h.line, detail: `[${h.rule}] ${h.detail}` })),
    }
  }
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${input.packages.length} 个包 / ${input.edges.length} 条跨包边 / 层表 ${registered.size} 条 ⇒ 三条判据全过`,
  }
}

/* ───────────────────────────── 子路径登记校验（IO） ───────────────────────────── */

/** `@scope/x/sub` 是否真在目标包 exports 里（支持 `./sub/*` 通配）。同旧格口径。 */
export function makeSubpathChecker(root: string, packages: PkgRef[]): (spec: string) => boolean {
  const { map } = nameIndex(packages)
  return (spec: string): boolean => {
    const parts = spec.split("/")
    const head = parts[0].startsWith("@") ? 2 : 1
    if (parts.length <= head) return false
    const key = map.get(parts.slice(0, head).join("/"))
    if (!key) return false
    const pkg = packages.find((p) => p.key === key)
    if (!pkg) return false
    const sub = "./" + parts.slice(head).join("/")
    let exportsField: unknown
    try {
      exportsField = (JSON.parse(fs.readFileSync(path.join(root, pkg.dir, "package.json"), "utf8")) as { exports?: unknown })
        .exports
    } catch {
      return false
    }
    if (!exportsField || typeof exportsField !== "object") return false
    for (const k of Object.keys(exportsField as Record<string, unknown>)) {
      if (k === sub) return true
      if (k.includes("*")) {
        const re = "^" + k.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "$"
        if (new RegExp(re).test(sub)) return true
      }
    }
    return false
  }
}

/* ───────────────────────────── main ───────────────────────────── */

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export function readContract(root: string): { contract: LayerContract | null; error?: string } {
  const p = path.join(root, CONTRACT_REL)
  if (!fs.existsSync(p)) return { contract: null, error: "文件不存在" }
  try {
    return { contract: JSON.parse(fs.readFileSync(p, "utf8")) as LayerContract }
  } catch (e) {
    return { contract: null, error: (e as Error).message }
  }
}

/** 装配一次完整判定（main 与 spec 共用，避免「自检测的和门禁跑的不是同一条路」）。 */
export function evaluate(root: string): GateResult {
  const { contract, error } = readContract(root)
  const { packages, dirExists, problems } = discoverPackages(root)
  const ts = loadTs(root)
  const edges = ts ? scanEdges({ root, packages, ts }) : []
  return judgeLayerNew({
    contract,
    contractError: error,
    packages,
    packagesDirExists: dirExists,
    packageProblems: [...problems, ...nameIndex(packages).dups],
    edges,
    astAvailable: !!ts,
    subpathExists: makeSubpathChecker(root, packages),
  })
}

if (isMain(import.meta.url)) {
  runGate({
    name: GATE,
    main: () => {
      const rootArg = argOf("--root")
      return evaluate(rootArg ? path.resolve(rootArg) : REPO)
    },
  })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
