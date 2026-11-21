#!/usr/bin/env node
// wt-scan.mjs —— 工作树治理的**只读采集层**原型（2026-09-28 · 设计方案 §WG1~WG5）
//
// 要回答的五个问题（老板 09-28 原话）：有多少 / 进行到哪里 / 内容是什么 / 用了多少空间 / 哪个 agent 在执行。
//
// 三条设计纪律：
//  ① **现算不缓存**：树的数量一天内可以大幅变（09-27 记录 17 棵 → 09-28 现量 16 棵），任何台账快照都会骗人。
//  ② **枚举以 git 为权威，路径只是落点**：`git worktree list --porcelain` 是唯一能同时看见三根路径
//     （`~/wt/dsh-forge` · 主 checkout 内嵌 `.wt/` · `~/orca/workspaces/`）的真相源；再用目录清单做**差集**
//     抓「目录在但 git 没注册」的孤儿和「git 注册了但目录没了」的 prunable。
//  ③ **归属只能是推断 + 来源 + 置信**：没有单一真相源（租约 owner 是 env 自报、单槽只容一单；
//     `git worktree lock` 现量 0 棵；agent-runs 不映射到树）。查不到就写「未知」，**绝不把「没有证据」显示成「没人」**.
//
// 只读：全程 `spawnSync` 只跑 git 读命令 + fs 读 + du/lsof。**不写盘**（除显式 `-o` 指定的输出文件）。
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { untrackedDirsFromPorcelain } from "./wt-scan-lib.mjs"
import { homedir } from "node:os"

const HOME = homedir()
const REPO = process.env.DSH_FORGE_REPO || join(HOME, "dsh-forge")
const REPO_NAME = basename(REPO)
const WT_ROOT = process.env.DSH_FORGE_WT_ROOT || join(HOME, "wt", REPO_NAME)
const IN_REPO_ROOT = join(REPO, ".wt")
const ORCA_ROOT = join(HOME, "orca", "workspaces", REPO_NAME)
// 插件挂载家必须与 `ws.sh` 同一条口径（ISS-554 之后 ws.sh 跟随 DSH_HOME，并留 WS_PROFILES_NM 覆盖）：
// 写死 ~/.dsh 的话，"插件占着 N" 数的是另一个家的链接，报表上那一列永远与现实无关。
const PROFILES_NM = process.env.WS_PROFILES_NM
  || join(process.env.DSH_HOME || join(HOME, ".dsh"), "profiles", "node_modules")
// ISS-552 W-3：治理件看的「家」不止一个候选。
//   实测（2026-10-01 06:12）：跑着的 3210 服务环境里 `DSH_HOME=~/.dsh-matter`，而 `ws.sh`
//   与本作读的是 `~/.dsh` ⇒ 租约这份状态**可能同时在两个家各有一份**（或只在其中一个）。
//   采集层的职责不是"挑一个家"然后装作没有别家 —— 那正是把假绿搬进报表的形状。
//   做法：每个候选都读、都说清看到什么；`~/.dsh` 仍是主口径（与 `ws.sh` 现行写入位置一致，
//   不改写入位置是刻意的：新旧脚本各写一家会把互踩放大，切换要挑没有他人在途的窗口）。
const STATE_DIR_PRIMARY = join(HOME, ".dsh")
const HOME_CANDIDATES = [...new Set([
  process.env.WS_STATE_DIR || "",
  process.env.DSH_HOME || "",
  STATE_DIR_PRIMARY,
].filter(Boolean))]
const LOCK_FILE = join(STATE_DIR_PRIMARY, "workspace-lock.json")
const SALVAGE_ROOT = join(HOME, ".dsh", "worktree-salvage")
const PM_ISSUES = join(HOME, ".dsh", "pm", "issues")
const BASE_BRANCH = process.env.WT_BASE || "main"

