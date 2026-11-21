/**
 * `lint-layer-new.ts` 的自检（ISS-843 · W0-GATE-G7）。
 *
 * 本判据的价值全在**反向用例**：正向「依赖方向对 ⇒ 绿」改哪行都绿。
 * 所以每条判据都造一个**必须红**的 fixture，证明了「该红能红」再证明「不该红的不红」。
 *
 * 两种喂法都测：
 *   ① 纯函数（`judgeLayerNew`）直接喂构造数据 —— 三条判据逻辑与覆盖完整性
 *   ② 落盘 fixture（`evaluate`）走真 AST 扫盘 —— 证明接线真的接上了
 *      （只测纯函数 = 摘掉 scanEdges 也全绿，ISS-701 缺口 A 的同一课）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FEATURE_LAYER, LAYER, evaluate, judgeLayerNew, type LayerContract, type LayerEdge, type PkgRef } from "./lint-layer-new.ts"

let fails = 0
const ok = (name: string, cond: boolean, note?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : `\n    ↳ ${note ?? "（未给实际值）"}`}`)
  if (!cond) fails++
}

/* ───────────────────── 纯函数 fixture ───────────────────── */

const PKGS: PkgRef[] = [
  { key: "util/kernel", dir: "packages/util/kernel", name: "@matter/kernel" },
  { key: "product/issue", dir: "packages/product/issue", name: "@matter/issue" },
  { key: "scenario/trader", dir: "packages/scenario/trader", name: "@matter/trader" },
  { key: "scenario/canvas", dir: "packages/scenario/canvas", name: "@matter/canvas" },
]
const LAYERS: Record<string, number> = {
  "util/kernel": 1,
  "product/issue": 3,
  "scenario/trader": 4,
  "scenario/canvas": 4,
}
const CONTRACT: LayerContract = {
  layers: LAYERS,
  subpathLayers: {},
  waivers: { "LAYER-REVERSE": [], "LAYER-SAME": [] },
}
const edge = (o: Partial<LayerEdge> = {}): LayerEdge => ({
  src: "util/kernel",
  dst: "product/issue",
  spec: "@matter/issue",
  file: "packages/util/kernel/src/x.ts",
  line: 1,
  typeOnly: false,
  ...o,
})
const judge = (o: Partial<Parameters<typeof judgeLayerNew>[0]> = {}) =>
  judgeLayerNew({
    contract: CONTRACT,
    packages: PKGS,
    packagesDirExists: true,
    packageProblems: [],
    edges: [],
    astAvailable: true,
    subpathExists: () => true,
    ...o,
  })
/** 命中里抽 rule 标签（判据每条 detail 都以 `[RULE]` 开头）。 */
const rules = (r: { findings?: { detail: string }[] }) =>
  (r.findings ?? []).map((f) => /^\[([A-Z-]+)\]/.exec(f.detail)?.[1] ?? "").filter(Boolean)

