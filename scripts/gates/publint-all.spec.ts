/**
 * `publint-all` 的 spec（ISS-822）。
 *
 * 四类用例：正例 / 反例（每条规则各一）/ 干扰（浏览器产物豁免的**双侧**）/ 缺输入。
 *
 * ⚠️ 关键的一条是「干扰」那组：浏览器产物豁免必须**两侧都验** —— 造一个真浏览器产物
 * （该放过）与一个同名但真是 Node CJS 的文件（**必须红**）。只验前者等于没有豁免的反向对照，
 * 而官方 `publint-browser-format.ts` 的注释原话就是 "a Node Client entry must never be exempt"。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Message } from "publint"
import {
  BROWSER_LOADER_MARKER,
  declaresDistTarget,
  isBrowserBundleFalsePositive,
  judgePublint,
  lintPackage,
  looksUnbuilt,
  packView,
  publicationPaths,
  walkFiles,
  type PackageResult,
  type PackedFile,
} from "./publint-all.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

/** 造一棵最小包树：`files` = { 包内相对路径: 内容 }。 */
function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publint-all-"))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return dir
}

const clean: PackageResult[] = []

export async function run(): Promise<boolean> {
  fails = 0
  console.log("publint-all.spec")

  // ── 正例：`files[]` 覆盖到的都进发布视图 ────────────────────────────
  {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", files: ["lib"], main: "lib/index.js" }),
      "lib/index.js": "export const a = 1",
      "extra.js": "export const b = 2",
    })
    const paths = publicationPaths(dir, JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")))
    ok("正例：`files:['lib']` ⇒ lib/ 下的文件进视图", paths.includes("lib/index.js"))
    ok("正例：`package.json` 恒进视图", paths.includes("package.json"))
    ok("反例：`files` 之外的兄弟文件不进视图（extra.js）", !paths.includes("extra.js"))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 反例：没有 `files[]` ⇒ 整目录（npm 缺省行为） ────────────────────
  {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0" }),
      "a.js": "",
      "sub/b.js": "",
      "node_modules/dep/index.js": "",
    })
    const paths = publicationPaths(dir, JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")))
    ok("反例：无 `files[]` ⇒ 整目录都在视图里", paths.includes("a.js") && paths.includes("sub/b.js"))
    ok("干扰：`node_modules/` 永远不进视图（不是包内容）", !paths.some((p) => p.startsWith("node_modules/")))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 反例：`main` 指向的文件 npm 恒收，与 `files[]` 无关 ─────────────
  {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", files: ["lib"], main: "entry/m.js" }),
      "lib/x.js": "",
      "entry/m.js": "",
    })
    const paths = publicationPaths(dir, JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")))
    ok("反例：`main` 在 `files[]` 之外仍进视图（npm 恒收）", paths.includes("entry/m.js"))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 反例：`README*` / `LICENSE*` / `LICENCE*` 恒收 ──────────────────
  {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", files: ["lib"] }),
      "lib/x.js": "",
      "README.zh.md": "",
      "LICENCE": "",
      "CHANGELOG.md": "",
    })
    const paths = publicationPaths(dir, JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")))
    ok("反例：`README.zh.md` 与 `LICENCE` 恒收（不是只有 README/LICENSE）", paths.includes("README.zh.md") && paths.includes("LICENCE"))
    ok("干扰：`CHANGELOG.md` **不**恒收（npm pack 实测不在无 files 声明的清单里）", !paths.includes("CHANGELOG.md"))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 工具函数：walkFiles 的路径拼接不许串味（本单实测的真 bug） ──────
  {
    const dir = fixture({ "a.js": "", "sub/b.js": "", "sub/deep/c.js": "" })
    const got = walkFiles(dir).sort()
    ok("walkFiles：嵌套路径各算各的（回归：曾把兄弟路径拼成一长串）", JSON.stringify(got) === JSON.stringify(["a.js", "sub/b.js", "sub/deep/c.js"]))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 判据纯函数：正例 / 反例 / 缺输入 ───────────────────────────────
  {
    const r = judgePublint([{ path: "forge-a", messages: [] }])
    ok("正例：无 error ⇒ passed", r.status === "passed")
  }
  {
    const r = judgePublint([
      { path: "forge-a", messages: [] },
      { path: "forge-b", messages: [{ type: "error", text: "pkg.exports[\".\"].default is ./nope.js but the file does not exist." }] },
    ])
    ok("反例：有 error ⇒ failed", r.status === "failed")
    ok("反例：finding 指名包名（不是「有 1 条红」）", r.findings?.[0]?.file === "forge-b")
  }
  {
    const r = judgePublint([{ path: "forge-a", messages: [{ type: "warning", text: "w" }, { type: "suggestion", text: "s" }] }])
    ok("干扰：只有 warning/suggestion ⇒ 仍 passed（与官方同口径）", r.status === "passed")
    ok("干扰：非阻断提示数写进 detail（不静默吞）", (r.detail ?? "").includes("2 条"))
  }
  {
    const r = judgePublint([{ path: "forge-a", messages: [], failure: "boom" }])
    ok("反例：publint 自己抛错 ⇒ failed（不许当「没问题」）", r.status === "failed")
  }
  {
    const r = judgePublint(clean)
    ok("缺输入：语料为空 ⇒ unjudged（不是绿）", r.status === "unjudged" && r.reason === "no-corpus")
  }

  // ── 浏览器产物豁免：**两侧都验**（本 spec 最要紧的一组） ─────────────
  {
    const browserFile: PackedFile = { name: "package/dist/client.js", data: Buffer.from(`${BROWSER_LOADER_MARKER}{ id: "x" }`) }
    const nodeCjsFile: PackedFile = { name: "package/dist/client.js", data: Buffer.from("module.exports = { a: 1 }") }
    const msg = {
      code: "FILE_INVALID_FORMAT",
      type: "warning",
      path: ["exports", "./client", "default"],
      args: { actualFilePath: "./dist/client.js", actualFormat: "CJS", expectFormat: "ESM", actualExtension: ".js", expectExtension: ".cjs" },
    } as Message

    ok("正例：`dist/client.js` + loader 标记 ⇒ 豁免（浏览器产物，不是 Node 模块）", isBrowserBundleFalsePositive(msg, [browserFile]))
    ok("反例：同路径但内容是 Node CJS ⇒ **不豁免**（官方口径：Node 入口永不免）", !isBrowserBundleFalsePositive(msg, [nodeCjsFile]))
    ok("反例：别的 code 即使路径对上也不豁免（只放行 FILE_INVALID_FORMAT）", !isBrowserBundleFalsePositive({ ...msg, code: "FILE_DOES_NOT_EXIST" } as Message, [browserFile]))
    ok("反例：`lib/client.js` 这个官方路径在本仓**不**自动豁免（我们的浏览器半在 dist/）", !isBrowserBundleFalsePositive(
      { ...msg, args: { ...msg.args, actualFilePath: "./lib/client.js" } } as Message,
      [{ name: "package/lib/client.js", data: Buffer.from(`${BROWSER_LOADER_MARKER}{}`) }],
    ))
  }

  // ── 端到端：真包树上 `packView` 的清单里有 package.json 且非空 ──────
  {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", files: ["lib"], exports: { ".": "./lib/index.js" } }),
      "lib/index.js": "export const a = 1",
    })
    const packed = packView(dir, JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")))
    ok("正例：`packView` 把文件名加 `package/` 前缀（publint 的虚拟 FS 形态）", packed.some((f) => f.name === "package/lib/index.js"))
    ok("正例：`packView` 装的是文件**内容**不是路径", packed.find((f) => f.name === "package/lib/index.js")?.data.toString("utf8") === "export const a = 1")
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 端到端反例：exports 指向不存在的文件 ⇒ 真红（证明接了 publint 的牙） ──
  {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", files: ["lib"], exports: { ".": "./lib/nope.js" } }),
      "lib/index.js": "export const a = 1",
    })
    const res = await lintPackage(dir)
    ok("反例端到端：`exports` 指向不存在的文件 ⇒ 该包报 error",
      res.messages.some((m) => m.type === "error" && m.text.includes("does not exist")))
    ok("反例端到端：错误文本指名 `exports[\".\"]`（可定位到字段）", res.messages.some((m) => m.text.includes('exports["."]')))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 端到端正例：exports 指向存在且已发布的文件 ⇒ 该包零 error ────────
  {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", type: "module", files: ["lib"], exports: { ".": "./lib/index.js" } }),
      "lib/index.js": "export const a = 1",
    })
    const res = await lintPackage(dir)
    ok("正例端到端：exports 指得上的包 ⇒ 零 error（证明不是「一律报红」）", res.messages.every((m) => m.type !== "error"))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── 未构建树：`dist/` 不入库 ⇒ 必须 unjudged，不许把「没构建」判成「发布物坏」 ──
  {
    const built = fixture({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", exports: { ".": "./dist/host.js" } }),
      "dist/host.js": "",
    })
    ok("正例：声明 dist 目标且 dist/ 在 ⇒ 不算未构建", looksUnbuilt([built]).length === 0)

    const unbuilt = fixture({
      "package.json": JSON.stringify({ name: "q", version: "1.0.0", exports: { ".": "./dist/host.js" } }),
      "lib/index.js": "",
    })
    ok("反例：声明 dist 目标但 dist/ 不在 ⇒ 判为未构建（否则 16 包假红）", looksUnbuilt([unbuilt]).length === 1)

    const noDistRef = fixture({
      "package.json": JSON.stringify({ name: "r", version: "1.0.0", exports: { ".": "./lib/index.js" } }),
      "lib/index.js": "",
    })
    ok("干扰：清单不指向 dist/ 的包不参与未构建判定（lib 是入库的）", looksUnbuilt([noDistRef]).length === 0)

    ok("工具函数：`declaresDistTarget` 认 exports 里的 dist", declaresDistTarget({ exports: { ".": "./dist/x.js" } }))
    ok("工具函数：`declaresDistTarget` 认 bin 里的 dist（不止 exports/main）", declaresDistTarget({ bin: { c: "./dist/cli.js" } }))
    ok("工具函数：`declaresDistTarget` 不认 lib（lib 入库、与构建无关）", !declaresDistTarget({ exports: { ".": "./lib/x.js" } }))

    for (const d of [built, unbuilt, noDistRef]) fs.rmSync(d, { recursive: true, force: true })
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过")
  return fails === 0
}
