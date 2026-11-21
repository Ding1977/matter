/**
 * `lint-complexity` 的 spec（ISS-841）。
 *
 * 四类用例（同 `verify-file-size.spec.ts` 的口径）：正例 / 反例 / 干扰（边界）/ 缺输入。
 * 另有两条**真跑 oxlint** 的端到端用例 —— 纯函数用例证明「判定逻辑对」，
 * 端到端用例证明「oxlint 那条规则真的在我配的阈值上报」。
 *
 * ⚠️ 端到端用例找不到 oxlint 时**跳过并说明**，不冒充通过：自检里一条假绿比一条红更坏。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  CANONICAL,
  collectCorpus,
  findOxlint,
  judgeComplexity,
  parseDiagnostics,
  readThresholds,
  ruleOf,
  thresholdDrift,
  type Diagnostic,
  type Thresholds,
} from "./lint-complexity.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const th = (over: Partial<Thresholds> = {}): Thresholds => ({ ...CANONICAL, ...over })

const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  file: "packages/g/a.ts",
  line: 1,
  rule: "max-depth",
  message: "Blocks are nested too deeply (5). Maximum allowed is 4.",
  ...over,
})

/** oxlint `-f json` 的真实输出形状（字段取自 1.76.0 实测输出，不是猜的）。 */
const OX_JSON = (items: Array<{ code?: string; filename: string; message: string; line?: number }>) =>
  JSON.stringify({
    diagnostics: items.map((i) => ({
      ...(i.code ? { code: i.code } : {}),
      severity: "error",
      message: i.message,
      filename: i.filename,
      labels: i.line ? [{ span: { offset: 0, length: 1, line: i.line, column: 1 } }] : [],
    })),
    number_of_files: 1,
    number_of_rules: 3,
  })

