#!/usr/bin/env node
// review-ledger —— 审查质量台账（P-1 · 只读 · 只报）
//
// 为什么有它（设计稿 docs/review-independent-redesign-2026-10-06.md §4.6 / §8 P-1）：
// 仓里有 2000+ 张工单，但没有任何机制知道「审查到底发生了什么」——多少单进过 in_review 却没有
// 审查卡、多少单首轮就过、多少单审查后仍漏了缺陷。没有这些数字，「审查清单该加一条还是删一条」
// 只能靠感觉。本文件把 §4.6 的五项指标**现算**出来，一个数字都不预置。
//
// ⚠️ 本文件不改任何放行行为：不写库、不改状态、不参与 merge/auto-merge。回滚 = 删本文件。
//
// ── 三条正确性纪律（比指标本身更重要）────────────────────────────────────
// ① **读不到印 `?`，不印 0**：`?` 在 --json 里是 `null`（沿用 gate-fast.mjs:50-52 的 null 语义）。
//    「未判」与「真的是 0」必须是两个值——否则「没记录」会被读成「没问题」。
// ② **口径必须跟数字一起印**：数据根、时间界、分母、判据定义，全部进头部与 --json.caliber。
//    本仓踩过「review-pack.mjs 指错根（~/.dsh/pm 空壳）却照样出数」的坑（ISS-773）。
// ③ **不用代理口径糊数**：算不了就 `?` + --explain 写清缺哪个字段/哪段时间。
//    宁可「1 个真数 + 4 个 ?」，也不要 5 个编出来的数。
//
// ── 实测的数据形状（2026-11-09 于真根现读，不是照文档猜）──────────────────
// · 主单 = `issues/*.md` 排除 `-activity.md` / `-comments.md` 侧车；真根 ~2000 张、侧车 ~2000 份。
// · frontmatter 有 `status` / `created`(仅日期) / `write_scope`(部分) / `aiReview`(一行 JSON，部分)；
//   **没有 updatedAt**。`deleted: true` = 已删，排除。
// · 进审时间只能从侧车 `event: status-change` + `to: in_review` 取；`at` 存在**两派时间戳**
//   （`2026-08-19T12:19:30+08:00` 与 `2026-10-03T13:20:40.002Z`），本文件一律按绝对时刻归一。
// · 合格审查卡 = 六段骨架（§4.2）。实测全库 0 张六段卡 ⇒ 无卡率必然是 100%，这正是 D1 的读数。
//
// 用法：
//   node scripts/gates/review-ledger.mjs                     # 全量
//   node scripts/gates/review-ledger.mjs --since 2026-10-01  # 只算该日（本地 00:00）起进审的单
//   node scripts/gates/review-ledger.mjs --root <pm 目录>     # 换数据根（自检/隔离库）
//   node scripts/gates/review-ledger.mjs --json              # 机器可读（? ⇒ null）
//   node scripts/gates/review-ledger.mjs --explain           # 每项算不了的原因 + 无卡名单
//   node scripts/gates/review-ledger.mjs --selftest          # 两条阳性对照（不碰真根）
//
// 退出码：0 正常出账（含 ?）· 1 自检失败 · 2 判不了（根不可读 / 参数错）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ARGV = process.argv.slice(2)
const has = (n) => ARGV.includes(n)
const opt = (n, d = null) => {
  const i = ARGV.indexOf(n)
  return i < 0 ? d : (ARGV[i + 1] ?? '')
}
const DEFAULT_ROOT = path.join(os.homedir(), '.dsh-matter', 'pm')

// 六段审查卡骨架（§4.2）。段号 + 段名都要在同一行出现；只认段名会把正文里的「发现」误当卡。
const SEGMENTS = [
  { key: 'range', no: '①', label: '区间' },
  { key: 'ran', no: '②', label: '跑了什么' },
  { key: 'gate', no: '③', label: '门禁增量' },
  { key: 'criteria', no: '④', label: '准则核对' },
  { key: 'findings', no: '⑤', label: '发现' },
  { key: 'who', no: '⑥', label: '谁审的' },
]
const SEG_RE = SEGMENTS.map((s) => ({ ...s, re: new RegExp(`${s.no}[^\\n]{0,6}${s.label}`) }))

