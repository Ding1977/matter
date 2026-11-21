#!/usr/bin/env node
// scripts/dead-exports-lib.mjs
// 死码清单（ISS-732）的**纯加工**与它的自检 —— 从 code-inventory.mjs 里分出来，理由很直白：
// 那份盘点器已经 1000 行在 K2a 的射程里（≥1000 = god module），把新能力塞进去就是把棘轮顶高一格。
// 判据算法（谁算"零引用"）仍然**只在** code-inventory.mjs 一处；这里只做"成员不变、加标记、可复算排序"。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * **三件装载契约名**（ISS-654）：cordis 引擎按名字从 `module.exports` 上取，一个都不许删
 * （删了插件不上电，`build-host.mjs` 第 ④ 步会直接 exit 1）。它们不是"没人用的导出"，
 * 只是"import 解析器看不见有人用" ⇒ 不构成死码债。
 *
 * ⚠️ **这里是唯一一份定义**，`code-inventory.mjs` 从这里 import。为什么不让两处各写一遍：
 * 这两个文件都要用这个名字集 —— code-inventory 算度量 Z2 的坏ness 段，本文件算侧产物的
 * `totals.zeroRefBadness`，而 `audit-doc-sync` 拿两者做**等式对账**。各写一遍 ⇒ 一边改一边忘，
 * 对账当场红（旧版正是这样：一边剔 237 条路径命中、一边按同一路径正则算，收窄判据后立刻分裂）。
 * @type {readonly string[]}
 */
export const LOAD_CONTRACT_NAMES = Object.freeze(['name', 'inject', 'apply'])

/**
 * 全仓字符串字面量池（粗糙但够用）：转义与模板插值会漏，本池只用于给死码清单打 `stringRef` 标记，
 * **不参与任何判据计数** —— 所以宁可多标（提示人去看过一眼）也不假装精确。
 * ⚠️ 自扫描：盘点器自己的源码也进这个池，于是工具的文本会参与测量（A/B 实测：把自检 fixture 的名字
 *    从真名 PROTOCOL_VERSION 换成 `__fx_decl__` 这类带前缀的名字，全仓 stringRef 从 152 回到 150）。
 *    ⇒ 两条纪律：① 自检 fixture 一律带 `__fx_` 前缀；② stringRef 只是"去看过一眼"的提示，**不是判据**。
 * @param {string} source 文件原文
 * @param {Map<string,number>} pool 累加进这个池
 */
