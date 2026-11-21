/**
 * ISS-536 · `@matter/blocks/src/export-md` 的永久回归守卫。
 *
 * 断言全部写成「换成错误实现即红」的形态（照 spec.test.ts 头注纪律）：
 *   ① 28 种块各一条独立 it —— 删/改任一映射，只那一条红（变异牙）；
 *   ② 容器递归缩进、marks 12、mark 叠加顺序、损失清单逐条钉住；
 *   ③ GOLDEN 用 `Record<BlockType, …>`：新增一种 BlockType 忘加 golden ⇒ TS 编译红，
 *      与源码 `assertNever` 一起构成「判枚举穷尽、不数恰好 28」的双层静态断言。
 * @module @matter/blocks/tests/export-md
 */

import { describe, expect, it } from "vitest"
import { exportMarkdown } from "../src/export-md.ts"
import { BLOCK_TYPES } from "../src/index.ts"
import type { Block as BlockValue, BlockType, Rich } from "../src/index.ts"

/** 造一个富文本片段（有 marks 才带 marks 键）。 */
function rich(text: string, marks?: string[]): Rich {
  return marks ? { text, marks } : { text }
}

interface GoldenCase {
  readonly block: BlockValue
  readonly md: string
}

/**
 * 每种块一条 golden。用 Record 钉死键集合：union 新增类型而此处漏加 ⇒ 编译红。
 * 每个 md 都是该映射的变异牙——把源码对应 case 改错，只有那一条 it 红。
 */
const GOLDEN: Record<BlockType, GoldenCase> = {
  paragraph: { block: { id: "p", type: "paragraph", rich: [rich("hello")] }, md: "hello" },
  heading: { block: { id: "h", type: "heading", level: 2, rich: [rich("Title")] }, md: "## Title" },
  bulletList: {
    block: { id: "bl", type: "bulletList", items: [rich("a"), rich("b")] },
    md: "- a\n- b",
  },
  orderedList: {
    block: { id: "ol", type: "orderedList", items: [rich("x"), rich("y")] },
    md: "1. x\n2. y",
  },
  todo: { block: { id: "t", type: "todo", checked: true, rich: [rich("done")] }, md: "- [x] done" },
  quote: { block: { id: "q", type: "quote", rich: [rich("q")] }, md: "> q" },
  divider: { block: { id: "d", type: "divider" }, md: "---" },
  code: { block: { id: "c", type: "code", code: "1+1", language: "ts" }, md: "```ts\n1+1\n```" },
  image: { block: { id: "i", type: "image", url: "https://x/i.png", caption: "cap" }, md: "![cap](https://x/i.png)" },
  issueRef: { block: { id: "ir", type: "issueRef", ref: "ISS-123" }, md: "[ISS-123](matter://issue/ISS-123)" },
  docRef: { block: { id: "dr", type: "docRef", ref: "DOC-512" }, md: "[DOC-512](matter://doc/DOC-512)" },
  mermaid: { block: { id: "m", type: "mermaid", code: "graph TD" }, md: "```mermaid\ngraph TD\n```" },
  toggle: {
    block: { id: "tg", type: "toggle", title: "T", children: [{ id: "p", type: "paragraph", rich: [rich("child")] }] },
    md: "<details><summary>T</summary>\n\n  child\n\n</details>",
  },
  callout: { block: { id: "co", type: "callout", tone: "warn", rich: [rich("careful")] }, md: "> [!WARNING]\n> careful" },
  table: { block: { id: "tb", type: "table", rows: [["A", "B"], ["1", "2"]] }, md: "| A | B |\n| --- | --- |\n| 1 | 2 |" },
  view: { block: { id: "v", type: "view", ref: "view-1" }, md: "[view:view-1](matter://view/view-1)" },
  video: { block: { id: "vd", type: "video", url: "https://x/v.mp4" }, md: "[video](https://x/v.mp4)" },
  audio: { block: { id: "au", type: "audio", url: "https://x/a.mp3" }, md: "[audio](https://x/a.mp3)" },
  pdf: { block: { id: "pd", type: "pdf", url: "https://x/p.pdf" }, md: "[pdf](https://x/p.pdf)" },
  bookmark: { block: { id: "bm", type: "bookmark", url: "https://x" }, md: "[https://x](https://x)" },
  attachment: { block: { id: "at", type: "attachment", asset: "media-1", name: "f.txt" }, md: "[f.txt](matter://asset/media-1)" },
  columns: {
    block: { id: "cl", type: "columns", children: [{ id: "p", type: "paragraph", rich: [rich("col")] }] },
    md: "  col",
  },
  math: { block: { id: "ma", type: "math", tex: "x^2" }, md: "$$x^2$$" },
  toc: { block: { id: "toc", type: "toc" }, md: "<!-- toc -->" },
  breadcrumb: { block: { id: "bc", type: "breadcrumb" }, md: "<!-- breadcrumb -->" },
  syncedBlock: {
    block: { id: "sb", type: "syncedBlock", ref: "b-root", children: [{ id: "p", type: "paragraph", rich: [rich("sync")] }] },
    md: "> synced from matter://block/b-root\n\n  sync",
  },
  template: { block: { id: "tp", type: "template", ref: "tpl-1" }, md: "[template](matter://template/tpl-1)" },
  embed: { block: { id: "em", type: "embed", url: "https://x/e" }, md: "[embed](https://x/e)" },
}

