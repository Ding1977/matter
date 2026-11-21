#!/usr/bin/env node
// scripts/format-debt.mjs
// ISS-726 的落地：**只检查不改**（老板 09-23 选乙；09-24 给了运行态窗口，但这份改动不碰运行态 ⇒ 窗口未用）。
//
// 为什么不是"把 Biome 装上判红"—— 实测过，代价与收益不划算（全过程见
// docs/memory/iss-726-biome-probe-2026-09-24.md）：
//   · 受测 971 个源文件：默认口径 965 个要重排；lineWidth 顶到上限 320 仍有 797 个（82%）。
//     差异主因不是折行宽度，是 Biome 要把本仓人肉折的多行 import / 调用摊平。
//   · 38 个 Tailwind 输入 CSS 文件 Biome 解析报错（读不懂 @theme / @source）
//     ⇒ 我 09-23 推荐它的第一条理由「单工具覆盖 TS/TSX/CSS」实测不成立，已撤回。
//   · 默认口径第一次跑就报 962 个红灯 = 纯噪音。门禁一旦假红就没人再信它（本仓写过好几遍）。
//
// 所以这里只数**本仓自己口径下机械可判**的六项：不引入依赖、不改任何一个字节。
// 引号 / 分号两项**不在这里重算** —— 那是 `scripts/code-inventory.mjs` 的 N7 / N8，
// 一个语义一份真相，这里只指路。
//
// 六项（全是"若将来上 formatter，一定会被改到的地方"的零依赖代理指标）：
//   trailing_ws         行尾空白（行数，`[ \t]$`；CRLF 的 \\r 不算这里，避免与 crlf 双计）
//   tab_indent          行首用 tab 缩进（行数；**只算字面量外的缩进**，见下「词法口径」）
//   no_final_newline    文件末尾缺换行（文件数）
//   crlf                含 CRLF 行的文件（文件数）
//   multi_blank         连续 ≥3 行空行（处数；一段只算一处，不按行放大）
//   arrow_paren_mixed   同文件里 `(x) =>` 与 `x =>` 各 ≥3 处（文件数）
//
// 词法口径（ISS-635）：tab_indent 只数**真缩进**，不数字符串 / 模板字面量内部的字节。
//   为什么必须分开：补丁载荷把别人的源码原样嵌进模板串当锚点（`scripts/patches/team-tools.mjs` 111 行），
//   这些 tab 是**目标文件的原始字节**，改成空格会打断补丁锚点 ⇒ 不能靠"改代码"消掉，只能修判据。
//   怎么判：交给 TypeScript 解析器取字面量区间（正则 vs 除法的歧义、模板 `${}` 的嵌套由引擎判，不由我判），
//   把字面量**内部**抹成等长空格（保行号），再看行首是否仍是 tab。
//   为什么不自己写词法：注释里的引号、转义引号、跨行模板都会骗过"一把梭"的正则 —— 本仓为手写词法层
//   付过两次学费（`scripts/lexical-lib.mjs` 头注：N7 被低估一半）。
//   解析不到 typescript ⇒ **判不了**（退出码 2），不退回正则口径 —— 口径换了却照样跟旧基线逐格比，是最难发现的静默错。
//
// 扫描面（ISS-635）：量的是**git 认得的项目文件** —— 已跟踪 ∪ 未跟踪但未被 .gitignore 排除，
// 再剔产物目录（SKIP_DIR）。判据以 git 为准，**不按目录名黑名单**：
//   本仓 .gitignore 有约 30 条忽略规则（`.tmp-*` / `.refs/` / `diag*.mjs` / `.probe-at-latency/` …），
//   黑名单追不上它们。ISS-635 照出来的就是这一格：未跟踪的临时备份目录 `.tmp-patch/` 被当成源码，
//   1944 行 tab 记进风格债（2369 里只有 425 是真的）；同批漏网的还有 `.refs/` 334 个只读 vendor 克隆。
//   git 读不到清单 ⇒ **判不了**（不退回黑名单：口径换了却照样跟旧基线逐格比，是最难发现的静默错）。
//
// 射程（ISS-890 甲案）：在 git 清单之上再钉 `packages/*/*` —— 旧树 forge-* 与 scripts 不扫
// （步5 新增的 scripts 判据文件把计数推过上限，那些不是新树的历史风格债；step3 旧树已退役）。
// 这是"判据不扫"，不是删磁盘文件。扫错射程由 selftest 的 scope 档拦截。
//
// 判红口径（ISS-890 甲案）：**零容忍** —— 六项任一 count>0 即红。`ceiling` 只作历史留档、
// 不参与判红；`--baseline-save` 的 nextCeiling 恒 0 ⇒ 抬数字消红这条路从机制上堵死，不靠人自觉。
//
// 用法：
//   node scripts/format-debt.mjs                  # 人读摘要
//   node scripts/format-debt.mjs --json           # 机器结果（含 offender 明细）
//   node scripts/format-debt.mjs --verbose        # 每项列前 12 个文件
//   node scripts/format-debt.mjs --baseline-save  # 存基线（零容忍：ceiling 恒 0，写不出非 0）
//   node scripts/format-debt.mjs --compare        # 与基线对照（guard 的 report_only 走这条）
//                                                 #   返回码三态（ISS-635）：0 六项全 0 / 1 有违例 / 2 判不了
//   node scripts/format-debt.mjs --selftest       # 六项各自能红 + 干净样例为 0 + 缺目录显式不判 + 上限方向
//   node scripts/format-debt.mjs --biome          # 可选：装了 Biome 才量"重排面"；没装显式不判
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..')
const BASE = path.join(ROOT, 'scripts', 'baseline', 'format-debt.json')
const A = process.argv.slice(2)

