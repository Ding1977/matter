// 客户端半产物落后检查（ISS-756 · 只报不红）
//
// 为什么需要：AGENTS §6「生效三类」写着 client 半（`src/**`）改动要 `build:client` + 重启 3210 + 刷新，
// 但**没有任何判据核这件事** —— `dist/client.js` 是 gitignored 产物，源码合进去了而产物没重建，
// 老板眼前的面板就静默跑旧代码，而且看不出来。09-23 实测撞到：`forge-monitor/dist/client.js` 建于
// 2026-09-20，而 `forge-monitor/src` 最后一次提交是 2026-09-22。
//
// 为什么**只报不红**（口径问题，不是偷懒）：判据比的是「源码最后提交时间」与「产物 mtime」，
// 而 rebase / `commit --amend` 会把提交时间刷成新的、产物却完全没问题 ⇒ 一旦判红就是按构造造假红。
// 本仓对假红的代价写过好几遍（ISS-701 三档口径里的第三档就是为此存在）。所以本脚本进的是
// 「计数类漂移只报」那一档：`--strict` 参数留着但**没有接红**，等它跑一段时间、看过假红率再决定升不升。
//
// 第二版口径修正（09-23 首跑实测）：原来用"有没有 src|surfaces|components 目录"当触发条件，
// 结果 4 条"缺产物"里 4 条都是假的 —— forge-design / forge-db / forge-shell 是**库**（只被 import，
// 按定义不产 bundle），forge-agents 的客户端件是由 `forge-pm` / `forge-model` 的 bundle 打包的
// （它们直接 import `forge-agents/agent-stream`）。⇒ 现在只判**包自己声明了 client 入口**的那些包
// （`exports` 里有 `./client` 或 `dsh.client`），未声明的包单独点名放在报告最后一行，不静默消失。
//
// 用法：node scripts/stale-client-bundle.mjs [--json|--selftest|--strict]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..'), A = process.argv.slice(2)
// 半区口径与 code-inventory.mjs:142 一致：client 半 = src / surfaces / components 三处
const CLIENT_DIRS = ['src', 'surfaces', 'components']
const DAY = 86400

const gitNum = (args) => {
  try { return Number(execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()) || 0 } catch { return 0 }
}

/** 一个包的证据行（纯数据，不含判断） */
function collect(pkg) {
  const abs = path.join(ROOT, pkg)
  const decl = clientDeclaration(abs) // 'none' | 'source' | 'built' + 产物路径
  const art = decl.artifact ? path.join(abs, decl.artifact) : ''
  const hasArt = !!art && fs.existsSync(art)
  let srcCt = 0, srcDir = ''
  for (const d of CLIENT_DIRS) {
    if (!fs.existsSync(path.join(abs, d))) continue
    const ct = gitNum(['log', '-1', '--format=%ct', '--', `${pkg}/${d}`])
    if (ct > srcCt) { srcCt = ct; srcDir = d }
  }
  return {
    pkg, hasClientHalf: srcCt > 0, srcCt, srcDir,
    clientDecl: decl.kind, artifact: decl.artifact || '',
    builtMtime: hasArt ? Math.floor(fs.statSync(art).mtimeMs / 1000) : 0,
    sloc: 0, // 保留位：将来要按"改动面"排优先级时再填（现在不猜）
  }
}

/** 客户端产物这件事，**只看包自己的声明**（规范 §0.3），不在脚本里另数目录形态。三种结果：
 *   'none'   没声明 client 入口 ⇒ 它不产自己的 bundle（库，或像 `forge-agents` 那样由别人的
 *            bundle 打包：`forge-pm` / `forge-model` 直接 import `forge-agents/agent-stream`）
 *   'source' 入口指向**源文件本身**（`forge-b-bridge` / `forge-b-embed` 的 `./client.js`）
 *            ⇒ 没有"构建"这一步，落后与缺产物都不适用于它
 *   'built'  入口指向构建产物（`./dist/client.js`）⇒ 本判据只管这种
 * 为什么不能只看"有没有 src/ 目录"，也不能写死 `dist/client.js`：09-23 首跑四条"缺产物"
 * 全是假的（三个库 + 一个被别人打包的），第二次修完又在主树露出两条假的（b-bridge / b-embed
 * 的 client 入口本来就是源文件）。⇒ 判据的正确形状是"读声明，按声明的指向分类"。 */
