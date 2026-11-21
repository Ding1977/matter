/**
 * 判据运行时（ISS-737）—— 一条判据 = 一个可单跑的 `.ts` + 同名 `.spec.ts`。
 *
 * 依据：`docs/plans-k-replacement-2026-11-09.md` §3.1 / §3.2。
 *
 * 退出码唯一口径：
 *   0 = passed（判过，绿）
 *   1 = failed（判到违规，红）
 *   2 = unjudged（缺输入 / 用法错 / 环境不满足）—— **必须带理由码**，L3 侧无票即红
 *
 * ⛔ **禁止用 0 表示「跳过」**：旧体系里「基线文件不存在 ⇒ exit 0」等于删掉基线就永久变绿。
 *
 * 三条硬要求：
 *   ① 判据逻辑是纯函数（输入 → GateResult），`main` 之外不碰 IO；spec 才能直接喂构造数据
 *   ② 缺输入返回 unjudged + 理由码，不许 return passed
 *   ③ 一个脚本一个判据；共用逻辑放 `scripts/lib/`，但 lib 里不许有判据
 */
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export type GateStatus = "passed" | "failed" | "unjudged"
export type ReasonCode = "no-corpus" | "no-home" | "no-binary" | "no-build" | "no-baseline" | "no-rule-table"

export interface Finding {
  file?: string
  line?: number
  detail: string
}

export interface GateResult {
  gate: string
  status: GateStatus
  findings?: Finding[]
  /** 仅 status=unjudged 时有意义；给不出理由码 = 载体不合格 */
  reason?: ReasonCode
  detail?: string
}

// ISS-832：码值不再在本文件定义 —— 唯一定义在 `scripts/lib/exit-codes.mjs`（零依赖纯常量），
//   本文件与 `run-gates-verdict.mjs` 都从那里取。原先这里 `{ passed: 0, failed: 1, unjudged: 2 }`
//   与 verdict 里的裸 `3`、README 的表格各写一遍，三份迟早不一致，而不一致的表现是**静默改口径**。
// ⚠️ `.mjs` 在 `.ts` 里的类型是推断出来的（无 .d.ts）；`as Record<GateStatus, number>` 是断言不是复制 ——
//   复制一份常量正是本单要修的病。
import { EXIT as EXIT_CODES } from "./exit-codes.mjs"
export const EXIT = EXIT_CODES as Record<GateStatus, number>

export function unjudged(gate: string, reason: ReasonCode, detail: string): GateResult {
  return { gate, status: "unjudged", reason, detail, findings: [] }
}

export function toExit(r: GateResult): number {
  return EXIT[r.status] ?? 2
}

/**
 * 「本文件是不是被判据直接执行」。
 * Node 22 没有 `import.meta.main`，所以用 argv[1] 与 import.meta.url 比对。
 */
export function isMain(url: string): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return pathToFileURL(path.resolve(argv1)).href === url
  } catch {
    return false
  }
}

/** `scripts/gates/` 下的文件算不算「一条判据」。spec 与注册表不是判据。 */
export function isGateFile(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".spec.ts") && name !== "registry.ts"
}

export interface GateOptions {
  pkg?: string
  files?: string[]
}

export interface GateSpec {
  name: string
  /** 只作文档与 L3 的依赖声明；真正的「缺输入」由 main 返回 unjudged 表达。 */
  requires?: string[]
  main: (opts: GateOptions) => GateResult | Promise<GateResult>
}

function parseArgs(argv: string[]) {
  const pick = (n: string) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    check: argv.includes("--check"),
    selftest: argv.includes("--selftest"),
    pkg: pick("--pkg"),
    files: pick("--files")?.split(",").filter(Boolean),
  }
}

/**
 * 统一入口：`--check`（默认）/ `--selftest` / `--pkg` / `--files`。
 * `--selftest` 动态加载**同目录同名** `.spec.ts` 并调用其 `run()`；
 * spec 缺失或没有 `run()` ⇒ 退 2（载体不规范），不是 0。
 */
export async function runGate(spec: GateSpec, argv = process.argv.slice(2)): Promise<number> {
  const a = parseArgs(argv)
  if (a.selftest) {
    const gateFile = process.env.__GATE_FILE__ || process.argv[1]
    if (!gateFile) {
      console.error(`✗ ${spec.name}: 无法定位当前判据文件（argv[1] 为空）`)
      return 2
    }
    const specPath = path.join(path.dirname(path.resolve(gateFile)), `${path.basename(gateFile).replace(/\.ts$/, "")}.spec.ts`)
    try {
      const mod = await import(pathToFileURL(specPath).href)
      if (typeof mod.run !== "function") {
        console.error(`✗ ${spec.name}: ${path.basename(specPath)} 没有导出 run()`)
        return 2
      }
      const ok = (await mod.run()) === true
      return ok ? 0 : 1
    } catch (e) {
      console.error(`✗ ${spec.name}: 同名 spec 加载/执行失败（${(e as Error).message}）`)
      console.error(`   期望文件：${specPath}`)
      return 2
    }
  }

  const r = await spec.main({ pkg: a.pkg, files: a.files })
  if (r.status === "passed") {
    console.log(`✓ ${r.gate}: passed`)
    // 绿也允许带提示（如「可收线」「距目标还差 N」）——静默丢提示等于丢行动项。
    if (r.detail) console.log(`   ${r.detail}`)
  } else if (r.status === "failed") {
    console.log(`✗ ${r.gate}: failed（${r.findings?.length ?? 0} 条）`)
    for (const f of r.findings ?? []) console.log(`   · ${f.file ?? "-"}${f.line ? `:${f.line}` : ""} ${f.detail}`)
  } else {
    console.log(`! ${r.gate}: unjudged（${r.reason ?? "unknown"}）${r.detail ? ` —— ${r.detail}` : ""}`)
  }
  return toExit(r)
}
