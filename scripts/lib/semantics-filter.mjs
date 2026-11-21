// 门禁语义标签 + `--semantics` 过滤（ISS-821 · 计划 ISS-D）
//
// 为什么要有这一层：`tiers`（fast / full / ci / gateselfcheck）分的是**快慢**，
// 回答「什么时候跑」；但「红意味着什么」在四档里没有承载位 —— 改一页文档与改一个产物，
// 在 `--tier full` 里长得一模一样。官方 DSH 用 19 个 Mode 表达这件事（ci-static / ci-unit /
// ci-artifacts / doc-sync / hygiene / …），我们裁到**实际有的**几种。
//
// ⛔ 不为对齐而造空语义：官方有 `coverage` / `bench` / `i18n` / 三个 windows 档，
//    我们一格都没有 ⇒ 本表里没有这几个名字。加空语义的后果是「跑了一格也没红」被读成「这类检查通过」。
//
// 语义 ≠ 档位：本文件只管「这格的红说明什么问题」，**不新增档位、不改 tiers 的算法**。
// 老板 2026-11-13 拍的「保留四档 + 加语义标签」就是这个形状。
//
// 本文件是纯函数 + 一张词表（`SEMANTICS`），调度器 `run-gates.mjs` 只调用、不复制逻辑 ——
// 那个文件有 `verify-file-size.ts` 的只许降棘轮，历史五次加功能都是抽出去而不是抬 ceiling。

/**
 * 语义词表 —— **唯一真相源**。
 *
 * `red`：这一格红说明「什么坏了」（不是「跑了什么脚本」）。分类判据就这一条，
 * 所以两格跑同一种脚本也可能不同语义（`lint-boot-log` 与 `lint-layer` 都叫 lint，前者读运行态日志）。
 * `official`：对齐官方哪个 Mode（`null` = 官方没有对应档，别硬编一个）。
 */
export const SEMANTICS = {
  static: { red: "源码 / 配置的静态形状不合规（规则、命名、依赖方向、类型）", official: "ci-static" },
  unit: { red: "测试没通过（单测 / 套件 / 变异测试）", official: "ci-unit" },
  contracts: { red: "声明与事实不一致（登记表、规则卡、装配、别名、挂载契约）", official: "ci-lint-contracts-ready" },
  artifacts: { red: "构建产物缺失或落后源码", official: "ci-artifacts" },
  "doc-sync": { red: "文档与索引 / 基线 / 链接不同步", official: "doc-sync" },
  hygiene: { red: "仓库或运行环境不干净（裸库、游离树、断链、明文密钥、钩子、启动失败）", official: "hygiene" },
  snapshot: { red: "库内基线快照（计数 / 指纹）漂移，现值与记录值不符", official: "ci-snapshot" },
  selftest: { red: "判据自身失去判别力（反向验证没抓住该抓的）", official: null },
}

export const SEMANTIC_NAMES = Object.keys(SEMANTICS)

/** 这一格声明的语义（没声明 = 空数组，由 `validateSemantics` 判红，不静默兜底）。 */
export function semanticsOf(gate) {
  return Array.isArray(gate?.semantics) ? gate.semantics : []
}

/**
 * 全格语义合法性 —— 每格至少一个，且名字都在词表里。
 *
 * ⚠️ 为什么硬判而不是「没写就当 none」：静默兜底会让「漏标」与「显式声明不适用」长得一样，
 * 而这两件事的处置完全相反（前者是配置缺项，后者是判过的结论）。要表达「哪类都不属于」请写 `["none"]`。
 *
 * @returns 问题清单（空数组 = 合格）；元素形如 `<格 id>：<原因>`
 */
