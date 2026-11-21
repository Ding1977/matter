#!/usr/bin/env node
// scripts/lint-code.mjs
// 代码规范的落地门禁（PRJ-016 / ISS-722）：把 `docs/code.md` 的 K 号判据变成**能判红**的东西。
//
// 为什么它不自己重写判据（本文件唯一的设计决定）：判据的算法已经在 `scripts/code-inventory.mjs` 里，
//   而那份同时产出 `docs/code-audit.md` 的现状数字。门禁若另写一套匹配逻辑，两处就会漂移 ——
//   于是"规范说有门禁"与"审计说有几个数"各说各话（本仓先例：守卫的判据错了会批量制造假结论）。
//   ⇒ 本文件只做三件事：① 跑盘点取结果；② 按规则表判 零容忍 / 白名单 / 棘轮；③ 反向验证自己。
//   要改判据就去改盘点脚本，**别在这里放宽**。
//
// 四档规则（对应 docs/code.md §0.4 的 ⛔ / ⚠️ / ✅）：
//   zero      必须为 0（现状已是 0 的那批 ⇒ 任何回归当场红，零误伤）
//   whitelist 违例集合必须 ⊆ 白名单，**每条必须带理由**；新增即红；欠账已清却不删条目也红（化石）
//   ratchet   数值只许降不许升（`take` 指明"值的第几段是坏ness"，避免拿总量当违规量判红）
//   report    只报不判（数值方向不是"越小越好"的，硬判就是假红制造机）
//
// 用法：node scripts/lint-code.mjs [--check|--write|--json|--verbose|--top N|--all|--selftest|--dump <file>|--baseline <file>]
//   --baseline 换一份基线（缺省 scripts/baseline/code-gates.json）。存在理由：验过期/定位要用「改坏一份副本」
//              做正反控，而仓库里那份是真相源，不许当试验田（ISS-671）。
//   --write    从当前盘点结果生成/刷新白名单键与棘轮上限；理由一律写成占位符「待补」，
//              **要人补了才不红** —— 脚本不替你决定允许什么。
//              只覆盖工具管理的四个字段，基线里**人工加的顶层键**（如 reasonPolicy）原样保留。
//   --selftest 用内建 fixture 反向验证三档规则各自能红能绿（不扫真仓库，所以能构造"该红"的场景）。
//   --dump     读一份 code-inventory 的 --json 产物：给 CI 或批量脚本复用一次扫描，不重复跑。
//   --top N    一个 finding 最多列几条 items（缺省 = 零容忍 6 / 棘轮 4）；`--top 0` = 全量。
//   --all      同 `--top 0`。
//   --verbose  全部细节 = 打全部摘要行 + items 全量（同 `--top 0`）。三者冲突时**显式 `--top` 优先**。
//   ⚠️ 无论怎么截断，**输出必须报总数与省略数**（ISS-674：读者把前 4 条当全集，
//      实测造成「27 → 32 个 god module 被读成只有 5 个越线」的判断事故）。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..')
const INVENTORY = path.join(ROOT, 'scripts', 'code-inventory.mjs')
const DOC = path.join(ROOT, 'docs', 'code.md')
const ARGV = process.argv.slice(2)
const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

/**
 * 基线路径（ISS-671）：缺省仍是仓库里那份，可用 `--baseline <file>` 换一份。
 * 为什么要这个口：验收要「把 writtenAt 改成 10 天前 ⇒ 必须报过期」，而仓库里那份基线是**真相源**
 * （改了它等于改判定标准）。没有这个口，验这条判据只能改真相源再改回来 —— 那种验法本身就会出事。
 * 给错了（跟了另一个开关 / 文件不存在）**必须出声**，不许静默回落到缺省：
 * 「我以为在验副本，其实验的是真相源」正是假绿的标准形态。
 */
function resolveBaseline(argv) {
  const at = argv.indexOf('--baseline')
  const eq = argv.find((a) => a.startsWith('--baseline='))
  if (at === -1 && !eq) return { file: path.join(ROOT, 'scripts', 'baseline', 'code-gates.json'), explicit: false }
  const raw = eq ? eq.slice('--baseline='.length) : argv[at + 1]
  if (raw === undefined || raw === '' || raw.startsWith('--')) return { err: '--baseline 后面缺路径（只认 `--baseline <file>` 或 `--baseline=<file>`）' }
  const file = path.resolve(raw)
  if (!fs.existsSync(file)) return { err: `--baseline 指的文件不存在：${file}（宁可红，不静默回落到仓库基线）` }
  return { file, explicit: true }
}
const BL = resolveBaseline(ARGV)
if (BL.err) {
  console.error(`✗ ${BL.err}`)
  process.exit(EXIT.INTERNAL)
}
const BASELINE = BL.file
/** 定位提交时用它当窗口下界：基线最后一次改动 = 判定标准的落点（见 attributeFinding 的注释）。 */
const BASELINE_REL = path.relative(ROOT, path.join(ROOT, 'scripts', 'baseline', 'code-gates.json'))

/** 占位理由 = 还没想清楚凭什么允许 ⇒ 判红（白名单不许空转成"默认放过"）。 */
const PLACEHOLDER_WHY = ['', '待补', 'TODO', 'todo', '-', 'n/a']

/** `--verbose`/`--all`/`--top 0` ⇒ 摘要全打（由 main 按 parseTop 的结果拨）。 */
let ALL_DETAIL = false

/**
 * 解析 `--top N`（也认 `--top=N`）。返回 `{ value }`：`undefined` = 没给（各档用缺省 6/4），`0` = 全量。
 * `--all` / `--verbose` 等价于 `--top 0`（`--verbose` 的语义就是"全部细节"，见文件头）；显式 `--top` 优先。
 * **给错了必须出声**：静默回落会让"我要全量"变成"我看了前 4 条"—— 正是 ISS-674 的形状。
 */
function parseTop(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a !== '--top' && !a.startsWith('--top=')) continue
    const raw = a === '--top' ? argv[i + 1] : a.slice('--top='.length)
    if (raw === undefined || raw.startsWith('--')) return { err: '--top 后面缺值（只认 `--top N` 或 `--top=N`）' }
    if (!/^\d+$/.test(raw)) return { err: `--top 要 ≥0 的整数，收到「${raw}」（截断口径不明的输出比截断本身更坏）` }
    return { value: Number(raw) }
  }
  if (argv.includes('--all') || argv.includes('--verbose')) return { value: 0 }
  return { value: undefined }
}

/**
 * 截断 + 记账（ISS-674）。`items` 保持短（不撑爆输出），**`itemsTotal` 必须一起带上**。
 * 没有 `itemsTotal` 的读者视角就是"这就是全部"—— 实测代价：把 27 → 32 个 god module
 * 读成"只有 5 个越线"，并照错的数写了一整份汇报。
 */
function cutItems(offenders, defaultCap, top) {
  const cap = top === undefined ? defaultCap : top
  return { items: cap === 0 ? offenders.slice() : offenders.slice(0, cap), itemsTotal: offenders.length }
}

/** 一个 finding 的完整渲染行。截断时**必须**补"另 N 个"，照同文件 TRACKED_MISSING 的既有写法。 */
function renderFinding(f) {
  const items = f.items || []
  const out = [`  ✗ ${f.rule} ${f.detail}`]
  for (const i of items) out.push(`      · ${i}`)
  const total = f.itemsTotal === undefined ? items.length : f.itemsTotal
  if (total > items.length) out.push(`      … 另 ${total - items.length} 个（共 ${total} 条；--top 0 看全量）`)
  /* ISS-671 ②：定位结果紧跟在 items 之后 —— 读者看到「新增 4 处」的第一反应是「谁干的」，
     把答案放在同一屏才不会让人自己去翻 git。拿不到时**必须**打出理由（验收第 5 条）。 */
  for (const s of f.suspects || []) out.push(`      ↳ ${s.sha} ${s.date} ${s.subject}（${s.file} · ${s.strength}）`)
  if (f.attrNote) out.push(`      ⤷ ${f.attrNote}`)
  return out
}

/* ─────────────────────── ISS-671 ① 基线过期（只警告，不改退出码） ─────────────────────── */

/**
 * 过期阈值 7 天。为什么是 7：**从基线自己的收线历史现算，不是拍的**。
 * `git log --format=%ad --date=short -- scripts/baseline/code-gates.json` 去重得 14 个日期，
 * 相邻间隔的中位数是 2 天、最长的正常间隔是 7 天（10-12→10-19）；本单现场那次 6 天没动
 * 就攒了 16 处新增（见工单 ②）。取 7 天 ⇒ 正常节奏不报，一旦超过「历史上最长的一次正常间隔」
 * 就出声。再小就会天天响（长鸣的警告 = 没有警告，本仓 ISS-587 同类）。
 * ⚠️ 这是阈值，不是承诺：连报三周都无人收线时该改的是流程（§0.7 的责任人），不是把这个数调大。
 */
const STALE_DAYS = 7