// **落点根清单**（09-28 全机扫描后从 3 根扩到 8 根）。为什么不能只盯 `ws.sh` 的两根：
// 本机实测有六家 agent 各自发明过工作树落点，其中 Trae / opencode 的约定**今天还是空的**，
// 空 ≠ 不存在约定 —— 明天它们建一棵，只认两根的枚举就会把它变成看不见的孤儿。
// 每项 = [根路径, 往下找几层]（`.trae-cn/worktrees/<仓>/<树>` 与 `opencode/worktree/<scope>/<名>` 是两层）。
const ROOTS = [
  [WT_ROOT, 1], // ws.sh 现行根
  [IN_REPO_ROOT, 1], // 主 checkout 内嵌（上一代落点，仍可能被 profile 软链解析到）
  [join(REPO, ".tmp", "wt"), 1], // ws.sh:366 的写穿扫描认它
  [ORCA_ROOT, 1], // Orca 自建
  [join(REPO + ".worktrees"), 1], // `<仓>.worktrees` 同级约定（opencode 用过，实测有死树）
  [join(HOME, ".local", "share", "opencode", "worktree"), 2], // opencode
  [join(HOME, ".trae-cn", "worktrees"), 2], // Trae CN（`<仓>/<名>` 两级）
  [join(HOME, "agent-os", "worktrees"), 1], // agent-os
]

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const OPT_DU = !has("--no-du")
const OPT_JSON = has("--json")
// `--machine`：全家扫 `.git` **文件**（工作树检出的唯一物证），用来抓「别的仓的树」和
// 「主仓已被删/改名的死树」——这两类**不可能**从单仓 `git worktree list` 里看到。慢（实测分钟级），默认关。
const OPT_MACHINE = has("--machine")
// `--detail`：多跑 4~6 个 git 调用/树，换回「地图 + diff」要的节点与正文（实测 +2 s）。
const OPT_DETAIL = has("--detail")
let machineNote = "未扫全家（加 --machine 开）"
const OUT = (() => {
  const i = args.indexOf("-o")
  return i >= 0 ? args[i + 1] : null
})()

function run(cmd, cargs, cwd, ms = 15000, buf = 8 * 1024 * 1024) {
  const r = spawnSync(cmd, cargs, { cwd, encoding: "utf8", timeout: ms, maxBuffer: buf })
  return r.status === 0 ? (r.stdout || "") : ""
}
/** 与 run() 同，但**把失败带回来**——用于"扫不到就等于没有"会骗人的场合（WGF3）。 */
function runChecked(cmd, cargs, cwd, ms = 15000, buf = 64 * 1024 * 1024) {
  const r = spawnSync(cmd, cargs, { cwd, encoding: "utf8", timeout: ms, maxBuffer: buf })
  return { out: r.stdout || "", status: r.status, err: r.error ? String(r.error.message || r.error) : "", stderr: r.stderr || "" }
}
const git = (cwd, ...cargs) => run("git", cargs, cwd)
const num = (s) => {
  const n = parseInt(String(s).trim(), 10)
  return Number.isFinite(n) ? n : null
}

// ── ① 枚举：git 权威清单 + 三根路径目录清单（差集抓孤儿/失效）────────────────
function registered() {
  const raw = git(REPO, "worktree", "list", "--porcelain")
  const list = []
  let cur = null
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9).trim(), locked: null, prunable: null }
    else if (line.startsWith("branch ")) cur && (cur.branch = line.slice(7).replace("refs/heads/", ""))
    else if (line.startsWith("HEAD ")) cur && (cur.head = line.slice(5))
    else if (line.startsWith("locked ")) cur && (cur.locked = line.slice(7))
    else if (line === "prunable" || line.startsWith("prunable ")) cur && (cur.prunable = line === "prunable" ? "unspecified" : line.slice(9))
    else if (line === "" && cur) {
      list.push(cur)
      cur = null
    }
  }
  if (cur) list.push(cur)
  return list
}

function dirsOnDisk() {
  const out = []
  // 按 ROOTS 逐根深探（深度 = 该根约定的层数）；`.git` 是**文件**才算检出（工作树标记），
  // 目录则是独立仓（比如主 checkout 本身），不算树。
  const walk = (dir, depth) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith(".")) continue // .orca-worktree-trash / .orca-preparing / .DS_Store
      const p = join(dir, name)
      let st = null
      try {
        st = statSync(p)
      } catch {}
      if (!st?.isDirectory()) continue
      let gitMarker = null
      try {
        gitMarker = statSync(join(p, ".git"))
      } catch {}
      if (gitMarker?.isFile()) out.push(p)
      else if (depth > 1) walk(p, depth - 1)
    }
  }
  for (const [root, depth] of ROOTS) {
    if (existsSync(root)) walk(root, depth)
  }
  return out
}

/** 某个检出目录落在哪根约定下（供报表说明"这棵树是谁、按什么约定建的"）。 */
function rootLabelOf(path) {
  const named = {
    [WT_ROOT]: "ws.sh",
    [IN_REPO_ROOT]: "in-repo（上一代落点）",
    [ORCA_ROOT]: "external（Orca）",
    [join(REPO, ".tmp", "wt")]: "tmp-wt",
    [join(REPO + ".worktrees")]: "外部落点（<仓>.worktrees）",
    [join(HOME, ".local", "share", "opencode", "worktree")]: "外部落点（opencode）",
    [join(HOME, ".trae-cn", "worktrees")]: "外部落点（Trae）",
    [join(HOME, "agent-os", "worktrees")]: "外部落点（agent-os）",
  }
  for (const [root, label] of Object.entries(named)) if (path.startsWith(root + "/")) return label
  return path === REPO ? "main" : "unknown-legacy"
}

