#!/usr/bin/env node
// scripts/preset-var-check.mjs
// 预设提示词变量守卫（ISS-615）：预设人设里写的 `{{变量}}` 必须真在**这台机器装的引擎**里注册过。
//
// ## 为什么要有这一条（2026-10-18 事故 · 同类第二次）
//   老板新设的三个预设（builder / reviewer / designer）**全部不可用**：任何一次委派立刻失败，
//   而全部门禁绿着、没有任何东西报警。引擎原文（子会话 `3429b1de` 的 `turn/end`）：
//     unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
//     registered variables: provider, model
//   根因：人设后缀写了 `当前工作目录 {{cwd}}`，而引擎对 `{{…}}` 做**严格插值**
//   （`@deepseek-ai/dsh-system-prompt` 的 `interpolate()`：未注册的名字直接抛错 ⇒ **整份预设装配失败**）。
//   该配置文件自己的注释还自承旧 `preset-review` 也「自建立起一直 broken 没人发现」—— 同一个形态。
//
// ## 与 scripts/preset-parity-check.mjs 的分工（两层，互不替代）
//   它管「**抄得对不对**」：home 预设的插件行与官方 `standard` 逐行对账（漂移即红）。
//   本件管「**跑不跑得起来**」：人设里引用的变量，引擎注册表里有没有。
//   插件行一字不差、人设里多写一个 `{{cwd}}`，预设照样整份不可用 —— 上一版守卫只能看住前者。
//
// ## 白名单从哪来（本判据的命门：不许硬编码）
//   引擎注册提示词变量的唯一入口是 `systemPrompt.variable("名字", …)`，本守卫**机械扫描**求并集：
//     ① 本 home 的引擎安装树 `<home>/profiles/node_modules/@deepseek-ai/*`（每个包的 host JS）；
//     ② 配置里声明、且在本 home 安装得到（`<home>/profiles/node_modules/<name>`）的插件包。
//   ⇒ **引擎将来新增变量，白名单自动跟着长**，不需要改本文件。
//   ⚠️ 为什么不去读 `~/dsh-src`（引擎源码浅克隆）：**版本会骗人**。本机 `~/dsh-src` 停在 0.2.0-rc.2，
//     它的 `dsh-agent-loop` 仍注册 `cwd`（实测 3 处）—— 照它判，**本次事故会被判成绿**。
//     真相只在**这台机器实际装的那一份**（实测：本机 `~/.dsh-matter` 的引擎 = 0.2.1-rc.2，只有
//     provider / model；`~/.dsh` 的引擎 = 0.1.1-rc.2，还带着 cwd ⇒ 同一份配置在两处一红一绿，
//     所以白名单必须**按 home 解析**，不能抄一个常量）。
//
// ## 失效模式（诚实写明，不冒充「已判过」）
//   · 引擎若换掉注册 API（不再出现 `systemPrompt.variable(` 字面量）⇒ 扫描得到**空**白名单。
//     那时判「**不判**」并打印扫了多少文件，而**不是**判红（不拿"扫不到"当"引擎没注册"）。
//   · 某个插件用别的机制注入变量 ⇒ 本守卫看不见 ⇒ 可能**误报红**；修法是把该包根加进 `--engine-root`。
//   · 现场有 `{{…}}` 跨行（引号内换行）时本守卫不判 —— 引擎按**整段**插值，理论上可跨行。
//   · `!!js` 值里的 `{{…}}` 也照判（它若真进了提示词，一样会炸）；若某处 `!!js` 其实不经插值
//     （例如用在 `disabled:` 上的表达式文本），那是**误报**，按需在扫描里排除该行。
//
// ## 判据
//   ① 未注册变量 ⇒ 红（引擎装配时必抛错）；
//   ② 畸形引用（`{{ cwd }}` / `{{Model}}` / `{{a.b}}`：名字不匹配 `^[a-z][a-z0-9_]*$`）⇒ 红（引擎同样抛错）；
//   ③ 注释行**不算**（引擎不插值注释）；块标量正文**算**（那是会进提示词的正文）；
//   ④ 读不到 patch / 读不到引擎安装树 / 白名单扫到 0 个名字 ⇒ **不判**（退出码 0，首行明说）。
//   ⑤ 本机有多个 home 都带 home 级 patch 时，只判一个（候选序第一命中），其余**出声**列出未判项。
//
// ## 退出码（与 guard-baselines.sh 的 livecheck 同一口径）
//   0 = 绿，或「不判」（首行以 `·  不判：` 开头，调用方看得见）
//   2 = 红（未注册 / 畸形）
//   1 = 判据自身异常（只在 --selftest 失败时出现）
//
// ## 用法
//   node scripts/preset-var-check.mjs                      # 默认：$DSH_HOME，否则 ~/.dsh-matter
//   node scripts/preset-var-check.mjs --home <dir|file>    # home 目录；直接给文件则视为 patch
//   node scripts/preset-var-check.mjs --patch <file>       # 只换 patch，home 仍用于解析引擎树
//   node scripts/preset-var-check.mjs --engine-root <dir>  # 追加白名单扫描根（可重复）
//   node scripts/preset-var-check.mjs --json               # 机器可读
//   node scripts/preset-var-check.mjs --selftest           # fixture 独立验「该红必须红、不判不绿」
//
// ## 手工复核路径（真 spawn 探针，本守卫**不**自动跑）
//   本守卫是静态判据：零成本、秒级、可常跑，但它判的是「变量注册了没有」，不判「装配真的跑通了」。
//   要真验一遍，起一次**最小委派**（真调模型，有耗时与 token 成本，不合适每次门禁）：
//     · 从 App 界面或 `agent_dispatch` 发一个一句话任务给目标预设；
//     · 只看该子会话的 `turn/end.reason`：`error` 即装配失败（本次事故就是这条），
//       `unknown prompt variable` 会连变量名与已注册名单一起写在 reason 里；
//     · 装配面改动（新预设 / 改 persona / 升引擎）后建议至少走一次这个探针。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HOME = os.homedir()

