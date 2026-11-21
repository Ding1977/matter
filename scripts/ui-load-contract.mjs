#!/usr/bin/env node
// ISS-578 · B0：面板挂载的可判守卫（离线只读；不碰界面、不碰装配文件）
// 三条判据：
//   G1 消费者上电、提供者没上电 ⇒ 报（ISS-569 的装配形状：那一侧所有面板必空）
//   G2（**登记项，不是判据**）注入名单里的非包名项 ⇒ 只列出来给人看；「服务名误写」那一格归 ISS-574
//      （「服务名误写进 inject」那一格归 ISS-574，本守卫不重复立判据）
//   G3 面板注册服务 `forge.surfaces` 已按 ISS-589 退役（各包改直挂官方槽）⇒ **不许再出现提供点**
//      （0 处才对，1 处即红）。口径 = `forge-ui/src/dsh/direct-mount.guard.test.ts:12` 的同一条源码断言，
//      本判据是它在装配侧的投影。⚠️ 旧形态「提供点必须恰好 1 处」退役后恒红（2026-10-24 实测 0 处⇒红），
//      改成「0 处」是**换判据方向**，不是删判据 —— 删了就没人管死灰复燃。
// 用法：node scripts/ui-load-contract.mjs [--selftest] [--repo <dir>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMounts, sideDirs, mirrorDir } from "./assembly-mounts-lib.mjs";

const ARGS = process.argv.slice(2);
const arg = (k, d) => { const i = ARGS.indexOf(k); return i >= 0 ? ARGS[i + 1] : d; };
const SURFACE_SERVICE = "forge.surfaces";
const SIDES = sideDirs();
const MIRRORS = { prod: mirrorDir(SIDES.prod), dev: mirrorDir(SIDES.dev) }; // 按侧取镜像：判生产官方包却看开发侧目录是方向错
// 挂载清单由 `assembly-mounts-lib.mjs` 统一读：本脚本与 assembly-diff-check 曾各写一份「只认 - insert:」的
// 解析器，profile 改成 dsh.profile.bundles 之后双双恒读 0（ISS-650）。

// 剥注释后再匹配代码：注释里的 ctx.provide / ctx.get 会让判据假红（第一版就这么错过）
function stripComments(t) {
  const noBlock = t.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out = [];
  for (const line of noBlock.split("\n")) {
    let cut = -1;
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "/" && line[i + 1] === "/") { cut = i; break; }
    }
    out.push(cut >= 0 ? line.slice(0, cut) : line);
  }
  return out.join("\n");
}

function readDecls(repo) {
  const dirs = fs.readdirSync(repo, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^forge-/.test(e.name)).map((e) => e.name);
  const out = [];
  for (const name of dirs) {
    const pjPath = path.join(repo, name, "package.json");
    if (!fs.existsSync(pjPath)) continue;
    let pj; try { pj = JSON.parse(fs.readFileSync(pjPath, "utf8")); } catch { continue; }
    const inject = new Set((((pj.dsh && pj.dsh.client && pj.dsh.client.inject) || [])).map(String));
    const gets = new Set();
    const provides = new Set();
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (["node_modules", "dist", ".git"].includes(e.name)) continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (!/\.(ts|tsx|js)$/.test(e.name) || /\.test\./.test(e.name)) continue;
        const t = stripComments(fs.readFileSync(f, "utf8"));
        for (const m of t.matchAll(/ctx\.get\(\s*["']([^"']+)["']\s*\)/g)) gets.add(m[1]);
        for (const m of t.matchAll(/ctx\.provide\(\s*["']([^"']+)["']/g)) provides.add(m[1]);
        for (const m of t.matchAll(/export const inject[^=\n]*=\s*\[([^\]]*)\]/g)) {
          for (const raw of m[1].split(",")) {
            const v = raw.trim().replace(/^["']|["']$/g, "");
            if (v) inject.add(v);
          }
        }
      }
    };
    walk(path.join(repo, name, "src"));
    walk(path.join(repo, name, "lib"));
    out.push({ pkg: name, gets, provides, inject, declaredClient: !!(pj.dsh && pj.dsh.client) });
  }
  return out;
}

/**
 * @param {string} repo 仓根（扫 forge-* 源码）
 * @param {{prod: object|null, dev: object|null}} mounts 两侧 `readMounts()` 结果（读不到就传 null）
 */
