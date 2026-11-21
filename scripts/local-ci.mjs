#!/usr/bin/env node
// scripts/local-ci.mjs —— 本地 CI 备用流程（ISS-903）
//
// CI 额度墙 / 静默窗期间，单命令在干净树上跑出与 .github/workflows/ci.yml **等价**的判定：
//   环境自检（真装 / @types 软链 / bun 缺失照判不了）→ build → 六 lane 等价跑 → 判定表 → 总 EXIT。
//
// 本单灵魂 = 防漂移：ci.yml 是六 lane 唯一真相源。本文件内置 LANE_MANIFEST 描述「ci.yml 每 job
// 该跑什么命令/档位」，运行时解析 ci.yml 逐行对照；ci.yml 改了 lane / 命令 / needs 而这里没跟 ⇒
// 同步自检红。local-ci 是**跑判据的工具**，不是判据：不改 registry、不改任何既有判据。
//
// 纯函数（parseCiYaml / checkDrift / checkManifestIntegrity / buildLanePlan / aggregateVerdict /
// checkTypesSymlinks）导出供 scripts/local-ci.spec.mjs 测；直接执行才跑 main()。
//
// 退出码：0 = 环境自检+同步+六 lane 全绿；1 = 任一红（环境硬失败 / 漂移 / lane 失败 / build 失败）。
// bun 缺失只是 unjudged（新树门禁不依赖 bun，ISS-867），不冒充绿也不冒充红，不阻断。

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { bunBin } from "./lib/bun-bin.mjs"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CI_YML = path.join(REPO, ".github", "workflows", "ci.yml")

/** ci.yml 里 carrying 判据的五个 job + 汇总 job。顺序 = ci.yml 出现顺序（gh pr checks 形态）。 */
export const ALL_CHECKS_JOB = "all-checks-passed"
export const EXPECTED_NEEDS = Object.freeze([
  "secret-scan",
  "next-tree",
  "doc-sync-tree",
  "coverage-tree",
  "gate-selftests",
])

/**
 * 内置 lane 清单 —— 与 ci.yml 逐行对照的**本地副本**。
 * `mustContain` 是 ci.yml 中该 job 必须出现的 run 命令字面量；`tier` 是 run-gates 档位；
 * `expectBuild` 是该 job 是否含 `pnpm run build`（逐 job 读 ci.yml 得来，不是记忆）。
 * 改 ci.yml 的 lane/命令/档位/构建前提而不改这里 ⇒ checkDrift 红；删这里的 lane ⇒ integrity 红。
 * @type {ReadonlyArray<{key:string,ciJob:string,tier:string|null,expectBuild:boolean,mustContain:ReadonlyArray<string>}>}
 */
export const LANE_MANIFEST = Object.freeze([
  Object.freeze({
    key: "secret-scan",
    ciJob: "secret-scan",
    tier: null,
    expectBuild: false,
    mustContain: Object.freeze([
      "node scripts/secret-scan.mjs --worktree",
      'node scripts/secret-scan.mjs --diff "$SCAN_BASE"',
    ]),
  }),
  Object.freeze({
    key: "next",
    ciJob: "next-tree",
    tier: "next",
    expectBuild: true,
    mustContain: Object.freeze(["node scripts/run-gates.mjs --tier next"]),
  }),
  Object.freeze({
    key: "doc-sync",
    ciJob: "doc-sync-tree",
    tier: "doc-sync",
    expectBuild: false,
    mustContain: Object.freeze(["node scripts/run-gates.mjs --tier doc-sync"]),
  }),
  Object.freeze({
    key: "coverage",
    ciJob: "coverage-tree",
    tier: "coverage",
    expectBuild: true,
    mustContain: Object.freeze([
      "./node_modules/.bin/vitest run packages --coverage",
      "node scripts/run-gates.mjs --tier coverage",
    ]),
  }),
  Object.freeze({
    key: "gateselfcheck",
    ciJob: "gate-selftests",
    tier: "gateselfcheck",
    expectBuild: false,
    mustContain: Object.freeze(["node scripts/run-gates.mjs --tier gateselfcheck"]),
  }),
])

