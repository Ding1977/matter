/**
 * `lint-rule-fingerprint` 的 spec（ISS-840）。
 *
 * 五类反向验证（工单 ③）+ 四类结构判据：
 *
 * | # | 用例 | 期望 |
 * |---|---|---|
 * | 1 | 改一条规则的**存在性** | 指纹变 |
 * | 2 | 改**严重级** `error → warn` | 指纹变 |
 * | 3 | 改**选项** | 指纹变 |
 * | 4 | 改**顺序** | 指纹**不变**（归一化生效） |
 * | 5 | 改**注释** | 指纹**不变**（JSONC 处理正确） |
 *
 * ⛔ 第 4、5 条是「不变」的用例，比「变」的用例更容易被做成空转：
 *    一个恒返回同一个常数的指纹函数能让 4、5 全过。所以 1~3 必须同时在场，
 *    且每条都点名**期望变的是哪一个 profile**，不许只断 `status === failed`。
 *
 * 第 2、5 类走**真 JSONC 文本**（经 `parseJsonc`），不是直接构造对象 ——
 * 否则「注释被正确处理」这条根本没被验，只是验了 `JSON.stringify`。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  fingerprint,
  judgeFingerprint,
  loadTypescript,
  mergeOverlay,
  normalizedRules,
  parseJsonc,
  severity,
  TS_CANDIDATES,
  type Baseline,
  type ParsedConfig,
  type ProfileRecord,
} from "./lint-rule-fingerprint.ts"

let fails = 0
let total = 0
const ok = (name: string, cond: boolean) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const ts = loadTypescript(REPO)
if (!ts) {
  console.error(`✗ 找不到 typescript（试过 ${TS_CANDIDATES.join(" / ")}）⇒ 本 spec 判不了`)
  process.exit(2)
}

/** 一份最小的"互斥式"配置：src 组与 test 组互斥 —— 正是我们旧树 ov1/ov2 的形状。 */
const SCOPE_SRC = ["forge-*/src/**/*.{ts,tsx}"]
const SCOPE_TEST = ["forge-*/src/**/*.test.ts"]
const EXCLUDE_TEST = ["**/*.test.ts"]

interface Fixture {
  top?: Record<string, unknown>
  overrides: Array<{ files: string[]; excludeFiles?: string[]; rules: Record<string, unknown> }>
}

function buildBaseline(fx: Fixture, members: Array<{ profile: string; indexes: number[] }>): Baseline {
  const profiles: Record<string, ProfileRecord> = {}
  for (const m of members) {
    const n = normalizedRules(mergeOverlay(fx.top ?? {}, fx.overrides, m.indexes))
    profiles[m.profile] = {
      config: "fake.json",
      count: Object.keys(n).length,
      sha256: fingerprint(n),
      members: m.indexes.map((i) => ({
        index: i,
        files: [...(fx.overrides[i].files ?? [])].sort(),
        excludeFiles: fx.overrides[i].excludeFiles ? [...fx.overrides[i].excludeFiles].sort() : null,
      })),
    }
  }
  return { profiles }
}

const asConfig = (fx: Fixture): ParsedConfig => ({ path: "fake.json", config: { rules: fx.top ?? {}, overrides: fx.overrides } })
const DUAL = [
  { profile: "fake:src", indexes: [0, 1] },
  { profile: "fake:test", indexes: [0, 2] },
]

const baseFx = (): Fixture => ({
  overrides: [
    { files: SCOPE_SRC, rules: { "no-var": "error", "prefer-const": "error", "max-depth": ["error", 4] } },
    { files: SCOPE_SRC, excludeFiles: EXCLUDE_TEST, rules: { "no-console": "error" } },
    { files: SCOPE_TEST, rules: { "no-console": "off" } },
  ],
})

const red = (r: ReturnType<typeof judgeFingerprint>) => r.status === "failed"
const joined = (r: ReturnType<typeof judgeFingerprint>) => (r.findings ?? []).map((f) => f.detail).join(" | ")

