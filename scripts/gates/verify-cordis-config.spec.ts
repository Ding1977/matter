/**
 * `verify-cordis-config` 的 spec（ISS-819）。
 * 四类用例：正例 / 反例（两条规则各一）/ 干扰（注释与 config 子树）/ 缺输入。
 */
import {
  clientHalfFindings,
  expressionProblem,
  isContainerLine,
  judgeCordisConfig,
  keyOf,
  scanMetadataExpressions,
  stripInlineComment,
  type MetadataFinding,
} from "./verify-cordis-config.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const clean: MetadataFinding[] = []

export function run(): boolean {
  fails = 0
  console.log("verify-cordis-config.spec")

  // ── 规则 A 正例：config 子树里的 !!js 合法（Loader 会插值） ──────────────
  {
    const src = [
      "- insert:",
      "    - id: preset-x",
      "      name: '@deepseek-ai/dsh-agent-preset'",
      "      config:",
      "        plugins:",
      "          - id: tool-bash",
      "            disabled: !!js process.platform === 'win32'",
    ].join("\n")
    const r = scanMetadataExpressions("a.yml", src)
    ok("正例：config 子树内的 disabled !!js ⇒ 不报（Loader 插值区）", r.length === 0)
  }

  // ── 规则 A 反例：元数据字段上的 !!js 必须红 ──────────────────────────
  {
    const src = [
      "- insert:",
      "    - id: !!js 'x'",
    ].join("\n")
    const r = scanMetadataExpressions("a.yml", src)
    ok("反例：id 上出现 !!js ⇒ 红", r.length === 1 && r[0].detail.includes("id"))
  }
  {
    const src = [
      "- insert:",
      "    - id: row",
      "      inject: !!js ['a']",
    ].join("\n")
    const r = scanMetadataExpressions("a.yml", src)
    ok("反例：inject 上出现 !!js ⇒ 红（恒真 ⇒ 静默改装配）", r.length === 1 && r[0].detail.includes("inject"))
  }

  // ── 规则 A 反例：disabled 表达式不合法必须红 ─────────────────────────
  {
    const src = [
      "- insert:",
      "    - id: row",
      "      disabled: !!js process.platform ===",
    ].join("\n")
    const r = scanMetadataExpressions("a.yml", src)
    ok("反例：disabled 表达式语法错 ⇒ 红（启动前就炸）", r.length === 1 && r[0].detail.includes("does not parse"))
  }
  ok("disabled 表达式合法 ⇒ 无问题", expressionProblem("process.platform === 'win32'") === null)
  ok("disabled 表达式为空 ⇒ 报出来（不当成合法）", expressionProblem("  ") !== null)

  // ── 反例：config 子树里的 disabled 语法错也必须红（本单实测补的收紧） ──────
  // 官方只校验 entry 级 disabled，config 深处漏了：变异实测「把 config 内某行
  // disabled 写成 `process.platform ====` ⇒ 官方口径不报」。嵌套 entry 的 disabled
  // 同样由 Loader 插值，语法错一样在启动时炸 ⇒ 本判据对该位置同样要求可编译。
  {
    const src = [
      "- insert:",
      "    - id: preset-x",
      "      config:",
      "        plugins:",
      "          - id: tool-bash",
      "            disabled: !!js process.platform ==== 'win32'",
    ].join("\n")
    const r = scanMetadataExpressions("a.yml", src)
    ok("反例：config 子树内 disabled 语法错 ⇒ 红（官方口径漏这一支）", r.length === 1 && r[0].detail.includes("does not parse"))
  }
  {
    // 正例对照：同一位置、表达式合法 ⇒ 绝不报（否则收紧就成了全量误报）
    const src = [
      "- insert:",
      "    - id: preset-x",
      "      config:",
      "        plugins:",
      "          - id: tool-bash",
      "            disabled: !!js process.platform === 'win32'",
    ].join("\n")
    ok("正例对照：config 子树内 disabled 合法 ⇒ 不报", scanMetadataExpressions("a.yml", src).length === 0)
  }
  {
    // preset 的 `config.id` 是数据不是 entry 元数据 ⇒ 不许被 `id` 规则误伤
    const src = [
      "- insert:",
      "    - id: preset-x",
      "      name: '@deepseek-ai/dsh-agent-preset'",
      "      config:",
      "        id: !!js 'matter'",
    ].join("\n")
    ok("正例：config.id 上的 !!js ⇒ 不报（是数据，不是 entry 元数据）", scanMetadataExpressions("a.yml", src).length === 0)
  }

  // ── 干扰：整行注释里的 !!js 不许被当成违规 ──────────────────────────
  {
    const src = [
      "# 历史挂载（已摘除）：",
      "#   - id: !!js 'old'",
      "- insert:",
      "    - id: row",
      "      name: 'x'",
    ].join("\n")
    const r = scanMetadataExpressions("a.yml", src)
    ok("干扰：注释行里的 !!js ⇒ 不报（否则退役件全成违规）", r.length === 0)
  }
  ok("stripInlineComment：剥尾注释", stripInlineComment("id: x # 注释").trim() === "id: x")
  ok("stripInlineComment：引号内的 # 不剥", stripInlineComment("id: 'a #b'").includes("#b"))
  ok("keyOf：`- id: x` ⇒ id", keyOf("- id: x") === "id")
  ok("keyOf：无 key ⇒ null", keyOf("!!js x") === null)
  ok("isContainerLine：`config:` 是容器", isContainerLine("config:"))
  ok("isContainerLine：`id: x` 不是容器", !isContainerLine("id: x"))

  // ── 规则 B：client 两半 ────────────────────────────────────────────
  {
    const r = clientHalfFindings([
      { file: "forge-ok/package.json", exports: { "./client": {} }, dsh: { client: {} } },
      { file: "forge-bad/package.json", exports: { "./client": {} } },
      { file: "forge-bad2/package.json", exports: {}, dsh: { client: {} } },
      { file: "forge-lib/package.json", exports: {} },
    ])
    ok("反例：只有 exports ./client 无 dsh.client ⇒ 红", r.some((f) => f.file === "forge-bad/package.json"))
    ok("反例：只有 dsh.client 无 exports ./client ⇒ 红", r.some((f) => f.file === "forge-bad2/package.json"))
    ok("正例：两半同现 ⇒ 不报", !r.some((f) => f.file === "forge-ok/package.json"))
    ok("正例：都不要 ⇒ 不报（库包不是插件）", !r.some((f) => f.file === "forge-lib/package.json"))
    ok("规则 B 恰好报 2 条（不是把所有包都报一遍）", r.length === 2)
  }

  // ── 缺输入：语料为空 ⇒ unjudged，不许绿 ─────────────────────────────
  {
    const r = judgeCordisConfig({ files: [], metadata: clean, clientHalves: clean })
    ok("缺输入：语料为空 ⇒ unjudged（不是绿）", r.status === "unjudged" && r.reason === "no-corpus")
  }
  {
    const r = judgeCordisConfig({ files: ["a.yml"], metadata: clean, clientHalves: clean })
    ok("正例：语料非空且无违规 ⇒ passed", r.status === "passed")
  }
  {
    const one: MetadataFinding[] = [{ file: "a.yml", line: 3, detail: "x" }]
    const r = judgeCordisConfig({ files: ["a.yml"], metadata: one, clientHalves: clean })
    ok("反例：有违规 ⇒ failed 且带文件行号", r.status === "failed" && r.findings?.[0]?.line === 3)
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（24 条：正例 6 / 反例 7 / 干扰 6 / 缺输入 3 / 工具函数 5，其中 2 条是同一断言的成对正反例）")
  return fails === 0
}
