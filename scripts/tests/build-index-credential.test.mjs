// build-index-repowiki · --check 的两个退出码必须可区分（ISS-657）
//
// ## 为什么必须有这一层（而不是只靠 --selftest）
// `--selftest` 验的是 `credentialState()` 这个**纯判据**；而「凭据失效 ⇒ exit 2 而不是 1」
// 这条语义落在 **CLI 分支**里（`process.exit(code)`）。只验纯函数的话，把
// `const code = r.ok ? (credBad ? 2 : 0) : 1` 改成恒 `1`（两种红混用一个码）照样全绿 ——
// 而「可区分」正是本单的硬要求。这正是本仓 ISS-637 返工踩过的坑：验到的那一层
// 必须就是被改的那一层。
//
// ## 为什么起真子进程
// 退出码是进程级事实，只有真跑才看得到。用 `--out` 喂一份**人造索引**，
// 从而在不重建全仓（秒级）的前提下分别构造「内容一致/不一致」×「凭据有效/失效」四种组合。
//
// 跑法：bash scripts/tests/run-build-index-credential.sh  或  node --test 本文件
// 自查：node scripts/tests/build-index-credential.test.mjs   （直接跑，退出码 0 = 全绿）
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..", "..")
const SCRIPT = path.join(ROOT, "scripts", "build-index-repowiki.mjs")
const INDEX = path.join(ROOT, "forge-repowiki", "index", "repo-wiki-index.json")

/* ⚠️ 本文件**自己会被收进 wiki 索引的 `files` 倒排**（索引扫的是已入库源码文件）。
   于是「跑一次重建」与「盘上索引」的 `files` 段必然差它自己这一个键 —— 实测就是这么红的
   （差异段：files，只重建有 `scripts/tests/build-index-credential.test.mjs`）。
   这不是产品缺陷，是**测试文件自己制造的噪音**：任何新增源码文件在重建索引前都会这样。
   故本测试判「内容一致」时用 `--out` 指向一份**同源人造索引**，而不是拿盘上那份去比 ——
   否则它会因自己的存在而恒红（那是「测试自己造红」，比不测更坏）。 */

const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 })
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` }
}

const cases = []
const t = (n, p) => cases.push({ n, p: !!p })

if (!fs.existsSync(INDEX)) {
  // 索引不在 ⇒ 这条测试**不能**报绿（那是「扫了 0 个」冒充「查过了」）
  console.log(`✗ 前置缺失：${INDEX} 不在（先重建一次索引）`)
  process.exit(2)
}

/* 内容一致的**基准**取「现在重建一次」的产物，而不是盘上那份：
   盘上索引可能落后于工作区（例如刚新增了源码文件），那时它与重建结果本来就不同，
   拿它当基准会让「内容一致」这条用例测的是「盘上索新不新」，而不是本单要测的退出码语义。
   ⚠️ 用 --out 写到临时目录，**不碰**入库的索引文件。 */
const baseTmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "repowiki-base-")), "base.json")
{
  const r = spawnSync(process.execPath, [SCRIPT, "--out", baseTmp], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 })
  if (r.status !== 0 || !fs.existsSync(baseTmp)) {
    console.log(`✗ 前置失败：无法生成基准索引（--out 退出 ${r.status}）\n${(r.stderr || "").slice(0, 800)}`)
    process.exit(2)
  }
}
const base = JSON.parse(fs.readFileSync(baseTmp, "utf8"))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repowiki-exitcode-"))
const withCred = (cred, mutate) => {
  const idx = JSON.parse(JSON.stringify(base))
  idx.stats.spanSource.cachePath = cred
  if (mutate) mutate(idx)
  const p = path.join(tmp, `idx-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(p, JSON.stringify(idx, null, 1))
  return p
}

