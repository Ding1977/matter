/**
 * W12 雏形判据（ISS-537 / P4-S1）：浏览器壳 boot 接线静态判。
 *
 * ## 判什么（甲形态的机器可判不变量）
 *
 * 扫 apps/web/ 的源码，判 5 组接线（每组可独立红，finding 带 文件:行 + 判词）：
 *   ① index.html 有 `#root` 与 `<script type="module" src=...>`（裸 Vite 载入载体）；
 *   ② boot.ts **静态 import** client 包（ui-theme 的 installThemeStyles/installDswBridgeStyles、
 *      ui-kb 的 DocList），且两个 install **各恰调用一次**（review-2305 观察项：
 *      重复装会追加 style 标签——调用点数必须为 1，不是「至少 1」也不是「注释里提到」）；
 *   ③ **甲形态**：apps/web/src 下无 DSH 注入层 token（__DSH_BOOT__ / __ModuleLoader__ /
 *      applyIndexInjections / __DSH_BOOT_READY__）——静态 import 直连，不抄注入层；
 *   ④ 配置注入：config 层从 URL query（URLSearchParams）与构建期 env（VITE_SHELL_*）取值，
 *      后端地址不写死——判「默认值之外有注入通道」；
 *   ⑤ 嵌入开关：config 暴露 embed，boot 依据 embed 做渲染分支（隐藏 chrome）。
 *
 * ## 为什么是「雏形」
 *
 * 口径刻意保守：只判可机判的**文本接线**（静态 import / 调用计数 / token 缺席 / 注入通道存在），
 * 不解析 AST 控制流、不验运行时行为（那是 smoke 与 #2 真机验收的事）。但「能判红」是硬标准：
 * spec 的必然失败向量（删 import / 装两次 / 塞注入层 token / 写死地址）每条都必红。
 *
 * ## 三态（gate-runtime 唯一口径）
 *
 *   0 = passed（apps/web 语料齐，0 条违例）
 *   1 = failed（有违例）
 *   2 = unjudged（apps/web/src 不存在 / 0 源文件 no-corpus）
 *
 * @module gates/verify-shell-boot
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-shell-boot"

/** 仓库根（相对本文件的稳定定位：scripts/gates → 上两级）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** 注入层 token（甲形态禁止出现在 apps/web/src）。 */
export const INJECTION_TOKENS = ["__DSH_BOOT__", "__ModuleLoader__", "applyIndexInjections", "__DSH_BOOT_READY__"] as const

/** 必须在 boot 源码中静态 import 的 client 面符号。 */
export const REQUIRED_IMPORTS = ["installThemeStyles", "installDswBridgeStyles", "DocList"] as const

/** 判据输入：apps/web 下源文件表（仓库相对路径 → 正文）。 */
export interface ShellBootCorpus {
  readonly files: ReadonlyMap<string, string>
}

/** 一条违例。 */
export type ShellBootFinding = Finding

/** 调用点计数用字面量（import 行不含 `(` 故不会误计；注释行由 `stripComments` 先摘除）。 */
const CALL_PATTERNS = ["installThemeStyles(", "installDswBridgeStyles("] as const

/**
 * 去掉 // 与 /* *\/ 注释（保留行结构以便行号对齐）。判词里出现的 token 不算真实接线。
 * @param text - 源文本。
 * @returns 去注释后的文本（行数不变）。
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
}

/** 找某字面量第一次出现的行号（1-based）。 */
function lineOf(text: string, needle: string): number | undefined {
  const idx = text.indexOf(needle)
  if (idx < 0) return undefined
  return text.slice(0, idx).split("\n").length
}

/** 统计字面量出现次数（去注释后的文本）。 */
function countOf(text: string, needle: string): number {
  let n = 0
  let from = 0
  for (;;) {
    const i = text.indexOf(needle, from)
    if (i < 0) return n
    n++
    from = i + needle.length
  }
}

/**
 * 纯判据：输入 apps/web 源文件表 → 判词。owner 可喂构造数据做变异/必然失败测试。
 *
 * @param corpus - 源表（key 形如 `apps/web/src/boot.ts`）。
 * @returns GateResult；0 源文件 = unjudged(no-corpus)。
 */
