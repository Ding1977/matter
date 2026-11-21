// 安装形状对照（ISS-791：主 checkout 的构建产物不可由 lockfile 复现）
//
// 为什么需要：09-24 实测同一提交、同一份源码，**主 checkout 构建出的 `forge-pm/dist/client.js` 比干净安装大 441KB（+18.1%）**。
// 根因不是代码，是安装现场的形状：`forge-pm/node_modules/lucide-react` 是一份**真目录形态的旧解析副本（1.42.0）**，
// 而 `bun.lock` 解析到 1.37.0 —— 打包器按"包级 node_modules 优先"解析，于是同一份 bundle 里打进两个版本的图标库。
// `bun install` 不清理孤儿目录（它报 "no changes" 也不代表树与 lock 一致），所以这种副本可以静静躺很久，
// **只有版本恰好不同时才会改变产物**，而产物变化没人天天比哈希 ⇒ 需要一个直接盯"形状"的读数。
//
// 判据（都在 `scanShape()` 里，一条一句话）：
//  ① **包级 `node_modules/<dep>` 是真目录而不是软链** ⇒ 形状异常。本仓 `bunfig.toml` 是 `node-linker = "hoisted"`，
//     干净安装后包级条目**全部**是指向根 `node_modules/.bun/<name>@<ver>` 的软链（09-24 重装后实测 347/347，真目录 0）。
//     真目录 = 要么被手工塞过，要么是没走 hoist 链接器的旧现场 ⇒ 它可能带着与 lock 不同的版本。
//  ② 软链**断链**（目标不存在）⇒ 形状异常：解析不出任何东西，这是真坏。
//     「指向仓外」（解析成功但绝对路径不在仓库根之下）**只是信息**，不是异常：对"链接是否有效"这个问题，
//     指向主 checkout 的第三方依赖是有效的。工作树里 `ws.sh deps` 建的镜像链就是这样（第三方依赖软链到主
//     检出、workspace 包指回本树），**天然不可能全部落在本树之内** ⇒ 拿"在不在仓内"当红的理由 = 每个
//     工作树天天假红，判据在工作树里等于没生效（ISS-710）。真该报的是"指向一个不存在的地方"。
//  ③ 同名件在包级与根 store 里**版本不同** ⇒ 直接点名两个版本号（这就是 ISS-791 的那一条）。
//
// ⚠️ 边界与取舍（写下来，别靠人记）：
//  - 本判据**不看产物哈希**：哈希会随任何一次正常的 client 改动而变，天天报就是狼来了。形状是"为什么变"的前因，盯它才不吵。
//  - 默认**只报不红**（`--check` 永远 exit 0，除非读不到）；要判红请显式加 `--strict`。理由同 deps-hygiene：
//    假红的代价本仓写过好几遍，而这条判据第一次跑就会在工作树/别人机器上点出一堆"历史形状"，先让人看得见再说。
//    **例外是 `--compare` 档（守卫的第三档走它，ISS-635）**：新增的「断链 / 真目录 / 既不是目录也不是软链」
//    ——与树无关的真坏 —— 返回 1 进退出码。「指向仓外」新增**不进退出码**（ISS-710）：那是工作树镜像链的
//    正常形态，不是回归；但仍逐条印在报告里，不因不红就看不见。
//    ⚠️ 两档判据故意不同：`--check`（含 `--strict`）问的是「**我应该长什么样**」⇒ 仍要求全部在仓内，
//       「指向仓外」照旧算违例；`--compare` 问的是「**变了什么**」⇒ 不拿"在不在仓内"当红的理由。
//       这个不对称是有意的：改 `--compare` 不等于放宽 `--check`。
//  - 读不到根 `package.json` / 没有 `node_modules`（没装依赖的树、CI 上没跑 install）⇒ **exit 2 显式不判**，
//    绝不把"看不见"当成"形状没问题"。
//
// 用法：node scripts/install-shape.mjs [--selftest | --check | --compare | --write | --strict | --json | --verbose]
// 退出码：0 = 通过或只报；1 = `--strict` 下有违例 / `--compare` 下新增硬违例；2 = 读不到或判不了（显式"判不了"）。
import { readFileSync, readdirSync, existsSync, writeFileSync, lstatSync, realpathSync, mkdtempSync, mkdirSync, symlinkSync, readlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const BASE = path.join(ROOT, "scripts", "baseline", "install-shape.json")
const A = process.argv

/** 列出 `<dir>/node_modules` 下的依赖名（含 `@scope/name` 两层）。 */
function shapeDepNames(nm) {
  const out = []
  for (const d of readdirSync(nm)) {
    if (d === ".bin" || d === ".bun" || d.startsWith(".")) continue
    if (d.startsWith("@")) {
      try {
        for (const s of readdirSync(path.join(nm, d))) if (!s.startsWith(".")) out.push(d + "/" + s)
      } catch {
        continue // 作用域名目录读不动（权限/竞态）：跳过这一支，不把它算成"没有依赖"
      }
      continue
    }
    out.push(d)
  }
  return out
}

/** 读某条依赖的 version（软链会跟到真实目录；读不到返回 null，不蒙成 "0"）。 */
function shapeDepVersion(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version || null
  } catch {
    return null
  }
}

