/**
 * `verify-tsconfig-paths` 的 spec（ISS-897 / ISS-518 盲区闭环）。
 *
 * ## 为什么这一格必须有「必然失败」用例
 *
 * 本判据封的是**静默漏配**：包在盘上、paths 缺一条 ⇒ 没有任何判据红，直到第一个
 * consumer 撞 TS2307。一条只验「现状判绿」的 spec 与**把判据删掉的版本**给出完全
 * 相同的结果（当前真实语料本来就是对上的）—— 它证明不了任何事。所以每个方向都配
 * 「必须红」的断言，外加一条语料归零的（断言 `status === "unjudged"`，**不是** `"passed"`
 * —— 单正文钉死「空语料判 unjudged 不判绿」）。
 *
 * ## 两层用例（缺一层就有一族形态没人盯）
 *
 *   A. **纯函数层**（`judgePaths`）：喂构造数据，判两个方向 + 隔离 + 语料坏 + 语料归零。
 *   B. **真实 IO 层**（`readPaths` 跑临时树）：纯函数看不见「发现器漏了包」与
 *      「JSONC 带注释解析失败」这两类错 —— 而它们恰恰是本判据的核心射程
 *      （真实 emit.json 满篇 `//` 注释，`JSON.parse` 直接抛）。
 *
 * ⛔ 反例必须点名**具体哪一条**报红（文件 + 期望 + 实际 + 怎么改），不许只断 `status === "failed"`。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { judgePaths, readPaths, type PathsInput, type PkgEntry } from "./verify-tsconfig-paths.ts"

let fails = 0
/** 断言条数**实测累加**，不在结尾手写拆解 —— 手写的数会和实际脱节。 */
let total = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : `\n      ↳ ${extra}`}`)
  if (!cond) fails++
}

/** 有没有某条 finding 的 detail 含这个片段。 */
const hits = (input: PathsInput, needle: string) =>
  (judgePaths(input).findings ?? []).some((f) => f.detail.includes(needle))

const pkg = (dir: string, name: string | null): PkgEntry => ({ dir, name })

/** 临时树骨架：写文件即建目录。 */
function tmpTree(prefix: string): { root: string; write: (rel: string, body: string) => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const write = (rel: string, body: string) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return { root, write }
}

/** 一份带注释的 emit 基座（真实形态：满篇 `//`，`JSON.parse` 直接抛——钉住必须走 parseJsonc）。 */
function emitBase(pathsBody: string): string {
  return (
    "// tsconfig.base.emit.json —— 测试骨架（带注释：JSONC，不是纯 JSON）\n" +
    `{\n  "compilerOptions": {\n    "paths": {\n${pathsBody}    }\n  }\n}\n`
  )
}

