// 别名登记表的判据（ISS-715 甲案 · 2026-09-23；第二批把 C9b 也纳进来）
//
// 「别名不登记就是渗漏，登记了就是契约」—— 这张表（`scripts/baseline/route-aliases.json`）是人写的**契约记录**，
// 本脚本是它的牙：**只读已落盘的两份产物**（路由明细 `route-literals.json` + 度量基线 `code-inventory.json`），
// 不重跑扫描 ⇒ 与 audit-doc-sync 同档（微秒级，可常驻 guard）。
//
// 判据（每条都有独立红路径，`--selftest` 用合成夹具逐条验）：
//   ① 登记了的必须真的还在：`measured` 里声明的每个来源，都要能在路由明细里找到该 path；
//      没有按 C9/C9b 口径计量的条目（别名/外部契约）必须给 `evidencePrefix`，且它要在 C8 的前缀清单里 —— 否则是**化石**。
//   ② 计量到的必须都登记过：`sameHalf` 与 `crossPkg` 两张名单里的每条 path 都要有登记项（且声明了对应来源）—— 否则是**漏登**。
//   ③ 消费方不许漂：登记项声明的消费方必须与计量出来的**集合相等**（顺序无关）——
//      sameHalf 对 `halves`（如 client:3），crossPkg 对 `pkgs`（含正源自己）。源码里多/少一处引用，这里必须跟着改。
//   ④ 表自身的形状：id 唯一、必填字段在、kind 合法（防手滑把一份契约写成半截）。
//
// 退出码：0 = 全绿 · 1 = 有红 · 2 = 自身异常（产物缺失等）
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const REG = path.join(ROOT, "scripts", "baseline", "route-aliases.json")
const LEDGER = path.join(ROOT, "scripts", "baseline", "route-literals.json")
const INVENTORY = path.join(ROOT, "scripts", "baseline", "code-inventory.json")
const KINDS = new Set(["copied-path", "cross-pkg", "dual-prefix", "external-contract", "cross-bundle-pair"])
const REQUIRED = ["id", "kind", "path", "owner", "measured", "reason", "retire"]
/** 三个来源 → 从 route-literals.json 的哪张名单里取"消费方" */
const SOURCE_OF = {
  sameHalf: { list: "sameHalf", field: "halves", what: "同半区抄写的半区与处数" },
  crossPkg: { list: "crossPkg", field: "pkgs", what: "跨包抄写涉及的包（含正源自己）" },
  // ⚠️ 这条来源是**双向**的：登记表里 kind=cross-bundle-pair 的条目本身就是 C9 的豁免名单（`loadCrossBundleBaseline` 读本表）。
  //    所以 ③ 的"漂移比对"对它而言是同源自流（恒等，别把它当牙），**真正有牙的是 ①**：
  //    源码实际文件集合与登记不符 ⇒ 那条 path 从 crossBundleAssets 掉进 staleCrossBundle ⇒ 本表立刻报"化石"。
  crossBundle: { list: "crossBundleAssets", field: "files", what: "跨 bundle 成对的两个文件（恰好匹配 = C9 免计的那一份）" },
}

/** C8 的路径前缀清单（外部契约/别名这类不按 C9/C9b 口径计量的条目，用它做"还在不在"的证据） */
function c8Prefixes(inventory) {
  const m = (inventory.metrics || []).find((x) => x.id === "C8")
  const out = new Set()
  for (const o of (m && m.offenders) || []) if (o && typeof o.k === "string") out.add(o.k)
  return out
}
/** 按来源取"实测的消费方集合" */
function measuredOf(ledger, source) {
  const src = SOURCE_OF[source]
  const list = (ledger[src.list] || []).filter((x) => x && typeof x.p === "string")
  return new Map(list.map((x) => [x.p, (x[src.field] || []).map(String)]))
}
const setEq = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

