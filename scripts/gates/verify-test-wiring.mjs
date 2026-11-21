#!/usr/bin/env node
// scripts/verify-test-wiring.mjs
// 测试接线门禁（ISS-710）—— 防「写了测试，但没有任何执行路径会跑它」。
//
// ## 为什么要有这条
//   scripts/guard-baselines.sh 有一格「门禁的端到端变异测试」，原先写成
//     "$BUN" test scripts/lint-layer.test.mjs scripts/lint-writer-uniqueness.test.mjs --isolate
//   —— **点名两个文件**。于是同目录下另外两个测试文件
//     （scripts/lint-capability-contract.test.mjs / scripts/watch-home-links.test.mjs）
//   写在盘上、真有用例，却**一次也没有被任何门禁执行过**。
//   比「少跑了」更坏的是**屏幕上没有任何一行是红的**：读者看到 `✓ 变异测试通过`，
//   会以为这一片有人在看着，实际那两个文件的用例常年不跑、坏了也没人知道。
//
//   把清单改宽（`scripts/*.test.mjs`）能补今天的洞，补不了明天：下一个人新建
//   `scripts/foo.test.mjs`，只要有人顺手把它从执行路径里漏掉，它又会静默地不跑。
//   所以本判据射的不是「这两个文件跑没跑」，而是**「盘上的测试文件」与「执行路径选中的文件」
//   两个集合的关系** —— 判据落在**东西之间的关系**上，不落在名字上。
//   （同源先例：secret-scan 的 isPlaceholderToken 判的是占位符本身的形状，不是它在哪个文件里。）
//
// ## 判据（一条，双向）
//   W1 ⛔ `scripts/*.test.mjs` 每一个都必须被至少一条执行路径选中。
//        · 执行路径 = 下面的 EXEC_PATHS（缺哪个跳过哪个：run-gates.mjs 只在某些分支上存在）
//        · 「选中」= 文件里有一行**同时**满足「带跑步器」与「指向这个测试文件」，两种写法都认：
//            （直呼）`"$BUN" test scripts/*.test.mjs --isolate`
//            （转手）`set -- scripts/*.test.mjs` + 另有一行 `"$BUN" test "$@" --isolate`
//        · A ⊄ B ⇒ 红，**点名到文件**；A = ∅ ⇒ 同样红（分母为 0 不许冒充绿）。
//
//   为什么「同一行要有跑步器」才算：只有「提到」不算执行。ISS-701 的注释里就写着
//   `scripts/lint-layer.test.mjs` 这串字 —— 按全文 grep 会把它算成「已接线」，而它当时正是不跑的那个。
//   判据要落在**会被执行的那一行**上，不是落在「文件里出现过这个字符串」上。
//
//   为什么认「`set --` + `$@`」这一对：那是 shell 里「先定集合再统一跑」的正常写法，
//   漏认它会把正当接线判成没接线（误伤比缺门禁更赶人）。认的仍然是那一对**行**，
//   不是「文件里出现过 `set --`」。
//
// ## 豁免（必须有牙）
//   scripts/baseline/test-wiring-exempt.json 的 `exempt` 数组，每条 {file, reason}：
//   · `reason` 为空 / 纯空白 ⇒ **不算豁免，照样判红**（「用一句空话消红」比红更坏 —— 同 lint-code K 号口径）
//   · 被豁免的文件后来接上了 ⇒ 报「白名单已失效（该摘）」（双向失效检测，同 lint-common）
//   · 指向不存在的文件 ⇒ 报「白名单指向的文件不存在」
//   豁免是最后手段：默认全部接上，接不上才登记理由。**不许拿空理由换绿。**
//
// ## 用法
//   node scripts/verify-test-wiring.mjs --check       # 判（guard-baselines.sh 的 selfcheck 走这一档）
//   node scripts/verify-test-wiring.mjs --json        # 机器读：tests / wired / uncovered / findings
//   node scripts/verify-test-wiring.mjs --selftest    # 19 条正反例：见文件末 selftest()
//
// 退出码：0 绿 / 1 红 / 2 判不了（豁免名单读不动等）。**只读**：不写任何文件、不跑任何测试。
//
// 为什么复用 lint-common 骨架：白名单双向失效（stale/gone）与「守卫自己也要被守」的口径已经在那里，
// 本文件只提供 A、B 两个集合与一条规则；自己再抄一份失效检测就是又一份会腐坏的副本。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLint } from '../lint-common.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..')

