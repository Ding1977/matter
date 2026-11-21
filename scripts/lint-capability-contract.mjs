#!/usr/bin/env node
// scripts/lint-capability-contract.mjs
// 能力契约门禁（ISS-681）—— 「目录说支持 image」与「适配器真发得出图」必须是同一件事。
//
// ## 为什么要有这条（本单的原始形态）
// 模型能力声明在仓里曾经有**两套真相**且无守卫：
//   · 目录/适配器声明 → 引擎（`dsh-llm/lib/index.js:2337`）据此决定「投影成占位文本」还是「原样放行」
//   · 适配器实际出站 → 有没有真的把图编进 wire 载荷
// 两套对不上时，用户发一张图：HTTP 200、有正文、不报错，模型对着**看不见的图**编出自信的答案。
// 本仓反复强调的最难查的故障形态。
//
// ## 关键事实：`inputModalities` 是**三态**，不是二态
//   引擎判据原文（`dsh-llm/lib/index.js:2337`）：
//     if (modelInfo.inputModalities !== void 0
//         && !modelInfo.inputModalities.includes("image") && hasImage)
//       → 把图片投影成占位文本
//   `!== void 0` 是**第一个短路条件**：
//     · `undefined`         ⇒ 短路 ⇒ **放行**，图原样交给适配器（= 危险档）
//     · `["text"]`          ⇒ 投影成占位文本（用户看得见"这里原本有图"）= **安全档**
//     · `["text","image"]`  ⇒ 放行
//   实测（独立调查员用真实 `LlmRuntime` 验过）：
//     `undefined` 与 `["text","image"]` **行为完全等价**。
//   ⇒ 「不写这个字段」**不等于**「声明不支持」。它是「未知」，而未知被引擎当成「支持」。
//   ⚠️ 单包版的官方范式在 `dsh-llm-deepseek/lib/index.js:357-362`：
//     `model.inputModalities ?? ["text"]`（缺省**补**成 text-only）+ 只有声明 image 才许配图像限额。
//     我们三个自研适配器一个都没照做 —— 本脚本就是仓级版本。
//
// ## 判据（判定单位 = 包 · 三条）
//   **C0** ⛔ 覆盖完整性：仓里**每一处** `ctx.llm.registerAdapter(` 所在的包，必须在 `ADAPTERS` 登记表里。
//        漏登记 = 这条门禁对它是瞎的。守卫最大的失效形态不是判错，是**射程不够**（老板 2026-10-31 原话：
//        「很多补丁都是因为检查的射程不足，然后自己又走捷径」）⇒ 覆盖本身要有牙，不能靠人记得加表。
//   **C1** ⛔ 声明了 `image` 但**出站发不出图** ⇒ 红。
//        「声明」与「发得出」两个方向都用**运行时探针**取，不 grep 源码：
//        适配器导出纯函数（`toModelInfo` 等），探针真调它、真构造一条带 image 块的 user 消息，
//        走本包自己的 wire 构造函数，看出站载荷里有没有图片通道。
//        ⚠️ 为什么不用 grep：`image_url` 写在**注释里**也算命中（本仓 WorkBuddy 就有一处这样的注释），
//           而"注释里实现过"不等于"发得出去"。一手证据只能从执行里拿。
//   **C2** ⛔ `toModelInfo` 或 `resolveModel` 的输出**缺 `inputModalities`**（而非显式 `["text"]`）⇒ 红。
//        两条路径都要判：引擎的**调用路径**走 `prepareCall → resolveModel`
//        （`dsh-llm/lib/index.js:2232`），只判 `listModels` 会漏掉「用户手填模型名」那条兜底分支。
//
// ## 存量与基线（照 `gate-fast` / `lint-channel-contract` 的既有范式，不自造第三套）
//   · `--write`   ：把当前 offenders 录进 `scripts/baseline/capability-contract.json`；
//   · `--check`   ：**新增违规即红**（比 offender 集合，比数字更严 —— 一条修好 + 一条新增不该对冲成绿）；
//   · 基线只锁**已登记的债**，且 `--check` 会把「比基线多出来的那条」点名。
//     判据本身一个字不为基线放宽（工单纪律：基线数字如实报，不许为了好看放宽判据）。
//   · 「探不了」（包 import 失败 / 目录读不到）**不许冒充绿**：显式 `unjudged` 落进输出与基线，
//     且 unjudged 数比基线多 ⇒ 红（否则"环境坏了"会永久伪装成"没问题"）。
//
// ## 用法
//   node scripts/lint-capability-contract.mjs [--check|--write|--json|--selftest] [--root <路径>]
//   --root 让同一份判据跑在别的树上：`gate-fast` 的 merge-base 基准树、以及本单验收要的
//   「故意注入违规 ⇒ 必须红」都靠它。**不传 = 跑本仓根**。
//   退出码：0 = 无新增 · 1 = 有新增违规（或基线缺席）· 2 = 判据失效（fail closed，不报绿）
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { WORKTREE_PATH_RE } from "./wt-exclude-lib.mjs" // ISS-724：工作树落点的唯一真相源