console.log("── ① 正例：基线自洽 ⇒ 绿")
{
  const fx = baseFx()
  const r = judgeFingerprint([asConfig(fx)], buildBaseline(fx, DUAL))
  ok("基线由同一份配置算出 ⇒ passed", r.status === "passed")
  ok("绿的时候两个 profile 都印出来了", (r.detail ?? "").includes("fake:src") && (r.detail ?? "").includes("fake:test"))
}

console.log("── ② 改规则【存在性】⇒ 指纹变（删 src 组一条 error 规则）")
{
  const fx = baseFx()
  const baseline = buildBaseline(fx, DUAL)
  const mut = baseFx()
  delete mut.overrides[1].rules["no-console"]
  const r = judgeFingerprint([asConfig(mut)], baseline)
  ok("删 ov1 的 no-console ⇒ failed", red(r))
  ok("fail 里点名 fake:src（而不是含糊报红）", joined(r).includes("fake:src"))
  ok("fake:test 不受影响（只红真正变的那一组）", !joined(r).includes("fake:test"))
}

console.log("── ③ 改规则【存在性】⇒ 新增一条也变")
{
  const fx = baseFx()
  const baseline = buildBaseline(fx, DUAL)
  const mut = baseFx()
  mut.overrides[0].rules["no-debugger"] = "error"
  ok("新增 no-debugger ⇒ failed 且条数变了", red(judgeFingerprint([asConfig(mut)], baseline)))
}

console.log("── ④ 改【严重级】error → warn ⇒ 指纹变（真 JSONC 文本，含行内尾注释）")
{
  const src = `{
  // 顶层注释
  "overrides": [
    { "files": ["forge-*/src/**/*.{ts,tsx}"], "rules": { "no-var": "error" } }
  ]
}`
  const p1 = parseJsonc(ts, src)
  ok("带注释的 JSONC 能解析（不是 JSON.parse 那条路）", p1.config !== undefined)
  const cfg1: ParsedConfig = { path: "fake.json", config: p1.config! }
  const n1 = normalizedRules(mergeOverlay({}, (p1.config!.overrides as unknown[]) ?? [], [0]))
  const baseline: Baseline = {
    profiles: { p: { config: "fake.json", count: Object.keys(n1).length, sha256: fingerprint(n1), members: [{ index: 0, files: [...SCOPE_SRC].sort(), excludeFiles: null }] } },
  }
  ok("先把 error 版判绿（基线自洽）", judgeFingerprint([cfg1], baseline).status === "passed")

  const warnText = src.replace('"no-var": "error"', '"no-var": "warn"')
  const p2 = parseJsonc(ts, warnText)
  const r = judgeFingerprint([{ path: "fake.json", config: p2.config! }], baseline)
  ok("error → warn ⇒ failed", red(r))
  ok("说法是条数没变、指纹变了（不是含糊的'某处不对'）", joined(r).includes("指纹") && !joined(r).includes("条数"))
}

console.log("── ⑤ 改【选项】⇒ 指纹变")
{
  const fx = baseFx()
  const baseline = buildBaseline(fx, DUAL)
  const mut = baseFx()
  mut.overrides[0].rules["max-depth"] = ["error", 6]
  ok("max-depth 4 → 6 ⇒ failed", red(judgeFingerprint([asConfig(mut)], baseline)))
}

console.log("── ⑥ 改【顺序】⇒ 指纹**不变**（归一化排序生效）")
{
  const fx = baseFx()
  const baseline = buildBaseline(fx, DUAL)
  // 整组规则倒序重排：语义完全等价
  const reordered: Fixture = {
    overrides: fx.overrides.map((o) => ({ ...o, rules: Object.fromEntries(Object.entries(o.rules).reverse()) })),
  }
  ok("规则键序倒排 ⇒ 仍 passed", judgeFingerprint([asConfig(reordered)], baseline).status === "passed")
  // 归一化后键序必须字典序（证明"不变"来自排序，而不是"根本没比"）
  const n = normalizedRules({ z: "error", a: "error", m: "error" })
  ok("归一化后键按字典序（a,m,z）", JSON.stringify(Object.keys(n)) === JSON.stringify(["a", "m", "z"]))
}

