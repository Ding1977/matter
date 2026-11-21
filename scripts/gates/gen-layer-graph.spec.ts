/**
 * `gen-layer-graph.ts` 的自检（ISS-845 · W0-GATE-G9）。
 *
 * 本判据的价值全在**反向用例**：「判据绿」改哪行都可能绿，只有造一条**必须红**的 fixture
 * 才证明「该红能红」。
 *
 * 两种喂法都测（照 G7 spec 同一套路）：
 *   ① 纯函数（`judgeLayerGraph` / `classifyUse`）直接喂构造数据 —— 判据逻辑与规则分支
 *   ② 落盘 fixture（`evaluate`）走真 AST 扫盘 —— 证明接线真的接上了
 *      （只测纯函数 = 摘掉 scanEdges / collectSymbolUses 也全绿）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_POLICY,
  OUTPUT_REL,
  type DependencyPolicy,
  type ManifestLike,
  type PackageRow,
  type SymbolUse,
  classifyUse,
  collectSymbolUses,
  evaluate,
  judgeLayerGraph,
  loadTs,
  renderLayer,
  renderLayerGraph,
  writeLayerGraph,
} from "./gen-layer-graph.ts"
import { type LayerEdge, type PkgRef } from "./lint-layer-new.ts"

let fails = 0
const ok = (name: string, cond: boolean, note?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : `\n    ↳ ${note ?? "（未给实际值）"}`}`)
  if (!cond) fails++
}

/* ───────────────────── fixture ───────────────────── */

const PKGS: PkgRef[] = [
  { key: "util/kernel", dir: "packages/util/kernel", name: "@matter/kernel" },
  { key: "llm/llm", dir: "packages/llm/llm", name: "@matter/llm" },
  { key: "product/issue", dir: "packages/product/issue", name: "@matter/issue" },
  { key: "scenario/trader", dir: "packages/scenario/trader", name: "@matter/trader" },
]
const LAYERS: Record<string, number> = {
  "util/kernel": 1,
  "llm/llm": 2,
  "product/issue": 3,
  "scenario/trader": 4,
}

const use = (o: Partial<SymbolUse> = {}): SymbolUse => ({
  from: "scenario/trader",
  spec: "@matter/issue",
  exportName: "readIssue",
  file: "packages/scenario/trader/src/a.ts",
  line: 1,
  typeOnly: false,
  ...o,
})

const edge = (o: Partial<LayerEdge> = {}): LayerEdge => ({
  src: "util/kernel",
  dst: "product/issue",
  spec: "@matter/issue",
  file: "packages/util/kernel/src/x.ts",
  line: 1,
  typeOnly: false,
  ...o,
})

const ROWS: PackageRow[] = PKGS.map((p) => ({
  key: p.key,
  name: p.name,
  group: p.key.split("/")[0],
  layer: LAYERS[p.key] ?? null,
  peers: [],
  deps: [],
}))

const manifestsOf = (m: Record<string, ManifestLike>): ReadonlyMap<string, ManifestLike | null> =>
  new Map(Object.entries(m))

const judge = (o: Partial<Parameters<typeof judgeLayerGraph>[0]> = {}) =>
  judgeLayerGraph({
    rows: ROWS,
    edges: [],
    uses: [],
    layers: LAYERS,
    packages: PKGS,
    manifests: manifestsOf({}),
    packagesDirExists: true,
    astAvailable: true,
    contractPresent: true,
    policy: DEFAULT_POLICY,
    expectedDoc: "DOC",
    actualDoc: "DOC",
    ...o,
  })

const failedWith = (r: ReturnType<typeof judgeLayerGraph>, rule: string): boolean =>
  r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes(`[${rule}]`))

/* ───────────────────── ① 判定规则：classifyUse ───────────────────── */

