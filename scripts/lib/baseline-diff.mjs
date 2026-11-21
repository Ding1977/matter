/**
 * baseline-diff —— `--diff-baseline` 的**报告与退出码层**（ISS-828）
 *
 * ## 为什么要把这一层拆出来
 *
 * `--diff-baseline` 是 **pre-push 唯一走的路**（`.git/hooks/pre-push`），而 `--tier fast` 走的是
 * `main()` 里的另一条分支 —— **两条路径**。ISS-813/2116/2122 三次事故的共同形态：
 * 坏在 `diffBaseline()` 里，而 `--selftest` 一条都不红。这不是偶发，是**结构性盲区**：
 * 那几十行「两棵树的结果怎么合成一句话、退出码怎么定」原先**只存在于 console.log 里**，
 * 没有返回值 ⇒ 想测它只能起两棵真树。
 *
 * 红绿账本身（`tallyReds` / `splitFixed`）早已搬进 `lib/baseline-cache.mjs` 且有自检
 * （`selftestBatch` ⑤/⑤b 组）。**本文件不重算那笔账**，只把 `classifyDiff` 作为一处
 * 统一形状的入口委托过去 —— 判据仍只有一份，改口径只改一个地方。
 *
 * ## 拆的边界（这是本单最容易做错的地方）
 *
 *  ✅ 拆进本文件：算分类 · 组报告行 · 定退出码 · 空/坏输入挡住
 *  ❌ 留在 run-gates：`--baseline` 必须显式给（ISS-715 的强约束）、`rev-parse` 解析、
 *     起基线树、跑两棵树门禁 —— 那些是 **IO 与前置校验**，不在纯函数里。
 *     尤其「不给默认起点」那条：它是**参数合法性判据**，不是计算，搬进来会让纯函数
 *     开始关心「调用方用的是哪把尺子」，那正好是这个函数要解的毒。
 *
 * ## 失败口径（设计决定，不是随手 return）
 *
 * 输入缺失 / 形状不对 ⇒ **exit 2（判不了）**，不是 0 也不是 1。
 * 「判不了」必须与「没有新增红」区分开 —— 把判不了印成绿，就是 `--diff-baseline` 这个
 * 判据最早那几次假绿的形态。
 */

/**
 * 纯函数：把两棵树的原始结果合成一笔账。
 *
 * `base` / `cur` 的形状见 `run-gates.mjs --json` 的产物：
 *   `{ counts: { passed, failed }, results: [{ id, status, allowFailure, note }] }`
 *
 * 返 `{ ok, reason?, fresh, preexisting, fixedGreen, demoted, regressed, counts }`。
 * `ok: false` 时其余字段为空数组 —— 调用方**只许**据此给 exit 2。
 *
 * ⚠️ 为什么不在这里 import `tallyReds`/`splitFixed`：本文件要保持**零依赖**，
 *    才能被 selftest 与将来的 JSON 输入路径直接复用。口径由调用方（run-gates）注入，
 *    见 `reportDiff` 的 `ledger` 参数 —— 注入而不是复制，是为了不让第二份红绿账长出来。
 */
export function classifyDiff(base, cur, ledger) {
  const bad = (reason) => ({ ok: false, reason, fresh: [], preexisting: [], fixedGreen: [], demoted: [], regressed: [] })
  if (!base || !cur) return bad("两棵树里有一棵没跑出结果（null/undefined）")
  if (!Array.isArray(base.results) || !Array.isArray(cur.results)) return bad("结果里没有 results 数组（形状不对）")
  if (!base.results.length || !cur.results.length) return bad("有一棵树的结果是空的（0 格 ⇒ 判不了，不是没红）")
  const t = ledger.tallyReds(base, cur)
  const s = ledger.splitFixed(base, cur)
  return {
    ok: true,
    fresh: t.fresh,
    preexisting: t.preexisting,
    // 已降级 / 判不了 的那两笔**不许**混进 fixedGreen（ISS-811 的口径）：见 splitFixed 的注释。
    fixedGreen: s.green,
    demoted: s.demoted,
    regressed: s.regressed,
  }
}

const nonBlockingCount = (r) => r.results.filter((x) => x.status === "failed" && x.allowFailure).length
const statusOf = (r, id) => r.results.find((x) => x.id === id)?.status ?? "?"
const noteOf = (r, id) => r.results.find((x) => x.id === id)?.note ?? ""

/**
 * 纯函数：把分类笔数组装成**要印的行**与**退出码**。
 *
 * 返 `{ exit, lines }`。不碰 console、不 spawn、不读文件 —— 这是它能被自检钉住的前提。
 * 原先这一整块直接 `console.log`，于是「打印什么」与「怎么算」搅在一起，谁都测不了。
 *
 * `sha` 只用于抬头那几个字符；`短` 是 8，与 run-gates 现有输出一致。
 */
