/**
 * 覆盖率「采集是否跑通」判据（ISS-513 · P1-1）。
 *
 * ## 判什么、不判什么
 *
 * 判：跑一次带 `--coverage` 的 vitest，**`coverage/coverage-summary.json` 存在且非 `total` 条目数 > 0**。
 * 不判：百分比。DOC-512 §5.5.6 定「P3 起才上 100%」—— P1 设阈值等于提前上曲线，
 *      而阈值一旦写死就会有人为了让格子变绿去调断言。
 *
 * ## 为什么这条必须存在
 *
 * `vitest.config.ts` 的 coverage 段长期自称「配置就位但采不到数据（0 个文件）」。
 * 那种自承的坏处不是难看，而是**没人能分辨「配置坏了」与「没人启用」** ——
 * 采集断了三个月，屏幕上只有一段注释说它断了。本判据把这句话变成一格可红的检查：
 * 采集真断掉时，这一格从绿变红，而不是靠人想起来去读注释。
 *
 * ## 本单实测到的两个坑（都写在这里，免得下一个人重踩）
 *
 * ① **`coverage.exclude` 里的 \`**\/wt\/**\` 会吃掉整棵工作树。**
 *    `ws.sh new` 的默认落点是 `~/wt/dsh-forge/<ISS-NNN>`（`scripts/ws.sh:53`），
 *    于是工作树里**每个文件**的绝对路径都含 `/wt/` 段。覆盖率过滤按绝对路径匹配
 *    ⇒ 整棵树被排除 ⇒ 采到 0 文件，而屏幕上没有任何一行说「它们被排除了」。
 *    对照：`test.exclude` 的**同一条 glob** 只按仓库相对路径匹配，挡不住工作树里的测试
 *    （实测 `Test Files 5 passed / Tests 51 passed`，一条没漏）。
 *    ⇒ 两处 exclude 的匹配基准不同，同一条 glob 在这里是「挡在仓内的 `.wt/`」，
 *      在那里是「挡掉所有工作树」。本单把它收窄为 `**\/.tmp\/wt\/**`。
 *
 * ② **`@matter/*` 包的 `main` 指向 tsdown 产物 `lib/index.js`，不是 `src`。**
 *    树刚建出来时没有 `lib/`，测试会报 `Failed to resolve entry for package "@matter/storage"`。
 *    与本判据无关（那是构建前置），但判据自己也要能分辨「没采集」与「没构建」——
 *    所以构建失败时报的是它自己的原因，不给一句含糊的「0 个文件」。
 *
 * ## 退出码（口径见 `scripts/lib/gate-runtime.ts`）
 *   0 = 绿（采到了）· 1 = 红（采集断了）· 2 = 判不了（缺 `vitest` 二进制 / 用例跑不起来）
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-coverage-collect"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
/** 采集产物相对仓库根的路径（`reporter: ["text-summary", "json-summary"]` 的第二个 reporter 产出）。 */
export const SUMMARY_REL = "coverage/coverage-summary.json"
/**
 * 采集射程 = **整个新树** `packages`，不是某几个包。
 *
 * ⚠️ ISS-875：原值是 `["run", "packages/storage", "--coverage"]` —— 当时仓里只有 storage 一个组，
 * 写死它读数完全等价，看不出问题。**但 pm 域落地后它立刻变成静默错**（实测）：
 *
 *   `vitest run packages/storage --coverage` ⇒ Statements **77.75% (685/881)**
 *   `vitest run packages          --coverage` ⇒ Statements **91.37% (805/881)**
 *
 * 差的那 129 条语句全是 `@matter/issue` 的源文件 —— 它们**在 `coverage.include` 的射程里**
 * （`packages/*​/*​/src/**`），于是即使测试一条没跑也被计进分母、按 0% 算，
 * 把真实覆盖率 91% 拉成 78%。而本格只判「条目 > 0 且含 /packages/」，**照样绿**。
 *
 * ⇒ 射程必须跟 `coverage.include` 对齐、且**随包增长自动变宽**，不能写死某个组。
 */
