#!/usr/bin/env node
// probe-bare-border-color.mjs —— 钉住「裸 border 落到 currentColor」的元素（ISS-481 机器判据）
//
// ── 机制 ──────────────────────────────────────────────────────────────────────
// v4 preflight 编译出的是：
//     *, ::after, ::before, ::backdrop, ::file-selector-button { border: 0 solid }
// `border` 是**简写** → 把 border-color 一并重置回**初始值 currentColor**；且这条规则
// **不在任何 @layer 里（unlayered）**，按级联层规则压过所有 layered 的「默认边框色补偿」。
// 结果：凡只给宽度不给色的裸 border（如 `border-b`）都去继承**文字色**，浅色主题下 ≈ 近黑「黑框」。
//
// ── 判据（这是本单最贵的一课，改之前先读完）──────────────────────────────────
// 目标签名：**元素真的在画的那一侧**，边框色去继承了文字色。
// 即：`border-<side>-width > 0` 且 `border-<side>-color === color`（逐字面值相等）。
//
// ⚠️ 两个踩过的坑，别重犯：
//   ① 只比较 `width>0` 的侧**会漏报**：元素上「当前没宽度的那几侧」照样被 preflight 重置成
//      currentColor，将来一加宽度就变黑。首版探针就是这么漏报的（报 0 命中，实际已中招）。
//   ② 反过来把「无宽侧」也算命中**会误报**：`border-color` 是**可继承属性**，
//      官方表格 `th` 的 top 宽 0px，颜色却是从祖先 `section`（bt=1px rgba(0,0,0,.12)）
//      继承来的——不是黑框。
//   折中：命中（计入退出码）只认有宽侧；无宽侧作为「潜在」信息随 `--verbose` 输出，不判失败。
//
// 为什么不用「黑」当判据：页面上有大量**合法的深色**边框（DSH 的 `rgba(0,0,0,.04/.12)`、
//   品牌色、文字色本身就深的容器），用「暗」判会一片 false positive。
//
// `--strict`：把「无宽侧也等于文字色」一并计入命中（回退到坑 ② 的激进口径）。
//   仅在「想排查将来会变黑的地方」时用，别用于验收（会误报）。
//
// ── 作用域 ────────────────────────────────────────────────────────────────────
// 各插件容器内的补偿有各自的口径（forge-pm 等用的是 `:where(*)` 高特异性块，行为与共享层不同），
// 故默认**排除**这些容器根，只查「离开容器」的区域 —— 正是 ISS-481 的病灶区。
// 需要连容器内一起查时加 `--no-exclude-roots`。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node scripts/probe-bare-border-color.mjs                 # 报告；有命中 → 退出码 1
//   node scripts/probe-bare-border-color.mjs --expect-clean  # 验收用（同判据，干净 = 0）
//   node scripts/probe-bare-border-color.mjs --json          # 机器可读
//   node scripts/probe-bare-border-color.mjs --port 9223 --url 127.0.0.1:3210
//
// ── 已知覆盖边界（别误读为「页面已干净」）─────────────────────────────────────
// 本探针扫 `document`（含 shadow root 时需自行扩展）；**不扫 Electron `<webview>` 内的
// 独立文档**（会话B 天然免疫，无此问题）。扫描不到的区域不算通过。

import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(HERE, "cdp-driver.mjs")

const argv = process.argv.slice(2)
const asJson = argv.includes("--json")
const verbose = argv.includes("--verbose")
const excludeRoots = !argv.includes("--no-exclude-roots")
const strict = argv.includes("--strict")
const pick = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const port = pick("--port", "9223")
const url = pick("--url", "127.0.0.1:3210")

