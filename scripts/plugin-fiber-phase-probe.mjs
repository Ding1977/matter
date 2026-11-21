#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
//  这是**探针**，不是门禁。
//  · 不参与 CI、不拦任何人、失败也不代表谁做错了
//  · 它回答的唯一问题：`pluginInventory/list` 的 `fiberPhase` 在四种装载情形下到底取值什么
//  · 想加门禁请另开单 —— 今晚已经有太多「看着像守卫其实没人跑」的东西，别再往这里加
// ═══════════════════════════════════════════════════════════════════════════════
//
// 为什么要有它（ISS-682）：`fiberPhase` 的语义原来只能靠猜。2026-11-02 08:53 的事故里
//   「配置有行、模块能解析、导出齐全，但 apply() 一次没跑」在界面上到底长什么样？猜不出来。
//   本探针用一个**隔离进程**（不碰 3210、不写任何 config）把真 loader 跑起来，再造四种情形：
//
//     probe-ok        正常 apply                    ⇒ 预期 enabled=true  fiberPhase="active"
//     probe-ok        加 disabled: true             ⇒ 预期 enabled=false fiberPhase=null
//     probe-boom      apply 抛错                    ⇒ 预期 enabled=true  fiberPhase="failed"
//     probe-dangling  inject 一个没人提供的服务      ⇒ 预期 enabled=true  fiberPhase="pending"
//                                                      （apply 一次没跑 = 事故形态）
//
//   还跑一次**回切**：active → disabled → enabled，确认关掉再打开能回到 active。
//
// 读的是真的官方投影函数 `readPluginInventory`（`@deepseek-ai/dsh-host-plugin-inventory`），
//   不是本仓自己再写一遍映射表 —— 那等于用猜测验证猜测。
//
// 用法：
//   DSH_HOME=~/.dsh-matter node scripts/plugin-fiber-phase-probe.mjs
//   （必须给 DSH_HOME：插件模块从它的 profiles/node_modules 解析。不给就报错退出，不猜路径）
//
// 退出码：0 = 四种情形与预期一致 · 1 = 有偏差或有情形没造出来（会逐条点名）

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const DSH_HOME = process.env.DSH_HOME
if (!DSH_HOME) {
  console.error("✗ 缺 DSH_HOME —— 探针要从 $DSH_HOME/profiles/node_modules 解析插件模块")
  console.error("  例：DSH_HOME=~/.dsh-matter node scripts/plugin-fiber-phase-probe.mjs")
  process.exit(2)
}

// 模块解析：**要那套「宿主正在跑的」代码**，否则验证的是另一份实现。
// 候选按顺序试（都不写死用户路径）：
//   ① $DSH_PROBE_MODULES（显式指定一个 node_modules 根）
//   ② $DSH_HOME/profiles/node_modules（profile 自己的解析面）
//   ③ 当前工作目录的 node_modules（在宿主安装目录里跑时命中，如 ~/dsh-local）
const CANDIDATES = [
  process.env.DSH_PROBE_MODULES,
  join(DSH_HOME, "profiles/node_modules"),
  join(process.cwd(), "node_modules"),
].filter((dir) => typeof dir === "string" && dir.length > 0)

const moduleAt = (root, pkg) => join(root, "@deepseek-ai", pkg)

/** 找到第一个真的有这三个包的根；找不到就说清楚怎么办。 */
function findModulesRoot() {
  for (const root of CANDIDATES) {
    if (existsSync(moduleAt(root, "dsh-host-plugin-inventory/lib/index.js"))) return root
  }
  console.error("✗ 没找到 DSH 宿主模块（@deepseek-ai/dsh-host-plugin-inventory）。试过的根：")
  for (const root of CANDIDATES) console.error(`   · ${root}`)
  console.error("  办法：在宿主安装目录里跑本探针，或设 DSH_PROBE_MODULES=<宿主 node_modules 路径>")
  process.exit(2)
}

const NM = findModulesRoot()
const modUrl = (pkg) => pathToFileURL(moduleAt(NM, `${pkg}/lib/index.js`)).href
const versionOf = (pkg) => JSON.parse(readFileSync(moduleAt(NM, `${pkg}/package.json`), "utf8")).version

