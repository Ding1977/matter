// scripts/lexical-lib.mjs
// 词法类度量的取数口径（ISS-762）：**注释不是代码**。
//
// 为什么外置成模块：`code-inventory.mjs` 贴着 K2a 的 1000 行红线（"加能力先外置或先还行数"，ISS-742 留的规矩）。
// 为什么用引擎的 scanner 而不是自己写"剔注释"的正则/切片：本仓为手写词法层付过两次学费 ——
//   `getFullStart()..getStart()` 反向切片会把正文一起切掉（区间重叠），N7 因此被低估一半（27 vs 真值 56）；
//   同族的还有"字符串里的 // 被当成注释起点"。⇒ **凡剔注释/取区间，交给引擎**（ISS-762 note 2 · ISS-765）。
//
// 口径（两个函数，各自对应一个度量的**乙案**）：
//   countQuotes —— N7「引号风格混用」：只数**字符串字面量里的引号**（注释、标识符、正则里的都不算）。
//   codeOnly    —— C11 之类的 pattern 匹配：把注释区间抹成空格（**保长度**，行号列号不受影响），再拿去匹配。

const COMMENT_KINDS = new Set([1 /* SingleLineCommentTrivia */, 2 /* MultiLineCommentTrivia */])

/** 扫一遍词法 token；skipTrivia=false 时注释与空白也在流里（由调用方决定怎么用） */
function* tokens(ts, source, skipTrivia) {
  const sc = ts.createScanner(ts.ScriptTarget.Latest, skipTrivia, ts.LanguageVariant.Standard, source)
  for (let k = sc.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = sc.scan()) yield { kind: k, text: sc.getTokenText() }
}

/** N7（乙案）：只数**字符串字面量**里的引号 —— 返回 { d: 双引号数, s: 单引号数 }
 *  取数走 **AST**（调用方已经有解析好的 sourceFile，不重复扫）：`isStringLiteral` 天然排掉注释、
 *  标识符、模板串文本；正则字面量也由**解析器**判对了（裸 scanner 会把 `/["\']/` 误当除法+数组，实测踩到）。 */
export function countQuotes(ts, sf) {
  const out = { d: 0, s: 0 }
  const walk = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const t = n.getText()
      if (t[0] === '"') out.d += (t.match(/"/g) || []).length
      else if (t[0] === "'") out.s += (t.match(/'/g) || []).length
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return out
}

/** 把注释抹成**等长空格**（保偏移/行号）；其余原样。给 C11 这类"按 pattern 数自己在实现某能力"的度量用 */
export function codeOnly(ts, source) {
  let out = ''
  for (const t of tokens(ts, source, false)) out += COMMENT_KINDS.has(t.kind) ? ' '.repeat(t.text.length) : t.text
  return out
}

/** 自检：注释里的不算、字面量里的算、转义不炸、模板串里的表达式按代码算、保长度 */
// ⚠️ **故意不 export**：自检只由本文件的 CLI 调用（`--selftest`）。给它加 export 就是给度量 Z2 添一条
//    零引用导出 —— 本仓为这个坑付过学费（`docDrift` 那次，K10b 当场红）。改回模块内函数后 325 → 326 的
//    那条新增也随即消失（这条注释就是那次红的现场记录）。
function selftestLexical(ts) {
  const cases = []
  const q = (src) => countQuotes(ts, ts.createSourceFile('__fx__.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
  cases.push(['注释里的引号不算（这是本模块存在的理由）', q('// 他说 "你好"\nconst a = 1\n') .d === 0 && q('/* "x" \'y\' */\nconst a = 1\n').d === 0])
  cases.push(['字符串字面量里的算（双/单各数各的）', q('const a = "x"\nconst b = \'y\'\n').d === 2 && q('const a = "x"\nconst b = \'y\'\n').s === 2])
  cases.push(['转义引号不炸（\\" 也算一个双引号字符，但不会把词法搞乱）', q('const a = "he said \\"hi\\""\n').d === 4])
  cases.push(['标识符/正则里的引号不算', q('const re = /["\']/\n').d === 0 && q("const re = /[\"']/\n").s === 0])
  cases.push(['模板串里的 ${} 表达式按代码算、模板文本本身不算引号', q('const t = `a${"b"}c`\n').d === 2])
  const src = '// "x"\nconst a = "y"\n'
  const co = codeOnly(ts, src)
  cases.push(['codeOnly 抹注释但保长度与其余原文', co.length === src.length && !co.includes('"x"') && co.includes('"y"')])
  cases.push(['codeOnly 保行号（换行数不变）', co.split('\n').length === src.split('\n').length])
  let fail = 0
  console.log('lexical-lib --selftest（口径：注释不是代码 · 取自引擎 scanner）')
  for (const [n, ok] of cases) { console.log(`  ${ok ? '✓' : '✗'} ${n}`); if (!ok) fail++ }
  console.log(fail ? `\n✗ ${fail} 项失败` : `\n✓ ${cases.length}/${cases.length} 项通过`)
  return fail ? 1 : 0
}

// CLI：`node scripts/lexical-lib.mjs --selftest`（体检自己会调它 —— 新判据必须自带反向验证，K8b）
if (process.argv[1] && process.argv[1].endsWith('lexical-lib.mjs')) {
  const { pathToFileURL } = await import('node:url')
  const { existsSync } = await import('node:fs')
  // 候选与 code-inventory 同套（含根 node_modules）：旧树 forge-ui/forge-pm 的 node_modules 只在
  // 主检出的 bun 环境存在；工单树 / CI 冷装是 pnpm 布局，typescript 装在根（ISS-899 补齐——
  // 原先漏根候选，冷装环境 selftest 恒 exit 2 被读成红）。
  const cands = ['forge-ui/node_modules/typescript/lib/typescript.js', 'forge-pm/node_modules/typescript/lib/typescript.js', 'node_modules/typescript/lib/typescript.js']
  const hit = cands.find((c) => existsSync(new URL('../' + c, import.meta.url)))
  if (!hit) { console.error('✗ 找不到 typescript（与 code-inventory 同一套候选路径）'); process.exit(2) }
  const ts = (await import(pathToFileURL(new URL('../' + hit, import.meta.url).pathname).href)).default
  process.exit(selftestLexical(ts))
}