/**
 * 判定基线「什么时候盘的」——三级兜底，顺序有理由：
 *   ① `writtenAt`：机器写入时刻（最准，但现库没有，是本次新加的字段）
 *   ② `recordedAt`：人工记录的日期（语义正确 —— 它就是「基线是什么时候盘的」；09-22 起一直有）
 *   ③ 文件 `mtime`：最后兜底。**不能当主判据** —— checkout / rsync / `--write` 都会刷它，
 *      「刚 clone 下来的 6 天前基线」会被算成今天刚盘过（假绿）。
 * 三级都拿不到 ⇒ 返回 null，调用方**不报**（失败安全）：没有时间戳不等于基线过期，
 * 拿不到就出声会让「基线文件不可读」这种事故伪装成「基线过期」。
 */
function baselineStamp(cfg, mtimeMs) {
  for (const [field, raw] of [['writtenAt', cfg.writtenAt], ['recordedAt', cfg.recordedAt]]) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const t = Date.parse(raw.trim())
    // 写坏的日期（`2026-13-45` / 随手写的中文）当"拿不到"，不静默当今天 —— 但要在返回值里说清是哪一级
    if (!Number.isNaN(t)) return { at: t, from: field }
  }
  if (Number.isFinite(mtimeMs)) return { at: mtimeMs, from: 'mtime' }
  return null
}

/**
 * 过期判断（纯函数）。返回 `{ days, text }` 或 `null`（不报）。`now` 由调用方注入 ⇒ 可测。
 * **只产警告，不产 finding**：基线旧了不是代码错，改退出码会让「门禁红」同时代表两件事，
 * 那正是本单要治的「红得没信息」。所以本函数的结果只进 `warnings`，不进退出码。
 */
function staleBaseline(stamp, now, days = STALE_DAYS) {
  if (!stamp) return null
  const age = Math.floor((now - stamp.at) / 86400000)
  if (age <= days) return null
  const when = new Date(stamp.at).toISOString().slice(0, 10)
  return {
    days: age,
    text: `基线已过期 ${age} 天（记于 ${when} · 取自 ${stamp.from}，阈值 ${days} 天）⇒ 上面的「新增 N 处」是 ${age} 天累积量，不是这次改的。收线前先看下面的「疑似引入」，确认不是回归再跑 --write（收线周期与责任人见 docs/code.md §0.7）`,
  }
}

/* ─────────────────── ISS-671 ② 新增违例定位到提交（B 案起步） ─────────────────── */

/**
 * 定位方案选 B（基线落点 → 窗口内改过的文件 → 与新增违例的文件取交集 → 点名那次提交），
 * 并**叠加** blame 兜底。理由：
 *   · A（基线里存每个指纹 + 引入 commit）最准，但它要求基线体积与实现复杂度同时上一个量级，
 *     而基线是**人工复核**的真相源 —— 往里塞几千条指纹，人就没法核了；
 *   · C（存 HEAD sha 后全区 blame）每个 finding 都要对本机全仓跑 blame：D2 638 个 site、
 *     E8 382 个 site，逐个 blame 实测 ~25ms×1000 ≈ 25s，门禁从 6.6s 涨到 30s+，会被绕开；
 *   · B 只跑**一次** `git log --name-only`（实测 0.05s / 29 文件），把「窗口内改过的文件」建成索引，
 *     再拿新增违例的文件去查 —— 没有逐 site 的子进程。
 * 准确度说清楚（**不许把「可能与必然」混着报**）：B 能给的是「疑似」。文件进过窗口 ≠ 这一行的违例
 * 是那次引入的。所以对能拿到行号的 metric 再补一次 `git blame -L`（每次一个文件一条命令，
 * 按文件批量，不按 site 逐个）：blame 结果若也落在窗口内 ⇒ 升格为「强嫌疑」并给出 commit；
 * blame 落在窗口外 ⇒ 说明**这一行不是这次改的**（文件被改过但这一行没动）⇒ 明确降级，不冒充。
 */
const GIT = (() => {
  try {
    return spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() === 'true'
  } catch { return false }
})()

function gitRun(args, cwd = ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 })
  return r.status === 0 ? r.stdout : null
}

/**
 * 窗口下界 = 基线文件最后一次改动的那次提交。
 * 为什么不用 `recordedAt` / `writtenAt` 的日期：日期是**人写的**，可以被回填、也可以比提交时间早一天；
 * 而「基线是哪次提交定下的」是 git 事实，取不到才退回过期天数。取不到 git ⇒ 返回 `{ err }`，由调用方明说。
 */
function attributionWindow() {
  if (!GIT) return { err: '不在 git 工作树内（定位需要 git log / blame）' }
  const anchor = gitRun(['log', '-1', '--format=%H', '--', BASELINE_REL])
  if (anchor === null || !anchor.trim()) return { err: `基线 ${BASELINE_REL} 没有任何提交记录（新文件 / 未入库）⇒ 无法确定窗口下界` }
  const files = new Map() // 文件 → 窗口内**最近**一次改它的提交（git log 默认倒序，先到先得）
  const commitsById = new Map() // 全 sha → { short, date, subject }（blame 给全 sha，必须能回查）
  const raw = gitRun(['log', '--format=@@%H\t%h\t%ad\t%s', '--date=short', '--name-only', `${anchor.trim()}..HEAD`])
  if (raw === null) return { err: `git log ${anchor.trim().slice(0, 8)}..HEAD 执行失败` }
  let cur = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      const [sha, short, date, ...rest] = line.slice(2).split('\t')
      cur = { sha, short, date, subject: rest.join('\t') || '' }
      commitsById.set(sha, cur)
      continue
    }
    if (!line.trim() || !cur) continue
    if (!files.has(line)) files.set(line, cur)
  }
  return { anchor: anchor.trim(), files, commitsById, commits: commitsById.size }
}

/** 度量 site 的 `k` 可能是 `名字 @ 路径`（K6a）也可能就是路径（K9f/K9c）⇒ 统一取路径。 */
function siteFile(k) {
  const s = String(k || '')
  const at = s.lastIndexOf(' @ ')
  return at >= 0 ? s.slice(at + 3) : s
}

/**
 * 给一个 finding 定位疑似引入的提交。返回 `{ suspects: [...], note: string }` ——
 * `suspects` 为空时 **`note` 必须写明为什么**（验收第 5 条：不许静默返回空）。
 * `metric` 带上 `sites`（有行号）就能逐行 blame 定级；只有 offenders（聚合数）时只能给到文件级。
 *
 * 两档措辞严分开（这是本函数存在的意义）：
 *   **强嫌疑** = `git blame` 说这一行的最后修改人就是窗口内某次提交 ⇒ 「疑似由 <commit> 引入」有行级依据；
 *   **疑似**   = 文件进过窗口，但 blame 说这些行不是窗口内的提交改的 ⇒ 只是「文件被改过」，
 *               违例很可能早就在那儿（比如同一文件被改了一处，别处的老违例跟着被算进「新增」）。
 * 两档都不许互相冒充：把疑似写成强嫌疑，等于把本单要治的「红得没信息」换成「假指认」。
 */
