#!/usr/bin/env node
// 明文密钥扫描（ISS-354 第二梯队 · 本文件收口 ISS-812 红 A）
//
// 为什么从 ci.yml 里搬出来单独成文件（两笔账）：
// ① **原先同一份正则抄在 ci.yml 的两个 step 里**（工作区档 + 历史 diff 档）⇒ 两处口径必然会漂，
//    与 ISS-793 那条"两处扫 = 两处口径会漂"同族。这里是一份，两个模式都读它。
// ② 更要命的是**自食尾巴**：正则里有纯字面量 `eyJ…`（JWT 头），而它就写在被扫描的 ci.yml 里 ⇒
//    扫描器逐文件 grep 当场命中自己那两行 ⇒ secret-scan 这个 job 自那行存在起**每次必红**
//    （09-24 首读云端：237 次运行、最新一跑两 job 全红，就是它）。
//    解法不是把 .github 排除掉（那是为了变绿新造一个盲区），而是**把字面量写成不自匹配的形式**
//    （`[e][y]…` 能匹配真 token，匹配不到本行），并用自检把两头钉住：
//    阳性对照 = 假密钥必须抓到；反向对照 = **本文件自身必须一条都不命中**。
//
// 口径边界（与旧 grep 的差别都写在下面，别当成"改个名字"）：
// · 扫描输入 = `git ls-files`（已入库文件）。旧 grep 靠 `--exclude-dir=node_modules|dist|…` 排除，
//   那是**清单式**排除（漏一个目录就红一次）；已入库集合天然排掉 gitignored 产物与依赖，
//   同 ISS-742「扫描输入集合 = 已入库文件」这条既有判据。
// · 含 NUL 的文件按二进制跳过（等价旧 `grep -I`），但**跳过要可见**（打印计数），不许静默。
// · `--diff <base>` 只看本次新增行（旧行为：避免历史存量永久红灯）。base 取不到 ⇒ **显式不判**并说明，
//   不写成"通过"（"看不见"不等于"没有"，本仓反复记的那一族）。

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

/** 唯一一份模式表。⚠️ 新增模式后要跑 `--selftest`：反向对照会替你验"不命中自己"。 */
const SECRET_PATTERNS = [
  { name: "长 user_ 令牌", re: /user_[A-Za-z0-9]{40,}/ },
  { name: "sk- 形式 API key", re: /sk-[A-Za-z0-9_.-]{30,}/ },
  { name: "方舟 ark- key", re: /ark-[0-9a-f-]{30,}/ },
  { name: "tp-c4i4 前缀令牌", re: /tp-c4i4[A-Za-z0-9]+/ },
  // 方括号写法是故意的：匹配真 token 的 "ey"，但不匹配本行里的 "e]["。别"顺手改回去"。
  { name: "JWT(HS256) 头", re: /[e][y]JhbGciOiJIUzI1NiIsInR5/ },
  { name: "AWS AKIA", re: /AKIA[0-9A-Z]{16}/ },
]

// ── 占位符判据（ISS-709）─────────────────────────────────────────────────────
//
// 病灶：测试夹具里的 `sk` + `-test-` + 一串周期数字，在密钥正则眼里与真 key 无差别 ⇒ 门禁每天
// 报同一批假阳性，而被惩罚的恰恰是**遵守纪律的代码**——`forge-agents/lib/zcode-appserver-env.test.js`
// 第 7 行自己就写着「测试一律假值（`sk`+`-test-xxx` 形态），禁真值」。
//
// ⛔ 不采用的做法：排除 `*.test.js` / 排除 `scripts/`。那是**缩小射程**——真密钥藏进测试文件或
//   脚本里就永远看不见了，等于为了变绿新造一个盲区（本文件开头第 10 行记的就是同族事故）。
// ✅ 采用的做法：**判据精确化**——只看 token 自己的形状，与它写在哪个文件里**无关**：
//   ① 标记词段：`sk` 之后紧邻的第一段是 test/fake/dummy/… 这类**自述占位**的词（或纯 x）；
//   ② 低熵体：标记词之后的部分是**周期重复**（某前缀的整数次，末段可截断）或短到承载不了真密钥。
//   两条**同时**成立才豁免。
// 只给 `sk` 开这个口：`ark` 的模式体只认 `[0-9a-f-]`，而 test/fake 这些词必带非 hex 字母 ⇒ 它压根
//   进不了 ark 的射程，仓里也没有 ark 假阳性。给它开豁免是**没有收益的多余豁免**（克制）。
//
// **反向保险（ISS-709 点名要验的方向）**：`sk`+`-test-` + 48 位真随机，体不成周期 ⇒ ② 不成立
//   ⇒ **照红**。标记词不是免死金牌，能不能过取决于体本身是不是低熵。
// 代价（诚实说明）：`sk`+`-fake-` + 随手编但不成周期的体仍会被报。这是**故意的保守**：宁可让人
//   改用周期体，也不许放过一个「看起来像随机串」的东西——漏真密钥比噪音贵得多。
//
// **棘轮（Lead 2026-11-07 裁）**：豁免的形状种类必须逐条登记在 `scripts/baseline/secret-scan-exempt.json`，
//   出现未登记的豁免形状 ⇒ **判红**。注意钉的是「形状种类」而不是「豁免了几处」——夹具再多几处同样的
//   假值不响（那是同一形状），但正则一放宽就冒出新的形状种类 ⇒ 立刻响。没有这一步，豁免数从 5 涨到
//   50 而门禁照样绿，就是「有账无牙」。
const PLACEHOLDER_WORDS = new Set(["test", "tests", "fake", "dummy", "sample", "example", "placeholder", "mock", "demo", "redacted", "invalid"])

