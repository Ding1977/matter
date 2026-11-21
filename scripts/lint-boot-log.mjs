#!/usr/bin/env node
// 启动日志自检（ISS-589 派生物）：把「静默失败」变成门禁能咬的判据
//
// ## 为什么需要它
// 插件加载失败**不报错、不出声**：引擎只在启动日志写一行
//   `forge-xxx (forge-xxx): failed to import`
// 界面少一块，人不知道；`guard-baselines.sh` 也看不见。
// 2026-10-04 实测：我批量改 package.json 时给两个包加了缺 `./` 前缀的 exports，
// 结果 forge-teammate-model / forge-archive 双双静默不激活 —— **清单层判据全绿，实际跑不起来**。
//
// ## 判据
//   B1 最近一次启动段里出现 `failed to import` ⇒ 红（列出包名）
//   B2 最近一次启动段里 `N entries did not activate` 且 N>0 ⇒ 红
//   B3 `skipping profile bundle` / `cannot resolve profile bundle` ⇒ 红（bundle 解析不到）
//   B4 `declares no dsh.bundle` ⇒ 红（声明缺失）
//   B5 日志读不到 ⇒ 明说「不判」（不许当零问题）
//
// ## 「最近一次启动段」怎么定位（关键）
// 不能用 tail N 行 —— 重启间隔内可能有上千行业务日志（forge-pm 轮询就 200+ 行/次）。
// 正解：找**最后一个启动标记**（`dsh web: http://...token=`），只看它之后的行。
//
// 用法：node scripts/lint-boot-log.mjs [--selftest] [--verbose]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ARGS = process.argv.slice(2);
const LOGS = [
  { name: "matter(3210 · dev)", file: path.join(os.homedir(), ".dsh-matter", "matter.log") },
  { name: "dsh(App · prod)", file: path.join(os.homedir(), ".dsh", "dsh-desktop-agent.log") },
];
// 启动标记：web 盘用 token URL；App 盘用它的等价标记
const BOOT_MARKERS = [/dsh web: http/, /dsh app: http/, /runtime listening/i];

const PATTERNS = [
  { id: "B1", re: /^(.+?) \((.+?)\): failed to import$/m, why: "插件 import 失败（该包整个不激活）" },
  { id: "B2", re: /warning: (\d+) entr(?:y|ies) did not activate/g, why: "有 entry 未激活" },
  { id: "B3", re: /skipping profile bundle "([^"]+)"/g, why: "bundle 解析不到，被静默跳过" },
  { id: "B4", re: /declares no dsh\.bundle/g, why: "包缺 dsh.bundle 声明" },
];

/** 取日志里**最后一次启动**之后的内容；找不到标记则返回 null（⇒ 不判，不当零问题）。 */
function lastBootSection(text) {
  let idx = -1;
  for (const m of BOOT_MARKERS) {
    const re = new RegExp(m.source, "g");
    let hit;
    while ((hit = re.exec(text)) !== null) idx = Math.max(idx, hit.index);
  }
  return idx < 0 ? null : text.slice(idx);
}

function check(file) {
  if (!fs.existsSync(file)) return { undecided: true };
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { undecided: true }; }
  const section = lastBootSection(text);
  if (section === null) return { undecided: true };
  const bad = [];
  for (const p of PATTERNS) {
    if (p.id === "B2") {
      let m; const re = new RegExp(p.re.source, "g");
      let total = 0;
      while ((m = re.exec(section)) !== null) total += Number(m[1]);
      if (total > 0) bad.push(`${p.id} ${p.why}：${total} 个`);
      continue;
    }
    const re = new RegExp(p.re.source, "gm");
    const hits = [...section.matchAll(re)].map((x) => x[1] ?? "").filter(Boolean);
    if (hits.length) bad.push(`${p.id} ${p.why}：${[...new Set(hits)].join(", ")}`);
  }
  return { bad };
}

function selftest() {
  let pass = 0, fail = 0;
  const t = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

  const boot = "dsh web: http://127.0.0.1:3210/?token=x\n";
  // 正样本：干净启动
  const clean = boot + "[forge-pm] host ready\n[forge-pm] poll\n";
  t("干净启动不报", (() => { const s = lastBootSection(clean); return !/failed to import/.test(s ?? ""); })());

  // 反样本 1：failed to import
  const f1 = boot + "forge-a (forge-a): failed to import\n";
  t("failed to import 抓得到", /failed to import/.test(lastBootSection(f1) ?? ""));

  // 反样本 2：did not activate
  const f2 = boot + "dsh: warning: 2 entries did not activate\n";
  t("did not activate 抓得到", /entries did not activate/.test(lastBootSection(f2) ?? ""));

  // 反样本 3：skipping profile bundle
  const f3 = boot + 'dsh: skipping profile bundle "forge-b": cannot resolve\n';
  t("skipping bundle 抓得到", /skipping profile bundle/.test(lastBootSection(f3) ?? ""));

  // **关键**：旧启动的失败不许报（只看最后一次启动之后）
  const old = "dsh web: http://a/?token=1\nforge-x (forge-x): failed to import\n" + boot + "[forge-pm] ok\n";
  t("旧启动的失败不报（只看最后一段）", !/failed to import/.test(lastBootSection(old) ?? ""));

  // 但同一段里的失败要报
  const same = boot + "forge-x (forge-x): failed to import\n" + boot + "";
  t("最后一段为空时不报旧的", !/failed to import/.test(lastBootSection(same) ?? ""));

  // 无启动标记 ⇒ 不判（不当零问题）
  t("无启动标记 ⇒ 不判", lastBootSection("随便一段日志\n") === null);

  console.log(`  selftest: ${pass} 过 / ${fail} 不过`);
  return fail === 0;
}

if (ARGS.includes("--selftest")) process.exit(selftest() ? 0 : 1);

let anyBad = 0, anyUndecided = 0;
for (const { name, file } of LOGS) {
  const r = check(file);
  if (r.undecided) {
    console.log(`· ${name}：日志读不到或无启动标记 ⇒ **不判**（别当零问题）`);
    anyUndecided++;
    continue;
  }
  if (r.bad.length) {
    console.log(`✗ ${name}`);
    for (const b of r.bad) console.log(`    ${b}`);
    anyBad += r.bad.length;
  } else {
    console.log(`✓ ${name}：最近一次启动无静默失败`);
  }
}
if (anyBad) console.log(`\n共 ${anyBad} 条启动失败（这类失败只在日志里，界面无感）`);
process.exit(anyBad ? 1 : 0);
