/**
 * `verify-workspace-constraints` 的 spec（ISS-849）。
 *
 * 七类用例：正例 / 三条判据各一反例 / 干扰（外部依赖、无关字段、边界值）/ 聚合隔离 /
 *          语料归零（**必须炸**）/ 根 version 取不到 / 变异（判据有牙）。
 *
 * ⛔ 反例必须点名**具体哪一条**报红，不许只断 `status === "failed"` ——
 *    三条判据挤在同一个 failed 上时，「只坏了 private」与「三条全坏」长得一样。
 *
 * ⛔ 语料归零那条是**必然失败**用例：`packages: []` 必须 `unjudged`，
 *    断言它**不是** `passed`。少了这条，把判据改成「没包就绿」也能全绿通过。
 */
import { DEP_SECTIONS, judgeConstraints, type ConstraintsInput, type ConstraintsPackage } from "./verify-workspace-constraints.ts"

let fails = 0
/** 断言条数**实测累加**，不在结尾手写拆解 —— 手写的数会和实际脱节。 */
let total = 0
const ok = (name: string, cond: boolean) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const ROOT_VERSION = "0.0.0"

/** 一个三条全合规的 manifest。反例各改一处。 */
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "@matter/sample",
  version: ROOT_VERSION,
  private: true,
  type: "module",
  ...over,
})

const pkg = (dir: string, manifest: Record<string, unknown> | null): ConstraintsPackage => ({ dir, manifest })

/** 只喂包清单的简写（根 version 默认取 ROOT_VERSION）。 */
const judge = (packages: ConstraintsPackage[], rootVersion = ROOT_VERSION) =>
  judgeConstraints({ rootVersion, packages })