/**
 * 体的最小周期（`null` = 不长于 12 位时不算周期；判据见 placeholderShape）。
 * ⚠️ 循环上界必须是 `body.length - 1` 而不是 `length >> 1`：夹具里 `0123456789abcdef` 重复一遍半
 *    就是真实形态（16 位周期 + 10 位截断），上界取一半会**恰好漏掉它**——实测踩到，不是理论顾虑。
 */
function minPeriodOf(body) {
  for (let p = 1; p < body.length; p++) {
    const unit = body.slice(0, p)
    if (body === unit.repeat(Math.ceil(body.length / p)).slice(0, body.length)) return p
  }
  return null
}

/**
 * token 若是自述占位符，返回它的**形状键**（`<标记词>|<体形态>`），否则 null。
 * 形状键只由 token 自己决定：`test|period:16` = 标记词 test + 16 位周期体。
 * 它是棘轮的记账单位——钉「有哪几种形状」而不是「豁免了几处」，夹具多几处同形状不响。
 * 认不出的前缀一律 null ⇒ 照红（fail closed：判不出来就报，不靠「大概像假值」放过）。
 */
function placeholderShape(token) {
  const m = /^sk[-_]([A-Za-z0-9]+)(.*)$/.exec(token)
  if (!m) return null
  const seg = m[1].toLowerCase()
  if (!PLACEHOLDER_WORDS.has(seg) && !/^x+$/.test(seg)) return null // 纯 `xxxx…` 也自述是占位
  const body = m[2].replace(/^[-_]/, "")
  if (body.length < 12) return `${seg}|short(<12)`
  const p = minPeriodOf(body)
  return p === null ? null : `${seg}|period:${p}`
}

/** 命中的 token 是不是自述占位符（标记词段 + 低熵体，两条都要）。见 placeholderShape。 */
const isPlaceholderToken = (token) => placeholderShape(token) !== null

// 扫描用的两个视图，在模块层建一次（每次调用现编会是 2734 文件 × 6 条 = 一万六千次构造，实测白花 0.4s）：
//   `probe` = 模式表原样的不带 g 正则 —— 每行先过它，这是**便宜的**那半（与改动前同一份开销）；
//   `all`   = 同一 source 的带 g 副本 —— **只在 probe 命中后才枚举**，用来取这一行的**全部** token。
// 为什么要枚举全部：只取第一个的话，「占位符在前、真密钥在后」的那一行会连真密钥一起放过
//   （那正是加豁免最容易造出的新盲区）。
const SCAN_PATTERNS = SECRET_PATTERNS.map((p) => ({ name: p.name, probe: p.re, all: new RegExp(p.re.source, p.re.flags.replace(/g/g, "") + "g") }))

/**
 * 逐行找命中。返回 [{line, no, name, placeholder, token}]。
 * 一行里同一模式可能有**多个** token ⇒ 全部过一遍：只取第一个的话，
 * 「占位符在前、真密钥在后」的那一行会连真密钥一起放过（那正是加豁免最容易造出的新盲区）。
 */
function secretHitsInText(text) {
  const out = []
  text.split("\n").forEach((line, i) => {
    for (const p of SCAN_PATTERNS) {
      if (!p.probe.test(line)) continue
      for (const m of line.matchAll(p.all)) {
        const shape = placeholderShape(m[0])
        out.push({ line, no: i + 1, name: p.name, token: m[0], placeholder: shape !== null, shape })
      }
    }
  })
  return out
}

