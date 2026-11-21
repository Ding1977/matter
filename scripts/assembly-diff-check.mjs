#!/usr/bin/env node
// ISS-579 · B1：装配真相守卫 —— 挂载清单必须现算并与登记表对账
// 背景：本会话内同一份「开发侧挂载数」读出过 15（读错家）/ 13 / 12 三个值 ⇒ 清单是易变读数，
//       只有「现算 + 与登记表比对 + 差异即红」才有牙。判据：
//   A1 生产侧出现登记表白名单之外的自有插件 ⇒ 红（生产保持精简，进生产要单独点头）
//   A2 开发侧出现登记表未登记的额外插件 ⇒ 红（多挂必须写明「未进生产」）
//   A3 登记表里登记的件实际没挂 ⇒ 红（化石）
//   A4 读不到家 / 读不到登记表 ⇒ 明说「不判」，不许当「没有问题」
//   A5 官方包版本代差 ⇒ 只报计数与方向，不判红（App asar 未拆，闭合前不下结论）
// 用法：node scripts/assembly-diff-check.mjs [--selftest] [--write-baseline]
//
// ⚠️ ISS-650（2026-10-24）：本脚本与 `ui-load-contract.mjs` 曾各自写了一份「读挂载清单」的解析器，
//    只认旧形态 `- insert:`。而 dev profile 自 ISS-589 P3 起改为 `dsh.profile.bundles` + 包自带 patch
//    （`grep -c 'insert:'` = 0）⇒ 两份同时恒读 0，于是登记表 11+12 件全被判「化石」，其中
//    forge-pm / forge-ui / forge-model / forge-canvas 此刻正跑在 3210 上。解析器现在只有一处：
//    `assembly-mounts-lib.mjs`（登记单位 = insert 出来的行 id，`^forge-` 前缀 = 自有件）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readMounts, sideDirs, mirrorDir } from "./assembly-mounts-lib.mjs";

const ARGS = process.argv.slice(2);
const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");
const HOME = os.homedir();
const SIDES = sideDirs(); // prod = 桌面 App(19387) · dev = 3210
const BASELINE = path.join(REPO, "scripts/baseline/assembly-whitelist.json");

/** 一侧的挂载清单：读得到（含「读到了但有 bundle 解析不到」）就返回自有件 id 集合，否则 null。 */
function mountedIds(profileDir) {
  const m = readMounts(profileDir);
  return { ids: m.ok ? m.own : null, mounts: m };
}

function officialVersions(mirror) {
  const dir = path.join(mirror, "@deepseek-ai");
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const p of fs.readdirSync(dir)) {
    try { out.set(p, JSON.parse(fs.readFileSync(path.join(dir, p, "package.json"), "utf8")).version); } catch { /* 无 package.json 的跳过 */ }
  }
  return out;
}

function drift() {
  const a = officialVersions(mirrorDir(SIDES.prod));
  const b = officialVersions(mirrorDir(SIDES.dev));
  let same = 0, diff = 0, onlyA = 0, onlyB = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(k)) onlyB++; else if (!b.has(k)) onlyA++; else if (a.get(k) === b.get(k)) same++; else diff++;
  }
  return { same, diff, onlyA, onlyB };
}