/**
 * 极简 YAML 子解析器：只认本单需要的 jobs / job key / run / needs 四件事。
 * 不引入 yaml 依赖（克制原则）：ci.yml 形状固定，行级解析足够且可测。
 * @param {string} text ci.yml 全文
 * @returns {{jobs: Record<string,{runLines:string[],needs:string[]}>}}
 */
export function parseCiYaml(text) {
  const lines = String(text).split(/\r?\n/)
  const jobs = {}
  let inJobs = false
  let cur = null
  let runBlock = false
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue }
    if (!inJobs) continue
    if (/^\S/.test(line)) { inJobs = false; cur = null; continue } // 顶格 key = jobs 段结束
    const jm = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line) // 两空格缩进的 job key
    if (jm) {
      cur = jm[1]
      jobs[cur] = { runLines: [], needs: [] }
      runBlock = false
      continue
    }
    if (!cur) continue
    const nm = /^\s+needs:\s*\[([^\]]*)\]\s*$/.exec(line)
    if (nm) {
      jobs[cur].needs = nm[1].split(",").map((s) => s.trim()).filter(Boolean)
      continue
    }
    const rm = /^\s+run:\s*(.*?)\s*$/.exec(line)
    if (rm) {
      const v = rm[1]
      if (v === "|" || v === ">") runBlock = true
      else if (v) jobs[cur].runLines.push(v)
      continue
    }
    if (runBlock) {
      if (/^\s{10,}\S/.test(line)) { jobs[cur].runLines.push(line.trim()); continue }
      if (/^\s*$/.test(line)) continue
      runBlock = false
    }
  }
  return { jobs }
}

/**
 * 防漂移主判据：内置清单 vs ci.yml 解析结果。
 * @param {string} ciText ci.yml 全文
 * @param {typeof LANE_MANIFEST} manifest 内置 lane 清单
 * @param {string} allChecksJob 汇总 job key
 * @param {readonly string[]} expectedNeeds 汇总 job 的 needs
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkDrift(ciText, manifest = LANE_MANIFEST, allChecksJob = ALL_CHECKS_JOB, expectedNeeds = EXPECTED_NEEDS) {
  const { jobs } = parseCiYaml(ciText)
  const problems = []
  for (const lane of manifest) {
    const job = jobs[lane.ciJob]
    if (!job) { problems.push(`ci.yml 缺 job: ${lane.ciJob}`); continue }
    for (const want of lane.mustContain) {
      if (!job.runLines.includes(want)) problems.push(`${lane.ciJob} 命令漂移：期望「${want}」，实得 [${job.runLines.join(" | ")}]`)
    }
    if (lane.tier) {
      const tiers = job.runLines.flatMap((l) => [...l.matchAll(/--tier\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]))
      if (!tiers.includes(lane.tier)) problems.push(`${lane.ciJob} 档位漂移：期望 ${lane.tier}，实得 [${tiers.join(",") || "无"}]`)
    }
    const hasBuild = job.runLines.some((l) => l === "pnpm run build")
    if (hasBuild !== lane.expectBuild) {
      problems.push(
        `${lane.ciJob} 构建前提漂移：期望 ${lane.expectBuild ? "build" : "不 build"}（doc-typecheck 在已构建树上会真红），实得 ${hasBuild ? "build" : "不 build"}`,
      )
    }
  }
  const agg = jobs[allChecksJob]
  if (!agg) problems.push(`ci.yml 缺汇总 job: ${allChecksJob}`)
  else {
    const got = agg.needs.join(",")
    const want = [...expectedNeeds].join(",")
    if (got !== want) problems.push(`汇总 needs 漂移：期望 [${want}]，实得 [${got}]`)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * manifest 自身完整性（变异牙）：andle 删一 lane / 有一 lane 编排被中和 ⇒ 红。
 * @param {typeof LANE_MANIFEST} manifest
 * @param {readonly string[]} expectedKeys
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkManifestIntegrity(manifest, expectedKeys = LANE_MANIFEST.map((l) => l.key)) {
  const problems = []
  const keys = manifest.map((l) => l.key)
  for (const k of expectedKeys) if (!keys.includes(k)) problems.push(`manifest 缺 lane: ${k}`)
  for (const lane of manifest) {
    if (!lane.ciJob) problems.push(`lane ${lane.key} 无 ciJob`)
    if (!Array.isArray(lane.mustContain) || lane.mustContain.length === 0) problems.push(`lane ${lane.key} 编排被中和（mustContain 空）`)
    if (lane.key !== "secret-scan" && !lane.tier) problems.push(`lane ${lane.key} 无 tier`)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 把 manifest 翻译成可执行的 lane 编排（本地等价命令）。
 * @param {string} base secret-scan --diff 的基线 SHA（取不到传空串 ⇒ 脚本诚实不判）
 * @returns {Array<{key:string,tier:string|null,cmds:Array<{cmd:string,args:string[],label:string}>}>}
 */
