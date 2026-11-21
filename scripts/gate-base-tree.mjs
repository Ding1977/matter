/**
 * gate-base-tree —— 给快闸取「共同祖先那一份代码」的门禁现值（ISS-955 乙案）
 *
 * 为什么要它：`gate-debt.json` 是**静态快照**，main 前进后没人复录 ⇒
 * "只拦新增"实际在拦所有 push（09-29 实测：main@89a4dfce 自己跑 gate-fast 就红，
 * design 现值 481 而登记 112）。修法不是放宽判据，而是把对照基准从"某个快照"
 * 换成"这次改动真正的起点"：merge-base(HEAD, origin/main) 的树现算同一批指标。
 *
 * 口径：
 *   · 只读操作：`git worktree add --detach`（不动主检出、不占 ws.sh 租约、不改分支）；
 *   · 依赖靠**软链**借用主检出的 node_modules（本仓不 hoist，第三方在 <pkg>/node_modules）；
 *     链不上就返回 null ⇒ 调用方必须 fail closed（继续拦），不许把"算不出基准"读成"没有存量"。
 *   · 用完由调用方决定 remove（缓存留着下次复用，同一 sha 不重建）。
 *
 * ── ISS-726：落点统一 + 自动清理 + 泄漏判据 ───────────────────────────
 * 上面那句「用完由调用方决定 remove」的实测后果：`grep -rn "dropBaseTree" scripts/*.mjs`
 * 除定义处外**零调用** —— 给了钥匙，没有一个调用方会成为那个调用方。于是游离树只增不减：
 * 一次核查时 `git worktree list` 的 69 条里有 26 条是门禁自己造的（833MB），散在 4 个位置。
 *
 * 散布的直接原因是**每个调用方各自算路径**：
 *   · gate-fast.mjs  → `~/wt/.gate-base`（defaultCachePath）
 *   · run-gates.mjs  → `path.join(REPO, "..", ".gate-base", ...)` —— 依赖「在哪个工作树里跑」：
 *                      主检出 ⇒ ~/.gate-base；.wt/ISS-x ⇒ .wt/.gate-base；~/wt/dsh-forge/ISS-x ⇒ ~/wt/dsh-forge/.gate-base
 * 所以本文件现在是**落点的唯一真相源**（`cacheRoot()`），调用方不再自己拼路径。
 *
 * ⛔ 落点不能放 `$TMPDIR`：借依赖用的是**相对**软链，而 macOS 的 `/tmp` → `/private/tmp`。
 *   相对链接按「建链处的真实路径」解析，于是 `../../../../node_modules` 从 `/private/tmp/...`
 *   出去就落到 `/private/Users/...` ⇒ ENOENT。实测复现过（ISS-726），后果是基线树里
 *   「找不到 typescript」⇒ 大面积自检假红 ⇒ 假红被读成「存量红」。
 *   同理，落点**不能有软链跳转**：`.agents/worktrees` 是指向 `~/wt/dsh-forge` 的软链，
 *   把缓存塞它下面会让相对链接多退一级（实测解析到 `<home>/node_modules`，不存在）。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" })

/** 主检出里存在 node_modules 的包（相对路径）；根 node_modules 也一并算 */
function depDirs(repoRoot) {
  const out = []
  if (fs.existsSync(path.join(repoRoot, "node_modules"))) out.push(".")
  for (const e of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^(forge-|matter)/.test(e.name)) continue
    if (fs.existsSync(path.join(repoRoot, e.name, "node_modules"))) out.push(e.name)
  }
  return out
}

/**
 * 缓存树落点 —— **唯一真相源**（ISS-726）。
 *
 * 判据：与「在哪个工作树里跑」无关。所以不许出现 `REPO`，只能用 `os.homedir()`。
 * 三位候选的实测（见文件头）：仓内 `.agents/worktrees/.gate-base` 会因软链跳转解析到
 * `<home>/node_modules`（不存在）⇒ 直接出局；`~/wt/.gate-base` 能解析但落在业务树池
 * 隔壁容易混淆；`~/.gate-base` 无软链跳转、与主检出同盘（dev 16777230）、且历史上就是
 * 主检出跑出来的落点（16 条存量都在这里）⇒ 选它。
 */
export const cacheRoot = () => path.join(os.homedir(), ".gate-base")

/** 给定 sha 的缓存树路径。**任何调用方都走这里**，不许自己 path.join 拼。 */
export const cachePathFor = (sha) => path.join(cacheRoot(), `base-${String(sha).slice(0, 8)}`)

/** @deprecated ISS-726：保留旧名只为不打断外部引用，实际已并入 cacheRoot() */
export const defaultCachePath = cacheRoot