function check(baseline, live) {
  const bad = [], note = []; let undecided = false;
  for (const side of ["prod", "dev"]) {
    const ids = live[side];
    if (!ids) { note.push(`${side} 的装配清单读不到（${(live.reasons && live.reasons[side]) || "?"}）⇒ 该侧不判（别当零问题）`); undecided = true; continue; }
    const reg = new Set(baseline[side]);
    const extra = [...ids].filter((x) => !reg.has(x));
    const gone = [...reg].filter((x) => !ids.has(x));
    if (side === "prod" && extra.length) bad.push(`A1 生产侧出现白名单外的插件：${extra.join(", ")}（进生产需老板单独点头）`);
    if (side === "dev") {
      const undeclared = extra.filter((x) => !(baseline.dev_extra || {})[x]);
      if (undeclared.length) bad.push(`A2 开发侧多挂但未登记「未进生产」：${undeclared.join(", ")}`);
      // 占位理由不算理由：否则登记表退化成「默认放过」
      const placeholder = [...ids].filter((x) => { const v = (baseline.dev_extra || {})[x]; return v && /待补|TBD|待填/.test(String(v)); });
      if (placeholder.length) bad.push(`A2b 多挂登记只有占位理由（${placeholder.length} 项）：${placeholder.join(", ")} —— 每项要写凭什么只留在开发盘`);
    }
    if (gone.length) bad.push(`A3 ${side} 登记表里的件实际没挂：${gone.join(", ")}（化石，删登记或挂回去）`);
  }
  const d = live.drift;
  if (d) note.push(`A5 官方包镜像代差：同名一致 ${d.same} · 版本不同 ${d.diff} · 仅生产侧 ${d.onlyA} · 仅开发侧 ${d.onlyB}（App asar 未拆 ⇒ 此项只登记、不计红；闭合前不下「谁旧」的结论）`);
  else { note.push("A5 代差算不出：装侧镜像目录读不到（不影响 A1~A3 判定）"); }
  return { bad, note, undecided };
}

function loadLive() {
  const prod = mountedIds(SIDES.prod);
  const dev = mountedIds(SIDES.dev);
  return {
    prod: prod.ids,
    dev: dev.ids,
    mounts: { prod: prod.mounts, dev: dev.mounts },
    reasons: { prod: prod.mounts.reason, dev: dev.mounts.reason },
    drift: drift(),
  };
}

function selftest() {
  const base = { prod: ["a", "b"], dev: ["a", "b", "c"], dev_extra: { c: "只在开发盘验，未进生产" } };
  let pass = 0, fail = 0;
  const t = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };
  const mk = (o) => ({ prod: o.prod ? new Set(o.prod) : null, dev: o.dev ? new Set(o.dev) : null, drift: { same: 1, diff: 2, onlyA: 0, onlyB: 0 } });
  t("正常态零报", check(base, mk({ prod: ["a", "b"], dev: ["a", "b", "c"] })).bad.length === 0);
  t("A1 生产多挂要报", check(base, mk({ prod: ["a", "b", "z"], dev: ["a", "b", "c"] })).bad.some((b) => b.startsWith("A1")));
  t("A2 开发多挂未登记要报", check(base, mk({ prod: ["a", "b"], dev: ["a", "b", "c", "d"] })).bad.some((b) => b.startsWith("A2")));
  t("A3 登记了却没挂要报（化石）", check(base, mk({ prod: ["a"], dev: ["a", "b", "c"] })).bad.some((b) => b.startsWith("A3")));
  t("A2b 占位理由要报红", check({ prod: ["a", "b"], dev: ["a", "b", "c"], dev_extra: { c: "待补：为什么只在开发盘" } }, mk({ prod: ["a", "b"], dev: ["a", "b", "c"] })).bad.some((b) => b.startsWith("A2b")));
  t("A4 读不到 ⇒ 不判不报红", (() => { const r = check(base, mk({ prod: null, dev: ["a", "b", "c"] })); return r.bad.length === 0 && r.note.some((n) => n.includes("不判")); })());
  console.log(`自检 ${pass}/${pass + fail}`);
  return fail === 0;
}

if (ARGS.includes("--selftest")) process.exit(selftest() ? 0 : 1);

