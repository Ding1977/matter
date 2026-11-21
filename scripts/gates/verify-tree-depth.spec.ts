/**
 * `verify-tree-depth` 的 spec（ISS-870 / W-0）。
 *
 * ## 为什么这一格必须有「必然失败」用例
 *
 * 本判据的三条断言里，③ 是**只报不红**的（存量 52 棵平级树）。如果 spec 只验「真仓跑绿」，
 * 那么一个把 ② 整段删掉的版本会给出**完全相同的结果** —— 真仓今天只有 1 棵 depth=1 的树，
 * 而它已登记；删掉 ② 之后照样绿。⇒ 它证明不了任何事。
 *
 * 所以每一条断言都配一条「必须红」的反向用例，且都**用 `mkdtempSync` 造临时树**
 * （`scripts/gates/README.md` 乙规则；`verify-tsconfig-coverage.spec.ts` 同款做法）。
 * ⛔ 不碰真仓 `.agents/trees.json` —— 那会让跑一次 spec 就改掉判据的输入语料。
 *
 * ## 三层用例（缺一层就有一族形态没人盯）
 *
 *   A. **纯函数层**：喂构造数据，判 ①②③ 三断言 + 归一 + 边界 + 两态判不了。
 *   B. **真实 IO 层**（`mkdtempSync` + 临时登记表文件）：纯函数看不见
 *      「登记表缺席被读成绿」「读不动的表被读成空表」这两类错 —— 而它们恰好是本判据的语文核心。
 *   C. **反向控制**：同一份语料只抽掉一处，绿 → 红，证明判据有判别力（不是恒绿）。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { judgeTreeDepth, parseWorktrees, readRegistryAt, MAX_DEPTH, REGISTRY_REL, type DepthInput } from "./verify-tree-depth.ts"

let fails = 0
/** 断言条数**实测累加**，不在结尾手写拆解 —— 手写的数会和实际脱节。 */
let total = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : `\n      ↳ ${extra}`}`)
  if (!cond) fails++
}

/** 有没有某条 finding 的 detail 含这个片段。 */
const hits = (input: DepthInput, needle: string): boolean =>
  (judgeTreeDepth(input).findings ?? []).some((f) => f.detail.includes(needle))

/** 一条 finding 都没有？ */
const clean = (input: DepthInput): boolean => judgeTreeDepth(input).status === "passed"

/**
 * 临时树骨架。`mkdtempSync` 保证不碰真仓；返回的 `real` 恒等函数注入给判据，
 * 让纯函数层不依赖**这台机器上**真实存在的目录（否则断言随环境变色）。
 */
function tmpRoot(prefix: string): { root: string; real: (p: string) => string; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { root, real: (p: string) => p, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-tree-depth.spec")

  // ══ A. 纯函数层 ══════════════════════════════════════════════════════════

  // ── 正例：主检出 + 一棵平级树 + 一棵已登记的两层树 ──────────────────────
  {
    const MAIN = "/r/main"
    const FLAT = "/r/wt/ISS-1"
    const SESSION = "/r/wt/dsh-abc"
    const ISSUE = "/r/wt/dsh-abc/.agents/worktrees/ISS-2"
    const input: DepthInput = {
      trees: [MAIN, FLAT, SESSION, ISSUE],
      mainCheckout: MAIN,
      registry: { "ISS-2": { kind: "issue", path: ISSUE, branch: "ISS-2", parent: SESSION } },
      realpath: (p) => p,
      exists: () => true,
    }
    ok("正例：主检出 + 平级 + 两层已登记 ⇒ 绿", clean(input), JSON.stringify(judgeTreeDepth(input).findings))
    ok("正例：maxDepth 报 1（不是 0，也不是 2）", (judgeTreeDepth(input).detail ?? "").includes("maxDepth=1"), judgeTreeDepth(input).detail)
  }

  // ── ① 三层及以上必须红，且文案含「三层及以上」────────────────────────────
  {
    const MAIN = "/r/main"
    const L1 = "/r/wt/dsh-abc"
    const L2 = "/r/wt/dsh-abc/.agents/worktrees/ISS-2"
    const L3 = "/r/wt/dsh-abc/.agents/worktrees/ISS-2/nested"
    const input: DepthInput = {
      trees: [MAIN, L1, L2, L3],
      mainCheckout: MAIN,
      registry: { "ISS-2": { kind: "issue", path: L2, parent: L1 } },
      realpath: (p) => p,
      exists: () => true,
    }
    ok("① 三层 ⇒ 红", judgeTreeDepth(input).status === "failed")
    ok("① 文案含「三层及以上」（人读得懂是什么坏了）", hits(input, "三层及以上"))
    ok("① 点名到具体路径（finding.file 是那棵三层树）", (judgeTreeDepth(input).findings ?? []).some((f) => f.file === L3), JSON.stringify(judgeTreeDepth(input).findings))
  }

  // ── ② depth=1 但未登记 ⇒ 红，且点名 ──────────────────────────────────────
  {
    const MAIN = "/r/main"
    const SESSION = "/r/wt/dsh-abc"
    const ISSUE = "/r/wt/dsh-abc/.agents/worktrees/ISS-9"
    const input: DepthInput = {
      trees: [MAIN, SESSION, ISSUE],
      mainCheckout: MAIN,
      registry: {},
      realpath: (p) => p,
      exists: () => true,
    }
    ok("② 两层未登记 ⇒ 红", judgeTreeDepth(input).status === "failed")
    ok("② 点名那棵树", (judgeTreeDepth(input).findings ?? []).some((f) => f.file === ISSUE), JSON.stringify(judgeTreeDepth(input).findings))
    ok("② 文案说出「没有它的登记行」", hits(input, "没有它的登记行"))
  }

  // ── ② 已登记但 kind 不对 ⇒ 红 ────────────────────────────────────────────
  {
    const MAIN = "/r/main"
    const SESSION = "/r/wt/dsh-abc"
    const ISSUE = "/r/wt/dsh-abc/.agents/worktrees/ISS-9"
    const mk = (kind: string): DepthInput => ({
      trees: [MAIN, SESSION, ISSUE],
      mainCheckout: MAIN,
      registry: { "ISS-9": { kind, path: ISSUE, parent: SESSION } },
      realpath: (p) => p,
      exists: () => true,
    })
    ok("② kind=issue ⇒ 绿（正例）", clean(mk("issue")))
    ok("② kind=session ⇒ 红（内层必须是 issue）", judgeTreeDepth(mk("session")).status === "failed")
    ok("② 文案点名 kind 不对", hits(mk("session"), "内层必须是 issue"))
  }

  // ── ② parent 必须指到**外层**那棵，不是随便一棵 ─────────────────────────
  {
    const MAIN = "/r/main"
    const OTHER = "/r/wt/other"
    const SESSION = "/r/wt/dsh-abc"
    const ISSUE = "/r/wt/dsh-abc/.agents/worktrees/ISS-9"
    const base = { trees: [MAIN, OTHER, SESSION, ISSUE], mainCheckout: MAIN, realpath: (p: string) => p, exists: () => true }
    ok(
      "② parent 写外层路径 ⇒ 绿",
      clean({ ...base, registry: { "ISS-9": { kind: "issue", path: ISSUE, parent: SESSION } } }),
    )
    ok(
      "② parent 写外层**键** ⇒ 也绿（两种写法都认）",
      clean({ ...base, registry: { SESSION: { kind: "session", path: SESSION }, "ISS-9": { kind: "issue", path: ISSUE, parent: "SESSION" } } }),
    )
    ok(
      "② parent 指到别处 ⇒ 红（指错比不写更坏：两张表对不上）",
      judgeTreeDepth({ ...base, registry: { "ISS-9": { kind: "issue", path: ISSUE, parent: OTHER } } }).status === "failed",
    )
    ok("② parent 缺失 ⇒ 红", judgeTreeDepth({ ...base, registry: { "ISS-9": { kind: "issue", path: ISSUE } } }).status === "failed")
  }

  // ── ③ depth=0 的存量：只报不红 ─────────────────────────────────────────
  {
    const MAIN = "/r/main"
    const input: DepthInput = {
      trees: [MAIN, "/r/wt/ISS-1", "/r/wt/ISS-2", "/r/wt/ISS-3"],
      mainCheckout: MAIN,
      registry: {},
      realpath: (p) => p,
      exists: () => true,
    }
    ok("③ 三棵未登记的平级树 ⇒ **仍然绿**（存量只报不红）", clean(input))
    ok("③ 但 detail 里报了未登记数（不是沉默）", (judgeTreeDepth(input).detail ?? "").includes("depth0 未登记 3 棵"), judgeTreeDepth(input).detail)
  }

  // ── 主检出不作父节点：`new --in-repo` 的 .wt/ISS-x 不是「套娃」────────────────
  {
    const MAIN = "/r/main"
    const input: DepthInput = {
      trees: [MAIN, "/r/main/.wt/ISS-7"],
      mainCheckout: MAIN,
      registry: {},
      realpath: (p) => p,
      exists: () => true,
    }
    ok("主检出下的 .wt/ISS-x 不算 depth=1（不排除主检出会让每棵 in-repo 树误红）", clean(input))
  }

  // ── 归一：同一棵树两种写法（池软链）不得互相判成嵌套 ────────────────────
  {
    // 模拟真仓形态：主检出的池是软链 `.agents/worktrees → ~/wt/dsh-forge`，于是
    // **同一棵内层树**可以写成两条完全不同的串 —— 而只有 realpath 之后才相等：
    //   worktree list 给的     ~/wt/dsh-forge/dsh-abc/.agents/worktrees/ISS-2
    //   经主检出池软链写出来的是  <主检出>/.agents/worktrees/dsh-abc/.agents/worktrees/ISS-2
    const REAL_MAIN = "<repo>"
    const REAL_SESSION = "<wt>/dsh-abc"
    const REAL_ISSUE = `${REAL_SESSION}/.agents/worktrees/ISS-2`
    const VIA_POOL = `${REAL_MAIN}/.agents/worktrees/dsh-abc/.agents/worktrees/ISS-2`
    const input: DepthInput = {
      trees: [REAL_MAIN, REAL_SESSION, REAL_ISSUE],
      mainCheckout: REAL_MAIN,
      registry: { "ISS-2": { kind: "issue", path: VIA_POOL, parent: REAL_SESSION } },
      realpath: (p) => (p === VIA_POOL ? REAL_ISSUE : p),
      exists: () => true,
    }
    ok("归一：登记行与 worktree list 两种写法 ⇒ 认作同一棵树（绿）", clean(input), JSON.stringify(judgeTreeDepth(input).findings))
    ok("归一：内层深度按真实路径算 = 1，不因写法不同算成 0", (judgeTreeDepth(input).detail ?? "").includes("maxDepth=1"), judgeTreeDepth(input).detail)
  }

  // ── 归一的反向控制：**不归一**就必须红（证明归一那一步真的在起作用）──────
  {
    const REAL_MAIN = "<repo>"
    const REAL_SESSION = "<wt>/dsh-abc"
    const REAL_ISSUE = `${REAL_SESSION}/.agents/worktrees/ISS-2`
    const VIA_POOL = `${REAL_MAIN}/.agents/worktrees/dsh-abc/.agents/worktrees/ISS-2`
    const input: DepthInput = {
      trees: [REAL_MAIN, REAL_SESSION, REAL_ISSUE],
      mainCheckout: REAL_MAIN,
      registry: { "ISS-2": { kind: "issue", path: VIA_POOL, parent: REAL_SESSION } },
      realpath: (p) => p, // ⛔ 刻意不归一 = 判据第一版的错法
      exists: () => true,
    }
    ok(
      "反向控制：realpath 恒等（不归一）⇒ 同一棵树被判成未登记 ⇒ 红。**这就是「不归一就全误红」的机器形态**",
      judgeTreeDepth(input).status === "failed",
    )
    ok("反向控制：不归一时 finding 点名的是那棵**真实路径**的内层树", (judgeTreeDepth(input).findings ?? []).some((f) => f.file === REAL_ISSUE))
  }

  // ── 两条判不了：不许退化成绿 ───────────────────────────────────────────
  {
    const nothing: DepthInput = { trees: [], mainCheckout: undefined, registry: {}, realpath: (p) => p, exists: () => true }
    ok("判不了：git worktree list 空 ⇒ unjudged（不是绿）", judgeTreeDepth(nothing).status === "unjudged")
    ok("判不了：理由码是 no-corpus", judgeTreeDepth(nothing).reason === "no-corpus")
    const broken: DepthInput = {
      trees: ["/r/main", "/r/wt/x"],
      mainCheckout: "/r/main",
      registry: null,
      realpath: (p) => p,
      exists: () => true,
    }
    ok("判不了：登记表读不动（null）⇒ unjudged（不是「空表」）", judgeTreeDepth(broken).status === "unjudged", JSON.stringify(judgeTreeDepth(broken)))
    ok("判不了：登记表读不动的文案点名文件", (judgeTreeDepth(broken).detail ?? "").includes(REGISTRY_REL))
  }

  // ── 登记表那一侧的坏输入：缺 path / 不是对象 / 重复路径 ────────────────────
  {
    const MAIN = "/r/main"
    const ISSUE = "/r/wt/dsh-abc/.agents/worktrees/ISS-9"
    const base = { trees: [MAIN, "/r/wt/dsh-abc", ISSUE], mainCheckout: MAIN, realpath: (p: string) => p, exists: () => true }
    ok(
      "登记行缺 path ⇒ 红（没有落点无法与 worktree list 对齐）",
      judgeTreeDepth({ ...base, registry: { "ISS-9": { kind: "issue" } } }).status === "failed",
    )
    ok(
      "两条登记行同路径 ⇒ 红（② 的映射会静默挑一个）",
      judgeTreeDepth({ ...base, registry: { A: { kind: "issue", path: ISSUE, parent: "/r/wt/dsh-abc" }, B: { kind: "issue", path: ISSUE, parent: "/r/wt/dsh-abc" } } }).status === "failed",
    )
    ok(
      "登记行指向已删除的树 ⇒ 跳过、不红（收树后忘删行不该把门禁弄红）",
      clean({ ...base, registry: { "ISS-9": { kind: "issue", path: ISSUE, parent: "/r/wt/dsh-abc" }, GONE: { kind: "issue", path: "/r/wt/已删掉的树" } }, exists: (p) => !p.includes("已删掉") }),
    )
  }

  // ── 可移植性：别人 clone 后登记表里的绝对路径在他机器上不存在，不许因此判红 ────
  // ⚠️ 这是 `.agents/trees.json` 用绝对路径的必然后果。没有这条跳过，判据在**别人机器上恒红**
  //   （「登记了 N 棵不存在的树」）⇒ 判据随环境变色，skill 明令禁止。实测钉住它。
  {
    const MAIN = "/other/main"
    const other: DepthInput = {
      trees: [MAIN, "/other/wt/ISS-777"],
      mainCheckout: MAIN,
      registry: {
        "dsh-abc": { kind: "session", path: "/Users/someone-else/wt/dsh-forge/dsh-abc", parent: null },
        "ISS-2": { kind: "issue", path: "/Users/someone-else/wt/dsh-forge/dsh-abc/.agents/worktrees/ISS-2", parent: "dsh-abc" },
      },
      realpath: (p) => p,
      exists: () => false, // 本机一条登记路径都不存在 = 别人 clone 之后的真实状态
    }
    ok("可移植性：登记路径在本机都不存在 ⇒ 仍绿（跳过，不判红）", clean(other), JSON.stringify(judgeTreeDepth(other).findings))
    ok("可移植性：detail 明说跳过了几条（不是沉默）", (judgeTreeDepth(other).detail ?? "").includes("指向已删除的树"), judgeTreeDepth(other).detail)
  }

  // ── 深度上限是常量，且与文档说的一致 ────────────────────────────────────
  ok(`MAX_DEPTH = ${MAX_DEPTH}（恰好两级：0 与 1）`, MAX_DEPTH === 1)

  // ══ B. 真实 IO 层（mkdtempSync，不碰真仓）══════════════════════════════
  {
    const { root, done } = tmpRoot("tree-depth-registry-")
    try {
      // 三态：缺席 ⇒ {}（按空表判）· 能解析 ⇒ 内容 · 读不动 ⇒ null
      const missing = path.join(root, "absent.json")
      ok("IO：登记表文件缺席 ⇒ 返回 {}（按空表判，不是判不了）", JSON.stringify(readRegistryAt(missing)) === "{}")

      const goodPath = path.join(root, "good.json")
      fs.writeFileSync(goodPath, JSON.stringify({ _readme: ["注释位"], X: { kind: "issue", path: "/r/wt/x", parent: "/r/wt" } }))
      const good = readRegistryAt(goodPath)
      ok("IO：能解析 ⇒ 内容读出来", !!good && !!good.X)
      ok("IO：`_` 开头的键当注释位，不当作登记行", !!good && !("_readme" in good))

      const brokenPath = path.join(root, "broken.json")
      fs.writeFileSync(brokenPath, "{ 这不是 JSON")
      ok("IO：坏 JSON ⇒ null（判不了，不当空表）", readRegistryAt(brokenPath) === null)

      const arrayPath = path.join(root, "array.json")
      fs.writeFileSync(arrayPath, "[1,2,3]")
      ok("IO：顶层是数组 ⇒ null（形状不对就是判不了，不静默当空表）", readRegistryAt(arrayPath) === null)

      // 「表在但空」与「表读不动」必须给出**相反**的结论 —— 这是本判据最容易混的一处。
      const MAIN = "/r/main"
      const SESSION = "/r/wt/dsh-abc"
      const ISSUE = "/r/wt/dsh-abc/.agents/worktrees/ISS-9"
      const ioBase = { trees: [MAIN, SESSION, ISSUE], mainCheckout: MAIN, realpath: (p: string) => p, exists: () => true }
      ok("IO：表在且为空 ⇒ 红（② 判得出来）", judgeTreeDepth({ ...ioBase, registry: readRegistryAt(missing) }).status === "failed")
      ok("IO：表读不动 ⇒ 判不了（与上一条相反，不许混）", judgeTreeDepth({ ...ioBase, registry: readRegistryAt(brokenPath) }).status === "unjudged")
    } finally {
      done()
    }
  }

  // ── parseWorktrees：porcelain 解析（真实形态取自 `git worktree list --porcelain`）───
  {
    const porcelain = [
      "worktree <repo>",
      "HEAD 0f08adc2aaaa",
      "branch refs/heads/main",
      "",
      "worktree <wt>/dsh-abc",
      "HEAD bfd903c6bbbb",
      "branch refs/heads/dsh-abc",
      "locked has inner trees",
      "",
    ].join("\n")
    const got = parseWorktrees(porcelain)
    ok("porcelain：每个 worktree 行取一条", got.length === 2, JSON.stringify(got))
    ok("porcelain：第一行是主检出（判据依赖这条 git 约定）", got[0] === "<repo>")
    ok("porcelain：不把 HEAD/branch/locked 行当路径", !got.some((p) => p.startsWith("HEAD") || p.startsWith("branch") || p.startsWith("locked")))
    ok("porcelain：空输入 ⇒ []（调用方据此判不了）", parseWorktrees("").length === 0)
  }

  // ── 默认归一的**真实 IO** 用例（不注入 realpath）────────────────────────
  // ⚠️ 这一段是本 spec 唯一真正测「默认归一实现」的地方，而它**必须有**：
  //   上面每一条都注入了恒等 `realpath`，于是把 `tolerantRealpath` 换成 `(p) => p`
  //   （即删掉归一）spec 会**全绿** —— 实测踩过。判据的射程恰好就在那一步。
  //   这里用真目录 + 真软链（`mkdtempSync` 造，不碰真仓），走判据的默认分支。
  {
    const { root, done } = tmpRoot("tree-depth-realpath-")
    try {
      const main = path.join(root, "main")
      const session = path.join(root, "wt", "dsh-abc")
      const issue = path.join(session, ".agents", "worktrees", "ISS-2")
      fs.mkdirSync(session, { recursive: true })
      fs.mkdirSync(main, { recursive: true })
      fs.mkdirSync(issue, { recursive: true })
      // 主检出的池软链：`<main>/.agents/worktrees → <root>/wt`，与真仓形态逐字同构
      fs.mkdirSync(path.join(main, ".agents"), { recursive: true })
      fs.symlinkSync(path.join(root, "wt"), path.join(main, ".agents", "worktrees"))

      // 同一棵内层树的两种写法：真实路径 / 经池软链
      const viaPool = path.join(main, ".agents", "worktrees", "dsh-abc", ".agents", "worktrees", "ISS-2")
      // 前提断言：两种写法**字面不同**，否则这一段什么都没测
      ok("IO 默认归一：两种写法字面上确实不同（否则这条用例是空的）", viaPool !== issue, `${viaPool} vs ${issue}`)
      ok("IO 默认归一：经池软链能读到同一棵树（软链真的建成了）", fs.existsSync(viaPool))

      const input: DepthInput = {
        trees: [main, session, issue],
        mainCheckout: main,
        registry: { "ISS-2": { kind: "issue", path: viaPool, parent: session } },
        exists: () => true,
        // ⛔ 刻意不注入 realpath —— 走判据自己的 `tolerantRealpath`
      }
      ok("IO 默认归一：登记行写池软链写法 ⇒ 认作同一棵树（绿）", clean(input), JSON.stringify(judgeTreeDepth(input).findings))
      ok("IO 默认归一：深度按真实路径算 = 1", (judgeTreeDepth(input).detail ?? "").includes("maxDepth=1"), judgeTreeDepth(input).detail)
    } finally {
      done()
    }
  }

  // ══ C. 反向控制：同一份语料只抽掉一处 ⇒ 绿变红（证明有判别力）═══════════
  {
    const MAIN = "/r/main"
    const SESSION = "/r/wt/dsh-abc"
    const ISSUE = "/r/wt/dsh-abc/.agents/worktrees/ISS-9"
    const cleanInput: DepthInput = {
      trees: [MAIN, SESSION, ISSUE],
      mainCheckout: MAIN,
      registry: { "ISS-9": { kind: "issue", path: ISSUE, parent: SESSION } },
      realpath: (p) => p,
      exists: () => true,
    }
    const mutated: DepthInput = { ...cleanInput, registry: {} }
    ok("反向控制：干净语料先绿（基线）", clean(cleanInput))
    ok("反向控制：只抽掉那一条登记 ⇒ 立刻红（判据有判别力，不是恒绿）", judgeTreeDepth(mutated).status === "failed")
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立（共 ${total} 条断言）`
      : `✓ spec 全过（${total} 条断言：①三层红 + ②未登记/kind/parent 三向 + ③存量只报不红 + 主检出非父 + 双侧归一与不归一的对照 + 默认归一真实软链 IO + 两态判不了 + 登记表坏输入四型 + 可移植性跳过 + 真实 IO 三态 + porcelain 解析 + 反向控制）`,
  )
  return fails === 0
}
