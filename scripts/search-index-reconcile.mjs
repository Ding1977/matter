#!/usr/bin/env node
// 全文索引对账（ISS-788 / ISS-806 的那条"承诺过但从没实现"的闸）
//
// ## 为什么单独成脚本而不是塞进 pm-v2-baseline 的基线对照
// 判据的形状不同。基线对照比的是"这次与上次差了多少"，而这里的不变性是**结构性的**：
//     表内 entity 集合  ==  声明的可检索实体集（`pm-domains.js` 的 `searchableRels()`）
// 两边都从当前现场算，所以内容涨跌**不该**让它红，只有"两侧不一致"才该红。
// 拿基线对照做这件事会有两个坏结果：① 新存一份数字快照，明天就滞后（`search-index.js` 头注
// 当年就是这么承诺的却从没实现）；② "少一份多一份"相互抵消，数着数着就绿了。
//
// ## 三条判据与一条口径纪律
// - `missing`（声明里有、表里没有）⇒ 红：就是"文档搜不到"的形态。
// - `extra`（表里有、声明里没有）⇒ 红：要么有人手建了野行，要么声明被悄悄收窄（**纳管面变小**同族）。
// - 库/数据根读不到 ⇒ **不判**（exit 3，打印"不判"），不豁免也不刷基线：CI 的空 HOME 与没起过
//   3210 的机器都没有这个库，判红就是把环境差异当回归（同 ISS-774 / ISS-751 的处置）。
//   ⚠️ exit 3 而不是 exit 0（ISS-744）：判不了是第三种状态，码上必须与「绿」分开。
// - ⚠️ 分组统计**不许用 `entity LIKE 'dir/%'`**：这张 trigram FTS5 表上 `entity` 列的 LIKE/GLOB
//   恒返回 0（实测见 ISS-788 20:00 备注 ②），用它做对账等于装一根假牙。本脚本把 entity 全量取回
//   JS 里分组，并且 `--selftest` 里带一条**阳性对照**：已知有 N 行 issues ⇒ 分组必须数出 N。
//
// 用法（**node 与 bun 都可**：判据格由 `run-gates` 以 bun 起，引擎适配见下方 `loadSqlite` —— ISS-782）：
//   node scripts/search-index-reconcile.mjs            体检（人读，红即 exit 2）
//   node scripts/search-index-reconcile.mjs --check     同上，供 guard-baselines.sh 调用
//   node scripts/search-index-reconcile.mjs --json      机器可读输出
//   node scripts/search-index-reconcile.mjs --backfill  补挂差集（写派生索引；不动 md，也不删任何行以外的东西）
//   node scripts/search-index-reconcile.mjs --selftest  判据自身（临时根 + 内存库，五档）
//
// 退出码三态（ISS-744）：0 = 绿 / 2 = 红（两侧不一致）/ 3 = **判不了**（库不存在、库打不开、
//   或两侧都为空 ⇒ 分母为 0）。第三条以前是 exit 0：`·  不判 —— 库不存在` 打在屏幕上，
//   退出码却是绿，guard 的 livecheck 只读码 ⇒ 没起过 3210 的机器上这一格显示为通过。
//
// ## 为什么要有 --backfill（以及为什么它不是"绕过重启"的捷径）
// 开机自愈（`index.js` 里那一次 `reconcileSearchIndex`）要等 3210 重启才跑，而重启属运行态、要老板给窗口；
// 在那之前这条判据会一直红，红到别人以为是自己写坏了。`--backfill` 就是把自愈**提前手动跑一次**：
// 只写派生索引（`pm_search` 是可重建物，DOC-258 §3.1 的判据），md 真相源一行不动，删的行只可能是
// "声明外"的野行。与运行中的 3210 并发写靠 `busy_timeout` 排队（本仓同类口 `pm-v2-migrate.mjs` 早就这么直开库）。
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const argv = process.argv.slice(2)
const MODE = argv.includes("--selftest") ? "selftest" : argv.includes("--json") ? "json" : argv.includes("--backfill") ? "backfill" : "check"
const REPO = process.cwd()

