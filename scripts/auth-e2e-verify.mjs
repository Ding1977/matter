// 端到端验证：MCP 客户端自助配对全链路（ISS-659）
//
// 为什么要有这个脚本（2026-10-25 教训）：
//   前两次「改完就重启 3210 再打真机」各踩了一个接线 bug ——
//     ① ctx.get('authorization') 在 apply 期恒 undefined（该用 ctx.inject）
//     ② ctx.credentials 在 forge-pm 里不存在（没 inject，读它必炸）
//   这两个都发生在**接线层**，本来用隔离根就能验出来，不该把 3210 当调试器。
//   本脚本 = 那条「先隔离验完再重启」的闸。
//
// 做法：不启真服务、不碰 3210、不写真实库。
//   · 路由 handler 直接调（与 whoami-route.test.js 同一套桩）
//   · PM_ROOT / 通道注册表 / 凭证库全部指到临时目录
//   · authorization 服务用**真身**（从装侧 require），保证 begin/commit 语义是真的
//
// 用法：bun scripts/auth-e2e-verify.mjs
// 退出码：0 = 全链路通过；1 = 任一步失败（会打印哪一步）

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "matter-auth-e2e-"))
const CLEANUP = []
function fail(step, detail) {
  console.error(`\n✗ 失败于「${step}」`)
  if (detail) console.error(`  ${detail}`)
  console.error(`\n（隔离根保留在 ${ROOT} 供排查）`)
  process.exit(1)
}
function ok(step, detail) {
  console.log(`✓ ${step}${detail ? ` —— ${detail}` : ""}`)
}

// ── 隔离根：所有落盘都指向临时目录，绝不碰 ~/.dsh-matter ──────────────
process.env.FORGE_PM_ROOT = join(ROOT, "pm")
process.env.FORGE_PM_AGENT_CHANNELS = join(ROOT, "agent-channels.json")
process.env.DSH_HOME = ROOT

const { mkdirSync } = await import("node:fs")
mkdirSync(join(ROOT, "pm", "members"), { recursive: true })

// 造两个 agent 成员（一个 active 一个 suspended，验「只列 active」）
function writeMember(id, name, status) {
  writeFileSync(
    join(ROOT, "pm", "members", `${id}.md`),
    `---\ntype: member\nid: ${id}\nname: ${name}\nmemberType: agent\nstatus: ${status}\nrole: member\nworkRole: coder\nteams: []\n---\n`,
    "utf8",
  )
}
writeMember("MEM-901", "probe-active", "active")
writeMember("MEM-902", "probe-suspended", "suspended")

// ── 加载被测模块（必须在设好 env 之后）────────────────────────────────
const { registerAuthRoutes } = await import("../forge-pm/lib/routes/auth.routes.js")
const flowMod = await import("../forge-pm/lib/auth-flow.js")
const { issueChannel, findChannelByToken } = await import("../forge-pm/lib/agent-channels.js")
const { actorChannel } = await import("../forge-pm/lib/actor.js")

// ── authorization 服务：用装侧真身，保证 begin/commit 语义真实 ──────────
// 装侧路径优先取 3210 实际用的那份（dsh-local），退回 profiles。
async function loadAuthorizationService() {
  const candidates = [
    "<dsh>/node_modules/@deepseek-ai/dsh-authorization/lib/index.js",
    "<home>/.dsh-matter/profiles/node_modules/@deepseek-ai/dsh-authorization/lib/index.js",
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const m = await import(p)
    return m.AuthorizationService || m.default
  }
  return null
}

const AuthorizationService = await loadAuthorizationService()
if (!AuthorizationService) {
  console.error("✗ 找不到 dsh-authorization 装侧包 —— 本脚本无法验真实 seam")
  process.exit(1)
}

// 极简 credentials provider：只为满足 AuthorizationService 的 inject + commit 观察。
// 记录写进临时文件，模拟 $DSH_HOME/.credentials.yaml 的角色。
const CRED_FILE = join(ROOT, "credentials.json")
const credStore = new Map()
const credentials = {
  async readRecord(key) {
    return credStore.get(key)
  },
  async describeRecord(key) {
    return { configured: credStore.has(key), writable: true }
  },
  async modifyRecord(key, mutate) {
    const next = await mutate(credStore.get(key))
    if (next === undefined) credStore.delete(key)
    else credStore.set(key, next)
    writeFileSync(CRED_FILE, JSON.stringify([...credStore], null, 2), "utf8")
    // ★ 必须发这个事件：authorization seam 的 attempt 靠监听 `credentials/record-updated`
    //   来确认「本次 attempt 内真的 commit 了」。不发 ⇒ seam 抛
    //   "resolved without committing a credential record"（本脚本第二版就栽在这）。
    //   真 provider 在 modifyRecord 后正是调 notifyRecordUpdated（credentials-local:570/593）。
    if (app && typeof app.emit === "function") app.emit("credentials/record-updated", key)
    return next
  },
}

