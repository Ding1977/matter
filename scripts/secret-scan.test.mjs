#!/usr/bin/env node
// scripts/secret-scan.test.mjs
// 明文密钥扫描（ISS-812 / ISS-709）的**端到端**验证：证明占位符豁免不是把门禁关掉。
//
// 为什么要单独成文件（`--selftest` 已经验过纯函数那一层）：
//   selftest 喂的是**字符串**，证不到「真 CLI 在真仓里真的读到了文件、真的按 git 的清单扫」。
//   一次典型的假绿：把豁免写成了排除路径（`scripts/`、`*.test.js`），纯函数照样全绿，
//   而真仓里藏在测试文件里的真密钥从此永远看不见。所以这里必须跑真子进程、真 git、真文件。
//
// 六件事（缺一不算验过）：
//   ① 真仓必须绿，且豁免计数印出来（5 处现存夹具）—— 免的是**这五处**，不是"以后都别报"；
//   ② 临时仓里放占位符夹具 ⇒ 绿；
//   ③ 临时仓里放**真形态**密钥（base62 48 位）⇒ 红，且点名文件与行号；
//   ④ 反向控：`sk`+`-test-` + 48 位真随机 ⇒ **红**（标记词不是免死金牌）；
//   ⑤ 同一条判据在 `--diff`（历史新增档）里同样生效——两个档不能各有一套口径；
//   ⑥ 真密钥与占位符**混在同一行**时，真密钥仍被抓（加豁免最容易造出的新盲区）；
//   ⑦ **新豁免形状未登记 ⇒ 红**（棘轮有牙：放宽正则就扩大盲区，必须显式登记）；
//   ⑧ 把新形状登记进基线 ⇒ 回绿（证明 ⑦ 红是因为"没登记"，不是因为"报不出来"）；
//   ⑨ 基线读不到 / 坏 JSON ⇒ **红**，不许当成通过（判不了 ≠ 绿）。
//
// 副本而不是原地改：本仓有并发会话共用文件系统，原地注入会污染他人工作树。
// 用法：bun test scripts/secret-scan.test.mjs --isolate
import { describe, expect, test, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "scripts", "secret-scan.mjs")

// ⚠️ 本文件自己会被 `--worktree` 扫到：所有夹具一律**拼接构造**，绝不写字面量，
//    否则这条测试自己就成了假阳性（ISS-812 的原事故形态）。
const SK = "sk" + "-"
const PLACEHOLDER = SK + "test" + "-" + "0123456789abcdef0123456789"
const REAL_FORM = SK + "proj" + "-" + "AbCdEf1234567890GhIjKlMnOpQrStUvWxYz012345"
const LOOKS_LIKE_PLACEHOLDER = SK + "test" + "-" + "Zx9Qv2Lm7Rt4Kp1Wn8Hy3Bc6Jd0Fg5Sa2Eo9Ui4Xz7Aw3Vm"

const made = []
afterEach(() => {
  for (const d of made.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }
})

const BASELINE_REL = path.join("scripts", "baseline", "secret-scan-exempt.json")
const BASELINE_SRC = path.join(ROOT, BASELINE_REL)

