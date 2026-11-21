// 路由字面量的全量明细（ISS-715 · S3-2 端点归一的前置）
//
// 为什么要有这个文件：主基线 `code-inventory.json` 每条度量只存**前 10 个 offender**，
// 于是 C9「同一 path 被抄写到 ≥2 个文件」答得出"有 107 个"，答不出"**是哪 107 个、各自抄在哪**"。
// 判据要收敛，第一步永远是**能点名**（ISS-739 就是卡在这上面：四格账还不了，因为点不出那一处）。
// 同一族的先例是 ISS-732 给 Z2 做的 `dead-exports.json` ⇒ 这里照做：成员**直接取盘点器算好的数组**，
// 本文件不另扫一遍源码（两处扫 = 两处口径会漂）。
//
// ⚠️ 与 `dead-exports-lib.mjs` 同一条纪律：本模块**只做组装与打标**，不改变任何判据口径；
//    C8/C9/C9b/C10 的算法仍在 `code-inventory.mjs` 里，唯一一份。
//    （例外：`loadCrossBundleBaseline` 只是**读一份名单**，不做任何判断 —— 放这里是因为盘点器已经贴着 1000 行红线。）
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「这条字面量出现在注释里吗」—— 端点字面量的**口径边界**，K5f/C9 与 C10 共用（ISS-715）。
 *
 * 为什么注释不算第二份真相：改路由时注释不会运行期出错，它坏的是文档（归 doc 规则的同步义务）；
 * 而 K5f 要防的是「改一端忘另一端 ⇒ 请求打到不存在的端点」，只有**代码里的字符串**才会发生那种事。
 * 反过来，把注释算进来会让"收敛"永远做不完，还会让包内的说明性文字被当成越界引用（C10 假红）。
 *
 * 三种情形：整行注释（`//`、`*`、`/*`、`#` 起头）／行内注释之后的部分／字符串里的 `//`（URL 协议）**不算注释**。
 */
export function isDocLine(line, idx = 0) {
  if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return true
  if (idx <= 0) return false
  let q = '' // 当前所在引号；'' 表示在代码里
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue }
    if (c === '"' || c === "'" || c === '`') { q = c; continue }
    if (c === '/' && line[i + 1] === '/') return i < idx
  }
  return false
}

/** 一次遍历算出全部路由事实，供基线产物与自检共用（纯函数，不碰磁盘）。 */
// 内部用（只有本文件的自检与组装用它）；不导出 ⇒ 不给度量 Z2 添零引用导出
function analyzeRoutes(routes) {
  const byPath = new Map()
  for (const r of routes) {
    if (!byPath.has(r.p)) byPath.set(r.p, [])
    byPath.get(r.p).push(r)
  }
  const copied = [...byPath.entries()].filter(([, v]) => new Set(v.map((r) => r.k)).size > 1)
  const crossPkg = [...byPath.entries()].filter(([, v]) => new Set(v.map((r) => r.pkg)).size > 1)
  const alien = routes.filter((r) => r.p.split('/')[1] && r.p.split('/')[1] !== r.pkg)
  const alienPairs = [...new Set(alien.map((r) => `${r.pkg} → /${r.p.split('/')[1]}`))]
  return { byPath, copied, crossPkg, alien, alienPairs }
}

/**
 * 落成可复算的明细档。成员与 C8/C9/C9b/C10 **同源**（同一个 routes 数组），所以
 * `totals.copiedPaths` 必然等于审计稿里 C9 的数 —— 这条不变量由 selftest 钉住。
 */
// 只被 buildRouteArtifactV2 与本文件自检调用 ⇒ 不导出（同上一条理由）
function buildRouteArtifact({ routes }) {
  const { copied, crossPkg, alienPairs } = analyzeRoutes(routes)
  const uniqPaths = new Set(routes.map((r) => r.p))
  return {
    tool: 'route-ledger-lib.mjs',
    note: '全仓路由字面量明细（与 code-inventory 的 C8/C9/C9b/C10 同一次测量、同一份数组）；端点归一的点名清单，不是门禁',
    totals: {
      literals: routes.length,
      uniqPaths: uniqPaths.size,
      copiedPaths: copied.length,
      crossPkgPaths: crossPkg.length,
      alienPairs: alienPairs.length,
    },
    copied: copied.map(([p, v]) => ({
      p,
      files: v.map((r) => ({ k: r.k, line: r.line, via: r.via })).sort((a, b) => a.k.localeCompare(b.k) || a.line - b.line),
      pkgs: [...new Set(v.map((r) => r.pkg))].sort(),
    })).sort((a, b) => a.p.localeCompare(b.p)),
    crossPkg: crossPkg.map(([p, v]) => ({ p, pkgs: [...new Set(v.map((r) => r.pkg))].sort(), files: [...new Set(v.map((r) => r.k))].sort() }))
      .sort((a, b) => b.pkgs.length - a.pkgs.length || a.p.localeCompare(b.p)),
    alien: alienPairs.sort(),
  }
}

