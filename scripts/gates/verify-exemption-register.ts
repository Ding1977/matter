/**
 * 豁免登记表（ISS-814 建 · ISS-830 补到期判定）—— 全库 171 条门禁豁免、0 条有到期日 ⇒ 门禁报的「绿」是一张允许清单。
 *
 * ## 现在做四件事（原「过期即红」缺位见下节，理由质量仍后续单补）
 *   ① 新增豁免必须带 `expires`：某文件「无 expires 的豁免条数」超过 `grandfathered` 上限 ⇒ 红。
 *   ② `grandfathered` 数字只减不增：与**已提交**（`git show HEAD:`）的上限比，调高 ⇒ 红。
 *   ③ `expires` 本身要有牙（ISS-830）：格式非法 / 已过期超宽限 / 过于遥远 ⇒ 红，临期 ⇒ 只提示。
 *   ④ `ticket` 拦占位符（ISS-830）：`TODO` / `TBD` / `x` / 空串等 ⇒ 红。**不查单据是否存在**（要读 Matter 库，超出本判据射程）。
 *
 * ## 为什么 ③ 必须存在（ISS-830：字段填了但没人读 = 第 4 种假绿）
 * ① 的红条件是「**无** expires 的条数超上限」—— 判的是**有没有填**，不是**填的日期过没过**。
 * 于是 204 条补了 expires 的豁免当天就「合规」了，却**没有一条会到期变红**：
 * 到 2026-12-31 那天它们照样绿。**填了但永久有效，比不填更坏**（不填至少 ① 会红）。
 * ③ 就是补这个洞 —— 日期比较必须在判据里真的发生。
 *
 * ## ③ 的分级为什么要有宽限期（ISS-830 裁决，不是随手定的）
 * 存量豁免的到期日高度集中于同一天（ISS-815 那批统一写 `2026-12-31`），
 * 不做分级的话那一天会**一次性红掉全部同批条目**——红是诚实信号，但几百条一起红等于门禁瘫痪，
 * 后果是下一个人直接把昨天整批改期，反而把债藏得更深。所以：
 *   · 过期 ≤ `GRACE_DAYS` 天 ⇒ 只提示（给人改期或还债的窗口）
 *   · 过期 > `GRACE_DAYS` 天 ⇒ 红（宽限期不是沉默期，拖过它就是红）
 *   · 未过期 ⇒ 静默通过
 * ⚠️ 宽限期只吸收「批量到期日的抖动」，**不吸收**「一直在拖」——所以它是 7 天，不是 7 个月。
 *
 * ## ③ 的「伪装永久」为什么红
 * `expires: 2999-12-31` 在形式上满足 ① 「有 expires」，实质上是永久豁免 ——
 * 这是把 ① 绕过去的最省事写法。超过 `MAX_YEARS_AHEAD` 年即判红：
 * **一个期限长到不会在本世纪兑现，等于没有期限。**
 *
 * ## 为什么「只减不增」不能只靠 ①
 * ① 的红条件是 `missing > limit`。单纯调高 `limit`（如 46 → 47）时 `missing` 没变，
 * 表现为 `limit > missing` ⇒ 按 ① 只会走「可下调」提示，**永不红** —— 那就是一条没牙的棘轮。
 * 实测本仓 16 个文件全部 `missing == limit`（零富余），所以「数百万」这类漂移不会有任何信号。
 * 因此 ② 另取一个锚点：**上一次提交里的那个数**。改动面比它大就是上升，与 `missing` 无关。
 * 这同时解释了一个反直觉行为：无富余时把某个数调低 1 也会红 —— 那不是棘轮坏了，
 * 而是「你声称已还 1 条债，但盘上那条豁免还在」。正确顺序是先补 `expires`（或删豁免）再降上限。
 *
 * ## 射程与口径（ISS-818 改：按 _meta.kind 显式分类，不靠目录猜）
 *   · 一个 baseline 文件是不是「豁免」，由它自己的 `_meta.kind` 声明，不由它住在哪个目录决定：
 *     - `kind=waiver` ⇒ 算豁免，受下面 ①③④ 的 expires / ticket 约束；
 *     - `kind=allowlist` / `frozen` / `ledger` ⇒ 允许清单 / 冻结路径 / 判不了台账，**不是豁免**，
 *       整文件跳过并出声「跳过了 N 个非豁免文件」（不再被数成「无 expires 的豁免」）；
 *     - **缺 `_meta.kind` ⇒ 红**：不许靠目录/文件名猜语义（这是 ISS-812 误判的根因）。
 *   · 文件内部的对象识别不依赖形状（`waivers{}` / `entries[]` / `frozen[]` 各不相同）：
 *     在**已判为 waiver 的文件里**递归遍历，凡带 `reason` 或 `why` 字段的对象即一条豁免。
 *   · `scripts/baseline/*.json` 的读入失败不在这里判 —— 坏 JSON 归别的判据，本判据只跳过并提示。
 *   · ⛔ 登记表缺失 ⇒ `unjudged`（no-baseline），不判绿：删掉登记表就永久变绿的形态是 K8 禁止的。
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const BASE_REL = "scripts/baseline"
const REGISTER_REL = `${BASE_REL}/exemption-register.json`
const GATE = "verify-exemption-register"

/** 宽限期（天）。过期在这么多天以内只提示不阻断 —— 理由见头注「③ 的分级为什么要有宽限期」。 */
export const GRACE_DAYS = 7
/** 到期日上限（年）。超过它 = 「伪装成有期限的永久豁免」，判红。 */
export const MAX_YEARS_AHEAD = 5
/** 明显是占位符的 `ticket`。只拦形状，**不查单据是否存在**（那要读 Matter 库，超出射程）。 */
export const TICKET_PLACEHOLDER = /^(todo|tbd|x|n\/a|na|待补|-|—|none|null)$/i

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * baseline 文件允许的 `_meta.kind`（ISS-818）。
 * 只有 `waiver` 计入豁免；其余三类是治理清单/冻结账本/判不了台账，文件整体跳过。
 */
