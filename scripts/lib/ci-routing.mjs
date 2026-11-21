// 逐包格（ci-typecheck-* / ci-test-*）的场景路由（ISS-817 · 从 run-gates.mjs 抽出）
//
// ## 为什么抽出来
// `verify-file-size` 是**只许降不许升**的棘轮（`scripts/baseline/file-size.json` 记
// `scripts/run-gates.mjs: 2056`）。本单的逻辑直接写进去会把 run-gates.mjs 顶到 2195 行 ⇒ 该格判红。
// 抽到 `scripts/lib/` 是本仓既有惯例（`gate-tables.mjs` / `registry-derive.mjs` 同一理由），
// 且这些函数与调度逻辑零耦合，本来就该在这里。
//
// ## 为什么需要场景路由
// 46 格逐包格此前**没有任何自动执行入口**：CI 不跑（2026-11-13 裁定远程只做仓库）、
// pre-push 只跑 fast 档（`ci-*` 不在 fast 里）、`package.json` 的 `"ci"` 全仓零调用方。
// ⇒ 23 个包的 typecheck 与 test 只在人手动想起时才跑。
//
// ## 为什么不直接全塞进 push
// 实测（本机 10 并发，`--only ci-` 47 格）**94s**；与 fast 档同池合成 ≈ 157~227s。
// pre-push 从 42s 变 200s+，人一定 `--no-verify` 绕过 ⇒「慢到没人用的闸等于没有闸」。
//
// ## 为什么**不**按包名推（第一版就是这么写的，实测会漏测）
// 直觉做法是「改了 forge-pm ⇒ 跑 ci-*-pm 及其依赖方」。实测两处漏：
//   · `forge-pm` 的 `src/pm/lexical/bridge.test.ts` 把 `docs/**\/*.md` 当语料读 ⇒ 只改 docs
//     时它必须跑，而按包名推会得到「没命中任何包 ⇒ 不跑」。
//   · `forge-pm` 的 typecheck 读面还含 `scripts/` 与 `(root)`（tsconfig extends 链）。
// 这正是 K8a 记的形态：按「看起来相关」推，而不是按**能证明的读面**推。
// ⇒ 判据复用 `narrowSelection()` + `attachDeclaredReads()`（ISS-720 / ISS-803 已在用、
// 自检已用合成格子逐条钉过）：读面**证明不了**的格一律照跑（宁多跑，不静默少跑）。
// 实测：46 格里 28 格能算出读面；18 格证明不了（`bun test` 全包的读根是运行期算的）⇒ 恒跑。
// 这也是「改 1 个包仍要跑 22 格」的原因 —— 那是**诚实**读数，不是收窄没生效。
//
// ## 与 `--only-changed` 的关系
// 用的是**同一个** `narrowSelection`，但调用点不同、目的不同：
//   · `--only-changed`：整档按读面收窄，且与 `--diff-baseline` 互斥（两棵树尺子必须一样）。
//   · 这里：只把 46 格的名单算出来，作为 `--include-cells` **原样下发给两棵树**
//     ⇒ `assertSameBatch` 照旧通过，「新增红」判据一点没松。

import { createHash } from "node:crypto"

/**
 * 纯函数：给定改动面，算「46 个逐包格该跑哪些」。
 *
 * @param {object} scope change-scope 的 summary（total/areas/packages）
 * @param {{allCells: number, gates: Array<object>, tops?: Set<string>, narrow: Function, topLevelAreas: Function}} ctx
 *   `narrow` / `topLevelAreas` 由调用方注入（run-gates.mjs 里那两个是本文件的兄弟函数，
 *   抽出来时它们留在原地 —— 复制一份就变成两个真相源，那比多一行参数糟得多）。
 * @returns {{kind:"cells",cells:string[],why:string}|{kind:"all",why:string}}
 */
