#!/usr/bin/env node
// scripts/gates/lint-jscpd.mjs
// jscpd 重复度判据（ISS-717）—— 把「跨文件复制粘贴」接进调度器，按**棘轮**判红。
//
// ## 为什么要有这条
//   本仓已有 `scripts/code-inventory.mjs` 的 D2/D3 度量（同名多份实现 / 跨文件复制粘贴函数簇），
//   经 `scripts/lint-code.mjs` 的 K 号门禁把关。那套是**AST 级、按函数粒度**的，判「哪些函数像复制品」。
//   jscpd 是**token 级、跨任意语句块**的，判「哪段代码在字面上重复」—— 两者射程不同，不是重复造轮子
//   （对照分析见基线文件 knownDefects.overlapWithCodeInventory）。
//   官方 DSH 把 jscpd 接在四个档上（`run-gates.ts` 的 ci-lint-contracts-ready / ci-unit / ci-static /
//   lint-and-duplication），是主门禁而非可选检查。
//
// ## 判据（新树零容忍，ISS-524）
//   J1/J2 新树（packages/*/*/src）克隆对数 `clones` **必须 === 0**（真扫，不是改形骗过）
//      · 任一对克隆 ⇒ 红，并**点名克隆对**（只说"多了 3 处"无处下手，等于没报）
//      · 基线不再判红，退为**清债记录**（`--write` 仍记账，供人看还债轨迹）
//   J3 改基线必须带非空 `--reason`（占位符不算），且 `--write` 必须 spread 旧对象
//   J4 口径锁为**常量**：`.jscpd.json` 的度量键 + 起点目录必须与本脚本锁定的零容忍口径一致。
//      换尺子（调大 minTokens / 改 ignore / 把起点改回旧树 forge-*）⇒ 红，不因数字变小而放绿。
//
//   为什么从棘轮改零容忍：旧树已冻结、存量已清到 0（ISS-524 先清债再切判据），棘轮的
//   "基线免死金牌"在新树没有存在的理由 —— 任一新增克隆都该当场拦住。
//
// ## 射程（ISS-524：新树零容忍，旧树 forge-* 冻结不扫）
//   `packages/*/*/src/**` 的 .ts/.tsx/.js（`.jscpd.json` 的 pattern + ignore 决定）。
//
//   ⚠️ **射程是「起点目录」×「配置」两层的乘积，缺一层就是假修（ISS-796 实测）**：
//     · 配置层：`.jscpd.json` 的 format/pattern 决定起点之内筛哪些后缀；
//     · 起点层：本脚本 `inferScope()` 决定把哪些目录交给 jscpd —— 起点之外的文件**根本不进遍历**。
//   洞 1 的真形态是两层同时缺：配置无 `javascript`/`.js`，起点又只传 `src`。
//   只补配置层时实测：注入一对相同 `.js` 到 `forge-pm/lib/` ⇒ 克隆数 217 → 217（纹丝不动）。
//   ⇒ 改口径必须**两层同改**，只改一层会被「数没变」误读成「补上了」。
//   另 9 个包只有 `lib/` 没有 `src/`（含 forge-messenger 63 个 `.js`），此前整包零覆盖。
//
//   ⚠️ 射程由 `.jscpd.json` 的 pattern 表达，**不是**靠本脚本拼参数排除 —— 排除必须写在配置里、
//   且在 diff 里看得见（「不许靠排除文件让判据变绿」）。
//   J4 的指纹把 `inferScope` 也纳入（`scopeFingerprint`）：改起点与改阈值同性质，
//   都是「换尺子」，不许靠换起点让数变小而不留痕。
//
// ## 用法
//   node scripts/gates/lint-jscpd.mjs              # 判（= --check）
//   node scripts/gates/lint-jscpd.mjs --json       # 机器读
//   node scripts/gates/lint-jscpd.mjs --selftest   # 反向验证：恒绿/恒红/判不了 三形态自检
//   node scripts/gates/lint-jscpd.mjs --measure    # 报实测数（不改基线、不判红）
//   node scripts/gates/lint-jscpd.mjs --write --reason "<为什么>"   # 刷新基线（必填理由）
//
// 退出码：0 绿 / 1 红线 / 2 判不了（jscpd 不在、配置读不动、输出解析不了）。
// **只读**：--check 不写任何文件（只有 --write 才写基线）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, '..', '..')
const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

/**
 * 零容忍口径（ISS-524）—— 判据自己持有"用哪把尺子"，不向基线/配置低头。
 *
 * J4 的**常量**形态：不再比"当前配置 vs 基线记录的配置"（那会比着比着一起漂移），而是比
 * "当前配置 vs 这里写死的零容忍口径"。改 minTokens / ignore / 起点目录任意一处都判红，
 * 且要求改本常量并说清理由 —— 换尺子是一次显式的、进 git 的决定，不是偷偷绕过门禁。
 */
const ZERO_TOLERANCE = Object.freeze({
  minTokens: 60,
  minLines: 6,
  mode: "mild",
  format: ["typescript", "tsx", "javascript"],
  pattern: "**/*.{ts,tsx,js}",
  ignore: ["**/node_modules/**", "**/dist/**", "**/.wt/**", "**/tests/**"],
  ignorePattern: ["(?s)/\\* jscpd:ignore-start \\*/.*?/\\* jscpd:ignore-end \\*/"],
})
const MEASURE_KEYS = ["minTokens", "minLines", "mode", "format", "pattern", "ignore", "ignorePattern"]
/** 新树起点：packages/<group>/<pkg>/src。旧树 forge-* 冻结，不进射程。 */
const ZERO_SCOPE = "packages/*/*/src"

