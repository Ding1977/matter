// scripts/caliber-lib.mjs
// 两处**度量口径**的判据本体（ISS-624）：H5a 的宿主注入豁免、D5 的已退役包识别。
//
// 为什么外置成模块：`code-inventory.mjs` 自带一条规矩 —— 贴着 K2a 的 1000 行红线，加能力先外置
// （ISS-742 起的惯例，lexical-lib / dup-detail-lib / route-ledger-lib 都是这么来的；本文件是第四件）。
//
// 为什么判据是**纯函数**（依赖从 ctx 注入）：口径最怕的是"今天手工验一次绿，明年没人知道它还准不准"。
// 注入之后 `--selftest-caliber` 能拿假仓库喂正反两面的用例，变异验证变成常驻门禁而不是一次性动作。
// 判据与用例在同一个文件 → 改判据的人必然看见用例（不会出现"改了算法、用例留在原地绿"）。

/** H5a 的**宿主注入模块**集合：说明符整串 → 应在 engines 里出现的键名。整串匹配，子路径不放行。 */
const HOST_INJECTED = new Map([['vscode', 'vscode']]) // 只在 hostInjectedWhy 内部用 ⇒ 不 export（Z2 量的是零引用导出，为一支内部判据加 export 会把数顶高一格）

/**
 * 该 import 是否属于「宿主注入」、「凭什么」。
 * @returns {string|null} 非空 = 豁免证据串（写进 H5a 的 note，让豁免本身可数）；null = 照旧判违例
 *
 * 三条**全中**才免，缺一条就照旧记违例：
 *   ① 说明符整串命中 HOST_INJECTED —— `vscode/foo` 这类子路径不放行（那才是真解析不到）
 *   ② 从该文件目录**向上第一个** package.json 里 `engines.<键>` 或 `extensionKind` 有声明
 *      ⇒ 证明"这个目录确实是一个扩展工程"，不是普通源码目录（只靠目录名像不算数）
 *   ③ 那份 package.json 所在目录**不在根 workspaces 里** —— 扩展随 vsix 装进宿主，不是本仓构建对象
 *
 * 原口径的问题（为什么要有这条豁免）：`vscode` 由 VSCode / TraeCode 扩展宿主**运行时注入**，
 * 扩展工程既不该也不需要把它写进 dependencies（真写进去反而装不上），也不存在"换台机器即崩"。
 * 旧口径把它记成「未声明且解析不到（ISS-504 同型）」= 纯误报。实测 offender：
 * `forge-trae-direct/trae-extension/extension.js:31` 的 `require("vscode")`。
 */
export function hostInjectedWhy(relPath, spec, ctx) {
  const engKey = HOST_INJECTED.get(spec)
  if (!engKey) return null // ①
  let dir = ctx.dirname(relPath)
  while (dir && dir !== '.' && !dir.startsWith('..')) {
    if (ctx.hasPkg(dir)) {
      if (ctx.isDeclared(dir)) return null // ③ 本仓 workspace 包 ⇒ 普通源码目录，宿主不会往这里注入
      const pj = ctx.pkgJson(dir)
      const eng = pj.engines && pj.engines[engKey]
      if (!eng && !pj.extensionKind) return null // ② 这个目录不是扩展工程
      return `${dir}/package.json ${eng ? `声明 engines.${engKey}=${eng}` : '声明 extensionKind'}`
    }
    dir = ctx.dirname(dir)
  }
  return null
}

/**
 * 把共享层名单分成「在役」与「已退役」。D5 的分母只该是在役的那几个。
 * @param {{shared: string[], isDeclared: (p: string) => boolean, importsOf: (p: string) => Set<string>, extraTargets?: () => string[]}} ctx
 * @returns {{rows: {k: string, n: number}[], live: {k: string, n: number}[], retired: {k: string, n: number}[]}}
 *
 * **四条**全中才判退役：
 *   ① 不在根 package.json 的 workspaces 里（不参与构建/锁/typecheck）
 *   ② 零消费者 —— **用 import 说明符判**（`importsOf`），不用包级 depEdges：后者只记 `forge-*` 说明符，
 *      对 `electron-shell` 这种名字结构性看不见，拿它判会把"看不见"当成"没有"
 *   ③ 目录还在（待清理的遗留）或目录已删（名单残留）—— 同一件事的两种形态，调用方分开点名
 *   ④ **不在开发面名单**（`extraTargets`：调用方传 `ci-local.mjs` 的 `EXTRA_TARGETS`）——
 *      这类目录不在 workspaces、也可能零 import，但它是**本仓开发面**：有 package.json、有测试、
 *      在 CI 射程里。ISS-624 独立审查 F2 实测：`electron-shell` 正是这个形状（lsof 7 个监听），
 *      只按 ①② 判会把它误判成"已退役待清理"，等于给一个在用的目录挂"该删"标签。
 *
 * ⚠️ **反例（必须仍计入）**：在 workspaces 里但零消费者的共享包 —— 那才是「要么该下沉的没沉，
 *    要么包多余」的真信号。它不满足 ①。
 * ⚠️ 每次运行重算、不写死跳过名单：包一旦被 import 回来（②失效）、重新进 workspaces（①失效）、
 *    或被移出开发面名单（④失效）⇒ 自动回到统计里，豁免不会变成永久后门。
 * ⚠️ `extraTargets` 省略时按空数组处理 ⇒ 退回到"不看开发面"的旧行为。**失效方向是多报一个退役，
 *    不是漏掉真问题** —— 与 K9c 的「多报 < 漏报」同一取舍。
 */