function clientDeclaration(abs) {
  let j
  try {
    j = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'))
  } catch {
    return { kind: 'none', artifact: '' } // 读不到 manifest ⇒ 不判，但报告会点名这类包
  }
  const exp = j.exports && typeof j.exports === 'object' ? j.exports : {}
  const raw = exp['./client'] ?? exp.client ?? null
  const target = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw.default ?? '') : ''
  if (target) return { kind: /(^|\/)dist\//.test(target) ? 'built' : 'source', artifact: target.replace(/^\.\//, '') }
  // 只有 dsh.client 而 exports 里没给 ./client 路径的（历史形态）：按约定产物在 dist/client.js
  if (j.dsh && (j.dsh.client || (j.dsh.web && j.dsh.web.client))) return { kind: 'built', artifact: 'dist/client.js' }
  return { kind: 'none', artifact: '' }
}

/** 判据（纯函数，自检靠它）。分类见上面 `clientDeclaration` 的三档。
 *  不参与判定的两类包也要**点名**，不许静默消失（静默排除 = 看不见，ISS-742 同族教训）。
 *  ⚠️ 故意不写 `export`：同模块自测不需要它，而度量 Z2 会把「导出但无人 import」计一格（K10b 实测踩过两次）。 */
function classifyStale(rows) {
  const stale = [], missing = [], notExpected = [], sourceShipped = []
  for (const r of rows) {
    if (r.clientDecl === 'none') { if (r.hasClientHalf) notExpected.push(r); continue }
    if (r.clientDecl === 'source') { sourceShipped.push(r); continue }
    if (!r.builtMtime) { missing.push(r); continue }
    if (r.builtMtime < r.srcCt) stale.push({ ...r, lagDays: Math.ceil((r.srcCt - r.builtMtime) / DAY) })
  }
  // 三个清单都必须**与输入顺序无关**（自检 ⑦ 就抓这个）：落后按天数倒序、同日按包名，其余按包名
  const byPkg = (a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0)
  return {
    stale: stale.sort((a, b) => b.lagDays - a.lagDays || byPkg(a, b)),
    missing: missing.sort(byPkg),
    notExpected: notExpected.sort(byPkg),
    sourceShipped: sourceShipped.sort(byPkg),
  }
}

/** 这棵树值不值得判：一个 dist 都没有（工作树典型状态）⇒ 判据不适用，而不是"全都缺"。 */
function treeHasArtifact(rows) { return rows.some((r) => r.builtMtime > 0) }

/** 这棵树像不像"构建过的树"：看**该产 bundle 的包里真产了产物**的占比（≥ 一半才算像）。
 *  只判"有没有一个 dist"不够 —— 工作树里只要手 build 过一个包，其余十几个包就全被点成"缺产物"
 *  （09-23 实测：ISS-694 工作树只构建过 forge-pm，旧写法报出 11 条假缺）。 */
function builtRatio(rows) {
  const need = rows.filter((r) => r.clientDecl === 'built')
  if (!need.length) return 0
  return need.filter((r) => r.builtMtime > 0).length / need.length
}

