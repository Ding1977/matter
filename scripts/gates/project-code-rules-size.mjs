#!/usr/bin/env node
/**
 * scripts/gates/project-code-rules-size.mjs —— 纪律层篇幅上限（ISS-725 · ISS-820 外化）
 *
 * ── 判据 ──────────────────────────────────────────────────────────────
 * `docs/project-code-rules.md` ≤ 27,000 B。超了 = 那份文件开始承载**工程判据**，
 * 而工程判据该进 `docs/code.md`（篇幅是分层的物理形态：一份文件同时装「纪律」与「实现」
 * 时长到谁都会被读成"规矩变多了"，而实际只是没人敢删的实现细节）。
 *
 * ── 为什么原来是 `<internal>`（ISS-820 外化的理由）────────────────────
 * ISS-800 退役 guard-baselines.sh 时，这条判据只剩一句 `wc -c`，于是就地写成
 * `custom:` 闭包挂在 `scripts/lib/inline-gates.mjs` 里。代价不是"跑不动"，是**它没有名字**：
 *   · `--list` 打 `<internal>` ⇒ 对账判据（verify-gate-coverage）看不出它指向哪个文件；
 *   · registry 只有 spec / legacy 两种 kind ⇒ 它进不了登记表 ⇒ 永久占白名单一格。
 * 外化成脚本后它是一等公民：可单跑、可被登记、可被「脚本存在性」判据看见。
 *
 * ── 口径 ─────────────────────────────────────────────────────────────
 * 上限 **27,000 B 不在这里可调**：它是判据的一部分，改它就是改判据。
 * 文件不在 ⇒ `unjudged`（exit 2，**不当绿**）：缺席不是"零字节所以合规"。
 *
 * 用法：node scripts/gates/project-code-rules-size.mjs [--check] [--json] [--selftest]
 * 退出码：0 合规 / 1 超限 / 2 判不了（文件不在）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, "..", "..")
const GATE = "project-code-rules-size"
const REL = "docs/project-code-rules.md"
/** 上限（字节）。改它 = 改判据，不是调阈值。 */
const LIMIT = 27_000
const EXIT = { CLEAN: 0, VIOLATION: 1, INTERNAL: 2 }

/**
 * 纯函数：给字节数判红绿。spec 直接喂数字，不碰文件系统。
 * @returns {{status:'passed'|'failed', detail:string}}
 */
export function judgeSize(n, limit = LIMIT) {
  const fmt = (v) => v.toLocaleString("en-US")
  return n <= limit
    ? { status: "passed", detail: `✓ 现 ${fmt(n)} B ≤ ${fmt(limit)} B` }
    : { status: "failed", detail: `✗ ${fmt(n)} B > ${fmt(limit)} B —— 工程判据该进 docs/code.md` }
}

function check(root = REPO) {
  const f = path.join(root, REL)
  if (!fs.existsSync(f)) return { code: EXIT.INTERNAL, detail: `${REL} 不存在 ⇒ 判不了（缺席不是"零字节所以合规"）` }
  const n = fs.statSync(f).size
  const r = judgeSize(n)
  return { code: r.status === "passed" ? EXIT.CLEAN : EXIT.VIOLATION, detail: r.detail, bytes: n }
}

/** 反向自检：**真造文件真量**，证明它是按字节判的，不是按文件名判的。 */
function selftest() {
  const cases = []
  const add = (name, got, want) => cases.push({ name, ok: got === want, got, want })

  // ① 正向：恰好等于上限 ⇒ 绿（边界属合规，不是越界）
  add("边界：= 上限 ⇒ passed", judgeSize(LIMIT).status, "passed")
  // ② 反向：上限 +1 ⇒ 红（差一个字节就红，不是"差不多就行"）
  add("反向边界：上限 +1 ⇒ failed", judgeSize(LIMIT + 1).status, "failed")
  // ③ 反向：远超上限 ⇒ 红，且理由里点出实际字节数
  const big = judgeSize(99_999)
  add("反向：99,999 B ⇒ failed", big.status, "failed")
  add("反红时点出实际字节数", /\b99,999 B\b/.test(big.detail), true)
  add("绿时也点出实际字节数", /\b1 B\b/.test(judgeSize(1).detail), true)

  // ④ 文件不在 ⇒ 判不了（exit 2），不是绿 —— 拿临时空树证
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "code-rules-size-"))
  try {
    const r = check(empty)
    add("文件不在 ⇒ exit 2（判不了，不是绿）", r.code, EXIT.INTERNAL)
    add("文件不在 ⇒ 理由点名文件路径", r.detail.includes(REL), true)

    // ⑤ 真造文件：26,999 B ⇒ 绿；27,001 B ⇒ 红（证明量的是盘上那个文件）
    fs.mkdirSync(path.join(empty, "docs"), { recursive: true })
    const f = path.join(empty, "docs", "project-code-rules.md")
    fs.writeFileSync(f, "x".repeat(LIMIT - 1))
    add("真文件 26,999 B ⇒ exit 0", check(empty).code, EXIT.CLEAN)
    fs.writeFileSync(f, "x".repeat(LIMIT + 1))
    add("真文件 27,001 B ⇒ exit 1", check(empty).code, EXIT.VIOLATION)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
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
  const r = check()
  if (argv.includes("--json")) console.log(JSON.stringify({ gate: GATE, code: r.code, ...r }, null, 1))
  else console.log(r.code === EXIT.INTERNAL ? `! ${GATE}: ${r.detail}` : `${GATE}: ${r.detail}`)
  process.exit(r.code)
}
