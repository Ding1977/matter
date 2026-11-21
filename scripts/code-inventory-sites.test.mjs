#!/usr/bin/env node
// scripts/code-inventory-sites.test.mjs
// ISS-771：**site（file:line）必须对得上原始文件的那一行**。
//
// 为什么单独立这条：棘轮类规则（K9b/K5f/K5g/K6a）判的是「比基线多出来的那几处」，
// 没有行号就只能看 per-file 计数、没法 blame 出「哪一处、谁引入的」—— 那种红只能靠猜。
// 但行号漂了**比没有更坏**：读者会照着它去改错行。所以这里逐条核：
//   ① 文件存在、行号在 1..行数 内；
//   ② 那一行**确实**是判据命中的东西（不是随便一个行号）。
//
// 用法：bun test scripts/code-inventory-sites.test.mjs --isolate
import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const INV = path.join(ROOT, "scripts", "code-inventory.mjs")

let cache = null
const metrics = () => {
  if (!cache) {
    const out = execFileSync(process.execPath, [INV, "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    cache = JSON.parse(out).metrics
  }
  return cache
}
const linesOf = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n")
const m = (id) => metrics().find((x) => x.id === id)

describe("ISS-771 site 行号可信度", () => {
  test("E3/K9b：每条 site 指到一行真 `catch`", () => {
    const x = m("E3")
    expect(Array.isArray(x.sites)).toBe(true)
    expect(x.sites.length).toBe(x.value)
    for (const s of x.sites) {
      const lines = linesOf(s.k)
      expect(s.line).toBeGreaterThanOrEqual(1)
      expect(s.line).toBeLessThanOrEqual(lines.length)
      expect(lines[s.line - 1]).toContain("catch")
    }
  }, 60_000)

  test("C9/K5f：每条 site 指到一行含该 path 字面量的行", () => {
    const x = m("C9")
    expect(Array.isArray(x.sites)).toBe(true)
    expect(x.sites.length).toBeGreaterThan(0)
    for (const s of x.sites) {
      const lines = linesOf(s.k)
      expect(s.line).toBeGreaterThanOrEqual(1)
      expect(s.line).toBeLessThanOrEqual(lines.length)
      expect(lines[s.line - 1]).toContain(s.p)
    }
  }, 60_000)

  test("C10/K5g：每条 site 指到一行含别人前缀的行", () => {
    const x = m("C10")
    expect(Array.isArray(x.sites)).toBe(true)
    expect(x.sites.length).toBeGreaterThan(0)
    for (const s of x.sites) {
      const lines = linesOf(s.k)
      expect(s.line).toBeGreaterThanOrEqual(1)
      expect(s.line).toBeLessThanOrEqual(lines.length)
      expect(lines[s.line - 1]).toContain(s.prefix)
    }
  }, 60_000)

  test("D2/K6a：每条 site 带 file + line，且那一行（或前后 2 行）真有该函数名", () => {
    const x = m("D2")
    expect(Array.isArray(x.sites)).toBe(true)
    for (const s of x.sites) {
      expect(typeof s.file).toBe("string")
      const lines = linesOf(s.file)
      expect(s.line).toBeGreaterThanOrEqual(1)
      expect(s.line).toBeLessThanOrEqual(lines.length)
      const win = lines.slice(Math.max(0, s.line - 3), s.line + 2).join("\n")
      expect(win).toContain(s.name)
    }
  }, 60_000)
})
