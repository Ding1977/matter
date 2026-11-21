#!/usr/bin/env node
// 活推送与对账的契约门禁（ISS-724 · S5-3 · docs/code.md §10 / K11）
//
// 为什么要有这条：DSH 的事件面**跨进程不通**（DOC-258 §4.1a），宿主重启后内存 seq 归零，
// 而浏览器 SSE 断线是常态（合盖、切后台、代理缓冲）。⇒ 推送只能当**加速器**；一旦某条流的
// 正确性绑在推送上，一断就错，而且错得看不见（与 §8 K9h「失败必响」同族）。
//
// 三条判据（号与 docs/code.md §10 同一套）：
//   **CC1** ⛔ 广播通道的帧必须带**游标**：写 `text/event-stream` 的那个文件里要有 `id:` 行 /
//         `seq` 字段，并且读得到续传参数（`Last-Event-ID` 头或 `?since=`）。
//         没游标 = 丢帧不可观测 = 无法续传 = 客户端只能整表重拉或永远缺一帧。
//   **CC2** ⛔ 订阅端必须有**非推送重拉**：出现 `new EventSource(` 订阅的那个包里，必须同时
//         存在对同前缀的普通 HTTP 读取（fetch）。这条判的是"断线之后还能不能把真相拉回来"——
//         ⚠️ 刻意判**客户端**而不是服务端：服务端"同包有个别的端点"根本证明不了是同一份数据的
//            对账口（第一版那样判，实测把 notify 的列表端点摘掉门禁仍然全绿 ⇒ 恒绿判据，已推翻）。
//   **CC3** ⚑ 提醒档：广播通道所在包在同前缀下**一个非事件端点都没有** ⇒ 报出来交人判
//         （可能是纯增量流，也可能真的没有对账口；静态判不准，所以不判红）。
//
// ⚠️ 广播型 vs 透传型是本门禁的分界：网关/代理（forge-model 的 v1 chat completions 流式、副引擎
//    转发）只搬上游字节，**不搬真相**，不适用 K11 ⇒ 判"广播"要有客户端集合或内核 hub 的证据。
//    别拿 `subscribe(fn)` 当证据 —— 那是 UI store 的订阅，第一版收了它就把 forge-model 误判成广播。
//
// 判定单位是**包**，不是文件：真实形态是"广播器住 events.js、writeHead 住 index.js"（pm 与 agents
// 都是），按文件判第一版只认出 1 / 4 条通道。
//
// 口径说明：本脚本自己扫源码（只取字面量与特征串），不复用 `code-inventory.mjs` 的 AST 路线 ——
// 盘点基线只存前 N 个 offender，回答不了"每条通道的对账口在不在"。两处的**一级前缀口径一致**
// （取路由首段）；一处一个地址：判据原文在规范，怎么判在这里。
//
// 扫描面（ISS-860）：**只扫源码，不扫 gitignored / untracked-scratch 路径**（判据 = `git check-ignore`，
// 见下方「扫描面」段）。`.tmp/` 是试跑产物目录（`.gitignore:12`），里面第三方试跑项目也写 event-stream，
// 旧版全树扫把它当成本仓通道 ⇒ 假红顶红守卫。`--include-ignored` 是逃生口（确要全树扫时用）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WORKTREE_PATH_RE } from './wt-exclude-lib.mjs' // ISS-724：工作树落点的唯一真相源

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = path.join(ROOT, 'scripts', 'baseline', 'channel-contract.json')
/* ISS-572（R29 家族第三处）：排除判据只许吃**仓根相对路径**。
   旧写法是绝对路径形状（`/(\/\.wt\/|…)`），而 walk 的目录分支拿**绝对路径** `p` 去喂它
   ⇒ 在本机沙箱下唯一可用的工作树落点（仓内 `<主仓>/.wt/<ISS>`，`.gitignore:75`）里 ROOT 自身含
   `/.wt/`，每个子目录都被判"该跳过"，walk 在第一层停住：实测**候选 1110 → 13、广播型通道 1 → 0**，
   而 `--check` 照旧打印 `✓ CC1/CC2 在限内` 并 exit 0 —— **静默假绿**（同族 ISS-561 的 code-inventory /
   lint-design 已先修）。形状必须是 `(^|\/)` ＋ 目录段名 ＋ `\/`：绝对路径上 `^` 命不中、`\.wt` 段前
   也没有 `/` 段边界 ⇒ 绝对路径**永远命不中**，判据只剩"喂相对路径"这一种正确用法。
   ⚠️ 别退回绝对路径形状：那会让仓内工作树重新静默归零（回归钉在 selftest 的 `iss-1154 ⑥`）。 */
