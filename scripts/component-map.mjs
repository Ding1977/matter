#!/usr/bin/env node
// scripts/component-map.mjs
// 组件清单生成器（ISS-944 / DOC-334 T4）—— 画布出码的 component_map 真相源（派生物，禁手写）
//
// 用法：node scripts/component-map.mjs [--write] [--check] [--json] [--selftest]
//   · 默认        打摘要（条数 / 三态统计 / 同名多份 Top）
//   · --write     记录基线 scripts/baseline/component-map.json（只在干净树、且读完 diff 后跑）
//   · --check     重算并与基线比：**漂移即判红**（exit 2），清单与代码不一致不许静默
//   · --selftest  三条牙：① 注入必红 ② 干净不误伤 ③ 空清单不会被读成"全都映射上了"
//
// 为什么必须派生：出码要判「这个画布框对应哪个既有组件」。如果清单是手写的 md，
// 组件一改名它就过期，而过期不会报错、只会**静默错**（project-refactor-rules 反面教训 #9）。
// 所以口径一律取 scripts/design-component-inventory.mjs（组件盘点的既有唯一口径，
// 见其头注「数字来源可机器复算，禁手抄进文档」），本脚本不另数一遍。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = path.join(ROOT, 'scripts/baseline/component-map.json')
const INVENTORY = path.join(ROOT, 'scripts/design-component-inventory.mjs')
/** 分层优先级：只用于给"建议"，不用于替人裁决同名多份（建议 ≠ 裁决，字段名单列） */
const LAYER_RANK = { BASE: 0, L2: 1, KIT: 2, BIZ: 3, COPY: 4 }