/**
 * 自检（CLI 用；契约与 dead-exports-lib 的 selftestDead 一致：自己打印、返回退出码）。
 * 每条判据都要能红也要能绿 —— 尤其"同文件抄两次不算 C9"这条口径边界。
 */
/**
 * 半区归类（ISS-715 口径修正 · 老板 09-22 选「乙」）：host（lib）· client（src）· mcp · scripts。
 *
 * 旧口径把"同一 path 出现在两个文件"一律算抄写，但 107 条里有 63 条是**服务端注册一次 + 浏览器半
 * 引用一次**的成对 —— 那在当前构建布局下物理上合不成一份（客户半不开 allowJs、两个 bundle 也不共享
 * 运行时常量）。真正的坏发生在**同一半区内**（改一端忘另一端就在此处）；跨半区那一对改由
 * `routeHalves().danglingRefs` 核一致：客户端写了本包前缀、而本包 host 没注册 ⇒ 红。
 * @param {string} rel 仓库相对路径
 */
// 内部与自检用；不导出（导出它 = 给度量 Z2 添一条零引用导出）
function halfOf(rel) {
  if (rel.startsWith('scripts/')) return 'scripts'
  if (rel.includes('/mcp')) return 'mcp'
  return rel.includes('/src/') ? 'client' : 'host'
}

/**
 * **跨 bundle 成对**的静态资源地址：同一个 URL 分属两个**独立产物**，源码里合不成一份。
 *
 * 为什么这不是"同半区抄两遍"那笔欠账：两份字面量各自被打进不同的 bundle（`client.js` 与某个 classic script），
 * 两个 bundle 不共享运行时常量 —— 这一点与 `docs/code.md` §4 / ISS-715 乙案里"host↔client 成对物理上合不成"是同一种形状，
 * 只是轴不同：那条是**跨半区**，这条是**同一半区里的两个 bundle**。
 *
 * ⚠️ 不是推断，是 09-24 实测过的（ISS-793）：把 `chat-enhance.ts` 的 fallback 改成 `ASSET.mermaidUmd` 之后，
 *   构建与 tsc **都不红**，但产物 `static/mermaid/chat-enhance.js` 里被内联进**整张资源表**
 *   （+12 行、多带 4 条这个脚本永远用不到的 monaco/pdfjs/mdRender 路径）—— 也就是"去重"的代价是把别的资源地址拖进一个独立脚本。
 *   现场当时还有一条钉子测试守着（文件中心插件的 chat-enhance.test.ts:45，09-22 就踩过一次并写下理由；
 *   该包已整包退役，夹具形状照旧，只是名字换成中性包名）。
 *
 * 名单**就是别名登记表 `scripts/baseline/route-aliases.json` 里 `kind = cross-bundle-pair` 的那些条目**，不另开一份文件：
 * 第一版我给它单独建了 `cross-bundle-assets.json`，复录当天就被 `route-alias-check` 抓出一条"化石"——
 * 同一个事实（这条 path 为什么合不成一处）在两张表里各写一份，一张改了另一张不知道。
 * 现在豁免的**唯一入口**是那张手写登记表，而它归 `route-alias-check --check`（已在 guard 里）看：
 * 登记了但源码实际文件集合对不上 ⇒ 条目掉进 `staleCrossBundle` ⇒ 登记表报"化石"红。
 * 名单为什么必须是 JSON 而不是源码常量：第一版写在源码常量里，本文件那条字面量被自己的扫描算成第三份抄写，
 * 恰好匹配规则当场拒绝豁免 —— **度量把守门员自己算成了球员**。JSON 不在扫描射程（只扫源码扩展名）。
 *
 * 名单是**恰好匹配 + 会腐烂**：这条路径上的文件集合必须与登记的集合完全相同才豁免；
 * 多一处（真新增的抄写）或少一处（两边已合并/消失）都不豁免，并记进 `staleCrossBundle` 点名。
 *
 * 读不到名单时**两档保守、一档炸**：文件不存在 / 缺 `entries` 数组 ⇒ 返回空名单 = **不豁免**（C9 只会涨回去，涨线必须查因）；
 * JSON 本身读不懂 ⇒ 让 `JSON.parse` 当场抛。为什么不留一个 `catch` 兜住：第一版这份逻辑在调用点，写的是
 * `try { readFileSync(...) } catch { return [] }`，而那里用的是 `import fs from 'node:fs'` ⇒ 裸 `readFileSync` 的
 * ReferenceError 被吞成"名单是空的"，表现是"改了三次、复录三次，C9 都不降，而且看不出为什么"
 * （"看不见"被当成"没有"，同 ISS-774/751 那一族）——这次是我自己新写的代码犯的。
 */
