// PM v2 活体验证（ISS-594 交付件）：重启 3210 之后跑一次，把「代码合了但没生效」这段灰区关掉。
//
// 为什么必须有：本批六条端点 + 四道安全闸全部住在宿主里，`bun test` 只能证明逻辑对，
// 证明不了**正在跑的那个进程**加载了新代码（ISS-407 的两层缓存事故就是这么来的）。
// 判据全部可反证：任何一条红都会说清是哪一条、期望什么、拿到什么。
//
// 用法：
//   node scripts/pm-v2-verify.mjs              # 打 127.0.0.1:3210
//   node scripts/pm-v2-verify.mjs --port 3211  # 隔离实例
//   退出码：0 全绿 / 2 有红（可直接进 CI 或 ws.sh）
const PORT_IDX = process.argv.indexOf("--port")
const PORT = PORT_IDX > -1 ? process.argv[PORT_IDX + 1] : "3210"
const BASE = `http://127.0.0.1:${PORT}`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, skipped: false, detail })
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
}

// ⚠️ 前置条件不成立时必须显式「未验证」，不能让它落进 ✓ 或 ✗：
//    落 ✓ 就是**假绿**（恒绿门禁比没门禁更糟，见 ISS-587 的验收口径），
//    落 ✗ 就是假红（把「还没重启」报成「功能坏了」会引着人去查错地方）。
function skip(name, why) {
  results.push({ name, ok: false, skipped: true, detail: why })
  console.log(`! ${name} — 未验证：${why}`)
}

async function req(path, init) {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 原样给 text */
  }
  return { status: res.status, json, text, headers: res.headers }
}

// ── 1. 版本端点：先确认「是谁在跑」 ────────────────────────────────────────
const v = await req("/forge-pm/version")
if (v.status === 404) {
  check("GET /forge-pm/version", false, `404 —— 进程跑的是旧代码，需要先重启（scripts/restart-web-detached.sh）`)
} else {
  const j = v.json || {}
  check("GET /forge-pm/version", v.status === 200 && !!j.version, JSON.stringify(j).slice(0, 160))
  check("schema 版本已上报", typeof j.storeSchemaVersion === "number" && j.storeSchemaVersion >= 5, `storeSchemaVersion=${j.storeSchemaVersion}`)
}

// ── 2. 活动流游标（ISS-591/595 的跨进程可重放） ───────────────────────────
const a0 = await req("/forge-pm/activity-log?limit=3")
const rows = a0.json?.rows || []
check("GET /forge-pm/activity-log", a0.status === 200 && rows.length > 0, `${rows.length} 行，next=${a0.json?.next}`)
if (rows.length) {
  const a1 = await req(`/forge-pm/activity-log?since=${a0.json.next}&limit=50`)
  const after = (a1.json?.rows || []).filter((r) => r.seq <= a0.json.next)
  check("游标续传只向前", a1.status === 200 && after.length === 0, `越界 ${after.length} 行`)
}

// ── 3. 单条取数 + 路径闸门（ISS-594） ─────────────────────────────────────
const list = await req("/forge-pm/list")
const first = (list.json?.items || [])[0]
check("GET /forge-pm/list 有数据", !!first, `items=${(list.json?.items || []).length}`)
let recordOk = false
if (first) {
  const one = await req(`/forge-pm/record?rel=${encodeURIComponent(first.id)}`)
  recordOk = one.status === 200 && one.json?.item?.id === first.id && one.json?.item?.status === first.status
  check("GET /forge-pm/record 与列表同构", recordOk, one.status === 200 ? `id=${one.json?.item?.id}` : `status=${one.status}`)
}
// 正例都不通时，"404 拒绝了穿越" 是**假绿**（路由根本不存在，返回的 404 与闸门无关）
if (!recordOk) skip("record 拒绝路径穿越", "record 正例未通过，404 无法区分「闸门挡住」与「路由不存在」")
else {
  const traversal = await req(`/forge-pm/record?rel=${encodeURIComponent("../../etc/passwd.md")}`)
  check("record 拒绝路径穿越", traversal.status === 404, `status=${traversal.status}`)
}

// ── 4. 搜索（ISS-593）与派生层体检（ISS-603） ─────────────────────────────
const s = await req("/forge-pm/search?q=%E6%B4%BE%E5%8D%95&limit=3")
const hits = s.json?.hits || s.json?.items || []
// 判据要的是"真命中"，`length >= 0` 那种永真式等于没测
check("GET /forge-pm/search 有命中", s.status === 200 && hits.length > 0, `mode=${s.json?.mode} hits=${hits.length} status=${s.status}`)

const h = await req("/forge-pm/db-health")
const db = h.json?.db || {}
check(
  "GET /forge-pm/db-health 报一致性",
  h.status === 200 && db.unavailable !== true && Number(db.events) > 0,
  `engine=${db.engine} schema=${db.schema} events=${db.events} indexed=${db.indexed} unknown=${db.unknownEvents}`,
)
// 清扫器只要跑过一圈，游标就该往前走；passes 会加。这项专防"接线在但没驱动"。
// 只在**端点已在但 ticks=0** 时等（首轮 tick 可能赶在 openStore 异步挂载之前，60s 内会补上）；
// 端点压根不存在（旧代码）时不白等 —— 那属于"没重启"，不是"没驱动"。
let sweep = h.json?.sweep || {}
if (h.status === 200 && !(Number(sweep.ticks) >= 1)) {
  for (let i = 0; i < 6 && !(Number(sweep.ticks) >= 1); i++) {
    await new Promise((r) => setTimeout(r, 12000))
    sweep = (await req("/forge-pm/db-health")).json?.sweep || {}
  }
}
check(
  "活动流清扫已被 tick 驱动",
  h.status === 200 && Number(sweep.ticks) >= 1,
  `ticks=${sweep.ticks} cursor=${sweep.cursor}/${sweep.total_last} passes=${sweep.passes} 累计补录=${sweep.inserted} 漂移文件=${sweep.driftFiles}`,
)