/* ───────────────────── ① 三条判据的正反例 ───────────────────── */
{
  // 判据 1 · L0→L4 单向
  const up = judge({ edges: [edge()] })
  ok("判据1 反向：L1 import L3 ⇒ failed + LAYER-REVERSE", up.status === "failed" && rules(up).includes("LAYER-REVERSE"), `实得 ${up.status} [${rules(up).join(",")}]`)
  ok("判据1 点名：detail 带层号与两端包名", !!up.findings?.some((f) => f.detail.includes("L1→L3") && f.detail.includes("util/kernel") && f.detail.includes("@matter/issue")))

  const upType = judge({ edges: [edge({ typeOnly: true })] })
  ok("判据1 反向：L1→L3 的 import type 也红（单向不许用类型洗白）", upType.status === "failed" && rules(upType).includes("LAYER-REVERSE"))

  const down = judge({ edges: [edge({ src: "product/issue", dst: "util/kernel", spec: "@matter/kernel" })] })
  ok("判据1 正向：L3 import L1 下行 ⇒ passed", down.status === "passed", `实得 ${down.status} [${rules(down).join(",")}]`)

  // 判据 2 · L4 向下只许 import type（值走注入服务）
  const l4TypeDown = judge({ edges: [edge({ src: "scenario/trader", dst: "util/kernel", spec: "@matter/kernel", typeOnly: true })] })
  ok("判据2 正向：L4 → L1 的 import type ⇒ passed（注入服务拿到的类型就是这个形状）", l4TypeDown.status === "passed", `实得 ${l4TypeDown.status} [${rules(l4TypeDown).join(",")}]`)

  const l4ValueDown = judge({ edges: [edge({ src: "scenario/trader", dst: "util/kernel", spec: "@matter/kernel" })] })
  ok("判据2 反向：L4 → L1 直接取值 ⇒ failed + LAYER-INJECT", l4ValueDown.status === "failed" && rules(l4ValueDown).includes("LAYER-INJECT"), `实得 ${l4ValueDown.status} [${rules(l4ValueDown).join(",")}]`)

  const l4ValueDown3 = judge({ edges: [edge({ src: "scenario/trader", dst: "product/issue", spec: "@matter/issue" })] })
  ok("判据2 反向：L4 → L3 直接取值 ⇒ failed（L1/L2/L3 一视同仁）", l4ValueDown3.status === "failed" && rules(l4ValueDown3).includes("LAYER-INJECT"))

  // 判据 3 · 跨功能插件禁 import 值
  const cross = judge({ edges: [edge({ src: "scenario/trader", dst: "scenario/canvas", spec: "@matter/canvas" })] })
  ok("判据3 反向：L4 取另一个 L4 的值 ⇒ failed + LAYER-SAME", cross.status === "failed" && rules(cross).includes("LAYER-SAME"), `实得 ${cross.status} [${rules(cross).join(",")}]`)

  const crossType = judge({ edges: [edge({ src: "scenario/trader", dst: "scenario/canvas", spec: "@matter/canvas", typeOnly: true })] })
  ok("判据3 正向：L4 ↔ L4 的 import type ⇒ passed（共享声明走类型）", crossType.status === "passed", `实得 ${crossType.status} [${rules(crossType).join(",")}]`)

  ok("层号常量齐备：L1/L2/L3/L4 = 1/2/3/4，功能插件层 = L4", LAYER.PRIMITIVE === 1 && LAYER.CAPABILITY === 2 && LAYER.PRODUCT === 3 && FEATURE_LAYER === 4)
}