export function loadCrossBundleBaseline(root) {
  const f = path.join(root, "scripts", "baseline", "route-aliases.json")
  if (!fs.existsSync(f)) return { entries: [], missing: true }
  const parsed = JSON.parse(fs.readFileSync(f, "utf8")) // 读不懂就当场炸：吞成"空名单"会让 C9 静默少降，且看不出原因
  if (!Array.isArray(parsed.entries)) return { entries: [], malformed: true }
  const pairs = parsed.entries.filter((e) => e && e.kind === "cross-bundle-pair")
  return { entries: pairs.map((e) => ({ p: e.path, files: (e.measured && e.measured.crossBundle) || [], why: e.reason })), missing: false }
}

/** 一次算齐：同半区重复 / 跨半区成对 / 悬空引用。纯函数，不碰磁盘（名单由调用方传进来）。 */
export function routeHalves(routes, crossBundleEntries = []) {
  const byPath = new Map()
  for (const r of routes) {
    if (!byPath.has(r.p)) byPath.set(r.p, [])
    byPath.get(r.p).push(r)
  }
  const sameHalf = [], crossHalf = []
  const crossBundle = [], staleCrossBundle = []
  for (const [p, v] of byPath) {
    const seen = new Set(v.map((r) => r.k))
    const hit = crossBundleEntries.filter((e) => e.p === p && e.files.length === seen.size && e.files.every((f) => seen.has(f)))
    for (const e of crossBundleEntries) {
      if (e.p !== p || hit.includes(e)) continue
      staleCrossBundle.push({ p, 登记: e.files, 实际: [...seen].sort(), why: e.why })
    }
    const exempt = new Set(hit.flatMap((e) => e.files))
    if (exempt.size) crossBundle.push({ p, files: [...exempt].sort(), why: hit[0].why })
    const filesByHalf = new Map()
    for (const r of v) {
      if (exempt.has(r.k)) continue
      const h = halfOf(r.k)
      if (!filesByHalf.has(h)) filesByHalf.set(h, new Set())
      filesByHalf.get(h).add(r.k)
    }
    const max = filesByHalf.size ? Math.max(...[...filesByHalf.values()].map((s) => s.size)) : 0
    if (max >= 2) sameHalf.push({ p, files: v.filter((r) => !exempt.has(r.k)), halves: [...filesByHalf].map(([h, s]) => h + ':' + s.size).sort() })
    else if (filesByHalf.size > 1) crossHalf.push({ p, halves: [...filesByHalf.keys()].sort() })
  }
  // 悬空引用：本包 client/mcp/scripts 写了「以本包前缀开头」的路径，而本包 host 侧没有这个 path
  const hostPaths = new Map()
  for (const r of routes) {
    if (halfOf(r.k) !== 'host') continue
    if (!hostPaths.has(r.pkg)) hostPaths.set(r.pkg, new Set())
    hostPaths.get(r.pkg).add(r.p)
  }
  const dangling = []
  const isStaticAsset = (p) => /\.[a-z0-9]{1,5}$/i.test(p.split('/').pop() || '')
  for (const r of routes) {
    const h = halfOf(r.k)
    if (h === 'host') continue
    if (isStaticAsset(r.p)) continue // 静态资源 URL 走框架的 static 处理，不是注册路由 ⇒ 不判悬空
    const own = '/' + r.pkg
    if (r.p !== own && !r.p.startsWith(own + '/')) continue
    if (!(hostPaths.get(r.pkg) || new Set()).has(r.p)) dangling.push({ k: r.k, line: r.line, p: r.p, pkg: r.pkg, half: h })
  }
  return { sameHalf, crossHalf, crossBundle, staleCrossBundle, dangling: [...new Map(dangling.map((d) => [d.k + '::' + d.p, d])).values()], byPath }
}

