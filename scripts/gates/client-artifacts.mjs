#!/usr/bin/env node
/**
 * scripts/gates/client-artifacts.mjs —— 客户端产物齐全判据（ISS-820 外化）
 *
 * ── 判据 ──────────────────────────────────────────────────────────────
 * `forge-ui` / `forge-pm` / `forge-model` 三包的 `dist/client.js` 都必须在。
 * 缺了不是"待生成"，是**白屏**：host 半照跑，浏览器侧一段代码都加载不到，
 * 而屏幕上通常只留一条与产物无关的报错。
 *
 * 口径与 `.github/workflows/ci.yml` 里那条 `node -e` 断言**逐字同源**，
 * 改一边必须看另一边 —— 两条判据对同一个事实给不同答案时，
 * 屏幕上"绿"的那条会被当成真相。
 *
 * ── 三态（为什么不能一律判红）────────────────────────────────────────
 *   · 产物齐                ⇒ passed(0)
 *   · 这棵树没 build 过      ⇒ unjudged(2)：`dist/` **整个不存在** 时，
 *     「没构建」不是「构建错了」。用 `--skip-build` 建的工作树正是这种情形，
 *     把它记红等于用"没跑"冒充"判据被违反"。
 *   · build 过但缺 client.js ⇒ failed(1)：CI 里生成产物是前置步骤，
 *     此时缺了确实是错（ISS-783 实测：`custom()` 曾在抽表时丢了 REPO 绑定，
 *     整格恒崩 `fs is not defined`，CI 每跑必红 —— 报的是崩溃不是结果）。
 *
 * ── 为什么原来是 `<internal>`（ISS-820 外化的理由）────────────────────
 * 同 `project-code-rules-size`：ISS-772/ISS-774 把数据表抽出 run-gates.mjs 时，
 * 这格留成了 `custom:` 闭包 ⇒ `--list` 打 `<internal>`，对账判据看不见它指向哪、
 * registry 也无处登记 ⇒ 永久占白名单一格。外化后它可单跑、可登记、可被查存在性。
 *
 * 用法：node scripts/gates/client-artifacts.mjs [--check] [--json] [--selftest]
 * 退出码：0 齐 / 1 缺（且这棵树 build 过）/ 2 判不了（没 build 过）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, "..", "..")
const GATE = "client-artifacts"
/** 必须带 `dist/client.js` 的包。与 ci.yml 那条断言同一个列表。 */
const PKGS = ["forge-ui", "forge-pm", "forge-model"]
// ISS-832：码值从唯一定义取，不再在本文件写第二份。
//   注意：本文件原先的 2 用法**本来就是对的**（INTERNAL/判不了），本单不改它的语义，
//   只把常量挪到 `scripts/lib/exit-codes.mjs` —— 同码异义的病不在这里，但「同一个数字三处各写一份」在这里。
import { EXIT as CODES } from "../lib/exit-codes.mjs"
const EXIT = { CLEAN: CODES.passed, VIOLATION: CODES.failed, INTERNAL: CODES.unjudged }

/**
 * 纯函数：给「哪些包有 dist/」与「哪些包有 dist/client.js」，判三态。
 * spec 直接喂构造数据，不碰文件系统。
 *
 * @param {string[]} withDist   `dist/` 目录存在的包
 * @param {string[]} withClient `dist/client.js` 存在的包
 */
export function judgeArtifacts(withDist, withClient, pkgs = PKGS) {
  const miss = pkgs.filter((p) => !withClient.includes(p))
  if (!miss.length) return { status: "passed", detail: `✓ ${pkgs.join(" / ")} 的 dist/client.js 都在` }
  // 一个包都没 build 过 ⇒ 这是「没跑」，不是「判据不符」。
  const built = withDist.length > 0
  if (!built) {
    return {
      status: "unjudged",
      detail: `这棵树没 build 过（${pkgs.map((p) => `${p}/dist`).join(" / ")} 整个不在）⇒ 判不了：缺 ${miss.join(", ")}`,
    }
  }
  return { status: "failed", detail: `缺 dist/client.js：${miss.join(", ")}` }
}

