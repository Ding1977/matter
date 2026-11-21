/**
 * `verify-coverage-collect.ts` 的自检向量（ISS-513）。
 *
 * 本判据的**全部价值在反向用例**：正向「采到了 ⇒ 绿」太容易，跑一次就绿。
 * 必须证明「采集断了 ⇒ 必红」，否则它只是又一格永远绿的空检查 —— 而这一格存在的理由
 * 恰恰是「上一版覆盖率注释连自己断了三个月都没人发现」。
 *
 * 四类用例（同 `verify-exit-codes.spec.ts` 的口径）：
 *   正例 / 反例 / 干扰（边界）/ 缺输入。
 * 其中三条是**必然失败**（一定会红）的向量：
 *   · 报告不存在            · 报告是 `{}`（旧注释记录的那个形态）
 *   · 旧树采到、新树 0 条   · 报告不是合法 JSON
 * 最后两条实仓用例证明「真产物也过」—— 纯函数全绿而真仓红 = 判据没接上。
 *
 * ⚠️ 一处必须讲清的口径：实仓用例**自己起一次采集**（`collect`），不是读上次残留的
 *    `coverage/coverage-summary.json`。读残留会让本 spec 在「没跑过覆盖率」的干净树上
 *    对着一个陈旧的绿文件断言 —— 那是假绿。
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_ARGS, judgeCoverageCollect, SUMMARY_REL, zeroCoveragePackages, type Inputs } from "./verify-coverage-collect.ts"
import { NEXT_PACKAGE_PROBES } from "../lib/next-packages-probes.mjs"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** 一条合法的最小 summary：一个旧树文件 + 一个新树文件。 */
const GOOD = JSON.stringify({
  total: { lines: { total: 10, covered: 8, skipped: 0, pct: 80 }, statements: { total: 10, covered: 8, pct: 80 } },
  "/repo/forge-model/src/a.ts": { lines: { total: 5, covered: 4, skipped: 0, pct: 80 }, statements: { total: 5, covered: 4, pct: 80 } },
  "/repo/packages/storage/storage/src/index.ts": { lines: { total: 5, covered: 4, skipped: 0, pct: 80 }, statements: { total: 5, covered: 4, pct: 80 } },
})

/**
 * ISS-875 的坏样本：新树里有一个包**整包 0%**（其它正常）。
 * 形态照抄 2026-11-18 实测 —— `@matter/issue` 落进 `coverage.include` 射程，
 * 但合并后没在树里跑过 `pnpm install` ⇒ 包级 node_modules 未建 ⇒ 测试连 import 都失败 ⇒ 129 条语句全 0%。
 */
const ZERO_PKG = JSON.stringify({
  total: { statements: { total: 20, covered: 10, pct: 50 } },
  "/repo/packages/storage/storage/src/index.ts": { statements: { total: 10, covered: 10, pct: 100 } },
  "/repo/packages/pm/issue/src/index.ts": { statements: { total: 6, covered: 0, pct: 0 } },
  "/repo/packages/pm/issue/src/spec.ts": { statements: { total: 4, covered: 0, pct: 0 } },
})

/** 纯类型文件（`S 0/0`）不该被判 0% —— 那是空真，不是缺陷。 */
const TYPE_ONLY = JSON.stringify({
  total: { statements: { total: 5, covered: 5, pct: 100 } },
  "/repo/packages/x/y/src/index.ts": { statements: { total: 5, covered: 5, pct: 100 } },
  "/repo/packages/x/y/src/types.ts": { statements: { total: 0, covered: 0, pct: 100 } },
})

function base(over: Partial<Inputs> = {}): Inputs {
  return { summary: GOOD, exitCode: 0, ...over }
}