export function validateSemantics(gates) {
  const out = []
  for (const g of Array.isArray(gates) ? gates : []) {
    const declared = semanticsOf(g)
    // `none` 是合法值（ISS-821 验收①原文：「或显式声明 none」）。单独放行，不进词表 ——
    // 它不是「一种红的含义」，写进词表会让 `--semantics none` 看起来像一类检查。
    if (!declared.length) {
      out.push(`${g?.id}：没有 semantics（每格必须声明，不适用请写 ["none"]）`)
      continue
    }
    for (const s of declared) {
      if (s === "none") {
        if (declared.length > 1) out.push(`${g?.id}：none 只能单独声明（与 ${declared.filter((x) => x !== "none").join("/")} 同时出现则自相矛盾）`)
        continue
      }
      if (!SEMANTIC_NAMES.includes(s)) out.push(`${g?.id}：语义 ${JSON.stringify(s)} 不在词表里（合法值：${SEMANTIC_NAMES.join(" / ")} / none）`)
    }
  }
  return out
}

/**
 * 按语义选格。
 *
 * 三种结果必须分开（都返回对象，不抛异常 —— 调度器要在起子进程之前把用法错一次判死）：
 *   `unknown`   词表里没有这个名字 ⇒ 用法错（exit 2），并列出词表
 *   `empty`     名字合法但当前档里 0 格 ⇒ 也是用法错。**绝不许「0 格 ⇒ 绿」**：
 *               那是 gateselfcheck 档踩过的同一个坑（ISS-734：空集必须判用法错）。
 *   `ok`        命中格清单
 */
export function filterBySemantics(gates, name) {
  const list = Array.isArray(gates) ? gates : []
  if (!SEMANTIC_NAMES.includes(name) && name !== "none") return { kind: "unknown", gates: [], names: SEMANTIC_NAMES }
  const hit = list.filter((g) => semanticsOf(g).includes(name))
  if (!hit.length) return { kind: "empty", gates: [], names: SEMANTIC_NAMES }
  return { kind: "ok", gates: hit }
}

/**
 * 调度器侧的完备性闸（`buildRegistry()` 调一次；抛错 = 登记表坏了，不是某格判红）。
 *
 * ⚠️ 为什么 `ownTree` 这个开关必须有：`--repo <dir>` 指向别处时跑的是 `--diff-baseline` 的**基线树** ——
 * 那是参照物，不是交付物，它没有本单新增的字段是当然的。判它等于让 `--diff-baseline` 对任何旧基线
 * 永久报错，而 pre-push 每次都走那条路 ⇒ 所有推送被拦。当前树那一趟照判，「交付物缺语义」一格没放过。
 *
 * 抛 Error 而不是返回清单：这是配置面的错，必须起第一个子进程**之前**崩 ——
 * 若退化成「某格判红」，少标的格会混进绿计数里，屏幕上一切正常。
 */
export function assertSemantics(gates, { ownTree }) {
  if (!ownTree) return { skipped: true }
  const problems = validateSemantics(gates)
  if (!problems.length) return { skipped: false }
  const err = new Error(`[run-gates] 语义标签不合法（${problems.length} 条）：\n  · ${problems.join("\n  · ")}`)
  err.name = "RegistryError"
  err.kind = "gate-semantics-invalid"
  throw err
}

/**
 * `--semantics` 的**调度器入口**（把「选格 + 用法错文案」一起收进来）。
 *
 * 为什么要连文案一起搬：三种结局里两种是**用法错**，而用法错的文案必须说清「合法值有哪些、
 * 去哪看每类的含义」。文案留在调度器里就又是一份要跟着词表改的副本 —— 抽出来只剩一处。
 *
 * @returns `{ selected, note }` 或 `{ error }`（error 是多行文案，调用方原样印到 stderr + exit 2）
 */
export function selectBySemantics(gates, name, tier) {
  const got = filterBySemantics(gates, name)
  if (got.kind === "unknown") return { error: `✗ 未知语义：${name}（可选 ${got.names.join(" / ")} / none）\n  词表与「每类红意味着什么」见 scripts/lib/semantics-filter.mjs；--list 会印各语义格数。` }
  if (got.kind === "empty") return { error: `✗ --semantics ${name}：${tier} 档里 0 格。换档再试（--tier full），或用 --list 看分布。` }
  return { selected: got.gates, note: `（--semantics ${name}：${tier} 档 ${gates.length} 格中取 ${got.gates.length} 格）` }
}

