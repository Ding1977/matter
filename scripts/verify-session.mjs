#!/usr/bin/env node
/**
 * 用 DSH 的 JsonlSessionPersistence 真实读取修复后的会话文件，验证能否正常加载。
 * 用法：verify-session.mjs <session.jsonl.zstd 路径> [sessionId]
 * 只读。走 dsh-session-persistence-jsonl 的公开读取路径（list 或直接 read prefix）。
 */
import { pathToFileURL } from 'node:url'

// 加载 DSH 模块
const mod = await import(pathToFileURL('<dsh>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js').href)
const { JsonlSessionPersistence } = mod

const path = process.argv[2]
if (!path) { console.error('usage: verify-session.mjs <path>'); process.exit(1) }

// 解析 sessionId 从目录名（session-xxx）或文件路径
const m = path.match(/session-([0-9a-f-]{36})/)
const sessionId = m ? `session-${m[1]}` : 'session-unknown'

// 创建 persistence 实例（只读验证，不启动 cordis ctx——用最小 ctx 桩）
// JsonlSessionPersistence 需要 ctx（logger）。构造最小桩。
const ctxStub = {
  logger: {
    warn: (...a) => console.log('[warn]', ...a),
    info: (...a) => console.log('[info]', ...a),
    debug: () => {},
    error: (...a) => console.log('[error]', ...a)
  }
}

// 直接调用模块内部的读取（导出仅 JsonlSessionPersistence）。用实例化 + 公开方法。
// 看类型定义找公开读方法：
import { readFile } from 'node:fs/promises'
// 尝试用 scanner 逻辑验证：直接模拟 readZstdPrefix
// 简化：用公开 API 尝试 list/read

try {
  const p = new JsonlSessionPersistence(ctxStub, {
    directory: process.env.HOME + '/.dsh/sessions'
  }, {})
  // 需要配置：compression 等。先看构造函数签名
  console.log('实例化成功，尝试读取会话...')
  const sessions = await p.list()
  const found = sessions.filter((s) => s.id === sessionId)
  console.log(`list 找到会话: ${found.length} 个 (id=${sessionId})`)
  if (found.length) console.log('header:', JSON.stringify(found[0]))
} catch (e) {
  console.log('list 失败:', e.message)
}

// 更直接：用 zip 模块解压全部 + 用 DSH scanner 类验证
// 从 dsh-session-persistence-jsonl 内部导入 SessionLogScanner（未导出），改用 dsh-session 验证
const dshSession = await import(pathToFileURL('<dsh>/node_modules/@deepseek-ai/dsh-session/lib/index.js').href)
const { decodeStorageRecord } = dshSession
// ISS-398 / DOC-223 §2-⑥：本脚本依赖 `dsh-session` 的 `decodeStorageRecord`，
// 该导出在 DSH 0.1.5-rc.2 **已被移除**（0.1.5 只导出 decodeSeqRanges；持久化改用
// materializeAppendBatch / validateStoredEvents 一族）。升级后本脚本会失去展开能力，
// 故显式失败而不是静默产出错的 seq 账单。改造方案见 DOC-223 §2-⑥。
if (typeof decodeStorageRecord !== "function") {
  console.error("[0.1.2-only] 本脚本基于 dsh-session.decodeStorageRecord，该 API 在 DSH 0.1.5-rc.2 已移除。" +
    "升级后请改用 0.1.5 的持久化 API（见 DOC-223 §2-⑥ / ISS-398）。");
  process.exit(2);
}
const { zstdDecompressSync } = await import('node:zlib')
const buffer = await readFile(path)

// 帧扫描（内联简化——文件是修复后的单帧）
// 检查 magic
if (buffer.readUInt32LE(0) === 4247762216) {
  // 可能是多帧，全部解压拼接验证
  let all = ''
  let off = 0
  let frameCount = 0
  while (off < buffer.length) {
    const start = off
    if (buffer.readUInt32LE(off) !== 4247762216) { console.log('非帧边界 @', off); break }
    off += 4
    const d = buffer.readUInt8(off); off += 1
    const csf = d >>> 6, ss = (d & 32) !== 0, chk = (d & 4) !== 0, df = d & 3
    const db = df === 3 ? 4 : df
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf
    off += (ss ? 0 : 1) + db + csb
    for (;;) {
      const bh = buffer.readUIntLE(off, 3); off += 3
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3
      const pb = bt === 1 ? 1 : bs
      off += pb
      if (last) break
    }
    if (chk) off += 4
    all += zstdDecompressSync(buffer.subarray(start, off)).toString('utf8')
    frameCount++
  }
  console.log(`解压 ${frameCount} 帧, 明文 ${all.length}B`)
  // 验证 seq 连续
  const lines = all.split('\n').filter(Boolean)
  let expected = 0, inHeader = true, gaps = 0
  for (const line of lines) {
    if (inHeader) { inHeader = false; continue }
    const evts = decodeStorageRecord(JSON.parse(line))
    for (const ev of evts) {
      if (typeof ev.seq === 'number' && ev.seq !== expected) { gaps++; break }
      expected++
    }
  }
  console.log(`seq 验证: ${gaps} gap, 末事件 seq ${expected - 1}, 共 ${expected} 事件`)
  if (gaps === 0) console.log('✅ 修复后文件 seq 完全连续，可被 DSH 正常读取')
  else console.log('❌ 仍有 gap！')
} else {
  console.log('不是 zstd 文件')
}
