/**
 * `verify-spec` 的 spec（ISS-742）。
 * 五类用例：正例 / 四类反例（点名到行号）/ 代码块与行内代码里的同形字样不误报 /
 * 白名单（有效、why 为空）/ 缺输入（无白名单文件仍可判；扫描面为空退 2）。
 */
import { collectHits, judgeSpec, type AllowEntry, type SpecDoc } from "./verify-spec.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const doc = (text: string, path = "docs/sample.md"): SpecDoc => ({ path, text })
const WHY = "存量：本单只建闸不改正文"
const exists = (rel: string) => ["scripts/run-gates.mjs", "scripts/gates/verify-spec.ts"].includes(rel)
const judge = (text: string, allowed: AllowEntry[] | null = []) => judgeSpec({ docs: [doc(text)], allowlist: allowed, exists })
const ruled = (r: ReturnType<typeof judge>, rule: string) => (r.findings ?? []).some((f) => f.detail.includes(`[${rule}]`))

export function run(): boolean {
  fails = 0
  console.log("verify-spec.spec")

  // ---------- 正例 ----------
  {
    const r = judge(
      [
        "# 规范",
        "",
        "判据入口见 `scripts/run-gates.mjs`，本判据自身 `scripts/gates/verify-spec.ts`。",
        "包内脚本 `forge-ui/scripts/build-client.mjs` 不归本判据管。",
        "",
        "### K2a · 别造 god module",
        "**K2a** 只写一次。",
        "",
        "## 变更记录",
        "| 日期 | 内容 |",
      ].join("\n"),
    )
    ok("正例：指针都存在 + 无现状数字 + 编号唯一 + 变更记录在末尾 ⇒ passed", r.status === "passed")
  }

  // ---------- a) 悬空脚本指针 ----------
  {
    const r = judge(["# x", "跑 `node scripts/gone.mjs --check` 即可。"].join("\n"))
    ok("反例 a：悬空脚本指针 ⇒ failed", r.status === "failed" && ruled(r, "悬空脚本指针"))
    ok("反例 a：点名文件与行号", (r.findings ?? []).some((f) => f.file === "docs/sample.md" && f.line === 2))
  }
  {
    const r = judge(["# x", "行内代码里的命令 `bash scripts/run-gates.mjs --tier fast` 存在 ⇒ 不报。"].join("\n"))
    ok("干扰 a：指针存在 ⇒ passed", r.status === "passed")
  }

  // ---------- b) 现状数字句式 ----------
  for (const [text, label] of [
    ["当前 98 个 ISS 号散在正文里。", "当前 N 个"],
    ["已 3 处按此改过。", "已 N 处"],
    ["现在有 2 份实现并存。", "现在有 N"],
    ["共 41 个组件，其中没有 card。", "共 N 个"],
  ] as const) {
    const r = judge(["# x", text].join("\n"))
    ok(`反例 b：${label} ⇒ failed`, r.status === "failed" && ruled(r, "现状数字句式"))
  }
  {
    const r = judge(["# x", "行内代码不算断言：`当前 98 个`；围栏里的也不算：", "```", "当前 98 个", "共 3 个", "```"].join("\n"))
    ok("干扰 b：行内代码 / 围栏代码块里的同形字样不误报", r.status === "passed")
  }

  // ---------- c) 编号重复 ----------
  {
    const r = judge(
      ["# x", "### K2a · 第一条", "### K2a · 又定义一次", "", "### REV-007 · 一", "### REV-007 · 二"].join("\n"),
    )
    ok("反例 c：K 号重复 ⇒ failed", r.status === "failed" && ruled(r, "编号重复"))
    ok("反例 c：REV 号重复 ⇒ failed", (r.findings ?? []).some((f) => f.detail.includes("REV-007")))
  }
  {
    const r = judge(
      [
        "# x",
        "### K9c · 主条",
        "| `K9c` | 例外子表里的同名格：不是第二次定义 |",
        "- **K9a**：主条",
        "正文里引用 K9a / K9c / K2a 多次都不算定义。",
        "K2a 提到三遍，K2a 再提一遍。",
      ].join("\n"),
    )
    ok("干扰 c：子表裸 id + 正文里的重复提及 ⇒ 不算重复定义", r.status === "passed")
  }
  {
    const r = judge(["# x", "| **REV-001** | 定义 |", "| **REV-001** | 重复 |"].join("\n"))
    ok("反例 c：表格里加粗的 REV 号重复 ⇒ failed", r.status === "failed" && ruled(r, "编号重复"))
  }

  // ---------- d) 变更记录之后不得再有正文 ----------
  {
    const r = judge(["# x", "## 变更记录", "| 2026-11-09 | 初版 |", "", "## 12. 附录", "正文"].join("\n"))
    ok("反例 d：「变更记录」之后又有 `## ` ⇒ failed", r.status === "failed" && ruled(r, "变更记录后有正文"))
    ok("反例 d：报的是后出现的那个标题行", (r.findings ?? []).some((f) => f.line === 5))
  }
  {
    const r = judge(["# x", "## 变更记录（续）", "| 2026-11-09 | 追加 |", "## 变更记录（二）", "| 2026-11-10 | 追加 |"].join("\n"))
    ok("干扰 d：标题里含「变更记录」的 `## ` 不报", r.status === "passed")
  }
  {
    const r = judge(["# x", "## 变更记录", "```", "## 不是标题，是代码", "```"].join("\n"))
    ok("干扰 d：围栏代码块里的 `## ` 不算正文标题", r.status === "passed")
  }

  // ---------- 白名单 ----------
  {
    const text = ["# x", "当前 98 个 ISS 号散在正文里。"].join("\n")
    const r = judge(text, [{ file: "docs/sample.md", lineText: "当前 98 个 ISS 号", why: WHY }])
    ok("白名单：命中且 why 非空 ⇒ 放行", r.status === "passed")
  }
  {
    const text = ["# x", "当前 98 个 ISS 号散在正文里。"].join("\n")
    const r = judge(text, [{ file: "docs/sample.md", lineText: "当前 98 个 ISS 号", why: "" }])
    ok("白名单：why 为空 ⇒ 不生效，照红", r.status === "failed")
  }
  {
    const text = ["# x", "当前 98 个 ISS 号散在正文里。"].join("\n")
    const r = judge(text, [{ file: "docs/other.md", lineText: "当前 98 个 ISS 号", why: WHY }])
    ok("白名单：文件不符 ⇒ 不生效，照红", r.status === "failed")
  }

  // ---------- 缺输入 ----------
  {
    const text = ["# x", "共 3 个文件。"].join("\n")
    const r = judge(text, null)
    ok("缺白名单文件（null）≠ 判不了：仍判到违规 ⇒ failed", r.status === "failed")
    const clean = judge("# x\n`scripts/run-gates.mjs` 存在。", null)
    ok("缺白名单文件（null）：干净文档仍判 passed（不退 2）", clean.status === "passed")
  }
  {
    const r = judgeSpec({ docs: [], allowlist: [], exists })
    ok("扫描面为空 ⇒ unjudged + no-corpus（不是绿）", r.status === "unjudged" && r.reason === "no-corpus")
  }

  // ---------- collectHits：行号与规则口径 ----------
  {
    const hits = collectHits([doc("a\n共 2 个\nb")], exists)
    ok("collectHits：报 1 条、规则为 status-number、行号 2", hits.length === 1 && hits[0].rule === "status-number" && hits[0].line === 2)
  }

  // ---------- ISS-852：(a) 三类「不该报」形态 + 三条反向 ----------
  // 一条待建脚本的路径；用它造反例，避免依赖真实仓库文件状态。
  const PENDING = "scripts/w1-not-built-yet.mjs"

  // A 类：上游语境。DSH 大写才认 —— 小写 dsh 是普通词。
  {
    const r = judge(["# x", `**DSH 实测**（\`${PENDING}\`）：`].join("\n"))
    ok("A1：行内含大写 DSH ⇒ 不报（官方引用）", r.status === "passed")
  }
  {
    const r = judge(["# x", `见 \`${PENDING}\`，这是 dsh 这个词。`].join("\n"))
    ok("★反向 3：小写 dsh + 真悬空 ⇒ 仍红（证明没加 i flag）", r.status === "failed" && ruled(r, "悬空脚本指针"))
  }
  // A 类边界：DSH 在表格另一格 ⇒ 不是这条路径的修饰语，不许吞。
  {
    const r = judge(["# x", `| 计数 == DSH 工具数 | \`${PENDING}\` |`].join("\n"))
    ok("A1 边界：DSH 在别的单元格 ⇒ 不算上游语境，照红", r.status === "failed" && ruled(r, "悬空脚本指针"))
  }

  // B 类：两种 HTML 注释形态（必须分别认，互相判不到）。
  {
    const r = judge(["# x", "| 文件头 | `<!-- Generated by " + PENDING + " — do not edit. -->` |"].join("\n"))
    ok("B2a：整条注释在反引号内（字面文本）⇒ 不报", r.status === "passed")
  }
  {
    const r = judge(["# x", "<!-- 由 x 生成——勿手改。", `     运行 \`node ${PENDING}\` 重新生成。`, "     备注。 -->"].join("\n"))
    ok("B2b：注释跨行把路径包住 ⇒ 不报", r.status === "passed")
  }
  {
    const r = judge(["# x", `<!-- 注释 --> 另见 \`${PENDING}\``].join("\n"))
    ok("★B 边界：行内闭合后仍在注释外 ⇒ 照红（状态机不能放宽）", r.status === "failed" && ruled(r, "悬空脚本指针"))
  }

  // C 类：显式标记。
  {
    const r = judge(["# x", `| P1 | 补 \`${PENDING}\`<!-- pending: 待建 --> | 判据 |`].join("\n"))
    ok("C：pending 标记 + 文件不存在 ⇒ 不报", r.status === "passed")
  }
  {
    const r = judge(["# x", `| x | \`scripts/run-gates.ts\`<!-- official: 引官方 --> |`].join("\n"))
    ok("★甲档：official 不豁免悬空指针（标注 ≠ 通行证）", r.status === "failed" && ruled(r, "悬空脚本指针"))
  }
  // ★反向 1：本单核心 —— pending 的文件已建 ⇒ 红（否则标记自己腐坏）。
  {
    const r = judge(["# x", `| x | \`scripts/run-gates.mjs\`<!-- pending: 早该建了 --> |`].join("\n"))
    ok("★反向 1：pending 但文件已存在 ⇒ stale-pending 红", r.status === "failed" && ruled(r, "pending 标记过时"))
    ok("★反向 1：文案点明「已建，摘掉标记」", (r.findings ?? []).some((f) => f.detail.includes("已建") && f.detail.includes("摘掉")))
  }
  // ★反向 2：标记那行没有脚本路径 ⇒ 红。
  {
    const r = judge(["# x", "这一行没有路径<!-- pending: 待建 -->"].join("\n"))
    ok("★反向 2：标记旁无 scripts 路径 ⇒ orphan-marker 红", r.status === "failed" && ruled(r, "标记无落点"))
  }
  {
    const r = judge(["# x", `| x | \`${PENDING}\`<!-- pending: --> |`].join("\n"))
    ok("C 边界：标记理由为空 ⇒ 红（空理由等于没标）", r.status === "failed" && ruled(r, "标记无落点"))
  }
  // ★反向 4：真悬空、无任何标记/语境 ⇒ 仍红（本单没把牙拔掉）。
  {
    const r = judge(["# x", "跑 `scripts/not-exist-abc.ts` 看看。"].join("\n"))
    ok("★反向 4：真悬空无标记 ⇒ 仍红", r.status === "failed" && ruled(r, "悬空脚本指针"))
  }
  // 标记不能自己给自己豁免：理由里写 DSH 不算上游语境。
  {
    const r = judge(["# x", `| x | \`${PENDING}\`<!-- pending: 引 DSH 官方 --> |`].join("\n"))
    ok("标记理由里写 DSH ⇒ 不算上游语境（仍然按 pending 放行，不致自豁免出别的问题）", r.status === "passed")
  }

  // ---------- 审查 F1 / F2 回归（返工补）----------
  // F1：official 曾是无据可查的一句话豁免。必须能被仓内事实证伪。
  {
    const r = judge(["# x", "`scripts/totally-rotten-xyz.ts`<!-- official: 我说它是官方的 -->"].join("\n"))
    ok("★F1：official 指向不存在的路径 ⇒ 红（复审后彻底不豁免）", r.status === "failed" && ruled(r, "悬空脚本指针"))
  }
  {
    const r = judge(["# x", "`scripts/run-gates.mjs`<!-- official: 其实是本仓的 -->"].join("\n"))
    ok("★F1-d：official 指向【已存在】文件 ⇒ stale-official 红，label 与 pending 可区分", r.status === "failed" && ruled(r, "official 标记过时"))
  }
  // F2：标记作用域曾是整行，一条标记吞掉同行所有真腐坏。
  {
    const r = judge(["# x", "`scripts/planned-ok.ts`<!-- pending: 待建 --> 与 `scripts/hidden-rot.ts`"].join("\n"))
    ok("★F2：一行两条、标一条 ⇒ 另一条仍红", r.status === "failed" && ruled(r, "悬空脚本指针"))
    ok("★F2：报的是被吞的那条 hidden-rot", (r.findings ?? []).some((f) => f.detail.includes("hidden-rot")))
  }
  {
    // 标记在引用之前 ⇒ 不是这条的标记，不许豁免。
    const r = judge(["# x", `<!-- pending: 待建 --> \`${PENDING}\``].join("\n"))
    ok("★F2 边界：标记在引用之前 ⇒ 不豁免该引用（只认紧邻其后的标记）", r.status === "failed" && ruled(r, "悬空脚本指针"))
  }
  {
    // 表格两格各一条：标记只作用于本格。
    const r = judge(["# x", `| \`${PENDING}\`<!-- pending: 待建 --> | \`scripts/hidden-rot-2.ts\` |`].join("\n"))
    ok("★F2 边界：表格里标记只救本单元格，邻格真腐坏照红", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("hidden-rot-2")))
  }

  // R-a：between 检查（「标记与引用之间不能再夹别的引用」）必须有独立用例 ——
  // 审查实测把 `const between = false` 后 selftest 仍全绿 = 这条零覆盖。
  {
    const r = judge(["# x", "`scripts/rot-c.ts` 与 `scripts/planned-d.ts`<!-- pending: 待建 -->"].join("\n"))
    ok("★R-a：标记与引用之间夹了别的引用 ⇒ 前一条仍红（不豁免）", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("rot-c")))
    ok("★R-a：紧邻标记的那条被豁免（planned-d 不报）", !(r.findings ?? []).some((f) => f.detail.includes("planned-d")))
  }
  // F1-c：`..` / 绝对路径不许探到仓外。
  {
    const r = judge(["# x", "`scripts/../../outside/scripts/gates/x.ts`<!-- official: x -->"].join("\n"))
    ok("★F1-c：`..` 逃出仓库 ⇒ outside-repo 红（不当成不存在）", r.status === "failed" && ruled(r, "指针逃出仓库"))
  }
  {
    const r = judge(["# x", "`scripts/a/../../scripts/b.ts`"].join("\n"))
    ok("★F1-c：归一后仍在仓内 ⇒ 不报 outside-repo", !(r.findings ?? []).some((f) => f.detail.includes("指针逃出仓库")))
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（正例×1 / 反例×4 类 / 干扰×5 / 白名单×3 / 缺输入×2 / ISS-852×14 / 审查回归×13）")
  return fails === 0
}