// ── 与引擎同一份口径（literal 抄自 dsh-system-prompt 的 VARIABLE_NAME / GROUP_AT）────────
// 抄的是**语义**不是名单：名字形态变了，这里要跟着改（变了就判「不判」而不是误判）。
const GROUP_AT = /^\{\{([^{}]*)\}\}/
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
/** 引擎注册变量**唯一入口**的调用形态：`ctx.systemPrompt.variable("provider", …)`。 */
const REGISTER_AT = /systemPrompt\s*\.\s*variable\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g

/** 扫描时跳过的目录名（客户端产物 / 测试 / devtools 里不会有 host 侧注册点）。 */
const SKIP_DIRS = new Set(['node_modules', 'devtools', 'coverage', '.git', 'test', 'tests', '__tests__', 'fixtures', 'vendor'])
/** 单文件上限：超了只跳过并**报出来**（跳过是可能漏白名单的原因，不许静默）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = { home: undefined, patch: undefined, engineRoots: [], json: false, selftest: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '') continue // guard-baselines.sh 的 livecheck 会传一个空参数（`"$NODE" "$script" "$2"`，$2 为空）
  if (a === '--home') opt.home = argv[++i]
  else if (a === '--patch') opt.patch = argv[++i]
  else if (a === '--engine-root') opt.engineRoots.push(argv[++i])
  else if (a === '--json') opt.json = true
  else if (a === '--selftest') opt.selftest = true
  else if (a === '--verbose') opt.verbose = true
  else if (a === '--help' || a === '-h') {
    const head = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n')
    const from = head.findIndex((l) => l.startsWith('// ## 用法'))
    const to = head.findIndex((l) => l.startsWith('// ## 手工复核路径'))
    console.log(head.slice(from < 0 ? 0 : from, to < 0 ? head.length : to).join('\n'))
    process.exit(0)
  } else {
    console.error(`未知参数：${a}（--help 看用法）`)
    process.exit(2)
  }
}

// ── 输入解析：home / patch / 引擎安装树 ───────────────────────────────────────
/**
 * home 候选序：显式 `--home` > `$DSH_HOME` > `~/.dsh-matter` > `~/.dsh`。
 * 为什么要多级（与 preset-parity-check 同口径）：agent 会话里的 `$DSH_HOME` 可能是 App home，
 * 而 3210 的装配住在 `~/.dsh-matter` —— 不 fallback 就会把「没东西可查」误报成结论。
 */
