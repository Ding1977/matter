/**
 * `@matter/blocks/src/export-md` —— 单向块树 → Markdown 的纯导出器（ISS-536 / P4-E1）。
 *
 * ## 单向、有损、零依赖
 *
 * 输入 `Block[]`，输出 Markdown 字符串。不读存储、不依赖 editor、不 import BN/remark；
 * 只读 {@link spec.ts} 的 28 种判别联合与词表。反方向（md → blocks）不在本模块职责内：
 * 双向需要 editor 实例与无损 AST，正是调研判词「不复用 `blocksToMarkdownLossy`」的原因。
 *
 * ## 穷尽性：判「枚举穷尽」而非「数恰好 28」
 *
 * 单一 28-case switch 的圈复杂度是 29（红，见 src/index.ts 头注），故按 A/B/C 分组：
 * 三个谓词把 `Block` 收窄到分组子联合，每组 switch 以 `assertNever` 收尾；dispatch 取
 * 「排除 A、B 后的剩余类型」交给 C 组渲染（三词表穷尽，漏一种类型则 renderC 处类型不符
 * 当场编译红）。新增一种 BlockType 而漏映射时，编译期 TS2345 当场红；
 * 不写「块数恰好 28」的快照断言（那种断言一扩容即恒红，比没有更坏）。
 *
 * ## 损失清单（V1 单向允许有损，显式列出；与 DSH session-log-export 的 omitted 纪律同形）
 *
 * 下面这些信息在导出时**被降级或丢弃**，调用方不应把 md 当可逆存档：
 * - `view` 查询结果、`toc` / `breadcrumb` 展开内容：只留占位/链接。
 * - `columns` 多栏布局拉平为顺序块；`syncedBlock` 同步语义丢失（子节点内联为快照）。
 * - `pdf.page`、`embed.html`（XSS 风险）、`issueRef/docRef.preview`、未知 mark：降级或丢弃。
 * - `attachment.mime`：技术元数据（非用户可见内容），只导出 name/asset 链接，mime 丢弃。
 * - 容器子节点缩进在 depth ≥ 2 时可能使 fenced code 缩进超标：V1 已知边界。
 *
 * @module @matter/blocks/src/export-md
 */

import { assertNever } from "./index.ts"
import {
  A_BASIC_TYPES, B_BUSINESS_TYPES, C_NOTION_TYPES,
} from "./spec.ts"
import type { Block, BlockType, Rich } from "./spec.ts"

/** A 组判别字面量（派生自词表，不另立真相源）。 */
type AType = (typeof A_BASIC_TYPES)[number]
/** B 组判别字面量。 */
type BType = (typeof B_BUSINESS_TYPES)[number]
/** C 组判别字面量。 */
type CType = (typeof C_NOTION_TYPES)[number]
/** 收窄到 A 组的块联合。 */
type BlockA = Extract<Block, { type: AType }>
/** 收窄到 B 组的块联合。 */
type BlockB = Extract<Block, { type: BType }>
/** 收窄到 C 组的块联合。 */
type BlockC = Extract<Block, { type: CType }>

/** 顶层块之间的分隔（空行）。 */
const BLOCK_SEP = "\n\n"
/** 每层容器的缩进单元。 */
const INDENT = "  "

/**
 * 一个已解析的内联 mark：名字、值、包裹优先级（升序，越小越靠内）。
 * `rank` 缺省 999 ⇒ 未知 mark 落到最外层且 wrapper 为恒等，等价于忽略。
 */
interface ParsedMark {
  readonly name: string
  readonly value: string
  readonly rank: number
}

/**
 * mark 包裹优先级（由内向外），与施工图一致。
 * ref 的三种编码名（issue/doc/view）同rank，彼此不叠加。
 */
const MARK_RANK: Readonly<Record<string, number>> = {
  code: 1, math: 2, color: 3, bg: 4, size: 5, underline: 6,
  highlight: 7, strikethrough: 8, italic: 9, bold: 10, link: 11,
  issue: 12, doc: 12, view: 12,
}

/** HTML 属性值的最小转义（`&` 先替换，避免二次转义）。 */
function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * 各 mark 名的包裹函数表。(text, value) => md。
 * math 的 tex 取自 value（编码 `math:<tex>`），显示文本不使用。
 */
