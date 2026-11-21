// 测试预载（ISS-581）：**在任何模块加载之前**把 agent 域根指到临时目录。
//
// ## 为什么需要它
// `forge-agents/lib/domain.js` 的域根是**加载期常量**（`export const AGENTS_ROOT = agentsRoot()`），
// 而 `bun test` 在**同一进程**里跑多个测试文件 ⇒ **谁先 import `domain.js` 谁定根**。
// 测试文件里那句 `process.env.FORGE_AGENTS_ROOT = ROOT`（`zcode-stdio.test.js:20`）**只在它是第一个
// import 时有效**；别的文件先加载时，根已定成**真实 `~/.dsh`** ⇒ 测试写真实用户目录。
// 后果已发生两次（同一根因）：① 2026-09-30 泄漏 76 个假 run 进老板列表；② ISS-581 写 zcode-state
// 被沙箱 EPERM。本预载把这件事从"靠 import 顺序"变成"**进程启动就定好**"。
//
// ⚠️ 只对 forge-agents 的测试生效（按 cwd 判定），不影响其它包；也不影响生产运行（生产不经这里）。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (!process.env.FORGE_AGENTS_ROOT && process.cwd().endsWith("/forge-agents")) {
  process.env.FORGE_AGENTS_ROOT = mkdtempSync(join(tmpdir(), "forge-agents-test-"))
}
