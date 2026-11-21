/**
 * 桥接层 ↔ 官方原件 token 契约 parity 判据（ISS-931 复审追加）。
 *
 * 守三件事（逻辑唯一真相源在 `packages/client/ui-theme/tests/bridge-parity.check.mjs`，
 * 本文件只把它的结果翻译成 GateResult，不复制任何比对逻辑）：
 *   ① 官方定义为 var() 且桥接也定义的项 ⇒ 桥接侧必须仍是 var()，不许写死数值；
 *   ② --dsw-static-* 调色板 ⇒ 桥接值 === 官方包值（禁手抄）；
 *   ③ designer 点名的 --dsl-search-line-height ⇒ 解析到官方 22px。
 * 漂移即红：官方调档或有人手抄错值，这条都会抓住。
 *
 * 不进 fast：判据读的是锁进仓内的官方包契约快照（fixtures/official-token-contract.json），
 * 不属于「每次提交都要跑」的高频轻档；进 ci + 由 active spec 条目自动派生的自检格进 gateselfcheck。
 *
 * @module scripts/gates/verify-bridge-parity
 */
import { isMain, runGate, type GateResult } from "../lib/gate-runtime.ts"
// 单一真相源：复用 ui-theme 测试的零依赖 parity 检查，不在本文件重写比对逻辑。
import { checkParity } from "../../packages/client/ui-theme/tests/bridge-parity.check.mjs"

const GATE = "verify-bridge-parity"

/** 与 check.mjs 的返回形状对齐（.mjs 无类型声明，这里显式声明 reader 侧契约）。 */
export interface ParityResult {
  readonly varForward: readonly string[]
  readonly staticPalette: readonly string[]
  readonly flaggedLiteral: readonly string[]
  readonly radius: readonly string[]
  readonly counts: { readonly varForward: number; readonly staticOverlap: number; readonly flagged: number; readonly radius: number }
  readonly resolved: Readonly<Record<string, string | undefined>>
  readonly resolvedRadii: readonly (string | undefined)[]
}

/** 纯函数：喂入 parity 结果 → GateResult（spec 的反向用例直接喂构造数据）。 */
export function judge(r: ParityResult): GateResult {
  const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["var-forward", r.varForward],
    ["static-palette", r.staticPalette],
    ["flagged-literal", r.flaggedLiteral],
    ["radius", r.radius],
  ]
  const findings = groups.flatMap(([group, list]) => list.map((detail) => ({ detail: `[${group}] ${detail}` })))
  return findings.length
    ? { gate: GATE, status: "failed", findings }
    : { gate: GATE, status: "passed", findings: [] }
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main: () => judge(checkParity() as ParityResult) })
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
