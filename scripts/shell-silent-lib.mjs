/**
 * shell 静默失败判据族（E5 / K9c）—— 「吞失败」与「探测」的分界 + 注释剥离。
 *
 * 从 `scripts/code-inventory.mjs` 搬出（ISS-774）：判据本体与 `--selftest-k9c` 的变异验证同住一处；
 * 口径正文（为什么探测不算、已知残留）在原注释里，逐字未改。
 */

/* E5/K9c 的口径修正（2026-10-19 · ISS-625）：**注释里提到这个模式不算违规**。
 *
 * 原实现直接对整份文件做 `\|\|\s*true|2>\/dev\/null` 文本匹配 ⇒ 把「解释这个模式的文字」
 * 当成了「使用这个模式」。实测影响面：全仓 412 处里 9 处是注释（2.2%）。
 * 踩过的具体案例：给 prune 写一句「不用 || true」的注释，K9c 当场 +1 —— 那句注释是**防护说明**，
 * 却被记成违规，等于「越解释越像犯错」。
 *
 * 剥离规则（保守，宁少剥不错剥）：
 *   ① 整行注释（`^\s*#`）→ 整行丢弃；
 *   ② 行内注释（代码后面 `# ...`）→ **只丢 # 之后的部分，保留前面的代码**。
 *      为什么不能整行丢：`app-proxy.sh:238` 是 `... 2>/dev/null || true; done   # 注释`，
 *      整行丢会把真实违规一起丢掉（假阴性比假阳性更贵）。
 *   ③ 不处理 `#` 出现在引号/`${var#pat}` 里的情况 —— 退化为「不剥」，
 *      只会让计数偏保守（多报），不会漏报。全仓实测：这类行**都不含**被匹配的字面量。
 */
export function stripShellComments(src) {
  return src.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return ''
    // 行内 #：只在「# 前面是空白」时认作注释起点（`${v#x}` 前面不是空白）
    const m = line.match(/\s#/)
    return m ? line.slice(0, m.index) : line
  }).join('\n')
}

/** E5/K9c 的判据本体（ISS-771）：**只把「吞失败」算欠账，「探测」不算**。
 *
 * 旧口径把 `2>/dev/null` 与 `|| true` 一律计数，于是把运维脚本里大量**正确写法**记成欠账：
 *   `readlink "$link" 2>/dev/null || true`（读一个可能不存在的软链）
 *   `kill -0 "$pid" 2>/dev/null || continue`（进程死了是**正常态**）
 *   `lsof -tiTCP:$PORT 2>/dev/null`（没人监听是正常态）
 * 这些命令在正常路径上天天返回非零；把它们的 stderr 放出来只会污染运维日志。
 *
 * 新口径（**语法可判，不用命令白名单** —— 白名单是弱证据，K9a 的 `-probe` 已经吃过这个亏）：
 *   一个 `2>/dev/null` 只有在**它的命令退出码没有任何消费者**时才算「吞失败」。
 *   消费者有三种，命中任一即判为探测、不计：
 *     ① 条件位：行首是 `if` / `elif` / `while` / `until`
 *     ② 同行 fallback：重定向后面紧跟 `||` 或 `&&`
 *     ③ `|| true` 这个记号本身就是消费者 ⇒ 它自己永远不算吞失败
 *   ⇒ 反过来说：`git push 2>/dev/null`（跑完不看退出码、也不交给条件）**仍然计数**。
 *
 * ⚠️ 已知残留（明写，别当 bug）：`git push || true` 这种**真吞失败**也会因为 `||` 被判成探测。
 *    语法上它和 `readlink … || true` 无法区分；要抓它需要"命令是否会正常失败"的语义，属另单。
 * ⚠️ 条件位判定是**整行**级的：`if a; then git push 2>/dev/null; fi` 这种一行写完的会把后者也免掉。
 *    实测全仓没有这种写法（`--selftest-k9c` 里记了这条边界）。 */
export function silentShellHitLines(line, lineNo) {
  const out = []
  const cond = /^\s*(if|elif|while|until)\b/.test(line)
  const re = /2>\/dev\/null|\|\|\s*true/g
  let m
  while ((m = re.exec(line)) !== null) {
    if (m[0].startsWith('||')) continue // `|| true` 本身是消费者
    if (cond) continue // 条件位 ⇒ 探测
    const rest = line.slice(m.index + m[0].length)
    if (/^\s*(\|\||&&)/.test(rest)) continue // 同行 fallback 消费了失败 ⇒ 探测
    out.push(lineNo)
  }
  return out
}

/** `--selftest-k9c`（ISS-771）：E5 口径的**变异验证**（正控/反控各半，照 K9a 的规格）。 */
export function selftestK9c() {
  const cases = []
  const push = (n, ok, note) => cases.push({ n, ok: !!ok, note })
  const hits = (line) => silentShellHitLines(line, 1).length

  /* 正控（探测 ⇒ 不计）：三类消费者各一条 + 两种真实形态 */
  push('正控 `kill -0 "$pid" 2>/dev/null || continue` 不计', hits('kill -0 "$_pid" 2>/dev/null || continue') === 0)
  push('正控 `if lsof -tiTCP:$PORT 2>/dev/null; then` 不计', hits('if lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null; then') === 0)
  push('正控 `readlink "$link" 2>/dev/null || true` 不计（|| 是消费者）', hits('[ "$(readlink "$link" 2>/dev/null || true)" = "$want" ]') === 0)
  push('正控 `cd "$x" 2>/dev/null && pwd -P` 不计（&& 左侧）', hits('want="$(cd "$WT_ROOT" 2>/dev/null && pwd -P)"') === 0)
  push('正控 `while … 2>/dev/null; do` 不计', hits('while read -r l 2>/dev/null; do :; done') === 0)

  /* 反控（吞失败 ⇒ 仍计）：没任何消费者 */
  push('反控 `git push 2>/dev/null` 仍计（无消费者）', hits('git push 2>/dev/null') === 1)
  push('反控 `cmd 2>/dev/null; echo x` 仍计（`;` 不是消费者）', hits('deploy.sh 2>/dev/null; echo done') === 1)
  push('反控 行尾裸 `2>/dev/null` 仍计', hits('rm -rf "$DIR" 2>/dev/null') === 1)
  push('反控 `|| true` 自己不再单独计（但同行的裸 2>/dev/null 计）',
    hits('git push 2>/dev/null || true') === 0 && hits('git push 2>/dev/null ; true') === 1)

  /* 边界：别把 `2>&1`、`>/dev/null`（不带 2）误算 */
  push('边界 `2>&1` 不计', hits('cmd 2>&1') === 0)
  push('边界 `>/dev/null`（stdout）不计', hits('cmd >/dev/null') === 0)

  let bad = 0
  console.log('code-inventory --selftest-k9c（E5：探测 vs 吞失败）')
  for (const c of cases) { console.log(`  ${c.ok ? '✓' : '✗'} ${c.n}${c.note && !c.ok ? '（' + c.note + '）' : ''}`); if (!c.ok) bad++ }
  console.log(bad ? `\n✗ 反向验证失败 ${bad}/${cases.length}` : `\n✓ ${cases.length}/${cases.length} 项通过：探测不计、吞失败仍计`)
  return bad ? 1 : 0
}
