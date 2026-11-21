// registry → 调度器格的派生通道（ISS-740 起、ISS-811 抽线）
//
// 抽出的理由与 ISS-772/ISS-774/ISS-775 那三次一致：这一段是**纯数据搬运**（登记表条目
// → 调度器认的格对象），与调度逻辑零耦合，却占了 run-gates.mjs 的篇幅 —— 而那个文件有
// `verify-file-size.ts` 的「只许降不许升」棘轮。ISS-811 要加 allowFailure 通道，
// 历史五次处理这种情形都是**抽出去腾空间**，没有一次是靠调高 ceiling 过的。
//
// ⚠️ 「搬走」不等于「可以不验」：`--selftest` 拿合成条目走的是**本文件这几个函数本体**，
//    不是副本 —— 验副本就是验自己（ISS-811 的 selftest 段已按这个口径写）。
import fs from "node:fs"
import path from "node:path"
import { measuredKey, timeoutFor } from "./run-gates-timeout.mjs"

/**
 * 档位映射：registry 的 `pre-commit` / `scheduled` **不进** fast/full/ci 三档
 * （前者由 lefthook 跑，后者是定时档），其余一一对应。
 */
export const REGISTRY_TIER_MAP = { "pre-commit": [], fast: ["fast"], full: ["full"], ci: ["ci"], scheduled: [], next: ["next"], doc: ["doc"], "doc-sync": ["doc-sync"], coverage: ["coverage"] }

/** 「来自 registry 的 legacy 格」标记（ISS-755 后 guard 已退役，本标记只剩历史含义）。`derived` 靠它取格。 */
export const LEGACY_SOURCE = "gates/registry.json（legacy）"

/**
 * ISS-730：cell 声明的基线文件在不在。
 *
 * guard 的 `livecheck()` 有第 4 参（基线文件），基线缺席时它自己打「判不了」——
 * **那段控制流只在 guard 本体里**。ISS-755 把 103 格迁进 registry 后，cell 只有
 * `arg` 一个参数位，基线路径无处安放，于是这一档前置检查在迁移中丢了：
 *
 *   有基线 `--only no-new-tailwind` ⇒ failed；删掉基线 ⇒ **passed**（「没基线 = 更绿」）
 *
 * 修法选 **(a) 把基线带过去**，不让派生格回头调 guard 本体 —— 因为 ISS-800 的退役动作
 * 就是删掉 `guard-baselines.sh`，(b) 那条路在退役那一刻会立刻死。这里只补一个数据字段
 * + 一次存在性前置检查，判据的红绿口径仍逐条对齐 guard（rc=3 ⇒ unjudged，见 VERDICT）。
 *
 * ⚠️ 探针问法与判据必须是同一个问题：这里问「**这一个**基线文件在不在」，
 * 不是「`scripts/baseline/` 目录在不在」—— 后者对单文件缺席恒 true，正是本单的形态。
 *
 * 返回 null = 不适用（cell 没声明 baseline）；字符串 = 缺席原因。
 */
function missingBaselineOf(cell, repo) {
  const rel = typeof cell.baseline === "string" ? cell.baseline.trim() : ""
  if (!rel) return null
  if (fs.existsSync(path.join(repo, rel))) return null
  return rel
}