// ─────────────────────────────────────────────────────────────────────────────
// 游离树识别：**区分业务树与缓存树**（ISS-726 第 3 步的前提）
//
// 实测 26 条泄漏分布在 4 个位置，路径前缀各不相同 ⇒ 只按 cacheRoot() 前缀数会漏掉全部存量。
// 所以按**形态**认，不按位置认：
//   · 路径里有 `.gate-base` 段（今天算法的所有历史落点都带它）
//   · 或 basename 形如 `base-<hex>`（detached 基准树）
//   · 或 basename 形如 `run-gates-base-*`（更早一版临时树）
// 业务树（`.wt/ISS-x`、`~/wt/dsh-forge/ISS-x`）三条都不匹配 ⇒ 不会被算成泄漏。
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_PATH_SEG = /(^|\/)\.gate-base(\/|$)/
const CACHE_BASENAME = /^base-[0-9a-f]{6,40}$|^run-gates-base-/

/** 判断一条 worktree 路径是不是**门禁自己的缓存树** */
export function isCacheTreePath(p) {
  const norm = String(p).replace(/\/+$/, "")
  if (CACHE_PATH_SEG.test(norm)) return true
  return CACHE_BASENAME.test(path.basename(norm))
}

/** `git worktree list --porcelain` ⇒ [{ path, sha, branch, detached }] */
export function listWorktrees(repoRoot) {
  const r = git(["worktree", "list", "--porcelain"], repoRoot)
  if (r.status !== 0) return []
  const out = []
  let cur = null
  for (const line of String(r.stdout || "").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur)
      cur = { path: line.slice(9).trim(), sha: null, branch: null, detached: false }
    } else if (cur && line.startsWith("HEAD ")) cur.sha = line.slice(5).trim()
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).trim()
    else if (cur && line.trim() === "detached") cur.detached = true
  }
  if (cur) out.push(cur)
  return out
}

/** 口径修正：一条命令能报「业务树 N / 缓存树 M」，不是混在一起一个数 */
export function classifyWorktrees(repoRoot) {
  const all = listWorktrees(repoRoot)
  const cache = all.filter((w) => isCacheTreePath(w.path))
  const business = all.filter((w) => !isCacheTreePath(w.path))
  return { all, business, cache }
}

/** 全清：删掉**所有**缓存树（含历史遗留散落各处）。返回实际删掉/失败的清单。 */
export function dropAllCacheTrees({ repoRoot, dryRun = false }) {
  const { cache } = classifyWorktrees(repoRoot)
  const removed = []
  const failed = []
  for (const w of cache) {
    if (dryRun) {
      removed.push(w.path)
      continue
    }
    const r = git(["worktree", "remove", "--force", w.path], repoRoot)
    if (r.status === 0) removed.push(w.path)
    else {
      // 目录已被手动删掉、git 元数据还在 ⇒ remove 会失败。清掉残目录 + prune 才算收干净。
      try {
        fs.rmSync(w.path, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      failed.push({ path: w.path, 原因: (r.stderr || r.stdout || "").trim().slice(0, 160) })
    }
  }
  if (!dryRun) git(["worktree", "prune"], repoRoot)
  return { removed, failed, skipped: dryRun }
}

/**
 * 「本次运行新建了哪些树」—— **自动清理的登记簿**（ISS-726）。
 *
 * 为什么不用「调用方各写一个 finally」：那个约定的失效方式已经被本文件实证过一次 ——
 * `dropBaseTree` 摆在那里、注释写着「用完由调用方决定」，结果零调用。要求**每个**调用方
 * 都记得写 finally，就是把同一个失败模式复制到 N 个地方；漏一个就是一条泄漏。
 *
 * 所以清理放在**建树的那一处**：谁建的谁登记，进程退出时统一回收。
 * 早返回、抛异常、`process.exit()` 都走同一扇门 —— `exit` 钩子对这三条路都生效，
 * 而散落的 finally 只对「它被写在的那条路」生效。
 *
 * 只清**本次新建**的：命中缓存（created === false）不动它，下次还能复用。
 * 调试想留住树：`GATE_BASE_KEEP=1`。
 */
const createdThisProcess = new Set()
let exitHookInstalled = false

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on("exit", () => {
    if (process.env.GATE_BASE_KEEP === "1") {
      if (createdThisProcess.size) console.error(`· GATE_BASE_KEEP=1 ⇒ 保留本次新建的 ${createdThisProcess.size} 棵基准树：${[...createdThisProcess].map((x) => x.cachePath).join(", ")}`)
      return
    }
    for (const { repoRoot, cachePath } of createdThisProcess) {
      try {
        dropBaseTree({ repoRoot, cachePath })
      } catch {
        /* 退出路径上尽力而为，不让清理失败盖掉真正的退出码 */
      }
    }
  })
}

/** 显式提前清理（不想等进程退出时用）；返回清掉几棵 */
export function dropCreatedBaseTrees() {
  let n = 0
  for (const { repoRoot, cachePath } of createdThisProcess) {
    try {
      if (dropBaseTree({ repoRoot, cachePath }).removed) n++
    } catch {
      /* ignore */
    }
  }
  createdThisProcess.clear()
  return n
}

/** 确保 base 树在 cachePath 上就位，返回 { ok, path, sha, 依赖已链, created, 原因 } */
export function ensureBaseTree({ repoRoot, sha, cachePath }) {
  const headAt = (p) => {
    const r = git(["rev-parse", "HEAD"], p)
    return r.status === 0 ? r.stdout.trim() : null
  }
  let ready = false
  let created = false
  if (fs.existsSync(cachePath)) {
    if (headAt(cachePath) === sha) ready = true
    else {
      const rm = git(["worktree", "remove", "--force", cachePath], repoRoot)
      if (rm.status !== 0) fs.rmSync(cachePath, { recursive: true, force: true })
      git(["worktree", "prune"], repoRoot)
    }
  }
  if (!ready) {
    const add = git(["worktree", "add", "--detach", cachePath, sha], repoRoot)
    if (add.status !== 0) {
      return { ok: false, 原因: `git worktree add 失败：${(add.stderr || add.stdout).trim().slice(0, 200)}` }
    }
    created = true
    // 谁建的谁登记 ⇒ 进程退出时统一回收（见上方 createdThisProcess 的理由）
    createdThisProcess.add({ repoRoot, cachePath })
    installExitHook()
  }
  // 借依赖：只在目标缺失时建相对软链，绝不覆盖真目录
  let linked = 0
  for (const rel of depDirs(repoRoot)) {
    const dst = path.join(cachePath, rel, "node_modules")
    if (fs.existsSync(dst)) continue
    const srcRel = path.relative(path.dirname(dst), path.join(repoRoot, rel, "node_modules"))
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.symlinkSync(srcRel, dst, "dir")
      linked++
    } catch {
      /* 链不上就让它链不上：调用方算不出数会 fail closed */
    }
  }
  return { ok: true, path: cachePath, sha: headAt(cachePath), 依赖已链: linked, created }
}