function resolveTargets() {
  let home = opt.home
  let patch = opt.patch
  const unjudged = []
  if (home && fs.existsSync(home) && fs.statSync(home).isFile()) {
    // `--home` 直接给了文件：按 patch 对待（夹具/备份用法），home 取它的目录
    patch = patch ?? home
    home = path.dirname(home)
  }
  if (!home) {
    const cands = [process.env.DSH_HOME, path.join(HOME, '.dsh-matter'), path.join(HOME, '.dsh')].filter(Boolean)
    home = cands.find((h) => fs.existsSync(path.join(h, 'cordis.patch.yml'))) ?? cands[0]
    // 只判一个 home ⇒ 把**没判的**列出来（静默的覆盖缺口正是本单要防的形态）
    for (const h of cands) if (h !== home && fs.existsSync(path.join(h, 'cordis.patch.yml'))) unjudged.push(h)
  }
  if (!patch) patch = path.join(home, 'cordis.patch.yml')
  // 引擎树必须跟着**这份配置所属的 home**走（同一个 home 的 `profiles/node_modules` 才是加载它的那份装配）
  const engineCands = opt.engineRoots.length > 0
    ? opt.engineRoots
    : [path.join(home, 'profiles/node_modules/@deepseek-ai'), path.join(home, 'node_modules/@deepseek-ai')]
  return { home, patch, engineCands, unjudged }
}

// ── 配置扫描：把 patch 文本读成「哪个预设 / 哪一行 / 哪个键 / 引用了什么变量」───────
/**
 * 逐行扫描 patch，只看**会被引擎插值**的文本：
 *   · `#` 注释行跳过（引擎不插值注释）；
 *   · 块标量（`key: |-` / `|` / `>-`）的正文**不跳注释**：那是正文，`#` 开的行也是正文。
 * 归属：最近一个 `- id: preset-*` 行。跨行 `{{…}}` 不判（见文件头的失效模式）。
 * @returns {{refs: Array, presets: string[]}}
 */
