/**
 * `verify-no-unknown-casts` 的 spec（ISS-879）。
 *
 * 载体：本仓口径 —— **`export function run()` + `--selftest`**（gate-runtime.ts:104-126：
 * `--selftest` 动态 import 同名 spec 并调 `run()`；不是 describe/it）。
 *
 * ## 覆盖什么
 *
 * ① `findUnknownCasts` AST 取数：`as unknown as X` / 尖括号 `<unknown>` / 联合类型里的 unknown 成员
 * ② 注释、字符串、别名（type Unknown = unknown + as Unknown）、`as string` 不误伤
 * ③ 指纹稳定：同写法两次同指纹；加注释/改空白不改指纹；改断言对象换指纹
 * ④ 判定四态：新指纹红 / 新文件红 / 存量变多红 / 相等绿 / 消失提示 prune（仍绿）
 * ⑤ fail-closed：基线缺席 ⇒ unjudged，不冒绿；0 文件 ⇒ unjudged；无编译器 ⇒ unjudged
 * ⑥ 变异：改基线计数必红、删基线记录必红（同一处 cast 从绿变红，证明判据有牙）
 * ⑦ 真扫盘：scanCasts 对仓库真实 src 扫出与 baseline 一致；临时注入一处 ⇒ 红带行号，移除 ⇒ 绿
 * ⑧ 按身份退役：删一处 cast 后 countCasts 不含该指纹（prune 会写掉），加回 ⇒ 红
 *
 * ⛔ 反例必须点名**哪一行、哪个指纹前缀、期望/实际**，不只断 `status === "failed"` ——
 *    「只有一个错」与「全都错」长得一样时，断 failed 等于什么也没断。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  countCasts,
  findUnknownCasts,
  judgeNoUnknownCasts,
  loadTs,
  readBaseline,
  scanCasts,
  type CastBaseline,
  type CastInput,
  type UnknownCast,
} from "./verify-no-unknown-casts.ts"

let fails = 0
/** 断言条数实测累加，不在结尾手写拆解。 */
let total = 0
const ok = (name: string, cond: boolean, extra = "") => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` —— 实际：${extra}`}`)
  if (!cond) fails++
}

const ts = loadTs()

/** 造一个 cast（指纹用长度 64 的假 sha，够判结构，不参与真 AST）。 */
const cast = (file: string, line: number, fp: string): UnknownCast => ({ file, line, fingerprint: fp })
const FP = (seed: string): string => seed.repeat(64 / seed.length).slice(0, 64)
const A = FP("a")
const B = FP("b")
const C = FP("c")

const F = "packages/g/p/src/x.ts"
const input = (casts: UnknownCast[], baseline: CastBaseline | null, fileCount = 1, hasTs = true): CastInput => ({
  casts,
  baseline,
  fileCount,
  hasTs,
})

/** findings 里有一条同时命中这些子串。 */
const hasFinding = (r: { findings?: { detail: string }[] }, ...needles: string[]): boolean =>
  (r.findings ?? []).some((f) => needles.every((n) => f.detail.includes(n)))

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-no-unknown-casts.spec")

  if (ts === null) {
    ok("缺 typescript ⇒ 本 spec 无法执行（不是通过）", false, "loadTs() 返回 null")
    console.log("✗ 缺 typescript，spec 无法执行")
    return false
  }

  /* ── ① AST 取数：四种写法 ─────────────────────────────────────── */

  {
    const src = [
      "const a = x as unknown as A", // as 写法
      "const b = <unknown>x", // 尖括号写法
      "const c = x as string | unknown", // 联合成员里的 unknown
      "const d = (x as (unknown))", // 括号里的 unknown
    ].join("\n")
    const casts = findUnknownCasts(F, src, ts)
    ok("AST：四种 unknown 断言都抓到（4 条）", casts.length === 4, `实际 ${casts.length} 条`)
    ok("AST：as unknown as 的行号正确（第 1 行）", casts.some((c) => c.line === 1), JSON.stringify(casts.map((c) => c.line)))
    ok("AST：尖括号写法行号正确（第 2 行）", casts.some((c) => c.line === 2), JSON.stringify(casts.map((c) => c.line)))
    ok("AST：每条都带 64 位 sha256 指纹", casts.every((c) => /^[a-f0-9]{64}$/.test(c.fingerprint)))
  }

  {
    const src = [
      "// const x = y as unknown as A", // 注释
      "const s = 'as unknown as A'", // 字符串
      "type U = unknown", // 别名声明
      "const t = y as U", // as 到别名（不是直接的 unknown keyword）
      "const n = y as string", // 普通断言
      "interface I { v: unknown }", // 容器类型
    ].join("\n")
    const casts = findUnknownCasts(F, src, ts)
    ok("AST：注释/字符串/别名/普通断言/容器都不误伤（0 条）", casts.length === 0, `实际 ${casts.length} 条`)
  }

  /* ── ③ 指纹稳定性 ─────────────────────────────────────────────── */

  {
    const a = findUnknownCasts(F, "const x = y as unknown as A", ts)[0]
    const b = findUnknownCasts(F, "const x = y as unknown as A", ts)[0]
    ok("指纹：同写法两次 ⇒ 同指纹", a.fingerprint === b.fingerprint, `${a.fingerprint.slice(0, 12)} / ${b.fingerprint.slice(0, 12)}`)
    const commented = findUnknownCasts(F, "/* note */ const x = y as unknown as A // tail", ts)[0]
    ok("指纹：加注释不改指纹", commented.fingerprint === a.fingerprint)
    const reformatted = findUnknownCasts(F, "const x   =   y as unknown as A", ts)[0]
    ok("指纹：改空白不改指纹", reformatted.fingerprint === a.fingerprint)
    const renamed = findUnknownCasts(F, "const x = z as unknown as A", ts)[0]
    ok("指纹：改断言对象（y→z）⇒ 换指纹（按身份退役）", renamed.fingerprint !== a.fingerprint)
  }

  /* ── ④ 判定四态 ───────────────────────────────────────────────── */

  {
    const r = judgeNoUnknownCasts(input([cast(F, 7, A)], { [F]: { [A]: 1 } }))
    ok("判定：存量指纹计数相等 ⇒ 绿", r.status === "passed", r.status)
  }
  {
    const r = judgeNoUnknownCasts(input([cast(F, 7, B)], { [F]: { [A]: 1 } }))
    ok("判定：新指纹 ⇒ 红", r.status === "failed", r.status)
    ok("判定：新指纹 finding 带文件:行", (r.findings ?? []).some((f) => f.file === F && f.line === 7), JSON.stringify(r.findings))
    ok("判定：新指纹 finding 带指纹前12位", hasFinding(r, B.slice(0, 12)))
    ok("判定：新指纹 finding 带期望/实际", hasFinding(r, "期望 0", "实际 1"))
    ok("判定：新指纹 finding 带怎么改", hasFinding(r, "窄化", "基线"))
  }
  {
    const r = judgeNoUnknownCasts(input([cast("packages/g/p/src/new.ts", 3, A)], { [F]: { [A]: 1 } }))
    ok("判定：新文件（基线无此文件）⇒ 红", r.status === "failed", r.status)
    ok("判定：新文件 finding 指到新文件路径", (r.findings ?? []).some((f) => f.file === "packages/g/p/src/new.ts"))
  }
  {
    // 同一文件、同一指纹出现两次，基线只登记 1 次 ⇒ 第二次是「存量变多」。
    const r = judgeNoUnknownCasts(input([cast(F, 7, A), cast(F, 9, A)], { [F]: { [A]: 1 } }))
    ok("判定：存量指纹变多（2>1）⇒ 红", r.status === "failed", r.status)
    ok("判定：存量变多条 finding 带实际出现的第二行", (r.findings ?? []).some((f) => f.line === 9), JSON.stringify(r.findings))
  }
  {
    const r = judgeNoUnknownCasts(input([], { [F]: { [A]: 1 } }))
    ok("判定：指纹消失（基线有实际无）⇒ 仍绿", r.status === "passed", r.status)
    ok("判定：指纹消失给 prune 提示", (r.detail ?? "").includes("prune"), r.detail)
    ok("判定：prune 提示带消失指纹前12位", (r.detail ?? "").includes(A.slice(0, 12)), r.detail)
  }

  /* ── ⑤ fail-closed 三态 ───────────────────────────────────────── */

  {
    const r = judgeNoUnknownCasts(input([], null))
    ok("fail-closed：基线缺席 ⇒ unjudged（不是绿）", r.status === "unjudged" && r.reason === "no-baseline", `${r.status}/${r.reason}`)
  }
  {
    const r = judgeNoUnknownCasts(input([], {}, 0))
    ok("fail-closed：0 源文件 ⇒ unjudged(no-corpus)", r.status === "unjudged" && r.reason === "no-corpus", `${r.status}/${r.reason}`)
  }
  {
    const r = judgeNoUnknownCasts(input([], {}, 1, false))
    ok("fail-closed：无编译器 ⇒ unjudged(no-binary)", r.status === "unjudged" && r.reason === "no-binary", `${r.status}/${r.reason}`)
  }

  /* ── ⑥ 变异：改基线计数 / 删记录 ⇒ 同一处 cast 从绿变红 ────────── */

  {
    const castA = cast(F, 7, A)
    const green = judgeNoUnknownCasts(input([castA], { [F]: { [A]: 1 } }))
    ok("变异前：1 处 cast + 基线记 1 ⇒ 绿", green.status === "passed", green.status)
    const lowered = judgeNoUnknownCasts(input([castA], { [F]: { [A]: 2 } })) // 记 2，实际 1：不该红（变少不红）
    ok("变异①：基线记多（2>实际1）⇒ 仍绿（只提示 prune）", lowered.status === "passed", lowered.status)
    const removed = judgeNoUnknownCasts(input([castA], { [F]: { [B]: 1 } })) // 删掉 A 记录
    ok("变异②：删掉该指纹的基线记录 ⇒ 红（判据有牙）", removed.status === "failed", removed.status)
    ok("变异②：红的指纹前缀是被删的那个", hasFinding(removed, A.slice(0, 12)))
  }

  /* ── 基线结构体检 ─────────────────────────────────────────────── */

  {
    // 用临时目录喂 readBaseline：畸形计数 / 空对象 / 非法路径都该返回 null（fail-closed）。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nuc-base-"))
    try {
      const baseDir = path.join(tmp, "scripts/baseline")
      fs.mkdirSync(baseDir, { recursive: true })
      const bp = path.join(baseDir, "no-unknown-casts.baseline.json")
      fs.writeFileSync(bp, JSON.stringify({ [F]: { not_a_sha: 1 } }))
      ok("基线体检：非法指纹 ⇒ readBaseline 返回 null", readBaseline(tmp) === null)
      fs.writeFileSync(bp, JSON.stringify({ [F]: {} }))
      ok("基线体检：空的指纹表 ⇒ null", readBaseline(tmp) === null)
      fs.writeFileSync(bp, JSON.stringify({ "/abs/x.ts": { [A]: 1 } }))
      ok("基线体检：绝对路径 ⇒ null", readBaseline(tmp) === null)
      fs.writeFileSync(bp, JSON.stringify({ "packages/g/p/src/x.ts": { [A]: -1 } }))
      ok("基线体检：负数计数 ⇒ null", readBaseline(tmp) === null)
      fs.writeFileSync(bp, "{not json")
      ok("基线体检：坏 JSON ⇒ null", readBaseline(tmp) === null)
      fs.unlinkSync(bp)
      ok("基线体检：文件缺席 ⇒ null（删基线不冒绿）", readBaseline(tmp) === null)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  /* ── countCasts 聚合与按身份退役 ───────────────────────────────── */

  {
    const counted = countCasts([cast(F, 1, B), cast(F, 2, A), cast(F, 3, B)])
    ok("countCasts：同文件同指纹聚合计数（B=2）", counted[F]?.[B] === 2, JSON.stringify(counted))
    ok("countCasts：不同指纹分开记（A=1）", counted[F]?.[A] === 1)
    // 按身份退役：删掉一条 B 后重新 count，B 变 1；全删则条目消失。
    const afterRetire = countCasts([cast(F, 1, B), cast(F, 2, A)])
    ok("按身份退役：删一处后该指纹计数从 2→1", afterRetire[F]?.[B] === 1)
    const afterAll = countCasts([cast(F, 2, A)])
    ok("按身份退役：删光后该指纹条目消失", afterAll[F]?.[B] === undefined)
    const readded = judgeNoUnknownCasts(input([cast(F, 1, B)], afterAll))
    ok("按身份退役：手动加回（无基线记录）⇒ 红", readded.status === "failed", readded.status)
  }

  /* ── ⑦ 真扫盘 + 反向控制（同一条路：scanCasts + readBaseline）───── */

  {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
    const realBase = readBaseline(repo)
    ok("真扫盘：仓库基线读得到（非空）", realBase !== null && Object.keys(realBase).length > 0)
    const scanned = scanCasts(repo, ts)
    ok("真扫盘：src 下有源码文件（分母>0）", scanned.fileCount > 0, `fileCount=${scanned.fileCount}`)
    // ISS-524：去重删掉两域各 2 处 `as unknown as Record`（改走 journal 共享骨架），存量 5 → 1。
    ok("真扫盘：扫出 1 处存量 cast", scanned.casts.length === 1, `实际 ${scanned.casts.length}`)
    const judged = judgeNoUnknownCasts(input(scanned.casts, realBase, scanned.fileCount, true))
    ok("真扫盘：真实语料对真实基线 ⇒ 绿", judged.status === "passed", `${judged.status} ${judged.detail ?? ""}`)

    // 变异：临时给一个真实 src 加一处 as unknown as，判红带行号，移除恢复绿。
    const target = path.join(repo, "packages/storage/storage-domain/src/index.ts")
    if (fs.existsSync(target)) {
      const original = fs.readFileSync(target, "utf8")
      try {
        fs.writeFileSync(target, `${original}\nexport const __nucSpecNeg = ({} as unknown as Record<string, unknown>)\n`)
        const after = scanCasts(repo, ts)
        const bad = judgeNoUnknownCasts(input(after.casts, realBase, after.fileCount, true))
        ok("真扫盘变异：注入一处 as unknown as ⇒ 红", bad.status === "failed", bad.status)
        ok(
          "真扫盘变异：红指到目标文件（带文件:行）",
          (bad.findings ?? []).some((f) => f.file === "packages/storage/storage-domain/src/index.ts" && typeof f.line === "number"),
          JSON.stringify(bad.findings),
        )
        fs.writeFileSync(target, original)
        const restored = scanCasts(repo, ts)
        ok(
          "真扫盘变异：恢复后 ⇒ 绿（红来源只可能是注入那行）",
          judgeNoUnknownCasts(input(restored.casts, realBase, restored.fileCount, true)).status === "passed",
        )
      } finally {
        fs.writeFileSync(target, original) // 双保险：中途抛错也还原，不留脏文件
      }
    } else {
      ok("真扫盘变异：目标源文件存在（否则变异跳过）", false, target)
    }
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立（共 ${total}）`
      : `✓ spec 全过（${total} 条断言：AST 四写法 + 五类不误伤 + 指纹稳定 + 判定五态 + fail-closed 三态 + 变异 + 基线体检 + 按身份退役 + 真扫盘反向控制）`,
  )
  return fails === 0
}