function check(repo, mounts) {
  const dec = readDecls(repo);
  const providers = dec.filter((d) => d.provides.has(SURFACE_SERVICE)).map((d) => d.pkg);
  const bad = [];
  const note = [];
  const counts = {};
  const allRows = {};

  // G3 退役后方向翻转：提供点必须**为 0**（ISS-589 删了服务实现，各包改直挂官方槽）
  if (providers.length) {
    bad.push("G3 面板注册服务 `" + SURFACE_SERVICE + "` 已退役（ISS-589），代码里不许再出现提供点：命中 " + providers.length + " 处（" + providers.join(", ") + "）⇒ 死灰复燃，与 forge-ui/src/dsh/direct-mount.guard.test.ts 同一口径");
  }
  for (const side of ["prod", "dev"]) {
    const m = mounts[side];
    if (!m || !m.ok) {
      note.push(side + " 挂载清单读不到（" + ((m && m.profileDir) || "?") + ((m && m.reason) ? " · " + m.reason : "") + "）⇒ 该侧不判，别当「没有问题」");
      counts[side] = 0;
      continue;
    }
    const list = m.own;
    counts[side] = list.size;
    allRows[side] = m.ids.size;
    for (const d of dec) {
      if (!list.has(d.pkg)) continue;
      // G1：消费者上电却取用了已退役的服务 ⇒ 提供者不可能在（G3 已把提供点堵死）⇒ 这一侧面板必空
      if (d.gets.has(SURFACE_SERVICE)) {
        bad.push("G1 " + side + " 侧 " + d.pkg + " 上电并取用面板注册服务，但该服务已退役、提供者未在该侧上电 ⇒ 这一侧所有面板必空");
      }
      for (const item of d.inject) {
        if (item.startsWith(".")) continue;
        if (item.startsWith("@")) {
          // 官方 scoped 包：按装侧镜像判存在，不能按「仓内目录」判（否则每条官方依赖都是假红）
          if (!fs.existsSync(path.join(MIRRORS[side] || "", "@deepseek-ai", item.split("/")[1] || ""))) {
            note.push(side + "/" + d.pkg + " 注入名单含官方包「" + item + "」，装侧镜像里找不到 ⇒ 待判（不报红）");
          }
          continue;
        }
        // 非 scoped 且仓内无此目录：可能是服务名误写（那一格归 ISS-574），只报不红
        if (!fs.existsSync(path.join(repo, item))) {
          note.push(side + "/" + d.pkg + " 注入名单含「" + item + "」，仓内无此包目录 ⇒ 疑似服务名误写，归 ISS-574 判，本守卫只登记不报红");
        }
      }
    }
  }
  return { bad, note, providers, counts, allRows };
}

function fixture(root, pkgs) {
  for (const pkg of Object.keys(pkgs)) {
    const spec = pkgs[pkg];
    fs.mkdirSync(path.join(root, pkg, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, pkg, "package.json"), JSON.stringify({
      name: pkg, dsh: { client: { platform: "web", inject: spec.inject || [] } },
    }));
    const lines = ["export const x = 1;"];
    if (spec.get) lines.push('const a = ctx.get("' + spec.get + '");');
    if (spec.provide) lines.push('ctx.provide("' + spec.provide + '", {});');
    if (spec.commentedProvide) lines.push('// 直到别人 ctx.provide("' + spec.commentedProvide + '") 之后才可用');
    fs.writeFileSync(path.join(root, pkg, "src", "client-entry.tsx"), lines.join("\n"));
  }
}