// 词法口径要引擎（见文件头）。缺席 ⇒ 退出码 2 = 判不了，**不出数**：
//   退回 `/^\t/` 会把补丁载荷算成债务（425 里 118 行不是我们的缩进），退回"整行含引号就跳过"会漏真缩进。
const TSL = loadDebtTypeScript()
if (!TSL) {
  console.error('✗ 找不到 typescript 编译器（试过 forge-ui / forge-pm / 根 node_modules）⇒ tab_indent 判不了，不出数')
  process.exit(2)
}
const TS = TSL.ts

// 产物 / 生成物目录：**第二层**过滤（第一层是 git 的忽略规则，见文件头）。
// 这些名字入库了也不量 —— `static` / `vendor` 是运行时件或三方拷贝，不是手写风格面。
const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'build', '.git', '.wt', '.workbuddy', '.tmp', '.bun-tmp', 'static', 'mockups', 'vendor', 'baseline'])
// 射程（ISS-890 甲案）：只认 `packages/<组>/<包>/…`。用 git 相对路径判定 —— 旧树 forge-* 与
// scripts 仍在盘上、仍被 git 跟踪，但**不是本判据的对象**（判据不扫，不是删文件）。
const SCOPE_RE = /^packages\/[^/]+\/[^/]+\//
const FILE_RE = /\.(ts|tsx|js|mjs|css)$/
const ITEMS = ['trailing_ws', 'tab_indent', 'no_final_newline', 'crlf', 'multi_blank', 'arrow_paren_mixed']
const LABEL = {
  trailing_ws: '行尾空白（行）',
  tab_indent: '行首 tab（行）',
  no_final_newline: '末尾缺换行（文件）',
  crlf: '含 CRLF（文件）',
  multi_blank: '连续 ≥3 空行（处）',
  arrow_paren_mixed: '箭头括号混用（文件）',
}

const LEX_KIND = { '.ts': 'TS', '.tsx': 'TSX', '.js': 'JS', '.mjs': 'JS', '.jsx': 'JSX' }

/** 借仓库里已有的 typescript（与 code-inventory / lexical-lib 同一套候选），不新增依赖。读不到 ⇒ null。 */
function loadDebtTypeScript() {
  for (const c of ['forge-ui/node_modules/typescript', 'forge-pm/node_modules/typescript', 'node_modules/typescript']) {
    const abs = path.join(ROOT, c)
    if (!fs.existsSync(abs)) continue
    try {
      return { ts: createRequire(path.join(abs, 'package.json'))('typescript'), from: c }
    } catch { /* 换下一个候选 */ }
  }
  return null
}

/**
 * 把字符串 / 模板字面量的**内部**抹成等长空格（换行与 `\r` 保留 ⇒ 行号、行尾空白、CRLF 三项不受影响）。
 * 定界符留着：行首 tab 若在引号**前面**，那是真缩进，该算。
 * 模板片段的 `${` 与 `}` 也留着 —— 壳内是代码，不是字面量。
 */
