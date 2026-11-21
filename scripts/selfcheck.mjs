#!/usr/bin/env node
// selfcheck（ISS-736）—— builder 的「一条命令自检」，产出六段机读证据。
//
// 它**不是**新一套门禁：只是 `run-gates --tier fast --only-changed --json` 的包装，
// 把结果补成审查员能直接吃掉的六段。**fast 不是完整门禁**（见 run-gates 的档位定义），
// 它只证明「快档那些格没坏」；build / test / typecheck / oxlint 全量仍由 pre-push 与 CI 覆盖。
//
// ⚠️ ISS-806 起指向 `fast`（原 `quick`）：builder 该跑真判据，不是跑判据自检。
//   判据自检（`*-selftest`）已从 fast 移到 `--tier gateselfcheck`，那是**判据维护者**的活。
//
// 用法：bun run selfcheck        （等价 node scripts/selfcheck.mjs）
// 退出码：0 = fast 全绿；1 = 有红或判不了；2 = 自身判不了（run-gates 输出不可解析）
//
// 六段（stdout 是纯 JSON；人读摘要走 stderr）：
//   scope     改动面（run-gates 的 onlyChanged；降级/缺席 ⇒ available:false + why）
//   commands  每格 命令 → 退出码 → 读数
//   reds      本次红项（fast 档已排除判据自检格 ⇒ 非空即本单引入）
//   unjudged  判不了（不算绿）
//   coverage  跑了哪些面 + 明确没测什么
//   head      分支 / commit / dirty 计数

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")
const run = (cmd, args) => spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 27 })

// SELFCHECK_FROM：读一份已有的 run-gates --json 输出做「复现/红路径验证」，不真跑。
// 存在的理由与 --coverage-from 同构：红路径不能靠「碰巧把某格弄坏」来验，要能注入。
const fromFile = process.env.SELFCHECK_FROM || null
let r
if (fromFile) {
  try {
    r = { status: 0, stdout: fs.readFileSync(fromFile, "utf8"), stderr: "" }
  } catch (e) {
    console.error(`✗ selfcheck 判不了：读不到 SELFCHECK_FROM=${fromFile}（${e.message}）`)
    process.exit(2)
  }
} else {
  r = run(process.execPath, [path.join(REPO, "scripts/run-gates.mjs"), "--tier", "fast", "--only-changed", "--json"])
}
let g
try {
  g = JSON.parse(r.stdout)
} catch {
  console.error("✗ selfcheck 判不了：run-gates --json 输出不是纯 JSON（机器模式被人类输出污染）")
  console.error(`  exit=${r.status}  stdout 头部：${(r.stdout || "").slice(0, 300).replace(/\n/g, " ")}`)
  console.error(`  stderr 头部：${(r.stderr || "").slice(0, 300).replace(/\n/g, " ")}`)
  process.exit(2)
}

const results = g.results ?? []
const reds = results.filter((x) => x.status === "failed")
const unjudged = results.filter((x) => x.status === "unjudged")
const passed = results.filter((x) => x.status === "passed")
// run-gates 在 --json 下把「已降级为全量」写进 stderr；把具体原因捞出来，
// 别用「空 / 取不到 / 根文件」三合一的模糊文案（那正是 scope 段要回答的问题）。
const degradedLine = (r.stderr || "").split("\n").map((l) => l.trim()).find((l) => l.includes("已降级为全量")) || ""

// scope：直接复用 run-gates 的读数（它已经跑过 change-scope，不重复 spawn）。
// 缺席 / 降级必须显式标出来 —— 「不知道改了哪些」不等于「没改」。
const oc = g.onlyChanged
const scope = oc
  ? oc.narrowed
    ? { available: true, base: oc.base, changedFiles: oc.changedFiles, changedAreas: oc.changedAreas, ranCells: oc.ranCells, skippedCells: oc.skippedCells, skipped: oc.skipped }
    : { available: false, degradedToFull: true, why: degradedLine.replace(/^⚠️\s*/, "") || "已降级为全量 fast（run-gates 未给出具体原因）" }
  : { available: false, why: "run-gates 未返回 onlyChanged（没传 --only-changed？）" }

const head = (() => {
  const h = run("git", ["rev-parse", "--short", "HEAD"])
  const b = run("git", ["branch", "--show-current"])
  const s = run("git", ["status", "--porcelain"])
  return {
    branch: (b.stdout || "").trim() || "(detached)",
    commit: (h.stdout || "").trim(),
    dirtyFiles: (s.stdout || "").split("\n").filter(Boolean).length,
  }
})()

const evidence = {
  tool: "selfcheck",
  tier: g.tier ?? "fast",
  head,
  scope,
  commands: results.map((x) => ({
    id: x.id,
    status: x.status,
    exitCode: x.exitCode,
    durationMs: x.durationMs,
    reading: x.note ?? (x.status === "passed" ? "ok" : ""),
  })),
  reds,
  unjudged,
  coverage: {
    ran: passed.length,
    total: results.length,
    wallMs: g.wallMs,
    workers: g.workers,
    // 「没测什么」必须写死，否则 selfcheck 会被当成完整门禁用。
    notCovered: [
      "build / build:host / build:client",
      "test（vitest 全量）",
      "typecheck / host 类型棘轮",
      "oxlint / jscpd 全量",
      "secret-scan 全仓（fast 档未含：单格 46s）",
      "fast / full / ci 的其余格（由 pre-push 与 CI 覆盖）",
    ],
  },
}

const summary =
  `selfcheck · ${results.length} 格 · ${passed.length} 绿 / ${reds.length} 红 / ${unjudged.length} 判不了 · ${g.wallMs}ms · ` +
  `${head.branch}@${head.commit}${head.dirtyFiles ? ` · dirty ${head.dirtyFiles}` : ""}`
console.error(summary)
if (!scope.available) console.error(`⚠️ scope：${scope.why}`)
if (reds.length) {
  console.error("红名单：")
  for (const x of reds) console.error(`  ✗ ${x.id}  ${x.note ?? ""}`)
}
if (unjudged.length) {
  console.error("判不了：")
  for (const x of unjudged) console.error(`  ! ${x.id}  ${x.note ?? ""}`)
}
console.error("（fast 不是完整门禁；没测的面见 JSON 的 coverage.notCovered）")

process.stdout.write(JSON.stringify(evidence, null, 2) + "\n")
process.exit(reds.length || unjudged.length ? 1 : r.status === 0 ? 0 : 1)