const WRAPPERS: Readonly<Record<string, (text: string, value: string) => string>> = {
  bold: (t) => `**${t}**`,
  italic: (t) => `*${t}*`,
  strikethrough: (t) => `~~${t}~~`,
  code: (t) => `\`${t}\``,
  underline: (t) => `<u>${t}</u>`,
  highlight: (t) => `==${t}==`,
  color: (t, v) => `<span style="color:${escAttr(v)}">${t}</span>`,
  bg: (t, v) => `<span style="background-color:${escAttr(v)}">${t}</span>`,
  size: (t, v) => `<span style="font-size:${escAttr(v)}">${t}</span>`,
  math: (_text, v) => `$${v}$`,
  link: (t, v) => `[${t}](${v})`,
  issue: (t, v) => `[${t}](matter://issue/${v})`,
  doc: (t, v) => `[${t}](matter://doc/${v})`,
  view: (t, v) => `[${t}](matter://view/${v})`,
}

/**
 * 解析一个骨架 mark 字符串（对齐 marks.ts `markToSkeletonString`）。
 * 首个冒号分割 name/value；无冒号则 value 为空（裸布尔 mark）。
 */
function parseMark(raw: string): ParsedMark {
  const i = raw.indexOf(":")
  const name = i < 0 ? raw : raw.slice(0, i)
  const value = i < 0 ? "" : raw.slice(i + 1)
  return { name, value, rank: MARK_RANK[name] ?? 999 }
}

/** 对一段文本按 rank 由内向外包裹 marks；未知 mark（恒等 wrapper）不改变文本。 */
function renderInline(text: string, marks: readonly string[] | undefined): string {
  let out = text
  if (!marks) return out
  const parsed = marks.map(parseMark).sort((a, b) => a.rank - b.rank)
  for (const m of parsed) {
    const wrap = WRAPPERS[m.name]
    out = wrap ? wrap(out, m.value) : out
  }
  return out
}

/** inline 一个 Rich 片段（bulletList / orderedList 的 item 是单个 Rich）。 */
function inlineRich(seg: Rich): string {
  return renderInline(seg.text, seg.marks)
}

/** 一组富文本片段顺序拼接为一行内联 md。 */
function renderRich(rich: readonly Rich[] | undefined): string {
  if (!rich) return ""
  return rich.map((seg) => renderInline(seg.text, seg.marks)).join("")
}

/** 列表项逐行渲染（无 items ⇒ 空串）。 */
function renderItems(
  items: readonly Rich[] | undefined,
  line: (item: Rich, index: number) => string,
): string {
  if (!items) return ""
  return items.map(line).join("\n")
}

/** 实体引用（issueRef/docRef）：`[ref](matter://<kind>/<ref>)`；preview 被丢弃（损失清单）。 */
function refLink(kind: "issue" | "doc", ref: string): string {
  return `[${ref}](matter://${kind}/${ref})`
}

/** 媒体链接（video/audio）：无 caption 时只出链接。 */
function mediaLink(label: string, url: string, caption: string | undefined): string {
  return `[${label}](${url})` + (caption ? "\n" + caption : "")
}

/** GFM 表格：首行表头 + 分隔行 + 数据行；单元格内 `|` 转义；空 rows ⇒ 空串。 */
function renderTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return ""
  const esc = (cell: string): string => cell.replace(/\|/g, "\\|")
  const line = (cells: readonly string[]): string => "| " + cells.map(esc).join(" | ") + " |"
  const header = line(rows[0])
  const sep = "| " + rows[0].map(() => "---").join(" | ") + " |"
  const body = rows.slice(1).map(line)
  return [header, sep, ...body].join("\n")
}

/** callout：GitHub alert，`tone` 映射为告警标签，缺省 NOTE。 */
function renderCallout(block: Extract<Block, { type: "callout" }>): string {
  const alerts: Readonly<Record<string, string>> = {
    info: "NOTE", warn: "WARNING", success: "TIP", error: "IMPORTANT",
  }
  const tag = block.tone ? alerts[block.tone] : "NOTE"
  return `> [!${tag}]\n> ` + renderRich(block.rich)
}

/** 容器子节点：空/缺省 ⇒ 空串，否则按 depth 递归渲染。 */
function renderChildren(children: readonly Block[] | undefined, depth: number): string {
  if (!children || children.length === 0) return ""
  return renderBlocks(children, depth)
}

/** 给渲染结果按层缩进；顶层（depth ≤ 0）原样返回。 */
function indentBlock(text: string, depth: number): string {
  if (depth <= 0) return text
  const pad = INDENT.repeat(depth)
  return text.split("\n").map((line) => pad + line).join("\n")
}

/** 一组块按 depth 渲染并用空行连接，每块按层缩进。 */
function renderBlocks(blocks: readonly Block[], depth: number): string {
  return blocks.map((block) => indentBlock(renderBlock(block, depth), depth)).join(BLOCK_SEP)
}

