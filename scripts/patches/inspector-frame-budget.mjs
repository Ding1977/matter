#!/usr/bin/env node
/**
 * Inspector 状态帧预算补丁 —— 让「collector 剪过的 payload」与「setState 收得下的 record」
 * 用同一个量，并把超限从「抛未捕获异常」改成「跳过本轮」（ISS-686）
 *
 * ## 事故形态（2026-11-03，一天两次，整个宿主进程退出）
 *
 *   publishCordisTree 的 queueMicrotask 回调
 *     → publisher.setState(CORDIS_TREE_TOPIC, snapshot)
 *     → InspectorSourceBuffer.setState 抛 Error
 *     → 微任务里无人 catch
 *     → dsh-app-boot installFailLoud 的 uncaughtException → proc.exit(1)
 *     → 3210 死，**所有会话一起死**（老板：「怎么linmo的会话没有了」）
 *
 * ## 根因：同一件事被两个判据用不同的量算，预算被扣了两次
 *
 *   collector（index.js:2404）  maxBytes = maxSourceFrameBytes - 4096 = 126976，剪**裸 snapshot**
 *   setState（index.js:1083）   jsonByteLength([...state.values()]) + 4096 <= maxFrameBytes，量**包装后的 record**
 *
 *   裸 snapshot 顶到 126976 时，包装成 {monotonicMs,topic,payload} 后是 127041（实测差额 65~66）
 *   ⇒ 126976 - 127041 = -65 ⇒ **只要树剪到顶格，必然抛。确定性失败，不是偶发。**
 *
 * ## 改法（两层，两层都要）
 *
 *   ① 治本：抽 stateRecordBytes / statePayloadBudgetBytes，**只有一处定义预算**；
 *      collector 的 maxBytes 改成 statePayloadBudgetBytes(...)（扣包装开销 + 留 256 字节余量）。
 *      判据：一个 payload 在 collector 侧通过 ⇒ 在 setState 侧必然也通过。
 *   ② 兜底：setState 超限时保留上一版 state、跳过本轮 enqueue、返回 false，**不 throw**。
 *      上限仍然在（不是「悄悄无限扩张」），只是失败姿态从「抛」改成「跳过」。
 *      降级可观测：同一话题每次降级回合 console.warn 一次（恢复后重新计回合，不刷屏）。
 *
 * ## ⛔ 明确不做的
 *
 *   - 不动 DEFAULT_MAX_SOURCE_FRAME_BYTES（131072）：那只是把阈值挪开，树继续长还会撞；
 *     而且它同时约束 query 帧与 body chunk 校验（index.js:1800），动了会波及别处。
 *   - 不动 SOURCE_FRAME_OVERHEAD_BYTES（4096）、record/enqueue/takeBatch 的语义、对外协议。
 *   - 不手改 node_modules：node_modules 重装/升级即丢且不在版本控制里，**手改等于没改**。
 *     所以补丁落在本脚本里，由 restart-matter.sh 每次重启幂等重放（同 team-tools 的形态）。
 *
 * 用法：
 *   node scripts/patches/inspector-frame-budget.mjs --check    # 只报告状态（+行为断言），不改盘
 *   node scripts/patches/inspector-frame-budget.mjs            # 幂等应用（已应用则跳过）+ 行为断言
 *   node scripts/patches/inspector-frame-budget.mjs --revert   # 从备份还原
 *   node scripts/patches/inspector-frame-budget.mjs --probe    # 只跑边界探针并打印（不改盘、不判绿）
 *
 * 关键纪律（team-tools.mjs 顶部 ISS-634 的教训，本单同样适用）：
 *   **替换成功 ≠ 行为正确。** 所以应用完必须跑行为断言：拿真实的 InspectorSourceBuffer，
 *   构造 jsonByteLength([record]) 恰好压线的 payload，验证「修前必抛、修后不抛且上一版 state 仍在」，
 *   再跑一遍真实 Cordis 树（queueMicrotask → setState 的原路径）确认不再有未捕获异常。
 *
 * 运行时根目录可用环境变量覆盖：DSH_RUNTIME_ROOT（默认 <dsh>）
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUNTIME = process.env.DSH_RUNTIME_ROOT ?? '<dsh>'
const NM = join(RUNTIME, 'node_modules/@deepseek-ai')
const PKG_DIR = join(NM, 'dsh-experimental-inspector')
const HOST = join(PKG_DIR, 'lib/index.js')
const CLIENT = join(PKG_DIR, 'lib/client.js')
// 备份目录必须跟运行时根**同源**（team-tools.mjs 头部的规则）：临时沙箱自测
// （DSH_RUNTIME_ROOT=/tmp/...）若共用真实备份，--revert 会把真实运行时的原始文件
// 拷进沙箱，往返验证就成了假绿。
const BACKUP = process.env.DSH_PATCH_BACKUP
  ?? (process.env.DSH_RUNTIME_ROOT === void 0
    ? join(process.env.HOME ?? '/tmp', '.dsh-matter/inspector-patch-backup')
    : join(RUNTIME, '.inspector-patch-backup'))

// ── 与写入运行时的那份**逐字相同**的常量（只用于探针复算；断言里还会拿真实 collector
//    产出的快照与真实 buffer 交叉核对，复写不作为唯一判据）────────────────────
const SOURCE_FRAME_OVERHEAD_BYTES = 4096
const STATE_MONOTONIC_SENTINEL = 1.7976931348623157e+308
const STATE_PAYLOAD_BUDGET_MARGIN_BYTES = 256
const CORDIS_TREE_TOPIC = 'cordis/tree'
const DEFAULT_MAX_SOURCE_FRAME_BYTES = 128 * 1024

// ── 缩进基准（实测，不是猜的）────────────────────────────────────────────
//   index.js：顶层 0 tab · 类成员 1 tab   → setState 行 1 tab，函数体 2 tab
//   client.js：在 factory 闭包里 +2 tab   → 顶层 2 tab · 类成员 3 tab，函数体 4 tab
const T = '\t'
const HOST_MEMBER = T             // 1 tab
const CLIENT_MEMBER = T + T + T   // 3 tabs
const HOST_TOP = ''               // SOURCE_FRAME_OVERHEAD_BYTES 所在缩进（模块顶层，0 tab）
const CLIENT_TOP = T + T          // 2 tabs

/** 六个补丁共用的 helper 文本（indent = 顶层缩进，member = 类成员缩进）*/
function helperBlock(indent) {
  const lines = [
    `${indent}const SOURCE_FRAME_OVERHEAD_BYTES = 4096;`,
    ``,
    `${indent}/**`,
    `${indent}* Encoded bytes one retained state record occupies once wrapped as`,
    `${indent}* \`{"monotonicMs":…,"topic":…,"payload":…}\` and placed in the state array.`,
    `${indent}* The Cordis collector and {@link InspectorSourceBuffer.stateFits} must measure the same`,
    `${indent}* quantity: pruning a bare payload while admitting only wrapped records left a fixed`,
    `${indent}* ~65-byte gap, so a snapshot pruned to the ceiling was always rejected (ISS-686).`,
    `${indent}* @param topic - Declared state topic.`,
    `${indent}* @param payload - Lossless JSON payload.`,
    `${indent}* @param monotonicMs - Finite source-clock timestamp.`,
    `${indent}* @returns Byte length of the one-record state array that would retain it.`,
    `${indent}*/`,
    `${indent}function stateRecordBytes(topic, payload, monotonicMs) {`,
    `${indent}${T}return jsonByteLength([{ monotonicMs, topic, payload }]);`,
    `${indent}}`,
    `${indent}/** Widest text a finite monotonic clock reading can occupy; over-estimates real readings. */`,
    `${indent}const STATE_MONOTONIC_SENTINEL = 1.7976931348623157e+308;`,
    `${indent}/** Headroom kept on top of the wrapping overhead so the two sides never meet exactly. */`,
    `${indent}const STATE_PAYLOAD_BUDGET_MARGIN_BYTES = 256;`,
    `${indent}/**`,
    `${indent}* Byte budget a payload may occupy so its wrapped record still fits one source frame.`,
    `${indent}* Payload pruners call this instead of re-deriving the number: this is the only definition.`,
    `${indent}* @param maxFrameBytes - Transport frame limit (the source's \`maxFrameBytes\`).`,
    `${indent}* @param topic - State topic the payload will be published under.`,
    `${indent}* @returns Allowed payload bytes: \`maxFrameBytes\` minus the frame overhead, the record`,
    `${indent}* wrapping overhead and a safety margin.`,
    `${indent}*/`,
    `${indent}function statePayloadBudgetBytes(maxFrameBytes, topic) {`,
    `${indent}${T}const wrapper = stateRecordBytes(topic, null, STATE_MONOTONIC_SENTINEL) - jsonByteLength(null);`,
    `${indent}${T}return maxFrameBytes - SOURCE_FRAME_OVERHEAD_BYTES - wrapper - STATE_PAYLOAD_BUDGET_MARGIN_BYTES;`,
    `${indent}}`,
    `${indent}/** Topics whose latest state update degraded; keeps the warning to one line per episode. */`,
    `${indent}const degradedStateTopics = /* @__PURE__ */ new Set();`,
  ]
  return lines.join('\n')
}

