#!/usr/bin/env node
/**
 * 公开仓同步机器（ISS-904 / P5 同步机制）—— 一键把私有 main 的白名单面导出成公开快照。
 *
 * 管线（默认 dry-run，只写本地快照目录，绝不推远端）：
 *   ① origin/main `git archive` 白名单导出（packages/** + scripts/** + apps/** + 8 根脚手架件；
 *      scripts/ 排除 3 个死链探针目录，见 SCRIPTS_EXCLUDE）
 *   ② 修订版洗脱（4+ token → 唯一小号段）+ 绝对路径归一（<home> → 占位前缀，显式最长优先表 + 自测）；
 *      **以持久化 mapping 为唯一真相源**，从不排序重算
 *   ③ vitest.config.ts 的 apps/ 适配（7 处命中 → 确定性 patch，含命中断言；根件漂移即停）
 *   ④ 快照内新写五件：package.json（瘦身根）/ LICENSE MIT / README 极简 / .gitignore /
 *      .github/workflows/ci.yml（build / typecheck / test / gates 四 lane）
 *   ⑤ 八件自证：install / build / typecheck / vitest / 13 模式密钥扫描 0 / 4+ grep=0 /
 *      <home> grep=0（全树，含 apps/）/ apps/ 单项 <home> grep=0
 *      （快照内 run-gates 另由 CI gates lane 验，见 ci.yml）
 *   ⑥ --push 段（默认关）：仅当显式传 --push 且远端指向公开仓才提交并推送；本单不推，Lead 收口推
 *
 * 硬断言（漂移即 exit≠0，停下报 Lead，不静默绕）：
 *   · mapping 文件 SHA256 跑前 = 跑后（脚本只读 mapping，绝不回写/重排）
 *   · 源里出现的每个 4+ token 都必须在 mapping 有条目（新 token 先追加映射，禁临时编号）
 *   · 洗脱后全树 4+ grep = 0，且 <home> grep = 0
 *   · 绝对路径归一自测（6 例抽样前后对照）在 main 开头跑，规则漂移即停
 *   · vitest patch 的每块命中次数恰为 1（根件漂移 = 断言失败）
 *
 * 幂等：同一 --base/--target 连跑两遍，快照内容逐字节一致（打印 SNAPSHOT_DIGEST 供 diff）。
 *
 * 用法：
 *   node scripts/sync-public.mjs                          # dry-run（写快照 + 自证，不推）
 *   node scripts/sync-public.mjs --no-attest              # 只做导出+洗脱+patch（快，查漂移用）
 *   node scripts/sync-public.mjs --target <sha>           # 指定导出 ref（默认 origin/main）
 *   node scripts/sync-public.mjs --out <dir>              # 指定快照目录（默认 ~/wt/matter-export）
 *   node scripts/sync-public.mjs --push --remote <url>    # 显式推（Lead 收口执行）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MAPPING_FILE = path.join(REPO, "scripts/baseline/public-wash-mapping.json")
const DEFAULT_TARGET = "origin/main"
const DEFAULT_OUT = path.join(os.homedir(), "wt", "matter-export")
const DEFAULT_REMOTE = "git@github.com:Ding1977/matter.git"

const ROOT_SCAFFOLD = [
  "pnpm-workspace.yaml", "tsconfig.next.json", "tsconfig.base.json",
  "tsconfig.base.emit.json", "tsconfig.base.client.emit.json",
  "vitest.config.ts", "vitest.setup.ts", "tsdown.config.ts",
  // ISS-930 补漏：公开仓跑 lint 需要这 2 份配置；typert 生成器靠 tsconfig.host.json 定位 workspace，
  // 缺它则 document-controller 的 ./remote|./typert 产物生成不出来（verify-node-next-types 红）。
  ".oxlintrc.json", ".oxlintrc.next.json", "tsconfig.host.json",
]
/** scripts/ 死链探针子目录：整目录硬编码私有 forge-* / dsh-* 路径，公开仓无这些包 ⇒ 全是死链，不导出。 survey: docs/memory/scripts-inventory-2026-11-08.md。 */
const SCRIPTS_EXCLUDE = [
  "scripts/qoder-probe/",   // 26/28 文件 import <repo>/forge-qoder-direct/lib/protocol.js（私有老树，不进公开仓）
  "scripts/iss1268/",       // ISS-594 一次性调研：硬编码 forge-* 私有路径，无门禁角色
  "scripts/plan-analysis/", // 订阅档位比价一次性探针：硬编码外部绝对路径 + dsh-authorization，无门禁角色
]
const TOKEN_RE = /(?:ISS|PRJ)-[1-9][0-9]{3,}/g
const ABS_RE = /\/Users\/dylan/

