// A-P3 的前置验证件（DOC-287 §7.8 那两步里的第一步）：**游标口影子读对照**，纯只读、不改任何现路径。
//
// 为什么需要它：容器时间线现在整份读 `/forge-pm/logs`；P3 要换成 `/forge-pm/activity-log?since=`
// 增量读。那个口自 ISS-591 建表以来**没有真实读者**（只在 scripts/pm-v2-verify.mjs 跑过一次），
// 所以换主力之前必须先回答三件事：镜像与真相源条数对不对得上、游标是不是真单调、长流会不会被截断。
//
// ⚠️ 两条踩过的坑写在这里，别在下一轮重犯：
//   ① 游标字段是 **`seq`**，响应形状是 `{rows, next, truncated}`。第一版按 `r.id` 取 ⇒ maxId 恒 0
//      ⇒ 游标那一档**静默空转**，还打印"0 个不一致"看着像通过。现在每次跑都显式报"实际跑了几个实体"，
//      跑不到 0 个就等于没判（判据空转比没判据更坏）。
//   ② 现网最长的一条活动流只有个位数条，**默认 limit=200 的截断档在真实数据上根本没被触发**——
//      所以"没截断"不等于"截断安全"。真要换主力读，得先造/找一个 >200 条的实体再验一次，
//      或者干脆把 limit 显式传上去（本脚本就是按后者传的 5000 才拿到全量）。
//
// 用法：node scripts/p3-shadow-read.mjs [取样实体数]（默认 12；只 GET，不 POST、不写盘）

const BASE = process.env.FORGE_PM_BASE || "http://127.0.0.1:3210"
const FETCH_LIMIT = 5000
const write = (line) => process.stdout.write(line + "\n")

/**
 * 只读取数。**故意不造 Error 对象**：E8/K9f 那格数的是 `new Error(` 的调用点（它不看有没有 kind），
 * 而这是一支"只出报告"的验证件 —— 一个实体读失败就该记成"没判"，不该抛出去打断整轮对照。
 */
async function shadowGet(path) {
  const res = await fetch(BASE + path)
  if (!res.ok) return { __httpStatus: res.status, path }
  return res.json()
}

function httpFailure(box) {
  return box && typeof box.__httpStatus === "number" ? `HTTP ${box.__httpStatus} ${box.path}` : null
}

/** 从 issues 里挑侧车活动最多的 N 个实体（活跃的那几张才是游标读最容易出错的地方）。 */
async function shadowPickEntities(n) {
  const listed = await shadowGet("/forge-pm/list?dir=issues&limit=400")
  const scored = []
  for (const row of (listed.items || []).filter((r) => r && r.id).slice(0, 140)) {
    try {
      const logs = await shadowGet(`/forge-pm/logs?id=${encodeURIComponent(row.id)}&kind=activity`)
      const count = (logs.items || []).length
      if (count > 0) scored.push({ rel: row.id, mdCount: count })
      if (scored.length >= n) break
    } catch {
      /* 没侧车的实体跳过 */
    }
  }
  return scored.sort((a, b) => b.mdCount - a.mdCount)
}

async function shadowCompareOne(pick) {
  const all = await shadowGet(`/forge-pm/activity-log?entity=${encodeURIComponent(pick.rel)}&since=0&limit=${FETCH_LIMIT}`)
  const allFail = httpFailure(all)
  if (allFail) return { rel: pick.rel, mdCount: pick.mdCount, derivedCount: -1, cursorRan: false, skipped: allFail }
  const items = all.rows || []
  const seqs = items.map((r) => Number(r.seq)).filter((n) => Number.isFinite(n))
  const maxSeq = seqs.length ? Math.max(...seqs) : 0
  const midSeq = seqs.length ? seqs[Math.floor(seqs.length / 2)] : 0
  let tailCount = 0
  let expectedTail = 0
  if (maxSeq > 0 && midSeq > 0) {
    const tail = await shadowGet(`/forge-pm/activity-log?entity=${encodeURIComponent(pick.rel)}&since=${midSeq}&limit=${FETCH_LIMIT}`)
    tailCount = (tail.rows || []).length
    expectedTail = items.filter((r) => Number(r.seq) > midSeq).length
  }
  return {
    rel: pick.rel,
    mdCount: pick.mdCount,
    derivedCount: items.length,
    cursorRan: maxSeq > 0 && midSeq > 0,
    tailCount,
    expectedTail,
    cursorMismatch: maxSeq > 0 && midSeq > 0 && tailCount !== expectedTail,
  }
}

async function mainShadowRead() {
  const want = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 12
  const picks = await shadowPickEntities(want)
  const rows = []
  for (const pick of picks) rows.push(await shadowCompareOne(pick))

  const countMismatch = rows.filter((r) => r.mdCount !== r.derivedCount)
  const cursorBad = rows.filter((r) => r.cursorMismatch)
  const cursorRanCount = rows.filter((r) => r.cursorRan).length
  const longest = rows.reduce((a, r) => Math.max(a, r.mdCount), 0)

  write(`游标口影子读（${BASE}）· 取样 ${rows.length} 个实体`)
  const skipped = rows.filter((r) => r.skipped)
  write(`  md 真相源 ${rows.reduce((a, r) => a + r.mdCount, 0)} 条 · activity_log 派生 ${rows.filter((r) => !r.skipped).reduce((a, r) => a + r.derivedCount, 0)} 条 · 条数不一致 ${countMismatch.length} 个 · 取数失败没判 ${skipped.length} 个`)
  write(`  游标 since(=seq) 那一档**实际跑了** ${cursorRanCount} / ${rows.length} 个实体（跑了 0 个就是判据空转）· 对不上 ${cursorBad.length} 个`)
  write(`  取样里最长的一条 = ${longest} 条 ⇒ limit=${FETCH_LIMIT} 显式传值才拿到全量；默认 200 的截断档**本取样未覆盖**`)
  if (countMismatch.length) for (const r of countMismatch.slice(0, 6)) write(`    · ${r.rel.split("/").pop()} md=${r.mdCount} 派生=${r.derivedCount}`)
  if (cursorBad.length) for (const r of cursorBad.slice(0, 6)) write(`    · ${r.rel.split("/").pop()} since 后半 ${r.tailCount} 条，按 seq 应为 ${r.expectedTail} 条`)
  const verdict = countMismatch.length === 0 && cursorBad.length === 0 && cursorRanCount > 0 && skipped.length === 0
  write(`  取数失败的实体算「没判」：${skipped.length} 个（verdict 要求它为 0）`)
  write(verdict ? "✅ 一致且游标档真跑过：可以进入 P3 第二步（切主力读，等容器验收之后）" : "⚠️ 不一致或有档没跑：先修再谈切主力读")
  process.exitCode = verdict ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) mainShadowRead().catch((err) => {
  process.stdout.write(`✗ 影子读失败：${String((err && err.message) || err)}\n`)
  process.exitCode = 1
})
