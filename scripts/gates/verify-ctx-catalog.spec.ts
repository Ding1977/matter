/**
 * `verify-ctx-catalog` 的 spec（ISS-862）。
 *
 * 覆盖三件事，缺一条这条判据就没有牙：
 *   ① 正例：生成物与现算一致 ⇒ passed
 *   ② **必然失败**的用例（不是「可能失败」）：手改生成物一个字符、文件缺失、首行文件头被改、
 *      新增包但不重生成 —— 四条各自断言 failed，且红文案里必须点到名
 *   ③ 判不了的用例：扫到 0 个包 ⇒ unjudged（⛔ 不许绿 —— 空表与空表当然一致）
 *
 * 另外验生成器本身的两条不变式：**幂等**（连跑两次字节相同）与**前缀歧义**
 * （`@matter/storage` 会作为 `@matter/storage-journal` 的前缀出现，缺包点名必须按整格判，
 * 不能按子串判）。这两条错起来都是静默的，所以必须钉成断言。
 *
 * 入口是 `--selftest`（`scripts/lib/gate-runtime.ts` 的动态加载约定），不是 vitest。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { firstDiff, judgeCatalog, missingPackages } from "./verify-ctx-catalog.ts"
import { HEADER, OUT_REL, buildCatalog, renderCatalog, scanCtxSurface } from "../gen-ctx-catalog.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

let fails = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && extra ? ` —— ${extra}` : ""}`)
  if (!cond) fails++
}

/** 一份最小可用的生成物样本：只为了让断言读得懂，不冒充真语料。 */
const EXPECTED = [
  HEADER,
  "",
  "# ctx catalog（生成物，勿手改）",
  "",
  "包 2 个 · ctx 键 2 条 · 事件 0 条。",
  "",
  "## 包清单",
  "",
  "| 包名 | ctx key | 类角色 | 单复数 |",
  "|---|---|---|---|",
  "| `@matter/storage` | `ctx.storage` | Service 子类 `Storage` | 单 |",
  "| `@matter/storage-journal` | `ctx.journal` | 插件（`apply`） | 单 |",
  "",
].join("\n")