/** setState 的替换体：超限降级（保留上一版 state、跳过 enqueue、返回 false、不抛） */
function setStateBody(member) {
  const body = member + T
  const inner = body + T
  return [
    `${member}setState(topic, payload, monotonicMs) {`,
    `${body}const record = this.record(topic, payload, monotonicMs);`,
    `${body}const previous = this.state.get(topic);`,
    `${body}this.state.set(topic, record);`,
    `${body}if (!this.stateFits()) {`,
    `${inner}if (previous === void 0) this.state.delete(topic);`,
    `${inner}else this.state.set(topic, previous);`,
    `${inner}// ISS-686：少刷一帧的代价近乎零，带走整个宿主的代价是当天所有会话。`,
    `${inner}// 上限仍然在 —— 保留上一版 state、本轮不 enqueue，但不抛。`,
    `${inner}if (!degradedStateTopics.has(topic)) {`,
    `${inner}${T}degradedStateTopics.add(topic);`,
    `${inner}${T}console.warn(\`dsh inspector: state topic \${JSON.stringify(topic)} exceeds the source-frame byte limit; keeping the previous value and skipping this update\`);`,
    `${inner}}`,
    `${inner}return false;`,
    `${body}}`,
    `${body}degradedStateTopics.delete(topic);`,
    `${body}this.enqueue(record);`,
    `${body}return true;`,
    `${member}}`,
  ].join('\n')
}

