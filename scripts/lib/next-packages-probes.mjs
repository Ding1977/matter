/**
 * `next` 档「判不了」资源探测器（ISS-835）。
 *
 * ## 为什么单独一个文件
 * `scripts/run-gates.mjs` 已被 `verify-file-size` 棘轮钉在 2056 行（当前 2045，余 11 行）。
 * 六个探测器塞不进去，抬上限又被棘轮判红（「已入册也只许降」）⇒ 按本仓既有惯例落到 `scripts/lib/`
 * （`unjudged-note.mjs` / `bun-bin.mjs` / `pm-root.mjs` 同一形态）。
 *
 * ## 为什么是 7 个而不是 1 个（本单的核心发现）
 * 工单原本要求 8 格共用 `needs:next-packages`，探测「`packages/*\/*\/package.json` **或** `src` 存在 ≥1」。
 * 实测（`--check` 口径，与 `run-gates` 派发一致）**这个 OR 会造出假化石**：
 *
 * | `packages/x/y/` 里有什么 | shape | complexity | layer-new | CDG | gen-layer | entry-exp | dead-code | file-size |
 * |---|---|---|---|---|---|---|---|---|
 * | 什么都没有（真实态） | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
 * | 只有 `package.json` | **1** | **2** | **1** | **2** | **1** | **2** | **2** | **2** |
 * | 只有 `src/foo.ts` | **2** | **0** | **2** | **2** | **2** | **2** | **0** | **2** |
 *
 * （2 = `unjudged(no-corpus)`，0/1 = 已判）。只造 manifest 时，单探针答 true，
 * 而 complexity / CDG / entry-exports / dead-code / file-size **仍在判不了**
 * ⇒ `xfail_strict` 把这 5 格判成「豁免成了化石」= 假红，恰好把本单要的第三态又打回红。
 * 反过来只造 `src/*.ts` 时，manifest 派系（shape / layer-new / gen-layer）成了假化石。
 *
 * **一个布尔值无法同时等于三个不同的条件。** 判不了的条件实测有三类：
 *   · 要 `packages/<g>/<p>/package.json`（走 manifest 发现）
 *   · 要 `.ts/.tsx` 语料（fs 遍历，**不要求** manifest）
 *   · 要更窄的形态 / 已入 git 索引
 * 所以按「判据问什么就探什么」拆成 7 个资源名，逐格对齐。每个公式下面注明它抄的是哪个判据的哪一行。
 *
 * 第 7 个 `next-build` 是 ISS-868 补的：上面 6 个探的全是「源码 / manifest / git 索引」这类**语料**，
 * 没有一个问**构建产物**。而 `verify-coverage-collect` 的 `no-build` 分支缺的是 `lib/index.js` ——
 * 拿语料探针代打，语料在就判成化石。一句话：**「源码在」不等于「跑得起来」**。
 *
 * ## 探测写法的约束
 * 返回 true = 资源在。**探不到一律 false**（保守：不冒充化石，宁可疑判不了也不制造假红）。
 * 不 import 各 gate 的 `.ts`（避免调度器依赖 node 类型擦除、也避免判据模块的加载副作用）。
 * 公式与判据源逐条对照，漂移风险用 ledger 的 `note` + `expires` 兜。
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"

/** `packages/` 下两层（group/pkg）的目录名。跳过点目录与 node_modules（同各判据的 SKIP 口径）。 */
function twoLevelDirs(repo) {
  const base = path.join(repo, "packages")
  const out = []
  let groups
  try {
    groups = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return out
  }
  for (const g of groups) {
    if (!g.isDirectory() || g.name.startsWith(".") || g.name === "node_modules") continue
    let pkgs
    try {
      pkgs = fs.readdirSync(path.join(base, g.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const p of pkgs) {
      if (!p.isDirectory() || p.name.startsWith(".") || p.name === "node_modules") continue
      out.push({ key: `${g.name}/${p.name}`, dir: path.join(base, g.name, p.name) })
    }
  }
  return out
}

/** 目录下是否有 `.ts/.tsx`（递归，跳过 node_modules / dist / 点目录 / 符号链接）。 */
function hasTs(dir, depth = 0) {
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of ents) {
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue
      if (depth < 4 && hasTs(path.join(dir, e.name), depth + 1)) return true
    } else if (e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      return true
    }
  }
  return false
}

