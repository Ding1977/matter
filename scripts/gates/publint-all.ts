/**
 * 包发布物合法性判据（ISS-822）—— **移植自官方 `scripts/publint-all.ts`（245 行）+
 * `scripts/publint-browser-format.ts`（20 行）**。
 *
 * ## 我们为什么要它
 *
 * 25 个 `forge-*` 包各自声明了 `exports`，**没有一条判据看它们指向的文件在不在**。
 * `exports` 写错是「静默」的：本地开发走 `workspace:*` 直连目录，永远读得到源文件；
 * 一旦按 `files[]` 打包（`npm pack` / 从 tarball 安装 / 将来改成分发形态），
 * 指向未发布文件的 `exports` 会在**加载期**炸 —— 而那时错在别人的机器上。
 *
 * ## 移植了什么（逐条对上官方）
 *
 *   ① **发布视图**：`package.json` + `files[]` 展开 + npm 恒收项（`README*` / `LICENSE*` /
 *      `LICENCE*`）+ `main` / `browser` / `bin` 指向的文件（与 `files[]` 无关，npm 恒收）。
 *      官方用 `globSync` + `addPath`（目录则递归收）；本判据同构。
 *   ② **调 publint 的虚拟 FS 形态**：`publint({ pkgDir: 'package', pack: { files } })` ——
 *      不给 `pack:'auto'`，因为那会真的调包管理器打包（实测本仓 25 包合计 **108s**，
 *      单 `forge-tailwind` 一格就 47s，且依赖 `bun` 在 PATH —— 门禁里不可接受）。
 *      ⚠️ 本判据改用「自己算发布视图」而不是 `pack:'npm'`：实测 25 包合计 1.3s，
 *      且逐包比对**与 `npm pack --dry-run` 的 25 份文件清单逐字节相同**（证据见工单 note）。
 *   ③ **浏览器产物格式误报过滤**（官方 `isBrowserBundleFormatFalsePositive`）。
 *   ④ **只有 `type === "error"` 判红**，`warning` / `suggestion` 只作提示（同官方口径）。
 *
 * ## 与官方实现的三处差异（都是有意的）
 *
 * 1. **误报过滤的依据从「路径名」换成「文件内容」**。官方按路径判
 *    `/(^|\/)lib\/(?:client(?:\.browser)?|worker)\.js$/`，因为官方那些浏览器半住在 `lib/`。
 *    我们的浏览器半统一是 `dist/client.js`，**且它确实不是 CJS 模块** —— 实测 13 个
 *    `dist/client.js` 首行全是 `window.__ModuleLoader__.load({`，由宿主在浏览器侧按脚本注入，
 *    不走 Node 的 ESM 加载器。所以本判据的豁免条件是**两件同时成立**：
 *    路径命中 `dist/client.js` **且** 内容以该 loader 标记起头。
 *    ⛔ 只按名字豁免是错的 —— 那样一个真写给 Node 的 CJS `client.js` 也会被放过
 *    （官方注释里那句 "a Node Client entry must never be exempt" 说的就是这件事）。
 * 2. **不移植 `publicationClosureViolations`**（官方用 `typescript` 的 `ts.createSourceFile`
 *    解析发布文件里的相对 import，查它引的兄弟文件是否也在发布视图里）。本仓**根目录没有
 *    `typescript` 依赖**（`grep -c '"typescript"' package.json` = 0，只有各包自己的
 *    `node_modules` 里各带一份），为这条一功能引入 tsc 不划算；改用正则手写又会把注释里的
 *    字符串算成 import ⇒ **假红噪音**。已知盲区，写在这里而不是假装等价。
 * 3. **语料是 `forge-<名>/package.json`**（官方是 `packages/<组>/<包>/package.json`）：本仓是
 *    平铺单层且无 `apps/`，照抄官方 glob 会得到空语料 ⇒ 恒判不了。
 *
 * ## 未构建树（本判据必带的一个 guard）
 *
 * `dist/` 在 `.gitignore` 第 2 行且**从未入库**（`git log --all -- forge-pm/dist` = 0 条），
 * 而 `lib/` 是入库的。⇒ 全新 checkout 上 16 个包的 `dist/` 整目录不存在。
 * 若照判，会得到「16 个包的 exports 指向不存在的文件」——**那不是发布物有错，是没构建**。
 * 把两件事判成一件 ⇒ 判据在干净树上恒红 ⇒ 一条恒红的判据等于没有判据。
 * 故：任一包声明了 `dist/` 下目标而它的 `dist/` 整个不在 ⇒ 整条判据 `unjudged(no-build)`。
 * 为什么不逐包挑掉：`dist/` 只建了一半（只跑了 `build:client`、没跑 `build:host`）时，
 * 逐包挑会把**真缺产物的包**一起放过；整条判不了更诚实。
 *
 * ## 口径（退出码见 `scripts/lib/gate-runtime.ts`）
 *   0 = 绿（全部包无 error） · 1 = 红（有 error） · 2 = 判不了（找不到任何包 / 整树未构建）
 *
 * ## 现状（本单实测 · 快照，不是恒真）
 *   本树 11 条 error / 4 个包（forge-mermaid 7 · forge-tailwind 2 · forge-model-limits 1 ·
 *   forge-window-chrome 1），已报 **ISS-827** 待修。判据**随红交付**：⛔ 不为了变绿去改
 *   `package.json`（那是 ISS-827 的活）。修完应转绿；若仍红，复检命令即上面那条。
 *
 * ## 变异可红（本单实测）
 *   往 `forge-widgets/package.json` 的 `exports` 加一条 `"./broken": "./lib/nonexistent-module.js"`
 *   ⇒ `EXIT=1` 且 finding 指名 `forge-widgets pkg.exports["./broken"] ... does not exist`
 *   ⇒ 还原后 `EXIT=1` 且条数回落 11（无 forge-widgets 条目）。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { publint, type Message } from "publint"
import { formatMessage } from "publint/utils"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "publint-all"

/** 浏览器半的产物标记：宿主在浏览器侧按脚本注入，不经 Node 的 ESM 加载器。 */
export const BROWSER_LOADER_MARKER = "window.__ModuleLoader__.load("