export const BASELINE_KINDS = new Set(["waiver", "allowlist", "frozen", "ledger"] as const)
export type BaselineKind = "waiver" | "allowlist" | "frozen" | "ledger"

/** 从解析后的 baseline 根对象取 `_meta.kind`；没有 / 类型不对 ⇒ null（判红，不猜）。 */
export function readBaselineKind(parsed: unknown): BaselineKind | null {
  if (!parsed || typeof parsed !== "object") return null
  const meta = (parsed as Record<string, unknown>)._meta
  if (!meta || typeof meta !== "object") return null
  const kind = (meta as Record<string, unknown>).kind
  return typeof kind === "string" && (BASELINE_KINDS as Set<string>).has(kind) ? (kind as BaselineKind) : null
}

/**
 * `YYYY-MM-DD` → UTC 天数序号；非法日期（含 `2026-02-31` 这类形状对但不存在的）⇒ `null`。
 * 用 UTC 是为了不受运行机器时区影响：同一份登记表在不同时区必须给出同一结论。
 */
export function toDayNumber(s: string): number | null {
  if (!DATE_RE.test(s)) return null
  const [y, m, d] = s.split("-").map(Number)
  const ms = Date.UTC(y, m - 1, d)
  const back = new Date(ms)
  // 形状对但不存在的日期会被 Date 归一化（2026-02-31 → 03-03），回读不一致即非法
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null
  return Math.round(ms / 86_400_000)
}

export type Exemption = Record<string, unknown>

/**
 * 递归收集「带 `reason` 或 `why` 的对象」。
 *
 * 命中后**继续下钻**（与统计脚本同源）：嵌套结构里外层带 why、内层带 why 的情况真实存在，
 * 只取外层会漏报内层那条无 expires 的豁免。宁可多算不算少算 —— 少算 = 假绿。
 */
export function collectExemptions(value: unknown, out: Exemption[] = []): Exemption[] {
  if (Array.isArray(value)) {
    for (const v of value) collectExemptions(v, out)
    return out
  }
  if (!value || typeof value !== "object") return out
  const rec = value as Exemption
  if ("reason" in rec || "why" in rec) out.push(rec)
  for (const v of Object.values(rec)) collectExemptions(v, out)
  return out
}

