#!/usr/bin/env node
// A0 蒸馏样片：抽取单个 session.jsonl.zstd 的骨架材料包（不读全文）
// 用法: node scripts/distill-material.mjs <session-dir> [--out file.md]
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as dshSession from "<dsh>/node_modules/@deepseek-ai/dsh-session/lib/index.js";

/** 本脚本解析的是逐行 JSON（实测 v3 拼接解码后仍是逐行合法 JSON），世代门槛只用于选文件。 */
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

const dir = process.argv[2];
if (!dir) { console.error("usage: distill-material.mjs <session-dir>"); process.exit(1); }
const { best, newer } = pickSessionLog(readdirSync(dir), MAX_GEN);
if (!best) {
  console.error(`no readable session log in ${dir} (MAX_GEN=v${MAX_GEN}${newer ? `, 有 ${newer} 个更新的世代被跳过` : ""})`);
  process.exit(1);
}
if (newer) console.error(`注意：另有 ${newer} 个更新世代的日志（> v${MAX_GEN}）被跳过。`);
const logPath = best.name;
const file = path.join(dir, logPath);
const raw = logPath.endsWith(".zstd")
  ? execFileSync("zstd", ["-dc", file], { maxBuffer: 512 * 1024 * 1024 }).toString()
  : readFileSync(file, "utf8");

const textOf = (content) => Array.isArray(content)
  ? content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
  : (typeof content === "string" ? content : "");

let header = null, titles = [], users = [], assistants = [], compactions = [], errors = [];
const filesHit = new Map(); // path -> count
const toolCount = new Map();
let seqCount = 0, firstTime = null, lastTime = null;

for (const line of raw.split("\n")) {
  if (!line) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  seqCount++;
  if (typeof e.time === "number") {
    if (firstTime == null) firstTime = e.time;
    lastTime = e.time;
  }
  switch (e.type) {
    case "session": header = e; break;
    case "session/title": titles.push(e.data?.title || ""); break;
    case "user/message": {
      let t = textOf(e.data?.content);
      // 去掉注入块（AGENTS.md/runtime context/系统通知），只留老板真实输入
      t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      if (/^(Current runtime context|Background (subagent|agent)|# DeepSeek Harness)/.test(t)) t = "";
      if (t && e.data?.source?.kind !== "system") users.push({ seq: e.seq, time: e.time, text: t });
      break;
    }
    case "assistant/message": {
      const t = textOf(e.data?.message?.content);
      if (t) assistants.push({ seq: e.seq, text: t });
      break;
    }
    case "compaction/summary":
      compactions.push({ seq: e.seq, time: e.time, text: (e.data?.summary || []).map((s) => s.text || "").join("\n"), shadowed: e.data?.shadowedTokenCount || 0 });
      break;
    case "tool/call": {
      const name = e.data?.name || "?";
      toolCount.set(name, (toolCount.get(name) || 0) + 1);
      let args = e.data?.arguments ?? e.data?.args ?? e.data?.input;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
      if (args && typeof args === "object") {
        for (const k of ["file_path", "path", "filePath"]) {
          if (typeof args[k] === "string") filesHit.set(args[k], (filesHit.get(args[k]) || 0) + 1);
        }
      }
      break;
    }
  }
}

const fmt = (ts) => ts ? new Date(ts).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }) : "?";
const clip = (s, n) => s.length > n ? s.slice(0, n) + `\n…[clipped ${s.length - n} chars]` : s;

// 引用到的 PM 实体
const allUserText = users.map((u) => u.text).join("\n");
const refs = [...new Set((allUserText.match(/(ISS|DOC|PRJ|REV|INI|MEM)-\d+/g) || []))];

const topFiles = [...filesHit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
const topTools = [...toolCount.entries()].sort((a, b) => b[1] - a[1]);

const out = [];
out.push(`# 材料包 · ${path.basename(dir)}`);
out.push(`- 标题: ${titles[titles.length - 1] || "(无)"}`);
out.push(`- 创建: ${fmt(header?.createdAt)}  活动区间: ${fmt(firstTime)} → ${fmt(lastTime)}`);
out.push(`- cwd: ${header?.cwd}  origin: ${header?.origin || "main"}  parent: ${header?.parentSession || "-"}  preset: ${header?.agentPreset || "-"}`);
out.push(`- 事件数: ${seqCount}  用户消息: ${users.length}  助手消息: ${assistants.length}  compaction: ${compactions.length}  工具调用: ${[...toolCount.values()].reduce((a, b) => a + b, 0)}`);
out.push(`- 提到的 PM 实体: ${refs.join(", ") || "-"}`);
out.push(`\n## 工具使用\n${topTools.map(([t, n]) => `${t}×${n}`).join("  ")}`);
out.push(`\n## 文件足迹 (top ${topFiles.length})\n${topFiles.map(([f, n]) => `${n}× ${f.replace(/^\/Users\/dylan\//, "~/")}`).join("\n")}`);
out.push(`\n## 用户消息（${compactions.length ? "有 compaction：前3 + 后3" : "无 compaction：全部保留作骨架"}，各截 800 字）`);
const pick = compactions.length ? (users.length <= 6 ? users : [...users.slice(0, 3), ...users.slice(-3)]) : users.slice(0, 18);
for (const u of pick) out.push(`\n> [seq ${u.seq} · ${fmt(u.time)}] ${clip(u.text.replace(/\n+/g, " ⏎ "), 800)}`);
if (compactions.length) {
  out.push(`\n## Compaction 摘要（共 ${compactions.length} 条，取最早+最新全文）`);
  const cs = compactions.length === 1 ? compactions : [compactions[0], compactions[compactions.length - 1]];
  for (const c of cs) out.push(`\n### [seq ${c.seq} · ${fmt(c.time)} · 压掉 ${c.shadowed} tokens]\n${c.text}`);
} else {
  out.push(`\n## Compaction 摘要: 无`);
}
out.push(`\n## 最后 3 条助手消息（各截 1200 字）`);
for (const a of assistants.slice(-3)) out.push(`\n> [seq ${a.seq}] ${clip(a.text, 1200)}`);

const md = out.join("\n");
const outArg = process.argv.indexOf("--out");
if (outArg > -1 && process.argv[outArg + 1]) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.argv[outArg + 1], md);
  console.log(`written: ${process.argv[outArg + 1]} (${md.length} chars)`);
} else {
  console.log(md);
}