export function reportDiff({ base, cur, sha = "", ledger }) {
  const cls = classifyDiff(base, cur, ledger)
  if (!cls.ok) {
    return { exit: 2, lines: [`✗ 差分算不出来：${cls.reason} —— 判不了（**不是「没有新增红」**）`] }
  }
  const { fresh, preexisting, fixedGreen, demoted, regressed } = cls
  const lines = []
  lines.push("")
  lines.push(`基线 ${String(sha).slice(0, 8)}：${base.counts.passed} 绿 / ${base.counts.failed} 红（其中非阻断 ${nonBlockingCount(base)}）`)
  lines.push(`当前 HEAD  ：${cur.counts.passed} 绿 / ${cur.counts.failed} 红（其中非阻断 ${nonBlockingCount(cur)}）`)
  lines.push("")
  lines.push(`存量红（基线就红，本单不背）：${preexisting.length} 格`)
  for (const id of preexisting) lines.push(`  · ${id}`)
  lines.push(`本次新增红（本单必须交代）：${fresh.length} 格`)
  for (const id of fresh) lines.push(`  ✗ ${id}  ${noteOf(cur, id)}`)
  if (fixedGreen.length) {
    lines.push(`顺带修好（基线红、当前绿）：${fixedGreen.length} 格`)
    for (const id of fixedGreen) lines.push(`  ✓ ${id}`)
  }
  if (demoted.length) {
    lines.push(`已降为只报不红（基线阻断红、当前仍红但不阻断）：${demoted.length} 格`)
    for (const id of demoted) lines.push(`  · ${id}`)
  }
  // 第三种事：从「阻断红」变成「判不了 / 跳过」。既没修好也没降级 ——
  // `skipped` 还是阻断态，混进 demoted 就是反向误导（ISS-811 二次审查必修4）。
  if (regressed.length) {
    lines.push(`⚠️ 从阻断红变成不给结论（判不了 / 跳过，**不是修好也不是降级**）：${regressed.length} 格`)
    for (const id of regressed) lines.push(`  ⚠ ${id}  ⇒ ${statusOf(cur, id)}`)
  }
  lines.push("")
  lines.push(fresh.length ? `✗ 新增 ${fresh.length} 格红 —— 本单没过` : "✓ 没有新增红（存量红见上，不是本单引入）")
  return { exit: fresh.length ? 1 : 0, lines }
}

/**
 * 自检向量（由 `run-gates.mjs --selftest` 逐条喂 trace 自己的 eq）。
 * 返 `[[name, 实得, 应为], …]`。纯函数、不碰仓、不 spawn。
 *
 * ⚠️ 这批向量的靶心是 **pre-push 那条路**：分类算错（少报一格新增红）= 推送被放过，
 *    报错方向（把判不了印成绿）= 假绿。两类都在下面各钉了一遍。
 */
