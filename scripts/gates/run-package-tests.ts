/**
 * 新树测试判据（ISS-866）—— `next` 档唯一一格**跑测试**的判据。
 *
 * ## 为什么这一格必须存在
 *
 * 老板 2026-11-17：「我们现在的开发以门禁变绿为目标了，代码通不通、功能是否全反而服务于门禁。」
 * 实测就是这个形态：
 *
 *   grep 'vitest' scripts/run-gates.mjs      → 0 命中
 *   scripts/git-hooks/pre-push 明文          → 「⚠️ 只带 typecheck，不带 test」
 *   scripts/selfcheck.mjs 的 notCovered 自认 → 「test（vitest 全量）」
 *
 * ⇒ `next` 档 11 格里 **没有一格在跑测试**。`storage-domain` 在主 checkout 根本 import
 * 不起来（缺 `lib/`），而 9 格照样全绿 —— 判据全对、代码跑不起来。
 *
 * ## 射程：只跑新树，绝不跑旧树
 *
 * 老板定：「可以，新树本来就不应该跑旧树的测试」。
 * 本格只扫 `packages/<group>/<pkg>/tests/**`（实测 9 文件 / 149 断言 / 1.07s）。
 * ⛔ 全仓 542 个测试文件跑完是分钟级，且 `forge-…` 是旧树 —— 那既慢又不是本格的目标。
 *
 * ## 四种「不是全绿」的形态，各自如实报
 *
 * | 形态 | 退出码 | 为什么 |
 * |---|---|---|
 * | 有断言真红了 | 1 | 就是测试没通过 |
 * | **缺依赖**（`Cannot find package` 一族，ISS-875） | 1 | 本树没跑过 `pnpm install` ⇒ 环境坏了且**可修**；CI 每次全新 install 踩不到、本地必踩 —— 「CI 绿本地红」的元凶就是当时没人红 |
 * | **0 个测试文件** | 2 | 分母为 0，不许判绿 |
 * | **全部包都跑不起来**（缺构建） | 2 | 一个断言都没跑 ⇒ 分母为 0，不许判绿 |
 * | **部分包跑不起来**（缺构建） | 0 + 出声 | 见下 |
 *
 * ### 为什么「部分包跑不起来」判绿而不是判不了
 *
 * 主 checkout 从不构建（`AGENTS.md` 只要求改过 `lib/**` 的包在重启前构建），
 * 所以**合并一个新包后主 checkout 必然没它的产物** —— 那是环境常态，不是缺陷。
 * 实测（2026-11-17 主 checkout）：4 个包里 2 个缺 `lib/`、2 个能跑，**111 个断言真跑了**。
 * 为跑不起来的 2 个包把真跑起来的 111 个断言一起废成「判不了」，等于让常态把有用读数吃掉。
 *
 * ⚠️ 但「跳过」必须比「通过」更刺眼 —— 今天 `storage-domain` 跑不起来时屏幕上只有
 * 一行 `(0 test)`，**没人注意到**。故本格在 passed 的 detail 里**逐包点名**谁没跑、缺什么、怎么补。
 *
 * ### 为什么「缺依赖」红而「缺构建产物」不红（ISS-875）
 *
 * 同是「跑不起来」，缺的料不同，处置就不同：
 *   · 缺**构建产物**是主 checkout 常态（从不构建）⇒ 维持 0 + 出声，不把常态变红；
 *   · 缺**依赖**是**本树**没跑过 `pnpm install` —— 判据跑在哪个树，哪个树就该装好依赖。
 *     实证（ISS-875，E-0 `@matter/issue` 合并后）：包级 `node_modules` 不存在 ⇒ 3 个测试文件
 *     `Cannot find package '@matter/storage'` ⇒ 覆盖率整包 0% 而门禁当时全绿；CI 因每次全新
 *     install 永远踩不到，只在本地复现。⇒ 判红 + 文案直说「跑 corepack pnpm install」，
 *     不让实施者自己从「整包 0%」推根因。
 *   · ⚠️ 报文实测（vitest 4.1.8 json reporter / node 24）：装载失败文件的 message 是
 *     `Cannot find package 'X' imported from <abs>` —— **单引号**。旧正则按双引号写，
 *     这条特征从未命中过真实报文（本单修正）。且**只认裸包名**：`Cannot find module './x.ts'`
 *     （相对/绝对路径）是文件没找到，不是缺依赖 —— 把它指到「跑 pnpm install」是指错修法。
 *
 * ### ⛔ 与 ISS-864 的关系（不重复那个坑）
 *
 * ISS-864 的教训：台账票的 `unjudgedKind` 必须**与实际缺的料同向**，否则 `xfail_strict`
 * 把一条真判据判成化石。本格的 unjudged 只有「0 个测试文件」一种，故票的探针必须问
 * 「`packages/*​/*​/tests` 下有没有测试文件」这一个问题 —— 不借 `next-src-corpus` 代打
 * （src 在有测试前就先有了，借它会在「有 src 还没写测试」那一态报假化石）。
 *
 * ## 退出码（口径见 `scripts/lib/gate-runtime.ts`）
 *   0 = 绿 · 1 = 有断言红或缺依赖（红，文案给「怎么改」） · 2 = 判不了（0 个测试文件 / 全部包缺构建 / 缺 vitest）
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "run-package-tests"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
/** 射程根：只扫这里。⛔ 不含 `forge-…` 旧树（536 个测试文件）。 */
export const SCOPE_ROOT = "packages"

