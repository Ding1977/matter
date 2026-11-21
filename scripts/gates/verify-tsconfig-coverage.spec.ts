/**
 * `verify-tsconfig-coverage` 的 spec（ISS-850 / W0-P0-4）。
 *
 * ## 为什么这一格必须有「必然失败」用例
 *
 * 本判据封的是**静默跳过**：包不在图里 ⇒ `tsc -b` 绿、`lib/` 不存在、屏幕上什么都没有。
 * 一条只验「合法语料判绿」的 spec 与**把判据删掉的版本**给出完全相同的结果 ——
 * 它证明不了任何事。所以每个方向都配一条「必须红」的断言，外加一条语料归零的
 * （断言 `status === "unjudged"`，**不是** `"passed"`）。
 *
 * ## 两层用例（缺一层就有一族形态没人盯）
 *
 *   A. **纯函数层**（`judgeCoverage`）：喂构造数据，判两个方向 + 隔离 + 边界 + 语料归零。
 *   B. **真实 IO 层**（`scanOnDisk` / `scanGraph` 跑临时树）：纯函数看不见「发现器漏了包」
 *      与「解图没跟间接」这两类错 —— 而它们恰恰是本判据的**核心射程**。
 *      实测过的教训：只测纯函数时，把 `scanGraph` 的递归删掉（不跟间接）仍然全绿。
 *
 * ⛔ 反例必须点名**具体哪一条**报红（文件 + 期望 + 实际 + 怎么改），不许只断 `status === "failed"`。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { judgeCoverage, loadTsFor, readCoverage, scanOnDisk, scanGraph, MAX_DEPTH, type CoverageInput } from "./verify-tsconfig-coverage.ts"

let fails = 0
/** 断言条数**实测累加**，不在结尾手写拆解 —— 手写的数会和实际脱节。 */
let total = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : `\n      ↳ ${extra}`}`)
  if (!cond) fails++
}

/** 有没有某条 finding 的 detail 含这个片段。 */
const hits = (input: CoverageInput, needle: string) =>
  (judgeCoverage(input).findings ?? []).some((f) => f.detail.includes(needle))

/** 临时树骨架：写文件即建目录。 */
function tmpTree(prefix: string): { root: string; write: (rel: string, body: string) => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const write = (rel: string, body: string) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return { root, write }
}

/** 一份最小的包级 tsconfig（真实形态：extends 基座、无 references）。 */
const PKG_TSCONFIG = '{ "extends": "../../../tsconfig.base.emit.json", "include": ["src/**/*.ts"] }'

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-tsconfig-coverage.spec")

  // ══ A. 纯函数层 ══════════════════════════════════════════════════════════

  // ── 正例 ────────────────────────────────────────────────────────────────
  {
    const r = judgeCoverage({ onDisk: ["packages/a/b", "packages/c/d"], inGraph: ["packages/a/b", "packages/c/d"] })
    ok("正例：盘上两个包、图里两个包 ⇒ passed", r.status === "passed")
    ok("正例：0 finding", (r.findings ?? []).length === 0)
    ok("正例：detail 数出包数并点名聚合入口", (r.detail ?? "").includes("2 个") && (r.detail ?? "").includes("tsconfig.next.json"))
  }

  // ── 反例①：盘上有、图里没有（陷阱③本体）────────────────────────────────
  {
    const input: CoverageInput = { onDisk: ["packages/a/b", "packages/kb/blocks"], inGraph: ["packages/a/b"] }
    const r = judgeCoverage(input)
    ok("反例①：盘上有包但图里没有 ⇒ failed", r.status === "failed")
    ok("反例①：只报 1 条（不连坐已登记的那个包）", (r.findings ?? []).length === 1)
    const f = (r.findings ?? [])[0]
    ok("反例①：file 指到漏登记的那个包的 tsconfig", f?.file === "packages/kb/blocks/tsconfig.json")
    ok(
      "反例①：文案说清「不会被 tsc -b 编译 / 类型错永远不会被看见」",
      (f?.detail ?? "").includes("不会被 tsc -b 编译") && (f?.detail ?? "").includes("永远不会被看见"),
      f?.detail,
    )
    ok("反例①：文案给出怎么改（references 补 path）", (f?.detail ?? "").includes("references") && (f?.detail ?? "").includes(`"path"`))
  }

  // ── 反例②：图里有、盘上没有（悬空 reference）──────────────────────────────
  {
    const input: CoverageInput = { onDisk: ["packages/a/b"], inGraph: ["packages/a/b"], dangling: ["packages/gone/pkg"] }
    const r = judgeCoverage(input)
    ok("反例②：悬空 reference ⇒ failed", r.status === "failed")
    ok("反例②：只报 1 条", (r.findings ?? []).length === 1)
    ok("反例②：文案含「悬空 reference」与该路径", hits(input, "悬空 reference") && hits(input, "packages/gone/pkg"))
    ok("反例②：文案说清怎么改（删那条 reference 或把包补回来）", hits(input, "删掉那条 reference"))
    ok("反例②：file 指到那个不存在的 tsconfig", (r.findings ?? [])[0]?.file === "packages/gone/pkg/tsconfig.json")
  }

  // ── 两方向同时坏：两条都报，互不吞掉 ──────────────────────────────────────
  {
    const r = judgeCoverage({
      onDisk: ["packages/a/b", "packages/new/pkg"],
      inGraph: ["packages/a/b"],
      dangling: ["packages/gone/pkg"],
    })
    ok("两方向同时坏 ⇒ 报 2 条（漏登记 1 + 悬空 1）", (r.findings ?? []).length === 2)
    ok("两方向同时坏：两类文案都在", hits({ onDisk: ["packages/new/pkg"], inGraph: [], dangling: [] }, "不会") &&
      hits({ onDisk: ["x/y"], inGraph: [], dangling: ["gone/z"] }, "悬空"))
  }

  // ── 干扰：不误判 ─────────────────────────────────────────────────────────
  {
    // 路径归一：`./` 前缀与尾斜杠不该造成假红（references 里两种写法都常见）
    const r = judgeCoverage({ onDisk: ["./packages/a/b/"], inGraph: ["packages/a/b"] })
    ok("归一：`./x/` 与 `x` 视为同一目录（不假红）", r.status === "passed", JSON.stringify(r.findings))

    // 深层包名（组名/包名不同）不该因为「看起来不像包」被跳过
    const deep = judgeCoverage({ onDisk: ["packages/very-long-group/very-long-pkg"], inGraph: ["packages/very-long-group/very-long-pkg"] })
    ok("归一：长组名/长包名照判绿", deep.status === "passed")

    // dangling 省略 = 无悬空（spec 两个字段构造法成立，不许因缺字段炸）
    const noDangling = judgeCoverage({ onDisk: ["packages/a/b"], inGraph: ["packages/a/b"] })
    ok("干扰：省略 dangling 字段 ⇒ 正常判绿（不炸）", noDangling.status === "passed")
  }

  // ── ⛔ 语料归零：必须炸，不许绿 ────────────────────────────────────────────
  {
    const r = judgeCoverage({ onDisk: [], inGraph: [] })
    ok("语料归零：0 个包级 tsconfig ⇒ unjudged（不是 passed）", r.status === "unjudged")
    ok("语料归零：status 严格不等于 passed（必然失败用例）", r.status !== "passed")
    ok("语料归零：理由码是 no-corpus", r.reason === "no-corpus")
    ok("语料归零：detail 说明「0 个包级 tsconfig」", (r.detail ?? "").includes("0 个包级 tsconfig"))
    // 空盘但图非空：仍然判不了（不是「图里有东西就算判过」）
    const r2 = judgeCoverage({ onDisk: [], inGraph: ["packages/a/b"] })
    ok("语料归零：盘空图非空也 unjudged（不当绿）", r2.status === "unjudged")
  }

  // ══ B. 真实 IO 层（发现器 + 解图）════════════════════════════════════════
  // 纯函数看不见「发现器漏包」与「解图不跟间接」—— 本判据的核心射程在这里。
  {
    const { root, write } = tmpTree("tsconfig-coverage-io-")
    try {
      write("packages/a/b/tsconfig.json", PKG_TSCONFIG)
      write("packages/c/d/tsconfig.json", PKG_TSCONFIG)
      // 已删的包，但盘上目录还在、只有 manifest（没有 tsconfig.json）⇒ **不该**进语料
      write("packages/e/f/package.json", '{"name":"@matter/e-f"}')
      // 干扰：点目录 / node_modules 里的 tsconfig 不该被当包
      write("packages/a/.hidden/tsconfig.json", PKG_TSCONFIG)
      write("packages/a/node_modules/x/tsconfig.json", PKG_TSCONFIG)

      const onDisk = scanOnDisk(root)
      ok(
        "发现器：只认 packages/<g>/<p>/tsconfig.json（2 个）",
        onDisk.length === 2 && onDisk.includes("packages/a/b") && onDisk.includes("packages/c/d"),
        JSON.stringify(onDisk),
      )
      ok("发现器：有 package.json 但没 tsconfig.json 的包不进语料", !onDisk.some((d) => d === "packages/e/f"))
      ok("发现器：点目录不进语料", !onDisk.some((d) => d.includes(".hidden")))
      ok("发现器：node_modules 不进语料", !onDisk.some((d) => d.includes("node_modules")))
      ok("发现器：结果有序（报告稳定、diff 可读）", JSON.stringify(onDisk) === JSON.stringify([...onDisk].sort()))

      // 解图：入口只引用 a/b；a/b 的包级 tsconfig 间接引用 c/d ⇒ c/d 必须算进图
      write("tsconfig.next.json", '{ "include": [], "references": [{ "path": "./packages/a/b" }] }')
      write(
        "packages/a/b/tsconfig.json",
        '{ "extends": "../../../tsconfig.base.emit.json", "include": ["src/**/*.ts"], "references": [{ "path": "../../c/d" }] }',
      )
      const ts = loadTsFor(root)
      ok("解图：typescript 能加载（候选表在真实树上有效）", ts !== null)
      if (ts) {
        const g = scanGraph(root, ts)
        ok("解图：入口直接引用的包在图里", g.inGraph.includes("packages/a/b"), JSON.stringify(g.inGraph))
        ok("★解图：**间接**引用的包也在图里（本判据的「含间接」射程）", g.inGraph.includes("packages/c/d"), JSON.stringify(g.inGraph))
        ok("解图：无悬空项", g.dangling.length === 0, JSON.stringify(g.dangling))
        ok("解图：无解析错误", g.errors.length === 0, JSON.stringify(g.errors))
        // 这一支把两层接上：同一棵树上 judgeCoverage 必须判绿
        ok("端到端：临时树三层齐全 ⇒ readCoverage passed", readCoverage(root).status === "passed")
      }

      // ── 反向：删掉间接引用 ⇒ 同一个 c/d 立刻变成「盘上有、图里没有」──────
      write("packages/a/b/tsconfig.json", PKG_TSCONFIG)
      const after = readCoverage(root)
      ok("端到端变异：摘掉间接引用 ⇒ 绿变红", after.status === "failed", JSON.stringify(after.findings))
      ok(
        "端到端变异：红的文案点名 c/d 且说清后果",
        (after.findings ?? []).some((f) => f.file === "packages/c/d/tsconfig.json" && f.detail.includes("永远不会被看见")),
        JSON.stringify(after.findings),
      )

      // ── 悬空（真实 IO）：入口留一个已删包的 path ──────────────────────────
      write("tsconfig.next.json", '{ "include": [], "references": [{ "path": "./packages/a/b" }, { "path": "./packages/kb/blocks" }] }')
      const dang = readCoverage(root)
      ok("端到端变异：悬空 reference ⇒ 红", dang.status === "failed")
      ok(
        "端到端变异：悬空文案含「悬空 reference」与该路径",
        (dang.findings ?? []).some((f) => f.detail.includes("悬空 reference") && f.detail.includes("packages/kb/blocks")),
        JSON.stringify(dang.findings),
      )

      // ── 坏 JSONC：按红处理，不许静默跳过 ─────────────────────────────────
      write("tsconfig.next.json", "{ this is not json ")
      const bad = readCoverage(root)
      ok("坏 JSONC ⇒ failed（不静默跳过、不冒充绿）", bad.status === "failed", JSON.stringify(bad.findings))
      ok("坏 JSONC：文案说清是 JSONC 解析失败", (bad.findings ?? []).some((f) => f.detail.includes("JSONC")))

      // ── 聚合入口缺席：判不了，不许绿 ─────────────────────────────────────
      fs.rmSync(path.join(root, "tsconfig.next.json"))
      const noEntry = readCoverage(root)
      ok("聚合入口不存在 ⇒ unjudged（不是 passed）", noEntry.status === "unjudged")
      ok("聚合入口不存在：理由码 no-corpus", noEntry.reason === "no-corpus")

      // ── 语料归零（真实 IO）：0 个包级 tsconfig ────────────────────────────
      write("tsconfig.next.json", '{ "include": [], "references": [] }')
      for (const rel of ["packages/a/b", "packages/c/d"]) fs.rmSync(path.join(root, rel), { recursive: true, force: true })
      const empty = readCoverage(root)
      ok("真实 IO 语料归零 ⇒ unjudged（不是 passed）", empty.status === "unjudged")
      ok("真实 IO 语料归零：理由码 no-corpus", empty.reason === "no-corpus")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ── 环保护：两条 tsconfig 互相 reference 不该把递归挂死 ──────────────────
  {
    const { root, write } = tmpTree("tsconfig-coverage-cycle-")
    try {
      write("packages/a/b/tsconfig.json", '{ "include": [], "references": [{ "path": "../../c/d" }] }')
      write("packages/c/d/tsconfig.json", '{ "include": [], "references": [{ "path": "../../a/b" }] }')
      write("tsconfig.next.json", '{ "include": [], "references": [{ "path": "./packages/a/b" }] }')
      const ts = loadTsFor(root)
      if (ts) {
        const g = scanGraph(root, ts) // 不设 visited 会在这里挂死
        ok("成环：解图能终止且两个包都在图里", g.inGraph.includes("packages/a/b") && g.inGraph.includes("packages/c/d"), JSON.stringify(g.inGraph))
        ok("成环：不产生假悬空", g.dangling.length === 0, JSON.stringify(g.dangling))
      } else {
        ok("成环：typescript 取不到（本机异常）", false)
      }
      ok("深度上限是个有限正数（不是 Infinity）", Number.isInteger(MAX_DEPTH) && MAX_DEPTH > 0 && MAX_DEPTH < 1000)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ── 反向控制：把「正向判据」摘掉必须变红（证明它有牙，不是恒绿）─────────
  {
    // 同一份语料，只在「图里少一个包」这一处变化：绿 → 红。这是判据有判别力的直接证据。
    const clean: CoverageInput = { onDisk: ["packages/a/b"], inGraph: ["packages/a/b"] }
    const mutated: CoverageInput = { onDisk: ["packages/a/b"], inGraph: [] }
    ok("反向控制：干净语料先绿（基线）", judgeCoverage(clean).status === "passed")
    ok("反向控制：只抽掉图里的那一项 ⇒ 立刻红（判据有判别力）", judgeCoverage(mutated).status === "failed")
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立（共 ${total} 条断言）`
      : `✓ spec 全过（${total} 条断言：纯函数两方向 + 隔离 + 归一 + 语料归零 + 真实 IO 发现器/解图/间接/悬空/坏 JSONC + 成环 + 反向控制）`,
  )
  return fails === 0
}
