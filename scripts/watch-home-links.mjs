#!/usr/bin/env node
// scripts/watch-home-links.mjs
// Home 软链只读观测器（ISS-699 · D-1）—— 回答「home 下的软链到底有没有人打开」。
//
// ## 为什么不改业务代码埋点
//   在 `forge-service-kit/lib/fs.js` 埋点确实更准，但那是 host 半（`lib/**`）：
//   按 `AGENTS.md` §4.6 改 host 必须 `build:host` + 重启 3210 才生效，代价是
//   老板界面中断 5-12s + App 控制台 502。本工具走**外部只读采样**，零运行态改动。
//
// ## 判据的诚实边界（本工具存在的理由）
//   `lsof` 是**快照**，而业务读是按需 `readFileSync`（打开→读→关闭，毫秒级）。
//   ⇒ 采样命中 0 **不等于**零读；反过来「lsof 没看到」也从来不能当否定证据。
//   本工具做三件事把这件事说清楚：
//     ① **阳性对照**：观测期间保持一个 fd 打开，验证 lsof 调用与输出解析确实有效；
//        fd 全程打开 ⇒ **每次采样都必然可见**，所以判据是「命中数 === 采样数」而不是「>0」
//        （`>0` 会把「17 次采样只见 1 次」这种部分失明说成探针有效 —— ISS-699 复审 F3）。
//        阳性对照失败 ⇒ `verdict=unobservable`、退出码非 0、结论作废（判不了不当绿）。
//     ② **瞬时读检出率**：另起子进程反复 readFileSync，量出这套采样对真实读形态的
//        漏报程度，如实打印。检出率低 ⇒ 明确声明「采样不构成零读证据」。
//     ③ 每条软链的命中次数 + 命中它的 PID/COMMAND。
//   D-2 的信心来自**静态判定**（代码引用穷举 + registry.db 已存在 + bridge.js「各有一份库」），
//   采样只是交叉验证，不是唯一依据。
//
// ## 用法
//   node scripts/watch-home-links.mjs --check                 只做自检、不采样（体检快档）
//   node scripts/watch-home-links.mjs --selftest               自检 + 一次可选的真机观测（结果不参与判定）
//   node scripts/watch-home-links.mjs --json --duration 10     采样观测真机 home
//   node scripts/watch-home-links.mjs --json --duration 3 --home /tmp/home-xxx
//
// ## skip 与红的界线（ISS-699 复审 F1/F2）
//   **环境不具备 ⇒ 跳过（exit 0）**，且输出里写明为什么判不了，不许报红：
//     · 本机 home（`$HOME/.dsh`）不存在、或里面一条软链都没有
//     · 本机没有 lsof 可执行文件（spawn ENOENT）
//     理由：恒红的守卫与没有守卫等价（`scripts/guard-baselines.sh:85` 的原话，ISS-587 教训）。
//   **探针真坏 ⇒ 判红（exit 1）**：解析错、阳性对照没做到「每次采样都命中」、
//     或自造临时 home 上的观测不成立（lsof 在，管道却在某处断了）。
//   自检的通过判定只用**自造临时 home**（F2），真机 home 的那次采样只作参考打印。
//
// 只读：不写 ~/.dsh / ~/.dsh-matter 任何文件；不重启；不碰软链。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const HOME = path.join(os.homedir(), '.dsh')
const DEFAULT_DURATION = 30
const DEFAULT_INTERVAL = 200

/** ⚠️ macOS 上 lsof 的 NAME 列是**带 /private 前缀的真实路径**（/tmp→/private/tmp、
 *  /var/folders→/private/var/folders），而 fs.realpathSync 给的是不带前缀的形式。
 *  按原路径匹配会 100% 漏报（本轮实测：保持 fd 打开却「命中 0」就是这么来的）。
 *  ⇒ 期望路径与 lsof 输出**两边都跑同一个归一函数**，统一剥掉 /private 前缀。 */
function canonical(p) {
  let r = path.resolve(p)
  try { r = fs.realpathSync(r) } catch { /* 目标不存在：用绝对路径本身 */ }
  return r.startsWith('/private/') ? r.slice('/private'.length) : r
}

/** home 下所有软链及其真实目标（readlink），目标不存在也照样记录（断链要能看出来）。 */
function linkTargets(home = HOME) {
  const out = []
  if (!fs.existsSync(home)) return out
  for (const n of fs.readdirSync(home).sort()) {
    const p = path.join(home, n)
    if (!fs.lstatSync(p).isSymbolicLink()) continue
    const target = fs.readlinkSync(p)
    const abs = path.isAbsolute(target) ? target : path.resolve(path.dirname(p), target)
    out.push({ name: n, link: p, target: abs, resolved: canonical(abs), targetExists: fs.existsSync(abs) })
  }
  return out
}