function inventoryJson() {
  // 同步读，避免 console.log+exit 那条截断坑（已在盘点器里修掉，这里仍按最稳的走）
  const res = spawnSync('node', [INVENTORY, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`盘点器退出码 ${res.status}：${(res.stderr || '').slice(0, 200)}`)
  return JSON.parse(res.stdout)
}

/** 派生清单：名 → 实现候选（文件/包/分层/使用者数）+ 建议档（不裁决） */
export function buildMap(inv = inventoryJson()) {
  const 组件表 = inv['组件表'] ?? []
  const names = []
  for (const c of 组件表) {
    const impls = (c.实现 ?? []).map((x) => ({ 文件: x.文件, 包: x.包, 分层: x.分层, 使用者: x.使用者 }))
    if (impls.length === 0) continue
    const ranked = [...impls].sort((a, b) => (LAYER_RANK[a.分层] ?? 9) - (LAYER_RANK[b.分层] ?? 9) || a.文件.localeCompare(b.文件))
    names.push({
      名: c.名,
      状态: impls.length === 1 ? 'mapped' : 'ambiguous',
      候选: ranked,
      建议: impls.length === 1 ? ranked[0].文件 : null,
      建议分层: impls.length === 1 ? ranked[0].分层 : ranked[0].分层,
    })
  }
  names.sort((a, b) => a.名.localeCompare(b.名))
  const mapped = names.filter((n) => n.状态 === 'mapped').length
  const ambiguous = names.filter((n) => n.状态 === 'ambiguous').length
  return {
    header: {
      tool: 'component-map.mjs',
      派生自: 'design-component-inventory.mjs --json（组件盘点唯一口径）',
      生成时间: new Date().toISOString(),
      扫描文件数: inv['扫描文件数'],
      组件实现总数: inv['组件实现总数'],
      规则: '一名一实现 = mapped；一名多实现 = ambiguous（出码必须停下等人工定档，不猜）；清单里没有 = unmapped',
    },
    统计: { 组件名: names.length, mapped, ambiguous },
    清单: names,
  }
}

const normalize = (raw) => String(raw ?? '').trim().replace(/\s+/g, ' ').split(' ')[0]

/** 与 canvas 侧同一套归一化口径（这里只为算摘要里的"可命中比例"） */
function hitRate(map, layerNames) {
  const set = new Set(map.清单.map((x) => x.名))
  const lower = new Map(map.清单.map((x) => [x.名.toLowerCase(), x.名]))
  let hit = 0, amb = 0, miss = 0
  for (const raw of layerNames) {
    const n = normalize(raw)
    if (set.has(n)) { const c = map.清单.find((x) => x.名 === n); c.状态 === 'mapped' ? hit++ : amb++ }
    else if (lower.has(n.toLowerCase())) { const c = map.清单.find((x) => x.名 === lower.get(n.toLowerCase())); c.状态 === 'mapped' ? hit++ : amb++ }
    else miss++
  }
  return { 命中: hit, 歧义: amb, 未映射: miss, 总数: layerNames.length }
}

function serialize(map) { return JSON.stringify(map, null, 1) + '\n' }

/* ───────────── 自检（K8b：从没红过 = 没有守卫） ───────────── */
if (process.argv.includes('--selftest')) {
  const fake = { '扫描文件数': 2, '组件实现总数': 3, 组件表: [
    { 名: 'ListRow', 实现: [{ 文件: 'forge-design/src/list-row.tsx', 包: 'forge-design', 分层: 'L2', 使用者: 5 }] },
    { 名: 'Button', 实现: [{ 文件: 'forge-design/src/ui/button.tsx', 包: 'forge-design', 分层: 'BASE', 使用者: 34 },
      { 文件: 'forge-legacy/src/components/ui/button.tsx', 包: 'forge-legacy', 分层: 'COPY', 使用者: 5 }] },
  ] }
  const cases = [
    ['① 一名一实现 ⇒ mapped 并给出建议文件', (() => { const m = buildMap(fake); const r = m.清单.find((x) => x.名 === 'ListRow'); return r.状态 === 'mapped' && r.建议 === 'forge-design/src/list-row.tsx' })()],
    ['② 一名多实现 ⇒ ambiguous 且 建议为 null（不许替人裁决）', (() => { const m = buildMap(fake); const r = m.清单.find((x) => x.名 === 'Button'); return r.状态 === 'ambiguous' && r.建议 === null && r.候选.length === 2 })()],
    ['③ 分层只影响"建议分层"排序，不改变 ambiguous 判定', (() => { const m = buildMap(fake); const r = m.清单.find((x) => x.名 === 'Button'); return r.候选[0].分层 === 'BASE' && r.状态 === 'ambiguous' })()],
    ['④ 空清单 ⇒ 统计为 0，不能被读成"全都映射上了"', (() => { const m = buildMap({ 组件表: [], '扫描文件数': 0, '组件实现总数': 0 }); return m.清单.length === 0 && m.统计.mapped === 0 && m.统计.ambiguous === 0 })()],
    /* ⑤ 归一化要判的是「带说明与大小写的图层名能不能被认出来」——
        Button 是两份 ⇒ 归到歧义而不是命中，所以这里判"认出来了"（命中+歧义=2、未映射=0），
        上一版我把它写成 命中===2，是我用例写错不是代码错。 */
    ['⑤ 归一化：图层名带说明与大小写都能认出来（button 主按钮 / ListRow / listrow 行）', (() => { const m = buildMap(fake); const r = hitRate(m, ['button 主按钮', 'ListRow', 'listrow 行']); return r.未映射 === 0 && (r.命中 + r.歧义) === 3 })()],
    ['⑥ 未映射不会被算成命中（不存在的组件名）', hitRate(buildMap(fake), ['NoSuchWidget']).未映射 === 1],
    ['⑦ 歧义清单不会被算成命中（Button 有两份 ⇒ 记歧义不记命中）', hitRate(buildMap(fake), ['Button']).歧义 === 1 && hitRate(buildMap(fake), ['Button']).命中 === 0],
    /* ⑧ 变异验证暴露的洞：④ 测的是「组件表整个为空」，而真实风险是「某个组件零实现」
        —— 该分支原来无用例，摘掉 `if (impls.length === 0) continue` 时八条前七条全绿（假安全）。 */
    ['⑧ 某组件零实现 ⇒ 跳过，不进清单也不算 mapped', (() => { const m = buildMap({ 组件表: [{ 名: 'Ghost', 实现: [] }, { 名: 'ListRow', 实现: [{ 文件: 'a.tsx', 包: 'p', 分层: 'L2', 使用者: 1 }] }], '扫描文件数': 1, '组件实现总数': 1 }); return m.清单.length === 1 && m.清单[0].名 === 'ListRow' && m.统计.mapped === 1 })()],
  ]
  const fails = cases.filter((c) => !c[1])
  for (const [name, ok] of cases) console.log(`${ok ? '✓' : '✗'} ${name}`)
  console.log(`component-map selftest ${cases.length - fails.length}/${cases.length} 通过`)
  process.exit(fails.length ? 2 : 0)
}

const map = buildMap()

if (process.argv.includes('--json')) { process.stdout.write(serialize(map)); process.exit(0) }

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, serialize(map))
  console.log(`✓ 已记录 ${path.relative(ROOT, BASELINE)}：${map.统计.组件名} 个组件名 · mapped ${map.统计.mapped} · ambiguous ${map.统计.ambiguous}`)
  process.exit(0)
}

