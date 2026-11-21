/**
 * `verify-browser-bundle-purity` 的 spec（ISS-906）。由 `--selftest` 加载。
 * 正例外必须有造出来的必红样本：5 条规则每条都要能被单独触发，且点名文件:行。
 */
import assert from "node:assert/strict"
import { extractImports, judge, scan, type ImportFact, type PurityInput } from "./verify-browser-bundle-purity.ts"

let pass = 0
let fails = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && extra ? ` —— ${extra}` : ""}`)
  if (cond) pass++
  else fails++
}

const WEB = "apps/web/src/boot.ts"
const CLIENT = "packages/client/ui-model/src/client/index.ts"
function imp(over: Partial<ImportFact> = {}): ImportFact {
  return { file: WEB, line: 30, specifier: "react", typeOnly: false, ...over }
}
function fixture(over: Partial<PurityInput> = {}): PurityInput {
  return {
    faceCount: 20,
    clientPackages: {
      "@matter/client-ui-model": "packages/client/ui-model",
      "@matter/client-ui-kb": "packages/client/ui-kb",
    },
    imports: [imp()],
    artifacts: [],
    ...over,
  }
}

export function run(): boolean {
  pass = 0
  fails = 0

  ok("正例① 干净 import ⇒ passed", judge(fixture()).status === "passed")

  // 反例① Node 核心模块（node: 前缀）
  const builtin = judge(fixture({ imports: [imp({ specifier: "node:fs" })] }))
  ok("反例① node:fs ⇒ failed 且点名文件:行", builtin.status === "failed"
    && builtin.findings?.some((f) => f.file === WEB && f.line === 30 && /Node 核心模块/.test(f.detail)) === true,
    `${builtin.status} / ${JSON.stringify(builtin.findings)}`)

  // 反例①b Node 核心模块（裸名）
  const bare = judge(fixture({ imports: [imp({ specifier: "child_process", line: 12 })] }))
  ok("反例①b 裸 child_process ⇒ failed 且点名第 12 行", bare.status === "failed"
    && bare.findings?.some((f) => f.line === 12) === true, bare.status)

  // 反例② server-only 原生模块
  const server = judge(fixture({ imports: [imp({ specifier: "better-sqlite3" })] }))
  ok("反例② better-sqlite3 ⇒ failed", server.status === "failed" && /服务端\/原生模块/.test(server.findings?.[0]?.detail ?? ""), server.status)

  // 反例③ 兄弟 client 包越层引用
  const sibling = judge(fixture({ imports: [imp({ file: CLIENT, line: 9, specifier: "@matter/client-ui-kb/client" })] }))
  ok("反例③ client 浏览器面引兄弟包 ⇒ failed 且点名 index.ts:9", sibling.status === "failed"
    && sibling.findings?.some((f) => f.file === CLIENT && f.line === 9 && /越层引用/.test(f.detail)) === true,
    `${sibling.status} / ${JSON.stringify(sibling.findings)}`)

  // 反例④ apps/web 用根路径引 client 包
  const rootImp = judge(fixture({ imports: [imp({ specifier: "@matter/client-ui-kb" })] }))
  ok("反例④ apps/web 根路径引 client 包 ⇒ failed 且提示 /client", rootImp.status === "failed"
    && /\/client/.test(rootImp.findings?.[0]?.detail ?? ""), rootImp.status)

  // 正例② type-only 被擦除，不进 bundle ⇒ 不报
  const typeOnly = judge(fixture({ imports: [imp({ specifier: "node:fs", typeOnly: true })] }))
  ok("正例② type-only import 不计违规（擦除，不进 bundle）", typeOnly.status === "passed", typeOnly.status)

  // 正例③ apps/web 走 /client 子路径 ⇒ 不报
  const subpath = judge(fixture({ imports: [imp({ specifier: "@matter/client-ui-kb/client" })] }))
  ok("正例③ apps/web 走 /client 子路径 ⇒ passed", subpath.status === "passed", subpath.status)

  // 判不了：0 源文件不许绿
  const noCorpus = judge(fixture({ faceCount: 0 }))
  ok("判不了① 0 源文件 ⇒ unjudged(no-corpus)", noCorpus.status === "unjudged" && noCorpus.reason === "no-corpus", `${noCorpus.status}/${noCorpus.reason}`)

  // 抽取器单测：三形态（import / import() / require）都抓，且 type-only 标记正确
  const src = [
    'import { a } from "node:fs"',
    'import type { T } from "zod"',
    'const m = import("@matter/client-ui-kb/client")',
    'const r = require("better-sqlite3")',
  ].join("\n")
  const facts = extractImports("apps/web/src/x.ts", src)
  ok("抽取器① 三形态 import 都抓到（4 条）", facts.length === 4, JSON.stringify(facts))
  ok("抽取器② type-only 被标记", facts.find((f) => f.specifier === "zod")?.typeOnly === true)

  // 集成正例：真语料 scan() 判绿
  const live = scan()
  ok("正例④ 真语料扫到非零浏览器面 + 非零 client 包 + 非零 import", live.faceCount > 0 && Object.keys(live.clientPackages).length > 0 && live.imports.length > 0,
    `${live.faceCount}/${Object.keys(live.clientPackages).length}/${live.imports.length}`)
  const liveJudge = judge(live)
  ok("正例⑤ 真语料判 passed", liveJudge.status === "passed", `${liveJudge.status} / ${JSON.stringify(liveJudge.findings)}`)

  // 有牙：给真语料注入一条越层引用 ⇒ 必红（证明不是恒绿）
  const teethInput = scan()
  assert.ok(teethInput.clientPackages["@matter/client-ui-kb"] !== undefined, "真语料必须含至少两个 client 包才能做反向对照")
  teethInput.imports.push(imp({ file: CLIENT, line: 9, specifier: "@matter/client-ui-kb/client" }))
  const teeth = judge(teethInput)
  ok("反例⑤ 真语料注入越层引用 ⇒ failed（判据有牙）", teeth.status === "failed", teeth.status)

  const total = pass + fails
  if (fails) {
    console.error(`✗ verify-browser-bundle-purity spec：${pass} 过 / ${fails} 失败（SPEC_RESULT total=${total} pass=${pass} fail=${fails}）`)
    return false
  }
  console.log(`✓ verify-browser-bundle-purity spec 全过：${total} 条（SPEC_RESULT total=${total} pass=${pass} fail=${fails}）`)
  return true
}
