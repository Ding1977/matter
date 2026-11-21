// tw-to-module.mjs —— Tailwind 工具类 → CSS Modules 翻译器（ISS-930 B3 trader/canvas 实战沉淀）
// 用法：node scripts/tw-to-module.mjs <包根目录> [--out styles/<name>.module.css] [--import css]
//   1. 收集包内全部唯一 className="..." 字符串
//   2. 逐 token 翻译成 CSS 声明（词典 + 数值规则），生成 module.css（每类首行注释=原串）
//   3. 改写 tsx：className="X" → className={s.tNN}；混合自有类 → className={"self " + s.tNN}
// 教训内建：混合类生成表达式 / 跳过 trand-root 式自有标记 / 词典未命中即报错退出（不静默）
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const pkgRoot = process.argv[2]
if (!pkgRoot) { console.error("用法: node tw-to-module.mjs <包根> [--out xxx.module.css]"); process.exit(1) }
const outArg = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "src/styles/tw.module.css"
const selfMarkers = (process.argv.find((a) => a.startsWith("--keep=")) || "--keep=").slice(7).split(",").filter(Boolean)

// ── 递归收集 tsx ──
function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const st = statSync(p)
    if (st.isDirectory()) { if (f !== "node_modules" && f !== "dist") walk(p, acc) }
    else if (f.endsWith(".tsx")) acc.push(p)
  }
  return acc
}
const files = walk(join(pkgRoot, "src"))
const all = files.map((p) => readFileSync(p, "utf8")).join("\n")
const uniq = [...new Set([...all.matchAll(/className="([^"]+)"/g)].map((m) => m[1]))].sort()
console.log(`唯一类串 ${uniq.length}`)

// ── 词典（B2/B3 校准后的官方真值口径）──
const C = {
  'text-muted-foreground': 'color: var(--dsw-alias-label-tertiary, #81858c);',
  'text-muted-foreground/70': 'color: color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 70%, transparent);',
  'text-muted-foreground/60': 'color: color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 60%, transparent);',
  'text-muted-foreground/50': 'color: color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 50%, transparent);',
  'text-foreground': 'color: var(--dsw-alias-label-primary, #0f1115);',
  'text-card-foreground': 'color: var(--dsw-alias-label-primary, #0f1115);',
  'text-up': 'color: hsl(var(--up));', 'text-down': 'color: hsl(var(--down));',
  'text-brand': 'color: var(--dsw-alias-state-business-primary, #4176e6);',
  'text-primary': 'color: var(--dsw-alias-state-business-primary, #4176e6);',
  'text-destructive': 'color: var(--dsw-alias-state-error-primary, #ec1313);',
  'text-red-500': 'color: var(--dsw-alias-state-error-primary, #ec1313);',
  'text-warn': 'color: var(--dsw-alias-state-warn-primary, #f59e0b);',
  'text-ok': 'color: var(--dsw-alias-state-success-primary, #22c55e);',
  'bg-background': 'background: var(--dsw-alias-bg-layer-1, #ffffff);',
  'bg-card': 'background: var(--dsw-alias-bg-layer-1, #ffffff);',
  'bg-popover': 'background: var(--dsw-alias-bg-layer-1, #ffffff);',
  'bg-muted': 'background: var(--dsw-alias-bg-layer-2, #ffffff);',
  'bg-border': 'background: var(--dsw-alias-border-l2, #d6dbe1);',
  'bg-transparent': 'background: transparent;',
  'bg-black/30': 'background: rgba(0, 0, 0, 0.3);', 'bg-black/40': 'background: rgba(0, 0, 0, 0.4);',
  'bg-up/15': 'background: hsl(var(--up) / 0.15);', 'bg-down/15': 'background: hsl(var(--down) / 0.15);',
  'bg-primary/10': 'background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 10%, transparent);',
  'bg-foreground/10': 'background: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 10%, transparent);',
  'bg-muted/50': 'background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #ffffff) 50%, transparent);',
  'bg-muted/40': 'background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #ffffff) 40%, transparent);',
  'bg-muted/30': 'background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #ffffff) 30%, transparent);',
  'bg-background/40': 'background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #ffffff) 40%, transparent);',
  'bg-red-500/10': 'background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 10%, transparent);',
  'border-border': 'border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));',
  'border-border/40': 'border-color: color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04)) 40%, transparent);',
  'border-border/60': 'border-color: color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04)) 60%, transparent);',
  'border-red-500/30': 'border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 30%, transparent);',
  'border-input': 'border-color: var(--dsw-alias-border-l2, #d6dbe1);',
  'bg-accent': 'background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));',
  'bg-accent/40': 'background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)) 40%, transparent);',
  'bg-accent/60': 'background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)) 60%, transparent);',
  'text-accent-foreground': 'color: var(--dsw-alias-label-primary, #0f1115);',
  'text-info': 'color: var(--dsw-alias-state-business-primary, #4176e6);',
  'border-warn/30': 'border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 30%, transparent);',
  'bg-warn/10': 'background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 10%, transparent);',
  'border-ok/30': 'border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 30%, transparent);',
  'bg-ok/10': 'background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 10%, transparent);',
  'ml-auto': 'margin-left: auto;',
}
const X = {
  'w-32': 'width: 128px;',
  'h-32': 'height: 128px;',
  'min-w-3': 'min-width: 12px;',
  'h-56': 'height: 224px;',
  'h-64': 'height: 256px;',
  'pl-7': 'padding-left: 28px;',
  'inline-block': 'display: inline-block;',
  'max-w-full': 'max-width: 100%;',
  'font-normal': 'font-weight: 400;',
  'mx-auto': 'margin-left: auto; margin-right: auto;',
  'left-2': 'left: 8px;', 'right-2': 'right: 8px;', 'top-2': 'top: 8px;', 'bottom-2': 'bottom: 8px;',
  'left-3': 'left: 12px;', 'right-3': 'right: 12px;', 'top-3': 'top: 12px;', 'bottom-3': 'bottom: 12px;',
  'left-4': 'left: 16px;', 'right-4': 'right: 16px;', 'top-4': 'top: 16px;', 'bottom-4': 'bottom: 16px;',
  'object-contain': 'object-fit: contain;',
  'text-danger': 'color: var(--dsw-alias-state-error-primary, #ec1313);',
  'w-64': 'width: 256px;',
  'w-48': 'width: 192px;',
  'rounded-t-sm': 'border-top-left-radius: 4px; border-top-right-radius: 4px;',
  'rounded-b-sm': 'border-bottom-left-radius: 4px; border-bottom-right-radius: 4px;',
  'stroke-muted-foreground/10': 'stroke: color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 10%, transparent);',
  'pl-[3.5rem]': 'padding-left: 3.5rem;',
  'size-[7px]': 'width: 7px; height: 7px;',
  'bg-muted-foreground/70': 'background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 70%, transparent);',
  'pl-[68px]': 'padding-left: 68px;',
  'bg-primary': 'background: var(--dsw-alias-state-business-primary, #4176e6);',
  'border-primary': 'border-color: var(--dsw-alias-state-business-primary, #4176e6);',
  'text-primary-foreground': 'color: #ffffff;',
  'bg-muted/60': 'background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #ffffff) 60%, transparent);',
  'bg-muted/20': 'background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #ffffff) 20%, transparent);',
  'pr-7': 'padding-right: 28px;',
  'min-w-4': 'min-width: 16px;',
  'border-dashed': 'border-style: dashed;',
  'border-dotted': 'border-style: dotted;',
  'border-solid': 'border-style: solid;',
  'fill-none': 'fill: none;',
  'fill-current': 'fill: currentColor;',
  'stroke-current': 'stroke: currentColor;',
  'text-mini': 'font-size: 11px;', // 包私有 @theme 档（R2b）：11px = caption 档
  'text-micro': 'font-size: 10px;', // 包私有：10px = micro（数字/拉丁）
  'outline-hidden': 'outline: none;',
  'ring-0': 'box-shadow: none;',
  'backdrop-blur-none': 'backdrop-filter: none;',
}
const SP = { '0':'0','px':'1px','0.5':'2px','1':'4px','1.5':'6px','2':'8px','2.5':'10px','3':'12px','3.5':'14px','4':'16px','5':'20px','6':'24px','8':'32px','10':'40px','12':'48px','16':'64px' }
// ⚠️ 本行曾与上一行粘连成 `...'16':'64px' }const WH = {`（2026-10-07 修）——
//    对象字面量后紧跟 `const` 会被当成属性访问 ⇒ `SyntaxError: Unexpected token 'const'`。
//    教训：ASI **不**在 `}` 后自动补分号（这里紧跟的是标识符，不是行首）。加换行即可，
//    但也说明这类"改一行带崩整文件"的脚本改动没有守卫跑它（本文件无单测、无门禁消费者）。
const WH = { '0':'0','px':'1px','0.5':'2px','1':'4px','1.5':'6px','2':'8px','2.5':'10px','3':'12px','3.5':'14px','4':'16px','5':'20px','6':'24px','7':'28px','8':'32px','9':'36px','10':'40px','11':'44px','12':'48px','14':'56px','16':'64px','20':'80px','24':'96px','40':'160px','44':'176px','52':'208px','72':'288px','96':'384px','full':'100%' }
const MONO = 'font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);'

/**
 * 判断一个 arbitrary 值是**颜色**还是**长度**（`text-[X]` 的双语义判据）。
 *
 * 与 Tailwind 自身同口径：值是颜色 ⇒ 前景色；值是长度 ⇒ 字号。
 * ⚠️ 判不出返回 null —— 调用点据此**报错退出**，不猜属性。
 *    （本仓踩过的坑：旧实现按"不以 # 开头就算字号"，把
 *     `text-[var(--dsw-alias-label-tertiary)]` 译成了 `font-size` —— 见 ISS-596。）
 *
 * @param {string} v arbitrary 值原样（如 `var(--x)` / `#fff` / `12px` / `1.5rem`）
 * @returns {'color'|'length'|null}
 */
function cssValueKind(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  // 长度：纯数字（含小数）、或数字 + 单位、或 calc/min/max/clamp 包裹
  if (/^-?\d+(\.\d+)?(px|rem|em|%|vh|vw|ch|ex|pt|pc|in|cm|mm|q)?$/.test(s)) return 'length'
  if (/^(calc|min|max|clamp)\(/.test(s)) return 'length'
  // 颜色：hex / 颜色函数 / 具名色关键字 / 关键字颜色变量 / currentColor 等
  if (/^#([0-9a-f]{3,8})$/i.test(s)) return 'color'
  if (/^(rgb|rgba|hsl|hsla|oklch|oklab|lch|lab|color|color-mix|light-dark|device-cmyk)\(/.test(s)) return 'color'
  if (/^(transparent|currentcolor|inherit|initial|unset|revert)$/i.test(s)) return 'color'
  // ⚠️ `var(--dsw-alias-*)` 这类：**按命名约定判**。
  //    `--dsw-alias-*` / `--dsw-specific-*` / `--dsw-static-*` / `--color-*` 全是**颜色**族
  //    （本仓的间距 token 一个都没有，见 design.md §1.3.1「DSH 一个间距 token 都没给」；
  //     字号 token 叫 `--dsw-font-*`、圆角叫 `--dsw-radius-*`、层级叫 `--dsw-elevation-*`）
  //    ⇒ 只有**明确属于颜色族**的变量才判 color；其余变量**判不了**（返回 null 报错），
  //      免得把 `var(--dsw-font-xs-13)` 也当成颜色。
  const vm = /^var\(\s*(--[A-Za-z0-9-]+)/.exec(s)
  if (vm) {
    const name = vm[1].toLowerCase()
    if (/^--(dsw|dsh)-(alias|specific|static)-/.test(name)) return 'color'
    if (/^--(color|tv)-/.test(name)) return 'color'
    if (/^--(dsw|dsh)-font-/.test(name)) return 'length'
    if (/^--(dsw|dsh)-radius-/.test(name)) return 'length'
    if (/^--forge-type-.*-(size|leading)$/.test(name)) return 'length'
    return null
  }
  return null
}

const F = {
  'flex':'display: flex;','block':'display: block;','hidden':'display: none;','grid':'display: grid;','inline-flex':'display: inline-flex;','contents':'display: contents;',
  'items-center':'align-items: center;','items-start':'align-items: flex-start;','items-end':'align-items: flex-end;','items-baseline':'align-items: baseline;',
  'justify-center':'justify-content: center;','justify-between':'justify-content: space-between;','justify-end':'justify-content: flex-end;','justify-start':'justify-content: flex-start;',
  'flex-col':'flex-direction: column;','flex-wrap':'flex-wrap: wrap;','flex-1':'flex: 1;','shrink-0':'flex-shrink: 0;','grow':'flex-grow: 1;',
  'min-h-0':'min-height: 0;','min-w-0':'min-width: 0;','max-h-0':'max-height: 0;',
  'relative':'position: relative;','absolute':'position: absolute;','fixed':'position: fixed;','sticky':'position: sticky;','static':'position: static;',
  'inset-0':'inset: 0;','inset-y-0':'top: 0; bottom: 0;','inset-x-0':'left: 0; right: 0;',
  'left-0':'left: 0;','right-0':'right: 0;','top-0':'top: 0;','bottom-0':'bottom: 0;','left-1/2':'left: 50%;','top-1/2':'top: 50%;','-translate-x-1/2':'transform: translateX(-50%);','-translate-y-1/2':'transform: translateY(-50%);',
  'overflow-hidden':'overflow: hidden;','overflow-auto':'overflow: auto;','overflow-y-auto':'overflow-y: auto;','overflow-x-auto':'overflow-x: auto;','overflow-visible':'overflow: visible;','overflow-clip':'overflow: clip;',
  'rounded':'border-radius: 4px;','rounded-sm':'border-radius: 4px;','rounded-md':'border-radius: var(--dsw-radius-sm, 8px);','rounded-lg':'border-radius: var(--dsw-radius-md, 12px);','rounded-xl':'border-radius: var(--dsw-radius-lg, 16px);','rounded-2xl':'border-radius: var(--dsw-radius-xl, 20px);','rounded-full':'border-radius: 999px; corner-shape: round;',
  'border':'border-width: 1px; border-style: solid;','border-0':'border-width: 0;','border-t':'border-top-width: 1px; border-top-style: solid;','border-b':'border-bottom-width: 1px; border-bottom-style: solid;','border-l':'border-left-width: 1px; border-left-style: solid;','border-r':'border-right-width: 1px; border-right-style: solid;','border-l-2':'border-left-width: 2px; border-left-style: solid;','border-l-4':'border-left-width: 4px; border-left-style: solid;','border-t-0':'border-top-width: 0;','border-b-0':'border-bottom-width: 0;',
  'w-full':'width: 100%;','h-full':'height: 100%;','w-fit':'width: fit-content;','w-px':'width: 1px;','h-px':'height: 1px;','size-full':'width: 100%; height: 100%;',
  'text-left':'text-align: left;','text-right':'text-align: right;','text-center':'text-align: center;',
  'font-medium':'font-weight: 500;','font-semibold':'font-weight: 600;','font-bold':'font-weight: 700;','font-mono':MONO,'uppercase':'text-transform: uppercase;','lowercase':'text-transform: lowercase;','italic':'font-style: italic;','not-italic':'font-style: normal;','underline':'text-decoration-line: underline;','line-through':'text-decoration-line: line-through;',
  'tabular-nums':'font-variant-numeric: tabular-nums;','truncate':'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;','break-all':'word-break: break-all;','break-words':'overflow-wrap: break-word;','whitespace-nowrap':'white-space: nowrap;','whitespace-pre':'white-space: pre;','whitespace-pre-wrap':'white-space: pre-wrap;','whitespace-pre-line':'white-space: pre-line;',
  'cursor-pointer':'cursor: pointer;','cursor-default':'cursor: default;','cursor-col-resize':'cursor: col-resize;','select-none':'user-select: none;','list-none':'list-style: none;','outline-none':'outline: none;','pointer-events-none':'pointer-events: none;','border-collapse':'border-collapse: collapse;','resize-none':'resize: none;','appearance-none':'appearance: none;',
  'space-y-1':'display: flex; flex-direction: column; gap: 4px;','space-y-1.5':'display: flex; flex-direction: column; gap: 6px;','space-y-2':'display: flex; flex-direction: column; gap: 8px;','space-y-3':'display: flex; flex-direction: column; gap: 12px;','space-y-4':'display: flex; flex-direction: column; gap: 16px;','space-y-5':'display: flex; flex-direction: column; gap: 20px;','space-x-1':'display: flex; gap: 4px;','space-x-2':'display: flex; gap: 8px;','divide-y':'','grid-cols-1':'grid-template-columns: repeat(1, minmax(0, 1fr));','grid-cols-2':'grid-template-columns: repeat(2, minmax(0, 1fr));','grid-cols-3':'grid-template-columns: repeat(3, minmax(0, 1fr));','grid-cols-4':'grid-template-columns: repeat(4, minmax(0, 1fr));','grid-cols-subgrid':'grid-template-columns: subgrid;','col-span-2':'grid-column: span 2 / span 2;','col-span-full':'grid-column: 1 / -1;','place-items-center':'place-items: center;','content-start':'align-content: flex-start;',
  'gap-0':'gap: 0;','gap-0.5':'gap: 2px;','gap-1':'gap: 4px;','gap-1.5':'gap: 6px;','gap-2':'gap: 8px;','gap-2.5':'gap: 10px;','gap-3':'gap: 12px;','gap-3.5':'gap: 14px;','gap-4':'gap: 16px;','gap-5':'gap: 20px;','gap-6':'gap: 24px;','gap-x-2':'column-gap: 8px;','gap-x-3':'column-gap: 12px;','gap-x-4':'column-gap: 16px;','gap-y-0.5':'row-gap: 2px;','gap-y-1':'row-gap: 4px;','gap-y-1.5':'row-gap: 6px;','gap-y-2':'row-gap: 8px;','gap-y-3':'row-gap: 12px;',
  'z-0':'z-index: 1;','z-10':'z-index: 200;','z-20':'z-index: 200;','z-30':'z-index: 300;','z-40':'z-index: 300;','z-50':'z-index: 500;',
  'shadow-sm':'box-shadow: var(--dsw-elevation-panel, 0 3px 8px 0 rgba(0,0,0,.03), 0 0 16px 0 rgba(0,0,0,.02));','shadow':'box-shadow: var(--dsw-elevation-panel, 0 3px 8px 0 rgba(0,0,0,.03), 0 0 16px 0 rgba(0,0,0,.02));','shadow-md':'box-shadow: var(--dsw-elevation-prominent, 0 3px 8px 0 rgba(0,0,0,.04), 0 0 20px 0 rgba(0,0,0,.05));','shadow-lg':'box-shadow: var(--dsw-elevation-prominent, 0 3px 8px 0 rgba(0,0,0,.04), 0 0 20px 0 rgba(0,0,0,.05));','shadow-xl':'box-shadow: var(--dsw-elevation-prominent, 0 3px 8px 0 rgba(0,0,0,.04), 0 0 20px 0 rgba(0,0,0,.05));','shadow-2xl':'box-shadow: var(--dsw-elevation-prominent, 0 3px 8px 0 rgba(0,0,0,.04), 0 0 20px 0 rgba(0,0,0,.05));','shadow-none':'box-shadow: none;','shadow-inner':'box-shadow: inset 0 2px 4px 0 rgba(0,0,0,.05);',
  'transition-colors':'transition: color var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1)),background-color var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1)),border-color var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1));','transition-all':'transition: all var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1));','transition-opacity':'transition: opacity var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1));','transition-transform':'transition: transform var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1));','transition':'transition: color var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1)),background-color var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1)),border-color var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1));',
  'peer':'', // Tailwind peer 机制标记类：无 peer: 变体消费则空转
  'transition-[color,box-shadow]':'transition: color var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1)),box-shadow var(--matter-dur-quick,120ms) var(--matter-ease-standard,cubic-bezier(.4,0,.2,1));',
  'animate-pulse':'animation: twPulse 1.5s ease-in-out infinite;','animate-spin':'animation: twSpin 1s linear infinite;','truncate2':'',
  'sr-only':'position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border-width: 0;','align-middle':'vertical-align: middle;','flex-none':'flex: none;','object-cover':'object-fit: cover;','bg-gradient-to-r':'','bg-clip-text':'-webkit-background-clip: text;','text-transparent':'color: transparent;',
}
const SZ = { 'xs':'12px','sm':'14px','base':'16px','lg':'18px','xl':'20px','2xl':'24px','3xl':'30px','4xl':'36px' }
const LH = { '3':'12px','4':'16px','5':'20px','6':'24px','7':'28px','8':'32px','9':'36px','10':'40px','none':'1','tight':'1.25','snug':'1.375','normal':'1.5','relaxed':'1.625','loose':'2' }
const R = { 'none':'0','sm':'4px','base':'4px','md':'8px','lg':'12px','xl':'16px','2xl':'20px','full':'999px' }

function one(tok) {
  if (!tok) return []
  if (C[tok]) return [C[tok]]
  if (X[tok]) return [X[tok]]
  if (F[tok] !== undefined) return F[tok] ? [F[tok]] : []
  let m
  if ((m = tok.match(/^([wh])-(\d+(?:\.\d+)?|full|px)$/)) && WH[m[2]]) return [`${m[1] === 'w' ? 'width' : 'height'}: ${WH[m[2]]};`]
  if ((m = tok.match(/^size-(\d+(?:\.\d+)?)$/)) && WH[m[1]]) return [`width: ${WH[m[1]]}; height: ${WH[m[1]]};`]
  if ((m = tok.match(/^min-([wh])-(\d+(?:\.\d+)?)$/)) && WH[m[2]]) return [`min-${m[1] === 'w' ? 'width' : 'height'}: ${WH[m[2]]};`]
  if ((m = tok.match(/^max-([wh])-(\d+(?:\.\d+)?)$/)) && WH[m[2]]) return [`max-${m[1] === 'w' ? 'width' : 'height'}: ${WH[m[2]]};`]
  if ((m = tok.match(/^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-(\d+(?:\.\d+)?|px)$/)) && SP[m[2]]) {
    const v = SP[m[2]]
    return { p:[`padding: ${v};`],'px':[`padding-left: ${v}; padding-right: ${v};`],py:[`padding-top: ${v}; padding-bottom: ${v};`],pt:[`padding-top: ${v};`],pb:[`padding-bottom: ${v};`],pl:[`padding-left: ${v};`],pr:[`padding-right: ${v};`],m:[`margin: ${v};`],mx:[`margin-left: ${v}; margin-right: ${v};`],my:[`margin-top: ${v}; margin-bottom: ${v};`],mt:[`margin-top: ${v};`],mb:[`margin-bottom: ${v};`],ml:[`margin-left: ${v};`],mr:[`margin-right: ${v};`]}[m[1]]
  }
  if ((m = tok.match(/^-?(?:mt|mb|ml|mr|mx|my)-(\d+(?:\.\d+)?)$/)) && SP[m[1]]) { /* negative handled by prefix below */ }
  if ((m = tok.match(/^-(right|left|top|bottom)-(\d+(?:\.\d+)?)$/)) && WH[m[2]]) return [`${m[1]}: -${WH[m[2]]};`]
  if ((m = tok.match(/^-(mt|mb|ml|mr|mx|my)-(\d+(?:\.\d+)?)$/)) && SP[m[2]]) {
    const v = '-' + SP[m[2]]
    return { mt:[`margin-top: ${v};`],mb:[`margin-bottom: ${v};`],ml:[`margin-left: ${v};`],mr:[`margin-right: ${v};`],mx:[`margin-left: ${v}; margin-right: ${v};`],my:[`margin-top: ${v}; margin-bottom: ${v};`]}[m[1]]
  }
  if ((m = tok.match(/^text-(xs|sm|base|lg|xl|2xl|3xl|4xl)$/))) return [`font-size: ${SZ[m[1]]};`]
  if ((m = tok.match(/^text-\[(\d+(?:\.\d+)?)px\]$/))) return [`font-size: ${m[1]}px;`]
  if ((m = tok.match(/^leading-(\d+|none|tight|snug|normal|relaxed|loose)$/)) && LH[m[1]]) return [`line-height: ${LH[m[1]]};`]
  if ((m = tok.match(/^leading-\[(\d+(?:\.\d+)?)px\]$/))) return [`line-height: ${m[1]}px;`]
  if ((m = tok.match(/^tracking-(tight|tighter|normal|wide)$/))) return [`letter-spacing: ${ {tight:'-0.01em',tighter:'-0.02em',normal:'0',wide:'0.025em'}[m[1]] };`]
  if ((m = tok.match(/^(rounded(?:-([a-z0-9]+))?)$/)) && R[m[2] ?? ''] !== undefined) {
    const v = R[m[2] ?? '']
    return v === '999px' ? ['border-radius: 999px; corner-shape: round;'] : [`border-radius: ${v === '' ? '4px' : v};`]
  }
  if ((m = tok.match(/^rounded-\[(.+)\]$/))) return [`border-radius: ${m[1]};`]
  if ((m = tok.match(/^(w|h|top|bottom|left|right|inset)-\[(.+)\]$/))) {
    const prop = { w:'width',h:'height',top:'top',bottom:'bottom',left:'left',right:'right',inset:'inset' }[m[1]]
    return [`${prop}: ${m[2]};`]
  }
  if ((m = tok.match(/^(pl|pr|pt|pb)-\[(.+)\]$/))) {
    const prop = { pl:'padding-left',pr:'padding-right',pt:'padding-top',pb:'padding-bottom' }[m[1]]
    return [`${prop}: ${m[2]};`]
  }
  if ((m = tok.match(/^(p|px|py|m|mx|my|gap)-\[(.+)\]$/))) {
    const prop = { p:'padding','px':null,py:null,m:'margin','mx':null,my:null,gap:'gap' }[m[1]]
    if (prop) return [`${prop}: ${m[2]};`]
    if (m[1] === 'px') return [`padding-left: ${m[2]}; padding-right: ${m[2]};`]
    return [`padding-top: ${m[2]}; padding-bottom: ${m[2]};`]
  }
  if ((m = tok.match(/^max-([wh])-\[(.+)\]$/))) return [`max-${m[1] === 'w' ? 'width' : 'height'}: ${m[2]};`]
  if ((m = tok.match(/^min-([wh])-\[(.+)\]$/))) return [`min-${m[1] === 'w' ? 'width' : 'height'}: ${m[2]};`]
  // `text-[X]` 是**双语义**类：值像长度 ⇒ 字号；值像颜色 ⇒ 前景色。
  // ⚠️⚠️ 这里曾出过一个静默事故（ISS-596 修）：旧实现按「不以 # 开头 ⇒ 字号」判，
  //   于是 `text-[var(--dsw-alias-label-tertiary)]`（**典型颜色**）被译成
  //   `font-size: var(--dsw-alias-label-tertiary)` —— 值非法 ⇒ 浏览器**静默丢弃**该声明，
  //   字号回落继承值。全仓 11 处中招，肉眼与门禁都看不出来（丢的是"没有样式"而非"报错"）。
  //   ⇒ 判据改成**按值类型**（与 Tailwind 自身一致），且**判不了就报错退出**（见文件尾的 fails），
  //   绝不猜一个"看起来合理"的属性。显式类型提示（Tailwind 的 `color:` / `length:`）优先。
  if ((m = tok.match(/^text-\[(color|length):(.+)\]$/))) {
    return [m[1] === 'color' ? `color: ${m[2]};` : `font-size: ${m[2]};`]
  }
  if ((m = tok.match(/^text-\[(.+)\]$/))) {
    const v = m[1]
    if (cssValueKind(v) === 'color') return [`color: ${v};`]
    if (cssValueKind(v) === 'length') return [`font-size: ${v};`]
    return null // 判不了 ⇒ 交给 fails 报错退出（不猜）
  }
  if ((m = tok.match(/^bg-\[(.+)\]$/))) return [`background: ${m[1]};`]
  if ((m = tok.match(/^border-\[(.+)\]$/))) return [`border-color: ${m[1]};`]
  if ((m = tok.match(/^z-\[(\d+)\]$/))) return [`z-index: ${ Number(m[1]) >= 1000 ? m[1] : (Number(m[1]) <= 9 ? 1 : 200) };`]
  if ((m = tok.match(/^grid-cols-\[(.+)\]$/))) return [`grid-template-columns: ${m[1]};`]
  if ((m = tok.match(/^(hover|focus-visible|focus-within|focus|disabled|active|group-hover|placeholder|first|last|odd|even):(.+)$/))) {
    const inner = one(m[2]) ?? []
    if (inner.length) return ['V', m[1], inner]
  }
  if ((m = tok.match(/^placeholder:text-muted-foreground\/(\d+)$/))) return ['V', 'placeholder', [`color: color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) ${m[1] * 10}%, transparent);`]]
  if ((m = tok.match(/^disabled:opacity-(\d+)$/))) return ['V', 'disabled', [`opacity: ${m[1] / 100};`]]
  if ((m = tok.match(/^hover:(bg|text|border)-(.+)$/))) {
    const body = one(m[2]) ?? []
    if (body.length) return ['V', 'hover', body]
  }
  if (tok.startsWith('peer-hover:ring')) return [] // ring 变体由 focus-visible outline 承担（D2）
  if (tok.startsWith('peer-focus-visible:')) {
    const b = one(tok.replace(/^peer-focus-visible:/, '')) ?? []
    return b.length ? ['V', 'peerfocus', b] : []
  }
  if ((m = tok.match(/^group-hover:(.+)$/))) { const b = one(m[1]) ?? []; if (b.length) return ['V', 'grouphover', b] }
  if ((m = tok.match(/^data-\[state=(\w+)\]:(.+)$/))) { const b = one(m[2]) ?? []; if (b.length) return ['V', `datastate-${m[1]}`, b] }
  if ((m = tok.match(/^@lg:(.+)$/))) { const b = one(m[1]) ?? []; if (b.length) return ['MQ', '(min-width: 56rem)', b] }
  if ((m = tok.match(/^@sm:(.+)$/))) { const b = one(m[1]) ?? []; if (b.length) return ['MQ', '(min-width: 24rem)', b] }
  if ((m = tok.match(/^@md:(.+)$/))) { const b = one(m[1]) ?? []; if (b.length) return ['MQ', '(min-width: 28rem)', b] }
  if (tok === '@container') return [] // §4.1 改判：零容器查询（老板 09-28），标记类丢弃
  if ((m = tok.match(/^@max-\[(\d+(?:\.\d+)?)(rem|px)\]:(.+)$/))) {
    // 主体可能是任意值类 pl-[2.5rem]
    const px = m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1])
    const b = one(m[3]) ?? []
    if (b.length) return ['MQ', `(max-width: ${Math.round(px)}px)`, b]
  }
  if ((m = tok.match(/^@min-\[(\d+(?:\.\d+)?)(rem|px)\]:(.+)$/))) {
    const px = m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1])
    const b = one(m[3]) ?? []
    if (b.length) return ['MQ', `(min-width: ${Math.round(px)}px)`, b]
  }
  if ((m = tok.match(/^dark:(.+)$/))) return [] // 深色由 token 自动适配，dark: 变体不需要
  if ((m = tok.match(/^sm:(.+)$/))) { const b = one(m[1]) ?? []; if (b.length) return ['MQ', '(min-width: 640px)', b] }
  if ((m = tok.match(/^md:(.+)$/))) { const b = one(m[1]) ?? []; if (b.length) return ['MQ', '(min-width: 768px)', b] }
  if ((m = tok.match(/^lg:(.+)$/))) { const b = one(m[1]) ?? []; if (b.length) return ['MQ', '(min-width: 1024px)', b] }
  if ((m = tok.match(/^xl:(.+)$/))) { const b = one(m[1]) ?? []; if (b.length) return ['MQ', '(min-width: 1280px)', b] }
  if ((m = tok.match(/^max-(sm|md|lg|xl):(.+)$/))) {
    const w = { sm:'639px',md:'767px',lg:'1023px',xl:'1279px' }[m[1]]
    const b = one(m[2]) ?? []; if (b.length) return ['MQ', `(max-width: ${w})`, b]
  }
  if (tok.startsWith('[&_svg]:')) {
    if (tok === '[&_svg]:h-auto') return ['SVG', 'height: auto;']
    if (tok === '[&_svg]:w-full') return ['SVG', 'width: 100%;']
    if (tok === '[&_svg]:min-w-[20rem]') return ['SVG', 'min-width: 20rem;']
    return []
  }
  if (tok.startsWith('[&::-w')) return []
  if (tok === 'focus:ring-ring' || tok === 'focus:ring-1' || tok === 'focus:ring-2' || tok === 'ring-1' || tok === 'ring-2') return [] // ring 由 focus-visible outline 承担（D2），ring 宽度变体丢弃
  if ((m = tok.match(/^focus:ring-(\d+)$/))) return [] // 同上
  if ((m = tok.match(/^duration-(\d+)$/))) return [`transition-duration: ${m[1]}ms;`]
  if ((m = tok.match(/^delay-(\d+)$/))) return [`transition-delay: ${m[1]}ms;`]
  if ((m = tok.match(/^opacity-(\d+)$/))) return [`opacity: ${m[1] / 100};`]
  if ((m = tok.match(/^basis-\[(.+)\]$/))) return [`flex-basis: ${m[1]};`]
  if ((m = tok.match(/^w-\[(\d+(?:\.\d+)?)\/(\d+)\]/))) return [`width: ${ (m[1] / m[2] * 100).toFixed(2) }%;`]
  return null
}

// ── 生成 ──
const classmap = {}
const cssChunks = ['/* 自动生成：tw-to-module.mjs（ISS-930 B3/B4 沉淀）；每类首行注释 = 原 Tailwind 串 */', '']
const fails = []
for (let i = 0; i < uniq.length; i++) {
  const cls = uniq[i]
  const toks = cls.split(/\s+/).filter((t) => !selfMarkers.includes(t))
  const decls = [], variants = {}, mqs = {}, svgSel = {}
  let ok = true
  for (const t of toks) {
    const r = one(t)
    if (r === null) { fails.push({ cls, t }); ok = false; break }
    if (r[0] === 'SVG') (svgSel['svg'] ??= []).push(...(r[2] ?? []))
    else if (r[0] === 'V') (variants[r[1]] ??= []).push(...r[2])
    else if (r[0] === 'MQ') (mqs[r[1]] ??= []).push(...r[2])
    else decls.push(...r)
  }
  if (!ok) continue
  const name = `t${i}`
  classmap[cls] = name
  let chunk = `.${name} {\n  /* ${cls} */\n`
  chunk += decls.length ? '  ' + decls.join('\n  ') + '\n' : '  /* 仅变体 */\n'
  chunk += '}\n'
  const selMap = { hover:':hover', focus:':focus', 'focus-visible':':focus-visible', 'focus-within':':focus-within', disabled:':disabled', active:':active', placeholder:'::placeholder', first:':first-child', last:':last-child', odd:':nth-child(odd)', even:':nth-child(even)' }
  for (const [v, ds] of Object.entries(svgSel)) chunk += `.${name} ${v} {\n  ` + ds.join("\n  ") + "\n}\n"
  for (const [v, ds] of Object.entries(variants)) {
    if (v === 'peerfocus') chunk += `.peer:focus-visible ~ .${name} {\n  ` + ds.join('\n  ') + '\n}\n'
    else if (v === 'grouphover') chunk += `.group:hover .${name} {\n  ${ds.join('\n  ')}\n}\n`
    else if (v.startsWith('datastate-')) chunk += `.${name}[data-state="${v.slice(10)}"] {\n  ${ds.join('\n  ')}\n}\n`
    else chunk += `.${name}${selMap[v] ?? ':' + v} {\n  ${ds.join('\n  ')}\n}\n`
  }
  for (const [q, ds] of Object.entries(mqs)) chunk += `@media ${q} {\n.${name} {\n  ${ds.join('\n  ')}\n}\n}\n`
  cssChunks.push(chunk)
}
if (fails.length) {
  console.error(`✗ ${fails.length} 个 token 未翻译（词典需扩充，退出以避免静默丢样式）：`)
  for (const f of fails.slice(0, 12)) console.error(`  '${f.t}'  in: ${f.cls.slice(0, 70)}`)
  process.exit(1)
}
cssChunks.push(`\n@keyframes twPulse {\n  0%, 100% { opacity: 1; }\n  50% { opacity: 0.5; }\n}\n@keyframes twSpin {\n  to { transform: rotate(360deg); }\n}\n`)
const outPath = join(pkgRoot, outArg)
writeFileSync(outPath, cssChunks.join('\n'))
writeFileSync('/tmp/tw-classmap.json', JSON.stringify(classmap))
console.log(`✓ ${uniq.length} 类串 → ${outPath}（词典全命中）`)