function attributeFinding(rule, metric, win) {
  if (win.err) return { suspects: [], note: `无法定位（${win.err}）` }
  if (!win.commits) return { suspects: [], note: `无法定位（基线落点 ${win.anchor.slice(0, 8)} 之后没有新提交 ⇒ 新增不是本窗口产生的，可能是基线之后改了盘点口径或度量射程）` }
  const offenders = (metric.offenders || []).map((o) => (typeof o === 'string' ? o : o.k))
  // 能拿到具体位置就按位置定位；只有聚合 offenders（如「forge-pm」「num」）时只能按文件交集给线索
  const sites = metric.sites || []
  const hitFiles = new Map() // 文件 → 窗口内最近一次改它的提交
  for (const s of sites) {
    const f = siteFile(s.k)
    const c = win.files.get(f)
    if (c && !hitFiles.has(f)) hitFiles.set(f, c)
  }
  if (!hitFiles.size) {
    // 位置对不上就退一步：新增 offender 的**包名**是否有同名目录在窗口里被动过（弱线索，明说弱）
    const pkgs = new Set(offenders.map((o) => String(o).split(' ')[0]).filter((p) => /^(forge-[a-z0-9-]+|electron-shell|scripts)$/.test(p)))
    const touchedPkgs = [...pkgs].filter((p) => [...win.files.keys()].some((f) => f === p || f.startsWith(`${p}/`)))
    return {
      suspects: [],
      note: sites.length
        ? `无法定位（该规则 ${sites.length} 个违例位置都不在基线落点之后的 ${win.files.size} 个改动文件里 ⇒ 大概率是**度量射程/口径变了**或未入库文件造成的假涨，逐条核对 git status 与 scripts/code-inventory.mjs 的历史）`
        : `无法定位（该度量只产聚合计数、不带行号；基线落点之后改过的文件里${touchedPkgs.length ? `有 ${touchedPkgs.join('、')}` : '没有'}同名目录 ⇒ 只能到这一层，要更准得先给该度量加 sites）`,
    }
  }
  /* blame 兜底：只对**有行号**的 site 做，且**按文件批量**（一条命令一个文件，`-L` 可重复给多段），
     不按 site 逐个起进程 —— D2 638 个 site / E8 382 个 site，逐个 blame 会把门禁从 6s 拖到 30s+。
     每个文件最多取 20 段：够判档，且避免命令行超长。 */
  const verdict = new Map() // 文件 → { sha, date, subject, hit, lines, blamed }
  for (const [f] of hitFiles) {
    const lines = [...new Set(sites.filter((s) => siteFile(s.k) === f && Number.isFinite(s.line)).map((s) => s.line))].slice(0, 20)
    const out = lines.length ? gitRun(['blame', '--line-porcelain', ...lines.flatMap((L) => ['-L', `${L},${L}`]), '--', f]) : null
    if (out === null) { verdict.set(f, { blamed: false, hit: false, lines: lines.length }); continue }
    // porcelain 每个「组」以 `<40位sha> <原行> <结果行> <组内行数>` 开头 ⇒ 这些 sha 就是这些行的最后修改人
    const shas = [...out.matchAll(/^([0-9a-f]{40}) \d+ \d+ \d+$/gm)].map((m) => m[1])
    // 「命中窗口内某次提交」= blame 给出的 sha 在窗口的提交表里（不必等于该文件最近那次提交）
    const inWin = [...new Set(shas)].filter((s) => win.commitsById.has(s))
    const pick = inWin.length ? win.commitsById.get(inWin[0]) : hitFiles.get(f)
    verdict.set(f, { blamed: true, hit: inWin.length > 0, ...pick, lines: lines.length })
  }
  const ranked = [...verdict.entries()]
    .sort((a, b) => Number(b[1].hit) - Number(a[1].hit))
    .map(([f, v]) => ({
      file: f,
      sha: v.sha || hitFiles.get(f).sha,
      date: v.date || hitFiles.get(f).date,
      subject: v.subject || hitFiles.get(f).subject,
      strength: !v.blamed
        ? '疑似（blame 跑不了 ⇒ 只按「文件进过窗口」推，不能当指认）'
        : v.hit
          ? `强嫌疑（blame 命中窗口内提交，${v.lines} 行有据）`
          : '疑似（文件进过窗口，但 blame 说这些违例行不是那次改的 ⇒ 老违例被算进了新增）',
    }))
  const suspects = ranked.slice(0, 5)
  const strong = ranked.filter((s) => s.strength.startsWith('强')).length
  return {
    suspects,
    note: `窗口 = ${win.anchor.slice(0, 8)}..HEAD（${win.commits} 次提交 / ${win.files.size} 个文件）· 命中 ${hitFiles.size} 个文件，其中 ${strong} 个 blame 落到窗口内、${hitFiles.size - strong} 个只是文件进过窗口` +
      (hitFiles.size > suspects.length ? `（另 ${hitFiles.size - suspects.length} 个未列，--top 0 不放开这一档）` : ''),
  }
}

/**
 * 规则表：一条 K 号 ↔ 盘点脚本的一个度量。号与 `docs/code.md` §0.4 同源，
 * 新增条目的准入条件：**能一句话说清"什么情况必红"**（规范 K8a）。
 */
export const RULES = [
  // ── ⛔ 零容忍（现状 = 0，任何回归当场红）──
  { rule: 'K1c', metric: 'B6', mode: 'zero', spec: '§1', text: '装配表声明了但盘上没有的 id' },
{ rule: 'K1g', metric: 'B3', mode: 'zero', spec: '§1', text: 'workspaces 声明了但磁盘没有的包（装配死链 ⇒ import 它的人全悬空）' },
  { rule: 'K3a', metric: 'H2', mode: 'zero', spec: '§2', text: '包级 import 环' },
  { rule: 'K3b', metric: 'H3', mode: 'zero', spec: '§2', text: '依赖方向违规（必须上层依赖下层）' },
  { rule: 'K3d', metric: 'H6', mode: 'zero', spec: '§2', text: 'client 半 import node 内置模块' },
  { rule: 'K4e', metric: 'H12', mode: 'zero', spec: '§3', text: '主 tsconfig 里 strict:false' },
  { rule: 'K5a', metric: 'C2', mode: 'zero', spec: '§4', text: 'defineTool 缺 output.render' },
  { rule: 'K5b', metric: 'C5', mode: 'zero', spec: '§4', text: '内嵌 object 缺 additionalProperties' },
  // 判据早写在 §4 的 K5b 原文里（"工具名匹配 ^[a-zA-Z0-9_-]+$"），度量 `C3` 也早有 —— 缺的只是没人接成规则 ⇒ 号按 K5b 的子条走
  { rule: 'K5b·n', metric: 'C3', mode: 'zero', spec: '§4', text: '工具名字符集不合规（判据原文在 K5b 那一行里）' },
  { rule: 'K5c', metric: 'C6', mode: 'zero', spec: '§4', text: 'systemPrompt.section 键集不合规' },
  { rule: 'K5d', doc: 'K5b', metric: 'C4', mode: 'zero', spec: '§4', text: '工具名重复定义（后注册者静默失效）' },
  { rule: 'K9a', metric: 'E6', mode: 'zero', spec: '§8', text: '库代码不得 process.exit（会带走宿主进程）' },
  // ── ⛔ 白名单（存量欠账逐条带理由）──
  { rule: 'K1a', metric: 'B2', mode: 'whitelist', spec: '§1', text: '盘上有 package.json 但不在根 workspaces' },
  { rule: 'K1b', metric: 'B5', mode: 'whitelist', spec: '§1', text: '三不靠包（两引擎不可达且无人 import）' },
  { rule: 'K3c', metric: 'H5a', mode: 'whitelist', spec: '§2', text: '未声明且解析不到的 import' },
  { rule: 'K3f', metric: 'H5c', mode: 'whitelist', spec: '§2', text: '路径别名 import' },
  { rule: 'K4a', metric: 'H9', mode: 'whitelist', spec: '§3', text: '零 tsconfig 的包（类型门禁盲区）' },
  // ⚠️ doc: 规则号与文档号**不是一一对应**（ISS-759 实测）。本条是文档 K4a 的**后半句**，
  //   文档 K4a 由本表的 K4a(H9) + K4b(H10) 两条合起来才算有牙。退役/删规则时按 doc 找，不要按 rule 找。
  { rule: 'K4b', doc: 'K4a', metric: 'H10', mode: 'whitelist', spec: '§3', text: 'host 半不在任何 tsconfig 范围内' },
  { rule: 'K7a', metric: 'T2', mode: 'whitelist', spec: '§7', text: '零测试文件的包' },
  // doc: 跨族——文档把这件事故在 K4（门禁入口），脚本按「测试」放进了 K7。
  { rule: 'K7b', doc: 'K4e', metric: 'T4', mode: 'whitelist', spec: '§7', text: '缺 typecheck 或 test 脚本的包' },
{ rule: 'K7i', metric: 'T5', mode: 'zero', spec: '§7', text: 'typecheck 脚本里不含 tsc（假门禁：名字对、事没做，跑了等于没跑）' },
  // ── ⛔ 棘轮（只许降）──
  { rule: 'K2a', metric: 'N4', mode: 'ratchet', take: 0, spec: '§6', text: '≥1000 行的 god module 数' },
  // doc: 文档 K2b 讲「拆出的模块必须能被静态扫到」，K2c 才讲子目录命名；本条量的是后者。
  { rule: 'K2b', doc: 'K2c', metric: 'N5', mode: 'ratchet', take: 0, spec: '§6', text: 'client 半子目录名种数' },
  { rule: 'K3c·b', metric: 'H5b', mode: 'ratchet', take: 0, spec: '§2', text: '未声明但靠 hoisting 侥幸可解析的 import' },
  { rule: 'K3e', metric: 'H8', mode: 'ratchet', take: 0, spec: '§2', text: 'exports 形态与角色不符的包' },
{ rule: 'K3h', metric: 'H7', mode: 'zero', spec: '§2', text: 'host 半 import react（无渲染上下文，既污染 bundle 又必然用错）' },
{ rule: 'K3g', metric: 'H4', mode: 'zero', spec: '§2', text: '契约包 forge-agent-protocol 有出边（有边就不叫契约，契约层被污染）' },
  // doc: 本条量的是文档 K4b 说的「档位数每多一档 = 一份手抄」，名字从 K4c 起就错了位。
  { rule: 'K4c', doc: 'K4b', metric: 'H11', mode: 'ratchet', take: 0, spec: '§3', text: 'tsconfig 编译器选项档位种数' },
  { rule: 'K5e', metric: 'C7b', mode: 'ratchet', take: 0, spec: '§4', text: 'host 半直接同步写盘的文件数' },
  { rule: 'K5f', metric: 'C9', mode: 'ratchet', take: 0, spec: '§4', text: '同一 path 被抄写到多个文件' },
  { rule: 'K5g', metric: 'C10', mode: 'ratchet', take: 0, spec: '§2', text: '在自己包里写别人的路由前缀' },
  { rule: 'K5i', metric: 'C9d', mode: 'whitelist', spec: '§4', text: '悬空端点引用：client/mcp/scripts 写了本包前缀而 host 未注册' },
  { rule: 'K6a', metric: 'D2', mode: 'ratchet', take: 0, spec: '§5', text: '同名多份实现' },
  { rule: 'K6b', metric: 'D3', mode: 'ratchet', take: 0, spec: '§5', text: '跨文件复制粘贴函数簇' },
  { rule: 'K6c', metric: 'D4', mode: 'ratchet', take: 0, spec: '§5', text: '通用能力被多包各自实现的项（S3 在收的就是它）' },
  { rule: 'K6f', metric: 'D7', mode: 'ratchet', take: 0, spec: '§5', text: '内核件就地重抄（json/readBody/parseQuery 只许内核一份）' },
  // 与 K6f 共用度量 D7，但两档各治一种病：K6f 管**数量**（不许多抄），K6g 管**署名**（留下的每一处
  // 必须写清"为什么不并回内核"）。只有 K6f 的话，把同体的一份换成少一个 gzip 分支的一份，数不变 ⇒ 静默放行。
  { rule: 'K6g', metric: 'D7', mode: 'whitelist', spec: '§5', text: '内核件重抄未登记理由' },
  { rule: 'K6e', metric: 'D6', mode: 'ratchet', take: 0, spec: '§5', text: 'forge-design 之外另起 ui/ 目录的包' },
  { rule: 'K9e', metric: 'E1', mode: 'ratchet', take: 0, spec: '§8', text: '不裸用 console.*（host 半用 console 的文件数；按包明细归 lint-log-outlet）' },
  { rule: 'K9b', metric: 'E3', mode: 'ratchet', take: 0, spec: '§8', text: '空 catch 块' },
  { rule: 'K9c', metric: 'E5', mode: 'ratchet', take: 0, spec: '§8', text: 'shell 里的静默失败' },
  { rule: 'K9f', metric: 'E8', mode: 'ratchet', take: 0, spec: '§8', text: '跨边界错误应带 kind：裸 throw new Error(...) 调用点（棘轮）' },
  { rule: 'K10a', metric: 'Z1', mode: 'ratchet', take: 0, spec: '§9', text: '零引用源文件' },
  { rule: 'K10b', metric: 'Z2', mode: 'ratchet', take: 1, spec: '§9', text: '零引用导出（第 2 段才是坏ness，第 1 段是导出总数）' },
{ rule: 'K10f', metric: 'Z3', mode: 'zero', spec: '§9', text: '解析不到的 import（写了路径但文件不在，运行时必炸，此前无人拦）' },
  // ── ⚠️ 只报不判 ──
  { rule: 'K6d', metric: 'D5', mode: 'report', spec: '§5', text: '共享层消费者数（多不一定坏，少才要问）' },
  { rule: 'K8a', metric: 'T7', mode: 'report', spec: '§7', text: '铁律"有牙率"（本门禁就是它的部分兑现）' },
]

