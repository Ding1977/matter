#!/usr/bin/env node
/**
 * 用 DSH 的 JsonlSessionPersistence.load() 完整加载会话，验证修复文件能否被 DSH 读取。
 * 用法：verify-load.mjs <sessionId>（如 session-3f0dfb84-...）
 * 需要 DSH 运行环境（dsh-local 的依赖）。只读验证。
 */
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('<dsh>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js').href)
const { JsonlSessionPersistence } = mod

const sessionId = process.argv[2]
if (!sessionId) { console.error('usage: verify-load.mjs <sessionId>'); process.exit(1) }

// 构造最小 ctx（logger 桩）
const ctxStub = {
  logger: {
    warn: (...a) => console.log('[warn]', ...a),
    info: (...a) => console.log('[info]', ...a),
    debug: () => {},
    error: (...a) => console.log('[error]', ...a),
    success: () => {}
  }
}

const config = {
  directory: process.env.HOME + '/.dsh/sessions'
}

try {
  const p = new JsonlSessionPersistence(ctxStub, config, {})
  console.log('实例化成功')
  const inspection = await p.load(sessionId)
  console.log('✅ load() 成功')
  console.log('  会话 header:', JSON.stringify(inspection.header))
  console.log('  事件数量:', inspection.events?.length ?? '?')
  const evts = inspection.events ?? []
  if (evts.length) {
    console.log('  首事件:', evts[0].type, evts[0].seq)
    console.log('  末事件:', evts.at(-1).type, evts.at(-1).seq)
  }
} catch (e) {
  console.log('❌ load() 失败:', e.message)
  console.log(e.stack?.split('\n').slice(0, 8).join('\n'))
  process.exit(1)
}