let Context, Loader, readPluginInventory
try {
  ;({ Context } = await import(modUrl("cordis")))
  ;({ default: Loader } = await import(modUrl("cordis-plugin-loader")))
  const inventoryModule = await import(modUrl("dsh-host-plugin-inventory"))
  readPluginInventory = inventoryModule.readPluginInventory
  if (typeof readPluginInventory !== "function") {
    // 0.1.x 没有导出这个内部函数（只有 Gateway）；投影逻辑就得自己复刻 —— 那等于用猜测验证猜测，不做。
    console.error(`✗ 这份 dsh-host-plugin-inventory（${versionOf("dsh-host-plugin-inventory")}）没有导出 readPluginInventory。`)
    console.error("  本探针**刻意不自己复刻映射表**（那样验的是本仓的猜测，不是官方行为）。")
    console.error("  办法：指到宿主实际用的那份，例：DSH_PROBE_MODULES=~/dsh-local/node_modules")
    process.exit(2)
  }
} catch (error) {
  console.error(`✗ 解析插件模块失败（根=${NM}）：${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

// ── 夹具：三个临时插件，覆盖「正常 / 抛错 / 缺依赖」三种 apply 形态 ──────────────
const WORK = mkdtempSync(join(tmpdir(), "fiber-phase-probe-"))
const write = (name, body) => writeFileSync(join(WORK, name), body, "utf8")
// 空的 apply 就够：三行夹具共用同一个模块，**不许有副作用**（provide 同名服务会互相冲突 ⇒ 误判 failed）
write("probe-ok.mjs", "export const name = 'probe-ok'\nexport function apply(ctx) { void ctx }\n")
write("probe-boom.mjs", "export const name = 'probe-boom'\nexport function apply() { throw new Error('apply throws on purpose') }\n")
write(
  "probe-dangling.mjs",
  "export const name = 'probe-dangling'\nexport const inject = ['serviceThatNobodyProvides']\nexport function apply() { /* never runs: dependency missing */ }\n",
)

const tick = (ms) => new Promise((done) => setTimeout(done, ms))

const ctx = new Context()
await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(WORK, "probe.mjs")).href })
await tick(100)
const loader = ctx.get("loader")
if (loader === undefined) {
  console.error("✗ loader 服务没起来 —— 探针环境不对，后面的结论都不作数")
  process.exit(2)
}

/** 一次读数：只挑本探针要看的字段（entryId / enabled / fiberPhase）。 */
async function readEntries() {
  const inventory = await readPluginInventory(ctx)
  return inventory.entries.map((entry) => ({
    entryId: entry.entryId,
    enabled: entry.enabled,
    fiberPhase: entry.fiberPhase,
  }))
}

const results = []
const expectRow = (label, actual, expected, why) => {
  const ok = actual?.enabled === expected.enabled && actual?.fiberPhase === expected.fiberPhase
  results.push({ label, ok, actual, expected, why })
}

// ── 四种情形：一次性造齐，然后读一次真投影 ──────────────────────────────────
for (const spec of [
  { id: "ok", name: "./probe-ok.mjs" },
  { id: "disabled", name: "./probe-ok.mjs", disabled: true },
  { id: "boom", name: "./probe-boom.mjs" },
  { id: "dangling", name: "./probe-dangling.mjs" },
]) {
  try {
    await loader.create(spec)
  } catch (error) {
    // `probe-boom` 的 apply **故意**抛错 ⇒ create 会 reject，但这行 entry 仍然在（fiber 记为 failed）。
    // 那正是要观测的第 3 种情形，所以只记账不退出；其余失败才算环境不对。
    if (spec.id !== "boom") {
      console.error(`✗ 造不出 ${spec.id}：${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }
}
await tick(500)

const rows = await readEntries()
const byId = (id) => rows.find((row) => row.entryId === id)

expectRow('正常 apply', byId("ok"), { enabled: true, fiberPhase: "active" }, "装上了且在跑")
expectRow("disabled: true", byId("disabled"), { enabled: false, fiberPhase: null }, "关了 —— 注意 fiberPhase 是 null，不是 active")
expectRow("apply 抛错", byId("boom"), { enabled: true, fiberPhase: "failed" }, "启动了但失败")
expectRow(
  "inject 缺依赖（apply 一次没跑）",
  byId("dangling"),
  { enabled: true, fiberPhase: "pending" },
  "★ 事故形态：配置有行、模块能解析，但 apply 没跑 ⇒ enabled=true 且 pending",
)

// ── 回切：active → disabled → enabled（pluginManager.setPluginEnabled 走的同一路径）──
try {
  await loader.create({ id: "roundtrip", name: "./probe-ok.mjs" })
  await tick(300)
  const before = (await readEntries()).find((row) => row.entryId === "roundtrip")
  await loader.update("roundtrip", { disabled: true })
  await tick(300)
  const off = (await readEntries()).find((row) => row.entryId === "roundtrip")
  await loader.update("roundtrip", { disabled: false })
  await tick(300)
  const back = (await readEntries()).find((row) => row.entryId === "roundtrip")

  results.push({
    label: "回切 active → disabled → enabled",
    ok: before?.fiberPhase === "active" && off?.fiberPhase === null && off?.enabled === false && back?.fiberPhase === "active",
    actual: { before, off, back },
    expected: { before: "active", off: "false/null", back: "active" },
    why: "改 disabled 之后能改回来，且回来仍是 active",
  })
} catch (error) {
  results.push({
    label: "回切 active → disabled → enabled",
    ok: false,
    actual: { error: error instanceof Error ? error.message : String(error) },
    expected: { before: "active", off: "false/null", back: "active" },
    why: "回切没跑通",
  })
}

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log(`\nfiberPhase 探针（真 loader + 真 readPluginInventory，隔离进程）`)
console.log(`模块取自 ${NM}（cordis ${versionOf("cordis")} · inventory ${versionOf("dsh-host-plugin-inventory")}）\n`)
for (const item of results) {
  console.log(`${item.ok ? "✓" : "✗"} ${item.label}`)
  console.log(`   实际   ${JSON.stringify(item.actual)}`)
  if (!item.ok) console.log(`   预期   ${JSON.stringify(item.expected)}`)
  console.log(`   含义   ${item.why}`)
}
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 与预期一致${failed.length ? " —— 有偏差，见上" : ""}`)
console.log("（探针不是门禁：它只回答取值集合，不拦任何人）\n")

rmSync(WORK, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