function scanPatch(text) {
  const lines = text.split('\n')
  const refs = []
  const presets = []
  let preset = undefined
  let blockIndent = null // 块标量状态：键行的缩进（内容必须比它更深）
  let blockKey = ''
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '')
    const trimmed = raw.trim()
    const indent = raw.length - raw.trimStart().length
    const pm = /^\s*- id: (preset-[A-Za-z0-9_-]+)\s*$/.exec(raw)
    if (pm !== null) {
      preset = pm[1]
      if (!presets.includes(preset)) presets.push(preset)
      blockIndent = null
      continue
    }
    let key = ''
    let content = false
    if (blockIndent !== null && (trimmed === '' || indent > blockIndent)) {
      content = true // 块标量正文
      key = blockKey
    } else {
      blockIndent = null
      if (trimmed === '' || /^\s*#/.test(raw)) continue
      content = true
      const km = /^\s*(?:-\s*)?([\w'"-]+):\s*(.*)$/.exec(raw)
      key = km !== null ? km[1] : ''
      const bm = /^\s*(?:-\s*)?[\w'"-]+:\s*[|>][-+]?\d*\s*$/.exec(raw)
      if (bm !== null) {
        blockIndent = indent
        blockKey = key
      }
    }
    if (!content) continue
    for (const r of refsInLine(raw)) refs.push({ ...r, preset, line: i + 1, key })
  }
  return { refs, presets }
}

/**
 * 逐行抽出 `{{…}}` 引用 —— 与引擎 `interpolate()` 的**同一个循环**：
 * 组不成立时，只有「后面还有 `}}`」才算畸形（否则是字面散文，引擎放过）。
 * @returns {Array<{name?: string, malformed?: boolean, raw: string}>}
 */
function refsInLine(line) {
  const out = []
  let last = 0
  for (let open = line.indexOf('{{'); open >= 0; open = line.indexOf('{{', last)) {
    const group = GROUP_AT.exec(line.slice(open))
    if (group === null) {
      if (line.indexOf('}}', open + 2) >= 0) out.push({ malformed: true, raw: line.slice(open, open + 16) })
      last = open + 2
      continue
    }
    const name = group[1]
    out.push(VARIABLE_NAME.test(name) ? { name, raw: `{{${name}}}` } : { malformed: true, raw: `{{${name}}}` })
    last = open + group[0].length
  }
  return out
}

// ── 白名单扫描：机械抽取 `systemPrompt.variable("名字", …)` 的字面量 ──────────────
/** 递归收集一个包目录下的 host JS（跳过客户端产物 / 测试 / devtools）。 */
function collectHostJs(dir, out, depth = 0) {
  if (depth > 8) return out
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    let st
    try { st = fs.statSync(p) } catch { continue } // 断链软链在这里被跳过（不炸）
    if (st.isDirectory()) { collectHostJs(p, out, depth + 1); continue }
    if (!e.name.endsWith('.js')) continue
    if (/^client/.test(e.name) || /\.(test|spec)\.js$/.test(e.name)) continue
    out.push(p)
  }
  return out
}

/** 一个引擎作用域根（如 `…/node_modules/@deepseek-ai`）下的所有包目录，或单个包目录。 */
function packageDirsOf(root) {
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const dirs = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = path.join(root, e.name)
    try { if (fs.statSync(p).isDirectory()) dirs.push(p) } catch { /* 断链软链：跳过 */ }
  }
  return dirs
}

/**
 * 扫白名单：`roots` = 引擎作用域根（内部展开成包目录），`extraPackages` = 逐个包目录（配置声明、本 home 可解析的插件）。
 * @returns {{names: Set<string>, sources: Map<string, string[]>, stat: object}}
 */
function scanWhitelist(roots, extraPackages) {
  const names = new Map() // name -> [相对证据路径]
  const stat = { files: 0, bytes: 0, packages: 0, skippedBig: [] }
  const seen = new Set()
  const readPkg = (pkgDir) => {
    stat.packages++
    for (const f of collectHostJs(pkgDir, [])) {
      let real
      try { real = fs.realpathSync(f) } catch { real = f }
      if (seen.has(real)) continue // 引擎作用域 + 插件名可能指向同一份物理文件（本机全是软链）
      seen.add(real)
      let st
      try { st = fs.statSync(real) } catch { continue }
      if (st.size > MAX_FILE_BYTES) { stat.skippedBig.push(`${real}（${(st.size / 1048576).toFixed(1)} MB）`); continue }
      let text
      try { text = fs.readFileSync(real, 'utf8') } catch { continue }
      stat.files++
      stat.bytes += text.length
      for (const m of text.matchAll(REGISTER_AT)) {
        const list = names.get(m[1]) ?? []
        if (list.length < 3 && !list.includes(real)) list.push(real)
        names.set(m[1], list)
      }
    }
  }
  for (const root of roots) for (const d of packageDirsOf(root)) readPkg(d)
  for (const d of extraPackages) readPkg(d)
  return { names: new Set(names.keys()), sources: names, stat }
}

