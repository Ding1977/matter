/**
 * 实测耗时表与超时红线折算（run-gates L3 的阈值层）。
 *
 * 从 `scripts/run-gates.mjs` 搬出（ISS-772）：唯一真相是 MEASURED 表 + 基准核数，
 * 红线 = 表值 × 安全系数 × 基准核数/本机核数。表值口径见下方原注释。
 */
import os from "node:os"
import path from "node:path"

export const DEFAULT_TIMEOUT_MS = 60_000
/**
 * 超时安全系数（ISS-725）：红线 = 实测 × 基准核数/本机核数 × 本系数。
 * 取 3 沿用 ISS-714 的原口径（「留 3 倍余量给冷缓存/慢机」），只是现在**再乘一道核数折算**。
 * 为什么不是 2：核数折算只补偿「平均慢」，不补偿抖动 —— 同一格本机三次实测 103/132/108.74s
 * 就散了 25%，冷缓存另算。3 倍是给这两者留的，别为了少几条红去压它。
 */
export const TIMEOUT_SAFETY = 3
// ─────────────────────────────────────────────────────────────────────────────
// §2 实测耗时表（唯一真相源：timeout 与「进不进快档」都由它推出来）
//
// 数字来自 ISS-714 现场逐格实测（9 并发上限、本机 M 系列、`bun` 不在 PATH 的空档）。
// 只收录 >1.5s 的格：其余 81 格合计 17.0s，一律 60s 超时 + 进快档。
// 两条派生规则：
//   timeoutMs = max(60s, ⌈实测 × 3 × 核数系数⌉) —— 见下方 timeoutFor。
//   进不进快档 = 实测 > 1.5s ⇒ 不进（快档是 <30s 的合入前信号，不是全量档的子集展示）。
// ⚠️ 新增一格若落在快档会更慢：改这里一行即可。`--list` 会打出快档实数，漂了看得见。
//
// ⚠️⚠️ **表里的秒数是「MEASURED_BASELINE_CORES 核」上测的**，不是通用值（ISS-725）。
//   同一格在不同核数的机器上能差 2~5 倍（实测：`host-typecheck-ratchet@--selftest`
//   本机 10 核 103~132s、CI 慢机器上跑不完）。拿它当绝对秒数直接比 = 用一台机器的速度量另一台。
//   所以换算必须带上核数，两个输入都要显式（表值 + 基准核数），不许有隐形常数。
// ─────────────────────────────────────────────────────────────────────────────
/** 上表所有秒数的测量基准机器核数。改表值时若换了机器，**必须同时改这里**，否则折算方向会反。 */
export const MEASURED_BASELINE_CORES = 10

