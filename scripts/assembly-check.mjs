#!/usr/bin/env node
// scripts/assembly-check.mjs
// 装配一致性体检 —— 该上电的没上、上电的没人声明，当场可见（PRJ-016 / ISS-707）
// 用法：node scripts/assembly-check.mjs [--check|--selftest|--json]
//
// 装配真相源有三处（与 code-inventory 的 B4~B10 同口径，实测于 2026-09-22）：
//   ① `dsh.profile.bundles` 里每个包自带的 patch（deferred：路径可由该包 package.json 的 `dsh.bundle.patch` 改名）
//      + profile 自己的 cordis.patch.yml 覆盖层 + home 级 cordis.patch.yml —— **声明 = 这些 patch 里 insert 出来的行 id**
//   ② 包自带 patch（package.json 的 dsh.bundle.patch，被引擎自动合并）
//   ③ <home>/.dsh/profiles/node_modules 的软链（决定 ② 能否生效，也是"装了"的证据）
//
// ⚠️ ISS-651（2026-10-24）：① 那一层以前本脚本**自己实现**（只读 profile 的 cordis.patch.yml，正则
//   `^\s*-?\s*id:`），profile 改成 bundles 之后两条都错：
//     · 只认 patch 不认 bundles ⇒ 14 件真在挂的件（forge-pm / forge-ui / forge-model / forge-canvas …）
//       被报「隐式装配（profile 未声明）」，而它们在 `dsh.profile.bundles` 里明明白白；
//     · `-?` 前缀让**顶层 config 覆盖行**（`- id: X` + `config:`）冒充声明 ⇒ 声明集成了巧合子集。
//   现在声明集只从 `assembly-mounts-lib.mjs` 的 `readMounts()` 取（与 ui-load-contract /
//   assembly-diff-check 同一份解析器；抄第二份就是漂移的成因）。
//
// 三档判定：
//   红 声明了但**加载不到**（两处锚点都没有）/ 声明了但盘上没这个包
//   提 声明了、共享镜像没有、但**声明它的那个 profile 私有目录里解析得到** ⇒ 引擎加载得到，
//      它问的只是"换机器/重装会不会掉"（安装态不完整）。**老板 09-23 批「降为提醒」**（ISS-728）：
//      两件事混在一个红里会让 guard 天天挂着一条**正在跑的**项，红灯一常态化真问题也被无视。
//      ⚠️ 2026-09-23 之前这条一律写"加载即失败"，把 ISS-728 的定性带偏过（详见该单）。
//   红 软链指向非主 checkout 或断链            → 生产引擎在跑别人的分支（AGENTS §4.7 事故类）
//   报 软链 + 自带 patch 但 profile 未声明     → 隐式装配（换机器/重装即掉），列清单不判红
//
// 豁免口：FORGE_ALLOW_WORKTREE_LINK=<ISS-NNN>[,<ISS-NNN>] —— 在途验证窗口用；
// 命中项降级为提醒并点名放行的是谁（白名单必须带理由、必须可见，同 code-rules §7）。
import fs from 'node:fs'
import { readSharedMirror, readProfilePrivate, profilesOf } from './assembly-anchors-lib.mjs'
// 声明集口径的唯一读者（ISS-651）：bundles 各包自带 patch + profile 覆盖层 + home 级 patch
import { readMounts } from './assembly-mounts-lib.mjs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO_DEFAULT = path.resolve(import.meta.dirname, '..')
// profile 的发现口径（含 `*.bak-*` / `*-probe` 的排除规则）在 `assembly-anchors-lib.mjs` 的 `profilesOf`
// —— 与 `code-inventory.mjs` 共用同一份，避免"哪个 profile 算数"在两个脚本里各判一套（ISS-557）。

/**
 * 主 checkout = git common dir 的父目录。**不能拿"脚本自己所在的树"当主 checkout**：
 * 在链接工作树里跑 `ws.sh guard`（或本脚本）时，那是工作树 ⇒ 生产引擎的**每一条** forge-* 软链
 * 都会被判成「指向非主 checkout」，于是守卫在合法场景里恒红（2026-09-22 ISS-727 收口时实测撞上：
 * 18 条软链全红，而它们全都正确指向 <repo>）。恒红的守卫和恒绿的一样没用。
 * 拿不到 git 输出时退回旧行为（fallback），并让调用方看得见退回没发生 —— 见 --selftest 的第 12 项。
 */
export function mainRepoRoot(fallback = REPO_DEFAULT) {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: fallback, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const common = path.resolve(out)
    // 主树：…/dsh-forge/.git（目录）；链接工作树：…/wt/ISS-x/.git（文件）→ 两种都取父目录即主树
    return path.dirname(common)
  } catch {
    return fallback
  }
}

const repoUnderTest = () => process.env.FORGE_REPO_UNDER_TEST || mainRepoRoot(REPO_DEFAULT)