/** 根 store（`node_modules/.bun/<name>@<ver>+<hash>`）里每个件名对应的版本集合。 */
function shapeStoreVersions(root) {
  const store = new Map()
  const sb = path.join(root, "node_modules", ".bun")
  if (!existsSync(sb)) return store
  for (const d of readdirSync(sb)) {
    const m = d.match(/^(.+)@([^@+]+)(\+.*)?$/)
    if (!m) continue
    const name = m[1].replace(/\+/g, "/")
    if (!store.has(name)) store.set(name, new Set())
    store.get(name).add(m[2])
  }
  return store
}

/**
 * 扫一棵树，返回形状读数与违例清单。
 * 只依赖 `root`（selftest 就是拿临时目录喂它，不碰真仓库）。
 */
function scanShape(root) {
  const findings = []
  const counts = { pkgs: 0, entries: 0, links: 0, realDirs: 0, broken: 0, outside: 0, versionDrift: 0 }
  const perPkg = {}
  let pj
  try {
    pj = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  } catch {
    return { unreadable: "根 package.json 读不到", counts, findings, perPkg }
  }
  if (!existsSync(path.join(root, "node_modules"))) return { unreadable: "根 node_modules 不存在（没装依赖的树）", counts, findings, perPkg }
  const store = shapeStoreVersions(root)
  const realRoot = (() => {
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  })()
  for (const w of pj.workspaces || []) {
    if (String(w).startsWith("!")) continue
    const nm = path.join(root, w, "node_modules")
    if (!existsSync(nm)) continue
    counts.pkgs++
    perPkg[w] = 0
    for (const dep of shapeDepNames(nm)) {
      const p = path.join(nm, dep)
      counts.entries++
      perPkg[w]++
      let st
      try {
        st = lstatSync(p)
      } catch {
        findings.push({ pkg: w, dep, kind: "读不到" })
        continue
      }
      if (st.isSymbolicLink()) {
        counts.links++
        let target
        try {
          target = realpathSync(p)
        } catch {
          counts.broken++
          let raw = null
          try {
            raw = readlinkSync(p)
          } catch {
            raw = "(readlink 也读不到)" // 断链且连目标都取不到：仍要点名，不许静默
          }
          findings.push({ pkg: w, dep, kind: "断链（指向不存在的路径）", target: raw })
          continue
        }
        if (!target.startsWith(realRoot + path.sep)) {
          counts.outside++
          findings.push({ pkg: w, dep, kind: "指向仓外", target })
        }
      } else if (st.isDirectory()) {
        counts.realDirs++
        const v = shapeDepVersion(p)
        const sv = store.get(dep)
        if (sv && v && ![...sv].includes(v)) {
          counts.versionDrift++
          findings.push({ pkg: w, dep, kind: `真目录旧副本（包级 ${v} vs 根 store ${[...sv].join("/")}）`, version: v })
        } else {
          findings.push({ pkg: w, dep, kind: `真目录（包级 ${v || "版本读不到"}，不是 hoist 软链）`, version: v })
        }
      } else {
        findings.push({ pkg: w, dep, kind: "既不是目录也不是软链" })
      }
    }
  }
  return { counts, findings, perPkg, unreadable: null }
}