const live = loadLive();
if (ARGS.includes("--write-baseline")) {
  const prev = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};
  // ISS-832：这是「读不到」⇒ 判不了，用本脚本既有的 3（与本文件 L140/L155 同一语义）。
  //   原先用 2 —— 而 2 在本脚本里表「有违规」（L154），同一个码两种意思，读侧无法分辨。
  if (!live.prod || !live.dev) { console.log("✗ 有侧挂载清单读不到 ⇒ 拒绝生成（否则整张登记表被写成空表，A3 从此永远绿）"); process.exit(3); }
  const doc = {
    _note: "装配白名单：由老板裁定「生产保持精简」⇒ 生产侧为白名单，开发侧可多挂但每项须在 dev_extra 里写明「未进生产」。由 --write-baseline 生成，禁止手改。登记单位 = insert 出来的行 id（自有件 = `^forge-`，来自 dsh.profile.bundles 各包自带 patch + profile 覆盖层，解析见 scripts/assembly-mounts-lib.mjs）。",
    prod: (() => {
      // 生成器不许改生产白名单：偷挂一个插件再跑 --write-baseline 就能把自己洗进「精简」名单 ⇒ 拒绝
      const prevProd = (prev && Array.isArray(prev.prod)) ? [...prev.prod].sort() : null;
      const now = [...(live.prod || [])].sort();
      if (!prevProd) return now;                       // 首次建表
      const added = now.filter((x) => !prevProd.includes(x));
      const removed = prevProd.filter((x) => !now.includes(x));
      if (added.length || removed.length) {
        console.log("✗ 生产白名单有出入 ⇒ 生成器**拒绝**覆盖（否则偷挂即洗白）：新增 " + (added.join(",") || "无") + " · 减少 " + (removed.join(",") || "无"));
        console.log("  要改白名单请摘/挂装配行后重跑，或人工编辑本文件并在提交说明里写明老板批准。");
        // ISS-832：生产白名单有出入 ⇒ 生成器拒写。这是「配得不对」（有 added/removed），不是「读不到」⇒ 违规 1。
        process.exit(1);
      }
      return now;
    })(),
    dev: [...(live.dev || [])].sort(),
    dev_extra: Object.fromEntries([...(live.dev || [])].filter((x) => !(live.prod || []).has(x)).map((x) => [x, (prev.dev_extra || {})[x] || "待补：为什么只在开发盘"])),
    commit: safeHead(),
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + "\n");
  console.log("已生成登记表：生产 " + doc.prod.length + " · 开发 " + doc.dev.length + " · 多挂 " + Object.keys(doc.dev_extra).length);
  process.exit(0);
}
function safeHead() { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { return "unknown"; } }

if (!fs.existsSync(BASELINE)) { console.log("✗ 无登记表（先跑 --write-baseline）⇒ **不判**：不判不等于通过（exit 3，体检计入「没在判」）"); process.exit(3); }
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const r = check(baseline, live);
const totalRows = (m) => (m && m.ok ? m.ids.size : 0);
console.log(`挂载现算：生产 ${(live.prod || new Set()).size} · 开发 ${(live.dev || new Set()).size}`
  + `（自有件；全部行：生产 ${totalRows(live.mounts.prod)} · 开发 ${totalRows(live.mounts.dev)}）`
  + ` | 登记基线 commit ${baseline.commit || "?"}`);
// 读到了但有 bundle 解析不到 ⇒ 那一条的 insert 没算进现算，必须出声（否则「化石」判定会误报）
for (const side of ["prod", "dev"]) {
  const m = live.mounts[side];
  if (m && m.ok && m.unresolved.length) console.log(`⚠ ${side} 有 ${m.unresolved.length} 条 bundle 解析不到（其 insert 未计入现算）：${m.unresolved.join(", ")}`);
}
for (const n of r.note) console.log("⚠ " + n);
// 「不判」与「一致」不能同屏：有 note 里带「不判」时绝不打印 ✓
// ISS-832：A3/A5 判到**违规**（化石件 / 清单增删）⇒ 1。原先用 2，与「判不了」撞码。
if (r.bad.length) { for (const b of r.bad) console.log("✗ " + b); console.log("共 " + r.bad.length + " 条"); process.exit(1); }
if (r.undecided) { console.log("!  未判（有侧读不到清单）⇒ 按「没在判」计，不算通过"); process.exit(3); }
console.log("✓ 装配与登记表一致");
process.exit(0);