console.log("── ⑦ 改【注释】⇒ 指纹**不变**（JSONC 处理正确）")
{
  const base = `{
  "overrides": [
    { "files": ["forge-*/src/**/*.{ts,tsx}"], "rules": { "no-var": "error", "max-depth": ["error", 4] } }
  ]
}`
  // ⚠️ 注释里**故意塞满注释标记与 glob**：朴素去注释正则会在这里吃掉字符串
  const commented = `/* 块注释：改注释不该改指纹 */
{
  // 行首注释 /**/ 混着斜杠星号
  "overrides": [
    {
      "files": ["forge-*/src/**/*.{ts,tsx}"], // ← 行内尾注释，glob 里本就含 /*
      "rules": {
        /* 值中间的块注释 */
        "no-var": "error", // 尾注释
        "max-depth": ["error", 4]
      }
    }
  ]
}`
  const pBase = parseJsonc(ts, base)
  const pCmt = parseJsonc(ts, commented)
  ok("两份都能解析（注释没把 JSONC 解析器打崩）", pBase.config !== undefined && pCmt.config !== undefined)
  ok(
    "加注释后 glob 字符串**一字未改**（朴素正则会把 **/* 吃成 **）",
    JSON.stringify((pCmt.config!.overrides as Array<{ files: string[] }>)[0].files) === JSON.stringify((pBase.config!.overrides as Array<{ files: string[] }>)[0].files) &&
      (pCmt.config!.overrides as Array<{ files: string[] }>)[0].files[0] === "forge-*/src/**/*.{ts,tsx}",
  )
  const toBaseline = (cfg: Record<string, unknown>): Baseline => {
    const n = normalizedRules(mergeOverlay({}, (cfg.overrides as unknown[]) ?? [], [0]))
    return { profiles: { p: { config: "fake.json", count: Object.keys(n).length, sha256: fingerprint(n), members: [{ index: 0, files: [...SCOPE_SRC].sort(), excludeFiles: null }] } } }
  }
  ok("加/删注释 ⇒ 指纹不变（判绿）", judgeFingerprint([{ path: "fake.json", config: pCmt.config! }], toBaseline(pBase.config!)).status === "passed")
}

console.log("── ⑧ off 不入哈希 / warn 与 error 不同值 / 字面量与数字等价")
{
  const withOff = normalizedRules({ a: "error", b: "off", c: ["warn", 3] })
  const withoutOff = normalizedRules({ a: "error", c: ["warn", 3] })
  ok("加一条 off ⇒ 归一化结果全等（off 不入哈希）", JSON.stringify(withOff) === JSON.stringify(withoutOff))
  ok("'error' 与 2 等价", severity("error") === severity(2) && severity("error") === 2)
  ok("'warn' 与 1 等价、与 'warning' 等价", severity(1) === 1 && severity("warning") === 1)
  ok(
    "error → warn 归一化后确实不同（① 不是空转）",
    JSON.stringify(normalizedRules({ a: "error" })) !== JSON.stringify(normalizedRules({ a: "warn" })),
  )
  let threw = false
  try {
    severity("nonsense")
  } catch {
    threw = true
  }
  ok("认不出的严重级抛错（不静默当 off）", threw)
}

console.log("── ⑨ 顶层 rules 是基础层（新树形态：只有顶层、0 组 override）")
{
  const n = normalizedRules(mergeOverlay({ "max-depth": ["error", 4], complexity: ["error", 15] }, [], []))
  ok("顶层 rules 参与归一化（漏了这步新树指纹恒为空集）", Object.keys(n).length === 2)
  const fx: Fixture = { top: { "no-var": "error" }, overrides: [{ files: SCOPE_TEST, rules: { "no-var": "off" } }] }
  const merged = mergeOverlay(fx.top!, fx.overrides, [0])
  ok("override 覆盖顶层（顶层 error + override off ⇒ 该组不含该规则）", !("no-var" in normalizedRules(merged)))
}

