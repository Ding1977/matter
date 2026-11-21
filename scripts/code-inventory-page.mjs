#!/usr/bin/env node
// scripts/code-inventory-page.mjs
// 代码规范对照器 —— 把 code-inventory 的度量 + docs/code-audit.md 的文案渲染成一页可打开的对照器
// 用法：node scripts/code-inventory-page.mjs [输出路径]（默认 docs/mockups/code-inventory-<日期>.html）
//
// 为什么要有这个页面：老板看不了 JSON，也看不了 600 行表格 —— 设计侧每条批复都靠"可打开的对照器"（见
// docs/mockups/）。文案**只从 docs/code-audit.md 读**（不在这里重写一遍 ⇒ 禁双写），数字**只从脚本 JSON 读**。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const NODE = process.execPath
const AUDIT = path.join(ROOT, 'docs', 'code-audit.md')
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'mockups', `code-inventory-${new Date().toISOString().slice(0, 10)}.html`)

const data = JSON.parse(execFileSync(NODE, [path.join(ROOT, 'scripts', 'code-inventory.mjs'), '--json'], { maxBuffer: 1 << 28, encoding: 'utf8' }))
const doc = fs.readFileSync(AUDIT, 'utf8')

// 取文档指定章节（按二级标题切），生成块不参与渲染（数字由脚本给）
function section(title) {
  const lines = doc.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(title))
  if (start < 0) return `（文档里找不到「${title}」）`
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith('## ')) { end = i; break }
  return lines.slice(start + 1, end).join('\n').trim()
}
const SECTIONS = {
  intro: section('0. 一页看懂'),
  decisions: section('2. 待拍板清单'),
  blind: section('3. 显式盲区'),
  outline: section('4. 规范章节骨架'),
}

// ── 极简 markdown → HTML（只覆盖本仓库文档实际用到的语法）──
function md2html(src) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/→/g, '<span class="arrow">→</span>')
  const out = []
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*$/.test(l)) { continue }
    if (/^(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); continue }
    if (/^###\s+/.test(l)) { out.push(`<h3>${inline(l.replace(/^###\s+/, ''))}</h3>`); continue }
    if (/^>\s?/.test(l)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++ }
      i--
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`)
      continue
    }
    if (/^\|/.test(l)) {
      const rows = []
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++ }
      i--
      const cells = (r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      const head = cells(rows[0])
      const body = rows.slice(2).map(cells)
      out.push(`<table class="md"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    if (/^- /  .test(l)) {
      const buf = []
      while (i < lines.length && /^(- |\s{2,}- )/.test(lines[i])) { buf.push(lines[i].replace(/^\s*-\s+/, '')); i++ }
      i--
      out.push(`<ul>${buf.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>`)
      continue
    }
    if (/^```/.test(l)) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++ }
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`)
      continue
    }
    out.push(`<p>${inline(l)}</p>`)
  }
  return out.join('\n')
}

const SECMETA = {
  B: { name: '包与装配', q: '这个包是插件还是库？挂上了吗？有没有人依赖它？' },
  N: { name: '目录与形态', q: '入口在哪、文件叫什么、一个文件该多大？' },
  H: { name: '半区与依赖方向', q: '谁能 import 谁、host/client 怎么分、依赖声明全不全？' },
  C: { name: '契约与铁律', q: '工具 schema / render / 端点 / 存储 —— 引擎与跨包契约守住了吗？' },
  D: { name: '重复与共享层', q: '同一件事有几份实现？该沉的沉了吗？' },
  T: { name: '测试与门禁', q: '规矩有牙吗？还是只写在文档里？' },
  E: { name: '错误处理与可观测', q: '出事看得见吗？错误能被上层分流吗？' },
  Z: { name: '死码与引用', q: '这些代码还有人用吗？' },
}
const KEY = { B: ['B4', 'B5', 'B8'], N: ['N2', 'N4', 'N6'], H: ['H9', 'H10', 'H5b'], C: ['C8', 'C9', 'C7'], D: ['D2', 'D3', 'D4'], T: ['T7', 'T4', 'T6'], E: ['E8', 'E3', 'E1'], Z: ['Z1', 'Z2', 'B5'] }