/** 读某个检出目录的 `.git` 文件 ⇒ 它真正属于哪个仓（`gitdir: <仓>/.git/worktrees/<名>`）。 */
function ownerRepoOf(path) {
  try {
    const line = readFileSync(join(path, ".git"), "utf8").trim()
    const m = line.match(/^gitdir:\s*(.+)$/)
    if (!m) return null
    const gd = m[1].trim()
    const owner = gd.includes("/.git/worktrees/") ? gd.slice(0, gd.indexOf("/.git/worktrees/")) : null
    return { gitdir: gd, owner, alive: owner ? existsSync(owner) : false }
  } catch {
    return null
  }
}

function trashContents() {
  const dir = join(WT_ROOT, ".orca-worktree-trash")
  if (!existsSync(dir)) return { path: dir, entries: 0 }
  return { path: dir, entries: readdirSync(dir).length }
}

// ── ② Matter 侧真相：单号 → 状态/标题（读 pm 的 md frontmatter，不猜）────────
// 单号在 **frontmatter 的 `id:`**，不在文件名（现存 1972 个文件里既有 `2026-08-16-1.md`
// 也有 `2026-08-16-ISS-ISS-001.md`，文件名里的号还会双写）⇒ 只能按 `id:` 建索引。
function matterIndex() {
  const map = new Map()
  if (!existsSync(PM_ISSUES)) return map
  for (const f of readdirSync(PM_ISSUES)) {
    if (!f.endsWith(".md") || f.includes("-activity.md") || f.includes("-comments.md")) continue
    const text = readFileSync(join(PM_ISSUES, f), "utf8").slice(0, 2000)
    const fm = text.match(/^---\n([\s\S]*?)\n---/)
    if (!fm) continue
    const get = (k) => {
      const mm = fm[1].match(new RegExp(`^${k}:\\s*"?([^"\\n]*)"?$`, "m"))
      return mm ? mm[1].trim() : ""
    }
    const id = get("id")
    if (!id) continue
    map.set(id, {
      status: get("status"),
      title: get("title"),
      estimate: get("estimate"),
      // 审核态：双态机正交于 status（forge-pm api.ts:129「status=代码态 × verdict=审查态」）
      verdict: get("verdict"),
      assignee: (() => {
        // assignee 在 frontmatter 里可能是 `due:` 这种 YAML 嵌套的残留（实测 09-29 取到 "due:"），
        // 只有像 `linmo` / `@dylan` 的字面量才算人，故白名单式判定，不直接透传。
        const a = get("assignee")
        return /^[@A-Za-z0-9_.-]{1,40}$/.test(a) ? a : ""
      })(),
      file: f,
    })
  }
  return map
}

// ── ③ 归属四源：租约 / git lock / 进程 cwd / agent-runs ────────────────────
function readLease(lockPath) {
  if (!existsSync(lockPath)) return null
  try {
    const d = JSON.parse(readFileSync(lockPath, "utf8"))
    if (!d || !d.iss) return null
    const exp = d.expire ? new Date(d.expire).getTime() : 0
    return { ...d, active: exp > Date.now(), minutesLeft: Math.round((exp - Date.now()) / 60000) }
  } catch {
    return null
  }
}
function leaseOf() {
  return readLease(LOCK_FILE)
}

/**
 * 每个候选家里的租约都说一句话（ISS-552 W-3）。
 * 三条纪律：① 读不到 ≠ 没有 ⇒ 分 `lease` / `无租约` / `读失败` 三种说法；
 * ② 不一致时不许沉默（`split` 旗标 + 人读那一行会直接印出来）；
 * ③ 不改写任何一家（本模块全程只读）。
 */
function leaseSweep() {
  const rows = HOME_CANDIDATES.map((dir) => {
    const lockPath = join(dir, "workspace-lock.json")
    let status = "无锁文件"
    let lease = null
    if (existsSync(dir)) {
      if (existsSync(lockPath)) {
        lease = readLease(lockPath)
        status = lease ? `租约 ${lease.iss}${lease.active ? "（在途）" : "（已过期）"}` : "锁文件在读不到单号（已释放态或形状不对）"
      }
    } else {
      status = "目录不存在"
    }
    return { dir, lockPath, status, iss: lease ? lease.iss : null, active: lease ? !!lease.active : null }
  })
  const holders = new Set(rows.filter((r) => r.iss && r.active).map((r) => String(r.iss)))
  return { rows, split: holders.size > 1, holderCount: holders.size, homes: rows.length }
}
function processCwd() {
  // 现成命令面：lsof 的 cwd 段。取不到就当无证据（不同机器 lsof 权限不一）。
  const out = run("lsof", ["-a", "-d", "cwd", "-c", "node", "-c", "bun", "-c", "DeepSeek", "-c", "trae", "-c", "zcode", "-w"], REPO, 30000)
  const rows = []
  for (const line of out.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 9) continue
    const cwd = parts.slice(8).join(" ")
    if (cwd) rows.push({ cmd: parts[0], pid: parts[1], cwd })
  }
  return rows
}
function linkOccupants() {
  // 哪些插件正从某棵树取产物（删树的断链风险 = ISS-862 现场）
  const map = new Map()
  if (!existsSync(PROFILES_NM)) return map
  for (const name of readdirSync(PROFILES_NM)) {
    if (!/^(forge-|matter)/.test(name)) continue
    let tgt = ""
    try {
      tgt = readlinkSync(join(PROFILES_NM, name))
    } catch {
      continue
    }
    if (!tgt || tgt.startsWith(REPO + "/matter")) continue
    for (const root of [WT_ROOT, IN_REPO_ROOT, ORCA_ROOT]) {
      if (tgt.startsWith(root)) {
        const key = root + "/" + tgt.slice(root.length + 1).split("/")[0]
        map.set(key, [...(map.get(key) || []), name])
      }
    }
  }
  return map
}