/** 产物组装（含新口径三段）。成员一律取传进来的 routes ⇒ 与度量同源。 */
export function buildRouteArtifactV2(routes, crossBundleEntries = []) {
  const { sameHalf, crossHalf, dangling, crossBundle, staleCrossBundle } = routeHalves(routes, crossBundleEntries)
  const a = buildRouteArtifact({ routes })
  return {
    ...a,
    note: a.note + ' · 口径已按 09-22 老板选「乙」改为「同半区重复 + 跨半区核一致」；09-24 起再排除**跨 bundle 成对**（见 crossBundleAssets 与 ISS-793）',
    totals: { ...a.totals, sameHalfCopies: sameHalf.length, crossHalfPairs: crossHalf.length, danglingRefs: dangling.length, crossBundleAssets: crossBundle.length, staleCrossBundle: staleCrossBundle.length },
    crossBundleAssets: crossBundle,
    staleCrossBundle,
    sameHalf: sameHalf.map((c) => ({ p: c.p, halves: c.halves, files: c.files.map((f) => ({ k: f.k, line: f.line, half: halfOf(f.k) })).sort((x, y) => x.k.localeCompare(y.k) || x.line - y.line) })).sort((x, y) => x.p.localeCompare(y.p)),
    crossHalf: crossHalf.map((c) => ({ p: c.p, halves: c.halves })).sort((x, y) => x.p.localeCompare(y.p)),
    dangling: dangling.sort((x, y) => x.k.localeCompare(y.k) || x.line - y.line),
  }
}