console.log("\n① peer vs dep 判定规则（默认拒绝）")
{
  const peerPolicy: DependencyPolicy = {
    ...DEFAULT_POLICY,
    peerRequiredHostExports: { "@matter/llm": ["readConfig"] },
    safeHostDependencyExports: { "@matter/kernel": ["never"] },
    duplicateSafePackages: ["@matter/brand"],
    hostDependencyPackages: ["@matter/llm"],
  }

  // cordis 无条件 peer
  const c1 = classifyUse(use({ spec: "cordis", exportName: "Context" }), DEFAULT_POLICY)
  ok("cordis ⇒ peer（无条件，不查表）", c1?.section === "peer", JSON.stringify(c1))
  const c1b = classifyUse(use({ spec: "cordis/plugin" }), DEFAULT_POLICY)
  ok("cordis 子路径 ⇒ 同样 peer", c1b?.section === "peer", JSON.stringify(c1b))

  // 符号级 peer
  const c2 = classifyUse(use({ spec: "@matter/llm", exportName: "readConfig" }), peerPolicy)
  ok("命中 peerRequiredHostExports ⇒ peer", c2?.section === "peer", JSON.stringify(c2))
  // 同包不同符号 ⇒ 不继承 peer（证明判定单位是符号不是包）
  const c2b = classifyUse(use({ spec: "@matter/llm", exportName: "other" }), peerPolicy)
  ok("同包未登记符号 ⇒ 不是 peer（判定单位是符号，不是包）", c2b === null, JSON.stringify(c2b))

  // duplicate-safe
  const c3 = classifyUse(use({ spec: "@matter/brand", exportName: "brandString" }), peerPolicy)
  ok("duplicateSafePackages ⇒ dependency", c3?.section === "dependency", JSON.stringify(c3))

  // safe 表
  const c4 = classifyUse(use({ spec: "@matter/kernel", exportName: "never" }), peerPolicy)
  ok("命中 safeHostDependencyExports ⇒ dependency", c4?.section === "dependency", JSON.stringify(c4))

  // 仅类型
  const c5 = classifyUse(use({ spec: "@matter/issue", exportName: "x", typeOnly: true }), DEFAULT_POLICY)
  ok("仅类型 import ⇒ dev", c5?.section === "dev", JSON.stringify(c5))

  // 默认拒绝
  const c6 = classifyUse(use({ spec: "@matter/issue", exportName: "readIssue" }), DEFAULT_POLICY)
  ok("未登记、取值 ⇒ null（默认拒绝）", c6 === null, JSON.stringify(c6))

  // 无界形态（命名空间/默认/副作用）不可分类
  const c7 = classifyUse(use({ spec: "@matter/issue", exportName: "" }), DEFAULT_POLICY)
  ok("无界形态（import * as）⇒ 默认拒绝", c7 === null, JSON.stringify(c7))
}

/* ───────────────────── ② 图过期 ───────────────────── */

console.log("\n② 图是否过期")
{
  const pass = judge()
  ok("文档与现算一致 ⇒ passed", pass.status === "passed", pass.status)

  const stale = judge({ actualDoc: "OLD" })
  ok("文档不一致 ⇒ failed + GRAPH-STALE", failedWith(stale, "GRAPH-STALE"), stale.status)

  const missing = judge({ actualDoc: null })
  ok("文档不存在 ⇒ failed + GRAPH-STALE", failedWith(missing, "GRAPH-STALE"), missing.status)

  // 反向对照：不一致必须红，否则「一致⇒绿」说明不了判据有牙
  const same = judge({ expectedDoc: "A", actualDoc: "A" })
  ok("反向对照：内容相同 ⇒ 不报 STALE", !failedWith(same, "GRAPH-STALE"), same.status)
}

/* ───────────────────── ③ 反向边 ───────────────────── */

console.log("\n③ 反向边（L1→L3 上行 / L4 越层取值）")
{
  const rev = judge({ edges: [edge()] })
  ok("L1 import L3 ⇒ failed + GRAPH-REVERSE", failedWith(rev, "GRAPH-REVERSE"), rev.status)

  const down = judge({
    edges: [edge({ src: "product/issue", dst: "util/kernel", spec: "@matter/kernel", file: "packages/product/issue/src/a.ts" })],
  })
  ok("L3 import L1（正常向下）⇒ 不报 REVERSE", !failedWith(down, "GRAPH-REVERSE"), down.status)

  const l4val = judge({
    edges: [edge({ src: "scenario/trader", dst: "llm/llm", spec: "@matter/llm", file: "packages/scenario/trader/src/a.ts" })],
  })
  ok("L4 → L2 取值 ⇒ failed + GRAPH-REVERSE（越层）", failedWith(l4val, "GRAPH-REVERSE"), l4val.status)

  const l4type = judge({
    edges: [edge({ src: "scenario/trader", dst: "llm/llm", spec: "@matter/llm", file: "packages/scenario/trader/src/a.ts", typeOnly: true })],
  })
  ok("L4 → L2 仅 import type ⇒ 不报（下行只许类型）", !failedWith(l4type, "GRAPH-REVERSE"), l4type.status)
}

/* ───────────────────── ④ 声明与实际一致 ───────────────────── */