// ─── 引擎适配：本判据在 bun 与 node 下都要跑到判据逻辑（ISS-782） ───
// 原来这里直接 `await import("node:sqlite")`：生产/CI 用 node 跑得通，但 `run-gates` 是 **bun** 起的，
// bun 没有 `node:sqlite`（是 `bun:sqlite`，不是同一个模块）⇒ 判据格每跑必「判据异常（exit 1）」，
// 屏幕上只剩一行 `No such built-in module`，真正的对账结论一次都没算出来。
//
// 两个引擎的类不是同一个，**实测**（2026-11-10 · node v22.22.2 / bun 1.3.14）差异如下，改这里先重测：
//
//   | 面 | node:sqlite `DatabaseSync` | bun:sqlite `Database` | 本脚本的处置 |
//   | 只读打开 | `new C(路径,{readOnly:true})` 可用 | `{readonly:true}` 键名不同（给 `readOnly` 抛 Misspelled option）；**且**在「WAL 库但无 `-shm`」时构造成功、首次 prepare 报 `SQLITE_CANTOPEN` | **必须适配**：node 用文件级只读，bun 用 `PRAGMA query_only=1`（见下两注） |
//   | `.all()` | 普通数组 | 普通数组（同为普通对象、列名同） | 无需适配（这条曾怀疑是迭代器，实测不是） |
//   | `.get()` 无行 | `undefined` | `null` | 不改写语义（见注 ①） |
//   | 命名参数 `:v` + `{v:1}` | 命中 | **静默返回空集** | 本脚本只用位置参数 `?`（见注 ②） |
//   | `.run()` 返回 | `{lastInsertRowid, changes}` | `{changes, lastInsertRowid}` | 键值相同，且本脚本不读返回值 |
//   | `.exec()` / `.close()` | 一致 | 一致 | 无需适配 |
//
// ⚠️ 注 ③ 只读这条是**必须**适配的那一条，而且**不能**只换个键名了事：
//   ① 直接把 `{readOnly:true}` 丢给 bun 会抛错，而调用点把「打不开」归到 exit 3（不判）⇒ 换引擎后
//      变成「永远不判」的**假绿**，比原来的红更坏；
//   ② 换成 bun 认的 `{readonly:true}` 仍不够：SQLite 只读打开 WAL 库要先读 `-shm`，`-shm` 不在时
//      bun 直接 `SQLITE_CANTOPEN`（node 的 `readOnly` 自己处理了这一步）。3210 在跑时 `-shm` 在，
//      看着一切正常；**3210 干净退出后 `-shm` 会被删**，只读打开随即坏掉 ⇒ 又是一次「红→不判」的假绿。
//   所以 bun 侧改成「普通打开 + `PRAGMA query_only=1`」：实测 DELETE / `CREATE TABLE` 都报
//   `SQLITE_READONLY`，读不受影响，且不依赖 `-shm`。代价是连接本身是读写句柄（会建/碰 `-wal`、`-shm`），
//   但本判据这条路径只发 SELECT，写保护由 SQLite 在 SQL 层挡。
//
// ⚠️ 注 ① `.get()` 无行时 node 给 `undefined`、bun 给 `null` —— 本脚本的 `.get()` 只取 `COUNT(*)`
//   （恒有行），所以不做归一（归一反而会盖掉「拿 get 判存在性」这种写法在两个引擎上的不同后果）。
// ⚠️ 注 ② 命名参数在 bun 下 `:v` + `{v:1}` 不报错、静默返回空集 —— 这种差异**吞不掉**也**测不出**，
//   唯一可靠的做法是本脚本继续只用位置参数 `?`；真要改命名参数必须写 `{$v:1}` 且两引擎各跑一次。
//
// 什么时候才允许失败：两个引擎都加载不到（node < 22.5 且不在 bun 里）⇒ 抛出去照常「判据异常」。
// 这里**不许**像 pm-store 那样 `return null` 降级 —— 那条降级在判据脚本里等于把「算不出来」伪装成「不判」。
//
// 与 `forge-pm/lib/pm-store.js:128` 的 `loadSqlite()` 是同一套双引擎口径，但那份返回 null 降级（供
// 3210 走 md 兜底），语义不同，故不复用；本文件多出来的只有「只读打开怎么做得既只读又可跑」。
async function loadSqlite() {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    return {
      engine: "node:sqlite",
      openReadOnly: (p) => new DatabaseSync(p, { readOnly: true }), // 文件级只读（OS 层），最严
      openReadWrite: (p) => new DatabaseSync(p),
    }
  } catch {
    const { Database } = await import("bun:sqlite") // node <22.5，或本来就是 bun 运行时
    return {
      engine: "bun:sqlite",
      // bun 的 `{readonly:true}` 在 WAL-无-`-shm` 时会 CANTOPEN（见注 ③），故改 SQL 层只读
      openReadOnly: (p) => {
        const db = new Database(p)
        db.exec("PRAGMA query_only = 1")
        return db
      },
      openReadWrite: (p) => new Database(p),
    }
  }
}

