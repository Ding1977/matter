// scripts/local-ci.spec.mjs —— 本地 CI 备用流程（ISS-903）的单元规格。
// 判据来自 ISS-903 acceptance：防漂移同步红、必然失败用例、删 lane/中和编排变异牙、lane 等价编排。
// 纯函数从 local-ci.mjs 导入测，不真跑子进程；真机全量由 pnpm run ci:local 承担。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  parseCiYaml,
  checkDrift,
  checkManifestIntegrity,
  buildLanePlan,
  aggregateVerdict,
  checkTypesSymlinks,
  LANE_MANIFEST,
  ALL_CHECKS_JOB,
  EXPECTED_NEEDS,
} from "./local-ci.mjs"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const CI = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8")

// ── 真相源解析 ────────────────────────────────────────────────────

test("parseCiYaml 抽出六个 job 与 needs 五元", () => {
  const { jobs } = parseCiYaml(CI)
  assert.deepEqual(Object.keys(jobs), [
    "secret-scan", "next-tree", "doc-sync-tree", "coverage-tree", "gate-selftests", ALL_CHECKS_JOB,
  ])
  assert.deepEqual(jobs[ALL_CHECKS_JOB].needs, [...EXPECTED_NEEDS])
})

// ── 防漂移：正向 + 必然失败用例 ───────────────────────────────────

test("真 ci.yml 与内置清单逐行匹配 ⇒ 同步自检绿", () => {
  const r = checkDrift(CI)
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
})

test("必然失败：改 ci.yml 一个 tier 名 ⇒ 同步自检红（点名档位漂移）", () => {
  const mutated = CI.replace("--tier next\n", "--tier NEXT_TIER_DRIFT\n")
  assert.notEqual(mutated, CI, "变异必须真的改到文件")
  const r = checkDrift(mutated)
  assert.equal(r.ok, false, "ci.yml 改了档位而 local-ci 没跟 ⇒ 必须红")
  assert.ok(r.problems.some((p) => p.includes("next-tree") && p.includes("档位漂移")), JSON.stringify(r.problems))
})

test("必然失败：改 ci.yml 一条命令 ⇒ 同步自检红（点名命令漂移）", () => {
  const mutated = CI.replace("node scripts/secret-scan.mjs --worktree", "node scripts/secret-scan.mjs --worktree --drifted")
  assert.notEqual(mutated, CI)
  const r = checkDrift(mutated)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes("secret-scan") && p.includes("命令漂移")), JSON.stringify(r.problems))
})

test("必然失败：给 doc-sync job 加一个 build 步 ⇒ 同步自检红（构建前提漂移）", () => {
  const mutated = CI.replace(
    "      # ⚠️ 刻意不 build（ISS-895 审查退回处置）",
    "      - name: 构建\n        run: pnpm run build\n\n      # ⚠️ 刻意不 build（ISS-895 审查退回处置）",
  )
  assert.notEqual(mutated, CI)
  const parsed = parseCiYaml(mutated)
  assert.ok(parsed.jobs["doc-sync-tree"].runLines.includes("pnpm run build"))
  const r = checkDrift(mutated)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes("doc-sync-tree") && p.includes("构建前提漂移")), JSON.stringify(r.problems))
})

test("必然失败：删掉 next job 的 build 步 ⇒ 同步自检红（构建前提漂移）", () => {
  const mutated = CI.replace(
    "      - name: 构建新树（四包 tsc + tsdown）\n        run: pnpm run build\n",
    "      - name: 构建新树（四包 tsc + tsdown）\n        run: echo 不构建了\n",
  )
  assert.notEqual(mutated, CI)
  const parsed = parseCiYaml(mutated)
  assert.equal(parsed.jobs["next-tree"].runLines.includes("pnpm run build"), false)
  const r = checkDrift(mutated)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes("next-tree") && p.includes("构建前提漂移")), JSON.stringify(r.problems))
})

test("必然失败：改 all-checks needs ⇒ 同步自检红（点名 needs 漂移）", () => {
  const mutated = CI.replace(
    "needs: [secret-scan, next-tree, doc-sync-tree, coverage-tree, gate-selftests]",
    "needs: [secret-scan, next-tree]",
  )
  assert.notEqual(mutated, CI)
  const r = checkDrift(mutated)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes("needs 漂移")), JSON.stringify(r.problems))
})

// ── 变异牙：中和 local-ci 编排 ⇒ 红 ───────────────────────────────

test("manifest 完整性自检在真清单上绿", () => {
  const r = checkManifestIntegrity(LANE_MANIFEST)
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
})

test("变异牙：删一 lane 编排 ⇒ integrity 红（点名缺失 lane）", () => {
  const cut = LANE_MANIFEST.filter((l) => l.key !== "gateselfcheck")
  const r = checkManifestIntegrity(cut)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes("gateselfcheck")), JSON.stringify(r.problems))
})