/** 基线读写：形状读数 + 违例清单（清单便于"上次是谁、这次还在不在"的对账）。 */
function shapeReport(r, baseline, compareMode = false) {
  const lines = []
  const n = r.findings.length
  lines.push(
    `安装形状（ISS-791）· 包 ${r.counts.pkgs} · 包级条目 ${r.counts.entries}（软链 ${r.counts.links} / 真目录 ${r.counts.realDirs}）· ` +
      `断链 ${r.counts.broken} · 指向仓外 ${r.counts.outside} · 版本漂 ${r.counts.versionDrift} · 违例 ${n} 条`,
  )
  if (baseline) {
    // 紧跟在读数行后：守卫绿档只印 head -1 + 第 2~9 行，不写在这里就会被读成「违例 343 条 ⇒ 却判绿」的自相矛盾。
    if (compareMode && r.counts.outside) lines.push(`  「指向仓外」${r.counts.outside} 条不计入退出码：工作树镜像链指向主检出属正常（ws.sh deps 的设计就是复用第三方依赖），判据只看链接目标是否存在`)
    const before = new Set((baseline.findings || []).map((f) => `${f.pkg}::${f.dep}`))
    const now = new Set(r.findings.map((f) => `${f.pkg}::${f.dep}`))
    const added = [...now].filter((x) => !before.has(x))
    const gone = [...before].filter((x) => !now.has(x))
    lines.push(`  与基线（${baseline.recordedAt}）比：新增 ${added.length} · 消失 ${gone.length}`)
    added.slice(0, 6).forEach((x) => lines.push(`    + ${x.replace("::", " → ")}`))
    gone.slice(0, 6).forEach((x) => lines.push(`    - ${x.replace("::", " → ")}`))
    if (added.length > 6 || gone.length > 6) lines.push("    （只列前 6 条，全量看 --verbose）")
  }
  return lines
}

/**
 * 违例分桶（`--compare` 的退出码只认「硬」这一桶）。
 * 提成模块级是为了让 selftest 能直接断言分桶口径，而不是只靠"跑一遍看退出码"。
 * 「指向仓外」不在硬桶里（ISS-710）：目标存在就说明链接是有效的，字节来自哪棵树不是"回归"。
 */
const 硬违例 = (f) => /^(断链|真目录|既不是目录)/.test(String(f.kind || ""))
const 仓外违例 = (f) => /^指向仓外/.test(String(f.kind || ""))

/**
 * 自检：夹具全在临时目录里现造，不碰真仓库。
 * 每档都要么"正向抓得到"、要么"反向不误判"—— 反向控制一律写成**恰好**，不留 `||` 逃生门（ISS-777 后半的教训）。
 */