/** 测试文件名后缀 —— 与 vitest.config.ts 的 test.include 里 packages 那条同口径（.test.ts / .test.tsx）。 */
const TEST_FILE_RE = /\.test\.tsx?$/

export interface CaseFailure {
  /** 用例全名（`describe > it`） */
  title: string
  /** 断言差在哪（vitest 的 failureMessages 首段） */
  message: string
}

export interface FileResult {
  /** 仓库相对路径 */
  file: string
  /** passed = 跑了且过；failed = 跑了但有断言红；skipped = 没跑起来（缺构建/依赖） */
  status: "passed" | "failed" | "skipped"
  /** 该文件跑了几个用例（skipped 时是 0） */
  tests: number
  /** failed 时的用例明细 */
  cases?: CaseFailure[]
  /** skipped 时的原因（原样取自 vitest 的 message，不编） */
  skipReason?: string
}

export interface Inputs {
  /** 盘上发现的测试文件（相对路径，已排序） */
  discovered: string[]
  /** vitest 跑出来的逐文件结果 */
  results: FileResult[]
  /** 缺 vitest 二进制 */
  missingBinary?: boolean
  /** vitest 跑了但没产出可解析的报告（二进制坏了 / 崩了）—— 与「0 个测试文件」是两件事 */
  noReport?: boolean
  /** 进程尾部输出（红时拼进文案） */
  tail?: string
}

/** `packages/<group>/<pkg>/...` → `packages/<group>/<pkg>`；不合形态返 null。 */
export function packageOf(file: string): string | null {
  const m = /^(packages\/[^/]+\/[^/]+)\//.exec(file)
  return m ? m[1] : null
}

/** `classifySkip` 的归类结果：两类「环境缺料」的处置不同（ISS-875 分家）。 */
export interface SkipClass {
  /** build = 缺构建产物（主检出常态 ⇒ 不红，逐包出声）；dep = 缺依赖（本树没装 ⇒ 红，明说 pnpm install） */
  kind: "build" | "dep"
  missing: string
  fix: string
}