describe("ISS-536 · 28 块逐条映射（变异牙：删一条 case 只红对应一条）", () => {
  it("§1 GOLDEN 键集合逐字等于 BLOCK_TYPES（Record 编译期穷尽 + 运行期无漂移）", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual([...BLOCK_TYPES].sort())
    expect(BLOCK_TYPES).toHaveLength(28)
  })

  for (const type of BLOCK_TYPES) {
    const { block, md } = GOLDEN[type]
    it(`§golden ${type} → ${JSON.stringify(md)}`, () => {
      expect(exportMarkdown([block])).toBe(md)
    })
  }

  it("§2 顶层多块以空行连接；空数组 ⇒ 空串", () => {
    expect(exportMarkdown([GOLDEN.paragraph.block, GOLDEN.divider.block])).toBe("hello\n\n---")
    expect(exportMarkdown([])).toBe("")
  })
})

describe("ISS-536 · 可选字段缺省与条件分支", () => {
  it("§3 orderedList 缺 start ⇒ 从 1 计；有 start ⇒ 从 start 计", () => {
    expect(exportMarkdown([{ id: "o", type: "orderedList", items: [rich("a"), rich("b")] }])).toBe("1. a\n2. b")
    expect(exportMarkdown([{ id: "o", type: "orderedList", items: [rich("a")], start: 3 }])).toBe("3. a")
  })

  it("§4 todo 未勾选 ⇒ 空方框", () => {
    expect(exportMarkdown([{ id: "t", type: "todo", checked: false, rich: [rich("x")] }])).toBe("- [ ] x")
  })

  it("§5 code 缺 language ⇒ 空 info string", () => {
    expect(exportMarkdown([{ id: "c", type: "code", code: "1+1" }])).toBe("```\n1+1\n```")
  })

  it("§6 image 缺 caption ⇒ 空 alt", () => {
    expect(exportMarkdown([{ id: "i", type: "image", url: "https://x/p.png" }])).toBe("![](https://x/p.png)")
  })

  it("§7 mermaid 有 caption ⇒ 代码块后附一行", () => {
    expect(exportMarkdown([{ id: "m", type: "mermaid", code: "graph TD", caption: "cap" }])).toBe("```mermaid\ngraph TD\n```\ncap")
  })

  it("§8 callout 缺 tone ⇒ NOTE；各 tone 映射到 alert 标签", () => {
    expect(exportMarkdown([{ id: "c", type: "callout", rich: [rich("t")] }])).toBe("> [!NOTE]\n> t")
    expect(exportMarkdown([{ id: "c", type: "callout", tone: "info", rich: [rich("t")] }])).toBe("> [!NOTE]\n> t")
    expect(exportMarkdown([{ id: "c", type: "callout", tone: "success", rich: [rich("t")] }])).toBe("> [!TIP]\n> t")
    expect(exportMarkdown([{ id: "c", type: "callout", tone: "error", rich: [rich("t")] }])).toBe("> [!IMPORTANT]\n> t")
  })

  it("§9 表格：空 rows ⇒ 空串；单元格 `|` 转义", () => {
    expect(exportMarkdown([{ id: "tb", type: "table", rows: [] }])).toBe("")
    expect(exportMarkdown([{ id: "tb", type: "table", rows: [["a|b"]] }])).toBe("| a\\|b |\n| --- |")
  })

  it("§10 媒体缺/有 caption；bookmark 缺/有 caption；template 缺/有 name", () => {
    expect(exportMarkdown([{ id: "v", type: "video", url: "https://x/v", caption: "demo" }])).toBe("[video](https://x/v)\ndemo")
    expect(exportMarkdown([{ id: "a", type: "audio", url: "https://x/a", caption: "song" }])).toBe("[audio](https://x/a)\nsong")
    expect(exportMarkdown([{ id: "b", type: "bookmark", url: "https://x", caption: "site" }])).toBe("[site](https://x)")
    expect(exportMarkdown([{ id: "t", type: "template", ref: "r", name: "N" }])).toBe("[N](matter://template/r)")
  })

  it("§11 富文本缺省：paragraph 无 rich、bulletList 无 items ⇒ 空串", () => {
    expect(exportMarkdown([{ id: "p", type: "paragraph" }])).toBe("")
    expect(exportMarkdown([{ id: "bl", type: "bulletList" }])).toBe("")
  })
})