const HERE = import.meta.dirname
const ARGV = process.argv.slice(2)
const flagValue = (name, dflt = "") => {
  const i = ARGV.indexOf(`--${name}`)
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt
}
const ROOT = path.resolve(flagValue("root", path.resolve(HERE, "..")))
const BASELINE = path.join(ROOT, "scripts", "baseline", "capability-contract.json")
const MODE = ARGV.includes("--selftest") ? "selftest" : ARGV.includes("--write") ? "write" : "check"

/** 日志口：探针期间各包的 warn/info 一律吞掉（守卫不该往 CI 日志里灌适配器的告警）。 */
const SILENT = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} })

/* ─────────────────── 探针夹具：一条带图的 user 消息 + 一份 data URL ───────────────────
 * 形状按 DSH 的真实块类型写：图片是 `{ type:"image", attachment:{ attachmentId } }`
 * （`dsh-llm` 的 `contentHasImage` 判的就是 `block.type === "image"`）。
 * 同一份夹具喂所有包 ⇒ 各包的差异只可能来自各包自己的实现，不来自夹具。 */
const PROBE_ATTACHMENT_ID = "capability-contract-probe"
const PROBE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
const IMAGE_MESSAGE = [
  { role: "user", content: [{ type: "text", text: "请描述这张图" }, { type: "image", attachment: { attachmentId: PROBE_ATTACHMENT_ID } }] },
]
/** 载荷里「图片通道」的形态：OpenAI 兼容 wire 用 `image_url` 部件，Responses 风格用 `input_image`。
 *  两种写法都要认（`{"type":"image_url","image_url":{…}}` 与 `{"type":"input_image","input_image":{…}}`），
 *  免得把"换了个名字的真实现"误判成"没有通道"；判据不变（能发出图 vs 发不出）。
 *  ⚠️ 只认**结构位置**（`type` 取值 / 部件键），不认"载荷里出现过这个字样"：
 *     纯文本正文里写到 `image_url` 不算通道（WorkBuddy 的注释里就有这个词，grep 会误判 ——
 *     这正是本门禁不用 grep 判源码的原因，同一条纪律也适用于载荷）。 */
