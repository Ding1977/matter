#!/usr/bin/env node
/**
 * 用完整 Cordis App + DSH JsonlSessionPersistence.load() 验证会话可加载。
 * 用法：verify-load2.mjs <sessionId>
 * 只读验证，不写任何文件。
 */
import { pathToFileURL } from 'node:url'

const cordisMod = await import(pathToFileURL('<dsh>/node_modules/@deepseek-ai/cordis/lib/index.js').href)
const { Context } = cordisMod
const persistMod = await import(pathToFileURL('<dsh>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js').href)
const { JsonlSessionPersistence } = persistMod

const sessionId = process.argv[2]
if (!sessionId) { console.error('usage: verify-load2.mjs <sessionId>'); process.exit(1) }

// 创建 Cordis App
const app = new Context()
app.plugin(JsonlSessionPersistence, {
  directory: process.env.HOME + '/.dsh/sessions'
})

try {
  const p = app.sessionPersistence
  console.log('✅ persistence 实例化成功:', p.name)
  const inspection = await p.load(sessionId)
  console.log('✅ load() 成功')
  console.log('  会话 header:', JSON.stringify(inspection.header))
  const evts = inspection.events ?? []
  console.log('  事件数量:', evts.length)
  if (evts.length) {
    console.log('  首事件:', evts[0].type, evts[0].seq)
    console.log('  末事件:', evts.at(-1).type, evts.at(-1).seq)
    // 抽查内容（用户消息）
    const users = evts.filter((e) => e.type === 'user/message')
    console.log('  用户消息数:', users.length)
    if (users.length) console.log('  首个用户消息时间:', new Date(users[0].time).toISOString())
  }
} catch (e) {
  console.log('❌ load() 失败:', e.message)
  process.exit(1)
}
