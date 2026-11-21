/**
 * `verify-node-next-types` 的 spec（ISS-882）。
 *
 * 载体：本仓口径 —— **`export function run()` + `--selftest`**（gate-runtime.ts:104-126），
 * 非 bun describe/it。`bun test --isolate` 本仓跑 0 pass/0 fail，权威执行是 `--selftest`。
 *
 * ## 覆盖（任务书五场景）
 *
 * ① 相对 specifier 无扩展名必红（预检，带 文件:行）— 修复⇒绿
 * ② 构造好产物 + 外部工程编译通过⇒绿
 * ③ 产物缺失⇒unjudged(no-build)
 * ④ no-binary（无 typescript）/ no-corpus（0 包 / 0 specifier）⇒unjudged
 * ⑤ 变异公开 .d.ts（语法错误）⇒外部编译失败红 — 还原⇒绿
 *
 * 另：workspacePackages/publicSpecifiers/relativeSpecifiersMissingExtensions/missingOutputs
 * 的纯函数单测；三态输出形态核对。
 *
 * ⛔ 反例必须点名哪一行、哪个 specifier、期望/实际，不只断 status === "failed"。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  collect,
  compileExternal,
  consumerTsconfig,
  hasTsc,
  judgeNextTypes,
  missingOutputs,
  publicSpecifiers,
  readPackage,
  relativeSpecifiersMissingExtensions,
  workspacePackages,
  TSC_BIN,
} from "./verify-node-next-types.ts"
import type { GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")

let fails = 0
let okCount = 0
const ok = (name: string, cond: boolean, extra = ""): void => {
  okCount++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` —— 实际：${extra}`}`)
  if (!cond) fails++
}

interface FixtureSpec {
  name: string
  /** 完整 d.ts 文本；null = 声明了 types 但不产出文件（缺产物）。 */
  dts: string | null
  /** exports 子路径（可选）。 */
  subpath?: string
  /** package.json 是否不写 types/exports（测 0 specifier）。 */
  noPublic?: boolean
}

interface Fixture {
  root: string
  pkgDirs: Map<string, string>
}

/**
 * 造一个仓库形态的临时根：packages/<g>/<p>/package.json + lib/types/index.d.ts；
 * node_modules/typescript 与 @types/node 软链到真实仓库（复用 tsc 与 node 类型，零拷贝）。
 */
function makeFixture(specs: readonly FixtureSpec[]): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nnt-fixture-"))
  const pkgDirs = new Map<string, string>()
  const nodeModules = path.join(root, "node_modules")
  fs.mkdirSync(nodeModules, { recursive: true })
  // 软链 typescript 可执行目录（hasTsc + compileExternal 都从 root/node_modules/typescript 取）
  fs.symlinkSync(path.join(REPO, "node_modules", "typescript"), path.join(nodeModules, "typescript"), "dir")
  const realTypesNode = path.join(REPO, "node_modules", "@types", "node")
  if (fs.existsSync(realTypesNode)) {
    fs.mkdirSync(path.join(nodeModules, "@types"), { recursive: true })
    fs.symlinkSync(realTypesNode, path.join(nodeModules, "@types", "node"), "dir")
  }
  specs.forEach((s, i) => {
    const dir = path.join(root, "packages", "g" + i, "p" + i)
    fs.mkdirSync(path.join(dir, "lib", "types"), { recursive: true })
    const manifest: Record<string, unknown> = { name: s.name, type: "module" }
    if (!s.noPublic) {
      manifest.types = "./lib/types/index.d.ts"
      manifest.exports = s.subpath
        ? { ".": { types: "./lib/types/index.d.ts" }, ["./" + s.subpath]: { types: "./lib/types/" + s.subpath + ".d.ts" } }
        : { ".": { types: "./lib/types/index.d.ts" } }
    }
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
    if (s.dts !== null) {
      fs.writeFileSync(path.join(dir, "lib", "types", "index.d.ts"), s.dts)
      if (s.subpath) fs.writeFileSync(path.join(dir, "lib", "types", s.subpath + ".d.ts"), "export declare const sub: string;\n")
    }
    pkgDirs.set(s.name, dir)
  })
  return { root, pkgDirs }
}

function rmFixture(f: Fixture): void {
  fs.rmSync(f.root, { recursive: true, force: true })
}

