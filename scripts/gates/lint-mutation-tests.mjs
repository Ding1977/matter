#!/usr/bin/env node
/**
 * scripts/gates/lint-mutation-tests.mjs —— scripts/*.test.mjs 全量变异测试（ISS-701 · ISS-820 外化）
 *
 * ── 一格判什么 ────────────────────────────────────────────────────────
 * `scripts/` 根下每个 `*.test.mjs` 都跑一遍（bun test）。它们测的是**判据自己的牙**：
 * 摘掉一条规则、把 block 降成 warn、把白名单塞一条 —— 判据必须当场变红。
 * 这些用例不跑 = 判据坏了没人知道，而屏幕上一切正常。
 *
 * ── ISS-800：射程从「点名两个文件」改成「扫目录」──────────────────────
 * 原先是**写死两个文件名**（lint-layer / lint-writer-uniqueness）—— 正是 ISS-710 明令禁止的
 * 「点名清单」形态。原先靠 guard-baselines.sh 那一格（bash `set --` 扫目录）补足其余测试文件；
 * guard 本单退役后，本格成了 scripts/*.test.mjs 的**唯一**执行路径，写死清单就变成永久漏跑：
 * 实测盘上 9 个 test 文件，本格只跑 2 个，另外 7 个「写了但永远不跑」
 * （`verify-test-wiring.mjs --check` 点名报了 9 条，含这两条本身没被任何路径选中）。
 * ⇒ 改成扫目录，与 guard 原实现同一口径：新文件自动进档，补漏不靠谁记得改清单。
 * 一个都没扫到 ⇒ 判红（glob 失效不许当绿）。
 *
 * ── ⚠️ ISS-820 外化时必须保留的约束（改这行前先读 verify-test-wiring.mjs）─────
 * **必须经 shell 跑**：`spawnSync(bun, ["test", "scripts/*.test.mjs"])` **不展开 glob**
 * （实测 bun 报 `The following filters did not match any test files`，exit 1）。
 * 走 bash 后 glob 由 shell 展开，实测 90 pass / 0 fail / 9 files。
 * **这一行同时是「跑步器」和「glob 射程」** —— 与 `verify-test-wiring.mjs` 的 DIRECT 形态同构，
 * 那条判据认得出来（它要求 RUNNER 与测试 token **在同一行**）。**别改成 readdirSync 再拼数组**：
 * 那样判据看不到射程，9 个测试文件会被点名判「没有任何执行路径选中它」。
 * ⇒ 所以下面那行 RUN 常量必须是**单行字面量**，不许拆、不许模板拼接成多行。
 *    外化到本文件后，`verify-test-wiring.mjs` 的 EXEC_PATHS 必须把本文件也列进去
 *    （ISS-820 已同步；漏了就是 9 个测试文件全部误判成「没被选中」）。
 *
 * ── ISS-816：跑命令必须用 `bunBin()` 给的**那个** bun ──────────────────
 * 旧写法 `bash -c "bun test ..."` 靠 PATH，而 `bunBin()` 可能返回 `~/.bun/bin/bun` 绝对路径
 * ⇒ 查找说「有」、执行却 exit 127 ⇒ 记成红。那是「本机没跑成」，不是「判据被违反」。
 *
 * 用法：node scripts/gates/lint-mutation-tests.mjs [--check] [--json] [--selftest]
 * 退出码：0 全过 / 1 有用例失败 / 2 判不了（本机没有 bun / 一个测试文件都没扫到）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { bunBin } from "../lib/bun-bin.mjs"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, "..", "..")
const GATE = "lint-mutation-tests"
const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

// ⛔ 单行字面量：这一行**同时**是「跑步器」与「glob 射程」，`verify-test-wiring.mjs` 按行认它。
//    拆行 / 拼数组 / 改 readdirSync 都会让那条判据看不见射程（见文件头）。
const RUN = `bun test scripts/*.test.mjs --isolate`

/** 盘上的测试文件（只扫一层，与 RUN 的 glob 同射程）。 */
function listTests(root = REPO) {
  try {
    return fs
      .readdirSync(path.join(root, "scripts"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".test.mjs"))
      .map((e) => `scripts/${e.name}`)
      .sort()
  } catch {
    return []
  }
}