/** 只跑纯函数用例（不需要 vitest，毫秒级）。 */
export function run(): boolean {
  const cases: [string, boolean, string?][] = []
  const t = (name: string, ok: boolean, note?: string) => cases.push([name, ok, note])

  // ── 正向 ───────────────────────────────────────────────────────
  const ok = judgeCoverageCollect(base())
  t("正向：有报告、条目 > 0、新树在射程 ⇒ passed", ok.status === "passed", `实得 ${ok.status}`)
  t("正向：pass 时 detail 带上新树条数（不静默）", /新树 1 个/.test(ok.detail ?? ""), `实得 ${JSON.stringify(ok.detail)}`)

  // ── 必然失败 ①：报告不存在 ─────────────────────────────────────
  const missing = judgeCoverageCollect(base({ summary: null, exitCode: 0 }))
  t("反例：coverage-summary.json 不存在 ⇒ failed（采集没产出）", missing.status === "failed", `实得 ${missing.status}`)
  t("反例：缺报告的文案指名文件与产出方式", /coverage-summary\.json/.test(missing.findings?.[0]?.detail ?? "") && /--coverage/.test(missing.findings?.[0]?.detail ?? ""), `实得 ${missing.findings?.[0]?.detail}`)

  // ── 必然失败 ②：报告是 `{}`（旧注释记录的那个形态）─────────────────
  const empty = judgeCoverageCollect(base({ summary: "{}", exitCode: 0 }))
  t("反例：报告是 {}（0 个文件）⇒ failed", empty.status === "failed", `实得 ${empty.status}`)
  t("反例：零射程的文案含「零个文件在射程」与 wt 那条真因", /零个文件在射程/.test(empty.findings?.[0]?.detail ?? ""), `实得 ${empty.findings?.[0]?.detail}`)

  // ── 必然失败 ③：旧树采到、新树 0 条（本判据要防的那件事本身）────────
  const oldOnly = JSON.stringify({
    total: {},
    "/repo/forge-model/src/a.ts": {},
    "/repo/forge-pm/src/b.ts": {},
  })
  const stale = judgeCoverageCollect(base({ summary: oldOnly }))
  t("反例：旧树 2 条、新树 0 条 ⇒ failed（总数绿不能替新树在射程）", stale.status === "failed", `实得 ${stale.status}`)
  t("反例：新树掉队的文案含「新树 0 个文件在射程」", /新树 0 个文件在射程/.test(stale.findings?.[0]?.detail ?? ""), `实得 ${stale.findings?.[0]?.detail}`)

  // ── 必然失败 ⑤（ISS-875）：有源文件在射程、却 0% 覆盖（包落地但测试没跑）──
  // 这一条是「条目 > 0」判不到的形态：总量够、新树也有条目，但某个包**整包 0%**。
  const zero = judgeCoverageCollect(base({ summary: ZERO_PKG, exitCode: 0 }))
  t("反例：新树里某包 0% 覆盖 ⇒ failed（不只是『条目 > 0』）", zero.status === "failed", `实得 ${zero.status}`)
  t("反例：0% 的文案点名到**包**并给三条常见原因",
    (zero.findings ?? []).some((f) => /packages\/pm\/issue/.test(f.file) && /pnpm install/.test(f.detail)),
    `实得 ${JSON.stringify(zero.findings?.map((f) => f.file))}`)
  t("反例：同包的多个 0% 文件合并成**一条**包级 finding（v8 单行恒等函数盲区要求包级判）",
    (zero.findings ?? []).length === 1, `实得 ${(zero.findings ?? []).length} 条`)

  // ── 边界：纯类型文件 S 0/0 ⇒ **不**判 0%（空真）──────────────────
  const typeOnly = judgeCoverageCollect(base({ summary: TYPE_ONLY, exitCode: 0 }))
  t("边界：纯类型文件 S 0/0 不算 0% 覆盖（空真，判它必红会造出无法修的假红）",
    typeOnly.status === "passed", `实得 ${typeOnly.status}`)

  // ── 纯函数 zeroCoveragePackages 的直接用例（不经 judgeCoverageCollect）────
  t("zeroCoveragePackages：整包 0% ⇒ 命中该包（带文件数与语句数）",
    zeroCoveragePackages(ZERO_PKG, ["/repo/packages/pm/issue/src/index.ts", "/repo/packages/pm/issue/src/spec.ts", "/repo/packages/storage/storage/src/index.ts"])
      .map((z) => `${z.pkg}:${z.files}:${z.total}`).join(",") === "packages/pm/issue:2:10",
    `实得 ${JSON.stringify(zeroCoveragePackages(ZERO_PKG, ["/repo/packages/pm/issue/src/index.ts"]))}`)
  t("zeroCoveragePackages：**单文件 0% 但同包其它文件有覆盖 ⇒ 不判**（v8 单行恒等函数盲区）",
    zeroCoveragePackages(JSON.stringify({
      "/repo/packages/x/y/src/a.ts": { statements: { total: 1, covered: 0 } },
      "/repo/packages/x/y/src/b.ts": { statements: { total: 5, covered: 5 } },
    }), ["/repo/packages/x/y/src/a.ts", "/repo/packages/x/y/src/b.ts"]).length === 0)
  t("zeroCoveragePackages：summary 为 null ⇒ 空（交给上游判『没产出』）", zeroCoveragePackages(null, ["/a"]).length === 0)
  t("zeroCoveragePackages：坏 JSON ⇒ 空（不在这里编一个红）", zeroCoveragePackages("{oops", ["/a"]).length === 0)

  // ── 必然失败 ④：报告不是合法 JSON ──────────────────────────────
  const broken = judgeCoverageCollect(base({ summary: "{not json", exitCode: 0 }))
  t("反例：报告不可解析 ⇒ failed（reporter 被换掉）", broken.status === "failed", `实得 ${broken.status}`)

  // ── 边界：只有 total 没有文件条目 ⇒ 红（不是「总条目 1」）──────────
  const totalOnly = judgeCoverageCollect(base({ summary: JSON.stringify({ total: {} }) }))
  t("边界：只有 total 键 ⇒ failed（total 不是文件）", totalOnly.status === "failed", `实得 ${totalOnly.status}`)

  // ── 边界：测试红了但采到了 ⇒ 绿 + 提示（本格只管采集，不管测试红）──
  const redTests = judgeCoverageCollect(base({ exitCode: 1 }))
  t("边界：vitest 退出码 1 但采到了 ⇒ passed（测试红归别的格）", redTests.status === "passed", `实得 ${redTests.status}`)
  t("边界：但必须提示退出码，不静默吞掉", /退出码 1/.test(redTests.detail ?? ""), `实得 ${JSON.stringify(redTests.detail)}`)

  // ── 实仓：真跑一次采集（纯函数全绿而真仓红 = 判据没接上）────────────
  // ⚠️ 缺 build 产物是合法环境态（ISS-899）：本组真跑 vitest，而 vitest resolve @matter/*
  //    需要 lib/ 产物（gitignore）—— CI 的 gate-selftests lane 不 build（DOC-517 §五.5
  //    口径：selfcheck 走构造语料），冷 checkout 起不来。环境态单列「未跑」不判红不冒绿；
  //    端到端链路在 CI 由 coverage lane（ISS-898）承担，本地 build 过则本组照常全验。
  //    探测复用 next 档的 next-build 探针（同一公式：全部包的 lib/index.js 都在才算 built）。
  const skipped: string[] = []
  if (!NEXT_PACKAGE_PROBES["next-build"](REPO)) {
    skipped.push("实仓 2 条未跑：无 build 产物（先 pnpm run build 复跑可全验；CI 冷 checkout 的端到端由 coverage lane 承担）")
  } else {
    const real = collectReal()
    if (real === null) {
      t("实仓：判不了 —— 缺 node_modules/.bin/vitest（未装依赖）", false, "装依赖后重跑：pnpm install")
    } else {
      const verdict = judgeCoverageCollect(real)
      t("实仓：真跑一次 --coverage 后判 passed", verdict.status === "passed",
        `实得 ${verdict.status}；${verdict.findings?.map((f) => f.detail).join("；") ?? verdict.detail ?? ""}`)
      if (verdict.status === "passed") {
        const n = real.summary ? Object.keys(JSON.parse(real.summary)).filter((k) => k !== "total").length : 0
        t("实仓：采到的条目数 > 0（不是靠残留旧文件）", n > 0, `实得 ${n} 条`)
      }
    }
  }

  const bad = cases.filter((c) => !c[1])
  for (const [n, okk, note] of cases) console.log(`${okk ? "✓" : "✗"} ${n}${okk ? "" : `\n    ↳ ${note ?? "（未给实际值）"}`}`)
  for (const s of skipped) console.log(`- ${s}（单列，不并入绿）`)
  console.log(`\nverify-coverage-collect selftest ${cases.length - bad.length}/${cases.length} 通过${skipped.length ? ` · 另有 ${skipped.length} 条未跑（缺产物，单列不并入绿）` : ""}`)
  return bad.length === 0
}