const metricById = new Map(data.metrics.map((m) => [m.id, m]))
const cards = Object.keys(SECMETA).map((sec) => {
  const ms = (KEY[sec] || []).map((id) => metricById.get(id)).filter(Boolean)
  return `<article class="card"><h2><span class="sec">${sec}</span>${SECMETA[sec].name}</h2>
    <p class="q">${SECMETA[sec].q}</p>
    ${ms.map((m) => `<div class="kv"><span class="v${String(m.value).length > 12 ? ' long' : ''}">${m.value}</span><span class="t">${m.id} ${m.title}</span></div>`).join('')}
  </article>`
}).join('\n')

const tables = Object.keys(SECMETA).map((sec) => {
  const ms = data.metrics.filter((m) => m.sec === sec)
  return `<section class="secblock" id="s-${sec}">
    <h2><span class="sec">${sec}</span>${SECMETA[sec].name}<button class="jump" data-sec="${sec}">仅本章</button></h2>
    <table class="data"><thead><tr><th>#</th><th>度量</th><th>值</th><th>门禁候选</th><th>热点</th></tr></thead><tbody>
    ${ms.map((m) => `<tr data-id="${m.id}"><td class="id">${m.id}</td><td>${m.title}</td><td class="num">${m.value}</td><td>${m.gate || '—'}</td><td>${m.offenders.length ? `<button class="open" data-id="${m.id}">${m.offenders.length} 条</button>` : '—'}</td></tr>`).join('')}
    </tbody></table>
    ${ms.filter((m) => m.offenders.length).map((m) => `<details id="d-${m.id}"><summary>${m.id} 明细${m.note ? ' · ' + m.note : ''}</summary><ul>${m.offenders.map((o) => `<li><code>${o.k}</code>${o.n !== undefined ? ` <b class="num">×${o.n}</b>` : ''}${o.d ? ` — ${o.d}` : ''}</li>`).join('')}</ul></details>`).join('')}
  </section>`
}).join('\n')