export function classifyShared({ shared, isDeclared, importsOf, extraTargets = () => [] }) {
  const rows = shared.map((k) => ({ k, n: importsOf(k).size }))
  /* 退役判据三条全中：① 不在 workspaces ② 零**可见**消费者 ③（目录在/已删由调用方点名形态）
   *
   * ⚠️ 2026-10-19 独立审查 F2 抓到的错：只看 ①② 会把 `electron-shell` 判成退役。
   *    它确实不在 workspaces、也确实零 import —— 但它是**本仓开发面**的一部分：
   *    `scripts/ci-local.mjs:61` 的 EXTRA_TARGETS 明列它（"非 workspace、但属于本仓开发面的目录
   *    （ISS-764）：目前只有 electron-shell —— 它有 package.json、有 4 个测试文件"），
   *    且 lsof 实测 7 个 Electron 监听、在 CI 射程与 shell-tsc 类型族里。
   *    ⇒ 加第三条：**在开发面名单里的一律不算退役**。判据从名单现读，不写死。
   *
   * 消费者用 `importsOf`（import 说明符）而非包级 depEdges：后者只记 `forge-*`，
   * 对 `electron-shell` 这种名字结构性看不见 —— 把"看不见"当成"没有"，正是这次判错的机制。 */
  const onDev = new Set(extraTargets())
  const retired = rows.filter((r) => !isDeclared(r.k) && r.n === 0 && !onDev.has(r.k))
  return { rows, live: rows.filter((r) => !retired.includes(r)), retired }
}