// ── 5. CSRF 同源闸门（ISS-584）：只打「会被闸门先拦下」的请求，不落数据 ────
const crossSite = await req("/forge-pm/note", {
  method: "POST",
  headers: { "content-type": "application/json", "sec-fetch-site": "cross-site", origin: "https://evil.example" },
  body: JSON.stringify({ id: "ISS-000000", text: "probe" }),
})
check("跨站 POST 被拒 403", crossSite.status === 403, `status=${crossSite.status}`)
const nullOrigin = await req("/forge-pm/note", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "null" },
  body: JSON.stringify({ id: "ISS-000000", text: "probe" }),
})
check("Origin: null 被拒 403", nullOrigin.status === 403, `status=${nullOrigin.status}`)
const gateLive = crossSite.status === 403 && nullOrigin.status === 403
const bogusLocal = await req("/forge-pm/note", {
  method: "POST",
  headers: { "content-type": "application/json", origin: `${BASE}` },
  body: JSON.stringify({ id: "ISS-000000", text: "probe" }),
})
// 「本机 POST 没被拦」在闸门还没上线时**必然成立**——那是假绿。只有两条负例都成立，
// 这条正例才有意义（证明闸门是"拦外人放自己"，而不是"谁都没拦"）。
if (!gateLive) skip("本机同源 POST 放行", "两条跨站负例未通过，无法区分「闸门放行」与「闸门不存在」")
else check("本机同源 POST 放行（拿到业务态而非 403）", bogusLocal.status !== 403, `status=${bogusLocal.status}（404=条目不存在，正是业务态）`)

// ── 6. SSE 事件流：真连一次，并做一次真写入验证帧会来 ─────────────────────
{
  const ctrl = new AbortController()
  let connected = false
  let buf = ""
  const stream = (async () => {
    try {
      const res = await fetch(`${BASE}/forge-pm/events`, { headers: { accept: "text/event-stream" }, signal: ctrl.signal })
      connected = res.status === 200 && String(res.headers.get("content-type") || "").includes("text/event-stream")
      if (!connected) return
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      const t0 = Date.now()
      while (Date.now() - t0 < 6000) {
        const got = await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r(null), 5000)),
        ])
        if (!got || got.done) break
        buf += dec.decode(got.value, { stream: true })
        // 收工条件必须是「拿到一条 data 帧」。服务端首包是 `: connected` **注释帧**，它同样以 \n\n 结尾 ——
        // 原先按「有完整帧就 break」会在 0.4s 就退出，data 帧永远读不到，把好好的事件面测成假红（ISS-609）。
        if (/^data: /m.test(buf)) break
      }
    } catch {
      connected = false
    }
  })()

  // 等连接建立后做一次真写入：给自己发一条备注 → 应当收到对应的一帧。
  // 备注本身是**可追溯的探针**（写明来源），比静默探测诚实；重复跑只多几条 agent-note。
  await new Promise((r) => setTimeout(r, 400))
  const wrote = await req("/forge-pm/note", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ id: "ISS-582", text: `[pm-v2-verify] SSE 活性探针 @ ${new Date().toISOString()}` }),
  })
  await Promise.race([stream, new Promise((r) => setTimeout(r, 6500))])
  ctrl.abort()
  check("GET /forge-pm/events 建流", connected, wrote.status === 200 ? "已写入一条探针备注等帧回来" : `写入失败 status=${wrote.status}`)
  const datas = buf
    .split("\n\n")
    .map((f) => (f.match(/^data: (.*)$/m) || [])[1])
    .filter(Boolean)
  let matched = null
  for (const d of datas) {
    try {
      const j = JSON.parse(d)
      if (j && typeof j.rel === "string" && j.rel.includes("ISS-582")) matched = j
    } catch {
      /* 非 JSON 帧忽略 */
    }
  }
  check(
    "写入 → 收到对应事件帧",
    !!matched,
    matched ? `rel=${matched.rel} seq=${matched.seq} kind=${matched.kind}` : `收到 ${datas.length} 帧但无 ISS-582 的变更帧`,
  )
}

const red = results.filter((r) => !r.ok && !r.skipped)
const skipped = results.filter((r) => r.skipped)
const green = results.filter((r) => r.ok).length
console.log(`\n── PM v2 活体验证：${green} 绿 / ${red.length} 红${skipped.length ? ` / ${skipped.length} 未验证` : ""}（共 ${results.length} 项）──`)
if (red.length) {
  console.log("红项：")
  for (const r of red) console.log(`  ✗ ${r.name} — ${r.detail || ""}`)
  console.log("\n若是「404 / 建流失败」类：说明 3210 还跑着旧代码，走 scripts/restart-web-detached.sh 再来一次。")
  process.exit(2)
}
if (skipped.length) {
  console.log("未验证项（不计绿，也不报错）：")
  for (const r of skipped) console.log(`  ! ${r.name} — ${r.detail}`)
}