/** legacy 条目的一个 cell（格）→ 调度器的一格。`repo` = 仓根（本文件不假定调用方 cwd）。 */
export function legacyCellGate(entry, cell, repo) {
  const isShell = String(entry.script).endsWith(".sh")
  const arg = typeof cell.arg === "string" ? cell.arg : ""
  const missingBaseline = missingBaselineOf(cell, repo)
  return {
    id: cell.id,
    label: cell.label,
    // badge = guard 的 runner 名（check/selfcheck/livecheck/report_only）——
    // 覆盖对账的 guardRunsInFast() 认这个字段。
    badge: cell.runner,
    command: isShell ? "bash" : process.execPath,
    args: [path.join(repo, entry.script), ...(arg ? [arg] : [])],
    cwd: repo,
    // 档位显式写死，不由耗时推 —— 档位必须与 `--list` 逐字一致。
    tiers: cell.tiers,
    // ISS-821：语义标签与 tiers 同理写在**格上**（同一脚本的 --check 与 --selftest 红得不一样：
    // 前者是「契约破了」，后者是「判据没牙了」）。不搬 ⇒ registry 写了字段而 --list 读不到，
    // 那正是 ISS-811 的 needs/after 踩过的「甲方写了名字、乙方从来没读」。
    ...(Array.isArray(cell.semantics) && cell.semantics.length ? { semantics: cell.semantics } : {}),
    // 超时走折算：键 = 去扩展名的脚本名 + @参数，与 MEASURED 的字面形状一致。
    timeoutMs: timeoutFor(measuredKey(entry.script, arg)),
    // ⚠️ ISS-748 踩到的坑：`classifyOutcome()` 用 `gate.classify !== undefined` 分派。
    // 省略这个字段 ⇒ 退化成「rc≠0 一律红」，把 livecheck/check 的 exit 3（判不了）读成红。
    // ⇒ 必须显式给 false；`--classify` 的格（只有 migration-baseline）由 cell.classify 打开。
    classify: cell.classify === true,
    // ISS-832：格级「判不了」码集。登记表写 `unjudgedCodes: [3]` 的格 = 该脚本仍用 2 表违规，
    //   读侧只认 3 为判不了（不改脚本本体，避免与在途单冲突）。
    //   不写 ⇒ undefined ⇒ 读侧双认 {2,3}（canonical 2 + legacy 3）。
    ...(Array.isArray(cell.unjudgedCodes) && cell.unjudgedCodes.length ? { unjudgedCodes: cell.unjudgedCodes } : {}),
    source: LEGACY_SOURCE,
    // ISS-811：依赖边同上 —— 格级优先、条目级兜底（legacy 的 tiers 就在格上，边也照此）。
    ...(() => {
      const n = cell.needs ?? entry.needs
      const a = cell.after ?? entry.after
      return { ...(Array.isArray(n) && n.length ? { needs: n } : {}), ...(Array.isArray(a) && a.length ? { after: a } : {}) }
    })(),
    // ISS-811：只报不红（格级）。老板 2026-11-13 裁决「过程记录类文档不进审查、不走门禁」
    // ⇒ 降强度而不是移出屏幕：红照出，但不进 exitCodeOf 的阻断口径。
    // ⚠️ 必须**同时**带 why —— 少了它 `--selftest` 的「allowFailure 必须写理由」当场红。
    allowFailure: cell.allowFailure === true,
    ...(cell.allowFailure === true ? { allowFailureWhy: cell.allowFailureWhy } : {}),
    // 不为 null 时 = 该格声明的基线文件缺席（见 missingBaselineOf）。runOne 据此直接给第三态。
    missingBaseline,
  }
}

/**
 * registry 的 `kind:"spec"` 条目 → 调度器的一格（纯函数，输入是**条目对象**不是文件）。
 * 单独成函数的理由（ISS-811）：`--selftest` 要拿合成条目走**同一条派生路径**去证明
 * 「allowFailure 真的被搬到格上」；若自检自己复制一份派生逻辑，它验的就是副本而不是实现。
 * 返回空数组 = 该条目不该产生格（没 tiers / 所有档位都不进快·全·CI 三档）。
 */