/**
 * 绝对路径归一规则——从 scripts/ 77 文件抽样 10 种形态后定的**显式最长优先前缀表**，
 * 不是正则一把梭：每条前缀来自实测，顺序敏感（更具体的先替，避免 .dsh 吞掉 .dsh-matter）。
 * 末条兜底保证任何残留 <home> 都被换掉；grepAbsPaths 再断言归零。
 */
const ABS_PATH_RULES = [
  ["<wt>", "<wt>"],
  ["<repo>", "<repo>"],
  ["<dsh-b>", "<dsh-b>"],
  ["<dsh>", "<dsh>"],
  ["<home>/.dsh-matter", "<home>/.dsh-matter"],
  ["<home>/.dsh-b", "<home>/.dsh-b"],
  ["<home>/.dsh", "<home>/.dsh"],
  ["<home>/.npm-global", "<home>/.npm-global"],
  ["<home>/opencode", "<home>/opencode"],
  ["<home>/node_modules", "<home>/node_modules"],
  ["<home>", "<home>"],
]
/** 5 个抽样文件的真实行前后对照（含最长优先边界 .dsh-matter / dsh-local-b），跑在 main 开头，漂移即停。 */
const ABS_PATH_SELFTEST = [
  ["<repo>/forge-agents", "<repo>/forge-agents"],
  ["<dsh>/node_modules/@deepseek-ai/cordis/lib/index.js", "<dsh>/node_modules/@deepseek-ai/cordis/lib/index.js"],
  ["<home>/.dsh-matter/profiles/node_modules/@deepseek-ai/x/lib/index.js", "<home>/.dsh-matter/profiles/node_modules/@deepseek-ai/x/lib/index.js"],
  ["<wt>/ISS-870/scripts/x.mjs", "<wt>/ISS-870/scripts/x.mjs"],
  ["<home>/.dsh/watchdog.log", "<home>/.dsh/watchdog.log"],
  ["<dsh-b>", "<dsh-b>"],
]

/** 逐条显式前缀替换（非正则一把梭）；返回归一后文本。 */
function washAbsPaths(text) {
  for (const [from, to] of ABS_PATH_RULES) {
    if (text.includes(from)) text = text.split(from).join(to)
  }
  return text
}

/** 自测：抽样 5+ 例的前后对照，任一漂移即 fail（规则改了必须同步改这里）。 */
function selftestAbsPaths() {
  for (const [input, expect] of ABS_PATH_SELFTEST) {
    const got = washAbsPaths(input)
    if (got !== expect) fail(`绝对路径归一自测失败：${input} → ${got}（期望 ${expect}）`)
  }
  return ABS_PATH_SELFTEST.length
}

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes(name)

function fail(msg, code = 1) {
  console.error(`✗ sync-public: ${msg}`)
  process.exit(code)
}
function sha(buf) { return crypto.createHash("sha256").update(buf).digest("hex") }

/** 白名单导出：git archive <target> -- packages/ <8 根件> scripts/ apps/ → 解到 staging，再剔除死链探针子目录。 */
function exportWhitelist(target, staging) {
  fs.mkdirSync(staging, { recursive: true })
  const args = ["-C", REPO, "archive", target, "--", "packages", ...ROOT_SCAFFOLD, "scripts", "apps"]
  const arc = spawnSync("git", args, { maxBuffer: 1 << 28 })
  if (arc.status !== 0) fail(`git archive ${target} 失败：${arc.stderr?.toString().slice(0, 400)}`)
  const tar = spawnSync("tar", ["-x", "-C", staging], { input: arc.stdout, maxBuffer: 1 << 28 })
  if (tar.status !== 0) fail(`tar 解包失败：${tar.stderr?.toString().slice(0, 400)}`)
  // 剔除在 export 之后、洗脱之前：archive pathspec 的 exclude 魔法在老 git 上不稳，落地后按目录删更可核。
  for (const d of SCRIPTS_EXCLUDE) {
    const p = path.join(staging, d)
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
  }
}

