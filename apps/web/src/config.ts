/**
 * 浏览器壳的启动配置解析（ISS-537 / P4-S1 · 嵌入友好①）。
 *
 * 后端地址不写死在 boot 里：从 URL query 与构建期 env 注入。优先 URL（运行时可改，
 * 嵌入式宿主按会话给不同后端），env 作构建期默认，最后落到相对路径 `/api`（同源）——
 * 三层显式解析，不在 `run()` 内用 `??` 隐藏来源（边界显式优于隐式）。
 *
 * 嵌入模式开关（嵌入友好③）走同一套注入：URL `embed=1` 或 env `VITE_SHELL_EMBED`。
 * 这是产品开关（隐藏自带 chrome、单页聚焦），不是架构改动——只影响渲染分支。
 *
 * @module apps/web/src/config
 */

/** 解析后的壳配置（冻结形状）。 */
export interface ShellConfig {
  /** 后端 API 根地址（末尾无斜杠）；stub 阶段不请求，仅供后续 N 轨消费。 */
  readonly apiBase: string
  /** 嵌入模式：隐藏自带 chrome、单页聚焦。 */
  readonly embed: boolean
}

/** 配置注入的原始来源（URL query + 构建期 env）。 */
export interface ConfigSources {
  /** URL query（如 `?apiBase=http://localhost:8100&embed=1`）。 */
  readonly search: string
  /** 构建期环境变量（Vite `import.meta.env` 的子集）。 */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** URL 参数名（对外契约，大小写敏感）。 */
export const PARAM_API_BASE = "apiBase"
export const PARAM_EMBED = "embed"
/** 构建期 env 名。 */
export const ENV_API_BASE = "VITE_SHELL_API_BASE"
export const ENV_EMBED = "VITE_SHELL_EMBED"
/** 缺省后端：同源相对路径，N 轨之前不发起请求。 */
export const DEFAULT_API_BASE = "/api"

/** `embed` 真值字面量（只有精确 "1"/"true" 算置位，避免 "false" 被误判）。 */
const TRUTHY = new Set(["1", "true"])

/** 去掉末尾斜杠，`/` 根本身保留。 */
function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value
}

/**
 * 从 URL/env 两层来源解析壳配置（纯函数，可单测）。
 *
 * @param sources - URL search 串 + 构建期 env 字典。
 * @returns 冻结的壳配置。
 */
export function resolveConfig(sources: ConfigSources): ShellConfig {
  const query = new URLSearchParams(sources.search)
  const fromUrl = query.get(PARAM_API_BASE)
  const fromEnv = sources.env[ENV_API_BASE]
  const apiBase = stripTrailingSlash(fromUrl ?? fromEnv ?? DEFAULT_API_BASE)
  const embedRaw = query.get(PARAM_EMBED) ?? sources.env[ENV_EMBED]
  return Object.freeze({ apiBase, embed: embedRaw !== null && embedRaw !== undefined && TRUTHY.has(embedRaw) })
}

/**
 * 浏览器现场采集：读当前 `location.search` 与 Vite 注入的 `import.meta.env`。
 *
 * 单独成函数而非在 boot 里内联，让 smoke 用构造数据走 `resolveConfig` 纯函数，
 * 真机这一层只做「把浏览器全局读出来」的薄封装。
 *
 * @returns 当前页面的配置来源。
 */
export function browserConfigSources(): ConfigSources {
  const meta = import.meta.env as unknown as Record<string, string | undefined>
  return { search: globalThis.location?.search ?? "", env: meta }
}
