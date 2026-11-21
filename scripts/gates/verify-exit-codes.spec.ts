/**
 * `verify-exit-codes.ts` 的自检向量（ISS-832）。
 *
 * 本判据的价值全在**反向用例**：正向「文档对得上 ⇒ 绿」太容易，改个错别字也绿。
 * 必须证明「改掉文档里的那个数字 ⇒ 必红」，否则它是一条没牙的门禁。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { EXIT, exitTableLine } from "../lib/exit-codes.mjs"
import { judgeExitCodes, type Inputs } from "./verify-exit-codes.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GOOD_README = `- 判据只**读**、只**报告**，用退出码表达结论：\`${exitTableLine()}\`。\n`
const GOOD_READER = `import { EXIT, isUnjudged } from "./exit-codes.mjs"\n`

/** 基线：全部正确。每个用例只改一处，证明那一处被抓住。 */
function base(over: Partial<Inputs> = {}): Inputs {
  return {
    readme: GOOD_README,
    readers: { "scripts/lib/gate-runtime.ts": GOOD_READER, "scripts/lib/run-gates-verdict.mjs": GOOD_READER },
    expectedLine: exitTableLine(),
    codes: EXIT,
    ...over,
  }
}

export function run(): boolean {
  const cases: [string, boolean, string?][] = []
  const t = (name: string, ok: boolean, note?: string) => cases.push([name, ok, note])

  // ── 正向：全对 ⇒ 绿 ───────────────────────────────────────────────
  t("正向：文档与常量一致、读者都引用常量 ⇒ passed", judgeExitCodes(base()).status === "passed")

  // ── 反向 ①：改掉文档里的数字 ⇒ 必红（本判据存在的理由）──────────────
  const wrongNumber = base({ readme: GOOD_README.replace(`\`${EXIT.unjudged}\` 判不了`, "`9` 判不了") })
  t("反向：文档把判不了码改成 9 ⇒ failed", judgeExitCodes(wrongNumber).status === "failed",
    `实得 ${judgeExitCodes(wrongNumber).status}`)

  const swapped = base({
    readme: GOOD_README.replace(`\`${EXIT.failed}\` 违规 / \`${EXIT.unjudged}\` 判不了`, `\`${EXIT.unjudged}\` 违规 / \`${EXIT.failed}\` 判不了`),
  })
  t("（自检）反向②的构造真的改到了文本", swapped.readme !== GOOD_README, "替换没命中 —— 用例会假绿")
  t("反向：文档把 1 与 2 的语义对调 ⇒ failed（数字都在、含义错了）", judgeExitCodes(swapped).status === "failed")

  // ── 反向 ②：读者偷偷复制一份常量（不 import）⇒ 必红 ─────────────────
  const copied = base({
    readers: {
      "scripts/lib/gate-runtime.ts": GOOD_READER,
      "scripts/lib/run-gates-verdict.mjs": `const EXIT = { passed: 0, failed: 1, unjudged: 2 }\n`,
    },
  })
  t("反向：读者自己写一份 EXIT、不 import 常量 ⇒ failed（复制的常量正是本单要修的病）",
    judgeExitCodes(copied).status === "failed")

  // ── 反向 ③：读者文件消失 ⇒ 红（不是静默变绿）───────────────────────
  const missing = base({ readers: { "scripts/lib/gate-runtime.ts": null, "scripts/lib/run-gates-verdict.mjs": GOOD_READER } })
  t("反向：读者文件不存在 ⇒ failed（目录结构变了，判据要跟上）", judgeExitCodes(missing).status === "failed")

  // ── 反向 ④：常量三态撞码 ⇒ 红 ────────────────────────────────────
  const collide = base({ codes: { passed: 0, failed: 1, unjudged: 1 } as typeof EXIT })
  t("反向：三态码有重复（failed 与 unjudged 都是 1）⇒ failed", judgeExitCodes(collide).status === "failed")

  // ── 边界：README 不存在 ⇒ 判不了（不是绿）──────────────────────────
  t("边界：README 不存在 ⇒ unjudged no-corpus（缺文档不是通过）", judgeExitCodes(base({ readme: null })).status === "unjudged")

  // ── 边界：判不了码自己认不出自己 ⇒ 红 ──────────────────────────────
  const selfBlind = base({ codes: { passed: 0, failed: 1, unjudged: 2 } as typeof EXIT })
  t("边界：canonical 2 必须被 isUnjudged 认出（本例绿，证明常量契约自洽）", judgeExitCodes(selfBlind).status === "passed")

  // ── 实仓：真文件也要过（用例全绿但真仓红 = 判据没接上）──────────────
  const realReadme = (() => {
    try {
      return fs.readFileSync(path.join(REPO, "scripts/gates/README.md"), "utf8")
    } catch {
      return null
    }
  })()
  const readFile = (rel: string) => {
    try {
      return fs.readFileSync(path.join(REPO, rel), "utf8")
    } catch {
      return null
    }
  }
  const real = judgeExitCodes({
    readme: realReadme,
    readers: {
      "scripts/lib/gate-runtime.ts": readFile("scripts/lib/gate-runtime.ts"),
      "scripts/lib/run-gates-verdict.mjs": readFile("scripts/lib/run-gates-verdict.mjs"),
    },
    expectedLine: exitTableLine(),
    codes: EXIT,
  })
  t("实仓：scripts/gates/README.md 与常量当前一致", real.status === "passed",
    real.findings?.map((f) => `${f.file ?? "-"} ${f.detail}`).join("；"))

  const bad = cases.filter((c) => !c[1])
  for (const [n, ok, note] of cases) console.log(`${ok ? "✓" : "✗"} ${n}${ok ? "" : `\n    ↳ ${note ?? "（未给实际值）"}`}`)
  console.log(`\nverify-exit-codes selftest ${cases.length - bad.length}/${cases.length} 通过`)
  return bad.length === 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(run() ? 0 : 1)
}
