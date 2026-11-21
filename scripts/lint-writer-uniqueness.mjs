#!/usr/bin/env node
// scripts/lint-writer-uniqueness.mjs
// 唯一写者门禁（ISS-698 · E-0）—— 防「写权悄悄从 3210 回漂到 App」。
//
// ## 为什么要有这条
//   10-03（ISS-568）写权已收敛到 3210：App 的 /forge-pm/*、/forge-agents/* 与 25 条
//   /forge-plans/* 全量/只读转发到 :3210，本进程不开库（`dsh-desktop-agent.log:833-836`）。
//   但这条形态只活在配置里、没有门禁：哪天有人删掉 App 的 proxyBase，App 就会
//   **自己开一个空库**（ISS-549 实测：`/models/all` 恒 0 条、套餐页与选择器不符），
//   而且界面不报错 —— 典型的静默失败。本门禁把「唯一写者」变成机器会拦的断言。
//
// ## 判据（四条，只读 home 配置，不改任何运行态文件）
//   W1 ⛔ App `desktop/cordis.patch.yml` 的 `forge-pm` 与 `forge-model` 两个块，
//        各须有**非注释** `proxyBase` 且指向 `:3210` ⇒ 缺一即红（第二个写者的入口）。
//   W2 ⛔ dev `web/cordis.patch.yml` 的**非注释行**不得出现 `proxyBase` 或 `:19387`
//        ⇒ 回指 App 会成双向环（ISS-568 明确「断双向环」）。
//   W3 ⛔ 两个 profile 的 `dsh.profile.bundles` 必须非空（空壳 = 门禁看不见东西）。
//   W4 ⛔ 四个配置文件任一缺失 ⇒ 红，**判不了不许静默当绿**。
//
// ⚠️ 为什么必须区分注释：dev patch 18-20 行的**回滚说明**里就写着
//    `proxyBase 指 19387`（本轮首扫实测 3 行命中），那不是生效配置。
//    判据若按全文 grep 会当场误报 —— 本仓「注释不是代码」的又一处落点。
//
// ## 用法
//   node scripts/lint-writer-uniqueness.mjs --check
//   node scripts/lint-writer-uniqueness.mjs --json
//   node scripts/lint-writer-uniqueness.mjs --selftest
//   node scripts/lint-writer-uniqueness.mjs --check --app-home <副本> --dev-home <副本>
//
// 只读取 `~/.dsh` / `~/.dsh-matter` 下 4 个文件；**不写、不重启、不碰软链、不碰 19387**。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLint } from './lint-common.mjs'

const DEFAULT_APP = path.join(os.homedir(), '.dsh')
const DEFAULT_DEV = path.join(os.homedir(), '.dsh-matter')
const LAYOUT = {
  appPatch: 'profiles/desktop/cordis.patch.yml',
  appPkg: 'profiles/desktop/package.json',
  devPatch: 'profiles/web/cordis.patch.yml',
  devPkg: 'profiles/web/package.json',
}

function paths(app, dev) {
  return {
    appPatch: path.join(app, LAYOUT.appPatch),
    appPkg: path.join(app, LAYOUT.appPkg),
    devPatch: path.join(dev, LAYOUT.devPatch),
    devPkg: path.join(dev, LAYOUT.devPkg),
  }
}

/** 抹掉整行注释（保行数，不保偏移 —— 本判据只要「这行是不是注释」）。 */
function nonComment(text) {
  return String(text || '').split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n')
}

/** 按 `- id:` 顶层条目切块；只取第一个匹配的 id。 */
function blockOf(text, id) {
  for (const part of String(text || '').split(/(?=^- id: )/m)) {
    const m = part.match(/^- id:\s*(\S+)/)
    if (m && m[1] === id) return part
  }
  return ''
}

