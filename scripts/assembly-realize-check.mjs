#!/usr/bin/env node
// scripts/assembly-realize-check.mjs —— 装配级实化判据（ISS-652）
//
// ## 为什么需要它（这层没有任何现有门禁能发现）
// ISS-642 把一个包拆成「面板半 + 工具半」，工具半靠主半在 apply 期 `ctx.provide()` 交出的服务活着。
// 2026-10-25 实测：`gate-for.sh forge-trader` 四项全绿、typecheck 绿、`bun test` 绿，
// 而真机会话里 **7 个 trader 工具一个都没注册**，启动日志只有一行
//     `[forge-trader/tools] 取不到 forge.trand-backend —— 工具半未注册`
// 原因不是语法错、不是类型错、不是测试漏 —— 是**装配时序**：
//   工具半 `inject` 里没声明那个服务 ⇒ 面板半稍后 provide 时引擎不会重新激活它
//   （cordis `notify()` 里 `if (!(name in fiber.inject)) continue`）⇒ 错过 apply 期就永不重试。
// 这类缺陷的特征是「静态全绿 + 只有真机装起来才炸」，所以判据必须**真的把两半按真实顺序装一遍**。
//
// ## 判据（两档都绿才算绿）
//   ① 顺装：面板半先 provide → 工具半后挂 ⇒ 必须注册上全部工具
//   ② 反序：工具半先挂（服务还没有）→ 面板半后 provide ⇒ 仍必须注册上全部工具
//   只有 ① 不够：把顺序调成"先 provide 再挂"就能绿，而真机顺序不受我们控制
//   （preset 子树与 bundle 根树的实化先后由引擎决定）。
//
// ## 判据用真引擎，不用假 Context
// 自己糊一个 `{ get: () => ... }` 的桩 ctx，验的是"我以为的语义"，那正是本单要消灭的假绿形态。
// 这里 import 引擎跑着的那份 @deepseek-ai/cordis，用它的 `new Context()` / `ctx.plugin()`。
//
// ## 变异可红（本单实测）
//   把面板半的 `ctx.provide("forge.trand-backend", ...)` 删掉 ⇒ 两档都必须红。
//   `--selftest` 就干这件事：在**系统临时目录**复制三份源码再改，不写工作区。
//
// ## 用法
//   node scripts/assembly-realize-check.mjs             # 判定（默认量 forge-trader）
//   node scripts/assembly-realize-check.mjs --json      # 机器可读
//   node scripts/assembly-realize-check.mjs --selftest  # 变异验证：删 provide 必须红
//
// 退出码：0 = 绿；1 = 红；2 = 判据自身跑不起来 / 变异构造失败（**不算绿**）
//
// ## 复用到 canvas（ISS-652 要求「改法能复用到 canvas」，本单不动 canvas）
//   node scripts/assembly-realize-check.mjs \
//     --panel=forge-canvas/lib/index.js --tools=forge-canvas/lib/canvas-tools.js \
//     --service=forge.canvas-store
// 面板半/工具半路径与服务名全是参数，不写死。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const SELFTEST = argv.includes('--selftest')
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PANEL = path.resolve(REPO, arg('panel', 'forge-trader/lib/index.js'))
const TOOLS = path.resolve(REPO, arg('tools', 'forge-trader/lib/tools.js'))
const SERVICE = arg('service', 'forge.trand-backend')

// 判据的**唯一**接受口（验收要的正是这两个数）
const ACCEPT_TOOLS_MIN = 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const line = (s = '') => { if (!JSON_OUT) console.log(s) }
// 尊重 NO_COLOR（`--json` 也一律不上色）：被 ci-local 之类的聚合脚本 parse 时，
// 色码会混进数字（`全绿：\x1b[32m7/7`）—— 那种失败很难看出来，不如源头就不上色。
const USE_COLOR = !JSON_OUT && !process.env.NO_COLOR && process.stdout.isTTY
const red = (s) => (USE_COLOR ? `\x1b[31m${s}\x1b[0m` : s)
const green = (s) => (USE_COLOR ? `\x1b[32m${s}\x1b[0m` : s)