/**
 * 依赖缺失特征：`Cannot find package 'X'` / `Cannot find module 'X'`。
 *
 * `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND` 一族（任务书的特征族）在 Node 的报文模板里
 * 永远带着这两句文字（json 报文实测只出现文字、不出现码），匹配文字即覆盖全族；
 * 单引号是实测形态（vitest 4.1.8 json reporter），双引号一并收容。
 *
 * ⚠️ 只认**裸包名**（不以 `.` / `/` 开头）：`Cannot find module './x.ts'` 是「文件没找到」，
 * 归真红（unclassified），不是缺依赖 —— 把它判成缺依赖会把人指去跑 pnpm install，指错修法。
 *
 * @returns 命中时返回缺失的包名；不是缺依赖形态返回 null。
 */
export function matchMissingDep(message: string): string | null {
  const m = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(message)
  const spec = m?.[1]
  if (!spec || spec.startsWith(".") || spec.startsWith("/")) return null
  return spec
}

/**
 * 把 vitest 的失败信息归类成「环境缺料」还是「真断言红」。
 *
 * 为什么必须分开：缺构建产物是**环境常态**（主 checkout 不构建），真断言红是**代码坏了**。
 * 把前者报成后者的代价是每次合并新包后门禁假红；把后者报成前者的代价是**真回归被静默跳过**——
 * 后者危险得多，故本函数**只认两种明确的缺料信号**，其余一律当真红。
 * ISS-875：缺料内部再分两类 —— 缺依赖判红（本树环境坏了，可修），缺构建维持不红（常态）。
 */
export function classifySkip(message: string): SkipClass | null {
  // ① 包自己的构建产物没打出来：`@matter/x` 的 exports 指向 lib/index.js，而它不存在。
  const build = /Failed to resolve entry for package "([^"]+)"/.exec(message)
  if (build) {
    return {
      kind: "build",
      missing: `${build[1]} 的构建产物（lib/index.js）`,
      fix: "pnpm run build（在主 checkout 或该工作树）",
    }
  }
  // ② 依赖没装到该包：`Cannot find package '<dep>'`（包级 node_modules 缺失）⇒ 红（ISS-875）。
  const dep = matchMissingDep(message)
  if (dep) {
    return { kind: "dep", missing: `依赖 ${dep}`, fix: "请在本树根跑 corepack pnpm install（装完重跑本格）" }
  }
  return null
}

