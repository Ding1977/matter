#!/usr/bin/env node
// ISS-577 · B5 机制半刀：Tailwind 工具类「新代码零容忍」门禁（不碰界面，只立闸）
// 判据（老板 10-03 裁「甲 + 新代码零容忍」；缺后半句则棘轮等于永远不动）：
//   T1 基线名单外的文件出现工具类 ⇒ 红（新文件一律不许再用 Tailwind）
//   T2 名单内文件的命中数**上升** ⇒ 红（存量只降不升）
//   T3 名单内文件命中数下降 ⇒ 提醒（该清账），清零后应从名单移除（否则成化石）
//   T4 名单本身读不到 / 源码树为空 ⇒ 明说「不判」，不许报「零问题」
// 用法：node scripts/no-new-tailwind.mjs [--write-baseline | --selftest | --verbose]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ARGS = process.argv.slice(2);
const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");
const BASELINE = path.join(REPO, "scripts/baseline/tailwind-files.json");

// 工具类判定：只看 className 字符串里的 Tailwind 形态（不用「含 flex 就算」这种会误伤 CSS 的写法）
//
// ★ 2026-10-05 修假阳性（canvas 那 21 处「存量债」全为此而来）：旧正则用 `\b` 结尾、**无起始锚** ⇒
//   在类名**中间**就命中 —— `rs-grid` 的 `grid`、`canvas-grid-bg` 的 `grid`、
//   `cs-v-border-label` 的 `border-l`、`cs-viz-frame` 的 `z-frame` 全被当成 Tailwind 工具类。
//   后果不是"多数一条"，而是**存量盘点失真**：自有语义类越多，假债越多（canvas 21 处无一为真）。
//
// 新判据：工具类 token 必须落在**片段边界**上。片段 = 按变体冒号 `:` 与斜杠修饰 `/` 切开的段，
//   每段要求 token 出现在**段首**，且其后只能是数值/档名/结束（不许再接连字符单词）。
//   这样：`md:flex` ✅（段 `flex`）、`bg-primary/5` ✅（段 `primary` 落在 bg- 之后）、
//        `hover:bg-white` ✅、`-mt-4` ✅（负值前缀）、`flex` ✅；而 `rs-grid` ❌、`cs-viz-frame` ❌。
//   ⚠️ 词表**逐项**给出后缀形态，不做 `[a-z-]*` 这类贪婪收尾 —— 那等于把"任何以 gap- 开头的串"都放行。
//
// ⚠️ 2026-10-05 第二轮（**自查抓到的漏报，必须记**）：首版把 `border`/`rounded`/`ring` 等塞进同一条
//   「档名白名单」正则，后缀集太窄 ⇒ **漏掉一批真 Tailwind 类**：`border-border`（语义色）、
//   `border-dashed`（样式）、`border-l-2`（边+宽）、`border-amber-400`、`max-w-4xl`、`rounded-xs`、
//   `outline-hidden`。用「旧判命中 ∩ 新判不命中」差集自查抓到 55 种候选。
//   ⇒ 颜色类必须**按调色板名逐个认**（不能用 `[a-z]+` —— 那会把自有类 `border-w` 又放进来的，
//      本仓 canvas 真有这个类）。这条纪律与首版修假阳性是**两个方向**的同一件事：
//      **既要挡住子串误报，又不能因噎废食漏掉真类**。
//
// ⚠️⚠️ 2026-10-05 第三轮（**独立审查 C1 抓到，比我自查的更根本**）：第二轮的手写白名单**仍漏 15.8%** ——
//   拿 Tailwind **编译产物**（`forge-ui/dist/tailwind.css`，961 个真实定义）当 oracle 实测漏 **152 种**，
//   成族丢失：`text-left/center/right`（**不是字号**）· `text-muted-foreground`（语义色）·
//   `animate-spin/ping/pulse` · `aspect-*` · `backdrop-*` · `bg-gradient-to-*` · `table-*` · `stroke-*` ·
//   `fill-*` · `rotate-*` · `origin-*` · `ms-*/me-*`（逻辑方向间距）。
//   **为什么是 critical 而非"少报几条"**：T1（新文件零容忍）与 T2（存量只降不升）**两个方向同时失效** ——
//   新写的 `className="text-left animate-spin"` 现算 0 处、门禁判绿放行（独立审查已在沙箱复现）。
//   ⚠️ **教训（比修法更重要）**：人工差集自查会**系统性低估**（第二轮抓到 55 种、自以为够了，
//      oracle 口径实际 152 种）⇒ 判据完整性**必须用客观 oracle 量，不能靠人肉枚举**。
//      本文件 `--selftest` 因此新增一条**以编译产物为 oracle** 的用例（漏一个即红），见文件末尾。
//
// 色名来源 = **权威 `@theme` 派生**，不再手写猜测。
//   ⚠️ 只列两个文件不够（`bg-container` 就漏了 —— 它的 `--color-container` 定义在别的样式表里）
//   ⇒ 改成**全仓扫 `--color-*`**（与 `scan()` 同一批包，口径一致）。
/** 从全仓样式/源码现读 `--color-*` 色名（读不到 ⇒ 退回内置兜底；selftest 有一条钉"读得到"） */
function twThemeColors() {
  const out = new Set()
  const SKIP_DIR = new Set(["node_modules", "dist", "out", "build", ".git", ".wt", "coverage", "static"])
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name), depth + 1); continue }
      if (!/\.(css|tsx?|jsx?)$/.test(e.name)) continue
      let t
      try { t = fs.readFileSync(path.join(dir, e.name), "utf8") } catch { continue }
      for (const m of t.matchAll(/--color-([a-z][a-z0-9-]*)\s*:/g)) out.add(m[1])
    }
  }
  for (const d of fs.readdirSync(REPO)) {
    if (/^(forge-|matter-)/.test(d) && fs.existsSync(path.join(REPO, d, "src"))) walk(path.join(REPO, d, "src"), 0)
  }
  return out
}
const TW_COLORS = new Set([
  // Tailwind 默认调色板
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green",
  "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
  // 特殊值
  "white", "black", "transparent", "current", "inherit", "none", "auto",
  // 本项目 @theme 色名（**现读权威源**，不再手写猜测）
  ...twThemeColors(),
  // 兜底（权威文件读不到时仍能判；与上面重名无妨）
  "primary", "secondary", "accent", "muted", "destructive", "border", "ring", "input", "background",
  "foreground", "card", "popover", "sidebar", "danger", "success", "warning", "info", "brand",
  "ok", "warn", "sev-error", "sev-warn", "sev-ok",
]);
/** 颜色尾：调色板名（可带色阶 / `-foreground` 等复合尾）或 arbitrary 值。**逐名认**，不用通配。 */
function isColorTail(s) {
  if (/^\[[^\]]+\]$/.test(s)) return true
  if (TW_COLORS.has(s)) return true
  // 复合：`muted-foreground` / `primary-foreground` / `sidebar-border` / `sev-error` / `amber-400`
  const parts = s.split("-")
  for (let i = parts.length - 1; i >= 1; i--) {
    const head = parts.slice(0, i).join("-")
    const tail = parts.slice(i).join("-")
    if (TW_COLORS.has(head) && /^(?:[0-9]{2,3}|foreground|background|border|primary|accent|ring|muted|error|warn|ok)$/.test(tail)) return true
  }
  return false
}
/** 档名（none/full/xs…6xl/数字/arbitrary）——rounded-2xl / shadow-lg / border-0 都用它 */
const isStepTail = (s) => /^(?:none|full|xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|inner|outer|\d+(?:\.\d+)?|\[[^\]]+\])$/.test(s)
/** 边方向：l/t/r/b/x/y/s/e，可连写两位（rounded-tl / border-xy） */
const isSideTail = (s) => /^[ltrbxyse]{1,2}(?:-(?:\d+|\[[^\]]+\]))?$/.test(s)
const TW_SEGMENTS = {
  // 纯关键字（整段就是它）
  bare: new Set(["flex", "grid", "block", "inline-flex", "inline-block", "inline", "hidden", "contents", "table",
    "flex-1", "flex-auto", "flex-initial", "flex-none", "flex-row", "flex-row-reverse", "flex-col", "flex-col-reverse",
    "flex-wrap", "flex-nowrap", "flex-wrap-reverse", "grow", "grow-0", "shrink", "shrink-0", "basis-full",
    "absolute", "relative", "fixed", "sticky", "static", "truncate", "italic", "not-italic", "underline",
    "overline", "line-through", "no-underline", "uppercase", "lowercase", "capitalize", "normal-case",
    "antialiased", "sr-only", "not-sr-only", "border", "rounded", "shadow", "outline-none", "ring",
    // 标记类（第五轮 low-a：原来判 false ⇒ fail-open，新文件只写它会被静默放行；仓内 `sidebar.tsx:217` 真在用）
    "group", "peer",
    "shadow-sm", "shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl", "shadow-inner", "shadow-none",
    // oracle 实测仍缺的一族（都是产物里真有规则的真类）
    "visible", "invisible", "collapse", "isolate", "isolation-auto", "resize", "resize-none",
    "container", "flow-root", "inline-grid", "inline-table", "flex-grow", "flex-shrink",
    "grayscale", "invert", "sepia", "blur", "filter", "transform", "transform-gpu", "transform-none",
    "w-max", "w-min", "h-svh", "h-lvh", "h-dvh", "w-svw", "w-lvw", "w-dvw", "min-w-max", "max-w-max",
    "caption-top", "caption-bottom", "diagonal-fractions", "tabular-nums", "ordinal"]),
  // 前缀 + 数值/档位（段首匹配，后缀受控）
  prefixed: [
    /^(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|w|h|min-w|min-h|max-w|max-h|top|left|right|bottom|inset|inset-x|inset-y|space-x|space-y|translate-x|translate-y|size|blur|backdrop-blur|aspect|basis|columns|indent|scroll-m|scroll-p)-(\[[^\]]+\]|\d+(?:\.\d+)?(?:\/[0-9]+)?|px|full|screen|auto|fit|xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|none|prose|square|video)$/,
    // text-*：**字号不是唯一一族**。独立审查 C1 抓到首版只认字号 ⇒ 对齐/换行/语义色全漏。
    /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|\[[^\]]+\])$/,
    /^text-(left|center|right|justify|start|end)$/,
    /^text-(ellipsis|clip|wrap|nowrap|balance|pretty)$/,
    /^font-(mono|sans|serif|bold|medium|semibold|normal|light|thin|extrabold|black|\d{3}|\[[^\]]+\])$/,
    /^(?:items|justify|content|self|place-items|place-content|place-self)-(center|start|end|between|around|evenly|baseline|stretch|auto)$/,
    /^(?:items|justify|content|self|place-items|place-content|place-self)-(center|start|end|between|around|evenly|baseline|stretch|auto)$/,
    // ⚠️ 这条原来尾随 `[a-z0-9-]+`（＝"任何以这些前缀开头的串都放行"）⇒ 实测误报
    //   `break-badge` / `scroll-badge` / `resize-badge` 等自有语义类。
    //   改为 **oracle 实测的真值集**（每族尾值有限，逐项列出；`[^\]]+` 留给 arbitrary）。
    /^overflow-(?:auto|clip|hidden|visible|x-auto|x-clip|x-hidden|x-visible|y-auto|y-clip|y-hidden|y-visible)$/,
    /^whitespace-(?:nowrap|pre|pre-line|pre-wrap|normal|break-spaces)$/,
    /^break-(?:all|words|normal|keep)$/,
    /^object-(?:contain|cover|fill|none|scale-down)$/,
    /^align-(?:middle|baseline|top|bottom|text-top|text-bottom|sub|super)$/,
    /^(?:float|clear)-(?:left|right|both|none|start|end)$/,
    /^isolate(?:-auto)?$/,
    /^pointer-events-(?:auto|none)$/,
    /^select-(?:none|text|all|auto)$/,
    /^resize(?:-(?:none|x|y))?$/,
    // oracle 实测真值（第五轮 low-a：原来 `[a-z-]+` 通配 ⇒ `cursor-panel` 这类自有类会被吃）
    /^cursor-(?:auto|default|pointer|wait|text|move|help|not-allowed|none|context-menu|progress|cell|crosshair|vertical-text|alias|copy|no-drop|grab|grabbing|all-scroll|col-resize|row-resize|n-resize|e-resize|s-resize|w-resize|ne-resize|nw-resize|se-resize|sw-resize|ew-resize|ns-resize|nesw-resize|nwse-resize|zoom-in|zoom-out)$/,
    /^list-(?:decimal|disc|item|none|inside|outside)$/,
    /^appearance-(?:none|auto)$/,
    /^will-change-(?:auto|scroll-position|contents|transform)$/,
    /^touch-(?:auto|none|pan-x|pan-left|pan-right|pan-y|pan-up|pan-down|pinch-zoom|manipulation)$/,
    /^snap-(?:none|x|y|both|start|end|center|align-none|align-start|align-end|center|always|normal|mandatory|proximity)$/,
    /^grid-cols-(?:\d+|none|subgrid|\[[^\]]+\])$/,
    /^grid-rows-(?:\d+|none|subgrid|\[[^\]]+\])$/,
    /^col-span-(?:\d+|full)$/,
    /^row-span-(?:\d+|full)$/,
    /^transition(?:-(?:all|colors|opacity|shadow|transform|none|\[[^\]]+\]))?$/,
    /^(?:duration|delay|ease|opacity|z|order|basis|leading|tracking)-?(?:none|full|sm|md|lg|xl|2xl|3xl|\d+(?:\.\d+)?|\[[^\]]+\]|auto|tight|snug|normal|relaxed|loose|in|out|in-out|linear)?$/,
    // 独立审查 C1 补齐的族（编译产物 oracle 实测漏掉的）
    /^animate-(?:none|spin|ping|pulse|bounce|\[[^\]]+\])$/,
    /^line-clamp-(?:\d+|none)$/,
    /^tabular-(?:nums|normal)$/,
    /^underline-offset-(?:\d+|auto|\[[^\]]+\])$/,
    // ⚠️ 以下四条的尾随**不再用 `[a-z0-9-]+`（那等于"任何以 X- 开头的串都放行"，实测吃掉
    //   `stroke-w` / `fill-badge` / `table-w` / `break-badge` / `scroll-badge` / `rotate-badge` /
    //   `resize-badge` / `mask-fade` 等自有语义类）** —— 改成 **oracle 实测的真值集**（数据驱动，不靠我猜）。
    /^(?:rotate|scale|skew|translate|origin|perspective)-(?:\d+(?:\.\d+)?|x-px|y-px|center|top|bottom|left|right|\[[^\]]+\])$/,
    /^stroke-(?:border|current|info|none|\[[^\]]+\])$/,
    /^fill-(?:current|info|muted|none|\[[^\]]+\])$/,
    /^table-(?:caption|cell|column|column-group|footer-group|header-group|row|row-group)$/,
    /^columns-(?:\d+|auto|\[[^\]]+\])$/,
    /^break-(?:all|words|normal|\[[^\]]+\])$/,
    /^ring-offset-(?:\d+|\[[^\]]+\])$/,
    // ⚠️⚠️ 第四轮终审 high-1：这两条原来尾随 `(.+)` / 任意词 ⇒ **把自有语义类吃进来**
    //   （实测误报：`to-canvas`（它在 `code-sidebar.tsx:85` 有真实 CSS 定义、全仓无 `--color-canvas`、
    //   oracle 里也没有）/ `from-panel` / `via-toolbar` / `to-badge` / `stroke-w` / `rotate-badge` …）。
    //   后果与第 3 轮同形：**T1/T2 双假红**，能挡住正常新代码，且**已把 `to-canvas` 污染进基线**。
    //   正解 = 尾随必须是 **颜色（调色板名 / 语义名 / arbitrary）**，不是"随便什么词"：
    //   oracle 实测 `from-*`/`via-*`/`to-*` 的真值只有 `.from-muted`/`.to-muted`/`.via-muted` 这类**色名**。
    //   （下方 `isTwSegment` 里单独处理，见那里的 `from|via|to` 分支。）
    /^bg-(?:gradient-to-(?:t|tr|r|br|b|bl|l|tl)|clip-[a-z]+|none|fixed|local|scroll|center|top|bottom|left|right|repeat|no-repeat|cover|contain)$/,
    // 长尾（oracle 实测各 1 种；均为产物里真有规则的真类）
    /^container$/,
    /^(?:inline-grid|inline-table|flow-root|flex-grow|flex-shrink|inline-flex)$/,
    /^(?:grayscale|invert|sepia|blur|brightness|contrast|saturate|hue-rotate|drop-shadow)$/,
    /^(?:filter|transform|transform-gpu|transform-none)$/,
    /^(?:caption-top|caption-bottom)$/,
    /^(?:underline-offset|outline-offset|ring-offset)-(?:\d+|auto|\[[^\]]+\])$/,
    /^(?:row|col)-(?:\d+|auto|span-\d+)$/,
    /^text-(?:micro|mini)$/,
    /^(?:mask-repeat|field-sizing-content|diagonal-fractions)$/,
    /^(?:blur|resize)-(?:none|sm|md|lg|xl|2xl|3xl|y|x|\[[^\]]+\])$/,
    /^(?:flex-grow|flex-shrink)-?(?:\d+)?$/,
    /^tracking-(?:tighter|tight|normal|wide|wider|widest|\[[^\]]+\])$/,
    /^backdrop-(?:blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia|filter)(?:-(?:none|sm|md|lg|xl|2xl|3xl|\d+)|\[[^\]]+\])?$/,
    // `scroll-*` 只认它真正的那几个族（oracle 实测：`scroll-my-1` / `scroll-py-1` / `scroll-m*`/`scroll-p*`）
    /^scroll-(?:m|mx|my|mt|mr|mb|ml|ms|me|p|px|py|pt|pr|pb|pl|ps|pe)-(?:\d+(?:\.\d+)?|px|\[[^\]]+\])$/,
    // ⚠️ 这里**不要**再放 `/^from-|^via-|^to-/`（第四轮终审 high-1 的元凶）：
    //   `from|via|to` 已在下方 `isTwSegment` 的分支里、且尾部要过 `isColorTail` ⇒ 只有色名才放行
    //   （oracle 实测真值 = `.from-muted`/`.to-muted`/`.via-muted`）。写成"前缀即命中"会把
    //   自有语义类 `to-canvas` / `from-panel` / `via-toolbar` 全吃进来。
  ],
};
/** 段 → 是否 Tailwind 工具类（含 border/rounded/ring/shadow 的「前缀+颜色/样式/边+宽」三大形态） */
function isTwSegment(s) {
  if (TW_SEGMENTS.bare.has(s)) return true
  if (TW_SEGMENTS.prefixed.some((re) => re.test(s))) return true
  // rounded-* / border-* / ring-* / outline-* / shadow-* / divide-*：前缀确定后，尾部分类判
  const m = /^(ring-offset|placeholder|decoration|rounded|border|ring|outline|shadow|divide|bg|text|fill|stroke|from|via|to|accent|caret)(?:-(.+))?$/.exec(s)
  if (!m) return false
  const [, head, tail] = m
  if (tail === undefined) return ["rounded", "border", "ring", "shadow", "outline", "divide"].includes(head)
  // ① 颜色尾（border-border / bg-primary / text-white / border-amber-400 / border-sidebar-border）
  if (isColorTail(tail)) return true
  // ② 档名尾（rounded-xs / rounded-2xl / shadow-lg / border-0）
  if (isStepTail(tail)) return true
  // ③ 样式尾（border-dashed / border-dotted / border-solid / border-double / outline-hidden / outline-dashed）
  if (/^(?:dashed|dotted|double|solid|hidden|wavy|groove|ridge|inset|outset|collapse|separate|nowrap|wrap|balance|pretty|clip|ellipsis)$/.test(tail)) return true
  // ④ 边 + 可选宽度（border-l / border-t / border-l-2 / border-x-4）；**只认 l/t/r/b/x/y/s/e 六个边字母**
  //    —— `border-w` 这类自有类因此天然不命中（`w` 不在边字母集里）
  if (isSideTail(tail)) return true
  // ⑤ 边 + 档名（rounded-t-sm / rounded-tl-lg / border-t-2 已由 ④ 覆盖）
  const sideStep = /^([ltrbxyse]{1,2})-(.+)$/.exec(tail)
  if (sideStep && (isStepTail(sideStep[2]) || isColorTail(sideStep[2]))) return true
  return false
}
/** 一个 className token 是不是 Tailwind 工具类（分段判，token 必须在段首） */
function isTailwindClass(cls) {
  if (!cls) return false
  // 变体前缀（md: / hover: / [&_x]: …）与斜杠修饰（bg-primary/5）：逐段判，**任一段**命中即算工具类
  // （变体前缀本身可能很长，如 `[&_[cmdk-group-heading]]:font-medium` —— 只判最后一段会是漏判）
  // `!` 是 important 修饰，可写在**段首**（`!visible`，Tailwind v3 风格）或**段尾**（`size-3!`，v4 风格）；
  //   负号前缀只在段首。两处都剥掉再判。
  const segs = cls.replace(/^!/, "").replace(/^-/, "").split(/[:/]/).filter(Boolean);
  for (const seg of segs) {
    const s = seg.replace(/^-/, "").replace(/!$/, "");
    if (isTwSegment(s)) return true
  }
  /* arbitrary 值（独立审查第二轮 low-1 抓到的残余盲区）：Tailwind 的任意值语法是 `前缀-[任意值]`，
     如 `aspect-[3/1]` · `[corner-shape:round]` · `[transform-box:fill-box]` · `[&_section]:!mt-3`。
     **为什么单独一条**：上面按 `:` `/` 切段会把方括号里的 `:` `/` 也切碎，段首白名单自然认不出。
     ⚠️⚠️ **独立审查第三轮 high-a 抓到我第一版的假阳性（我引入的）**：原先写成 `/\[[^\]\s]*\]/`，
     只要求"含方括号" ⇒ **JS 索引表达式**（`TONE_TEXT[tone]` / `MAP[key]` / `SEC_H[kind]` /
     `CODE_TONE[r.code]` / `MARKET_STATUS_META[marketStatus]`）全被误判成 Tailwind（实测全仓 **7 处/4 文件**），
     且能造成 **T1 假红**：新建一个只含 `className={cn("tabular-nums", TONE[tone])}` 的文件即 exit 2。
     我上一版注释写的"JS 表达式都不含方括号"是**假保证** —— 我只验了 `cns.absolute`/`s.flexColEnd`
     这类**点号**形态，漏了**索引**形态。这就是"反向钉只测了一半"的现场。
     **正解**：方括号必须是**段首**（`^[`，纯 arbitrary 如 `[corner-shape:round]`）
     或**紧跟 `-`**（`-[`，带前缀的 arbitrary 如 `aspect-[3/1]` / `data-[state=open]`）；
     `标识符[` 一律不算（那是 JS 取下标）。
     代价：arbitrary 值在 **CSS 产物里是转义形态**（`aspect-\[3\/1\]`），oracle 侧无法可靠还原，
     故它**不参与 oracle 守卫**（守卫口径仍排除含 `[]` 的类）—— 这条靠本判据 + 双向用例覆盖。
     全仓实测量：真类 arbitrary 21 处 / 8 文件；JS 索引 7 处 / 4 文件（后者必须**不**命中）。 */
  // ⚠️ 必须在**未切分的原串**上判（两级都是）：
  //    ① 方括号里含 `:` `/`（`[corner-shape:round]` / `aspect-[3/1]`）⇒ 先按分隔符切段会把它们切碎；
  //    ② 但"含方括号"又不能当充分条件（JS 的 `TONE_TEXT[tone]` 也含）⇒ 要求 `[` 出现在
  //       **段首或紧跟 `-`**，且 `[` 前不能是标识符字符（排除 `标识符[`）。
  //    故顺序：先在原串上判 arbitrary，再回到逐段白名单。
  const 原串 = cls.replace(/^!/, "")
  // ① 纯 arbitrary 段：整串以 `[` 开头、或某变体段（按 `:` 切）以 `[` 开头 —— `[corner-shape:round]`
  if (/^\[[^\]\s]*\]/.test(原串)) return true
  for (const piece of 原串.split(":")) if (/^\[[^\]\s]*\]/.test(piece)) return true
  // ② 前缀-[…] 形态：`aspect-[3/1]` / `data-[state=open]`（`[` 紧跟 `-`，且前面是合法前缀，不是标识符下标）
  if (/(?:^|[:/])-?[A-Za-z][A-Za-z0-9-]*-\[[^\]\s]*\]/.test(原串)) return true
  // ③ v4 CSS 变量简写：`w-(--sidebar-width)` / `origin-(--radix-tooltip-content-transform-origin)`
  //    （第五轮 low-a：原来判 false ⇒ fail-open；oracle 实测 5 个，仓内真在用 3 个）
  //    形态 = `前缀-(--变量名)`；变量名限定 CSS 自定义属性字符集，避免把 `fn-(x)` 这类表达式吃进来。
  if (/(?:^|[:/])-?[A-Za-z][A-Za-z0-9-]*(?:-(?:[A-Za-z][A-Za-z0-9-]*))?-\(--[A-Za-z0-9-]+\)(?:\/[0-9.]+)?$/.test(原串)) return true
  return false
}
function hitsIn(text) {
  let n = 0;
  for (const m of text.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{([\s\S]{0,400}?)\})/g)) {
    const raw = (m[1] || m[2] || m[3] || m[4] || "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const cls of raw.split(/[\s`'"]+/)) if (isTailwindClass(cls)) n++;
  }
  return n;
}

