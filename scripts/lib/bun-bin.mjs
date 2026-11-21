// 找 `bun` 可执行文件 —— ISS-505 / ISS-669 同一个病根：**别信 `process.execPath` 或 PATH**。
//
// 背景（两条实测，都是「假设不成立但不报错」那一族）：
//
//   ① ISS-669：包脚本/PATH 里的裸 `bun` 依赖 PATH。agent 宿主与 launchd 的 PATH 常不含
//      `~/.bun/bin` ⇒ 子进程根本没起来，报错被上层当成「探针失败」⇒ **假红**。
//     当年的修法是改用 `process.execPath`（跑测试的就是 bun 自己）。
//
//   ② ISS-505：改用 vitest 之后，`process.execPath` **变成了 node** ——
//      于是凡是「拿 execPath 去跑 bun 专有子命令」（`bun build`）的用例，会在
//      迁移后静默失效：报的是「bundle 构建失败」，而真相是「node 不认识 build 子命令」。
//      ⇒ 修法不能只靠 execPath，要显式分辨「我要的是 bun 还是 node」。
//
// 结论：这里给两条明确的取法，调用方按需选，不许再各自猜。
//   · bunBin()  —— 要执行 bun 专有子命令（build / transpile / run）时用这个
//   · nodeBin() —— 只需要一个 JS 运行时跑普通脚本时用这个（vitest 下就是 execPath，
//                  bun 下退回 node：本仓 CI/生产跑的都是 node，口径更接近真实）
//
// ⚠️ 找不到就返回 null，**不返回裸名** —— 裸名会让调用方去 PATH 里碰运气（ISS-669 的原形）。
//   ISS-867：原先这里「找不到就抛」，但三处消费者（run-gates.mjs 的 bun 探针 / lint-mutation-tests /
//   check-pm-suite-twice）早已写好 `if (!bun)` 的降级分支 —— 抛错让那些分支成了死代码，还把
//   「无 bun 跑 next 档」这种**根本不需要 bun** 的场合崩在建表期。返回 null 让降级路径复活。

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/** 候选顺序：跑测试的进程自己若是 bun ⇒ 就是它；再试 PATH；最后试已知安装位。 */
function candidates() {
  const out = []
  // ① 进程自己就是 bun（`bun test` 形态）
  if (/\bbun\b/.test(process.execPath)) out.push(process.execPath)
  // ② PATH（`which bun` 的等价物，但用 spawn 验真而不是只看文件名）
  out.push("bun")
  // ③ 已知安装位（BUN_INSTALL 可覆盖；默认 ~/.bun/bin）
  const home = process.env.BUN_INSTALL ?? join(process.env.HOME ?? "", ".bun")
  out.push(join(home, "bin", "bun"))
  return out
}

let cached

/**
 * 返回一个**真的能跑**的 bun 绝对路径（带缓存）。找不到返回 `null`（ISS-867）。
 *
 * `null` 是「本机没有可用 bun」的诚实读数，不是错误：调用方据此记「判不了」、降级或跳过，
 * 不冒充绿也不冒充红（见 run-gates.mjs 的 `needsBun` / `bun` 探针、lint-mutation-tests 等）。
 * 绝不返回裸名「bun」—— 那会让调用方去 PATH 碰运气，正是 ISS-669 的病根。
 */
export function bunBin() {
  if (cached !== undefined) return cached
  for (const c of candidates()) {
    if (c.includes("/") && !existsSync(c)) continue
    try {
      const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 10_000 })
      if (r.status === 0) {
        cached =
          c.includes("/")
            ? c
            : // PATH 命中：问它自己真实位置（macOS 下 which 可能给软链，path.resolve 不够）
              String(spawnSync("/usr/bin/which", [c], { encoding: "utf8" }).stdout ?? "").trim() || c
        return cached
      }
    } catch {
      // 这个候选不行，试下一个
    }
  }
  // 找不到 = 本机没装/不可用 ⇒ null（带缓存，不重复探测）。不是测试逻辑错误，不抛。
  // 调用方各有降级：run-gates 记「判不了」、lint-mutation-tests / check-pm-suite-twice 退内部码。
  cached = null
  return null
}

/**
 * 「只要一个能跑本仓 .mjs/.js 的 JS 运行时」时用它。
 *
 * vitest 下 = `process.execPath`（node）。
 * bun 下 = 也退回 **node**（本仓 CI 与生产跑 node，口径更接近真实；bun 能跑 node 脚本，
 * 但反过来 node 跑不了 bun 专有 API —— 用 node 是更严的那一侧）。
 */
export function nodeBin() {
  return process.execPath
}