const SKIP_DIR = new RegExp(
  `(^|/)(node_modules|dist|\\.git|out|static|vendor)/|${WORKTREE_PATH_RE.source}`
)
const INCLUDE_IGNORED = process.argv.includes('--include-ignored')
const SRC_RE = /\.(js|ts|tsx|mjs)$/
const HUB_RE = /(\b[\w-]*[Cc]lients?\.add\(|\b[\w-]*[Cc]lients?\.delete\(|sseClients|subscribers\.add\(|createEventHub\()/
const CURSOR_RE = /(id: \$\{|`id: |['"]id: |last-event-id|Last-Event-ID|\bseq\b|since=|\?since)/
const EVENT_PATH_RE = /^(events?|stream|sse|live)(\b|[/?])/i

/** 仓根相对路径（斜杠统一）：**判据只许看这个形状**（ISS-572）。 */
const relOf = (root, p) => path.relative(root, p).split(path.sep).join('/')

/** 排除判据的**唯一入口**：全脚本只有这一处能碰绝对路径 —— 敲掉仓根前缀后交给 `SKIP_DIR`，
 *  判据本体只吃相对路径（ISS-561 的 `skipPath(rel(p))` 同口径）。自检见 `selftest()` 的 `iss-1154 ⑥/⑦`。 */
const shouldSkipDir = (root, absPath) => SKIP_DIR.test('/' + relOf(root, absPath) + '/')

/* ───────────────────── 扫描面：gitignored / untracked-scratch 不是源码，不参与契约判定 ─────────────────────
 * 为什么要有这一层（ISS-860）：`.tmp/` 是试跑产物目录（`.gitignore:12` 已忽略），里面那个 archify 试跑
 * 项目也写 `text/event-stream` ⇒ 旧版全树扫把它当成本仓的一条广播通道，CC1/CC2 各报一条**假红**，
 * 并且会把 `--check` 顶到 exit 1（基线 CC1/CC2 = 0）⇒ 守卫被噪声顶红，真红就淹了。
 *
 * 判据来源是 **git 自己**，绝不在这儿重写 .gitignore 语义：
 *   · 生产路径：一次批量问 —— `git check-ignore --stdin`（与逐路径 `git check-ignore -q <path>` 同源同语义，
 *     selftest 里对拍；批量只为省 fork：608 条候选实测 17ms vs 5.9s）；
 *   · git 不可用（spawn 失败 / 非工作树）⇒ 退化为**显式排除 `.tmp/`**，并在输出里写明用的是退化判据；
 *   · `--include-ignored` 是逃生口：将来确要全树扫（含 scratch）时用它，不是"把判据改瞎"。
 * 注：git check-ignore 默认**看 index** ⇒ 已 tracked 的文件即使撞上忽略模式也仍会被扫（正是我们要的语义）。
 */
const SCRATCH_FALLBACK = /^\.tmp\//

/** 逐个路径问 git：true=被忽略 · false=没被忽略 · null=git 不可用（调用方退化为 SCRATCH_FALLBACK） */
function gitCheckIgnoreQ(rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: ROOT, stdio: 'ignore' })
  if (r.error || (r.status !== 0 && r.status !== 1)) return null
  return r.status === 0
}

/** 批量问 git：Set=被忽略的路径 · null=git 不可用。与 gitCheckIgnoreQ 同源（selftest 对拍两者结论） */
let gitAvailable = null // null=未探测 · false ⇒ 走 SCRATCH_FALLBACK 退化判据（输出里必须写明）
function gitIgnoredRels(rels) {
  if (!rels.length) return new Set()
  const r = spawnSync('git', ['check-ignore', '--stdin'], { cwd: ROOT, input: rels.join('\n'), encoding: 'utf8' })
  if (r.error || (r.status !== 0 && r.status !== 1)) { gitAvailable = false; return null }
  gitAvailable = true
  return new Set(String(r.stdout || '').split('\n').filter(Boolean))
}

/** 从候选里剔掉 gitignored / scratch（保持顺序）。includeIgnored = 逃生口：显式要求全树扫 */
function filterIgnored(files, includeIgnored = false) {
  if (includeIgnored) return files
  const ignored = gitIgnoredRels(files.map((f) => f.rel))
  if (ignored === null) return files.filter((f) => !SCRATCH_FALLBACK.test(f.rel))
  return files.filter((f) => !ignored.has(f.rel))
}

/** 只取"像路由"的字符串字面量：一级前缀 + 去掉首段后的剩余路径 */
const routeLiteralsOf = (text) => {
  const out = []
  const re = /['"`]\/((?:forge|agent|api)-[a-z0-9-]+|[a-z][a-z0-9-]*)\/([^'"`\s]*)['"`]/g
  let m
  while ((m = re.exec(text)) !== null) out.push({ prefix: '/' + m[1], rest: m[2] })
  return out
}

const pkgOf = (rel) => (rel.includes('/') ? rel.split('/')[0] : rel)

/**
 * 核心分析：输入 `[{rel, text}]` → 三条判据的违例。纯函数 ⇒ 自检不碰磁盘。
 * @param {{rel:string,text:string}[]} files
 */
function analyzeChannels(files) {
  /** @type {Map<string,{sse:boolean,hub:boolean,evPaths:Set<string>,allPaths:Set<string>,cursor:boolean,evFiles:Set<string>,subs:Set<string>,reads:Set<string>,readFiles:Set<string>}>} */
  const byPkg = new Map()
  const get = (p) => {
    if (!byPkg.has(p)) byPkg.set(p, { sse: false, hub: false, evPaths: new Set(), allPaths: new Set(), cursor: false, evFiles: new Set(), subs: new Set(), reads: new Set(), readFiles: new Set() })
    return byPkg.get(p)
  }
  for (const f of files) {
    const p = get(pkgOf(f.rel))
    const routes = routeLiteralsOf(f.text)
    for (const r of routes) {
      p.allPaths.add(r.prefix)
      if (EVENT_PATH_RE.test(r.rest)) p.evPaths.add(r.prefix)
    }
    const writesSse = /text\/event-stream/.test(f.text)
    p.sse = p.sse || writesSse
    p.hub = p.hub || HUB_RE.test(f.text)
    if (writesSse) {
      p.evFiles.add(f.rel)
      if (CURSOR_RE.test(f.text)) p.cursor = true
    }
    // 订阅点与重拉口：EventSource 的前缀 vs fetch 的前缀
    for (const m of f.text.matchAll(/new EventSource\(\s*[`'"]\/([a-z0-9-]+)/g)) p.subs.add('/' + m[1])
    for (const m of f.text.matchAll(/(?:fetch|get|getJSON|axios)\s*\(\s*[`'"]\/([a-z0-9-]+)/g)) p.reads.add('/' + m[1])
    if (p.reads.size) p.readFiles.add(f.rel)
  }
  const cc1 = [], cc2 = [], cc3 = []
  for (const [pkg, p] of byPkg) {
    if (p.sse && p.hub && !p.cursor) cc1.push({ k: pkg, d: '写 event-stream 的文件里没有游标（id:/seq）也读不到续传参数', files: [...p.evFiles] })
    // 订阅点与重拉口按**包**配对：重拉常写在 store 之外（组件里、hook 里），要求同文件会误伤
    for (const pref of p.subs) {
      if (!p.reads.has(pref)) cc2.push({ k: pkg, d: `订了 ${pref} 的流，但同包里找不到 ${pref}/… 的普通 HTTP 重拉（断线即缺帧）` })
    }
  }
  // 前缀级服务端面：某前缀下只有事件端点 ⇒ 提醒（是否故意纯增量流静态判不准，不判红）
  const prefixHasNonEvent = new Map()
  for (const f of files) for (const r of routeLiteralsOf(f.text)) if (!EVENT_PATH_RE.test(r.rest)) prefixHasNonEvent.set(r.prefix, true)
  for (const [pkg, p] of byPkg) {
    if (!(p.sse && p.hub)) continue
    for (const pref of p.evPaths) {
      if (!prefixHasNonEvent.get(pref)) cc3.push({ k: pkg, d: `${pref} 下只有事件端点，没有任何非事件读取口（可能是故意的纯增量流 ⇒ 只报）` })
    }
  }
  const sort = (a, b) => a.k.localeCompare(b.k)
  return {
    cc1: cc1.sort(sort), cc2: cc2.sort(sort), cc3: cc3.sort(sort),
    channels: [...byPkg].filter(([, p]) => p.sse && p.hub).map(([pkg, p]) => ({ pkg, evPaths: [...p.evPaths], cursor: p.cursor, subs: [...p.subs], reads: [...p.reads] })),
  }
}

/** 上一轮扫描的统计：过滤必须**看得见**（跳过了什么、为什么跳），否则过滤自己会变成新的看不见 */
let lastScan = { candidate: 0, scanned: 0, dropped: [], degraded: false }

/* 候选收集（跳过产物、依赖目录、脚本自身与测试）。**单独成函数 + 收 root 参数**：
   自检要的是"能分辨调用点喂绝对/相对"的端到端形状 —— 只喂谓词钉不住这一点（ISS-561 审查 low-1），
   所以 selftest 会在 `os.tmpdir()` 下造 `<base>/.wt/ISS-1/<pkg>/…` 跑**真 walk**（见 `iss-1154 ⑦/⑩`）。 */
function collectCandidates(root) {
  const candidates = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      /* ⚠️ 这里只认 **lstat 语义**的 dirent，不许 `statSync` 跟随软链（ISS-572 顺带修的真崩溃）：
         旧写法 `if (fs.statSync(p).isDirectory()) … else readFileSync(p)` 在软链上走的是**跟随**语义 ——
         ① 悬空软链 ⇒ statSync ENOENT 崩；
         ② 指向目录的软链 ⇒ 落到 else 分支、`readFileSync` 抛 EISDIR 崩（实测 `/tmp/ISS-559-link`）。
         旧代码只是被"先撞上别的 entry"掩盖着；ISS-572 改了剪枝顺序后它就露出来了。
         `e.isDirectory()`/`e.isFile()` 都是 dirent（不跟随）⇒ 两类软链都自然跳过，不用 try/catch。 */
      if (e.isDirectory()) { if (!shouldSkipDir(root, p)) walk(p); continue }
      if (!e.isFile()) continue
      const rel = relOf(root, p)
      if (SKIP_DIR.test('/' + rel) || !SRC_RE.test(rel) || /\.test\.[jt]sx?$/.test(rel) || rel.startsWith('scripts/')) continue
      candidates.push({ rel, text: fs.readFileSync(p, 'utf8') })
    }
  }
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const p = path.join(root, d.name)
    if (!shouldSkipDir(root, p)) walk(p)
  }
  return candidates
}

/* ───────────────────── fail-closed：扫描面塌缩时**拒绝报绿**（ISS-572 · 照 ISS-561 的口径） ─────────────────────
 * 为什么必须有这一半：判据修对了，下次再退回绝对路径形状（或换台机器、换个 ROOT 形状）时，症状仍然是
 * **候选塌缩 + 输出 ✓ + exit 0** —— 塌缩的守卫等于没有守卫。所以候选数异常低时直接 exit 2 并指认现场。
 */
const MIN_CANDIDATES = 100
const FORGE_PKGS_MIN = 5

const forgeDirCount = (root) =>
  fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('forge-')).length

/** 有牙的那一半（纯函数 ⇒ 正反例可推演、可自检）：候选数异常低 + 仓里确有多个 forge-* 包 ⇒ 拒判。
 *  返回 null（放行）或 { candidate, packages }（该红）。
 *  三个条件缺一不可，第三条是防误报的关键（见下方边界说明）：
 *  ① 候选 < 100：健康态实测 ≈ 1110、塌缩态 13 —— 100 落在两者之间；
 *  ② forge-* 包 ≥ 5：只有"确有多个包"的仓才谈得上塌缩，玩具仓豁免；
 *  ③ 候选 ≤ 包数：**每个包至少一个源文件**才叫扫过它 —— 5 个包却只收到 ≤5 个候选说明文件面也没走通，
 *     而一个"真小仓"（每包 1~2 个文件）在 ② 上过滤后仍可能 < 100，第三条正是为它兜底。 */
function scanCollapse(candidate, packages) {
  if (candidate >= MIN_CANDIDATES) return null
  if (packages < FORGE_PKGS_MIN) return null
  if (candidate > packages) return null
  return { candidate, packages }
}

/** 扫真实仓库（跳过产物、依赖目录、脚本自身与测试；再剔掉 gitignored/scratch —— 见「扫描面」） */
function scanRepo(includeIgnored = INCLUDE_IGNORED) {
  const candidates = collectCandidates(ROOT)
  const kept = filterIgnored(candidates, includeIgnored)
  const keptRels = new Set(kept.map((f) => f.rel))
  lastScan = {
    candidate: candidates.length,
    scanned: kept.length,
    dropped: candidates.map((f) => f.rel).filter((r) => !keptRels.has(r)),
    degraded: !includeIgnored && gitAvailable === false,
  }
  return kept
}

/* ───────────────────────────────── 自检：每条判据都必须能红 ───────────────────────────────── */
// 路由串一律**拼出来**：源码里不留 "前缀/路径" 形态的字面量 —— 盘点器把 scripts/ 也当代码扫，
// 这种串会被算成 K5f（同 path 多文件抄写）与 K5g（在自己包里写别人的路由前缀）。
// 上一批立的规矩在这儿同样成立：**改写法，不动上限**。
const P = (a, b) => '/' + a + '/' + b
const SERVER = (pkg, opts = {}) => ({
  rel: `${pkg}/lib/index.js`,
  text: `ws.register({ path: '${P(pkg, 'events')}' })${opts.noList ? '' : `\n    ws.register({ path: '${P(pkg, 'list')}' })`}
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const clients = new Set(); clients.add(res)
    req.on('close', () => clients.delete(res))
    res.write(\`id: \${evt.seq}\\ndata: \${JSON.stringify(evt)}\\n\\n\`)
    const since = new URL(req.url).searchParams.get('since') ?? req.headers['last-event-id']`,
})
const CLIENT = (pkg, withPull = true) => ({
  rel: `${pkg}/src/store.ts`,
  text: `es = new EventSource('${P(pkg, 'events')}?since=' + last)${withPull ? `\n    const r = await fetch('${P(pkg, 'list')}')` : ''}`,
})
/** 一段确定的 CC1 违规体（写了 event-stream、没有游标）：扫描面用例要把它**搬家**到不同 rel 上 */
const NO_CURSOR = (pkg, rel = `${pkg}/lib/index.js`) => ({
  ...SERVER(pkg),
  rel,
  text: SERVER(pkg).text.replace(/id: \$\{evt\.seq\}/, 'x: ${evt.ord}').replace(/\bseq\b/g, 'ord').replace(/last-event-id/g, 'xxx').replace(/\?since|'since'/g, 'xxx'),
})

function selftest() {
  const cases = []
  const t = (name, pass) => cases.push({ name, pass })
  let r = analyzeChannels([SERVER('forge-x'), CLIENT('forge-x')])
  t('合规通道（带游标 + 同包有重拉口）三条都不报', r.cc1.length + r.cc2.length + r.cc3.length === 0)

  r = analyzeChannels([NO_CURSOR('forge-x')])
  t('摘掉游标 ⇒ CC1 变红', r.cc1.length === 1 && r.cc1[0].k === 'forge-x')

  r = analyzeChannels([SERVER('forge-x'), CLIENT('forge-x', false)])
  t('摘掉非推送重拉（只剩订阅）⇒ CC2 变红', r.cc2.length === 1 && r.cc2[0].k === 'forge-x')

  r = analyzeChannels([SERVER('forge-x'), { rel: 'forge-x/src/store.ts', text: `es = new EventSource('${P('forge-x', 'events')}?since=' + last)` }, { rel: 'forge-x/src/api.ts', text: `const r = await fetch('${P('forge-x', 'list')}')` }])
  t('重拉口写在同包另一个文件 ⇒ 仍算有对账口（判包不判文件）', r.cc2.length === 0)

  r = analyzeChannels([{ rel: 'forge-x/src/other.ts', text: `es = new EventSource('${P('forge-x', 'events')}?since=' + n)\n    fetch('${P('forge-x', 'list')}')` }])
  t('重拉在同文件的另一条 fetch 也算 ⇒ CC2 不报', r.cc2.length === 0)

  r = analyzeChannels([
    { rel: 'forge-y/lib/proxy.js', text: `ws.register({ path: '${P('forge-y', 'passthrough')}' })\n    res.writeHead(200, { 'Content-Type': 'text/event-stream' })\n    const reader = upstream.body.getReader()` },
    { rel: 'forge-y/src/dsh/client-entry.tsx', text: `(fn) => (directory ? directory.subscribe(fn) : () => {})` },
  ])
  t('透传代理不算广播（UI store 的 subscribe 也不是广播证据）', r.cc1.length + r.cc2.length + r.cc3.length === 0 && r.channels.length === 0)

  r = analyzeChannels([
    { rel: 'forge-v/lib/events.js', text: `import { createEventHub } from 'forge-service-kit/events'\n    const hub = createEventHub({ label: 'forge-v' })` },
    { rel: 'forge-v/lib/index.js', text: `ws.register({ path: '${P('forge-v', 'events')}' })\n       res.writeHead(200, { 'Content-Type': 'text/event-stream' })\n       res.write(\`id: \${evt.seq}\\n\\n\`)` },
  ])
  t('广播器与 writeHead 分文件 ⇒ 仍认出通道（按包判定）', r.channels.length === 1 && r.channels[0].pkg === 'forge-v')

  r = analyzeChannels([
    { rel: 'forge-v/lib/events.js', text: `import { createEventHub } from 'forge-service-kit/events'\n    const hub = makeThing({ label: 'forge-v' })` },
    { rel: 'forge-v/lib/index.js', text: `ws.register({ path: '${P('forge-v', 'events')}' })\n       res.writeHead(200, { 'Content-Type': 'text/event-stream' })` },
  ])
  t('拿掉广播证据（hub 不再实例化、也没有客户端集合）⇒ 通道从表里消失（判不了 ≠ 合规）', r.channels.length === 0)

  r = analyzeChannels([SERVER('forge-z', { noList: true }), CLIENT('forge-z', false)])
  t('某前缀下只有事件端点 ⇒ CC3 报出（提醒档），且 CC2 同时报（缺重拉口）', r.cc3.length === 1 && r.cc3[0].k === 'forge-z' && r.cc2.length === 1)

  r = analyzeChannels([SERVER('forge-x'), CLIENT('forge-x')])
  t('全合规时 CC3 也不许乱报（防空判）', r.cc3.length === 0)

  t('扫描跳过 dist/node_modules/static 与 scripts/ 自身', !scanRepo().some((f) => /\/dist\/|node_modules|\/static\//.test(f.rel) || f.rel.startsWith('scripts/')))

  /* ── 扫描面（ISS-860）：同一段 CC1 违规，放 tracked 位置必须红，放 gitignored scratch 不许红 ──
   * 双向判：只验"scratch 不报"会得到一条恒绿判据（把扫描面整个关掉也过）；所以必须同时验"非 ignored 时照样红"。 */
  const tracked = NO_CURSOR('forge-x', 'forge-x/lib/index.js')
  const keptTracked = filterIgnored([tracked])
  r = analyzeChannels(keptTracked)
  t(`① CC1 违规放在**非 ignored** 路径 ⇒ 照样变红（${tracked.rel} 经 git 判为不忽略；过滤没拔牙；真 tracked 文件见 ⑤）`, keptTracked.length === 1 && r.cc1.length === 1 && r.cc1[0].k === 'forge-x')

  const scratch = { ...tracked, rel: '.tmp/archify-trial/archify/bin/preview.mjs' }
  const keptScratch = filterIgnored([scratch])
  r = analyzeChannels(keptScratch)
  t(`② 同内容放进 .tmp/（gitignored scratch）⇒ 不红：scratch 非源码、不参与契约判定（候选 1 → 已扫 ${keptScratch.length}）`, keptScratch.length === 0 && r.cc1.length + r.cc2.length + r.cc3.length === 0)

  r = analyzeChannels(filterIgnored([scratch], true))
  t('③ --include-ignored 逃生口：显式要求全树时同一 scratch 文件仍被扫到并报出（证明不是把判据改瞎）', r.cc1.length === 1 && r.cc1[0].k === '.tmp')

  // 判据一致性：生产的批量路径（`--stdin`）必须与逐路径 `git check-ignore -q <path>` 同结论，
  // 否则"批量"就成了偷偷换判据的性能优化。无 git 的环境则验退化判据（显式排除 .tmp/）。
  const probe = ['.tmp/forge-x/lib/index.js', 'forge-x/lib/index.js']
  const oneByOne = probe.map((p) => gitCheckIgnoreQ(p))
  if (oneByOne[0] === null) {
    t('无 git ⇒ 退化判据 = 显式排除 .tmp/（且不误伤普通路径）', SCRATCH_FALLBACK.test('.tmp/a/b.mjs') && !SCRATCH_FALLBACK.test('forge-agents/lib/index.js'))
  } else {
    const batch = gitIgnoredRels(probe) || new Set()
    t('判据一致性：批量 check-ignore（--stdin）与逐个 `git check-ignore -q <path>` 结论相同（.tmp/ 忽略=true · forge-x/ 忽略=false）',
      probe.every((p, i) => batch.has(p) === oneByOne[i]) && oneByOne[0] === true && oneByOne[1] === false)
    // 再拿一个**真 tracked** 文件抽验：check-ignore 默认看 index ⇒ 已入库文件即使撞上忽略模式也不该被剔
    const real = String(spawnSync('git', ['ls-files', '--', 'forge-agents/lib'], { cwd: ROOT, encoding: 'utf8' }).stdout || '')
      .split('\n').filter((f) => /\.(js|ts|tsx|mjs)$/.test(f))[0]
    t(`⑤ 真 tracked 文件不被过滤（抽样 ${real || '（ls-files 空 ⇒ 判不了）'}）`, !!real && gitCheckIgnoreQ(real) === false && filterIgnored([{ rel: real, text: '' }]).length === 1)
  }

  // 真扫描面：默认扫描结果里不许有 gitignored 路径，且**每条被剔除的路径都要能单独被 git 确认为 ignored**
  // （反向也判：别把 tracked 文件误剔了）。本树盘上有 .tmp/ 试跑产物 ⇒ 这条不是空判。
  const FIXTURE = '.tmp/archify-trial/archify/bin/preview.mjs'
  const fixtureOnDisk = fs.existsSync(path.join(ROOT, FIXTURE))
  const scanned = scanRepo()
  t(`④ 真扫描面：候选 ${lastScan.candidate} · 已扫 ${lastScan.scanned} · 跳过 ${lastScan.dropped.length} 条（逐条经 git check-ignore -q 确认为 ignored）${fixtureOnDisk ? '；.tmp/ 试跑产物在盘上但未被扫' : '；本树无 .tmp/ 试跑产物 ⇒ 该向为空判'}`,
    lastScan.dropped.every((rel) => gitCheckIgnoreQ(rel) === true) && (!fixtureOnDisk || !scanned.some((f) => f.rel === FIXTURE)))

  /* ── ISS-572（R29 家族第三处）：扫描排除判据必须按**仓根相对路径**判 ──
   * 谓词级用例钉不住这一点（ISS-561 审查 low-1）：真正的病灶在**调用点**喂绝对路径。
   * 所以 ⑦/⑩ 落盘 fixture 跑**真 walk** —— 树根自身在 `.wt/` 里（本机沙箱下唯一可用的工作树落点）。 */
  const fakeRoot = '/tmp/<repo>/.wt/ISS-1'
  t('iss-1154 ⑥ 排除判据只喂相对路径：树根在 `.wt` 里时，包内目录/文件都不许被跳过（`shouldSkipDir` 吃绝对路径也不许命中）',
    shouldSkipDir(fakeRoot, fakeRoot + '/forge-pm') === false &&
    shouldSkipDir(fakeRoot, fakeRoot + '/forge-pm/lib') === false &&
    shouldSkipDir(ROOT, path.join(ROOT, 'forge-pm')) === false &&
    // 仓根**相对路径**里的 .wt/ 仍照排（ISS-572 没放宽排除面）：deps/dist 同理
    shouldSkipDir(fakeRoot, fakeRoot + '/.wt/ISS-2') === true &&
    shouldSkipDir(fakeRoot, fakeRoot + '/forge-x/node_modules') === true &&
    shouldSkipDir(fakeRoot, fakeRoot + '/forge-x/dist') === true)
  // ISS-724：新落点 `.agents/worktrees`（两段）。名字级判据看不出它是工作树 ⇒ 必须有路径级用例钉住，
  // 否则搬家后整整一个池子会被当成本仓源码，候选数暴涨、CC1/CC2 在别人的树上假红。
  t('iss-1933 新落点 .agents/worktrees 照排（两段）',
    shouldSkipDir(ROOT, path.join(ROOT, '.agents', 'worktrees', 'ISS-1', 'forge-x')) === true &&
    shouldSkipDir(ROOT, path.join(ROOT, '.agents', 'worktrees')) === true &&
    // `.agents/` 下别的东西（skills）不是工作树，误杀会让技能文档里的通道样例消失
    shouldSkipDir(ROOT, path.join(ROOT, '.agents', 'skills', 'reviewer')) === false)

  /* ⑦ 真 walk 端到端：**根自身在 `.wt` 里**（= 仓内工作树的真实形状）。这是能分辨"调用点喂绝对/相对"的
     形状 —— 判据只有在"被检路径含 `/.wt/`"时才可能出错，而仓内工作树里**子目录的绝对路径**正是这个形状
     （ROOT=`<repo>/.wt/ISS-x` ⇒ `p=<repo>/.wt/ISS-x/forge-pm`）。
     ⚠️ 第一版 fixture 把树造在 `<tmp>/.wt/ISS-1/` 下、拿 `<tmp>` 当 root —— 那样被剪的是 `<tmp>/.wt`，
     对非工作树的仓来说**是正确行为**，于是用例在变异体上也照样绿（假守卫，已推翻）。
     现在照 `os.tmpdir()` 下造 `<base>/.wt/ISS-1/{forge-*}`、拿 `<base>/.wt/ISS-1` 当 root，与生产同形。
     变异验证（调用点改回 `!SKIP_DIR.test(p + '/')`）时这条必红。 */
  const wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-wt-'))
  const wtRoot = path.join(wtBase, '.wt', 'ISS-1')
  try {
    fs.mkdirSync(path.join(wtRoot, 'forge-pm', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(wtRoot, 'forge-pm', 'lib', 'index.js'), SERVER('forge-pm').text)
    fs.writeFileSync(path.join(wtRoot, 'forge-pm', 'lib', 'a.test.js'), '// 测试文件不算候选\n')
    fs.mkdirSync(path.join(wtRoot, 'forge-pm', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(wtRoot, 'forge-pm', 'node_modules', 'skip.js'), '// 依赖目录必须跳过\n')
    fs.mkdirSync(path.join(wtRoot, '.wt', 'ISS-2', 'forge-old', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(wtRoot, '.wt', 'ISS-2', 'forge-old', 'lib', 'index.js'), '// 仓内嵌套工作树仍要排除\n')
    // 软链福利：悬空软链 + 指向目录的软链都不许炸（旧写法分别 ENOENT / EISDIR，见 collectCandidates 注释）
    fs.symlinkSync(path.join(wtRoot, 'nope-does-not-exist'), path.join(wtRoot, 'forge-pm', 'dangling-link.js'))
    fs.symlinkSync(path.join(wtRoot, 'forge-pm', 'lib'), path.join(wtRoot, 'forge-pm', 'dirlink.js'))
    const got = collectCandidates(wtRoot).map((f) => f.rel)
    t(`iss-1154 ⑦ 落盘 fixture 跑真 walk：根自身在 .wt 里也能走到底（收到 ${got.length} 个候选，含 forge-pm/lib/index.js；嵌套 .wt/、node_modules、软链都排除）`,
      got.includes('forge-pm/lib/index.js') && !got.some((r) => /node_modules|\.test\.js$|^\.wt\/|link\.js$/.test(r)))
  } finally {
    fs.rmSync(wtBase, { recursive: true, force: true })
  }

  /* ⑩ 生产形状直检：拿**本脚本所在的工作树当 root** 再跑一遍真 walk。
     本单跑在 `.wt/ISS-572` 里 ⇒ 这条用例如果变红，就是"仓内工作树又静默归零"这件事本身复发。 */
  const here = collectCandidates(ROOT).map((f) => f.rel)
  t(`iss-1154 ⑩ 生产形状直检：本树（ROOT=${ROOT}）真 walk 收到 ${here.length} 个候选 —— 仓内工作树不许归零`,
    here.length > 100 && here.includes('forge-pm/lib/index.js'))

  /* ⑧ fail-closed 正反例（照 ISS-561 的"半径取法"）：小仓不误报 / 塌缩必红。
     边界为什么这么取：本仓健康态原始候选 ≈ 1110、塌缩态 13 ⇒ 100 落在两者之间；
     条件② 只对"确有 ≥5 个 forge-* 包"的仓生效（玩具仓豁免）；条件③（候选 ≤ 包数）再兜一层：
     一个包连一个源文件都收不到，说明文件面也没走通。三条合取 ⇒ 真小仓（每包 1~2 文件）仍放行。 */
  t('iss-1154 ⑧ fail-closed：小仓/健康态放行；塌缩（候选 13 + 29 包）与"5 包只收到 ≤5 文件"都必红',
    scanCollapse(60, 3) === null && scanCollapse(1110, 29) === null && scanCollapse(MIN_CANDIDATES, 9) === null &&
    scanCollapse(300, 120) === null && scanCollapse(99, 5) === null &&
    scanCollapse(13, 29) !== null && scanCollapse(4, FORGE_PKGS_MIN) !== null && scanCollapse(5, 5) !== null)

  /* ⑨ 双保险：把 ⑥ 的 fixture 用**旧写法**（绝对路径喂 SKIP_DIR）跑一遍，必须"整棵树被跳过" ——
     这条把 bug 的形状本身钉在测试里：将来若有人把 ⑥ 的断言写松（改成恒真），⑨ 会立刻暴露。 */
  const oldShape = (p) => SKIP_DIR.test(p + '/')
  t('iss-1154 ⑨ 反向：同一条判据若退回吃绝对路径，树根在 `.wt` 里时包内目录会被跳过（bug 形状仍在测里）',
    oldShape(fakeRoot + '/forge-pm') === true && shouldSkipDir(fakeRoot, fakeRoot + '/forge-pm') === false)
  return cases
}

if (process.argv.includes('--selftest')) {
  const cs = selftest()
  const bad = cs.filter((c) => !c.pass)
  console.log(cs.map((c) => `${c.pass ? '✓' : '✗'} ${c.name}`).join('\n'))
  console.log(`自检 ${cs.length - bad.length}/${cs.length}`)
  process.exit(bad.length ? 1 : 0)
}

const res = analyzeChannels(scanRepo())
const counts = { CC1: res.cc1.length, CC2: res.cc2.length, CC3: res.cc3.length }
/* ISS-572 有牙的那一半：塌缩的扫描面**不许**报绿（修复前实测"候选 13 · 广播型通道 0 条 · ✓ CC1/CC2 在限内 · exit 0"）。
   放在计数之前、所有模式下（含 --json / --write）：任何"基于这堆候选"的结论都不该由坏扫描面得出。 */
const collapsed = scanCollapse(lastScan.candidate, forgeDirCount(ROOT))
if (collapsed) {
  console.error(`✗ 扫描面塌缩：候选只有 ${collapsed.candidate} 个，而 ${ROOT} 下有 ${collapsed.packages} 个 forge-* 包 —— 这不是"零违例"，是扫描面坏了。`)
  console.error('  该查什么：① 是否跑在仓内工作树（<主仓>/.wt/<ISS>）—— 排除判据必须按仓根相对路径判（ISS-572；同族 ISS-561）')
  console.error(`            ② ROOT=${ROOT} 算得对不对 ③ 软链/权限是否让整棵子树读不到`)
  console.error(`  拒绝出数（exit 2）：塌缩的扫描面会给出"✓ 在限内"的假绿，比报错危险。判据：候选 < ${MIN_CANDIDATES} 且 forge-* 包 ≥ ${FORGE_PKGS_MIN} 且 候选 ≤ 包数`)
  process.exit(2)
}
const scanLine = INCLUDE_IGNORED
  ? `扫描面：候选 ${lastScan.candidate} · ⚠ --include-ignored 全树扫（含 gitignored/scratch）`
  : lastScan.degraded
    ? `扫描面：候选 ${lastScan.candidate} · 已扫 ${lastScan.scanned} · 跳过 ${lastScan.dropped.length}（⚠ git 不可用 ⇒ 退化判据 = 显式排除 .tmp/）`
    : `扫描面：候选 ${lastScan.candidate} · 已扫 ${lastScan.scanned} · 跳过 gitignored/scratch ${lastScan.dropped.length} 条（判据 = git check-ignore）`
if (process.argv.includes('--json')) { console.log(JSON.stringify({ counts, scan: lastScan, includeIgnored: INCLUDE_IGNORED, ...res }, null, 1)); process.exit(0) }
console.log(`活推送契约 · 广播型通道 ${res.channels.length} 条（${res.channels.map((c) => c.pkg).join(' / ')}）· CC1 无游标 ${counts.CC1} · CC2 订阅无重拉 ${counts.CC2} · CC3 提醒 ${counts.CC3}`)
console.log(`  ${scanLine}`)
for (const x of res.cc1) console.log(`  ✗ CC1 ${x.k} —— ${x.d}（${x.files.join(' ')}）`)
for (const x of res.cc2) console.log(`  ✗ CC2 ${x.k} —— ${x.d}`)
for (const x of res.cc3) console.log(`  ⚑ CC3 ${x.k} —— ${x.d}`)
if (process.argv.includes('--write')) {
  // 逃生口不许用来录基线：那会把 scratch 里的假红**写进棘轮上限**（CC1 1 就成了"合法"），
  // 之后再跑 --check 永远绿 ⇒ ISS-860 这个坑会以更贵的形态回来（基线得靠人记得去收）。
  if (INCLUDE_IGNORED) { console.log('✗ --write 不许与 --include-ignored 同用：那会把 scratch 的假红录进基线，棘轮再也收不回来'); process.exit(2) }
  const prev = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {}
  const next = { ...prev, tool: 'lint-channel-contract.mjs', recordedAt: new Date().toISOString().slice(0, 10), note: '广播型 SSE 通道：CC1 游标 · CC2 订阅端非推送重拉（两条判红）；CC3 只报（静态判不准是否故意纯增量流）', ceiling: { CC1: counts.CC1, CC2: counts.CC2 }, offenders: { CC1: res.cc1.map((x) => x.k), CC2: res.cc2.map((x) => x.k) } }
  fs.writeFileSync(BASELINE, JSON.stringify(next, null, 1) + '\n')
  console.log(`✓ 已录基线（CC1 ${counts.CC1} · CC2 ${counts.CC2}）`)
  process.exit(0)
}
if (process.argv.includes('--check')) {
  if (!fs.existsSync(BASELINE)) { console.log('✗ 缺基线（没基线不免检，先 --write 再改）'); process.exit(1) }
  const c = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).ceiling || {}
  const worse = ['CC1', 'CC2'].filter((k) => counts[k] > (c[k] ?? 0))
  if (worse.length) { console.log(`✗ 超限：${worse.map((k) => `${k} ${c[k]} → ${counts[k]}`).join(' · ')}（只许降；确要扩在提交说明里点名）`); process.exit(1) }
  console.log('✓ CC1/CC2 在限内')
}
process.exit(0)
