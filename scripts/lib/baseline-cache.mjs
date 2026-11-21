/**
 * baseline-cache —— `--diff-baseline` 的基线树结果**跨 run 复用**（ISS-799 乙）
 *
 * ## 为什么缓存结果而不是缓存树
 *
 * 基线树由 `gate-base-tree.mjs` 的 `ensureBaseTree()` 建，进程退出时 `installExitHook()`
 * 就回收了（ISS-726 的教训：树只增不减，故特意做成「谁建谁登记、退出即回收」）。
 * 而基线树一轮实测 19.6 min（CI run 43172685951 时间戳：07:05:55 → 07:25:28），
 * 同一个 `base.sha` 永远是同一份代码 —— 每个 PR 都重算属于纯浪费。
 * 缓存**结果 JSON**（实测 12K/个）最省事，也不必动树的回收逻辑。
 *
 * ## ⚠️ 缓存 key 必须覆盖「结果依赖的全部输入」，漏一个就是用过期结果判红/判绿
 *
 * 基线树的结果取决于四样，少一样都不许命中：
 *   ① 基线 sha         —— 树里是什么代码
 *   ② 尺子版本         —— 跑它的 run-gates/scripts 用**当前树**的（run-gates 注释 :1832 明写
 *                         「基线树没有本文件 ⇒ 一律用当前这版的 run-gates」），换分支/改脚本就变
 *   ③ tier             —— 选哪些格
 *   ④ workers          —— 并发数影响超时判红（ISS-715 实测 w=2 与 w=10 结论不同）
 *
 * ## 两个实测踩过的坑（都是「假绿」，比慢更坏）
 *
 * 坑 ① `git rev-parse HEAD:scripts` **只认已提交的树**。
 *   本地改完尺子还没提交时它不变 ⇒ 命中旧结果 ⇒ 新尺子配旧读数 = 假绿。
 *   复现：改 `scripts/change-scope.mjs` 后缓存照旧命中（实测）。
 *   ⇒ 用 `git status --porcelain -- scripts` 探脏，脏文件**真算 hash** 掺进 key。
 *   只掺文件名不够（同文件改两遍同 key），掺长度也不够（改内容不改长度照样撞）。
 *
 * 坑 ② `rattle.slice(0, 8)` 会把 `d498d771-dirty-<hash>` 截成 `d498d771`，脏标记被切掉
 *   ⇒ 改了尺子还命中旧结果。这是「截断导致永远 hit」，比「拼接导致永远 miss」更隐蔽。
 *   ⇒ 整个 rattle 过一遍 sha1 再截，别对结构化串直接截断。
 *
 * ## 缓存只省时间，不改结论
 *
 * 读不到 / 读坏了 / 形状不对 ⇒ 一律当 miss 现算，**绝不因 miss 而判绿或判红**。
 * 写不进缓存（CI 只读等）⇒ 出声，不静默（静默会让人以为「下次就快了」，实际每次都全跑）。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

/**
 * 算「尺子版本」：已提交的 scripts 目录树 hash + 未提交文件的真 hash。
 * 返 "" 表示取不到（浅克隆 / 无 git）⇒ 调用方**不许缓存**，绝不拿来源不明的 key 去命中。
 */
export function rulerFingerprint(repo) {
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD:scripts"], { cwd: repo, encoding: "utf8" })
  const tree = head.status === 0 ? (head.stdout || "").trim() : ""
  if (!tree) return ""
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "scripts"], { cwd: repo, encoding: "utf8" })
  const lines = (dirty.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)
  if (!lines.length) return tree
  const stray = lines
    .map((l) => l.replace(/^\S+\s+/, ""))
    .map((rel) => {
      try {
        return `${rel}:${crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, rel))).digest("hex").slice(0, 10)}`
      } catch {
        return `${rel}:gone`
      }
    })
    .sort()
    .join("|")
  return `${tree}-dirty-${crypto.createHash("sha1").update(stray).digest("hex").slice(0, 10)}`
}