// 自检：坏样本各要能报红 + 正常态零报 + 阳性对照（读得到清单），缺一律不许合
function selftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uilc-"));
  // 夹具挂载清单：形状同 readMounts() 的返回（本判据只用到 ok / own / profileDir）
  const prof = (prod, dev) => ({ prod: { ok: true, own: new Set(prod), ids: new Set(prod), profileDir: "夹具/prod" }, dev: { ok: true, own: new Set(dev), ids: new Set(dev), profileDir: "夹具/dev" } });
  const P = prof(["forge-ui", "forge-pm", "forge-monitor"], ["forge-ui", "forge-pm"]);
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.log("  ✗ " + name); } };
  const fresh = (pkgs) => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); fixture(root, pkgs); };

  // 正常态 = ISS-589 之后的**正形态**：谁都不 provide 面板注册服务，各包直挂官方槽
  fresh({ "forge-ui": {}, "forge-pm": { inject: ["forge-ui"] }, "forge-monitor": { inject: ["forge-ui"] } });
  const ok = check(root, P);
  t("正常态：零违例（无 provide ⇒ G3 绿）", ok.bad.length === 0);
  t("阳性对照：两侧清单读得到", ok.counts.prod === 3 && ok.counts.dev === 2);

  // G3 反向（退役后的唯一方向）：代码里再出现一行 provide("forge.surfaces") ⇒ 必红
  fresh({ "forge-ui": { provide: SURFACE_SERVICE }, "forge-pm": { inject: ["forge-ui"] } });
  const g3 = check(root, P);
  t("G3：出现 provide(\"forge.surfaces\") 必须红", g3.bad.some((b) => b.startsWith("G3")));
  t("G3：红项点名命中的包（看得见是谁死灰复燃）", g3.bad.some((b) => b.includes("forge-ui")));

  // 反向的反面：把那一行拿掉 ⇒ 同一夹具立刻转绿（证明不是恒红）
  fresh({ "forge-ui": {}, "forge-pm": { inject: ["forge-ui"] } });
  t("G3：删掉那行 provide ⇒ 转绿（不是恒红）", check(root, P).bad.length === 0);

  // 注释里的 provide 不算（历史注释很多，误判 = 假红）
  fresh({ "forge-ui": { commentedProvide: SURFACE_SERVICE }, "forge-pm": { inject: ["forge-ui"] } });
  t("G3：注释里的 provide 不算（不假红）", check(root, P).bad.length === 0);

  // G2 归口 ISS-574 之后的期望形状：进 note（登记）但不进 bad（不报红）——用例改判形状，不动判据迁就绿灯
  fresh({ "forge-pm": { get: SURFACE_SERVICE, inject: ["forge-ghost-pkg"] } });
  const g2 = check(root, P);
  t("G2：非包名项要登记在提醒里", g2.note.some((n) => n.includes("forge-ghost-pkg")));
  t("G2：非包名项不报红（避免与 ISS-574 双写判据）", !g2.bad.some((b) => b.startsWith("G2")));
  // 反向控制要真能分辨：这个夹具里 G1 必须**确实红**，而红项里不含 G2（上一版写成 !some(G2) 与 every(!G2) 同式 = 恒真）
  t("反向控制：夹具里 G1 确实红，且红项里没有 G2", g2.bad.some((b) => b.startsWith("G1")) && !g2.bad.some((b) => b.startsWith("G2")));

  // G1：挂着却还在取用已退役服务 ⇒ 必有面板空白（提供点已被 G3 堵死，所以取用即违规）
  fresh({ "forge-pm": { get: SURFACE_SERVICE, inject: ["forge-ui"] } });
  t("G1：上电的消费者取用已退役服务要报", check(root, P).bad.some((b) => b.startsWith("G1")));
  // 该包没挂 ⇒ 不判（没上电就谈不上「这一侧面板必空」）
  t("G1：没挂的消费者不报（不许假红）", check(root, prof(["forge-ui"], ["forge-ui"])).bad.length === 0);

  // 读不到清单 ⇒ 出声「不判」，且不许因此报红
  const unread = check(root, { prod: null, dev: null });
  t("读不到清单 ⇒ 记不判（不报红、也不当通过）", unread.bad.length === 0 && unread.note.some((n) => n.includes("不判")));

  console.log("自检 " + pass + "/" + (pass + fail));
  return fail === 0;
}

if (ARGS.includes("--selftest")) process.exit(selftest() ? 0 : 1);

const repo = arg("--repo", path.resolve(new URL(".", import.meta.url).pathname, "..")); // 仓根 = 脚本所在仓（写死主 checkout 会在工作树里扫别人的代码）
const mounts = { prod: readMounts(SIDES.prod), dev: readMounts(SIDES.dev) };
const r = check(repo, mounts);
console.log("仓库 " + repo);
console.log("挂载数（自有机：insert 出来的行 id）：生产 " + r.counts.prod + " · 开发 " + r.counts.dev
  + " | 全部行数：生产 " + (r.allRows.prod || 0) + " · 开发 " + (r.allRows.dev || 0)
  + " | 面板注册服务提供点：" + (r.providers.join(", ") || "无（已退役，应为无）"));
// 读到了但读不全的，必须出声：@deepseek-ai/* 未装在本机 ⇒ 那一条 bundle 的 insert 没算进去
for (const side of ["prod", "dev"]) {
  const m = mounts[side];
  if (m && m.ok && m.unresolved.length) console.log("⚠ " + side + " 有 " + m.unresolved.length + " 条 bundle 解析不到（其 insert 未计入）：" + m.unresolved.join(", "));
}
for (const n of r.note) console.log("⚠ " + n);
if (!r.bad.length) console.log("✓ 判据零违例（G1 装配一致 / G3 退役服务无提供点）；G2 为登记项，不计红");
else { for (const b of r.bad) console.log("✗ " + b); console.log("共 " + r.bad.length + " 条"); }
process.exit(r.bad.length ? 2 : 0);
