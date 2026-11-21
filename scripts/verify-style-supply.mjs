#!/usr/bin/env bun
/**
 * 样式供给链验证器（2026-10-07 · 模型管理页 P0 调研副产物）
 *
 * 回答一个问题：**某个类名在当前页面到底有没有样式供给？**
 *
 * 为什么需要它：
 *   ISS-933 把 Tailwind 工具类整体退役后，`cn(..., "flex flex-col shadow-sm")` 这类
 *   `className` 上的字符串**不再对应任何 CSS 规则** —— 它们不报错、不告警，
 *   只是在浏览器里静默失效。这是 ISS-684 / ISS-685 同源事故的第三遭
 *   （前两遭还有 forge-ui 的合并产物兜底，这遭连兜底都没有）。
 *   本脚本把"哪个类活着"变成**可机器判定**的事实，而不是靠人记。
 *
 * 用法：
 *   bun scripts/verify-style-supply.mjs                # 检查全部
 *   bun scripts/verify-style-supply.mjs .flex .h-9     # 只查指定类
 *
 * 退出码：0 = 全部有供给；1 = 存在死类（CI 可据此拦截）
 */

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname

/** 供给方清单：谁在运行时往 document 里塞 <style> */
const SUPPLIERS = [
  {
    name: "forge-model · CSS Modules（随 client.js 内联）",
    file: "forge-model/dist/client.js",
    // 产物里是 `var css = "..."` 的形式
    extract: (src) => {
      const m = src.match(/var css = ("[\s\S]*?");\s*\n\s*if \(!css\)/)
      return m ? JSON.parse(m[1]) : ""
    },
  },
  {
    name: "forge-model · 作用域层（model-scope.css → SCOPE_CSS）",
    file: "forge-model/src/styles/scope.generated.ts",
    extract: (src) => {
      const m = src.match(/SCOPE_CSS: string = ("[\s\S]*?")\s*$/m)
      return m ? JSON.parse(m[1]) : ""
    },
  },
  {
    name: "forge-design · FORGE_DESIGN_CSS（injectForgeStyles）",
    file: "forge-design/src/styles.generated.ts",
    extract: (src) => {
      const m = src.match(/FORGE_DESIGN_CSS: string = ("[\s\S]*?")\s*$/m)
      return m ? JSON.parse(m[1]) : ""
    },
  },
  {
    name: "forge-pm · TAILWIND_CSS（若与 forge-model 同页则生效）",
    file: "forge-pm/src/styles/tailwind.generated.ts",
    extract: (src) => {
      const m = src.match(/TAILWIND_CSS: string = ("[\s\S]*?")\s*$/m)
      return m ? JSON.parse(m[1]) : ""
    },
  },
]

/** 默认检查集：shadcn 基元与业务代码最常用的类 */
const DEFAULT_PROBES = [
  // 布局
  ".flex", ".inline-flex", ".grid", ".flex-col", ".items-center", ".justify-between", ".gap-2",
  // 尺寸 / 形状
  ".h-8", ".h-9", ".h-10", ".w-56", ".px-2", ".px-3", ".py-2", ".gap-1\\.5",
  ".rounded-md", ".rounded-lg", ".rounded-xl", ".rounded-full",
  // 颜色
  ".bg-card", ".bg-background", ".bg-accent", ".bg-primary", ".bg-muted", ".border-border",
  ".text-foreground", ".text-muted-foreground", ".text-primary-foreground",
  // 字号
  ".text-xs", ".text-sm",
  // 阴影 / 动效
  ".shadow-sm", ".shadow-md", ".transition-all", ".duration-200",
]

function classExists(cssText, cls) {
  // CSS Modules 产物带 hash 后缀（.flex_AbC12）；裸类无后缀
  const bare = cls.replace(/^\./, "")
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // ⚠️ 字符类里的 `>` 必须转义：`[\s,{:>]` 会报 "Unterminated character class"。
  //    本文件此前从没被跑过，这个语法错一直躺着（2026-10-07 首次运行才发现）。
  const re = new RegExp(`\\.${escaped}(_[A-Za-z0-9]+)?[\\s,{:>]`)
  return re.test(cssText)
}

const probes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PROBES

console.log("── 样式供给方 ───────────────────────────────")
const cssBySupplier = []
for (const s of SUPPLIERS) {
  const p = join(ROOT, s.file)
  if (!existsSync(p)) {
    console.log(`  ⚠️  缺失：${s.name} (${s.file})`)
    cssBySupplier.push({ ...s, css: "" })
    continue
  }
  let css = ""
  try {
    css = s.extract(readFileSync(p, "utf8"))
  } catch (e) {
    console.log(`  ⚠️  解析失败：${s.name} — ${e.message}`)
  }
  console.log(`  ${css ? "✅" : "❌"} ${s.name} — ${css.length} 字节`)
  cssBySupplier.push({ ...s, css })
}

console.log("\n── 类名存活判定 ─────────────────────────────")
const dead = []
for (const cls of probes) {
  const alive = cssBySupplier.filter((s) => classExists(s.css, cls))
  if (alive.length === 0) {
    dead.push(cls)
    console.log(`  ❌ ${cls.padEnd(22)} 无供给 ⇒ **死类**（写了不生效）`)
  } else {
    console.log(`  ✅ ${cls.padEnd(22)} ← ${alive.map((a) => a.name.split(" · ")[0]).join(", ")}`)
  }
}

console.log(`\n合计：${probes.length - dead.length} 活 / ${dead.length} 死`)
if (dead.length) {
  console.log("\n⛔ 存在死类。修法：把类搬进对应包的 CSS Modules 再引用 s.xxx，")
  console.log("   而不是把它加进某种 allowlist（那等于承认样式可以写而不生效）。")
  process.exit(1)
}
console.log("\n✅ 全部有供给。")
