/**
 * `verify-client-domain-graph` 的 spec（ISS-839）。
 *
 * 六类用例：
 *   ① 正例（合规分层 ⇒ 绿）
 *   ② 两条规则各一反例（域↔域 / 顶层非装配→域），并断言**报的是哪一条规则**
 *   ③ 三种 import 形态（静态 / 动态 / 副作用）+ 注释剥离 —— 官方漏掉的那几种
 *   ④ 扫描根射程：`tests/` 下跨域取值**不报**（真造目录跑 `scanClientPackages`，不是纯函数假设）
 *   ⑤ 缺输入（0 包 / 0 源文件 ⇒ unjudged，不许绿）
 *   ⑥ 变异：同一份数据改一处 ⇒ 绿变红，还原 ⇒ 红变绿（判据有牙）
 *
 * ⛔ 反例必须点名**具体哪一条规则**报红，不许只断「status === failed」——
 *    两条规则挤在同一个 failed 上时，「只坏域间」与「两条都坏」长得一样。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  ASSEMBLY_FILES,
  CONTRACT_DIRS,
  checkPackage,
  domainOf,
  judgeClientDomainGraph,
  reasonFor,
  resolveClientImport,
  scanClientPackages,
  stripComments,
  type ClientPackage,
} from "./verify-client-domain-graph.ts"

let fails = 0
/** 断言条数**实测累加**，不在结尾手写拆解 —— 手写的数会和实际脱节。 */
let total = 0
const ok = (name: string, cond: boolean) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

/** 造一个包：`files` 是相对 `src/client/` 的路径 → 正文。 */
const pkg = (files: Record<string, string>, dir = "packages/client/sample"): ClientPackage => ({
  dir,
  files: Object.entries(files).map(([rel, source]) => ({ rel, source })),
})

const judge = (files: Record<string, string>) => judgeClientDomainGraph([pkg(files)])