function buildLint(app = DEFAULT_APP, dev = DEFAULT_DEV) {
  const P = paths(app, dev)
  const root = path.dirname(app)
  const files = () => Object.values(P)
  const rel = (p) => path.relative(root, p).split(path.sep).join('/')
  // ISS-701 · 缺口 E：`read()` 原先吞掉异常返回 ''，于是「读不到」被静默当成「空文件」——
  // dev patch 若是目录 / chmod 000，W2 看到 '' 无话可说、判绿，而 W4 只判 existsSync 也判绿。
  // 那正好违背 W4 自己的 why（「判不了不许静默当绿」）。现在读失败落进 readErrors，由 W4 判红。
  const readErrors = new Map()
  const read = (p) => {
    try {
      const t = fs.readFileSync(p, 'utf8')
      readErrors.delete(p)
      return t
    } catch (e) {
      readErrors.set(p, String((e && e.code) || (e && e.message) || e))
      return ''
    }
  }

  const W1 = {
    id: 'W1-APP-PROXY', level: 'block',
    why: 'App 侧 forge-pm / forge-model 必须只读转发到 3210；缺 proxyBase 就会自己开库（第二个写者）',
    check: () => {
      const text = read(P.appPatch)
      const hits = []
      for (const id of ['forge-pm', 'forge-model']) {
        const vals = [...nonComment(blockOf(text, id)).matchAll(/proxyBase:\s*(\S+)/g)].map((m) => m[1])
        if (!vals.some((v) => /:3210(\D|$)/.test(v))) {
          hits.push({ file: rel(P.appPatch), line: null, detail: `W1 ${id} 缺少指向 :3210 的非注释 proxyBase（现有：${vals.join(',') || '无'}）` })
        }
      }
      return hits
    },
  }
  const W2 = {
    id: 'W2-DEV-NO-BACK', level: 'block',
    why: 'dev 侧不得回指 App，否则成双向环（ISS-568）',
    check: () => {
      const clean = nonComment(read(P.devPatch))
      const m = clean.match(/^.*(?:proxyBase:|:19387).*$/m)
      return m ? [{ file: rel(P.devPatch), line: null, detail: `W2 dev 侧出现回指配置（非注释行）：${m[0].trim().slice(0, 120)}` }] : []
    },
  }
  const W3 = {
    id: 'W3-BUNDLES', level: 'block',
    why: '两个 profile 的 bundles 必须非空，空壳会让门禁看不见东西',
    check: () => {
      const hits = []
      for (const [name, p] of [['App', P.appPkg], ['dev', P.devPkg]]) {
        let j
        try { j = JSON.parse(read(p)) } catch { hits.push({ file: rel(p), line: null, detail: `W3 ${name} package.json 解析失败` }); continue }
        const b = j?.dsh?.profile?.bundles
        if (!Array.isArray(b) || b.length === 0) hits.push({ file: rel(p), line: null, detail: `W3 ${name} dsh.profile.bundles 为空` })
      }
      return hits
    },
  }
  const W4 = {
    id: 'W4-EXISTS', level: 'block',
    why: '四个配置文件必须齐全且读得动；判不了不许静默当绿',
    check: () => {
      const hits = []
      for (const [k, p] of Object.entries(P)) {
        if (!fs.existsSync(p)) {
          hits.push({ file: rel(p), line: null, detail: `W4 配置文件缺失：${k}` })
          continue
        }
        // 「存在」不等于「读得到」：目录 / 权限 000 / 坏挂载都会让 readSync 抛（ISS-701 缺口 E）。
        // 这里主动读一遍，不依赖 W1~W3 是否已经跑过（规则顺序不该成为判据的前提）。
        read(p)
        if (readErrors.has(p)) {
          hits.push({ file: rel(p), line: null, detail: `W4 配置文件读不动：${k}（${readErrors.get(p)}）—— 判不了不许静默当绿` })
        }
      }
      return hits
    },
  }

  const lint = createLint({ name: 'lint-writer-uniqueness', root, files, rules: [W1, W2, W3, W4], whitelist: {} })
  return { lint, P }
}

/** 造一对最小 home 副本（4 文件），只由本文件 --selftest 使用。
 *  ⚠️ 故意不 export：多导一个符号就是给度量 Z2 添零引用导出（本仓两次教训）；
 *     端到端测试走真 CLI + 自己造副本，不 import 本模块。 */
function makeHomes(dir) {
  const app = path.join(dir, 'app')
  const dev = path.join(dir, 'dev')
  for (const p of [path.join(app, 'profiles/desktop'), path.join(dev, 'profiles/web')]) fs.mkdirSync(p, { recursive: true })
  const P = paths(app, dev)
  fs.writeFileSync(P.appPatch, '- id: forge-pm\n  name: forge-pm\n  config:\n    proxyBase: http://127.0.0.1:3210\n- id: forge-model\n  name: forge-model\n  config:\n    proxyBase: http://127.0.0.1:3210\n')
  fs.writeFileSync(P.devPatch, '# 回滚说明：proxyBase 指 19387（这是注释，不该判红）\n- id: forge-pm\n  name: forge-pm\n')
  fs.writeFileSync(P.appPkg, JSON.stringify({ name: 'app', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'forge-pm'] } } }))
  fs.writeFileSync(P.devPkg, JSON.stringify({ name: 'dev', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'forge-pm'] } } }))
  return { app, dev, P }
}

