/**
 * 静态判据 S1 裸标题禁用 + S2 字号/字重只用档位（ISS-907 / DOC-533 段三）。
 *
 * 形态照 DSH `radius-styles.client.spec.ts`（52 行）四个设计要点：
 *   ① 合法集从真值源动态读（字号档 = theme.css 的 --matter-alias-font-size-*，字重档 = expected json）；
 *   ② 先跑自测正反例，证明判据会红（不是写完就绿的自欺）；
 *   ③ 再全仓扫 apps/web/src + 各 client 包 src；
 *   ④ 例外清单**精确相等**（toEqual，多一条少一条都红），每条带理由。
 *
 * 文件名按本仓 vitest include（各 client 包 tests 下的 .test.ts）取 .test.ts —— DSH 的
 * .client.spec.ts 形态体现在结构与纪律，不体现在后缀（后缀错了会被 run-package-tests 静默漏掉）。
 * 扫描核心在 ./typography-scan.ts；本文件只做判定与举证，不重写扫描逻辑。
 *
 * @module @matter/client-ui-theme/tests/typography
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  cssFindings,
  headingClassRefs,
  headingFindings,
  headingWeightFindings,
  readConfig,
  scanRepo,
  weightTiers,
  type TypographyConfig,
} from "./typography-scan.ts"

const EXCEPTIONS = JSON.parse(
  readFileSync(new URL("./expected/typography-exceptions.json", import.meta.url), "utf8"),
) as {
  s1: Record<string, { code: string; reason: string }>
  s2: Record<string, { code: string; reason: string }>
  s3: Record<string, { code: string; reason: string }>
}

/** 把带理由的例外投影成 finding 映射，供 toEqual 精确对账。 */
function expectedFindings(which: "s1" | "s2" | "s3"): Record<string, string> {
  return Object.fromEntries(Object.entries(EXCEPTIONS[which]).map(([at, e]) => [at, e.code]))
}

const cfg: TypographyConfig = readConfig()

describe("真值源动态读（不写死档位）", () => {
  it("字号档从 theme.css 解析出五档，字重档从 expected json 读出三档", () => {
    expect([...cfg.fontSizes]).toEqual([
      "--matter-alias-font-size-body",
      "--matter-alias-font-size-secondary",
      "--matter-alias-font-size-caption",
      "--matter-alias-font-size-code",
      "--matter-alias-font-size-title",
    ])
    expect([...cfg.weights]).toEqual([400, 500, 600])
  })

  it("从真值源删一档，合法集立刻变小（删了会红才算动态读）", () => {
    const shrunken = weightTiers('{"tiers":[400,500]}')
    expect(shrunken.has(600)).toBe(false)
    expect(shrunken.size).toBe(2)
  })
})

describe("S1 裸标题禁用 · 自测正反例（证明会红）", () => {
  const file = "apps/web/src/_selftest.tsx"

  it("裸 <h2> 红、带 className 的 <h2> 绿", () => {
    expect(headingFindings("const a = <h2>hi</h2>", file)).toEqual({ [`${file}:1`]: "h2" })
    expect(headingFindings("const a = <h2 className={css.title}>hi</h2>", file)).toEqual({})
  })

  it("本仓真实形态：createElement 裸 h2 红、带 className 绿", () => {
    expect(headingFindings('createElement("h2", null, "hi")', file)).toEqual({ [`${file}:1`]: "h2" })
    expect(headingFindings('createElement("h2", { className: css.title }, "hi")', file)).toEqual({})
    expect(headingFindings('React.createElement("h3", null, "hi")', file)).toEqual({ [`${file}:1`]: "h3" })
  })

  it("AST 级：注释与字符串里的 h2 不误伤（正则会误伤，这里不会）", () => {
    const src = '// <h2>comment</h2>\nconst s = "<h2>string</h2>"\n/* createElement("h2", null) */\nconst ok = <h2 className={css.title}>x</h2>'
    expect(headingFindings(src, file)).toEqual({})
  })

  it("每个 h1–h6 都被覆盖", () => {
    const tags = ["h1", "h2", "h3", "h4", "h5", "h6"] as const
    for (const tag of tags) {
      expect(headingFindings(`createElement("${tag}", null, "x")`, file)).toEqual({ [`${file}:1`]: tag })
    }
  })
})