console.log("\n④ 声明与实际对账")
{
  const policy: DependencyPolicy = {
    ...DEFAULT_POLICY,
    peerRequiredHostExports: { "@matter/llm": ["readConfig"] },
    duplicateSafePackages: ["@matter/brand"],
  }

  // 未分类 ⇒ 红
  const un = judge({ uses: [use()], policy: DEFAULT_POLICY })
  ok("未分类符号 ⇒ failed + GRAPH-UNCLASSIFIED", failedWith(un, "GRAPH-UNCLASSIFIED"), un.status)

  // 判 peer 但没双写 ⇒ 红
  const noDual = judge({
    uses: [use({ spec: "@matter/llm", exportName: "readConfig" })],
    policy,
    manifests: manifestsOf({ "scenario/trader": { name: "@matter/trader", peerDependencies: { "@matter/llm": "workspace:*" } } }),
  })
  ok("判 peer 只写 peer 无 dev ⇒ failed + GRAPH-PEER-NOT-DUAL", failedWith(noDual, "GRAPH-PEER-NOT-DUAL"), noDual.status)

  // 判 peer 且双写 ⇒ 绿
  const dual = judge({
    uses: [use({ spec: "@matter/llm", exportName: "readConfig" })],
    policy,
    manifests: manifestsOf({
      "scenario/trader": {
        name: "@matter/trader",
        peerDependencies: { "@matter/llm": "workspace:*" },
        devDependencies: { "@matter/llm": "workspace:*" },
      },
    }),
  })
  ok("判 peer 且 peer+dev 双写 ⇒ passed", dual.status === "passed", `${dual.status} ${JSON.stringify(dual.findings)}`)

  // 判 dep 但写进 peer ⇒ 红
  const wrongSection = judge({
    uses: [use({ spec: "@matter/brand", exportName: "brandString" })],
    policy,
    manifests: manifestsOf({ "scenario/trader": { name: "@matter/trader", peerDependencies: { "@matter/brand": "workspace:*" } } }),
  })
  ok("判 dep 却写进 peer ⇒ failed + GRAPH-SECTION-MISMATCH", failedWith(wrongSection, "GRAPH-SECTION-MISMATCH"), wrongSection.status)

  // 判 dep 且写进 dependencies ⇒ 绿
  const rightSection = judge({
    uses: [use({ spec: "@matter/brand", exportName: "brandString" })],
    policy,
    manifests: manifestsOf({ "scenario/trader": { name: "@matter/trader", dependencies: { "@matter/brand": "workspace:*" } } }),
  })
  ok("判 dep 且写进 dependencies ⇒ passed", rightSection.status === "passed", rightSection.status)

  // cordis 由 G1 专判，本判据不重复判它的双写
  const cordisUse = judge({
    uses: [use({ spec: "cordis", exportName: "Context" })],
    manifests: manifestsOf({ "scenario/trader": { name: "@matter/trader", peerDependencies: { cordis: "workspace:*" } } }),
  })
  ok("cordis 不双写 ⇒ 本判据不报（交 G1 verify-plugin-shape 专判）", cordisUse.status === "passed", cordisUse.status)

  // ③b 反向对账：声明了内部依赖但零 import ⇒ 化石声明必须红
  // 这条是补缺口的证据：第一版只做「import ⇒ 该声明」单向检查，
  // 造一个声明 peer 却零 import 的包时判据**报 passed**（实测），与本判据的承诺相反。
  const phantom = judge({
    uses: [], // 源码零 import
    manifests: manifestsOf({
      "scenario/trader": {
        name: "@matter/trader",
        peerDependencies: { cordis: "workspace:*", "@matter/llm": "workspace:*" },
        devDependencies: { cordis: "workspace:*" },
      },
    }),
  })
  ok("声明了内部 peer 但零 import ⇒ failed + GRAPH-PHANTOM-DECL", failedWith(phantom, "GRAPH-PHANTOM-DECL"), `${phantom.status} ${JSON.stringify(phantom.findings)}`)

  // 反向对照：同一份声明，只要源码真的 import 了它，就不该报化石
  const notPhantom = judge({
    uses: [use({ spec: "@matter/llm", exportName: "readConfig" })],
    manifests: manifestsOf({
      "scenario/trader": {
        name: "@matter/trader",
        peerDependencies: { cordis: "workspace:*", "@matter/llm": "workspace:*" },
        devDependencies: { cordis: "workspace:*", "@matter/llm": "workspace:*" },
      },
    }),
  })
  ok("反向对照：同声明但真有 import ⇒ 不报 PHANTOM-DECL", !failedWith(notPhantom, "GRAPH-PHANTOM-DECL"), JSON.stringify(notPhantom.findings))

  // 外部包（非 workspace 内部）不归本判据管，不该报化石
  const external = judge({
    uses: [],
    manifests: manifestsOf({
      "scenario/trader": { name: "@matter/trader", dependencies: { typescript: "^5.0.0" } },
    }),
  })
  ok("外部包声明（非内部包）⇒ 不报 PHANTOM-DECL", !failedWith(external, "GRAPH-PHANTOM-DECL"), JSON.stringify(external.findings))
}