/** 解析 `lsof -nP <files...>` 的文本输出 → Map<绝对路径, [{pid, command}]>。 */
function parseLsof(text) {
  const hits = new Map()
  for (const line of String(text || '').split('\n')) {
    if (!line.trim() || line.startsWith('COMMAND')) continue
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9) continue
    const name = canonical(cols.slice(8).join(' '))
    const entry = { pid: cols[1], command: cols[0] }
    if (!hits.has(name)) hits.set(name, [])
    hits.get(name).push(entry)
  }
  return hits
}

/** 本机有没有 lsof 可执行文件。「环境不具备」与「探针坏掉」的分界线就在这里：
 *  ENOENT = 这台机器没装 lsof ⇒ 判不了（skip）；lsof 在但管道/解析/阳性对照失效 ⇒ 红。 */
function lsofPresent() {
  const r = spawnSync('lsof', ['-h'], { stdio: 'ignore' })
  return !(r.error && r.error.code === 'ENOENT')
}

/** 一次采样：返回每个目标当前的打开者。lsof 无匹配时退出码 1，属正常。 */
function sample(targets) {
  let text = ''
  try {
    text = execFileSync('lsof', ['-nP', ...targets], { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    text = String(e.stdout || '')
    // 退出码 1 = 没有匹配（正常）；其它（含 lsof 不存在）= 判不了
    if (e.status !== 1 && e.status != null) throw new Error('lsof 不可用：' + String(e.message).slice(0, 120))
  }
  return parseLsof(text)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 阳性对照判据 —— 纯函数，导出给 `scripts/watch-home-links.test.mjs` 做**变异验证**
 * （「采样 17 次只命中 1 次」必须判不 observable，这条判据自己得有牙）。
 *
 * 设计前提：阳性对照的 fd 在整个观测窗口保持打开 ⇒ 每次采样都必然看得见它。
 * 所以通过条件是 `positiveHits === samples`，不是 `> 0`：后者允许「部分失明」冒充「探针有效」
 * （ISS-699 复审 F3 实测：samples=17、阳性对照只命中 1 次仍报 passed/exit 0）。
 * `samples === 0` 时无采样可判，按判不了处理（不许拿空窗口当绿）。
 */
export function judgeProbe({ samples, positiveHits }) {
  const passed = samples > 0 && positiveHits === samples
  return { samples, positiveHits, passed, verdict: passed ? 'observable' : 'unobservable' }
}

/**
 * 跑一次观测窗口。**总是返回 Promise**（提前返回也一样）—— `--selftest` 在无软链的机器上
 * 曾经拿到普通对象、`.then` 抛 TypeError ⇒ 统一体检在非本机 home 上恒红（复审 F1）。
 * @returns {Promise<{ok:boolean, verdict:string, report:object}>}
 */
async function observe({ duration = DEFAULT_DURATION, interval = DEFAULT_INTERVAL, home = HOME } = {}) {
  const links = linkTargets(home)
  if (!links.length) {
    return { ok: false, verdict: 'unobservable', report: { reason: 'home 下没有软链', reasonCode: 'no-links', home, links: [] } }
  }

  // 阳性对照 A：观测全程保持一个 fd 打开 ⇒ lsof 每次采样都必须看到（验证管道与解析）。
  const positive = canonical(path.join(os.tmpdir(), `watch-links-positive-${process.pid}.txt`))
  fs.writeFileSync(positive, 'positive-control\n')
  const fd = fs.openSync(positive, 'r')
  // 阳性对照 B：主进程定时做瞬时 readFileSync，量这套采样对真实读形态的漏报率。
  const transient = canonical(path.join(os.tmpdir(), `watch-links-transient-${process.pid}.txt`))
  fs.writeFileSync(transient, 'transient-read\n')
  let transientReads = 0
  const transientTimer = setInterval(() => { try { fs.readFileSync(transient); transientReads += 1 } catch { /* 文件已清 */ } }, 60)

  const targets = [...new Set([...links.map((l) => l.resolved), positive, transient])]
  const counts = Object.fromEntries(links.map((l) => [l.name, 0]))
  const seen = Object.fromEntries(links.map((l) => [l.name, new Set()]))
  let positiveHits = 0
  let transientHits = 0
  let samples = 0
  const started = Date.now()

  return new Promise((resolve) => {
    const tick = async () => {
      const elapsed = Date.now() - started
      let hits
      try { hits = sample(targets) } catch (e) {
        try { fs.closeSync(fd) } catch { /* 已关 */ }
        clearInterval(transientTimer)
        try { fs.rmSync(positive, { force: true }); fs.rmSync(transient, { force: true }) } catch { /* 无害 */ }
        resolve({ ok: false, verdict: 'unobservable', report: { reason: String(e.message), reasonCode: 'probe-error', home, links } })
        return
      }
      samples += 1
      if (hits.has(positive)) positiveHits += 1
      if (hits.has(transient)) transientHits += 1
      for (const l of links) {
        const got = hits.get(l.resolved) || []
        if (got.length) {
          counts[l.name] += got.length
          for (const g of got) seen[l.name].add(`${g.pid}:${g.command}`)
        }
      }
      if (elapsed >= duration * 1000) {
        try { fs.closeSync(fd) } catch { /* 已关 */ }
        clearInterval(transientTimer)
        const detectionRate = transientReads > 0 ? transientHits / Math.max(1, transientReads) : 0
        const probe = judgeProbe({ samples, positiveHits })
        const report = {
          at: new Date().toISOString(), home, duration, interval, samples,
          lsofOk: probe.passed,
          positiveControl: {
            hits: positiveHits, samples, passed: probe.passed,
            expected: 'hits === samples（对照 fd 全程打开 ⇒ 每次采样都必然可见；>0 会放过部分失明）',
          },
          transientControl: { reads: transientReads, sampledHits: transientHits, detectionRate, note: '对瞬时 readFileSync 的检出率；低 ⇒ 采样不构成零读证据' },
          links: links.map((l) => ({ name: l.name, target: l.target, resolved: l.resolved, targetExists: l.targetExists, hits: counts[l.name], openedBy: [...seen[l.name]] })),
        }
        try { fs.rmSync(positive, { force: true }); fs.rmSync(transient, { force: true }) } catch { /* 无害 */ }
        resolve({ ok: probe.passed, verdict: probe.verdict, report })
      } else {
        await sleep(Math.max(10, interval))
        tick()
      }
    }
    tick()
  })
}

/**
 * 自检。通过判定**只用自造临时 home**（F2）—— 真机 home 布局是这台机器的事实，
 * 不能拿它当「探针有效」的前提；真机那次采样只作参考打印，不参与判定。
 * 环境不具备（无软链 / 无 lsof）⇒ 对应判据**跳过**并在输出里写明，不报红。
 * 只由本文件 CLI 调用，不 export。
 */
async function selftest({ realObservation = true } = {}) {
  const cases = []
  const notes = []
  const push = (n, ok) => cases.push({ n, ok })

  // ① 解析层（纯 fixture，与真机无关）
  const fake = 'COMMAND   PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode    1234 dylan 3r REG 1,5 1024 99 <home>/.dsh-matter/forge-model.db\nnode    5678 dylan 4r REG 1,5 10 100 /tmp/x.txt\n'
  const parsed = parseLsof(fake)
  push('解析能归因到具体文件', parsed.has('<home>/.dsh-matter/forge-model.db') && parsed.get('<home>/.dsh-matter/forge-model.db')[0].pid === '1234')
  push('解析跳过表头与非数据行', [...parsed.keys()].length === 2)
  push('空输出不误报', parseLsof('').size === 0 && parseLsof('COMMAND PID\n').size === 0)

  // ② 两个路径归一坑（本轮真踩过的）：/tmp→/private/tmp、/var/folders→/private/var/folders。
  //    钉住的是「期望路径与 lsof 输出跑同一把钥匙」，不是某个具体前缀。
  const canonProbe = path.join(os.tmpdir(), `watch-links-canonical-${process.pid}.txt`)
  fs.writeFileSync(canonProbe, 'canonical\n')
  const one = canonical(canonProbe)
  push('路径归一：os.tmpdir() 形式的路径不产出 /private 前缀', !one.startsWith('/private/') && one === path.resolve(canonProbe))
  push('/tmp 与 /private/tmp 两种写法归一到同一把钥匙（lsof 侧与 fs 侧同口径）', canonical('/private' + one) === one)
  fs.rmSync(canonProbe, { force: true })

  // ③ 自造临时 home 上的真采样：证明探针管道有效，且不依赖真机 home 结构
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-links-selftest-home-'))
  const tmpEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-links-selftest-empty-'))
  try {
    const data = path.join(tmpHome, 'data.json')
    fs.writeFileSync(data, '{}\n')
    fs.symlinkSync(data, path.join(tmpHome, 'link.json'))

    // ④ 提前返回也必须是 thenable（F1 的原始形态：无软链时 observe 返回普通对象 ⇒ `r.then is not a function`）
    const pending = observe({ home: tmpEmpty, duration: 0.2 })
    const empty = await pending
    push('home 无软链 ⇒ 返回 Promise（不崩）且判不了，不假绿', typeof pending?.then === 'function' && empty.verdict === 'unobservable' && empty.report.reasonCode === 'no-links')

    if (!lsofPresent()) {
      notes.push('跳过：本机没有 lsof 可执行文件（ENOENT），探针类判据判不了 —— 不判 ≠ 判红')
    } else {
      const r = await observe({ home: tmpHome, duration: 0.6, interval: 50 })
      push('自造临时 home 上探针有效：阳性对照每次采样都命中', r.ok && r.verdict === 'observable' && r.report.positiveControl.passed && r.report.positiveControl.hits === r.report.samples)
      push('自造临时 home：软链逐条列出且带命中计数', r.report.links.length === 1 && r.report.links[0].name === 'link.json' && typeof r.report.links[0].hits === 'number' && r.report.links[0].targetExists === true)
      push('瞬时读检出率如实给出（0~1）', typeof r.report.transientControl?.detectionRate === 'number')
    }
  } finally {
    for (const d of [tmpHome, tmpEmpty]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ } }
  }

  // ⑤ F3 判据自身：部分失明不算探针有效
  const half = judgeProbe({ samples: 17, positiveHits: 1 })
  push('部分失明不算探针有效：17 次采样只命中 1 次 ⇒ unobservable', half.verdict === 'unobservable' && half.passed === false)
  push('全采样命中才算探针有效：17/17 ⇒ observable；空窗口 0/0 ⇒ 判不了', judgeProbe({ samples: 17, positiveHits: 17 }).verdict === 'observable' && judgeProbe({ samples: 0, positiveHits: 0 }).passed === false)

  // ⑥ 可选的一次真实观测：只打印，不参与通过判定（F2）
  if (!realObservation) {
    notes.push('跳过：--check 只做自检，不采样真机 home')
  } else if (!fs.existsSync(HOME) || linkTargets().length === 0) {
    notes.push(`跳过：本机 home 无软链（${HOME}），判不了 —— 不判 ≠ 判红`)
  } else {
    const real = await observe({ duration: 1.2, interval: 100 })
    notes.push(`真机观测（仅供参考，不参与本次通过判定）：home=${real.report.home} · 采样 ${real.report.samples} 次 · 阳性对照 ${real.report.positiveControl?.hits ?? 0}/${real.report.samples ?? 0} · 软链 ${real.report.links?.length ?? 0} 条 · verdict=${real.verdict}`)
  }

  const bad = cases.filter((c) => !c.ok)
  console.log(`watch-home-links --selftest${realObservation ? '' : '（--check：不采样）'}`)
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.n}`)
  for (const n of notes) console.log(`  — ${n}`)
  console.log(bad.length ? `\n✗ ${bad.length}/${cases.length} 项失败` : `\n✓ ${cases.length}/${cases.length} 项通过`)
  console.log(`verdict=${bad.length ? 'red' : 'green'}`)
  return bad.length ? 1 : 0
}

const isCli = process.argv[1] && process.argv[1].endsWith('watch-home-links.mjs')
if (isCli) {
  const argv = process.argv.slice(2)
  const wantSelftest = argv.includes('--selftest')
  if (wantSelftest || argv.includes('--check')) {
    process.exit(await selftest({ realObservation: wantSelftest }))
  } else {
    const num = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt }
    const hi = argv.indexOf('--home')
    const home = hi >= 0 && argv[hi + 1] ? path.resolve(argv[hi + 1]) : undefined
    const r = await observe({ duration: num('--duration', DEFAULT_DURATION), interval: num('--interval', DEFAULT_INTERVAL), home })
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ verdict: r.verdict, ...r.report }, null, 1))
    } else {
      console.log(`watch-home-links · 观测 ${r.report.duration}s / ${r.report.samples} 次采样 · home ${r.report.home}`)
      console.log(`  阳性对照（保持 fd）：命中 ${r.report.positiveControl?.hits ?? 0}/${r.report.samples ?? 0} 次 ⇒ ${r.report.lsofOk ? '探针有效' : '探针无效，结论作废'}`)
      const tc = r.report.transientControl || {}
      console.log(`  瞬时读检出率：${((tc.detectionRate || 0) * 100).toFixed(1)}%（读了 ${tc.reads ?? 0} 次、采到 ${tc.sampledHits ?? 0} 次）⇒ 低则该采样不构成零读证据`)
      for (const l of r.report.links || []) {
        console.log(`  ${l.name.padEnd(30)} 命中 ${String(l.hits).padStart(4)}  ${l.openedBy.length ? '← ' + l.openedBy.slice(0, 3).join(', ') : ''}`)
      }
      console.log(`verdict=${r.verdict}`)
    }
    process.exit(r.ok ? 0 : 2)
  }
}