/* ───────────────────── ② 覆盖完整性（不许静默当绿） ───────────────────── */
{
  const zero = judge({ packages: [] })
  ok("防扫空：packages/*/* 下 0 个包 ⇒ unjudged no-corpus（不是 passed）", zero.status === "unjudged" && zero.reason === "no-corpus", `实得 ${zero.status}/${zero.reason}`)

  const noDir = judge({ packages: [], packagesDirExists: false })
  ok("防扫空：packages/ 目录都不在 ⇒ unjudged no-corpus", noDir.status === "unjudged" && noDir.reason === "no-corpus")

  ok("无解析器：找不到 typescript ⇒ unjudged no-binary（不许冒充绿）", judge({ astAvailable: false }).status === "unjudged" && judge({ astAvailable: false }).reason === "no-binary")
  ok("无层表：layer-contract-next.json 缺失 ⇒ unjudged no-baseline", judge({ contract: null }).status === "unjudged" && judge({ contract: null }).reason === "no-baseline")

  // 漏登记包：真的把键删掉（只把值设成 undefined 的话 Object.keys 仍在，用例会假绿）
  const withoutCanvas: Record<string, number> = { ...LAYERS }
  delete withoutCanvas["scenario/canvas"]
  const unjudgedPkg = judge({ contract: { ...CONTRACT, layers: withoutCanvas } })
  ok("漏登记包：packages/ 下有包但层表没有 ⇒ failed + LAYER-UNJUDGED", unjudgedPkg.status === "failed" && rules(unjudgedPkg).includes("LAYER-UNJUDGED"), `实得 ${unjudgedPkg.status} [${rules(unjudgedPkg).join(",")}]`)
  ok("漏登记包：按包报一次，不为它的每条边各报一条（避免同源噪音）", (unjudgedPkg.findings ?? []).filter((f) => f.detail.includes("LAYER-UNJUDGED")).length === 1)

  const phantom = judge({ contract: { ...CONTRACT, layers: { ...LAYERS, "scenario/cad": 4 } } })
  ok("层表化石：登记了 packages/ 下不存在的包 ⇒ failed + LAYER-PHANTOM 且点名",
    phantom.status === "failed" && !!phantom.findings?.some((f) => f.detail.includes("LAYER-PHANTOM") && f.detail.includes("scenario/cad")),
    `实得 ${phantom.status} [${rules(phantom).join(",")}]`)

  const badPkg = judge({ packageProblems: ["packages/x/y/package.json 缺 name ⇒ 别的包 import 它时解析不出边（静默漏判，比判红坏）"] })
  ok("包自身坏：缺 name ⇒ failed + LAYER-PACKAGE", badPkg.status === "failed" && rules(badPkg).includes("LAYER-PACKAGE"))

  const badSub = judge({ contract: { ...CONTRACT, subpathLayers: { "@matter/kernel/nope": 1 } }, subpathExists: () => false })
  ok("子路径守卫：登记的子路径不在目标包 exports 里 ⇒ failed + LAYER-SUBPATH", badSub.status === "failed" && rules(badSub).includes("LAYER-SUBPATH"))
}

/* ───────────────────── ③ 子路径层号（合法复用不被误判） ───────────────────── */
{
  const sub = judge({
    contract: { ...CONTRACT, subpathLayers: { "@matter/canvas/ui": 1 } },
    edges: [edge({ src: "scenario/trader", dst: "scenario/canvas", spec: "@matter/canvas/ui" })],
  })
  ok("子路径原语：L4 取别家的 L1 共享组件（已登记）⇒ passed（旧格 P1 同口径）", sub.status === "passed", `实得 ${sub.status} [${rules(sub).join(",")}]`)

  const subUnregistered = judge({ edges: [edge({ src: "scenario/trader", dst: "scenario/canvas", spec: "@matter/canvas/ui" })] })
  ok("子路径原语：同一条边但没登记子路径 ⇒ 回落到包层号判 LAYER-SAME（不许沉默放行）", subUnregistered.status === "failed" && rules(subUnregistered).includes("LAYER-SAME"))
}