/** 配置里声明过的包名（`name: '@scope/pkg'` / `name: pkg`），用于把插件提供的变量也算进白名单。 */
function declaredPackageNames(text) {
  const out = new Set()
  for (const m of text.matchAll(/^\s*(?:-\s*)?name:\s*(['"]?)([@A-Za-z0-9_./-]+)\1\s*$/gm)) out.add(m[2])
  return out
}

const engineVersionOf = (root) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'dsh/package.json'), 'utf8')).version } catch { return '未知' }
}

// ── 判定 ────────────────────────────────────────────────────────────────────
/**
 * 纯函数式判定（selftest 直接调它，避免"用例只验子进程退出码"的黑盒化）。
 * @returns {{verdict: 'green'|'red'|'skip', missing: Array, malformed: Array, whitelist: string[], presets: string[], refs: Array}}
 */
function judge(refs, whitelist, presets) {
  const missing = refs.filter((r) => r.name !== undefined && !whitelist.has(r.name))
  const malformed = refs.filter((r) => r.malformed === true)
  const verdict = missing.length > 0 || malformed.length > 0 ? 'red' : 'green'
  return { verdict, missing, malformed, whitelist: [...whitelist].sort(), presets, refs }
}

/** 人读形式的一处指认（含「哪个预设、哪个变量」——验收 ① 的要求）。 */
const where = (r) => `${r.preset ?? '未归属预设'}（第 ${r.line} 行${r.key ? ` · ${r.key}` : ''}）`

// ── selftest：fixture 独立验「该红必须红、不判不绿」 ───────────────────────────
/** 造一个夹具 home：一份 patch + 一棵引擎树（注册点写在 fixture 里，不许碰生产配置）。 */
function fixtureHome(dir, patchText, { register = 'model', extraPkg = undefined, withEngine = true, withPatch = true } = {}) {
  if (withPatch) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patchText)
  const scope = path.join(dir, 'profiles/node_modules/@deepseek-ai')
  fs.mkdirSync(path.join(scope, 'dsh-agent-loop/lib'), { recursive: true })
  fs.writeFileSync(path.join(scope, 'dsh-agent-loop/package.json'), JSON.stringify({ name: 'dsh-agent-loop', version: '0.0.0-fixture' }))
  if (withEngine) {
    // ⚠️ 用 `null` 表示「不写注册点」：写成 `undefined` 会落到默认参数上（`register = 'model'`），
    //    反向控制① 于是注入不进去、恒绿通过（首版实测踩到，正是本单要防的那类假绿）。
    // ⚠️ 夹具源码里的箭头函数一律写 `(x) =>`：本仓声明的格式化档是 `arrowParentheses: 'always'`，
    //    而 format-debt 的 arrow_paren_mixed 判据**连字符串里的箭头也算** —— 首版写成 `c => …`
    //    让那个计数从 26 涨到 27（只报不红，但增债就是增债）。
    fs.writeFileSync(path.join(scope, 'dsh-agent-loop/lib/index.js'),
      `export function apply(ctx) {\n  ctx.systemPrompt.variable("provider", (c) => c.agent?.options.provider)\n`
      + (register === null ? '' : `  ctx.systemPrompt.variable("${register}", (c) => c.agent?.options.model)\n`) + '}\n')
  }
  if (extraPkg !== undefined) {
    const pkgDir = path.join(dir, 'profiles/node_modules/forge-x/lib')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'profiles/node_modules/forge-x/package.json'), JSON.stringify({ name: 'forge-x', version: '0.0.0-fixture' }))
    fs.writeFileSync(path.join(pkgDir, 'index.js'), `export const x = (ctx) => ctx.systemPrompt.variable("${extraPkg}", (c) => 'x')\n`)
  }
  return dir
}