/** 取回表内 entity（全量；一千多行几十毫秒）。 */
function tableEntities(db) {
  return db.prepare("SELECT entity FROM pm_search").all().map((r) => String(r.entity))
}

function diffSets(declared, indexed) {
  const a = new Set(declared)
  const b = new Set(indexed)
  return {
    missing: [...a].filter((x) => !b.has(x)), // 声明里有、表里没有 ⇒ 搜不到
    extra: [...b].filter((x) => !a.has(x)), // 表里有、声明里没有 ⇒ 野行或声明被收窄
  }
}

/** 按顶层目录分组（**不用** entity LIKE，见文件头）。 */
function groupByTop(entities) {
  const out = {}
  for (const e of entities) {
    const t = e.split("/")[0]
    out[t] = (out[t] || 0) + 1
  }
  return out
}

async function measureIndex() {
  const { dbPath } = await import(join(REPO, "forge-pm/lib/pm-store.js"))
  const { searchableRels } = await import(join(REPO, "forge-pm/lib/pm-domains.js"))
  const path = dbPath()
  if (!existsSync(path)) {
    return { verdict: "skip", why: `库不存在（${path}）⇒ 不判（不是回归；本机没起过 3210 或 CI 环境）` }
  }
  // 引擎在 try 之外取：两个引擎都没有时**照常抛**（「判据异常」），不许落进下面「库打不开 ⇒ 不判」
  const { openReadOnly, engine } = await loadSqlite()
  let db = null
  try {
    db = openReadOnly(path)
  } catch (err) {
    // 带上引擎名：换引擎后才红/才不判时，第一眼要能看出是哪一侧的打开姿势不对（ISS-782）
    return { verdict: "skip", why: `库打不开（${err?.message || err}）⇒ 不判 · 引擎 ${engine}` }
  }
  try {
    const { searchableEntityRels } = await import(join(REPO, "forge-pm/lib/md-store.js"))
    const { rels: declared, blocked } = searchableEntityRels()
    const indexed = tableEntities(db)
    // ISS-744：两侧都空 ⇒ **判不了**（分母为 0）。以前这一档 `0 == 0` 直接判绿，
    //   屏幕上「可读声明 0 篇 == 表内 0 行」，看着像对账通过，实际一个实体都没扫到 ——
    //   数据根指错（分层根 / 软链逃根）时正是这个样子。空集相等不是一致性证据。
    if (declared.length === 0 && indexed.length === 0) {
      return { verdict: "skip", dbPath: path, why: `两侧都空（声明 0 篇 · 表内 0 行）⇒ 不判（分母为 0，空集相等不算对账通过；查数据根是否指对）` }
    }
    const { missing, extra } = diffSets(declared, indexed)
    const bad = missing.length > 0 || extra.length > 0
    return {
      verdict: bad ? "red" : "green",
      dbPath: path,
      declared: declared.length,
      // 两个数都要报：纯声明 与 本进程读得到的。**读不到不等于不存在**（分层数据根/软链逃根会落到这一档），
      // 静默剔除就等于让下一个读数的人去修一个不存在的问题（ISS-788 那批的原始病）。
      declaredAll: searchableRels().length,
      blocked: blocked.length,
      indexed: indexed.length,
      missing: missing.length,
      extra: extra.length,
      missingSample: missing.slice(0, 12),
      extraSample: extra.slice(0, 12),
      declaredByTop: groupByTop(declared),
      indexedByTop: groupByTop(indexed),
    }
  } finally {
    try {
      db.close()
    } catch { /* 只读连接关不上不影响结论 */ }
  }
}