// ── cordis：用引擎自己跑的那份 ───────────────────────────────────────
function loadCordis() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-matter')
  const candidates = [
    path.join(path.dirname(PANEL), '..', 'node_modules/@deepseek-ai/cordis/lib/index.js'),
    path.join(REPO, 'forge-trader/node_modules/@deepseek-ai/cordis/lib/index.js'),
    path.join(home, 'profiles/node_modules/@deepseek-ai/cordis/lib/index.js'),
    path.join(os.homedir(), '.dsh', 'profiles/node_modules/@deepseek-ai/cordis/lib/index.js'),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return { path: c }
  return null
}

// ── 期望工具数：从源码数，不写死 ─────────────────────────────────────
// 写死数字会在"加第 8 个工具"时逼人改门禁，而改门禁比改实现省事 ⇒ 迟早有人把数字调小换绿。
function expectedToolCount(file) {
  const code = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const names = [...code.matchAll(/defineTool\(\s*\{[\s\S]*?name:\s*["']([A-Za-z0-9_]+)["']/g)]
    .map((m) => m[1])
  return new Set(names).size
}

// ── 桩服务：引擎自带的 tools + 两半用到的其余服务 ────────────────────
function stubs() {
  const registered = []
  const noop = () => {}
  return {
    registered,
    root: {
      tools: { register: (def, label) => { registered.push(def?.name || label || '(unnamed)'); return noop } },
      // 面板半：路由注册（webServer.register）；工具半：prompt 段（systemPrompt.section，可选增强）
      webServer: { register: () => noop },
      systemPrompt: { section: () => noop },
    },
  }
}

/**
 * 把两半装进同一个 Context。
 * 工具半挂在 `root.extend(...)` 出来的**另一棵树**上 —— 真机的 preset 子树在 loader 里就是
 * `ctx.extend()` 的子上下文（不是新建 Context：新建会连 registry 一起分开，测不出真机的 notify）。
 */
async function mount({ cordisPath, panelPath, toolsPath, panelFirst }) {
  const mod = await import(pathToFileURL(cordisPath).href)
  const Context = mod.Context || mod.default?.Context
  if (!Context) throw new Error('cordis 里没有导出 Context')

  const s = stubs()
  const root = new Context()
  for (const [name, impl] of Object.entries(s.root)) root.provide(name, impl)

  const panelMod = await import(pathToFileURL(panelPath).href)
  const toolsMod = await import(pathToFileURL(toolsPath).href)
  const loadPanel = () => root.plugin(panelMod)
  const loadTools = () => root.extend({ baseUrl: undefined }).plugin(toolsMod)

  if (panelFirst) {
    loadPanel(); await sleep(60)
    loadTools(); await sleep(140)
  } else {
    loadTools(); await sleep(40)
    loadPanel(); await sleep(180)
  }
  return s.registered
}

// ── 变异：复制三个源文件到临时目录，删掉面板半的 provide ─────────────
// 为什么整包复制：tools.js 与 index.js 都 `import "./trader-pure.js"`，只复制一个文件会断相对路径。
// 为什么在临时目录：门禁不许有写工作区的副作用（否则"跑过门禁"本身会弄脏 diff）。
function buildMutant() {
  const panelSrc = fs.readFileSync(PANEL, 'utf8')
  const patched = panelSrc.replace(
    /^([ \t]*)ctx\.provide\(\s*["']([^"']+)["'][\s\S]*?\)[ \t]*$/m,
    '$1// [mutant] ctx.provide($2, ...) 已被删掉',
  )
  if (patched === panelSrc) return null

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-realize-mutant-'))
  const panelDir = path.dirname(PANEL)
  for (const f of fs.readdirSync(panelDir)) {
    if (!f.endsWith('.js') || f.endsWith('.test.js')) continue
    fs.copyFileSync(path.join(panelDir, f), path.join(dir, f))
  }
  // 副本要能解析 `forge-service-kit` / `@deepseek-ai/dsh-tools` —— 把包自己的 node_modules
  // 软链进来（不复制，几百 MB）。少了这一步，变异档会以 ERR_MODULE_NOT_FOUND 崩掉，
  // 而崩溃容易被当成"判据没牙"混过去 —— 所以宁可显式补依赖也不动工作区。
  const pkgNm = path.join(path.dirname(panelDir), 'node_modules')
  if (fs.existsSync(pkgNm)) fs.symlinkSync(pkgNm, path.join(dir, 'node_modules'), 'dir')
  const mutantPanel = path.join(dir, path.basename(PANEL))
  fs.writeFileSync(mutantPanel, patched)
  return { dir, panelPath: mutantPanel, toolsPath: path.join(dir, path.basename(TOOLS)) }
}

async function main() {
  const cordis = loadCordis()
  if (!cordis) {
    line(red('✗ 找不到 @deepseek-ai/cordis —— 判据自身跑不起来（不算绿）'))
    process.exit(2)
  }
  const expected = expectedToolCount(TOOLS)
  if (expected < ACCEPT_TOOLS_MIN) {
    line(red(`✗ 在 ${path.relative(REPO, TOOLS)} 里数到 0 个 defineTool —— 判据瞄错对象（不算绿）`))
    process.exit(2)
  }

  line('── assembly-realize-check（ISS-652 装配级实化判据）──')
  line(`   面板半 ${path.relative(REPO, PANEL)}`)
  line(`   工具半 ${path.relative(REPO, TOOLS)}`)
  line(`   服务名 ${SERVICE} · 期望工具数 ${expected}`)
  line(`   cordis ${cordis.path.replace(os.homedir(), '~')}`)
  line()

  const forward = await mount({ cordisPath: cordis.path, panelPath: PANEL, toolsPath: TOOLS, panelFirst: true })
  const okA = forward.length === expected
  line(`   ① 顺装（面板半先 provide → 工具半后挂）：${forward.length}/${expected} ${okA ? green('✓') : red('✗')}`)
  if (!okA) line(`      实得 ${JSON.stringify(forward)}`)

  const reverse = await mount({ cordisPath: cordis.path, panelPath: PANEL, toolsPath: TOOLS, panelFirst: false })
  const okB = reverse.length === expected
  line(`   ② 反序（工具半先挂 → 面板半后 provide）：${reverse.length}/${expected} ${okB ? green('✓') : red('✗')}`)
  if (!okB) line(`      实得 ${JSON.stringify(reverse)}`)

  let mutantOk = null
  let mutantCount = null
  if (SELFTEST) {
    const m = buildMutant()
    if (!m) {
      line(red(`✗ 变异构造失败：${path.relative(REPO, PANEL)} 里没找到 ctx.provide(...) 那一行`))
      process.exit(2)
    }
    try {
      const got = await mount({ cordisPath: cordis.path, panelPath: m.panelPath, toolsPath: m.toolsPath, panelFirst: true })
      mutantCount = got.length
      // 删掉 provide 后必须**一个工具都注册不上** —— 判据若还绿，说明它根本没在量实化
      mutantOk = got.length === 0
      line(`   变异（面板半删掉 provide）：${got.length}/${expected} —— 期望 0 ${mutantOk ? green('✓ 判据有牙') : red('✗ 判据没牙')}`)
    } finally {
      fs.rmSync(m.dir, { recursive: true, force: true })
    }
  }

  const pass = okA && okB && (mutantOk === null || mutantOk === true)
  line()
  if (JSON_OUT) {
    console.log(JSON.stringify({ pass, expected, forward: forward.length, reverse: reverse.length, mutant: mutantCount, service: SERVICE }, null, 2))
  } else {
    console.log(pass
      ? green(`✓ 装配实化判据全绿：${expected}/${expected} 个工具两档都注册上` + (SELFTEST ? '，变异可红' : ''))
      : red('✗ 装配实化判据红（见上）'))
  }
  process.exit(pass ? 0 : 1)
}

await main()