export function judgeShellBoot(corpus: ShellBootCorpus): GateResult {
  const findings: ShellBootFinding[] = []
  const files = corpus.files
  if (files.size === 0) return unjudged(GATE, "no-corpus", "apps/web 下无源文件可判")

  const html = files.get("apps/web/index.html")
  const bootRaw = files.get("apps/web/src/boot.ts")
  const configRaw = files.get("apps/web/src/config.ts")

  // ① index.html 载体
  if (html === undefined) {
    findings.push({ file: "apps/web/index.html", detail: "缺 index.html——裸 Vite 无载入载体" })
  } else {
    if (!/#root|id=["']root["']/.test(html)) {
      findings.push({ file: "apps/web/index.html", detail: "缺 #root 容器" })
    }
    if (!/<script[^>]*type=["']module["'][^>]*src=/.test(html) && !/<script[^>]*src=[^>]*type=["']module["']/.test(html)) {
      findings.push({ file: "apps/web/index.html", detail: "缺 <script type=\"module\" src=...> 入口" })
    }
  }

  if (bootRaw === undefined) {
    findings.push({ file: "apps/web/src/boot.ts", detail: "缺 boot.ts——boot 链无装配点" })
  } else {
    const boot = stripComments(bootRaw)
    // ② 静态 import + 各恰一次调用
    //    行内匹配（`^\s*import...\b<sym>\b`，m 标志）：不能用 [^;]* 跨行——TS 无分号，
    //    否则任意一条 import 会一路吞到后面的调用点，造成「删了 import 仍判有」的假阴性。
    for (const sym of REQUIRED_IMPORTS) {
      if (!new RegExp(`^\\s*import\\b[^\\n]*\\b${sym}\\b`, "m").test(boot)) {
        findings.push({ file: "apps/web/src/boot.ts", line: lineOf(boot, sym), detail: `boot 未静态 import ${sym}` })
      }
    }
    for (const call of CALL_PATTERNS) {
      const sym = call.slice(0, -1)
      const n = countOf(boot, call)
      if (n !== 1) {
        findings.push({
          file: "apps/web/src/boot.ts",
          line: lineOf(boot, sym),
          detail: `${sym} 调用点数 = ${n}，必须为 1（各恰一次，重复装会追加 style 标签 · review-2305）`,
        })
      }
    }
    // ⑤ 嵌入开关：boot 依据 embed 分支渲染
    if (!/\bembed\b/.test(boot)) {
      findings.push({ file: "apps/web/src/boot.ts", detail: "boot 未读 embed 开关——嵌入模式无渲染分支" })
    }
  }

  // ③ 甲形态：src 下无注入层 token（只看 js/ts 源，不看 md）
  for (const [file, raw] of files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue
    const text = stripComments(raw)
    for (const token of INJECTION_TOKENS) {
      if (text.includes(token)) {
        findings.push({ file, line: lineOf(text, token), detail: `甲形态禁止注入层 token ${token}（静态 import 直连，不抄 DSH 注入层）` })
      }
    }
  }

  // ④ 配置注入 + ⑤ embed 开关在 config 层
  if (configRaw === undefined) {
    findings.push({ file: "apps/web/src/config.ts", detail: "缺 config.ts——无 URL/env 注入通道" })
  } else {
    const config = stripComments(configRaw)
    if (!/URLSearchParams|location\.search/.test(config)) {
      findings.push({ file: "apps/web/src/config.ts", detail: "config 未从 URL query 取值（后端地址/@注入通道缺失）" })
    }
    if (!/VITE_SHELL_|import\.meta\.env|Sources/.test(config)) {
      findings.push({ file: "apps/web/src/config.ts", detail: "config 未从构建期 env 取值" })
    }
    if (!/\bembed\b/.test(config)) {
      findings.push({ file: "apps/web/src/config.ts", detail: "config 未暴露 embed 开关" })
    }
  }

  return findings.length > 0
    ? { gate: GATE, status: "failed", findings }
    : { gate: GATE, status: "passed", findings: [] }
}

/** 现场采集：递归列 apps/web 下源/HTML 文件（跳过 dist/node_modules/tests/README）。 */
const SKIP = new Set(["node_modules", "dist", "tests"])

/**
 * @param root - 仓库根绝对路径。
 * @returns 源文件表（仓库相对路径 → 正文）。
 */
export function collectWebSources(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const base = path.join(root, "apps", "web")
  if (!fs.existsSync(base)) return out
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile() && /\.(ts|tsx|js|jsx|html)$/.test(e.name)) {
        out.set(path.relative(root, abs), fs.readFileSync(abs, "utf8"))
      }
    }
  }
  walk(base)
  return out
}

if (isMain(import.meta.url)) {
  runGate({
    name: GATE,
    main: () => judgeShellBoot({ files: collectWebSources(REPO_ROOT) }),
  })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