export const DEFAULT_ARGS = ["run", "packages", "--coverage"]

export interface Inputs {
  /** 采集产物全文；null = 文件不存在 */
  summary: string | null
  /** 覆盖率报告器的退出码（vitest 自己的码）；不判时传 null */
  exitCode: number | null
  /** 报告器 stderr/stdout 尾部，红时拼进文案 */
  tail?: string
}

/**
 * 纯函数：spec 直接喂构造数据。**不碰 IO**。
 *
 * 判据只有两条，且**必须先判「条目数」再判百分比**：文件存在但 `{}` 也是 0 个文件，
 * 而 `{}` 恰恰是最容易出现的形态（配置在、采集断）。
 */
export function judgeCoverageCollect(i: Inputs): GateResult {
  if (i.summary === null) {
    return {
      gate: GATE,
      status: "failed",
      findings: [
        {
          file: SUMMARY_REL,
          detail:
            `覆盖率报告不存在（期望：带 --coverage 跑完产出 ${SUMMARY_REL}；实际：文件不存在）。` +
            `怎么改：先单独跑 \`./node_modules/.bin/vitest ${DEFAULT_ARGS.join(" ")}\` 看它是否报错；` +
            `若报 "Failed to resolve entry for package @matter/..." 那是没构建（先 \`npx tsc -b tsconfig.next.json && npx tsdown\`），与采集配置无关。`,
        },
      ],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(i.summary)
  } catch (e) {
    return {
      gate: GATE,
      status: "failed",
      findings: [
        {
          file: SUMMARY_REL,
          detail: `报告不是合法 JSON（期望：json-summary 可直接解析；实际：${(e as Error).message}）—— 可能被换成了别的 reporter`,
        },
      ],
    }
  }

  const entries = parsed && typeof parsed === "object" ? Object.keys(parsed as Record<string, unknown>).filter((k) => k !== "total") : []
  if (!entries.length) {
    return {
      gate: GATE,
      status: "failed",
      findings: [
        {
          file: SUMMARY_REL,
          detail:
            `采集跑通但**零个文件在射程**（期望：非 total 条目 ≥ 1；实际：${entries.length} 条）。` +
            `常见原因按实测频率排：① \`coverage.exclude\` 里有 \`**/wt/**\` 而工作树在 \`~/wt/dsh-forge/<ISS>\` ——` +
            `覆盖率按**绝对路径**匹配，该 glob 会吃掉整棵树（本单实测：删掉它 ⇒ 0 条变 831 条）；` +
            `② \`coverage.include\` 没含 \`packages/*/*/src/**\`（本单修前就是这条）；` +
            `③ 测试根本没跑到任何源码（用例全 skip）。怎么改：先按 ①② 核配置，再核用例数。`,
        },
      ],
    }
  }

  // 新树在射程 —— 这是本判据存在的**具体理由**（新树曾经 0 文件在射程）。
  // 只判「总条目 > 0」是不够的：旧树 821 个文件足以让总数永远为正，
  // 新树掉出射程也照样绿 ⇒ 那一格会在没人察觉时退化成一句空话。
  const NEW_TREE = "/packages/"
  const newTree = entries.filter((k) => k.includes(NEW_TREE))
  if (!newTree.length) {
    return {
      gate: GATE,
      status: "failed",
      findings: [
        {
          file: SUMMARY_REL,
          detail:
            `采到了 ${entries.length} 个文件，但**新树 0 个文件在射程**（期望：含 \`${NEW_TREE}\` 的条目 ≥ 1；实际：0 条）。` +
            `这是本判据要防的那件事本身：旧树把总数撑住，新树静默掉出射程，而每格都绿。` +
            `怎么改：核 \`vitest.config.ts\` 的 \`coverage.include\` 是否含 \`packages/*/*/src/**\`；` +
            `再核本次跑的目录是否真有新树用例（\`find packages/*/*/src -name '*.ts' | wc -l\`）。`,
        },
      ],
    }
  }

  // ③ ISS-875：**有源文件在射程里、却一条测试都没跑到**（0%）⇒ 红。
  //
  // 为什么这条必须有：「条目数 > 0」是对全体的判断，它允许「某个包整包 0%」混过去 ——
  //   而那正是「新包落了地、但没人为它写/跑测试」的形态。实测（pm 域刚落时）：
  //   `@matter/issue` 3 文件 129 条语句全部 0%，掺进分母把总覆盖率从 91.37% 拉成 77.75%，
  //   而本格照样绿。⇒ 0% 不是「覆盖得少」，是「这个包的测试**根本没被执行**」，
  //   与「采不到数」是同一类病，只是缩到一个包上。
  //
  // ⚠️ 口径两条，都是实测逼出来的：
  //   ① 只判 `statements.total > 0` 的条目 —— 纯类型文件 `S 0/0` 是空真，拿它判红会造出无法修的假红。
  //   ② **按包聚合再判**，不是按文件 —— v8 对「函数体只有一个 `return`」的恒等函数有统计盲区：
  //      实测 `issueId(value) { return value }`，写一条测试**直调它且断言通过**，
  //      `brand.ts` 仍被记 `statements 0/1`（2026-11-18 现算，`zzprobe` 探针）。
  //      ⇒ 单文件 0% 可能是假红；**整个包 0%** 才是「测试根本没跑这个包」。
  const zero = zeroCoveragePackages(i.summary, newTree)
  if (zero.length) {
    return {
      gate: GATE,
      status: "failed",
      findings: zero.map((z) => ({
        file: z.pkg,
        detail:
          `该包（${z.files} 个源文件 / ${z.total} 条 statements）覆盖率为 **0%**（期望：> 0；实际：0/${z.total}）—— ` +
          `它在采集射程里，却没有任何测试跑到它 ⇒ 包落了地但测试没被执行。` +
          `常见原因：① 新包合并后**没在树里跑过 \`pnpm install\`**（包级 \`node_modules\` 未建 ⇒ 测试连 import 都失败，被 vitest 记成 0%；实测原样复现）；` +
          `② 测试放在 \`packages/<g>/<p>/tests/\` 之外的地方；` +
          `③ 包真的没写测试。` +
          `怎么改：先在树里 \`corepack pnpm install --frozen-lockfile\`，再 \`./node_modules/.bin/vitest run packages\` 看它是否转绿。`,
      })),
    }
  }

  // 采集到了。退出码非 0 只提示不判红：测试红是别的格的事（ISS-512 管），
  // 本格只答「采集链路通不通」。但**不许静默** —— 带进 detail 里。
  const note =
    i.exitCode === 0
      ? `采到 ${entries.length} 个文件（新树 ${newTree.length} 个，其中 0 覆盖 0 个）`
      : `采到 ${entries.length} 个文件（新树 ${newTree.length} 个）；注意：vitest 退出码 ${i.exitCode} ⇒ 有测试没通过，覆盖率只是部分样本；测试红归各自的格`
  return { gate: GATE, status: "passed", findings: [], detail: note }
}

/** 一个「有源文件在射程内、但整包 0% 覆盖」的包。 */
export interface ZeroCoveragePackage {
  /** 包路径（`packages/<group>/<pkg>`）。 */
  readonly pkg: string
  /** 该包在射程内的源文件数。 */
  readonly files: number
  /** 这些文件的 statements 总数（== 0 的包不判，全部 0/0 是空真）。 */
  readonly total: number
}

/**
 * 从 `coverage-summary.json` 里取「整包一条语句都没跑到」的包。
 *
 * 纯函数：spec 直接喂构造数据。
 *
 * ## 为什么按包判而不是按文件判（实测逼出来的）
 *
 * v8 对「函数体只有一个 `return`」的恒等函数**统计不到**：实测
 * `export function issueId(value: string) { return value }`，写一条测试直调它并断言通过，
 * `brand.ts` 仍被记 `statements 0/1 · functions 0/1`（2026-11-18 现算）。
 * ⇒ 拿单文件 0% 判红会**造出修不掉的假红**（那条语句没法「多跑几次」）。
 *
 * 而**整包 0%** 的含义明确：这个包没有任何测试被执行到 —— 与「采集断了」同类，只是缩到一个包上。
 *
 * @param summary - `coverage-summary.json` 全文；null / 坏 JSON ⇒ 空（交给上游判「没产出」）。
 * @param inScope - 已在射程内的条目 key 列表（上游已按 `/packages/` 过滤）。
 * @returns 整包 0% 的包，按包名排序保证读数稳定。
 */
export function zeroCoveragePackages(summary: string | null, inScope: readonly string[]): ZeroCoveragePackage[] {
  if (summary === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(summary)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const table = parsed as Record<string, { statements?: { covered?: number; total?: number } }>
  const agg = new Map<string, { files: number; total: number; covered: number }>()
  for (const key of inScope) {
    const pkg = /(packages\/[^/]+\/[^/]+)\//.exec(key)?.[1]
    if (pkg === undefined) continue
    const stat = table[key]?.statements
    const total = typeof stat?.total === "number" ? stat.total : 0
    const covered = typeof stat?.covered === "number" ? stat.covered : 0
    const a = agg.get(pkg) ?? { files: 0, total: 0, covered: 0 }
    a.files += 1
    a.total += total
    a.covered += covered
    agg.set(pkg, a)
  }
  const out: ZeroCoveragePackage[] = []
  for (const [pkg, a] of agg) {
    if (a.total <= 0 || a.covered > 0) continue
    out.push({ pkg, files: a.files, total: a.total })
  }
  return out.sort((x, y) => x.pkg.localeCompare(y.pkg))
}

/** 真跑一次采集。`--coverage` 会覆盖上一步的产物，故先删旧报告 —— 否则读的是上一次的。 */
function collect(): Inputs {
  const summaryAbs = path.join(REPO, SUMMARY_REL)
  try {
    fs.rmSync(summaryAbs, { force: true })
  } catch {
    /* 删不掉就让下面的时间戳判断兜底，不在这里判红 */
  }
  const bin = path.join(REPO, "node_modules/.bin/vitest")
  if (!fs.existsSync(bin)) {
    // 交给 main 侧退 2（no-binary），不在这里编一个 passed。
    return { summary: null, exitCode: null, tail: `缺 ${path.relative(REPO, bin)}` }
  }
  const r = spawnSync(bin, DEFAULT_ARGS, { cwd: REPO, encoding: "utf8", timeout: 600_000 })
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n")
  let summary: string | null = null
  try {
    summary = fs.readFileSync(summaryAbs, "utf8")
  } catch {
    summary = null
  }
  return { summary, exitCode: r.status, tail }
}

export async function main(): Promise<GateResult> {
  const inputs = collect()
  if (inputs.exitCode === null && inputs.summary === null) {
    return unjudged(GATE, "no-binary", `缺 vitest：${inputs.tail ?? ""} —— 装依赖后重跑（pnpm install）`)
  }
  const v = judgeCoverageCollect(inputs)
  // 报告不存在且用例本身跑不起来 ⇒ 是「判不了」，不是「判到违规」：
  // 后者会让人去改覆盖率配置，而真因是测试/构建起不来。
  if (v.status === "failed" && inputs.summary === null && /Failed to resolve entry|Cannot find (module|package)/.test(inputs.tail ?? "")) {
    return unjudged(GATE, "no-build", `采集跑不起来（不是覆盖率配置问题）：${(inputs.tail ?? "").split("\n").slice(-6).join(" / ")}`)
  }
  const findings = v.findings ?? []
  if (v.status === "failed" && inputs.tail) {
    findings[0] = { ...findings[0], detail: `${findings[0].detail}\n     报告器尾部：${inputs.tail.split("\n").slice(-8).join("\n     ")}` }
  }
  return { ...v, findings }
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
