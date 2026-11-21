/**
 * `verify-web-snapshots` 的 spec —— 四类用例齐全：正例 / 反例 / 干扰 / 缺输入。
 *
 * 自检不真起浏览器（gateselfcheck 必须秒级）；只喂构造数据给纯函数 judgeWebSnapshots。
 * 判据「有牙」的证明在反例：测试红 / 基线数量漂移都必须 failed，缺料必须 unjudged 而不是绿。
 */
import { EXPECTED_GOLDENS, firstSceneLabel, judgeWebSnapshots, type SnapshotRunInput } from "./verify-web-snapshots.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const mkInput = (over: Partial<SnapshotRunInput> = {}): SnapshotRunInput => ({
  rc: 0,
  output: "",
  goldenCount: EXPECTED_GOLDENS,
  ...over,
})

export function run_spec(): boolean {
  fails = 0
  console.log("verify-web-snapshots.spec")

  // 正例
  {
    const r = judgeWebSnapshots(mkInput())
    ok("正例：replay 全绿 + 9 基线 ⇒ passed", r.status === "passed")
    ok("正例：detail 带 9 基线读数", (r.detail ?? "").includes("9"))
  }

  // 反例：测试红
  {
    const out = "FAIL shell @ 480\nError: [replay] 快照不符 · 场景=shell 视口=480\n第 2 行："
    const r = judgeWebSnapshots(mkInput({ rc: 1, output: out }))
    ok("反例：replay 有红 ⇒ failed", r.status === "failed")
    ok("反例：红里点名场景+视口", (r.findings ?? []).some((f) => f.detail.includes("场景=shell 视口=480")))
  }

  // 反例：基线数量漂移
  {
    const r = judgeWebSnapshots(mkInput({ goldenCount: 8 }))
    ok("反例：少一个基线 ⇒ failed（不是绿）", r.status === "failed")
    ok("反例：点名数量 8/9", (r.findings ?? []).some((f) => f.detail.includes("8") && f.detail.includes("9")))
  }

  // 反例：数量对但测试红 —— 不许「9 个文件在盘上」被当成绿
  {
    const r = judgeWebSnapshots(mkInput({ rc: 1, output: "some test failed" }))
    ok("反例：9 基线但 rc≠0 ⇒ failed", r.status === "failed")
    ok("反例：无场景标签时也 failed（不吞红）", (r.findings ?? []).some((f) => f.detail.includes("replay 有测试红")))
  }

  // 干扰：浏览器缺料必须判不了，不能算判据被违反
  {
    const r = judgeWebSnapshots(mkInput({ rc: 1, output: "browserType.launch: Executable doesn't exist", browserMissing: true }))
    ok("干扰：缺 Chromium ⇒ unjudged(no-binary)，不是红", r.status === "unjudged" && r.reason === "no-binary")
  }

  // 缺输入
  {
    const r = judgeWebSnapshots(mkInput({ goldenCount: 0 }))
    ok("缺输入：0 基线 ⇒ unjudged(no-baseline)", r.status === "unjudged" && r.reason === "no-baseline")
  }
  {
    const r = judgeWebSnapshots(mkInput({ missingBinary: true }))
    ok("缺输入：缺 vitest ⇒ unjudged(no-binary)", r.status === "unjudged" && r.reason === "no-binary")
  }

  // 辅助：场景标签抽取
  {
    ok("firstSceneLabel：从多行输出抽场景+视口", firstSceneLabel("x\n场景=detail 视口=768\ny") === "场景=detail 视口=768")
    ok("firstSceneLabel：没有标签返回 undefined", firstSceneLabel("no label") === undefined)
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（正例×2 / 反例×4 / 干扰×1 / 缺输入×2 / 辅助×2）")
  return fails === 0
}

/** runGate --selftest 约定的入口名。 */
export function run(): boolean {
  return run_spec()
}