/* ───────────────────── ⑤ 覆盖完整性：判不了 ≠ 绿 ───────────────────── */

console.log("\n⑤ 0 个包 / 缺输入 ⇒ unjudged（不是绿）")
{
  const noDir = judge({ packagesDirExists: false })
  ok("packages/ 不存在 ⇒ unjudged(no-corpus)", noDir.status === "unjudged" && noDir.reason === "no-corpus", noDir.status)

  const zero = judge({ packages: [] })
  ok("0 个包 ⇒ unjudged(no-corpus)", zero.status === "unjudged" && zero.reason === "no-corpus", zero.status)

  const noTs = judge({ astAvailable: false })
  ok("无 typescript ⇒ unjudged(no-binary)", noTs.status === "unjudged" && noTs.reason === "no-binary", noTs.status)

  const noContract = judge({ contractPresent: false })
  ok("无层表 ⇒ unjudged(no-baseline)", noContract.status === "unjudged" && noContract.reason === "no-baseline", noContract.status)
}

/* ───────────────────── ⑥ 渲染：六列 + area 恒 — ───────────────────── */

console.log("\n⑥ 产出表六列")
{
  const doc = renderLayerGraph([
    { key: "util/kernel", name: "@matter/kernel", group: "util", layer: 1, peers: [], deps: [] },
    { key: "scenario/trader", name: "@matter/trader", group: "scenario", layer: 4, peers: ["product/issue"], deps: [] },
  ])
  ok("表头是 6 列", doc.includes("| package | group | logical_layer | area | peerDependencies | evidence |"), doc.split("\n").find((l) => l.startsWith("| package")))
  ok("logical_layer 渲染成 L1/L4", doc.includes("| L1 |") && doc.includes("| L4 |"), "")
  ok("area 恒为 —", doc.split("\n").filter((l) => l.startsWith("| @matter/")).every((l) => l.includes("| — |")), "")
  ok("peer 为空渲染 —", doc.includes("| — | — |"), "")
  ok("字节稳定：同输入两次渲染全等", renderLayerGraph(ROWS) === renderLayerGraph(ROWS), "")
  ok("排序稳定：包顺序按 key", (() => {
    const a = renderLayerGraph([ROWS[3], ROWS[0]])
    const b = renderLayerGraph([ROWS[0], ROWS[3]])
    return a === b
  })(), "")

  ok("renderLayer(null) ⇒ —", renderLayer(null) === "—", renderLayer(null))
  ok("renderLayer(2) ⇒ L2", renderLayer(2) === "L2", renderLayer(2))

  const unreg = renderLayerGraph([{ key: "x/y", name: null, group: "x", layer: null, peers: [], deps: [] }])
  ok("层表未登记的包 ⇒ evidence 写「层表未登记」", unreg.includes("层表未登记"), "")
}

/* ───────────────────── ⑦ 符号抽取（真 AST） ───────────────────── */

