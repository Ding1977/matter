/**
 * `verify-exemption-register` 的 spec（ISS-814）。
 *
 * 四类用例，对应工单验收的三条变异 + 一条正例：
 *   ① 正例：`missing <= limit` ⇒ passed
 *   ② 新增一条无 expires 的豁免 ⇒ failed（且点名到文件与数字）
 *   ③ `grandfathered` 调高 1 ⇒ failed（只减不增）
 *   ④ `grandfathered` 调低 ⇒ passed + 提示「可下调」
 *
 * ⚠️ ④ 的口径（实测得出，不是猜的）：本仓 16 个文件全部 `missing == limit`，
 *   所以「只降数字、不还债」在 ② 的锚点下**不红**（`missing > limit` 不成立），
 *   在 ②的只减不增锚点下也不红（降不是升）⇒ 落在「可下调」提示上。这正是工单要的行为。
 *
 * 反向对照（说「绿」时必须给出「红会是什么样」）：③ 与 ④ 输入只差 `limits` 里一个数，
 * 一个红一个绿 —— 证明红线确实读的是那个数字，不是别的东西顺带红了。
 */
import { collectExemptions, judgeExemptionRegister, readBaselineKind, toDayNumber, GRACE_DAYS, MAX_YEARS_AHEAD, type Exemption } from "./verify-exemption-register.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const ex = (over: Exemption = {}): Exemption => ({ reason: "存量豁免", ...over })

