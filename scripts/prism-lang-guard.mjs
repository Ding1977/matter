#!/usr/bin/env node
// Prism 语言集守卫（ISS-603 · 第三轮独立审查"必修 1"落地）——
// **期望集由语料现算，不由实现文件自述**。
//
// ## 为什么需要它（三轮审查的教训，别再退回手写数组）
//
// ISS-603 给代码块补 Prism 语言包时，期望集先后写过两次，都被独立审查打回：
//   ① 写进 `prism-languages.ts` 的 `PRISM_REGISTERED_LANGUAGES` —— 与 import **同文件**，
//      「清单+import 一起删」时内部仍自洽 ⇒ 全绿而功能真回退；
//   ② 挪进测试文件 `EXPECTED_REQUIRED` —— **只挡住了顺手删一处**，同一次提交改两处
//      （清单+冻结集）照样全绿；把冻结集改成 `require("./prism-languages")…` 更是一行回退到自指。
// 根因：**「独立」不是换个文件住，而是有一个不由被审文件决定的真相源**。
// 本脚本就是那个真相源 —— 它**读语料**（`~/.dsh-matter/pm` 的 md 围栏语言分布），
// 减去「`@lexical/code-prism` 自带集」，得出「必须由我们补的语言」，再与实现对账。
// 改实现改不动它（除非改语料，即真的不用那种语言了）。
//
// ## 判据（一条必红条件）
//
// `语料里在用、且 code-prism 不自带、且 Prism 无对应语言包` 的语言集合
//   ⊆ 实现（`prism-languages.ts` 的 import + 清单）
// 否则红，列出缺口。
//
// ## 两条硬纪律（照抄 `md-corpus-guard.mjs` 的成熟范式）
//
// · `--selftest`：造**临时夹具目录**（绝不读真语料），双向验证（该红的红、干净的不红）。
//   "从没红过的守卫等于没有守卫"（K8b）。
// · **不判**：`--root` 不存在（CI 空 HOME）⇒ 打印「不判（语料不存在）」`exit 0`，
//   不报红也不报绿（口径同 「读不到即不判」的既有口径（见 md-corpus-guard） / `md-corpus-guard.mjs`）。
//
// 用法：node scripts/prism-lang-guard.mjs [--check] [--root <dir>] [--verbose] [--selftest]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url))
const REPO = dirname(SCRIPT_DIR)
const IMPL_PATH = join(REPO, "forge-pm", "src", "pm", "lexical", "prism-languages.ts")

/** `@lexical/code-prism@0.49` **自带**的语言（实测其 dist:13-27 的 15 条 import
 *  + `:94` 内联的 `go`）。补这些是冗余 ⇒ 从期望集里减掉。
 *  ⚠️ 这份清单**有独立来源**（读 node_modules 的 dist 文件），不是抄自实现。
 *  ⚠️ 返回 `null` = **读不到依赖环境**（.bun 不在 —— pnpm 工单树 / CI 冷装），与「读到了、
 *  自带集为空」严格区分：前者期望集算不出（判不了），后者才是真空集。ISS-899 之前这里
 *  返回空 Set ⇒ builtin 减不掉，与 hasPrismComponent 恒 false 叠加 ⇒ 期望集恒空 ⇒ 假绿。 */
function codePrismBuiltinLanguages(base) {
  const glob = base ?? join(REPO, "node_modules", ".bun")
  if (!existsSync(glob)) return null
  const found = new Set()
  let dirs = []
  try {
    dirs = readdirSync(glob).filter((d) => d.startsWith("@lexical+code-prism@"))
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = join(glob, d, "node_modules", "@lexical", "code-prism", "dist", "LexicalCodePrism.dev.mjs")
    if (!existsSync(p)) continue
    const src = readFileSync(p, "utf8")
    for (const m of src.matchAll(/import\s+'prismjs\/components\/prism-([a-z0-9-]+)\.js'/g)) found.add(m[1])
    // 内联注册（如 `Prism.languages.go = …`）
    for (const m of src.matchAll(/Prism\.languages\.([a-z0-9-]+)\s*=/g)) found.add(m[1])
  }
  return found
}