const ARGV = process.argv.slice(2)
const optRepo = (() => {
  const i = ARGV.indexOf('--repo')
  return i >= 0 ? ARGV[i + 1] : null
})()

/**
 * 占位理由 = 还没想清楚凭什么改基线 ⇒ 判红。
 * 与 scripts/lint-code.mjs:40 及 scripts/gates/lint-oxlint.mjs 的 PLACEHOLDER_WHY 同口径：
 * 「什么算没写理由」在三个判据里必须是同一个答案，否则同一句话在一处算理由、另一处算占位。
 */
const PLACEHOLDER_WHY = ['', '待补', 'TODO', 'todo', '-', 'n/a']

/** 「判不了」都走 2，不冒充绿。 */
function unjudged(msg, detail) {
  return { status: 'unjudged', code: EXIT.INTERNAL, message: msg, detail }
}

/** 取 `--write --reason "<文字>"`。没给 = undefined（与「给了空串」区分：两种都该红，但文案不同）。 */
function takeReason() {
  const i = ARGV.indexOf('--reason')
  if (i >= 0) return ARGV[i + 1] ?? ''
  const eq = ARGV.find((a) => a.startsWith('--reason='))
  return eq === undefined ? undefined : eq.slice('--reason='.length)
}

/**
 * 找 jscpd 可执行文件。
 * ⚠️ 为什么不用 `node_modules/.bin/jscpd` 直接调：工作树的 `.bin` 可能是软链到主检出的
 * （ISS-504 之前是；之后是真目录，但不能假设）。逐个候选试，第一个存在的用它。
 *
 * ⚠️ 为什么要退回 DEFAULT_ROOT（`--selftest` 的合成树没有 node_modules）：
 * 判据会在**任意 root** 上跑（`--repo` 换根、selftest 造临时树）。若只在 `root` 下找，
 * 合成树永远查不到二进制 ⇒ 自检变成「每次都判不了」，那不比恒绿好多少（都是测不到真东西）。
 * 真实仓库里 root 就是本树，退回分支不会被用到；只有「被测树没有依赖」时才走它，
 * 而那种情形本来就该用**跑判据那台机器**装的工具去测它。
 */
function findJscpd(root) {
  // 显式覆盖口（`--selftest` 用它证明「找不到二进制 ⇒ 判不了」这条路真的走得到）。
  // 有它才能测「判不了」，没有它就永远测不到那条分支 —— 那等于那条判据没被验证过。
  if (process.env.JSCPD_BIN !== undefined) {
    const forced = process.env.JSCPD_BIN
    try {
      return forced && fs.existsSync(forced) ? forced : null
    } catch {
      return null
    }
  }
  const candidates = [
    path.join(root, 'node_modules', 'jscpd', 'run-jscpd.js'),
    path.join(root, 'node_modules', '.bin', 'jscpd'),
  ]
  // 退回本脚本所在的仓库（判据真正的家）
  candidates.push(path.join(DEFAULT_ROOT, 'node_modules', 'jscpd', 'run-jscpd.js'))
  candidates.push(path.join(DEFAULT_ROOT, 'node_modules', '.bin', 'jscpd'))
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* 悬空软链：existsSync 为 false 即跳过 */
    }
  }
  return null
}

/**
 * 跑一次 jscpd，返回 `{ clones, duplicatedLines, duplicatedTokens, lines, tokens, sources, percentage, duplicates }`
 * 或 `{ error }`。
 *
 * 为什么必须用 `--reporters json --output <tmpdir>`：
 *   console reporter 的表格是**给人看的**，解析它等于把判据绑死在 jscpd 的排版上
 *   （排版一改，判据恒绿 —— 正是 ISS-818 那一族事故的形态）。JSON 是它的公开产物。
 */