export const MEASURED = {
  // ISS-725：`guard-baselines` 全量档。原先**没有登记**，于是它只能靠内联写死 600_000 ——
  // 一个说不出出处的死数，CI 上 600.01s 正好撞死。数值出处：
  // scripts/baseline/gate-health/2026-10-24T2004.json 的 meta.durations.guard = 183.8s
  // （同文件 meta 记了 head/branch/treeKind，**没记核数** —— 这是它作为折算输入的先天缺陷）。
  // ⇒ 本条按 10 核基准登记（同 MEASURED_BASELINE_CORES），折算后 2 核 = 183.8×3×5 ≈ 2757s；
  //    看着宽，但这正是本单要的：宁可让 2 核机器跑完并**给出判决**，也不要它被掐死在 600s 零信息。
  // ⚠️ 它是全量档聚合格，本身包含 91 格；它跑不完 = 那 91 格全都没判。
  "guard-baselines@": 183.8,
  // 测量条件：本机 10 核；2026-11-09 由 ISS-743 重算。
  //   host-typecheck 两格为**单格单跑**；其余为 4~6 并发下实测的**上界**（并发只会更慢，故偏保守）。
  //   新值 = ⌈实测 × 1.2 / 3⌉（timeoutFor 会再乘 TIMEOUT_SAFETY=3，留出 20% 余量后红线 ≥ 实测×1.2）。
  "host-typecheck-ratchet@--selftest": 261.6, // 实测 >654s（截断点，非收敛值）
  "host-typecheck-ratchet@--check": 177.08, // 实测 442.7s（旧表 40.16 ⇒ 红线 120s，早被杀）
  "shell-utf8-var-guard@--check": 97.6, // 实测 >244s（旧表 21.18 ⇒ 红线 64s）
  // ⚠️ ISS-791：`--selftest` 这一格此前**完全未登记** ⇒ 兜底 60s，而 full 档 10 并发实测 **77.54s** 必翻。
  //   单跑只有 1.1s（10 路同格并发 3.3s）—— 它不是自己慢，是被同批的 host-typecheck（单格 286s，吃满核）饿死。
  //   表值 = ⌈77.54 × 1.5 ÷ 3⌉ = 39 ⇒ 红线 117s。口径同 ISS-787 / ISS-777。
  //   ⚠️ 键是 **脚本名@arg**，不是 cell id@arg —— 两格同属一个条目，键必须按 arg 分开。
  "shell-utf8-var-guard@--selftest": 39,
  // ⚠️ `lint-mutation-tests` **不要**在这里再登记一次：它已有 `lint-mutation-tests@: 13.28`（下文 ISS-745 段），
  //   而 JS 对象**重复键后者覆盖前者** ⇒ 在上面写一个新值等于没写，还会留下「已登记」的假象
  //   （ISS-777 就是栽在「键写对了查不到」这一类）。且它的超时**不走 MEASURED**：inline 格
  //   `scripts/lib/inline-gates.mjs:71` 给了 `timeoutMs: 150_000` 写死，实测 75.72s 余量足够。
  "ws-lease-selftest@selftest": 54, // ISS-787：原 31.6 ⇒ 红线 95s，full 档 10 并发实测 106.40s
  "lint-code@--check": 72, // 实测 >180s（旧表 8.75 ⇒ 红线 60s，run-gates 必杀）
  "code-inventory@--compare": 72, // 实测 >180s（旧表 8.41 ⇒ 红线 60s）
  // ISS-743：以下三格原**未登记**，按「未见实测」落进快档并使用 60s 兜底；实测均远超。
  "pm-v2-baseline@--check": 67.6, // 实测 169s
  "canvas-style-check@--selftest": 53.2, // 实测 133s
  "secret-scan@--selftest": 55.2, // 实测 138s
  "ws-base-guard-selftest@selftest": 7.54,
  "lint-design@--check": 39, // ISS-787：原表 3.33（单跑口径）⇒ 红线 60s，而 full 档 10 并发实测 76.68s 必翻
  // ↑ 同批四格：单跑全是秒级，full 档全超时。原因不是它们慢，是**表值按单跑登记**、而红线在并发下才被用。
  //   实测（2026-11-10 · 本机 10 核 · full 档同批含 host-typecheck 286s 巨兽）：
  //     lint-design            单 3.66s → 并发 76.68s（20×，同格 10 路并发实测 18.24s = 4.98×，同批更糟）
  //     lint-tool-contract     单 2.10s → 并发 69.53s
  //     stale-client-bundle    单 0.03s → 并发 66.60s   ← 0.03s 排到 66s，不可能是它自己干的
  //     ws-lease-selftest      单 31.92s → 并发 106.40s
  //   表值 = ⌈并发实测 × 1.5 ÷ 3⌉（1.5 沿用 ISS-777 的口径：并发放大远超 1.2）。
  // ⚠️ 键是 **脚本文件名@arg**（measuredKey），不是 cell id@arg —— ISS-777 在这里错过一次。
  // ⚠️ 深层问题（同批另一单）：全局 N 路并发 + 每格不限流 = 结构性超订。本表只是把**阈值**钉对，
  //   不是修并发模型；把红线放宽不等于「这格该慢 76s」。
  "lint-tool-contract@--check": 35,
  "stale-client-bundle@--selftest": 34,
  // inline 格（无参数）的键是「脚本名@」—— 对应 inline-gates.mjs 的 timeoutFor("stale-client-bundle@")。
  // 单跑 0.31s，full 档 10 并发实测 **72.89s（235×）**：全树扫 + 读一堆 dist 元数据，并发时被 I/O 饿死。
  "stale-client-bundle@": 49,
  "ws-lease-selftest@selftest": 54, // 原 31.6 ⇒ 红线 95s；full 档实测 106.40s
  "format-debt@--compare": 2.27,
  "watch-home-links@--selftest": 2.18,
  // ISS-713：oxlint 棘轮。档位由 registry 的 cells[].tiers 给（full,ci），
  //   本表只提供**超时**口径 —— 漏登记会让 timeoutFor 走缺省值，与实测脱节。
  // 实测：--check 1.7s（539 文件）；--selftest 1.9s（造临时目录 + 假 oxlint）。
  "lint-oxlint@--check": 1.7,
  "lint-oxlint@--selftest": 1.9,
  // ISS-717：jscpd 重复度棘轮。实测：--check 0.15s（500 文件 / 108 克隆）；--selftest 0.6s。
  // ⚠️ 它**不进 fast 档**（fast 只跑最要紧的格；重复度不是"合入前 block 人"那一类）。
  // ISS-755 起档位由 registry 的 cells[].tiers 直接写 full,ci —— 不再靠"把数写高"来表达例外。
  "lint-jscpd@--check": 0.15,
  "lint-jscpd@--selftest": 0.6,
  // ⚠️ 2026-11-10（ISS-777 现场）：三格在 fast 档撞 60s 红线，但**单独跑只要 8~26s**。
  //   根因不是判据慢，是本机 I/O —— 单文件 open+read ≈24ms，10 并发时 I/O 排队 ⇒ 实测放大 2.3~5.9 倍：
  //     data-root-check@--check               单跑 20.43s → 并发 60.01s（被掐死，≥3.0×）
  //     deps-hygiene@--compare                单跑  8.63s → 并发 51.20s（5.9×）
  //     lint-channel-contract-selftest        单跑 25.64s → 并发 60.00s（被掐死，≥2.3×）
  //   表值口径破例用 **1.5** 而不是 1.2：并发放大倍数远超 1.2，按 1.2 算出的红线仍紧贴实测值
  //   ⇒ 会退化成「每天在 60s 上下抖着偶发零信息超时」，比宽一点更糟。
  //   表值 = ⌈并发实测 × 1.5 ÷ 3⌉。首轮给的 93/78/90s 仍被撞（data-root 93.00s、md-corpus 90.01s
  //   都正好卡在线上，实测并发下更慢）⇒ 两个 I/O 大户再抬到 50（红线 150s）。
  //   只在**真卡住**时触发，不再把「这台机器此刻忙」报成超时。
  "data-root-check@--check": 50,
  "deps-hygiene@--compare": 26,
  // ⚠️ 键是 `measuredKey(script, arg)` = **脚本文件名**@arg，不是 cell id@arg。
  //    我第一次写成 `lint-channel-contract-selftest@--selftest`（cell id）⇒ 表里查不到 ⇒
  //    tier 输出仍打「表值未登记 × 3 = 红线 60.00s」，红线压根没变（2026-11-10 实测 60.01s 撞线验证）。
  "lint-channel-contract@--selftest": 30,
  // 同一现场：ISS-777 修好「子进程 env 没拿到 PM 根」之后，这一格**开始真的扫 5533 个 md**
  // （之前读空壳根 ~/.dsh/pm 只扫到 2 个 ⇒ 一直报不判）。实测单跑 31.61s。
  // 表值 = ⌈31.61 × 1.5 ÷ 3⌉ ≈ 16 会让红线只有 48s（比缺省 60s 还紧）⇒ 反而更容易被掐死。
  // 取 30：红线 90s，只挡真卡住。**代价要记住**：fast 档从此多一格 30s 级的格。
  "md-corpus-guard@--check": 50,
  // ISS-745（S0c-2）：7 个 full-only 慢格实测后接进 ci 的格。值 = ⌈实测 × 1.2 / 3⌉。
  //   测量条件：本机 10 核、单格单跑、2026-11-09。空 HOME 下复跑同样绿（这几格不读本机 home）。
  //   ⚠️ 这几格是 standalone / inline 格，timeout 仍由各自的 `timeoutMs` 字段给（已足够宽）；
  //      本表登记的是**实测档案**，供「快档准入」与性能账使用，不是它们的超时来源。
  "gate-health@--selftest": 0.02, // 实测 0.05s
  "assembly-realize@": 0.24, // 实测 0.60s
  "dts-gate@": 0.05, // 实测 0.12s
  "lint-mutation-tests@": 13.28, // 实测 33.2s
  // ISS-825：node:test 形态的格接进 registry 时实测（本机 10 核 · full 档 10 并发）。
  //   单跑只有 6~7s，但 full 档里要跟 host-typecheck 这类吃满核的巨兽同批 ⇒ 放大 8~10×。
  //   表值 = ⌈并发实测 × 1.5 ÷ 3⌉（1.5 沿用 ISS-787/ISS-777 的并发放大口径）。
  //   ⚠️ 键是 **脚本文件名**@arg（measuredKey），不是 cell id@arg —— 见上方 ISS-777 那次踩空。
  //   ⚠️ 只有这一条：同批原本还给 `lint-code.test@--check` 登记过 42，但那一格后来**删了**
  //      （该文件已被 lint-mutation-tests 的 glob 覆盖，重复登记 = 同一批用例跑两遍）。
  //      删格时同步删表值 —— 留一条永远命中不了的条目，下一个人会以为它在跑。
  "build-index-credential.test@--check": 26, // 实测 full 档并发 51.02s
  // ISS-784：`gate-fast` 聚合闸（四格串行）。原先是 gate-tables 里写死的 120_000 ⇒ 实测 107s
  // 只剩 13s 余量，机器一有负载就翻成 `timeout`（零信息，看着跟真红一样）。
  // 值按四格分段实测之和给：design 5.2s + **lint-code 79.5~180s** + deps 7.2s + capability 6.6s ≈ 200s，
  // 取 220 覆盖 lint-code 的抖动上界。⚠️ 它**不快了**：`lint-code@--check` 本表早就记着「实测 >180s」，
  // gate-fast 自称「只跑秒级那一档」已经不成立；要真回秒级得给 lint-code 加 `--changed` 增量模式（独立单）。
  "gate-fast@": 220,

  // ── ISS-820：20 格从硬编码表收进 registry（kind:"legacy"）后补的实测登记 ──────────
  //
  // ⚠️ 这一段**不是档案，是超时红线本身**。legacy 格不许写 `timeoutMs`（见 `registry.ts` 的
  //   `timeoutMs?: never`：写死会绕过核数折算，少核机器上稳定撞线），红线一律由本表折算。
  //   迁移前这些数在 gate-tables.mjs / inline-gates.mjs 各自的 `timeoutMs` 字段上；迁走那一刻
  //   若不补到这里，**红线会静默退回 60s 缺省值**。实测已复现：迁移后 `--list` 里这 20 格
  //   全部打 60000ms，而 check-pm-suite-twice 实测 132.8s、lint-mutation-tests 实测 58.3s
  //   ⇒ 前者每次必被掐死，屏幕上只有 `timeout after 60000ms`（零信息，看着跟真红一样）。
  //
  // ⚠️⚠️ 键是 `measuredKey(script, arg)` = **脚本文件名@arg**，不是 cell id@arg。
  //   本条踩了两次：先按 cell id 写了一版（`gate-base-leak` 碰巧对，`git-health` 全错，
  //   因为脚本叫 git-health-check.mjs）；后来又与 `stale-client-bundle` 的自检格同键互相覆盖
  //   （同脚本、只差 arg）。⇒ 加/改本表后必须回读核对，别靠记忆：
  //     node scripts/run-gates.mjs --list --json | 看这 20 格的 timeoutMs 是否还停在 60000
  //
  // 值口径（沿用本表既有约定，不新造）：**⌈实测 × 1.5 ÷ 3⌉**（并发口径，ISS-787/ISS-777）。
  // 测量条件：本机 10 核、单格单跑、2026-11-14。折算后红线 = 值 × 3 × (10/本机核数)。
  // ⚠️ 这两格的值**按"保住迁移前的红线"定**，不是按实测最小值定 —— 迁移前它们写死在
  //   gate-tables.mjs 的 timeoutMs 上（600_000 / 660_000），那是当时刻意给的宽余量。
  //   我第一次按「实测 ⌈×1.5÷3⌉」给了 66 / 29 ⇒ 红线掉到 198s / 87s，full 档实测
  //   lint-mutation-tests 直接 `timeout after 87000ms`（单跑 58s，并发下 147s）。
  //   ⇒ 值取 practice 红线 ÷ 3：660s/3 = 220、600s/3 = 200。红线与迁移前**逐字相同**。
  "check-pm-suite-twice@": 200, // 迁移前 timeoutMs 600_000 ⇒ 红线 600s（未变）。实测单跑 132.8s
  "lint-mutation-tests@--check": 220, // ISS-820 外化后**参数变了**（原 inline 格无参）。迁移前 timeoutMs 660_000 ⇒ 红线 660s（未变）。实测单跑 58.3~147.5s，full 档并发会翻倍，故保留原宽余量
  "gate-base-leak@": 0.05, // 实测 0.09s
  "secret-scan@--worktree": 0.31, // 实测 0.62s。⚠️ arg 是 `--worktree` 不是空串 —— 原 standalone 格就带它
  "client-artifacts@--check": 0.05, // 实测 ≤0.1s（三次 existsSync）
  "git-health-check@": 4, // 实测 6.07s（读本机 checkout 现状，机器越忙越慢）
  "preset-parity-check@": 0.05, // 实测 0.04s（读两个 patch 文件做文本比对）
  "runtime-secret-check@": 0.05, // 实测 0.03s（本机无运行态语料时最快）
  "assembly-realize-check@": 0.31, // 实测 0.47s
  "dts-gate-check@": 0.05, // 实测 0.04s
  "check-matter-plugin-port@": 0.05, // 实测 0.03s
  "check-css-block-depth@": 0.05, // 实测 0.04s
  "check-design-token-exists@": 0.05, // 实测 0.04s
  "verify-gates-registry@": 0.15, // 实测 0.19s（它自己 spawn 一次 run-gates --list）
  "assembly-check@--check": 0.05, // 实测 0.10s（主判据格）
  // 外化后的新脚本名（原 custom 闭包没有脚本文件），键按新文件名登记。
  "project-code-rules-size@--check": 0.05, // 实测 0.02s（一次 statSync）
  "ci-red-to-issue@--selftest": 0.05, // 实测 0.03s（自检不联网不写库，只在 tmpdir 造 fixture）
  "review-ledger@--selftest": 0.05, // 实测 0.04s（同上，自检只造 fixture 不读真库）
  // ⚠️ 刻意**不**给 `stale-client-bundle@` 再写一条：它的主判据格 arg 是空串，键与上面已有的
  //   `"stale-client-bundle@": 49`（全树扫 + 并发被 I/O 饿死，0.31s 单跑 → 并发实测 72.89s）
  //   完全相同。重键后者覆盖前者，写一条新值等于把那条踩掉、还留下「已登记」的假象（ISS-777）。
}