// ── 基础解析 ────────────────────────────────────────────────────────────────

/** frontmatter 正文（文件以 `---` 开头，取到下一个 `---` 行为止）。 */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  return m ? m[1] : ''
}

function field(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
  return m ? m[1].trim().replace(/^"(.*)"$/, '$1') : ''
}

/**
 * 时间戳归一。`at` 有两种写法（+08:00 / Z），Date.parse 都按绝对时刻处理；
 * `created` 只有日期（YYYY-MM-DD），按**本地**当日 00:00 解释 —— 与 --since 的起算点同一口径。
 * 解析不出 ⇒ null（调用方必须把 null 当「读不到」，不是 0）。
 */
function parseTs(s) {
  if (!s) return null
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (d) {
    const dt = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]))
    // 2026-13-45 会被 Date 静默归一成下一年 ⇒ 回读年月日，对不上就是读不到
    if (dt.getFullYear() !== Number(d[1]) || dt.getMonth() !== Number(d[2]) - 1 || dt.getDate() !== Number(d[3])) return null
    return dt.getTime()
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * 侧车事件流。只读每个块**头部**（第一个空行之前）—— 正文里的 `---` 与 `event:` 不算事件。
 * 返回 [{event, at, from, to, actor, body}]。
 */
function parseActivity(text) {
  // 事件块之间用 `\n---\n` 分隔，但**块正文里也可能有 `---`**（markdown 分隔线）。
  // 所以只把「`---` 后紧跟 `type: activity-log`」当成新块的开始，正文按区间截取 ——
  // 直接 split(/\n---\n/) 会把 agent-note 正文切掉，六段卡永远检测不到（实测踩过）。
  const starts = [...text.matchAll(/(?:^|\n)---\r?\n(?=type: activity-log\r?\n)/g)].map((m) => m.index + m[0].length)
  const out = []
  for (let k = 0; k < starts.length; k++) {
    const chunk = text.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : text.length)
    const lines = chunk.split(/\r?\n/)
    const sep = lines.findIndex((l) => l.trim() === '---')
    const kv = {}
    for (const line of (sep >= 0 ? lines.slice(0, sep) : lines)) {
      const m = line.match(/^([A-Za-z][\w-]*):\s?(.*)$/)
      if (m && !(m[1] in kv)) kv[m[1]] = m[2]
    }
    if (kv.type === 'activity-log' && kv.event) {
      out.push({
        event: kv.event, at: kv.at, from: kv.from, to: kv.to, actor: kv.actor,
        body: sep >= 0 ? lines.slice(sep + 1).join('\n') : '',
      })
    }
  }
  return out
}

/**
 * 六段骨架检测。缺一段 = 不合格，不做「大致齐全」的宽容 —— 宽容会让残缺卡静默变成有卡。
 * 段内容判定：标号+段名之后本行还有字，或下一非空行不是另一个段标（允许 `### ⑥ 谁审的` 换行写内容）。
 */