/** 度量值里取第 n 个整数；取不到返回 NaN —— 调用方按"判不了"报，不静默当 0。 */
export function nthInt(value, n = 0) {
  const nums = String(value ?? '').match(/-?\d+/g) || []
  return nums[n] === undefined ? NaN : Number(nums[n])
}

/**
 * 核心判定（纯函数：度量表 + 配置 → findings / stale / missing）。
 * 拆成纯函数的理由：反向验证要能构造"该红"的假数据，真仓库扫描一次几十秒且造不出回归场景。
 */
/**
 * 规则号 ↔ `docs/code.md` 同源检查（09-23 第 5 格随批）。
 * 起因是我加 `K6g` 时顺手比了一遍，撞出三处**一直存在但没人看得见**的漂移：
 *   ① 文档 §5 里有**两行同号 `K6f`**（一行为已接线的"只许一份"，一行为未接线的"合并不豁免等价性"）；
 *   ② §2 的 `K5g` 在 §4 又被当新号声明一次（指针行没写"指针"）；
 *   ③ 脚本里的 `K3c·b` 这一档在文档里根本没有对应号（文档只写了一行 K3c 覆盖两档）。
 * 号被复用 = 一条判据有两个含义，正是 K8a 要治的"有编号冒充有门禁"，出现在规范里比出现在代码里更坏。
 * 两个方向都查：脚本有号而文档没有 ⇒ 漂；文档里同一号声明两行 ⇒ 漂。文档读不到 ⇒ 报"判不了"而不是通过。
 * ⚠️ **故意不 export**：度量 Z2 量的就是"没人 import 的导出"，为一支内部判据加 export 会把零引用数
 *    顶高一格（09-23 首版就这么红了：804 → 805）—— 自检与调用点都在本模块内，不需要跨模块可见。
 */
function docDrift(rules, doc) {
  if (!doc) return [{ rule: '§0.4', metric: 'docs/code.md', why: '读不到规范文档 —— 号同源检查判不了，别当"通过"' }]
  const out = rules.filter((r) => !doc.includes(r.rule))
    .map((r) => ({ rule: r.rule, metric: 'docs/code.md', why: '规范里没有这个号 —— 脚本与文档已漂移（改文档或改号，别静默）' }))
  const seen = new Map()
  for (const m of doc.matchAll(/^\| \*\*(K[0-9][^\s|]*)\*\* \|/gm)) seen.set(m[1], (seen.get(m[1]) || 0) + 1)
  for (const [k, n] of seen) if (n > 1) out.push({ rule: k, metric: 'docs/code.md', why: `规范里这个号声明了 ${n} 行 —— 一条号两个含义，先分号再谈门禁` })
  return out
}

/**
 * 头部版本行 ↔ 变更记录 同源（09-23 实测两处漂移：变更记录已写到 v0.12，头部还挂 v0.2；
 * 行序按字符串排 ⇒ `v0.1` 夹在 v0.4 与 v0.3 之间，读者分不清哪条是最新的）。
 * 两个方向都要有牙：一致时不报、滞后与乱序各报一条；缺头部行 / 缺变更记录 ⇒ 报"判不了"而不是通过。
 * ⚠️ 与 docDrift 同一条纪律：**故意不 export**（零引用导出本身是被 Z2 量的指标）。
 */
function headDrift(doc) {
  if (!doc) return [{ rule: '变更记录', metric: 'docs/code.md', why: '读不到规范文档 —— 版本同源检查判不了，别当"通过"' }]
  const head = doc.match(/^> \*\*版本\*\*：v(\d+)\.(\d+)/m)
  const rows = [...doc.matchAll(/^\| v(\d+)\.(\d+)/gm)].map((m) => Number(m[1]) * 1000 + Number(m[2]))
  if (!head || !rows.length) return [{ rule: '变更记录', metric: 'docs/code.md', why: '头部版本行或变更记录读不到 —— 判不了，别当"没有漂移"' }]
  const ver = (n) => `v${Math.floor(n / 1000)}.${n % 1000}`
  const h = Number(head[1]) * 1000 + Number(head[2])
  const newest = Math.max(...rows)
  const out = []
  if (h !== newest) out.push({ rule: '变更记录', metric: 'docs/code.md', why: `头部写 ${ver(h)}，变更记录最新是 ${ver(newest)} —— 头部是读者第一眼，改文档要同步它` })
  for (let i = 1; i < rows.length; i++) if (rows[i] > rows[i - 1]) { out.push({ rule: '变更记录', metric: 'docs/code.md', why: `变更记录非数值降序（${ver(rows[i - 1])} 后面跟着 ${ver(rows[i])}）—— 字符串序会把 v0.1 排到 v0.3 前面` }); break }
  return out
}

/**
 * 核心判定（纯函数：度量表 + 配置 → findings / stale / missing）。
 * 拆成纯函数的理由：反向验证要能构造"该红"的假数据，真仓库扫描一次几十秒且造不出回归场景。
 *
 * `attr`（ISS-671 ②，可选）：`(rule, metric) => { suspects, note }` 或 `null`。
 * **注入而不内置**：本函数要能被自检以假度量调用（那时没有真仓库、也不该起 git 子进程）。
 * 不传 = 不定位（自检路径）；CLI 传真实现。这样「定位」这条判据的牙长在自检里可直接构造，
 * 而不是只能靠"跑一遍真仓库看着像对"。
 */