export function specEntryGate(e, repo) {
  if (!Array.isArray(e.tiers)) return []
  const tiers = [...new Set(e.tiers.flatMap((t) => REGISTRY_TIER_MAP[t] ?? []))]
  if (!tiers.length) return []
  return [
    {
      id: e.id,
      label: `[新载体] ${e.id}`,
      badge: "check",
      command: process.execPath,
      args: [path.join(repo, "scripts/gates", `${e.id}.ts`), "--check"],
      cwd: repo,
      tiers,
      timeoutMs: Number(e.timeoutMs) > 0 ? Number(e.timeoutMs) : 120_000,
      source: "gates/registry.json",
      // ISS-821：语义标签（spec 条目一格一个档集 ⇒ 语义也写在条目上）。
      ...(Array.isArray(e.semantics) && e.semantics.length ? { semantics: e.semantics } : {}),
      // ISS-811：`needs` / `after` 此前**从登记表到调度器格根本不搬**（既存缺陷，非本单引入：
      // main 的 deriveRegistryGates 同款）。后果是登记表里写了依赖边也永不生效，
      // 而 `--selftest` 那条「依赖都指得到」实测恒真 —— 甲方写了名字、乙方从来没读。
      // 这里补搬，断言才有牙。
      ...(Array.isArray(e.needs) && e.needs.length ? { needs: e.needs } : {}),
      ...(Array.isArray(e.after) && e.after.length ? { after: e.after } : {}),
      // ISS-811：只报不红走的是**已有机制**（`exitCodeOf()` 认 `gate.allowFailure !== true`），
      // 这里只负责把 registry 的字段搬到调度器格上 —— 搬半截（只搬 allowFailure 不搬 why）
      // 会被 `--selftest` 的「必须写理由」当场抓住，见 `allowFailureViolations()`。
      allowFailure: e.allowFailure === true,
      ...(e.allowFailure === true ? { allowFailureWhy: e.allowFailureWhy } : {}),
      // ⚠️ ISS-832：新载体**按退出码判**，不再只嗅输出文案。
      //   修前这里只有 `unjudgedWhen: (out) => /unjudged（/.test(out)` —— 那是个中文括号正则，
      //   于是「2 = 判不了」这条口径**只对打印得整整齐齐的 runGate 走通的路成立**：
      //   判据自身崩溃（`✗ <gate>: <err>` + exit 2，所有 .ts 判据 catch 分支都是这个形状）
      //   输出里没有那个括号 ⇒ 落进「非 0 = 红」⇒ 干净机器上「缺 typescript」被报成「判据被违反」。
      //   现在：`badge: "check"` + `classify: false` 让 `classifyOutcome()` 走 VERDICT.check，
      //   而 VERDICT.check 认 isUnjudged(rc)（canonical 2 + legacy 3）。
      //   文案正则**保留**作兜底：有脚本仍按旧约定「输出说判不了、码上却是 0」时，
      //   code !== 0 是前提，故两者不冲突，只在前者判不出时才生效。
      classify: false,
      unjudgedWhen: (out) => /unjudged（/.test(out),
    },
  ]
}

/**
 * 「allowFailure 必须写理由」的**登记表口径**（ISS-811）—— 直接看 registry 原始条目。
 *
 * 为什么不只靠派生后那条断言：派生路径会按 `status` / `tiers` / `kind` 过滤，
 * 一个「被过滤掉、屏幕上根本不出现」的条目永远不会进入 `buildRegistry()` 的 `all`，
 * 于是它写了 `allowFailure` 却没写理由也**永远不会被任何判据看到**。
 * 两端各判一次才是闭环：
 *   · 这里 = 登记表原文（含 legacy 的**格级**，因为那一层才是「格」）；
 *   · `buildRegistry()` 那条 = 派生后的格（顺手证明字段真被搬过去了）。
 *
 * 返回违规格 id（条目级用 `id`，格级用 `条目id/格id`）；空数组 = 合格。
 */
/**
 * 一条 `allowFailureWhy` 算不算「真写了理由」（ISS-811 · F3）。
 *
 * 原判据只查非空 —— 实测 `why="x"`、`why="TODO"` 都过，等于给了一条敷衍即可绕过的后门。
 * 豁免是**降低门禁强度**的动作，它的理由是唯一的可审计面，所以这里要求：
 *   · 去空白后 ≥ MIN_LEN 个字符（`x` / `todo` / `fix` 这类一个词过不去）
 *   · 且不含占位词（大小写不敏感，命中即判不合格）
 *
 * ⚠️ 这仍是**下限**不是质量判据：写得够长的敷衍话照样能过。
 *    「理由是否真的成立」没有机器判据，只能靠审查 —— 这条只负责把最明显的偷懒挡在门外，
 *    别把它当成「理由已被审过」。
 */
const WHY_MIN_LEN = 12
const WHY_PLACEHOLDERS = [/^\s*(todo|tbd|fixme|n\/?a|na|none|null|x|fix|later|占位|待补|待填|略)\s*[.。!！]*\s*$/i]