/**
 * 缓存文件路径。落 `results/` 子目录而不是 cacheRoot() 根：cacheRoot 里还有基线 **worktree**
 * （实测 61MB），Actions cache 若按目录整包缓存会把整棵树拖走，而 worktree 带绝对路径、
 * 跨 run 不可用。结果 JSON 只有 12K ⇒ 单独一个目录，ci.yml 才能精确只缓这一样。
 *
 * 返回 null 表示不缓存（拿不到尺子指纹 / 调用方显式禁用）。
 */
export function cachePathFor({ cacheRoot, sha, repo, tier, workers, enabled = true }) {
  if (!enabled) return null
  const rattle = rulerFingerprint(repo)
  if (!rattle) return null
  const key = crypto.createHash("sha1").update(rattle).digest("hex").slice(0, 12)
  return path.join(cacheRoot, "results", `results-${String(sha).slice(0, 8)}-${key}-${tier}-w${workers}.json`)
}

/** 读缓存。任何异常 / 形状不对一律返回 null（= miss，现算）。 */
export function readCache(file) {
  if (!file || !fs.existsSync(file)) return null
  try {
    const hit = JSON.parse(fs.readFileSync(file, "utf8"))
    // 只认「形状对得上」的：results 得是非空数组。残了就当 miss，绝不半信半疑地用。
    if (hit && Array.isArray(hit.results) && hit.results.length > 0) return hit
    return null
  } catch {
    return null
  }
}

/**
 * 写缓存。返回 { ok, 原因 }。
 * 写不进去**不算错**（CI 里可能只读），但调用方必须出声 ——
 * 静默写失败会让人以为「下次就快了」，而实际每次都全跑。
 */
export function writeCache(file, data) {
  if (!file) return { ok: false, 原因: "未启用缓存" }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data))
    return { ok: true }
  } catch (e) {
    return { ok: false, 原因: `${e.code ?? e.message}` }
  }
}

/**
 * 同批断言（ISS-799 · 任务书要求的硬保证）。
 *
 * 差分口径的全部意义是「两棵树拿同一把尺子量」。只要两边跑的**格集合**不同，
 * 少跑的那侧就会把「我没跑」读成「不红」⇒ 那批格在基线上红、当前树「不存在」
 * ⇒ 被算成「顺带修好」，凭空长出一批假修复（run-gates :1828 那条注释担心的正是这个）。
 *
 * 历来只有「别这么用」的注释在拦，没有任何机械保证。这里钉成硬断言。
 * 比的是 **id 集合**而不是格数：格数相同但 id 不同（换档/登记表动了）只比数量会漏。
 *
 * 返回 { ok: true } 或 { ok: false, 说明, onlyBase, onlyCur }。
 */
export function assertSameBatch(base, cur) {
  const baseIds = new Set(base.results.map((x) => x.id))
  const curIds = new Set(cur.results.map((x) => x.id))
  const onlyBase = [...baseIds].filter((id) => !curIds.has(id))
  const onlyCur = [...curIds].filter((id) => !baseIds.has(id))
  if (!onlyBase.length && !onlyCur.length) return { ok: true }
  return {
    ok: false,
    说明: `两棵树跑的不是同一批格（基线 ${baseIds.size} 格 / 当前 ${curIds.size} 格）⇒ 判不了，不换尺子`,
    onlyBase,
    onlyCur,
  }
}

const clipIds = (xs) => `${xs.slice(0, 10).join(" · ")}${xs.length > 10 ? ` …共 ${xs.length} 格` : ""}`

