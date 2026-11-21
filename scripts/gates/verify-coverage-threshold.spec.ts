/**
 * `verify-coverage-threshold.ts` 的自检向量（ISS-522 / C-0a）。
 *
 * 本判据的价值全在**能红且红得有用**（红文案带行号 + 三选一改法），
 * 以及**豁免有牙**（brand.ts 不判，但同形态的假文件不在清单必须判）。
 * 正向「全 100 ⇒ 绿」太容易，光有它等于一条恒绿空检查。
 *
 * 四类用例：正例 / 反例（必然失败）/ 边界 / 实仓。
 * 实仓契约用例验「判据读得懂真产物、豁免生效、判词形态对」——passed/failed 皆是合法态
 * （缺口数量是状态不是契约，ISS-878）；缺 coverage 产物是合法环境态（gateselfcheck 档
 * 与 CI lane 都不跑 vitest --coverage），单列「未跑」不判红（ISS-899）。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_PREFIX_THRESHOLDS, DEFAULT_THRESHOLD, judgeCoverageThreshold, type ThresholdInputs } from "./verify-coverage-threshold.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const ROOT = "/repo"
const A = "packages/x/y/src/a.ts"
/**
 * client 域路径（ISS-530 分域用例）：合成的非提档 client 包，只命中 `packages/client/` → 80。
 * ISS-534 把 ui-theme 单独提到 100 后，域 80 的向量不能再借 ui-theme 路径 —— 否则撞上包级
 * 100 前缀，期望的 80 变 100（CI lane 实测咬到）。用合成路径让「域 80」用例只考域规则本身。
 */
const C = "packages/client/ui-sample/src/client/styles.ts"
/** 包级提档路径（ISS-534）：命中更长前缀 `packages/client/ui-theme/` → 100。 */
const C100 = "packages/client/ui-theme/src/client/styles.ts"
/** 包级提档路径（ISS-540）：命中更长前缀 `packages/client/ui-pm/` → 100（提档纪律第二例）。 */
const C100PM = "packages/client/ui-pm/src/client/list/list.tsx"
/** 包级提档路径（ISS-543）：命中更长前缀 `packages/client/ui-model/` → 100（提档纪律第三例）。 */
const C100MODEL = "packages/client/ui-model/src/client/panel/panel.tsx"
/** 包级提档路径（ISS-544）：命中更长前缀 `packages/client/ui-kb/` → 100（提档纪律第四例）。 */
const C100KB = "packages/client/ui-kb/src/client/list/list.tsx"
const BRAND = "packages/storage/storage/src/brand.ts"
const FAKE = "packages/storage/storage/src/fake-brand.ts"

const k = (rel: string) => `${ROOT}/${rel}`
const stat = (total: number, covered: number, pct: number) => ({ total, covered, pct, skipped: 0 })

/** 四维全满的单文件 summary。 */
function goodSummary(rel = A) {
  return JSON.stringify({
    total: { statements: stat(10, 10, 100), branches: stat(4, 4, 100), functions: stat(2, 2, 100), lines: stat(8, 8, 100) },
    [k(rel)]: { statements: stat(10, 10, 100), branches: stat(4, 4, 100), functions: stat(2, 2, 100), lines: stat(8, 8, 100) },
  })
}

/** statements 给定 pct 的单文件 summary（其余三维满；分域用例的主力构造器）。 */
function pctSummary(rel: string, pct: number) {
  const total = 10
  const covered = Math.round((total * pct) / 100)
  return JSON.stringify({
    total: { statements: stat(total, covered, pct) },
    [k(rel)]: {
      statements: stat(total, covered, pct),
      branches: stat(4, 4, 100),
      functions: stat(2, 2, 100),
      lines: stat(8, 8, 100),
    },
  })
}

/** 一个 statements 90% 的文件 + final 里给出的未覆盖位置（行号来源）。 */
function badSummary() {
  return JSON.stringify({
    total: { statements: stat(10, 9, 90) },
    [k(A)]: {
      statements: stat(10, 9, 90),
      branches: stat(4, 4, 100),
      functions: stat(2, 2, 100),
      lines: stat(8, 8, 100),
    },
  })
}