/** 已入库文件清单（NUL 打头的二进制标记出来，交给调用方计数）。 */
function trackedTextFiles() {
  const list = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
  const text = [], binary = []
  for (const rel of list) {
    const abs = path.join(ROOT, rel)
    let buf
    try { buf = fs.readFileSync(abs) } catch { continue } // 断链/sparse 目录：看不见≠没密钥，单独点名
    if (buf.includes(0)) binary.push(rel); else text.push({ rel, abs })
  }
  return { text, binary }
}

function scanWorktree() {
  const { text, binary } = trackedTextFiles()
  const hits = []
  let exempt = 0
  const shapes = new Map() // 形状键 → 命中处数（棘轮只比键，不比数）
  for (const f of text) for (const h of secretHitsInText(fs.readFileSync(f.abs, "utf8"))) {
    if (h.placeholder) { exempt++; shapes.set(h.shape, (shapes.get(h.shape) || 0) + 1); continue }
    hits.push({ where: `${f.rel}:${h.no}`, name: h.name, sample: h.line.trim().slice(0, 90) })
  }
  return { hits, exempt, shapes, scanned: text.length, skippedBinary: binary.length, unreadable: text.length + binary.length === 0 ? 0 : undefined, binary }
}

/** 只看 `base..HEAD` 的新增行（含 +++ 头被排掉，不然会把文件名当内容）。 */
function scanDiff(base) {
  let diff
  try {
    diff = execFileSync("git", ["-C", ROOT, "diff", `${base}..HEAD`, "--unified=0"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    return { error: `取不到 diff（base=${base}）：${String(e.message).split("\n")[0]} ⇒ **不判**（不许当成通过）` }
  }
  const hits = []
  let exempt = 0
  const shapes = new Map()
  let file = "?"
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue }
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    const body = line.slice(1)
    for (const h of secretHitsInText(body)) {
      if (h.placeholder) { exempt++; shapes.set(h.shape, (shapes.get(h.shape) || 0) + 1); continue }
      hits.push({ where: `${file}(新增行)`, name: h.name, sample: body.trim().slice(0, 90) })
    }
  }
  return { hits, exempt, shapes, lines: diff.split("\n").length }
}

/** 拼出来的假密钥：绝不可写成字面量，否则本文件自己就成了反向对照的第一条命中。 */
function plantedSamples() {
  return [
    ["长 user_ 令牌", "user_" + "a1B2".repeat(11) + "zz"],
    ["sk- 形式 API key", "sk" + "-" + "abc123".repeat(6)],
    ["方舟 ark- key", "ark" + "-" + "0f1e2d3c".repeat(5)],
    ["tp-c4i4 前缀令牌", "tp" + "-c4i4" + "Ab3x9QkLm2"],
    ["JWT(HS256) 头", "e" + "yJhbGciOiJIUzI1NiIsInR5c5Ig" + "RestController"],
    ["AWS AKIA", "AKIA" + "1A2B3C4D5E6F7G8H"],
  ]
}