/** 一个最小合规包：契约 / 两个域 / 一个装配点，没有任何跨域引用。 */
const goodFiles = (): Record<string, string> => ({
  "contract/api.ts": "export interface Api { id: string }\n",
  "alpha/impl.ts": "import type { Api } from '../contract/api.ts'\nexport const a: Api = { id: 'a' }\n",
  "beta/impl.ts": "import type { Api } from '../contract/api.ts'\nexport const b: Api = { id: 'b' }\n",
  "apply.ts": "import { a } from './alpha/impl.ts'\nimport { b } from './beta/impl.ts'\nexport const all = [a, b]\n",
})

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-client-domain-graph.spec")

  // ── ① 正例 ──────────────────────────────────────────────────────────
  {
    const r = judge(goodFiles())
    ok("正例：两域走 contract + apply 装配 ⇒ 绿", r.status === "passed")
    ok("正例：detail 报出包数与文件数（不是只打一个绿字）", /1 个 client 包 \/ 4 个源文件/.test(r.detail ?? ""))
    ok("正例：目录常量与官方逐字一致（contract / apply·index·index.tsx）", CONTRACT_DIRS.has("contract") && ASSEMBLY_FILES.has("apply.ts") && ASSEMBLY_FILES.has("index.ts") && ASSEMBLY_FILES.has("index.tsx"))
  }

  // ── ② 规则一：域 ↔ 域 ───────────────────────────────────────────────
  {
    const r = judge({ ...goodFiles(), "alpha/impl.ts": "import { b } from '../beta/impl.ts'\nexport const a = b\n" })
    ok("反例①：alpha 直接 import beta ⇒ 红", r.status === "failed")
    ok("反例①：原因文本逐字是官方那句「route shared API through contract/」", (r.findings ?? []).some((f) => f.detail.includes(reasonFor("alpha", "beta"))))
    ok("反例①：只报 1 条（同域内引用不许自报）", (r.findings ?? []).length === 1)
    ok("反例①：file 定位到具体文件", (r.findings ?? [])[0]?.file === "packages/client/sample/src/client/alpha/impl.ts")
  }

  // ── ② 规则二：顶层非装配 → 域 ───────────────────────────────────────
  {
    const r = judge({ ...goodFiles(), "locales.ts": "import { a } from './alpha/impl.ts'\nexport const l = a\n" })
    ok("反例②：顶层 locales.ts import 域 ⇒ 红", r.status === "failed")
    ok("反例②：原因文本逐字是官方那句「only apply/index may assemble」", (r.findings ?? []).some((f) => f.detail.includes(reasonFor("", "alpha"))))
    ok("反例②：同一份不带出「域↔域」的假红（两条规则不互串）", !(r.findings ?? []).some((f) => f.detail.includes("sibling domain")))
  }

  // ── ② 装配点：apply / index / index.tsx 跨域都放行 ───────────────────
  for (const asm of ["apply.ts", "index.ts", "index.tsx"]) {
    const r = judge({
      ...goodFiles(),
      [asm]: "import { a } from './alpha/impl.ts'\nimport { b } from './beta/impl.ts'\nexport const all = [a, b]\n",
    })
    ok(`正例：${asm} 同时 import 两个域 ⇒ 绿（装配点唯一特许）`, r.status === "passed")
  }
  {
    // ⚠️ 域内的 index 不是装配点 —— 这条最容易漏，因为文件名一模一样
    const r = judge({ ...goodFiles(), "alpha/index.ts": "import { b } from '../beta/impl.ts'\nexport const a = b\n" })
    ok("反例②b：域内 alpha/index.ts 跨域 ⇒ 仍红（装配点只认顶层）", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes(reasonFor("alpha", "beta"))))
  }

  // ── ③ 三种 import 形态：官方只认 from，漏掉的两种也必须是边 ──────────
  {
    const withDynamic = judge({ ...goodFiles(), "alpha/impl.ts": "export const a = async () => (await import('../beta/impl.ts')).b\n" })
    ok("形态：动态 import('../beta/impl.ts') ⇒ 红（官方 from 正则漏这一形）", withDynamic.status === "failed")
    const withTypePos = judge({ ...goodFiles(), "alpha/impl.ts": "type B = import('../beta/impl.ts').B\nexport const a: B = { x: 1 }\n" })
    ok("形态：类型位 import('../beta/impl.ts').B ⇒ 也红（同一形态的第二种写法）", withTypePos.status === "failed")
    const withSideEffect = judge({ ...goodFiles(), "alpha/impl.ts": "import '../beta/register.ts'\nexport const a = 1\n" })
    ok("形态：副作用 import '../beta/register.ts' ⇒ 红", withSideEffect.status === "failed")
    const okSideEffect = judge({ ...goodFiles(), "alpha/impl.ts": "import './local-register.ts'\nexport const a = 1\n" })
    ok("形态：副作用 import 同域 ⇒ 不报（不是一律见 import 就红）", okSideEffect.status === "passed")
  }

  // ── ③ 注释剥离：注释掉的跨域 import 不许假红 ─────────────────────────
  {
    const commented = judge({
      ...goodFiles(),
      "alpha/impl.ts": "// import { b } from '../beta/impl.ts'\n/* import { c } from '../gamma/impl.ts' */\nexport const a = 1\n",
    })
    ok("注释：行注释与块注释里的跨域 import ⇒ 不报（官方不剥注释，会假红）", commented.status === "passed")
    const real = judge({ ...goodFiles(), "alpha/impl.ts": "// 注释里的不算\nexport { b } from '../beta/impl.ts'\n" })
    ok("注释：注释旁边真的有一行跨域 re-export ⇒ 照红（剥注释不许把真边一起剥掉）", real.status === "failed")
    ok("剥注释口径与 declared-reads 同形（行首 // 整行 + 块注释）", stripComments("a\n// x\n/* y */b\n") === "a\n\nb\n")
  }

  // ── ③ 目标在顶层 / contract / 出包：按官方口径放行 ───────────────────
  {
    const toTop = judge({ ...goodFiles(), "alpha/impl.ts": "import { l } from '../locales.ts'\nexport const a = l\n" })
    ok("边界：域 import 顶层非装配文件 ⇒ 官方口径放行（分歧⑤，见文件头）", toTop.status === "passed")
    const toContract = judge({ ...goodFiles(), "alpha/impl.ts": "import type { Api } from '../contract/api.ts'\nexport const a: Api = { id: 'x' }\n" })
    ok("等价性：经 contract/ 共享 ⇒ 绿（这就是规则要求的改法）", toContract.status === "passed")
    const outside = judge({ ...goodFiles(), "alpha/impl.ts": "import { s } from '../../shared/util.ts'\nexport const a = s\n" })
    ok("边界：../../ 出 src/client ⇒ 不判（包级依赖方向归 verify-module-graph）", outside.status === "passed")
  }

  // ── ④ 扫描根射程：tests/ 下跨域取值不报（真造目录，不靠假设）──────────
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-spec-"))
    try {
      const write = (rel: string, body: string) => {
        const abs = path.join(root, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, body)
      }
      // 合规包：域间靠 contract
      write("packages/client/clean/package.json", "{}")
      write("packages/client/clean/src/client/contract/api.ts", "export type A = { id: string }\n")
      write("packages/client/clean/src/client/one/x.ts", "import type { A } from '../contract/api.ts'\nexport const x: A = { id: '1' }\n")
      write("packages/client/clean/src/client/two/y.ts", "import type { A } from '../contract/api.ts'\nexport const y: A = { id: '2' }\n")
      write("packages/client/clean/src/client/apply.ts", "import { x } from './one/x.ts'\nimport { y } from './two/y.ts'\nexport const all = [x, y]\n")
      // ⚠️ 测试目录：从域 two 取值构造被测对象 —— 正当用法，**不在射程**
      write("packages/client/clean/tests/one.spec.ts", "import { y } from '../src/client/two/y.ts'\nimport { x } from '../src/client/one/x.ts'\nexport const t = [x, y]\n")
      // 对照组：同样的跨域引用，写在 src/client 里就必须红
      write("packages/client/dirty/src/client/one/x.ts", "import { y } from '../two/y.ts'\nexport const x = y\n")
      write("packages/client/dirty/src/client/two/y.ts", "export const y = 1\n")

      const scanned = scanClientPackages(root)
      ok("射程：扫到 2 个 client 包（clean / dirty），没有把 tests/ 当包", scanned.length === 2)
      const cleanFiles = scanned.find((p) => p.dir.endsWith("/clean"))?.files.map((f) => f.rel) ?? []
      ok("射程：clean 包的源文件里没有 tests/（扫描根是 src/client，不是包根）", cleanFiles.length === 4 && !cleanFiles.some((f) => f.startsWith("tests/")))
      ok("射程：clean 包（含 tests/ 下跨域取值）⇒ 不报", checkPackage(scanned.find((p) => p.dir.endsWith("/clean"))!).length === 0)
      ok("射程对照：dirty 包同样的跨域引用写在 src/client 下 ⇒ 报（证明不是整棵树都不报）",
        checkPackage(scanned.find((p) => p.dir.endsWith("/dirty"))!).some((v) => v.reason.includes("sibling domain")))
      const whole = judgeClientDomainGraph(scanned)
      ok("射程：整棵临时树上只有 dirty 那 1 条红", whole.status === "failed" && (whole.findings ?? []).length === 1)

      // 反向：把 tests/ 挪进 src/client ⇒ 立刻进射程（证明「不报」是因为位置，不是因为有豁免名单）
      write("packages/client/clean/src/client/one/x.spec.ts", "import { y } from '../two/y.ts'\nexport const t = y\n")
      const after = scanClientPackages(root)
      const cleanNow = checkPackage(after.find((p) => p.dir.endsWith("/clean"))!)
      ok("射程反向：测试文件搬进 src/client/ 内 ⇒ 照红（无豁免名单，跑的是位置）", cleanNow.some((v) => v.reason.includes("sibling domain")))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ── ⑤ 缺输入：0 包 / 0 源文件 ⇒ unjudged，都不许绿 ────────────────────
  {
    const r = judgeClientDomainGraph([])
    ok("防扫空：0 个 client 包 ⇒ unjudged（官方此处 exit 0 + clean，本仓口径退 2）", r.status === "unjudged")
    ok("防扫空：理由码是 no-corpus", r.reason === "no-corpus")
    ok("防扫空：detail 说明了「0 个 client 包」", (r.detail ?? "").includes("0 个 client 包"))
    const empty = judgeClientDomainGraph([pkg({})])
    ok("防扫空：目录在但 0 个 .ts/.tsx ⇒ 也是 unjudged（删空源码不许变绿）", empty.status === "unjudged" && empty.reason === "no-corpus")
    // 真扫本仓：新树还没有 packages/ ⇒ 必须落地成 unjudged，不是绿
    const real = scanClientPackages(process.cwd())
    // 防扫空的本意是「扫描器没瞎、能扫到真实包」——非快照断言（写死包数会在新包落地当天恒红）。
    ok(`防扫空：本仓现状扫描到 ${real.length} 个 client 包（>0 即扫到；无 packages/ ⇒ 0 由上组对照覆盖）`, real.length > 0)
  }

  // ── ⑥ 变异：同一份数据改一处 ⇒ 绿变红；还原 ⇒ 红变绿 ─────────────────
  {
    const before = judge(goodFiles())
    const broken = { ...goodFiles(), "alpha/impl.ts": "import { b } from '../beta/impl.ts'\nexport const a = b\n" }
    const during = judge(broken)
    const restored = judge(goodFiles())
    ok("变异：改前绿 → 造坏红 → 还原绿（三步都在同一条链上）", before.status === "passed" && during.status === "failed" && restored.status === "passed")
    ok("变异：造坏只影响该文件，不把合规的 beta 也报出来", (during.findings ?? []).every((f) => f.file?.includes("/alpha/")))
  }

  // ── 纯函数：路径解析 ────────────────────────────────────────────────
  {
    ok("解析：域内 ../queue/store.ts ⇒ queue/store.ts", resolveClientImport("input/hub.ts", "../queue/store.ts") === "queue/store.ts")
    ok("解析：顶层 ../styles/x.css?inline ⇒ 原样保留出包形态（官方 spec 同断言）", resolveClientImport("styles.ts", "../styles/base.css?inline") === "../styles/base.css?inline")
    ok("解析：domainOf 对顶层文件回空串", domainOf("apply.ts") === "" && domainOf("chat/x.ts") === "chat")
  }

  console.log(fails ? `✗ ${fails} 条不成立` : `✓ spec 全过（${total} 条断言：正例 / 两条规则反例 / 三形态 / 注释 / 边界 / 射程含 tests / 防扫空 / 变异，逐条见上）`)
  return fails === 0
}