function maskLiteralText(ts, file, body) {
  const ext = path.extname(file)
  const kind = LEX_KIND[ext]
  if (!kind) return body // css 等：本项不涉及字面量
  const sf = ts.createSourceFile('__fmt__' + ext, body, ts.ScriptTarget.Latest, true, ts.ScriptKind[kind])
  const chars = body.split('')
  const blank = (a, b) => {
    for (let i = a; i < b; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '
  }
  const walk = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const t = n.getText()
      if (t.length >= 2) blank(n.getStart() + 1, n.getEnd() - 1) // 去掉两端引号，只抹内部
    } else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      // 片段形如 `text${ / }text${ / }text` ⇒ 抹文本、留 `${`（2 字符）或 `}`（1 字符）
      blank(n.getStart() + 1, n.getEnd() - (n.getText().endsWith('${') ? 2 : 1))
    }
    ts.forEachChild(n, walk) // ⚠️ 回调**不许 return 值**：forEachChild 见到真值就停掉兄弟遍历（本单实测：会漏数一半）
  }
  walk(sf)
  return chars.join('')
}

/** 项目文件清单（相对路径，`/` 分隔）。git 读不到 ⇒ null = 判不了，绝不拿别的口径顶替。 */
function gitProjectFiles(root) {
  try {
    // --cached = 已跟踪；--others --exclude-standard = 未跟踪但未被 .gitignore 排除（新写的源码必须在里面，
    // 否则「还没提交 ⇒ 看不见」就是更坏的假绿）。-z 免去文件名转义。
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean)
  } catch {
    return null
  }
}

/**
 * 扫源码：扫描面 = git 认得的项目文件 − 产物目录（SKIP_DIR）− 生成物（`.generated.` / `~NNN` 残留）。
 * 判据选型与代价见文件头「扫描面」一段；selftest 有正反两档打它（忽略目录被剔 + 新源码没被连坐）。
 */
function scanSourceFiles(root = ROOT, scoped = true) {
  const rel = gitProjectFiles(root)
  if (rel === null) return { files: [], unreadable: 0, surface: null }
  const files = []
  for (const r of rel) {
    if (!FILE_RE.test(r) || r.includes('.generated.')) continue
    if (/~\d{3,}/.test(r)) continue
    // scoped=false 只给 selftest 的临时 git 仓库用（它们的样例文件不在 packages/*/* 下）；
    // 真跑恒为 true —— 射程收窄是本判据的口径，不是可配置选项。
    if (scoped && !SCOPE_RE.test(r)) continue
    if (r.split('/').some((seg) => SKIP_DIR.has(seg))) continue
    const abs = path.join(root, r)
    // 索引里有、盘上已删 ⇒ 不在本次测量的树里（旧口径同样不数它；删文件只会让债务下降，棘轮方向不受影响）
    if (!fs.existsSync(abs)) continue
    files.push(abs)
  }
  return { files, unreadable: 0, surface: 'git' }
}

/** 逐文件数六项。口径全在这一个函数里 —— selftest 打的就是它。 */
function measureStyle(root = ROOT, ts = TS, scoped = true) {
  // `let`：读不到时下面要累加（旧版是 const，真出现读不到会抛 TypeError —— 「判不了」这条路自己先崩）
  const { files, surface } = scanSourceFiles(root, scoped)
  let unreadable = 0
  const count = Object.fromEntries(ITEMS.map((k) => [k, 0]))
  const offenders = Object.fromEntries(ITEMS.map((k) => [k, []]))
  const arrowParen = /\(\s*[\w$]+\s*(?:,\s*[\w$]+\s*)*\)\s*=>/g
  const arrowBare = /(?:^|[^\w$.)\]])\s*([a-z$][\w$]*)\s*=>(?!=)/g
  const push = (k, n, file, bag = offenders) => {
    if (!n) return
    count[k] += n
    bag[k].push({ k: file, n })
  }
  for (const p of files) {
    let body = ''
    try {
      body = fs.readFileSync(p, 'utf8')
    } catch {
      unreadable++
      continue
    }
    const rel = path.relative(root, p)
    const lines = body.split('\n')
    // 词法口径：行首 tab 只在**字面量外**才算真缩进（见文件头「词法口径」）。抹空格保长度 ⇒ 下标与 lines 一一对应。
    const lexLines = maskLiteralText(ts, p, body).split('\n')
    let tw = 0
    let ti = 0
    let crlf = 0
    let blanks = 0
    let run = 0
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (/[ \t]$/.test(ln)) tw++
      if (/^\t/.test(lexLines[i])) ti++
      if (/\r$/.test(ln)) crlf++
      if (ln.trim() === '') {
        run++
        if (run === 3) blanks++
      } else run = 0
    }
    let paren = 0
    let bare = 0
    for (const m of body.matchAll(arrowParen)) paren++
    for (const m of body.matchAll(arrowBare)) bare++
    push('trailing_ws', tw, rel)
    push('tab_indent', ti, rel)
    push('crlf', crlf ? 1 : 0, rel)
    push('multi_blank', blanks, rel)
    push('arrow_paren_mixed', paren >= 3 && bare >= 3 ? 1 : 0, rel)
    if (body.length && !body.endsWith('\n')) push('no_final_newline', 1, rel)
  }
  // 判不了的三条路各自成对：清单读不到（surface=null）/ 一个文件都没有 / 有文件读不到。
  const judged = surface !== null && files.length > 0 && unreadable === 0
  return { count, offenders, files: files.length, unreadable, surface, judged }
}

