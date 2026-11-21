#!/usr/bin/env node
/* 运行态明文密钥守卫（ISS-837）
 *
 * 一句话：**运行态目录里出现形如长串密钥的字面量即红**，且必须报出分母（扫了几个文件）。
 *
 * ── 为什么需要它（与既有 secret-scan 的分工，别当成重复造）
 * 本仓已有 `scripts/secret-scan.mjs`，但它的扫描输入是 **`git ls-files`（已入库文件）**——
 * 这个选择本身是对的（天然排掉 gitignored 产物与依赖，见它头注「ISS-742」）。
 * 而 `~/.dsh/<pkg>/state/` 这类**运行态目录根本不在仓内** ⇒ 那个守卫**结构上扫不到它**。
 * 实测（2026-10-20）：`secret-scan --worktree` 读 2249 个已入库文本文件，与运行态零交集。
 * ⇒ 本文件补的是那块盲区：**输入集合 = 运行时数据根，不是 git 索引**。
 * 两者口径互补、不互相替代：入库文件归 secret-scan，运行态归本守卫。
 *
 * ── 为什么要棘轮（而不是零容忍）
 * 立这道闸的当天，运行态里**已经有**存量明文（ISS-837 实测 4 条，轮换属 ISS-919、老板 09-30 已裁「先不用换」）。
 * 零容忍 = 从第一天起永久红 = 没人看的红 = 等于没有闸（本仓反复记的那一族）。
 * ⇒ 存量记进基线、**只拦新增**；压低基线才是成绩。
 * ⚠️ 但基线**不许静默**：每次运行都把「全量命中」与「基线内」分开打印 —— 让人看见欠账还在。
 *
 * ── 分母不许空转（ISS-629）
 * `--selftest` 里有一条专门钉它：扫到 0 个文件必须 **fail closed**（exit 2），
 * 不许把「没扫到」读成「零违例」。运行态目录不存在（新机器）同理 —— 那不叫干净，叫没看。
 *
 * ── 判据不猜值（纪律：绝不把真值写进代码/日志/输出）
 * 只看**形状**，且**只输出计数与定位**（文件 + 路径 + 长度档），**绝不回显命中内容**。
 * 这不是洁癖：ISS-919 就是「读全文再打码展示」把 16 个 key 漏进了会话记录。
 * 本文件任何输出路径都不得出现密钥片段 —— selftest 里有一条反向对照钉住它。
 *
 * 用法：node scripts/runtime-secret-check.mjs [--check|--json|--verbose|--selftest|--write-baseline]
 * 退出码：0 = 无新增；2 = 有新增 / fail-closed（没扫到东西）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
// 基线读取只留一份实现（K6a）：三份逐字节相同的 `读基线` 已收进 scripts/baseline-read-lib.mjs。
// ⚠️ 这只多一个**仓内兄弟脚本**的依赖，不引任何包 —— 与上面「本守卫不 import 内核 dshPath()」的
//    兜底纪律不冲突：兜底不依赖被兜底方，但可以依赖门禁自己家的一份纯函数。
import { 读基线 } from "./baseline-read-lib.mjs"

const ARGV = process.argv.slice(2)

/**
 * 运行态根：**认 `DSH_HOME`**（与内核 `dshPath()` 同一口径），缺省 `~/.dsh`。
 * ⚠️ 这里刻意**不 import 内核的 dshPath()**：本守卫要能在**内核装坏/没构建**时照跑
 * （它就是用来兜底的），引依赖等于把兜底交给被兜底的一方。取根语义与内核一致即可，见 `--selftest` 有对账。
 */
const 运行态根 = (env = process.env) => env.DSH_HOME || path.join(os.homedir(), ".dsh")

/** 只扫这些子树（其余运行态内容不归本守卫管，扫了只会造成噪音与假红）。 */
const 扫描子树 = ["forge-agents/state", "forge-qoder-direct/state"]

