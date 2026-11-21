/**
 * 退出码口径一致性判据（ISS-832）。
 *
 * 治的病：同一个数字在**三处各写一遍** —— `lib/gate-runtime.ts` 的 EXIT、
 * `lib/run-gates-verdict.mjs` 里的裸 `3`、`gates/README.md` 的表格。
 * 三份迟早不一致，而不一致的表现是「文档说 2 = 判不了，代码读 2 = 违规」这种**静默改口径**。
 *
 * 现在唯一真相源 = `scripts/lib/exit-codes.mjs`。本判据验两件事：
 *   ① **代码真的引用它**（不是复制一份常量）——引用断了就红；
 *   ② **README 的口径行与它逐字一致** ——文档与实现分叉就红。
 *
 * ⚠️ 为什么比对「整行字符串」而不是「解析 README 里的数字」：
 *   解析数字的判据改个措辞就挂（假红），而假红的判据会被关掉，于是什么也没守住。
 *   整行比对把措辞也纳入契约：要改文案就同时改常量文件的 `exitTableLine()`，
 *   `git diff` 里两边都看得见。代价是改文案要动两处 —— 有意如此：这是一次有意的口径变更，
 *   不需要「顺手改一下文档措辞」那种便利。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { EXIT, isUnjudged, exitTableLine } from "../lib/exit-codes.mjs"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-exit-codes"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const README = path.join(REPO, "scripts/gates/README.md")
/** 「代码真的引用常量」这条断言要看的读者。缺一个 = 那个读者随时可以偷偷改回自己的数字。 */
const READERS = ["scripts/lib/gate-runtime.ts", "scripts/lib/run-gates-verdict.mjs"]

export interface Inputs {
  /** README 全文；null = 文件不存在 */
  readme: string | null
  /** 各读者文件的全文，键是仓库相对路径；缺文件用 null */
  readers: Record<string, string | null>
  /** 唯一常量给的口径行 */
  expectedLine: string
  /** 常量口径的三态码（喂给 spec 构造反例用） */
  codes: typeof EXIT
}

/** 纯函数：spec 直接喂构造数据。 */
export function judgeExitCodes(i: Inputs): GateResult {
  if (i.readme === null) return unjudged(GATE, "no-corpus", "scripts/gates/README.md 不存在 —— 口径文档没了，无从对账")

  const findings: { file?: string; line?: number; detail: string }[] = []

  // ① 文档行必须逐字包含权威口径
  if (!i.readme.includes(i.expectedLine)) {
    const at = i.readme.split("\n").findIndex((l) => /判据只\*\*读\*\*、只\*\*报告\*\*/.test(l))
    findings.push({
      file: "scripts/gates/README.md",
      ...(at >= 0 ? { line: at + 1 } : {}),
      detail: `退出码口径行与 ${"scripts/lib/exit-codes.mjs"} 不一致。期望逐字包含：\`${i.expectedLine}\``,
    })
  }

  // ② 每个读者都必须真的引用常量文件（复制一份常量正是本单要修的病）
  for (const rel of READERS) {
    const src = i.readers[rel]
    if (src === null) {
      findings.push({ file: rel, detail: "读者文件不存在 —— 目录结构变了，本条判据需要同步" })
      continue
    }
    if (!/from\s+["'][^"']*exit-codes\.mjs["']/.test(src)) {
      findings.push({ file: rel, detail: "没有 import scripts/lib/exit-codes.mjs —— 退出码又是本文件自己写的一份了" })
    }
  }

  // ③ 常量自身必须自洽（三态互不相同、判不了码能被 isUnjudged 认出）
  const vals = [i.codes.passed, i.codes.failed, i.codes.unjudged]
  if (new Set(vals).size !== vals.length) findings.push({ detail: `三态码有重复：${JSON.stringify(i.codes)}（三态必须可分辨）` })
  if (!isUnjudged(i.codes.unjudged)) findings.push({ detail: `isUnjudged(${i.codes.unjudged}) 为假 —— canonical 的判不了码自己认不出自己` })

  return findings.length ? { gate: GATE, status: "failed", findings } : { gate: GATE, status: "passed", findings: [] }
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(REPO, rel), "utf8")
  } catch {
    return null
  }
}

function scan(): Inputs {
  const readers: Record<string, string | null> = {}
  for (const r of READERS) readers[r] = read(r)
  return { readme: read("scripts/gates/README.md"), readers, expectedLine: exitTableLine(), codes: EXIT }
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main: () => judgeExitCodes(scan()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