// ── 用**真的 cordis Context** 装配（Service 基类要 ctx.reflect.provide 等真接口，
//    手搓桩会在 `new Service()` 里就炸 —— 这正是"隔离验证要用真身"的意思）──
const { Context } = await import("<dsh>/node_modules/@deepseek-ai/cordis/lib/index.js")
const handlers = new Map()

const app = new Context()
// 把我们的 credentials provider 挂成服务（AuthorizationService 声明 inject:['credentials']）
app.provide("credentials", credentials)
// authorization 真身挂上
const authorization = new AuthorizationService(app)
const ctx = app

const ws = {
  register({ path, handler }) {
    handlers.set(path, handler)
    return () => handlers.delete(path)
  },
}

// ★ 顺序与生产一致：先注册 flow，再注册路由（approve 路由 begin 时要能找到它）。
//   漏这一步 ⇒ begin() 报 "no authorization flow is registered" —— 本脚本第一版就漏了，
//   正好证明这个脚本能抓到「接线漏了一半」这类问题。
const registered = flowMod.registerMatterAuthFlow({ ctx })
if (!registered) fail("flow 注册", "registerMatterAuthFlow 返回 false")
// ★ ctx.inject 的回调**不在当前 tick 执行**（实测：同步 false，50ms 后 true）。
//   生产环境里它由 cordis 在服务就绪后调度，所以「注册完立刻 list()」会读到 0。
//   这不是 bug，是 cordis 的语义 —— 但脚本必须等它，否则会误判成"没注册上"。
for (let i = 0; i < 50 && authorization.list().length === 0; i += 1) {
  await new Promise((r) => setTimeout(r, 10))
}
const flowCount = authorization.list().length
if (flowCount !== 1) fail("flow 注册", `期望 1 个 flow，实得 ${flowCount}（inject 回调未执行？）`)
ok("⓪ flow 注册", `${flowCount} 个（key=${authorization.list()[0].key}）`)

registerAuthRoutes({ ctx, ws })

// ── HTTP 桩 ───────────────────────────────────────────────────────────
function mkReq({ method = "GET", url = "/", headers = {}, body = null } = {}) {
  const h = new Map()
  const req = {
    method,
    url,
    headers: { host: "127.0.0.1:3210", ...headers },
    destroy() {},
    on(evt, fn) {
      if (!h.has(evt)) h.set(evt, [])
      h.get(evt).push(fn)
      return req
    },
    off() {
      return req
    },
  }
  queueMicrotask(() => {
    if (body !== null) for (const fn of h.get("data") || []) fn(Buffer.from(JSON.stringify(body)))
    for (const fn of h.get("end") || []) fn()
  })
  return req
}
function mkRes() {
  const res = {
    statusCode: 0,
    body: null,
    setHeader() {},
    end(chunk) {
      if (!chunk) return
      try {
        res.body = JSON.parse(String(chunk))
      } catch {
        res.body = String(chunk)
      }
    },
  }
  Object.defineProperty(res, "status", { get: () => res.statusCode })
  return res
}
async function call(path, opts = {}) {
  // path 可带 query（如 /forge-pm/auth/poll?code=X）；注册表 key 是**不含 query** 的路由路径。
  const routePath = path.split("?")[0]
  const h = handlers.get(routePath)
  if (!h) fail(`路由存在性：${routePath}`, `handler 未注册（已注册：${[...handlers.keys()].join(", ")}）`)
  const res = mkRes()
  await h(mkReq({ ...opts, url: path }), res)
  return res
}

const UI = { origin: "http://127.0.0.1:3210" }

// ══ 链路开始 ══════════════════════════════════════════════════════════

// ① 申请配对码
const r1 = await call("/forge-pm/auth/request", {
  method: "POST",
  headers: UI,
  body: { clientName: "ZCode-e2e", clientVersion: "0.0.1" },
})
if (r1.status !== 200 || !r1.body.code) fail("① request", JSON.stringify(r1.body))
const code = r1.body.code
ok("① 申请配对码", `code=${code} TTL≈${Math.round((r1.body.expiresAt - Date.now()) / 1000)}s`)