export function buildLanePlan(base) {
  const node = process.execPath
  const plan = []
  for (const lane of LANE_MANIFEST) {
    const cmds = []
    if (lane.key === "secret-scan") {
      cmds.push({ cmd: node, args: ["scripts/secret-scan.mjs", "--worktree"], label: "secret-scan --worktree" })
      cmds.push({
        cmd: node,
        args: ["scripts/secret-scan.mjs", "--diff", base || ""],
        label: base ? `secret-scan --diff ${base.slice(0, 8)}` : "secret-scan --diff（无基线，脚本不判）",
      })
    } else {
      if (lane.key === "coverage") {
        cmds.push({
          cmd: path.join(REPO, "node_modules", ".bin", "vitest"),
          args: ["run", "packages", "--coverage"],
          label: "vitest 采集覆盖率（先产 coverage-summary.json）",
        })
      }
      // --json 只改输出形态，跑的档位/格数不变（档位仍由 --tier 决定）。
      cmds.push({ cmd: node, args: ["scripts/run-gates.mjs", "--tier", lane.tier, "--json"], label: `${lane.tier} 档` })
    }
    plan.push({ key: lane.key, tier: lane.tier, expectBuild: lane.expectBuild, cmds })
  }
  return plan
}

/**
 * 清掉 packages/<组>/<包>/lib 陈旧 tsc 产物（唯一被 .gitignore 的 lib，旧树 forge-<x>/lib 是跟踪源码，绝不碰）。
 * 让「不 build」lane 在冷树口径下跑（CI 每个 job 独立冷 checkout）——幂等，重复跑结果一致。
 * @returns {number} 清掉的包数
 */
export function cleanBuildOutput() {
  const pkgRoot = path.join(REPO, "packages")
  let removed = 0
  for (const group of safeReadDir(pkgRoot)) {
    for (const pkg of safeReadDir(path.join(pkgRoot, group))) {
      const lib = path.join(pkgRoot, group, pkg, "lib")
      try {
        if (fs.statSync(lib).isDirectory()) { fs.rmSync(lib, { recursive: true, force: true }); removed++ }
      } catch { /* 不存在即冷树，正常 */ }
    }
  }
  return removed
}

function safeReadDir(p) { try { return fs.readdirSync(p) } catch { return [] } }

/**
 * all-checks 汇总：五条 lane 全绿才绿（本地按 PR 口径；push 分叉本地不模拟）。
 * @param {Array<{key:string,pass:boolean}>} results
 */
export function aggregateVerdict(results) {
  const failed = results.filter((r) => !r.pass).map((r) => r.key)
  return { ok: failed.length === 0, failed }
}

/**
 * @types 软链坑自检：node_modules/@types/* 每条软链 realpath 必须存在；缺 node 即失败。
 * @param {string} typesDir node_modules/@types 绝对路径
 * @returns {{ok:boolean, problems:string[], checked:number}}
 */
export function checkTypesSymlinks(typesDir) {
  const problems = []
  let checked = 0
  let entries = []
  try { entries = fs.readdirSync(typesDir) } catch (e) {
    return { ok: false, problems: [`读不到 ${typesDir}：${e.message}`], checked: 0 }
  }
  if (!entries.includes("node")) problems.push("node_modules/@types/node 缺失（真装核验失败）")
  for (const name of entries) {
    const p = path.join(typesDir, name)
    try {
      let st = fs.lstatSync(p)
      if (st.isSymbolicLink()) { checked++; fs.realpathSync(p) } // 悬空 ⇒ 抛 ⇒ 红
    } catch (e) {
      problems.push(`@types/${name} 软链悬空：${e.message}`)
    }
  }
  return { ok: problems.length === 0, problems, checked }
}

