// 收集「供应商 + 模型家族」的 logo，生成内联 data URI 的 TS 资源文件。
//
// 为什么内联：与既有 `avatar-logos.ts` 同款做法 —— **零运行时依赖**（不装图标包、不发外部请求）。
//
// 来源（两个，互补）：
//   · 供应商：`https://models.dev/logos/<provider-id>.svg`（与我们的规格同源，真 logo、体积小）
//     ⚠️ 实测（2026-09-15）：**模型家族**不能用这个路径 —— `/logos/<family>.svg` 对未知 id 返回
//     **同一个占位图**（qwen/glm/gpt/claude/gemini 的 md5 全相同），所以家族走 lobehub。
//   · 模型家族：`@lobehub/icons-static-svg`（MIT）里的 `icons/*.svg`，品牌更全。
//
// 用法：node scripts/collect-brand-logos.mjs [lobehub解包目录]
//   日后再收集：先 `curl <tarball> | tar xz`，再跑本脚本覆盖生成。
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, "..", "forge-ui", "src", "surfaces", "plans", "brand-logos.ts")
const LB = process.argv[2] || "/tmp/lbicons/package/icons"

/** 供应商 logo：我们的 plan id → models.dev 的 logo id（与 MODELS_DEV_KEYS 同源）。 */
const PROVIDER_MD = {
  opencode: "opencode",
  "opencode-go": "opencode",
  openrouter: "openrouter",
  "deepseek-official": "deepseek",
}

/** 供应商 logo：plan id → lobehub 文件名（models.dev 没有的那几家）。
 *  值可以是 `"file.svg"`，也可以是 `{ file, recolor: [from, to] }`（需要染色时）。
 *  ⚠️ 2026-09-15 老板实测逐条纠正：
 *    · 智谱：原用 `zai.svg`（其 <title> 是 **Z.ai**，只是字母 Z 的形，是国际品牌标）→ 改 `zhipu-color.svg`（真 Zhipu，#3859FF）。
 *    · 月之暗面：`moonshot.svg` 单色 → 改 `kimi`；但 **`kimi-color.svg` 里有一条路径是白填充 `#fff`**
 *      → 浅色底上白的那条看不见，**只剩一个蓝点**（老板实测「还是一个点」）。
 *      故改用**单色** `kimi.svg` 并把 `currentColor` **染成品牌蓝 #1783FF** → 完整的 K 形可见。
 */
const PROVIDER_LOBE = {
  "volcengine-agent-plan": "volcengine-color.svg",
  "qwen-token-plan-cn": "alibaba-brand-color.svg",
  "zai-coding-cn": "zhipu-color.svg",
  "zai-cn-usage": "zhipu-color.svg",
  "xiaomi-token-plan-cn": "xiaomimimo.svg",
  "kimi-coding": { file: "kimi.svg", recolor: ["currentColor", "#1783FF"] },
}

/**
 * 官方资源（models.dev 与 lobehub 都没有的）—— 直接取厂商官网，必要时染色。
 * `commandcode`：品牌页（commandcode.ai/brand）声明强调色 **Burple #8C4EDD**，
 *   但其 logomark 是**单色黑白**（favicon 的 mask-icon 是 potrace 单色 #000000）
 *   → 内联时把 fill 染成 Burple，保证浅/深背景都看得见。
 */
const OFFICIAL = {
  commandcode: {
    url: "https://commandcode.ai/favicon/2024/safari-pinned-tab.svg",
    recolor: ["#000000", "#8C4EDD"],
  },
}

const toDataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
/** 读 lobehub 图标；spec 可为 `"file.svg"` 或 `{file, recolor:[from,to]}`。返回 null = 文件缺失。 */
function readLobe(spec) {
  const file = typeof spec === "string" ? spec : spec.file
  const p = join(LB, file)
  if (!existsSync(p)) return null
  let svg = readFileSync(p, "utf8")
  const recolored = typeof spec !== "string" && spec.recolor
  if (recolored) svg = svg.split(spec.recolor[0]).join(spec.recolor[1])
  return { svg, note: file + (recolored ? " (染色 " + spec.recolor[1] + ")" : "") }
}

const out = { provider: {}, family: {} }
const report = { provider: [], family: [], missProvider: [], missFamily: [] }

// ── 供应商：先 models.dev，再 lobehub，最后官方 ──
for (const [planId, mdId] of Object.entries(PROVIDER_MD)) {
  try {
    const r = await fetch(`https://models.dev/logos/${mdId}.svg`)
    if (!r.ok) throw new Error(String(r.status))
    out.provider[planId] = toDataUri(await r.text())
    report.provider.push(planId + " ← models.dev/" + mdId)
  } catch (e) {
    report.missProvider.push(planId + " (models.dev " + e.message + ")")
  }
}
for (const [planId, spec] of Object.entries(PROVIDER_LOBE)) {
  const got = readLobe(spec)
  if (!got) {
    report.missProvider.push(planId + " (lobehub 缺 " + (typeof spec === "string" ? spec : spec.file) + ")")
    continue
  }
  out.provider[planId] = toDataUri(got.svg)
  report.provider.push(planId + " ← lobehub/" + got.note)
}
/** 带重试的 fetch（官方站点偶发抖动；一次失败就丢 logo 太脆）。 */
async function fetchWithRetry(url, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.text()
      last = new Error(String(r.status))
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)))
  }
  throw last ?? new Error("fetch failed")
}

