/**
 * `verify-package-readme` 的 spec（ISS-850 / W0-P0-4）。
 *
 * ## 为什么这一格必须有「必然失败」用例
 *
 * 本判据落地时真实语料是**红的**（新树 2 个包都还没写 README）—— 所以「只验绿」的 spec
 * 根本证明不了任何事。更要紧的是反向：一条把判据放宽成「有 `## Summary` 就行」的实现也会全绿。
 * 所以每条判据都配「该红」的一侧，另加边界值（100 词过 / 101 词红）与语料归零。
 *
 * ## 两层用例
 *
 *   A. **纯函数层**（`judgeOneReadme` / `judgeReadmes`）：构造数据，判四条 + 边界 + 隔离 + 归零。
 *   B. **真实 IO 层**（`readReadmes` 跑临时树）：证明「有 manifest 但没 README 的包不会被静默跳过」。
 *      纯函数看不见这一类 —— 发现器若按「有 README 才算包」筛选，3b 就永远判不出来。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  countWords,
  findH2,
  judgeOneReadme,
  judgeReadmes,
  LIMITATIONS_HEADING,
  MAX_SUMMARY_WORDS,
  readReadmes,
  scanHeadings,
  type ReadmePackage,
} from "./verify-package-readme.ts"

let fails = 0
/** 断言条数**实测累加**，不在结尾手写拆解。 */
let total = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : `\n      ↳ ${extra}`}`)
  if (!cond) fails++
}

const TRIO = ["README.md", "README.zh.md", "README.i18n.yaml"]

/** 一份三条全合规的 README。反例各改一处。 */
const goodReadme = (summary = "A package that stores things.", limits = "- Nothing yet.") =>
  [
    "# @matter/sample",
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Details",
    "",
    "Some details here.",
    "",
    `## ${LIMITATIONS_HEADING}`,
    "",
    limits,
    "",
  ].join("\n")

/** 一个三条全合规的包。 */
const pkg = (dir: string, over: Partial<ReadmePackage> = {}): ReadmePackage => ({
  dir,
  presentFiles: TRIO,
  readme: goodReadme(),
  ...over,
})