export function selftestDiff(ledger) {
  const mk = (rows) =>
    ({ counts: { passed: rows.filter(([, s]) => s === "passed").length, failed: rows.filter(([, s]) => s === "failed").length }, results: rows.map(([id, status, allowFailure, note]) => ({ id, status, allowFailure: Boolean(allowFailure), note })) })
  const v = []
  const rep = (b, c) => reportDiff({ base: b, cur: c, sha: "0123456789abcdef", ledger })

  // ① 同一组 3 红 ⇒ 新增 0，且三格全进「存量」
  {
    const b = mk([["g1", "passed"], ["g2", "failed"], ["g3", "failed"], ["g4", "failed"]])
    const r = rep(b, b)
    v.push(["①-1 基线/当前同一组红 ⇒ 新增红 0 格", r.lines.find((l) => l.startsWith("本次新增红")), "本次新增红（本单必须交代）：0 格"])
    v.push(["①-2 同一组红 ⇒ 存量红 3 格", r.lines.find((l) => l.startsWith("存量红")), "存量红（基线就红，本单不背）：3 格"])
    v.push(["①-3 没有新增红时退出码 0（不许因存量红判红）", r.exit, 0])
    v.push(["①-4 末行说「没有新增红」而不是沉默", r.lines.at(-1).startsWith("✓ 没有新增红"), true])
  }
  // ② 基线 2 红 / 当前 3 红（多一格）⇒ 新增 1 且**点名**
  {
    const b = mk([["g1", "failed"], ["g2", "failed"], ["g3", "passed"]])
    const c = mk([["g1", "failed"], ["g2", "failed"], ["g3", "failed", false, "这格是新坏的"]])
    const r = rep(b, c)
    v.push(["②-1 多红一格 ⇒ 新增红 1 格", r.lines.find((l) => l.startsWith("本次新增红")), "本次新增红（本单必须交代）：1 格"])
    v.push(["②-2 新增的那格被点名（不是只报数字）", r.lines.includes("  ✗ g3  这格是新坏的"), true])
    v.push(["②-3 新增红存在 ⇒ 退出码 1（pre-push 靠它拦）", r.exit, 1])
    v.push(["②-4 末行判「本单没过」", r.lines.at(-1), "✗ 新增 1 格红 —— 本单没过"])
  }
  // ③ 基线 3 红 / 当前 2 红（修好一格）⇒ 「修好 1 格」并点名
  {
    const b = mk([["g1", "failed"], ["g2", "failed"], ["g3", "failed"]])
    const c = mk([["g1", "failed"], ["g2", "failed"], ["g3", "passed"]])
    const r = rep(b, c)
    v.push(["③-1 少红一格 ⇒ 报「顺带修好」1 格", r.lines.find((l) => l.startsWith("顺带修好")), "顺带修好（基线红、当前绿）：1 格"])
    v.push(["③-2 修好的那格被点名", r.lines.includes("  ✓ g3"), true])
    v.push(["③-3 修好不减退出码（仍是 0，且不许为负）", r.exit, 0])
    // 反面：降级不是修好。同一格从阻断红变 allowFailure 红，屏幕**不许**打 ✓。
    const cDemoted = mk([["g1", "failed"], ["g2", "failed"], ["g3", "failed", true]])
    const rd = rep(b, cDemoted)
    v.push(["③-4 降级格不许被印成「顺带修好」", rd.lines.some((l) => l.startsWith("顺带修好")), false])
    v.push(["③-5 降级格单列在「已降为只报不红」", rd.lines.some((l) => l.startsWith("已降为只报不红")), true])
  }
  // ④ 格集合不同（当前 184 / 基线 183）⇒ 由 judgeBatch 拦，本层不许自己编「新增红」
  {
    const b = mk(Array.from({ length: 183 }, (_, i) => [`x${i}`, "passed"]))
    const c = mk(Array.from({ length: 184 }, (_, i) => [`x${i}`, "passed"]))
    const batch = ledger.judgeBatch({ base: b, cur: c, moved: [], say: () => {} })
    v.push(["④-1 格集合不等 + 尺子没动 ⇒ 由 judgeBatch 拦下（exit 2）", [batch.ok, batch.exit], [false, 2]])
    v.push(["④-2 拦下时用的是「同一批格」判据，不是「新增红」", batch.ok === false, true])
    // 本层**不负责**判格集合 —— 它拿到不同批的数据照样只算红绿账。这条钉住职责边界：
    // 若哪天有人把 batch 检查搬进 reportDiff，两边职责就重了，④-3 会当场变红。
    v.push(["④-3 reportDiff 自身不做格集合判定（职责在 judgeBatch）", Object.keys(rep(b, c)).sort(), ["exit", "lines"]])
  }
  // ⑤ 当前格数少于基线（有人删格）⇒ judgeBatch 拦住，且点名「只在基线跑」的那几格
  {
    const b = mk([["x1", "failed"], ["x2", "passed"], ["x3", "failed"]])
    const c = mk([["x1", "failed"]])
    const batch = ledger.judgeBatch({ base: b, cur: c, moved: [], say: () => {} })
    v.push(["⑤-1 有人删格 ⇒ 拦住（exit 2）", [batch.ok, batch.exit], [false, 2]])
    const out = []
    ledger.judgeBatch({ base: b, cur: c, moved: [], say: (s) => out.push(s) })
    v.push(["⑤-2 拦住时点名了只在基线跑的格", out.join("\n").includes("x2") && out.join("\n").includes("x3"), true])
    // 格数必须报出来 —— 只说「不是同一批」而不给两侧格数，读者无法判断是删格还是收窄算歪。
    v.push(["⑤-3 交代了两侧格数", out.join("\n").includes("基线 3 格 / 当前 1 格"), true])
  }
  // ⑥ 空输入 / null ⇒ 不崩，明确报「判不了」，退出码 2（**不许**是 0 或 1）
  {
    for (const [name, args] of [
      ["null 基线", [null, mk([["a", "passed"]])]],
      ["null 当前", [mk([["a", "passed"]]), null]],
      ["两边都 null", [null, null]],
      ["空 results", [mk([]), mk([["a", "passed"]])]],
      ["缺 results 键", [{ counts: { passed: 0, failed: 0 } }, mk([["a", "passed"]])]],
    ]) {
      let r
      try {
        r = rep(args[0], args[1])
      } catch (e) {
        v.push([`⑥ ${name}：不许抛异常`, `抛了 ${e?.message ?? e}`, "不抛"])
        continue
      }
      v.push([`⑥ ${name}：退出码 2（判不了 ≠ 没红）`, r.exit, 2])
      v.push([`⑥ ${name}：明说「判不了」并且与「没有新增红」区分开`, r.lines[0].includes("判不了") && r.lines[0].includes("不是「没有新增红」"), true])
    }
  }
  // ⑦ 注入口径真的被用上了（防「参数给了但忽略」这种假接线）
  {
    const b = mk([["g1", "passed"]])
    const c = mk([["g1", "failed"]])
    const fakeLedger = {
      tallyReds: () => ({ fresh: ["假的"], preexisting: [], fixed: [] }),
      splitFixed: () => ({ green: [], demoted: [], regressed: [] }),
    }
    const r = reportDiff({ base: b, cur: c, sha: "x", ledger: fakeLedger })
    v.push(["⑦-1 红绿账来自注入的 ledger，不是本文件另算一份", r.lines.includes("  ✗ 假的  "), true])
  }
  return v
}
