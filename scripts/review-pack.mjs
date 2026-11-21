#!/usr/bin/env node
// 代审包生成器（PRJ-016 · ISS-696）：把"停在待审核、等老板逐张看"的一批单，压成一张可直接打开的 HTML 表。
// 为什么要有它：老板的批复是本项目当前唯一的堵点，而"23 张 / 29 张"这种数一旦手抄就必然滞后
// （09-23 实测：15:55 那版看板 23 张，补挂里程碑后真值 29 张 —— 差别不是活儿变了，是**归属**变了）。
// 口径全部现算：状态来自 ~/.dsh/pm/issues 的 frontmatter（排除 -activity / -comments 侧车），
// 提交数来自 `git log --grep`（只数已进 main 的），备注条数来自活动侧车里 event: agent-note 的计数。
// 用法：node scripts/review-pack.mjs [--out docs/mockups/review-pack-<日期>.html] [--project <rel>]
// ⚠️ 三件刻意的取舍：① 读不到的格子印 `?` 而不是 0（0 与"读不到"必须可区分，否则"没交代"会被读成"没内容"）；
//    ② 不放"建议"列（从各单备注里摘原话会摘出半截片段，删列比留错强）；
//    ③ 每条判据都配一条阳性对照断言，判据坏了要当场红，不许静默少印几行。
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { runGitSync } from './git-lib.mjs'

const PM = homedir() + '/.dsh/pm'
const REPO = process.argv.includes('--repo') ? process.argv[1 + process.argv.indexOf('--repo')] : process.cwd()
const PROJECT = (() => {
  const i = process.argv.indexOf('--project')
  return i > 0 ? process.argv[i + 1] : 'projects/2026-09-22-PRJ-016-s0-s5.md'
})()
const OUT = (() => {
  const i = process.argv.indexOf('--out')
  if (i > 0) return process.argv[i + 1]
  const d = new Date().toISOString().slice(0, 10)
  return `docs/mockups/review-pack-${d}.html`
})()

const fmOf = (path) => readFileSync(path, 'utf8').split('\n---')[0]
const field = (fm, k) => {
  const m = fm.match(new RegExp('^' + k + ': (.*)$', 'm'))
  return m ? m[1].trim().replace(/^"|"$/g, '') : ''
}
const list = (fm, k) => {
  const one = field(fm, k)
  if (one && one !== '[]') return one.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
  // 多行 YAML 列表（subtasks / milestones 那种）
  const block = fm.match(new RegExp('^' + k + ':\n((?:[ \\t]*- .*\n?)+)', 'm'))
  return block ? [...block[1].matchAll(/-\s+"?([^\s"]+)"?\s*$/gm)].map((m) => m[1]) : []
}
const files = existsSync(PM + '/issues')
  ? readdirSync(PM + '/issues').filter((f) => f.endsWith('.md') && !/-activity\.md$|-comments\.md$/.test(f))
  : []

// git 走 `scripts/git-lib.mjs` 那一份实现（argv 数组、不经 shell）；本仓只允许存在一处这种包装。
// 名字故意不叫 `git()`：`git-health-check.mjs` 已有一个同名但**契约不同**的包装（它失败抛错 / 我这条把失败映射成 null）。
// 同名不同物才是病根（ISS-739 那一格的结论），所以这里按契约起名 `tryGit`，不与它共用标识符。
const tryGit = (args) => {
  try {
    return runGitSync(REPO, args)
  } catch (e) {
    return null
  }
}
const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const rows = []
for (const f of files) {
  const fm = fmOf(PM + '/issues/' + f)
  if (field(fm, 'project') !== PROJECT) continue
  const id = field(fm, 'id') || f.match(/ISS-\d+|REV-\d+|DOC-\d+/)?.[0] || '?'
  const st = field(fm, 'status')
  if (st !== 'in_review') continue
  // 备注条数：数活动侧车里"event: agent-note"的**块**（每块一行 header）；侧车不存在 ⇒ ?
  const side = PM + '/issues/' + f.replace(/\.md$/, '-activity.md')
  let notes = '?'
  if (existsSync(side)) notes = [...readFileSync(side, 'utf8').matchAll(/^event: agent-note$/gm)].length
  // 主干提交数：只数已进 main 的；仓库/分支读不到 ⇒ ?（不把"读不到"印成 0）
  const out = tryGit(['log', '--fixed-strings', '--grep=' + id, '--oneline', 'main'])
  const commits = out === null ? '?' : out.trim() ? out.trim().split('\n').length : 0
  const last = commits === '?' || commits === 0
    ? '—'
    : tryGit(['log', '--fixed-strings', '--grep=' + id, '-1', '--format=%cd', '--date=format:%m-%d %H:%M', 'main']).trim()
  rows.push({
    id, ms: field(fm, 'milestone') || '（未挂）', est: field(fm, 'estimate') || '—',
    title: (field(fm, 'title') || '').slice(0, 96), commits, notes, last,
    file: 'issues/' + f,
  })
}
rows.sort((a, b) => a.ms.localeCompare(b.ms) || a.id.localeCompare(b.id))