/** 把 assertSameBatch 的失败结果印成人能读的报错。分开两个方向，因为误读的后果不同。 */
export function formatBatchMismatch(r) {
  const out = ["", `✗ ${r.说明}`]
  if (r.onlyBase.length) out.push(`  只基线跑了（会被误读成「顺带修好」）：${clipIds(r.onlyBase)}`)
  if (r.onlyCur.length) out.push(`  只当前跑了（会被误读成「新增红」）：${clipIds(r.onlyCur)}`)
  out.push("  差分要求两边格集合逐 id 相同；不同就说明收窄/缓存只作用在了一侧。")
  return out.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// ISS-808：格集合**合法地**变了怎么办
//
// ## 问题
// assertSameBatch 是 fail closed 的，而「合法地改格集合」是真实工作（ISS-805 fast 94→99 格、
// ISS-806 fast 92→42 格，同一天两次）。原行为下这两类提交**永远推不上去**（pre-push 恒 exit 2），
// 只能靠 owner 批准 `--no-verify` 绕过 —— 那是把整道门禁关掉，比判错还坏。
//
// ## 判据（乙 · 默认）：格集合不同**且**决定格集合的文件确实改过 ⇒ 这叫换了尺子，不是算歪了
//
// ⚠️ 这份清单是**实测**出来的，不是按「谁看起来相关」列的。关键前提：`--diff-baseline` 跑基线树时
// 用的是**当前树**的 `run-gates.mjs`（`--repo` 只换 REPO，不换 runner —— 见 run-gates.mjs 的 `run()`），
// 于是只有 `path.join(REPO, …)` 读出来的东西会两棵树不同。据此逐个入口核过：
//
//   · scripts/gates/registry.json —— **按树**（`deriveRegistryGates()` 读 `path.join(REPO, …)`）。
//     实测：把基线树 registry 里一格移出 fast ⇒ 基线树跑 46 格（原 47）。必收。
//   · package.json + 各 workspace 的 package.json —— **按树**（`deriveCiPackageGates()`），只在 `ci` 档
//     成格。实测：删基线树 forge-pm 的 typecheck 脚本 ⇒ `ci-typecheck-pm` 消失。
//   · scripts/lib/gate-tables.mjs / inline-gates.mjs —— **不按树**：两者由当前树的 run-gates.mjs 静态
//     import，两棵树跑的是同一份。实测：往基线树的 gate-tables.mjs 注入一格假门禁，基线树那轮**看不见**它。
//     ⇒ 它们改动能改变格集合，但**两边同时改**，造不出「两棵树不一样」。收进依据 = 白送一条放松口子：只要
//     顺手碰一下这个文件，任何收窄/缓存算歪都能借它放行。故**不收**。
//
// 一条没动而格集合变了 ⇒ 只可能是收窄/缓存算歪了（正是 assertSameBatch 要拦的），照旧 fail closed。
//
// ⚠️ 诚实说明这条判据的**弱处**：它证明的是「这些文件在这次 diff 里动过」，不是「你看到的那 N 格
// 增删就是这几行造成的」。改了 registry 的 label 而没动 tiers，恰好另一处把格算歪，理论上能借它一次
// 放松。故它只许改变**判不判得下去**，不许改变**红绿口径** —— 见下方「逐 id 印增删 + 只判交集 +
// 假修复不算修好」三件套，那三件才是红绿口径本身的兜底。
//
// ## 判据（甲 · 显式）：`--expect-batch-change`
// 乙 的探测只看**已提交**的 diff（pre-push 时 HEAD 就是要推的东西，语义正好）。
// 提交前手工跑 `--diff-baseline` 改了 registry ⇒ 乙 看不见 ⇒ fail closed。要提前看数就显式声明。
// ─────────────────────────────────────────────────────────────────────────────

/** 无论哪个档都会影响格集合的文件（按树读的那一份）。 */
export const GATE_SET_SOURCES = ["scripts/gates/registry.json"]

/**
 * `ci` 档额外按树读的：`ci-*` 格由根 package.json 的 workspaces + 各 workspace 的 scripts 派生。
 * 其它档没有 `ci-*` 格 ⇒ 这两类文件改不动它们的格集合，故只对 ci 放进来（少一条放松口子）。
 */
export const GATE_SET_SOURCES_CI = ["package.json", ":(glob)**/package.json"]

/**
 * 这次 diff（`sha..tip`）动过哪几个「决定格集合」的文件。
 * 返 [] = 没动；返非空数组 = 动过；返 null = git 取不到（浅克隆/无 git）⇒ 调用方按「没动」处理（fail closed）。
 *
 * `tier` 决定要不要把 package.json 那组算进来（见 GATE_SET_SOURCES_CI）。
 * `tip` 默认 HEAD，且**不该**换成被推提交：`--diff-baseline` 拿 `run(REPO)` 量的是**当前工作树**
 * 的读数，基线就是 `sha`。拿 `sha..HEAD` 与它对齐，比的是同一对树；换成 push_oid 会变成
 * 「用 A 树的改动面解释 B 树的读数」，方向偏向多放松一次（最不该错的那边）。
 */
export function changedGateSetSources({ repo, sha, tip = "HEAD", tier = "" }) {
  if (!sha) return null
  const paths = tier === "ci" ? [...GATE_SET_SOURCES, ...GATE_SET_SOURCES_CI] : GATE_SET_SOURCES
  const r = spawnSync("git", ["diff", "--name-only", sha, tip, "--", ...paths], { cwd: repo, encoding: "utf8" })
  if (r.status !== 0) return null
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
}

/**
 * 差分该不该接着判下去（ISS-808）。`assertSameBatch` 一个字没改，只在它后面加一个**有条件的**出口。
 *
 * `moved` 由调用方给（`changedGateSetSources()` 的结果），这样本函数是纯的、自检不用碰真仓：
 *   数组含路径 = 尺子文件动过（合法）；`[]` = 一行没动（不放松）；`null` = git 取不到（不放松）。
 * 返 `{ ok, exit, relaxed }`：`exit` 非 0 就当场当退出码返回。
 * 放松时**一定**逐 id 印出增删（铁律：不许静默通过）。
 */
export function judgeBatch({ base, cur, expect = false, moved = null, say = console.error }) {
  const batch = assertSameBatch(base, cur)
  if (batch.ok) return { ok: true, exit: 0, relaxed: false }
  const why = expect ? "调用方显式声明了 --expect-batch-change" : moved?.length ? `本次动了决定格集合的文件：${moved.join(" · ")}` : null
  if (!why) {
    const hint =
      moved === null
        ? "取不到这次改动的文件清单（浅克隆 / 无 git）⇒ 证明不了尺子动过，不放松。要提前看数可加 --expect-batch-change。"
        : `这些文件在 基线..HEAD 之间一行没改 ⇒ 格集合本不该变，那就只可能是收窄/缓存算歪了。提交后再跑，或确信合法时加 --expect-batch-change。`
    say([formatBatchMismatch(batch), `  ${hint}`].join("\n"))
    return { ok: false, exit: 2, relaxed: false }
  }
  const baseRedIds = new Set(base.results.filter((x) => x.status === "failed" && !x.allowFailure).map((x) => x.id))
  const lostRed = batch.onlyBase.filter((id) => baseRedIds.has(id)).length
  say(
    [
      "",
      `⚠️ 两棵树跑的不是同一批格，但尺子确实换了 ⇒ 接着判 —— 依据：${why}`,
      // 不复用 batch.说明：那句话的结论是「判不了，不换尺子」，在放行分支里会自相矛盾（第 3 行实测撞见）。
      `  两棵树跑的格数：基线 ${base.results.length} / 当前 ${cur.results.length}`,
      ...(batch.onlyBase.length ? [`  只基线跑了（本轮无读数，且**不算**顺带修好；其中基线红 ${lostRed} 格）：${clipIds(batch.onlyBase)}`] : []),
      ...(batch.onlyCur.length ? [`  只当前跑了（新增格，照常判红）：${clipIds(batch.onlyCur)}`] : []),
      "  口径：存量红 = 两边都跑且都红；新增红 = 当前红而基线没红过（新格自然在内）。",
    ].join("\n"),
  )
  return { ok: true, exit: 0, relaxed: true, onlyBase: batch.onlyBase, onlyCur: batch.onlyCur }
}

/**
 * 红绿账（ISS-808 从 run-gates 搬来，为的是把「放松时也算对」变成能自检的一处）。
 *
 * · `fresh`  = 当前红 ∩ ¬基线红 —— **新格的红自然算在里面**（基线没跑过它，凭什么是存量）。
 * · `fixed`  = 基线红 ∩ ¬当前红 ∩ **当前树真跑过它**。最后那一项是关键：放松掉「两边同批」之后，
 *   基线红而当前根本没跑的格会被算成「顺带修好」—— 凭空长出一批假修复。同批时当前树必然跑过
 *   基线跑过的每一格，故这一项恒 true ⇒ 与改动前的口径逐字相同。
 */
export function tallyReds(base, cur) {
  const redOf = (r) => new Set(r.results.filter((x) => x.status === "failed" && !x.allowFailure).map((x) => x.id))
  const curIds = new Set(cur.results.map((x) => x.id))
  const baseRed = redOf(base)
  const curRed = redOf(cur)
  return {
    fresh: [...curRed].filter((id) => !baseRed.has(id)),
    preexisting: [...curRed].filter((id) => baseRed.has(id)),
    fixed: [...baseRed].filter((id) => !curRed.has(id) && curIds.has(id)),
  }
}

/**
 * 把 `tallyReds().fixed` 再拆成两笔（ISS-811 · F5 副产物）。
 *
 * 为什么要拆：`fixed` 的口径是「基线阻断红 ∩ 当前**不阻断**」，而屏幕上的文案写的是
 * 「顺带修好（基线红、**当前绿**）」并逐格打 `✓`。这两句话**不是一回事** ——
 * 一格从「阻断红」降成「allowFailure 红」时，它**仍然是红的**（判据照旧 failed，
 * 只是不进退出码）。把它印成「已变绿 + ✓」是本单最该防的那种误导：
 * 屏幕说修好了，用户去查还是红的。
 *
 * ⇒ 拆两笔，各说各的：
 *   · `green`   = 当前 `passed`，这才配叫「顺带修好」
 *   · `demoted` = 当前仍 `failed` 但已不阻断，只能说「已降为只报不红」
 */
export function splitFixed(base, cur) {
  const curById = new Map(cur.results.map((x) => [x.id, x]))
  const { fixed } = tallyReds(base, cur)
  const statusOf = (id) => curById.get(id)?.status
  const afOf = (id) => curById.get(id)?.allowFailure === true
  return {
    // 真变绿才配叫「顺带修好」
    green: fixed.filter((id) => statusOf(id) === "passed"),
    // ⚠️ 只有 `failed && allowFailure` 才叫「降为只报不红」。
    // 二次审查实测我上一版把 `unjudged` 和 `skipped` 也算进 demoted ——
    // 而 `skipped` 在 `exitCodeOf()` 里与 failed **同权（阻断态）**：
    // 把它印成「已降为只报不红」是反向误导，比原来那句「已修好」更坏
    // （原来至少方向是「变好了」，这个是「变差了还说不阻断」）。
    demoted: fixed.filter((id) => statusOf(id) === "failed" && afOf(id)),
    // 从「阻断红」变成「判不了 / 跳过」= 既没修好也没降级，是**第三种**事：
    // 判据不再给结论 or 干脆没跑。单独一笔，不许混进上面任何一格。
    regressed: fixed.filter((id) => statusOf(id) !== "passed" && !(statusOf(id) === "failed" && afOf(id))),
  }
}

/**
 * `judgeBatch` / `tallyReds` 的自检向量（`run-gates --selftest` 逐条喂给它自己的 eq）。
 * 返 `[[名字, 实得, 应为], …]`。纯函数、不碰仓、不 spawn —— 毫秒级。
 */
export function selftestBatch() {
  const mk = (rows) => ({ counts: { passed: 0, failed: 0, skipped: 0, unjudged: 0 }, results: rows.map(([id, status, allowFailure]) => ({ id, status, allowFailure: Boolean(allowFailure) })) })
  const same = { base: mk([["a", "passed"], ["b", "failed"]]), cur: mk([["a", "passed"], ["b", "failed"]]) }
  // 尺子动了：当前树少了 b（基线红）、多了 c（当前红）
  const moved = { base: mk([["a", "passed"], ["b", "failed"]]), cur: mk([["a", "passed"], ["c", "failed"]]) }
  const run = (o) => {
    const out = []
    const r = judgeBatch({ ...o, say: (s) => out.push(s) })
    return { r, text: out.join("\n") }
  }
  const v = []
  // ① 同批：一个字都不许变（relaxed=false，等于原来那条 return { ok: true }）
  {
    const { r } = run({ base: same.base, cur: same.cur, moved: null })
    v.push(["①-1 两边同批 ⇒ 放行且未放松", [r.ok, r.relaxed], [true, false]])
  }
  // ② 尺子文件动过 ⇒ 接着判，且**逐 id 印出增删**（铁律二：不许静默通过）
  {
    const { r, text } = run({ base: moved.base, cur: moved.cur, moved: ["scripts/gates/registry.json"] })
    v.push(["②-1 格集合变了 + 尺子文件动过 ⇒ 放行且标记放松", [r.ok, r.relaxed, r.exit], [true, true, 0]])
    v.push(["②-2 放松时印出了只在基线跑的格 id", text.includes("b"), true])
    v.push(["②-3 放松时印出了只在当前跑的格 id", text.includes("c"), true])
    v.push(["②-4 放松时点名了依据文件", text.includes("registry.json"), true])
    v.push(["②-5 放松时交代了「只基线跑了」几格是红的", text.includes("其中基线红 1 格"), true])
    // 第 3 行实测撞见：放行分支里印了 fail-closed 那句「判不了，不换尺子」，与「接着判」自相矛盾。
    v.push(["②-6 放松时不许印「判不了」这类自相矛盾的话", !text.includes("判不了"), true])
  }
  // ③ 反证：格集合变了但尺子文件**一行没改** ⇒ 照旧 fail closed（这是本单最不能退的一格）
  {
    const { r, text } = run({ base: moved.base, cur: moved.cur, moved: [] })
    v.push(["③-1 格集合变了 + 尺子文件没动 ⇒ 拦住（exit 2）", [r.ok, r.exit], [false, 2]])
    v.push(["③-2 拦住时说明了「一行没改」", text.includes("一行没改"), true])
  }
  // ③b 反证：git 取不到改动面 ⇒ 同样不许放松（fail closed，绝不因取不到而放行）
  {
    const { r } = run({ base: moved.base, cur: moved.cur, moved: null })
    v.push(["③b-1 取不到改动面 ⇒ 拦住（exit 2）", [r.ok, r.exit], [false, 2]])
  }
  // ④ 甲：显式 --expect-batch-change 时，尺子文件没动也放行（且照样印增删）
  {
    const { r, text } = run({ base: moved.base, cur: moved.cur, moved: [], expect: true })
    v.push(["④-1 显式声明 ⇒ 放行", [r.ok, r.relaxed], [true, true]])
    v.push(["④-2 显式声明时也印了增删", text.includes("b") && text.includes("c"), true])
  }
  // ⑤ 红绿账：新格的红必须算新增；只在基线跑的格不许被算成「顺带修好」
  {
    const t = tallyReds(moved.base, moved.cur)
    v.push(["⑤-1 新增格上的红 ⇒ 算本次新增红", t.fresh, ["c"]])
    v.push(["⑤-2 只在基线跑的格 ⇒ 不算顺带修好（假修复）", t.fixed, []])
    const t2 = tallyReds(moved.base, mk([["a", "passed"], ["b", "passed"], ["c", "failed"]]))
    v.push(["⑤-3 真修好了 ⇒ 仍算顺带修好", t2.fixed, ["b"]])
  }
  // ⑤b ISS-811（F5）：`tallyReds` 原先**零覆盖** allowFailure —— 删掉判据里那个 `!x.allowFailure`
  // 整份 selftest 一条不红，正是 F1（JSON 丢字段 ⇒ pre-push 上豁免全失效）能活下来的插座。
  //
  // 向量设计：用**同一格**做对照，只改 allowFailure 一个变量。
  //   base 里 b 是**阻断红**（allowFailure 缺省），cur 里 b 仍红但 `allowFailure: true`
  //   ⇒ 它既不是「本次新增红」（本单没弄坏它），也不能算「顺带修好」（它没变绿）。
  // ⚠️ 这条向量必须能抓住 F1 那个形态：若 `results` 行里根本没有 allowFailure 键，
  //    传进来就是 `undefined` ⇒ `!undefined === true` ⇒ b 落进 fresh ⇒ 期望值当场不符。
  {
    const base = mk([["a", "passed"], ["b", "failed"]])
    const cur = mk([["a", "passed"], ["b", "failed", true]])
    const t = tallyReds(base, cur)
    v.push(["⑤b-1 当前树标了 allowFailure 的红 ⇒ 不算本次新增红（F1 的插座）", t.fresh, []])
    // 反面：没标 allowFailure 的同一个红格必须照旧算新增 —— 否则上面两条可以靠「永远不报」通过
    const tNoFlag = tallyReds(mk([["a", "passed"]]), mk([["a", "passed"], ["b", "failed"]]))
    v.push(["⑤b-3 反向对照：未标的红格仍算本次新增红", tNoFlag.fresh, ["b"]])
    // 回归向量：把 F1 修复前的 JSON 形状原样喂进来（`results` 行里**没有** allowFailure 键）。
    // base 里没有 b ⇒ b 是这一轮新出现的红，正是 pre-push 上「新增红」的口径。
    // 键缺失 ⇒ `!undefined` ⇒ b 落进 fresh ⇒ 与「标了 allowFailure 就不算新增」相反。
    const freshBase = mk([["a", "passed"]])
    const stripped = { counts: cur.counts, results: [["a", "passed"], ["b", "failed"]].map(([id, status]) => ({ id, status })) }
    v.push(["⑤b-4 回归：行里丢了 allowFailure 键 ⇒ 重复 F1 的症状（红被算新增）", tallyReds(freshBase, stripped).fresh, ["b"]])
    // 同一条向量换成**带** allowFailure 的行 ⇒ 必须不再是新增红。两条并排才证明是该字段在起作用。
    v.push(["⑤b-5 对照：同一份数据带上 allowFailure:true ⇒ 不算新增红", tallyReds(freshBase, mk([["a", "passed"], ["b", "failed", true]])).fresh, []])
    // ⑤b-2 的真身：从「阻断红」降成「只报不红」并不是变绿。
    // 它不落 fresh（⑤b-1 已判），但 `fixed` 的屏幕文案写的是「基线红、**当前绿**」+ ✓ —— 那是假话。
    const demoted = cur.results.find((x) => x.id === "b")
    v.push(["⑤b-2 降级格当前状态仍是 failed（不是绿）", demoted?.status, "failed"])
    v.push(["⑤b-6 降级格必须被单独归为「已不阻断」而不是「已变绿」", splitFixed(base, cur).demoted, ["b"]])
    v.push(["⑤b-7 真变绿的格仍归「顺带修好」", splitFixed(mk([["a", "passed"], ["b", "failed"]]), mk([["a", "passed"], ["b", "passed"]])).green, ["b"]])
    // ⑤b-8（二次审查必修4）：三种「从阻断红出走」的迁移必须分得开。
    // `skipped` 在 exitCodeOf 里与 failed **同权**，把它印成「已降为只报不红」是反向误导。
    {
      const from = mk([["a", "passed"], ["x", "failed"], ["y", "failed"], ["z", "failed"]])
      const to = mk([["a", "passed"], ["x", "failed", true], ["y", "unjudged"], ["z", "skipped"]])
      const r = splitFixed(from, to)
      v.push(["⑤b-8 只有 failed+allowFailure 才算「降为只报不红」", r.demoted, ["x"]])
      v.push(["⑤b-9 判不了 / 跳过 不许混进 demoted（skipped 是阻断态）", r.demoted.includes("y") || r.demoted.includes("z"), false])
      v.push(["⑤b-10 failed⇒unjudged / failed⇒skipped 归到 regressed 单列", r.regressed, ["y", "z"]])
      v.push(["⑤b-11 这三种都不许被算成 green", r.green, []])
    }
  }
  // ⑥ 依据文件清单本身：只许收「两棵树会读到不同版本」的，多收一个 = 白送一条放松口子。
  // gate-tables / inline-gates 由当前树静态 import（两棵树同一份，实测注入看不见）⇒ 不许收。
  {
    const ci = [...GATE_SET_SOURCES, ...GATE_SET_SOURCES_CI]
    const noStaticSrc = (xs) => xs.every((p) => !/gate-tables|inline-gates/.test(p))
    v.push(["⑥-1 常档依据 = 只有 registry.json", GATE_SET_SOURCES, ["scripts/gates/registry.json"]])
    v.push(["⑥-2 两棵树的静态源（gate-tables/inline-gates）不在依据里", noStaticSrc(ci), true])
    v.push(["⑥-3 ci 档才把 package.json 算进依据", ci.length > GATE_SET_SOURCES.length, true])
  }
  return v
}
