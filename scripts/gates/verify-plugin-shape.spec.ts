/**
 * `verify-plugin-shape` 的 spec（ISS-837）。
 *
 * 五类用例：正例 / 九条判据各一反例 / 干扰（多余元素、无关字段）/ cordis 真名（ISS-849）/ 缺输入（防扫空）。
 *
 * ⛔ 反例必须点名**具体哪一条**报红，不许只断「status === failed」——
 *    九条判据挤在同一个 failed 上时，「只坏了第 4 条」与「九条全坏」长得一样。
 */
import { EXPECTED, REQUIRED_FILES, SCOPE_PREFIX, cordisPackage, judgeManifest, judgePluginShape, type PackageInput } from "./verify-plugin-shape.ts"

let fails = 0
/** 断言条数**实测累加**，不在结尾手写拆解 —— 手写的数会和实际脱节（本文件改过一版就漂了）。 */
let total = 0
const ok = (name: string, cond: boolean) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

/** 一个 9 条全合规的 manifest。反例各改一处。 */
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "sample",
  type: EXPECTED.type,
  main: EXPECTED.main,
  types: EXPECTED.types,
  exports: { ".": { types: EXPECTED.exportsTypes, default: EXPECTED.exportsDefault } },
  peerDependencies: { [cordisPackage()]: "^4.0.0" },
  devDependencies: { [cordisPackage()]: "^4.0.0" },
  files: [...REQUIRED_FILES],
  ...over,
})