// —— 阳性对照（判据自己先证能读出正例，否则这张表等于没跑）——
const ctl = []
const withCommits = rows.filter((r) => typeof r.commits === 'number' && r.commits > 0).length
const withNotes = rows.filter((r) => typeof r.notes === 'number' && r.notes > 0).length
// ⚠️ 这两条只在**有单**时成立：0 张待审 = 世界变干净了，不是判据坏了。
//    上一版写死 `> 0`，于是代审清空那天这张表反而拒绝生成 —— 一条"世界一好就报错"的判据方向是反的（同 ISS-791 那次恒红风险）。
if (rows.length === 0) {
  ctl.push(['无待审单 ⇒ 两条阳性对照不适用（不是判据坏了）', true, '0 张'])
} else {
  ctl.push(['至少一张单有主干提交', withCommits > 0, `${withCommits}/${rows.length}`])
  ctl.push(['至少一张单有 agent 备注', withNotes > 0, `${withNotes}/${rows.length}`])
}
const diskCount = (() => {
  let n = 0
  for (const f of files) {
    const fm = fmOf(PM + '/issues/' + f)
    if (field(fm, 'project') === PROJECT && field(fm, 'status') === 'in_review') n++
  }
  return n
})()
ctl.push(['表里的行数 = 磁盘现算的待审数', diskCount === rows.length, `${rows.length} vs ${diskCount}`])
const failed = ctl.filter((c) => !c[1])
if (failed.length) {
  console.error('✗ 阳性对照失败（判据坏了，不出包）：\n  ' + failed.map((f) => `${f[0]}（${f[2]}）`).join('\n  '))
  process.exit(1)
}

const byMs = {}
for (const r of rows) byMs[r.ms] = (byMs[r.ms] || 0) + 1
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>代审包 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</title>
<style>
body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;margin:32px auto;max-width:1100px;color:#1c1e21}
h1{font-size:22px;margin:0 0 4px}p.cal{color:#57606a;margin:0 0 18px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e3e6e8;padding:7px 9px;text-align:left;vertical-align:top}
th{background:#f6f8fa;font-weight:600;position:sticky;top:0}td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
code{background:#f6f8fa;padding:1px 4px;border-radius:3px}
.gone{color:#8c959f}.ok{color:#1a7f37}.warn{color:#9a6700}
h2{font-size:15px;margin:26px 0 6px}ul{margin:6px 0 0 18px;padding:0}
</style></head><body>
<h1>PRJ-016 代审包 · 停在待审核的 ${rows.length} 张</h1>
<p class="cal">口径：状态与归属现算自 <code>~/.dsh/pm/issues</code> 的 frontmatter（已排除 <code>-activity</code>/<code>-comments</code> 侧车）；
提交数只数<b>已进 main</b> 的（<code>git log --grep</code>：提交信息里出现该单号即计入 ⇒ 批次说明里点名带过的也算，它是"有没有产出"的证据，不是"改了多少行"）。读不到的格子印 <code>?</code> —— 与"真的是 0"分开。
本项目的批复粒度是<b>父单代审</b>：一次批复即授权本批，不必逐张打开。</p>
<table><thead><tr><th>单号</th><th>里程碑</th><th>分诊</th><th>标题</th><th class="n">主干提交</th><th class="n">agent 备注</th><th>最近提交</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><code>${htmlEsc(r.id)}</code></td><td>${htmlEsc(r.ms)}</td><td>${htmlEsc(r.est)}</td><td>${htmlEsc(r.title)}</td><td class="n">${r.commits}</td><td class="n">${r.notes}</td><td class="${r.commits === '?' ? 'warn' : 'gone'}">${htmlEsc(r.last)}</td></tr>`).join('\n')}
</tbody></table>
<h2>按里程碑</h2>
<table><thead><tr><th>里程碑</th><th class="n">待审张数</th></tr></thead><tbody>
${Object.entries(byMs).map(([k, v]) => `<tr><td>${htmlEsc(k)}</td><td class="n">${v}</td></tr>`).join('\n')}
</tbody></table>
<h2>判据自检（出包前跑过）</h2>
<ul>${ctl.map((c) => `<li class="ok">✓ ${htmlEsc(c[0])} — ${htmlEsc(c[2])}</li>`).join('\n')}</ul>
<p class="cal">重跑：<code>node scripts/review-pack.mjs</code>（默认写 <code>docs/mockups/review-pack-&lt;今天&gt;.html</code>）</p>
</body></html>`
writeFileSync(REPO + '/' + OUT, html)
console.log(`✓ 代审包：${rows.length} 张 · 按里程碑 ${Object.entries(byMs).map(([k, v]) => k + ' ' + v).join(' · ')}`)
console.log('  自检 ' + ctl.map((c) => (c[1] ? '✓' : '✗') + ' ' + c[0]).join(' · '))
console.log('  写出 ' + OUT)
