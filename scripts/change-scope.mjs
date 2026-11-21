#!/usr/bin/env node
// change-scope —— 「改了什么」报告器（L1 编排层入口 · ISS-711）
//
// 为什么要有它：skill 那张「场景 → 命令」表的**第一列是改动面**。没有可靠的「改了什么」，
//   表的行根本选不出来 —— 于是要么全跑（慢到没人用），要么凭记忆瞎跑（漏）。
//   本文件只回答一件事：这一坨改动到底落在哪些文件/包/面上。**它不做取舍、不跑门禁、不下判定。**
//
// 纪律（每条都有事故来历，别软化）：
//   ① `--base` **必填，不猜不 fetch**。猜 base 会拿错改动面；fetch 会让"本地看的"和"远端拿的"
//      悄悄分家。给不出来就红，让人自己指名。
//   ② merge-base **唯一性校验**。`git merge-base --all` 返回多个 = criss-cross 合流，
//      此时取任意一个都是猜。同一个 merge-base 病已出过三次（docs/project-ops-rules.md §3.0-pre-b）：
//      `main..HEAD` 假删除 358 文件（害 ISS-687 建了又取消）· 工作树测试数比 main 少（ISS-685）·
//      本单文件数翻 7 倍。所以这里**必须判红并列出全部候选**，不许静默取第一个。
//   ③ `-z`（NUL 分隔）而非换行分隔。文件名含空格/中文时换行分隔会串行，串行后改动面就是错的。
//   ④ `--no-renames`。改名在 diff 里会变成 delete+add 两行 —— 那正是我们要的**改动面**形态
//      （old 路径删了、new 路径加了）；开着 rename 检测会被折叠成一条 "R old -> new"，第一列就选不出行。
//   ⑤ `--no-ext-diff` / `--no-textconv` / `--ignore-submodules=none` / 结尾 `--`。
//      四条都抄自官方 `scripts/change-scope.ts:diffPaths`，用途是「别让环境配置改写输出」。
//      ⚠️ 实测更正（2026-11-07，变异 M7+M10）：**这四条在本文件里都是纵深防御，没有一个能造出反向对照**。
//      · `--name-only` 本身不触发外部 diff（配了 `GIT_EXTERNAL_DIFF` 时 `git diff --name-only` 不调用它）；
//      · 摘掉 `--` 分隔符，24 项自检仍全过（git 对这些位置不按路径解析）；
//      · 于是我没有给它们写断言 —— **删掉后自检仍绿，那种断言是空心测试**，比没有更坏（它冒充保护）。
//      保留它们是因为与官方口径对齐 + 防未来 git 行为变化，**不是因为它们现在被验着**。
//      同级**真有牙**的护栏是下面的 `--no-relative`，以及 ② merge-base 唯一性与 ③ `-z`。
//   ⑤b `--no-relative`。`diff.relative=true` + 在子目录里跑时，git 会把路径**重写成相对 cwd**
//      （实测：`sub/a` 变 `a`）⇒ areas/packages 归类全错，而人看不出哪里错。这是静默错，必须挡。
//   ⑥ 四类分开：committed / staged / unstaged / untracked。四类的"该跑什么"不同 ——
//      committed 是要合进去的、staged 是即将提交的、unstaged 还没成形、untracked 可能根本不该进库。
//      混成一个集合会让人对着半成品跑全量门禁。
//
// 输出纪律（ISS-708）：**stdout 永远是纯 JSON，红的时候也是**。人读的提示一律走 stderr。
//   上一轮两道门禁的红档把人类可读行混进了 JSON，下游 `JSON.parse` 整体失败 —— 只红一次就把机器消费方全打死。
//
// 口径（别在两处用不同定义）：
//   · `committed` = mergeBase..HEAD，即**本单真正的提交**（三点口径，不是两点 `main..HEAD`）
//   · `total`     = 四段**去重后**的文件数（同一文件既 staged 又 unstaged 只算一个文件；
//                   但它在各自段里照旧各出现一次 —— 两段描述的是不同内容状态，不是重复记账）
//   · `packages`  = 改动命中的 workspace 包，**从根 package.json 的 workspaces 派生**，不硬编码清单
//   · `areas`     = 改动面的顶层归类（首段路径；仓库根文件归 `(root)`），同样不硬编码
//
// 用法：node scripts/change-scope.mjs --base <ref> [--json]
//        node scripts/change-scope.mjs --selftest
//   退出码：0 = 报告已出 · 2 = 红（base 解析不了 / merge-base 不唯一）· 3 = 没给输入（判不了）
import { execFileSync } from "node:child_process"
import fs, { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const SELF = fileURLToPath(import.meta.url)
const ARGS = process.argv.slice(2)

// ── 输出通道：stdout 只出 JSON，人类提示全走 stderr ─────────────────────────────
const emitJson = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + "\n")
const human = (msg) => process.stderr.write(msg + "\n")