/**
 * 快档线（秒）。ISS-755 起只用于 `--selftest` 的「快格是否真的快」自查 ——
 * 档位本身已由 registry 的 `cells[].tiers` 显式给出，不再由耗时推（那是 inFastByTime 的旧职责，随解析器一起删）。
 */
export const FAST_CUTOFF_SEC = 1.5

/** 实测表的键 = 去掉扩展名的脚本名 + @参数（与 MEASURED 的字面形状一致，别在这多推一层）。 */
export const measuredKey = (script, arg) => `${path.basename(script).replace(/\.(mjs|js|sh)$/, "")}@${arg}`

/**
 * 超时红线（ISS-725）：**环境阈值**，按核数折算，不是绝对秒数。
 *
 * 为什么要有折算：表里的秒数是在 `MEASURED_BASELINE_CORES` 核机器上测的。同一份判据在核少的
 * 机器上就是更慢 —— 那是机器的事，不是代码的事。用绝对秒数比 ⇒ 核少的机器上稳定撞线，
 * 撞线是 SIGTERM 掐死，**判据没来得及说话**（CI 日志只有 `timeout after Nms`），
 * 比真失败更坏：它零信息。反过来核多的机器上那条线永远咬不到，等于装饰品。
 *
 *  红线 = 实测秒数 × 基准核数/本机核数 × 安全系数
 *
 * ⚠️ 方向：**本机核少 ⇒ 红线放大**（分母小）。写反了会用 10 核的线量 2 核机器，红得更早。
 * ⚠️ 核数必须取**执行进程所在机器**的真值。`--workers` 只限并发，与核数无关，别拿它算
 *   （run-gates 里 `WORKERS` 给了 `--workers` 就短路；核数另走 `availableParallelism()`）。
 * ⚠️ 这是**环境阈值**。正确性阈值（违例上限/存量债）一个字都不许动 —— 两者混谈就是放水。
 *
 * @param {string} key MEASURED 表的键
 * @param {number} [cores] 当前机器核数（默认现取；给值只为 selftest 可控）
 */
export const timeoutFor = (key, cores = availableCores()) => {
  const sec = MEASURED[key]
  if (sec === undefined) return DEFAULT_TIMEOUT_MS
  const factor = MEASURED_BASELINE_CORES / Math.max(1, cores) // 核越少 ⇒ factor 越大 ⇒ 红线越宽
  const ms = Math.ceil(sec * TIMEOUT_SAFETY * factor) * 1000
  return Math.max(DEFAULT_TIMEOUT_MS, ms)
}

/** 本机可用核数（`availableParallelism` 拿不到时退回 `cpus()`，再不行按 4 核 —— 保守方向）。 */
export function availableCores() {
  return os.availableParallelism?.() || os.cpus().length || 4
}

export const MAX_BUFFER = 1 << 24 // 16MB：门禁输出里有整份清单，8MB 会截断