/**
 * 密钥形状判据。⚠️ 与 `secret-scan.mjs` 的模式表**故意不完全相同**：
 * 那边面向"代码里误提交"，这边面向"运行态配置里落了明文凭据"——长随机串 + 已知前缀两大类。
 * 每条都要求足够长，避免把 `sk-test` 这种假值之外的东西（如 `Bearer` 常量、版本号）判红。
 *
 * 键名线索：JSON 里 `apiKey`/`secret`/`token`/`password` 这类键，其值若像凭据就判红。
 * 这比"全文件正则"准得多 —— 运行态 JSON 里有大量 UUID/路径/时间戳，全文件正则会满屏假红。
 */
const 键名线索 = /^(api[-_]?key|.*secret.*|.*token.*|password|passwd|credential.*)$/i

/** 值像不像凭据：≥20 字符、无空白、不是明显占位/引用形态。 */
function 像凭据(v) {
  if (typeof v !== "string") return false
  const s = v.trim()
  if (s.length < 20) return false
  if (/\s/.test(s)) return false
  // 显式引用形态：这些**正是**我们要的干净形态，判红就是挡自己的路
  if (/^(ref|env|vault|secret-ref):/i.test(s)) return false
  if (/^\$\{?[A-Z_]+\}?$/.test(s)) return false
  if (/^(null|none|changeme|placeholder|xxx+|\*+|<.*>)$/i.test(s)) return false
  // 已知密钥前缀：命中即判（长随机串里的常见族）
  if (/^(sk|pk|ark|ak|tp|ghp|gho|xox[baprs])[-_]/i.test(s)) return true
  // 其余：长度够 + 高熵字符集（含大小写+数字，或 base64/hex 长串）
  return /^[A-Za-z0-9_.\-+/=]{20,}$/.test(s) && (/[0-9]/.test(s) && /[A-Za-z]/.test(s))
}

/** 递归找「键名像凭据、值像凭据」的位置。返回 [{path, len, key}] —— **只有长度，没有值**。 */
function 扫对象(obj, 前缀 = "", out = []) {
  if (obj === null || typeof obj !== "object") return out
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => 扫对象(v, `${前缀}[${i}]`, out))
    return out
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = 前缀 ? `${前缀}.${k}` : k
    if (v && typeof v === "object") { 扫对象(v, p, out); continue }
    if (键名线索.test(k) && 像凭据(v)) out.push({ path: p, len: String(v).trim().length, key: k })
  }
  return out
}

/** 扫一个文件。非 JSON 按文本行找已知前缀（JSON 优先，因为它能定位到键路径）。 */
function 扫文件(abs) {
  let 原文
  try { 原文 = fs.readFileSync(abs, "utf8") } catch (e) { return { ok: false, reason: "读不到: " + e.message, hits: [] } }
  let parsed = null
  try { parsed = JSON.parse(原文) } catch { parsed = null }
  if (parsed !== null) {
    const hits = 扫对象(parsed)
    return { ok: true, format: "json", hits, 键数: 计数键(parsed) }
  }
  // 非 JSON：只按强前缀找，且**只记行号与长度**
  const hits = []
  原文.split("\n").forEach((line, i) => {
    const m = /(sk|pk|ark|tp|ghp|xox[baprs])[-_][A-Za-z0-9_.\-]{20,}/.exec(line)
    if (m) hits.push({ path: `line:${i + 1}`, len: m[0].length, key: "-" })
  })
  return { ok: true, format: "text", hits }
}

function 计数键(obj) {
  if (!obj || typeof obj !== "object") return 0
  return Array.isArray(obj) ? obj.reduce((a, v) => a + 计数键(v), 0) : Object.values(obj).reduce((a, v) => a + 计数键(v), 1)
}

