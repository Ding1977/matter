// 外部二进制定位 + 「环境缺失」报错（ISS-669）
//
// ## 为什么需要它
//
// 测试用例会 spawn 外部二进制（`python3.11` / `node`）。它们**裸名**去找时，能不能找到
// 取决于跑测试的那个进程的 `PATH` —— 而 agent / 宿主进程的 `PATH` 取决于 DSH 服务是怎么起来的
// （launchd 起的桌面端只会拿到 `/usr/bin:/bin:/usr/sbin:/sbin`），**与用户登录 shell 的 PATH 不同**。
// 于是同一份代码、同一个工作树，两个会话跑出两种结果：
//   PATH 缺 `/opt/homebrew/bin` ⇒ `spawn("python3.11")` ENOENT ⇒ 子进程没起来
//   ⇒ 断言 `expect(alive).toBe(true)` 报 "Expected true, Received false"
//   ⇒ **看起来像代码坏了，其实是机器/会话缺东西**。
// 门禁是收口的唯一凭据，这种假红损坏的是「判断」本身（≠ 一个失败的用例）。
//
// ## 判据：两种失败必须分开报
//
//   ① 找到了，用例跑挂  ⇒ 真失败（代码缺陷）
//   ② 找不到          ⇒ 环境缺失（本机/本会话缺前提，与 diff 无关）
//
// 所以这里是两件事：`resolveTool` 先按 `command -v` 语义查 PATH，**再查已知安装位兜底**
// （与 `scripts/ws.sh:resolve_bun` 同一口径）；`requireTool` 在还是找不到时抛一个
// **名字叫得出来的错误**，消息里写明「不是代码缺陷」+ 查过哪些目录 + 怎么补。
//
// ⚠️ 别把这里退化成 `.skip()`：跳过 = 静默通过 = 假绿，比假红更坏。
// ⚠️ 也别让它变成"随手忽略缺失"：找不到就抛，不返回空串。
import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"

/** 常见安装位：Homebrew(Apple Silicon) / Homebrew(Intel) / bun 官方安装脚本。 */
export function defaultDirs(home: string = homedir()): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".bun", "bin")]
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface ResolveOptions {
  /** 覆盖 PATH（缺省 `process.env.PATH`）。守卫用它模拟「PATH 被裁剪」。 */
  envPath?: string
  /** 覆盖已知安装位（缺省 `defaultDirs()`）。守卫用它证明兜底那段真的在起作用。 */
  dirs?: string[]
}

/**
 * 定位一个外部二进制。命中返回**绝对路径**（可直接喂 spawn，不再依赖子进程的 PATH），
 * 找不到返回 `null`。
 *
 * 顺序：PATH（`command -v` 语义）→ 已知安装位。**不前置**已知位 —— 不遮蔽用户自己装的同名工具。
 */
export function resolveTool(name: string, opts: ResolveOptions = {}): string | null {
  if (isAbsolute(name)) return isExecutable(name) ? name : null
  const dirs = opts.dirs ?? defaultDirs()
  const envPath = opts.envPath ?? process.env.PATH ?? ""
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** 「环境缺失」—— 与「用例失败」区分开的那一类错误。 */
export class MissingToolError extends Error {
  readonly tool: string
  readonly searched: string[]

  constructor(tool: string, searched: string[], detail: string) {
    super(detail)
    this.name = "MissingToolError"
    this.tool = tool
    this.searched = searched
  }
}

export interface RequireOptions extends ResolveOptions {
  /** 可用于覆盖的既有环境变量名（如 `TRAND_PYTHON`），写进报错文案。 */
  envVar?: string
  /** 额外说明（为什么这个用例需要它），写进报错文案。 */
  why?: string
}

/**
 * 同 `resolveTool`，但找不到时抛 `MissingToolError`。
 *
 * 消息必须满足两条：① 一眼看出是**环境**问题不是代码问题；② 给出可执行的补法。
 */
export function requireTool(name: string, opts: RequireOptions = {}): string {
  const dirs = opts.dirs ?? defaultDirs()
  const envPath = opts.envPath ?? process.env.PATH ?? ""
  const searched = [...envPath.split(delimiter).filter(Boolean), ...dirs]
  const override = opts.envVar ? `\n  · 或用环境变量 ${opts.envVar} 直接指定绝对路径` : ""
  const why = opts.why ? `\n  用途：${opts.why}` : ""

  // 显式覆盖优先：给了就必须能用 —— 给了却不可执行是**配置错**，同样按环境缺失报，不静默回落。
  if (opts.envVar) {
    const given = process.env[opts.envVar]
    if (given) {
      if (isExecutable(given)) return given
      throw new MissingToolError(
        name,
        searched,
        `环境缺失（不是代码缺陷）：${opts.envVar}=${given} 不可执行。\n` +
          `  这不是测试失败 —— 是把覆盖变量指到了不存在/不可执行的文件。\n` +
          `  修：改正或删除 ${opts.envVar}。${why}`,
      )
    }
  }

  const found = resolveTool(name, { envPath, dirs })
  if (found) return found

  throw new MissingToolError(
    name,
    searched,
    `环境缺失（不是代码缺陷）：找不到可执行的 ${name}。\n` +
      `  查过（PATH）：${envPath.split(delimiter).filter(Boolean).join(":") || "<空>"}\n` +
      `  查过（已知安装位）：${dirs.join(":")}\n` +
      `  ⇒ 换一台机器 / 换一个会话（PATH 不同）就会变，**与本次 diff 无关**。\n` +
      `  修：装上 ${name} 并确保它在 PATH 里${override}。${why}`,
  )
}