/** 核心比对：返回违例行（空 = 一致）。纯函数 ⇒ 自检夹具不必碰真文件 */
function diff(registry, ledger, inventory) {
  const bad = []
  const entries = Array.isArray(registry.entries) ? registry.entries : []
  const prefixes = c8Prefixes(inventory)
  // 每个来源：path → 实测消费方
  const measured = Object.fromEntries(Object.keys(SOURCE_OF).map((s) => [s, measuredOf(ledger, s)]))

  // ④ 形状
  const seen = new Set()
  for (const [i, e] of entries.entries()) {
    // 坏条目先报出来：判据在畸形输入上崩掉，比报红更糟（夹具就是这么把 --selftest 打崩过一次）
    if (!e || typeof e !== "object") { bad.push(`第 ${i + 1} 条不是对象（登记表被改坏了）`); continue }
    for (const k of REQUIRED) if (e[k] === undefined) bad.push(`第 ${i + 1} 条缺字段 ${k}（id=${e.id || "?"}）`)
    if (e.id) { if (seen.has(e.id)) bad.push(`id 重复：${e.id}`); seen.add(e.id) }
    if (e.kind && !KINDS.has(e.kind)) bad.push(`kind 非法：${e.id} = ${e.kind}（合法：${[...KINDS].join(" / ")}）`)
    if (e.measured && typeof e.measured !== "object") bad.push(`measured 必须是对象（来源 → 消费方数组）：${e.id}`)
    for (const s of Object.keys(e.measured || {})) {
      if (!SOURCE_OF[s]) bad.push(`measured 里出现未知来源 ${s}：${e.id}（合法来源：${Object.keys(SOURCE_OF).join(" / ")}）`)
    }
  }
  // ① 化石
  for (const e of entries) {
    if (!e || typeof e !== "object") continue
    const srcs = Object.keys(e.measured || {})
    if (srcs.length === 0) {
      const pfx = e.evidencePrefix
      if (!pfx) bad.push(`① ${e.id} 没有任何 measured 来源 ⇒ 必须给 evidencePrefix（拿什么证明它还在）`)
      else if (!prefixes.has(pfx)) bad.push(`① 化石：${e.id} 的 evidencePrefix ${pfx} 已不在 C8 前缀清单里`)
      continue
    }
    for (const s of srcs) {
      const mm = measured[s]
      if (!mm) continue // 未知来源已由 ④ 报出；这里不重复报，更不能崩（判据在畸形输入上崩掉比报红更糟）
      if (!mm.has(e.path)) bad.push(`① 化石：${e.id} 声明来源 ${s}，但 ${e.path} 已不在该来源的名单里`)
    }
  }
  // ② 漏登（两张名单都要有主）
  for (const s of Object.keys(SOURCE_OF)) {
    const declared = new Set(entries.filter((e) => e && typeof e === "object" && e.measured && Object.prototype.hasOwnProperty.call(e.measured, s)).map((e) => e.path))
    for (const p of measured[s].keys()) {
      if (!declared.has(p)) bad.push(`② 漏登：${s} 名单里的 ${p} 没有任何登记项声明这个来源（渗漏没变成契约）`)
    }
  }
  // ③ 消费方漂移
  for (const e of entries) {
    if (!e || typeof e !== "object") continue
    for (const s of Object.keys(e.measured || {})) {
      const m = measured[s] && measured[s].get(e.path)
      if (!m) continue // ① 已报（未知来源也已由 ④ 报过）
      const claimed = (e.measured[s] || []).map(String)
      if (!setEq(m, claimed)) bad.push(`③ 消费方漂了：${e.path}（${s}）登记 [${claimed.join(" ")}] ≠ 计量 [${m.join(" ")}]`)
    }
  }
  return bad
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")) }

if (process.argv.includes("--selftest")) {
  const ledger = {
    sameHalf: [{ p: "/a", halves: ["client:2"] }, { p: "/b", halves: ["host:1"] }],
    crossPkg: [{ p: "/a", pkgs: ["p1", "p2"] }, { p: "/c", pkgs: ["p1", "scripts"] }],
    crossBundleAssets: [{ p: "/x", files: ["p1/src/a.ts", "p1/src/b.ts"] }],
  }
  const inv = { metrics: [{ id: "C8", offenders: [{ k: "/plans" }] }] }
  const base = () => ({
    entries: [
      { id: "e-a", kind: "cross-pkg", path: "/a", owner: "p1", measured: { sameHalf: ["client:2"], crossPkg: ["p1", "p2"] }, reason: "r", retire: "t" },
      { id: "e-b", kind: "copied-path", path: "/b", owner: "p1", measured: { sameHalf: ["host:1"] }, reason: "r", retire: "t" },
      { id: "e-c", kind: "cross-pkg", path: "/c", owner: "p1", measured: { crossPkg: ["p1", "scripts"] }, reason: "r", retire: "t" },
      { id: "e-plans", kind: "external-contract", path: "/plans", owner: "m", measured: {}, evidencePrefix: "/plans", reason: "r", retire: "t" },
      { id: "e-xb", kind: "cross-bundle-pair", path: "/x", owner: "p1", measured: { crossBundle: ["p1/src/a.ts", "p1/src/b.ts"] }, reason: "两个独立 bundle 各写一次", retire: "不删" },
    ],
  })
  const cases = [
    ["阳性对照：五类条目各按口径登记 ⇒ 0 处", diff(base(), ledger, inv).length === 0],
    ["阳性对照（跨 bundle 成对登记且对得上）⇒ 不报", diff(base(), ledger, inv).every((l) => !l.includes("/x"))],
    ["① 化石（登记的成对与源码集合对不上 ⇒ path 掉出 crossBundleAssets）⇒ 红", (() => { const l = { ...ledger, crossBundleAssets: [] }; return diff(base(), l, inv).some((x) => x.includes("化石") && x.includes("crossBundle")) })()],
    ["② 漏登（C9 免计了一条却在登记表里没主）⇒ 红", (() => { const r = base(); r.entries = r.entries.filter((e) => e.path !== "/x"); return diff(r, ledger, inv).some((l) => l.includes("漏登") && l.includes("/x")) })()],
    ["① 化石（sameHalf 声明了但源码里没了）⇒ 红", (() => { const r = base(); r.entries = r.entries.filter((e) => e.path !== "/b").concat([{ id: "e-x", kind: "copied-path", path: "/gone", owner: "p", measured: { sameHalf: ["host:1"] }, reason: "r", retire: "t" }]); return diff(r, ledger, inv).some((l) => l.includes("化石")) })()],
    ["④ 坏条目（不是对象）⇒ 报出来而不是崩", (() => { const r = base(); r.entries = [...r.entries, null]; return diff(r, ledger, inv).some((l) => l.includes("不是对象")) })()],
    ["① 化石（外部契约前缀不在 C8）⇒ 红", (() => { const r = base(); r.entries[3].evidencePrefix = "/nope"; return diff(r, ledger, inv).some((l) => l.includes("化石")) })()],
    ["① 无 measured 又无 evidencePrefix ⇒ 红", (() => { const r = base(); delete r.entries[3].evidencePrefix; return diff(r, ledger, inv).some((l) => l.includes("evidencePrefix")) })()],
    ["② 漏登（crossPkg 的 /c 没人声明该来源）⇒ 红", (() => { const r = base(); r.entries = r.entries.filter((e) => e.path !== "/c"); return diff(r, ledger, inv).some((l) => l.includes("漏登")) })()],
    ["② 漏登（同一条 path 只声明了 sameHalf、没声明 crossPkg）⇒ 红", (() => { const r = base(); r.entries[0].measured = { sameHalf: ["client:2"] }; return diff(r, ledger, inv).some((l) => l.includes("漏登") && l.includes("crossPkg")) })()],
    ["③ 消费方多写一处 ⇒ 红", (() => { const r = base(); r.entries[0].measured.sameHalf = ["client:3"]; return diff(r, ledger, inv).some((l) => l.includes("消费方漂了")) })()],
    ["③ 顺序不同但集合相同 ⇒ 绿（不许把顺序当漂移）", (() => { const r = base(); r.entries[0].measured.crossPkg = ["p2", "p1"]; return diff(r, ledger, inv).length === 0 })()],
    ["④ id 重复 ⇒ 红", (() => { const r = base(); r.entries[1].id = "e-a"; return diff(r, ledger, inv).some((l) => l.includes("id 重复")) })()],
    ["④ 缺必填字段 ⇒ 红", (() => { const r = base(); delete r.entries[1].retire; return diff(r, ledger, inv).some((l) => l.includes("缺字段 retire")) })()],
    ["④ 未知来源 ⇒ 红", (() => { const r = base(); r.entries[1].measured = { sameHalves: ["host:1"] }; return diff(r, ledger, inv).some((l) => l.includes("未知来源")) })()],
    ["④ kind 写错 ⇒ 红", (() => { const r = base(); r.entries[1].kind = "whatever"; return diff(r, ledger, inv).some((l) => l.includes("kind 非法")) })()],
  ]
  let fail = 0
  console.log("route-alias-check --selftest（合成夹具，不碰真产物）")
  for (const [n, ok] of cases) { console.log(`  ${ok ? "✓" : "✗"} ${n}`); if (!ok) fail++ }
  console.log(fail ? `\n✗ 反向验证失败 ${fail}/${cases.length}` : `\n✓ ${cases.length}/${cases.length} 项通过：化石/漏登/漂移/形状四条红路径都能红，阳性对照与"顺序不算漂移"不误伤`)
  process.exit(fail ? 1 : 0)
}

for (const f of [REG, LEDGER, INVENTORY]) {
  if (!fs.existsSync(f)) { console.error(`✗ 缺产物：${path.relative(ROOT, f)}（先跑一次复录）`); process.exit(2) }
}
const reg = readJson(REG)
const bad = diff(reg, readJson(LEDGER), readJson(INVENTORY))
const ledger = readJson(LEDGER)
if (bad.length) {
  console.log(`✗ 别名登记表与事实不符（${bad.length} 处 · ISS-715）`)
  for (const b of bad.slice(0, 12)) console.log(`   · ${b}`)
  if (bad.length > 12) console.log(`   · …另有 ${bad.length - 12} 处`)
  process.exit(1)
}
console.log(`✓ 别名登记表与事实一致（${reg.entries.length} 条登记 · sameHalf ${ledger.sameHalf.length} 条 + crossPkg ${ledger.crossPkg.length} 条全部登记且消费方对得上）`)