/** 有没有某条 finding 的 detail 含这个片段。 */
const hits = (pkgs: ReadmePackage[], needle: string) =>
  (judgeReadmes(pkgs).findings ?? []).some((f) => f.detail.includes(needle))

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-package-readme.spec")

  // ══ A. 纯函数层 ══════════════════════════════════════════════════════════

  // ── 正例 ────────────────────────────────────────────────────────────────
  {
    const r = judgeReadmes([pkg("packages/a/b")])
    ok("正例：三件套齐 + Summary 短 + Limitations 末位 ⇒ passed", r.status === "passed")
    ok("正例：0 finding", (r.findings ?? []).length === 0)
    ok("正例：detail 数出包数并点名口径", (r.detail ?? "").includes("1 个包") && (r.detail ?? "").includes(LIMITATIONS_HEADING))
  }

  // ── ① Summary 边界值：100 词过 / 101 词红（照 DSH countWords 口径）────────
  {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ")
    ok("边界：countWords 口径与 wc -w 一致（3 词）", countWords("a b c") === 3)
    ok("边界：多余空白不计词", countWords("  a   b \n c  ") === 3)
    ok(`边界：恰好 ${MAX_SUMMARY_WORDS} 词 ⇒ 通过`, judgeOneReadme("r.md", goodReadme(words(100))).length === 0)
    const over = judgeOneReadme("r.md", goodReadme(words(101)))
    ok(`边界：${MAX_SUMMARY_WORDS + 1} 词 ⇒ 红（+1 就炸）`, over.length === 1, JSON.stringify(over))
    ok(
      "边界：文案含「现数 / 上限 / 怎么改」三件事",
      /has 101 words/.test(over[0]?.detail ?? "") &&
        /limit is 100/.test(over[0]?.detail ?? "") &&
        (over[0]?.detail ?? "").includes("## Details"),
      over[0]?.detail,
    )
    ok("边界：红带行号（定位到 Summary 那行）", typeof over[0]?.line === "number" && over[0].line > 0)
  }

  // ── ① Summary 缺失 ──────────────────────────────────────────────────────
  {
    const noSummary = [`# t`, "", "## Details", "", "x", "", `## ${LIMITATIONS_HEADING}`, "", "- none"].join("\n")
    const f = judgeOneReadme("r.md", noSummary)
    ok("反例①：缺 Summary ⇒ 红", f.length === 1, JSON.stringify(f))
    ok("反例①：文案点名缺 `## Summary`", (f[0]?.detail ?? "").includes("## Summary"))
  }

  // ── ② Limitations 必须是最后一个 H2 ──────────────────────────────────────
  {
    const misplaced = [
      "# t",
      "",
      "## Summary",
      "",
      "short.",
      "",
      `## ${LIMITATIONS_HEADING}`,
      "",
      "- one limit",
      "",
      "## Details",
      "",
      "after.",
      "",
    ].join("\n")
    const f = judgeOneReadme("r.md", misplaced)
    ok("反例②：Limitations 后面还有 H2 ⇒ 红", f.length === 1, JSON.stringify(f))
    ok(
      "反例②：文案说清「不是最后一个 H2」并点名后面那个",
      (f[0]?.detail ?? "").includes("不是最后一个 H2") && (f[0]?.detail ?? "").includes("Details"),
      f[0]?.detail,
    )
    ok("反例②：文案给出怎么改（移到文档末尾）", (f[0]?.detail ?? "").includes("末尾"))
  }

  // ── ② 段内必须 ≥1 条 `- ` 顶层条目 ───────────────────────────────────────
  {
    const noBullet = [`# t`, "", "## Summary", "", "short.", "", `## ${LIMITATIONS_HEADING}`, "", "Just prose, no bullet.", ""].join("\n")
    const f = judgeOneReadme("r.md", noBullet)
    ok("反例②：段内无 `- ` 条目 ⇒ 红", f.length === 1, JSON.stringify(f))
    ok("反例②：文案要求顶层 `- ` 条目", (f[0]?.detail ?? "").includes("`- `"))

    // 干扰：缩进 bullet 不算顶层（`  - x` 是子项，说明挂在别的东西下面）
    const nested = [`# t`, "", "## Summary", "", "short.", "", `## ${LIMITATIONS_HEADING}`, "", "  - indented only", ""].join("\n")
    ok("反例②：只有缩进 bullet（子项）⇒ 仍红（顶层才算）", judgeOneReadme("r.md", nested).length === 1)
  }

  // ── ② Limitations 缺失 ──────────────────────────────────────────────────
  {
    const none = [`# t`, "", "## Summary", "", "short.", ""].join("\n")
    const f = judgeOneReadme("r.md", none)
    ok("反例②：缺 Limitations 段 ⇒ 红", f.length === 1, JSON.stringify(f))
    ok("反例②：文案点名要逐条列出「现在不能干什么」", (f[0]?.detail ?? "").includes("现在不能干什么"))
  }

  // ── ② 同名段重复 ────────────────────────────────────────────────────────
  {
    const twice = [
      "# t",
      "",
      "## Summary",
      "",
      "short.",
      "",
      `## ${LIMITATIONS_HEADING}`,
      "",
      "- one",
      "",
      "## Details",
      "",
      "x",
      "",
      `## ${LIMITATIONS_HEADING}`,
      "",
      "- two",
      "",
    ].join("\n")
    const f = judgeOneReadme("r.md", twice)
    ok("反例②：Limitations 出现两次 ⇒ 红", f.some((x) => x.detail.includes("出现了 2 次")), JSON.stringify(f))
  }

  // ── ③ 三件套缺件 ────────────────────────────────────────────────────────
  {
    for (const missing of TRIO) {
      const files = TRIO.filter((f) => f !== missing)
      const r = judgeReadmes([pkg("packages/a/b", { presentFiles: files, readme: missing === "README.md" ? null : goodReadme() } as Partial<ReadmePackage>)])
      ok(`反例③：缺 ${missing} ⇒ 红`, r.status === "failed")
      ok(`反例③：文案指出具体缺哪一件（${missing}）`, (r.findings ?? []).some((f) => f.detail.includes(missing)), JSON.stringify(r.findings))
    }
    // 三件全缺 ⇒ 报 3 条（不是「报一条就够了」：修的人要知道补齐几件）
    const none = judgeReadmes([pkg("packages/a/b", { presentFiles: [], readme: null } as Partial<ReadmePackage>)])
    ok("反例③：三件全缺 ⇒ 报 3 条", (none.findings ?? []).length === 3, JSON.stringify(none.findings))
  }

  // ── 3b：有 manifest 就必须有 README.md（**缺失是红，不是跳过**）───────────
  {
    const r = judgeReadmes([pkg("packages/a/b", { presentFiles: [], readme: null } as Partial<ReadmePackage>)])
    ok("3b：有 package.json 却没 README.md ⇒ 红（不是跳过）", r.status === "failed")
    ok(
      "3b：文案明确「缺失是红，不是跳过」",
      (r.findings ?? []).some((f) => f.file === "packages/a/b/README.md" && f.detail.includes("缺失是红，不是跳过")),
      JSON.stringify(r.findings),
    )
    ok("3b：有 README.md 的包不报这一条", !hits([pkg("packages/a/b")], "有 package.json 却没有"))
  }

  // ── 干扰：不该误判 ───────────────────────────────────────────────────────
  {
    // 围栏代码块里的 `## ` 不是标题（假红源）
    const fenced = [
      "# t",
      "",
      "## Summary",
      "",
      "short.",
      "",
      `## ${LIMITATIONS_HEADING}`,
      "",
      "- one",
      "",
      "```sh",
      "## this is a shell comment, not a heading",
      "```",
      "",
    ].join("\n")
    const heads = scanHeadings(fenced)
    ok("干扰：围栏内的 `## ` 不算标题（不造成假红）", !heads.some((h) => h.title.includes("shell comment")), JSON.stringify(heads.map((h) => h.title)))
    ok("干扰：含代码块的合规 README ⇒ 判绿", judgeOneReadme("r.md", fenced).length === 0, JSON.stringify(judgeOneReadme("r.md", fenced)))

    // 标题必须逐字：变体要红
    const variant = [`# t`, "", "## Summary", "", "short.", "", "## Known Limitations", "", "- x", ""].join("\n")
    ok("干扰：标题变体（Known Limitations）不认 ⇒ 红（逐字口径）", judgeOneReadme("r.md", variant).length === 1)

    // 段内 `### 子标题` 不该把段算结束（与 DSH 的 h2Body 有意偏离，见文件头）
    const subhead = [
      "# t",
      "",
      "## Summary",
      "",
      "short.",
      "",
      "### Sub",
      "",
      "still summary?",
      "",
      `## ${LIMITATIONS_HEADING}`,
      "",
      "- one",
      "",
    ].join("\n")
    const h = findH2(scanHeadings(subhead), "Summary")
    ok("干扰：Summary 段被 `### 子标题` 收住（段内边界=任意级标题）", h !== undefined && !h.body.includes("still summary?"), h?.body)
    // 该文档三条全过：子标题只是把 Summary 截短了，不影响任何判据
    ok("干扰：含 `### 子标题` 的合规文档 ⇒ 判绿", judgeOneReadme("r.md", subhead).length === 0, JSON.stringify(judgeOneReadme("r.md", subhead)))

    // 文件读不出（undefined）⇒ 按红，不当「没有这个文件」
    const unreadable = judgeReadmes([pkg("packages/a/b", { readme: undefined } as Partial<ReadmePackage>)])
    ok("干扰：README 读不出 ⇒ 红（按红处理，不静默跳过）", unreadable.status === "failed")
    ok("干扰：读不出时文案说清是按红处理", (unreadable.findings ?? []).some((f) => f.detail.includes("按红处理")))
  }

  // ── 多包聚合隔离：一个包坏不许连坐另一个 ─────────────────────────────────
  {
    const r = judgeReadmes([
      pkg("packages/ok/ok"),
      pkg("packages/bad/bad", { presentFiles: [], readme: null } as Partial<ReadmePackage>),
    ])
    ok("聚合：2 个包中 1 个坏 ⇒ 只报坏的那个（3 条）", (r.findings ?? []).length === 3, JSON.stringify(r.findings))
    ok("聚合：所有 finding 都指向坏包", (r.findings ?? []).every((f) => f.file?.startsWith("packages/bad/bad/")), JSON.stringify(r.findings))
  }

  // ── ⛔ 语料归零：必须炸，不许绿 ────────────────────────────────────────────
  {
    const r = judgeReadmes([])
    ok("语料归零：0 个有 manifest 的包 ⇒ unjudged（不是 passed）", r.status === "unjudged")
    ok("语料归零：status 严格不等于 passed（必然失败用例）", r.status !== "passed")
    ok("语料归零：理由码是 no-corpus", r.reason === "no-corpus")
    ok("语料归零：detail 说明「0 个有 manifest 的包」", (r.detail ?? "").includes("0 个有 manifest 的包"))
  }

  // ══ B. 真实 IO 层 ════════════════════════════════════════════════════════
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-readme-io-"))
    try {
      const write = (rel: string, body: string) => {
        const p = path.join(root, rel)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, body)
      }
      // 一个全合规的包
      write("packages/a/b/package.json", '{"name":"@matter/a-b"}')
      for (const f of TRIO) write(`packages/a/b/${f}`, f === "README.md" ? goodReadme() : "x")
      // 一个有 manifest 但一个 README 都没有的包（3b 的关键语料）
      write("packages/c/d/package.json", '{"name":"@matter/c-d"}')
      // 干扰：没有 manifest 的目录不算包（不在 3b 射程）
      write("packages/e/f/README.md", goodReadme())

      const pkgs = readReadmes(root)
      ok("发现器：只收有 package.json 的包（2 个）", pkgs.length === 2, JSON.stringify(pkgs.map((p) => p.dir)))
      ok("★发现器：没 README 但有 manifest 的包**仍在语料里**", pkgs.some((p) => p.dir === "packages/c/d"), JSON.stringify(pkgs.map((p) => p.dir)))
      ok("发现器：没有 manifest 的目录不进语料（不在 3b 射程）", !pkgs.some((p) => p.dir === "packages/e/f"))
      ok("发现器：结果有序", JSON.stringify(pkgs.map((p) => p.dir)) === JSON.stringify([...pkgs.map((p) => p.dir)].sort()))

      const cd = pkgs.find((p) => p.dir === "packages/c/d")
      ok("发现器：没 README 时 readme === null（不是 undefined/空串）", cd?.readme === null, String(cd?.readme))
      ok("发现器：列出实际存在的文件（无 README ⇒ 三件套全缺）", cd?.presentFiles.length === 1 && cd.presentFiles[0] === "package.json")

      const r = judgeReadmes(pkgs)
      ok("端到端：真实树 1 好 1 坏 ⇒ failed", r.status === "failed")
      ok("端到端：坏的那包报 3 条（README.md + 两件）", (r.findings ?? []).length === 3, JSON.stringify(r.findings))
      ok("端到端：好的那包一条都不报", !(r.findings ?? []).some((f) => f.file?.startsWith("packages/a/b/")))

      // 补齐三件套 ⇒ 绿（证明它不是恒红）
      for (const f of TRIO) write(`packages/c/d/${f}`, f === "README.md" ? goodReadme() : "x")
      ok("端到端变异：补齐三件套 ⇒ 绿", judgeReadmes(readReadmes(root)).status === "passed")

      // 再塞 101 词进 Summary ⇒ 绿变红
      const long = goodReadme(Array.from({ length: 101 }, (_, i) => `w${i + 1}`).join(" "))
      write("packages/c/d/README.md", long)
      const over = judgeReadmes(readReadmes(root))
      ok("端到端变异：Summary 塞 101 词 ⇒ 绿变红", over.status === "failed", JSON.stringify(over.findings))
      ok("端到端变异：文案含现数 101 与上限 100", (over.findings ?? []).some((f) => /101 words/.test(f.detail) && /limit is 100/.test(f.detail)))

      // 删掉 README.zh.md ⇒ 指出缺这一件
      fs.rmSync(path.join(root, "packages/c/d/README.zh.md"))
      write("packages/c/d/README.md", goodReadme())
      const gone = judgeReadmes(readReadmes(root))
      ok("端到端变异：删 README.zh.md ⇒ 红", gone.status === "failed")
      ok("端到端变异：指出缺 README.zh.md", (gone.findings ?? []).some((f) => f.detail.includes("README.zh.md")), JSON.stringify(gone.findings))

      // 语料归零（真实 IO）：0 个 manifest
      fs.rmSync(path.join(root, "packages"), { recursive: true, force: true })
      const empty = judgeReadmes(readReadmes(root))
      ok("真实 IO 语料归零 ⇒ unjudged（不是 passed）", empty.status === "unjudged")
      ok("真实 IO 语料归零：理由码 no-corpus", empty.reason === "no-corpus")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ── 反向控制：判定力直证（同一份语料，只改一处 ⇐ 绿→红）────────────────
  {
    ok("反向控制：干净语料先绿（基线）", judgeReadmes([pkg("packages/a/b")]).status === "passed")
    const mutated = judgeReadmes([pkg("packages/a/b", { presentFiles: ["README.md", "README.i18n.yaml"], readme: goodReadme() } as Partial<ReadmePackage>)])
    ok("反向控制：只抽掉 README.zh.md ⇒ 立刻红（判据有判别力）", mutated.status === "failed")
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立（共 ${total} 条断言）`
      : `✓ spec 全过（${total} 条断言：Summary 边界 100/101 + 两条判据各自缺失/位置/变体 + 三件套逐件 + 3b + 围栏/子标题/读不出干扰 + 聚合隔离 + 语料归零 + 真实 IO 发现器 + 反向控制）`,
  )
  return fails === 0
}