/**
 * 按 profile 分组的声明集（ISS-757 收尾 · 2026-09-23）。
 *  为什么必须分组：引擎解析一个包时用的是**那一个 profile** 的私有目录 + 共享镜像，而声明写在具体某个
 *  profile 里 —— 把同一 home 的所有 profile 声明并成一个集合去判"能不能加载"，就会把
 *  「web-b 声明、web-b 私有目录里可解析」判成"加载即失败"（ISS-728 实测：forge-notify-bridge 在两个
 *  home 的 `profiles/web-b/node_modules` 里都是指向主 checkout 的软链，`package.json` 在 ⇒ 引擎加载得到）。
 *  @returns {{byProfile: Map<string, Set<string>>, bundled: Set<string>, unread: {profile: string, reason: string}[]}}
 *    byProfile = 该 profile **声明挂载**的行 id（insert 出来的）
 *    bundled   = 该 profile `dsh.profile.bundles` 里的**包名**。bundle 式加载 = 引擎合并该包自带的 patch，
 *                profile 的 cordis.patch.yml 里**不该**再写一条 insert（写了是重复挂载）⇒ 判「隐式装配」时
 *                必须把这一档算成**已声明**，否则会给自己加 insert 的包泼脏水（2026-10-24 实测：
 *                forge-messenger / forge-widgets / forge-archive 三个 bundle 被误报成「profile 未声明」）。
 *    unread    = 读不到 profile 本身（无 package.json 等）⇒ 调用方必须**出声**，不许当成「没声明」（ISS-651）。
 */
function declaredByProfile(home) {
  const byProfile = new Map()
  const bundled = new Set()
  const unread = []
  for (const p of profilesOf(home)) {
    const m = readMounts(path.join(home, 'profiles', p))
    if (!m.ok) { unread.push({ profile: p, reason: m.reason }); continue }
    for (const b of m.bundles) bundled.add(String(b))
    if (m.own.size) byProfile.set(p, m.own)
  }
  return { byProfile, bundled, unread }
}

/** 薄投影：口径（三层语义、五类分法）在 `assembly-anchors-lib.mjs`，本脚本只负责把
 *  "主 checkout"基准传对 —— 在链接工作树里跑守卫时 repoRoot 就是那棵树（ISS-727 的恒红教训）。 */
const readLinks = (home) => readSharedMirror(home, repoUnderTest())

/** profile 私有层（第二锚点）的读法已收进 `assembly-anchors-lib.mjs`（口径唯一，K6b 的账）。
 *  分五类 main / main-tree-other / elsewhere / copy / broken —— 判定与文案都在本脚本里用。 */
const privateOf = (home) => readProfilePrivate(home, repoUnderTest())