function check(root = REPO) {
  const tests = listTests(root)
  // 分母为 0 不许冒充绿：一个都没扫到说明 glob/目录出了问题，不是"全过"。
  if (!tests.length) return { code: EXIT.INTERNAL, detail: "一个 scripts/*.test.mjs 都没扫到（分母为 0 ⇒ 判据没在工作）" }
  const bun = bunBin()
  if (!bun) return { code: EXIT.INTERNAL, detail: "本机没有可执行的 bun ⇒ 没跑（不冒充绿）" }
  // ⚠️ 真的经 bash 跑，glob 由 shell 展开（见文件头）。
  const r = spawnSync("bash", ["-c", RUN.replace(/^bun/, `"${bun}"`)], {
    cwd: root,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 1 << 28,
    env: { ...process.env, NO_COLOR: "1" },
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  if (r.status === 0) return { code: EXIT.CLEAN, detail: `${tests.length} 个测试文件全过`, output: out }
  return { code: EXIT.VIOLATION, detail: `exit ${r.status}`, output: out }
}

/** 反向自检：不跑 bun（自检不许依赖它），只验「分母 / 射程 / bun 缺席」三条判别。 */
function selftest() {
  const cases = []
  const add = (name, got, want) => cases.push({ name, ok: got === want, got, want })

  // ① 正面：真盘上扫得到测试文件（≥1，证明 listTests 在工作）
  const real = listTests(REPO)
  add("真盘上扫到 ≥1 个测试文件", real.length >= 1, true)
  add("扫到的都在 scripts/ 根、都以 .test.mjs 结尾", real.every((t) => /^scripts\/[^/]+\.test\.mjs$/.test(t)), true)

  // ② 反向：空目录 ⇒ 分母 0 ⇒ exit 2（不是绿）
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-tests-"))
  try {
    fs.mkdirSync(path.join(empty, "scripts"))
    const r0 = check(empty)
    add("空 scripts/ ⇒ exit 2（分母为 0 不许冒充绿）", r0.code, EXIT.INTERNAL)
    add("分母为 0 时理由点名", r0.detail.includes("分母为 0"), true)

    // ③ 射程：真造 3 个测试文件 ⇒ 都要被扫到（证明是扫目录，不是点名清单）
    //    比字符串不比数组引用 —— `===` 比数组恒 false，那是自检自己写错，不是判据不对。
    for (const n of ["a", "b", "zzz"]) fs.writeFileSync(path.join(empty, "scripts", `${n}.test.mjs`), "")
    add("新造的 3 个测试文件全被扫到（扫目录不是点名）", listTests(empty).join(","), "scripts/a.test.mjs,scripts/b.test.mjs,scripts/zzz.test.mjs")

    // ④ 反面：非 .test.mjs 的文件不许被算进来（射程边界）
    fs.writeFileSync(path.join(empty, "scripts", "notatest.mjs"), "")
    add("非 *.test.mjs 不算进射程", listTests(empty).length, 3)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }

  // ⑤ RUN 常量的形状约束：必须单行、带跑步器、带 glob —— 与 verify-test-wiring 的判据同构。
  //    这条是「外化时别把射程拆散」的机器化提醒：拆了它会红，而不是等对账判据隔一天来报。
  add("RUN 不含换行（射程必须在一行里）", /\n/.test(RUN), false)
  add("RUN 带 glob 射程", RUN.includes("scripts/*.test.mjs"), true)
  add("RUN 带跑步器 bun", /^bun\s+test\b/.test(RUN), true)
  add("RUN 带 --isolate", RUN.includes("--isolate"), true)

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
  const r = check()
  if (argv.includes("--json")) console.log(JSON.stringify({ gate: GATE, code: r.code, detail: r.detail }, null, 1))
  else {
    console.log(`${r.code === EXIT.CLEAN ? "✓" : r.code === EXIT.VIOLATION ? "✗" : "!"} ${GATE}: ${r.detail}`)
    if (r.output) process.stdout.write(r.output)
  }
  process.exit(r.code)
}