/** 判不了时的那一句话：读不到清单与读不到文件是两回事，别混成同一句糊过去。 */
function undecidedNote(m) {
  if (m.surface === null) return '  ! 判不了：git 读不到仓库文件清单（扫描面以 git 为准）—— 结论不可得，不是「没问题」'
  return `  ! 有 ${m.unreadable} 处读不到 ⇒ 判不了（结论不可得，不是「没问题」）`
}

/** 与基线对照：纯函数，selftest 直接拿它验零容忍，不靠真跑一遍仓库。 */
function driftAgainst(base, counts) {
  const rises = []
  const same = []
  const moved = []
  for (const k of ITEMS) {
    const was = base.items ? base.items[k] : undefined
    const now = counts[k]
    // 零容忍（ISS-890）：有效上限恒 0 —— base.ceiling 只留档、不参与判红。
    // 即便有人手改 JSON 抬 ceiling，也消不掉违例（不靠「审查会盯住那个数」）。
    if (was === undefined) {
      rises.push(`${k} 基线里没这项（度量加过项？先 --baseline-save 复录，别拿 undefined 当 0）`)
      continue
    }
    if (was === now) same.push(k)
    else moved.push(`${now < was ? '↓' : '↑'} ${LABEL[k]}：${was} → ${now}`)
    if (now > 0) rises.push(`${k} 有 ${now} 处违例（零容忍，必须=0）`)
  }
  return { rises, same, moved }
}

/** 上限形态（ISS-890 甲案）：恒 0 —— --baseline-save 无论当前计数多少都写不出非 0 ceiling。 */
function nextCeiling() {
  return Object.fromEntries(ITEMS.map((k) => [k, 0]))
}

const total = (counts) => ITEMS.reduce((s, k) => s + counts[k], 0)

function headLine(m, base) {
  return `格式化债务（ISS-726 乙 · 只检查不改${base ? ' · ISS-890 新树零容忍' : ''}）· 六项合计 ${total(m.count)} / 上限 0 · 扫 ${m.files} 个源文件（packages/*/*）· 引号与分号风格另见 code-inventory N7/N8`
}

/* ───────────── 可选：装了 Biome 才量的"若上 formatter"代价（不装 ⇒ 显式不判）───────────── */

function findBiome() {
  const cands = [process.env.BIOME_BIN, path.join(ROOT, 'node_modules', '.bin', 'biome')]
  for (const c of cands) if (c && fs.existsSync(c)) return c
  return null
}

// 本仓口径：2 空格 / 双引号 / 不带分号 / 箭头括号保留 / 行宽顶到上限 320（仍会重排 82%，见文件头）
const BIOME_HOUSE = {
  $schema: 'https://biomejs.dev/schemas/2.5.14/schema.json',
  formatter: { enabled: true, indentStyle: 'space', indentWidth: 2, lineWidth: 320 },
  javascript: { formatter: { quoteStyle: 'double', semicolons: 'asNeeded', trailingCommas: 'all', arrowParentheses: 'always', bracketSpacing: true } },
  css: { formatter: { enabled: true } },
}