/** 夹具 patch 生成器：`suffix` 是要注入的人设后缀（可留 `{{…}}`）。 */
const fixturePatch = (suffix, { comment = '', prefix = '你是夹具里的 builder。', extraPlugin = undefined } = {}) => [
  '# 夹具（fixture）：结构与生产 patch 同形，但不含任何生产内容',
  '- insert:',
  '    - id: preset-builder',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: builder',
  '        name: Builder',
  '        plugins:',
  '          - id: persona',
  "            name: '@deepseek-ai/dsh-persona'",
  '            config:',
  '              prefix: |-',
  ...prefix.split('\n').map((l) => `                ${l}`),
  `              suffix: ${suffix}`,
  ...(extraPlugin === undefined ? [] : ['          - id: forge-x', '            name: forge-x']),
  comment === '' ? '#（无注释用例）' : `              # ${comment}`,
  '',
].join('\n')

function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-var-'))
  let bad = 0
  const child = (args) => {
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, ...args], { encoding: 'utf8' })
    return { code: r.status === null ? -1 : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
  /**
   * 一条用例 = 一个夹具 home + 期望退出码 + 输出里必须/不许出现的串。
   * `want` 用退出码判（0=绿或不判 / 2=红），`has`/`hasNot` 判它红在哪、或证明它确实"不判"。
   */
  const cases = [
    { name: '正样本（{{model}} 注册过）⇒ 绿', suffix: '所用模型 {{model}}。', want: 0, has: ['✓', 'model'] },
    {
      name: '★变异：suffix 写回 {{cwd}} ⇒ 红，且点名预设与变量',
      suffix: '当前工作目录 {{cwd}}。', want: 2, has: ['preset-builder', 'cwd', 'suffix'],
    },
    {
      name: '块标量正文里的 {{cwd}} ⇒ 红（正文会进提示词）',
      suffix: '所用模型 {{model}}。', want: 2, has: ['cwd', 'prefix'], prefix: '你在 {{cwd}} 下工作。',
    },
    {
      name: '注释里的 {{cwd}} ⇒ 绿（引擎不插值注释）',
      suffix: '所用模型 {{model}}。', want: 0, has: ['✓'], hasNot: ['cwd'], comment: '历史遗留写法 {{cwd}}（已删）',
    },
    {
      name: '畸形 {{ cwd }} ⇒ 红（引擎判 malformed）',
      suffix: '目录 {{ cwd }}。', want: 2, has: ['畸形'],
    },
    {
      name: '畸形 {{Model}} ⇒ 红（名字必须 ^[a-z][a-z0-9_]*$）',
      suffix: '所用模型 {{Model}}。', want: 2, has: ['畸形'],
    },
    {
      name: '未闭合 {{ 但无 }} ⇒ 绿（引擎当字面散文放过）',
      suffix: '花括号 {{ 不是引用。', want: 0, has: ['✓'],
    },
    {
      name: '插件声明提供的变量也算白名单（第二来源）⇒ 绿',
      suffix: '工单 {{issueid}}。', want: 0, has: ['✓', 'issueid'], extraPkg: 'issueid', extraPlugin: true,
    },
  ]
  console.log('selftest：fixture 独立验（不碰生产配置）')
  for (const [i, c] of cases.entries()) {
    const home = path.join(dir, `home-${i}`)
    fs.mkdirSync(home, { recursive: true })
    fixtureHome(home, fixturePatch(c.suffix, { comment: c.comment ?? '', prefix: c.prefix ?? '你是夹具里的 builder。', extraPlugin: c.extraPlugin }),
      { register: 'model', extraPkg: c.extraPkg, withEngine: true })
    const r = child(['--home', home])
    const ok = r.code === c.want && c.has.every((s) => r.out.includes(s)) && (c.hasNot ?? []).every((s) => !r.out.includes(s))
    console.log(`${ok ? '✓' : '✗'} ${c.name}（want ${c.want} got ${r.code}）`)
    if (!ok) { bad++; console.log(r.out.split('\n').slice(0, 6).map((l) => `      ${l}`).join('\n')) }
  }
  // ── 反向控制：白名单源必须真在读盘，否则上面那些绿是假的 ──
  // ① 把 fixture 引擎里的注册点删掉：原本绿的正样本必须**变红**（证明白名单不是恒真）。
  {
    const home = path.join(dir, 'ctl-no-register')
    fs.mkdirSync(home, { recursive: true })
    fixtureHome(home, fixturePatch('所用模型 {{model}}。'), { register: null })
    const r = child(['--home', home])
    const ok = r.code === 2 && r.out.includes('model')
    console.log(`${ok ? '✓' : '✗'} 反向控制①：注册点删掉 ⇒ 原本绿的 {{model}} 变红（want 2 got ${r.code}）`)
    if (!ok) bad++
  }
  // ② 引擎扫到 0 个注册点 ⇒ 必须判「不判」，绝不冒充绿（API 形态变了的那天靠这条兜住）。
  {
    const home = path.join(dir, 'ctl-empty-engine')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'cordis.patch.yml'), fixturePatch('所用模型 {{model}}。'))
    const scope = path.join(home, 'profiles/node_modules/@deepseek-ai/dsh-agent-loop/lib')
    fs.mkdirSync(scope, { recursive: true })
    fs.writeFileSync(path.join(scope, 'index.js'), 'export function apply() {}\n')
    const r = child(['--home', home])
    const ok = r.code === 0 && r.out.includes('不判') && !r.out.includes('✓')
    console.log(`${ok ? '✓' : '✗'} 不判①：白名单扫到 0 个名字 ⇒ 不判（want 0+不判 got ${r.code}）`)
    if (!ok) bad++
  }
  // ③ 引擎安装树读不到 ⇒ 不判。
  {
    const home = path.join(dir, 'ctl-no-engine')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'cordis.patch.yml'), fixturePatch('所用模型 {{model}}。'))
    const r = child(['--home', home])
    const ok = r.code === 0 && r.out.includes('不判') && !r.out.includes('✓')
    console.log(`${ok ? '✓' : '✗'} 不判②：引擎安装树读不到 ⇒ 不判（want 0+不判 got ${r.code}）`)
    if (!ok) bad++
  }
  // ④ patch 读不到 ⇒ 不判（不是绿）。
  {
    const home = path.join(dir, 'ctl-no-patch')
    fs.mkdirSync(home, { recursive: true })
    fixtureHome(home, '', { register: 'model', withPatch: false })
    const r = child(['--home', home])
    const ok = r.code === 0 && r.out.includes('不判') && !r.out.includes('✓')
    console.log(`${ok ? '✓' : '✗'} 不判③：patch 读不到 ⇒ 不判（want 0+不判 got ${r.code}）`)
    if (!ok) bad++
  }
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(bad === 0 ? 'selftest 全绿' : `selftest 失败 ${bad} 项`)
  process.exit(bad === 0 ? 0 : 1)
}

