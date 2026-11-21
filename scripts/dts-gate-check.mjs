#!/usr/bin/env node
/* dts 门禁覆盖守卫（ISS-647 · 审查 F2/F3）
 *
 * ## 守什么
 * 本单的病是 `skipLibCheck: true` 让**手写 .d.ts** 完全逃过类型检查（注入错误也 exit 0）。
 * 修法是给每个「有手写 .d.ts」的包加一份 `tsconfig.dts.json`（skipLibCheck:false + types:[]）
 * 并让 `typecheck` 前置它。
 *
 * 但修复本身**没有防回归**：
 *   · 有人把 `skipLibCheck` 改回 true ⇒ 检查静默失效，全仓照绿（审查 F2 的变异⑤实测：存活）
 *   · 新建一个有手写 .d.ts 的包、忘了加配置 ⇒ 又造一个假门禁（首个提交就漏了 3 个包）
 *   · 分母靠人枚举 ⇒ 必然漏（审查 F1/F3）
 *
 * 本脚本把这三件事变成机器判据：**扫描是分母，不是清单**。
 *
 * ## 判据（每条都能红）
 *   1. 每个含手写 .d.ts 的包，必须存在 `<pkg>/tsconfig.dts.json`
 *   2. 该文件必须 `skipLibCheck: false`，且 `types` 存在（`[]` 或不拉第三方）
 *   3. 该文件必须**覆盖到这个包每一个手写 .d.ts**（用 include 根逐个比对，防「配置在但 include 漏了目录」）
 *   4. 该包 `package.json` 的 `typecheck` 必须**前置** `tsc -p tsconfig.dts.json`
 *
 * ## 用法
 *   node scripts/dts-gate-check.mjs            # 判定（有缺口 exit 1）
 *   node scripts/dts-gate-check.mjs --list     # 只打印分母
 *
 * 退出码：0 = 全覆盖且配置正确 · 1 = 有缺口（逐条打印）· 2 = 扫描本身出错（分母为 0）
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const LIST_ONLY = process.argv.includes('--list')

/** 递归找 dir 下的 *.d.ts（跳过 node_modules / dist / .wt） */
function findDts(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.') || e.name === 'static') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) findDts(p, out)
    else if (e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** 顶层包目录（含 package.json 的 forge-* / api / scripts 同级） */
function packages() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => join(ROOT, e.name))
    .filter((p) => existsSync(join(p, 'package.json')))
}

const gaps = []
const rows = []

for (const pkgDir of packages()) {
  const pkg = relative(ROOT, pkgDir)
  const dts = [...findDts(join(pkgDir, 'lib')), ...findDts(join(pkgDir, 'src'))]
  if (dts.length === 0) continue

  const cfgPath = join(pkgDir, 'tsconfig.dts.json')
  const pkgJsonPath = join(pkgDir, 'package.json')
  const rel = (p) => relative(ROOT, p)
  rows.push({ pkg, dts: dts.length })

  if (!existsSync(cfgPath)) {
    gaps.push(`${pkg}: 有 ${dts.length} 个手写 .d.ts，缺 tsconfig.dts.json`)
    continue
  }

  const cfg = readFileSync(cfgPath, 'utf8')
  if (!/"skipLibCheck"\s*:\s*false/.test(cfg.replace(/\/\/.*$/gm, ''))) {
    gaps.push(`${pkg}: tsconfig.dts.json 里 skipLibCheck 不是 false（检查会静默失效）`)
  }
  if (!/"types"\s*:\s*\[/.test(cfg.replace(/\/\/.*$/gm, ''))) {
    gaps.push(`${pkg}: tsconfig.dts.json 缺 "types": []（会拉入第三方 .d.ts 造成噪音）`)
  }

  // include 根是否覆盖每一个手写 .d.ts
  const incMatch = /"include"\s*:\s*(\[[^\]]*\])/.exec(cfg.replace(/\/\/.*$/gm, ''))
  const includeRoots = incMatch ? [...incMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []
  for (const file of dts) {
    const r = relative(pkgDir, file)
    const covered = includeRoots.some((root) => {
      const base = root.replace(/\/\*\*\/\*\.d\.ts$/, '').replace(/\*\*\/\*\.d\.ts$/, '')
      return r === base || r.startsWith(base + '/')
    })
    if (!covered) gaps.push(`${pkg}: ${r} 不在 tsconfig.dts.json 的 include 里（${includeRoots.join(', ') || '无 include'}）`)
  }

  // typecheck 必须前置 dts 段
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const tc = String(pkgJson?.scripts?.typecheck ?? '')
  if (!tc.includes('tsconfig.dts.json')) {
    gaps.push(`${pkg}: package.json 的 typecheck 没有前置 tsc -p tsconfig.dts.json（当前：${tc || '无 typecheck'}）`)
  }
}

if (rows.length === 0) {
  console.error('✗ 扫描到 0 个含手写 .d.ts 的包 —— 分母为 0，判据空转（路径或 cwd 不对？）')
  process.exit(2)
}

const totalDts = rows.reduce((n, r) => n + r.dts, 0)
console.log(`dts 门禁覆盖：扫 ${rows.length} 个包 / ${totalDts} 个手写 .d.ts`)
if (LIST_ONLY) {
  for (const r of rows) console.log(`  ${r.pkg}  ${r.dts}`)
  process.exit(0)
}

if (gaps.length > 0) {
  console.error(`\n✗ 发现 ${gaps.length} 处缺口：`)
  for (const g of gaps) console.error(`  - ${g}`)
  process.exit(1)
}
console.log('✓ 全覆盖：每个手写 .d.ts 都有生效的 dts 检查段')
