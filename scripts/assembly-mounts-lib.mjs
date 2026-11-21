// 装配挂载清单的**唯一**读者（ISS-650 · 尺子 C）
//
// 为什么单独立一份：`ui-load-contract.mjs` 与 `assembly-diff-check.mjs` 各写了一遍
// 「读 profile 里挂了哪些件」，只认旧形态 `- insert:`。而 dev profile 从 ISS-589 P3
// 起已改成 `dsh.profile.bundles` + 包自带 patch（`~/.dsh-matter/profiles/web/`
// 里 `grep -c 'insert:'` = 0）⇒ 两份解析器同时恒读 0：ui-load-contract 报「G3 提供点 0 处」，
// assembly-diff-check 报「登记表 11+12 件全是化石」，而 3210 上实际在跑十几件。
// 抄两份的代价不止是修两次，还会**第二次漂移**（ISS-757 在装配锚点上踩过同一个坑）。
//
// 真实形态（`cordis.yml` 头注 + profile `package.json` 的 `dsh.profile` 原文）：
//   树 = [dsh.profile.bundles 里**每个包**自带的 patch] → profile 的 cordis.patch.yml
//        → home 级 patch → --patch 覆盖层
// 每包的 patch 文件默认 `cordis.patch.yml`，可由该包 `package.json` 的 `dsh.bundle.patch` 改名。
// 「挂了哪些件」= 这些 patch 里 `- insert:` 块内各个 `- id:` 的并集（`disabled: true` 的不算）。
//
// 口径（写在这里，免得两侧各算一套）：
//   · 只认 insert 块内的 id。顶层 `- id: X` + `config:` 是**覆盖已有行**，不是新挂（dev 盘的
//     forge-agents / forge-model-limits 就是这种形态：insert 来自包自带 patch，profile 只留 config）。
//   · 整行注释先剥掉：两个 profile 的 patch 里都留着大量「已摘除的历史挂载」注释，
//     不剥就会把退役件读成在挂（旧形态的教训）。
//   · 包解析顺序 = profile 私有 node_modules → `<home>/profiles/node_modules` 共享镜像
//     （引擎的解析顺序同此，见 `docs/dsh-wiki/04-subsystems/boot-and-assembly.md`）。
//     两侧都没有 = `unresolved`，由调用方出声（**不静默当 0**）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 自有插件的 id 前缀。白名单口径 = 自有件（官方 `@deepseek-ai/*` 行与第三方行不计）。 */
const OWN_RE = /^forge-/;
const DEFAULT_PATCH = "cordis.patch.yml";

/**
 * 两侧 profile 目录（`home` 可传，自测跑在临时家上）。
 * @param {string} [home] 引擎根，缺省 `os.homedir()`
 * @returns {{prod: string, dev: string}} prod = 桌面 App（19387）· dev = 3210
 */
export function sideDirs(home = os.homedir()) {
  return { prod: path.join(home, ".dsh/profiles/desktop"), dev: path.join(home, ".dsh-matter/profiles/web") };
}

/** 共享镜像目录（`<home>/profiles/node_modules`）：profile 私有层解析不到时的兜底。 */
export function mirrorDir(profileDir) {
  return path.join(profileDir, "..", "node_modules");
}

const isCommentLine = (line) => /^\s*#/.test(line);
const indentWidth = (line) => line.match(/^\s*/)[0].length;

/**
 * 找出一段 patch 文本里所有 `- insert:` 块的行号区间。
 * @returns {{start: number, end: number, indent: number}[]} start/end 为块内容行号（左闭右开）
 */
function insertBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s*insert:\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    let j = i + 1;
    while (j < lines.length) {
      if (!lines[j].trim() || isCommentLine(lines[j])) { j++; continue; }
      if (indentWidth(lines[j]) <= indent) break;
      j++;
    }
    blocks.push({ start: i + 1, end: j, indent });
    i = j - 1;
  }
  return blocks;
}