function scan(root = REPO, pkgs = PKGS) {
  const has = (p, sub) => fs.existsSync(path.join(root, p, sub))
  return judgeArtifacts(
    pkgs.filter((p) => has(p, "dist")),
    pkgs.filter((p) => has(p, "dist/client.js")),
    pkgs,
  )
}

/** 反向自检：**真造目录真判**。三态各至少一条正反例。 */
function selftest() {
  const cases = []
  const add = (name, got, want) => cases.push({ name, ok: got === want, got, want })

  // ① 正向：三包齐全 ⇒ passed
  add("三包 dist/client.js 齐 ⇒ passed", judgeArtifacts([...PKGS], [...PKGS]).status, "passed")
  // ② 反向：build 过但缺一个 ⇒ failed，且点名到缺的那个
  const one = judgeArtifacts(PKGS, ["forge-ui", "forge-pm"])
  add("build 过但缺 forge-model ⇒ failed", one.status, "failed")
  add("红时点名到缺的包", one.detail.includes("forge-model"), true)
  // ③ 反向：都没 build 过 ⇒ unjudged（**不是红、更不是绿**）
  add("三包 dist/ 都不在 ⇒ unjudged（没跑不冒充判据不符）", judgeArtifacts([], []).status, "unjudged")
  // ④ 关键分辨：只 build 了**别的**包（这里恰好就是要的那个缺）⇒ 仍是 failed
  //    这条把「有没有 build 过」与「缺不缺那个包」分开，是整格最容易写反的一处。
  add("build 过（forge-ui 有 dist）但缺 forge-model/client.js ⇒ failed", judgeArtifacts(["forge-ui"], ["forge-ui"]).status, "failed")
  // ⑤ 分母方向：一个包都不要求 ⇒ passed（不是「扫空所以红」）—— 与 ③ 互为对照
  add("空包列表 ⇒ passed（分母由调用方给，不是猜的）", judgeArtifacts([], [], []).status, "passed")

  // ⑥ 真造目录：证明 scan() 真的在量盘，不是恒返某个值
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "client-artifacts-"))
  try {
    add("真空树 ⇒ unjudged", scan(tree).status, "unjudged")
    for (const p of PKGS) fs.mkdirSync(path.join(tree, p, "dist"), { recursive: true })
    add("只建 dist 空目录 ⇒ failed（build 过但没产物）", scan(tree).status, "failed")
    for (const p of PKGS) fs.writeFileSync(path.join(tree, p, "dist", "client.js"), "")
    add("真产物齐 ⇒ passed", scan(tree).status, "passed")
    fs.rmSync(path.join(tree, "forge-pm", "dist", "client.js"))
    const after = scan(tree)
    add("删掉一个真产物 ⇒ failed", after.status, "failed")
    add("删掉的那个被点名", after.detail.includes("forge-pm"), true)
  } finally {
    fs.rmSync(tree, { recursive: true, force: true })
  }

  const bad = cases.filter((c) => !c.ok)
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ selftest: true, pass: cases.length - bad.length, total: cases.length, cases }, null, 1))
  } else {
    console.log(`${GATE} --selftest`)
    for (const c of cases) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `  期望 ${c.want} 实得 ${c.got}`}`)
    console.log(`\n${cases.length - bad.length}/${cases.length} 例通过`)
  }
  return bad.length ? EXIT.VIOLATION : EXIT.CLEAN
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`用法：node scripts/gates/${GATE}.mjs [--check|--json|--selftest]`)
    process.exit(EXIT.CLEAN)
  }
  if (argv.includes("--selftest")) process.exit(selftest())
  const r = scan()
  const code = r.status === "passed" ? EXIT.CLEAN : r.status === "failed" ? EXIT.VIOLATION : EXIT.INTERNAL
  if (argv.includes("--json")) console.log(JSON.stringify({ gate: GATE, code, ...r }, null, 1))
  else console.log(`${r.status === "passed" ? "✓" : r.status === "failed" ? "✗" : "!"} ${GATE}: ${r.detail}`)
  process.exit(code)
}