/** 递归列文件（相对 staging，/ 分隔）。 */
function walk(root, prefix = "") {
  const out = []
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(path.join(root, e.name), rel))
    else if (e.isFile()) out.push(rel)   // 跳过软链/special（pnpm 装完 node_modules 里有软链，readFileSync 会踩）
  }
  return out
}
const isBinary = (buf) => buf.includes(0)

/** ② 洗脱：mapping 为唯一真相源；未知 token 即停（禁临时编号/禁重算）。同时归一绝对路径。 */
function wash(root, mapping) {
  const tokensSeen = new Map()
  let filesChanged = 0
  let filesAbsChanged = 0
  for (const rel of walk(root)) {
    const p = path.join(root, rel)
    const raw = fs.readFileSync(p)
    if (isBinary(raw)) continue
    const text = raw.toString("utf8")
    const found = [...new Set(text.match(TOKEN_RE) ?? [])]
    for (const t of found) {
      if (!mapping[t]) fail(`映射缺失：源里出现 ${t} 但 mapping 无条目——先按 append-only 追加映射再跑（禁临时编号/重排）`)
      tokensSeen.set(t, (tokensSeen.get(t) ?? 0) + 1)
    }
    let next = text
    // 长 token 先替，避免前缀吞并（ISS-927 含 ISS-545 前缀）
    for (const t of found.sort((a, b) => b.length - a.length)) next = next.split(t).join(mapping[t])
    // 绝对路径归一：即使没有 4+ token 的文件也要洗（77 文件与 token 面不重叠）
    next = washAbsPaths(next)
    if (next !== text) {
      fs.writeFileSync(p, next)
      filesChanged++
      if (washAbsPaths(text) !== text) filesAbsChanged++
    }
  }
  return { tokensSeen, filesChanged, filesAbsChanged }
}

/** 洗脱后 4+ 归零断言。 */
function grep4plus(root) {
  const hits = []
  for (const rel of walk(root)) {
    if (rel.startsWith(".git/") || rel.includes("/node_modules/") || rel.startsWith("node_modules/") || rel.includes("/lib/")) continue
    const raw = fs.readFileSync(path.join(root, rel))
    if (isBinary(raw)) continue
    const lines = raw.toString("utf8").split("\n")
    lines.forEach((ln, i) => { if (TOKEN_RE.test(ln)) hits.push(`${rel}:${i + 1}`); TOKEN_RE.lastIndex = 0 })
  }
  return hits
}

/** 洗脱后绝对路径（<home>）归零断言（新增自证）。sub 非空时只扫该前缀（如 "apps/"）。 */
function grepAbsPaths(root, sub = "") {
  const hits = []
  for (const rel of walk(root)) {
    if (sub && !rel.startsWith(sub)) continue
    if (rel.startsWith(".git/") || rel.includes("/node_modules/") || rel.startsWith("node_modules/") || rel.includes("/lib/")) continue
    const raw = fs.readFileSync(path.join(root, rel))
    if (isBinary(raw)) continue
    raw.toString("utf8").split("\n").forEach((ln, i) => { if (ABS_RE.test(ln)) hits.push(`${rel}:${i + 1}`) })
  }
  return hits
}