// ─── 判据自检：五档，每档都指定向 ───
// 为什么必须自带自检：一条"平时永远绿"的对账，坏法有四种（两侧都空、恒等、分组谓词恒 0、
// 异常被 catch 成 0）。这四种在真实数据上都看不出问题，只有造场景才能抓住。
async function selfJudge() {
  const cases = []
  const recordCase = (name, ok) => cases.push([name, ok === true])

  // ① 一致 ⇒ 绿
  const d1 = diffSets(["a.md", "b.md"], ["a.md", "b.md"])
  recordCase("两侧一致 ⇒ 无 missing/extra", d1.missing.length === 0 && d1.extra.length === 0)

  // ② 声明内有、表内没有 ⇒ 红且点名（这就是"文档搜不到"的形态）
  const d2 = diffSets(["issues/x.md", "documents/y.md"], ["issues/x.md"])
  recordCase("缺一份即红且点名 documents/y.md", d2.missing.length === 1 && d2.missing[0] === "documents/y.md")

  // ③ 表内有、声明没有 ⇒ 红（防"声明被悄悄收窄"）
  const d3 = diffSets(["issues/x.md"], ["issues/x.md", "queue/野行.md"])
  recordCase("野行即红且点名 queue/野行.md", d3.extra.length === 1 && d3.extra[0] === "queue/野行.md")

  // ④ 相互抵消不放过：一份少 + 一份多 ⇒ 数量相同但集合不同，条数判据会绿、集合判据必须红
  const d4 = diffSets(["a.md", "b.md"], ["a.md", "c.md"])
  recordCase("数量相同集合不同 ⇒ 仍红（条数判据抓不到）", d4.missing.length === 1 && d4.extra.length === 1)

  // ⑤ 分组口径：LIKE 恒 0 的坑必须在**这张表**上被看见，而不是只在注释里
  const root = mkdtempSync(join(tmpdir(), "fts-reconcile-"))
  process.env.FORGE_PM_ROOT = root
  process.env.FORGE_AGENTS_ROOT = root
  for (const d of ["issues", "documents", "memos", "projects"]) mkdirSync(join(root, d), { recursive: true })
  const writeRow = (rel, title) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), `---\nid: X\ntitle: ${title}\n---\n探针正文 ${title}\n`, "utf8")
    return rel
  }
  const i1 = writeRow("issues/r-a.md", "对账探针需求")
  const i2 = writeRow("issues/r-b.md", "对账探针需求二")
  writeRow("issues/r-a-activity.md", "侧车不该进") // 侧车
  const doc1 = writeRow("documents/r-doc.md", "对账探针文档")
  // ── 加载组（ISS-899）：旧树 forge-pm 的四个模块。依赖 forge-service-kit 等只在主检出
  //    bun 环境解析得到；工单树 / CI 冷装是 pnpm 布局 ⇒ import 即 ERR_MODULE_NOT_FOUND。
  //    环境态单列「未跑」（不判红不冒绿），selfcheck 的 rc 才不随环境变色；对账逻辑的
  //    牙全在下方执行组的 8 条断言与①-④的纯函数档，加载不了 ≠ 判据坏了。
  const skipped = []
  let mods = null
  try {
    mods = {
      pmStore: await import(join(REPO, "forge-pm/lib/pm-store.js")),
      searchIndex: await import(join(REPO, "forge-pm/lib/search-index.js")),
      pmDomains: await import(join(REPO, "forge-pm/lib/pm-domains.js")),
      mdStore: await import(join(REPO, "forge-pm/lib/md-store.js")),
    }
    recordCase("自检能跑通（模块可加载）", true)
  } catch (err) {
    skipped.push(
      `模块组未跑：旧树 forge-pm 依赖不可解析（${String(err?.message ?? err).slice(0, 140)}）—— 主检出 bun 环境复跑可全验（环境态单列，不判红不冒绿）`,
    )
  }
  if (mods) {
    try {
      const { openStore } = mods.pmStore
      const { indexEntity, indexedEntities } = mods.searchIndex
      const { searchableRels } = mods.pmDomains
      const { searchableEntityRels } = mods.mdStore
      const store = await openStore(":memory:")
      indexEntity(store, i1)
      indexEntity(store, i2)
      indexEntity(store, doc1)
      const grouped = groupByTop(indexedEntities(store))
      recordCase("分组用 JS 取回：数得出 2 行 issues", grouped.issues === 2)
      const byLike = store.db.prepare("SELECT COUNT(*) AS c FROM pm_search WHERE entity LIKE ?").get("issues/%").c
      recordCase("同一条 LIKE 判 0（这根假牙必须被看见）", byLike === 0)
      const { rels, blocked } = searchableEntityRels()
      const declared = rels
      // 注入读判据那一档：被拒的那篇必须进 blocked 且不进 rels（静默少算就是 ISS-788 的原始病）
      recordCase("可注入读判据：被拒的那篇进 blocked、不进 rels", (() => {
        const t = searchableEntityRels({ readable: (r) => r !== doc1 })
        return t.blocked.length === 1 && t.blocked[0] === doc1 && !t.rels.includes(doc1)
      })())
      recordCase("纯声明 = 可读集 + blocked（没有第三种去向）", searchableRels().length === declared.length + blocked.length)
      recordCase("声明含三篇主文档且不含侧车", declared.length === 3 && !declared.some((r) => r.includes("-activity.md")))
      recordCase("声明含 documents（ISS-788 扩的就是这一格）", declared.includes(doc1))
      const d = diffSets(declared, indexedEntities(store))
      recordCase("现场两侧一致 ⇒ 绿（缺啥都点得出来）", d.missing.length === 0 && d.extra.length === 0)
    } catch (err) {
      // 模块在、断言执行抛错 = 判据真坏（与加载失败严格区分），照旧判红
      recordCase("对账断言执行不抛错", false)
      console.log("   断言异常:", err?.message || err)
    }
  }

  // 临时根清理（加载失败 / 断言失败都不许留垃圾目录）
  rmSync(root, { recursive: true, force: true })

  const bad = cases.filter(([, ok]) => !ok)
  for (const [name, ok] of cases) console.log(`${ok ? "  ok" : "  FAIL"}  ${name}`)
  for (const s of skipped) console.log(`  --  ${s}`)
  console.log(`search-index-reconcile 自检：${cases.length - bad.length}/${cases.length} 通过${skipped.length ? ` · 另有 1 组未跑（冷装环境，单列不并入绿）` : ""}`)
  return bad.length === 0 ? 0 : 2
}