try {
  const liveCred = base.stats && base.stats.spanSource && base.stats.spanSource.cachePath
  const liveOk = liveCred && (liveCred.startsWith("~/") ? fs.existsSync(path.join(os.homedir(), liveCred.slice(2))) : fs.existsSync(liveCred))

  // ① 内容一致 + 凭据有效 ⇒ 0（基准索引刚由本树重建，凭据必然有效）
  const clean = withCred(liveCred)
  const r1 = run(["--check", "--out", clean])
  t("前置：基准索引的凭据在本树有效（否则下面几条测的就不是退出码语义）", liveOk)
  t("内容一致 + 凭据有效 ⇒ exit 0", r1.code === 0)
  t("exit 0 时输出含「凭据有效」（人不用猜它查没查凭据）", r1.out.includes("凭据有效"))

  // ② 内容一致 + 凭据失效 ⇒ 2（**不许**因为凭据问题就报 1：处置不同）
  const credBad = withCred(path.join(tmp, "definitely-gone-1577.json"))
  const r2 = run(["--check", "--out", credBad])
  t("内容一致 + 凭据失效 ⇒ exit 2（不是 1：两种红可区分）", r2.code === 2)
  t("exit 2 文案点名「索引凭据失效」", /索引凭据失效/.test(r2.out))
  t("exit 2 文案点出「不影响内容正确性」（否则下一人当红灯修错方向）", /不影响内容正确性/.test(r2.out))
  t("exit 2 文案说出内容比对的结论（本次为一致）", /本次内容比对：一致/.test(r2.out))

  // ③ 内容不一致 + 凭据有效 ⇒ 1（这才是要判红的那个）
  const badContent = withCred(liveCred, (idx) => { idx.stats.moduleScope = (idx.stats.moduleScope || 0) + 999 })
  const r3 = run(["--check", "--out", badContent])
  t("内容不一致 + 凭据有效 ⇒ exit 1", r3.code === 1)
  t("exit 1 文案含「内容不一致」与重建修法", /内容不一致/.test(r3.out) && /重建一次并提交/.test(r3.out))

  // ④ 内容不一致 + 凭据失效 ⇒ 仍 1（内容问题优先：它才是判红的那个），且两段都报
  const both = withCred(path.join(tmp, "gone-both-1577.json"), (idx) => { idx.stats.moduleScope = (idx.stats.moduleScope || 0) + 999 })
  const r4 = run(["--check", "--out", both])
  t("内容不一致 + 凭据失效 ⇒ exit 1（内容问题优先，不被黄灯盖住）", r4.code === 1)
  t("两者并存时两段都报（不许只报一个）", /内容不一致/.test(r4.out) && /索引凭据失效/.test(r4.out))
  t("并存时凭据段说清「本次内容比对：不一致」", /本次内容比对：不一致/.test(r4.out))

  // ⑤ 反控：凭据**有效**时不许出现凭据告警（否则黄灯恒亮 = 噪音）
  const r5 = run(["--check", "--out", clean])
  t("反控：凭据有效时不出「索引凭据失效」字样（黄灯不许恒亮）", !/索引凭据失效/.test(r5.out))

  // ⑥ --json 形态带 code 与 credential（CI 与工具要能机器读，不必解析人话）
  const r6 = run(["--check", "--json", "--out", credBad])
  let j = null
  /* ⚠️ 取 `out` 不是 `stdout`：`run()` 把 stdout+stderr 合并成 out（与上面几条断言同一口径）。
     第一版这里写 `r6.stdout` ⇒ 恒 undefined ⇒ JSON.parse 抛 ⇒ 三条断言假红
     （而实现其实是对的，实测 `code:2` / `credential.state:missing` / `raw` 齐全）。
     一律用 `out`，别在这一个用例上换口径。 */
  try { j = JSON.parse(r6.out) } catch { /* 解析失败由下面的断言报 */ }
  t("--json 带 code 字段且与退出码一致", j && j.code === 2 && r6.code === 2)
  t("--json 带 credential.state（机器可判）", j && j.credential && j.credential.state === "missing")
  t("--json 带 credential.raw（能追到是哪条路径）", j && j.credential && typeof j.credential.raw === "string")

  const bad = cases.filter((c) => !c.p)
  console.log(cases.map((c) => `${c.p ? "✓" : "✗"} ${c.n}`).join("\n"))
  console.log(`\nbuild-index 凭据/退出码 ${cases.length - bad.length}/${cases.length} 通过`)
  process.exitCode = bad.length ? 1 : 0
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
}
