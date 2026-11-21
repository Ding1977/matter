// impact-of-diff · 符号级跨文件调用图（ISS-658）——「谁**调**这个符号」
//
// ## 为什么单独一个文件
// `scripts/impact-of-diff.mjs` 加完本功能实测 1240 行，越过 K2a 的 1000 行红线（god module 棘轮只许降）。
// 抽出来的判据一个字没改：抽取仍然**只用 `factsOf`**（`forge-repowiki/lib/symbols.js:7-13` 明令
// 不许有第二个 TypeScript 解析器 —— 两套 span 口径必然漂，而漂移是静默的）。
//
// ## 为什么是依赖注入，而不是本文件 import impact-of-diff
// 那是个**脚本**（模块级读 argv、跑到底就 set exitCode），import 它会执行它的主流程。
// 同 `impact-of-diff-selftest.mjs` 的取舍：本文件不 import 对方，对方把
// `factsCached` / `resolveSpec` / `innermost` / `saveIndex` / `pkgOf` / `isTest` 传进来。
// 代价是本文件不能单独跑，收益是**判据只有一份**。
//
// ## 与「谁 import 这个文件」的分工（本单的全部意义）
// `--who-imports`（文件级）答「会不会编译坏」；本模块（符号级）答「行为会不会变」。
// 实测两者不是一个数：`domain.js` 56 个 importer 里真调用 `activityEventState` 的只有 2 个。
//
// ⚠️ 这是 `scripts/` 下的 node 脚本，不是 host 半（`lib/**`）—— 但本仓 lint-scripts 同样扫它。
import fs from "node:fs"