/* ───────────────────── ④ 豁免双向（豁免不许当免死金牌） ───────────────────── */
{
  const w = (list: { file: string; match?: string; reason: string }[]) =>
    judge({ contract: { ...CONTRACT, waivers: { "LAYER-REVERSE": list } }, edges: [edge()] })

  ok("豁免：命中且带 reason ⇒ passed（归零）", w([{ file: "packages/util/kernel/src/x.ts", reason: "自检：证明豁免生效" }]).status === "passed")
  ok("豁免：命中但 reason 为空 ⇒ failed（不许当免死金牌）", w([{ file: "packages/util/kernel/src/x.ts", reason: "  " }]).status === "failed")
  ok("豁免：条目指的文件已不命中 ⇒ failed（化石要摘）", (() => {
    const r = w([{ file: "packages/已不存在/src/y.ts", reason: "自检：化石" }])
    return r.status === "failed" && !!r.findings?.some((f) => f.detail.includes("化石"))
  })())
  ok("豁免边级：match 对不上 ⇒ 仍红（豁免收到边级，文件级不设防区不存在）", (() => {
    const r = w([{ file: "packages/util/kernel/src/x.ts", match: "→ @matter/other", reason: "自检：match 不命中" }])
    return r.status === "failed" && !!r.findings?.some((f) => f.detail.includes("化石"))
  })())

  // 桶键守卫：豁免桶名与规则 id 不同词 ⇒ 那一桶永远匹配不到命中（静默失效的豁免口）
  const bucket = (name: string) => judge({ contract: { ...CONTRACT, waivers: { [name]: [] } }, edges: [] })
  ok("桶键守卫：写对了的桶（LAYER-REVERSE / LAYER-SAME / LAYER-INJECT）⇒ passed", ["LAYER-REVERSE", "LAYER-SAME", "LAYER-INJECT"].every((n) => bucket(n).status === "passed"))
  ok("桶键守卫：桶名写错一个词（LAYER-CROSS）⇒ failed + LAYER-WAIVER（豁免不会静默失效）",
    (() => {
      const r = bucket("LAYER-CROSS")
      return r.status === "failed" && rules(r).includes("LAYER-WAIVER") && !!r.findings?.some((f) => f.detail.includes("永远不会生效"))
    })(), `实得 ${JSON.stringify(bucket("LAYER-CROSS"))}`)
  ok("桶键守卫：把不可豁免的规则写进 waivers（LAYER-PHANTOM）⇒ failed + LAYER-WAIVER（表错了不是边欠着）",
    (() => {
      const r = bucket("LAYER-PHANTOM")
      return r.status === "failed" && rules(r).includes("LAYER-WAIVER")
    })())
  ok("桶键守卫：非法桶只报一条（不重复产出「化石」噪音）",
    (bucket("LAYER-CROSS").findings ?? []).filter((f) => f.detail.includes("LAYER-WAIVER")).length === 1)
}