console.log("\n⑦ 符号抽取 collectSymbolUses（真 AST）")
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glg-sym-"))
  try {
    const src = [
      `import { a, b } from "@matter/kernel"`,
      `import type { T } from "@matter/kernel"`,
      `import { type U, v } from "@matter/kernel"`,
      `import * as ns from "@matter/kernel"`,
      `import def from "@matter/kernel"`,
      `import "@matter/kernel"`,
      `export { w } from "@matter/kernel"`,
      `// import { commentOnly } from "@matter/kernel"`,
    ].join("\n")
    fs.mkdirSync(path.join(tmp, "packages/util/kernel/src"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "packages/util/kernel/src/a.ts"), src)

    // 解析器走与门禁同一条加载器（loadTs），不在这里自己拼机器路径 ——
    // 自检拿到的 ts 必须是门禁拿到的那一个，否则「自检测的不是门禁跑的那条路」。
    const ts = loadTs(tmp) ?? loadTs("")
    if (!ts) {
      ok("（跳过：取不到 typescript）", true)
    } else {
      const files = ["packages/util/kernel/src/a.ts"]
      const uses = collectSymbolUses({ root: tmp, files, fromOf: () => "util/kernel", ts })
      const named = uses.filter((u) => u.exportName !== "").map((u) => u.exportName)
      ok("具名符号被抽出（a/b/T/U/v/w）", ["a", "b", "T", "U", "v", "w"].every((n) => named.includes(n)), named.join(","))
      ok("import type 的 T 标 typeOnly", uses.some((u) => u.exportName === "T" && u.typeOnly), "")
      ok("`{ type U }` 标 typeOnly", uses.some((u) => u.exportName === "U" && u.typeOnly), "")
      ok("命名空间 import 记无界（exportName 空）", uses.some((u) => u.exportName === ""), "")
      ok("副作用 import 也会被记录", uses.filter((u) => u.spec === "@matter/kernel").length >= 6, String(uses.length))
      ok("注释里的 import 不算（AST 天然排除）", !named.includes("commentOnly"), named.join(","))
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/* ───────────────────── ⑧ 落盘接线（真扫盘） ───────────────────── */

console.log("\n⑧ 落盘 fixture：evaluate 真扫盘")
{
  const mk = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glg-eval-"))
    fs.mkdirSync(path.join(root, "scripts/baseline"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "scripts/baseline/layer-contract-next.json"),
      JSON.stringify({ layers: { "util/kernel": 1, "product/issue": 3 }, subpathLayers: {}, waivers: {} }),
    )
    fs.mkdirSync(path.join(root, "packages/util/kernel/src"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "packages/util/kernel/package.json"),
      JSON.stringify({ name: "@matter/kernel", peerDependencies: { cordis: "workspace:*" }, devDependencies: { cordis: "workspace:*" } }),
    )
    fs.writeFileSync(path.join(root, "packages/util/kernel/src/index.ts"), "export const k = 1\n")
    fs.mkdirSync(path.join(root, "packages/product/issue/src"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "packages/product/issue/package.json"),
      JSON.stringify({ name: "@matter/issue", peerDependencies: { cordis: "workspace:*" }, devDependencies: { cordis: "workspace:*" } }),
    )
    fs.writeFileSync(path.join(root, "packages/product/issue/src/index.ts"), "export const readIssue = 1\n")
    return root
  }

  // ① 干净 fixture（无跨包边）⇒ 生成文档后应绿
  {
    const root = mk()
    try {
      writeLayerGraph(root)
      const r = evaluate(root)
      ok("干净 fixture（2 包、零跨包边）⇒ passed", r.status === "passed", `${r.status} ${JSON.stringify(r.findings)}`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ② 变异：造一条 L1 → L3 反向边 ⇒ 必红
  {
    const root = mk()
    try {
      writeLayerGraph(root)
      fs.appendFileSync(path.join(root, "packages/util/kernel/src/index.ts"), `import { readIssue } from "@matter/issue"\n`)
      const r = evaluate(root)
      ok("变异 L1→L3 反向边 ⇒ failed + GRAPH-REVERSE", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("GRAPH-REVERSE")), `${r.status} ${JSON.stringify(r.findings)}`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ③ 恢复 ⇒ 绿
  {
    const root = mk()
    try {
      writeLayerGraph(root)
      const r = evaluate(root)
      ok("恢复（删反向边）⇒ 回到 passed", r.status === "passed", r.status)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ④ 图过期：手改文档 ⇒ 红
  {
    const root = mk()
    try {
      writeLayerGraph(root)
      fs.appendFileSync(path.join(root, OUTPUT_REL), "\n手改一行\n")
      const r = evaluate(root)
      ok("手改生成物一行 ⇒ failed + GRAPH-STALE", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("GRAPH-STALE")), r.status)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ⑤ 0 个包 ⇒ unjudged
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glg-zero-"))
    try {
      fs.mkdirSync(path.join(root, "scripts/baseline"), { recursive: true })
      fs.writeFileSync(path.join(root, "scripts/baseline/layer-contract-next.json"), JSON.stringify({ layers: {}, subpathLayers: {}, waivers: {} }))
      const r = evaluate(root)
      ok("0 个包 ⇒ unjudged(no-corpus) 不是绿", r.status === "unjudged" && r.reason === "no-corpus", `${r.status}/${r.reason}`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

/* ───────────────────── 收尾 ───────────────────── */

export function run(): boolean {
  console.log(`\n${fails === 0 ? "✓" : "✗"} gen-layer-graph spec: ${fails === 0 ? "全过" : `${fails} 条失败`}`)
  return fails === 0
}