function cardSegments(note) {
  const lines = note.split('\n')
  const found = new Set()
  for (let i = 0; i < lines.length; i++) {
    for (const s of SEG_RE) {
      if (!s.re.test(lines[i])) continue
      const rest = lines[i].replace(s.re, '').replace(/[*#`：:、.\s]/g, '')
      if (rest.length > 0) {
        found.add(s.key)
        continue
      }
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      const next = j < lines.length ? lines[j] : ''
      if (next.trim() && !SEG_RE.some((x) => x.re.test(next))) found.add(s.key)
    }
  }
  return found
}

/** aiReview 是一行 JSON；截断/非 JSON = 读不到（null），不是「无判定」。 */
function parseAiReview(fm) {
  const raw = field(fm, 'aiReview').trim()
  if (!raw.startsWith('{')) return { value: null, raw, ok: false }
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? { value: v, raw, ok: true } : { value: null, raw, ok: false }
  } catch {
    return { value: null, raw, ok: false }
  }
}

const isIssueFile = (f) => f.endsWith('.md') && !/-activity\.md$|-comments\.md$/.test(f)

/** 读真根：返回每张主单的判定素材。readdirSync 用在**仓库外**的数据根（不是本仓文件的扫描面）。 */
function collect(root) {
  const dir = path.join(root, 'issues')
  if (!fs.existsSync(dir)) throw new Error(`数据根下没有 issues/：${dir}`)
  const files = fs.readdirSync(dir).filter(isIssueFile).sort()
  const issues = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    const fm = frontmatter(text)
    const id = field(fm, 'id') || f.match(/ISS-\d+|REV-\d+|DOC-\d+/)?.[0] || f.replace(/\.md$/, '')
    const deleted = field(fm, 'deleted') === 'true'
    const activityPath = path.join(dir, f.replace(/\.md$/, '-activity.md'))
    const events = fs.existsSync(activityPath) ? parseActivity(fs.readFileSync(activityPath, 'utf8')) : null
    issues.push({ file: f, id, fm, deleted, events })
  }
  return { dir, issues }
}