export function selftestRoutes() {
  const cases = []
  const t = (name, pass) => cases.push({ name, pass })
  const PT = (a, b) => '/' + a + '/' + b
  const R = (pkg, k, line, p) => ({ pkg, k, line, p, via: '注册点' })

  /* ── 新口径（09-22 老板选「乙」）：同半区重复才算坏，跨半区由悬空引用守卫核一致 ── */
  const hh = (rel) => halfOf(rel)
  t('半区归类：lib=host · src=client · mcp · scripts/', hh('forge-x/lib/a.js') === 'host' && hh('forge-x/src/b.tsx') === 'client' && hh('forge-x/mcp/c.mjs') === 'mcp' && hh('scripts/d.mjs') === 'scripts')
  const hostClientPair = routeHalves([R('forge-x', 'forge-x/lib/a.js', 1, PT('forge-x', 'q')), R('forge-x', 'forge-x/src/b.ts', 2, PT('forge-x', 'q'))])
  t('host + client 各一份 ⇒ 不算同半区重复（结构性成对，改判据不再把它算成坏）', hostClientPair.sameHalf.length === 0 && hostClientPair.crossHalf.length === 1)
  const twoClients = routeHalves([R('forge-x', 'forge-x/lib/a.js', 1, PT('forge-x', 'q')), R('forge-x', 'forge-x/src/b.ts', 2, PT('forge-x', 'q')), R('forge-x', 'forge-x/src/c.ts', 3, PT('forge-x', 'q'))])
  t('client 侧两份 ⇒ 算同半区重复（这才是"改一端忘另一端"的现场）', twoClients.sameHalf.length === 1 && twoClients.crossHalf.length === 0)
  t('host 有、client 引用另一个本包路径 ⇒ 悬空引用报出（新牙）', (() => {
    const d = routeHalves([R('forge-x', 'forge-x/lib/a.js', 1, PT('forge-x', 'real')), R('forge-x', 'forge-x/src/b.ts', 2, PT('forge-x', 'typo'))])
    return d.dangling.length === 1 && d.dangling[0].p === PT('forge-x', 'typo')
  })())
  t('引用**别包**前缀不算本包悬空（那是别名/渗漏，另有口径管）', routeHalves([R('forge-x', 'forge-x/src/b.ts', 2, PT('forge-y', 'z'))]).dangling.length === 0)
  t('静态资源 URL（末段带扩展名）不算悬空路由 ⇒ 防假阳性（首版就是被 /forge-legacy/pdfjs/*.js 这类骗到）', routeHalves([R('forge-x', 'forge-x/lib/a.js', 1, PT('forge-x', 'real')), R('forge-x', 'forge-x/src/b.tsx', 2, PT('forge-x', 'vendor') + '/asset.min.js')]).dangling.length === 0)
  t('悬空计数按 path 去重（同文件多处写同一个错路径只算一处问题）', routeHalves([R('forge-x', 'forge-x/src/b.ts', 2, PT('forge-x', 'typo')), R('forge-x', 'forge-x/src/b.ts', 9, PT('forge-x', 'typo'))]).dangling.length === 1)
  const v2 = buildRouteArtifactV2([R('forge-x', 'forge-x/lib/a.js', 1, PT('forge-x', 'q')), R('forge-x', 'forge-x/src/b.ts', 2, PT('forge-x', 'q')), R('forge-x', 'forge-x/src/c.ts', 3, PT('forge-x', 'q'))])
  t('产物新 totals 与 routeHalves 同源（sameHalfCopies / crossHalfPairs / danglingRefs）', v2.totals.sameHalfCopies === 1 && v2.totals.crossHalfPairs === 0 && v2.totals.danglingRefs === 0 && v2.totals.copiedPaths === 1)
  t('V2 产物两跑逐字节一致（可复算）', JSON.stringify(v2) === JSON.stringify(buildRouteArtifactV2([R('forge-x', 'forge-x/lib/a.js', 1, PT('forge-x', 'q')), R('forge-x', 'forge-x/src/b.ts', 2, PT('forge-x', 'q')), R('forge-x', 'forge-x/src/c.ts', 3, PT('forge-x', 'q'))])))

  /* ── 跨 bundle 成对（ISS-793，09-24）：名单由调用方传入，四向都要有判别力 ── */
  // ⚠️ 这条路径是**拼出来**的，不能直写：本文件自己在度量扫描射程内，直写就等于"守门员下场踢球"——
  //    第一版我把名单写在源码常量里，mermaid 那条 path 立刻从两份变成三份，恰好匹配规则随即拒绝豁免（实测过两次）。
  const CBP = "forge-legacy/mermaid/mermaid.min.js"
  const LIST = [{ p: "/" + CBP, files: ["forge-legacy/src/assets.ts", "forge-legacy/src/mermaid/chat-enhance.ts"], why: "两个独立 bundle" }]
  const cbRoutes = (extra = []) => [...LIST[0].files, ...extra].map((k, i) => R('forge-legacy', k, i + 1, LIST[0].p))
  const cbPair = routeHalves(cbRoutes(), LIST)
  t('跨 bundle 名单命中（文件集合恰好等于登记的那两个）⇒ 不算同半区抄写，另计入 crossBundleAssets', cbPair.sameHalf.length === 0 && cbPair.crossBundle.length === 1 && cbPair.staleCrossBundle.length === 0)
  const cbThird = routeHalves(cbRoutes(['forge-legacy/src/files/preview.tsx']), LIST)
  t('同一资源再多一处抄 ⇒ 名单**不豁免**并当场进 stale（名单不许当免死金牌，这是它唯一的失效方向）', cbThird.sameHalf.length === 1 && cbThird.crossBundle.length === 0 && cbThird.staleCrossBundle.length === 1)
  const cbGone = routeHalves([R('forge-legacy', LIST[0].files[0], 1, LIST[0].p)], LIST)
  t('登记的两处只剩一处 ⇒ 不豁免、记 stale（名单腐烂要看得见，不许静默少计）', cbGone.crossBundle.length === 0 && cbGone.staleCrossBundle.length === 1)
  const plainPair = routeHalves([R('forge-y', 'forge-y/src/a.ts', 1, PT('forge-y', 'b.min.js')), R('forge-y', 'forge-y/src/b.ts', 2, PT('forge-y', 'b.min.js'))], LIST)
  t('未登记的同半区两份 ⇒ 照旧算重复（反向：新加的资源地址不会因为"像跨 bundle"而自动免计）', plainPair.sameHalf.length === 1 && plainPair.crossBundle.length === 0)
  const noList = routeHalves(cbRoutes())
  t('不传名单 ⇒ 一律照计（默认必须保守，豁免只来自显式传入的基线文件）', noList.sameHalf.length === 1 && noList.crossBundle.length === 0)
  const cbV2 = buildRouteArtifactV2(cbRoutes(), LIST)
  t('V2 产物把豁免与 stale 一起落盘（totals 与 routeHalves 同源，不许只报数不留名）', cbV2.totals.sameHalfCopies === 0 && cbV2.totals.crossBundleAssets === 1 && cbV2.crossBundleAssets[0].files.length === 2)

  /* ── 名单从哪来（ISS-793 收尾，09-24）：唯一入口 = 别名登记表，四向都要有判别力 ── */
  // 夹具写在临时目录里，且 path 仍用拼出来的 CBP：直写整条路径会让本文件被度量算成第三份抄写（上面那条教训）。
  const xbDir = fs.mkdtempSync('/tmp/xb-reg-')
  const xbBase = path.join(xbDir, 'scripts', 'baseline')
  fs.mkdirSync(xbBase, { recursive: true })
  const xbReg = (entries) => { fs.writeFileSync(path.join(xbBase, 'route-aliases.json'), JSON.stringify({ entries })) }
  const xbPairEntry = { id: 'x-1', kind: 'cross-bundle-pair', path: '/' + CBP, owner: 'forge-legacy', measured: { crossBundle: LIST[0].files }, reason: LIST[0].why, retire: '不删' }
  xbReg([xbPairEntry, { id: 'x-2', kind: 'cross-pkg', path: '/other', owner: 'p', measured: { crossPkg: ['p'] }, reason: 'r', retire: 't' }])
  const xbLoaded = loadCrossBundleBaseline(xbDir)
  t('登记表里只有 kind=cross-bundle-pair 的条目进豁免名单（别的登记项一律不算）', xbLoaded.entries.length === 1 && xbLoaded.entries[0].p === '/' + CBP)
  const xbFeeded = routeHalves(cbRoutes(), xbLoaded.entries)
  t('登记表读出来直接喂 routeHalves 仍然恰好命中（p / files 字段映射写错就红）', xbFeeded.crossBundle.length === 1 && xbFeeded.sameHalf.length === 0 && xbFeeded.staleCrossBundle.length === 0)
  xbReg([])
  t('登记表里一条 cross-bundle-pair 都没有 ⇒ 空名单（不豁免，默认保守）', loadCrossBundleBaseline(xbDir).entries.length === 0)
  fs.rmSync(path.join(xbBase, 'route-aliases.json'))
  const xbMissing = loadCrossBundleBaseline(xbDir)
  t('登记表文件不存在 ⇒ 空名单 + missing 标记（C9 只会涨回去，不许静默免计）', xbMissing.entries.length === 0 && xbMissing.missing === true)
  fs.mkdirSync(xbBase, { recursive: true })
  fs.writeFileSync(path.join(xbBase, 'route-aliases.json'), '{ "note": "缺 entries 字段" }')
  t('结构不对（缺 entries）⇒ 空名单 + malformed，不崩', loadCrossBundleBaseline(xbDir).malformed === true)
  fs.writeFileSync(path.join(xbBase, 'route-aliases.json'), '{ 这不是 JSON')
  t('JSON 读不懂 ⇒ **当场炸**（第一版这里是个 catch { return [] }，把代码错误吞成"名单是空的"）', (() => { try { loadCrossBundleBaseline(xbDir); return false } catch { return true } })())
  fs.rmSync(xbDir, { recursive: true, force: true })

  const two = analyzeRoutes([R('forge-a', 'forge-a/lib/x.js', 1, PT('forge-a', 'list')), R('forge-a', 'forge-a/lib/y.js', 9, PT('forge-a', 'list'))])
  t('同一 path 出现在两个文件 ⇒ 进 copied', two.copied.length === 1 && two.copied[0][0] === PT('forge-a', 'list'))

  const same = analyzeRoutes([R('forge-a', 'forge-a/lib/x.js', 1, PT('forge-a', 'list')), R('forge-a', 'forge-a/lib/x.js', 40, PT('forge-a', 'list'))])
  t('同一 path 在同一文件里两次 ⇒ 不算 copied（口径按文件数，不是出现次数）', same.copied.length === 0 && same.byPath.get(PT('forge-a', 'list')).length === 2)

  const xp = analyzeRoutes([R('forge-a', 'forge-a/lib/x.js', 1, PT('shared', 'undefined')), R('forge-b', 'forge-b/lib/y.js', 2, PT('shared', 'undefined'))])
  t('同一 path 跨两个包 ⇒ 同时进 copied 与 crossPkg', xp.copied.length === 1 && xp.crossPkg.length === 1 && xp.crossPkg[0][1].length === 2)

  const own = analyzeRoutes([R('forge-a', 'forge-a/lib/x.js', 1, PT('forge-a', 'one'))])
  t('自己包内的单个端点 ⇒ 三条都不进', own.copied.length === 0 && own.crossPkg.length === 0 && own.alien.length === 0)

  const al = analyzeRoutes([R('forge-a', 'forge-a/lib/x.js', 1, PT('forge-b', 'thing'))])
  t('在 A 包里写 B 包前缀 ⇒ 进 alien（边界渗漏）', al.alien.length === 1 && al.alienPairs.join() === 'forge-a → /forge-b')

  const root = analyzeRoutes([R('forge-a', 'forge-a/lib/x.js', 1, '/')])
  t('裸根路径 "/" 没有一级段 ⇒ 不判成渗漏（防空判）', root.alien.length === 0)

  const ART_IN = [R('forge-a', 'forge-a/lib/x.js', 1, '/a'), R('forge-a', 'forge-a/lib/y.js', 2, '/a')]
  const art = buildRouteArtifact({ routes: ART_IN })
  t('产物 totals.copiedPaths 与 C9 同源（同一条 routes 数组，不许另算一套）', art.totals.copiedPaths === analyzeRoutes(ART_IN).copied.length)
  t('同一输入两次组装逐字节一致（可复算；顺序不能靠 Map 之外的东西）', JSON.stringify(art) === JSON.stringify(buildRouteArtifact({ routes: ART_IN.slice() })))

  t('明细里文件按路径名字典序 + 行号升序（点名的时候要稳定）', (() => {
    const a = buildRouteArtifact({ routes: [R('p', 'p/z.js', 5, '/dup'), R('p', 'p/a.js', 9, '/dup'), R('p', 'p/a.js', 2, '/dup')] })
    const f = a.copied[0].files
    return f[0].k === 'p/a.js' && f[0].line === 2 && f[1].line === 9 && f[2].k === 'p/z.js'
  })())

  // 注释口径（ISS-715）：同一行既能"算代码"又能"算注释" ⇒ 两个方向必须同时成立，否则判据是恒真/恒假
  const codeThenDoc = '  const r = await fetch("/a/b") // 见 /a/b 的说明'
  t('整行注释（// 起头）⇒ 判成注释', isDocLine('// 取数走 "/a/b"', 10))
  t('块注释续行（* 起头）⇒ 判成注释', isDocLine(' * host "/a/b" 返回的一行', 8))
  t('代码里的字面量 ⇒ 不判成注释（同一条行，前一处）', !isDocLine(codeThenDoc, codeThenDoc.indexOf('/a/b')))
  t('行内注释之后的同一条 path ⇒ 判成注释（同一条行，后一处）', isDocLine(codeThenDoc, codeThenDoc.lastIndexOf('/a/b')))
  t('字符串里的 // 是 URL 协议，不当成注释起点', !isDocLine('  await fetch(`${base}/a/b`) // x'.replace('${base}', 'http://127.0.0.1:3210'), 30))
  t('引号内的转义不会把引号状态搞乱（含 \\" 的行仍算代码）', !isDocLine('  const s = "a\\"b" + "/a/b"', 20))
  const bad = cases.filter((c) => !c.pass)
  console.log(cases.map((c) => `${c.pass ? '✓' : '✗'} ${c.name}`).join('\n'))
  console.log(`路由明细自检 ${cases.length - bad.length}/${cases.length}`)
  return bad.length ? 1 : 0
}
