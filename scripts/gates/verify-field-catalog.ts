/**
 * `docs/field-catalog.md` 的新鲜度判据（ISS-896 / DOC-516 §四 D8）。
 *
 * 机制与 ctx/dependency 同款，**失败驱动**（DOC-512 §5.6.3）：
 *   改 schema → 忘跑生成器 → 本格红 → 跑 `node scripts/gen-field-catalog.ts` → 提交。
 *
 * 判据不自己再写一份扫描：`--check` 与生成器必须问同一个问题，两份实现会在某天分叉
 * （「生成器说最新、判据说旧」，没人能说清哪边对）。本格直接 import 生成器的
 * {@link buildFieldCatalog}（同一函数、同一扫描面、同一排序）。
 *
 * 三态（`scripts/lib/gate-runtime.ts`）：0 绿 / 1 红（旧了）/ 2 判不了（没有语料）。
 * ⛔ **0 张字段清单 schema 不许判绿**：schema 数为 0 时「生成物与源码一致」是空话
 *    （两边都是「（无）」自然一致）。那是 `no-corpus`，必须判不了，让「schema 全没了 /
 *    抽取坏了」这件事出声，而不是拿空表冒充绿。
 *
 * 红文案给全四件（DOC-512 §5.5.7 第 2 条）：文件:行 + 期望 + 实际 + 怎么改（能直接粘的一条）。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult, type Finding } from "../lib/gate-runtime.ts"
import { firstDiff } from "./verify-ctx-catalog.ts"
import { HEADER, OUT_REL, buildFieldCatalog } from "../gen-field-catalog.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-field-catalog"
/** 生成器的重跑命令：红文案里的「怎么改」必须是**能直接粘的**一条。 */
const REGEN = "node scripts/gen-field-catalog.ts"

/** 一张 catalog 的检查输入。 */
export interface FieldCatalogInput {
  /** 生成物现状（`null` = 文件不存在）。 */
  actual: string | null
  /** 现算的生成物内容（来自生成器，同一条路径）。 */
  expected: string
  /** 扫到几张字段清单 schema（0 ⇒ 判不了，不许绿）。 */
  schemaCount: number
}

/**
 * 纯函数判据：spec 直接喂构造数据（正例 / 改一字 / 删文件 / 改头 / 0 schema）。
 * @param input - 生成物现状 + 现算内容 + schema 数。
 */
export function judgeFieldCatalog(input: FieldCatalogInput): GateResult {
  if (!(input.schemaCount > 0)) {
    return unjudged(
      GATE,
      "no-corpus",
      "扫描面里 0 张字段清单 schema ⇒ 判不了「生成物是否新鲜」（空表与空表当然一致，那不是绿）",
    )
  }
  if (input.actual === null) {
    return {
      gate: GATE,
      status: "failed",
      findings: [
        {
          file: OUT_REL,
          detail: `文件不存在，但源码里有 ${input.schemaCount} 张字段清单 schema ⇒ 跑生成器 \`${REGEN}\` 生成，并把结果提交进 git（生成物进仓库是这个机制的承重墙）`,
        } satisfies Finding,
      ],
    }
  }
  if (input.actual === input.expected) return { gate: GATE, status: "passed", findings: [] }

  const findings: Finding[] = []
  if (!input.actual.startsWith(HEADER)) {
    findings.push({
      file: OUT_REL,
      line: 1,
      detail: `首行不是生成器文件头。期望 \`${HEADER}\`，实际 \`${input.actual.split("\n")[0] ?? "（空文件）"}\``,
    })
  }
  const diff = firstDiff(input.actual, input.expected)
  if (diff) {
    findings.push({
      file: OUT_REL,
      line: diff.line,
      detail: `内容与源码不一致。期望 \`${oneLine(diff.expected)}\`，实际 \`${oneLine(diff.actual)}\``,
    })
  }
  findings.push({
    file: OUT_REL,
    detail: `这是生成物，不要手改：跑生成器 \`${REGEN}\` 重生成后提交（改源码才是改这张表的唯一途径）`,
  })
  return { gate: GATE, status: "failed", findings }
}

/** 摘要把一行压成可读长度，免得一个超长行把红文案撑爆。 */
function oneLine(s: string): string {
  const t = s.length > 160 ? `${s.slice(0, 157)}…` : s
  return t.replace(/`/g, "ˋ")
}

/** 现算生成物 + 读盘现状 + schema 数（与生成器/CLI 共用同一条路径）。 */
export function scan(): FieldCatalogInput {
  const expected = buildFieldCatalog(REPO)
  // schema 数从生成物头部那行读（格式由生成器自述，避免判据另写一份扫描口径）。
  const m = /字段清单 schema (\d+) 张/u.exec(expected)
  const file = path.join(REPO, OUT_REL)
  return {
    actual: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
    expected,
    schemaCount: m ? Number(m[1]) : 0,
  }
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main: () => judgeFieldCatalog(scan()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
