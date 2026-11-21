/**
 * `verify-memory-index` 的 spec（ISS-766）。
 * 四类基础用例（正例 / 悬空 / 缺条目 / 封存目录不要求）+ 棘轮三态（存量豁免 / 新增即红 /
 * 基线自身说谎 + 两条只提示不判红）+ 解析口径（只认表格第一列）+ 缺输入判不了。
 */
import { isSealed, judgeMemoryIndex, indexRowPath, missingInScope, parseIndex } from "./verify-memory-index.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const details = (r: ReturnType<typeof judgeMemoryIndex>) => (r.findings ?? []).map((f) => f.detail).join("\n")

/** 造一份最小 README：只有「归档文件」表，行数由 rowPaths 决定。 */
const readme = (rowPaths: string[]) =>
  ["# docs/memory", "", "## 归档文件", "", "| 文件 | 内容 | 原大小 |", "|---|---|---|", ...rowPaths.map((p) => `| \`${p}\` | 某主题 | — |`)].join("\n")

export function run(): boolean {
  fails = 0
  console.log("verify-memory-index.spec")

  // ── 正例 ────────────────────────────────────────────────────────────────────
  {
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md", "incidents/boom-2026-10-05.md"]), files: ["a-2026-05-20.md", "incidents/boom-2026-10-05.md", "README.md"] })
    ok("正例：表与盘一一对应 ⇒ passed", r.status === "passed")
    ok("正例：detail 报「缺条目 0 新增 · 存量豁免 0 · 悬空 0」+ 射程与排除数", (r.detail ?? "").startsWith("缺条目 0 新增 · 存量豁免 0 · 悬空 0") && (r.detail ?? "").includes("射程 = git 跟踪 2 份（已排除 0 份未入库）"))
  }

  // ── 射程报数：排除的未入库份数必须显式出现在结论行（静默排除 = 门禁看不见东西）──
  {
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md"]), files: ["a-2026-05-20.md", "README.md"], untrackedCount: 34 })
    ok("射程：未入库排除数进结论行（34）", (r.detail ?? "").includes("已排除 34 份未入库"))
    ok("射程：未入库文件本身不进缺条目（它不是射程内实体）", r.status === "passed" && !details(r).includes("缺条目新增"))
  }

  // ── 悬空：表里有、盘上没有 ─────────────────────────────────────────────────
  {
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md", "renamed-2026-09-01.md"]), files: ["a-2026-05-20.md", "README.md"] })
    ok("悬空：failed", r.status === "failed")
    ok("悬空：点名 renamed-2026-09-01.md", details(r).includes("索引悬空 1 条") && details(r).includes("renamed-2026-09-01.md"))
    ok("悬空：不误报缺条目（a 两边都有）", !details(r).includes("缺条目新增"))
    ok("悬空：基线豁免不了悬空（knownMissing 塞进去也照样红）", judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md", "ghost.md"]), files: ["a-2026-05-20.md", "README.md"], knownMissing: ["ghost.md"] }).status === "failed")
  }

  // ── 悬空的两种成因分开报（判定相同，文案必须指对方向）────────────────────────
  {
    // 盘上也没有：改名/删除后索引没跟上
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md", "renamed-2026-09-01.md"]), files: ["a-2026-05-20.md", "README.md"], physical: ["a-2026-05-20.md", "README.md"] })
    ok("悬空成因①：盘上也没有 ⇒ 措辞「盘上也没有」（点名改名/删除）", details(r).includes("索引悬空 1 条") && details(r).includes("盘上也没有") && !details(r).includes("未入库文件"))
  }
  {
    // 盘上有但未入库：索引指向一个没 git add 的文件
    const r = judgeMemoryIndex({
      indexText: readme(["a-2026-05-20.md", "draft-2026-11-09.md"]),
      files: ["a-2026-05-20.md", "README.md"],
      physical: ["a-2026-05-20.md", "draft-2026-11-09.md", "README.md"],
      untrackedCount: 1,
    })
    ok("悬空成因②：盘上有但未入库 ⇒ failed（判定不变）", r.status === "failed")
    ok("悬空成因②：措辞「索引指向未入库文件」+ 提示先 git add", details(r).includes("索引指向未入库文件 1 条") && details(r).includes("git add"))
    ok("悬空成因②：不再说「盘上也没有」（本机该文件明明存在）", !details(r).includes("盘上也没有"))
  }

  // ── 缺条目：盘上有、表里没有 ───────────────────────────────────────────────
  {
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md"]), files: ["a-2026-05-20.md", "b-2026-06-01.md", "incidents/boom-2026-10-05.md", "README.md"] })
    ok("缺条目：failed", r.status === "failed")
    ok("缺条目：点名 b 与 incidents/boom（两处都点名）", details(r).includes("缺条目新增 2 份") && details(r).includes("b-2026-06-01.md") && details(r).includes("incidents/boom-2026-10-05.md"))
    ok("缺条目：不误报悬空", !details(r).includes("索引悬空"))
  }

  // ── 封存目录不要求索引 ─────────────────────────────────────────────────────
  {
    const files = ["a-2026-05-20.md", "README.md", "archive/old-2026-10-19.md", "attachments/matrix.md", "triage-2026-10-26/part1a.md", "wt-salvage-2026-11-08/README.md", "evidence-run-1.md", "patches/fix.md", "pool-archive/x.md"]
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md"]), files })
    ok("封存目录：封存目录里的文件缺条目 ⇒ 仍 passed", r.status === "passed")
    ok("封存目录：isSealed 逐条认（archive/attachments/triage-*/wt-salvage-*/evidence-*/patches/pool-archive/README）", files.filter((f) => f !== "a-2026-05-20.md").every(isSealed))
    ok("封存目录：普通归档不误判为封存", !isSealed("incidents/boom-2026-10-05.md") && !isSealed("a-2026-05-20.md"))
  }

  // ── 棘轮三态 ───────────────────────────────────────────────────────────────
  {
    const files = ["a-2026-05-20.md", "b-2026-06-01.md", "README.md"]
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md"]), files, knownMissing: ["b-2026-06-01.md"] })
    ok("棘轮：存量缺条目在基线里 ⇒ passed", r.status === "passed")
    ok("棘轮：detail 报「缺条目 0 新增 · 存量豁免 1 · 悬空 0」", (r.detail ?? "").startsWith("缺条目 0 新增 · 存量豁免 1 · 悬空 0"))
  }

  {
    const files = ["a-2026-05-20.md", "b-2026-06-01.md", "c-2026-07-01.md", "README.md"]
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md"]), files, knownMissing: ["b-2026-06-01.md"] })
    ok("棘轮：基线外的新缺条目 ⇒ failed", r.status === "failed")
    ok("棘轮：只点名 c（基线里的 b 不报）", details(r).includes("缺条目新增 1 份") && details(r).includes("c-2026-07-01.md") && !details(r).includes("b-2026-06-01.md"))
  }

  {
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md", "b-2026-06-01.md"]), files: ["a-2026-05-20.md", "b-2026-06-01.md", "README.md"], knownMissing: ["b-2026-06-01.md"] })
    ok("棘轮：基线条目已被索引 ⇒ 只提示「可摘」，不判红", r.status === "passed" && (r.detail ?? "").includes("可摘 1 条") && (r.detail ?? "").includes("已被索引"))
  }

  {
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md"]), files: ["a-2026-05-20.md", "README.md"], knownMissing: ["deleted-2026-01-01.md"] })
    ok("棘轮：基线条目的文件已删 ⇒ 只提示「可摘（文件已删）」，不判红", r.status === "passed" && (r.detail ?? "").includes("可摘 1 条") && (r.detail ?? "").includes("文件已删"))
  }

  {
    const r = judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md"]), files: ["a-2026-05-20.md", "README.md"], knownMissing: ["archive/old-2026-10-19.md"] })
    ok("棘轮：knownMissing 里有封存目录路径 ⇒ failed（基线自身说谎）", r.status === "failed" && details(r).includes("基线自身说谎 1 条"))
    ok("棘轮：README.md 也不许进基线", judgeMemoryIndex({ indexText: readme(["a-2026-05-20.md"]), files: ["a-2026-05-20.md", "README.md"], knownMissing: ["README.md"] }).status === "failed")
  }

  // ── 只认表格第一列 ─────────────────────────────────────────────────────────
  {
    const text = ["## 归档文件", "| 文件 | 内容 |", "|---|---|", "| `a-2026-05-20.md` | 见 `b-2026-06-01.md` 的展开 |"].join("\n")
    const r = judgeMemoryIndex({ indexText: text, files: ["a-2026-05-20.md", "b-2026-06-01.md", "README.md"] })
    ok("第一列：第二列提到的文件不算已索引（b 仍报缺条目）", r.status === "failed" && details(r).includes("缺条目新增 1 份") && details(r).includes("b-2026-06-01.md"))
    ok("第一列：正文行（非表格）不算索引", indexRowPath("见 `a-2026-05-20.md`") === null)
    ok("第一列：路径后的 §13 不被带进路径", indexRowPath("| `plans-x-2026-09-17.md` §13 | 说明 |") === "plans-x-2026-09-17.md")
    ok("第一列：同一文件分段重复登记只算一条", parseIndex(readme(["a.md", "a.md"])).length === 1)
  }

  // ── --write 与判定同口径 ───────────────────────────────────────────────────
  {
    const input = { indexText: readme(["a-2026-05-20.md"]), files: ["a-2026-05-20.md", "b-2026-06-01.md", "archive/x.md", "README.md"] }
    ok("missingInScope：只算射程内且缺索引（b 一条，archive/README 不算）", JSON.stringify(missingInScope(input)) === JSON.stringify(["b-2026-06-01.md"]))
  }

  // ── 缺输入 = 判不了（不是绿）────────────────────────────────────────────────
  {
    const r = judgeMemoryIndex({ indexText: "# docs/memory\n\n归档表被删了\n", files: ["a-2026-05-20.md", "README.md"] })
    ok("缺输入：表解析为空 ⇒ unjudged（不是 passed）", r.status === "unjudged" && r.reason === "no-corpus")
    const r2 = judgeMemoryIndex({ indexText: readme(["archive/x.md"]), files: ["README.md", "archive/x.md"] })
    ok("缺输入：射程内一份都没有 ⇒ unjudged（不因「全封存」判绿）", r2.status === "unjudged" && r2.reason === "no-corpus")
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（正例×2 / 射程报数×2 / 悬空×4 / 悬空成因×3 / 缺条目×3 / 封存×3 / 棘轮×9 / 第一列×4 / 同口径×1 / 缺输入×2）")
  return fails === 0
}