const selftestStale = () => {
  const rows = [
    { pkg: 'a', hasClientHalf: true, clientDecl: 'built', artifact: 'dist/client.js', srcCt: 100 * DAY, builtMtime: 90 * DAY },   // 落后 10 天
    { pkg: 'b', hasClientHalf: true, clientDecl: 'built', artifact: 'dist/client.js', srcCt: 100 * DAY, builtMtime: 101 * DAY },  // 新于源码 ⇒ 不该报
    { pkg: 'c', hasClientHalf: true, clientDecl: 'built', artifact: 'dist/client.js', srcCt: 100 * DAY, builtMtime: 100 * DAY },  // 恰好相等 ⇒ 不该报（边界）
    { pkg: 'd', hasClientHalf: true, clientDecl: 'built', artifact: 'dist/client.js', srcCt: 100 * DAY, builtMtime: 0 },          // 声明了 client 入口却没产物
    { pkg: 'e', hasClientHalf: false, clientDecl: 'none', artifact: '', srcCt: 0, builtMtime: 0 },                // 纯 host 包 ⇒ 完全不参与
    { pkg: 'f', hasClientHalf: false, clientDecl: 'none', artifact: '', srcCt: 0, builtMtime: 50 * DAY },         // 只有 dist 没有 client 半 ⇒ 不参与
    { pkg: 'g', hasClientHalf: true, clientDecl: 'none', artifact: '', srcCt: 100 * DAY, builtMtime: 0 },         // 有 src/ 但未声明入口（forge-agents 型）
    { pkg: 'h', hasClientHalf: true, clientDecl: 'none', artifact: '', srcCt: 100 * DAY, builtMtime: 60 * DAY },  // 同上，但有个陈旧 dist（不该报，也不该被当落后）
    { pkg: 'i', hasClientHalf: true, clientDecl: 'source', artifact: 'client.js', srcCt: 100 * DAY, builtMtime: 60 * DAY }, // 入口就是源文件（无构建这一步的包型）
  ]
  const { stale, missing, notExpected, sourceShipped } = classifyStale(rows)
  const cases = [
    ['① 产物早于源码提交 ⇒ 进落后清单', stale.map((s) => s.pkg).join() === 'a'],
    ['② 落后天数按天向上取整（10 天）', stale[0]?.lagDays === 10],
    ['③ 产物新于源码 / 恰好相等 ⇒ 都不报（边界不制造噪音）', !stale.some((s) => s.pkg === 'b' || s.pkg === 'c')],
    ['④ 声明了 client 入口但没产物 ⇒ 单独点名，不混进落后清单', missing.map((m) => m.pkg).join() === 'd'],
    ['⑤ 纯 host 包 / 只有产物的包 ⇒ 一律不参与', !stale.some((s) => s.pkg === 'e' || s.pkg === 'f') && !missing.some((m) => m.pkg === 'e' || m.pkg === 'f')],
    // 反向验证：把 a 的产物时间改到源码提交之后，它必须从清单里消失（判据不是恒报）
    ['⑥ 变异对照：把落后那条改成"产物更新" ⇒ 清单必须变空', classifyStale(rows.map((r) => (r.pkg === 'a' ? { ...r, builtMtime: 200 * DAY } : r))).stale.length === 0],
    ['⑦ 输入顺序不影响输出（可复算）', JSON.stringify(classifyStale(rows)) === JSON.stringify(classifyStale([...rows].reverse()))],
    ['⑧ 整树没有任何 dist ⇒ 判据不适用（工作树），不许报一屏"缺产物"', treeHasArtifact(rows.map((r) => ({ ...r, builtMtime: 0 }))) === false],
    ['⑨ 只要有一个 dist 就照判（不许因为"大部分缺"就整体跳过）', treeHasArtifact(rows.map((r) => ({ ...r, builtMtime: r.pkg === 'b' ? 101 * DAY : 0 }))) === true],
    // ↓ ISS-756 第二版：判据的输入从"有没有 src/ 目录"改成"包自己有没有声明 client 入口"
    //   （首跑误报四条：forge-design / forge-db / forge-shell 是库，forge-agents 的客户端件由别人的 bundle 打包）
    ['⑩ 未声明入口的包有 src 无产物 ⇒ 进 notExpected，不再被点名为缺产物', notExpected.map((x) => x.pkg).join() === 'g,h' && missing.map((m) => m.pkg).join() === 'd'],
    ['⑪ 变异对照：把 g 改成"声明了入口" ⇒ 必须立刻回到 missing（豁免真来自声明，不是判据变松）', (() => {
      const r = classifyStale(rows.map((x) => (x.pkg === 'g' ? { ...x, clientDecl: 'built' } : x)))
      return r.missing.map((m) => m.pkg).join() === 'd,g' && r.notExpected.map((x) => x.pkg).join() === 'h'
    })()],
    ['⑫ 未声明入口的包即便有个陈旧 dist ⇒ 也不报落后（陈旧产物不是"落后"，是另一种脏，本判据不混管）', !stale.some((s) => s.pkg === 'h')],
    ['⑬ 声明了入口的包不受这轮改动影响（落后清单与只看 src 的老口径一致）', stale.map((s) => s.pkg).join() === 'a'],
    // ↓ 工作树豁免的加强版：只看"有没有一个 dist"不够（build 过一个包就会让其余十几个被点成假缺）
    ['⑭ 8 个应产包里只 build 过 1 个 ⇒ 判"不像构建过的树"（不报那 7 条假缺）', (() => {
      const one = Array.from({ length: 8 }, (_, i) => ({ pkg: 'p' + i, clientDecl: 'built', artifact: 'dist/client.js', hasClientHalf: true, srcCt: 100 * DAY, builtMtime: i === 0 ? 99 * DAY : 0 }))
      return builtRatio(one) < 0.5 && treeHasArtifact(one) === true // 旧口径会判"这棵树有产物"⇒ 于是 7 条假缺
    })()],
    ['⑮ 变异对照：过半数补上产物 ⇒ 比例过线，"缺产物"必须恢复可判', (() => {
      const half = Array.from({ length: 8 }, (_, i) => ({ pkg: 'p' + i, clientDecl: 'built', builtMtime: i < 5 ? 99 * DAY : 0 }))
      return builtRatio(half) >= 0.5
    })()],
    ['⑯ 一个都不该产 bundle 的树 ⇒ 比例为 0（不许除零给出 NaN）', builtRatio([{ pkg: 'x', clientDecl: 'none', builtMtime: 0 }]) === 0],
    // ↓ 第三版：入口指向源文件的包（b-bridge / b-embed 型）既不该被点"缺产物"，也不该被点"落后"
    ['⑰ 入口=源文件的包 ⇒ 进 sourceShipped，绝不进 missing / stale', (() => {
      const r = classifyStale(rows)
      return r.sourceShipped.map((x) => x.pkg).join() === 'i' && !r.missing.some((m) => m.pkg === 'i') && !r.stale.some((s) => s.pkg === 'i')
    })()],
    ['⑱ 变异对照：把 i 的入口改成"指向 dist" ⇒ 它必须立刻变成"缺产物"（分类真来自声明）', (() => {
      const r = classifyStale(rows.map((x) => (x.pkg === 'i' ? { ...x, clientDecl: 'built', builtMtime: 0 } : x)))
      return r.missing.map((m) => m.pkg).join() === 'd,i' && r.sourceShipped.length === 0
    })()],
  ]
  let bad = 0
  for (const [n, ok] of cases) { console.log(`${ok ? '✓' : '✗'} ${n}`); if (!ok) bad++ }
  console.log(`stale-client-bundle selftest ${cases.length - bad}/${cases.length} 通过`)
  return bad ? 2 : 0
}
if (A.includes('--selftest')) process.exit(selftestStale())