export function planCiCells(scope, ctx) {
  const total = scope?.total ?? 0
  if (!total) return { kind: "all", why: "改动面为空 ⇒ 不等于没事要跑（改 PM 语料时四个桶全空，但确实影响本仓）" }
  const plan = ctx.narrow(ctx.gates, { summary: scope }, ctx.tops ?? ctx.topLevelAreas())
  if (plan.degraded) return { kind: "all", why: plan.degraded }
  const cells = plan.run.map((r) => r.gate.id).sort()
  const unknown = plan.run.filter((r) => String(r.why).startsWith("读面证明不了")).length
  const why = `${cells.length}/${ctx.allCells} 格（跳 ${plan.skipped.length} 格；其中 ${unknown} 格读面证明不了故照跑）`
  return { kind: "cells", cells, why }
}

/**
 * 纯函数：把一批格并进已选集合，**只增不减**，按 base 原序 + add 中未出现者顺序。
 *
 * 与 `--only`（「点名只跑这些」）的分界：这里是「本档照跑，另外把跟这次改动有关的也带上」。
 * 两条语义混一起会让人看不出这一轮到底跑了什么。
 */
export function unionById(base, add) {
  const seen = new Set(base.map((g) => g.id))
  return [...base, ...add.filter((g) => !seen.has(g.id))]
}

/**
 * 把 `--only` 的多个 token 解析成格集合（ISS-817）。
 *
 * 每个 token 独立解析：**精确 id 优先，否则前缀**。前缀命中多格是**有意的**
 * （`--only ci-typecheck-` 就是「全部 typecheck 格」），故不判「多于 1 格」。
 * ⚠️ 任一 token 一个都没命中 ⇒ 返回 `missing`，由调用方判用法错：
 *    静默丢掉一个 token = 点了名却没跑，那是本仓反复踩的那类静默错。
 *
 * @returns {{picked: Array<object>, missing: string[]}}
 */
export function resolveOnlyTokens(all, tokens) {
  const picked = new Map()
  const missing = []
  for (const tok of tokens) {
    const exact = all.filter((g) => g.id === tok)
    const hit = exact.length ? exact : all.filter((g) => g.id.startsWith(tok))
    if (!hit.length) missing.push(tok)
    for (const g of hit) picked.set(g.id, g)
  }
  return { picked: [...picked.values()], missing }
}

/**
 * 工厂：把调用方（run-gates.mjs）的几个局部实现一次性注入，返回本模块的能力。
 *
 * 为什么用工厂而不是让本文件 import run-gates：那会成环（run-gates 已经 import 本文件）。
 * 也**不复制**这些函数进来 —— 复制即两处真相源，改一处另一处悄悄腐坏。
 *
 * @param {object} deps
 *   `repo` / `spawnSync` / `path` / `fs` / `maxBuffer` —— 取改动面要用的运行时面
 *   `baseSha()` —— 分支起点；取不到返回 ""，本模块据此报「判不了」，不猜起点
 *   `buildRegistry()` / `attachDeclaredReads()` / `narrowSelection()` / `topLevelAreas()` —— 判据本体
 */