describe("ISS-536 · 容器递归与缩进", () => {
  it("§12 两层嵌套（columns → toggle → paragraph）：每层缩进 2 空格，逐字钉住", () => {
    const block: BlockValue = {
      id: "cl", type: "columns",
      children: [{
        id: "tg", type: "toggle", title: "T",
        children: [{ id: "p", type: "paragraph", rich: [rich("leaf")] }],
      }],
    }
    expect(exportMarkdown([block])).toBe(
      "  <details><summary>T</summary>\n  \n      leaf\n  \n  </details>",
    )
  })

  it("§13 syncedBlock 嵌套在 columns 内：引用标记 + 子节点内联 + 缩进", () => {
    const block: BlockValue = {
      id: "cl", type: "columns",
      children: [{
        id: "sb", type: "syncedBlock", ref: "b-root",
        children: [{ id: "p", type: "paragraph", rich: [rich("leaf")] }],
      }],
    }
    expect(exportMarkdown([block])).toBe("  > synced from matter://block/b-root\n  \n      leaf")
  })

  it("§14 空容器：无 children / 空数组 ⇒ 空串（不出孤立标记）", () => {
    expect(exportMarkdown([{ id: "cl", type: "columns" }])).toBe("")
    expect(exportMarkdown([{ id: "cl", type: "columns", children: [] }])).toBe("")
    expect(exportMarkdown([{ id: "tg", type: "toggle", title: "T" }])).toBe("<details><summary>T</summary>\n\n\n\n</details>")
    expect(exportMarkdown([{ id: "sb", type: "syncedBlock", ref: "b" }])).toBe("> synced from matter://block/b\n\n")
  })
})