test("变异牙：中和一 lane 的命令编排 ⇒ integrity 红（点名被中和）", () => {
  const neutralized = LANE_MANIFEST.map((l) => (l.key === "coverage" ? { ...l, mustContain: [] } : l))
  const r = checkManifestIntegrity(neutralized)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes("coverage") && p.includes("中和")), JSON.stringify(r.problems))
})

test("职责分离：删一 lane 由 integrity 拦（drift 只对照 manifest 里剩下的 lane）", () => {
  const cut = LANE_MANIFEST.filter((l) => l.key !== "doc-sync")
  // checkDrift 只查 manifest 里剩下的 lane；needs 仍期望 doc-sync-tree ⇒ 汇总不因删 lane 而红。
  // 真正拦「删 lane」的是 checkManifestIntegrity —— 本例断言职责分离：drift 仍绿，integrity 红。
  assert.equal(checkDrift(CI, cut).ok, true)
  assert.equal(checkManifestIntegrity(cut).ok, false)
})

test("expectBuild 逐 job 派生正确：next/coverage build，其余不 build", () => {
  const byKey = Object.fromEntries(LANE_MANIFEST.map((l) => [l.key, l.expectBuild]))
  assert.deepEqual(byKey, {
    "secret-scan": false,
    next: true,
    "doc-sync": false,
    coverage: true,
    gateselfcheck: false,
  })
  // 与 ci.yml 实得对齐：build 步恰出现在 next-tree 与 coverage-tree 两个 job。
  const { jobs } = parseCiYaml(CI)
  const built = Object.entries(jobs)
    .filter(([, j]) => j.runLines.includes("pnpm run build"))
    .map(([k]) => k)
    .sort()
  assert.deepEqual(built, ["coverage-tree", "next-tree"])
})

// ── lane 编排翻译 ─────────────────────────────────────────────────

test("buildLanePlan 五 lane 齐全，coverage 先采集后判定", () => {
  const plan = buildLanePlan("5ec9671185f6")
  assert.deepEqual(plan.map((l) => l.key), ["secret-scan", "next", "doc-sync", "coverage", "gateselfcheck"])
  assert.deepEqual(plan.filter((l) => l.expectBuild).map((l) => l.key), ["next", "coverage"])
  const cov = plan.find((l) => l.key === "coverage")
  assert.equal(cov.cmds.length, 2)
  assert.ok(cov.cmds[0].args.includes("--coverage"))
  assert.ok(cov.cmds[1].args.includes("coverage"), "第二格是 coverage 档")
  const scan = plan.find((l) => l.key === "secret-scan")
  assert.ok(scan.cmds[0].args.includes("--worktree"))
  assert.ok(scan.cmds[1].args.includes("--diff"))
})

test("buildLanePlan 无基线时 secret-scan --diff 传空串（脚本诚实不判）", () => {
  const scan = buildLanePlan("").find((l) => l.key === "secret-scan")
  assert.equal(scan.cmds[1].args[scan.cmds[1].args.length - 1], "")
})

// ── all-checks 汇总 ───────────────────────────────────────────────

test("aggregateVerdict 五 lane 全绿 ⇒ ok", () => {
  const r = aggregateVerdict(LANE_MANIFEST.map((l) => ({ key: l.key, pass: true })))
  assert.equal(r.ok, true)
  assert.deepEqual(r.failed, [])
})

test("必然失败：任一 lane 红 ⇒ aggregateVerdict 点名失败 lane", () => {
  const r = aggregateVerdict([
    { key: "next", pass: true },
    { key: "coverage", pass: false },
  ])
  assert.equal(r.ok, false)
  assert.deepEqual(r.failed, ["coverage"])
})

// ── @types 软链坑 ─────────────────────────────────────────────────

test("checkTypesSymlinks：实链绿 / 悬空红 / 缺 node 红", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lci-types-"))
  try {
    const real = path.join(dir, "real-node")
    fs.mkdirSync(real)
    fs.symlinkSync(real, path.join(dir, "node"))
    assert.equal(checkTypesSymlinks(dir).ok, true)

    fs.symlinkSync(path.join(dir, "NOPE"), path.join(dir, "react"))
    const dangling = checkTypesSymlinks(dir)
    assert.equal(dangling.ok, false)
    assert.ok(dangling.problems.some((p) => p.includes("react") && p.includes("悬空")), JSON.stringify(dangling.problems))

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lci-empty-"))
    try {
      const r = checkTypesSymlinks(empty)
      assert.equal(r.ok, false)
      assert.ok(r.problems.some((p) => p.includes("node")))
    } finally { fs.rmSync(empty, { recursive: true, force: true }) }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