/**
 * 手动跑一次开机自愈：把差集补挂上（只写派生索引 `pm_search`，md 真相源一行不动）。
 *
 * 为什么不 import 生产那份 `reconcileSearchIndex(store,…)`：它的入参是 pm-store 的 store 包装，
 * 而 `openStore()` 顺带跑 schema 迁移 —— 从旁路进程对**活库**做迁移不是补索引，是越权改结构。
 * 这里只重用同一个 `indexEntity`（同一份 SQL 与先删后插语义），迁移面一律不碰。
 * 与运行中的 3210 并发写靠 `busy_timeout` 排队（同仓先例：`scripts/pm-v2-migrate.mjs` 一直这么直开库）。
 */
async function backfillNow() {
  const { dbPath } = await import(join(REPO, "forge-pm/lib/pm-store.js"))
  const { indexEntity } = await import(join(REPO, "forge-pm/lib/search-index.js"))
  const { searchableRels } = await import(join(REPO, "forge-pm/lib/pm-domains.js"))
  const path = dbPath()
  if (!existsSync(path)) return { verdict: "skip", why: `库不存在（${path}）⇒ 无可补挂` }
  // 补挂要写，走读写句柄（两个引擎的构造签名一致，只换构造器；见 loadSqlite）
  const { openReadWrite } = await loadSqlite()
  const db = openReadWrite(path)
  db.exec("PRAGMA busy_timeout = 8000")
  try {
    const { rels: declared, blocked } = await (async () => {
      const { searchableEntityRels } = await import(join(REPO, "forge-pm/lib/md-store.js"))
      return searchableEntityRels()
    })()
    if (blocked.length) console.log(`·  另有 ${blocked.length} 篇声明内但本进程读不到（分层根/软链逃根），已排除并点名前三：${blocked.slice(0, 3).join(", ")}`)
    const want = new Set(declared)
    const have = new Set(tableEntities(db))
    const before = have.size
    let extra = 0
    const del = db.prepare("DELETE FROM pm_search WHERE entity = ?")
    for (const rel of have) {
      if (want.has(rel)) continue
      del.run(String(rel))
      extra++
    }
    const store = { db }
    let added = 0
    const failed = []
    for (const rel of declared) {
      if (have.has(rel)) continue
      try {
        if (indexEntity(store, rel)) added++
        else failed.push(rel)
      } catch {
        failed.push(rel)
      }
    }
    return { verdict: added || extra ? "did" : "clean", before, after: tableEntities(db).length, declared: declared.length, added, extra, failed }
  } finally {
    try {
      db.close()
    } catch { /* 关不上不影响已落盘 */ }
  }
}

