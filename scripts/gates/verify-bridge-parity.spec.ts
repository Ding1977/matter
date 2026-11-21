/**
 * `verify-bridge-parity.ts` 的自检向量（ISS-931）。
 *
 * 判据的价值全在**反向用例**：正向「现在全对」太容易；必须证明四组里任一组漂移都会红，
 * 否则「parity 判据」只是个摆设。特别是六档圆角：reviewer mutation 实测「全改回 4px
 * 仍 rc=0」——本版把圆角纳入契约后，这两条 mutation 必须红。
 *
 * 跑法：node scripts/gates/verify-bridge-parity.ts --selftest
 *
 * @module scripts/gates/verify-bridge-parity.spec
 */
import { readFileSync } from "node:fs"
import { checkParity } from "../../packages/client/ui-theme/tests/bridge-parity.check.mjs"
import { judge, type ParityResult } from "./verify-bridge-parity.ts"

/** 当前真值（只读仓内文件，不写盘）。 */
const real = checkParity() as ParityResult
/** 桥接 CSS 全文，用于真 mutation（喂 checkParity 的注入口，不改盘上文件）。 */
const bridgeCss = readFileSync(new URL("../../packages/client/ui-theme/src/client/dsw-bridge.css", import.meta.url), "utf8")

export function run(): boolean {
  const cases: Array<[string, boolean]> = []

  // 正向：当前桥接四组全过。
  cases.push(["正向：当前契约全过 ⇒ passed", judge(real).status === "passed"])

  // 防空转：四组契约集都必须非空，否则「空集合 ⇒ 恒绿」等于没验。
  cases.push([
    "非空：var 转发 / 静态调色板 / 点名字面量 / 六档圆角四组契约都非空",
    real.counts.varForward > 0 && real.counts.staticOverlap > 0 && real.counts.flagged > 0 && real.counts.radius === 6,
  ])

  // 反向①：官方 var() 转发被写死成数值 ⇒ 必红。
  const varDrift: ParityResult = { ...real, varForward: ["--dsl-search-radius: 官方=var(--dsw-radius-lg) / 桥接=4px（写死数值）"] }
  cases.push(["反向①：var() 转发被写死 ⇒ failed", judge(varDrift).status === "failed"])

  // 反向②：静态调色板手抄漂移 ⇒ 必红（22px→8px 同类）。
  const colorDrift: ParityResult = { ...real, staticPalette: ["--dsw-static-deepseek-500: 官方=#4176e6 / 桥接=#3d6df2"] }
  cases.push(["反向②：静态调色板漂移 ⇒ failed", judge(colorDrift).status === "failed"])

  // 反向③：点名字面量解析值漂移 ⇒ 必红。
  const literalDrift: ParityResult = { ...real, flaggedLiteral: ["--dsl-search-line-height: 官方=22px / 桥接解析=8px"] }
  cases.push(["反向③：点名字面量漂移 ⇒ failed", judge(literalDrift).status === "failed"])

  // 反向④：契约项从桥接侧删掉（check.mjs 的「删项假绿」反向钉死）⇒ 必红。
  const missing: ParityResult = { ...real, varForward: ["--dsl-search-radius: 桥接层缺失该官方转发项"] }
  cases.push(["反向④：官方转发项从桥接侧缺失 ⇒ failed（删项假绿）", judge(missing).status === "failed"])

  // 反向⑤【reviewer mutation】：只把 md 档改成 xs 档（两档解析值变成同一个 4px）⇒ 必红。
  const oneTier = bridgeCss.replace("--dsw-radius-md: var(--matter-alias-radius-md)", "--dsw-radius-md: var(--matter-alias-radius-xs)")
  cases.push([
    "反向⑤：mutation 把 md 档改成 xs 档（同值 4px）⇒ radius 组红",
    oneTier !== bridgeCss && checkParity({ bridgeCss: oneTier }).radius.length > 0,
  ])

  // 反向⑥【reviewer 原用例】：六档全改回 4px ⇒ 必红（旧版此处 rc=0，正是判据洞）。
  const allFour = bridgeCss.replace(/--dsw-radius-[a-z0-9-]+:\s*var\([^)]*\);/g, (line) => line.replace(/var\([^)]*\)/, "4px"))
  const allFourResult = checkParity({ bridgeCss: allFour })
  cases.push([
    "反向⑥：mutation 六档圆角全改回 4px ⇒ radius 组红（reviewer 原用例）",
    allFour !== bridgeCss && allFourResult.radius.length > 0 && judge(allFourResult as ParityResult).status === "failed",
  ])

  for (const [name, ok] of cases) console.log(`  ${ok ? "✓" : "✗"} ${name}`)
  return cases.every(([, ok]) => ok)
}