/** ISS-624 selftest：两处口径的**正反控制**。只喂假事实、不碰真仓库 ⇒ 毫秒级，可常驻 guard。 */
export function selftestCaliber() {
  const cases = []
  const push = (name, ok) => cases.push({ name, ok })
  const mkCtx = (pkgs, declaredDirs) => ({
    dirname: (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'),
    hasPkg: (d) => Object.hasOwn(pkgs, d),
    pkgJson: (d) => pkgs[d],
    isDeclared: (d) => declaredDirs.includes(d),
  })
  const ext = mkCtx({ 'forge-trae-direct/trae-extension': { engines: { vscode: '^1.70.0' } }, 'forge-x': {} }, [])
  // ── H5a：阳性（该免）──
  push('H5a ① 扩展目录 + engines.vscode 声明 ⇒ 豁免（本单的真实 offender 形状）',
    !!hostInjectedWhy('forge-trae-direct/trae-extension/extension.js', 'vscode', ext))
  push('H5a ② 只有 extensionKind、没有 engines 也免（两种声明等价，判据是同一条）',
    !!hostInjectedWhy('a/ext/extension.js', 'vscode', mkCtx({ 'a/ext': { extensionKind: ['workspace'] } }, [])))
  push('H5a ③ 向上逐级找到包声明即免（文件在 src/ 子目录里）',
    !!hostInjectedWhy('a/ext/src/deep/x.js', 'vscode', mkCtx({ 'a/ext': { engines: { vscode: '^1.0.0' } } }, [])))
  // ── H5a：阴性（不许免 —— 这四条就是变异验证）──
  push('H5a ④ **真解析不到**的第三方包照样抓（no-such-pkg 不在宿主注入集里）',
    hostInjectedWhy('forge-pm/lib/x.js', 'no-such-pkg', ext) === null)
  push('H5a ⑤ workspace 包内写 vscode ⇒ 不免（③ 不命中：宿主不会往业务包目录注入）',
    hostInjectedWhy('forge-x/lib/x.js', 'vscode', mkCtx({ 'forge-x': { engines: { vscode: '^1.70.0' } } }, ['forge-x'])) === null)
  push('H5a ⑥ 子路径说明符 vscode/foo ⇒ 不免（① 整串匹配，子路径才是真解析不到）',
    hostInjectedWhy('forge-trae-direct/trae-extension/extension.js', 'vscode/foo', ext) === null)
  push('H5a ⑦ 扩展目录里没有 engines/extensionKind 声明 ⇒ 不免（② 不命中：只有目录名像不算数）',
    hostInjectedWhy('a/ext/extension.js', 'vscode', mkCtx({ 'a/ext': {} }, [])) === null)
  push('H5a ⑧ 一个 package.json 都没有（裸源码目录）⇒ 不免',
    hostInjectedWhy('loose/x.js', 'vscode', mkCtx({}, [])) === null)
  // ── D5 ──
  const imports = (map) => (k) => new Set(map[k] || [])
  const ret = classifyShared({ shared: ['forge-a', 'forge-b', 'forge-c'], isDeclared: (k) => k !== 'forge-c', importsOf: imports({ 'forge-a': ['p'], 'forge-b': [] }) })
  push('D5 ① 不在 workspaces + 零消费者 ⇒ 判退役，并从 live 里移出', ret.retired.map((r) => r.k).join() === 'forge-c' && ret.live.map((r) => r.k).join() === 'forge-a,forge-b')
  push('D5 ② **在 workspaces 里却零消费者 ⇒ 不许判退役**（那是"该沉的没沉/包多余"的真信号）',
    ret.retired.every((r) => r.k !== 'forge-b') && ret.rows.find((r) => r.k === 'forge-b').n === 0)
  push('D5 ③ 不在 workspaces 但**有消费者** ⇒ 不许判退役（被用了就不是退役，是漏登记）',
    classifyShared({ shared: ['forge-c'], isDeclared: () => false, importsOf: imports({ 'forge-c': ['p'] }) }).retired.length === 0)
  push('D5 ④ 退役判定不吃写死名单：消费者一出现立刻回到统计里（豁免不是永久后门）',
    classifyShared({ shared: ['forge-c'], isDeclared: (k) => k === 'forge-c', importsOf: imports({}) }).retired.length === 0)
  // ── D5 ⑤：**不在 workspaces 却有消费者** —— 本单变异验证踩到的盲区（旧写法会让它彻底消失）
  push('D5 ⑤ 不在 workspaces 但有消费者：不算退役（③ 不命中）且仍留在 rows 里可见',
    (() => { const r = classifyShared({ shared: ['forge-c'], isDeclared: () => false, importsOf: imports({ 'forge-c': ['forge-pm'] }) }); return r.retired.length === 0 && r.live.length === 1 && r.live[0].n === 1 })())

  // ── D5 ⑥⑦：**开发面名单**（ISS-624 F2）—— 本单被独立审查抓到的误判
  push('D5 ⑥ 在开发面名单里 ⇒ 不算退役（electron-shell 的真实形状：不在 workspaces、零 import，但在用）',
    (() => { const r = classifyShared({ shared: ['electron-shell'], isDeclared: () => false, importsOf: () => new Set(), extraTargets: () => ['electron-shell'] }); return r.retired.length === 0 && r.live.length === 1 })())
  push('D5 ⑦ 不在开发面名单 + 不在 workspaces + 零消费者 ⇒ 仍判退役（⑥ 不是无条件豁免）',
    (() => { const r = classifyShared({ shared: ['forge-x'], isDeclared: () => false, importsOf: () => new Set(), extraTargets: () => ['electron-shell'] }); return r.retired.length === 1 && r.live.length === 0 })())

  console.log('code-inventory --selftest-caliber（ISS-624 · 假事实，不扫真仓库）')
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}`)
  const fails = cases.filter((c) => !c.ok)
  console.log(fails.length ? `\n✗ ${fails.length}/${cases.length} 失败 —— 口径没牙` : `\n✓ ${cases.length}/${cases.length} 项通过：H5a 该免的免、真问题照样抓；D5 退役与真信号不混`)
  return fails.length ? 2 : 0
}

/* CLI 入口：`node scripts/caliber-lib.mjs --selftest`（门禁 guard-baselines.sh 就照这条调）。
   ⚠️ 必须真的把退出码传出去：没有入口的话 node 跑一个纯模块是 exit 0 —— 守卫会显示
   「自检通过」而其实**一个用例都没跑**，那是一条没有牙的门禁。 */
if (process.argv[1] && /caliber-lib\.mjs$/.test(process.argv[1])) {
  if (!process.argv.includes('--selftest')) { console.error('用法：node scripts/caliber-lib.mjs --selftest'); process.exit(2) }
  process.exit(selftestCaliber())
}