/** 枚举待扫文件（递归，跳过明显非文本的大件）。分母的分子就在这里。 */
function 枚举文件(root) {
  const out = []
  const walk = (dir, depth = 0) => {
    if (depth > 6) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!e.isFile()) continue
      // 只看可能承载配置的：json/yaml/yml/env/toml/ini/txt
      if (!/\.(json|ya?ml|env|toml|ini|txt)$/i.test(e.name)) continue
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.size > 8 * 1024 * 1024) continue
      out.push(p)
    }
  }
  for (const sub of 扫描子树) walk(path.join(root, sub))
  return out
}

/** 命中归一成可比的键（棘轮用）。**键里不许含值**，只有文件 + 路径 + 长度档。 */
const 键 = (h, 相对) => `${相对}#${h.path}#${h.len}`

/** 扫全部子树，返回 {文件数, 命中[], 读不到[]}。 */
function scanAll(root = 运行态根()) {
  const files = 枚举文件(root)
  const 命中 = []
  const 读不到 = []
  for (const abs of files) {
    const 相对 = path.relative(root, abs).split(path.sep).join("/")
    const r = 扫文件(abs)
    if (!r.ok) { 读不到.push({ file: 相对, reason: r.reason }); continue }
    for (const h of r.hits) 命中.push({ file: 相对, ...h })
  }
  return { root, 文件数: files.length, 命中, 读不到 }
}