function runShapeSelftest() {
  const cases = []
  const push = (n, ok) => cases.push({ n, ok })
  const root = mkdtempSync(path.join(tmpdir(), "install-shape-"))
  const mk = (rel) => {
    const d = path.join(root, rel)
    mkdirSync(d, { recursive: true })
    return d
  }
  // 夹具布局：一个"干净形状"包（软链到根 store）+ 一个"真目录旧副本"包 + 一条断链
  const storeDir = "node_modules/.bun/left-pad@1.37.0+abc/node_modules/left-pad"
  mk(storeDir)
  writeFileSync(path.join(root, storeDir, "package.json"), '{"name":"left-pad","version":"1.37.0"}')
  const good = mk("pkgs/a/node_modules")
  const bad = mk("pkgs/b/node_modules")
  const broken = mk("pkgs/c/node_modules")
  // 相对软链：从 pkgs/<x>/node_modules/<dep> 往上三层到仓根的 store
  const hoist = "../../../node_modules/.bun/left-pad@1.37.0+abc/node_modules/left-pad"
  symlinkSync(hoist, path.join(good, "left-pad"))
  mkdirSync(path.join(bad, "left-pad"))
  writeFileSync(path.join(bad, "left-pad/package.json"), '{"name":"left-pad","version":"1.42.0"}')
  symlinkSync("../does-not-exist", path.join(broken, "gone-pkg"))
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["pkgs/a", "pkgs/b", "pkgs/c"] }))

  const r = scanShape(root)
  push("控制①：真目录旧副本（包级 1.42.0 vs store 1.37.0）⇒ 点名版本漂（正向）", r.counts.versionDrift === 1 && r.findings.some((f) => f.pkg === "pkgs/b" && f.dep === "left-pad" && /1\.42\.0.*1\.37\.0/.test(f.kind)))
  push("控制②：hoist 软链指向仓内 ⇒ 不算违例（反向，防恒红）", !r.findings.some((f) => f.pkg === "pkgs/a"))
  push("控制③：断链 ⇒ 点名（正向）", r.counts.broken === 1 && r.findings.some((f) => f.dep === "gone-pkg" && /断链/.test(f.kind)))
  push("控制④：计数自洽（entries = links + realDirs + 其它，且条目数 = 各包之和）", r.counts.entries === 3 && r.counts.links === 2 && r.counts.realDirs === 1 && Object.values(r.perPkg).reduce((a, b) => a + b, 0) === 3)
  // 反向对照：把真目录与断链都换成 hoist 软链 ⇒ 违例必须归 0（否则这条判据是恒红的）
  rmSync(path.join(bad, "left-pad"), { recursive: true, force: true })
  symlinkSync(hoist, path.join(bad, "left-pad"))
  rmSync(path.join(broken, "gone-pkg"), { force: true })
  symlinkSync(hoist, path.join(broken, "gone-pkg"))
  const clean = scanShape(root)
  push("控制⑤：全部改成 hoist 软链 ⇒ 违例恰好 0 条（反向，防恒红）", clean.findings.length === 0 && clean.counts.realDirs === 0 && clean.counts.broken === 0)
  push("控制⑥：同一棵树连跑两次读数相同（判据自身确定性）", JSON.stringify(scanShape(root).counts) === JSON.stringify(clean.counts))
  // 读不到 ⇒ 显式不判，不冒充"形状没问题"
  const empty = scanShape(path.join(root, "no-such-tree"))
  push("控制⑦：根 package.json 读不到 ⇒ 显式不判（不是「零违例」）", !!empty.unreadable && empty.findings.length === 0)
  const noNm = mk("bare")
  writeFileSync(path.join(root, "bare/package.json"), JSON.stringify({ workspaces: [] }))
  const r2 = scanShape(path.join(root, "bare"))
  push("控制⑧：根 node_modules 不存在（没装依赖）⇒ 显式不判", !!r2.unreadable && /node_modules/.test(r2.unreadable))
  // 报告行：基线在/不在两种输入下都要能印，且"新增/消失"要数得对
  const rep = shapeReport(r, { recordedAt: "test", findings: [{ pkg: "pkgs/b", dep: "left-pad" }, { pkg: "pkgs/z", dep: "ghost" }] })
  push("控制⑨：对照行能算出「新增 1 / 消失 1」（基线里那条 pkgs/z 已消失，现扫的 pkgs/b 是新出现）", /新增 1 · 消失 1/.test(rep[1]))
  push("控制⑩：无基线时仍印读数行、不编造差值", shapeReport(clean, null).length === 1 && /违例 0 条/.test(shapeReport(clean, null)[0]))
  // ISS-710：`--compare` 红面的分桶口径（判据从"在不在仓内"换成"目标是否存在"）。
  // 这几条是**口径本身的**反向控制：仓外不进红桶，断链/真目录必须还在红桶里 —— 防"顺手放宽"。
  push("控制⑪：断链 ⇒ 落进红桶（正向：判据只看目标是否存在，这条不能松）", 硬违例({ kind: "断链（指向不存在的路径）" }) === true)
  push("控制⑫：真目录 / 既不是目录也不是软链 ⇒ 落进红桶（正向，与树无关的真坏）", 硬违例({ kind: "真目录（包级 1.0.0，不是 hoist 软链）" }) === true && 硬违例({ kind: "既不是目录也不是软链" }) === true)
  push("控制⑬：指向仓外 ⇒ **不进**红桶（反向：工作树镜像链的正常形态，判红就是每个工作树天天红）", 硬违例({ kind: "指向仓外" }) === false && 仓外违例({ kind: "指向仓外" }) === true)
  push("控制⑭：读不到 ⇒ 两桶都不是（仍走判不了，不许被算成绿或红）", !硬违例({ kind: "读不到" }) && !仓外违例({ kind: "读不到" }))
  // 场记：仓外违例必须仍能被扫出来（不红≠不可见）。造一条指向仓外、但目标**存在**的软链。
  // 目标必须真的建在 root **之外**（建在 root 里就成了"仓内"，测不到这条）。
  const otherRepo = mkdtempSync(path.join(tmpdir(), "install-shape-other-"))
  mkdirSync(path.join(otherRepo, "node_modules/left-pad"), { recursive: true })
  writeFileSync(path.join(otherRepo, "node_modules/left-pad/package.json"), '{"name":"left-pad","version":"1.37.0"}')
  const outSide = mk("pkgs/d/node_modules")
  symlinkSync(path.join(otherRepo, "node_modules/left-pad"), path.join(outSide, "left-pad"))
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["pkgs/a", "pkgs/b", "pkgs/c", "pkgs/d"] }))
  const withOut = scanShape(root)
  push("控制⑮：指向仓外且目标存在 ⇒ 被扫出来并计入 outside、且不进红桶（不红≠不可见）", withOut.counts.outside === 1 && withOut.counts.broken === 0 && withOut.findings.filter(硬违例).length === 0 && withOut.findings.some((f) => f.dep === "left-pad" && 仓外违例(f)))
  const badCases = cases.filter((x) => !x.ok)
  console.log(badCases.length ? "✗ 自检失败：" + badCases.map((x) => x.n).join(" / ") : `✓ ${cases.length}/${cases.length} 项控制通过：真目录/断链抓得到、hoist 软链不误判、读不到不冒充通过`)
  process.exit(badCases.length ? 1 : 0)
}

