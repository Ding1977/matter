// git 子进程的唯一实现（ISS-696 · K6a 的"同体两份"教训）
//
// 为什么有这份文件：`scripts/git-health-check.mjs` 里已经有一个 `git()` 包装（`-C <repo>` +
// GIT_OPTIONAL_LOCKS=0 + allowFail 时才吞错）。我新写 `review-pack.mjs` 时又落了一个"看着一样"的版本
// （用 `cwd` 而不是 `-C`、失败返回 null）—— 两个实现的区别全是手滑造成的，而这种同名不同体的副本
// 正是 K6a/D2 要拦的东西（09-23 实测：正因为多了这一份，`K6a` 上限从 211 被顶到 212，
// 而上限只许降不许升 ⇒ 只能把两份合成一份，不能录新上限）。
//
// 语义（逐字照抄 git-health-check 的那一版，只做两处**单向放宽**）：
// - 走 argv 数组 + `execFileSync`：**不经 shell** ⇒ 参数里的 `;`、反引号、`$()` 都只是字面量；
// - `maxBuffer` 提到 32MB：原来的 1MB 默认值在"跑全历史 `git log`"时会 ENOBUFS 抛错，这是纯加固；
// - 失败默认**抛错**，只有显式 `{allowFail: true}` 才返回空串（调用方要"没有结果"这个语义时自己映射）。
//
// 名字里带 `Sync` 是有原因的：文件中心插件（已整包退役）的 `lib/index.js:45` 曾有一个 `runGit`，那是**异步**的
// （`execFile` + Promise，返回 `{error}|{output}`，还自带 cleanGitEnv）。两者契约不同，共用一个名字
// 等于给下一个读者埋"看起来可以互换"的雷 —— 而 D2/K6a 也正是把这种同名当成重复件计出来（09-23 实测：
// 本文件入库后 `K6a` 211 → 212，多出的那一组就是 `runGit`）。所以这里叫 `runGitSync`。
import { execFileSync } from "node:child_process"

export function runGitSync(repo, args, opts = {}) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 << 20,
      ...opts,
    })
  } catch (err) {
    if (opts.allowFail) return ""
    throw err
  }
}
