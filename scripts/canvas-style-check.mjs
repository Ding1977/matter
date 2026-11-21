#!/usr/bin/env node
// scripts/canvas-style-check.mjs
// 画布出码的样式门禁（ISS-939 / DOC-334 T8）—— 判「出码产物与画布文档在出码那一刻能不能过」
//
// 用法：node scripts/canvas-style-check.mjs --selftest
//       node scripts/canvas-style-check.mjs --fixture            仓库内正样本（干净 ⇒ 必须全过）
//       node scripts/canvas-style-check.mjs --file <产物文件>…    检出码产物（离仓前的预检）
//       node scripts/canvas-style-check.mjs --doc [<canvas.json>] 判活体画布文档（缺省取数据根那份）
//       另有 --json / --verbose
//   · exit 0 全过 · exit 1 有违例（ISS-832，原 2）· exit 3 没给任何输入（空跑不算通过）
//
// 与 lint-design.mjs 的分工（别混，别双写）：
//   lint-design 判**已落进仓库的代码**（R1b 裸 hex / R2a 字号 role / R3a 间距档 / R5a 圆角 / R7b 时长），
//   真相源是 docs/design.md + scripts/baseline/design-lint.json。本脚本判它够不着的两段：
//   ① 出码产物在离仓之前（裸值 / 预览轨 class / 任意值 / 悬空 var / 可注入面）
//   ② 画布文档在出码之前（阶梯外值、文字对比度、组件身份三态）
//   阶梯与组件一律调 forge-canvas 纯核（token-map / component-map），本文件不写第二份档位表。
//
// 门禁链里只跑 --selftest + --fixture（仓库内、可复算、不碰个人数据根）；
// --doc 是给人和 agent 的出码前预检，**不进 CI**（CI 的 HOME 是空的，拿不到 ~/.dsh）。
//
// 对比度：docs/design.md:1367 定正文 ≥4.5:1、大字（≥24px 或 ≥18.66px 加粗）与图形 ≥3:1，浅深两主题都要过；
// 底色口径 docs/design.md:216（浅 #ffffff / 深 #151517，带 alpha 先叠底）。
// 要把 var(--dsw-*) 解成实色时取**安装侧** dsh-client-ui-theme/lib/client.js（与 design.md 同一机器取法），
// 取不到就显式「不判」——绝不拿 fallback 字面量冒充（看不见 ≠ 没有）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE = path.join(ROOT, 'forge-canvas/lib/canvas-core.js')
const COMPONENT_MAP = path.join(ROOT, 'scripts/baseline/component-map.json')
const FIXTURE = path.join(ROOT, 'forge-canvas/testdata/style-check-fixture.json')
/* 装侧 theme 的取根：见下面 THEME_CANDIDATES（逻辑在纯核 themeCandidatePaths/pickThemeText，本文件不复制一份）。
   背景（10-02 修）：数据根从 web 盘 ~/.dsh 搬到 Matter 生产盘 ~/.dsh-matter（AGENTS.md §0.5），
   旧路径的文件**还在、内容却是旧引擎那一份**（`--dsw-radius-*` 整段没了）⇒ 只认单一路径会读到陈旧那份。 */
const THEME_BASE = { light: '#ffffff', dark: '#151517' } // 出处 docs/design.md:216
const AA_BODY = 4.5
const AA_LARGE = 3.0 // 出处 docs/design.md:1367
/** 例外：给变量赋值处允许字面色值。按文件名写死 ⇒ 改名即新增违例（selftest ⑧ 双向验） */
const DECLARATION_FILES = [/forge-design\/src\/tokens\.ts$/, /forge-design\/src\/styles\.css$/, /canvas-scope\.css$/]

// 色值解析与 token 变量名都从 forge-canvas 纯核取（K6a：同一实现只留一处；本脚本第一版自己写过两份，已摘）
const { hexToRgb01, rgbToHex, tokenVarNames, parseThemeColors, parseRadiusTokens, radiusStepsFromTheme, radiusVarName, hasRadiusDecls, themeCandidatePaths, pickThemeText, themeTextFrom } = await import(CORE)

/* 取根一次，两处用（漂移守卫 + 色表解析）⇒ 不许出现"门禁读了新根、色表读了旧根"的第三种状态 */
/* 取根一律**调用时算**，不在模块加载时定格（第 2 轮审查的第 2 刀：定格之后，
   测试里 import 完成再设 DSH_THEME_CLIENT 就无效了 —— 那条"色表读不到"的用例会假过）。 */
function themeCandidatesNow() { return themeCandidatePaths(process.env) }
const THEME_CLIENT = '' // 保留名占位：真实取根一律走 themeCandidatesNow()，任何"单一路径"用法都是回归
/* 画布文档的数据根也走候选（第 2 轮审查第 3 刀：同一个脚本里"读 theme"用候选、"读文档"却手写旧根 = 两套口径）。 */
function docCandidatePaths(env) {
  const rel = 'forge-canvas/.design/canvas.json'
  const home = env.HOME || ''
  return [...new Set([
    env.DSH_HOME ? `${env.DSH_HOME}/${rel}` : null,
    home ? `${home}/.dsh-matter/${rel}` : null,
    home ? `${home}/.dsh/${rel}` : null,
  ].filter(Boolean))]
}
function pickCanvasDoc() { const c = docCandidatePaths(process.env); return c.find((p) => fs.existsSync(p)) || c[0] }

const composite = (fg, alpha, bg) => ({ r: fg.r * alpha + bg.r * (1 - alpha), g: fg.g * alpha + bg.g * (1 - alpha), b: fg.b * alpha + bg.b * (1 - alpha) })
const luminance = ({ r, g, b }) => {
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const isLargeText = (px, weight) => px >= 24 || (px >= 18.66 && (weight ?? 400) >= 600)

/** 安装侧 theme：var → 实色（浅深各一份）；取不到返回 null，调用方必须走「不判」。
 *  ⚠️ 09-29 归一：这里原来自己写了一套「找 body{ 块 + 收 hex/rgb()」的解析器，
 *  而本家 theme 的语义名（--dsw-alias-*）几乎全是 `var(--dsw-static-*)` 间接引用 ⇒ 那套解析器实收为空，
 *  深色块更是从没正确取到过（`block('body{')` 命中的是文件里第一个小块）。
 *  现在一律走纯核 parseThemeColors()（全文扫 + 沿 var 链 + 深浅分开 + 环检测），一份实现两处用（K6a）。 */
let themeCache
function loadThemeVars() {
  if (themeCache !== undefined) return themeCache
  const text = loadThemeText()
  if (!text) { themeCache = null; return null } // 三份候选都没档位 ⇒ 不判（含"文件在但是旧引擎那份"这种形态）
  const t = parseThemeColors(text)
  const to = (map) => {
    const out = {}
    for (const [name, hex] of Object.entries(map)) { const rgb = hexToRgb01(hex); if (rgb) out[name] = rgb }
    return out
  }
  /* hex → **所有**候选变量名（不是挑一个）。同一个浅色 hex 往往被多个 token 共用
     （语义名 + 它的 static 来源 + 别同色别名），挑错名字就会把另一主题的深色值算错：
     活体稿那条「标题 在 dark 下 1.00:1」就是这么造出来的假阳性（09-29 自查撤回）。
     所以判据改成"唯一解才判"：候选在另一主题的取值一致 ⇒ 判；不一致 ⇒ 换算歧义，不判。 */
  const rev = (map) => {
    const out = {}
    for (const [name, hex] of Object.entries(map)) (out[hex] ??= []).push(name)
    return out
  }
  themeCache = {
    light: to(t.名到色), dark: to(t.深色到色),
    浅色名: rev(t.名到色), 深色名: rev(t.深色到色), 统计: t.统计,
  }
  return themeCache
}

/** 画布里画出来的颜色 → **另一套主题下它会变成什么色**（走 token 名换算，双向）。
 *  docs/design.md:1367 要求浅深两主题都过；稿子只画一套底色，但颜色若来自 token，
 *  它在另一主题下有确定值 ⇒ 能算。换算不出（不是 token 色）就明说没判，不拿本主题的值冒充。 */
export function otherThemeColor(tv, rgb01, themeKey) {
  if (!tv || !rgb01) return null
  const hex = rgbToHex(rgb01)
  const names = (themeKey === 'dark' ? tv.浅色名 : tv.深色名)?.[hex]
  if (!names?.length) return null
  const table = themeKey === 'dark' ? tv.dark : tv.light
  /* 每个候选在目标主题下的取值：有覆盖用覆盖值；没覆盖就说明它在那边保持这个颜色。
     所有候选取值**完全一致**才判（唯一解）；不一致 ⇒ 返回 歧义，宁可不判也不猜。
     （第一版在这里"挑一个名字"，于是把活体稿的「标题」算成 dark 下 1.00:1 —— 那是假阳性，已撤回。） */
  const 取值 = [...new Set(names.map((nm) => (table[nm] ? rgbToHex(table[nm]) : hex)))]
  if (取值.length !== 1) return { 歧义: true }
  const rgb = 取值[0] === hex ? rgb01 : hexToRgb01(取值[0])
  if (!rgb) return null
  return { ...rgb, 名: names.find((x) => table[x]) ?? names[0] }
}

/** 声明集：仓库内可见的 CSS 自定义属性名 + theme 的 --dsw-*（悬空 var 判据的分母） */
/* 圆角档位**来源**守卫（10-02 按老板指令重写：档位改吃 theme-tokens，本仓不再抄字面量表）
   ── 为什么守卫的形状必须跟着换：旧版判的是「本仓抄的表 vs 装侧 theme」。现在本仓没有那张表了
   （`token-map.ts` 的 `radiusTable(steps)` 吃调用方传进来的 steps），**拿 theme 比 theme 就是恒真**，
   而恒真的守卫比没守卫更坏 —— 下一个人会以为"漂移有人管"。于是这里判的是「有没有第二份来源」：
     1) 谁把圆角档位表抄回 `forge-canvas/src/token-map.ts`（官方变量名 / 旧常量名 / 「档名+数值」字面量对 /
        内置默认表）⇒ 工具的真相源坏了 ⇒ **拒判**（exit 2；这不是判红你的稿子）；
     2) 装侧 theme 读不到、或读到了却一条圆角档都解不出 ⇒ 判「未判」（不判红、也不假装通过）；
     3) 装侧同名重复声明 / 有声明但值解不出 ⇒ 报出来，"取了哪一次、跳过了哪几条"不许静默。
   注释一律**先剥再匹配**：token-map.ts 的纪律说明里就写着 `--dsw-radius-xs/sm/…` 和旧表的名字，
   不剥注释这条守卫从第一天起就是恒红的（同 lint-code 的剥注释纪律，台账 §15 那一刀）。 */
/* 覆盖口 CANVAS_TOKEN_MAP_TS 给"造一份抄了表的 token-map"用（同 DSH_THEME_CLIENT 的纪律：
   没有它就只能靠真仓库跑，而"有人抄回第二份表"恰恰是最该被测的那一档）。
   ⚠️ **调用时现算**，不在模块加载时定格（第 2 轮审查抓到过"import 时定格让覆盖口失效"；
   ㊹ 就是在**同进程**里改 env 再读一次来证伪定格那种写法 —— 走子进程传 env 两种实现分不出来）。 */
const tokenMapSrcNow = () => process.env.CANVAS_TOKEN_MAP_TS || path.join(ROOT, 'forge-canvas/src/token-map.ts')
/** 读本仓的档位来源文件；读不到 ⇒ null（这一项判「未判」，不判红也不假装干净） */
function readTokenMapSrc() {
  try { return fs.readFileSync(tokenMapSrcNow(), 'utf8') } catch { return null }
}

export function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
}