/** final：a.ts 有一条未覆盖语句在 22:5。 */
function finalWithLoc(rel = A, line = 22, column = 5) {
  return JSON.stringify({
    [k(rel)]: {
      path: k(rel),
      statementMap: { "0": { start: { line, column }, end: { line, column: column + 3 } } },
      fnMap: {},
      branchMap: {},
      s: { "0": 0 },
      f: {},
      b: {},
    },
  })
}

/** brand.ts 的真实形态：statements 0/1（单行恒等函数被 v8 记 0）。 */
function brandShape(rel = BRAND) {
  return JSON.stringify({
    total: { statements: stat(1, 0, 0) },
    [k(rel)]: { statements: stat(1, 0, 0), branches: stat(4, 4, 100), functions: stat(1, 0, 0), lines: stat(1, 1, 100) },
  })
}

const EXEMPT_BRAND = JSON.stringify({
  [BRAND]: { why: "v8 单行恒等函数盲区，补测试也无法覆盖", ticket: "ISS-876", expires: "2026-12-31" },
})

function base(over: Partial<ThresholdInputs> = {}): ThresholdInputs {
  return { summary: goodSummary(), final: null, exempt: "{}", ...over }
}

/** 只跑纯函数 + 实仓用例。 */
export function run(): boolean {
  const cases: [string, boolean, string?][] = []
  const t = (name: string, ok: boolean, note?: string) => cases.push([name, ok, note])

  // ── 正向 ───────────────────────────────────────────────────────
  const ok = judgeCoverageThreshold(base())
  t("正向：四维全 100 ⇒ passed", ok.status === "passed", `实得 ${ok.status}`)
  t("正向：pass detail 报在判文件数（不静默）", /在判 1 文件/.test(ok.detail ?? ""), `实得 ${JSON.stringify(ok.detail)}`)

  // ── 反例①：覆盖不足 ⇒ failed，且判词带行号 ────────────────────────
  const bad = judgeCoverageThreshold(base({ summary: badSummary(), final: finalWithLoc() }))
  t("反例：statements 90% ⇒ failed", bad.status === "failed", `实得 ${bad.status}`)
  const f = bad.findings?.[0]
  t("反例：finding.file 是仓库相对路径", f?.file === A, `实得 ${f?.file}`)
  t("反例：判词带 文件:行:列（主交付）", /:22:5/.test(f?.detail ?? ""), `实得 ${f?.detail?.slice(0, 120)}`)
  t("反例：判词带 expected / actual 分子分母百分比", /expected 100%/.test(f?.detail ?? "") && /9\/10 = 90\.00%/.test(f?.detail ?? ""), `实得 ${f?.detail?.slice(0, 160)}`)
  t("反例：判词带 howToFix 三选一", /howToFix/.test(f?.detail ?? "") && /加用例/.test(f?.detail ?? "") && /v8 ignore/.test(f?.detail ?? ""), `实得 ${f?.detail?.slice(0, 200)}`)
  t("反例：判词带 forbidden 硬约束", /forbidden/.test(f?.detail ?? "") && /不许改阈值/.test(f?.detail ?? ""), `实得 ${f?.detail?.slice(0, 240)}`)
  t("反例：Finding.line 取首个未覆盖行（run-gates 打印成 文件:行）", f?.line === 22, `实得 ${f?.line}`)

  // ── 反例②：branches 未覆盖位置全部列出 ──────────────────────────
  const finalBranches = JSON.stringify({
    [k(A)]: {
      statementMap: {}, fnMap: {},
      branchMap: { "0": { type: "if", locations: [{ start: { line: 7, column: 2 } }, { start: { line: 9, column: 4 } }] } },
      s: {}, f: {}, b: { "0": [1, 0] },
    },
  })
  const branchBad = judgeCoverageThreshold(base({
    summary: JSON.stringify({ total: {}, [k(A)]: { branches: stat(2, 1, 50) } }),
    final: finalBranches,
  }))
  t("反例：branches 50% ⇒ failed 且判词点名 path 2/2", branchBad.status === "failed" && /path 2\/2/.test(branchBad.findings?.[0]?.detail ?? ""), `实得 ${branchBad.findings?.[0]?.detail?.slice(0, 120)}`)

  // ── 豁免：brand.ts 不判 ────────────────────────────────────────
  const exempted = judgeCoverageThreshold(base({ summary: brandShape(), exempt: EXEMPT_BRAND }))
  t("豁免：brand.ts 形态 + 在清单 ⇒ passed（不判红）", exempted.status === "passed", `实得 ${exempted.status}`)
  t("豁免：pass detail 报豁免了 1 个文件", /豁免 1 文件/.test(exempted.detail ?? ""), `实得 ${JSON.stringify(exempted.detail)}`)

  // ── 豁免有牙：同形态假文件不在清单 ⇒ 必须判 ─────────────────────
  const notExempt = judgeCoverageThreshold(base({ summary: brandShape(FAKE), exempt: EXEMPT_BRAND }))
  t("豁免有牙：同形态假文件不在清单 ⇒ failed（变异对照）", notExempt.status === "failed" && notExempt.findings?.[0]?.file === FAKE, `实得 ${notExempt.status} / ${notExempt.findings?.[0]?.file}`)

  // ── 判不了 / 坏输入 ────────────────────────────────────────────
  const noProd = judgeCoverageThreshold(base({ summary: null }))
  t("判不了：无 coverage-summary.json ⇒ unjudged(no-corpus)", noProd.status === "unjudged" && noProd.reason === "no-corpus", `实得 ${noProd.status}/${noProd.reason}`)
  const badJson = judgeCoverageThreshold(base({ summary: "{not json" }))
  t("反例：summary 坏 JSON ⇒ failed（reporter 被换掉）", badJson.status === "failed", `实得 ${badJson.status}`)
  const badExempt = judgeCoverageThreshold(base({ exempt: "{oops" }))
  t("反例：豁免清单坏 JSON ⇒ failed", badExempt.status === "failed", `实得 ${badExempt.status}`)
  const totalOnly = judgeCoverageThreshold(base({ summary: JSON.stringify({ total: {} }) }))
  t("边界：只有 total 无文件条目 ⇒ unjudged（不是绿）", totalOnly.status === "unjudged", `实得 ${totalOnly.status}`)

  // ── 边界：空真（total 0）不判红 ─────────────────────────────────
  const emptyTrue = judgeCoverageThreshold(base({
    summary: JSON.stringify({ total: {}, [k(A)]: { statements: stat(0, 0, 100), branches: stat(4, 4, 100), functions: stat(2, 2, 100), lines: stat(8, 8, 100) } }),
  }))
  t("边界：纯类型文件 statements 0/0 不判红（空真）", emptyTrue.status === "passed", `实得 ${emptyTrue.status}`)

  // ── 阈值可注入（文案 expected 从配置读，不手写）────────────────────
  const lowered = judgeCoverageThreshold(base({ summary: badSummary(), threshold: 80 }))
  t("边界：阈值注入 80 时 90% ⇒ passed（expected 从配置读）", lowered.status === "passed", `实得 ${lowered.status}`)
  t("阈值默认值是 100", DEFAULT_THRESHOLD === 100, `实得 ${DEFAULT_THRESHOLD}`)

  // ── 分域阈值（ISS-530 / P3-U1：packages/client/ → 80）──────────────────
  // 验收原文三件：client 79% 必红 · client 80% 过 · 非 client 维持 100 不变。
  const clientBad = judgeCoverageThreshold(base({ summary: pctSummary(C, 79), final: finalWithLoc(C, 31, 7) }))
  t("分域：client 路径 79% ⇒ failed（80 域阈值下必红）", clientBad.status === "failed", `实得 ${clientBad.status}`)
  t("分域：client 红判词 expected 是域阈值 80（非全局 100）",
    /expected 80%/.test(clientBad.findings?.[0]?.detail ?? "") && /79\.00%/.test(clientBad.findings?.[0]?.detail ?? ""),
    `实得 ${clientBad.findings?.[0]?.detail?.slice(0, 160)}`)
  t("分域：client 红判词落 client 文件（前缀匹配命中）", clientBad.findings?.[0]?.file === C, `实得 ${clientBad.findings?.[0]?.file}`)

  const clientOk = judgeCoverageThreshold(base({ summary: pctSummary(C, 80) }))
  t("分域：client 路径 80% ⇒ passed（边界正好达标）", clientOk.status === "passed", `实得 ${clientOk.status}`)
  t("分域：pass detail 出声域阈值读数（判据改形态要看得见）",
    /域阈值 packages\/client\/→80 ×1 文件/.test(clientOk.detail ?? ""), `实得 ${JSON.stringify(clientOk.detail)}`)

  const nonClientBad = judgeCoverageThreshold(base({ summary: pctSummary(A, 99), final: finalWithLoc(A, 12, 3) }))
  t("分域：非 client 路径 99% ⇒ failed（perFile 100 维持不变）", nonClientBad.status === "failed", `实得 ${nonClientBad.status}`)
  t("分域：非 client 红判词 expected 仍是 100",
    /expected 100%/.test(nonClientBad.findings?.[0]?.detail ?? ""), `实得 ${nonClientBad.findings?.[0]?.detail?.slice(0, 120)}`)

  // 同一份 summary 两域并存：client 过、非 client 红 —— 一张表两档互不越界。
  const mixed = judgeCoverageThreshold(base({
    summary: JSON.stringify({
      total: { statements: stat(20, 18, 90) },
      [k(C)]: { statements: stat(10, 8, 80), branches: stat(4, 4, 100), functions: stat(2, 2, 100), lines: stat(8, 8, 100) },
      [k(A)]: { statements: stat(10, 10, 100), branches: stat(4, 3, 75), functions: stat(2, 2, 100), lines: stat(8, 8, 100) },
    }),
  }))
  t("分域：两域并存时各判各的（client 80 过、非 client branches 75 红，互不越界）",
    mixed.status === "failed" && mixed.findings?.length === 1 && mixed.findings?.[0]?.file === A,
    `实得 ${mixed.status} / ${mixed.findings?.map((x) => `${x.file}`).join(",")}`)

  // 优先级：域前缀优先于全局 threshold 注入（全局只管未命中前缀的文件）。
  //   取 75%：全局 60 下本会放行，域 80 不放行 ⇒ 红——若全局压过域表，这里会是 passed。
  const precedence = judgeCoverageThreshold(base({ summary: pctSummary(C, 75), threshold: 60 }))
  t("分域：域阈值优先于全局 threshold 注入（75% 在全局 60 下本会过，域 80 不放行 ⇒ 红）",
    precedence.status === "failed" && /expected 80%/.test(precedence.findings?.[0]?.detail ?? ""),
    `实得 ${precedence.status}`)

  // 注入口：prefixThresholds 可整表注入覆盖（spec 不依赖默认表也能构造域用例）。
  const injected = judgeCoverageThreshold(base({
    summary: pctSummary(C, 85),
    prefixThresholds: { "packages/client/": 90 },
  }))
  t("分域：prefixThresholds 注入 90 ⇒ 85% 红（整表覆盖默认）",
    injected.status === "failed" && /expected 90%/.test(injected.findings?.[0]?.detail ?? ""),
    `实得 ${injected.status} / ${injected.findings?.[0]?.detail?.slice(0, 120)}`)
  t("分域：默认表含 packages/client/→80、ui-theme/ui-pm/ui-model/ui-kb→100（五条）",
    Object.keys(DEFAULT_PREFIX_THRESHOLDS).length === 5
      && DEFAULT_PREFIX_THRESHOLDS["packages/client/"] === 80
      && DEFAULT_PREFIX_THRESHOLDS["packages/client/ui-theme/"] === 100
      && DEFAULT_PREFIX_THRESHOLDS["packages/client/ui-pm/"] === 100
      && DEFAULT_PREFIX_THRESHOLDS["packages/client/ui-model/"] === 100
      && DEFAULT_PREFIX_THRESHOLDS["packages/client/ui-kb/"] === 100,
    `实得 ${JSON.stringify(DEFAULT_PREFIX_THRESHOLDS)}`)

  // 最长前缀：更长前缀覆盖更短前缀（给未来分档留的路，今天钉住语义）。
  const longest = judgeCoverageThreshold(base({
    summary: pctSummary("packages/client/ui-blocks/src/x.ts", 85),
    prefixThresholds: { "packages/client/": 80, "packages/client/ui-blocks/": 90 },
  }))
  t("分域：最长前缀优先（ui-blocks 90 下 85% 红，packages/client/ 80 不放行）",
    longest.status === "failed" && /expected 90%/.test(longest.findings?.[0]?.detail ?? ""),
    `实得 ${longest.status}`)

  // ── 包级提档（ISS-534 / P4-0：默认表 ui-theme → 100，最长前缀优先的真实向量）──
  // 用默认表（不注入），钉死 ui-theme 走 100 而非域 80 —— 这是把阈值写进 DEFAULT_PREFIX_THRESHOLDS
  // 的验收本身，也是 CI lane 上一轮漏测的那条：改数据表必带 spec 向量。
  const themeBad = judgeCoverageThreshold(base({ summary: pctSummary(C100, 80), final: finalWithLoc(C100, 31, 7) }))
  t("提档：ui-theme 80% ⇒ failed（expected 是包级 100 非域 80）",
    themeBad.status === "failed" && /expected 100%/.test(themeBad.findings?.[0]?.detail ?? "") && /80\.00%/.test(themeBad.findings?.[0]?.detail ?? ""),
    `实得 ${themeBad.status} / ${themeBad.findings?.[0]?.detail?.slice(0, 120)}`)
  const themeOk = judgeCoverageThreshold(base({ summary: pctSummary(C100, 100) }))
  t("提档：ui-theme 100% ⇒ passed（正好达标）", themeOk.status === "passed", `实得 ${themeOk.status}`)
  // 同一读数 85%：ui-sample（域 80）过、ui-theme（包级 100）红 —— 默认表里包级前缀压过域前缀，有牙。
  const sample85 = judgeCoverageThreshold(base({ summary: pctSummary(C, 85) }))
  const theme85 = judgeCoverageThreshold(base({ summary: pctSummary(C100, 85) }))
  t("提档：默认表包级前缀优先于域前缀（85% 下 ui-sample 过、ui-theme 红）",
    sample85.status === "passed" && theme85.status === "failed" && /expected 100%/.test(theme85.findings?.[0]?.detail ?? ""),
    `实得 sample=${sample85.status} / theme=${theme85.status}`)

  // ISS-540 / P4-V2：ui-pm 提档到 100（提档纪律第二例）——改数据表必带 spec 向量。
  const pm85 = judgeCoverageThreshold(base({ summary: pctSummary(C100PM, 85) }))
  const pm100 = judgeCoverageThreshold(base({ summary: pctSummary(C100PM, 100) }))
  t("提档：ui-pm 85% ⇒ failed（expected 是包级 100 非域 80）",
    pm85.status === "failed" && /expected 100%/.test(pm85.findings?.[0]?.detail ?? ""),
    `实得 ${pm85.status} / ${pm85.findings?.[0]?.detail?.slice(0, 120)}`)
  t("提档：ui-pm 100% ⇒ passed（正好达标）", pm100.status === "passed", `实得 ${pm100.status}`)

  // ISS-543 / P4-M1：ui-model 提档到 100（提档纪律第三例）——改数据表必带 4 条 spec 向量。
  // ① 85% 红（expected 是包级 100 非域 80）② 100% 绿（正好达标）
  // ③ 99% 红（差 1 个点也不放行，钉死「四维全满」而非四舍五入）④ 默认表最长前缀压过域前缀。
  const mo85 = judgeCoverageThreshold(base({ summary: pctSummary(C100MODEL, 85) }))
  const mo100 = judgeCoverageThreshold(base({ summary: pctSummary(C100MODEL, 100) }))
  const mo99 = judgeCoverageThreshold(base({ summary: pctSummary(C100MODEL, 99) }))
  const sample85Model = judgeCoverageThreshold(base({ summary: pctSummary(C, 85) }))
  t("提档：ui-model 85% ⇒ failed（expected 是包级 100 非域 80）",
    mo85.status === "failed" && /expected 100%/.test(mo85.findings?.[0]?.detail ?? ""),
    `实得 ${mo85.status} / ${mo85.findings?.[0]?.detail?.slice(0, 120)}`)
  t("提档：ui-model 100% ⇒ passed（正好达标）", mo100.status === "passed", `实得 ${mo100.status}`)
  t("提档：ui-model 99% ⇒ failed（四维全满，差 1 点不放行）",
    mo99.status === "failed" && /expected 100%/.test(mo99.findings?.[0]?.detail ?? ""),
    `实得 ${mo99.status}`)
  t("提档：默认表下 ui-model 85% 红而合成 client 包 85% 绿（最长前缀压过域前缀）",
    mo85.status === "failed" && sample85Model.status === "passed",
    `实得 ui-model=${mo85.status} / sample=${sample85Model.status}`)

  // ISS-544 / P5-D1：ui-kb 提档到 100（提档纪律第四例，Q7 甲案首单）——改数据表必带 spec 向量。
  const kb85 = judgeCoverageThreshold(base({ summary: pctSummary(C100KB, 85) }))
  const kb100 = judgeCoverageThreshold(base({ summary: pctSummary(C100KB, 100) }))
  const kb99 = judgeCoverageThreshold(base({ summary: pctSummary(C100KB, 99) }))
  t("提档：ui-kb 85% ⇒ failed（expected 是包级 100 非域 80）",
    kb85.status === "failed" && /expected 100%/.test(kb85.findings?.[0]?.detail ?? ""),
    `实得 ${kb85.status} / ${kb85.findings?.[0]?.detail?.slice(0, 120)}`)
  t("提档：ui-kb 100% ⇒ passed（正好达标）", kb100.status === "passed", `实得 ${kb100.status}`)
  t("提档：ui-kb 99% ⇒ failed（四维全满，差 1 点不放行）",
    kb99.status === "failed" && /expected 100%/.test(kb99.findings?.[0]?.detail ?? ""),
    `实得 ${kb99.status}`)

  // 变异对照（分域有牙的自证）：85% 在默认表（80）下过；把表换成空 ⇒ 同一读数红。
  //   若分域逻辑是恒绿摆设，这两个用例不可能一绿一红。
  const withDomain85 = judgeCoverageThreshold(base({ summary: pctSummary(C, 85) }))
  t("分域：client 85% ⇒ 默认表下 passed", withDomain85.status === "passed", `实得 ${withDomain85.status}`)
  const noDomain85 = judgeCoverageThreshold(base({ summary: pctSummary(C, 85), prefixThresholds: {} }))
  t("分域（变异）：同读数换空域表 ⇒ failed（expected 100）—— 分域不是恒绿摆设",
    noDomain85.status === "failed" && /expected 100%/.test(noDomain85.findings?.[0]?.detail ?? ""),
    `实得 ${noDomain85.status}`)

  // ── 实仓：真读产物 ⇒ 验「判据能判读真产物」，不验「还有多少缺口」──────────
  //
  // ⚠️ 这里曾经写死「真产物必须 failed / 红项 ≥ 16」，结果覆盖率补齐后自检从 24/24 掉到 21/24
  //    —— **修得越好自检越红**（ISS-878）。根因是把「某个时点的覆盖率状态」当成了不变契约。
  //
  //    缺口数量是**状态**，不是**契约**：它随补测单调下降到 0，写死它等于给判据装了一个
  //    「不许把活干完」的反向闸门。契约只能验「判据读得懂真产物、豁免生效、判词形态对」，
  //    这些不随覆盖率变化。
  //
  // ⚠️ 缺产物同样不是契约而是环境态（ISS-899 清债）：gateselfcheck 档与 CI 的
  //    gate-selftests lane 都不跑 vitest --coverage（selfcheck 不需要 build 同理），
  //    把「本地产物在场」当前提 ⇒ lane 上这格永久红。缺产物 ⇒ 实仓组单列「未跑」，
  //    不判红也不并入绿；产物在场（本地跑过 coverage）时实仓契约照常全验。
  const skipped: string[] = []
  const real = realInputs()
  if (real === null) {
    skipped.push("实仓契约组未跑：缺 coverage-summary.json（跑 vitest --coverage 后复跑可验实仓契约）")
  } else {
    const verdict = judgeCoverageThreshold(real)
    // 状态用例：passed 或 failed 都合法 —— 取决于当前覆盖率，判据两种都要能正确给出。
    t("实仓：判据能判读真产物（passed / failed 皆是合法态，不是判不了）",
      verdict.status === "passed" || verdict.status === "failed", `实得 ${verdict.status}`)
    // 契约用例：任何时刻 brand.ts 都不能出现在 findings 里（豁免恒定生效）。
    t("实仓：brand.ts 被豁免（不出现在 findings）", !(verdict.findings ?? []).some((x) => x.file === BRAND), `实得 ${(verdict.findings ?? []).filter((x) => x.file === BRAND).length} 条`)
    // 契约用例：每条 finding 的形态恒定（仓库相对路径 + 文件:行 + 维度 + expected/actual + howToFix + forbidden）。
    //   ⚠️ 不硬验「必须有行号」：coverage-final.json 只在显式带 json reporter 采集时才在（ISS-877）；
    //      且覆盖率补齐后根本没有 finding 可验。判词带行号这件事由上面的纯函数用例用构造数据钉死。
    const shapeOk = (verdict.findings ?? []).every((x) =>
      x.file.startsWith("packages/") && /:\d+/.test(x.detail ?? "") && /expected \d+% \/ actual \d+\//.test(x.detail ?? ""))
    t("实仓：finding 形态恒定（有 finding 时每条都合规；无 finding 时空真）", shapeOk, "有 finding 不合形态")
    // 形态自检说明：当前 0 条 finding ⇒ every 返回 true（空真）。覆盖率若回退出现 finding，此用例会验住它们。
  }

  const badCases = cases.filter((c) => !c[1])
  for (const [n, okk, note] of cases) console.log(`${okk ? "✓" : "✗"} ${n}${okk ? "" : `\n    ↳ ${note ?? "（未给实际值）"}`}`)
  for (const s of skipped) console.log(`- ${s}（单列，不并入绿）`)
  console.log(`\nverify-coverage-threshold selftest ${cases.length - badCases.length}/${cases.length} 通过${skipped.length ? ` · 另有 ${skipped.length} 条未跑（缺产物，单列不并入绿）` : ""}`)
  return badCases.length === 0
}

/** 真读仓内三份产物。 */
function realInputs(): ThresholdInputs | null {
  const read = (rel: string) => {
    try {
      return fs.readFileSync(path.join(REPO, rel), "utf8")
    } catch {
      return null
    }
  }
  const summary = read("coverage/coverage-summary.json")
  if (summary === null) return null
  return { summary, final: read("coverage/coverage-final.json"), exempt: read("scripts/baseline/coverage-exempt.json") ?? "{}" }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(run() ? 0 : 1)
}