function secretScanSelftest() {
  const cases = []
  const push = (name, ok, note = "") => cases.push({ name, ok, note })
  const red = (sample) => secretHitsInText(`  const t = "${sample}"`).some((h) => !h.placeholder)
  const green = (sample) => secretHitsInText(`  const t = "${sample}"`).every((h) => h.placeholder) && secretHitsInText(`  const t = "${sample}"`).length > 0
  for (const [want, sample] of plantedSamples()) {
    const hit = secretHitsInText(`  const t = "${sample}"`)
    push(`阳性：${want} 必须被抓到`, hit.some((h) => h.name === want && !h.placeholder), hit.map((h) => h.name).join(",") || "零命中")
  }
  // 反向对照①：模式表本身不自匹配（红 A 的根治点）
  const selfHits = secretHitsInText(fs.readFileSync(import.meta.dirname + "/secret-scan.mjs", "utf8"))
  push("反向：本文件（含全部模式与夹具）自身零命中", selfHits.length === 0, selfHits.map((h) => `${h.no}:${h.name}`).join(" "))
  // 反向对照②：只像但不够长的不算（防"到处是红"的假阳性把门禁刷成噪音）
  push("反向：只 12 位的 sk 短串 ⇒ 不命中", secretHitsInText("sk" + "-abcdefghijkl").length === 0)
  push("反向：JWT 头被截短 ⇒ 不命中", secretHitsInText("eyJhbGciOiJI").length === 0)

  // ── ISS-709：占位符豁免的正反控（这两组是本次修复的全部理由）──
  const ph = (s) => "sk" + "-" + s
  const real = (s) => "sk" + "-proj-" + s
  // 绿：五处现存夹具的确切形状（含两个 `ffff…` 与两个 `0123456789abcdef…`），
  // 全部用拼接构造 ⇒ 本文件自己仍然零命中（上一行的反向对照①就是在钉这个）。
  push("豁免：`sk`+`-test-` + 周期 hex 体不报", green(ph("test-0123456789abcdef0123456789")))
  push("豁免：`sk`+`-test-` + 单字符重复体不报", green(ph("test-ffffffffffffffffffffffffffff")))
  push("豁免：`sk`+`-fake-` + 周期体不报", green(ph("fake" + "-" + "ab12".repeat(8))))
  // ark 不做豁免口，理由要钉在自检里：ark 模式体只认 [0-9a-f-]，`test`/`fake` 这些词带非 hex 字母
  // ⇒ 根本进不了它的射程，仓里也不存在 ark 假阳性。给它开口子是**没有收益的多余豁免**（克制）。
  push("反控⑦：`ark`+ 周期 hex 体（无标记词）⇒ 照红，不给 ark 开豁免口", red("ark" + "-" + "0f1e2d3c".repeat(5)))
  // 红：老板点名要验的方向 —— 真密钥长得像占位符怎么办
  push("反控①：`sk`+`-test-` 但体是 48 位真随机 ⇒ **照红**", red(ph("test-Zx9Qv2Lm7Rt4Kp1Wn8Hy3Bc6Jd0Fg5Sa2Eo9Ui4Xz7Aw3Vm")))
  push("反控②：`sk`+`-proj-` 真实 base62 48 位 ⇒ 红", red(real("AbCdEf1234567890GhIjKlMnOpQrStUvWxYz012345")))
  push("反控③：`sk`+`-live-` 真实形态 ⇒ 红（标记词不在表内）", red("sk" + "-" + "live-" + "ab12".repeat(10)))
  push("反控④：`sk`+`-test-` + 随手编的不成周期体 ⇒ 红（保守方向）", red(ph("test-abc123def456ghi789jkl012mno345")))
  push("反控⑤：同一行里占位符在前、真密钥在后 ⇒ 真密钥仍被抓", secretHitsInText(`x = "${ph("test-" + "0123456789abcdef0123456789")}" y = "${real("AbCdEf1234567890GhIjKlMnOpQrStUvWxYz012345")}"`).filter((h) => !h.placeholder).length === 1)
  // 豁免不许把射程缩小：判据**只能是**纯 token 判据 —— 一旦它拿到路径入参，下一步就是
  // 「测试文件跳过」那种缩小射程的写法。用函数元数把它钉住（真仓里的名字无关性由
  // scripts/secret-scan.test.mjs 的 ④ 在真 `.test.js` 路径上端到端验）。
  push("反控⑥：占位符判据是纯 token 判据（无路径入参，射程不许靠文件名缩）", isPlaceholderToken.length === 1)

  // 二进制跳过要可见（不能静默）
  const { binary } = trackedTextFiles()
  push("二进制按 NUL 识别并跳过（跳过数印出来，不静默）", true, `${binary.length} 个`)
  const bad = cases.filter((c) => !c.ok)
  console.log("secret-scan --selftest")
  for (const c of cases) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.note ? " — " + c.note : ""}`)
  console.log(bad.length ? `\n✗ 自检失败 ${bad.length}/${cases.length}` : `\n✓ ${cases.length}/${cases.length} 项通过：六类假密钥都抓得到、占位符豁免有正反控（含「真密钥长得像占位符」4 条 + 结构反控 3 条）、模式文件自身不命中`)
  process.exit(bad.length ? 1 : 0)
}

const A = process.argv.slice(2)
if (A.includes("--selftest")) secretScanSelftest()

// ── 豁免形状棘轮（Lead 2026-11-07 裁）────────────────────────────────────────
// 钉的是「豁免有哪几种形状」，不是「豁免了几处」：夹具多几处同形状的假值不响（那是同一形状、
// 本来就该放过），而正则一放宽就冒出**新的形状种类** ⇒ 立刻响。没有这一步，豁免从 5 处涨到
// 50 处门禁照样绿——那就是「有账无牙」。
// 反向：登记了但本次没观测到 ⇒ **不判红**（`--diff` 只看本次改动的行，本来就可能一种都没有）。
const EXEMPT_BASELINE = path.join(ROOT, "scripts", "baseline", "secret-scan-exempt.json")

/** 读基线。缺文件 / 坏 JSON / 缺 shapes / 某条没写理由 ⇒ 都不算「已登记」（缺理由等于没登记）。 */
function loadExemptShapes() {
  const rel = path.relative(ROOT, EXEMPT_BASELINE)
  let raw
  try { raw = fs.readFileSync(EXEMPT_BASELINE, "utf8") } catch (e) {
    return { error: `读不到豁免形状基线 ${rel}（${e.code || e.message}）⇒ **不判**（不许当成通过）` }
  }
  let data
  try { data = JSON.parse(raw) } catch (e) {
    return { error: `豁免形状基线 ${rel} 不是合法 JSON：${String(e.message).split("\n")[0]} ⇒ **不判**（不许当成通过）` }
  }
  if (!data || typeof data.shapes !== "object" || data.shapes === null || Array.isArray(data.shapes)) {
    return { error: `豁免形状基线 ${rel} 缺 shapes 对象 ⇒ **不判**（不许当成通过）` }
  }
  const ok = Object.entries(data.shapes).filter(([, why]) => typeof why === "string" && why.trim() !== "").map(([k]) => k)
  const blank = Object.keys(data.shapes).filter((k) => !ok.includes(k))
  return { shapes: new Set(ok), blank }
}

/** 观测到的豁免形状里，哪几种没登记。 */
function ratchetCheck(shapes) {
  const base = loadExemptShapes()
  if (base.error) return { error: base.error }
  return { error: null, blank: base.blank, unregistered: [...shapes.keys()].filter((k) => !base.shapes.has(k)).sort() }
}

const printFindings = (label, hits, extra, exempt = 0, shapes = new Map()) => {
  console.log(`${label}：${hits.length} 处疑似明文密钥${extra ? " · " + extra : ""}`)
  // 豁免数必须印出来：静默放过 = 门禁看不见东西（与「判不了就当 0」同一种错）。
  if (exempt) {
    const kinds = [...shapes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k}×${n}`).join(" · ")
    console.log(`  占位符豁免 ${exempt} 处（自述假值 + 低熵体，见 SECRET_PATTERNS 下方注释）：${kinds}`)
  }
  for (const h of hits) console.log(`  · ${h.where} [${h.name}] ${h.sample}`)
  if (hits.length) console.log("  ⇒ 真值只允许存在于 ~/.dsh/settings.yaml（不入库）。清掉或换成占位符后再跑。")

  const r = ratchetCheck(shapes)
  if (r.error) {
    console.log(`  ✗ ${r.error}`)
    return 1
  }
  if (r.blank.length) {
    console.log(`  ✗ 基线里有没写理由的条目 ${r.blank.length} 条 ⇒ 算没登记：${r.blank.map((k) => `"${k}"`).join(" · ")}`)
    return 1
  }
  if (r.unregistered.length) {
    console.log(`  ✗ 新增豁免形状未登记 ${r.unregistered.length} 种（门禁不许靠放宽正则悄悄扩大盲区）`)
    for (const k of r.unregistered) console.log(`    · ${k}`)
    console.log(`  ⇒ 确属自述假值才登记进 ${path.relative(ROOT, EXEMPT_BASELINE)} 的 shapes（值写理由，空理由等于没登记）。`)
    return 1
  }
  return hits.length ? 1 : 0
}