export function makeCiRouting(deps) {
  const { repo, spawnSync, path, fs, maxBuffer, baseSha, buildRegistry, attachDeclaredReads, narrowSelection, topLevelAreas } = deps

  /**
   * 算逐包格名单。取不到起点 / change-scope 报错 ⇒ `kind:"all"` 并出声，绝不静默少跑。
   *
   * @param {{since?:string, scripts?:string[]}} o
   *   `scripts` 限定只看哪一类逐包格（默认两类都看）。pre-push 传 `["typecheck"]`：
   *   实测（本机）typecheck 侧 23 格读面**全部可证明** ⇒ 改一包只跑 4 格、**4.9s**；
   *   而 test 侧 23 格里只有 5 格能证明、18 格恒跑 ⇒ 改一包要跑 22~25 格、**+84s**。
   *   push 上只带 typecheck，「改 A 的 test 没跑」由 `ws.sh guard` 的收工全量兜底。
   */
  function resolveCiPlan({ since, scripts = ["typecheck", "test"] } = {}) {
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "change-scope.mjs")
    if (!fs.existsSync(script)) return { kind: "all", why: `找不到 ${script}` }
    const base = (since || "").trim() || baseSha()
    if (!base) return { kind: "all", why: "取不到对照起点（没有 --changed-since，且 merge-base 算不出来）" }
    const r = spawnSync(process.execPath, [script, "--base", base], { cwd: repo, encoding: "utf8", timeout: 60_000, maxBuffer })
    let j = null
    try {
      j = JSON.parse(r.stdout ?? "")
    } catch {
      return { kind: "all", why: `change-scope 没给出可解析的 JSON（退出码 ${r.status}）` }
    }
    if (j.error) return { kind: "all", why: `change-scope 报 ${j.error.kind}：${j.error.message}` }
    if (r.status !== 0) return { kind: "all", why: `change-scope 退出码 ${r.status}` }
    // 名单只能在**当前树**上算（读面靠 AST 静态解析各包源码），算完原样下发给两棵树。
    const { all } = buildRegistry()
    const want = new RegExp(`^ci-(${scripts.join("|")})-`)
    const gates = all.filter((g) => want.test(g.id))
    if (!gates.length) return { kind: "all", why: `登记表里没有 ${scripts.join("/")} 逐包格（ci-* 派生失败？）` }
    attachDeclaredReads(gates)
    return { ...planCiCells(j.summary, { gates, allCells: gates.length, narrow: narrowSelection, topLevelAreas }), base: j.mergeBase ?? base, packages: j.summary?.packages ?? [] }
  }

  return { planCiCells: (scope, ctx) => planCiCells(scope, { narrow: narrowSelection, topLevelAreas, ...ctx }), resolveCiPlan }
}

/**
 * 解析 `--include-cells`（ISS-817）：在**本档原有格之上**并进点名的一批。
 *
 * 与 `--only`（只跑这些）不同，这里是**并集**：本档原有的格一格不少。
 * 专为 `--diff-baseline --with-ci` 的内部调用存在：两层进程必须拿到**逐 id 相同**的格集合
 * （`assertSameBatch` 的硬前提），故名单由父进程算好后原样下发，子进程不再自己算。
 * ⚠️ 认不出 id ⇒ 返回 `missing`，由调用方判用法错 —— 丢一个 id = 两棵树格集合不等 ⇒ 差分判不了。
 *
 * @returns {{selected: Array<object>, missing: string[]}}
 */
export function applyIncludeCells(selected, all, specs) {
  const ids = specs.flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean)
  if (!ids.length) return { selected, missing: [] }
  const byId = new Map(all.map((g) => [g.id, g]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) return { selected, missing }
  return { selected: unionById(selected, ids.map((id) => byId.get(id))), missing: [] }
}

/**
 * `--with-ci`（直接跑，不经 --diff-baseline）要并进来的格：46 个逐包格**全部**。
 * 给 `ws.sh guard` 用 —— 收工体检要的是「今天到底有没有坏」，不该被某一单的 diff 决定跑不跑。
 */
export const allCiCellIds = (all, scripts = null) =>
  all.filter((g) => (scripts ? new RegExp(`^ci-(${scripts.join("|")})-`) : /^ci-(typecheck|test)-/).test(g.id)).map((g) => g.id)

/**
 * 本模块的自检（ISS-817）。用**合成格子**钉四条边界，不真跑 46 格。
 *
 * 为什么不留在 run-gates.mjs 的 selftest 里：那文件被 `verify-file-size` 棘轮盯着
 * （只许降不许升），把本单的判据与其断言放一起会顶穿记录值。判据在哪，断言就在哪 —— 更好读。
 *
 * @param {(name:string, got:unknown, want:unknown)=>void} eq 调用方的断言器（同一份口径，不新造）
 * @param {{narrow:Function, topLevelAreas:Function, repo:string}} deps
 */
