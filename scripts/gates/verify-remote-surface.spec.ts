/**
 * `verify-remote-surface` 的 spec（ISS-533 / W12 雏形判据）。
 *
 * 判据的全部价值在**能判红**：正例跑过不算，必须证明缺失/畸形/越界都会红，
 * 且三态（no-corpus / no-binary）不冒绿、真仓实扫绿。
 *
 * 六类用例：
 *   ① 正例：super 字面量 + @Remote 三方法匹配契约 ⇒ 绿；
 *   ② 必然失败向量：非字面量 super key / @Remote 数字实参 / 空导出面 ⇒ 红；
 *   ③ 双向导出面锁：越界端点名红、契约端点缺失红、未登记 controller 只看结构（新包不使判据变假）；
 *   ④ 端点重复红；
 *   ⑤ 缺输入：0 controller no-corpus / 无 typescript no-binary ⇒ unjudged（不冒绿）；
 *   ⑥ 真仓：实扫 packages/api/<pkg>/src ⇒ 绿。
 *
 * @module gates/verify-remote-surface.spec
 */
import {
  EXPECTED_SURFACE,
  collectSources,
  judgeRemoteSurface,
  loadTs,
} from "./verify-remote-surface.ts"

const REPO = process.cwd()
const ts = loadTs()

let fails = 0
let total = 0
const ok = (name: string, cond: boolean) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

/** 一段最小合法 controller 源码。 */
const GOOD = `
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
export class DocController extends TypertRemoteService {
  constructor(ctx) { super(ctx, 'document') }
  @Remote('list') list() {}
  @Remote('get') get() {}
  @Remote('update') update() {}
}
`
const input = (src: string) => new Map<string, string>([["packages/api/document-controller/src/index.ts", src]])

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-remote-surface.spec")
  if (ts === null) {
    console.log("  ✗ 环境：找不到 typescript，spec 无法运行")
    return false
  }

  // ── ① 正例 ────────────────────────────────────────────────────────────
  {
    const r = judgeRemoteSurface({ files: input(GOOD), hasTs: true }, ts)
    ok("正例：super 字面量 + @Remote 三方法匹配契约 ⇒ 绿", r.status === "passed")
    ok("正例：契约端点齐全 ⇒ 无「契约端点缺失」finding", !(r.findings ?? []).some((f) => f.detail.includes("契约端点缺失")))
  }

  // ── ② 必然失败向量 ────────────────────────────────────────────────────
  {
    const badKey = GOOD.replace("super(ctx, 'document')", "super(ctx, serviceKey)")
    const r1 = judgeRemoteSurface({ files: input(badKey), hasTs: true }, ts)
    ok("反例①：super 非字面量 key ⇒ 红（必然失败向量）", r1.status === "failed")
    ok("反例①：finding 带 文件:行:详情", (r1.findings ?? []).some((f) => f.file?.includes("index.ts") && typeof f.line === "number" && f.detail.includes("service key")))

    const badRemote = GOOD.replace("@Remote('list')", "@Remote(123)")
    const r2 = judgeRemoteSurface({ files: input(badRemote), hasTs: true }, ts)
    ok("反例②：@Remote 数字实参 ⇒ 红", r2.status === "failed")

    const empty = `
export class DocController extends TypertRemoteService {
  constructor(ctx) { super(ctx, 'document') }
  plain() {}
}
`
    const r3 = judgeRemoteSurface({ files: input(empty), hasTs: true }, ts)
    ok("反例③：无 @Remote 方法（空导出面）⇒ 红", r3.status === "failed")

    const noSuper = GOOD.replace("super(ctx, 'document')", "void ctx")
    const r4 = judgeRemoteSurface({ files: input(noSuper), hasTs: true }, ts)
    ok("反例④：缺 super(ctx,...) ⇒ 红", r4.status === "failed")
  }

  // ── ③ 签名白名单 + 未登记 controller ──────────────────────────────────
  {
    const extra = GOOD.replace("@Remote('update')", "@Remote('destroy')")
    const r1 = judgeRemoteSurface({ files: input(extra), hasTs: true }, ts)
    ok("白名单：端点 destroy 不在 document 契约内 ⇒ 红", r1.status === "failed")
    ok("白名单：finding 点名越界端点", (r1.findings ?? []).some((f) => f.detail.includes("destroy")))

    // 反向判：删一个契约端点仍绿 = 判据名不副实，这条必须红。
    const missing = GOOD.replace("  @Remote('update') update() {}\n", "")
    const rMissing = judgeRemoteSurface({ files: input(missing), hasTs: true }, ts)
    ok("反向判：删单个契约端点 update ⇒ 红（必然失败向量）", rMissing.status === "failed")
    ok("反向判：finding 点名缺失端点并要求同步契约表", (rMissing.findings ?? []).some((f) => f.detail.includes("契约端点缺失：update") && f.detail.includes("同步 verify-remote-surface 契约表")))

    const unknown = GOOD.replace(/'document'/g, "'futureX'")
    const r2 = judgeRemoteSurface({ files: input(unknown), hasTs: true }, ts)
    ok("未登记 controller：只判结构、不套白名单 ⇒ 绿（新增合法包不使判据变假）", r2.status === "passed")
    ok("契约表：document 三端点在册", EXPECTED_SURFACE.document?.join(",") === "list,get,update")
  }

  // ── ④ 端点重复 ────────────────────────────────────────────────────────
  {
    const dup = GOOD.replace("@Remote('update')", "@Remote('get')")
    const r = judgeRemoteSurface({ files: input(dup), hasTs: true }, ts)
    ok("重复端点名 get ⇒ 红", r.status === "failed")
    ok("重复端点：finding 点名重复", (r.findings ?? []).some((f) => f.detail.includes("重复")))
  }

  // ── ⑤ 缺输入：no-corpus / no-binary ───────────────────────────────────
  {
    const noCorpus = judgeRemoteSurface({ files: input("export const x = 1\n"), hasTs: true }, ts)
    ok("防扫空：0 controller ⇒ unjudged(no-corpus)，不冒绿", noCorpus.status === "unjudged" && noCorpus.reason === "no-corpus")
    const noBinary = judgeRemoteSurface({ files: input(GOOD), hasTs: false }, null)
    ok("缺工具：无 typescript ⇒ unjudged(no-binary)，不冒绿", noBinary.status === "unjudged" && noBinary.reason === "no-binary")
  }

  // ── ⑥ 真仓：实扫 api src ⇒ 绿 ────────────────────────────────────────
  {
    const real = collectSources(REPO)
    const r = judgeRemoteSurface({ files: real, hasTs: true }, ts)
    ok(`真仓：实扫 ${real.size} 个 api 源文件 ⇒ 绿`, r.status === "passed")
  }

  console.log(fails ? `✗ ${fails} 条不成立` : `✓ spec 全过（${total} 条断言：正例 / 必然失败 / 双向锁 / 重复 / 缺输入 / 真仓）`)
  return fails === 0
}