/**
 * 读一段 patch 文本里 insert 出来的行 id。
 * @param {string} text patch 文件内容
 * @param {{file?: string, origin?: string}} [meta] file = 路径（报错用）· origin = 来源标签（如包名 / "profile"）
 * @returns {{id: string, file: string, origin: string, line: number, disabled: boolean}[]}
 */
function parseInsertIds(text, meta = {}) {
  const file = meta.file || "";
  const origin = meta.origin || "";
  const lines = text.split("\n");
  const rows = [];
  for (const block of insertBlocks(lines)) {
    let itemIndent = -1;
    let cur = null;
    for (let i = block.start; i < block.end; i++) {
      const line = lines[i];
      if (!line.trim() || isCommentLine(line)) continue;
      const ind = indentWidth(line);
      if (/^\s*-\s/.test(line) && (itemIndent < 0 || ind === itemIndent)) {
        if (itemIndent < 0) itemIndent = ind;
        cur = null;
        const m = line.match(/^\s*-\s*id:\s*(["']?)([^"'\s]+)\1\s*$/);
        if (m) {
          cur = { id: m[2], file, origin, line: i + 1, disabled: false };
          rows.push(cur);
        }
        continue;
      }
      // 条目体内的 `disabled: true`（与 id 同层）⇒ 这一行没上电，不算挂载
      if (cur && itemIndent >= 0 && ind === itemIndent + 2 && /^disabled:\s*true\b/.test(line.trim())) cur.disabled = true;
    }
  }
  return rows;
}

/** 解析一个包自带的 patch 路径（`package.json` 的 `dsh.bundle.patch` 可改名）。 */
function patchOfPkg(pkgDir) {
  const pjPath = path.join(pkgDir, "package.json");
  let pj = null;
  try { pj = JSON.parse(fs.readFileSync(pjPath, "utf8")); } catch { return null; }
  const declared = pj && pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch;
  return path.resolve(pkgDir, typeof declared === "string" && declared ? declared : DEFAULT_PATCH);
}

/**
 * 读一侧 profile 的挂载清单。
 * @param {string} profileDir profile 目录（含 package.json / cordis.patch.yml / node_modules）
 * @returns {{
 *   profileDir: string, ok: boolean, reason: string, bundles: string[],
 *   ids: Set<string>, own: Set<string>,
 *   rows: {id: string, file: string, origin: string, line: number, disabled: boolean, side: "bundle"|"profile"}[],
 *   disabled: string[], unresolved: string[], noPatch: string[]
 * }}
 *   ok=false ⇒ 读不到 profile 本身（调用方必须出声「不判」，不许当 0）
 */
export function readMounts(profileDir) {
  const out = {
    profileDir, ok: false, reason: "", bundles: [], ids: new Set(), own: new Set(),
    rows: [], disabled: [], unresolved: [], noPatch: [],
  };
  const pjPath = path.join(profileDir, "package.json");
  if (!fs.existsSync(pjPath)) { out.reason = "无 package.json：" + pjPath; return out; }
  let pj;
  try { pj = JSON.parse(fs.readFileSync(pjPath, "utf8")); } catch (e) {
    out.reason = "package.json 解析失败：" + pjPath + "（" + (e && e.message) + "）";
    return out;
  }
  out.ok = true;
  const bundles = pj && pj.dsh && pj.dsh.profile && pj.dsh.profile.bundles;
  out.bundles = Array.isArray(bundles) ? bundles.map(String) : [];

  const add = (rows, side) => {
    for (const r of rows) {
      out.rows.push({ ...r, side });
      if (r.disabled) { out.disabled.push(r.id); continue; }
      out.ids.add(r.id);
      if (OWN_RE.test(r.id)) out.own.add(r.id);
    }
  };

  // ① 每个 bundle 自带的 patch
  const roots = [path.join(profileDir, "node_modules"), mirrorDir(profileDir)];
  for (const name of out.bundles) {
    const pkgDir = roots.map((r) => path.join(r, name)).find((p) => fs.existsSync(path.join(p, "package.json")));
    if (!pkgDir) { out.unresolved.push(name); continue; }
    const patch = patchOfPkg(pkgDir);
    if (!patch || !fs.existsSync(patch)) { out.noPatch.push(name); continue; }
    add(parseInsertIds(fs.readFileSync(patch, "utf8"), { file: patch, origin: name }), "bundle");
  }

  // ② profile 自己的覆盖层（dev 盘已不含手写 insert，prod 盘只剩注释；仍读，防回退）
  const ownPatch = path.join(profileDir, DEFAULT_PATCH);
  if (fs.existsSync(ownPatch)) {
    add(parseInsertIds(fs.readFileSync(ownPatch, "utf8"), { file: ownPatch, origin: "profile" }), "profile");
  }

  // ③ home 级 patch（监听列表第二处：`<home>/cordis.patch.yml`；2026-10 实测建文件即挂载）
  //    本仓现状 = 只 insert agent preset（非自有件），但「自有件也能从这里挂」这条能力是真的，
  //    不读就等于把一条装配通路排除在守卫之外。
  const homePatch = path.join(profileDir, "..", "..", DEFAULT_PATCH);
  if (fs.existsSync(homePatch)) {
    add(parseInsertIds(fs.readFileSync(homePatch, "utf8"), { file: homePatch, origin: "home" }), "home");
  }
  return out;
}

/**
 * 判据自检（本文件自己的 CLI：`node scripts/assembly-mounts-lib.mjs --selftest`）。
 * 为什么解析器要有自己的牙：它坏掉的样子是**静默恒 0**（ISS-650：两个门禁同时读 0，一个报「提供点 0 处」、
 * 另一个把 11+12 件在跑的插件判成化石），而真实 profile 天天在变、不能拿来当夹具。
 * 所以这里用临时目录造**形态**，把 parser 的契约逐条钉住（该算的算、不该算的不算、读不到要出声）。
 * ⚠️ 自检 fixture 一律用 `__fx_` 前缀：全仓字符串池会把本文本算进去（同 dead-exports-lib 的纪律）。
 */
function selftestMounts() {
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.log("  ✗ " + name); } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "__fx_mounts-"));
  const write = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  // profile 目录一律造成 `<home>/profiles/<name>` 形状：readMounts 靠 "../.." 找 home 级 patch，
  // 摊平造夹具会让「home 层」串到别的用例上（第一版就这么错，被 ⑧ 抓到）。
  const mkProfile = (home, bundles) => {
    const dir = path.join(home, "profiles", "web");
    write(path.join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles } } }));
    return path.join(root, dir);   // 绝对路径：readMounts 拿到相对路径会按 cwd 解析 ⇒ 假「读不到」
  };

  // ① 基本形态：insert 块内两条 ⇒ 两条都算；块外的顶层 `- id: x` + config 是**覆盖**，不算挂载
  const ids1 = parseInsertIds([
    "- insert:",
    "    - id: __fx_a",
    "      name: __fx_a",
    "    - id: \"__fx_b\"",
    "      name: __fx_b",
    "- id: __fx_override",
    "  name: __fx_override",
    "  config:",
    "    k: v",
  ].join("\n"), { origin: "__fx" });
  t("insert 块内两条都算 · 块外覆盖行不算", ids1.length === 2 && ids1.map((r) => r.id).join(",") === "__fx_a,__fx_b");

  // ② 整行注释不算（profile 里大量「已摘除的历史挂载」以 # 留存）；条目体内夹注释不影响后续条目
  const ids2 = parseInsertIds([
    "- insert:",
    "  # - id: __fx_gone",
    "    - id: __fx_keep",
    "      # 这条名字待定",
    "      name: __fx_keep",
    "    # - id: __fx_also_gone",
  ].join("\n"));
  t("注释掉的历史挂载不算 · 条目体内注释不吞下一条", ids2.length === 1 && ids2[0].id === "__fx_keep");

  // ③ disabled 的行没上电 ⇒ 不算挂载，但要单独露出来（不许静默）
  const ids3 = parseInsertIds([
    "- insert:",
    "    - id: __fx_off",
    "      disabled: true",
    "    - id: __fx_on",
  ].join("\n"));
  t("disabled 的 insert 不算挂载，但被登记", ids3.length === 2 && ids3[0].disabled === true && ids3[1].disabled === false);

  // ④ 行号如实（报错时能指到那一行）
  const ids4 = parseInsertIds(["# x", "- insert:", "    - id: __fx_line"].join("\n"));
  t("行号 = 文件内 1-based 行号", ids4.length === 1 && ids4[0].line === 3);

  // ⑤ bundle 自带 patch 的路径可由 `dsh.bundle.patch` 改名；解析不到 / 解析到无 patch 要分别记，不许混
  const prof5 = mkProfile("__fx/home5", ["__fx_renamed", "__fx_missing", "__fx_nopatch"]);
  write("__fx/home5/profiles/web/node_modules/__fx_renamed/package.json", JSON.stringify({ dsh: { bundle: { patch: "./patch-alt.yml" } } }));
  write("__fx/home5/profiles/web/node_modules/__fx_renamed/patch-alt.yml", "- insert:\n    - id: __fx_from_alt\n");
  write("__fx/home5/profiles/web/node_modules/__fx_nopatch/package.json", JSON.stringify({ name: "__fx_nopatch" }));
  const m5 = readMounts(prof5);
  t("dsh.bundle.patch 指定的 patch 能读到", m5.ok && m5.ids.has("__fx_from_alt"));
  t("解析不到的 bundle 记进 unresolved（不许静默当 0）", m5.unresolved.length === 1 && m5.unresolved[0] === "__fx_missing");
  t("无 patch 的 bundle 记进 noPatch（与 unresolved 分开）", m5.noPatch.length === 1 && m5.noPatch[0] === "__fx_nopatch");

  // ⑥ 只有读得到 profile 才算 ok；读不到要带原因（调用方据此说「不判」而不是「零问题」）
  const m6 = readMounts(path.join(root, "__fx/home6/profiles/web"));
  t("读不到 profile ⇒ ok=false 且带原因", m6.ok === false && /package\.json/.test(m6.reason));

  // ⑦ 自有件口径：只把 ^forge- 记进 own（官方 / 第三方行仍进 ids，便于报总量）
  const prof7 = mkProfile("__fx/home7", ["__fx_mixed"]);
  write("__fx/home7/profiles/web/node_modules/__fx_mixed/package.json", JSON.stringify({}));
  write("__fx/home7/profiles/web/node_modules/__fx_mixed/cordis.patch.yml", "- insert:\n    - id: __fx_third\n    - id: __fx-forge-own\n");
  const m7 = readMounts(prof7);
  t("own 只含 ^forge- 自有件 · ids 含全部行", m7.own.size === 0 && m7.ids.size === 2);

  // ⑧ profile 覆盖层与 home 级 patch 也算装配通路（漏读 = 一条通路在守卫之外）
  const prof8 = mkProfile("__fx/home8", []);
  write("__fx/home8/profiles/web/cordis.patch.yml", "- insert:\n    - id: __fx_profile_layer\n");
  write("__fx/home8/cordis.patch.yml", "- insert:\n    - id: __fx_home_layer\n");
  const m8 = readMounts(prof8);
  t("profile 覆盖层 + home 级 patch 都读到", m8.ids.has("__fx_profile_layer") && m8.ids.has("__fx_home_layer"));

  fs.rmSync(root, { recursive: true, force: true });
  const total = pass + fail;
  console.log(fail ? `✗ 装配挂载解析自检失败 ${fail}/${total}` : `✓ 装配挂载解析自检 ${total} 项全过（该算的算 / 不该算的不算 / 读不到要出声）`);
  return fail === 0;
}

// CLI 入口：`node scripts/assembly-mounts-lib.mjs --selftest`（同 dup-detail-lib / caliber-lib 的形态）
if (process.argv[1] && /assembly-mounts-lib\.mjs$/.test(process.argv[1])) {
  if (process.argv.slice(2).includes("--selftest")) process.exitCode = selftestMounts() ? 0 : 2;
  else console.log("用法: node scripts/assembly-mounts-lib.mjs --selftest（本模块无独立判据，判据在 ui-load-contract / assembly-diff-check）");
}