export interface RegisterInput {
  /** 文件名（相对 `scripts/baseline/`）→ 该文件里的全部豁免对象（只含 `kind=waiver` 的文件） */
  files: Record<string, Exemption[]>
  /**
   * 因 `_meta.kind` 非 waiver 而**整文件跳过**的文件名 → kind（ISS-818）。
   * 不参与豁免计数，只在 detail 里出声「跳过了 N 个非豁免文件」。
   */
  skippedFiles?: Record<string, BaselineKind>
  /**
   * 含豁免形状对象、但**缺合法 `_meta.kind`** 的文件名（ISS-818）。
   * 非空 ⇒ 红：不许靠目录/文件名猜语义。
   */
  missingKindFiles?: string[]
  /** 登记表里的上限（文件名 → 允许的无 expires 条数） */
  limits: Record<string, number>
  /**
   * 上一次提交里的上限（`git show HEAD:` 读出）。`null` = 读不到（首次入库 / 无 git），
   * 此时「只减不增」判不了 —— 跳过而不是判绿，理由写进 detail。
   */
  previousLimits?: Record<string, number> | null
  /** 读不了的文件（坏 JSON 等），只提示不判红（归别的判据） */
  unreadable?: string[]
  /**
   * 今天（`YYYY-MM-DD`，UTC）。**必须显式传入**：判据逻辑不许自己调 `Date.now()`，
   * 否则 spec 无法构造「昨天 / 明年」这类用例，测出来的只是「今天恰好成立」。
   * 缺省 = 当前 UTC 日期（生产路径由 `judge()` 填）。
   */
  today?: string
}