/** Prism **没有**对应语言包的语言（无包可补 ⇒ 不列入期望集，属已知边界）。 */
const NO_PRISM_PACKAGE = new Set(["jsonc"])

/** `mermaid` 不走代码高亮链路（由 MermaidNode + 覆盖层渲染 SVG，ISS-598）。 */
const NOT_HIGHLIGHT_LINK = new Set(["mermaid"])

/** 语料里的**语言别名** → Prism 的规范名。
 *  ⚠️ 必需：语料写 `js`/`ts`/`yml`，而 Prism 的键是 `javascript`/`typescript`/`yaml`；
 *  不归一会把「早已自带的语言」误判成缺口（实测踩过：js 66 / ts 65 被误报为缺）。
 *  口径 = Prism 官方 `components.json` 的别名（此处只收本仓语料实际出现的）。 */
const ALIAS = new Map([
  ["js", "javascript"],
  ["jsx", "jsx"],
  ["ts", "typescript"],
  ["tsx", "tsx"],
  ["yml", "yaml"],
  ["py", "python"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["md", "markdown"],
  ["html", "markup"],
  ["htm", "markup"],
  ["xml", "markup"],
  ["svg", "markup"],
])

const canonical = (lang) => ALIAS.get(lang) ?? lang

/** 扫语料：返回 `{ lang: count }`；**扫不到任何围栏时返回 null**（= 不判，不是"需补 0 种"）。
 *  口径：`<root>/{issues,documents,projects}/*.md`，排除 `-activity.md` / `-comments.md` 侧车；
 *  只认行首 ```lang。
 *
 *  ⚠️⚠️ 「根在但零围栏」**必须返回 null**（独立审查第四轮 blocker-3）：本机 `~/.dsh/pm` 是
 *  真实存在的目录、但里 **0 个 md**（真语料在 `~/.dsh-matter/pm`）。若把它当"空语料"，
 *  `need` 为空 ⇒ 打印 **`✓ 需补 0 种，实现均覆盖`** 的**假绿** —— 而删掉实现里的 json
 *  （语料 26 处）也照样绿。这与本仓 `md-corpus-guard.mjs` 对同形状的处置相反（它判「不判」）。
 *  口径统一为：**读不到可信语料 ⇒ 不判（exit 0 + 明说），不报绿也不报红**。 */
function scanCorpus(root) {
  const counts = new Map()
  if (!existsSync(root)) return null
  let scannedFiles = 0
  for (const sub of ["issues", "documents", "projects"]) {
    const dir = join(root, sub)
    if (!existsSync(dir)) continue
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.endsWith(".md")) continue
      if (n.endsWith("-activity.md") || n.endsWith("-comments.md")) continue
      let text = ""
      try {
        text = readFileSync(join(dir, n), "utf8")
      } catch {
        continue
      }
      scannedFiles++
      for (const m of text.matchAll(/^\s*```([\w-]+)/gm)) {
        const lang = m[1].toLowerCase()
        counts.set(lang, (counts.get(lang) ?? 0) + 1)
      }
    }
  }
  // 一个 md 都没读到 ⇒ 语料不可用（路径错/空库）⇒ 判「不判」，防假绿
  if (scannedFiles === 0) return null
  return counts
}

/** 读实现：`prism-languages.ts` 里真出现的 import（**先剥注释**，注释掉的不算）。
 *  ⚠️ 只用于「实现提供面」，不参与定义期望集 —— 期望集只来自语料。 */
function implementedLanguages() {
  if (!existsSync(IMPL_PATH)) return null
  const src = readFileSync(IMPL_PATH, "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  return new Set([...code.matchAll(/import\s+["']prismjs\/components\/prism-([a-z0-9-]+)\.js["']/g)].map((m) => m[1]))
}

/** 期望集 = 语料在用 − code-prism 自带 − Prism 无包 − 不走高亮链路（先归一再比较）。
 *  返回：`"no-prism-deps"` = 依赖环境不可读（判不了）；`null` = 语料不可用（判不了）；
 *  `Map` = 期望集。`bunBase` 供 `--selftest` 注入夹具 store，缺省读真实 node_modules/.bun。 */
function expectedRequired(root, { bunBase } = {}) {
  // 顺序：语料早退在前、依赖早退在后 —— CI 空 HOME 时报「语料不可用」（ISS-832 原语义），
  //   语料在而 .bun 不在（pnpm 工单树）时才报「Prism 依赖不在本环境」（ISS-899 新增）。
  //   依赖早退放前面会把「语料不存在」用例的意图挡掉（同码 2 蒙混，理由文案错位）。
  const counts = scanCorpus(root)
  if (counts === null) return null
  const builtin = codePrismBuiltinLanguages(bunBase)
  const componentDirs = prismComponentDirs(bunBase)
  if (builtin === null || componentDirs === null) return "no-prism-deps"
  const need = new Map()
  for (const [raw, n] of counts) {
    const lang = canonical(raw)
    // 归一后再过滤：语料写 `js` 而 Prism 键是 `javascript`，不归一会误报缺口（实测踩过）
    if (builtin.has(lang)) continue
    if (NO_PRISM_PACKAGE.has(raw) || NO_PRISM_PACKAGE.has(lang)) continue
    if (NOT_HIGHLIGHT_LINK.has(raw) || NOT_HIGHLIGHT_LINK.has(lang)) continue
    // Prism 无该规范名的语言包也算边界（与"无包"同义）——由 hasPrismComponent 判
    if (!hasPrismComponent(lang, componentDirs)) continue
    need.set(lang, (need.get(lang) ?? 0) + n)
  }
  return need
}

/** prismjs 的 components 目录清单（store 里可能有多个实例，逐个探）。
 *  返回 `null` = **环境不可用**（.bun 不在 / 读不了 / 没有 prismjs 实例）—— 期望集因此算不出
 *  （判不了，不是「Prism 无包」）。ISS-899 之前这里探不到就 `return false`：每个语言都被当
 *  「Prism 无包」过滤掉 ⇒ 期望集恒空 ⇒ `--check` 恒「需补 0 种」**假绿**，selftest 夹具是唯一
 *  暴露它的格子（真红）。`base` 参数供 `--selftest` 注入夹具，缺省读真实 store。 */
function prismComponentDirs(base) {
  const glob = base ?? join(REPO, "node_modules", ".bun")
  if (!existsSync(glob)) return null
  let dirs = []
  try {
    dirs = readdirSync(glob).filter((d) => d.startsWith("prismjs@"))
  } catch {
    return null
  }
  if (dirs.length === 0) return null
  return dirs.map((d) => join(glob, d, "node_modules", "prismjs", "components"))
}

/** Prism 是否**有**该语言的语言包（决定"能不能补"）。
 *  ⚠️ 只看 components 目录里**文件在不在**（不 import —— 判据要快，且不把语言包的运行期
 *  副作用带进本进程）；`prism-${lang}.js` 由 prismjs 发布物保证与语言规范名同名。 */
function hasPrismComponent(lang, componentDirs) {
  for (const dir of componentDirs) {
    if (existsSync(join(dir, `prism-${lang}.js`))) return true
  }
  return false
}

/** 行为级顺序检查（独立审查第四轮 blocker-2）：**真加载一次** `prism-languages.ts`，
 *  看它在运行期是否抛错。
 *
 *  为什么必须单独有这一条：本文件上面的判据只查 import **存在性**（"语言在不在"），
 *  查不了 **import 顺序**。而 Prism 语言包之间有**运行期依赖**：
 *  `prism-tsx` 依赖 `prism-typescript` + `prism-jsx` ⇒ 顺序颠倒时**语言都"在"**
 *  （import 字面量一个不少、语料守卫照样绿），但加载即抛：
 *      `TypeError: Cannot convert undefined or null to object
 *         at delete Prism.languages.tsx["parameter"]`
 *  这条路径此前只由 `prism-languages.test.ts` 守 —— 而那个文件**可被整份删除**且
 *  `bun test` 仍全绿（第四轮实测 1124→1118 无任何发声）⇒ 存在"功能真回退、全门禁绿"的通道。
 *  现在把顺序约束落到**本守卫**（不依赖任何测试文件是否存在）。
 *
 *  做法：`bun build` 一个只 import 实现的探针 → **独立 node 子进程**执行 → 看退出码。
 *  （独立子进程是必需的：同进程内 Prism 是全局单例，会被调用方自己的 import 污染。）
 *  返回 `{ ok, skipped, detail }`。
 *
 *  ⚠️⚠️ **必须区分两种失败**（独立审查第五轮 M1）：
 *    · `built.error`（ENOENT = **bun 真不存在**）⇒ 跳过（`skipped: true`，不假红，明示）；
 *    · `built.status !== 0`（**构建失败**，bun 在但编译/解析出错）⇒ **判红**。
 *    早前把两者混在一个 catch-all 里跳过 ⇒ 可构造「顺序错 + 追加一个不可解析 import」
 *    让构建失败从而**全绿**（审查员实测：exit 0）。那正是 fail-open。
 *
 *  ⚠️ 探针路径必须**每进程唯一**（独立审查第五轮 M2）：早前用固定路径
 *    `forge-pm/.tmp-prism-order`，两进程并发时 A 的 `finally` 删目录 ⇒ B 的 `node probe.cjs`
 *    报 MODULE_NOT_FOUND ⇒ 被误判成"import 顺序违反"**假红**（审查员实测 40 次里 16 次假红）。
 *    ⇒ 用 `mkdtempSync` 拿唯一目录。 */
function checkLoadOrder() {
  // ⚠️ 探针必须落在**仓库内**（解析依赖的基准）：`import "prismjs"` 要能从探针所在目录
  //   向上找到 `node_modules`。放 `/tmp` 会解析失败 ⇒ 被误判成"bun 不可用"而静默跳过
  //   （实测踩过：顺序检查形同不存在）。
  let tmpDir = ""
  try {
    tmpDir = mkdtempSync(join(REPO, "forge-pm", ".tmp-prism-order-"))
  } catch (e) {
    return { ok: true, skipped: true, detail: `建临时目录失败：${String(e).slice(0, 160)}` }
  }
  const out = join(tmpDir, "probe.cjs")
  const entry = join(tmpDir, "probe-entry.ts")
  try {
    // ⚠️ 探针必须先 `import "prismjs"`（核心）：语言包是 `(function(Prism){…})(Prism)` 形态、
    //    直接读全局 `Prism`，核心被 import 时会把自己挂到 `globalThis.Prism`。
    //    不先加载核心 ⇒ 一律 `ReferenceError: Prism is not defined`（与真实 bundle 形态不符，
    //    会**恒红**——本探针第一版正是如此）。
    writeFileSync(entry, `import "prismjs"\nimport ${JSON.stringify(IMPL_PATH)}\n`, "utf8")
    const built = spawnSync("bun", ["build", entry, "--outfile", out, "--target", "node", "--format", "cjs"], {
      cwd: REPO,
      encoding: "utf8",
    })
    // bun 真不存在（ENOENT）⇒ 跳过；其余非零退出 = 构建真失败 ⇒ 判红（不许 fail-open）
    if (built.error && built.error.code === "ENOENT") {
      return { ok: true, skipped: true, detail: "bun 不在 PATH（跳过顺序检查）" }
    }
    if (built.error || built.status !== 0) {
      return {
        ok: false,
        skipped: false,
        detail: `探针构建失败（bun 在但编译/解析出错，非"bun 不可用"）：${String(built.stderr ?? built.error ?? "").split("\n").slice(0, 3).join(" / ").slice(0, 300)}`,
      }
    }
    const ran = spawnSync("node", [out], { encoding: "utf8" })
    if (ran.status !== 0) {
      return { ok: false, detail: String(ran.stderr ?? "").split("\n").slice(0, 4).join(" / ").slice(0, 400) }
    }
    return { ok: true, skipped: false, detail: "" }
  } catch (e) {
    return { ok: true, skipped: true, detail: String(e).slice(0, 200) }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

function check(root, { verbose = false } = {}) {
  // ── ① 顺序/可加载性检查（**与语料无关，故放在语料早退之前**）────────────────────
  // ⚠️ 独立审查第五轮建议：CI 里没有语料（`need === null` 会提前 return 0），
  //    若把本检查放在早退之后，**CI 里永不执行**。而"import 顺序错 ⇒ 加载即抛"
  //    是纯实现问题，与语料存在与否无关 ⇒ 必须先查。
  const order = checkLoadOrder()
  if (!order.ok) {
    console.error(`✗ prism-languages.ts 加载即抛错（import 顺序违反语言包依赖 / 探针构建失败）：`)
    console.error(`    ${order.detail}`)
    console.error(`  修法：按依赖拓扑排序（jsx 必须在 tsx 之前；见该文件头注释）`)
    return 2
  }

  // ── ② 语料 ↔ 实现对账 ──────────────────────────────────────────────────────
  const need = expectedRequired(root)
  if (need === "no-prism-deps") {
    // ISS-899：pnpm 工单树 / CI 冷装没有旧树 forge-pm 的 .bun store ⇒「Prism 有无该语言包」
    //   的过滤做不了 ⇒ 期望集给不出。原先 hasPrismComponent 探不到就当「无包」全过滤 ⇒ 恒
    //   「需补 0 种」假绿。改判「不判」（canonical 2，livecheck 双认 {2,3}）；主检出/生产的
    //   bun 环境照常真判。
    console.log(`不判（Prism 依赖不在本环境）：node_modules/.bun 无 prismjs/@lexical/code-prism —— 「Prism 有无该语言包」过滤做不了，期望集算不出，不报绿也不报红`)
    return 2
  }
  if (need === null) {
    console.log(`不判（语料不可用）：${root} —— 未读到任何 md（路径错或空库），不报绿也不报红`)
    // ISS-832：原先 `return 0` —— 嘴上说「不判」、码上却是绿，正是 K9 管的「自报不判当逃生门」。
    //   改成 canonical 的 2（判不了）。这一格是 livecheck，读侧现在双认 {2,3}，两种码都归第三态。
    return 2
  }
  const impl = implementedLanguages()
  if (impl === null) {
    console.error(`✗ 读不到实现文件：${IMPL_PATH}`)
    return 2
  }
  const missing = [...need.entries()].filter(([l]) => !impl.has(l)).sort((a, b) => b[1] - a[1])
  if (verbose) {
    console.log(`语料需补的语言（${need.size} 种）:`)
    for (const [l, n] of [...need.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${l.padEnd(12)} ${n} 处`)
    console.log(`实现已提供（${impl.size} 种）: ${[...impl].sort().join(", ")}`)
  }
  if (missing.length) {
    console.error(`✗ 语料在用但这些语言没被实现补上（会成块但零着色）：`)
    for (const [l, n] of missing) console.error(`    ${l}（语料 ${n} 处）`)
    console.error(`  修法：在 forge-pm/src/pm/lexical/prism-languages.ts 补 import + 清单条目`)
    // ISS-832：2 在 canonical 口径里是「判不了」，这里是**判到了违规** ⇒ 必须是 1。
    //   原先退 2，被调度器读成「回归（exit 2）」，一旦读侧把 2 正名为判不了，这条红就被洗成第三态。
    return 1
  }
  // 顺序检查已在函数开头做过（见上方 ⚠️「与语料无关，故放在语料早退之前」）
  const orderNote = order.skipped ? "（顺序检查跳过：bun 不可用）" : ""
  console.log(`✓ Prism 语言集与语料一致（需补 ${need.size} 种，实现均覆盖${orderNote}）`)
  return 0
}

/** 自测：造临时夹具，双向验证（该红的红、干净的不红）。不读真语料。 */
function selftest() {
  const tmp = mkdtempSync(join(tmpdir(), "prism-guard-"))
  let failures = 0
  try {
    // 夹具：一个 issues 目录，含 bash / mermaid / jsonc / javascript / yaml 五种围栏
    const dir = join(tmp, "issues")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "a.md"),
      "---\nid: X\n---\n\n```bash\necho hi\n```\n\n```mermaid\ngraph TD\nA-->B\n```\n" +
        "\n```jsonc\n{}\n```\n\n```javascript\nconst a=1\n```\n\n```yaml\nk: v\n```\n",
    )
    // 夹具 store（ISS-899）：期望集的「Prism 有无包 / code-prism 自带」两道过滤读
    // node_modules/.bun —— 真实 store 只在主检出的 bun 环境存在（工单树 / CI 冷装是 pnpm）。
    // 夹具自建一份假 store **注入**，selftest 才不随环境变色：原先探不到 ⇒ builtin 恒空 +
    // 「有无包」恒 false ⇒ 期望集恒空 ⇒ 「应把 bash/yaml 列入期望集」真红（工单树基线 7 红之一）。
    const bunBase = join(tmp, "fake-bun-store")
    const prismComponents = join(bunBase, "prismjs@1.0.0-fixture", "node_modules", "prismjs", "components")
    mkdirSync(prismComponents, { recursive: true })
    for (const l of ["bash", "yaml", "javascript"]) writeFileSync(join(prismComponents, `prism-${l}.js`), "")
    const cpDist = join(bunBase, "@lexical+code-prism@0.49.0-fixture", "node_modules", "@lexical", "code-prism", "dist")
    mkdirSync(cpDist, { recursive: true })
    // 自带集夹具同时走到两条提取路径：import 形态（javascript）+ 内联注册形态（go）
    writeFileSync(
      join(cpDist, "LexicalCodePrism.dev.mjs"),
      "import 'prismjs/components/prism-javascript.js'\nPrism.languages.go = {}\n",
    )
    const need = expectedRequired(tmp, { bunBase })
    // 期望：bash 与 yaml 在（语料在用、非自带、夹具 store 有包）；mermaid / jsonc / javascript
    // 不在（不走高亮链路 / Prism 无包 / code-prism 自带）。夹具注入下 need 必须是真 Map ——
    // 环境哨兵漏到这里说明夹具坏了，同样算失败。
    const ok1 = need instanceof Map && need.has("bash") && need.has("yaml")
    const ok2 = need instanceof Map && !need.has("mermaid") && !need.has("jsonc") && !need.has("javascript")
    if (!ok1) {
      console.error("✗ selftest: 应把 bash/yaml 列入期望集")
      failures++
    }
    if (!ok2) {
      console.error("✗ selftest: 不该把 mermaid/jsonc/javascript 列入期望集")
      failures++
    }
    // 反向：语料不存在 ⇒ 不判（ISS-832 起是 exit 2，不再是 exit 0）
    //   原先这里断 rc === 0：脚本嘴上说「不判」、码上却是绿 —— 断言把 fail-open 钉死了，
    //   所以改码的同时必须改这条断言，否则「修好了但自检红」。
    const rc = check(join(tmp, "nonexistent-dir"))
    if (rc !== 2) {
      console.error(`✗ selftest: 语料不存在时应「不判」exit 2（实得 ${rc}）`)
      failures++
    }
    // 反向：构造"实现缺 yaml" ⇒ check 应报红
    // 用临时实现文件做不到（路径固定），故直接验 missing 计算逻辑
    const impl = implementedLanguages()
    if (impl) {
      const missing = [...(need instanceof Map ? need.keys() : [])].filter((l) => !impl.has(l))
      // 真实现里 yaml 应该在 ⇒ 不应有 missing
      if (missing.length) {
        console.error(`✗ selftest: 真实现竟缺语言：${missing.join(", ")}`)
        failures++
      }
    }
    if (failures === 0) console.log("✓ selftest 通过（期望集口径双向验证：该列入的列入、不该的不列入）")
    return failures === 0 ? 0 : 2
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const rootIdx = args.indexOf("--root")
const root =
  rootIdx >= 0
    ? args[rootIdx + 1]
    : join(process.env.DSH_HOME || join(process.env.HOME || "", ".dsh"), "pm")
if (args.includes("--selftest")) process.exit(selftest())
// `--check` 与缺省同义（`guard-baselines.sh` 的 livecheck 会传一个参数如 `--check`）
process.exit(check(root, { verbose: args.includes("--verbose") }))
