/**
 * 桥接层 ↔ 官方原件 token 契约 parity 检查（ISS-931 复审追加）。
 *
 * 零依赖、只读仓内文件，可用两种形态跑：
 *   node packages/client/ui-theme/tests/bridge-parity.check.mjs --check   # selftest 形态，退出码 0/1
 *   bun test --isolate packages/client/ui-theme/tests/bridge-parity.test.ts  # vitest 形态（同一逻辑）
 *
 * 三条口径：
 *  ① 官方定义为 var() 且桥接也定义的项 ⇒ 桥接值必须仍是 var()（禁「伪装的裸值」）；
 *  ② --dsw-static-* 调色板 ⇒ 桥接值 === 官方包值（禁手抄）；
 *  ③ designer 点名的 --dsl-search-line-height ⇒ 解析到官方 22px。
 *
 * 契约快照 fixtures/official-token-contract.json 由已装官方包实扫生成，来源见其 _source。
 *
 * @module @matter/client-ui-theme/tests/bridge-parity.check
 */

import { readFileSync } from "node:fs"

const HERE = new URL(".", import.meta.url)

/** 从 CSS 全文抽变量定义：`--x: value;` → Map。 */
export function definitions(css) {
  const out = new Map()
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

/** 把 var(--x) 链解析成终结字面值（防环，深度 16）。 */
export function resolveVar(name, defs, depth = 0) {
  if (depth > 16) return undefined
  const value = defs.get(name)
  if (value === undefined) return undefined
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(value)
  return m === null ? value : resolveVar(m[1], defs, depth + 1)
}

/**
 * 跑一遍 parity，返回四组违规（空数组 = 全过）。
 * @param opts.bridgeCss - 可注入的桥接 CSS 全文；缺省读真文件。mutation 自测靠它喂改过的源码。
 */
export function checkParity(opts = {}) {
  const fixture = JSON.parse(readFileSync(new URL("fixtures/official-token-contract.json", HERE), "utf8"))
  const bridgeCss = opts.bridgeCss ?? readFileSync(new URL("../src/client/dsw-bridge.css", HERE), "utf8")
  const bridgeDefs = definitions(bridgeCss)
  const allDefs = new Map([...definitions(readFileSync(new URL("../src/client/theme.css", HERE), "utf8")), ...bridgeDefs])

  // ① 官方 var() 转发项
  const varForward = Object.entries(fixture.officialVarForward)
  const varMissing = varForward.filter(([n]) => !bridgeDefs.has(n)).map(([n]) => `${n}: 桥接层缺失该官方转发项`)
  const varDisguised = varForward
    .filter(([n]) => bridgeDefs.has(n) && !/^var\(/.test(bridgeDefs.get(n)))
    .map(([n]) => `${n}: 官方=${fixture.officialVarForward[n]} / 桥接=${bridgeDefs.get(n)}（写死数值）`)

  // ② 官方静态调色板
  const statics = Object.entries(fixture.officialStaticPalette).filter(([n]) => bridgeDefs.has(n))
  const staticDrift = statics
    .filter(([n, v]) => (bridgeDefs.get(n) ?? "").toLowerCase() !== v.toLowerCase())
    .map(([n, v]) => `${n}: 官方=${v} / 桥接=${bridgeDefs.get(n)}`)

  // ③ designer 点名的字面量项
  const flagged = Object.entries(fixture.designerFlaggedLiteral)
  const flagDrift = flagged
    .filter(([n, v]) => resolveVar(n, allDefs) !== v)
    .map(([n, v]) => `${n}: 官方=${v} / 桥接解析=${resolveVar(n, allDefs)}`)

  // ④ 六档圆角：解析值必须逐档等于官方，且六档两两不同（防「全改回 4px 仍绿」）。
  const radiusEntries = Object.entries(fixture.officialRadiusTiers)
  const radiusMissing = radiusEntries.filter(([n]) => !bridgeDefs.has(n)).map(([n]) => `${n}: 桥接层缺失该圆角档`)
  const radiusDrift = radiusEntries
    .filter(([n, v]) => bridgeDefs.has(n) && resolveVar(n, allDefs) !== v)
    .map(([n, v]) => `${n}: 官方=${v} / 桥接解析=${resolveVar(n, allDefs)}`)
  const resolvedRadii = radiusEntries.map(([n]) => resolveVar(n, allDefs))
  if (new Set(resolvedRadii).size !== radiusEntries.length) {
    radiusDrift.push(`六档圆角解析值不两两不同：${JSON.stringify(Object.fromEntries(radiusEntries.map(([n], i) => [n, resolvedRadii[i]])))}`)
  }

  return {
    varForward: [...varMissing, ...varDisguised],
    staticPalette: staticDrift,
    flaggedLiteral: flagDrift,
    radius: [...radiusMissing, ...radiusDrift],
    counts: {
      varForward: varForward.length,
      staticOverlap: statics.length,
      flagged: flagged.length,
      radius: radiusEntries.length,
    },
    // 点名项的解析值：防「写成另一个 var 但解析错档」的假绿。
    resolved: {
      "--dsl-search-radius": resolveVar("--dsl-search-radius", allDefs),
      "--dsl-search-line-height": resolveVar("--dsl-search-line-height", allDefs),
    },
    resolvedRadii,
  }
}

/** 直接执行形态：node <file> --check → 退出码 0/1。 */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const r = checkParity()
  const total = r.varForward.length + r.staticPalette.length + r.flaggedLiteral.length + r.radius.length
  console.log(`bridge-parity · 官方 var 转发 ${r.counts.varForward} 条 / 静态调色板交集 ${r.counts.staticOverlap} 条 / 点名字面量 ${r.counts.flagged} 条 / 六档圆角 ${r.counts.radius} 条`)
  for (const [group, list] of Object.entries(r)) {
    if (group === "counts" || group === "resolved" || group === "resolvedRadii") continue
    for (const line of list) console.log(`  ✗ [${group}] ${line}`)
  }
  console.log(total === 0 ? "✓ parity 全过" : `✗ parity 违规 ${total} 条`)
  process.exit(total === 0 ? 0 : 1)
}
