#!/usr/bin/env node
// Matter 打包插件端口守卫（ISS-592）
//
// ## 要治的病
// `plugins/matter/.zcode-plugin/plugin.json` 是**分发物**（zcode 用户拿它连 Matter），
// 它的 `mcpServers.matter.env.MATTER_BASE` 曾长期写死 `http://127.0.0.1:3220` ——
// 而 3220 是 **Electron exec 桥**的端口（`electron-shell/main.js` 的 `FORGE_EXEC_PORT`），
// 从来不是 Matter 宿主。宿主早就是 3210（`scripts/restart-matter.sh: PORT="${MATTER_PORT:-3210}"`）。
// ⇒ 拿这个插件的人，8 个 MCP 工具一调就 404，而他看到的永远是「工具不存在」。
//
// ## 为什么守卫要读 restart-matter.sh 而不是再写一个 3210
// 写死两份 = 下次换宿主照样漂，而且**漂的那份一定是没人看的这份**。本脚本从宿主启动脚本里
// 抠出默认端口，让「活宿主」只有一个真相源；`MATTER_PORT` 环境变量覆盖它（与启动脚本同口径）。
//
// ## fail-closed
// 抠不到默认端口（启动脚本改了写法）⇒ **判红并说清「判据失效」**，不是静默通过。
// 抓不到数的闸恒绿，正是 ISS-818 那一族事故的形状。
//
// 用法：node scripts/check-matter-plugin-port.mjs [--json]
// 退出码：0 = 一致 / 1 = 不一致或判据失效 / 2 = 用法错

import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const PLUGIN = path.join(ROOT, "plugins", "matter", ".zcode-plugin", "plugin.json")
const HOST_SCRIPT = path.join(ROOT, "scripts", "restart-matter.sh")
const AS_JSON = process.argv.includes("--json")

/**
 * 已退役 / 从不是 Matter 宿主的端口。出现即红，即使它"恰好"等于某个环境变量。
 * 3220：Electron exec 桥（`electron-shell/main.js: FORGE_EXEC_PORT = 3220`）—— 与 Matter 无关，
 *       当年就是把它误当 Matter 宿主才写出这条错配置。
 */
const NEVER_MATTER_HOST = new Set([3220])

const problems = []
const notes = []
const red = (m) => problems.push(m)

/** 从宿主启动脚本抠默认端口。抠不到 ⇒ 判据失效（红），不猜。 */
function hostPortFromScript() {
  let src
  try {
    src = fs.readFileSync(HOST_SCRIPT, "utf8")
  } catch (err) {
    red(`读不到宿主启动脚本 ${path.relative(ROOT, HOST_SCRIPT)}：${(err && err.message) || err} —— 判据失效（不是"通过"）`)
    return null
  }
  // 形状（restart-matter.sh:19）：PORT="${MATTER_PORT:-3210}"
  const m = src.match(/PORT="\$\{(MATTER_PORT|DSH_PROD_PORT):-(\d{2,5})\}"/)
  if (!m) {
    red(
      `判据失效：${path.relative(ROOT, HOST_SCRIPT)} 里找不到 \`PORT="\${MATTER_PORT:-<端口>}"\` 形状。` +
        `启动脚本改了写法 ⇒ 本守卫跟着失效，必须同步修本文件，**不得**改成静默通过。`,
    )
    return null
  }
  return { port: Number(m[2]), from: `${path.relative(ROOT, HOST_SCRIPT)} 的 \${${m[1]}:-${m[2]}}` }
}

/** 读打包产物里的 MATTER_BASE 端口。 */
function pluginPort() {
  let raw
  try {
    raw = fs.readFileSync(PLUGIN, "utf8")
  } catch (err) {
    red(`读不到打包产物 ${path.relative(ROOT, PLUGIN)}：${(err && err.message) || err} —— 判据失效`)
    return null
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch (err) {
    red(`打包产物不是合法 JSON：${(err && err.message) || err}`)
    return null
  }
  const base = json?.mcpServers?.matter?.env?.MATTER_BASE
  if (typeof base !== "string" || !base.trim()) {
    red(`打包产物里没有 mcpServers.matter.env.MATTER_BASE（插件连不上任何宿主）`)
    return null
  }
  let u
  try {
    u = new URL(base.trim())
  } catch {
    red(`MATTER_BASE 不是合法 URL：${base}`)
    return null
  }
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80))
  return { port, base: base.trim(), host: u.hostname }
}

const host = hostPortFromScript()
// `MATTER_PORT` 覆盖（与 restart-matter.sh 同口径）；给了就用它，并记一笔让读者知道判的是哪个值
const envPort = String(process.env.MATTER_PORT || "").trim()
const expected = envPort ? Number(envPort) : host?.port ?? null
if (envPort && !Number.isFinite(expected)) {
  red(`环境变量 MATTER_PORT="${process.env.MATTER_PORT}" 不是端口数字 —— 判据失效`)
}
if (envPort && host && Number(envPort) !== host.port) {
  notes.push(`MATTER_PORT=${envPort} 覆盖了启动脚本默认值 ${host.port}（本判据按环境变量判）`)
}

const plugin = pluginPort()

if (Number.isFinite(expected) && plugin) {
  if (plugin.port !== expected) {
    red(
      `端口不一致：打包产物指向 ${plugin.port}，活宿主是 ${expected}（来源：${host?.from ?? `MATTER_PORT=${envPort}`}）。` +
        `\n  拿这个插件的人每个工具都会 404。改 ${path.relative(ROOT, PLUGIN)} 的 MATTER_BASE 端口。`,
    )
  }
  if (NEVER_MATTER_HOST.has(plugin.port)) {
    red(
      `打包产物指向 ${plugin.port} —— 该端口**从不是 Matter 宿主**（3220 是 Electron exec 桥）。` +
        `这条配置本身是把两个东西搞混的产物，不是"旧值"：就算宿主哪天搬过去，也不该靠它。`,
    )
  }
  if (plugin.host !== "127.0.0.1" && plugin.host !== "localhost") {
    notes.push(`MATTER_BASE 主机是 ${plugin.host}（本仓其余地方一律 127.0.0.1）—— 若不是有意为之，应改回环回地址`)
  }
  if (plugin.port === expected && !NEVER_MATTER_HOST.has(plugin.port)) {
    notes.push(`一致：打包产物 ${plugin.port} == 活宿主 ${expected}`)
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ ok: problems.length === 0, expected, plugin, problems, notes }, null, 2))
} else {
  for (const n of notes) console.log(`· ${n}`)
  for (const p of problems) console.error(`✗ ${p}`)
  if (!problems.length) console.log(`✓ Matter 打包插件端口与活宿主一致（${expected}）`)
}
process.exit(problems.length === 0 ? 0 : 1)
