// 脚本红线 lint（ISS-587 G 项 · 「守卫要有牙」的脚本侧落地）
//
// 为什么值得机器化而不是写成一句口头纪律：本仓的几次事故都不是"没人知道规矩"，
// 而是**规矩没有牙**（AGENTS §4 写了「禁止直接 kill 3210」还是被 kill 过，
// 「重启只走官方入口」也照样有人另起端口）。写进 lint 才会在新增脚本时出声。
//
// 六条红线，全部来自实测踩到的坑（不是凭空立规矩）：
//   R1 .sh 里禁用裸 `timeout`：macOS 没这个命令（同一批工作里踩到两次，一次差点卡住自愈路径）。
//   R2 只有白名单脚本能真的杀进程。`kill -0` 是**探测**不是杀，必须不算违例（否则取证脚本被误伤）。
//   R3 每个 .sh 要有 `set -u`（不装的话，变量名拼错会静默走空值分支）。
//   R4 只有服务生命周期脚本能 `nohup` 拉常驻（agent 会话里起的后台进程活不过几分钟 —— AGENTS §4.3）。
//   R5 每个脚本头部要有说明注释（.sh 认 `#`，.mjs 认 `//`）：没有说明的脚本半年后会被当成垃圾删掉。
//   R6 插件侧（forge-*/lib|src 的生产 JS）启动/终止子进程必须**显式声明**：命中 SPAWN_OK 白名单，
//      或文件内自带 `// @spawn-allow: <理由>`。为什么需要它（ISS-646 · DOC-274 §2.4）：脚本侧有五条牙，
//      插件侧却长期零门禁 —— 而进程生命周期恰恰是最容易各写一份的东西（本仓已实测：四处实现里
//      三种存活判据、三份空闲回收器、两处各写一遍的 kill）。R6 不禁止 spawn，只要求"你写了要说明"。
//
// 判据口径：**存量违例走白名单且必须写理由**，新增即红；白名单项若已不再命中也算失败
// （防止豁免养成长期化石，防止规则被无声放宽）。反向验证见 --selftest。
//
// 用法：node scripts/lint-scripts.mjs [--check|--report|--selftest]
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, basename, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)))