const pkgRows = data.packages.slice().sort((a, b) => b.sloc - a.sloc).map((p) => `<tr><td>${p.p}</td><td class="num">${p.src}</td><td class="num">${p.sloc}</td><td class="num">${p.tests}</td><td class="num">${p.expects}</td><td class="num">${p.tests ? (p.src / p.tests).toFixed(0) : '∞'}</td></tr>`).join('')
const depRows = data.deps.filter((d) => d.to.length).map((d) => `<tr><td>${d.from}</td><td>${d.to.join(' · ')}</td></tr>`).join('')
const vendorRows = data.vendor.map((v) => `<tr><td>${v.k}</td><td class="num">${v.n}</td></tr>`).join('')

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>代码规范对照器 · ${data.header.date}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1c1a;--mut:#6b6b66;--line:#e4e4e0;--acc:#2f5cff;--warn:#b4341c;--ok:#1f7a4d;--card:#fff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme: dark){:root{--bg:#16171a;--fg:#ececea;--mut:#9a9a94;--line:#2c2d31;--acc:#7d9bff;--warn:#e2745c;--ok:#5cc48e;--card:#1d1e22}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
header{padding:32px 24px 20px;border-bottom:1px solid var(--line);background:var(--card)}
.wrap{max-width:1100px;margin:0 auto;padding:0 24px 80px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--mut);font-size:13px;margin:0}
.meta{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:14px;font-size:12px;color:var(--mut)}
.meta code{font-family:var(--mono);font-size:11.5px;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin:22px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card h2{font-size:14px;margin:0 0 2px;display:flex;align-items:center;gap:8px}
.card .q{color:var(--mut);font-size:12px;margin:0 0 10px}
.kv{display:flex;gap:10px;align-items:baseline;padding:5px 0;border-top:1px dashed var(--line)}
.kv .v{font-variant-numeric:tabular-nums;font-weight:600;font-size:15px;min-width:64px;max-width:44%;color:var(--acc);word-break:break-word}
.kv .v.long{font-size:12px;line-height:1.4;font-weight:600}
.kv .t{font-size:11.5px;color:var(--mut);line-height:1.35}
.sec{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:5px;background:var(--fg);color:var(--bg);font-size:11px;font-weight:700}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0 6px}
nav a{font-size:12.5px;text-decoration:none;color:var(--fg);border:1px solid var(--line);background:var(--card);border-radius:20px;padding:5px 12px}
nav a:hover{border-color:var(--acc)}
h2{font-size:17px;margin:34px 0 10px;display:flex;align-items:center;gap:9px}
h3{font-size:15px;margin:22px 0 6px}
table{border-collapse:collapse;width:100%;font-size:13px;background:var(--card)}
th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:12px;position:sticky;top:0;background:var(--card)}
td.num,.num{font-variant-numeric:tabular-nums}
table.md td:first-child{white-space:nowrap;color:var(--mut)}
.id{font-family:var(--mono);font-size:12px;color:var(--mut)}
button{font:inherit;cursor:pointer}
.open{border:1px solid var(--line);background:var(--bg);color:var(--acc);border-radius:6px;padding:1px 8px;font-size:12px}
.jump{border:1px solid var(--line);background:var(--bg);color:var(--mut);border-radius:6px;padding:1px 8px;font-size:11px;font-weight:400}
details{margin:8px 0 0;border:1px solid var(--line);border-radius:8px;background:var(--card);padding:0 12px}
details[open]{padding-bottom:10px}
summary{cursor:pointer;padding:8px 0;font-size:12.5px;color:var(--mut)}
details ul{margin:0;padding-left:18px;font-size:12.5px}
details li{padding:3px 0;border-top:1px dashed var(--line)}
code{font-family:var(--mono);font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:0 4px}
blockquote{margin:10px 0;padding:10px 14px;border-left:3px solid var(--acc);background:var(--card);color:var(--mut);font-size:13px;border-radius:0 8px 8px 0}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:12px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:760px){.cols{grid-template-columns:1fr}}
.filter{margin:6px 0 14px;display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--mut)}
.filter input{font:inherit;font-size:12.5px;padding:6px 10px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg);min-width:220px}
.pane{display:none}.pane.on{display:block}
.tabs{display:flex;gap:6px;margin:22px 0 4px}
.tabs button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:6px 14px;font-size:13px}
.tabs button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
footer{border-top:1px solid var(--line);margin-top:40px;padding-top:14px;color:var(--mut);font-size:12px}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}
</style></head>
<body>
<header><div class="wrap" style="padding-bottom:0">
  <h1>代码规范对照器</h1>
  <p class="sub">现状层（审计）· 结论与待拍板清单在 <code>docs/code-audit.md</code> · 本页只负责让你<b>看得懂 + 点得开</b></p>
  <div class="meta">
    <span>日期 <b>${data.header.date}</b></span>
    <span>范围 <b>${data.header.packages} 个包 + scripts/</b></span>
    <span>解析 <b>${data.header.filesScanned} 文件 · typescript ${data.header.ts}</b>（${data.header.tsFrom}）</span>
    <span>排除 vendor <b>${data.header.vendorSkipped}</b> · 解析失败 <b>${data.header.parseFail}</b></span>
    <span>复算 <code>node scripts/code-inventory.mjs</code></span>
    <span>对照 <code>… --compare</code>（基线 ${data.header.date}）</code></span>
  </div>