/** 纯函数：判据本体。spec 直接喂构造数据，不碰 IO。 */
export function judgePackageTests(i: Inputs): GateResult {
  if (i.missingBinary) {
    return unjudged(GATE, "no-binary", "缺 node_modules/.bin/vitest —— 装依赖后重跑（pnpm install）")
  }
  // vitest 跑了但没产出报告 ⇒ 判不了。⛔ 不许落进「0 个测试文件」那条：那是两个不同的病，
  // 报错方向不同（前者查依赖/二进制，后者查 tests 目录），混成一句会让人去修错的东西。
  if (i.noReport) {
    return unjudged(GATE, "no-binary", `vitest 跑不出可解析的报告 —— 不是「没有测试」，是「测试跑不起来」：${i.tail ?? ""}`)
  }
  // 分母为 0：盘上一个测试文件都没有 ⇒ 不许判绿。这是本格存在的具体理由
  // （`storage-domain` 那次屏幕上只有一行 `(0 test)`，没人注意到）。
  if (!i.discovered.length) {
    return unjudged(
      GATE,
      "no-corpus",
      `按 ${SCOPE_ROOT} 下 <group>/<pkg>/tests 的 .test.ts(x) 扫到 0 个测试文件 —— 分母为 0，不许判绿。` +
        `这不是「测试通过」，是「新树的测试一个都没有」。` +
        `怎么改：把测试放在 packages/<group>/<pkg>/tests/ 下（例如 packages/storage/storage/tests/storage.test.ts）。`,
    )
  }

  // 盘上发现了、vitest 却没报它的结果 ⇒ 它被静默漏掉了（include 口径漂了 / 文件名不合规）。
  // 这是本格最该防的一类静默：不报出来，屏幕上只有「文件数比预期少」。
  const seen = new Set(i.results.map((r) => r.file))
  const notRun = i.discovered.filter((f) => !seen.has(f))

  const failedFiles = i.results.filter((r) => r.status === "failed")
  // 缺构建产物：环境常态 ⇒ 维持「0 + 出声」（下方 ⚠️ 部分）。
  const skipped: { file: string; pkg: string; missing: string; fix: string }[] = []
  // 缺依赖：本树没跑 pnpm install ⇒ 红（ISS-875：E-0 合并后 3 个测试文件 import 失败、
  // 覆盖率整包 0%，而当时没有任何一格红 —— CI 全新 install 踩不到，本地必踩）。
  const depMissing: { file: string; pkg: string; missing: string; fix: string; reason: string }[] = []
  const unclassified: FileResult[] = [] // 跑不起来但不是已知缺料 ⇒ 当真红，不静默放过
  for (const r of i.results) {
    if (r.status !== "skipped") continue
    const cls = classifySkip(r.skipReason ?? "")
    if (!cls) {
      unclassified.push(r)
    } else if (cls.kind === "dep") {
      depMissing.push({ file: r.file, pkg: packageOf(r.file) ?? r.file, ...cls, reason: firstLine(r.skipReason ?? "") })
    } else {
      skipped.push({ file: r.file, pkg: packageOf(r.file) ?? r.file, ...cls })
    }
  }

  const ran = i.results.filter((r) => r.status !== "skipped")
  const totalTests = ran.reduce((n, r) => n + r.tests, 0)
  const skippedPkgs = [...new Set(skipped.map((s) => s.pkg))].sort()

  // ── 判不了：一个断言都没跑起来 ────────────────────────────────────────
  // ⚠️ 与「部分包跳过」的区别是**分母**：这里 0 个断言真跑过，说绿等于说「没跑 = 通过」。
  // ⚠️ 缺依赖优先于判不了（ISS-875）：缺依赖是**可修的红**（跑 pnpm install 就好），
  //    把它降成判不了等于把「怎么改」从文案里拿掉 —— 本单治的正是「当时谁都不出声」。
  if (!ran.length && skipped.length && !depMissing.length) {
    return unjudged(
      GATE,
      "no-build",
      [
        `全部 ${new Set(skipped.map((s) => s.pkg)).size} 个包的测试**都没跑起来** —— 0 个断言被执行，不许判绿。`,
        ...skipLines(skipped),
        `  这不是「测试通过」，是「这些包的测试根本没跑」。`,
        `  怎么改：${skipped[0].fix}`,
      ].join("\n"),
    )
  }

  // ── 红：缺依赖（ISS-875 新增）、真断言失败、或跑不起来但不属于已知缺料 ──
  const findings: Finding[] = []
  // 缺依赖的红文案必须把「包 + 缺什么 + 怎么改」一次给全 —— 报成「整包 0%」或「跑不起来」
  // 都还得实施者自己推到「原来要跑 pnpm install」（ISS-875 需求原话）。
  for (const d of depMissing) {
    findings.push({
      file: d.file,
      detail:
        `[${d.pkg}] 该包的依赖未安装（${d.missing}）⇒ 测试文件连 import 都失败，0 个断言被执行` +
        `\n      原文：${d.reason}` +
        `\n      怎么改：${d.fix}`,
    })
  }
  for (const r of failedFiles) {
    const pkg = packageOf(r.file) ?? r.file
    const cases = r.cases ?? []
    // 一条 finding 一个用例：只说「这个文件红了」等于没说「哪条断言差在哪」。
    // ⚠️ 必须带「怎么改」：本仓的判据文案口径是「文件 + 期望 + 实际 + 一句怎么改」，
    //    缺最后一句时读的人知道红了却不知道从哪下手（spec 有一条断言专门盯这句）。
    for (const c of cases.length ? cases : [{ title: "(未见用例明细)", message: r.skipReason ?? "vitest 未给断言信息" }]) {
      findings.push({
        file: r.file,
        detail:
          `[${pkg}] ${c.title}\n      ${firstLine(c.message)}` +
          `\n      怎么改：先单独复现 \`./node_modules/.bin/vitest run ${r.file}\`，按上面这条断言核代码（期望 vs 实际）`,
      })
    }
  }
  for (const r of unclassified) {
    findings.push({
      file: r.file,
      detail:
        `[${packageOf(r.file) ?? r.file}] 这个文件跑不起来，且原因**不是**已知的环境缺料（缺构建产物 / 缺依赖）` +
        ` ⇒ 按真红计，不跳过。\n      原文：${firstLine(r.skipReason ?? "")}\n      怎么改：先单独跑 \`./node_modules/.bin/vitest run ${r.file}\` 看完整堆栈`,
    })
  }
  if (notRun.length) {
    for (const f of notRun) {
      findings.push({
        file: f,
        detail:
          `盘上有这个测试文件，但 vitest 的结果里**没有它** —— 它被静默漏掉了（多半是 include 口径或文件名不合规）。` +
          `\n      怎么改：核 vitest.config.ts 的 test.include 是否覆盖 ${f}；文件名须以 .test.ts / .test.tsx 结尾`,
      })
    }
  }
  if (findings.length) {
    return {
      gate: GATE,
      status: "failed",
      findings,
      detail: [
        `${ran.length} 个文件跑起来 · ${totalTests} 个断言 · 红 ${findings.length} 条`,
        ...(depMissing.length
          ? [
              `⚠️ ${new Set(depMissing.map((d) => d.pkg)).size} 个包依赖未安装 ⇒ 红（见上）—— 请在本树根跑 corepack pnpm install 后重跑`,
            ]
          : []),
        ...(skipped.length
          ? [`另有 ${skippedPkgs.length} 个包未执行（缺构建产物，主检出常态 ⇒ 不判红；补法：pnpm run build）：`, ...skipLines(skipped)]
          : []),
      ].join("\n"),
    }
  }

  // ── 绿 ────────────────────────────────────────────────────────────────
  const pkgCount = new Set(ran.map((r) => packageOf(r.file) ?? r.file)).size
  const ranOk = `${pkgCount} 个包 / ${ran.length} 个文件 / ${totalTests} 个断言`
  if (!skipped.length) {
    return { gate: GATE, status: "passed", findings: [], detail: `全跑：${ranOk}，全绿` }
  }
  // 部分跳过：绿，但必须比全跑更刺眼（否则「跳过」与「通过」在屏幕上长得一样）。
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: [
      `⚠️ 部分跳过：${skippedPkgs.length} 个包的测试**没跑** —— 这不是「测试通过」，是「这些包的测试根本没跑」。`,
      ...skipLines(skipped),
      `  怎么改：${skipped[0].fix}`,
      `  ✅ 真跑起来且全绿：${ranOk}`,
    ].join("\n"),
  }
}