export function whyIsReal(text) {
  const t = String(text ?? "").trim()
  if (t.length < WHY_MIN_LEN) return false
  return !WHY_PLACEHOLDERS.some((re) => re.test(t))
}

export function allowFailureViolations(entries) {
  const out = []
  const bad = (o) => !whyIsReal(String(o?.allowFailureWhy ?? "").trim())
  // ⛔ `neverAllowFailure`（ISS-811 · F6）：老板明令不许降门槛的格。名单从代码挪到登记表，
  // 因为「哪一格不许免」是治理数据，不是实现细节 —— 写死在这里，加一格要改脚本、看 diff 的人才发现。
  // `neverAllowFailure` 的 why 走**与 allowFailure 同一个质量门槛**（二次审查必修2）。
  // 原先是 `!String(...).trim()` ⇒ "x" / "TODO" 都能过，而 allowFailureWhy 的 "TODO" 会被抓。
  // 方向反了：neverAllowFailure 是**更硬**的治理声明（老板明令不许降门槛），
  // 弱的那条有门槛、强的那条没有，说不通。
  // `inheritedNever` = 条目级带了 neverAllowFailure 时，**该条目下的格**也不许被标 allowFailure。
  // 二次审查必修5：原实现只把「条目对象」喂进来，legacy 分支 `continue` 前没看格级 ⇒
  // `legacy neverAllowFailure + 格 allowFailure` 报 []（漏）。老板给的三格恰好都是 spec，
  // 当前实例不触发，但语义上正是 F6 想封的那类缝。
  const forbidden = (o, where, inheritedNever) => {
    const never = o?.neverAllowFailure === true || inheritedNever === true
    if (!never) return
    if (o?.allowFailure === true) out.push(`${where}：标了 neverAllowFailure 却又写 allowFailure:true`)
    // why 只需在**声明 never 的那一层**合格：条目声明了就查条目，格自己声明才查格。
    if (o?.neverAllowFailure === true && !whyIsReal(o?.neverAllowFailureWhy)) out.push(`${where}：neverAllowFailure 的 why 不够/是占位词`)
  }
  for (const e of Array.isArray(entries) ? entries : []) {
    // ⚠️ ISS-811（F2）：legacy **条目级**写 allowFailure 一律判违规（不是「允许但兜底」）。
    // 实测事实：`legacyCellGate()` 只读 `cell.allowFailure`，条目级那个值**从不派生**
    // ⇒ 写了条目级 + 写了 why 的结果是「不报错、不生效、全程绿」—— 配置看着配了，行为没有。
    // 本函数原先的注释还写着「条目级也会派生到每一格」，与代码相反（已删）。
    //
    // 为什么不选 (a)「兜底读条目级」：那会把「配了不生效」变成「配了悄悄生效」，
    // 而豁免是**降低门禁强度**的动作 —— 它必须看得见、必须落在最小单位（格）上。
    //
    // ⚠️ 原先这里还有一条理由是**错的**，已删（二次审查指出，我照改）：
    //    写的是「兜底会让『同脚本 --check 免、--selftest 不免』表达不出来」——
    //    与代码相反。格级本来就是唯一承载位，(a) 只是「格级没写时回落读条目级」，
    //    两种做法都保得住这个分辨率。用一条不成立的理由去支撑一个正确结论，
    //    下一个人会照着它去否决更好的做法。结论 (b) 不变，理由只剩上面这一条。
    forbidden(e, String(e?.id))
    if (e?.kind === "legacy") {
      if (e.allowFailure === true) out.push(`${e.id}（legacy 条目级不许写 allowFailure，请写到 cells[i] 上）`)
      for (const c of Array.isArray(e.cells) ? e.cells : []) {
        // 必修5：条目级 never 要向下管住格（`{rel}` 形式点名，方便定位到具体那一格）
        forbidden(c, `${e.id}/${c.id}`, e.neverAllowFailure === true)
        if (c?.allowFailure !== true) continue
        // 格级理由只认格自己那条：条目级那个值从不派生，拿它兜底等于让理由也悄悄生效。
        if (bad(c)) out.push(`${e.id}/${c.id}`)
      }
      continue
    }
    if (e?.allowFailure === true && bad(e)) out.push(String(e.id))
  }
  return out
}