/** A 的射程：与 `lint-mutation-tests` 那一格**同一个 glob**，扫目录不点名。 */
const GLOB = 'scripts/*.test.mjs'

/** 可能执行测试的路径。缺哪个就跳过哪个（run-gates.mjs 只在某些分支上存在）。 */
// ISS-800：`scripts/guard-baselines.sh` 已退役（它的 `lint-mutation-tests` 内联块是原执行面）。
// 该格迁到 `scripts/lib/inline-gates.mjs`（badge:"inline"），执行面随之改指那里 ——
// 不换的话本判据会在 EXEC_PATHS 里留一条指向不存在文件的路径，9 个测试文件全部误判成「没被选中」。
// ISS-820：该格从 inline-gates.mjs 的 `custom:` 闭包**外化成真实脚本**
// `scripts/gates/lint-mutation-tests.mjs`（连同 client-artifacts / project-code-rules-size）——
// 执行面第三次搬家，同一条理由：射程跟着执行面走，不跟名字走。
const EXEC_PATHS = [
  // ⚠️ `scripts/lib/inline-gates.mjs` 已随 ISS-820 删除（4 格全数迁进 registry），
  //    执行面整体换到下面这条。它留在这里不会误判（缺失的路径按「跳过」处理），
  //    但会让人以为还有两处执行面 —— 删掉。
  'scripts/gates/lint-mutation-tests.mjs',
  'scripts/run-gates.mjs',
  'scripts/ci-local.mjs',
  '.github/workflows/ci.yml',
  'package.json',
]

/** 豁免名单。理由为空 = 没有理由 = 不算豁免。 */
const MANIFEST = 'scripts/baseline/test-wiring-exempt.json'

const RULE = 'W1'
const RULE_WHY = '写了 *.test.mjs 却没有任何执行路径选中它 ⇒ 这个测试永远不会跑，而屏幕上没有任何一行是红的'

/* ───────────────────────── A：盘上的测试文件 ───────────────────────── */

/** 只扫一层：与 GLOB 同射程（递归就是另一条判据、另一张单）。 */
function listTests(root) {
  const dir = path.join(root, 'scripts')
  let ents = []
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return ents
    .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
    .map((e) => `scripts/${e.name}`)
    .sort()
}

/** 射程外盘点：本判据只压 scripts 一层，nested 的测试文件仍没人跑 —— 报出来，不静默跳过。
 *  （报而不判红：它们的跑法不同（plain node 脚本不能塞进 `bun test`），是另一张单的事；
 *   但「漏在射程外」与「补上了」不是一回事，屏幕必须说出来。） */
function outOfScope(root) {
  const out = { nestedMjs: [], testSh: [] }
  const walk = (dir) => {
    let ents = []
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        const rel = path.relative(root, p).split(path.sep).join('/')
        const depth = rel.split('/').length
        if (e.name.endsWith('.test.mjs') && depth > 2) out.nestedMjs.push(rel)
        else if (e.name.endsWith('.test.sh')) out.testSh.push(rel)
      }
    }
  }
  walk(path.join(root, 'scripts'))
  out.nestedMjs.sort()
  out.testSh.sort()
  return out
}

/* ───────────────────────── B：执行路径选中的测试文件 ───────────────────────── */

/** 抹掉注释与纯打印（按行，够用且可预测）。JSON 不许注释 ⇒ 原文即代码。
 *
 * 为什么连 `echo` / `printf` 也要抹：本文件自己的报错文案就是
 *   `echo "!  scripts/*.test.mjs 的变异测试未跑：本机没有 bun（不冒充绿）"`
 * —— 同一行里既有 `bun` 也有 glob。不抹掉它，一句"没跑"的报错会被算成"接线了"，
 * 判据就在最该红的那一格上判绿。`echo` 不执行任何东西，抹掉它不损失任何执行证据。 */
