// ctx.storage 行为证据（P0 唯一的行为判据）。用法：
//   node packages/storage/storage/scripts/verify-ctx-storage.mjs
// 前置：已跑过 tsdown（lib/index.js 存在）。路径全部相对本文件解析，可跨机器复核。
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, "..")

// cordis 从本包的解析链取（依赖声明在 package.json 的 peer+dev）
const require = createRequire(`${PKG}/package.json`)
const cordisEntry = require.resolve("@deepseek-ai/cordis")
const { Context } = await import(pathToFileURL(cordisEntry).href)

const m = await import(pathToFileURL(resolve(PKG, "lib/index.js")).href)
const Storage = m.default

let failed = 0
const assert = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`)
  if (!cond) failed++
}

// ① ctx.storage 真挂上
const ctx = new Context()
assert(ctx.storage === undefined, "挂载前 ctx.storage 是 undefined")
await ctx.plugin(Storage)
assert(ctx.storage instanceof Storage, "ctx.storage instanceof Storage")

// ② 注册 / 注销
const fake = { close: async () => {} }
const dispose = ctx.storage.backend.register("x", fake)
assert(ctx.storage.backend.names().includes("x"), "names() 含 x")
dispose()
assert(!ctx.storage.backend.names().includes("x"), "调 disposer 后不含 x")

// ③ stale-disposer 守卫：旧 disposer 迟到不许删掉新后端
const A = { close: async () => {}, tag: "A" }
const B = { close: async () => {}, tag: "B" }
const dA = ctx.storage.backend.register("x", A)
dA()
const dB = ctx.storage.backend.register("x", B)
dA() // 迟到的旧 disposer
assert(ctx.storage.backend.get("x").tag === "B", "stale-disposer 守卫：get('x') 仍是 B")
dB()

console.log(failed === 0 ? "\n全部断言通过" : `\n${failed} 条断言失败`)
process.exit(failed === 0 ? 0 : 1)