/** 从 registry.json 派生全部格。读不到 / 解析失败 ⇒ 空数组（调用方按「没格」处理）。 */
export function deriveRegistryGates(repo) {
  const file = path.join(repo, "scripts/gates/registry.json")
  if (!fs.existsSync(file)) return []
  let entries
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return []
  }
  // ⚠️ ISS-811（必修3）：登记表的 allowFailure 系列约束**在这里判**，不在 `--selftest` 里判。
  //
  // 为什么必须挂在这：`--selftest` 在本仓**零自动接线** —— pre-commit / pre-push / CI 都不调它。
  // 把 F2/F3/F6 的唯一下游押在它上面，等于「本单交付物不可达」：实测注入
  // `verify-spec` + `allowFailure: true`（F6 明令禁止的形态，且带合格 why）后，
  // `--tier fast` 照旧 43 绿 / 2 红、一格都不报、pre-push 直接放行。
  //
  // `deriveRegistryGates()` 是**所有档位都会经过**的地方（buildRegistry 的唯一 registry 入口），
  // 且这份 JSON 它已经读过了 ⇒ 成本是一次纯内存遍历。
  //
  // 判成「登记表坏了」而不是「某格判据红」：这是**配置面**的错，不是判据面的错。
  // 用 RegistryError 语义（登记表自身出错），与 `timeoutMs 缺失` 同一条口径 —— 起第一个
  // 子进程之前就该崩，而不是跑完全场再报一个红。
  const violations = allowFailureViolations(entries)
  if (violations.length) {
    const err = new Error(`[run-gates] registry.json 的 allowFailure 配置不合法（${violations.length} 条）：\n  · ${violations.join("\n  · ")}`)
    err.name = "RegistryError"
    err.kind = "gate-registry-allow-failure-invalid"
    throw err
  }
  return entries
    .filter((e) => e.status === "active")
    .flatMap((e) => {
      if (e.kind === "legacy") {
        const cells = Array.isArray(e.cells) ? e.cells : []
        return cells.map((cell) => legacyCellGate(e, cell, repo))
      }
      return specEntryGate(e, repo)
    })
}

/**
 * 本文件的自检向量（ISS-811）—— `run-gates --selftest` 逐条喂给它自己的 `eq`。
 *
 * 为什么住在 lib 而不是 run-gates.mjs：与 `baseline-cache.selftestBatch()` 同一个理由 ——
 * 向量是**被抽出去的这段实现**的规格，实现搬了规格就该跟着搬，否则两者迟早对不上。
 * 而且 run-gates.mjs 有 `verify-file-size` 的「只许降不许升」棘轮。
 *
 * ⚠️ 这些断言**只在有人手敲 `--selftest` 时执行** —— 仓里目前没有任何自动接线
 *    （pre-commit / pre-push / CI 都调它，见 ISS-811 note 的 F4 条）。
 *    别把「selftest 绿」当成「合入前已经验过」。
 *
 * @param repo 仓根（用于读盘上那份真 registry.json）
 * @param all  派生后的全部格（用于证明字段真被搬到了格上）
 */
