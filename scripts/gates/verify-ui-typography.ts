/**
 * 静态判据 S1（裸标题禁用）+ S2（字号/字重只用档位）的门禁薄包装（ISS-907）。
 *
 * 判据本体住 packages/client/ui-theme/tests/typography-scan.ts + typography.test.ts（照 DSH 归属）；
 * 本脚本只把全仓扫结果对账 expected/typography-exceptions.json，产出 0/1/2 退出码给 run-gates。
 *
 * 精确相等口径：多一条、少一条、code 漂移都红；例外缺理由也红。
 * --selftest 由 gate-runtime 自动调度同名 spec（含必然失败反向对照）。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"
import {
  readConfig,
  scanRepo,
  type ScanFindings,
} from "../../packages/client/ui-theme/tests/typography-scan.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const EXPECTED = path.join(REPO, "packages/client/ui-theme/tests/expected/typography-exceptions.json")

/** 带理由的例外条目。 */
export interface ExceptionEntry {
  code: string
  reason: string
}

/** 例外清单形状：s1 / s2 都是 key(at) → entry。 */
export interface ExpectedExceptions {
  s1: Record<string, ExceptionEntry>
  s2: Record<string, ExceptionEntry>
  /** S3：h2 引用的 title/column 类未声明 font-weight（ISS-931 reviewer 洞）。 */
  s3: Record<string, ExceptionEntry>
}

/**
 * 纯函数：全仓扫事实 ⇄ 例外清单对账（spec 直接喂构造数据）。
 * @param actual - 扫描事实。
 * @param expected - 例外清单（null = 读不到 ⇒ 判不了）。
 * @returns 门禁结论。
 */
export function judgeTypography(actual: ScanFindings, expected: ExpectedExceptions | null): GateResult {
  const gate = "verify-ui-typography"
  if (expected === null) return unjudged(gate, "no-baseline", "typography-exceptions.json 读不到或不是合法 JSON ⇒ 判不了")

  const findings: string[] = []
  for (const which of ["s1", "s2", "s3"] as const) {
    const exp = expected[which] ?? {}
    const act = actual[which] ?? {}
    for (const [at, entry] of Object.entries(exp)) {
      if (!entry.reason?.trim()) findings.push(`${which} ${at}：例外缺理由（不许用空理由吞真回归）`)
    }
    const expCodes = Object.fromEntries(Object.entries(exp).map(([at, e]) => [at, e.code]))
    for (const [at, code] of Object.entries(act)) {
      if (expCodes[at] !== code) findings.push(`${which} 多出 ${at}: ${code}（未在例外清单，或 code 漂移）`)
    }
    for (const [at, code] of Object.entries(expCodes)) {
      if (act[at] !== code) findings.push(`${which} 少了 ${at}: ${code}（违规已消失：要么修好了该收线，要么判据漏报）`)
    }
  }
  return findings.length
    ? { gate, status: "failed", findings: findings.map((detail) => ({ detail })) }
    : { gate, status: "passed", findings: [] }
}

/** 读例外清单；读不到返回 null（判不了，不冒绿）。 */
export function readExpected(): ExpectedExceptions | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(EXPECTED, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return null
    const obj = parsed as Partial<ExpectedExceptions>
    if (typeof obj.s1 !== "object" || typeof obj.s2 !== "object" || typeof obj.s3 !== "object") return null
    return obj as ExpectedExceptions
  } catch {
    return null
  }
}

if (isMain(import.meta.url)) {
  runGate({
    name: "verify-ui-typography",
    main: () => judgeTypography(scanRepo(readConfig()), readExpected()),
  })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ verify-ui-typography: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