class Red extends Error {
  constructor(code, detail, hint) {
    super(detail)
    this.code = code
    this.detail = detail
    this.hint = hint
  }
}

/** git 一次调用 → 去 NUL 后的路径数组。任何非零退出都当红（不许把"命令失败"读成"没有改动"）。 */
function gitZ(cwd, args) {
  let out
  try {
    out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // 隔离外部环境：GIT_EXTERNAL_DIFF / GIT_PAGER 都不该影响判据
      env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
    })
  } catch (e) {
    throw new Red(2, `git ${args.join(" ")} 失败（exit ${e.status ?? "?"}）：${(e.stderr || e.message || "").toString().trim()}`)
  }
  return out.split("\0").filter((s) => s.length > 0)
}

function gitText(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim()
  } catch (e) {
    throw new Red(2, `git ${args.join(" ")} 失败（exit ${e.status ?? "?"}）：${(e.stderr || e.message || "").toString().trim()}`)
  }
}

/**
 * 解析 base ref → sha。**不猜、不 fetch**。
 * `--end-of-options` 挡住以 `-` 开头的 ref 被当成 git 选项（形如 `--base --all` 那种误用）。
 */
function resolveBase(cwd, ref) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    throw new Red(
      2,
      `--base ${ref} 解析不到一个 commit`,
      [
        `查一下这个名字在不在：git rev-parse --verify '${ref}^{commit}'`,
        `想用远端最新：先自己 git fetch，再 --base origin/main（本脚本不替你 fetch）`,
      ].join("\n  "),
    )
  }
}

/**
 * merge-base 唯一性校验 —— 本文件的核心判据。
 * `--all` 会打出**全部**共同祖先；>1 就是 criss-cross，取哪一个都是猜 ⇒ 红。
 */