const EDITS = [
  // ── 补丁 ①：预算只留一处定义（index.js）──────────────────────────────
  {
    id: 'budget.helper.host',
    file: HOST,
    probe: `${HOST_TOP}function stateRecordBytes(topic, payload, monotonicMs) {`,
    old: `${HOST_TOP}const SOURCE_FRAME_OVERHEAD_BYTES = 4096;`,
    next: helperBlock(HOST_TOP),
  },
  // ── 补丁 ②：超限降级而非抛（index.js 的 InspectorSourceBuffer.setState）──
  {
    id: 'degrade.setState.host',
    file: HOST,
    probe: `${HOST_MEMBER}${T}return false;`,
    old: [
      `${HOST_MEMBER}setState(topic, payload, monotonicMs) {`,
      `${HOST_MEMBER}${T}const record = this.record(topic, payload, monotonicMs);`,
      `${HOST_MEMBER}${T}const previous = this.state.get(topic);`,
      `${HOST_MEMBER}${T}this.state.set(topic, record);`,
      `${HOST_MEMBER}${T}if (!this.stateFits()) {`,
      `${HOST_MEMBER}${T}${T}if (previous === void 0) this.state.delete(topic);`,
      `${HOST_MEMBER}${T}${T}else this.state.set(topic, previous);`,
      `${HOST_MEMBER}${T}${T}throw new Error("inspector: source state exceeds the source-frame byte limit");`,
      `${HOST_MEMBER}${T}}`,
      `${HOST_MEMBER}${T}this.enqueue(record);`,
      `${HOST_MEMBER}}`,
    ].join('\n'),
    next: setStateBody(HOST_MEMBER),
  },
  // ── 补丁 ③：collector 预算改用同一处定义（index.js 调用点，4 tab）────────
  {
    id: 'budget.collector.host',
    file: HOST,
    probe: `${T}${T}${T}${T}maxBytes: statePayloadBudgetBytes(spec.maxSourceFrameBytes, CORDIS_TREE_TOPIC)`,
    old: `${T}${T}${T}${T}maxBytes: spec.maxSourceFrameBytes - 4096`,
    next: `${T}${T}${T}${T}maxBytes: statePayloadBudgetBytes(spec.maxSourceFrameBytes, CORDIS_TREE_TOPIC)`,
  },

  // ── 补丁 ④⑤⑥：client.js 里的同构副本 ────────────────────────────────
  {
    id: 'budget.helper.client',
    file: CLIENT,
    probe: `${CLIENT_TOP}function stateRecordBytes(topic, payload, monotonicMs) {`,
    old: `${CLIENT_TOP}const SOURCE_FRAME_OVERHEAD_BYTES = 4096;`,
    next: helperBlock(CLIENT_TOP),
  },
  {
    id: 'degrade.setState.client',
    file: CLIENT,
    probe: `${CLIENT_MEMBER}${T}return false;`,
    old: [
      `${CLIENT_MEMBER}setState(topic, payload, monotonicMs) {`,
      `${CLIENT_MEMBER}${T}const record = this.record(topic, payload, monotonicMs);`,
      `${CLIENT_MEMBER}${T}const previous = this.state.get(topic);`,
      `${CLIENT_MEMBER}${T}this.state.set(topic, record);`,
      `${CLIENT_MEMBER}${T}if (!this.stateFits()) {`,
      `${CLIENT_MEMBER}${T}${T}if (previous === void 0) this.state.delete(topic);`,
      `${CLIENT_MEMBER}${T}${T}else this.state.set(topic, previous);`,
      `${CLIENT_MEMBER}${T}${T}throw new Error("inspector: source state exceeds the source-frame byte limit");`,
      `${CLIENT_MEMBER}${T}}`,
      `${CLIENT_MEMBER}${T}this.enqueue(record);`,
      `${CLIENT_MEMBER}}`,
    ].join('\n'),
    next: setStateBody(CLIENT_MEMBER),
  },
  {
    id: 'budget.collector.client',
    file: CLIENT,
    probe: `${T}${T}${T}${T}${T}${T}maxBytes: statePayloadBudgetBytes(bootstrap.maxFrameBytes, CORDIS_TREE_TOPIC)`,
    old: `${T}${T}${T}${T}${T}${T}maxBytes: bootstrap.maxFrameBytes - 4096`,
    next: `${T}${T}${T}${T}${T}${T}maxBytes: statePayloadBudgetBytes(bootstrap.maxFrameBytes, CORDIS_TREE_TOPIC)`,
  },
]

// ── 骨架（照抄 team-tools.mjs 的 check / apply / revert 纪律）─────────────────
const args = new Set(process.argv.slice(2))
const mode = args.has('--check') ? 'check' : args.has('--revert') ? 'revert' : args.has('--probe') ? 'probe' : 'apply'

function preStates(edit) {
  return Array.isArray(edit.old) ? edit.old : [edit.old]
}

function readOrFail(file) {
  if (!existsSync(file)) {
    console.error(`✗ 找不到 ${file}\n  运行时根目录不对？用 DSH_RUNTIME_ROOT=... 指定。`)
    process.exit(3)
  }
  return readFileSync(file, 'utf8')
}

function patchFiles() {
  return [...new Set(EDITS.map((edit) => edit.file))]
}

function loadTexts() {
  return new Map(patchFiles().map((file) => [file, readOrFail(file)]))
}

function backupName(file) {
  return file.split('/node_modules/@deepseek-ai/')[1].replaceAll('/', '__')
}

function doBackup(file) {
  mkdirSync(BACKUP, { recursive: true })
  const dest = join(BACKUP, backupName(file))
  if (!existsSync(dest)) copyFileSync(file, dest)
  return dest
}

