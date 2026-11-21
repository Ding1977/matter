// 提取规划稿里的 mermaid 块 → 生成一个自检页（含正反对照）
// 用法：node scripts/check-mermaid.mjs <md 文件> > /tmp/mermaid-check.html
//
// 2026-10-20（ISS-626）：渲染内核换成 Pele 1.7.0 ⇒ 本页从 mermaid.render 改为**同步**的 pele.render，
// 资产指向同目录的 pele.global.js（用 file:// 打开时脚本按文档字符集解码 ⇒ head 里必须有 meta charset）。
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// UMD 唯一副本：ISS-846 资产归一后住 forge-mermaid（原先硬编码指向已退役文件中心插件的绝对路径 ⇒ 断链）。
// 顺手去掉硬编码仓库路径：按本脚本位置推导，换机/换工作树都成立。
const UMD = join(dirname(fileURLToPath(import.meta.url)), '..', 'forge-mermaid', 'static', 'mermaid', 'pele.global.js')
const mdPath = process.argv[2]
if (!mdPath) { console.error('用法: node check-mermaid.mjs <md>'); process.exit(2) }
const md = fs.readFileSync(mdPath, 'utf8')
const blocks = []
let cur = null
for (const line of md.split('\n')) {
  if (/^\s*```mermaid\s*$/.test(line)) { cur = []; continue }
  if (cur && /^\s*```\s*$/.test(line)) { blocks.push(cur.join('\n')); cur = null; continue }
  if (cur) cur.push(line)
}
// 反控：一段故意坏掉的 mermaid，必须报错，否则说明这套自检本身是假的
const NEG = 'flowchart LR\n  A --[>} B'
const names = blocks.map((_, i) => `positive-${i + 1}`)
const all = [...blocks, NEG]
const labels = [...names, 'negative-control(MUST FAIL)']
const pages = all.map((src, i) => `<section data-i="${i}"><h3>${labels[i]}</h3><pre class="mermaid">${src.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre></section>`).join('\n')
process.stdout.write(`<!doctype html><html><head><meta charset="utf-8">
<script src="file://${UMD}"></script>
</head><body>
<div id="report">running…</div>
${pages}
<script>
window.__RESULT__ = { errors: [], rendered: [] }
;(async () => {
  const secs = [...document.querySelectorAll('section')]
  for (const s of secs) {
    const src = s.querySelector('pre').textContent
    const label = s.dataset.i
    try {
      // Pele 的 render 是同步的，且**纯字符串进出、不碰 DOM** ⇒ 没有 Mermaid 那套"失败把错误 svg 挂到
      // body 直下、还得自己清残留"的包袱。limit 放开到 2e5：默认 5e4 会拒掉 module-graph 那张 55,984 字符的图。
      const { svg } = pele.render(src, { limit: 200000 })
      if (!/<svg/.test(svg)) throw new Error('no svg output')
      window.__RESULT__.rendered.push(label)
    } catch (e) {
      window.__RESULT__.errors.push(label + ': ' + String(e && e.message ? e.message : e).split('\\n')[0])
    }
  }
  document.getElementById('report').textContent = JSON.stringify(window.__RESULT__)
})()
</script></body></html>
`)
console.error(`提取到 ${blocks.length} 段 mermaid + 1 段反控`)
