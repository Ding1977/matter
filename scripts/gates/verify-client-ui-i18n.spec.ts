/**
 * `verify-client-ui-i18n` 的 spec（ISS-531 / W12 雏形判据）。
 *
 * 判据的全部价值在**能判红**：正向「0 裸中文 ⇒ 绿」跑一次就过；必须证明
 * 「有裸中文文案 ⇒ 必红」「走了字典 ⇒ 不红」「豁免生效/失效双向」才有牙。
 *
 * 六类用例：
 *   ① 正例：无中文文案 / 全走字典 ⇒ 绿；
 *   ② 必然失败向量：一条裸中文字面量 ⇒ 红且报 文件:行:文本；
 *   ③ locale 调用白名单：t("中文") / i18n.tr("中文") ⇒ 不算裸文案；
 *   ④ 豁免：存量 ui-theme 21 条 description 不红；删一条豁免 ⇒ 对应文案红（变异有牙）；
 *   ⑤ 缺输入：0 源文件 no-corpus / 无 typescript no-binary ⇒ unjudged（不冒绿）；
 *   ⑥ 真仓：实扫 packages/client/<pkg>/src ⇒ 绿（证明判据接上了真实语料）。
 *
 * @module gates/verify-client-ui-i18n.spec
 */
import {
  CJK_RE,
  EXEMPTIONS,
  collectSources,
  judgeClientI18n,
  loadTs,
} from "./verify-client-ui-i18n.ts"

const REPO = process.cwd()
const ts = loadTs()

let fails = 0
let total = 0
const ok = (name: string, cond: boolean) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

/** 构造扫描输入：源码表 + ts 可用性。 */
const input = (files: Record<string, string>, hasTs = true) => new Map(Object.entries(files))

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-client-ui-i18n.spec")
  if (ts === null) {
    console.log("  ✗ 环境：找不到 typescript，spec 无法运行（判据会退 no-binary，但 spec 本身要 ts）")
    return false
  }

  // ── ① 正例 ──────────────────────────────────────────────────────────
  {
    const r = judgeClientI18n({ files: input({ "packages/client/foo/src/a.ts": "export const x = 1\n" }), hasTs: true }, ts)
    ok("正例：无中文文案 ⇒ 绿", r.status === "passed")
    const r2 = judgeClientI18n({ files: input({ "packages/client/foo/src/a.ts": 'export const x = "hello"\n' }), hasTs: true }, ts)
    ok("正例：纯英文文案 ⇒ 绿（CJK 代理集不误伤英文）", r2.status === "passed")
  }

  // ── ② 必然失败向量 ──────────────────────────────────────────────────
  {
    const r = judgeClientI18n({ files: input({ "packages/client/foo/src/a.ts": 'export const label = "提交"\n' }), hasTs: true }, ts, [])
    ok("反例①：裸中文文案 ⇒ 红（必然失败向量）", r.status === "failed")
    ok("反例①：finding 带 文件:行:文本", (r.findings ?? []).some((f) => f.file?.includes("a.ts") && f.line === 1 && f.detail.includes("提交")))
    const multi = judgeClientI18n({ files: input({
      "packages/client/foo/src/a.ts": 'export const a = "保存"\n',
      "packages/client/foo/src/b.tsx": 'export const b = "取消"\n',
    }), hasTs: true }, ts, [])
    ok("反例①b：两块各一条裸中文 ⇒ 2 条 finding", multi.status === "failed" && (multi.findings ?? []).length === 2)
  }

  // ── ③ locale 调用白名单 ──────────────────────────────────────────────
  {
    const calls = [
      'export const a = t("提交")\n',
      'export const a = i18n.tr("提交")\n',
      'export const a = translate("提交")\n',
      'export const a = locale.t("提交")\n',
    ]
    for (const src of calls) {
      const r = judgeClientI18n({ files: input({ "packages/client/foo/src/a.ts": src }), hasTs: true }, ts, [])
      ok(`白名单：${src.trim()} ⇒ 绿（字典取用不算裸文案）`, r.status === "passed")
    }
    const bad = judgeClientI18n({ files: input({ "packages/client/foo/src/a.ts": 'export const a = other("提交")\n' }), hasTs: true }, ts, [])
    ok('白名单边界：非字典函数 other("提交") ⇒ 仍红', bad.status === "failed")
  }

  // ── ④ 豁免生效/失效双向 ─────────────────────────────────────────────
  {
    const file = "packages/client/ui-theme/src/tokens.ts"
    const text = "纯白：页面表面与强调色上的文字底。"
    const withEx = judgeClientI18n({ files: input({ [file]: `export const d = "${text}"\n` }), hasTs: true }, ts, EXEMPTIONS)
    ok("豁免：存量 description 在登记中 ⇒ 绿", withEx.status === "passed")
    const withoutEx = judgeClientI18n({ files: input({ [file]: `export const d = "${text}"\n` }), hasTs: true }, ts, [])
    ok("豁免变异：撤销登记后同一文案 ⇒ 红（豁免有牙，不是恒绿）", withoutEx.status === "failed")
    ok("存量豁免 21 条齐（ui-theme token descriptions 带票）", EXEMPTIONS.length === 21 && EXEMPTIONS.every((e) => /^ISS-\d+$/.test(e.ticket)))
  }

  // ── ⑤ 缺输入：no-corpus / no-binary ─────────────────────────────────
  {
    const noCorpus = judgeClientI18n({ files: input({}), hasTs: true }, ts)
    ok("防扫空：0 源文件 ⇒ unjudged(no-corpus)，不冒绿", noCorpus.status === "unjudged" && noCorpus.reason === "no-corpus")
    const noBinary = judgeClientI18n({ files: input({ "a.ts": "export const a = 1\n" }), hasTs: false }, ts)
    ok("缺工具：无 typescript ⇒ unjudged(no-binary)，不冒绿", noBinary.status === "unjudged" && noBinary.reason === "no-binary")
  }

  // ── ⑥ 真仓：实扫 client src ⇒ 绿 ────────────────────────────────────
  {
    const real = collectSources(REPO)
    const r = judgeClientI18n({ files: real, hasTs: true }, ts)
    ok(`真仓：实扫 ${real.size} 个 client 源文件 ⇒ 绿（存量豁免后 0 违例）`, r.status === "passed")
  }

  // ── 纯函数：CJK 代理集 ──────────────────────────────────────────────
  ok("CJK_RE：命中汉字", CJK_RE.test("提交"))
  ok("CJK_RE：不命中纯英文/数字", !CJK_RE.test("submit123"))

  console.log(fails ? `✗ ${fails} 条不成立` : `✓ spec 全过（${total} 条断言：正例 / 必然失败 / 字典白名单 / 豁免双向 / 缺输入 / 真仓）`)
  return fails === 0
}
