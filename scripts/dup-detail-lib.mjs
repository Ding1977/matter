// 重复实现 / 复制粘贴簇 / 靠 hoisting 侥幸解析的 import —— 三份**全量明细**（ISS-739）
//
// 为什么要有这个文件：窗口批（5 个包进 workspace）之后 K6a / K6b / K3b 各涨了 1~3 格，
// 而那三个度量的 offender 只存"每包前 10 个计数"⇒ **点不出名就还不了账**（ISS-739 正是卡在这里）。
// 同一族的先例是 ISS-732 给 Z2 做的 dead-exports.json 与 ISS-715 给 C9 做的 route-literals.json：
// 成员一律取盘点器**算好的同一份数组**，本文件不另扫一遍源码（两处扫 = 两处口径会漂）。
//
// ⚠️ 与另两个 lib 同一条纪律：本模块只做**组装与排序**，不改变任何判据口径；
//    D2 / D3 / H5b 的算法仍在 code-inventory.mjs 里，唯一一份。
//    `totals.*` 与三条度量恒等这件事由 selftestDup() 钉住。
//
// 明细的定位与 dead-exports 一样：**只报"在哪里"，不判"该不该动"**。
// 同名不同语义、簇是不是真重复、hoisting 要不要补声明 —— 判断归人，动手归老板点头之后的批次。

/** 排序 + 剥出可比对的纯数据。所有列表都显式排序 ⇒ 同一输入两次组装逐字节一致（可复算）。 */
function sitesOf(items) {
  return [...items].map((y) => `${y.k}:${y.line}`).sort()
}

export function buildDupArtifact({ multi, multiCross, clusters, undeclaredSoft }) {
  const sameName = [...multi]
    .map(([name, v]) => ({ name, n: v.length, pkgs: [...new Set(v.map((y) => y.pkg))].sort(), sites: sitesOf(v) }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
  const dupClusters = [...clusters]
    .map((c) => {
      const all = sitesOf(c.map((m) => ({ k: m.k, line: m.line })))
      return {
        root: c[0].name,
        n: c.length,
        pkgs: [...new Set(c.map((m) => m.pkg))].sort(),
        minToks: Math.min(...c.map((m) => m.toks)),
        members: all.length > 60 ? all.slice(0, 60) : all,
        truncated: all.length > 60,
      }
    })
    .sort((a, b) => b.n - a.n || a.root.localeCompare(b.root))
  const byPair = new Map()
  for (const u of undeclaredSoft) {
    const m = /^(\S+) import (\S+)：/.exec(u.d) || /^(\S+) 用了 (\S+)，/.exec(u.d) || []
    const key = `${m[1] || '?'} → ${m[2] || '?'}`
    if (!byPair.has(key)) byPair.set(key, [])
    byPair.get(key).push(u.k)
  }
  const hoisting = [...byPair.entries()]
    .map(([pair, ks]) => ({ pair, n: ks.length, sites: ks.sort() }))
    .sort((a, b) => b.n - a.n || a.pair.localeCompare(b.pair))
  return {
    tool: 'code-inventory.mjs --write-dup-detail（组装在 dup-detail-lib.mjs）',
    note: 'ISS-739 三格的"点名清单"：⑴ sameNameImpl = 同名多份实现（成员 = 度量 D2 的同一份数组，条数恒等于 D2 第一段）；⑵ dupClusters = 跨文件复制粘贴函数簇（成员 = 度量 D3 的同一份数组，条数恒等于 D3）；⑶ hoistingOnly = 未声明但靠 root 提升侥幸可解析的 import（条数恒等于 H5b）。members 每簇最多列 60 个（截断处标 truncated）。**只报在哪里，不判该不该动** —— 同名可能有两种语义、簇要人看是不是真复制、hoisting 要么补声明要么改依赖方向，判断归人，动手归老板点头之后的批次。',
    totals: {
      sameNameImpl: sameName.length,
      sameNameCrossPkg: multiCross.length,
      implSites: sameName.reduce((s, x) => s + x.n, 0),
      dupClusters: dupClusters.length,
      clusterFns: dupClusters.reduce((s, x) => s + x.n, 0),
      hoistingOnly: hoisting.reduce((s, x) => s + x.n, 0),
      hoistingPairs: hoisting.length,
    },
    sameNameImpl: sameName,
    dupClusters,
    hoistingOnly: hoisting,
  }
}

/** 判据自检（本文件自己的 CLI：`node scripts/dup-detail-lib.mjs --selftest`）：证明这份明细与三条度量同源，且可复算。
 *  ⚠️ 注释里曾写 `--selftest-dup` —— 那个 flag 只存在注释里（ISS-767 实测：`code-inventory --selftest-dup` 会白跑一次全量扫描）。 */
/** 不导出：它只被本模块自己的 CLI 入口调用——导出就是给度量 Z2 多一条零引用导出（09-22 实测把 K10b 从 804 顶到 805）。 */
function selftestDup() {
  const cases = []
  const t = (name, pass) => cases.push({ name, pass })
  const I = (pkg, k, line, name) => ({ name, kind: 'function', pkg, k, line })
  const F = (k, line, name, toks) => ({ k, line, name, toks, pkg: k.split('/')[0] })

  const multi = [['run', [I('a', 'a/lib/x.js', 3, 'run'), I('b', 'b/lib/y.js', 9, 'run')]]]
  const multiCross = [['run', multi[0][1]]]
  const clusters = [[F('a/lib/x.js', 3, 'run', 40), F('b/lib/y.js', 9, 'run', 42)]]
  const soft = [{ k: 'a/lib/x.js:12', d: 'a import forge-b：未声明，靠 hoisting 侥幸可解析' }]
  const art = buildDupArtifact({ multi, multiCross, clusters, undeclaredSoft: soft })

  t('D2 条数 = sameNameImpl 条数（同源，不另算一套）', art.totals.sameNameImpl === multi.length)
  t('D3 条数 = dupClusters 条数', art.totals.dupClusters === clusters.length)
  t('H5b 条数 = hoistingOnly 站点数', art.totals.hoistingOnly === soft.length)
  t('跨包同名单列（窗口批要看的就是这一格）', art.totals.sameNameCrossPkg === 1)
  t('成员带 file:line（点得出名才还得动）', art.sameNameImpl[0].sites.join(' ') === 'a/lib/x.js:3 b/lib/y.js:9')
  t('hoisting 配对成对可查（包 → 模块）', art.hoistingOnly[0].pair === 'a → forge-b')
  t('同一输入两次组装逐字节一致（可复算）', JSON.stringify(art) === JSON.stringify(buildDupArtifact({ multi: [...multi], multiCross: [...multiCross], clusters: [...clusters], undeclaredSoft: [...soft] })))
  const big = [[...Array(70)].map((_, i) => F(`p/f${i}.js`, i, 'big', 50))]
  const art2 = buildDupArtifact({ multi, multiCross, clusters: big, undeclaredSoft: [] })
  t('超大簇截断到 60 并显式标 truncated（不许静默少列）', art2.dupClusters[0].members.length === 60 && art2.dupClusters[0].truncated === true && art2.totals.clusterFns === 70)

  const bad = cases.filter((c) => !c.pass)
  console.log(cases.map((c) => `${c.pass ? '✓' : '✗'} ${c.name}`).join('\n'))
  console.log(`重复明细自检 ${cases.length - bad.length}/${cases.length}`)
  return bad.length ? 1 : 0
}

if (process.argv.slice(2).includes('--selftest')) process.exitCode = selftestDup()