// ── main ────────────────────────────────────────────────────────────────────
if (opt.selftest) selftest()

/** 「不判」的统一出口：退出码 0，但首行以 `·  不判：` 开头 —— 调用方看得见，绝不冒充「已判过」。 */
function skip(reasons, extra = {}) {
  if (opt.json) console.log(JSON.stringify({ verdict: 'skip', reasons, ...extra }, null, 2))
  else {
    console.log(`·  不判：${reasons.join('；')}`)
    console.log('   读不到不等于没问题 —— 但也不能拿它当「判过了」。')
    for (const l of extra.tried ?? []) console.log(`   试过：${l}`)
  }
  process.exit(0)
}

const { home, patch, engineCands, unjudged } = resolveTargets()
if (!fs.existsSync(patch)) skip([`patch 读不到：${patch}`], { home, patch, tried: engineCands })

const patchText = fs.readFileSync(patch, 'utf8')
const { refs, presets } = scanPatch(patchText)
const engineRoots = engineCands.filter((c) => fs.existsSync(c))
if (engineRoots.length === 0) {
  skip([`引擎安装树读不到（白名单无从取，不判）`], { home, patch, tried: engineCands })
}
// 第二来源：配置声明、且在本 home 安装得到的插件包（插件也能注册提示词变量）
const declared = declaredPackageNames(patchText)
const extraPackages = []
for (const name of declared) {
  for (const base of [path.join(home, 'profiles/node_modules'), path.join(home, 'node_modules')]) {
    const p = path.join(base, name)
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) { extraPackages.push(p); break } } catch { /* 忽略 */ }
  }
}
const scan = scanWhitelist(engineRoots, extraPackages)
const engineVersion = engineVersionOf(engineRoots[0])
const srcNote = `${engineVersion} · ${scan.stat.files} 文件 / ${(scan.stat.bytes / 1048576).toFixed(1)} MB / ${scan.stat.packages} 个包根`
if (scan.names.size === 0) {
  // 扫到 0 个名字有两种可能：引擎真的一个都没注册（那任何 {{x}} 都该红），或者**本判据的扫描形态过期了**。
  // 静态判据分不清这两者 ⇒ 判「不判」并打印扫描量（谁来修：看 REGISTER_AT 是否还对得上引擎）。
  skip([`白名单扫到 0 个名字（${srcNote}）—— 引擎可能换了注册形态，本判据的扫描口径要维护`],
    { home, patch, engineRoots, engineVersion })
}