/**
 * 销毁一棵 base 树，返回 { removed, 原因 }。
 *
 * ISS-726 之前这里的注释是「用完销毁（默认不调用：同 sha 缓存复用）」——
 * 而事实上**一个调用方都没有**，于是树只增不减。现在调用点有三处，别再写成「默认不调用」：
 *   1. installExitHook()  进程退出时回收本次新建的（主要出口，早返回/抛异常/process.exit 都覆盖）
 *   2. dropCreatedBaseTrees()  想提前清、不等进程退出的
 *   3. dropAllCacheTrees()   --clean 全清
 * 同 sha 复用仍然有效：只有 created === true 的才进回收名单，命中缓存的树不碰。
 */
export function dropBaseTree({ repoRoot, cachePath }) {
  const rm = git(["worktree", "remove", "--force", cachePath], repoRoot)
  git(["worktree", "prune"], repoRoot)
  return { removed: rm.status === 0, 原因: rm.status === 0 ? "" : (rm.stderr || rm.stdout).trim().slice(0, 200) }
}

export function mergeBase(repoRoot, refs) {
  for (const ref of refs) {
    const r = git(["merge-base", "HEAD", ref], repoRoot)
    if (r.status === 0) return r.stdout.trim()
  }
  return null
}

if (process.argv[1] && import.meta.url === new URL(`file://${fs.realpathSync(path.resolve(process.argv[1]))}`).href) {
  const repoRoot = path.resolve(import.meta.dirname, "..")
  const clean = process.argv.includes("--clean")
  const status = process.argv.includes("--status")
  const dryRun = process.argv.includes("--dry-run")

  // --status / --clean：口径修正（ISS-726 验收第 4 条）。一条命令分清「业务树 N / 缓存树 M」，
  // 不再混在一起一个数；--clean 只清缓存树，业务树一棵不动。
  if (status || clean) {
    const { business, cache } = classifyWorktrees(repoRoot)
    if (status && !clean) {
      console.log(`业务树 ${business.length} / 缓存树 ${cache.length}（共 ${business.length + cache.length} 条）`)
      for (const w of cache) console.log(`  · 缓存 ${w.path}`)
      process.exit(0)
    }
    const d = dropAllCacheTrees({ repoRoot, dryRun })
    if (dryRun) {
      console.log(`· 将删除 ${d.removed.length} 棵缓存树（业务树 ${business.length} 棵不动）：`)
      for (const p of d.removed) console.log(`  - ${p}`)
      process.exit(0)
    }
    console.log(`✓ 清掉 ${d.removed.length} 棵缓存树 · 保留业务树 ${business.length} 棵 · 剩缓存树 ${classifyWorktrees(repoRoot).cache.length}`)
    for (const f of d.failed) console.log(`  ⚠ ${f.path}：${f.原因}`)
    process.exit(0)
  }

  const sha = mergeBase(repoRoot, ["origin/main", "main"])
  if (!sha) { console.error("✗ 找不到 merge-base（origin/main 与 main 都不可用）"); process.exit(2) }
  const cp = cachePathFor(sha)
  const r = ensureBaseTree({ repoRoot, sha, cachePath: cp })
  console.log(r.ok ? `✓ 基准树就位 ${r.path} @${String(r.sha).slice(0, 7)} · 新链依赖 ${r.依赖已链} 处` : `✗ ${r.原因}`)
  process.exit(r.ok ? 0 : 2)
}