function runJscpd(root, cfgPath, scope) {
  const bin = findJscpd(root)
  if (!bin) return { error: 'jscpd-not-found' }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-gate-'))
  try {
    const args = [...scope, '--config', cfgPath, '--reporters', 'json', '--output', outDir]
    // jscpd 的 bin 是 `run-jscpd.js`（node 脚本），用当前 node 跑，避免依赖 shebang/执行位
    const r = spawnSync(process.execPath, [bin, ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60_000,
    })
    const reportPath = path.join(outDir, 'jscpd-report.json')
    if (!fs.existsSync(reportPath)) {
      // 报告没生成 = 没跑成。把 stderr 一并带出去，别让「跑失败」看起来像「零重复」。
      return {
        error: 'no-report',
        exitCode: r.status,
        stderr: (r.stderr ?? '').slice(0, 2000),
        stdout: (r.stdout ?? '').slice(0, 1000),
      }
    }
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    } catch (e) {
      return { error: 'unparsable-report', detail: String(e?.message ?? e) }
    }
    const st = parsed.statistics?.total
    if (!st || typeof st.clones !== 'number' || typeof st.duplicatedLines !== 'number') {
      return { error: 'missing-statistics', keys: Object.keys(parsed.statistics ?? {}) }
    }
    return {
      clones: st.clones,
      duplicatedLines: st.duplicatedLines,
      duplicatedTokens: st.duplicatedTokens,
      lines: st.lines,
      tokens: st.tokens,
      sources: st.sources,
      percentage: st.percentage,
      percentageTokens: st.percentageTokens,
      duplicates: parsed.duplicates ?? [],
    }
  } finally {
    try {
      fs.rmSync(outDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }
}

/**
 * 推导扫描射程（位置参数）。
 *
 * ⚠️ 为什么不能写死射程 glob：本仓射程是 forge-* 下的 src，但判据会在任意 root 上跑
 * （`--repo` 换根、`--selftest` 造临时树）。写死会让合成树永远扫不到东西 ⇒ 自检全判「判不了」，
 * 那等于自检测不到判据本身（比恒绿好不了多少）。
 *
 * 口径：**射程由配置表达**（.jscpd.json 的 pattern + ignore）。这里只负责挑「从哪个目录开始扫」：
 *   · root 下有 forge-* 包目录 ⇒ 逐个传各包的 `src` **与 `lib`**（本仓形态；枚举真实目录，不传 glob）
 *   · 否则 ⇒ 传 "."（合成树/外来树：让 pattern 自己去匹配）
 * 这样「扫什么」的唯一真相源仍是配置文件，代码只决定起点 —— 也符合「不许靠代码排除文件」的纪律。
 *
 * ⚠️ **`lib` 必须进起点（ISS-796）**：只传 `src` 时，`.jscpd.json` 里写多少个 `.js` 都没用 ——
 * jscpd 的位置参数是**起点目录**，起点之外的文件根本不进它的遍历，pattern 是在起点之内筛的。
 * 实测（改完三字段后仍不生效）：注入一对相同 `.js` 到 `forge-pm/lib/`，克隆数 **217 → 217** 纹丝不动；
 * 同一个探针直接对 `forge-pm/lib` 单独扫则是 **+1**（110 token 的克隆）。⇒ 光改 pattern 是**假修**。
 * 另有 9 个包只有 `lib/` 没有 `src/`（含 forge-messenger 63 个 `.js`），此前**整包零覆盖**。
 */
function inferScope(root) {
  try {
    // ⚠️ 必须**枚举真实目录**，不能传 glob 字面量：spawnSync 不经过 shell，`packages/*/*/src`
    // 会被 jscpd 当成一个真实路径 ⇒ `Error: path does not exist`（实测踩中）。
    // 新树形态：packages/<group>/<pkg>/src（ISS-524）。旧树 forge-* 冻结，不再扫。
    const groups = fs
      .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
    const dirs = []
    for (const g of groups) {
      for (const p of fs.readdirSync(path.join(root, 'packages', g.name), { withFileTypes: true })) {
        if (!p.isDirectory()) continue
        const src = path.join('packages', g.name, p.name, 'src')
        if (fs.existsSync(path.join(root, src))) dirs.push(src)
      }
    }
    return [...new Set(dirs)].sort()
  } catch {
    // 合成树 / 外来树没有 packages/ ⇒ 交 '.'，让配置里的 pattern 自己匹配（selftest 用）。
    return ['.']
  }
}

/** 把一个克隆对压成一行可读的键：`a.ts:10-20 ↔ b.ts:30-40`。 */
function cloneKey(d) {
  const f = (x) => `${x?.name ?? '?'}:${x?.start ?? '?'}-${x?.end ?? '?'}`
  return `${f(d.firstFile)} ↔ ${f(d.secondFile)}`
}

/**
 * 克隆的**身份**：`format|文件名A|文件名B|片段内容哈希`。
 *
 * 为什么用内容哈希而不是片段全文（ISS-796）：749 个克隆时全文形式让基线涨到 344KB，
 * 哈希形式 52KB（6.7×）。基线是**要进 git、每次改口径都要人读 diff** 的文件，
 * 体积本身就是维护成本。哈希只用于**同一性比较**（这段重复是不是同一段），不用于展示 ——
 * 展示仍走 `cloneKey()` 的行号标签，人看的是那个。
 *
 * ⚠️ 为什么不是行号：行号会随上方代码增删整体位移，拿它当身份等于把「上面插了一行」
 * 报成「新增重复」（全是假阳性）。文件名 + 内容哈希对位移免疫，只对「内容真变了」敏感。
 */
function cloneId(d) {
  const h = createHash('sha256').update(String(d.fragment ?? '')).digest('hex').slice(0, 16)
  return `${d.format}|${d.firstFile?.name}|${d.secondFile?.name}|${h}`
}

/**
 * 判三条。
 *
 * J1/J2 用「基线记数 + 当前实测」比较；J3 用 `lastWrite.reason`。
 *
 * ── 关于「点名新增克隆对」的分寸 ──────────────────────────────────────
 * 克隆对的**位置**会随上方代码增删而整体位移，所以不能拿「位置字符串」当身份
 * （那会把「上面插了一行」报成「这处重复是新增的」—— 全是假阳性）。
 * 身份取 `format + 两侧文件名 + 片段内容的哈希`：只有**同一段重复内容**才算同一个克隆。
 * 这仍然是近似（片段移动了但内容没变会被认成同一个，这是想要的），但比位置稳得多。
 */
function judge(root) {
  const cfg = path.join(root, '.jscpd.json')
  if (!fs.existsSync(cfg)) return unjudged('.jscpd.json 不在 ⇒ 配置缺失时 jscpd 会退回默认阈值，跑出来的数不是本判据要判的数', cfg)

  const res = runJscpd(root, cfg, inferScope(root))
  if (res.error === 'jscpd-not-found') return unjudged('本机没有 jscpd 可执行文件（node_modules 未装/未镜像）⇒ 没跑，不记绿')
  if (res.error) return unjudged(`jscpd 没跑成（${res.error}）⇒ 不记绿`, JSON.stringify(res).slice(0, 1500))

  const basePath = path.join(root, 'scripts', 'baseline', 'jscpd.json')
  if (!fs.existsSync(basePath)) {
    return unjudged(`基线不在：${path.relative(root, basePath)} ⇒ 没有基线就不判（不冒充绿：那等于这条门禁默认关着）`)
  }
  let base
  try {
    base = JSON.parse(fs.readFileSync(basePath, 'utf8'))
  } catch (e) {
    return unjudged(`基线读不动：${e?.message ?? e}`, basePath)
  }

  // J4：口径**锁为常量**（ISS-524 零容忍）—— .jscpd.json 的度量键 + 起点目录必须与
  // 本脚本写死的 ZERO_TOLERANCE / ZERO_SCOPE 一致。
  //
  // ── 为什么不再跟基线比（旧形态的洞）────────────────────────────
  // 旧形态比「当前配置 vs 基线记录的配置」，而基线可被 `--write` 改 ⇒ 调大 minTokens
  // 让克隆 108→10 再顺手改基线，判据判绿、业务代码一行没动（把体温计换刻度，不是退烧）。
  // 零容忍下基线退为清债记录、不再参与判红，尺子必须有个不会跟着漂移的家 —— 就是本常量。
  // 改口径 ⇒ 改这里（一次显式的、进 git 的决定），否则判红。
  const cfgRaw = fs.readFileSync(cfg, 'utf8')
  let cfgObj
  try {
    cfgObj = JSON.parse(cfgRaw)
  } catch (e) {
    return unjudged(`.jscpd.json 解析不了（${e?.message ?? e}）⇒ 判不了`, cfg)
  }
  // 逐键比当前配置与锁定常量，报出到底改了哪个键（只说「配置变了」读者还得自己 diff）。
  const cfgChanged = MEASURE_KEYS
    .filter((k) => JSON.stringify(cfgObj[k] ?? null) !== JSON.stringify(ZERO_TOLERANCE[k] ?? null))
    .map((k) => `${k}: ${JSON.stringify(cfgObj[k] ?? null)} → 应为 ${JSON.stringify(ZERO_TOLERANCE[k] ?? null)}`)

  // 起点也是尺子的一半：inferScope 必须交出 packages/*/*/src（新树），交出 forge-*（旧树）
  // 或空清单 ⇒ 判红，不因数变小而放绿。合成树（无 packages/）走 '.'，仅 selftest 用，不属生产射程。
  const scopeDirs = inferScope(root)
  const scopeFingerprint = JSON.stringify([...scopeDirs].sort())
  const scopeIsNewTree = scopeDirs.length > 0 && scopeDirs.every((d) => d.startsWith('packages/') && d.endsWith('/src'))
  const scopeChanged = scopeIsNewTree ? null : [`射程起点应为 ${ZERO_SCOPE}（packages/*/*/src），实得 ${scopeFingerprint}`]
  const rulerChanged = [...cfgChanged, ...(scopeChanged ?? [])]
  const cfgChangedOut = rulerChanged.length ? rulerChanged : null

  const baseLines = Number(base.duplicatedLines)
  const baseClones = Number(base.clones)
  if (!Number.isFinite(baseLines) || baseLines < 0) return unjudged(`基线的 duplicatedLines 不是非负数字（收到 ${JSON.stringify(base.duplicatedLines)}）⇒ 判不了`, basePath)
  if (!Number.isFinite(baseClones) || baseClones < 0) return unjudged(`基线的 clones 不是非负数字（收到 ${JSON.stringify(base.clones)}）⇒ 判不了`, basePath)

  // 点名当前所有克隆对（零容忍下每一对都是要清的债）。
  const current = res.duplicates.map((d) => ({ id: cloneId(d), label: cloneKey(d) }))
  const addedClones = current.map((c) => c.label)

  // J3 仍守基线治理字段（清债记录也要可信理由），但基线数字不再参与判红。
  let writeReasonProblem = null
  const lw = base.lastWrite
  if (lw) {
    const r = typeof lw.reason === 'string' ? lw.reason : ''
    if (!r.trim()) writeReasonProblem = 'lastWrite.reason 为空'
    else if (PLACEHOLDER_WHY.includes(r.trim())) writeReasonProblem = `lastWrite.reason 是占位符（${JSON.stringify(r)}）`
  }

  const clonesZero = res.clones === 0
  const failed = !clonesZero || writeReasonProblem !== null || cfgChangedOut !== null
  // 下面两字段只供文案展示；零容忍下判红只看 clones===0 / 口径 / 基线治理字段。
  const linesOver = clonesZero ? 0 : res.duplicatedLines
  const clonesOver = clonesZero ? 0 : res.clones

  return {
    status: failed ? 'failed' : 'passed',
    code: failed ? EXIT.VIOLATION : EXIT.CLEAN,
    // 实测值
    duplicatedLines: res.duplicatedLines,
    clones: res.clones,
    percentage: res.percentage,
    duplicatedTokens: res.duplicatedTokens,
    lines: res.lines,
    tokens: res.tokens,
    sources: res.sources,
    // 基线值
    baseLines,
    baseClones,
    // 差值（>0 = 涨了）
    linesOver,
    clonesOver,
    addedClones,
    writeReasonProblem,
    cfgChanged: cfgChangedOut,
    lastWrite: lw ?? null,
    // 下降量（>0 = 有还债空间，提示降基线）
    paydownLines: baseLines - res.duplicatedLines,
    paydownClones: baseClones - res.clones,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// --measure：报实测数（不改基线、不判红）。ISS-717 的交付证据要的是这一组。
// ─────────────────────────────────────────────────────────────────────────────
function measure(root) {
  const cfg = path.join(root, '.jscpd.json')
  if (!fs.existsSync(cfg)) return unjudged('.jscpd.json 不在 ⇒ 量不了', cfg)
  const res = runJscpd(root, cfg, inferScope(root))
  if (res.error) return unjudged(`量不了：${res.error}`, JSON.stringify(res).slice(0, 1500))
  return {
    status: 'measured',
    code: EXIT.CLEAN,
    duplicatedLines: res.duplicatedLines,
    clones: res.clones,
    duplicatedTokens: res.duplicatedTokens,
    percentage: res.percentage,
    percentageTokens: res.percentageTokens,
    lines: res.lines,
    tokens: res.tokens,
    sources: res.sources,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// --selftest：四种形态（review-gate 的硬要求）
//   ① 恒绿检测：造必然有重复的合成树 ⇒ 必须红（证明判据不是恒绿）
//   ② 恒红检测：造零重复的合成树 ⇒ 必须绿（证明判据不是恒红）
//   ③ 判不了不当绿：jscpd 不在 / 配置缺失 / 基线不在 ⇒ exit 2
//   ④ --write 保治理字段：spread 旧对象，不抹掉五个治理字段（b3cdc55a 修的 bug，别重挖）
// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const cases = []
  const eq = (name, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected)
    cases.push({ name, pass, actual, expected })
  }

  // ① 零容忍判据层（纯函数）：clones===0 才绿，任何克隆 ⇒ 红
  const verdict = (clones) => (clones === 0 ? 'passed' : 'failed')
  eq('零容忍：0 克隆 ⇒ 绿', verdict(0), 'passed')
  eq('零容忍：1 克隆 ⇒ 红', verdict(1), 'failed')
  eq('零容忍：20 克隆 ⇒ 红', verdict(20), 'failed')

  const root = optRepo ? path.resolve(optRepo) : DEFAULT_ROOT
  const bin = findJscpd(root)
  if (!bin) {
    cases.push({ name: '合成树（本机无 jscpd ⇒ 跳过，不记绿）', pass: true, skipped: true })
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-selftest-'))
    try {
      // 合成树用**真实形态**：packages/<g>/<p>/src + 锁定口径 .jscpd.json + 基线 0。
      // 这样 judge() 的 J4 常量比对与起点检查都走真路径，而不是靠放宽 selftest 特例。
      const srcRel = path.join('packages', 'g', 'p', 'src')
      fs.mkdirSync(path.join(tmp, srcRel), { recursive: true })
      const lockedCfg = { ...ZERO_TOLERANCE, reporters: ['console'], exitCode: 1, noColors: true, noTips: true }
      const writeCfg = (obj) => fs.writeFileSync(path.join(tmp, '.jscpd.json'), JSON.stringify(obj))
      writeCfg(lockedCfg)
      const writeBase = (obj) => {
        fs.mkdirSync(path.join(tmp, 'scripts', 'baseline'), { recursive: true })
        fs.writeFileSync(path.join(tmp, 'scripts', 'baseline', 'jscpd.json'), JSON.stringify(obj))
      }
      writeBase({ duplicatedLines: 0, clones: 0, lastWrite: { reason: 'selftest 基线' } })

      // 一段够长的重复（minTokens 60）：同一段逻辑两个文件 ⇒ 必构成克隆
      const chunk = `
export function computeTotalA(items: Array<{ price: number; qty: number; tax: number }>): number {
  let subtotal = 0
  for (const item of items) {
    subtotal += item.price * item.qty
  }
  let taxAmount = 0
  for (const item of items) {
    taxAmount += item.price * item.qty * item.tax
  }
  const shipping = subtotal > 100 ? 0 : 8
  return subtotal + taxAmount + shipping
}
`
      fs.writeFileSync(path.join(tmp, srcRel, 'a.ts'), chunk)
      fs.writeFileSync(path.join(tmp, srcRel, 'b.ts'), chunk.replace('computeTotalA', 'computeTotalB'))

      // ② 恒绿检测：有重复 ⇒ 实测 > 0，且判红（判据对重复有牙）
      const dupRes = runJscpd(tmp, path.join(tmp, '.jscpd.json'), [srcRel])
      eq('恒绿检测：有重复 ⇒ 实测克隆数 > 0', dupRes.clones > 0, true)
      eq('恒绿检测：有重复 + 零容忍 ⇒ 判红', judge(tmp).status, 'failed')
      eq('恒绿检测：判红时点名克隆对', judge(tmp).addedClones.length > 0, true)

      // ② D1 配置层：format 含 javascript 才解析 .js（真 jscpd，先证伪再证真）
      const jsChunk = `
export function computeJsA(items) {
  let subtotal = 0
  let taxAmount = 0
  for (const item of items) {
    subtotal += item.price * item.qty
    taxAmount += item.price * item.qty * item.tax
  }
  const total = subtotal + taxAmount
  return { ok: true, total }
}
`
      fs.writeFileSync(path.join(tmp, srcRel, 'j1.js'), jsChunk)
      fs.writeFileSync(path.join(tmp, srcRel, 'j2.js'), jsChunk.replace('computeJsA', 'computeJsB'))
      // D1 探针用 minTokens 40（只为证明 format 这个键有牙；与生产锁定的 60 无关）
      const oldCfgPath = path.join(tmp, '.jscpd-old.json')
      fs.writeFileSync(oldCfgPath, JSON.stringify({ ...ZERO_TOLERANCE, minTokens: 40, format: ['typescript', 'tsx'], pattern: '**/*.{ts,tsx}' }))
      const newCfgPath = path.join(tmp, '.jscpd-js.json')
      fs.writeFileSync(newCfgPath, JSON.stringify({ ...ZERO_TOLERANCE, minTokens: 40 }))
      const jsOld = runJscpd(tmp, oldCfgPath, [srcRel])
      const jsNew = runJscpd(tmp, newCfgPath, [srcRel])
      const jsTouches = (res) => (res.duplicates ?? []).some((d) => /\.js$/.test(d.firstFile?.name ?? '') || /\.js$/.test(d.secondFile?.name ?? ''))
      eq('D1 反证：format 无 javascript ⇒ 没有克隆涉及 .js', jsTouches(jsOld), false)
      eq('D1 正证：format 含 javascript ⇒ 出现涉及 .js 的克隆（不是恒 false）', jsTouches(jsNew), true)
      fs.rmSync(path.join(tmp, srcRel, 'j1.js'))
      fs.rmSync(path.join(tmp, srcRel, 'j2.js'))

      // ② D2 起点层：inferScope 只交 packages/*/*/src，缺了就扫不到
      eq('D2 正证：inferScope 在 packages 树返回 src 起点', JSON.stringify(inferScope(tmp)), JSON.stringify([srcRel]))
      const noPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-nopkg-'))
      try {
        eq('D2 反证：无 packages/ 的合成树起点回落 .（仅 selftest 用）', JSON.stringify(inferScope(noPkg)), JSON.stringify(['.']))
      } finally {
        fs.rmSync(noPkg, { recursive: true, force: true })
      }

      // ② 恒红检测：把 b.ts 改成各不相同 ⇒ 0 克隆 ⇒ 绿
      fs.writeFileSync(path.join(tmp, srcRel, 'b.ts'), `
export function computeTotalB(items: Array<{ price: number; qty: number }>): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0) * 2
}
`)
      eq('恒红检测：零重复 ⇒ 判绿（判据不是恒红）', judge(tmp).status, 'passed')

      // ③ 判不了不当绿：配置缺失 / 基线缺失 / jscpd 不在
      fs.rmSync(path.join(tmp, '.jscpd.json'))
      eq('判不了：配置缺失 ⇒ exit 2', judge(tmp).code, EXIT.INTERNAL)
      writeCfg(lockedCfg)
      fs.rmSync(path.join(tmp, 'scripts', 'baseline', 'jscpd.json'))
      eq('判不了：基线缺失 ⇒ exit 2', judge(tmp).code, EXIT.INTERNAL)
      writeBase({ duplicatedLines: 0, clones: 0, lastWrite: { reason: 'selftest 基线' } })
      const savedBin = process.env.JSCPD_BIN
      process.env.JSCPD_BIN = path.join(tmp, 'definitely-not-here', 'jscpd')
      const noBin = judge(tmp)
      if (savedBin === undefined) delete process.env.JSCPD_BIN
      else process.env.JSCPD_BIN = savedBin
      eq('判不了：jscpd 不在 ⇒ exit 2', noBin.code, EXIT.INTERNAL)
      eq('判不了：文案说清「没装」而非「没问题」', /没有 jscpd|没跑/.test(noBin.message ?? ''), true)

      // J4 常量对照：改口径 ⇒ 红且点名键；起点改回旧树 ⇒ 红；还原 ⇒ 绿
      writeCfg({ ...lockedCfg, minTokens: 200 })
      const vBad = judge(tmp)
      eq('J4 反向：minTokens 60→200 ⇒ 判红', vBad.status, 'failed')
      eq('J4 反向：点名 minTokens', vBad.cfgChanged?.some((x) => x.includes('minTokens')), true)
      writeCfg({ ...lockedCfg, ignore: [] })
      eq('J4 反向：去掉 ignore（放宽射程）⇒ 判红', judge(tmp).status, 'failed')
      writeCfg(lockedCfg)
      eq('J4 正对照：还原锁定口径 ⇒ 绿（不是恒红）', judge(tmp).status, 'passed')

      // J3：清债记录的 lastWrite.reason 为空/占位 ⇒ 红；真实理由 ⇒ 绿
      writeBase({ duplicatedLines: 0, clones: 0, lastWrite: { reason: '' } })
      eq('J3 反向：lastWrite.reason 为空 ⇒ 判红', judge(tmp).status, 'failed')
      writeBase({ duplicatedLines: 0, clones: 0, lastWrite: { reason: 'TODO' } })
      eq('J3 反向：占位符 ⇒ 判红', judge(tmp).status, 'failed')
      writeBase({ duplicatedLines: 0, clones: 0, lastWrite: { reason: 'ISS-524 清债记录' } })
      eq('J3 正对照：真实理由 ⇒ 绿', judge(tmp).status, 'passed')

      // ④ --write 保治理字段 + 强制理由
      writeBase({
        duplicatedLines: 0,
        clones: 0,
        provenance: { recordedAt: '2026-11-08', recordedBy: 'selftest' },
        whyThisNumber: { whyNotZero: '存量不可一次清零' },
        antiGaming: { rule: '不许靠排除文件变绿' },
        knownDefects: { overlap: '与 code-inventory D2/D3 射程不同' },
        measure: { clones: 0, duplicatedLines: 0 },
      })
      const saved = ARGV.slice()
      ARGV.push('--reason', '--selftest 用的正常理由')
      const wrc = writeBaseline(tmp)
      ARGV.length = 0
      ARGV.push(...saved)
      eq('--write --reason 正常理由 ⇒ 成功', wrc, EXIT.CLEAN)
      const after = JSON.parse(fs.readFileSync(path.join(tmp, 'scripts', 'baseline', 'jscpd.json'), 'utf8'))
      eq('--write 保 provenance', typeof after.provenance, 'object')
      eq('--write 保 whyThisNumber', typeof after.whyThisNumber, 'object')
      eq('--write 保 antiGaming', typeof after.antiGaming, 'object')
      eq('--write 保 knownDefects', typeof after.knownDefects, 'object')
      eq('--write 保 measure', typeof after.measure, 'object')
      eq('--write 记下 lastWrite.reason', after.lastWrite?.reason, '--selftest 用的正常理由')
      const runWriteWith = (reason) => {
        const s = saved.slice()
        ARGV.length = 0
        ARGV.push(...s, '--reason', reason)
        const rc = writeBaseline(tmp)
        ARGV.length = 0
        ARGV.push(...s)
        return rc
      }
      eq('--write 理由空白 ⇒ 拒（exit 1）', runWriteWith('   '), EXIT.VIOLATION)
      eq('--write 理由占位符 ⇒ 拒（exit 1）', runWriteWith('待补'), EXIT.VIOLATION)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  const fail = cases.filter((c) => !c.pass)
  if (ARGV.includes('--json')) {
    console.log(JSON.stringify({ selftest: true, pass: cases.length - fail.length, total: cases.length, cases }, null, 1))
  } else {
    console.log('lint-jscpd --selftest（新树零容忍）')
    for (const c of cases) {
      console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.skipped ? '（跳过）' : ''}`)
      if (!c.pass) console.log(`      actual=${JSON.stringify(c.actual)} expected=${JSON.stringify(c.expected)}`)
    }
    console.log(`\n${fail.length ? '✗ 自检失败' : '✓ 自检通过'}：${cases.length - fail.length}/${cases.length}`)
  }
  return fail.length ? EXIT.VIOLATION : EXIT.CLEAN
}

/**
 * --write：刷新基线的**数值部分**。
 * 两条纪律（与 lint-oxlint.mjs 同源，b3cdc55a 的教训）：
 *   ① spread 旧对象 —— 治理字段是人写的判断，机器不该覆盖
 *   ② 必须 --reason，占位符不算 —— 改基线是「重新定义什么叫可接受」，不是纯数字动作
 */
function writeBaseline(root) {
  const cfg = path.join(root, '.jscpd.json')
  if (!fs.existsSync(cfg)) return unjudged('.jscpd.json 不在 ⇒ 写不了基线', cfg)

  const reason = takeReason()
  if (reason === undefined) {
    console.log('✗ --write 必须带理由：--write --reason "<为什么改基线>"')
    console.log('  为什么：改基线是「重新定义什么叫可接受」，不是一个纯数字动作。')
    console.log('  写什么：这次改是还债（重复消除了）、补漏（原先漏扫的现在扫到了）、还是新增豁免（谁批的）。')
    return EXIT.VIOLATION
  }
  if (PLACEHOLDER_WHY.includes(String(reason).trim())) {
    console.log(`✗ --write 的理由是占位符（${JSON.stringify(reason)}）⇒ 不算理由`)
    console.log('  占位符表与 scripts/lint-code.mjs:40 同口径：' + JSON.stringify(PLACEHOLDER_WHY))
    return EXIT.VIOLATION
  }

  const res = runJscpd(root, cfg, inferScope(root))
  if (res.error) return unjudged(`跑不成 jscpd（${res.error}）⇒ 不写基线（不拿空数据覆盖真基线）`)

  // J4 的另一半：--write 必须把「当前用的是哪把尺子」一起记进基线，
  // 否则下次无从判断「数变了是因为代码变了，还是因为尺子变了」。
  const cfgObj = JSON.parse(fs.readFileSync(cfg, 'utf8'))
  const measureKeys = ['minTokens', 'minLines', 'mode', 'format', 'pattern', 'ignore', 'ignorePattern']
  const cfgSnapshot = Object.fromEntries(measureKeys.map((k) => [k, cfgObj[k] ?? null]))
  const cfgFingerprint = JSON.stringify(measureKeys.map((k) => [k, cfgObj[k] ?? null]))
  // 起点目录同记（ISS-796）：见 judge() 里 scopeFingerprint 的注释 —— 起点也是尺子。
  const scopeFingerprint = JSON.stringify([...inferScope(root)].sort())

  const basePath = path.join(root, 'scripts', 'baseline', 'jscpd.json')
  let prev = {}
  if (fs.existsSync(basePath)) {
    try {
      prev = JSON.parse(fs.readFileSync(basePath, 'utf8'))
    } catch {
      return unjudged('旧基线读不动 ⇒ 不写（盲写会把人写的治理字段覆盖成空）', basePath)
    }
  }
  const prevLines = Number(prev.duplicatedLines)
  const prevClones = Number(prev.clones)

  const out = {
    ...prev, // ← 治理字段（provenance / whyThisNumber / antiGaming / knownDefects / measure）靠这一行活下来
    duplicatedLines: res.duplicatedLines,
    clones: res.clones,
    duplicatedTokens: res.duplicatedTokens,
    percentage: res.percentage,
    lines: res.lines,
    tokens: res.tokens,
    sources: res.sources,
    // 指纹：供下次「点名新增克隆对」用。拿 format+两侧文件名+片段内容**哈希** 当身份，
    // 不用位置（位置会随上方代码增删漂移，拿它当身份等于把「上面插一行」报成「新增重复」）。
    cloneFingerprints: res.duplicates.map((d) => ({ id: cloneId(d), label: cloneKey(d) })),
    // 「用哪把尺子量的」—— 与数一起记。J4 靠它判断尺子有没有被换过。
    config: cfgSnapshot,
    configFingerprint: cfgFingerprint,
    // 起点目录指纹（ISS-796）：改 inferScope 与改 minTokens 同性质，都要留痕。
    scopeFingerprint,
    lastWrite: {
      at: new Date().toISOString(),
      by: process.env.USER ?? 'unknown',
      reason,
      from: Number.isFinite(prevLines) ? { duplicatedLines: prevLines, clones: prevClones } : null,
      to: { duplicatedLines: res.duplicatedLines, clones: res.clones },
      delta: Number.isFinite(prevLines)
        ? { duplicatedLines: res.duplicatedLines - prevLines, clones: res.clones - prevClones }
        : null,
    },
  }
  fs.writeFileSync(basePath, JSON.stringify(out, null, 2) + '\n')
  console.log(`✓ 已写基线：${res.clones} 处克隆 / ${res.duplicatedLines} 行重复（${res.percentage.toFixed(2)}%）`)
  console.log(`  理由已记账：${reason}`)
  console.log('  治理字段（provenance/whyThisNumber/antiGaming/knownDefects/measure）原样保留')
  return EXIT.CLEAN
}

function main() {
  const root = optRepo ? path.resolve(optRepo) : DEFAULT_ROOT
  if (ARGV.includes('--selftest')) return selftest()

  if (ARGV.includes('--measure')) {
    const m = measure(root)
    if (ARGV.includes('--json')) {
      console.log(JSON.stringify(m, null, 1))
      return m.code
    }
    if (m.status === 'unjudged') {
      console.log(`! 量不了：${m.message}`)
      if (m.detail) console.log(`  ${m.detail}`)
      return m.code
    }
    console.log('jscpd 实测（ISS-717）')
    console.log(`  克隆对     ${m.clones} 处`)
    console.log(`  重复行     ${m.duplicatedLines} / ${m.lines}（${m.percentage.toFixed(2)}%）`)
    console.log(`  重复 token ${m.duplicatedTokens} / ${m.tokens}（${m.percentageTokens.toFixed(2)}%）`)
    console.log(`  扫描文件   ${m.sources}`)
    return m.code
  }

  if (ARGV.includes('--write')) return writeBaseline(root)

  const r = judge(root)
  if (ARGV.includes('--json')) {
    console.log(JSON.stringify(r, null, 1))
    return r.code
  }
  if (r.status === 'unjudged') {
    console.log(`! J1 判不了：${r.message}`)
    if (r.detail) console.log(`  ${r.detail}`)
    return r.code
  }
  if (r.status === 'passed') {
    console.log(`✓ J1/J2 新树零容忍：packages/*/*/src 克隆 ${r.clones} === 0 · 重复行 ${r.duplicatedLines}（${r.percentage.toFixed(2)}%）`)
    return EXIT.CLEAN
  }
  // 红分三种：克隆非零 / 口径被换 / 基线治理字段没理由。分开报 —— 混一起会让人去修错的地方。
  if (r.clones > 0) {
    console.log(`✗ J1/J2 新树零容忍：克隆 ${r.clones} ≠ 0（重复行 ${r.duplicatedLines}）—— 必须清到 0，不许改形骗过`)
    if (r.addedClones.length) {
      console.log('  待清的克隆对：')
      for (const a of r.addedClones.slice(0, 10)) console.log(`    + ${a}`)
      if (r.addedClones.length > 10) console.log(`    … 另有 ${r.addedClones.length - 10} 处`)
    }
  }
  if (r.cfgChanged) {
    console.log('✗ J4 口径被换过（非零容忍锁定值）—— 尺子不许偷偷改：')
    for (const d of r.cfgChanged) console.log(`    - ${d}`)
    console.log('  为什么这条是红线：J1/J2 判的是「克隆 === 0」，而数由射程+阈值共同决定。')
    console.log('  调大 minTokens / 改 ignore / 起点改回旧树 forge-* 都能让数变小，而业务代码一行没动。')
    console.log('  要改口径只能显式改本脚本的 ZERO_TOLERANCE / ZERO_SCOPE 常量（进 git、说清理由）。')
  }
  if (r.writeReasonProblem) {
    console.log(`✗ J3 基线（清债记录）治理字段没有可信理由：${r.writeReasonProblem}`)
    console.log('  两条出路：① 补一次 --write --reason "<说明>"  ② 把改动退回去')
  }
  return EXIT.VIOLATION
}

process.exit(main())
