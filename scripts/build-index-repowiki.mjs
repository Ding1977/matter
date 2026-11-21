#!/usr/bin/env node
// forge-repowiki · 倒排索引重建入口（ISS-648）
//
// 用法（任意目录都行，脚本自己定位仓库根）：
//   node scripts/build-index-repowiki.mjs                重建并写盘（forge-repowiki/index/repo-wiki-index.json）
//   node scripts/build-index-repowiki.mjs --check        只比对：盘上索引 vs 重建结果（不稳定字段不参与）
//   node scripts/build-index-repowiki.mjs --out <path>   写到别处（排查用）
//   node scripts/build-index-repowiki.mjs --json         只出机器可读结果（CI 用）
//
// ## --check 的两个退出码（ISS-657：这两种「红」处置不同，必须分开）
//   1 = **内容不一致**：盘上索引与重建结果不同 ⇒ 重建一次并提交（派生数据，别手改）。
//   2 = **索引凭据失效**：索引自己记着「我是哪棵树、用哪份缓存算出来的」（`stats.spanSource.cachePath`），
//       而那个缓存文件现在不在了 ⇒ 先查「为什么这份索引不是本树生成的」，**别急着重建**。
//       重建会把现场盖掉（`cacheFiles` / `warm` 一起刷新），真问题就再也看不出来。
//   0 = 一致。
// ⚠️ 凭据失效**不单独判红**，理由见 `credentialState()` 的头注（fresh clone 恒红 ⇒ 闸会被关掉）。
//
// **为什么入口在仓根 scripts/ 而不在包内 forge-repowiki/scripts/**：
//  K5e（host 半直接同步写盘的文件数）的射程是**包内**源码，而写盘是这个脚本的正当职责
//  （索引是它的产物）。放仓根 scripts/ 是任务书给的第二个选项，且与
//  `scripts/impact-of-diff.mjs` 等开发工具同一层 —— 开发工具在仓根、运行期代码在包里，分层也更对。
//
// **为什么是 node 而不是 bun**：本脚本只用 lib/ 里已有的能力，而 lib 的 sqlite 层
// 优先 `node:sqlite`（引擎也跑 node）。用 node 跑 = 与生产同一条路径，测试跑 bun 只覆盖回退分支。
// 实测：node 24 自带 node:sqlite（实验性，会打一行 ExperimentalWarning，不影响结果）。
//
// **为什么 --check 单独一个模式**：`generatedAt` 每次重建都会变，直接逐字节比对永远红。
// 稳定部分由 `stableStringify` 剔除易变字段后比对 —— 判据是「除了时间戳，一个字节都没变」。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..")
const PKG_ROOT = path.join(REPO_ROOT, "forge-repowiki")

const argv = process.argv.slice(2)
// 名字带 `Flag`/`Arg` 后缀：全仓有 7 个脚本各有一份 `has`/`val`（K6a 同名多份），
// 本脚本不为凑数再造同名件 —— 叫得具体一点，盘点里就不算一份新的同名实现。
const rwHasFlag = (f) => argv.includes(f)
const rwArgOf = (f, d) => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1] }

const KNOWN = new Set(["--check", "--out", "--json", "--allow-empty-symbols", "--selftest"])
const unknown = argv.filter((a) => a.startsWith("--") && !KNOWN.has(a))
if (unknown.length) {
  // 参数写错不许静默退回默认模式 —— 那会让人以为「已经重建过了」
  console.error(`✗ 未知参数 ${unknown.join(" ")}\n  已知参数：${[...KNOWN].join(" ")}`)
  process.exit(2)
}

const { INDEX_REL_PATH, buildIndex, checkIndex } = await import(path.join(PKG_ROOT, "lib", "index-store.js"))

/** 写索引（原子写：同目录临时文件 + rename）。
 *  **为什么写在脚本里而不在 lib/**：K5e 的口径是「host 半直接同步写盘的文件数」——
 *  lib/ 是会被插件加载的代码，让它持有写盘能力既过不了那道门禁、也不是好分层。
 *  lib 只做「读三源 + 组装」（纯函数，可单测），写盘是入口脚本的事。 */
function writeIndex(index, filePath) {
  const target = filePath || path.join(REPO_ROOT, INDEX_REL_PATH)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // 原子写：写一半崩掉会留下半截 JSON，下次 --check 会把它当「内容变了」而不是「上次写挂了」
  const tmp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(index, null, 1) + "\n")
  fs.renameSync(tmp, target)
  return target
}