const pkgs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && /^forge-/.test(d.name)).map((d) => d.name)
const rows = pkgs.map(collect)
// git 拿不到时间（浅克隆 / 非仓库）⇒ 这是"判不了"，必须明说并按失败退出，不许静默报"一切正常"
if (rows.some((r) => r.hasClientHalf && !r.srcCt) && gitNum(['rev-parse', '--git-dir']) === 0) {
  console.error('✗ 取不到源码提交时间（git 不可用？）—— 本判据判不了，按失败处理')
  process.exit(2)
}
const { stale, missing, notExpected, sourceShipped } = classifyStale(rows)
const fmtDay = (ct) => new Date(ct * 1000).toISOString().slice(0, 10)
// 工作树里通常**一个 dist 都没有**（产物不入库）⇒ 那不是"没构建"，是本判据在这棵树上不适用。
// 不先排掉这一种，工作树里跑会得到一屏假警示（同一族错误：把"看不见"当成"有问题"）。
// 整树一个 dist 都没有（工作树典型状态）⇒ "缺产物"这条在这棵树上判不出来，一起跳过（不是"全都缺"）
if (!treeHasArtifact(rows) && !stale.length) {
  console.log(`· 本树没有任何 client 半产物（多半是工作树）⇒ ISS-756 落后检查不适用，跳过（要判请跑主 checkout）`)
  process.exit(0)
}