function revert() {
  let n = 0
  for (const file of patchFiles()) {
    const src = join(BACKUP, backupName(file))
    if (!existsSync(src)) {
      console.log(`- 无备份，跳过 ${file}`)
      continue
    }
    copyFileSync(src, file)
    n += 1
    console.log(`↩ 已回滚 ${file}`)
  }
  const total = patchFiles().length
  console.log(n === total
    ? `回滚完成（${n} 个文件，备份为首次补丁前的原始文件）`
    : `⚠️ 回滚不完整（${n}/${total}）：缺备份的文件保持现状`)
}

/**
 * 解析「这条补丁在当前文本上该做什么」。
 * @returns {{state:'applied'|'missing'|'partial'|'mismatch', pairs:Array, hits:number}}
 */
function inspectEdit(edit, hay) {
  const expected = edit.count ?? 1
  const probeHits = hay.split(edit.probe).length - 1
  if (probeHits === expected) return { state: 'applied', pairs: [], hits: probeHits }
  if (probeHits > 0) return { state: 'partial', pairs: [], hits: probeHits }

  const olds = preStates(edit)
  const nexts = Array.isArray(edit.next) ? edit.next : olds.map(() => edit.next)
  if (Array.isArray(edit.next) && edit.next.length !== olds.length) {
    throw new Error(`${edit.id}: old/next 数组长度不一致（${olds.length} vs ${nexts.length}）`)
  }
  const matched = olds
    .map((old, index) => ({ old, next: nexts[index], hits: hay.split(old).length - 1 }))
    .filter((entry) => entry.hits > 0)
  // 两个前态同时命中 ⇒ 语义不清（一处已换、另一处还没），不做猜测
  if (matched.length !== 1) return { state: 'mismatch', pairs: [], hits: matched.length }
  if (matched[0].hits !== expected) return { state: 'mismatch', pairs: [], hits: matched[0].hits }
  return { state: 'missing', pairs: matched, hits: matched[0].hits }
}

function check() {
  const texts = loadTexts()
  let applied = 0
  let missing = 0
  let conflict = 0
  for (const edit of EDITS) {
    const hay = texts.get(edit.file)
    const expected = edit.count ?? 1
    const outcome = inspectEdit(edit, hay)
    // probe 只命中一次就判「已应用」是假绿（ISS-634 审查 C1）；这里逐条比对次数。
    if (outcome.state === 'applied') {
      applied += 1
      continue
    }
    if (outcome.state === 'partial') {
      conflict += 1
      console.log(`✗ 半截补丁 ${edit.id}：probe 命中 ${outcome.hits}/${expected}（部分站点已打，必须人工核对）`)
      continue
    }
    if (outcome.state === 'missing') {
      missing += 1
      console.log(`· 未应用 ${edit.id}`)
      continue
    }
    conflict += 1
    console.log(`✗ 锚点失配 ${edit.id}（期望 ${expected} 处前态；实际命中 ${outcome.hits} 个前态分组，上游可能已改）`)
  }
  console.log(`\n补丁状态：已应用 ${applied}/${EDITS.length}，缺失 ${missing}，锚点失配 ${conflict}`)
  return missing === 0 && conflict === 0 ? 0 : 1
}

function apply() {
  const texts = loadTexts()
  const todo = []
  for (const edit of EDITS) {
    const hay = texts.get(edit.file)
    const expected = edit.count ?? 1
    const outcome = inspectEdit(edit, hay)
    if (outcome.state === 'applied') continue
    if (outcome.state === 'partial') {
      console.error(`✗ 中止 ${edit.id}：半截补丁（probe 命中 ${outcome.hits}/${expected}），先人工核对再重跑`)
      process.exit(2)
    }
    if (outcome.state === 'mismatch') {
      console.error(`✗ 中止 ${edit.id}：锚点期望 ${expected} 处，实际命中 ${outcome.hits} 个前态分组`)
      console.error('  未写入任何文件。上游版本可能已变，请人工核对。')
      process.exit(2)
    }
    todo.push({ edit, pair: outcome.pairs[0] })
  }
  if (todo.length === 0) {
    console.log('✓ 补丁已在位，无需改动')
    return
  }
  for (const file of texts.keys()) doBackup(file)
  for (const { edit, pair } of todo) {
    const before = texts.get(edit.file)
    texts.set(edit.file, before.split(pair.old).join(pair.next))
    console.log(`+ ${edit.id}`)
  }
  for (const [file, text] of texts) writeFileSync(file, text, 'utf8')
  console.log(`✓ 已应用 ${todo.length} 处（备份在 ${BACKUP}）`)
}

// ── 行为断言 ────────────────────────────────────────────────────────────────

const enc = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength
/** 一个 payload 包装成 state record 后的字节数（探针自己算，不借被补对象的 helper） */
const wrappedBytes = (topic, payload, monotonicMs) => enc([{ monotonicMs, topic, payload }])
/** 与打在运行时里的 statePayloadBudgetBytes 同式复算（仅当宿主没导出时才用） */
const legacyBudget = (maxFrameBytes) => maxFrameBytes - SOURCE_FRAME_OVERHEAD_BYTES

/**
 * 宿主侧：把 index.js 的**当前磁盘内容**拷成同目录临时 ESM，追加测试用导出后 import。
 * 同目录是为了让它的裸导入（@deepseek-ai/schemastery 等）按原样解析。
 * @returns {{mod: object, cleanup: () => void}}
 */
