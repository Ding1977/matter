/**
 * PM 数据根的解析与「传给子进程」的一致化（从 scripts/run-gates.mjs 抽出，ISS-777）。
 *
 * ## 为什么要有这个文件
 * 同一个「语料在哪」的问题，在 run-gates 里有**两个回答者**：
 *   · 台账探针（`PROBES["pm-corpus"]`）—— 用 resolvePmRoot/resolveCorpusRoot 找到了真根
 *   · 被调度的判据子进程 —— 只认它继承到的 env，`DSH_HOME=~/.dsh` ⇒ 读到空壳根 `~/.dsh/pm`（2 个 md）
 *
 * 于是出现最难查的一类不一致：**探针说「资源在」，判据说「我没扫到」** ⇒ xfail_strict 把一条
 * 合法的豁免判成「化石」（md-corpus-guard 在 fast 档被 ⛔ 阻断，2026-11-10 实测）。
 *
 * 判据：**探针与判据必须问同一个资源**。所以不是改探针去迁就子进程，而是**把 run-gates 自己解析出的
 * 根显式传给子进程** —— 让两者用同一个答案。
 *
 * ## 顺序为什么是这个顺序
 * `~/.dsh-matter/pm` 排在 `~/.dsh/pm` 之前：后者是空壳根（主单 0 张，只有侧车），
 * 前者才是真相源（主单 2000+）。用户显式给的 `FORGE_PM_ROOT` 永远第一优先。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function resolvePmRoot() {
  const cands = [
    process.env.FORGE_PM_ROOT,
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, "pm"),
    path.join(os.homedir(), ".dsh-matter", "pm"),
    path.join(os.homedir(), ".dsh", "pm"),
  ]
  return cands.find((p) => p && fs.existsSync(p)) ?? null
}

/**
 * 子进程 env 里要补的那一段。解析不到根就**不注入**（保持原样），
 * 让判据照旧报「找不到根 ⇒ 判不了」，而不是被一个空字符串骗过去。
 */
export function pmRootEnv() {
  const root = resolvePmRoot()
  return root ? { FORGE_PM_ROOT: root } : {}
}