/** 只判代码行：返回"第二份圆角档位表"的形状命中（空数组 = 来源干净） */
export function radiusLiteralHits(codeText) {
  const out = []
  const 名字 = /--dsw-radius-[A-Za-z0-9-]+/
  if (名字.test(codeText)) out.push(`出现官方圆角变量名字面量「${名字.exec(codeText)[0]}」⇒ 档位只能由调用方从 theme 传入；名字 ↔ 变量的换算只有 theme-tokens.ts 一处（RADIUS_VAR_PREFIX / radiusVarName）`)
  if (/\bOFFICIAL_RADIUS\b/.test(codeText)) out.push('旧的字面量档位常量 OFFICIAL_RADIUS 又回来了（10-02 已摘：两份同名不同值的表就是 09-29 那条假漂移的根）')
  const 档值 = /name:\s*["'](?:xs|sm|md|lg|xl|panel|pill)["']\s*,\s*value:\s*\d+/
  if (档值.test(codeText)) out.push(`出现「档名 + 数值」字面量对「${档值.exec(codeText)[0].replace(/\s+/g, ' ')}」⇒ 这是抄来的第二份档位表`)
  const 内置 = [/(?<![\w.-])radius[A-Za-z]*\s*=\s*\[[^\]]*\d/, /\bsteps[^=\n]{0,30}=\s*\[[^\]]*\d[^\]]*\]/]
  for (const re of 内置) {
    if (re.test(codeText)) { out.push(`圆角档位带了**内置默认表**（形状 ${re.source}）⇒ 读不到 theme 时必须判「未判」，不许用内置表冒充官方档位`); break }
  }
  return out
}

/** 守卫主入口。@param tokenMapText 传 undefined = 只看装侧状态（不读源文件），给只要 theme 状态的调用方用 */
export function radiusSourceGuard(themeCss, tokenMapText) {
  const out = []
  const 装侧 = themeCss ? parseRadiusTokens(themeCss) : null
  if (!themeCss || !hasRadiusDecls(themeCss)) {
    out.push({ kind: 'radius-steps-unreadable', at: 'theme', 未判: true, detail: `候选里读不到带 --dsw-radius-* 声明的 theme（按序试过：${themeCandidatesNow().join(' → ') || '(无候选)'}）⇒ 圆角档位**未判**，不是通过` })
  } else if (装侧.统计.解析成功 === 0) {
    out.push({ kind: 'radius-steps-unreadable', at: '--dsw-radius-*', 未判: true, detail: `theme 里有 ${装侧.统计.扫到声明} 条 --dsw-radius-* 声明，但**一条都没解成 px** ⇒ 档位未判（是解析口径不认识这写法，不是官方没档）` })
  } else {
    if (装侧.统计.解不出 > 0) out.push({ kind: 'radius-step-unparsable', at: '--dsw-radius-*', detail: `装侧有 ${装侧.统计.解不出} 条圆角声明解不出 px 值（被跳过）⇒ 面板与出码看到的档位少这几档，要人看装侧那几条写法` })
    if (装侧.统计.重名 > 0) out.push({ kind: 'radius-dup-declaration', at: '--dsw-radius-*', detail: `装侧有 ${装侧.统计.重名} 处同名重复声明（本层取首次值）⇒ 若深浅两套圆角不同值，档位表里只有浅色的那份` })
  }
  if (tokenMapText === null) {
    out.push({ kind: 'radius-source-unreadable', at: path.relative(ROOT, tokenMapSrcNow()), 未判: true, detail: `读不到档位来源文件 ⇒ 「有没有第二份表」这一项**未判**（不是干净）：本检查只在仓库检出里有效` })
  } else if (tokenMapText !== undefined) {
    for (const h of radiusLiteralHits(stripComments(tokenMapText))) out.push({ kind: 'radius-second-table', at: path.relative(ROOT, tokenMapSrcNow()), detail: h })
  }
  return out
}

/** 文档档的圆角判定（一份实现两处用：CLI 与 selftest 都调这里，免得"测的是另一套逻辑"）
 *  @param steps 装侧 theme 解出的档位表；**空表 ⇒ 一律不判**（判「未判」）——否则这份稿的每个圆角都算违例，那是假红 */
export function radiusStepProblems(core, radii, steps) {
  if (!steps || steps.length === 0) return { 问题: [], 未判: '没拿到带 --dsw-radius-* 的装侧 theme ⇒ 本稿圆角**未判**（不判红、也不判过）' }
  const 问题 = []
  for (const { value, at } of radii) {
    const r = core.mapStep('radius', value, steps)
    if (!r.ok) 问题.push({ kind: 'radius-out-of-step', at, detail: `圆角 ${value}px 不在装侧官方档位（最近 ${r.nearestName}=${r.nearestValue}，差 ${r.delta}）⇒ 人工定档（官方没有的形状不许自造，也不许就近吸附）` })
  }
  return { 问题, 未判: null }
}

/** 纯核 bundle 与源码同代吗？（10-02 对抗审查 F 条 + 复核补的那一形）
 *  判据**不能只看名字**：名字全在但行为是旧的（例如 `radiusTable` 空表偷偷回落一张表）同样致命，
 *  所以三件事都要验：旧常量缺席 · 新导出是函数 · **空表必须判 empty-step-table**（这条只有跑行为才知道）。
 *  抽成函数是为了让 selftest 能拿一份"造出来的旧核"证伪它 —— 闸门本身没法用真 bundle 证伪。 */
export function coreGenerationOk(core) {
  try {
    if (typeof core.radiusStepsFromTheme !== 'function' || typeof core.radiusVarName !== 'function') return false
    if (core.OFFICIAL_RADIUS !== undefined || core.radiusTokenIndexFromTheme !== undefined) return false
    const 空表 = core.mapStep('radius', 12, [])
    const 命中 = core.mapStep('radius', 12, [{ name: 'md', value: 12 }])
    return 空表.ok === false && 空表.reason === 'empty-step-table' && 命中.ok === true
  } catch { return false }
}
/* ───────────── 身份合并写的「落笔点」判据（ISS-567 / PRJ-020 M1） ─────────────
   为什么这条要长在门禁里而不是只写一条用例：M1 把「令牌身份」存进节点的 `customData`，
   而那个字段同时是引擎的**内部 id 载体**（v2id：认节点、恢复选区、增量保存）+ K3 源码定位（sourceRef）。
   补丁语义是整体替换 ⇒ 谁把「合并写」这行摘掉（或另起一处直写），症状是"改个圆角档，导入定位没了、撤销栈错乱"，
   **而且不报错** —— 测试夹具里跑不出来，只有真画布上会坏。
   所以判的是**可达性 + 唯一性**（不是"文件里出现过这个名字"）：
     1) 两处落笔（引擎 Leafer 侧 `applyPatchToNode` / 文档级 `应用补丁`）**函数体内**必须真调到 `合并节点数据(`
        —— 摘掉调用 ⇒ 红；把调用挪到函数外 ⇒ 也红（第五形：多落点只接一个落点正好对目标无效）；
     2) 引擎的 patch 白名单必须有 `case "customData"`（漏了 ⇒ 带填充的合并补丁走不到 rebuild，身份被旧节点覆盖）；
     3) 每份文件里 `合并节点数据(` 只能出现 1 次（多一处 = 有人另写了一份落笔语义）；
     4) v3↔Leafer 往返的两个载体（`token-identity.ts` 的 装载体 / 读载体）必须都带 `tokens`，
        并且 `adapter.ts` 必须**真 import 且真调用**它们（实现搬走了，接线断了照样是"存盘即丢"）；
     5) 读不到源文件 ⇒ 判「未判」，不许把"没看到"读成"干净"。
   与 `radiusSourceGuard` 同一套三态口径，CLI 里合并成一份「本次拒判」。

   ⚠️ 这条判据的**射程边界**（写出来是为了不让下一个人以为它什么都管）：
     · 它判的是「已知两处落笔有没有调合并」，**不是**「所有 customData 写入都走合并」——
       有人新写一处 `node.customData = {...}` 直写，本判据看不见（那要类型级或运行时才挡得住）；
     · 它不吃**死分支**：`if (false) 合并节点数据(...)` 这种"调用在但永不执行"照样绿
       （要挡这一形得把合并搬成能被真调的唯一入口并做行为断言，见 ISS「待定」）。
   所以它的定位是"**把已经接好的两处落笔钉住不许被悄悄摘掉**"，不是"证明没有旁路"。 */
const srcDirNow = () => process.env.CANVAS_SRC_DIR || path.join(ROOT, 'forge-canvas/src')
export const IDENTITY_SRC_FILES = ['engine.ts', 'operation-reducer.ts', 'token-identity.ts', 'adapter.ts']

/** 读三份落笔相关源文件（覆盖口 CANVAS_SRC_DIR 给"造一份摘掉合并的副本"用，调用时现算） */
export function readIdentitySrc() {
  const dir = srcDirNow()
  const 读 = {}
  for (const f of IDENTITY_SRC_FILES) {
    try { 读[f] = fs.readFileSync(path.join(dir, f), 'utf8') } catch { 读[f] = null }
  }
  return 读
}

/** 取函数体（大括号配对）。取不到返回 null ⇒ 调用方必须判「未判」，不许当成"函数没写所以不违规"
 *  ⚠️ 只适用于**签名里没有大括号**的函数（TS 返回类型写成 `& { v2id: string }` 时，第一个 `{` 是类型不是体 —— 会用下面 顶层段） */
export function funcBody(text, name) {
  const i = text ? text.indexOf(`function ${name}(`) : -1
  if (i < 0) return null
  const open = text.indexOf('{', i)
  if (open < 0) return null
  let depth = 0
  for (let j = open; j < text.length; j++) {
    const c = text[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(open, j + 1)
    }
  }
  return null
}

/** 顶层函数的**整段**（从 `function 名(` 那一行到它的收尾 `}`）：不靠大括号配对，
 *  所以签名带 TS 返回类型（`& { v2id: string }`）的函数也能取全。取不到 ⇒ null（未判）。
 *  ⚠️ 终止规则=「下一行**顶格**」（本仓 prettier 下函数体全部缩进）：
 *     第一版是拿「下一个 function/const/class」当终止 ⇒ 后面紧跟 `export interface` 时段会越界，
 *     于是段里出现了别人的 `tokens`，判据当场变**恒真**（10-02 独立审查抓到的 P1①：
 *     删掉 读载体 里那行 tokens，闸门 exit 0、selftest 仍 51/51）。
 *  ⚠️ 只对**顶层**函数有效（嵌套函数的收尾 `}` 是缩进的 ⇒ 会取到外层函数结束）。 */
export function 顶层段(text, name) {
  if (!text) return null
  const 行 = text.split('\n')
  const 起 = 行.findIndex((l) => l.indexOf(`function ${name}(`) >= 0)
  if (起 < 0) return null
  for (let i = 起 + 1; i < 行.length; i++) {
    if (/^\S/.test(行[i])) return /^}(?:;?)?$/.test(行[i]) ? 行.slice(起, i + 1).join('\n') : 行.slice(起, i).join('\n')
  }
  return 行.slice(起).join('\n')
}