async function loadHostForProbe() {
  const text = readOrFail(HOST)
  const extra = [
    'export { InspectorSourceBuffer, publishCordisTree, SOURCE_FRAME_OVERHEAD_BYTES as __overhead };',
  ]
  // 打了补丁才导得出来（未打时这个名字不存在，静态导出会在链接期抛错）
  if (text.includes(`${HOST_TOP}function statePayloadBudgetBytes(`)) {
    extra.push('export { statePayloadBudgetBytes as __budget, STATE_PAYLOAD_BUDGET_MARGIN_BYTES as __margin };')
  }
  const tmp = join(PKG_DIR, 'lib', `.probe-1823-${String(process.pid)}.mjs`)
  try {
    writeFileSync(tmp, `${text}\n${extra.join('\n')}\n`, 'utf8')
    const mod = await import(pathToFileURL(tmp).href)
    return { mod, cleanup: () => { try { unlinkSync(tmp) } catch {} } }
  } catch (error) {
    try { unlinkSync(tmp) } catch {}
    throw error
  }
}

/**
 * 客户端侧：client.js 是 `window.__ModuleLoader__.load({factory})` 的浏览器形态，不能直接
 * import 出内部类。做法：把它拷成**同目录临时 ESM 副本**（磁盘上的原件一个字节不动），
 * 只在副本里、于 `exports.name = name;` 之后补一行
 * `exports.__probeBuffer = InspectorSourceBuffer;`，再装一个最小
 * `globalThis.window.__ModuleLoader__` 把它 import 进来，最后手工调 factory 拿到模块对象。
 *
 * 为什么不用 node:vm：vm 沙箱有自己的 Object.prototype / Array.prototype，而 client.js 的
 * isJsonValue 用 `prototype === Object.prototype` 判「纯对象」—— 跨 realm 传进去的 payload
 * 会被误判成非 JSON 值（实测报 "must be lossless JSON data"）。同 realm 跑就没有这个问题。
 *
 * @returns {Promise<typeof Function>} 客户端那份 InspectorSourceBuffer
 */
async function loadClientForProbe() {
  const text = readOrFail(CLIENT)
  const marker = `${CLIENT_TOP}exports.name = name;`
  if (text.split(marker).length - 1 !== 1) throw new Error('client.js 找不到唯一的 exports.name 锚点（上游形态已变）')
  const instrumented = text.replace(marker, `${marker}\n${CLIENT_TOP}exports.__probeBuffer = InspectorSourceBuffer;`)
  const stub = new Proxy(function () {}, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => 'stub' : stub),
    apply: () => stub,
    construct: () => stub,
  })
  const tmp = join(PKG_DIR, 'lib', `.probe-client-1823-${String(process.pid)}.mjs`)
  const previousWindow = globalThis.window
  let record
  globalThis.window = new Proxy(
    { __ModuleLoader__: { load: (value) => { record = value } } },
    { get: (target, key) => (key in target ? target[key] : stub) },
  )
  try {
    writeFileSync(tmp, instrumented, 'utf8')
    await import(pathToFileURL(tmp).href)
  } finally {
    globalThis.window = previousWindow
    try { unlinkSync(tmp) } catch {}
  }
  if (record === void 0) throw new Error('client.js 未调用 window.__ModuleLoader__.load')
  const mod = record.factory(() => stub)
  // factory 的返回值可能是 { exports }（CJS 形态）也可能是裸 exports —— 两种都接
  const Buffer = (mod?.exports ?? mod).__probeBuffer
  if (typeof Buffer !== 'function') throw new Error('client.js 未能取出 InspectorSourceBuffer')
  return Buffer
}

/** 造一个 buffer；topics 用 "*" 以容纳任何话题 */
function makeBuffer(Buffer) {
  return new Buffer({
    topics: ['*'],
    maxFrameBytes: DEFAULT_MAX_SOURCE_FRAME_BYTES,
    maxQueuedRecords: 256,
    maxQueuedBytes: 4 * 1024 * 1024,
  })
}

/**
 * 判据：把边界扫描结果翻成失败项（宿主与 client 共用同一套判据，不许两份口径）。
 *
 * 硬要求：
 *   1. 任何一档都**不许抛** —— 这正是本单要消灭的失败姿态
 *   2. 装得下的档必须真的收下（不是一律拒收），装不下的档必须降级返回 false
 *   3. 降级时上一版 state 必须保留（否则面板变空）
 *   4. 降级后能恢复（不是死锁）、且降级可观测（至少一次 console.warn）
 *
 * @returns {string[]} 失败描述；空数组 = 通过
 */
function judgeBoundary(scope, boundary) {
  const problems = []
  for (const row of boundary.rows) {
    if (row.verdict === 'throw') problems.push(`${scope} setState 在「${row.label}」（裸${String(row.bare)}/包装${String(row.wrapped)}）上仍抛错：${row.message}`)
    else if (row.fits && row.verdict !== 'accepted') problems.push(`${scope} setState 把装得下的「${row.label}」（包装${String(row.wrapped)}）拒了 —— 降级被写成了「一律拒收」`)
    else if (!row.fits && row.verdict !== 'degrade') problems.push(`${scope} setState 在装不下的「${row.label}」（包装${String(row.wrapped)}）上未降级（verdict=${row.verdict}）—— 上限被悄悄去掉了`)
    if (!row.stateOk) problems.push(`${scope} setState 在「${row.label}」后 state 不是应有的版本（降级没留上一版 / 收下没换新）—— 面板会显示错值或变空`)
  }
  if (!boundary.retainedPrevious) problems.push(`${scope} setState 降级后没有保留上一版 state（面板会变空）`)
  if (boundary.warnCount === 0) problems.push(`${scope} 降级未打 console.warn（降级不可观测）`)
  if (!boundary.smallOk || !boundary.smallRetained) problems.push(`${scope} setState 把明显装得下的 payload 也拒了`)
  if (!boundary.recoverOk || !boundary.recoverRetained) problems.push(`${scope} 降级后无法恢复（一直拒收到进程重启）`)
  return problems
}

