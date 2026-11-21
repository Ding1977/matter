#!/usr/bin/env bun
// check-host-dist-fresh.mjs —— 宿主产物新鲜度守卫（ISS-610）
//
// 为什么需要它：自有插件的包入口是**构建产物**（`package.json` 的 `main = dist/host.js`），
// 而 `dist/` 在 `.gitignore` 里。于是「改了 lib/** 但没重建」这件事**不留任何痕迹**：
// 不进 git status、不进测试、不报错 —— 门禁全绿，真机却在跑旧代码。
// 2026-10-17 实测事故：ISS-501/1359 合并后门禁三绿、服务已重启，真机仍四条全红，
// 根因就是 dist/host.js 停留在两天前。
//
// 判据：对每个「入口为 dist/host.js」的包，取该包 lib/** 下**非测试**文件的最新 mtime，
//      若 dist/host.js 更旧 ⇒ 报红。测试文件不参与（产物不打包它们）。
// 缺 dist 的包**跳过**（全新 clone 未构建属正常，不是本守卫的判据）。
//
// 用法：bun scripts/check-host-dist-fresh.mjs        （退出码 0 = 全新鲜 / 1 = 有陈旧 / 3 = 判不了）
//       建议挂在「重启 3210 之前」这一步，见 AGENTS.md §5。
//
// 退出码三态（ISS-744）：`3` = **没有可判定的包**（全仓连一个 dist/host.js 都没有 ⇒ 分母为 0）。
//   ⚠️ 这里曾经 exit 0 —— 输出写着「本守卫不判，也不报绿」，退出码却是绿。guard 的 livecheck 只读码，
//   于是「这台机器没构建过」被当成「产物全都新鲜」。JS 世界里这叫「说不判、报绿」，正是 ISS-635 那一族的病。

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

/** 递归取一个目录下所有文件的 mtime 最大值（跳过 node_modules/dist/.git）。 */
function newestMtime(dir, skip = new Set(["node_modules", "dist", ".git"])) {
  let newest = 0
  let where = ""
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (!/\.test\.[cm]?[jt]sx?$/.test(e.name)) {
        const m = statSync(p).mtimeMs
        if (m > newest) {
          newest = m
          where = p
        }
      }
    }
  }
  walk(dir)
  return { newest, where }
}

const fmt = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16)

/**
 * 只统计 **git 已跟踪**的 `lib/**` 文件。
 *
 * 为什么不用目录遍历：测试会往 `lib/` 留**未跟踪的生成物**（如
 * `forge-browser/lib/__ratchet_selftest__.js` —— 一个故意写坏的类型探针），它的 mtime
 * 会把包误判成「产物陈旧」，守卫就变成噪音源。未跟踪文件不进产物，不该参与比较。
 * git 不可用或无跟踪文件时返回 null，调用方回退到目录遍历。
 */
function newestTrackedMtime(pkgName) {
  let out
  try {
    out = execFileSync("git", ["-C", REPO, "ls-files", "-z", `${pkgName}/lib`], { encoding: "utf8" })
  } catch {
    return null
  }
  const files = out.split("\0").filter(Boolean).filter((p) => !/\.test\.[cm]?[jt]sx?$/.test(p))
  if (files.length === 0) return null
  let newest = 0
  let where = ""
  for (const rel of files) {
    const abs = join(REPO, rel)
    if (!existsSync(abs)) continue // 已删除但索引未刷新
    const m = statSync(abs).mtimeMs
    if (m > newest) {
      newest = m
      where = abs
    }
  }
  return { newest, where }
}

const pkgs = readdirSync(REPO, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("forge-"))
  .map((e) => e.name)
  .sort()

let stale = 0
let checked = 0
const skipped = []

for (const name of pkgs) {
  const dir = join(REPO, name)
  const pkgJson = join(dir, "package.json")
  if (!existsSync(pkgJson)) continue
  let main = ""
  try {
    main = JSON.parse(readFileSync(pkgJson, "utf8")).main ?? ""
  } catch {
    continue
  }
  if (main !== "dist/host.js") continue // 入口不是产物 ⇒ 不适用

  const dist = join(dir, "dist", "host.js")
  if (!existsSync(dist)) {
    skipped.push(name)
    continue
  }
  checked++
  const distMs = statSync(dist).mtimeMs
  const { newest, where } = newestTrackedMtime(name) ?? newestMtime(join(dir, "lib"))
  if (newest > distMs) {
    stale++
    console.error(
      `✗ ${name}：dist/host.js 陈旧\n    产物 ${fmt(distMs)}  <  源码 ${fmt(newest)}\n    最新源码：${where.replace(REPO + "/", "")}\n    → 补：cd ${name} && bun run build:host`,
    )
  } else {
    console.log(`✓ ${name}：产物新鲜（${fmt(distMs)}）`)
  }
}

if (checked === 0) {
  // ISS-744：**判不了要体现在退出码上**（3 = unjudged，同 gate-runtime / guard 的 check() 口径）。
  //   首行保留「不判」字样：guard 的 livecheck 除了看码，也用它区分「真通过」与「脚本自报不判」。
  console.error("! 没有可判定的包（dist/host.js 均不存在）—— 本守卫不判，也不报绿。")
  process.exit(3)
}
if (skipped.length > 0) console.error(`（跳过未构建：${skipped.join(", ")}）`)
if (stale > 0) {
  console.error(`\n❌ ${stale}/${checked} 个包的宿主产物陈旧 —— 重启服务前必须先 build:host，否则修复静默失效。`)
  process.exit(1)
}
console.log(`\n✓ ${checked} 个包的宿主产物均新鲜。`)