</div></header>
<div class="wrap">
  <div class="filter">过滤度量：<input id="q" placeholder="输入度量号 / 关键字，如 Z1、端点、catch"></div>
  <div class="tabs">
    <button class="on" data-tab="home">结论与决策</button>
    <button data-tab="data">度量与热点（${data.metrics.length} 项）</button>
    <button data-tab="pkg">包与依赖表</button>
  </div>

  <div class="pane on" id="p-home">
    ${md2html(SECTIONS.intro)}
    <h2>待拍板清单（D1~D12 · 短答即可）</h2>
    ${md2html(SECTIONS.decisions)}
    <h2>显式盲区</h2>
    ${md2html(SECTIONS.blind)}
    <h2>规范章节骨架</h2>
    ${md2html(SECTIONS.outline)}
  </div>

  <div class="pane" id="p-data">
    <div class="cards">${cards}</div>
    <nav>${Object.keys(SECMETA).map((s) => `<a href="#s-${s}">${s} ${SECMETA[s].name}</a>`).join('')}</nav>
    ${tables}
  </div>

  <div class="pane" id="p-pkg">
    <h2>逐包体量与测试密度</h2>
    <table><thead><tr><th>包</th><th>源文件</th><th>源码行</th><th>测试文件</th><th>断言数</th><th>源文件/测试</th></tr></thead><tbody>${pkgRows}</tbody></table>
    <h2>跨包 import 边（依赖方向的原始材料）</h2>
    <table><thead><tr><th>from</th><th>to</th></tr></thead><tbody>${depRows}</tbody></table>
    <h2>被排除的 vendor / 产物级文件（${data.vendor.length} 个）</h2>
    <table><thead><tr><th>文件</th><th>行数</th></tr></thead><tbody>${vendorRows}</tbody></table>
  </div>

  <footer>本页由 <code>node scripts/code-inventory-page.mjs</code> 生成：数字取自 <code>code-inventory.mjs --json</code>，文案取自 <code>docs/code-audit.md</code>（不双写）。重跑同一命令即刷新。</footer>
</div>
<script>
const tabs=document.querySelectorAll('.tabs button'),panes=document.querySelectorAll('.pane');
tabs.forEach(b=>b.onclick=()=>{tabs.forEach(x=>x.classList.toggle('on',x===b));panes.forEach(p=>p.classList.toggle('on',p.id==='p-'+b.dataset.tab))});
const q=document.getElementById('q');
q.oninput=()=>{const v=q.value.trim().toLowerCase();
 document.querySelectorAll('#p-data table.data tbody tr').forEach(tr=>{const hit=!v||tr.textContent.toLowerCase().includes(v);tr.style.display=hit?'':'none'});
 document.querySelectorAll('#p-data details').forEach(d=>{const hit=!v||d.textContent.toLowerCase().includes(v);d.style.display=hit?'':'none'});
 document.querySelectorAll('.secblock').forEach(s=>{const any=[...s.querySelectorAll('table.data tbody tr')].some(t=>t.style.display!=='none');s.style.display=any?'':'none'})};
document.querySelectorAll('.jump').forEach(b=>b.onclick=(e)=>{e.preventDefault();const sec=b.dataset.sec;q.value='';q.oninput();
 document.querySelectorAll('.secblock').forEach(s=>s.style.display=s.id==='s-'+sec?'':'none');
 document.querySelectorAll('#p-data details').forEach(d=>d.style.display=d.id.startsWith('d-'+sec)?'':'none')});
document.querySelectorAll('.open').forEach(b=>b.onclick=()=>{tabs.forEach(x=>x.classList.toggle('on',x.dataset.tab==='data'));panes.forEach(p=>p.classList.toggle('on',p.id==='p-data'));
 const d=document.getElementById('d-'+b.dataset.id);if(d){d.open=true;d.scrollIntoView({behavior:'smooth',block:'center'})}});
</script>
</body></html>`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html)
console.log(`✓ 对照器已生成 ${path.relative(ROOT, OUT)}（${data.metrics.length} 项度量 · ${(html.length / 1024).toFixed(0)} KB）`)