export function addStringsToPool(source, pool) {
  for (const m of source.matchAll(/(["'`])([^"'`\n]{2,60})\1/g)) {
    const s = m[2]
    if (/^[A-Za-z_$][A-Za-z0-9_$]{1,59}$/.test(s)) pool.set(s, (pool.get(s) || 0) + 1)
  }
}

/**
 * 给符号级零引用导出打标 + 稳定排序。**不增不删**：成员与度量 Z2 同源，
 * 否则会出现"清单说 529 条、度量说 838 条"这种两份真相。
 * @param {{name:string,k:string,line:number,pkg:string,kind:string}[]} items
 * @param {Map<string,number>} stringPool
 * @param {RegExp} entryRe 入口判据（与 Z1 同源）
 * @param {{artifacts?:Map<string,{artifact:string,mentions:Set<string>}>, prodTokens?:Map<string,Set<string>>, testTokens?:Map<string,Set<string>>}} [opts]
 *        两条**消费通道**的数据源（都不传 ⇒ 只出老的三个标记，口径向后兼容）
 */
export function annotateDead(items, stringPool, entryRe, opts = {}) {
  const { artifacts, prodTokens, testTokens } = opts
  const cmp = (a, b) => a.pkg.localeCompare(b.pkg) || a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name)
  return items
    .map((e) => {
      const flags = []
      // 声明文件（.d.ts）与实现文件是同一批名字的**第二份**：算进账本就是双计（实测本仓 131 条）
      if (/\.d\.ts$/.test(e.k)) flags.push('declFile')
      // 入口/装配面：引擎按名字取用（ctx 插件入口、工具注册表），机器看不见 ⇒ 单靠"没人 import"判死必误
      if (entryRe.test(e.k)) flags.push('entryFile')
      // 名字以字符串形态在全仓出现过：动态 import / 反射 / 配置表都可能用到 ⇒ 只是"要人过一眼"的提示
      if (stringPool.has(e.name)) flags.push('stringRef')
      // 第二条消费通道：自己的编译产物（入库的 static/）里用了这个名字 ⇒ 删源必须连产物一起处理，不是"没人用"
      if (artifacts?.get(e.k)?.mentions.has(e.name)) flags.push('builtArtifactSource')
      // 除自己声明的文件以外，生产代码一次没提过、只被测试文本提过 ⇒ 钉住它的是断言里那串字，不是行为
      // （⚠️ 这条**不等于**"可以删"：测试会红，得先改测试；它只是把"看起来有人用"从"其实没人用"里分出来）
      if (testTokens?.get(e.name)?.size && prodTokens && ![...(prodTokens.get(e.name) ?? [])].some((f) => f !== e.k)) flags.push('testPinnedBySourceText')
      return { pkg: e.pkg, file: e.k, line: e.line, name: e.name, kind: e.kind || '', flags }
    })
    .sort(cmp)
}

/** 反向验证：三条标记各有判别力、打标不改成员、两次跑逐字节相同。返回进程退出码。 */
export function selftestDead() {
  const ENTRY = /(\/lib\/index\.js$|\/src\/dsh\/client-entry\.tsx?$|^electron-shell\/|(^|\/)scripts\/|\/dsh\/)/
  const pool = new Map([['__fx_build__', 3], ['__fx_other__', 1]])
  const items = [
    { name: '__fx_build__', k: 'forge-pm/lib/index.js', line: 7, pkg: 'forge-pm', kind: 'function' },
    { name: '__fx_absent__', k: 'scripts/util.mjs', line: 3, pkg: 'scripts', kind: 'const' },
    { name: '__fx_aaa__', k: 'forge-pm/lib/a.js', line: 1, pkg: 'forge-pm', kind: 'function' },
    { name: '__fx_decl__', k: 'forge-x/lib/index.d.ts', line: 8, pkg: 'forge-x', kind: 'const' },
  ]
  const cases = []
  const push = (n, ok, note = '') => cases.push({ n, ok: !!ok, note })
  const got = annotateDead(items, pool, ENTRY)
  const flagOf = (f) => got.filter((g) => g.flags.includes(f))
  push('不增不删（只打标）', got.length === items.length && new Set(got.map((g) => g.file + ':' + g.name)).size === items.length)
  push('entry 文件被标 entryFile（引擎按名取用，机器看不见）', flagOf('entryFile').length === 2)
  push('普通源文件不标 entryFile', !got.find((g) => g.file === 'forge-pm/lib/a.js').flags.includes('entryFile'))
  push('.d.ts 标 declFile（与实现文件是同一批名字，进账本就双计）', got.find((g) => g.file === 'forge-x/lib/index.d.ts').flags.includes('declFile'))
  push('反向验证：declFile 只落在 .d.ts 上，不误伤实现文件', flagOf('declFile').length === 1)
  push('名字在字符串池里 ⇒ 标 stringRef', got.find((g) => g.name === '__fx_build__').flags.includes('stringRef') && !got.find((g) => g.name === '__fx_aaa__').flags.includes('stringRef'))
  push('排序确定（pkg→file→line→name），两次跑逐字节相同', JSON.stringify(got) === JSON.stringify(annotateDead(items, pool, ENTRY)) && got[0].file === 'forge-pm/lib/a.js')
  const noEntry = annotateDead(items, pool, /(?!)/)
  push('反向验证：换掉入口判据后 entryFile 必须归零（标记真有判别力）', noEntry.filter((g) => g.flags.includes('entryFile')).length === 0)
  push('反向验证：清空字符串池后 stringRef 必须归零', annotateDead(items, new Map(), ENTRY).filter((g) => g.flags.includes('stringRef')).length === 0)
  push('字符串池只收 identifier 形状的字面量', (() => {
    const p = new Map()
    addStringsToPool('const a = "__fx_in__"; const b = "1px solid"; const c = `x`; const d = "a";', p)
    return p.has('__fx_in__') && !p.has('1px solid') && !p.has('x') && !p.has('a')
  })())
  // buildDeadArtifact：文件级那一档（ISS-723）同样"不增不删"，且三个总数必须自洽
  const art = buildDeadArtifact({
    exported: new Array(5).fill({}), zeroExport: items, zeroFile: [
      { pkg: 'forge-x', rel: 'forge-x/lib/orphan.js', lines: 40, half: 'host' },
      { pkg: 'forge-a', rel: 'forge-a/src/orphan.ts', lines: 7, half: 'client' },
    ],
    stringPool: pool, entryRe: ENTRY,
  })
  push('产物含文件级清单，成员数与输入一致（不增不删）', art.files.length === 2 && art.items.length === items.length)
  push('totals 三个数自洽（导出总数 / 零引用导出 / 零引用文件）', art.totals.exports === 5 && art.totals.zeroRef === items.length && art.totals.zeroFiles === 2)
  push('文件级清单按 pkg→file 稳定排序（两次跑逐字节相同）', art.files[0].pkg === 'forge-a' && JSON.stringify(art.files) === JSON.stringify(buildDeadArtifact({ exported: [], zeroExport: items, zeroFile: [art.files[1], art.files[0]].map((f) => ({ pkg: f.pkg, rel: f.file, lines: f.lines, half: f.half })), stringPool: pool, entryRe: ENTRY }).files))
  push('flags 计数与 items 同源（none + 各标记都不超过总数）', art.flags.none + art.flags.declFile + art.flags.entryFile + art.flags.stringRef >= art.items.length)
  /* ── ISS-765：测试洗白（countTestWashed）的牙 ──
     fixture 形状照真实事故：模块有两个导出，生产一个都没解构到那个"死"的，测试用 `await import()` 整体吃进。 */
  const exp2 = [
    { name: 'startRun', k: 'forge-x/lib/m.js', pkg: 'forge-x' },
    { name: 'deadOne', k: 'forge-x/lib/m.js', pkg: 'forge-x' },
    { name: 'prodWild', k: 'forge-x/lib/w.js', pkg: 'forge-x' },
  ]
  const resolve2 = (_from, spec) => (spec.includes('m.js') ? 'forge-x/lib/m.js' : spec.includes('w.js') ? 'forge-x/lib/w.js' : null)
  const srcA = [{ rel: 'forge-x/lib/other.js', imports: [{ spec: './m.js', names: ['startRun'], ns: false, dynamic: false }], exportStar: [] }]
  const srcWild = [{ rel: 'forge-x/lib/other.js', imports: [{ spec: './w.js', names: [], ns: true, dynamic: false }], exportStar: [] }]
  const tstDyn = [{ rel: 'forge-x/lib/m.test.js', imports: [{ spec: './m.js', names: [], ns: false, dynamic: true }], exportStar: [] }]
  const tw = countTestWashed({ exported: exp2, src: srcA.concat(srcWild), tst: tstDyn, resolveSpec: resolve2 })
  push('测试里的 await import 把该模块的未用导出算成"被测试洗白"（本单现象）', tw.count === 1 && tw.files.join() === 'forge-x/lib/m.js' && tw.byFile[0].names.join() === 'deadOne')
  push('生产侧已按名用掉的那个不被洗白（只报真没生产消费者的）', !tw.byFile[0].names.includes('startRun'))
  push('生产侧 namespace import 过的模块不算测试洗白（保守是生产给的，不是测试给的）', !tw.files.includes('forge-x/lib/w.js'))
  const twOff = countTestWashed({ exported: exp2, src: srcA.concat(srcWild), tst: [], resolveSpec: resolve2 })
  push('反向控制：摘掉那个测试文件 ⇒ 洗白数归 0（防"恒报有洗白"）', twOff.count === 0)
  const twNoFn = countTestWashed({ exported: exp2, src: srcA, tst: tstDyn })
  push('缺 resolveSpec 时报"不判"而不是伪装成 0 条', twNoFn.count === 0 && /不判/.test(twNoFn.note || ''))

  /* ── ISS-723 第 4 批：两个**降噪**标记的牙（把"零引用但其实是活的"和"只被测试文本钉住"分开摆）──
     fixture 全部照 09-23 真实定位到的两类现象做形状，名字一律带 `__fx_` 前缀（除照抄的真名）。 */
  // ① builtArtifactSource：源文件自己的**编译产物**（仓库里入库的那份）用了这个名字 ——
  //    真实现象（该例随文件中心插件整包退役，形状照旧）：某源文件导出的函数由**它自己的编译产物**消费，
  //    产物里形如 `window.__x={install:installX}`（宿主再用 <script> 加载那份产物），
  //    forge-native 再用 <script> 加载那份产物。import 分析看不见这条通道 ⇒ 单看"没人 import"会误判成死码。
  const arts = new Map([['forge-legacy/src/mermaid/chat-enhance.ts', { artifact: 'forge-legacy/static/mermaid/chat-enhance.js', mentions: new Set(['__fx_install__']) }]])
  const itemsArt = [
    { name: '__fx_install__', k: 'forge-legacy/src/mermaid/chat-enhance.ts', line: 581, pkg: 'forge-legacy', kind: 'function' },
    { name: '__fx_noment__', k: 'forge-legacy/src/mermaid/chat-enhance.ts', line: 9, pkg: 'forge-legacy', kind: 'function' },
    { name: '__fx_otherfile__', k: 'forge-x/lib/a.js', line: 2, pkg: 'forge-x', kind: 'function' },
  ]
  const gotArt = annotateDead(itemsArt, new Map(), ENTRY, { artifacts: arts })
  push('产物用了这个名字 ⇒ 标 builtArtifactSource（要删就得源与产物一起处理）', gotArt.find((g) => g.name === '__fx_install__').flags.includes('builtArtifactSource'))
  push('反向控制①：同一份产物里没提到这个名字 ⇒ 不标', !gotArt.find((g) => g.name === '__fx_noment__').flags.includes('builtArtifactSource'))
  push('反向控制②：别的文件有产物但自己没产物 ⇒ 不标', !gotArt.find((g) => g.name === '__fx_otherfile__').flags.includes('builtArtifactSource'))
  push('反向控制③：不传 artifacts ⇒ builtArtifactSource 归零（旧调用方口径不变）', annotateDead(itemsArt, new Map(), ENTRY).every((g) => !g.flags.includes('builtArtifactSource')))
  // ② testPinnedBySourceText：名字在**除自己声明文件以外**的生产代码里一次都没出现，只在测试文本里出现
  //    （真实现象：errLive 只被 test 的标题字符串钉住；AGENT_DEFAULT_MODEL_NS 只被 toMatch(正则) 钉住。
  //     ⇒ 死的是"测试里的那串字"，不是行为；改名/收回 export 时测试跟着改，别把它当成"有人在用"。
  //     ⚠️ 这些真名一律不加引号或反引号：本文件的说明也会被扫进池，加了就会反过来吃掉这些名字的标记）
  const prodTok = new Map([
    ['__fx_err__', new Set(['forge-model/lib/plans/providers.js'])],
    ['__fx_two__', new Set(['forge-x/lib/a.js', 'forge-x/lib/consumer.js'])],
  ])
  const testTok = new Map([['__fx_err__', new Set(['forge-model/lib/plans/browser-normalize.test.js'])]])
  const itemsPin = [
    { name: '__fx_err__', k: 'forge-model/lib/plans/providers.js', line: 907, pkg: 'forge-model', kind: 'function' },
    { name: '__fx_two__', k: 'forge-x/lib/a.js', line: 3, pkg: 'forge-x', kind: 'function' },
    { name: '__fx_notest__', k: 'forge-x/lib/b.js', line: 4, pkg: 'forge-x', kind: 'const' },
  ]
  const gotPin = annotateDead(itemsPin, new Map(), ENTRY, { prodTokens: prodTok, testTokens: testTok })
  push('只在自己文件 + 测试文本里出现 ⇒ 标 testPinnedBySourceText（钉的是断言里的字符串）', gotPin.find((g) => g.name === '__fx_err__').flags.includes('testPinnedBySourceText'))
  push('反向控制①：生产侧另有别的文件提到它 ⇒ 不标（那是真线索，不能被测试标记掩盖）', !gotPin.find((g) => g.name === '__fx_two__').flags.includes('testPinnedBySourceText'))
  push('反向控制②：测试里也没提到 ⇒ 不标', !gotPin.find((g) => g.name === '__fx_notest__').flags.includes('testPinnedBySourceText'))
  push('反向控制③：不传两个池 ⇒ testPinnedBySourceText 归零', annotateDead(itemsPin, new Map(), ENTRY).every((g) => !g.flags.includes('testPinnedBySourceText')))
  // ④ 装载器必须把两条通道**传下去**：只测 annotateDead 抓不到"忘了传参"这条漏线（真实漏过一次：第一版跑完 真候选仍 7）
  const art2 = buildDeadArtifact({ exported: [], zeroExport: [itemsArt[0], itemsPin[0]], zeroFile: [], stringPool: new Map(), entryRe: ENTRY, artifacts: arts, prodTokens: prodTok, testTokens: testTok })
  push('buildDeadArtifact 把两个数据源传给了 annotateDead（新标记在产物里真看得见）', art2.items.some((g) => g.flags.includes('builtArtifactSource')) && art2.items.some((g) => g.flags.includes('testPinnedBySourceText')))
  push('产物 flags 计数把新标记算进去，且"不增不删"仍然成立', art2.flags.builtArtifactSource === 1 && art2.flags.testPinnedBySourceText === 1 && art2.items.length === 2)
  // ③ 采集侧的纯函数：整文件 token 化与产物头解析
  const tk = new Map()
  addTokensToPool('const __fx_t1 = 1; expect(x).toMatch(/__fx_t2/); const s = "export const __fx_t3"; // __fx_t4', 'p/q.js', tk)
  push('token 池收"长字面量拆出来的词"：正则里的 __fx_t2 与字符串里的 __fx_t3 都算（断言源码文本就是这个形状）', tk.get('__fx_t2')?.has('p/q.js') && tk.get('__fx_t3')?.has('p/q.js'))
  push('反向控制：裸标识符（__fx_t1）与注释（__fx_t4）不进池 —— 否则工具自己的说明会改变测量', !tk.has('__fx_t1') && !tk.has('__fx_t4'))
  push('token 池按文件建索引（同名不同文件要能区分：String.match 那课的反面）', (() => {
    const m = new Map(); addTokensToPool('const a = "__fx_s__ here"', 'a.js', m); addTokensToPool('const b = "__fx_s__ there"', 'b.js', m)
    return m.get('__fx_s__').size === 2
  })())
  const HEAD = '// 自动生成，勿手改 —— 源：forge-legacy/src/mermaid/chat-enhance.ts（改完跑 bun run build:client）\n(() => {'
  const fakeFs = {
    'forge-legacy/static/mermaid/chat-enhance.js': { head: HEAD, full: 'window.__forgeMermaidChat = { install: __fx_install__, src: __fx_default_src__ };' },
    'forge-legacy/static/vendor/md-render.js': { head: '// 手写的第三方渲染器\n', full: 'const x = 1' },
    'forge-x/src/a.ts': { head: HEAD, full: 'const x = 1' },
  }
  const col = collectBuiltArtifacts('/', Object.keys(fakeFs), (r, max) => (max ? (fakeFs[r].head || '') : (fakeFs[r].full || '')))
  push('产物表只收"在 static|dist 下 + 头里声明了源"的文件（别的一律不算产物）', col.size === 1 && col.has('forge-legacy/src/mermaid/chat-enhance.ts') && col.get('forge-legacy/src/mermaid/chat-enhance.ts').artifact === 'forge-legacy/static/mermaid/chat-enhance.js')
  push('产物表带上产物里出现过的名字（token 级，不是"文件里随便搜一下"）', col.get('forge-legacy/src/mermaid/chat-enhance.ts').mentions.has('__fx_install__') && !col.get('forge-legacy/src/mermaid/chat-enhance.ts').mentions.has('md_render_absent'))
  push('反向控制：只扫 1KB 头部，非产物路径（不在 static|dist 下）连头部都不读（读全盘 108 个 static 文件的代价要看得见）', (() => {
    let headsRead = 0
    const c2 = collectBuiltArtifacts('/', Object.keys(fakeFs), (r, max) => { if (max) headsRead++; return fakeFs[r].head || '' })
    return headsRead === 2 && c2.size === 1
  })())
  push('默认 reader 真能读盘（tmpdir 造一份产物，不碰真仓库）', (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fx-'))
    try {
      fs.mkdirSync(path.join(dir, 'p/static/mermaid'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'p/static/mermaid/x.js'), HEAD + '\nwindow.__fx = { install: __fx_install__ }\n')
      const c = collectBuiltArtifacts(dir, ['p/static/mermaid/x.js'])
      return c.size === 1 && c.get('forge-legacy/src/mermaid/chat-enhance.ts').mentions.has('__fx_install__')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })())

  let bad = 0
  console.log('dead-exports --selftest（内建 fixture，不扫真实仓库）')
  for (const c of cases) { console.log(`  ${c.ok ? '✓' : '✗'} ${c.n}${c.note ? '（' + c.note + '）' : ''}`); if (!c.ok) bad++ }
  console.log(bad ? `\n✗ 反向验证失败 ${bad}/${cases.length}` : `\n✓ ${cases.length}/${cases.length} 项通过：打标不改成员、五个标记各有判别力、排序可复算`)
  return bad ? 1 : 0
}

/**
 * 组装载产物（ISS-723 要的文件级那一档也在这里出，判据仍由 code-inventory 唯一持有）：
 * 成员一律**不增不删**，只打标 + 排序；文件级清单与符号级清单共用一份口径，避免两份真相。
 * @param {{exported:any[],zeroExport:any[],zeroFile:any[],stringPool:Map<string,number>,entryRe:RegExp,src?:any[],tst?:any[],resolveSpec?:Function,artifacts?:Map<string,{artifact:string,mentions:Set<string>}>,prodTokens?:Map<string,Set<string>>,testTokens?:Map<string,Set<string>>}} a
 *        后三个是 ISS-723 第 4 批的"消费通道"数据源，原样转给 annotateDead（漏传 = 新标记恒为 0，自检第 ④ 组抓这条）
 */
export function buildDeadArtifact({ exported, zeroExport, zeroFile, stringPool, entryRe, src, tst, resolveSpec, artifacts, prodTokens, testTokens }) {
  const items = annotateDead(zeroExport, stringPool, entryRe, { artifacts, prodTokens, testTokens })
  const n = (f) => items.filter((x) => x.flags.includes(f)).length
  const cmpFile = (a, b) => a.pkg.localeCompare(b.pkg) || a.file.localeCompare(b.file)
  return {
    tool: 'code-inventory.mjs --write-dead-exports',
    note: '零引用清单（ISS-732 符号级 + ISS-723 文件级，死码账本的输入）。items 成员 = 度量 Z2 的 zeroExport、files 成员 = 度量 Z1 的 zeroFile，两处都一字不改；flags 只是降噪提示（declFile / entryFile / stringRef / builtArtifactSource / testPinnedBySourceText），既不是活证据也不是死证据 —— 删之前逐条人工过。不含 default export（Z2 对其无判据）。testWashed = **只因测试文件把模块整体吃进而被算成"有人用"**的导出（ISS-765 的可伪造面，Z2 的数按现行口径不含它们，所以这个数不是违例、是"还能再降多少的真相"）。',
    /* zeroRef = 清单成员数（全量）；zeroRefBadness = 度量 Z2 坏ness 段的口径（= 全量 − 三件装载契约名，
       ISS-654）。两个数都在这里，是为了让人一眼看出"清单 X 条，其中 Y 条是装载契约、不算债"，
       而不是让两份数字各说各话。
       ⚠️ 按 **name** 剔，不按 `entryFile` 标记（那是路径判据）：旧版按路径剔，实测剔掉 237 条，
       其中只有 84 条真是三件契约名，另 153 条跟着免计 —— 与 Z2 的论证范围对不上，且修正判据后
       本式会停在旧值（896→396），audit-doc-sync 的等式当场红。名字集从 LOAD_CONTRACT_NAMES 取，
       与度量侧同一份，不许各写一遍。 */
    totals: { exports: exported.length, zeroRef: zeroExport.length, zeroRefBadness: items.filter((x) => !LOAD_CONTRACT_NAMES.includes(x.name)).length, zeroFiles: zeroFile.length },
    flags: { declFile: n('declFile'), entryFile: n('entryFile'), stringRef: n('stringRef'), builtArtifactSource: n('builtArtifactSource'), testPinnedBySourceText: n('testPinnedBySourceText'), none: items.filter((x) => !x.flags.length).length },
    testWashed: countTestWashed({ exported, src, tst, resolveSpec }),
    items,
    files: zeroFile.map((x) => ({ pkg: x.pkg, file: x.rel, lines: x.lines, half: x.half })).sort(cmpFile),
  }
}

const TEST_FILE_RE = /(\.test\.|\.spec\.|\/__tests__\/|\/test\/)/

/**
 * 「测试洗白」清单（ISS-765）：Z2 的 wildcard 规则（namespace / 动态 / 副作用 import ⇒ 整份文件算被用）
 * 在生产代码里是**必要的保守**，但它有一扇可伪造的门 —— **加一个 `await import("./x.js")` 的测试文件，
 * 就能把该模块的全部导出从"零引用"里抹掉，而生产使用面一个字没变**。实测触发形态（09-23 在
 * `forge-agents/lib/zcode-stdio.js` 上定位到机制）：`zcode-ask-branch.test.js:76` 用了
 * `const { startZcodeRun, ... } = await import("./zcode-stdio.js")` ⇒ 动态 import ⇒ `usedWildcard` ⇒
 * 连没被解构出来的 `mapToolUpdated` 也算"有人用"。
 *
 * 这里**只报数、不改 Z2 的判定**（补盲区不翻判红是本页老规矩）：`count` = 若把口径改成
 * "零引用只看生产 importer"（ISS-765 甲案）就会新增的条数。甲/乙要老板定，定了再动 Z2 与上限。
 * @param {{exported:any[],src?:any[],tst?:any[],resolveSpec?:Function}} a
 */
/** 模块内私有：`export` 出去会被 Z2 数成一条零引用导出（本仓这条度量量的是"没人 import 的导出"，
 *  新工具的内部函数一律不导出 —— 同一课第三次踩，这次是自己写的判据抓的）。自检在同文件内跑，不需要导出。 */
function countTestWashed({ exported, src = [], tst = [], resolveSpec }) {
  if (typeof resolveSpec !== 'function' || !tst.length) return { count: 0, files: [], note: '未传 src/tst/resolveSpec ⇒ 不判（不许把"缺数据"印成 0）' }
  const key = (t, n) => `${t}::${n}`
  /** 与 code-inventory 的 used/usedWildcard 构造**逐条同构**（那边改了这里必须跟着改，否则两个真相） */
  const collect = (list) => {
    const byName = new Set(), wild = new Set()
    for (const x of list) {
      for (const im of x.imports || []) {
        const t = resolveSpec(x.rel, im.spec)
        if (!t || t.includes('/UNRESOLVED/')) continue
        for (const nm of im.names) byName.add(key(t, nm))
        if (im.def) byName.add(key(t, 'default'))
        const emptyClause = !im.names?.length && !im.ns && !im.def && !im.fromReexport
        if (im.ns || im.dynamic || emptyClause) wild.add(t)
      }
      for (const spec of x.exportStar || []) { const t = resolveSpec(x.rel, spec); if (t) wild.add(t) }
    }
    return { byName, wild }
  }
  const prod = collect(src), test = collect(tst)
  const washed = exported.filter((e) => test.wild.has(e.k) && !prod.wild.has(e.k) && !prod.byName.has(key(e.k, e.name)))
  const files = [...new Set(washed.map((e) => e.k))].sort()
  return { count: washed.length, files, byFile: files.map((f) => ({ file: f, names: washed.filter((e) => e.k === f).map((e) => e.name) })) }
}


/* ───────── ISS-723 第 4 批：两条"消费通道"的采集器（都只给清单打标，不参与任何判据计数） ───────── */

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]+/g
/** 编译产物的落点：本仓只有 `static/`（入库、被 <script> 直接加载）与 `dist/`（构建输出，未入库）两种口径 */
const ARTIFACT_PATH_RE = /(^|\/)(static|dist)\/[^\n]*\.[cm]?[jt]sx?$/
/** 产物头部的自述：`// 自动生成，勿手改 —— 源：<path>（改完跑 bun run build:client）` —— 两个条件都要，缺"自动生成"就当手写文件 */
const ARTIFACT_DECL_RE = /自动生成[\s\S]{0,80}?源[:：]\s*([A-Za-z0-9_\-./]+\.[cm]?[jt]sx?)/

/** 模块内私有：整份文本切 token 用（不进 Z2 口径 ⇒ 不导出，同一课第三次踩过的坑不再犯） */
function tokenSetOf(text) {
  const out = new Set()
  for (const m of text.matchAll(TOKEN_RE)) out.add(m[0])
  return out
}

/**
 * 把一个文件里**字符串字面量 + 正则字面量**内部出现的 identifier 形状 token，按"名字 → 出现过的文件集合"入池。
 * 与 `addStringsToPool` 的分工：那个要求**整条字面量**就是个 identifier（stringRef 的旧口径，原样保留），
 * 这个把长字面量**拆开**取词 —— 因为"断言源码文本"这种 pin 恰恰写在长串里：
 * ⚠️ 这里故意不写真实例子：工具自己的说明文字若把真名放进引号或反引号，就会进池并把该名字的 testPinned 标记吃掉
 * ⚠️ 三条故意的粗糙（这条只是降噪提示，不是判据）：① 不解析语法，正则字面量按上下文猜（与除号歧义时可能漏）；
 * ② 不剥字符串里的关键字（`const`、`install` 这类会进池，但它们当不上导出名）；
 * ③ 多行模板串整条跳过。**不碰裸标识符与注释** —— 否则工具自己的说明文字就会改变测量（第一版就栽在这里：
 * 全文件 token 化让 stringRef 从 148 涨到 150，"真候选"少掉了两条本来该人看的）。
 * @param {string} source 文件原文
 * @param {string} rel 文件相对路径（同一名字在不同文件要能区分：String.match 那课的反面）
 * @param {Map<string,Set<string>>} pool 累加
 */
export function addTokensToPool(source, rel, pool) {
  const hits = new Set()
  const feed = (chunk) => { for (const t of chunk.matchAll(/[A-Za-z_$][A-Za-z0-9_$]+/g)) hits.add(t[0]) }
  for (const m of source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) feed(m[2])
  for (const m of source.matchAll(/(^|[=(,:[\s{!?|&;])(\/(?:\\.|[^/\\\n])+?\/[gimsuy]*)/g)) feed(m[2])
  for (const h of hits) {
    let set = pool.get(h)
    if (!set) pool.set(h, (set = new Set()))
    set.add(rel)
  }
}

/**
 * 「源 → 它自己的编译产物」表（`builtArtifactSource` 的数据源）：
 * 编译产物是 import 分析看不见的**第二条消费通道**——真实现象：
 * 某个源文件（该例随文件中心插件整包退役，形状照旧）导出的 installX 没有任何 importer（这里不加反引号：注释里的反引号字面量会被自扫描收进字符串池，见文件头那条纪律），
 * 但它的编译产物（入库、由 `build:client` 生成，路径在 static|dist 下）里
 * `window.__forgeMermaidChat = { install: installMermaidChat }` 用了它，forge-native 再 <script> 加载那份产物。
 * 只认"路径在 static|dist 下 **且** 头部自述了源"的文件——一条都不猜（`.wt/` 工作树、未入库的 dist 天然不在 candidates 里，
 * 因为调用方给的是 `git ls-files` 的全集）。
 * @param {string} root 仓库根
 * @param {Iterable<string>} candidates 候选相对路径（**必须传全集**，漏一半就会把"没有产物"读成"产物没用这个名字"）
 * @param {(rel:string, maxBytes?:number)=>string} [read] 注入的读盘函数（自检用假 reader；默认走 fs）
 * @returns {Map<string,{artifact:string, mentions:Set<string>}>}
 */
export function collectBuiltArtifacts(root, candidates, read) {
  const rd = read || ((rel, max) => {
    try {
      if (!max) return fs.readFileSync(path.join(root, rel), 'utf8')
      const fd = fs.openSync(path.join(root, rel), 'r')
      try { const buf = Buffer.alloc(max); return buf.slice(0, fs.readSync(fd, buf, 0, max, 0)).toString('utf8') } finally { fs.closeSync(fd) }
    } catch { return '' } // 读不到 = 不在场（清单里没有它，比假装读到强）
  })
  const out = new Map()
  for (const rel of candidates) {
    if (!ARTIFACT_PATH_RE.test(rel)) continue
    const src = (ARTIFACT_DECL_RE.exec(rd(rel, 1024)) || [])[1]
    if (!src) continue
    out.set(src, { artifact: rel, mentions: tokenSetOf(rd(rel)) })
  }
  return out
}

/** 允许独立跑自检：`node scripts/dead-exports-lib.mjs --selftest`（被 import 时不触发） */
if (process.argv[2] === '--selftest') process.exit(selftestDead())
