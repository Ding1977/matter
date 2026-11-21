/**
 * 重复实现判据（D3）：函数归一形状 + 两条牙的成簇判定（ISS-654）。
 *
 * 从 `scripts/code-inventory.mjs` 搬出（ISS-772）：判据本体与 `--selftest-dup` 的变异验证同住一处。
 * `ts` 由调用方传入 —— 编译器实例的唯一加载点仍在 code-inventory（loadTs），本模块不另建第二条加载路径。
 */
const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'return', 'const', 'let', 'var', 'function', 'await', 'async', 'new', 'try', 'catch', 'finally', 'throw', 'break', 'continue', 'switch', 'case', 'default', 'of', 'in', 'typeof', 'instanceof', 'class', 'extends', 'super', 'do', 'delete', 'void', 'yield', 'import', 'export'])
export const text = (n, sf) => { try { return n.getText(sf) } catch { return '' } }

function tokenTypes(ts, node, sf, out) {
  const stack = [node]
  while (stack.length) {
    const n = stack.pop()
    const k = n.kind
    if (k === ts.SyntaxKind.Identifier) out.push('I')
    else if (k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateHead || k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail || k === ts.SyntaxKind.TemplateExpression) out.push('S')
    else if (k === ts.SyntaxKind.NumericLiteral) out.push('N')
    else if (k === ts.SyntaxKind.RegularExpressionLiteral) out.push('R')
    else {
      const t = text(n, sf)
      if (t.length <= 24 && KEYWORDS.has(t)) out.push(t)
      else if (t.length <= 8 && /^[{}()[\];:,.=<>!&|?+\-*/%]+$/.test(t)) out.push(t)
    }
    ts.forEachChild(n, (c) => { stack.push(c) }) // ⚠️ 回调必须返回 undefined：`(c) => stack.push(c)` 返回数组长度（真值）会让 TS **停止遍历子树**
  }
}

/* ── D3 的两个判据（ISS-654 补第二颗牙）───────────────────────────────────────
 * 函数形状 = ① 归一 token 序列（Jaccard 用）＋ ② **语句级指纹集合**（"是不是抄的"用）。
 * 归一由 `tokenTypes` 完成：标识符→I、字符串→S、数字→N、正则→R，空白与变量名都不进序列。
 *
 * ⚠️ 为什么 ② 必须存在：①只答"长得像"。12-gram 相似度 ≥0.6 在"同一模块里两个都遍历 pages
 *    的箭头函数"这种情形下必然命中，实测把 `function isoAt` 与一个**语义无关**的
 *    `withIndex(res, (index) => …)` 聚成了一簇（ISS-654 的假账来源）。
 *    ②要求两边**至少有一条归一语句逐字相同**（去空白、去变量名之后）
 *    —— 真复制粘贴必然满足（抄的人不会逐句改），单纯形状相近则不满足。
 */