// ② 批准前先领一次 → 必须 pending（不能提前给 token）
const r2a = await call(`/forge-pm/auth/poll?code=${code}`)
if (r2a.body.status !== "pending") fail("② poll(批准前)", `期望 pending，实得 ${r2a.body.status}`)
ok("② 批准前 poll", "pending（未提前给 token）")

// ③ 批准（选 active 成员 MEM-901）
const r3 = await call("/forge-pm/auth/approve", {
  method: "POST",
  headers: UI,
  body: { code, memId: "MEM-901" },
})
if (r3.status !== 200) fail("③ approve", `${r3.status} ${JSON.stringify(r3.body)}`)
ok("③ 批准", `member=${JSON.stringify(r3.body.member)}`)

// ④ 领取（一次性）→ 拿到 token
const r4 = await call(`/forge-pm/auth/poll?code=${code}`)
if (r4.body.status !== "approved" || !r4.body.token) fail("④ poll(批准后)", JSON.stringify(r4.body))
const token = r4.body.token
ok("④ 领取 token", `member=${r4.body.member.name}（token 长度 ${token.length}）`)

// ⑤ 再领一次 → 必须 expired（一次性）
const r5 = await call(`/forge-pm/auth/poll?code=${code}`)
if (r5.body.status !== "expired") fail("⑤ 二次领取", `期望 expired，实得 ${r5.body.status}`)
ok("⑤ 二次领取", "expired（一次性成立）")

// ⑥ token 真的能认成成员（鉴权闭环）
const hit = findChannelByToken(token)
if (!hit || hit.memId !== "MEM-901") fail("⑥ 鉴权", `findChannelByToken 回 ${JSON.stringify(hit)}`)
const chan = actorChannel({ headers: { "x-matter-agent-token": token } })
if (chan.via !== "mcp" || chan.actor !== "probe-active") {
  fail("⑥ 鉴权", `actorChannel 回 ${JSON.stringify(chan)}`)
}
ok("⑥ 鉴权闭环", `actor=${chan.actor} via=${chan.via}`)

// ⑦ 明文落进 DSH 凭证库（而不是只在我们内存里）
const stored = await credentials.readRecord("matter/mcp-channel")
if (!stored || stored.kind !== "grant" || stored.payload?.token !== token) {
  fail("⑦ 凭证库", `记录=${JSON.stringify(stored)}`)
}
ok("⑦ DSH 凭证库", `kind=${stored.kind} memId=${stored.payload.memId}`)

// ⑧ 落盘只有 hash（Matter 侧）
const regRaw = readFileSync(process.env.FORGE_PM_AGENT_CHANNELS, "utf8")
if (regRaw.includes(token)) fail("⑧ 落盘", "注册表里出现了 token 明文！")
ok("⑧ 落盘安全", "注册表不含明文（只有 hash）")

// ⑨ 注销后 token 失效
const r9 = await call("/forge-pm/auth/revoke", {
  method: "POST",
  headers: { ...UI, "x-matter-agent-token": token },
  body: {},
})
if (r9.status !== 200) fail("⑨ revoke", `${r9.status} ${JSON.stringify(r9.body)}`)
const after = findChannelByToken(token)
if (after !== null) fail("⑨ revoke", "吊销后 token 仍能查到")
ok("⑨ 注销", "吊销后 token 立即失效")

// ⑩ 成员选项只含 active（suspended 不得被批准）
const options = flowMod.approvableMembers()
if (!options.some((o) => o.id === "MEM-901")) fail("⑩ 成员选项", "缺 active 成员")
if (options.some((o) => o.id === "MEM-902")) fail("⑩ 成员选项", "suspended 成员被列进来了")
ok("⑩ 成员选项", `${options.length} 个 active（suspended 已排除）`)

// ⑪ 身份闸：裸通道不得批准
const r11 = await call("/forge-pm/auth/approve", {
  method: "POST",
  headers: {},
  body: { code: "AAAA-AAAA", memId: "MEM-901" },
})
if (r11.status !== 403) fail("⑪ 身份闸", `期望 403，实得 ${r11.status}`)
ok("⑪ 身份闸", "裸通道批准被拒 403")

console.log("\n══ 全链路通过 ══")
console.log("（本次未碰 3210、未写真实库；隔离根 =", ROOT, "）")
try {
  rmSync(ROOT, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}
process.exit(0)