describe("ISS-536 · marks 12 全过与叠加顺序", () => {
  it("§15 12 种 mark 各一段，逐字钉住 md 形态", () => {
    const block: BlockValue = {
      id: "p", type: "paragraph",
      rich: [
        rich("B", ["bold"]),
        rich("I", ["italic"]),
        rich("S", ["strikethrough"]),
        rich("C", ["code"]),
        rich("L", ["link:https://x"]),
        rich("U", ["underline"]),
        rich("H", ["highlight"]),
        rich("R", ["color:red"]),
        rich("G", ["bg:yellow"]),
        rich("Z", ["size:lg"]),
        rich("M", ["math:x^2"]),
        rich("F", ["issue:ISS-1"]),
      ],
    }
    expect(exportMarkdown([block])).toBe(
      "**B**" + "*I*" + "~~S~~" + "`C`" + "[L](https://x)" + "<u>U</u>" + "==H=="
      + "<span style=\"color:red\">R</span>" + "<span style=\"background-color:yellow\">G</span>"
      + "<span style=\"font-size:lg\">Z</span>" + "$x^2$" + "[F](matter://issue/ISS-1)",
    )
  })

  it("§16 叠加按固定 rank 由内向外，与输入顺序无关（code < bold < link）", () => {
    const asWritten: BlockValue = { id: "p", type: "paragraph", rich: [rich("x", ["bold", "link:https://x", "code"])] }
    const reversed: BlockValue = { id: "p", type: "paragraph", rich: [rich("x", ["code", "link:https://x", "bold"])] }
    // rank: code(1) → bold(10) → link(11)：`code` 最内、`link` 最外
    expect(exportMarkdown([asWritten])).toBe("[**`x`**](https://x)")
    expect(exportMarkdown([reversed])).toBe(exportMarkdown([asWritten]))
  })

  it("§17 未知 mark 原文直出（schema 允许任意 string ⇒ 丢弃不计红）", () => {
    expect(exportMarkdown([{ id: "p", type: "paragraph", rich: [rich("plain", ["not-a-mark"])] }])).toBe("plain")
  })

  it("§18 HTML 属性值最小转义（color 值含 & \" < >）", () => {
    const block: BlockValue = { id: "p", type: "paragraph", rich: [rich("t", ["color:a&b\"<>"])] }
    expect(exportMarkdown([block])).toBe("<span style=\"color:a&amp;b&quot;&lt;&gt;\">t</span>")
  })

  it("§19 ref mark 三种 kind（issue/doc/view）各自拼 matter URI", () => {
    const block: BlockValue = {
      id: "p", type: "paragraph",
      rich: [rich("i", ["issue:ISS-1"]), rich("d", ["doc:DOC-2"]), rich("v", ["view:v-3"])],
    }
    expect(exportMarkdown([block])).toBe(
      "[i](matter://issue/ISS-1)[d](matter://doc/DOC-2)[v](matter://view/v-3)",
    )
  })
})

describe("ISS-536 · 损失清单（有损点显式钉住，不冒充无损）", () => {
  it("§20 view/toc/breadcrumb 仅占位；pdf.page 与 embed.html 被丢弃", () => {
    expect(exportMarkdown([{ id: "p", type: "pdf", url: "https://x/p", page: 7 }])).toBe("[pdf](https://x/p)")
    expect(exportMarkdown([{ id: "e", type: "embed", url: "https://x/e", html: "<b>x</b>" }])).toBe("[embed](https://x/e)")
    expect(exportMarkdown([GOLDEN.view.block])).toBe("[view:view-1](matter://view/view-1)")
    expect(exportMarkdown([GOLDEN.toc.block])).toBe("<!-- toc -->")
    expect(exportMarkdown([GOLDEN.breadcrumb.block])).toBe("<!-- breadcrumb -->")
  })

  it("§21 issueRef.preview 被忽略：有无 preview 输出一致", () => {
    const a = exportMarkdown([{ id: "ir", type: "issueRef", ref: "ISS-9" }])
    const b = exportMarkdown([{ id: "ir", type: "issueRef", ref: "ISS-9", preview: true }])
    expect(b).toBe(a)
  })
})