// ── ④ 分类判据（确定性、可判红；顺序即优先级）────────────────────────────
function classify(t, lease) {
  // ⚠️ `living` 是数组：**空数组也是 truthy** ⇒ 判活一律数长度（第一版把 6 棵无人在跑的树
  //    报成了「在途」，症状正是"谁在跑"这一格全绿 = 全红）。
  if (t.isMain) return { state: "主库", note: "只跑服务与收口合并，不参与回收（铁律 7）" }
  if (t.prunable) return { state: "失效", note: "git 已注册但目录不在（prunable）" }
  if (t.orphan) return { state: "孤儿", note: "目录像工作树但 git 没注册" }
  if (String(t.ownership).startsWith("external")) return { state: "外部", note: "非 ws.sh 所建（Orca / 第三方 agent）⇒ 只看不碰" }
  if (t.livingCount > 0) return { state: "在途", note: `有进程 cwd 在此树内（${t.living.join(", ")}）` }
  if (t.dirtyTotal > 0) return { state: "在途", note: `工作区还有 ${t.dirtyTotal} 个未提交改动` }
  if (lease?.active && lease.iss === t.iss) return { state: "在途", note: `租约未过期（剩 ${lease.minutesLeft} 分）` }
  if (t.ahead > 0) return { state: "需人判", note: `分支有 ${t.ahead} 个未进 ${BASE_BRANCH} 的提交（合？弃？）` }
  // ahead=0 且 behind=0 = **与 base 同点**：刚 `ws.sh new` 出来、一行还没写（09-28 实测 ISS-924 落在这里，
  // 说明判据少了一格 —— 不补就会天天报"待判断"，而"待判断"等于没答第五问之外的第二问）。
  if (t.ahead === 0 && t.behind === 0) return { state: "新树", note: `与 ${BASE_BRANCH} 同点、工作区干净 ⇒ 刚建还没开工` }
  // **git 单源分不开"没干活"与"干完并合了"**：两种都是 ahead=0 + 干净 + behind>0。
  // 唯一能把它们分开的是单据状态 ⇒ 进度这一格必须两源合判（git + Matter）。09-28 实测：
  // ISS-924 建完 13 分钟后 main 前进了两个提交，光看 git 它就和 6 棵"已交付待清"长得一模一样。
  if (t.ahead === 0 && t.behind > 0 && t.matter && /^(backlog|todo)$/.test(t.matter.status))
    return { state: "未动工", note: `git 上没东西，但单据仍是 ${t.matter.status} ⇒ 树建了没开工（不是"已交付"）` }
  if (t.ahead === 0 && t.behind > 0) return { state: "可回收", note: `提交已全部进 ${BASE_BRANCH}，落后 ${t.behind} 个` }
  return { state: "待判断", note: "以上条件都不命中" }
}

function sizeOf(path) {
  if (!OPT_DU) return null
  // du 默认**不跟随软链** ⇒ 这个数就是「该树的增量磁盘成本」（依赖镜像是链接、不计入），
  // 而老式「整目录软链」的树会把真实字节算进来 —— 两种树放一起比大小之前必须知道这条口径。
  const out = run("du", ["-sk", path], REPO, 240000)
  const kb = num(out.split("\t")[0])
  return kb
}

/**
 * `--detail`：给「git 地图 + diff」两视图取数（地图要分叉点与提交节点，diff 要正文）。
 * 字节纪律照 Orca 的 tail 契约：**每个文件最多 DIFF_CAP 行**，超出插一行「… 中间省略 N 行 …」——
 * 一个失控的巨型文件不该把整页撑爆（09-28 实测最大一棵 42 文件 / 260 KB）。
 */
