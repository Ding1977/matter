/**
 * `run-package-tests.ts` 的自检向量（ISS-866；ISS-875 增缺依赖一族）。
 *
 * 本判据的全部价值在**反例**：正向「测试全绿 ⇒ passed」跑一次就绿，证明不了任何事。
 * 必须证明三类形态各自**判对**，否则它只是又一格永远绿的空检查 —— 而这一格存在的理由
 * 恰恰是「新树 149 个断言曾经没有任何一格门禁在跑，屏幕上完全看不出来」。
 *
 * 四类用例（与 `verify-coverage-collect.spec.ts` 同口径）：
 *   正例 / 反例 / 干扰（边界）/ 缺输入。
 *
 * 其中**必然失败**的向量（构造数据一定该红 / 该判不了，判绿即判据坏了）：
 *   · 有断言红              ⇒ failed（不许绿）
 *   · 缺依赖（ISS-875）    ⇒ failed 且文案含 corepack pnpm install（不许再当「部分跳过」绿掉）
 *   · 0 个测试文件          ⇒ unjudged(no-corpus)（分母为 0，不许绿）
 *   · 全部包都跑不起来      ⇒ unjudged(no-build)（0 个断言执行，不许绿）
 *   · 缺 vitest 二进制      ⇒ unjudged(no-binary)
 *   · 跑不起来但不是缺料    ⇒ failed（真红，不许当环境问题放过）
 *   · 盘上有文件但报告里没有 ⇒ failed（静默漏跑，不许绿）
 *
 * ISS-875 的两条**反向牙**（缺一即误判一侧）：
 *   · 缺依赖 ⇒ 红 + 文案说 pnpm install —— E-0 形态（`Cannot find package '@matter/storage'`
 *     **单引号**，vitest 4.1.8 json 报文实测）必须命中；全部包缺依赖也红（不许降成 no-build 判不了）。
 *   · 断言失败 ⇒ 红归测试格，文案**不含** pnpm install —— 真红的断言被读成缺依赖，
 *     修的人会去装依赖而不是改代码。
 *
 * ⚠️ 最后一段是**实仓用例**：真跑一次 `vitest run packages/`。
 *   纯函数全绿而实仓红 = 判据没接上；反之实仓绿而纯函数全绿才是可交付的证据。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  classifySkip,
  discoverTestFiles,
  judgePackageTests,
  matchMissingDep,
  packageOf,
  parseReport,
  type FileResult,
  type Inputs,
} from "./run-package-tests.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** 一个「真跑起来且全绿」的文件。 */
function okFile(file = "packages/storage/storage/tests/storage.test.ts", tests = 9): FileResult {
  return { file, status: "passed", tests }
}

/** 一个「缺构建产物、没跑起来」的文件。 */
function skippedFile(file = "packages/storage/storage-domain/tests/domain.test.ts"): FileResult {
  return {
    file,
    status: "skipped",
    tests: 0,
    skipReason: 'Failed to resolve entry for package "@matter/storage". The package may have incorrect main/module/exports specified in its package.json.',
  }
}

function base(over: Partial<Inputs> = {}): Inputs {
  const results = over.results ?? [okFile()]
  return {
    discovered: over.discovered ?? results.map((r) => r.file),
    ...over,
    results,
  }
}