export function run(): boolean {
  fails = 0
  console.log("verify-ctx-catalog.spec")

  // ── ① 正例 ──────────────────────────────────────────────
  {
    const r = judgeCatalog({ actual: EXPECTED, expected: EXPECTED, packageCount: 2 })
    ok("正例：生成物与现算一致 ⇒ passed", r.status === "passed", `实际 ${r.status}`)
  }

  // ── ② 必然失败的用例（各造一个真红） ─────────────────────
  {
    // 变异一：手改生成物一个字符。这是本单的**验收判据**本身 —— 判据抓不住它就没有意义。
    const tampered = EXPECTED.replace("ctx.storage`", "ctx.storage-`")
    const r = judgeCatalog({ actual: tampered, expected: EXPECTED, packageCount: 2 })
    const detail = (r.findings ?? []).map((f) => f.detail).join(" ")
    ok("变异①：手改一个字符 ⇒ failed", r.status === "failed", `实际 ${r.status}`)
    ok("变异①：点名文件与行号", (r.findings ?? []).some((f) => f.file === OUT_REL && typeof f.line === "number"))
    ok("变异①：文案给出「怎么改」的命令", detail.includes("node scripts/gen-ctx-catalog.ts"))
    ok("变异①：文案同时给期望与实际", detail.includes("期望") && detail.includes("实际"))
  }

  {
    // 变异二：文件不存在。⛔ 不许因为「没有文件就没有不一致」而判绿。
    const r = judgeCatalog({ actual: null, expected: EXPECTED, packageCount: 2 })
    ok("变异②：生成物缺失 ⇒ failed", r.status === "failed", `实际 ${r.status}`)
    ok("变异②：文案指向重生成命令", (r.findings ?? []).some((f) => f.detail.includes("node scripts/gen-ctx-catalog.ts")))
  }

  {
    // 变异三：首行文件头被换成别的（常见形态：有人把生成物当普通 md 摘要加了一句）。
    const noHeader = EXPECTED.replace(HEADER, "<!-- 我手写的文件头 -->")
    const r = judgeCatalog({ actual: noHeader, expected: EXPECTED, packageCount: 2 })
    ok("变异③：文件头被改 ⇒ failed", r.status === "failed", `实际 ${r.status}`)
    ok("变异③：文案点出首行文件头", (r.findings ?? []).some((f) => f.detail.includes("首行不是生成器文件头")))
  }

  {
    // 变异四：反向变异 —— 新增一个包但不跑生成器。这是**失败驱动**机制的正面用例：
    // 源码变了、生成物没变，判据必须红且点名缺哪个包。
    const newPkg = EXPECTED.replace(
      "| `@matter/storage-journal` | `ctx.journal` | 插件（`apply`） | 单 |",
      [
        "| `@matter/storage-journal` | `ctx.journal` | 插件（`apply`） | 单 |",
        "| `@matter/blocks` | `ctx.blocks` | 插件（`apply`） | 单 |",
      ].join("\n"),
    )
    const r = judgeCatalog({ actual: EXPECTED, expected: newPkg, packageCount: 3 })
    const detail = (r.findings ?? []).map((f) => f.detail).join(" ")
    ok("变异④：新增包未重生成 ⇒ failed", r.status === "failed", `实际 ${r.status}`)
    ok("变异④：点名缺的那个包", detail.includes("@matter/blocks"), detail)
  }

  {
    // 前缀歧义（ISS-515 教训）：`@matter/storage` 是 `@matter/storage-journal` 的前缀。
    // `@matter/storage` 在、journal 缺 ⇒ 必须报 journal 缺，**不许**因为子串命中判成两个都在。
    const partial = EXPECTED.split("\n").filter((l) => !l.startsWith("| `@matter/storage-journal`")).join("\n")
    const missing = missingPackages(partial, EXPECTED)
    ok("前缀歧义：只缺 journal 时点名 journal", missing.length === 1 && missing[0] === "@matter/storage-journal", JSON.stringify(missing))
    ok("前缀歧义：不把 storage 误报成缺", !missing.includes("@matter/storage"), JSON.stringify(missing))
  }

  // ── ③ 判不了（不是绿） ──────────────────────────────────
  {
    const r = judgeCatalog({ actual: "", expected: "", packageCount: 0 })
    ok("0 个包 ⇒ unjudged（不许绿）", r.status === "unjudged" && r.reason === "no-corpus", `实际 ${r.status}/${r.reason}`)
  }

  // ── firstDiff 的边界 ────────────────────────────────────
  {
    ok("firstDiff：相同 ⇒ null", firstDiff("a\nb", "a\nb") === null)
    const d = firstDiff("a\nX", "a\nY")
    ok("firstDiff：报第一处不同的行号", d?.line === 2, JSON.stringify(d))
    const longer = firstDiff("a", "a\nb")
    ok("firstDiff：多出来的行也算不同", longer?.line === 2 && longer.expected === "b", JSON.stringify(longer))
  }

  // ── 生成器本身的不变式（真语料上跑） ─────────────────────
  {
    const once = buildCatalog(REPO) as string
    const twice = buildCatalog(REPO) as string
    ok("生成器幂等：连算两次字节相同", once === twice)
    ok("生成器：首行是逐字文件头", once.startsWith(`${HEADER}\n`), once.split("\n")[0])

    const surface = scanCtxSurface(REPO) as { packages?: { name: string }[] }
    const n = surface.packages?.length ?? 0
    ok("生成器：扫到包（本期语料非空）", n > 0, `扫到 ${n} 个`)
    ok("生成器：包清单按包名排序（幂等的来源）", (() => {
      const names = (surface.packages ?? []).map((p) => p.name)
      return names.every((v, i) => i === 0 || names[i - 1] <= v)
    })())

    // 前缀歧义的真语料形态：两个包都在，且各自的行是**整格**匹配得到的。
    // ⛔ 这条如果按子串实现，`@matter/storage` 会在 journal 那行里也命中 ⇒ 表里两行判成一行。
    const rows = once.split("\n").filter((l) => l.startsWith("| `@matter/"))
    const rowNames = rows.map((l) => /^\|\s*`([^`]+)`/u.exec(l)?.[1])
    ok("真语料：storage 与 storage-journal 各占一行", rowNames.filter((x) => x === "@matter/storage").length === 1 && rowNames.filter((x) => x === "@matter/storage-journal").length === 1, JSON.stringify(rowNames))
  }

  // ── 临时目录上的端到端：真的「源码变了、生成物没变」─────
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-catalog-"))
    try {
      const writePkg = (group: string, name: string, src: string) => {
        const dir = path.join(tmp, "packages", group, name)
        fs.mkdirSync(path.join(dir, "src"), { recursive: true })
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@matter/${name}`, description: "fixture" }))
        fs.writeFileSync(path.join(dir, "src", "index.ts"), src)
      }
      writePkg("storage", "storage", 'declare module "@deepseek-ai/cordis" {\n  interface Context {\n    storage: X\n  }\n}\n')
      const before = buildCatalog(tmp) as string
      ok("端到端：单个包能被扫出 ctx key", before.includes("`ctx.storage`"), before.slice(0, 200))

      // `lib/` 是产物：里面也有一份 `declare module`，必须**不**进表。
      const libDir = path.join(tmp, "packages", "storage", "storage", "lib", "types")
      fs.mkdirSync(libDir, { recursive: true })
      fs.writeFileSync(path.join(libDir, "index.d.ts"), 'declare module "@deepseek-ai/cordis" {\n  interface Context {\n    ghostFromLib: X\n  }\n}\n')
      const withLib = buildCatalog(tmp) as string
      ok("端到端：lib/ 是产物，不进表", withLib === before && !withLib.includes("ghostFromLib"), withLib.includes("ghostFromLib") ? "lib 里的键进了表" : "内容变了")

      // 新增一个包而不重生成 ⇒ 判据必须红，并点名它。
      writePkg("storage", "storage-journal", 'declare module "@deepseek-ai/cordis" {\n  interface Context {\n    journal: X\n  }\n}\n')
      const after = buildCatalog(tmp) as string
      const r = judgeCatalog({ actual: before, expected: after, packageCount: 2 })
      const detail = (r.findings ?? []).map((f) => f.detail).join(" ")
      ok("端到端：新增包未重生成 ⇒ failed", r.status === "failed", `实际 ${r.status}`)
      ok("端到端：点名缺的那个包", detail.includes("@matter/storage-journal"), detail)

      // 空目录 ⇒ 0 个包 ⇒ 判不了（⛔ 不许绿）。
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-empty-"))
      const emptyText = buildCatalog(empty) as string
      const rEmpty = judgeCatalog({ actual: emptyText, expected: emptyText, packageCount: 0 })
      ok("端到端：空仓库 ⇒ unjudged（不许绿）", rEmpty.status === "unjudged", `实际 ${rEmpty.status}`)
      fs.rmSync(empty, { recursive: true, force: true })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  // ── renderCatalog 是纯函数：喂空语料也不抛 ───────────────
  {
    const text = renderCatalog({ packages: [], keyRows: [], eventRows: [] }) as string
    ok("renderCatalog：空语料 ⇒ 仍出完整文件（不抛）", text.startsWith(HEADER) && text.includes("## 包清单"))
    const noSurface = renderCatalog(undefined) as string
    ok("renderCatalog：undefined ⇒ 按空语料处理", noSurface.startsWith(HEADER))
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（正例 / 必然失败×4 / 判不了 / 边界 / 真语料不变式 / 端到端）")
  return fails === 0
}