if (process.argv.includes('--check')) {
  if (!fs.existsSync(BASELINE)) { console.error('✗ 缺基线：先跑 node scripts/component-map.mjs --write'); process.exit(2) }
  const cur = JSON.parse(serialize(map))
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  // 比较时剔掉时间戳（每次生成都不同，不算漂移）
  delete cur.header.生成时间; delete base.header.生成时间
  const drift = JSON.stringify(cur) !== JSON.stringify(base)
  if (drift) {
    const a = new Map(base.清单.map((x) => [x.名, x])), b = new Map(cur.清单.map((x) => [x.名, x]))
    const added = [...b.keys()].filter((k) => !a.has(k))
    const gone = [...a.keys()].filter((k) => !b.has(k))
    const changed = [...b.keys()].filter((k) => a.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)))
    const headDiff = Object.keys(cur.header).filter((k) => JSON.stringify(cur.header[k]) !== JSON.stringify(base.header[k]))
    const statDiff = Object.keys(cur.统计 ?? {}).filter((k) => JSON.stringify(cur.统计[k]) !== JSON.stringify(base.统计?.[k]))
    console.error(`✗ 组件清单与基线漂移（出码的 component_map 会静默错）：清单 新增 ${added.length} · 消失 ${gone.length} · 变化 ${changed.length} · 定位：头部/统计 [${[...headDiff, ...statDiff].join(", ")}]`)
    for (const k of headDiff) console.error(`   · header.${k}：${JSON.stringify(base.header[k])} → ${JSON.stringify(cur.header[k])}`)
    for (const k of statDiff) console.error(`   · 统计.${k}：${JSON.stringify(base.统计[k])} → ${JSON.stringify(cur.统计[k])}`)
    for (const k of changed.slice(0, 6)) console.error(`   · ${k}：${a.get(k).状态}(${a.get(k).候选.length} 份) → ${b.get(k).状态}(${b.get(k).候选.length} 份)`)
    for (const k of added.slice(0, 4)) console.error(`   + ${k}`)
    for (const k of gone.slice(0, 4)) console.error(`   - ${k}`)
    console.error('  要么改代码后复录（--write），要么就是组件真的动了 —— 不许只把本条关掉')
    process.exit(2)
  }
  console.log(`✓ 组件清单与基线一致（${map.统计.组件名} 名 · mapped ${map.统计.mapped} · ambiguous ${map.统计.ambiguous}）`)
  process.exit(0)
}

console.log(`component-map · 组件名 ${map.统计.组件名} · mapped ${map.统计.mapped} · ambiguous ${map.统计.ambiguous}（派生自盘点 ${map.header.组件实现总数} 个实现）`)
const top = map.清单.filter((x) => x.状态 === 'ambiguous').sort((a, b) => b.候选.length - a.候选.length).slice(0, 8)
console.log('同名多份（出码时必须人工定档）Top：')
for (const t of top) console.log(`  ${t.名.padEnd(18)} ${t.候选.length} 份 · ${t.候选.map((c) => `${c.包}/${c.分层}`).join(' , ')}`)