/** 解析 pnpm 通道：直接 pnpm，退化 corepack pnpm；都没有返回 null（环境硬失败）。 */
export function resolvePnpm() {
  for (const [cmd, args, label] of [["pnpm", [], "pnpm"], ["corepack", ["pnpm"], "corepack pnpm"]]) {
    try {
      const r = spawnSync(cmd, [...args, "--version"], { cwd: REPO, encoding: "utf8", timeout: 30_000 })
      if (r.status === 0) return { cmd, args, label }
    } catch { /* 试下一条 */ }
  }
  return null
}

function runCmd(cmd, args, label) {
  const t0 = Date.now()
  let r
  try {
    r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 27, timeout: 20 * 60_000 })
  } catch (e) {
    return { label, code: -1, ms: Date.now() - t0, stdout: "", stderr: String(e.message), spawnError: true }
  }
  return { label, code: r.status ?? -1, ms: Date.now() - t0, stdout: r.stdout || "", stderr: r.stderr || "", signal: r.signal ?? null }
}

function parseCounts(stdout) {
  try {
    const g = JSON.parse(stdout)
    return g.counts || null
  } catch { return null }
}

function ts() { return new Date().toISOString() }

/** 主流程。仅直接执行时调用（import 不触发）。 */
export function main() {
  console.log(`local-ci · 本地 CI 等价判定（ISS-903）  ${ts()}`)
  console.log(`真相源 .github/workflows/ci.yml  ·  repo ${REPO}\n`)

  // ── 1. 环境自检 ───────────────────────────────────────────────
  console.log("[1/5] 环境自检（真装 / @types 软链 / bun 口径）")
  const hard = []
  const unjudged = []
  for (const bin of ["vitest", "tsc", "tsdown"]) {
    const p = path.join(REPO, "node_modules", ".bin", bin)
    try { fs.realpathSync(p) } catch (e) { hard.push(`.bin/${bin} 真装核验失败：${e.message}`) }
  }
  const types = checkTypesSymlinks(path.join(REPO, "node_modules", "@types"))
  for (const p of types.problems) hard.push(p)
  const bun = bunBin()
  if (!bun) unjudged.push("bun 缺失（bunBin→null）：照判不了口径，新树门禁不依赖 bun（ISS-867）；不冒充绿也不冒充红")
  const pnpm = resolvePnpm()
  if (!pnpm) hard.push("pnpm 通道不可用（pnpm 与 corepack pnpm 皆失败）：无法 build")
  if (hard.length) {
    for (const p of hard) console.log(`  ✗ ${p}`)
    console.error("环境自检红 ⇒ 中止（不在坏环境上出等价判定）")
    return 1
  }
  console.log(`  ✓ 真装核验通过（.bin 3 项）· @types 软链 ${types.checked} 条全实 · pnpm=${pnpm.label}`)
  for (const u of unjudged) console.log(`  · 判不了：${u}`)

  // ── 2. 防漂移同步自检（本单灵魂）──────────────────────────────
  console.log("\n[2/5] 防漂移同步自检（内置清单 vs ci.yml）")
  let ciText
  try { ciText = fs.readFileSync(CI_YML, "utf8") } catch (e) {
    console.error(`  ✗ 读不到 ci.yml：${e.message}`)
    return 1
  }
  const drift = checkDrift(ciText)
  const integrity = checkManifestIntegrity(LANE_MANIFEST)
  if (!drift.ok || !integrity.ok) {
    for (const p of drift.problems) console.log(`  ✗ 漂移：${p}`)
    for (const p of integrity.problems) console.log(`  ✗ 编排：${p}`)
    console.error("同步自检红 ⇒ ci.yml 与 local-ci 已漂移，等价判定不可信")
    return 1
  }
  console.log(`  ✓ ${LANE_MANIFEST.length} lane 命令/档位逐行匹配 · needs(${EXPECTED_NEEDS.length}) 匹配 · manifest 完整`)

  // ── 3. 免构建 lane（冷树口径，对齐 CI 每个 job 独立冷 checkout）──
  // ci.yml 逐 job 派生：expectBuild=false 的 lane 不 build。doc-typecheck 在已 build 树上真红
  // （ci.yml L181-183），冷跑才是等价形态；故先清陈旧 lib 再跑这三条，幂等。
  const coldKeys = LANE_MANIFEST.filter((l) => !l.expectBuild).map((l) => l.key)
  console.log(`\n[3/5] 免构建 lane（冷树口径：${coldKeys.join(" / ")}）`)
  const removed = cleanBuildOutput()
  console.log(`  · 清理 packages/*/*/lib 陈旧产物 ${removed} 个（对齐冷 checkout；旧树 forge-*/lib 跟踪源码不碰）`)

  let base = ""
  try {
    const bb = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: REPO, encoding: "utf8" })
    if (bb.status === 0 && /^[0-9a-f]{7,40}$/i.test((bb.stdout || "").trim())) base = bb.stdout.trim()
  } catch { /* 取不到基线 ⇒ secret-scan 脚本自己诚实不判 */ }
  const plan = buildLanePlan(base)

  /** 跑一条 lane 的全部命令，返回判定行。 */
  function runLane(lane) {
    let pass = true
    const detailParts = []
    let ms = 0
    for (const c of lane.cmds) {
      const r = runCmd(c.cmd, c.args, c.label)
      ms += r.ms
      if (r.code !== 0) pass = false
      const counts = parseCounts(r.stdout)
      if (counts) detailParts.push(`${counts.passed}/${counts.passed + counts.failed + counts.unjudged} ug=${counts.unjudged}`)
      if (r.code !== 0) detailParts.push(`${c.label} exit=${r.code}`)
    }
    if (detailParts.length === 0) detailParts.push(lane.key === "secret-scan" ? "worktree+diff" : "ok")
    return { key: lane.key, pass, ms, detail: detailParts.join(" ") }
  }

  const rows = new Map()
  for (const lane of plan.filter((l) => !l.expectBuild)) {
    const row = runLane(lane)
    rows.set(row.key, row)
    console.log(`  · ${row.key} ${row.pass ? "PASS" : "FAIL"} ${row.ms}ms`)
  }

  // ── 4. build + 需构建 lane ────────────────────────────────────
  const hotKeys = LANE_MANIFEST.filter((l) => l.expectBuild).map((l) => l.key)
  console.log(`\n[4/5] build + 需构建 lane（${hotKeys.join(" / ")}）`)
  const b = runCmd(pnpm.cmd, [...pnpm.args, "run", "build"], "pnpm run build")
  if (b.code !== 0) {
    console.log(`  ✗ build 失败 exit=${b.code} ${b.ms}ms`)
    console.error((b.stderr || b.stdout).split("\n").slice(-15).join("\n"))
    return 1
  }
  console.log(`  ✓ build exit=0 ${b.ms}ms`)
  for (const lane of plan.filter((l) => l.expectBuild)) {
    const row = runLane(lane)
    rows.set(row.key, row)
    console.log(`  · ${row.key} ${row.pass ? "PASS" : "FAIL"} ${row.ms}ms`)
  }

  // 判定表按 ci.yml 的 job 顺序排（gh pr checks 形态）；all-checks 汇总殿后。
  const laneRows = plan.map((l) => rows.get(l.key))
  const core = laneRows
  const agg = aggregateVerdict(core.map((r) => ({ key: r.key, pass: r.pass })))
  laneRows.push({ key: "all-checks", pass: agg.ok, ms: 0, detail: agg.ok ? `${core.length} lanes` : `失败: ${agg.failed.join(",")}` })

  // ── 5. 判定表 + 总 EXIT ───────────────────────────────────────
  console.log("\n[5/5] 判定表（形如 gh pr checks）")
  console.log("  " + "lane".padEnd(16) + "status".padEnd(9) + "exit".padEnd(7) + "ms".padEnd(9) + "detail")
  for (const r of laneRows) {
    console.log("  " + r.key.padEnd(16) + (r.pass ? "PASS" : "FAIL").padEnd(9) + (r.pass ? "0" : "1").padEnd(7) + String(r.ms).padEnd(9) + r.detail)
  }
  const allPass = agg.ok && laneRows.every((r) => r.pass)
  console.log(`\n总 EXIT = ${allPass ? 0 : 1}  （${laneRows.filter((r) => r.pass).length}/${laneRows.length} lanes PASS）  ${ts()}`)
  return allPass ? 0 : 1
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main()
}