function biomeProbe() {
  const bin = findBiome()
  if (!bin) {
    return {
      judged: false,
      note: '未装 Biome ⇒ 不判（不是「没问题」）。要量甲案代价：bun add -d @biomejs/biome，或 BIOME_BIN=/路径/biome 再跑一次 --biome。',
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-biome-'))
  fs.writeFileSync(path.join(dir, 'biome.json'), JSON.stringify(BIOME_HOUSE, null, 2))
  // 正 / 反两档对照：脏样例必须被判"要重排"，干净样例必须判"不用改"。
  // 上一轮就是漏了这步 —— 配置非法导致 Biome 拒载、返回 0 个文件需重排，差点被当成好消息写进结论。
  const dirty = path.join(dir, 'dirty.ts')
  const clean = path.join(dir, 'clean.ts')
  fs.writeFileSync(dirty, 'const a={b:1}\nexport function f(x){return a}\n')
  fs.writeFileSync(clean, 'const a = { b: 1 }\nexport function f(x) {\n  return a\n}\n')
  const runOne = (file) => {
    // Biome 的诊断走哪个流不稳（默认 reporter 打到 stderr，--reporter=github 打 stdout）⇒ 两个都收
    try {
      const out = execFileSync(bin, ['format', '--config-path=' + dir, file], { encoding: 'utf8', maxBuffer: 8 << 20 })
      return { rc: 0, out }
    } catch (e) {
      return { rc: (e && e.status) || 1, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') }
    }
  }
  const d1 = runOne(dirty)
  const d2 = runOne(clean)
  const wantsChange = d1.rc !== 0 && /Formatter would have printed/.test(d1.out)
  const staysPut = d2.rc === 0 && !/Formatter would have printed/.test(d2.out)
  if (!wantsChange || !staysPut) {
    fs.rmSync(dir, { recursive: true, force: true })
    return {
      judged: false,
      note: 'Biome 在，但两档对照没过（脏样例：' + (wantsChange ? '能红' : '判不出要改') + ' · 净样例：' + (staysPut ? '能绿' : '被误判要改') + '）⇒ 不判。绝不把「读不到」写成 0。',
    }
  }
  const js = scanSourceFiles().files.filter((p) => !p.endsWith('.css'))
  const css = scanSourceFiles().files.filter((p) => p.endsWith('.css')).length
  const need = new Set()
  let parseFail = 0
  for (let i = 0; i < js.length; i += 200) {
    let out = ''
    try {
      out = execFileSync(bin, ['format', '--config-path=' + dir, '--reporter=github', ...js.slice(i, i + 200).map((p) => path.relative(ROOT, p))], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    } catch (e) {
      out = String((e && e.stdout) || '') + String((e && e.stderr) || '')
    }
    for (const m of out.matchAll(/,file=([^,]+),/g)) need.add(m[1])
    parseFail += [...out.matchAll(/title=parse/g)].length
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { judged: true, bin, 受测: js.length, needReformat: need.size, parseFail, cssExcluded: css }
}

/* ──────────────────────────────── 正 / 反对照 selftest ──────────────────────────────── */

function runSelftest() {
  const bad = []
  let checks = 0
  const t = (cond, msg) => {
    checks++
    if (!cond) bad.push(msg)
  }
  // 扫描面以 git 为准（见文件头）⇒ 下面每个「必须给出数」的样例都得是真 git 仓库，否则量到的是「判不了」。
  // 只要 `git init` 够：`ls-files --others --exclude-standard` 会带上未跟踪文件，不必 add / commit。
  const gitInit = (d) => {
    try {
      execFileSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fmt-selftest-'))
  try {
    t(gitInit(dir), '正对照失败：git 不可用 ⇒ 扫描面判据装不上（本判据以 git 为准）')
    // 正对照：六项各埋一处，必须都被数到
    const dirty = [
      'export const a = 1   ', // trailing_ws
      '\tif (a) return 1', // tab_indent
      'const f = (x) => x + 1', // 带括号的箭头写法 ×3
      'const g = (y) => y * 2',
      'const h = (z) => z - 3',
      'const p = q => q + 1', // 裸写法 ×3
      'const r = s => s + 2',
      'const t2 = u => u + 3',
      '',
      '',
      '', // multi_blank
      'const win = 1\r', // crlf
      'const noEol = 2', // 末尾不留换行 → no_final_newline
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'dirty.ts'), dirty)
    const m = measureStyle(dir, TS, false) // 临时仓不在 packages/*/* 射程内 ⇒ 关掉射程过滤，只测六项度量本身
    for (const k of ITEMS) t(m.count[k] > 0, `正对照失败：${k} 埋了问题却数到 ${m.count[k]}（判据瞎了）`)
    t(m.judged, '正对照失败：埋了问题却报「不判」')

    // 反对照：干净样例必须全 0（口径过宽 = 假红源）
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fmt-clean-'))
    t(gitInit(clean), '反对照失败：git 不可用 ⇒ 扫描面判据装不上')
    fs.writeFileSync(path.join(clean, 'ok.ts'), 'export const a = 1\nexport const b = (x) => x + 1\n')
    const c = measureStyle(clean, TS, false)
    for (const k of ITEMS) t(c.count[k] === 0, `反对照失败：干净样例的 ${k} 数到 ${c.count[k]}（口径过宽）`)
    t(c.judged, '反对照失败：干净样例被判成「不判」')
    fs.rmSync(clean, { recursive: true, force: true })

    // 扫描面（ISS-635 的复现档）：.gitignore 排除的临时目录**不进统计**，未跟踪但没被排除的真源码**仍进**。
    // 两半都要测 —— 只测「忽略的被剔掉」，换成目录名黑名单也能过；只测「新文件被算」，
    // 旧版把 `.tmp-patch/` 当源码那个 bug 也能过。缺一半，判据就只剩一半的牙。
    const surf = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fmt-surface-'))
    try {
      t(gitInit(surf), '扫描面失败：git init 不成 ⇒ 这一档测不了（本判据以 git 为准）')
      fs.mkdirSync(path.join(surf, 'src'))
      fs.mkdirSync(path.join(surf, '.tmp-backup', 'backup'), { recursive: true })
      fs.writeFileSync(path.join(surf, '.gitignore'), '.tmp-*/\n')
      fs.writeFileSync(path.join(surf, 'src', 'real.ts'), '\tconst a = 1\n') // 真源码：1 行 tab
      fs.writeFileSync(path.join(surf, '.tmp-backup', 'backup', 'junk.ts'), '\tconst b = 2\n\tconst c = 3\n') // 垃圾：2 行 tab
      const s = measureStyle(surf, TS, false)
      t(s.judged, '扫描面失败：带 .gitignore 的真 git 仓库被判成「不判」')
      t(s.files === 1, `扫描面失败：扫了 ${s.files} 个文件（应 1 = 只有 src/real.ts；被忽略的临时目录进了扫描面）`)
      t(s.count.tab_indent === 1, `扫描面失败：tab 数到 ${s.count.tab_indent}（应 1；未跟踪临时目录被当成源码 = ISS-635 原形）`)
    } finally {
      fs.rmSync(surf, { recursive: true, force: true })
    }

    // 射程（ISS-890 甲案）：只扫 packages/*/*；旧树 forge-* 与 scripts 同样在盘上、同样被 git
    // 跟踪，但判据不扫。两半都要测 —— 只测「in-scope 被算」换成全仓也能过；只测「旧树/scripts 被剔」
    // 换成 wholesale 排除所有子目录也能过。缺一半，射程判据就只剩一半的牙。
    const scope = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fmt-scope-'))
    try {
      t(gitInit(scope), '射程失败：git init 不成 ⇒ 这一档测不了')
      fs.mkdirSync(path.join(scope, 'packages', 'grp', 'pkg'), { recursive: true })
      fs.mkdirSync(path.join(scope, 'forge-legacy'))
      fs.mkdirSync(path.join(scope, 'scripts'))
      fs.writeFileSync(path.join(scope, 'packages', 'grp', 'pkg', 'in.ts'), '\tconst a = 1\n')
      fs.writeFileSync(path.join(scope, 'forge-legacy', 'out.ts'), '\tconst b = 2\n')
      fs.writeFileSync(path.join(scope, 'scripts', 'out.mjs'), '\tconst c = 3\n')
      const sc = measureStyle(scope) // 真跑口径：scoped 默认 true
      t(sc.judged, '射程失败：射程内有真源码的 git 仓库被判成「不判」')
      t(sc.files === 1, `射程失败：扫了 ${sc.files} 个文件（应 1 = 只有 packages/grp/pkg/in.ts；旧树 / scripts 进了射程）`)
      t(sc.count.tab_indent === 1, `射程失败：tab 数到 ${sc.count.tab_indent}（应 1；射程外那两个文件被算进来了）`)
    } finally {
      fs.rmSync(scope, { recursive: true, force: true })
    }

    // 词法口径（本单新增）：字面量内部的行首 tab **不算**，字面量外的真缩进**仍算**。
    // 两半缺一不可：只测"串里不算" ⇒ 退回 `/^\t/` 也能过；只测"真缩进仍算" ⇒ 把字面量一起放过也能过。
    // 第二段模板是专门打 forEachChild「回调返回值 = 停掉兄弟遍历」那个坑的（本单实测它会让后半个文件漏掩码）。
    const lex = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fmt-lexical-'))
    try {
      t(gitInit(lex), '词法口径失败：git init 不成 ⇒ 这一档测不了')
      fs.writeFileSync(
        path.join(lex, 'a.ts'),
        [
          '\tconst real = 1', // 算：真缩进
          'const tpl = `', // 模板串开始（补丁载荷的典型形状）
          '\tfromPatchAnchor', // 不算：模板文本内部
          '${(() => {', // 模板表达式：这段是代码
          '\tconst inner = 2', // 算：`${}` 内部是代码
          '})()}`',
          'const cont = "a\\', // 反斜杠续行 ⇒ 字符串跨行
          '\tinsideString"', // 不算：字符串字面量内部
          'const t2 = `',
          '\tsecondPayload', // 不算：**第二段**模板（防兄弟遍历被掐断）
          '`',
          '\tconst bare = 3', // 算：真缩进
          '\t"tab before a string literal"', // 算：tab 在字面量**外**，只跳过"整行含引号"的实现会漏掉它
        ].join('\n'),
      )
      const lx = measureStyle(lex, TS, false)
      t(lx.judged, '词法口径失败：词法样例被判成「不判」')
      t(
        lx.count.tab_indent === 4,
        `词法口径失败：tab 数到 ${lx.count.tab_indent}（应 4 = 真缩进 3 行 + \`\${}\` 内 1 行；串内/模板内那 3 行不该算）`,
      )
    } finally {
      fs.rmSync(lex, { recursive: true, force: true })
    }

    // 反面：不是 git 工作区 ⇒ 显式不判。绝不退回目录黑名单 —— 口径换了却照样跟旧基线逐格比，是最难发现的静默错。
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fmt-nongit-'))
    try {
      fs.writeFileSync(path.join(nonGit, 'a.ts'), 'export const a = 1\n')
      const ng = measureStyle(nonGit, TS, false)
      t(ng.surface === null, '反面失败：非 git 目录却判定扫描面可得（口径换了却照样报数）')
      t(!ng.judged && ng.files === 0, '反面失败：非 git 目录给出了数 / 判成没问题')
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true })
    }

    // 缺输入：不存在的目录 ⇒ judged=false（显式不判），不是"零债务"
    const g = measureStyle(path.join(dir, 'nope-does-not-exist'), TS, false)
    t(!g.judged, '缺输入失败：目录不存在却判成「没问题」')

    // 零容忍（ISS-890 甲案）：违例必须=0 —— 任何一项 count>0 即红，不再有「计数≤上限」的棘轮。
    const zeroBase = { items: Object.fromEntries(ITEMS.map((k) => [k, 0])), ceiling: Object.fromEntries(ITEMS.map((k) => [k, 0])) }
    const zeroCounts = Object.fromEntries(ITEMS.map((k) => [k, 0]))
    t(driftAgainst(zeroBase, zeroCounts).rises.length === 0, '零容忍失败：六项全 0 却点名了')
    const oneViolation = Object.fromEntries(ITEMS.map((k) => [k, 0]))
    oneViolation.arrow_paren_mixed = 1
    const dz = driftAgainst(zeroBase, oneViolation)
    t(dz.rises.length === 1 && dz.rises[0].includes('arrow_paren_mixed'), '零容忍失败：1 处违例没逐项点名（还在用「计数≤上限」判红）')
    t(driftAgainst(zeroBase, Object.fromEntries(ITEMS.map((k) => [k, 2]))).rises.length === ITEMS.length, '零容忍失败：六项都有违例却没逐项点名')
    t(driftAgainst({ items: {}, ceiling: {} }, Object.fromEntries(ITEMS.map((k) => [k, 1]))).rises.length === ITEMS.length, '缺项失败：基线里没有这项却当 0 处理')
    // ceiling 抬到 99 也不许消红（证明判红读的是零容忍、不是 JSON 里的数字）。
    const raised = { items: zeroBase.items, ceiling: Object.fromEntries(ITEMS.map((k) => [k, 99])) }
    t(driftAgainst(raised, oneViolation).rises.length === 1, '零容忍失败：把 ceiling 抬到 99 就消红 ⇒ 抬数字能蒙混过关')

    // 上限形态（nextCeiling）：恒 0 —— --baseline-save 无论当前计数多少都写不出非 0 ceiling。
    // 少这一档的后果是真实的：一次 --baseline-save 就能把 ceiling 写高，零容忍就白装。
    t(ITEMS.every((k) => nextCeiling(Object.fromEntries(ITEMS.map((x) => [x, 22])), Object.fromEntries(ITEMS.map((x) => [x, 99])))[k] === 0), '零容忍失败：ceiling 被写成非 0（抬数字消红的路没堵死）')
    t(ITEMS.every((k) => nextCeiling(null, Object.fromEntries(ITEMS.map((x) => [x, 3])))[k] === 0), '零容忍失败：无基线时 ceiling 没写 0')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  if (bad.length) {
    console.log('format-debt --selftest ✗（跑了 ' + checks + ' 档）')
    for (const b of bad) console.log('  · ' + b)
    process.exit(1)
  }
  console.log('✓ format-debt 自检 ' + checks + ' 档通过：六项各自能红、干净样例为 0、缺目录显式不判、射程只扫 packages/*/*（旧树/scripts 不进）、零容忍违例必红且抬 ceiling 消不掉、基线缺项不蒙混、扫描面只剔临时目录不伤真源码')
  process.exit(0)
}

/* ────────────────────────────────────── 主流程 ────────────────────────────────────── */

if (A.includes("--selftest")) runSelftest()

if (A.includes('--biome')) {
  console.log(JSON.stringify(biomeProbe(), null, 2))
  process.exit(0)
}

const m = measureStyle()
const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : null

if (A.includes('--baseline-save')) {
  const ceiling = nextCeiling(base && base.ceiling, m.count) // 上限只降不升（selftest 直接打这个函数）
  const body = {
    recordedAt: new Date().toISOString(),
    tool: 'format-debt',
    mode: 'zero-tolerance', // ISS-890：与 ceiling 全 0 配套的形态标记，重录时不会丢
    scope: 'packages/*/*',
    items: m.count,
    ceiling,
    files: m.files,
    note: 'ISS-890 甲案：射程 packages/*/* + 零容忍（ceiling 恒 0，违例必须=0；抬数字消不了红）。只检查不改（ISS-726 乙）。引号 / 分号风格在 code-inventory 的 N7 / N8，不在此重算。',
  }
  fs.writeFileSync(BASE, JSON.stringify(body, null, 2))
  console.log(`✓ 基线已存 scripts/baseline/format-debt.json（六项 ${ITEMS.map((k) => `${k}=${m.count[k]}`).join(' ')} · 上限 ${ITEMS.map((k) => ceiling[k]).join('/')}）`)
  process.exit(0)
}

if (A.includes('--json')) {
  const off = {}
  for (const k of ITEMS) off[k] = m.offenders[k].sort((a, b) => b.n - a.n).slice(0, 60)
  console.log(JSON.stringify({ items: m.count, files: m.files, surface: m.surface, judged: m.judged, unreadable: m.unreadable, ceiling: base ? base.ceiling : null, offenders: off }, null, 2))
  process.exit(m.judged ? 0 : 1)
}

if (A.includes('--compare')) {
  if (!base) {
    console.log(headLine(m, null)) // 旧版写成 head( ⇒ ReferenceError ⇒ 基线缺席这条路崩成退出码 1（红），三态里的 2 拿不到
    console.log('  ! 基线缺席 ⇒ 判不了（先跑 node scripts/format-debt.mjs --baseline-save；没基线看得见数，看不见趋势）')
    process.exit(2)
  }
  const d = driftAgainst(base, m.count)
  const L = [headLine(m, base)]
  for (const x of d.moved) L.push('  ' + x)
  if (!d.moved.length) L.push(`  · 六项与基线逐格相同（同一命令产出，才算对照）`)
  // ISS-635 三态（口径同 ISS-586 的 ws.sh）：0 绿 / 1 红 / 2 判不了。
  // 零容忍（ISS-890 甲案）：六项任一 count>0 ⇒ 1；全 0 ⇒ 0。ceiling 恒 0、只留档不判红，
  // 抬 JSON 里的数字也消不掉红。git 读不到 / 文件读不到 ⇒ 2（判不了，不冒充绿）。
  if (d.rises.length) L.push('  ✗ 零容忍违约：' + d.rises.join(' · ') + ' —— 违例必须=0（进退出码）')
  else L.push('  ✓ 六项零违例（射程 packages/*/* · 零容忍，ceiling 恒 0）')
  if (!m.judged) L.push(undecidedNote(m))
  console.log(L.join('\n'))
  process.exit(d.rises.length ? 1 : m.judged ? 0 : 2)
}

const lines = [headLine(m, base)]
for (const k of ITEMS) lines.push(`  · ${LABEL[k].padEnd(14)} ${String(m.count[k]).padStart(6)}`)
if (!base) lines.push('  ! 无基线 ⇒ 先跑 --baseline-save')
if (!m.judged) lines.push(undecidedNote(m))
if (A.includes('--verbose')) {
  for (const k of ITEMS) {
    const off = m.offenders[k].sort((a, b) => b.n - a.n).slice(0, 12)
    if (!off.length) continue
    lines.push(`  [${k}]`)
    for (const o of off) lines.push(`      ${String(o.n).padStart(5)}  ${o.k}`)
  }
}
console.log(lines.join('\n'))