describe("S2 字号/字重只用档位 · 自测正反例（证明会红）", () => {
  const file = "packages/client/ui-theme/src/client/_selftest.module.css"

  it("裸 14px 字号红、已定义字号档绿", () => {
    expect(cssFindings(".x { font-size: 14px }", file, cfg)).toEqual({ [`${file}:1`]: "font-size:14px" })
    expect(cssFindings(".x { font-size: var(--matter-alias-font-size-body) }", file, cfg)).toEqual({})
    expect(cssFindings(".x { font-size: var(--matter-alias-font-size-nope) }", file, cfg)).not.toEqual({})
  })

  it("裸 700 字重红、已定义档绿", () => {
    expect(cssFindings(".x { font-weight: 700 }", file, cfg)).toEqual({ [`${file}:1`]: "font-weight:700" })
    for (const w of [400, 500, 600]) {
      expect(cssFindings(`.x { font-weight: ${w} }`, file, cfg)).toEqual({})
    }
  })

  it("token 定义（--* 自定义属性）不算违规——真值源页不误伤", () => {
    const css = ":root { --matter-static-font-size-body: 14px; --dsh-content-font-size: 14px }"
    expect(cssFindings(css, file, cfg)).toEqual({})
  })
})

describe("S3 h2 类字重显式声明 · 自测正反例（证明会红，ISS-931 reviewer 洞）", () => {
  const ts = [{ rel: "apps/web/src/_s3.tsx", text: 'createElement("h2", { className: css.title }, "hi")' }]

  it("抽得到 h2 的 className 类名", () => {
    expect(headingClassRefs(ts[0]!.text, ts[0]!.rel)).toEqual([{ className: "title", line: 1 }])
  })

  it("CSS 类写了 font-weight ⇒ 绿；没写 ⇒ 红（死代码假象也会被抓）", () => {
    expect(headingWeightFindings(ts, [{ rel: "apps/web/src/_s3.module.css", text: ".title { font-size: 18px; font-weight: 600 }" }])).toEqual({})
    expect(headingWeightFindings(ts, [{ rel: "apps/web/src/_s3.module.css", text: ".title { font-size: 18px }" }])).toEqual({
      "apps/web/src/_s3.tsx:1": ".title 缺 font-weight",
    })
  })

  it("另写一个带 600 的 .columnTitle 但 h2 仍用裸 .title ⇒ 仍红（死代码不冒充修复）", () => {
    const css = ".title { font-size: 18px }\n.columnTitle { font-size: 18px; font-weight: 600 }"
    expect(headingWeightFindings(ts, [{ rel: "apps/web/src/_s3.module.css", text: css }])).toEqual({
      "apps/web/src/_s3.tsx:1": ".title 缺 font-weight",
    })
  })

  it("非 title/column 类不受本判据管（不制造假红）", () => {
    const other = [{ rel: "apps/web/src/_s3.tsx", text: 'createElement("h2", { className: css.sidebarNav }, "hi")' }]
    expect(headingWeightFindings(other, [])).toEqual({})
  })
})

describe("全仓扫 · 例外清单精确相等（多一条少一条都红）", () => {
  it("S1：全仓裸标题 == 例外清单（修完 kb-shell 三处后应恰好相等）", () => {
    expect(scanRepo().s1).toEqual(expectedFindings("s1"))
  })

  it("S2：全仓字号/字重违规 == 例外清单（当前为空）", () => {
    expect(scanRepo().s2).toEqual(expectedFindings("s2"))
  })

  it("S3：全仓 h2 title/column 类缺字重 == 例外清单（当前为空）", () => {
    expect(scanRepo().s3).toEqual(expectedFindings("s3"))
  })

  it("每条例外都有非空理由", () => {
    for (const which of ["s1", "s2", "s3"] as const) {
      for (const [at, entry] of Object.entries(EXCEPTIONS[which])) {
        expect(entry.reason?.trim().length, `例外 ${which} ${at} 必须有理由`).toBeGreaterThan(0)
      }
    }
  })
})