console.log("── ⑩ 互斥射程必须分 profile：单聚合会漏检（本单的核心证据）")
{
  const fx = baseFx()
  const baseline = buildBaseline(fx, DUAL)
  const mut = baseFx()
  delete mut.overrides[1].rules["no-console"]
  // 反证：如果按官方那样单聚合（indexes=[0,1,2]），同一个变异**检不出来**
  const single = (f: Fixture) => {
    const n = normalizedRules(mergeOverlay(f.top ?? {}, f.overrides, [0, 1, 2]))
    return fingerprint(n)
  }
  ok("分 profile ⇒ 变异被抓住", red(judgeFingerprint([asConfig(mut)], baseline)))
  ok("单聚合 ⇒ 同一个变异指纹不变（照搬官方会装一格假门禁）", single(fx) === single(mut))
}

console.log("── ⑪ 射程签名：改 files / excludeFiles ⇒ 红（不是算出一个错数）")
{
  const fx = baseFx()
  const baseline = buildBaseline(fx, DUAL)
  const scopeChanged = baseFx()
  scopeChanged.overrides[1].excludeFiles = ["**/*.spec.ts"]
  const r = judgeFingerprint([asConfig(scopeChanged)], baseline)
  ok("改 excludeFiles ⇒ failed", red(r))
  ok("说法是「射程与登记不符」", joined(r).includes("射程"))

  const filesChanged = baseFx()
  filesChanged.overrides[2].files = ["forge-*/src/**/*.spec.ts"]
  ok("改 files ⇒ failed", red(judgeFingerprint([asConfig(filesChanged)], baseline)))

  const reorderedGroups = baseFx()
  const n = reorderedGroups.overrides[0]
  reorderedGroups.overrides[0] = reorderedGroups.overrides[1]
  reorderedGroups.overrides[1] = n
  ok("两组换位置 ⇒ failed（index 认位置，射程不认）", red(judgeFingerprint([asConfig(reorderedGroups)], baseline)))
}

console.log("── ⑫ 覆盖率：带规则的 override 不归属任何 profile ⇒ 红（静默漏检）")
{
  const fx = baseFx()
  // 只登记 ov0，ov1/ov2 谁都不管 ⇒ 改它们不会红
  const baseline = buildBaseline(fx, [{ profile: "only0", indexes: [0] }])
  const r = judgeFingerprint([asConfig(fx)], baseline)
  ok("有未归属的 override ⇒ failed", red(r))
  ok("两条未归属都点名了", (r.findings ?? []).length === 2 && joined(r).includes("#1") && joined(r).includes("#2"))
}

console.log("── ⑬ 缺输入一律不许判绿")
{
  ok("基线为 null ⇒ unjudged", judgeFingerprint([asConfig(baseFx())], null).status === "unjudged")
  ok("基线 0 个 profile ⇒ unjudged（不是 passed）", judgeFingerprint([asConfig(baseFx())], { profiles: {} }).status === "unjudged")
  const fx = baseFx()
  const baseline = buildBaseline(fx, DUAL)
  const missing = judgeFingerprint([], baseline)
  ok("配置读不到 ⇒ failed + 点名", red(missing) && joined(missing).includes("读不到"))
  const badCfg = judgeFingerprint([{ path: "fake.json", config: null, error: "boom" }], baseline)
  ok("配置解析失败 ⇒ failed + 带原因", red(badCfg) && joined(badCfg).includes("boom"))
}

console.log("── ⑭ 真配置文件：仓库里那两份 JSONC 都解析得开")
{
  for (const rel of [".oxlintrc.json", ".oxlintrc.next.json"]) {
    const abs = path.join(REPO, rel)
    const parsed = parseJsonc(ts, fs.readFileSync(abs, "utf8"))
    ok(`${rel} 解析成功`, parsed.config !== undefined)
  }
  const nextCfg = parseJsonc(ts, fs.readFileSync(path.join(REPO, ".oxlintrc.next.json"), "utf8"))
  const nextN = normalizedRules(mergeOverlay((nextCfg.config!.rules as Record<string, unknown>) ?? {}, [], []))
  ok("新树配置（只有顶层 rules）归一化出 3 条非空", Object.keys(nextN).length === 3)
}

console.log(`\n${fails === 0 ? "✓" : "✗"} spec ${fails === 0 ? "全过" : `失败 ${fails} 条`}（${total} 条断言：五类变异 + 互斥射程 + 射程签名 + 覆盖率 + 缺输入 + 真配置）`)
export function run(): boolean {
  return fails === 0
}
