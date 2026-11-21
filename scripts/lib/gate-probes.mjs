/**
 * 非 next 档的「判不了」资源探测器。
 *
 * ## 与 `next-packages-probes.mjs` 的分工（为什么另起一个文件）
 *
 * | 文件 | 探什么 |
 * |---|---|
 * | `next-packages-probes.mjs` | `packages/` 语料（新树建包进度，6 个探针逐格对齐三态矩阵） |
 * | 本文件 | **其它**资源（Matter 数据根、外部介质……） |
 *
 * 把与 `packages/` 无关的探针塞进那个文件会污染它的语义 —— 它的头注已经把「6 个探针
 * 逐格对齐三态矩阵」写成了契约，多一个不相干的条目会让那张矩阵不再是它声称的东西。
 *
 * ## 为什么不直接写进 `run-gates.mjs` 的 `PROBES` 表
 *
 * 那个文件被 `verify-file-size` 棘轮钉在 2056 行（当前 2053，**余 3 行**）。
 * 探针表本身占十几行，塞不进去；抬上限又被棘轮判红（「已入册也只许降」）。
 * ⇒ 按本仓既有惯例落到 `scripts/lib/`（`bun-bin.mjs` / `pm-root.mjs` / `unjudged-note.mjs`
 * 同一形态），`run-gates.mjs` 侧只加一行 import + 一行展开。
 *
 * ## 纪律（与 `next-packages-probes.mjs` 头注同一条，这里重申因为它是唯一要紧的事）
 *
 * **探测器必须问与判据同一个问题。** 判据的 unjudged 条件是什么，探针就问什么：
 *   · 问得**宽**（探上层目录）⇒ 资源其实不在判据要的那一层，探针却答 true ⇒ `xfail_strict`
 *     报「豁免成了化石」= **假红**，恰好把「判不了」这个第三态打回红。
 *   · 问得**窄**（多要一个条件）⇒ 资源在、探针答 false ⇒ 该抓的化石抓不到。
 * 返回 true = 资源在。**探不到一律 false**（保守：宁可疑判不了，也不冒充化石）。
 *
 * 不 import 各 gate 的 `.ts`（避免调度器依赖 node 类型擦除、也避免判据模块的加载副作用）。
 * 公式与判据源逐条对照，漂移风险用台账的 `note` + `expires` 兜。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const GATE_PROBES = {
  /**
   * `flow-metrics` —— 判不了条件 = **`<home>/pm/issues` 不存在**（不是 `pm` 不存在）。
   *
   * 出处（逐行核对，不是转述）：`scripts/gates/flow-metrics.ts` 的 `readMatter()`
   *   `const issuesDir = path.join(home, "pm", "issues")`
   *   `if (!fs.existsSync(issuesDir)) return { error: ... }`
   * `home` 的取法在 `defaultHome()`：`process.env.DSH_HOME || path.join(os.homedir(), ".dsh-matter")`。
   *
   * ⚠️ **为什么不能复用 `pm-root`**：那个探针问的是 `resolvePmRoot()`（返回 `pm` 目录，
   * 4 个候选任一命中），比本格需要的 `pm/issues` **宽一级**。在「`pm` 在、`pm/issues` 不在」
   * 这个分歧态上，`pm-root` 答 true 而判据报 unjudged ⇒ `xfail_strict` 判「化石」= 假红。
   * 这正是 ISS-730 记下的那个病（探针问「`scripts/baseline/` 目录在不在」，对单文件缺席恒 true）。
   *
   * ⚠️ 也不能用 `pm-corpus`：它要求该根下 md **≥100** 个，比本格所需的「目录存在」严得多
   * ⇒ 少数单据的机器上会造**假化石**（方向相反的同一种错）。
   */
  "matter-issues-dir": () => {
    const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh-matter")
    return fs.existsSync(path.join(home, "pm", "issues"))
  },
}
