/**
 * `verify-catalogs` 的 spec（ISS-893）。经 `--selftest` 被 gate-runtime 动态加载。
 *
 * 覆盖四件事，缺一条这条判据就没有牙：
 *   ① 正例：3 张生成物与现算一致 ⇒ passed（含真语料 scan()）
 *   ② **必然失败**的用例：改一个字符 / 删文件 / 改文件头各断言 failed，且点名到文件与行
 *   ③ 判不了的用例：0 个包 ⇒ unjudged（⛔ 不许绿 —— 空表与空表当然一致）
 *   ④ 同口径：expected 来自生成器，3 张全由 generateAll 产出（判据不另写扫描）
 */
import assert from "node:assert/strict"
import { judgeCatalogs, scan, type CatalogCheck, type CatalogsInput } from "./verify-catalogs.ts"
import { EXTRACTORS, REPO_ROOT, generateAll } from "../gen-catalog.ts"

let fails = 0
let pass = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && extra ? ` —— ${extra}` : ""}`)
  if (cond) pass++
  else fails++
}

/** 最小可用样本：三张各两行，只为了让断言读得懂，不冒充真语料。 */
function fixture(): CatalogsInput {
  const catalogs: CatalogCheck[] = [
    { id: "ctx", output: "docs/ctx-catalog.md", actual: "H\nline1\nline2", expected: "H\nline1\nline2" },
    { id: "event", output: "docs/event-catalog.md", actual: "H2\na\nb", expected: "H2\na\nb" },
    { id: "dependency", output: "docs/dependency-catalog.md", actual: "H3\nx\ny", expected: "H3\nx\ny" },
  ]
  return { catalogs, packageCount: 6 }
}

export function run(): boolean {
  fails = 0
  pass = 0

  const good = judgeCatalogs(fixture())
  ok("正例① 三张一致 ⇒ passed", good.status === "passed", good.status)

  // 反例① 改一个字符（中间行）：必须红、点名文件与行、给出改法
  const mutated = fixture()
  mutated.catalogs[1].actual = "H2\na\nb-CHANGED"
  const m = judgeCatalogs(mutated)
  ok(
    "反例① 改一个字符 ⇒ failed 且点名 event 文件/行/重生成命令",
    m.status === "failed" &&
      m.findings?.some((f) => f.file === "docs/event-catalog.md" && f.line === 3 && /内容与源码不一致/.test(f.detail)) === true &&
      m.findings?.some((f) => f.file === "docs/event-catalog.md" && /gen-catalog\.ts/.test(f.detail)) === true,
    `${m.status} / ${JSON.stringify(m.findings)}`,
  )

  // 反例② 文件缺失：必须红，且说清「生成物进 git」
  const missing = fixture()
  missing.catalogs[2].actual = null
  const ms = judgeCatalogs(missing)
  ok(
    "反例② 文件不存在 ⇒ failed 且点名 dependency 文件",
    ms.status === "failed" && ms.findings?.some((f) => f.file === "docs/dependency-catalog.md" && /提交进 git/.test(f.detail)) === true,
    `${ms.status} / ${JSON.stringify(ms.findings)}`,
  )

  // 反例③ 改文件头：必须红并指到第 1 行
  const hdr = fixture()
  hdr.catalogs[0].actual = "TAMPERED\nline1\nline2"
  const h = judgeCatalogs(hdr)
  ok(
    "反例③ 改文件头 ⇒ failed 且指到第 1 行",
    h.status === "failed" && h.findings?.some((f) => f.file === "docs/ctx-catalog.md" && f.line === 1 && /文件头/.test(f.detail)) === true,
    `${h.status} / ${JSON.stringify(h.findings)}`,
  )

  // 判不了：0 包不许绿
  const noCorpus = fixture()
  noCorpus.packageCount = 0
  const u = judgeCatalogs(noCorpus)
  ok("判不了① 0 个包 ⇒ unjudged(no-corpus)，不冒充绿", u.status === "unjudged" && u.reason === "no-corpus", `${u.status}/${u.reason}`)

  // 集成正例：真语料 scan() 与 committed 生成物一致。
  // ⚠️ 不写死包数与表数：曾硬编码「3 张 + 6 个包」，盘上包演进到 8 后自检假红（快照断言随
  //    语料漂移，ISS-899 清债）。表数从 EXTRACTORS 现算（extractor 增减断言自动跟随）；
  //    包数只断言非零——0 包的 unjudged 形态已由上方 fixture 用例钉死，不靠这里复读。
  const live = scan()
  ok("正例② 真语料扫到全部 extractor 的表 + 非零包数", live.catalogs.length === EXTRACTORS.length && live.packageCount > 0, `${live.catalogs.length}/${live.packageCount}`)
  const liveJudge = judgeCatalogs(live)
  ok("正例③ 真语料判 passed（committed 生成物与源码一致）", liveJudge.status === "passed", `${liveJudge.status} / ${JSON.stringify(liveJudge.findings)}`)

  // 有牙：把真语料某张的 expected 删一行 ⇒ 必红
  const teethInput = scan()
  teethInput.catalogs[1].actual = `${teethInput.catalogs[1].expected}\n多一行`
  const teeth = judgeCatalogs(teethInput)
  ok("反例④ 真语料注入多余行 ⇒ failed（判据有牙）", teeth.status === "failed", teeth.status)

  // 同口径：expected 全部来自 generateAll（表数同样从 EXTRACTORS 现算，不写死）
  const gen = generateAll(REPO_ROOT)
  ok("不变式：判据的全部表 expected 与生成器逐字相同", gen.length === EXTRACTORS.length && gen.every((g) => live.catalogs.some((c) => c.output === g.output && c.expected === g.text)))

  const total = pass + fails
  if (fails) {
    console.error(`✗ verify-catalogs spec：${pass} 过 / ${fails} 失败（SPEC_RESULT total=${total} pass=${pass} fail=${fails}）`)
    return false
  }
  console.log(`✓ verify-catalogs spec 全过：${total} 条（SPEC_RESULT total=${total} pass=${pass} fail=${fails}）`)
  return true
}
