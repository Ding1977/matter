#!/usr/bin/env node
/**
 * 修复 DSH 会话日志的 seq 冲突（中断恢复重写导致的重复 seq）：
 * 1. 解压全部帧 → 逐行解码（decodeStorageRecord 展开）
 * 2. 遇到 seq 冲突时：将冲突行的 seq 重写为期望的连续值（保留内容，仅改序号）
 * 3. 重新压缩为单帧 zstd 文件（checksum 开启，与 DSH 一致）
 * 用法：fix-session-seq.mjs <input.zstd> <output.zstd>
 * 不修改输入文件。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { constants, zstdDecompress, zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
const dshSession = await import(pathToFileURL('<dsh>/node_modules/@deepseek-ai/dsh-session/lib/index.js').href)
const decodeStorageRecord = dshSession.decodeStorageRecord
// ISS-398 / DOC-223 §2-⑥：本脚本依赖 `dsh-session` 的 `decodeStorageRecord`，
// 该导出在 DSH 0.1.5-rc.2 **已被移除**（0.1.5 只导出 decodeSeqRanges；持久化改用
// materializeAppendBatch / validateStoredEvents 一族）。升级后本脚本会失去展开能力，
// 故显式失败而不是静默产出错的 seq 账单。改造方案见 DOC-223 §2-⑥。
if (typeof decodeStorageRecord !== "function") {
  console.error("[0.1.2-only] 本脚本基于 dsh-session.decodeStorageRecord，该 API 在 DSH 0.1.5-rc.2 已移除。" +
    "升级后请改用 0.1.5 的持久化 API（见 DOC-223 §2-⑥ / ISS-398）。");
  process.exit(2);
}
const zstdDecompressAsync = promisify(zstdDecompress)
const zstdCompressAsync = promisify(zstdCompress)
const ZSTD_MAGIC = 4247762216
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

async function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('bad magic')
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset); offset += 1
    const csf = descriptor >>> 6, ss = (descriptor & 32) !== 0, chk = (descriptor & 4) !== 0, df = descriptor & 3
    const db = df === 3 ? 4 : df
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf
    const rhb = (ss ? 0 : 1) + db + csb
    if (buffer.length - offset < rhb) return { frames, tornStart: start }
    offset += rhb
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const bh = buffer.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3
      if (bt === 3) throw new Error('reserved block')
      const pb = bt === 1 ? 1 : bs
      if (buffer.length - offset < pb) return { frames, tornStart: start }
      offset += pb
      if (last) break
    }
    if (chk) { offset += 4 }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const inputPath = process.argv[2]
const outputPath = process.argv[3]
if (!inputPath || !outputPath) { console.error('usage: fix-session-seq.mjs <input.zstd> <output.zstd>'); process.exit(1) }

const buffer = await readFile(inputPath)
const { frames } = await scanFrames(buffer)
console.log(`输入 ${buffer.length}B, ${frames.length} 帧`)

const outLines = []
let events = 0
let inHeader = true
let fixed = 0
let jsonErrors = 0

for (let i = 0; i < frames.length; i++) {
  const f = frames[i]
  const plain = await zstdDecompressAsync(buffer.subarray(f.start, f.end))
  const text = plain.toString('utf8')
  const rows = text.split('\n')
  for (let r = 0; r < rows.length; r++) {
    const line = rows[r]
    if (line === '' && r === rows.length - 1) continue
    if (inHeader) {
      inHeader = false
      outLines.push(line) // header 原样保留
      continue
    }
    let decoded
    try { decoded = JSON.parse(line) } catch { jsonErrors++; outLines.push(line); continue }
    const evts = decodeStorageRecord(decoded)
    // 检查本行是否 seq 冲突
    let rowConflict = false
    for (const ev of evts) {
      if (typeof ev.seq === 'number' && ev.seq !== events) { rowConflict = true; break }
    }
    if (rowConflict) {
      // 重写 seq：单事件行直接改 seq；chunk 行改 seq0
      fixed++
      const lineEvents = decodeStorageRecord(JSON.parse(line)) // 再展开确认数量
      if (lineEvents.length === 1 && typeof lineEvents[0].seq === 'number') {
        const d = JSON.parse(line)
        d.seq = events
        outLines.push(JSON.stringify(d))
        events++
      } else if (typeof decoded.seq0 === 'number') {
        // chunk 行：seq0 是首事件 seq，成员数 = data.texts/args 长度
        const members = decoded.data?.texts ?? decoded.data?.args ?? []
        const delta = events - decoded.seq0
        if (delta >= 0 && delta < members.length) {
          const d = JSON.parse(line)
          d.seq0 = events
          outLines.push(JSON.stringify(d))
          events += members.length
        } else {
          // 无法安全重写：保留原文并推进（保守）
          outLines.push(line)
          events += members.length
        }
      } else {
        outLines.push(line)
      }
      continue
    }
    outLines.push(line)
    events += evts.length
  }
}
console.log(`修复 ${fixed} 行 seq 冲突, JSON 解析失败 ${jsonErrors} 行, 事件总数 ${events}`)

// 重写后验证无冲突
let checkSeq = 0
let checkHeader = true
let checkGaps = 0
for (const line of outLines) {
  if (line === '') continue
  if (checkHeader) { checkHeader = false; continue }
  const evts = decodeStorageRecord(JSON.parse(line))
  for (const ev of evts) {
    if (typeof ev.seq === 'number' && ev.seq !== checkSeq) { checkGaps++; break }
    checkSeq++
  }
}
console.log(`重写后验证: seq gap ${checkGaps} 个, 事件 ${checkSeq}`)

// 压缩输出（单帧，checksum 开启）
const plaintext = outLines.join('\n') + '\n'
const compressed = await zstdCompressAsync(Buffer.from(plaintext), CHECKSUM_OPTIONS)
await writeFile(outputPath, compressed)
console.log(`输出 ${outputPath}: ${compressed.length}B (原 ${buffer.length}B)`)