/** 每语义覆盖几格（`--list` 与体检用；不参与判定）。 */
export function countBySemantics(gates) {
  const list = Array.isArray(gates) ? gates : []
  const out = Object.fromEntries(SEMANTIC_NAMES.map((n) => [n, 0]))
  for (const g of list) for (const s of semanticsOf(g)) if (s in out) out[s] += 1
  return out
}

/**
 * 自检向量。`run-gates --selftest` 逐条喂给它自己的 `eq`。
 *
 * ⚠️ 与 `selftestBatch()` / `selftestAllowFailure()` 同一形状、同一警告：本仓没有自动接线，
 *    这些断言只在有人手敲 `--selftest` 时执行。别把「自检绿」当成「合入前已经验过」。
 */
export function selftestSemantics() {
  const v = []
  const mk = (id, semantics) => ({ id, semantics })
  // ── 词表 ────────────────────────────────────────────────────────────────
  v.push(["词表里没有官方要有、我们一格都没有的语义（coverage / bench / i18n 不造空语义）", ["coverage", "bench", "i18n", "ci-coverage"].filter((n) => SEMANTIC_NAMES.includes(n)), []])
  v.push(["词表每个语义都写了「红意味着什么」", SEMANTIC_NAMES.filter((n) => !SEMANTICS[n].red?.trim()), []])
  v.push(["selftest 语义显式标了官方无对应档", SEMANTICS.selftest.official, null])
  // ── 合法性 ──────────────────────────────────────────────────────────────
  v.push(["反证：没写 semantics 的格被抓到", validateSemantics([mk("g1", undefined)]), ["g1：没有 semantics（每格必须声明，不适用请写 [\"none\"]）"]])
  v.push(["反证：写了空数组也当没写（不许用 [] 冒充声明）", validateSemantics([mk("g2", [])]).length, 1])
  v.push(["反证：词表外的名字被抓到", validateSemantics([mk("g3", ["lint"])]).length, 1])
  v.push(["反面：词表内的名字通过", validateSemantics([mk("g4", ["static"])]), []])
  v.push(["反面：显式 none 通过（验收①的原文口径）", validateSemantics([mk("g5", ["none"])]), []])
  v.push(["反证：none 与真语义同列自相矛盾 ⇒ 报", validateSemantics([mk("g6", ["none", "static"])]).length, 1])
  // ── 过滤三态 ────────────────────────────────────────────────────────────
  const sample = [mk("a", ["static"]), mk("b", ["static", "unit"]), mk("c", ["doc-sync"]), mk("d", ["none"])]
  v.push(["过滤：命中格按声明取（core 与次要语义都算）", filterBySemantics(sample, "static").gates.map((g) => g.id), ["a", "b"]])
  v.push(["过滤：只按声明取，不按 id 猜", filterBySemantics(sample, "doc-sync").gates.map((g) => g.id), ["c"]])
  v.push(["过滤：不适用格（none）不进任何真语义", SEMANTIC_NAMES.filter((n) => filterBySemantics(sample, n).gates.some((g) => g.id === "d")), []])
  v.push(["反证：词表外的语义名 ⇒ unknown（不静默空跑）", filterBySemantics(sample, "nope").kind, "unknown"])
  v.push(["反证：名字合法但 0 格 ⇒ empty（绝不当绿）", filterBySemantics([mk("a", ["static"])], "unit").kind, "empty"])
  v.push(["反面：正常命中 ⇒ ok", filterBySemantics(sample, "unit").kind, "ok"])
  // ── 计数 ────────────────────────────────────────────────────────────────
  // sample 有 4 格：a=static / b=static+unit / c=doc-sync / d=none ⇒ 真语义计数 2+1+1=4（d 不计）
  v.push(["计数：一格两语义各计一次（static 命中 a 与 b）", countBySemantics(sample).static, 2])
  v.push(["计数：none 不计入任何语义（总和 4 > 格数 3 才是对的）", Object.values(countBySemantics(sample)).reduce((s, n) => s + n, 0), 4])
  return v
}
