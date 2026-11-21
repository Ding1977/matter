#!/usr/bin/env node
// scripts/host-typecheck-ratchet.mjs
// 类型门禁的「棘轮」—— 只许降不许升（ISS-706 · ISS-763 · PRJ-016）
// 用法：node scripts/host-typecheck-ratchet.mjs [--check|--write|--selftest|--verbose] [--family host|client] [--strict]
// --strict（或环境变量 FORGE_RATCHET_STRICT=1）= CI 严格档：任何「没在判」的行都算红（防 CI 绿着而门禁其实没跑）
//
// **两族**（ISS-763 起）：host 半（`tsconfig.lib.json`，19 包，存量有欠账 ⇒ 逐包上限）与
// client 半（`tsconfig.json` + 有 `src/`，实测 20 包**全 0 错** ⇒ 零错误阻塞门禁）。
// 为什么合成一个脚本而不是新开一份：同一套"该红能红 / 还原即绿 / 缺记录必红"的自检骨架与本文件里
// 那两个已修的坑（`ceilings` 取值、整份覆盖会抹顶层字段）不该被抄第二遍 —— K6b 的账。
//
// 为什么不一步到位把 host 也做成"零错误阻塞"：
//   实测 12 个待纳管包里 3 个确实 0 错误（forge-shell / forge-combo-model 等，原名单含已退役的文件中心插件），
//   其余 8 个共约 940 处，而大头是 TS2339/TS2307/TS2591 —— 多数源于**这些包没装 @types/node**
//   （全仓只有 forge-pm 与 forge-ui 有），少部分是 host 半长期无类型覆盖留下的 JSDoc 缺口。
//   把它们一次性判红 = 门禁长期红灯 = 逼人绕过（forge-ui/tsconfig.lib.json 的注释里写死了这条教训）。
//   棘轮的口径：**今天记录现状为上限，任何新增错误当场红** —— 既立刻有牙，又不假装历史是干净的。
//   client 族没有这个历史包袱（实测 0），所以直接上"零错误"这一档。
//
// 退出码：0 = 全部不超上限 · 1 = 有包超上限或有包缺测 · 2 = 脚本自身异常（tsc 找不到等）
import { execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const ARGV = process.argv.slice(2)
const MODE = ARGV.includes('--write') ? 'write' : ARGV.includes('--selftest') ? 'selftest' : 'check'
// CI 严格档：--strict 或 FORGE_RATCHET_STRICT=1（本地 guard 不开：工作树里没产物是常态，长红的门禁等于没有门禁）
const STRICT = ARGV.includes('--strict') || process.env.FORGE_RATCHET_STRICT === '1'
/** 两族的差别集中在这张表里；其余逻辑共用（同骨架、同自检、同上限文件形状） */
const FAMILIES = [
  {
    key: 'host',
    label: 'host 半',
    cfg: 'tsconfig.lib.json',
    srcDir: 'lib',
    ceiling: path.join(ROOT, 'scripts', 'baseline', 'host-checkjs.json'),
    // host 族纳管条件与旧版一致：有 lib/ 且有 tsconfig.lib.json
    include: (p) => fs.existsSync(path.join(ROOT, p, 'lib')) && fs.existsSync(path.join(ROOT, p, 'tsconfig.lib.json')),
  },
  {
    key: 'client',
    label: 'client 半',
    cfg: 'tsconfig.json',
    srcDir: 'src',
    ceiling: path.join(ROOT, 'scripts', 'baseline', 'client-tsc.json'),
    // client 族纳管条件：有 src/ 且有 tsconfig.json ⇒ 4 个只有 lib/ 的包（archive/cli-provider/combo-model/services）
    // 自然不进射程，不需要白名单（它们的 tsconfig.json 其实"指不到东西"，已记进 ISS-723 待处置）
    include: (p) => fs.existsSync(path.join(ROOT, p, 'src')) && fs.existsSync(path.join(ROOT, p, 'tsconfig.json')),
  },
  {
    // ISS-764 甲案：electron-shell 是**非 workspace** 目录（CI 侧由 ci-local 的 EXTRA_TARGETS 收进去，乙案已做），
    // 它此前连 tsconfig 都没有 ⇒ 3357 行含桥鉴权，类型 0 覆盖。这一族纳的就是它。
    key: 'shell',
    label: '壳（非 workspace）',
    cfg: 'tsconfig.lib.json',
    srcDir: '',
    ceiling: path.join(ROOT, 'scripts', 'baseline', 'shell-tsc.json'),
    include: (p) => p === 'electron-shell' && fs.existsSync(path.join(ROOT, p, 'tsconfig.lib.json')),
  },
]

/** 非 workspace 但要有类型门禁的目录（与 scripts/ci-local.mjs 的 EXTRA_TARGETS 同名单 —— 两处不一致就有一边在自欺） */
const NON_WORKSPACE_TARGETS = ['electron-shell']
const wantFamilies = () => {
  const i = ARGV.indexOf('--family')
  if (i < 0) return FAMILIES
  const key = ARGV[i + 1]
  const hit = FAMILIES.filter((f) => f.key === key)
  if (!hit.length) { console.error(`✗ 未知族：${key}（可选 ${FAMILIES.map((f) => f.key).join(' / ')}）`); process.exit(2) }
  return hit
}

/** tsc 用仓库里已有的 typescript（不新增依赖） */
function tscBin() {
  for (const c of ['forge-ui/node_modules/typescript/bin/tsc', 'forge-pm/node_modules/typescript/bin/tsc', 'node_modules/typescript/bin/tsc']) {
    if (fs.existsSync(path.join(ROOT, c))) return path.join(ROOT, c)
  }
  return null
}
/** 待纳管包 = 满足该族 include 条件的 workspace 包 */
function targets(fam) {
  const ws = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).workspaces || []
  return [...ws, ...NON_WORKSPACE_TARGETS].filter((p) => fam.include(p))
}
/** 「只有缺生成产物这一种错」⇒ 不算欠账（工作树里没跑 build:client 的正常状态，ISS-729/ISS-756 同族） */
function artifactOnly(errs) {
  return errs.length > 0 && errs.every((l) => /error TS2307/.test(l) && /\.generated['"]/.test(l))
}
/**
 * 「装齐」探针（ISS-774）：壳族是**非 workspace** 目录 ⇒ 根 `bun install` 不管它，
 * 它的类型面靠 `electron-shell/node_modules/{@types/node, electron, bun-types}`。
 * 缺这些时 tsc **少报错**而不是多报错（09-23 实测：同一份代码，主树 35 条、工作树 2 条 ——
 * 因为 'electron' 解析不到 ⇒ 大量表达式退化成 any ⇒ 形状问题全部隐形）。
 * 也就是说"计数变低"在这种树里不是收敛，是**门禁没在跑**；拿它去 `--write` 就是把上限从 35 悄悄录成 2。
 * 所以：这种树里本族**不判**（打印说明，不判红也不判绿），且 `--write` 必须保留旧上限。
 * 自测靠 FORGE_SHELL_TYPE_PROBE 指到临时目录，不去动真树（动真树被 kill 会把主库弄脏）。
 */
function unprovisioned(pkg, fam) {
  if (fam.key !== 'shell') return null
  const base = process.env.FORGE_SHELL_TYPE_PROBE || path.join(ROOT, pkg)
  const missing = ['@types', 'electron', 'bun-types'].filter((n) => !fs.existsSync(path.join(base, 'node_modules', n)))
  return missing.length ? `缺 node_modules/${missing.join('、')}` : null
}

function countErrors(pkg, tsc, fam) {
  const r = spawnSync(process.execPath, [tsc, '-p', fam.cfg, '--noEmit'], { cwd: path.join(ROOT, pkg), encoding: 'utf8', maxBuffer: 1 << 28 })
  const out = (r.stdout || '') + (r.stderr || '')
  const errs = out.split('\n').filter((l) => /error TS\d+/.test(l))
  return { count: errs.length, sample: errs.slice(0, 3), exit: r.status, artifactOnly: artifactOnly(errs) }
}

/** 上限文件的形状：{ recordedAt, tool, ceilings: { pkg: n } } —— 读取只认 ceilings（第一版按顶层取，结果全部"未记录"） */
function readCeilings(file) {
  if (!fs.existsSync(file)) return {}
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  return j && j.ceilings && typeof j.ceilings === 'object' ? j.ceilings : j
}
/**
 * 平台豁免（ISS-823）：壳族那一条**唯一的原生依赖** `electron-window-glass@1.0.0` 在
 * `electron-shell/bun.lock` 里带 `"os": "darwin"` ⇒ linux runner 上 `bun install` 根本不装它，
 * tsc 因此比 macOS 多一条 `TS2307 Cannot find module`（09-25 CI 实测：`main.js(122,25)`；
 * 本机与全新克隆在 macOS 上都是 0 错）。这不是代码错，是**平台事实**：这一族在 linux 上判不了。
 * 为什么不是"把上限改成 1"：那等于让上限跟着 runner 的 OS 漂，同一份代码两个真相，
 * 而且换来的是一条谁都不可能在 linux 上修掉的红 —— 本仓自己的教训：长红的门禁等于没有门禁。
 * 范围关到最小：**只有壳族 + 只有非 darwin**；darwin 上这条豁免拿不到（selftest 有反向控制），
 * 所以它不能被人当逃生口用。真正的覆盖来自 macOS 侧本地 guard 跑同一脚本同一上限。
 */
const platformNow = () => process.env.FORGE_RATCHET_PLATFORM || process.platform
const shellUnjudgeableHere = (fam) => fam.key === 'shell' && platformNow() !== 'darwin'

/**
 * CI 严格档（ISS-751③ 的后半）：把**没在判**的行显成违例。
 * 为什么只在 CI 开：本仓工作树里没有 dist/、壳的 devDeps 也只手工装 ⇒ 本地"跳过"是常态，
 * 长红的门禁等于没有门禁（人人直接无视）；而 CI 是「装齐 + 先 build:client」的树，
 * 那里再出现跳过就说明**产物没生成 / 依赖没装 / 射程被收紧** —— 绿着比红更危险。
 * 只挑"没判"的行：超上限那类仍由 runCheck 的 bad 负责，这里不双计。
 * 唯一的例外是上面那条**平台豁免**：它在任何 linux runner 上都不可能变成"在判"，
 * 算红只会得到一条无人能修的常驻红，所以放行（但那一行照样打给看见日志的人，不是静默）。
 */
function strictViolations(rows, strict) {
  return strict ? rows.filter((r) => r.judged === false && !r.platformSkip) : []
}
/**
 * 跑一遍对账。
 * @param ceilingsOf ISS-783 新增的**只读替身**口：`(fam) => ceilings`，不给就按磁盘上的真实上限读。
 *   存在的理由：自检要试"缺记录 / 超上限"两种假形状，而把假形状**写到盘上那份**在硬中断时会留在盘上
 *   （见下面 selftest 里那段注释）。假形状只在内存里成立 ⇒ 真实基线在自检期间是只读的。
 */
/**
 * @param opts.only  **只对这些包真跑 tsc**（ISS-727：selftest 用，--check 不传 = 全族）
 *   ⚠️ 它只收「实际跑哪些包」，**不收射程**：上面"名册里消失了"那一档仍按**全族**名册判 ——
 *   若拿收窄后的名册去判，其余 22 个包全会被报成"名册里消失"，把一条真判据变成 22 条假红。
 */
function runCheck(tsc, fams, ceilingsOf, opts) {
  const capsOf = ceilingsOf || ((f) => readCeilings(f.ceiling))
  const only = opts && opts.only ? new Set(opts.only) : null
  const rows = []
  let bad = 0
  for (const fam of fams) {
    const ceilings = capsOf(fam)
    // fullRoster = 射程（真·纳管面）；runList = 这一轮真跑 tsc 的包
    const fullRoster = new Set(targets(fam))
    const inRoster = only ? new Set([...fullRoster].filter((p) => only.has(p))) : fullRoster
    if (shellUnjudgeableHere(fam)) {
      // 整族跳过（含下面"名册消失"那一档）：这一族在本平台根本没有可信计数。
      rows.push({ fam: fam.key, famLabel: fam.label, pkg: 'electron-shell', count: null, cap: ceilings['electron-shell'] ?? null, state: `非 darwin 平台（${platformNow()}）：electron-window-glass 带 os:darwin 装不上 ⇒ 本族不判，由 macOS 侧本地 guard 覆盖（ISS-823）`, sample: [], ao: false, skip: true, judged: false, platformSkip: true, ok: true })
      continue
    }
    for (const pkg of inRoster) {
      const up = unprovisioned(pkg, fam)
      if (up) {
        // 不判红也不判绿：红会让所有树都长红（壳的 devDeps 只能手工装），绿会假装"收敛了"。
        rows.push({ fam: fam.key, famLabel: fam.label, pkg, count: null, cap: ceilings[pkg] ?? null, state: `未装齐（${up}）⇒ 本族不判，计数不可信（ISS-774）`, sample: [], ao: true, skip: true, judged: false, ok: true })
        continue
      }
      const { count, sample, artifactOnly: ao } = countErrors(pkg, tsc, fam)
      const cap = ceilings[pkg]
      let state
      if (ao) { state = '未构建产物（跳过：只有 .generated 缺失这一种错，跑 build:client 后再看）' }
      else if (cap === undefined) { state = '无上限记录'; bad++ }
      else if (count > cap) { state = `超上限 ${cap} → ${count}`; bad++ }
      else if (count < cap) { state = `低于上限（可收线 ${cap} → ${count}）` }
      else state = count === 0 ? '零错误（阻塞门禁）' : '等于上限'
      // ok 与 bad 同源：跳过（未构建产物）不算红，也**不许在画面上显示成 ✗** —— 早一版就是这么打印的，
      // 「判红 10」里其实 8 个是「无上限记录」（首录前的正常态）、2 个是跳过项，看着像十处欠账。
      rows.push({ fam: fam.key, famLabel: fam.label, pkg, count, cap: cap === undefined ? null : cap, state, sample, ao, judged: !ao, ok: ao || (cap !== undefined && count <= cap) })
    }
    // 纳管面**悄悄缩小**要判红（ISS-763 的新用例逼出来的）：上限文件里还有它、而纳管条件不再收它 ——
    // 改名、删包、或有人把 include 条件收紧，都会让一行上限**静默消失**。这与 lint-code 的"化石"同一纪律：
    // 欠账清了要删条目，条目与名册对不上就是红。`--write` 会把消失的包点名打出来。
    // ⚠️ 用 fullRoster 而不是 inRoster：`only` 收窄的是「跑几个 tsc」，不是「谁该在名册里」（ISS-727）。
    for (const pkg of Object.keys(ceilings)) {
      if (fullRoster.has(pkg)) continue
      rows.push({ fam: fam.key, famLabel: fam.label, pkg, count: null, cap: ceilings[pkg], state: '名册里消失了（上限文件还有它，纳管条件不再收 —— 改名/删包/条件收紧都长这样）', sample: [], judged: true, ok: false })
      bad++
    }
  }
  return { rows, bad }
}

if (MODE === 'selftest') {
  // 反向验证（**逐族**跑）：① 人为注入一处新类型错误 → 必红 ② 还原 → 必绿 ③ 上限记录缺项 → 必红 ④ 超上限必红
  const tsc = tscBin()
  if (!tsc) { console.error('✗ 找不到 tsc'); process.exit(2) }
  const results = []
  // ISS-783 的**结论级**钉子（开头快照、结尾对账）：自检跑完，三份真实上限文件必须逐字节没动。
  // 为什么留这一条而不是只改写法：写法是这一版对的，下一版有人再引一个写盘点就又错了 ——
  // "靠读代码的人记得"不成立，得让下一轮自检自己抓出来。
  // 自测测的是**棘轮的牙**，不是跑它的那台机器的 OS ⇒ 全程按 darwin 判（生产 `--check` 不受影响：
  //   平台豁免在 linux 上照样生效，且下面有两条用例专门验它）。
  //   不这么做的话 linux runner 上壳族那几档会拿到「平台不合」这一行，四条断言抓不到自己要验的东西 ——
  //   09-25 在 CI 上红 4 项，在 CI 同形克隆（壳依赖 provisioned）里用 FORGE_RATCHET_PLATFORM=linux 逐条复现。
  const savedPlatSelftest = process.env.FORGE_RATCHET_PLATFORM
  process.env.FORGE_RATCHET_PLATFORM = 'darwin'
  const capsSnap = FAMILIES.map((f) => [f.label, f.ceiling, fs.existsSync(f.ceiling) ? fs.readFileSync(f.ceiling) : null])
  for (const fam of wantFamilies()) {
    // 未装齐的树里**别拿假计数做注入实验**（09-23：壳在本类树里恒报 2 条 ⇒ "注入后 > 基线"必然假红，
    // 而"上限缺项会报 / 超上限必红"两条也必然假红 —— 三条红会把人引去查一个不存在的回归）。
    const probePkg0 = targets(fam)[0]
    if (probePkg0 && unprovisioned(probePkg0, fam)) {
      results.push([`${fam.label}：未装齐 ⇒ 牙验不了（明确报出，而不是假红或假装通过）`, true,
        `${probePkg0} ${unprovisioned(probePkg0, fam)} —— 要验这一族的牙，先在 ${probePkg0} 里装 devDeps（非 workspace，根 install 不管它）`])
      continue
    }
    // ISS-764：原来只认"零错误的包"，于是**有余量的族（如壳，35 处存量）根本验不了牙**。
    // 改成断言**增量**：记基线 B ⇒ 注入后必须 > B ⇒ 还原后必须 == B。对零错族 B=0，与原断言完全等价。
    //
    // ISS-727：**这里原来扫全族取「错误最少」的包**（`targets(fam).map(countErrors).sort()[0]`），
    //   39 个包就 39 次完整 tsc。那是为**旧断言**服务的 —— 旧断言要 `n === 0`，所以得先找出一个零错的包。
    //   ISS-764 改成增量断言后，**任何包都能验牙**（B 由它自己现算，不要求 0），这个 min 只剩成本。
    //   ⇒ 改成确定性地挑一个包：族内字典序第一个（跨平台稳定，不依赖 readdir 顺序）。
    //   ⚠️ 探针注入/还原仍在这个包上真跑 tsc —— 牙的分量不变，只是不再为「挑包」先扫全族。
    const roster = targets(fam)
    const cand = roster.length ? { p: [...roster].sort()[0] } : null
    if (!cand) { results.push([`${fam.label}：有包可做注入实验`, false, '这一族一个目标都没有 ⇒ 牙验不了（不许静默跳过）']); continue }
    const pkg = cand.p
    // 基线 B 现算（原来白拿的那次 min 顺带算出来了，现在单独跑一次：1 次 tsc，必须留着）
    const baseN = countErrors(pkg, tsc, fam).count
    // ⚠️ 两个"探针不被收录/不报错"的坑（都踩过）：
    //  ① host 族的 `tsconfig.lib.json` 是 `include: ["lib/**/*.js"]` ⇒ 探针必须是 **.js**（写成 .ts 直接没进编译，计数 0 ⇒ 假红）；
    //  ② 探针内容必须是**真的类型错**：早一版写 `(a as unknown as {foo})` 是合法 TS，编译过 ⇒ 同样计数 0。
    const probe = path.join(ROOT, pkg, fam.srcDir, fam.key === 'host' ? '__ratchet_selftest__.js' : '__ratchet_selftest__.ts')
    try {
      fs.writeFileSync(probe, 'const s = "x"\nexport const b = s.foo() // 故意制造 TS2339\n')
      const withBug = countErrors(pkg, tsc, fam)
      results.push([`${fam.label}：该红能红（注入一处类型错误）`, withBug.count > baseN, `${pkg} 错误数 ${baseN} → ${withBug.count}`])
    } finally {
      fs.rmSync(probe, { force: true })
    }
    const clean = countErrors(pkg, tsc, fam)
    results.push([`${fam.label}：还原即绿（同一包回到注入前）`, clean.count === baseN, `${pkg} 错误数 ${baseN} → ${clean.count}`])
    // ── ISS-783：这两种假形状**只活在内存里**，真实上限文件在本函数全程只读 ──
    // 原来这里有两个写盘点（先把 probe2 那一键摘掉、再把 ceilings 整体压成 `{pkg: -1}`），靠 finally 复原。
    // finally 挡得住异常与 SIGTERM，挡不住 SIGKILL：09-25 在工作树里用 SIGKILL 打进那个窗口稳定复现 ——
    // 18 键的 client-tsc.json 只剩 1 键，而 recordedAt/tool 全在（所以它**看着像一份合法基线**），
    // 下一次 `--check` 对整族报「无上限记录」，guard 全量跟着红，而红的原因看着像"有人删了基线"。
    // 09-23 ISS-776 那次加固治的是"中间态丢字段"，没治"中间态本身就少键"——这一类只能从结构上消掉：
    // 自检期间不写真实文件，就没有"记得复原"这件事可忘。
    const realCaps = readCeilings(fam.ceiling)
    const probe2 = targets(fam)[0]
    if (realCaps[probe2] === undefined) {
      results.push([`${fam.label}：上限缺项会报（不当成通过）`, false, `测试前提不成立：${probe2} 本来就没记录`])
    } else {
      const stripped = { ...realCaps }
      delete stripped[probe2]
      const miss = runCheck(tsc, [fam], () => stripped, { only: [probe2] })
      results.push([`${fam.label}：上限缺项会报（不当成通过）`, miss.rows.some((r) => r.pkg === probe2 && r.state === '无上限记录') && miss.bad > 0, `摘掉 ${probe2} 的记录后判红 ${miss.bad} 项`])
    }
    // 超上限这一档顺手收紧：原来压成 -1 时**其他包全变"无上限记录"**，`bad > 0` 是被那批假红撑起来的；
    // 现在只改探针自己那一格 ⇒ 红的必须是"这一包超上限"，判据从"有红"升成"红在该红的地方"。
    const over = runCheck(tsc, [fam], () => ({ ...realCaps, [pkg]: -1 }), { only: [pkg] })
    const overRow = over.rows.find((r) => r.pkg === pkg)
    results.push([`${fam.label}：超上限必红（只把 ${pkg} 的上限压成 -1）`,
      !!overRow && /超上限/.test(overRow.state) && over.bad > 0,
      overRow ? `${pkg} 上限 -1 / 计数 ${overRow.count} ⇒ ${overRow.state}（本族共判红 ${over.bad} 项）` : `${pkg} 这一行没出现 ⇒ 这条没牙`])
  }
  // 族级反向验证：把一个包从纳管条件里摘掉 ⇒ `--check` 必须报"名册里消失了"（防"悄悄缩小射程"）
  {
    const fam = FAMILIES[0]
    const victim = targets(fam)[0]
    const saved = fam.include
    fam.include = (p) => p !== victim && saved(p)
    // ISS-727：这一档**一次 tsc 都不用跑**。判据是「victim 那一行要被报成『名册里消失了』」，
    // 而那一行是 `ceilings` 与 fullRoster 的差集算出来的 —— 与被摘包的错误数无关。
    // `only: []` ⇒ 一个包都不真跑，只走名册对账（改前这里白跑了 host 全族 11 次 tsc）。
    const shrunk = runCheck(tsc, [fam], undefined, { only: [] })
    fam.include = saved
    const hit = shrunk.rows.find((r) => r.pkg === victim)
    results.push(['摘掉一个包的纳管条件 ⇒ 判"名册里消失了"（不是静默少一行）',
      !!hit && /名册里消失/.test(hit.state) && shrunk.bad > 0,
      hit ? `${victim}: ${hit.state}` : `${victim} 整行都没出现 ⇒ 这条没牙`])
  }
  // ISS-774 的牙：壳族「未装齐 ⇒ 不判」这条必须两头都能红/能绿。
  // 用临时目录当探针目标，**不动真树**（动真树要是被 kill 会把主库弄脏 —— 有过前科）。
  {
    const shellFam = FAMILIES.find((f) => f.key === 'shell')
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-shell-'))
    const savedProbe = process.env.FORGE_SHELL_TYPE_PROBE
    // ISS-823 的连带修正：这一段验的是**「未装齐 ⇒ 不判」**那套语义（靠临时目录当假现场），
    //   而新加的平台豁免在 runCheck 里排在它**前面** —— linux runner 上整族先被"平台不合"跳过，
    //   这几条断言就抓不到自己要验的东西（本地 `FORGE_RATCHET_PLATFORM=linux` 复现：2 条红；CI 上 4 条红）。
    //   ⇒ 修法改在**selftest 入口整体按 darwin 跑**（见上面 capsSnap 之后那段），不在这里各钉一处。
    try {
      process.env.FORGE_SHELL_TYPE_PROBE = fixture
      const bare = unprovisioned('electron-shell', shellFam)
      const checkBare = runCheck(tsc, [shellFam])
      const bareRow = checkBare.rows.find((r) => r.pkg === 'electron-shell')
      results.push(['未装齐 ⇒ 本族不判（不报错数、也不算绿）',
        !!bare && !!bareRow && /未装齐/.test(bareRow.state) && bareRow.count === null, String(bare)])
      // 反向控制：把三样都"装上" ⇒ 必须回到判（否则这条判据恒真，等于永远跳过）
      for (const n of ['@types/node', 'electron', 'bun-types']) fs.mkdirSync(path.join(fixture, 'node_modules', n), { recursive: true })
      process.env.FORGE_SHELL_TYPE_PROBE = fixture
      const after = unprovisioned('electron-shell', shellFam)
      results.push(['装齐后回到判（反向控制，防"恒跳过"）', after === null, after === null ? '已装齐' : `仍报未装齐：${after}`])
      // host/client 两族不受这条影响（它们是 workspace，根 install 管得到）
      results.push(['host/client 族不做"未装齐"跳过（只有壳族需要）',
        unprovisioned('forge-pm', FAMILIES[0]) === null && unprovisioned('forge-ui', FAMILIES[1]) === null, 'ok'])
      /* ── ISS-823：平台豁免两头都要有牙 ──
         豁免本身是给"linux runner 上装不了 darwin 专有原生依赖"这一条平台事实让路的，
         但它同时是一条**能让壳族永远不出现在检查里**的通道 ⇒ 必须钉住它的边界：
         非 darwin 才生效、生效时报的是"平台不合"而不是伪装成"未装齐"或绿，
         而在 darwin 上（也就是老板与本仓开发机真实跑门禁的地方）**拿不到**这条豁免。 */
      const savedPlat = process.env.FORGE_RATCHET_PLATFORM
      try {
        process.env.FORGE_RATCHET_PLATFORM = 'linux'
        const off = runCheck(tsc, [shellFam])
        const offRow = off.rows.find((r) => r.pkg === 'electron-shell')
        results.push(['非 darwin ⇒ 壳族报"平台不合"，且不算超上限、不被严格档算违例（ISS-823）',
          !!offRow && /非 darwin 平台/.test(offRow.state) && off.bad === 0 && strictViolations(off.rows, true).length === 0,
          offRow ? offRow.state.slice(0, 40) : '整行都没出现 ⇒ 豁免没落地'])
        process.env.FORGE_RATCHET_PLATFORM = 'darwin'
        const on = runCheck(tsc, [shellFam])
        const onRow = on.rows.find((r) => r.pkg === 'electron-shell')
        results.push(['反向控制：darwin 上拿不到平台豁免（防它变成逃生口）',
          !!onRow && !onRow.platformSkip && !/非 darwin 平台/.test(onRow.state),
          onRow ? onRow.state.slice(0, 30) : '整行都没出现'])
      } finally {
        if (savedPlat === undefined) delete process.env.FORGE_RATCHET_PLATFORM
        else process.env.FORGE_RATCHET_PLATFORM = savedPlat
      }
      /* ── ISS-751③ 的后半：CI 上「没在判」必须是红，本地仍按常态放过 ──
         为什么分开判：guard 在本仓天天跑，工作树里没有 dist/、没装壳的 devDeps 是常态，
         长红会让人直接无视这条门禁；而 CI 是**装齐 + 先构建**的树，那里还出现"跳过"就等于门禁没在跑，
         绿着比红更危险（本单第①条当年就是这么烂掉的：产物没生成 ⇒ 8 个包悄悄不判）。 */
      results.push(['CI 严格档：把"未装齐/未构建产物"这类没在判的行显成违例',
        strictViolations(checkBare.rows, true).length === 1 && strictViolations(checkBare.rows, true)[0].pkg === 'electron-shell',
        JSON.stringify(checkBare.rows.map((r) => r.judged))])
      results.push(['本地默认档：同样这些行不判红（工作树未构建是常态，长红=没人看）',
        strictViolations(checkBare.rows, false).length === 0, 'ok'])
      results.push(['CI 严格档也认"未构建产物"为没判（ao 行）',
        strictViolations([{ pkg: 'forge-pm', judged: false, ao: true }], true).length === 1, 'ok'])
      results.push(['反向控制：判过的行（含超上限）在严格档里不重复计违例（防恒红、防双计）',
        strictViolations([{ pkg: 'a', judged: true, ok: true }, { pkg: 'b', judged: true, ok: false }], true).length === 0, 'ok'])
    } finally {
      if (savedProbe === undefined) delete process.env.FORGE_SHELL_TYPE_PROBE
      else process.env.FORGE_SHELL_TYPE_PROBE = savedProbe
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  }
  // ── ISS-783 的两条结论级对账（前面所有档位都跑完之后才判）──
  const wrecked = capsSnap.filter(([, file, buf]) => {
    const now = fs.existsSync(file) ? fs.readFileSync(file) : null
    return buf === null ? now !== null : !buf.equals(now)
  })
  results.push(['自检全程不改写真实上限文件（残骸从结构上消失，不靠 finally 记得复原）',
    wrecked.length === 0, wrecked.length ? `${wrecked.map(([l]) => l).join(' · ')} 的上限文件被动过` : `${capsSnap.length} 族上限文件逐字节未变`])
  // 探针文件是**写进包里**的（必须进编译才有错可数）⇒ 硬中断会把它留在源码目录里，
  // 下一轮 --check 就变成一处真错误（症状是"某包凭空超上限"）。留残留必须在这条上露出来。
  const leftovers = []
  for (const fam of FAMILIES) {
    for (const p2 of targets(fam)) {
      for (const ext of ['.js', '.ts']) {
        if (fs.existsSync(path.join(ROOT, p2, fam.srcDir, `__ratchet_selftest__${ext}`))) leftovers.push(`${p2}/${fam.srcDir}/__ratchet_selftest__${ext}`)
      }
    }
  }
  results.push(['自检结束不留探针文件（被 SIGKILL 打断过也会在这里露出来）',
    leftovers.length === 0, leftovers.join(' · ') || '全族目标包里都没有残留'])
  let fail = 0
  console.log(`host-typecheck-ratchet --selftest（${FAMILIES.length} 族：${FAMILIES.map((f) => f.label).join(' · ')}）`)
  for (const [n, ok, note] of results) { console.log(`  ${ok ? '✓' : '✗'} ${n}（${note}）`); if (!ok) fail++ }
  console.log(fail ? `\n✗ 反向验证失败 ${fail} 项` : '\n✓ 棘轮有牙：注入必红、还原必绿、缺记录与超上限都判红、纳管面被悄悄缩小也能看见')
  process.exit(fail ? 1 : 0)
}

const tsc = tscBin()
if (!tsc) { console.error('✗ 找不到 typescript（forge-ui / forge-pm / root 的 node_modules 都没有）'); process.exit(2) }
if (MODE === 'write') {
  let risenAll = []
  for (const fam of wantFamilies()) {
    const map = {}
    // 记录时把「只有 .generated 缺失」的包按 0 记：与 --check 的跳过口径一致。
    // 不然工作树（无产物）与主树（有产物）两种态来回判红/绿，等于给"没跑 build:client"造一条假欠账。
    const raw0 = fs.existsSync(fam.ceiling) ? JSON.parse(fs.readFileSync(fam.ceiling, 'utf8')) : {}
    const prev0 = raw0.ceilings || {}
    const unprov = []
    for (const pkg of targets(fam)) {
      const up = unprovisioned(pkg, fam)
      if (up) {
        // 关键的一条：这种树里**沿用旧上限**，而不是把 2 当成新收敛写进去（写进去 = 从此门禁形同虚设）
        if (prev0[pkg] !== undefined) map[pkg] = prev0[pkg]
        unprov.push(`${pkg}（${up}）`)
        continue
      }
      const ce = countErrors(pkg, tsc, fam)
      map[pkg] = ce.artifactOnly ? 0 : ce.count
    }
    if (unprov.length) console.log(`  ⚠️ 未装齐、本族跳过测量并**沿用旧上限**：${unprov.join('；')} —— 要录新数请在 electron-shell 里装 devDeps（非 workspace，根 install 不管它）`)
    const raw = raw0
    // ⚠️ 两个坑一起修（09-23 实证）：
    //  ⑴ 旧版拿 `prev[k]` 比，但上限是嵌在 `ceilings` 下的 ⇒ 每个包都成"undefined→N"，
    //     明明只变了 1 行却报"变化 19 个包"。刷新基线的回显说谎，比不回显更糟
    //     （会让人以为整份文件被重写，从此不信这行输出 —— 而这行正是唯一能看见"降了几格"的地方）。
    //  ⑵ 旧版整份覆盖写 ⇒ 人工加的**顶层字段**会被静默抹掉（同 `lint-code --write` 那次 `reasonPolicy` 事故）。
    const prev = raw.ceilings || {}
    const changed = Object.keys(map).filter((k) => prev[k] !== map[k])
    const risen = changed.filter((k) => prev[k] !== undefined && map[k] > prev[k])
    const fresh = changed.filter((k) => prev[k] === undefined)
    const fell = changed.filter((k) => prev[k] !== undefined && map[k] < prev[k])
    // 从名册里**消失**的包也要说：改名、删包、或 targets() 不再收录它，都会让上限静默少一行。
    const dropped = Object.keys(prev).filter((k) => !(k in map))
    fs.mkdirSync(path.dirname(fam.ceiling), { recursive: true })
    fs.writeFileSync(fam.ceiling, JSON.stringify({ ...raw, recordedAt: new Date().toISOString().slice(0, 10), tool: `host-typecheck-ratchet.mjs --write（${fam.label}）`, ceilings: map }, null, 1))
    const part = (label, ks) => (ks.length ? `${label} ${ks.length}：${ks.map((k) => `${k} ${prev[k]}→${map[k]}`).join(' ')}` : '')
    const bits = [part('↓ 收敛', fell), part('⚠️ 升高', risen), part('＋ 首次记录', fresh)].filter(Boolean)
    console.log(`✓ ${fam.label}上限已记录 ${Object.keys(map).length} 个包（真变化 ${changed.length}${bits.length ? ' —— ' + bits.join(' ｜ ') : '：无'}）`)
    if (dropped.length) console.log(`  · 名册里消失的 ${dropped.length} 个（改名/删包/targets 不再收录都会这样，确认一下别是漏了）：${dropped.join(' ')}`)
    if (risen.length) console.log(`  ✗ ${fam.label} 有 ${risen.length} 个包的存量类型错**变多**了：刷新上限只该用于"确实收敛了或新纳入了包"，升的那几个先查为什么`)
    risenAll = risenAll.concat(risen.map((k) => `${fam.key}:${k}`))
  }
  console.log('  ⚠️ 刷新上限 = 承认这些错误可以继续留着，必须在提交说明里写清为什么')
  process.exit(risenAll.length ? 1 : 0)
}
const { rows, bad } = runCheck(tsc, wantFamilies())
const skipped = strictViolations(rows, STRICT)
const fams = [...new Set(rows.map((r) => r.fam))]
console.log(`类型棘轮 · ${fams.length} 族 · ${rows.length} 个包 · 判红 ${bad + skipped.length}${STRICT ? " · CI 严格档开（没在判的也算红）" : ""}`)
for (const fam of fams) {
  const rs = rows.filter((r) => r.fam === fam)
  console.log(`  ── ${rs[0].famLabel}（${rs.length} 个包）`)
  for (const r of rs) console.log(`  ${r.ao ? '·' : !r.ok ? '✗' : r.count < r.cap ? '↓' : '✓'} ${r.pkg.padEnd(22)} 错误 ${String(r.count === null ? '—' : r.count).padStart(4)} / 上限 ${r.cap === null ? '未记录' : r.cap}  ${r.state}`)
}
// **判红的行自带错误原文**（ISS-819 同一族的纪律：失败不许只留一个数字）。
//   起因是 09-25 那次 CI：`electron-shell 错误 1 / 上限 0` 是当天 CI 唯一的红，但**原文只在样本里、
//   只有 --verbose 才打**，而 guard 调它不带 --verbose ⇒ 云端留下的信息量刚好够让人去猜
//   （本机与全新克隆都是 0 错，猜不出 CI 那 1 条是什么）。放宽的只是**可见性**：
//   判据、上限、退出码一个没动，--verbose 仍然连判过的行一起打。
for (const r of rows) {
  if (ARGV.includes('--verbose') || !r.ok) for (const s of r.sample) console.log(`      ${r.ok ? '·' : '✗'} ${r.pkg}: ${s}`)
}
if (skipped.length) {
  console.log(`  ✗ CI 严格档：${skipped.length} 行「没在判」—— ${skipped.map((r) => `${r.pkg}（${r.state.slice(0, 14)}…）`).join(" ｜ ")}`)
  console.log("    CI 上这一档必须全判过：产物没生成（build:client 没跑到）/ 依赖没装齐 / 纳管条件被收紧，三种都得修，不能放绿")
}
process.exit(bad + skipped.length ? 1 : 0)