/** 单张单：进审时刻、卡、判定、轮次。所有「读不到」都留在 null 上，不补 0。 */
function inspect(issue) {
  const fm = issue.fm
  const status = field(fm, 'status')
  const events = issue.events // null = 没有侧车（≠ 没事件）
  const entries = (events || [])
    .filter((e) => e.event === 'status-change' && e.to === 'in_review')
    .map((e) => ({ at: parseTs(e.at), raw: e }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
  // 时间读不到的进审事件不能算进任何窗口，单独计数（不是「0 张」）
  const undatedEntries = entries.filter((e) => e.at === null).length
  const datedEntries = entries.map((e) => e.at).filter((t) => t !== null)

  const notes = (events || []).filter((e) => e.event === 'agent-note')
  const cards = [] // { at, segments }
  for (const n of notes) {
    const segs = cardSegments(n.body)
    if (segs.size === SEGMENTS.length) cards.push({ at: parseTs(n.at), segments: segs })
  }
  const ai = parseAiReview(fm)
  const reviewCreated = (events || []).filter((e) => e.event === 'review-created').length

  // 首轮通过：进审后没有被退回开发（in_review → in_progress），且第一条有效状态变更是 → done。
  // ⚠️ 先剔掉 from===to 的空迁移：实测有单在同一分钟连写两条 → in_review，按「进审次数」算会把
  //    一次通过误判成多轮。轮次语义看「有没有退回去」，不看「重复记了几条」。
  let firstPass = null
  if (events) {
    const changes = events
      .filter((e) => e.event === 'status-change' && e.from !== e.to && parseTs(e.at) !== null)
      .sort((a, b) => parseTs(a.at) - parseTs(b.at))
    const entryIdx = changes.findIndex((e) => e.to === 'in_review')
    if (entryIdx >= 0) {
      const after = changes.slice(entryIdx + 1)
      const bounced = after.some((e) => e.from === 'in_review' && e.to === 'in_progress')
      firstPass = !bounced && after[0]?.to === 'done'
    }
  }

  return {
    ...issue,
    status,
    created: parseTs(field(fm, 'created')),
    everInReview: datedEntries.length > 0 || undatedEntries > 0 || status === 'in_review',
    firstEntryAt: datedEntries.length ? datedEntries[0] : null,
    undatedEntries,
    cards,
    aiReview: ai,
    reviewCreated,
    firstPass,
  }
}

/**
 * 窗口三态：'in' / 'out' / 'unknown'。
 * 'out' 与 'unknown' 必须分开：前者是「有记录、明确在窗口外」，后者是「读不到，判不了」。
 * 把两者混成一个数，会让 --explain 的「未判」变成一个吓人的假数（实测踩过：504 张全是窗口外）。
 */
function windowState(x, sinceMs) {
  if (!x.everInReview) return 'out'
  if (x.firstEntryAt !== null) return sinceMs === null || x.firstEntryAt >= sinceMs ? 'in' : 'out'
  if (x.status === 'in_review') {
    if (sinceMs === null) return 'in'
    if (x.created === null) return 'unknown'
    // 当前在 in_review ⇒ 一定进过审；created 在窗口内 ⇒ 进审不可能早于窗口
    return x.created >= sinceMs ? 'in' : 'unknown'
  }
  return 'unknown'
}

// ── 指标 ────────────────────────────────────────────────────────────────────

function analyze(root, sinceMs) {
  const { dir, issues } = collect(root)
  const rows = issues.filter((i) => !i.deleted).map(inspect)
  const deleted = issues.length - rows.length
  const popped = rows.filter((r) => windowState(r, sinceMs) === 'in')
  const undetermined = rows.filter((r) => windowState(r, sinceMs) === 'unknown')

  const den = popped.length
  const withCard = popped.filter((r) => r.cards.length > 0).length
  const withAiVerdict = popped.filter((r) => r.aiReview.value?.verdict).length
  const withLegacyRev = popped.filter((r) => r.reviewCreated > 0).length
  const missingIds = popped.filter((r) => r.cards.length === 0).map((r) => r.id)

  const missingCardRate = den === 0
    ? null
    : {
        value: (den - withCard) / den,
        numerator: den - withCard,
        denominator: den,
        withCard,
        withAiVerdict,
        withLegacyRev,
        // aiReview / REV 单据都是旧路（aiReview 于 2026-10-20 废止），都不含六段 ⇒ 不计合格卡
        note: '合格卡 = agent-note 六段骨架（§4.2）。legacy aiReview 无六段，不计合格卡。',
      }

  const judged = popped.filter((r) => r.aiReview.value?.verdict === 'approved' || r.aiReview.value?.verdict === 'changes-requested')
  const firstApproved = judged.filter((r) => r.aiReview.value.verdict === 'approved' && r.firstPass === true)

  return {
    root: dir.replace(/\/issues$/, ''),
    issuesDir: dir,
    mainIssues: issues.length,
    deleted,
    population: den,
    undetermined: undetermined.length,
    metrics: {
      missingCardRate,
      missedDefectRate: {
        value: null,
        reason:
          '缺两类结构化字段：①「approved 合入」的机器时间点 —— PM 无 updatedAt，branch-merged 全库仅 2 条，多数单只有 commit 字段；' +
          '②「回炉/新提缺陷单命中同一改动面」的关联 —— relations 全库 135 条且只有 references 一种，无 caused-by/regression-of；' +
          'write_scope 仅 165 张有且是计划面，不是实际 diff 文件清单。现算只能靠关键词猜，会把「没记录」算成「没漏报」。',
      },
      falsePositiveRate: {
        value: null,
        reason:
          '缺 finding 级结构化记录：judgment-recorded（71 条）是**单据级**结论，不是单条 finding 的「不成立」标记；' +
          'agent-note 里的「不成立/误报」是自由文本，无法与作者自辩区分。按关键词计数会把噪声当数据。',
      },
      firstPassRate: {
        value: null,
        reason:
          `分母要求「派审单」，但只有 ${judged.length}/${den} 张有结构化 verdict（aiReview 已于 2026-10-20 废止）；` +
          '其余单「没判定」≠「未通过」。把无判定单算成通过 = 把 D1 的漏审洗成一次通过率。',
        lowerBound: judged.length ? { approvedFirst: firstApproved.length, judged: judged.length } : null,
      },
      gateCoverageRate: {
        value: null,
        reason:
          '审查卡 ② 段（跑了什么）全库 0 张 —— 六段骨架是 P0 才落的东西；' +
          'legacy aiReview.checks（28 条）是自由文本数组，无 cwd、无包归属、无退出码字段，' +
          '无法判「命令集覆盖了改动面」。按包名 grep 命令文本 = 用代理口径造假数。',
      },
    },
    missingCardIds: missingIds,
    undeterminedIds: undetermined.map((r) => r.id),
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────

const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`

// 中文按 2 列宽算，否则「无卡率」「一次通过率」两行永远对不齐。只用到常用 CJK 区段，够这张表。
const displayWidth = (s) => [...s].reduce((w, c) => w + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/.test(c) ? 2 : 1), 0)
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - displayWidth(s)))

function printReport(res, since, explain) {
  const rootSource = path.resolve(res.root) === path.resolve(DEFAULT_ROOT) ? '默认真根' : '--root 指定'
  console.log('review-ledger · 审查质量台账（P-1 · 只读，不改任何放行行为）')
  console.log('口径')
  console.log(`  数据根   ${res.root}（${rootSource}）`)
  console.log(`  主单     ${res.mainIssues} 张（排除 -activity/-comments 侧车；已删 ${res.deleted} 张不计）`)
  // 本仓有两个根：~/.dsh-matter/pm（真，约 2000 张）与 ~/.dsh/pm（空壳，2 张）。
  // 指错根时数字会「看起来正常地变成 0/2」——必须当场喊出来，不能等读者自己发现。
  if (res.mainIssues < 100) {
    console.log(`  ⚠ 警告   该根主单只有 ${res.mainIssues} 张（真根约 2000）—— 很可能是空壳根 ~/.dsh/pm，数字不可用`)
  }
  console.log(`  时间界   ${since ? `--since ${since}（本地时区 00:00 起算，按进审时刻）` : '全量（未设 --since）'}`)
  console.log(`  派审单   ${res.population} 张（判定 = 侧车 status-change → in_review；当前 in_review 无事件者按 created 归窗）`)
  console.log(`  未判     ${res.undetermined} 张（进过 in_review 但进审时刻读不到，且无法归入本窗口 ⇒ 不计入任何分母）`)
  console.log('  时间戳   +08:00 与 Z 两派按绝对时刻归一；created 只有日期（YYYY-MM-DD）')
  console.log('')

  const m = res.metrics
  const line = (name, text) => console.log(`  ${pad(name, 14)} ${text}`)

  if (m.missingCardRate) {
    const r = m.missingCardRate
    line('无卡率', `${pct(r.value)}（${r.denominator} 张派审单里 ${r.numerator} 张无六段审查卡；有卡 ${r.withCard} 张）`)
    if (explain) {
      console.log(`               · ${r.note}`)
      console.log(`               · 同期 legacy aiReview 判定 ${r.withAiVerdict} 张 / 历史 REV 审查单 ${r.withLegacyRev} 张；两者都不含六段且 aiReview 已于 2026-10-20 废止 ⇒ 不计合格卡`)
    }
  } else {
    line('无卡率', '?')
    if (explain) console.log('               · 本窗口内没有可判定的派审单（分母 0）⇒ 不印 0')
  }

  const unknown = [
    ['漏报率', m.missedDefectRate],
    ['误报率', m.falsePositiveRate],
    ['一次通过率', m.firstPassRate],
    ['门禁实跑率', m.gateCoverageRate],
  ]
  for (const [name, v] of unknown) {
    if (v.value === null) {
      line(name, '?')
      if (explain) {
        console.log(`               · 为什么算不了：${v.reason}`)
        if (v.lowerBound) {
          console.log(`               · 可判子集（不当作指标）：${v.lowerBound.judged} 张有 verdict，其中 ${v.lowerBound.approvedFirst} 张首轮 approved`)
        }
      }
    } else {
      line(name, pct(v.value))
    }
  }

  if (explain && res.missingCardIds.length) {
    console.log('')
    console.log(`无卡名单（${res.missingCardIds.length} 张，前 20）`)
    console.log('  ' + res.missingCardIds.slice(0, 20).join(' · '))
    if (res.missingCardIds.length > 20) console.log(`  … 另 ${res.missingCardIds.length - 20} 张见 --json`)
  }
  if (explain && res.undeterminedIds.length) {
    console.log('')
    console.log(`时间未判名单（${res.undeterminedIds.length} 张，前 20）`)
    console.log('  ' + res.undeterminedIds.slice(0, 20).join(' · '))
  }
}

function toJson(res, since) {
  return {
    tool: 'review-ledger',
    version: 1,
    generatedAt: new Date().toISOString(),
    since: since ?? null,
    caliber: {
      root: res.root,
      issuesDir: res.issuesDir,
      mainIssues: res.mainIssues,
      warning: res.mainIssues < 100 ? `该根主单只有 ${res.mainIssues} 张（真根约 2000）—— 很可能是空壳根 ~/.dsh/pm，数字不可用` : null,
      deleted: res.deleted,
      population: res.population,
      undetermined: res.undetermined,
      populationDefinition: '进入过 in_review 的未删单；进审时刻取侧车 status-change → in_review，当前 in_review 且无事件时按 created 归窗',
      cardDefinition: 'agent-note 六段骨架：①区间 ②跑了什么 ③门禁增量 ④准则核对 ⑤发现 ⑥谁审的（缺段即不合格）',
      timestampRule: '+08:00 与 Z 均按绝对时刻；created 仅日期，按本地 00:00；--since 为本地当日 00:00（含）',
      nullMeans: '? = 读不到/判不了；与 0 严格区分',
    },
    metrics: res.metrics,
    missingCardIds: res.missingCardIds,
    undeterminedIds: res.undeterminedIds,
  }
}

// ── 自检：两条阳性对照（判据没牙 = 没判据）─────────────────────────────────
//
// A 防「解析没命中却静默返回 0」——最典型的假绿。
// B 防「残缺卡被当成有卡」——六段判据被宽松成「有字就算」。
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ledger-'))
  const results = []
  const mkRoot = (name) => {
    const root = path.join(tmp, name)
    fs.mkdirSync(path.join(root, 'issues'), { recursive: true })
    return root
  }
  try {
    const writeIssue = (root, n, status) => {
      const dir = path.join(root, 'issues')
      const id = `ISS-${9000 + n}`
      const base = `2026-10-0${(n % 9) + 1}-${id}-fixture`
      fs.writeFileSync(
        path.join(dir, `${base}.md`),
        `---\ntype: issue\ntitle: fixture ${n}\nid: ${id}\nstatus: ${status}\ncreated: 2026-10-01\n---\nfixture body\n`,
      )
      fs.writeFileSync(
        path.join(dir, `${base}-activity.md`),
        `---\ntype: activity-log\nfor: issues/${base}.md\n---\n\n---\ntype: activity-log\nfor: issues/${base}.md\nevent: status-change\nat: 2026-10-02T10:00:0${n % 10}+08:00\nactor: fixture\nfrom: in_progress\nto: in_review\n---\n`,
      )
      return base
    }
    const addNote = (root, base, body) => {
      fs.appendFileSync(
        path.join(root, 'issues', `${base}-activity.md`),
        `\n---\ntype: activity-log\nfor: issues/${base}.md\nevent: agent-note\nat: 2026-10-02T11:00:00+08:00\nactor: reviewer\n---\n${body}`,
      )
    }

    // 样本 A：10 张全部进过 in_review、全部无卡 ⇒ 必须 100%
    const rootA = mkRoot('a')
    for (let i = 0; i < 10; i++) writeIssue(rootA, i, i < 5 ? 'done' : 'in_review')
    const a = analyze(rootA, null).metrics.missingCardRate
    const aOk = a !== null && a.denominator === 10 && a.numerator === 10 && a.value === 1
    results.push({ name: '样本 A（10 张全进过 in_review · 全无卡）', ok: aOk, got: a ? `${pct(a.value)}（${a.numerator}/${a.denominator}）` : '?', why: aOk ? '' : '假绿：解析没命中却静默返回 0/? —— 无卡率必须报 100%' })

    // 样本 B：5 张，2 张有完整六段卡；3 张的判据字段被删（无侧车、只有当前 in_review）⇒
    // 那 3 张的时间读不到，必须退出分母（不是算成「有卡」，也不是算成「无卡」）。
    const rootB = mkRoot('b')
    const full = SEGMENTS.map((s) => `${s.no} ${s.label}：fixture 内容`).join('\n')
    for (let i = 10; i < 12; i++) {
      const base = writeIssue(rootB, i, 'done')
      addNote(rootB, base, full)
    }
    for (let i = 12; i < 15; i++) {
      const id = `ISS-${9000 + i}`
      fs.writeFileSync(
        path.join(rootB, 'issues', `2026-09-01-${id}-lost-fields.md`),
        `---\ntype: issue\ntitle: 残缺 ${i}\nid: ${id}\nstatus: in_review\ncreated: 2026-09-01\n---\n判据字段被删（无 activity 侧车）\n`,
      )
    }
    const bRes = analyze(rootB, parseTs('2026-10-01'))
    const b = bRes.metrics.missingCardRate
    const bOk = b !== null && b.withCard === 2 && b.denominator === 2 && (b.value === 0 || b.value === null) && bRes.undetermined === 3
    results.push({ name: '样本 B（5 张里 3 张判据字段被删）', ok: bOk, got: b ? `有卡 ${b.withCard} / 分母 ${b.denominator} / 未判 ${bRes.undetermined}` : '?', why: bOk ? '' : '残缺的 3 张必须退出分母（未判），不能算成有卡、也不能算成无卡' })

    // 样本 C（附加牙口）：3 张卡缺第 ⑥ 段 ⇒ 缺段即不合格，不得因为「有五行」就算有卡。
    const rootC = mkRoot('c')
    for (let i = 20; i < 25; i++) {
      const base = writeIssue(rootC, i, 'done')
      const body = i < 22 ? full : SEGMENTS.filter((s) => s.key !== 'who').map((s) => `${s.no} ${s.label}：fixture 内容`).join('\n')
      addNote(rootC, base, body)
    }
    const c = analyze(rootC, null).metrics.missingCardRate
    const cOk = c !== null && c.withCard === 2 && c.denominator === 5 && c.value === 0.6
    results.push({ name: '样本 C（5 张里 3 张卡缺第 ⑥ 段）', ok: cOk, got: c ? `有卡 ${c.withCard} / 分母 ${c.denominator} / 无卡率 ${pct(c.value)}` : '?', why: cOk ? '' : '残缺卡被当成有卡 —— 缺段必须判不合格' })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  console.log('review-ledger --selftest（真根零接触，fixture 在临时目录）')
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} ⇒ ${r.got}${r.why ? `\n      ${r.why}` : ''}`)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `✗ ${results.length - failed}/${results.length} 通过` : `✓ ${results.length}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  if (has('--selftest')) selftest()

  const root = path.resolve(opt('--root', DEFAULT_ROOT))
  if (has('--root') && !opt('--root')) {
    console.error('✗ --root 缺少路径')
    process.exit(2)
  }
  const sinceRaw = opt('--since', null)
  if (sinceRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw)) {
    console.error(`✗ --since 需要 YYYY-MM-DD，收到「${sinceRaw}」`)
    process.exit(2)
  }
  const sinceMs = sinceRaw ? parseTs(sinceRaw) : null

  let res
  try {
    res = analyze(root, sinceMs)
  } catch (e) {
    console.error(`✗ 判不了：${e.message}`)
    console.error('  没有出数 —— 读不到根时印 0 或空表都是假绿。')
    process.exit(2)
  }

  if (has('--json')) {
    console.log(JSON.stringify(toJson(res, sinceRaw), null, 2))
  } else {
    printReport(res, sinceRaw, has('--explain'))
  }
  process.exit(0)
}

main()