/** 索引的「凭据」——它自己记着的生成现场（`stats.spanSource.cachePath`）。ISS-657。
 *
 *  ## 为什么需要它
 *  `cachePath` 在 `index-store.js` 的 `VOLATILE_KEYS` 里被 `stableStringify` **剔除**
 *  （它是「这次在哪算的」而非索引内容）⇒ **内容比对结构上永远抓不到凭据问题**。
 *  于是「索引是从别的树的缓存算出来的」这件事，以前没有任何一处会报。
 *
 *  ## 判据：`cachePath` 指向的文件在不在
 *  展开 `~` 后 stat。不在 ⇒ `state:"missing"`；索引里没这个字段 ⇒ `state:"absent"`。
 *
 *  ## ⚠️ 为什么「凭据失效」不单独判红
 *  实测三条（2026-10-25，ISS-657）：
 *   ① `cachePath` 落在 `<git-dir>/impact-cache/`，而 `.git` **从不入库** ⇒ 任何 fresh clone、
 *      换机器、**换工作树**都不可能命中该文件（实测：ISS-656 树与主 checkout 的前缀就不同）。
 *   ② 缓存文件不在时内容比对**照样能算**（`checkIndex` 现算并重新暖缓存；实测删掉缓存后仍 exit 0）
 *      ⇒ 「凭据失效」≠「内容错误」，两者独立。
 *   ③ `repo-wiki-index.json` 是**入库**的派生数据：合并 ISS-656 后主仓索引会记着 ISS-656 树的缓存，
 *      那棵树一旦 `ws.sh rm`，主仓凭据又失效 —— 而内容仍然是对的。
 *  ⇒ 若「凭据失效即判红」，这道闸在**正常**的仓上恒红，随即被关掉，比没有闸更坏
 *  （正是本单要防的「装上就红、然后被绕过」）。
 *
 *  故凭据失效用**独立退出码 2 + 专属文案**（「可区分」是本单硬要求），
 *  但红不红按「这条能不能在**所有**机器上稳定成立」定。`ci-local.mjs` 据此报出但不计入 fails。
 *
 *  @returns {{ state: "ok"|"missing"|"absent", raw: string|null, abs: string|null, why: string|null }}
 */
export function credentialState(index) {
  const raw = index && index.stats && index.stats.spanSource && index.stats.spanSource.cachePath
  if (!raw || typeof raw !== "string") return { state: "absent", raw: null, abs: null, why: "索引里没有 stats.spanSource.cachePath（老索引或被裁剪）" }
  const abs = expandHome(raw)
  try { fs.accessSync(abs) } catch { return { state: "missing", raw, abs, why: `缓存文件不存在：${abs}` } }
  return { state: "ok", raw, abs, why: null }
}

/** `~/x` → `<home>/x`。`~` 前缀是 `index-store` 落盘时的缩写形态（见其 VOLATILE_KEYS 注释）。 */
export function expandHome(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p
}

/* ───────────────────────── --selftest：这把尺子自己要有牙（ISS-657）─────────────────────────
 * 判据纪律与仓里其它门禁一致（`lint-common --selftest` / `scan-input --selftest`）：
 * **既要证明该红能红，也要证明不该红的不红**，还要证明「黄灯不会把自己升级成红灯」。
 * 为什么要测 credentialState 而不是只跑一遍 --check：`--check` 要现算全仓（秒级），
 *   而判据本体只是「展开 ~ 后 stat 一下」—— 抽成函数就能秒验，且变异立刻红。
 */
function runSelftest() {
  const cases = []
  const t = (n, p) => cases.push({ n, p: !!p })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repowiki-cred-"))
  try {
    const live = path.join(tmp, "live.json")
    fs.writeFileSync(live, "{}")

    // ── 正控：文件真在 ⇒ ok ──
    t("凭据：文件存在 ⇒ state=ok", credentialState({ stats: { spanSource: { cachePath: live } } }).state === "ok")
    // ── 主判据：文件不在 ⇒ missing（这是本单要能报出来的那个信号）──
    const gone = path.join(tmp, "gone.json")
    const m = credentialState({ stats: { spanSource: { cachePath: gone } } })
    t("凭据：文件不存在 ⇒ state=missing", m.state === "missing")
    t("凭据：missing 时 why 里点名那个路径（人要能照着查）", (m.why || "").includes(gone))
    // ── `~` 必须展开：不展开的话任何生产索引都会被判 missing（全仓恒黄）──
    const tilde = credentialState({ stats: { spanSource: { cachePath: "~/definitely-not-here-1577/x.json" } } })
    t("凭据：~ 前缀被展开（不是当字面量路径去 stat）", tilde.abs && !tilde.abs.startsWith("~/") && tilde.abs.includes(os.homedir()))
    t("凭据：~ 展开后仍不存在 ⇒ missing（展开不是把判据绕过去）", tilde.state === "missing")
    // ── 反控：没有凭据字段（老索引/被裁剪）⇒ absent，不是 missing 也不是 ok ──
    t("凭据：缺 spanSource.cachePath ⇒ state=absent（不冒充 ok）", credentialState({ stats: {} }).state === "absent")
    t("凭据：index 为 null ⇒ absent（不许抛）", credentialState(null).state === "absent")
    t("凭据：cachePath 非字符串 ⇒ absent（不许把对象当路径）", credentialState({ stats: { spanSource: { cachePath: 123 } } }).state === "absent")
    // ── expandHome 本体 ──
    t("expandHome：绝对路径原样返回", expandHome("/a/b") === "/a/b")
    t("expandHome：~/x ⇒ <home>/x", expandHome("~/x") === path.join(os.homedir(), "x"))
    t("expandHome：裸 ~ 不当前缀（避免把 ~foo 误展）", expandHome("~foo/x") === "~foo/x")

    const bad = cases.filter((c) => !c.p)
    console.log(cases.map((c) => `${c.p ? "✓" : "✗"} ${c.n}`).join("\n"))
    console.log(`\nbuild-index-repowiki --selftest ${cases.length - bad.length}/${cases.length} 通过`)
    return bad.length ? 1 : 0
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
  }
}