// ── 页面内探针 ────────────────────────────────────────────────────────────────
// 输出刻意保持紧凑（本机 cdp 输出有 64KB 量级的截断坑）：只回命中项 + 汇总计数。
const pageProbe = (exclude, strictMode) => `(() => {
  const ROOTS = ${JSON.stringify([
    ".matter-plans-root",
    ".matter-plans-sheet",
    ".matter-browser-root",
    ".matter-linear-root",
    ".matter-model-ui",
    ".matter-pm-root",
  ])};
  const EXCLUDE = ${exclude};
  const STRICT = ${strictMode};
  const SIDES = ["Top", "Right", "Bottom", "Left"];
  const path = (el) => {
    const h = [];
    let n = el;
    for (let i = 0; i < 5 && n && n.tagName !== "BODY"; i++) {
      const c = typeof n.className === "string" && n.className.trim()
        ? "." + n.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
      h.push(n.tagName.toLowerCase() + c);
      n = n.parentElement;
    }
    return h.join(" < ");
  };
  const hits = [];
  const latent = [];
  let scanned = 0, bordered = 0;
  for (const el of document.querySelectorAll("*")) {
    scanned++;
    if (EXCLUDE && ROOTS.some((r) => el.closest(r))) continue;
    const cs = getComputedStyle(el);
    const w = SIDES.map((s) => parseFloat(cs["border" + s + "Width"]) || 0);
    if (!w.some((x) => x > 0)) continue;
    bordered++;
    // 命中（计入退出码）：**真的在画的那一侧**去继承了文字色
    const eqSides = SIDES.filter((s, i) => w[i] > 0 && cs["border" + s + "Color"] === cs.color);
    // 潜在（默认只信息性输出，不判失败）：无宽侧等于文字色 —— 可能是继承来的，不一定是黑框
    const latentSides = SIDES.filter((s, i) => w[i] === 0 && cs["border" + s + "Color"] === cs.color);
    const rec = () => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === "string" ? el.className : "").slice(0, 48),
        path: path(el),
        visible: r.width > 0 && r.height > 0,
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(","),
        eqSides: eqSides.join(","),
        eqWidths: SIDES.map((s, i) => (eqSides.includes(s) ? w[i] + "px" : null)).filter(Boolean).join(","),
        latentSides: latentSides.join(","),
        color: cs.color,
        text: (el.textContent || "").trim().slice(0, 24),
      };
    };
    if (eqSides.length || (STRICT && latentSides.length)) hits.push(rec());
    else if (latentSides.length) latent.push(rec());
  }
  // 环境佐证：preflight 是否真在页面里生效 + 共享层默认边框色是否已声明
  let preflightOn = false, sharedDefault = null;
  for (const s of document.styleSheets) {
    let rules; try { rules = [...s.cssRules] } catch { continue }
    for (const r of rules) {
      if (!r.selectorText || !r.style) continue;
      if (/::file-selector-button/.test(r.selectorText) && r.style.getPropertyValue("border")) preflightOn = true;
      if (/::file-selector-button/.test(r.selectorText) && r.style.getPropertyValue("border-color"))
        sharedDefault = r.style.getPropertyValue("border-color").trim();
    }
  }
  return {
    hits, latent, scanned, bordered,
    env: {
      preflightOn, sharedDefault, strict: STRICT,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      exclusions: EXCLUDE ? ROOTS.length : 0,
    },
  };
})()`

const res = spawnSync("node", [DRIVER, "--port", port, "--url", url, "eval", pageProbe(excludeRoots, strict)], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
})

let data = null
const raw = (res.stdout || "").trim()
try {
  data = JSON.parse(raw)
} catch {
  // 页面求值异常信息在 stderr / 首行
  const msg = (res.stderr || "").trim() || raw.slice(0, 300)
  console.error("✗ 无法解析探针结果：", msg || "(空输出)")
  process.exit(2)
}

if (asJson) console.log(JSON.stringify(data, null, 2))
else {
  const { hits, latent = [], scanned, bordered, env } = data
  console.log("── ISS-481 探针：裸 border 落到 currentColor ──────────────────")
  console.log(`页面        : ${url}  (CDP ${port})`)
  console.log(`preflight   : ${env.preflightOn ? "生效中（检测到 unlayered 的 border 重置）" : "未检测到——此状态下本类 bug 不会显现"}`)
  console.log(`共享层默认色 : ${env.sharedDefault || "❌ 未声明（ISS-481 修复未落地）"}`)
  console.log(`主题        : body bg=${env.bodyBg} color=${env.bodyColor}`)
  console.log(`扫描        : ${scanned} 个元素，其中有边框 ${bordered} 个${env.exclusions ? `（已排除 ${env.exclusions} 个容器根内）` : "（未排除容器根）"}`)
  if (!hits.length) {
    console.log("\n✅ 0 命中：没有「正在画的那一侧」去继承文字色的元素")
  } else {
    console.log(`\n❌ ${hits.length} 个命中（正在画的侧 border-color === color → 浅色主题下就是近黑框）：`)
    for (const h of hits) {
      console.log(`  · <${h.tag}>${h.cls ? "." + h.cls.split(/\s+/)[0] : ""}  文字色=${h.color}  可见=${h.visible ? "是" : "否"}  box=${h.box}`)
      console.log(`      位置    : ${h.path}`)
      if (h.eqSides) console.log(`      变色侧  : ${h.eqSides}（宽 ${h.eqWidths}）`)
      if (h.text) console.log(`      文本    : "${h.text}"`)
    }
  }
  if (verbose && latent.length) {
    console.log(`\nℹ️  ${latent.length} 个「潜在」项（无宽侧等于文字色，多为继承，未计入失败）：`)
    for (const h of latent.slice(0, 12))
      console.log(`  · <${h.tag}> box=${h.box} 潜在侧=${h.latentSides}  ${h.text ? `"${h.text}"` : ""}`)
    if (latent.length > 12) console.log(`  ...（共 ${latent.length} 个，已截断）`)
  }
}

process.exit(Array.isArray(data?.hits) && data.hits.length > 0 ? 1 : 0)