if (A.includes("--selftest")) runShapeSelftest()

const scanned = scanShape(ROOT)
if (scanned.unreadable) {
  console.log(`安装形状 · **不判**：${scanned.unreadable}（"看不见"不等于"形状没问题"）`)
  process.exit(2)
}
const hasBase = existsSync(BASE)
const baseline = hasBase ? JSON.parse(readFileSync(BASE, "utf8")) : null

if (A.includes("--json")) {
  console.log(JSON.stringify({ ...scanned, baseline: baseline ? { recordedAt: baseline.recordedAt, findings: (baseline.findings || []).length } : null }))
  process.exit(A.includes("--strict") && scanned.findings.length ? 1 : 0)
}
if (A.includes("--write")) {
  writeFileSync(BASE, JSON.stringify({ recordedAt: new Date().toISOString().slice(0, 19) + "Z", counts: scanned.counts, perPkg: scanned.perPkg, findings: scanned.findings, note: "上限=形状基线：干净安装（bun install --frozen-lockfile）后录。真目录/断链/指向仓外/版本漂 都是 ISS-791 那一族的形状。只报不红；要升红由老板定（--strict）。" }, null, 1) + "\n")
  console.log(`✓ 形状基线已存 ${path.relative(ROOT, BASE)}（条目 ${scanned.counts.entries} · 违例 ${scanned.findings.length}）`)
  process.exit(0)
}
const lines = shapeReport(scanned, A.includes("--compare") ? baseline : null, A.includes("--compare"))
console.log(lines.join("\n"))
if (A.includes("--compare")) {
  // ISS-635 三态：0 绿 / 1 红 / 2 判不了。红面只取**与树无关的真坏**（新增断链 / 真目录 / 既不是目录也不是软链）。
  // ISS-710：本档问的是「**变了什么**」，所以「指向仓外」新增**不进退出码** —— 工作树镜像链指向主检出是
  // `ws.sh deps` 的设计（第三方依赖复用），拿"在不在仓内"当红 = 每个工作树天天假红，这一档在工作树里从没生效过。
  //   判据替换：`目标是否在 REPO 之下` → `目标是否存在`。目标不存在 = 断链 = 红（上一行的硬新增，逻辑不变）；
  //   目标存在但不在仓内 = 信息，逐条印出来，不因不红就看不见。
  // ⚠️ 只改这一档：`--check` / `--strict` 仍要求全部在仓内（"我应该长什么样"），`ws.sh deps` 之外的
  //    「读不到」一类也仍走 2（判不了），不因本单被顺手放宽。
  if (!hasBase) { console.log("  ! 无形状基线 ⇒ 判不了（录基线：node scripts/install-shape.mjs --write，须在装齐且与 lock 一致的树上）"); process.exit(2) }
  const before = new Set((baseline.findings || []).map((f) => `${f.pkg}::${f.dep}`))
  const added = scanned.findings.filter((f) => !before.has(`${f.pkg}::${f.dep}`))
  const 硬新增 = added.filter(硬违例)
  const 仓外新增 = added.filter(仓外违例)
  const 其它新增 = added.filter((f) => !硬违例(f) && !仓外违例(f)) // 只可能是「读不到」一类：仍判不了，不顺手放宽
  if (硬新增.length) {
    console.log(`  ✗ 新增形状违例 ${硬新增.length} 条（断链 / 真目录 / 既不是目录也不是软链）—— 修法：挪开包级 node_modules 后 \`bun install --frozen-lockfile\`（ISS-791）`)
    for (const f of 硬新增.slice(0, 6)) console.log(`      + ${f.pkg} → ${f.dep}（${f.kind}）`)
    process.exit(1)
  }
  if (其它新增.length) {
    console.log(`  判不了 —— 新增 ${其它新增.length} 条读不出来的条目：看不见不等于形状没问题`)
    for (const f of 其它新增.slice(0, 6)) console.log(`      ? ${f.pkg} → ${f.dep}（${f.kind}）`)
    process.exit(2)
  }
  if (仓外新增.length) {
    // 不红、但必须可见：这 343 条正是"这份产物的字节来自哪棵树"的可见化。
    console.log(`  新增 ${仓外新增.length} 条「指向仓外」· 不计入退出码（工作树镜像链指向主检出属正常：ws.sh deps 的设计就是复用第三方依赖；判据只看链接目标是否存在）`)
    for (const f of 仓外新增.slice(0, 6)) console.log(`      ~ ${f.pkg} → ${f.dep}（→ ${f.target || "?"}）`)
    if (仓外新增.length > 6) console.log(`      （只列前 6 条，全量看 --verbose）`)
  }
  process.exit(0)
}
if (!hasBase) console.log("  ! 无形状基线 ⇒ 只印读数不判（录基线：node scripts/install-shape.mjs --write，须在装齐且与 lock 一致的树上）")
if (A.includes("--verbose")) for (const f of scanned.findings) console.log(`      ${f.pkg} → ${f.dep}（${f.kind}${f.target ? " " + f.target : ""}）`)
if (A.includes("--strict") && scanned.findings.length) {
  console.log(`  ✗ --strict：形状违例 ${scanned.findings.length} 条 —— 修法：挪开包级 node_modules 后 \`bun install --frozen-lockfile\`（ISS-791）`)
  process.exit(1)
}
process.exit(0)