export function run(): boolean {
  fails = 0
  console.log("verify-exemption-register.spec")

  const files = { "a.json": [ex(), ex({ why: "另一种理由字段" })] }
  const limits = { "a.json": 2 }

  {
    const r = judgeExemptionRegister({ files, limits, previousLimits: limits })
    ok("正例：missing(2) == limit(2) ⇒ passed", r.status === "passed")
    ok("正例：detail 报出口径（文件数 / 条数）", (r.detail ?? "").includes("1 个文件") && (r.detail ?? "").includes("2 条无 expires"))
  }

  {
    // 变异 a：新增一条只有 reason 没有 expires
    const r = judgeExemptionRegister({ files: { "a.json": [...files["a.json"], ex()] }, limits, previousLimits: limits })
    ok("变异a：新增无 expires 豁免 ⇒ failed", r.status === "failed")
    ok("变异a：点名到文件与三个数字", (r.findings ?? []).some((f) => f.detail.includes("a.json") && f.detail.includes("3 条") && f.detail.includes("上限 2")))
  }

  {
    // 变异 b：上限 +1（旧上限 2 → 新上限 3），missing 仍为 2
    const r = judgeExemptionRegister({ files, limits: { "a.json": 3 }, previousLimits: limits })
    ok("变异b：grandfathered +1 ⇒ failed（只减不增）", r.status === "failed")
    ok("变异b：点名叫「只许降不许升」并给出 2 → 3", (r.findings ?? []).some((f) => f.detail.includes("只许降不许升") && f.detail.includes("2 → 3")))
  }

  {
    // 变异 c：上限 -1（2 → 1），missing 仍为 2 ⇒ 数字降了但债没还
    const r = judgeExemptionRegister({ files, limits: { "a.json": 1 }, previousLimits: limits })
    ok("变异c：grandfathered -1 ⇒ 不因「只减不增」判红", r.status === "failed" && !(r.findings ?? []).some((f) => f.detail.includes("只许降不许升")))
  }

  {
    // 变异 c 的「已还债」形态：真还了一条（只留 1 条），同时降上限到 1 ⇒ passed + 可下调提示
    const r = judgeExemptionRegister({ files: { "a.json": [ex()] }, limits: { "a.json": 1 }, previousLimits: limits })
    ok("变异c：还债后降上限 ⇒ passed", r.status === "passed")
    ok("变异c：missing < limit 时给「可下调」提示", judgeExemptionRegister({ files: { "a.json": [ex()] }, limits, previousLimits: limits }).detail?.includes("可下调") === true)
  }

  {
    // 干扰：文件里有豁免但登记表完全没写它 ⇒ 上限按 0 处理（不因没登记就放行）
    const r = judgeExemptionRegister({ files: { "b.json": [ex()] }, limits: {}, previousLimits: {} })
    ok("干扰：未登记的文件有豁免 ⇒ failed（上限按 0）", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("b.json") && f.detail.includes("上限 0")))
  }

  {
    // 缺输入：读不到上一次提交 ⇒ 只减不增「未判」，可以说绿，但必须在 detail 里留痕
    const r = judgeExemptionRegister({ files, limits, previousLimits: null })
    ok("缺输入：previousLimits=null ⇒ 仍 passed", r.status === "passed")
    ok("缺输入：detail 明写「本条未判」（不静默）", (r.detail ?? "").includes("未判"))
  }

  {
    // 坏 JSON 只提示不判红（归别的判据）
    const r = judgeExemptionRegister({ files, limits, previousLimits: limits, unreadable: ["bad.json"] })
    ok("干扰：坏 JSON 只提示不判红", r.status === "passed" && (r.detail ?? "").includes("bad.json"))
  }

  {
    // collectExemptions：嵌套结构下钻（外层带 why、内层也有 ⇒ 两条都要收到，不许漏内层）
    const nested = { a: { why: "外层", b: [{ reason: "内层1" }, { reason: "内层2", expires: "2026-12-31" }] } }
    const got = collectExemptions(nested)
    ok("collectExemptions：嵌套下钻收全 3 条（外层带 why 也不掩盖内层）", got.length === 3)
    ok("collectExemptions：带 expires 的那条被识别为「不缺」", got.filter((x) => !x.expires).length === 2)
  }

  {
    // 反向对照：非对象/数组/原始值不得被当成豁免
    ok("collectExemptions：原始值不产生豁免", collectExemptions({ a: "reason", b: 1, c: null }).length === 0)
  }

  // ═══ 以下为 ISS-830：expires 到期判定 + ticket 占位符 ═══
  // 全部用显式 today，不依赖「今天恰好是几号」——否则这些用例明年自动变味。
  const TODAY = "2026-11-14"
  const day = (over: Exemption = {}): Exemption => ({ reason: "存量豁免", expires: "2026-12-31", ...over })
  // 一条有 expires 的豁免 + 上限 0（上限为 0 ⇒ ① 不红，变异只可能来自 ③/④）
  const dated = (x: Exemption[]) => ({ files: { "a.json": x }, limits: { "a.json": 0 }, previousLimits: { "a.json": 0 }, today: TODAY })

  {
    // ① 正常态：未过期 ⇒ 绿
    const r = judgeExemptionRegister(dated([day()]))
    ok("ISS-830①：expires 未过期（2026-12-31 / today=2026-11-14）⇒ passed", r.status === "passed")
    ok("ISS-830①：绿态也报出「判了几条」+ 最近到期", (r.detail ?? "").includes("1 条有 expires") && (r.detail ?? "").includes("最近到期 2026-12-31"))
  }

  {
    // ② 变异：改成昨天 ⇒ 红
    const r = judgeExemptionRegister(dated([day({ expires: "2026-11-13" })]))
    ok("ISS-830②：过期 1 天 ⇒ 在宽限期内，只提示不红", r.status === "passed" && (r.detail ?? "").includes("宽限"))
    const r2 = judgeExemptionRegister(dated([day({ expires: "2026-11-01" })]))
    ok("ISS-830②：过期 13 天（> 宽限 7）⇒ failed", r2.status === "failed")
    ok("ISS-830②：点名过期天数与 expires", (r2.findings ?? []).some((f) => f.detail.includes("已过期 13 天") && f.detail.includes("2026-11-01")))
  }

  {
    // ②b 宽限期边界：恰好在 GRACE_DAYS 内只提示、多 1 天就红（证明红线读的确实是那个数字）
    const inside = judgeExemptionRegister(dated([day({ expires: "2026-11-07" })])) // 过期 7 天
    ok(`ISS-830②b：过期恰 ${GRACE_DAYS} 天 ⇒ 仍 passed（不阻断）`, inside.status === "passed")
    const outside = judgeExemptionRegister(dated([day({ expires: "2026-11-06" })])) // 过期 8 天
    ok(`ISS-830②b：过期 ${GRACE_DAYS + 1} 天 ⇒ failed`, outside.status === "failed")
  }

  {
    // ③ 变异：2999-12-31 ⇒ 红（伪装永久）
    const r = judgeExemptionRegister(dated([day({ expires: "2999-12-31" })]))
    ok("ISS-830③：expires=2999-12-31 ⇒ failed（伪装永久）", r.status === "failed")
    ok("ISS-830③：点名叫「过于遥远」", (r.findings ?? []).some((f) => f.detail.includes("过于遥远")))
    // 边界：恰好 today 的年份 + MAX_YEARS_AHEAD ⇒ 不红
    const edge = judgeExemptionRegister(dated([day({ expires: `${2026 + MAX_YEARS_AHEAD}-12-31` })]))
    ok(`ISS-830③：expires = today年+${MAX_YEARS_AHEAD} ⇒ 不因「过于遥远」红`, !(edge.findings ?? []).some((f) => f.detail.includes("过于遥远")))
  }

  {
    // ④ 变异：ticket 写 "TODO" ⇒ 红
    const r = judgeExemptionRegister(dated([day({ ticket: "TODO" })]))
    ok("ISS-830④：ticket=TODO ⇒ failed", r.status === "failed")
    ok("ISS-830④：点名叫「占位符」", (r.findings ?? []).some((f) => f.detail.includes("占位符")))
    ok("ISS-830④：ticket=ISS-823 是真实单号 ⇒ 不红", judgeExemptionRegister(dated([day({ ticket: "ISS-823" })])).status === "passed")
    // 无 expires 的条目也要拦占位符（④ 不等 ③）
    const noExp = judgeExemptionRegister({ files: { "a.json": [{ reason: "x", ticket: "x" }] }, limits: { "a.json": 1 }, previousLimits: { "a.json": 1 }, today: TODAY })
    ok("ISS-830④：无 expires 的条目 ticket=x 也红", noExp.status === "failed" && (noExp.findings ?? []).some((f) => f.detail.includes("占位符")))
  }

  {
    // ⑤ 变异：2026/12/31（格式错）⇒ 红
    const r = judgeExemptionRegister(dated([day({ expires: "2026/12/31" })]))
    ok("ISS-830⑤：expires=2026/12/31 ⇒ failed（格式非法）", r.status === "failed")
    ok("ISS-830⑤：点名叫「格式非法」", (r.findings ?? []).some((f) => f.detail.includes("格式非法")))
    // 形状对但日期不存在（2026-02-31）也要红 —— 否则它会被 Date 归一化后当成 03-03
    const r2 = judgeExemptionRegister(dated([day({ expires: "2026-02-31" })]))
    ok("ISS-830⑤：expires=2026-02-31（不存在的一天）⇒ failed", r2.status === "failed" && (r2.findings ?? []).some((f) => f.detail.includes("格式非法")))
  }

  {
    // 纯函数 toDayNumber：合法/非法 + 时区无关
    ok("toDayNumber：2026-11-14 合法", toDayNumber("2026-11-14") === Date.UTC(2026, 10, 14) / 86_400_000)
    ok("toDayNumber：2026-02-31 ⇒ null", toDayNumber("2026-02-31") === null)
    ok("toDayNumber：2026/11/14 ⇒ null", toDayNumber("2026/11/14") === null)
    // 反向对照：跨年差一天要算对（天数差 = 1，不是 0 也不是 32）
    ok("toDayNumber：跨年差 1 天", toDayNumber("2027-01-01")! - toDayNumber("2026-12-31")! === 1)
  }

  // ═══ 以下为 ISS-818：按 _meta.kind 分类，不靠目录猜 ═══
  {
    // readBaselineKind：四种合法 kind 识别，缺/错 ⇒ null
    ok("ISS-818 kind：waiver 识别", readBaselineKind({ _meta: { kind: "waiver" } }) === "waiver")
    ok("ISS-818 kind：allowlist/frozen/ledger 识别", ["allowlist", "frozen", "ledger"].every((k) => readBaselineKind({ _meta: { kind: k } }) === k))
    ok("ISS-818 kind：缺 _meta ⇒ null（判红，不猜）", readBaselineKind({ waivers: {} }) === null)
    ok("ISS-818 kind：_meta 有但缺 kind ⇒ null", readBaselineKind({ _meta: { note: "x" } }) === null)
    ok("ISS-818 kind：未知 kind ⇒ null（不静默当 waiver）", readBaselineKind({ _meta: { kind: "exempt" } }) === null)
  }

  {
    // 分类：allowlist 的 48 条「无 expires」不数成豁免 ⇒ 原 48>46 的红消失
    const r = judgeExemptionRegister({
      files: {}, // allowlist 文件根本不进 files
      skippedFiles: { "gate-coverage-allowlist.json": "allowlist" },
      limits: {}, previousLimits: {},
    })
    ok("ISS-818 分类：allowlist 不数成豁免 ⇒ passed（48>46 红消失）", r.status === "passed")
    ok("ISS-818 分类：出声「跳过了 N 个非豁免文件」并点名文件与 kind", (r.detail ?? "").includes("跳过了 1 个非豁免文件") && (r.detail ?? "").includes("gate-coverage-allowlist.json(allowlist)"))
    // 反向对照：若把同样 48 条当 waiver 喂进去（旧口径），必须红 —— 证明绿是分类带来的，不是数字凑巧
    const oldWay = judgeExemptionRegister({
      files: { "gate-coverage-allowlist.json": Array.from({ length: 48 }, () => ex()) },
      limits: { "gate-coverage-allowlist.json": 46 }, previousLimits: { "gate-coverage-allowlist.json": 46 },
    })
    ok("ISS-818 反向对照：旧口径把 allowlist 当 waiver ⇒ failed（48 条 > 46）", oldWay.status === "failed" && (oldWay.findings ?? []).some((f) => f.detail.includes("48 条") && f.detail.includes("上限 46")))
  }

  {
    // 缺 kind ⇒ 红（即便豁免数在上限内也不许放行）
    const r = judgeExemptionRegister({
      files: { "a.json": [ex()] }, limits: { "a.json": 2 }, previousLimits: { "a.json": 2 },
      missingKindFiles: ["mystery.json"],
    })
    ok("ISS-818 缺 kind：含豁免形状对象却缺声明 ⇒ failed", r.status === "failed")
    ok("ISS-818 缺 kind：点名文件与「不许靠目录猜」", (r.findings ?? []).some((f) => f.detail.includes("mystery.json") && f.detail.includes("不许靠目录猜")))
  }

  {
    // 阴性：真 waiver 无 expires ⇒ 红；移除该条 ⇒ 绿（分类正确时红线仍咬真豁免）
    const waiverFiles = { "layer-contract.json": [ex({ ticket: "ISS-823" })] } // 无 expires 的真 waiver
    const red = judgeExemptionRegister({ files: waiverFiles, limits: { "layer-contract.json": 0 }, previousLimits: { "layer-contract.json": 0 } })
    ok("ISS-818 阴性：真 waiver 无 expires ⇒ failed", red.status === "failed" && (red.findings ?? []).some((f) => f.detail.includes("layer-contract.json")))
    const green = judgeExemptionRegister({ files: { "layer-contract.json": [] }, limits: { "layer-contract.json": 0 }, previousLimits: { "layer-contract.json": 0 } })
    ok("ISS-818 阴性：移除该条 ⇒ passed（红→绿对转）", green.status === "passed")
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（49 条：正例×2 / 变异a×2 / 变异b×2 / 变异c×3 / 干扰×2 / 缺输入×2 / collect×3 / ISS-830×17 / toDayNumber×4 / ISS-818×12）")
  return fails === 0
}