/** 缺口行：逐包点名（同一包可能多个文件，按包去重保留首个原因）。 */
function skipLines(skipped: { file: string; pkg: string; missing: string; fix: string }[]): string[] {
  const byPkg = new Map<string, { missing: string; file: string }>()
  for (const s of skipped) if (!byPkg.has(s.pkg)) byPkg.set(s.pkg, { missing: s.missing, file: s.file })
  return [...byPkg.entries()].map(([pkg, v]) => `  · ${pkg} —— 缺 ${v.missing} ⇒ 该包测试未被执行（${v.file}）`)
}

/** 断言信息截首行：vitest 的 failureMessages 首行就是「expected 2 to be 3」，后面是堆栈。 */
function firstLine(s: string): string {
  return (s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "").slice(0, 300)
}

/** 扫盘：`packages/<group>/<pkg>/tests/**` 下的测试文件（排序保证读数稳定）。 */
export function discoverTestFiles(repo: string): string[] {
  const base = path.join(repo, SCOPE_ROOT)
  const out: string[] = []
  let groups: fs.Dirent[]
  try {
    groups = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return out
  }
  for (const g of groups) {
    if (!g.isDirectory() || g.name.startsWith(".") || g.name === "node_modules") continue
    let pkgs: fs.Dirent[]
    try {
      pkgs = fs.readdirSync(path.join(base, g.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const p of pkgs) {
      if (!p.isDirectory() || p.name.startsWith(".") || p.name === "node_modules") continue
      walk(path.join(base, g.name, p.name, "tests"), `${SCOPE_ROOT}/${g.name}/${p.name}/tests`, out)
    }
  }
  return out.sort()
}

function walk(abs: string, rel: string, out: string[]): void {
  let ents: fs.Dirent[]
  try {
    ents = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      walk(path.join(abs, e.name), `${rel}/${e.name}`, out)
    } else if (e.isFile() && TEST_FILE_RE.test(e.name)) {
      out.push(`${rel}/${e.name}`)
    }
  }
}

/** vitest 的 json reporter 产物形状（只取本判据用到的字段）。 */
interface VitestJson {
  testResults?: {
    name: string
    status?: string
    message?: string
    assertionResults?: { status: string; fullName?: string; title?: string; failureMessages?: string[] }[]
  }[]
}

/** 把 vitest 的 json 报告转成本判据的逐文件结果。`repo` 用于把绝对路径折成仓库相对路径。 */
export function parseReport(report: VitestJson, repo: string): FileResult[] {
  const out: FileResult[] = []
  for (const r of report.testResults ?? []) {
    const file = path.relative(repo, r.name).split(path.sep).join("/")
    const asserts = r.assertionResults ?? []
    const bad = asserts.filter((a) => a.status === "failed")
    // 一个用例都没有 + 有 message ⇒ 这个文件根本没装载起来（import 失败 / 语法错）。
    // ⚠️ 不能把它当「0 个用例通过」：那正是 `(0 test)` 那一行骗过所有人的形态。
    if (!asserts.length) {
      out.push({ file, status: "skipped", tests: 0, skipReason: r.message ?? "" })
      continue
    }
    out.push({
      file,
      status: bad.length ? "failed" : "passed",
      tests: asserts.length,
      cases: bad.length
        ? bad.map((a) => ({ title: a.fullName ?? a.title ?? "(未命名用例)", message: (a.failureMessages ?? [])[0] ?? "" }))
        : undefined,
    })
  }
  return out
}

/** 真跑一次 `vitest run packages/`（只跑新树）。返回值带 `noReport` 标记，由纯函数判，不在 main 里临时补。 */
function runVitest(repo: string): { results: FileResult[]; tail: string; noReport: boolean } | null {
  const bin = path.join(repo, "node_modules/.bin/vitest")
  if (!fs.existsSync(bin)) return null
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rpt-")), "report.json")
  const r = spawnSync(bin, ["run", SCOPE_ROOT, "--reporter=json", `--outputFile=${outFile}`], {
    cwd: repo,
    encoding: "utf8",
    timeout: 600_000,
  })
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n")
  let report: VitestJson
  try {
    report = JSON.parse(fs.readFileSync(outFile, "utf8")) as VitestJson
  } catch {
    // 报告都没产出 ⇒ noReport（判不了）：编一个绿或空结果都是假读数。
    return { results: [], tail: `vitest 未产出 json 报告（exit ${r.status}）：${tail}`, noReport: true }
  }
  return { results: parseReport(report, repo), tail, noReport: false }
}

export async function main(): Promise<GateResult> {
  const discovered = discoverTestFiles(REPO)
  const run = runVitest(REPO)
  if (!run) return judgePackageTests({ discovered, results: [], missingBinary: true })
  return judgePackageTests({ discovered, results: run.results, noReport: run.noReport, tail: run.tail })
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