// **归属排除**：只扫我们自己的包（forge-*/matter-* 的 src 半）。
// 否则别人的未跟踪目录（`.refs/`、learning 里的样例、别人的工作树）会被算成「新代码」，
// 门禁替别人认账 —— 这条在第一版就红了 182 条，全是别人的文件。
const PKGDIR = /^(forge-|matter-)/;
const SKIP = new Set(["node_modules", "dist", "out", "build", ".git", ".wt", "coverage"]);
function scan(repo) {
  const out = new Map();
  let scanned = 0; // 扫到几个 tsx/jsx 文件：用来分清「已清零」与「根本没扫到」——混为一谈会把清零读成「不判」
  const tops = fs.readdirSync(repo, { withFileTypes: true })
    .filter((e) => e.isDirectory() && PKGDIR.test(e.name) && fs.existsSync(path.join(repo, e.name, "src")))
    .map((e) => path.join(repo, e.name, "src"));
  const stack = [...tops];
  while (stack.length) {
    const d = stack.pop();
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(f); continue; }
      if (!/\.(tsx|jsx)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      let n; try { n = hitsIn(fs.readFileSync(f, "utf8")); } catch { continue; }
      scanned++;
      if (n > 0) out.set(path.relative(repo, f), n);
    }
  }
  out.scanned = scanned;
  return out;
}

