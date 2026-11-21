#!/usr/bin/env node
// 脚本卫生体检（ISS-540）：抓「注释被粘进上一行导致 `#` 不再是注释起始」这类事故。
//
// 事故原型（2026-09-17）：`echo "..."` 与下一行注释被编辑成同一行 →
//   echo "==> 0. 存档旧 web.log（崩溃取证）"# 2026-08-28 ... 的 > 重定向覆盖，死前日志
// bash 的规则是「`#` 只有位于**词首**才算注释」，紧跟闭引号的 `#` 属于同一个词 →
// 注释没生效，后面那句里的 `>` 被当成**重定向**：在可写目录只多一个垃圾文件（所以本地
// 验收会通过），在只读 cwd（launchd 的 cwd 是 `/`）**直接中止脚本** → 重启永远失败。
//
// 判定：逐字符走，跟踪是否在单/双引号内；凡「不在字符串内、且紧贴非空白非元字符的 `#`」
// 就是可疑（正常的 `echo "# x"` 在字符串内、`cmd   # 注释` 前面有空白，都不报）。
//
// 用法：node scripts/tests/script-hygiene.mjs        （退出码 1 = 有可疑行）
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.argv[2] || new URL("../../", import.meta.url).pathname
const META = new Set([";", "|", "&", "(", ")", "<", ">", "{", "}", "\n"])

function suspicious(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === "\\" && quote === '"') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue }
    if (ch === "#") {
      const prev = i === 0 ? "\n" : line[i - 1]
      if (prev === "$") continue            // 参数展开 $# —— 合法
      if (prev === "#") continue            // 注释/装饰性 ### 连写 —— 首个 # 已在词首
      if (!/\s/.test(prev) && !META.has(prev)) return true
    }
  }
  return false
}

let bad = 0
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (!entry.endsWith(".sh")) continue
    const lines = readFileSync(p, "utf8").split("\n")
    let heredoc = null
    lines.forEach((l, i) => {
      if (heredoc) {                          // heredoc 体是数据，不是代码
        if (l.trim() === heredoc) heredoc = null
        return
      }
      const hd = l.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)
      if (hd) heredoc = hd[1]
      if (suspicious(l)) {
        bad++
        console.log(`${p}:${i + 1}: 可疑行（# 未处于词首，可能被并进上一行 → 注释失效/重定向生效）\n    ${l.trim().slice(0, 120)}`)
      }
    })
  }
}
walk(join(ROOT, "scripts"))
console.log(bad === 0 ? "✓ 脚本卫生检查通过（无粘连注释）" : `✗ ${bad} 处可疑`)
process.exit(bad === 0 ? 0 : 1)
