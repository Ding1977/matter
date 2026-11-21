// 用 dsh 自己的 readZstdPrefix 逐个验证会话文件（完整复刻 torn 判定）
// ISS-338：会话日志自 0.1.5 起按世代命名（`session.vN.jsonl.zstd`）。本脚本用**运行时引擎自带**
// 的后端读日志，故按 `dsh-session` 的 `SESSION_FORMAT_VERSION` 自适应世代：
//   A=0.1.2 → 版本 0，只查 v0（并显式报出被跳过的 vN 数量，不再静默漏项）
//   A=0.1.5 → 版本 3，自动改查 v3（无需改本脚本）
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import JsonlSessionPersistence from "<dsh>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js";
import * as dshSession from "<dsh>/node_modules/@deepseek-ai/dsh-session/lib/index.js";

const MAX_GEN = Number(dshSession.SESSION_FORMAT_VERSION ?? 0);


/**
 * 会话日志文件名 → 世代号（ISS-338 · DOC-223 §2-④）。官方命名：`session.jsonl.zstd` = v0，
 * `session.vN.jsonl.zstd` = vN（0.1.5-rc.2 起写 v3；迁移保留原 v0 → 可能两代并存）。
 * ⚠️ 同步点（三处逻辑必须一致）：`forge-ui/lib/plans-usage.js` ·
 *    `scripts/scan-sessions-health.mjs` · `scripts/distill-material.mjs`。
 */
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/
/** 从目录项名里挑出**不超过 maxGen** 的最高代日志；同代优先 `.zstd`。 */
function pickSessionLog(names, maxGen = Infinity) {
  let best = null
  let newer = 0
  for (const name of names) {
    const m = SESSION_LOG_RE.exec(name)
    if (!m) continue
    const generation = m[1] ? Number(m[1]) : 0
    if (generation > maxGen) { newer++; continue }
    const compressed = Boolean(m[2])
    if (best === null || generation > best.generation ||
        (generation === best.generation && compressed && !best.compressed)) {
      best = { name, generation, compressed }
    }
  }
  return { best, newer }
}

// ⚠️ ISS-522：认 `DSH_HOME`（原先写死 `$HOME/.dsh` ⇒ 隔离实例/副引擎上跑它会去扫**生产**会话，
//   报出来的健康度属于别人）。与包内 `shared/paths.js` 同一条取值规则。
const ROOT = (process.env.DSH_HOME || process.env.HOME + "/.dsh") + "/sessions";

// 极简 ctx：readZstdPrefix 只用 this.compression，构造里 super(ctx) 需要 ctx
// 用 Object.create 绕过构造，直接设 compression 字段
const fake = Object.create(JsonlSessionPersistence.prototype);
fake.compression = "zstd";
fake.root = ROOT;
// readZstdPrefix 内部用 this.compression? 看代码：readZstdPrefix 没用 this.compression（用 scanZstdFrames）
// 但保险起见设上；scheduler.yield 在异步分支，Node 24 有 scheduler 全局

const projects = (await readdir(ROOT, { withFileTypes: true })).filter((d) => d.isDirectory());
let clean = 0, bad = [], skippedNewer = 0;
for (const proj of projects) {
  const entries = await readdir(join(ROOT, proj.name), { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let names;
    try { names = await readdir(join(ROOT, proj.name, e.name)); }
    catch { continue; }
    const { best, newer } = pickSessionLog(names, MAX_GEN);
    if (newer) skippedNewer += newer;
    if (!best) continue;
    const file = join(ROOT, proj.name, e.name, best.name);
    let buf;
    try { buf = await readFile(file); }
    catch { continue; }
    try {
      const r = await fake.readZstdPrefix(buf);
      clean++;
    } catch (err) {
      bad.push({ proj: proj.name, sess: e.name, file, error: err.message });
    }
  }
}
console.log(`CLEAN=${clean} BAD=${bad.length} SKIPPED_NEWER_GEN=${skippedNewer} (MAX_GEN=${MAX_GEN})`);
if (skippedNewer) console.log(`注意：有 ${skippedNewer} 个日志的世代高于本引擎可读的 v${MAX_GEN}，已跳过（升级引擎后本脚本自动覆盖）。`);
for (const b of bad.slice(0, 40)) console.log(`BAD: ${b.sess} [${b.proj}]\n     ${b.error}`);
