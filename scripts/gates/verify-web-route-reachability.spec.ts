/**
 * `verify-web-route-reachability` 的 spec（ISS-906）。由 `--selftest` 加载。
 * 每条判据都要有反向对照：正例外，还必须有造出来的必红样本，且点名到文件:行。
 */
import assert from "node:assert/strict"
import { judge, scan, type RouteModuleFact, type RouteReachInput, type RouteSite } from "./verify-web-route-reachability.ts"

let pass = 0
let fails = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && extra ? ` —— ${extra}` : ""}`)
  if (cond) pass++
  else fails++
}

function site(over: Partial<RouteSite> = {}): RouteSite {
  return {
    path: "/editor-demo", file: "apps/web/src/main.ts", line: 25, column: 25,
    handlers: [{ name: "mountEditorDemo", resolved: true }], ...over,
  }
}
function fact(over: Partial<RouteModuleFact> = {}): RouteModuleFact {
  return { file: "apps/web/src/main.ts", sites: [site()], brokenImports: [], ...over }
}
function fixture(over: Partial<RouteReachInput> = {}): RouteReachInput {
  return {
    entry: "apps/web/src/main.ts",
    reachable: ["apps/web/src/main.ts"],
    modules: [fact()],
    sourceCount: 3,
    ...over,
  }
}

export function run(): boolean {
  pass = 0
  fails = 0

  ok("正例① 声明路由有可达处理器 ⇒ passed", judge(fixture()).status === "passed")

  // 反例① 死路由：分派分支没有已导入处理器 ⇒ failed + 点名文件:行
  const noHandler = judge(fixture({ modules: [fact({ sites: [site({ handlers: [] })] })] }))
  ok(
    "反例① 死路由无处理器 ⇒ failed 且点名 apps/web/src/main.ts:25",
    noHandler.status === "failed"
      && noHandler.findings?.some((f) => f.file === "apps/web/src/main.ts" && f.line === 25 && /死路由/.test(f.detail)) === true,
    `${noHandler.status} / ${JSON.stringify(noHandler.findings)}`,
  )

  // 反例② 不可达声明：路由所在模块不在入口 import 图里
  const orphan = judge(fixture({ modules: [fact({ file: "apps/web/src/orphan.ts", sites: [site({ file: "apps/web/src/orphan.ts", line: 7 })] })] }))
  ok(
    "反例② 声明在入口图外 ⇒ failed 且点名 orphan.ts:7 不可达",
    orphan.status === "failed" && orphan.findings?.some((f) => f.file === "apps/web/src/orphan.ts" && f.line === 7 && /不可达/.test(f.detail)) === true,
    `${orphan.status} / ${JSON.stringify(orphan.findings)}`,
  )

  // 反例③ 处理器 import 目标不存在
  const badImport = judge(fixture({ modules: [fact({ sites: [site({ handlers: [{ name: "mountGhost", resolved: false }] })] })] }))
  ok(
    "反例③ 处理器 import 目标不存在 ⇒ failed",
    badImport.status === "failed" && badImport.findings?.some((f) => /mountGhost/.test(f.detail)) === true,
    `${badImport.status} / ${JSON.stringify(badImport.findings)}`,
  )

  // 反例④ 断链的相对 import ⇒ failed + 点名行
  const broken = judge(fixture({ modules: [fact({ brokenImports: [{ line: 9, specifier: "./missing.ts" }] })] }))
  ok(
    "反例④ 相对 import 断链 ⇒ failed 且点名第 9 行",
    broken.status === "failed" && broken.findings?.some((f) => f.line === 9 && /断在这里/.test(f.detail)) === true,
    `${broken.status} / ${JSON.stringify(broken.findings)}`,
  )

  // 判不了：0 源文件不许绿
  const noCorpus = judge(fixture({ sourceCount: 0 }))
  ok("判不了① 0 源文件 ⇒ unjudged(no-corpus)", noCorpus.status === "unjudged" && noCorpus.reason === "no-corpus", `${noCorpus.status}/${noCorpus.reason}`)

  // 反例⑤ HTML 入口缺失 ⇒ failed（不是判不了）
  const noEntry = judge(fixture({ entry: null }))
  ok("反例⑤ 无 HTML 入口 ⇒ failed", noEntry.status === "failed" && noEntry.findings?.some((f) => f.file === "apps/web/index.html") === true, noEntry.status)

  // 集成正例：真语料 scan() 判绿，且路由声明数 > 0（空表不许冒充）
  const live = scan()
  ok("正例② 真语料扫到入口 + 非零源文件 + 非零路由声明", live.entry !== null && live.sourceCount > 0 && live.modules.reduce((n, m) => n + m.sites.length, 0) > 0,
    `${live.entry}/${live.sourceCount}/${live.modules.reduce((n, m) => n + m.sites.length, 0)}`)
  const liveJudge = judge(live)
  ok("正例③ 真语料判 passed", liveJudge.status === "passed", `${liveJudge.status} / ${JSON.stringify(liveJudge.findings)}`)

  // 有牙：把真语料某条路由的处理器抽空 ⇒ 必红（证明不是恒绿）
  const teethInput = scan()
  assert.ok(teethInput.modules.some((m) => m.sites.length > 0), "真语料必须有路由声明才能做反向对照")
  const target = teethInput.modules.find((m) => m.sites.length > 0)
  if (target === undefined) { ok("反例⑥ 真语料注入死路由 ⇒ failed", false, "找不到可注入的路由模块") }
  else {
    target.sites[0].handlers = []
    const teeth = judge(teethInput)
    ok("反例⑥ 真语料注入死路由 ⇒ failed（判据有牙）", teeth.status === "failed", teeth.status)
  }

  const total = pass + fails
  if (fails) {
    console.error(`✗ verify-web-route-reachability spec：${pass} 过 / ${fails} 失败（SPEC_RESULT total=${total} pass=${pass} fail=${fails}）`)
    return false
  }
  console.log(`✓ verify-web-route-reachability spec 全过：${total} 条（SPEC_RESULT total=${total} pass=${pass} fail=${fails}）`)
  return true
}