const target = rwArgOf("--out", path.join(REPO_ROOT, INDEX_REL_PATH))
const t0 = Date.now()

if (rwHasFlag("--selftest")) process.exit(runSelftest())

if (rwHasFlag("--check")) {
  /* ISS-657：先读盘上索引取凭据，**再**比对内容。顺序有意义 ——
     凭据失效是「这份索引从哪来」的问题，内容不一致是「它现在还对不对」的问题。
     两者同时存在时，先报凭据（它会解释内容为什么可能不一致，且重建会盖掉现场）。 */
  let diskIndex = null
  try { diskIndex = JSON.parse(fs.readFileSync(target, "utf8")) } catch { /* 盘上没有/坏了 ⇒ 由 checkIndex 报「不存在」 */ }
  const cred = diskIndex ? credentialState(diskIndex) : { state: "absent", raw: null, abs: null, why: "盘上索引读不到，无法取凭据" }
  const r = await checkIndex({ root: REPO_ROOT, filePath: target })
  const ms = Date.now() - t0
  /* 退出码语义（本单硬要求：两种「红」必须可区分）：
     1 = 内容不一致（重建并提交）· 2 = 凭据失效（先查为什么不是本树生成的）· 0 = 绿 */
  const credBad = cred.state !== "ok"
  const code = r.ok ? (credBad ? 2 : 0) : 1
  if (rwHasFlag("--json")) {
    console.log(JSON.stringify({
      ok: r.ok, code, why: r.why || null, differing: r.differing || null,
      credential: { state: cred.state, raw: cred.raw, abs: cred.abs, why: cred.why },
      ms,
    }, null, 1))
  } else if (r.ok && !credBad) {
    console.log(`✓ 索引与重建结果一致（不稳定字段已剔除）· 凭据有效 · ${ms}ms · ${path.relative(REPO_ROOT, target)}`)
  } else {
    if (!r.ok) {
      console.error(`✗ [内容不一致 · exit 1] ${r.why}`)
      console.error("  修法：node scripts/build-index-repowiki.mjs 重建一次并提交（这是派生数据，重建即可，不要手改）")
    }
    if (credBad) {
      /* 凭据这条**单独成段、单独措辞**：让人一眼看出「这不是内容错了」。
         措辞里必须写「别急着重」——重建会把 cachePath/cacheFiles/warm 一起刷新，现场就没了。 */
      /* 文案要求（Lead 2026-10-25）：必须能让人**自答**两件事 ——
         ① 索引由哪个路径生成、那文件为什么不在；
         ② **这不影响内容正确性**（否则下一个人会把黄灯当红灯修错方向）。
         第 ② 点是实测出来的：缓存文件不在时 `checkIndex` 照样现算 + 重暖（删缓存后仍 exit 0）
         ⇒ 「凭据失效」与「内容不一致」是两件独立的事，不能混着说。 */
      console.error(`⚠ [索引凭据失效 · exit 2] 这份索引记着的生成缓存已不在：`)
      console.error(`   索引自述由 ${cred.raw || "(无凭据字段)"} 生成`)
      console.error(`   该文件现在${cred.abs ? `不存在（${cred.abs}）` : "取不到"}`)
      console.error(`   ⚠️ 这**不影响内容正确性**：缓存只是"当时怎么算的"的现场凭据，`)
      console.error(`      内容对不对由 exit 1 那条判据独立回答（本次内容比对：${r.ok ? "一致 ✓" : "不一致 ✗"}）。`)
      console.error("   为什么常见：缓存落在 <git-dir>/impact-cache/，`.git` 从不入库 ⇒")
      console.error("      fresh clone / 换机器 / 换工作树 都必然没有它。这是常态，不是缺陷。")
      console.error("   要查什么：git log 该索引文件，看它在哪棵树里生成（重建会把现场盖掉，别急着来）。")
      console.error("   若只是换树/换机器、且上面内容比对一致：重建一次即可恢复凭据（会刷新 cachePath/cacheFiles/warm）。")
    }
  }
  process.exit(code)
}