function uniqueMergeBase(cwd, baseSha, headSha) {
  const out = execFileSync("git", ["merge-base", "--all", baseSha, headSha], { cwd, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  if (out.length === 0) {
    throw new Red(2, `${baseSha.slice(0, 12)} 与 HEAD(${headSha.slice(0, 12)}) 没有共同祖先 —— 改动面无从定义`,
      "两条历史不相交（浅克隆 / 换过根的仓库）。先确认历史是连的，或换一个共同祖先明确的 base。")
  }
  if (out.length > 1) {
    throw new Red(
      2,
      `merge-base 不唯一：找到 ${out.length} 个候选（criss-cross 合流）—— 取任意一个都是猜，故判红`,
      [
        "候选（每个都能当 merge-base，结果不同）：",
        ...out.map((s, i) => `  [${i + 1}] ${s}`),
        "怎么办：把 base 指到一个**候选已经并进来之后**的提交（如某个明确的 tag / 发布点），",
        "        或先合并掉 criss-cross 再测。⚠️ 不要用 `main..HEAD` 两点口径绕过 —— 那正是出过三次的那个病。",
      ].join("\n  "),
    )
  }
  return out[0]
}

/** 首段路径 → 改动面归类。不硬编码任何目录名。 */
const areaOf = (p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "(root)")

/** workspace 包名集合，从根 package.json 派生（读不到就是判不了，不假装空集）。 */
function workspacePackages(cwd) {
  // 本文件常在工作树里跑，cwd 可能不是 git 根；workspaces 只在**根** package.json 里
  const root = gitText(cwd, ["rev-parse", "--show-toplevel"]) || cwd
  const pkgPath = path.join(root, "package.json")
  try {
    const j = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    const ws = Array.isArray(j.workspaces) ? j.workspaces : (j.workspaces && j.workspaces.packages) || []
    // workspaces 可能带 `packages/*` 这类通配；这里只取能直接当顶层目录名用的那些
    return { root, set: new Set(ws.filter((w) => !w.includes("*"))) }
  } catch (e) {
    throw new Red(2, `读不到 ${pkgPath} 的 workspaces —— packages 归类判不了`, String(e.message))
  }
}

/** 采样：一次算完四段 + summary。fixture 自检与真实调用共用这一条路径（避免两套口径）。 */
function scope(cwd, baseRef) {
  const headSha = gitText(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])
  const baseSha = resolveBase(cwd, baseRef)
  const mergeBase = uniqueMergeBase(cwd, baseSha, headSha)

  // 共同的 diff 开关：
  //   -z              防串行（空格/中文文件名）
  //   --no-renames    改名落成 delete+add（不是一条 R）
  //   --no-ext-diff   挡外部 diff 工具（纵深防御，name-only 实测本就不触发）
  //   --no-relative   挡 diff.relative=true 把路径重写成相对 cwd（真污染源）
  // 与官方 scripts/change-scope.ts:diffPaths 的旗标逐条对齐（本仓另有官方没有的 --no-relative）：
  //   --no-ext-diff / --no-textconv  外部 diff 与 textconv 驱动不得改写路径或内容
  //   --no-renames                   改名必须拆成「删旧 + 加新」两条，否则改动面漏掉旧路径
  //   --ignore-submodules=none       子模块变更要报出来，不静默吞
  //   --name-only / -z               只出路径、NUL 分隔（路径含空格/换行/CJK 时不会被拆错）
  //   --                             ⚠️ 结尾分隔符：没有它，后面的 sha/ref 可能被当成路径参数
  //   --no-relative                  （本仓新增）diff.relative=true 时从子目录跑会把路径压成裸文件名，
  //                                  静默把 areas/packages 算错 —— 官方无此配置故无需，我方需要。
  const DIFF = ["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--name-only", "-z", "--no-relative"]

  const committed = gitZ(cwd, ["diff", ...DIFF, mergeBase, headSha, "--"])
  const staged = gitZ(cwd, ["diff", "--cached", ...DIFF, "--"])
  const unstaged = gitZ(cwd, ["diff", ...DIFF, "--"])
  const untracked = gitZ(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"])

  const { set: wsSet } = workspacePackages(cwd)
  const all = [...committed, ...staged, ...unstaged, ...untracked]
  const areas = [...new Set(all.map(areaOf))].sort()
  const packages = [...new Set(all.map(areaOf).filter((a) => wsSet.has(a)))].sort()

  return {
    base: baseSha,
    mergeBase,
    committed,
    staged,
    unstaged,
    untracked,
    summary: { packages, areas, total: new Set(all).size },
  }
}

// ── 自检：真建 git 仓库，把每条判据的红绿两条路都走一遍 ────────────────────────
// 为什么不在真实仓库上自检：真实仓库的 base/改动是变的，绿了也证明不了什么；
// 而且反向对照（故意传错 base）必须能**造**出来，靠真库造不出来。
function selftest() {
  const t = []
  const tmp = mkdtempSync(path.join(tmpdir(), "change-scope-selftest-"))
  const run = (args, cwd = tmp) => {
    try {
      const out = execFileSync(process.execPath, [SELF, ...args], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" },
      })
      return { code: 0, out }
    } catch (e) {
      return { code: e.status ?? -1, out: e.stdout ?? "", err: e.stderr ?? "" }
    }
  }
  const g = (args) => execFileSync("git", args, { cwd: tmp, stdio: ["ignore", "pipe", "pipe"] })
  const gq = (args) => g(args).toString().trim()
  const write = (p, body) => {
    const full = path.join(tmp, p)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  const json = (r) => {
    try { return JSON.parse(r.out) } catch { return null }
  }

  try {
    // ── 夹具：一个普通的线性仓库，main 上有一个"本单"提交，外加三种未提交状态 ──
    g(["init", "-q", "-b", "main", "."])
    g(["config", "user.email", "selftest@local"])
    g(["config", "user.name", "selftest"])
    g(["config", "commit.gpgsign", "false"])
    write("package.json", JSON.stringify({ name: "fx", private: true, workspaces: ["pkg-a", "pkg-b"] }, null, 2))
    write("README.md", "base\n")
    write("scripts/old.mjs", "// old\n")
    g(["add", "-A"]); g(["commit", "-qm", "base"])
    const baseMain = gq(["rev-parse", "HEAD"])

    g(["checkout", "-qb", "ticket"])
    write("scripts/keep.mjs", "// keep\n")
    write("scripts/old.mjs", "// old v2\n")
    write("pkg-a/src/a.ts", "export const a = 1\n")
    g(["add", "-A"]); g(["commit", "-qm", "ticket work"])

    // 只改不暂存：committed 里有 a.ts，工作区又改了它的内容 ⇒ 同一文件两段各出现一次
    write("pkg-a/src/a.ts", "export const a = 2\n")
    // 已暂存但未提交（含空格 + 中文：换行分隔会串行的地方，-z 必须原样带出来）
    // ⚠️ 只 add 这一个路径 —— `add -A` 会把上面那份 unstaged 也一并吞进 staged，两段就都错了
    write("docs/带 空格 的 文件.md", "x\n")
    g(["add", "--", "docs/带 空格 的 文件.md"])
    // 未跟踪
    write("pkg-b/lib/b.ts", "export const b = 1\n")

    // 用例 1：四类分开且各自命中
    const r1 = run(["--base", "main"])
    const j1 = json(r1)
    t.push(["① 正常档：exit 0 且 stdout 是纯 JSON", r1.code === 0 && j1 !== null, `exit=${r1.code}`])
    t.push([
      "② committed 只含本单提交（三点口径，不含 base 自身）",
      JSON.stringify(j1?.committed?.sort()) === JSON.stringify(["pkg-a/src/a.ts", "scripts/keep.mjs", "scripts/old.mjs"].sort()),
      JSON.stringify(j1?.committed),
    ])
    t.push(["③ staged 只含已暂存那条（含空格中文名原样未串行）", JSON.stringify(j1?.staged) === JSON.stringify(["docs/带 空格 的 文件.md"]), JSON.stringify(j1?.staged)])
    t.push(["④ unstaged 只含未暂存那条", JSON.stringify(j1?.unstaged) === JSON.stringify(["pkg-a/src/a.ts"]), JSON.stringify(j1?.unstaged)])
    t.push(["⑤ untracked 只含未跟踪那条（不含 .gitignore 内）", JSON.stringify(j1?.untracked) === JSON.stringify(["pkg-b/lib/b.ts"]), JSON.stringify(j1?.untracked)])
    t.push(["⑥ areas 从路径推导（scripts/docs/pkg-a/pkg-b）", JSON.stringify(j1?.summary?.areas) === JSON.stringify(["docs", "pkg-a", "pkg-b", "scripts"]), JSON.stringify(j1?.summary?.areas)])
    t.push(["⑦ packages 从 workspaces 派生（pkg-a/pkg-b，不含 scripts/docs）", JSON.stringify(j1?.summary?.packages) === JSON.stringify(["pkg-a", "pkg-b"]), JSON.stringify(j1?.summary?.packages)])
    t.push(["⑧ total = 四段去重后的文件数（a.ts 两段只算一个）", j1?.summary?.total === 5, `total=${j1?.summary?.total}`])
    t.push(["⑨ base/mergeBase 都回 sha", /^[0-9a-f]{40}$/.test(j1?.base ?? "") && /^[0-9a-f]{40}$/.test(j1?.mergeBase ?? ""), `${j1?.base} / ${j1?.mergeBase}`])

    // 用例 2：--no-renames 生效（改名落成 delete+add，不是一条 R）
    g(["add", "-A"]); g(["commit", "-qm", "cleanup"])
    g(["mv", "scripts/keep.mjs", "scripts/renamed.mjs"])
    const j2 = json(run(["--base", "main"]))
    const stagedHas = (p) => (j2?.staged ?? []).includes(p)
    t.push([
      "⑩ --no-renames：改名 = 删旧 + 加新两条（不是一条 R）",
      stagedHas("scripts/keep.mjs") && stagedHas("scripts/renamed.mjs"),
      JSON.stringify(j2?.staged),
    ])

    // 用例 2b：--no-relative 生效 —— `diff.relative=true` 且在子目录里跑时，路径会被重写成相对 cwd
    // （探针实测 `sub/a` → `a`）。这正是**静默错**：路径看着像对的，areas/packages 却全归错。
    g(["config", "diff.relative", "true"])
    const jRel = json(run(["--base", "main"], path.join(tmp, "scripts")))
    // 期望仍是**仓库相对**的脚本路径（改名留下的删旧 + 加新两条都在）；被污染时会塌成裸文件名如 `keep.mjs`
    const allScriptPaths = (jRel?.staged ?? []).length > 0 && (jRel?.staged ?? []).every((p) => p.startsWith("scripts/"))
    t.push([
      "⑩b --no-relative：子目录 + diff.relative=true 时路径仍是仓库相对（不塌成裸文件名）",
      allScriptPaths,
      JSON.stringify(jRel?.staged),
    ])
    g(["config", "--unset", "diff.relative"])

    // 用例 3（反向对照）：故意传错 base ⇒ committed 必须跟着变
    // 这是本文件最容易写错的地方：base 若没真接进 diff，两种 base 会给出同一个答案。
    const jWrong = json(run(["--base", "HEAD"]))
    t.push([
      "⑪ 反向对照：--base HEAD 时 committed 必为空（base 真的接进了 diff，不是摆设）",
      Array.isArray(jWrong?.committed) && jWrong.committed.length === 0,
      `committed=${JSON.stringify(jWrong?.committed)}`,
    ])
    t.push([
      "⑫ 反向对照续：同一个仓库换 base，committed 由 N 条变 0 条（base 驱动输出）",
      (j2?.committed?.length ?? 0) > 0 && jWrong?.committed?.length === 0,
      `main=${j2?.committed?.length} vs HEAD=${jWrong?.committed?.length}`,
    ])

    // 用例 3b（**三点口径的反向对照**，本文件最容易退化的一处）：
    // 造「base 自己往前走了一步」的形态。此时两点 `base..HEAD` 会把 base 上那份**别人的**改动
    // 读成"本单删了它"（假删除）——那正是 docs/project-ops-rules.md §3.0-pre-b 记的三种事故之一
    // （`main..HEAD` 假删除 358 文件，害 ISS-687 建了又取消）。
    // 三点 `mergeBase..HEAD` 才只算本单的改动。变异 M9 把 mergeBase 换成 baseSha 时，这条必须红。
    g(["checkout", "-q", "-b", "upstream", baseMain])
    write("upstream-only.txt", "别人在 base 上新增的\n")
    g(["add", "-A"]); g(["commit", "-qm", "upstream work"])
    g(["checkout", "-q", "main"])
    const jThree = json(run(["--base", "upstream"]))
    t.push([
      "⑫b 三点口径：base 自己前进时，committed 不含「base 有而我没有」的假删除",
      Array.isArray(jThree?.committed) && !jThree.committed.includes("upstream-only.txt"),
      JSON.stringify(jThree?.committed),
    ])
    t.push([
      "⑫c 三点口径续：mergeBase ≠ base（mergeBase 退到分叉点，base 停在 upstream 尖）",
      jThree?.mergeBase === baseMain && jThree?.base !== baseMain,
      `mergeBase=${jThree?.mergeBase?.slice(0, 7)} base=${jThree?.base?.slice(0, 7)}`,
    ])

    // 用例 4（反向对照）：--base 缺失 ⇒ 判红并说清用法
    // ⚠️ 断言**退出码 3**（"没给输入"那一档），不是"非 0 就行"：
    //    变异实测（M4）把"必填"降级成默认 HEAD 时，脚本会 exit 0 并给出一份**看起来正常**的报告 ——
    //    只断言"非 0"抓不到它（那次是靠 ⑭ 才红的）。缺输入与判不了必须是独立的一档。
    const rNo = run([])
    t.push(["⑬ --base 缺失：退出码 3（没给输入），不猜成默认 HEAD", rNo.code === 3, `exit=${rNo.code}`])
    t.push(["⑬b --base 缺失：stderr 说清必填与两种正确取值", /必填|故意不猜/.test(rNo.err) && /--base main/.test(rNo.err) && /git fetch/.test(rNo.err), String(rNo.err).slice(0, 80)])
    const jNo = json(rNo)
    t.push(["⑭ --base 缺失时 stdout 仍是纯 JSON（可被机器读）", jNo !== null && jNo?.error?.kind === "missing-base", String(rNo.out).slice(0, 80)])

    // 用例 5（反向对照）：base 指向不存在的 ref ⇒ 判红，不静默退化成"空改动"
    const rBad = run(["--base", "no-such-ref-xyz"])
    const jBad = json(rBad)
    t.push(["⑮ base 解析不到：非 0（不静默当成空改动）", rBad.code !== 0 && !Array.isArray(jBad?.committed), `exit=${rBad.code}`])

    // 用例 6（本文件核心）：merge-base 不唯一 ⇒ 判红并列出全部候选
    // 造 criss-cross：两条分支互相合并对方，`merge-base --all` 会给出两个共同祖先。
    g(["checkout", "-q", "main"]); g(["checkout", "-qb", "bx"])
    write("x.txt", "x\n"); g(["add", "-A"]); g(["commit", "-qm", "x1"])
    const X1 = gq(["rev-parse", "HEAD"])
    g(["checkout", "-q", "main"]); g(["checkout", "-qb", "by"])
    write("y.txt", "y\n"); g(["add", "-A"]); g(["commit", "-qm", "y1"])
    const Y1 = gq(["rev-parse", "HEAD"])
    g(["checkout", "-q", "bx"]); g(["merge", "-q", "--no-edit", Y1, "-m", "xm"])
    const XM = gq(["rev-parse", "HEAD"])
    g(["checkout", "-q", "by"]); g(["merge", "-q", "--no-edit", X1, "-m", "ym"])
    const YM = gq(["rev-parse", "HEAD"])

    const mbAll = execFileSync("git", ["merge-base", "--all", XM, YM], { cwd: tmp, encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean)
    t.push(["⑯ 夹具自证：这个 criss-cross 确实有 2 个 merge-base（否则下一条是空测试）", mbAll.length === 2, `候选 ${mbAll.length} 个`])

    const rAmb = run(["--base", XM], tmp)
    // 在 YM 上看 XM 的改动面：merge-base(XM,YM) 不唯一
    g(["checkout", "-q", "by"])
    const rAmb2 = run(["--base", XM])
    const jAmb = json(rAmb2)
    t.push(["⑰ merge-base 不唯一：判红（exit 2），不是静默取第一个", rAmb2.code === 2, `exit=${rAmb2.code}`])
    t.push([
      "⑱ 红档要把**全部候选**列出来（不是只说一句「不唯一」）",
      /候选|\[1\]|\[2\]/.test(rAmb2.err) && mbAll.every((s) => rAmb2.err.includes(s.slice(0, 7))),
      `${(rAmb2.err || "").split("\n").slice(0, 4).join(" | ")}`,
    ])
    t.push(["⑲ 红档 stdout 仍是纯 JSON 且带 error（机器能读，呼应 ISS-708）", jAmb !== null && jAmb?.error?.kind === "ambiguous-merge-base", String(rAmb2.out).slice(0, 80)])
    void rAmb
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {
      // 清临时目录的尽力而为：失败不影响自检结论
    }
  }

  let bad = 0
  for (const [name, ok, detail] of t) {
    if (!ok) bad++
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ⇒ ${detail}`}`)
  }
  console.log(bad ? `✗ change-scope 自检失败：${bad}/${t.length}` : `✓ change-scope 自检全过：${t.length}/${t.length}`)
  process.exit(bad ? 2 : 0)
}

function main() {
  if (ARGS.includes("--selftest")) return selftest()

  const bi = ARGS.indexOf("--base")
  const baseRef = bi >= 0 ? ARGS[bi + 1] : undefined
  const unknown = ARGS.filter((a) => a.startsWith("--") && a !== "--base" && a !== "--selftest")

  if (unknown.length) {
    emitJson({ error: { kind: "unknown-option", message: `不认识的选项：${unknown.join(" ")}`, usage: USAGE } })
    human(`✗ 不认识的选项：${unknown.join(" ")}\n${USAGE}`)
    return 3
  }
  if (!baseRef || baseRef.startsWith("--")) {
    // ISS-711 铁律：base 必填。不猜上游（猜了会拿错改动面），不 fetch（会让本地与远端悄悄分家）。
    const msg = [
      "✗ 缺 --base —— 本工具**故意不猜** base。",
      "",
      USAGE,
      "",
      "为什么必填：",
      "  · 猜 base = 拿错改动面，整张「该跑什么」表都选错行；",
      "  · 替你 fetch = 你本地看的和远端拿的不是同一份历史。",
      "取值的正确姿势：想测「本单改了什么」用 `--base main`（脚本内部取 merge-base 走三点口径）；",
      "                想测「相对远端」先自己 `git fetch`，再 `--base origin/main`。",
    ].join("\n")
    emitJson({ error: { kind: "missing-base", message: "缺 --base（必填，不猜）", usage: USAGE } })
    human(msg)
    return 3
  }

  const cwd = process.cwd()
  const res = scope(cwd, baseRef)
  emitJson(res)
  return 0
}

const USAGE = [
  "用法：node scripts/change-scope.mjs --base <ref>",
  "      node scripts/change-scope.mjs --selftest",
  "输出：stdout 纯 JSON（committed/staged/unstaged/untracked + summary）；人类提示走 stderr。",
  "退出码：0 出报告 · 2 红（base 解析不了 / merge-base 不唯一）· 3 没给输入。",
].join("\n")

try {
  process.exit(main())
} catch (e) {
  if (e instanceof Red) {
    emitJson({ error: { kind: e.code === 2 ? redKind(e) : "red", message: e.detail, hint: e.hint } })
    human(`✗ ${e.detail}`)
    if (e.hint) human(`  ${e.hint}`)
    process.exit(e.code)
  }
  emitJson({ error: { kind: "crash", message: String(e && e.message ? e.message : e) } })
  human(`✗ 崩溃：${e && e.stack ? e.stack : e}`)
  process.exit(2)
}

/** 给红档一个机器可辨的 kind（下游按 kind 分流，不解析中文文案 —— 文案一改就恒绿）。 */
function redKind(e) {
  if (/merge-base 不唯一/.test(e.detail)) return "ambiguous-merge-base"
  if (/解析不到一个 commit/.test(e.detail)) return "unresolvable-base"
  if (/没有共同祖先/.test(e.detail)) return "no-common-ancestor"
  if (/workspaces/.test(e.detail)) return "unreadable-workspaces"
  return "red"
}