const WIRE_IMAGE_RE = /"type"\s*:\s*"(?:image_url|input_image)"|"(?:image_url|input_image)"\s*:\s*\{/

/**
 * 适配器登记表 —— 「仓里哪些包注册 LLM 适配器、怎么探它」。
 * ⚠️ 这张表**被 C0 守着**（漏一个包就红），所以它不会腐坏成"漏掉新包"的化石。
 * 每项：
 *   pkg       包目录名（= 违规归属单位）
 *   provider  注册用的 provider id
 *   adapter   适配器模块（相对包根）
 *   proto     wire 构造函数所在模块（相对包根，可空 = 用 adapter 自己导出的）
 *   toModelInfo  模块名里的映射函数名（listModels 的唯一映射器）
 *   makeAdapter  构造实例（形状各家不同，只能显式写）
 *   entries      **给探针的目录条目**：一条纯文本、一条"上游说支持图"
 *   textId/imageId  上面两条各自的 id（按各家目录的 id 字段取）
 *   resolveId    "目录里查不到"的模型 id（判 C2 的兜底路径）
 *   wireImage   `(protoModule) => boolean`：用本包自己的构造函数编一份带图载荷，看有没有图片通道
 */
const ADAPTERS = [
  {
    pkg: "forge-trae-direct",
    provider: "trae-cn-direct",
    adapter: "lib/adapter.js",
    entries: [
      { name: "capability-probe-text", display_name: "Probe Text" },
      // 上游目录里 multimodal 是**上游模型**的事实（模型收得下图），不等于本通道发得出图
      { name: "capability-probe-image", display_name: "Probe Image", multimodal: true },
    ],
    textId: "capability-probe-text",
    imageId: "capability-probe-image",
    resolveId: "capability-probe-typed-by-user",
    makeAdapter: (m) => new m.TraeDirectAdapter({ logger: SILENT }),
    /** 出站：Trae 走自己的 `buildChatPayload`（`function/config_name/messages` 具名协议）。 */
    wireImage: (proto) => WIRE_IMAGE_RE.test(JSON.stringify(proto.buildChatPayload("probe-model", { system: "", messages: IMAGE_MESSAGE }).messages)),
  },
  {
    pkg: "forge-workbuddy-direct",
    provider: "workbuddy-cn-direct",
    adapter: "lib/adapter.js",
    entries: [
      { id: "capability-probe-text", name: "Probe Text" },
      { id: "capability-probe-image", name: "Probe Image", supportsImages: true },
    ],
    textId: "capability-probe-text",
    imageId: "capability-probe-image",
    resolveId: "capability-probe-typed-by-user",
    makeAdapter: (m) => new m.WorkBuddyDirectAdapter({ logger: SILENT, readCatalog: () => ({ models: [], source: "probe" }) }),
    wireImage: (proto) => WIRE_IMAGE_RE.test(JSON.stringify(proto.buildChatBody({ model: "probe-model", system: "", messages: IMAGE_MESSAGE }).body.messages)),
  },
  {
    pkg: "forge-qoder-direct",
    provider: "qoder-cn-direct",
    adapter: "lib/adapter.js",
    entries: [
      { key: "capability-probe-text", display_name: "Probe Text" },
      { key: "capability-probe-image", display_name: "Probe Image", is_vl: true },
    ],
    textId: "capability-probe-text",
    imageId: "capability-probe-image",
    resolveId: "capability-probe-typed-by-user",
    makeAdapter: (m) => new m.QoderDirectAdapter({ logger: SILENT }),
    /** Qoder 的 wire 构造函数要 imageData（attachmentId → data URL），第三参是把它解好的表。 */
    wireImage: (m) => {
      const fn = m.toQoderMessages
      if (typeof fn !== "function") return false
      const wire = fn("", IMAGE_MESSAGE, new Map([[PROBE_ATTACHMENT_ID, PROBE_DATA_URL]]))
      return WIRE_IMAGE_RE.test(JSON.stringify(wire))
    },
  },
  {
    pkg: "forge-cli-provider",
    provider: "cli-probe",
    adapter: "lib/adapter.js",
    // CLI 通道的目录是从 `/forge-agents/agent-models` 转来的（`wiring.js` 的 `toModelInfo`）
    listMapper: { module: "lib/wiring.js", fn: "toModelInfo", call: (m, entry) => m.toModelInfo({ kind: "list", modelIds: [entry.id ?? "capability-probe-text"] }, { provider: "cli-probe", label: "Probe" })?.[0] },
    entries: [{ id: "capability-probe-text" }],
    textId: "capability-probe-text",
    imageId: "capability-probe-text",
    resolveId: "capability-probe-typed-by-user",
    makeAdapter: (m) => new m.CliAdapter({ catalog: { modelsOf: async () => [], resolve: async (p, id) => ({ provider: p, id, name: id }) } }),
    /** CLI 通道把 messages 渲染成**纯文本 prompt**（`history.js` 的 `buildPrompt`）⇒ 没有图片通道。 */
    wireImage: () => false,
  },
  {
    // ISS-681 C0 补登记（2026-11-04）：`forge-router-direct/lib/index.js:79` 调了
    // `ctx.llm.registerAdapter(...)`，但此前不在本表 ⇒ 这道闸对它完全是瞎的。
    //
    // ⚠️ 它是**虚拟 provider**（一个 id 背后按额度推荐序试多家真实 provider），
    //    结构与其它 adapter 不同：`listModels` 是**实例方法**，没有导出的 `toModelInfo`；
    //    也没有 `resolveModel`。所以本轮探针跑不起来 ⇒ 落 `unjudged`（这是诚实，
    //    不是"合规"）。补登记的第一步价值是**让 C0 覆盖到它**，第二步才是补探针。
    pkg: "forge-router-direct",
    provider: "forge-router", // = chain.js 的 SELF_PROVIDER
    adapter: "lib/adapter.js",
    entries: [{ id: "deepseek-v4.1-flash" }],
    textId: "deepseek-v4.1-flash",
    imageId: "deepseek-v4.1-flash",
    resolveId: "capability-probe-typed-by-user",
    /** 虚拟 provider 的语义：链尾那几家实测没有图床/未验证 ⇒ 编不出图片载荷。 */
    wireImage: () => false,
    /** 探针暂时跑不了（无导出映射器、无 resolveModel）⇒ 显式记原因，不冒充绿。 */
    probeUnsupported: "forge-router-direct 是虚拟 provider：listModels 是实例方法、无 resolveModel ⇒ 探针结构不适用（补探针是独立单）",
  },
]

/* ─────────────────── 覆盖完整性（C0）：谁是适配器包，不能只靠上面这张表说了算 ───────────────────
 * 判据 = 全仓源码里出现 `registerAdapter(` 的包必须在登记表里。
 * 必须**先剥注释**再匹配：本仓的注释里大量出现这个调用（说明文字、"为什么会崩"的引用），
 * 不剥的话登记表会被注释里的样例撑出假缺口，缺口的红一多就没人看了（假红比没门禁更赶人）。 */
const SRC_EXT_RE = /\.(js|mjs|cjs|ts)$/
const SKIP_DIR = new RegExp(
  `(^|/)(node_modules|dist|out|build|\\.git|\\.tmp|static|vendor|coverage)(/|$)|${WORKTREE_PATH_RE.source}`
)

/** 去掉行注释与块注释（保留字符串字面量**大致**完好即可 —— 这里只找调用名，不做语法解析）。 */
function stripCommentsForRegistryScan(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // ⚠️ `(?<!:)` 保护 `https://`：否则 URL 会把后面整行吃掉（本仓注释里全是 URL）
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")
}

/** 扫 `root` 下所有源码文件（跳过产物/依赖/工作树），返回 `[{rel, text}]`。 */
function collectSourceFiles(root) {
  const out = []
  const walk = (dir) => {
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const abs = path.join(dir, e.name)
      const rel = path.relative(root, abs).split(path.sep).join("/")
      // 用 dirent 判目录（不跟随软链）：本包 node_modules 全是软链，跟随会走出仓外
      if (e.isDirectory()) {
        if (!SKIP_DIR.test("/" + rel)) walk(abs)
        continue
      }
      if (!e.isFile() || !SRC_EXT_RE.test(rel)) continue
      try {
        out.push({ rel, text: fs.readFileSync(abs, "utf8") })
      } catch {
        /* 读不到就当没这个文件；C0 另有一条"扫到的文件数为 0 ⇒ 判据失效"的兜底 */
      }
    }
  }
  walk(root)
  return out
}