/**
 * 真跑一次采集并读产物。返回 null = 没有 vitest 二进制（判不了，不冒充通过）。
 *
 * ⚠️ 先删旧报告：`--coverage` 不保证覆盖上一次的产物形态，读残留等于用上次的绿灯
 *    给这次背书。
 */
function collectReal(): Inputs | null {
  const bin = path.join(REPO, "node_modules/.bin/vitest")
  if (!fs.existsSync(bin)) return null
  const summaryAbs = path.join(REPO, SUMMARY_REL)
  fs.rmSync(summaryAbs, { force: true })
  // ⚠️ ISS-875：必须跟 `DEFAULT_ARGS` 同射程（`packages`），**不能写死某个组**。
  //   写死 `packages/storage` 时，其它包的源文件仍在 `coverage.include` 射程里 ⇒ 按 0% 进分母
  //   ⇒ 新的「0% 判红」会对着**这个 spec 自己的窄射程**报一堆假红（实测：4 条 0%）。
  const r = spawnSync(bin, DEFAULT_ARGS, { cwd: REPO, encoding: "utf8", timeout: 600_000 })
  let summary: string | null = null
  try {
    summary = fs.readFileSync(summaryAbs, "utf8")
  } catch {
    summary = null
  }
  return { summary, exitCode: r.status, tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").slice(-6).join(" / ") }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(run() ? 0 : 1)
}