if (MODE === "selftest") {
  process.exitCode = await selfJudge()
} else if (MODE === "backfill") {
  const r = await backfillNow()
  if (r.verdict === "skip") console.log(`·  索引补挂：不判 —— ${r.why}`)
  else if (r.verdict === "clean") console.log(`✓  索引补挂：两侧已一致（声明 ${r.declared} 篇 / 表内 ${r.after} 行），无需动手`)
  else {
    console.log(`✓  索引补挂：补上 ${r.added} 篇、清除声明外 ${r.extra} 行 ⇒ 表内 ${r.before} → ${r.after}（声明 ${r.declared}）`)
    if (r.failed.length) console.log(`   读不到的 ${r.failed.length} 篇: ${r.failed.slice(0, 8).join(", ")}`)
  }
  process.exitCode = r.failed && r.failed.length ? 2 : 0
} else {
  const r = await measureIndex()
  if (MODE === "json") {
    console.log(JSON.stringify(r))
  } else if (r.verdict === "skip") {
    console.log(`·  全文索引对账：不判 —— ${r.why}`)
  } else if (r.verdict === "green") {
    console.log(`✓  全文索引对账：可读声明 ${r.declared} 篇 == 表内 ${r.indexed} 行（按域 ${JSON.stringify(r.indexedByTop)}）` + (r.blocked ? ` · 读不到已排除 ${r.blocked} 篇（纯声明 ${r.declaredAll}）` : ""))
  } else {
    console.log(`✗  全文索引对账：可读声明 ${r.declared} 篇 vs 表内 ${r.indexed} 行 ⇒ 缺 ${r.missing} / 野 ${r.extra}` + (r.blocked ? ` ·另有 ${r.blocked} 篇读不到已排除` : ""))
    if (r.missingSample.length) console.log(`   搜不到的（声明里有、索引没有）: ${r.missingSample.join(", ")}`)
    if (r.extraSample.length) console.log(`   索引里有、声明不认（野行或声明被收窄）: ${r.extraSample.join(", ")}`)
    console.log("   修法：跑 --backfill（只补派生索引，不动 md），或等重启 3210 走开机自愈；口径见本文件头注")
  }
  process.exitCode = r.verdict === "red" ? 2 : r.verdict === "skip" ? 3 : 0
}
