// Matter 通道凭证发号 CLI（DOC-454 / ISS-600 M1）
//
// 用法：
//   node scripts/agent-channel.mjs list
//   node scripts/agent-channel.mjs issue MEM-012 --name zcode [--note "..."]
//   node scripts/agent-channel.mjs rotate MEM-012|zcode
//   node scripts/agent-channel.mjs revoke MEM-012|zcode
//
// 规则：
//   · token 明文**只在 issue / rotate 时打印一次**；注册表只存 SHA-256；
//   · 同一 memId 再次 issue = 轮换（旧 token 立即失效）；
//   · revoke = 停用（请求视同无凭证，写闸按既有规则 403）；
//   · 不要把 token 写进仓库、插件包或日志；只放进目标客户端本机的 MCP env。
import { channelsPath, issueChannel, listChannels, revokeChannel, rotateChannel, channelsFileInfo } from "../forge-pm/lib/agent-channels.js"

function printUsage() {
  console.log(`Matter 通道凭证

  node scripts/agent-channel.mjs list
  node scripts/agent-channel.mjs issue <MEM-NNN> --name <署名> [--note <备注>]
     （MEM-NNN 必须是既有 agent 成员：GET /forge-pm/members 可核对）
  node scripts/agent-channel.mjs rotate <MEM-NNN|署名>
  node scripts/agent-channel.mjs revoke <MEM-NNN|署名>

环境：FORGE_PM_AGENT_CHANNELS 可覆盖注册表路径（默认 ~/.dsh/agent-channels.json）`)
}

function failCli(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function parse(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--name" || a === "--note") {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith("--")) return { error: `${a} 缺值` }
      out.flags[a.slice(2)] = v
      i += 1
    } else if (a.startsWith("--")) {
      return { error: `不认识的参数：${a}` }
    } else {
      out._.push(a)
    }
  }
  return out
}

function printIssued(result, action) {
  console.log(`✓ 已${action}：${result.entry.memId} ${result.entry.name}`)
  console.log(`  token（只显示这一次，复制到客户端本机 MCP env，勿入库）：`)
  console.log(`  ${result.token}`)
  console.log()
  console.log(`  客户端 config 片段：`)
  console.log(`  "env": { "MATTER_BASE": "http://127.0.0.1:3210", "FORGE_PM_AGENT_TOKEN": "${result.token}" }`)
  console.log()
  console.log(`  核对：curl -s http://127.0.0.1:3210/forge-pm/whoami -H 'X-Matter-Agent-Token: <token>'`)
}

const argv = process.argv.slice(2)
const args = parse(argv)
if (args.error) {
  console.error(`✗ ${args.error}`)
  printUsage()
  process.exit(1)
}

const cmd = args._[0]
try {
  if (cmd === "list") {
    const out = listChannels()
    if (!out.ok) failCli(out.error)
    const info = channelsFileInfo()
    console.log(`注册表：${info.path}${info.exists ? `（${info.mode}，${info.size} B）` : "（尚无文件）"}`)
    if (info.exists && info.mode && info.mode !== "600") {
      console.error(`⚠️ 文件权限是 ${info.mode}，应为 600（同用户其它进程可读 = 凭证泄露面变大）`)
    }
    if (!out.entries.length) {
      console.log("（空表）")
    } else {
      for (const e of out.entries) {
        console.log(`${e.memId}\t${e.name}\t${e.status}\tfp=${e.fingerprint}\t${e.updatedAt || e.createdAt || ""}\t${e.note || ""}`)
      }
    }
    process.exit(0)
  }

  if (cmd === "issue") {
    const memId = args._[1]
    const name = args.flags.name
    if (!memId || !name) failCli("issue 需要 <MEM-NNN> 与 --name")
    const out = issueChannel({ memId, name, note: args.flags.note || "" })
    if (!out.ok) failCli(out.error)
    printIssued(out, out.rotated ? "轮换" : "签发")
    process.exit(0)
  }

  if (cmd === "rotate") {
    const ref = args._[1]
    if (!ref) failCli("rotate 需要 <MEM-NNN|署名>")
    const out = rotateChannel(ref)
    if (!out.ok) failCli(out.error)
    printIssued(out, "轮换")
    process.exit(0)
  }

  if (cmd === "revoke") {
    const ref = args._[1]
    if (!ref) failCli("revoke 需要 <MEM-NNN|署名>")
    const out = revokeChannel(ref)
    if (!out.ok) failCli(out.error)
    console.log(`✓ 已停用：${out.memId} ${out.name}（旧 token 立即失效）`)
    process.exit(0)
  }

  printUsage()
  process.exit(1)
} catch (err) {
  failCli(String((err && err.message) || err))
}
