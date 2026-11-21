// PM v2 存量迁移与对账 CLI（ISS-595 · DOC-258 §3.3.6 migrate-phase1）
//
// 为什么是命令行而不是开机自动跑：开机导入 = 在「3210 正在被人用」的时候批量写库 + 扫 600 个文件，
// 出问题时没人知道是哪一步；这件事要**看得见结果再决定下一步**，所以给人一条命令、一份 JSON 报告。
// 幂等由 activity_log.uid 唯一键保证（见 pm-store DDL_V5）：dry-run 完再正式跑、跑一半中断重来，
// 都不会长出第二行。
//
// 用法（库路径 = 数据根的父目录下的 forge-pm.db；用 FORGE_PM_ROOT 换数据根，库跟着走，
// 所以测试与演练天然不碰 ~/.dsh）：
//   node scripts/pm-v2-migrate.mjs --import-activity --dry-run   先看会动多少
//   node scripts/pm-v2-migrate.mjs --import-activity             正式导入存量活动
//   node scripts/pm-v2-migrate.mjs --import-queue                队列读模型补存量
//   node scripts/pm-v2-migrate.mjs --refresh-known               词表变化后重算 known 三态
//   node scripts/pm-v2-migrate.mjs --reconcile                  md ⇄ 库逐实体对账（只读）
//   node scripts/pm-v2-migrate.mjs --stale-queue                僵尸派单盘点（只读）
//   node scripts/pm-v2-migrate.mjs --all                        上面三条一起跑
// ⚠️ 本文件是 host 侧 `.mjs` —— 严禁 TS 类型注解（Bun/node 直跑）。
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const REPO = process.env.DSH_FORGE_REPO || dirname(dirname(fileURLToPath(import.meta.url)))

const arg = process.argv.slice(2)
// 不认识的参数必须报错，不能静默跑完还回 ok:true —— 「命令跑了但什么都没做」是排查成本最高的一类，
// 实测就是这么踩的：`--help` 并不存在，却拿到一份看起来正常的 JSON。
const KNOWN_FLAGS = ["--import-activity", "--import-queue", "--refresh-known", "--reconcile", "--stale-queue", "--all", "--dry-run", "--git-head"]
const unknownFlag = arg.find((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a) && !a.startsWith("--entity="))
if (unknownFlag || arg.length === 0) {
  console.error(`未知或空缺的参数：${unknownFlag || "(没给参数)"}\n可用：${KNOWN_FLAGS.join(" ")}（--entity=<前缀> 可限定导入范围）`)
  process.exit(1)
}
const has = (f) => arg.includes(f)
const valOf = (name) => {
  const eq = arg.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.split("=").slice(1).join("=") : ""
}

const pm = await import(join(REPO, "forge-pm/lib/pm-store.js"))
const mg = await import(join(REPO, "forge-pm/lib/migrate-pm.js"))
const mr = await import(join(REPO, "forge-pm/lib/member-registry.js"))
const qs = await import(join(REPO, "forge-pm/lib/queue-store.js"))
const rebuildQueue = qs.rebuildFromMd

const store = await pm.openStore()
if (!store) {
  console.error(JSON.stringify({ ok: false, error: "pm-store 打不开（node:sqlite 不可用？路径不可写？）", dbPath: pm.dbPath() }))
  process.exit(3)
}

const out = { ok: true, dbPath: pm.dbPath(), schema: pm.schemaVersion(store.db) }

/** 活着的 Run 集合（判僵尸用）；拿不到 agents 侧就明说，不假装"没有活着的"。 */
async function liveRuns() {
  try {
    const agentsRoot = process.env.FORGE_AGENTS_ROOT || join(process.env.HOME || "", ".dsh", "agent-runs")
    const rm = await import(join(REPO, "forge-agents/lib/run-manager.js"))
    const runs = rm.listRuns({ status: "running" })
    return { ids: runs.map((r) => r.id || r.runId).filter(Boolean), source: agentsRoot }
  } catch (err) {
    return { ids: null, error: String(err?.message || err) }
  }
}

if (has("--import-activity")) {
  out.import = mg.importActivity(store, { dryRun: has("--dry-run"), entityPrefix: valOf("entity") || undefined })
}

if (has("--import-queue")) {
  // 队列读模型同样要补存量：新写入才进表的话，幂等锁看不见历史在途、调度体检也看不见僵尸
  out.importQueue = rebuildQueue(store, mr.listQueue({}))
}

if (has("--refresh-known")) {
  // 词表变过（补充或改名）后重算 known 标记 —— 不必清库重导
  out.refreshKnown = pm.refreshKnownFlags(store)
}

if (has("--reconcile") || has("--all")) {
  out.reconcile = mg.reconcileActivity(store)
  out.queue = mg.reconcileQueue(store, mr.listQueue({}))
  // 全量搜索索引顺手重建（同一个工具跑一次，免得两条命令之间状态互相甩锅）
  // ISS-788：清单来源换成域声明（`pm-domains.js`），不再用 `scan()`——后者是"列表面吃哪四域"，
  // 用它喂索引就把 documents/memos 全丢了，且 rebuild 清表会把写入钩子收录的行删掉（ISS-806）。
  try {
    const sx = await import(join(REPO, "forge-pm/lib/search-index.js"))
    const md = await import(join(REPO, "forge-pm/lib/md-store.js"))
    const { rels, blocked } = md.searchableEntityRels()
    out.search = { ...sx.rebuildAll(store, rels), blocked: blocked.length }
  } catch (err) {
    out.search = { error: String(err?.message || err) }
  }
}

if (has("--stale-queue") || has("--all")) {
  const lr = await liveRuns()
  if (lr.ids === null) out.staleQueue = { unavailable: true, reason: `取不到在跑的 Run：${lr.error}` }
  else out.staleQueue = mg.staleDispatched(store, { liveRunIds: lr.ids })
}

if (has("--git-head")) {
  try {
    out.head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim()
  } catch {
    out.head = null
  }
}

pm.closeStore(store)
console.log(JSON.stringify(out, null, 2))
// 对账不平就非零退出：CI/脚本能接住，人也一眼看出「还没完」
if (out.reconcile && !out.reconcile.consistent) process.exit(2)
