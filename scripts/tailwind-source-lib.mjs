// scripts/tailwind-source-lib.mjs —— Tailwind v4 `@source` 消费者通道（ISS-694 §M6-1 第 2 子批撞出来的盲区）
//
// 为什么要有这一支：
//   「零引用」原先只看 JS/TS 的 import 子句。但 Tailwind 生成 CSS 时读的是**源码文本**，
//   于是「没人 import 的文件」仍然可以是某个页面样式表的**类供体** —— 删掉它，JS 一字不动、
//   产物里的原子类却静默少几条 ⇒ 组件还在渲染、样式没了。
//   活例（09-23 实测）：forge-model/src/styles/tailwind-input.css 里
//     @source "../../node_modules/forge-pm/src/components/ui/slider.tsx";
//   而套餐页渲染的 <EffortSlider> 用的是 forge-agents 那份 slider（不在 forge-model 的扫描范围内），
//   它的 touch-none / grow / border-primary 正是靠上面这条"供体"进来的；删文件后 forge-model 的
//   tailwind.css 少了这三条，而 client.js 里 Slider 的 JSX 一行没变 —— 只比 JS 看不见这类差异。
//
// v4 的两条行为（本仓已在 forge-ui 的头注释里实测记下）：
//   ① `@source` 指向**文件** = 扫该文件**所在目录**（不是只扫那一个文件）；
//   ② `@source not` 是排除，不能当覆盖；解析基准是**样式表自身所在目录**，不是 CWD。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SOURCE_RE = /@source\s+(not\s+)?(["'])(.*?)\2/g

/** 收集样式表里的 @source 指令：覆盖目录 / 点名文件 / 悬空目标 / 排除项 */
export function collectSources(cssFiles) {
  const dirs = new Set()
  const files = new Set()
  const dangling = []     // 目标不存在 ⇒ 这条根本没在扫（供体已失效，属 ISS-614 那类"空判"）
  const exclusions = []   // @source not：只登记，不参与覆盖
  for (const css of cssFiles) {
    const text = fs.readFileSync(css, 'utf8')
    for (const m of text.matchAll(SOURCE_RE)) {
      const [, not, , raw] = m
      const abs = path.resolve(path.dirname(css), raw)
      if (not) { exclusions.push({ css: path.basename(css), raw }); continue }
      let st = null
      try { st = fs.statSync(abs) } catch { /* 悬空 */ }
      if (!st) { dangling.push({ css: path.basename(css), raw, abs }); continue }
      // @source 常写成 `../../node_modules/<pkg>/src/...`；那是软链，必须 realpath 回真实源树，
      // 否则"工作树/主树"两条路径永远对不上（同一份代码在两棵树里量出两个覆盖集）。
      const real = path.dirname(fs.realpathSync(abs))
      const target = real === path.dirname(abs) ? abs : path.join(real, path.basename(abs))
      if (st.isDirectory()) dirs.add(target)
      else { files.add(target); dirs.add(path.dirname(target)) }   // ① 指向文件 = 扫整目录
    }
  }
  return { dirs, files, dangling, exclusions }
}

/** 源文件是否落在任何 @source 射程内（含"指向文件 ⇒ 整目录"顺带覆盖的那些兄弟文件） */
export function makeCssCovered(srcFiles, src) {
  const covered = new Set()
  for (const f of srcFiles) {
    for (const d of src.dirs) {
      if (f === d || f.startsWith(d + path.sep)) { covered.add(f); break }
    }
  }
  for (const f of src.files) covered.add(f)
  return covered
}

/** 造一棵最小临时树验五条口径都有牙（判据自己也要被证明，不然这一支等于没装） */
export function selftestTailwindSource(report = (s) => console.log(s)) {
  // realpath 过的基目录：collectSources 会 realpath 目标，两边必须同一口径（macOS 的 /tmp 是软链）
  const root = path.join(fs.realpathSync(os.tmpdir()), `tw-src-selftest-${process.pid}-${Date.now()}`)
  const styleDir = path.join(root, 'pkg/src/styles')
  const uiDir = path.join(root, 'pkg/src/components/ui')
  const otherDir = path.join(root, 'pkg/src/other')
  fs.mkdirSync(styleDir, { recursive: true })
  fs.mkdirSync(uiDir, { recursive: true })
  fs.mkdirSync(otherDir, { recursive: true })
  const donor = path.join(uiDir, 'slider.tsx')
  const sibling = path.join(uiDir, 'textarea.tsx')
  const outside = path.join(otherDir, 'card.tsx')
  for (const f of [donor, sibling, outside]) fs.writeFileSync(f, 'export const X = 1\n')
  const css = path.join(styleDir, 'tailwind-input.css')
  fs.writeFileSync(css, [
    '@source "../components/ui/slider.tsx";   // 指向文件 ⇒ 整目录',
    '@source not "./generated.css";           // 排除，不算覆盖',
    '@source "../../ghost/nowhere.tsx";       // 悬空：目标不存在',
  ].join('\n'))

  const src = collectSources([css])
  const all = [donor, sibling, outside]
  const covered = makeCssCovered(all, src)
  const cases = [
    ['① 被点名的文件算覆盖', covered.has(donor)],
    ['② 同目录的兄弟文件一起被扫（v4 行为①）', covered.has(sibling)],
    ['③ 目录外的文件不算覆盖', !covered.has(outside)],
    ['④ `@source not` 既不进覆盖也不被当悬空', src.exclusions.length === 1 && !src.dangling.some((d) => /generated/.test(d.raw)) && !covered.has(path.join(styleDir, 'generated.css'))],
    ['⑤ 目标不存在 ⇒ 记悬空（这条其实没在扫）', src.dangling.length === 1 && /ghost/.test(src.dangling[0].raw)],
  ]
  // 反向控制：把供体那条注掉 ⇒ 覆盖集合必须空（防"恒判有覆盖"的假绿）
  fs.writeFileSync(css, '/* 无 @source */\n')
  const off = makeCssCovered(all, collectSources([css]))
  fs.rmSync(root, { recursive: true, force: true })
  cases.push(['⑥ 摘掉 @source ⇒ 覆盖集合为空（反向控制，防恒绿）', off.size === 0])

  let bad = 0
  for (const [n, ok] of cases) { report(`${ok ? '✓' : '✗'} ${n}`); if (!ok) bad++ }
  return { pass: cases.length - bad, total: cases.length }
}