const DIFF_CAP = 200
const DIFF_BUDGET = 40000 // 每棵树内联 diff 的总字节上限；超了就停，剩下的只给文件名（整页不能被一棵树撑死）
function capDiff(text) {
  if (!text) return ""
  const chunks = text.split("\ndiff --git ")
  const kept = []
  let used = 0
  for (let i = 0; i < chunks.length; i++) {
    let c = chunks[i]
    const lines = c.split("\n")
    if (lines.length > DIFF_CAP) {
      c = lines.slice(0, DIFF_CAP).join("\n") + `\n… 中间省略 ${lines.length - DIFF_CAP} 行（全量：cd 到该树跑 git diff）…`
    }
    used += c.length
    if (used > DIFF_BUDGET) {
      kept.push(`… 其余 ${chunks.length - i} 个文件的改动未内联（超预算 ${DIFF_BUDGET} B；全量在树上跑 git diff）…`)
      break
    }
    kept.push(c)
  }
  return kept.join("\ndiff --git ")
}
/**
 * 主干上的「并回点」——**一次取全**（替代每棵树跑一次 `--grep`），两条硬条件：
 *  ① 在 main 的 **first-parent 链**上 = 真正并入主干那一步（不是侧线互并 / back-merge）；
 *  ② **标题行**带该单号。本仓 M-023 之后多数合并写成 `merge(ISS-854): 自审收口…`，
 *    只有少数是 git 默认的 `Merge branch 'ISS-927'`；而 `--grep` 是**全文匹配**，
 *    09-28 实测会把"正文提到 ISS-891 的 ISS-907 合并"当成 891 的并回点 ⇒ 必须按标题行再判一次。
 */
let _merges = null
function trunkMerges() {
  if (_merges) return _merges
  const SEP = "\u001f"
  _merges = git(REPO, "log", "--merges", "--first-parent", `--format=%h${SEP}%cI${SEP}%s`, "-n", "400", BASE_BRANCH)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, date, subject] = l.split(SEP)
      return { hash, date, subject, iss: (subject.match(/ISS-\d+/) || [])[0] || null }
    })
  return _merges
}
function detailOf(path, iss) {
  const SEP = "\u001f"
  const mb = git(path, "merge-base", BASE_BRANCH, "HEAD").trim()
  const commits = git(path, "log", `--format=%h${SEP}%cI${SEP}%an${SEP}%s`, `${BASE_BRANCH}..HEAD`)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, date, author, subject] = l.split(SEP)
      return { hash, date, author, subject }
    })
  // 已并回的树：地图要画出"回流到主干哪一格"⇒ 查上面那张 first-parent 并回点表（标题行含本单号的那一枚）
  const mrec = iss ? trunkMerges().find((m) => m.iss === iss) : null
  const mh = mrec ? mrec.hash : null
  const mdate = mrec ? mrec.date : null
  const msubject = mrec ? mrec.subject : null
  // GitLens 的做法：merge 带进来的提交画成**一条支线**，而不是"这棵树没东西"。
  // `merge^1..merge^2` = 这次合并从侧线带进来的全部提交 ⇒ 已并回的树靠它才有"内容"可读。
  const merged = mh ? git(REPO, "log", "--oneline", `${mh}^1..${mh}^2`).split("\n").filter(Boolean).slice(0, 12) : []
  const files = git(path, "diff", "--numstat", `${BASE_BRANCH}...HEAD`)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [add, del, f] = l.split("\t")
      return { file: f, add: num(add) ?? add, del: num(del) ?? del }
    })
  return {
    mergeBase: mb ? { hash: mb.slice(0, 8), date: git(path, "log", "-1", "--format=%cI", mb) } : null,
    commits,
    mergedCommits: merged, // 已并回的树：这次 merge 带进主干的那几笔（GitLens 的"支线"）
    files,
    mergeCommit: mh ? { hash: mh, date: mdate, subject: msubject } : null,
    mergedDiff: mh && merged.length ? capDiff(git(REPO, "diff", `${mh}^1..${mh}^2`)) : "",
    // 已并回的树也要有"内容"：这次合并改了哪些文件（numstat 一行一条，比 diff 正文便宜得多）
    mergedFiles: mh
      ? git(REPO, "diff", "--numstat", `${mh}^1..${mh}^2`)
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [add, del, f] = l.split("\t")
            return { file: f, add: num(add) ?? add, del: num(del) ?? del }
          })
          .slice(0, 40)
      : [],
    branchDiff: capDiff(git(path, "diff", `${BASE_BRANCH}...HEAD`, "--", ".", ":!*.lock")),
    workDiff: capDiff(git(path, "diff")),
    untracked: git(path, "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean),
  }
}

const t0 = Date.now()
const lease = leaseOf()
const procs = processCwd()
const matters = matterIndex()
const occupants = linkOccupants()
const reg = registered()
const regPaths = new Set(reg.map((r) => r.path))
const disk = dirsOnDisk()

