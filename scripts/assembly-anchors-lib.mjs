// 装配锚点的**唯一**读者（ISS-757 收尾 · 2026-09-23）
//
// 为什么单独立一份：这两层目录原先在两个脚本里各写一遍 ——
//   · `assembly-check.mjs` 的 `readLinks()` / `readProfilePrivate()`
//   · `code-inventory.mjs` 的 `linkedInto()`（以及我这次临时加的私有层扫描）
// 抄两份的代价实测过：`k6b` 的跨文件复制粘贴簇当场 **73 → 74**（判据在 1000 行上限之外先报了警），
// 而「哪一层算可达」的口径分歧会把同一个包在一个脚本里判成「在跑」、在另一个里判成「三不靠」（ISS-704 的前提正是它）。
// ⇒ 口径只有一处，消费方只做投影（Set / Map / 分类），不自己再扫目录。
//
// 三层的语义（引擎解析顺序见 `@deepseek-ai/dsh-app-boot/lib/index.js:303-315`：先安装、再 profile 目录）：
//   ① profile 的 cordis.patch.yml（声明 ⇒ 激活）—— 不在本模块，读声明在各自脚本里做（口径不同：并按 home / 按 profile）
//   ② `<home>/profiles/node_modules`（共享镜像：安装态证据，靠 Node 父目录上溯兜底）
//   ③ `<home>/profiles/<profile>/node_modules`（profile 私有：**优先于 ② 生效**）
import fs from 'node:fs'
import path from 'node:path'

/**
 * 共享镜像：`<home>/profiles/node_modules` 里的 forge-* 条目。
 * @param {string} home 引擎根（如 ~/.dsh、~/.dsh-b）
 * @param {string} repoRoot 「主 checkout」的判定基准。**要分类（main/elsewhere）就必须给**：在链接工作树里跑守卫时
 *        传进来的 repoRoot 就是那棵树，写死会把它正确的指向误报成「跑别处」（ISS-727 的恒红同型）。
 *        只取键名集合的消费方（如 code-inventory 的可达集）可以不给 ⇒ 那时 kind 只表达「是不是软链/断链」
 * @returns {Map<string, {kind: 'main'|'real'|'elsewhere'|'broken', target: string, real: string}>}
 */
export function readSharedMirror(home, repoRoot = '') {
  const dir = path.join(home, 'profiles', 'node_modules')
  const out = new Map()
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir)) {
    if (!/^forge-/.test(e)) continue
    const abs = path.join(dir, e)
    let st = null
    try { st = fs.lstatSync(abs) } catch { continue }
    if (!st.isSymbolicLink()) { out.set(e, { kind: 'real', target: abs, real: abs }); continue }
    const link = fs.readlinkSync(abs)
    let real = ''
    try { real = fs.realpathSync(abs) } catch { real = '' }
    if (!real) out.set(e, { kind: 'broken', target: link, real: '' })
    else if (real === path.join(repoRoot, e) || real === path.join(repoRoot, e) + path.sep) out.set(e, { kind: 'main', target: link, real })
    else out.set(e, { kind: 'elsewhere', target: link, real })
  }
  return out
}

/**
 * profile 私有 `node_modules`（第二锚点）：**引擎先按这一层解析，共享镜像看不见它**。
 * 分五类：main（指向主 checkout，正常）/ main-tree-other（同主树的别处，如 `.wt/ISS-x`）/
 * elsewhere（仓库之外）/ copy（实体目录 = 快照拷贝，改仓库不生效）/ broken（断链）。
 * @param {string} home
 * @param {string} repoRoot 同 readSharedMirror
 * @returns {Array<{pkg: string, profile: string, kind: string, real: string}>}
 */
export function readProfilePrivate(home, repoRoot = '') {
  const out = []
  const profilesDir = path.join(home, 'profiles')
  if (!fs.existsSync(profilesDir)) return out
  for (const prof of fs.readdirSync(profilesDir, { withFileTypes: true })) {
    if (!prof.isDirectory()) continue
    const nm = path.join(profilesDir, prof.name, 'node_modules')
    if (!fs.existsSync(nm)) continue
    for (const e of fs.readdirSync(nm)) {
      if (!/^forge-/.test(e)) continue
      const abs = path.join(nm, e)
      let st = null
      try { st = fs.lstatSync(abs) } catch { continue }
      if (!st.isSymbolicLink()) { out.push({ pkg: e, profile: prof.name, kind: 'copy', real: abs }); continue }
      let real = ''
      try { real = fs.realpathSync(abs) } catch { real = '' }
      const target = (() => { try { return fs.readlinkSync(abs) } catch { return '' } })()
      if (!real) out.push({ pkg: e, profile: prof.name, kind: 'broken', real: target })
      else if (real === path.join(repoRoot, e) || real.startsWith(path.join(repoRoot, e) + path.sep)) out.push({ pkg: e, profile: prof.name, kind: 'main', real })
      else out.push({ pkg: e, profile: prof.name, kind: real.startsWith(repoRoot + path.sep) ? 'main-tree-other' : 'elsewhere', real })
    }
  }
  return out
}

/** 「解析得到」= 三类里的任何一类，**断链不算**（引擎加载那一刻会失败） */
// ⚠️ **不导出**：只有本文件的 privatePkgs 用它 ⇒ 导出就是给 K10b 加一格零引用（实测 793→794 当场判红）。
// 将来真有第二个导入方再导，别提前给「可能有人要用」留口子。
const RESOLVABLE_KINDS = new Set(['main', 'real', 'elsewhere', 'main-tree-other', 'copy'])

/** profile 私有层里"解析得到"的包集合（可达判定的原料；断链被排除 ⇒ 度量不比引擎更严也不更松） */
export function privatePkgs(home, repoRoot = '') {
  return new Set(readProfilePrivate(home, repoRoot).filter((d) => RESOLVABLE_KINDS.has(d.kind)).map((d) => d.pkg))
}

/**
 * 某个 home 下**真实存在**的 profile 名（排除 `node_modules`、`*.bak-*` 备份、`*-probe` 探测目录）。
 *
 * 为什么自动发现而不是各脚本硬编码一份（ISS-557 / 风险 R3）：旧的 `['web','web-b']` 在 2026-10-01
 * 被查实**四个面全不在跑** —— `~/.dsh-b` 已删、`web`/`web-b` 无引擎；而真实在跑的
 * `~/.dsh/profiles/desktop`（官方 App 19387 · 生产）与 `~/.dsh-matter/profiles/web`（3210 独立服务）
 * **零覆盖** ⇒ 门禁对着空地扫。自动发现让**新增 profile 天然被覆盖**，不必记得同步常量。
 *
 * 排除规则：`node_modules` / `*-probe` 本来就没有 `cordis.patch.yml`，会被存在性过滤掉；
 * `*.bak-*` 是 profile 备份，扫它只会把历史快照的悬空条目算成当下的红（ISS-728 的「红灯常态化」教训）。
 * @param {string} home 引擎根（如 ~/.dsh、~/.dsh-matter）
 * @returns {string[]} 升序的 profile 名
 */
export function profilesOf(home) {
  const dir = path.join(home, 'profiles')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !/\.bak[-.]/.test(d.name) && !/-probe$/.test(d.name))
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(dir, n, 'cordis.patch.yml')))
    .sort()
}