const cleanDts = "export declare const answer: number;\n"
const hasFinding = (r: GateResult, ...needles: string[]): boolean =>
  (r.findings ?? []).some((f) => needles.every((n) => (f.detail ?? "").includes(n)))

export function run(): boolean {
  fails = 0
  okCount = 0
  console.log("verify-node-next-types.spec")

  /* ── ⓪ 纯函数单测 ─────────────────────────────────────────────── */

  {
    const f = makeFixture([
      { name: "@matter/alpha", dts: cleanDts },
      { name: "@matter/beta", dts: cleanDts, subpath: "extra" },
    ])
    try {
      const pkgs = workspacePackages(f.root)
      ok("workspacePackages：扫到 2 个包", pkgs.length === 2, `实际 ${pkgs.length}`)
      ok("workspacePackages：按 name 排序", pkgs[0]?.name === "@matter/alpha" && pkgs[1]?.name === "@matter/beta", pkgs.map((p) => p.name).join(","))
      const alpha = pkgs.find((p) => p.name === "@matter/alpha")!
      const beta = pkgs.find((p) => p.name === "@matter/beta")!
      ok("publicSpecifiers：types 字段给包名", publicSpecifiers(alpha).join(",") === "@matter/alpha", publicSpecifiers(alpha).join(","))
      ok("publicSpecifiers：exports[.].types 去重不重复", publicSpecifiers(alpha).length === 1)
      ok("publicSpecifiers：子路径 exports.types 展开为 name/subpath", publicSpecifiers(beta).join(",") === "@matter/beta,@matter/beta/extra", publicSpecifiers(beta).join(","))
      ok("missingOutputs：产物齐时为空", missingOutputs(pkgs, f.root).length === 0)
      const rp = readPackage(path.join(f.root, "packages/g0/p0/package.json"))
      ok("readPackage：读 name 正确", rp?.name === "@matter/alpha", rp?.name)
    } finally {
      rmFixture(f)
    }
  }

  {
    const f = makeFixture([{ name: "@matter/only", dts: null }])
    try {
      const pkgs = workspacePackages(f.root)
      const miss = missingOutputs(pkgs, f.root)
      ok("missingOutputs：缺产物报包名+路径", miss.length === 1 && miss[0]!.includes("@matter/only") && miss[0]!.includes("lib/types/index.d.ts"), miss.join("|"))
    } finally {
      rmFixture(f)
    }
  }

  {
    // 预检正则：from / import() / import / declare module 四种形态都抓；带 .js 不报。
    const f = makeFixture([{ name: "@matter/alpha", dts: "export {};\n" }])
    try {
      const dir = f.pkgDirs.get("@matter/alpha")!
      const dts = path.join(dir, "lib", "types", "index.d.ts")
      fs.writeFileSync(dts, [
        "export declare const a: number;",
        "export { b } from \"./b\";",
        "export type C = import(\"./c\").C;",
        "declare module \"./d\" {}",
      ].join("\n") + "\n")
      const bad = relativeSpecifiersMissingExtensions(f.root)
      ok("预检：三种无扩展名相对 specifier 全抓", bad.length === 3, JSON.stringify(bad))
      ok("预检：带 文件:行", bad.every((b) => b.file.includes("index.d.ts") && b.line >= 1), JSON.stringify(bad))
      fs.writeFileSync(dts, [
        "export declare const a: number;",
        "export { b } from \"./b.js\";",
        "export type C = import(\"./c.js\").C;",
        "declare module \"./d.js\" {}",
      ].join("\n") + "\n")
      ok("预检：补 .js 扩展名后不报", relativeSpecifiersMissingExtensions(f.root).length === 0)
    } finally {
      rmFixture(f)
    }
  }

  /* ── ② 构造好产物 + 外部工程编译通过 ⇒ 绿 ────────────────────── */

  {
    const f = makeFixture([
      { name: "@matter/alpha", dts: cleanDts },
      { name: "@matter/beta", dts: "export interface Widget { id: number }\nexport declare function make(): Widget;\n", subpath: "extra" },
    ])
    try {
      const input = collect(f.root)
      ok("绿路径：hasTs 真（软链 typescript 可解析）", input.hasTs === true)
      ok("绿路径：无缺产物", input.missing.length === 0, input.missing.join("|"))
      ok("绿路径：无无扩展名预检错", input.badSpecifiers.length === 0, JSON.stringify(input.badSpecifiers))
      ok("绿路径：外部编译执行了", input.compile !== null)
      ok("绿路径：外部编译通过", input.compile?.ok === true, input.compile?.output?.slice(0, 200) ?? "")
      const r = judgeNextTypes(input)
      ok("绿路径：判绿", r.status === "passed", `${r.status} ${r.reason ?? ""}`)
      ok("绿路径：detail 点名包数", (r.detail ?? "").includes("2 个包"), r.detail)
    } finally {
      rmFixture(f)
    }
  }

  /* ── ① 相对 specifier 无扩展名 ⇒ 红（带 文件:行），修复⇒绿 ──── */

  {
    const f = makeFixture([{ name: "@matter/alpha", dts: null }])
    try {
      const dir = f.pkgDirs.get("@matter/alpha")!
      const dts = path.join(dir, "lib", "types", "index.d.ts")
      // 注入：第 3 行有无扩展名相对 specifier
      fs.writeFileSync(dts, `export declare const a: number;\nexport declare const b: number;\nexport { c } from "./c";\n`)
      const input = collect(f.root)
      const r = judgeNextTypes(input)
      ok("无扩展名：判红", r.status === "failed", r.status)
      ok("无扩展名：finding 带 文件", (r.findings ?? []).some((x) => (x.file ?? "").includes("index.d.ts")), JSON.stringify(r.findings))
      ok("无扩展名：finding 带行号 3", (r.findings ?? []).some((x) => x.line === 3), JSON.stringify(r.findings?.map((x) => x.line)))
      ok("无扩展名：判词点名 specifier 与期望", hasFinding(r, "./c", "补 .js 扩展名"), JSON.stringify(r.findings))
      // 修复：补扩展名 + 造目标文件
      fs.writeFileSync(dts, `export declare const a: number;\nexport declare const b: number;\nexport { c } from "./c.js";\n`)
      fs.writeFileSync(path.join(dir, "lib", "types", "c.d.ts"), "export declare const c: number;\n")
      const fixed = judgeNextTypes(collect(f.root))
      ok("无扩展名：修复后⇒绿", fixed.status === "passed", `${fixed.status} ${fixed.reason ?? ""}`)
    } finally {
      rmFixture(f)
    }
  }

  /* ── ③ 产物缺失 ⇒ unjudged(no-build) ─────────────────────────── */

  {
    const f = makeFixture([{ name: "@matter/alpha", dts: null }])
    try {
      const input = collect(f.root)
      ok("产物缺失：missing 有 1 条", input.missing.length === 1, input.missing.join("|"))
      ok("产物缺失：没跑外部编译", input.compile === null)
      const r = judgeNextTypes(input)
      ok("产物缺失：判不了", r.status === "unjudged", r.status)
      ok("产物缺失：理由码 no-build", r.reason === "no-build", String(r.reason))
      ok("产物缺失：判词点名先 build 且明确不冒绿不判红", (r.detail ?? "").includes("pnpm run build") && (r.detail ?? "").includes("不冒绿"), r.detail ?? "")
    } finally {
      rmFixture(f)
    }
  }

  /* ── ④ no-binary / no-corpus ⇒ unjudged ──────────────────────── */

  {
    const f = makeFixture([{ name: "@matter/alpha", dts: cleanDts }])
    try {
      // 移除 typescript 软链 ⇒ no-binary
      fs.rmSync(path.join(f.root, "node_modules", "typescript"), { force: true })
      ok("no-binary：hasTsc 假", hasTsc(f.root) === false)
      const r = judgeNextTypes(collect(f.root))
      ok("no-binary：判不了", r.status === "unjudged", r.status)
      ok("no-binary：理由码 no-binary", r.reason === "no-binary", String(r.reason))
    } finally {
      rmFixture(f)
    }
  }
  {
    const f = makeFixture([]) // 0 包
    try {
      const r = judgeNextTypes(collect(f.root))
      ok("no-corpus：0 包⇒判不了", r.status === "unjudged" && r.reason === "no-corpus", `${r.status}/${r.reason}`)
    } finally {
      rmFixture(f)
    }
  }
  {
    const f = makeFixture([{ name: "@matter/only", dts: cleanDts, noPublic: true }]) // 0 specifier
    try {
      const pkgs = workspacePackages(f.root)
      ok("no-corpus：0 specifier 输入构造成功", pkgs.length === 1 && publicSpecifiers(pkgs[0]!).length === 0)
      const r = judgeNextTypes(collect(f.root))
      ok("no-corpus：0 specifier⇒判不了", r.status === "unjudged" && r.reason === "no-corpus", `${r.status}/${r.reason}`)
    } finally {
      rmFixture(f)
    }
  }

  /* ── ⑤ 变异公开 .d.ts（语法错误）⇒外部编译失败红，还原⇒绿 ──── */

  {
    const f = makeFixture([{ name: "@matter/alpha", dts: cleanDts }])
    try {
      const dir = f.pkgDirs.get("@matter/alpha")!
      const dts = path.join(dir, "lib", "types", "index.d.ts")
      const green = judgeNextTypes(collect(f.root))
      ok("变异前：好产物⇒绿", green.status === "passed", green.status)
      fs.writeFileSync(dts, "export declare const answer: = ;\n")
      const compile = compileExternal(workspacePackages(f.root), f.root)
      ok("变异：外部编译失败（tsc 出口非 0）", compile.ok === false, compile.output.slice(0, 120))
      ok("变异：编译输出含 TS 错误码", /TS\d+/.test(compile.output), compile.output.slice(0, 120))
      const r = judgeNextTypes(collect(f.root))
      ok("变异：判红", r.status === "failed", r.status)
      ok("变异：判词点名外部编译失败", hasFinding(r, "外部 NodeNext 工程编译失败"), JSON.stringify(r.findings))
      // 还原
      fs.writeFileSync(dts, cleanDts)
      const restored = judgeNextTypes(collect(f.root))
      ok("变异：还原后⇒绿（红来源只可能是那处变异）", restored.status === "passed", `${restored.status} ${restored.reason ?? ""}`)
    } finally {
      rmFixture(f)
    }
  }

  /* ── ⑥ consumerTsconfig 口径核对（NodeNext 严格解析） ───────── */

  {
    const cfg = consumerTsconfig() as { compilerOptions: Record<string, unknown> }
    ok("tsconfig：module=NodeNext", cfg.compilerOptions.module === "NodeNext")
    ok("tsconfig：moduleResolution=NodeNext", cfg.compilerOptions.moduleResolution === "NodeNext")
    ok("tsconfig：strict=true", cfg.compilerOptions.strict === true)
    ok("tsconfig：skipLibCheck=true（第三方 lib noise 不遮回归）", cfg.compilerOptions.skipLibCheck === true)
    ok("tsconfig：preserveSymlinks=true（软链包按自身位置解析）", cfg.compilerOptions.preserveSymlinks === true)
    ok("tsconfig：noEmit=true", cfg.compilerOptions.noEmit === true)
    ok("TSC_BIN 路径指向 node 可执行的 JS 入口", TSC_BIN.endsWith("typescript/bin/tsc"))
  }

  /* ── ⑦ 真树形态自洽（未 build ⇒ no-build / 已 build ⇒ 判得出结论） ── */

  {
    // ⚠️ 不把「本树未 build」当前提（ISS-899 清债）：iss-flow 要求本地工单树 install+build，
    //    而 CI 的 gateselfcheck lane 不 build——同一用例在两种环境必须都成立，写死任何一侧
    //    都会随环境变色。no-build 行为本身已由 ⑤（fixture 级构造语料）钉死；这里验的是判据
    //    在真语料上形态自洽：产物缺 ⇒ unjudged(no-build) 不冒绿不判红；产物在 ⇒ 必须判得出
    //    结论（passed/failed），不是判不了。
    const input = collect(REPO)
    const r = judgeNextTypes(input)
    ok(
      "真树：形态自洽（未 build ⇒ no-build 不冒绿；已 build ⇒ 判得出结论不判不了）",
      input.missing.length > 0
        ? r.status === "unjudged" && r.reason === "no-build"
        : r.status === "passed" || r.status === "failed",
      `${r.status}/${r.reason}（missing=${input.missing.length}）`,
    )
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立（共 ${okCount}）`
      : `✓ spec 全过（${okCount} 条断言：纯函数 + 绿路径 + 无扩展名红/修复绿 + 产物缺失 unjudged + no-binary/no-corpus unjudged + 变异红/还原绿 + tsconfig 口径 + 真树形态）`,
  )
  return fails === 0
}