/** A 组 9 种基础块渲染；default 是穷尽闸（漏 case ⇒ 编译红）。 */
function renderA(block: BlockA, _depth: number): string {
  switch (block.type) {
    case "paragraph":
      return renderRich(block.rich)
    case "heading":
      return "#".repeat(block.level) + " " + renderRich(block.rich)
    case "bulletList":
      return renderItems(block.items, (item) => "- " + inlineRich(item))
    case "orderedList":
      return renderItems(block.items, (item, i) => (block.start ?? 1) + i + ". " + inlineRich(item))
    case "todo":
      return "- [" + (block.checked ? "x" : " ") + "] " + renderRich(block.rich)
    case "quote":
      return "> " + renderRich(block.rich)
    case "divider":
      return "---"
    case "code":
      return "```" + (block.language ?? "") + "\n" + block.code + "\n```"
    case "image":
      return `![${block.caption ?? ""}](${block.url})`
    /* v8 ignore next 2 -- 穷尽闸：blockGroup 词表与 9 case 同步维护，运行期不可达 */
    default:
      return assertNever(block)
  }
}

/** B 组 7 种业务块渲染；default 是穷尽闸。 */
function renderB(block: BlockB, depth: number): string {
  switch (block.type) {
    case "issueRef":
      return refLink("issue", block.ref)
    case "docRef":
      return refLink("doc", block.ref)
    case "mermaid":
      return "```mermaid\n" + block.code + "\n```" + (block.caption ? "\n" + block.caption : "")
    case "toggle":
      return "<details><summary>" + block.title + "</summary>" + BLOCK_SEP
        + renderChildren(block.children, depth + 1) + BLOCK_SEP + "</details>"
    case "callout":
      return renderCallout(block)
    case "table":
      return renderTable(block.rows)
    case "view":
      return `[view:${block.ref}](matter://view/${block.ref})`
    /* v8 ignore next 2 -- 穷尽闸：运行期不可达 */
    default:
      return assertNever(block)
  }
}

/** C 组 12 种 Notion 扩展块渲染；default 是穷尽闸。 */
function renderC(block: BlockC, depth: number): string {
  switch (block.type) {
    case "video":
      return mediaLink("video", block.url, block.caption)
    case "audio":
      return mediaLink("audio", block.url, block.caption)
    case "pdf":
      return `[pdf](${block.url})`
    case "bookmark":
      return `[${block.caption ?? block.url}](${block.url})`
    case "attachment":
      return `[${block.name}](matter://asset/${block.asset})`
    case "math":
      return "$$" + block.tex + "$$"
    case "toc":
      return "<!-- toc -->"
    case "breadcrumb":
      return "<!-- breadcrumb -->"
    case "columns":
      return renderChildren(block.children, depth + 1)
    case "syncedBlock":
      return "> synced from matter://block/" + block.ref + BLOCK_SEP
        + renderChildren(block.children, depth + 1)
    case "template":
      return `[${block.name ?? "template"}](matter://template/${block.ref})`
    case "embed":
      return `[embed](${block.url})`
    /* v8 ignore next 2 -- 穷尽闸：运行期不可达 */
    default:
      return assertNever(block)
  }
}

/** 按 A/B/C 词表把块收窄到分组子联合（谓词派生自词表，无手写镜像）。 */
function isABlock(block: Block): block is BlockA {
  return (A_BASIC_TYPES as readonly string[]).includes(block.type)
}
/** 是否 B 组块。 */
function isBBlock(block: Block): block is BlockB {
  return (B_BUSINESS_TYPES as readonly string[]).includes(block.type)
}
/**
 * 单块渲染：两组谓词分派。前两组为 `if`，C 组取「排除 A、B 后的剩余类型」——
 * 三词表穷尽（Block = A∪B∪C）保证此处 `block` 恰收窄为 `BlockC`；新增一种 BlockType
 * 若漏进任何词表，`renderC(block)` 处 TS 类型不符当场编译红，等价于链尾 assertNever 闸，
 * 但没有运行期不可达的死分支。
 */
function renderBlock(block: Block, depth: number): string {
  if (isABlock(block)) return renderA(block, depth)
  if (isBBlock(block)) return renderB(block, depth)
  return renderC(block, depth)
}

/**
 * 单向把块树导出为 Markdown 字符串（纯函数）。
 *
 * 顶层块以空行分隔；容器子节点按层缩进 2 空格；富文本 marks 按固定优先级包裹。
 * 输入块不被修改。有损点见模块头注「损失清单」。
 * @param blocks - 顶层块数组（空数组 ⇒ 空字符串）。
 * @returns Markdown 文本。
 */
export function exportMarkdown(blocks: Block[]): string {
  return renderBlocks(blocks, 0)
}