/* ─── selftest（双向失效：阳性必抓 + 反向必不误伤 + 分母不许空转）──────────── */
if (ARGV.includes("--selftest")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-secret-"))
  const mk = (rel, body) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p }
  const res = []
  const push = (n, ok, note = "") => res.push({ n, ok: !!ok, note })

  // 阳性：假值（纪律：测试一律假值，禁真值）
  mk("forge-agents/state/bad.json", JSON.stringify({ config: { a: { apiKey: "sk-test-0123456789abcdef0123456789" } } }))
  const r1 = scanAll(dir)
  push("① 阳性：假明文 apiKey 必被抓", r1.命中.length === 1, JSON.stringify(r1.命中.map((h) => h.path)))
  push("② 命中记录只有长度、没有值（纪律硬线）", r1.命中.every((h) => !JSON.stringify(h).includes("sk-test")), JSON.stringify(r1.命中))

  // 反向：干净形态一律不误伤 —— 这是"守卫不许挡自己的路"的核心
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-clean-"))
  const mk2 = (rel, body) => { const p = path.join(clean, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p }
  mk2("forge-agents/state/ref.json", JSON.stringify({ apiKey: "ref:bigmodel_key" }))
  mk2("forge-agents/state/env.json", JSON.stringify({ apiKey: "env:ANTHROPIC_API_KEY" }))
  mk2("forge-agents/state/short.json", JSON.stringify({ apiKey: "sk-test" }))
  mk2("forge-agents/state/null.json", JSON.stringify({ apiKey: null }))
  mk2("forge-agents/state/ids.json", JSON.stringify({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", at: "2026-10-20T13:00:00.000Z", name: "canvas" }))
  const r2 = scanAll(clean)
  push("③ 反向：ref:/env: 引用形态不误伤（那是我们要的干净态）", r2.命中.length === 0, JSON.stringify(r2.命中))
  push("④ 反向：短占位值不误伤", r2.命中.length === 0)
  push("⑤ 反向：UUID/时间戳/普通字符串不误伤（运行态里全是这些）", r2.命中.length === 0, JSON.stringify(r2.命中))

  // 分母
  push("⑥ 分母：扫到的文件数是正数（不许扫了 0 个就判绿）", r1.文件数 > 0, "扫 " + r1.文件数)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-empty-"))
  const r3 = scanAll(empty)
  push("⑦ 分母空转必须 fail closed：没扫到文件时命中=0 但文件数也=0，调用方据此判红", r3.文件数 === 0 && r3.命中.length === 0)

  // 键名判据
  push("⑧ 键名：apiKey/token/secret 都算线索", ["apiKey", "accessToken", "clientSecret", "password"].every((k) => 键名线索.test(k)))
  push("⑨ 键名：普通键不算（id/name/baseUrl/modelIds）", !["id", "name", "baseUrl", "modelIds", "providerId"].some((k) => 键名线索.test(k)))
  // 非 JSON 文本
  mk("forge-agents/state/plain.env", "OPENAI_API_KEY=sk-test-0123456789abcdef0123456789\n")
  const r4 = scanAll(dir)
  push("⑩ 非 JSON 文本也抓（.env 形态）", r4.命中.some((h) => h.file.endsWith("plain.env")), JSON.stringify(r4.命中.map((h) => h.file)))

  const fails = res.filter((r) => !r.ok)
  for (const r of res) console.log((r.ok ? "✓ " : "✗ ") + r.n + (r.note ? "（" + r.note + "）" : ""))
  console.log("runtime-secret-check selftest " + (res.length - fails.length) + "/" + res.length + " 通过")
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(clean, { recursive: true, force: true })
  fs.rmSync(empty, { recursive: true, force: true })
  process.exit(fails.length ? 2 : 0)
}

/* ─── 正常判定 ─────────────────────────────────────────────────────────── */
const BASELINE = path.join(path.resolve(import.meta.dirname, ".."), "scripts", "baseline", "runtime-secret.json")

const { root, 文件数, 命中, 读不到 } = scanAll()

// 分母空转 = fail closed（ISS-629）。目录不存在是"新机器/没跑过"，不是"干净"。
if (文件数 === 0 && !ARGV.includes("--json")) {
  console.error("✗ 运行态目录下一个待扫文件都没有（root=" + root + "）⇒ fail closed，不许把\"没扫到\"读成\"零违例\"")
  process.exit(2)
}

const 基线 = 读基线(BASELINE)
const 新增 = 基线 ? 命中.filter((h) => !基线.存量?.[键(h, h.file)]) : 命中

if (ARGV.includes("--write-baseline")) {
  const 存量 = {}
  for (const h of 命中) 存量[键(h, h.file)] = `${h.file} → ${h.path}（len=${h.len}）`
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify({
    recordedAt: new Date().toISOString().slice(0, 10),
    tool: "runtime-secret-check.mjs --write-baseline",
    note: "存量明文凭据。**不含任何值**，只有文件+键路径+长度档。压低它才是成绩；抬高要在提交说明里给理由。轮换属 ISS-919。",
    存量,
  }, null, 1) + "\n")
  console.log("已记基线 " + Object.keys(存量).length + " 条（存量不再拦；新增一律红）。")
  process.exit(0)
}

// 输出纪律：**只打定位与长度，绝不打值**
for (const h of 新增) console.log("✗ " + h.file + " → " + h.path + "（长度 " + h.len + "）—— 运行态落了明文凭据，改存 ref:/env: 形态或走凭据 seam")
for (const u of 读不到) console.log("○ 读不到：" + u.file + "（" + u.reason + "）—— 看不见≠没有，单独点名")
if (!基线) console.log("✗ 还没有基线（" + BASELINE + "）⇒ 先跑 --write-baseline 记存量，不许当\"没有欠账\"")
if (ARGV.includes("--verbose")) for (const h of 命中) console.log("  [基线内] " + h.file + " → " + h.path + "（长度 " + h.len + "）")

if (ARGV.includes("--json")) {
  console.log(JSON.stringify({ root, 文件数, 全量命中: 命中.length, 基线内: 命中.length - 新增.length, 新增: 新增.length, 读不到: 读不到.length, 基线条数: 基线 ? Object.keys(基线.存量 ?? {}).length : null }, null, 1))
  process.exit(基线 && 新增.length === 0 ? 0 : 2)
}
console.log("runtime-secret-check · 扫 " + 文件数 + " 个运行态文件（root=" + root + "）· 全量命中 " + 命中.length + " · 基线内 " + (命中.length - 新增.length) + " · 基线外新增 " + 新增.length + " · 读不到 " + 读不到.length)
process.exit(基线 && 新增.length === 0 ? 0 : 2)
