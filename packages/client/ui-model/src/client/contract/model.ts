/**
 * ui-model 共享契约（layer 0）：模型行 / provider 分组 / ctx 注入目录 + 纯函数。
 *
 * ## 跨包纪律（ISS-543）
 *
 * 模型目录由 ctx/prop 注入（本单是 stub；llm 域真实目录是 P5+），本包真消费、不另造
 * store、不 import 兄弟 UI 包。搜索/分组/高亮纯函数供 panel 消费，装配点 apply.ts 才跨域。
 *
 * ## 形态学来源（带行号）
 *
 * - 两级面板 + 搜索框：DSH `ModelSelect.tsx:3-13`（root menu 与 drilled pane 的两级结构、
 *   >4 条模型出搜索、↑↓ 循环高亮、provider 分组）。
 * - ↑↓ 回绕高亮：`ModelSelect.tsx:284-290`（`(active + direction + length) % length`）。
 * - 有序子序列匹配：`ModelSelect.tsx:17-19`（case-insensitive ordered subsequence）。
 * - 焦点纪律（搜索框常驻焦点、列表用 active descendant）：Linear 档案 §6 K4/K6 仅导航参考。
 *
 * @module @matter/client-ui-model/client/contract/model
 */

/** 一行模型（ctx 注入 stub 的最小展示投影）。 */
export interface ModelRow {
  /** 模型 id（稳定键）。 */
  readonly id: string
  /** 所属 provider id。 */
  readonly provider: string
  /** 展示名（搜索匹配的目标）。 */
  readonly name: string
  /** 默认推理强度（详情展示）。 */
  readonly effort: string
}

/** 一个 provider 分组。 */
export interface ProviderGroup {
  /** provider id。 */
  readonly id: string
  /** provider 展示名。 */
  readonly name: string
  /** 该组的模型（注入顺序）。 */
  readonly models: readonly ModelRow[]
}

/** ctx 注入的模型目录（本单 stub；llm 域真实目录是 P5+）。 */
export interface ModelDirectory {
  /** provider 分组（注入顺序即展示顺序）。 */
  readonly groups: readonly ProviderGroup[]
}

/**
 * stub 模型目录：3 个 provider / 6 个模型（>4 出搜索，照 DSH `showSearch` 阈值）。
 * 由挂载方经 ctx/prop 注入——本函数是测试与 shell 的注入源，不是运行时 store。
 * @returns 一份稳定的 stub 目录（新对象，调用方可安全持有）。
 */
export function stubDirectory(): ModelDirectory {
  return {
    groups: [
      {
        id: "deepseek", name: "DeepSeek",
        models: [
          { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek V3", effort: "medium" },
          { id: "deepseek-reasoner", provider: "deepseek", name: "DeepSeek R1", effort: "high" },
        ],
      },
      {
        id: "openai", name: "OpenAI",
        models: [
          { id: "gpt-4o", provider: "openai", name: "GPT-4o", effort: "low" },
          { id: "gpt-4o-mini", provider: "openai", name: "GPT-4o mini", effort: "low" },
          { id: "o3", provider: "openai", name: "o3", effort: "high" },
        ],
      },
      {
        id: "anthropic", name: "Anthropic",
        models: [
          { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet", effort: "medium" },
        ],
      },
    ],
  }
}

/**
 * 大小写不敏感的有序子序列匹配（DSH `rankByName` 的最小形态，ModelSelect.tsx:17-19）。
 * 空查询命中全部；非空查询要求字符按序出现（不要求连续）。
 * @param name - 模型展示名。
 * @param query - 搜索串（已 trim 由调用方保证）。
 * @returns 是否命中。
 */
export function matchesQuery(name: string, query: string): boolean {
  if (query === "") return true
  const target = name.toLowerCase()
  let at = 0
  for (const ch of query.toLowerCase()) {
    const found = target.indexOf(ch, at)
    if (found === -1) return false
    at = found + 1
  }
  return true
}

/**
 * 按查询过滤并按 provider 分组（保持注入顺序；空组丢弃）。
 * @param directory - ctx 注入的目录。
 * @param query - 搜索串。
 * @returns 过滤后的分组数组。
 */
export function filterGroups(directory: ModelDirectory, query: string): ProviderGroup[] {
  const out: ProviderGroup[] = []
  for (const group of directory.groups) {
    const models = group.models.filter((model) => matchesQuery(model.name, query))
    if (models.length > 0) out.push({ id: group.id, name: group.name, models })
  }
  return out
}

/**
 * 分组展平成可导航行序（↑↓ 的索引空间，与 DSH `visibleModels` 同口径 ModelSelect.tsx:119-124）。
 * @param groups - 过滤后的分组。
 * @returns 展平的模型数组（新数组）。
 */
export function visibleModels(groups: readonly ProviderGroup[]): ModelRow[] {
  return groups.flatMap((group) => [...group.models])
}

/**
 * 高亮索引循环：±step 后取模回绕；空列表回 0（DSH ModelSelect.tsx:284-290）。
 * @param current - 当前高亮索引。
 * @param step - 步长（↑ = -1 / ↓ = +1）。
 * @param length - 可见行数。
 * @returns 新的高亮索引（0..length-1；length≤0 时为 0）。
 */
export function moveHighlight(current: number, step: number, length: number): number {
  if (length <= 0) return 0
  return ((current + step) % length + length) % length
}