/** 有没有某条 finding 的 detail 含这个片段。 */
const hits = (input: ConstraintsInput, needle: string) =>
  (judgeConstraints(input).findings ?? []).some((f) => f.detail.includes(needle))

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-workspace-constraints.spec")

  // ── 正例 ────────────────────────────────────────────────────────────
  {
    const r = judge([pkg("packages/a/b", good())])
    ok("正例：三条全合规 ⇒ passed", r.status === "passed")
    ok("正例：0 finding", (r.findings ?? []).length === 0)
    ok("正例：detail 点名三条口径（private / version / workspace:）",
      (r.detail ?? "").includes("private") && (r.detail ?? "").includes(ROOT_VERSION) && (r.detail ?? "").includes("workspace:"))
  }

  // ── 反例①：private 不是 true ─────────────────────────────────────────
  {
    const m = good()
    delete m.private
    ok("反例①：private 缺失 ⇒ 红且点名 private", hits({ rootVersion: ROOT_VERSION, packages: [pkg("p", m)] }, "private 必须是 true"))
    ok("反例①：private: false ⇒ 也红（不是只判缺失）",
      hits({ rootVersion: ROOT_VERSION, packages: [pkg("p", good({ private: false }))] }, "private 必须是 true"))
    // 隔离：只坏① 时不许带出②③ 的假红
    ok("反例①：只报 1 条（不连坐 version / workspace 协议）", judge([pkg("p", good({ private: false }))]).findings?.length === 1)
  }

  // ── 反例②：version 与根不一致（边界值 = 差一个字符）────────────────────
  {
    ok("反例②：version 差一个字符（0.0.1 vs 根 0.0.0）⇒ 红且两个值都点名",
      hits({ rootVersion: ROOT_VERSION, packages: [pkg("p", good({ version: "0.0.1" }))] }, `期望 "${ROOT_VERSION}"，实际 "0.0.1"`))
    ok("反例②：version 缺失 ⇒ 红", hits({ rootVersion: ROOT_VERSION, packages: [pkg("p", good({ version: undefined }))] }, "version 必须与根一致"))
    ok("反例②：只报 1 条", judge([pkg("p", good({ version: "0.0.1" }))]).findings?.length === 1)
  }

  // ── 反例③：workspace 内互引没用 workspace: 协议 ───────────────────────
  {
    // 两个包：storage 与依赖它的 storage-json（依赖名在成员集合里 ⇒ 进射程）
    const storage = pkg("packages/storage/storage", good({ name: "@matter/storage" }))
    const consumer = (range: string) =>
      pkg("packages/storage/storage-json", good({ name: "@matter/storage-json", dependencies: { "@matter/storage": range } }))

    ok("反例③：互引写 ^0.0.1 ⇒ 红且点名字段与怎么改",
      hits({ rootVersion: ROOT_VERSION, packages: [storage, consumer("^0.0.1")] },
        `dependencies["@matter/storage"] 必须用 workspace: 协议（实际 "^0.0.1"）`))
    ok("反例③：可见文案含修法（改成 \"workspace:*\"）",
      hits({ rootVersion: ROOT_VERSION, packages: [storage, consumer("^0.0.1")] }, '改成 "workspace:*"'))
    ok("反例③：写 workspace:* ⇒ 不报", judgeConstraints({ rootVersion: ROOT_VERSION, packages: [storage, consumer("workspace:*")] }).status === "passed")
    ok("反例③：写 workspace:^（带 range 的协议形态）⇒ 不报",
      judgeConstraints({ rootVersion: ROOT_VERSION, packages: [storage, consumer("workspace:^")] }).status === "passed")
    // 四个依赖段都要扫 —— 只扫 dependencies 会漏掉 peer/dev/optional 里的一条
    for (const section of DEP_SECTIONS) {
      ok(`反例③：${section} 里的互引也判（四处都扫）`,
        hits({ rootVersion: ROOT_VERSION, packages: [storage, pkg("packages/x/y", good({ name: "@matter/x", [section]: { "@matter/storage": "^0.0.1" } }))] },
          `${section}["@matter/storage"]`))
    }
  }

  // ── 干扰：外部依赖 / 无关字段不许影响判定 ──────────────────────────────
  {
    // 这是最关键的一条干扰：@deepseek-ai/cordis 不在成员里 ⇒ 归 plugin-shape 管，本判据不碰。
    const m = good({
      peerDependencies: { "@deepseek-ai/cordis": "^4.1.0" },
      devDependencies: { "@deepseek-ai/cordis": "^4.1.0", typescript: "^6.0.3" },
    })
    ok("干扰：外部依赖（cordis / typescript）不归本判据 ⇒ 不报", judge([pkg("p", m)]).status === "passed")
    ok("干扰：无关字段（description/dsh/files）⇒ 不报",
      judge([pkg("p", good({ description: "x", files: ["src"], dsh: { client: {} } }))]).status === "passed")
    // 边界：range 写成非字符串（数组 / null）时，只要不是 workspace: 前缀就必须红 —— 不许静默跳过。
    ok("干扰：互引 range 是数组形态 ⇒ 仍判红（不静默跳过）",
      judgeConstraints({ rootVersion: ROOT_VERSION, packages: [
        pkg("packages/s/a", good({ name: "@matter/a" })),
        pkg("packages/s/b", good({ name: "@matter/b", dependencies: { "@matter/a": ["workspace:*"] } })),
      ] }).status === "failed")
  }

  // ── 聚合与隔离：一个好包 + 一个坏包，不许互相盖掉 ──────────────────────
  {
    const r = judge([
      pkg("packages/a/ok", good()),
      pkg("packages/a/bad", good({ private: false })),
    ])
    ok("聚合：一好一坏 ⇒ failed 且只报坏包那条", r.status === "failed" && (r.findings ?? []).length === 1 && (r.findings ?? [])[0].file === "packages/a/bad/package.json")
    // 三条同时坏 ⇒ 三条各报一次（不许合并成一条）
    const all = judge([pkg("packages/a/terrible", { name: "@matter/terrible" })])
    ok("聚合：三条全坏 ⇒ 至少报 private 与 version 两条（各条独立判）",
      (all.findings ?? []).filter((f) => f.detail.includes("private")).length === 1 &&
      (all.findings ?? []).filter((f) => f.detail.includes("version")).length === 1)
  }

  // ── manifest 读不到 ⇒ 红（不许静默跳过这个包）──────────────────────────
  {
    const r = judge([pkg("packages/a/b", null)])
    ok("反例：manifest 读不到 ⇒ 红（跳过 = 静默少判一个包）", r.status === "failed")
    ok("反例：文案说明是按红处理，不是忽略", (r.findings ?? []).some((f) => f.detail.includes("按红处理")))
  }

  // ── ⛔ 语料归零：必须炸，不许绿 ──────────────────────────────────────
  {
    const r = judge([])
    ok("语料归零：0 个包 ⇒ unjudged（不是 passed）", r.status === "unjudged")
    ok("语料归零：status 严格不等于 passed（必然失败用例）", r.status !== "passed")
    ok("语料归零：理由码是 no-corpus", r.reason === "no-corpus")
    ok("语料归零：detail 说明了「0 个包」", (r.detail ?? "").includes("0 个包"))
  }

  // ── 根 version 取不到 ⇒ 判不了（不许假装 version 一致已验）──────────────
  {
    const r = judge([pkg("packages/a/b", good())], "")
    ok("根 version 空 ⇒ unjudged（不是绿）", r.status === "unjudged")
    ok("根 version 空：文案点名第 ② 条判据无从判", (r.detail ?? "").includes("version"))
  }

  // ── 变异：改一处 ⇒ 绿变红（判据有牙，且红的定位到那个文件）──────────────
  {
    const clean: ConstraintsInput = { rootVersion: ROOT_VERSION, packages: [pkg("packages/a/b", good())] }
    ok("变异：干净语料先绿（基线）", judgeConstraints(clean).status === "passed")

    const mutated: ConstraintsInput = { rootVersion: ROOT_VERSION, packages: [pkg("packages/a/b", good({ private: false }))] }
    const m = judgeConstraints(mutated)
    ok("变异：private 改 false ⇒ 绿变红", m.status === "failed")
    // 一条 finding 四个要素：文件 · 期望 · 实际 false · 怎么改（"加"）。缺任一条，读它的人还得自己反推。
    ok("变异：红的信息含文件 + 期望 + 实际 + 怎么改",
      (m.findings ?? []).length === 1 &&
      m.findings![0]!.file === "packages/a/b/package.json" &&
      m.findings![0]!.detail.includes("private 必须是 true") &&
      m.findings![0]!.detail.includes("false") &&
      m.findings![0]!.detail.includes("加"))
  }

  console.log(fails ? `✗ ${fails} 条不成立` : `✓ spec 全过（${total} 条断言：正例 / 三条判据各反例 / 干扰 / 聚合 / 语料归零 / 根 version / 变异，逐条见上）`)
  return fails === 0
}