export function evaluate(metrics, cfg, top, attr = null) {
  const byKey = new Map(metrics.map((m) => [m.id, m]))
  const findings = []
  const stale = []
  const missing = []
  const lines = []
  /** 挂定位结果；`attr` 缺省 ⇒ 什么都不加（自检路径不许被 git 牵连） */
  const withAttr = (f, r, m) => {
    if (!attr) return f
    const a = attr(r.rule, m)
    if (!a) return f
    return { ...f, suspects: a.suspects || [], attrNote: a.note }
  }
  for (const r of RULES) {
    const m = byKey.get(r.metric)
    if (!m) {
      missing.push({ rule: r.rule, metric: r.metric, why: '盘点没产出这个度量 —— 判据失效或度量被改名，别当"没问题"' })
      continue
    }
    const offenders = (m.offenders || []).map((o) => (typeof o === 'string' ? o : o.k))
    if (r.mode === 'zero') {
      /* ISS-629：**分母为 0 ⇒ 判据空转**，不许当成绿。本仓反复踩过「扫了 0 个文件 ⇒ 恒绿」
         （ISS-619 同类）。零容忍规则特别危险：它的正常值就是 0，所以"什么都没扫到"和
         "真的没有违例"在输出上一模一样 —— 必须在分母上分开。 */
      if (m.scanN === 0) { findings.push({ rule: r.rule, detail: `${r.text}：扫描面为空（分母 0）⇒ 判据空转，不许当绿`, items: [], itemsTotal: 0 }); continue }
      if (nthInt(m.value, 0) === 0 && offenders.length === 0) lines.push(`  ✓ ${r.rule} ${r.text} = 0`)
      else findings.push(withAttr({ rule: r.rule, detail: `${r.text} 不为 0：${m.value}`, ...cutItems(offenders, 6, top) }, r, m))
    } else if (r.mode === 'whitelist') {
      // 度量自带 skip ⇒ 判据的输入不在这台机器上：**不判**（不产违例、也不算化石）。
      // 为什么不能照判：CI runner 没有 ~/.dsh 的装配表，B5 会把每个包都看成「引擎不可达」⇒ 凭空 17 条违例；
      // 那是把「看不见」说成「没有」（ISS-774 同族），红得让人以为门禁在跑。
      if (m.skip) { lines.push(`  · ${r.rule} ${r.text}：本机没有该判据的输入 ⇒ 不判（不许把看不见当成没有）`); continue }
      const allow = (cfg.whitelist || {})[r.rule] || {}
      let added = 0
      for (const k of offenders) {
        const why = allow[k]
        if (why === undefined) {
          findings.push(withAttr({ rule: r.rule, detail: `${r.text}：新增「${k}」不在白名单（要么改代码，要么写理由登记）`, items: [] }, r, m))
          added++
        } else if (PLACEHOLDER_WHY.includes(String(why).trim())) {
          findings.push({ rule: r.rule, detail: `${r.text}：「${k}」的豁免没有理由（占位符不算理由）`, items: [] })
        }
      }
      for (const k of Object.keys(allow)) {
        if (!offenders.includes(k)) stale.push({ rule: r.rule, key: k, why: String(allow[k]) })
      }
      if (!added && offenders.length) lines.push(`  ✓ ${r.rule} ${r.text}：${offenders.length} 条全在名单内`)
      else if (!added && !offenders.length) lines.push(`  ✓ ${r.rule} ${r.text}：0 条（名单已空，可整条删掉）`)
    } else if (r.mode === 'ratchet') {
      // 同上：判据输入不在本机 ⇒ 不判（不升不降，也不许拿「看不见」的数去收线）
      if (m.skip) { lines.push('  · ' + r.rule + ' ' + r.text + '：本机没有该判据的输入 ⇒ 不判'); continue }
      const now = nthInt(m.value, r.take || 0)
      const cap = (cfg.ceiling || {})[r.rule]
      if (Number.isNaN(now)) missing.push({ rule: r.rule, metric: r.metric, why: `值「${m.value}」里没有第 ${(r.take || 0) + 1} 个整数，棘轮判不了 —— 改 take 或改度量口径，别默认放过` })
      else if (cap === undefined) missing.push({ rule: r.rule, metric: r.metric, why: '上限未记录 —— 先跑 --write 建立基线（缺基线不等于免检）' })
      else if (now > cap) findings.push(withAttr({ rule: r.rule, detail: `${r.text} 新增：${cap} → ${now}`, ...cutItems(offenders, 4, top) }, r, m))
      // ISS-671 ③：收线提示补一句 —— 上限低于现值时先看新增定位，别把回归一起收进基线
      else if (now < cap) lines.push(`  ↓ ${r.rule} ${r.text} ${now} < 上限 ${cap}（可收线：确认下面的新增不是回归后跑 --write）`)
      else lines.push(`  = ${r.rule} ${r.text} 等于上限 ${cap}`)
    } else {
      lines.push(`  · ${r.rule} ${r.text}：${m.value}（只报不判）`)
    }
  }
  return { findings, stale, missing, lines }
}

/* ─────────────────────────── 装载 ─────────────────────────── */