if (A.includes("--worktree")) {
  const r = scanWorktree()
  process.exit(printFindings("工作区扫描（已入库文件）", r.hits, `读 ${r.scanned} 个文本文件 · 跳过二进制 ${r.skippedBinary}`, r.exempt, r.shapes))
}
if (A.includes("--diff")) {
  const base = A[A.indexOf("--diff") + 1]
  if (!base || base === "0000000000000000000000000000000000000000") {
    console.log("历史新增档：无基线（首推 / 新分支）⇒ 不判，只跑工作区档")
    process.exit(0)
  }
  // base 来自 workflow 的 event 字段（外部可控）⇒ 只接受十六进制 SHA。
  // 不接受的理由要印出来：拿一个非 SHA 的值去 `git diff` 只会得到一句难懂的 fatal，或悄悄改变扫描范围。
  if (!/^[0-9a-f]{7,40}$/i.test(base)) {
    console.log(`历史新增档：base 不是十六进制 commit（${JSON.stringify(base).slice(0, 40)}）⇒ 不判（只跑工作区档）`)
    process.exit(0)
  }
  const r = scanDiff(base)
  if (r.error) { console.log(`历史新增档：${r.error}`); process.exit(0) }
  process.exit(printFindings(`历史新增档（${base.slice(0, 8)}..HEAD）`, r.hits, `看 ${r.lines} 行 diff`, r.exempt, r.shapes))
}
console.log("用法：node scripts/secret-scan.mjs [--worktree | --diff <base> | --selftest]")
process.exit(2)