const STMT_MIN = 8            // 语句指纹的最短 token 数：`const _ = _( _ )` 这种 6 token 的通用句不算证据
export function funcShapeOf(ts, node, sf) {
  if (!node || !node.body || !ts.isBlock(node.body)) return null
  const toks = []
  tokenTypes(ts, node.body, sf, toks)
  if (toks.length < 40) return null
  const stmts = new Set()
  const walk = (n) => {
    if (ts.isStatement(n) && !ts.isBlock(n)) {
      const st = []
      tokenTypes(ts, n, sf, st)
      if (st.length >= STMT_MIN) stmts.add(st.join('.'))
    }
    ts.forEachChild(n, walk)
  }
  walk(node.body)
  return { toks, stmts }
}
/** 两条判据都过才算一条边：① 12-gram Jaccard ≥ jac，② 共享至少一条归一语句。 */
export function dupEdgeHolds(a, b, jac, sh, requireStmt = true) {
  const inter = [...a.shingles].filter((s) => b.shingles.has(s)).length
  if (inter / Math.max(1, Math.min(a.shingles.size, b.shingles.size)) < jac) return false
  if (!requireStmt) return true // 只有给 `--selftest-dup` 做对照用：关掉第二颗牙应回到旧口径（证明牙有判别力）
  if (!a.stmts.size || !b.stmts.size) return false
  const [small, big] = a.stmts.size <= b.stmts.size ? [a.stmts, b.stmts] : [b.stmts, a.stmts]
  for (const s of small) if (big.has(s)) return true
  return false
}
/** 并查集聚簇。纯函数（不读盘、不读全局）—— `--selftest-dup` 用同一份代码喂 fixture，防止"自检走另一条路"。 */
export function clusterDupFuncs(all, jac, sh, requireStmt = true) {
  const fs2 = all.filter(Boolean).map((f) => {
    const shingles = new Set()
    for (let i = 0; i + sh <= f.toks.length; i++) shingles.add(f.toks.slice(i, i + sh).join('.'))
    return { ...f, shingles }
  }).filter((f) => f.shingles.size >= 3)
  const shingleMap = new Map()
  fs2.forEach((f, i) => { for (const s of f.shingles) { if (!shingleMap.has(s)) shingleMap.set(s, []); shingleMap.get(s).push(i) } })
  const parent = fs2.map((_, i) => i)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  const HOT = 60
  for (const [, members] of shingleMap) {
    if (members.length < 2 || members.length > HOT) continue
    const uniq = [...new Set(members)]
    for (let i = 1; i < uniq.length; i++) if (dupEdgeHolds(fs2[uniq[0]], fs2[uniq[i]], jac, sh, requireStmt)) uni(uniq[0], uniq[i])
  }
  // ⚠️ 并查集分组必须按"根 → 成员列表"收，不能对 find(i) 的结果再 group（那样每组只剩根自己 ⇒ 簇恒为 0）
  const byRoot = new Map()
  fs2.forEach((f, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(f) })
  return [...byRoot.values()]
    .filter((c) => new Set(c.map((m) => m.k)).size >= 2)
    .sort((a, b) => b.length - a.length || Math.min(...b.map((x) => x.toks.length)) - Math.min(...a.map((x) => x.toks.length)))
}
/** fixture 里取第一个函数形状（自检与主扫描共用 funcShapeOf）。 */
export function firstFuncShapeOf(ts, src) {
  const sf = ts.createSourceFile('fx.ts', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  let out = null
  const visit = (n) => {
    if (out) return
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) {
      const s = funcShapeOf(ts, n, sf)
      if (s) { out = { pkg: 'fx', k: 'fx.ts', name: 'fx', line: 1, toks: s.toks, stmts: s.stmts }; return }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
/** `--selftest-dup`：变异验证「改完仍有牙」—— 见 ISS-654 交付说明的两条反证。 */
export function selftestDupCriterion({ ts, jac, shingle }) {
  const cases = []
  const push = (n, ok, note) => cases.push({ n, ok: !!ok, note })
  const mk = (src, k) => { const f = firstFuncShapeOf(ts, src); return f && { ...f, k } }
  /* 反证 ①（该红仍红）：整段函数体逐字相同、**只改标识符名** ⇒ 必须仍成簇。 */
  const realA = mk(`async function readIndex(files, sizes) {
    const rows = []
    const missing = []
    for (const f of files) {
      const chars = sizes.get(String(f.id))
      if (chars == null) { missing.push(String(f.id)); continue }
      rows.push({ id: String(f.id), title: String(f.title || ""), tokens: Math.round(chars / 3), refs: f.refCount || 0 })
    }
    return { ok: true, rows, missing, n: rows.length }
  }`, 'fx/a.ts')
  const realB = mk(`async function readIndex2(list, sizeMap) {
    const out = []
    const absent = []
    for (const it of list) {
      const n = sizeMap.get(String(it.id))
      if (n == null) { absent.push(String(it.id)); continue }
      out.push({ id: String(it.id), title: String(it.title || ""), tokens: Math.round(n / 3), refs: it.refCount || 0 })
    }
    return { ok: true, rows: out, missing: absent, n: out.length }
  }`, 'fx/b.ts')
  const c1 = clusterDupFuncs([realA, realB], jac, shingle)
  push('反证① 真复制粘贴（体逐字相同、只改标识符）仍被聚成 1 簇', realA && realB && c1.length === 1 && c1[0].length === 2, `实测簇数 ${c1.length} / 成员 ${c1.map((c) => c.length).join(',') || '无'}`)
  /* 反证 ②（该绿已绿）：ISS-654 抓到的那两个假账 —— isoAt 与本仓 routes.js 的 withIndex 箭头，不许再成簇。 */
  const isoA = mk(`function isoAt(raw) {
    if (raw === undefined || raw === null || raw === "") return new Date().toISOString()
    const t = typeof raw === "number" && Number.isFinite(raw) ? raw : Date.parse(String(raw))
    const ms = Number.isFinite(t) ? t : NaN
    if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) {
      return { error: "at 不是合法时间: " + String(raw) }
    }
    return new Date(ms).toISOString()
  }`, 'forge-pm/lib/delegation.js')
  /* 逐字取自 forge-repowiki/lib/routes.js:202 的 `(index) => {…}`（stale 路由里的回调） */
  const arrow = mk(`(index) => {
    const r = stale(index, { paths: paths.length ? paths : undefined, since: q.since || undefined, root: PKG_REPO_ROOT })
    if (!r.ok) return { ok: false, why: r.why, counts: r.counts, buckets: r.buckets }
    return {
      ok: true,
      why: null,
      since: r.since,
      changedReason: r.changedReason,
      changedFiles: r.changedFiles,
      pages: r.pages,
      buckets: r.buckets,
      counts: r.counts,
      stats: r.stats,
      unjudged: r.unjudged,
    }
  }`, 'forge-repowiki/lib/routes.js')
  const c2 = clusterDupFuncs([isoA, arrow], jac, shingle)
  push('反证② isoAt ↔ withIndex 箭头（相似但无逐字相同语句）不再成簇', isoA && arrow && c2.length === 0, `实测簇数 ${c2.length}`)
  /* 反证 ③（对照组，决定性的那一条）：把**同一对** isoAt ↔ withIndex 箭头关掉第二颗牙
     ⇒ 必须回到旧口径聚成 1 簇。它证明 ② 造成的"不聚"不是这对相似度本来就没达标
     —— 本仓 HEAD 的 dup-detail.json 里这一对确实是 1 簇（原始输出见交付说明）。 */
  const c2old = clusterDupFuncs([isoA, arrow], jac, shingle, false)
  push('反证③ 同一对关掉第二颗牙 ⇒ 聚成 1 簇（② 是决定因素，不是巧合）', c2old.length === 1 && c2old[0].length === 2, `实测簇数 ${c2old.length}`)

  let bad = 0
  console.log('code-inventory --selftest-dup（内建 fixture，不扫真实仓库）')
  for (const c of cases) { console.log(`  ${c.ok ? '✓' : '✗'} ${c.n}${c.note ? '（' + c.note + '）' : ''}`); if (!c.ok) bad++ }
  console.log(bad ? `\n✗ 反向验证失败 ${bad}/${cases.length}` : `\n✓ ${cases.length}/${cases.length} 项通过：真复制必聚、相似非复制必不聚`)
  return bad ? 1 : 0
}