/* ───────────── --selftest：本门禁判据自己的正反例 ───────────── */
function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-uniqueness-selftest-'))
  const cases = []
  const push = (name, ok) => cases.push({ name, ok })
  const judge = (app, dev) => {
    const { lint } = buildLint(app, dev)
    const res = lint.run()
    return { exit: lint.format(res).exit, text: lint.format(res).text }
  }
  const fresh = () => {
    const d = fs.mkdtempSync(path.join(dir, 'case-'))
    return makeHomes(d)
  }

  const base = fresh()
  const ok = judge(base.app, base.dev)
  push('该绿能绿：正常形态（App 两条 proxyBase + dev 只有注释里回指）', ok.exit === 0)
  push('注释不误伤（dev 回滚说明里的 proxyBase 不算配置）', !ok.text.includes('W2'))

  const a = fresh()
  fs.writeFileSync(a.P.appPatch, fs.readFileSync(a.P.appPatch, 'utf8').replace(/proxyBase: http:\/\/127\.0\.0\.1:3210\n/, ''))
  push('删 App 一条 proxyBase ⇒ 红且点名 W1', judge(a.app, a.dev).text.includes('W1'))

  const b = fresh()
  fs.writeFileSync(b.P.devPatch, fs.readFileSync(b.P.devPatch, 'utf8') + '- id: bad\n  config:\n    proxyBase: http://127.0.0.1:19387\n')
  push('dev 加非注释回指 ⇒ 红且点名 W2', judge(b.app, b.dev).text.includes('W2'))

  const c = fresh()
  fs.writeFileSync(c.P.appPatch, fs.readFileSync(c.P.appPatch, 'utf8').replace(/:3210/g, ':19387'))
  push('App proxyBase 指错方向 ⇒ 红', judge(c.app, c.dev).exit !== 0)

  const d = fresh()
  fs.writeFileSync(d.P.appPkg, JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  push('bundles 空壳 ⇒ 红且点名 W3', judge(d.app, d.dev).text.includes('W3'))

  const e = fresh()
  fs.rmSync(e.P.appPatch)
  push('App patch 缺失 ⇒ 红且点名 W4（判不了不当绿）', judge(e.app, e.dev).text.includes('W4'))

  const f = fresh()
  fs.writeFileSync(f.P.devPatch, fs.readFileSync(f.P.devPatch, 'utf8').replace(/- id: forge-pm/, '# - id: forge-pm'))
  push('反向对照：注释掉条目不影响 W1/W2 判定', judge(f.app, f.dev).exit === 0)

  // ISS-701 · 缺口 E：文件在、但读不动（chmod 000）—— 不能因为 W2 读到 '' 就判绿
  if (process.getuid && process.getuid() !== 0) {
    const g = fresh()
    fs.chmodSync(g.P.devPatch, 0o000)
    const rg = judge(g.app, g.dev)
    push('dev patch 读不动（chmod 000）⇒ 红且点名 W4（判不了不当绿）', rg.exit !== 0 && rg.text.includes('W4') && rg.text.includes('读不动'))
    fs.chmodSync(g.P.devPatch, 0o644)
  }

  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  const bad = cases.filter((c) => !c.ok)
  console.log('lint-writer-uniqueness --selftest（唯一写者判据的正反例）')
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}`)
  const code = bad.length ? 1 : 0
  console.log(code ? `\n✗ ${bad.length}/${cases.length} 项失败` : `\n✓ ${cases.length}/${cases.length} 项通过：该红能红、注释不误伤、判不了不当绿`)
  console.log(`verdict=${code ? 'red' : 'green'}`)
  return code
}

/* ─────────────────────────────── CLI ─────────────────────────────── */
const argv = process.argv.slice(2)
if (argv.includes('--selftest')) process.exit(selftest())
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : fallback
}
const { lint } = buildLint(arg('--app-home', DEFAULT_APP), arg('--dev-home', DEFAULT_DEV))
const res = lint.run()
if (argv.includes('--json')) {
  console.log(JSON.stringify(res, null, 1))
  process.exit(res.findings.length || res.errored.length ? 1 : 0)
}
const { text, exit } = lint.format(res, { verbose: argv.includes('--verbose') })
console.log(text)
console.log(`verdict=${exit ? 'red' : 'green'}`)
process.exit(exit)