export function selftestCiRouting(eq, { narrow, topLevelAreas, repo }) {
  // command 必给：readSurfaceOf() 会 basename(gate.command)；缺了 selftest 自己先崩（实测撞过）。
  // bun 形状 = 走「入口不是 node」分支，与真实 ci-* 派生格同形。
  const mk = (id, declared) => ({ id, command: "bun", args: ["run", "x"], cwd: `${repo}/forge-x`, tiers: ["ci"], timeoutMs: 1000, ...(declared ? { readsDeclared: declared } : {}) })
  const ciSynth = [mk("ci-typecheck-a", ["forge-a"]), mk("ci-test-a", ["forge-a"]), mk("ci-typecheck-b", ["forge-b"]), mk("ci-test-b", ["forge-b"]), mk("ci-test-blind")]
  const ctx = { gates: ciSynth, allCells: ciSynth.length, tops: new Set(["forge-a", "forge-b", "docs"]) }
  const planCi = (scope) => planCiCells(scope, { ...ctx, narrow, topLevelAreas })
  const onlyA = planCi({ total: 1, areas: ["forge-a"], packages: ["forge-a"] })
  eq("改 A ⇒ 跑 A 的两格 + 读面证明不了的那格（B 的两格跳掉）", onlyA.cells, ["ci-test-a", "ci-test-blind", "ci-typecheck-a"])
  eq("改 A ⇒ 读面证明不了的那格**仍然跑**（宁多跑，不静默少跑）", onlyA.cells.includes("ci-test-blind"), true)
  eq("改 A ⇒ 只读 B 的格确实被跳掉（收窄真的发生了）", onlyA.cells.includes("ci-test-b"), false)
  eq("空改动面 ⇒ 全跑（空集不等于没事要跑）", planCi({ total: 0, areas: [], packages: [] }).kind, "all")
  eq("改根文件 ⇒ 全跑（影响面按全仓算）", planCi({ total: 1, areas: ["(root)"], packages: [] }).kind, "all")
  eq("改 docs ⇒ 按读面算，不因「没命中包」就跳光", planCi({ total: 1, areas: ["docs"], packages: [] }).kind, "cells")
  // --include-cells 是并集：老格全留、重的去重、认不出的 id 报出来（不静默丢）
  const before = [{ id: "fast-1" }, { id: "ci-test-a" }]
  const merged = applyIncludeCells(before, [...before, { id: "ci-test-b" }], ["ci-test-a,ci-test-b"])
  eq("include-cells 是并集：老格全留、重的去重", merged.selected.map((g) => g.id), ["fast-1", "ci-test-a", "ci-test-b"])
  eq("include-cells 认不出的 id ⇒ 报 missing（不许静默丢）", applyIncludeCells(before, before, ["no-such"]).missing, ["no-such"])
  // --only 多 token：任一没命中必须报，不许静默丢（同开关写两遍是 opt() 的老毛病）
  eq("--only 多 token 取并集", resolveOnlyTokens(ciSynth, ["ci-test-a", "ci-typecheck-b"]).picked.map((g) => g.id), ["ci-test-a", "ci-typecheck-b"])
  eq("--only 有一个 token 没命中 ⇒ 报 missing", resolveOnlyTokens(ciSynth, ["ci-test-a", "nope"]).missing, ["nope"])
  // --only 与 --with-ci 同给必须报错：实测踩过「说只跑一格却跑了 23 格」的静默错
  const both = applyCiUnion({ selected: ciSynth.slice(0, 1), all: ciSynth, ciSel: "typecheck", includeSpecs: [], onlyGiven: true, say: () => {} })
  eq("--only 与 --with-ci 同给 ⇒ 报错（不许静默各跑一半）", Boolean(both.error), true)
  // 单给 --with-ci 是并集：原有格全留
  const unioned = applyCiUnion({ selected: [ciSynth[0]], all: ciSynth, ciSel: "typecheck", includeSpecs: [], onlyGiven: false, say: () => {} })
  eq("--with-ci 是并集：原有格留着，另加指定侧", unioned.selected.some((g) => g.id === "ci-typecheck-a") && unioned.selected.some((g) => g.id === "ci-typecheck-b"), true)

  // ── ISS-831 回归：`planDiffCiCells` 的返回形状**必须恒为数组** ────────────────
  // 原先未给 selection 时返回 `{ cellArg, count, note }`，其余分支返回裸数组；
  // 而调用方 `run-gates.mjs`（差分模式）是 `...cellArg` 直接展开 ⇒ 对象 ⇒
  // `TypeError: cellArg is not iterable`，整条 `--diff-baseline` 跑不到判据。
  // 触发条件窄（pre-push 默认传 --with-ci），但**手工跑 --diff-baseline 必崩** ——
  // 正是「验有没有新增红」那个最常用的动作。
  //
  // ⚠️ 这条用例的靶心是**形状**不是内容：数组本身可迭代、展开后为空。
  //    只断言 `toEqual([])` 不够 —— 若有人改回对象，`toEqual` 也可能被写成宽松比较放过，
  //    故连 `Array.isArray` 与真实 `[...]` 展开一起钉。
  {
    const plan = planDiffCiCells({ selection: null, since: "abc", routing: {}, all: [], say: () => {} })
    eq("ISS-831：不传 selection ⇒ 返回数组（不是对象）", Array.isArray(plan), true)
    let spread
    try {
      spread = [...plan]
    } catch (e) {
      spread = `展开抛错：${e?.message ?? e}`
    }
    eq("ISS-831：不传 selection ⇒ 能 `...` 展开且为空（调用方就是这么用的）", spread, [])
  }
  // 反面：给了 selection 但算出 0 格时，也必须是数组（原实现这里已经对，钉住别改坏）
  {
    const plan = planDiffCiCells({ selection: "typecheck", since: "abc", routing: { resolveCiPlan: () => ({ kind: "cells", cells: [], why: "合成：本次不跑" }) }, all: [], say: () => {} })
    eq("ISS-831 对照：给了 selection 且 0 格 ⇒ 仍是可展开的空数组", [Array.isArray(plan), [...plan]], [true, []])
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 两个「一调用就走完」的入口，给 run-gates.mjs 里的两处接线各留一行。
// 抽到这里是因为 run-gates.mjs 被 file-size 棘轮盯着（只许降不许升），
// 而这两段的判断（选哪侧脚本 / 全跑还是收窄 / 缺值怎么报）本来就是本模块的知识。
// ─────────────────────────────────────────────────────────────────────────────

/** `--with-ci` 的取值 → 要看哪几类逐包格。未给值/未知值都由调用方先判过。 */
const scriptsOfSel = (sel) => (sel === "all" ? ["typecheck", "test"] : [sel])

/**
 * 差分模式用：算出这次要下发给**两棵树**的格名单，并给出可直接拼进子进程参数的 `--include-cells`。
 *
 * ⚠️ 为什么由父进程算一次、再原样下发：`assertSameBatch` 要求两棵树的格集合**逐 id 相同**，
 * 子进程各自按「自己那棵树的改动面」算就会分叉 ⇒ 差分判不了（或被误判成「换尺子」）。
 *
 * @returns {string[]} 可直接 `...` 展开进子进程参数；空数组 = 本轮不带逐包格。
 *   ⚠️ 原先这一行返回 `{ cellArg, count, note }` 而下面返回裸数组 —— **一个函数两种形状**，
 *   调用方按数组展开，于是「不传 --with-ci」那条分支必抛 `cellArg is not iterable`（ISS-831）。
 *   全仓没有任何消费方读 `.cellArg/.count/.note`（唯一调用方就是 `...cellArg`），故收敛成数组无兼容负担。
 */
export function planDiffCiCells({ selection, since, routing, all, say }) {
  if (!selection) return []
  const scr = scriptsOfSel(selection)
  const plan = routing.resolveCiPlan({ since, scripts: scr })
  const cells = plan.kind === "cells" ? plan.cells : allCiCellIds(all, selection === "all" ? null : scr)
  if (selection) say(`▶ 逐包格：${cells.length ? `跑 ${cells.length} 格` : "本次不跑"}（${plan.why}）`)
  return cells.length ? ["--include-cells", cells.join(",")] : []
}

/**
 * 直接跑（不经差分）用：`--with-ci` 与 `--include-cells` 都是**并集** —— 本档原有格一格不少。
 *
 * @returns {{selected: Array<object>, missing: string[], ciSel: string|null, count: number}}
 *   `missing` 非空由调用方判用法错（丢一个 id = 静默少跑）。
 */
export function applyCiUnion({ selected, all, ciSel, includeSpecs, onlyGiven, say }) {
  // ⚠️ `--only`（点名只跑这些）与 `--with-ci`（另把这批也带上）是**相反**的意图，同给必错：
  //    实测踩过 —— `--only ci-typecheck-pm --with-ci typecheck` 跑了 23 格，
  //    屏幕上却写着「--only ci-typecheck-pm」。那是「说只跑一格却跑了全部」的静默错，必须挡。
  if (onlyGiven && ciSel) return { selected, error: `✗ --only 与 --with-ci 互斥：「只跑这些」与「另把这些也带上」方向相反，同给看不出该听哪条。` }
  const ids = ciSel ? allCiCellIds(all, ciSel === "all" ? null : [ciSel]) : []
  const r = applyIncludeCells(selected, all, ciSel ? [...includeSpecs, ...ids] : includeSpecs)
  // `error` 非空 ⇒ 调用方直接判用法错（丢一个 id = 静默少跑）。文案也放这里，省得两处各写一份。
  const error = r.missing.length ? `✗ --include-cells 里有不存在的格：${r.missing.join(" · ")}（登记表 ${all.length} 格）` : ""
  if (!error && ciSel) say(`（--with-ci=${ciSel}：并入 ${ids.length} 个逐包格）`)
  return { selected: r.selected, error }
}

/**
 * `--only` 的完整解析（ISS-817）：多 token → 格集合 + 人读的「没见过这一格」提示行。
 *
 * 抽出来是为了让 run-gates.mjs 只留一行接线（它被 file-size 棘轮盯着）；
 * 而「精确优先、否则前缀」「任一 token 没命中就整次判错」这两条判断本来就是本模块的。
 *
 * 前缀命中多格是**有意的**（`--only ci-typecheck-` = 全部 typecheck 格），故不判「多于 1 格」。
 * ⚠️ 任一 token 一个都没命中 ⇒ `missing` 非空，调用方**必须**判用法错：
 *    静默丢掉一个 token = 点了名却没跑。
 *
 * @returns {{gates: Array<object>|null, missing: string[], hints: string[], label: string}}
 *   `gates` 为 null 表示这次没给 `--only`。
 */
export function parseOnlySelection(all, tokens) {
  if (!tokens.length) return { gates: null, missing: [], hints: [], label: "", banner: "" }
  const { picked, missing } = resolveOnlyTokens(all, tokens)
  // 提示行只给没命中的那些：全部并列会把真答案淹掉（与既有口径一致）。
  const hints = missing.map((tok) => {
    const near = all.filter((g) => g.id.includes(tok) || g.label.includes(tok)).slice(0, 8)
    return near.map((g) => `   · ${g.id}  ${g.label}`).join("\n")
  })
  // `banner` 是「命中了哪几格」那行人读提示；`streamOutput` 让单跑看到全量输出
  // （否则「跑一格」等于又一层摘要）—— 两条都是本模块的判断，一次算完省得调用方再分支。
  const label = tokens.join(",")
  const banner = picked.length > 1 ? `（--only ${label} 命中 ${picked.length} 格：${picked.map((g) => g.id).join(" · ")}）` : ""
  for (const g of picked) g.streamOutput = true
  return { gates: picked, missing, hints, label, banner }
}

/**
 * 差分缓存的「格清单指纹」（ISS-817）。
 *
 * 为什么必须进缓存键：同一个 sha + 同一把尺子下，「跑了全部格」与「只跑 4 格」是**两份不同读数**。
 * 共用 key 会命中另一份 ⇒ 两棵树的格集合不等 ⇒ `judgeBatch` 放松成「顺带修好」——
 * 那正是本仓最不能出的那种静默假绿。
 */
export function cellsFingerprint(cellArg) {
  if (!cellArg?.length) return ""
  return `+${createHash("sha1").update(String(cellArg[1])).digest("hex").slice(0, 8)}`
}

/** `--only` 没命中时给人看的整段提示（ISS-817 抽出来：这段只排版，不含判断）。 */
export function formatOnlyMiss(sel, listHint) {
  return [
    `✗ --only ${sel.missing.join(" / ")}：没有这一格${sel.missing.length > 1 ? "（以上几个）" : ""}。相近的有：`,
    ...sel.hints.filter(Boolean),
    `   ${listHint}`,
  ].join("\n")
}