const result = judge(refs, scan.names, presets)
const report = {
  verdict: result.verdict,
  home, patch, engineRoots, engineVersion,
  unjudgedHomes: unjudged,
  whitelist: result.whitelist,
  whitelistSources: Object.fromEntries([...scan.sources].map(([k, v]) => [k, v])),
  scan: scan.stat,
  presets,
  refs: result.refs.map((r) => ({ preset: r.preset, line: r.line, key: r.key, name: r.name, malformed: r.malformed, raw: r.raw })),
  missing: result.missing,
  malformed: result.malformed,
}

if (opt.json) {
  console.log(JSON.stringify(report, null, 2))
} else if (result.verdict === 'green') {
  console.log(`✓ ${refs.length} 处 {{变量}} 全在引擎注册表内（预设 ${presets.length} 个：${presets.join(', ') || '无'}）`)
  console.log(`  白名单 ${result.whitelist.length} 个名字（${srcNote}）：${result.whitelist.join(', ')}`)
  for (const [name, files] of scan.sources) console.log(`  · ${name} ← ${files[0]}`)
  if (refs.length === 0) console.log('  ! patch 里一处 {{变量}} 都没有 —— 若期望有，说明扫描没读到（检查 patch 路径）')
} else {
  console.log(`✗ ${result.missing.length + result.malformed.length} 处引用会让**整份预设装配失败**（引擎对 {{…}} 做严格插值）`)
  for (const r of result.missing) {
    console.log(`  · ${where(r)}：${r.raw} 未注册；引擎 ${engineVersion} 已注册的只有：${result.whitelist.join(', ') || '（无）'}`)
  }
  for (const r of result.malformed) {
    console.log(`  · ${where(r)}：${r.raw} 是畸形引用（名字须匹配 ^[a-z][a-z0-9_]*$，引擎会抛 malformed）`)
  }
  console.log(`  白名单 ${result.whitelist.length} 个名字（${srcNote}）：${result.whitelist.join(', ')}`)
  for (const [name, files] of scan.sources) console.log(`  · ${name} ← ${files[0]}`)
  console.log('  修法：删掉这些人设里的引用，或改用已注册的名字；改完重跑本守卫。')
}
if (unjudged.length > 0) {
  console.log(`  ! 另有 home 也带 home 级 patch，本次**未判**：${unjudged.join(', ')}（要逐个判：--home <dir>）`)
}
if (scan.stat.skippedBig.length > 0) {
  console.log(`  ! 跳过了 ${scan.stat.skippedBig.length} 个超大文件（>${MAX_FILE_BYTES / 1048576} MB，可能藏着注册点）：`)
  for (const s of scan.stat.skippedBig.slice(0, 5)) console.log(`    ${s}`)
}
process.exit(result.verdict === 'red' ? 2 : 0)