const rows = []
// 地图视图的横轴 = **main 的提交序号**（离散、真实），所以要知道主干最近这一段。
// 500 条覆盖得住现状（最老的树 behind ≈ 155）；超窗的树在地图上标"基线超出窗口"，不假装画对了。
const MAIN_WINDOW = 500
const mainLog = (OPT_DETAIL
  ? git(REPO, "log", `--format=%h${"\u001f"}%cI${"\u001f"}%s`, "-n", String(MAIN_WINDOW), BASE_BRANCH)
  : ""
)
  .split("\n")
  .filter(Boolean)
  .map((l, i) => {
    const [hash, date, subject] = l.split("\u001f")
    return { hash, date, subject, i }
  })
const mainIndex = new Map(mainLog.map((c) => [c.hash, c.i]))
for (const entry of reg) {
  const path = entry.path
  const isMain = path === REPO
  const branch = entry.branch || git(path, "rev-parse", "--abbrev-ref", "HEAD")
  const iss = (branch || "").match(/ISS-\d+[A-Za-z0-9-]*/)?.[0] || basename(path).match(/ISS-\d+|DOC-\d+|PRJ-\d+|^[a-z]+$/)?.[0] || ""
  const ownership = isMain ? "main" : rootLabelOf(path)
  const st = git(path, "status", "--porcelain")
  const lines = st.split("\n").filter(Boolean)
  const dirty = lines.filter((l) => !/^\?\?/.test(l)).length
  const untracked = lines.filter((l) => /^\?\?/.test(l)).length
  const ahead = num(git(path, "rev-list", "--count", `${BASE_BRANCH}..HEAD`))
  const behind = num(git(path, "rev-list", "--count", `HEAD..${BASE_BRANCH}`))
  const commits = git(path, "log", "--oneline", `${BASE_BRANCH}..HEAD`).split("\n").filter(Boolean)
  const changed = git(path, "diff", "--name-only", `${BASE_BRANCH}...HEAD`).split("\n").filter(Boolean)
  const lastCommit = git(path, "log", "-1", "--format=%cI")
  const living = procs.filter((p) => p.cwd === path || p.cwd.startsWith(path + "/"))
  const row = {
    path,
    isMain,
    iss,
    branch,
    ownership,
    head: (entry.head || git(path, "rev-parse", "--short", "HEAD")).slice(0, 8),
    baseRef: git(path, "config", `--get`, `branch.${branch}.base`) || null,
    locked: entry.locked || null,
    prunable: entry.prunable || null,
    orphan: false,
    ahead,
    behind,
    unpushed: commits.length, // = ahead（未进 base 的提交数）；保留别名供报表用
    dirty,
    untracked,
    dirtyTotal: dirty + untracked,
    commits,
    changedFiles: changed,
    lastCommitAt: lastCommit || null,
    sizeKB: isMain ? null : sizeOf(path),
    living: living.map((p) => `${p.cmd}:${p.pid}`),
    plugins: occupants.get(path) || [],
    matter: matters.get(iss) || null,
    lease: lease && lease.iss === iss ? lease : null,
  }
  row.livingCount = row.living.length
  row.detail = OPT_DETAIL && !isMain ? detailOf(path, iss) : null
  if (row.detail) {
    // 地图横轴的落点。取不到 = 基线在主干窗口之外 ⇒ **由视图显式标注**，不许悄悄画成 0
    row.detail.baseIndex = row.detail.mergeBase ? mainIndex.get(row.detail.mergeBase.hash) ?? null : null
    row.detail.mergeIndex = row.detail.mergeCommit ? mainIndex.get(row.detail.mergeCommit.hash) ?? null : null
  }
  const c = classify(row, lease, procs)
  row.state = c.state
  row.stateNote = c.note
  rows.push(row)
}
// 差集：目录里有 `.git` 文件、但本仓 git 没注册。两种，必须分开：
//  ① **本仓孤儿** = `.git` 指向本仓 ⇒ 判据命中，进处置面；
//  ② **外仓树** = `.git` 指向别的仓 ⇒ **不算本仓的树**（混进来会虚报数量）；其中
//     指向的主仓已不存在/已改名的 = **死树**：`git worktree prune` 都管不到（登记方已消失），
//     只能当普通目录删。09-28 全机扫实测 2 棵（opencode 的 `OpenForge` 改名成 `OpenForge.git` 留下）。
const foreign = []
for (const p of disk) {
  if (regPaths.has(p)) continue
  const own = ownerRepoOf(p)
  if (!own || own.owner !== REPO) {
    foreign.push({
      path: p,
      ownerRepo: own?.owner || "(.git 读不出)",
      ownerAlive: own?.alive ?? false,
      dead: !own?.alive,
      sizeKB: sizeOf(p),
    })
    continue
  }
  rows.push({
    path: p,
    isMain: false,
    iss: basename(p),
    branch: "?",
    ownership: rootLabelOf(p),
    state: "孤儿",
    stateNote: "目录内有 .git 且未被 git worktree 注册",
    sizeKB: sizeOf(p),
  })
}