export function run(): boolean {
  fails = 0
  console.log("lint-complexity.spec")

  // ── 正例 ──────────────────────────────────────────────────────────────────
  {
    const r = judgeComplexity(["packages/g/a.ts"], th(), [])
    ok("正例：有语料 + 0 条诊断 ⇒ passed", r.status === "passed")
    ok("正例：detail 报出三个阈值（读者不用翻配置）", /≤100/.test(r.detail ?? "") && /≤4/.test(r.detail ?? "") && /≤15/.test(r.detail ?? ""))
  }

  // ── 反例 ──────────────────────────────────────────────────────────────────
  {
    const r = judgeComplexity(["packages/g/a.ts"], th(), [diag()])
    ok("反例：1 条 max-depth ⇒ failed", r.status === "failed" && (r.findings ?? []).length === 1)
    ok("反例：finding 给出文件名", (r.findings ?? [])[0]?.file === "packages/g/a.ts")
    ok("反例：finding 保留行号", (r.findings ?? [])[0]?.line === 1)
  }
  {
    const r = judgeComplexity(["packages/g/a.ts"], th(), [diag({ rule: "max-lines-per-function", message: "The function `x` has too many lines (122). Maximum allowed is 100." })])
    ok("反例：函数行数超限 ⇒ failed", r.status === "failed" && (r.findings ?? [])[0]?.detail.includes("122"))
  }
  {
    const r = judgeComplexity(["packages/g/a.ts"], th(), [diag({ rule: "complexity", message: "function `x` has a complexity of 19. Maximum allowed is 15." })])
    ok("反例：圈复杂度超限 ⇒ failed", r.status === "failed" && (r.findings ?? [])[0]?.detail.includes("19"))
  }
  {
    // 解析错误与「太复杂」是两件事：红都红，但 detail 要点明有几条是「根本没判成」。
    const r = judgeComplexity(["packages/g/a.ts"], th(), [diag({ rule: "parse-error", message: "Expected `:` but found `decimal`" })])
    ok("反例：解析错误 ⇒ failed（不是绿：解析不了没有复杂度可言）", r.status === "failed")
    ok("反例：解析错误在 detail 里单独点明", /1 条是解析错误/.test(r.detail ?? ""))
  }

  // ── 干扰 / 边界 ────────────────────────────────────────────────────────────
  {
    const r = judgeComplexity(["packages/g/a.ts"], th({ maxDepth: 3 }), [])
    ok("干扰：阈值被改（maxDepth 4→3）⇒ unjudged（配置被改过，不按新数判）", r.status === "unjudged" && r.reason === "no-rule-table")
  }
  {
    const r = judgeComplexity(["packages/g/a.ts"], th({ maxLinesPerFunction: 200 }), [])
    ok("干扰：有人把 100 改成 200 ⇒ unjudged 且点名是哪一项", r.status === "unjudged" && (r.detail ?? "").includes("maxLinesPerFunction"))
  }
  {
    const r = judgeComplexity(["packages/g/a.ts"], th({ complexity: 16 }), [])
    ok("干扰：complexity 15→16 ⇒ unjudged", r.status === "unjudged")
  }

  // ── 缺输入：三种「判不了」必须分清，且都不是绿 ──────────────────────────────
  {
    const r = judgeComplexity([], th(), [])
    ok("缺输入：0 个文件 ⇒ unjudged(no-corpus)，**不是绿**", r.status === "unjudged" && r.reason === "no-corpus")
  }
  {
    const r = judgeComplexity(["packages/g/a.ts"], null, [])
    ok("缺输入：阈值读不到 ⇒ unjudged(no-rule-table)", r.status === "unjudged" && r.reason === "no-rule-table")
  }
  {
    const r = judgeComplexity(["packages/g/a.ts"], th(), null)
    ok("缺输入：诊断拿不到 ⇒ unjudged(no-binary)", r.status === "unjudged" && r.reason === "no-binary")
  }
  {
    const r = judgeComplexity(["packages/g/a.ts"], th(), [diag(), diag({ rule: "complexity" })])
    ok("多条：2 条诊断 ⇒ failed 且条数 = 2", r.status === "failed" && (r.findings ?? []).length === 2)
  }

  // ── 纯函数单元 ────────────────────────────────────────────────────────────
  ok("ruleOf：eslint(max-depth) → max-depth", ruleOf("eslint(max-depth)") === "max-depth")
  ok("ruleOf：无 code（解析错误）→ parse-error", ruleOf(undefined) === "parse-error")
  ok("ruleOf：非 eslint 前缀（typescript(x)）→ x", ruleOf("typescript(no-floating-promises)") === "no-floating-promises")

  {
    const parsed = parseDiagnostics(OX_JSON([{ code: "eslint(max-depth)", filename: path.join(REPO, "packages/g/a.ts"), message: "深度超限", line: 7 }]))
    ok("parseDiagnostics：真形状可解析", parsed !== null && parsed.length === 1)
    ok("parseDiagnostics：绝对路径 → 仓内相对路径", parsed?.[0]?.file === "packages/g/a.ts")
    ok("parseDiagnostics：行号取到", parsed?.[0]?.line === 7)
  }
  {
    const parsed = parseDiagnostics(OX_JSON([{ filename: path.join(REPO, "packages/g/a.ts"), message: "Expected `:` but found `decimal`" }]))
    ok("parseDiagnostics：无 code ⇒ rule=parse-error", parsed?.[0]?.rule === "parse-error")
  }
  ok("parseDiagnostics：非 JSON（oxlint 空语料的「No files found」）⇒ null，不冒充空诊断", parseDiagnostics("No files found to lint.") === null)
  ok("parseDiagnostics：合法 JSON 但没有 diagnostics 字段 ⇒ null", parseDiagnostics('{"foo":1}') === null)

  {
    const t = readThresholds('{ "rules": { "max-depth": ["error", 4], "complexity": ["error", 15], "max-lines-per-function": ["error", 100] } }')
    ok("readThresholds：三条齐 ⇒ 数值正确", t?.maxDepth === 4 && t.complexity === 15 && t.maxLinesPerFunction === 100)
    ok("readThresholds：与 CANONICAL 无漂移", t !== null && thresholdDrift(t).length === 0)
  }
  ok(
    "readThresholds：缺一条规则 ⇒ null（不猜默认值）",
    readThresholds('{ "rules": { "max-depth": ["error", 4] } }') === null,
  )
  ok(
    "readThresholds：值不是正整数 ⇒ null",
    readThresholds('{ "rules": { "max-depth": ["error", 4], "complexity": ["error", 0], "max-lines-per-function": ["error", 100] } }') === null,
  )
  ok("readThresholds：坏 JSON ⇒ null", readThresholds("{ bad json") === null)
  ok("readThresholds：允许行首 // 注释（配置是 JSONC）", readThresholds('// 注释\n{ "rules": { "max-depth": ["error", 4], "complexity": ["error", 15], "max-lines-per-function": ["error", 100] } }') !== null)
  ok("thresholdDrift：一致 ⇒ 空", thresholdDrift(th()).length === 0)
  ok("thresholdDrift：不一致 ⇒ 非空", thresholdDrift(th({ maxDepth: 9 })).length === 1)

  // ── 端到端：磁盘上的配置本身合法（否则整条判据在生产里恒 unjudged）───────────
  {
    const cfgPath = path.join(REPO, ".oxlintrc.next.json")
    const exists = fs.existsSync(cfgPath)
    ok(".oxlintrc.next.json 在盘上", exists)
    if (exists) {
      const t = readThresholds(fs.readFileSync(cfgPath, "utf8"))
      ok("磁盘配置的阈值 = CANONICAL（改阈值不许只改一处）", t !== null && thresholdDrift(t).length === 0)
    }
  }

  // ── 端到端：真语料 + 真 oxlint（找不到二进制时明说跳过）──────────────────────
  {
    const bin = findOxlint(REPO)
    if (!bin) {
      console.log("  ⚠ 跳过端到端用例：找不到 oxlint 二进制（本机没装 ⇒ 生产里这会判 unjudged(no-binary)）")
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lint-complexity-spec-"))
      try {
        // 13 层嵌套 + 120 行函数 —— 工单指定的两个必红形态
        const deep = ["export function deepNest(x: number): number {"]
        for (let i = 0; i < 13; i++) deep.push("  ".repeat(i + 1) + "if (x > 0) {")
        deep.push("  ".repeat(14) + "return x")
        for (let i = 13; i > 0; i--) deep.push("  ".repeat(i) + "}")
        deep.push("  return 0", "}")
        fs.writeFileSync(path.join(tmp, "deep.ts"), deep.join("\n") + "\n")

        const long = ["export function hundredTwenty(): number {", "  let v = 0"]
        for (let i = 0; i < 118; i++) long.push(`  v += ${i}`)
        long.push("  return v", "}")
        fs.writeFileSync(path.join(tmp, "long.ts"), long.join("\n") + "\n")

        const runOn = (files: string[]): Diagnostic[] | null => {
          const r = spawnSync(bin, ["-c", path.join(REPO, ".oxlintrc.next.json"), "--format=json", ...files], {
            cwd: tmp,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          })
          return parseDiagnostics(r.stdout ?? "", tmp)
        }

        // 合规对照组：写在同一个 tmp 里，证明上面两条红是**规则命中**而不是「tmp 里什么都判红」。
        fs.writeFileSync(
          path.join(tmp, "ok.ts"),
          "export function add(a: number, b: number): number {\n  return a + b\n}\n\n" +
            "export function classify(n: number): string {\n  if (n < 0) return \"neg\"\n  if (n === 0) return \"zero\"\n  return \"pos\"\n}\n",
        )

        const reds = runOn(["deep.ts", "long.ts"])
        ok("端到端：oxlint 输出可解析", reds !== null)
        const rules = new Set((reds ?? []).map((d) => d.rule))
        ok("端到端：13 层嵌套 ⇒ max-depth 报出", rules.has("max-depth"))
        ok("端到端：120 行函数 ⇒ max-lines-per-function 报出", rules.has("max-lines-per-function"))

        const green = judgeComplexity(["packages/g/ok.ts"], th(), runOn(["ok.ts"]))
        ok("端到端：合规文件 ⇒ passed（反例不是靠恒红）", green.status === "passed")

        const red = judgeComplexity(["packages/g/deep.ts"], th(), reds)
        ok("端到端：造坏语料 ⇒ failed", red.status === "failed")
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    }
  }

  // ── collectCorpus：射程本身的定义 ─────────────────────────────────────────
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lint-complexity-corpus-"))
    try {
      fs.mkdirSync(path.join(tmp, "packages/g/p"), { recursive: true })
      fs.writeFileSync(path.join(tmp, "packages/g/p/a.ts"), "export const a = 1\n")
      fs.writeFileSync(path.join(tmp, "packages/g/p/b.tsx"), "export const B = () => null\n")
      fs.writeFileSync(path.join(tmp, "packages/g/p/c.js"), "export const c = 1\n")
      fs.mkdirSync(path.join(tmp, "packages/g/p/dist"), { recursive: true })
      fs.writeFileSync(path.join(tmp, "packages/g/p/dist/d.ts"), "export const d = 1\n")
      fs.mkdirSync(path.join(tmp, "packages/g/p/node_modules"), { recursive: true })
      fs.writeFileSync(path.join(tmp, "packages/g/p/node_modules/e.ts"), "export const e = 1\n")
      const got = collectCorpus(tmp)
      ok("collectCorpus：收 .ts", got.includes("packages/g/p/a.ts"))
      ok("collectCorpus：收 .tsx", got.includes("packages/g/p/b.tsx"))
      ok("collectCorpus：不收 .js", !got.some((f) => f.endsWith(".js")))
      ok("collectCorpus：不收 dist/", !got.some((f) => f.includes("/dist/")))
      ok("collectCorpus：不收 node_modules/", !got.some((f) => f.includes("/node_modules/")))
      ok("collectCorpus：结果已排序（批处理时顺序稳定）", JSON.stringify(got) === JSON.stringify([...got].sort()))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    ok("collectCorpus：packages/ 不存在 ⇒ 空数组（不是抛错）", collectCorpus(path.join(os.tmpdir(), "__no_such_repo__")).length === 0)
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过")
  return fails === 0
}