/* ───────────────────── ⑤ 真扫盘：接线真的接上了 ───────────────────── */
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-layer-new-selftest-"))
  const write = (rel: string, body: string) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  /** 重建整棵假新树：清空 packages/ + 重写层表 + 按清单造包。变异验证要求能反复重建。 */
  const scene = (opts: {
    layers?: Record<string, number>
    subpathLayers?: Record<string, number>
    pkgList?: { group: string; name: string; exports?: Record<string, string> }[]
  } = {}) => {
    const pkgList = opts.pkgList ?? [
      { group: "util/kernel", name: "@matter/kernel" },
      { group: "product/issue", name: "@matter/issue" },
      { group: "scenario/trader", name: "@matter/trader", exports: { ".": "./lib/index.js", "./ui": "./lib/ui.js" } },
      { group: "scenario/canvas", name: "@matter/canvas", exports: { ".": "./lib/index.js", "./ui": "./lib/ui.js" } },
    ]
    fs.rmSync(path.join(root, "packages"), { recursive: true, force: true })
    write(
      "scripts/baseline/layer-contract-next.json",
      JSON.stringify(
        {
          layers: opts.layers ?? LAYERS,
          subpathLayers: opts.subpathLayers ?? {},
          waivers: { "LAYER-REVERSE": [], "LAYER-SAME": [] },
        },
        null,
        2,
      ),
    )
    for (const p of pkgList) {
      write(`packages/${p.group}/package.json`, JSON.stringify({ name: p.name, version: "0.0.0", ...(p.exports ? { exports: p.exports } : {}) }))
      write(`packages/${p.group}/src/index.ts`, `export const own = 1\n`)
    }
  }
  const check = () => evaluate(root)
  // 注意：路径在 `f.file`、说明在 `f.detail` —— 只搜 detail 会漏掉「点名到文件」这件事。
  const hit = (r: ReturnType<typeof check>, rule: string, frag?: string) =>
    !!r.findings?.some((f) => f.detail.includes(rule) && (!frag || `${f.file ?? ""} ${f.detail}`.includes(frag)))

  scene()
  ok("真扫盘 · 正向：四个包零跨包 import ⇒ passed（下面每条红都得是那条边造成的）", check().status === "passed", `实得 ${check().status} ${JSON.stringify(check().findings)}`)

  // 判据 1 · 反向 + 恢复
  write("packages/util/kernel/src/bad.ts", `import { x } from "@matter/issue"\nvoid x\n`)
  ok("真扫盘 · 判据1：L1 写 import @matter/issue ⇒ failed + LAYER-REVERSE（点名文件行号）", hit(check(), "LAYER-REVERSE", "bad.ts"), `实得 ${JSON.stringify(check().findings)}`)
  fs.rmSync(path.join(root, "packages/util/kernel/src/bad.ts"))
  ok("真扫盘 · 判据1：删掉那条反向边 ⇒ 回到 passed（红是那条边造成的，不是别的）", check().status === "passed", `实得 ${check().status} ${JSON.stringify(check().findings)}`)

  // 判据 2 · L4 取值下行 vs import type
  write("packages/scenario/trader/src/value.ts", `import { k } from "@matter/kernel"\nvoid k\n`)
  ok("真扫盘 · 判据2：L4 直接取值下行 ⇒ failed + LAYER-INJECT", hit(check(), "LAYER-INJECT"), `实得 ${JSON.stringify(check().findings)}`)
  fs.rmSync(path.join(root, "packages/scenario/trader/src/value.ts"))
  write("packages/scenario/trader/src/typed.ts", `import type { K } from "@matter/kernel"\nexport type T = K\n`)
  ok("真扫盘 · 判据2：同方向改成 import type ⇒ passed", check().status === "passed", `实得 ${check().status} ${JSON.stringify(check().findings)}`)
  fs.rmSync(path.join(root, "packages/scenario/trader/src/typed.ts"))

  // 判据 3 · 跨功能插件
  write("packages/scenario/trader/src/cross.ts", `import { c } from "@matter/canvas"\nvoid c\n`)
  ok("真扫盘 · 判据3：L4 取另一个 L4 的值 ⇒ failed + LAYER-SAME", hit(check(), "LAYER-SAME"), `实得 ${JSON.stringify(check().findings)}`)
  write("packages/scenario/trader/src/cross.ts", `import type { C } from "@matter/canvas"\nexport type T = C\n`)
  ok("真扫盘 · 判据3：改成 import type ⇒ passed", check().status === "passed", `实得 ${check().status} ${JSON.stringify(check().findings)}`)
  fs.rmSync(path.join(root, "packages/scenario/trader/src/cross.ts"))

  // AST 的必要性：注释 / 字符串 / 守卫正则里的 import 不算依赖
  write(
    "packages/scenario/trader/src/noise.ts",
    [
      `// import { c } from "@matter/canvas"`,
      `/* from "@matter/canvas" */`,
      'const s = `import x from "@matter/canvas"`',
      'for (const re of [/from "@matter\\/canvas"/]) void re',
      `export const keep = s`,
      ``,
    ].join("\n"),
  )
  ok("真扫盘 · AST：注释 / 模板串 / 正则字面量里的 import 一律不算依赖", check().status === "passed", `实得 ${check().status} ${JSON.stringify(check().findings)}`)
  fs.rmSync(path.join(root, "packages/scenario/trader/src/noise.ts"))

  // 值 import 的五种真实形态都必须被认出
  const shapes: [string, string][] = [
    ["多行具名 import", `import {\n  c,\n} from "@matter/canvas"\nvoid c\n`],
    ["副作用 import", `import "@matter/canvas"\n`],
    ["require()", `const c = require("@matter/canvas")\nvoid c\n`],
    ["export ... from", `export { c } from "@matter/canvas"\n`],
    ["动态 import()", `void import("@matter/canvas")\n`],
  ]
  for (const [name, body] of shapes) {
    write("packages/scenario/trader/src/shape.ts", body)
    ok(`真扫盘 · 形态「${name}」被认出是取值 ⇒ LAYER-SAME`, hit(check(), "LAYER-SAME"), `实得 ${JSON.stringify(check().findings)}`)
    fs.rmSync(path.join(root, "packages/scenario/trader/src/shape.ts"))
  }

  // 子路径登记：真在 exports 里 ⇒ 校验通过；不在 ⇒ LAYER-SUBPATH 红
  scene({ subpathLayers: { "@matter/canvas/ui": 1 } })
  write("packages/scenario/trader/src/uses.ts", `import { btn } from "@matter/canvas/ui"\nvoid btn\n`)
  ok("真扫盘 · 子路径：exports 里真实存在的 ./ui 登记 ⇒ passed（L4 借别家 L1 原语不误伤）", check().status === "passed", `实得 ${check().status} ${JSON.stringify(check().findings)}`)
  fs.rmSync(path.join(root, "packages/scenario/trader/src/uses.ts"))

  scene({ subpathLayers: { "@matter/canvas/nope": 1 } })
  ok("真扫盘 · 子路径守卫：exports 里没有的 ./nope 登记 ⇒ failed + LAYER-SUBPATH", hit(check(), "LAYER-SUBPATH"), `实得 ${JSON.stringify(check().findings)}`)

  // 漏登记 / 化石：真扫盘也要抓到
  const noCanvas: Record<string, number> = { ...LAYERS }
  delete noCanvas["scenario/canvas"]
  scene({ layers: noCanvas })
  ok("真扫盘 · 漏登记：canvas 未登记层号 ⇒ failed + LAYER-UNJUDGED", hit(check(), "LAYER-UNJUDGED", "scenario/canvas"), `实得 ${JSON.stringify(check().findings)}`)
  scene({ layers: { ...LAYERS, "scenario/cad": 4 } })
  ok("真扫盘 · 化石：层表多一条 scenario/cad ⇒ failed + LAYER-PHANTOM", hit(check(), "LAYER-PHANTOM", "scenario/cad"), `实得 ${JSON.stringify(check().findings)}`)

  // 组是纯容器：组目录自己有 package.json 不算包（包 = packages/<g>/<p>/package.json）
  scene({ pkgList: [{ group: "util/kernel", name: "@matter/kernel" }], layers: { "util/kernel": 1 } })
  write("packages/util/package.json", JSON.stringify({ name: "@matter/should-not-count" }))
  ok("组容器：packages/<group>/package.json 不被当成包（容器口径；约束由 workspace 校验判）", check().status === "passed", `实得 ${check().status} ${JSON.stringify(check().findings)}`)

  // 防扫空：一个包都没有 ⇒ 判不了
  scene({ pkgList: [], layers: {} })
  const empty = check()
  ok("真扫盘 · 防扫空：删光所有包 ⇒ unjudged no-corpus（不是 passed）", empty.status === "unjudged" && empty.reason === "no-corpus", `实得 ${JSON.stringify(empty)}`)

  /* ───────── 扫描根 = src/：测试目录不在射程（ISS-843 第二段）───────── */
  // 与 DSH verify-client-domain-graph.ts:85 同口径：只扫 src/，测试目录天然在射程外。
  // 这一组必须**同时**有反例（同一条边放进 src/ 要红），否则「tests 下不报」分不清是
  // 射程收缩生效、还是判据整体失效了。
  scene()

  // ① tests/ 下从别包取值 ⇒ 不报（测试取别包的值构造被测对象是正当用法）
  write("packages/scenario/trader/tests/a.spec.ts", `import { c } from "@matter/canvas"\nvoid c\n`)
  const testsOnly = check()
  ok("扫描根 · 正向：tests/a.spec.ts 从别包取值 ⇒ passed（测试不在射程）", testsOnly.status === "passed", `实得 ${testsOnly.status} ${JSON.stringify(testsOnly.findings)}`)

  // ② 同一条 import 放进 src/ ⇒ 必须红。没有这一条，①可能只是判据坏了。
  write("packages/scenario/trader/src/cross-real.ts", `import { c } from "@matter/canvas"\nvoid c\n`)
  const srcSame = check()
  ok("扫描根 · 反向对照：同一条 import 放进 src/ ⇒ failed + LAYER-SAME（证明①不是判据失效）",
    srcSame.status === "failed" && hit(srcSame, "LAYER-SAME", "cross-real.ts"), `实得 ${srcSame.status} ${JSON.stringify(srcSame.findings)}`)
  fs.rmSync(path.join(root, "packages/scenario/trader/src/cross-real.ts"))
  ok("扫描根 · 恢复：删掉 src/ 里那条 ⇒ 回到 passed（tests/ 那份仍不影响）", check().status === "passed", `实得 ${JSON.stringify(check().findings)}`)

  // ③ L4 向下取值放在 tests/ 同样不报（判据 2 也要在射程收缩后保持正向）
  write("packages/scenario/trader/tests/down.spec.ts", `import { k } from "@matter/kernel"\nvoid k\n`)
  ok("扫描根 · 判据2 同口径：tests/ 里 L4 向下取值 ⇒ passed", check().status === "passed", `实得 ${JSON.stringify(check().findings)}`)
  fs.rmSync(path.join(root, "packages/scenario/trader/tests/down.spec.ts"))

  // ④ 反向边（L1→L3）放在 tests/ 也不报 —— 三条判据一视同仁，不是只对判据3 生效
  write("packages/util/kernel/tests/bad.spec.ts", `import { i } from "@matter/issue"\nvoid i\n`)
  ok("扫描根 · 判据1 同口径：tests/ 里 L1→L3 反向 ⇒ passed（射程收缩对三条判据一致）", check().status === "passed", `实得 ${JSON.stringify(check().findings)}`)
  fs.rmSync(path.join(root, "packages/util/kernel/tests/bad.spec.ts"))

  // ⑤ 边界：src/ 目录整个不存在（只有 tests/）⇒ 扫不到文件但包在，不报绿也不崩
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "lint-layer-new-bare-"))
  try {
    fs.mkdirSync(path.join(bare, "scripts/baseline"), { recursive: true })
    fs.writeFileSync(
      path.join(bare, "scripts/baseline/layer-contract-next.json"),
      JSON.stringify({ layers: { "util/kernel": 1 }, subpathLayers: {}, waivers: { "LAYER-REVERSE": [], "LAYER-SAME": [] } }),
    )
    fs.mkdirSync(path.join(bare, "packages/util/kernel/tests"), { recursive: true })
    fs.writeFileSync(path.join(bare, "packages/util/kernel/package.json"), JSON.stringify({ name: "@matter/kernel" }))
    fs.writeFileSync(path.join(bare, "packages/util/kernel/tests/only.spec.ts"), `export const x = 1\n`)
    const rBare = evaluate(bare)
    ok("扫描根 · 边界：包只有 tests/、没有 src/ ⇒ passed（包在、0 条边；不是 unjudged，也不是崩）",
      rBare.status === "passed", `实得 ${JSON.stringify(rBare)}`)
  } finally {
    fs.rmSync(bare, { recursive: true, force: true })
  }

  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* 清不掉不影响结论 */
  }
}

console.log(fails ? `\n✗ ${fails} 条不成立` : "\n✓ spec 全过：三条判据正反例齐、覆盖完整性不冒充绿、豁免双向有牙、真扫盘接线已验")
export function run(): boolean {
  return fails === 0
}

// 直接跑（`node scripts/gates/lint-layer-new.spec.ts`）时用退出码表达结论；
// 被 `runGate --selftest` import 时不抢 exitCode（那是 runGate 的返回值说了算）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(fails === 0 ? 0 : 1)
}