export const NEXT_PACKAGE_PROBES = {
  /**
   * `verify-plugin-shape` / `lint-layer-new` / `gen-layer-graph` —— 三格判不了的条件同一句：
   * 「`packages/<group>/<pkg>/package.json` 一个都没扫到」。
   * 出处：verify-plugin-shape.ts:168 · lint-layer-new.ts:406-412 · gen-layer-graph.ts:439-447
   * （后两者共走 `discoverPackages()`，它 `if (!fs.existsSync(manifest)) continue`）。
   */
  "next-manifest": (repo) => twoLevelDirs(repo).some((p) => fs.existsSync(path.join(p.dir, "package.json"))),

  /**
   * `lint-complexity` —— 判不了条件 =「`packages/` 下 0 个 `.ts/.tsx`」。
   * 出处：lint-complexity.ts:122-146 `collectCorpus()`：**整个 `packages/` 递归**，不限 `<g>/<p>/src`，
   * 也不要求 manifest ⇒ 只造 `packages/x/y/foo.ts`（无 src 无 manifest）它就能判（实测 EXIT=0）。
   */
  "next-ts-corpus": (repo) => hasTs(path.join(repo, "packages")),

  /**
   * `verify-coverage-collect` —— 判不了的两个条件（verify-coverage-collect.ts:155-181）：
   *   ① `no-binary`：`node_modules/.bin/vitest` 不存在
   *   ② `no-build`：这次 `vitest run packages/storage --coverage` 跑不起来，
   *      且尾部报 `Failed to resolve entry` / `Cannot find (module|package)`
   * ⇒ 缺的料是**构建产物**，不是语料。本探针只答 ② 的一半（`lib/index.js` 在不在）；
   *   ①（没装依赖）由 `next-ts-corpus` 那族与 `no-binary` 自己的分支覆盖。
   *
   * ## 为什么是 `.every()` 而不是 `.some()`（本探针的唯一要命的细节）
   * 判据的退 2 条件是「**这次** `vitest run packages/storage` **整批**跑不起来」
   * （`DEFAULT_ARGS = ["run","packages/storage","--coverage"]`，一个进程跑全部 4 个包）。
   * 任何一个包缺 `lib/index.js` ⇒ 依赖它的测试 import 失败 ⇒ **整批**报错 ⇒ 退 2
   * ⇒ 探针就该问「**每个**包都有 lib」。
   * 实测（主检出 ISS-868 建树当天）：storage 有 / storage-json 有 / storage-domain 无 / storage-journal 无
   *   · `.every()` ⇒ false ⇒ 判「不够判」⇒ unjudged 且不报化石 ✓（这正是本单要的）
   *   · `.some()`  ⇒ true  ⇒ 判「资源在」⇒ **仍报化石**，本单白做 ✗
   *
   * ## 为什么必须显式判 `pkgs.length > 0`
   * `.every()` 对空数组返回 `true` ⇒ 零包的仓库会被判成「构建产物齐了」⇒ 假化石。
   * 「一个包都没有」是 `next-manifest` 的活，不是本探针的。
   *
   * ⚠️ `lib/` 是 `.gitignore` 的产物（`.gitignore:131-133`），跟着构建走、不跟着 clone 走
   * ⇒ 本探针在 CI 上为 true 只在 `pnpm run build` 之后（ci.yml 的 next lane 正是这个顺序）。
   */
  "next-build": (repo) => {
    const pkgs = twoLevelDirs(repo)
    return pkgs.length > 0 && pkgs.every((p) => fs.existsSync(path.join(p.dir, "lib", "index.js")))
  },

  /**
   * `lint-dead-code` —— 判不了条件比上面**窄一层**：语料是 `packages/<group>/<pkg>/src/**`。
   * 出处：lint-dead-code.ts:262-271 `collectFiles()`（固定两段包位置 + 必带 `src/`）。
   * ⇒ `packages/x/y/foo.ts`（无 src）它仍判不了，故不能与 complexity 共用一个探测。
   */
  "next-src-corpus": (repo) => twoLevelDirs(repo).some((p) => hasTs(path.join(p.dir, "src"))),

  /**
   * `verify-client-domain-graph` —— 判不了条件 =「`packages/<group>/<pkg>/src/client` 一个都没扫到」。
   * 出处：verify-client-domain-graph.ts:251-268 `scanClientPackages()`（`statSync(<pkg>/src/client)` 不存在即 continue）。
   */
  "next-client-corpus": (repo) => twoLevelDirs(repo).some((p) => hasTs(path.join(p.dir, "src", "client"))),

  /**
   * `verify-plugin-entry-exports` —— 这一格有**两种** unjudged，且第二种不是「缺资源」：
   *   ① :465 `ENTRY_GLOB`（`packages/*\/*\/src/index.ts`）一个都没扫到
   *   ② :471 扫到入口，但**函数插件与服务插件都是 0**（全被判成库）⇒ 分类器健康度
   * 只探 `src/index.ts` 在不在会在 ② 上答 true 而判据仍报 unjudged ⇒ **假化石**（ISS-835 实测 S4：
   * 造一个 `export const a=1` 的 `src/index.ts`，gate=2 而朴素探测=T）。故这里**委托判据自己的分类器**，
   * 与该格 `judgeEntryExports` 走到同一结论：只有它真能判（status≠unjudged）才答 true。
   *
   * 为什么这里允许跨层 import（其它 5 个探测不复用 gate 代码）：只有这一格的「资源」
   * 不是纯文件存在性，而是「文件 + 分类器能分出插件」的合取。复述分类逻辑等于复制一份必然腐坏的副本；
   * 判据已 `export` 了 `loadTs` / `scanEntries` / `judgeEntry`（verify-plugin-entry-exports.ts:509/536/391），
   * 本就是给外部复用的口子。代价：要加载 typescript（~110ms，实测三次 113/134/113ms），
   * 且只在 unjudged 路径上调用一次 —— 不进热路径。
   */
  "next-entry-corpus": (repo) => {
    let m
    try {
      const req = createRequire(path.join(repo, "package.json"))
      m = req(path.join(repo, "scripts", "gates", "verify-plugin-entry-exports.ts"))
    } catch {
      return false // 加载不了（node 版本 / 文件形态）⇒ 按缺料算，不冒充化石
    }
    try {
      const input = m.scanEntries(repo)
      if (input.entries.length === 0) return false // ①
      const ts = m.loadTs(repo)
      if (!ts) return false
      const verdicts = input.entries.map((e) => m.judgeEntry(ts, e, input))
      // ② 判据的核心射程要求至少判到一个真插件；全是库 ⇒ 判不了（分类器可能坏了）
      return verdicts.some((v) => v.form === "function" || v.form === "service")
    } catch {
      return false
    }
  },

  /**
   * `verify-file-size-new` —— 判不了条件 =「扫到 0 个候选文件」，而它走 **`git ls-files`**：
   * 未 `git add` 的新文件不在射程（verify-file-size-new.ts:192-200 头注已自认这是已知边界）。
   * 所以这一格必须真问 git，不能拿上面任何一个 fs 探测代打 —— 实测未入索引时有 `.ts` 它仍判不了。
   * 过滤同 verify-file-size-new.ts:181 `isCandidate()`：两段包 + 代码扩展名，排除 `.d.ts`。
   */
  "next-indexed-corpus": (repo) => {
    try {
      const out = execFileSync("git", ["ls-files", "-z", "packages"], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 })
      return out
        .split("\0")
        .filter(Boolean)
        .some(
          (rel) =>
            /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(rel) && !/\.d\.ts$/.test(rel) && /^packages\/[^/]+\/[^/]+\/.+/.test(rel),
        )
    } catch {
      return false
    }
  },
}
