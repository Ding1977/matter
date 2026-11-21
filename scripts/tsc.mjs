#!/usr/bin/env node
// scripts/tsc.mjs
// 共用 tsc 定位器：把参数原样转发给仓库里**已安装**的 typescript 编译器（ISS-706）
// 为什么要有它：12 个包里只有部分装了 typescript 依赖，`bun run typecheck` 在没装的包里 exit 127
// —— 门禁"配了但跑不动"等于没配。本文件让任何包的 scripts 都能写 `node ../scripts/tsc.mjs -p tsconfig.lib.json`，
// 不为此给每个包新增 devDependency（那会牵动 bun.lock，属老板窗口的事）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')
const CANDIDATES = [
  'node_modules/typescript/bin/tsc',
  'forge-ui/node_modules/typescript/bin/tsc',
  'forge-pm/node_modules/typescript/bin/tsc',
]
const hit = CANDIDATES.map((c) => path.join(ROOT, c)).find((p) => fs.existsSync(p))
if (!hit) { console.error('✗ 找不到 typescript（试过 ' + CANDIDATES.join(' · ') + '）'); process.exit(2) }
const r = spawnSync(process.execPath, [hit, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() })
process.exit(r.status ?? 2)