export function run(): boolean {
  const cases: [string, boolean, string?][] = []
  const t = (name: string, ok: boolean, note?: string) => cases.push([name, ok, note])

  // ── 正向 ────────────────────────────────────────────────────────────
  {
    const v = judgePackageTests(base())
    t("正向：全跑且全绿 ⇒ passed", v.status === "passed", `实得 ${v.status}`)
    t("正向：detail 带实数（包 / 文件 / 断言）", /4|1 个包/.test(v.detail ?? "") && /149|9/.test(v.detail ?? ""), `实得 ${v.detail}`)
    t("正向：没有任何跳过时 detail 明说「全跑」", /全跑/.test(v.detail ?? ""), `实得 ${v.detail}`)
  }

  // ── 必然失败 ①：有断言红 ⇒ 必须红，且指出包/用例/断言差 ──────────────
  {
    const v = judgePackageTests(
      base({
        results: [
          okFile(),
          {
            file: "packages/storage/storage-json/tests/apply.test.ts",
            status: "failed",
            tests: 3,
            cases: [{ title: "apply > 合并后取第二个值", message: "AssertionError: expected 2 to be 3 // Object.is equality\n    at x:2:51" }],
          },
        ],
      }),
    )
    t("反例：有断言红 ⇒ failed（不许绿）", v.status === "failed", `实得 ${v.status}`)
    const detail = v.findings?.[0]?.detail ?? ""
    t("反例：红文案指出**包名**", /storage-json/.test(detail), `实得 ${detail}`)
    t("反例：红文案指出**用例名**", /合并后取第二个值/.test(detail), `实得 ${detail}`)
    t("反例：红文案指出**断言差在哪**（expected 2 to be 3）", /expected 2 to be 3/.test(detail), `实得 ${detail}`)
    t("反例：红文案带一句怎么改（给的是一句动作）", /怎么改|堆栈|单独跑/.test(detail), `实得 ${detail}`)
  }

  // ── 必然失败 ②：0 个测试文件 ⇒ 判不了，不许绿 ─────────────────────────
  {
    const v = judgePackageTests({ discovered: [], results: [] })
    t("反例：0 个测试文件 ⇒ unjudged（分母为 0 不许绿）", v.status === "unjudged", `实得 ${v.status}`)
    t("反例：理由码是 no-corpus", v.reason === "no-corpus", `实得 ${String(v.reason)}`)
    t("反例：文案明说「不是测试通过」", /不是「测试通过」/.test(v.detail ?? ""), `实得 ${v.detail}`)
    t("反例：文案给出怎么改（tests 目录在哪）", /怎么改/.test(v.detail ?? "") && /tests/.test(v.detail ?? ""), `实得 ${v.detail}`)
  }

  // ── 必然失败 ③：全部包都跑不起来 ⇒ 判不了，且必须出声 ──────────────────
  {
    const v = judgePackageTests(base({ results: [skippedFile(), skippedFile("packages/storage/storage-json/tests/apply.test.ts")] }))
    t("反例：全部包缺构建 ⇒ unjudged(no-build)（0 个断言执行不许绿）", v.status === "unjudged" && v.reason === "no-build", `实得 ${v.status}/${String(v.reason)}`)
    const d = v.detail ?? ""
    t("反例：明说「0 个断言被执行」", /0 个断言/.test(d), `实得 ${d}`)
    t("反例：逐包点名缺什么", /storage-domain/.test(d) && /storage-json/.test(d), `实得 ${d}`)
    t("反例：给出怎么补（pnpm run build）", /pnpm run build/.test(d), `实得 ${d}`)
    t("反例：原文点明「根本不是没跑」不是通过", /根本没跑/.test(d), `实得 ${d}`)
  }

  // ── 必然失败 ④：缺 vitest 二进制 ⇒ 判不了 ─────────────────────────────
  {
    const v = judgePackageTests({ discovered: ["packages/a/b/tests/x.test.ts"], results: [], missingBinary: true })
    t("反例：缺 vitest ⇒ unjudged(no-binary)", v.status === "unjudged" && v.reason === "no-binary", `实得 ${v.status}/${String(v.reason)}`)
  }

  // ── 必然失败 ⑤：报告没产出 ⇒ 判不了（与「0 个测试文件」分开）───────────
  {
    const v = judgePackageTests({ discovered: ["packages/a/b/tests/x.test.ts"], results: [], noReport: true, tail: "boom" })
    t("反例：vitest 跑不出报告 ⇒ unjudged(no-binary)，不落进 no-corpus", v.status === "unjudged" && v.reason === "no-binary", `实得 ${v.status}/${String(v.reason)}`)
  }

  // ── 必然失败 ⑥：跑不起来但**不是**已知缺料 ⇒ 按真红，不静默跳过 ────────
  // 这是本判据最危险那侧的守卫：把真回归读成「环境问题」就等于关掉这一格。
  {
    const v = judgePackageTests(
      base({
        results: [okFile(), { file: "packages/storage/storage/tests/weird.test.ts", status: "skipped", tests: 0, skipReason: "Cannot access 'x' before initialization" }],
      }),
    )
    t("反例：非缺料的跑不起来 ⇒ failed（不许当环境问题放过）", v.status === "failed", `实得 ${v.status}`)
    t("反例：文案明说「不是已知的环境缺料」", /不是\*\*已知的环境缺料|不是.*环境缺料/.test(v.findings?.[0]?.detail ?? ""), `实得 ${v.findings?.[0]?.detail}`)
  }

  // ── 必然失败 ⑦：盘上有文件、报告里没有 ⇒ 静默漏跑必须红 ────────────────
  {
    const v = judgePackageTests({
      discovered: ["packages/storage/storage/tests/a.test.ts", "packages/storage/storage/tests/b.test.ts"],
      results: [okFile("packages/storage/storage/tests/a.test.ts")],
    })
    t("反例：盘上有但 vitest 没跑 ⇒ failed（静默漏跑不许绿）", v.status === "failed", `实得 ${v.status}`)
    t("反例：文案点名被漏掉的那个文件", /b\.test\.ts/.test(v.findings?.[0]?.file ?? "") || /b\.test\.ts/.test(v.findings?.[0]?.detail ?? ""), `实得 ${JSON.stringify(v.findings?.[0])}`)
  }

  // ── 必然失败 ⑧：缺依赖 ⇒ 红，文案明说 pnpm install（ISS-875 正主）────────
  // 报文用实测形态：单引号 + imported from（vitest 4.1.8 json reporter，见 run-package-tests.ts 头注）。
  {
    const v = judgePackageTests(
      base({
        results: [
          okFile(),
          {
            file: "packages/pm/issue/tests/domain.test.ts",
            status: "skipped",
            tests: 0,
            skipReason: "Cannot find package '@matter/storage' imported from /repo/packages/pm/issue/tests/domain.test.ts",
          },
        ],
      }),
    )
    t("反例：缺依赖 ⇒ failed（不许再当「部分跳过」绿掉）", v.status === "failed", `实得 ${v.status}`)
    const detail = v.findings?.[0]?.detail ?? ""
    t("反例：缺依赖红文案明说「该包的依赖未安装」", /依赖未安装/.test(detail), `实得 ${detail}`)
    t("反例：缺依赖红文案含 corepack pnpm install（怎么改可执行）", /corepack pnpm install/.test(detail), `实得 ${detail}`)
    t("反例：缺依赖红文案点名包（packages/pm/issue）", /packages\/pm\/issue/.test(detail), `实得 ${detail}`)
    t("反例：缺依赖红文案点名缺的依赖（@matter/storage）", /@matter\/storage/.test(detail), `实得 ${detail}`)
    t("反例：缺依赖红文案带报文原文（Cannot find package）", /Cannot find package/.test(detail), `实得 ${detail}`)
    t("反例：红时 detail 汇总也指 pnpm install", /corepack pnpm install/.test(v.detail ?? ""), `实得 ${v.detail}`)
  }

  // ── 必然失败 ⑨：断言失败 ⇒ 红归测试格，不误判为缺依赖（ISS-875 反向牙）──
  // 与 ⑧ 互为反向：真红的断言若被读成「缺依赖」，修的人会去跑 pnpm install 而不是改代码。
  {
    const v = judgePackageTests(
      base({
        results: [
          okFile(),
          {
            file: "packages/pm/issue/tests/domain.test.ts",
            status: "failed",
            tests: 3,
            cases: [{ title: "domain > 状态推进", message: "AssertionError: expected 2 to be 3 // Object.is equality\n    at domain.test.ts:42:51" }],
          },
        ],
      }),
    )
    const detail = v.findings?.[0]?.detail ?? ""
    t("反例：断言红 ⇒ failed 且归测试格（用例级明细）", v.status === "failed" && /状态推进/.test(detail), `实得 ${v.status} / ${detail}`)
    t("反例：断言红**不误判**为缺依赖（文案不含 pnpm install / 依赖未安装）", !/pnpm install|依赖未安装/.test(detail), `实得 ${detail}`)
    t("反例：断言红的怎么改指向复现命令（不是装依赖）", /vitest run/.test(detail), `实得 ${detail}`)
  }

  // ── 必然失败 ⑩：全部包都缺依赖 ⇒ 红，不许降成 no-build 判不了（E-0 形态守卫）──
  {
    const v = judgePackageTests({
      discovered: ["packages/pm/issue/tests/a.test.ts", "packages/pm/issue/tests/b.test.ts"],
      results: [
        { file: "packages/pm/issue/tests/a.test.ts", status: "skipped", tests: 0, skipReason: "Cannot find package '@matter/storage' imported from /repo/a.test.ts" },
        { file: "packages/pm/issue/tests/b.test.ts", status: "skipped", tests: 0, skipReason: "Cannot find package '@deepseek-ai/cordis' imported from /repo/b.test.ts" },
      ],
    })
    t("反例：全部包缺依赖 ⇒ failed（0 断言也不许降成判不了）", v.status === "failed", `实得 ${v.status}/${String(v.reason)}`)
    t("反例：逐文件给红（两个文件两条 finding）", v.findings?.length === 2, `实得 ${v.findings?.length} 条`)
    t("反例：detail 仍明说 pnpm install", /corepack pnpm install/.test(v.detail ?? ""), `实得 ${v.detail}`)
  }

  // ── 边界：缺依赖（红）与缺构建（不红）同场 ⇒ 红归红、常态归常态，互不吞 ────
  {
    const v = judgePackageTests(
      base({
        results: [
          okFile(),
          skippedFile(),
          { file: "packages/pm/issue/tests/domain.test.ts", status: "skipped", tests: 0, skipReason: "Cannot find package '@matter/storage' imported from /repo/d.test.ts" },
        ],
      }),
    )
    t("边界：缺依赖红与缺构建跳过同场 ⇒ failed", v.status === "failed", `实得 ${v.status}`)
    t("边界：缺构建的包仍在 detail 点名（不被红吞掉）", /storage-domain/.test(v.detail ?? "") && /未执行/.test(v.detail ?? ""), `实得 ${v.detail}`)
    t("边界：detail 分得清两类怎么补（install 与 build 各在）", /corepack pnpm install/.test(v.detail ?? "") && /pnpm run build/.test(v.detail ?? ""), `实得 ${v.detail}`)
  }

  // ── 边界：部分包跳过 ⇒ passed，但必须比全跑更刺眼 ──────────────────────
  {
    const v = judgePackageTests(base({ results: [okFile("packages/storage/storage/tests/storage.test.ts", 9), skippedFile()] }))
    t("边界：部分包缺构建 ⇒ passed（真跑起来的那部分有读数）", v.status === "passed", `实得 ${v.status}`)
    const d = v.detail ?? ""
    t("边界：明说「部分跳过」", /部分跳过/.test(d), `实得 ${d}`)
    t("边界：明说这不是测试通过", /不是「测试通过」/.test(d), `实得 ${d}`)
    t("边界：点名被跳过的包", /storage-domain/.test(d), `实得 ${d}`)
    t("边界：给出怎么补", /pnpm run build/.test(d), `实得 ${d}`)
    t("边界：同时报真跑起来的那部分（不因跳过就不报绿数）", /9 个断言|1 个文件/.test(d), `实得 ${d}`)
    t("边界：带 ⚠️ 标记（一眼看出不是全跑）", /⚠️/.test(d), `实得 ${d}`)
  }

  // ── 边界：跳过与全跑的 detail 必须不同（否则屏幕上分不出）─────────────
  {
    const all = judgePackageTests(base({ results: [okFile()] })).detail ?? ""
    const part = judgePackageTests(base({ results: [okFile(), skippedFile()] })).detail ?? ""
    t("边界：全跑与部分跳过的 detail 不同（可区分）", all !== part, `全跑=${all.slice(0, 40)} / 部分=${part.slice(0, 40)}`)
  }

  // ── 边界：classifySkip 只认两种缺料信号，别的一律不认；且两类要能分开 ────
  {
    t("纯函数：Failed to resolve entry ⇒ 认（缺构建，kind=build 不红）", classifySkip('Failed to resolve entry for package "@matter/x".')?.kind === "build" && /lib\/index\.js/.test(classifySkip('Failed to resolve entry for package "@matter/x".')?.missing ?? ""), `实得 ${JSON.stringify(classifySkip('Failed to resolve entry for package "@matter/x".'))}`)
    t("纯函数：Cannot find package ⇒ 认（缺依赖，kind=dep 判红）", classifySkip('Cannot find package "@deepseek-ai/cordis"')?.kind === "dep" && /依赖/.test(classifySkip('Cannot find package "@deepseek-ai/cordis"')?.missing ?? ""), `实得 ${JSON.stringify(classifySkip('Cannot find package "@deepseek-ai/cordis"'))}`)
    t("纯函数：**实测报文形态**（单引号 + imported from）⇒ 认 —— 旧双引号正则从未命中过它（ISS-875 修正点）", classifySkip("Cannot find package '@matter/storage' imported from /repo/packages/pm/issue/tests/domain.test.ts")?.kind === "dep", `实得 ${JSON.stringify(classifySkip("Cannot find package '@matter/storage' imported from /repo/d.test.ts"))}`)
    t("纯函数：ERR_MODULE_NOT_FOUND 码前缀形态 ⇒ 认（同族）", matchMissingDep("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from '/repo/x.test.ts'") === "zod", `实得 ${JSON.stringify(matchMissingDep("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from '/repo/x.test.ts'"))}`)
    t("纯函数：Cannot find module 裸包名 ⇒ 认（CJS MODULE_NOT_FOUND 同族）", matchMissingDep("Cannot find module 'lodash'") === "lodash", `实得 ${JSON.stringify(matchMissingDep("Cannot find module 'lodash'"))}`)
    t("纯函数：相对导入断 ⇒ **不认**（文件没找到，不是缺依赖 —— 实测报文就是这个形态）", matchMissingDep("Cannot find module './__no-such-probe-file.ts' imported from /repo/x.test.ts") === null, `实得 ${JSON.stringify(matchMissingDep("Cannot find module './__no-such-probe-file.ts' imported from /repo/x.test.ts"))}`)
    t("纯函数：绝对路径模块断 ⇒ 不认", matchMissingDep("Cannot find module '/abs/no-such.ts' imported from '/repo/x'") === null, `实得 ${JSON.stringify(matchMissingDep("Cannot find module '/abs/no-such.ts' imported from '/repo/x'"))}`)
    t("纯函数：语法错 ⇒ 不认（当真红，不放过）", classifySkip("Cannot access 'x' before initialization") === null, `实得 ${JSON.stringify(classifySkip("Cannot access 'x' before initialization"))}`)
    t("纯函数：断言错 ⇒ 不认（当真红）", classifySkip("AssertionError: expected 2 to be 3") === null, `实得 ${JSON.stringify(classifySkip("AssertionError: expected 2 to be 3"))}`)
    t("纯函数：空串 ⇒ 不认", classifySkip("") === null, `实得 ${JSON.stringify(classifySkip(""))}`)
  }

  // ── 边界：packageOf 取出两段包名 ─────────────────────────────────────
  {
    t("纯函数：packageOf 取对包名", packageOf("packages/storage/storage-json/tests/a.test.ts") === "packages/storage/storage-json", `实得 ${packageOf("packages/storage/storage-json/tests/a.test.ts")}`)
    t("边界：packageOf 对射程外路径返 null", packageOf("forge-pm/lib/x.test.ts") === null, `实得 ${String(packageOf("forge-pm/lib/x.test.ts"))}`)
  }

  // ── 边界：parseReport 把「0 用例 + message」读成 skipped，而不是 passed ──
  {
    const rs = parseReport(
      {
        testResults: [
          { name: path.join(REPO, "packages/a/b/tests/load-fail.test.ts"), message: 'Failed to resolve entry for package "@matter/b".' },
          { name: path.join(REPO, "packages/a/b/tests/ok.test.ts"), assertionResults: [{ status: "passed", title: "x" }] },
          { name: path.join(REPO, "packages/a/b/tests/red.test.ts"), assertionResults: [{ status: "failed", fullName: "d > i", failureMessages: ["AssertionError: expected 1 to be 2\n at y"] }] },
        ],
      },
      REPO,
    )
    t("解析：0 用例 + message ⇒ skipped（不是 passed）", rs[0]?.status === "skipped", `实得 ${rs[0]?.status}`)
    t("解析：全过 ⇒ passed 且带用例数", rs[1]?.status === "passed" && rs[1]?.tests === 1, `实得 ${rs[1]?.status}/${rs[1]?.tests}`)
    t("解析：有用例红 ⇒ failed 且带用例名", rs[2]?.status === "failed" && rs[2]?.cases?.[0]?.title === "d > i", `实得 ${JSON.stringify(rs[2])}`)
    t("解析：绝对路径折成仓库相对路径", rs.every((r) => !path.isAbsolute(r.file)), `实得 ${rs.map((r) => r.file).join(",")}`)
  }

  // ── 实仓：真跑一次（纯函数全绿而实仓红 = 判据没接上）──────────────────
  {
    const discovered = discoverTestFiles(REPO)
    t("实仓：扫到了测试文件（射程不是空的）", discovered.length > 0, `实得 ${discovered.length} 个`)
    t("实仓：扫到的文件全部落在 packages/ 下（⛔ 不碰旧树）", discovered.every((f) => f.startsWith("packages/")), `越界：${discovered.filter((f) => !f.startsWith("packages/")).join(",") || "无"}`)
    t("实仓：扫到的文件里不含任何 forge- 路径", discovered.every((f) => !f.includes("forge-")), `命中：${discovered.filter((f) => f.includes("forge-")).join(",") || "无"}`)
  }

  const bad = cases.filter((c) => !c[1])
  for (const [n, okk, note] of cases) console.log(`${okk ? "✓" : "✗"} ${n}${okk ? "" : `\n    ↳ ${note ?? "（未给实际值）"}`}`)
  console.log(`\nrun-package-tests selftest ${cases.length - bad.length}/${cases.length} 通过`)
  return bad.length === 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(run() ? 0 : 1)
}