/** ③ vitest.config.ts apps/ 适配：4 块精确替换，每块命中恰 1 次；漂移即 fail。 */
const VITEST_PATCH = [
  {
    name: "WEB_ALIASES import + 注释",
    from: 'import ts from "typescript"\n// ISS-537 / P4-S1：浏览器壳 smoke 测试在 apps/web/tests/。与 client 包共用同一份 alias\n// （apps/web/aliases.ts）——裸 @matter/* 与 cordis 从 apps/ 向上无 pnpm 链接，须显式解析到源。\nimport { WEB_ALIASES } from "./apps/web/aliases.ts"\n',
    to: 'import ts from "typescript"\n',
  },
  {
    name: "resolve.alias + 注释",
    from: '  // ISS-537：壳静态 import 的 @matter/* client 面 + cordis 从 apps/ 向上无 pnpm 链接，\n  // 与 vite.config 共用同一份 alias 解析到源文件（甲形态无运行时注入层）。\n  resolve: { alias: [...WEB_ALIASES] },\n',
    to: '',
  },
  {
    name: "apps tests include + 注释",
    from: '      // ISS-537 / P4-S1：浏览器壳 smoke（apps/web/tests/boot.test.tsx）。不收进来则\n      // 「壳能渲染」这条永远没跑且屏幕上没有任何一行说没跑——同 ISS-505 漏 .mjs 形态。\n      "apps/*/tests/**/*.test.{ts,tsx}",\n',
    to: '',
  },
  {
    // scripts/ 单测是**判据自身的私有夹具**（依赖 forge-* / HOME 软链 / 主 checkout 布局）——
    // 公开仓无这些事实，跑必红；公开面只验 packages 产品测试，scripts 门禁由 CI gates lane 走 run-gates。
    name: "scripts tests include（私有夹具，公开面不跑）",
    from: '      "scripts/**/*.test.mjs",\n',
    to: '',
  },
  {
    name: "CSS 块内 apps 注释行",
    from: '    //    apps/web/tests/content-flow.test.ts 断言其长度 > 0 且含 `.bn-` 标记。\n',
    to: '',
  },
]
function patchVitest(root) {
  const p = path.join(root, "vitest.config.ts")
  if (!fs.existsSync(p)) fail("根件漂移：vitest.config.ts 不在导出白名单里")
  let text = fs.readFileSync(p, "utf8")
  for (const blk of VITEST_PATCH) {
    const n = text.split(blk.from).length - 1
    if (n !== 1) fail(`根件漂移：vitest patch「${blk.name}」命中 ${n} 次（应恰 1）——vitest.config.ts 已变，需重新核对 patch 块`)
    text = text.replace(blk.from, blk.to)
  }
  if (/apps\//.test(text)) fail("根件漂移：vitest.config.ts patch 后仍有 apps/ 引用")
  fs.writeFileSync(p, text)
  return VITEST_PATCH.length
}

/** ④ 新写五件（内容固定，逐字沿用 ISS-902 快照 + 第 5 件公开仓 CI）。 */
function newWriteFiles(root) {
  const pkg = {
    name: "matter", version: "0.0.0", private: true, type: "module",
    engines: { node: ">=24.9.0" }, packageManager: "pnpm@11.28.5",
    scripts: {
      typecheck: "tsc -b tsconfig.next.json",
      // ISS-930：与私有根 build 同序——先源-only 生成 typert 产物（document-controller 的
      // ./typert|./remote 依赖），再 tsc + tsdown。缺第一段则公开仓那些子路径导出解析红。
      build: "node --strip-types scripts/generate-typert.ts && tsc -b tsconfig.next.json && tsdown",
      test: "vitest run", lint: "oxlint",
    },
    devDependencies: {
      // ISS-539 (5ec96711→000891aa)：根件 tsdown.config.ts 新增 decoratorPlugin 导入，
      // 瘦身后必须带这个公开发布的同族包，否则 build 段的 tsdown 解析红（impl-2319 报备）。
      "@deepseek-ai/dsh-typert-generator": "0.2.2-rc.2",
      "@deepseek-ai/dsh-client-ui-primitives": "0.2.2-rc.2",
      "@testing-library/dom": "^10.4.1",
      "@testing-library/react": "^16.3.3",
      "@types/node": "^22.20.1",
      "@types/react": "^18.3.1",
      "@vitest/coverage-v8": "4.1.8",
      clsx: "^2.1.1",
      jsdom: "29.1.1",
      oxlint: "1.76.0",
      react: "18.3.1",
      "react-dom": "18.3.1",
      tsdown: "0.22.2",
      typescript: "6.0.3",
      vitest: "4.1.8",
    },
    overrides: { "@deepseek-ai/cordis": "4.1.0" },
  }
  const license = `MIT License

Copyright (c) 2026 The Matter Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
  const readme = `# Matter

Matter connects the digital and physical worlds — a tool for humans and agents to work together.

## Commands

Install first: \`pnpm install\`.

\`\`\`sh
pnpm run typecheck    # type-check all packages
pnpm run test         # run unit tests
pnpm run build        # build all packages
pnpm run lint         # static checks
\`\`\`

## Layout

\`\`\`
packages/            self-owned packages (@matter/<name>), at packages/<group>/<pkg>/
  api/               interface layer (Remote RPC controllers)
  client/            frontend (theme tokens · block editor · knowledge-base UI)
  kb/                knowledge base (document domain · block engine)
  pm/                task line (issue · project)
  storage/           data storage (JSON entities · SQLite events · search)
\`\`\`
`
  const gitignore = "node_modules/\npackages/**/lib/\n*.tsbuildinfo\n.bun-tmp/\n.npm-cache/\ncoverage\n"
  const ci = `# Public-repo CI — minimal three lanes (build / typecheck / test).
# Public Actions minutes are unlimited; this covers the packages/** whitelist only.
# Private-repo five-lane orchestration (gates / doc-sync / coverage / gate-selftests) stays private.
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.13.1
      - name: Install pnpm
        run: corepack enable && corepack prepare pnpm@11.28.5 --activate
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.13.1
      - name: Install pnpm
        run: corepack enable && corepack prepare pnpm@11.28.5 --activate
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.13.1
      - name: Install pnpm
        run: corepack enable && corepack prepare pnpm@11.28.5 --activate
      - run: pnpm install --frozen-lockfile
      # 包入口是 build 产物 lib/index.js（不在版本库、被 .gitignore 排除）——
      # 没有前置 build，test lane 解析 @matter/* 入口即红。
      - run: pnpm run build
      - run: pnpm run test
  gates:
    runs-on: ubuntu-latest
    # 公开仓 gates lane。冷 checkout 无 lib/ 产物 —— 与 test lane 同例，先 build 再跑门禁。
    # 档位 = next（22 格，实测 10s 量级）；公开仓 export 面=packages/**+scripts/**，
    # 缺失的根配置（.oxlintrc*.json）/ 文档语料 依赖的格在该档判不了或红，详见本单 note 的「判据落差」。
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.13.1
      - name: Install pnpm
        run: corepack enable && corepack prepare pnpm@11.28.5 --activate
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - name: Gate tier (next)
        run: node scripts/run-gates.mjs --tier next
`
  const files = {
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    LICENSE: license,
    "README.md": readme,
    ".gitignore": gitignore,
    ".github/workflows/ci.yml": ci,
  }
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return Object.keys(files)
}

/** staging → out：删除已在上游移除的旧白名单文件，再逐文件覆盖；node_modules / pnpm-lock / .git 不动。 */
function syncToOut(staging, out) {
  fs.mkdirSync(out, { recursive: true })
  let tracked
  try { tracked = execFileSync("git", ["-C", out, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean) }
  catch { tracked = [] }
  const stageSet = new Set(walk(staging))
  const excluded = (rel) => SCRIPTS_EXCLUDE.some((d) => rel.startsWith(d))
  for (const rel of tracked) {
    const inWhitelist = rel.startsWith("packages/") || rel.startsWith("scripts/") || rel.startsWith("apps/") || ROOT_SCAFFOLD.includes(rel)
    if (inWhitelist && !excluded(rel) && !stageSet.has(rel)) {
      const p = path.join(out, rel)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
  }
  for (const rel of walk(staging)) {
    const p = path.join(out, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.copyFileSync(path.join(staging, rel), p)
  }
}

/** 快照内容摘要：只覆盖本次同步写的白名单面 + 新写五件（node_modules / pnpm-lock / lib 不计）。 */
function snapshotDigest(out) {
  const surf = []
  for (const rel of walk(out)) {
    if (rel.startsWith("node_modules/") || rel.includes("/node_modules/") || rel === "pnpm-lock.yaml") continue
    if (rel.includes("/lib/") || rel.endsWith(".tsbuildinfo")) continue
    if (rel.startsWith(".git/")) continue
    surf.push(rel)
  }
  surf.sort()
  const h = crypto.createHash("sha256")
  for (const rel of surf) { h.update(rel); h.update("\0"); h.update(fs.readFileSync(path.join(out, rel))) }
  return { digest: h.digest("hex"), files: surf.length }
}

/** ⑤ 五件自证：install / build / typecheck / vitest / 13 模式密钥扫描 / 4+ grep。 */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 27 })
  return { rc: r.status, out: (r.stdout || "") + (r.stderr || "") }
}
function attest(out) {
  const results = []
  const pnpm = process.env.PNPM_BIN || path.join(os.homedir(), ".npm-global/lib/node_modules/pnpm/bin/pnpm.cjs")
  if (!fs.existsSync(pnpm)) fail(`找不到 pnpm：${pnpm}（设 PNPM_BIN 覆盖）`)

  // pnpm 不在 PATH（本机实测 which pnpm 为空）—— install/build/typecheck/test 一律走显式 cjs 路径，
  // 避免 spawnSync ENOENT 被当成「红但无输出」的假失败（无法诊断）。
  let r = run(process.execPath, [pnpm, "install"], out)
  results.push({ gate: "install", rc: r.rc, detail: r.rc === 0 ? "EXIT 0" : r.out.slice(-300) })
  if (r.rc !== 0) return results

  r = run(process.execPath, [pnpm, "run", "build"], out)
  results.push({ gate: "build", rc: r.rc, detail: r.rc === 0 ? "EXIT 0" : r.out.slice(-300) })
  if (r.rc !== 0) return results

  r = run(process.execPath, [pnpm, "run", "typecheck"], out)
  results.push({ gate: "typecheck", rc: r.rc, detail: r.rc === 0 ? "EXIT 0" : r.out.slice(-300) })
  if (r.rc !== 0) return results

  r = run(process.execPath, [pnpm, "run", "test"], out)
  const tm = r.out.match(/Test Files\s+([^\n]+)/)
  const tests = r.out.match(/\bTests\s+([^\n]+)/)
  results.push({ gate: "vitest", rc: r.rc, detail: `EXIT ${r.rc}${tm ? " · " + tm[1].trim() : ""}${tests ? " · " + tests[1].trim() : ""}` })
  if (r.rc !== 0) return results

  r = secretScan(out)
  results.push({ gate: "secret-scan", rc: r.rc, detail: r.detail })
  const g = grep4plus(out)
  results.push({ gate: "4plus-grep", rc: g.length ? 1 : 0, detail: g.length ? `${g.length} 命中：${g.slice(0, 5).join("、")}` : "0 命中" })
  if (g.length) return results
  const a = grepAbsPaths(out)
  results.push({ gate: "abs-grep", rc: a.length ? 1 : 0, detail: a.length ? `${a.length} 命中：${a.slice(0, 5).join("、")}` : "<home> 0 命中（全树）" })
  const aa = grepAbsPaths(out, "apps/")
  results.push({ gate: "apps-abs-grep", rc: aa.length ? 1 : 0, detail: aa.length ? `${aa.length} 命中：${aa.slice(0, 5).join("、")}` : "apps/ 下 <home> 0 命中" })
  return results
}

/** 13 模式（ISS-901 官方 6 + 扩展 7；ISS-902 实跑 14 条的同一张表）密钥扫描。 */
const SECRET_PATTERNS = [
  ["长 user_ 令牌", /user_[A-Za-z0-9]{40,}/],
  ["sk- 形式 API key", /sk-[A-Za-z0-9_.-]{30,}/],
  ["方舟 ark- key", /ark-[0-9a-f-]{30,}/],
  ["tp-c4i4 前缀令牌", /tp-c4i4[A-Za-z0-9]+/],
  ["JWT(HS256) 头", /[e][y]JhbGciOiJIUzI1NiIsInR5/],
  ["AWS AKIA", /AKIA[0-9A-Z]{16}/],
  ["EXT ghp_ GitHub PAT", /ghp_[A-Za-z0-9]{36}/],
  ["EXT gho_ GitHub OAuth", /gho_[A-Za-z0-9]{36}/],
  ["EXT github_pat_ fine-grained", /github_pat_[A-Za-z0-9_]{22,}/],
  ["EXT Slack xox", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["EXT Google API AIza", /AIza[0-9A-Za-z_-]{35}/],
  ["EXT private key header", /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE/],
  ["EXT DB/AMQP conn uri w/ creds", /(postgres|postgis|mysql|mongodb(\+srv)?|redis|rediss|amqp):\/\/[^\s:@/'\"]+:[^\s@/'\"]+@/],
  ["EXT secret assignment", /(password|passwd|secret|token|apikey|api_key)\s*[:=]\s*["'][^"']{8,}["']/i],
]
const PLACEHOLDER = /^sk[-_]([A-Za-z0-9]+)(.*)$/
const PW = new Set(["test", "tests", "fake", "dummy", "sample", "example", "placeholder", "mock", "demo", "redacted", "invalid"])
/** 引用形态（非明文 secret）——与本仓 `scripts/runtime-secret-check.mjs` 自测的「干净态」同口径。 */
const REF_VALUE = /^(ref|env):[A-Za-z_][A-Za-z0-9_]*$/
function isPlaceholder(tok) {
  // EXT secret assignment 模式匹配的是整条 `apiKey: "..."`，不是裸值——须把引号里的值也拿出来判，
  // 否则 selftest 假值夹具会在公开仓被误报成真 secret（scripts/ 进白名单后暴露）。
  const candidates = [tok]
  const q = /["']([^"']+)["']\s*$/.exec(tok)
  if (q) candidates.push(q[1])
  for (const c of candidates) {
    const m = PLACEHOLDER.exec(c)
    if (m) {
      const seg = m[1].toLowerCase()
      if (PW.has(seg) || /^x+$/.test(seg)) return true
    }
    if (REF_VALUE.test(c)) return true
  }
  return false
}
function secretScan(root) {
  const hits = []
  let scanned = 0, exempt = 0
  for (const rel of walk(root)) {
    if (rel.startsWith(".git/") || rel.includes("/node_modules/") || rel.startsWith("node_modules/") || rel.includes("/lib/")) continue
    const raw = fs.readFileSync(path.join(root, rel))
    if (isBinary(raw)) continue
    scanned++
    raw.toString("utf8").split("\n").forEach((ln, i) => {
      for (const [name, re] of SECRET_PATTERNS) {
        // 模式表正则不带 g（供 .test 形态复用）；matchAll 要求 global ⇒ 现场加 g 克隆。
        const gre = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
        for (const m of ln.matchAll(gre)) {
          if (isPlaceholder(m[0])) exempt++
          else hits.push(`${rel}:${i + 1} [${name}]`)
        }
      }
    })
  }
  return {
    rc: hits.length ? 1 : 0,
    detail: `EXIT ${hits.length ? 1 : 0} · ${SECRET_PATTERNS.length} 模式 · ${scanned} 文本文件 · ${hits.length} 真命中 · ${exempt} 占位豁免${hits.length ? "：" + hits.slice(0, 5).join("、") : ""}`,
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
function main() {
  const target = arg("--target", DEFAULT_TARGET)
  const out = path.resolve(arg("--out", DEFAULT_OUT))
  const doAttest = !has("--no-attest")
  const doPush = has("--push")
  const remote = arg("--remote", DEFAULT_REMOTE)

  if (out === REPO || out.startsWith(REPO + path.sep)) fail(`--out 不能落在私有仓内（${out} 在 ${REPO} 内）`)
  if (!fs.existsSync(MAPPING_FILE)) fail(`缺映射文件 ${MAPPING_FILE}`)
  const selftestCount = selftestAbsPaths()

  const mappingBefore = crypto.createHash("sha256").update(fs.readFileSync(MAPPING_FILE)).digest("hex")
  const doc = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"))
  const mapping = doc.mapping
  if (!mapping || typeof mapping !== "object") fail("mapping.json 缺 mapping 对象")

  // target 必须是 ref/commit
  const rv = spawnSync("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", `${target}^{commit}`])
  if (rv.status !== 0) fail(`target 不是有效 ref/commit：${target}`)
  const targetSha = execFileSync("git", ["-C", REPO, "rev-parse", target], { encoding: "utf8" }).trim()

  console.log(`sync-public · target=${target}@${targetSha.slice(0, 8)} · out=${out} · mode=${doPush ? "PUSH" : "dry-run"}`)

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "sync-public-"))
  try {
    exportWhitelist(target, staging)
    // patch 必须在洗脱之前：patch 块含 ISS-537/2313 原文，洗脱会先把它们换成小号段 ⇒ 命中 0。
    const patched = patchVitest(staging)
    const washRes = wash(staging, mapping)
    const written = newWriteFiles(staging)
    const g = grep4plus(staging)
    if (g.length) fail(`洗脱后仍有 ${g.length} 处 4+ 引用：${g.slice(0, 5).join("、")}`)
    const absHits = grepAbsPaths(staging)
    if (absHits.length) fail(`洗脱后仍有 ${absHits.length} 处 <home> 绝对路径：${absHits.slice(0, 5).join("、")}`)
    const appsAbsHits = grepAbsPaths(staging, "apps/")
    if (appsAbsHits.length) fail(`洗脱后 apps/ 仍有 ${appsAbsHits.length} 处 <home> 绝对路径：${appsAbsHits.slice(0, 5).join("、")}`)

    const mappingAfter = crypto.createHash("sha256").update(fs.readFileSync(MAPPING_FILE)).digest("hex")
    if (mappingAfter !== mappingBefore) fail("映射文件在跑中被改动（漂移）——脚本必须只读 mapping")
    void mappingAfter

    syncToOut(staging, out)
    const dg = snapshotDigest(out)

    console.log(`① 白名单导出：packages/** + scripts/**（排除 ${SCRIPTS_EXCLUDE.length} 死链探针目录）+ apps/** + ${ROOT_SCAFFOLD.length} 根件`)
    console.log(`② 洗脱：${washRes.tokensSeen.size} 个 token / ${washRes.filesChanged} 文件（绝对路径归一 ${washRes.filesAbsChanged} 文件）· 自测 ${selftestCount} 例 · mapping 只读 SHA256=${mappingBefore.slice(0, 12)}（跑前=跑后）`)
    console.log(`③ vitest patch：${patched} 块命中各 1 次 · apps/ 归零`)
    console.log(`④ 新写五件：${written.join(" / ")}`)
    console.log(`⑤ 4+ grep：0 · <home> grep：0 · SNAPSHOT_DIGEST=${dg.digest} (${dg.files} files)`)

    if (doAttest) {
      const results = attest(out)
      for (const r of results) console.log(`   [${r.rc === 0 ? "PASS" : "FAIL"}] ${r.gate}: ${r.detail}`)
      const reds = results.filter((r) => r.rc !== 0)
      if (reds.length) fail(`自证 ${reds.length} 件失败：${reds.map((r) => r.gate).join("、")}`)
    } else {
      console.log("⑤ 自证：--no-attest 跳过（查漂移专用）")
    }

    if (doPush) {
      const actualRemote = execFileSync("git", ["-C", out, "remote", "get-url", "origin"], { encoding: "utf8" }).trim()
      if (!actualRemote.includes("Ding1977/matter") && actualRemote !== remote) {
        fail(`--push 拒绝：快照 origin=${actualRemote} 不像公开仓（期望含 Ding1977/matter；--remote 需匹配）`)
      }
      const add = spawnSync("git", ["-C", out, "add", "-A"]); if (add.status !== 0) fail("git add 失败")
      const cm = spawnSync("git", ["-C", out, "commit", "-m", `chore: sync public snapshot to ${targetSha.slice(0, 8)} (ISS-904 mechanism)`], { encoding: "utf8" })
      if (cm.status !== 0 && !/nothing to commit/.test(cm.stdout || "")) fail(`git commit 失败：${cm.stderr?.toString().slice(0, 300)}`)
      const pu = spawnSync("git", ["-C", out, "push", "origin", "main"], { encoding: "utf8" })
      if (pu.status !== 0) fail(`git push 失败：${pu.stderr?.toString().slice(0, 400)}`)
      console.log("⑥ --push：已提交并推送公开仓 main（单根演进，不携私有历史）")
    } else {
      console.log("⑥ --push：dry-run 未推（Lead 收口执行首推）")
    }
    console.log("✓ sync-public 完成")
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

main()