function selfPatchOf(repoRoot) {
  const set = new Set()
  if (!fs.existsSync(repoRoot)) return set
  for (const p of fs.readdirSync(repoRoot)) {
    if (!/^forge-/.test(p)) continue
    const f = path.join(repoRoot, p, 'package.json')
    if (!fs.existsSync(f)) continue
    let j = null
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    const rel = j && j.dsh && j.dsh.bundle && j.dsh.bundle.patch
    if (rel && fs.existsSync(path.join(repoRoot, p, String(rel).replace(/^\.\//, '')))) set.add(p)
  }
  return set
}

/** 单个 home 的判定（home = 引擎根，如 ~/.dsh 与 ~/.dsh-matter —— 两者的 profiles/node_modules 各自独立） */
function checkHome(home, repoRoot, allowWorktreeLink) {
  const { byProfile, bundled, unread } = declaredByProfile(home)
  const declared = new Set([...byProfile.values()].flatMap((s) => [...s]))
  const links = readLinks(home)
  const selfPatch = selfPatchOf(repoRoot)
  const disk = new Set(fs.existsSync(repoRoot) ? fs.readdirSync(repoRoot).filter((p) => /^forge-/.test(p) && fs.existsSync(path.join(repoRoot, p, 'package.json'))) : [])
  const r = { home, declared: [...declared], links: links.size, missingInstall: [], notOnDisk: [], hijacked: [], implicit: [], allowed: [], privateDrift: [], missingAlsoPrivate: [], unread }
  for (const id of declared) {
    if (!disk.has(id)) r.notOnDisk.push(id)
    else if (!links.has(id)) r.missingInstall.push(id)
  }
  for (const [name, info] of links) {
    if (info.kind === 'broken') r.hijacked.push({ pkg: name, why: '断链（指向不存在的路径）', target: info.target })
    else if (info.kind === 'elsewhere') {
      const iss = (info.real.match(/(ISS-\d+)/) || [])[1] || info.real
      if (allowWorktreeLink.includes(iss)) r.allowed.push({ pkg: name, iss, real: info.real })
      else r.hijacked.push({ pkg: name, why: '指向非主 checkout（生产引擎在跑别人的分支）', target: info.real })
    // 「隐式装配」= 软链 + 自带 patch，**但没人声明**。判定顺序按 ISS-651 的更正：
    //   ① 先看包是否在该 home 任一 profile 的 `dsh.profile.bundles` 里 —— 在 ⇒ **已声明**（bundle 式加载，
    //      自带 patch 由引擎合并；profile 的 patch 里本来就不该再写 insert，写了反而重复挂载）；
    //   ② 不在 bundles、却有软链 + 自带 patch ⇒ 才是真「隐式装配」（换机器/重装即掉），保留这条真信息。
    } else if (!declared.has(name) && !bundled.has(name) && selfPatch.has(name)) r.implicit.push(name)
  }
  // ⚠️ red 不在这里定：它要看**能不能加载**（见下面 missingLoad 那段）。
  // 第二锚点这一层只**报**不判红：它不改现有判定，但让"生产引擎在跑别的工作树 / 跑快照拷贝"
  // 从看不见变成天天看得见。要升红由老板定。
  const priv = privateOf(home)
  r.privateDrift = priv.filter((d) => d.kind !== 'main')
  // 但"声明了没软链 = 加载即失败"这条红的**强度**取决于第二锚点：能在私有 node_modules 里解析到的，
  // 红仍保留（不偷改判定），只是把这句话附在旁边 —— ISS-728 的定性正需要这条信息。
  r.missingAlsoPrivate = r.missingInstall
    .map((id) => {
      const hit = priv.find((d) => d.pkg === id)
      return hit ? { pkg: id, via: `${hit.profile}/node_modules/${hit.pkg}`, kind: hit.kind, real: hit.real } : null
    })
    .filter(Boolean)
  // ISS-757 收尾：逐 profile 说清"到底加载不加载得到"。红**不降级**（判定一字未动，降不降由老板定），
  // 但文案不许再说"加载即失败"——那句对"声明它的那个 profile 里私有目录有链"的包是**假的**。
  r.missingDetail = r.missingInstall.map((id) => {
    const declaresIn = [...byProfile.entries()].filter(([, s]) => s.has(id)).map(([p]) => p)
    const via = declaresIn.map((p) => {
      const hit = priv.find((d) => d.pkg === id && d.profile === p)
      return { profile: p, kind: hit ? hit.kind : 'absent', real: hit ? hit.real : '' }
    })
    // 能加载 = 声明它的那个 profile 里解析得到（main / copy / elsewhere 都是"解析得到"，只是去处分歧）
    const loadable = via.some((v) => v.kind !== 'absent' && v.kind !== 'broken')
    return { pkg: id, declaresIn, via, loadableInDeclaringProfile: loadable }
  })
  r.missingLoad = r.missingInstall.filter((id) => !(r.missingDetail.find((d) => d.pkg === id) || {}).loadableInDeclaringProfile)
  r.mirrorOnly = r.missingInstall.filter((id) => !r.missingLoad.includes(id))
  // 老板 09-23 批「降为提醒」（ISS-728）：**能加载的不再判红**。红只留给三件真事 ——
  // ① 真加载即失败（声明它的那个 profile 的私有层也解析不到）② 断链 / 指向别的工作树 ③ 盘上没有这个包。
  // 依据：共享镜像那一层答的是"**换机器 / 重装会不会掉**"，不是"**现在能不能跑**"。两件事混在一个红里，
  // 会让 guard 天天挂着一条**正在跑的**项 —— 红灯一旦常态化，真问题也会被一起无视（本仓为"恒红"付过学费）。
  // ⇒ mirrorOnly（声明了、共享镜像没有、但声明它的 profile 私有目录里解析得到）降为**提醒**，仍天天看得见。
  r.red = r.missingLoad.length + r.hijacked.length + r.notOnDisk.length
  r.warn = r.implicit.length + r.privateDrift.length + r.mirrorOnly.length
  return r
}

/** 可注入 homes / repoRoot 的纯体检 —— selftest 因此在临时目录里跑红绿两条路径，绝不碰真实 ~/.dsh */
export function checkAssembly({ homes = [process.env.HOME || ''], repoRoot = REPO_DEFAULT, allowWorktreeLink = [] } = {}) {
  const parts = homes.filter((h) => h && fs.existsSync(path.join(h, 'profiles'))).map((h) => checkHome(h, repoRoot, allowWorktreeLink))
  const sum = { declared: [], links: 0, missingInstall: [], missingDetail: [], missingLoad: [], mirrorOnly: [], notOnDisk: [], hijacked: [], implicit: [], allowed: [], privateDrift: [], missingAlsoPrivate: [], unread: [], parts }
  for (const p of parts) {
    sum.declared.push(...p.declared.map((d) => `${d}@${homeTag(p.home)}`))
    sum.links += p.links
    sum.missingInstall.push(...p.missingInstall.map((x) => `${x}（${homeTag(p.home)}）`))
    sum.missingDetail.push(...p.missingDetail.map((x) => ({ ...x, pkg: `${x.pkg}（${homeTag(p.home)}）` })))
    sum.missingLoad.push(...p.missingLoad.map((x) => `${x}（${homeTag(p.home)}）`))
    sum.mirrorOnly.push(...p.mirrorOnly.map((x) => `${x}（${homeTag(p.home)}）`))
    sum.notOnDisk.push(...p.notOnDisk.map((x) => `${x}（${homeTag(p.home)}）`))
    sum.hijacked.push(...p.hijacked.map((x) => ({ ...x, pkg: `${x.pkg}（${homeTag(p.home)}）` })))
    sum.implicit.push(...p.implicit.map((x) => `${x}（${homeTag(p.home)}）`))
    sum.allowed.push(...p.allowed.map((x) => ({ ...x, pkg: `${x.pkg}（${homeTag(p.home)}）` })))
    sum.privateDrift.push(...p.privateDrift.map((x) => ({ ...x, pkg: `${x.pkg}（${homeTag(p.home)}/${x.profile}）` })))
    sum.missingAlsoPrivate.push(...p.missingAlsoPrivate.map((x) => ({ ...x, pkg: `${x.pkg}（${homeTag(p.home)}）` })))
    sum.unread.push(...p.unread.map((x) => ({ ...x, home: homeTag(p.home) })))
  }
  sum.red = parts.reduce((a, b) => a + b.red, 0)
  sum.warn = parts.reduce((a, b) => a + b.warn, 0)
  return sum
}

/** 现役 home（2026-10-01 起 · ISS-557）：`~/.dsh`（官方 App 19387）与 `~/.dsh-matter`（3210 独立服务）。
 *  两者的 `profiles/node_modules` 各自独立，必须分开判。已退役的 `~/.dsh-b` 不再列入
 *  —— 它的 profiles 已随 home 一起删除，留着只会让门禁去扫一个不存在的面。 */
function homesOfEnv() {
  const h = process.env.HOME || ''
  return [path.join(h, '.dsh'), path.join(h, '.dsh-matter')]   // 引擎根就是这两个目录本身（不是 $HOME）
}
const homeTag = (h) => (String(h).endsWith('.dsh-matter') ? 'matter服务' : 'App')


function selftest() {
  // ⚠️ 必须 realpath：macOS 的 os.tmpdir() 在 /var（= /private/var 的软链）下，
  //    不解析会让"指向主 checkout"的软链被判成"指向别处"，隐式装配那档永远验不到（实测踩过）。
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-selftest-')))
  const home = path.join(root, 'home')
  const repo = path.join(root, 'repo')
  const other = path.join(root, 'wt', 'ISS-999')
  const nm = path.join(home, 'profiles', 'node_modules')
  const mkdir = (x) => fs.mkdirSync(x, { recursive: true })
  const cases = []
  const push = (n, c, note = '') => cases.push({ n, c: !!c, note })
  process.env.FORGE_REPO_UNDER_TEST = repo
  try {
    mkdir(nm); mkdir(other)
    for (const p of ['alpha', 'beta', 'gamma', 'delta']) {
      mkdir(path.join(repo, 'forge-' + p))            // 包目录必须叫 forge-*（第一版建成 repo/alpha ⇒ disk 为空 ⇒ 判红项跑错分支）
      mkdir(path.join(other, 'forge-' + p))           // 工作树目标得真存在，否则 realpath 失败会被判成"断链"而不是"指向别处"
      fs.writeFileSync(path.join(other, 'forge-' + p, 'package.json'), JSON.stringify({ name: 'forge-' + p }))
      const pj = { name: `forge-${p}` }
      if (p === 'beta' || p === 'delta') pj.dsh = { bundle: { patch: './cordis.patch.yml' } }
      fs.writeFileSync(path.join(repo, 'forge-' + p, 'package.json'), JSON.stringify(pj, null, 1))
      if (pj.dsh) fs.writeFileSync(path.join(repo, 'forge-' + p, 'cordis.patch.yml'), `- insert:\n    - id: forge-${p}\n`)
    }
    const patchDir = path.join(home, 'profiles', 'web')
    mkdir(patchDir)
    // ISS-651：profile 目录现在必须有 package.json —— 声明集从 `readMounts()` 取，它靠这个文件
    // 认「这是一个 profile」（缺了就是 ok=false ⇒ 出声「读不到」，不再是把 patch 当唯一真相）
    fs.writeFileSync(path.join(patchDir, 'package.json'), JSON.stringify({ name: 'fx-web', dsh: { profile: { bundles: [] } } }, null, 1))
    // alpha 声明+主链（绿）· beta 声明无链（红）· gamma 链到别的工作树（红）· delta 隐式装配（报）· nowhere 断链（红）
    fs.writeFileSync(path.join(patchDir, 'cordis.patch.yml'), '# 注释里的 forge-delta 不该被算成声明\n- insert:\n    - id: forge-alpha\n- insert:\n    - id: forge-beta\n')
    fs.symlinkSync(path.join(repo, 'forge-alpha'), path.join(nm, 'forge-alpha'))
    fs.symlinkSync(path.join(other, 'forge-gamma'), path.join(nm, 'forge-gamma'))
    fs.symlinkSync(path.join(repo, 'forge-delta'), path.join(nm, 'forge-delta'))
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(nm, 'forge-nowhere'))
    // ↓ profile 私有条目（ISS-757 的那一层：引擎先按 profile 目录解析，共享镜像看不见这里）
    const privNm = path.join(patchDir, 'node_modules')
    mkdir(privNm)
    mkdir(path.join(other, 'forge-eps'))
    fs.writeFileSync(path.join(other, 'forge-eps', 'package.json'), JSON.stringify({ name: 'forge-eps' }))
    fs.symlinkSync(path.join(other, 'forge-eps'), path.join(privNm, 'forge-eps'))   // 指向别的工作树 ⇒ 偏移
    fs.symlinkSync(path.join(repo, 'forge-alpha'), path.join(privNm, 'forge-alpha')) // 指向主 checkout ⇒ 正常
    mkdir(path.join(privNm, 'forge-zeta'))                                            // 实体目录 = 快照拷贝
    fs.writeFileSync(path.join(privNm, 'forge-zeta', 'package.json'), JSON.stringify({ name: 'forge-zeta' }))
    fs.symlinkSync(path.join(repo, 'forge-beta'), path.join(privNm, 'forge-beta'))     // beta：声明了、共享镜像无链（红），但第二锚点解析得到
    const base = { homes: [home], repoRoot: repo }
    const r0 = checkAssembly(base)
    push('声明 + 软链在主 checkout ⇒ 不红', !r0.missingInstall.some((x) => x.startsWith('forge-alpha')) && !r0.implicit.some((x) => x.startsWith('forge-alpha')))
    push('声明了但没软链 ⇒ 判红', r0.missingInstall.some((x) => x.startsWith('forge-beta')), r0.missingInstall.join(','))
    push('软链指向别的工作树 ⇒ 判红（劫持）', r0.hijacked.some((x) => x.pkg.startsWith('forge-gamma')))
    push('断链判红', r0.hijacked.some((x) => x.pkg.startsWith('forge-nowhere')))
    push('隐式装配只提醒不判红', r0.implicit.some((x) => x.startsWith('forge-delta')) && !r0.missingInstall.some((x) => x.startsWith('forge-delta')))
    push('注释里的 id 不算声明', !r0.declared.some((x) => x.startsWith('forge-delta')))
    // ↓ ISS-757：profile 私有 node_modules 里指向别处/快照拷贝的条目，共享镜像那一层看不见
    const driftOf = (list) => list.map((d) => `${d.pkg}:${d.kind}`).join(',')
    // ⚠️ 汇总层的 pkg 带 `（引擎/profile）` 后缀 ⇒ 断言必须按前缀匹配（第一版用 === 判等，
    //    结果"指向主 checkout 不报"那条是**空判**（永远为真），这里一并修掉）
    push('profile 私有条目指向别的工作树 ⇒ 进 privateDrift(elsewhere)', r0.privateDrift.some((d) => d.pkg.startsWith('forge-eps') && d.kind === 'elsewhere'), driftOf(r0.privateDrift))
    push('profile 私有条目是快照拷贝（实体目录）⇒ 进 privateDrift(copy)', r0.privateDrift.some((d) => d.pkg.startsWith('forge-zeta') && d.kind === 'copy'))
    push('profile 私有条目指向主 checkout ⇒ 不报（不制造噪音）', !r0.privateDrift.some((d) => d.pkg.startsWith('forge-alpha')), driftOf(r0.privateDrift))
    // 锚点一致性：repoRoot 传成"另一棵树"时也不许把指向主树的私有条目报成偏移
    // （真实场景 = 在链接工作树里跑 guard，此时传进来的 repoRoot 就是工作树；ISS-727 的恒红教训同型）
    push('私有条目的主树判定与 readLinks 同锚点（repoRoot 传错树也不误报）',
      checkAssembly({ homes: [home], repoRoot: path.join(root, 'unrelated-tree') }).privateDrift.every((d) => !d.pkg.startsWith('forge-alpha')))
    push('这一档只提醒不判红：红清单里不许出现 eps/zeta',
      !r0.missingInstall.some((x) => /^forge-(eps|zeta)/.test(x)) && !r0.hijacked.some((x) => /^forge-(eps|zeta)/.test(x.pkg)) && r0.warn >= r0.privateDrift.length - 1)
    // ISS-728 需要的正是这条信息：红**保留**（不偷改判定），但旁边必须写清"第二锚点解析得到"
    push('声明无共享链 ⇒ 红保留，同时点名"第二锚点解析得到"（beta）',
      r0.missingInstall.some((x) => x.startsWith('forge-beta')) && r0.missingAlsoPrivate.some((d) => d.pkg.startsWith('forge-beta') && d.kind === 'main'),
      r0.missingAlsoPrivate.map((d) => `${d.pkg}:${d.kind}`).join(','))
    push('反向验证：删掉私有层 ⇒ 点名消失，且 beta 从"提醒"翻成"红"（降级后红/提醒的分界正是"能不能加载"）', (() => {
      const redBefore = r0.red, missBefore = r0.missingInstall.length
      fs.rmSync(privNm, { recursive: true, force: true })
      const rr = checkAssembly(base)
      const ok = rr.missingAlsoPrivate.length === 0 && rr.red === redBefore + 1 && rr.missingInstall.length === missBefore
      mkdir(privNm) // rmSync 把目录本身删了，重建必须先 mkdir（第一版直接在已消失的目录里建链 ⇒ ENOENT）
      fs.symlinkSync(path.join(other, 'forge-eps'), path.join(privNm, 'forge-eps'))
      fs.symlinkSync(path.join(repo, 'forge-alpha'), path.join(privNm, 'forge-alpha'))
      fs.symlinkSync(path.join(repo, 'forge-beta'), path.join(privNm, 'forge-beta'))
      mkdir(path.join(privNm, 'forge-zeta'))
      fs.writeFileSync(path.join(privNm, 'forge-zeta', 'package.json'), JSON.stringify({ name: 'forge-zeta' }))
      return ok
    })(), `红 ${r0.red} → 删层后 +1（beta 落进"真加载即失败"）；missingInstall 成员不变`)
    const r1 = checkAssembly({ ...base, allowWorktreeLink: ['ISS-999'] })
    push('豁免口生效且点名', r1.hijacked.every((x) => !x.pkg.startsWith('forge-gamma')) && r1.allowed.some((x) => x.pkg.startsWith('forge-gamma')), `放行 ${r1.allowed.length} 项`)
    push('豁免后仍非假绿（红数下降但 >0）', r1.red < r0.red && r1.red > 0, `${r0.red} → ${r1.red}`)
    const r2 = checkAssembly({ homes: [path.join(root, 'empty')], repoRoot: repo })
    push('空 home 不炸（读不到 = 没声明）', r2.declared.length === 0 && r2.links === 0)
    fs.writeFileSync(path.join(patchDir, 'cordis.patch.yml'), '- insert:\n    - id: forge-ghost\n')
    const r3 = checkAssembly(base)
    push('声明了但盘上无此包 ⇒ 判红', r3.notOnDisk.some((x) => x.startsWith('forge-ghost')))
    // 两引擎：B home 声明、A 未装、B 装了 ⇒ 必须按 home 分别判，不能互相掩盖
    const homeB = path.join(root, 'homeB')
    mkdir(path.join(homeB, 'profiles', 'web-b'))
    mkdir(path.join(homeB, 'profiles', 'node_modules'))
    fs.symlinkSync(path.join(repo, 'forge-alpha'), path.join(homeB, 'profiles', 'node_modules', 'forge-alpha'))
    fs.writeFileSync(path.join(homeB, 'profiles', 'web-b', 'package.json'), JSON.stringify({ name: 'fx-web-b', dsh: { profile: { bundles: [] } } }))
    fs.writeFileSync(path.join(homeB, 'profiles', 'web-b', 'cordis.patch.yml'), '- insert:\n    - id: forge-alpha\n')
    const r4 = checkAssembly({ homes: [home, homeB], repoRoot: repo })
    push('两 home 分别判定（B 装了不算 A 装了）', r4.parts.length === 2 && r4.links >= 1, `parts ${r4.parts.length}`)
    // 主 checkout 的判定不许跟着"脚本自己所在的树"漂：这一条在**链接工作树里**跑才有鉴别力
    // （旧实现返回工作树，于是 18 条正常软链全被判"指向非主 checkout"；在主 checkout 里跑则两者相同）
    // 反向验证（两档互不掩盖）：删掉 profile 私有一层 ⇒ 这一档归零，而原判红的条数**一字不变**
    const redBefore = r0.red
    fs.rmSync(privNm, { recursive: true, force: true })
    const r5 = checkAssembly(base)
    push('删掉 profile 私有一层 ⇒ privateDrift 归零，红数 +1（beta 从提醒翻回红）——两档互不掩盖、也不互相顶包',
      r5.privateDrift.length === 0 && r5.red === redBefore + 1, `${redBefore} → ${r5.red} · drift ${r0.privateDrift.length} → ${r5.privateDrift.length}`)
    const main = mainRepoRoot(REPO_DEFAULT)
    push('主 checkout 由 git common dir 定，那里 .git 是目录而非工作树的 .git 文件',
      fs.existsSync(path.join(main, '.git')) && fs.statSync(path.join(main, '.git')).isDirectory(), main)
    // ↓ ISS-757 收尾（2026-09-23）：红线文案必须分两档 —— "没进共享镜像"与"真加载即失败"不是一回事
    push('逐 profile 明细：beta 声明在 web 且 web 私有目录有链 ⇒ 标"能加载"，且不进"真加载即失败"那一档',
      r0.missingDetail.some((d) => d.pkg.startsWith('forge-beta') && d.loadableInDeclaringProfile === true && d.declaresIn.join() === 'web')
      && r0.mirrorOnly.some((x) => x.startsWith('forge-beta')) && !r0.missingLoad.some((x) => x.startsWith('forge-beta')),
      `missingLoad=[${r0.missingLoad.join(',')}] mirrorOnly=[${r0.mirrorOnly.join(',')}]`)
    // 降级本身要有鉴别力（ISS-728）：这个 fixture 里 beta 能加载、gamma 劫持、nowhere 断链 ⇒ 红必须正好是 2
    // （写死绝对值，不是复述公式 —— 复述公式的用例恒绿，等于没有）
    push('降级生效：能加载的 beta 不进红 ⇒ 本 fixture 红 = 2（gamma 劫持 + nowhere 断链），beta 落提醒',
      r0.red === 2 && r0.warn >= 1, `red=${r0.red} warn=${r0.warn} mirrorOnly=[${r0.mirrorOnly.join(',')}]`)
    // 正向对照：一个"声明了但两处锚点都解析不到"的包，必须落进另一档（否则上一档就是恒真）
    const home2 = path.join(root, 'home2')
    mkdir(path.join(home2, 'profiles', 'web'))
    mkdir(path.join(home2, 'profiles', 'node_modules'))
    mkdir(path.join(repo, 'forge-eta'))
    fs.writeFileSync(path.join(repo, 'forge-eta', 'package.json'), JSON.stringify({ name: 'forge-eta' }))
    fs.writeFileSync(path.join(home2, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'fx-web2', dsh: { profile: { bundles: [] } } }))
    fs.writeFileSync(path.join(home2, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - id: forge-eta\n')
    const r6 = checkAssembly({ homes: [home2], repoRoot: repo })
    push('声明了但两处锚点都没有 ⇒ 判"真加载即失败"（红不降级）',
      r6.missingDetail.some((d) => d.pkg.startsWith('forge-eta') && d.loadableInDeclaringProfile === false)
      && r6.missingLoad.some((x) => x.startsWith('forge-eta')) && r6.red >= 1,
      `missingLoad=[${r6.missingLoad.join(',')}]`)
    // 反向：把 beta 的私有链换成断链 ⇒ 同一张单子必须从"能加载"翻到"真加载即失败"（判据有鉴别力）
    // ⚠️ 两处前置：① r5 用例把 privNm 整层删掉了 ⇒ 先 mkdir 再建链；② 更早的 r3 用例把 patch 文件
    //    改写成只剩 forge-ghost ⇒ 不恢复声明的话 missingInstall 是空的，这条会"因为没东西可判"而假失败
    //    （第一次跑就是这样：missingLoad=[] 不是判据没翻，是**没有声明可判**）。
    mkdir(privNm)
    fs.writeFileSync(path.join(patchDir, 'cordis.patch.yml'), '- insert:\n    - id: forge-alpha\n- insert:\n    - id: forge-beta\n')
    fs.rmSync(path.join(privNm, 'forge-beta'), { force: true })
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(privNm, 'forge-beta'))
    const r7 = checkAssembly(base)
    push('私有链变成断链 ⇒ beta 从"能加载"翻到"真加载即失败"（不是恒绿也不是恒红）',
      r7.missingLoad.some((x) => x.startsWith('forge-beta')) && !r7.mirrorOnly.some((x) => x.startsWith('forge-beta')),
      `missingLoad=[${r7.missingLoad.join(',')}]`)
    // ↓ ISS-651（2026-10-24）：声明集必须认 `dsh.profile.bundles`，且顶层 `- id:` 覆盖行**不**算声明
    //   这一组就是本单的回归用例：改前（只读 profile patch + `-?` 宽松正则）两类都会错。
    const home3 = path.join(root, 'home3')
    const p3 = path.join(home3, 'profiles', 'web')
    const nm3 = path.join(home3, 'profiles', 'node_modules')
    mkdir(p3); mkdir(nm3)
    fs.symlinkSync(path.join(repo, 'forge-beta'), path.join(nm3, 'forge-beta'))   // beta 自带 patch（fixture 已建）
    const writeP3 = (bundles, patchText) => {
      fs.writeFileSync(path.join(p3, 'package.json'), JSON.stringify({ name: 'fx-web3', dsh: { profile: { bundles } } }))
      fs.writeFileSync(path.join(p3, 'cordis.patch.yml'), patchText)
    }
    // ① bundle 声明的件 = 声明（改前只读 patch ⇒ 报成「隐式装配」）
    writeP3(['forge-beta'], '# 本 profile 的 patch 里一行 insert 都没有 —— 声明全在 bundles\n')
    const r8 = checkAssembly({ homes: [home3], repoRoot: repo })
    push('ISS-651①：bundles 声明的件算声明，不再报「profile 未声明」',
      r8.declared.some((x) => x.startsWith('forge-beta')) && !r8.implicit.some((x) => x.startsWith('forge-beta')),
      `declared=[${r8.declared.join(',')}] implicit=[${r8.implicit.join(',')}]`)
    // ② 反向：把 bundle 从清单里摘掉 ⇒ 同一条翻成「隐式装配」（证明①不是恒真）
    writeP3([], '# 同上，但 bundles 已摘空\n')
    const r9 = checkAssembly({ homes: [home3], repoRoot: repo })
    push('ISS-651①反向：bundles 摘掉 ⇒ 翻成隐式装配（判据有鉴别力，不是恒绿）',
      !r9.declared.some((x) => x.startsWith('forge-beta')) && r9.implicit.some((x) => x.startsWith('forge-beta')),
      `implicit=[${r9.implicit.join(',')}]`)
    // ③ 顶层 `- id: X` + config 是**覆盖行**，不是声明（改前的 `-?` 正则把 forge-agents 这类算成声明）
    writeP3([], '- id: forge-gamma\n  config:\n    k: v\n')
    const r10 = checkAssembly({ homes: [home3], repoRoot: repo })
    push('ISS-651②：顶层 `- id:` 覆盖行不算声明（改前的宽松正则把它冒充声明）',
      r10.declared.length === 0, `declared=[${r10.declared.join(',')}]`)
    // ④ 读不到 profile（无 package.json）⇒ 出声，不许静默当「没声明」
    fs.rmSync(path.join(p3, 'package.json'), { force: true })
    const r11 = checkAssembly({ homes: [home3], repoRoot: repo })
    push('ISS-651③：profile 读不到 ⇒ 记进 unread 出声（不当成「没挂」）',
      r11.unread.some((u) => u.profile === 'web' && /package\.json/.test(u.reason)), JSON.stringify(r11.unread))
    // ⑤ bundle 式加载：包在 bundles 里、自带 patch insert 的却是**别的 id**（真形态 = forge-widgets 自挂
    //    forge-mermaid）⇒ 必须算「已声明」，不许报「隐式装配」。这条与①不同：①的 insert id 与被挂包同名，
    //    这里同名同不了 ⇒ 只有「按 bundles 判」才拦得住。
    mkdir(path.join(repo, 'forge-agg'))
    fs.writeFileSync(path.join(repo, 'forge-agg', 'package.json'), JSON.stringify({ name: 'forge-agg', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    fs.writeFileSync(path.join(repo, 'forge-agg', 'cordis.patch.yml'), '- insert:\n    - id: forge-agg-child\n')
    fs.symlinkSync(path.join(repo, 'forge-agg'), path.join(nm3, 'forge-agg'))
    writeP3(['forge-agg'], '# 声明全在 bundles\n')
    const r12 = checkAssembly({ homes: [home3], repoRoot: repo })
    push('bundle 式加载（自带 patch insert 的是别的 id）⇒ 不报「隐式装配」',
      !r12.implicit.some((x) => x.startsWith('forge-agg')) && r12.declared.some((x) => x.startsWith('forge-agg-child')),
      `declared=[${r12.declared.join(',')}] implicit=[${r12.implicit.join(',')}]`)
    // ⑥ 反向：把 forge-agg 从 bundles 摘掉 ⇒ 立刻回到「隐式装配」（证明⑤是判据不是恒绿）
    writeP3([], '# bundles 摘空\n')
    const r13 = checkAssembly({ homes: [home3], repoRoot: repo })
    push('bundle 式加载的反向：从 bundles 摘掉 ⇒ 重新出现在「隐式装配」里',
      r13.implicit.some((x) => x.startsWith('forge-agg')), `implicit=[${r13.implicit.join(',')}]`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    delete process.env.FORGE_REPO_UNDER_TEST
  }
  let fail = 0
  console.log('assembly-check --selftest（临时目录 fixture，不碰真实 ~/.dsh）')
  for (const c of cases) { console.log(`  ${c.c ? '✓' : '✗'} ${c.n}${c.note ? '（' + c.note + '）' : ''}`); if (!c.c) fail++ }
  console.log(fail ? `\n✗ 反向验证失败 ${fail}/${cases.length}` : `\n✓ ${cases.length}/${cases.length} 项通过：该红能红、豁免会点名、隐式装配不误伤、注释不冒充声明、两 home 不互掩、主根不随工作树漂、红线按逐 profile 事实分档`)
  return fail ? 1 : 0
}

const ARGV = process.argv.slice(2)
if (ARGV.includes('--selftest')) process.exit(selftest())
const allow = (process.env.FORGE_ALLOW_WORKTREE_LINK || '').split(',').map((s) => s.trim()).filter(Boolean)
const r = checkAssembly({ homes: homesOfEnv(), allowWorktreeLink: allow })
if (ARGV.includes('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(r.red ? 1 : 0) }
console.log(`装配体检 · home ${r.parts.length} · 声明 ${r.declared.length} · 软链 ${r.links} · 红 ${r.red}（其中真加载即失败 ${r.missingLoad.length}）· 提醒 ${r.warn}${allow.length ? ` · 已放行 ${allow.join(',')}` : ''}`)
// 红线按**逐 profile 的事实**写，不再一律说"加载即失败"（ISS-757 收尾）：
// 声明在哪个 profile、那个 profile 的私有目录里有没有链、链去哪 —— 三样都摆出来，人才判得动。
const KIND_CN = { main: '私有目录有链 → 主 checkout', copy: '私有目录是快照拷贝', elsewhere: '私有目录有链 → 仓库之外', 'main-tree-other': '私有目录有链 → 同一主树的别处', broken: '私有目录里是断链', absent: '私有目录里没有' }
for (const d of r.missingDetail) {
  const where = d.declaresIn.length ? `声明于 ${d.declaresIn.join(' + ')}` : '（没有 profile 声明它 —— 不该出现，说明读取有洞）'
  const vias = d.via.map((v) => `${v.profile}: ${KIND_CN[v.kind] || v.kind}${v.real && v.kind !== 'main' && v.kind !== 'copy' ? `（${v.real}）` : ''}`).join(' · ')
  if (d.loadableInDeclaringProfile) console.log(`  · 提醒：声明了但没进共享镜像（**不是加载失败**，老板 09-23 批降级）：${d.pkg} · ${where} · ${vias} ⇒ 引擎加载得到；它问的是"换机器/重装会不会掉"（共享镜像是安装态证据）`)
  else console.log(`  ✗ 声明了但解析不到（真加载即失败）：${d.pkg} · ${where} · ${vias}`)
}
for (const u of r.unread) console.log(`  · 读不到 profile 的装配声明（其声明未计入，别当「没挂」）：${u.profile}（${u.home}）· ${u.reason}`)
for (const x of r.notOnDisk) console.log(`  ✗ 声明了但盘上没这个包（装配表说谎）：${x}`)
for (const x of r.hijacked) console.log(`  ✗ ${x.pkg} ${x.why}：${x.target}`)
// ISS-750：断链/劫持的**修法**要写在红线上，否则下一个人只会把判据当噪音（ISS-703/1893 退役后
// 留下的 4 条断链软链就挂了一整天，谁看到都以为是「这台机器的问题」）。三类的动作各不相同：
if (r.hijacked.length) {
  const broken = r.hijacked.filter((x) => x.why.startsWith('断链'))
  if (broken.length) console.log('      → 断链修法：包已退役/工作树已删 ⇒ 删掉软链本身（rm <上面那个路径>）；包还在 ⇒ 重建链。别改判据。')
  const elsewhere = r.hijacked.filter((x) => !x.why.startsWith('断链'))
  if (elsewhere.length) console.log('      → 劫持修法：指向别的工作树 ⇒ 改回主 checkout；确需放行用 FORGE_ALLOW_WORKTREE_LINK=<ISS号>（见 docs/code.md §4.7）。')
  console.log('      → 复发根因：退役单的收尾清单里没有「清 home 软链」这一步（ISS-751 建议：退役必须同时清 profiles/node_modules 的链）。')
}
for (const x of r.allowed) console.log(`  ⚑ 已放行（FORGE_ALLOW_WORKTREE_LINK）：${x.pkg} → ${x.iss}`)
for (const x of r.implicit) console.log(`  · 隐式装配（软链 + 自带 patch，profile 未声明）：${x}`)
for (const d of r.privateDrift) console.log(`  · profile 私有条目（第二锚点，共享镜像看不见 ⇒ ISS-757）：${d.pkg} ${d.kind === 'copy' ? '是快照拷贝，改仓库不会生效' : d.kind === 'broken' ? '断链' : '指向仓库之外'} → ${d.real}`)
// missingAlsoPrivate 是 missingDetail 的子集（同一条红的两份视图）⇒ 上面逐 profile 那几行已经把它说全了，
// 这里不再重复打印（字段保留：先前的用例与下游脚本在读它）。
void r.missingAlsoPrivate
process.exit(r.red ? 1 : 0)