/** @param {{ factsCached, resolveSpec, saveIndex, innermost, pkgOf, isTest }} deps */
export function makeCallGraph(deps) {
  const { factsCached, resolveSpec, saveIndex, innermost, pkgOf, isTest } = deps

/* 4b. 符号级跨文件调用图（ISS-658）
 *
 * ## 判据：**调用必须有 import 证据才成边**
 * JS/TS 模块没有跨模块隐式作用域 ⇒ 按名字裸匹配会把同名导出连成假依赖
 * （graphify `extract.py:10871`；本仓 `apply` 一个名字 **48 处定义**，裸匹配必炸）。
 * 所以一条边的完整证据链是**四步全中**，缺一步就不成边：
 *   ① 调用方文件里这次调用有 import 证据（`calls[].ev` 指向 `imports[]`，`factsOf` 时已算好）
 *   ② `resolveSpec` 把那个说明符解析到**本仓**的目标文件（解析不到 = 外部包/非源码，不是我们的事）
 *   ③ 目标文件里有这个名字的 span（`spans[]`；**没有 = 这个名字根本没声明在那，不许连**）
 *   ④ 目标文件**导出**了这个名字（`exported` 位）—— 没导出却能 import 到的，只可能是
 *      `export { X }` 的别名形态或我们抽错了；后者连边就是假边缘，前者由 `exported` 回填覆盖。
 *
 * ## 为什么不用属性访问的目标方法（`obj.run()`）
 * 只认 `a.f()` 里 **a 是 import 进来的命名空间/默认导出**的情形：那时 f 是目标文件的导出名，
 * 可核对。`this.m()` / `a.b.c()` / 局部对象的方法（`ctx.tools.register`）一律不产边 ——
 * 抽不到能核对的来源，硬连就是造边（`apply` 的 48 处同名就是这么来的）。
 *
 * ## confidence 恒 `INFERRED`
 * graphify `extract.py:10833`：没有类型检查器的名字级匹配只能算推断，不许标 `EXTRACTED`。
 *
 * ## 计数（任务书「不许静默丢」）
 * `droppedNoEvidence` / `droppedUnresolved` / `droppedNoSpan` / `droppedNotExported` / `droppedDynamic`
 * 五个都落盘并进渲染 —— 少报一个，读的人就会把「我们没算」当成「没有」。
 */
function buildCalls(files) {
  const fileSet = new Set(files)
  const out = [], dropped = { noEvidence: 0, external: 0, unresolved: 0, noSpan: 0, notExported: 0, dynamic: 0 }
  /** 说明符是否可能指向本仓（与 `resolveSpec` 的射程同口径：相对路径 或 forge- 前缀 / matter 前缀的裸包名）。
   *  **外部包（node:fs / react / typescript …）不进丢弃账**：那不是「我们没算出来」，
   *  而是「本来就不在射程内」。混在一起报会把 3 万条外部 import 说成「丢弃了大量边」，
   *  读的人会以为工具漏了一半 —— 这本身就是一种假账。 */
  const inScope = (spec) => !!spec && (spec.startsWith(".") || /^(forge-|matter)/.test(spec))
  /** 每个文件按名字建的 span 索引（同名多处时取**第一个导出的**：一个文件里同名导出本就罕见，
   *  而「第一个」是确定的 ⇒ 结果可复现，不会因遍历顺序不同而抖动）。 */
  const spanByName = new Map()
  const factsOfFile = new Map()
  for (const rel of files) {
    let f = null
    try { f = factsCached(rel) } catch { f = null }
    if (!f) continue
    factsOfFile.set(rel, f)
    const m = new Map()
    for (const s of f.spans || []) {
      const cur = m.get(s.name)
      if (!cur || (!cur.exported && s.exported)) m.set(s.name, s)
    }
    spanByName.set(rel, m)
  }
  /** 顺着转出口找到**真正声明**这个符号的文件（ISS-658）。
   *
   *  `import { cn } from "./lib/utils"` 里 utils.ts 只有 `export { cn } from "../ui/cn"` —
   *  cn 的 span 在 `ui/cn.ts`。不跟这一跳，全仓经 barrel / 适配层转发出去的调用**整片丢边**
   *  （实测这才是召回率的最大单笔：`cn` 82 条、`parseFrontmatter` 38 条）。
   *
   *  判据必须**仍然可核对**：只在目标文件确实把 `name` 转出时才跟，且跟过去以后要在
   *  下一站里真找到同名 span。这仍然是「有出处」的解析，不是按名字裸匹配。
   *  `seen` 防环（本仓存在 A→B→A 的适配层）。
   *  返回 `{ file, span, facts }` 或 null。 */
  const resolveThrough = (file, name, seen) => {
    const key = `${file}#${name}`
    if (seen.has(key)) return null
    seen.add(key)
    const f = factsOfFile.get(file)
    if (!f) return null
    const m = spanByName.get(file)
    const hit = m ? m.get(name) : null
    /* 本地有同名声明（且导出）⇒ 到此为止，它就在这里。 */
    if (hit && hit.exported) return { file, span: hit, facts: f }
    /* 具名转出口：`export { remote as name } from "s"` */
    for (const r of f.reexports || []) {
      const local = r.name === name ? r.remote : null
      if (!local) continue
      const t = resolveSpec(file, r.spec, fileSet)
      if (!t || t === file) continue
      const got = resolveThrough(t, local, seen)
      if (got) return got
    }
    /* `export * from "s"`：名字没在本文件出现，但可能整包转出。逐个星号源查（深度有限、带环保护）。 */
    for (const spec of f.reexportStars || []) {
      const t = resolveSpec(file, spec, fileSet)
      if (!t || t === file) continue
      const got = resolveThrough(t, name, seen)
      if (got) return got
    }
    return null
  }
  /** 调用点所在的最内层 span 名（= callerName）。`innermost` 与 diff 模式同一判据，不另写一份。 */
  const spanAt = (rel, line) => {
    const f = factsOfFile.get(rel)
    if (!f) return null
    const s = innermost(f.spans || [], line)
    return s ? s.name : null
  }
  for (const rel of files) {
    const f = factsOfFile.get(rel)
    if (!f) continue
    const d = f.dropped || { noEvidence: 0, dynamic: 0 }
    dropped.noEvidence += d.noEvidence || 0
    dropped.dynamic += d.dynamic || 0
    for (const c of f.calls || []) {
      const imp = (f.imports || [])[c.ev]
      if (!imp) { dropped.noEvidence++; continue }
      if (!inScope(imp.spec)) { dropped.external++; continue }
      const target = resolveSpec(rel, imp.spec, fileSet)
      if (!target || target === rel) { dropped.unresolved++; continue }
      const tm = spanByName.get(target)
      if (!tm) { dropped.unresolved++; continue }
      /* 目标文件名怎么定，看导入形态（**这是唯一的口径，别再加「按名字裸找」当兜底**）：
       · `import * as ns` / `const m = require() `（imported === "*"）⇒ 属性名即导出名：`ns.f()` → f
       · `import { a as b }` ⇒ imported 就是导出名：`b()` → a
       · `import d from` （imported === "default"）：目标文件的默认导出**本地名**由
         `defaultExport` 记着（`export default X` / `export default function foo`）；有名字就按它核，
         没有（`export default {}` 之类）⇒ 计 `noSpan`，**宁可少边不造边**。 */
      const tf = factsOfFile.get(target) || {}
      /* CJS 别名（`module.exports = { a: someFn }`）：导入名是 a，声明的名字是 someFn。
         先按别名表翻一次，再按同名找 —— 两条都是「可核对的出处」，不是裸猜。 */
      const aliased = imp.imported === "*" && tf.exportAlias ? tf.exportAlias[c.name] : imp.imported !== "*" && tf.exportAlias ? tf.exportAlias[imp.imported] : null
      const want = aliased || (imp.imported === "*" ? c.name : imp.imported === "default" ? tf.defaultExport : imp.imported)
      const hit = want ? tm.get(want) : null
      if (hit && hit.exported) {
        out.push({
          callerFile: rel, callerName: spanAt(rel, c.line), callerLine: c.line,
          calleeFile: target, calleeName: hit.name, calleeLine: hit.start,
          confidence: "INFERRED",
        })
        continue
      }
      /* 目标文件里没有（或没导出）这个名字 ⇒ **先看它是不是转出口**（barrel / 适配层）。
         跟到真正声明处才算成边；跟不到就按 noSpan 记账，不连。 */
      const via = want ? resolveThrough(target, want, new Set()) : null
      if (!via) { dropped.noSpan++; continue }
      out.push({
        callerFile: rel, callerName: spanAt(rel, c.line), callerLine: c.line,
        calleeFile: via.file, calleeName: via.span.name, calleeLine: via.span.start,
        confidence: "INFERRED",
        via: target,
      })
    }
  }
  /* 与 buildReverse 同一条纪律：算完落盘，否则每次跑调用图都要冷启动全仓重解析。
     `--call-graph` 因此也是一个**暖缓存入口**（index-store 用它一次拿到边 + 把缓存建全）。 */
  saveIndex()
  return { calls: out, dropped }
}


/* 8c. `--callers` 的单目标渲染（ISS-658）。**纯函数**（同 renderWhoBlock 的理由：不抽出来
 * 自测就只能断言常量，而「默认 20 条 + 总数」这类判据的错法正是「悄悄改成全列」或「悄悄截成 5」）。
 *
 * ## 排序判据（任务书给定，不是偏好）
 * 同包优先 → 跨包其次 → 测试文件最后。同一个问题「我改这个函数会影响到谁」，
 * 同包的调用方处置是「一起改」，跨包是「对契约」，测试是「跟着改断言」，三者的动作不同。
 *
 * ## 截断纪律：**热点函数不许整段省略**
 * `cn()` 实测入边 256 条。整段略掉等于让 agent 以为「没人调它」——那是本工具最危险的错法
 * （比缺边危险：agent 会照着空结果判断「安全可改」）。所以：
 *   ① 每个被调符号**必出一行汇总**（名字 + 入边数 + 文件数）—— 无论有多少条；
 *   ② 明细只列前 `limit` 条，且明说「只列前 N，共 M 条」。
 */
function renderCallersBlock({ norm, edges, dropped, quiet, verbose, limit = 20 }) {
  const pkg = pkgOf(norm), L = []
  const rankOf = (f) => {
    if (isTest(f)) return 2
    return pkgOf(f) && pkgOf(f) === pkg ? 0 : 1
  }
  const rankLabel = ["同包", "跨包", "测试"]
  const sorted = [...edges].sort((a, b) => rankOf(a.callerFile) - rankOf(b.callerFile) || (a.callerFile + a.callerLine) < (b.callerFile + b.callerLine) ? -1 : 1)
  const byCallee = new Map()
  for (const e of sorted) {
    if (!byCallee.has(e.calleeName)) byCallee.set(e.calleeName, [])
    byCallee.get(e.calleeName).push(e)
  }
  const json = {
    target: norm, pkg, edgeCount: sorted.length, calleeCount: byCallee.size,
    confidence: "INFERRED",
    callees: [...byCallee].map(([name, g]) => ({ name, count: g.length, files: new Set(g.map((e) => e.callerFile)).size })),
    edges: sorted,
    dropped,
  }
  L.push(`谁调用 ${norm}${pkg ? `（${pkg}）` : ""}`, "")
  if (!sorted.length) {
    L.push("  调用边 0 条（没有任何本仓文件**调用**它声明的符号 —— 注意这不等于「没人 import 它」，那问 --who-imports）")
  } else {
    const nFiles = new Set(sorted.map((e) => e.callerFile)).size
    L.push(`  入边 ${sorted.length} 条 · ${byCallee.size} 个符号 · ${nFiles} 个调用方文件 · 置信度 INFERRED（名字级匹配，无类型检查器：调用必须有 import 证据才成边）`)
    /* ① 每个符号一行汇总，**永不省略**（热点函数也在这里看得见数量）。 */
    L.push("", "  ■ 按被调符号（每个符号都列，不管多少条）：")
    const summ = [...byCallee].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
    for (const [name, g] of summ) L.push(`      ${name} · ${g.length} 条 · ${new Set(g.map((e) => e.callerFile)).size} 个文件`)
    /* ② 明细：前 `limit` 条 + 明确的总数。 */
    const show = verbose ? sorted : sorted.slice(0, limit)
    if (quiet) {
      L.push("", `  明细 ${sorted.length} 条（--quiet 不逐条列出；去掉 --quiet 看前 ${limit} 条）`)
    } else {
      L.push("", `  ■ 明细（同包优先 / 跨包其次 / 测试最后）：`)
      for (const e of show) L.push(`      ${e.callerFile}:${e.callerLine}${e.callerName ? ` ${e.callerName}()` : ""} → ${e.calleeName}()  〔${rankLabel[rankOf(e.callerFile)]}〕`)
      if (sorted.length > show.length) L.push(`      … 只列前 ${show.length} 条，共 ${sorted.length} 条（--verbose 看全）`)
    }
  }
  /* ③ 丢弃的必须报（任务书：不许静默）。这四类都是「我们没算」，不是「没有」。 */
  const d = dropped || {}
  const dsum = ["noEvidence", "external", "unresolved", "noSpan", "notExported", "dynamic"].map((k) => `${DROPPED_LABEL[k]} ${d[k] || 0}`)
  L.push("", `  · 未成边的调用（全仓口径，不是本目标的）：${dsum.join(" · ")}`)
  return { L, json }
}
/** 丢弃原因的**人话**（键名进 JSON、人话进渲染；两处同源，免得改了数字看不懂是哪一档）。 */
const DROPPED_LABEL = {
  noEvidence: "无 import 证据",
  external: "外部包（不在射程内）",
  unresolved: "说明符解析不到",
  noSpan: "目标文件无此名字",
  notExported: "目标未导出",
  dynamic: "callee 形态抽不出名",
}


/* 8d. `--callers <rel…>`：从**符号**出发问「谁在调我」（ISS-658）。
 *
 * 与 `--who-imports` 的分工是这一单的全部意义：**前者答「会不会编译坏」，后者答「行为会不会变」**。
 * 两个模式共用一次 `buildCalls`（它复用 `factsCached` ⇒ 与 wiki 索引同一份 span 缓存，
 * **不新建第二个 TS 解析器**，见 `forge-repowiki/lib/symbols.js:7-13`）。
 *
 * `--call-graph` 是它「全量输出版」：给召回率对照/调试用（`--json` 出全部边 + 丢弃计数）。
 */
function runCallersCli(g) {
  const { A, has, val, QUIET, VERBOSE, JSONOUT, ROOT, DROPPED_LABEL, buildCalls, renderCallersBlock, classifyTargets, scanFiles, parseVals, cacheStatus } = g
  if (!(has("--callers") || has("--call-graph"))) return
  {
  const graphOnly = has("--call-graph")
  const rawTargets = graphOnly ? [] : parseVals(A, "--callers").map((t) => String(t).replace(/^\.\//, ""))
  if (!graphOnly && !rawTargets.length) { console.error("✗ --callers 需要一个相对路径（可给多个文件；符号级调用方按文件聚合）"); process.exit(2) }
  const { ok: validTargets, missing, dir: dirTargets } = classifyTargets(rawTargets)
  if ((missing.length || dirTargets.length) && !graphOnly) {
    const msgs = []
    if (missing.length) msgs.push(`目标不存在：${missing.join("、")}（相对仓库根 ${ROOT}）`)
    if (dirTargets.length) msgs.push(`目标是目录而非文件：${dirTargets.join("、")}（请给到具体文件）`)
    for (const m of msgs) console.error(`✗ ${m}`)
    if (!validTargets.length) process.exit(2)
  }
  const PARTIAL_FAIL = !graphOnly && (missing.length > 0 || dirTargets.length > 0)
  const files = scanFiles()
  const t0 = Date.now()
  const { calls, dropped } = buildCalls(files)
  const tCalls = Date.now()
  if (graphOnly) {
    /* 全量：给召回率对照用。`--json` 是机器读的唯一形态（人读一屏放不下 3000+ 条）。 */
    const byFile = new Map()
    for (const e of calls) { if (!byFile.has(e.calleeFile)) byFile.set(e.calleeFile, []); byFile.get(e.calleeFile).push(e) }
    if (JSONOUT) console.log(JSON.stringify({ calls, dropped, files: files.length, edgeCount: calls.length, calleeFiles: byFile.size }, null, 0))
    else console.log(`调用边 ${calls.length} 条 · ${byFile.size} 个文件被调用 · ${files.length} 个文件扫描 · ${tCalls - t0}ms\n  丢弃：${Object.entries(dropped).map(([k, v]) => `${DROPPED_LABEL[k] || k} ${v}`).join(" · ")}\n  （--json 出全部边，供召回率对照）`)
    /* ⚠️ **不许用 `process.exit()`**：11k 条边的 JSON 是好几百 KB，`exit` 会在 stdout 还没刷完时
       就把进程掐掉 —— 实测管道读到 73KB 处截断，JSON 解析失败。`exitCode` + 自然结束才完整。
       （`--who-imports` 的 606 字节输出撞不到这个坑，所以那里一直是 exit；这里量级不同。） */
    process.exitCode = 0
  } else {
  const targets = validTargets.length ? validTargets : rawTargets
  const limit = Number(val("--limit", 20)) > 0 ? Number(val("--limit", 20)) : 20
  const blocks = targets.map((norm) => renderCallersBlock({
    norm, edges: calls.filter((e) => e.calleeFile === norm), dropped,
    quiet: QUIET, verbose: VERBOSE, limit,
  }))
  if (JSONOUT) console.log(JSON.stringify(blocks.length === 1 ? blocks[0].json : blocks.map((b) => b.json), null, 1))
  else {
    blocks.forEach((b, i) => { if (i) console.log(""); for (const l of b.L) console.log(l) })
    if (!QUIET) console.log(`\n扫描根 ${ROOT} · ${files.length} 个文件 · ${tCalls - t0}ms`)
    console.log(`缓存 ${cacheStatus.state}${cacheStatus.why ? `（${cacheStatus.why}）` : ""} · ${cacheStatus.dir}`)
  }
    /* 同一条理由（见上）：exitCode 而不是 exit —— 管道下大段 JSON 会被截断。
       代价是**不能落回下面的 diff 主流程**（那会多打一份无关分析）⇒ 见文件末尾的守卫。 */
    process.exitCode = PARTIAL_FAIL ? 2 : 0
  }
}
}

  return { buildCalls, renderCallersBlock, DROPPED_LABEL, runCallersCli }
}