/** npm 恒收的文件（与 `files[]` 无关）。`npm pack` 实测：`README*` / `LICENSE*` / `LICENCE*`。 */
const ALWAYS_INCLUDED = ["README*", "LICENSE*", "LICENCE*"] as const

/** 遍历时跳过的目录（`node_modules` 不是包自己的内容；`.git` 同）。 */
const SKIP_DIRS = new Set(["node_modules", ".git"])

export interface PackedFile {
  /** 虚拟 FS 里的路径，`package/<包内相对路径>` */
  name: string
  data: Buffer
}

export interface Finding {
  /** 包目录名，如 `forge-pm` */
  pkg: string
  /** 人读一行（已由 `formatMessage` 按该包 manifest 渲染） */
  detail: string
}

/**
 * **未构建树**的判法：`dist/` 是 `.gitignore` 的第 2 行且**从未入库**
 * （`git log --all -- forge-pm/dist` = 0 条）。⇒ 全新 checkout / CI 干净树上
 * 16 个包的 `dist/` 整目录不存在，若照判就是 16 个包「exports 指向不存在的文件」——
 * 那不是发布物有错，是**根本没构建**。把这两件事判成同一件会让判据在干净树上恒红，
 * 一条恒红的判据等于没有判据。
 *
 * 判法（保守，宁可判不了不乱报）：只要有一个包声明了 `dist/` 下的目标、而它**整个
 * `dist/` 目录都不在**，就认定这棵树没构建 ⇒ 整条判据 unjudged(no-build)。
 * 为什么不是「逐包挑掉」：`dist/` 里只建了一半（`build:client` 跑了、`build:host` 没跑）
 * 时逐包挑会把**真的缺产物的包**一起放过。整条判不了更诚实，且 `detail` 说清怎么补。
 */
export function looksUnbuilt(dirs: string[]): string[] {
  const missing: string[] = []
  for (const dir of dirs) {
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    } catch {
      continue
    }
    if (!declaresDistTarget(manifest)) continue
    if (!fs.existsSync(path.join(dir, "dist"))) missing.push(path.basename(dir))
  }
  return missing
}

/** 清单里有没有指向 `dist/` 的目标（exports / main / browser / bin 四类入口都算）。 */
export function declaresDistTarget(manifest: Record<string, unknown>): boolean {
  const text = JSON.stringify({ e: manifest.exports, m: manifest.main, b: manifest.browser, bin: manifest.bin })
  return text.includes("dist/")
}

export interface PackageResult {
  /** 包目录名，如 `forge-pm` */
  path: string
  /** 过滤掉浏览器产物误报之后的 publint 消息，**已渲染成可读一行** */
  messages: Array<{ type: Message["type"]; text: string }>
  /** publint 自身抛错（清单坏了 / 文件读不动）—— 不许静默当「没问题」 */
  failure?: string
}