for (const [planId, spec] of Object.entries(OFFICIAL)) {
  try {
    let svg = await fetchWithRetry(spec.url)
    if (spec.recolor) svg = svg.split(spec.recolor[0]).join(spec.recolor[1])
    out.provider[planId] = toDataUri(svg)
    report.provider.push(planId + " ← 官方 " + spec.url + (spec.recolor ? " (染色 " + spec.recolor[1] + ")" : ""))
  } catch (e) {
    report.missProvider.push(planId + " (官方 " + e.message + ")")
  }
}

/** 模型家族 logo：family 首段 → lobehub 文件名（优先彩色版）；值同样支持 `{file, recolor}`。
 *  ⚠️ 2026-09-15 老板实测纠正：
 *    · glm → **与供应商一致**（智谱）→ 用 `zhipu-color.svg`（不再用 glmv-color，避免同一家两个标）。
 *    · kimi → 同供应商：`kimi-color.svg` 有白填充会只剩一点 → 单色 `kimi.svg` + 染 #1783FF。
 *    · 豆包（`seed` / `doubao`）原先**没有** → 补 `doubao-color.svg`。
 */
const FAMILY_LOBE = {
  qwen: "qwen-color.svg",
  glm: "zhipu-color.svg",
  gpt: "openai.svg",
  o: "openai.svg",
  claude: "claude-color.svg",
  gemini: "gemini-color.svg",
  deepseek: "deepseek-color.svg",
  kimi: { file: "kimi.svg", recolor: ["currentColor", "#1783FF"] },
  minimax: "minimax-color.svg",
  grok: "grok.svg",
  gemma: "gemma-color.svg",
  mistral: "mistral-color.svg",
  nova: "nova-color.svg",
  mimo: "xiaomimimo.svg",
  llama: "meta-color.svg",
  nemotron: "nvidia-color.svg",
  seed: "doubao-color.svg",
  doubao: "doubao-color.svg",
}

// ── 模型家族 ──
for (const [brand, spec] of Object.entries(FAMILY_LOBE)) {
  const got = readLobe(spec)
  if (!got) {
    report.missFamily.push(brand + " (缺 " + (typeof spec === "string" ? spec : spec.file) + ")")
    continue
  }
  out.family[brand] = toDataUri(got.svg)
  report.family.push(brand + " ← " + got.note)
}

const ts = `// 供应商 / 模型家族 logo —— 内联 data URI，零运行时依赖（同 avatar-logos.ts 的做法）
//
// ⚠️ 本文件由 \`scripts/collect-brand-logos.mjs\` **生成**，勿手改。
//
// 来源：
//   · 供应商 → \`https://models.dev/logos/<id>.svg\`（与规格同源；实测其 **family 路径返回占位图**，故家族不用它）
//   · 模型家族 → \`@lobehub/icons-static-svg\`（MIT）
//
// 用法：
//   providerLogo(planId)        → 供应商 logo（如 "volcengine-agent-plan"）
//   familyLogo(modelNameOrFamily)→ 按家族首段猜模型 logo（如 "claude-opus-4" → claude）

/** 供应商 logo：key = 我们的 plan id。 */
export const PROVIDER_LOGOS: Record<string, string> = ${JSON.stringify(out.provider, null, 2)}

/** 模型家族 logo：key = family 的**首段**（小写），如 claude / gpt / qwen。 */
export const FAMILY_LOGOS: Record<string, string> = ${JSON.stringify(out.family, null, 2)}

/** 取供应商 logo；没有则 undefined（UI 自行兜底）。 */
export function providerLogo(planId: string): string | undefined {
  return PROVIDER_LOGOS[planId]
}

/**
 * 按模型名猜家族 logo：取名字首段（去掉 provider 前缀与变体后缀）小写后查表。
 * 例：\`anthropic/claude-opus-4\` → claude；\`gpt-5.3-codex\` → gpt。
 */
export function familyLogo(modelNameOrId: string): string | undefined {
  const base = String(modelNameOrId || "")
    .split("/")
    .pop()!
    .replace(/:.*$/, "")
    .toLowerCase()
  const head = base.split(/[-_.\\s]/)[0] ?? ""
  return FAMILY_LOGOS[head]
}
`

writeFileSync(OUT, ts)
console.log("生成:", OUT)
console.log("供应商 logo:", report.provider.length, "个")
report.provider.forEach((x) => console.log("  ✓", x))
report.missProvider.forEach((x) => console.log("  ✗", x))
console.log("模型家族 logo:", report.family.length, "个")
console.log("  失败:", report.missFamily.join(", ") || "(无)")
console.log("文件大小:", (ts.length / 1024).toFixed(1), "KB")

// ★ 缺任何一个供应商 logo 就**报错退出**：本脚本会整份覆盖生成物，
//   静默少一个 = 悄悄把线上已有的 logo 抹掉（2026-09-15 commandcode 因网络抖动丢过一次）。
if (report.missProvider.length > 0) {
  console.error("\n✗ 有供应商 logo 没取到 —— 生成物已写出但**不完整**，别就这么提交：")
  report.missProvider.forEach((x) => console.error("   ", x))
  process.exit(1)
}