/** C0：从源码里认出**真会注册适配器**的包（剥注释后出现 `registerAdapter(`，且不在 scripts/ 下）。 */
function adapterPackagesIn(sources) {
  const found = new Set()
  for (const f of sources) {
    if (f.rel.startsWith("scripts/")) continue // 守卫/文档脚本里的调用是说明，不是注册
    if (/(\.test\.|\.spec\.)/.test(f.rel)) continue // 测试里调注册是替身
    const code = stripCommentsForRegistryScan(f.text)
    if (!/\.registerAdapter\s*\(/.test(code)) continue
    const seg = f.rel.split("/")
    found.add(seg.length > 1 ? seg[0] : "(root)")
  }
  return found
}

/* ─────────────────── 探针：真调适配器的导出函数，取**一手**输出 ─────────────────── */

/**
 * 探一个包。任何一步失败都**不**降级成"通过"：
 * 返回 `{ ok:false, reason }` ⇒ 调用方记 unjudged（显式落进输出与基线，`--check` 时增多即红）。
 * @returns {Promise<{ok:true, list:Array<{id:string,im:any}>, call:Array<{id:string,im:any}>, wireImage:boolean}>|{ok:false, reason:string}>}
 */
async function probeAdapter(a) {
  /* 结构不适用探针的包（如虚拟 provider）：显式落 unjudged 并写明原因。
     ⚠️ 不许写成 `{ ok: true }` —— 那是把「探不了」冒充成「合规」。
     允许存在的理由：C0 的价值（覆盖完整性）先拿到；C1/C2 的探针是独立欠账。 */
  if (a.probeUnsupported) return { ok: false, reason: a.probeUnsupported }
  const at = (rel) => pathToFileURL(path.join(ROOT, a.pkg, rel)).href
  const load = (rel) => import(at(rel))
  let mod
  try {
    mod = await load(a.adapter)
  } catch (e) {
    return { ok: false, reason: `import ${a.pkg}/${a.adapter} 失败：${e && e.message ? e.message : String(e)}` }
  }
  // ── listModels 的产物：走该包的映射器（默认 `toModelInfo`，CLI 通道另指 wiring.js） ──
  const list = []
  try {
    const mapper = a.listMapper || { module: a.adapter, fn: "toModelInfo", call: (m, entry) => m.toModelInfo(a.provider, entry, null) }
    const mmod = mapper.module === a.adapter ? mod : await load(mapper.module)
    const fn = mapper.fn
    if (typeof mmod[fn] !== "function") return { ok: false, reason: `${a.pkg}/${mapper.module} 不再导出 ${fn}（映射器改名/搬走 ⇒ 判据失效）` }
    for (const [idx, entry] of a.entries.entries()) {
      const info = mapper.call(mmod, entry)
      const rows = Array.isArray(info) ? info : info ? [info] : []
      if (!rows.length) return { ok: false, reason: `${a.pkg} 的 ${fn} 对第 ${idx + 1} 条探针条目返回空（夹具与目录形状对不上了）` }
      for (const r of rows) list.push({ id: String(r?.id ?? ""), im: r?.inputModalities })
    }
  } catch (e) {
    return { ok: false, reason: `${a.pkg} 的 listModels 映射器抛错：${e && e.message ? e.message : String(e)}` }
  }
  // ── resolveModel 的产物：**调用路径**（引擎 2232 走这条），含"目录查不到"的兜底 ──
  const call = []
  try {
    const adapter = a.makeAdapter(mod)
    // 目录读盘/打网都由这里注入，探针不碰真实用户环境（守卫不该改用户的 ~/.dsh）
    if (typeof adapter.loadCatalog === "function") adapter.loadCatalog = async () => a.entries
    for (const id of [a.textId, a.imageId, a.resolveId]) {
      let r
      try {
        r = await adapter.resolveModel(a.provider, id)
      } catch (e) {
        // 单条抛错（例如该包要求真凭据）⇒ 整包判不了，别把"探不了"读成"合规"
        return { ok: false, reason: `${a.pkg}.resolveModel(${id}) 抛错：${e && e.message ? e.message : String(e)}` }
      }
      call.push({ id, im: r?.inputModalities })
    }
  } catch (e) {
    return { ok: false, reason: `${a.pkg} 的适配器构造失败：${e && e.message ? e.message : String(e)}` }
  }
  // ── 出站：本包自己的 wire 构造函数编一份带图载荷，看有没有图片通道 ──
  let wireImage = false
  try {
    let proto = mod
    if (a.proto) proto = await load(a.proto)
    else if (typeof a.wireImage === "function") {
      // Qoder 的 wire 构造函数在 adapter 模块里；trae/workbuddy 在 protocol.js
      const candidates = [a.adapter, "lib/protocol.js"]
      for (const cand of candidates) {
        const m = cand === a.adapter ? mod : await load(cand).catch(() => null)
        if (m && (typeof m.buildChatPayload === "function" || typeof m.buildChatBody === "function" || typeof m.toQoderMessages === "function")) {
          proto = m
          break
        }
      }
    }
    wireImage = a.wireImage(proto) === true
  } catch (e) {
    return { ok: false, reason: `${a.pkg} 的出站探针抛错（wire 构造函数改名/形状变了）：${e && e.message ? e.message : String(e)}` }
  }
  return { ok: true, list, call, wireImage }
}

/** 一条输出是"显式声明"还是"缺字段"。缺 ⇒ C2。 */
const isExplicitModalities = (im) => Array.isArray(im) && im.length > 0 && im.every((x) => x === "text" || x === "image")
/** 声明含 image。 */
const declaresImage = (im) => Array.isArray(im) && im.includes("image")

/**
 * 核心判定（纯函数 ⇒ selftest 不碰磁盘、不碰真包）。
 * @param {{pkg:string, declaredImage:boolean, wireImage:boolean, missing:Array<{path:string,id:string}>, unjudged?:string}[]} probes
 * @returns {{rule:string, pkg:string, detail:string}[]} offenders
 */
function judgeCapabilities(probes) {
  const out = []
  for (const p of probes) {
    if (p.unjudged) continue // 「判不了」单独记档（见下面 unjudged 计数），不许混进绿也不许混进红
    // C1：声明了 image 却发不出图 —— 本单的原始形态（引擎放行 → 适配器丢图 → 模型编答案）
    if (p.declaredImage && !p.wireImage) {
      out.push({ rule: "C1", pkg: p.pkg, detail: `声明了 image 能力，但本包出站载荷里没有任何图片通道（引擎会原样放行图片，适配器静默丢弃）` })
    }
    // C2：缺字段 = 未知 = 引擎放行（三态里的危险档）
    for (const m of p.missing) {
      out.push({ rule: "C2", pkg: p.pkg, detail: `${m.path}(${m.id || "(无名)"}) 的 inputModalities 缺失/非法 —— 必须显式写 ["text"]（不写 = undefined = 引擎放行图片）` })
    }
  }
  return out
}

/* ───────────────────────────── 跑真仓 ───────────────────────────── */

async function collectFindings() {
  const sources = collectSourceFiles(ROOT)
  const registered = adapterPackagesIn(sources)
  const known = new Set(ADAPTERS.map((a) => a.pkg))
  /** C0 违规：真注册了适配器却不在登记表里 ⇒ 这条门禁对它是瞎的 */
  const uncovered = [...registered].filter((p) => !known.has(p)).sort()
  const vanished = [...known].filter((p) => !registered.has(p)).sort()
  const probes = []
  for (const a of ADAPTERS) {
    const r = await probeAdapter(a)
    if (!r.ok) {
      probes.push({ pkg: a.pkg, unjudged: r.reason })
      continue
    }
    const missing = []
    for (const row of r.list) if (!isExplicitModalities(row.im)) missing.push({ path: "toModelInfo", id: row.id })
    for (const row of r.call) if (!isExplicitModalities(row.im)) missing.push({ path: "resolveModel", id: row.id })
    probes.push({
      pkg: a.pkg,
      declaredImage: r.list.some((x) => declaresImage(x.im)) || r.call.some((x) => declaresImage(x.im)),
      wireImage: r.wireImage,
      missing,
      listIds: r.list.map((x) => x.id),
      callIds: r.call.map((x) => x.id),
    })
  }
  /* 同一条 (规则, 包) 只留一条：探针会对同一包跑多条路径（listModels / resolveModel 三种 id），
     同一处病灶会被撞见多次。基线口径本来就是 (规则, 包) 集合，输出也照这个口径去重 ——
     否则「C2 缺字段 5」里其实只有 4 条病灶，读者会以为收口进度比实际好。 */
  const seenKey = new Set()
  const offenders = judgeCapabilities(probes).filter((o) => {
    const k = offenderKey(o)
    if (seenKey.has(k)) return false
    seenKey.add(k)
    return true
  })
  for (const p of uncovered) offenders.push({ rule: "C0", pkg: p, detail: `包内调用了 registerAdapter，但不在 scripts/lint-capability-contract.mjs 的 ADAPTERS 登记表里 ⇒ 本门禁看不见它（补登记，别让射程留缺口）` })
  return {
    offenders,
    probes,
    registered: [...registered].sort(),
    uncovered,
    vanished,
    scanned: sources.length,
    unjudged: probes.filter((p) => p.unjudged).map((p) => ({ pkg: p.pkg, reason: p.unjudged })),
  }
}

/** 违规集合的稳定键（比数字严：一条修好 + 一条新增**不许对冲成绿**）。 */
const offenderKey = (o) => `${o.rule}|${o.pkg}`

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) return null
  try {
    return JSON.parse(fs.readFileSync(BASELINE, "utf8"))
  } catch (e) {
    console.error(`✗ 基线解析失败（${BASELINE}）：${e.message}`)
    console.error("  fail closed —— 基线坏了就当「没有基线」，别当成「没有存量债」。")
    process.exit(2)
  }
}