export function selftestAllowFailure(repo, all) {
  const v = []
  const REAL_WHY = "本格判的是过程记录类归档，老板 2026-11-13 裁决降为只报不红"
  const raw = JSON.parse(fs.readFileSync(path.join(repo, "scripts/gates/registry.json"), "utf8"))

  // ── 登记表原文口径：派生后那条查不到「被过滤掉、不上屏」的条目 ──────────────────
  v.push(["allowFailure 必须写理由（登记表原文 · 含 legacy 格级）", allowFailureViolations(raw), []])
  v.push(["反证：无理由的 spec 条目被抓到", allowFailureViolations([{ id: "x", allowFailure: true }]), ["x"]])
  v.push([
    "反证：legacy 格级无理由被抓到（格 id 带条目前缀）",
    allowFailureViolations([{ id: "y", kind: "legacy", cells: [{ id: "y1", allowFailure: true }] }]),
    ["y/y1"],
  ])
  // 最关键的一条：`tiers: []` ⇒ 派生路径直接 return []，该条目永远不上屏、永远不进 `all`，
  // 正是「派生后那条断言」结构上抓不到的形态。
  v.push(["反证：被 tiers 过滤掉（不上屏）的条目仍被抓到", allowFailureViolations([{ id: "z", tiers: [], allowFailure: true }]), ["z"]])
  v.push([
    "反证的反面：带真理由就不报（spec / legacy 格级）",
    allowFailureViolations([
      { id: "ok1", allowFailure: true, allowFailureWhy: REAL_WHY },
      { id: "ok2", kind: "legacy", cells: [{ id: "c1", allowFailure: true, allowFailureWhy: REAL_WHY }] },
    ]),
    [],
  ])

  // ── F3：敷衍理由必须过不去（原先只判非空 ⇒ x / TODO 都能过）──────────────────
  v.push(["F3 反证：why 只有一个字母 x 不算写了理由", allowFailureViolations([{ id: "t1", allowFailure: true, allowFailureWhy: "x" }]), ["t1"]])
  v.push(["F3 反证：why 是 TODO 占位词不算写了理由", allowFailureViolations([{ id: "t2", allowFailure: true, allowFailureWhy: "TODO" }]), ["t2"]])
  v.push(["F3 反证：why 全是空白不算写", allowFailureViolations([{ id: "t3", allowFailure: true, allowFailureWhy: "   " }]), ["t3"]])
  v.push(["F3 反面：够长的真理由照常通过", allowFailureViolations([{ id: "t4", allowFailure: true, allowFailureWhy: REAL_WHY }]), []])

  // ── F2：legacy 条目级一律判违规（方案 b：配了就报错，不做静默兜底）────────────
  v.push([
    "F2 反证：legacy 条目级 allowFailure（即便写了 why）也判违规",
    allowFailureViolations([{ id: "b", kind: "legacy", allowFailure: true, allowFailureWhy: REAL_WHY, cells: [{ id: "c1" }] }]).length,
    1,
  ])
  // 行为断言（二次审查建议）：不只证明「报了个字符串」，要证明「配了确实不生效」这个**事实**本身。
  // 这样即使有人把允许违规的规则放宽，这条仍会抓住「条目级值被静默忽略」这个行为。
  {
    const derived = legacyCellGate(
      { script: "scripts/x.mjs", allowFailure: true, allowFailureWhy: REAL_WHY },
      { id: "c1", label: "l", arg: "", runner: "check", tiers: ["fast"] },
      repo,
    )
    v.push(["F2 行为：legacy 条目级 allowFailure **不派生**到格（这就是它必须报错的原因）", derived?.allowFailure, false])
    // 反面：写在格上就派生 —— 证明「不派生」是条目级的特性，不是整个机制坏了
    const onCell = legacyCellGate(
      { script: "scripts/x.mjs" },
      { id: "c1", label: "l", arg: "", runner: "check", tiers: ["fast"], allowFailure: true, allowFailureWhy: REAL_WHY },
      repo,
    )
    v.push(["F2 行为反面：写在格上就派生", onCell?.allowFailure, true])
  }
  v.push([
    "F2 反证：条目级 why 不给格兜底",
    allowFailureViolations([{ id: "b", kind: "legacy", allowFailureWhy: REAL_WHY, cells: [{ id: "c1", allowFailure: true }] }]),
    ["b/c1"],
  ])

  // ── F6：neverAllowFailure（名单在登记表里，不在脚本里）────────────────────────
  v.push([
    "F6 反证：标了 neverAllowFailure 又想 allowFailure ⇒ 报",
    allowFailureViolations([{ id: "g", neverAllowFailure: true, neverAllowFailureWhy: REAL_WHY, allowFailure: true, allowFailureWhy: REAL_WHY }]).length > 0,
    true,
  ])
  v.push(["F6 反证：neverAllowFailure 不写 why ⇒ 报", allowFailureViolations([{ id: "g", neverAllowFailure: true }]), ["g：neverAllowFailure 的 why 不够/是占位词"]])
  v.push(["F6 反面：正常标 neverAllowFailure 不误报", allowFailureViolations([{ id: "g", neverAllowFailure: true, neverAllowFailureWhy: REAL_WHY }]), []])
  // 必修2：neverAllowFailureWhy 必须过 F3 同一门槛（"x" / "TODO" 不许过）
  v.push(["必修2 反证：neverAllowFailureWhy 太短（x）⇒ 报", allowFailureViolations([{ id: "g", neverAllowFailure: true, neverAllowFailureWhy: "x" }]).length, 1])
  v.push(["必修2 反证：neverAllowFailureWhy 是占位词（TODO）⇒ 报", allowFailureViolations([{ id: "g", neverAllowFailure: true, neverAllowFailureWhy: "TODO" }]).length, 1])
  // 必修5：legacy 条目级 never ⇒ 管住该条目下的格
  v.push([
    "必修5 反证：legacy 条目 never + 格 allowFailure ⇒ 报（原来漏）",
    allowFailureViolations([{ id: "L", kind: "legacy", neverAllowFailure: true, neverAllowFailureWhy: REAL_WHY, cells: [{ id: "c1", allowFailure: true, allowFailureWhy: REAL_WHY }] }]).length,
    1,
  ])
  v.push([
    "必修5 反面：legacy 条目 never + 格未标 allowFailure ⇒ 不报",
    allowFailureViolations([{ id: "L", kind: "legacy", neverAllowFailure: true, neverAllowFailureWhy: REAL_WHY, cells: [{ id: "c1" }] }]),
    [],
  ])

  // ── 派生端：字段真的被搬到格上了吗（登记表写了 ≠ 调度器格认识）─────────────────
  // 走实现本体，不自建副本 —— 验副本就是验自己。
  const spec = specEntryGate({ id: "s1", spec: "s1.spec.ts", tiers: ["fast"], allowFailure: true, allowFailureWhy: REAL_WHY }, repo)[0]
  v.push(["spec 派生格带上 allowFailure", spec?.allowFailure, true])
  v.push(["spec 派生格带上 allowFailureWhy", spec?.allowFailureWhy, REAL_WHY])
  const plain = specEntryGate({ id: "s2", spec: "s2.spec.ts", tiers: ["fast"] }, repo)[0]
  v.push(["spec 派生格省略时 allowFailure=false", plain?.allowFailure, false])
  v.push(["spec 派生格省略时不带 why 键", "allowFailureWhy" in plain, false])
  const cell = legacyCellGate({ script: "scripts/x.mjs" }, { id: "l1", label: "l", arg: "", runner: "check", tiers: ["fast"], allowFailure: true, allowFailureWhy: REAL_WHY }, repo)
  v.push(["legacy 派生格带上 allowFailure", cell?.allowFailure, true])
  v.push(["legacy 派生格带上 allowFailureWhy", cell?.allowFailureWhy, REAL_WHY])

  // ── 端到端：盘上那份 registry 的真格 ────────────────────────────────────────
  const mem = all.find((g) => g.id === "verify-memory-index")
  v.push(["盘上 verify-memory-index 派生出了 allowFailure 格", mem?.allowFailure === true && !!mem?.allowFailureWhy, true])

  // ── F6：不许标的格从登记表读，不写死在脚本里 ────────────────────────────────
  const forbiddenIds = raw.filter((e) => e.neverAllowFailure === true).map((e) => e.id)
  v.push(["登记表里 neverAllowFailure 的格一个都没标 allowFailure", all.filter((g) => forbiddenIds.includes(g.id) && g.allowFailure).map((g) => g.id), []])
  // K 规则卡体系 2026-11-21 整体删除（老板拍板「丙」）⇒ verify-rule-cards 已从 registry 下线，
  // 不再属于「老板明令永不许 allowFailure」的格子。剩下的两格仍逐条钉住。
  v.push(["老板明令的两格都在 neverAllowFailure 名单里", ["verify-spec", "verify-doc-budgets"].filter((id) => !forbiddenIds.includes(id)), []])
  return v
}