const RE = {
  // 真杀进程的四种形态。注意 `kill -0` 不落在任何一条里（-0 不在信号白名单内，且 $ 前是 -0 不是直接跟 $）
  pkill: /\bpkill\b/,
  // ⚠️ 三条 kill 判据都用 `(?<![\w-])` 而不是 `\b`（ISS-614 实测踩到）：词边界会把
  //    `prod-guard.sh require-kill "$pid"` 里的 `kill "$pid"` 当成真杀 —— **牙的调用被判成杀**，
  //    于是「加完牙」立刻红，理由还指向牙自己那行。改用「前一个字符不能是词字符或连字符」，
  //    `require-kill`（复合词）不再命中，而 `; kill ...` / `&& kill ...` / 行首 kill 照常命中。
  killSignal: /(?<![\w-])kill\s+-(9|15|TERM|HUP|INT|KILL)\b/,
  xargsKill: /\bxargs\s+[^|]*(?<![\w-])kill\b/,
  killVar: /(?<![\w-])kill\s+"?\$\w/,
  bareTimeout: /(^|[;&|(\s])timeout\s+\d/,
  nohup: /\bnohup\b/,
  // ⚠️ 别在 JS 里写 `[[:space:]]`（那不是 POSIX 类，会被当成一组字面字符，判据静默走偏）。
  //    set -u 的两种真实写法都要认：`set -u` / `set -euo pipefail` / `set -o pipefail -u`。
  setU: /\bset\s+-\w*u\w*\b/,
  setU2: /\bset\b[^\n]*\s-u(\s|$)/,
  // ── R6（插件侧进程控制）──
  // 判据 = 「文件 import 了 node:child_process」**且**「代码里有启动/终止子进程的调用」。
  // 必须先认 import：`.kill(` 这种形态在没有 child_process 的文件里可能属于别的库（假红比没门禁更赶人）。
  cpImport: /from\s+["']node:child_process["']|require\(\s*["']node:child_process["']\s*\)/,
  jsSpawn: /\bspawn(Sync)?\s*\(/,
  jsFork: /\bfork\s*\(/,
  jsKill: /process\.kill\s*\(|\.kill\s*\(/,
  /**
   * 存活探针：`process.kill(pid, 0)` / `kill(-pid, 0)` —— **探测不是杀**。
   * R2 从第一版就豁免 `kill -0`（"否则取证类脚本被误伤"，本仓踩过），R6 第一版漏了同一条，
   * 于是把 `forge-agents/lib/child-lease.js` 的 `pidAlive()` 判成未声明的进程控制（ISS-727 实测）。
   * 只豁免"第二实参是字面量 0"这一种形态：`kill(-pid)`（树级真杀、信号缺省）与带信号的一律照判。
   */
  jsProbeKill: /\.kill\(\s*-?[\w.]+\s*,\s*0\s*\)/g,
  /** 文件内自带理由即放行（免去为每个站点维护一行白名单）。要求理由 ≥ 8 字符，防「写了等于没写」。 */
  spawnAllow: /@spawn-allow:\s*(\S[\s\S]{7,}?)(?:\*\/|\n|$)/,
}

/**
 * 头部说明：shebang 不算说明（它每个脚本都有，用它判等于没判）。
 * ⚠️ 必须按**注释块整体**判：块注释 `/**` 的正文写在下一行，按单行取长度会把
 *    写得最规范的脚本报成"没说明"（合入主库当天被自己的 lint 抓到一次，误伤 2 个在排查的脚本）。
 */
function hasHeader(src) {
  const text = src
    .split("\n")
    .slice(0, 4)
    .map((l) => l.trim())
    .filter((t) => t && !t.startsWith("#!"))
    .filter((t) => /^#|^\/\/|^\/\*|^\*($|\s|\/)/.test(t))
    .map((t) => t.replace(/^(#|\/\/|\/\*+|\*+\/|\*+)\s*/, "").replace(/\*\/$/, "").trim())
    .join(" ")
  return text.length >= 8
}
const isRealKill = (text) => RE.pkill.test(text) || RE.killSignal.test(text) || RE.xargsKill.test(text) || RE.killVar.test(text)
const hasSetU = (s) => RE.setU.test(s) || RE.setU2.test(s)

/** 这一行**是代码**吗（不是空行/行注释）。R2 的牙与行级豁免都只认代码行 ——
 *  ISS-640 实测反例：`# 每一处杀都先过 prod-guard.sh` 这种**说明性注释**能整条满足
 *  「牙在场」判据，于是把真调用删掉、只留注释 ⇒ 门禁仍绿（牙可整条拆掉而看不见）。
 *  口径与 E5/K9c 的 `stripShellComments` 一致（只剥行首注释，行内 `#` 不剥 ⇒ 宁可多报）。 */
const isCodeLine = (t) => !!t && !t.startsWith("#") && !t.startsWith("//")

/** `if false; then … fi` 里的行号集合。
 *  ISS-640 实测反例：把牙的调用整个塞进 `if false; then`（彻底失效，四处杀照旧执行）——
 *  「牙在场」的文本匹配照样命中 ⇒ 假绿。判据只认**活着**的那条调用。
 *  ⚠️ 只认字面 `false` / `! true` 这种「一眼就死」的条件：`if ! out="$(…)"`（fail-closed 的正解）
 *     必须照常算活，否则会逼人把牙从条件里搬出来写成非 fail-closed 的形状。 */
function deadBranchLines(lines) {
  const dead = new Array(lines.length).fill(false)
  const stack = [] // true = 这一层 if 是死分支
  let inDead = 0
  lines.forEach((text, i) => {
    const t = text.trim()
    if (!isCodeLine(t)) return
    dead[i] = inDead > 0 // 先记状态：`if` 那一行本身不算被自己包住
    if (/^if\b/.test(t)) {
      const d = /^if\s+(?:false\b|!\s*true\b)/.test(t)
      stack.push(d)
      if (d) inDead++
    } else if (/^(elif|else)\b/.test(t)) {
      // elif/else 分支是活的：把上面那层的死态摘掉（`fi` 仍会把它弹出，深度不变）
      if (stack.length && stack[stack.length - 1]) { stack[stack.length - 1] = false; inDead-- }
    } else if (/^fi\b/.test(t)) {
      if (stack.pop()) inDead--
    }
  })
  return dead
}

/** `guarded_kill()` 的函数体行号区间（1-based，花括号配对）。
 *  F2（ISS-640）：行级豁免原本**不分位置** —— 把 `kill -TERM "$pid" 2>/dev/null` 逐字抄到
 *  `restart)` 分支（函数体之外，牙根本不在那儿）也照样放行。豁免必须锚在函数体里。
 *  返回 null = 找不到这个函数 ⇒ 行级豁免一律失效（锚点没了就别放行，fail-closed）。 */
function guardedBodyRange(lines) {
  const start = lines.findIndex((l) => /^\s*guarded_kill\s*\(\s*\)\s*\{/.test(l))
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    if (!isCodeLine(lines[i].trim()) && i > start) continue // 注释里的花括号不参与配对
    for (const ch of lines[i]) {
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) return { start: start + 1, end: i + 1 }
        if (depth < 0) return null
      }
    }
  }
  return null
}

const KILL_OK = [
  // ⚠️ 口径更新（ISS-558 · 2026-10-01）：3210 已是 **Matter 独立服务**（DSH_HOME=~/.dsh-matter），
  //    **现役完整重启入口 = restart-matter.sh**；restart-web.sh 是**老盘入口**（保留作参考实现，
  //    见其文件头）。三条杀进程的路径都必须先过 `scripts/prod-guard.sh` 的**同一道牙**
  //    （lsof -p 判生产 home · 不依赖 ps · fail-closed），所以这里的理由写的是「牙在哪」。
  { f: "restart-matter.sh", why: "3210 的现役完整重启入口（AGENTS §5 / code-rules §4.6）；两处 kill 都先过 scripts/prod-guard.sh 的牙" },
  { f: "restart-web.sh", why: "老盘（~/.dsh）3210 重启入口，保留作参考实现；kill 路径同样先过 scripts/prod-guard.sh 的牙" },
  { f: "restart-web-detached.sh", why: "分离版重启（agent 会话内专用），同样负责杀旧；kill 前先过 scripts/prod-guard.sh 的牙" },
  { f: "dev-instance.sh", why: "只管自己起的隔离实例 3211，不碰生产 3210" },
]

/** R2 **行级豁免 + 牙校验**（ISS-614 审查抓出）。
 *
 *  整文件豁免的洞：它把「理由讲的那一处」和「文件里所有杀」**一起**放行了。实测往
 *  `scripts/app-proxy.sh` 塞一句 `pkill -9 -f "dsh web"` ⇒ 零违例（改成别的文件名立刻红）。
 *  而它的豁免理由写的是「App(19387) 代理重启入口，不碰生产 3210」—— 偏偏那条脚本的端口是
 *  `${DSH_DESKTOP_PORT:-19387}`，**可覆盖**：`DSH_DESKTOP_PORT=3210 app-proxy.sh restart`
 *  就是在杀生产。理由描述的是**默认值**，不是**保证** ⇒ 那条豁免实际覆盖了生产杀
 *  （违反 AGENTS §4 铁律一：杀 3210 要有牙）。
 *
 *  这里换成两条必须**同时**成立的判据（缺一即红）：
 *    ① `requires` 必须在文件里**作为代码**命中 —— 即**牙真的还在**（prod-guard.sh 那道判据），
 *       且那一行不能落在 `if false; then` 这种**一眼就死**的分支里（ISS-640：注释里提一句
 *       `prod-guard.sh`、或把调用塞进 `if false`，都曾让「牙被拆掉」看不见）。
 *       牙被删/被换/被调成死码 ⇒ 整条豁免失效，连登记的形态也不再放行。
 *    ② 每一处真杀都必须落在 `allows` 的某个**确切形态**里 —— 只放行 guarded_kill() 内那两行；
 *       新增任何别的杀法（pkill / kill -9 <别的 pid> / xargs kill）一律红。
 *       ⚠️ ISS-640：**位置也算判据** —— 逐字相同的行抄到 `guarded_kill()` 函数体之外
 *       （那里的杀根本没过牙）同样是红；豁免锚的是「函数体内」这个区间，不是字符串。
 *
 *  为什么不把其余四条 KILL_OK 一起改成行级：它们不在本单 diff 面内，改判据要配各自现场复核；
 *  本单只给 app-proxy.sh 长牙，其余维持存量登记（不做「顺手」改动）。 */
const KILL_GUARDED = [
  {
    f: "app-proxy.sh",
    // 要的是**调用**（`prod-guard.sh" require-kill`），不是"文件里出现过 prod-guard.sh" ——
    // 光认文件名的话，注释与 echo 文案（`挡生产是 prod-guard 的本职`）都能满足它（ISS-640 反例）。
    requires: /prod-guard\.sh["']?\s+require-kill/,
    allows: [/\bkill -(?:9|TERM) "\$pid" 2>\/dev\/null/],
    why: "App(19387) 代理重启/接管入口：每一处杀都只走 guarded_kill()，函数体内先跑 scripts/prod-guard.sh 的同一道牙（PORT 由 DSH_DESKTOP_PORT 可覆盖成 3210 ⇒ 靠牙不靠默认值）",
  },
]
const NOHUP_OK = [
  { f: "restart-matter.sh", why: "3210 现役完整重启入口，需要把 Matter 服务 detach 出会话（配方照 restart-web.sh）" },
  { f: "restart-web.sh", why: "老盘重启入口，需要把服务器 detach 出会话（保留作参考实现）" },
  { f: "restart-web-detached.sh", why: "同上（分离版正是为常驻拉起而生）" },
  { f: "watchdog-web.sh", why: "守护自身由 launchd 拉起，重启服务是它的本职" },
  { f: "dev-instance.sh", why: "隔离验证实例的启停归它管" },
  // ISS-555 / **ISS-614 更正**：本文件有**两处** nohup，理由必须覆盖两处。
  //   旧理由只写「nohup 仅老系统/权限失败时的退回路径」—— 说的是 `start)`
  //   （`open --env` 失败后直接执行二进制），而 `shared)` **主路径**也直接 nohup 拉起 App、
  //   把进程拉进共享 `~/.dsh`。审查实测：理由只覆盖一处 ⇒ 第二处藏在第一处的理由下面，
  //   任何人读这条豁免都会以为这个文件里只有一条退回路径（K8c：理由与覆盖面必须一致）。
  //   两处的实情（按分支说，不按行号说 —— 行号会漂）：
  //     · `start)`  —— 退回路径：首选 open --env（launchd 托管），老系统/权限失败才直接执行二进制；
  //     · `shared)` —— 主路径：老板明确要历史时才用，直接执行二进制拉进共享 `~/.dsh`。
  //   保留理由：两者都是**人手跑一次**的启动动作（不是常驻服务入口），且都保留了
  //   「open --env 不可用」/「要共享 home」这两条走不通的选择。
  //   ⚠️ 未把 `shared)` 改成 open --env（虽然能让 nohup 只剩一处）：那条路径会**把 App 拉进生产
  //      `~/.dsh`**，本单（门禁修）无法验证它（铁律 §4.2：不碰 App），改机制属于未验证的行为变更。
  { f: "dsh-desktop.sh", why: "启动 App，nohup 共**两处**：① start) 的退回路径（open --env 不可用/老系统时直接执行二进制）② shared) 的主路径（老板明确要历史时直接拉进共享 ~/.dsh）；都属人手跑一次的启动，不是常驻服务入口" },
]
const SET_U_OK = [
  { f: "sync-code.sh", why: "双机同步脚本牵涉老板的口令与远端流程，单独排期再补（ISS-587 备注）" },
  { f: "restart-web-detached.sh", why: "补 set -u 会暴露历史未初始化变量，需回归验证后再收紧" },
  { f: "restart-web.sh", why: "同上（老盘入口的历史未初始化变量）；它的 kill 路径已由 scripts/prod-guard.sh 的牙覆盖" },
]
/** 历史上的一次性脚本（scratch）：见文件末 R5 说明 —— 这条**零豁免**。
 *  （曾经列过 5 条豁免，全部是我自己那版坏判据造出来的假债；判据修对后一条都不需要。
 *    留名单不删就是养化石，所以这里写死成空数组并保留这段注释当教训。） */
const HEADER_OK = []

/** R6 白名单：插件侧**已入库**的进程控制站点，每条必须写清「为什么它必须自己 spawn」。
 *  与 R2/R4 同款纪律：存量登记 + 写理由，新增即红，且豁免失效（文件没了 / 不再 spawn）也会报。
 *  ⚠️ 收敛到 forge-service-kit 的**不是**这些文件的 spawn —— kit 只提供判据/回收/停机/锁，
 *      「拉起什么、用什么命令、什么 env」永远是属主的业务语义（DOC-273 §2.1 L3 边界）。 */
const SPAWN_OK = [
  { f: "forge-trader/lib/index.js", why: "行情后端属主：spawn python app.py（lazy/auto 模式），进程是它自己的后端" },
  { f: "forge-agents/lib/zcode-stdio.js", why: "zcode stdio 通道属主：每 Run 拉起 app-server --stdio（回合结束即随 Run 收）" },
  { f: "forge-agents/lib/acp-client.js", why: "ACP stdio 客户端属主：每 Run 一个 CLI 子进程（detached 成组，dispose 树级清）" },
  { f: "forge-agents/lib/qoder-model-list.js", why: "Qoder 模型清单采集：一次性 spawn CLI 拉列表（带超时，非长驻）" },
]

const read = (dir, f) => {
  const p = join(dir, f)
  return existsSync(p) ? readFileSync(p, "utf8") : null
}

/** 一个文件的违例列表 */
function lintFile(name, src) {
  const out = []
  const isSh = name.endsWith(".sh")
  const lines = src.split("\n")
  const guarded = KILL_GUARDED.find((w) => w.f === name)
  // 牙在不在：只在**活着的代码行**上找（ISS-640）。找不到 ⇒ 这条文件连登记的形态也不再放行
  // （牙比豁免强，没有牙就只剩豁免 = 一句话）。
  const dead = deadBranchLines(lines)
  const teethLine = guarded ? lines.findIndex((text, i) => isCodeLine(text.trim()) && !dead[i] && guarded.requires.test(text)) : -1
  const guardedHasTeeth = !!guarded && teethLine >= 0
  // 行级豁免的**有效区间** = guarded_kill() 函数体（ISS-640/F2：位置也算判据）
  const allowRange = guardedHasTeeth ? guardedBodyRange(lines) : null
  const isAllowedLine = (i) => !!allowRange && i + 1 >= allowRange.start && i + 1 <= allowRange.end && guarded.allows.some((re) => re.test(lines[i].trim()))
  // 牙本身单列一条，且**先于**逐行违例入列：dedupe 只留每文件每规则第一条，
  // 放在后面会被"某处杀形态不对"顶掉，理由就落到杀上而不是缺牙上。
  if (guarded && !guardedHasTeeth) {
    // 文本上还找得到、只是不算数（在注释里 / 在死分支里）—— 这是最容易骗过人眼的那种假绿，点名说清。
    // 分三档：真调用在但被埋（死分支）· 只剩注释/文案提到 prod-guard.sh · 整个词都没了。
    const deadCallLine = lines.findIndex((l) => guarded.requires.test(l))
    out.push({
      rule: "R2",
      line: deadCallLine >= 0 ? deadCallLine + 1 : 1,
      text:
        deadCallLine >= 0
          ? `（${name} 的杀进程路径必须过 scripts/prod-guard.sh 的牙 —— 调用在文件里，但只在**注释或死分支**里，跑不到）`
          : /prod-guard\.sh/.test(src)
            ? `（${name} 的杀进程路径必须过 scripts/prod-guard.sh 的牙 —— 整份文件只是**提到**它（注释/echo 文案），真调用不在）`
            : `（${name} 的杀进程路径必须过 scripts/prod-guard.sh 的牙 —— 牙不在文件里了）`,
    })
  }
  lines.forEach((text, i) => {
    const t = text.trim()
    if (!isCodeLine(t)) return // 注释里提到关键词不算
    if (isSh) {
      if (RE.bareTimeout.test(text)) out.push({ rule: "R1", line: i + 1, text: t })
      if (isRealKill(text) && !KILL_OK.some((w) => w.f === name)) {
        // R2 行级豁免（ISS-614 + ISS-640）：登记形态之外一律红，且只有落在 guarded_kill()
        // 函数体内的那些行才算「过了牙」。
        if (!isAllowedLine(i)) {
          // 三种红的理由要能分开读：牙没了 / 形态对但位置不对（=F2 的那个洞）/ 形态本身没登记
          const shapeOk = guardedHasTeeth && guarded.allows.some((re) => re.test(t))
          const why = !guardedHasTeeth
            ? `${t}（KILL_GUARDED 登记的牙不在文件里：必须调 prod-guard.sh 才允许杀）`
            : allowRange === null
              ? `${t}（登记形态但找不到 guarded_kill()（豁免锚点）：形同没过牙）`
              : shapeOk
                ? `${t}（登记形态，但不在 guarded_kill() 函数体的第 ${allowRange.start}~${allowRange.end} 行内 ⇒ 那处的杀没过牙）`
                : t
          out.push({ rule: "R2", line: i + 1, text: why })
        }
      }
      if (RE.nohup.test(text) && !NOHUP_OK.some((w) => w.f === name)) out.push({ rule: "R4", line: i + 1, text: t })
    }
  })
  if (isSh && !hasSetU(src) && !SET_U_OK.some((w) => w.f === name)) {
    out.push({ rule: "R3", line: 1, text: "（文件内没有 set -u / set -euo pipefail）" })
  }
  // R5：要求"有**说明**"而不是"有 # 号"——shebang 每个脚本都有，拿它当判据等于没判
  // （第一版就是这么写的，自检当场把它抓成摆设）。
  if (!hasHeader(src) && !HEADER_OK.some((w) => w.f === name)) {
    out.push({ rule: "R5", line: 1, text: "（前 3 行没有说明性注释；shebang 不算说明）" })
  }
  return out
}

/** 每条规则去重到"每文件每规则报一次"，避免长文件刷屏把真问题埋掉 */
function dedupe(vs) {
  const seen = new Set()
  return vs.filter((v) => {
    const k = `${v.file}#${v.rule}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 只判**已入库**的脚本。
 *  ⚠️ 别人的在途 scratch（未 git add 的文件）不该让全仓体检变红 —— 那是假红，
 *     而假红的代价是人开始无视体检（本仓为这类误伤写过好几条纪律）。
 *     拿不到 git 清单时（自检的临时目录、非 git 环境）退回扫全目录，保证自检仍能验证规则。 */
function trackedScripts(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return new Set(out.split("\n").filter(Boolean).map((p) => basename(p)))
  } catch {
    return null
  }
}

/** 剥掉注释只留代码 —— R6 必须盯**代码**：插件注释里正当地讨论 spawn/kill
 *  （实测：`forge-agents/lib/routes.js` 的预热说明里写着 spawn(detached)，那是文字不是调用）。
 *
 *  ⚠️ 顺序不能反：**必须先删整行行注释，再剥块注释**。
 *     反过来的话，一行行注释里出现的「块注释起始符」（行情路由的路径通配恰好带着它）
 *     会被当成块注释开头，一路吞到下一个结束符 —— 实测吞掉 2412 字符、把 import 整段吃没，
 *     于是 cpImport 判否、该文件被误报「豁免失效」。
 *     这个 bug 是 R6 的「豁免失效也要报」抓出来的：守卫先抓到了自己。
 *  ⚠️ 本注释自身也不能含那两个符号序列（第一次写就因此让整个脚本编译不过）。 */
function jsCodeOnly(src) {
  return src
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

/** R6 扫描范围：插件包 lib 与 src 下的**生产** js/mjs（不含测试）。
 *  为什么不含测试：测试里 spawn 一个假进程是常规手法，纳进来只会逼人加豁免。
 *  ⚠️ 本注释里绝不能出现"星号加斜杠"的序列（会提前终止块注释）—— 第一次写时就踩了：
 *     把通配路径原样写进来后，块注释在那一行就断了，后面整段变成代码、启动即 ReferenceError。 */
function pluginJsFiles(dir) {
  const out = []
  let pkgs = []
  try {
    pkgs = readdirSync(dir).filter((f) => f.startsWith("forge-") && statSync(join(dir, f)).isDirectory())
  } catch {
    return out
  }
  for (const pkg of pkgs) {
    for (const sub of ["lib", "src"]) {
      const base = join(dir, pkg, sub)
      if (!existsSync(base)) continue
      const walk = (d) => {
        for (const name of readdirSync(d)) {
          if (name === "node_modules") continue
          const full = join(d, name)
          if (statSync(full).isDirectory()) walk(full)
          else if (/\.(js|mjs)$/.test(name) && !/\.test\.[cm]?js$/.test(name)) out.push(relative(dir, full))
        }
      }
      walk(base)
    }
  }
  return out
}

/** 判 R6 前先把存活探针抹掉（换成不含 `.kill(` 字样的占位符，免得替换文本自己又被 jsKill 命中）。 */
function stripProbeKills(code) {
  return code.replace(RE.jsProbeKill, "PROBE_KILL_CALL")
}

/** R6：插件侧进程控制必须声明（白名单带理由，或文件内自带 `@spawn-allow`）。 */
function lintPluginSpawns(dir) {
  const out = []
  for (const rel of pluginJsFiles(dir)) {
    let src
    try {
      src = readFileSync(join(dir, rel), "utf8")
    } catch {
      continue
    }
    const code = stripProbeKills(jsCodeOnly(src))
    // ① 必须真的 import 了 child_process（否则 `.kill(` 可能属于别的库 —— 那类假红最赶人）
    if (!RE.cpImport.test(code)) continue
    // ② 必须有启动或终止子进程的**调用**
    if (!(RE.jsSpawn.test(code) || RE.jsFork.test(code) || RE.jsKill.test(code))) continue
    // ③ 声明放行：白名单 或 文件内理由
    if (SPAWN_OK.some((w) => w.f === rel)) continue
    if (RE.spawnAllow.test(src)) continue
    const hit = code.split("\n").findIndex((l) => RE.jsSpawn.test(l) || RE.jsFork.test(l) || RE.jsKill.test(l))
    out.push({ file: rel, rule: "R6", line: hit + 1, text: "（插件侧 spawn/kill 未声明：加白名单条目或在文件内写 `// @spawn-allow: <理由>`）" })
  }
  return out
}

/** R6 豁免失效判据：文件没了、或它已不再 import child_process、或已无 spawn/kill 调用。 */
function spawnExemptionStillNeeded(dir, rel) {
  try {
    const code = stripProbeKills(jsCodeOnly(readFileSync(join(dir, rel), "utf8")))
    return RE.cpImport.test(code) && (RE.jsSpawn.test(code) || RE.jsFork.test(code) || RE.jsKill.test(code))
  } catch {
    return false
  }
}

export function run(dir = REPO_DIR, pluginRoot = join(dir, "..")) {
  let files = readdirSync(dir).filter((f) => f.endsWith(".sh") || f.endsWith(".mjs"))
  const tracked = trackedScripts(dir)
  const ignoredUntracked = tracked ? files.filter((f) => !tracked.has(f)) : []
  if (tracked) files = files.filter((f) => tracked.has(f))
  const violations = []
  for (const f of files) {
    if (f === "lint-scripts.mjs") continue // 本体：正则字面量里必然含关键词，自己查自己是自伤
    for (const v of lintFile(f, read(dir, f))) violations.push({ file: f, ...v })
  }
  // 豁免必须"仍然有效"：文件没了、或它已经不触犯这条规则，都要报出来。
  // 放养一条失效的豁免 = 规则被无声放宽（白名单养成长辈化石，本仓是有先例的）。
  const stale = []
  const chk = (list, rule, stillNeedsExemption) => {
    for (const w of list) {
      const src = read(dir, w.f)
      if (src === null || !stillNeedsExemption(src, w.f)) stale.push(`${rule}/${w.f}`)
    }
  }
  chk(KILL_OK, "R2", isRealKill)
  chk(NOHUP_OK, "R4", (s) => RE.nohup.test(s))
  // 注意第二个参数才是文件名：第一版在这里写了 `s.endsWith(".sh")`（拿内容判扩展名），
  // 于是三条 R3 豁免全被误判成失效 —— 守卫把自己的白名单报成红，是最赶人的一种错。
  chk(SET_U_OK, "R3", (s, f) => f.endsWith(".sh") && !hasSetU(s))
  chk(HEADER_OK, "R5", (s) => !hasHeader(s))
  // 行级豁免（KILL_GUARDED）同样要「仍然有效」：文件没了、或文件里已经没有一处登记形态的杀，
  // 这条豁免就该删 —— 与 R2 存量白名单同款纪律（放养失效豁免 = 规则被无声放宽）。
  // ⚠️ 判据与 lintFile **同一套**（ISS-640）：只看 guarded_kill() 函数体内的行 —— 否则
  //    函数体被删、外面临时抄了两行同样文本，会让这条豁免"看起来还有用"而一直挂在账上。
  for (const w of KILL_GUARDED) {
    const src = read(dir, w.f)
    let stillHit = false
    if (src !== null) {
      const lines = src.split("\n")
      const range = guardedBodyRange(lines)
      stillHit = !!range && lines.some((l, i) => i + 1 >= range.start && i + 1 <= range.end && w.allows.some((re) => re.test(l.trim())))
    }
    if (!stillHit) stale.push(`R2/${w.f}`)
  }
  // R6（ISS-646 · DOC-274 §2.4）：插件侧进程控制 —— 与 R1–R5 同款纪律（存量白名单 + 失效也报）。
  // ⚠️ 插件根与脚本目录**不是同一个**：本脚本住在 <repo>/scripts，而 forge-* 在仓库根下。
  //    故 run(dir) 的 dir 是脚本目录，插件侧另走 pluginRoot（默认 = dir 的父目录）。
  for (const v of lintPluginSpawns(pluginRoot)) violations.push(v)
  for (const w of SPAWN_OK) {
    if (!spawnExemptionStillNeeded(pluginRoot, w.f)) stale.push(`R6/${w.f}`)
  }
  return { files: files.length, violations: dedupe(violations), stale, ignoredUntracked, pluginScanned: pluginJsFiles(pluginRoot).length }
}

const RULE_TEXT = {
  R1: ".sh 禁用裸 `timeout`（macOS 无此命令）→ 用 curl --max-time 或自己计时",
  R2: "非白名单脚本不得杀进程 → 要重启 3210 请调 scripts/restart-matter.sh（现役入口；杀 3210 前必须过 scripts/prod-guard.sh 的牙）。`kill -0` 属探测，不算",
  R3: "缺 `set -u` → 变量名拼错时会静默走空值分支",
  R4: "非白名单脚本不得 nohup 拉常驻 → 常驻交 launchd/watchdog（AGENTS §4.3）",
  R5: "脚本头部缺说明注释 → 写清它干什么、判据来自哪张单",
  R6: "插件侧 spawn/kill 未声明 → 加 SPAWN_OK 白名单条目（必须写理由），或文件内写 `// @spawn-allow: <理由>`",
}

function report() {
  const r = run()
  console.log(`扫描 ${r.files} 个**已入库**脚本（scripts/）＋ ${r.pluginScanned} 个插件侧生产 JS（forge-*/lib|src）${r.ignoredUntracked?.length ? `；另跳过 ${r.ignoredUntracked.length} 个未入库的在途文件：${r.ignoredUntracked.join(" ")}` : ""}`)
  if (!r.violations.length) console.log("✓ 无新增违例")
  for (const v of r.violations) {
    console.log(`✗ ${v.rule} ${v.file}:${v.line} — ${RULE_TEXT[v.rule]}`)
    console.log(`    ${v.text.slice(0, 110)}`)
  }
  if (r.stale.length) {
    console.log(`✗ 白名单有 ${r.stale.length} 项已不再命中（= 规则被无声放宽）：${r.stale.join(", ")}`)
    console.log("  → 该删这条豁免就删掉，别留着当化石")
  }
  // 计数口径：整文件豁免（KILL_OK 等）与**行级**豁免（KILL_GUARDED）分开报 ——
  // 混成一个数会让人以为 app-proxy.sh 还是整文件放行的（那正是本单要治的形态）。
  console.log(`\n存量豁免（每条都带理由，新增即红；豁免失效也会报）：R2 ${KILL_OK.length} 整文件 + ${KILL_GUARDED.length} 行级/有牙 · R3 ${SET_U_OK.length} · R4 ${NOHUP_OK.length} · R5 ${HEADER_OK.length} · R6 ${SPAWN_OK.length}`)
  return { ok: r.violations.length === 0 && r.stale.length === 0, ...r }
}

// 反向验证：每条规则都要能被**故意破坏**触发，且干净样本不误伤。
// 恒绿的 lint 与没有 lint 等价（ISS-587 验收口径）。
function selftest() {
  const tmp = mkdtempSync(join(tmpdir(), "lint-selftest-"))
  let fails = 0
  // 记「跑了几项」：只数 ✓ 行（✗ 行不算通过项）。报告里给出条数，验收才有刻度可对
  // —— 「条数增加」是新增样本真的装上了的证据，光说"加了三条"不算。
  let checks = 0
  const rawLog = console.log
  console.log = (m, ...rest) => {
    if (typeof m === "string" && m.startsWith("✓")) checks++
    rawLog(m, ...rest)
  }
  const put = (name, text) => writeFileSync(join(tmp, name), text, "utf8")
  const del = (name) => rmSync(join(tmp, name), { force: true })
  const violIn = (name) => run(tmp, tmp).violations.filter((v) => v.file === name)
  try {
    put("clean.sh", "#!/usr/bin/env bash\n# 这是自检用的干净样本\nset -uo pipefail\necho hi\n")
    put("clean.mjs", "// 这是自检用的干净样本\nconsole.log(1)\n")
    const clean = run(tmp, tmp).violations.filter((v) => v.file.startsWith("clean."))
    if (clean.length === 0) console.log("✓ 干净样本不误伤（不该红的不红）")
    else {
      console.log("✗ 干净样本被误报（假红比没门禁更赶人）：", JSON.stringify(clean))
      fails++
    }
    del("clean.sh")
    del("clean.mjs")

    const cases = [
      ["R1", "bad1.sh", "#!/usr/bin/env bash\n# 说明\nset -u\ntimeout 5 curl http://x\n"],
      ["R2", "bad2.sh", "#!/usr/bin/env bash\n# 说明\nset -u\npkill -f dsh\n"],
      ["R3", "bad3.sh", "#!/usr/bin/env bash\n# 说明\necho hi\n"],
      ["R4", "bad4.sh", "#!/usr/bin/env bash\n# 说明\nset -u\nnohup node server.js &\n"],
      ["R5", "bad5.sh", "#!/usr/bin/env bash\nset -u\necho hi\n"],
    ]
    for (const [rule, name, text] of cases) {
      put(name, text)
      const hit = violIn(name).find((v) => v.rule === rule)
      if (hit) console.log(`✓ ${rule} 被故意破坏时判红（${name}:${hit.line}）`)
      else {
        console.log(`✗ ${rule} 破坏了却没报 —— 这条规则是摆设`)
        fails++
      }
      del(name)
    }

    // `kill -0` 是探测，不该被 R2 抓
    put("probe.sh", "#!/usr/bin/env bash\n# 说明\nset -u\nif kill -0 1234 2>/dev/null; then echo alive; fi\n")
    if (!violIn("probe.sh").some((v) => v.rule === "R2")) console.log("✓ `kill -0` 按探测处理，未被 R2 误伤")
    else {
      console.log("✗ `kill -0` 被当成杀进程 —— 探测语义被误伤")
      fails++
    }
    del("probe.sh")

    // R2 行级豁免 + 牙（ISS-614）：整文件豁免的洞 —— 登记形态之外的杀必须红，牙没了也要红。
    // 样本按守卫里登记的形态写（文件内调 prod-guard.sh + kill -TERM "$pid"）。
    const GUARDED_OK =
      '#!/usr/bin/env bash\n# 说明\nset -u\nROOT=/x\n' +
      'guarded_kill() {\n  bash "$ROOT/scripts/prod-guard.sh" require-kill "$pid" || return 4\n  kill -TERM "$pid" 2>/dev/null || true\n}\n'
    put("app-proxy.sh", GUARDED_OK)
    if (!violIn("app-proxy.sh").some((v) => v.rule === "R2")) console.log("✓ R2 行级豁免：登记的形态 + 牙在场 ⇒ 放行（代理重启入口不误伤）")
    else {
      console.log("✗ R2 把有牙的登记形态也报了 —— 会逼人把牙删掉换成豁免")
      fails++
    }
    // ⭐ 验收 #5 的判据：这正是审查实测塞进去的那一行
    put("app-proxy.sh", GUARDED_OK + 'pkill -9 -f "dsh web"\n')
    if (violIn("app-proxy.sh").some((v) => v.rule === "R2")) console.log("✓ R2 行级豁免：登记形态之外的杀（pkill -9 -f）判红 —— 整文件豁免的洞堵上了")
    else {
      console.log("✗ 整文件豁免的洞还在：往 app-proxy.sh 塞 pkill 仍然零违例")
      fails++
    }
    // 牙被拆掉 ⇒ 连登记形态也不再放行（否则"有豁免"就等于"能杀"）
    put("app-proxy.sh", GUARDED_OK.replace('  bash "$ROOT/scripts/prod-guard.sh" require-kill "$pid" || return 4\n', ""))
    if (violIn("app-proxy.sh").some((v) => v.rule === "R2")) console.log("✓ R2 行级豁免：牙被拆掉 ⇒ 连登记形态也不再放行")
    else {
      console.log("✗ 牙没了却还在放行 —— 豁免退化成一句空话")
      fails++
    }
    // ⭐ ISS-640 F1-a：牙"还在文件里"但要**只是注释** —— 真调用删掉、留一句说明。改前是假绿
    // （`/prod-guard\.sh/` 被注释满足），实测 app-proxy.sh 整条拆牙仍 exit 0。
    put("app-proxy.sh", GUARDED_OK.replace('  bash "$ROOT/scripts/prod-guard.sh" require-kill "$pid" || return 4\n', "  # 每一处杀都先过 scripts/prod-guard.sh 的牙（这句注释就是全部）\n"))
    if (violIn("app-proxy.sh").some((v) => v.rule === "R2")) console.log("✓ R2 行级豁免：牙只剩注释（真调用删了）⇒ 判红 —— 文本匹配的洞堵上了")
    else {
      console.log("✗ 只留一句注释就骗过了牙判据 —— 牙可以整条拆掉而门禁仍绿")
      fails++
    }
    // ⭐ ISS-640 F1-b：牙调到 `if false; then` 里（调用还在、但永不执行，四处杀照旧执行）。
    put("app-proxy.sh", GUARDED_OK.replace('  bash "$ROOT/scripts/prod-guard.sh" require-kill "$pid" || return 4\n', '  if false; then\n    bash "$ROOT/scripts/prod-guard.sh" require-kill "$pid" || return 4\n  fi\n'))
    if (violIn("app-proxy.sh").some((v) => v.rule === "R2")) console.log("✓ R2 行级豁免：牙被调进 `if false` 死分支 ⇒ 判红 —— 牙在文本里不等于牙在跑")
    else {
      console.log("✗ 牙进了 `if false` 仍算在场 —— 「有牙」变成文本游戏")
      fails++
    }
    // 反面对照：`if ! out="$(…)"` 这种 fail-closed 的条件**不是**死分支，必须照常放行
    // （否则会逼人把牙从条件里搬出来写成非 fail-closed 的形状）。
    put("app-proxy.sh", GUARDED_OK.replace('  bash "$ROOT/scripts/prod-guard.sh" require-kill "$pid" || return 4\n', '  if ! out="$(bash "$ROOT/scripts/prod-guard.sh" require-kill "$pid" 2>&1)"; then return 4; fi\n'))
    if (!violIn("app-proxy.sh").some((v) => v.rule === "R2")) console.log("✓ R2 行级豁免：fail-closed 的 `if ! cmd` 里的牙照常算在场（死分支判据不误伤）")
    else {
      console.log("✗ 把 fail-closed 的牙误判成死分支 —— 会逼人改成非 fail-closed 的形状")
      fails++
    }
    // ⭐ ISS-640 F2：逐字相同的杀行抄到 guarded_kill() **外面** ⇒ 必须红（豁免锚的是函数体，不是字符串）
    put("app-proxy.sh", GUARDED_OK + 'restart)\n  kill -TERM "$pid" 2>/dev/null || true\n  ;;\n')
    if (violIn("app-proxy.sh").some((v) => v.rule === "R2")) console.log("✓ R2 行级豁免：逐字相同的行放到 guarded_kill() 之外 ⇒ 判红 —— 豁免不再不分位置")
    else {
      console.log("✗ 函数体外抄一行同样文本照样放行 —— 豁免又退化成整文件级")
      fails++
    }
    del("app-proxy.sh")

    // 牙自身的调用形式 `require-kill "$pid"` 里含 "kill $pid" 三个词 —— 别把它当成杀进程。
    // （本单实际踩到：给 app-proxy.sh 加完牙，lint 反手把**牙的调用**报成 R2，理由指向牙那一行。）
    put("teeth-call.sh", '#!/usr/bin/env bash\n# 说明\nset -u\nif ! out="$(bash scripts/prod-guard.sh require-kill "$pid" 2>&1)"; then exit 4; fi\n')
    if (!violIn("teeth-call.sh").some((v) => v.rule === "R2")) console.log('✓ `prod-guard.sh require-kill "$pid"` 不被误判成杀进程（复合词 require-kill）')
    else {
      console.log("✗ 牙的调用被当成杀 —— 会逼人不敢调牙，或改用变量名绕过判据")
      fails++
    }
    del("teeth-call.sh")

    // R6：插件侧 spawn/kill 必须声明 —— 三种样本各验一次（未声明红 / @spawn-allow 放行 / 无关文件不误伤）
    mkdirSync(join(tmp, "forge-probe", "lib"), { recursive: true })
    put("forge-probe/lib/bare.js", 'import { spawn } from "node:child_process"\nconst c = spawn("x", [])\nvoid c\n')
    const r6Bare = run(tmp, tmp).violations.filter((v) => v.rule === "R6" && v.file === "forge-probe/lib/bare.js")
    if (r6Bare.length) console.log(`✓ R6 未声明的插件侧 spawn 判红（${r6Bare[0].file}:${r6Bare[0].line}）`)
    else {
      console.log("✗ R6 破坏了却没报 —— 这条规则是摆设")
      fails++
    }
    put("forge-probe/lib/allowed.js", '// @spawn-allow: 自检样本，理由写得足够长\nimport { spawn } from "node:child_process"\nspawn("x", [])\n')
    if (!run(tmp, tmp).violations.some((v) => v.rule === "R6" && v.file === "forge-probe/lib/allowed.js")) console.log("✓ R6 识别文件内 `@spawn-allow` 理由（放行）")
    else {
      console.log("✗ R6 把写了理由的站点也报了 —— 会逼人去删注释")
      fails++
    }
    // 存活探针 `process.kill(pid, 0)` 不是进程控制：R2 早就豁免了 `kill -0`，R6 第一版漏了同一条，
    // 于是把 forge-agents/lib/child-lease.js 的 pidAlive 判成未声明（ISS-727 收口时实测撞上）。
    put("forge-probe/lib/probe.js", 'import { execFileSync } from "node:child_process"\nexport function pidAlive(n) { try { process.kill(n, 0); return true } catch { return false } }\nvoid execFileSync\n')
    if (!run(tmp, tmp).violations.some((v) => v.rule === "R6" && v.file === "forge-probe/lib/probe.js")) console.log("✓ R6 不误伤存活探针 `kill(pid, 0)`")
    else {
      console.log("✗ R6 把存活探针判成进程控制 —— 探测语义被误伤，取证类插件会被逼着写假理由")
      fails++
    }
    // 但**带信号**的 kill 必须照样红 —— 否则这条豁免就放宽过头了。
    put("forge-probe/lib/realkill.js", 'import { spawn } from "node:child_process"\nexport function stop(p) { process.kill(p, "SIGKILL") }\nvoid stop\n')
    if (run(tmp, tmp).violations.some((v) => v.rule === "R6" && v.file === "forge-probe/lib/realkill.js")) console.log("✓ 真杀（带信号）照样判红：豁免没有放宽过头")
    else {
      console.log("✗ 豁免过头：process.kill(p, \"SIGKILL\") 都没报")
      fails++
    }
    put("forge-probe/lib/notspawn.js", 'import { readFileSync } from "node:fs"\nconsole.log(readFileSync)\n')
    put("forge-probe/lib/commentonly.js", '// 这段注释讨论 spawn(x) 但不调用\nimport { readFileSync } from "node:fs"\nconsole.log(readFileSync)\n')
    const EXPECTED_RED = new Set(["forge-probe/lib/bare.js", "forge-probe/lib/realkill.js"])
    const r6False = run(tmp, tmp).violations.filter((v) => v.rule === "R6" && !EXPECTED_RED.has(v.file))
    if (r6False.length === 0) console.log("✓ R6 不误伤：无关文件与「只提到 spawn 的注释」都放行")
    else {
      console.log("✗ R6 假红（假红比没门禁更赶人）：", JSON.stringify(r6False))
      fails++
    }

    // 白名单文件在场但已不含相应关键词 → 必须报"豁免失效"
    for (const f of ["restart-web.sh", "restart-web-detached.sh", "dev-instance.sh", "watchdog-web.sh", "sync-code.sh"]) {
      put(f, "#!/usr/bin/env bash\n# 说明\nset -u\necho hi\n")
    }
    const stale = run(tmp, tmp).stale
    if (stale.some((s) => s.startsWith("R2/")) && stale.some((s) => s.startsWith("R4/")) && stale.some((s) => s.startsWith("R3/"))) {
      console.log(`✓ 豁免失效可被查出（${stale.length} 项，例：${stale.slice(0, 3).join(", ")}）`)
    } else {
      console.log("✗ 白名单已不命中却没报 —— 规则正在被无声放宽", JSON.stringify(stale))
      fails++
    }
  } finally {
    console.log = rawLog
    rmSync(tmp, { recursive: true, force: true })
  }
  if (fails) {
    console.log(`\n守卫自检 ${fails} 项不过（共 ${checks + fails} 项）→ 退出 2`)
    process.exit(2)
  }
  console.log(`\n✓ 守卫自检通过（${checks} 项：六条各自能红、干净不误伤、豁免失效会报）`)
}

const mode = process.argv[2] || "--check"
if (mode === "--selftest") {
  selftest()
} else {
  const r = report()
  // ISS-832：`--check` 判到**违规**（白名单不符 / 规则失效）⇒ 1。原先用 2，而 2 在新口径里是「判不了」。
  //   本格登记为 selfcheck（非 0 即红），改码不改行为，只是把语义写对。
  if (mode === "--check" && !r.ok) process.exit(1)
}