const pkgManifest = (name: string) => `{"name":"${name}","version":"0.0.0","private":true}`

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-tsconfig-paths.spec")

  // ══ A. 纯函数层 ══════════════════════════════════════════════════════════

  // ── 正例 ────────────────────────────────────────────────────────────────
  {
    const input: PathsInput = {
      packages: [pkg("packages/pm/issue", "@matter/issue"), pkg("packages/kb/blocks", "@matter/blocks")],
      pathsKeys: ["@matter/blocks", "@matter/issue"],
    }
    const r = judgePaths(input)
    ok("正例：两包两键双向对上 ⇒ passed", r.status === "passed")
    ok("正例：0 finding", (r.findings ?? []).length === 0)
    ok("正例：detail 数出包数与键数", (r.detail ?? "").includes("2 个包") && (r.detail ?? "").includes("2 条"))
  }

  // ── 反例①：包存在而 paths 缺（ISS-518 本体）─────────────────────────────
  {
    const input: PathsInput = {
      packages: [pkg("packages/pm/issue", "@matter/issue"), pkg("packages/ui/theme", "@matter/ui-theme")],
      pathsKeys: ["@matter/issue"],
    }
    const r = judgePaths(input)
    ok("反例①：包存在而 paths 缺 ⇒ failed", r.status === "failed")
    ok("反例①：只报 1 条（不连坐已对上的那个包）", (r.findings ?? []).length === 1)
    const f = (r.findings ?? [])[0]
    ok("反例①：file 指到漏配包的 manifest", f?.file === "packages/ui/theme/package.json")
    ok(
      "反例①：文案含包名 + 期望 + 实际（四要素：文件已由 file 指向）",
      (f?.detail ?? "").includes("@matter/ui-theme") && (f?.detail ?? "").includes("期望") && (f?.detail ?? "").includes("实际缺失"),
      f?.detail,
    )
    ok(
      "反例①：文案给出怎么改（含「在 tsconfig.base.emit.json 的 paths 补一条」+ 建议键值）",
      (f?.detail ?? "").includes("在 tsconfig.base.emit.json 的 paths 补一条") && (f?.detail ?? "").includes(`"@matter/ui-theme": ["./packages/ui/theme/src/index.ts"]`),
      f?.detail,
    )
    ok("反例①：文案点名 ISS-518 的教训（第一个 consumer 撞 TS2307）", (f?.detail ?? "").includes("TS2307"))
  }

  // ── 反例②：paths 有键而包不存在（悬空）───────────────────────────────────
  {
    const input: PathsInput = {
      packages: [pkg("packages/pm/issue", "@matter/issue")],
      pathsKeys: ["@matter/issue", "@matter/gone"],
    }
    const r = judgePaths(input)
    ok("反例②：悬空键 ⇒ failed", r.status === "failed")
    ok("反例②：只报 1 条", (r.findings ?? []).length === 1)
    const f = (r.findings ?? [])[0]
    ok("反例②：file 指到 emit 基座", f?.file === "tsconfig.base.emit.json")
    ok(
      "反例②：文案含「悬空」与该键名 + 期望 + 实际",
      (f?.detail ?? "").includes("悬空") && (f?.detail ?? "").includes("@matter/gone") && (f?.detail ?? "").includes("期望") && (f?.detail ?? "").includes("实际"),
      f?.detail,
    )
    ok("反例②：文案给出怎么改（删那条或对齐包名）", (f?.detail ?? "").includes("删掉") && (f?.detail ?? "").includes("对齐"))
  }

  // ── 两方向同时坏：两条都报，互不吞掉 ──────────────────────────────────────
  {
    const input: PathsInput = {
      packages: [pkg("packages/a/b", "@matter/kept"), pkg("packages/new/pkg", "@matter/new-pkg")],
      pathsKeys: ["@matter/kept", "@matter/gone"],
    }
    const r = judgePaths(input)
    ok("两方向同时坏 ⇒ 报 2 条（漏配 1 + 悬空 1）", (r.findings ?? []).length === 2)
    ok("两方向同时坏：漏配那条点了名", hits(input, "@matter/new-pkg"))
    ok("两方向同时坏：悬空那条点了名", hits(input, "@matter/gone"))
  }

  // ── 语料坏：manifest 读不出 name ⇒ 按红，不静默跳过 ───────────────────────
  {
    const input: PathsInput = {
      packages: [pkg("packages/bad/one", null), pkg("packages/good/two", "@matter/good-two")],
      pathsKeys: ["@matter/good-two"],
    }
    const r = judgePaths(input)
    ok("语料坏：manifest 无 name ⇒ failed（不是静默跳过）", r.status === "failed")
    ok("语料坏：只报 1 条（好的那个包不连坐）", (r.findings ?? []).length === 1)
    ok("语料坏：file 指到坏 manifest", (r.findings ?? [])[0]?.file === "packages/bad/one/package.json")
    ok("语料坏：文案给出修法（合法 JSON 且有 name）", hits(input, "合法 JSON"))
  }

  // ── 干扰：不误判 ─────────────────────────────────────────────────────────
  {
    // 键序无关：paths 键与包名的对应是集合关系，不是位置关系
    const r = judgePaths({
      packages: [pkg("packages/a/b", "@matter/aa"), pkg("packages/c/d", "@matter/cc")],
      pathsKeys: ["@matter/cc", "@matter/aa"],
    })
    ok("干扰：键序与包序不一致也判绿（集合对账，不是位置对账）", r.status === "passed")

    // 大小写敏感：TS paths 键按字符串全等解析，@matter/X ≠ @matter/x —— 不做大小写归一
    const cs = judgePaths({ packages: [pkg("packages/a/b", "@matter/UI-Theme")], pathsKeys: ["@matter/ui-theme"] })
    ok("干扰：大小写敏感（@matter/UI-Theme ≠ @matter/ui-theme ⇒ 红两条：漏配 + 悬空）", cs.status === "failed" && (cs.findings ?? []).length === 2)

    // 空 name 视同语料坏（name: "" 不是合法包名）：报坏语料 1 条；
    // 那条 @matter/a-b 键对不上任何**有效**包名 ⇒ 同时悬空 1 条 —— 两条都是真实信息，不互相吞
    const emptyName = judgePaths({ packages: [pkg("packages/a/b", "")], pathsKeys: ["@matter/a-b"] })
    ok(
      "干扰：空串 name 视同坏语料按红（不静默）+ 悬空并报",
      emptyName.status === "failed" && (emptyName.findings ?? []).length === 2 && (emptyName.findings ?? []).every((f) => f.file === "packages/a/b/package.json" || f.file === "tsconfig.base.emit.json"),
      JSON.stringify(emptyName.findings),
    )
  }

  // ── ⛔ 语料归零：必须 unjudged，不许绿（单正文钉死的验收 2）────────────────
  {
    const r = judgePaths({ packages: [], pathsKeys: [] })
    ok("语料归零：0 个包 ⇒ unjudged（不是 passed）", r.status === "unjudged")
    ok("语料归零：status 严格不等于 passed（必然失败用例）", r.status !== "passed")
    ok("语料归零：理由码 no-corpus", r.reason === "no-corpus")
    ok("语料归零：detail 说明「0 个包」", (r.detail ?? "").includes("0 个包"))
    // 空盘但键非空：仍判不了（包语料为空时悬空无从定义——哪个键该对上哪个包没有语料）
    const r2 = judgePaths({ packages: [], pathsKeys: ["@matter/ghost"] })
    ok("语料归零：盘空键非空也 unjudged（不当绿也不当红）", r2.status === "unjudged")
  }

  // ── 反向控制：抽掉一条键必须变红（证明判据有牙，不是恒绿）────────────────
  {
    const clean: PathsInput = {
      packages: [pkg("packages/a/b", "@matter/aa"), pkg("packages/c/d", "@matter/cc")],
      pathsKeys: ["@matter/aa", "@matter/cc"],
    }
    const mutated: PathsInput = { packages: clean.packages, pathsKeys: ["@matter/aa"] }
    ok("反向控制：干净语料先绿（基线）", judgePaths(clean).status === "passed")
    ok("反向控制：只抽掉一条键 ⇒ 立刻红（判据有判别力）", judgePaths(mutated).status === "failed")
  }

  // ══ B. 真实 IO 层（发现器 scanPackages + JSONC 解析 + 端到端）═════════════
  // 纯函数看不见「发现器漏包」与「带注释 JSONC 解析失败」—— 本判据的核心射程在这里。
  {
    const { root, write } = tmpTree("tsconfig-paths-io-")
    try {
      // 任务书验收 1 的形态：造包不补 paths ⇒ 红；红文案含包名 + 怎么改
      write("packages/test-group/test-pkg/package.json", pkgManifest("@matter/test-pkg"))
      // 干扰：点目录 / node_modules 里的 manifest 不该被当包（scanPackages 的纪律，钉住）
      write("packages/.hidden/x/package.json", pkgManifest("@matter/hidden"))
      write("packages/test-group/node_modules/y/package.json", pkgManifest("@matter/nm-pkg"))

      write(
        "tsconfig.base.emit.json",
        emitBase(`      // 只配了别的包，没配 @matter/test-pkg\n      "@matter/other": ["./packages/other/other/src/index.ts"],\n`),
      )

      const r = readPaths(root)
      ok("端到端：造包不补 paths ⇒ 红", r.status === "failed")
      ok(
        "端到端：红文案含包名 + 「在 tsconfig.base.emit.json 的 paths 补一条」+ 建议键值",
        (r.findings ?? []).some(
          (f) =>
            f.detail.includes("@matter/test-pkg") &&
            f.detail.includes("在 tsconfig.base.emit.json 的 paths 补一条") &&
            f.detail.includes(`"@matter/test-pkg": ["./packages/test-group/test-pkg/src/index.ts"]`),
        ),
        JSON.stringify(r.findings),
      )
      ok("端到端：悬空键 @matter/other 同时报出来（两个方向都活着）", (r.findings ?? []).some((f) => f.detail.includes("悬空") && f.detail.includes("@matter/other")))
      ok("端到端：点目录不进语料（不因 @matter/hidden 多报一条）", !(r.findings ?? []).some((f) => f.detail.includes("@matter/hidden")))
      ok("端到端：node_modules 不进语料", !(r.findings ?? []).some((f) => f.detail.includes("@matter/nm-pkg")))
      ok(
        "端到端：带注释的 JSONC 解析成功（`// 只配了别的包…` 那行没把 parser 炸掉）",
        r.status === "failed" /* 到这里即证明解析没走 JSON.parse 直接抛 */ && !(r.detail ?? "").includes("unjudged"),
      )

      // 任务书验收 1 的第二段：补上键 ⇒ 同一棵树立刻绿
      write(
        "tsconfig.base.emit.json",
        emitBase(
          `      "@matter/other": ["./packages/other/other/src/index.ts"],\n      "@matter/test-pkg": ["./packages/test-group/test-pkg/src/index.ts"],\n`,
        ),
      )
      // @matter/other 悬空 ⇒ 先把「other」包也造出来，让这一跳只验证「补键 ⇒ 绿」
      write("packages/other/other/package.json", pkgManifest("@matter/other"))
      const green = readPaths(root)
      ok("端到端：补上 paths 键 ⇒ 绿变红再变绿（红绿对照的后半）", green.status === "passed", JSON.stringify(green.findings))
      ok("端到端：绿 detail 数出 2 个包", (green.detail ?? "").includes("2 个包"))

      // 任务书验收 1 的第三段：悬空键 ⇒ 红
      write(
        "tsconfig.base.emit.json",
        emitBase(
          `      "@matter/other": ["./packages/other/other/src/index.ts"],\n      "@matter/test-pkg": ["./packages/test-group/test-pkg/src/index.ts"],\n      "@matter/ghost": ["./packages/ghost/ghost/src/index.ts"],\n`,
        ),
      )
      const dang = readPaths(root)
      ok("端到端：悬空键 ⇒ 红", dang.status === "failed")
      ok(
        "端到端：悬空文案含键名 + 期望 + 实际",
        (dang.findings ?? []).some((f) => f.file === "tsconfig.base.emit.json" && f.detail.includes("@matter/ghost") && f.detail.includes("悬空")),
        JSON.stringify(dang.findings),
      )

      // 坏 manifest（JSON 坏）⇒ 按红不静默（发现器看见了包，name 取不出）
      write("packages/broken/bp/package.json", "{ this is not json ")
      const badManifest = readPaths(root)
      ok("坏 manifest ⇒ 红（不静默跳过那一支）", badManifest.status === "failed" && (badManifest.findings ?? []).some((f) => f.file === "packages/broken/bp/package.json"), JSON.stringify(badManifest.findings))

      // 组目录带 manifest ⇒ 不参与对账（组目录不是包；组目录禁 manifest 归 verify-plugin-shape 管）
      write("packages/group-manifest/package.json", pkgManifest("@matter/group-is-not-a-pkg"))
      const groupCase = readPaths(root)
      ok("组目录 manifest 不进对账（不报 @matter/group-is-not-a-pkg）", !(groupCase.findings ?? []).some((f) => f.detail.includes("@matter/group-is-not-a-pkg")))

      // 坏 JSONC（emit.json 语法坏）⇒ 按红处理，不静默、不冒充绿
      write("tsconfig.base.emit.json", "{ this is not json ")
      const bad = readPaths(root)
      ok("坏 JSONC ⇒ failed（不静默跳过、不冒充绿）", bad.status === "failed", JSON.stringify(bad.findings))
      ok("坏 JSONC：文案点名 JSONC 解析失败", (bad.findings ?? []).some((f) => f.detail.includes("JSONC")))

      // compilerOptions.paths 写成数组（配置坏）⇒ 红
      write("tsconfig.base.emit.json", `{\n  "compilerOptions": { "paths": ["@matter/a"] }\n}\n`)
      const badShape = readPaths(root)
      ok("paths 不是对象（数组）⇒ 红，文案说清实际形态", badShape.status === "failed" && (badShape.findings ?? []).some((f) => f.detail.includes("数组")), JSON.stringify(badShape.findings))

      // compilerOptions.paths 整个缺席 + 包语料满 ⇒ 判红不判 unjudged（对账可执行，结论是全漏配）
      write("tsconfig.base.emit.json", `{\n  "compilerOptions": { "noEmit": false }\n}\n`)
      const noPaths = readPaths(root)
      ok("paths 表缺席 + 包语料满 ⇒ 红（每包一条漏配，不是 unjudged）", noPaths.status === "failed", JSON.stringify(noPaths.findings))

      // emit 基座缺席 ⇒ unjudged（对账一侧没有）
      fs.rmSync(path.join(root, "tsconfig.base.emit.json"))
      const noEmit = readPaths(root)
      ok("emit 基座缺席 ⇒ unjudged（不是 passed）", noEmit.status === "unjudged")
      ok("emit 基座缺席：理由码 no-corpus", noEmit.reason === "no-corpus")

      // 语料归零（真实 IO）：0 个包 ⇒ unjudged（钉住验收 2 的机器形态）
      write("tsconfig.base.emit.json", emitBase(`      "@matter/ghost": ["./packages/ghost/ghost/src/index.ts"],\n`))
      for (const rel of ["packages/test-group", "packages/other", "packages/broken", "packages/group-manifest"]) {
        fs.rmSync(path.join(root, rel), { recursive: true, force: true })
      }
      const empty = readPaths(root)
      ok("真实 IO 语料归零（0 个包）⇒ unjudged（不是 passed）", empty.status === "unjudged")
      ok("真实 IO 语料归零：理由码 no-corpus", empty.reason === "no-corpus")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立（共 ${total} 条断言）`
      : `✓ spec 全过（${total} 条断言：纯函数两方向 + 隔离 + 语料坏 + 语料归零 unjudged + 反向控制 + 真实 IO 造包/补键/悬空/坏语料/坏 JSONC/基座缺席 + 红绿对照）`,
  )
  return fails === 0
}