/** 落笔点判据主入口。@param 读 {engine.ts, 'operation-reducer.ts', 'token-identity.ts'}，值为 null = 读不到（判未判） */
export function identityWriteGuard(读) {
  const out = []
  const 缺 = IDENTITY_SRC_FILES.filter((f) => !读[f])
  if (缺.length) {
    out.push({ kind: 'identity-src-unreadable', at: `${srcDirNow()}｜${缺.join(' / ')}`, 未判: true,
      detail: `读不到身份落笔相关的源文件 ⇒ 「合并写有没有被摘掉」**未判**（不是干净）：本检查只在仓库检出里有效` })
    return out
  }
  const 引擎 = stripComments(读['engine.ts'])
  const 文档 = stripComments(读['operation-reducer.ts'])
  const 身份 = stripComments(读['token-identity.ts'])
  const 落笔 = (文本, 函数名, 在哪) => {
    const 体 = funcBody(文本, 函数名)
    if (体 === null) {
      out.push({ kind: 'identity-merge-unreachable', at: 在哪, 未判: true, detail: `找不到函数 ${函数名} ⇒ 这一处的合并写**未判**（形状变了要人来对一下，别由门禁猜）` })
      return
    }
    const n = (体.match(/合并节点数据\(/g) ?? []).length
    if (n === 0) out.push({ kind: 'identity-merge-unreachable', at: 在哪, detail: `${函数名} 里没有「合并节点数据(」调用 ⇒ customData 会被整体替换，写身份时顺手冲掉 v2id / sourceRef（不报错，只在真画布上坏）` })
    else if (n > 1) out.push({ kind: 'identity-merge-duplicated', at: 在哪, detail: `${函数名} 里出现 ${n} 次合并调用 ⇒ 同一语义写了两遍，改一处漏一处` })
  }
  落笔(引擎, 'applyPatchToNode', 'forge-canvas/src/engine.ts:applyPatchToNode')
  落笔(文档, '应用补丁', 'forge-canvas/src/operation-reducer.ts:应用补丁')
  const 白名单 = funcBody(引擎, 'toUpdatePatch')
  if (白名单 === null) out.push({ kind: 'identity-patch-gate-unreadable', at: 'engine.ts:toUpdatePatch', 未判: true, detail: '找不到 toUpdatePatch ⇒ 白名单这一项未判' })
  else if (!/case\s+["']customData["']/.test(白名单)) out.push({ kind: 'identity-patch-not-whitelisted', at: 'engine.ts:toUpdatePatch', detail: 'patch 白名单没有 case "customData"（单双引号都认）⇒ 含填充的合并补丁被判成"不可映射"，重建节点时身份带不过去' })
  const 带 = (函数名, 在哪) => {
    const 段 = 顶层段(身份, 函数名)
    if (段 === null) { out.push({ kind: 'identity-carriage-unreadable', at: 在哪, 未判: true, detail: `找不到 ${函数名} ⇒ 往返这一头未判` }); return }
    // 判的是**真搬值**的形状（`带.tokens = …`），不是"段里出现过 tokens 这几个字"：
    // 10-02 独立审查先在段边界上抓到一次恒真（删掉读侧那行照样绿）；修完边界复审又试出第二刀 ——
    // 把搬运行换成 `type _T = { tokens: unknown }` 这种**必需字段类型注解**，`tokens:` 那一支照样被喂饱。
    // 所以只收赋值形：`tokens:` 看着像对象键，实际分不清"取值"还是"声明类型"，弱判据比少判一档更坏
    //（真改成对象字面量写法时同步改这条判据，别指望它自动认得）。
    if (!/\.tokens\s*=/.test(段)) out.push({ kind: 'identity-carriage-dropped', at: 在哪, detail: `${函数名} 里没有「.tokens =」这种真搬运（只剩提到名字或声明类型的形状）⇒ 身份存不进盘/读不回（面板点了档，刷新就没）` })
  }
  带('装载体', 'token-identity.ts:装载体')
  带('读载体', 'token-identity.ts:读载体')
  for (const [名, 文本] of [['engine.ts', 引擎], ['operation-reducer.ts', 文档]]) {
    const n = (文本.match(/合并节点数据\(/g) ?? []).length
    if (n !== 1) out.push({ kind: 'identity-merge-callsite-count', at: `forge-canvas/src/${名}`, detail: `${名} 里合并落笔调用点应为 1，现算 ${n} ⇒ 落笔要么被摘要么被多写（两处落点共用一份语义这条就不成立了）` })
  }
  // 载体必须由 adapter 真接上（搬进 token-identity 之后，"没人 import"就等于往返又断了）
  // ⚠️ 判据里不用 `\b`：中文标识符在 JS 正则里不构成词边界，`\b装载体\b` 永远匹配不上（弱判据的形状之一）
  const 适配 = stripComments(读['adapter.ts'])
  for (const 名 of ['装载体', '读载体']) {
    const 接了 = new RegExp(`import \\{[^}]*${名}[^}]*\\} from ["']\\./token-identity["']`).test(适配)
    const 用了 = 适配.split(`${名}(`).length - 1 >= 1
    if (!接了 || !用了) out.push({ kind: 'identity-carriage-unwired', at: `forge-canvas/src/adapter.ts:${名}`,
      detail: `adapter 里「${名}」${接了 ? '没有被真调用' : '既没 import 也没调用'} ⇒ v3↔Leafer 往返又把身份丢了（存盘即丢，测试全绿）` })
  }
  return out
}

/* 从候选里挑第一份"真带圆角档"的 theme 文本。选择逻辑在纯核 pickThemeText（出码侧共用同一份，K6a），
   本文件只负责把 fs 读法注进去。 */
let themeTextCache
function loadThemeText() {
  if (themeTextCache !== undefined) return themeTextCache
  themeTextCache = themeTextFrom((p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null), process.env)
  return themeTextCache
}
/** 装侧圆角档位表（取根一次、一处用；读不到 ⇒ 空数组 = 「未判」，**绝不返回内置默认表**） */
function radiusStepsNow() {
  const t = loadThemeText()
  return t ? radiusStepsFromTheme(t) : []
}

function declaredVarNames() {
  const names = new Set()
  const addFrom = (txt) => { for (const m of txt.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) names.add(m[1]) }
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'out'].includes(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(css|ts|tsx|js)$/.test(e.name)) { try { addFrom(fs.readFileSync(p, 'utf8')) } catch { /* 读不动 ⇒ 不算看见 */ } }
    }
  }
  for (const pkg of ['forge-design', 'forge-canvas/src', 'forge-pm/src']) walk(path.join(ROOT, pkg))
  const theme = loadThemeVars()
  if (theme) for (const k of [...Object.keys(theme.light), ...Object.keys(theme.dark)]) names.add(k)
  /* --forge-type-* 全族**不在任何源文件里**（运行时由 forge-design 的 typeCssVars 注入 :root），
     纯文本扫描收不到 ⇒ 项目轨产物里的 var(--forge-type-body-size) 会被判成悬空（09-29 端到实测的假红）。
     名字从纯核取（= 从 typeCssVars 的输出里正则回来），不在这里拼命名规则，免得第二份表漂。 */
  for (const v of tokenVarNames()) names.add(v)
  return names
}

/* ───────────── ① 产物文本判据 ───────────── */
export function checkArtifactText(text, file) {
  const hits = []
  const exempt = DECLARATION_FILES.some((re) => re.test(file))
  text.split('\n').forEach((line, i) => {
    const at = `${file}:${i + 1}`
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return // 注释行不算 ⇒ 判据只落代码行
    if (!exempt) {
      const hex = line.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)
      if (hex) hits.push({ kind: 'bare-hex', at, detail: `${hex.length} 处裸色值（${hex.slice(0, 2).join(' ')}）⇒ 项目轨要引 var` })
    }
    // 只抓「字符串字面量里的工具类形态」：className={styles.wrap} 是 CSS Modules 的正当写法
    //（docs/design.md:104 §0.2），一律当预览轨判红就是误伤 —— 第一版就栽在这，被自测的干净样本抓住。
    const cls = line.match(/\b(?:className|class)\s*=\s*(["'`])([^'"`]*)\1/)
    if (cls && cls[2].trim()) {
      hits.push({ kind: 'tailwind-preview', at, detail: `class 是字符串字面量（${cls[2].slice(0, 44)}）⇒ 预览轨产物不许进仓库（DOC-334 §5.4 S3）` })
      const arb = line.match(/\[[0-9a-zA-Z#,.%\-]+\]/g)
      if (arb) hits.push({ kind: 'arbitrary-value', at, detail: `${arb.length} 处任意值（${arb.slice(0, 2).join(' ')}）` })
    }
    for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) hits.push({ kind: 'var-ref', at, detail: m[1], ref: true })
    if (/dangerouslySetInnerHTML|eval\s*\(|\.innerHTML\s*=|javascript:/.test(line)) hits.push({ kind: 'anti-pattern', at, detail: '出现可注入面（dangerouslySetInnerHTML / eval / innerHTML 赋值 / javascript:）' })
    /* 类名形状（09-29 端到端实测补的牙）：CSS 选择器与 JS 点属性都不许以数字起手。
       真稿图层叫「5」「3-active」这类是常态，旧出码层直接把它 slug 成 `.5` / `styles.1-active` ——
       前者是非法选择器（整条规则静默不生效，样式丢一半），后者让产物**根本编译不过**。
       两类都不会有人报错，所以必须落在门禁上，不能靠人肉看。 */
    if (/^\s*\.[0-9]/.test(line)) hits.push({ kind: 'bad-class-selector', at, detail: `类选择器以数字开头（${line.trim().slice(0, 28)}）⇒ CSS 非法，整条规则不生效` })
    const dotNum = line.match(/\bstyles\.([0-9][A-Za-z0-9_-]*)/g)
    if (dotNum) hits.push({ kind: 'bad-class-selector', at, detail: `${dotNum.length} 处 styles.<数字> 点属性（${dotNum.slice(0, 2).join(' ')}）⇒ JS 语法错，产物编译不过` })
  })
  /* 同名规则块（09-29 出码层撞到同一件事后补的门禁侧）：CSS Modules 里两个顶层块写同一个类名
     = 后写的静默覆盖前写的，产物"出码成功"但渲染跟设计稿不符，且没有任何一方报错。
     只数**顶层**：`@media`/`@supports` 里再写一次同名类是正当响应式写法 ⇒ 按花括号深度判，深度 >0 不算。 */
  let depth = 0
  const seenCls = new Map()
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\*|\*|\/\/)/.test(line)) return // 注释里的类名不算定义（与上面逐行判据同一口径）
    const sel = depth === 0 ? /^\s*\.([A-Za-z0-9_-]+)[^{}]*\{/.exec(line) : null
    if (sel) {
      const n = (seenCls.get(sel[1]) ?? 0) + 1
      seenCls.set(sel[1], n)
      if (n > 1) hits.push({ kind: 'dup-class-rule', at: `${file}:${i + 1}`, detail: `顶层类名 .${sel[1]} 第 ${n} 次定义 ⇒ 同名规则互相覆盖（后写吃前写），产物与画布不符` })
    }
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth-- }
  })
  return hits
}

/** 悬空 var：引用了声明集里不存在的名字 */
export function findDanglingVars(hits, declared) {
  return hits.filter((h) => h.ref && !declared.has(h.detail))
}

/* ───────────── ② 画布文档判据（出码前） ───────────── */
/**
 * 这份文本是不是画布文档（而不是出码产物）—— `--file` 那一档靠它拒判。
 *
 * 为什么要有：`--file` 只匹配出码产物要找的模式（裸 hex / 预览轨类 / 悬空 var / dup-class），
 * 一份 canvas.json 里**一条都不命中** ⇒ 旧行为是印「违例 0 · ✓ 全过」并 exit 0（09-29 实测：
 * 同一份真稿 `--file` 给 0、`--doc` 给 99，文件一字未动）。那是 fail-open：
 * "没判"被读成"判过且干净"，而唯一的信号（`文档: null`）藏在 JSON 里、被 stdout 的小结盖住。
 */
export function looksLikeCanvasDoc(text) {
  if (!/^\s*[{[]/.test(text)) return false
  return /"(pages|design|children)"\s*:/.test(text)
}

export async function checkCanvasDoc(docPath) {
  if (!fs.existsSync(docPath)) return { skipped: true, reason: `文档不存在：${docPath}` }
  if (!fs.existsSync(CORE)) return { skipped: true, reason: `缺纯核产物 ${path.relative(ROOT, CORE)}：先跑 cd forge-canvas && bun run build:core` }
  const core = await import(CORE)
  const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'))
  // 背景要取**祖先**的填充，不是自己那份（第一版把文字自己的 fill 当背景 ⇒ 前景=背景 ⇒ 全员 1:1 全红）
  const walk = (nodes, inherited, out = []) => {
    for (const n of nodes || []) {
      out.push({ node: n, bgFill: inherited })
      const own = n.fills?.length ? n.fills[0] : null
      if (n.children) walk(n.children, own ?? inherited, out)
    }
    return out
  }
  const flat = walk(doc.pages?.[0]?.design?.children ?? [], null)
  if (flat.length === 0) return { skipped: true, reason: '文档没有节点 ⇒ 无输入可判' }

  const problems = []
  const mapTable = fs.existsSync(COMPONENT_MAP) ? JSON.parse(fs.readFileSync(COMPONENT_MAP, 'utf8')) : null
  if (!mapTable) problems.push({ kind: 'no-component-map', at: '-', detail: `缺 ${path.relative(ROOT, COMPONENT_MAP)} ⇒ 组件身份一律不判；先跑 node scripts/component-map.mjs --write` })

  /* 圆角项先收集，判据放在循环外一次跑：档位表来自装侧 theme（`radiusStepsNow()`），
     读不到时**整域不判并记「未判」**——逐个圆角判"不在档"会把环境问题报成稿子的问题（假红）。
     这份收集与判定抽在 radiusStepProblems 里，selftest 打的就是同一条路（不留"测试测另一套"的窗口）。 */
  const 圆角项 = []
  for (const { node } of flat) {
    if (typeof node.fontSize === 'number') {
      const r = core.mapStep('type', node.fontSize)
      if (!r.ok) problems.push({ kind: 'type-out-of-step', at: node.name || node.id, detail: `字号 ${node.fontSize} 不在 role 阶梯（最近 ${r.nearestName}=${r.nearestValue}，差 ${r.delta}）⇒ 人工定档` })
    }
    /* ISS-590：间距在 v3 里住在 **`node.layout.*`**（`frameLayoutSchema`，schema.ts:82-91），
       不是节点顶层。上一版读 `node.paddingLeft / node.paddingTop / node.itemSpacing` ——
       前两个在真文档里恒为 undefined，第三个**在 schema 里根本不存在** ⇒ 这一域恒为空判（fail-open）。
       现修正为：真形状（`layout.*`）**必判**；顶层旧键只作兼容（v2 迁移前的文档），
       且两者都读，不互相覆盖（同一节点可能同时有 layout 与旧键，那是脏数据，各自记账）。 */
    const layout = node.layout && typeof node.layout === 'object' ? node.layout : null
    const 间距项 = []
    if (layout) {
      for (const key of ['gapX', 'gapY', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
        const v = layout[key]
        if (typeof v === 'number' && v > 0) 间距项.push([key, v])
      }
    }
    // 兼容：v3 之前的扁平键（含 schema 里不存在的 itemSpacing，读到就说明文档脏，仍要判）
    for (const key of ['paddingLeft', 'paddingTop', 'itemSpacing']) {
      const v = node[key]
      if (typeof v === 'number' && v > 0) 间距项.push([`${key}(顶层·非 v3 形状)`, v])
    }
    for (const [key, v] of 间距项) {
      const r = core.mapStep('space', v)
      if (!r.ok) problems.push({ kind: 'space-out-of-step', at: `${node.name || node.id}.${key}`, detail: `间距 ${v}px 不在档（最近 ${r.nearestName}=${r.nearestValue}，差 ${r.delta}）` })
    }
    const radii = typeof node.cornerRadius === 'number' ? [node.cornerRadius] : (Array.isArray(node.rectangleCornerRadii) ? node.rectangleCornerRadii : [])
    for (const v of radii) if (typeof v === 'number' && v > 0) 圆角项.push({ value: v, at: node.name || node.id })
    if (mapTable) {
      const res = core.resolveComponent(node.name, mapTable)
      if (res.state !== 'mapped') problems.push({ kind: `component-${res.state}`, at: node.name || node.id, detail: res.说明 })
    }
  }

  // 档位表现从装侧 theme 取（本脚本不备第二份），取不到 ⇒ 整域判「未判」并把这句话带进结果
  const 圆角判 = radiusStepProblems(core, 圆角项, radiusStepsNow())
  problems.push(...圆角判.问题)
  const 圆角档未判 = 圆角判.未判

  const rootFill = flat.find((x) => x.node.fills?.length)?.node.fills[0]?.color
  const 本稿主题 = rootFill && luminance(rootFill) > 0.5 ? 'light' : 'dark'
  const 未判主题 = 本稿主题 === 'light' ? 'dark' : 'light'
  const tv = loadThemeVars()
  let judged = 0, 另主题判了 = 0, 换算不出 = 0, 换算歧义 = 0
  for (const { node, bgFill } of flat) {
    if (node.type !== 'TEXT' || !node.fills?.length) continue
    const fg = node.fills[0].color
    if (!fg) continue
    const alpha = node.fills[0].opacity ?? fg.a ?? 1
    // 本稿主题按画出来的色判；另一主题只在"这个色确实是某个 token"时按该 token 的另一套值判
    for (const themeKey of [本稿主题, 未判主题]) {
      let fgc = fg, bgc = bgFill?.color ?? null, varName = ''
      if (themeKey !== 本稿主题) {
        const conv = otherThemeColor(tv, fg, themeKey)
        if (conv?.歧义) { 换算歧义++; continue }
        if (!conv) { 换算不出++; continue }
        fgc = conv
        // 容器色同理：歧义或换算不出 ⇒ 退回主题基色（不是拿本主题的容器色硬搬到另一主题）
        const convBg = bgc ? otherThemeColor(tv, bgc, themeKey) : null
        bgc = convBg && !convBg.歧义 ? convBg : null
        varName = conv.名 ?? varName
        另主题判了++
      }
      const base = hexToRgb01(THEME_BASE[themeKey])
      const under = bgc ? composite(bgc, bgFill.opacity ?? 1, base) : base
      const ratio = contrast(composite(fgc, alpha, under), under)
      judged++
      const need = isLargeText(node.fontSize ?? 14, node.fontWeight) ? AA_LARGE : AA_BODY
      if (ratio + 1e-9 < need) {
        problems.push({ kind: 'contrast', at: `${node.name || node.id}（${themeKey}）`, detail: `文字 ${rgbToHex(fgc)} 对底 ${rgbToHex(under)} 实测 ${ratio.toFixed(2)}:1 < 要求 ${need}:1（${node.fontSize ?? '缺'}px / 字重 ${node.fontWeight ?? '缺'}${themeKey === 本稿主题 ? '' : ` · 按 ${varName || '未知 token'} 在 ${themeKey} 主题的取值换算`}）` })
      }
    }
  }
  return {
    skipped: false, 节点: flat.length, 对比度判了: judged, 另主题判了, 换算不出, 换算歧义, 问题: problems.length, 本稿主题,
    未判: {
      圆角档: 圆角档未判 ?? null,
      对比度另一主题: tv
        ? `另一主题（${未判主题}）有 ${换算不出} 个文字节点的颜色**不是 token 色** ⇒ 换算不出、不判（不拿本主题值冒充）；能换算的 ${另主题判了} 个已按该 token 的另一套色判过`
        : `取不到安装侧 theme ⇒ 另一主题整体不判（本主题按 docs/design.md:216 的底色基准判）`,
    },
    problems,
  }
}

/* ───────────── CLI ───────────── */
const isCli = !!process.argv[1] && import.meta.url === pathToFileURLSafe(process.argv[1])
function pathToFileURLSafe(p) { try { return new URL('file://' + fs.realpathSync(p)).href } catch { return '' } }

if (isCli && process.argv.includes('--selftest')) {
  /* 进门先验"纯核 bundle 与 src 同代"（10-02 对抗审查的 F 条 + 我手工复现过一次）：
     本文件的文档档判据吃 `lib/canvas-core.js`（入库产物），抄表判据吃 `src/token-map.ts`（源）。
     bundle 停在摘表之前 ⇒ "源码检查过了、判定还在用旧档位表"这种空档就出现了。
     旧写法是把这条做成一条用例，但那时 selftest 早在 `checkCanvasDoc(FIXTURE)` 里调
     `radiusStepsFromTheme`（旧 bundle 没这个导出）崩了 —— 退出码非 0 是 fail-closed，可一行 ✗ 都没有，
     没人看得懂为什么红。**判据要抢在崩溃前面说话**，所以做成入口闸门：不同代就当场点名 + 给唯一出路并 exit 2。 */
  const 核 = await import(CORE)
  if (!coreGenerationOk(核)) {
    console.error('✗ 纯核 bundle 与 src **不同代**：还带着摘表之前的档位表，或者没有 radiusStepsFromTheme / radiusVarName')
    console.error('  ⇒ 本轮自检作废（判的是旧行为，绿也不算数）。唯一出路：cd forge-canvas && bun run build:core 再跑一次')
    process.exit(2)
  }
  const badArtifact = [
    'export function Frame1() {',
    '  return <div className="bg-[#f5f5f5] p-[13px] text-[13.7px]" style={{ color: "#1f2429" }} />',
    '}',
    'const html = "<b>" + eval(payload) + "</b>"',
    'const cfg = { __html: raw, dangerouslySetInnerHTML: cfg }',
  ].join('\n')
  const cleanArtifact = [
    'import styles from "./Frame1.module.css"',
    'export function Frame1() {',
    '  return <div className={styles.wrap}><span className={styles.label}>标题</span></div>',
    '}',
  ].join('\n')
  const fx = await checkCanvasDoc(FIXTURE)
  const declared = declaredVarNames()
  const kinds = (hs) => new Set(hs.map((h) => h.kind))
  const hitsBad = checkArtifactText(badArtifact, 'out/bad.tsx')
  const hitsClean = checkArtifactText(cleanArtifact, 'out/good.tsx')
  const cases = [
    ['① CSS Modules 的 className={styles.x} 不算违例（干净产物零误伤）', hitsClean.length === 0],
    ['② 裸 hex 必被抓', kinds(hitsBad).has('bare-hex')],
    ['③ class 写成字符串字面量（预览轨）必被抓', kinds(hitsBad).has('tailwind-preview')],
    ['④ 任意值必被抓', kinds(hitsBad).has('arbitrary-value')],
    ['⑤ 可注入面必被抓', kinds(hitsBad).has('anti-pattern')],
    ['⑥ 声明集非空（否则悬空 var 判据恒绿）', declared.size > 0],
    ['⑦ 悬空 var 能抓到', findDanglingVars(checkArtifactText('a { color: var(--matter-not-declared-anywhere) }', 'out/x.module.css'), declared).length === 1],
    /* 反向断言用**声明集里真存在的名字**（原来我写死 --dsw-text-primary，那是猜的、根本不存在 ⇒ 假红）。
       动态取一个，既证不抓合法引用，也顺带证明声明集不是空的 */
    ['⑧ 已声明的 var 不算悬空（反向：不抓合法引用）', (() => { const v = [...declared][0]; return !!v && findDanglingVars(checkArtifactText(`a { color: var(${v}) }`, 'out/x.module.css'), declared).length === 0 })()],
    ['⑨ 例外按文件名写死：改名后同一行要重新算违例（双向失效）', (() => {
      const line = 'export const c = "#1f2429"'
      return !kinds(checkArtifactText(line, 'forge-design/src/tokens.ts')).has('bare-hex') && kinds(checkArtifactText(line, 'forge-design/src/tokens-renamed.ts')).has('bare-hex')
    })()],
    ['⑩ 注释行不算违例（判据只落代码行）', checkArtifactText('// 示例色 #ff0000', 'out/x.tsx').filter((h) => h.kind === 'bare-hex').length === 0],
    ['⑪ 仓库正样本 fixture 真跑一遍必须全过（判据坏了当场发现，不写死 true）', !fx.skipped && fx.问题 === 0],
    /* 09-29 端到端假红的钉子：--forge-type-* 只由 typeCssVars 运行时注入，源码扫不到 ⇒
       补进声明集后，项目轨产物里的合法引用不能再判悬空（正向），而**同族拼错的名字仍要判**（反向）——
       后者防的是"把整族前缀放行"这种修法，那等于把这条判据拆了。 */
    ['⑫ token 生成族的真名不算悬空（正向：--forge-type-body-size）', (() => {
      const v = tokenVarNames().find((x) => x === '--forge-type-body-size')
      return !!v && findDanglingVars(checkArtifactText(`a { font-size: var(${v}) }`, 'out/Component.module.css'), declared).length === 0
    })()],
    ['⑬ 同族拼错的名字仍判悬空（反向：不许退化成前缀放行）', findDanglingVars(checkArtifactText('a { font-size: var(--forge-type-body-ghostsize) }', 'out/Component.module.css'), declared).length === 1],
    /* 09-29 出码层撞到"同名类互相覆盖"之后补的门禁侧：出码器修好了，但别人手改产物 / 另一条生成路径
       还会犯，所以这条判据得在门禁上，而不是只活在我自己的用例里。 */
    ['⑭ 顶层同名类名必被抓（两条规则写同一个类 = 后写吃前写）',
      (() => { const h = checkArtifactText('.a { color: #fff }\n.b { color: #000 }\n.a { border-radius: 4px }', 'out/Component.module.css'); return h.filter((x) => x.kind === 'dup-class-rule').length === 1 })()],
    ['⑮ @media 里再写同名类不许报（反向：深度非 0 不算顶层重复）',
      (() => { const h = checkArtifactText('.a { color: #fff }\n@media (min-width: 600px) {\n  .a { color: #000 }\n}', 'out/Component.module.css'); return h.filter((x) => x.kind === 'dup-class-rule').length === 0 })()],
    ['⑯ 注释里的类名不算定义（反向：注释掉的旧规则不该把判据点红）',
      (() => { const h = checkArtifactText('/* .a { color: red } */\n.a { color: #fff }', 'out/Component.module.css'); return h.filter((x) => x.kind === 'dup-class-rule').length === 0 })()],
  ]
  /* 深浅主题复查（C6 第 1 项）：另一主题的判定依赖 token 名换算 ⇒ 正反各一枚。
     反向那枚防的是一种很具体的偷懒：把本主题的颜色直接搬到另一主题去算，那样永远恒绿。 */
  const fakeTv = {
    浅色名: { '#0f1115': ['--dsw-alias-text'] }, 深色名: { '#f2f3f5': ['--dsw-alias-text'] },
    light: { '--dsw-alias-text': { r: 15 / 255, g: 17 / 255, b: 21 / 255 } },
    dark: { '--dsw-alias-text': { r: 242 / 255, g: 243 / 255, b: 245 / 255 } },
  }
  const darkOf = otherThemeColor(fakeTv, { r: 15 / 255, g: 17 / 255, b: 21 / 255 }, 'dark')
  const lightOf = otherThemeColor(fakeTv, { r: 242 / 255, g: 243 / 255, b: 245 / 255 }, 'light')
  cases.push(
    ['⑰ token 色可换算到另一主题（深浅两值都参与对比度判定）',
      !!darkOf && darkOf.r > 0.9 && !!lightOf && lightOf.r < 0.1],
    ['⑱ 不是 token 的颜色不许换算（反向：不拿本主题值冒充另一主题）',
      otherThemeColor(fakeTv, { r: 0.5, g: 0.2, b: 0.1 }, 'dark') === null &&
      otherThemeColor(fakeTv, { r: 15 / 255, g: 17 / 255, b: 21 / 255 }, 'light') === null &&
      otherThemeColor(null, { r: 0, g: 0, b: 0 }, 'dark') === null],
  )
  /* 换算歧义那枚是 09-29 自己踩出来的：活体稿的「标题」先被判成 dark 下 1.00:1，
     实际是"同一个浅色 hex 挂在多个 token 上、各自深色值不同"——挑错名字就会算错。 */
  const tv2 = {
    浅色名: { '#ffffff': ['--dsw-alias-card-fill', '--dsw-static-white'] },
    dark: { '--dsw-alias-card-fill': { r: 44 / 255, g: 44 / 255, b: 46 / 255 } },
    light: {}, 深色名: {},
  }
  const 白 = { r: 1, g: 1, b: 1 }
  cases.push(
    ['⑲ 同一浅色 hex 挂着多个 token、深色取值不一致 ⇒ 判"歧义"而非挑一个算',
      otherThemeColor(tv2, 白, 'dark')?.歧义 === true],
    ['⑳ 多个 token 但深色取值一致 ⇒ 仍判（唯一解，别把能判的也躲掉）',
      (() => {
        const tv3 = {
          浅色名: { '#ffffff': ['--dsw-alias-a', '--dsw-alias-b'] },
          dark: { '--dsw-alias-a': { r: 0.1, g: 0.1, b: 0.1 }, '--dsw-alias-b': { r: 0.1, g: 0.1, b: 0.1 } },
          light: {}, 深色名: {},
        }
        const got = otherThemeColor(tv3, 白, 'dark')
        return !!got && got.歧义 === undefined && Math.abs(got.r - 26 / 255) < 1e-9 && got.名 === "--dsw-alias-a"
      })()],
  )
  /* ㉑–㉔ 是 09-29 那条 fail-open 的钉子：`--file` 收到画布文档必须**拒判**（exit 2），
     不许像旧版那样因为"产物要找的模式一条都不命中"而印「违例 0 · ✓ 全过」。
     两条正交的控制：㉒ 证明谓词不误伤真产物（否则拒判会退化成"全都拒"），
     ㉔ 走 CLI 端到端证明干净产物照样 0。 */
  const { spawnSync } = await import('node:child_process')
  const self = path.join(ROOT, 'scripts', 'canvas-style-check.mjs')
  const docText = fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, 'utf8') : ''
  // env 必须清掉外设的 DSH_THEME_CLIENT：否则在这变量被设过的机器上，㉑–㉔ 会被外层 theme 的状态带红（第 2 轮审查第 1 刀的第二处，我按它做完 selftest 仍 37/39 才发现）
  const runCli = (argv) => { const e = { ...process.env }; delete e.DSH_THEME_CLIENT; return spawnSync(process.execPath, [self, ...argv], { encoding: 'utf8', env: e }) }
  const tmpClean = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csc-')), 'Frame1.tsx')
  fs.writeFileSync(tmpClean, cleanArtifact)
  const cliDoc = runCli(['--file', FIXTURE])
  const cliArtifact = runCli(['--file', tmpClean])
  cases.push(
    ['㉑ 谓词认得出画布文档（拿真 fixture 判，不是拿我编的串判）',
      docText.length > 0 && looksLikeCanvasDoc(docText) === true],
    ['㉒ 谓词不误伤出码产物（干净与脏两份产物都必须判 false ⇒ 拒判不是恒拒）',
      looksLikeCanvasDoc(cleanArtifact) === false && looksLikeCanvasDoc(badArtifact) === false],
    ['㉓ CLI 契约：--file 收画布文档 ⇒ 拒判 exit 2 并点名该走 --doc，且不许印「全过」',
      cliDoc.status === 2 && /请用 --doc/.test(cliDoc.stderr) && !/全过/.test(cliDoc.stdout)],
    ['㉔ 同匹配方式的正对照：干净产物走 --file 仍判 0（把上面那条的红归给"形状不符"，不是归给"闸恒红"）',
      cliArtifact.status === 0 && /文档档未判/.test(cliArtifact.stdout)],
  )
  const badCls = checkArtifactText('.5 { color: red; }\nconst A = <div className={styles.1-active} />', 'out/bad2.tsx')
  const goodCls = checkArtifactText(".n-5 { color: red; }\nconst A = <div className={styles['n-5']} />", 'out/good2.tsx')
  cases.push(
    ['㉕ 类名以数字开头必被抓（CSS 选择器与 styles.<数字> 两种形状各一条）',
      badCls.filter((h) => h.kind === 'bad-class-selector').length === 2],
    ['㉖ 合法类名不误伤（带字母前缀 + 方括号访问 ⇒ 0 命中；否则 ㉕ 是恒红的闸）',
      goodCls.filter((h) => h.kind === 'bad-class-selector').length === 0,
      `实际 ${goodCls.map((h) => h.kind).join(',') || '无'}`],
  )
  /* ── 圆角档位来源（10-02 重写：档位表吃 theme-tokens，守卫判"有没有第二份来源"） ──
     用例编号沿用旧序列，但**每条判的东西换了**，所以逐条写明它钉的是哪一种坏形状。 */
  const coreMod = await import(CORE)
  const 官六档 = ':root { --dsw-radius-xs: 4px; --dsw-radius-sm: 8px; --dsw-radius-md: 12px; --dsw-radius-lg: 16px; --dsw-radius-xl: 20px; --dsw-radius-panel: 28px; }'
  const 读源 = () => fs.readFileSync(tokenMapSrcNow(), 'utf8')
  const 真tokenMap = 读源()
  /* ㊸ 必须**先判、且把后面依赖新 API 的用例包起来**：10-02 手工把摘表之前的 bundle 盖回来验过一次 ——
     那时候 ㉞ 直接 TypeError 把整个 selftest 打死（退出码非 0，是 fail-closed，但一行 ✗ 都没有，
     没人看得懂"为什么红"）。判据要抢在崩溃前面说话，所以这里：
       · bundle 同代与否用**行为探针**判（`mapStep('radius',12,[])` 必须是 empty-step-table），不是只看名字；
       · 后面三条用 core 的用例走 `判()`，崩了记 false（红）而不是掀桌子，并把异常种类记进 `崩` 里另外印一行
         —— 否则"实现坏到抛异常"与"判定为否"在输出里一模一样（10-02 复核的第二 nit）。 */
  const 崩 = []
  const 判 = (f, 标) => {
    try { return f() === true } catch (e) { 崩.push(`${标 || '未命名用例'}：${e instanceof Error ? e.message : String(e)}`); return false }
  }
  const 抄表样本 = {
    变量名: 'export const x = { md: "--dsw-radius-md" }',
    旧常量: 'export const OFFICIAL_RADIUS = []',
    档值对: 'export const t = [{ name: "sm", value: 8 }]',
    内置数组: 'const radiusSteps = [8, 12]',
    默认参数: 'export const radiusTable = (steps: RadiusStep[] = [8, 12]) => ({ entries: steps })',
  }
  cases.push(
    ['㉗ 正对照：仓库里那份 token-map.ts（注释里全是 --dsw-radius-* 与旧表名）**走守卫本身**判 0 条 ⇒ 剥注释这件事长在判据里，不是用例自己剥',
      radiusSourceGuard(':root { --dsw-radius-sm: 8px; }', 真tokenMap).filter((d) => d.kind === 'radius-second-table').length === 0,
      `实际 ${radiusSourceGuard(':root { --dsw-radius-sm: 8px; }', 真tokenMap).map((d) => d.kind).join(' ｜ ') || '无'}`],
    ['㉘ 五种"抄回第二份表"的形状各有牙：官方变量名字面量 / 旧常量名 / 档名+数值对 / 内置数字数组 / steps 默认参数',
      Object.values(抄表样本).every((t) => radiusLiteralHits(stripComments(t)).length >= 1) &&
      (() => { const g = radiusSourceGuard(':root { --dsw-radius-sm: 8px; }', 抄表样本.档值对); return g.length >= 1 && g.every((d) => d.kind === 'radius-second-table') })(),
      `实际 ${Object.entries(抄表样本).map(([k, t]) => `${k}:${radiusLiteralHits(stripComments(t)).length}`).join(' ')}`],
    ['㉙ 反向控制：同样的内容只写在注释里 ⇒ 不算抄表（不剥注释这条守卫从第一天起就恒红）',
      radiusLiteralHits(stripComments('/* 官方 --dsw-radius-sm = 8px，旧常量 OFFICIAL_RADIUS 已摘 */\nexport const radiusTable = (steps) => ({ entries: steps })')).length === 0],
    ['㉚ theme 读不到 ⇒ 判「未判」一条（at=theme），不许返回空数组被读成通过',
      (() => { const g = radiusSourceGuard(null, 真tokenMap); return g.length === 1 && g[0].at === 'theme' && g[0].未判 === true })()],
    ['㉛ 装侧有 --dsw-radius-* 声明但一条都解不出 px ⇒ 判「未判」，不是"官方没档"也不是通过',
      (() => { const g = radiusSourceGuard(':root { --dsw-radius-sm: 0.5rem; --dsw-radius-md: 8pxpx; }', 真tokenMap); return g.length === 1 && g[0].未判 === true && /一条都没解成/.test(g[0].detail) })()],
    ['㉜ 解不出的条数必须点名（1 条写 rem 被跳过 ⇒ 面板/出码看到的档位少一档，不许静默）',
      radiusSourceGuard(':root { --dsw-radius-sm: 8px; --dsw-radius-md: 12px; --dsw-radius-lg: 0.75rem; }', 真tokenMap).some((d) => d.kind === 'radius-step-unparsable' && /1 条/.test(d.detail))],
    ['㉝ 同名重复声明 ⇒ 必须报"取了首值、可能有第二套"（不许静默二选一）',
      radiusSourceGuard(':root { --dsw-radius-sm: 8px; --dsw-radius-sm: 10px; }', 真tokenMap).some((d) => d.kind === 'radius-dup-declaration' && /1 处同名重复/.test(d.detail))],
    ['㉞ 档位真从 theme 走而不是常量：装侧 md 换成 13 ⇒ 13 在档、12 变成不在档（同一段代码两种结论）',
      判(() => {
        const 步 = radiusStepsFromTheme(':root { --dsw-radius-sm: 8px; --dsw-radius-md: 13px; }')
        return 步.length === 2 && coreMod.mapStep('radius', 13, 步).ok === true && coreMod.mapStep('radius', 12, 步).ok === false &&
          coreMod.mapStep('radius', 8, 步).names[0] === 'sm' && radiusVarName('md') === '--dsw-radius-md'
      }, '㉞ 档位从 theme 走')],
    ['㉟ doc 模式：没有档位表 ⇒ 圆角整域不判（0 违例 + 一句未判）——否则每个圆角都算违例，那是把环境问题报成稿子问题',
      判(() => { const r = radiusStepProblems(coreMod, [{ value: 999, at: 'n' }], []); return r.问题.length === 0 && /未判/.test(r.未判) }, '㉟ doc 空表不判')],
    ['㊱ doc 模式：有档位表 ⇒ 官方没有的形状（胶囊 999）必须被抓，且写明最近档（不许就近吸附）',
      判(() => {
        const 步 = radiusStepsFromTheme(':root { --dsw-radius-xs: 4px; --dsw-radius-sm: 8px; --dsw-radius-panel: 28px; }')
        const r = radiusStepProblems(coreMod, [{ value: 999, at: 'chip' }, { value: 8, at: 'ok' }], 步)
        return r.问题.length === 1 && r.问题[0].at === 'chip' && /最近 panel=28/.test(r.问题[0].detail) && /不许就近吸附/.test(r.问题[0].detail)
      }, '㊱ doc 抓 999')],
  )
  /* ㊲㊳㊴ 是 10-02 main 上那 2 条红的钉子：数据根搬家后旧路径的文件还在但没有 `--dsw-radius-*`，
     旧代码只认一个路径 ⇒ 读到陈旧那份 ⇒ 报假漂移；而且我把漂移写成"先 exit 再判"，
     连 `--file` 那档的退出码都被改掉（环境问题冒充判红）。两条各治一半。 */
  const 假读 = (map) => (p) => (p in map ? map[p] : null)
  const withRadius = ':root { --dsw-radius-sm: 8px; }'
  const stale = ':root { --dsw-alias-text: #0f1115; }'
  cases.push(
    ['㊲ 选路取"真有圆角档"的那份，跳过文件在但档位没了的陈旧份；都没有 ⇒ null（未判）',
      pickThemeText(假读({ '/a': stale, '/b': withRadius }), ['/a', '/b']) === withRadius &&
      pickThemeText(假读({ '/a': stale, '/b': stale }), ['/a', '/b']) === null],
  )
  const spawnWith = (env, argv) => {
    // 值为 undefined 的键要**删掉**而不是传下去：㊴ 想模拟"这台机器没装引擎"，
    // 若继承调用者自己的 DSH_THEME_CLIENT（第 2 轮审查的第 1 刀），设过这个变量的机器上 selftest 直接少一条
    const e = { ...process.env, ...env }
    for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k]
    return spawnSync(process.execPath, [self, ...argv], { encoding: 'utf8', env: e })
  }
  const 空根 = fs.mkdtempSync(path.join(os.tmpdir(), 'csc-nohome-'))
  const tmp = (name, text) => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csc-')), name); fs.writeFileSync(p, text); return p }
  const 坏源 = tmp('token-map.ts', 抄表样本.档值对)
  const 旧引擎 = tmp('client.js', stale)
  const cliSecondTable = spawnWith({ CANVAS_TOKEN_MAP_TS: 坏源 }, ['--file', tmpClean])
  const cliSecondTableSkippedDoc = spawnWith({ CANVAS_TOKEN_MAP_TS: 坏源 }, ['--doc', path.join(空根, 'nope.json')])
  const cliNoTheme = spawnWith({ HOME: 空根, DSH_HOME: 空根, DSH_THEME_CLIENT: undefined, CANVAS_TOKEN_MAP_TS: undefined }, ['--fixture'])
  const cliStaleTheme = spawnWith({ HOME: 空根, DSH_HOME: 空根, DSH_THEME_CLIENT: 旧引擎, CANVAS_TOKEN_MAP_TS: undefined }, ['--fixture'])
  cases.push(
    ['㊳ 有人把档位表抄回 token-map ⇒ 拒判：exit 2、点名"第二份来源"、stdout 不许出现「✓ 全过」（哪怕这轮只判产物）',
      cliSecondTable.status === 2 && /第二份|radius-second-table/.test(cliSecondTable.stderr) && !/全过/.test(cliSecondTable.stdout),
      `exit=${cliSecondTable.status}｜${cliSecondTable.stderr.trim().split('\n')[0]}`],
    ['㊴ 拒判 + 文档档被跳过（--doc 指不存在的稿）⇒ 依旧拒判，不许退回「全过」exit 0（10-02 审查实测到的 fail-open 窗口）',
      cliSecondTableSkippedDoc.status === 2 && !/全过/.test(cliSecondTableSkippedDoc.stdout),
      `exit=${cliSecondTableSkippedDoc.status}｜${cliSecondTableSkippedDoc.stdout.trim().split('\n').pop()}`],
    ['㊵ 一份 theme 都读不到（空 HOME + 清掉覆盖口）⇒ 判「未判」不判红：--fixture 仍 exit 0、未判走 stderr、stdout 仍可解析',
      cliNoTheme.status === 0 && /未判/.test(cliNoTheme.stderr) && /全过/.test(cliNoTheme.stdout),
      `exit=${cliNoTheme.status}｜stderr=${cliNoTheme.stderr.trim().split('\n')[0]}`],
    ['㊶ 覆盖口指到"旧引擎那份"（文件在、没有圆角档）⇒ 同样判未判且 exit 0，不许报假漂移（10-02 main 上那 2 条红的原形）',
      cliStaleTheme.status === 0 && /未判/.test(cliStaleTheme.stderr) && !/第二份|真漂/.test(cliStaleTheme.stderr),
      `exit=${cliStaleTheme.status}｜stderr=${cliStaleTheme.stderr.trim().split('\n')[0]}`],
  )
  cases.push(
    ['㉠ 候选根里必须有生产盘 .dsh-matter 且排在旧盘 .dsh 前（摘掉这条候选 ⇒ 本用例红，别让它静默退回旧根）',
      (() => {
        const c = themeCandidatePaths({ HOME: '/h' })
        const iMatter = c.findIndex((p) => p.includes('/.dsh-matter/'))
        const iOld = c.findIndex((p) => p.includes('/.dsh/profiles/'))
        return iMatter >= 0 && iOld >= 0 && iMatter < iOld
      })()],
    ['㊷ 覆盖口必须**调用时**生效（同进程证伪）：设 CANVAS_TOKEN_MAP_TS 指到抄了表的那份 ⇒ 现读必须换成它，撤掉又要换回来。' +
      '原来这条走子进程传 env，定格/现算两种实现跑出来一样 ⇒ 恒真（10-02 审查抓到的第 2 枚）',
      (() => {
        const 抄了没 = () => radiusSourceGuard(官六档, 读源()).filter((d) => d.kind === 'radius-second-table').length
        const 前 = process.env.CANVAS_TOKEN_MAP_TS
        process.env.CANVAS_TOKEN_MAP_TS = 坏源
        const 换了 = tokenMapSrcNow() === 坏源 && 抄了没() === 1
        if (前 === undefined) delete process.env.CANVAS_TOKEN_MAP_TS
        else process.env.CANVAS_TOKEN_MAP_TS = 前
        const 换回 = tokenMapSrcNow() !== 坏源 && 抄了没() === 0
        return 换了 && 换回
      })()],
  )
  /* ㊸ 单独一支：它测的是**探针本身**（三种假 bundle），不是当前产物 —— 当前产物由进门闸门保证，
     写成"再测一遍真 bundle"就是恒绿用例（10-02 复核抓的就是这个：我差点留了一条永远不可能红的用例）。 */
  const 假旧核 = { radiusStepsFromTheme: () => [], radiusVarName: (n) => `--dsw-radius-${n}`, mapStep: () => ({ ok: true, names: ['md'] }) }
  const 带旧表 = { radiusStepsFromTheme: () => [], radiusVarName: () => '', OFFICIAL_RADIUS: [{ name: 'sm', value: 8 }], mapStep: () => ({ ok: false, reason: 'empty-step-table' }) }
  const 真同代 = { radiusStepsFromTheme: () => [], radiusVarName: () => '', mapStep: (_d, _v, s) => (s && s.length ? { ok: true, names: ['md'] } : { ok: false, reason: 'empty-step-table' }) }
  const 探针坏 = coreGenerationOk(假旧核) !== false
  const 探针盲 = coreGenerationOk(带旧表) !== false
  const 探针误杀 = coreGenerationOk(真同代) !== true
  cases.push(
    ['㊸ 产物同代探针**自己**要能识破三种 bundle（预检只吃这一份实现，探针没牙=整批白判）：' +
      '① 名字全在但 mapStep 行为是旧的（空表也返回 ok）② 还带着 OFFICIAL_RADIUS ③ 真同代形状 —— 前两条必须判 false、第三条必须判 true',
      探针坏 === false && 探针盲 === false && 探针误杀 === false,
      `旧行为核被放=${探针坏} 带旧表被放=${探针盲} 真同代被误杀=${探针误杀}`],
  )
  /* ㊹–㊿ 身份合并写的落笔点判据（ISS-567 / PRJ-020 M1）。这条为什么值得进门禁：
     把 `合并节点数据` 那行摘掉之后**全量测试照样绿**，只有真画布会坏 —— 写一个圆角档顺手把
     `v2id`（引擎认节点/撤销/增量保存靠它）和 `sourceRef`（K3 导入定位）冲掉，而且不报错。
     所以判的是**可达性**（调用必须落在两处落笔函数的体内），不是"文件里出现过这个名字" ——
     ㊻ 就是专门证后者不够的那一刀（同一族教训：多落点的闸只接了一个落点）。 */
  const 真源 = readIdentitySrc()
  const 有源 = IDENTITY_SRC_FILES.every((f) => typeof 真源[f] === 'string' && 真源[f].length > 100)
  /** 造样本：逐处替换，**每处必须命中恰好 1 次**（命中 0 或多次 ⇒ null，这条用例当场红，不许"没改成也算过"） */
  const 改样 = (f, ...对) => {
    let t = 真源[f] ?? ''
    for (const [从, 到] of 对) {
      const n = t.split(从).length - 1
      if (n !== 1) return null
      t = t.replaceAll(从, 到)
    }
    return { ...真源, [f]: t }
  }
  const 点名 = (读) => identityWriteGuard(读).map((d) => `${d.kind}${d.未判 ? '(未判)' : ''}@${d.at}`).join(' ｜ ') || '无'
  const 摘合并 = 'customData: 合并节点数据('
  cases.push(
    ['㊹ 正对照 + 未判档：真仓库那三份必须 0 条非未判项（判据语法没写错），读不到源文件必须只出「未判」而不是"干净"',
      有源 &&
      identityWriteGuard(真源).filter((d) => !d.未判).length === 0 &&
      (() => {
        const g = identityWriteGuard({ 'engine.ts': null, 'operation-reducer.ts': null, 'adapter.ts': null })
        return g.length === 1 && g[0].未判 === true && g[0].kind === 'identity-src-unreadable'
      })(),
      `有源=${有源}｜真源判出=${点名(真源)}`],
    ['㊺ 摘掉合并写（引擎侧改成整体替换）⇒ 必须红且点名 applyPatchToNode：这是"测试全绿、真画布静默丢 v2id"那一格',
      (() => {
        const s = 改样('engine.ts', [摘合并, 'customData: 整体替换('])
        if (!s) return false
        const g = identityWriteGuard(s)
        return g.some((d) => d.kind === 'identity-merge-unreachable' && /applyPatchToNode/.test(d.at)) &&
          g.some((d) => d.kind === 'identity-merge-callsite-count')
      })(),
      (() => { const s = 改样('engine.ts', [摘合并, 'customData: 整体替换(']); return s ? 点名(s) : '落刀失败：engine.ts 里没命中那一句' })()],
    ['㊻ 合并调用**挪到函数外**（另起一个顶层函数去调）⇒ 仍要红：这条证明判据吃的是"落笔函数体内"，不是"文件里出现过这个名字"' +
      '（数量守恒那一档此刻仍是绿的 —— 弱判据放不掉这一形）',
      (() => {
        const s = 改样('engine.ts', [摘合并, 'customData: 铺平('],
          ['\nexport type Tool =', `\nfunction 铺平(原: object | undefined, 新: object | undefined) { return 合并节点数据(原, 新) }\nexport type Tool =`])
        if (!s) return false
        const g = identityWriteGuard(s)
        return g.some((d) => d.kind === 'identity-merge-unreachable') &&
          !g.some((d) => d.kind === 'identity-merge-callsite-count')
      })(),
      (() => {
        const s = 改样('engine.ts', [摘合并, 'customData: 铺平('],
          ['\nexport type Tool =', `\nfunction 铺平(原: object | undefined, 新: object | undefined) { return 合并节点数据(原, 新) }\nexport type Tool =`])
        return s ? 点名(s) : '落刀失败：engine.ts 的替换点没命中'
      })()],
    ['㊼ patch 白名单漏 `case "customData"` ⇒ 红（漏了它，带填充的合并补丁被判成"不可映射"，重建节点时身份丢）',
      (() => {
        const s = 改样('engine.ts', ['case "points":\n        case "customData":', 'case "points":'])
        if (!s) return false
        return identityWriteGuard(s).some((d) => d.kind === 'identity-patch-not-whitelisted')
      })(),
      (() => { const s = 改样('engine.ts', ['case "points":\n        case "customData":', 'case "points":']); return s ? 点名(s) : '落刀失败：白名单那两行没按预期相连' })()],
    ['㊽ 往返断掉的三种形状都要红：① 写侧载体不带 tokens ② **读侧**载体不带 tokens（两头各打一刀，' +
      '只打一头就是 10-02 审查抓到的 P1① —— 段取宽了读到别人的 tokens，判据恒真）③ 载体还在但 adapter 不再 import/调用它',
      (() => {
        const 丢写侧 = 改样('token-identity.ts', ['if (customData?.tokens) 带.tokens = customData.tokens', 'void customData'])
        const 丢读侧 = 改样('token-identity.ts', ['  if (c.tokens && typeof c.tokens === "object") 出.tokens = c.tokens as 载体数据["tokens"]\n', ''])
        const 断接线 = 改样('adapter.ts', ['import { 读载体, 装载体 } from "./token-identity"', '// 接线断了：这一行被摘掉'])
        if (!丢写侧 || !丢读侧 || !断接线) return false
        const a = identityWriteGuard(丢写侧).filter((d) => d.kind === 'identity-carriage-dropped')
        const b = identityWriteGuard(丢读侧).filter((d) => d.kind === 'identity-carriage-dropped')
        const c = identityWriteGuard(断接线)
        const 段 = 顶层段(stripComments(真源['token-identity.ts'] ?? ''), '读载体') ?? ''
        return a.length === 1 && /装载体/.test(a[0].at) &&
          b.length === 1 && /读载体/.test(b[0].at) &&
          c.filter((d) => d.kind === 'identity-carriage-unwired').length === 2 && c.every((d) => d.kind !== 'identity-carriage-dropped') &&
          !段.includes('可判节点') // 段不许越界到下一个顶层声明（越界就是恒真的成因）
      })(),
      (() => {
        const 丢写侧 = 改样('token-identity.ts', ['if (customData?.tokens) 带.tokens = customData.tokens', 'void customData'])
        const 丢读侧 = 改样('token-identity.ts', ['  if (c.tokens && typeof c.tokens === "object") 出.tokens = c.tokens as 载体数据["tokens"]\n', ''])
        const 断接线 = 改样('adapter.ts', ['import { 读载体, 装载体 } from "./token-identity"', '// 接线断了：这一行被摘掉'])
        const 段 = 顶层段(stripComments(真源['token-identity.ts'] ?? ''), '读载体') ?? ''
        if (!丢写侧) return '落刀失败：装载体里那句 tokens 赋值没命中'
        if (!丢读侧) return '落刀失败：读载体里那句 tokens 赋值没命中'
        if (!断接线) return '落刀失败：adapter 的 import 那句没命中（写法变了要同步改这条夹具）'
        if (段.includes('可判节点')) return `读载体的段越界（${段.split('\n').length} 行）⇒ 判据恒真`
        return `写侧→${点名(丢写侧)}｜读侧→${点名(丢读侧)}｜断线→${点名(断接线)}`
      })()],
    ['㊾ 出现**第二处**落笔（文档级另起一个也调合并的函数）⇒ 数量守恒那一档红：两处落点共用一份语义这条不许悄悄变三份',
      (() => {
        const s = 改样('operation-reducer.ts', ['function 应用补丁(', 'function 也这样铺(原: object | undefined, 新: object | undefined) { return 合并节点数据(原, 新) }\nfunction 应用补丁('])
        if (!s) return false
        return identityWriteGuard(s).some((d) => d.kind === 'identity-merge-callsite-count' && /operation-reducer/.test(d.at))
      })(),
      (() => { const s = 改样('operation-reducer.ts', ['function 应用补丁(', 'function 也这样铺(原: object | undefined, 新: object | undefined) { return 合并节点数据(原, 新) }\nfunction 应用补丁(']); return s ? 点名(s) : '落刀失败：reducer 里那句函数声明没命中' })()],
  )
  const 身份副本 = fs.mkdtempSync(path.join(os.tmpdir(), 'cisrc-'))
  for (const f of IDENTITY_SRC_FILES) fs.writeFileSync(path.join(身份副本, f), 真源[f] ?? '')
  fs.writeFileSync(path.join(身份副本, 'engine.ts'), (真源['engine.ts'] ?? '').replaceAll(摘合并, 'customData: 整体替换('))
  const cli摘合并 = spawnWith({ CANVAS_SRC_DIR: 身份副本, CANVAS_TOKEN_MAP_TS: undefined }, ['--fixture'])
  cases.push(
    ['㊿ 这条判据必须**接进了 CLI**（不只活在 selftest）：把源码副本摘掉合并再指过去 ⇒ exit 2、stderr 点名 identity-merge-unreachable、stdout 不许出现「全过」',
      (真源['engine.ts'] ?? '').split(摘合并).length - 1 === 1 &&
      cli摘合并.status === 2 && /identity-merge-unreachable/.test(cli摘合并.stderr) && !/全过/.test(cli摘合并.stdout),
      `exit=${cli摘合并.status}｜stderr=${cli摘合并.stderr.trim().split('\n')[0] || '(空)'}`],
  )
  /* ── ISS-590 间距判据：读的是真形状（layout.*）还是不存在于 schema 的扁平键 ──
     这一域**此前一条用例都没有**，正是它 fail-open 至今没被发现的原因（真形状恒 0 条而无人察觉）。
     判据走 `checkCanvasDoc`（与 CLI 同一条路），不另写一份判定 —— 免得"测的是另一套逻辑"。
     双向钉住：真形状阶梯外必须红、真形状在档必须绿、旧扁平键仍要判（兼容不许退化成漏判）。 */
  const 间距用例 = (children) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cspace-'))
    const p = path.join(d, 'doc.json')
    fs.writeFileSync(p, JSON.stringify({ version: 3, documentId: 'canvas', revision: 1, pages: [{ id: 'page-1', name: 'P', design: { children } }] }))
    return p
  }
  const frameNode = (id, extra) => ({ id, type: 'FRAME', name: id, x: 0, y: 0, width: 400, height: 300, children: [], ...extra })
  const 数间距 = (r) => (r.problems || []).filter((x) => x.kind === 'space-out-of-step').length
  const 真外 = await checkCanvasDoc(间距用例([frameNode('f1', { layout: { gapY: 7 } })]))
  const 真内 = await checkCanvasDoc(间距用例([frameNode('f2', { layout: { gapY: 8 } })]))
  const 真padding = await checkCanvasDoc(间距用例([frameNode('f3', { layout: { paddingLeft: 7 } })]))
  const 旧扁平 = await checkCanvasDoc(间距用例([frameNode('f4', { paddingLeft: 7 })]))
  cases.push(
    ['㊀真形状（layout.gapY）阶梯外的值 ⇒ 必须判红：上一版读 node.gapY（不存在）⇒ 这一格恒 0 条，是 fail-open',
      数间距(真外) === 1,
      `实际 ${数间距(真外)} 条（problems=${JSON.stringify((真外.problems || []).map((x) => x.kind))}）`],
    ['㊁真形状且值在档（layout.gapY=8）⇒ 不许误报（判据宽到见数值就红同样是坏形状）',
      数间距(真内) === 0,
      `实际 ${数间距(真内)} 条`],
    ['㊂真形状的 padding 四个方向也吃判据（layout.paddingLeft）⇒ 红',
      数间距(真padding) === 1,
      `实际 ${数间距(真padding)} 条`],
    ['㊃旧扁平键（非 v3 形状，含 schema 里不存在的 itemSpacing）仍要判 ⇒ 兼容不许退化成漏判',
      数间距(旧扁平) === 1,
      `实际 ${数间距(旧扁平)} 条`],
  )
  const fails = cases.filter((c) => !c[1])
  // 失败必须带"实际是什么"：第三元 `实际 …` 以前根本没印过（复核抓的 nit），判否与崩在输出里长得一样
  for (const [n, ok, note] of cases) console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : `\n    ↳ ${note || '（这条没写实际值）'}`}`)
  if (崩.length) for (const b of 崩) console.error(`⚠ 用例抛异常（已记红，不是跳过）：${b}`)
  console.log(`canvas-style-check selftest ${cases.length - fails.length}/${cases.length} 通过`)
  process.exit(fails.length ? 2 : 0)
}

if (isCli) {
  const args = process.argv.slice(2)
  /* 每一档（--selftest / --fixture / --doc / --file）都先过"产物同代"这道闸（10-02 复核抓的第三 nit：
     闸门原先只装在 --selftest 分支，直接跑 --fixture 遇旧 bundle 仍是一句裸 TypeError，exit 1，没人看得懂）。
     判的是旧档位表时**任何**结论都不作数，所以宁可拦下来给一句人话加唯一出路。 */
  const 核 = await import(CORE)
  if (!coreGenerationOk(核)) {
    console.error('✗ 纯核 bundle 与 src **不同代**（缺 radiusStepsFromTheme / radiusVarName，或还带着旧的档位表）⇒ 本次不作判定')
    console.error('  ⇒ 唯一出路：cd forge-canvas && bun run build:core 再跑一次（判的是旧行为时，绿也不算数）')
    process.exit(2)
  }
  const declared = declaredVarNames()
  /* 档位来源状态（10-02 重写后的三种状态，别混成"警告+全过"）：
     · **有第二份来源**（有人把圆角档位表抄回 token-map）或装侧声明读不懂（解不出/重名）⇒ 工具的真相源坏了 ⇒ **拒判**：
       exit 2，且 stdout 不许出现「✓ 全过」。留窗口的旧写法是"只在 `文档结果` 非 null 时计入违例"，
       `--doc` 指到不存在/空文档 ⇒ 文档档被跳过 ⇒ 打两行警告却印「全过」exit 0（审查实测到的 fail-open）。
     · **读不到 theme / 读不到源文件**（CI 空 HOME、没装引擎、文件不在）⇒ 判「未判」：明说没判、不影响退出码
       （同 ISS-751/774：不许把环境问题读成代码坏）。
     · 拒判 ≠ 判红产物：消息点名"是档位来源坏了，不是你的稿子/产物有问题"，并给出路。 */
  const 档位状态 = radiusSourceGuard(loadThemeText(), readTokenMapSrc())
  /* 身份落笔点判据（M1）与档位来源同一种"工具自己的真相源"状态：坏 ⇒ 拒判；读不到 ⇒ 未判。
     分开两种状态是因为出路完全不同：档位坏了要改解析，落笔坏了是把合并调用摘了。 */
  const 拒判来源 = [...档位状态, ...identityWriteGuard(readIdentitySrc())]
  const 拒判 = 拒判来源.filter((d) => !d.未判)
  for (const d of 拒判来源.filter((x) => x.未判)) console.error(`⚠ 未判：${d.at} —— ${d.detail}`) // 走 stderr：--json 的 stdout 必须保持可被 JSON.parse（第 2 轮审查第 3 刀）
  if (拒判.length) {
    for (const d of 拒判) console.error(`✗ ${d.kind} ${d.at} —— ${d.detail}`)
    const 是档位 = 拒判.some((d) => d.kind.startsWith('radius'))
    const 是身份 = 拒判.some((d) => d.kind.startsWith('identity'))
    console.error(`  ⇒ ${是档位 && 是身份 ? '圆角档位的**来源**与身份的**落笔点**' : 是身份 ? '令牌身份的**落笔点/往返**' : '圆角档位的**来源**'}出了问题 ⇒ **工具自己的真相源坏了，本次拒判**（不是判红你的稿子或产物）。`)
    if (是档位) {
      console.error('  ⇒ 出路：档位只能由 `radiusStepsFromTheme(装侧 theme)` 现解（要改口径就改 `theme-tokens.ts` 的解析），')
      console.error('         不许在 `forge-canvas/src/token-map.ts` 里抄第二份数字表；若是装侧 theme 的写法变了，把 DSH_THEME_CLIENT/数据根指到当前引擎那份再看。')
    }
    if (是身份) {
      console.error('  ⇒ 出路：`customData` 只能经 `合并节点数据` 合并写入（engine.applyPatchToNode 与 operation-reducer.应用补丁')
      console.error('         两处落笔共用同一份语义），往返由 token-identity 的 装载体 / 读载体 携带 tokens（adapter 必须真调用它们）；')
      console.error('         要换形状就同步改这条判据，别只摘调用 —— 那会在真画布上静默冲掉 v2id / sourceRef。')
    }
    process.exit(2)
  }
  const 产物 = []
  let 文档结果 = null
  const 跳过 = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--file') {
      // 一次跟多个产物：项目轨一件产物是 Component.tsx + Component.module.css **两件**，
      // 旧写法一个 --file 只吃一个路径，第二个参数被当未知项**静默跳过** ⇒ 判了 1 件、以为判了 2 件
      const files = []
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) files.push(args[++i])
      if (files.length === 0) { console.error('✗ --file 后面没有路径'); process.exit(2) }
      for (const f of files) {
        if (!fs.existsSync(f)) { console.error(`✗ 找不到产物文件：${f}`); process.exit(2) }
        const text = fs.readFileSync(f, 'utf8')
        if (looksLikeCanvasDoc(text)) {
          // 拒判而不是给"全过"：这一档不吃画布文档，给了 0 就是假绿
          console.error(`✗ --file 收到的是画布文档：${path.relative(ROOT, f)} —— 这一档只判出码产物（.tsx/.css/.html）；画布文档请用 --doc`)
          process.exit(2)
        }
        const hits = checkArtifactText(text, f)
        const bad = [...hits.filter((h) => h.kind !== 'var-ref'), ...findDanglingVars(hits, declared)]
        产物.push({ 文件: path.relative(ROOT, f), 违例: bad.length, 明细: bad })
      }
    } else if (a === '--fixture' || a === '--doc') {
      const p = a === '--fixture' ? FIXTURE : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : pickCanvasDoc())
      const r = await checkCanvasDoc(p)
      if (r.skipped) 跳过.push({ 项: path.relative(ROOT, p), 原因: r.reason })
      else 文档结果 = { ...r, 项: a === '--fixture' ? 'fixture' : path.relative(ROOT, p) }
    } else if (a === '--verbose' || a === '--json' || a === '--selftest') {
      // 开关位：本身不产判定（--selftest 在上面分支已提前退出，留在这里是为了让"参数拼错=没判"这条不变红）
    } else {
      // 未知参数**必须报错**，不许像旧版那样掉进 else 什么都不做：
      // 掉下去的那条路径就是"我以为判了两个产物、其实只判了一个"（09-29 端到端实测撞到）
      console.error(`✗ 不认识的参数：${a}（只认 --file / --doc / --fixture / --selftest / --verbose / --json）`)
      process.exit(2)
    }
  }

  if (!args.some((a) => ['--file', '--doc', '--fixture', '--selftest'].includes(a))) {
    console.log('用法：--selftest | --fixture | --file <产物>… | --doc [canvas.json]（没输入就算没判，exit 3）')
    process.exit(3)
  }

  const total = 产物.reduce((s, x) => s + x.违例, 0) + (文档结果?.问题 ?? 0)
  if (args.includes('--json')) { fs.writeSync(1, JSON.stringify({ 产物, 文档: 文档结果, 跳过 }, null, 1) + '\n'); process.exit(total ? 1 : 0) } // ISS-832: total=违例 ⇒ 1（原 2，而 2 现为「判不了」）

  for (const p of 产物) {
    console.log(`${p.文件}：违例 ${p.违例}`)
    if (args.includes('--verbose')) for (const h of p.明细) console.log(`   · [${h.kind}] ${h.at} ${h.detail}`)
  }
  if (文档结果) {
    console.log(`${文档结果.项}：${文档结果.节点} 节点 · 对比度判了 ${文档结果.对比度判了} 次（另一主题 ${文档结果.另主题判了 ?? 0} 次 · 不判：非 token 色 ${文档结果.换算不出 ?? 0} 个 / 换算歧义 ${文档结果.换算歧义 ?? 0} 个）· 问题 ${文档结果.问题}`)
    const byKind = {}
    for (const p of 文档结果.problems) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1
    for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`   · ${k.padEnd(24)} ${v}`)
    // 「未判」要和「问题」分开放：这一档没判成不是稿子的错，但也不能不提（不提就等于通过）
    for (const [k, v] of Object.entries(文档结果.未判 ?? {})) if (v) console.log(`   ○ 未判 · ${k}：${v}`)
    if (args.includes('--verbose')) for (const p of 文档结果.problems.slice(0, 14)) console.log(`     - ${p.at}：${p.detail}`)
  }
  for (const s of 跳过) console.log(`⚠ 未判：${s.项} —— ${s.原因}（未判 ≠ 通过，见 code.md §0.7）`)
  // 小结必须自己说清"这一轮没判哪一档"：总数 0 不等于两档都过了（09-29 那条 fail-open 的另一面）
  if (产物.length && !args.some((a) => ['--doc', '--fixture'].includes(a))) {
    console.log('○ 文档档未判：本次只判出码产物。画布文档要过 --doc 才判阶梯外值 / 对比度 / 组件身份')
  }
  console.log(total ? `✗ canvas-style-check：违例 ${total} 条` : '✓ canvas-style-check：全过')
  process.exit(total ? 1 : 0) // ISS-832：违例=1（同上）
}