/**
 * 边界探针：复刻事故形态并扫一组尺寸。
 *
 * 事故点 = 裸 payload 恰好顶到旧 collector 预算（maxFrameBytes - 4096 = 126976）：
 * collector 判它合法，包装成 record 后 127040 ⇒ stateFits 判否 ⇒ 旧代码抛。
 * 所以尺寸集合取「裸 payload = 顶格 -1 / 顶格 / 顶格 +1」以及「包装后恰好等于上限」，
 * 每一档都要「不抛」；能装下的档还要「真的收下」。
 *
 * 同时做两条反向探针：
 *   · 明显装得下的 payload 必须被正常收下（降级不能写成「一律拒收」）
 *   · 降级之后再来一个小 payload 必须能接上（降级不是死锁）
 * 以及一条不变量：降级时上一版 state 必须保留（否则 inspector 面板变空）。
 *
 * @returns {{rows: Array, retainedPrevious: boolean, warnCount: number, smallOk: boolean,
 *   smallRetained: boolean, recoverOk: boolean, recoverRetained: boolean}}
 */
function boundaryProbe(Buffer) {
  const ceiling = DEFAULT_MAX_SOURCE_FRAME_BYTES - SOURCE_FRAME_OVERHEAD_BYTES // 126976
  const quoteCost = enc('') // payload 的两个引号
  const cases = [
    { label: '裸 顶格-1', bare: ceiling - 1 },
    { label: '裸 顶格  ', bare: ceiling },
    { label: '裸 顶格+1', bare: ceiling + 1 },
    // 包装后恰好等于上限：payload 再小一些
    { label: '包装==上限', wrapped: ceiling },
    { label: '包装=上限+1', wrapped: ceiling + 1 },
  ]

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...rest) => { warnings.push(rest.join(' ')) }
  const rows = []
  let retainedPrevious = true
  let recoverOk
  let recoverRetained
  try {
    for (const item of cases) {
      const buffer = makeBuffer(Buffer)
      const previousPayload = { schemaVersion: 0, revision: 1, marker: 'PREVIOUS' }
      buffer.setState(CORDIS_TREE_TOPIC, previousPayload, 1789000000000)
      const payloadChars = item.bare !== void 0
        ? item.bare - quoteCost
        : item.wrapped - wrappedBytes(CORDIS_TREE_TOPIC, '', 1789000000000)
      const payload = 'x'.repeat(payloadChars)
      const bare = enc(payload)
      const wrapped = wrappedBytes(CORDIS_TREE_TOPIC, payload, 1789000000000)
      const fits = wrapped + SOURCE_FRAME_OVERHEAD_BYTES <= DEFAULT_MAX_SOURCE_FRAME_BYTES
      let verdict
      let message
      let returnValue
      try {
        returnValue = buffer.setState(CORDIS_TREE_TOPIC, payload, 1789000000000)
        verdict = returnValue === false ? 'degrade' : 'accepted'
      } catch (error) {
        verdict = 'throw'
        message = error?.message
      }
      const retained = buffer.state?.get?.(CORDIS_TREE_TOPIC)
      const keptPrevious = retained?.payload?.marker === 'PREVIOUS'
      // 降级必须留上一版；收下的则 state 应换成新 payload
      const stateOk = verdict === 'accepted' ? retained?.payload === payload : keptPrevious
      if (!stateOk) retainedPrevious = false
      rows.push({ label: item.label, bare, wrapped, fits, verdict, message, returnValue, stateOk })
      if (recoverOk === void 0) {
        // 第一次降级之后试恢复（只在确实发生过降级时判）
        const smallPayload = { marker: 'RECOVERED' }
        recoverOk = buffer.setState(CORDIS_TREE_TOPIC, smallPayload, 1789000000001) !== false
        recoverRetained = buffer.state?.get?.(CORDIS_TREE_TOPIC)?.payload?.marker === 'RECOVERED'
      }
    }
  } finally {
    console.warn = originalWarn
  }

  // 反向探针：远小于上限的 payload 必须照常收下
  const smallBuffer = makeBuffer(Buffer)
  const smallOk = smallBuffer.setState(CORDIS_TREE_TOPIC, { marker: 'SMALL' }, 1789000000000) !== false
  const smallRetained = smallBuffer.state?.get?.(CORDIS_TREE_TOPIC)?.payload?.marker === 'SMALL'

  return {
    rows,
    ceiling,
    retainedPrevious,
    warnCount: warnings.length,
    smallOk,
    smallRetained,
    recoverOk: recoverOk ?? false,
    recoverRetained: recoverRetained ?? false,
  }
}

/**
 * 端到端：真实 Cordis 树 → publishCordisTree（走模块里真正的 collector 预算）→ 真实 buffer。
 * 这条是事故原路径（queueMicrotask 里的 setState），必须整条跑通。
 * @param budget - 传给 publishCordisTree 的 maxBytes；打后由模块自己的 __budget 算出
 */