function stripComment(rel, line) {
  const ext = path.extname(rel)
  if (ext === '.json') return line
  if (ext === '.mjs' || ext === '.js') return line.replace(/(^|\s)\/\/.*$/, '')
  const code = line.replace(/(^|\s)#.*$/, '')
  return /^\s*(echo|printf)\b/.test(code) ? '' : code
}

/** 跑步器：「提到」不等于「执行」，这条是分界。 */
const RUNNER = /(\bbun\b|\bnode\b|\bnpx\b|\bbash\b|--test\b|\$BUN\b|\$NODE\b)/

/** 行内指向测试文件的候选：字面路径或 glob；`"$REPO"/` 前缀剥掉再比（绝对路径是 shell 里的正常写法）。 */
const TEST_TOKEN = /(?:"?\$\{?REPO\}?"?\/)?[\w./*-]+\.test\.mjs/g
const unRepo = (tok) => tok.replace(/^"?\$\{?REPO\}?"?\//, '').replace(/^\.\//, '')

/** 先定集合的写法：`set -- <glob|路径 ...>`。 */
const DECLARE = /^set\s+--\s+(.+)$/

function globToRe(glob) {
  const body = glob
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${body}$`)
}

/** 把一个 token 解析成它选中的测试文件（字面/末尾匹配/glob 三种）。 */
function select(rawTok, tests) {
  const tok = unRepo(rawTok)
  if (tok.includes('*')) return tests.filter((t) => globToRe(tok).test(t))
  // 字面路径两种写法都算：`scripts/x.test.mjs` 与 `$REPO/scripts/x.test.mjs` 选的是同一个文件。
  return tests.filter((t) => t === tok || tok.endsWith(`/${t}`))
}

/** 返回 rel → `执行路径:行号`（第一次命中的位置 —— 红的时候要指得出来）。 */
function coveredBy(tests, execPaths, root) {
  const hit = new Map()
  const mark = (list, where) => {
    for (const t of list) if (!hit.has(t)) hit.set(t, where)
  }
  for (const rel of execPaths) {
    let text
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n').map((raw) => stripComment(rel, raw))
    // ① 直呼：跑步器与测试文件在**同一行**
    lines.forEach((line, i) => {
      if (!line.trim() || !RUNNER.test(line)) return
      for (const tok of line.match(TEST_TOKEN) || []) mark(select(tok, tests), `${rel}:${i + 1}`)
    })
    // ② 转手：`set -- <集合>` + 另有一行跑步器跑 `"$@"`（行号取跑的那一行，红的时候指得出去）
    const declared = []
    for (const line of lines) {
      const m = DECLARE.exec(line.trim())
      if (!m) continue
      for (const tok of m[1].match(TEST_TOKEN) || []) declared.push(...select(tok, tests))
    }
    if (declared.length) {
      const runnerAt = lines.findIndex((l) => RUNNER.test(l) && /"\$@"/.test(l))
      if (runnerAt >= 0) mark(declared, `${rel}:${runnerAt + 1}`)
    }
  }
  return hit
}

/* ───────────────────────── 豁免名单 ───────────────────────── */

function loadManifest(root, rel) {
  let raw
  try {
    raw = fs.readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return [] // 没有名单 = 没有豁免（正常状态：没豁免就要求全部接上，不是"没配就放绿"）
  }
  let j
  try {
    j = JSON.parse(raw)
  } catch (e) {
    throw new Error(`豁免名单不是合法 JSON：${rel}（${e.message}）`)
  }
  const list = Array.isArray(j) ? j : Array.isArray(j.exempt) ? j.exempt : null
  if (!list) throw new Error(`豁免名单形状不对：${rel} 应为 {"exempt":[{"file","reason"}]}`)
  return list
    .filter((e) => e && typeof e === 'object' && e.file)
    .map((e) => ({ file: String(e.file).split(path.sep).join('/'), reason: e.reason }))
}

/* ───────────────────────── 判 ───────────────────────── */

function judge(root = REPO, { execPaths = EXEC_PATHS, manifestPath = MANIFEST } = {}) {
  const tests = listTests(root)
  const execFound = execPaths.filter((p) => fs.existsSync(path.join(root, p)))
  const covered = coveredBy(tests, execPaths, root)
  const exempt = loadManifest(root, manifestPath)

  const lint = createLint({
    name: 'verify-test-wiring',
    root,
    files: () => tests.map((t) => path.join(root, t)),
    rules: [
      {
        id: RULE,
        why: RULE_WHY,
        check: () => {
          // 分母为 0 不许冒充绿：一个测试文件都没扫到，说明这条判据没在工作（glob 被挪走 / 目录改名）。
          if (!tests.length) {
            return [{ file: GLOB, detail: '一个 *.test.mjs 都没扫到（分母为 0 ⇒ 判据没在工作，不许当绿）' }]
          }
          return tests
            .filter((t) => !covered.has(t))
            .map((t) => ({
              file: t,
              detail: `没有任何执行路径选中它（${execFound.join(' / ')} 里没有一条带跑步器的行会跑它）`,
            }))
        },
      },
    ],
    whitelist: { [RULE]: exempt },
  })

  const res = lint.run()

  // 空理由的豁免：lint-common 只认「有没有这一条」，不认「理由是不是空的」。
  // 这里补上 —— 理由是这条机制唯一的代价，缺了它就退化成「用一句空话消红」。
  // 已被其它检查覆盖的（后来接上了 ⇒ stale 那档会报）不重复计。
  for (const e of exempt) {
    if (String(e.reason || '').trim()) continue
    if (covered.has(e.file)) continue
    if (!fs.existsSync(path.join(root, e.file))) continue
    res.findings.push({
      rule: RULE,
      level: 'block',
      why: '豁免必须带理由：理由为空说明没人解释过为什么它可以不跑',
      file: e.file,
      line: null,
      detail: '豁免理由为空 ⇒ 不算豁免（红在「用空话消红」上，不是红在测试上）',
    })
  }

  const uncovered = tests.filter((t) => !covered.has(t))
  return { root, tests, covered, uncovered, exempt, execFound, res, text: lint.format(res), outside: outOfScope(root) }
}

/* ───────────────────────── --selftest：守卫自己要有牙 ───────────────────────── */

function selftest() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'test-wiring-selftest-'))
  const total = { n: 0, bad: 0 }
  const ok = (name, cond, extra = '') => {
    total.n += 1
    if (cond) console.log(`  ✓ ${name}`)
    else {
      total.bad += 1
      console.log(`  ✗ ${name}${extra ? ` —— ${String(extra).slice(0, 300)}` : ''}`)
    }
  }
  const tree = (files) => {
    const d = fs.mkdtempSync(path.join(base, 'case-'))
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(d, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body)
    }
    return d
  }
  // ⚠️ 这里的路径名只活在**临时树**里（`tree()` 拿它在 mkdtemp 下造文件），不读真实仓库。
  //    保留 `guard-baselines.sh` 这个名字是刻意的：下面的夹具全是 bash 形态（DIRECT / LITERAL / VIA_SET），
  //    换成真实入口 `scripts/lib/inline-gates.mjs`（.mjs）会让 8/19 条自检失去被测对象而挂。
  //    ⇒ 真实执行路径由上面的 `EXEC_PATHS` 管，与这里无关，别把两者混为一谈。
  const EP = ['scripts/guard-baselines.sh']
  const MF = 'scripts/baseline/exempt.json'
  const DIRECT = '#!/usr/bin/env bash\nif ( cd "$REPO" && "$BUN" test scripts/*.test.mjs --isolate ) >/dev/null 2>&1; then :; fi\n'
  // 点名式（只覆盖 a）：用来证明"漏一个会红"、"豁免三态" —— glob 那种覆盖全部，测不了这些。
  const LITERAL = '#!/usr/bin/env bash\nif "$BUN" test scripts/a.test.mjs --isolate >/dev/null 2>&1; then :; fi\n'
  const VIA_SET = '#!/usr/bin/env bash\nset -- scripts/*.test.mjs\n[ -f "$1" ] || exit 3\n"$BUN" test "$@" --isolate\n'
  const man = (exempt) => JSON.stringify({ exempt }, null, 1)
  const run = (files) => {
    try {
      return judge(tree(files), { execPaths: EP, manifestPath: MF })
    } catch (e) {
      return { threw: String((e && e.message) || e) }
    }
  }

  // ① 覆盖了就是绿（否则这条判据恒红，等于没有这条判据）
  {
    const r = run({ 'scripts/guard-baselines.sh': DIRECT, 'scripts/a.test.mjs': '' })
    ok('覆盖了就绿（A ⊆ B ⇒ exit 0）', !r.threw && r.text.exit === 0, r.threw || r.text.text)
    ok('读数对得上：1 个测试文件 / 已接线 1', !r.threw && r.tests.length === 1 && r.covered.has('scripts/a.test.mjs'))
  }

  // ② 只接线一个、另一个漏了 ⇒ 红，且点名到漏的那个、不误伤已接线的
  {
    const r = run({ 'scripts/guard-baselines.sh': LITERAL, 'scripts/a.test.mjs': '', 'scripts/zz.test.mjs': '' })
    ok('漏接一个 ⇒ 红（exit 1）', !r.threw && r.text.exit === 1, r.threw || `exit ${r.threw ? '' : r.text.exit}`)
    ok('红的时候点名到漏的那个文件', !r.threw && /✗ W1\s+scripts\/zz\.test\.mjs/.test(r.text.text))
    ok('已接线的那个不误伤', !r.threw && !/✗ W1\s+scripts\/a\.test\.mjs/.test(r.text.text))
  }

  // ③ `set -- 集合` + `"$@"` 的正当接线要认（漏认 = 误伤，误伤比缺门禁更赶人）
  {
    const r = run({ 'scripts/guard-baselines.sh': VIA_SET, 'scripts/a.test.mjs': '' })
    ok('认「set -- glob + "$@"」这一对（exit 0）', !r.threw && r.text.exit === 0, r.threw || r.text.text)
    ok('并且说得清是哪一行跑的', !r.threw && String(r.covered.get('scripts/a.test.mjs')).includes('guard-baselines.sh:'))
  }

  // ④ 只有 set --、没有跑步器跑 $@ ⇒ 不算接线（否则「定了集合没跑」也是绿）
  {
    const r = run({ 'scripts/guard-baselines.sh': '#!/usr/bin/env bash\nset -- scripts/*.test.mjs\n', 'scripts/a.test.mjs': '' })
    ok('只 set -- 没跑 $@ ⇒ 仍红（定了集合不等于跑了）', !r.threw && r.text.exit === 1, r.threw || `exit ${r.threw ? '' : r.text.exit}`)
  }

  // ⑤ 只在注释里提到 glob ⇒ 不算接线（否则一句注释就能把红说成绿）
  {
    const r = run({ 'scripts/guard-baselines.sh': '# 跑法：bun test scripts/*.test.mjs\n', 'scripts/a.test.mjs': '' })
    ok('注释里提到 glob 不算接线（仍红）', !r.threw && r.text.exit === 1, r.threw || `exit ${r.threw ? '' : r.text.exit}`)
  }

  // ⑤b `echo` 里印出「没跑 + glob + bun」不算接线（本条是实测踩出来的：
  //     本文件自己的报错文案就长这样，不抹掉它，最该红的那一格会判绿）
  {
    const r = run({
      'scripts/guard-baselines.sh': '#!/usr/bin/env bash\necho "!  scripts/*.test.mjs 未跑：本机没有 bun（不冒充绿）"\n',
      'scripts/a.test.mjs': '',
    })
    ok('echo 里印出「未跑 + glob + bun」不算接线（仍红）', !r.threw && r.text.exit === 1, r.threw || `exit ${r.threw ? '' : r.text.exit}`)
  }

  // ⑥ 分母为 0 ⇒ 红（扫空不是"全接上了"）
  {
    const r = run({ 'scripts/guard-baselines.sh': DIRECT, 'scripts/README.md': '' })
    ok('一个测试文件都没扫到 ⇒ 红（分母为 0 不许冒充绿）', !r.threw && r.text.exit === 1, r.threw || `exit ${r.threw ? '' : r.text.exit}`)
  }

  // ⑦ 带理由的豁免 ⇒ 绿
  {
    const r = run({
      'scripts/guard-baselines.sh': LITERAL,
      'scripts/a.test.mjs': '',
      'scripts/b.test.mjs': '',
      [MF]: man([{ file: 'scripts/b.test.mjs', reason: 'plain script，由 node 直跑：bun test 吃它只报 0 pass' }]),
    })
    ok('带理由的豁免 ⇒ 绿（exit 0）', !r.threw && r.text.exit === 0, r.threw || r.text.text)
  }

  // ⑧ 理由为空/纯空白 ⇒ 不算豁免
  {
    const r = run({
      'scripts/guard-baselines.sh': LITERAL,
      'scripts/a.test.mjs': '',
      'scripts/b.test.mjs': '',
      [MF]: man([{ file: 'scripts/b.test.mjs', reason: '   ' }]),
    })
    ok('豁免理由为空 ⇒ 红（exit 1）', !r.threw && r.text.exit === 1, r.threw || `exit ${r.threw ? '' : r.text.exit}`)
    ok('并且点明是「理由为空」，不是「没接线」', !r.threw && /豁免理由为空/.test(r.text.text))
  }

  // ⑨ 豁免是化石：文件后来接上了 ⇒ 红，要求摘掉
  {
    const r = run({ 'scripts/guard-baselines.sh': LITERAL, 'scripts/a.test.mjs': '', [MF]: man([{ file: 'scripts/a.test.mjs', reason: '本来不该跑' }]) })
    ok('豁免指向已接线的文件 ⇒ 报化石 ⇒ 红', !r.threw && r.text.exit === 1, r.threw || `exit ${r.threw ? '' : r.text.exit}`)
    ok('并且点明「白名单已失效（该摘）」', !r.threw && /白名单已失效（该摘）/.test(r.text.text))
  }

  // ⑩ 豁免指向不存在的文件 ⇒ 红
  {
    const r = run({ 'scripts/guard-baselines.sh': LITERAL, 'scripts/a.test.mjs': '', [MF]: man([{ file: 'scripts/gone.test.mjs', reason: '已删' }]) })
    ok('豁免指向不存在的文件 ⇒ 红', !r.threw && r.text.exit === 1, r.threw || `exit ${r.threw ? '' : r.text.exit}`)
    ok('并且点明「不存在」', !r.threw && /不存在/.test(r.text.text))
  }

  // ⑪ 名单坏掉 ⇒ 判不了（不是绿、也不是"当没豁免"）
  {
    const r = run({ 'scripts/guard-baselines.sh': LITERAL, 'scripts/a.test.mjs': '', [MF]: '{ 不是 json' })
    ok('豁免名单坏掉 ⇒ 判不了（抛错，由调用方报 2）', !!r.threw, r.threw || '没抛错')
  }

  try {
    fs.rmSync(base, { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
  console.log(total.bad ? `✗ ${total.bad}/${total.n} 条自检没过` : `✓ ${total.n} 条自检全过`)
  return total.bad ? 1 : 0
}

/* ───────────────────────── CLI ───────────────────────── */

if (process.argv.slice(2).includes('--selftest')) process.exit(selftest())

let R
try {
  R = judge()
} catch (e) {
  console.log(`✗ verify-test-wiring 判不了：${e.message}`)
  process.exit(2)
}

const ARG = process.argv.slice(2)

if (ARG.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        glob: GLOB,
        tests: R.tests,
        wired: Object.fromEntries(R.covered),
        uncovered: R.uncovered,
        exempt: R.exempt,
        execPaths: R.execFound,
        findings: R.res.findings,
        stale: R.res.stale,
        gone: R.res.gone,
        exit: R.text.exit,
      },
      null,
      1
    )
  )
  process.exit(R.text.exit)
}

console.log(
  `测试接线（ISS-710）· ${GLOB} ${R.tests.length} 个 · 执行路径 ${R.execFound.length} 个 · 已接线 ${R.tests.length - R.uncovered.length} · 豁免 ${R.exempt.length}`
)
console.log(R.text.text)
const outside = [...R.outside.nestedMjs, ...R.outside.testSh]
if (outside.length) {
  console.log(
    `·  射程外另有 ${R.outside.nestedMjs.length} 个嵌套 *.test.mjs、${R.outside.testSh.length} 个 *.test.sh 同样没有任何门禁执行（同一类缺陷，跑法不同，不在本判据射程内 —— 别把这行当"已覆盖"）`
  )
}
if (R.uncovered.length) {
  console.log('      → 接上：这一段进 scripts/guard-baselines.sh 的测试格（扫目录，别点名）；')
  console.log(`        真跑不了（如 plain script 需 node 直跑）就在 ${MANIFEST} 里登记 **非空** 理由`)
}
process.exit(R.text.exit)