function check(repo, base) {
  const bad = [], note = [];
  if (!base || !base.files) { note.push("T4 读不到名单（先跑 --write-baseline）⇒ 不判，别当零问题"); return { bad, note, total: 0 }; }
  const live = scan(repo);
  if (!live.scanned) {
    note.push("T4 一个 tsx/jsx 都没扫到 ⇒ 不判（多半是树不对，不是「已清零」）"); return { bad, note, total: 0 };
  }
  let total = 0;
  for (const [f, n] of live) {
    total += n;
    const prev = base.files[f];
    if (prev === undefined) bad.push(`T1 名单外文件含 Tailwind 工具类 ${n} 处：${f} ⇒ 新代码请用 CSS Modules（官方基元 39 件各带一份 module.css，同一写法）`);
    else if (n > prev) bad.push(`T2 ${f} 命中数上升 ${prev} → ${n}（存量只降不升）`);
    else if (n === 0) note.push(`T3 ${f} 已清零 ⇒ 应从名单移除（留着就是化石）`);
    else if (n < prev) note.push(`T3 ${f} 下降 ${prev} → ${n}（继续）`);
  }
  for (const f of Object.keys(base.files)) if (!live.has(f) && base.files[f] > 0) note.push(`T3 名单里的 ${f} 已不在扫描面（删了或清零）⇒ 该清账`);
  return { bad, note, total };
}

function selftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nnt-"));
  const mk = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  let pass = 0, fail = 0;
  // 第三参是「实际是什么」：独立审查第二轮 low-2 抓到它原来被丢弃（守卫红了却不点名漏了哪些类）。
  const t = (n, c, d) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); if (d) console.log("      ↳ " + d); } };
  const base = { files: { "forge-demo/src/a/b.tsx": 3 } };
  const run = () => check(root, base);

  mk("forge-demo/src/a/b.tsx", 'export const X = () => <div className="flex items-center p-2" />;\n');
  t("名单内、计数持平 ⇒ 零报", run().bad.length === 0);
  mk("forge-demo/src/a/b.tsx", 'export const X = () => <div className="flex items-center p-2 gap-1 text-sm" />;\n');
  t("T2 计数上升要报红", run().bad.some((b) => b.startsWith("T2")));
  mk("forge-demo/src/a/new.tsx", 'export const Y = () => <div className="rounded-md bg-white" />;\n');
  t("T1 名单外新文件要报红", run().bad.some((b) => b.startsWith("T1")));
  fs.rmSync(path.join(root, "forge-demo/src/a/new.tsx")); mk("forge-demo/src/a/b.tsx", 'export const X = () => <div className="wraps" />;\n');
  t("清零后不再报红但提醒清账", run().bad.length === 0 && run().note.some((n) => n.startsWith("T3")));
  t("CSS 里的 flex 不算工具类（不误伤）", hitsIn(".a{display:flex;padding:2px}") === 0);
  /* ── 假阳性回归（2026-10-05）：自有语义类不许被算成 Tailwind ──
     这一组此前**零用例**，所以 canvas 的 21 处「存量债」全是 `rs-grid` / `canvas-grid-bg` 这类误报。 */
  t("自有语义类（含 grid/bg/border 子串）不算工具类——canvas 那 21 处假债的形状",
    ['rs-grid', 'canvas-grid-bg', 'cs-v-border-label', 'cs-viz-frame'].every((c) => isTailwindClass(c) === false));
  t("真工具类仍要命中（含变体前缀 / 斜杠修饰 / 负值 / 任意值）",
    ['flex', 'grid', 'gap-1', 'gap-1.5', 'bg-white', 'bg-primary/5', 'md:flex', 'hover:bg-white',
     '-mt-4', 'bg-[var(--x)]', 'text-xs', 'rounded-lg', 'items-center', 'justify-between',
     '[&_[cmdk-group-heading]]:font-medium'].every((c) => isTailwindClass(c) === true));
  /* ⚠️ 漏报回归（2026-10-05 第二轮）：首版把 border/rounded/ring 塞进一条窄后缀正则，
     漏掉下面这一批**真 Tailwind 类**。用「旧判命中 ∩ 新判不命中」差集自查才抓到（55 种候选）。
     教训：修子串误报**不能因噎废食** —— 判据收紧的同时必须反向扫一遍真类还在不在。 */
  t("颜色类/样式类/边类不许漏（首版漏报的回归钉）",
    ['border-border', 'border-border/60', 'border-sidebar-border', 'border-amber-400', 'border-dashed',
     'border-l-2', 'border-t', 'border-0', 'rounded-xs', 'rounded-t-sm', 'rounded-full',
     'outline-hidden', 'shadow-sm', 'max-w-4xl', 'size-4', 'text-[11px]', 'hover:bg-accent',
     'bg-[#1a7f37]/10', 'flex-col', 'flex-1', 'transition-colors', 'overflow-hidden'].every((c) => isTailwindClass(c) === true));
  t("自有语义类与 JS 表达式仍不许误判（与上一条同批：两个方向都要钉）",
    ['rs-grid', 'cs-grid', 'canvas-grid-bg', 'cs-v-border-label', 'cs-viz-frame', 'border-w',
     'cns.absolute', 's.flexColEnd', 'cns.gridCenter', 's.flexCenterGap10'].every((c) => isTailwindClass(c) === false));
  t("非工具类的普通自造类/拼写近似不算（防矫枉过正）",
    ['wraps', 'noCollapse', 'rowBetween', 'ellipsis', 'cardGrid', 'my-panel', 'btn-primary'].every((c) => isTailwindClass(c) === false));
  /* arbitrary 值族（独立审查第二轮 low-1）：`前缀-[任意值]` 与纯 `[任意值]` 形态。
     首版按 `:` `/` 切段会把方括号里的分隔符切碎 ⇒ 整族漏判（本轮实测全仓 15 处 / 8 文件）。 */
  t("arbitrary 值形态必须命中（aspect-[3/1] / [corner-shape:round] / [&_h2]:!text-sm …）",
    ['aspect-[3/1]', '[corner-shape:round]', '[transform-box:fill-box]', '[transform-origin:center]',
     '[&_section]:!mt-3', '[&_h2]:!text-sm', 'bg-[#1a7f37]/10', 'text-[11px]',
     'data-[state=open]:bg-accent'].every((c) => isTailwindClass(c) === true));
  t("放宽 arbitrary 后自有类/JS 表达式仍不许误判（同批的反向钉，防这一放宽引入误报）",
    ['rs-grid', 'cs-grid', 'canvas-grid-bg', 'border-w', 'cns.absolute', 's.flexColEnd',
     'wraps', 'cardGrid', 'btn-primary'].every((c) => isTailwindClass(c) === false));
  /* ⚠️ **独立审查第三轮 high-a 的回归钉**：我第一版 arbitrary 规则写成"含方括号即命中"，
     把 **JS 索引表达式**误判成 Tailwind（`TONE_TEXT[tone]` / `MAP[key]` / `SEC_H[kind]` /
     `CODE_TONE[r.code]` / `MARKET_STATUS_META[marketStatus]` / `LEVEL_GRAYS[levelOfPct(pct)]`，
     实测全仓 7 处 / 4 文件），后果是 **T1 假红** —— 新建一个只含 `className={cn("tabular-nums", TONE[tone])}`
     的文件就 exit 2，**能阻断正常新代码**。
     我上一版注释写"JS 表达式都不含方括号"是**假保证**：只验了点号形态（`cns.absolute`），漏了索引形态。
     ⇒ 这一条把"索引形态必须不命中"钉成用例，**防止下次再靠半个反向钉自证**。 */
  t("JS 索引表达式（标识符[下标]）不许被当成 Tailwind arbitrary —— 第三轮 high-a 的回归钉",
    ['TONE_TEXT[tone]', 'MAP[key]', 'SEC_H[kind]', 'CODE_TONE[r.code]',
     'MARKET_STATUS_META[marketStatus]', 'LEVEL_GRAYS[levelOfPct(pct)]']
      .every((c) => isTailwindClass(c) === false));
  /* ⚠️⚠️ **第四轮终审 high-1 的回归钉 —— 这是 K7h 在同一批里的第 4 次现场**。
     第 3 轮我修 arbitrary 时只验了"JS 索引不命中"，**没反向验"放宽 `to-` 后自有类会不会被吃"**
     ⇒ `to-`/`from-`/`via-` 写成"前缀即命中"，把自有语义类 `to-canvas`
     （它在 `code-sidebar.tsx:85` 有真实 CSS 定义、全仓无 `--color-canvas`、oracle 里也没有）判成 Tailwind
     ⇒ **T1/T2 双假红**（新建只含它的文件 exit 2；正常新增第 5 处 exit 2），且**已污染基线**。
     同类过宽还吃到：`from-panel` / `via-toolbar` / `to-badge` / `stroke-w` / `fill-badge` /
     `table-w` / `break-badge` / `scroll-badge` / `rotate-badge` / `resize-badge` / `mask-fade`（共 12 个形态）。
     修法 = 尾部必须过 `isColorTail` 或走 oracle 实测真值集。**这一条两个方向都钉**：
     自有形态不命中（下）+ 真 Tailwind 仍命中（再下）。 */
  t("`to-`/`from-`/`via-` 与 stroke/fill/table/break/scroll/resize 等前缀**不许吃自有语义类**（第 4 次现场的回归钉）",
    ['to-canvas', 'from-panel', 'via-toolbar', 'to-badge', 'stroke-w', 'fill-badge',
     'table-w', 'break-badge', 'scroll-badge', 'rotate-badge', 'resize-badge', 'mask-fade']
      .every((c) => isTailwindClass(c) === false));
  t("同批反向：这些族的**真** Tailwind 必须仍命中（收窄不许收过头 —— K7h 的另一半）",
    ['from-blue-500', 'via-white/50', 'to-transparent', 'to-muted/80', 'from-muted', 'via-muted',
     'stroke-info', 'fill-none', 'table-cell', 'break-words', 'rotate-90', 'scale-110',
     'resize-y', 'scroll-my-1', 'ring-offset-background', 'blur-sm', 'backdrop-blur-sm']
      .every((c) => isTailwindClass(c) === true));
  /* 第五轮低级别遗留的三条 fail-open（独立审查新找，均**不挡正常代码**故列为 low，但顺手补齐）：
     ① `cursor-*`/`will-change-*`/`touch-*`/`snap-*` 原来是通配前缀 ⇒ `cursor-panel` 这类自有类会被吃；
     ② `group`/`peer` 是 Tailwind **标记类**（仓内 `forge-design/src/ui/sidebar.tsx:217` 真在用），原来判 false；
     ③ v4 **CSS 变量简写** `w-(--sidebar-width)` / `origin-(--radix-…)`，oracle 里 5 个、仓内真在用 3 个。 */
  t("cursor/will-change/touch/snap 首尾两侧都要对（真值命中、自有类不命中）",
    ['cursor-pointer', 'cursor-grab', 'cursor-not-allowed', 'touch-none'].every((c) => isTailwindClass(c) === true) &&
    ['cursor-panel', 'cursor-badge', 'touch-panel', 'snap-row', 'will-change-x'].every((c) => isTailwindClass(c) === false));
  t("Tailwind 标记类 group/peer 要命中（原来 fail-open）",
    ['group', 'peer'].every((c) => isTailwindClass(c) === true));
  t("v4 CSS 变量简写 `前缀-(--var)` 要命中（oracle 实测 5 个）",
    ['w-(--sidebar-width)', 'max-w-(--skeleton-width)',
     'max-h-(--radix-context-menu-content-available-height)',
     'origin-(--radix-tooltip-content-transform-origin)',
     'origin-(--radix-context-menu-content-transform-origin)'].every((c) => isTailwindClass(c) === true));
  /* ISS-719：`ordinal` 是 `font-variant-numeric` 族的真 Tailwind 类，产物里有、白名单漏了
     ⇒ **判据知识缺一项**（不是判据太严）。上面的 oracle 守卫是"漏了会红"的总闸，这条把
     **双向**钉成单点用例：补进来的类必须命中，而且**收窄必须仍然收得住**（`ordinal-x` /
     `my-ordinal` 这类自有语义类不许被新加的这行顺手放进去）。 */
  t("`ordinal` 与同族 `tabular-nums` 必须命中（ISS-719：白名单漏真工具类）",
    ['ordinal', 'tabular-nums', 'diagonal-fractions'].every((c) => isTailwindClass(c) === true));
  t("补 `ordinal` 后自有语义类仍不许误判（同批的反向钉）",
    ['ordinal-x', 'my-ordinal', 'ordinal-custom', 'ordinalList'].every((c) => isTailwindClass(c) === false));
  /* ★★ 以**编译产物为 oracle** 的完整性守卫（独立审查 H1/C1 的直接落地）。
     为什么必须有这一条：人工白名单**系统性低估** —— 本判据第二轮自查"抓到 55 种、以为够了"，
     oracle 口径实际 **152 种**（15.8%），且 T1/T2 两个方向同时失效（新写的真 Tailwind 静默放行）。
     判据：产物里定义过的每个工具类，`isTailwindClass` 都必须认。
       ① 产物读不到 ⇒ **不判**（明说，不算通过、也不算失败 —— CI 无产物是常态）；
       ② 产物读得到 ⇒ 漏一个即红，并把漏掉的类名印出来（下一个人直接照单补）。
     oracle 口径（**独立审查第二轮 critical-1 纠正，此前口径是错的**）：
       **只用 `forge-tailwind/dist/tailwind.css` 这一份**。理由三条，都是实测：
         ① 它是**全仓唯一供给源**（`forge-tailwind` 就是那张共享样式表的家），产物最全（655 类）；
         ② 别的包的产物里含**自有语义类**（`matter-linear-root` / `pm-sm-inline` / `fni-toast-in` /
            `matter-limits-dock` … 实测 14 个）—— 它们不是 Tailwind 工具类，混进 oracle 会让守卫**假红**；
         ③ `forge-ui/dist/tailwind.css` 是**墓碑**（该包的 tailwind 编译 2026-10-04 已删，
            `scripts/build-client.mjs` 搜 `tailwindcss` = 0 命中）⇒ 拿它当 oracle 在 CI 上不成立。
       ⚠️ 我上一轮用"profiles 里那份墓碑"当 oracle 得出"漏 0"，**在 CI 形状下是假的** —— 这正是本守卫
          要防的复发形态，却被自己踩了一次。故口径写死为这一份，且**产物缺失时不判（明说）**。
       排除项：含 `:`（伪类/变体）、含 `[]()/`（arbitrary 值在 CSS 里是转义产物，oracle 侧不可靠）。 */
  const ORACLE_CSS = path.join(REPO, "forge-tailwind", "dist", "tailwind.css")
  // 缺产物时**试着自己现编一份**（独立审查第二轮建议②：否则本地永远看不到这条红 ——
  //   而 CI 跑过 build:client 才有产物，于是"本地绿、CI 红"这种最难查的形态就出现了）。
  // 编不出来 ⇒ 显式"未判"（不伪装通过），并把原因印出来。
  let oracleNote = ""
  if (!fs.existsSync(ORACLE_CSS)) {
    const built = spawnSync("bun", ["run", "build:client"], {
      cwd: path.join(REPO, "forge-tailwind"), encoding: "utf8", timeout: 120000,
    })
    if (fs.existsSync(ORACLE_CSS)) oracleNote = "（本树原缺产物，已就地现编一份用于判定）"
    else oracleNote = `（缺产物且现编失败：${String(built.stderr || built.stdout || "").trim().split("\n").slice(-1)[0] || "未知"}）`
  }
  if (!fs.existsSync(ORACLE_CSS)) {
    console.log(`  · 自检·oracle 完整性：未判 ${oracleNote}—— 手动跑 cd forge-tailwind && bun run build:client 后再看`)
  } else {
    const css = fs.readFileSync(ORACLE_CSS, "utf8")
    const defined = new Set()
    for (const m of css.matchAll(/^\.((?:[a-zA-Z0-9_-]|\\.)+)\s*[,{]/gm)) {
      const raw = m[1].replace(/\\/g, "")
      if (raw.includes(":") || raw.startsWith("@") || /[[\]()/]/.test(raw)) continue
      defined.add(raw)
    }
    const missed = [...defined].filter((c) => !isTailwindClass(c)).sort()
    t(`oracle 完整性：forge-tailwind 产物里 ${defined.size} 个真工具类，判据必须一个不漏${oracleNote}`,
      missed.length === 0,
      `漏 ${missed.length} 种：${missed.slice(0, 40).join("  ")}`);
  }
  t("T4 没名单 ⇒ 不判", (() => { const r = check(root, null); return r.bad.length === 0 && r.note.some((n) => n.startsWith("T4")); })());
  console.log(`自检 ${pass}/${pass + fail}`);
  return fail === 0;
}

if (ARGS.includes("--selftest")) process.exit(selftest() ? 0 : 1);
if (ARGS.includes("--write-baseline")) {
  const live = scan(REPO);
  const doc = { _note: "Tailwind 工具类存量名单：名单外文件出现即红（T1），名单内只降不升（T2）。由 --write-baseline 生成，手改即漂移。", commit: "", files: Object.fromEntries([...live.entries()].sort()) };
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + "\n");
  console.log(`名单已生成：${live.size} 个文件 · 合计 ${[...live.values()].reduce((a, b) => a + b, 0)} 处`);
  process.exit(0);
}
if (!fs.existsSync(BASELINE)) { console.log("✗ 无名单（先 --write-baseline）⇒ 不判"); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const r = check(REPO, base);
console.log(`Tailwind 工具类：现算 ${r.total} 处 / 名单内 ${Object.keys(base.files || {}).length} 个文件`);
for (const n of r.note) if (ARGS.includes("--verbose")) console.log("· " + n);
if (!r.bad.length) console.log("✓ 无新增、无回升");
else { for (const b of r.bad) console.log("✗ " + b); console.log(`共 ${r.bad.length} 条`); }
process.exit(r.bad.length ? 2 : 0);