const index = await buildIndex({ root: REPO_ROOT })

/* C3：**符号全空的索引不该能悄悄进 git**。
   冷启动（无 node_modules / 缓存未命中且暖缓存失败）实测会产出 `求出符号 0（0.0%）· 零声明 3575`，
   而旧版照样打印 `✓ 索引已写` 并 exit 0 —— 唯一痕迹是嵌套两层的 `stats.spanSource.warm.ok`。
   一份「所有锚点都没有符号名」的索引对 P3 是**有毒的**：它看起来是合法产物，用起来全是空。
   判据：暖缓存失败 **或** 原文口径一个符号都没求出来 ⇒ 拒绝落盘（除非显式 --allow-empty-symbols）。 */
const warm = index.stats.spanSource && index.stats.spanSource.warm
const symbolsEmpty = !index.stats.rawSymbolFound && !index.stats.symbolFound
const warmBroken = warm && warm.ok === false
if ((warmBroken || symbolsEmpty) && !rwHasFlag("--allow-empty-symbols")) {
  console.error("✗ 拒绝写出符号全空的索引 —— 这份产物对下游是毒药（看起来合法、用起来全空）：")
  if (warmBroken) console.error(`   · 暖缓存失败：${warm.why}`)
  if (symbolsEmpty) console.error(`   · 原文口径求出符号 ${index.stats.rawSymbolFound} / 代码锚点 ${index.stats.rawCodeAnchors}；索引内 ${index.stats.symbolFound} / ${index.stats.codeAnchors}`)
  console.error("   修法：先确保 impact-of-diff 的缓存可写（它需要 typescript 与 git），再重跑。")
  console.error("   若确实要产出一份无符号索引（例如只想验 reader 部分），显式加 --allow-empty-symbols。")
  process.exit(3)
}

const written = writeIndex(index, target)
const ms = Date.now() - t0
const bytes = fs.statSync(written).size
const s = index.stats

if (rwHasFlag("--json")) {
  console.log(JSON.stringify({ ok: true, path: written, bytes, ms, stats: s, sources: index.sources }, null, 1))
} else {
  if (symbolsEmpty || warmBroken) console.log(`⚠ 索引已写（**符号为空**，因显式 --allow-empty-symbols 放行）· ${(bytes / 1024).toFixed(1)} KB · ${ms}ms`)
  else console.log(`✓ 索引已写 ${path.relative(REPO_ROOT, written)} · ${(bytes / 1024).toFixed(1)} KB · ${ms}ms`)
  console.log(`  页 ${s.pages} · 索引内 refs ${s.refs}（去重）· 代码锚点 ${s.codeAnchors} · 求出符号 ${s.symbolFound}（${s.symbolRate_ofIndexed == null ? "n/a" : (s.symbolRate_ofIndexed * 100).toFixed(1) + "%"}）`)
  console.log(`  原文口径（未去重，与基线对账用）：refs ${s.rawRefs} · 带区间代码锚点 ${s.rawCodeAnchors} · 非代码带区间 ${s.rawNonCodeAnchors} · 求出符号 ${s.rawSymbolFound}（${s.symbolRate_ofCode == null ? "n/a" : (s.symbolRate_ofCode * 100).toFixed(1) + "%"}）· 交集空 ${s.rawModuleScope} · 零声明 ${s.rawNoSpans}`)
  console.log(`  索引内：非代码 ${s.nonCode} · 交集空 ${s.moduleScope} · 零声明 ${s.noSpans} · unresolved ${s.unresolved}`)
  console.log(`  原文口径：unresolved ${s.rawUnresolved}（其中代码 ${s.rawCodeUnresolved} / 非代码 ${s.rawNonCodeUnresolved}）`)
  for (const src of index.sources) {
    if (src.unavailable) console.log(`  源 ${src.kind}：不可用（${src.unavailable.reason}）— ${src.unavailable.why}`)
    else console.log(`  源 ${src.kind}：${src.path || ""}${src.pageCount != null ? ` · ${src.pageCount} 页` : ""}${src.snapshotState ? ` · 快照 ${src.snapshotState}` : ""}`)
  }
  const spanSrc = s.spanSource
  if (spanSrc) console.log(`  span 来源：缓存 ${spanSrc.cacheOk ? "命中" : `未用（${spanSrc.cacheWhy}）`} · 缓存文件 ${spanSrc.cacheFiles} · 命中 ${spanSrc.fromCache} · 未覆盖 ${spanSrc.missing} · 读不到 ${spanSrc.failed}`)
}