function readMetrics() {
  const at = ARGV.indexOf('--dump')
  if (at !== -1 && ARGV[at + 1]) return JSON.parse(fs.readFileSync(ARGV[at + 1], 'utf8')).metrics
  const r = spawnSync(process.execPath, [INVENTORY, '--json'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.status !== 0) throw new Error(`盘点失败（exit ${r.status}）：${String(r.stderr || r.stdout || '').slice(0, 400)}`)
  const j = JSON.parse(r.stdout)
  // ★ ISS-582：把"未入库被跳过的文件"带出来 —— 它们是**测量缺口**，不是代码变差。
  //   实测教训：S1 拆 routes.js 时新文件未 `git add`，K10b 零引用导出假涨 14（420 → 434），
  //   让一次独立审查把 high 记到了错的地方。缺口必须**在判据输出里可见**。
  TRACKED_MISSING = Array.isArray(j.trackedMissing) ? j.trackedMissing : []
  TRACKED_ALL = j.trackedAll === true
  return j.metrics
}
/** 未入库被跳过的文件（ISS-582）：非空 ⇒ 本次棘轮结论**不完整**。 */
let TRACKED_MISSING = []
let TRACKED_ALL = false

function readCfg() {
  const j = readBaselineRaw()
  return { whitelist: j.whitelist || {}, ceiling: j.ceiling || {} }
}

/** 基线的 mtime（过期判断的第三级兜底）。读不到 ⇒ undefined ⇒ 不报（失败安全）。 */
function baselineMtime(file) {
  try { return fs.statSync(file).mtimeMs } catch { return undefined }
}

/**
 * 给 evaluate 的定位口（ISS-671 ②）。**惰性**：只有真出现 findings 时才去跑 git
 * （绿的时候一次子进程都不起 —— 门禁 6.6s 的预算别再浇一层）。
 * 同一个 metric 只算一次（`--write` 之外每轮至多 5 条 finding，但同度量可能被两条规则共用，如 K6f/K6g）。
 */
function attributionFor(metrics) {
  let win = null
  const cache = new Map()
  return (rule, metric) => {
    const key = `${rule}:${metric.id}`
    if (cache.has(key)) return cache.get(key)
    if (win === null) win = attributionWindow()
    const res = attributeFinding(rule, metric, win)
    cache.set(key, res)
    return res
  }
}

/** 基线原文（不做字段裁剪）：--write 要拿它保住"人工写的顶层字段" */
function readBaselineRaw() {
  if (!fs.existsSync(BASELINE)) return {}
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
}

/**
 * 合成要写回的基线：工具只管 `whitelist` / `ceiling` 与三个头部字段，
 * 其余**人工加的顶层键**（例如 `reasonPolicy` 这条策略原文）必须原样带过去。
 * 上一版直接整体覆盖一次 `--write`，静默抹掉了 reasonPolicy —— 复录丢字段的典型形态。
 * （故意**不加 export**：K10b 量的就是"没人 import 的导出"，自检在同一文件里直接调。）
 */
function mergeBaseline(prev, next) {
  return { ...prev, ...next }
}

/* ─────────────────────────── --selftest ─────────────────────────── */

export function selftest() {
  const cases = []
  const push = (name, ok, note = '') => cases.push({ name, ok, note })
  const mk = (id, value, offs = []) => ({ id, value, offenders: offs.map((k) => ({ k })) })
  /* scanN = 「判据输入规模」的分母。ISS-629 补丁：零容忍规则必须带分母，
     否则「扫了 0 个对象」和「真的零违例」在输出上一模一样。 */
  const mkS = (id, value, scanN) => ({ id, value, offenders: [], scanN })

  push('零容忍 = 0 时不红', evaluate([mk('B6', 0), mk('H2', 0)], { whitelist: {}, ceiling: {} }).findings.length === 0)
  push('零容忍回归即红', (() => {
    const r = evaluate([mk('B6', 1, ['ghost-id']), mk('H2', 0)], { whitelist: {}, ceiling: {} })
    return r.findings.some((f) => f.rule === 'K1c') && r.findings[0].items.includes('ghost-id')
  })())

  const cfgW = { whitelist: { K1a: { 'forge-x': '自检：已知欠账，等 bun.lock 窗口' } }, ceiling: {} }
  push('白名单命中 ⇒ 不红', (() => {
    const r = evaluate([mk('B2', 1, ['forge-x'])], cfgW)
    return r.findings.length === 0 && r.stale.length === 0
  })())
  push('新增违例即红', evaluate([mk('B2', 2, ['forge-x', 'forge-new'])], cfgW).findings.some((f) => /forge-new/.test(f.detail)))
  push('欠账清了但名单没删 ⇒ 报化石', (() => {
    const r = evaluate([mk('B2', 0, [])], cfgW)
    return r.stale.length === 1 && r.stale[0].key === 'forge-x'
  })())
  push('豁免没有理由（占位符）判红', evaluate([mk('B2', 1, ['forge-x'])], { whitelist: { K1a: { 'forge-x': '待补' } }, ceiling: {} }).findings.some((f) => /没有理由/.test(f.detail)))

  const cfgR = { whitelist: {}, ceiling: { K6c: 16 } }
  push('棘轮等于上限不红', evaluate([mk('D4', '16')], cfgR).findings.length === 0)
  push('棘轮升一格即红', evaluate([mk('D4', '17')], cfgR).findings.some((f) => f.rule === 'K6c'))
  const dropCase = evaluate([mk('D4', '15')], cfgR)
  push('棘轮下降只提示不红', dropCase.findings.length === 0 && dropCase.lines.some((l) => /收线/.test(l)))
  const noBaseline = evaluate([mk('D4', '9')], { whitelist: {}, ceiling: {} })
  push('缺基线不静默放行', noBaseline.missing.some((x) => x.rule === 'K6c'))
  const noNumber = evaluate([mk('D4', '—')], cfgR)
  push('值取不到整数 ⇒ 报"判不了"而不是当 0', noNumber.missing.some((x) => /棘轮判不了/.test(x.why)))
  const noMetric = evaluate([], cfgR)
  push('度量缺席 ⇒ 报判据失效', noMetric.missing.some((x) => /盘点没产出/.test(x.why)))

  /* ── ISS-629 补丁：5 条零容忍规则各正反一条（10 条）──
     正向：对象在册、值为 0 ⇒ 绿（正常状态）。
     反向：**把被判对象从扫描集合里拿掉**（scanN=0）⇒ 必须红「判据空转」。
     为什么反向要造「对象缺席」而不是「造一个违例」：造违例会红是显然的；
     真正阴的形态是**被判的东西整个消失、规则还判绿**（第五种假判据形态：分母与被判对象脱钩）。
     H4 就是活样本——分母曾写成 adj.size（19 个别的包），契约包删了照样绿。 */
  for (const [rule, metric, what] of [
    ['K1g', 'B3', 'workspaces 装配死链'],
    ['K3g', 'H4', '契约包出边'],
    ['K3h', 'H7', 'host 半 import react'],
    ['K7i', 'T5', '假 typecheck'],
    ['K10f', 'Z3', '解析不到的 import'],
  ]) {
    push(`${rule} 正控：${what} 对象在册且值为 0 ⇒ 绿`,
      evaluate([mkS(metric, 0, 7)], { whitelist: {}, ceiling: {} }).findings.length === 0)
    const gone = evaluate([mkS(metric, 0, 0)], { whitelist: {}, ceiling: {} })
    push(`${rule} 反控：${what} **被判对象缺席**（分母 0）⇒ 判红「判据空转」`,
      gone.findings.some((f) => f.rule === rule && /空转/.test(f.detail)),
      gone.findings.map((f) => f.detail).join(' | ').slice(0, 120))
  }

  // --write 的写回语义：工具管理的键以新值为准，人工加的顶层键原样带过去
  const merged = mergeBaseline(
    { recordedAt: '2020-01-01', whitelist: { K1a: { 'forge-gone': '旧条目' } }, ceiling: { K6c: 99 }, reasonPolicy: '每条豁免必须写理由' },
    { recordedAt: '2026-09-22', whitelist: { K1a: { 'forge-x': '新条目' } }, ceiling: { K6c: 16 } },
  )
  push('--write 不抹掉人工写的顶层字段', merged.reasonPolicy === '每条豁免必须写理由')
  push('--write 用新值覆盖白名单/上限（不留旧条目）', JSON.stringify(merged.whitelist) === '{"K1a":{"forge-x":"新条目"}}' && merged.ceiling.K6c === 16)
  push('--write 的 recordedAt 取新值', merged.recordedAt === '2026-09-22')
  push('基线不存在时 --write 仍产出完整结构', ['recordedAt', 'whitelist', 'ceiling'].every((k) => k in mergeBaseline({}, { recordedAt: 'x', whitelist: {}, ceiling: {} })))
  const cfgK10 = { whitelist: {}, ceiling: { K10b: 830 } }
  push('K10b 取第 2 段（总数涨、零引用降 ⇒ 不红）', evaluate([mk('Z2', '9999 / 800 / 8%')], cfgK10).findings.length === 0)
  push('K10b 零引用涨了照样红', evaluate([mk('Z2', '9999 / 900 / 9%')], cfgK10).findings.some((f) => f.rule === 'K10b'))

  // 号 ↔ 文档同源（docDrift）：四个方向都要有判别力，缺一条这支检查就是摆设
  push('规则号在文档里查不到 ⇒ 报漂', docDrift([{ rule: 'K9z' }], '| **K1a** | 别的判据 |').length === 1)
  push('号在文档里有 ⇒ 不报', docDrift([{ rule: 'K1a' }], '| **K1a** | 跨包 import 必须声明 |').length === 0)
  push('文档里同号声明两行 ⇒ 报漂（09-23 实测 K6f 就是这样被复用的）',
    docDrift([], '| **K1a** | 甲 |\n| **K1a** | 乙 |').some((x) => /两行|含义/.test(x.why)))
  push('指针行不算重复声明', docDrift([], '| **K1a** | 甲 |\n| §2 **K1a**（同一判据，指针） | 见 §2 |').length === 0)
  push('文档读不到 ⇒ 报"判不了"而不是通过', docDrift([{ rule: 'K1a' }], '').length === 1)

  // 头部版本 ↔ 变更记录（headDrift）：同样两头都验
  push('头部版本 = 变更记录最新且降序 ⇒ 不报', headDrift('> **版本**：v0.12（略）\n| v0.12 | a |\n| v0.11 | b |\n| v0.9 | c |').length === 0)
  push('头部版本滞后于变更记录 ⇒ 报（09-23 实测：头部 v0.2 而记录已到 v0.12）',
    headDrift('> **版本**：v0.2（略）\n| v0.12 | a |\n| v0.11 | b |').some((x) => /头部写 v0\.2/.test(x.why)))
  push('变更记录按字符串排 ⇒ 报（v0.1 夹在 v0.4 与 v0.3 中间）',
    headDrift('> **版本**：v0.4\n| v0.4 | a |\n| v0.1 | b |\n| v0.3 | c |').some((x) => /降序/.test(x.why)))
  push('只有头部没有变更记录 ⇒ 报"判不了"', headDrift('> **版本**：v0.4\n正文').length === 1)
  push('文档空 ⇒ 报"判不了"而不是通过', headDrift('').length === 1)

  /* ── ISS-674：截断必须报总数与省略数 ──
     反控要「删掉那行"另 N 个"就变红」，所以判据挂在**渲染出来的文本**上，不是挂在字段上：
     字段对了但没打出来，读者看到的仍然是"这就是全部"。10 条 offenders 是刻意选的最小构造 ——
     棘轮缺省 4 ⇒ 省略 6，与事故现场（27 → 32 被读成 5 条）同一个形状。 */
  const tenOffs = (n = 10) => Array.from({ length: n }, (_, i) => ({ k: `forge-off-${i + 1}` }))
  const ratchetFinding = (top) => evaluate([{ id: 'D4', value: '17', offenders: tenOffs() }], cfgR, top).findings.find((f) => f.rule === 'K6c')
  const zeroFinding = (top) => evaluate([{ id: 'B6', value: 10, offenders: tenOffs(), scanN: 9 }], { whitelist: {}, ceiling: {} }, top).findings.find((f) => f.rule === 'K1c')
  push('缺省截断：10 条 offenders 必须写出「另 6 个（共 10 条）」（棘轮缺省 4）', (() => {
    const f = ratchetFinding(undefined)
    const t = renderFinding(f).join('\n')
    return f.items.length === 4 && f.itemsTotal === 10 && /另 6 个/.test(t) && /共 10 条/.test(t)
  })(), '不是理论上可能：本仓据此把 27 → 32 个 god module 读成"只有 5 个越线"')
  push('缺省截断：零容忍档缺省 6 条，10 条 ⇒ 写出「另 4 个（共 10 条）」', (() => {
    const f = zeroFinding(undefined)
    const t = renderFinding(f).join('\n')
    return f.items.length === 6 && /另 4 个/.test(t) && (t.match(/^ {6}· /gm) || []).length === 6
  })())
  push('--top 3 ⇒ 3 条 + 「另 7 个」（显式值优先于缺省与 --verbose）', (() => {
    const f = ratchetFinding(3)
    const t = renderFinding(f).join('\n')
    return f.items.length === 3 && /另 7 个/.test(t) && parseTop(['--top', '3', '--verbose']).value === 3
  })())
  push('--top 0 / --all ⇒ 全量 10 条、不出现「另 N 个」', (() => {
    const a = ratchetFinding(0), b = ratchetFinding(parseTop(['--all']).value)
    return a.items.length === 10 && b.items.length === 10 && !/另 \d+ 个/.test(renderFinding(a).join('\n'))
  })(), '全量口径走同一条渲染路径，否则"看全量"仍是另一种截断')
  push('--top 给错值 ⇒ 报错而不是静默截断（空值 / 非数字 / 后跟另一个开关）',
    ['--top=', '--top', '--top --all'].every((_, i) => {
      const argv = [['--top='], ['--top', 'x'], ['--top', '--all']][i]
      return parseTop(argv).err !== undefined
    }), '静默回落到缺省 = 我要全量却只看到 4 条，正是本单要治的形状')
  push('--verbose = 全部细节（摘要全打 + items 全量；不含 --verbose 时 items 仍截断）',
    parseTop(['--verbose']).value === 0 && parseTop([]).value === undefined)

  // skip 档的两头：skip=true 必须既不产违例也不算化石；skip 缺失时照旧判（防"恒不判"）
  push('度量带 skip ⇒ 该规则不判：零违例、也不把白名单条目判成化石', (() => {
    // 名单里是 forge-x，违例面故意给一个不在名单里的 forge-new ⇒ 不 skip 时必须红，skip 时既不许红也不许把 forge-x 报成化石
    const one = (skip) => evaluate([{ id: 'B5', value: 1, offenders: [{ k: 'forge-new' }], ...(skip ? { skip: true } : {}) }], { whitelist: { K1b: { 'forge-x': '自检：已知欠账' } }, ceiling: {} })
    const s = one(true), j = one(false)
    return s.findings.filter((f) => f.rule === 'K1b').length === 0 && s.stale.filter((f) => f.rule === 'K1b').length === 0 && j.findings.filter((f) => f.rule === 'K1b').length === 1
  })(), 'skip 与不 skip 的结果必须不同，否则这条判据是恒绿的')
  push('棘轮档也认 skip：不判时既不比上限也不报收线（防拿看不见的数收线）', (() => {
    const mkH8 = (skip) => ({ id: 'H8', value: skip ? '5 / 27' : '16 / 27', offenders: [], ...(skip ? { skip: true } : {}) })
    const cfg = { whitelist: {}, ceiling: { K3e: 5 } }
    const s = evaluate([mkH8(true)], cfg), j = evaluate([mkH8(false)], cfg)
    return s.findings.filter((f) => f.rule === 'K3e').length === 0 && s.lines.join('').includes('K3e') && j.findings.filter((f) => f.rule === 'K3e').length === 1
  })(), 'skip=true 不判、skip 缺失时 16>5 必须红')

  /* ── ISS-671 ①：基线过期判据 ──
     两头都要验（正控"该报就报" + 反控"不报的那几档"），否则「恒报过期」也能自洽通过。
     `now` 由这里注入 ⇒ 不依赖系统时钟，也不会因为日子过去而变红（本仓栽过按写作日期硬编码的时间炸弹）。 */
  const NOW = Date.parse('2026-11-04T12:00:00Z')
  const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString()
  push('过期正控：writtenAt 10 天前 ⇒ 报过期，且说清取自哪一级字段', (() => {
    const w = staleBaseline(baselineStamp({ writtenAt: daysAgo(10) }, NOW), NOW)
    return w && w.days === 10 && /取自 writtenAt/.test(w.text) && /10 天/.test(w.text)
  })())
  push('过期反控：writtenAt 3 天前 ⇒ 不报（阈值内不许响，长鸣的警告等于没有警告）', (() => {
    return staleBaseline(baselineStamp({ writtenAt: daysAgo(3) }, NOW), NOW) === null
  })())
  push('阈值边界：正好 7 天不报、8 天才报（差一格必须能分辨，否则阈值等于摆设', (() => {
    return staleBaseline(baselineStamp({ writtenAt: daysAgo(7) }, NOW), NOW) === null && staleBaseline(baselineStamp({ writtenAt: daysAgo(8) }, NOW), NOW) !== null
  })())
  push('兜底第二级：没有 writtenAt 时认 recordedAt（且文案标出来源，人不用猜）', (() => {
    const w = staleBaseline(baselineStamp({ recordedAt: daysAgo(10) }, NOW), NOW)
    return w && w.days === 10 && /取自 recordedAt/.test(w.text)
  })())
  push('writtenAt 优先于 recordedAt（机器时间更准；两格子都在时不许认错）', (() => {
    const w = staleBaseline(baselineStamp({ writtenAt: daysAgo(10), recordedAt: daysAgo(1) }, NOW), NOW)
    return w && w.days === 10 && /取自 writtenAt/.test(w.text)
  })())
  push('兜底第三级：两个字段都没有 ⇒ 用 mtime', (() => {
    const w = staleBaseline(baselineStamp({}, NOW - 10 * 86400000), NOW)
    return w && w.days === 10 && /取自 mtime/.test(w.text)
  })())
  push('失败安全：三级都拿不到 ⇒ 不报（不是"报过期"，也不是"当今天"）', (() => {
    return baselineStamp({}, undefined) === null && staleBaseline(null, NOW) === null
  })())
  push('写坏的日期当"拿不到"处理，不静默当今天', (() => {
    // recordedAt 写得离谱 ⇒ 退到 mtime；连 mtime 都没有 ⇒ null（既不报，也不冒充新鲜）
    const bad = baselineStamp({ recordedAt: '2026-13-45' }, undefined)
    return bad === null && baselineStamp({ recordedAt: '2026-13-45' }, NOW - 10 * 86400000)?.from === 'mtime'
  })())

  /* ── ISS-671 ②：定位判据的**分级**（本单最容易被糊过去的一处）──
     反控的意思是：要证明「强嫌疑」与「疑似」是**两个不同的值**，不是同一句话换词。
     只断言"有输出"是恒绿的假牙 —— 把 strength 写死成同一串也照样过。 */
  const winStub = (files, commits) => ({ anchor: 'a'.repeat(40), files: new Map(files), commitsById: new Map(commits), commits: commits.length })
  push('定位反控：blame 落到窗口外 ⇒ 只说「疑似」并写明「老违例被算进新增」', (() => {
    const win = winStub([['f.js', { sha: 'x'.repeat(40), short: 'xxxxxxx', date: '2026-11-03', subject: 's' }]], [['x'.repeat(40), { sha: 'x'.repeat(40), short: 'xxxxxxx', date: '2026-11-03', subject: 's' }]])
    // 该文件在窗口里被改过，但 metric 的 site 没有行号 ⇒ 只走文件级
    const r = attributeFinding('K9f', { sites: [{ k: 'f.js' }] }, win)
    return r.suspects.length === 1 && /疑似/.test(r.suspects[0].strength) && !/强嫌疑/.test(r.suspects[0].strength)
  })())
  push('定位：拿不到窗口 ⇒ suspects 空**且 note 说「无法定位」**（不许静默返回空数组）', (() => {
    const r = attributeFinding('K9f', { sites: [{ k: 'f.js', line: 1 }] }, { err: '不在 git 工作树内' })
    return r.suspects.length === 0 && /无法定位/.test(r.note) && /不在 git 工作树内/.test(r.note)
  })())
  push('定位：窗口内没有改动文件 ⇒ note 指向「度量射程/口径变了」而不是「没有新增」', (() => {
    const win = winStub([], [['y'.repeat(40), { sha: 'y'.repeat(40), short: 'yyyyyyy', date: '2026-11-03', subject: 's' }]])
    const r = attributeFinding('K9f', { sites: [{ k: 'other.js', line: 3 }] }, win)
    return r.suspects.length === 0 && /无法定位/.test(r.note) && /口径变了/.test(r.note)
  })())
  push('定位：聚合度量（无 sites）不许冒充已定位，note 必须说清只能到包级', (() => {
    const win = winStub([], [['y'.repeat(40), { sha: 'y'.repeat(40), short: 'yyyyyyy', date: '2026-11-03', subject: 's' }]])
    const r = attributeFinding('K10b', { offenders: [{ k: 'forge-pm' }] }, win)
    return r.suspects.length === 0 && /无法定位/.test(r.note) && /聚合计数/.test(r.note)
  })())
  push('定位：--top/渲染必须把 suspects 与 note 真打出来（字段对了但没打出 = 读者照样看不到）', (() => {
    const t = renderFinding({ rule: 'K9f', detail: 'd', items: [], itemsTotal: 0, suspects: [{ sha: 'abc1234', date: '2026-11-03', subject: 's', file: 'f.js', strength: '强嫌疑（blame 命中窗口内提交，1 行有据）' }], attrNote: '窗口 = x' }).join('\n')
    return /↳ abc1234/.test(t) && /强嫌疑/.test(t) && /⤷ 窗口 = x/.test(t)
  })())
  push('evaluate 的定位是**注入**的：不传 attr 时 findings 不带 suspects（自检不跑 git）', (() => {
    const r = evaluate([mk('D4', '17')], cfgR)
    return r.findings.length === 1 && r.findings[0].suspects === undefined
  })())
  push('evaluate 传了 attr ⇒ 定位结果真挂到 finding 上（防"注入了但没用"）', (() => {
    const r = evaluate([mk('D4', '17')], cfgR, undefined, () => ({ suspects: [{ sha: 'z' }], note: 'n' }))
    return r.findings.length === 1 && r.findings[0].suspects?.[0]?.sha === 'z' && r.findings[0].attrNote === 'n'
  })(), '注入点没生效的话，上面所有分级断言测的都是虚构路径')

  /* ISS-671：`fails` 必须在**最后一个 push 之后**才算 —— 上一版它在 skip 那两条之前就求值了，
     于是那两条（以及任何后加的用例）失败都不进退出码 ⇒ 自检打了一屏 ✗ 却 exit 0，
     guard 据此判绿。这正是本单要治的「守卫没牙」同款形态，顺手钉死在最后一行前。 */
  const fails = cases.filter((c) => !c.ok)
  console.log('lint-code --selftest（内建 fixture，不扫真实仓库）')
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.note ? '（' + c.note + '）' : ''}`)
  console.log(fails.length ? `\n✗ 反向验证失败 ${fails.length}/${cases.length} —— 门禁没牙，别接进 guard` : `\n✓ ${cases.length}/${cases.length} 项通过：三档规则各自能红能绿，化石、缺基线、判据失效都不静默`)
  return fails.length ? EXIT.VIOLATION : EXIT.CLEAN
}

/* ─────────────────────────── CLI ─────────────────────────── */

function main() {
  if (ARGV.includes('--selftest')) process.exit(selftest())

  /* ISS-674：`--top` 单独解析一次 —— 缺省值按档不同（零容忍 6 / 棘轮 4），
     所以 `undefined` 要能区分于 `0`；给了错值**直接红**，别静默回落成"前 4 条"。 */
  const topArg = parseTop(ARGV)
  if (topArg.err) {
    console.error(`✗ ${topArg.err}`)
    process.exit(EXIT.INTERNAL)
  }
  const top = topArg.value
  /* 两条轴各自语义单一（ISS-674 要求）：
     · `--top N` / `--all` 只管 **items 条数**（`0` = 全量）；不影响摘要行。
     · `--verbose` = 全部细节 ⇒ 两条轴一起放开（摘要全打 + items 全量），这才对得起名字。
       选"扩宽"而非"改名"：既有调用方已按"全部细节"理解它（`impact-of-diff` 的
       「--verbose 看全」就是同一口径），改名会让所有既有肌肉记忆失效；
       而当前"只多打几行摘要"恰恰是名字与行为不符的那一侧。 */
  ALL_DETAIL = ARGV.includes('--verbose')

  let metrics
  try {
    metrics = readMetrics()
  } catch (e) {
    console.error(`✗ 拿不到盘点结果：${e.message}`)
    process.exit(EXIT.INTERNAL)
  }
  const cfg = readCfg()

  if (ARGV.includes('--write')) {
    const whitelist = {}
    const ceiling = {}
    for (const r of RULES) {
      const m = metrics.find((x) => x.id === r.metric)
      if (!m) continue
      if (r.mode === 'whitelist') {
        const keep = {}
        for (const o of m.offenders || []) {
          const k = typeof o === 'string' ? o : o.k
          keep[k] = (cfg.whitelist[r.rule] && cfg.whitelist[r.rule][k]) || '待补'
        }
        whitelist[r.rule] = keep
      } else if (r.mode === 'ratchet') {
        const now = nthInt(m.value, r.take || 0)
        if (!Number.isNaN(now)) ceiling[r.rule] = now
      }
    }
    fs.writeFileSync(BASELINE, JSON.stringify(mergeBaseline(readBaselineRaw(), {
      recordedAt: new Date().toISOString().slice(0, 10),
      // ISS-671 ①：机器写入时刻。recordedAt 是人写的日期、可被回填；这个是脚本自己落的毫秒级时刻，
      // 过期判断优先认它。同一份基线里两个字段都在 = 两者都能查（人也核得出"哪天盘的"）。
      writtenAt: new Date().toISOString(),
      tool: 'lint-code.mjs --write',
      note: '判据算法在 scripts/code-inventory.mjs（唯一口径）；这里只存"允许哪些欠账 + 上限在哪"。白名单理由为占位符「待补」时门禁判红。',
      whitelist,
      ceiling,
    }), null, 1) + '\n')
    const todo = Object.values(whitelist).reduce((a, m) => a + Object.values(m).filter((w) => PLACEHOLDER_WHY.includes(String(w).trim())).length, 0)
    console.log(`✓ 已录：白名单 ${Object.keys(whitelist).length} 条规则 / 棘轮 ${Object.keys(ceiling).length} 条上限`)
    console.log(todo ? `  ⚠️ 有 ${todo} 条豁免理由是「待补」—— 那是要人写的，脚本不替你决定；没写完门禁会一直红` : '  ✓ 所有豁免都带理由')
    process.exit(EXIT.CLEAN)
  }

  const { findings, stale, missing, lines } = evaluate(metrics, cfg, top, attributionFor(metrics))
  const docText = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : ''
  for (const x of docDrift(RULES, docText)) missing.push(x)
  for (const x of headDrift(docText)) missing.push(x)
  // ISS-671 ①：过期只当警告（不进 findings / 不改退出码）。`--json` 里单列一档，免得机器读的人以为它红了。
  const staleWarn = staleBaseline(baselineStamp(readBaselineRaw(), baselineMtime(BASELINE)), Date.now())
  if (ARGV.includes('--json')) {
    console.log(JSON.stringify({ findings, stale, missing, baselineWarning: staleWarn ? staleWarn.text : null }, null, 1))
    process.exit(findings.length || stale.length || missing.length ? EXIT.VIOLATION : EXIT.CLEAN)
  }
  const judged = RULES.filter((r) => r.mode !== 'report').length
  console.log(`lint-code · 规则 ${RULES.length} 条（判 ${judged} · 只报 ${RULES.length - judged}）· 违例 ${findings.length} · 化石 ${stale.length} · 判据失效 ${missing.length}`)
  // ★ ISS-582：**测量缺口必须可见**。未入库的文件不参与测量（ISS-742 的有意设计），但输出里
  //   只有 `--md` 报告会点名 —— `--check` 读的人会把"缺口"误读成"代码变差"。
  //   实测教训：S1 拆 routes.js 时新文件未 `git add` ⇒ K10b 零引用导出假涨 14（420 → 434），
  //   一次独立审查据此把 high 记到了错的地方（真缺陷在别处）。
  if (TRACKED_MISSING.length > 0 || TRACKED_ALL) {
    console.log('')
    console.log(TRACKED_ALL
      ? '⚠️ 拿不到 git ⇒ 本次**未过滤未入库文件**，棘轮结论不完整'
      : `⚠️ 有 ${TRACKED_MISSING.length} 个文件**未入库、未参与测量** ⇒ 上面的棘轮数字**不完整**（缺口 ≠ 代码变差；先 git add 再跑）`)
    for (const f of TRACKED_MISSING.slice(0, 10)) console.log(`     · ${f}`)
    if (TRACKED_MISSING.length > 10) console.log(`     … 另 ${TRACKED_MISSING.length - 10} 个`)
  }
  for (const l of lines) if (ALL_DETAIL || /↓/.test(l)) console.log(l)
  for (const f of findings) for (const l of renderFinding(f)) console.log(l)
  for (const s of stale) console.log(`  ⚑ 名单化石 ${s.rule} → ${s.key}（原理由：${s.why}）—— 欠账清了就把条目删掉`)
  for (const x of missing) console.log(`  ✗ 判据失效 ${x.rule}/${x.metric}：${x.why}`)
  /* ISS-671 ①：过期警告打在最末，紧跟结论行 —— 它不是红的理由，但它是「上面那些新增该不该信」的前提。
     ⚠️ 不许挪进 findings：那会让退出码从 0 变 1，「基线旧了」就冒充成「代码坏了」。 */
  if (staleWarn) console.log(`\n⚠️ ${staleWarn.text}`)
  if (!findings.length && !stale.length && !missing.length) console.log('\n✓ 全部判据通过（棘轮未升、白名单未扩、无化石、判据都在跑）')
  else if (!findings.length && !missing.length) console.log('\n⚠️ 没有新增违例，但有化石要清（清掉再收工）')
  else console.log('\n✗ 有违例 —— 优先改代码；确要允许就在 baseline 里写理由，并在提交说明里点名扩了哪条')
  process.exit(findings.length || stale.length || missing.length ? EXIT.VIOLATION : EXIT.CLEAN)
}

if (process.argv[1] && /lint-code\.mjs$/.test(process.argv[1])) main()