// `--machine`：扫全家找 `.git` 文件。单仓视角永远看不见「别的仓的树」，而治理要的恰恰是
// 「本机还有哪些 agent 在发明落点」——只有这一条路能答（实测分钟级，故默认关）。
if (OPT_MACHINE) {
  const found = runChecked(
    "find",
    [HOME, "-name", ".git", "-type", "f",
      "-not", "-path", "*/node_modules/*", "-not", "-path", join(HOME, "Library") + "/*",
      "-not", "-path", join(HOME, ".Trash") + "/*", "-not", "-path", "*/.git/*",
      "-not", "-path", join(HOME, ".dsh") + "/*"],
    HOME,
    570000,
  )
  // BSD find 的退出码语义：**1 = 有目录进不去（权限等），结果仍然可用；>1 才是真失败**。
  // 把 1 当失败 ⇒ 本机永远报"未判"（实测就是 1）；把 1 当成功 ⇒ 掩盖真断了。取中间：出数 + 把错误行数摊开。
  const errLines = found.stderr.split("\n").filter(Boolean).length
  if (found.err || found.status > 1) {
    machineNote = `⚠️ 全家扫失败（${found.err || `exit ${found.status}`}）⇒ 外仓/死树这一格**未判**，别当"没有"`
  } else {
    const seen = new Set(rows.concat(foreign).map((r) => r.path))
    let n = 0
    for (const line of found.out.split("\n").filter(Boolean)) {
      const p = line.replace(/\/\.git$/, "")
      n++
      if (seen.has(p)) continue
      const own = ownerRepoOf(p)
      if (!own) continue
      foreign.push({
        path: p,
        ownerRepo: own.owner || "(非工作树)",
        ownerAlive: own.alive,
        dead: !own.alive,
        ofThisRepo: own.owner === REPO,
        sizeKB: sizeOf(p),
      })
    }
    machineNote = `已扫全家 .git 文件（命中 ${n} 处 · 进不去 ${errLines} 个目录）`
  }
}

const totalKB = rows.reduce((s, r) => s + (r.sizeKB || 0), 0)
// ── 主检出的未跟踪顶层目录（ISS-553）──
// 为什么这一格必须存在：`forge-widgets/` 09-29 08:05 起在主检出裸奔 2 天，4 个文件、从未入库、
// 没有任何单据认领，而 K4a/K7b 天天为它红 —— 本盘点器原来看不见它（它不是工作树、也不是租约）。
// 归属三条说法分开写：**读不到 ≠ 没有**（unreadable），无单号 = 无主，有单号但租约不匹配 = 待查。
function mainUntrackedDirs() {
  const r = spawnSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" })
  if (!r || r.status !== 0) return { unreadable: true, note: String((r && r.stderr) || "git status 失败").slice(0, 80), rows: [] }
  const lease = leaseOf()
  const rows = untrackedDirsFromPorcelain(r.stdout).map((d) => {
    let mtime = null
    try { mtime = statSync(join(REPO, d.name)).mtime.toISOString() } catch { /* 读不到就留 null，不猜 */ }
    const m = /\bISS-\d+\b/.exec(d.name)
    const iss = m ? m[0] : null
    const ownership = !iss ? "无主"
      : (lease && lease.active && lease.iss === iss ? "有在途租约" : "带单号但无在途租约")
    return { name: d.name, mtime, iss, ownership }
  })
  return { unreadable: false, rows }
}

const summary = {
  generatedAt: new Date().toISOString(),
  mainUntracked: mainUntrackedDirs(),
  elapsedMs: Date.now() - t0,
  repo: REPO,
  base: BASE_BRANCH,
  counts: {
    registered: reg.length,
    trees: rows.filter((r) => !r.isMain).length,
    byState: rows.reduce((m, r) => ((m[r.state] = (m[r.state] || 0) + 1), m), {}),
    byOwnership: rows.reduce((m, r) => ((m[r.ownership] = (m[r.ownership] || 0) + 1), m), {}),
    locked: rows.filter((r) => r.locked).length,
    living: rows.filter((r) => r.livingCount > 0).length,
    withLease: rows.filter((r) => r.lease).length,
    pluginOccupied: rows.filter((r) => r.plugins?.length).length,
    salvageDirs: existsSync(SALVAGE_ROOT) ? readdirSync(SALVAGE_ROOT).length : 0,
    foreign: foreign.length,
    deadForeign: foreign.filter((f) => f.dead).length,
  },
  totalSizeKB: totalKB,
  foreignSizeKB: foreign.reduce((s, f) => s + (f.sizeKB || 0), 0),
  roots: ROOTS.filter(([r]) => existsSync(r)).map(([r]) => r),
  machine: machineNote,
  mainWindow: mainLog.length ? { n: mainLog.length, newest: mainLog[0].hash, oldest: mainLog[mainLog.length - 1].hash } : null,
  du: OPT_DU ? "du -sk（不跟随软链 = 增量成本口径）" : "跳过（--no-du）",
  trash: trashContents(),
  lease,
  // ISS-552 W-3：候选家各自的租约视图（不一致时 `split=true`，人读那一行会直接印出来）
  leaseHomes: leaseSweep(),
}