if (A.includes('--json')) {
  console.log(JSON.stringify({ tool: 'stale-client-bundle.mjs', scanned: rows.length, stale, missing, notExpected, sourceShipped, builtRatio: Math.round(builtRatio(rows) * 100) / 100 }, null, 1))
  process.exit(0)
}
if (!stale.length && !missing.length) {
  console.log(`✓ 声明了 client 入口的包，产物都不落后源码（共 ${rows.filter((r) => r.clientDecl === 'built').length} 个 · 另有 ${notExpected.length} 个包不产自己的 bundle · ISS-756 只报不红）`)
  process.exit(0)
}
console.log(`· client 半产物落后源码（ISS-756 · **只报不红**：rebase/amend 会刷提交时间，判红就是造假红）`)
for (const s of stale) console.log(`   ⚠ ${s.pkg.padEnd(20)} dist/client.js 建于 ${fmtDay(s.builtMtime)}，${s.srcDir}/ 最后提交 ${fmtDay(s.srcCt)} ⇒ 落后 ${s.lagDays} 天`)
const builtish = builtRatio(rows) >= 0.5
if (!builtish && missing.length) console.log(`   · 该产 bundle 的包里只有 ${Math.round(builtRatio(rows) * 100)}% 有产物 ⇒ 这棵树多半没构建过，${missing.length} 条"缺产物"不判（要判请跑主 checkout）`)
else for (const m of missing) console.log(`   ! ${m.pkg.padEnd(20)} 声明了 client 入口但**没有** dist/client.js —— 从未构建或已清理`)
// 不参与判据的那批必须**点名**，不能静默消失（静默排除 = 看不见，ISS-742 同族教训）
if (notExpected.length) console.log(`   · ${notExpected.length} 个包有客户端代码但不产自己的 bundle（未声明 client 入口；由别人的包把它打进去）：${notExpected.map((x) => x.pkg).join(' ')}`)
if (sourceShipped.length) console.log(`   · ${sourceShipped.length} 个包的 client 入口就是源文件（没有构建这一步）：${sourceShipped.map((x) => x.pkg + '→' + x.artifact).join(' ')}`)
console.log(`   → 恢复到 HEAD：cd <包> && bun run build:client，再 bash scripts/restart-web-detached.sh + 刷新页面`)
console.log(`     ⚠️ 那会改变老板眼前的界面（可能把别人已合入但未生效的 client 改动推进运行态），属运行态动作`)
// 报告档：判据本身出错才非 0；发现落后不判红（要升红改这里并配 --strict 的接线，见 --strict 说明）
if (A.includes('--strict')) console.log('   （--strict 目前未接红 —— 故意留着：先看假红率，见文件头）')
process.exit(0)