async function treeProbe(mod, Buffer, budget) {
  // 从**运行时根**解析 cordis：本脚本跑在 dsh-forge 工作树里，那里没有运行时依赖
  const { Context } = await import(pathToFileURL(join(NM, 'cordis/lib/index.js')).href)
  const ctx = new Context()
  // 树要大到顶格：实测 1200 个插件即可把裸快照剪到 ~126947（旧预算 126976）
  for (let index = 0; index < 1400; index += 1) {
    ctx.plugin({ name: `probe-plugin-${String(index)}-padding-name`, apply() {} })
  }
  await new Promise((resolve) => setTimeout(resolve, 30))
  const buffer = makeBuffer(Buffer)
  const captured = {}
  const publisher = {
    setState(topic, payload, monotonicMs) {
      captured.payload = payload
      return buffer.setState(topic, payload, monotonicMs ?? performance.now())
    },
  }
  // 事故形态：抛在 queueMicrotask 里 ⇒ 无人 catch ⇒ uncaughtException ⇒ 宿主 exit(1)。
  // 探针把它接住并记下来，这就是「原来的失败」。
  let uncaught
  const onUncaught = (error) => { uncaught = error }
  process.on('uncaughtException', onUncaught)
  const originalWarn = console.warn
  console.warn = () => {}
  let dispose
  let syncError
  try {
    // 注意：observeCordisTree 首次是**同步** publish（之后才走 queueMicrotask），
    // 所以未打的版本在这里就是同步抛 —— 必须两边都接住。
    try {
      dispose = mod.publishCordisTree(ctx, publisher, { maxNodes: 2048, maxBytes: budget })
    } catch (error) {
      syncError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  } finally {
    console.warn = originalWarn
    process.off('uncaughtException', onUncaught)
    try { dispose?.() } catch {}
    try { await ctx.dispose?.() } catch {}
  }
  // 交叉核对：collector 真正产出的那份快照，一个全新的真实 buffer 收得下吗
  let accepted
  if (captured.payload !== void 0) {
    const verifier = makeBuffer(Buffer)
    try {
      accepted = verifier.setState(CORDIS_TREE_TOPIC, captured.payload, 1789000000000) !== false
    } catch {
      accepted = false
    }
  }
  return {
    threw: syncError?.message ?? uncaught?.message,
    budget,
    bareBytes: captured.payload === void 0 ? void 0 : enc(captured.payload),
    snapshotBytes: captured.payload === void 0 ? void 0 : wrappedBytes(CORDIS_TREE_TOPIC, captured.payload, 1789000000000),
    accepted,
  }
}

/** 当前磁盘上的调用点用的是哪套口径 */
function budgetModeOf(text) {
  return text.includes('maxBytes: statePayloadBudgetBytes(') ? 'aligned' : 'legacy'
}

/** 打后宿主该用的预算：优先问模块自己的 helper（证明 helper 本身口径自洽） */
function hostBudget(mod) {
  return typeof mod.__budget === 'function'
    ? mod.__budget(DEFAULT_MAX_SOURCE_FRAME_BYTES, CORDIS_TREE_TOPIC)
    : legacyBudget(DEFAULT_MAX_SOURCE_FRAME_BYTES)
}

async function assertBehavior() {
  const failures = []
  const notes = []

  // ── ① 宿主侧：边界 + 端到端 ─────────────────────────────────────────
  let host
  try {
    host = await loadHostForProbe()
  } catch (error) {
    console.error(`✗ 行为断言无法执行（宿主模块加载失败）：${error.message}`)
    return false
  }
  try {
    const Buffer = host.mod.InspectorSourceBuffer
    if (typeof Buffer !== 'function') {
      failures.push('index.js 未导出 InspectorSourceBuffer（探针注入失效）')
    } else {
      const boundary = boundaryProbe(Buffer)
      failures.push(...judgeBoundary('宿主', boundary))
      const notesRows = boundary.rows
        .map((row) => `${row.label} 裸${String(row.bare)}/包装${String(row.wrapped)}→${row.verdict}${row.fits ? '(应装下)' : '(应降级)'}`)
        .join(' · ')
      notes.push(`宿主 setState 边界扫描：${notesRows} · 降级后恢复=${String(boundary.recoverOk)} · warn ${String(boundary.warnCount)} 次`)

      const budget = hostBudget(host.mod)
      const tree = await treeProbe(host.mod, Buffer, budget)
      if (tree.threw !== void 0) failures.push(`宿主 Cordis 树路径仍有未捕获异常：${tree.threw}`)
      if (tree.accepted === false) failures.push('collector 产出的快照被 setState 拒绝 —— 两侧口径仍不一致')
      const ceiling = DEFAULT_MAX_SOURCE_FRAME_BYTES - SOURCE_FRAME_OVERHEAD_BYTES
      if (tree.snapshotBytes !== void 0 && tree.snapshotBytes > ceiling) {
        failures.push(`collector 快照包装后 ${String(tree.snapshotBytes)} 超过帧预算 ${String(ceiling)}`)
      }
      notes.push(`宿主 collector 预算 ${String(budget)}（旧值 ${String(legacyBudget(DEFAULT_MAX_SOURCE_FRAME_BYTES))}）`
        + ` · 树快照裸 ${String(tree.bareBytes)} / 包装后 ${String(tree.snapshotBytes)}`
        + ` · 未捕获异常 ${tree.threw === void 0 ? '无' : tree.threw} · 新 buffer 收下 ${String(tree.accepted)}`)
    }
  } finally {
    host.cleanup()
  }

  // ── ② 客户端侧：同构副本的边界 ──────────────────────────────────────
  try {
    const ClientBuffer = await loadClientForProbe()
    const boundary = boundaryProbe(ClientBuffer)
    failures.push(...judgeBoundary('client', boundary))
  } catch (error) {
    failures.push(`client.js 行为断言无法执行：${error.message}`)
  }

  // ── ③ 静态判据：预算只留一处定义、上限常量没被动过 ────────────────────
  const hostText = readOrFail(HOST)
  const clientText = readOrFail(CLIENT)
  if (budgetModeOf(hostText) !== 'aligned') failures.push('index.js 的 collector 调用点没改用 statePayloadBudgetBytes')
  if (budgetModeOf(clientText) !== 'aligned') failures.push('client.js 的 collector 调用点没改用 statePayloadBudgetBytes')
  if (!hostText.includes(`${HOST_TOP}const SOURCE_FRAME_OVERHEAD_BYTES = 4096;`)) failures.push('index.js 的 SOURCE_FRAME_OVERHEAD_BYTES 被改了')
  if (!clientText.includes(`${CLIENT_TOP}const SOURCE_FRAME_OVERHEAD_BYTES = 4096;`)) failures.push('client.js 的 SOURCE_FRAME_OVERHEAD_BYTES 被改了')
  if (!hostText.includes('const DEFAULT_MAX_SOURCE_FRAME_BYTES = 128 * 1024;')) failures.push('DEFAULT_MAX_SOURCE_FRAME_BYTES 被改了（⛔ 工单禁止）')
  if (hostText.includes('throw new Error("inspector: source state exceeds')) failures.push('index.js 仍有 source-state 抛错站点')
  if (clientText.includes('throw new Error("inspector: source state exceeds')) failures.push('client.js 仍有 source-state 抛错站点')
  // 协议面没被碰：frame 形状与 topic 名原样
  if (!hostText.includes(`${HOST_TOP}const CORDIS_TREE_TOPIC = "cordis/tree";`)) failures.push('CORDIS_TREE_TOPIC 被改了（协议面）')
  if (!clientText.includes(`${CLIENT_TOP}const CORDIS_TREE_TOPIC = "cordis/tree";`)) failures.push('client 的 CORDIS_TREE_TOPIC 被改了（协议面）')

  if (failures.length > 0) {
    console.error('✗ 行为断言失败：')
    for (const failure of failures) console.error(`  - ${failure}`)
    return false
  }
  for (const note of notes) console.log(`· ${note}`)
  console.log('✓ 行为断言全绿：顶格 payload 降级不抛 / 上一版 state 保留 / 真实 Cordis 树无未捕获异常 / 两侧预算同源 / 上限与协议常量未动')
  return true
}

/** --probe 用：把边界扫描表打到 stdout（人读） */
function printBoundary(scope, boundary) {
  console.log(`${scope} setState 边界扫描（帧上限 ${String(DEFAULT_MAX_SOURCE_FRAME_BYTES)} · 裸 payload 上限 ${String(boundary.ceiling)}）：`)
  for (const row of boundary.rows) {
    console.log(`  ${row.label} · 裸=${String(row.bare)} 包装=${String(row.wrapped)}`
      + ` · ${row.fits ? '应装下' : '应降级'} · 实际=${row.verdict}`
      + `${row.message === void 0 ? '' : ` · ${row.message}`}`
      + `${row.verdict === 'throw' ? '' : ` · 返回=${JSON.stringify(row.returnValue)}`}`)
  }
  console.log(`  上一版 state 保留=${String(boundary.retainedPrevious)} · 降级后恢复=${String(boundary.recoverOk)}`
    + ` · 明显装得下的收下=${String(boundary.smallOk)} · warn=${String(boundary.warnCount)} 次`)
}

/** --probe：只跑探针并打印（不改盘、不判绿），用于「修前 vs 修后」对照 */
async function probe() {
  const hostText = readOrFail(HOST)
  console.log(`宿主 collector 调用点口径：${budgetModeOf(hostText)}`)
  const host = await loadHostForProbe()
  try {
    const Buffer = host.mod.InspectorSourceBuffer
    const boundary = boundaryProbe(Buffer)
    printBoundary('宿主', boundary)
    const budget = hostBudget(host.mod)
    console.log(`宿主 collector 预算：${String(budget)}（旧值 ${String(legacyBudget(DEFAULT_MAX_SOURCE_FRAME_BYTES))}）`)
    const tree = await treeProbe(host.mod, Buffer, budget)
    console.log(`宿主 Cordis 树路径：未捕获异常=${tree.threw ?? '无'}`
      + ` · 快照裸=${String(tree.bareBytes)} 包装后=${String(tree.snapshotBytes)}`
      + ` · 新 buffer 收下=${String(tree.accepted)}`)
  } finally {
    host.cleanup()
  }
  try {
    const ClientBuffer = await loadClientForProbe()
    const boundary = boundaryProbe(ClientBuffer)
    printBoundary('client', boundary)
  } catch (error) {
    console.log(`client 探针失败：${error.message}`)
  }
}

if (mode === 'revert') {
  revert()
  process.exit(0)
}
if (mode === 'probe') {
  await probe()
  process.exit(0)
}
if (mode === 'check') {
  const code = check()
  const ok = await assertBehavior()
  process.exit(code === 0 && ok ? 0 : 1)
}
apply()
const ok = await assertBehavior()
process.exit(ok ? 0 : 1)