/* ───────────────────────────── 自检：每条判据都必须能红 ───────────────────────────── */
/**
 * 反向验证（`docs/code.md` §7.1 K8b：从没红过的守卫等于没有守卫）。
 * 每条用例都**必须**钉住一个具体形态；「恒绿」的实现（比如 judgeCapabilities 永远返回 []）
 * 会让第 1/2/3 条当场红。
 */
function selftest() {
  const cases = []
  const t = (name, pass) => cases.push({ name, pass })

  // ① C1 该红能红：声明 image + 无图片通道
  t("C1：声明 image 但出站无图片通道 ⇒ 红", judgeCapabilities([{ pkg: "p", declaredImage: true, wireImage: false, missing: [] }]).some((o) => o.rule === "C1" && o.pkg === "p"))
  // ② C1 不该红的不红：声明了就真发得出
  t("C1：声明 image 且真发得出 ⇒ 不红", judgeCapabilities([{ pkg: "p", declaredImage: true, wireImage: true, missing: [] }]).every((o) => o.rule !== "C1"))
  // ③ 没声明 image 也没通道 ⇒ C1 不适用（纯文本适配器是**合法**的，不许误伤成红）
  t("C1：不声明 image 也没有通道 ⇒ 不红（纯文本适配器合法）", judgeCapabilities([{ pkg: "p", declaredImage: false, wireImage: false, missing: [] }]).length === 0)
  // ④ C2 该红能红：缺字段
  t("C2：缺 inputModalities ⇒ 红", judgeCapabilities([{ pkg: "p", declaredImage: false, wireImage: false, missing: [{ path: "toModelInfo", id: "m" }] }]).some((o) => o.rule === "C2"))
  // ⑤ C2 不该红的不红：显式 ["text"] 是**合规**的安全档（这是本单止血的目标形态）
  t("C2：显式 [\"text\"] ⇒ 不红（安全档）", judgeCapabilities([{ pkg: "p", declaredImage: false, wireImage: false, missing: [] }]).length === 0)
  // ⑥ 「判不了」不许冒充绿
  t("unjudged 的包既不进红也不进绿（单独记档）", judgeCapabilities([{ pkg: "p", unjudged: "import 失败" }]).length === 0)

  // ⑦ 三态语义判据本身：isExplicitModalities 必须拒绝 undefined / 空数组 / 非法值
  t("C2 判据：undefined / [] / 非法模态串 统统算缺字段",
    !isExplicitModalities(undefined) && !isExplicitModalities([]) && !isExplicitModalities(["video"]) && !isExplicitModalities("text") &&
    isExplicitModalities(["text"]) && isExplicitModalities(["text", "image"]))
  // ⑧ `undefined` 与 `["text","image"]` 在**引擎**眼里等价 ⇒ 判据必须把 undefined 当**危险**，不能当"没声明所以不管"
  t("三态口径：declaresImage(undefined) = false（不会误判成「声明了」），但 C2 会把 undefined 单独抓出来",
    declaresImage(undefined) === false && judgeCapabilities([{ pkg: "p", declaredImage: false, wireImage: false, missing: [{ path: "toModelInfo", id: "m" }] }]).some((o) => o.rule === "C2"))

  // ⑨ 剥注释（C0 的前提）：注释里的 registerAdapter 不算注册，代码里的算
  t("C0 判据：注释里的 registerAdapter 不算，代码里的算",
    adapterPackagesIn([
      { rel: "forge-x/lib/index.js", text: "// 这里调 ctx.llm.registerAdapter(a)\nconst y = 1" },
      { rel: "forge-y/lib/index.js", text: "ctx.llm.registerAdapter([p], a)" },
    ]).size === 1)
  t("C0 判据：剥注释不误伤 URL（`https://` 不许把后面整行吃掉）",
    stripCommentsForRegistryScan("const u = 'https://x/y'; ctx.llm.registerAdapter(a)").includes("registerAdapter"))
  // ⑩ C0 覆盖：真注册了却不在表里 ⇒ 必须出现在 offenders（这条出错的话，整张门禁对未来的包是瞎的）
  const fakeRegistered = adapterPackagesIn([
    { rel: "forge-trae-direct/lib/index.js", text: "ctx.llm.registerAdapter(a)" },
    { rel: "forge-newadapter/lib/index.js", text: "ctx.llm.registerAdapter(a)" },
  ])
  const uncoveredFake = [...fakeRegistered].filter((p) => !ADAPTERS.some((a) => a.pkg === p))
  t(`C0：登记表外的新适配器包被点名（认出的包 ${[...fakeRegistered].join("/")} ⇒ 表外 ${uncoveredFake.join("/") || "无"}）`,
    uncoveredFake.includes("forge-newadapter") && !uncoveredFake.includes("forge-trae-direct"))

  // ⑪ 违规集合的键必须含规则号：同包换规则不许被当成"同一条债"
  t("基线键含规则号（C1→C2 的漂移不会伪装成仍欠着旧账）", offenderKey({ rule: "C1", pkg: "p" }) !== offenderKey({ rule: "C2", pkg: "p" }))
  // ⑫ 出站探针的正则：三种常见形态都认，纯文本载荷不认
  t("wire 形态：image_url / input_image 两种部件都认，纯文本正文里写这个词不认",
    WIRE_IMAGE_RE.test('{"type":"image_url","image_url":{"url":"data:image/png;base64,AA"}}') &&
    WIRE_IMAGE_RE.test('{"type":"input_image","input_image":{"url":"x"}}') &&
    !WIRE_IMAGE_RE.test('{"type":"text","text":"请描述这张图，参考 image_url 字段"}') &&
    !WIRE_IMAGE_RE.test('{"type":"text","text":"[图片未能读取：abc]"}\n{"role":"user","content":"见 image_url"}'))

  // ⑬ ISS-724：新落点 `.agents/worktrees`（两段）。SKIP_DIR 是**按路径段**的正则，两段要能命中；
  //    而 `.agents/skills` 不是工作树，误杀会让技能目录下的样例源码从 C0 覆盖里消失。
  t("ISS-724：.agents/worktrees 段照排、.agents/skills 不许误杀",
    SKIP_DIR.test("/.agents/worktrees/ISS-1/forge-x/lib/index.js") &&
    SKIP_DIR.test("/.agents/worktrees") &&
    !SKIP_DIR.test("/.agents/skills/reviewer/lib/index.js") &&
    !SKIP_DIR.test("/forge-x/a.agents/worktrees/b.js"))

  const bad = cases.filter((c) => !c.pass)
  console.log("lint-capability-contract --selftest")
  for (const c of cases) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}`)
  console.log(bad.length ? `\n✗ 反向验证失败 ${bad.length}/${cases.length} 项 —— 判据没牙，别接进闸` : `\n✓ ${cases.length}/${cases.length} 项通过：C1/C2 都能红能绿、unjudged 不冒充绿、C0 覆盖有牙、剥注释不误伤`)
  return bad.length ? 1 : 0
}

if (MODE === "selftest") process.exit(selftest())

/* ───────────────────────────── 主流程（--write / --check） ───────────────────────────── */
const r = await collectFindings()
/* fail closed：扫描面塌缩 = 判据失效，**拒绝报绿**（同 `lint-channel-contract` 的 ISS-572 教训：
   塌缩的守卫打 ✓ exit 0，比没守卫更坏）。两个条件缺一不可：源文件为 0 / 一个适配器包都没认出。 */
if (!r.scanned || !r.registered.length) {
  console.error(`✗ 扫描面塌缩：源文件 ${r.scanned} 个 · 认出的适配器包 ${r.registered.length} 个 —— 这不是「零违例」，是判据坏了。`)
  console.error(`  ROOT=${ROOT}`)
  console.error("  该查什么：① --root 传的路径对不对 ② 是否跑在仓内工作树（<主仓>/.wt/<ISS>）③ 源码排除规则是否把包目录整个剪掉")
  process.exit(2)
}

const countBy = (rule) => r.offenders.filter((o) => o.rule === rule).length
const summary = `能力契约 · 适配器包 ${r.registered.length} 个（登记 ${ADAPTERS.length} · 表外 ${r.uncovered.length}）· C0 未覆盖 ${countBy("C0")} · C1 声明发不出 ${countBy("C1")} · C2 缺字段 ${countBy("C2")} · 判不了 ${r.unjudged.length}`

if (ARGV.includes("--json")) {
  console.log(JSON.stringify({ root: ROOT, summary, ...r }, null, 1))
  process.exit(0)
}

console.log(summary)
console.log(`  扫描面：源文件 ${r.scanned} 个 · 注册适配器的包 ${r.registered.join(" / ") || "(无)"}`)
if (r.vanished.length) console.log(`  ○ 登记表里这些包已不再注册适配器（该从表里摘）：${r.vanished.join(" / ")}`)
for (const o of r.offenders) console.log(`  ✗ ${o.rule} ${o.pkg} —— ${o.detail}`)
for (const u of r.unjudged) console.log(`  ⚑ 判不了 ${u.pkg} —— ${u.reason}（判不了 ≠ 通过；探针环境缺失时它不进绿也不进红）`)

if (MODE === "write") {
  const prev = loadBaseline()
  const items = r.offenders.map((o) => ({ rule: o.rule, pkg: o.pkg, detail: o.detail })).sort((a, b) => offenderKey(a).localeCompare(offenderKey(b)))
  const prevKeys = new Set((prev?.offenders || []).map(offenderKey))
  const raised = items.filter((o) => !prevKeys.has(offenderKey(o)))
  const next = {
    _comment:
      "能力契约存量债（ISS-681）。记的是「当下确实还不合契约」的 (规则, 包)，**不是放行许可**：只许降不许升，" +
      "修好一条就从这里删一条（--write 复录）。数字口径 = 违规的 (规则号, 包) 集合，不是条数 —— 一条修好 + 一条新增不许对冲成绿。" +
      "C1=声明 image 却发不出图 · C2=inputModalities 缺字段（= undefined = 引擎放行）· C0=登记表外的适配器包。" +
      "unjudged 也要同步登记：探不了的包比基线上多 ⇒ 判红（否则「环境坏了」会永久伪装成「没问题」）。",
    tool: "lint-capability-contract.mjs",
    recordedAt: new Date().toISOString(),
    adapters: ADAPTERS.map((a) => a.pkg),
    unjudged: r.unjudged.map((u) => ({ pkg: u.pkg, reason: u.reason })),
    offenders: items,
  }
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify(next, null, 1) + "\n")
  console.log(`✓ 已录基线：${items.length} 条（C0 ${countBy("C0")} · C1 ${countBy("C1")} · C2 ${countBy("C2")}）· 判不了 ${r.unjudged.length} → ${path.relative(ROOT, BASELINE)}`)
  if (raised.length) console.log(`  ⚠ 本次比上次登记多 ${raised.length} 条：${raised.map(offenderKey).join(" / ")} —— 逐条确认是"本来就欠着"还是"你刚造的"`)
  process.exit(0)
}

/* --check：**新增即红**。按 (规则, 包) 集合比，不按条数（条数涨了但集合变好了也不算新增）。 */
const baseline = loadBaseline()
if (!baseline) {
  console.error(`✗ 缺基线（${path.relative(ROOT, BASELINE)}）—— 没基线不免检：先跑 node scripts/lint-capability-contract.mjs --write 并逐条确认为真存量`)
  process.exit(1)
}
const knownKeys = new Set((baseline.offenders || []).map(offenderKey))
const added = r.offenders.filter((o) => !knownKeys.has(offenderKey(o)))
const fixed = [...knownKeys].filter((k) => !r.offenders.some((o) => offenderKey(o) === k))
const knownUnjudged = new Set((baseline.unjudged || []).map((u) => u.pkg))
const newUnjudged = r.unjudged.filter((u) => !knownUnjudged.has(u.pkg))

if (fixed.length) console.log(`  ○ 已收紧（基线里可以删了，跑 --write 复录）：${fixed.join(" / ")}`)
/* ⚠️ 这行是**给 `gate-fast.mjs` 的机器读数口**（它按 `extract()` 抠数字比债快照）。
   形状与 `lint-channel-contract` 的计数行同款：单独一行、数字可正则、**空输出不许读成 0**
   （读不到数 ⇒ gate-fast 的 extract 返回 null ⇒ 按"判据失效"fail closed）。
   改这行的文案就必须同步改 `gate-fast.mjs` 里那条正则 —— 否则闸会静默恒绿（ISS-818 那一族）。 */
console.log(`能力契约增量：新增违规 ${added.length + newUnjudged.length}`)
if (!added.length && !newUnjudged.length) {
  console.log(`✓ 能力契约无新增违规（存量 ${knownKeys.size} 条已登记，本次新增 0）`)
  process.exit(0)
}
console.error(`✗ 能力契约新增违规 ${added.length} 条${newUnjudged.length ? ` + 新判不了 ${newUnjudged.length} 个包` : ""}`)
for (const o of added) {
  console.error(`  + ${o.rule} ${o.pkg} —— ${o.detail}`)
  console.error(`    规范：模型能力声明必须与实际出站一致。显式写 ["text"] 才是"不支持图片"；不写 = 引擎放行 = 静默丢图`)
}
for (const u of newUnjudged) {
  console.error(`  + 判不了 ${u.pkg} —— ${u.reason}`)
  console.error(`    基线里没有这个包 ⇒ 要么修好探针环境，要么 --write 登记并写明为什么它探不了（不许静默放过）`)
}
console.error("  不许为了让它绿而放宽判据或改基线（四原则：规范是底线）。")
process.exit(1)