/** 造一棵最小临时仓：脚本副本 + **真实基线副本** + git 已入库清单。ROOT 由脚本自身位置推出。 */
function fixtureRepo({ baseline = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-scan-"))
  made.push(dir)
  fs.mkdirSync(path.join(dir, "scripts", "baseline"), { recursive: true })
  fs.copyFileSync(SRC, path.join(dir, "scripts", "secret-scan.mjs"))
  if (baseline) fs.copyFileSync(BASELINE_SRC, path.join(dir, BASELINE_REL))
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  return { dir, git }
}

/** 写文件并入库（扫描面 = `git ls-files`，不 add 就等于没扫，别把"没扫"当"绿"）。 */
function commit(fx, rel, content) {
  const abs = path.join(fx.dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  fx.git("add", "-f", rel)
  fx.git("commit", "-q", "-m", rel)
  return abs
}

/** 跑真 CLI，红是预期结果之一，不抛。 */
function run(cwd, args) {
  try {
    return { code: 0, out: execFileSync("node", [path.join(cwd, "scripts", "secret-scan.mjs"), ...args], { encoding: "utf8", maxBuffer: 16 << 20 }) }
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : -1, out: `${e.stdout || ""}${e.stderr || ""}` }
  }
}

describe("secret-scan · 真仓", () => {
  // 咬：真仓基线态 —— 5 处现存豁免必须全在 secret-scan-exempt.json 里（scanWorktree + ratchetCheck 都不许回红）；
  //     以及「豁免数必须印出来」（printFindings `:274`）—— 有人把豁免改成静默排除路径，这里就印不出数字。
  // ⚠️ ISS-790：本组两条是**真仓级**（`run()` 起真子进程扫全仓）。实测单跑 `--worktree` 28.3s、
  //   `--selftest` 18.4s，而 bun test 的单测**默认 5s 超时** ⇒ 进程被杀、`run()` 拿到 `code:-1` / `out:""`
  //   ⇒ 断言失败。**红的不是判据，是「测试跑不完」** —— 这类红长得跟真红一模一样（报错也是断言不符），
  //   最容易让人跑去改判据。所以这里显式给 60s（≈ 实测 2 倍）。
  //   临时仓那几条夹具测试是 130ms 级，**不要**跟着放大。
  test("① 真仓工作区档必须绿，且把豁免数量印出来（5 处现存夹具）", () => {
    const r = run(ROOT, ["--worktree"])
    expect(r.out).toContain("0 处疑似明文密钥")
    // 豁免数不许静默：印不出数字就说明豁免逻辑被绕过了（或改成排除路径了）
    expect(r.out).toMatch(/占位符豁免 \d+ 处/)
    expect(r.code).toBe(0)
  }, 60_000)

  // 咬：`--selftest` 全 20 项（`guard-baselines.sh:413` 的 selfcheck 挂的就是它）。
  //     改坏 SECRET_PATTERNS 或收窄探测面（如 `{30,}`→`{60,}`）⇒ 这里必红。
  test("⑥ --selftest 自身必须绿（guard-baselines 把它当门禁）", () => {
    const r = run(ROOT, ["--selftest"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("项通过")
  }, 60_000)
})

describe("secret-scan · 临时仓里的正反控", () => {
  // 咬：placeholderShape `:84` 的双条件 —— 标记词在 PLACEHOLDER_WORDS `:63` 内 **且** 体低熵（minPeriodOf `:70` 非 null）。
  //     以及「豁免要计入 exempt 而不是当没看见」。
  test("② 占位符夹具（自述假值 + 低熵体）⇒ 绿，且计入豁免而不是当没看见", () => {
    const fx = fixtureRepo()
    commit(fx, "lib/a.test.js", `const 假密钥 = "${PLACEHOLDER}"\n`)
    const r = run(fx.dir, ["--worktree"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("占位符豁免 1 处")
  })

  // 咬：判据是**纯 token 判据**（placeholderShape 只吃 token，无路径入参）⇒ 不许把豁免写成排除路径。
  //     谁把 scripts/ 或 *.test.js 整目录排除掉来"变绿"，这条就红。
  test("②b 反向：同一个占位符写进**生产文件**也照样豁免 ⇒ 证明豁免不看路径（没缩小射程）", () => {
    const fx = fixtureRepo()
    commit(fx, "lib/runtime-config.js", `export const k = "${PLACEHOLDER}"\n`)
    const r = run(fx.dir, ["--worktree"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("占位符豁免 1 处")
  })

  // 咬：SECRET_PATTERNS 的 `sk-[A-Za-z0-9_.-]{30,}` 下界 `:31`（放宽/收窄都会动到这里）
  //     + secretHitsInText 的 where 字段（`:117`，必须给到「文件:行号」而不是只报个数字）。
  test("③ 真形态密钥（base62 48 位）⇒ 红，点名文件与行号", () => {
    const fx = fixtureRepo()
    commit(fx, "lib/b.js", `// 老实说这行本来不该存在\nconst k = "${REAL_FORM}"\n`)
    const r = run(fx.dir, ["--worktree"])
    expect(r.code).toBe(1)
    expect(r.out).toContain("lib/b.js:2")
    expect(r.out).toContain("sk- 形式 API key")
  })

  // 咬：placeholderShape 的第二条 —— 标记词对但体**不成周期**（minPeriodOf 返回 null）⇒ 必须照红。
  //     这是「真密钥长得像占位符」那组反向控的主控点，标记词不是免死金牌。
  test("④ 反控：`sk`+`-test-` 的标记词 + 48 位真随机 ⇒ 仍然红（标记词不是免死金牌）", () => {
    const fx = fixtureRepo()
    commit(fx, "lib/c.test.js", `const k = "${LOOKS_LIKE_PLACEHOLDER}"\n`)
    const r = run(fx.dir, ["--worktree"])
    expect(r.code).toBe(1)
    expect(r.out).toContain("lib/c.test.js:1")
  })

  // 咬：secretHitsInText 用 `matchAll` 枚举该行**全部** token（`:115`）。
  //     若改成只取第一个匹配，占位符在前时真密钥会被一起放过 —— 加豁免最容易造出来的新盲区。
  test("⑥ 占位符与真密钥混在同一行 ⇒ 真密钥仍被抓（豁免最容易造的新盲区）", () => {
    const fx = fixtureRepo()
    commit(fx, "lib/d.test.js", `const a = "${PLACEHOLDER}", b = "${REAL_FORM}"\n`)
    const r = run(fx.dir, ["--worktree"])
    expect(r.code).toBe(1)
    expect(r.out).toContain("lib/d.test.js:1")
    // 这一行只该剩 1 处：说明占位符被豁免、真密钥被留下，不是整行连坐也不是整行放过
    expect(r.out).toContain("1 处疑似明文密钥")
  })

  // 咬：ratchetCheck 的未登记分支 `:289`（文案「新增豁免形状未登记」）+ 形状键格式 `<标记词>|<体形态>`。
  //     这是整个棘轮的主控：放宽正则（加标记词/加周期形态）⇒ 冒出未登记形状 ⇒ 必红。
  test("⑦ 新豁免形状未登记 ⇒ 红，并点名是哪一种形状", () => {
    const fx = fixtureRepo()
    // 基线只登记了 `test|period:16`；这里换成 `dummy` 标记词 = 一种**没登记过**的形状
    commit(fx, BASELINE_REL, JSON.stringify({ shapes: { "test|period:16": "夹具" } }, null, 2))
    commit(fx, "lib/g.test.js", `const k = "${SK}dummy-${"0123456789abcdef0123456789"}"\n`)
    const r = run(fx.dir, ["--worktree"])
    expect(r.code).toBe(1)
    expect(r.out).toContain("新增豁免形状未登记")
    expect(r.out).toContain("dummy|period:16")
  })

  // 咬：ratchetCheck 的放行路径 —— 登记进 shapes 且写了理由即绿。
  //     同时钉住「⑦ 的红是因为没登记、不是因为报不出来」：先断言豁免计数 >0 再断言未登记，避免把"抓不到"误当棘轮生效。
  test("⑧ 把这个形状登记进基线 ⇒ 回绿（红是因为没登记，不是报不出来）", () => {
    const fx = fixtureRepo()
    commit(fx, "lib/h.test.js", `const k = "${SK}dummy-${"0123456789abcdef0123456789"}"\n`)
    // 先钉住"红的原因"：不是抓不到（占位符计数要 >0），而是这种形状没登记
    const before = run(fx.dir, ["--worktree"])
    expect(before.code).toBe(1)
    expect(before.out).toContain("占位符豁免 1 处")
    expect(before.out).toContain("新增豁免形状未登记")
    // 登记后必须回绿——否则 ⑦ 的红是假的（可能本来就抓不到，跟棘轮无关）
    const cur = JSON.parse(fs.readFileSync(path.join(fx.dir, BASELINE_REL), "utf8"))
    cur.shapes["dummy|period:16"] = "ISS-709 测试：确认登记后回绿"
    commit(fx, BASELINE_REL, JSON.stringify(cur, null, 2))
    const after = run(fx.dir, ["--worktree"])
    expect(after.code).toBe(0)
    expect(after.out).toContain("占位符豁免 1 处")
  })

  // 咬：loadExemptShapes 的三条 fail-closed —— 读不到 `:248`、坏 JSON `:252`、条目没写理由算没登记 `:285`。
  //     口径：判不了 ≠ 绿，与同文件 --selftest 的 fail-closed 一致。
  test("⑨ 基线读不到 / 坏 JSON / 条目没写理由 ⇒ 一律红（判不了不当绿）", () => {
    const missing = fixtureRepo({ baseline: false })
    commit(missing, "lib/i.js", "export const x = 1\n")
    const r1 = run(missing.dir, ["--worktree"])
    expect(r1.code).toBe(1)
    expect(r1.out).toContain("不许当成通过")

    const broken = fixtureRepo()
    commit(broken, BASELINE_REL, "{ 这不是 JSON")
    expect(run(broken.dir, ["--worktree"]).code).toBe(1)

    const blank = fixtureRepo()
    commit(blank, BASELINE_REL, JSON.stringify({ shapes: { "test|period:16": "  " } }))
    commit(blank, "lib/j.test.js", `const k = "${PLACEHOLDER}"\n`)
    const r3 = run(blank.dir, ["--worktree"])
    expect(r3.code).toBe(1)
    expect(r3.out).toContain("没写理由")
  })

  // 咬：scanDiff `:150` 与 scanWorktree `:137` 共用同一套 placeholderShape + ratchetCheck ——
  //     两个档不许各有一套口径（CI 两档都在跑：ci.yml `--worktree` / `--diff`）。
  test("⑤ --diff 档与工作区档同一判据：占位符绿、真密钥红", () => {
    const fx = fixtureRepo()
    commit(fx, "lib/base.js", "export const x = 1\n")
    const base = fx.git("rev-parse", "HEAD").trim()
    commit(fx, "lib/e.test.js", `const p = "${PLACEHOLDER}"\n`)
    const green = run(fx.dir, ["--diff", base])
    expect(green.code).toBe(0)
    expect(green.out).toContain("占位符豁免 1 处")
    commit(fx, "lib/f.js", `const k = "${REAL_FORM}"\n`)
    const red = run(fx.dir, ["--diff", base])
    expect(red.code).toBe(1)
    expect(red.out).toContain("lib/f.js(新增行)")
  })
})