if (OPT_JSON) {
  const json = JSON.stringify({ summary, rows, foreign, main: mainLog, merges: OPT_DETAIL ? trunkMerges() : [] }, null, 2)
  if (OUT) writeFileSync(OUT, json)
  else console.log(json)
} else {
  const f = (r, w) => String(r ?? "-").padEnd(w).slice(0, w)
  console.log(`工作树 ${summary.counts.trees} 棵（已注册 ${summary.counts.registered} 条含主库）· 合计 ${Math.round(totalKB / 1024)} MB · 采集 ${summary.elapsedMs}ms`)
  console.log(`${f("状态", 10)}${f("单号", 11)}${f("归属", 22)}${f("+/-", 8)}${f("脏", 5)}${f("空间", 8)}${f("活进程", 7)}${f("最后提交", 12)}判据说明`)
  for (const r of rows) {
    console.log(
      `${f(r.state, 10)}${f(r.iss, 11)}${f(r.ownership, 22)}${f(`${r.unpushed ?? "?"}/${r.behind ?? "?"}`, 8)}${f(r.dirtyTotal ?? 0, 5)}${f(r.sizeKB ? Math.round(r.sizeKB / 1024) + "M" : "-", 8)}${f(r.livingCount || "-", 7)}${f((r.lastCommitAt || "").slice(5, 16).replace("T", " "), 12)}${r.stateNote}${r.plugins?.length ? ` ⚠️插件${r.plugins.join(",")}` : ""}`,
    )
  }
  console.log(`\n── 不在本仓统计面内的检出（${foreign.length} 棵 · ${Math.round((summary.foreignSizeKB || 0) / 1024)} MB）──`)
  if (!foreign.length) console.log("  （无）")
  for (const x of foreign) {
    console.log(`  ${x.dead ? "☠ 死树" : "外仓 "} ${f(x.path.replace(HOME, "~"), 62)} 主仓=${x.ownerRepo.replace(HOME, "~")}${x.dead ? "（已不存在 ⇒ prune 管不到，只能当目录删）" : ""} ${x.sizeKB ? Math.round(x.sizeKB / 1024) + "M" : ""}`)
  }
  console.log(`\n枚举根（存在 ${summary.roots.length}/${ROOTS.length}）：${summary.roots.map((r) => r.replace(HOME, "~")).join(" · ")}`)
  console.log(`全家扫：${summary.machine} · 空间：${summary.du}`)
  // ISS-552 W-3：租约的家。多个候选就逐个说看到什么——不一致不许沉默（沉默 = 报表替人做了"没事"的决定）。
  const lh = summary.leaseHomes || { rows: [], split: false }
  if (lh.rows.length > 1 || lh.split) {
    console.log(`\n── 租约面（候选家 ${lh.rows.length} 个 · 在途持有者 ${lh.holderCount} 个${lh.split ? " · ⚠️ 两家各说各话" : ""}）──`)
    for (const r of lh.rows) console.log(`  ${String(r.dir).replace(HOME, "~").padEnd(34)} ${r.status}`)
    console.log("  说明：主口径仍是 ~/.dsh（与 ws.sh 现行写入位置一致）；切家要挑没有他人在途的窗口，见 ISS-552 W-3。")
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ summary, rows, foreign, main: mainLog, merges: OPT_DETAIL ? trunkMerges() : [] }, null, 2))
  // 主检出未跟踪目录（ISS-553）：先只报不红一轮，噪声量清楚了再决定转硬
  const mu = summary.mainUntracked
  if (mu.unreadable) console.log(`\n未跟踪目录面：读不到（${mu.note}）⇒ **不判"没有"**，看上面的 git 输出`)
  else if (!mu.rows.length) console.log("\n未跟踪目录面：主检出干净（0 个顶层未跟踪目录）")
  else {
    console.log(`\n── 未跟踪目录面（主检出 ${mu.rows.length} 个顶层目录 · 只报不红）──`)
    for (const d of mu.rows) console.log(`  ${String(d.name).padEnd(24)} ${String(d.mtime || "?").slice(0, 16)}  ${d.ownership}${d.iss ? `（${d.iss}）` : ""}`)
    console.log("  说明：这一格管的是「新包/新目录躺在主检出且没人认领」（违反 §7.7）；归属只按**目录名里的单号 × 当前在途租约**判，认不出就写「无主」，不猜。")
  }
}