const hits = (dir: string, manifest: Record<string, unknown> | null, needle: string) =>
  judgeManifest(dir, manifest).some((d) => d.detail.includes(needle))

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-plugin-shape.spec")

  // ── 正例 ────────────────────────────────────────────────────────────
  {
    ok("正例：9 条全合规 ⇒ 0 条问题", judgeManifest("packages/a/b", good()).length === 0)
    const r = judgePluginShape([{ dir: "packages/a/b", manifest: good() }])
    ok("正例：judgePluginShape 全合规 ⇒ passed", r.status === "passed")
    ok("正例：passed 的 detail 点名包名前缀与框架依赖真名", (r.detail ?? "").includes(SCOPE_PREFIX) && (r.detail ?? "").includes(cordisPackage()))
  }

  // ── 反例①：cordis 缺 peer ──────────────────────────────────────────
  {
    const m = good()
    delete m.peerDependencies
    ok("反例①：缺 peerDependencies[cordis] ⇒ 红且点名", hits("p", m, "必须是 peerDependency"))
    ok("反例①：同一份不带出「dev 也缺」的假红", !hits("p", m, "也必须同时是 devDependency"))
  }

  // ── 反例②：cordis 缺 dev ────────────────────────────────────────────
  {
    const m = good()
    delete m.devDependencies
    ok("反例②：缺 devDependencies[cordis] ⇒ 红且点名", hits("p", m, "也必须同时是 devDependency"))
    ok("反例②：同一份不带出「peer 缺」的假红", !hits("p", m, "必须是 peerDependency"))
  }

  // ── 反例③：peer 与 dev range 不同 ───────────────────────────────────
  {
    const m = good({ devDependencies: { [cordisPackage()]: "^5.0.0" } })
    ok("反例③：peer ^4 与 dev ^5 不相同 ⇒ 红且两个 range 都点名", hits("p", m, "^4.0.0") && hits("p", m, "^5.0.0"))
    // 严格说：range 不同但两个都在 ⇒ 只报第 3 条，不重复报第 1/2 条。
    ok("反例③：只报 1 条（不把「range 不同」也算成「缺」）", judgeManifest("p", m).length === 1)
  }

  // ── 反例④⑤⑥：type / main / types 三个逐字常量 ─────────────────────
  for (const [field, bad, needle] of [
    ["type", "commonjs", `type 必须是 "${EXPECTED.type}"`],
    ["main", "dist/index.js", `main 必须是 "${EXPECTED.main}"`],
    ["types", "dist/index.d.ts", `types 必须是 "${EXPECTED.types}"`],
  ] as const) {
    const m = good({ [field]: bad })
    ok(`反例：${field} = ${bad} ⇒ 红且点名期望值`, hits("p", m, needle))
  }

  // ── 反例⑦⑧：exports["."] 两半 ──────────────────────────────────────
  {
    const m = good({ exports: { ".": { types: "./dist/index.d.ts", default: EXPECTED.exportsDefault } } })
    ok("反例⑦：exports['.'].types 写成别处 ⇒ 红且点名", hits("p", m, `exports["."].types 必须是`))
  }
  {
    const m = good({ exports: { ".": { types: EXPECTED.exportsTypes, default: "./dist/index.js" } } })
    ok("反例⑧：exports['.'].default 写成别处 ⇒ 红且点名", hits("p", m, `exports["."].default 必须是`))
  }
  {
    // 整个 exports 缺 ⇒ ⑦⑧ 都要报（不许只报一条就停）
    const d = judgeManifest("p", good({ exports: undefined }))
    ok("反例⑦⑧：exports 整块缺失 ⇒ 两半各报一条", d.filter((x) => x.detail.includes(`exports["."]`)).length === 2)
  }
  {
    // exports 是字符串形态（不是条件表）⇒ 同样判红（官方 exportFields 返回 undefined）
    const m = good({ exports: "./lib/index.js" })
    ok("反例：exports 写成字符串 ⇒ 两半都判红（官方 exportFields 同理）", judgeManifest("p", m).filter((x) => x.detail.includes(`exports["."]`)).length === 2)
  }

  // ── 反例⑨：files 三项，逐个缺 ──────────────────────────────────────
  for (const need of REQUIRED_FILES) {
    const m = good({ files: REQUIRED_FILES.filter((f) => f !== need) })
    ok(`反例⑨：files 缺 "${need}" ⇒ 红且点名`, hits("p", m, `files 必须含 "${need}"`))
  }
  {
    const m = good({ files: "lib/index.js" })
    ok("反例⑨：files 不是数组 ⇒ 红", hits("p", m, "files 必须是数组"))
  }
  {
    // 干扰：多余元素 / 顺序不同 ⇒ 简化版**不报**（完整推导才顺序敏感）。
    // 这条同时是对「简化到什么程度」的可执行记录 —— 补推导时这句会红，正好提醒改。
    const m = good({ files: ["src", "lib/types/**/*.d.ts", "lib/index.js", "lib/client.js"] })
    ok("干扰：files 多一个元素且顺序不同 ⇒ 简化版不报（完整推导见官方 :312-385）", judgeManifest("p", m).length === 0)
  }

  // ── 干扰：无关字段不许影响判定 ──────────────────────────────────────
  {
    const m = good({ description: "x", dependencies: { foo: "^1.0.0" }, dsh: { client: {} } })
    ok("干扰：无关字段（description/dependencies/dsh）⇒ 不报", judgeManifest("p", m).length === 0)
  }

  // ── cordis 用真名（ISS-849 · 老板 2026-11-16 D2 甲档）─────────────────
  //
  // 这一段的前身是「scope 参数化」：断言 cordisPackage(scope) 从 scope 派生。
  // 那条断言**正是 bug 本身** —— 它绿的时候，判据要求 @matter/cordis，而该包不存在。
  // ⇒ 现在反过来断言：真名固定、且**旧的 @matter/cordis 口径必须判红**。
  {
    ok("cordis 用真名：cordisPackage() 无参返回 @deepseek-ai/cordis", cordisPackage() === "@deepseek-ai/cordis")
    ok("cordis 用真名：包名前缀仍是 @matter/（两件事分开）", SCOPE_PREFIX === "@matter/")
    // 正例：真名双写 ⇒ 0 finding（这是「新树包照它写能过」的唯一证据）
    ok("cordis 真名双写 ⇒ 0 finding（新树 manifest 能过判据）", judgeManifest("p", good()).length === 0)
    // ⛔ 必然失败方向：照旧判据写 @matter/cordis ⇒ 必须红两条，且文案点名真名。
    const legacy = good({
      peerDependencies: { "@matter/cordis": "^4.0.0" },
      devDependencies: { "@matter/cordis": "^4.0.0" },
    })
    ok("旧口径 @matter/cordis ⇒ 红且点名真名（bug 已修的可执行记录）",
      hits("p", legacy, "@deepseek-ai/cordis 必须是 peerDependency") && hits("p", legacy, "@deepseek-ai/cordis 也必须同时是 devDependency"))
    ok("旧口径只报两条（不把 range 相同也误报成第三条）", judgeManifest("p", legacy).length === 2)
  }

  // ── 缺输入 / 防扫空：0 个包 ⇒ unjudged，不是绿 ───────────────────────
  {
    const r = judgePluginShape([])
    ok("防扫空：0 个包 ⇒ unjudged（不是绿）", r.status === "unjudged")
    ok("防扫空：理由码是 no-corpus", r.reason === "no-corpus")
    ok("防扫空：detail 说明了「0 个包」", (r.detail ?? "").includes("0 个包"))
  }

  // ── 组目录带 package.json ⇒ 红（它会绕过 packages/*/* 扫描面）──────────
  {
    const group: PackageInput = { dir: "packages/core", isGroup: true, manifest: null }
    const r = judgePluginShape([group])
    ok("反例：组目录带 package.json ⇒ 红", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("组目录不许有 package.json")))
  }

  // ── manifest 读不到 ⇒ 红（不许静默跳过这个包）────────────────────────
  {
    const r = judgePluginShape([{ dir: "packages/a/b", manifest: null }])
    ok("反例：manifest 读不到 ⇒ 红（跳过 = 静默少判一个包）", r.status === "failed")
  }

  // ── 聚合：一个坏包不许把好包的结论盖掉 ──────────────────────────────
  {
    const r = judgePluginShape([
      { dir: "packages/a/ok", manifest: good() },
      { dir: "packages/a/bad", manifest: good({ type: "commonjs" }) },
    ])
    ok("聚合：一个好包 + 一个坏包 ⇒ failed 且只报坏包那条", r.status === "failed" && (r.findings ?? []).length === 1 && (r.findings ?? [])[0].file === "packages/a/bad/package.json")
  }

  // ── 反向验证：坏包确实能红（不是所有输入都判绿）──────────────────────
  {
    const r = judgePluginShape([{ dir: "packages/a/bad", manifest: good({ main: "src/index.ts" }) }])
    ok("变异：改 main ⇒ 绿变红（判据有牙）", r.status === "failed")
  }

  console.log(fails ? `✗ ${fails} 条不成立` : `✓ spec 全过（${total} 条断言：正例 / 九条判据反例 / 干扰 / cordis 真名 / 防扫空 / 聚合 / 变异，逐条见上）`)
  return fails === 0
}
