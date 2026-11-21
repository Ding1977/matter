// wt-scan-lib.mjs —— 工作树治理的**判据层**（纯函数，可被单测/自测直接 import）
//
// 为什么单独一份（ISS-553）：`wt-scan.mjs` 是**脚本**，import 它就会把整轮采集跑一遍并打印报告
// （实测：自测里 import 那个函数 ⇒ stdout 混进一整份扫描报告，断言全被污染）。
// 判据住在脚本里就测不到，这条仓内早已认过第二次（`ws-lease-selftest.sh` 头注同款理由）。
// 所以：**判据住这里，采集与打印住 wt-scan.mjs**。

/**
 * 主检出的**未跟踪顶层目录**（ISS-553 的判据层：喂 `git status --porcelain` 的原文就能判）。
 *
 * 为什么单独一格（09-29 起裸奔 2 天的 `forge-widgets/` 就是理由）：
 * 采集层原来只看**工作树与租约文件**，而「主检出躺着一个没人认领的新目录」既不是工作树也不是租约，
 * 于是 K4a/K7b 天天为它红却没人知道该谁收。这里把它变成**可判的一格**。
 *
 * 三条口径写死，别靠调用方兜：
 * - 只认 `?? <名字>/` 这种**目录**条目 ⇒ 未跟踪的单个文件不算（那多半是半成品，不该报给人）；
 * - 只数**顶层**（含 `/` 的嵌套条目跳过）⇒ 报出来的是"包/目录"这一级，不是噪声；
 * - 点开头（`.git`、`.cache` 之类）不算。
 *
 * @param text git status --porcelain 的原文
 * @returns {{name: string}[]}
 */
export function untrackedDirsFromPorcelain(text) {
  const out = []
  for (const line of String(text || "").split("\n")) {
    const m = /^\?\? (.+)\/\s*$/.exec(line)
    if (!m) continue
    const name = String(m[1]).trim()
    if (!name || name.startsWith(".") || name.includes("/")) continue
    out.push({ name })
  }
  return out
}