/** 全部文件（相对包根，posix 分隔）。符号链接不深入：本仓包内软链指向 workspace 兄弟，不是包内容。 */
export function walkFiles(dir: string, prefix = "", out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walkFiles(abs, rel, out)
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/**
 * **发布视图**：哪些文件会真的被打进包里（npm 口径）。
 *
 * ⚠️ 这是本判据唯一的「自己算」的部分（官方直接调包管理器打包）。口径来源与验证方式：
 * 对 25 个包逐包与 `npm pack --dry-run --json` 的文件清单比对，**25/25 集合完全相同**。
 */
export function publicationPaths(dir: string, manifest: Record<string, unknown>): string[] {
  const declared = Array.isArray(manifest.files)
    ? manifest.files.filter((v): v is string => typeof v === "string")
    : null
  const set = new Set<string>(["package.json"])

  if (declared === null) {
    // 没有 `files[]` ⇒ 整个目录（npm 的缺省行为）。
    for (const f of walkFiles(dir)) set.add(f)
    return [...set].sort()
  }

  const add = (abs: string) => {
    const stat = fs.statSync(abs)
    const rel = path.relative(dir, abs).split(path.sep).join("/")
    if (stat.isDirectory()) {
      for (const f of walkFiles(abs)) set.add(rel ? `${rel}/${f}` : f)
    } else if (stat.isFile()) {
      set.add(rel)
    }
  }
  for (const pattern of [...declared, ...ALWAYS_INCLUDED]) {
    const hits = typeof fs.globSync === "function" ? fs.globSync(pattern, { cwd: dir }) : []
    for (const hit of hits) add(path.resolve(dir, hit))
  }
  // `main` / `browser` / `bin` 指向的文件 npm 恒收，与 `files[]` 是否覆盖无关（实测确认）。
  const entries = [manifest.main, manifest.browser, ...Object.values((manifest.bin ?? {}) as Record<string, unknown>)]
  for (const rel of entries) {
    if (typeof rel !== "string") continue
    const abs = path.resolve(dir, rel)
    if (fs.existsSync(abs)) add(abs)
  }
  return [...set].sort()
}

/** 发布视图 → publint 的虚拟 FS 形态。 */
export function packView(dir: string, manifest: Record<string, unknown>): PackedFile[] {
  return publicationPaths(dir, manifest).map((rel) => ({
    name: `package/${rel}`,
    data: fs.readFileSync(path.join(dir, rel)),
  }))
}

/**
 * 浏览器产物格式误报：`dist/client.js` 被 publint 判成「CJS 却按 ESM 解释」。
 *
 * 它不是误判格式、是**根本不是 Node 模块** —— 实测 13 个 `dist/client.js` 首行都是
 * `window.__ModuleLoader__.load({`，由宿主注入浏览器。故豁免条件两项同时成立：
 * 路径命中 `dist/client.js` **且** 内容以 loader 标记起头（只按名字豁免会放过真的 Node CJS）。
 */
export function isBrowserBundleFalsePositive(message: Message, files: readonly PackedFile[]): boolean {
  if (message.code !== "FILE_INVALID_FORMAT") return false
  const actual = (message.args as { actualFilePath?: string }).actualFilePath ?? ""
  const rel = actual.replace(/^\.?\/?/, "")
  if (!/(^|\/)dist\/client\.js$/.test(rel)) return false
  const packed = files.find((f) => f.name === `package/${rel}`)
  return packed !== undefined && packed.data.toString("utf8").startsWith(BROWSER_LOADER_MARKER)
}

/** **纯函数**：输入各包结果，返回判定（spec 直接喂构造数据）。 */
export function judgePublint(results: PackageResult[]): GateResult {
  if (results.length === 0) {
    return unjudged(GATE, "no-corpus", "仓内找不到任何自有包（`forge-<名>/package.json`）⇒ 判不了")
  }
  const findings: Finding[] = []
  let warnings = 0
  for (const r of results) {
    if (r.failure) findings.push({ pkg: r.path, detail: `publint 执行失败：${r.failure}` })
    for (const m of r.messages) {
      if (m.type === "error") findings.push({ pkg: r.path, detail: m.text })
      else warnings++
    }
  }
  if (findings.length > 0) {
    return { gate: GATE, status: "failed", findings: findings.map((f) => ({ file: f.pkg, detail: f.detail })) }
  }
  return {
    gate: GATE,
    status: "passed",
    detail: `${results.length} 个包的发布视图合法（0 error）` + (warnings ? ` · ${warnings} 条非阻断提示（warning/suggestion）` : ""),
  }
}

/** IO：对单个包跑一遍 publint。 */
export async function lintPackage(dir: string): Promise<PackageResult> {
  const rel = path.basename(dir)
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>
    const files = packView(dir, manifest)
    const result = await publint({ pkgDir: "package", pack: { files } })
    return {
      path: rel,
      // 渲染在这里做：`formatMessage` 要那份**具体包的** manifest 才能把路径解释成
      // `pkg.exports["."].types`；判据（纯函数）只吃渲染好的字符串。
      messages: result.messages
        .filter((m) => !isBrowserBundleFalsePositive(m, files))
        .map((m) => ({ type: m.type, text: (formatMessage(m, result.pkg, { color: false }) ?? m.code).split("\n")[0] })),
    }
  } catch (error) {
    return { path: rel, messages: [], failure: (error as Error).message }
  }
}

/** IO：语料 = 仓内自有包。 */
export function packageDirs(repo: string = REPO): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(repo, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("forge-"))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
  return names.filter((n) => fs.existsSync(path.join(repo, n, "package.json"))).map((n) => path.join(repo, n))
}

if (isMain(import.meta.url)) {
  const dirs = packageDirs()
  const unbuilt = looksUnbuilt(dirs)
  const verdict = unbuilt.length > 0
    ? Promise.resolve(unjudged(GATE, "no-build",
      `${unbuilt.length} 个包声明了 dist/ 下的目标但整个 dist/ 目录不在（${unbuilt.slice(0, 4).join("、")}${unbuilt.length > 4 ? " 等" : ""}）——` +
      `本树没构建 ⇒ 判不了。补：bun run build:host && bun run build:client`))
    : Promise.all(dirs.map((dir) => lintPackage(dir))).then((results) => judgePublint(results))
  verdict
    .then((result) => runGate({ name: GATE, main: () => result }))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