/** 纯函数：输入 → 判定。spec 直接喂构造数据，不碰文件系统。 */
export function judgeExemptionRegister(input: RegisterInput): GateResult {
  const findings: string[] = []
  const hints: string[] = []

  // ── ⓪ 缺 _meta.kind ⇒ 红（ISS-818：语义必须由文件显式声明，不许靠目录/文件名猜） ──
  const missingKind = input.missingKindFiles ?? []
  if (missingKind.length) {
    findings.push(
      `${BASE_REL}/：${missingKind.length} 个含豁免形状对象但缺合法 _meta.kind 的文件（${missingKind.join("、")}）` +
        `—— 必须显式声明 waiver/allowlist/frozen/ledger，不许靠目录猜（ISS-818）`,
    )
  }

  // ── ① 新增豁免必须带 expires ──
  for (const file of Object.keys(input.files).sort()) {
    const items = input.files[file]
    const missing = items.filter((x) => !x.expires).length
    const limit = input.limits[file] ?? 0
    if (missing > limit) {
      findings.push(`${BASE_REL}/${file}：${missing} 条无 expires 的豁免，上限 ${limit}（新增豁免必须带 expires；已有条目只许减不许增）`)
      continue
    }
    // 不红，只提示：上限高于实际 = 有人还了债但没降数。**降数不会自动发生**，不提示就永远挂着。
    if (limit > missing) hints.push(`${file}：上限 ${limit} 高于实际 ${missing}，可下调到 ${missing}`)
  }

  // ── ② grandfathered 只减不增（锚点 = 已提交的那份） ──
  if (input.previousLimits) {
    for (const file of Object.keys(input.previousLimits)) {
      const prev = input.previousLimits[file]
      const now = input.limits[file] ?? 0
      if (now > prev) findings.push(`${file}：上限 ${prev} → ${now}，只许降不许升（登记表只减不增）`)
    }
  } else {
    hints.push("读不到上一次提交的上限（首次入库或非 git 环境），「只减不增」本条未判")
  }

  // 登记表里有、盘上已无豁免的文件 —— 只提示（删条目是人的动作，不在这里红）
  const stray = Object.keys(input.limits).filter((f) => !(f in input.files))
  if (stray.length) hints.push(`上限表里有 ${stray.length} 个文件已无任何豁免，可删条目：${stray.join("、")}`)

  // ── ③ expires 到期判定 + ④ ticket 占位符（ISS-830） ──
  // 遍历文件里全部豁免（不只无 expires 的）：有 expires 的才轮到 ③ 判，但 ④ 对谁都适用。
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  const todayNum = toDayNumber(today)
  let expiredCount = 0
  let staleCount = 0
  let farCount = 0
  let ticketCount = 0

  for (const file of Object.keys(input.files).sort()) {
    for (const x of input.files[file]) {
      // ④ ticket 占位符 —— 独立于 expires 判：没填 expires 的条目也该把 ticket 写对
      const ticketRaw = x.ticket
      if (ticketRaw !== undefined && ticketRaw !== null && TICKET_PLACEHOLDER.test(String(ticketRaw).trim())) {
        ticketCount++
        findings.push(`${BASE_REL}/${file}：ticket 是占位符「${ticketRaw}」—— 必须指向真实单据（如 ISS-NNN）`)
      }

      // expires 的**存在性**归 ① 管，这里只管「填了之后对不对」
      if (!x.expires) continue
      const expires = String(x.expires)

      const num = toDayNumber(expires)
      if (num === null) {
        findings.push(`${BASE_REL}/${file}：expires 格式非法「${expires}」（应为 YYYY-MM-DD 且是真实存在的日期）`)
        continue
      }

      // 「伪装永久」：期限远到本世纪兑现不了，等于没有期限
      const years = Number(expires.slice(0, 4))
      const currentYear = DATE_RE.test(today) ? Number(today.slice(0, 4)) : new Date().getUTCFullYear()
      if (years > currentYear + MAX_YEARS_AHEAD) {
        farCount++
        findings.push(
          `${BASE_REL}/${file}：expires=${expires} 过于遥远（>${MAX_YEARS_AHEAD} 年）—— 「永不到期」的豁免等于永久豁免，请写真实可兑现的日期`,
        )
        continue
      }

      if (todayNum === null) {
        hints.push(`${BASE_REL}/${file}：today=「${today}」非法，到期判定未执行`)
        continue
      }

      const days = num - todayNum // 正 = 还剩几天，0 = 今天到期，负 = 已过期几天
      if (days < -GRACE_DAYS) {
        expiredCount++
        findings.push(
          `${BASE_REL}/${file}：豁免已过期 ${-days} 天（expires=${expires}，ticket=${x.ticket ?? "未登记"}）` +
            `—— 到期即红，续期须写明理由并改日期`,
        )
      } else if (days < 0) {
        staleCount++
        hints.push(
          `${BASE_REL}/${file}：豁免已过期 ${-days} 天（宽限 ${GRACE_DAYS} 天内只提示，超期即红）` +
            `（expires=${expires}，ticket=${x.ticket ?? "未登记"}）`,
        )
      }
    }
  }

  if (input.unreadable?.length) hints.push(`跳过 ${input.unreadable.length} 个读不了的文件（坏 JSON 归别的判据）：${input.unreadable.join("、")}`)

  // 非豁免文件出声（ISS-818）：跳过可以，但不许静默 —— 报出跳过了几个、各是什么 kind
  const skipped = input.skippedFiles ?? {}
  const skippedNames = Object.keys(skipped).sort()
  if (skippedNames.length) {
    const byKind = skippedNames.reduce<Record<string, number>>((acc, n) => {
      const k = skipped[n]
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {})
    const detail = skippedNames.map((n) => `${n}(${skipped[n]})`).join("、")
    hints.push(
      `跳过了 ${skippedNames.length} 个非豁免文件（${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join("、")}）：${detail}`,
    )
  }

  const files = Object.keys(input.files).length
  const totalMissing = Object.values(input.files).reduce((n, items) => n + items.filter((x) => !x.expires).length, 0)
  // 有 expires 的条数与到期判定结果一并报出：「判了多少条」不写清，绿也是含糊的绿
  const totalDated = Object.values(input.files).reduce((n, items) => n + items.filter((x) => x.expires).length, 0)
  const judgeBits: string[] = []
  if (expiredCount) judgeBits.push(`过期${expiredCount}`)
  if (farCount) judgeBits.push(`过远${farCount}`)
  if (ticketCount) judgeBits.push(`ticket 占位${ticketCount}`)
  if (staleCount) judgeBits.push(`宽限内${staleCount}`)

  // 「最近到期」——让人一眼看出有没有在还债（ISS-830 / Lead 追加）。
  // ⚠️ 这只是提示，**不参与绿/红**：它答「离下次红还有多久」，不答「合不合规」。
  let nearest = ""
  if (totalDated && todayNum !== null) {
    let best: { d: number; s: string } | null = null
    for (const items of Object.values(input.files)) {
      for (const x of items) {
        if (!x.expires) continue
        const s = String(x.expires)
        const n = toDayNumber(s)
        if (n === null) continue
        const d = n - todayNum
        if (d < 0) continue // 已过期的已由上面报过，这里只看「下一次到期」
        if (!best || d < best.d) best = { d, s }
      }
    }
    if (best) {
      nearest = `（最近到期 ${best.s}，还有 ${best.d} 天）`
    }
  }

  const summary =
    `${files} 个文件 / ${totalMissing} 条无 expires（上限合计 ${Object.values(input.limits).reduce((a, b) => a + b, 0)}）` +
    ` / ${totalDated} 条有 expires 已按 today=${today} 判` +
    (judgeBits.length ? `（${judgeBits.join("、")}）` : "（全部未过期）") +
    nearest

  if (findings.length) {
    return { gate: GATE, status: "failed", findings: findings.map((detail) => ({ detail })), detail: [summary, ...hints].join("；") }
  }
  return { gate: GATE, status: "passed", findings: [], detail: hints.length ? [summary, ...hints].join("；") : summary }
}

// ── IO ──────────────────────────────────────────────────────────────────────
function readRegister(): { limits: Record<string, number> } | null {
  const abs = path.join(REPO, REGISTER_REL)
  if (!fs.existsSync(abs)) return null
  const parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as { grandfathered?: Record<string, number> }
  return { limits: parsed.grandfathered ?? {} }
}

/** 已提交的上限。读不到（首次入库 / 无 git）⇒ null，不判绿也不判红。 */
function readPreviousLimits(): Record<string, number> | null {
  try {
    const out = execFileSync("git", ["-C", REPO, "show", `HEAD:${REGISTER_REL}`], {
      encoding: "utf8",
      maxBuffer: 8 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const parsed = JSON.parse(out) as { grandfathered?: Record<string, number> }
    return parsed.grandfathered ?? {}
  } catch {
    return null
  }
}

interface CollectedFiles {
  /** `kind=waiver` 且含豁免对象的文件 */
  files: Record<string, Exemption[]>
  /** 含豁免对象但 `kind` 非 waiver（allowlist/frozen/ledger）⇒ 整文件跳过并出声 */
  skippedFiles: Record<string, BaselineKind>
  /** 含豁免对象但缺合法 `_meta.kind` ⇒ 红 */
  missingKindFiles: string[]
  /** 读不了的（坏 JSON） */
  unreadable: string[]
}

function collectFiles(): CollectedFiles {
  const dir = path.join(REPO, BASE_REL)
  const files: Record<string, Exemption[]> = {}
  const skippedFiles: Record<string, BaselineKind> = {}
  const missingKindFiles: string[] = []
  const unreadable: string[] = []
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")) : []
  for (const name of names) {
    if (name === path.basename(REGISTER_REL)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
    } catch {
      unreadable.push(name)
      continue
    }
    const items = collectExemptions(parsed)
    // 没有豁免形状对象的文件本判据根本不数 —— 也就不要求它声明 kind（不然几十个纯账本都要补）
    if (!items.length) continue
    const kind = readBaselineKind(parsed)
    if (kind === null) {
      missingKindFiles.push(name)
    } else if (kind === "waiver") {
      files[name] = items
    } else {
      skippedFiles[name] = kind
    }
  }
  return { files, skippedFiles, missingKindFiles, unreadable }
}

function judge(): GateResult {
  const register = readRegister()
  if (!register) return unjudged(GATE, "no-baseline", `登记表不存在：${REGISTER_REL}（删掉它不许变成永久绿）`)
  const { files, skippedFiles, missingKindFiles, unreadable } = collectFiles()
  return judgeExemptionRegister({
    files,
    skippedFiles,
    missingKindFiles,
    limits: register.limits,
    previousLimits: readPreviousLimits(),
    unreadable,
    // 「今天」只在生产入口取一次：纯函数里不调 Date，spec 才能构造昨天/明年
    today: new Date().toISOString().slice(0, 10),
  })
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，spec 又静态 import 本文件
  //   ⇒ TLA 未结算时 spec 永远等它（unsettled top-level await, rc=13）。用 then 设 exitCode。
  runGate({ name: GATE, main: judge })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
